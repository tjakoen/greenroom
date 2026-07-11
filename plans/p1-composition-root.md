---
id: p1-composition-root
status: done
track: migration
depends: [p0-spikes]
touches: [server.ts, lib/, guard.ts, plans/, context/]
owner: ai
---

# P1 — composition root serving the existing frontend

Port server.js (1975 lines) into server.ts on bun: pinned @tjakoen/* deps, guards, all
/api/* handlers moved to lib/*.ts, PROOF /plans + MILL /guide + /context mounted, binary/Range
helpers, run-stream foundation. Old interface/server.js kept until P6 as the legacy entry.

## Tasks

- [x] server.js split into 15 lib/*.ts modules (envs, creds, roles, groups, tests-lib, records,
      runner, recorder, bundle, zip, pdf, ffmpeg, guard, binary, run-stream)
- [x] server.ts wires guard → PROOF/MILL → old SPA at `/` → all /api/* → binary static → EADDRINUSE probe
- [x] `start`+`demo` flipped to `bun server.ts`; old entry kept as `start:legacy`
- [x] `bun run check` + `check:legacy` green
- [x] `bun test lib` 14/14 green
- [x] `bun pm ls` single-copy check (no duplicate layer copies)
- [x] curl battery (/api/state /api/envs /api/tests /api/runs /plans /guide) all 200 + CSRF 403
- [x] full run (example-search → passed → archived, /report) + PDF + moment + bug-bundle zip verified
- [x] recorder spawn → stop group-kill verified (no orphans/stray spec)
- [x] demo write-guard verified

Note: run SSE ended up as a greenroom-owned Bun `ReadableStream` hub (`lib/run-stream.ts`)
with replay-on-connect, not batch's `createStream` — the pinned batch Stream has no
replay-on-subscribe hook and P1 serves the frozen `app.js`.
