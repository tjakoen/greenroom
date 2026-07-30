---
id: p5-history-bug-report
status: done
track: migration
depends: [p4-run-page]
touches: [pages/history, pages/bug, components/]
owner: ai
---

# P5 — History + Report-a-bug

Rebuild the run history list and the report-a-bug flow: screenshot scrubber, moment logs, PDF
export, video clip, bundle download, video seeking.

## Tasks

- [ ] runs list / history page
- [ ] scrubber + moment logs
- [ ] PDF export scoped to the same from/to window as the preview
- [ ] video clip (graceful hide without ffmpeg) + video seeking
- [ ] bug bundle download
- [ ] verify: PDF window == preview window; bundle zip diffed vs the P0 bundle
