---
id: p2-grain-shell
status: todo
track: migration
depends: [p1-composition-root]
touches: [pages/, components/, server.ts]
owner: ai
---

# P2 — GRAIN shell + Guide + Settings

Build the app-shell (sidebar/theme/⌘K/catalog) in GRAIN; serve the user guide through MILL;
rebuild the Settings forms (envs/login form/roles/groups) as server-rendered pages under
`pages/`.

## Tasks

- [ ] app-shell + side-rail/nav-item wired at the composition root
- [ ] Guide page served via MILL collection over USER-GUIDE.md
- [ ] Settings forms (envs, login form, roles & logins, groups) rebuilt in GRAIN
- [ ] verify: curl /settings /guide /catalog /components.css
- [ ] verify: env/role/group edits byte-match old file formats
- [ ] verify: dark mode correct; demo mode still blocks writes
