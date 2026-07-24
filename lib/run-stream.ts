// lib/run-stream.ts — per-runId run state + its Server-Sent-Events hub.
//
// PLAN §1 says the run output "moves to batch createStream with the same event names
// (state/line/started/done) and replay-on-connect". The pinned batch Stream (f9ecb03) is a
// per-session broadcast hub with NO replay-on-subscribe seam, and P1 must serve the FROZEN
// interface/app.js whose EventSource opens /api/stream and expects the current `state` event +
// the buffered `line` history replayed on THAT same connection before live events flow. So the
// run stream is a greenroom-owned Bun ReadableStream hub here: identical event names + the
// replay §5.1 ("SSE replay") requires. Swap to batch createStream if/when it grows a
// replay-on-subscribe hook. The AI door (Phase G) gets its OWN separate stream — never this one.
//
// Gate B (plans/platform.md §6): today's SINGLE global `state` singleton (one lines[] buffer, one
// SSE clients set) can't tell two concurrent runs apart. This re-keys run state + SSE by `runId` —
// a `Map<string, RunHandle>` — so a later gate (the queue, Gate D) can go concurrent. Still
// single-run in practice (the lock lives in runner.ts's startRun); this gate is the keyed API +
// the compat shims that keep (a) today's single-run UX, (b) the frozen interface/app.js SPA, and
// (c) lib/recorder.ts all working unchanged from the outside.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { ROOT, IS_DEMO } from "./paths.ts";
import { envNames, getLastConfigError } from "./envs.ts";
import { listRuns } from "./records.ts";

// P5 Gate D (plans/platform.md §6) adds "queued" (a handle can now exist before its process ever
// spawns — lib/run-queue.ts's enqueueRun creates it immediately so /api/stream?run=<runId> is
// subscribable from the moment a run is enqueued, not just once it starts) and "error" (a queued
// run that fails to actually start — e.g. an environment vanished while it waited — never reaches
// "running" at all, so it needs a terminal status of its own distinct from "failed", which implies
// the tests themselves ran).
export type RunStatus = "queued" | "running" | "passed" | "failed" | "stopped" | "error";

export interface RunHandle {
  runId: string;
  status: RunStatus;
  env: string | null; // display label: single env name, or "a+b" for a multi-env run
  envs: string[]; // the env list this run targeted
  light: boolean;
  lines: string[];
  proc: ChildProcess | null;
  clients: Set<ReadableStreamDefaultController<Uint8Array>>;
  startedAt: number;
}

export const MAX_LINES = 2000;
// Cap how many finished RunHandles we keep around in memory (a long-lived session running many
// tests one after another shouldn't leak forever) — generous enough that a Run page/reconnect can
// still reach recent runs' /api/results?run=<id>. Never evicts the currently-running handle.
const MAX_HANDLES = 25;

const runs = new Map<string, RunHandle>();

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const encoder = new TextEncoder();
const frame = (event: string, data: unknown): Uint8Array =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function evictIfNeeded(): void {
  if (runs.size <= MAX_HANDLES) return;
  // Gate D: a "queued" handle hasn't run yet — never evict it as though it were finished history.
  const finished = [...runs.values()]
    .filter((h) => h.status !== "running" && h.status !== "queued")
    .sort((a, b) => a.startedAt - b.startedAt);
  while (runs.size > MAX_HANDLES && finished.length) {
    const oldest = finished.shift() as RunHandle;
    runs.delete(oldest.runId);
  }
}

/** Register a new run's handle. Called by lib/run-queue.ts's enqueueRun at enqueue time (Gate D:
 *  `status: "queued"`, so /api/stream?run=<runId> is subscribable immediately — see
 *  runner.ts's startRun, which looks up and REUSES this same handle, preserving its `.clients`,
 *  once the queue actually starts it) or by runner.ts's startRun itself when no handle exists yet
 *  (a standalone/legacy caller with no queue in front of it). `meta.status` defaults to "running"
 *  for that legacy shape. */
export function createRun(
  runId: string,
  meta: { env: string | null; envs: string[]; light: boolean; status?: RunStatus },
): RunHandle {
  const handle: RunHandle = {
    runId,
    status: meta.status ?? "running",
    env: meta.env,
    envs: meta.envs,
    light: meta.light,
    lines: [],
    proc: null,
    clients: new Set(),
    startedAt: Date.now(),
  };
  runs.set(runId, handle);
  evictIfNeeded();
  return handle;
}

export function getRun(runId: string): RunHandle | undefined {
  return runs.get(runId);
}

/** Every known run handle (running or finished) — used by server.ts's shutdown handler to make
 *  sure no detached Playwright process group is left behind when the app exits. */
export function allRunHandles(): RunHandle[] {
  return [...runs.values()];
}

/** The run currently in flight, if any — the single-run lock (Gate D lifts this). */
export function getActiveRun(): RunHandle | undefined {
  for (const h of runs.values()) if (h.status === "running") return h;
  return undefined;
}

/** Newest handle by start time, running or not — the compat shims' "current run" fallback. */
function newestRun(): RunHandle | undefined {
  let best: RunHandle | undefined;
  for (const h of runs.values()) if (!best || h.startedAt >= best.startedAt) best = h;
  return best;
}

/** Which run a no-runId (compat) caller should look at: the active one, else the most recent. */
function compatRun(): RunHandle | undefined {
  return getActiveRun() || newestRun();
}

