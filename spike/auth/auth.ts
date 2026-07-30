// spike/auth/auth.ts
// THROWAWAY spike (P0 spike B) — proves better-auth email/password over bun:sqlite.
//
// Adapter choice: better-auth's core options type (@better-auth/core/dist/types/init-options.d.mts)
// declares `database?: PostgresPool | MysqlPool | SqliteDatabase | Dialect | DBAdapterInstance
// | Database (from "bun:sqlite") | DatabaseSync | D1Database | {...}` — i.e. better-auth has
// FIRST-CLASS built-in support for a raw bun:sqlite Database instance, no adapter package needed.
// That's simpler than wiring the Drizzle adapter (which also works — @better-auth/drizzle-adapter's
// drizzleAdapter(db, { provider: "sqlite", schema }) — and is what §3's app tables will use), so for
// THIS spike we pass the bun:sqlite Database straight through. Internally better-auth drives it via
// Kysely's sqlite dialect (see the Dialect/SqliteDatabase types from "kysely" in the same union).
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";

export const DB_PATH = `${import.meta.dir}/auth.db`;

export const sqlite = new Database(DB_PATH);

export const auth = betterAuth({
  database: sqlite,
  emailAndPassword: {
    enabled: true,
  },
  secret: "spike-only-not-a-real-secret",
  baseURL: "http://localhost:4321",
});
