// lib/paths.ts — the shared path + demo spine every domain lib module imports.
// Ported from the top-of-file constants of interface/server.js. Domain modules declare their
// OWN config-file paths from ROOT/DEMO_DIR (as server.js did, grouped by concern); this file
// holds only what genuinely crosses modules: the root, the demo switch, and a few helpers.
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";

// lib/ sits one level under the repo root (interface/server.js used __dirname/.. from interface/).
export const ROOT = join(import.meta.dir, "..");
export const PORT = Number(Bun.env.PORT ?? 4321);

// Demo mode: read seeded fixtures from demo/ instead of the user's live data, and refuse every
// write. Lets a fresh clone show a fully-populated, safe, read-only app (bun run demo). Domain
// modules swap their read boundary to DEMO_DIR when IS_DEMO, and return denyInDemo from writes.
export const IS_DEMO = Bun.env.GREENROOM_DEMO === "1";
export const DEMO_DIR = join(ROOT, "demo");
export const denyInDemo = { ok: false as const, demo: true as const, error: "Demo mode is read-only." };

export const TESTS_DIR = join(ROOT, "tests");
// App-managed test metadata sidecar (group/priority/owner/notes/role), demo-swapped. Shared by
// tests-lib (loadMeta/saveMeta) and recorder (setRecordedRole).
export const META_FILE = IS_DEMO ? join(DEMO_DIR, "tests-meta.json") : join(TESTS_DIR, "tests-meta.json");

/** Read a file if present, else "" (never throws). Mirrors server.js readFileMaybe. */
export function readFileMaybe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** Validate a user-supplied test path: a *.spec.ts that actually exists inside tests/. Mirrors
 *  server.js validTestFile — the traversal guard behind every file-scoped run/rename/meta write. */
export function validTestFile(rel: unknown): rel is string {
  if (typeof rel !== "string" || !rel.endsWith(".spec.ts")) return false;
  const target = normalize(join(ROOT, rel));
  return target.startsWith(TESTS_DIR + sep) && existsSync(target);
}
