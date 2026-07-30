# DEPLOY.md — running Greenroom as a deployed multi-user platform

> **"Platform" and "Team" are the same edition.** The README and the in-app guide call it the
> **Team** edition, because that's what it means to the people using it. The code, the env vars
> and this runbook call it **`platform`** — `GREENROOM_MODE=platform`, `npm run start:platform`.
> This file is for whoever hosts it; users want [docs/guide/team.md](docs/guide/team.md).

Greenroom began as a local, single-user tool and still runs that way by default (loopback,
no accounts needed in demo). The platform layer (accounts, teams, scoping, the run queue —
see [plans/platform.md](plans/platform.md)) lets one company run **one shared instance** many
people use at once. This file is the deploy runbook.

> **Security status — read first.** The platform is **hardened for internal deployment behind a
> trusted reverse proxy, not audited for direct public-internet exposure.** Defaults stay
> loopback-locked; deployment is opt-in via the env vars below. Keep it on a private/company
> network behind the proxy. See the security-review section below for what's covered vs residual.

## Security review

What the platform already enforces (all opt-in via env, defaults unchanged for local):
- **Auth on every route** — better-auth sessions; unauthenticated page → 302 `/login`, API → 401.
  Cookies are `httpOnly` + `sameSite=lax`, and **Secure** when `BETTER_AUTH_URL` is `https://`.
- **Host + CSRF allowlist** — `lib/guard.ts` serves only `ALLOWED_HOSTS` (+ genuine loopback) and
  rejects cross-origin writes; on a deployment an empty/missing `Host` (or a raw `0.0.0.0`) is
  rejected, not waved through. better-auth `trustedOrigins` gates CSRF + SSO redirects to the same hosts.
- **Private-run artifact wall** — a run that covered a `private` test walls its saved artifacts AND
  its live stream/state/history metadata to non-owners (`lib/run-scope.ts` `canReadRun`); `?run=latest`
  resolves to the concrete newest run and is walled the same. Stopping a run is owner/superadmin-only
  (`canControlRun`). The `/api/queue` + `/api/runs` listings are scoped to the caller.
