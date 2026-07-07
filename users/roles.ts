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

/** Read a role's username/password, preferring the env-scoped var. */
function readCred(role: string): { username?: string; password?: string; envKey: string; roleKey: string } {
  const envKey = `${norm(getEnvName())}_${norm(role)}`;
  const roleKey = norm(role);
  const username = process.env[`${envKey}_USERNAME`] ?? process.env[`${roleKey}_USERNAME`];
  const password = process.env[`${envKey}_PASSWORD`] ?? process.env[`${roleKey}_PASSWORD`];
  return { username, password, envKey, roleKey };
}

/** Get a login by role name for the current TEST_ENV. */
export function getUser(role: string): Credential {
  const { username, password, envKey, roleKey } = readCred(role);

  if (!username || !password) {
    throw new Error(
      `Missing credentials for role "${role}" in env "${getEnvName()}". ` +
        `Set ${envKey}_USERNAME/${envKey}_PASSWORD (or the shared ${roleKey}_USERNAME/${roleKey}_PASSWORD) ` +
        `in your .env file (copy from .env.example).`,
    );
  }
  return { username, password };
}
