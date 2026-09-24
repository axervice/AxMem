# decisions.md (migrate-index-bullets fixture) — legacy hand-written Index bullet shapes for the
# migrator's ⑤/⑦/⑧/⑨/⑩ action detection (parseLegacyIndexBullets in pmm-migrate-v3.cjs)

## Index
- 2026-01-01 [fx:mib-old] old decision, already formally superseded (superseded→[fx:mib-new])
  - continuation line, two-space indented, must not be mis-parsed as its own bullet/tag
- 2026-01-02 [fx:mib-new] new decision that supersedes fx:mib-old
- 2026-01-03 [fx:mib-clarify-target] entry later clarified by a non-standard marker (superseded→澄清[fx:mib-clarifier])
- 2026-01-04 [fx:mib-clarifier] clarifies fx:mib-clarify-target
- 2026-01-05 [fx:mib-hookmove] this REST text differs from the entry's actual title and must become a Hook: line via action ⑤
- 2026-01-06(晚) [fx:mib-late] a dateRaw suffix carried only on the Index bullet, not on the title line itself (action ⑨)
- 2026-01-07 [fx:mib-oversized] aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaz
- 2026-01-08 [fx:mib-markeronly-target] target of the marker-only bullet, no Supersedes field of its own yet
- 2026-01-09 [fx:mib-markeronly-source] marker-only source (superseded→[fx:mib-markeronly-target])

## Entries

**2026-01-01 — old decision** [fx:mib-old]
body.

**2026-01-02 — new decision that supersedes the old one** [fx:mib-new]
Supersedes: [[fx:mib-old]]
formal edge already exists — this one is NOT marker-only.

**2026-01-03 — entry later clarified** [fx:mib-clarify-target]
body, never formally superseded.

**2026-01-04 — clarifies the entry above, non-standard marker, prose only** [fx:mib-clarifier]
参见: [[fx:mib-clarify-target]]
this is prose, per owner decision this never becomes a formal Supersedes edge.

**2026-01-05 — this is the real title (different from the Index REST above)** [fx:mib-hookmove]
body, no Hook: field yet — action ⑤ should propose moving the Index REST text here.

**2026-01-06 — late-dated decision** [fx:mib-late]
body — the title line's own dateRaw is empty; only the Index bullet above carries "(晚)".

**2026-01-07 — oversized Index row target** [fx:mib-oversized]
body — the Index bullet for this tag is >320B, action ⑤ must NOT auto-copy it into Hook (would just
relocate the B14 violation); it belongs in the ⑩ manual-distillation list instead.

**2026-01-08 — target of the marker-only bullet, no Supersedes field of its own yet** [fx:mib-markeronly-target]
body — used by the marker-only case below.

**2026-01-09 — marker-only source: Index says superseded, but the target has no formal Supersedes yet** [fx:mib-markeronly-source]
body — action ⑦ should propose adding `Supersedes: [[fx:mib-markeronly-source]]` to
fx:mib-markeronly-target.
