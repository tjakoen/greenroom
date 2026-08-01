---
title: "Bringing in tests you already have"
subtitle: "Import checks from another Greenroom, or Playwright scripts from anywhere, then point them at your own sites and logins."
date: "2026-07-31"
---
# Bringing in tests you already have

You do not have to start from scratch, and you do not have to edit any files. Checks can arrive
two ways:

- **From another Greenroom.** Someone exports a zip, you import it.
- **From anywhere else.** You already have Playwright scripts, written by a developer or by you.
  Greenroom adapts them for you when they come in.

Both end up in the same place, and both share one thing you have to do yourself.

## The one thing you have to set up

Whichever way checks arrive, **they never bring sites or logins with them**, and they never bring
passwords. That is on purpose. Passwords stay on the machine they were typed on, and nobody's real
web addresses get passed around in a file.

So a check that arrives expecting an account called `admin` will not run until **you** have made an
`admin` role on your side, pointed at **your** sites, with **your** password.

Set up both before running anything you brought in:

1. **Your sites.** Add each one with its address, and mark one as the default. On your own machine
   this is under **Settings**. On a shared Greenroom it is under **Environments**.
2. **Roles & logins.** Make a role for each account the checks sign in as, tick which sites it
   applies to, and type the username and password for each.

You do not have to guess what a check needs. After importing, Greenroom tells you on screen if a
check expects a login, and the Tests page shows a **runs as** badge on checks that sign in.

## From another Greenroom

1. Ask them to open **Tests**, tick the checks to share, and press **Export**. They get a zip file.
2. Open **Tests**, press **Import**, and pick that zip.

Their checks arrive with their labels: group, priority, owner, notes, and which role each one signs
in as. Shared helper code comes too.

Checks already on your side are never overwritten. If a file with the same name is there, the
import leaves yours alone and says how many it skipped, so you cannot lose work by importing.

## From anywhere else

Playwright scripts written outside Greenroom usually need two changes to work properly here.
**Greenroom makes both for you.** You do not need to open a file or understand what changed.

You have two ways in:

- **Press Import** and pick a zip of your scripts.
- **Copy the files** into the `tests` folder, then open **Tests** and press
  **Make my tests work here**. Tick specific checks first to limit it to those, or press it with
  nothing ticked to do all of them.

Either way you get a short summary of what happened.

### What it changes for you

**It makes addresses portable.** A script written elsewhere usually has a full web address in it,
like `https://staging.example.com/checkout`. That pins the check to one site, so picking a
different site on the Run page would change nothing. Greenroom shortens it to just `/checkout`, so
the same check runs against whichever site you pick. It only does this for addresses that match
sites you have set up.

**It turns on full reporting.** This is the one that matters most and is easiest to miss. A script
from elsewhere still passes without this change, so nothing looks wrong. What is missing only
shows up later, when a check fails and you go to report it: no screenshots to scroll through, no
browser log for the moment it broke, and no PDF to export. Greenroom switches this on, so a
failure gives you the full bug report.

### What it will not do behind your back

Two things are reported rather than changed, because guessing would be worse than asking:

**A check that signs itself in.** If a script types a username and password directly, Greenroom
tells you which check and which line, and leaves it alone. Make a role under **Roles & logins**,
then open that check on the Tests page and press **Login**. Pick the role, and Greenroom shows you
the sign-in steps it found so you can untick anything you want to keep, then it wires the check to
sign in through your role and removes the ones you left ticked. Greenroom then fills in the right
account for each site, and the password never sits inside a check.

**A check that visits somebody else's website.** If a check goes to an address that is not one of
your sites, that address is kept exactly as it is, because it is probably deliberate. Greenroom
points it out so you know that check ignores which site you pick.

Both appear in a note at the top of the Tests page after importing, with the file and line.

## Things that catch people out

**Keep check names as plain text.** Greenroom reads names out of the file to list them. A name
built up from a variable or a placeholder cannot be read properly, so the check runs but looks
wrong in the list.

**Grouping blocks show only the inner name.** If your scripts group checks together, the group name
is not shown, only the checks inside it. Two checks with the same name in different groups in one
file get treated as one, so give them different names.

## A quick checklist

1. Your sites added, one marked as the default.
2. A role for each account the checks use, with a login for each site.
3. Checks brought in, by **Import** or by **Make my tests work here**.
4. Anything flagged in the note at the top of the Tests page dealt with.

Then run them once and open the report. If **Report a bug** lets you scroll through screenshots,
everything is wired up.

## Next

- [Writing and recording checks](/guide/writing-checks): let Greenroom write new checks for you.
- [Reporting a bug](/guide/reporting-bugs): turn a failed run into one file a developer can open.
- [Safety, speed, and FAQ](/guide/faq): where data lives, how to run faster, how to watch a run.
