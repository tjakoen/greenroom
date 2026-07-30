// spike/db/migrate.ts
// THROWAWAY spike (P0 spike A) — proves drizzle-orm/bun-sqlite/migrator applies the
// drizzle-kit-generated SQL migration(s) in spike/db/migrations/ to a fresh db.
// Run with: bun spike/db/migrate.ts
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { unlinkSync, existsSync } from "node:fs";
import { widget } from "./schema";

const DB_PATH = `${import.meta.dir}/spike-migrated.db`;

for (const suffix of ["", "-wal", "-shm"]) {
  const p = DB_PATH + suffix;
  if (existsSync(p)) unlinkSync(p);
}

const sqlite = new Database(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL;");
const db = drizzle(sqlite);

// Fresh db, no tables yet — migrate() must create `widget` from the generated SQL.
migrate(db, { migrationsFolder: `${import.meta.dir}/migrations` });

// Prove the table exists and is usable post-migration.
db.insert(widget)
  .values({ id: "m1", name: "Migrated widget", createdAt: new Date() })
  .run();

const rows = db.select().from(widget).all();
console.log("Rows after migrate() on a fresh db:");
console.log(rows);

// A drizzle-kit migrations table is created to track applied migrations — confirm it.
const migTable = sqlite
  .query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%migrations%'")
  .all();
console.log("Migration-tracking table(s):", migTable);

sqlite.close();

for (const suffix of ["", "-wal", "-shm"]) {
  const p = DB_PATH + suffix;
  if (existsSync(p)) unlinkSync(p);
}

console.log("Cleaned up spike-migrated.db (+ WAL/SHM sidecars).");
