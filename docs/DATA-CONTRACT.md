# AxMem data contract — schema version 1

Everything AxMem governs is plain markdown + TSV in `AXMEM_MEMORY_DIR`,
git-versioned, human-readable, greppable. No database, no binary state.

## Files

| File | Role | Injection guidance |
|---|---|---|
| `decisions.md` / `lessons.md` | ratified decisions / lessons, append-only | index lines only; bodies on demand |
| `standinginstructions.md` | always-on rules; `### Kernel` full-text zone | Kernel full text; rest as index |
| `*-archive.md` | retired entries, verbatim (retirement = move) | never injected; searchable |
| `progress.md` | `## Active` dashboard (size-capped) + `## Ledger` history | Active only |
| `receipts/spool-<session>.tsv` | write-ahead memory receipts | session lamp counts them |
| `receipts/covered-<machine>.tsv` | coverage watermark (per machine) | — |
| `receipts/blobs/<id>.txt` | oversize receipt payloads, verbatim | — |
| `telemetry/trigger-log-<machine>.tsv` | staged recall telemetry | — |
| `classes.md` | lesson-class taxonomy hubs, append-only | hub titles only; bodies on demand |
| `FINGERPRINTS.tsv` (at `AXMEM_FP_HOME`, default the AxMem code root — not `AXMEM_MEMORY_DIR`) | sha256 roster of guard code (`core/*.sh`, `core/*.cjs`, `lib/*.sh`, `lib/*.cjs`, `bin/axmem`) | never injected; `axmem fingerprint check` reads it, `refresh "<reason>"` is the only legal way to rewrite it |

## Entry form (the only legal shape)

```
**YYYY-MM-DD — title with greppable anchor words** [namespace:tag] [user:name|agent:name] [sole-record]? [redundancy-ok]?
<!-- attribution: who/why, optional -->
<!-- trigger: tool=Edit|Write; repo=<repo-id>; path=<repo-relative-posix or prefix*> -->   (optional)
Class: [[class:<id>]]   (lessons.md only; see Classes below)
body ≤ entry_limit bytes (default 900 ≈ one retrieval window) — body + WHY + →pointer
[trust:user-ratified|observed|derived]  (optional; REQUIRED for Kernel promotion)
Ratified by: user:<name> (YYYY-MM-DD)
```

Rules the gates enforce mechanically:
- header starts the line with `**` (any prefix, including a single leading
  space, blinds four subsystems at once — counting, parity, retirement
  tracking, title-anchored retrieval)
- every entry has exactly one Index row (`- YYYY-MM-DD [ns:tag] title`); the
  Index tag SET and the live-entry identity-tag SET must be equal, not just
  equal in count (manifest.cjs `--check` B4 — a phantom Index row can balance
  a missing one under row-count parity alone)
