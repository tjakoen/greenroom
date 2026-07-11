---
id: p6-cutover
status: todo
track: migration
depends: [p5-history-bug-report]
touches: [interface/, server.ts, README.md, USER-GUIDE.md, CLAUDE.md, AUDIT.md]
owner: ai
---

# P6 — cutover

`/` becomes the new Run page; delete the old interface/ SPA + server.js; run the full §5
must-not-regress checklist from PLAN.md; sync docs.

## Tasks

- [ ] `/` serves the new Run page
- [ ] delete interface/ SPA + server.js (legacy entry removed)
- [ ] demo parity drive (npm run demo matches old behavior)
- [ ] README / USER-GUIDE / CLAUDE.md sync table / AUDIT.md updated
- [ ] full §5 must-not-regress checklist (PLAN.md) run and green
- [ ] fresh-clone sim: `rm -rf node_modules && bun run bootstrap && bun start` + `bun run demo`
