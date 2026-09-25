# AxMem P2 spec v1.1:「Claude Code 完美」—— 产品仓与活体同源,一键部署得到升级后的完整系统

状态:**v1.1(2026-09-17 18:30,主脑按 codex 审 spec `review-20260917T220642Z` 9H/2M 全部收入;判定 GO-WITH-CHANGES → 本版为可开工版)**。裁定依据:PMM decisions `[axmem:adapter-priority-cc-then-codex-then-hermes]`(Jax 2026-09-17:CC 完美 → codex → Hermes/其它)。

**分层说明(2026-09-24 Jax 裁决)**:本 spec 的产品本体 = 私仓 AxMem-dev 的完整系统。公开仓 axervice/AxMem 只承载免费层(由 publish.manifest.json 导出);§P2.1 提到的因果记忆核心簇等高级组件仍按本 spec 移植进产品本体,但归付费层,付费用户通过付费渠道把已安装的 AxMem 升级为完整系统。免费层代码不包含付费层代码。

**开工前置(硬门)**:活体正在跑 fab 盲攻 + codex 终审(Jax 2026-09-17 指令),其修复落地并冻结后才生成 §1.0 的冻结清单;冻结清单不存在,P2.1 不得开工。

## 0. 事实基线
见 `docs/audits/SURVEY-2026-09-17-live-vs-product.md`(file:line 齐全)。要点:活体 09-13 起的全部升级(管道闸 v2 + 解析器 + 台账 v3 + 验收 runner + 4 artifact、召回 M0–M3 工具、写时 trigger 闸 + glob、C0 工具、现版 canary/fingerprint/manifest)产品仓一件未同步;产品仓 `guards/ hooks/ retrieval/` 是 legacy 引用且刻意不在 selftest/fingerprint/canary 覆盖面;产品仓已有唯一路径解析链 `lib/prelude.*`(只认 `AXMEM_*`);活体守卫各自定义 `PMM_*` 回落并写死 `C:/Users/<user>`、`.claude` 段;安装器只接 5/≈20 条 hook。

## 1. 目标与完成定义(全部机器谓词)
**目标**:产品仓成为记忆升级本体的唯一源码;干净机器上 `install.sh --claude-code` 得到的行为与**冻结清单所标识的活体**逐事件等价;活体随后切换为从安装产物运行,可一步回滚。

### 1.0 冻结清单(codex H1;P2.0 产物,机器可读 `docs/freeze/FREEZE-<date>.json`)
- 源仓 commit + `.claude` tree OID;未提交改动的 patch bundle SHA256(要求为空,即冻结必须是干净提交);每个源文件 SHA256;**每条 settings.json hook 命令**与**每个守卫文件**的处置:`port | replace(由产品既有实现替代) | external-prerequisite | private-exclude`;依赖闭包(require/source/vendor/fixtures/specs/pins);hook 顺序(事件 → group → hook 的数组序);允许差异清单(逐条附理由)。
- 差分验收器 `bin/axmem equiv`:在隔离 HOME 里,对同一组 hook 事件夹具(每类事件 ≥3 例,含 Bash/Edit/Write/SessionStart/SessionEnd/UserPromptSubmit/PreCompact)分别驱动冻结实现与安装产物,比较**退出码、stdout、stderr、规范化后的状态树(台账/回执/trigger 状态,去时间戳与路径前缀)**;差异必须落在允许差异清单内,否则红。**没有冻结清单与差分报告,禁止宣称 functionally equivalent。**

