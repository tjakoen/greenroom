---
id: executable
status: todo
track: distribution
depends: []
touches: [lib/paths.ts, server.ts, scripts/, .github/workflows/]
owner: human
---

# EXECUTABLE — ship Greenroom as a double-clickable app (2026-08-04)

> **Status: PARKED 2026-08-04, by decision, not by a blocker.** (Frontmatter stays `todo` because the
> vocabulary is todo/doing/done/blocked and `blocked` would be wrong: nothing is waiting on anything,
> this was deprioritised deliberately.) Ranked behind the real deployment and behind Entra SSO.
>
> The spike answered the hard question — `bun build --compile` DOES produce a working binary for this
> codebase — but then answered a harder one badly: **a Bun binary does not remove the Node
> requirement**, which was the whole point. See the premise section below before restarting this.
> Decision taken if it ever resumes: **unsigned, Chromium fetched on first run, Node shipped in the
> bundle.**
>
> Nothing here is wasted if it stays parked. The one code change it required (pulling Playwright out
> of the boot graph, commit 7838c72) was worth making on its own merits and is already on main.

## Why

The local edition's entry point is "open the folder in VS Code and run a task". That assumes a
checkout, VS Code, and `bun install`. For someone who cannot install Node, an executable is the only
local path. (Producers who cannot install anything at all are served by the hosted Team edition
instead, which needs nothing but a URL. This plan is for the other audience: individual testers and
developers on their own machine.)

## What is settled

**It compiles.** With Playwright marked external:

```
bun build --compile server.ts --outfile dist/greenroom \
  --external '@playwright/test' --external playwright \
  --external playwright-core --external chromium-bidi
```

→ 979 modules bundled, a 64MB binary (the Bun runtime is most of that).

**Two source changes were needed and are already made** (see the commit that adds this file):
`lib/pdf.ts` and `lib/recorder.ts` imported `chromium` from `@playwright/test` at module scope. A
static import drags `playwright-core` into the build graph, and playwright-core has optional deps
(`chromium-bidi`) that no bundler can resolve, so the compile failed outright. Both now import
dynamically at their single call site. Marking them `--external` is not optional either: Playwright
MUST resolve from disk at runtime, because `@playwright/test` compiles the user's `.spec.ts` files
when a run starts. Verified PDF export still produces a real 33KB PDF after the change.

## The premise problem: a Bun binary does NOT remove the Node requirement

Found 2026-08-04, after the compile spike, and it undercuts the main reason to build this at all.

Playwright's test runner needs **Node**. `node_modules/playwright/cli.js` opens with
`#!/usr/bin/env node`, and `lib/runner.ts` spawns `npx playwright test`. Running the CLI under Bun
gets as far as `Version 1.61.1` and then fails compiling the config, because Playwright's own
TypeScript transform does not engage under Bun:

```
$ bun node_modules/playwright/cli.js test --list
error: Expected ";" but found "GrOptions"   (playwright.config.ts:23 — a plain type alias)
```

So a Bun-compiled executable removes the clone and the `bun install`, but leaves the user still
needing Node, which was the main thing it was supposed to remove. Three options:

1. **Ship a Node runtime inside the bundle** (+50-110MB). The only version that is genuinely
   no-install. Bundle lands around 130MB, plus the 344MB Chromium fetch on first run.
2. **Require Node.** Fatal for anyone who cannot install software; a modest convenience for someone
   who simply does not want to deal with a repo.
3. **Make the test runner work under Bun.** Fighting upstream on their transform pipeline. Not worth it.

**Only option 1 is worth building.** If this gets picked up, that is the shape.

## Is this worth doing at all?

Worth re-deciding before spending the days, because the audience is narrower than it looks:

- Producers who cannot install anything are **already served by the hosted Team edition** (a URL).
- Developers can clone the repo.
- That leaves people who can run a downloaded app but cannot install Node. Real, but narrow.

And the catch: on a locked-down corporate machine, the policy that blocks installing Node usually
also blocks running **unsigned** downloaded binaries, and unsigned is the decision taken below. So
the executable risks being refused by exactly the machines that justify it, while the people who can
run it could probably have installed Node anyway.

