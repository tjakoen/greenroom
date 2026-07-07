# Greenroom — User Guide

A short manual. No coding needed. Everything here happens in the app that opens in your
browser when you run the **🚀 Open Test App** task in VS Code (**Terminal → Run Task**).

> New here? Do the four steps on the **Run tests** page's *Getting started* checklist, top
> to bottom. This guide explains each one.

## What this app does

It opens a real browser, clicks through your website exactly like a person would, and tells
you what worked and what broke — with screenshots, video and a full recording you can hand
to a developer. You pick an environment, press **Run**, and read the results.

## The pages (left sidebar)

- **🏠 Run tests** — pick an environment, run the checks, watch results come in live.
- **🧪 Tests** — every individual check. Run one, run a few, rename, delete, or record a new one.
- **📜 History** — every past run, saved on your computer. Open any to review it.
- **🐞 Report a bug** — bundle everything a developer needs into one file, or copy a summary.
- **📖 User guide** — this page.
- **⚙️ Settings** — logins, environments, light/dark theme.

## First time: add your environments and logins

1. Go to **Settings → Environments**: add each site you want to test — a name (e.g.
   `staging`) and its URL. One is marked the default.
2. Go to **Settings → Logins**. Each role you test (the roles are names you choose, e.g.
   `admin`) has a username and password slot. Type them in and click **Save**.
3. A green dot means the login is saved. Passwords are stored in a private file on your
   computer and are **never shown again or shared**.

You only do this once per computer. The coloured dot next to each environment name (on the
Run and Tests pages) tells you at a glance whether its login is ready (green) or missing (amber).

> Logins can be tied to one environment (e.g. a `staging` account) or shared across all of
> them (handy when the same account works everywhere). The Logins panel handles both.

## Run the tests

1. On **Run tests**, click the environment you want (e.g. `staging`).
2. Optionally tick **Faster run** — quicker, but keeps less detail (only when something fails).
3. Click **▶ Run tests**.
4. Results appear as a live checklist: ✓ passed, ✕ failed, ◐ running. Need the raw log?
   Open **Technical details**.
5. When it finishes, click **Open full report ↗** for screenshots, video and a step-by-step
   trace of every check.

Runs can take a few minutes — you can switch to another tab; the checklist keeps updating.

Every test runs against whichever environment you pick — there are no per-environment test
folders, just one set of tests and a choice of where to point them.

## Run just one test

On the **Tests** page, hover a test and click **▶ Run**, or tick several and click
**▶ Run selected**. Handy when you only care about one flow (e.g. login) and don't want to
wait for everything.

## Organise your tests (tags, groups, priority)

The **Tests** page groups every check by feature and gives you four ways to slice them:

- **Tags** — a test whose name ends with `@smoke`, `@auth`, `@critical` etc. shows those as
  chips. Click a tag chip to filter, then **▶ Run by tag** to run just those.
- **Groups** — click 🏷 on a test to put it in a group (e.g. *Authentication*, *Checkout*).
  Grouped tests get their own collapsible section. Ungrouped ones sit under their file.
- **Priority / owner / notes** — also on 🏷: mark a test **P1/P2/P3**, set an owner, jot a
  note (e.g. "flaky on staging"). No coding — it's saved for the whole team.
- **Smart filters** — one click: **Failing**, **Never run**, **Flaky** (passes some runs,
  fails others), **Slowest**. Computed automatically from your run history.

Search box at the top matches names, tags, owners and groups.

## Record a new test (no coding)

1. Go to **Tests → Record a new test**.
2. Type a short name (e.g. `create-account`) and click **⏺ Start recording**.
3. A browser opens. Click through the site — log in, open a page, fill a form.
4. Close the browser. Your clicks are saved as a new test you can run like any other.

## Send a bug to the developers

This is the important one — give devs everything in a single step.

1. Go to **🐞 Report a bug**.
2. Pick the **run** and the **test** that failed.
3. Read the **Summary** (result, environment, error, pages visited, console/network issues).
4. Click **⬇ Download bug bundle (.zip)**. That one file contains:
   - `summary.md` — the plain-language write-up
   - `trace.zip` — the developer opens this at **trace.playwright.dev** to replay the whole
     session: every step, screenshot, console message and network call. This is what they
     need most.
   - `video.webm` — a screen recording of the test
   - `screenshots/` — one image per page
   - `record.json` — the full machine-readable details
5. Or click **📋 Copy summary** to paste the write-up straight into your issue tracker,
   Slack or email.

Want a single image instead of the whole bundle? Use **Export a single-snapshot PDF** lower
on the same page: pick a page (or scrub the video to the exact moment and click *Use this
frame*), then **Download PDF**. When you capture a video frame, the PDF also spotlights the
browser's console + network **from around that moment (±3s)** — so a developer sees exactly
what the site was doing when the problem appeared.

## Add another environment

**Settings → Environments**: type a name (e.g. `staging`) and its URL, click **Add**. It
adds the environment to `config/urls.json` and seeds its login slots (fill those in under
Logins). Every existing test can then run against it — just pick it on the Run page.

## Common questions

**A test failed — is the app broken?** Usually no. A red ✕ means the check found a problem
on the *site under test* (or a login/data issue). Open the report or send the bug bundle to
the devs.

**I don't see my test's result on the Tests page.** Statuses come from the most recent run.
Run the tests once and they'll show.

**Where are my passwords?** In a private `.env` file on your computer only. Never uploaded,
never committed, never displayed back.

**Nothing happens when I record.** Recording opens a real browser window — check it didn't
open behind this one. Close that window to save the test.

**The login step fails on my site.** The login form details (page path, username/password
fields, submit button) live in `tests/helpers/auth.ts`. Whoever set the app up edits the
`LOGIN` object there to match your site — a one-time setup.
