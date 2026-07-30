// spike/auth/migrate.ts
// THROWAWAY spike (P0 spike B) — creates better-auth's required tables in auth.db.
//
// GOTCHA (documented in the report): `bunx @better-auth/cli generate|migrate` cannot load
// spike/auth/auth.ts at all — the CLI loads your config through `jiti` (for TS/ESM interop),
// and jiti's own module resolver does not understand Bun's virtual `bun:sqlite` specifier. It
// fails with `Cannot find module 'bun:sqlite'` even though the process is invoked via `bunx`
// and Bun itself supports the import fine. This isn't limited to a raw `import` in our file —
// it reproduces identically one level down through `drizzle-orm/bun-sqlite` (tried, same crash,
// see report). So *no* config that ultimately touches bun:sqlite can go through the CLI's
// config loader today.
//
// Fix used here: skip the CLI's config-loading step entirely and call the exact functions the
// CLI itself calls — `getMigrations` from `better-auth/db` (see `getMigrations`/`runMigrations`
// in node_modules/@better-auth/cli/dist/index.mjs) — directly from a plain Bun script. No jiti
// involved, so bun:sqlite resolves normally. This is only possible because the CLI's `migrate`
// command supports the **built-in Kysely-backed adapter** (raw bun:sqlite Database) — for the
// Drizzle adapter the CLI explicitly refuses migrate ("only works with the built-in Kysely
// adapter... for Drizzle, run `generate` then use Drizzle's migrate/push").
//
// Run with: bun spike/auth/migrate.ts
import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth";

const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);

console.log("Tables to be created:", toBeCreated.map((t) => t.table));
console.log("Fields to be added to existing tables:", toBeAdded.map((t) => t.table));

await runMigrations();

console.log("Migration complete.");
