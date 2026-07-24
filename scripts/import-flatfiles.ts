// scripts/import-flatfiles.ts
// One-shot / idempotent flat-file -> SQLite importer (plans/platform.md §7, P1 Gate 3).
//
// Run with: bun scripts/import-flatfiles.ts
//
// Imports today's flat-file config (config/urls.json, config/roles.json, config/groups.json,
// tests/tests-meta.json + the specs on disk, runs/<id>/, .env) into the real app tables in
// db/schema.ts. Safe to run more than once: every row is looked up by a natural key first, so
// a repeat run reports everything as "skipped" (no duplicates).
//
// Uses the SAME flat-file readers the live app uses (lib/envs.ts, lib/roles.ts, lib/groups.ts,
// lib/tests-lib.ts, lib/records.ts) rather than re-parsing the on-disk shapes by hand, so the
// importer can never drift from how the app itself reads these files. The credential step (6,
// below) is the one exception — it re-derives (env, role) pairs generically from `.env` KEY
// NAMES using lib/creds.ts's own `parseEnvText`/`envPrefix` helpers (no env/role name is
// hardcoded), because lib/creds.ts itself has no "list every configured credential" reader.
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { and, eq } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import * as schema from "../db/schema";
import { credential, environment, envGroup, role, run, runResult, test, testVersion, id as newId } from "../db/schema";
import type { LoginFormConfig } from "../db/schema";
import { ROOT } from "../lib/paths.ts";
import { loadUrls } from "../lib/envs.ts";
import { loadRolesRaw } from "../lib/roles.ts";
import { listGroups } from "../lib/groups.ts";
import { loadMeta, parseTests, readResults, specFiles } from "../lib/tests-lib.ts";
import { listRuns, RUNS_DIR } from "../lib/records.ts";
import { ENV_FILE, envPrefix, parseEnvText } from "../lib/creds.ts";
import { encryptSecret } from "../lib/secret.ts";

// ---------------------------------------------------------------------------------------------
// Ownership sentinel (plans/platform.md §4 default-open policy).
//
// No Greenroom user accounts exist yet — better-auth (P1 gate 2) hasn't landed a `user` table
// this script can point at, and this gate builds the DB + importer only. Every imported row's
// `ownerId` column is NOT NULL, so we stamp a sentinel id instead of a real better-auth user id.
// It is never a valid session subject; a superadmin reassigns real ownership once accounts
// exist. Every imported row also gets `visibility: "company"` (default-open — everyone can read
// it until a user narrows it), per §4.
export const SYSTEM_OWNER_ID = "system";
const VISIBILITY = "company" as const;

type Db = BunSQLiteDatabase<typeof schema>;

// -------------------------------------------------------------------------------------- db open
// Normal use: reuse the app's own db/index.ts (opens data/greenroom.db, runs the drizzle-kit
// migrations). Verification use: GREENROOM_DB points the importer at a scratch file instead, so
// running it against a throwaway db never touches the real one. db/index.ts is intentionally
// NOT edited to support this — its module-top-level `new Database(...)` would open the real db
// as a side effect of merely importing it, so the override path opens its own handle instead,
// replicating db/index.ts's open sequence (WAL + foreign keys + migrate) exactly.
async function openDb(): Promise<{ db: Db; sqlite: Database }> {
  const override = process.env.GREENROOM_DB;
  if (override) {
    const sqlite = new Database(override);
    sqlite.exec("PRAGMA journal_mode = WAL;");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: `${import.meta.dir}/../db/migrations` });
    return { db, sqlite };
  }
  const mod = await import("../db/index.ts");
  mod.runAppMigrations();
  return { db: mod.db, sqlite: mod.sqlite };
}

