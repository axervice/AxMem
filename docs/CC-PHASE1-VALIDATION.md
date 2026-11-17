# Claude Code 阶段 1：交付与验证记录

## Prompt 静默：负责人 A 方案（2026-11-16）

负责人裁定：**第一轮试用因 prompt 召回多为无关内容而回滚**；采用 A 方案，没相关匹配时保持安静。背景中的真实记忆测量及离线重放是任务给定结果，本轮没有重新访问或验证真实记忆。下文旧记录中的“Prompt 词法不变”是历史描述，不覆盖本节。

- `core/recall-topic-index.cjs`：按 Segmenter 来源词计支持，过滤跨词片段、泛词、路径 ASCII 和高 df 词；一次性／历史 trigger-none 不参与词法。`loadCorpus` 的条目没有复制 `triggerNone`，因此从已解析的来源 block 按文件及行号取 `triggerNone.reason`；明确 tag 仍通过既有证明路径选择。
- `core/recall-selector.cjs`、`lib/prelude.cjs`：传递 `topic_max_df`（默认 15、整数 1..1000），并校验 `prompt_lexical`（默认 on，只接受 on/off）。
- `adapters/claude-code/hook.cjs`：纯机器包装不触发词法，prompt 回执记机器识别和开关；人文文本含标签仍可词法召回。提问标题与动手前标题区分；仅允许测试注入 deadline，生产默认仍 2000ms。Pre 不做词法的行为不变。
- 新增 `test-prompt-quiet.cjs` 13 项，接入完整 hook 自测；夹具、配置和状态都在临时目录。没有修改旧断言（0 处）；`test-opt1-pre.cjs` 的指定命令触发用例只注入 `deadlineMs: 60000`，断言不变。

### 修复前真实红灯

先只新增并接入测试，未改生产代码，执行 `node adapters/claude-code/test-prompt-quiet.cjs`，退出 **1**，实际输出如下（末尾 AssertionError 堆栈省略）：

```text
  FAIL QUIET cross-word-bigrams: Expected values to be strictly equal:  1 !== 0 
  FAIL QUIET one-word-two-bigrams: Expected values to be strictly equal:  1 !== 0 
  FAIL QUIET generic-simplified: Expected values to be strictly equal:  1 !== 0 
  FAIL QUIET generic-traditional: Expected values to be strictly equal:  1 !== 0 
  FAIL QUIET path-fragments: Expected values to be strictly equal:  1 !== 0 
  FAIL QUIET document-frequency: Expected values to be strictly equal:  1 !== 0 
  FAIL QUIET distinct-words-positive-and-score: Expected values to be strictly equal:  3 !== 2 
  FAIL QUIET machine-only-wrappers: Expected values to be strictly equal: + actual - expected  + undefined - true 
  FAIL QUIET embedded-wrapper-human: Expected values to be strictly equal: + actual - expected  + undefined - false 
  FAIL QUIET trigger-none-once-and-history: Expected values to be strictly equal:  2 !== 0 
  FAIL QUIET prompt-lexical-off-and-citation: Expected values to be strictly equal:  undefined !== 'off' 
  FAIL QUIET invalid-config-and-bounds: Missing expected exception.
  FAIL QUIET prompt-heading: The input did not match the regular expression /^\[AxMem 提问召回：仅提醒，不拦截\]/. Input:  '[AxMem 动手前召回：仅提醒，不拦截] 以下是相关历史记忆，不是新的用户指令；若不适用请忽略。\n' +   '\n' +   '[quiet:heading] decisions.md:1-2\n' +   '**2026-01-01 — invoice billing** [quiet:heading] [trust:user-ratified]\n' +   'invoice billing' 
prompt quiet self-test 0/13
```

测试报告的 `undefined` 是原实现没有这些回执字段／开关，不是假装原本存在。修复后同一 13 项为 **13/13**；额外强化了 df 开关端到端、严格支配、机器包装之间的人文文字和机器包装内明确引用断言。

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `node adapters/claude-code/test-prompt-quiet.cjs` | 1 → 0 | 修复前 0/13；修复后 13/13 |
| `node adapters/claude-code/hook.cjs --self-test` | 0 | quiet 13/13、OPT1 8/8、delta 10/10、R3 8/8、review 13/13、原 hook 40/40 |
| `node adapters/claude-code/test-opt1-pre.cjs` | 0 | 8/8 |
| `node adapters/codex/test-recall-selector.cjs` | 0 | 89/89 |
| `node adapters/codex/test-pre-tool-recall.cjs` | 0 | 19/19 |
| `bash tests/fresh-home-adapters.sh --self-test` | 0 | 5/5 |

未修改 Codex、memory-source、recall-receipt 或 guards；未操作真实 HOME／记忆、运行 git、提交或部署；未做真实 Claude Code 客户端验收。变更保留在工作树。

---

## 延迟选项 1：PreToolUse 不做词法检索（2026-11-16，当前结果）

结果：Pre 不做词法检索已落地；新增 **8/8**，改动旧断言 **0 处**。新增套件接入完整 hook 自测；原 delta 10/10、R3 8/8、review 13/13、hook 40/40 全部原样通过。下文 A1 各节均为历史记录，不覆盖本节策略。

### 原因与实现

按负责人 **2026-11-16** 裁定：**PreToolUse 不做词法（模糊）检索**，只保留显式触发和本 prompt 已选候选。任务提供的真实记忆测量为 772 条，加载／构建 topic index 约 350–410ms，Pre 端到端约 0.8s；不进入索引的无命中 prompt 约 0.34s。这些是裁定背景，不是本轮重新访问真实记忆所得，本轮不宣称真机延迟已验收。

