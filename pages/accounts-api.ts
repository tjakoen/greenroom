// pages/accounts-api.ts — Accounts tab API (P2, plans/platform.md §3/§4/§11): scoped CRUD over
// TEST-TARGET credentials (the DB `credential` table). An "Account" here is a login ON THE APP
// UNDER TEST (e.g. a QA user for the site being tested) — NOT a Greenroom user account (those are
// better-auth's `user` table, resolved into the `ScopedUser` this module receives). Self-contained
// module to a fixed contract (accountsApi(ctx)) — the orchestrator wires this into server.ts's
// dispatch; this file does not touch server.ts itself. Mirrors pages/environments-api.ts (the
// sibling P2 scoped-CRUD module) in shape and response conventions for consistency.
//
// TRANSITIONAL BOUNDARY (read before assuming this affects real runs): the live Playwright runner
// still reads `.env` for test-target creds today (users/roles.ts) — these DB credentials do NOT
// drive real runs until P5 wires the run queue to resolve them at spawn time. There is therefore
// no dual-write here (unlike environment, which mirrors into config/urls.json for the runner) —
// `credential` rows are DB-only until P5. pages/accounts-page.ts carries the honest user-facing
// note; nothing in this file should imply an edit here changes a test run today.
//
// Secrets discipline (mirrors Settings → Roles & logins' existing rule EXACTLY — see
// pages/settings-page.ts/settings.js): a saved username is shown back; a saved password is NEVER
// returned once written. GET only ever carries `hasSecret:true`, never `secretEnc` or plaintext.
// lib/audit.ts's own redaction keeps `secretEnc` out of the audit trail too (redacts the top-level
// key by name), so create/update/delete audit rows are safe to keep forever.
import type { ScopedUser } from "../lib/scope.ts";
import { canWrite, canRescope, filterReadable, parseVisibility, resolveTeamId } from "../lib/scope.ts";
import { writeAudit } from "../lib/audit.ts";
import { encryptSecret } from "../lib/secret.ts";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { credential, type Visibility } from "../db/schema.ts";

export type ApiCtx = {
  req: Request;
  url: URL;
  p: string;
  method: string;
  qp: URLSearchParams;
  user: ScopedUser | null;
};

function json(data: unknown, status = 200): Response {
  return Response.json(data as any, { status });
}

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

type CredentialRow = typeof credential.$inferSelect;

/** Public shape — NEVER carries `secretEnc` or plaintext (see file header). */
function toApi(row: CredentialRow) {
  return {
    id: row.id,
    label: row.label,
    username: row.username,
    envId: row.envId,
    role: row.role,
    visibility: row.visibility,
    teamId: row.teamId,
    ownerId: row.ownerId,
    hasSecret: true as const,
  };
}

// ------------------------------------------------------------------------------------ handlers
async function listAccounts(user: ScopedUser): Promise<Response> {
  const rows = await db.select().from(credential);
  return json(filterReadable(user, rows).map(toApi));
}

async function createAccount(ctx: ApiCtx): Promise<Response> {
  const user = ctx.user!;
  const body = await readBody(ctx.req);
  const label = String(body?.label ?? "").trim();
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");
  if (!label || !username || !password) {
    return json({ ok: false, error: "label, username, and password are required" }, 400);
  }

  // Reject an unrecognized visibility rather than silently defaulting a typo to company (open).
  const visibility: Visibility = body?.visibility === undefined ? "company" : (parseVisibility(body.visibility) ?? "invalid" as Visibility);
  if ((visibility as string) === "invalid") return json({ ok: false, error: "visibility must be private, team, or company" }, 400);
  // Validate teamId against the caller's own membership (can't assign to a team you're not in).
  const teamRes = resolveTeamId(user, visibility, body?.teamId);
  if ("error" in teamRes) return json({ ok: false, error: teamRes.error }, 400);
  const teamId = teamRes.teamId;
  const envId: string | null = body?.envId ? String(body.envId) : null;
  // P5 Gate C: the (env, role) pair a per-run handoff (lib/run-config.ts) builds
  // `<ENV>_<ROLE>_USERNAME/PASSWORD` child env vars from — NOT the free-text `label`. Optional:
  // an account with no role stays "unknown/shared" and is never handed off to a run.
  const role: string | null = body?.role ? String(body.role).trim() : null;

  const secretEnc = await encryptSecret(password);
  const [row] = await db
    .insert(credential)
    .values({ label, username, envId, role, teamId, ownerId: user.id, visibility, secretEnc })
    .returning();

  await writeAudit({ actorId: user.id, action: "create", entity: "credential", entityId: row.id, after: row });
  return json({ ok: true, account: toApi(row) });
}

