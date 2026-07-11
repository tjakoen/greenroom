---
id: pg-ai-door
status: todo
track: migration
depends: [p6-cutover]
touches: [server.ts, ai-dispatch.js]
owner: ai
---

# PG — AI door

After cutover: wire createAccepts → /ai/manifest, createInteractionLayer + a greenroom
reasoner, data-surface attributes on operable surfaces, boot drift guards. Starts with
existing verbs only (demo.run, desk.stop) — greenroom domain verbs are a flagged cross-repo
decision, not part of this phase.

## Tasks

- [ ] /ai/manifest lists operable surfaces
- [ ] demo.run scripted "watch the AI run the examples" demo with spotlight/console narration
- [ ] desk.stop wired
- [ ] door gets its own SSE stream (never the run stream)
- [ ] verify: demo runs AND releases the spotlight on natural completion; no drift warnings at boot