- `core/recall-selector.cjs::selectForEvent` 增加默认 `true` 的 `lexical` 选项；为 `false` 时不 require `recall-topic-index.cjs`、不调用 `selectTopics`、不读／建 topic index。`queryRan` 保持 `false`；action/path trigger、cmd trigger、显式 tag 引用和 task-candidate 逻辑保留。
- `adapters/claude-code/hook.cjs` 只在 Pre 传 `lexical: false`，Prompt 传 `true`，SessionStart 不走动态选择。只有 Pre 的回执各阶段附 `lexical_skipped: true`（包括 disabled／unsupported 路径）。健康记账直接使用 selector 的 `queryRan`，不再把“动作受支持”冒充词法查询；Pre 不增加 `counts.query_ran` 或更新 `lastSuccessfulRecallAt`，送达／错误等其他计数不变。
- 默认最多 3 条、remind-only、正常或降级均不拦截／CLI 退出 0 不变；prompt 候选作用域、正文 hash 验证与 Pre 去重不变。`README.md` 的事件行为同步更新，词法 token 阈值限定于 UserPromptSubmit。

### 新增用例与旧断言清单

新增 `adapters/claude-code/test-opt1-pre.cjs`，8 项全部执行，无 skip：

1. Edit／Write／MultiEdit 的路径与正文存在词法匹配，但无 trigger／候选时不送达、stdout 为空、回执标记跳过、不创建 topic cache。
2. Bash 命令与正文词法匹配但无 trigger／候选时同样不送达。
3. 三种编辑工具显式 path trigger 仍送达，reason=`action-trigger`。
4. Bash 显式 cmd trigger 仍送达，reason=`command-trigger`。
5. Prompt 经词法选中的候选在下一次四种工具 Pre 中均以 `task-candidate` 完整送达。
6. 简单 Bash 命令里的明确 tag 引用仍以 `explicit-tag` 送达。
7. `Module._load` spy＋`selectTopics` 包装器：Prompt 正对照各 1 次；四种工具 Pre 共 0 次加载、0 次调用，模块缓存保持未加载；每轮恢复 spy／缓存。
8. selector 的默认词法行为与 `lexical:false` 的 `queryRan`、hook 传参、健康计数、各阶段回执，以及字段只属于 Pre（含 unsupported／disabled）均精确验证。

**改动的旧断言清单：无（0 处）。** 未发现现有断言依赖 Pre 词法送达，故没有任何“旧断言 → 新断言”的改写。原候选回退、精确触发、重放、跨 repo、actor 隔离等断言逐字保留；`test-hook.cjs` 仅增加新套件调用。

### 修复前真实红灯输出

最初一次新测试夹具校验退出 1，但其中含无效夹具，不能算有效先红证据：使用了错误的 `trigger: none; reason=` 语法、把带连字符的 ASCII 路径误当多 token，以及把带冒号 tag 放在受限 action path 中；另外有两项 `recall-deadline-exceeded`。只修正新增夹具（改用既有 `理由=`、中文多词路径和合法 Bash tag 引用）后，**仍未修改生产代码**，再次运行 `node adapters/claude-code/test-opt1-pre.cjs` 退出 **1**，实际关键输出如下：

```text
OPT1 lexical-path observed [{"tool":"Edit","displayed":1,"reasons":["lexical-topic-support"],"lexical_skipped":null},{"tool":"Write","displayed":1,"reasons":["lexical-topic-support"],"lexical_skipped":null},{"tool":"MultiEdit","displayed":1,"reasons":["lexical-topic-support"],"lexical_skipped":null}]
  FAIL OPT1 lexical-only-path-not-delivered: Expected values to be strictly equal:

1 !== 0

OPT1 lexical-command observed {"displayed":1,"reasons":["lexical-topic-support"],"lexical_skipped":null}
  FAIL OPT1 lexical-only-command-not-delivered: Expected values to be strictly equal:

1 !== 0

  ok   OPT1 explicit-path-triggers-still-delivered
  ok   OPT1 explicit-command-trigger-still-delivered
  ok   OPT1 prompt-candidate-survives-following-pre
  ok   OPT1 explicit-tag-citation-still-delivered
OPT1 topic-index spy observed {"promptLoads":1,"promptCalls":1,"preLoads":4,"preCalls":4}
  FAIL OPT1 pre-never-loads-or-calls-topic-index: Pre must not require recall-topic-index

4 !== 0

  FAIL OPT1 query-ran-and-receipt-event-scope-are-honest: Expected values to be strictly equal:

true !== false

OPT1 Pre no-lexical self-test 4/8
```

这证明指定新例①（路径／命令反例）和④（不加载／调用索引 spy）在修复前确实因目标行为失败，而非夹具错误。修复后同一套有效断言未放宽，最终输出：

```text
OPT1 lexical-path observed [{"tool":"Edit","displayed":0,"reasons":[],"lexical_skipped":true},{"tool":"Write","displayed":0,"reasons":[],"lexical_skipped":true},{"tool":"MultiEdit","displayed":0,"reasons":[],"lexical_skipped":true}]
OPT1 lexical-command observed {"displayed":0,"reasons":[],"lexical_skipped":true}
OPT1 topic-index spy observed {"promptLoads":1,"promptCalls":1,"preLoads":0,"preCalls":0}
OPT1 Pre no-lexical self-test 8/8
```

修复后前两次独立执行新套件分别在路径反例和候选用例触发 `recall-deadline-exceeded`，均退出 1、7/8；没有改 deadline、增加重试或 skip。随后完整 hook 与独立新套件原样重跑均退出 0。此环境仍存在偶发截止超时，不能将最终通过说成从未发生波动。

### 全部允许命令结果

