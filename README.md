# 🎭 Greenroom

[![Made with Claude](https://img.shields.io/badge/Made_with-Claude-D97757?logo=anthropic&logoColor=white)](https://tjakoen.github.io/notes/ten-times-zero)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?logo=playwright&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-000000?logo=bun&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Run automated browser checks against your web app and review the results, with **no coding
required**. Greenroom wraps [Playwright](https://playwright.dev) in a dashboard: pick one or
several environments, click **Run**, watch a live pass/fail checklist, and hand developers a
one-click **bug bundle** (trace + video + screenshots + logs).

It never needs your app's source. You tell it the URLs and how to log in.

**Look before setting anything up:** `npm run demo` (or the VS Code task **🎬 Open Demo**) boots
read-only against seeded example data: a populated dashboard with red and green results, zero
config. A **Demo** badge appears and every write is disabled.

## Two ways to run it

One app, two editions, same code:

| | Who for | How you reach it |
|---|---|---|
| **Local** (default) | one person, own machine: no accounts, no server, config in local files | open the folder in VS Code, run a task |
| **Team** | a company hosting one instance: accounts, sessions, encrypted credentials, a shared run queue, per-resource visibility | a URL: sign in, install nothing |

Whichever you're running, Greenroom tells you: a **Local** / **Team** / **Demo** badge sits next to
the logo in the sidebar.

### Which one do I want?

- **Just trying it, or checking a site by yourself?** → **Local.** Nothing to host, nothing to
  sign into, no data leaves your machine.
- **Want colleagues to run the same checks without installing anything?** → **Team.** You host it
  once; they open a URL.
- **Can I start local and move to team later?** Yes. Your tests are just files in `tests/`, and
  they carry over unchanged. Environments and logins are re-entered in the Team UI, because
  there they live in an encrypted database instead of local files.
- **Does local share anything?** No. Local writes to your own disk only: results, run history and
  credentials never leave the machine.

> **A note on naming:** "Team" is what this README and the in-app guide call the multi-user
> edition. The code, env vars and deployment docs call the same thing **`platform`**, hence
> `npm run start:platform` and `GREENROOM_MODE=platform`. Same edition, two names.

The in-app guide adapts to whichever edition you're running. Reading order:

- **New to Greenroom?** → **[the local guide](docs/guide/local.md)**, or open **User guide** in the app.
- **Standing up a shared instance?** → **[DEPLOY.md](DEPLOY.md)** for hosting, then **[the team guide](docs/guide/team.md)**.
- **Building on the code?** → **[CLAUDE.md](CLAUDE.md)**.

Both guides link the same how-to pages: [writing checks](docs/guide/writing-checks.md) ·
[reporting a bug](docs/guide/reporting-bugs.md) · [safety and FAQ](docs/guide/faq.md).

---

## First time (local, once)

1. Install **Node.js** (LTS) from <https://nodejs.org>. One-time, like installing any app.
2. Install **Bun** from <https://bun.sh>. One line in a terminal
   (`curl -fsSL https://bun.sh/install | bash`, or `brew install bun` on a Mac). The app
   runs on Bun; this is one-time.
3. Install **VS Code** from <https://code.visualstudio.com> and open this folder in it
   (**File → Open Folder**). It'll offer to install the **Playwright** extension; say yes.
4. Start the app without typing anything: **Terminal → Run Task → 🚀 Open Test App**. The
   first run installs everything (a few minutes; it runs `bun install` for you), then the app
   opens in your browser at <http://localhost:4321>.
5. Add your **environments** in **Settings → Environments**: a name like `staging` and its URL;
   one is the default. The same panel's **Login form** section is where you describe your app's
   sign-in page (per site, or one shared form). That's data, not code.
6. Add your **roles & logins** in **Settings → Roles & logins**: create a role (e.g. `admin`),
   tick which sites it applies to, type a username + password for each, **Save**.

> **Use `bun install`, not `npm install`.** A dev-only dependency pins a git commit npm refuses
> to resolve; bun handles it. The VS Code tasks already use bun.

A **role** is a named account your tests sign in as. Role *definitions* (names + which sites)
live in `config/roles.json`; the *credentials* go only into a private, git-ignored `.env`:
never shown again, never committed, never sent anywhere. Deleting a role leaves its saved
passwords untouched. A ready-made `example` role ships wired to saucedemo's public demo login,
so the four shipped `@example` tests run with no setup at all. One of them **fails on purpose**,
so you can see what red looks like.

After that, just run **🚀 Open Test App** any time. Other tasks: **▶ Run tests**, **⏺ Record a
new test**, **📊 View last report**. Or use VS Code's **Testing** panel for a ▶ beside every
test.

## The pages

**In both editions:**

- **Run**: pick one or several environments, click **Run**, watch a live checklist
  (✓ ✕ ◐ ○). Several environments render as a **test × environment matrix** with per-env
  health. **Open full report** for screenshots, video and a step-by-step trace.
- **Tests**: every check, grouped. Run one, tick several and **Run selected**, or **Run by
  tag**. Filter by `@tag` or smart filter (**Failing / Never run / Flaky / Slowest**). 🏷 sets
  group, priority, owner and notes. **Record a new test**: name it, optionally pick a role
  under **Log in as**, click through the site, close the browser. Your clicks are the test.
  Tests can also be **exported and imported as a zip**, to hand a set of checks to someone else.
- **Editor**: edit a spec in the browser, validated before it saves.
- **History**: every past run; filter and reopen any.
- **Report a bug**: pick a run + test, then **Download bug bundle (.zip)**: trace, video,
  screenshots, logs and a plain-language `summary.md`. Or **Copy summary** for an issue
  tracker, or export a single-snapshot **PDF**.
- **User guide**: the manual, in the app, matched to your edition.

**Local only:**

- **Settings**: environments, roles & logins, and appearance, written to local files.

**Team only:** *(these replace Settings: the same jobs, but shared, scoped and audited)*

- **Environments**: the sites everyone tests against, with per-resource visibility.
- **Accounts**: test-target logins, encrypted at rest and shared by visibility.
- **Admin**: users, teams and the audit log.
- The **Editor** also keeps **version history** here.

If a page in this list isn't in your sidebar, check the edition badge next to the logo; you're
in the other edition.

The `trace.zip` is what developers actually want. They drop it on
<https://trace.playwright.dev> and replay the whole session.

### Recording signs itself in

Pick a role under **Log in as**: Greenroom logs you in before the recorder opens, then writes
`await login('<role>')` into the spec. At run time that resolves the right per-environment
account, so **no credentials ever land in a test file**.

### Dynamic form inputs

A recorded test replays the exact text you typed, so re-runs hit "email already exists". Click
**⌗**, pick a generator (unique email, random name, phone) and Greenroom rewrites that field.
Backed by [tests/helpers/data.ts](tests/helpers/data.ts).

## What gets captured

Everything, by default: a **screenshot filmstrip**, the full **video**, every Playwright
**step**, and the browser's **console** and **network** logs (plus `console.log` /
`network.log` attachments for errors and 4xx/5xx). Open a test in the report and click the
trace to see it all at once.

In a hurry? Tick **faster run (less detail)**, or set `CAPTURE=light`. Heavy artifacts are
then kept only for failures.

Want to watch instead of reading a report afterwards? Tick **show the browser** and a real
Chromium window opens and clicks through your app in front of you. Checks then run one at a
time, so it is slower, and it only works on your own machine (a deployed Greenroom has no
screen to open a window on).

## Writing a test by hand

**Record a new test** is the easy path, and [writing checks](docs/guide/writing-checks.md) is
the full walkthrough. Otherwise add a `*.spec.ts` anywhere in `tests/`:

1. Copy the shape of a shipped example: `tests/example-nav.spec.ts` (no login),
   `tests/example-login.spec.ts` (logs in), or `tests/login.spec.ts`, the template for a
   smoke login as one of your own roles.
2. Navigate with **relative** paths: `page.goto('/some/path')` resolves against whichever
   environment you picked, so one test works everywhere.
3. Add `@tags` to the title, like `test('checkout works @smoke', …)`, to filter and run by tag.

Never type a password in a test. Use the `login` fixture (`await login('admin')`), which reads
that role's per-environment account from your `.env`; recording with **Log in as** inserts the
call for you. You only hand-edit [tests/helpers/auth.ts](tests/helpers/auth.ts) for exotic
flows (multi-step, MFA, SSO). Ordinary login forms are configuration.

Tests are **not** tied to an environment: they live flat in `tests/`, and the environment you
pick supplies the base URL and the logins.

## Where things live

| Path | What it's for |
|---|---|
| `server.ts` + `pages/` | The app you run tests from |
| `lib/` | The domain: runner, recorder, bundles, PDF, scoping |
| `tests/` · `tests/helpers/` | Your specs, and reusable pieces like `login` |
| `config/urls.json` | Environment URLs + login forms (git-ignored, seeded from `urls.example.json`) |
| `config/roles.json` | Role definitions, no passwords (git-ignored) |
| `.env` | Your logins (private, git-ignored) |
| `runs/` | Archived past runs (local only) |
| `demo/` | Seeded data for `npm run demo` (committed, read-only) |
| `docs/guide/` | The user manual, served in-app at `/guide` |
| `context/` | A fill-in template describing the app under test |
| `plans/` | The design record: how this was built, and why |

## Commands (optional)

```bash
npm start                                          # the app (http://localhost:4321)
npm run demo                                       # read-only, seeded, zero config
npm run start:platform                             # team edition (see DEPLOY.md)
npm run menu                                       # run from the terminal
npm run record                                     # record a test from the terminal
npm run report                                     # reopen the last report
TEST_ENV=staging npx playwright test               # one environment
TEST_ENVS=staging,production npx playwright test   # several at once
```

`TEST_ENV` picks a single environment; unset, the one marked `"default": true` in
`config/urls.json` wins. `TEST_ENVS` runs the same tests against each environment in turn,
which is what the Run page's multi-select does.

## Docs

**[docs/guide/](docs/guide/)** the user manual · **[DEPLOY.md](DEPLOY.md)** running a real
deployment · **[CLAUDE.md](CLAUDE.md)** how to work in this repo · **[AUDIT.md](AUDIT.md)** the
alignment runbook · **[plans/](plans/)** the design record ·
**[docs/case-study.md](docs/case-study.md)** why it's built this way

## License

MIT. See [LICENSE](LICENSE).

---
🤖 **Built with Claude, so a non-coder never has to meet a terminal.** I decided what "no coding required" has to mean, Claude typed the dashboard that keeps that promise. **I don't prompt and pray, I prompt and prove.** [How I actually work with AI, receipts and all →](https://tjakoen.github.io/notes/ten-times-zero)
