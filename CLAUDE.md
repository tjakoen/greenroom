# CLAUDE.md — start here

Onboarding + operating rules for any AI (or human) joining this repo. Read this first,
then the docs it points to. Keep it accurate: if you change how the project works, update
this file in the same change.

## What this is

**Greenroom** — a **local, no-coding-required test app** for running Playwright end-to-end
checks against any live web app and reviewing the results. You point it at your app's URLs
and tell it how to log in; it never needs your app's source. `context/` holds a
fill-in-the-blank map of the app under test (routes + how the pages are built) so tests can
be written against real URLs without the source.

The whole point: a non-coder opens the folder in **VS Code**, runs the **🚀 Open Test App**
task (Terminal → Run Task — no typing), a web page opens, they pick an environment, click
**Run**, and see pass/fail with screenshots, video and console/network logs. No command
typing.

The interface is a **bold status-dashboard single-page app** (sidebar + hash-routed pages:
Run / Tests / History / Report a bug / User guide / Settings), zero-dependency plain Node.
Users define **roles & logins** in-app (Settings → Roles & logins: named roles mapped to one
or more environments, credentials written to the git-ignored `.env`; values are never read
back), run one/some/all/by-tag tests **against one or several environments at once**, get a
live pass/fail dashboard (stat tiles + health bar + checklist, a test × environment matrix on
multi-env runs), and hand devs a one-click **bug bundle** (trace + video + screenshots + logs
+ markdown summary, zipped).

A committed `demo/` dir + `npm run demo` boot a read-only, zero-config populated dashboard for
a fresh clone; a small set of committed `@example` specs run against safe public sites out of
the box.

Tests are tagged/organised four ways, combined on the Tests page: **@tags** in the test
title (read from the file, run-by-tag via `--grep`), **group/priority/owner/notes** metadata
(app-managed sidecar `tests/tests-meta.json`, editable in-app), and **smart filters**
(failing / never-run / flaky / slowest) computed from run history. Bug-report PDFs can also
spotlight the browser logs **around a captured video moment** (relative timestamps recorded
by `fixtures.ts`).

**Tests are not tied to an environment.** Every `*.spec.ts` lives flat in `tests/` and runs
against whichever environment you pick; use relative `page.goto('/path')` so the active
environment's `baseURL` applies.

## Start here (reading order)

1. **The published BREAD standards index — <https://tjakoen.github.io/standards>.** How we build
   with AI (AI-DEVELOPMENT), session mechanics (SESSION-LOOP), and voice/doc shape (VOICE,
   NOTE-STANDARD, README-STANDARD). These are the cross-repo single source; this repo **references**
   them and never forks them. Read the index first, then fetch only the one the task needs.
2. **[README.md](README.md)** — the user-facing guide (how they actually use the app).
   The in-app version is **[USER-GUIDE.md](USER-GUIDE.md)** (task-based; served at `/api/guide`).
3. **[context/frontend-structure.md](context/frontend-structure.md)** + **[context/sitemap.md](context/sitemap.md)** — the fill-in-the-blank map of the app under test.

