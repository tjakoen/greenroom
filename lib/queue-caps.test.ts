// Run-queue admission caps + the hung-run watchdog (lib/run-queue.ts, DEPLOY.md's GR_MAX_* /
// GR_RUN_TIMEOUT_MS knobs). These are the controls that stop one user exhausting a shared instance,
// so they matter most in exactly the multi-user deployment the rest of the suite now covers.
//
// Each cap needs a different env, and the caps are read per call from process.env, so each block
// boots its own server. Three short-lived instances instead of one, deliberately.
//
// Keeping the in-flight window deterministic without a browser: enqueue a run whose --grep matches
// no test. Playwright still spawns, loads its config and exits, which takes seconds — long enough
// that the follow-up enqueue reliably sees the first run in flight — but it launches no browser and
// makes no network request. `envs: []` (the trick lib/platform-api.test.ts uses for a fast settle)
// is the opposite of what's wanted here: it settles before a second enqueue could ever be refused.
//
// The environment NAME is read from /api/state rather than hardcoded, because config/urls.json is
// git-ignored and machine-specific — on CI it is seeded from config/urls.example.json, so a literal
// like "demo-dev" would pass locally and fail there.
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const SERVER = join(import.meta.dir, "..", "server.ts");
const NO_MATCH_GREP = "__greenroom_no_such_test_name__";

type Booted = {
  proc: Subprocess;
  base: string;
  db: string;
  /** Everything the server has written to stderr so far. */
  stderr: () => string;
  stop: () => Promise<void>;
};

