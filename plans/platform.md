---
id: platform
status: todo
track: platform
depends: [p6-cutover]
touches: [server.ts, lib/, pages/, db/, auth/, config/, tests/]
owner: human
---

# PLATFORM — Greenroom → multi-user company platform (2026-07-18)

> **Status: proposed, awaiting review.** This plan layers a **deployed, multi-user platform**
> on top of the current single-user local tool. It is the biggest identity change in the
> repo's history: it **overturns four CLAUDE.md non-negotiables** — local-only, zero-dep,
> VS Code as entry point, **and (undecided) the open-source generic-starter identity** (§0.5).
> Those rules get rewritten when Phase 1 lands — deliberately, not by drift. This plan sits
> alongside the in-progress BREAD migration (`PLAN.md`); see §9 for the dependency between
> them. Per the repo's own rule (no org names in committed files), this plan says "the
> company" throughout — the deployment target is the single company that operates it.

Owner: Tjakoen. Locked decisions (from kickoff): **Microsoft Entra (Azure AD) OIDC** for SSO ·
**single-server queued** run execution · **embedded SQLite** (`bun:sqlite`) as the datastore ·
plan-first.

---

## 0. What changes about the project's identity

| Today | After |
|---|---|
| Local app, loopback-bound `127.0.0.1`, one trusted user | Deployed, bound to a host, many concurrent users |
| No app accounts — every "user/role/login" = **test-target** creds | Real **app accounts** (Greenroom users) *plus* the existing test-target creds, kept separate |
| Entry = VS Code task / `npm start` on a laptop | Entry = a URL. No pull, no VS Code, no terminal |
| Playwright runs on the user's own machine | Playwright runs **on the server**, queued, shared |
| Persistence = flat JSON + artifact dirs | Persistence = **SQLite** (accounts, teams, tests, scopes, audit); artifacts stay on disk keyed by run |
| `lib/guard.ts` = loopback-only, single-trusted-user | Real **session auth + authorization** (scopes, superadmin) |
| Zero runtime deps | Adds: Drizzle, better-auth, Monaco (justified — see §8) |

**Preserved:** the whole test-authoring/running/reporting surface (Run/Tests/History/Report-a-bug),
the GRAIN shell, artifact capture (video/trace/screenshots/console/network), the PDF + bug-bundle
export. This plan adds a **platform layer around** that surface; it does not rewrite it.

**Scope note (single-company internal).** Single company, everyone may read everything. Scopes are
for **organization and accountability, not a hard security wall between teammates**. Superadmins
see and do everything. That is the threat model — design to it, don't over-engineer isolation.

## 0.5 Open-source identity — decide before P1

CLAUDE.md has a 4th rule this plan collides with: **"Open source. This is a generic starter — no
data about any specific app under test belongs in committed files (URLs, selectors, routes,
credentials, org names)."** A deployed internal platform pulls the other way. Options:

1. **Stay generic (recommended).** The platform layer itself is generic (any company can deploy
   it): company name, Entra tenant ids, host, SUPERADMIN_EMAIL all live in git-ignored config /
   env / the DB — exactly like `urls.json` today. AUDIT §7's brand-string grep keeps passing.
   Open-source value survives; the company's deployment is just an instance.
2. **Private fork.** Fork to a private repo for the company instance; upstream stays the generic
   starter. More freedom, dual-maintenance cost.

Option 1 unless a concrete need forces 2. Either way: **recorded, app-specific specs must never
be committed** — today nothing stops `git add tests/` from committing a recorded spec full of the
real app's selectors (found live in this audit). Interim fix: gitignore non-`@example` specs or
document the rule; the DB test store (§3) solves it structurally (user tests live in the DB, only
the Examples seed ships in git).

---

## 1. Target architecture

