// db/schema.ts
// Drizzle sqlite-core table definitions for the app tables Greenroom itself owns.
//
// Ownership split (plans/platform.md §3, "P0 spike B — table ownership" box):
// better-auth owns `user`/`session`/`account`/`verification` (+ organization/admin/sso plugin
// tables) via its own built-in bun:sqlite runner — NOT drizzle. Those tables are NOT defined
// here. This file defines only the app tables the plugins don't provide: environment,
// credential, role, envGroup, test, testVersion, run, runResult, auditLog.
//
// ownerId / teamId / authorId / triggeredBy / actorId are plain text columns that reference
// better-auth-owned tables (user/team) by id — drizzle does not own those tables, so no FK
// constraint is declared for them. FKs ARE declared among our own tables (testVersion.testId,
// runResult.runId).
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/** Shared visibility levels for shareable resources. Company-internal default-open (§4). */
export type Visibility = "private" | "team" | "company";

/** Per-environment (or shared `_login`) login-form shape, mirrors config/urls.json `login`. */
export interface LoginFormConfig {
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  usernameField?: string;
  passwordField?: string;
  [key: string]: unknown;
}

/** role.envScope — which environments (by id) a role applies to. */
export type EnvScope = string[];

/** test.tags — @tags parsed from the spec title, kept in sync in the DB copy. */
export type TestTags = string[];

/** run.scope — the picked run scope (files/grep/env list) that produced this run. */
export interface RunScope {
  envs?: string[];
  files?: string[];
  grep?: string;
  [key: string]: unknown;
}

/** auditLog.before / auditLog.after — arbitrary snapshot of the changed entity. */
export type AuditSnapshot = Record<string, unknown>;

/** Generates a new text primary key. Shared by every table's `id` column. */
export function id(): string {
  return crypto.randomUUID();
}

export const environment = sqliteTable("environment", {
  id: text("id").primaryKey().$defaultFn(id),
  name: text("name").notNull(),
  baseURL: text("base_url").notNull(),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  loginForm: text("login_form", { mode: "json" }).$type<LoginFormConfig>(),
  ownerId: text("owner_id").notNull(),
  teamId: text("team_id"),
  visibility: text("visibility").$type<Visibility>().notNull().default("company"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const credential = sqliteTable("credential", {
  id: text("id").primaryKey().$defaultFn(id),
  label: text("label").notNull(),
  envId: text("env_id"),
  teamId: text("team_id"),
  ownerId: text("owner_id").notNull(),
  visibility: text("visibility").$type<Visibility>().notNull().default("company"),
  username: text("username").notNull(),
  secretEnc: text("secret_enc").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const role = sqliteTable("role", {
  id: text("id").primaryKey().$defaultFn(id),
  label: text("label").notNull(),
  envScope: text("env_scope", { mode: "json" }).$type<EnvScope>(),
  ownerId: text("owner_id").notNull(),
  teamId: text("team_id"),
  visibility: text("visibility").$type<Visibility>().notNull().default("company"),
});

export const envGroup = sqliteTable("env_group", {
  id: text("id").primaryKey().$defaultFn(id),
  label: text("label").notNull(),
  envIds: text("env_ids", { mode: "json" }).$type<string[]>(),
  roleId: text("role_id"),
  ownerId: text("owner_id").notNull(),
  teamId: text("team_id"),
  visibility: text("visibility").$type<Visibility>().notNull().default("company"),
});

export const test = sqliteTable("test", {
  id: text("id").primaryKey().$defaultFn(id),
  title: text("title").notNull(),
  filePath: text("file_path").notNull(),
  tags: text("tags", { mode: "json" }).$type<TestTags>(),
  group: text("group"),
  priority: text("priority"),
  owner: text("owner"),
  notes: text("notes"),
  runAsRole: text("run_as_role"),
  ownerId: text("owner_id").notNull(),
  teamId: text("team_id"),
  visibility: text("visibility").$type<Visibility>().notNull().default("company"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const testVersion = sqliteTable("test_version", {
  id: text("id").primaryKey().$defaultFn(id),
  testId: text("test_id")
    .notNull()
    .references(() => test.id),
  source: text("source").notNull(),
  authorId: text("author_id").notNull(),
  message: text("message"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const run = sqliteTable("run", {
  id: text("id").primaryKey().$defaultFn(id),
  envLabel: text("env_label").notNull(),
  status: text("status").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  triggeredBy: text("triggered_by").notNull(),
  scope: text("scope", { mode: "json" }).$type<RunScope>(),
  artifactDir: text("artifact_dir").notNull(),
});

export const runResult = sqliteTable("run_result", {
  id: text("id").primaryKey().$defaultFn(id),
  runId: text("run_id")
    .notNull()
    .references(() => run.id),
  testId: text("test_id").notNull(),
  env: text("env").notNull(),
  status: text("status").notNull(),
  durationMs: integer("duration_ms"),
});

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey().$defaultFn(id),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  before: text("before", { mode: "json" }).$type<AuditSnapshot>(),
  after: text("after", { mode: "json" }).$type<AuditSnapshot>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
