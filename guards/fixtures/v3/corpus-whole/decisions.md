# decisions.md (corpus-whole fixture)

## Index
- 2026-01-01 [fx:cross-tag] shared cross-file tag, decisions version

## Entries

**2026-01-01 — shared cross-file tag, decisions version** [fx:cross-tag]
this tag ALSO exists in standinginstructions.md below — B7 cross-file duplicate.

**2026-01-02 — Class target that does not exist in classes.md (must be B6)** [fx:dec-badclass]
Class: [[class:never-defined]]
decisions.md entries may carry Class too; target must resolve.

**2026-01-04 — Cause pointing at an archive locator that does NOT exist (must be B1)** [fx:dec-cause-archive-bad]
Cause: [[archive-sha256:1111111111111111111111111111111111111111111111111111111111111111]]
64 hex chars but no archive block anywhere hashes to this — dangling locator.
(NOTE: the positive case — Cause resolving to a REAL archive block's sha256 — is covered as a dynamic
unit test in pmm-core-selftest.cjs, not here: a hand-typed hex hash in a static fixture would silently
go stale the moment anyone reflows this file's whitespace, since blockHash64 is byte-exact.)
