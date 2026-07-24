// greenroom/server.ts — the BREAD composition root: the ONE place BATCH + GRAIN + MILL + PROOF
// and greenroom's own domain meet, mirroring tjakoen.github.io/server.ts.
//
// STATUS: Phase 2 (PLAN.md §4, P2) — GRAIN shell + Guide + Settings. P1 ported the whole domain
// of interface/server.js into lib/*.ts and wired every /api/* route, the run-output SSE
// (lib/run-stream.ts), byte-preserving binary/Range static for report/runs/images/zips
// (lib/binary.ts), the local-only security guards (lib/guard.ts), PROOF /plans and MILL
// /guide,/context (both with a placeholder chrome). P2 replaces that placeholder with a real
// GRAIN app-shell page (grainPage below), serves GRAIN's styles/scripts/component-CSS/catalog,
// and adds /settings — server-rendered grain forms over the UNCHANGED /api/{envs,roles,creds,
// groups} endpoints. P3 adds /tests the same way, over the unchanged tests-lib.ts endpoints,
// using the new grain chip-group + b-select components. The old interface/ SPA at "/" (and its
// hash routes) is kept byte-identical until cutover (P6). Frontend rebuild in GRAIN continues
// P4–P5 (Run/History pages).
import { join, basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bunRuntime } from "@tjakoen/batch/platform/bun-runtime.ts";
import { makeStatic } from "@tjakoen/batch/http/static.ts";
import { createStyleBundle } from "@tjakoen/batch/assets/style-bundle.ts";
import { createMillRoutes, dirSource } from "@tjakoen/mill/serve.ts";
import type { ContentSource } from "@tjakoen/mill/serve.ts";
import { escapeHtml } from "@tjakoen/mill/core/engine.ts";
import { createProofRoutes } from "@tjakoen/proof/routes.ts";
import { createCatalog } from "@tjakoen/grain/catalog/catalog.ts";

import { guardRequest } from "./lib/guard.ts";
import { serveFileRanged, safeResolve, mimeOf } from "./lib/binary.ts";
import { ROOT, PORT, IS_DEMO, readFileMaybe, denyInDemo } from "./lib/paths.ts";
import { runAppMigrations } from "./db/index.ts";
import { auth, runAuthMigrations, getSessionUser } from "./auth/index.ts";
import { ensureDefaultOrg } from "./auth/bootstrap.ts";
import { publicState, runStream, allRunHandles, recordingState } from "./lib/run-stream.ts";
import {
  loadUrls, envNames, sanitizeLoginForm, saveEnv, saveSharedLogin, deleteEnv,
} from "./lib/envs.ts";
import { credRoles, saveCred, ENV_FILE } from "./lib/creds.ts";
import { rolesWithStatus, saveRole, deleteRole, seedRoles } from "./lib/roles.ts";
import { listGroups, saveGroup, deleteGroup } from "./lib/groups.ts";
import {
  listTests, deleteTest, renameTest, saveMeta, saveTags, readResults,
  specFiles, recordedInputs, applyInputs,
} from "./lib/tests-lib.ts";
import { listRuns, collectRecords, findRecord } from "./lib/records.ts";
import { stopRun as stopLegacy, killProc } from "./lib/runner.ts";
import { enqueueRun, stopRun as stopQueuedRun, reconcileOnBoot, tick as tickQueue, listQueue } from "./lib/run-queue.ts";
import { startRecording } from "./lib/recorder.ts";
import { bugSummaryMd, buildBugBundle } from "./lib/bundle.ts";
import { buildPdf } from "./lib/pdf.ts";
import { resolveFfmpeg, clipStream } from "./lib/ffmpeg.ts";
import { settingsBody } from "./pages/settings-page.ts";
import { loginBody } from "./pages/login-page.ts";
import { testsBody } from "./pages/tests-page.ts";
import { runBody } from "./pages/run-page.ts";
import { historyBody } from "./pages/history-page.ts";
import { reportBugBody } from "./pages/report-bug-page.ts";
// ---- P2 platform pages + scoped/audited API handlers (wired below) ----
import { adminApi } from "./pages/admin-api.ts";
import { adminBody } from "./pages/admin-page.ts";
import { accountsApi } from "./pages/accounts-api.ts";
import { accountsBody } from "./pages/accounts-page.ts";
import { environmentsApi } from "./pages/environments-api.ts";
import { environmentsBody } from "./pages/environments-page.ts";
import { editorApi } from "./pages/editor-api.ts";
import { editorBody } from "./pages/editor-page.ts";

