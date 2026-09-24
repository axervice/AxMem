# decisions.md (migrate-selftest fixture memory dir)

## Index
- 2026-01-01 [ms:identityless-gist-match] an identity-less title that D1-NAMING assigns a new tag to
- 2026-01-02 [ms:dup-tag] first occurrence of a same-file duplicate tag, kept as-is
- 2026-01-03 [ms:dup-tag] second occurrence of a same-file duplicate tag, renamed by D1
- 2026-01-04 [ms:cross-tag] cross-tag decision, brief hook text differs from title (R-1 same-offset ④+⑤ fixture material)
- 2026-01-05 [ms:hookmove] REST text differs from title, should become a Hook line
- 2026-01-06 [ms:supersede-old] a decision later superseded
- 2026-01-07 [ms:supersede-new] supersedes ms:supersede-old, a real formal edge

## Entries

**2026-01-01 — plain identity-less title with no ns:tag bracket at all**
this entry has no `[ns:tag]` anywhere — id=null; D1-NAMING.md maps its title text to a new tag.

**2026-01-02 — first occurrence of a same-file duplicate tag, kept as-is** [ms:dup-tag]
D1-NAMING designates this one (by title-gist match) as the one that keeps ms:dup-tag.

**2026-01-03 — second occurrence of a same-file duplicate tag, renamed by D1** [ms:dup-tag]
D1-NAMING designates this one (by title-gist match) as the one renamed away from ms:dup-tag.

**2026-01-04 — decisions-side record of a cross-file duplicate tag** [ms:cross-tag]
this tag also lives in standinginstructions.md — the decisions copy gets renamed `-decided` + a
mutual link line is inserted.

**2026-01-05 — the real title, different from the Index REST text above** [ms:hookmove]
body — no Hook: field yet. References [[ms:supersede-old]] as a prose link (A12 fixture material).

**2026-01-06 — a decision later superseded** [ms:supersede-old]
body, untouched by any migration action — pure A5/A15 material.

**2026-01-07 — supersedes ms:supersede-old, a real formal edge** [ms:supersede-new]
Supersedes: [[ms:supersede-old]]
this edge must survive byte-identical in staged (A5) and this block's hash must be unaffected by
any plan action (A15 — nothing in D1-NAMING touches it).
