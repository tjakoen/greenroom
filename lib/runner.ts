// lib/runner.ts — the Playwright run lifecycle (spawns a detached node child).
// Ported from interface/server.js startRun/killProc/stopRun (lines 233-334).
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { state, pushOutput, broadcast, publicState } from "./run-stream.ts";
import { validTestFile, ROOT, IS_DEMO, denyInDemo } from "./paths.ts";
import { envNames } from "./envs.ts";
import { archiveRun } from "./records.ts";

export interface RunResult {
  ok: boolean;
  error?: string;
  demo?: boolean;
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
): RunResult {
  if (IS_DEMO) return denyInDemo;
  if (state.proc) return { ok: false, error: "A run is already in progress." };
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
  state.status = "running";
  state.env = envLabel;
  state.envs = unique;
  state.light = !!light;
  state.lines = [];
  const startedAt = Date.now();

  // detached: give the child its own process group so Stop can kill the whole
  // tree (Playwright spawns worker processes) — see killProc/stopRun.
  const proc = spawn("npx", ["playwright", "test", ...targets, ...grepArgs], {
    cwd: ROOT,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      TEST_ENVS: unique.join(","),
      TEST_ENV: unique[0],
      // "Run as" override: force every login('…') to use this role (see the login
      // fixture). Empty/unset → each test keeps its own role.
      ...(role && typeof role === "string" && role.trim() ? { GR_ROLE: role.trim() } : {}),
      ...(light ? { CAPTURE: "light" } : {}),
    },
  });
  state.proc = proc;

  let settled = false;
  proc.stdout?.on("data", pushOutput);
  proc.stderr?.on("data", pushOutput);
  // spawn itself failing (e.g. `npx` not on PATH — common when VS Code is
  // launched from the Dock with a GUI-only PATH) fires 'error', not 'close'.
  // Tell the user instead of crashing the server on an unhandled event.
  proc.on("error", (err) => {
    if (settled) return;
    settled = true;
    state.proc = null;
    state.status = "failed";
    pushOutput(
      `\nCouldn't start the test runner: ${err.message}\nIs Node/npx on your PATH? Try launching the app from a terminal, or reinstall dependencies (npm install).`,
    );
    broadcast("done", publicState());
  });
  proc.on("close", (code) => {
    if (settled) return;
    settled = true;
    state.proc = null;
    if (state.status === "running") state.status = code === 0 ? "passed" : "failed";
    archiveRun(envLabel, state.status, startedAt);
    broadcast("done", publicState());
  });

  broadcast("started", publicState());
  return { ok: true };
}

// SIGTERM the whole process group (negative pid), then SIGKILL after a grace
// period so orphaned Playwright workers can't keep writing to test-results/.
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

export function stopRun(): RunResult {
  if (!state.proc && !state.recording) return { ok: false, error: "Nothing is running." };
  state.status = "stopped";
  if (state.proc) killProc(state.proc); // during pre-auth there's no proc yet; the record flow sees 'stopped' and cancels
  return { ok: true };
}
