// Deployment-gate integration tests — the DEPLOY.md promises that only appear when the instance is
// network-exposed, and that loopback testing therefore never reaches.
//
// Three surfaces, all driven against a really-spawned `bun server.ts` (same harness shape as
// lib/platform-api.test.ts):
//   A. Fail-closed boot gates (server.ts ~898-939) — refuse to start rather than silently fall back
//      to the dev session secret / dev encryption key / non-Secure cookies.
//   B. The ALLOWED_HOSTS Host-header allowlist (lib/guard.ts isAllowedHost) in DEPLOYED mode, where
//      the rule inverts: an empty Host and the wildcard 0.0.0.0 stop being tolerated.
//   C. better-auth's credential-brute-force rate limit + its per-client-IP bucketing via
//      x-forwarded-for, which is only trusted when ALLOWED_HOSTS is set (auth/index.ts IP_ADDRESS).
//
// Why raw sockets for B: `fetch` will not let a caller set Host (it is a forbidden header), and Host
// is the entire subject of those assertions. A 15-line HTTP/1.1 writer gives exact control,
// including the empty-Host case a proxy misconfiguration would produce.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const SERVER = join(import.meta.dir, "..", "server.ts");
// Distinct from platform-api.test.ts's 4399 so the suites can run concurrently.
const PORT = 4407;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `/tmp/gr-deploy-gates-${process.pid}.db`;
const HOSTNAME = "greenroom.internal.test";

/** Env for a *valid* deployed instance: ALLOWED_HOSTS makes it "deployed", so the boot gate then
 *  demands both secrets + an https BETTER_AUTH_URL. Bind stays loopback so the test never actually
 *  opens a port to the network — `deployed` is triggered by ALLOWED_HOSTS, not by the bind. */
function deployedEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    GREENROOM_MODE: "platform",
    GREENROOM_DB_PATH: DB,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    ALLOWED_HOSTS: HOSTNAME,
    BETTER_AUTH_SECRET: "deploy-gates-test-secret",
    SECRET_KEY: "deploy-gates-test-key",
    BETTER_AUTH_URL: `https://${HOSTNAME}`,
    ...extra,
  } as Record<string, string>;
}

// ------------------------------------------------------------------ A. boot gates

/** Spawn a server that is expected to REFUSE to boot. Returns its exit code + stderr.
 *  Uses a port nobody listens on: these gates all run before Bun.serve, so nothing binds. */
async function bootExpectingFailure(env: Record<string, string>): Promise<{ code: number | null; err: string }> {
  const proc = Bun.spawn(["bun", SERVER], { cwd: "/tmp", env, stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, err };
}

test("A1: deployed + BETTER_AUTH_SECRET unset → refuses to boot", async () => {
  const env = deployedEnv();
  delete (env as any).BETTER_AUTH_SECRET;
  const { code, err } = await bootExpectingFailure(env);
  expect(code).toBe(1);
  expect(err).toContain("BETTER_AUTH_SECRET is unset");
  // The point of the gate: no silent fallback to the forgeable dev session secret.
  expect(err).toContain("Refusing to start a network-exposed instance");
});

test("A2: deployed + whitespace-only SECRET_KEY → refuses (a secrets manager can hand back ' ')", async () => {
  const { code, err } = await bootExpectingFailure(deployedEnv({ SECRET_KEY: "   " }));
  expect(code).toBe(1);
  expect(err).toContain("SECRET_KEY is unset");
});

test("A3: deployed + non-https BETTER_AUTH_URL → refuses (Secure cookies would be off)", async () => {
  const { code, err } = await bootExpectingFailure(deployedEnv({ BETTER_AUTH_URL: `http://${HOSTNAME}` }));
  expect(code).toBe(1);
  expect(err).toContain("must be an https:// URL");
});

test("A4: non-loopback HOST in the LOCAL edition → refuses (would expose unlocked config writes)", async () => {
  const env = { ...process.env, HOST: "0.0.0.0", PORT: String(PORT), GREENROOM_DB_PATH: DB } as Record<string, string>;
  delete (env as any).GREENROOM_MODE;
  delete (env as any).ALLOWED_HOSTS;
  const { code, err } = await bootExpectingFailure(env);
  expect(code).toBe(1);
  expect(err).toContain("Refusing to bind a non-loopback HOST");
});

test("A5: deployed + demo mode → refuses (demo has no session gate at all)", async () => {
  const { code, err } = await bootExpectingFailure(deployedEnv({ GREENROOM_DEMO: "1" }));
  expect(code).toBe(1);
  expect(err).toContain("Refusing to expose DEMO mode");
});

test("A6: a purely loopback platform dev run still tolerates the dev fallbacks (gate is not overzealous)", async () => {
  // No ALLOWED_HOSTS, loopback bind, no secrets → must BOOT, because nothing is reachable off-box.
  // A gate that also blocked this would make local platform development impossible.
  const env = {
    ...process.env,
    GREENROOM_MODE: "platform",
    GREENROOM_DB_PATH: `/tmp/gr-deploy-gates-loopback-${process.pid}.db`,
    PORT: String(PORT + 1),
    HOST: "127.0.0.1",
  } as Record<string, string>;
  delete (env as any).ALLOWED_HOSTS;
  delete (env as any).BETTER_AUTH_SECRET;
  delete (env as any).SECRET_KEY;
  delete (env as any).BETTER_AUTH_URL;
  const proc = Bun.spawn(["bun", SERVER], { cwd: "/tmp", env, stdout: "pipe", stderr: "pipe" });
  let booted = false;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT + 1}/login`, { redirect: "manual" });
      if (r.status === 200) { booted = true; break; }
    } catch { /* not up yet */ }
    await Bun.sleep(250);
  }
  proc.kill();
  await proc.exited;
  rmSync(`/tmp/gr-deploy-gates-loopback-${process.pid}.db`, { force: true });
  rmSync(`/tmp/gr-deploy-gates-loopback-${process.pid}.db-wal`, { force: true });
  rmSync(`/tmp/gr-deploy-gates-loopback-${process.pid}.db-shm`, { force: true });
  expect(booted).toBe(true);
});

// ------------------------------- B + C. against one booted, validly-configured deployed instance

let proc: Subprocess;

beforeAll(async () => {
  proc = Bun.spawn(["bun", SERVER], { cwd: "/tmp", env: deployedEnv(), stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/login`, { redirect: "manual" });
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await Bun.sleep(250);
  }
  throw new Error("deployed-mode test server did not become ready");
});

afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
});

/** Minimal HTTP/1.1 GET with a caller-chosen Host header (fetch forbids setting Host). */
async function rawGet(path: string, host: string): Promise<{ status: number; raw: string }> {
  const chunks: Uint8Array[] = [];
  let finish!: () => void;
  const closed = new Promise<void>((r) => { finish = r; });
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: PORT,
    socket: {
      data: (_s, d) => { chunks.push(d); },
      close: () => finish(),
      error: () => finish(),
    },
  });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  await closed;
  const raw = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  return { status: Number(raw.slice(9, 12)), raw };
}

test("B1: the configured hostname is served (302 to /login — reached the session gate)", async () => {
  const { status } = await rawGet("/run", HOSTNAME);
  expect(status).toBe(302);
});

test("B2: an unlisted Host is refused 403 before anything else runs (DNS-rebinding / wrong vhost)", async () => {
  const { status, raw } = await rawGet("/run", "evil.example");
  expect(status).toBe(403);
  expect(raw).toContain("Forbidden");
});

test("B3: an EMPTY Host is refused on a deployed instance (a real proxy always sets one)", async () => {
  // This is the inversion that only exists when deployed: in the local edition an empty Host is
  // deliberately tolerated (lib/guard.ts:52). Here it must not be, or the loopback allowance
  // becomes a blanket bypass for anything that simply omits the header.
  const { status } = await rawGet("/run", "");
  expect(status).toBe(403);
});

test("B4: the wildcard bind address 0.0.0.0 is refused as a Host, despite reading as loopback", async () => {
  // isLoopbackHost() treats 0.0.0.0 as loopback for anti-DNS-rebinding purposes; isAllowedHost()
  // must NOT inherit that on a deployed instance.
  const { status } = await rawGet("/run", "0.0.0.0");
  expect(status).toBe(403);
});

test("B5: genuine loopback still reaches the app (so a proxy on the same box works)", async () => {
  const { status } = await rawGet("/run", `127.0.0.1:${PORT}`);
  expect(status).toBe(302);
});

// ------------------------------------------------------------------ C. rate limiting

/** Fire n sign-in attempts with junk credentials from one apparent client IP. Bad credentials still
 *  consume the limiter budget, which is the point — this is the brute-force path. */
async function signInBurst(n: number, xff?: string): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `https://${HOSTNAME}`,
        ...(xff ? { "X-Forwarded-For": xff } : {}),
      },
      body: JSON.stringify({ email: `nobody${i}@example.com`, password: "wrong-password-here" }),
    });
    codes.push(r.status);
  }
  return codes;
}

test("C1: repeated sign-in attempts from one client hit the 10/min limit (credential brute-force)", async () => {
  const codes = await signInBurst(14, "203.0.113.10");
  expect(codes).toContain(429);
  // Not everything is throttled — the limit is 10/min, so the early attempts must get through
  // (a limiter that 429s from request #1 would lock real users out).
  expect(codes.filter((c) => c !== 429).length).toBeGreaterThan(0);
});

test("C2: a different client IP gets its own budget (per-client bucketing via x-forwarded-for)", async () => {
  // Exhaust one IP...
  await signInBurst(14, "203.0.113.20");
  // ...a different IP must still be served. If x-forwarded-for were ignored, every client would
  // share the proxy's single connection bucket and one noisy user would lock out the company.
  const fresh = await signInBurst(1, "198.51.100.7");
  expect(fresh[0]).not.toBe(429);
});

test("C3: KNOWN LIMITATION — the rate limit covers /api/auth/* only, not the whole app", async () => {
  // auth/index.ts configures better-auth's own limiter, so it guards better-auth's routes. DEPLOY.md
  // describes it as "120 req/min global", which reads as app-wide; it is not. This test pins the
  // ACTUAL behaviour so the gap is visible and a future app-wide limiter has a failing test to flip.
  const codes: number[] = [];
  for (let i = 0; i < 140; i++) {
    const r = await fetch(`${BASE}/api/state`, { redirect: "manual" });
    codes.push(r.status);
  }
  expect(codes).not.toContain(429); // documents reality, not an endorsement
});
