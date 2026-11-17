# AxMem product backlog

Source: codex blind review 2026-09-13 (`review-20260913T040320Z`) §4, fused
with the extraction ledger. Order = priority.

## Phase 1 — parameterization + installer + one-click + multi-agent (Jax 2026-09-13 拍板;09-13 复确认「P1包括參數化+安裝器」)

> P1 的完成定义:①参数化(下文 1,零硬编码残留)②安装器(下文 2,单命令生命周期)
> ③一键部署 ④四适配层(下文 0)。四者缺一不算 P1 收口。

0. **Adapter architecture (new, ratified)**: one governance core, N thin adapters —
   Claude Code (native hooks, reference impl), codex CLI (AGENTS.md + CODEX_HOME
   conventions), Hermes-style agents (MEMORY.md/SOUL.md conventions), generic
   (any file-based memory dir + CLI invocation). Core never imports adapter code.
   One-click: single installer script per platform, idempotent, doctor-verified.
1. Clean product boundary: shared prelude (`AXMEM_HOME`/`AXMEM_MEMORY_DIR`),
   `axmem.config.json`, zero personal residue (run opensource-sanitizer before
   any visibility change).
2. Single-command lifecycle: `install / init / doctor / upgrade / uninstall /
   restore` across Windows (git-bash), macOS, Linux; detect Claude Code
   version, git, optional semantic backend, hook conflicts.
3. Versioned data contract: schema version for entry / index / archive /
   supersedes / stamp; dry-run migration + backup + rollback + import/export.

## Phase 2 — trust at scale
4. Fixture CI matrix: fictional user, temp git remote, temp home; three
   platforms × line-endings × non-English entries × offline × dual-machine
   divergence × plugin-absent × hook-timeout × restore drill.
5. Canary template + self-test contract: every shipped guard proves red AND
   green in CI; a guard without a self-test cannot enter the roster.

## Phase 3 — explainability & launch
6. Ops surface (CLI/TUI): what was injected this session, why each item hit,
   token cost, pending dream proposals, canary freshness, cross-machine sync
   state.
7. Public regression set measuring the actual promise ("does a known error
   recur?"), not LoCoMo-style QA recall.
8. Security defaults: dedicated data dir (never git-init HOME), remote sync
   off by default, secrets via OS keychain, retrieved content injected as
   data-not-instructions, isolated review queue for any automated write.

## Claude Code phase-1 trial carry-overs (2026-11-16; evidence in `D:/AI/axervice-booking-archive/axmem/` subdirectories)
Not in this round; status lives in `C:/Users/jax-x/Desktop/AxMem-trees/STATUS.md`.
- **Bash pre-action triggers nearly idle (A4)**: the whitelist only covers ~1.2% of real Bash calls (3 of 254); relaxing to quoted args + `cd && one command` only gets 5.1%; 67% contain pipes/redirects/multiple segments. Fix: per-segment bash parse to get each segment's executable + skip git global options (`-C <dir>`/`-c k=v`). Pre-file-edit path triggers are unaffected. (`opt1-cost/bash-shape*.cjs`)
- **Prompt recall semantic rerank (A4)**: lexical rules alone can't reach "hit ≥75% and false positives ≤10%" (control set: current 7/13 hit, 2/20 false positive); prompts with embedded operating instructions or that talk about AxMem itself still slip through. Switch: `recall.prompt_lexical`. (`recall-quality/`)
- **Why the noise pair got matched widely**: in the pre-option-1 replay, `xiaod:api-migration` and `process:session-scratchpad-is-wiped-on-reboot` were pushed to dozens of unrelated commands; the prompt side still uses lexical search, so the retrieval-side cause needs follow-up.
  - Related cause, verified for the 7 irrelevant items among the "13 dropped" (Booking review notes under `.codex-reviews/execution-officer-*/units/*.md`, not `docs/*`): **not path triggers**. All 3 entries hit are `trigger: none`. The replay sample records only the file path, so the hits came from pre-action lexical search tokenizing path fragments (`execution-officer`, `units`, `r1`/`r2`/`r9`, `spec`, `fix`, `amend`) against entries that mention `SQ-ALIGN R2/R5`. Option 1 (no lexical search before actions) already removes this path. The prompt side drops path-derived ASCII terms since ruling A. (`opt1-cost/lost13.cjs`)
- **13 dropped pre-action items after option 1**: 2 relevant (`cold-email:warmup-cap`←`send_emails.py`, `cao-pipeline:whatsapp-dialog-blocks-send`←`cao_pipeline.py`), 2 weakly relevant, 9 irrelevant. The 2 relevant ones can be recovered by giving their memory entries path triggers (memory-store governance, the lead's call).
- **`OPT1 explicit-command-trigger-still-delivered` wall-clock sensitive**: now injectable via `deps.deadlineMs` (639f707); real hardware under high load may still exceed 2 seconds on a single recall (trial red line; daily report "over 2 seconds").
- **`cleanSessions`' `continue` in finally swallows exceptions from the try block** (only when release also reports `ENOENT`/`state-claim-unavailable`): record it first, then decide.
- **Persistent write denial + a leftover stale lock is still silent**: while a lock exists it is treated as busy, so expiry is never evaluated.
- **Pre-action reminder cooldown per (session, file, entry)**: current dedup key (`adapters/claude-code/hook.cjs:220-222`) = task + context epoch + event + action_id + tag + text hash, and action_id is derived from the tool input hash, so every Edit with different content is a new action and gets the same reminder again. Trial numbers: one Booking session got the same reminder 8 times on one file (`scripts/itest-noshow-v2.ts`) within 10 minutes; dedup hits over the whole trial = 0. Default proposal: within one session, send each entry once per file; send again only for a different file. **This changes what the user sees; Jax approved it on 2026-11-17: once per file per session is enough, because more becomes noise the agent learns to ignore.** Scheduling is the lead's call. (`trial-monitor/top3-repeat.cjs`, `top3-ids.cjs`)
- **ax-api receipts don't record cache hits**: use `node D:/AI/pmm-work/cache-ledger.cjs <run dir>` to recompute from the transcript instead.

## Non-goals (empirically closed)
- Autonomous memory rewriting / reflection loops (confabulation; killed by audit).
- Agent-decides-what-to-remember discovery (90% FP; killed).
- Knowledge-graph store as source of truth (judgment metadata rots; wiki-links
  + supersedes chains carry the relations that matter).

- [ ] **常驻规则横幅产品评测（Jax 裁决 2026-09-30）**：「横幅可做产品规则,前提是先证明有效;有效性由受控评测给出(BE-1:每提示横幅 / 仅会话起始 / 无横幅三臂,确定性评分,预登记通过线);未证明前不入产品规则」。P2.0 对 pmm-banner 的量尺排除不作为产品删除依据。
- **2026-09-30 R14 — Codex raw prompt capture撤除**：Jax裁定不再永久保存原始提示词明文；AxMem记忆只保留简洁、精准的意思。已安装hook由一次性uninstall清理，真实Codex主目录与本机原文库由主审执行迁移。
