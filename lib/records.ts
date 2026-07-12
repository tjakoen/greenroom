// lib/records.ts — run archive + result/record readers (runs/ + test-results/).
// Ported from interface/server.js lines 620-742.
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  cpSync,
} from "node:fs";
import { join, basename } from "node:path";
import { ROOT, IS_DEMO, DEMO_DIR } from "./paths.ts";

export const RUNS_DIR = IS_DEMO ? join(DEMO_DIR, "runs") : join(ROOT, "runs");
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
  let all = readdirSync(RUNS_DIR).sort(); // oldest first
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

export function archiveRun(env: string, result: string, startedAt?: number): void {
  try {
    const src = join(ROOT, "playwright-report");
    const idx = join(src, "index.html");
    if (!existsSync(idx)) return;
    // Don't archive a STALE report: if the report predates this run (e.g. the
    // run was stopped/crashed before Playwright wrote a fresh one), archiving it
    // would file the previous run's results under this run's label — wrong data
    // shown with full confidence on the History page.
    if (startedAt && statSync(idx).mtimeMs < startedAt - 2000) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dest = join(RUNS_DIR, `${stamp}-${env}-${result}`);
    cpSync(src, dest, { recursive: true });
    // Also keep the raw results (snapshots + pdf-record.json) so past runs can
    // still export PDFs.
    const tr = join(ROOT, "test-results");
    if (existsSync(tr)) cpSync(tr, join(dest, "results"), { recursive: true });
    pruneRuns();
  } catch (err: any) {
    console.error("Could not archive run:", err.message);
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
// Where the pdf-record.json + snapshot PNGs live for a given run.
export function resultsDir(run?: string): string {
  if (run && run !== "latest") return join(RUNS_DIR, basename(run), "results");
  return IS_DEMO ? join(DEMO_DIR, "test-results") : join(ROOT, "test-results");
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
