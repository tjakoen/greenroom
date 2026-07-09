// lib/run-stream.ts — the run's shared mutable state + its Server-Sent-Events hub.
//
// PLAN §1 says the run output "moves to batch createStream with the same event names
// (state/line/started/done) and replay-on-connect". The pinned batch Stream (f9ecb03) is a
// per-session broadcast hub with NO replay-on-subscribe seam, and P1 must serve the FROZEN
// interface/app.js whose EventSource opens /api/stream and expects the current `state` event +
// the buffered `line` history replayed on THAT same connection before live events flow. So the
// run stream is a greenroom-owned Bun ReadableStream hub here: identical event names + the
// replay §5.1 ("SSE replay") requires. Swap to batch createStream if/when it grows a
// replay-on-subscribe hook. The AI door (Phase G) gets its OWN separate stream — never this one.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { ROOT, DEMO_DIR, IS_DEMO } from "./paths.ts";
import { envNames, getLastConfigError } from "./envs.ts";

export interface RunState {
  status: "idle" | "running" | "passed" | "failed" | "stopped";
  env: string | null; // display label: single env name, or "a+b" for a multi-env run
  envs: string[]; // the env list the current/last run targeted
  light: boolean;
  lines: string[];
  proc: ChildProcess | null;
  recording: boolean; // true during the async pre-auth window before proc is set
}

export const MAX_LINES = 2000;
export const state: RunState = {
  status: "idle",
  env: null,
  envs: [],
  light: false,
  lines: [],
  proc: null,
  recording: false,
};

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const encoder = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const frame = (event: string, data: unknown): Uint8Array =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** Push a named event to every open /api/stream connection. Mirrors server.js broadcast(). */
export function broadcast(event: string, data: unknown): void {
  const chunk = frame(event, data);
  for (const c of clients) {
    try {
      c.enqueue(chunk);
    } catch {
      clients.delete(c); // closed tab → drop quietly
    }
  }
}

/** Append runner stdout/stderr to the line buffer (capped) and broadcast each new line.
 *  Mirrors server.js pushOutput(); accepts a Buffer or string. */
export function pushOutput(chunk: unknown): void {
  for (const line of stripAnsi(String(chunk)).split("\n")) {
    if (line.trim() === "") continue;
    state.lines.push(line);
    if (state.lines.length > MAX_LINES) state.lines.shift();
    broadcast("line", { line });
  }
}

/** The JSON status blob the UI polls (/api/state) and every started/done SSE frame carries.
 *  Mirrors server.js publicState(). */
export function publicState() {
  return {
    status: state.status,
    env: state.env,
    runEnvs: state.envs, // which envs the current/last run targeted
    light: state.light,
    envs: envNames(),
    demo: IS_DEMO,
    envFileExists: IS_DEMO || existsSync(join(ROOT, ".env")),
    reportExists: IS_DEMO
      ? existsSync(join(DEMO_DIR, "runs")) // demo: report links resolve to seeded runs
      : existsSync(join(ROOT, "playwright-report", "index.html")),
    // Non-null when config/urls.json can't be parsed — the UI shows a fix hint.
    configError: getLastConfigError(),
  };
}

/** The /api/stream Response: replay current state + buffered lines on connect, then stream live.
 *  See the file header for why this is greenroom-owned rather than batch createStream. */
export function runStream(): Response {
  let self: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      self = controller;
      controller.enqueue(frame("state", publicState()));
      for (const line of state.lines) controller.enqueue(frame("line", { line }));
      clients.add(controller);
    },
    cancel() {
      if (self) clients.delete(self);
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
