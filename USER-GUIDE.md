# Greenroom — User Guide

A short manual. No coding needed. Everything here happens in the app that opens in your
browser when you run the **Open Test App** task in VS Code (**Terminal → Run Task**).

> New here? Do the steps on the **Run tests** page's *Getting started* checklist, top to
> bottom. This guide explains each one.

## What this app does

It opens a real browser, clicks through your website exactly like a person would, and tells
you what worked and what broke — with screenshots, video and a full recording you can hand
to a developer. You pick one or more environments, press **Run**, and read the results.

> **Just want a look first?** Run the **Open Demo** VS Code task (or `npm run demo`).
> Greenroom opens in **read-only demo mode** with example data already filled in — a
> populated dashboard, a run with both passing and failing tests, and example roles — so you
> can explore with zero setup. A **Demo** badge shows in the sidebar; nothing you click
> changes your real data.

## The pages (left sidebar)

- **Run tests** — pick one or more environments, run the checks, watch results come in live.
- **Tests** — every individual check. Run one, run a few, tag, group, rename, delete, or
  record a new one.
- **History** — every past run, saved on your computer. Open any to review it.
- **Report a bug** — bundle everything a developer needs into one file, or copy a summary.
- **User guide** — this page.
- **Settings** — roles & logins, environments, site groups, and appearance (theme).

## First time: add your environments and logins

1. Go to **Settings → Environments**: add each site you want to test — a name (e.g.
   `staging`) and its URL. One is marked the default.
2. Go to **Settings → Roles & logins**. A **role** is a named account you test with (you
   choose the names, e.g. `admin` or `editor`):
   - **Add a role** and give it a label.
   - **Tick which sites** it applies to (or mark it shared, so one login works everywhere).
   - **Type a username and password for each site**, then click **Save**.
3. A green dot means the login is saved. Passwords are stored in a private file on your
   computer and are **never shown again or shared**.

You only do this once per computer. The coloured dot next to each environment name (on the
Run and Tests pages) tells you at a glance whether its login is ready (green) or missing (amber).

> A role can have a different account per site (e.g. a separate `staging` login) or one
> shared account used everywhere — the panel handles both. **Deleting a role never deletes
> your saved passwords** — it only removes the role's definition.

> A ready-made `example` role ships pre-configured (it uses a public demo login), so the
> built-in example tests run without any setup.

## Run the tests

1. On **Run tests**, click the environment you want (e.g. `staging`). You can click **more
   than one** — the environment pills are multi-select, so you can check the same tests
   against, say, `staging` and `production` in one go. If you've saved a **site group** in
   Settings, its chip appears here too — one click selects the whole group.
2. Optionally tick **Faster run** — quicker, but keeps less detail (only when something fails).
3. Optionally change **Run as** to override which login every test uses for this run, or
   leave it as each test's own role.
