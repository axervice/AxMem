# AxMem — Attention Guardrails for Claude Code

**The same mistake never happens twice. Not because the agent remembers better, but because a machine stops it.**

A memory layer for AI coding agents (Claude Code first) that pulls the agent's attention back with hooks, not prose. Zero runtime dependencies. Local-first, git-auditable. Built to be the cheapest memory layer in tokens.

[English](#english) · [中文](#中文)

---

## English

### Why this exists

We did not set out to build a "bionic memory", a "reflection engine" or a system that "distills wisdom". We set out to fix one boring, expensive problem we kept hitting in months of daily Claude Code use:

> **Over a long session, and across sessions, the agent's attention drifts.** The rule is in its memory file. It has even read the rule. It still repeats the mistake, because at the moment the tool call happens, the rule is not where its attention is.

Writing more memory does not fix this. A bigger always-on context makes it worse: the important rule gets buried in the pile, and every turn pays for the pile.

So AxMem does the opposite. It keeps the always-on layer thin and puts **machines** at the exact moment the agent is about to act:

- **A lesson is a gate, not a note.** A hook denies the tool call that would repeat a recorded mistake. The agent does not have to remember the rule; it cannot pass the gate.
- **Recall is keyed on the action, not on similarity.** A trigger pushes only the matching lesson, only when the agent touches the matching file path or tool.
- **Every push leaves a receipt.** A ledger records which lesson was pushed, to which session, triggered by what. When a mistake recurs anyway, you can prove whether the rule ever reached the agent, instead of guessing. (That is how we found, in our own use, a rule that had been pushed to subagents 46 times and to the main session zero times. The fix was a new trigger, not more prose.)
- **A canary proves every guard is alive.** A dead guard is worse than no guard, because it reads as coverage.
- **Lints keep the memory file from rotting.** Dangling pointers, duplicate entries, oversized entries and stale counts are caught by a pre-commit gate, not by a human noticing months later.

That is the whole idea. It is deliberately unglamorous.

### Thin is a constraint, not an adjective

The always-on layer stays small because the pre-commit gate refuses commits that break these limits:

| What | Cap | Enforced by |
|---|---|---|
| One memory entry | 900 bytes | entry-length watch (a longer entry must be a pointer to its full record) |
| The active-work dashboard | 3,000 bytes | entry-length watch |
| Session-start injection (all memory files combined) | 50,000-token warning threshold | size watch |

A pushed lesson therefore costs the agent at most a few hundred tokens, and a denied tool call costs zero.

### The pragmatist's position on tokens

Every mechanism above is chosen to cost as few tokens as possible:

| Where other systems spend tokens | What AxMem does instead |
|---|---|
| Inject a large memory context every turn | Inject a thin kernel; everything else is pushed on demand by file/tool triggers |
| Ask the model to "reflect" and rewrite its memory | Deterministic lints and gates; the model is never asked to judge what a script can count |
| Semantic retrieval over the whole corpus on every prompt | Exact trigger match on the file path and tool of the current action |
| Trust that a written rule will be followed | Deny the tool call; zero tokens spent re-explaining the rule |

We have not run a formal head-to-head benchmark against other memory products, so read this as a design position rather than a measured ranking: **AxMem is built so that enforcement never costs model tokens, and recall costs tokens only for the one lesson that matches the current action.**

### What the gates can and cannot catch

Be clear about the boundary. A gate catches mistakes that have a *shape*: a file path, a tool, a command form, a redirect that is missing. Those are the mistakes that recur most, and they are the ones a script can decide with certainty. Judgment mistakes (a wrong design call, a misread requirement) have no shape; for those AxMem gives you the receipt ledger and the lints, and you still need a reviewer. Machines count well and judge poorly, and AxMem never asks a machine to judge.

### What you get (free tier, this repo)

- **Write gate** — a Claude Code hook that blocks edits and shell commands that would repeat a recorded lesson.
- **Trigger recall** — file-path and tool-keyed push of the matching lesson into the agent's context, with a receipt ledger of every push.
- **Canary** — self-registering health check across every guard, with an executed-count assertion; goes red when a guard silently dies.
- **Pre-commit gate + lints** — pointer lint, redundancy lint, entry-length and size caps, fingerprint drift detection for your memory files.
- **Isolation gate** — a shell-AST based guard (vendored `unbash`) that stops self-tests and probes from ever touching your real home directory.
- **Lifecycle** — `install`, `doctor`, `backup`, `restore` (crash-consistent two-phase swap), `upgrade`, `uninstall`.
- **Adapters** — Claude Code (primary), Hermes, Codex, and a generic instruction-file adapter.
- **Self-tests everywhere** — every component ships its own red/green self-test; `npm run selftest` discovers and runs all of them in an isolated HOME.

Everything is plain Node.js and bash. No database, no service, no API key. Your memory stays in Markdown files in your own git repo.

### What is paid (AxMem Pro, not in this repo)

The free tier is a complete, usable system on its own. AxMem Pro is an **upgrade of the same installation**, for people who want the guards to improve themselves from evidence:

- **Causal shadow memory** — a graph over your memory entries (supersession, cause/follow links, identity) that records what a future guard *would* have done on every edit, without blocking anything.
- **Shadow comparator and replay** — validate a guard or policy change against your real recorded history across five judgment dimensions (including whether a pushed lesson was actually heeded) before it goes live.
- **Fused retrieval with scored baselines** — exact + semantic search with a reproducible corpus for tuning recall precision.

Paid users get the full system through a private channel; the free tier contains none of the paid code. Interested? Open an issue.

---

## 中文

**同一个错误不会犯第二次。不是因为 agent 记得更牢,而是因为有机器拦着。**

给 AI 编程 agent(Claude Code 优先)的记忆层:用 hook 而不是文字把 agent 的注意力抓回来。零运行时依赖。本地优先,git 可审计。设计目标是 token 花得最少的记忆层。

### 为什么做这个

我们没打算做「仿生记忆」「反思引擎」或者「沉淀智慧」之类高大上的东西。我们要解决的是几个月每天用 Claude Code 反复踩到的一个又土又贵的问题:

> **会话拉长、跨会话之后,agent 的注意力会偏移。** 规则明明写在记忆文件里,它甚至已经读过,到了真正调用工具的那一刻还是会犯同一个错——因为那一刻规则不在它的注意力上。

多写记忆解决不了这个问题。把常驻上下文越堆越大只会更糟:重要规则被埋在一堆文字里,而每一轮都要为这一堆付 token。

所以 AxMem 反着来:常驻层保持很薄,把**机器**放在 agent 即将动手的那一刻:

- **教训是闸,不是笔记。** hook 直接拒绝会重犯已记录错误的工具调用。agent 不需要记住规则,它过不去这道闸。
- **召回按动作匹配,不按相似度。** 触发器只在 agent 碰到对应文件路径或工具时,只推送对应的那一条教训。
- **每次推送都留回执。** 台账记录推了哪条教训、推给哪个会话、由什么触发。错误还是重犯时,你能证明规则到底有没有送到 agent 面前,而不是猜。(我们自己就靠它查出一条规则推给子代理 46 次、推给主会话 0 次;修法是加一个触发器,不是再写一段文字。)
- **金丝雀证明每个守卫都活着。** 死掉的守卫比没有守卫更糟,因为它看起来像有覆盖。
- **lint 防止记忆文件腐烂。** 悬空指针、重复条目、超长条目、过期计数,由提交前闸门当场抓住,而不是几个月后靠人发现。

就这么多。它刻意不炫。

### 「薄」是约束,不是形容词

常驻层之所以小,是因为提交前闸门会拒绝突破这些上限的提交:

| 对象 | 上限 | 谁在执行 |
|---|---|---|
| 单条记忆条目 | 900 字节 | 条目长度监视(更长的必须降成指向完整记录的指针) |
| 进行中工作仪表盘 | 3,000 字节 | 条目长度监视 |
| 会话启动总注入量(全部记忆文件合计) | 50,000 token 预警线 | 体积监视 |

所以一次推送最多让 agent 花几百个 token,一次拒绝花零个。

### 实用派的 token 立场

上面每一个机制都是按「尽量少花 token」选的:

| 别家系统把 token 花在哪 | AxMem 怎么做 |
|---|---|
| 每轮注入一大块记忆上下文 | 只注入很薄的内核,其余按文件/工具触发按需推送 |
| 让模型「反思」并重写自己的记忆 | 确定性的 lint 和闸门;能用脚本数清楚的事绝不让模型去判断 |
| 每条提示都对全部语料做语义检索 | 对当前动作的文件路径和工具做精确触发匹配 |
| 相信写下的规则会被遵守 | 直接拒绝工具调用;不花一个 token 再解释规则 |

我们没有和其他记忆产品做过正式的一对一基准测试,所以请把这句话当成设计立场而不是测出来的排名:**AxMem 的设计目标是执行规则永远不花模型 token,召回只为匹配当前动作的那一条教训花 token。**

### 闸能拦什么,不能拦什么

边界说清楚。闸拦的是**有形状**的错:文件路径、工具、命令形态、漏掉的重定向。这类错重犯最多,也是脚本能百分之百判定的。判断类的错(设计选错、需求看错)没有形状;对这类错 AxMem 给你回执台账和 lint,但你仍然需要审查者。机器擅长数数、不擅长判断,AxMem 从不让机器去判断。

### 免费层包含什么(就是这个仓库)

- **写入闸**:Claude Code hook,拦下会重犯已记录教训的编辑和 shell 命令。
- **触发召回**:按文件路径和工具把匹配的教训推入 agent 上下文,每次推送都进回执台账。
- **金丝雀**:覆盖全部守卫的自注册健康检查,带执行计数断言;守卫悄悄死掉时变红。
- **提交前闸门 + lint**:指针 lint、冗余 lint、条目长度与体积上限、记忆文件指纹漂移检测。
- **隔离闸**:基于 shell 语法树(内置 `unbash`)的守卫,保证自测和探针永远碰不到你真实的 home 目录。
- **生命周期**:`install`、`doctor`、`backup`、`restore`(崩溃一致的两阶段切换)、`upgrade`、`uninstall`。
- **适配器**:Claude Code(主)、Hermes、Codex,以及通用的指令文件适配器。
- **处处自测**:每个组件自带红/绿自测;`npm run selftest` 在隔离 HOME 下自动发现并跑完全部。

全部是纯 Node.js 和 bash。没有数据库、没有服务、不要 API key。你的记忆就是你自己 git 仓库里的 Markdown 文件。

### 什么是付费的(AxMem Pro,不在本仓库)

免费层本身就是一套完整可用的系统。AxMem Pro 是**同一套安装的升级**,给想让守卫「拿证据自我改进」的人:

- **因果影子记忆**:在记忆条目之上建图(取代、因果、同一性),记录未来的守卫在每次编辑时「本会」怎么做,但不拦任何东西。
- **影子对照器与回放**:守卫或策略改动上线前,先按五个判断维度(包括推送的教训有没有真被听进去)对照你真实的历史记录做验证。
- **融合检索与评分基线**:精确 + 语义检索,带可复现的语料基线,用来调召回精度。

付费用户通过私有渠道拿到完整系统;免费层不包含任何付费代码。有兴趣请开 issue。

---

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
               tree — see "What is paid" above.

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

`guards/` is legacy/reference: it is not wired into `bin/axmem`, and each
file's own `--self-test` still runs standalone (`node guards/<file>.cjs
--self-test` / `bash guards/<file>.sh --self-test`).

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
