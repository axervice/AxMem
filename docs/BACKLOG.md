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

## Non-goals (empirically closed)
- Autonomous memory rewriting / reflection loops (confabulation; killed by audit).
- Agent-decides-what-to-remember discovery (90% FP; killed).
- Knowledge-graph store as source of truth (judgment metadata rots; wiki-links
  + supersedes chains carry the relations that matter).
- **2026-09-30 R14 — Codex raw prompt capture撤除**：Jax裁定不再永久保存原始提示词明文；AxMem记忆只保留简洁、精准的意思。已安装hook由一次性uninstall清理，真实Codex主目录与本机原文库由主审执行迁移。