### 1.1 DoD(逐条谓词)
1. **零硬编码(带 allowlist)**:对 `core/ lib/ adapters/ lifecycle/ tests/ bin/` 跑 `bin/axmem lint-hardcode`:模式 `C:/Users`、`jax-x`、`Desktop/`、`/\.claude/`;命中必须全部在 `docs/HARDCODE-ALLOWLIST.json`(逐条:文件、行、理由——例如 CC 适配器的默认 settings 路径 `$HOME/.claude/settings.json` 是合法适配器默认值),未登记命中 = 红。
2. **同源 + 三重覆盖**:冻结清单里处置为 `port|replace` 的每个组件都在 **组件注册表** `docs/COMPONENTS.json` 中(见 §3.1),注册表被 selftest、fingerprint、canary 三个工具共同消费;`bin/axmem selftest --strict` 结果 **FAIL=0 且 SKIP=0**(严格模式为 DoD 口径);fingerprint `check` 覆盖注册表全部路径及其 pins/fixtures;canary 通用名册 = 注册表中声明 `canaryCommand` 的全部项,执行数 == 名册数。
3. **验收 runner 可移植**:`core/acceptance/` 含 runner、**4 个 artifact(null / always / blind-parser 三个计分变异轮 + di-intervene 注入辅助体)**、契约、conformance 夹具、pins;`bin/axmem accept` 在临时 HOME 对安装产物跑:主跑 scored 全绿(基线 = 冻结版 158/158)、三个计分轮 `sets_equal/sentinel_ok/probe_ok` 全 true;pins 在 P2.2 合入后**重新生成**并与安装产物 blob 一致。
4. **接线完整且可逆**:hook 清单为层级结构(§3.3);`merge-hooks` 一次事务写入;`doctor` 断言清单(§3.3);`uninstall` 在「安装后未被用户改动」时恢复**原始字节**(preimage),否则整体拒绝并保持文件不变(不承诺同时保留用户改动与字节一致)。
5. **端到端行为证明(两层)**:(a) 确定性 hook 协议测试 `tests/e2e-hook-protocol.sh`:临时 HOME,按 Claude Code hook JSON 协议喂事件——Edit 命中 trigger 的文件 ⇒ stdout 含**该教训的标题行 + tag**(活体只注入标题与搜索命令,不注入全文,断言按此);Bash `cmd | tail -3` ⇒ 台账出现 B 行且 mode=shadow;写入缺 trigger 的条目 ⇒ 被拒且 stderr 含诊断前缀;SessionEnd ⇒ flush;**持久遥测**(`telemetry/trigger-log-*.tsv`)落 memory 目录、**本地状态**(台账/回执/trigger 状态)落 `AXMEM_STATE_DIR`,两者按 DATA-CONTRACT 各自断言;真实 `~/.claude` 与 `~/.claude/.local` 前后 hash 相同。(b) 真实 Claude Code 烟测:指定版本(当前 2.1.271)在临时 HOME 启动一次会话跑 3 条命令,核对台账行;记录版本号,版本变更即重跑。
6. **切换与回滚(单事务 + 干跑)**:`bin/axmem cutover --dry-run` 打印 §3.6 全部项;`--apply` 只在 Opus GO + Jax 拍板后执行;`--rollback` 后 settings.json 字节、guards 目录逐文件 SHA、fingerprint/canary 结果与切换前相同。

## 2. 非目标
codex 适配深化;Hermes 桥接器(标实验性);C0 `--apply`;dream/heat 产品化 UI;三平台(macOS/Linux)验收——**P2 的「完美」只指 Windows 上的 Claude Code**,三平台列为发布门待办(BACKLOG),不默认满足。

