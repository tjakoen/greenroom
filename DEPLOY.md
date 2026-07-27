# DEPLOY.md — running Greenroom as a deployed multi-user platform

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
- **Host + CSRF allowlist** — `lib/guard.ts` serves only `ALLOWED_HOSTS` (+ loopback) and rejects
  cross-origin writes; better-auth `trustedOrigins` gates CSRF + SSO redirects to the same hosts.
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
  for organization + accountability, not a hard wall between teammates (plans/platform.md §0).

## Prerequisites

- **Bun** (the app is `bun server.ts`).
- **Node.js + Playwright browsers** — the run queue spawns `npx playwright test`; Chromium is
  installed by the `postinstall`.
- A **reverse proxy** (nginx / Caddy) terminating TLS in front of the app.
- This checkout's **`node_modules`** — see *Install* below (a fresh clone can't reinstall yet).

## Environment variables

Set these in the process environment (systemd unit, container env, etc.) — never commit them.

> **Fail-closed:** when `ALLOWED_HOSTS` is set (a real deployment), the app **refuses to boot** if
> `BETTER_AUTH_SECRET` or `SECRET_KEY` is unset, or if `BETTER_AUTH_URL` is not `https://` — it will
> not silently fall back to the dev session secret / dev encryption key / non-Secure cookies. Fix the
> reported vars and restart. (A local platform run without `ALLOWED_HOSTS` still tolerates the dev
> fallbacks.)

| Var | Required for deploy | What it does |
|---|---|---|
| `GREENROOM_MODE` | — | `platform` selects the multi-user edition (accounts + DB + run queue). **Setting `ALLOWED_HOSTS` already implies platform**, so a real deploy rarely needs this explicitly; it exists to run the platform edition locally (e.g. `npm run start:platform`) without exposing a host. Unset + no `ALLOWED_HOSTS` = the LOCAL single-user edition (no accounts, no DB). |
| `HOST` | yes | Bind address. Default `127.0.0.1` (loopback). Set `0.0.0.0` to accept the proxy's connections. |
| `PORT` | — | Listen port (default 4321). |
| `ALLOWED_HOSTS` | yes | Comma-separated hostname(s) the instance is served on, e.g. `greenroom.example.com`. The guard rejects any other `Host`/cross-origin write. Unset → loopback-only. |
| `BETTER_AUTH_SECRET` | yes | Signing secret for sessions. Generate a long random value; losing/rotating it logs everyone out. |
| `BETTER_AUTH_URL` | yes | The public base URL, e.g. `https://greenroom.example.com` (used for cookies + the SSO callback). |
| `SECRET_KEY` | yes | AES key material for encrypting stored **test-target** credentials (`credential.secretEnc`). Losing it just means those creds need re-entering — not catastrophic, but set a real managed secret. |
| `SUPERADMIN_EMAIL` | recommended | The email that becomes superadmin on first login. Otherwise the first-ever user is promoted. |
| `COMPANY_NAME` | — | Name of the default organization (cosmetic; default `"Company"`). |
| `GR_MAX_PARALLEL_RUNS` | — | Concurrent Playwright runs (default 2 — browsers are RAM-heavy; raise with headroom). |
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

**Runtime (deploy/CI) install now works from scratch** — with one prerequisite. All runtime
dependencies are either public npm packages (`better-auth`, `drizzle-orm`, `monaco-editor`,
`@better-auth/sso`) or **GitHub Packages** publishes (`@tjakoen/{batch,grain,mill,proof}` — see
`.npmrc` → `npm.pkg.github.com`). GitHub Packages needs auth, so before installing, add a token
line to your environment's `.npmrc` (do NOT commit it) and export a token with `read:packages`:

```
# ~/.npmrc or CI env — token NOT committed
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Then a runtime install resolves cleanly:

```
GITHUB_TOKEN=<pat> bun install --production   # skips devDependencies
bun run postinstall                            # installs the Playwright browser
```

`--production` is what unblocks it: **`@tjakoen/pantry` is the only remaining GitHub *git*-dep**
(a nested graph Bun can't resolve from zero), and it is a **devDependency** — the component-catalog
cockpit (`bunx pantry`), never imported at runtime. A production install omits it entirely.

**Dev install (with the cockpit) still hits the nested-git wall** — a full `bun install` pulls
`pantry`, which fails to resolve from scratch — so local development still runs from an existing
vendored `node_modules`. Flattening/publishing `pantry` removes that last wrinkle
(tracked in [plans/platform.md](plans/platform.md) §10). For deploy, prefer the `--production`
path above, or ship the app **with a working `node_modules`** as the artifact.

> Two additional caveats for a from-scratch deploy install: (1) published `@tjakoen/grain@^0.1.8`
> may not yet carry the P4 editor's `organisms/code-editor` chrome (currently vendored) — if the
> `/editor` page renders unstyled, that component still needs publishing. (2) `monaco-editor`'s
> `min/vs` assets are served from `node_modules/monaco-editor` — ensure they're present post-install.
