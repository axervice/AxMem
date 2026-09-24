# lessons.md (corpus-whole fixture)

跨项目通用。项目专属教训路由表(B13 routing-namespace pointer table):
- Axervice(`[axervice:*]`)→ project LESSONS.md

## Index
- 2026-01-01 [fx:les-ok] properly classed lesson

## Entries

**2026-01-01 — properly classed lesson (Class target exists, no B6)** [fx:les-ok]
Class: [[class:fixture-class]]
What happened: nothing wrong.

**2026-01-02 — routed-namespace identity must be B13** [axervice:should-be-in-project-repo]
Class: [[class:fixture-class]]
ns=axervice is in this file's own routing pointer table — B13 fires (belongs in project LESSONS.md).

**2026-09-15 — new lesson missing Class (must be B6, dated at/after the cutoff)** [fx:les-missing-class]
What happened: this entry has no Class: line and is dated >= 2026-09-15 — B6 blocking.
