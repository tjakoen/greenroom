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
