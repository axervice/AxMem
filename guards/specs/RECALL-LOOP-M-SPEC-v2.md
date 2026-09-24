# 召回侧闭环 spec v2(codex spec 审查后重写;审查判「改后可建」,7 HIGH / 4 MED 已全并入)

仓库根 `C:/Users/<user>`,代码在 `.claude/guards/`。本版取代 v1(`RECALL-LOOP-M-SPEC.md`)。
审查产物 `~/.codex-reviews/review-20260916T181348Z.md`,存档 `audits/CODEX-2026-09-16-recall-M-spec-review.md`。
**审查逮住的每一条都标了 [审:编号]。** 建在**当前语料格式**上;M4 是唯一可能需要迁移 ⑤ 的点(见 M4)。

## 为什么重写:v1 的三个自相矛盾 [审 HIGH-1/2/7]
1. v1 说「零注入」,却把会输出 `additionalContext` 的管道闸并入同一阶段——**测量器即干预**。
2. v1 的「注入后复发率低于未注入时」没有可比对照:`suppressed-seen` 已接受过注入、`suppressed-cap` 是被挤出的低位候选、
   不触发的会话任务本就不同——**不是随机对照,比率无反事实意义**。
3. v1 说「引擎 :130 已解析 Index 行的 Hook,不需迁移」——**后半句不实**:引擎 Index 分支只取取代标记(`:144`),不存该文本;
   真正的 `Hook:` 字段只有 core 解析且 live 语料没有。「不需完整迁移」可成立,「引擎已能直接取」不成立。

## 分期(审查建议的最小风险分期,全收)[审 §建议的最小分期]

### M0 · 纯观测契约(第一步,零行为改动)
**交付**:命令解析库 + repo 解析 + 一条 shadow-only cmd trigger 种子 + 版本化台账 + 全通道零输出测试。管道闸只记 candidate。
- **解析库 `pmm-cmd-parse.cjs`**(零依赖叶子)[审 HIGH-6]:
  - 第一层按 POSIX shell 切段(未引号 `;`/`&&`/`||`/`|`/换行);剥 `VAR=val`、`sudo [-u x]`、`timeout N`、`env [-i] [VAR=v…]`、
    `command`、`nohup`——**wrapper 自身带参数的选项要定义**(`sudo -u root`、`env -i PATH=`);
  - **方言检测与独立子解析器,各最多递归一层**:`bash -c`/`sh -c` → POSIX;`powershell(.exe) -Command` → PowerShell
    (`&` call operator、`Get-X | Select-Object`、scriptblock、不同引号规则);`cmd(.exe) /c` → cmd;`wsl` → POSIX;
  - exe = 首 token basename 小写去 `.exe`;sub = 首个不以 `-` 起的后续 token,**跳过全局选项及其参数**(`git -C <path> status` → sub=status);
  - `(…)`、`$(…)`、heredoc、引号不平衡等**不支持的结构记 `parse_status=unsupported:<reason>`,绝不并入 `matched=0`**——
    否则解析失败伪装成真阴性,污染全部基线;
  - repo 由 hook 的 `data.cwd` 经 realpath / worktree / 配置映射解析,不硬编码;
  - 自测至少覆盖审查给的 8 行矩阵 + 6 条 happy-path,每例断言 `dialect/exe/sub/parse_status` 四元组。
- **一条 shadow-only cmd trigger 种子** [审 HIGH-4]:当前语料 cmd trigger 为 **0 条**,不种就是空基线。
  在管道教训 `process:pipe-hides-exit-code-and-truncates-evidence` 上加 `<!-- trigger: tool=Bash; repo=*; cmd=tail -->` 与 `cmd=head`
  (repo=* 允许,`tail/head` 不在 denylist);**引擎对 cmd 类仍不注入**,只由 M0 台账记 eligible。
  金丝雀加断言:生产语料 `cmd trigger count ≥ 1`。
