---
id: p6-cutover
status: done
track: migration
depends: [p5-history-bug-report]
touches: [interface/, server.ts, README.md, USER-GUIDE.md, CLAUDE.md, AUDIT.md]
owner: ai
---

# P6 — cutover

`/` becomes the new Run page; delete the old interface/ SPA + server.js; run the full §5
must-not-regress checklist from PLAN.md; sync docs.

## Tasks

- [x] `/` serves the new Run page (folded into the same `grainPage("Run", runBody(), …)` route as
      `/run`; a normal gated route — unauthenticated `/` 302s to `/login` like any other page)
- [x] delete interface/ SPA + server.js (legacy entry removed, `start:legacy` script removed)
- [x] demo parity drive (`npm run demo`: `/` and `/run` both 200, no auth required, unchanged)
- [x] README / CLAUDE.md sync table / AUDIT.md updated (USER-GUIDE.md had no interface/ references)
- [x] boot + auth flow verified (unauth `/` → 302 /login; sign-up; authed `/`, `/run`, `/tests`,
      `/editor` → 200; `/app.js`, `/styles.css`, `/index.html` → 404; SSE `/api/stream` streams a
      real @example run start to finish); `npm run check` and `npm run check:legacy` both green
- [x] fresh-clone sim skipped (nested private git deps mean a from-scratch `bun install` doesn't
      resolve in this environment — pre-existing, unrelated to this cutover); verified instead
      against the existing checkout's `node_modules`, which is how this repo is documented to run
