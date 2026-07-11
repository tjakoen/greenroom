---
id: p3-tests-page
status: todo
track: migration
depends: [p2-grain-shell]
touches: [pages/tests, components/]
owner: ai
---

# P3 — Tests page

Rebuild the Tests library (filters, tags/meta, rename/delete, dynamic-input rewriting, record
launcher) as a GRAIN page.

## Tasks

- [ ] Tests library page (filters, smart filters, group/priority/owner/notes)
- [ ] tag rewrite + meta-key migration UI
- [ ] rename/delete + sidecar migration UI
- [ ] "Make inputs dynamic" panel
- [ ] record launcher (env/role picker → pre-auth → codegen)
- [ ] verify end-to-end against the P0 baseline: tag/group/rename/record/dynamic-input
