# PMM v3 — core/migrator reference (C0 build, 2026-09-15; C0 repair pass same day after Opus NO-GO)

Authoritative spec: `guards/specs/PMM-V3-FINAL-SPEC.md` (definitive; this doc is a practitioner's
reference, not a second source of truth — where the two disagree, the spec wins). Deliverable list
and naming: `guards/specs/C0-BUILD-SPEC.md`. Naming table for the C1 migration: `guards/specs/D1-NAMING.md`.

**Status: C0 — shadow only.** Nothing in this build is wired into any hook, gate, or settings.json.
`pmm-core.cjs`/`pmm-manifest-v2.cjs` only *read*. `pmm-migrate-v3.cjs --apply` only ever writes inside
an explicit `--dir` copy (it refuses any path that resolves under the real `~/.claude/memory`). No
real memory content changes as a result of this build existing.

## 1. Files in this build

| File | Role |
|---|---|
| `guards/pmm-core.cjs` | Core library — parser, graph, `check()`, `renderIndex()`, `ledger()`, `analyze()`. Everything else `require()`s this; no private grammar regex exists anywhere else. |
| `guards/pmm-manifest-v2.cjs` | Thin CLI shell over core: `--from worktree\|HEAD\|:0`, `--json`, `--check`, `--index`, `--diff <a> <b>`, `--ledger`. |
| `guards/pmm-migrate-v3.cjs` | Migrator: `--plan`, `--apply --dir <copy> --plan <PLAN-<oid>.json>`, `--verify --stage c0\|c1 --before <dir> --after <dir> [--plan <file>]`. **`--apply` now takes `--plan`, not `--names`** — see §5.5. |
| `guards/pmm-verify-assertions.cjs` | Implements assertions A1–A22 for `--verify` (required by pmm-migrate-v3.cjs, not meant to be run standalone). |
| `guards/pmm-manifest-shadow.cjs` / `.sh` | v1-vs-v2 shadow comparator on the real corpus (read-only), incl. archive identity comparison. |
| `guards/pmm-core.sh` | `--self-test` wrapper — runs `pmm-core-selftest.cjs` against `guards/fixtures/v3/*` (now incl. fault-injection and CLI-level `PMM-CORE-ERROR` tests, §7). |
| `guards/pmm-migrate-v3.sh` | `--self-test` wrapper — hermetic plan→apply→verify→idempotency(byte-diff)→17 break-tests, using `guards/fixtures/v3/migrate-selftest/`. Builds a full plan JSON (`buildFullPlan`) and drives `--apply`/`--verify` through the real CLI, exactly like a real run. Also forwards any other args straight to `pmm-migrate-v3.cjs`. |
| `guards/pmm-c0-canary-check.sh` | The `guard-canary.sh` C0 roster line's actual check (Opus H-3): requires a **committed** `PLAN-<oid>.json` matching the current `HEAD:.claude/memory` OID, applies it to a fresh temp copy, runs `--verify --stage c0`, then the shadow comparator. Never calls `--plan` itself. |
| `guards/fixtures/v3/` | Golden corpus: standalone `.md` fixtures (incl. `unclosed-fence.md` for B32), `corpus-whole/` (multi-file whole-corpus checks), `migrate-index-bullets/` (legacy Index-bullet action detection), `migrate-selftest/` (hermetic migrator end-to-end fixture + its own `D1-NAMING.md`). |
| `guards/specs/PLAN-<treeOid>.json` | `--plan`'s output, bound to `git rev-parse HEAD:.claude/memory` at generation time; now a **self-contained apply contract** — carries the concrete byte edits (`edits[]`, each with `oldBytesBase64`/`titleLineSha256`) and `contentFingerprint`/`contentFingerprintAfter` (§5.5), not just action summaries. Regenerate (and re-review) whenever that OID changes — the old plan file must be deleted, never left stale (the canary now hard-fails on a stale/missing plan instead of silently regenerating one). |

## 2. Grammar (§1.2a of the spec, summarized)

A **block** starts at any line matching `TITLE` (`^\*\*(dateISO)(dateRaw)\s+—\s+(title)\*\*(tail)`)
that is outside a fence, and runs to the byte before the next such line, or `^## `, or `^### `, or EOF
(fence-aware — a fenced `## Index` or `**20…**` is invisible to the grammar entirely). Trailing blank
lines are trimmed from the block before hashing; `blockHash64 = sha256(block bytes)`, full 64 hex.

**Identity** = the first `[ns:tag]`-shaped bracket in the title's `tail` (case captured, not forced
lowercase — case is checked separately). If that bracket's `ns` is in `{user,agent,system,trust}`
(the attribution namespaces), the entry has **no valid identity** (`id = null`) even though a bracket
matched — that's B8b, and it's exactly why 24 real live titles currently have no usable tag (their
only bracket is an attribution flag like `[system:hydrate]` or a bare `[user]` with no colon at all).

**Tag case (§1.7).** The namespace part of a tag is lowercase-only (`[a-z][a-z0-9-]*`); the tag part
after the colon allows `[A-Za-z0-9._-]` — 3 grandfathered uppercase tags exist in the real corpus and
must stay addressable. Identity uniqueness (B7) and every `[[…]]` link/edge resolution (Supersedes,
Cause, Follows, `headOf`) compare ASCII-lowercase throughout (`core.idKey()`/`core.ciMap()`) — a link
spelled in a different case than the identity it targets still resolves to the same entry. B8c (new
identity must be lowercase) stays report-level; it flags any uppercase identity, not just new ones,
because a single snapshot can't tell "pre-existing" from "just added" (see §7).

**Archive exemption (§1.5).** Entries in the three `*-archive.md` files are exempt from B7, B8, B8b,
B8c, B13, B14, B16, and B22 — they are verbatim, zero-rewrite historical records (permanent identity
= `archive-sha256:<blockHash64>`, tag optional and may repeat). They are **not** exempt from B1, B2′,
B5, B6, B15, B17, B19, B23, or B32 — a malformed `Supersedes:` line or an unclosed fence in an archive
still gets diagnosed (just never auto-rewritten).

