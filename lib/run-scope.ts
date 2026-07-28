// lib/run-scope.ts — PLATFORM-only read-scope for a run's saved artifacts (audit blocker #2).
//
// The raw artifact endpoints (/api/{pdf-data,pdf-image,moment,video,video-clip,bug-summary,
// bug-bundle,results,pdf} + the /report and /runs/ static serves) resolve a run purely by id and
// return its screenshots/video/console/network/PDF/zip. Left unscoped, a `private` test's captured
// output (which can include the app-under-test's credential entry) leaks to any authenticated user.
//
// Doctrine (lib/scope.ts / plans §4): the company is internal and everyone reads `company`/`team`
// by default — the ONLY hard wall is `private`. So this check is deliberately narrow: it walls off
// a run ONLY when that run covered a `private` test the requester can't read. Superadmin and the
// user who triggered the run always pass. Anything we can't resolve to a DB row (legacy/imported
// runs, a "latest"/blank selector) falls back to ALLOW, so the guard only ever tightens the
// genuinely-private case and never breaks the normal (company-visibility) bug-report/history flow.
import { eq, or, desc, isNotNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { run, runResult, test } from "../db/schema.ts";
import { canRead, type ScopedUser } from "./scope.ts";

/** Resolves the `run` row a `?run=` param addresses. `key` may be the DB run id, the archived
 *  artifactDir name (bare `<stamp>-<env>-<result>` as History sends it, OR the ROOT-relative
 *  `runs/<stamp>…` form the DB stores — see lib/records.ts archiveRun), or blank/"latest" which
 *  the artifact handlers resolve to the newest finished run (lib/records.ts). We mirror that
 *  "latest" resolution here (newest archived row) so the wall keys on the SAME run the handler
 *  will actually serve — otherwise `?run=latest` silently bypasses it (was an audit finding). */
function resolveRunRow(key: string): { id: string; triggeredBy: string } | undefined {
  if (!key || key === "latest") {
    return db
      .select({ id: run.id, triggeredBy: run.triggeredBy })
      .from(run)
      .where(isNotNull(run.artifactDir))
      .orderBy(desc(run.finishedAt))
      .get();
  }
  return db
    .select({ id: run.id, triggeredBy: run.triggeredBy })
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
