# AxMem — Memory Governance for Claude Code

**Deterministic guardrails for AI coding agents (Claude Code first).**

> **Lessons become gates.** Every other memory product sells better recall.
> AxMem sells something different: *the same mistake never happens twice.*

Two problems compound in any long-running agent memory system: (1) a written
lesson is not a lesson *enforced* — nothing stops the same mistake from
recurring unless a hook can actually deny the tool call that would repeat it;
(2) a growing memory file rots — dangling pointers, size bloat, orphaned
blocks, duplicate content — and a human has to notice before it becomes
useless. AxMem is a Claude Code–native, local-first, git-auditable **memory
governance layer** that solves both with machinery instead of more prose. It
doesn't replace your memory files — it puts deterministic checks around them:

## Architecture (text diagram)

```
Claude Code hook events (SessionStart / PreToolUse / PostToolUse / PreCompact)
        │
        ▼
  hooks/*.sh  ───────────────►  core/*  (write-gate, receipts, pointer-lint,
   (thin, per-event shims)         trigger-recall, precommit-gate, canary,
        │                          redundancy-lint, fingerprint — parameterized
        │                          via lib/prelude, zero hardcoded paths)
        │
        └─► retrieval/*        fused exact + semantic search, heat telemetry

guards/*     — legacy/reference guard scripts (isolation gate, trigger-recall,
               fingerprint, canary, model dispatch guards) predating the P1
               port; see Status below for what's wired vs. reference-only.
               AxMem Pro's causal shadow-memory engine is not part of this
               tree — see "AxMem Pro" below.

lifecycle/*  — init / doctor / backup / restore / uninstall / upgrade,
               crash-consistent two-phase swap
adapters/*   — Claude Code / Codex / Hermes / generic wiring, each isolated
               behind lib/prelude's env > config.json > default resolution
```

Every component ships its own `--self-test` (red: a historical bad input is
actually blocked; green: an adjacent legal input still passes; mutation: a
weakened copy of the guard's own judgment must go red; wiring: a real entry
point proves it's actually connected, not just present in a test file).
`bin/axmem selftest` discovers and runs every one of them automatically.

| Pillar | What it does | Origin component |
|---|---|---|
| **Write discipline gates** | Atomic entries, index↔entry parity, orphan detection, size caps with a `[sole-record]` fidelity exemption — enforced by hooks, not prose | `hooks/pmm-entry-length-watch.sh` |
| **Pointer integrity** | Every `→pointer` and `[[wiki-link]]` must resolve; compression is only legal when the detail is alive somewhere else | `guards/pmm-pointer-lint.*` |
| **Guard canary** | Every guard is fed known inputs on a schedule; a guard that can't prove it still fires gets loudly retired — silent death is the #1 guard killer | (template in Phase 1) |
| **Redundancy lint** | Four countable proxies (intra-entry repeat, corpus copy, filler words, gzip ratio) catch "this repeats itself" without ever judging meaning | `guards/pmm-redundancy-lint.*` |
| **Guard-code fingerprint** | The guards themselves sync over git — a sha256 roster catches an undocumented edit to guard code, since editing a guard with nobody noticing is the cheapest attack | `guards/pmm-fingerprint.sh` |
| **Lesson-class taxonomy** | Every lesson gets one `Class:` line from a controlled vocabulary in `classes.md`; editing a file that matches a class's trigger pushes the class plus its newest members — "is this the same kind of mistake as before?" becomes a machine check | `memory/classes.md` + `core/manifest.cjs` |
| **Retire = move** | Deleting an entry requires its verbatim text to appear in an archive in the same commit — loss is structurally impossible | `hooks/pmm-precommit-gate.sh` |
| **Fused retrieval** | Exact-text and semantic channels both run on every query; exact hits pin to the top; misses are ledgered, not shrugged at | `retrieval/pmm-search.sh` |
| **Dispatch guards** | Sub-agent model/effort mix checked before launch — an AST parse of workflow scripts, not a regex guess | `guards/model-guard.sh` + friends |
| **Dream (hygiene)** | Monthly, human-approved, **counts-only** maintenance proposals. Judgment-based auto-rewriting is banned by empirical audit (5/10 wrong), which independent research now names "memory confabulation" | (protocol in Phase 1) |
| **Heat telemetry** | Access logging drives promote/demote proposals — evidence, not vibes | `hooks/pmm-heat-collect.sh` |

## Design laws (all empirically earned)

1. **Injection ≠ effect.** A fat always-on context loses authority; keep the hot layer thin.
2. **Gates work, text doesn't.** A rule that isn't machine-enforced is wallpaper.
3. **Machines count well, judge poorly.** Counting claims audit byte-accurate; judgment claims fail ~50%.
4. **Counts age into phantoms.** Every count carries an as-of date.
5. **A dead guard is worse than no guard** — it reads as coverage. Hence the canary.
6. **Compression may never buy tidiness with fidelity.** If detail has no other home, full text is legal (`[sole-record]`).

## Status

**Alpha — P1 core landed (2026-09-13).** `lib/prelude` + `core/` are fully
parameterized: eight components (write-gate, receipts, pointer-lint,
trigger-recall, precommit-gate, canary, redundancy-lint, fingerprint), each
with red/green self-tests covering the adversarial escapes they were
hardened against, under an auto-registering canary with an executed-count
assertion. Fresh-user E2E: empty HOME, zero edits, `doctor: all green`.
Install: `bash install.sh [--claude-code] [--hermes] [--generic
--instruction-file <path>]` · codex wiring: `bash adapters/codex/wire.sh`.

Commands (`axmem <command>`, see `bin/axmem` for the full list): `init` ·
`doctor` · `gate [--block]` · `receipt <sub...>` · `lint [--strict]` ·
`trigger` · `precommit` · `canary` · `manifest [--json|--check]` ·
`redundancy [--report|--json]` · `fingerprint <init|check|refresh>` ·
`classify --map <tsv>` · `selftest` · `config get <k> <d>` · `version` ·
`migrate --backup` (manifest.json-carrying tar) · `uninstall --adapter
<name>|--all [--dry-run]` · `upgrade` · `restore <backup.tar> [--dry-run]`
(crash-consistent two-phase swap, D7 — see `docs/P1-ADAPTERS-SPEC.md` §2.3
for the exact recovery guarantees and what they deliberately do NOT cover).
List a class's members with a raw grep (no dedicated `axmem grep`
subcommand ships yet — `retrieval/pmm-grep.sh` is a legacy reference
pending its own port): `grep -B3 'Class: \[\[class:<id>\]\]'
AXMEM_MEMORY_DIR/lessons.md`.
`guards/`, `hooks/`, `retrieval/` are legacy extracted references
(see `docs/PARAMETERIZATION.md`) pending port or retirement.

