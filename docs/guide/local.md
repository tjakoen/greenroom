---
title: "Getting started on your computer"
subtitle: "Set up and run your first check. No accounts, nothing leaves your machine."
date: "2026-07-30"
---
# Getting started on your computer

This is the local way to use Greenroom: one person, one computer, no accounts, no sign-in.
Everything you set up and every result stays on your machine.

## The one-time setup

You only do this once.

1. Install **Node.js** (the LTS version) from nodejs.org, then **Bun** from bun.sh. These are the
   two things Greenroom runs on. Installing them is like installing any other app.
2. Open this folder in **VS Code** (File, then Open Folder). If it offers the Playwright
   extension, say yes.
3. Start Greenroom with no typing: **Terminal**, then **Run Task**, then **🚀 Open Test App**.
   The first start installs a few things and can take a couple of minutes. When it finishes, the
   app opens in your browser.

## Point it at your site

1. Open **Settings**, then **Environments**. Add a row for each site you want to check: a short
   name like `staging` and its web address. Mark one as the default.
2. Open **Settings**, then **Roles & logins**. A role is a named login, like `admin` or
   `editor`. Create one, tick the sites it works on, and type a username and password for each.
   Click **Save**.

Your passwords are saved in a private file on this computer and are never shown again, never
uploaded, and never shared. See [Safety and FAQ](/guide/faq) for exactly where things live.

## Run your first check

1. Open **Run**.
2. Click one or more environment pills to choose where to check.
3. Click **Run Tests**.
4. Watch the checklist fill in live. A green mark passed, a red mark failed. The health bar shows
   how the whole run is going. Click **Open full report** for screenshots, video, and a full
   step-by-step trace.

A ready-made `example` role and a handful of `@example` checks ship with Greenroom and run
against public sites, so you have something to click before you add your own site.

## Next

- [Writing and recording checks](/guide/writing-checks): make Greenroom test the exact things
  you care about, without writing code.
- [Reporting a bug](/guide/reporting-bugs): turn a failed run into one file a developer can open.
- [Safety, speed, and FAQ](/guide/faq): where data lives, how to run faster, the demo.
