# Run reports

One file per run, named `YYYY-MM-DD-<slug>.md`. A run closes here rather than in a chat log, so the
next session can read what the last one did without anybody remembering to tell it.

This is the same convention the portfolio uses, and PANTRY reads it with no configuration: the
default runs directory is `artifacts/runs/`, so nothing in `pantry.config.json` needs to name it.
Do not use the top-level `runs/` directory for this. That one belongs to the app, holds recorded
demo runs, and is gitignored.

## What a report carries

The frontmatter below is the checklist LOOP section 9 turns into fields. PANTRY's run ledger reads
it and reports which items are missing, so a report that skips one is visibly incomplete rather
than quietly thin.

```
---
title: What the run did, in a sentence
date: 2026-08-19
status: complete            # complete | partial | blocked
lane: gated                 # high | gated | human
branch: main
scope:                      # the envelope the run worked inside
  - lib/
touched:                    # what it actually changed
  - lib/report.ts
skills:
  - loop-standard
gates:                      # "command | result"; the output goes in the body, verbatim
  - bun test lib | 68 pass, 0 fail
diffstat: 4 files changed, 180 insertions(+), 163 deletions(-)
unpushed: 0 | reason, when the count is not zero
verifiedBy: who checked it who did not write it
doctor: flags fixed or carried by name
---

## Gate output
## What was not done
## What needs human eyes
```

Gate output is pasted verbatim and never summarized. When a run's original output was not kept and
a later session reconstructs the block, the fence opens with the literal line `NOT A PASTE` and
says where its numbers came from. A checker that can be satisfied by inventing evidence teaches
sessions to invent evidence.
