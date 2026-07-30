---
title: "Bringing in tests you already have"
subtitle: "Move checks from another Greenroom, or adapt any Playwright script, then point them at your own sites and logins."
date: "2026-07-31"
---
# Bringing in tests you already have

You do not have to start from scratch. Checks can arrive two ways:

- **From another Greenroom.** Someone exports a zip, you import it. Almost everything travels.
- **From any Playwright project.** You already have specs written elsewhere. They need a few
  small edits, then they behave like native checks.

Both paths end at the same place, and both share one catch worth reading first.

## The catch: sites and logins never travel

Whichever way checks arrive, **they do not bring your colleague's environments or logins with
them**, and they never bring passwords. That is deliberate. Credentials stay on the machine they
were typed on, and nobody's real site addresses get passed around in a file.

So a check that arrives referring to a role called `admin` will not run until **you** have created
a role called `admin` on your side, pointed at **your** environments, with **your** password.

Before running anything you imported, set up both:

1. **Environments.** Add each site you want to test, with its address. One is the default. In the
   team edition these live under **Environments**; on your own machine they are under
   **Settings**.
2. **Roles & logins.** Create a role for each account the checks sign in as, tick which sites it
   applies to, and enter the username and password for each. The name has to match what the check
   asks for.

If you are not sure what a check needs, open it in the **Editor** and look for `login('...')`. The
name in the brackets is the role you need to create. The Tests page also shows a **runs as** badge
on checks that sign in.

Get this wrong and the symptom is clear enough: the check fails at the login step, or it runs
against the wrong site.

## Path A: from another Greenroom

1. Ask them to open **Tests**, select the checks to share, and use **Export**. They get a zip.
2. On your side, open **Tests** and use **Import**, then pick that zip.

What comes across:

- the check files themselves
- any shared helper code they rely on
- their labels: group, priority, owner, notes, and the role each check signs in as

What does not come across: environments, logins, run history, and reports. Set up the first two as
described above.

Existing files are never overwritten silently. If a check with the same file name is already
there, the import skips it and tells you, so you cannot lose your own work by importing.

Once the import is done, jump to the checklist at the end. There is nothing to edit, because the
checks were already written for Greenroom.

## Path B: from any Playwright project

Existing specs work here, because this is ordinary Playwright underneath. Work through these in
order. After step 2 your checks run. Steps 3 and 4 are what make them feel native.

### 1. Get the files in

Put each `*.spec.ts` directly into the `tests/` folder. Put any helper modules they import into
`tests/helpers/`, which is reserved for shared code and is never listed as a check.

Do not create a folder per environment. Checks are not tied to an environment here, which is the
point of the next step.

### 2. Make the addresses relative

This is the most important change, and the easiest to miss, because nothing looks broken if you
skip it.

Replace any full web address with just the path:

```ts
// before
await page.goto('https://staging.example.com/checkout');

// after
await page.goto('/checkout');
```

Each environment supplies its own base address. A check written with a path runs against dev,
staging and production without being edited. A check written with a full address ignores the
environment you picked, so choosing several environments just tests the same site repeatedly and
every result looks identical.

### 3. Switch the import

Change the top of each spec from Playwright's own import to Greenroom's:

```ts
// before
import { test, expect } from '@playwright/test';

// after
import { test, expect } from './helpers/fixtures';
```

Everything else in the file stays the same. This matters more than it looks, because a check that
skips it still passes and still records video and a trace. What it quietly loses is everything the
bug report is built from:

- the screenshot filmstrip, so the **Report a bug** scrubber has nothing to step through
- the browser console and network log tied to moments in time, so "what happened here" is blank
- the record that PDF export reads, so there is no PDF to produce

Nothing errors. You simply get a thinner report, and only notice when you need it. If you change
one thing on this page, make it this.

### 4. Use the login fixture

If your specs sign in by typing credentials, replace that with a role:

```ts
// before
await page.fill('#username', process.env.TEST_USER);
await page.fill('#password', process.env.TEST_PASS);
await page.click('#signin');

// after
await login('admin');
```

Add `login` to the test's arguments:

```ts
test('checkout works @smoke', async ({ page, login }) => {
  await login('admin');
  await page.goto('/checkout');
});
```

The check then looks up the right account for whichever environment it is running against, so one
check covers all of them. It also makes the Run page's **Run as** override work, letting you
replay the same flow as a different account to test permissions.

Never leave a real password in a check.

### 5. Add tags

Put a tag in the title to make a check filterable and runnable on its own:

```ts
test('checkout works @smoke', async ({ page }) => {
```

You can also add tags later from the **Tests** page, using the tag button, without editing files.

## Things that catch people out

**Write titles as plain text.** Greenroom reads check names out of the file by pattern matching,
not by running it. A title stitched together from a variable or a template placeholder will not be
read properly, so the check runs but shows up wrong in the Tests list. Keep the name a simple
quoted string.

**Grouping blocks are fine, but only the inner name shows.** If you use `test.describe`, the group
name is not displayed; only the individual check names inside it are. Two checks with the same
name inside different groups in the same file will be treated as one, so give them distinct names.

**Fixtures you wrote yourself.** If your specs extend Playwright's test object with your own
fixtures, keep that file in `tests/helpers/` and have it build on Greenroom's fixtures rather than
on `@playwright/test`, so you keep the reporting features from step 3.

## A quick checklist

Before the first run, whichever path you took:

1. Environments added, one marked as the default.
2. Roles created, with names matching what the checks ask for, and a login for each site.
3. Files in `tests/`, helpers in `tests/helpers/`.
4. Coming from plain Playwright: addresses replaced with paths, import switched to
   `./helpers/fixtures`, logins replaced with `login('role')`.

Then run them once against a real environment and open the report. If the screenshot scrubber on
the **Report a bug** page has images to step through, everything is wired up.

## Next

- [Writing and recording checks](/guide/writing-checks): let Greenroom write new checks for you.
- [Reporting a bug](/guide/reporting-bugs): turn a failed run into one file a developer can open.
- [Safety, speed, and FAQ](/guide/faq): where data lives, how to run faster, how to watch a run.
