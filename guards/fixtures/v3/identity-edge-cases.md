# identity-edge-cases.md — B8b/B8c/identity-less/sole-record-only golden fixture

**2026-01-01 — class identity itself is a valid identity** [class:widget-alpha]
判据: this entry's identity ns is literally "class" — it is a legal identity per FINAL §8
("class 是否身份 — 是;14 枢纽以 class 为唯一身份").

**2026-01-02 — attribution-only title (system ns masquerades as identity)** [system:hydrate]
<!-- attribution: [system:hydrate] -->
This title's only bracket is `[system:hydrate]`. Per the position rule (first `[TAG]` in tail is the
identity), this resolves to ns=system which is in ATTR — B8b fires and this entry has NO valid id.

**2026-01-03 — bare [user] with no colon carries no identity** [user]
<!-- attribution: Jax -->
`[user]` has no colon so it does not even match the TAG shape — this entry has zero brackets that
match TAG, so it is squarely in the "24 identity-less" bucket (id=null, no B8b diagnostic since the
bracket never matched TAG at all).

**2026-01-04 — sole-record-only title, no real tag anywhere** [sole-record]
<!-- attribution: Jax -->
`[sole-record]` is a flag, not a TAG (no colon) — this entry is also identity-less; soleRecord=true.

**2026-01-05 — uppercase existing tag is grandfathered (B8c report, not block)** [Axervice:Legacy-Tag]
This tag has uppercase letters. Per FINAL §1.1 "存量 3 个大写 tag 不改名" — recognized as a valid
identity (case preserved) but flagged B8c (report-level in a single-snapshot --check).

  **2026-01-06 — leading-space title never becomes an entry** [fx:leading-space-ghost]
This line is indented by two spaces before `**` — B8 must fire and this must NOT start a new block;
its content is swallowed into entry [Axervice:Legacy-Tag]'s body above.

> **2026-01-07 — blockquote-prefixed title never becomes an entry** [fx:blockquote-ghost]
Same as above with a `>` prefix — B8 must fire; also swallowed into the prior entry's body.
