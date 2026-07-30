# Greenroom: a case study

A local, no-code app for running Playwright end-to-end checks against any live web app, and a
deployable multi-user platform, from one codebase.

**Repo:** <https://github.com/tjakoen/greenroom> · **Features page:**
[docs/index.html](index.html) · **Design record:** [plans/](../plans/) ·
**Alignment runbook:** [AUDIT.md](../AUDIT.md)

---

## The problem

End-to-end tests are written by developers and read by developers. Everyone else, the people
who actually know what "broken" looks like, gets locked out twice: they can't write a check,
and they can't read the result. So regressions get reported as "the thing is weird again", and
a developer spends the first hour of every bug reproducing it.

Greenroom's premise: let the person who noticed the problem run the checks and produce a
report a developer can act on immediately, without writing code or typing a command.

## Constraints that shaped it

These were fixed up front, and they drove most of the architecture:

1. **The app under test is not in this repo.** No source, ever. Tests are written against real
   URLs using a fill-in map of routes and selectors ([context/](../context/)). This keeps the
   tool generic and means it can be pointed at anything.
2. **No secrets, no real URLs, ever committed.** Credentials live in a git-ignored `.env` (or
   encrypted in the DB); environment URLs in a git-ignored `config/urls.json`. Only generic
   `*.example` templates are tracked.
3. **No command typing.** A non-coder opens the folder in VS Code and picks a task. Everything
   else is a web UI.
4. **Login is configuration, not code.** Every app's sign-in form differs. Rather than make
   users edit a helper file, the form's selectors are data: set in the UI, resolved at runtime
   (`getLoginForm(env)` → per-env → shared → generic default). Hand-editing is reserved for
   genuinely exotic flows: multi-step, MFA, SSO.
5. **A dependency floor.** Every added package has to justify itself in writing
   ([plans/platform.md](../plans/platform.md) §8). The ZIP writer, the PDF renderer and the
   random-data generators are all hand-rolled rather than pulled in.

## Shape of the system

~800 lines of composition root, ~3,400 lines of domain, ~4,400 lines of pages, 29 HTTP
endpoints.

```
server.ts          one composition root: routes, SSE hub, page rendering, auth gate
lib/*.ts           the domain, 21 modules: runner · recorder · run-queue · run-scope
                   bundle · pdf · zip · ffmpeg · creds · roles · envs · scope · secret · audit
pages/*            one *-page.ts (server-rendered) + one *.js (client) per route
tests/             flat Playwright specs, never per-environment folders
plans/             the design record, as a PROOF plan board
```

Two decisions did the most work:

**Tests are decoupled from environments.** Specs live flat in `tests/` and navigate with
relative paths (`page.goto('/checkout')`). The environment you pick at run time supplies the
base URL and the credentials. One spec therefore runs against dev, staging and production
without modification, and selecting several environments at once produces one Playwright
project per environment and a test × environment result matrix.

**The domain is separate from the transport.** Everything real lives in `lib/` as plain
functions over the filesystem or the DB. `server.ts` only wires HTTP to them. That's what made
the next part survivable.

## The hard part: one codebase, two editions

Greenroom began as a single-user local tool. It later had to also be a deployed instance that a
company runs for many concurrent users, with accounts, teams, per-resource visibility and a run
queue, *without* the local edition growing an account system, a database, or a login screen.

The rule that made this tractable:

> **Nothing on a local request may touch `db` or `auth`.**

Not "should not" but *cannot*, or the lazy SQLite handle opens a database file that a local user
never asked for. Enforcement is structural rather than by convention:

- `lib/paths.ts` exposes a single `IS_PLATFORM` / `IS_LOCAL` flag (set by `GREENROOM_MODE`, or
  implied by `ALLOWED_HOSTS`, since a real deployment is always the platform edition).
- `db/index.ts` and `auth/index.ts` export **lazy proxies**. Nothing is constructed at import
  time, so merely loading a module can't open the DB or build the auth stack.
