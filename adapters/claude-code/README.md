# Claude Code adapter — phase 1: pre-action recall

本阶段只增加**提醒、送达回执和基础健康计数**，不新增任何拦截。现有写后纪律闸、
AskUserQuestion 收据、Stop 检查、SessionStart 待沉淀灯保留；后者不是召回健康灯。
Codex 的 UserPromptSubmit 仍然仅召回明确 tag 引用，未改成自动词法召回。

## 接线（这里只描述，安装须另行批准）

`merge-hooks.cjs::buildWant()` 现在声明 8 条精确身份：原来的 5 条，加上：

| settings.hooks 事件 | matcher | command |
|---|---|---|
| SessionStart | 无 | `node "<绝对 AxMem 根>/adapters/claude-code/hook.cjs"` |
| UserPromptSubmit | 无 | 同上 |
| PreToolUse | `Edit\|Write\|MultiEdit\|Bash` | 同上 |

command 依赖 PATH 上的 Node；输出沿用本仓库的
`{hookSpecificOutput:{hookEventName,additionalContext}}` 协议。
这三条均不输出 `permissionDecision` / `deny`，内部错误可见告警后退出 0。
不要删用户／外部插件 hook，不要把 `receipt.sh session-lamp` 当成新健康 hook。
原 PostToolUse `trigger-recall.sh` 的 command 和逻辑边界保留，只加同动作兼容去重。
接线按完整 `{event, matcher, normalized_command}` 去重；`verifyWiring()` 验证全部 8 条各有一份。
此阶段不做旧安装记录合并、多项卸载修复或入口物理合并。

真实接入还需确认：AxMem 配置指向正确的 memory/state，`repos[].roots` 对应真实仓库；
上述 settings 项接好，**新会话**中验证顺序与显示。存在 PMM 等 Kernel 注入器时，必须
在下述配置里选择唯一发送者。这里没有执行真实安装、修改用户 settings 或主目录。

## 事件行为

- **SessionStart**：显示来源是否可读、条目数、当前作用域上次成功查询时间和连续失败数。
  来源有效时只额外发送 standinginstructions 的明确 `### Kernel` 段；缺失、空段、
  歧义或超预算显式说明，不把其他条目自动提升成 Kernel。Kernel 的身份是
  `section-declared`：证明来自该段，不伪造单条用户批准／阅读证明。
  startup/resume/compact 都建立新 epoch，允许重新发送。
- **UserPromptSubmit**：本地 MiniSearch 检索 decisions、lessons、standinginstructions 的 live 条目。
  词法支持按不同来源词计数：跨词中文二元片段、泛词、路径中的 ASCII 片段和高文档频率词不计；默认至少两个不同词才提醒。
  `trigger: none; 理由=一次性…/历史…` 的条目不参与词法检索，其他 trigger-none 仍可检索。
  纯 task-notification、cross-session-message、system-reminder 包装消息不触发词法检索；夹有人写文字则照常检索。
  `prompt_lexical` 可设 `off` 停用 prompt 词法；`topic_max_df` 控制词项的最大文档频率。
  明确 tag 引用不受这些静默规则限制，可沿真实 Supersedes 边跳到 live head；Index 箭头不当作边的证明。
  回执记录 `prompt_machine_only` 和 `prompt_lexical`。prompt 原文只在进程内使用；状态仅保留任务 hash、候选 tag／正文 hash。
- **PreToolUse**：只考虑明确工具／repo／路径的 action trigger、简单命令的 cmd trigger、明确 tag 引用和本 prompt 已建立的任务候选。
  **不做词法（模糊）检索，不加载／构建 topic index**，不凭路径／命令的主题相似度推送记忆；UserPromptSubmit 的词法检索另按上述静默规则执行。
  这是为降低逐次动手前延迟，按负责人 2026-11-16 的裁定实施；仅 Pre 回执记录 `lexical_skipped: true`，不计为已运行词法查询。
  prompt 已推不等于 Pre 免推；同一动作的同版本重复 Pre 可以抑制。
  Edit/Write/MultiEdit 额外按 session/actor、context epoch、规范化绝对文件路径和条目正文版本去重：完整送达后同文件不重复提醒，跨 prompt 保留；正文变化或 SessionStart（含 compact）可再推，最多保留最近 500 个键。Bash 仍只按动作去重。
  Edit、Write、MultiEdit 支持单个 file_path；相对路径必须有 cwd，路径别名不冒充已证明的仓库目标。
  Bash 只识别**裸可执行名＋简单字面参数**，可匹配成熟解析器的 cmd trigger；
  引号、管道、重定向、变量展开、包装 shell、cwd 复合语法均报告 unknown，
  **不把它们猜成文件写入**。未接 NotebookEdit、子代理事件、PreCompact 或 SessionEnd。
- **PostToolUse 兼容**：同一 session/actor/tool_use_id、相同规范化工具输入、来源文件版本的
  Pre 完整正文已经成功输出且 emitted 已落盘时，旧 Post 不再重复该 tag（含 link/class 顺带项）。
  没有 tool_use_id、没有完整 Pre、来源已变或 Pre 只有 prepared 时不猜测，保留旧 Post 退路。
  有关联时追加 `observed-unverified` 结果行；这是观察到 Post，不是判定复发或执行成功。
  无 Pre 的旧标题退路也补 prepared/emitted 回执，明确 `pointer-only`、完整展示数为 0；
  不把标题包装成完整正文送达。旧 Post 主选择／seen 策略没有在本阶段重写。

