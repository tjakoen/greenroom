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
