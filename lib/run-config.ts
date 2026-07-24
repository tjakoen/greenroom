// lib/run-config.ts — P5 Gate C: per-run DB→Playwright-child config/credential handoff
// (plans/platform.md §6, "Per-run config/cred handoff"). The Playwright CHILD process reads
// environments via config/environments.ts (rawUrlsFile → GREENROOM_URLS_FILE when set) and
// credentials via users/roles.ts getUser() (`<ENV>_<ROLE>_USERNAME/PASSWORD` env vars) — neither
// can reach the DB itself. This module resolves both from the DB, SCOPED to what the requesting
// user canRead (lib/scope.ts), at the moment a run is spawned, and hands them to the child as:
//   - a per-run temp `urls.json`-shaped snapshot file (env config + login FORMS only — no
//     secrets) whose absolute path becomes GREENROOM_URLS_FILE, and
//   - a plain env-var map (credEnv) carrying DECRYPTED username/password pairs, spread directly
//     into the child's `env` by lib/runner.ts.
//
// SECURITY: decrypted secrets exist ONLY in the returned credEnv object and then the child
// process's environment — they are NEVER written to disk, logged, or echoed back to the browser.
// The temp snapshot file holds env config + login-form selectors only (never a credential) and is
// deleted by `cleanup()` once the run's child process has closed (lib/runner.ts calls this from
// its `close`/`error` handlers, so the file lives exactly as long as the child needs it).
//
// Demo / no session: `user === null` (demo mode's session gate is skipped, plans/platform.md §2)
// returns an inert bundle — today's `.env`/`config/urls.json` path is unchanged for demo runs.
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db } from "../db/index.ts";
import { environment, credential, type LoginFormConfig } from "../db/schema.ts";
import { filterReadable, type ScopedUser } from "./scope.ts";
import { decryptSecret } from "./secret.ts";

// MUST equal users/roles.ts's `norm` exactly — that's the CHILD-side reader building the same
// var names from `<env>`/`<role>` strings. Keep these two in lockstep by hand; there's no shared
// import between the two processes' code paths worth introducing for one one-liner.
const NORM = (s: string) => s.toUpperCase().replace(/-/g, "_");

export interface RunConfigBundle {
  /** Absolute path to a per-run `urls.json`-shaped snapshot (env config + login forms, no
   *  secrets), or null when there's nothing to hand off (demo / no matching envs). Callers set
   *  `GREENROOM_URLS_FILE` to this in the child's env when non-null. */
  urlsFile: string | null;
  /** `<ENV>_<ROLE>_USERNAME`/`_PASSWORD` (or shared `<ROLE>_USERNAME`/`_PASSWORD`) pairs with
   *  DECRYPTED plaintext passwords — spread directly into the child process's `env`. Never
   *  written to disk, logged, or returned over HTTP. */
  credEnv: Record<string, string>;
  /** Deletes the temp snapshot file (if any). Call once the run's child process has exited. */
  cleanup: () => void;
}

function urlsShapeFor(rows: (typeof environment.$inferSelect)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const entry: { baseURL: string; default?: true; login?: LoginFormConfig } = { baseURL: row.baseURL };
    if (row.isDefault) entry.default = true;
    if (row.loginForm && Object.keys(row.loginForm).length) entry.login = row.loginForm;
    out[row.name] = entry;
  }
  return out;
}

/**
 * Builds the per-run env-config + credential handoff bundle for one run's child process.
 * `envs` are the environment NAMES this run targets (as picked in the Run UI); `role` is the
 * optional "run as" override (server.ts's GR_ROLE) — when given, only that role's credentials are
 * decrypted and handed off (least-privilege: a forced single-role run has no reason to decrypt
 * every other role's secret too). Omit it to hand off every readable role (a run whose specs each
 * call `login('<their own role>')` needs all of them available).
 */
export async function buildRunConfig(
  user: ScopedUser | null,
  envs: string[],
  role?: string,
): Promise<RunConfigBundle> {
  const noop: RunConfigBundle = { urlsFile: null, credEnv: {}, cleanup() {} };
  if (!user) return noop; // demo mode / no session — today's .env + urls.json path is unchanged

  const wanted = new Set(envs.map((e) => String(e || "").trim()).filter(Boolean));

  // ---- environment snapshot: config + login FORMS only, scoped to what the user can read ----
  const allEnvRows = await db.select().from(environment);
  const readableEnvRows = filterReadable(user, allEnvRows);
  const picked = wanted.size ? readableEnvRows.filter((r) => wanted.has(r.name)) : [];

  let urlsFile: string | null = null;
  if (picked.length) {
    const shape = urlsShapeFor(picked);
    urlsFile = join(tmpdir(), `greenroom-run-${crypto.randomUUID()}.json`);
    writeFileSync(urlsFile, JSON.stringify(shape, null, 2), { mode: 0o600 });
  }

  // env id -> name for credential resolution below. Unscoped on purpose: an environment's NAME is
  // not a secret (environments-api.ts's own header note: visibility there is an org-accountability
  // concern, not a security wall against the runner) — what stays scoped is the CREDENTIAL row
  // itself, via filterReadable(user, credRows) below.
  const nameById = new Map(allEnvRows.map((r) => [r.id, r.name]));

  // ---- credential snapshot: decrypted ONLY here, in memory, for the life of this call ----
  const roleFilter = role && role.trim() ? NORM(role.trim()) : null;
  const credRows = filterReadable(user, await db.select().from(credential));
  const credEnv: Record<string, string> = {};
  for (const row of credRows) {
    if (!row.role) continue; // unknown/shared role — never handed off (db/schema.ts's own note)
    const roleKey = NORM(row.role);
    if (roleFilter && roleKey !== roleFilter) continue;
    if (row.envId && !nameById.has(row.envId)) continue; // dangling envId — skip, don't guess

    let password: string;
    try {
      password = await decryptSecret(row.secretEnc);
    } catch (err) {
      // Never log plaintext or the ciphertext — just that a row couldn't be decrypted (e.g. the
      // key rotated, plans/platform.md §10's "re-enterable, not catastrophic" case).
      console.warn(`[lib/run-config.ts] Could not decrypt credential ${row.id} (role "${row.role}") — skipping.`);
      continue;
    }

    const envName = row.envId ? nameById.get(row.envId) : undefined;
    const prefix = envName ? `${NORM(envName)}_${roleKey}` : roleKey;
    credEnv[`${prefix}_USERNAME`] = row.username;
    credEnv[`${prefix}_PASSWORD`] = password;
  }

  const cleanup = (): void => {
    if (!urlsFile) return;
    try {
      unlinkSync(urlsFile);
    } catch {
      /* already gone / best effort — never let cleanup crash a close handler */
    }
  };

  return { urlsFile, credEnv, cleanup };
}