## 配置

在 AxMem `config.json` 的 `adapters.claude_code` 下（完整样例见根配置示例）：

```json
{
  "enabled": true,
  "settings_json": "~/.claude/settings.json",
  "recall": {
    "mode": "remind-only",
    "on_unavailable": "warn-and-continue",
    "max_items": 3,
    "max_bytes": 4096,
    "min_topic_terms": 2,
    "prompt_lexical": "on",
    "topic_max_df": 15,
    "kernel_sender": "axmem",
    "kernel_max_bytes": 4096
  }
}
```

动态最多 3 条，可下调；UserPromptSubmit 默认至少两个不同来源词支撑词法提醒，明确引用／精确 trigger 不受此阈值限制。
`prompt_lexical` 默认 `on`，可设 `off`；`topic_max_df` 默认 15，允许 1..1000 的整数。无效值按配置故障提示。
分数记录为来源词支撑数，不冒充语义概率。预算按 UTF-8 additionalContext 字节计，整条放不下
就标 omitted 并给定位，不截掉例外／否定后当完整送达。Kernel 独立预算，超限告警。
`kernel_sender` 可为 `axmem`、`external`、`off`；后两者不由本 hook 发送 Kernel。
`mode` / `on_unavailable` 显式记录产品策略；阶段 1 只接受上述提醒／继续组合，其他值会可见降级，绝不借此启用新闸。

`lib/prelude.cjs::resolveRuntimeConfig()` 严格报告配置错误，解析 env > config > 默认路径；
展开 `~`、MSYS 路径；配置内相对路径相对于 config 所在目录。
repo 按最长合法根匹配，并保留 `.claude/worktrees/<name>/` 相对路径归一化。
不按 basename 猜 repo，不自动迁移／改写用户记忆。

## 回执与健康

新的追加 JSONL 位于 `AXMEM_STATE_DIR/recall/<machine+session+actor 的 SHA256>/<invocation UUID>.jsonl`，
和 `receipt.sh` 的待沉淀 TSV 完全分开。schema 为 `axmem.cc.recall.v1`，不修改 Codex exactKeys v1。
关联字段、选择原因／score／trigger ID、来源定位／trust／正文和文件 hash、完整／省略状态、
stdout 结果、耗时、错误码均入账；未实现的 rule/predicate/outcome/incident/label 留 null/unknown，
不编造违规判断。`payload_hash/bytes` 绑定最终 stdout JSON（含换行）；
`context_hash/context_bytes` 单独绑定 additionalContext；不保存 prompt／命令原文或整条正文。

新 hook 状态顺序为 received → source-ready → selected → prepared → emitted，再追加结算。
旧 Post 标题兼容层只补 prepared/emitted 传输阶段，未冒充已重构完整事件流水线。
**只有 stdout 成功写出完整正文才算最低限度送达**；prepared 孤儿、omitted、旧 Post 标题不算完整送达。
`hostConfirmed` 永远 unknown，不代表客户端／模型已阅读、理解、服从。
stdout 和磁盘不能原子提交；输出后补记失败会走 stderr 告警，不能事后修改已经输出的 JSON。

每个作用域的 `state.json` 有 received/completed/source_ok/query_ran/matched/emitted/omitted/errors、
最近开始／结束、`lastSuccessfulRecallAt`、`lastDeliveryAt`、`consecutiveFailures`。
正常零匹配也是成功完成查询，不是服务 down。一次调用多个错误只增加一次连续失败数。
缺 session 不落入共享 nosess 桶；actor 缺失标 null/unknown，**不跨调用复用任务候选**；
tool_use_id 的动作关联仍可使用。子代理继承关系未验证，不宣称主代理送达等于子代理送达。

状态锁忙、状态损坏／不可写、来源不可读／变化、索引失败、全部超预算都显式降级。
磁盘完全不可写时，只能当前通道提示“本次失败=1，持久计数未知”，不能保证磁盘计数。
异常终止留下的 lock 不自动偷锁；需人工确认该 hook 已不运行再清除。
此阶段没有日志轮换、独立巡检、停摆通知、复发报表或 doctor 策略升级。
**所有 hook 被宿主禁用时，hook 自己无法报告自己没有收到事件。**

## 验证边界

`node adapters/claude-code/hook.cjs --self-test`：临时 HOME／记忆／state／settings，含 prompt 静默回归及原有 hook 场景；
共享模块各有小型组件自测，由现有 `bin/axmem selftest` 发现。
覆盖三个新增事件、Edit/Write/MultiEdit/Bash 正／反／故障分支、Post 兼容、完整预算、
索引失败、来源变化、身份隔离、stdout 失败、状态失败、精确 payload 回执等。

**未在真实 Claude Code 客户端验证。** input 的 agent_id、tool_use_id 可用性、各事件
additionalContext 的实际显示／时序、Kernel 的真实部署唯一性、2 秒本地处理预算及
3 个真实小任务仍需指定版本客户端验收；synthetic 测试不冒充真机证据。