```
server.ts (Bun.serve — now binds 0.0.0.0:PORT behind the company network / reverse proxy)
├─ auth        better-auth: sessions, email+password, Entra OIDC (SSO), org/teams, admin
│              → session middleware in handle(): every /api/* + page route resolves req → user
├─ authz       scope.ts: canRead/canWrite(user, entity) over visibility + team membership + superadmin
├─ db          Drizzle + bun:sqlite (WAL), ./data/greenroom.db — schema §3, migrations §7
├─ queue       run-queue.ts: DB-backed job table, N worker slots, one shared Playwright host
├─ editor      Monaco served as a page; /api/test-source GET/PUT with version history
├─ audit       audit.ts: append-only log on every write (who/what/before/after)
│
│  ── everything below is TODAY's stack, mostly unchanged, now scope-aware ──
├─ BATCH/GRAIN/MILL/PROOF   shell, pages, docs, plan board (as-is)
├─ lib/runner.ts            spawns playwright, but now pulled by the queue, not called direct
├─ lib/records.ts          run archive on disk (runs/<id>/) — keyed by run, unchanged bytes
└─ pages/*                  Run/Tests/History/Bug + NEW: Accounts, Editor, Admin, scope pickers
```

Key shifts from today:
- **Bind + guard.** `lib/guard.ts` stops being "loopback-only." It becomes: TLS-terminating
  reverse proxy in front (nginx/caddy — ops, not app), app requires a valid **session** on every
  route, keeps the cross-origin-write + JSON-content-type gates. Loopback self-probe on
  `EADDRINUSE` is dropped (server is long-lived, single instance behind the proxy).
- **Runs go through a queue.** `runner.ts startRun` is no longer called directly by `/api/run`;
  `/api/run` enqueues a job, the queue's worker slots call `startRun`. One Playwright host,
  bounded concurrency (browsers are heavy). Live SSE stream keys by `runId`, not a global singleton.
- **Flat-file config becomes DB-backed but scoped.** `config/urls.json`, `roles.json`,
  `groups.json`, `tests/tests-meta.json` → tables (§3, §7). Test **spec files** stay on disk in
  `tests/` (Playwright needs real files to run) but gain a **DB mirror** of source + version
  history + scope; the queue materializes the right specs before a run.
- **`.env` test-target secrets stay in `.env` semantics but move behind the DB.** Credentials for
  the *app under test* are still secrets, still never returned to the client, now stored encrypted
  in a `credential` table (§3) instead of the flat `.env` — so they can be team/company scoped and
  survive a multi-user deployment. Greenroom **account** passwords are handled entirely by
  better-auth (hashed), never in `.env`.

---

## 2. Auth & SSO (Microsoft Entra OIDC)

**Library: `better-auth`.** Chosen because its plugin set maps almost 1:1 to the requirements and
it is Bun + Drizzle native:

| Requirement | better-auth mechanism |
|---|---|
| Accounts + login flow | core email/password + session cookies |
| SSO (Entra) | **`@better-auth/sso`** (separate package since 1.3) — OIDC + SAML 2.0; Entra ID identity validation is explicitly supported/hardened upstream |
| Teams with scopes | `organization` plugin → one org (the company) + **teams**, membership, per-team roles |
| Superadmin | `admin` plugin → `role: admin` bypass + user management UI hooks |
| Accountability | session + user id on every request → feeds the audit log |

Verified 2026-07-18: SSO plugin ships OIDC + SAML 2.0 in its own package; the Drizzle adapter and
the Bun SQLite driver are actively maintained (recent affected-rows + param-binding fixes for Bun).

**Entra setup (ops, documented in the plan, not code):** register an App in the company's Entra
tenant → redirect URI `https://<host>/api/auth/sso/callback/entra` → client id + secret + tenant
id → config (all git-ignored / env — never committed, per §0.5). Scopes `openid profile email`. First
login auto-provisions a Greenroom account from the Entra profile (email as the natural key).
Email/password stays enabled as a fallback for non-SSO/service accounts; can be disabled later by
policy.

> **P0 spike B correction:** Entra is **NOT static plugin config**. `@better-auth/sso` (separate
> package, `@better-auth/sso@1.6.23`, now installed) registers providers at **runtime** via
> `auth.api.registerSSOProvider` (`POST /sso/register`), which runs OIDC discovery against the
> tenant issuer. So P3 = a one-time superadmin action / boot-seed that registers the Entra provider
> from env config, not a literal `sso({ providers: [...] })` block. Sign-in = `auth.api.signInSSO`;
> callback = `/api/auth/sso/callback/:providerId`.

**Provisioning + roles.** First user (or a seeded env var `SUPERADMIN_EMAIL`) becomes superadmin.
New SSO logins land in a default team = "Unassigned" until a superadmin assigns them. Team
membership drives scope; superadmin bypasses all of it.

