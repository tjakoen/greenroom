// pages/editor-api.ts — the in-browser test EDITOR's scoped API (plans/platform.md §5, P4).
// Full-source read/write with version history + validation, over the DB `test`/`testVersion`
// tables (db/schema.ts). Self-contained to the environmentsApi(ctx) contract; server.ts wires it
// into dispatch alongside the other P2/P4 handlers. Additive — the old surgical writers
// (tests-lib applyInputs/saveTags) are untouched.
//
// Three things the schema forces us to reconcile:
//  1. VERSIONS ARE PER-test() ROW, BUT THE EDITOR EDITS A WHOLE FILE. A spec with three test()s
//     is three `test` rows; the importer seeds each with a version holding the WHOLE-FILE source.
//     The editor can't fan a save across N rows coherently, so it picks ONE *canonical* test row
//     per file (oldest by createdAt, then id — deterministic) and anchors the file's version
//     chain there. Read + write always resolve the same canonical row, so history stays coherent.
//  2. OTHER WRITERS TOUCH THE DISK WITHOUT A DB VERSION (applyInputs/saveTags writeFileSync the
//     spec but never insert a testVersion). So the latest DB version can LAG the file on disk.
//     GET therefore returns the DISK source (what the runner actually runs + what reflects every
//     edit), not the latest version row. Version history (the drawer) is the DB snapshot trail.
//  3. A FILE MAY HAVE NO test ROW YET (created via record, or the DB was never imported). PUT
//     ensures a canonical row exists (creating a minimal one owned by the saver) before snapshotting.
//
// Validation is layered (§5): Monaco squiggles are client-side (P4-B); this module owns the two
// SERVER layers — a fast parse guard (Bun.Transpiler, gates every PUT) and a real Playwright
// compile via `playwright test --list` (POST /api/validate) that loads + collects the spec in a
// browser-less Playwright context without running a single step.
import { and, asc, desc, eq } from "drizzle-orm";
import { basename } from "node:path";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { db } from "../db/index.ts";
import { test, testVersion, type Visibility } from "../db/schema.ts";
import { canRead, type ScopedUser } from "../lib/scope.ts";
import { writeAudit } from "../lib/audit.ts";
import { parseTests } from "../lib/tests-lib.ts";
import { ROOT, TESTS_DIR, IS_DEMO, IS_LOCAL, denyInDemo, readFileMaybe, validTestFile } from "../lib/paths.ts";

export type ApiCtx = {
  req: Request;
  url: URL;
  p: string;
  method: string;
  qp: URLSearchParams;
  user: ScopedUser | null;
};

function json(data: unknown, status = 200): Response {
  return Response.json(data as any, { status });
}

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

type TestRow = typeof test.$inferSelect;

const abs = (rel: string) => join(ROOT, rel);

/** Child env for the `playwright test --list` validation spawn, with the platform master secrets
 *  stripped. `--list` COLLECTS a spec — which executes its module-level code — and this endpoint
 *  returns the child's stdout/stderr to the client, so a user-authored spec with a top-level
 *  `console.log(process.env.SECRET_KEY)` would otherwise leak the AES/session keys. Mirrors
 *  lib/runner.ts's strip; the collector needs neither secret. */
function validateChildEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ["SECRET_KEY", "BETTER_AUTH_SECRET"]) delete env[k];
  return env;
}

// ---- canonical test row (see file header §1) -----------------------------------------------
/** The one `test` row a file's version chain is anchored to: oldest by createdAt, then id.
 *  Read-only — returns null when the file has no `test` row yet. */
function resolveCanonicalTest(rel: string): TestRow | undefined {
  return db
    .select()
    .from(test)
    .where(eq(test.filePath, rel))
    .orderBy(asc(test.createdAt), asc(test.id))
    .get();
}

/** May `user` read the WHOLE file `rel`? A spec with N `test()` blocks is N `test` rows, each with
 *  its own visibility, but the editor reads/writes the whole file on disk as one unit. Scoping only
 *  the canonical (oldest) row would let a company-reader read/overwrite a file that also contains a
 *  private sibling test they can't see. So require read on EVERY row for the file. A file with no
 *  rows yet (unmanaged / record-created) is company-readable by default (empty ⇒ true). */