**Single sources of truth:**
- Environment URLs → **`config/urls.json`** (git-ignored; seeded from `config/urls.example.json` on first boot; read by both the tests and the recorder). Exactly one entry has `"default": true`. Each entry may also carry an optional **`login`** block (how that env's login form works); a top-level **`_login`** key sets the shared form used by every env that doesn't override it.
- Role *definitions* (names + which envs each maps to) → **`config/roles.json`** (git-ignored; seeded from `config/roles.example.json` + the existing `.env` on first boot). Credentials themselves stay in `.env` only.
- Logins → the user's private **`.env`** (git-ignored; template is `.env.example`).
- Which env(s) are active → **`TEST_ENV`** (single) or **`TEST_ENVS`** (comma-separated, one Playwright project per env) set by the interface; unset → the `"default": true` env.

## Commands

```bash
npm install                    # deps + Chromium (postinstall)
npm start                      # the app: web interface at http://localhost:4321
npm run menu                   # terminal menu runner (prompts for the environment)
TEST_ENV=<env> npx playwright test   # run all tests against one environment
npm run record                 # record a test by clicking through the site (opens a browser)
npm run report                 # reopen the last HTML report
npm run demo                   # boot read-only with seeded demo data (GREENROOM_DEMO=1)
npx tsc --noEmit               # typecheck (must stay green)
```

Non-coders don't type these: the **🚀 Open Test App** VS Code task (`.vscode/tasks.json`)
runs `npm start` and opens the browser; **🎬 Open Demo** runs `npm run demo`. First
`npm install` runs on VS Code's prompt / the task's first run.

## Non-negotiables

- **No app source enters this repo.** Only derived context (routes, selectors) in
  `context/`. If you need a new fact about the app under test, add it to the context docs.
- **No secrets committed.** Logins live only in `.env` (git-ignored). Never hardcode
  credentials in a test — pull them via `getUser(role)` (reads `.env`).
- **No real environment URLs committed.** `config/urls.json` is git-ignored (a user's real
  environments); only the generic `config/urls.example.json` is committed. Never hardcode an
  environment URL in a test — use relative paths.
- **Tests live flat in `tests/`**, not in per-environment folders. Never reintroduce
  `tests/<env>/` coupling — scope by `@tag`/metadata instead.
- **Keep dependencies at the floor.** The interface is zero-dependency plain Node on
  purpose. Add a library only when it earns its place.
- **User-first.** Anything a non-coder touches must work with no command typing and no
  coding — via the VS Code tasks + the web app, not raw terminal commands.
- **Definition of done** (below) — not "it runs on my machine once."

## Keep it aligned — when you change X, update Y

> **Migration note (BREAD, in progress — PLAN.md §4).** The entry point is **`server.ts`**, the
> BATCH·GRAIN·MILL·PROOF composition root (`start` = `bun server.ts`; `start:legacy` = the old
> `interface/server.js`). The whole domain lives in **`lib/*.ts`**; the `interface/server.js`
> rows below describe the **frozen old SPA still served at `/`** (Run/Tests/History/Report-a-bug),
> unchanged until the P6 cutover. Already migrated to real GRAIN-shelled routes (via `grainPage`
> in `server.ts`): **`/settings`** (`pages/settings-page.ts` + `pages/settings.js`, forms over the
> unchanged `/api/*`), **`/guide`** + **`/context`** (MILL), **`/plans`** (PROOF), **`/catalog`**
> (grain). Shell assets (`/styles`,`/scripts`,`/assets`,`/fonts`,`/components.css`) are served from
> the grain package; the shell chrome + nav live in `server.ts` `grainPage`/`NAV`, page-specific
> layout in `pages/greenroom.css`. When you touch a migrated page, update `server.ts` + its
> `pages/*` file (not the `interface/` SPA); when you touch a not-yet-migrated page, the
> `interface/` rows below still apply.

| You change… | …also update |
|---|---|
| **An environment** (add/edit/remove) | Just use the app's **Environments** panel (writes `config/urls.json`, seeds `.env.example`). Envs are dynamic — `config/environments.ts` reads `urls.json` at runtime; the runner targets `tests/` regardless of env, so no `EnvName` type or `package.json` script edit is needed. Mark exactly one `"default": true`. Add real logins in Settings → **Roles & logins**; set how the app's login form works in the same panel's **Login form** section (per env or shared). |
| **A public URL** | `config/urls.json` (your real envs) and/or `config/urls.example.json` (the committed template). Never in a test. |
| **The login form / selectors** | It's per-app **data**, not code: the `login` block per env (or shared `_login`) in `config/urls.json`, resolved by `config/environments.ts` **`getLoginForm(env)`** (env.login → `_login` → generic default). `tests/helpers/auth.ts` `login()` reads `getLoginForm` (only hand-edit `auth.ts` for exotic multi-step/MFA/SSO flows). Edited in-app via **Settings → Environments → Login form** (`server.js` `saveEnv`/`saveSharedLogin` + `sanitizeLoginForm`, `GET/POST /api/envs` carrying `login`/`sharedLogin`; `app.js` `refreshEnvs`/`saveSharedLogin` + `loginFieldsHtml`). Committed `urls.example.json` ships only generic placeholders → repo stays generic. Keep `context/frontend-structure.md` in step |
| **How logins are stored** | `users/roles.ts` (loader — env-scoped `<ENV>_<ROLE>_*` wins, shared `<ROLE>_*` falls back; a built-in public-cred default for the `example` role) → `.env.example` → `.gitignore` → README "First time" |
| **Role definitions** (names + which envs each maps to) | `config/roles.json` (git-ignored, seeded from `config/roles.example.json` + `.env` on first boot) ↔ `interface/server.js` `loadRoles`/`saveRoles` + `/api/roles` (GET merges defs with per-env cred status — **saved username + set booleans; the password is never returned**; POST create/update; DELETE removes the def and **never touches `.env`**) + `credRoles`/`rolesWithStatus` ↔ `app.js` Settings → **Roles & logins** ↔ `config/roles.example.json` (committed seed). Credentials stay in `.env` only; deleting a role leaves its `.env` lines alone. **`roles.json` is authoritative:** `scanCredRoles` seeds legacy `.env`-implied roles into `roles.json` **once** in `seedRoles` (first boot); `rolesWithStatus` does **not** re-union them at runtime, so editing/deleting a role in `roles.json` is honoured immediately (a leftover matching `.env` credential no longer resurrects a deleted role) |
| **The interface** (run/record/report/history/PDF/tests/creds/bug-bundle/guide) | `interface/server.js` (endpoints) ↔ `interface/index.html` (markup) ↔ `interface/app.js` (logic, hash router) ↔ `interface/styles.css` (theme, light+dark). Keep the four in sync. `app.js`/`styles.css` are served by `server.js` via the `/app.js` + `/styles.css` routes |
| **The PDF report** (fields, layout) | `interface/pdf.js` (HTML→PDF) ← the record written by `tests/helpers/fixtures.ts` (snapshots, browser info, console, network). The image is the chosen saved snapshot (`opts` carries the snapshot index `i` + the `from`/`to` ms window); error/console/network text is ANSI-stripped (`clean()`). Change one, check the others |
| **The bug bundle** (dev handoff zip) | `interface/server.js` `buildBugBundle`/`bugSummaryMd` + `interface/zip.js` (zero-dep STORE zip writer). Bundles summary.md + record.json + console/network + screenshots + video + `trace.zip` |
| **Video clip export** (short clip for a bug report) | `interface/ffmpeg.js` (locates ffmpeg: system install → Playwright's bundled copy; no new dependency) ↔ `interface/server.js` `/api/ffmpeg-available` + the clip endpoint ↔ `app.js` `ffmpegAvailable` + Download-clip buttons (hidden with a note when no ffmpeg) |
| **The Tests library / per-test results** | `interface/server.js` `listTests`/`specFiles`/`readResults`/`testHistory` (`specFiles` recursively walks `tests/` skipping `helpers/`; parses `test('…')` titles + @tags + the JSON reporter's `test-results/results.json`, aggregated across `runs/` for flaky/never-run/slowest) ↔ `app.js` Tests page + Run-page checklist. If you change the reporter set in `playwright.config.ts`, keep `results.json` |
| **Test tags / metadata / filters** | `@tags` live in the test title (parsed by `parseTests`, matched by `--grep` on run) — editable in-app via the 🏷 panel's **Tags** field: `saveTags`/`/api/test-tags` rewrites the `@tags` in the title inside the spec file and migrates the sidecar meta key (`file::title`) to the new title (returns it so the client re-keys the follow-up `/api/test-meta` save). Group/priority/owner/notes live in `tests/tests-meta.json` (git-ignored, `loadMeta`/`saveMeta`, `/api/test-meta`). Smart filters (failing/flaky/never-run/slowest) are computed client-side in `app.js`. Run-by-tag/one/selected all go through `startRun(env,light,files,grep)` (env only picks the baseURL/logins; `files` empty → all of `tests/`). The **Run page** also has a **Tests** scope dropdown (`#runScope`, `populateRunScope`/`resolveRunScope` in `app.js`): "All tests" → unscoped; a **group** → its specs + a title-grep (groups are sidecar metadata, not greppable, so resolved like Run-selected); a **@tag** → a plain `--grep`. Refreshed on init/reload/run-done |
| **Run-page dashboard** (stat tiles + health bar + live checklist) | `app.js` `renderChecklist` (parses Playwright `list` output live; reconciles from `/api/results` on done) ↔ `index.html` Run page (`#statTiles`,`#healthBar`,`#checklist`) ↔ `styles.css` `.stat`/`.health` |
| **Report-a-bug moment picker** (screenshot scrubber) | It's a **screenshot** scrubber, not a video one: `app.js` `showSnap`/`loadPdfSnaps` step through the snapshots the test captured (`#snapRange`/`#snapPrev`/`#snapNext`, 2-col `.scrub-layout` = image \| logs). The webm is a secondary reference in a `<details>` (`#pdfVideoDetails`, native `<video controls>`; `primeVideo` resolves Playwright's `duration=Infinity` so it's seekable — `serveRanged` gives `/api/video` HTTP Range/206). Snapshots carry a `t` (ms from start, written by `fixtures.ts`); Download PDF sends `i` = snapshot index + `time` = its `t`. Keep `.scrubber` markup in `index.html` + `styles.css` in step |
| **Logs at a captured moment** | `app.js` `renderMomentLogs` shows console + **actual network requests** (`requests`: method/status/url, non-2xx in red, capped `NET_MAX`) for the current screenshot: if the run has timing, filtered to ±`winMs()` of the snapshot's `t`; **fallback** — runs without timing show everything with a "re-run to pinpoint" note (never blank). Fed by `/api/moment?run&test` (`server.js`, returns `consoleTimed`/`networkTimed`/`requests`/`console`/`network`/`durationMs`). The window is computed **client-side** as the interval from the previous screenshot's `t` to the current one's; **Download PDF** echoes that same interval to `/api/pdf` as `from`/`to` (ms), and `pdf.js` filters `consoleTimed`/`networkTimed`/`requests` to `[from, to]` — so preview and PDF match. Runs without per-line timing fall back to the full logs in both. |
| **Logins UI** (guided `.env`) | `interface/server.js` `credRoles`/`saveCred` (role names now come from `config/roles.json`; writes env-scoped `.env` vars) ↔ `app.js` Settings → **Roles & logins** ↔ `.env.example` (the role blocks it discovers). `rolesWithStatus` returns the **saved username** (so the field pre-fills — it's the user's own local test account) but **never the password** (only a set-boolean; UI shows `•••••• (saved)`). Copy must stress: logins are local-only, never committed/synced/sent; saved usernames are shown, passwords are never shown again |
| **Multi-environment runs** (`TEST_ENVS` + one project per env) | `config/environments.ts` `getSelectedEnvs()` (parses `TEST_ENVS`, validates against `urls.json`, falls back to `[getEnvName()]`) → `playwright.config.ts` maps each selected env to a project named **`chromium (<env>)`** (name format is load-bearing — checklist parser + results readers key off it; per-project `envName` drives per-env `getUser`) → `interface/server.js` `startRun(envs,…)` spawns with `TEST_ENVS=<joined>`, archives/keys results per `(test, env)` → `app.js` Run page multi-select pills + test × environment **matrix** + per-env health. Single `TEST_ENV` path is unchanged |
| **Dynamic test data** (fresh inputs per run) | `tests/helpers/data.ts` (zero-dep generators: `uniqueEmail`/`unique`/`randomName`/`randomPhone`/`password`/`pick`/`randomString`) imported directly by a spec (`import * as data from './helpers/data'`) ↔ `interface/server.js` `recordedInputs` (detects `.fill('literal')` lines) + `applyInputs` (rewrites chosen fields to `data.*()` and adds the import) via `/api/recorded-inputs` + `/api/apply-inputs` ↔ `app.js` Tests-page **⌗ Make inputs dynamic** panel. Uniqueness is per call, so each env in a multi-env run submits a distinct value automatically |
| **Record with automatic login** | `interface/server.js` record flow injects `import` + `await login('<role>')` into the generated spec (credentials never typed into the recording) + stores the chosen `role` in `tests-meta.json` ↔ `app.js` record setup **Log in as** picker + Tests-page "runs as: X" ↔ `tests/helpers/fixtures.ts` `login` fixture (resolves `getUser(role, envName)` per env). **Pre-auth**: when a role is picked, `startRecording` (async) first runs `preAuth(env, role)` — a headless login using `resolveLoginForm`+`resolveCred` — saves a storageState temp file, and launches `codegen --load-storage=<file>` so the recorder opens **already logged in** (generic, driven by the `login` config; falls back to opening logged-out with a message if pre-auth fails). Temp session deleted on close; the saved spec still logs in fresh at runtime via the injected `login()` |
| **Demo mode** (read-only seeded clone) | `interface/server.js` `IS_DEMO = process.env.GREENROOM_DEMO === '1'` swaps each read boundary to the committed `demo/` dir (state/results/runs/tests-meta/roles/artifacts) and **guards every write endpoint** (run/record/env/cred/roles) → `{ ok:false, demo:true }` ↔ `app.js` "Demo" sidebar badge + disabled write buttons. `npm run demo` = `GREENROOM_DEMO=1 npm start`, mirrored as the **🎬 Open Demo** VS Code task. Keep `demo/` small and free of PII/real URLs |
| **The Examples group** (zero-config onboarding specs) | committed `@example` specs in `tests/` (saucedemo login, playwright.dev nav, wikipedia search, one intentional failure) + committed `tests/tests-meta.json` seed (`group: "Examples"`) + `config/roles.example.json` (`example` role) + `config/urls.example.json` demo envs + the `example` public-cred default in `users/roles.ts`. `example-login` is self-contained |
| **The features / landing page** | standalone `docs/index.html` (GitHub Pages ready; self-contained, inlined CSS + embedded shots). Keep its feature list in step with README |
| **The in-app user manual** | `USER-GUIDE.md` — served raw at `/api/guide`, rendered by `app.js`'s markdown renderer. Keep in step with `README.md` |
| **A user-facing command** (npm script) | mirror it in `.vscode/tasks.json` (the no-typing task) → README |
| **What/where tests capture** (video, screenshots, console, network, trace) | `playwright.config.ts` (`use`/`CAPTURE`) + `tests/helpers/fixtures.ts`. Fixtures record: a **filmstrip** of screenshots (on load, `framenavigated`, a 1s interval, and debounced after each click/input/submit via `addInitScript`+`__grSnap`; capped `CAP`, fewer in `CAPTURE=light`) each with a `t`; console (`consoleTimed`); network **issues** (`networkTimed`) and the **full request log** (`requests`: `{t,method,status,url,type,failed?}`, capped 3000) → README "What gets captured" |
| **The app under test (new route/feature)** | `context/sitemap.md` and/or `context/frontend-structure.md` — the map, since the app's source isn't here |
| **A user-facing flow** | `README.md` in the same change (it's the user's manual) |
| **A notable decision or non-obvious fact** | write a **memory** (see below) so the next session inherits it |

## Definition of done

> **Done = the change works end-to-end + `npx tsc --noEmit` is green + the docs in the
> sync table above are updated + the interface still boots (`npm start`) + a memory if a
> decision was made.**

For anything a user touches, "works" means *driven the real flow*, not just typechecked.

## Before committing / after a big change

Run the alignment audit — **[AUDIT.md](AUDIT.md)** (no secrets committed, no real URLs
committed, no app source, interface boots, typecheck green). Fix findings in the same session.

## Memory

Claude Code keeps per-project memories (decisions, preferences, context) outside the repo;
they surface at session start. Write one when a real decision is made or something
non-obvious is learned. If a recalled memory contradicts the code, trust the code and fix
the memory. Durable, repo-worthy rules belong *in this file*, not in memory.

## Working notes

- **Local only.** Ships as a local app. Recording uses a real browser on the user's screen.
- **VS Code is the primary entry point.** Users open the folder in VS Code and use the
  `.vscode/` tasks (**🚀 Open Test App**, run/record/report) + the Testing panel. The web
  app at `localhost:4321` is the main surface once started.
- **Open source.** This is a generic starter — no data about any specific app under test
  belongs in committed files (URLs, selectors, routes, credentials, org names). Keep
  `context/` and `*.example` files generic; real values live in git-ignored `urls.json`/`.env`.
- Run commands from the repo root.
- Commit/push only when asked.
