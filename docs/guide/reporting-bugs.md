---
title: "Reporting a bug"
subtitle: "Turn a failed run into one file a developer can open."
date: "2026-07-28"
---
# Reporting a bug

When a check fails, Greenroom can package everything a developer needs into one file. No writing
up steps, no screenshots to gather by hand.

## Make a bug bundle

1. Open **Report a bug** (or click **Report this** on a failed check).
2. Pick the run and the failed check.
3. Click **Download bug bundle**. You get a `.zip` with the trace, the video, the screenshots,
   the console and network logs, and a plain-language `summary.md`.

Send that one file to a developer. Or click **Copy summary** to paste into an issue tracker,
Slack, or email.

## The trace is the important part

Inside the bundle is a `trace.zip`. A developer opens it at **trace.playwright.dev** and replays
the entire session: every step, a screenshot at each one, and the console and network activity.
It is the closest thing to sitting next to the person when it broke.

## Export a single moment as a PDF

Sometimes you just want one page. On the Report a bug screen you can step through the screenshots
the check captured, or scrub the video and pick a frame, then export a one-page PDF of that
moment with the console and network activity around it.

## What is captured

Every run records a screenshot per step, the full video, the browser console, and the network
log, so the evidence is already there when something fails. To run faster, see
[Safety, speed, and FAQ](/guide/faq).