**Session model.** better-auth session cookie; `handle(req)` gains a resolve-session step that
attaches `req.user` (id, email, teams[], isSuperadmin) before dispatch. Unauthenticated → redirect
to `/login` for pages, `401` for `/api/*`.

---

## 3. Data model (Drizzle + SQLite)

Sketch — not final DDL. `visibility` enum = `'private' | 'team' | 'company'` reused across every
shareable resource (tests, environments, accounts). "Account" below = a **test-target credential
set** (an account *on the app under test*), which is the "accounts tab" the user described — NOT a
Greenroom login (those are `user`).

> **P0 spike B — table ownership + migration flows (settled).** One physical db file
> (`data/greenroom.db`), **two migration runners** against it:
> - **better-auth owns** `user`, `session`, `account`, `verification` (+ the `organization`/`admin`/
>   `sso` plugin tables). It uses its **built-in `bun:sqlite`** support (Kysely under the hood) —
>   **not** the Drizzle adapter. Its tables are created by better-auth's own runner.
> - **We own** the app tables below (`environment`, `credential`, `role`, `envGroup`, `test`,
>   `testVersion`, `run`, `runResult`, `auditLog`) via **drizzle-kit** generate + `migrate()`.
> - No name collisions; both point at the same `Database` handle. **Boot sequence:** open db → WAL
>   pragma → better-auth `runMigrations()` → drizzle `migrate()` → serve.
> - **jiti/bun gotcha:** `bunx @better-auth/cli` and any config-loader using jiti **cannot import
>   `bun:sqlite`**. Do NOT use the auth CLI. Migrate by calling `getMigrations` from
>   **`better-auth/db/migration`** directly in a `bun` script. drizzle-kit `generate` is unaffected
>   (its config imports only the pure-JS schema, not `bun:sqlite`) — but never point drizzle-kit
>   `push`/introspect at a bun-scheme config for the same reason.
>
> So the §3 `user`/`session`/`oauthAccount` rows below are **better-auth's**, shown for reference —
> don't hand-write them in our Drizzle schema. `isSuperadmin` comes from the `admin` plugin's role,
> `team`/`teamMember` from the `organization` plugin — check the plugins' generated columns before
> duplicating; our Drizzle schema only defines the app tables the plugins don't provide.

```
── identity (mostly owned by better-auth's generated tables) ──
user            id, email, name, image, isSuperadmin, createdAt        -- Greenroom login
session         id, userId, expiresAt, ...                             -- better-auth
oauthAccount    userId, provider('entra'), providerAccountId, ...      -- SSO link
team            id, name, slug, createdAt
teamMember      teamId, userId, role('owner'|'member')                 -- user ∈ many teams

── shareable resources — all carry (ownerId, teamId?, visibility) ──
environment     id, name, baseURL, isDefault, loginForm(json),
                ownerId, teamId, visibility, createdAt, updatedAt      -- was config/urls.json
credential      id, label, envId?, teamId?, ownerId, visibility,
                username, secretEnc(encrypted), createdAt              -- was .env (test-target creds)
role            id, label, envScope(json), ownerId, teamId, visibility -- was config/roles.json
envGroup        id, label, envIds(json), roleId, ownerId, teamId, visibility  -- was config/groups.json

test            id, title, filePath, tags(json), group, priority,
                owner, notes, runAsRole, ownerId, teamId, visibility,
                createdAt, updatedAt                                   -- was tests-meta.json + spec file
testVersion     id, testId, source(text), authorId, message,
                createdAt                                              -- edit history (accountability)

── runs (metadata in DB, artifacts stay on disk) ──
run             id, envLabel, status, startedAt, finishedAt,
                triggeredBy(userId), scope(json), artifactDir          -- runs/<id>/ on disk
runResult       id, runId, testId, env, status, durationMs            -- flattened per (test,env)

── accountability ──
auditLog        id, actorId, action, entity, entityId,
                before(json), after(json), createdAt                   -- append-only, never updated
```

