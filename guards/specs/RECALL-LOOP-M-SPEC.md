# spec 草稿:召回侧闭环 · 阶段 M(度量先行)—— **待 the maintainer 拍板,未审未建**

仓库根 `C:/Users/<user>`,代码在 `.claude/guards/`。本 spec 建在**当前语料格式**上,不依赖 C1 迁移。
拍板后走完整流水线:codex 审 spec → Sonnet 建 → 确定性门 → 并行审码 → 主会话复验 → 记账。

## 为什么是这个,为什么先度量

记忆系统的目标是让 Agent **想起并因此不再犯**。核实到的回路现状(`pmm-trigger-recall.cjs`):只注标题不注「怎么做」(:4);
每事件 ≤3 且任意序(:214);只对 `kind==='path'` 动作、从不看 Bash 命令(:134-141);`trigger-log` 只记注入/压制,
**没有一条记录「注入之后是否真的避免了复发」**;试点止损判据(≥30 标注样本、精确率 <80% 砍,:10)从未评估。
本会话就是反证:管道错误在教训已入库且被注入过的前提下仍犯 5 次。

**v3 spec §3 :103 自己规定**:cmd 触发先只记 impression 不注入,取得 ≥200 条 Bash 事件误报基线后才启用注入。
所以第一阶段不加任何注入——先把「回路是否闭合」变成可测的数。**在测出来之前,任何「召回更好了」都是自述。**

## M1 · Bash 事件 impression 台账(零注入)
- 新增 PreToolUse(Bash)钩子 `pmm-bash-impression.cjs`:读 hook JSON 的 `tool_input.command`,按 v3 §3 :98 切段
  (未引号的 `;`/`&&`/`||`/`|`/换行;剥 `VAR=val`/`sudo`/`timeout N`/`env`/`command`/`nohup`;`bash -c`/`sh -c` 递归一层;
  exe = 首 token basename 小写去 `.exe`;sub = 首个不以 `-` 起的后续 token;引号不平衡/heredoc 失败 ⇒ matched=0)。
- 用**现役** `core.classifyTriggerLine` 收集语料里 `kind==='cmd'` 的触发(语法已在 `pmm-core.cjs:284-289`,不新写解析器),
  按「exe 相等 ∧ (无 sub ∨ sub 相等)」匹配。
- **只写台账,不输出任何 additionalContext,exit 0。** 行格式沿用 v3 §3 :100:
  `ts sid impression-id trigger-id repo cmd-sha tag source position`,命令文本**只记 sha256**。
  写本机未跟踪文件(P24 口径),不入库。
- 自测:≥6 条命令切段用例(含 `&&` 链、`sudo`、`timeout`、`bash -c` 嵌套、引号不平衡)+ 匹配/不匹配各 ≥3 例;
  **断言钩子 stdout 为空**(零注入是本阶段的硬约束,自测必须锁住它)。

## M2 · 标注与精确率
- `pmm-recall-label.sh <impression-id> useful|noise [备注]`:追加标注行到本机文件。主会话/the maintainer 在回合里觉得某次
  召回相关或吵,一条命令标注。
- `pmm-recall-precision.cjs --report`:按 trigger、按 class 汇总曝光数、标注数、useful 精确率、每千回合噪音行;
  套用 :10/:102 的止损判据输出 **UNKNOWN / KEEP / 降级议案**,未标注 = UNKNOWN 不猜。
- 本阶段也把**现有 path 形态**的 impression 纳入同一台账(它们一直在注入却从未被标注)。

## M3 · 「注入→复发」闭环度量(缺失的那个数)
- 定义**复发事件**:某错误类的**确定性闸**开火(如管道闸、引擎+语料同提交闸、条目超长闸)= 该类复发一次。
  每个闸开火时追加一行 `recurrence ts sid class-tag gate-id` 到本机台账。
- 报告:对每条带 class 的教训,列「曝光/注入次数」与「其后同会话内该 class 的复发次数」。
  **闭环的定义:注入后复发率显著低于未注入时的复发率。** 没有这个数,一切「召回有用」都是自述。
- **因此第十四轮 spec 的 Part B(管道闸)整体并入本阶段**——它既是「机器而非警惕」的第一道自建闸,
  也是 M3 的第一个复发探测器。设计按 codex 审查修正:命中时**只输出**结构化
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"[tag] …"}}`,不设 permissionDecision,exit 0;
  触发条件覆盖审查点名的漏网写法(`tail -6 <文件>`、`… | head -60 | wc -l`、`head -n`、`--lines=`、`| tee/jq/sort`),
  例外 `PIPESTATUS`/`pipefail`/注释字符串;自测解析 JSON 断言事件名与文案,≥6 必触发 + ≥4 必不触发。

## M4 · 推「怎么做」,不只推标题(**M1–M3 跑满基线后才做**)
- 注入载荷由「标题 + 搜索命令」改为「标题 + Hook 一行」。Hook 已在 Index 行 tag 之后(引擎 :130 已解析该行),
  **不需要迁移**。总预算仍 ≤3 行 ≤1.2KB(v3 §3 :99)。
- 启用条件:M2 报告里该 trigger 的 useful 精确率 ≥80% 且曝光 ≥30;否则维持只记不注。

## M5 · 名额按相关性排序(与 M4 同期)
- 替换 `fresh.slice(0,3)` 的任意序:按 source 固定序(直接命中 > 因/果 > follows > 类枢纽,即 v3 §3 :99),
  同级按日期新者优先。被压制的仍记 `suppressed-cap` 以便 M2 度量「排序是否把有用的挤掉了」。

## 顺序与验收
- **M1+M2+M3 一起交付**(零注入、零行为改动,只增度量与一道警告闸);跑到 ≥200 条 Bash 事件 + ≥30 条标注。
- M4+M5 在精确率闸通过后另开一轮,不并入本轮。
- 完成标准:七套自测全绿项数只增;金丝雀名册 +2(impression 钩子、管道闸)红项 ≤1(仍是已知的 plan-OID 那台);
  `pmm-manifest-v2.cjs --check` 阻断分布不变;**每条自测断言具体退出码/JSON 字段**;M1 的「stdout 为空」有自测锁死。
- 明确**不做**:不改语料格式;不动 `pmm-migrate-v3.cjs`;不派 C0.5/盲攻/C1。

## 与迁移线的关系
C1 迁移线**暂停不删**(13 轮代码、82 项自测、`spec-round14-v2.md`、`brief-queue-drain.md` 全部留档)。
若 M4 实施时发现 Hook 从 Index 行读取有结构性障碍,再评估是否需要 ⑤ 那一类迁移——那时迁移才回到关键路径。
