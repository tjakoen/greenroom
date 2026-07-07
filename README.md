# Greenroom

A small **local app** to run automated browser checks against your web app and review the
results. **No coding required.** Runs entirely on your computer, from VS Code or the terminal.

Greenroom wraps [Playwright](https://playwright.dev) in a friendly dashboard: pick an
environment, click **Run**, watch a live pass/fail checklist, and hand developers a
one-click **bug bundle** (trace + video + screenshots + logs). Point it at any website —
you tell it the URLs and how to log in.

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
5. Set your **logins** inside the app: **Settings → Logins**, type the usernames and
   passwords for the roles you test, click **Save**. They're written to a private `.env`
   file on your machine — never shown again, never shared or committed. (No file editing.)

After that, just run the **🚀 Open Test App** task any time to open the app.

## Using the app

The app has a left sidebar with these pages:

- **🏠 Run tests** — pick an environment, click **Run**, and watch a live pass/fail
  checklist (✓ / ✕ / ◐). Raw log is under *Technical details*. **Open full report** for
  screenshots, video and a step-by-step trace. A *Getting started* checklist guides you the
  first time.
- **🧪 Tests** — every individual check, grouped by feature. Run one (hover → **▶ Run**),
  tick several and **Run selected**, or **Run by tag**. Filter by `@tag`, or by smart
  filters (**Failing / Never run / Flaky / Slowest**). Click 🏷 on a test to set its
  **group, priority (P1/P2/P3), owner and notes**. Rename/delete too. **Record a new test**:
  type a name, click record, click through the site, close the browser — your clicks become
  a test.
- **📜 History** — every past run, saved on your computer; filter and open any.
- **🐞 Report a bug** — pick a run + test, then **Download bug bundle (.zip)** (trace,
  video, screenshots, logs, and a plain-language `summary.md` — everything a developer
  needs), or **Copy summary** to paste into an issue tracker/Slack/email. Also exports a
  single-snapshot **PDF** (pick a page, or scrub the video and *Use this frame*).
- **📖 User guide** — the manual, in the app.
- **⚙️ Settings** — logins, environments, light/dark theme.

The `trace.zip` in a bug bundle is the key artifact for devs — they open it at
<https://trace.playwright.dev> to replay the whole session (steps, screenshots, console,
network).

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
npm run menu                    # run from the terminal (prompts for the environment)
TEST_ENV=staging npx playwright test    # run all tests against one environment
npm run record                  # record a test from the terminal
npm run report                  # reopen the last report
CAPTURE=light TEST_ENV=staging npx playwright test   # faster: artifacts only on failure
```

`TEST_ENV` picks which environment to run against. Leave it unset and the one marked
`"default": true` in `config/urls.json` is used.

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
| `.env` | Your logins (private, git-ignored) |
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
[tests/helpers/auth.ts](tests/helpers/auth.ts), which reads them from your private `.env`.
**First edit `auth.ts` to match your app's login form** (URL + field selectors).

## Adding another environment

Use the **Environments** panel in the app: type a name (e.g. `staging`) and its URL, click
**Add**. It seeds a login block in `.env.example`; add the real logins for it in
**Settings → Logins**.

(You can also edit `config/urls.json` directly — see the change-map in [CLAUDE.md](CLAUDE.md).
Mark one environment `"default": true`.)

## License

MIT — see [LICENSE](LICENSE).
