// lib/recorder.ts — record-a-test flow (pre-auth + codegen + spec post-processing).
// Ported from interface/server.js lines 341-391 (spec post-processing helpers),
// 495-522 (preAuth) and 524-619 (startRecording).
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { resolveLoginForm, baseURLof, DEFAULT_LOGIN_FORM, envNames } from "./envs.ts";
import { resolveCred } from "./creds.ts";
import { loadRolesRaw } from "./roles.ts";
import { injectLogin } from "./adapt.ts";
import { setTestRole } from "./tests-lib.ts";
import { recordingState, pushRecordingOutput, broadcastGlobal, publicState, getActiveRun } from "./run-stream.ts";
import { ROOT, IS_DEMO, denyInDemo } from "./paths.ts";

export interface RecordResult {
  ok: boolean;
  error?: string;
  demo?: boolean;
  out?: string;
}

// Rewrite a freshly-recorded codegen spec so login is AUTOMATED at run time: point the import at
// our fixtures (adds capture + the `login` fixture), and inject `await login('<role>')` as the
// first action of the test. A thin wrapper over lib/adapt.ts's injectLogin — the same transform
// the Tests page's "Login" action runs on an imported spec — so there is exactly one
// implementation of "wire a role's login into a spec" rather than two that can drift apart.
function injectLoginIntoSpec(absPath: string, role: string): boolean {
  try {
    const before = readFileSync(absPath, "utf8");
    const rel = relative(ROOT, absPath).split(sep).join("/");
    const result = injectLogin(before, rel, role);
    if (result.changed) writeFileSync(absPath, result.code);
    return result.changed;
  } catch {
    return false;
  }
}

// Clean a freshly recorded codegen spec:
//  - drop the `test.use({ storageState: '…' })` block codegen injects when we
//    recorded with --load-storage. That temp session file is deleted after
//    recording (it only authenticated the recorder); login() re-auths at run
//    time. Leaving it makes the test fail loading a missing file.
//  - rewrite absolute URLs that point at this env's baseURL back to relative
//    paths, so the spec stays environment-agnostic and no real host is committed.
function cleanRecordedSpec(absPath: string, baseURL: string | null | undefined): void {
  try {
    let s = readFileSync(absPath, "utf8");
    const before = s;
    s = s.replace(/\n?\s*test\.use\(\{[^}]*storageState[^}]*\}\);?/g, "");
    if (baseURL) {
      const b = baseURL.replace(/\/+$/, "");
      const escd = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // '<baseURL>/path' → '/path' ; bare '<baseURL>' → '/'
      s = s.replace(new RegExp(`(['"\`])${escd}(/[^'"\`]*)?\\1`, "g"), (_m, q, p) => `${q}${p || "/"}${q}`);
    }
    if (s !== before) writeFileSync(absPath, s);
  } catch {
    /* best effort — a hand-editable spec is still produced */
  }
}

