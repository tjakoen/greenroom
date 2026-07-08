# Greenroom

A small **local app** to run automated browser checks against your web app and review the
results. **No coding required.** Runs entirely on your computer, from VS Code or the terminal.

Greenroom wraps [Playwright](https://playwright.dev) in a friendly dashboard: pick one (or
several) environments, click **Run**, watch a live pass/fail checklist, and hand developers a
one-click **bug bundle** (trace + video + screenshots + logs). Point it at any website —
you tell it the URLs and how to log in.

**Want to look before you set anything up?** Run `npm run demo` (or the VS Code task
**🎬 Open Demo**) — it boots read-only with example data already filled in, so you can click
around a populated dashboard with zero config. See [Try the demo](#try-the-demo) below.

---

## First time (once)

1. Install **Node.js** (LTS) from <https://nodejs.org> — one-time, like installing any app.
2. Install **VS Code** from <https://code.visualstudio.com> and open this folder in it
   (**File → Open Folder**). It'll offer to install the **Playwright** extension — say yes.
3. Start the app without typing anything: **Terminal → Run Task → 🚀 Open Test App**. First
   run installs everything (a few minutes), then the app opens in your browser at
   <http://localhost:4321>.
4. Add your **environments**: go to **Settings → Environments** and add each site you want to
   test (a name like `staging` and its URL). One is marked the default.
5. Add your **roles & logins**: go to **Settings → Roles & logins**, create a role (e.g.
   `admin`), tick which sites it applies to, and type a username + password for each. Click
   **Save**. Passwords are written to a private `.env` file on your machine — never shown
   again, never shared or committed. (No file editing.) The role *definitions* (names +
   which sites) are saved in `config/roles.json`; the *credentials* live only in `.env`.

After that, just run the **🚀 Open Test App** task any time to open the app.

A ready-made `example` role (using saucedemo's public demo login) ships pre-configured, so
the built-in example tests run without any setup.

## Using the app

The app has a left sidebar with these pages:

- **🏠 Run tests** — pick **one or several** environments (the environment pills are
  multi-select), click **Run**, and watch a live pass/fail checklist (✓ / ✕ / ◐). Raw log is
  under *Technical details*. **Open full report** for screenshots, video and a step-by-step
  trace. When you pick more than one environment, results show as a **test × environment
  matrix** with per-environment health. A *Getting started* checklist guides you the first time.
- **🧪 Tests** — every individual check, grouped by feature. Run one (hover → **▶ Run**),
  tick several and **Run selected**, or **Run by tag**. Filter by `@tag`, or by smart
  filters (**Failing / Never run / Flaky / Slowest**). Click 🏷 on a test to set its
  **group, priority (P1/P2/P3), owner and notes**. Rename/delete too. A test recorded with a
  login shows a **runs as: <role>** badge. Click **⌗** on a test to make its form inputs
  **dynamic** (see below). **Record a new test**: type a name, optionally pick a role in
  **Log in as**, click record, click through the site, close the browser — your clicks
  become a test.
- **📜 History** — every past run, saved on your computer; filter and open any.
- **🐞 Report a bug** — pick a run + test, then **Download bug bundle (.zip)** (trace,
  video, screenshots, logs, and a plain-language `summary.md` — everything a developer
  needs), or **Copy summary** to paste into an issue tracker/Slack/email. Also exports a
  single-snapshot **PDF** (pick a page, or scrub the video and *Use this frame*).
- **📖 User guide** — the manual, in the app.
- **⚙️ Settings** — roles & logins, environments, light/dark theme.

The `trace.zip` in a bug bundle is the key artifact for devs — they open it at
<https://trace.playwright.dev> to replay the whole session (steps, screenshots, console,
network).

### Roles & logins

A **role** is a named account (e.g. `admin`, `editor`) that tests can log in as. In
**Settings → Roles & logins** you:

1. **Create a role** and give it a friendly label.
2. **Tick which sites (environments)** it applies to — or mark it *shared* so one login
   works everywhere.
3. **Fill in a username + password per site.** Click **Save**.

The role *definitions* (names + which sites) are stored in `config/roles.json`. The
*credentials* live only in your private `.env` and are **never shown again, never committed,
never sent anywhere**. Deleting a role removes its definition but **never touches `.env`** —
your saved passwords stay put. Where a site has its own account, that per-environment login
is used; otherwise the shared login is the fallback.

### Record a test that logs itself in

When recording, pick a role under **Log in as**. Greenroom logs you in first (so you skip
the login screen while clicking around) and writes `await login('<role>')` into the recorded
test. At run time that logs in with the right per-environment account — **no credentials ever
land in the test file**. The Tests page shows a **runs as: <role>** badge on such tests.

### Make form inputs dynamic

Recorded tests capture the exact text you typed (e.g. an email). Re-running them can fail
with "email already exists". Click **⌗** on a test to see every recorded input value, then
pick a generator — **unique email**, **random name**, **random phone**, and more — and
Greenroom rewrites that field so each run submits fresh data. It's backed by
[tests/helpers/data.ts](tests/helpers/data.ts) (no new dependencies).

### Try the demo

Want to explore before setting anything up? Run **`npm run demo`** (or the VS Code task
**🎬 Open Demo**). Greenroom boots **read-only** with seeded example data from the committed
`demo/` folder — a populated dashboard, a run with both red and green results, and example
roles — so you can click through everything with zero config. A **Demo** badge shows in the
sidebar and all writes are disabled (nothing you click changes your real setup).

### The built-in example tests

Four `@example` tests ship with Greenroom and run **zero-config** against public sites, so a
fresh clone works out of the box:

- **logs in as a standard user** — saucedemo login
- **navigates the Playwright docs** — playwright.dev
- **searches Wikipedia**
- **fails on purpose to show a red run** — an intentional failure, so you can see what a
  failure looks like

Use them to learn the app, then delete them once your own tests exist.

### More ways to run in VS Code

Everything runs without typing commands:

- **Terminal → Run Task**, then pick **🚀 Open Test App**, **▶ Run tests (pick
  environment)**, **⏺ Record a new test**, or **📊 View last report**.
- Or use the **Testing** panel (flask icon, left sidebar): every test with a ▶ play button,
  results shown inline.

Browsing your saved tests and results is point-and-click in the file explorer.

### Power-user commands (optional)

```bash
npm start                       # the app (http://localhost:4321)
npm run demo                    # read-only demo with seeded example data (zero config)
npm run menu                    # run from the terminal (prompts for the environment)
TEST_ENV=staging npx playwright test        # run all tests against one environment
TEST_ENVS=staging,production npx playwright test   # run against several environments at once
npm run record                  # record a test from the terminal
npm run report                  # reopen the last report
CAPTURE=light TEST_ENV=staging npx playwright test   # faster: artifacts only on failure
```

`TEST_ENV` picks which single environment to run against. Leave it unset and the one marked
`"default": true` in `config/urls.json` is used. `TEST_ENVS` (comma-separated) runs the same
tests against each environment in turn (one Playwright project per environment) — this is
what the multi-select on the Run page uses.

## What gets captured

Every run records **everything by default**. Open the report, click a test, then click the
**trace** to get the full picture:

- **Right pane** — every step Playwright took.
- **Top (filmstrip)** — a **screenshot per step**.
- **Bottom tabs** — the browser's **Console** and **Network**.
- **Video** — the whole test, start to finish.
- Plus `console.log` / `network.log` attachments (errors and 4xx/5xx) on each test.

Want faster runs? Tick **faster run (less detail)** in the app, or use `CAPTURE=light` —
that keeps the heavy artifacts only when a test fails.

---

## Where things live

| Folder | What it's for |
|--------|---------------|
| `interface/` | The web page you run tests from |
| `runs/` | Archived results of past runs (local only) |
| `tests/` | Your tests (`*.spec.ts`). Every test runs against whichever environment you pick |
| `tests/helpers/` | Reusable pieces (e.g. `login`) |
| `config/urls.json` | The website URLs for each environment (single source; git-ignored, seeded from `urls.example.json`) |
| `config/roles.json` | Your role definitions — names + which sites each applies to (git-ignored, seeded from `roles.example.json`). No passwords here |
| `.env` | Your logins/passwords (private, git-ignored) |
| `demo/` | Seeded example data for `npm run demo` (committed, read-only) |
| `context/` | Notes about your app for whoever writes tests (a template to fill in) |
| `standards/` | How this repo is built + worked on with AI |

## Writing a new test

Easiest is **Record a new test** in the app (above). To write one by hand:

1. Add a `*.spec.ts` file anywhere in `tests/`. Copy the shape of `tests/home.spec.ts` or
   `tests/login.spec.ts`.
2. Use relative paths — `page.goto('/some/path')` hits the active environment's base URL, so
   the same test works against every environment.
3. Add `@tags` to the test title (e.g. `test('checkout works @smoke', ...)`) to filter and
   run by tag in the app.

Never type passwords directly in a test — use `login(page, 'roleName')` from
[tests/helpers/auth.ts](tests/helpers/auth.ts), which reads the right per-environment account
for that role from your private `.env`. (Recording with a **Log in as** role inserts this
call for you.) **First edit `auth.ts` to match your app's login form** (URL + field
selectors). To vary form data on each run, use the generators in
[tests/helpers/data.ts](tests/helpers/data.ts) (or the **⌗** button in the app).

## Adding another environment

Use the **Environments** panel in the app: type a name (e.g. `staging`) and its URL, click
**Add**. Then add the real logins for it in **Settings → Roles & logins** — tick the new site
on any role that should run there and fill in its username + password.

(You can also edit `config/urls.json` directly — see the change-map in [CLAUDE.md](CLAUDE.md).
Mark one environment `"default": true`.)

## License

MIT — see [LICENSE](LICENSE).
