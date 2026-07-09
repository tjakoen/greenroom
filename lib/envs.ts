// lib/envs.ts — environments + login-form config (config/urls.json).
// Ported from interface/server.js: urls.json seeding/loading/editing + login-form
// resolution (env.login → shared _login → generic default).
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, IS_DEMO, denyInDemo } from "./paths.ts";

const URLS_PATH = join(ROOT, "config", "urls.json");
const URLS_EXAMPLE_PATH = join(ROOT, "config", "urls.example.json");

// urls.json holds your real environments and is git-ignored. On a fresh clone
// it won't exist, so seed it from the committed template on first boot.
export function seedUrls(): void {
  if (IS_DEMO) return; // demo reads config via the committed example; never write
  if (!existsSync(URLS_PATH) && existsSync(URLS_EXAMPLE_PATH)) {
    copyFileSync(URLS_EXAMPLE_PATH, URLS_PATH);
  }
}
seedUrls();

// Environments are read fresh every time so edits from the app take effect
// without restarting the server.
let lastConfigError: string | null = null;

/** The last urls.json parse error (or null), so the UI can tell the user what to fix. */
export function getLastConfigError(): string | null {
  return lastConfigError;
}

export function loadUrls(): Record<string, any> {
  // Demo always uses the committed generic envs — never the user's real urls.json.
  const file = !IS_DEMO && existsSync(URLS_PATH) ? URLS_PATH : URLS_EXAMPLE_PATH;
  try {
    const obj = JSON.parse(readFileSync(file, "utf8"));
    lastConfigError = null;
    return obj;
  } catch (err: any) {
    // A hand-edited, malformed urls.json must NOT crash the server (it's read on
    // every request, including /api/state). Degrade to no environments and
    // surface the reason so the UI can tell the user what to fix.
    lastConfigError = `${relative(ROOT, file)} is not valid JSON — ${err.message}`;
    return {};
  }
}

export function envNames(): string[] {
  return Object.keys(loadUrls()).filter((k) => !k.startsWith("_"));
}

export function baseURLof(env: string): string | undefined {
  return loadUrls()[env]?.baseURL;
}

// ---------------------------------------------------------- environment editing
export function isValidEnvName(n: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,40}$/.test(n);
}

// The login-form fields kept per env (or under the shared `_login` key) — how a
// site's login form is laid out, so login()/pre-auth recording can drive it.
// These are selectors + button text, not secrets; still trimmed + single-line.
const LOGIN_FIELDS = ["path", "username", "password", "submit"];
export function sanitizeLoginForm(login: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (login && typeof login === "object") {
    for (const k of LOGIN_FIELDS) {
      const v = login[k];
      if (typeof v === "string" && v.trim() && !/[\x00-\x1f\x7f]/.test(v)) out[k] = v.trim();
    }
  }
  return out;
}

// Add or update an environment in config/urls.json and seed a login block in
// .env.example. Preserves other fields on an existing entry (e.g. "default").
// If this is the first environment, it becomes the default. `login` (optional)
// sets that env's own login-form override; pass {} (or all-empty) to clear it,
// omit it (undefined) to leave any existing block untouched.
export function saveEnv(name: string, baseURL: string, login?: any): { ok: boolean; error?: string; demo?: boolean } {
  if (IS_DEMO) return denyInDemo;
  if (!isValidEnvName(name)) {
    return { ok: false, error: "Name must be lowercase letters/numbers/dashes (e.g. staging)." };
  }
  if (!/^https?:\/\/.+/.test(baseURL)) {
    return { ok: false, error: "URL must start with http:// or https://" };
  }
  const u = loadUrls();
  const isFirst = envNames().length === 0;
  u[name] = { ...(u[name] || {}), baseURL: baseURL.replace(/\/+$/, "") };
  if (isFirst) u[name].default = true;
  if (login !== undefined) {
    const form = sanitizeLoginForm(login);
    if (Object.keys(form).length) u[name].login = form;
    else delete u[name].login;
  }
  writeFileSync(URLS_PATH, JSON.stringify(u, null, 2) + "\n");

  try {
    const p = join(ROOT, ".env.example");
    const prefix = name.toUpperCase().replace(/-/g, "_");
    let txt = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (!txt.includes(`${prefix}_`)) {
      txt += `\n# ---- ${name} ----\n${prefix}_ADMIN_USERNAME=\n${prefix}_ADMIN_PASSWORD=\n`;
      writeFileSync(p, txt);
    }
  } catch {
    /* seeding the template is best-effort */
  }
  return { ok: true };
}

// The shared login form (top-level `_login`), applied to every env that doesn't
// define its own. Pass an all-empty form to remove it.
export function saveSharedLogin(login: any): { ok: boolean; error?: string; demo?: boolean } {
  if (IS_DEMO) return denyInDemo;
  const u = loadUrls();
  const form = sanitizeLoginForm(login);
  if (Object.keys(form).length) u._login = form;
  else delete u._login;
  writeFileSync(URLS_PATH, JSON.stringify(u, null, 2) + "\n");
  return { ok: true };
}

export function deleteEnv(name: string): { ok: boolean; error?: string; demo?: boolean } {
  if (IS_DEMO) return denyInDemo;
  const u = loadUrls();
  if (!u[name]) return { ok: false, error: "No such environment." };
  delete u[name];
  writeFileSync(URLS_PATH, JSON.stringify(u, null, 2) + "\n");
  // Note: the tests/<name> folder and its files are left alone on purpose.
  return { ok: true };
}

// ------------------------------------------------------------------- login form
// Resolve an env's login form the same way config/environments.ts getLoginForm
// does (env.login → shared _login → generic default), but without importing the
// TS module, so the server can pre-authenticate for recording.
export const DEFAULT_LOGIN_FORM = { path: "/login", username: "#email", password: "#password", submit: "log in" };

export function resolveLoginForm(env: string): { path: string; username: string; password: string; submit: string } {
  const u = loadUrls();
  const shared = sanitizeLoginForm(u._login);
  const per = sanitizeLoginForm(u[env] && u[env].login);
  const pick = (k: string): string => per[k] || shared[k] || (DEFAULT_LOGIN_FORM as Record<string, string>)[k];
  return { path: pick("path"), username: pick("username"), password: pick("password"), submit: pick("submit") };
}
