// pages/admin-api.ts — /api/admin/* handler (P2, superadmin-only user + team management).
// plans/platform.md §11 P2: "superadmin and /admin user/team management ... every write
// audited." Self-contained module built to a fixed contract (see ApiCtx/adminApi below) — the
// orchestrator (server.ts) wires this in; this file never imports or touches server.ts.
//
// Auth split (verified by reading node_modules/better-auth, not guessed):
//   - user listing + role promotion/demotion -> the ADMIN plugin's own API
//     (`auth.api.listUsers` / `auth.api.setRole`, node_modules/better-auth/dist/plugins/admin) —
//     its default `admin` role (auth/index.ts SUPERADMIN_ROLE) already has the `user:list` /
//     `user:set-role` permissions (admin/access/statement.mjs adminAc), so our own
//     `ctx.user.isSuperadmin` gate lines up cleanly with these endpoints' own gate.
//   - team create/add-member/remove-member -> the ORGANIZATION plugin's team API
//     (`auth.api.createTeam` / `auth.api.addTeamMember` / `auth.api.removeTeamMember`,
//     node_modules/better-auth/dist/plugins/organization/routes/crud-team.mjs). BUT that
//     plugin's own permission model is ORG-scoped (`member.role` = owner/admin/member —
//     organization/access/statement.mjs), independent of the admin plugin's role, and
//     auth/bootstrap.ts's joinDefaultOrg always inserts new members as plain "member" (no
//     `team:create` / `member:update` / `member:delete` permission) — so a superadmin calling
//     these endpoints as-is would get FORBIDDEN despite plans/platform.md §0's threat model
//     ("Superadmins see and do everything"). `ensureOrgOwner` below reconciles the two models:
//     since every route in this file is already gated on `ctx.user.isSuperadmin`, we lazily
//     promote the acting superadmin's own org membership to "owner" (idempotent raw SQL against
//     the shared `sqlite` handle, same direct-query pattern auth/bootstrap.ts already uses for
//     these better-auth-owned tables) immediately before a team mutation, then let the plugin's
//     own endpoint do the actual write + hooks.
//   - team roster / member counts -> plain SQL reads over the shared `sqlite` handle. No clean
//     auth.api method covers this without ALSO restricting to teams the caller happens to be a
//     member of (`listTeamMembers` requires the caller be a member of that specific team, which
//     would incorrectly narrow a superadmin's visibility) — so this is the "no clean API method"
//     fallback the task allows, same rationale as the team-mutation permission gap above.
import type { ScopedUser } from "../lib/scope.ts";
import { auth } from "../auth/index.ts";
import { ensureDefaultOrg, getTeamIds } from "../auth/bootstrap.ts";
import { sqlite } from "../db/index.ts";
import { writeAudit, listAudit } from "../lib/audit.ts";