- **台账** [审 MEDIUM-2]:路径 `~/.claude/.local/pmm-recall/<机器名>/`(根 `.gitignore` 须覆盖 `.claude/.local/`,验收 `git check-ignore`
  + `git ls-files` 双断言);版本化 TSV,字段:
  `schema_version ts session_sha256 tool_use_id event_kind(eligible|displayed|suppressed|would-warn|candidate|recurrence)
   trigger_id class_tag gate_id dialect segment_index exe sub parse_status cmd_sha256 parser_version`;
  impression-id = `sha256(session_sha256 + tool_use_id + trigger_id)` 作幂等键;并发 append 用 O_APPEND 单行写。
- **全通道零输出测试** [审 MEDIUM-1]:通过 `settings.json` 实际接线的命令跑,对「正常 / 坏 JSON / 空 stdin / 台账不可写 / 解析失败」
  五种输入各断言:stdout **0 字节**、stderr **0 字节**、rc **0**、除指定台账外无文件变化(`.trigger-seen-*`、`memory/`、`settings.json`
  逐字节不变)、运行时 < 500ms。
- **管道闸**(已在建,按 HIGH-1/3 修正):`PMM_RECALL_MODE=shadow|intervene`,默认 shadow 零输出只记 `would-warn`;
  三个 gate-id `exit-status-masked` / `verification-output-truncated` / `posthoc-partial-read`;`pipefail`/`PIPESTATUS` 只豁免第一类;
  第三类只记 `candidate` 除非关联同会话此前同路径的重定向事件。
- **验收**:名册红项集合**精确等于** allowlist(当前 = {plan-OID 那台}),不按数量 [审 MEDIUM-4];每个新守卫有 synthetic mutation 臂,
  按测试名固定;先观察 `parse_status` 分布(unsupported 比例)再进 M1。

### M1 · 可标注基线
- **本地 review queue** [审 HIGH-5]:持久层只留哈希与解析结果;**短期只读展示层**保存脱敏命令片段(去路径中的用户名、去引号内容)、
  tag、exe/sub、时间、impression-id,放同一 gitignored 目录,7 天滚动。`pmm-recall-queue.sh` 按 trigger 分层抽样列出待标注清单。
- `pmm-recall-label.sh <impression-id> useful|noise|useful-not-followed [备注]`。**三值不是二值** [审 HIGH-5]:
  「相关但没遵守」= `useful-not-followed`,是 useful + 复发,不是 noise;「不相关」才是 noise;未观察到复发**不自动算 useful**。
- **停止条件按 trigger 计,不按总 Bash 事件** [审 HIGH-4]:每 trigger `matched impressions ≥ 30` 且标注 ≥ 30。
- **精确率闸用置信区间** [审 HIGH-5]:单侧 95% Wilson 下界 > 80%(n=30 时约需 ≥28 useful;24/30 仍为 UNKNOWN);未达 = `UNKNOWN`,不猜。
- 报告 `pmm-recall-precision.cjs --report`:按 trigger、按 class 列曝光/标注/useful 精确率(含区间)/每千 **eligible tool events** 噪音行
  (不是「每千回合」,Bash hook 拿不到回合数)[审 MEDIUM-2]。

### M2 · 复发代理基线(静默)
- 细分类 gate 信号只记不警(全部 shadow);证明各 detector 自身的精确率与覆盖边界(对每个 gate-id 做标注抽样)。
- 此阶段**只做描述统计**,结论一律命名为「复发动作代理指标」,**不宣称测到实际错误或损失** [审 HIGH-2]。

### M3 · 随机干预(第一次真正能回答「注入有没有用」)[审 HIGH-2,全收]
- 分析单位 = 独立的 `session × class`;首次 eligible trigger 为 t0。
- 用 `hash(full_session_id, class_tag)` **稳定随机**分为 intervene 组与 shadow holdout 组;整个会话该类保持同组。
- 两组都跑静默 detector;**只有 intervene 组输出 `additionalContext`**。
- 记 `tool_use_id`、`eligible`、`emitted`(**在真正写 stdout 之后记**,不是准备发送时——现役 `:218` 记早了)、`recurrence-candidate`;
  **同一 tool event 不算「注入后复发」**。
