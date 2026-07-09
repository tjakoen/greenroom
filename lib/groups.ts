// lib/groups.ts — site groups (config/groups.json).
// A named, saved set of environments (optionally pinned to a role) so a user can
// select "dev + staging" in one click on the Run page instead of re-ticking pills
// each time. Holds no secrets — just env names and an optional role name.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, IS_DEMO, DEMO_DIR, denyInDemo } from "./paths.ts";
import { envNames } from "./envs.ts";
import { loadRolesRaw } from "./roles.ts";

const GROUPS_PATH = IS_DEMO ? join(DEMO_DIR, "groups.json") : join(ROOT, "config", "groups.json");
const GROUPS_EXAMPLE_PATH = join(ROOT, "config", "groups.example.json");

export type GroupDef = { label: string; envs: string[]; role: string };

function normalizeGroups(obj: any): Record<string, GroupDef> {
  const out: Record<string, GroupDef> = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith("_")) continue;
    if (!v || typeof v !== "object") continue;
    const vv = v as any;
    out[k] = {
      label: typeof vv.label === "string" && vv.label ? vv.label : k,
      envs: Array.isArray(vv.envs) ? vv.envs.filter((e: any) => typeof e === "string") : [],
      role: typeof vv.role === "string" ? vv.role : "",
    };
  }
  return out;
}

function loadGroupsRaw(): Record<string, GroupDef> {
  const file = existsSync(GROUPS_PATH) ? GROUPS_PATH : existsSync(GROUPS_EXAMPLE_PATH) ? GROUPS_EXAMPLE_PATH : null;
  if (!file) return {};
  try {
    return normalizeGroups(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return {};
  }
}

// Groups filtered to still-valid envs, with a flag if any member env is gone.
export function listGroups(): any[] {
  const known = envNames();
  return Object.entries(loadGroupsRaw())
    .map(([name, g]) => {
      const envs = g.envs.filter((e) => known.includes(e));
      return { name, label: g.label, envs, role: g.role, missing: g.envs.length !== envs.length };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function saveGroup({
  name,
  label,
  envs,
  role,
}: {
  name: string;
  label?: string;
  envs?: string[];
  role?: string;
}): { ok: boolean; error?: string; name?: string; demo?: boolean } {
  if (IS_DEMO) return denyInDemo;
  const clean = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!clean) return { ok: false, error: "Enter a group name (letters, numbers, dashes — e.g. non-prod)." };
  const envsVal = Array.isArray(envs) ? envs.filter((e) => envNames().includes(e)) : [];
  if (!envsVal.length) return { ok: false, error: "Pick at least one environment for the group." };
  const roleVal = typeof role === "string" && loadRolesRaw()[role] ? role : "";
  const defs = loadGroupsRaw();
  defs[clean] = { label: typeof label === "string" && label.trim() ? label.trim() : clean, envs: envsVal, role: roleVal };
  writeFileSync(GROUPS_PATH, JSON.stringify(defs, null, 2) + "\n");
  return { ok: true, name: clean };
}

export function deleteGroup(name: string): { ok: boolean; error?: string; demo?: boolean } {
  if (IS_DEMO) return denyInDemo;
  const defs = loadGroupsRaw();
  if (!defs[name]) return { ok: false, error: "No such group." };
  delete defs[name];
  writeFileSync(GROUPS_PATH, JSON.stringify(defs, null, 2) + "\n");
  return { ok: true };
}
