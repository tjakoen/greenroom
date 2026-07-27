// Booted-server integration test for the PLATFORM edition's security gates (audit: session gate,
// CSRF/origin guard, config-write lockdown). Spawns a real `bun server.ts` against a throwaway db
// on a private port, drives it over HTTP, then tears it down. Guards the exact fixes shipped in the
// local/platform split so a regression fails CI instead of quietly re-opening a hole.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `/tmp/gr-integ-test-${process.pid}.db`;
const SERVER = join(import.meta.dir, "..", "server.ts");
let proc: Subprocess;

async function waitReady(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/login`, { redirect: "manual" });
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await Bun.sleep(250);
  }
  throw new Error("integration server did not become ready");
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", SERVER], {
    // cwd=/tmp dodges a machine-local bun cwd-canonicalization stall; server.ts resolves its own
    // paths via import.meta so cwd doesn't affect correctness. Only the db is redirected (isolated).
    cwd: "/tmp",
    env: {
      ...process.env,
      GREENROOM_MODE: "platform",
      GREENROOM_DB_PATH: DB,
      PORT: String(PORT),
      BETTER_AUTH_SECRET: "integration-test-secret",
      SECRET_KEY: "integration-test-key",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitReady();
});

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch { /* not there */ } }
});

const jsonHdr = { "content-type": "application/json", origin: BASE };
const PW = "integration-pw-123";

// --- helpers shared by the run-artifact scope + queue tests below --------------------------------

function cookieFrom(r: Response): string {
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

/** Create a fresh account; returns its session cookie + the better-auth user id. NOTE: the FIRST
 *  account created against the server (the `it-…` account in the config-lockdown test above) is the
 *  superadmin (first-user rule) — every account minted here afterwards is a normal, non-superadmin
 *  user, which is exactly the non-owner case the wall tests need. */
async function signUp(email: string): Promise<{ cookie: string; userId: string }> {
  const r = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST", headers: jsonHdr,
    body: JSON.stringify({ email, password: PW, name: email.split("@")[0] }),
  });
  if (r.status !== 200) throw new Error(`sign-up ${email} -> ${r.status}`);
  const body = (await r.json()) as { user?: { id?: string } };
  return { cookie: cookieFrom(r), userId: body.user?.id ?? "" };
}

async function signIn(email: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST", headers: jsonHdr, body: JSON.stringify({ email, password: PW }),
  });
  if (r.status !== 200) throw new Error(`sign-in ${email} -> ${r.status}`);
  return cookieFrom(r);
}

/** Seed one run + its single covered test + result straight into the server's db over a 2nd
 *  connection to the same file — WAL makes the committed writes visible to the live server. No
 *  artifact files are written: canReadRun walls (or clears) purely on the DB rows, up front. */
async function seedRun(o: {
  id: string; dir: string; visibility: "private" | "company"; ownerId: string; triggeredBy: string;
}): Promise<void> {
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const { Database } = await import("bun:sqlite");
  const schema = await import("../db/schema.ts");
  const sq = new Database(DB);
  sq.exec("PRAGMA foreign_keys = ON;");
  const d = drizzle(sq, { schema });
  d.insert(schema.test).values({ id: `${o.id}-t`, title: o.id, filePath: `tests/${o.id}.spec.ts`, ownerId: o.ownerId, visibility: o.visibility }).run();
  d.insert(schema.run).values({ id: o.id, envLabel: "e", status: "failed", triggeredBy: o.triggeredBy, artifactDir: o.dir }).run();
  d.insert(schema.runResult).values({ id: `${o.id}-rr`, runId: o.id, testId: `${o.id}-t`, env: "e", status: "failed" }).run();
  sq.close();
}

const status = (r: Response) => r.status;
const get = (path: string, cookie: string) => fetch(`${BASE}${path}`, { headers: { cookie } });
const postPdf = (run: string, cookie: string) =>
  fetch(`${BASE}/api/pdf`, { method: "POST", headers: { ...jsonHdr, cookie }, body: JSON.stringify({ run, test: "x" }) });

// The full set of ?run=-keyed artifact endpoints guarded up front in server.ts (RUN_ARTIFACT_QP).
const QP_ARTIFACT_ENDPOINTS = [
  "/api/pdf-data", "/api/pdf-image", "/api/moment", "/api/video", "/api/video-clip",
  "/api/bug-summary", "/api/bug-bundle", "/api/results",
];

test("unauthenticated page 302s to /login (session gate)", async () => {
  const r = await fetch(`${BASE}/run`, { redirect: "manual" });
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("/login");
});

test("unauthenticated /api write 401s (session gate)", async () => {
  const r = await fetch(`${BASE}/api/creds`, { method: "POST", headers: jsonHdr, body: "{}" });
  expect(r.status).toBe(401);
});

test("cross-origin write is refused 403 before the gate even runs (CSRF/origin guard)", async () => {
  const r = await fetch(`${BASE}/api/creds`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: "{}",
  });
  expect(r.status).toBe(403);
});

test("a session unlocks the app but platform config writes stay locked (audit #1)", async () => {
  const su = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: jsonHdr,
    body: JSON.stringify({ email: `it-${process.pid}@example.com`, password: "integration-pw-123", name: "IT" }),
  });
  expect(su.status).toBe(200);
  const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  expect(cookie.length).toBeGreaterThan(0);

  // Authenticated: the app is reachable, but Settings is local-only and config writes are locked.
  expect((await fetch(`${BASE}/run`, { headers: { cookie }, redirect: "manual" })).status).toBe(200);
  expect((await fetch(`${BASE}/settings`, { headers: { cookie }, redirect: "manual" })).status).toBe(404);
  expect((await fetch(`${BASE}/api/creds`, { headers: { cookie } })).status).toBe(200); // read stays open
  const write = await fetch(`${BASE}/api/creds`, {
    method: "POST",
    headers: { ...jsonHdr, cookie },
    body: JSON.stringify({ role: "x", env: "y", username: "u", password: "p" }),
  });
  expect(write.status).toBe(403); // PLATFORM_CONFIG_LOCKED
});

test("a non-owner is walled 403 from a PRIVATE run's artifacts, but not a company run (audit #2, HTTP path)", async () => {
  // Seed one private + one company run straight into the server's db (a 2nd connection to the same
  // file — WAL makes the committed writes visible to the live server). No artifact files are needed:
  // canReadRun walls up front, before any disk read. This asserts the HTTP guard that run-scope.test
  // covers only at the function level.
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const { Database } = await import("bun:sqlite");
  const schema = await import("../db/schema.ts");
  const sq = new Database(DB);
  sq.exec("PRAGMA foreign_keys = ON;");
  const d = drizzle(sq, { schema });
  d.insert(schema.test).values({ id: "priv-t", title: "Priv", filePath: "tests/priv.spec.ts", ownerId: "seed-owner", visibility: "private" }).run();
  d.insert(schema.run).values({ id: "priv-run", envLabel: "e", status: "failed", triggeredBy: "seed-owner", artifactDir: "priv-dir" }).run();
  d.insert(schema.runResult).values({ id: "priv-rr", runId: "priv-run", testId: "priv-t", env: "e", status: "failed" }).run();
  d.insert(schema.test).values({ id: "comp-t", title: "Comp", filePath: "tests/comp.spec.ts", ownerId: "seed-owner", visibility: "company" }).run();
  d.insert(schema.run).values({ id: "comp-run", envLabel: "e", status: "passed", triggeredBy: "seed-owner", artifactDir: "comp-dir" }).run();
  d.insert(schema.runResult).values({ id: "comp-rr", runId: "comp-run", testId: "comp-t", env: "e", status: "passed" }).run();
  sq.close();

  // A reader account. The FIRST sign-up (the prior test) became superadmin; this later account is a
  // normal, non-superadmin, non-owner user — the walled case (superadmin/triggerer would pass).
  const su = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: jsonHdr,
    body: JSON.stringify({ email: `reader-${process.pid}@example.com`, password: "integration-pw-123", name: "Reader" }),
  });
  expect(su.status).toBe(200);
  const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  expect(cookie.length).toBeGreaterThan(0);

  // Walled from the private run — addressed by artifactDir AND by run id (both resolve to one row).
  expect((await fetch(`${BASE}/api/results?run=priv-dir`, { headers: { cookie } })).status).toBe(403);
  expect((await fetch(`${BASE}/api/results?run=priv-run`, { headers: { cookie } })).status).toBe(403);
  // The wall is selective: a company-visibility run clears the scope guard (it may 404 for missing
  // artifact files on disk, but the point is it is NOT 403).
  expect((await fetch(`${BASE}/api/results?run=comp-dir`, { headers: { cookie } })).status).not.toBe(403);
});

test("superadmin bypasses the private-run wall over HTTP (qp endpoints, POST /api/pdf, /runs/ serve)", async () => {
  await seedRun({ id: "sa-priv", dir: "sa-priv-dir", visibility: "private", ownerId: "seed-owner", triggeredBy: "seed-owner" });
  const cookie = await signIn(`it-${process.pid}@example.com`); // the first account = superadmin
  for (const ep of QP_ARTIFACT_ENDPOINTS) {
    expect(status(await get(`${ep}?run=sa-priv-dir`, cookie))).not.toBe(403);
  }
  expect(status(await postPdf("sa-priv-dir", cookie))).not.toBe(403);
  expect(status(await get(`/runs/sa-priv-dir/index.html`, cookie))).not.toBe(403);
});

test("the run's triggering user reads their own private run over HTTP", async () => {
  const owner = await signUp(`owner-${process.pid}@example.com`); // normal user, but this run's triggerer
  await seedRun({ id: "own-priv", dir: "own-priv-dir", visibility: "private", ownerId: owner.userId, triggeredBy: owner.userId });
  expect(status(await get(`/api/results?run=own-priv-dir`, owner.cookie))).not.toBe(403);
  expect(status(await get(`/api/results?run=own-priv`, owner.cookie))).not.toBe(403); // by id too
  expect(status(await get(`/runs/own-priv-dir/index.html`, owner.cookie))).not.toBe(403);
});

test("a non-owner is walled 403 across EVERY artifact endpoint + static serve, private only", async () => {
  await seedRun({ id: "priv2", dir: "priv2-dir", visibility: "private", ownerId: "seed-owner", triggeredBy: "seed-owner" });
  await seedRun({ id: "comp2", dir: "comp2-dir", visibility: "company", ownerId: "seed-owner", triggeredBy: "seed-owner" });
  const { cookie } = await signUp(`reader2-${process.pid}@example.com`); // normal, non-owner

  // PRIVATE run — every up-front-guarded ?run= endpoint 403s...
  for (const ep of QP_ARTIFACT_ENDPOINTS) {
    expect(status(await get(`${ep}?run=priv2-dir`, cookie))).toBe(403);
  }
  // ...as do the two separately-guarded paths: POST /api/pdf (run in body) + the /runs/ static serve.
  expect(status(await postPdf("priv2-dir", cookie))).toBe(403);
  expect(status(await get(`/runs/priv2-dir/index.html`, cookie))).toBe(403);
  expect(status(await get(`/runs/priv2-dir/anything/deep.png`, cookie))).toBe(403); // first path seg keys the guard

  // COMPANY run — the wall is selective: it clears the guard everywhere (may 404 for missing files,
  // but never 403).
  for (const ep of QP_ARTIFACT_ENDPOINTS) {
    expect(status(await get(`${ep}?run=comp2-dir`, cookie))).not.toBe(403);
  }
  expect(status(await postPdf("comp2-dir", cookie))).not.toBe(403);
  expect(status(await get(`/runs/comp2-dir/index.html`, cookie))).not.toBe(403);
});

test("the run queue: enqueue is authed, keyed + subscribable immediately, and settles (no wedge)", async () => {
  // Unauthenticated enqueue is refused by the session gate.
  expect(status(await fetch(`${BASE}/api/run`, { method: "POST", headers: jsonHdr, body: JSON.stringify({ envs: [] }) }))).toBe(401);

  const { cookie } = await signUp(`runner-${process.pid}@example.com`);
  // Enqueue with NO envs: startRun returns ok:false before spawning anything (runner.ts guards empty
  // envs), so the row settles to `error` fast with no real browser — enough to exercise the whole
  // enqueue -> claim -> launch -> settle path (incl. the audit #4 wedge fix) deterministically.
  const enq = await fetch(`${BASE}/api/run`, { method: "POST", headers: { ...jsonHdr, cookie }, body: JSON.stringify({ envs: [] }) });
  expect(enq.status).toBe(200);
  const { ok, runId } = (await enq.json()) as { ok: boolean; runId: string };
  expect(ok).toBe(true);
  expect(typeof runId).toBe("string");

  // The row is keyed + subscribable from the moment it's queued (createRun runs before tick()).
  expect(status(await get(`/api/state?run=${runId}`, cookie))).not.toBe(404);
  const q = (await (await get(`/api/queue`, cookie)).json()) as { ok: boolean; queue: unknown[] };
  expect(q.ok).toBe(true);
  expect(Array.isArray(q.queue)).toBe(true);

  // It must reach a terminal status — never stick in queued/running (the wedge the queue try/catch
  // guards against).
  let st: { status?: string } | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await get(`/api/state?run=${runId}`, cookie);
    if (r.status === 200) {
      st = (await r.json()) as { status?: string };
      if (st.status && st.status !== "queued" && st.status !== "running") break;
    }
    await Bun.sleep(100);
  }
  expect(st?.status).toBeDefined();
  expect(["queued", "running"]).not.toContain(st!.status);

  // Stopping an unknown run is a clean 409, not a 500.
  expect(status(await fetch(`${BASE}/api/stop?run=does-not-exist`, { method: "POST", headers: { ...jsonHdr, cookie } }))).toBe(409);
});