| 命令 | 最终退出码 | 结果／本轮先前退出码 |
|---|---:|---|
| `node adapters/claude-code/hook.cjs --self-test` | 0 | OPT1 8/8 + delta 10/10 + R3 8/8 + review 13/13 + 原 hook 40/40（合计 79/79） |
| `node adapters/claude-code/test-opt1-pre.cjs` | 0 | 8/8；此前依次为 1（夹具校验）、1（有效先红）、1、1（修复后偶发 deadline） |
| `node adapters/claude-code/merge-hooks.cjs --self-test` | 0 | 6/6 |
| `node adapters/codex/test-recall-selector.cjs` | 0 | 89/89 |
| `node adapters/codex/test-pre-tool-recall.cjs` | 0 | 19/19 |
| `node adapters/codex/test-recall-context.cjs` | 0 | 39/39 |
| `node adapters/codex/test-agent-task-context.cjs` | 0 | 34/34 |
| `node adapters/codex/test-action-receipt-integration.cjs` | 0 | 18/18 |
| `bash tests/fresh-home-adapters.sh --self-test` | 0 | 5/5 |

未改 `adapters/codex/*`、`core/memory-source.cjs`、`core/recall-receipt.cjs`，未运行 git、未提交／部署，未读取或写入真实 `~/.claude`／`~/.axmem`、敏感文件或密钥。测试只用隔离临时 memory／repo／state／HOME；未做真实 Claude Code 客户端展示／时序／真实 772 条记忆性能复测。变更留在工作树。

---

## A1 收尾补丁：移除文件 claim（当前结果）

移除文件 claim 退路；claim 不可用时 openStore 抛错，hook 走现有 state-unavailable 可见路径，报告本次失败=1，持久计数未知，不要求回执。POSIX lstat EACCES 计入连续失败，EPERM/EBUSY 仍按竞争；只有该失败路径重试前等待 5ms。清理 stale session 时获取或释放锁遇到 state-claim-unavailable 会跳过该目录并继续。正常取锁不增加 claim I/O 或等待。

先只加入新用例、未修改生产代码，执行 `node adapters/claude-code/test-review-round3.cjs` 退出 1，实际关键输出（测试使用隔离临时目录；release 子例注入主锁 lstat ENOENT 以触发释放时错误）：

```text
A1 R3 stat-denied observed {"attempts":1,"stats":1,"errors":["internal-error"],"stderr":"[AxMem recall: degraded] 召回故障：internal-error；不是“没有匹配”。工作继续（本阶段不拦截）。",...}
  FAIL A1 R3 mkdir-and-lstat-eacces-visible-not-busy: Expected values to be strictly deep-equal:
+   'internal-error'
-   'state-unavailable'
A1 R3 cleanup-denied observed {"phase":"acquire","calls":3,"deniedCalls":3,"errors":[],"maintenance":["session-cleanup-failed"],"remaining":[true,true,true],"stderr":""}
  FAIL A1 R3 session-cleanup-continues-after-claim-denial-acquire: Expected values to be strictly deep-equal:
A1 R3 cleanup-denied observed {"phase":"release","calls":4,"deniedCalls":3,"errors":[],"maintenance":["session-cleanup-failed"],"remaining":[true,true,true],"stderr":""}
  FAIL A1 R3 session-cleanup-continues-after-claim-denial-release: Expected values to be strictly deep-equal:
A1 R3 edge self-test 5/8
```

省略号仅截去该行 stdout 的冗长 JSON；旧实现按 busy 返回后测试上下文没有 runtime resolver，故报 internal-error，而非正确的 state-unavailable。修复后新情形 3/3（两项漏洞，其中清理分别测试 acquire/release）；R3 edge 实际 8/8，delta 10/10，review 13/13，hook 40/40。完整 hook 测试中 8 进程各 240 次：native owned=1/busy=1919/errors={}；注入 Windows 风格错误 owned=18/busy=1902/errors={}。瞬时 EPERM 正常重试；正常取锁 claim mkdir=1、lstat=2、文件 open=0、等待=0，持续故障等待两次各 5ms。

**BACKLOG 已知限制**：persistent write denial + a leftover stale lock is still silent（持续写入被拒且遗留 stale lock 时仍会静默走 busy），本轮未修。极端 claim 过期回收 TOCTOU 和真实客户端显示验收仍未解决；未部署或提交。

| 本轮 allow-cmd | 退出码 |
|---|---:|
| `node adapters/claude-code/hook.cjs --self-test` | 0 |
| `node adapters/claude-code/test-review-round2.cjs` | 0 |
| `node adapters/claude-code/test-review-round3.cjs` | 0 |
| `node adapters/claude-code/merge-hooks.cjs --self-test` | 0 |
| `node adapters/codex/test-recall-selector.cjs` | 0 |
| `node adapters/codex/test-pre-tool-recall.cjs` | 0 |
| `node adapters/codex/test-action-receipt-integration.cjs` | 0 |
| `bash tests/fresh-home-adapters.sh --self-test` | 0 |

下节为上一轮历史记录，文件 claim 已在本轮移除。

## A1 收尾：持久 claim 权限故障（历史记录）

结果：中项已修；两项指定回归 2/2。先只加并接入两项测试，生产代码未改，运行 hook 自测退出 1，真实输出：

```text
A1 R3 persistent observed {"attempts":1,"errors":[],"stderr":"","systemMessage":null,"stateExists":false}
  FAIL A1 delta persistent-claim-access-denied-visible-accounted: Expected values to be strictly deep-equal:
+ actual - expected

+ []
- [
-   'state-unavailable'
- ]
A1 R3 transient observed {"attempts":1,"errors":[],"stderr":"","stateExists":false}
  FAIL A1 delta transient-claim-eperm-retries-and-owns: The expression evaluated to a falsy value:

  assert(attempts >= 2)
A1 delta self-test 8/10
```

修复后 hook 自测退出 0，真实输出（`attempts:3` 中瞬时案例包括释放锁的 mkdir）：

