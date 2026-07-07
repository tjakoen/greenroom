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

interface EnvEntry {
  baseURL: string;
  default?: boolean;
}
type UrlsFile = Record<string, EnvEntry>;

function loadUrls(): UrlsFile {
  // urls.json holds your real environments and is git-ignored. On a fresh clone
  // it may not exist yet, so fall back to the committed template.
  const own = path.join(__dirname, 'urls.json');
  const example = path.join(__dirname, 'urls.example.json');
  const file = fs.existsSync(own) ? own : example;
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: UrlsFile = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (key.startsWith('_')) continue; // skip _comment etc.
    if (val && typeof val === 'object' && typeof (val as { baseURL?: unknown }).baseURL === 'string') {
      const entry = val as { baseURL: string; default?: unknown };
      out[key] = { baseURL: entry.baseURL, default: entry.default === true };
    }
  }
  return out;
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
