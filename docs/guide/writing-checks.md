---
title: "Writing and recording checks"
subtitle: "Make Greenroom test the things you care about, without writing code."
date: "2026-07-29"
---
# Writing and recording checks

A check is one thing you want to be true about your site, like "a user can log in" or "checkout
works". You do not need to write code to make one.

## Record a check by clicking

This is the easiest way.

1. Open **Tests**, then **Record a new test**.
2. Type a name. If the check needs a login, pick a role under **Log in as**. Greenroom logs you
   in first, so you skip the login screen while you click.
3. Click through your site the way a real user would. Close the browser when you are done.
4. Your clicks become a check. It shows up in the Tests list, with a **runs as** badge if you
   picked a role.

No password ever lands in the recorded check. It stores the role name, and the real login is
looked up at run time.

## Organize checks

On the **Tests** page you can:

- Filter by `@tag`, or by smart filters: failing, never run, flaky, slowest.
- Click the tag button on a check to set its group, priority, owner, and notes.
- Run one, tick several and **Run selected**, or **Run by tag**.

To tag a check, add the tag to its title, like `checkout works @smoke`. Tags are how you group
and run related checks together.

## Make form inputs fresh each run

A recorded check remembers the exact text you typed, like an email. Re-running it can fail with
"that email already exists". Click the make-inputs button on a check, pick a field, and choose a
generator like **unique email** or **random name**. Greenroom rewrites that field so every run
submits new data.

## Writing one by hand (optional)

If you are comfortable with code, add a `*.spec.ts` file in the `tests/` folder and copy the
shape of an existing `example-*` check. Use relative paths like `page.goto('/checkout')` so the
same check works against every environment, and use `login('roleName')` instead of typing a
password. The [Editor](/editor) page lets you do this in the browser.
