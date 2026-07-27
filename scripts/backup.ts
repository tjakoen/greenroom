// scripts/backup.ts
// Safe hot backup of the Greenroom SQLite db (PLATFORM edition).
//
// Run with:  bun scripts/backup.ts [dest-dir-or-file]
//   - no arg           -> writes <db-dir>/backups/greenroom-<UTC-stamp>.db
//   - a directory      -> writes <dir>/greenroom-<UTC-stamp>.db
//   - a *.db file path  -> writes exactly there (must not already exist)
//
// Uses SQLite's `VACUUM INTO`, NOT a file copy. Under WAL a plain `cp` of the .db can capture a
// torn state (committed pages still in -wal), so a copy-based backup is corrupt-prone. `VACUUM INTO`
// takes a read transaction and writes a single, fully-checkpointed, defragmented snapshot to a new
// file — consistent even while the server is live and writing. The snapshot is then reopened
// read-only and `PRAGMA integrity_check`'d before we call it good.
//
// Source db path mirrors db/index.ts: GREENROOM_DB_PATH overrides the default data/greenroom.db,
// so a deployment backs up whatever volume it runs against. Old backups are pruned to the newest
// GREENROOM_BACKUP_KEEP (default 30), matching the runs/ retention doctrine (DEPLOY.md).
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ROOT } from "../lib/paths.ts";

const SRC = process.env.GREENROOM_DB_PATH || join(ROOT, "data", "greenroom.db");
const KEEP = Math.max(1, Number(process.env.GREENROOM_BACKUP_KEEP) || 30);
const PREFIX = "greenroom-";

function stamp(): string {
  // UTC, filename-safe, lexically sortable (so name-sort == time-sort for pruning).
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveDest(arg: string | undefined): string {
  if (arg && arg.endsWith(".db")) return arg; // explicit file
  const dir = arg || join(dirname(SRC), "backups");
  return join(dir, `${PREFIX}${stamp()}.db`);
}

function prune(dir: string): number {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(PREFIX) && f.endsWith(".db"));
  } catch {
    return 0;
  }
  files.sort().reverse(); // newest (highest stamp) first
  let removed = 0;
  for (const f of files.slice(KEEP)) {
    try { unlinkSync(join(dir, f)); removed++; } catch { /* best-effort */ }
  }
  return removed;
}

function main(): void {
  if (!existsSync(SRC)) {
    console.error(`backup: no db at ${SRC} — nothing to back up (set GREENROOM_DB_PATH?).`);
    process.exit(1);
  }
  const dest = resolveDest(process.argv[2]);
  if (existsSync(dest)) {
    console.error(`backup: destination already exists: ${dest}`);
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });

  // VACUUM INTO a SQL string literal — escape single quotes (paths here can contain spaces, which
  // are fine inside the quotes; a lone quote would break the statement).
  const litDest = dest.replace(/'/g, "''");
  const src = new Database(SRC, { readonly: true });
  try {
    src.exec(`VACUUM INTO '${litDest}'`);
  } finally {
    src.close();
  }

  // Verify the snapshot before reporting success.
  const check = new Database(dest, { readonly: true });
  let ok = false;
  try {
    const row = check.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null;
    ok = row?.integrity_check === "ok";
  } finally {
    check.close();
  }
  if (!ok) {
    console.error(`backup: integrity_check FAILED for ${dest} — leaving it for inspection.`);
    process.exit(2);
  }

  const bytes = statSync(dest).size;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  const removed = prune(dirname(dest));
  console.log(`backup: ${basename(dest)} (${mb} MB) verified ok in ${dirname(dest)}` +
    (removed ? ` — pruned ${removed} old backup${removed === 1 ? "" : "s"} (keep ${KEEP})` : ""));
}

main();
