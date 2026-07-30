// spike/db/run.ts
// THROWAWAY spike (P0 spike A) — proves drizzle-orm works over bun:sqlite in THIS repo.
// Run with: bun spike/db/run.ts
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { unlinkSync, existsSync } from "node:fs";
import { widget } from "./schema";

const DB_PATH = `${import.meta.dir}/spike.db`;

// Clean slate: drop any leftover db/wal/shm from a previous run.
for (const suffix of ["", "-wal", "-shm"]) {
  const p = DB_PATH + suffix;
  if (existsSync(p)) unlinkSync(p);
}

const sqlite = new Database(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL;");

const db = drizzle(sqlite);

// Create the table directly (no migrations here — see migrate.ts for the migrator flow).
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS widget (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

db.insert(widget)
  .values([
    { id: "1", name: "First widget", createdAt: new Date() },
    { id: "2", name: "Second widget", createdAt: new Date() },
  ])
  .run();

const rows = db.select().from(widget).all();
console.log("Rows from widget table:");
console.log(rows);

sqlite.close();

// Cleanup: remove the db file (+ WAL/SHM sidecars) so the spike leaves no artifact.
for (const suffix of ["", "-wal", "-shm"]) {
  const p = DB_PATH + suffix;
  if (existsSync(p)) unlinkSync(p);
}

console.log("Cleaned up spike.db (+ WAL/SHM sidecars).");
