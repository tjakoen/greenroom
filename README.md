# 🎭 Greenroom

[![Made with Claude](https://img.shields.io/badge/Made_with-Claude-D97757?logo=anthropic&logoColor=white)](https://tjakoen.github.io/notes/ten-times-zero)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?logo=playwright&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-000000?logo=bun&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Run automated browser checks against your web app and review the results — **no coding
required**. Greenroom wraps [Playwright](https://playwright.dev) in a dashboard: pick one or
several environments, click **Run**, watch a live pass/fail checklist, and hand developers a
one-click **bug bundle** (trace + video + screenshots + logs).

It never needs your app's source — you tell it the URLs and how to log in.

**Look before setting anything up:** `npm run demo` (or the VS Code task **🎬 Open Demo**) boots
read-only against seeded example data — a populated dashboard with red and green results, zero
config. A **Demo** badge appears and every write is disabled.

Greenroom runs two ways from one codebase:

| | Who for | How you reach it |
|---|---|---|
| **Local** (default) | one person, own machine | open the folder in VS Code, run a task |
| **Platform** | a team, many at once | a URL — accounts, teams, a run queue → **[DEPLOY.md](DEPLOY.md)** |

---

## First time (once)

1. Install **Node.js** (LTS) from <https://nodejs.org> — one-time, like installing any app.
2. Install **Bun** from <https://bun.sh> — one line in a terminal
   (`curl -fsSL https://bun.sh/install | bash`, or `brew install bun` on a Mac). The app
   runs on Bun; this is one-time.
3. Install **VS Code** from <https://code.visualstudio.com> and open this folder in it
   (**File → Open Folder**). It'll offer to install the **Playwright** extension — say yes.
4. **Add your access token** (one-time, and only if you cloned this repo yourself). Some of
   Greenroom's building blocks are published privately, so installing needs a GitHub token
   with `read:packages`. Create one at <https://github.com/settings/tokens>, then add these two
   lines to the file `.npmrc` in your home folder (create it if it isn't there), replacing
   `<your-token>`:

   ```
   @tjakoen:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=<your-token>
   ```

   Without it, step 5 stops with `401 … failed to resolve`. **If someone sent you a link to a
   running Greenroom instead, skip all of this** — just open the link and sign in; there is
   nothing to install.
5. Start the app without typing anything: **Terminal → Run Task → 🚀 Open Test App**. The
   first run installs everything (a few minutes — it runs `bun install` for you), then the app
   opens in your browser at <http://localhost:4321>.
6. Add your **environments** — **Settings → Environments**: a name like `staging` and its URL;
   one is the default. The same panel's **Login form** section is where you describe your app's
   sign-in page (per site, or one shared form). That's data, not code.
7. Add your **roles & logins** — **Settings → Roles & logins**: create a role (e.g. `admin`),
   tick which sites it applies to, type a username + password for each, **Save**.

A **role** is a named account your tests sign in as. Role *definitions* (names + which sites)
live in `config/roles.json`; the *credentials* go only into a private, git-ignored `.env` —
never shown again, never committed, never sent anywhere. Deleting a role leaves its saved
passwords untouched. A ready-made `example` role ships wired to saucedemo's public demo login,
so the four shipped `@example` tests — including one that **fails on purpose**, so you can see
what red looks like — run with no setup at all.

After that, just run **🚀 Open Test App** any time. Other tasks: **▶ Run tests**, **⏺ Record a
new test**, **📊 View last report** — or use VS Code's **Testing** panel for a ▶ beside every
test.

## The pages

- **Run** — pick one or several environments, click **Run**, watch a live checklist
  (✓ ✕ ◐ ○). Several environments render as a **test × environment matrix** with per-env
  health. **Open full report** for screenshots, video and a step-by-step trace.
- **Tests** — every check, grouped. Run one, tick several and **Run selected**, or **Run by
  tag**. Filter by `@tag` or smart filter (**Failing / Never run / Flaky / Slowest**). 🏷 sets
  group, priority, owner and notes. **Record a new test**: name it, optionally pick a role
  under **Log in as**, click through the site, close the browser — your clicks are the test.
- **Editor** — edit a spec in the browser, validated before it saves (with version history on
  the platform edition).
- **History** — every past run; filter and reopen any.
- **Report a bug** — pick a run + test, then **Download bug bundle (.zip)**: trace, video,
  screenshots, logs and a plain-language `summary.md`. Or **Copy summary** for an issue
  tracker, or export a single-snapshot **PDF**.
- **User guide** — the manual, in the app ([USER-GUIDE.md](USER-GUIDE.md)).
- **Settings** (local only) · **Environments · Accounts · Admin** (platform only).

The `trace.zip` is what developers actually want — they drop it on
<https://trace.playwright.dev> and replay the whole session.

### Recording signs itself in

Pick a role under **Log in as**: Greenroom logs you in before the recorder opens, then writes
`await login('<role>')` into the spec. At run time that resolves the right per-environment
account — **no credentials ever land in a test file**.

### Dynamic form inputs

A recorded test replays the exact text you typed, so re-runs hit "email already exists". Click
**⌗**, pick a generator — unique email, random name, phone — and Greenroom rewrites that field.
Backed by [tests/helpers/data.ts](tests/helpers/data.ts).

## What gets captured

Everything, by default: a **screenshot filmstrip**, the full **video**, every Playwright
**step**, and the browser's **console** and **network** logs (plus `console.log` /
`network.log` attachments for errors and 4xx/5xx). Open a test in the report and click the
trace to see it all at once.

In a hurry? Tick **faster run (less detail)**, or set `CAPTURE=light` — heavy artifacts are
then kept only for failures.

## Writing a test by hand

**Record a new test** is the easy path. Otherwise add a `*.spec.ts` anywhere in `tests/`:

1. Copy the shape of a shipped example — `tests/example-nav.spec.ts` (no login) or
   `tests/example-login.spec.ts` (logs in) — or `tests/login.spec.ts`, the template for a
   smoke login as one of your own roles.
2. Navigate with **relative** paths: `page.goto('/some/path')` resolves against whichever
   environment you picked, so one test works everywhere.
3. Add `@tags` to the title — `test('checkout works @smoke', …)` — to filter and run by tag.

Never type a password in a test. Use the `login` fixture (`await login('admin')`), which reads
that role's per-environment account from your `.env`; recording with **Log in as** inserts the
call for you. You only hand-edit [tests/helpers/auth.ts](tests/helpers/auth.ts) for exotic
flows (multi-step, MFA, SSO) — ordinary login forms are configuration.

Tests are **not** tied to an environment: they live flat in `tests/`, and the environment you
pick supplies the base URL and the logins.

## Where things live

| Path | What it's for |
|---|---|
| `server.ts` + `pages/` | The app you run tests from |
| `lib/` | The domain — runner, recorder, bundles, PDF, scoping |
| `tests/` · `tests/helpers/` | Your specs, and reusable pieces like `login` |
| `config/urls.json` | Environment URLs + login forms (git-ignored, seeded from `urls.example.json`) |
| `config/roles.json` | Role definitions — no passwords (git-ignored) |
| `.env` | Your logins (private, git-ignored) |
| `runs/` | Archived past runs (local only) |
| `demo/` | Seeded data for `npm run demo` (committed, read-only) |
| `context/` | A fill-in template describing the app under test |
| `plans/` | The design record — how this was built, and why |

## Commands (optional)

```bash
npm start                                          # the app (http://localhost:4321)
npm run demo                                       # read-only, seeded, zero config
npm run start:platform                             # multi-user edition (see DEPLOY.md)
npm run menu                                       # run from the terminal
npm run record                                     # record a test from the terminal
npm run report                                     # reopen the last report
TEST_ENV=staging npx playwright test               # one environment
TEST_ENVS=staging,production npx playwright test   # several at once
```

`TEST_ENV` picks a single environment; unset, the one marked `"default": true` in
`config/urls.json` wins. `TEST_ENVS` runs the same tests against each environment in turn —
that's what the Run page's multi-select does.

## Docs

**[USER-GUIDE.md](USER-GUIDE.md)** the in-app manual · **[DEPLOY.md](DEPLOY.md)** running a real
deployment · **[CLAUDE.md](CLAUDE.md)** how to work in this repo · **[AUDIT.md](AUDIT.md)** the
alignment runbook · **[plans/](plans/)** the design record

## License

MIT — see [LICENSE](LICENSE).

---
🤖 **Built with Claude, so a non-coder never has to meet a terminal.** I decided what "no coding required" has to mean, Claude typed the dashboard that keeps that promise. **I don't prompt and pray, I prompt and prove.** [How I actually work with AI, receipts and all →](https://tjakoen.github.io/notes/ten-times-zero)
