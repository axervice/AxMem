# links-and-hooks.md — Hook opaque/oversize/newline, bare [[x]] golden fixture

**2026-01-01 — Hook line contains a [[link]] which must be opaque (link extracted, no edge)** [fx:hook-with-link]
Hook: see also [[fx:hook-target]] for background — this is prose inside Hook, not a graph edge.
This entry's Hook must NOT create a supersedes/cause/follows edge to fx:hook-target; the tag must
still land in this entry's `links` array (A12 opaque-but-addressable).

**2026-01-02 — Hook target (exists so the link above is not dangling)** [fx:hook-target]
plain body.

**2026-01-03 — Hook line is exactly 321 UTF-8 bytes (one over the limit, must be B14)** [fx:hook-oversize]
Hook: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaz
body after the oversize Hook line.

**2026-01-04 — bare [[x]] with no namespace is B15** [fx:bare-link-owner]
prose line with a bad link: [[nope-no-namespace]] must be flagged B15.
And a legitimate link right after for contrast: [[fx:hook-target]].
