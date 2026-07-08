import { getEnvName } from '../config/environments';

/**
 * Loads logins from environment variables (your private .env file).
 * Copy .env.example -> .env and fill it in once.
 *
 * Var naming (most specific wins):
 *   <ENV>_<ROLE>_USERNAME / <ENV>_<ROLE>_PASSWORD   ← per-environment login
 *   <ROLE>_USERNAME       / <ROLE>_PASSWORD         ← shared across environments
 *
 *   staging + admin  ->  STAGING_ADMIN_USERNAME  (falls back to ADMIN_USERNAME)
 *
 * The shared fallback lets teams whose accounts are the same across
 * environments fill the credentials in once.
 */

export interface Credential {
  username: string;
  password: string;
}

const norm = (s: string) => s.toUpperCase().replace(/-/g, '_');

/**
 * Public, purpose-built credentials for the shipped Example tests only. These
 * sites publish these logins for automated testing, so it's safe to ship them
 * as a final fallback — it lets a fresh clone run the Examples group with no
 * .env setup. NEVER add a private app's credentials here.
 */
const EXAMPLE_CREDS: Record<string, Credential> = {
  // https://www.saucedemo.com — publicly documented demo-store login.
  example: { username: 'standard_user', password: 'secret_sauce' },
};

/** Read a role's username/password, preferring the env-scoped var. */
function readCred(role: string, env?: string): { username?: string; password?: string; envKey: string; roleKey: string } {
  const envKey = `${norm(env || getEnvName())}_${norm(role)}`;
  const roleKey = norm(role);
  const username = process.env[`${envKey}_USERNAME`] ?? process.env[`${roleKey}_USERNAME`];
  const password = process.env[`${envKey}_PASSWORD`] ?? process.env[`${roleKey}_PASSWORD`];
  return { username, password, envKey, roleKey };
}

/**
 * Get a login by role name. `env` defaults to the current TEST_ENV (via
 * getEnvName) — pass it explicitly to resolve a specific environment's account,
 * which is what a multi-environment run does (one project per env, each with its
 * own creds). Resolution order: env-scoped var → shared var → public example map.
 */
export function getUser(role: string, env?: string): Credential {
  const { username, password, envKey, roleKey } = readCred(role, env);
  if (username && password) return { username, password };

  const fallback = EXAMPLE_CREDS[role.toLowerCase()];
  if (fallback) return fallback;

  throw new Error(
    `Missing credentials for role "${role}" in env "${env || getEnvName()}". ` +
      `Set ${envKey}_USERNAME/${envKey}_PASSWORD (or the shared ${roleKey}_USERNAME/${roleKey}_PASSWORD) ` +
      `in your .env file (copy from .env.example).`,
  );
}