function canReadFile(user: ScopedUser, rel: string): boolean {
  const rows = db.select().from(test).where(eq(test.filePath, rel)).all();
  return rows.every((r) => canRead(user, r));
}

/** As resolveCanonicalTest, but creates a minimal row (owned by `user`) when none exists, so a
 *  spec created outside the importer (record flow, hand-added file) can still be versioned. Title
 *  comes from the file's first test() so the row is recognisable in listings. */
function ensureCanonicalTest(rel: string, user: ScopedUser): TestRow {
  const existing = resolveCanonicalTest(rel);
  if (existing) return existing;
  const title = parseTests(abs(rel))[0]?.title ?? basename(rel);
  const [row] = db
    .insert(test)
    .values({ title, filePath: rel, ownerId: user.id, visibility: "company" as Visibility })
    .returning()
    .all();
  return row;
}

// ---- parse guard (server validation layer 1 — gates every PUT) -----------------------------
export interface Diagnostic { line?: number; col?: number; message: string }

/** Fast, in-process syntax check via Bun's transpiler. Catches unparseable TS (the thing that
 *  would make the spec fail to even load) — NOT type errors, which are Monaco's + --list's job.
 *  Returns [] when the source parses. */
function parseGuard(source: string): Diagnostic[] {
  try {
    new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    return [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Best-effort location scrape — Bun's transpiler error text includes a "line:col" run.
    const loc = msg.match(/(\d+):(\d+)/);
    return [{ message: msg.split("\n")[0] || "Syntax error", line: loc ? Number(loc[1]) : undefined, col: loc ? Number(loc[2]) : undefined }];
  }
}

// ---- handlers ------------------------------------------------------------------------------
/** GET /api/test-source?file=tests/x.spec.ts → the file's source (disk, see header §2). */
function getSource(ctx: ApiCtx): Response {
  const user = ctx.user!;
  const rel = String(ctx.qp.get("file") ?? "");
  if (!validTestFile(rel)) return json({ error: "No such test file." }, 404);
  const canonical = resolveCanonicalTest(rel);
  // Enforce read scope across EVERY test row in the file (a private sibling walls the whole file);
  // an unmanaged file in the shared tests/ dir is readable (company-internal default, §4).
  if (!canReadFile(user, rel)) return json({ error: "forbidden" }, 403);
  const versionCount = canonical
    ? (db.select().from(testVersion).where(eq(testVersion.testId, canonical.id)).all().length)
    : 0;
  return json({ file: rel, source: readFileMaybe(abs(rel)), versionCount, testId: canonical?.id ?? null });
}

/** PUT /api/test-source { file, source, message? } → parse-guard, write disk + a new version, audit. */
async function putSource(ctx: ApiCtx): Promise<Response> {
  if (IS_DEMO) return json(denyInDemo, 403);
  const user = ctx.user!;
  const body = await readBody(ctx.req);
  const rel = String(body?.file ?? "");
  const source = typeof body?.source === "string" ? body.source : null;
  const message = body?.message != null ? String(body.message).slice(0, 500) : null;
  if (!validTestFile(rel)) return json({ ok: false, error: "No such test file." }, 404);
  if (source == null) return json({ ok: false, error: "source is required" }, 400);

  // Scope: EDITING a spec is gated on READ, not write. Tests are the collaborative artifact this
  // tool exists to edit — the scope.ts doctrine is "company-internal, everyone may read/write by
  // default; scope is for accountability, not a hard wall between teammates." So anyone who can see
  // a spec (company/team/owner) can edit it; a private spec they can't even read stays 403.
  // Accountability is preserved WITHOUT canWrite's owner/superadmin restriction: every save records
  // testVersion.authorId + an audit row below. (This is deliberately looser than canWrite, which
  // still guards the sensitive resources — credentials, environments, roles — in their own APIs.)
  // An unmanaged file (no test row yet) gets a canonical row owned by the saver, so it's self-
  // authorised.
  const existing = resolveCanonicalTest(rel);
  // Read-scope the WHOLE file: overwriting it rewrites every sibling test() too, so a private
  // sibling the saver can't read must wall the write (not just the canonical row's visibility).
  if (!canReadFile(user, rel)) return json({ ok: false, error: "forbidden" }, 403);

  // Layer 1 — reject unparseable TS BEFORE it can reach the disk or the runner (§5 guardrail).
  const diagnostics = parseGuard(source);
  if (diagnostics.length) return json({ ok: false, error: "Spec doesn't parse — fix the errors and try again.", diagnostics }, 400);

  const canonical = existing ?? ensureCanonicalTest(rel, user);
  writeFileSync(abs(rel), source);
  const [version] = db
    .insert(testVersion)
    .values({ testId: canonical.id, source, authorId: user.id, message })
    .returning()
    .all();
  await writeAudit({ actorId: user.id, action: "update", entity: "testVersion", entityId: version.id, after: { testId: canonical.id, file: rel, message } });
  const versionCount = db.select().from(testVersion).where(eq(testVersion.testId, canonical.id)).all().length;
  return json({ ok: true, versionId: version.id, versionCount, testId: canonical.id });
}

/** GET /api/test-versions?file= → the file's version snapshots, newest first (no source blobs). */
function listVersions(ctx: ApiCtx): Response {
  const user = ctx.user!;
  const rel = String(ctx.qp.get("file") ?? "");
  if (!validTestFile(rel)) return json({ error: "No such test file." }, 404);
  const canonical = resolveCanonicalTest(rel);
  if (!canonical) return json({ versions: [] });
  if (!canReadFile(user, rel)) return json({ error: "forbidden" }, 403);
  const rows = db
    .select({ id: testVersion.id, authorId: testVersion.authorId, message: testVersion.message, createdAt: testVersion.createdAt })
    .from(testVersion)
    .where(eq(testVersion.testId, canonical.id))
    .orderBy(desc(testVersion.createdAt))
    .all();
  return json({ versions: rows });
}

/** GET /api/test-version?id= → one version's full source (for restore/diff in the editor). */
function getVersion(ctx: ApiCtx): Response {
  const user = ctx.user!;
  const vid = String(ctx.qp.get("id") ?? "");
  if (!vid) return json({ error: "id is required" }, 400);
  const version = db.select().from(testVersion).where(eq(testVersion.id, vid)).get();
  if (!version) return json({ error: "not found" }, 404);
  // The version blob is the WHOLE-FILE source — scope on every test row for that file, not just the
  // canonical row this version chain is anchored to (a private sibling must wall the restore/diff).
  const owner = db.select().from(test).where(eq(test.id, version.testId)).get();
  if (owner && !canReadFile(user, owner.filePath)) return json({ error: "forbidden" }, 403);
  return json({ id: version.id, source: version.source, message: version.message, authorId: version.authorId, createdAt: version.createdAt });
}

/** POST /api/validate { file } → the strong check: `playwright test --list <file>` compiles +
 *  collects the spec in a real (browser-less) Playwright context WITHOUT running a step. Runs the
 *  parse guard first so a syntax error returns instantly instead of paying for a spawn. Validates
 *  the SAVED file (Save is parse-gated, so Save-then-Validate is coherent — the page can chain them). */
async function validate(ctx: ApiCtx): Promise<Response> {
  if (IS_DEMO) return json(denyInDemo, 403);
  const user = ctx.user!;
  const body = await readBody(ctx.req);
  const rel = String(body?.file ?? "");
  if (!validTestFile(rel)) return json({ ok: false, error: "No such test file." }, 404);
  if (!canReadFile(user, rel)) return json({ ok: false, error: "forbidden" }, 403);

  // Cheap layer first.
  const parseDiags = parseGuard(readFileMaybe(abs(rel)));
  if (parseDiags.length) return json({ ok: true, valid: false, diagnostics: parseDiags, output: parseDiags[0].message });

  // Real Playwright collection. --list loads playwright.config.ts + the spec, resolves imports and
  // fixtures, and enumerates tests — but launches no browser and runs nothing. Exit 0 = valid.
  const proc = Bun.spawn(["npx", "playwright", "test", "--list", rel], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: validateChildEnv(),
  });
  const timer = setTimeout(() => proc.kill(), 30_000); // don't hang a request on a wedged collect
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const output = (err + out).trim();
  const valid = code === 0;
  const diagnostics: Diagnostic[] = valid ? [] : scrapeDiagnostics(output, rel);
  return json({ ok: true, valid, output, diagnostics });
}