## 3. 设计
### 3.1 组件注册表与落点(codex H4/H5)
- `docs/COMPONENTS.json`:每项 `{id, path, kind: gate|hook|tool|lib|acceptance|fixture, selftestCommand|null, fingerprint: true, canaryCommand|null, origin: {liveFile, liveSha256}, disposition, notes}`;selftest 不再按内容 grep `--self-test`,只跑注册表的 `selftestCommand`;fingerprint 递归覆盖注册路径及 pins/fixtures;canary 通用名册来自注册表。
- 落点:守卫与工具 → `core/`;runner/变异体/契约/夹具/pins → `core/acceptance/`;文件名去 `pmm-` 前缀(产品命名),`origin.liveFile` 记录对应活体文件。
- **同名/同职责裁决规则**:冻结活体决定 CC 行为;已批准的产品数据/CLI/生命周期契约决定包装;职责不同则改名并存;职责相同禁止双份。逐项裁决表(冻结清单必须包含并附差分测试):
  | 冲突 | 裁决 |
  |---|---|
  | `core/write-gate.sh`(写后完整性)vs 活体 `pmm-trigger-write-gate.*`(PreToolUse 预测闸) | 职责不同,并存;后者命名 `trigger-write-gate.*` |
  | `core/trigger-recall.cjs` | 活体匹配/glob/redirect/ledger/policy 语义胜;产品文件名/prelude/CLI/数据契约胜;最终唯一 |
  | `core/receipt.sh` + `receipt-fromhook.cjs` | 产品版为基线(已参数化、可选非阻断接口);只移植差分证明为 CC 必需的活体行为;单一实现 |
  | `core/fade.cjs` | 活体为等价 oracle,产品 resolver/目标文件名为落地基线;逐项裁决 git 根/热度目录/pending 语义 |
  | `core/manifest.cjs` | 活体 fence/glob/cmd trigger/B32 解析语义胜;产品文件名/prelude/输出契约胜;最终唯一 |

### 3.2 参数化(codex H3)
- 共享 `lib/prelude.*` **只接受 `AXMEM_*`**;最终 resolver API:`home()`, `memoryDir()`, `stateDir()`, `recallRoot()`(= `stateDir()/recall`), `triggerStateDir()`(= `stateDir()/trigger`), `settingsJson()`(= `AXMEM_CLAUDE_SETTINGS` 或 `$HOME/.claude/settings.json`),均返回规范化绝对路径(MSYS 规范化沿用 `prelude.cjs:16-27`;空/空白回落默认,规则搬自活体 `pmm-recall-ledger.cjs:64`)。
- 移植代码与自测**一次性改名**到 `AXMEM_*`;**不做** `PMM_*`→`AXMEM_*` 的共享映射。切换期若需兼容,只在 `adapters/claude-code/legacy-env-shim.sh` 里翻译一个**封闭名单**(逐个变量写明语义:`PMM_RECALL_ROOT`→`AXMEM_RECALL_ROOT`、`PMM_TRIGGER_STATE`→`AXMEM_TRIGGER_STATE_DIR`、`PMM_MEM_DIR`→`AXMEM_MEMORY_DIR`;`PMM_HOME`/`PMM_STATE_FILE`/`PMM_CANONICAL_MEMORY`/`PMM_PERMANENT_DIR` 语义不同,**不映射**,出现即报错),旧值与新值并存时**报冲突退出**,P2 完成前删除 shim。
- 活体还有 impression/git/host/labeler/tag 等 env 入口:冻结清单逐个登记并在 P2.1 归入 resolver 或删除。

### 3.3 hook 清单、事务安装与 doctor(codex H6/H7/H10)
- `adapters/claude-code/hooks.manifest.json` 镜像真实层级:`{events: {<Event>: [{matcher: <精确字符串>|null(表示省略字段), hooks: [{command, timeout?, id}]}]}}`;数组顺序即执行顺序(Bash 事件里 pipe gate 必须先于 impression);AxMem 管理块整体插在每个事件的**首部**,用户 group/hook 相对顺序不变;`doctor` 断言 AxMem hook 构成清单顺序的唯一子序列。
- 每条清单命令在冻结清单里都有处置与实现落点;安装前做依赖闭包检查(命令目标存在、可执行、依赖 vendor/fixtures 在场);`external-prerequisite`(例如 PMM plugin 2.7 的 session-start/should-save、autopull 的网络 pull/push、permanent 注入)必须:产品内实现、或声明为可选依赖并由 doctor 做版本/路径检查、或书面排出等价范围;网络与 git 操作必须有离线 E2E 夹具。
- 安装/卸载为**整文件单事务**:写前保存内容寻址的原始字节(preimage)到 lifecycle 目录;全部 hook 一次 merge、一次原子替换(临时文件 + rename)、一次 lifecycle 记录(pre/post hash + preimage 路径);卸载:当前 hash == 安装后 hash ⇒ 原子恢复 preimage;否则拒绝并保持不变。
- `doctor` 至少断言:settings 可解析;清单 schema/ID/顺序唯一;每个 managed hook 恰好一次且 matcher/group/顺序/命令/失败策略精确一致;无指向旧根的 stale hook;用户自有 hook 可存在且相对顺序未变;命令解析到当前安装根且目标存在可执行;settings 路径与 prelude 解析一致;lifecycle preimage 存在且 hash 匹配;错误分 missing / duplicate / stale / misordered / modified-after-install。

