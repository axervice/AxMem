# Survey 2026-09-17 — live PMM system (C:SERS<USER>\.claude) vs AxMem product repo

Read-only survey by an Explore agent (Sonnet), commissioned by the main session as the fact base for `docs/P2-CC-PERFECT-SPEC.md`. Nothing was modified. Line numbers refer to the files as of 2026-09-17 17:30.

## 1. Live guard/hook file → CC hook event → role → product-repo status

Directly wired in `C:SERS<USER>\.claude\settings.json` (lines 24-221):

| File | Hook event(s) | Role | Product-repo status |
|---|---|---|---|
| pmm-autopull.sh | SessionStart | pull memory repo, freshness lamp | MISSING |
| pmm-session-start.sh | SessionStart | inject memory into session | MISSING |
| pmm-size-watch.sh | SessionStart | protocol/kernel-injection canary | MISSING |
| pmm-lessons-routing.sh | SessionStart, PostToolUse(Edit\|Write\|MultiEdit --block) | route new lessons to a channel | MISSING |
| pmm-entry-length-watch.sh | SessionStart, PostToolUse(Edit\|Write\|MultiEdit --block) | write-integrity gate | PRESENT-diverged → hooks/pmm-entry-length-watch.sh |
| hooks/pmm-permanent-inject.sh | SessionStart | inject PERMANENT repo content | MISSING |
| pmm-dream-pending-watch.sh | SessionStart | flag pending dream proposals | PRESENT-same → hooks/pmm-dream-pending-watch.sh |
| hermes-memory-freshness.sh | SessionStart | cross-tool (Hermes) freshness | MISSING (live-only, not to port) |
| pmm-banner.sh | SessionStart, UserPromptSubmit | standing-rule banner | MISSING |
| pmm-prompt-pull.sh | UserPromptSubmit | pull-on-prompt | MISSING |
| guards/model-guard.sh | PreToolUse Agent\|Workflow | model-guard dispatcher | PRESENT-same → guards/model-guard.sh |
| guards/opus-justification-guard.sh | PreToolUse Agent | require [OPUS:reason] | PRESENT-same → guards/opus-justification-guard.sh |
| guards/pmm-trigger-write-gate.sh (+.cjs) | PreToolUse Edit\|Write\|MultiEdit | write-time trigger-presence gate | PRESENT-diverged, different design → core/write-gate.sh (329-line bash reimplementation vs 15-line wrapper over 207-line .cjs) |
| guards/bash-pipe-exitcode-watch.sh (+.cjs) | PreToolUse+PostToolUse+PostToolUseFailure Bash | pipe gate v2 | MISSING |
| guards/pmm-bash-impression.sh (+.cjs) | PreToolUse Bash | M0 impression/ledger observer | MISSING |
| guards/pmm-trigger-recall.sh (+.cjs) | PostToolUse Edit\|Write\|MultiEdit, NotebookEdit | moment-triggered recall | PRESENT-diverged → core/trigger-recall.cjs/sh |
| memory/_local-config/pmm-receipt.sh | PostToolUse AskUserQuestion (from-hook), Stop (stop-check) | write-receipt capture | PRESENT-diverged → core/receipt.sh (+ core/receipt-fromhook.cjs) |
| pmm-heat-collect.sh | PostToolUse Grep | access-heat telemetry | PRESENT-same → hooks/pmm-heat-collect.sh |
| guards/pmm-recall-ledger.cjs --session-end | SessionEnd | flush v3 recall ledger | MISSING |
| pmm-should-save.sh | Stop | decide whether to prompt a save | MISSING |
| pmm-pre-compact.sh | PreCompact | pre-compaction hook | PRESENT-same → hooks/pmm-pre-compact.sh |

Registered only in `guards/guard-canary.sh` roster (guard-canary.sh:12-14 "the roster IS the registry"), grouped by subsystem:

