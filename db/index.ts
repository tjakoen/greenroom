// db/index.ts
// Opens the one physical Greenroom db file and exposes a typed Drizzle client.
//
// Ownership split (plans/platform.md §3 box): better-auth manages its own tables via its own
// runner against the same `Database` handle; this module only owns migrating + querying the
// app tables in ./schema.ts. Boot sequence (server.ts, Gate 2): open db -> WAL pragma ->
// better-auth runMigrations() -> runAppMigrations() (this file) -> serve. Migrations are NOT
// run at import time here, on purpose — only `runAppMigrations()` runs them, so the caller
// controls when/whether that happens.
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

const DB_PATH = `${import.meta.dir}/../data/greenroom.db`;

mkdirSync(dirname(DB_PATH), { recursive: true });

export const sqlite = new Database(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

export const db = drizzle(sqlite, { schema });

/** Applies the drizzle-kit-generated app-table migrations in db/migrations/. */
export function runAppMigrations(): void {
  migrate(db, { migrationsFolder: `${import.meta.dir}/migrations` });
}
