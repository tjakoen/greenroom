// lib/roles.ts — role definitions (config/roles.json).
// roles.json holds role DEFINITIONS ONLY — a role's name, label, and which
// environments (sites) it applies to. It NEVER holds credentials; those stay in
// the git-ignored .env. This split lets the app show a role↔site map and let
// users create roles before any login is filled in.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, IS_DEMO, DEMO_DIR, denyInDemo, readFileMaybe } from "./paths.ts";
import { scanCredRoles, parseEnvText, envPrefix, roleVar, ENV_FILE } from "./creds.ts";
import { envNames } from "./envs.ts";

const ROLES_PATH = IS_DEMO ? join(DEMO_DIR, "roles.json") : join(ROOT, "config", "roles.json");
const ROLES_EXAMPLE_PATH = join(ROOT, "config", "roles.example.json");

export type RoleDef = { label: string; envs: string[] | "all" };

function normalizeRoles(obj: any): Record<string, RoleDef> {
  const out: Record<string, RoleDef> = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith("_")) continue; // skip _comment
    if (!v || typeof v !== "object") continue;
    const vv = v as any;
    const envs: string[] | "all" =
      vv.envs === "all" ? "all" : Array.isArray(vv.envs) ? vv.envs.filter((e: any) => typeof e === "string") : "all";
    out[k] = { label: typeof vv.label === "string" && vv.label ? vv.label : k, envs };
  }
  return out;
}

export function loadRolesRaw(): Record<string, RoleDef> {
  const file = existsSync(ROLES_PATH) ? ROLES_PATH : existsSync(ROLES_EXAMPLE_PATH) ? ROLES_EXAMPLE_PATH : null;
  if (!file) return {};
  try {
    return normalizeRoles(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return {};
  }
}

function saveRolesRaw(roles: Record<string, RoleDef>): void {
  writeFileSync(ROLES_PATH, JSON.stringify(roles, null, 2) + "\n");
}

// Seed config/roles.json once, on first boot: start from the committed template
// (if any), then merge in every role already implied by existing .env vars so a
// migrating user's roles carry over. Runs only when roles.json doesn't exist yet.
export function seedRoles(): void {
  if (IS_DEMO) return; // demo/roles.json ships committed; never write in demo
  if (existsSync(ROLES_PATH)) return;
  const defs = loadRolesRaw(); // picks up roles.example.json if present
  for (const { env, name } of scanCredRoles()) {
    if (!defs[name]) defs[name] = { label: name.replace(/-/g, " "), envs: [] };
    const envsArr = defs[name].envs;
    if (envsArr !== "all" && !envsArr.includes(env)) envsArr.push(env);
  }
  try {
    saveRolesRaw(defs);
  } catch {
    /* best effort — a read-only checkout still works via loadRolesRaw fallback */
  }
}
seedRoles();

// Role definitions expanded with per-env credential status. This is what the
// Roles & logins UI renders: for each role, the sites it maps to, the saved
// USERNAME (so the field pre-fills) and whether the password is set. The
// password itself is never returned.
export function rolesWithStatus(): any[] {
  const dot: Record<string, string> = IS_DEMO ? {} : parseEnvText(readFileMaybe(ENV_FILE));
  // config/roles.json is the single source of truth for which roles exist. Legacy
  // roles implied only by raw .env var names are migrated into roles.json once by
  // seedRoles() on first boot; we deliberately do NOT re-union them here, so that
  // editing (or deleting a role from) roles.json is honoured immediately instead
  // of being silently overridden by a matching leftover .env credential. The .env
  // is still read below — but only to report each role's per-env credential
  // status, never to conjure a role.
  const defs = loadRolesRaw();
  const allEnvs = envNames();
  const out: any[] = [];
  for (const [name, def] of Object.entries(defs)) {
    const envs = def.envs === "all" ? allEnvs : def.envs.filter((e) => allEnvs.includes(e));
    const roleUp = roleVar(name);
    const sites = envs.map((env) => {
      // In demo mode every login reads as configured (no real .env, never any values).
      if (IS_DEMO) return { env, username: "", usernameSet: true, passwordSet: true };
      // Same resolution order as getUser: env-scoped var wins, shared var falls back.
      const u = dot[`${envPrefix(env)}${roleUp}_USERNAME`] ?? dot[`${roleUp}_USERNAME`];
      const p = dot[`${envPrefix(env)}${roleUp}_PASSWORD`] ?? dot[`${roleUp}_PASSWORD`];
      // The saved USERNAME is returned so the field can pre-fill it — it's the
      // user's own test-account name on their own machine. The PASSWORD is never
      // returned (only whether it's set); the UI shows it masked as "•••••• (saved)".
      return { env, username: (u || "").trim(), usernameSet: !!(u && u.trim()), passwordSet: !!(p && p.trim()) };
    });
    out.push({ name, label: def.label, envs: def.envs, sites });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Create or update a role definition (name, label, which sites/envs it maps to).
export function saveRole({
  name,
  label,
  envs,
}: {
  name: string;
  label?: string;
  envs?: string[] | "all";
}): { ok: boolean; error?: string; name?: string; demo?: boolean } {
  if (IS_DEMO) return denyInDemo;
  const clean = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!clean) return { ok: false, error: "Enter a role name (letters, numbers, dashes — e.g. admin)." };
  let envsVal: string[] | "all" = "all";
  if (Array.isArray(envs)) envsVal = envs.filter((e) => envNames().includes(e));
  else if (envs !== "all") envsVal = [];
  const defs = loadRolesRaw();
  defs[clean] = { label: typeof label === "string" && label.trim() ? label.trim() : clean, envs: envsVal };
  saveRolesRaw(defs);
  return { ok: true, name: clean };
}

// Remove a role DEFINITION. Deliberately leaves any stored .env logins untouched
// — deleting a definition must never destroy secrets.
export function deleteRole(name: string): { ok: boolean; error?: string; demo?: boolean } {
  if (IS_DEMO) return denyInDemo;
  const defs = loadRolesRaw();
  if (!defs[name]) return { ok: false, error: "No such role." };
  delete defs[name];
  saveRolesRaw(defs);
  return { ok: true };
}