| Subsystem | Live files | Product-repo status |
|---|---|---|
| pipe gate v2 + parser + ledger + acceptance runner + mutants | bash-pipe-exitcode-watch.cjs/.sh, pmm-cmd-parse.cjs, pmm-cmd-parse-conformance-check.cjs, pmm-bash-impression.cjs/.sh, pmm-recall-ledger.cjs, pipe-gate-v2-acceptance.cjs, mutants/{always,null,blind-parser,di-intervene}.cjs, specs/pipe-gate-v2-pins*.json, specs/pipe-gate-v2-test-contract.json | all MISSING |
| recall loop M0–M3 tools | pmm-recall-queue.cjs, pmm-recall-label.cjs, pmm-recall-precision.cjs, pmm-recall-baseline.cjs, pmm-recall-m3.cjs, pmm-recall-policy.cjs, pmm-recall-classify.cjs, pmm-trigger-compat-replay.cjs | all MISSING |
| trigger write gate / trigger recall / glob | pmm-trigger-write-gate.cjs, pmm-trigger-glob.cjs | write-gate.sh present-diverged (reimplemented); .cjs internals and pmm-trigger-glob.cjs MISSING |
| write integrity / precommit | pmm-entry-length-watch.sh, pmm-supersede-fixture-test.sh, pmm-precommit-gate.sh | entry-length-watch diverged; precommit-gate diverged and duplicated in-repo (hooks/ vs core/ differ from each other and from live); supersede-fixture-test MISSING |
| manifest / fingerprint / canary | pmm-manifest.cjs/.sh, pmm-manifest-v2.cjs, pmm-manifest-shadow.cjs/.sh, pmm-fingerprint.sh, guard-canary.sh, pmm-c0-canary-check.sh | manifest diverged (core/manifest.*); fingerprint diverged (core/fingerprint.sh, different convention); canary reimplemented (core/canary.sh self-discovering vs live hardcoded roster); manifest-v2, manifest-shadow, c0-canary-check MISSING |
| dream / receipts / heat | pmm-dream-pending-watch.sh, pmm-heat-collect.sh, pmm-receipt.sh, pmm-receipt-fromhook.cjs, pmm-fade.cjs | dream-watch/heat-collect PRESENT-same; receipt.* diverged; fade diverged (core/fade.cjs) |
| PMM v3 C0 migration (shadow-only) | pmm-core.cjs/.sh, pmm-core-selftest.cjs, pmm-core-high4b-probe.cjs, pmm-migrate-v3.cjs/.sh, pmm-verify-assertions.cjs | all MISSING (never part of P1 extraction) |
| misc canary-only checks | plugin-cache-instruction-scan.cjs/.sh, lesson-channel-lint.sh, pmm-write-echo.cjs, agent-model-guard.sh (+.test.sh), workflow-model-guard.sh (+.test.sh), review-gate.sh, review-stamp.sh, pmm-pointer-lint.cjs/.sh | lesson-channel-lint, agent-model-guard, workflow-model-guard, review-gate (diverged), review-stamp (diverged), pointer-lint (diverged → core/pointer-lint.*) present in guards/; the two .test.sh harnesses and plugin-cache-instruction-scan.* MISSING; write-echo diverged → core/write-echo.cjs |

Notes: review-gate.sh / review-stamp.sh / pmm-precommit-gate.sh are wired via git hooks (pre-push / pre-commit), not settings.json. `memory/_local-config/` is a byte-for-byte mirror of guards/ + root pmm-* scripts; guard-canary.sh:223 asserts settings.json hooks match the mirror's; FINGERPRINTS.tsv tracks both copies.

## 2. Path/HOME parameterization

Product repo: single chain env > config.json > default — lib/prelude.sh:16 (`AXMEM_HOME`), :18 (`AXMEM_CONFIG`), :29,31 (`AXMEM_MEMORY_DIR`/`AXMEM_STATE_DIR` via `axmem_cfg` → prelude.cjs get); lib/prelude.cjs:29-31 same chain, :16-27 MSYS path normalization before backslash pass; contract at lib/prelude.sh:3 "NO component may hardcode a user path, repo name, or machine detail"; core/canary.sh:16 uses `$AXMEM_STATE_DIR`; core/fingerprint.sh:15-16 uses `AXMEM_FP_HOME`/`AXMEM_FP_ROSTER` with repo root default.

Live guards (hardcoded or per-component env fallback):
- guards/pmm-trigger-recall.cjs:65 `HOME = process.env.PMM_HOME || 'C:/Users/<user>'`; :66-67 MEM/STATE from HOME + '/.claude/...'; :70 LOG default under MEM/dreams.
- guards/pmm-recall-ledger.cjs:48 `path.join(os.homedir(), '.claude', '.local', 'pmm-recall')`.
- guards/pmm-fade.cjs:11, pmm-manifest.cjs:18, pmm-redundancy-lint.cjs:15 `PMM_MEM_DIR || 'C:/Users/<user>/.claude/memory'`.
- guards/pmm-bash-impression.cjs:704 `CLAUDE_SETTINGS_JSON_OVERRIDE || 'C:/Users/<user>/.claude/settings.json'`; :710,714-715 literal 'C:/Users/<user>/.claude/memory/' and 'C:/Users/<user>/.claude' (scan for .trigger-seen-*).
- guards/pmm-fingerprint.sh:12 `PMM_FP_RECEIPT:-$HOME/.claude/memory/_local-config/pmm-receipt.sh`.
- guards/guard-canary.sh:18-19 STAMP/G under $HOME/.claude; ~15 more $HOME/.claude literals at 79, 200-202, 205, 213, 223, 230-265, 358, 367; :23 `AX=/c/Users/<user>/Desktop/axervice-booking/.claude/worktrees/canary-main` (another repo hardcoded).
- Env names in play (no shared resolver): PMM_HOME, PMM_MEM_DIR, PMM_STATE_FILE, PMM_TRIGGER_MEM, PMM_TRIGGER_STATE, PMM_TRIGGER_LOG, PMM_RECALL_ROOT, PMM_CANONICAL_MEMORY, PMM_PERMANENT_DIR, PMM_FP_RECEIPT, CLAUDE_SETTINGS_JSON_OVERRIDE. Documented cross-run contamination when only PMM_RECALL_ROOT changes: pmm-trigger-recall.cjs:13-29.

