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
Users set logins in-app (Settings → Logins writes the git-ignored `.env`; values are never
read back), run one/some/all/by-tag tests, get a live pass/fail dashboard (stat tiles +
health bar + checklist), and hand devs a one-click **bug bundle** (trace + video +
screenshots + logs + markdown summary, zipped).

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

1. **[standards/AI-DEVELOPMENT.md](standards/AI-DEVELOPMENT.md)** — how we build with AI (the standards every change is held to). **The why.**
2. **[standards/SESSION-LOOP.md](standards/SESSION-LOOP.md)** — session mechanics: orient, loop, memory, handoff, model economy.
3. **[standards/AI-REPO-STANDARD.md](standards/AI-REPO-STANDARD.md)** — how this repo is structured so AI sessions compound.
4. **[README.md](README.md)** — the user-facing guide (how they actually use the app).
   The in-app version is **[USER-GUIDE.md](USER-GUIDE.md)** (task-based; served at `/api/guide`).
5. **[context/frontend-structure.md](context/frontend-structure.md)** + **[context/sitemap.md](context/sitemap.md)** — the fill-in-the-blank map of the app under test.

**Single sources of truth:**
- Environment URLs → **`config/urls.json`** (git-ignored; seeded from `config/urls.example.json` on first boot; read by both the tests and the recorder). Exactly one entry has `"default": true`.
- Logins → the user's private **`.env`** (git-ignored; template is `.env.example`).
- Which env is active → the **`TEST_ENV`** env var (set by the interface / `run.sh`); unset → the `"default": true` env.

## Commands

```bash
npm install                    # deps + Chromium (postinstall)
npm start                      # the app: web interface at http://localhost:4321
npm run menu                   # terminal menu runner (prompts for the environment)
TEST_ENV=<env> npx playwright test   # run all tests against one environment
npm run record                 # record a test by clicking through the site (opens a browser)
npm run report                 # reopen the last HTML report
npx tsc --noEmit               # typecheck (must stay green)
```

Non-coders don't type these: the **🚀 Open Test App** VS Code task (`.vscode/tasks.json`)
runs `npm start` and opens the browser. First `npm install` runs on VS Code's prompt / the
task's first run.

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

| You change… | …also update |
|---|---|
| **An environment** (add/edit/remove) | Just use the app's **Environments** panel (writes `config/urls.json`, seeds `.env.example`). Envs are dynamic — `config/environments.ts` reads `urls.json` at runtime; the runner targets `tests/` regardless of env, so no `EnvName` type or `package.json` script edit is needed. Mark exactly one `"default": true`. Add real logins in Settings → Logins. |
| **A public URL** | `config/urls.json` (your real envs) and/or `config/urls.example.json` (the committed template). Never in a test. |
| **The login form / selectors** | `tests/helpers/auth.ts` (the `LOGIN` object) → `context/frontend-structure.md` (the selector table) |
| **How logins are stored** | `users/roles.ts` (loader — env-scoped `<ENV>_<ROLE>_*` with a shared `<ROLE>_*` fallback) → `.env.example` → `.gitignore` → README "First time" |
| **The interface** (run/record/report/history/PDF/tests/creds/bug-bundle/guide) | `interface/server.js` (endpoints) ↔ `interface/index.html` (markup) ↔ `interface/app.js` (logic, hash router) ↔ `interface/styles.css` (theme, light+dark). Keep the four in sync. `app.js`/`styles.css` are served by `server.js` via the `/app.js` + `/styles.css` routes |
| **The PDF report** (fields, layout) | `interface/pdf.js` (HTML→PDF) ← the record written by `tests/helpers/fixtures.ts` (snapshots, browser info, console, network). Image can be a saved snapshot OR a video frame captured in the browser (`imageData` → `/api/pdf`). Change one, check the others |
| **The bug bundle** (dev handoff zip) | `interface/server.js` `buildBugBundle`/`bugSummaryMd` + `interface/zip.js` (zero-dep STORE zip writer). Bundles summary.md + record.json + console/network + screenshots + video + `trace.zip` |
| **The Tests library / per-test results** | `interface/server.js` `listTests`/`specFiles`/`readResults`/`testHistory` (`specFiles` recursively walks `tests/` skipping `helpers/`; parses `test('…')` titles + @tags + the JSON reporter's `test-results/results.json`, aggregated across `runs/` for flaky/never-run/slowest) ↔ `app.js` Tests page + Run-page checklist. If you change the reporter set in `playwright.config.ts`, keep `results.json` |
| **Test tags / metadata / filters** | `@tags` live in the test title (parsed by `parseTests`, matched by `--grep` on run). Group/priority/owner/notes live in `tests/tests-meta.json` (git-ignored, `loadMeta`/`saveMeta`, `/api/test-meta`). Smart filters (failing/flaky/never-run/slowest) are computed client-side in `app.js`. Run-by-tag/one/selected all go through `startRun(env,light,files,grep)` (env only picks the baseURL/logins; `files` empty → all of `tests/`) |
| **Run-page dashboard** (stat tiles + health bar + live checklist) | `app.js` `renderChecklist` (parses Playwright `list` output live; reconciles from `/api/results` on done) ↔ `index.html` Run page (`#statTiles`,`#healthBar`,`#checklist`) ↔ `styles.css` `.stat`/`.health` |
| **Video scrubbing** (Report-a-bug frame capture) | `interface/server.js` `serveRanged` (HTTP Range/206 for `/api/video` — required for `<video>` seeking) + `app.js` `fixVideoDuration` (works around Playwright webm `duration=Infinity`) |
| **Logs at a captured moment** (PDF) | `tests/helpers/fixtures.ts` writes `consoleTimed`/`networkTimed` (ms from test start) → `interface/pdf.js` filters them to ±3s of `opts.time` → `app.js` sends `time` = captured frame's video timestamp to `/api/pdf` |
| **Logins UI** (guided `.env`) | `interface/server.js` `credRoles`/`saveCred` (reads role names from `.env.example`/`.env`, writes env-scoped `.env` vars, never returns values) ↔ `app.js` Settings → Logins ↔ `.env.example` (the role blocks it discovers) |
| **The in-app user manual** | `USER-GUIDE.md` — served raw at `/api/guide`, rendered by `app.js`'s markdown renderer. Keep in step with `README.md` |
| **A user-facing command** (npm script) | mirror it in `.vscode/tasks.json` (the no-typing task) → README |
| **What/where tests capture** (video, screenshot, console, network, trace) | `playwright.config.ts` (`use`/`CAPTURE`) + `tests/helpers/fixtures.ts` (console/network) → README "What gets captured" |
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