- 固定观察窗:之后 20 个 Bash 事件或会话结束;比较「窗口内是否复发」或首次复发时间,不用无界计数。
- **样本量预注册**(双侧 5%、80% power、独立 session×class):50%→25% 每组约 58;30%→15% 约 121;20%→10% 约 199;
  同会话聚类与跨会话学习需上调。**数据未达即输出 `DESCRIPTIVE/UNKNOWN`,不得输出「显著有效」。**

### M4 · 推「怎么做」(等 M1 精确率闸)[审 HIGH-7 修正]
「怎么做」文本在旧 Index 行,**引擎当前不保存它**。二选一,建造者按实测决定:
- 稳妥:等迁移 ⑤ 把 Index REST 正式变为 `Hook:` 字段(这是暂停的迁移线里**唯一**可能被召回需求复活的动作类型);
- 无迁移:新增明确命名的 `legacyIndexHookByTag` adapter,处理唯一 tagged 单行、取代后缀、重复行、续行、无 tag、`classes.md`(无 Index 段)、
  archive redirect;**任何歧义回退标题并禁止该 trigger 过 M4 闸**。
- 载荷由**一个统一 builder 按实际 UTF-8 字节装箱** [审 MEDIUM-3],明确「≤3 条候选」而非「≤3 行」,总 ≤1.2KB 真的有闸。

### M5 · 名额排序 [审 MEDIUM-3]
现役引擎把所有双链折进 `entryLinks`(`:102/:225`),区分不了 Cause/effect/Follows;live 语料也无 typed 字段。
**M5 等 typed 图可消费后再建**;此前只承诺 direct/class 的确定排序。

## 硬约束(同前)
绝不对真库 `--apply`;`.claude/memory/*.md` 只允许 M0 那一处种 trigger 的编辑(经写时闸);`git add <具体文件>`;
守卫改动同批指纹 refresh + 收据 + `_local-config` 同步;取退出码不经管道;夹具不经 shell 构造(反斜杠折半);
对照组只留一个变量;复用旧脚本先读判定逻辑。

## 与迁移线的关系(修正)
迁移线仍暂停。**但 ⑤ hook-from-index-rest 不再是「无关」**:它是 M4 两条路里稳妥的那条。若 M4 时 adapter 的歧义率高,
以「只做 ⑤」的最小迁移复活——不是整条 C1。

## LESSON CANDIDATES(审查提的 + 主脑自认,择机入库)
- 会输出警告的 detector 同时当 outcome source = 测量器即干预。
- 只存 SHA 且不展示 impression-id,标注入口形式存在实际不可达。
- `unsupported syntax → matched=0` 把解析失败伪装成真阴性,污染基线。
- 主脑自认:「引擎已解析 Index Hook」是读了 `:130` 的 `startsWith('- 20')` 就推断它保存了文本——**看到解析不等于看到保存**。


