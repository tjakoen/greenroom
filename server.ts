// greenroom/server.ts — the BREAD composition root: the ONE place BATCH + GRAIN + MILL + PROOF
// and greenroom's own domain meet, mirroring tjakoen.github.io/server.ts.
//
// STATUS: Phase 1 (PLAN.md §4, P1) — composition root serving the EXISTING interface/ SPA. The
// whole domain of interface/server.js is ported into lib/*.ts and wired here: every /api/* route,
// the run-output SSE (lib/run-stream.ts), byte-preserving binary/Range static for report/runs/
// images/zips (lib/binary.ts), the local-only security guards (lib/guard.ts), PROOF /plans and
// MILL /guide,/context. The old interface/server.js is kept as the live app until cutover (P6);
// `start` flips to this file at the end of P1 verification. Frontend rebuild in GRAIN is P2–P5.
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { createMillRoutes, dirSource } from "@tjakoen/mill/serve.ts";
import type { ContentSource } from "@tjakoen/mill/serve.ts";
import { createProofRoutes } from "@tjakoen/proof/routes.ts";

import { guardRequest } from "./lib/guard.ts";
import { serveFileRanged, safeResolve, mimeOf } from "./lib/binary.ts";
import { ROOT, PORT, readFileMaybe } from "./lib/paths.ts";
import { state, publicState, runStream } from "./lib/run-stream.ts";
import {
  loadUrls, envNames, sanitizeLoginForm, saveEnv, saveSharedLogin, deleteEnv,
} from "./lib/envs.ts";
import { credRoles, saveCred, ENV_FILE } from "./lib/creds.ts";
import { rolesWithStatus, saveRole, deleteRole } from "./lib/roles.ts";
import { listGroups, saveGroup, deleteGroup } from "./lib/groups.ts";
import {
  listTests, deleteTest, renameTest, saveMeta, saveTags, readResults,
  specFiles, recordedInputs, applyInputs,
} from "./lib/tests-lib.ts";
import { listRuns, collectRecords, findRecord } from "./lib/records.ts";
import { startRun, stopRun, killProc } from "./lib/runner.ts";
import { startRecording } from "./lib/recorder.ts";
import { bugSummaryMd, buildBugBundle } from "./lib/bundle.ts";
import { buildPdf } from "./lib/pdf.ts";
import { resolveFfmpeg, clipStream } from "./lib/ffmpeg.ts";

const HERE = import.meta.dir;
const INTERFACE = join(HERE, "interface");
const REPORT_DIR = join(ROOT, "playwright-report");
const RUNS_DIR = existsSync(join(ROOT, "demo", "runs")) && Bun.env.GREENROOM_DEMO === "1"
  ? join(ROOT, "demo", "runs")
  : join(ROOT, "runs");