const HERE = import.meta.dir;
const INTERFACE = join(HERE, "interface");
const RUNS_DIR = existsSync(join(ROOT, "demo", "runs")) && Bun.env.GREENROOM_DEMO === "1"
  ? join(ROOT, "demo", "runs")
  : join(ROOT, "runs");
// Gate A (plans/platform.md §6): there's no more shared ROOT/playwright-report — each run writes
// straight to its own runs/.live/<id> dir and gets renamed into RUNS_DIR on close (lib/runner.ts,
// lib/records.ts). "/report" (the "open latest report" button) now serves out of the newest
// finished run's own dir.
function latestRunDir(): string | null {
  const runs = listRuns();
  return runs.length ? join(RUNS_DIR, runs[0].id) : null;
}

// ---------------------------------------------------------------- GRAIN shell (P2)
// GRAIN is installed as a git dependency (node_modules/@tjakoen/grain), never a monorepo sibling
// — unlike pantry.ts (which still lives beside grain/ and can use a relative sibling path), so the
// root must resolve as a PACKAGE. grain's package.json exports "./styles/*" but not
// "./package.json" itself, so anchor on a real exported file (styles/variables.css) and walk up
// two dirs (file → styles/ → grain root) rather than the (unexported) package.json shortcut.
const GRAIN_ROOT = dirname(dirname(fileURLToPath(import.meta.resolve("@tjakoen/grain/styles/variables.css"))));

const serveGrainStyles = makeStatic(bunRuntime, join(GRAIN_ROOT, "styles"));
const serveGrainScripts = makeStatic(bunRuntime, join(GRAIN_ROOT, "scripts"));
const serveGrainAssets = makeStatic(bunRuntime, join(GRAIN_ROOT, "assets"));
// grain.css @font-face's the Redaction faces at absolute /fonts/* URLs — serve grain's own
// fonts/ so the shell renders in GRAIN's typeface instead of silently falling back to system
// fonts (pantry omits this and falls back; greenroom serves them).
const serveGrainFonts = makeStatic(bunRuntime, join(GRAIN_ROOT, "fonts"));
const componentCss = createStyleBundle(bunRuntime, join(GRAIN_ROOT, "components"));

