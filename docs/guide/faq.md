---
title: "Safety, speed, and FAQ"
subtitle: "Where your data lives, how to run faster, how to watch a run, and the demo."
date: "2026-07-27"
---
# Safety, speed, and FAQ

## Is my data safe?

On the **local** edition, yes, by design. Greenroom runs entirely on your own computer. Your
logins are saved in a private file that is never uploaded, synced, committed, or sent anywhere.
Your results stay in a folder on your machine. Nothing leaves the computer.

On the **team** edition, your company hosts the instance. Test logins are stored encrypted, a
saved password is never shown again, and results are scoped so people see only what they are
allowed to. Greenroom itself sends nothing to anyone outside your company.

## Where do things live? (local)

- Your site addresses: `config/urls.json`
- Your role definitions (names and which sites): `config/roles.json`
- Your passwords: a private `.env` file, and nowhere else
- Past results: the `runs/` folder

The role and site files never contain passwords. Deleting a role leaves your saved passwords
alone.

## How do I run faster?

Every run captures everything by default, which is thorough but slower. Tick **faster run (less
detail)** on the Run page. Greenroom then keeps the heavy artifacts, like video and trace, only
when a check actually fails.

## Can I watch the checks run?

Yes. Tick **show the browser** on the Run page and a real browser window opens and clicks
through your app while you watch. It is useful when a check fails and you want to see it
happen rather than read the report afterwards.

Two things to know. Checks run one at a time in this mode, so a full run takes longer than
the normal invisible one. And the option only appears when you run Greenroom on your own
machine: a Greenroom your company hosts has no screen to open a window on, so it always runs
invisibly and hands you the video and screenshots instead.

## Can I look before I set anything up?

Yes. Run the **🎬 Open Demo** task (or `npm run demo`). Greenroom boots read-only with example
data already filled in, so you can click a populated dashboard with zero setup. A Demo badge
shows in the sidebar and nothing you click changes real data.

## What are the example checks?

A few `@example` checks ship with Greenroom and run against public sites, so a fresh copy works
out of the box: a login, some navigation, a search, and one that fails on purpose so you can see
what a failure looks like. Use them to learn the app, then delete them once you have your own.

## Can I take a guided tour?

Yes. When you first open Greenroom, a welcome message offers a quick guided tour of the app. You
can also start it any time from this guide.