## 附录 A(2026-09-16 18:05)· 台账契约同步:schema v3、双 id、术语、事件名、观察窗终止 [codex 审管道闸 v2.1 第 2 轮 MEDIUM-5]
本附录是权威;正文 M0 节「台账」段与之冲突处以本附录为准。
- **文件**:`<PMM_RECALL_ROOT>/events-v3-<host>.tsv`(缺省 root `~/.claude/.local/pmm-recall/`;可注入,只改位置不改行为);M0 impression 钩子与管道闸共写同一文件、同一共用模块 `pmm-recall-ledger.cjs`;旧 `impressions-*.tsv`/`pipe-gate-*.tsv` 改名 `.discarded-<ts>` 只读,数据判不可信。
- **列(v3)**:`schema_version ts sid_sha16 agent_sha16 agent_type prompt_id tool_use_id impression_id event_id event_kind gate confidence class_tag trigger_or_gate_id cmd_sha16 parser_version mode run_provenance sanitized id_missing agent_id_missing`。
- **双 id**:`impression_id = sha256(full session_id ‖ NUL ‖ agent_id ‖ NUL ‖ tool_use_id ‖ NUL ‖ trigger_or_gate_id ‖ NUL ‖ gate_instance_id)` 标识一次曝光机会(`gate_instance_id` 按 gate 种类钉死(2026-09-16 v2.9):A 行 = `<pipeline_id>:<pipeline_id>`(被判管道,首段 index 标识);B 行 = `<pipeline_id>:<segment_index>`(被判段);D 行 = `<pipeline_id>:<segment_index>:<operand_index>`(同段多文件 operand 各一条);M0 trigger 曝光 = `<segment_index>`;observed/session-end 为空;NUL 分隔防拼接碰撞);`event_id = sha256(impression_id ‖ event_kind ‖ ordinal)`,ordinal = `H(gate_id ‖ gate_instance_id ‖ event_kind)` 的序数化(由稳定标识派生,不用进程内计数)。**写入端不去重;读取端按 event_id 去重并报告重复率**。
- **术语**:`trigger_or_gate_id`(M0 的 trigger id / 管道闸的 gate id;取代原 `tag` 列)、`class_tag`(教训分类)、`run_provenance`(`test`/空;`PMM_RECALL_TAG` 写入此列;分析可剔除但不是唯一依据)。
- **事件名**:`observed | eligible | suppressed | displayed | would-warn | emitted | emit-failed | recurrence-candidate | recurrence | unsupported | path_unresolved | cd-hint | pending-conflict | pending-corrupt | pending-expired | receipt-lost | session-end | read`。正文中的 `candidate` 一律读作 `recurrence-candidate`。(2026-09-23 契约 v2.26 勘误 4:`read` = PreToolUse Bash 由 `pmm-bash-impression.cjs` 记录的「经 pmm-search.sh/pmm-grep.sh 按 live 身份全等查询」读信号,列取值见契约 `conventions.read_event`;不属 informational,不计入曝光/窗口/复发。)
- **观察窗终止**:M3 的「之后 20 个 Bash 事件或会话结束」= 同 (session, agent) 的 20 行 `observed`,或一行 `session-end`(由共用模块的 `writeSessionEnd()` 在 Claude Code `SessionEnd` hook 写入);两者都没有的会话记为 `window-open`,不进分析。
- **分析单位**:M3 仍为 `session × class`,随机分组 `hash(full_session_id, class_tag)`;`agent_*` 列只做分层与过滤。子代理曝光的抑制状态按 (session, agent) 计(盲攻 H4)。
- **M1 队列表头**:`impression_id trigger_or_gate_id class_tag exe sub ts snippet`。


## 附录 B(2026-09-17 06:50;上线后第一批,主脑裁定;覆盖 M1–M3 中与实现相关的句子)· M0 补全 + M2/M3 工具 + 干预解锁策略

### B1 · Edit/Write 触发召回钩子并入台账 v3(M0 补全)
- 现役 `pmm-trigger-recall.cjs`(PostToolUse Edit|Write|MultiEdit|NotebookEdit)只写 `dreams/trigger-log-<host>.tsv`(旧格式),不在 v3 台账里 ⇒ M1/M3 对「真正注入到对话里的召回」是盲的。**改为双写**:旧日志照写(dream 工具仍读),同时经 `pmm-recall-ledger.cjs` 写 v3 行:
  - 每个 matched 的 lesson tag 一行 `eligible`;被注入的 tag 各一行 `displayed`(**在真正写 stdout 之后记**);被 `suppressed-seen` / `suppressed-cap` 挤掉的各一行 `suppressed`,`run_provenance` 记 `seen` / `cap`;`gate` 与 `confidence` 列空;`class_tag` = 该 lesson 的 class;`trigger_or_gate_id` = lesson tag;`gate_instance_id`(进 impression_id 公式)= `sha16(repo ‖ NUL ‖ rel_path)`;`cmd_sha16` = sha16(tool_input.file_path);`mode` = `intervene`(它本来就注入)。
  - 同一 tool event 同一 tag 只一个 impression;写侧不去重(与附录 A 一致)。
  - 静默:任何失败不改钩子现有 stdout 行为(它的 stdout 是注入载荷),台账写失败只追加 `write-failures.count`。
