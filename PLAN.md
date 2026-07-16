# PLAN — Greenroom → BREAD stack migration (2026-07-09)

> This is the **active** plan: greenroom's migration to a full BREAD consumer. The original
> build plan (Tracks 1–5, complete) is archived verbatim at the bottom of this file under
> [Archive — original build plan](#archive--original-build-plan-complete). Companion doc for
> the new grain components this migration needs lives outside the repo (handed to a grain
> session separately).

Goal: greenroom becomes a full BREAD consumer like the portfolio — bun BATCH composition
root, frontend rebuilt in GRAIN, MILL for its docs, PROOF for its plan board — while
preserving every current behavior (§5).

## 1. Target architecture

One `server.ts` at greenroom's root, mirroring `tjakoen.github.io/server.ts`:

```
server.ts (Bun.serve, port 4321, loopback bind 127.0.0.1)
├─ BATCH  bunRuntime · makePageServer · makeStatic · createStyleBundle
│         createStream (SSE hub — run output; a SEPARATE stream later for the AI door)
│         makeModuleServer (client TS → browser, no bundler)
├─ GRAIN  styles + components + catalog + createAccepts (+ interaction layer in Phase G)
├─ MILL   createMillRoutes → /guide (USER-GUIDE.md) + /context (context/*.md)
├─ PROOF  createProofRoutes({ plansDir:"./plans", prefix:"/plans", chrome }) — direct mount
└─ lib/*.ts — domain extracted from interface/server.js (mechanical port):
   runner · recorder · envs · roles · groups · creds · tests-lib · runs · records
   bundle · pdf · ffmpeg · zip · demo · guard
```

Decisions:
- **Playwright stays on Node.** Server runs on bun; `runner.ts` keeps spawning
  `npx playwright test` / `codegen` as detached node children (group-kill semantics kept).
  In-process `chromium.launch()` (preAuth, pdf.js) is spiked in Phase 0; fallback = one-shot
  `node scripts/*.mjs` children.
- **Security guards port verbatim** into `guard.ts` (loopback Host allowlist, cross-origin
  write rejection, JSON content-type gate) + unit tests. BATCH doesn't ship these.
  Loopback bind + EADDRINUSE self-probe ("already running" vs "another app") kept.
- **Binary serving is explicit**: `Bun.file`-based byte-preserving static for report/runs/
  images/zips, and a Range/206 handler for `/api/video` (batch makeStatic text-reads —
  would corrupt binaries; portfolio's font lesson).
- **PROOF direct, pantry demoted to devDependency** (cockpit via `bunx pantry` still works;
  `pantry.config.json` stays).
- **Run-output SSE moves to batch `createStream`** with the same event names
  (`state`/`line`/`started`/`done`) and replay-on-connect.

## 2. Dependencies, pins, scripts

Pin git deps by **sha, not #main** (bun resolution quirk: `#main` transitive deps can
resolve duplicate layer copies). Copy the portfolio's CURRENT pattern (its package.json
as of 2026-07-09): per-repo sha pins + a `deps:refresh` script:

```json
"deps:refresh": "for p in batch grain mill proof; do bun add @tjakoen/$p@github:tjakoen/$p#$(git ls-remote https://github.com/tjakoen/$p.git main | cut -c1-7); done"
```