- The session gate, the scoped APIs, the platform-only pages and `/api/auth/*` all sit behind
  `if (IS_PLATFORM)`. The flat-file config *write* endpoints invert it: they return
  `PLATFORM_CONFIG_LOCKED` on a deployment, because there the DB is the source of truth.
- Demo mode is a read-only *local* variant: every read boundary swaps to a committed `demo/`
  fixture directory and every write endpoint refuses.

The payoff is that `npm start` and a deployed instance are the same binary with different gates,
and the local edition kept its original promise: no accounts, no database, no ceremony.

## Security work

Three hardening passes, each recorded in the plan board. The two findings worth describing:

**Private test artifacts leaked through the artifact endpoints.** Visibility scoping was correct
on the resources themselves, but a *run* is a different object from the *test* it covered, and
the bug-report endpoints (`/api/pdf-data`, `/api/video`, `/api/bug-bundle`, the static
`/report` and `/runs/` serves) took a `?run=` parameter and served whatever it named. Anyone
with a run id could read screenshots and video of a private test. The fix is
[lib/run-scope.ts](../lib/run-scope.ts) `canReadRun()`, resolving a run by id *or* artifact
directory back through `runResult` → `test.visibility`, applied as one up-front guard across
every artifact endpoint. Company and team visibility stay open by design; only `private` is a
wall.

**A deployment could boot insecurely.** An instance reachable over a network now refuses to
start without `BETTER_AUTH_SECRET`, `SECRET_KEY`, and an https `BETTER_AUTH_URL`. A missing
secret is a startup failure, not a silent default.

Test-target credentials are encrypted at rest (AES-256-GCM, `lib/secret.ts`), decrypted only
inside the test runner's own process, and never written to disk or returned to a client. Saved
usernames are shown so a form can pre-fill; passwords are never returned once saved.

## Keeping it honest

The thing I'd point at first, because it's the part that usually doesn't exist:

- **[AUDIT.md](../AUDIT.md)** is a runnable alignment runbook. Eight sections, each a command
  plus a pass bar: no secrets committed, no real URLs, no app source, typechecks green, the app
  boots, environments wired consistently, docs synced, and public-repo gates. Run before
  committing.
- **[CLAUDE.md](../CLAUDE.md)** carries a "when you change X, update Y" table, so the coupling
  between a feature and its docs is written down rather than remembered.
- **[plans/](../plans/)** is the design record: every phase, its dependencies, and what it
  touched.
- 35 unit and booted-server integration tests over the auth, scope and crypto gates; two
  typecheck configs (composition root, and legacy specs) that both stay green.

That runbook has caught real drift, including in its own checks. Its brand-string gate used a
`--include='*.md' --include='*.ts'` extension allowlist, which silently skipped extensionless
tracked files, so a stale employer name sat in `LICENSE` line 3 while the check reported green.
It now scans `git ls-files` via `git grep`, because tracked content is exactly what goes public.

The same runbook later caught something a text scan alone would have missed: two long-deleted
spec files still sitting in git history, carrying real routes and selectors from an app under
test. Deleting a file does not unpublish it. That is now section 8, and it runs before a first
publish rather than after.

## Known gaps

Stated plainly, because a case study that claims everything works is not worth reading:

- **No lockfile is committed.** Runtime dependencies are exact pins, but the dev dependencies
  use caret ranges, so two installs weeks apart can differ. Tracked as deploy hardening.
- **Recording needs a real browser on a real screen**, so it is local-only by construction. A
  headless deployment refuses it rather than failing obscurely.
- **The demo fixtures are committed screenshots and videos.** They make a fresh clone
  immediately explorable, at the cost of repo weight.

## Built with Claude

Every line here was written with Claude Code, which is the point rather than an aside: the
interesting question was never whether it could produce the code, but what has to be true for
the output to be trustworthy. The answer, in this repo, is the boring infrastructure: a
non-negotiables list, a change-map table, a runnable audit, a plan board, and gates that fail
loudly. **I don't prompt and pray, I prompt and prove.**

[How I actually work with AI, receipts and all →](https://tjakoen.github.io/notes/ten-times-zero)