// Minimal P1 page chrome for the NEW human routes (PROOF/MILL) — a bare valid document. The GRAIN
// app shell wraps these in P2; kept plain here so the mounts verify in isolation. The old SPA at
// "/" is served as-is from interface/index.html.
function minimalPage(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>` +
    `<body>${body}</body></html>`;
}

// --- PROOF: greenroom renders its OWN plans/ folder as a board at /plans. ---
const proofRoutes = createProofRoutes({
  plansDir: join(HERE, "plans"),
  prefix: "/plans",
  chrome: (title, body) => minimalPage(`${title} · Plans`, `<div class="board">${body}</div>`),
});

// --- MILL: user guide (USER-GUIDE.md) at /guide, app-under-test context docs at /context. ---
const guideSource: ContentSource = {
  list: async () => ["user-guide"],
  read: async (slug) => (slug === "user-guide" ? await Bun.file(join(HERE, "USER-GUIDE.md")).text() : null),
};
const millRoutes = createMillRoutes({
  chrome: ({ title, body }) => minimalPage(title, body),
  collections: [
    { prefix: "/guide", title: "User guide", source: guideSource },
    { prefix: "/context", title: "App-under-test context", source: dirSource(join(HERE, "context")) },
  ],
});

// ---------------------------------------------------------------------- helpers
/** Parse a JSON request body, or {} on empty/invalid (mirrors server.js readBody). */
async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

const json = (data: unknown, status = 200): Response => Response.json(data as any, { status });
// A result object whose truthy `.ok` maps to 200 and falsy to `bad` (400/409) — the app's convention.
const okOr = (result: { ok?: boolean }, bad = 400): Response =>
  json(result, result && result.ok ? 200 : bad);

/** Serve a file byte-preserving (Bun.file), 404 when missing. Non-ranged sibling of serveFileRanged
 *  for html/js/css/png where Range isn't needed. */
async function serveStatic(absPath: string): Promise<Response> {
  const file = Bun.file(absPath);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, { headers: { "Content-Type": mimeOf(absPath) } });
}

// The onboarding hint state — composes across creds/records/tests, so it lives at the root that
// imports them all (server.js onboardingState, 1385-1392).
function onboardingState() {
  return {
    envFileExists: existsSync(ENV_FILE),
    anyCreds: credRoles().some((c: any) => c.usernameSet && c.passwordSet),
    hasRuns: listRuns().length > 0,
    reportExists: existsSync(join(REPORT_DIR, "index.html")),
    testCount: specFiles().length,
  };
}

const slug = (s: unknown, fallback: string): string =>
  (String(s || fallback)).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || fallback;

// ------------------------------------------------------------------- dispatch
async function handle(req: Request): Promise<Response> {
  const denied = guardRequest(req);
  if (denied) return denied;

  const url = new URL(req.url);
  let p = url.pathname;
  const method = req.method.toUpperCase();
  const qp = url.searchParams;

  // The single-doc guide is served at /guide by MILL (which lists it as /guide/user-guide).
  const millPath = p === "/guide" ? "/guide/user-guide" : p;
  const fromProof = await proofRoutes(p);
  if (fromProof) return fromProof;
  const fromMill = await millRoutes(millPath);
  if (fromMill) return fromMill;

  // ---- the old SPA + its assets (frozen in P1; GRAIN pages replace them P2-P6) ----
  if (p === "/" || p === "/index.html") return serveStatic(join(INTERFACE, "index.html"));
  if (p === "/app.js" || p === "/styles.css") return serveStatic(join(INTERFACE, p.slice(1)));

  // ---- status + run control ----
  if (p === "/api/state") return json(publicState());

  if (p === "/api/envs") {
    if (method === "GET") {
      const u = loadUrls();
      // Each env carries its OWN login block (empty = inherits the shared one), plus `_login`.
      // Selectors aren't secrets, so they're returned for the Environments panel to show + edit.
      const envs = envNames().map((n) => ({ name: n, baseURL: u[n].baseURL, login: sanitizeLoginForm(u[n] && u[n].login) }));
      return json({ envs, sharedLogin: sanitizeLoginForm(u._login) });
    }
    if (method === "POST") {
      const body = await readBody(req);
      const result = body && body.shared
        ? saveSharedLogin(body.login)
        : saveEnv(String((body && body.name) || "").trim(), String((body && body.baseURL) || "").trim(), body ? body.login : undefined);
      return okOr(result);
    }
    if (method === "DELETE") return okOr(deleteEnv(String(qp.get("name") || "")));
  }

  if (p === "/api/run" && method === "POST") {
    const { env, envs, light, files, grep, role } = await readBody(req);
    // Accept either `envs` (array — multi-env) or `env` (string — single).
    return okOr(startRun(envs != null ? envs : env, light, files, grep, role), 409);
  }
  if (p === "/api/stop" && method === "POST") return okOr(stopRun(), 409);
  if (p === "/api/record" && method === "POST") {
    const { env, name, role } = await readBody(req);
    return okOr(await startRecording(env, name, role), 409);
  }

  // ---- dynamic test data ----
  if (p === "/api/recorded-inputs" && method === "GET") return okOr(recordedInputs(String(qp.get("file") || "")));
  if (p === "/api/apply-inputs" && method === "POST") {
    const { file, mappings } = await readBody(req);
    return okOr(applyInputs(file, mappings));
  }

  // ---- live run output (SSE, replay-on-connect) ----
  if (p === "/api/stream") return runStream();

  if (p === "/api/runs") return json(listRuns());

  // ---- snapshots / PDF / video ----
  if (p === "/api/pdf-data") {
    const run = qp.get("run") || "latest";
    const data = collectRecords(run).map(({ test, record }: any) => ({
      test, title: record.title, status: record.status, env: record.env, hasVideo: !!record.videoFile,
      snapshots: (record.snapshots || []).map((s: any) => ({
        index: s.index, t: typeof s.t === "number" ? s.t : null, title: s.title, url: s.url, final: !!s.final,
      })),
    }));
    return json(data);
  }
  if (p === "/api/pdf-image") {
    const found = findRecord(qp.get("run") || "latest", qp.get("test"));
    const snap = found?.record.snapshots[Number(qp.get("i"))];
    if (!snap || !existsSync(snap.file)) return new Response("Not found", { status: 404 });
    return serveStatic(snap.file);
  }
  if (p === "/api/moment") {
    const found = findRecord(qp.get("run") || "latest", qp.get("test"));
    if (!found) return json({ error: "Not found" }, 404);
    const r = found.record;
    return json({
      durationMs: r.durationMs || 0,
      consoleTimed: r.consoleTimed || [], networkTimed: r.networkTimed || [], requests: r.requests || [],
      console: r.console || [], network: r.network || [],
    });
  }
  if (p === "/api/video") {
    const found = findRecord(qp.get("run") || "latest", qp.get("test"));
    if (!found?.record.videoFile || !existsSync(found.record.videoFile)) return new Response("No video", { status: 404 });
    const res = await serveFileRanged(req, found.record.videoFile, "video/webm");
    if (qp.get("download")) res.headers.set("Content-Disposition", `attachment; filename="${slug(found.record.title, "recording")}.webm"`);
    return res;
  }
  if (p === "/api/ffmpeg-available") return json({ available: !!resolveFfmpeg() });
  if (p === "/api/video-clip") {
    const found = findRecord(qp.get("run") || "latest", qp.get("test"));
    const from = Number(qp.get("from")), to = Number(qp.get("to"));
    if (!found?.record.videoFile || !existsSync(found.record.videoFile)) return new Response("No video", { status: 404 });
    if (!isFinite(from) || !isFinite(to) || to <= from) return new Response("Invalid clip range", { status: 400 });
    if (!resolveFfmpeg()) return new Response("ffmpeg not available — install ffmpeg, or download the full recording instead.", { status: 501, headers: { "Content-Type": "text/plain" } });
    return new Response(clipStream(found.record.videoFile, from, to), {
      headers: { "Content-Type": "video/webm", "Content-Disposition": `attachment; filename="${slug(found.record.title, "clip")}-${from.toFixed(1)}s-${to.toFixed(1)}s.webm"` },
    });
  }
  if (p === "/api/pdf" && method === "POST") {
    const { run = "latest", test, i = 0, from, to } = await readBody(req);
    const found = findRecord(run, test);
    if (!found) return json({ ok: false, error: "Snapshot data not found." }, 404);
    try {
      const pdf = await buildPdf(found.record, Number(i), {
        from: typeof from === "number" ? from : undefined,
        to: typeof to === "number" ? to : undefined,
      });
      return new Response(pdf as any, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${slug(found.record.title, "report")}.pdf"` } });
    } catch (err: any) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // ---- test library ----
  if (p === "/api/tests") {
    if (method === "GET") return json(listTests());
    if (method === "DELETE") return okOr(deleteTest(String(qp.get("file") || "")));
  }
  if (p === "/api/tests/rename" && method === "POST") {
    const { file, name } = await readBody(req);
    return okOr(renameTest(file, name));
  }
  if (p === "/api/test-meta" && method === "POST") {
    const { file, title, group, priority, owner, notes } = await readBody(req);
    return okOr(saveMeta(file, title, { group, priority, owner, notes }));
  }
  if (p === "/api/test-tags" && method === "POST") {
    const { file, title, tags } = await readBody(req);
    return okOr(saveTags(file, title, tags));
  }
  if (p === "/api/results") return json(readResults(qp.get("run") || "latest"));

  // ---- credentials / roles / groups ----
  if (p === "/api/creds") {
    if (method === "GET") return json(credRoles());
    if (method === "POST") return okOr(saveCred(await readBody(req)));
  }
  if (p === "/api/roles") {
    if (method === "GET") return json(rolesWithStatus());
    if (method === "POST") return okOr(saveRole(await readBody(req)));
    if (method === "DELETE") return okOr(deleteRole(String(qp.get("name") || "")));
  }
  if (p === "/api/groups") {
    if (method === "GET") return json(listGroups());
    if (method === "POST") return okOr(saveGroup(await readBody(req)));
    if (method === "DELETE") return okOr(deleteGroup(String(qp.get("name") || "")));
  }

  // ---- bug report ----
  if (p === "/api/bug-summary") {
    const found = findRecord(qp.get("run") || "latest", qp.get("test"));
    if (!found) return json({ ok: false, error: "Test not found." }, 404);
    return new Response(bugSummaryMd(found.record, qp.get("run") || "latest"), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
  }
  if (p === "/api/bug-bundle") {
    const test = qp.get("test");
    const bundle = buildBugBundle(qp.get("run") || "latest", test);
    if (!bundle) return new Response("Test not found", { status: 404 });
    const safe = (bundle.record.env || "run") + "-" + basename(String(test || "test")).replace(/[^a-z0-9]+/gi, "-").slice(0, 50);
    return new Response(bundle.zip as any, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="bug-${safe}.zip"` } });
  }

  // ---- guide + onboarding (the SPA's own raw endpoints; MILL /guide is a separate human route) ----
  if (p === "/api/guide") {
    const md = readFileMaybe(join(ROOT, "USER-GUIDE.md"));
    return new Response(md || "# Guide\n\nUSER-GUIDE.md is missing.", { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
  }
  if (p === "/api/onboarding") return json(onboardingState());

  // ---- archived reports + run artifacts (byte-preserving static, traversal-guarded) ----
  if (p.startsWith("/report")) {
    const rel = p === "/report" || p === "/report/" ? "index.html" : p.slice("/report/".length);
    const target = safeResolve(REPORT_DIR, decodeURIComponent(rel));
    if (!target) return new Response("Forbidden", { status: 403 });
    return serveStatic(target);
  }
  if (p.startsWith("/runs/")) {
    let rel = decodeURIComponent(p.slice("/runs/".length));
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    if (!rel.includes("/")) rel += "/index.html";
    const target = safeResolve(RUNS_DIR, rel);
    if (!target) return new Response("Forbidden", { status: 403 });
    return serveStatic(target);
  }

  return new Response("Not found", { status: 404 });
}

// ---------------------------------------------------------------------- serve
try {
  Bun.serve({
    port: PORT,
    hostname: "127.0.0.1", // loopback only — this is a local app; never expose it to the LAN.
    // Wrap every request so one thrown error returns a 500 instead of taking the server down — a
    // silently dead page is the worst failure mode for a non-coder.
    async fetch(req) {
      try {
        return await handle(req);
      } catch (err: any) {
        console.error("Request error:", err);
        return json({ ok: false, error: "Server error: " + (err?.message ?? String(err)) }, 500);
      }
    },
  });
  console.log(`Test interface ready → http://localhost:${PORT}  [BATCH·GRAIN·MILL·PROOF composition root]`);
} catch (err: any) {
  if (err?.code === "EADDRINUSE" || /in use|EADDRINUSE/i.test(String(err?.message))) {
    // Don't blindly assume it's us — another app on this port would otherwise make the VS Code
    // task open the browser onto the wrong app silently. Probe /api/state for our demo boolean.
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(1500) });
      const ours = typeof (await r.json()).demo === "boolean";
      if (ours) {
        console.log(`Greenroom is already running → http://localhost:${PORT}`);
        process.exit(0);
      }
    } catch {
      /* not JSON / unreachable → not us */
    }
    console.error(`Port ${PORT} is in use by another app. Set a different port and retry, e.g. PORT=4322 bun start`);
    process.exit(1);
  }
  throw err;
}

// Kill any in-flight run/recording so exiting doesn't orphan a detached Playwright process group.
function shutdown() {
  if (state.proc) {
    try {
      killProc(state.proc);
    } catch {
      /* best effort */
    }
  }
}
process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
process.on("exit", shutdown);
