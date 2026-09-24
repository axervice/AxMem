# decisions-archive.md (corpus-whole fixture) — §1.5: verbatim, no Index, identity = archive-sha256 locator

**2026-01-01 — retired decision, still carries its old tag (tag is optional in archives)** [fx:dec-archived-with-tag]
retired body text, kept verbatim.

**2026-01-02 — archive entry WITHOUT any tag at all (legal — identity is the block locator)**
this entry has no `[ns:tag]` anywhere in its tail — per §1.5 archives may lack a tag entirely; its
identity for Cause/Follows purposes is `archive-sha256:<blockHash64>`, not a human tag.
