// lib/records.ts — run archive + result/record readers (runs/ + test-results/).
// Ported from interface/server.js lines 620-742.
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
} from "node:fs";
import { join, basename, relative } from "node:path";
import { ROOT, IS_DEMO, DEMO_DIR } from "./paths.ts";

export const RUNS_DIR = IS_DEMO ? join(DEMO_DIR, "runs") : join(ROOT, "runs");
// Gate A (plans/platform.md §6): each in-flight run writes straight to its own dir here instead
// of the shared playwright-report/test-results paths; archiveRun renames it into RUNS_DIR (the
// History naming convention) on close. Never read by History/PDF — only runner.ts writes here.
export const LIVE_RUNS_DIR = join(RUNS_DIR, ".live");
// Cap history two ways: newest N by count, AND a total-size ceiling (each run
// duplicates the report + all videos/traces, so a handful of full-capture
// multi-env runs is many GB — the target user will never clear it by hand).
export const RUNS_MAX = 30;
export const RUNS_MAX_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) total += dirSize(p);
      else {
        try {
          total += statSync(p).size;
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  } catch {
    /* dir gone */
  }
  return total;
}

// Delete oldest runs until we're under both the count and size caps.
export function pruneRuns(): void {
  // ".live" (in-flight run dirs, pre-rename) sorts first ASCII-wise and isn't a finished run —
  // never let it be evicted as though it were the oldest history entry.
  let all = readdirSync(RUNS_DIR)
    .filter((d) => d !== ".live")
    .sort(); // oldest first
  // Count cap: drop everything but the newest RUNS_MAX.
  while (all.length > RUNS_MAX) {
    rmSync(join(RUNS_DIR, all.shift() as string), { recursive: true, force: true });
  }
  // Size cap: keep dropping the oldest while over budget (always keep the newest).
  let total = all.reduce((n, d) => n + dirSize(join(RUNS_DIR, d)), 0);
  while (all.length > 1 && total > RUNS_MAX_BYTES) {
    const old = all.shift() as string;
    total -= dirSize(join(RUNS_DIR, old));
    rmSync(join(RUNS_DIR, old), { recursive: true, force: true });
  }
}

// Gate A: runDir is the per-run live dir (LIVE_RUNS_DIR/<runId>) the html reporter wrote straight
// to (index.html at its root); `${runDir}-results` is its SIBLING live dir (playwright.config.ts's
// RESULTS_DIR, holding results.json + per-test folders) — kept as a sibling rather than nested
// because the html reporter recursively clears its own outputFolder when it writes the report,
// which would silently destroy anything nested under it (confirmed by hand: nesting outputDir
// under RUN_DIR wiped every per-test pdf-record.json/snapshot/trace). No more copy: just rename
// both into the History naming convention now that Playwright is done touching either. The old
// stale-mtime guard is gone with it — there is no shared report left to go stale, each run only
// ever has its own dir.
// Gate B: runId -> archived dir name, so /api/results?run=<runId> (lib/tests-lib.ts readResults,
// via resultsDir below) keeps resolving once archiveRun renames the live dir away from its
// runId-named path into the History `<stamp>-<env>-<result>` convention. In-memory only — fine for
// now (durable run/result identity across restarts is Gate D's per-run-DB-row job, plans/
// platform.md §6/§7); worst case a runId from before a restart falls back to resultsDir's "no
// match" branch below (empty results, same as an unknown run today).
const runIdToDir = new Map<string, string>();

