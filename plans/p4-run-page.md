---
id: p4-run-page
status: done
track: migration
depends: [p3-tests-page]
touches: [pages/run, components/]
owner: ai
---

# P4 — Run page

Rebuild the flagship Run page: env/scope/role/light picker, Run/Stop, live console over the
run SSE stream, checklist (pending→settled rows), stat tiles, health bar, multi-env matrix.

## Tasks

- [ ] env multi-select + scope + role + light controls
- [ ] Run/Stop wired to the run stream
- [ ] live checklist (pending→settled) + stat tiles + health bar
- [ ] multi-env test × environment matrix
- [ ] verify: single- and multi-env live runs; Stop kills workers; checklist reconciles from /api/results
