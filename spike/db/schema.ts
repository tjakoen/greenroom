// spike/db/schema.ts
// THROWAWAY spike (P0 spike A) — proves drizzle-orm sqlite-core over bun:sqlite.
// Mirrors the shape style the real plan needs: text primary key id, integer timestamps.
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const widget = sqliteTable("widget", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull(),
});