async function updateAccount(ctx: ApiCtx): Promise<Response> {
  const user = ctx.user!;
  const body = await readBody(ctx.req);
  const id = String(body?.id ?? "");
  if (!id) return json({ ok: false, error: "id is required" }, 400);

  const [existing] = await db.select().from(credential).where(eq(credential.id, id));
  if (!existing) return json({ ok: false, error: "not found" }, 404);
  if (!canWrite(user, existing)) return json({ ok: false, error: "forbidden" }, 403);

  const label = body?.label !== undefined ? String(body.label).trim() : existing.label;
  const username = body?.username !== undefined ? String(body.username).trim() : existing.username;
  if (!label || !username) return json({ ok: false, error: "label and username are required" }, 400);

  // Resolve the requested scope (visibility/teamId), then guard it. Re-scoping (changing either) is
  // owner/superadmin-only — a teammate with write access may edit fields but not relocate/flip scope.
  let visibility: Visibility = existing.visibility;
  if (body?.visibility !== undefined) {
    const v = parseVisibility(body.visibility);
    if (!v) return json({ ok: false, error: "visibility must be private, team, or company" }, 400);
    visibility = v;
  }
  let teamId: string | null = existing.teamId;
  if (body?.teamId !== undefined || visibility !== existing.visibility) {
    const teamRes = resolveTeamId(user, visibility, body?.teamId !== undefined ? body.teamId : existing.teamId);
    if ("error" in teamRes) return json({ ok: false, error: teamRes.error }, 400);
    teamId = teamRes.teamId;
  }
  const rescoping = visibility !== existing.visibility || teamId !== existing.teamId;
  if (rescoping && !canRescope(user, existing)) {
    return json({ ok: false, error: "only the owner or a superadmin can change a resource's visibility or team" }, 403);
  }
  const envId: string | null =
    body?.envId !== undefined ? (body.envId ? String(body.envId) : null) : existing.envId;
  const role: string | null =
    body?.role !== undefined ? (body.role ? String(body.role).trim() : null) : existing.role;
  // Leave secretEnc unchanged unless a new password was actually typed in — an empty/omitted
  // password field must never blank out (or re-encrypt garbage over) a saved one.
  const secretEnc = body?.password ? await encryptSecret(String(body.password)) : existing.secretEnc;

  const [row] = await db
    .update(credential)
    .set({ label, username, envId, role, teamId, visibility, secretEnc })
    .where(eq(credential.id, id))
    .returning();

  // before/after both carry secretEnc — lib/audit.ts's writeAudit redacts that key before the
  // insert, so the (possibly re-encrypted) ciphertext never lands in the audit trail either.
  await writeAudit({ actorId: user.id, action: "update", entity: "credential", entityId: id, before: existing, after: row });
  return json({ ok: true, account: toApi(row) });
}

async function deleteAccount(ctx: ApiCtx): Promise<Response> {
  const user = ctx.user!;
  const body = await readBody(ctx.req);
  const id = String(body?.id ?? "");
  if (!id) return json({ ok: false, error: "id is required" }, 400);

  const [existing] = await db.select().from(credential).where(eq(credential.id, id));
  if (!existing) return json({ ok: false, error: "not found" }, 404);
  if (!canWrite(user, existing)) return json({ ok: false, error: "forbidden" }, 403);

  await db.delete(credential).where(eq(credential.id, id));
  await writeAudit({ actorId: user.id, action: "delete", entity: "credential", entityId: id, before: existing });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------------- entry point
export async function accountsApi(ctx: ApiCtx): Promise<Response | null> {
  if (!ctx.p.startsWith("/api/accounts")) return null;
  if (!ctx.user) return json({ error: "unauthenticated" }, 401);

  if (ctx.p === "/api/accounts") {
    if (ctx.method === "GET") return listAccounts(ctx.user);
    if (ctx.method === "POST") return createAccount(ctx);
    return json({ error: "method not allowed" }, 405);
  }
  if (ctx.p === "/api/accounts/update") {
    if (ctx.method !== "POST") return json({ error: "method not allowed" }, 405);
    return updateAccount(ctx);
  }
  if (ctx.p === "/api/accounts/delete") {
    if (ctx.method !== "POST") return json({ error: "method not allowed" }, 405);
    return deleteAccount(ctx);
  }
  return json({ error: "not found" }, 404);
}