// Gate D (plans/platform.md §6): returns the archived dir's ROOT-relative path (the same shape
// scripts/import-flatfiles.ts writes into `run.artifactDir`) so lib/run-queue.ts can persist it on
// the run's DB row once the child has actually closed — undefined when nothing was archived
// (nothing to archive, or no report was produced).
export function archiveRun(runDir: string, env: string, result: string, runId?: string): string | undefined {
  const resultsLiveDir = `${runDir}-results`;
  try {
    if (!existsSync(runDir)) {
      // Nothing to archive (e.g. the child never got far enough to write anything) — still clean
      // up a stray results dir if one was created.
      rmSync(resultsLiveDir, { recursive: true, force: true });
      return undefined;
    }
    const idx = join(runDir, "index.html");
    if (!existsSync(idx)) {
      // No report was produced (stopped/crashed before Playwright finished) — nothing worth
      // keeping in History; clean up the empty/partial live dirs rather than filing them under a
      // result label with no report to show.
      rmSync(runDir, { recursive: true, force: true });
      rmSync(resultsLiveDir, { recursive: true, force: true });
      return undefined;
    }
    // Gate D (plans/platform.md §6): two runs can now legitimately finish in the SAME wall-clock
    // second (true concurrency, not the old single-run-at-a-time world this second-resolution
    // stamp was written for) — same env + same result would then collide on an EXISTING dest dir,
    // failing renameSync (ENOTEMPTY) and losing the run's whole archive. Bump the stamp forward a
    // second at a time until the name is free rather than clobbering/erroring on a collision; the
    // <19-char-stamp>-<env>-<result> FORMAT stays exactly what listRuns()/history parsing expects
    // (fixed-width stamp, `-` separators) — only which second it names can drift by a beat when
    // this happens, which is cosmetic (still within a second or two of when the run actually
    // finished) and only ever triggers on a genuine same-second collision.
    const stampFor = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    let stampMs = Date.now();
    let dest = join(RUNS_DIR, `${stampFor(stampMs)}-${env}-${result}`);
    while (existsSync(dest)) {
      stampMs += 1000;
      dest = join(RUNS_DIR, `${stampFor(stampMs)}-${env}-${result}`);
    }
    renameSync(runDir, dest);
    if (existsSync(resultsLiveDir)) renameSync(resultsLiveDir, join(dest, "results"));
    if (runId) runIdToDir.set(runId, basename(dest));
    pruneRuns();
    return relative(ROOT, dest);
  } catch (err: any) {
    console.error("Could not archive run:", err.message);
    return undefined;
  }
}

export function listRuns(): { id: string; when: string; env: string; result: string }[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((d) => existsSync(join(RUNS_DIR, d, "index.html")))
    .sort()
    .reverse()
    .map((d) => {
      // <timestamp>-<env>-<result> ; timestamp is 19 chars (2026-07-04T10-30-00)
      const rest = d.slice(20);
      const result = rest.split("-").pop() as string;
      const env = rest.slice(0, rest.length - result.length - 1);
      // Stamp is "2026-07-08T02-00-37" (colons became dashes for the folder name);
      // render the time part back with colons so it reads as a clock time.
      const [date, time] = d.slice(0, 19).split("T");
      const when = `${date} ${(time || "").replace(/-/g, ":")}`;
      return { id: d, when, env, result };
    });
}

// ---------------------------------------------------------- snapshots -> PDF
// Where the pdf-record.json + snapshot PNGs live for a given run. Gate A: there's no more shared
// ROOT/test-results — "latest" now means the newest FINISHED run's own results/ dir.
export function resultsDir(run?: string): string {
  if (run && run !== "latest") {
    // Gate B: `run` may be a runId (lib/run-stream.ts) rather than the archived `<stamp>-<env>-
    // <result>` dir name — resolve it through the map archiveRun populated, falling back to
    // treating it as a literal dir name (today's behaviour, e.g. History's own run ids).
    const dirName = runIdToDir.get(run) || run;
    return join(RUNS_DIR, basename(dirName), "results");
  }
  const runs = listRuns();
  return runs.length ? join(RUNS_DIR, runs[0].id, "results") : join(RUNS_DIR, ".none", "results");
}

// Read every test's pdf-record.json for a run, resolving snapshot files to the
// record's own folder (so it works for both the latest run and archived ones).
export function collectRecords(run?: string): { test: string; record: any }[] {
  const base = resultsDir(run);
  if (!existsSync(base)) return [];
  const out: { test: string; record: any }[] = [];
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    const rp = join(dir, "pdf-record.json");
    if (!existsSync(rp)) continue;
    let rec: any;
    try {
      rec = JSON.parse(readFileSync(rp, "utf8"));
    } catch {
      continue;
    }
    rec.snapshots = (rec.snapshots || []).map((s: any) => ({ ...s, file: join(dir, basename(s.file)) }));
    const video = join(dir, "video.webm");
    rec.videoFile = existsSync(video) ? video : null;
    rec.dir = dir;
    const trace = join(dir, "trace.zip");
    rec.traceFile = existsSync(trace) ? trace : null;
    out.push({ test: name, record: rec });
  }
  return out;
}

export function findRecord(run: string | undefined, test: string | null): { test: string; record: any } | undefined {
  return collectRecords(run).find((r) => r.test === basename(test || ""));
}
