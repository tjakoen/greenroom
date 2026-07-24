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
import { sqlite } from "../db/index.ts";
import { countUsers, getTeamIds, isSuperadminEmail, joinDefaultOrg } from "./bootstrap.ts";

// DEV-ONLY fallback — this constant must NEVER be relied on in production. Set BETTER_AUTH_SECRET
// in the real environment (deployed platform, plans/platform.md §10 "secret management"); a
// missing prod secret means sessions can be forged. Fine for local dev only.
const DEV_SECRET_FALLBACK = "greenroom-dev-only-secret-not-for-prod";

// admin()'s default `adminRoles` is ["admin"] (verified by reading node_modules/better-auth's
// admin plugin, P2 Gate 1) — we don't override it below, so "admin" is the literal role value
// that makes isSuperadmin true (getSessionUser, bottom of this file).
const SUPERADMIN_ROLE = "admin";

export const auth = betterAuth({
  database: sqlite,
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
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:4321",
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