- **Run isolation** — the Playwright child never inherits `SECRET_KEY`/`BETTER_AUTH_SECRET` (a
  user-authored spec can't exfiltrate them via its streamed output). The queue caps in-flight runs
  (global + per-user) and force-stops a run past `GR_RUN_TIMEOUT_MS` so it can't wedge a slot.
- **Rate limiting** — 120 req/min global, 10/min on `sign-in`/`sign-up` (credential brute-force).
  Behind a proxy the app resolves the client IP from `x-forwarded-for` (only when `ALLOWED_HOSTS`
  is set) so the limit is per-client, not one shared bucket. **This is only safe if the proxy
  OVERWRITES `X-Forwarded-For` with the real client IP** (see the nginx config below) — an
  append-style proxy header is client-spoofable.
- **Secrets at rest** — test-target credentials AES-256-GCM encrypted (`SECRET_KEY`); Greenroom
  account passwords hashed by better-auth; neither returned to the client.
- **Accountability** — every write goes through the append-only audit log (actor + before/after,
  secrets redacted).

Residual risk / must-do before exposure (do NOT skip):
- **Trusted proxy is assumed.** The app trusts `Host` + `X-Forwarded-For` from the proxy. Only run
  it behind a proxy you control that sets those correctly; never bind `0.0.0.0` without the proxy.
- **In-memory rate limiter** — fine for the single-server model (plans/platform.md §6). A
  multi-instance deploy needs a shared store, or each instance limits independently.
- **No independent security audit yet** — pen-test / review before any broader exposure.
- **Company-open scoping by design** — everyone can read `company`-visibility resources; scoping is
  for organization + accountability, not a hard wall between teammates (plans/platform.md §0). Note a
  run using a `private`/`team` credential against a `company` test can still surface that credential
  in the run's screenshots/logs to any reader — keep sensitive-cred tests `private`.
- **Restrict registration** — sign-up is open by default. On a public instance set
  `GREENROOM_DISABLE_SIGNUP=1` or `SIGNUP_ALLOWED_DOMAINS` so anonymous visitors can't self-register
  (the first-ever user is auto-promoted to superadmin — set `SUPERADMIN_EMAIL` too).

## Prerequisites

- **Bun** (the app is `bun server.ts`).
- **Node.js + Playwright browsers** — the run queue spawns `npx playwright test`; Chromium is
  installed by the `postinstall`.
- A **reverse proxy** (nginx / Caddy) terminating TLS in front of the app.
- **No registry token.** The `@tjakoen` shared layer is published to the public npm registry, so
  installing needs no credentials at all. See *Install* below.

## Environment variables

Set these in the process environment (systemd unit, container env, etc.) — never commit them.

> **Fail-closed:** the app treats an instance as a *deployment* when **either** `ALLOWED_HOSTS` is
> set **or** `HOST` is bound to a non-loopback address (e.g. `0.0.0.0`) — i.e. anything reachable
> off-box. In that state it **refuses to boot** if `BETTER_AUTH_SECRET` or `SECRET_KEY` is unset (or
> whitespace-only), or if `BETTER_AUTH_URL` is not `https://` — no silent fallback to the dev session
> secret / dev encryption key / non-Secure cookies. It also **refuses** to bind a non-loopback `HOST`
> in the LOCAL edition (a public bind must run the platform edition, with its session gate + config
> lock) and refuses to expose `GREENROOM_DEMO` on a network interface (demo has no auth). A purely
> loopback local-platform dev run still tolerates the dev fallbacks. Fix the reported vars and restart.

| Var | Required for deploy | What it does |
|---|---|---|
| `GREENROOM_MODE` | — | `platform` selects the multi-user edition (accounts + DB + run queue). **Setting `ALLOWED_HOSTS` already implies platform**, so a real deploy rarely needs this explicitly; it exists to run the platform edition locally (e.g. `npm run start:platform`) without exposing a host. Unset + no `ALLOWED_HOSTS` = the LOCAL single-user edition (no accounts, no DB). |
| `HOST` | yes | Bind address. Default `127.0.0.1` (loopback). Set `0.0.0.0` to accept the proxy's connections. |
| `PORT` | — | Listen port (default 4321). |
| `ALLOWED_HOSTS` | yes | Comma-separated hostname(s) the instance is served on, e.g. `greenroom.example.com`. The guard rejects any other `Host`/cross-origin write. Unset → loopback-only. |
| `BETTER_AUTH_SECRET` | yes | Signing secret for sessions. Generate a long random value; losing/rotating it logs everyone out. |
| `BETTER_AUTH_URL` | yes | The public base URL, e.g. `https://greenroom.example.com` (used for cookies + the SSO callback). **It gates trusted origins, so it must match the URL you actually browse.** Defaults to `http://localhost:4321` — so a local platform run on any other port fails sign-in/sign-up with an opaque `Invalid origin` until you set this to match (e.g. `PORT=4899 BETTER_AUTH_URL=http://localhost:4899`). |
| `SECRET_KEY` | yes | AES key material for encrypting stored **test-target** credentials (`credential.secretEnc`). Losing it just means those creds need re-entering — not catastrophic, but set a real managed secret. |
| `SUPERADMIN_EMAIL` | recommended | The email that becomes superadmin on first login. Otherwise the first-ever user is promoted. |
| `COMPANY_NAME` | — | Name of the default organization (cosmetic; default `"Company"`). |
| `GR_MAX_PARALLEL_RUNS` | — | Concurrent Playwright runs (default 2 — browsers are RAM-heavy; raise with headroom). |
| `GR_MAX_QUEUED` | — | Global admission cap on in-flight (queued+running) runs (default 200). Rejects further `/api/run` with 429 — bounds memory/DB against a run-flood. |
| `GR_MAX_QUEUED_PER_USER` | — | Per-user in-flight run cap (default 20). One user can't monopolise the queue. |
| `GR_RUN_TIMEOUT_MS` | — | Wall-clock ceiling per run before the queue force-stops it (default 1800000 = 30 min). Stops a hung child wedging a concurrency slot. |
| `GREENROOM_DISABLE_SIGNUP` | recommended | `1` disables self-service email/password sign-up (create users via admin). Prevents anonymous registration on a public instance. |
| `SIGNUP_ALLOWED_DOMAINS` | recommended | Comma-separated email domains allowed to register, e.g. `example.com`. Empty → any domain (open). Enforced on every create path. |
| `GREENROOM_DB_PATH` | — | Override the SQLite file location (default `data/greenroom.db`). Point at a managed/persistent volume in a container deploy so the DB survives redeploys. |
| `GREENROOM_DEMO` | — | `1` = read-only demo mode (no accounts, seeded data). Not for a real deployment. |

Entra SSO (deferred — email/password works without it): register an app in your company's
Microsoft Entra tenant, redirect URI `https://<host>/api/auth/sso/callback/entra`, then register
the provider at runtime (`auth.api.registerSSOProvider`) — see [plans/platform.md](plans/platform.md) §2.

## Reverse proxy + TLS

Terminate TLS at the proxy; forward to the app on `HOST:PORT`. Pass through `Host`, `X-Forwarded-*`.
Example (nginx):

```
server {
  server_name greenroom.example.com;
  listen 443 ssl;
  # ssl_certificate / ssl_certificate_key ...
  location / {
    proxy_pass http://127.0.0.1:4321;
    proxy_set_header Host $host;
    # OVERWRITE (not $proxy_add_x_forwarded_for, which appends the client-supplied value):
    # the app trusts x-forwarded-for for rate-limit client-IP resolution when ALLOWED_HOSTS is
    # set, so the proxy must set it to the REAL client IP only. Appending would let a client
    # spoof a leftmost IP and evade the auth rate limit.
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;   # the run dashboard streams Server-Sent Events
  }
}
```

Run the app with e.g. `HOST=0.0.0.0 ALLOWED_HOSTS=greenroom.example.com BETTER_AUTH_URL=https://greenroom.example.com bun server.ts`.

## First run

On first boot the app migrates the DB (better-auth tables + app tables), seeds a single default
organization + an "Unassigned" team, and seeds `config/roles.json`. The first user to sign up (or
the `SUPERADMIN_EMAIL`) becomes superadmin and can manage users/teams at `/admin`.

## State + backups

Everything durable lives in two places — back both up:
- **`data/greenroom.db`** (+ `-wal`/`-shm`) — accounts, teams, environments, credentials (encrypted),
  tests, run metadata, audit log. Back it up with the bundled script — it uses SQLite `VACUUM INTO`
  (a consistent, fully-checkpointed snapshot, safe to run against the **live** db; a raw file copy
  under WAL can capture a torn state) and integrity-checks the result before reporting success:

  ```
  bun scripts/backup.ts                 # -> <db-dir>/backups/greenroom-<UTC-stamp>.db
  bun scripts/backup.ts /mnt/backups    # or pass a directory / an explicit *.db path
  ```

  It honours `GREENROOM_DB_PATH` (backs up whatever volume the app runs against) and prunes to the
  newest `GREENROOM_BACKUP_KEEP` (default 30). Schedule it from cron or a systemd timer — e.g. hourly:

  ```
  0 * * * * cd /srv/greenroom && GREENROOM_DB_PATH=/data/greenroom.db /usr/local/bin/bun scripts/backup.ts /data/backups >> /var/log/greenroom-backup.log 2>&1
  ```

  For continuous / point-in-time recovery, layer a litestream-style WAL shipper on top.
- **`runs/`** — per-run artifacts (report, video, trace, screenshots). Large; can be treated as
  regenerable (re-run) if backup cost matters. Pruned to newest 30 / under 3 GB by default.

`SECRET_KEY` is NOT in these — store it in your secret manager. Without it the encrypted
`credential` values can't be decrypted (re-enter them).

## Install

**Install works from scratch, with no credentials.** Every dependency — including the
`@tjakoen/{batch,grain,mill,proof}` shared layer — resolves anonymously from the public npm
registry. There is no `.npmrc` in this repo and none is needed:

```
bun install          # or `bun install --production` to skip devDependencies
bun run postinstall  # installs the Playwright browser
```

Verified 2026-07-30 against an empty `HOME` (no user `~/.npmrc`) and a purged package cache:
82 packages installed, both typechecks green, 44/44 tests, every page 200.

**Use Bun, not npm** — this is the one hard rule, re-verified 2026-07-30 on a fresh clone with a
cold cache:

- **A full `bun install` now works from scratch**, `pantry` included (85 packages, then the app
  boots). The older note here — that a dev install hits a "nested-git wall" and you must ship a
  vendored `node_modules` — no longer matches reality; `--production` is a way to install *less*,
  not a workaround you need.
- **`npm install` fails outright, and always will until `pantry` is re-pinned.** `@tjakoen/pantry`
  (a devDependency) pins `tjakoen.github.io#afc640a`, a commit no longer on that remote. npm
  resolves the whole graph and runs `git checkout afc640a`, which aborts the install — even with
  `--omit=dev`, so the runtime deps never land. Bun fetches that commit as a codeload tarball and
  succeeds. Note what this means: bun works only because GitHub still serves an *unreferenced*
  commit. Re-pin the dep in the **`pantry` repo** (`bun run deps:refresh` there → commit → re-pin
  here) to stop depending on that.

> Caveat for a from-scratch install: `monaco-editor`'s `min/vs` assets are served from
> `node_modules/monaco-editor` — ensure they're present post-install. (The earlier caveat about
> published `grain` lacking the editor's `organisms/code-editor` chrome is resolved: the pinned
> `@tjakoen/grain@0.1.12` carries it, so nothing is vendored any more.)
