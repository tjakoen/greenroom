// auth/index.ts — the real better-auth instance (P1 Gate 2), replacing spike/auth/auth.ts.
//
// Shares the ONE physical db file with the app's own Drizzle tables (plans/platform.md §3 "table
// ownership" box): better-auth drives its own tables (user/session/account/verification +
// organization/admin/sso plugin tables) directly against the same bun:sqlite `Database` handle
// exported by db/index.ts — via its BUILT-IN bun:sqlite support (Kysely under the hood), NOT the
// Drizzle adapter. No name collisions with db/schema.ts's app tables.
//
// jiti/bun gotcha (proved in spike/auth/migrate.ts): the better-auth CLI loads config through
// jiti, which cannot resolve the virtual `bun:sqlite` specifier. So migrations here are run via
// `getMigrations` from `better-auth/db/migration` directly in a plain Bun script/import — never
// `bunx @better-auth/cli`.
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { admin } from "better-auth/plugins/admin";
import { sso } from "@better-auth/sso";
import { getMigrations } from "better-auth/db/migration";
import { sqlite, openSqlite } from "../db/index.ts";
import { countUsers, getTeamIds, isSuperadminEmail, joinDefaultOrg } from "./bootstrap.ts";

// DEV-ONLY fallback — this constant must NEVER be relied on in production. Set BETTER_AUTH_SECRET
// in the real environment (deployed platform, plans/platform.md §10 "secret management"); a
// missing prod secret means sessions can be forged. Fine for local dev only.
const DEV_SECRET_FALLBACK = "greenroom-dev-only-secret-not-for-prod";

// admin()'s default `adminRoles` is ["admin"] (verified by reading node_modules/better-auth's
// admin plugin, P2 Gate 1) — we don't override it below, so "admin" is the literal role value
// that makes isSuperadmin true (getSessionUser, bottom of this file).
const SUPERADMIN_ROLE = "admin";

// ---- deploy security (plans/platform.md §10 / DEPLOY.md) ----
const BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:4321";
// Cookies are marked Secure only when we're actually served over https (a deployed instance
// behind a TLS proxy sets BETTER_AUTH_URL=https://…). Local http dev keeps them non-Secure so
// the session cookie is still sent. sameSite=lax + httpOnly are better-auth defaults.
const USE_SECURE_COOKIES = BASE_URL.startsWith("https://");
// CSRF / redirect allowlist: better-auth validates Origin + SSO callbacks against these. The
// deployment host(s) (ALLOWED_HOSTS, shared with lib/guard.ts) get an https origin each; the
// base URL + loopback stay for local dev. Deduped.
const TRUSTED_ORIGINS = Array.from(new Set([
  BASE_URL,
  "http://localhost:4321",
  "http://127.0.0.1:4321",
  ...String(process.env.ALLOWED_HOSTS || "")
    .split(",").map((s) => s.trim().replace(/^https?:\/\//, "").replace(/\/$/, "")).filter(Boolean)
    .map((h) => `https://${h}`),
]));
// Client-IP resolution for rate limiting. When deployed (ALLOWED_HOSTS set), we're behind a
// reverse proxy so the socket IP is the proxy's — better-auth would otherwise fall back to ONE
// shared rate-limit bucket (its own warning), letting a single attacker rate-limit everyone.
// Trust x-forwarded-for ONLY when deployed: the proxy MUST set it to the real client IP and
// OVERWRITE any client-supplied value (nginx `proxy_set_header X-Forwarded-For $remote_addr` —
// see DEPLOY.md), otherwise a client could spoof it to evade the limit. In local/direct mode we
// leave it unset so the real socket IP is used and XFF can't be spoofed.
const IS_DEPLOYED = !!process.env.ALLOWED_HOSTS;
const IP_ADDRESS = IS_DEPLOYED ? { ipAddressHeaders: ["x-forwarded-for"] } : undefined;

// Lazy-built (local/platform split): constructing better-auth opens the db (database: openSqlite())
// and loads the plugin stack. The LOCAL edition never builds it — server.ts only ever touches
// `auth` on platform routes (/api/auth/*, the session gate, admin-api). Exported as a proxy so all
// call sites (auth.handler / auth.api.* / auth.options) work unchanged; the real instance is built
// on first property access and memoized.
// A pure factory so `ReturnType<typeof makeAuth>` keeps better-auth's fully-inferred, plugin-
// augmented type (auth.api.listUsers/setRole/createTeam/… come from the admin + organization
// plugins). Only CALLED lazily by buildAuth() — never at import — so the db stays closed in local.
function makeAuth() {
  return betterAuth({
  database: openSqlite(),
  emailAndPassword: {
    enabled: true,
  },
  // Superadmin promotion + org/team auto-join (plans/platform.md §2). better-auth runs plugin
  // databaseHooks first, then this top-level `databaseHooks` LAST (verified by reading
  // context/helpers.ts runPluginInit: plugin hooks are pushed to `dbHooks` in plugin-registration
  // order, this top-level config is pushed last as source "user") — so the `data` this before-hook
  // returns wins over admin()'s own before-hook (which otherwise defaults every new user's `role`
  // to "user"; db/with-hooks.ts createWithHooks merges each hook's `data` over the last, last
  // write wins).
  databaseHooks: {
    user: {
      create: {
        async before(user) {
          const email = String((user as { email?: unknown }).email ?? "");
          // FIRST user ever created also becomes superadmin (bootstrap safety net) so a fresh
          // deploy is never stuck with zero admins if SUPERADMIN_EMAIL wasn't set in time.
          // countUsers() reads the table BEFORE this insert, so the very first sign-up sees 0.
          const promote = isSuperadminEmail(email) || countUsers() === 0;
          if (!promote) return;
          return { data: { ...user, role: SUPERADMIN_ROLE } };
        },
        async after(user) {
          // Auto-join the single default org + default "Unassigned" team (§2). Runs after the
          // user row commits (queued via queueAfterTransactionHook, awaited before the endpoint
          // returns — verified by reading @better-auth/core's transaction.ts), so getSessionUser
          // called right after sign-up already sees the membership.
          joinDefaultOrg(user.id);
        },
      },
    },
  },
  plugins: [
    organization({ teams: { enabled: true } }),
    admin(),
    sso(),
  ],
  secret: process.env.BETTER_AUTH_SECRET ?? DEV_SECRET_FALLBACK,
  baseURL: BASE_URL,
  // Deploy security (DEPLOY.md). trustedOrigins gates CSRF + SSO redirects; secure cookies over
  // https; rate limit blunts credential brute-force. In-memory limiter is fine for the
  // single-server model (plans/platform.md §6); a multi-instance deploy would need shared storage.
  trustedOrigins: TRUSTED_ORIGINS,
  advanced: { useSecureCookies: USE_SECURE_COOKIES, ...(IP_ADDRESS ? { ipAddress: IP_ADDRESS } : {}) },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 120,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 10 },
    },
  },
  });
}
let _auth: ReturnType<typeof makeAuth> | null = null;
function buildAuth(): ReturnType<typeof makeAuth> {
  return (_auth ??= makeAuth());
}
export const auth: ReturnType<typeof makeAuth> = new Proxy({} as ReturnType<typeof makeAuth>, {
  get(_t, prop) {
    const a = buildAuth() as any;
    const v = a[prop];
    return typeof v === "function" ? v.bind(a) : v;
  },
});