// Monaco's classic-AMD self-host assets (P4 editor): served static under /vs/, byte-preserving
// (min/vs ships codicon.ttf — a binary that makeStatic's text-read would corrupt), lazily loaded
// only by the /editor page. Proven in spike/monaco (plans/platform.md §8 verdict). The .ttf/.woff
// types monaco can carry aren't in binary.ts's MIME map, so pass them explicitly here.
const MONACO_VS = join(ROOT, "node_modules", "monaco-editor", "min", "vs");
const VS_MIME: Record<string, string> = { ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2" };
async function serveVs(req: Request, rel: string): Promise<Response> {
  const abs = safeResolve(MONACO_VS, rel === "" || rel === "/" ? "loader.js" : rel);
  if (!abs) return new Response("Forbidden", { status: 403 });
  const ext = abs.slice(abs.lastIndexOf("."));
  return serveFileRanged(req, abs, VS_MIME[ext]);
}

// The rail + ⌘K destinations, in one place so the shell nav and /search.json agree. History/
// Report a bug still point into the frozen old SPA (hash routes) — their own grain page lands
// P5; User guide/Plans/Catalog/Settings/Tests/Run wear the new shell today.
const NAV: Array<{ key: string; label: string; href: string; icon: string; footer?: boolean }> = [
  { key: "run", label: "Run", href: "/run", icon: "loop" },
  { key: "tests", label: "Tests", href: "/tests", icon: "tasks" },
  { key: "editor", label: "Editor", href: "/editor", icon: "files" },
  { key: "history", label: "History", href: "/history", icon: "traces" },
  { key: "bug", label: "Report a bug", href: "/bug", icon: "send" },
  { key: "environments", label: "Environments", href: "/environments", icon: "rules" },
  { key: "accounts", label: "Accounts", href: "/accounts", icon: "pin" },
  { key: "guide", label: "User guide", href: "/guide", icon: "knowledge" },
  { key: "plans", label: "Plans", href: "/plans", icon: "files" },
  { key: "catalog", label: "Catalog", href: "/catalog", icon: "spark" },
  { key: "admin", label: "Admin", href: "/admin", icon: "settings", footer: true },
  { key: "settings", label: "Settings", href: "/settings", icon: "settings", footer: true },
];
// Only the real, single-page destinations belong in the catalog's page-nav / a component search
// index (hash routes into the frozen SPA aren't pages of THIS shell yet).
const SHELL_PAGE_HREFS = NAV.filter((n) => !n.href.includes("#")).map((n) => n.href);

const STYLESHEETS = [
  "/styles/variables.css", "/styles/global.css", "/styles/grain.css", "/styles/cmdk.css",
  "/components.css", "/greenroom.css",
];
const styleLinks = STYLESHEETS.map((h) => `<link rel="stylesheet" href="${h}">`).join("\n  ");

// The catalog builds its OWN shell (it isn't mounted inside grainPage) — give it the same
// stylesheet links so its component previews are styled (pantry.ts does the same).
const catalog = createCatalog(join(GRAIN_ROOT, "components"), () => SHELL_PAGE_HREFS, { headEnd: styleLinks });

function icon(sym: string, size?: "sm" | "lg"): string {
  return `<svg class="icon"${size ? ` data-size="${size}"` : ""} aria-hidden="true" focusable="false">` +
    `<use href="/assets/sprite.svg#${sym}"></use></svg>`;
}

function railNav(active?: string): string {
  const item = (n: (typeof NAV)[number]): string => {
    const current = n.key === active ? ` aria-current="page"` : "";
    return `<a class="nav-item" href="${escapeHtml(n.href)}"${current}>${icon(n.icon)}` +
      `<span class="nav-item__label">${escapeHtml(n.label)}</span></a>`;
  };
  const main = NAV.filter((n) => !n.footer).map(item).join("\n    ");
  const footer = NAV.filter((n) => n.footer).map(item).join("\n    ");
  return `${main}\n    <div class="side-rail__spacer"></div>\n    ${footer}`;
}

// The GRAIN app-shell page wrapper — replaces P1's minimalPage for every new human route
// (PROOF /plans, MILL /guide + /context, and /settings). The old SPA at "/" is untouched (it
// ships its own <head>/chrome from interface/index.html, never this function).
//   - theme-boot.js is render-blocking in <head>, BEFORE the stylesheets (no FOUC — mirrors
//     saved data-color-scheme/data-theme onto <html> before first paint).
//   - the title bar's `.window-bar__search` is the ⌘K anchor cmdk.js measures + opens from.
//   - shell.js (rail collapse/drawer) + theme.js (toggle wiring) + cmdk.js load deferred after
//     the body, same order pantry.ts uses.
//   - data-aside-hidden="true": P2 ships no assistant pane (the AI door is PG) — collapses the
//     app-shell's reserved aside column to 0 instead of leaving a dead 20rem gap on the right.
function grainPage(title: string, body: string, opts: { active?: string } = {}): string {
  const active = opts.active;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Greenroom</title>
  <script src="/scripts/theme-boot.js"></script>
  ${styleLinks}
</head>
<body class="app-window-backdrop">
  <div class="app-shell app-window" data-aside-hidden="true">
    <header class="app-shell__window window-bar">
      <span class="window-bar__dots"><i></i><i></i><i></i></span>
      <span class="window-bar__ctl">
        <button type="button" class="icon-btn" data-variant="ghost" data-cycle-theme title="Cycle theme" aria-label="Cycle theme">◆</button>
        <button type="button" class="icon-btn" data-variant="ghost" data-toggle-scheme title="Light / dark" aria-label="Light / dark">◐</button>
      </span>
      <button class="window-bar__search" type="button" data-cmdk-open><kbd class="kbd">⌘K</kbd> greenroom › ${escapeHtml(title)}</button>
      <span class="window-bar__end" style="width:6.5rem"></span>
    </header>
    <aside class="app-shell__rail side-rail">
      <div class="side-rail__brand">${icon("spark")}<span>Greenroom</span></div>
      ${railNav(active)}
    </aside>
    <main class="app-shell__main">${body}</main>
    <footer class="app-shell__status status-bar">
      <span class="status-bar__spacer"></span>
      <span class="made-with" data-status-optional>built on GRAIN</span>
    </footer>
  </div>
  <div id="toast" class="gr-toast" role="status" aria-live="polite"></div>
  <script src="/scripts/shell.js" defer></script>
  <script src="/scripts/theme.js" defer></script>
  <script src="/scripts/cmdk.js" defer></script>
</body>
</html>`;
}

// --- PROOF: greenroom renders its OWN plans/ folder as a board at /plans. ---
const proofRoutes = createProofRoutes({
  plansDir: join(HERE, "plans"),
  prefix: "/plans",
  chrome: (title, body) => grainPage(`${title} · Plans`, `<div class="board">${body}</div>`, { active: "plans" }),
});

// --- MILL: user guide (USER-GUIDE.md) at /guide, app-under-test context docs at /context. ---
const guideSource: ContentSource = {
  list: async () => ["user-guide"],
  read: async (slug) => (slug === "user-guide" ? await Bun.file(join(HERE, "USER-GUIDE.md")).text() : null),
};
// USER-GUIDE.md (and each context doc) leads with its OWN `# Title` heading, so MILL's default
// note masthead would re-emit the same title under our chrome and double it. Render the body
// only (same fix pantry.ts uses); the grade guardrail still runs (data-grade="smooth").
const bodyOnlyLayout = ({ body }: { body: string }) => `<article class="note" data-grade="smooth">${body}</article>`;
const millRoutes = createMillRoutes({
  collections: [
    {
      prefix: "/guide", title: "User guide", source: guideSource,
      adapter: { defaultLayout: bodyOnlyLayout },
      chrome: ({ title, body }) => grainPage(title, `<div class="board">${body}</div>`, { active: "guide" }),
    },
    {
      prefix: "/context", title: "App-under-test context", source: dirSource(join(HERE, "context")),
      adapter: { defaultLayout: bodyOnlyLayout },
      chrome: ({ title, body }) => grainPage(title, `<div class="board">${body}</div>`),
    },
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
    reportExists: listRuns().length > 0, // Gate A: "a report" now means the newest run has one
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

  // ---- auth (P1 Gate 2): better-auth owns every /api/auth/* route (sign-up/sign-in/sign-out/
  // get-session/...) — mount it before any other dispatch so it's reachable without a session. ----
  if (p.startsWith("/api/auth")) return auth.handler(req);

  // ---- session gate (P1 Gate 2): every route below this line requires a session EXCEPT this
  // allow-list — /api/auth/* (already handled above), the /login page + its client module, and
  // every static/shell asset (the rail chrome + the legacy SPA at "/" must stay reachable so the
  // browser can even render the /login page). Demo mode is read-only + public — skip the gate
  // entirely so `npm run demo` keeps working with no accounts. ----
  // Resolved once past the gate (non-null for every gated route in non-demo mode); handed to the
  // P2 scoped API handlers below. Null in demo mode (gate skipped) — those handlers 401 on it.
  let user: Awaited<ReturnType<typeof getSessionUser>> = null;
  if (!IS_DEMO) {
    const gateAllowed =
      p === "/login" || p === "/login.js" ||
      p.startsWith("/styles/") || p.startsWith("/scripts/") || p.startsWith("/assets/") || p.startsWith("/fonts/") || p.startsWith("/vs/") ||
      p === "/components.css" || p === "/greenroom.css" || p.startsWith("/favicon") ||
      p === "/" || p === "/index.html" || p === "/app.js" || p === "/styles.css";
    if (!gateAllowed) {
      user = await getSessionUser(req);
      if (!user) {
        // /api/* → 401 JSON (a fetch caller decides what to do); every other route is a page →
        // 302 to /login. Keyed on the path, not the Accept header — real navigations don't
        // reliably send one, and this is the same split the rest of the app already uses (okOr/
        // json vs serveStatic).
        if (p.startsWith("/api/")) return json({ error: "unauthenticated" }, 401);
        return new Response(null, { status: 302, headers: { Location: "/login" } });
      }
    }
  }

  // ---- P2 scoped + audited platform APIs. Each handler owns its own /api/{admin,accounts,
  // environments}/* prefix and returns null to fall through. `user` is the ScopedUser resolved
  // above (canRead/canWrite + superadmin enforced inside each handler). ----
  {
    const ctx = { req, url, p, method, qp, user };
    const p2 = (await adminApi(ctx)) ?? (await accountsApi(ctx)) ?? (await environmentsApi(ctx)) ?? (await editorApi(ctx));
    if (p2) return p2;
  }

  // The single-doc guide is served at /guide by MILL (which lists it as /guide/user-guide).
  const millPath = p === "/guide" ? "/guide/user-guide" : p;
  const fromProof = await proofRoutes(p);
  if (fromProof) return fromProof;
  const fromMill = await millRoutes(millPath);
  if (fromMill) return fromMill;

  // ---- the old SPA + its assets (frozen in P1; GRAIN pages replace them P2-P6) ----
  if (p === "/" || p === "/index.html") return serveStatic(join(INTERFACE, "index.html"));
  if (p === "/app.js" || p === "/styles.css") return serveStatic(join(INTERFACE, p.slice(1)));

  // ---- GRAIN shell assets (P2): styles/scripts/component-CSS/icon sprite + the catalog ----
  const htmlHeaders = { "Content-Type": "text/html; charset=utf-8" };
  if (p.startsWith("/styles/")) return serveGrainStyles(p.slice("/styles".length));
  if (p.startsWith("/scripts/")) return serveGrainScripts(p.slice("/scripts".length));
  if (p.startsWith("/assets/")) return serveGrainAssets(p.slice("/assets".length));
  if (p.startsWith("/fonts/")) return serveGrainFonts(p.slice("/fonts".length));
  if (p.startsWith("/vs/")) return serveVs(req, p.slice("/vs/".length));
  if (p === "/favicon.ico") return new Response(null, { status: 204 });
  if (p === "/components.css") return new Response(await componentCss.css(), { headers: { "Content-Type": "text/css" } });
  if (p === "/greenroom.css") return serveStatic(join(HERE, "pages", "greenroom.css"));
  if (p === "/catalog") return new Response(await catalog.html(), { headers: htmlHeaders });
  if (p === "/search.json") {
    const pages = NAV.map((n) => ({ title: n.label, url: n.href }));
    const components = (await catalog.entries()).map((c) => ({ title: c.name, subtitle: c.layer, url: `/catalog#${c.slug}` }));
    return json({ pages, components });
  }

  // ---- Login (P1 Gate 2): the one page NOT wrapped in grainPage — there's no session yet, so
  // there's nothing to navigate to and no rail to show. loginBody() returns its own complete
  // standalone HTML document (own <head>, own minimal stylesheet set). Not in NAV — it isn't a
  // rail destination. ----
  if (p === "/login") return new Response(loginBody(), { headers: htmlHeaders });
  if (p === "/login.js") return serveStatic(join(HERE, "pages", "login.js"));

  // ---- Settings (P2): server-rendered grain forms over the unchanged /api/{envs,roles,creds,
  // groups} endpoints below — settings.js (a thin client module) does the fetch + re-render. ----
  if (p === "/settings") return new Response(grainPage("Settings", settingsBody(), { active: "settings" }), { headers: htmlHeaders });
  if (p === "/settings.js") return serveStatic(join(HERE, "pages", "settings.js"));

  // ---- P2 platform pages: Environments (DB + dual-write urls.json), Accounts (scoped test-target
  // creds), Admin (superadmin-only user/team management). Client modules fetch the /api handlers
  // dispatched above. ----
  if (p === "/environments") return new Response(grainPage("Environments", environmentsBody(), { active: "environments" }), { headers: htmlHeaders });
  if (p === "/environments.js") return serveStatic(join(HERE, "pages", "environments.js"));
  if (p === "/accounts") return new Response(grainPage("Accounts", accountsBody(), { active: "accounts" }), { headers: htmlHeaders });
  if (p === "/accounts.js") return serveStatic(join(HERE, "pages", "accounts.js"));
  if (p === "/admin") return new Response(grainPage("Admin", adminBody(), { active: "admin" }), { headers: htmlHeaders });
  if (p === "/admin.js") return serveStatic(join(HERE, "pages", "admin.js"));

  // ---- Tests (P3): server-rendered grain chip-group/b-select over the unchanged /api/{tests,
  // recorded-inputs,apply-inputs,test-tags,test-meta,tests/rename,roles,record,state} endpoints
  // below — tests.js (a thin client module) does the fetch + re-render. Run/Run selected/Run by
  // tag hand off to the frozen SPA's Run page (still P4's to migrate) rather than triggering a
  // run from here. ----
  if (p === "/tests") return new Response(grainPage("Tests", testsBody(), { active: "tests" }), { headers: htmlHeaders });
  if (p === "/tests.js") return serveStatic(join(HERE, "pages", "tests.js"));

  // ---- Editor (P4): in-browser Playwright test editing — Monaco (lazy, self-hosted at /vs/)
  // mounted into the grain code-editor organism, over /api/{test-source,test-versions,test-version,
  // validate,tests}. editor.js does the fetch + Monaco wiring; the page skeleton is grain chrome. ----
  if (p === "/editor") return new Response(grainPage("Editor", editorBody(), { active: "editor" }), { headers: htmlHeaders });
  if (p === "/editor.js") return serveStatic(join(HERE, "pages", "editor.js"));

  // ---- Run (P4): server-rendered grain chip-group/stat-tile/b-meter/status-list over the
  // unchanged /api/{run,stop,stream,state,results,tests,roles,groups,creds} endpoints below —
  // run.js (a thin client module) sends the identical /api/run body and consumes the identical
  // /api/stream events interface/app.js does today. ----
  if (p === "/run") return new Response(grainPage("Run", runBody(), { active: "run" }), { headers: htmlHeaders });
  if (p === "/run.js") return serveStatic(join(HERE, "pages", "run.js"));

  // ---- History (P5): server-rendered grain rows over the unchanged /api/{runs,pdf-data}
  // endpoints below — history.js (a thin client module) does the fetch + re-render. "Report this"
  // on a failed run hands off to /bug with the run + first failed test as query params. ----
  if (p === "/history") return new Response(grainPage("History", historyBody(), { active: "history" }), { headers: htmlHeaders });
  if (p === "/history.js") return serveStatic(join(HERE, "pages", "history.js"));

  // ---- Report a bug (P5): server-rendered grain scrubber/summary over the unchanged /api/{runs,
  // pdf-data,moment,bug-summary,pdf-image,video,video-clip,bug-bundle,pdf,ffmpeg-available}
  // endpoints below — bug.js (a thin client module) reproduces the SPA's #/share surface (run/test
  // pickers, screenshot scrubber + windowed moment logs, PDF/clip/bundle export). Reads the
  // preselected run/test from its own URL query (the History "Report this" hand-off). ----
  if (p === "/bug") return new Response(grainPage("Report a bug", reportBugBody(), { active: "bug" }), { headers: htmlHeaders });
  if (p === "/bug.js") return serveStatic(join(HERE, "pages", "bug.js"));

  // ---- status + run control ----
  // Gate B: /api/state?run=<runId> is the new keyed shape (404 if unknown); no `run` param keeps
  // the frozen SPA's compat behaviour — the newest active-or-most-recent run's state, or idle.
  if (p === "/api/state") {
    const run = qp.get("run");
    if (run) {
      const st = publicState(run);
      return st ? json(st) : json({ error: "Unknown run." }, 404);
    }
    return json(publicState());
  }

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
    // P5 Gate D (plans/platform.md §6): every run is now a QUEUED db row, not a direct spawn — the
    // scheduler (lib/run-queue.ts) resolves the DB→child config/credential handoff itself once the
    // row actually gets its turn (its own `resolveScopedUser`, since by then the HTTP request that
    // enqueued it is long gone). Demo mode never enqueues (read-only, no accounts to own a row).
    if (IS_DEMO) return okOr(denyInDemo, 409);
    if (!user) return json({ error: "unauthenticated" }, 401); // belt-and-suspenders — the session gate above already guarantees this outside demo mode
    const { env, envs, light, files, grep, role } = await readBody(req);
    // Accept either `envs` (array — multi-env) or `env` (string — single). Response now carries
    // `runId` (subscribe to /api/stream?run=<runId> immediately — it's live from the moment the run
    // is queued, Gate D) + `position` (0 = starting now; N>0 = N runs ahead of it).
    const envList = (envs != null ? (Array.isArray(envs) ? envs : [envs]) : env ? [env] : [])
      .map((e: unknown) => String(e ?? "").trim())
      .filter(Boolean);
    const { runId, position } = await enqueueRun({ userId: user.id, envs: envList, files, grep, role, light: !!light });
    return json({ ok: true, runId, position });
  }
  // Gate D: /api/queue — every currently queued/running row + its position, for the Run page to
  // poll (or reconcile against the `queued`/`position`/`done` global-channel events it also gets).
  if (p === "/api/queue" && method === "GET") return json({ ok: true, queue: listQueue() });
  // Gate B/D: ?run=<runId> stops that specific run (queued -> never starts; running -> killed) via
  // the queue; no param keeps the frozen SPA's compat behaviour (stop an in-flight recording, or —
  // legacy shape — whatever lib/runner.ts's own map still thinks is "the active run").
  if (p === "/api/stop" && method === "POST") {
    const runParam = qp.get("run");
    return okOr(runParam ? stopQueuedRun(runParam) : stopLegacy(undefined), 409);
  }
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
  // Gate B: ?run=<runId> is the new keyed stream (404 if unknown); no param is the frozen SPA's
  // compat stream — the newest-or-recording run's replay + the cross-run global channel.
  if (p === "/api/stream") {
    const run = qp.get("run");
    if (run) {
      const stream = runStream(run);
      return stream ?? new Response("Unknown run.", { status: 404 });
    }
    return runStream();
  }

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
    const dir = latestRunDir();
    if (!dir) return new Response("No test runs yet.", { status: 404 });
    const rel = p === "/report" || p === "/report/" ? "index.html" : p.slice("/report/".length);
    const target = safeResolve(dir, decodeURIComponent(rel));
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

// ---------------------------------------------------------------------- boot migrations
// One physical db file (data/greenroom.db), two migration runners (plans/platform.md §3 "table
// ownership" box): better-auth's own runner creates its tables first, then drizzle's migrate()
// creates ours. Runs every boot; both are no-ops once the schema is current. Top-level await is
// fine under bun.
await runAuthMigrations();
runAppMigrations();
// Single default organization + "Unassigned" team (plans/platform.md §2) — idempotent, must run
// after both migration runners so `organization`/`team` exist. auth/index.ts's databaseHooks
// joins every new user to these on creation.
ensureDefaultOrg();
// Seed config/roles.json on first boot (was a roles.ts load-time side-effect — moved here to
// break the roles.ts↔creds.ts import-cycle TDZ that crashed a fresh boot with no roles.json).
seedRoles();
// P5 Gate D (plans/platform.md §6): crash recovery BEFORE anything can observe a stale row as
// still active — any `run` left `running` from a previous (crashed/killed) process becomes
// `error`, any `queued` becomes `stopped` (never silently auto-resumed). Then a first `tick()` in
// case anything is still legitimately queued (there shouldn't be, reconcileOnBoot just cleared it,
// but a fresh boot with a from-scratch db or a future change to that policy makes this a no-op
// worth having rather than a queue that only ever starts moving once someone hits /api/run again).
reconcileOnBoot();
tickQueue();

// ---------------------------------------------------------------------- serve
try {
  Bun.serve({
    port: PORT,
    // Loopback-only by default (local app). Set HOST=0.0.0.0 to bind all interfaces for a
    // deployed instance BEHIND a TLS-terminating reverse proxy + ALLOWED_HOSTS (see DEPLOY.md);
    // never expose 0.0.0.0 directly to a network without the proxy + a session in front.
    hostname: process.env.HOST ?? "127.0.0.1",
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
// Gate B: there's no single `state.proc` anymore — walk every run handle (there's only ever one
// active in practice, the lock stays until Gate D) plus the separate recording proc.
function shutdown() {
  for (const h of allRunHandles()) {
    if (!h.proc) continue;
    try {
      killProc(h.proc);
    } catch {
      /* best effort */
    }
  }
  if (recordingState.proc) {
    try {
      killProc(recordingState.proc);
    } catch {
      /* best effort */
    }
  }
}
process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
process.on("exit", shutdown);
