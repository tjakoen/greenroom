# 🎭 Greenroom

[![Made with Claude](https://img.shields.io/badge/Made_with-Claude-D97757?logo=anthropic&logoColor=white)](https://tjakoen.github.io/notes/ten-times-zero)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?logo=playwright&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-000000?logo=bun&logoColor=white)
![Zero-dep core](https://img.shields.io/badge/interface_deps-0-2ea44f)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A no-code app for running automated browser checks against your web app and reviewing the
results. You point it at your site and tell it how to log in. It never needs your app's source.

Greenroom wraps [Playwright](https://playwright.dev) in a friendly dashboard: pick one or
several environments, click **Run**, watch a live pass/fail checklist, and hand a developer a
one-click **bug bundle** (trace, video, screenshots, logs). No test-writing required to start,
and the example checks run against public sites out of the box.

**Want to look first?** Run `npm run demo` (or the VS Code task **🎬 Open Demo**). It boots
read-only with example data already filled in, so you can click a populated dashboard with zero
setup.

---

## Two ways to run it

Greenroom is one app with two editions, from the same code:

- **Local** (default) is a single-user tool that runs entirely on your own computer: no
  accounts, no server, config in local files. This is the quick way for one person to check a
  site. Start here.
- **Team** is a deployed, multi-user instance one company hosts behind a URL: real accounts and
  sessions, an embedded database, encrypted credentials, a shared run queue, and per-resource
  visibility. A teammate just opens the URL and signs in.

The in-app guide adapts to whichever edition you are running. Reading order:

- **New to Greenroom?** Follow **[the local guide](docs/guide/local.md)** below, or open
  **User guide** in the app.
- **Standing up a shared instance?** See **[DEPLOY.md](DEPLOY.md)** for hosting, then
  **[the team guide](docs/guide/team.md)**.
- **Building on the code?** Start at **[CLAUDE.md](CLAUDE.md)**.

Both guides link the same shared how-to pages ([writing checks](docs/guide/writing-checks.md),
[reporting a bug](docs/guide/reporting-bugs.md), [safety and FAQ](docs/guide/faq.md)).

---

## First time (local, once)

1. Install **Node.js** (LTS) from <https://nodejs.org>. One-time, like installing any app.
2. Install **Bun** from <https://bun.sh> (`curl -fsSL https://bun.sh/install | bash`, or
   `brew install bun` on a Mac). The app runs on Bun. One-time.
3. Install **VS Code** from <https://code.visualstudio.com> and open this folder
   (**File → Open Folder**). It offers to install the **Playwright** extension. Say yes.
4. Start the app with no typing: **Terminal → Run Task → 🚀 Open Test App**. The first run
   installs everything (a few minutes), then the app opens at <http://localhost:4321>.
5. Add your **environments**: **Settings → Environments**, one row per site (a name like
   `staging` and its URL). One is the default.
6. Add your **roles and logins**: **Settings → Roles & logins**, create a role (say `admin`),
   tick which sites it applies to, type a username and password for each, then **Save**.
   Passwords are written to a private `.env` file on your machine. They are never shown again,
   never shared, never committed. The role definitions (names plus which sites) live in
   `config/roles.json`. The credentials live only in `.env`.

After that, run the **🚀 Open Test App** task any time to open the app. A ready-made `example`
role (saucedemo's public demo login) ships pre-configured, so the built-in checks run with no
setup.

## Using the app

A left sidebar holds the pages:

- **Run** picks one or several environments (the pills are multi-select), starts a run, and
  shows a live pass/fail checklist. Pick more than one site and results show as a test by
  environment matrix. **Open full report** gives screenshots, video, and a step trace.
- **Tests** is every check, grouped by feature. Run one, tick several and **Run selected**, or
  **Run by tag**. Filter by `@tag` or by smart filters (failing, never run, flaky, slowest).
  Click the tag button on a test to set its group, priority, owner, and notes. **Record a new
  test**: type a name, optionally pick a role, click through the site, and your clicks become a
  test.
- **Editor** reads and tweaks a check in the browser, with saved version history on the team
  edition.
- **History** is every past run, saved locally, filterable.
- **Report a bug** turns a failed run into a **bug bundle** (`.zip` with trace, video,
  screenshots, logs, and a plain-language `summary.md`), or a copyable summary, or a
  single-snapshot **PDF**.
- **User guide** is the manual, in the app.
- **Settings** (local edition) holds roles and logins, environments, and the theme.

The `trace.zip` in a bug bundle is the key artifact for a developer. They open it at
<https://trace.playwright.dev> to replay the whole session: steps, screenshots, console, network.

## What gets captured

Every run records everything by default: a screenshot per step, the full video, the browser
console, and the network log, plus a step-by-step trace. Want faster runs? Tick **faster run
(less detail)** in the app, or set `CAPTURE=light`, which keeps the heavy artifacts only when a
check fails.

## Power-user commands (optional)

```bash
npm start                       # the app at http://localhost:4321 (local edition)
npm run start:platform          # the team edition (accounts + database)
npm run demo                    # read-only demo with seeded data (zero config)
npm run menu                    # run from the terminal (prompts for the environment)
TEST_ENV=staging npx playwright test                 # all checks against one environment
TEST_ENVS=staging,production npx playwright test     # against several at once
npm run record                  # record a check from the terminal
npm run report                  # reopen the last report
```

`TEST_ENV` picks a single environment. Leave it unset and the one marked `"default": true` in
`config/urls.json` is used. `TEST_ENVS` (comma-separated) runs the same checks against each
environment in turn.

## Where things live

| Path | What it is |
|------|------------|
| `server.ts` + `pages/` | The web app you run checks from |
| `tests/` | Your checks (`*.spec.ts`), each run against whichever environment you pick |
| `tests/helpers/` | Reusable pieces (for example `login`) |
| `tours/` | Guided in-app tours (markdown, rendered by CRUMB) |
| `config/urls.json` | The site URLs per environment (git-ignored, seeded from `urls.example.json`) |
| `config/roles.json` | Role definitions, names plus which sites (git-ignored). No passwords here |
| `.env` | Your logins (private, git-ignored) |
| `runs/` | Archived results of past runs (local) |
| `demo/` | Seeded example data for `npm run demo` (committed, read-only) |
| `context/` | Notes about your app for whoever writes checks (a template to fill in) |

## Writing a new check

Easiest is **Record a new test** in the app. To write one by hand:

1. Add a `*.spec.ts` file anywhere in `tests/`. Copy the shape of an existing `example-*` spec.
2. Use relative paths. `page.goto('/some/path')` hits the active environment's base URL, so the
   same check works against every environment.
3. Add `@tags` to the title (`test('checkout works @smoke', ...)`) to filter and run by tag.

Never type passwords in a check. Use `login('roleName')` from
[tests/helpers/auth.ts](tests/helpers/auth.ts), which reads the right per-environment account
from your private `.env`. Recording with a role inserts this call for you. To vary form data on
each run, use the generators in [tests/helpers/data.ts](tests/helpers/data.ts) (or the make-inputs
button in the app).

## License

MIT. See [LICENSE](LICENSE).

---
🤖 **Built with Claude, so a non-coder never has to meet a terminal.** I decided what "no coding required" has to mean, Claude typed the dashboard that keeps that promise. **I don't prompt and pray, I prompt and prove.** [How I actually work with AI, receipts and all →](https://tjakoen.github.io/notes/ten-times-zero)