- 验收:钩子 `--self-test` 加「三种事件各一行、列数 21、impression_id 公式」断言;runner 契约 G11:对钩子在临时 root 下真实跑一次 Edit 事件,断言 eligible/displayed/suppressed 行齐全且 `trigger_or_gate_id` 非空、`gate` 空。

### B2 · M2 复发代理基线工具 `pmm-recall-baseline.cjs --report [--source v3] [--since <iso>]`
- 只读、只做描述统计,输出前缀固定 `DESCRIPTIVE`;按 class_tag × trigger_or_gate_id 列:曝光(eligible + would-warn)、displayed、suppressed(seen/cap)、recurrence-candidate、recurrence、每千 eligible tool events 的 would-warn 行、观察窗状态(同 (session, agent) 后续 `observed` ≥20 或 `session-end` ⇒ closed,否则 open)。
- 不宣称测到实际错误或损失;字段名一律带 `proxy_`。自测:合成台账(含重复 event_id、窗口开/闭、跨会话)≥12 例;`UNKNOWN` 字面量对未闭合窗口。

### B3 · M3 干预解锁策略与分析工具
- **策略文件** `<PMM_RECALL_ROOT>/policy.json`(gitignored 目录内):`{ "<class_tag>": { "mode": "shadow" | "randomized", "unlocked_by": "<precision report id>", "lower95": 0.xx, "unlocked_at": "<iso>" } }`。缺文件或缺键 ⇒ `shadow`。**只有 M1 报告 Wilson 单侧 95% 下界 > 80% 的 class 才允许写 `randomized`**,写入动作由 `pmm-recall-precision.cjs --unlock <class_tag>` 完成(它自己核对下界,不达即拒绝),人工手改视为篡改(指纹不管 policy,但 M3 分析工具会把 `unlocked_by` 与报告核对)。
- **分配函数**(简报 §6 的常量 `shadow` 升级):`assignment(full_session_id, class_tag)`:policy 为 `randomized` 时 = `sha256(session ‖ NUL ‖ class_tag)` 首字节奇偶 → `intervene` / `shadow`(整个会话该类固定);否则 `shadow`。台账 `mode` 列记实际分配;`run_provenance` 记 `policy:<mode>`。
- **观察窗**:附录 A 已定(20 行 observed 或 session-end)。
- **分析工具** `pmm-recall-m3.cjs --report`:分析单位 session × class;t0 = 首次 eligible;两臂各自的「窗口内复发」比例与首次复发时间;样本量预注册表(50→25%:58/组;30→15%:121;20→10%:199)未达 ⇒ 输出 `UNKNOWN`,达标才给差值与区间;同会话聚类用 session 层 bootstrap;永不输出「显著有效」四字以外的措辞(只输出数字与区间)。
- 验收:契约用例 P01 policy 缺 ⇒ shadow;P02 policy shadow ⇒ shadow;P03 policy randomized ⇒ 同一 session 同 class 的两次事件同臂、不同 session 可不同臂、mode 列如实;P04 intervene 臂 emitted、shadow 臂只 would-warn;P05 `--unlock` 对下界 ≤80% 的 class 拒绝并 rc 2。