Recommendation: rank this behind the deployment itself and behind Entra SSO. Not abandoned, but do
not treat it as the answer to "someone cannot install software" — the hosted edition is that answer.

**What cannot go inside the binary, ever:**
- **Chromium** (344MB native). Fetched on first run.
- **`@playwright/test` + `playwright` + `playwright-core`** (~17MB of real files). The test runner
  compiles user specs at runtime and needs a resolvable module root.

Everything else (server, pages, GRAIN/Monaco/CRUMB assets, the seed `tests/` and `config/*.example`)
can be embedded or shipped beside the binary.

## The exact failure that stops it today

```
$ cd /tmp/gr-exe && ./greenroom
error: Cannot find module '@tjakoen/grain/styles/variables.css' from '/$bunfs/root/greenroom'
```

`/$bunfs/` is the compiled binary's virtual filesystem. `server.ts` resolves shell assets with
`import.meta.resolve("@tjakoen/grain/...")` (and CRUMB the same way, plus Monaco via
`join(ROOT, "node_modules", ...)`). None of those exist inside a binary.

## Remaining work

1. **Asset resolution** — `server.ts:84` (GRAIN), `:110` (Monaco), `:333` (CRUMB). Replace
   `import.meta.resolve` / `ROOT`-relative lookups with a resolver that prefers a sidecar
   `assets/` dir next to the executable and falls back to `node_modules` when running from source.
   Both modes must keep working: the repo checkout is still the primary development path.
2. **`ROOT` becomes two ideas.** Today `ROOT = join(import.meta.dir, "..")` serves as both "where the
   code is" and "where the user's data is". In a binary those diverge. 68 call sites across 15 files
   derive from `ROOT`, but they all import it from `lib/paths.ts`, so this is a **one-place change**:
   introduce `DATA_ROOT` (an app-data dir, e.g. `~/Greenroom/`) for `config/`, `tests/`, `runs/`,
   `data/`, `demo/`, and keep code/asset lookups separate. Seed `DATA_ROOT` on first run from
   embedded copies of `tests/` + `config/*.example.json`.
3. **First-run bootstrap** — create `DATA_ROOT`, then install Chromium into it with
   `PLAYWRIGHT_BROWSERS_PATH=<DATA_ROOT>/browsers`. Needs a progress indication, since it is a 344MB
   download and a silent 3-minute first launch reads as a hang.
4. **Launchers** — `Greenroom.app` (mac) and `Greenroom.exe` (Windows) that start the server and open
   the browser. The binary already serves on a port; the launcher just needs to open it.
5. **Release** — `scripts/bundle.ts` plus a GitHub Actions workflow building macOS (arm64 + x64) and
   Windows x64 on tag push. Bun cross-compiles with `--target=bun-windows-x64` etc.

## Risks and honest limits

- **Unsigned — decided 2026-08-04: ship it unsigned.** macOS Gatekeeper will say "cannot be opened
  because the developer cannot be verified" and Windows SmartScreen will say "unrecognized app".
  Signing properly costs an Apple Developer ID (99/yr) and a Windows OV cert (200-400/yr), and that
  is not worth it for this. The consequence is a **hard requirement, not a nice-to-have**: the
  download page and README must walk a non-coder through the first-open warning with a screenshot
  per platform (mac: right-click the app, choose Open, then Open again; Windows: More info, then Run
  anyway). Ship that copy at the same time as the first binary. An unexplained OS warning is worse
  than no executable, because it reads as "this software is unsafe" to exactly the audience this is
  built for.
- **Windows is unverifiable from a macOS dev machine.** Bun can cross-compile the binary, but nobody
  here can run it. The Windows half needs a real Windows check before release, and CI can build it
  but not meaningfully smoke-test the double-click flow.
- **Recording is local-only and opens a real browser window.** That still works in a binary, but it
  depends on the fetched Chromium being present, so it must fail with a clear message pre-bootstrap.
- **Demo mode reads `demo/`**, which would have to be embedded and seeded like `tests/`.