**2026-09-24 sync**: the trigger/recall pipeline (`guards/pmm-trigger-*.cjs`,
`guards/pmm-recall-*.cjs`), the isolation gate (`guards/pmm-isolation-gate.cjs`),
and a handful of dispatch/fingerprint/canary guards remain in `guards/` as
**legacy/reference, not yet wired into `bin/axmem`** — each file's own
`--self-test` runs standalone (`node guards/<file>.cjs --self-test` / `bash
guards/<file>.sh --self-test`); none of it is discovered by `npm run
selftest` yet (that only walks `core/ lib/ adapters/** lifecycle/*.cjs
tests/`). Two personal-deployment hardcodes were parameterized in this pass:
`guards/guard-canary.sh`'s optional second-repo check now reads
`PMM_SECOND_REPO_DIR` (unset by default — every check tied to it is a silent
pass, not a fail), and `guards/pmm-pointer-lint.cjs`'s extra path roots now
read `PMM_POINTER_EXTRA_ROOTS` (comma-separated, empty by default). The rest
of `guards/` still carries author-specific comments (dates, first name, an
internal project codename) that were judged low sensitivity and left as-is
for this pass — see the sync report for the exact grep counts.

## AxMem Pro (coming)

The causal shadow-memory engine — a graph-based analysis layer that computes
what a future enforcing hook *would* have done on every edit, without ever
blocking or injecting anything — is not part of this open-core repo. It will
ship as **AxMem Pro**, under a commercial license, and includes:

- **Causal shadow memory** — a graph engine over your memory files that tracks
  supersession, cause/follow links, and identity across entries.
- **Five-dimension shadow comparator** — compares what the live gates did
  against what a candidate policy change would have done, across five
  independent judgment dimensions, before that change ever goes live.
- **Replay** — deterministic replay of recorded sessions against a new guard
  version, so a policy change is validated against real history before it's
  trusted.
- **Retrieval baselines** — fused exact + semantic search with a scored,
  reproducible baseline corpus for tuning recall precision.

Interested in an early build or a commercial license? Open an issue.

## Isolation discipline

Nothing in this repo may touch a real user's `$HOME`/`.claude` by accident.
The convention, enforced by convention (not yet by a shipped lint — see
`guards/pmm-isolation-gate.cjs` for the reference implementation of what
that lint should eventually become):

- Every component resolves its base directory through `lib/prelude` (`env >
  config.json > default`) — grep for a literal `C:/Users` or a bare
  `/home/` outside `docs/`/`tests/` fixtures and it's a bug.
- Every self-test that exercises filesystem writes does so inside its own
  `mktemp -d` root, passed in via `HOME`/`USERPROFILE`/`PMM_HOME`/
  `AXMEM_HOME` overrides — never the invoking user's real profile.
- CI (`.github/workflows/ci.yml`) runs `npm run selftest` and `npm run
  doctor` on Ubuntu and Windows, each inside a freshly `mktemp -d`'d,
  fully-redirected HOME, so a green CI run is itself the isolation proof.
- When developing against this repo locally, always export `HOME`,
  `USERPROFILE`, and `PMM_HOME` to the same temporary directory before
  running any self-test — `HOME=$T USERPROFILE=$T PMM_HOME=$T <command>`.

## Self-test

```
npm install     # no-op — zero runtime dependencies, Node's stdlib only
npm run selftest
npm run doctor
```

`npm run selftest` runs `bin/axmem selftest`, which discovers and executes
every component under `core/`, `lib/`, `adapters/**`, `lifecycle/*.cjs`, and
`tests/` that declares its own `--self-test` (240s timeout per component,
PASS/SKIP/FAIL reported per component and summarized at the end).

Roadmap (Phase 1–3): single-command lifecycle (`install / init / doctor /
restore`), versioned data contract + migrations, fixture-based CI matrix
(three platforms, fictional user), explainable ops surface (what got injected,
why, at what token cost), security-hardened defaults.

## Compatibility & provenance

AxMem grew around [PMM (Poor Man's Memory)](https://github.com/nominex/pmm) —
an excellent Claude Code memory plugin by NominexHQ (PolyForm Noncommercial).
**AxMem does not bundle or fork PMM**; it is an independent hardening layer
that works with any markdown-file memory convention. PMM remains a great
choice for the storage/save layer underneath.

## License

Apache-2.0 — see [LICENSE](LICENSE).
