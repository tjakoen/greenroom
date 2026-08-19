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
typing. The interface is a **bold status-dashboard app** (sidebar + real GRAIN routes:
Run / Tests / History / Report a bug / User guide / Settings), served by `bun server.ts` on
the shared layer.

**Two editions from one codebase.** The original **local single-user tool** (loopback, no
accounts — still the default), and a **deployed multi-user platform** one company runs behind
a URL (accounts + sessions, teams + visibility scoping, embedded SQLite, a server-side run
queue, an in-browser editor, an audit log). It stays loopback-locked until you opt in via env.
The split, and everything that follows from it, is in
**[docs/OPERATING-NOTES.md](docs/OPERATING-NOTES.md)**; architecture + phase history in
**[plans/platform.md](plans/platform.md)**; deploying for real in **[DEPLOY.md](DEPLOY.md)**.

**Tests are not tied to an environment.** Every `*.spec.ts` lives flat in `tests/` and runs
against whichever environment you pick; use relative `page.goto('/path')` so the active
environment's `baseURL` applies. They are organised four ways (`@tags` in the title,
sidecar metadata in `tests/tests-meta.json`, smart filters computed from run history) —
detail in [docs/ALIGNMENT.md](docs/ALIGNMENT.md).

## Start here (reading order)

1. **The published BREAD standards index — <https://tjakoen.github.io/standards>.** How we build
   with AI (AI-DEVELOPMENT), session mechanics (SESSION-LOOP), and voice/doc shape (VOICE,
   NOTE-STANDARD, README-STANDARD). These are the cross-repo single source; this repo **references**
   them and never forks them. Read the index first, then fetch only the one the task needs.
2. **[README.md](README.md)** — the user-facing guide (how they actually use the app).
   The in-app version is the **edition-aware guide** in **[docs/guide/](docs/guide/)** (`local`/`team`
   start pages + shared how-to pages; rendered by MILL at `/guide`, raw at `/api/guide`).
3. **[context/frontend-structure.md](context/frontend-structure.md)** + **[context/sitemap.md](context/sitemap.md)** — the fill-in-the-blank map of the app under test.
4. **[docs/ALIGNMENT.md](docs/ALIGNMENT.md)** — the when-you-change-X-update-Y table. Read the row
   for whatever you are about to touch, before you touch it.