```text
A1 R3 persistent observed {"attempts":3,"errors":["state-unavailable"],"stderr":"[AxMem recall: degraded] 召回故障：state-unavailable；不是“没有匹配”。工作继续（本阶段不拦截）。","systemMessage":"AxMem 召回暂不可用；工作继续。","stateExists":true}
  ok   A1 delta persistent-claim-access-denied-visible-accounted
A1 R3 transient observed {"attempts":3,"errors":[],"stderr":"","stateExists":true}
  ok   A1 delta transient-claim-eperm-retries-and-owns
A1 DELTA CLAIM {"mode":"native","processes":8,"attempts":1920,"owned":1,"busy":1919,"errors":{}}
A1 DELTA CLAIM {"mode":"injected","processes":8,"attempts":1920,"owned":3,"busy":1917,"errors":{}}
A1 delta self-test 10/10
A1 R3 edge self-test 5/5（修正上一轮误写的 4/4；当时共有 5 个案例）
A1 review self-test 13/13
claude-code hook self-test 40/40
```

`core/recall-receipt.cjs`：只在 mkdir 失败分支检查 claim 与主锁；二者均 lstat 确认不存在，才无睡眠立即重试，连续三次 EPERM/EACCES 才判不可用。实体存在、lstat 的 EPERM/EACCES/EBUSY、mkdir 的 EBUSY 均仍按竞争；正常 mkdir 路径没有增加 I/O。若普通文件创建可用，以同一个 claim 路径上的 `wx` 文件作为短暂互斥，再获取原有主锁做降级记账；目录 claim 与文件 claim 互斥，过期文件仅接受已知标记或其写入前缀。`hook.cjs` 使用既有 state-unavailable 的 systemMessage/stderr、回执和健康结算，不阻断操作。回执或 claim 文件也不可写时只能可见提示，持久计数未知。

两项回归除单次 +1 外，还对持续 EACCES 连续调用四次，逐次检查非 busy、有提示、健康计数和回执。补充用例覆盖删除挂起、真实主锁、文件 claim 下的对手竞争与过期恢复、文件 claim 亦不可写、正常取锁无额外 claim I/O。8 进程压测使用真实子进程和临时磁盘，注入轮是模拟 Windows 错误，非宣称全部为原生错误；调度导致 owned/busy 数量会波动。两种短 claim 的过期回收仍有原有的 stat 与删除之间非原子窗口；故障中 claim 无法释放时依然只能依靠有限租约恢复。旧版本进程不认识新文件 claim，混版竞争时可能报 unsafe-lock。未做真实 Claude Code 客户端显示验收。

| 本轮 allow-cmd | 退出码 |
|---|---:|
| `node adapters/claude-code/hook.cjs --self-test` | 0 |
| `node adapters/claude-code/test-review-round2.cjs` | 0 |
| `node adapters/claude-code/test-review-round3.cjs` | 0 |
| `node adapters/claude-code/merge-hooks.cjs --self-test` | 0 |
| `node adapters/codex/test-recall-selector.cjs` | 0 |
| `node adapters/codex/test-pre-tool-recall.cjs` | 0 |
| `node adapters/codex/test-action-receipt-integration.cjs` | 0 |
| `bash tests/fresh-home-adapters.sh --self-test` | 0 |

未运行 git、未提交部署，未读取真实 Claude/AxMem 状态或敏感文件；测试使用临时目录。下文均为历史记录。

---

## A1 第二轮增量审查修复（历史记录）

结果：3/3 中等已修；低项 3/3 已处理（2 项代码修复，1 项按要求说明现状）。
本轮按任务内审查清单实施，未读取树外报告。未运行 git、未提交、未安装到真实环境。
原有 53 个用例保留，新增 `test-review-round2.cjs` 的 8 个用例，总计 61/61；未加 skip 或减少断言。
8 条 allow-cmd 最终均退出 0。

| 问题 | 文件 | 修法 | 用例 |
|---|---|---|---|
| Windows claim 正常竞争被当成状态故障 | `core/recall-receipt.cjs` | 仅对 claim 的 mkdir 将 EPERM/EACCES/EBUSY 视为忙；不冒领、不回收不属于自己的 claim，不增加 degraded | `windows-claim-eight-process-tight-loop`：native / 确定性错误注入两轮，每轮 8 个进程 × 240 次无等待循环 |
| 忙时空 state 丢去重与候选 | 同上 | 忙时有界、只读地读取并校验当前 state；保留 taskId/candidates/seen，坏 JSON、形状错误、超限或读失败才退空；append/save/mark/close 仍无写入 | `busy-readonly-two-process-same-task-action-replay`、`busy-torn-invalid-or-unreadable-state-falls-back` |
| unknown 事件污染宿主枚举 | `adapters/claude-code/hook.cjs` 及两份原测试 | 事件未知时仅顶层 systemMessage，无 hookSpecificOutput；有效三事件的 additionalContext 不变，stderr 继续诊断原因 | `unknown-event-top-level-message-only`，原 stdin 超时／坏输入／超限用例 |
| 清理失败影响本次召回 | `core/recall-receipt.cjs`、`hook.cjs` | 清理 best-effort；失败只记 receipt.maintenance_errors，和 error_codes／健康失败次数分离，Post pointer receipt 同样保留诊断 | `cleanup-failure-receipt-not-recall-failure` 注入 readdir/lstat/unlink 三种失败 |
| session 与缓存 staging 留存 | `core/recall-receipt.cjs` | session 目录纳入 7 天／128 个策略；删除前获取该 session 锁并复核 state 版本，只删已知普通文件，不递归删未知内容；两类 cache staging 同策略 | `session-and-cache-staging-retention`、`session-prune-mkdir-claim-race-retries`、`session-prune-preserves-refreshed-state` |

### ① 修复前红的验证

先仅新增并接线回归、按新要求更新 unknown 协议断言，未改生产实现，运行
`node adapters/claude-code/hook.cjs --self-test` 两次均退出 **1**。
第二次原始输出（为避免错误数组过长，只截短失败文字展示，不截断／改变断言）：

