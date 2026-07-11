---
id: p0-spikes
status: done
track: migration
depends: []
touches: [interface/server.js, package.json]
owner: ai
---

# P0 — spikes, no product change

Baseline drive of the old app under bun; validate the risky assumptions (in-process chromium,
detached-spawn group-kill, codegen spawn) before committing to the BREAD rewrite.

## Tasks

- [x] (a) `bun interface/server.js` runs the whole app as-is — PASS, zero warnings
- [x] (b1) in-process `chromium.launch()` works under bun (preAuth/pdf, no node fallback needed)
- [x] (b2) detached spawn + `kill(-pid)` group kill reaps parent+grandchild (`npx playwright` v1.61.1)
- [x] (c) codegen spawns its browser tree under bun; group-kill reaps it clean
- [x] flip `start`+`demo` to `bun interface/server.js`; `bun run start` verified