// Log in headlessly and save the browser session, so the recorder can open
// ALREADY authenticated — the user records their real flow without ever seeing
// the login screen or typing credentials into the recording. Returns the
// storageState file path, or an error the caller surfaces (recording then falls
// back to opening logged-out). Generic: driven entirely by the env's login-form
// config + .env, never app-specific code.
async function preAuth(env: string, role: string): Promise<{ ok: boolean; error?: string; file?: string }> {
  const cred = resolveCred(env, role);
  if (!cred) return { ok: false, error: `no saved login for "${role}" on "${env}"` };
  const base = baseURLof(env);
  if (!base) return { ok: false, error: `no baseURL for "${env}"` };
  const form = resolveLoginForm(env);
  let browser;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ baseURL: base });
    const page = await ctx.newPage();
    await page.goto(form.path);
    await page.locator(form.username).fill(cred.username);
    await page.locator(form.password).fill(cred.password);
    await page.getByRole("button", { name: form.submit }).click();
    // Wait until we've left the login path (same heuristic as auth.ts login()).
    const loginPath = new URL(form.path || "/", "http://x").pathname;
    await page.waitForFunction((lp) => new URL(location.href).pathname !== lp, loginPath, { timeout: 20000 });
    const file = join(tmpdir(), `gr-auth-${env}-${Date.now()}.json`);
    await ctx.storageState({ path: file });
    return { ok: true, file };
  } catch (err: any) {
    return { ok: false, error: String(err.message || err).split("\n")[0] };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export async function startRecording(env: string, name: string, role?: string): Promise<RecordResult> {
  if (IS_DEMO) return denyInDemo;
  // P5 Gate E (plans/platform.md §10): recording launches `playwright codegen` — a REAL browser
  // window on the machine running the server. That only makes sense locally; a deployed instance
  // is headless (no screen), so refuse with a clear pointer instead of spawning a doomed codegen.
  // ALLOWED_HOSTS is the deploy signal (see DEPLOY.md / lib/guard.ts). Recording stays an
  // exclusive, LOCAL-ONLY action — never a queued run.
  if (process.env.ALLOWED_HOSTS) {
    return { ok: false, error: "Recording opens a real browser on the server host — unavailable on a deployed instance (no screen). Record locally with greenroom, or author/edit specs in the in-browser editor (/editor)." };
  }
  // Gate B: recording is still exclusive with a real run — the run map replaced the shared
  // singleton, so that check now needs its own lookup alongside recordingState's own guard.
  if (recordingState.proc || recordingState.recording || getActiveRun()) {
    return { ok: false, error: "A run is in progress — finish it first." };
  }
  if (!envNames().includes(env)) return { ok: false, error: `Unknown environment "${env}".` };
  const roleName = role ? String(role).trim() : "";
  if (roleName && !loadRolesRaw()[roleName]) return { ok: false, error: `Unknown role "${roleName}".` };

  const safe = String(name || "").trim().replace(/[^a-zA-Z0-9-]/g, "-") || "recorded";
  const out = `tests/${safe}.spec.ts`;
  const url = baseURLof(env);

  recordingState.status = "running";
  recordingState.recording = true; // guards a second start during the async pre-auth window (before recordingState.proc is set)
  recordingState.env = env;
  recordingState.envs = [env]; // don't leave the previous run's env list advertised while recording
  recordingState.lines = [];
  broadcastGlobal("started", publicState());
  const say = (line: string) => pushRecordingOutput(line);

  // Pre-authenticate so the recorder opens already logged in — driven by the
  // env's login-form config + .env, so it's generic for any app.
  let storageFile: string | null = null;
  if (roleName) {
    say(`Signing in as "${roleName}" so the recorder opens already logged in…`);
    const pre = await preAuth(env, roleName);
    // recordingState.status is read through a widening cast: stopRun() can flip it to "stopped" during the
    // awaited preAuth above, which TS's control-flow can't see (it still thinks it's "running").
    if ((recordingState.status as string) === "stopped") {
      // user cancelled during pre-auth
      recordingState.recording = false;
      recordingState.status = "idle";
      say("Recording cancelled.");
      broadcastGlobal("done", publicState());
      return { ok: true, out };
    }
    if (pre.ok) {
      storageFile = pre.file as string;
      say("Signed in — opening the recorder already logged in.");
    } else {
      say(
        `Couldn't pre-authenticate (${pre.error}). The recorder will open logged out — check the login form in Settings → Environments, or log in by hand and delete the recorded login lines afterward.`,
      );
    }
  }
  say(`Opening a browser to record "${out}" against ${url}…`);
  say("Click through the site, then close the browser to save.");

  const args = ["playwright", "codegen", "--target", "playwright-test", "-o", out];
  if (storageFile) args.push(`--load-storage=${storageFile}`);
  args.push(url as string);
  const proc = spawn("npx", args, {
    cwd: ROOT,
    detached: process.platform !== "win32",
    env: { ...process.env, TEST_ENV: env },
  });
  recordingState.proc = proc;
  recordingState.recording = false;
  let settled = false;
  const cleanupStorage = () => {
    if (storageFile) {
      try {
        rmSync(storageFile, { force: true });
      } catch {
        /* already gone */
      }
    }
  };
  proc.stdout?.on("data", pushRecordingOutput);
  proc.stderr?.on("data", pushRecordingOutput);
  proc.on("error", (err) => {
    if (settled) return;
    settled = true;
    recordingState.proc = null;
    recordingState.recording = false;
    recordingState.status = "idle";
    cleanupStorage();
    pushRecordingOutput(`\nCouldn't open the recorder: ${err.message}\nIs Node/npx on your PATH? Try launching the app from a terminal.`);
    broadcastGlobal("done", publicState());
  });
  proc.on("close", () => {
    if (settled) return;
    settled = true;
    recordingState.proc = null;
    recordingState.recording = false;
    cleanupStorage(); // the pre-auth session was only for the recorder — the saved spec logs in fresh via login()
    // If the user hit Stop, don't post-process a half-written spec — just cancel.
    const aborted = recordingState.status === "stopped";
    recordingState.status = "idle";
    if (aborted) {
      pushRecordingOutput("\nRecording cancelled.");
      broadcastGlobal("done", publicState());
      return;
    }
    // Always: strip the ephemeral pre-auth storageState block + relativize URLs.
    cleanRecordedSpec(join(ROOT, out), url);
    if (roleName) {
      const injected = injectLoginIntoSpec(join(ROOT, out), roleName);
      setTestRole(out, roleName);
      pushRecordingOutput(
        injected
          ? `\nAdded automatic login as "${roleName}".`
          : `\nCouldn't auto-insert login — add \`await login('${roleName}')\` at the top by hand.`,
      );
    }
    pushRecordingOutput(`\nSaved: ${out}\nRun it from the list above.`);
    broadcastGlobal("done", publicState());
  });
  return { ok: true, out };
}