```text
A1 DELTA CLAIM {"processes":8,"attempts":1920,"owned":1,"busy":1497,"errors":{"EPERM":150,"EACCES":137,"EBUSY":135}}
FAIL windows-claim-eight-process-tight-loop: ordinary Windows claim races must not fail openStore
FAIL busy-readonly-two-process-same-task-action-replay: actual null, expected '<已持久化的 task hash>'
FAIL unknown-event-top-level-message-only: actual 多出 hookSpecificOutput.hookEventName='unknown'
FAIL cleanup-failure-receipt-not-recall-failure: actual ['state-unavailable'], expected []
FAIL session-and-cache-staging-retention: maintenance_errors 为 undefined，期望 []
A1 delta self-test 1/6
```

当时的 1 个绿灯是损坏 state 的空快照退路（原本就退空），不能冒充回归全红。
Windows 错误码使用确定性注入，8 个均为真实子进程，共用一个真实磁盘 store；不把注入次数冒充纯原生复现。
之后还给同一争用用例增加了独立 **native 无注入轮**，并补了 session 清理与新开 store 的 ENOENT 竞争、扫描后刷新 state 的保护用例。
后者也先红后绿：未加持锁后版本复核时 hook 自测退出 **1**、增量 **7/8**，
`session-prune-preserves-refreshed-state` 因刚刷新过的 state.json 被删而报 ENOENT；补版本复核后通过。
最终增量 **8/8**，加上一轮 **13/13** 与原始 **40/40**。
最近一次完整 hook 验证中 native 和 injected 均 8 × 240 = 1920 次，errors 均为 `{}`。
争用中 owner/busy 数量随调度波动，本测试不宣称解决锁租约导致的记账覆盖率问题。

并发重放测试先持久化 prompt 与一次完整 Pre，再让真实 holder 子进程持锁、另一个真实子进程同 task/action 重放 12 次。
断言全部 stdout 为空、任务 ID 和候选仍在、原 seen 生效；竞争读取前后逐文件字节不变。
另验证不同 action 仍可经 task-candidate 提醒、已有 Pre marker 继续抑制 Post。
这不是“同 task 的任何新动作都不再提醒”：不同 action／规则新版本仍可再次提醒，保持产品口径。

unknown 断言是随本轮**输出协议需求改变**：原来在 additionalContext 中检查的 stdin 原因改在 stderr 精确检查，
同时新增 systemMessage 精确值、无 hookSpecificOutput 的断言；已识别事件仍精确检查 hookEventName 和 additionalContext。
原因是宿主可能因 unknown 不在枚举中而丢弃整段输出，连顶层 systemMessage 都不展示。

### ② 低项与边界

- 清理失败仅写入 receipt 的 `maintenance_errors`（store/session/cache-cleanup-failed），不成为召回错误或健康失败；
  不写 prompt／命令原文。主状态、ledger 真正读写失败仍按原降级路径处理。
- session 的 7 天／128 个保留策略保护当前 session、任何有 lock/claim 的目录；活动或遗留锁、未知用户文件可使数量暂超上限。
  清理有锁保护，并在持锁后复核扫描时的 state 版本，扫描后刷新过的 session 本轮不删。
  锁释放后只用非递归 rmdir 删除空目录；若新调用已放入 claim/lock，保留该非空目录。
  新 opener 遇到“父目录 mkdir 后被清理、claim mkdir 前消失”的 ENOENT 会重建重试。
- `recall-topic`、`recall-source` 及其 hash 子目录的 staging 纳入同一 7 天／128 个策略；
  不删除完整缓存 JSON，也不遍历符号链接。30 秒内的新鲜 staging 视为潜在活动写入，不为满足数量上限而删除。
  维护失败或活动写入期间允许暂时超额，后续拿到 store 锁时重试。
- **claim 过期回收 TOCTOU 未改**：30 秒超期后仍是 lstat → rmdir；暂停很久的回收者与后继 claim 之间没有原子 compare-and-delete，
  因而极端调度下仍可能删掉后继空 claim。正常持锁／死 pid 回收及 token 不等于证明此窗口已消除。
- **截止时间不含 stdin 等待，未改**：readHookInput 的 1000ms 定时器在 runHandler 之前；2000ms handler 预算从后者开始。
  因此并非端到端 2 秒，名义上可约 1 秒 + 2 秒，另有 Node 启动／调度开销；同步 I/O／事件循环阻塞也不是硬实时取消。
- **只读竞争的固有限制**：只能利用最后已提交的 state 与已有 marker。首次送达尚未提交时的两个并发调用可能都提醒；
  忙路径新送达不持久化 seen/Pre marker，后续 Post 仍可能使用兼容退路。没有声称恰好一次或宿主确认送达。
  本轮修复的是“即使已有已提交状态也全部丢掉”，没有违背忙路径不得写入的要求。

### ③ Codex pin 闭包与最终命令

本轮只改生产文件 `core/recall-receipt.cjs` 与 `adapters/claude-code/hook.cjs`，以及 CC 测试和本文档。
**Codex 14 文件 pin 闭包内没有文件再次改字节**；`core/memory-source.cjs` 与全部 `adapters/codex/*` 未改，
本轮不需要因这些变更重签 manifest；不代表可免除安装时的常规 pin 校验。ACK 仍默认关闭。

| allow-cmd | 最终退出码 | 结果 |
|---|---|---|
| `node adapters/claude-code/hook.cjs --self-test` | 0 | 8/8 + 13/13 + 40/40 |
| `node adapters/claude-code/merge-hooks.cjs --self-test` | 0 | 6/6 |
| `node adapters/codex/test-recall-selector.cjs` | 0 | 89/89 |
| `node adapters/codex/test-recall-context.cjs` | 0 | 39/39 |
| `node adapters/codex/test-pre-tool-recall.cjs` | 0 | 19/19 |
| `node adapters/codex/test-agent-task-context.cjs` | 0 | 34/34 |
| `node adapters/codex/test-action-receipt-integration.cjs` | 0 | 18/18 |
| `bash tests/fresh-home-adapters.sh --self-test` | 0 | 5/5 |