Take the shas the portfolio currently pins (batch#f9ecb03, grain#3e94bdc, mill#15fa3a5,
proof#f06daab at time of writing — re-check, or just run deps:refresh). The portfolio no
longer carries an `overrides` block; after install run `bun pm ls` and verify exactly one
copy of each layer resolves — if duplicates appear, add matching `overrides`.

Scripts: `dev` = `bun --hot server.ts`, `start`, `demo` (GREENROOM_DEMO=1), `bootstrap`
(`bun install && bunx playwright install chromium`), `check` (tsc --noEmit), `test`
(playwright test, unchanged), `test:unit` (bun test). Keep `postinstall`. devDependencies:
@playwright/test, @tjakoen/pantry, typescript, bun-types, dotenv. `.vscode/tasks.json`
flips npm→bun.

## 3. Frontend in GRAIN

SPA (`interface/index.html`+`app.js`+`styles.css`, hash routes) → server-rendered pages
under `pages/` (one real route per hash route: /run /tests /history /bug /guide /settings),
greenroom page shell (grain styles + app-shell) injected at the composition root, small
per-page client modules via makeModuleServer or plain JS. No bundler. Old SPA stays at `/`
until Phase 6 cutover (hash routes don't collide with new paths).

### Component mapping (current surface → GRAIN)

| Surface | Realization | Owner |
|---|---|---|
| Sidebar/frame | app-shell + side-rail/activity-bar + nav-item | grain |
| Status/demo badges | b-badge | grain |
| Env picker + group presets | **chip-group** (proposed) else gr-env-picker | grain-proposed |
| Run/Stop/light/role/scope controls | b-button, b-input, **b-select** (proposed) | grain(+proposed) |
| Live output console | console organism + run stream | grain |
| Live checklist | **status-list** (proposed): rows wear `data-commit="pending"` in flight, settle on result | grain-proposed |
| Stat tiles | **stat-tile** (proposed) | grain-proposed |
| Health bar | **b-meter** (proposed, monochrome segments) | grain-proposed |
| Test × env matrix | table + b-badge cells | grain |
| Tests library (filters/tags/meta/rename/dynamic-inputs) | table/card/tab/b-badge + forms | grain compose |
| History | timeline or table | grain |
| Bug page scrubber + moment logs | **gr-scrubber** (greenroom-owned; promote later) + figure + code-block | greenroom |
| Bundle/PDF/clip downloads | plain `<a href>` + b-button styling | grain |
| User guide | MILL collection over USER-GUIDE.md (deletes app.js md renderer) | mill |
| Settings (envs/login form/roles/groups) | card + table + b-input forms; password stays `•••••• (saved)` | grain compose |
| Onboarding hints | callout + /api/onboarding | grain |
| Theme, ⌘K | grain theme.js/theme-boot.js/cmdk.js + /search.json | grain, free |
| Plan board | PROOF /plans | proof |

Greenroom components live in a `components/` root fed to createStyleBundle/createCatalog
alongside grain's (they appear in /catalog). Tokens-only, one root class, variants as
attributes (CONVENTIONS §4). If the grain proposals land first, greenroom builds fewer
gr-* components — check grain's catalog before building any.

### The AI door (Phase G, last)

createAccepts → /ai/manifest; createInteractionLayer + greenroom reasoner; data-surface on
operable surfaces; ai-dispatch.js in shell; boot drift guards copied from portfolio.
Constraint: grain's `ActionName` is a CLOSED union — greenroom domain verbs (run.start etc.)
don't exist and don't belong upstream. So: human path stays hypermedia POSTs to /api/*
(stack-conformant); AI operability starts with existing verbs (`demo.run` on `screen` → a
scripted "watch the AI run the examples" demo + spotlight/console narration; `desk.stop`).
Real domain verbs = a flagged cross-repo decision (grow grain's registry reluctantly, or a
consumer-extensible registry in grain). Door gets its OWN SSE stream, never the run stream.

## 4. Phases (each independently verifiable)

- **P0 — spikes, no product change.** Baseline drive of the old app (run, record, bundle).
  Spikes under bun: (a) `bun interface/server.js` runs the whole app as-is; (b)
  `chromium.launch()` + `spawn('npx',…,{detached})` + group kill; (c) codegen spawn.
  If (a) passes → ship `"start": "bun interface/server.js"` immediately (runtime pivot
  lands before any rewrite). Verify: notes per spike; go/no-go on in-process chromium.
  **STATUS (2026-07-09): DONE.** (a) PASS — full app boots under bun, /api/state·/api/envs·
  /api/tests·/ all serve, zero warnings. (b1) GO — in-process `chromium.launch()` works
  under bun (no node one-shot fallback needed for preAuth/pdf). (b2) detached spawn +
  `kill(-pid)` group kill reaps parent+grandchild; `npx playwright` (v1.61.1) spawns from
  bun. (c) GO — codegen spawns its browser tree under bun, group-kill reaps it clean.
  `start`+`demo` flipped to `bun interface/server.js`, `bun run start` verified.
- **P1 — composition root serving the EXISTING frontend.** Pinned deps; server.ts; guards;
  all /api/* handlers ported to lib/*.ts; run stream on createStream; binary/Range helpers;
  PROOF /plans + MILL /guide + /context (minimal chrome). interface/server.js kept until P6.
  Verify: `bun run check`; boot; curl /api/state /api/envs /api/tests /api/runs /plans
  /guide; full run + recording + bundle via old UI on new server; `bun test` on lib units;
  `bun pm ls` single-copy check.
  **STATUS (2026-07-09): DONE + VERIFIED.** server.js (1975 lines) → 15 lib/*.ts modules
  (paths·run-stream foundation + envs·creds·roles·groups·tests-lib·records·runner·recorder·
  bundle·zip·pdf·ffmpeg, joining guard·binary). server.ts wires guard → PROOF/MILL → old SPA
  at `/` → all /api/* → binary static (/report,/runs,pdf-image) → EADDRINUSE probe + 500 wrap.
  `start`+`demo` flipped to `bun server.ts`; old entry kept as `start:legacy`. Verified: check
  + check:legacy green, `bun test lib` 14/14, `bun pm ls` single-copy, curl battery all 200 +
  CSRF 403, a full run (example-search→passed→archived, /report) + PDF + moment + bug-bundle
  zip + recorder spawn→stop group-kill (no orphans/stray spec), demo write-guard. NOTE: run
  SSE is a greenroom-owned Bun ReadableStream hub (lib/run-stream.ts) with replay-on-connect,
  NOT batch createStream — the pinned batch Stream has no replay-on-subscribe hook and P1
  serves the frozen app.js (§5.1). ALL WORK UNCOMMITTED on bread-migration (commit when asked).
- **P2 — GRAIN shell + Guide + Settings.** Shell/theme/⌘K/catalog; Guide via MILL; Settings
  forms. Verify: curl /settings /guide /catalog /components.css; env/role/group edits
  byte-match old file formats; dark mode; demo mode blocks writes.
  **STATUS (2026-07-12): DONE + VERIFIED.** `server.ts` gained a real GRAIN `app-shell` page
  (`grainPage`) that replaces P1's `minimalPage` for every new human route — a side-rail nav +
  app-window title bar, render-blocking `theme-boot.js` (no FOUC), `theme.js`, `cmdk.js` (⌘K
  over `/search.json`), `shell.js`. Serves grain assets via BATCH `makeStatic`/`createStyleBundle`:
  `/styles/*`, `/scripts/*`, `/assets/*`, **`/fonts/*`** (Redaction faces — pantry omits these
  and falls back; greenroom serves them), `/components.css`, `/catalog` (grain `createCatalog`,
  33 components). PROOF `/plans` + MILL `/guide`,`/context` now take `grainPage` as their `chrome`
  (guide/context use pantry's `bodyOnlyLayout` adapter so the doc's own `# H1` isn't doubled by
  MILL's masthead). New **`/settings`** page (`pages/settings-page.ts` skeleton + `pages/settings.js`
  client + `pages/greenroom.css`) reproduces Environments / Roles & logins / Site groups as grain
  `.card`/`.field`/`.btn` forms POSTing the IDENTICAL bodies to the UNCHANGED
  `/api/{envs,roles,creds,groups}` — password never returned (`•••••• (saved)`), demo writes
  refused + surfaced. NO proposed grain components needed (Settings has no `<select>` except the
  native group role picker). Old SPA at `/` byte-identical. Verified: `check` + `check:legacy`
  green, `bun test lib` 14/14, curl battery (all new routes 200 + correct types), CSRF 403,
  live env/role/group write round-trip (correct file format) + restore, demo write-block
  (`{ok:false,demo:true}`), and a headless-chromium drive of /settings /guide /catalog /plans:
  shell renders, settings list populates from `/api/*`, ⌘K opens, **zero console errors**.
- **P3 — Tests page.** Library, filters, tags/meta, rename/delete, dynamic inputs, record
  launcher. Verify: tag/group/rename/record/dynamic-input end-to-end vs P0 baseline.
  **STATUS (2026-07-12): DONE + VERIFIED.** New **`/tests`** page (`pages/tests-page.ts` skeleton
  + `pages/tests.js` client) reproduces the old Tests surface (interface/app.js ~405-675,
  ~1476-1495) as grain `.card`/`.field`/`.btn`/`.badge` markup POSTing the IDENTICAL bodies to the
  UNCHANGED `/api/{tests,recorded-inputs,apply-inputs,test-tags,test-meta,tests/rename,roles,
  record,state}` — env picker, search, smart filters, @tag filter bar, grouped/collapsible test
  list (select/Run/⌗ make-inputs-dynamic/🏷 tag-priority-owner/✎ rename/🗑 delete), bulk
  select-all/run-selected/delete-selected, and the record launcher's "Log in as" role picker, all
  demo-guarded like Settings. **Uses the new grain b-select + chip-group** (this page is why they
  were built): chip-group for the env picker + smart filters (single-select) and the @tag bar
  (multi-select), b-select for the Priority/input-generator/"Log in as" dropdowns. **Run seam:**
  the Run page is still the frozen SPA (P4's to migrate), so Run/Run selected/Run by tag do not
  trigger a run from this page — they hand off to the frozen SPA's `/#run` and let the user pick
  env + scope there, rather than teaching `interface/app.js` (off-limits here) to read a stashed
  scope back out. Old SPA at `/` byte-identical. Verified: `check` + `check:legacy` green,
  `bun test lib` 14/14 (untouched), curl `/tests` (200, grain shell) + `/tests.js` (200, serves),
  `/` unchanged.
- **P4 — Run page.** Picker, scope, role, light, Run/Stop, console SSE, checklist
  (pending→settled rows), stat tiles, health bar, matrix. Verify: single+multi-env live
  runs; Stop kills workers; checklist reconciles from /api/results.
  **STATUS (2026-07-13): DONE + VERIFIED.** New **`/run`** page (`pages/run-page.ts` skeleton +
  `pages/run.js` thin client) rebuilds the old SPA Run surface on GRAIN over the UNCHANGED
  `/api/{run,stop,stream,state,results,tests,roles,groups,creds}` — `run.js` sends the identical
  `/api/run` body and consumes the identical `/api/stream` events (`state`/`line`/`started`/`done`,
  replay-on-connect) `interface/app.js` does (byte-compat gate). Uses **three new grain primitives**
  (built in grain `996282f`, vendored into node_modules like the P3 components): **stat-tile**
  (Passed/Failed/Pending/Total), **b-meter** (`--seg`-driven health bar), **status-list** (single-env
  live checklist — a running row wears `data-commit="pending"`, the grain control lifecycle). Multi-env
  stays a plain grain `.table` matrix (table + b-badge cells, no bespoke component). chip-group
  multi-select env picker (monochrome ●/○ login-readiness glyph — no hue), b-select Tests-scope +
  Run-as pickers, monochrome `#runStatus` readout (grain caret while running). **Run seam owned:** the
  Tests page (P3) now hands off to `/run` (was `/#run`); the Run page itself triggers runs. Report-a-bug
  on a failed row hands off to the frozen SPA (`/#bug`) until P5. NAV Run `/` → `/run`; old SPA at `/`
  byte-identical. Also defined grain's `.cat-intro` in greenroom.css (was unstyled on the app-shell
  pages — a latent P3 gap). Verified: `check` + `check:legacy` green, `bun test lib` 14/14 (untouched),
  and headless-chromium drives in NON-demo mode — a real `@smoke` run (button → `startRun` →
  `seedChecklist` → SSE `started`/`line`/`done` → status-list + stat tiles + b-meter render →
  `reconcileResults` fills the real duration), a 2-env `demo+demo2` run (matrix table + per-env health),
  and **Stop** (`Stopping…` → `Stopped`, buttons revert). **ZERO console errors** throughout.
  **Deferred to a follow-up:** stashing the picked scope from Tests → Run (the handoff lands on `/run`
  but the user re-picks scope there; nothing reads a stashed scope yet), and the Run-page onboarding
  card (`refreshOnboarding`) was not ported (cross-cutting; not in P4's surface).
- **P5 — History + Report-a-bug.** Runs list; scrubber + moment logs + PDF + clip + bundle
  + video seeking. Verify: PDF window == preview window; clip hides without ffmpeg; bundle
  zip diffed vs P0 bundle.
  **STATUS (2026-07-16): DONE + VERIFIED.** Two new GRAIN-shelled pages, frontend-only (every
  endpoint already existed in `server.ts`/`lib/`): **`/history`** (`pages/history-page.ts` +
  `pages/history.js`, filterable run rows over `/api/{runs,pdf-data}`, monochrome pass/fail glyph,
  "Open report ↗" → `/runs/<id>/`, "Report this" on a failed run → `/bug?run=&test=&title=`) and
  **`/bug`** (`pages/report-bug-page.ts` + `pages/bug.js`, ported near-verbatim from the SPA's
  `#/share`: run/test pickers, markdown summary + full-log `<details>`, screenshot scrubber via
  `/api/pdf-image`, windowed moment logs `[prevSnap.t, curSnap.t]`, video `<details>` with
  `primeVideo` + Range/206, PDF `POST /api/pdf {run,test,i,from,to}`, bug-bundle, ffmpeg-gated
  clip). The SPA's in-page `pendingShare` global is replaced by a URL query on `/bug` (the
  History/Run "Report this" hand-off); NAV `/#history`→`/history`, `/#bug`→`/bug`; the Run page's
  "Report this" now hands off to `/bug?title=` (was frozen `/#bug`). Verified: `check` +
  `check:legacy` green; a headless-browser drive of both pages (History lists/filters/handoff;
  Bug summary + scrubber image + moment logs + Next-steps + PDF download + clip-shown-with-ffmpeg
  + title→test preselection) all PASS; `/api/bug-bundle` streams an 18-entry zip; `/api/video`
  Range → 206. Old SPA at `/` byte-identical (nothing in NAV routes to it now). Onboarding card
  still not ported (P4 gap, deferred to P6).
- **P6 — cutover.** `/` = new Run page; delete interface/ SPA + server.js; demo parity
  drive; tasks/README/USER-GUIDE/CLAUDE sync table/AUDIT updated; run the full §5 checklist;
  fresh-clone sim (`rm -rf node_modules && bun run bootstrap && bun start`) + `bun run demo`.
- **PG — AI door** (after cutover). Verify: /ai/manifest lists surfaces; demo runs AND
  releases the spotlight on natural completion (grain lesson 7); no drift warnings at boot.

## 5. Must-not-regress checklist (the P6 gate)

1. Runs: single/multi-env (`TEST_ENVS`, project name `chromium (<env>)` is load-bearing),
   by file/tag/group, GR_ROLE, CAPTURE=light, Stop kills process tree, SSE replay.
2. Config byte-compat: urls.json (_login + per-env login, default:true, first-boot seed),
   roles.json (+ .env-scan seed), groups.json, .env formats + control-char rejection;
   passwords never returned.
3. Artifacts: capture per playwright.config.ts (untouched); runs/ naming + count/size
   pruning; stale-report guard; /report + /runs serving w/ traversal guards; results.json
   flattening; flaky/never-run/slowest history.
4. Bug page: scrubber, timed+untimed moment logs, PDF scoped to same from/to, video
   Range/206, ffmpeg clip w/ graceful absence, bundle entry set identical.
5. Recorder: preAuth → --load-storage, cancel-during-preauth, temp cleanup, spec
   post-processing (storageState strip, URL relativize, login() injection, role meta),
   dynamic-input rewriting.
6. Tests mgmt: title/@tag parsing, tag rewrite + meta-key migration, rename/delete +
   sidecar migration.
7. Demo mode: all read boundaries → demo/, all writes refused, badge, VS Code task.
8. Local-only security: loopback bind, Host allowlist, cross-origin write rejection, JSON
   content-type gate, EADDRINUSE self-probe.
9. Non-coder entry: VS Code tasks no-typing; port 4321; malformed urls.json degrades with
   hint; per-request error wrapping (one error never kills the server).
10. Guide renders in-app; onboarding hints appear.

## 6. Risks

| Risk | De-risk |
|---|---|
| Playwright under bun | Runner always a node child; P0 spikes; preAuth/pdf fall back to node one-shot scripts |
| Recorder flow | Spiked P0, ported unchanged P1 (runtime vs UI changes never conflated) |
| Login flows | fixtures/auth.ts/environments.ts untouched (run inside node runner); test vs shipped `example` role |
| Binary/Range regressions | dedicated Bun.file helpers + unit tests (206 math, traversal) + bytes check in P1 curls |
| Guard regression | guard.ts verbatim + unit tests from P1 |
| SSE worlds colliding | separate streams (portfolio precedent); door deferred to PG |
| Duplicate layer copies | sha pins; `bun pm ls` check; add overrides only if duplicates appear |
| UI long tail (~4k-line SPA) | old SPA runnable until P6; per-page migration diffs against it; §5 is the gate |

## 7. Dependency direction + standards

Greenroom imports @tjakoen/{batch,grain,mill,proof}; is a dep of NOTHING. Reusable
discoveries are proposed upward to grain (see companion proposals doc), never reached into.
CLAUDE.md keeps referencing the published standards index (now the @tjakoen/standards
package / https://tjakoen.github.io/standards); update its sync table as interface rows
change (server.js↔index.html↔app.js↔styles.css → server.ts↔pages/↔components/↔lib/).
Add AGENTS.md → CLAUDE.md symlink + README badge row per README-STANDARD if missing.
Greenroom's own non-negotiables (no app-under-test source, no secrets/URLs committed,
tests flat, user-first) all survive; "dependencies at the floor" = the stack + zero
third-party runtime deps beyond it.

---

# Archive — original build plan (complete)

> The plan below drove greenroom's original build (Tracks 1–5: roles↔environments,
> multi-env runs, open-source demo + features page, dynamic test data, dashboard layout).
> All tracks landed and were verified; it is preserved here for the behavior contract it
> encodes (§5 of the migration plan above is the must-not-regress gate derived from it).
> Kept verbatim.

## PLAN — Greenroom build plan

> **Progress (2026-07-08):** DONE + verified — shared refactor (env-aware `getUser`,
> `envName` option, `login` fixture); Track 1a (roles.json + `/api/roles` + Roles & logins
> UI); Track 1b CORE (record role picker + automatic `login('<role>')` injection into the
> recorded spec + "runs as" on Tests page); Track 2a (`getSelectedEnvs` + one-project-per-env
> config); Track 2b (`startRun` env-array + per-env results); Track 2c (Run-page multi-select
> pills + test×env matrix + per-env health + prod confirm); Track 4 (`tests/helpers/data.ts`
> generators); Track 5 (dashboard grid `.dash`/`.col-*` + Run flagship re-tiled + centered
> width cap); Track 3 Part A (example specs + demo env templates + `roles.example.json` +
> committed `tests-meta.json` seed + self-contained `example-login`). All typecheck green,
> app boots, UI verified headless (no console errors, screenshots reviewed).
 Also DONE since: Track 1b "Make inputs dynamic" (⌗ panel + `/api/recorded-inputs`
> + `/api/apply-inputs` rewriting `.fill()` literals to `data.*()`); Track 3 Part B (demo mode
> — `GREENROOM_DEMO`/`IS_DEMO` read overrides to `demo/`, all writes guarded, sidebar badge,
> `npm run demo` + 🎬 Open Demo task, committed 5MB `demo/` seeded from a real 2-env run, paths
> scrubbed of home/brand strings); Track 3 Part C (`scripts/capture-shots.mjs` → `docs/shots/`
> run-dashboard/matrix/roles/tests); Track 3 Part D (standalone `docs/index.html` features
> page with real shots); CLAUDE.md sync-table rows; `.gitignore` anchored so `demo/` commits.
> All verified: tsc green, demo + non-demo boot, UI screenshots reviewed, AUDIT clean (no
> secrets/PII/real-private-URLs/app source; example specs use public test sites by design).
> REMAINING — README/USER-GUIDE/.env.example refresh (in progress); Track 1b pre-auth
> storageState (recorder opens already-logged-in) DEFERRED — runtime `login()` injection
> already automates login; pre-auth needs a headless TS login flow, low ROI vs risk; optional
> in-app `#/features` route (standalone `docs/` page covers it).


Three tracks, one document. They interlock: the demo showcases the two new features, and the
new features reshape what the demo must seed.

- **Track 1 — Roles ↔ environments**: create roles in-app, associate them to environments,
  fill credentials per env (local-only), pick a role when recording so login is automated.
- **Track 2 — Simultaneous multi-environment runs**: run the same tests against dev + stage
  + prod in one click, with per-environment accounts respected.
- **Track 3 — Open-source demo + features page**: fresh clone → alive dashboard with real
  screenshots/video/trace, zero config; plus a shareable features page.
- **Track 4 — Dynamic test data**: recorded form tests replay fresh/unique inputs each run
  instead of the hardcoded literals the recorder captured (fix "email already exists").
- **Track 5 — Dashboard layout**: use the full screen width with a multi-column,
  dashboard-style grid instead of today's single stacked column.

Non-negotiables honored throughout: creds only in git-ignored `.env`; no real URLs
committed; tests flat in `tests/`; interface zero-dependency plain Node.

---

## How the tracks interlock (read before sequencing)

| Intersection | Consequence |
|---|---|
| Demo seeds creds as "set" | Demo must also seed `roles.json` + ship `config/roles.example.json` so the Roles UI looks alive. |
| Demo ships `dev/stage/prod`-style envs | Perfect vehicle to **demo the simultaneous multi-env run** — the money shot for Track 2. |
| Examples group (public specs) | Doubles as the multi-env demo (e.g. saucedemo run across two demo envs) and as roles onboarding. |
| Features page (Track 3) | Must spotlight roles + multi-env, so build the page **after** Tracks 1–2 land. |
| Demo write-guard | Must also guard `/api/roles` writes and multi-env runs, not just today's endpoints. |
| Track 4 post-record step | Runs in the same record→spec pipeline as Track 1b's `login('<role>')` injection — build them as one post-processing pass, not two. |
| Track 4 × multi-env | Dynamic data must be regenerated **per project/env**, so a 3-env run submits 3 distinct unique emails — the generator lives in the `login`/data fixtures keyed off `envName`. |

Build order across tracks: **shared refactor → Track 1 → Track 2 → Track 3**. Track 3's
seeded data and screenshots depend on 1 and 2 existing.

---

## Current state (what already exists)

- **Cred storage**: `.env`, env-scoped `<ENV>_<ROLE>_USERNAME/_PASSWORD` with shared
  `<ROLE>_*` fallback (`users/roles.ts`). Already handles "accounts differ per environment".
- **Settings → Logins**: `credRoles()`/`saveCred()` in `interface/server.js` — roles are
  *implicit*: they exist only if a matching var name appears in `.env.example`/`.env`. No
  create/rename/delete, no role↔env association.
- **Record flow**: `startRecording(env, name)` opens codegen against the env's baseURL. User
  logs in manually; generated spec risks containing raw typed credentials.
- **Run flow**: `startRun(env, light, files, grep)` — one env, one `state.proc`, one
  Playwright project; `TEST_ENV` picks baseURL + creds.
- **Demo**: none yet. Fresh clone shows an empty dashboard.

---

## Shared refactor first — env-aware `getUser`

Tracks 1 and 2 both need credentials resolvable for an **explicit** env, not just the
process-wide `TEST_ENV`.

- `users/roles.ts`: `getUser(role, env?)` — `env` defaults to `getEnvName()` (backward
  compatible; every existing call keeps working).
- `tests/helpers/fixtures.ts`: give each Playwright project a custom `envName` option
  (`test.extend<{ envName: string }>`), and export a **`login` fixture** bound to it so specs
  write `await login('admin')` and get the right account for the running env/project. Keep
  the old `login(page, role)` helper in `tests/helpers/auth.ts` working (single-env path) —
  deprecate gently in comments, don't break existing specs.

Verify single-env everything still green (`npx tsc --noEmit`, run an existing spec) before
moving on.

---

## Track 1 — Roles: create, associate to envs, use when creating tests

> **Login ↔ site mapping is the core of this track.** In Greenroom an **environment = a
> site** (each env is one baseURL in `urls.json`). A **login** is a role's username/password
> *for one site*. This track lets a user: add a login, and map it to one site, several
> sites, or all sites. Two mapping shapes, both first-class:
> - **Same login across sites** → role with `envs: "all"`, credentials in the shared
>   `<ROLE>_*` vars. Fill once, works everywhere.
> - **Different login per site** → role mapped to specific `envs: [...]`, credentials in the
>   env-scoped `<ENV>_<ROLE>_*` vars. A "student" login on dev differs from staging.
>
> The Roles UI is where this mapping is created and edited; the `.env` var naming already
> encodes it (shared vs env-scoped). "Roles" is just the grouping so one login concept
> (e.g. *admin*) can carry a different actual account per site.

### Data model

New git-ignored **`config/roles.json`** (committed template `config/roles.example.json`) —
role *definitions* only (names/associations, **never** credentials; those stay in `.env`):

```json
{
  "admin":   { "label": "Admin",   "envs": "all" },
  "student": { "label": "Student", "envs": ["dev", "staging"] }
}
```

- `envs: "all"` → every environment (pairs with shared `<ROLE>_*` vars).
- `envs: [...]` → only those (pairs with `<ENV>_<ROLE>_*` vars).
- First boot: **seed from what's implicit today** — run `credRoles()` scan once, write
  discovered roles into `roles.json`, so existing users lose nothing.

### Server (`interface/server.js`)

- `loadRoles()`/`saveRoles()` + endpoints:
  - `GET /api/roles` — definitions merged with cred status per env (reuses `credRoles()`
    logic; **booleans only**, never values).
  - `POST /api/roles` — create/update (name, label, env list).
  - `DELETE /api/roles/<name>` — remove definition; **leave `.env` lines alone** (deleting a
    definition must never touch stored secrets).
- `credRoles()` becomes: roles from `roles.json` × associated envs (var-name scan kept as
  fallback for unmigrated setups).

### UI (Settings → Logins becomes "Roles & logins")

- **Roles list**: create role (name + label), **checkboxes to map it to sites** — one,
  several, or "All environments" (the toggle = one shared login used on every site).
- Per role × mapped site: username/password inputs (write-only, `saveCred` as today) — this
  is literally "add a login, map it to a site". A role mapped to 3 sites shows 3 login rows;
  fill each (or leave the shared one to cover all).
- Prominent copy: **"Logins are stored only in a private file on this computer (`.env`).
  Never committed, synced, or sent anywhere."**
- Env pills' readiness dots (`updateDots`) now answer "does every role associated with this
  env have creds set".

### Test creation / recording setup screen

On **Record a new test** (and future "new test" flows):

1. Setup dialog: pick **environment** → role dropdown shows only roles associated with that
   env (creds-set enabled; missing-creds shown disabled + "add login" link). Option:
   "No login (public pages)".
2. If a role is picked, server **pre-authenticates before codegen**: headless Playwright
   runs the `LOGIN` flow from `tests/helpers/auth.ts` with `getUser(role, env)`, saves
   `storageState` to git-ignored `test-results/.auth/<env>-<role>.json`, then launches
   `codegen --load-storage=<file>` — recorder opens **already logged in**, so credentials
   never get typed into the recording.
3. Post-process the generated spec: inject the import + `await login('<role>')` at the top so
   at *runtime* the test logs in per env. Recorded storage state is a recording convenience,
   never a runtime dependency.
4. Store chosen role in `tests/tests-meta.json` (new `role` field) → Tests page shows "runs
   as: admin" and warns when a target env lacks that role's creds.

Caveat: pre-auth only works once `auth.ts` `LOGIN` selectors are configured for the app under
test (placeholders on a fresh clone). If pre-auth fails, fall back to today's behavior (open
codegen logged out) + a toast explaining why.

---

## Track 2 — Simultaneous multi-environment runs

### Approach: one Playwright process, one **project per env** (recommended)

Rejected alternative: spawning N `playwright test` processes (one per env). That clobbers
`test-results/`/`playwright-report`/`results.json`, breaks `archiveRun`, and forces a
multi-proc rewrite of `state`. Projects give us for free: a single merged HTML report, one
`results.json` (each entry carries `projectName`), the existing single `state.proc`, and
Playwright's own worker scheduling across envs.

### Config

- **`TEST_ENVS`** (new, comma-separated `TEST_ENVS=dev,staging`) selects the run's envs.
  `TEST_ENV` (singular) keeps working — one env, one project.
- `config/environments.ts`: add `getSelectedEnvs(): EnvName[]` (parse `TEST_ENVS`, validate
  against `urls.json`, fall back to `[getEnvName()]`).
- `playwright.config.ts`:

```ts
projects: getSelectedEnvs().map((env) => ({
  name: `chromium (${env})`,
  use: { ...devices['Desktop Chrome'], baseURL: baseURLof(env), envName: env },
})),
```

  Top-level `use.baseURL` stays for the single-env path. Project **name format
  `chromium (<env>)` is load-bearing** — checklist parser and results readers key off it.

### Per-env accounts (the caveat, handled)

The `login` fixture resolves creds via `getUser(role, envName)` per project → env-scoped
vars win, shared vars fall back. Same test, three projects, three accounts, zero test edits.

### Server (`interface/server.js`)

- `startRun(envs, light, files, grep)` — accept an array (length 1 = today). Validate every
  env; spawn with `TEST_ENVS=<joined>`. `state.env` becomes the list (keep a joined string
  for display/back-compat).
- `archiveRun`: folder `<stamp>-<env1+env2>-<result>`; history entries record the env list.
- `readResults`/`testHistory`/`listTests`: results carry `projectName`; parse env out of
  `chromium (<env>)` and key per-test results by **(test, env)**. Smart filters aggregate
  across envs but must not mark a test "flaky" because prod fails while dev passes — treat
  each (test, env) series independently, surface "differs by environment" as its own signal
  (that divergence is what this feature is for).

### UI (`interface/app.js` / `index.html` / `styles.css`)

- **Env pills → multi-select** on the Run page (toggle; default one; "Run on all"
  affordance). Readiness dots unchanged.
- **Checklist becomes a matrix** when >1 env: rows = tests, one status cell per env (`list`
  reporter prefixes each line with `[chromium (<env>)]` — `renderChecklist` parses that into
  the env column). Single-env keeps today's flat list.
- **Stat tiles / health bar**: overall aggregate + a compact per-env health row ("prod red,
  dev green" visible at a glance).
- **Safety**: selecting an env whose associated roles lack creds → warn before run. Confirm
  step when the selection includes an env named/flagged production (recommended — cheap
  insurance).
- History page: env list per run; per-test history gains an env column.

### PDF / bug bundle

`fixtures.ts` already records `env` + `project` per test — verify `interface/pdf.js` and
`bugSummaryMd` show the *test's own* env (they read from the record, so should Just Work;
check, don't assume).

---

## Track 3 — Open-source demo + features page

Goal: fresh clone → fully-populated Greenroom (dashboards, history, screenshots, video, PDF,
bug bundle) **without configuring an env or logins**. Real artifacts captured against safe
public sites, reused on a features page. Ships no secrets, no real URLs, no app-under-test
source.

### Part A — safe public target sites

Sites built for / tolerant of automated testing:

| Site | Why | Demos |
|---|---|---|
| `https://www.saucedemo.com` | Purpose-built Playwright demo store, public creds (`standard_user`/`secret_sauce`) | Login flow + `getUser(role)` + a real pass |
| `https://playwright.dev` | Stable docs, no auth | Navigation, fast pass |
| `https://en.wikipedia.org` | Stable, allows automation | Search interaction, multi-step |
| `https://the-internet.herokuapp.com` | Classic QA sandbox | **Intentional failures** → red run screenshots/trace/video |

the-internet + a deliberately-wrong assertion give an authentic **failing** test (red tiles,
failure screenshot, trace, bug bundle — the money shots). Add these as demo envs in
`config/urls.example.json` (committed, generic). Real `urls.json` stays git-ignored.
**Track-2 tie-in:** define two demo envs so the demo can showcase a simultaneous run.

### Part A2 — the Examples group (permanent onboarding tests)

Example specs ship forever as a self-documenting "Examples" group. Value: onboarding
(fresh clone → green dashboard, no config), template (copy a spec, swap URL/selectors),
demo-data source, and regression on Greenroom's own capture pipeline.

- Tag every example spec `@example` in its `test('…')` title (runnable via `--grep @example`).
- Set `group: "Examples"` (+ owner/priority/notes) in the committed `tests/tests-meta.json`.
- Keep flat in `tests/` (or `tests/examples/` — `specFiles` recurses, skips `helpers/`).
  Prefer flat + tag to honor "scope by tag/metadata, not folders".
- `tests-meta.json` is git-ignored today — **commit a seed** (or merge committed example
  defaults with the user's) so the group exists on clone.

Zero-config logins for examples (`getUser` throws when unset today):
- Add a small **public-cred default map** in `users/roles.ts` for known example roles only
  (`example` → saucedemo `standard_user`/`secret_sauce`), used as the final fallback after
  env-scoped and shared vars. Safe: public + purpose-built. **Fold into the shared refactor**
  — `getUser(role, env?)` gets this default map in the same pass.
- Non-login examples (playwright.dev, wikipedia) need no creds.
- **Track-1 tie-in:** seed `config/roles.example.json` with the `example` role so the Roles
  UI is populated on a fresh clone.

### Part B — demo mode (static data)

Single flag `GREENROOM_DEMO=1` makes `interface/server.js` read seeded fixtures from a
committed `demo/` dir instead of live user-specific sources. No changes to real code paths —
demo swaps the data source at each read boundary.

Data-source swap points:

| Endpoint / fn | Live source | Demo source |
|---|---|---|
| `publicState()` → `/api/state` | run status, env list, `.env` presence | seeded: status `passed`, demo envs, creds "set" |
| `/api/results` (`readResults`) | `test-results/results.json` | `demo/results.json` |
| `/api/runs` + `/runs/*` (`testHistory`) | `runs/` | `demo/runs/` |
| `/api/tests` (`listTests`/`specFiles`/`loadMeta`) | `tests/` + `tests-meta.json` | real demo specs + `demo/tests-meta.json` |
| `/api/creds` (`credRoles`) | `.env` scan | seeded roles, "configured" (never values) |
| `/api/roles` (`loadRoles`) — **new** | `roles.json` | `demo/roles.json` |
| `/api/pdf-image`, `/api/video`, `/api/moment` | captured artifacts | `demo/` artifacts |
| `/api/bug-summary`, `/api/bug-bundle` | live run | seeded run folder |

Implementation:
1. `IS_DEMO = process.env.GREENROOM_DEMO === '1'` near top of `server.js`.
2. `demoRead(name, liveFn)` helper: if `IS_DEMO`, return `demo/<name>.json` (or dir); else
   call `liveFn`. Wrap each read boundary above.
3. Seed `demo/` by **actually running** the demo specs once (`GREENROOM_DEMO=` unset), then
   copy the produced `runs/<id>/`, `results.json`, artifacts into `demo/`. Real artifacts >
   hand-faked JSON.
4. Scrub seeded data: no real emails/PII (org rule: no customer PII anywhere), generic env
   names, saucedemo public creds only.
5. **Gate write endpoints on `IS_DEMO`** (read-only) — `/api/run`, `/api/record`, env
   POST/DELETE, cred save, **and the new `/api/roles` POST/DELETE + multi-env run** → return
   `{ ok:false, demo:true }`; app.js shows a "Demo mode" badge + disables write buttons.
6. `npm run demo` → `GREENROOM_DEMO=1 npm start`; mirror as VS Code task **🎬 Open Demo**.

Open decision — **static (recommended for screenshots + safety)** vs live vs both. Static:
read-only, deterministic, safe to host. Live: user clicks Run against public sites (flakier).
Can support both via an optional "run it live" toggle that lifts the write guard.

### Part C — capture screenshots for the features page

Once demo mode looks right, capture Greenroom's own UI:
1. `GREENROOM_DEMO=1 npm start`, open each page: Run (green), Run (red), Tests, History,
   Report-a-bug (video scrub + frame), **Roles & logins**, **multi-env matrix run**, User
   guide.
2. Playwright script `scripts/capture-shots.ts` hitting `localhost:4321` at a fixed viewport
   (1440×900), light **and** dark theme → `docs/shots/`. Automated = repeatable.
3. Grab real artifact shots (saucedemo failure screenshot, trace viewer).

### Part D — features / screenshots page

Build **after** Tracks 1–2 so it can spotlight them. Two surfaces from one content source:
- In-app route `#/features` (consistent theme, demo build).
- Standalone `docs/index.html` (GitHub Pages landing; self-contained, inlined CSS + embedded
  shots).

Content: hero pitch; feature grid (live dashboard, tags/metadata/smart filters, **roles &
per-env logins**, **simultaneous multi-env runs**, video scrub → PDF, bug bundle, guided
logins, VS Code no-typing tasks); "How it works" 3 steps; repo link + "Try the demo".

---

## Track 4 — Dynamic test data (fresh inputs per run)

### The problem

The recorder writes literal typed values into the spec (`.fill('bob@example.com')`). On
replay the same value is submitted every time, which breaks whenever the form needs a
**new** value: signup emails/usernames with a uniqueness constraint ("already exists"),
one-time codes, values consumed on first use. Recorded-as-is form tests pass once, then fail
forever.

### Input categories (each handled differently)

| Category | Example | Handling |
|---|---|---|
| **Unique-required** | signup email, username | Generate fresh + unique each run (`user+<ts>-<rand>@…`) |
| **Random-valid** | name, address, phone, company | Fake generator, any valid value |
| **Fixed-but-per-env** | an account/record that must already exist in that env's DB | Per-env data value (stored like creds, resolved by `envName`) |
| **Keep literal** | a fixed dropdown choice, a constant | Left exactly as recorded |

### Test-data helper — `tests/helpers/data.ts` (zero-dep)

Small homegrown generators so the tests stay dependency-free (honors the floor rule):
`uniqueEmail(prefix?)`, `unique(prefix)`, `randomName()`, `randomPhone()`, `pick([...])`,
`randomString(n)`. Tests may use `Date.now()`/`Math.random()` freely (the ban on those is
workflow-script-only, not test code). If broader realism is wanted later, `@faker-js/faker`
is a **devDep, tests-only** add — does not touch the zero-dep interface.

Expose them as a **fixture keyed off `envName`** (same mechanism as the `login` fixture from
the shared refactor) so a multi-env run regenerates distinct values per project — 3 envs =
3 different unique emails, no collisions.

### Record post-processing — the no-coding bridge

Fold into the **same post-record pass** that injects `login('<role>')` (Track 1b):

1. After codegen, parse the generated spec for input actions (`.fill(sel, 'literal')`,
   `.type(...)`, select/`.check()` where relevant).
2. Show a **"Make inputs dynamic"** screen: a row per detected filled field (label = nearest
   selector/placeholder, current literal shown), with a per-field dropdown:
   `Keep literal` (default) / `Unique email` / `Random name` / `Random text` / `Pick from
   list…` / `Per-env value…`.
3. Rewrite chosen fields: `.fill('bob@example.com')` → `.fill(data.uniqueEmail())`, inject
   the `data` fixture import/param at the top. Untouched fields stay literal.
4. Record the mapping in `tests/tests-meta.json` (new `inputs` field) so the choice is
   visible/editable on the Tests page later — non-coder never edits the spec by hand.

### Data-driven runs (optional, later)

Run the same spec over a set of input rows (inline list in the spec, or a git-ignored CSV
per test). Playwright pattern: `for (const row of rows) test(\`… \${row.name}\`, …)`. Nice
for "submit 20 variations"; not required for the core fix above. Ship only if asked.

### Files to touch

- `tests/helpers/data.ts` — **new**, zero-dep generators.
- `tests/helpers/fixtures.ts` — expose `data` as an `envName`-keyed fixture.
- `interface/server.js` — extend the record post-processing (shared with Track 1b) to detect
  fields and rewrite chosen ones; `tests-meta.json` `inputs` field.
- `interface/app.js` / `index.html` / `styles.css` — the "Make inputs dynamic" screen (part
  of the same record setup/finish flow as the role picker).
- `USER-GUIDE.md` / `README.md` — "why your form test needs dynamic data" + how to pick.
- Per-env values (`Per-env value…`) reuse the creds storage pattern: git-ignored, resolved
  by `envName`. Keep out of committed files.

---

## Track 5 — Dashboard layout (multi-column, full-width)

### The problem

`.content` is already full-width (only the guide + `.narrow` pages cap at 820px), and helpers
exist (`.grid2`, `.stat-tiles`). But most pages **stack every card in one vertical column**,
so on a wide screen the right two-thirds is empty. Goal: a **dashboard grid** — cards tile
into 2–3 columns and fill the width, with a sensible reading order that collapses to one
column on narrow screens.

### Design constraints (per the UI memory)

Restrained pro SaaS: **neutral zinc + green, no decorative emoji, no "AI vibe"**. This is a
layout/density change only — reuse existing tokens (`--bg`, `--border`, `--radius`), card
styles, stat tiles, health bar. No new colors, no gradients, no visual noise. More columns,
same restraint.

### Approach — a reusable dashboard grid, per page

- Add a `.dash` grid utility: `display: grid; grid-template-columns: repeat(12, 1fr);
  gap: 16px; align-items: start;` and let cards span columns (`.col-4/.col-6/.col-8` →
  `grid-column: span N`). Cards keep their current look; only their container changes.
- Responsive: `@media (max-width: ~1100px)` collapse to 6-col, `~760px` to 1-col — extend the
  existing `.grid2` breakpoint pattern (line ~108) rather than inventing a new system.
- `align-items: start` so cards don't stretch to the tallest sibling (masonry-ish without JS).
  If true masonry is wanted later, CSS `grid-template-rows: masonry` is not broadly shipped —
  stay with column spans, don't add a JS masonry lib (zero-dep floor).
- Consider a comfortable max-width cap (e.g. `~1600px`, centered) so cards don't stretch
  absurdly wide on ultrawide monitors — full-width, but not unreadable. Make it a token.

### Per-page layout (proposed tiling)

- **Run** (the flagship dashboard): top row = stat tiles (full width, already a grid) +
  health bar; then a 2-col split — **left** the run controls (env multi-select pills, tags,
  Run button, light toggle), **right** the live checklist/matrix. Output/console as a wide
  card below. With Track 2's per-env matrix this becomes the real "mission control" view.
- **Tests**: filter bar full width on top; test groups tile 2-col on wide screens (they're
  independent lists) — or keep 1-col if grouping reads better; decide during build.
- **History**: run list left column, selected-run detail/preview right column (master-detail)
  instead of a single stacked list.
- **Settings / Roles & logins**: roles grid tiles per role card (2-col), each card holding
  its site→login rows. Pairs naturally with Track 1.
- **Report a bug**: the scrub layout is already 2-col (`.scrub-layout`); leave it, just let it
  sit in the wider canvas.
- **Guide / features**: keep the readable single-column cap (820px) — long-form text should
  NOT go full width.

### Files to touch

- `interface/styles.css` — `.dash` grid + `.col-*` spans + responsive breakpoints + optional
  ultrawide max-width token. Reuse existing card/token styles.
- `interface/index.html` — wrap each page's cards in `.dash` and add span classes; reorder
  markup for the intended tiling (source order = reading/collapse order).
- `interface/app.js` — only if a page builds its cards dynamically (checklist/matrix already
  do); ensure injected nodes get the right span classes. Mostly markup/CSS, minimal JS.
- Keep light **and** dark theme correct (test both — it's in the definition of done).

### Interaction with other tracks

- Track 2's multi-env matrix wants horizontal room → the Run dashboard grid is what makes it
  legible. Build Track 5 **after** Track 2 so the Run page is laid out with the matrix in mind.
- Track 3's screenshots (Part C) must capture the **new** multi-column layout → Track 5 lands
  before screenshot capture. Slot it before Track 3 Part C.

---

## Sequencing (all five tracks)

1. **Shared refactor** — `getUser(role, env?)` (incl. example public-cred default map),
   `envName` project option + `login` fixture. Single-env still green.
2. **Track 1a** — `roles.json` + `/api/roles` + seed-from-`.env` migration + Settings UI
   rework (create/associate roles, local-only copy).
3. **Track 1b + Track 4** — record setup + post-processing (one pass): env → role picker →
   pre-auth storageState → codegen `--load-storage` → post-inject `login('<role>')` →
   **"Make inputs dynamic" screen** rewrites chosen fields to `data.*()` → `role` + `inputs`
   in `tests-meta.json`. Add `tests/helpers/data.ts` + the `data` fixture here.
4. **Track 2a** — `TEST_ENVS` + `getSelectedEnvs` + projects in `playwright.config.ts`;
   prove a 2-env CLI run works and `results.json` carries both project names.
5. **Track 2b** — server `startRun(envs…)`, archive naming, results/history env keying.
6. **Track 2c** — Run page multi-select pills, checklist matrix, per-env health, warnings.
7. **Track 5** — dashboard layout: `.dash` grid + `.col-*` spans + breakpoints, re-tile each
   page (Run as flagship mission-control with the matrix). Built after Track 2 so the Run
   page is laid out with the multi-env matrix in mind; before Track 3 screenshots.
8. **Track 3 Part A/A2** — demo envs in `urls.example.json` + Examples specs (incl. one
   intentional fail) + committed `tests-meta.json` seed + `roles.example.json`. Verify
   **fresh-clone zero-config run** goes green.
9. **Track 3 Part B** — `GREENROOM_DEMO` flag, `demoRead` swaps (incl. `/api/roles`), write
   guards (incl. roles + multi-env), badge, `npm run demo`. Harvest real artifacts into
   `demo/`.
10. **Track 3 Part C** — automated screenshot capture (light+dark) of the **new dashboard
    layout**, incl. roles + matrix pages.
11. **Track 3 Part D** — features page (in-app + `docs/` landing).
12. Docs sweep per CLAUDE.md sync table: `README.md`, `USER-GUIDE.md`, `.env.example`
    (roles UI note), CLAUDE.md sync table **gains rows** for `config/roles.json`,
    `TEST_ENVS`, and `demo/`. `.gitignore`: add `config/roles.json`, `test-results/.auth/`;
    ensure `demo/` is **not** ignored while real `runs/`/`test-results/`/`urls.json`/`.env`
    stay ignored.
13. **AUDIT.md** pass + memories for decisions (projects-not-processes; roles.json split from
    `.env`; demo read-only swap; dashboard grid).

## Definition of done

- **Track 1:** create a role in-app, tick two envs, fill different creds per env → recorder
  opens pre-logged-in with the right account; generated spec contains `login('<role>')` and
  **no literal credentials**.
- **Track 4:** record a signup form, pick "Unique email" for the email field → the generated
  spec uses `data.uniqueEmail()`, and running it twice (and across two envs at once) submits
  distinct emails with no "already exists" failure. Untouched fields stay literal.
- **Track 2:** select dev + staging on the Run page, click Run → one run, live matrix
  checklist, per-env results in History, PDF/bundle show the correct env per test. Single-env
  flow byte-for-byte unchanged; `TEST_ENV=x npx playwright test` still works.
- **Track 3:** fresh clone → `npm run demo` → alive dashboard with real screenshots/video/
  trace, **zero config**, read-only (roles + multi-env write-guarded). Features page renders
  in-app + as static `docs/` landing with current screenshots.
- **Track 5:** on a wide screen every page fills the width with tiled cards (Run page reads
  as a mission-control dashboard, not a single column); collapses cleanly to 1 column when
  narrow; light + dark both correct; restrained zinc+green, no new visual noise.
- `npx tsc --noEmit` green, app boots, AUDIT clean (no secrets/PII/real URLs/app source),
  docs + memory updated.

## Risks / open questions

- **Codegen + storageState**: `--load-storage` is solid, but pre-auth depends on `auth.ts`
  selectors being configured; fresh-clone fallback (logged-out recorder + toast) is
  mandatory.
- **Checklist parser**: multi-project `list` output interleaves projects; key on
  `[project] › file › title`, not title alone (same title exists once per env).
- **Worker pressure**: 3 envs × fullyParallel on a laptop — acceptable; use the existing
  "light capture" toggle as mitigation, don't add config.
- **Prod in a simultaneous run**: recommend an explicit confirm.
- **roles.json vs `.env` scan**: two sources could drift; scan stays only as read-time
  fallback + seed migration, `roles.json` wins on conflict.
- **Public sites change/go down** → seeded static data insulates the demo; re-harvest when
  specs break. Keep the-internet fail assertion robust.
- **Keep `demo/` small** (repo weight): 1 short webm, few PNGs, one trace.
- **Demo write-guard must be airtight** so a hosted demo can't trigger runs/record/role-edits
  on the host.