4. Click **Run** (it reads **Run on N sites** once you've picked more than one environment).
5. Results appear as a live checklist: a check mark for passed, a cross for failed, a filled
   circle for running. Need the raw log? Open **Technical details**.
6. When it finishes, click **Open full report** for screenshots, video and a step-by-step
   trace of every check.

If you picked several environments, the results show as a **grid of test × environment**,
with a health summary per environment, so you can see at a glance which site a test failed
on. Each environment uses its own login where one is set (falling back to a shared login).

Runs can take a few minutes — you can switch to another tab; the checklist keeps updating.

Every test runs against whichever environment(s) you pick — there are no per-environment test
folders, just one set of tests and a choice of where to point them.

## Run just one test

On the **Tests** page, hover a test and click **Run**, or tick several with the checkboxes
and click **Run selected**. Handy when you only care about one flow (e.g. login) and don't
want to wait for everything.

## Organise your tests (tags, groups, priority)

The **Tests** page groups every check by feature and gives you four ways to slice them:

- **Tags** — a test whose name ends with `@smoke`, `@auth`, `@critical` etc. shows those as
  chips. Click a tag chip to filter, then **Run by tag** to run just those.
- **Groups** — click the tag icon on a test to put it in a group (e.g. *Authentication*,
  *Checkout*). Grouped tests get their own collapsible section. Ungrouped ones sit under
  their file.
- **Priority / owner / notes** — also on the tag icon: mark a test **P1/P2/P3**, set an
  owner, jot a note (e.g. "flaky on staging"). No coding — it's saved for the whole team.
- **Smart filters** — one click: **Failing**, **Never run**, **Flaky** (passes some runs,
  fails others), **Slowest**. Computed automatically from your run history.

Search box at the top matches names, tags, owners and groups.

## Record a new test (no coding)

1. Go to **Tests → Record a new test**.
2. Type a short name (e.g. `create-account`).
3. Optionally pick a role under **Log in as** — Greenroom logs you in first, so you can skip
   the login screen and start recording from inside the app.
4. Click **Start recording**. A browser opens. Click through the site — open a page, fill a
   form, submit.
5. Close the browser. Your clicks are saved as a new test you can run like any other.

If you chose a **Log in as** role, the recorded test logs itself in with the right account
for whichever environment you run it against — **no passwords are written into the test**.
The Tests page shows a **runs as: `<role>`** note on it.

## Make a test use fresh data each run

Recorded tests remember the exact text you typed — including things like an email address.
Re-running such a test can fail with "that email already exists". To fix it:

1. On the **Tests** page, click the **Make inputs dynamic** icon on the test.
2. You'll see the values it fills in. For any field, pick a generator — **unique email**,
   **random name**, **random phone**, and so on.
3. Save. Now each run submits fresh, unique data, so it won't clash with what a previous run
   created.

## Send a bug to the developers

This is the important one — give devs everything in a single step.

1. Go to **Report a bug**.
2. Pick the **run** and the **test** that failed.
3. Read the **Summary** (result, environment, error, pages visited, console/network issues).
4. Click **Download bug bundle (.zip)**. That one file contains:
   - `summary.md` — the plain-language write-up
   - `trace.zip` — the developer opens this at **trace.playwright.dev** to replay the whole
     session: every step, screenshot, console message and network call. This is what they
     need most.
   - `video.webm` — a screen recording of the test
   - `screenshots/` — one image per page
   - `record.json` — the full machine-readable details
5. Or click **Copy summary** to paste the write-up straight into your issue tracker, Slack
   or email.

Want a single image instead of the whole bundle? Use **Export a single-moment PDF** lower on
the same page. It's a screenshot scrubber, not a video: step through the screenshots the
test captured with the previous/next buttons (or drag the slider). For each screenshot, the
panel below shows the console and network activity that happened **since the previous
screenshot**, so you can confirm the problem is captured before you export. Once you're
happy with the moment shown, click **Download PDF**. The full screen recording is also
available underneath as a secondary reference (**Full screen recording**, with buttons to
download the whole video or a short clip around the current step).

## Add another environment

**Settings → Environments**: type a name (e.g. `staging`) and its URL, click **Add**. Then go
to **Roles & logins**, tick the new site on any role that should run there, and fill in its
username + password. Every existing test can then run against it — just pick it (alone or
alongside others) on the Run page. You can also save a combination of sites as a **site
group** in Settings, so picking them together on the Run page is one click.

## Explore without any setup

- **Demo mode** — run the **Open Demo** VS Code task (or `npm run demo`) to open Greenroom
  read-only with example data already filled in. Nothing you click changes your real setup.
- **Example tests** — a small set of checks ship built in and run against public websites
  with no setup: a login, some page navigation, a search, and one that **fails on purpose**
  so you can see what a red result looks like. Use them to learn the app, then delete them
  once you have your own tests.

## Common questions

**A test failed — is the app broken?** Usually no. A red cross means the check found a
problem on the *site under test* (or a login/data issue). Open the report or send the bug
bundle to the devs.

**I don't see my test's result on the Tests page.** Statuses come from the most recent run.
Run the tests once and they'll show.

**Where are my passwords?** In a private `.env` file on your computer only. Never uploaded,
never committed, never displayed back. (Role *names* and which sites they apply to live in
`config/roles.json` — no passwords there. Deleting a role never removes your saved passwords.)

**Nothing happens when I record.** Recording opens a real browser window — check it didn't
open behind this one. Close that window to save the test.

**The login step fails on my site.** The login form details (page path, username/password
fields, submit button) live in `tests/helpers/auth.ts`. Whoever set the app up edits the
`LOGIN` object there to match your site — a one-time setup.