// ------------------------------------------------------------------------------ small counters
interface Counts {
  created: number;
  skipped: number;
}
const counts = {
  environments: { created: 0, skipped: 0 } as Counts,
  roles: { created: 0, skipped: 0 } as Counts,
  groups: { created: 0, skipped: 0 } as Counts,
  tests: { created: 0, skipped: 0 } as Counts,
  testVersions: { created: 0, skipped: 0 } as Counts,
  runs: { created: 0, skipped: 0 } as Counts,
  runResults: { created: 0, skipped: 0 } as Counts,
  credentials: { created: 0, skipped: 0 } as Counts,
};

// ---------------------------------------------------------------------------------- credentials
// One (env, role) or (shared role) pair discovered by scanning `.env` KEY NAMES — never hardcoded
// to a specific env/role. `envName: null` means a shared `<ROLE>_*` credential (no env prefix).
interface CredEntry {
  label: string;
  username: string;
  password: string;
  envName: string | null;
}

// Derives credential entries from raw `.env` text using the SAME convention lib/creds.ts's
// envPrefix()/parseEnvText() encode (`<ENV>_<ROLE>_USERNAME/PASSWORD` env-scoped, shared
// `<ROLE>_USERNAME/PASSWORD` fallback) — `envNames` is the list of environments already imported
// in step 1, so this never needs to know any concrete env or role name up front. Longest env-name
// prefix wins first, so an env name that happens to be a prefix of another (e.g. "demo" vs.
// "demo-stage") doesn't mis-attribute a shared/other-env credential.
function parseCredentialEntries(envText: string, envNames: string[]): CredEntry[] {
  const dot = parseEnvText(envText);
  const sortedEnvs = [...envNames].sort((a, b) => b.length - a.length);
  const seenBases = new Set<string>();
  const out: CredEntry[] = [];
  for (const key of Object.keys(dot)) {
    if (!key.endsWith("_USERNAME")) continue;
    const base = key.slice(0, -"_USERNAME".length);
    if (!base || seenBases.has(base)) continue;
    seenBases.add(base);

    const username = (dot[key] || "").trim();
    const password = (dot[`${base}_PASSWORD`] || "").trim();
    if (!username || !password) continue; // only fully-configured pairs are real credentials

    let envName: string | null = null;
    let roleBase = base;
    for (const name of sortedEnvs) {
      const prefix = envPrefix(name); // e.g. "demo-stage" -> "DEMO_STAGE_"
      if (base.startsWith(prefix)) {
        envName = name;
        roleBase = base.slice(prefix.length);
        break;
      }
    }
    if (!roleBase) continue; // base WAS an env prefix with nothing after it — not a real role

    const role = roleBase.toLowerCase().replace(/_/g, "-");
    out.push({
      label: envName ? `${role}@${envName}` : `${role} (shared)`,
      username,
      password,
      envName,
    });
  }
  return out;
}