export type ApiCtx = {
  req: Request;
  url: URL;
  p: string;
  method: string;
  qp: URLSearchParams;
  user: ScopedUser | null;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function methodNotAllowed(): Response {
  return json({ ok: false, error: "Method not allowed." }, 405);
}

function forbidden(): Response {
  return json({ ok: false, error: "Superadmin only." }, 403);
}

/** Extracts a friendly message + HTTP status from a thrown better-auth APIError (has
 *  `.statusCode` (number) and `.body.message` (string) — see node_modules/@better-auth/core's
 *  error/index.mjs + node_modules/better-call's error.mjs). Falls back to 500 for anything else. */
function errorResponse(err: unknown): Response {
  const e = err as { statusCode?: unknown; body?: { message?: unknown }; message?: unknown } | null;
  const statusCode = typeof e?.statusCode === "number" ? e.statusCode : 500;
  const message =
    (typeof e?.body?.message === "string" && e.body.message) ||
    (typeof e?.message === "string" && e.message) ||
    "Request failed.";
  return json({ ok: false, error: message }, statusCode);
}

interface UserWithRoleLike {
  id: string;
  email: string;
  name?: string | null;
  role?: string | string[] | null;
}

function roleString(role: UserWithRoleLike["role"]): string {
  if (Array.isArray(role)) return role[0] ?? "user";
  return role ?? "user";
}

interface TeamRow {
  id: string;
  name: string;
  memberCount: number;
}

/** Reads the team roster for the default org directly (see file-header rationale). */
function listTeamsRaw(orgId: string): TeamRow[] {
  const rows = sqlite
    .query(
      `SELECT team.id as id, team.name as name, COUNT(teamMember.id) as memberCount
       FROM team
       LEFT JOIN teamMember ON teamMember.teamId = team.id
       WHERE team.organizationId = ?
       GROUP BY team.id
       ORDER BY team.name`,
    )
    .all(orgId) as TeamRow[];
  return rows;
}

/** Resolves a batch of actorIds -> email via the shared `sqlite` handle (better-auth's own
 *  `user` table isn't in our Drizzle schema — see file header rationale for the same pattern in
 *  listTeamsRaw). Missing/unknown ids are simply absent from the returned map; callers fall back
 *  to the raw id so an audit row is never dropped for a since-deleted actor. */
function resolveActorEmails(actorIds: string[]): Map<string, string> {
  const unique = [...new Set(actorIds)];
  if (!unique.length) return new Map();
  const placeholders = unique.map(() => "?").join(",");
  const rows = sqlite
    .query(`SELECT id, email FROM user WHERE id IN (${placeholders})`)
    .all(...unique) as Array<{ id: string; email: string }>;
  return new Map(rows.map((r) => [r.id, r.email]));
}

const AUDIT_DEFAULT_LIMIT = 100;
const AUDIT_MAX_LIMIT = 500;

/** GET /api/admin/audit — read-only surface over lib/audit.ts's listAudit (writing already
 *  happens at every P2 mutation site above). Compact rows only: actorId is resolved to the
 *  actor's email for readability, and before/after snapshots are deliberately dropped from the
 *  list response (they're already redacted at write time, but a compact table reads better; the
 *  raw record is still in the db for anyone who needs it). Newest-first, per listAudit. */
async function handleListAudit(ctx: ApiCtx): Promise<Response> {
  const entity = ctx.qp.get("entity") ?? undefined;
  const entityId = ctx.qp.get("entityId") ?? undefined;
  const actorId = ctx.qp.get("actorId") ?? undefined;

  let limit = AUDIT_DEFAULT_LIMIT;
  const limitParam = ctx.qp.get("limit");
  if (limitParam) {
    const parsed = Number.parseInt(limitParam, 10);
    if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(parsed, AUDIT_MAX_LIMIT);
  }

  const rows = await listAudit({ entity, entityId, actorId, limit });
  const emails = resolveActorEmails(rows.map((r) => r.actorId));
  const audit = rows.map((r) => ({
    id: r.id,
    actor: emails.get(r.actorId) ?? r.actorId,
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    createdAt: r.createdAt,
  }));
  return json({ ok: true, audit });
}

/** Idempotently promotes `userId`'s ORG-level membership role (the organization plugin's own
 *  `member.role`, independent of the admin plugin's `user.role`) to "owner" so the organization
 *  plugin's own permission checks (team:create / member:update / member:delete — see file
 *  header) pass for a caller this file has already verified is a Greenroom superadmin. */
function ensureOrgOwner(orgId: string, userId: string): void {
  sqlite
    .query(`UPDATE member SET role = 'owner' WHERE organizationId = ? AND userId = ? AND role != 'owner'`)
    .run(orgId, userId);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function handleListUsers(ctx: ApiCtx): Promise<Response> {
  try {
    const result = (await auth.api.listUsers({
      query: { limit: 500, sortBy: "email", sortDirection: "asc" },
      headers: ctx.req.headers,
    })) as { users: UserWithRoleLike[]; total: number };

    const users = result.users.map((u) => {
      const teamIds = getTeamIds(u.id);
      return {
        id: u.id,
        email: u.email,
        name: u.name ?? null,
        role: roleString(u.role),
        isSuperadmin: roleString(u.role) === "admin",
        teamIds,
      };
    });
    return json({ ok: true, users });
  } catch (err) {
    return errorResponse(err);
  }
}

async function handleSetRole(ctx: ApiCtx): Promise<Response> {
  const body = await readJsonBody(ctx.req);
  const userId = body?.userId;
  const makeAdmin = body?.makeAdmin;
  if (typeof userId !== "string" || !userId || typeof makeAdmin !== "boolean") {
    return json({ ok: false, error: "userId (string) and makeAdmin (boolean) are required." }, 400);
  }
  const role = makeAdmin ? "admin" : "user";
  try {
    await auth.api.setRole({ body: { userId, role }, headers: ctx.req.headers });
    await writeAudit({
      actorId: ctx.user!.id,
      action: "user.role",
      entity: "user",
      entityId: userId,
      after: { role },
    });
    return json({ ok: true, role });
  } catch (err) {
    return errorResponse(err);
  }
}

function handleListTeams(orgId: string): Response {
  return json({ ok: true, teams: listTeamsRaw(orgId) });
}

async function handleCreateTeam(ctx: ApiCtx, orgId: string): Promise<Response> {
  const body = await readJsonBody(ctx.req);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return json({ ok: false, error: "Team name is required." }, 400);

  ensureOrgOwner(orgId, ctx.user!.id);
  try {
    const team = (await auth.api.createTeam({
      body: { name, organizationId: orgId },
      headers: ctx.req.headers,
    })) as { id: string; name: string };
    await writeAudit({
      actorId: ctx.user!.id,
      action: "team.create",
      entity: "team",
      entityId: team.id,
      after: { name: team.name },
    });
    return json({ ok: true, team: { id: team.id, name: team.name, memberCount: 0 } });
  } catch (err) {
    return errorResponse(err);
  }
}

async function handleTeamMembers(ctx: ApiCtx, orgId: string): Promise<Response> {
  const body = await readJsonBody(ctx.req);
  const teamId = body?.teamId;
  const userId = body?.userId;
  const add = body?.add;
  if (typeof teamId !== "string" || !teamId || typeof userId !== "string" || !userId || typeof add !== "boolean") {
    return json({ ok: false, error: "teamId, userId (strings) and add (boolean) are required." }, 400);
  }

  ensureOrgOwner(orgId, ctx.user!.id);
  try {
    if (add) {
      await auth.api.addTeamMember({ body: { teamId, userId, organizationId: orgId }, headers: ctx.req.headers });
    } else {
      await auth.api.removeTeamMember({ body: { teamId, userId, organizationId: orgId }, headers: ctx.req.headers });
    }
    await writeAudit({
      actorId: ctx.user!.id,
      action: add ? "team.member.add" : "team.member.remove",
      entity: "team",
      entityId: teamId,
      after: { userId, added: add },
    });
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** /api/admin/* dispatcher. Returns null when `ctx.p` isn't one of this module's routes, so the
 *  orchestrator can fall through to its next handler / a 404. Every recognized route requires
 *  `ctx.user?.isSuperadmin` (checked ONCE here, before dispatch) — else 403 JSON. */
export async function adminApi(ctx: ApiCtx): Promise<Response | null> {
  if (!ctx.p.startsWith("/api/admin/")) return null;

  if (!ctx.user?.isSuperadmin) return forbidden();

  if (ctx.p === "/api/admin/users") {
    if (ctx.method !== "GET") return methodNotAllowed();
    return handleListUsers(ctx);
  }

  if (ctx.p === "/api/admin/users/role") {
    if (ctx.method !== "POST") return methodNotAllowed();
    return handleSetRole(ctx);
  }

  if (ctx.p === "/api/admin/teams") {
    const { id: orgId } = ensureDefaultOrg();
    if (ctx.method === "GET") return handleListTeams(orgId);
    if (ctx.method === "POST") return handleCreateTeam(ctx, orgId);
    return methodNotAllowed();
  }

  if (ctx.p === "/api/admin/teams/members") {
    if (ctx.method !== "POST") return methodNotAllowed();
    const { id: orgId } = ensureDefaultOrg();
    return handleTeamMembers(ctx, orgId);
  }

  if (ctx.p === "/api/admin/audit") {
    if (ctx.method !== "GET") return methodNotAllowed();
    return handleListAudit(ctx);
  }

  return null;
}