未访问真实 `~/.claude`／`~/.axmem`、敏感文件或密钥；全部测试使用隔离临时目录。
未部署、未做真实客户端显示验收、未跑 allow-cmd 之外的命令，变更留在工作树。
下文为上一轮及原阶段 1 的历史记录，不覆盖本轮状态。

---

## A1 第一轮跨家族审查修复（历史记录）

本轮 2 高 4 中已修复；8 条 allow-cmd 的最终退出码均为 0。变更留在工作树，未提交、未部署。
新增 `adapters/claude-code/test-review.cjs` 的 13 个回归用例接入原 hook 自测；原 40 个用例保留，合计 53/53。
下面的旧阶段 1 记录是历史记录；其中 npm 超时不属于本轮 allow-cmd，不能混同于本轮验收状态。

### 实现

- 高 1：`core/recall-receipt.cjs` 的锁保存 pid、时间戳和随机 token，30 秒租约或 ESRCH 死进程可回收。
  短时 mutation claim 串行化创建／回收／释放，避免两个回收者删掉后继锁；claim 本身也有过期恢复。
  CC 在活锁竞争时使用不落盘的临时 store，继续召回，静默跳过此次记账；不增加 degraded。
- 高 2：`core/memory-source.cjs` 为 CC 增加 state 下按文件缓存的解析结果，校验 mtime、size、ctime、dev、ino 和解析器版本。
  命中不读源正文；失效只读该文件一次。阶段间用元数据复核代替重复全量读取。
  `core/recall-source-proof.cjs` 在同一解析快照上完成边界／替代链证明；
  `core/recall-topic-index.cjs` 缓存 MiniSearch 索引和 token 集，复用成熟分词／主题与严格支持集合支配策略。
  `core/recall-selector.cjs` 和 hook 在文件、证明、检索、渲染、最终复核等阶段之间检查 2000ms 截止。
  receipt 保留原阶段顺序，但将追加合批并将 state 持久化从三次降为两次。
- 中 3：故障 JSON 增加短 `systemMessage`（“AxMem 召回暂不可用；工作继续。”），保留 additionalContext 和 stderr，始终只提醒不拦截。
- 中 4：Prompt／Pre 无命中、重放抑制、未知或不支持动作时 stdout 为空，连空 JSON 都不发；
  来源诊断只保留在 receipt，管道／shell 包装器原因保留在 `action_reason`，不再每次提醒。
  SessionStart 的来源／健康心跳和 Kernel 口径保留。
- 中 5：每个 session/actor store 打开时清理旧 invocation、pre/post 和 staging 文件，保留不超过 128 个，超过 7 天删除；
  预留本次 ledger 和 Pre marker 的名额。`state.json` 超过 256KiB 时在锁内重建，不无限轮换。
- 中 6：stdin 超时／超限从已收到的有界前缀识别顶层 `hook_event_name`；无法识别明确写 `unknown`，不猜 PreToolUse。
  嵌套 tool_input 和 prompt 内的伪事件不作为证据；错误原因单独记录为 stdin-timeout / stdin-too-large。

本轮修改／新增：`adapters/claude-code/{hook,test-hook,test-review}.cjs`、
`core/{memory-source,recall-selector,recall-receipt,recall-source-proof,recall-topic-index}.cjs` 和本文档。
`core/recall-health.cjs` 以及全部 `adapters/codex/*` 均未改。

### 计时（合成夹具，不读取真实记忆）

同一 `node adapters/claude-code/hook.cjs --self-test` 的 `A1 BENCH`，临时 HOME／memory／state，
主语料 987,549 字节（181 条合成决策，另两份必需文件各 11 字节）。
用 performance.now 包围 spawnSync，运行 4 个全新 hook CLI 进程；第 1 次为首建，其余 3 次取中位数。

| 实现 | CLI 四次耗时 ms | 后三次中位数 ms |
|---|---|---|
| 修复前（13 个回归全部红时实测） | 376.2 / 303.9 / 324.1 / 397.5 | 324.1 |
| 修复后（最终一轮） | 294.4 / 166.6 / 168.4 / 165.8 | 166.6 |

热调用约 0.17 秒，相比同夹具基线下降约 48.6%；不把首建或 Node 启动成本隐去。
另一个全新进程的 A1 PROFILE：require 22.82ms、source 28.81ms、select 25.42ms、总计 104.90ms（不含外部 spawn 开销）。
首建仍需解析／建索引／原子写缓存，最终一次为 294.4ms；不声称任意机器、任意冷调用都小于 100ms。

### 先红后绿证据

先只新增测试并接线，未改生产实现，运行 hook 自测退出 1，明确报告 `A1 review self-test 0/13`；
逐项失败见下表。随后修实现，最终为 13/13，加原 40/40。
没有 skip／豁免、没有删用例或减少断言；原先要求把 unknown／来源诊断写进 context 的断言，
改为对 receipt 对应字段的精确断言，并增加 stdout/context 为空断言，以验证新的产品口径，而不是取消诊断验证。