async function main() {
  const { db } = await openDb();

  // ------------------------------------------------------------------------- 1. environments
  // config/urls.json (loadUrls() already falls back to config/urls.example.json when urls.json
  // doesn't exist, mirroring today's app behavior). `_`-prefixed keys (`_login`, `_comment`,
  // `_examples`) are config, not environments — skipped. Each env's OWN `login` block is stored
  // as-is in loginForm; a shared `_login` default is deliberately NOT flattened into every row
  // (per §7 — the shared default stays a separate, not-yet-modeled concern).
  const urls = loadUrls();
  const envNameToId = new Map<string, string>();
  for (const [name, cfg] of Object.entries(urls)) {
    if (name.startsWith("_")) continue;
    if (!cfg || typeof cfg !== "object") continue;
    const c = cfg as { baseURL?: string; default?: boolean; login?: LoginFormConfig };
    if (!c.baseURL) continue;

    const existing = db.select().from(environment).where(eq(environment.name, name)).get();
    if (existing) {
      envNameToId.set(name, existing.id);
      counts.environments.skipped++;
      continue;
    }
    const rowId = newId();
    db.insert(environment)
      .values({
        id: rowId,
        name,
        baseURL: c.baseURL,
        isDefault: !!c.default,
        loginForm: c.login ?? null,
        ownerId: SYSTEM_OWNER_ID,
        visibility: VISIBILITY,
      })
      .run();
    envNameToId.set(name, rowId);
    counts.environments.created++;
  }

  // -------------------------------------------------------------------------------- 2. roles
  // config/roles.json (loadRolesRaw() falls back to roles.example.json the same way). Natural
  // key = role.label. envScope stores environment IDs (the NEW db ids, per db/schema.ts's
  // comment on role.envScope), resolved from the env-name list via envNameToId above; "all"
  // expands to every environment imported in step 1.
  const roleDefs = loadRolesRaw();
  const roleKeyToId = new Map<string, string>(); // roles.json KEY (e.g. "admin") -> new id
  for (const [key, def] of Object.entries(roleDefs)) {
    const existing = db.select().from(role).where(eq(role.label, def.label)).get();
    if (existing) {
      roleKeyToId.set(key, existing.id);
      counts.roles.skipped++;
      continue;
    }
    const envScope =
      def.envs === "all"
        ? [...envNameToId.values()]
        : def.envs.map((e) => envNameToId.get(e)).filter((v): v is string => !!v);
    const rowId = newId();
    db.insert(role)
      .values({
        id: rowId,
        label: def.label,
        envScope,
        ownerId: SYSTEM_OWNER_ID,
        visibility: VISIBILITY,
      })
      .run();
    roleKeyToId.set(key, rowId);
    counts.roles.created++;
  }

  // ------------------------------------------------------------------------------- 3. groups
  // config/groups.json (listGroups() falls back to groups.example.json if absent, same seed
  // philosophy as urls/roles). Natural key = env_group.label. envIds resolved like role.envScope
  // above. `group.role` in the flat file is the roles.json KEY (e.g. "admin"), not its
  // label, so it's resolved via roleKeyToId built in step 2 — NOT by label match, since two
  // roles could share a label but the flat file always references the unique key. An
  // unresolvable/empty role is stored as roleId: null rather than the label string, since every
  // other FK-shaped column here is an id.
  const groups = listGroups();
  for (const g of groups as { name: string; label: string; envs: string[]; role: string }[]) {
    const existing = db.select().from(envGroup).where(eq(envGroup.label, g.label)).get();
    if (existing) {
      counts.groups.skipped++;
      continue;
    }
    const envIds = g.envs.map((e) => envNameToId.get(e)).filter((v): v is string => !!v);
    const roleId = g.role ? (roleKeyToId.get(g.role) ?? null) : null;
    db.insert(envGroup)
      .values({
        id: newId(),
        label: g.label,
        envIds,
        roleId,
        ownerId: SYSTEM_OWNER_ID,
        visibility: VISIBILITY,
      })
      .run();
    counts.groups.created++;
  }

  // -------------------------------------------------------------------- 4. tests + versions
  // tests/tests-meta.json ("file::title" -> group/priority/owner/notes/role) UNIONED with every
  // spec discovered on disk (specFiles() + parseTests(), the same walk listTests() uses) so a
  // spec with no sidecar entry still gets a minimal test row, and a stale sidecar entry whose
  // title no longer matches any test() in the file still gets imported (nothing here silently
  // drops data). Natural key = filePath + title. Tags come from the discovered test's title when
  // available (authoritative — it's what --grep actually matches today); for a sidecar-only
  // (orphaned) entry, tags are parsed from the title string the same way.
  interface TestEntry {
    file: string;
    title: string;
    tags: string[];
    meta?: { group?: string; priority?: string; owner?: string; notes?: string; role?: string };
  }
  const entries = new Map<string, TestEntry>();
  for (const file of specFiles()) {
    for (const { title, tags } of parseTests(join(ROOT, file))) {
      entries.set(`${file}::${title}`, { file, title, tags });
    }
  }
  const meta = loadMeta();
  for (const [key, m] of Object.entries(meta)) {
    const existingEntry = entries.get(key);
    if (existingEntry) {
      existingEntry.meta = m as TestEntry["meta"];
      continue;
    }
    // Sidecar key not matched by any discovered test() — split "file::title" on the ".spec.ts::"
    // boundary (metaKey() in lib/tests-lib.ts always builds keys this way; file always ends in
    // .spec.ts, so this boundary is unambiguous even if the title itself contains "::").
    const marker = ".spec.ts::";
    const idx = key.indexOf(marker);
    if (idx === -1) continue; // malformed key — nothing to import
    const file = key.slice(0, idx + ".spec.ts".length);
    const title = key.slice(idx + marker.length);
    entries.set(key, { file, title, tags: title.match(/@[\w-]+/g) || [], meta: m as TestEntry["meta"] });
  }

  const sourceCache = new Map<string, string | null>();
  const readSpecSource = (file: string): string | null => {
    if (sourceCache.has(file)) return sourceCache.get(file)!;
    const abs = join(ROOT, file);
    const src = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    sourceCache.set(file, src);
    return src;
  };

  for (const entry of entries.values()) {
    const existing = db
      .select()
      .from(test)
      .where(and(eq(test.filePath, entry.file), eq(test.title, entry.title)))
      .get();
    let testId: string;
    if (existing) {
      testId = existing.id;
      counts.tests.skipped++;
    } else {
      const m = entry.meta || {};
      testId = newId();
      db.insert(test)
        .values({
          id: testId,
          title: entry.title,
          filePath: entry.file,
          tags: entry.tags,
          group: m.group || null,
          priority: m.priority || null,
          owner: m.owner || null,
          notes: m.notes || null,
          runAsRole: m.role || null,
          ownerId: SYSTEM_OWNER_ID,
          visibility: VISIBILITY,
        })
        .run();
      counts.tests.created++;
    }

    // Seed one initial version per test, only if it doesn't already have one (idempotent) and
    // the spec file still exists on disk (an orphaned sidecar entry with no matching file has no
    // source to snapshot).
    const hasVersion = db.select().from(testVersion).where(eq(testVersion.testId, testId)).get();
    if (hasVersion) {
      counts.testVersions.skipped++;
      continue;
    }
    const source = readSpecSource(entry.file);
    if (source == null) continue;
    db.insert(testVersion)
      .values({
        id: newId(),
        testId,
        source,
        authorId: SYSTEM_OWNER_ID,
        message: "imported",
      })
      .run();
    counts.testVersions.created++;
  }

  // ------------------------------------------------------------------------------- 5. runs
  // runs/<id>/ (folder name convention "<ISO-stamp>-<env>-<result>", parsed by listRuns() exactly
  // as the History page does). Natural key = artifactDir (repo-relative path). Per-test results
  // come from readResults(id) (the same reader the Tests page uses for history/flaky detection),
  // which reads runs/<id>/results/results.json when it exists; resolved to a testId by
  // basename(file)+title, matching how listTests()/testHistory() key results — that's the same
  // key shape results.json itself uses (its "file" is a bare basename, e.g. "login.spec.ts").
  const testIdByKey = new Map<string, string>();
  for (const t of db.select().from(test).all()) {
    testIdByKey.set(`${basename(t.filePath)}::${t.title}`, t.id);
  }

  for (const r of listRuns()) {
    const artifactDir = relative(ROOT, join(RUNS_DIR, r.id));
    const existing = db.select().from(run).where(eq(run.artifactDir, artifactDir)).get();
    if (existing) {
      counts.runs.skipped++;
      continue;
    }

    // Folder stamp is "YYYY-MM-DDTHH-MM-SS" — the dashes in the time part came from
    // archiveRun()'s `new Date().toISOString().replace(/[:.]/g, "-")`, which starts from a UTC
    // ISO string; re-appending "Z" round-trips it back to the original UTC instant.
    const stamp = r.id.slice(0, 19);
    const startedAt = new Date(`${stamp.slice(0, 10)}T${stamp.slice(11).replace(/-/g, ":")}Z`);

    const runId = newId();
    db.insert(run)
      .values({
        id: runId,
        envLabel: r.env,
        status: r.result,
        startedAt,
        finishedAt: null,
        triggeredBy: SYSTEM_OWNER_ID,
        scope: null,
        artifactDir,
      })
      .run();
    counts.runs.created++;

    for (const res of readResults(r.id) as { file: string; title: string; env: string; status: string; durationMs: number }[]) {
      const testId = testIdByKey.get(`${basename(res.file)}::${res.title}`);
      if (!testId) continue; // no matching imported test row — nothing to link this result to
      db.insert(runResult)
        .values({
          id: newId(),
          runId,
          testId,
          env: res.env,
          status: res.status,
          durationMs: res.durationMs || null,
        })
        .run();
      counts.runResults.created++;
    }
  }

  // ------------------------------------------------------------------------ 6. credentials
  // .env (`<ENV>_<ROLE>_USERNAME/PASSWORD` env-scoped, `<ROLE>_USERNAME/PASSWORD` shared) ->
  // credential rows. Natural key = label (env-scope + role name), like the other importers.
  // `secretEnc` is AES-256-GCM ciphertext from lib/secret.ts; the plaintext password only ever
  // lives in a local `const` for the one `encryptSecret` call below — never logged, never stored
  // unencrypted, never included in any console output.
  //
  // Transitional (plans/platform.md §7): the LIVE Playwright runner still reads `.env` directly
  // today via lib/creds.ts/users/roles.ts — completely unchanged by this step. This import only
  // populates the DB copy of these credentials for the future scoped Accounts UI (P2). Both the
  // flat `.env` and this DB copy coexist for now; this script never deletes or edits `.env`.
  //
  // GREENROOM_ENV_FILE (mirrors the GREENROOM_DB scratch-override above) lets verification point
  // the parser at a throwaway `.env` without ever touching the repo's real one; unset -> the real
  // `lib/creds.ts` ENV_FILE path.
  const envFilePath = process.env.GREENROOM_ENV_FILE || ENV_FILE;
  if (!existsSync(envFilePath)) {
    console.log("Credentials: no .env, 0 credentials");
  } else {
    const envText = readFileSync(envFilePath, "utf8");
    const entries = parseCredentialEntries(envText, [...envNameToId.keys()]);
    for (const entry of entries) {
      const existing = db.select().from(credential).where(eq(credential.label, entry.label)).get();
      if (existing) {
        counts.credentials.skipped++;
        continue;
      }
      const secretEnc = await encryptSecret(entry.password);
      db.insert(credential)
        .values({
          id: newId(),
          label: entry.label,
          envId: entry.envName ? (envNameToId.get(entry.envName) ?? null) : null,
          ownerId: SYSTEM_OWNER_ID,
          visibility: VISIBILITY,
          username: entry.username,
          secretEnc,
        })
        .run();
      counts.credentials.created++;
    }
  }

  // ------------------------------------------------------------------------------- summary
  const line = (label: string, c: Counts) => `  ${label}: ${c.created} created, ${c.skipped} skipped`;
  console.log("Flat-file import complete.");
  console.log(line("Environments", counts.environments));
  console.log(line("Roles", counts.roles));
  console.log(line("Env groups", counts.groups));
  console.log(line("Tests", counts.tests));
  console.log(line("Test versions", counts.testVersions));
  console.log(line("Runs", counts.runs));
  console.log(`  Run results: ${counts.runResults.created} created`);
  console.log(line("Credentials", counts.credentials));
  console.log(
    `${counts.environments.created + counts.environments.skipped} environments, ` +
      `${counts.roles.created + counts.roles.skipped} roles, ` +
      `${counts.groups.created + counts.groups.skipped} groups, ` +
      `${counts.tests.created + counts.tests.skipped} tests ` +
      `(+ ${counts.testVersions.created} new versions), ` +
      `${counts.runs.created + counts.runs.skipped} runs imported (or already present), ` +
      `${counts.credentials.created + counts.credentials.skipped} credentials imported (or already present).`,
  );
}

await main();
