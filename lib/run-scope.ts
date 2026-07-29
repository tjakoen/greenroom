// lib/run-scope.ts — PLATFORM-only read-scope for a run's saved artifacts (audit blocker #2).
//
// The raw artifact endpoints (/api/{pdf-data,pdf-image,moment,video,video-clip,bug-summary,
// bug-bundle,results,pdf} + the /report and /runs/ static serves) resolve a run purely by id and
// return its screenshots/video/console/network/PDF/zip. Left unscoped, a `private` test's captured
// output (which can include the app-under-test's credential entry) leaks to any authenticated user.
//
// Doctrine (lib/scope.ts / plans §4): the company is internal and everyone reads `company`/`team`
// by default — the ONLY hard wall is `private`. So this check is deliberately narrow: it walls off
// a run when the requester can't read something that run exposed — a `private` TEST it covered (by
// run_result linkage AND, belt-and-suspenders, by the run's scoped spec files), OR a non-company
// CREDENTIAL its child was handed (a private login can surface in the captured screenshots/network
// of an otherwise company-visible run). Superadmin and the user who triggered the run always pass.
// An unresolvable run (legacy/imported, empty history) falls back to ALLOW, so the guard only ever
// tightens the genuinely-private case and never breaks the normal company-visibility history flow.
import { eq, or, desc, isNotNull, inArray } from "drizzle-orm";
import { basename } from "node:path";
import { db } from "../db/index.ts";
import { run, runResult, test, credential } from "../db/schema.ts";
import { canRead, type ScopedUser } from "./scope.ts";

type RunRow = { id: string; triggeredBy: string; scope: unknown };

/** Resolves the `run` row a `?run=` param addresses. `key` may be the DB run id, the archived
 *  artifactDir name (bare `<stamp>-<env>-<result>` as History sends it, OR the ROOT-relative
 *  `runs/<stamp>…` form the DB stores — see lib/records.ts archiveRun), or blank/"latest" which
 *  the artifact handlers resolve to the newest finished run (lib/records.ts). We mirror that
 *  "latest" resolution here (newest archived row) so the wall keys on the SAME run the handler
 *  will actually serve — otherwise `?run=latest` silently bypasses it (was an audit finding). */
function resolveRunRow(key: string): RunRow | undefined {
  const cols = { id: run.id, triggeredBy: run.triggeredBy, scope: run.scope };
  if (!key || key === "latest") {
    return db.select(cols).from(run).where(isNotNull(run.artifactDir)).orderBy(desc(run.finishedAt)).get();
  }
  return db
    .select(cols)
    .from(run)
    .where(or(eq(run.id, key), eq(run.artifactDir, key), eq(run.artifactDir, `runs/${key}`)))
    .get();
}

/** May `user` read the artifacts of the run addressed by `runParam`? `runParam` is whatever the
 *  endpoint received — the DB run id (live/queued runs) OR the archived artifactDir name (History
 *  addresses runs by their `<stamp>-<env>-<result>` dir). Both resolve to the same `run` row. */
export function canReadRun(user: ScopedUser, runParam: string | null | undefined): boolean {
  if (user.isSuperadmin) return true;
  const key = String(runParam ?? "").trim();

  // Resolve blank/"latest" to the concrete newest run the handler will serve, then wall THAT — a
  // caller-relative selector is not a free pass (the newest run can cover a private test).
  const row = resolveRunRow(key);
  if (!row) return true; // no such run / empty history → company-open default (never breaks the normal flow)
  if (row.triggeredBy === user.id) return true;

  // Wall the run iff it covered a test this user cannot read (i.e. a private test they don't own).
  const rows = db
    .select({ visibility: test.visibility, ownerId: test.ownerId, teamId: test.teamId })
    .from(runResult)
    .innerJoin(test, eq(test.id, runResult.testId))
    .where(eq(runResult.runId, row.id))
    .all();
  for (const t of rows) {
    if (!canRead(user, t)) return false;
  }

  const scope = (row.scope ?? {}) as { files?: unknown; credentialIds?: unknown };

  // Belt-and-suspenders for the test-visibility wall above: run_result rows link to `test` rows by
  // basename(file)::title and are silently skipped when that join misses (a renamed spec / title
  // drift), which would fail OPEN. So ALSO wall by the run's SCOPED spec files — any private test
  // whose file this run explicitly targeted, matched by basename, regardless of result linkage.
  // (An unscoped "run all" leaves scope.files empty; that residual is covered by the join above.)
  const files = Array.isArray(scope.files) ? scope.files.filter((f): f is string => typeof f === "string") : [];
  if (files.length) {
    const bases = new Set(files.map((f) => basename(f)));
    const testRows = db.select({ filePath: test.filePath, visibility: test.visibility, ownerId: test.ownerId, teamId: test.teamId }).from(test).all();
    for (const t of testRows) {
      if (bases.has(basename(t.filePath)) && !canRead(user, t)) return false;
    }
  }

  // Wall the run iff its child was handed a NON-company credential this user can't read — a
  // private/team login can surface in an otherwise company-visible run's screenshots/network
  // (buildRunConfig records the ids on scope.credentialIds).
  const credIds = Array.isArray(scope.credentialIds) ? scope.credentialIds.filter((c): c is string => typeof c === "string") : [];
  if (credIds.length) {
    const credRows = db
      .select({ visibility: credential.visibility, ownerId: credential.ownerId, teamId: credential.teamId })
      .from(credential)
      .where(inArray(credential.id, credIds))
      .all();
    for (const c of credRows) {
      if (!canRead(user, c)) return false;
    }
  }
  return true;
}

/** May `user` CONTROL (stop/cancel) the run addressed by `runParam`? Stronger than canReadRun:
 *  stopping another user's run is cross-user tampering/DoS, so only the run's triggerer or a
 *  superadmin may. Fails CLOSED — an unknown/blank/legacy run is NOT controllable by a non-admin
 *  (a mutation must resolve to a row you own; there is no company-open default for control). */
export function canControlRun(user: ScopedUser, runParam: string | null | undefined): boolean {
  if (user.isSuperadmin) return true;
  const key = String(runParam ?? "").trim();
  if (!key || key === "latest") return false; // no concrete owned target → refuse
  const row = resolveRunRow(key);
  return !!row && row.triggeredBy === user.id;
}
