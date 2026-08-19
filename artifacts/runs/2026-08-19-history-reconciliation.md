---
title: Two unrelated histories were one history all along, and the public README got the badge it earned
date: 2026-08-19
status: complete
lane: human
branch: main
scope:
  - the greenroom repository's git history
  - CLAUDE.md
  - README.md
  - docs/
touched:
  - CLAUDE.md
  - README.md
  - docs/ALIGNMENT.md
  - docs/OPERATING-NOTES.md
skills:
  - voice
  - loop-standard
plans: none opened. The reconciliation was authorized directly, overriding a standing note that said
  the two lineages must never be merged.
gates:
  - bun run check | tsc --noEmit -p tsconfig.next.json, no output, exit 0
  - bun test lib | 68 pass, 0 fail, 225 expect() calls, 9 files
  - git merge-base main origin/main | 1203bfc, so origin/main is an ancestor of the result
  - git log --oneline main..origin/main | empty, so nothing upstream was dropped
  - git rev-parse --abbrev-ref '@{u}' | origin/main, tracking configured
diffstat: 4 files changed, 180 insertions(+), 163 deletions(-), measured across 494168b..1203bfc
unpushed: 0 | the three replayed commits are on origin/main, pushed as 494168b..1203bfc
verifiedBy: the 2026-08-19 consolidation session, which did not do the reconciliation. It re-ran the
  gate at 1203bfc and re-measured all three verification commands and the trailer counts by an
  independent route, and its numbers are the ones in this file.
doctor: not run here. Greenroom carries no pantry.config.json entry for a runs directory, because
  the default is the one this file sits in.
---

# Two unrelated histories were one history all along

> This report was deposited by a later session on 2026-08-19. Greenroom had no run-report
> convention when the work happened, so the reconciliation closed in a chat log instead. The
> account below is the original session's, and every number in it was re-measured before it was
> written down here.

The repository's local `main` and its `origin/main` shared no merge base. Local carried 74 commits
ending 2026-08-19, origin carried 84 ending 2026-08-06, and each side held real work the other
lacked. The obvious reading was two projects that had drifted, and the obvious fix was a merge.
Both readings were wrong.

## Why the histories diverged

Not two projects. A history rewrite this checkout was never re-pointed at.

The root commits on both sides have byte-identical trees, `3290d68bbc0e7b866882c075e5b78fa7b1c649cc`
on each, with the same date and the same message and different hashes. So does the second commit.
Same work, every hash changed.

The rewrite stripped AI attribution trailers, and the repository's own commit `a2ba658` documents
it. Measured across the three lineages:

| lineage | commits carrying a trailer |
|---|---|
| the old local head, tagged `pre-reconcile-local` | 23 |
| `origin/main` | 0 |
| `main` after the reconciliation | 0 |

There is one grep hit on origin that is not a trailer. It is the commit documenting the no-trailer
rule, quoting the phrase in its own prose. Counting trailers means anchoring the pattern to the
start of a line, or the rule's own documentation reads as a violation of it.

## The shape chosen, and the one that would have done damage

Origin is canonical. Reset `main` to `origin/main`, replay the genuinely new local commits on top as
fresh trailer-free commits, then set the upstream tracking that had been missing all along.

Three commits were genuinely new, all documentation:

```
103170e docs: split CLAUDE.md so the front door is a one-minute read
efd051a docs: the README claims the CI badge it had earned
a4943ca docs: three links resolve from the file that carries them
```

**Rejected: `git merge --allow-unrelated-histories`.** Of the 74 local commits, 61 were already
upstream by patch id. A merge would have resurrected 23 trailer-carrying duplicates of work that is
already public, which is precisely what the upstream rewrite removed. That is worse than the state
it would have replaced. The arithmetic reconciles: `git cherry` skips merge commits, so 74 is 64
non-merge plus 10 merges, and 64 is 61 already upstream plus the 3 above.

**Rejected: graft or `git replace`.** Both rewrite published history, and strangers have cloned
`origin/main`.

## The trap worth writing down

After the replay, `git cherry -v main pre-reconcile-local` still lists `103170e` as absent by patch
id. That looks like a lost commit and is not one. It was replayed as `71006ae`, and the patch id
differs because the replay resolved conflicts against a lineage that had moved `CLAUDE.md` three
times. Confirmed by content rather than by hash: `CLAUDE.md` is 10,598 characters where it had been
36,255, and both `docs/ALIGNMENT.md` and `docs/OPERATING-NOTES.md` exist.

A patch id compares a patch, so any conflict resolution during a replay changes it. After a
conflicted replay, verify by content.

## Gate output

```
$ git rev-parse HEAD
1203bfcddeae52bc4bfcf7465335c9af5052ea03

$ bun run check
$ tsc --noEmit -p tsconfig.next.json
exit=0

$ bun test lib
bun test v1.3.14 (0d9b296a)

 68 pass
 0 fail
 225 expect() calls
Ran 68 tests across 9 files. [5.52s]

$ git merge-base main origin/main
1203bfcddeae52bc4bfcf7465335c9af5052ea03

$ git rev-parse --abbrev-ref '@{u}'
origin/main

$ git log --oneline main..origin/main
(empty above means nothing upstream was dropped)

$ git log --oneline origin/main..main
(empty above means nothing local is unpushed)

$ git tag -l 'pre-reconcile*'; git branch --list 'pre-reconcile*'
pre-reconcile-local
pre-reconcile-origin
  pre-reconcile-local-branch

$ git diff --shortstat 494168b 1203bfc
4 files changed, 180 insertions(+), 163 deletions(-)

$ git show origin/main:README.md | grep -c 'workflows/ci'
1
```

The gate and all six verifications above were re-run at `1203bfc` by the session depositing this
report, so the block is a paste rather than a reconstruction.

## What was not done

The backup refs are still in place: tags `pre-reconcile-local` at `a4943ca` and `pre-reconcile-origin`
at `494168b`, plus the branch `pre-reconcile-local-branch`. They cost nothing and they are the thing
that made every step of this reversible, so deleting them is a separate decision rather than
cleanup.

The no-AI-trailer note in the repository's own documentation says 28 commits carried the trailer
before it was caught. The measurement here found 23 on the lineage that still exists. Origin's
figure was left verbatim rather than corrected, because the difference is most likely commits the
rewrite dropped entirely, and nobody has checked that.

## What needs human eyes

Nothing blocking. The reconciliation is pushed, the public README carries the CI badge it had been
missing since 2026-08-18, and the badge was verified against `git show origin/main:README.md` rather
than against the working tree, which is the mistake the 2026-08-18 audit made.

The one open question is whether the backup refs stay. They will keep resolving until somebody
decides otherwise.
