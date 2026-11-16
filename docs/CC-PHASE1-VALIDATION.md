# Claude Code 阶段 1：交付与验证记录

## 状态

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