### B4 · 到 100% 的度量定义(主脑 2026-09-17 06:50)
| 维度 | 100% 的含义 | 现状 |
|---|---|---|
| M0 观测 | Bash 闸 + Bash 触发 + Edit/Write 触发全部经 v3 台账 | 前两项 ✓,B1 待建 |
| M1 精确率 | 每个 trigger/gate-id ≥30 标注,报告给出下界或 UNKNOWN | 工具 ✓,0 标注 |
| M2 基线 | B2 工具在册并产出 DESCRIPTIVE 报告 | 待建 |
| M3 干预 | 策略文件 + 分配函数 + 分析工具在册;至少一个 class 通过 M1 闸进入 randomized 并累积到预注册样本量 | 待建 + 等数据 |
| M4 怎么做 | legacyIndexHookByTag adapter 或迁移 ⑤,M1 闸后 | 待 |
| M5 排序 | typed 图可消费后 | 挂起 |
| 闸卫生 | fab LOW 14 + codex 后续(L21/L23)+ C0 影子 | v2.18 批 |
- 附录 A 补注(2026-09-17,fab L10):`impression_id` 与 `event_id` 的实现值 = 对应 sha256 的前 16 个 hex(64 位),列宽与公式以此为准;当前规模碰撞概率可忽略,若将来需全宽再加列。
- **附录 B3 补注(2026-09-17 11:00;建造者 B3 判断点)**:M3 与 M2 的「复发」**不是** `event_kind='recurrence'` 行(生产闸从不写该 kind——D 的复发按 `gate_disposition_map` 记为 `would-warn`/`emitted` 且 `confidence='recurrence'`,候选记为 `event_kind='recurrence-candidate'`)。定义:t0 之后、观察窗内、同 (session, agent, class_tag) 的任一行满足 `confidence ∈ {recurrence, recurrence-candidate}` 或 `event_kind='recurrence-candidate'`,且 `tool_use_id` ≠ t0 的事件,即计一次复发(同一 tool event 不算)。`pmm-recall-m3.cjs` 与 `pmm-recall-baseline.cjs` 按此读;自测各加「confidence=recurrence 的 would-warn 行被计为复发」「event_kind=recurrence 行不存在也能计」两例。
- **附录 B3 补注 #2(2026-09-17 11:10;契约 v2.19)**:policy.json 结构改为 `{class_tag: {mode, gates: {A,B,D}, unlocked_by, lower95_by_gate, unlocked_at}}`;class_tag = 闸实现的教训 tag(gate 行必须写它,空即红);臂按 (session, class) 一次抛硬币、全 class 共用;某 gate 只有自己的 (class, gate) 下界 > 0.80(≥30 标注)被 `--unlock <class> --gate <G>` 写成 randomized 才在 intervene 臂真正输出,否则该 gate 行 mode=shadow、run_provenance `policy:shadow-gate`。
- **M1 结果记录(2026-09-17 11:12)**:首批 180 条标注(B 14/16/0、pipe 教训 12/18/0、guard-fingerprint-roster 30/0/0 下界 0.917 过闸、gate-matcher 3/27、cycle-detection 0/30、kernel-decay 0/30)。结论:Edit/Write 教训的宽路径 trigger 是主要噪声源(按标注收窄);B/pipe 的噪声来自判定规则本身(下批契约收窄 B 到验证类 exe)。工具缺口:v3 下 M1 展示层 `queue-<host>.tsv` 无人写(`writeQueue()` 导出未接线),标注者靠会话 JSONL 交叉核对;闸/M0 钩子须补写展示层(脱敏片段、7 天滚动)。
- **附录 B 补注 #3(2026-09-17 11:20;Opus 增量核 MEDIUM-E1/E3)**:B3/B2 的**主结局** = 窗口内 `confidence='recurrence'` 行,**次结局/敏感性** = 主结局 ∪ candidate;两口径都报。B1 的 `gate_instance_id = sha16(repo‖NUL‖rel)`:repo = 触发引擎解析出的 repo 名,rel = 相对 repo 根、正斜杠、无前导 `./`;行的 `run_provenance` 追加 `inst:<sha16>` 供 runner 复算 impression_id。gate 行 class_tag 空的旧行(修复前 1058 行)**不回填**:读侧按 A/B/D 派生,报告把 `(unknown)` 拆成 `(pre-class_tag)` 与 `(n/a)`,并记切换时刻;台账 append-only 不改写。