Notes:
- **`secretEnc`** — test-target passwords encrypted at rest with a server key (`SECRET_KEY` env).
  Never returned to the client (mirror today's "username shown, password never shown" rule).
- **Test spec files stay on disk** (`tests/*.spec.ts`) — Playwright runs real files. `test.source`
  of truth for *editing* is `testVersion` (latest row); on save we write the row **and** the file,
  and the queue materializes files before a run. This gives version history for free.
- **Artifacts stay on disk** in `runs/<id>/` exactly as today (`lib/records.ts` unchanged); the DB
  only holds run **metadata** so History/Bug pages can list + scope without walking the filesystem.

---

## 4. Scoping & authorization

One helper module `authz`/`scope.ts`:

```
canRead(user, r)  = user.isSuperadmin
                 || r.visibility === 'company'
                 || (r.visibility === 'team'    && user.teams.includes(r.teamId))
                 || (r.visibility === 'private'  && r.ownerId === user.id)
canWrite(user, r) = user.isSuperadmin || r.ownerId === user.id
                 || (r.visibility === 'team' && teamRole(user, r.teamId) === 'owner')
```

- Applied uniformly to `environment`, `credential`, `role`, `envGroup`, `test`, `run`.
- **Company-internal reality:** default new resources to `visibility: 'company'` (everyone reads),
  so the tool stays frictionless; the user *chooses* to narrow to team/private. This matches the
  described default for accounts and extends it to envs + tests.
- **List endpoints** filter by `canRead`; **write endpoints** enforce `canWrite`; superadmin routes
  under `/admin` require `isSuperadmin`.
- Every write passes through `audit.ts` → `auditLog` row, so "who changed this env / edited this
  test / shared this account" is always answerable.

---

## 5. In-browser test editing (Monaco)

- New **Editor** page (`pages/editor-page.ts` + `pages/editor.js`) hosting **Monaco** (VS Code's
  editor — the "VS Code feel without VS Code"). TS language + Playwright type defs loaded for
  autocomplete/inline errors.
- `GET /api/test-source?id=` → latest `testVersion.source` (scope-checked). `PUT /api/test-source`
  → writes a new `testVersion` row (author = session user, optional commit message) **and** the
  spec file, then `audit`. History drawer lists versions with author + timestamp + diff; restore =
  write a new version from an old one (never mutate history).
- Guardrails: server-side lint/parse the saved source (reject unparseable TS) before it can run;
  the file write is scoped to `tests/` via the existing `validTestFile` traversal guard.
- "Run this" from the editor enqueues a run of just that spec.

**Built so far (ahead of p6-cutover — the editor is a new GRAIN route, touches no `interface/`):**
- **P4-0 — grain `code-editor` organism** (`components/organisms/code-editor/`, CSS + catalog `.md`
  + `.ai.md`). Monaco-free chrome by construction (grain ships no JS bundler): frame + toolbar +
  `.code-editor__mount` slot the consumer injects the engine into + `data-state` status strip +
  diagnostics list + `data-history` version drawer. Reuses code-block's mono/surface tokens so
  MILL blog code and the editor read as one system. Committed in the grain monorepo clone
  (`packages/grain/...`), **vendored** into greenroom's flat `node_modules/@tjakoen/grain` (nested-git
  wall — see package.json `//dependencies`); auto-picked-up by `createStyleBundle` → `/components.css`
  and auto-discovered by the catalog. Not yet pushed upstream / pinned (grain `main` went `packages/`
  monorepo; greenroom stays on the flat vendored copy).
