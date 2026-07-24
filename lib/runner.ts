// lib/runner.ts — the Playwright run lifecycle (spawns a detached node child).
// Ported from interface/server.js startRun/killProc/stopRun (lines 233-334).
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createRun, getRun, getActiveRun, pushOutput, broadcast, broadcastGlobal, publicState, recordingState,
} from "./run-stream.ts";
import type { RunStatus } from "./run-stream.ts";
import { validTestFile, ROOT, IS_DEMO, denyInDemo } from "./paths.ts";
import { envNames } from "./envs.ts";
import { archiveRun, LIVE_RUNS_DIR } from "./records.ts";
import type { RunConfigBundle } from "./run-config.ts";

export interface RunResult {
  ok: boolean;
  error?: string;
  demo?: boolean;
  runId?: string;
}

// P5 Gate D (plans/platform.md §6): the queue (lib/run-queue.ts) is the only remaining caller of
// startRun, and it already claimed the DB row + admitted it under the concurrency cap before
// calling in — so `runId` is the caller's DB row id (making the RunHandle id, the archive dir name,
// and the `run` row id all the same value) and `onDone` is how the queue learns the final
// status/archived dir once the child closes, without startRun needing to know anything about the
// DB. Both optional so a hand-run/legacy caller (none left today, kept for the demo/no-runId shape)
// behaves exactly as before: a self-generated id, no DB write-back.
export interface StartRunOptions {
  runId?: string;
  runConfig?: RunConfigBundle;
  onDone?: (info: { status: RunStatus; artifactDir?: string }) => void;
}

