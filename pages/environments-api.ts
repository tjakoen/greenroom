// pages/environments-api.ts — scoped CRUD over the DB `environment` table (plans/platform.md §3,
// §4; P2 "Environments tab"). New /api/environments/* routes — the OLD /api/envs (interface/app.js
// + pages/settings.js) is untouched; this is an ADDITIVE, scoped surface for the platform layer.
// Self-contained module to a fixed contract (environmentsApi(ctx)) — the orchestrator wires this
// into server.ts's dispatch; this file does not touch server.ts itself.
//
// CRITICAL coupling — dual-write (read this before changing anything here): the Playwright
// RUNNER is a SEPARATE process that reads config/urls.json via config/environments.ts — it
// CANNOT read the DB. So the DB `environment` table is the source of truth for the scoped UI +
// metadata (owner/team/visibility/audit history), but every create/update/delete ALSO calls
// lib/envs.ts's EXISTING writers (saveEnv/deleteEnv) so config/urls.json stays in sync and runs
// keep resolving baseURLs. `visibility` here is a UI-listing/org-accountability concern — NOT a
// security boundary against the runner: environment URLs are shared infrastructure, not a
// per-user secret, so one shared urls.json is fine and the runner (a separate, unscoped process)
// sees every environment regardless of who can/can't see or edit it in this UI.
//
// urls.json "default" gap: lib/envs.ts has no primitive for flipping WHICH env is `default` on an
// already-existing urls.json entry — `saveEnv` only sets `default:true` when the entry being
// created is the very first one in the file; an existing entry's `default` is preserved as-is
// (spread) on every later save. But config/environments.ts's getEnvName() falls back to whichever
// env urls.json flags `default:true` when TEST_ENV is unset, so that flag IS load-bearing for the
// runner. Since there's no exported writer for it, `patchDefaultFlag` below does a narrow,
// additive patch of ONLY that boolean, directly on urls.json, using the same path convention
// lib/envs.ts uses — it never duplicates saveEnv/deleteEnv's name/baseURL/login-form writing.
import { and, eq, ne } from "drizzle-orm";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/index.ts";
import { environment, type LoginFormConfig, type Visibility } from "../db/schema.ts";
import { canWrite, canRescope, filterReadable, parseVisibility, resolveTeamId, type ScopedUser } from "../lib/scope.ts";
import { writeAudit } from "../lib/audit.ts";
import { saveEnv, deleteEnv as deleteUrlsEnv, isValidEnvName } from "../lib/envs.ts";
import { ROOT, IS_DEMO } from "../lib/paths.ts";

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

type EnvRow = typeof environment.$inferSelect;

function toApi(row: EnvRow) {
  return {
    id: row.id,
    name: row.name,
    baseURL: row.baseURL,
    isDefault: row.isDefault,
    visibility: row.visibility,
    teamId: row.teamId,
    ownerId: row.ownerId,
    loginForm: row.loginForm ?? null,
  };
}

// ---------------------------------------------------------- urls.json default-flag shim (header)
const URLS_PATH = join(ROOT, "config", "urls.json");

function patchDefaultFlag(defaultName: string): void {
  if (IS_DEMO) return; // demo never writes urls.json (mirrors lib/envs.ts's own IS_DEMO guards)
  if (!existsSync(URLS_PATH)) return;
  try {
    const u = JSON.parse(readFileSync(URLS_PATH, "utf8"));
    for (const key of Object.keys(u)) {
      if (key.startsWith("_") || !u[key] || typeof u[key] !== "object") continue;
      if (key === defaultName) u[key].default = true;
      else delete u[key].default;
    }
    writeFileSync(URLS_PATH, JSON.stringify(u, null, 2) + "\n");
  } catch {
    // Best-effort: a hand-edited/malformed urls.json shouldn't crash a DB write. loadUrls()
    // elsewhere already surfaces parse errors to the UI via getLastConfigError().
  }
}

/** Unsets isDefault on every OTHER row so exactly one environment stays default DB-wide (urls.json
 *  mirrors a single shared `default:true` env too — plans/platform.md §4 doesn't scope isDefault
 *  per team/owner, it's one runner fallback env for the whole shared urls.json). */
