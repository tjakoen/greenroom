# OPERATING-NOTES.md — install, editions, working notes

The depth behind `CLAUDE.md`'s Commands and What-this-is sections: how install actually resolves,
and how the two editions differ. Split out so the front door stays a one-minute read.

## Install notes

> **Install is `bun install`, and it needs no credentials** (changed 2026-07-30; the notes below
> replace the old "needs a `read:packages` token" rule, which no longer applies):
> 1. **`@tjakoen/{batch,grain,mill,proof}` are on the PUBLIC npm registry**, published from the
>    `grain` monorepo (`packages/*`) and the `batch` repo. There is **no `.npmrc` in this repo**,
>    so the scope resolves to npmjs by default. Verified against an empty `HOME` with a purged
>    cache: 82 packages, typechecks green, the shipped specs green, every page 200. (That check
>    once read "44/44 tests" — that figure is the `bun test lib` suite, not the specs.) **The healthy
>    state of a fresh clone is `3 passed, 1 failed, 1 skipped`** (verified 2026-08-04 against a
>    genuinely fresh clone). The failure is `example-failure.spec.ts` failing **on purpose**, so a red
>    run has something to show; the skip is `login.spec.ts`, which skips until you save an `admin`
>    login. An earlier version of this note said "4 green + 1 deliberate red", which counted the
>    skipped spec as green — so anyone checking their clone against it saw "3 passed" and reasonably
>    concluded something was broken.
> 2. **Never commit an `.npmrc` with `_authToken=${GITHUB_TOKEN}`.** When the var is unset it
>    resolves *empty* and overrides the user's valid `~/.npmrc` token, so every install 401s on a
>    cold cache — invisible locally, fatal on a new machine.
> 3. **`@tjakoen/pantry` was removed** as a devDependency: nothing imported it, and it alone
>    caused the nested git-dep wall (hence no committed lockfile), the `npm install` failure (a
>    dead `tjakoen.github.io#afc640a` pin), and a `mill ^0.1.2` requirement that blocked the
>    tokenless install. Run the catalog cockpit from its own checkout; `pantry.config.json` stays.
> 4. **`@tjakoen/crumb` (guided tours) IS now a dependency** (`0.1.4`, published to npmjs
>    2026-07-30 — this reverses the old "intentionally not a dependency / not yet published"
>    rule). `server.ts` still imports it via a variable specifier in `try/catch`, so the app
>    degrades to tours-disabled if it's ever absent; keep that guard.
> 5. Prefer `bun install`; `bun.lock` stays git-ignored. **`npm install` now resolves too** (83
>    packages against an empty `HOME`, verified 2026-07-31) — the `pantry` git pin that used to
>    abort it is gone. Neither installer needs credentials.

## Editions + working notes

- **Two editions from one codebase (real toggle — `lib/paths.ts` `IS_PLATFORM`/`IS_LOCAL`).**
  (1) **Local** (default) — single-user tool, loopback, **no accounts/sessions**, config in flat
  files (`.env`/`config/*.json`), runs via the **legacy runner** (`lib/runner.ts` `startRun`). The
  embedded DB is **never opened** and better-auth is **never built** — every db/auth path is gated
  off in `server.ts` and sits behind lazy handles (`db/index.ts` `openSqlite`/lazy `db`+`sqlite`
  proxies; `auth/index.ts` `makeAuth`/lazy `auth` proxy). The Editor still works (disk-only, no
  version history — that's a platform feature; `pages/editor-api.ts` `editorLocal`). Rail hides
  Accounts/Environments/Admin; `/login` 302s to `/run`; `/api/auth/*` 404s.
  (2) **Platform** — multi-user deployment: better-auth accounts + sessions (the whole session gate),
  the SQLite DB (scoped/audited config, encrypted creds), the server-side **run queue**
  (`enqueueRun`), Accounts/Environments/Admin. **Opt in** with `GREENROOM_MODE=platform`, or
  implicitly by setting `ALLOWED_HOSTS` (a real deployment is always platform — [DEPLOY.md](../DEPLOY.md)).
  **Demo** (`GREENROOM_DEMO=1`) is a read-only *local* variant (no accounts, DB untouched).
  Recording uses a real browser on the user's screen (local-only — a headless deploy can't open a
  codegen window; refused on a deployed instance, Gate E). Both editions run from `bun server.ts`.
- **VS Code is the primary entry point *for local use*.** Users open the folder in VS Code and use
  the `.vscode/` tasks (**🚀 Open Test App**, run/record/report) + the Testing panel; the web app at
  `localhost:4321` is the surface once started. On a **deployed** instance the entry point is just
  the URL — no VS Code, no clone.
- **Open source, stays generic.** Still a generic starter — no data about any specific app under
  test, and no company/deployment specifics (company name, Entra tenant, host, `SECRET_KEY`), in
  committed files. The platform is deployable by any company; a given company's instance is
  configured entirely via git-ignored config + env + the DB (see [plans/platform.md](../plans/platform.md) §0.5).
  Keep `context/` and `*.example` files generic; real values live in git-ignored `urls.json`/`.env`/DB.
- Run commands from the repo root.
- Commit/push only when asked.