**Unclosed fences (§1.8, B32).** If a file ends with an odd number of fence toggles (`inFence` still
true at EOF), that is a blocking diagnostic pointing at the fence's *opening* line — never a silent
"everything after this line vanished." See `fixtures/v3/unclosed-fence.md`.

Field lines (only meaningful inside an open block): `attribution`, `trigger` (path or cmd form),
`Class`, `Supersedes` (strict `[[tag]]` list only — anything else, including a single bracket or
"clarifying" prose around the bracket, is B23 and creates **no edge**), `Cause`/`Follows` (`[[tag]]`
or `[[archive-sha256:<64hex>]]` targets), `Hook`/`Banner` (≤320 UTF-8 bytes, opaque — any `[[link]]`
inside is added to the entry's `links[]` for addressability but never becomes a graph edge), `Rules`.
Anything else is prose: backtick spans and fenced regions are stripped before link extraction;
`\[\[tag\]\]` becomes a link, `\[\[not-a-tag\]\]` is B15.

## 3. Invariants implemented (`core.check()`)

B1 (dangling Supersedes/Cause/Follows target, incl. archive locators), B2′ (cycles; multi-terminal
fork), B5 (trigger form + `repo=*` exe denylist), B6 (Class form/target/lessons-required), B7 (live
identity uniqueness, case-insensitive, across all 4 live files), B8 (near-title that never became an
entry — leading whitespace/`>` prefix, or missing closing `**` on the same line), B8b (attribution-ns
bracket masquerading as identity), B8c (uppercase identity — **report-level** in single-snapshot
`--check`; the spec's "3 grandfathered uppercase tags don't get renamed" language is inherently a
diff concept, so this only escalates to blocking inside `--diff` for genuinely *new* uppercase
identities — see §7), B9 (real `## `/`### Index` heading present — **report-level in C0**, becomes
blocking only when `--cutover` is passed, which nothing in C0 does), B10 (Cause/Follows self-edge,
duplicate edge, cycle on the Cause graph; date-reversal is report-only), B12 (Kernel section ≤16KB,
single Kernel entry ≤5KB), B13 (lessons.md identity ns in the file's own routing pointer table), B14
(Hook/Banner ≤320B, no control chars), B15 (bare `[[x]]`), B16 (block >900B without `[sole-record]` —
**report-level in single-snapshot `--check`**; see §7), B17 (Q-gate keyword/long-quote lint), B19
(Banner host must be a live `standinginstructions.md` entry with `[trust:user-ratified]`; total ≤2560B),
B22 (future date), B23 (malformed `Supersedes:` line), B29 (report: `Superseded by:` prose vs derived
reverse edge mismatch), B32 (unclosed fence at EOF — blocking, diagnostic at the fence's opening line).

**Failure semantics (Opus B-4).** `core.snapshot()`/`core.snapshotDir()` default to `{requireAll:true}`:
any missing/unreadable file, an unresolvable git ref, or an empty directory throws `core.PmmCoreError`
instead of silently returning a snapshot with holes. Every CLI (`pmm-manifest-v2.cjs`,
`pmm-migrate-v3.cjs`) catches this and prints `PMM-CORE-ERROR <reason>` + exits non-zero — `--check`/
`--index`/`--diff` never produce "blocking=0 exit 0" or empty output on a bad input. Pass
`{requireAll:false}` explicitly for a deliberately partial/synthetic snapshot (fixtures only).

## 4. Running it

```
# read-only inspection of the real corpus
node guards/pmm-manifest-v2.cjs --from worktree --json
node guards/pmm-manifest-v2.cjs --from HEAD --check
node guards/pmm-manifest-v2.cjs --index --as-of 2026-09-15        # derived index (default — see §5.5)
node guards/pmm-manifest-v2.cjs --index --legacy                   # verbatim old `## Index` passthrough
node guards/pmm-manifest-v2.cjs --diff HEAD :0

# migration planning (real corpus, read-only — never writes; writes guards/specs/PLAN-<oid>.json,
# a self-contained plan with concrete byte edits + before/after content fingerprints, see §5.5)
node guards/pmm-migrate-v3.cjs --plan

# migration rehearsal (ALWAYS use a --dir copy; refuses any path under the real memory dir).
# --apply now CONSUMES a plan file (--plan, not --names) — it never re-matches/re-derives anything;
# it only verifies the --dir's content fingerprint against the plan's before/after fingerprints and
# each edit's exact pre-edit bytes, then applies the plan's own byte-ops verbatim.
cp -r ~/.claude/memory /tmp/pmm-rehearsal
node guards/pmm-migrate-v3.cjs --apply --dir /tmp/pmm-rehearsal --plan guards/specs/PLAN-<oid>.json
node guards/pmm-migrate-v3.cjs --verify --stage c0 --before ~/.claude/memory --after /tmp/pmm-rehearsal --plan /tmp/pmm-rehearsal/PLAN-applied.json

# re-running --apply with the SAME plan against the now-migrated dir is a real no-op (Opus A10):
# the dir's content fingerprint now matches contentFingerprintAfter, so it prints "编辑 0 处" and
# writes nothing — not a hardcoded PASS, an actual fingerprint+per-edit-byte check.
node guards/pmm-migrate-v3.cjs --apply --dir /tmp/pmm-rehearsal --plan guards/specs/PLAN-<oid>.json

# self-tests (required before every commit touching this build)
bash guards/pmm-core.sh --self-test
bash guards/pmm-migrate-v3.sh --self-test
bash guards/pmm-manifest-shadow.sh
bash guards/pmm-c0-canary-check.sh      # the guard-canary.sh C0 roster line, runnable standalone
```

## 5. Migration actions ①–⑬ (C1, not executed by this build)

Detected by `computePlan()` in `pmm-migrate-v3.cjs`, driven by `D1-NAMING.md` (matched by **title
text**, never by its stale line numbers) plus direct corpus scanning:

- **①** insert a new `[ns:tag]` right after the closing `**` on each of the ~24 identity-less live
  titles (matched to D1-NAMING's 24-row table by fuzzy title-token overlap; unmatched rows are listed,
  not guessed). **Opus B-2 fix:** a tie or near-tie among candidates (best score, or second-best
  `>0.9×`best) is refused outright (`AMBIGUOUS`, listed with its candidates) instead of silently
  taking whichever candidate happened to appear first in the file — the pre-fix version did exactly
  that and could swap two identities when a short gist scored 1.0 against both a title and its own
  superset title (see `bestMatch()`/`scoreCandidates()` in `pmm-migrate-v3.cjs`).
- **②** bare `[user]` (no colon) anywhere in a tail → `[user:jax]`.
- **③** same-file duplicate identity → rename the D1-designated "second" occurrence. Matching reuses
  the same ambiguity-aware `bestMatch()` for both the "keep" and "rename" roles — either role tying/
  near-tying refuses the whole action rather than guessing.
- **④** cross-file duplicate (same id in exactly `{decisions.md, standinginstructions.md}`) → the
  decisions.md copy is renamed `<tag>-decided` plus a mutual `参见`/`规则版 → [[tag]]` link line.
- **⑤** legacy hand-written Index-bullet REST text that differs from the entry's title, and the entry
  has no `Hook:` yet → becomes `Hook: <REST>`. **Skipped** (left for ⑩) when the REST is >320B — auto-
  copying an oversized REST into Hook would just relocate a B14 violation instead of fixing it.
- **⑥** malformed `Supersedes:` line (single bracket, or bracket plus trailing/leading explanatory
  prose that isn't a "clarifies" marker) → normalize to `Supersedes: [[tag]]`.
- **⑦** an Index bullet's `(superseded→[tag])` marker names a target that has no formal `Supersedes:`
  field yet → add one to the target.
- **⑧** a marker (or a malformed `Supersedes:` line) whose text contains 澄清/部分取代 → convert to a
  plain prose `参见: [[tag]]` link, **never a formal edge** (owner decision, FINAL §10: two decisions
  can both stay current — a "closure" verdict and an unrelated "continuation" clarification aren't a
  supersession of one by the other).
- **⑨** an Index bullet carries a `(晚)`-style dateRaw suffix that the title line itself lacks →
  informational only in C0 (`pmm-migrate-v3.cjs` records the action but emits no byte-op; the actual
  text relocation needs a human-reviewed Hook rewrite, done together with ⑤/⑩ at C1).
- **⑩** Index bullet REST >320B → listed for **manual** Hook distillation; never auto-shortened.
- **⑪** `banner.md` (minus its header line) → `Banner:` field lines on the 4 target standing entries,
  then delete `banner.md`. Informational only in C0 (multi-file restructuring reserved for the
  human-reviewed C1 step).
- **⑫** stray `## Index`/`### Index` headings → delete. Informational only in C0.
- **⑬** add `[trust:user-ratified]` to `process:review-effort-tier-table`'s **standinginstructions.md**
  copy specifically (not its decisions.md pre-④ duplicate) — this is a hardcoded, deliberately
  disambiguated target per FINAL §5, not a fuzzy match.

`--apply` only emits byte-ops for ①②③④⑤⑬ — the rest are recorded in the plan/manifest for human
review but never touch bytes in C0 (or, for ⑥/⑦/⑧/⑨/⑩/⑪/⑫, in this build at all — they're multi-line
or multi-file restructurings the spec explicitly reserves for the reviewed C1 commit).

## 5.5 The plan↔apply contract (Opus B-1/B-3 rewrite)

Pre-repair, `--apply` re-ran `computePlan()` (and therefore `bestMatch()`) against whatever `--dir`
happened to contain, independently of what `--plan` had computed against `HEAD` — the two paths could
silently diverge, `--apply` never checked any OID/fingerprint, and a second `--apply` run re-matched
from scratch and could misfire (the ③-rename → ⑤-Hook-move queue misalignment that struck a *different*
entry's Hook line onto the wrong occurrence on a real-corpus second apply — Opus's B-3 repro). Now:

- **`--plan` is the only place matching ever runs.** It calls `buildFullPlan(snap, d1)`, which runs
  `computePlan()` once and immediately calls `buildEditOps()` on the *same* snapshot to produce
  concrete `edits[]` — each edit carries `oldBytesBase64` (the exact pre-edit bytes at its offset,
  base64), `titleLineSha256` (sha256 of the owning entry's title line, pre-edit), and `blockHash64`.
  The plan file also carries `contentFingerprint` (a sha256-of-sha256es over the 8 relevant files —
  the 7 `core.ALL_FILES` plus `banner.md` — computed from *this* snapshot) and
  `contentFingerprintAfter` (the same fingerprint computed over the edits applied *in memory* to that
  snapshot, via `simulateAfterSnap()` — i.e. "what --dir should look like once this plan is applied").
- **`--apply --dir <copy> --plan <file>` only ever consumes.** It computes the `--dir`'s own
  `contentFingerprint`: if it equals `contentFingerprintAfter`, the dir already reflects this exact
  plan (idempotent re-run — writes nothing, prints "编辑 0 处", exits 0 — this **is** A10, not a
  special case bolted on top); if it equals `contentFingerprint`, it verifies every edit's
  `oldBytesBase64` still matches at its recorded offset (defense in depth on top of the whole-snapshot
  check) and applies `plan.edits` verbatim; if it matches **neither**, it refuses (`--dir` doesn't
  correspond to this plan — wrong directory, or the plan is stale). `computePlan()`/`bestMatch()` are
  never called from `cmdApply()`.
- A git-tree-hash-identical fingerprint (matching `git rev-parse HEAD:.claude/memory` byte-for-byte)
  was considered and rejected for the `--dir`-side check: a `--dir` copy generally contains only the 8
  files this build touches, not the full `~/.claude/memory` tree (which also has `dreams/`,
  `_local-config/`, `secrets.md.gpg`, …), so it can never git-tree-hash-equal the real OID even when
  every file this build cares about is byte-identical. `contentFingerprint` is the honest,
  git-independent equivalent scoped to exactly the files that matter here; `plan.treeOid` (the real
  git OID) is kept separately as metadata for the canary's "is this plan current" check (A20, §6).

## 6. `--verify` assertions (A1–A22)

Implemented with real, breakable logic: A1 (per-entry body conservation, mechanical inserts excluded),
A2 (byte-exact replay of the plan's edit intervals over the *before* bytes — same `applyEditsToBuffer`
function `--apply` itself uses, so there is only one byte-patching algorithm in the codebase, not two
that could silently disagree on tie-breaking), A3 (title-line diffs only at plan-listed lines, only for
kinds ①②③④⑬), A4/A7 (old Index-bullet REST text vs staged Hook-or-title, via the *same* underlying
per-bullet check — kept as two reported assertions per spec, sharing one computation), A5 (edge
conservation vs v1's real parse of `--before`, minus exactly this plan's ⑧ action count — not a fixed
constant), A6 (per-entry field-multiset equality), A8 (archives + classes.md byte-identical), A9 (no
*newly introduced* B7/B8/B23 violation — compared by normalized violation-set, not raw counts, so a
pre-existing issue that merely shifted line numbers isn't misread as new), **A10 (idempotency — Opus
B-3 rewrite: `pmm-verify-assertions.cjs` now REALLY re-runs `--apply` itself**, in-process, against a
fresh scratch copy of `--after` using the same plan, and requires both "编辑 0 处" in its own output
and byte-identical files afterward — not a hardcoded `PASS`, and not solely relying on the shell
self-test's separate second `--apply` call, though that still exists too as an independent top-level
check), A12 (opaque links never lost), A14 (dateRaw conserved), A15 (blocks untouched by any plan
action keep their hash), A16/A17 (B10/B2′ and B14/B19 — no *new* violation introduced by `--apply`;
pre-existing corpus issues are left alone by design and correctly don't fail this), A18 (B9
fence-awareness sanity), **A20 (Opus H-2 rewrite: really calls `git rev-parse HEAD:.claude/memory`
right now and compares it to `plan.treeOid`** — not just "is the field non-empty". A plan with no
`treeOid` at all, e.g. one built by `buildFullPlan()` directly against a hermetic fixture rather than
via `cmdPlan()` against real `HEAD`, correctly `NOT-RUN`s instead of false-failing against an unrelated
repo). A11/A13 are documented, not independently asserted (A11: `--dir` copies aren't necessarily git
repos, so there's no `git diff --numstat` to check against — an edit-count proxy is printed instead,
`NOT-RUN` as a judgement; A13 is covered by the golden corpus, not re-derived per verify run).
**A19/A21/A22 are always `NOT-RUN` in C0** — they need infrastructure (C0.5 runtime shadow hooks, a
second machine, a wired `pmm-index-emit.sh`) that doesn't exist until later steps; `--stage c0` =
A1–A18 + A20, `--stage c1` additionally expects A19/A21/A22 to be real (still `NOT-RUN` today,
correctly).

**CLI parsing (Opus H-2).** `main()` checks the verb flags `--apply`/`--verify` *before* the generic
`--plan` flag — both `--apply --dir X --plan Y` and `--verify --stage c0 … --plan Y` legitimately
contain the substring `--plan` as an *option value*, not as the command. The pre-fix order checked
`args.includes('--plan')` first, so `--verify --stage c0 … --plan X` silently ran `cmdPlan()` instead
of `cmdVerify()` (and wrote a fresh, unreviewed plan file as a side effect of what was supposed to be
a read-only verify call).

## 7. Where this build could not be made fully deterministic (say so, don't hide it)

- **B8c (uppercase identity) is report-level in single-snapshot `--check`.** The spec's "3 existing
  uppercase tags are grandfathered, don't rename them" is inherently a *diff* concept (new vs.
  pre-existing) — a single `git show HEAD:...` snapshot can't tell "already existed" from "just
  added" on its own. Escalating it to blocking only inside `--diff`, for identities that are new in
  the later view and absent from the earlier one, is the closest deterministic approximation; it is
  documented here rather than silently assumed.
- **B16 (≤900B block size) is report-level in single-snapshot `--check`.** The spec's own text says
  the limit applies "only to new/changed blocks" (mechanical-insert lines excluded) — that's a diff
  concept too. `--verify`'s A1/A15 machinery gives the *real*, diff-aware version of this check for
  the migration path; a bare `--check` on one view reports oversized blocks without claiming to know
  which ones are "new."
- **① (identity-less title) and ③ (same-file duplicate) matching against D1-NAMING.md is fuzzy
  (normalized token-overlap against the gist text), not exact**, because D1-NAMING's own line-number
  hints are stale by design (the task brief: "match rows by title text, never by line number"). Ties
  and near-ties are refused rather than guessed (`AMBIGUOUS`, §5's ①/③ entries, Opus B-2) — but a
  genuinely fuzzy match that clears the ambiguity threshold with only one candidate is still fuzzy, not
  exact; D1-NAMING carrying a `blockHash64` or the full verbatim title (spec's own suggested strengthening)
  would remove this residual fuzziness entirely and is not implemented in this build. On today's real
  corpus every row matches cleanly with zero ambiguity (`--plan`'s own printed summary, incl.
  `①③AMBIGUOUS` count, is the source of truth).
- **⑨/⑩/⑪/⑫ are plan-only, not byte-ops, in C0** (see §5) — multi-file or human-judgment-requiring
  restructurings the spec reserves for the reviewed C1 commit, not something a shadow build should
  guess at.
- **A11 has no real `git diff --numstat` to compare against** for a `--dir` copy that may not be a git
  repository at all; it prints an edit-count proxy and reports `NOT-RUN` rather than asserting.
- **The shadow comparator's archive identity comparison (`pmm-manifest-shadow.cjs`, Opus H-5/H-9) is
  by `(file, tag)`, not by `blockHash` value equality**, because v1's `blockHash` (sha256 of the body
  lines rejoined by `\n`, truncated to 16 hex) and v2's `blockHash64` (sha256 of the *exact original
  bytes*, fence-aware block cut, CRLF/BOM preserved, full 64 hex) are different algorithms over
  different byte inputs — they are not directly comparable by value even when they describe the same
  logical block. §1.5's permanent archive identity really is `archive-sha256:<blockHash64>` (v2-only,
  going forward); the shadow comparator's job here is only to catch v1↔v2 corpus-coverage drift during
  C0, not to prove hash-equality across two different hash functions.
- **A5's "no more than exactly this plan's ⑧ count" slack is still a count comparison**, not a fully
  identity-mapped one (Opus H-5 also flagged this for `pmm-verify-assertions.cjs`, not just the shadow
  comparator) — it lists every missing edge in its detail string so a human can eyeball-map them, but
  does not machine-verify that each missing edge maps to a specific plan action. The shadow comparator
  (`pmm-manifest-shadow.cjs`) *does* do full per-edge identity mapping against B23 diagnostics; A5 was
  left as a count+listing given the time budget for this repair pass.

## 8. Rollback

C0 makes zero changes to `~/.claude/memory` and is not wired into anything — there is nothing to roll
back. If a *future* C1 step needs reverting, the plan (`guards/specs/PLAN-<treeOid>.json`) records
every action bound to the exact tree it was computed against; `git revert <C1 commit>` on the memory
repo followed by re-running `pmm-index-emit.sh --legacy` (once C1 exists) restores prior behavior — see
FINAL-SPEC §5 "双机协议" for the two-machine revert protocol. None of that machinery is built yet;
this section exists so the eventual C1 author isn't guessing.

## 9. C0.5 — shadow operations and exit criteria

Spec: `guards/specs/C05-BUILD-SPEC.md` (deliverables 1–9, "退出判据" (C1 前置), addendum-1 items 12/16,
and the 2026-09-24 errata section). **Status: shadow only**, same invariant as C0 — every tool below
only records or compares; none of them ever blocks a tool call, injects `additionalContext`, or writes
any file the live three/four-hook stack or the v3 ledger reads or writes. The three named exceptions
(isolation gate item 21, R2 re-push item 23, canary tri-state item 26) are live, already-wired,
explicitly-approved behavior changes and are **out of scope for this section** — they are not shadow
logging and are documented elsewhere (`guards/specs/isolation-gate-contract.json`,
`guards/pmm-isolation-gate.cjs`).

### 9.1 `pmm-hook.cjs --shadow` — unified shadow hook (deliverable 1)

`~/.claude/pmm-hook.cjs` is a preview of the future C1 authoritative hook, run today in shadow mode.

- **CLI**: `--shadow` (PostToolUse form), `--shadow --pre` (PreToolUse form), `--self-test`. Any other
  invocation is a silent no-op, exit 0.
- **Wiring** (`settings.json`, matches spec item 1 / spec 审 K20 exactly, verified live):
  `PostToolUse` matcher `Edit|Write|MultiEdit|NotebookEdit` → `node pmm-hook.cjs --shadow`;
  `PreToolUse` matcher `Edit|Write|MultiEdit` → `node pmm-hook.cjs --shadow --pre`. Both are wired
  **additionally** (the pre-existing three hooks' own entries are untouched) and both are wrapped
  `|| { echo …fail-open…; exit 0; }` — a crash inside the shadow hook can never become a denial (never
  `process.exit(2)`, never non-empty stdout).
- **Writes**: exactly `<resolveHome()>/.claude/.shadow/hook-<mach>.log`, one JSON line per invocation
  (`ts`, `phase`, `sid`, `agent`, `tool_use_id` — the comparator's join key, spec 审 K18 —, `tool`,
  `rel`, `repo`, `isMemory`, `gateBlocking[]`, `pushCandidatesPreTruncation[]` — the untruncated §3.1
  neighborhood sequence —, `pushSelected[]`, `quotaTruncated`, `packedPreview`).
- **Push candidates are Post-only.** A 2026-09-24 batch-review finding (H-1) was that Pre used to
  compute and consume the same shadow seen-budget first, leaving Post nothing to push (live logs
  showed 6/69 two-phase events as "Pre selected → Post empty"); Pre now only ever records
  `gateBlocking`/`isMemory` and never touches push candidates or the seen file (`if (repo && rel &&
  !isPre) {…}` guard, `pmm-hook.cjs:347`).
- **Its own seen-state** lives at `.shadow/seen-<seenKey>` only — `seenKey` is the same
  `pmm-recall-ledger.cjs`-exported `seenKey(session_id, agent_id)` function `pmm-trigger-recall.cjs`
  uses (M-SPEC 附注 #5③, incl. `nosess` fallback). It never reads or writes `.trigger-seen-*`,
  `memory/dreams/trigger-log-*.tsv`, `.pmm-len-baseline*`, or any v3 ledger row — no
  `writeEvent`/`writeQueue`/`writeSessionEnd` call exists anywhere in the file.
- **§3.1 邻域固定序** (① direct → ② Cause/effect → ③ Follows/precedes → ④ class-hub pointer, no
  members) is produced by `computeNeighborhood()`, deliberately bracketed by mutation-test markers
  (`CAUSE-BRANCH-BEGIN/END`, `FOLLOWS-BRANCH-BEGIN/END`) that `--self-test`'s K19 group splices/swaps
  against an independently-derived oracle to prove the comparison actually goes red on three separate
  mutations (delete Cause branch, swap ②③ order, drop only the 果 sub-branch).
- **1.2KB packing** (`packCandidates()`, item 20): drops trailing candidates first, then hard-truncates
  the remainder on a UTF-8 code-point boundary; recorded as `quotaTruncated` in the log row.
- **Isolation for `--self-test`**: every DUT subprocess is spawned through `selftest-iso.cjs`'s
  `isoEnv(T)`; the self-test's own footprint check asserts zero attributable change on the real root.
- **Last recorded self-test result**: 47/47 (F1 fix `6bac91d`, 2026-09-24; independently re-run by the
  closer with the same result — `guards/CHANGELOG.md` "09-24 F1 落地"). `pmm-hook.cjs` is not yet
  entered in `SELFTEST_STRUCTURE_ROSTER` (spec item 22) — flagged in the builder's own report for the
  closer to register.

### 9.2 Read-only tee on the four legacy hooks (`PMM_TEE_LOG`, deliverable 2's legacy-side data source)

`pmm-entry-length-watch.sh`, `guards/pmm-trigger-recall.sh`, `pmm-lessons-routing.sh`, and
`guards/pmm-trigger-write-gate.sh` each carry an identical, additive-only block near the top of the
file (marker comment `# ── C05-BUILD-SPEC B2 tee …`): when `PMM_TEE_LOG` is set (and the invocation is
not `--self-test`/`--self-check`, and not already inside the tee's own re-exec), the script re-execs
itself once with the original stdin captured to a temp file, replays the original stdout to the real
caller unchanged, and additionally appends one **7-column TSV row** to `$PMM_TEE_LOG` (errata E-6,
supersedes the spec's original "append stdout/exit code" wording):
`ts(UTC) \t hook-basename \t tool_use_id(or "-") \t truncated-flag(0/1) \t base64(stdout, raw bytes
capped at 1200B before encoding) \t sha256(full untruncated stdout) \t rc`. `PMM_TEE_LOG` unset ⇒ the
block never fires and the script's behavior is byte-for-byte what it was before this build (verified in
`pmm-precommit-gate.sh`'s own shadow self-test group, which diffs stdout/stderr/rc of the same fixture
with the switch on vs. off).
**Production status**: `settings.json` does not set `PMM_TEE_LOG` anywhere — the tee has never fired in
production, and no `~/.claude/.shadow/legacy-<mach>.log` exists on the real root. The only place this
tee currently produces real data is `pmm-shadow-replay.cjs`, which sets `PMM_TEE_LOG` itself for its
own isolated subprocess (§9.4). Self-test count for the hook carrying the tee assertions:
`pmm-trigger-recall.sh --self-test` 104/104 (B2-1, additive 36 lines).

### 9.3 `guards/pmm-shadow-compare.cjs` — the comparator (deliverable 2)

Read-only; compares the shadow log (§9.1) against the legacy tee log (§9.2) for the same
`tool_use_id`, and classifies any disagreement.

- **CLI**: `[--shadow-log <path>] [--legacy-log <path>] [--repo <dir>] [--out <file>] [--self-test|--self-check]`.
  With no `--shadow-log`/`--legacy-log`, mode is `live` and both default to
  `<resolveHome()>/.claude/.shadow/{hook,legacy}-<mach>.log`; passing either flips mode to
  `explicit-logs`. Report goes to stdout unless `--out` is given.
- **OID pinning** (addendum-1 item 12): `git rev-parse HEAD:.claude/memory` is taken once before
  comparing and once after; if it drifted, the whole run's conclusion is discarded (`process.exit(1)`)
  rather than mixing pre/post-drift results. The report always prints both OIDs.
- **Classification** (`classifyPushDiff()`): a same-`tool_use_id` mismatch in the write-gate-blocking
  set, echo-tag set, or push-tag set is sorted into exactly one of three mechanical "allowed" buckets —
  `quota` (the shadow row's `quotaTruncated` flag was set and the missing tag was in the
  pre-truncation sequence), `v3-class-count-not-members` (shadow pushed a class-hub pointer + count
  where legacy pushed actual members), `v3-untyped-link-not-carried` (legacy's tag is only a plain
  `[[link]]` in the entry's body, not a typed Cause/Follows/Supersedes edge) — or else counted as
  `unexplained`/`no-corpus-context`. `totalUnexplained` is the metric the exit criteria (§9.9) gate on.
- **Self-test**: 27/27 (B2-2, `6d7d053`).
- **Current real data**: production has never wired `PMM_TEE_LOG` (§9.2), so a live `--out` run against
  the real `.shadow/` logs sees 0 legacy rows by construction — the comparator reports "0 events on
  both sides" honestly rather than a real zero-unexplained result. The only runs with real two-sided
  data so far are via the replay path (§9.4).

### 9.4 `guards/pmm-shadow-replay.cjs` — event replay (deliverable 3)

Rebuilds hook JSON from `memory/dreams/trigger-log-*.tsv` `event` rows (Bash events have no reconstructable
command text and are skipped per addendum-1 item 13③) and feeds each reconstructed event to both
`pmm-hook.cjs --shadow` and the real `pmm-trigger-recall.sh` (through `bash`, so its `PMM_TEE_LOG` tee
actually fires) under one isolated temp root, then reuses `pmm-shadow-compare.cjs`'s own
`compareEvents()`/`renderReport()` to produce a "replay" report.

- **CLI**: `[--limit N] [--out <file>] [--tsv <override-file>] [--repo <dir>] [--self-test|--self-check]`.
  `DEFAULT_LIMIT = 300` (spec only requires ≥200; replaying the full 4000+-event history would be slow).
- **OID pinning**: same discipline as §9.3 — a single `git archive` of the pinned OID supplies both the
  corpus *and* the `dreams/trigger-log-*.tsv` event source, so they cannot disagree mid-round; a commit
  landing between the start/end pin invalidates the whole round.
- **Writes nothing to the real root** — everything (including its own `hook-<mach>.log` /
  `legacy-<mach>.log`) lands under a `mkdtemp` root that is removed at the end of the run; only
  `--out <file>` (if given) writes to a caller-chosen path.
- **Self-test**: 13/13 (B2-2, same commit as §9.3), including a full hermetic end-to-end round against
  a synthetic fake git repo (never the real one) and a mid-round-drift primitive check.
- **Real replay results so far** (per `guards/CHANGELOG.md` "09-24 B2-2 落地"): `--limit 10` completed
  cleanly (OID stable) with 24 unexplained + 25 class-count-pointer diffs against real production
  history; two attempts at `--limit 200`/`--limit 220` both aborted with `drift` because a concurrent
  builder session committed to `.claude/memory` mid-round — proof the drift-abort mechanism (item 12)
  works, but **the ≥200-event replay required by the exit criteria has not yet completed clean** and
  must be re-run in a window with no concurrent commits.

### 9.5 `~/.claude/pmm-precommit-gate.sh` `PMM_PRECOMMIT_SHADOW=1` + `guards/pmm-precommit-shadow-replay.sh` (deliverable 4)

- **Live-gate switch**: `PMM_PRECOMMIT_SHADOW=1 git commit …` (env var, default unset/off). When on, and
  only *after* the real gate's `fail`/`msg` decision is already computed, it separately evaluates
  `core.check()`'s blocking set on `HEAD` vs. `:0` (the staged index) and appends one JSON line to
  `<resolveHome()>/.claude/.shadow/precommit-<mach>.log`: `{ts, tool, view_a:"HEAD", view_b:":0",
  v3_blocking_staged, v3_blocking_new, v3_blocking_fixed, legacy_fail, legacy_msg}`. **Never changes
  the real gate's exit code** — verified by the gate's own shadow self-test group, which diffs
  stdout/stderr/rc of one red fixture and one green fixture with the switch on vs. off (12 assertions
  plus 2 required-red mutants).
- **`guards/pmm-precommit-shadow-replay.sh`** (thin wrapper) / **`.cjs`** (engine): replays the most
  recent N real commits touching `.claude/memory` (`--n`, default 30) by diffing each commit's `core
  --diff <parent> <commit>`-equivalent blocking set, sorted into two columns: **列①** "v3 会拦而当时
  放行" (this commit's diff introduces new blocking — since the commit exists, it was historically not
  blocked) and **列②** "当时拦而 v3 不拦". Column ② is **structurally always empty** under the spec's
  own definition ("提交存在=没被拦" gives no data source for "was historically blocked") — this is a
  documented spec-definition consequence, not an engine gap (flagged to the batch reviewer as errata
  E-11, accepted literally for C0.5; a real data source for column ② is deferred to C1).
- **CLI**: `[--out <file>] [--n <N>] [--self-test]`. Isolation: the wrapper redirects
  `HOME=USERPROFILE=PMM_HOME=<T>` via `selftest-iso.cjs`'s `isoEnv()` but separately overrides
  `PMM_GIT_HOME=<real home>` (a `pmm-core.cjs` `homeDir()`-native override, distinct from "home
  redirection") so the engine's read-only `git` calls still see real history; a temporary
  `GIT_CONFIG_GLOBAL` supplies a `safe.directory` exception that git's normal `$HOME/.gitconfig` lookup
  would otherwise lose once `HOME` is redirected.
- **Self-test**: 18 assertions (fixture-repo 列①/列② counts, a `--n 999`-root-commit boundary case that
  must not crash, and a real-history smoke test asserting the wrapper's own `PMM_GIT_HOME` wiring still
  works, all under a zero-footprint proof).
- **Real run** (B3, `728ba65`+`10e3303`): 30 real commits, OID `acbcc7f6…` — 列① = **8** (B8b/B12/B23
  diagnostics; each one requires manual batch-review judgment before it counts toward the exit
  criteria), 列② = 0 (structural, per above).

### 9.6 `guards/pmm-index-emit.sh --shadow` + LKG cache (deliverable 5)

Computes what `core --index` would render for `HEAD` and compares it against the three files'
existing hand-written `## Index` sections — **never wired into SessionStart** (explicit in both the
spec text and the file's own header comment).

- **CLI**: `[--dir <path>] [--as-of <date>] [--shadow] [--self-test|--self-check]`. `--shadow` is
  accepted but is the tool's only mode (a no-op flag, kept for the spec's naming). `--dir` switches
  from the default `core.snapshot('HEAD')` view to `core.snapshotDir(dir, {requireAll:false})`, used
  by the fault-injection self-test and available for future fixture replay.
- **Writes**: `<resolveHome()>/.claude/.shadow/index-<mach>.txt` and an LKG cache entry
  `<resolveHome()>/.claude/.pmm-index-lkg/<sha256hex(JSON({sourceOids, schemaVersion}))>.txt`.
- **Fault injection → `PMM-DEGRADED <code>` on stdout, rc 1, never empty output** (deliverable 5's
  base three plus addendum-1 item 10①'s two new ones, all with distinct, non-`blocking`-shaped codes):
  `core-throw`, `empty-snapshot` (all 7 files missing), `missing-file:<name>` (comma-joined if several),
  `file-empty:<name>` (0-byte file — item 10①, checked *before* `parseAll` ever sees the file so core
  cannot silently treat it as legal), `file-truncated:<name>` (last non-blank line opens a v3 title
  `**YYYY-MM-DD…` but never closes it — `detectTruncation()`, deliberately excludes the
  already-legal "missing trailing newline" shape). On any of these, `degraded()` tries an exact LKG-key
  hit first, then falls back to the most-recently-modified `.txt` in the LKG dir, and only emits a
  bare diagnostic header if neither exists — "从不空输出" is enforced structurally, not by convention.
- **Comparison to the 3 files' legacy `## Index`** (`compareIndexToLegacy()`, A4/A7-aligned pairing —
  in C0.5 there is no migration plan yet, so the "plan mapping" degrades to identity `id→id`): buckets
  are `matched` (byte-equal), `mismatched`, `dangling` (legacy bullet has no corresponding live entry),
  `derivedOnly` (live entry has no legacy bullet), `exempt` (bullet carries a dateRaw suffix, ⑨'s
  known exemption). This is a **report, not a pass/fail gate** — unlike §9.3's zero-unexplained bar.
- **Self-test**: 27/27 (B4, `dad3ec6`+`acce55d`), including all five fault codes plus one LKG-hit
  round-trip (same isolated `HOME`, same `--dir`, run twice — second run must show `lkgHit:true`
  against the first run's freshly-written cache file).
- **Real run** (HEAD view, 3 files): 508 legacy bullets compared — 124 matched / 357 mismatched (旧
  Index 手写摘要 vs. 派生标题不同, expected pre-C1) / 1 dangling (`lessons.md [agent:claude]`, flagged
  for `pmm-pointer-lint.cjs` at close-out) / 25 derivedOnly / 1 exempt.

### 9.7 `guards/pmm-search-v2.sh` — v2 ranking shadow (deliverable 6)

Parallel §3.2-ranked retrieval engine; does not touch `pmm-search.sh` (v1, still the production path).

- **CLI**: `pmm-search-v2.cjs "<query>" [--record-exposure]` | `--baseline [canary.tsv] [out.json]` |
  `--self-test`. Ranking is implemented over the vendored `lucaong/minisearch` 7.2.0
  (`guards/vendor/minisearch/`, per addendum-1 item 19's "vendor, don't hand-roll a ranker" rule —
  `guards/vendor/VENDOR.md` records the upstream URL/version/license/sha256); the wrapper layer adds
  exact-identity-first boosting and §3.2's field weights on top, never edits the vendored file itself.
- **Exposure log** (`<resolveHome()>/.claude/.shadow/retrieval-impressions-<mach>.tsv`, 7-column TSV:
  `ts, query_sha256, rank(0-based), gate_instance_id="search:<rank>", impression_id, identity, score`;
  `impression_id` uses the M-SPEC Appendix A formula with `session_id`/`agent_id`/`tool_use_id` fixed
  to `''` — a bare CLI tool has no real session context to read) is written **only** when the caller
  passes the literal `--record-exposure` flag. Neither a plain query nor `--baseline` ever writes it —
  this is a deliberate 2026-09-24 design fix, not the original design: an earlier version wrote
  exposures unconditionally, and three real `--baseline` runs against the real root wrote 23×8×3=552
  rows of session-empty **fake exposure data** into the real `.shadow/retrieval-impressions-<mach>.tsv`
  before anyone noticed (F3 incident, `guards/CHANGELOG.md` "09-24 F3 落地" / "F3 修复落地";
  quarantined copy sha `b13f8a74…`, real-root copy since deleted). The ruling that followed:
  **a measurement/baseline mode must never write production telemetry as a side effect** — write-gating
  must be an explicit, literal caller flag, never inferred from environment or call context.
- **Baseline**: `--baseline [canaryFile] [outFile]` runs every non-comment row of
  `memory/_local-config/canary-set.tsv` (23 questions: `text`/`search`/`semantic` types) and reports
  Recall@1/Recall@3/MRR/zero-hit-rate; `runBaseline()` structurally never calls the exposure writer
  regardless of flags. `outFile` (if given) is written verbatim as JSON — the caller, not the script,
  is responsible for naming it `guards/specs/RETRIEVAL-BASELINE-<treeOid>.json` (spec item 6's naming
  convention); the checked-in `guards/specs/RETRIEVAL-BASELINE-69f6ca819f5ed24aa54b57019e1d3f9a74cf3989.json`
  is the current instance: 23 questions, Recall@1 = Recall@3 = MRR ≈ 0.6957, zero-hit 7/23 (2 malformed
  tag queries, 1 not-in-corpus timeline target, 4 gbrain-slug `semantic` questions the v2 index was
  never meant to answer — a different retrieval channel, not a v2 defect).
- **Self-test**: 32/32 (fixed from 26/26 by the F3 opt-in rewrite; independently re-run with the same
  result — `guards/CHANGELOG.md` "09-24 F3 修复落地").

### 9.8 Fault-injection matrix `guards/pmm-fault-matrix.cjs` (deliverable 8)

Was mid-build at the time this section was written (`guards/CHANGELOG.md`'s last entry predates its
most recent `pmm-fault-matrix.cjs`/`.sh` mtimes); per this build's own instruction not to read its
internals prematurely, this doc intentionally stops at one pointer: **see `pmm-fault-matrix.cjs
--help`** for its current CLI and coverage. Do not treat its absence from the rest of this section as
evidence it is unbuilt — check `--help` and `guards/CHANGELOG.md` directly for its landing status.

### 9.9 Exit criteria (C1 前置) — current status

Per spec's own "退出判据" section, cross-referenced against `guards/CHANGELOG.md`'s most recent B2-2/
B3/B4 entries at the time of writing:

| Criterion | Status | Evidence |
|---|---|---|
| Shadow comparison: ≥200 events real-time (Bash events excluded), ≥100 on each of 2 machines, ≥1 day apart; replay listed separately, never substituting for real-time | **Not met** | Production has never wired `PMM_TEE_LOG` (§9.2), so real-time comparison currently has 0 legacy-side rows by construction — a trivial, not a real, zero-unexplained result (§9.3). Replay attempts at ≥200 events both aborted on OID drift (§9.4); only a clean `--limit 10` run exists so far. |
| 7 consecutive days zero unexplained differences (by §9.3's 3 allowed categories) | **Not met** | No multi-day run has occurred yet; also blocked on the same tee-wiring gap above. |
| precommit replay: 30 commits, all diffs manually judged to zero | **Partially done** | 30-commit run completed (§9.5); 列① has 8 entries still awaiting the batch reviewer's per-entry manual judgment (not yet judged to zero). |
| Fault-injection matrix all green | **Unknown at time of writing** | `pmm-fault-matrix.cjs` was mid-build (§9.8); check `--help`/CHANGELOG directly. |
| Retrieval baseline recorded | **Done** | `guards/specs/RETRIEVAL-BASELINE-69f6ca819f5ed24aa54b57019e1d3f9a74cf3989.json` (§9.7). |
| LKG hit path tested | **Done** | `pmm-index-emit.cjs --self-test` group ⑥ (§9.6): second run against an unchanged `--dir` shows `lkgHit:true` against the cache the first run wrote. |
| codex + Opus review C0.5 diff, GO | **Conditional, not a clean GO** | `audits/OPUS-2026-09-24-c05-batch-review.md`: A-batch and B-batch both "有条件保留" (conditionally retained), with the B7 hand-rolled-ranker branch rejected outright and rebuilt as §9.7; multiple errata items (E-1…E-11) tracked, several already landed via the F1/F2/F3 repair waves referenced throughout this section. |
| fab 盲攻 #4 (spec §9 步 2) | **Not yet run** | Per `guards/CHANGELOG.md`, scheduling was deferred pending Jax's approval, suggested to run after §9.3/§9.4 stabilize. |

None of the above are blocking for continued C0.5 shadow-mode operation (per the "不拦、不注入"
invariant, nothing in this build's absence of a clean exit-criteria pass can regress anything live) —
they gate the *next* step, C1, not this one.

### 9.10 Discipline: a measurement mode must never write production telemetry

Restated because it cost a real incident this batch (§9.7's F3 exposure-contamination episode,
2026-09-24): any tool whose job is to *measure* — a baseline run, a `--self-test`, a throwaway CLI
query, a dry-run replay — must never write to the same file a real, "this was actually shown to a
user" signal is read from, unless the caller passes an explicit, literal flag asking for that write.
Inferring "am I in measurement mode" from environment variables, call context, or a default-on write
path is exactly how 552 rows of fake exposure data landed in a real production file before anyone
noticed it wasn't supposed to exist yet.