async function boot(port: number, extra: Record<string, string>): Promise<Booted> {
  const db = `/tmp/gr-queue-caps-${process.pid}-${port}.db`;
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", SERVER], {
    cwd: "/tmp",
    env: {
      ...process.env,
      GREENROOM_MODE: "platform",
      GREENROOM_DB_PATH: db,
      PORT: String(port),
      HOST: "127.0.0.1",
      BETTER_AUTH_SECRET: "queue-caps-test-secret",
      SECRET_KEY: "queue-caps-test-key",
      ...extra,
    } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Drain stderr continuously into a buffer: the watchdog announces itself there, and an unread
  // pipe would also eventually block the child.
  let err = "";
  (async () => {
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        err += new TextDecoder().decode(value);
      }
    } catch { /* stream closed on teardown */ }
  })();

  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/login`, { redirect: "manual" })).status === 200) { ready = true; break; }
    } catch { /* not up yet */ }
    await Bun.sleep(250);
  }
  if (!ready) throw new Error(`queue-caps server on ${port} did not become ready:\n${err}`);

  return {
    proc, base, db,
    stderr: () => err,
    stop: async () => {
      proc.kill();
      await proc.exited;
      for (const s of ["", "-wal", "-shm"]) rmSync(db + s, { force: true });
    },
  };
}

const jsonHdr = { "Content-Type": "application/json" };

async function signUp(base: string, email: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: jsonHdr,
    body: JSON.stringify({ email, password: "queue-caps-pw-123", name: "Queue Caps" }),
  });
  if (r.status !== 200) throw new Error(`sign-up ${email} -> ${r.status}`);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

/** First configured environment name, whatever this machine/CI happens to have. */
async function anEnv(base: string, cookie: string): Promise<string> {
  const s = (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()) as { envs?: string[] };
  const name = s.envs?.[0];
  if (!name) throw new Error("no configured environment to run against");
  return name;
}

/** Enqueue a run that occupies a slot for a few seconds without launching a browser. */
async function enqueue(base: string, cookie: string, env: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { ...jsonHdr, cookie },
    body: JSON.stringify({ envs: [env], grep: NO_MATCH_GREP }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

test("per-user cap: a second in-flight run is refused 429, and it does NOT lock out other users", async () => {
  const srv = await boot(4411, { GR_MAX_QUEUED_PER_USER: "1", GR_MAX_QUEUED: "50", GR_MAX_PARALLEL_RUNS: "1" });
  try {
    const alice = await signUp(srv.base, `alice-caps-${process.pid}@example.com`);
    const bob = await signUp(srv.base, `bob-caps-${process.pid}@example.com`);
    const env = await anEnv(srv.base, alice);

    const first = await enqueue(srv.base, alice, env);
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);

    // Alice is at her ceiling of 1 in-flight run.
    const second = await enqueue(srv.base, alice, env);
    expect(second.status).toBe(429);
    expect(String(second.body.error)).toContain("You already have");

    // The property that actually matters on a shared instance: Alice hitting her own cap must not
    // deny service to Bob. A global-only cap would fail here, and one noisy user would be able to
    // freeze the queue for the whole company.
    const bobs = await enqueue(srv.base, bob, env);
    expect(bobs.status).toBe(200);
    expect(bobs.body.ok).toBe(true);
  } finally {
    await srv.stop();
  }
}, 60_000);

test("global cap: in-flight total is bounded across users, not just per user", async () => {
  const srv = await boot(4412, { GR_MAX_QUEUED: "1", GR_MAX_QUEUED_PER_USER: "50", GR_MAX_PARALLEL_RUNS: "1" });
  try {
    const alice = await signUp(srv.base, `alice-global-${process.pid}@example.com`);
    const bob = await signUp(srv.base, `bob-global-${process.pid}@example.com`);
    const env = await anEnv(srv.base, alice);

    expect((await enqueue(srv.base, alice, env)).status).toBe(200);

    // A DIFFERENT user is refused, so this ceiling is genuinely global. Per-user headroom is 50
    // here, so only the global cap can be responsible for the rejection.
    const bobs = await enqueue(srv.base, bob, env);
    expect(bobs.status).toBe(429);
    expect(String(bobs.body.error)).toContain("queue is full");
  } finally {
    await srv.stop();
  }
}, 60_000);

test("watchdog: a run past GR_RUN_TIMEOUT_MS is force-stopped and frees its slot", async () => {
  // 700ms ceiling with one slot: Playwright cannot finish booting in that time, so the run is still
  // alive when the watchdog fires. That is the hung-child case the watchdog exists for.
  const srv = await boot(4413, { GR_RUN_TIMEOUT_MS: "700", GR_MAX_PARALLEL_RUNS: "1", GR_MAX_QUEUED: "50", GR_MAX_QUEUED_PER_USER: "50" });
  try {
    const cookie = await signUp(srv.base, `watchdog-${process.pid}@example.com`);
    const env = await anEnv(srv.base, cookie);

    const first = await enqueue(srv.base, cookie, env);
    expect(first.status).toBe(200);
    const runId = first.body.runId as string;

    // The watchdog announces itself on stderr — an unambiguous signal that it fired, rather than
    // inferring it from a terminal status a natural finish could also produce.
    let fired = false;
    for (let i = 0; i < 80; i++) {
      if (srv.stderr().includes("force-stopping (watchdog)")) { fired = true; break; }
      await Bun.sleep(250);
    }
    expect(fired).toBe(true);
    expect(srv.stderr()).toContain(runId);

    // ...and the killed run must not pin its slot: it reaches a terminal status, and a fresh run is
    // admitted and also settles. A wedged slot would leave this queued forever.
    for (let i = 0; i < 80; i++) {
      const r = await fetch(`${srv.base}/api/state?run=${runId}`, { headers: { cookie } });
      if (r.status === 200) {
        const st = (await r.json()) as { status?: string };
        if (st.status && st.status !== "queued" && st.status !== "running") break;
      }
      await Bun.sleep(250);
    }

    const next = await enqueue(srv.base, cookie, env);
    expect(next.status).toBe(200);
    expect(next.body.ok).toBe(true);
  } finally {
    await srv.stop();
  }
}, 90_000);