- `<!-- trigger: ... -->` has exactly ONE legal shape: `tool=Edit|Write;
  repo=<repo-id>; path=<repo-relative-posix or prefix*>`, one trigger per
  line. Any other `<!-- trigger:` text (a `path=...`-only shorthand, missing
  `tool=`/`repo=`, wrong separators, …) is not a lenient variant — the push
  channel's regex simply never matches it, so the trigger is silently dead
  with no report anywhere else. `manifest.cjs --check` B5 catches this for
  every non-archived entry (an archived entry's dead trigger is harmless)
- body size counts to the NEXT header; archive-note lines (`*(...)*`,
  `*Archived`, `*RAG`) are skipped line-wise, capped at 3 free lines per
  entry; `[sole-record]` exempts a body whose detail has no other home —
  compression may never buy tidiness with fidelity
- `[sole-record]` also raises the bar on repetition: `axmem redundancy` R1
  (intra-entry repeated phrase) and R4 (low gzip ratio) block only
  `[sole-record]` entries — the length exemption's price is proving the
  wording is already minimal. R2 (corpus copy — reuse a `[[tag]]` reference
  instead) and R3 (filler words) block every entry regardless. `[redundancy-ok]`
  in the header downgrades any redundancy hit to informational (escape hatch,
  audited monthly — same treatment as `[sole-record]`)
- supersession: new entry declares `Supersedes: [[old:tag]]`; the old entry is
  archived or marked in the same change; its Index row gains `(superseded→...)`
- wiki-refs are `[[ns:tag]]`; a naked `[[word]]` alongside namespaced
  definitions poisons dangling-scan precision and is blocked
- deletion of a header requires the verbatim entry in the matching archive in
  the same commit (precommit gate F), verified by identity (the tag must
  HEAD its own live entry — a mere mention in another title's prose does not
  count), and re-verified over the full staged snapshot at commit time so
  writes that bypass Edit/Write hooks (a raw `sed`/`echo >>`) are still caught
- a live `lessons.md`/`decisions.md`/`standinginstructions.md` entry carries
  at most one `Class: [[class:<id>]]` line, the id defined as a hub in
  `classes.md`; see Classes below (`manifest.cjs --check` B6)

## Classes

`classes.md` holds the lesson-class taxonomy: a controlled vocabulary of
"what KIND of mistake was this" (never which project or how severe). A class
hub is an ordinary entry in that file — header (the date matters: every
parser here only recognises a `**20...**` header), one criterion sentence,
and optionally the trigger(s) the class shares. The push channel matches a
hub against an edit exactly like any other entry: hitting a hub's trigger
pushes the hub plus its newest live members (telemetry stage
`injected-class-member`); hitting a member's own trigger reports "same class
N more" on that member's own line instead of spending an extra recall slot.

Rules (`manifest.cjs --check` B6, all mechanical):
- a live lesson has at most one `Class:` line, in the strict form
  `Class: [[class:<id>]]` — anything else (extra text, missing brackets,
  wrong prefix) blocks, same treatment as a malformed trigger comment (B5)
- the class id must be defined as a hub in `classes.md` — it is a controlled
  vocabulary, not a free-form tag; no fitting class means add one in the
  same change (title + one criterion sentence)
- from `AXMEM_CLASS_REQUIRED_FROM` on (default `2026-09-15`; **a fresh
  install should set this env var to its own install date** rather than
  inherit the default verbatim) a `lessons.md` entry with no `Class:` line
  is BLOCKED at write time; an older unclassified entry is only reported
  (`manifest --json` → `counts.unclassifiedLessons`), never blocked
- `axmem fingerprint` and `axmem canary` both cover this: the canary asserts
  `counts.unclassifiedLessons === 0 && counts.classes >= 1` straight from
  `manifest --json`'s counts, never by counting lines (two `Class:` lines on
  one entry and none on another would balance a line count into a false
  green)
- the `Class:` line is metadata, not content — the write-gate byte count
  skips it (bounded to the exact same strict form B6 enforces, so the skip
  can't be smuggled into a free-text lane) and it never counts as an
  outgoing `[[link]]`

Listing a class's members: `grep -B3 'Class: \[\[class:<id>\]\]'
AXMEM_MEMORY_DIR/lessons.md` (no dedicated `axmem grep` subcommand ships
yet; `retrieval/pmm-grep.sh` is a legacy reference pending its own port).

Migrating an existing memory dir onto the taxonomy in one pass: `axmem
classify --map <tsv>` inserts `Class: [[class:<id>]]` lines from a
`tag<TAB>class` TSV. It is idempotent (an already-classified entry is left
alone) and all-or-nothing (any row naming an unknown tag or an undefined
class aborts with nothing written, `--dry` previews without writing).

## Receipts TSV

`id \t iso-time \t session \t kind \t ref \t note`
- `note` is verbatim (control chars flattened); >800B spills to
  `blobs/<id>.txt` with a visible `...[truncated->...]` marker
- covering requires a memory commit newer than the oldest pending receipt
  (`cover --dismiss` is the honest lane for disposable receipts)

## Telemetry TSV (trigger recall)

`iso-time \t session \t stage \t tool \t repo \t rel \t tag \t note`
Stages: `event` (opportunity, with matched=N) · `injected` ·
`injected-linked` (one-hop `[[link]]` carriage) · `injected-class-member`
(class-hub member carriage) · `superseded-redirect` · `suppressed-seen` ·
`suppressed-cap` · `wt-normalized` · `error`.
`opened`/`followed` are DERIVED offline (join with retrieval logs) — runtime
never fabricates them, and no stage may be collapsed into a vague "hit".

## Versioning

`config.json` carries `$schema_version` (this document = 1). Any breaking
change to the shapes above bumps it and ships a dry-run migration.