/** Best-effort: pull `<file>:<line>:<col>` locations Playwright/tsc print on a collection error. */
function scrapeDiagnostics(output: string, rel: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re = new RegExp(`${rel.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}:(\\d+):(\\d+)`, "g");
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(output))) {
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line: Number(m[1]), col: Number(m[2]), message: "See validation output" });
  }
  if (!out.length) out.push({ message: output.split("\n").slice(0, 3).join(" ").slice(0, 300) || "Validation failed" });
  return out;
}

// ---- LOCAL edition: disk-only editor (no db) ------------------------------------------------
// The version-history + audit trail are PLATFORM features (they live in the db `testVersion`
// table). The LOCAL edition edits the file on disk directly with the same parse-guard + Playwright
// --list validation, but no history: /api/test-versions is empty and /api/test-version 404s.
// Crucially this path NEVER touches `db`, so the (lazy) db handle is never opened in local mode.
async function editorLocal(ctx: ApiCtx): Promise<Response> {
  const rel = String((ctx.method === "GET" ? ctx.qp.get("file") : (await readBody(ctx.req))?.file) ?? "");
  if (ctx.p === "/api/test-source") {
    if (ctx.method === "GET") {
      if (!validTestFile(rel)) return json({ error: "No such test file." }, 404);
      return json({ file: rel, source: readFileMaybe(abs(rel)), versionCount: 0, testId: null });
    }
    if (ctx.method === "PUT") {
      if (IS_DEMO) return json(denyInDemo, 403);
      const body = await readBody(ctx.req);
      const r = String(body?.file ?? "");
      const source = typeof body?.source === "string" ? body.source : null;
      if (!validTestFile(r)) return json({ ok: false, error: "No such test file." }, 404);
      if (source == null) return json({ ok: false, error: "source is required" }, 400);
      const diagnostics = parseGuard(source);
      if (diagnostics.length) return json({ ok: false, error: "Spec doesn't parse — fix the errors and try again.", diagnostics }, 400);
      writeFileSync(abs(r), source);
      return json({ ok: true, versionCount: 0, testId: null });
    }
    return json({ error: "method not allowed" }, 405);
  }
  if (ctx.p === "/api/test-versions") return json({ versions: [] });
  if (ctx.p === "/api/test-version") return json({ error: "Version history is a platform feature." }, 404);
  // /api/validate — identical to the platform path minus the db-backed scope check.
  if (IS_DEMO) return json(denyInDemo, 403);
  if (!validTestFile(rel)) return json({ ok: false, error: "No such test file." }, 404);
  const parseDiags = parseGuard(readFileMaybe(abs(rel)));
  if (parseDiags.length) return json({ ok: true, valid: false, diagnostics: parseDiags, output: parseDiags[0].message });
  const proc = Bun.spawn(["npx", "playwright", "test", "--list", rel], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: validateChildEnv() });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const output = (err + out).trim();
  const valid = code === 0;
  return json({ ok: true, valid, output, diagnostics: valid ? [] : scrapeDiagnostics(output, rel) });
}

