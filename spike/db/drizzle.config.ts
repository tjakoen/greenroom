// spike/db/drizzle.config.ts
// THROWAWAY spike (P0 spike A) — minimal drizzle-kit config to prove `generate` works
// against sqlite-core + bun:sqlite in this repo.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./spike/db/schema.ts",
  out: "./spike/db/migrations",
});