Assumptions a port must parameterize: (1) literal username/home fallback; (2) `.claude` segment hardcoded even when HOME is parameterized; (3) settings.json absolute path; (4) a second repo's absolute worktree path in the canary; (5) N independent env names vs the product's one chain.

## 3. Installer wiring vs live hook events

adapters/claude-code/merge-hooks.cjs:22-35 `buildWant()` wires exactly 5 entries (PostToolUse Edit|Write|MultiEdit → core/write-gate.sh --block; PostToolUse Edit|Write|MultiEdit → core/trigger-recall.sh; PostToolUse AskUserQuestion → core/receipt.sh from-hook || exit 0; Stop → core/receipt.sh stop-check; SessionStart → core/receipt.sh session-lamp), idempotent by {event, matcher, command} (:51-81); install.sh:43-47,60 = init → merge-hooks → doctor; settings.json backup at merge-hooks.cjs:153-154, JSON round-trip check :157.

Not wired by the installer but used live: PreToolUse (Agent|Workflow, Agent, Edit|Write|MultiEdit pre-write gate, Bash ×2); PostToolUse Bash; PostToolUseFailure Bash; PostToolUse NotebookEdit; PostToolUse Grep; SessionEnd (ledger flush); SessionStart (8 of 9 missing); UserPromptSubmit; PreCompact. docs/P1-ADAPTERS-SPEC.md:6 confirms install only --claude-code, doctor only CC; :20 decision D6 "CC 补接线" ratified but not delivered.

## 4. selftest / canary / fingerprint conventions

- bin/axmem selftest (bin/axmem:230-381): discovery by content grep `--self-test` under core/ lib/ adapters/ lifecycle/ tests/ (:364-368), 240 s timeout, 3-way PASS/SKIP/FAIL, per-component git-cleanliness diff (:278-363); guards/ and hooks/ deliberately excluded (:243 "D8 legacy / out of P1 scope").
- core/canary.sh: default roster = core/*.sh with `--self-test` (:41-46) + fingerprint check + lesson-class coverage; extension point `config get canary.roster` appends {name, cmd} (:63-72); executed-count asserted against roster length (:12-13, :79-81); stamp at $AXMEM_STATE_DIR/canary-stamp (AXMEM_CANARY_STAMP override) only on all-green.
- core/fingerprint.sh: roster auto-derived by covered() (:18-21) = core/*.sh core/*.cjs lib/*.sh lib/*.cjs bin/axmem relative to AXMEM_FP_HOME; roster file AXMEM_FP_ROSTER (default FINGERPRINTS.tsv at repo root); sole mutation path `fingerprint.sh refresh "<reason>"` which also lands `core/receipt.sh add guard-change` (:66-67). docs/DATA-CONTRACT.md ~:15: roster lives at the code root, not the memory dir.
- Live contrast: guard-canary.sh hand-maintained roster (~150 run lines, :55-300+), covers other repos' itests; docs/PARAMETERIZATION.md:23 and docs/BACKLOG.md Phase 2 item 5 say the pattern ships as a template, the roster is personal.

## 5. CC-related unfinished items

- docs/README.md:56-57 / docs/PARAMETERIZATION.md status: guards/, hooks/, retrieval/ are "legacy extracted references… pending port or retirement".
- docs/BACKLOG.md:8 P1 DoD (parameterization, installer, one-click, four adapters) not closed: CC adapter wires 5/~20 entries.
- docs/BACKLOG.md Phase 2 items 4 (fixture CI matrix) and 5 (canary template + self-test contract) unfinished.
- docs/BACKLOG.md Phase 3 item 6 (ops surface) unfinished; maps to dream/receipts/heat.
- docs/P1-ADAPTERS-SPEC.md:20 D6 "CC 补接线" half delivered (dedup) / half not (wiring).
- README pillar table still cites legacy guards/ hooks/ paths as origin components.
