# supersedes-cause-follows.md — Supersedes/Cause/Follows grammar + graph-invariant golden fixture

**2026-01-01 — supersedes target (will be superseded)** [fx:scf-old]
body of the entry that gets superseded.

**2026-01-02 — proper double-bracket Supersedes, single target** [fx:scf-new]
Supersedes: [[fx:scf-old]]
this is the standard, legal form.

**2026-01-03 — single-bracket Supersedes must be B23 (malformed, not a real edge)** [fx:scf-singlebracket]
Supersedes: [fx:scf-old]
single brackets are not TARGET — B23 fires, and no supersedes edge is created from this line.

**2026-01-04 — Supersedes with trailing prose ("clarifies") must be B23, not an edge** [fx:scf-prose]
Supersedes: 澄清 [[fx:scf-old]]
trailing/leading prose around the bracket breaks the strict SUPERS grammar — B23, no edge (this is
the real-corpus "⑧ prose-link-not-edge" shape, owner-decided to stay prose, never a formal edge).

**2026-01-05 — Cause with two targets via middle-dot separator** [fx:scf-cause-dot]
Cause: [[fx:scf-old]] · [[fx:scf-new]]
two causes joined by "·".

**2026-01-06 — Cause pointing at an archive locator** [fx:scf-cause-locator]
Cause: [[archive-sha256:0000000000000000000000000000000000000000000000000000000000000001]]
this locator does not exist in this fixture's (nonexistent) archive — used by the dangling-locator
test case below; a second entry in this same file supplies a real matching locator scenario is out
of scope for a single-file core.parseFile() test (locator existence is a whole-corpus --check concern
covered by the corpus-archive-locator/ directory fixture).

**2026-01-07 — Cause self-edge (must be B10)** [fx:scf-cause-self]
Cause: [[fx:scf-cause-self]]
citing itself as its own cause — B10 self-edge.

**2026-01-08 — Cause duplicate edge on one line (must be B10)** [fx:scf-cause-dup]
Cause: [[fx:scf-old]] , [[fx:scf-old]]
same target listed twice (comma separator this time) — B10 duplicate edge.

**2026-01-09 — Follows with two targets (comma separator)** [fx:scf-follows-two]
Follows: [[fx:scf-old]] , [[fx:scf-new]]
Follows is 0..n, non-causal ("先后" not "因果") — both targets recorded, no cycle check applies here.

**2026-01-10 — Cause cycle member A (must be B10)** [fx:scf-cycle-a]
Cause: [[fx:scf-cycle-b]]
A is caused by B.

**2026-01-11 — Cause cycle member B (must be B10, closes the cycle with A)** [fx:scf-cycle-b]
Cause: [[fx:scf-cycle-a]]
B is caused by A — A→B→A is a 2-cycle in the Cause graph.

**2026-01-12 — dangling Cause target (must be B1)** [fx:scf-cause-dangling]
Cause: [[fx:scf-never-defined-anywhere]]
this target does not exist anywhere in the fixture — B1 dangling target.