// ---------------------------------------------------------------------- recording (exclusive)
// Recording (lib/recorder.ts) is a local, exclusive action — not a queued run — so it gets its own
// small state slice rather than a slot in the run map. Shape mirrors the old singleton's fields
// recorder.ts already reads/writes so its own diff stays mechanical.
export interface RecordingState {
  recording: boolean; // true during the async pre-auth window, before proc is set
  proc: ChildProcess | null;
  status: "idle" | RunStatus;
  env: string | null;
  envs: string[];
  lines: string[];
}
export const recordingState: RecordingState = {
  recording: false,
  proc: null,
  status: "idle",
  env: null,
  envs: [],
  lines: [],
};

// ---------------------------------------------------------------------- SSE plumbing
// The global/compat channel: cross-run lifecycle events (queued/started/done — Gate D adds
// queued/position) plus a mirror of whichever run/recording is "current", so a connection that
// doesn't know a runId (the frozen SPA, or a Run page before it has one) still sees live output
// and lifecycle events exactly like the old singleton did.
const globalClients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function sendTo(clients: Set<ReadableStreamDefaultController<Uint8Array>>, event: string, data: unknown): void {
  const chunk = frame(event, data);
  for (const c of clients) {
    try {
      c.enqueue(chunk);
    } catch {
      clients.delete(c); // closed tab → drop quietly
    }
  }
}

/** Push a named event to one run's own subscribers (its /api/stream?run=<id> connections). */
export function broadcast(runId: string, event: string, data: unknown): void {
  const h = runs.get(runId);
  if (h) sendTo(h.clients, event, data);
}

/** Push a named event to the global/compat channel only (no specific run). */
export function broadcastGlobal(event: string, data: unknown): void {
  sendTo(globalClients, event, data);
}

/** Append runner stdout/stderr to a run's own line buffer (capped), broadcast to that run's
 *  subscribers, AND mirror the line onto the global/compat channel — so a connection that isn't
 *  runId-aware (the frozen SPA, or a Run page's very first load) still sees live output exactly
 *  like today's singleton. Mirrors server.js pushOutput(); accepts a Buffer or string. */
export function pushOutput(runId: string, chunk: unknown): void {
  const h = runs.get(runId);
  if (!h) return;
  for (const line of stripAnsi(String(chunk)).split("\n")) {
    if (line.trim() === "") continue;
    h.lines.push(line);
    if (h.lines.length > MAX_LINES) h.lines.shift();
    sendTo(h.clients, "line", { line });
    sendTo(globalClients, "line", { line });
  }
}

/** Recording's own output — recording isn't in the run map, so it pushes straight to its own
 *  buffer and the global channel (recording only ever had a global audience, even pre-Gate-B). */
export function pushRecordingOutput(chunk: unknown): void {
  for (const line of stripAnsi(String(chunk)).split("\n")) {
    if (line.trim() === "") continue;
    recordingState.lines.push(line);
    if (recordingState.lines.length > MAX_LINES) recordingState.lines.shift();
    sendTo(globalClients, "line", { line });
  }
}

function shapeOf(status: string, env: string | null, envs: string[], light: boolean) {
  return {
    status,
    env,
    runEnvs: envs, // which envs this run targeted
    light,
    envs: envNames(),
    demo: IS_DEMO,
    envFileExists: IS_DEMO || existsSync(join(ROOT, ".env")),
    // Gate A: no more shared ROOT/playwright-report — "a report exists" now means the newest
    // finished run's own dir has one (listRuns already filters to dirs with an index.html, and is
    // demo-aware via records.ts's RUNS_DIR).
    reportExists: listRuns().length > 0,
    // Non-null when config/urls.json can't be parsed — the UI shows a fix hint.
    configError: getLastConfigError(),
  };
}

/** The JSON status blob for one run (keyed /api/state?run=<id>) — undefined if unknown. */
export function publicState(runId: string): ReturnType<typeof shapeOf> | undefined;
/** Compat: the newest active-or-most-recent run's public state, or an idle default when none —
 *  same shape as today. The frozen SPA's /api/state (no run param) uses this. */
export function publicState(): ReturnType<typeof shapeOf>;
export function publicState(runId?: string): ReturnType<typeof shapeOf> | undefined {
  if (runId) {
    const h = runs.get(runId);
    return h ? shapeOf(h.status, h.env, h.envs, h.light) : undefined;
  }
  if (recordingState.recording || recordingState.proc) {
    return shapeOf(recordingState.status, recordingState.env, recordingState.envs, false);
  }
  const cur = compatRun();
  if (cur) return shapeOf(cur.status, cur.env, cur.envs, cur.light);
  return shapeOf("idle", null, [], false);
}

/** The /api/stream?run=<id> Response: replay that run's state + buffered lines on connect, then
 *  stream its live events. undefined if the runId is unknown (caller 404s). */
export function runStream(runId: string): Response | undefined;
/** Compat: the /api/stream (no run param) Response the frozen SPA/recorder use — replays the
 *  newest-or-recording run's state + buffered lines, then streams both that run's AND the global
 *  channel's events (so lifecycle events for a run started after connect still arrive). */
export function runStream(): Response;
export function runStream(runId?: string): Response | undefined {
  if (runId) {
    const h = runs.get(runId);
    if (!h) return undefined;
    let self: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller;
        controller.enqueue(frame("state", publicState(runId)));
        for (const line of h.lines) controller.enqueue(frame("line", { line }));
        h.clients.add(controller);
      },
      cancel() {
        if (self) h.clients.delete(self);
      },
    });
    return new Response(body, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }
  // ---- compat / global ----
  let self: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      self = controller;
      controller.enqueue(frame("state", publicState()));
      const recording = recordingState.recording || recordingState.proc;
      const replayLines = recording ? recordingState.lines : (compatRun()?.lines ?? []);
      for (const line of replayLines) controller.enqueue(frame("line", { line }));
      globalClients.add(controller);
    },
    cancel() {
      if (self) globalClients.delete(self);
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
