// drizzle.config.ts
// drizzle-kit config for the real app schema (db/schema.ts). Config loading is pure JS (no
// bun:sqlite import), so it's unaffected by the jiti/bun-sqlite gotcha noted in
// plans/platform.md §3 — that gotcha only applies to better-auth's own migration runner.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./db/schema.ts",
  out: "./db/migrations",
});
