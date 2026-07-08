/**
 * Per-branch environment config.
 *
 * The environments themselves live in config/urls.json (single source of truth,
 * also read by the recorder and editable from the app's Environments panel).
 * This file just loads them. Nothing secret here — logins live in your .env file.
 *
 * `TEST_ENV` (set by the npm scripts / the interface) picks which one is used.
 */
import * as fs from 'fs';
import * as path from 'path';

export type EnvName = string;

export interface EnvConfig {
  /** Base URL Playwright navigates to for page.goto('/...'). */
  baseURL: string;
}

/**
 * How an environment's login form is laid out, so `login()` (and pre-auth
 * recording) can drive it without the app's source. Kept as per-app DATA in
 * urls.json — never hardcoded in the committed repo — so Greenroom stays generic.
 */
export interface LoginForm {
  /** Login page, relative to the env's baseURL (e.g. "/login"). */
  path: string;
  /** Selector for the username / email input. */
  username: string;
  /** Selector for the password input. */
  password: string;
  /** The submit button's accessible name (matched case-insensitively). */
  submit: string;
}

// Generic fallback used only when neither the env nor the shared `_login` block
// defines a form. These are placeholders — real selectors live in git-ignored
// urls.json (per env or under the shared `_login` key), editable in-app.
const DEFAULT_LOGIN: LoginForm = { path: '/login', username: '#email', password: '#password', submit: 'log in' };

interface EnvEntry {
  baseURL: string;
  default?: boolean;
}
type UrlsFile = Record<string, EnvEntry>;

// The parsed urls.json (or the committed template on a fresh clone), unfiltered
// so callers can read non-env keys like `_login`.
function rawUrlsFile(): Record<string, unknown> {
  // urls.json holds your real environments and is git-ignored. On a fresh clone
  // it may not exist yet, so fall back to the committed template.
  const own = path.join(__dirname, 'urls.json');
  const example = path.join(__dirname, 'urls.example.json');
  const file = fs.existsSync(own) ? own : example;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

function loadUrls(): UrlsFile {
  const parsed = rawUrlsFile();
  const out: UrlsFile = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (key.startsWith('_')) continue; // skip _comment / _login etc.
    if (val && typeof val === 'object' && typeof (val as { baseURL?: unknown }).baseURL === 'string') {
      const entry = val as { baseURL: string; default?: unknown };
      out[key] = { baseURL: entry.baseURL, default: entry.default === true };
    }
  }
  return out;
}

/**
 * Resolve the login form for an environment. Precedence: the env's own `login`
 * block → the shared top-level `_login` block → the generic DEFAULT_LOGIN. Each
 * field falls back independently, so `_login` can set the common form and an env
 * override just the one field that differs.
 */
export function getLoginForm(env?: EnvName): LoginForm {
  const raw = rawUrlsFile();
  const asForm = (v: unknown): Partial<LoginForm> => (v && typeof v === 'object' ? (v as Partial<LoginForm>) : {});
  const shared = asForm(raw._login);
  const name = env || getEnvName();
  const perEnv = asForm((raw[name] as { login?: unknown } | undefined)?.login);
  const pick = (k: keyof LoginForm): string => {
    const p = perEnv[k];
    const s = shared[k];
    if (typeof p === 'string' && p.trim()) return p;
    if (typeof s === 'string' && s.trim()) return s;
    return DEFAULT_LOGIN[k];
  };
  return { path: pick('path'), username: pick('username'), password: pick('password'), submit: pick('submit') };
}

export function envNames(): EnvName[] {
  return Object.keys(loadUrls());
}

export function getEnvName(): EnvName {
  const urls = loadUrls();
  const names = Object.keys(urls);
  // Explicit choice wins; otherwise the env flagged "default": true in urls.json.
  // We never silently fall back to "whichever is first" — a default is picked
  // deliberately so a bare `playwright test` can't hit the wrong (e.g. prod) site.
  const name = process.env.TEST_ENV || names.find((k) => urls[k].default);
  if (!name) {
    throw new Error(
      `No environment selected. Set TEST_ENV (one of: ${names.join(', ') || 'none defined'}) ` +
        `or mark one environment "default": true in config/urls.json.`,
    );
  }
  if (!names.includes(name)) {
    throw new Error(`Unknown TEST_ENV "${name}". Valid options: ${names.join(', ')}`);
  }
  return name;
}

export function getEnv(): EnvConfig {
  return loadUrls()[getEnvName()];
}

export function baseURLof(env: EnvName): string {
  // Look up one named environment's baseURL. Used when a run targets several
  // envs at once (one project each) and each project needs its own baseURL.
  const urls = loadUrls();
  const entry = urls[env];
  if (!entry) {
    throw new Error(`Unknown environment "${env}". Valid options: ${Object.keys(urls).join(', ')}`);
  }
  return entry.baseURL;
}

export function getSelectedEnvs(): EnvName[] {
  // `TEST_ENVS` (comma-separated) runs several environments simultaneously —
  // one Playwright project per env. Unset/empty falls back to the single-env
  // path (getEnvName), so its default/validation logic is preserved.
  const raw = process.env.TEST_ENVS;
  if (!raw || !raw.trim()) {
    return [getEnvName()];
  }
  const names = Object.keys(loadUrls());
  const picked: EnvName[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (!name) continue; // drop empties (trailing comma, "a,,b" etc.)
    if (!names.includes(name)) {
      throw new Error(`Unknown environment "${name}" in TEST_ENVS. Valid options: ${names.join(', ')}`);
    }
    if (!picked.includes(name)) picked.push(name); // dedupe, preserve order
  }
  // Everything after trimming could still be empty (e.g. TEST_ENVS=",,").
  if (picked.length === 0) {
    return [getEnvName()];
  }
  return picked;
}