// ---- entry point ---------------------------------------------------------------------------
export async function editorApi(ctx: ApiCtx): Promise<Response | null> {
  if (
    ctx.p !== "/api/test-source" &&
    ctx.p !== "/api/test-versions" &&
    ctx.p !== "/api/test-version" &&
    ctx.p !== "/api/validate"
  ) {
    return null;
  }
  // LOCAL edition: no accounts, no db — handle the editor entirely on disk (see editorLocal).
  if (IS_LOCAL) return editorLocal(ctx);
  if (!ctx.user) return json({ error: "unauthenticated" }, 401);

  if (ctx.p === "/api/test-source") {
    if (ctx.method === "GET") return getSource(ctx);
    if (ctx.method === "PUT") return putSource(ctx);
    return json({ error: "method not allowed" }, 405);
  }
  if (ctx.p === "/api/test-versions") {
    if (ctx.method === "GET") return listVersions(ctx);
    return json({ error: "method not allowed" }, 405);
  }
  if (ctx.p === "/api/test-version") {
    if (ctx.method === "GET") return getVersion(ctx);
    return json({ error: "method not allowed" }, 405);
  }
  if (ctx.p === "/api/validate") {
    if (ctx.method === "POST") return validate(ctx);
    return json({ error: "method not allowed" }, 405);
  }
  return json({ error: "not found" }, 404);
}