async function unsetOtherDefaults(exceptId: string): Promise<void> {
  await db
    .update(environment)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(environment.isDefault, true), ne(environment.id, exceptId)));
}

// ------------------------------------------------------------------------------------ handlers
async function listEnvironments(user: ScopedUser): Promise<Response> {
  const rows = await db.select().from(environment);
  return json(filterReadable(user, rows).map(toApi));
}

async function createEnvironment(ctx: ApiCtx): Promise<Response> {
  const user = ctx.user!;
  const body = await readBody(ctx.req);
  const name = String(body?.name ?? "").trim();
  const baseURL = String(body?.baseURL ?? "").trim().replace(/\/+$/, "");
  if (!name || !baseURL) return json({ ok: false, error: "name and baseURL are required" }, 400);
  if (!isValidEnvName(name)) {
    return json({ ok: false, error: "Name must be lowercase letters/numbers/dashes (e.g. staging)." }, 400);
  }
  if (!/^https?:\/\/.+/.test(baseURL)) {
    return json({ ok: false, error: "URL must start with http:// or https://" }, 400);
  }

  const existingRows = await db.select().from(environment);
  if (existingRows.some((r) => r.name === name)) {
    return json({ ok: false, error: `An environment named "${name}" already exists.` }, 409);
  }

  const visibility: Visibility = body?.visibility === undefined ? "company" : (parseVisibility(body.visibility) ?? "invalid" as Visibility);
  if ((visibility as string) === "invalid") return json({ ok: false, error: "visibility must be private, team, or company" }, 400);
  const teamRes = resolveTeamId(user, visibility, body?.teamId);
  if ("error" in teamRes) return json({ ok: false, error: teamRes.error }, 400);
  const teamId = teamRes.teamId;
  const loginForm: LoginFormConfig | null = body?.loginForm && typeof body.loginForm === "object" ? body.loginForm : null;
  // The very first environment ever created becomes the default (mirrors saveEnv's own
  // "isFirst" behavior for urls.json) — a fresh DB must never end up with zero defaults.
  const isDefault = existingRows.length === 0 ? true : !!body?.isDefault;

  const [row] = await db
    .insert(environment)
    .values({ name, baseURL, isDefault, loginForm, ownerId: user.id, teamId, visibility })
    .returning();

  if (isDefault) await unsetOtherDefaults(row.id);

  // Dual-write (see file header): urls.json is the runner's only view of this environment.
  const urlsResult = saveEnv(name, baseURL, loginForm ?? undefined);
  if (isDefault) patchDefaultFlag(name);

  await writeAudit({ actorId: user.id, action: "create", entity: "environment", entityId: row.id, after: row });

  if (!urlsResult.ok && !urlsResult.demo) {
    // DB row stands (visible in-app) but urls.json rejected the write — surface it so the user
    // knows the runner won't see this env until the name/URL is fixed. Shouldn't normally happen
    // since we validate the same rules above, but urls.json is hand-editable too.
    return json({ ok: true, environment: toApi(row), warning: urlsResult.error }, 200);
  }
  return json({ ok: true, environment: toApi(row) });
}

