# DEPLOY.md — running Greenroom as a deployed multi-user platform

Greenroom began as a local, single-user tool and still runs that way by default (loopback,
no accounts needed in demo). The platform layer (accounts, teams, scoping, the run queue —
see [plans/platform.md](plans/platform.md)) lets one company run **one shared instance** many
people use at once. This file is the deploy runbook.

> **Security status — read first.** The platform is **deploy-capable, not yet
> security-reviewed for public exposure.** The defaults keep it locked to loopback; deployment
> is opt-in via the env vars below. Before exposing it to real users you MUST (a) put it behind
> a TLS-terminating reverse proxy on a private/company network, (b) set the secrets below, and
> (c) have someone do the deploy security pass tracked in [plans/platform.md](plans/platform.md)
> §10 (session/CSRF behind a proxy, trusted-proxy headers, rate limiting). Do not put it on the
> public internet without that pass.

## Prerequisites

- **Bun** (the app is `bun server.ts`).
- **Node.js + Playwright browsers** — the run queue spawns `npx playwright test`; Chromium is
  installed by the `postinstall`.
- A **reverse proxy** (nginx / Caddy) terminating TLS in front of the app.
- This checkout's **`node_modules`** — see *Install* below (a fresh clone can't reinstall yet).

## Environment variables

Set these in the process environment (systemd unit, container env, etc.) — never commit them.

| Var | Required for deploy | What it does |
|---|---|---|
| `HOST` | yes | Bind address. Default `127.0.0.1` (loopback). Set `0.0.0.0` to accept the proxy's connections. |
| `PORT` | — | Listen port (default 4321). |
| `ALLOWED_HOSTS` | yes | Comma-separated hostname(s) the instance is served on, e.g. `greenroom.example.com`. The guard rejects any other `Host`/cross-origin write. Unset → loopback-only. |
| `BETTER_AUTH_SECRET` | yes | Signing secret for sessions. Generate a long random value; losing/rotating it logs everyone out. |
| `BETTER_AUTH_URL` | yes | The public base URL, e.g. `https://greenroom.example.com` (used for cookies + the SSO callback). |
| `SECRET_KEY` | yes | AES key material for encrypting stored **test-target** credentials (`credential.secretEnc`). Losing it just means those creds need re-entering — not catastrophic, but set a real managed secret. |
| `SUPERADMIN_EMAIL` | recommended | The email that becomes superadmin on first login. Otherwise the first-ever user is promoted. |
| `COMPANY_NAME` | — | Name of the default organization (cosmetic; default `"Company"`). |
| `GR_MAX_PARALLEL_RUNS` | — | Concurrent Playwright runs (default 2 — browsers are RAM-heavy; raise with headroom). |
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
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
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
  tests, run metadata, audit log. This is a SQLite file: snapshot it with the SQLite online-backup
  API or copy it while the app is stopped; for continuous backup consider a litestream-style tool.
- **`runs/`** — per-run artifacts (report, video, trace, screenshots). Large; can be treated as
  regenerable (re-run) if backup cost matters. Pruned to newest 30 / under 3 GB by default.

`SECRET_KEY` is NOT in these — store it in your secret manager. Without it the encrypted
`credential` values can't be decrypted (re-enter them).

## Install (known limitation)

A **fresh clone cannot `npm install`/`bun install` from scratch today.** `@tjakoen/pantry` is a
GitHub git-dep with its own nested git-deps that Bun can't resolve from zero, and the `@tjakoen/*`
published packages come from **GitHub Packages** (`.npmrc` → `npm.pkg.github.com`), which needs a
`GITHUB_TOKEN` with `read:packages`. The instance therefore **runs from an existing, working
`node_modules`** (copied/rsynced with the deploy artifact). Flattening the pantry nesting (or
publishing pantry) + providing the GitHub Packages token is the work needed to make a clean
install reproducible — tracked in [plans/platform.md](plans/platform.md) §10. Until then: deploy
the app **with its `node_modules`** rather than reinstalling on the target.
