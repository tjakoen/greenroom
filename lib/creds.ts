// lib/creds.ts — .env parsing + credential read/write.
// Ported from interface/server.js: the git-ignored .env is where per-env/per-role
// logins are written; values are never read back to the browser (set-booleans only).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, IS_DEMO, denyInDemo, readFileMaybe } from "./paths.ts";
import { envNames } from "./envs.ts";
import { rolesWithStatus } from "./roles.ts";

export const ENV_FILE = join(ROOT, ".env");
const ENV_EXAMPLE = join(ROOT, ".env.example");

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export function envPrefix(env: string): string {
  return env.toUpperCase().replace(/-/g, "_") + "_";
}

export const roleVar = (name: string): string => name.toUpperCase().replace(/-/g, "_");

// The old, pure var-name scan: which (env, role) logins are implied by the
// variable NAMES present in .env / .env.example. Kept as (a) the migration seed
// for roles.json and (b) a fallback so hand-edited .env roles still surface even
// if they were never created through the app.
export function scanCredRoles(): { env: string; name: string }[] {
  const known = new Set([
    ...Object.keys(parseEnvText(readFileMaybe(ENV_EXAMPLE))),
    ...Object.keys(parseEnvText(readFileMaybe(ENV_FILE))),
  ]);
  const out: { env: string; name: string }[] = [];
  for (const env of envNames()) {
    const prefix = envPrefix(env);
    for (const v of known) {
      if (v.startsWith(prefix) && (v.endsWith("_USERNAME") || v.endsWith("_PASSWORD"))) {
        const mid = v.slice(prefix.length).replace(/_(USERNAME|PASSWORD)$/, "");
        if (mid) out.push({ env, name: mid.toLowerCase().replace(/_/g, "-") });
      }
    }
  }
  return out;
}

// The roles the app knows about per env — sourced from role DEFINITIONS in
// config/roles.json (see lib/roles.ts), unioned with the var-name scan so nothing
// that only exists in .env is lost. Returns "set" booleans only, never values.
export function credRoles(): any[] {
  const out: any[] = [];
  for (const r of rolesWithStatus()) {
    for (const s of r.sites) {
      out.push({
        env: s.env,
        roleKey: roleVar(r.name),
        role: r.name, // what login(page, 'admin') / the login fixture expects
        label: r.label,
        usernameSet: s.usernameSet,
        passwordSet: s.passwordSet,
      });
    }
  }
  return out;
}

export function upsertEnvVar(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  return (text.endsWith("\n") || text === "" ? text : text + "\n") + line + "\n";
}

// Write a role's login into .env (creating it if needed). Only non-empty fields
// are written, so saving with one field blank won't wipe the other.
export function saveCred({
  env,
  role,
  username,
  password,
}: {
  env: string;
  role: string;
  username?: string;
  password?: string;
}): { ok: boolean; error?: string; demo?: boolean } {
  if (IS_DEMO) return denyInDemo;
  if (!envNames().includes(env)) return { ok: false, error: `Unknown environment "${env}".` };
  const roleKey = String(role || "")
    .toUpperCase()
    .replace(/-/g, "_")
    .replace(/[^A-Z0-9_]/g, "");
  if (!roleKey) return { ok: false, error: "Enter a role name (e.g. admin)." };
  // Reject control characters: a newline in a value would inject arbitrary extra
  // lines into .env (e.g. "pass\nEVIL=1"), which dotenv would then load into
  // every test run. Values are single-line by definition.
  const hasControlChars = (v: unknown): boolean => typeof v === "string" && /[\x00-\x1f\x7f]/.test(v);
  if (hasControlChars(username) || hasControlChars(password)) {
    return { ok: false, error: "Username and password cannot contain line breaks or control characters." };
  }
  const prefix = envPrefix(env) + roleKey;
  let text = readFileMaybe(ENV_FILE);
  if (typeof username === "string" && username.trim()) text = upsertEnvVar(text, `${prefix}_USERNAME`, username.trim());
  if (typeof password === "string" && password.trim()) text = upsertEnvVar(text, `${prefix}_PASSWORD`, password.trim());
  writeFileSync(ENV_FILE, text);
  return { ok: true };
}

// Public creds for the shipped `example` role only (mirrors users/roles.ts) so
// pre-auth recording works zero-config against the example sites.
const EXAMPLE_CREDS: Record<string, { username: string; password: string }> = {
  example: { username: "standard_user", password: "secret_sauce" },
};

// Resolve a role's login for an env from .env (env-scoped var wins, shared falls
// back), else the public example cred. Mirrors users/roles.ts getUser.
export function resolveCred(env: string, role: string): { username: string; password: string } | null {
  const dot = parseEnvText(readFileMaybe(ENV_FILE));
  const rk = roleVar(role);
  const username = dot[`${envPrefix(env)}${rk}_USERNAME`] ?? dot[`${rk}_USERNAME`];
  const password = dot[`${envPrefix(env)}${rk}_PASSWORD`] ?? dot[`${rk}_PASSWORD`];
  if (username && password) return { username, password };
  return EXAMPLE_CREDS[String(role).toLowerCase()] || null;
}