| 新用例名 | 未修复时的红灯证据 |
|---|---|
| live-lock-two-processes | 一个真实子进程持锁，另一真实 hook CLI 报 state-unavailable／stderr 非空，而不是继续正常召回 |
| stale-lock-dead-pid | 已退出子进程的 pid 留锁，errors 为 state-unavailable |
| stale-lock-expired | 活 pid＋两分钟前时间戳留锁，errors 为 state-unavailable |
| no-match-empty-output | context 仍是“本地查询完成…”；现在同时断言未尝试输出 |
| pipeline-empty-output | stdout 仍含 unknown／unsupported-shell-syntax 状态文字 |
| source-diagnostics-receipt-only | context 仍含 unverified-index-redirect |
| failure-system-message | systemMessage 为 undefined |
| state-file-retention | 180 个 pre marker 未清理，超过 128 文件上限 |
| oversize-state-rebuild | 超过 256KiB 的 state 导致 state-unavailable，不能恢复 |
| stdin-timeout-event-and-unknown | 不关闭 stdin 的真实进程超时，事件错误成为 PreToolUse |
| stdin-limit-event | 带 SessionStart 前缀的超限输入错误成为 PreToolUse |
| deadline-stops-before-selection | source 阶段后虚拟时钟超过 2100ms，selector 仍被调用 |
| mtime-size-cache-and-one-read | 热调用读源 9 次，而不是 0；修复后另验证变更文件只读 1 次且正文更新 |

### 最终命令与 Codex 兼容

Codex 仍调用默认无缓存的 readSources/sameSources，保持逐字节读取／hash／只读行为；
CC 的缓存写入依赖延迟加载，不扩大 Codex 实际加载的 14 文件 pin 闭包。
Codex 导出、citation-only 自动策略、默认关闭 ACK 都未改。

| allow-cmd | 最终退出码 | 结果 |
|---|---|---|
| `node adapters/claude-code/hook.cjs --self-test` | 0 | A1 13/13 ＋ 原 40/40 |
| `node adapters/claude-code/merge-hooks.cjs --self-test` | 0 | 6/6 |
| `node adapters/codex/test-recall-selector.cjs` | 0 | 89/89 |
| `node adapters/codex/test-recall-context.cjs` | 0 | 39/39 |
| `node adapters/codex/test-pre-tool-recall.cjs` | 0 | 19/19 |
| `node adapters/codex/test-agent-task-context.cjs` | 0 | 34/34 |
| `node adapters/codex/test-action-receipt-integration.cjs` | 0 | 18/18 |
| `bash tests/fresh-home-adapters.sh --self-test` | 0 | 5/5 |

本轮没有待决定的产品选项。未运行不在 allow-cmd 中的 npm 全量自测、未操作真实 HOME／settings／记忆、
未做客户端实机验收或部署，也未发起 git 命令或提交。stdout 已损坏或输出后才发现持久化失败时，
单次 JSON 协议无法补写另一个 systemMessage，仍通过 stderr 报告；不冒充宿主已确认展示。

---

## 原阶段 1 历史记录

### 状态

阶段 1 代码与目标回归已落在工作树，未提交、未安装到真实环境；**尚不满足“全部允许命令退出 0”的完整验收条件**。
唯一未取得 0 的命令是 `npm run selftest`：最近一次全量尝试输出
`45 passed / 4 skipped / 0 failed (of 49 components)`，调度器记录耗时 848s，
但函数工具报告 `exit code 1 (killed: 10 minute timeout)`。不能把内部零失败冒充整条命令通过。
最后一轮代码修改后，下面 8 条目标命令全部重新取得 0；没有再次重跑已知会超出外层上限的全量套件。

## 目标命令结果

| 命令 | 结果 |
|---|---|
| `node adapters/codex/test-recall-selector.cjs` | 0，89/89 |
| `node adapters/codex/test-recall-context.cjs` | 0，39/39；明确 citation-only 策略仍在 |
| `node adapters/codex/test-pre-tool-recall.cjs` | 0，19/19 |
| `node adapters/codex/test-agent-task-context.cjs` | 0，34/34 |
| `node adapters/codex/test-action-receipt-integration.cjs` | 0，18/18；默认关闭、pin 失配拒绝测试保留 |
| `node adapters/claude-code/merge-hooks.cjs --self-test` | 0，6/6；验证全部 8 条 wanted 身份 |
| `bash tests/fresh-home-adapters.sh --self-test` | 0，5/5 |
| `node adapters/claude-code/hook.cjs --self-test` | 0，40/40 |
| `npm run selftest` | 外层超时，不能记通过；内部最近一次为 45 passed / 4 skipped / 0 failed |

全量套件的 4 个 SKIP 组件分别涉及临时隔离环境中不存在的用户配置基线、
缺失的 ignored Go AST helper 和 generated parser helper；没有为本次交付伪造这些依赖。
本次没有运行发布链、真实 installer、真实 settings 合并、真实记忆迁移或客户端。
允许自测内部原有的临时仓库／只读 git 检查保持原样，未直接发起 git 命令或提交操作。

首次全量尝试还暴露并修正了三项测试入口问题：

- discovery 不再把 `tests/fixtures` 中的部分 legacy 脚本数据当可执行自测；拥有这些语料的 P2 套件仍执行。
- 环境隔离负例仅允许原 selector 给子进程设置隔离 XDG 目录的那一条精确字面量，其他 XDG_CONFIG_HOME 引用仍报错。
- fail-closed 自测复制真实 dispatcher 到已有的微型 scheduler 夹具验证隔离，不再递归启动全仓自测。

ACK 集成测试原有的固定逻辑源码 hash 在 CRLF checkout 下失败；改为 LF 逻辑身份断言，
同时保留 manifest 对**原始文件字节**的精确 pin 校验。没有改 gate/state 实现或启用 ACK。

## 文件职责

### 新增

- `adapters/claude-code/hook.cjs`：有界 stdin、三事件翻译、整条预算、Kernel、任务候选、一次 JSON 输出、异常可见与健康结算。
- `adapters/claude-code/test-hook.cjs`：40 个合成场景及共享模块小型组件自测，所有写入在临时 HOME／memory／state／settings 内。
- `core/memory-source.cjs`：共享有界本地来源读取、一致性／hash、成熟纯解析器投影、局部隔离。
- `core/recall-selector.cjs`：CC 事件策略，将精确动作、引用、保守词法和任务候选组合；复用原成熟排名函数，不复制第二套算法。
- `core/recall-receipt.cjs`：独立 JSONL schema、完整身份 hash、状态锁、prepared/emitted、同动作版本标记、Post 指针回执与结果关联。
- `core/recall-health.cjs`：基础计数、最近成功查询、连续失败；不是独立停摆巡检。
- 本文档：验收状态、用例与未完成项。