**Single sources of truth:**
- Environment URLs → **`config/urls.json`** (git-ignored; seeded from `config/urls.example.json` on first boot; read by both the tests and the recorder). Exactly one entry has `"default": true`. Each entry may also carry an optional **`login`** block (how that env's login form works); a top-level **`_login`** key sets the shared form used by every env that doesn't override it.
- Role *definitions* (names + which envs each maps to) → **`config/roles.json`** (git-ignored; seeded from `config/roles.example.json` + the existing `.env` on first boot). Credentials themselves stay in `.env` only.
- Logins → the user's private **`.env`** (git-ignored; template is `.env.example`).
- Which env(s) are active → **`TEST_ENV`** (single) or **`TEST_ENVS`** (comma-separated, one Playwright project per env) set by the interface; unset → the `"default": true` env.

## Commands

Requires **Bun** (<https://bun.sh>) — the app runs on `bun server.ts` — plus Node.js for
Playwright. `npm start`/`npm run demo` shell out to bun.

```bash
bun install                    # deps + Chromium (postinstall). THE supported installer
npm start                      # the app: LOCAL edition — single-user, no accounts, flat-file config
npm run start:platform         # PLATFORM edition — multi-user accounts + DB (GREENROOM_MODE=platform)
npm run demo                   # boot read-only with seeded demo data (GREENROOM_DEMO=1)
npm run check                  # typecheck the composition root — must stay green
```

Also available: `npm run menu`, `TEST_ENV=<env> npx playwright test`, `npm run record`,
`npm run report`, `npm run check:legacy`.

Non-coders don't type these: the **🚀 Open Test App** VS Code task (`.vscode/tasks.json`)
runs `npm start` and opens the browser; **🎬 Open Demo** runs `npm run demo`. Both `dependsOn`
the **📦 Install dependencies** task (`bun install`), so a fresh clone installs on the first
task run instead of crashing on a missing module.

**Install needs no credentials** (changed 2026-07-30). The `@tjakoen/*` layers are on the public
npm registry, there is no `.npmrc` in this repo, and both `bun install` and `npm install` resolve
clean against an empty `HOME`. The four rules that keep it that way — including *never commit an
`.npmrc` with `_authToken=${GITHUB_TOKEN}`* — are in
[docs/OPERATING-NOTES.md](docs/OPERATING-NOTES.md).

## Non-negotiables

- **No app source enters this repo.** Only derived context (routes, selectors) in
  `context/`. If you need a new fact about the app under test, add it to the context docs.
- **No secrets committed.** Logins live only in `.env` (git-ignored). Never hardcode
  credentials in a test — pull them via `getUser(role)` (reads `.env`). *Platform:* test-target
  credentials also live **encrypted** (`credential.secretEnc`, AES-256-GCM via `lib/secret.ts`,
  keyed by `SECRET_KEY`) in the DB; still never returned to the client, never committed. Greenroom
  **account** passwords are hashed by better-auth. This non-negotiable is unchanged — only stronger.
- **No real environment URLs committed.** `config/urls.json` is git-ignored (a user's real
  environments); only the generic `config/urls.example.json` is committed. Never hardcode an
  environment URL in a test — use relative paths.
- **Tests live flat in `tests/`**, not in per-environment folders. Never reintroduce
  `tests/<env>/` coupling — scope by `@tag`/metadata instead.
- **Keep dependencies at the floor** — *amended by the platform.* The test-runner **core** stays
  minimal, leaning on the shared layer (grain / mill / pantry). The **platform layer** spends the
  budget deliberately on a small, audited set, each justified in
  [plans/platform.md](plans/platform.md) §8. Add nothing else without the same bar.
- **User-first.** Anything a non-coder touches must work with no command typing and no coding.
  *Local:* via the VS Code tasks + the web app. *Platform:* via **a URL** — no pull, no VS Code,
  no terminal; a teammate signs in and uses it.
- **Definition of done** (below) — not "it runs on my machine once."

## Keep it aligned

The when-you-change-X-update-Y table lives in **[docs/ALIGNMENT.md](docs/ALIGNMENT.md)**. Open the
row for what you are changing before you change it — most of this repo's coupling is in there, and
it is the difference between a change that lands and one that half-lands.

The entry point is **`server.ts`**, the BATCH·GRAIN·MILL·PROOF composition root; the whole domain
lives in **`lib/*.ts`**; every human route is a real GRAIN page. The old `interface/` SPA is
**deleted** — when you touch a page, update `server.ts` + its `pages/*` file, there is no other
copy to keep in sync.

## Definition of done

> **Done = the change works end-to-end + `npm run check` (and `npm run check:legacy`) is
> green + the docs in the sync table are updated + the app still boots
> (`npm start` → `bun server.ts`) + a memory if a decision was made.**

For anything a user touches, "works" means *driven the real flow*, not just typechecked.

## Before committing / after a big change

Run the alignment audit — **[AUDIT.md](AUDIT.md)** (no secrets committed, no real URLs
committed, no app source, app boots, typecheck green). Fix findings in the same session.

## Run reports

A run closes with a report in **`artifacts/runs/`**, one file per run, named
`YYYY-MM-DD-<slug>.md`. Its schema and the rule about pasting gate output verbatim are in
[`artifacts/runs/README.md`](artifacts/runs/README.md). PANTRY reads that directory with no
configuration, so nothing in `pantry.config.json` needs to name it.

Do not put a run report in the top-level `runs/` directory. That one belongs to the app, holds
recorded demo runs, and is gitignored.

## Memory

Claude Code keeps per-project memories (decisions, preferences, context) outside the repo;
they surface at session start. Write one when a real decision is made or something
non-obvious is learned. If a recalled memory contradicts the code, trust the code and fix
the memory. Durable, repo-worthy rules belong *in this file*, not in memory.

## The rest

Run commands from the repo root. Commit/push only when asked. For the board, the plans, the
decisions and the docs, run the catalog cockpit from its own checkout — `pantry.config.json` here
is what it reads.

- **No AI attribution trailers on commits** (`Co-Authored-By: Claude` and the like). The receipt for
  "built with Claude" is the README badge + footer, not commit metadata — see the published
  standards' commit convention (<https://tjakoen.github.io/standards>). Claude Code adds the trailer
  by default, so it needs `"includeCoAuthoredBy": false` in `~/.claude/settings.json`; the rule is
  repeated here because pointing at the standards index was not enough on its own (28 commits in
  this repo carried the trailer before it was caught, and removing them meant rewriting published
  history). Check with `git log -E --grep="^Co-Authored-By:" --oneline` before a push — anchor it to
  the line start, or the pattern also matches docs (this bullet included) that merely *name* the
  trailer, and a clean repo reports itself dirty.
- **Check what a file says with `git show origin/main:<path>`, never by reading the working tree.**
  This checkout and the published repo drifted apart for two weeks without either side noticing,
  because the local lineage was a pre-rewrite copy with no upstream tracking. The cost was a real
  wrong answer: the 2026-08-18 audit recorded the README CI badge as fixed while the public README
  still had no badge, because it read the file on disk. The working tree tells you what *you* have.
  A stranger cloning the repo gets `origin/main`, so any claim about what this repo says in public
  has to be read from there. Fetch first, since `origin/main` is only as fresh as your last fetch.