- **P4-A — `pages/editor-api.ts`** (wired in `server.ts` dispatch after `environmentsApi`), over the
  existing `test`/`testVersion` tables:
  - `GET /api/test-source?file=` → the file's **disk** source (not the latest version row): other
    writers (`applyInputs`/`saveTags`) touch the disk without a DB version, so disk is what the
    runner runs + what reflects every edit. Scope-checked via the file's canonical `test` row.
  - `PUT /api/test-source {file,source,message?}` → **parse guard** (Bun.Transpiler — rejects
    unparseable TS before it reaches disk/runner), then `writeFileSync` + a new `testVersion` row +
    `audit`. Traversal-guarded by `validTestFile`.
  - `GET /api/test-versions?file=` (history, newest-first) + `GET /api/test-version?id=` (one
    snapshot's source, for restore/diff).
  - `POST /api/validate {file}` → the strong check: `playwright test --list <file>` compiles +
    collects the spec in a browser-less Playwright context **without running** — catches import/
    collection errors the parse guard misses (proven). Parse-guards first to skip the spawn on
    syntax errors. Demo-guarded (no spawns/writes in demo).
  - **Canonical test row:** versions are schema-keyed per `test()` row but the editor edits a whole
    FILE, so the file's version chain anchors to one canonical row (oldest by `createdAt`, then `id`);
    `ensureCanonicalTest` creates a minimal row (owned by the saver) for files with no `test` row yet.
- **P4-B — `/editor` page** (`pages/editor-page.ts` skeleton + `pages/editor.js` client, NAV entry,
  `active:"editor"`), rendering the grain `code-editor` chrome. Monaco is **lazy self-hosted**:
  server.ts serves `node_modules/monaco-editor/min/vs` byte-preserving under `/vs/` (allow-listed
  static, `serveVs` + `safeResolve` guard); editor.js injects `/vs/loader.js` on first file open
  (classic AMD, `require.config({paths:{vs:'/vs'}})`), so Monaco's weight lands only on this page.
  Wires: file picker (from `/api/tests`, deduped by file) → open (GET disk source) → edit (live
  squiggles + dirty tracking) → **Save** (PUT, parse-guarded, ⌘S too) → **Validate** (POST, real
  `--list`) → **History** drawer (versions, click a row to load an old snapshot into the buffer;
  restore = Save it as a NEW version). Server diagnostics (layers 2/3) paint back as Monaco markers +
  the `__diag` list (click-to-jump). On-brand light theme from grain's paper/ink tokens (dark →
  vs-dark). `@playwright/test` given a compact ambient `.d.ts` for autocomplete; TS 2307
  (module-not-found for relative helper imports Monaco can't resolve) silenced — the server `--list`
  is the real module-resolution authority. **Verified end-to-end** in a headless authed browser
  (13 checks: mount, load, edit→dirty, Save→version, History, Validate→valid, zero console errors).
- **P4-C — done:** "Run this" (POST `/api/run {files:[spec]}` default env → navigate to `/run`;
  confirms first if the buffer is dirty, since the runner executes the file on disk); a **restore
  diff overlay** (clicking a history version opens a Monaco side-by-side diff of that version vs the
  current buffer — non-destructive; Restore then loads it in as an edit, Save persists a new version);
  and a **commit-message field** in the toolbar (sent as `message` on PUT, shown in the history rows).
  Verified end-to-end (19 checks: + message persists to history, diff is non-destructive, restore →
  dirty buffer, Run this → `/run`).
- **Write-scope — RESOLVED (editing gated on READ, not write):** the earlier gap was that `canWrite`
  (owner/superadmin/team-member) blocked non-owners from saving `visibility:'company'` specs (incl.
  P1's `ownerId:'system'` imports). Fix: `putSource` gates on `canRead`, not `canWrite` — tests are
  the collaborative artifact this tool edits, and the scope.ts doctrine is "company-internal,
  everyone may read/write by default; scope is for accountability, not a wall." Anyone who can SEE a
  spec can edit it; a private spec they can't read stays 403. Accountability is kept via
  `testVersion.authorId` + audit on every save. This is deliberately looser than `canWrite`, which
  still guards the sensitive resources (credentials/environments/roles) in their own APIs — the
  change is scoped to editor-api only, scope.ts is untouched.

---

## 6. Server-side run queue

- `run-queue.ts`: a `run` job table + an in-process pool of **N worker slots** (config, default
  small — browsers are RAM-heavy). `/api/run` **enqueues** (scope-checked) and returns a `runId`;
  workers pull queued jobs FIFO and call the existing `runner.startRun`.
- **Per-run isolation — more than the archive dir.** Today `test-results/`, `results.json` and
  `playwright-report/` are **shared, overwritten-each-run** paths (`records.ts` copies them into
  `runs/<id>/` only after the run closes). Two concurrent runs in the same cwd clobber each other.
  The queue must give every job its own live output dirs from the start — Playwright's
  `--output <dir>` + per-run reporter output paths (JSON + HTML) pointed straight at
  `runs/<id>/`, killing the copy-on-close step. `archiveRun`'s stale-mtime guard becomes obsolete.
  Live output SSE keys by `runId` (today's `run-stream.ts` singleton becomes a per-run map).
- **Per-run config/cred handoff.** The Playwright **child process** reads `config/urls.json`
  (via `config/environments.ts`) and `.env` (via `users/roles.ts` + dotenv) — neither exists once
  envs/creds live in the DB. The queue worker resolves both from the DB at spawn time and hands
  them to the child as **env vars** (the existing `<ENV>_<ROLE>_USERNAME/PASSWORD` contract, plus
  a serialized env-map var or a per-run materialized `urls.json` snapshot in the run's temp dir).
  Decrypted secrets exist only in the child's environment for the life of the run — never on disk.
  Same applies to spec materialization: a per-run temp tests dir needs `tests/helpers/` alongside
  the specs (relative imports).
- **Concurrency cap** protects the shared host; queued jobs show position/ETA. Stop/kill still works
  per run (existing group-kill in `runner.killProc`).
- Config knobs: max parallel runs, per-run timeout, artifact retention (today: 30 runs / 3 GB — keep,
  make configurable).
- This is the **single biggest new subsystem** and the main scale risk (§10).

---

## 7. Migrating today's flat-file data

One-shot importer (`scripts/import-flatfiles.ts`, run once on first boot of the DB build):

| Flat file | → table | Mapping |
|---|---|---|
| `config/urls.json` | `environment` | each non-`_` key → row; `_login`/env `login` → `loginForm` json; `default:true` preserved. Owner = superadmin, `visibility: company` |
| `config/roles.json` | `role` | defs → rows, `envs` → `envScope` |
| `config/groups.json` | `envGroup` | presets → rows |
| `tests/tests-meta.json` | `test` + seed `testVersion` | sidecar `file::title` → `test` row; read the spec file → initial `testVersion` |
| `.env` (`<ENV>_<ROLE>_*`) | `credential` | parse → encrypted `secretEnc`; **do not commit; delete `.env` semantics after import** |
| `runs/<id>/` | `run` + `runResult` | walk existing archive → metadata rows; artifacts stay in place |

`config/*.example.json` and the committed `tests/tests-meta.json` Examples seed stay as the
**fresh-install seed** (imported into a new DB so a clean deploy still has the Examples group).

---

## 8. Dependencies & the zero-dep ethos

This pivot **spends** the zero-dep budget deliberately. New runtime deps and why each earns its place:

| Dep | Why | Alternative rejected |
|---|---|---|
| `drizzle-orm@0.45.2` + `bun:sqlite` | Typed schema, migrations, one-line Postgres swap later. `bun:sqlite` is built into Bun — the embedded store, zero install | Hand-rolled SQL (no migrations/types); Prisma (heavier, worse Bun story) |
| `better-auth@1.6.23` (+ `@better-auth/sso`) | Sessions + Entra OIDC + org/teams + admin in one Bun/Drizzle-native lib | Hand-rolled auth (SSO + sessions is a security footgun); Lucia (now deprecated) |
| `monaco-editor@0.55.1` | In-browser code editing with the VS Code feel + TS intellisense | CodeMirror (lighter but less "VS Code"); textarea (no intellisense) |

**Install de-risked (P0, 2026-07-18):** all installed via **incremental `bun add`** on top of the
existing vendored `node_modules` — the GRAIN git-deps stayed put, no re-resolution, `bun server.ts`
still boots. So **local dev dep-adds are NOT blocked** by the fresh-clone problem. `bun add` migrated
`package-lock.json` → `bun.lock` and added them to `package.json` (tracked). The fresh-clone /
CI blocker in §10 is unchanged — it's about resolving the graph *from scratch*, which we still don't
do (we add onto the vendored tree). Now in `package.json`: `drizzle-orm@0.45.2`, `better-auth@1.6.23`,
`@better-auth/sso@1.6.23`, `monaco-editor@0.55.1` (deps) + `drizzle-kit@0.31.10` (dev).

### P0 verdict — all three spikes GREEN (2026-07-18)

| Spike | Result | Load-bearing finding for P1 |
|---|---|---|
| A · Drizzle+`bun:sqlite` | ✅ runs | `drizzle-orm/bun-sqlite` + `/migrator`; `drizzle-kit generate` + `migrate()` zero-friction; layout `db/{schema.ts,index.ts,migrations/}` + `drizzle.config.ts`; `tsc` clean under `verbatimModuleSyntax` (use `import type`) |
| B · better-auth | ✅ runs | built-in `bun:sqlite` (no adapter); one db two migration flows (see §3 box); **no auth CLI** (jiti/bun), migrate via `getMigrations` from `better-auth/db/migration`; `auth.handler` is drop-in `if (p.startsWith("/api/auth")) return auth.handler(req)`; Entra = runtime `registerSSOProvider` (see §2 box) |
| C · Monaco | ✅ renders headless, zero console errors | self-hosts with **no bundler / no manual worker config** (0.55.1 bakes worker resolution) — just serve `min/vs/` static + `require.config({paths:{vs:'/vs'}})`; lazy on editor page only; ship TS-only subset (~7.7M of 15M, drop other langs + non-EN locales + css/html/json workers) |

Spike code kept under `spike/{db,auth,monaco}/` for reference — delete or fold into real `db/`,
`auth/`, editor page when P1/P4 build them. No production file was touched by the spikes.

CLAUDE.md's "keep dependencies at the floor" rule gets **rewritten** to "floor for the test-runner
core; a small, audited set for the platform layer." Monaco is the heaviest — it can load lazily on
the Editor page only, so the rest of the app stays light.

---

## 9. Relationship to the in-progress BREAD migration (`PLAN.md`)

- The BREAD migration (P1–P6) is landing the GRAIN shell + real routes; P6 (cutover, delete
  `interface/`) is **not done**. This platform plan assumes the **GRAIN stack** (it builds new
  pages as `pages/*` + `server.ts` routes), so:
  - **Do P6 cutover first** — this plan's frontmatter `depends: [p6-cutover]` gates the board on it.
  - Exception that doesn't violate the gate: P0 spikes and P1's new modules (`db`, `auth`, `scope`)
    touch neither the frozen SPA nor existing pages, so that work may start while cutover is in
    flight. No platform **pages** before cutover.
- After this plan lands, `PLAN.md`'s "local-only / zero-dep / loopback" invariants are superseded by
  §0 here; update both `PLAN.md` and `CLAUDE.md` in the same change that ships Phase 1.

---

## 10. Risks & open questions

- **Run concurrency / host load** — N headless Chromium at once is the real scaling ceiling. Start
  with a low cap; measure. If it saturates, the "dedicated worker pool" option (deferred at kickoff)
  is the escape hatch — the queue table already models it.
- **Fresh-clone install is currently broken** (package.json note: nested GRAIN git-deps can't be
  resolved from scratch, repo runs from a vendored `node_modules`). A **deployed** platform needs a
  reproducible build/CI. **This must be solved before deploy** — likely vendor/lock the GRAIN deps or
  publish them to a private registry. Blocker for "deployed," not for Phase 1 dev.
- **Bun in production** — `Bun.serve`/`bun:sqlite` are production-grade, but confirm the deploy target
  (container? which host?) runs Bun. Playwright still needs Node + browsers on the same host.
- **Secret encryption key management** — `SECRET_KEY` for `credential.secretEnc` must be a real
  managed secret, not committed. Loss = unreadable test creds (re-enterable, not catastrophic).
- **Recording cannot work as-is on a deployed server.** `npm run record` / the Tests-page Record
  flow launches `playwright codegen` — **a real browser window on the user's screen**. On a server
  there is no screen. This is a core flow with no server-side equivalent. Options, pick in P4/P5:
  (a) keep recording a *local companion* mode (run greenroom locally just to record, spec syncs to
  the platform DB); (b) drop codegen for deployed mode — Monaco + snippets + "pick selector from a
  live trace" becomes the authoring story; (c) later: remote codegen over CDP to a
  server-launched headful browser streamed to the client (heavy — don't build first). Until
  decided, the deployed Tests page must hide Record, not break it.
- **Monaco without a bundler.** The repo deliberately has no bundler (`makeModuleServer` serves
  plain TS). Monaco is large and worker-based — the P0 spike must prove it loads self-hosted
  (static `min/` assets + its web workers) under this serving model, lazily on the Editor page only.
- **Artifact routes need auth too.** `/report/*`, `/runs/*`, `/api/video` (Range/206), `/api/pdf-image`
  are byte-serving routes — they must sit **behind the session check** like every page; easy to
  forget because they're static-file paths.
- **Backups.** `data/greenroom.db` + `runs/` are now shared company state, not a scratch dir.
  P6 deploy hardening includes a backup story (SQLite online backup / litestream-style copy + runs/
  snapshot or acceptance that artifacts are re-runnable).
- **Entra tenant access** — need an admin in the company's Entra tenant to register the app +
  grant redirect URIs. External dependency; start early.
- **Data residency / PII** — org policy: no customer PII in the system. Test-target creds are
  *service/test* accounts, not customer data — keep it that way; audit log stores actor emails
  (company staff), which is fine internally.

---

## 11. Phases (each ends green + docs updated + a memory if a decision was made)

| P | Ships | DoD |
|---|---|---|
| **P0 ✅ DONE (2026-07-18)** | Spike: `bun:sqlite`+Drizzle; better-auth email/password login round-trip; Monaco renders a spec read-only self-hosted. De-risk the 3 new deps | ✅ all 3 spikes ran green; deps installed; findings in §8 verdict table |
| **P1 ✅ DONE (2026-07-18)** | `db/` (9 app tables, drizzle-kit migrations, WAL boot) · `auth/` (better-auth + organization/admin/sso plugins, `auth.handler` mount, session gate in `handle()`, `/login` page) · `scripts/import-flatfiles.ts` (envs/roles/groups/tests+versions/runs/**credentials**) · `lib/secret.ts` (AES-256-GCM) | ✅ **live-verified end-to-end**: unauth page→302 `/login`, unauth API→401, sign-up→session→200; real `data/greenroom.db` imported 3 envs / 1 role / 1 group / 8 tests+versions / 14 runs / 22 results / 2 encrypted creds; importer idempotent; both typechecks green. **Follow-ups deferred:** first-user→superadmin promotion + `SUPERADMIN_EMAIL` seed (P2/P3); runner still reads `.env` (DB cred copy unused until P5 queue); `CLAUDE.md` non-negotiables NOT yet rewritten (do at commit/merge time — see §9) |
| **P2 ✅ DONE (2026-07-20)** | `lib/scope.ts` (canRead/canWrite) + `lib/audit.ts` (append-only, secret-redacting) + superadmin/single-org/"Unassigned"-team bootstrap · `/admin` (users+teams+**audit view**, superadmin-only) · **Accounts tab** (scoped encrypted test-target creds) · **Environments tab** (DB + dual-write `urls.json` for the runner) · all wired into `server.ts` via a handler-module contract (`pages/*-api.ts`) | ✅ **live-verified**: normal user C could NOT see user B's `private` account but saw `company` ones; normal user→admin API 403; superadmin saw all; secrets never in list responses; every mutation audited + actor-email-resolved in the `/admin` audit view; both typechecks green; app boots. **Deferred:** team-write degrades to any-member (better-auth `teamMember` has no role col — `// TODO tighten`); superadmin needs org `owner` role for org-plugin team ops (`ensureOrgOwner`); creds still don't drive real runs until P5 |
| **P3** | **Entra OIDC SSO** (§2): runtime `registerSSOProvider`, callback, auto-provision. **Blocked on** a company Entra-tenant admin registering the app | SSO login from a company Entra account creates/binds an account and a session |
| **P4** | **In-browser test editor** + `testVersion` history + restore (§5); server-side parse guard. ⚠️ **APPROACH CHANGED:** editor is now a **Monaco-free grain `code-editor` organism** (see the `code-editor-grain-component` memory), NOT Monaco — the P0 Monaco spike is superseded; drop `monaco-editor` from deps unless something still needs it. §5/§8 below describe the old Monaco plan and are stale for P4 | Edit a spec in-browser, save creates a version, history shows author+time, restore works, run-from-editor works |
| **P5** | **Server-side run queue** (§6): enqueue, N worker slots, per-run SSE, concurrency cap, stop/kill; Run page shows queue position | Two users trigger runs concurrently; both queue, run within cap, stream independently, artifacts isolated |
| **P6** | **Audit log surfaced** in UI (History/Accounts/Environments "changed by" + an admin audit view); deploy hardening: reproducible build/install (§10), reverse-proxy + TLS docs, `0.0.0.0` bind, secret-key management; rewrite `CLAUDE.md` non-negotiables | Deployed on the company network, multiple real users, edits attributable end-to-end |

Rough order dependency: **P0 → P1 → (P2 ‖ P3) → P4 → P5 → P6**. P3 (SSO) can trail P2 if Entra tenant
access is slow. P5 (queue) is the heaviest build; P6 (deploy) is gated on the fresh-install fix.