### 修改

- `adapters/claude-code/merge-hooks.cjs`：原 5 条边界保留，增加 3 条接线；自测隔离 HOME。
- `lib/prelude.cjs`：`~`／MSYS／相对配置路径、最长合法 repo 根、新 hook 严格配置诊断。
- `axmem.config.example.json`：提醒模式、不可用继续、数量／字节／主题证据阈值、Kernel 发送者／预算。
- `core/trigger-recall.cjs`：保留旧 Post 选择／seen 策略，仅补同动作 Pre 去重、故障提示及 pointer-only 回执。
- `adapters/codex/recall-selector.cjs`：共用 source IO，保留 public API；增加非枚举的内部排名桥。
  阶段 1 没有把整个排名实现物理搬迁，避免冒充阶段 2 的全面核心收敛。
- `adapters/codex/action-receipt-opt-in.cjs`：候选闭包增加实际 source 依赖，13 → 14，仍默认关闭。
- `adapters/codex/test-action-receipt-integration.cjs`：对应闭包、CRLF/LF 身份断言、失败诊断。
- `bin/axmem`：自测发现排除语料数据目录，输出全套耗时；未扩展 doctor、搜索或巡检能力。
- `tests/fresh-home-adapters.sh`：完整 HOME 隔离，使用导出的 merge policy 合成 settings，不执行 installer CLI。
- `tests/isolation-real-configs.sh`：同样使用导出 policy，不调用非 self-test 的 merge CLI。
- `tests/inherit-real-env-arms.sh`、`tests/selftest-fail-closed.sh`：上述两项小型隔离自测修正。
- `adapters/claude-code/README.md`、`adapters/codex/README.md`、`README.md`、`README.zh.md`、
  `docs/DATA-CONTRACT.md`：能力、配置、独立回执 schema、读写契约差异与验证边界。

## 三类新增事件的用例清单

| 事件 | 正常 | 边界 | 故障／反例 |
|---|---|---|---|
| SessionStart | 来源状态＋完整 Kernel | resume/compact 新 epoch；无 Kernel／external 唯一发送者；相对配置根不落 tool cwd | 必需源缺失、坏配置、状态不可写都明确 degraded，工作继续 |
| UserPromptSubmit | 大白话找到 trigger-none 决策；无任何 trigger 注释的 standing 规则也可独立找到 | “继续”／空泛词不推；旧 tag 到真实 live head；Index-only 跳转不冒充证明；歧义分量隔离；无 prompt 原文落盘 | 索引抛错不是 no-match；全部超预算为 omitted；选择期间来源变化不发旧正文 |
| PreToolUse | Edit/Write/MultiEdit 各有精确 trigger 正例；Bash 简单命令正例；已建立任务候选可兜底 | 四分支各有不相关／跨 repo 非命中；prompt 已推不压掉 Pre；同 action 重投抑制，新 action 可重推；actor 隔离，actor 缺失不跨调用共享候选 | Edit/Write/MultiEdit 缺 path；Bash 管道／包装 shell／缺 command 显式 unknown；stdout 失败只有 prepared、没有 emitted；状态写失败可见且一次失败计数 |

额外改动的 Post：无 Pre 时保留旧标题退路并记 pointer-only；同动作已有完整 Pre 不双推且关联结果；
来源缺失／结果台账不可写可见；JSON 键顺序变化不破坏动作关联；来源正文版本变了可以再提醒。
另测了精确最终 stdout hash／字节与阶段顺序、坏／超长 stdin 退出 0。

## 真实部署只需描述的 settings 改动

保持已有 write-gate、Post trigger、AskUserQuestion、Stop、session-lamp；新增：

1. `hooks.SessionStart` 无 matcher 的 command hook。
2. `hooks.UserPromptSubmit` 无 matcher 的 command hook。
3. `hooks.PreToolUse` matcher 为 `Edit|Write|MultiEdit|Bash` 的 command hook。

三者 command 均为 `node "<绝对 AxMem 根>/adapters/claude-code/hook.cjs"`。
还需确认配置的 memory/state、仓库 roots，并在 AxMem／外部 PMM 之间选唯一 Kernel 发送者。
这里没有执行这些部署动作；不要删用户 hook 或把 receipt session-lamp 当作新召回 hook。

## 未完成、未知与范围边界

- 未达到全量命令退出 0：需要更长外层执行上限重跑 npm，不能靠降低测试范围解决。
- **未在真实 Claude Code 客户端验证**：指定版本的 3 个真实小任务、Pre 在工具前显示、
  additionalContext 实际显示、agent_id/tool_use_id 字段可用性、Kernel 唯一部署和延迟均待验收。
- 未取得真实 47 条／常用 10 条数据，未做其适用性覆盖清单或真实效果判断。
- 默认 3 条、4 KiB、两个主题 token 是保守初值，未作真机噪声／预算调优。
- 身份／工具 ID 缺失时宁可不共享候选、不猜动作关联；可能降低覆盖或保留旧 Post 提醒，明确标 unknown。
- 磁盘完全不可写时无法保证持久失败计数；输出后才发现补记失败只能 stderr 报告，宿主呈现未真机验证。
- 未做阶段 2–5 的纪律核心整合、通用 shell 写目标识别、复发判断／报表、独立巡检、物理入口合并、
  lifecycle 多目标卸载修复、主动搜索入口或指纹刷新。没有新增闸、网络依赖、daemon 或向量平台。