/** Creates better-auth's own tables (user/session/account/verification + plugin tables) against
 *  the shared sqlite handle. Boot sequence (server.ts): runAuthMigrations() -> runAppMigrations()
 *  -> serve. Safe to call every boot — getMigrations only migrates what's missing. */
export async function runAuthMigrations(): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/** The ScopedUser (lib/scope.ts) shape resolved from a session, plus the identity fields callers
 *  display (email). isSuperadmin comes from the admin plugin's `user.role` column; teamIds from
 *  the organization plugin's `teamMember` table (auth/bootstrap.ts getTeamIds). */
export interface SessionUser {
  id: string;
  email: string;
  isSuperadmin: boolean;
  teamIds: string[];
}

/** Resolves the session (if any) for an incoming request. Returns the user, or null when there
 *  is no valid session — the one call site handle()'s session gate needs. Also the ScopedUser
 *  factory every future scope-checked /api/* handler (P2 UI gates) will call. */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: req.headers });
  const user = session?.user;
  if (!user) return null;
  const role = (user as { role?: string | null }).role ?? null;
  return {
    id: user.id,
    email: user.email,
    isSuperadmin: role === SUPERADMIN_ROLE,
    teamIds: getTeamIds(user.id),
  };
}

/** P5 Gate D (plans/platform.md §6): the scheduler (lib/run-queue.ts) has no incoming Request to
 *  resolve a session from — a queued run may start long after the HTTP request that enqueued it
 *  returned. This rebuilds the SAME SessionUser/ScopedUser shape getSessionUser() does, straight
 *  from the `triggeredBy` user id stored on the `run` row, by querying better-auth's own `user`
 *  table directly over the shared sqlite handle (same pattern as pages/admin-api.ts's
 *  resolveActorEmails — that table isn't in our Drizzle schema). Returns null if the user has
 *  since been deleted; callers (buildRunConfig) already treat a null user as "no DB config/cred
 *  handoff" (demo-mode-shaped no-op), which is the right degrade here too. */
export function resolveScopedUser(userId: string): SessionUser | null {
  const row = sqlite
    .query("SELECT id, email, role FROM user WHERE id = ?")
    .get(userId) as { id: string; email: string; role: string | null } | null;
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    isSuperadmin: row.role === SUPERADMIN_ROLE,
    teamIds: getTeamIds(row.id),
  };
}
