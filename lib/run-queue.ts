// lib/run-queue.ts — P5 Gate D (plans/platform.md §6): the server-side run QUEUE with bounded
// concurrency. Replaces the direct single-run path (`/api/run` -> buildRunConfig -> startRun`)
// that Gate C left in server.ts: every run now becomes a DB row the moment it's requested
// (status:'queued'), and an in-process scheduler (`tick`) promotes queued rows to `startRun` calls
// FIFO, never running more than `GR_MAX_PARALLEL_RUNS` at once. The DB row id, the RunHandle id
// (lib/run-stream.ts), and the eventual archive dir name are all the SAME id end to end — set
// once here at enqueue time, threaded through startRun via its `runId` option (lib/runner.ts).
//
// Concurrency model: this is a SINGLE Bun process (no worker threads, no multiple server
// instances) — `tick()`'s own re-entrancy guard (`ticking`) is therefore the only lock this needs;
// two requests racing to enqueue/stop/finish never interleave `tick`'s own body, only ever queue
// up a re-run of it (`pendingTick`) once the in-flight one finishes.
import { eq, asc, and, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { run, runResult, test, type RunScope } from "../db/schema.ts";
import { resolveScopedUser } from "../auth/index.ts";
import { buildRunConfig } from "./run-config.ts";
import { startRun, stopRun as stopRunHandle, type RunResult as StartRunResult } from "./runner.ts";
import { createRun, getRun, broadcast, broadcastGlobal, publicState } from "./run-stream.ts";
import { readResults } from "./tests-lib.ts";
import { basename } from "node:path";

/** Max simultaneously-`running` rows. Re-read every call (not cached at module-load) so a test
 *  boot can tune it via the env var without any extra plumbing. */
function cap(): number {
  const n = Number(process.env.GR_MAX_PARALLEL_RUNS ?? 2);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

/** Admission control (audit: unbounded queue depth → memory/DB exhaustion DoS). A queued row pins
 *  an in-memory RunHandle (never evicted while queued, run-stream.ts) + a DB row, and only `cap()`
 *  ever drain at once — so without a ceiling one client firing thousands of POST /api/run grows
 *  both without bound. Cap total in-flight (queued+running) globally and per user. Env-tunable. */
function maxQueued(): number {
  const n = Number(process.env.GR_MAX_QUEUED ?? 200);
  return Number.isFinite(n) && n > 0 ? n : 200;
}
function maxQueuedPerUser(): number {
  const n = Number(process.env.GR_MAX_QUEUED_PER_USER ?? 20);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

/** Wall-clock ceiling for a single run before the queue force-stops it (audit: a hung child that
 *  never emits 'close' otherwise wedges a concurrency slot forever). 0/invalid disables. */
function runTimeoutMs(): number {
  const n = Number(process.env.GR_RUN_TIMEOUT_MS ?? 30 * 60 * 1000);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
}

/** Thrown by enqueueRun when the queue is at capacity — server.ts maps it to HTTP 429. */
export class QueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueFullError";
  }
}

// The scope shape a queued row's `run.scope` json column carries — a superset of db/schema.ts's
// RunScope (which only types envs/files/grep) with the two extra fields this queue also needs to
// hand back to startRun once it actually launches the row.
interface QueuedScope extends RunScope {
  role?: string;
  light?: boolean;
}

export interface EnqueueParams {
  userId: string;
  envs: string[];
  files?: string[];
  grep?: string;
  role?: string;
  light?: boolean;
}

export interface EnqueueResult {
  runId: string;
  /** 0 = will start the moment `tick()` runs (immediately, in practice); N>0 = N runs (running or
   *  queued ahead of it) must finish first. Advisory — re-check /api/queue or the `position`
   *  channel event for the current number; it only ever decreases. */
  position: number;
}

function countByStatus(status: string): number {
  return db.select({ id: run.id }).from(run).where(eq(run.status, status)).all().length;
}

// How many runs stand between a row and its turn, given `runningCount` already running and
// `queuedAhead` queued rows strictly before it in FIFO order. 0 once there's a free slot for it.
function computePosition(runningCount: number, queuedAhead: number): number {
  return Math.max(0, runningCount + queuedAhead - cap() + 1);
}

/** Enqueues a run: inserts a `queued` DB row (FIFO via `queuedAt`) + a matching "queued"
 *  lib/run-stream.ts handle (so /api/stream?run=<runId> is subscribable immediately, before the
 *  run ever starts), kicks the scheduler, and returns the new run's id + its queue position. */
export async function enqueueRun(params: EnqueueParams): Promise<EnqueueResult> {
  const envs = params.envs.map((e) => String(e ?? "").trim()).filter(Boolean);
  const envLabel = envs.join("+") || "?";
  // Snapshot ahead-of-me counts BEFORE inserting this row (so this row isn't counted against itself).
  const runningCount = countByStatus("running");
  const queuedAhead = countByStatus("queued");

  // Admission control — reject rather than grow the queue/handle-map without bound.
  const inFlight = runningCount + queuedAhead;
  if (inFlight >= maxQueued()) {
    throw new QueueFullError(`The run queue is full (${inFlight} in flight). Try again once some runs finish.`);
  }
  const mineInFlight = db
    .select({ id: run.id })
    .from(run)
    .where(and(eq(run.triggeredBy, params.userId), inArray(run.status, ["queued", "running"])))
    .all().length;
  if (mineInFlight >= maxQueuedPerUser()) {
    throw new QueueFullError(`You already have ${mineInFlight} runs queued or running. Wait for some to finish before starting more.`);
  }

  const scope: QueuedScope = { envs, files: params.files, grep: params.grep, role: params.role, light: !!params.light };
  const [row] = await db
    .insert(run)
    .values({
      envLabel,
      status: "queued",
      queuedAt: new Date(),
      triggeredBy: params.userId,
      scope,
    })
    .returning();

  createRun(row.id, { env: envLabel, envs, light: !!params.light, status: "queued" });

  const position = computePosition(runningCount, queuedAhead);
  broadcastGlobal("queued", { runId: row.id, position });
  tick();
  return { runId: row.id, position };
}

/** One queue row shaped for /api/queue — every currently queued or running run, with its position
 *  (0 for anything running). */
export interface QueueEntry {
  runId: string;
  status: string;
  envLabel: string;
  triggeredBy: string;
  queuedAt: number | null;
  startedAt: number | null;
  position: number;
}

export function listQueue(): QueueEntry[] {
  const runningRows = db.select().from(run).where(eq(run.status, "running")).orderBy(asc(run.startedAt)).all();
  const queuedRows = db.select().from(run).where(eq(run.status, "queued")).orderBy(asc(run.queuedAt)).all();
  const runningCount = runningRows.length;
  const entries: QueueEntry[] = runningRows.map((r) => ({
    runId: r.id,
    status: r.status,
    envLabel: r.envLabel,
    triggeredBy: r.triggeredBy,
    queuedAt: r.queuedAt ? r.queuedAt.getTime() : null,
    startedAt: r.startedAt ? r.startedAt.getTime() : null,
    position: 0,
  }));
  queuedRows.forEach((r, i) => {
    entries.push({
      runId: r.id,
      status: r.status,
      envLabel: r.envLabel,
      triggeredBy: r.triggeredBy,
      queuedAt: r.queuedAt ? r.queuedAt.getTime() : null,
      startedAt: null,
      position: computePosition(runningCount, i),
    });
  });
  return entries;
}

/** Broadcasts every still-queued row's current position on the global channel — called whenever
 *  the queue advances, so a client polling-or-listening sees its number count down without
 *  needing to re-derive it itself. */
function broadcastPositions(): void {
  for (const entry of listQueue()) {
    if (entry.status === "queued") broadcastGlobal("position", { runId: entry.runId, position: entry.position });
  }
}

/** Finds the resulting test rows for a just-finished run (readResults(runId), lib/tests-lib.ts)
 *  and writes them into `runResult`, resolving each to a `test` row by basename(file)::title —
 *  the exact key shape scripts/import-flatfiles.ts already uses for the same join. Silently skips
 *  results that don't match a known test row (never yet imported/synced) rather than failing the
 *  whole run's bookkeeping over one row. */
function writeRunResults(runId: string): void {
  const results = readResults(runId) as Array<{ file?: string; title: string; env?: string; status: string; durationMs?: number }>;
  if (!results.length) return;
  const testRows = db.select({ id: test.id, filePath: test.filePath, title: test.title }).from(test).all();
  const testIdByKey = new Map(testRows.map((t) => [`${basename(t.filePath)}::${t.title}`, t.id]));
  for (const r of results) {
    const testId = r.file ? testIdByKey.get(`${basename(r.file)}::${r.title}`) : undefined;
    if (!testId) continue;
    db.insert(runResult)
      .values({ runId, testId, env: r.env ?? "", status: r.status, durationMs: r.durationMs ?? null })
      .run();
  }
}

function closeRow(runId: string, status: string, artifactDir?: string): void {
  db.update(run)
    .set({ status, finishedAt: new Date(), artifactDir: artifactDir ?? null })
    .where(eq(run.id, runId))
    .run();
}

/** Claims the oldest queued row (FIFO by queuedAt) by flipping it to `running` + `startedAt` in
 *  the SAME synchronous call — nothing else can observe it as still "queued" once this returns, so
 *  two overlapping `tick()` bodies (shouldn't happen, `ticking` guards it, but cheap insurance)
 *  can't both claim it. Returns undefined once the queue is empty. */
function claimNextQueued(): typeof run.$inferSelect | undefined {
  const [row] = db.select().from(run).where(eq(run.status, "queued")).orderBy(asc(run.queuedAt)).limit(1).all();
  if (!row) return undefined;
  const startedAt = new Date();
  db.update(run).set({ status: "running", startedAt }).where(eq(run.id, row.id)).run();
  return { ...row, status: "running", startedAt };
}

/** Resolves scope/creds and actually launches one claimed row via lib/runner.ts's startRun,
 *  wiring `onDone` back to this module's bookkeeping (DB row close + runResult rows + tick()). */
async function launch(row: typeof run.$inferSelect): Promise<void> {
  const scope = (row.scope ?? {}) as QueuedScope;
  const envs = scope.envs ?? [];

  // Settle a row that never actually reached a live "running" child to `error` and free its slot —
  // not "failed" (implies tests ran) or "stopped" (implies someone asked). Also broadcasts done.
  const settleError = (runConfig?: { cleanup: () => void }): void => {
    try { runConfig?.cleanup(); } catch { /* best-effort */ }
    closeRow(row.id, "error");
    const handle = getRun(row.id);
    if (handle) {
      handle.status = "error";
      broadcast(row.id, "done", publicState(row.id));
    }
    broadcastGlobal("done", publicState());
  };

  // claimNextQueued() already flipped this row to `running`. If resolveScopedUser/buildRunConfig/
  // startRun THROW (a DB hiccup, a tmpdir write failure), that status would otherwise stick forever
  // — countByStatus("running") keeps counting it, the concurrency slot is consumed, and the queue
  // wedges until a restart runs reconcileOnBoot (audit #3). And because tick() fire-and-forgets
  // runTick(), the throw would be an unhandled rejection. Catch it and settle the row to `error`.
  let runConfig: Awaited<ReturnType<typeof buildRunConfig>> | undefined;
  try {
    const scopedUser = resolveScopedUser(row.triggeredBy);
    runConfig = await buildRunConfig(scopedUser, envs, scope.role);

    // Watchdog: force-stop a run that outlives the ceiling so a hung child (never emits 'close')
    // can't pin its concurrency slot forever and wedge the whole queue. Cleared on natural done.
    let watchdog: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      watchdog = undefined;
      console.warn(`[lib/run-queue.ts] run ${row.id} exceeded ${runTimeoutMs()}ms — force-stopping (watchdog).`);
      try { stopRunHandle(row.id); } catch { /* best-effort; onDone will still fire on kill */ }
    }, runTimeoutMs());

    const result: StartRunResult = startRun(envs, !!scope.light, scope.files, scope.grep, scope.role, {
      runId: row.id,
      runConfig,
      onDone: (info) => {
        if (watchdog) { clearTimeout(watchdog); watchdog = undefined; }
        closeRow(row.id, info.status, info.artifactDir);
        writeRunResults(row.id);
        broadcastGlobal("done", { runId: row.id, status: info.status });
        tick();
      },
    });

    if (!result.ok && watchdog) { clearTimeout(watchdog); watchdog = undefined; }

    if (!result.ok) {
      // Couldn't even start (e.g. an environment/file vanished between enqueue and its turn, or a
      // recording is in progress) — never reaches "running", so settle to "error" and free the slot.
      console.warn(`[lib/run-queue.ts] run ${row.id} failed to start: ${result.error}`);
      settleError(runConfig);
    }
  } catch (err) {
    console.error(`[lib/run-queue.ts] run ${row.id} threw during launch — settling to error:`, err);
    settleError(runConfig);
  }
}