### 3.4 批次(codex M8:改为串行 A→B,共享文件唯一所有者)
- **P2.0 冻结**(Sonnet,活体审计收口后):生成冻结清单 + `bin/axmem equiv` 骨架(夹具集与差分器,先对「冻结活体 vs 冻结活体」跑出全等作为自证)。
- **P2.1 地基**(Sonnet A):prelude 扩展(resolver API)、注册表、三工具改读注册表、lint-hardcode、legacy shim;移植 ledger/policy/classify/trigger-glob/pmm-core/manifest/fingerprint/canary/receipt/fade/trigger-write-gate/trigger-recall 与召回 M1–M3 工具;严格 selftest 全绿。**落固定 commit 后**才开 P2.2。
- **P2.2 管道闸 + 验收**(Sonnet B,基于 P2.1 的固定 commit):闸、解析器(+conformance)、impression、runner + 4 artifact + 契约 + pins → `core/acceptance/`;`bin/axmem accept`。合入后**重新生成 pins**、跑组合验收,单设 integration commit。
- **P2.3 接线 + 端到端 + 切换**(Sonnet C):hooks.manifest、事务安装/卸载/doctor、`tests/e2e-hook-protocol.sh`、真实 CC 烟测、`cutover --dry-run/--apply/--rollback`。
- 共享文件唯一所有者矩阵(写进冻结清单):`lib/prelude.*`、`bin/axmem`、`core/canary.sh`、`core/fingerprint.sh`、注册表、DATA-CONTRACT/PARAMETERIZATION 文档 → P2.1 所有;`core/acceptance/**`、pins → P2.2;`adapters/claude-code/**`、`lifecycle/**`、`tests/e2e-*` → P2.3。

### 3.5 验收
每批:严格 selftest FAIL=0/SKIP=0 + lint-hardcode 绿 + 指纹刷新 + 通用 canary N/N;P2.2 另加 accept 主跑 + 三计分轮;P2.3 另加 e2e 两层 + cutover 干跑;每批 Opus 增量核冻结版;codex 在 P2.3 后攒一波审全批。`equiv` 差分报告是 P2 收口的必要产物。

### 3.6 切换(codex H9)
- 活体 59 项 canary 逐项处置表(迁入通用 / 留活体私有 wrapper / 排除);产品通用 canary 报 N/N,活体私有 wrapper 报 M/M,**不再把排除后的产品 canary 称为 59/59**。
- 旧 `~/.claude/guards` 与 `_local-config` 镜像**不在切换事务中删除**:先冻结为只读回滚包(目录 SHA 清单 + tar),从活动名册迁出;家仓 git `pre-commit`/`post-commit` 钩子的目标改指安装产物(切换事务的一部分,含回滚)。
- `cutover --dry-run` 必须打印:冻结源 commit/tree/patch hash 与产品版本;解析后的 HOME/config/memory/state/settings 路径;settings 每个 hook 的前后序号、matcher、命令与不动的用户项;每个将写/移文件的前后 SHA256、preimage 位置、回滚命令;活体与产品 fingerprint 名册数量/hash/差异;通用/私有 canary 预期数量与命令;镜像处置及对现有 canary 的影响;家仓 git 根/分支/dirty/ahead-behind/origin 及每个 git hook 的解析目标;严格 selftest、accept、e2e 结果与真实生产台账前后 hash;回滚前置条件与一次模拟回滚的字节/hash 相等结果;现存 Claude 会话是否需重启(实测:hook 改动对已开会话即时生效,2026-09-17 证据见活体 CHANGELOG)。

