# diamond-dag.md — B2' diamond-DAG-is-not-a-cycle golden fixture (coordinator-confirmed defect,
# 2026-09-15: resolveHeads() used one flat "seen" set for both visited-dedup and cycle detection, so
# a node reached twice via two DIFFERENT paths — not a real back-edge — was misjudged as a cycle.
# Case: A -> B -> D, A -> C -> D, plus a transitive shortcut A -> D directly. D is reached three times
# by three different paths; this is a diamond (single converging terminal), never a cycle.

**2026-01-01 — diamond root, superseded by three different later entries** [fx:dd-a]
this is the diamond's root/start; it supersedes nothing itself.

**2026-01-02 — diamond branch B, supersedes the root** [fx:dd-b]
Supersedes: [[fx:dd-a]]

**2026-01-03 — diamond branch C, supersedes the root** [fx:dd-c]
Supersedes: [[fx:dd-a]]

**2026-01-04 — diamond convergence point D, supersedes BOTH branch B and branch C, plus the root directly (transitive shortcut)** [fx:dd-d]
Supersedes: [[fx:dd-b]] · [[fx:dd-c]] · [[fx:dd-a]]
This node is reached from fx:dd-a via three distinct paths (a->b->d, a->c->d, a->d directly) — none
of these are a back-edge to an ANCESTOR still on the current path, so this must NOT be flagged as a
cycle; fx:dd-d is the single, unique terminal head for the whole diamond.
