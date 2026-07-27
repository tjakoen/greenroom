// db/index.ts
// Opens the one physical Greenroom db file and exposes a typed Drizzle client.
//
// Ownership split (plans/platform.md §3 box): better-auth manages its own tables via its own
// runner against the same `Database` handle; this module only owns migrating + querying the
// app tables in ./schema.ts. Boot sequence (server.ts, Gate 2): open db -> WAL pragma ->
// better-auth runMigrations() -> runAppMigrations() (this file) -> serve. Migrations are NOT
// run at import time here, on purpose — only `runAppMigrations()` runs them, so the caller
// controls when/whether that happens.
//
// LAZY-OPEN (local/platform split, lib/paths.ts IS_LOCAL): the db file is opened on FIRST ACCESS,
// never at import time. The LOCAL edition never touches the db (accounts/queue/scoped-APIs are all
// gated off in server.ts), so `data/greenroom.db` is never created and better-auth never loads.
// The exported `db`/`sqlite` are lazy proxies: the first property access triggers openSqlite().
// Platform boot forces the open explicitly via runAppMigrations()/openSqlite().
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

// Default location is data/greenroom.db next to the repo; GREENROOM_DB_PATH overrides it (a
// deployment can point at a managed volume, and tests point at a throwaway file / :memory:).
const DB_PATH = process.env.GREENROOM_DB_PATH || `${import.meta.dir}/../data/greenroom.db`;

let _sqlite: Database | null = null;
let _db: BunSQLiteDatabase<typeof schema> | null = null;

/** Open (once) the physical db file with the WAL + FK pragmas. Memoized — safe to call anywhere;
 *  the first call creates data/greenroom.db, later calls return the same handle. */
export function openSqlite(): Database {
  if (_sqlite) return _sqlite;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const s = new Database(DB_PATH);
  s.exec("PRAGMA journal_mode = WAL;");
  s.exec("PRAGMA foreign_keys = ON;");
  _sqlite = s;
  return s;
}

/** The memoized Drizzle client over the (lazily opened) sqlite handle. */
export function openDb(): BunSQLiteDatabase<typeof schema> {
  return (_db ??= drizzle(openSqlite(), { schema }));
}

// Lazy proxies so existing call sites (`db.select()…`, `sqlite.query()…`) work unchanged while the
// actual open is deferred to first use. `this`-bound so chained/prepared calls keep their receiver.
const lazyProxy = <T extends object>(open: () => T): T =>
  new Proxy({} as T, {
    get(_t, prop) {
      const real = open() as any;
      const v = real[prop];
      return typeof v === "function" ? v.bind(real) : v;
    },
  });

export const sqlite: Database = lazyProxy(openSqlite);
export const db: BunSQLiteDatabase<typeof schema> = lazyProxy(openDb);

/** Applies the drizzle-kit-generated app-table migrations in db/migrations/ (opens the db). */
export function runAppMigrations(): void {
  migrate(openDb(), { migrationsFolder: `${import.meta.dir}/migrations` });
}