**附录 B 补注 #4(2026-09-17 15:10,Opus v2.23 补核 LOW-J4:码先于规格,此处补记)**:M3 分析单位(session × class)只由 `run_provenance` 含 `policy:randomized` 的 eligible 行播种;`policy:absent|shadow|corrupt` 的单位不进任一臂,按 class 以 `units_unrandomized_excluded` 单列报告。理由:未随机化的类恒走 intervene(trigger 照旧显示),计入会抬高 intervene 臂分母、让 UNKNOWN 看起来像结果。两个 eligible writer(Edit/Write trigger、Bash impression)经唯一解析器 `pmm-recall-policy.cjs` 落实际臂;randomized 且臂为 shadow 时不显示,写 eligible + suppressed(reason=policy-shadow)。实现:`pmm-recall-m3.cjs`(ff7a8d4)、`pmm-recall-policy.cjs`(594a2a1)。

**附录 B 补注 #5(2026-09-17 19:40,fab 盲攻 MEDIUM-3 + Opus 复现:seen 键只取 session 前 8 字符,子代理与主会话互相饿死;M3 单位与复发口径不一致)**:①**分析单位改为 `session × agent × class`**(原「session × class」整句作废):曝光(t0 = 首次 eligible)与结局(窗口内复发)必须落在**同一执行体**(同 sid_sha16 + agent_sha16),跨执行体不配对;②**随机分组不变**:臂仍按 `assignment(full_session_id, class_tag)` 决定,同一会话内所有执行体共臂(避免主/子代理互相污染);③**seen 去重键 = `sha16(session_id ‖ NUL ‖ agent_id)`**(主会话 agent_id 为空即旧行为),不再取 session 前 8 字符;④样本量预注册表按单位数不变(58/121/199),单位计数口径随①;⑤`pmm-recall-m3.cjs` 的 `unitKey` 与 `sessAgentKey` 窗口口径对齐,读侧对旧行(无 agent 列或为空)按 agent 空串归一,不回填。实现:`pmm-trigger-recall.cjs`、`pmm-recall-m3.cjs`(直接派建)。

**附录 B 补注 #6(2026-09-23,C0.5 spec 审 K11/K12,Jax「执行」裁决):风险时刻再推**:①风险动作为闭集——R1(Bash 段未完整重定向即调用守卫 DUT)由隔离闸 `pmm-isolation-gate` 的拒绝文案承载,不另推、不动 seen;R2(Edit/MultiEdit 于 `<repo=home>/.claude/guards/**`,old_string 含 `HOME=|USERPROFILE=|PMM_HOME=|PMM_RECALL_ROOT=|PMM_TRIGGER_(MEM|STATE|LOG)=|PMM_MEM_DIR=` 任一赋值而 new_string 已无该名赋值)由 `pmm-trigger-recall.cjs` 承载;②R2 对本事件直接命中且已在 seen(键 = `seenKey(session_id, agent_id)`,即补注 #5③,由 `pmm-recall-ledger.cjs` 导出共用)而未曾再推的 tag 再推一次,每 (seenKey, tag) 至多一次,记账为同一 seen 文件追加 `repush:<tag>` 行;③再推经 `pmm-recall-policy.resolve()`,randomized 的 shadow 臂只写 eligible + suppressed(policy-shadow),否则写 displayed 且 run_provenance 追加 `repush:R2`,M3 按其分层;④再推载荷 = 条目首个 `What to do instead:` 行(≤320 B,码点边界截断),无则退回标题,整条 ≤1200 B(超出截断并 tlog `quota-truncated`)——这是对 M4「等 M1 精确率闸」的显式豁免,范围仅 R2;普通推送载荷不变。