## 4. 风险与未决
- R1 活体审计(fab/codex)可能再改活体 ⇒ 冻结推迟;冻结前不开工(硬门)。
- R2 `pmm-bash-impression.cjs:704-715` 直接扫 `~/.claude`:改为 `triggerStateDir()`。
- R3 Windows/MSYS 路径:临时 HOME 同时设 `HOME`/`USERPROFILE`;`os.homedir()` 只能经 resolver 使用。
- R4 legacy shim 若残留会再分叉:P2 完成前删除,写进 BACKLOG 与冻结清单。
- 未决 Q1:C0 迁移工具(`pmm-core*`, `pmm-migrate-v3*`, `pmm-verify-assertions`)是否进 P2.1(建议:进,标 shadow-only,不接 hook)。Q2:`guard-canary.sh` 中 axervice/夜巡行的归宿(建议:私有 wrapper)。

## 5. 派发与时长自估
P2.0 半天(含 equiv 自证);P2.1 一天(单 Sonnet);P2.2 半天(基于固定 commit);P2.3 一天;Opus 四次增量核;codex 一波。总计约 3 个工作日(v1 估 1.5 天,因串行化与冻结/差分新增而加倍)。

## 6. 借用来源(Jax 2026-09-17 铁律「基建先抄开源再优化」;依据 `docs/audits/OSS-CANDIDATES-2026-09-17.md`,codex 审 spec 时核此节)
| 用途 | 来源(版本 · 许可证) | 落点 | 用法 |
|---|---|---|---|
| 解析器差分对照物(仅测试) | un-ts/sh-syntax 0.6.0(MIT,包 mvdan/sh BSD-3)· tree-sitter-bash v0.25.1 wasm(MIT)· vorpaljs/bash-parser 0.5.0(MIT) | `tests/oracles/`(devDependency + wasm 夹具) | P2.2:`core/acceptance` 新增差分自检:113 例 conformance 夹具与三对照物比较管道/重定向/heredoc 结构,差异逐条归类(允许/缺陷);不替换解析器 1.2 |
| 检索 v2 排序 | lucaong/minisearch 7.2.0(MIT,零依赖) | `vendor/minisearch/` + `core/retrieval-bm25.cjs` 包装 | v3 C0.5 交付物 6(`pmm-search-v2`):BM25+ 打分,精确命中置顶与字段权重按 FINAL-SPEC §3.2 在包装层实现 |
| 原子写 settings.json | npm/write-file-atomic `writeFileAtomicSync`(ISC,≈90 行) | `lib/atomic-write.cjs` | P2.3:`merge-hooks.cjs:153-156` 的非原子写改用它;`lifecycle/install-manifest.cjs`、`restore.cjs` 已有 temp+rename,统一到同一实现 |
| 路径包含判定 | domenic/path-is-inside 1.0.2(MIT/WTFPL,Windows 大小写折叠) | `lib/path-is-inside.cjs` | P2.1 resolver 与写时闸共用;活体 HIGH-2 修复已先行 vendor 到 `~/.claude/guards/vendor/` |
| `\?\`/`\.\` 前缀 | jonschlinkert/normalize-path 3.0.0 的 3 行(MIT) | 内联 `lib/msys-path.cjs`,带来源注释 | 同上 |
| Wilson 下界 | msn0/wilson-score-interval(MIT,1 函数) | `lib/wilson-score.cjs` | P2.1 移植 precision 时替换自写实现,自测对拍旧值 |
| 不借用(理由) | proper-lockfile(本仓 lock.cjs 已处理 Windows EPERM)· 各 Claude Code hook 安装器(弱于本仓身份去重)· Graphiti/cognee/mem0/letta(仅设计先例,双时态边模型)· 组件注册表先例(git t/、bats-core、Taskfile、just 仅参考) | — | — |
每个 vendor 文件头必须写来源 URL、pin 的版本/commit、许可证;`docs/THIRD-PARTY.md` 汇总;指纹册覆盖 `vendor/**`。
