---
title: "Getting started on the team platform"
subtitle: "Sign in and run checks alongside your team."
date: "2026-07-30"
---
# Getting started on the team platform

This is the shared way to use Greenroom: your company hosts one instance behind a web address,
and everyone signs in. Your work is organized by teams, and what each person can see is scoped.

If you are the one hosting the instance, read [DEPLOY.md](https://github.com/tjakoen/greenroom/blob/main/DEPLOY.md)
first. This page is for people using an instance that already exists.

## Sign in

1. Open the web address someone on your team gave you.
2. Create an account with your work email, or click **Sign in with Microsoft** if your company
   set that up. The very first person to sign up becomes the administrator.

## The pages you get

The sidebar has a few pages that the local edition does not:

- **Environments** is where your team defines the sites to check. Mark one as the default.
- **Accounts** holds the test logins, stored encrypted. A saved password is never shown again,
  only whether one is set. You choose who each account is visible to: just you, your team, or
  everyone in the company.
- **Admin** (administrators only) manages people and teams, and shows an audit log of every
  change.

## Run a check

1. Open **Run**, pick one or more environments, and click **Run Tests**.
2. Runs are queued and isolated, so several people can run at the same time without interfering.
3. Watch the live checklist, then open the full report for screenshots, video, and the trace.

Runs, history, and bug bundles are shared with your team, scoped so people see what they are
allowed to see. A private check's results stay private to its owner.

## Next

- [Writing and recording checks](/guide/writing-checks): add the checks your team needs.
- [Bringing in tests you already have](/guide/existing-tests): import checks from another
  Greenroom, or adapt Playwright scripts your team already wrote.
- [Reporting a bug](/guide/reporting-bugs): hand a developer one file with everything in it.
- [Safety, speed, and FAQ](/guide/faq): how data is stored, how to run faster.