// envs may be a single env name (today's behaviour, one project) or an array of
// names (a simultaneous multi-environment run — one Playwright project per env,
// each with its own baseURL + per-env account). We pass TEST_ENVS to the runner
// (read by playwright.config's getSelectedEnvs) and also TEST_ENV=<first> so any
// code that reads the process-wide env still resolves to a sensible default.
export function startRun(
  envs: string | string[],
  light: boolean,
  files?: string[],
  grep?: string,
  role?: string,
  opts?: StartRunOptions,
): RunResult {
  if (IS_DEMO) return denyInDemo;
  const runConfig = opts?.runConfig;
  // Gate D: run-vs-run concurrency is no longer decided here — lib/run-queue.ts's scheduler is the
  // only caller left, and it only ever calls in once a slot under GR_MAX_PARALLEL_RUNS is free.
  // Recording stays exclusive against ANY run, though: it's a real local browser on the user's own
  // screen (lib/recorder.ts), not something the queue's concurrency cap makes sense for.
  if (recordingState.recording || recordingState.proc) {
    return { ok: false, error: "A recording is in progress." };
  }
  const list = (Array.isArray(envs) ? envs : [envs]).map((e) => String(e || "").trim()).filter(Boolean);
  const unique = [...new Set(list)];
  if (!unique.length) return { ok: false, error: "Pick at least one environment." };
  const known = envNames();
  const bad = unique.filter((e) => !known.includes(e));
  if (bad.length) return { ok: false, error: `Unknown environment${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}.` };

  let targets: string[];
  if (Array.isArray(files) && files.length) {
    targets = files.filter(validTestFile);
    if (!targets.length) return { ok: false, error: "None of the selected test files exist." };
  } else {
    targets = ["tests"];
  }
  const grepArgs = typeof grep === "string" && grep.trim() ? ["--grep", grep.trim()] : [];

  const envLabel = unique.join("+"); // folder/display label for the run

  // Gate A (plans/platform.md §6): give this run its own live output dir instead of writing
  // straight to the shared playwright-report/test-results paths — de-clobbers the filesystem so a
  // future concurrent run (the queue, Gate D) can't stomp this one's artifacts. GR_RUN_DIR is read
  // by playwright.config.ts to point the html/json reporters + outputDir at it; on close we rename
  // the whole dir into the runs/<stamp>-<env>-<result> History convention (archiveRun below) —
  // atomic, same filesystem, no copy.
  // Gate D: prefer the caller's runId (lib/run-queue.ts passes its `run` row id) so that id, the
  // RunHandle id, and the eventual archive dir all resolve to the same identifier; self-generate
  // only for a caller that didn't supply one (kept so this function still works standalone).
  const runId = opts?.runId || crypto.randomUUID();
  const runDir = join(LIVE_RUNS_DIR, runId);
  // Sibling, not a child of runDir — playwright.config.ts derives the SAME `${runDir}-results`
  // path from GR_RUN_DIR for its outputDir (see that file's RESULTS_DIR comment for why: nesting
  // it under the html reporter's own output folder gets it recursively wiped when the report is
  // generated). Keep this suffix in sync with playwright.config.ts if either ever changes.
  const resultsLiveDir = `${runDir}-results`;
  try {
    mkdirSync(runDir, { recursive: true });
    mkdirSync(resultsLiveDir, { recursive: true });
  } catch (err: any) {
    return { ok: false, error: `Could not create the run's output directory: ${err.message}` };
  }

  // Gate B: this run's own keyed handle (lib/run-stream.ts) — no more shared singleton.
  // Gate D: lib/run-queue.ts's enqueueRun already created this handle (status "queued") so a
  // client could subscribe to /api/stream?run=<runId> before the run ever started — REUSE it
  // (mutate in place) rather than replacing it, so any SSE connection opened while queued keeps
  // flowing through the exact same object's `.clients` instead of being silently dropped. A caller
  // with no queue in front of it (none left today) still gets a fresh "running" handle as before.
  const existingHandle = getRun(runId);
  const handle = existingHandle ?? createRun(runId, { env: envLabel, envs: unique, light: !!light });
  if (existingHandle) {
    existingHandle.status = "running";
    existingHandle.env = envLabel;
    existingHandle.envs = unique;
    existingHandle.light = !!light;
    // Tell anyone already subscribed (from the queued state) that this run just started.
    broadcast(runId, "state", publicState(runId));
  }

  // detached: give the child its own process group so Stop can kill the whole
  // tree (Playwright spawns worker processes) — see killProc/stopRun.
  const proc = spawn("npx", ["playwright", "test", ...targets, ...grepArgs], {
    cwd: ROOT,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      GR_RUN_DIR: runDir,
      TEST_ENVS: unique.join(","),
      TEST_ENV: unique[0],
      // "Run as" override: force every login('…') to use this role (see the login
      // fixture). Empty/unset → each test keeps its own role.
      ...(role && typeof role === "string" && role.trim() ? { GR_ROLE: role.trim() } : {}),
      ...(light ? { CAPTURE: "light" } : {}),
      // P5 Gate C (plans/platform.md §6): the DB→child config/credential handoff. GREENROOM_URLS_FILE
      // points config/environments.ts at this run's scoped, secret-free urls.json-shaped snapshot;
      // credEnv spreads in DECRYPTED `<ENV>_<ROLE>_USERNAME/PASSWORD` pairs (users/roles.ts's exact
      // var-naming contract) so the child's getUser() resolves them without ever touching .env or
      // disk. Both are only ever set by lib/run-config.ts's buildRunConfig — absent runConfig (demo,
      // or any caller with no DB session) leaves this spawn byte-identical to before Gate C.
      ...(runConfig?.urlsFile ? { GREENROOM_URLS_FILE: runConfig.urlsFile } : {}),
      ...(runConfig?.credEnv ?? {}),
    },
  });
  handle.proc = proc;

  let settled = false;
  proc.stdout?.on("data", (chunk) => pushOutput(runId, chunk));
  proc.stderr?.on("data", (chunk) => pushOutput(runId, chunk));
  // spawn itself failing (e.g. `npx` not on PATH — common when VS Code is
  // launched from the Dock with a GUI-only PATH) fires 'error', not 'close'.
  // Tell the user instead of crashing the server on an unhandled event.
  proc.on("error", (err) => {
    if (settled) return;
    settled = true;
    handle.proc = null;
    handle.status = "failed";
    pushOutput(
      runId,
      `\nCouldn't start the test runner: ${err.message}\nIs Node/npx on your PATH? Try launching the app from a terminal, or reinstall dependencies (npm install).`,
    );
    // The child never ran (or never got far enough to write a report) — nothing to archive, and
    // the close handler won't run again (settled), so clean up the empty/partial live dirs here.
    try {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(resultsLiveDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    runConfig?.cleanup(); // the child never ran — delete the (unused) per-run snapshot now
    opts?.onDone?.({ status: handle.status }); // Gate D: nothing archived — no artifactDir
    broadcast(runId, "done", publicState(runId));
    broadcastGlobal("done", publicState());
  });
  proc.on("close", (code) => {
    if (settled) return;
    settled = true;
    handle.proc = null;
    if (handle.status === "running") handle.status = code === 0 ? "passed" : "failed";
    const artifactDir = archiveRun(runDir, envLabel, handle.status, runId);
    // The child has fully exited (and archiveRun finished reading its output) — safe to delete the
    // per-run urls.json snapshot now (P5 Gate C; never before this point, the child may still need it).
    runConfig?.cleanup();
    // Gate D: tell the queue the final status + where (if anywhere) it landed, BEFORE broadcasting
    // "done" — run-queue.ts's onDone writes the DB row and calls readResults(runId) (lib/tests-lib.ts,
    // via lib/records.ts's runIdToDir map that archiveRun just populated), then ticks the scheduler
    // to fill the freed slot. A caller with no onDone (none left today) sees no behaviour change.
    opts?.onDone?.({ status: handle.status, artifactDir });
    broadcast(runId, "done", publicState(runId));
    broadcastGlobal("done", publicState());
  });

  broadcastGlobal("started", publicState());
  return { ok: true, runId };
}

// SIGTERM the whole process group (negative pid), then SIGKILL after a grace
// period so orphaned Playwright workers can't keep writing into the run's live dir.
export function killProc(proc: ChildProcess | null): void {
  if (!proc || !proc.pid) return;
  const hard = () => {
    try {
      if (process.platform !== "win32") process.kill(-proc.pid!, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  try {
    if (process.platform !== "win32") process.kill(-proc.pid, "SIGTERM");
    else proc.kill("SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(hard, 5000).unref();
}

// Gate B: runId present → stop that specific run (the keyed API). No runId → compat behaviour for
// the frozen SPA: stop "the current thing" (the active run, or an in-flight recording) same as the
// old singleton did — recorder.ts's own guard also reads recordingState.
export function stopRun(runId?: string): RunResult {
  if (runId) {
    const h = getRun(runId);
    if (!h) return { ok: false, error: "Unknown run." };
    if (h.status !== "running") return { ok: false, error: "That run isn't active." };
    h.status = "stopped";
    if (h.proc) killProc(h.proc);
    return { ok: true };
  }
  const active = getActiveRun();
  if (active) {
    active.status = "stopped";
    if (active.proc) killProc(active.proc);
    return { ok: true };
  }
  if (!recordingState.recording && !recordingState.proc) return { ok: false, error: "Nothing is running." };
  recordingState.status = "stopped";
  if (recordingState.proc) killProc(recordingState.proc); // during pre-auth there's no proc yet; the record flow sees 'stopped' and cancels
  return { ok: true };
}
