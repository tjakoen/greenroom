---
id: executable
status: todo
track: distribution
depends: []
touches: [lib/paths.ts, server.ts, scripts/, .github/workflows/]
owner: human
---

# EXECUTABLE — ship Greenroom as a double-clickable app (2026-08-04)

> **Status: spiked, not built.** The hard question is answered: `bun build --compile` DOES produce a
> working binary for this codebase. The remaining work is bounded and listed below, with the exact
> failure that stops it today. Decision taken: **portable, unsigned, Chromium fetched on first run.**

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

- **Unsigned.** macOS Gatekeeper says "cannot be opened because the developer cannot be verified";
  Windows SmartScreen says "unrecognized app". The workaround (right-click → Open) is exactly the
  kind of step this project exists to remove, so the README must walk a non-coder through it with a
  screenshot. Signing properly costs an Apple Developer ID (99/yr) and a Windows OV cert (200-400/yr).
  **Decide whether an unsigned download is genuinely better than the VS Code task before shipping it.**
- **Windows is unverifiable from a macOS dev machine.** Bun can cross-compile the binary, but nobody
  here can run it. The Windows half needs a real Windows check before release, and CI can build it
  but not meaningfully smoke-test the double-click flow.
- **Recording is local-only and opens a real browser window.** That still works in a binary, but it
  depends on the fetched Chromium being present, so it must fail with a clear message pre-bootstrap.
- **Demo mode reads `demo/`**, which would have to be embedded and seeded like `tests/`.