async function updateEnvironment(ctx: ApiCtx): Promise<Response> {
  const user = ctx.user!;
  const body = await readBody(ctx.req);
  const id = String(body?.id ?? "");
  if (!id) return json({ ok: false, error: "id is required" }, 400);

  const [existing] = await db.select().from(environment).where(eq(environment.id, id));
  if (!existing) return json({ ok: false, error: "not found" }, 404);
  if (!canWrite(user, existing)) return json({ ok: false, error: "forbidden" }, 403);

  const name = body?.name !== undefined ? String(body.name).trim() : existing.name;
  const baseURL = body?.baseURL !== undefined ? String(body.baseURL).trim().replace(/\/+$/, "") : existing.baseURL;
  if (!name || !baseURL) return json({ ok: false, error: "name and baseURL are required" }, 400);
  if (!isValidEnvName(name)) {
    return json({ ok: false, error: "Name must be lowercase letters/numbers/dashes (e.g. staging)." }, 400);
  }
  if (!/^https?:\/\/.+/.test(baseURL)) {
    return json({ ok: false, error: "URL must start with http:// or https://" }, 400);
  }

  if (name !== existing.name) {
    const clash = await db.select().from(environment).where(eq(environment.name, name));
    if (clash.some((r) => r.id !== id)) {
      return json({ ok: false, error: `An environment named "${name}" already exists.` }, 409);
    }
  }

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
  if ((visibility !== existing.visibility || teamId !== existing.teamId) && !canRescope(user, existing)) {
    return json({ ok: false, error: "only the owner or a superadmin can change a resource's visibility or team" }, 403);
  }
  const loginForm: LoginFormConfig | null =
    body?.loginForm !== undefined ? (body.loginForm && typeof body.loginForm === "object" ? body.loginForm : null) : existing.loginForm ?? null;
  const isDefault = body?.isDefault !== undefined ? !!body.isDefault : existing.isDefault;

  // Never leave zero defaults: refuse turning off the only default with nothing to replace it.
  if (existing.isDefault && !isDefault) {
    const others = await db.select().from(environment).where(and(eq(environment.isDefault, true), ne(environment.id, id)));
    if (others.length === 0) {
      return json({ ok: false, error: "At least one environment must stay default — make another one default first." }, 400);
    }
  }

  const [row] = await db
    .update(environment)
    .set({ name, baseURL, isDefault, visibility, teamId, loginForm, updatedAt: new Date() })
    .where(eq(environment.id, id))
    .returning();

  if (isDefault) await unsetOtherDefaults(id);

  // Dual-write: renaming means the OLD urls.json key must go so the runner doesn't keep a stale
  // duplicate entry alongside the new one.
  if (name !== existing.name) deleteUrlsEnv(existing.name);
  const urlsResult = saveEnv(name, baseURL, loginForm ?? undefined);
  if (isDefault) patchDefaultFlag(name);

  await writeAudit({ actorId: user.id, action: "update", entity: "environment", entityId: id, before: existing, after: row });

  if (!urlsResult.ok && !urlsResult.demo) {
    return json({ ok: true, environment: toApi(row), warning: urlsResult.error }, 200);
  }
  return json({ ok: true, environment: toApi(row) });
}

async function deleteEnvironment(ctx: ApiCtx): Promise<Response> {
  const user = ctx.user!;
  const body = await readBody(ctx.req);
  const id = String(body?.id ?? "");
  if (!id) return json({ ok: false, error: "id is required" }, 400);

  const [existing] = await db.select().from(environment).where(eq(environment.id, id));
  if (!existing) return json({ ok: false, error: "not found" }, 404);
  if (!canWrite(user, existing)) return json({ ok: false, error: "forbidden" }, 403);

  const all = await db.select().from(environment);
  if (all.length <= 1) {
    return json({ ok: false, error: "Cannot delete the last remaining environment." }, 400);
  }

  await db.delete(environment).where(eq(environment.id, id));

  // Never leave zero defaults: promote another remaining environment when the deleted one was it.
  const remaining = all.filter((r) => r.id !== id);
  if (existing.isDefault && remaining.length) {
    const promoted = remaining[0];
    await db.update(environment).set({ isDefault: true, updatedAt: new Date() }).where(eq(environment.id, promoted.id));
    patchDefaultFlag(promoted.name);
  }

  deleteUrlsEnv(existing.name);

  await writeAudit({ actorId: user.id, action: "delete", entity: "environment", entityId: id, before: existing });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------------- entry point
export async function environmentsApi(ctx: ApiCtx): Promise<Response | null> {
  if (!ctx.p.startsWith("/api/environments")) return null;
  if (!ctx.user) return json({ error: "unauthenticated" }, 401);

  if (ctx.p === "/api/environments") {
    if (ctx.method === "GET") return listEnvironments(ctx.user);
    if (ctx.method === "POST") return createEnvironment(ctx);
    return json({ error: "method not allowed" }, 405);
  }
  if (ctx.p === "/api/environments/update") {
    if (ctx.method !== "POST") return json({ error: "method not allowed" }, 405);
    return updateEnvironment(ctx);
  }
  if (ctx.p === "/api/environments/delete") {
    if (ctx.method !== "POST") return json({ error: "method not allowed" }, 405);
    return deleteEnvironment(ctx);
  }
  return json({ error: "not found" }, 404);
}