let ticking = false;
let pendingTick = false;

/** Runs the scheduler: while there's a free slot under `cap()` and a queued row exists, claim +
 *  launch it. Re-entrancy-safe — a call that arrives while another is already running just marks
 *  `pendingTick` and returns; the in-flight call re-runs itself once done so no enqueue/stop/done
 *  event is ever silently dropped. Fire-and-forget by design (callers never await it — enqueueing
 *  or finishing a run shouldn't block on the NEXT run's launch). */
export function tick(): void {
  if (ticking) {
    pendingTick = true;
    return;
  }
  ticking = true;
  void runTick().finally(() => {
    ticking = false;
    if (pendingTick) {
      pendingTick = false;
      tick();
    }
  });
}

async function runTick(): Promise<void> {
  for (;;) {
    if (countByStatus("running") >= cap()) return;
    const claimed = claimNextQueued();
    if (!claimed) return;
    broadcastGlobal("started", { runId: claimed.id });
    await launch(claimed);
    broadcastPositions();
  }
}

/** Stops one run by DB row id: a still-`queued` row is marked `stopped` and never starts; a
 *  `running` row is killed via lib/runner.ts's existing stopRun (its own close handler drives this
 *  module's `onDone` -> DB close + tick(), same as a natural finish). */
export function stopRun(runId: string): StartRunResult {
  const [row] = db.select().from(run).where(eq(run.id, runId)).all();
  if (!row) return { ok: false, error: "Unknown run." };
  if (row.status === "queued") {
    closeRow(runId, "stopped");
    const handle = getRun(runId);
    if (handle) {
      handle.status = "stopped";
      broadcast(runId, "done", publicState(runId));
    }
    broadcastGlobal("done", publicState());
    tick();
    return { ok: true };
  }
  if (row.status === "running") return stopRunHandle(runId);
  return { ok: false, error: "That run isn't active." };
}

/** Boot-time crash recovery (server.ts, once at startup, before serving): a row left `running`
 *  from a previous process (it crashed/was killed — nothing in memory survived a restart to finish
 *  it) becomes `error`; a `queued` row becomes `stopped` rather than silently auto-resuming a run
 *  nobody's watching anymore. Run this BEFORE the first `tick()` so neither status is ever
 *  observed as still active by a fresh boot. */
export function reconcileOnBoot(): void {
  const now = new Date();
  db.update(run).set({ status: "error", finishedAt: now }).where(eq(run.status, "running")).run();
  db.update(run).set({ status: "stopped", finishedAt: now }).where(eq(run.status, "queued")).run();
}
