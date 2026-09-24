# multi-terminal-fork.md — B2' fork-allowed-but-multi-terminal-not golden fixture

**2026-01-01 — root of the takeover chain** [fx:fork-root]
body.

**2026-01-02 — first entry that supersedes root (fork branch A)** [fx:fork-branch-a]
Supersedes: [[fx:fork-root]]
a fork is allowed by itself — this alone does not violate B2'.

**2026-01-03 — second, DIFFERENT entry that also supersedes root (fork branch B)** [fx:fork-branch-b]
Supersedes: [[fx:fork-root]]
now fx:fork-root has two direct supersessors that never converge — two distinct terminal heads
(fx:fork-branch-a and fx:fork-branch-b) are both reachable from fx:fork-root — B2' multi-terminal
must fire (head-set size 2 > 1).
