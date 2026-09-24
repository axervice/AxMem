# PMM v3 目标 spec(2026-09-15;主会话综合 fab #3 + codex 六审 + Jax 目标)

Jax 目标(原文要点):一次建好,记忆系统脱胎换骨、完美闭环,**真正帮 agent 想起相关记忆与经验教训**;考虑以后的维护成本和记忆的前后/因果关联;AxMem 不计成本。
约束:机器只做确定性事;批量改写允许但必须语义不变且逐字节可验;教训不按里程碑/热度退热(只因被取代);建者≠审者。

## A. 存得对(采纳 fab #3 §2,含主会话裁定)
A1 身份 = 标题闭 `**` 后第一个 `[ns:tag]`,live 全库唯一(B7);署名 `[user:x]/[agent:x]/[system:x]`、`[trust:x]`、`[sole-record]`、`[redundancy-ok]` 在身份之后任意序,不参与身份。身份 ns ∈ {user,agent,system,trust} = 红(B8b)。
A2 字段行(标题后、正文前,严格正则,一行一字段,任意序):`<!-- attribution: -->` · `<!-- trigger: … -->`×n · `Class: [[class:x]]`(lessons 必填)· `Supersedes: [[…]]`(只写被取代者)· **`Cause: [[…]]`×n(新,见 B)** · `Rules:`(仅 classes.md)· **`Hook: ≤320B`(新;派生 Index 用的一句钩子,缺省用标题)**。正文自由;`Ratified by:` 不必填。
A3 Index 全派生:文件里删除 `## Index` 段;`manifest --index --as-of D` 渲染 `- DATE [id] Hook` + 派生 `(superseded→[head])`,按日期降序;冷行折叠为一行计数(D2:已取代 + decisions 项目命名空间 >90 天且无 live 反向链;lessons 只按已取代)。注入:三文件 `skip`,SessionStart `pmm-index-emit.sh`(fail-open 只打印标题行),`/read-pmm`、codex session-start 同调。
A4 归档零改写;身份 = blockHash。退役=移动 F′:manifest(HEAD live) 有、manifest(staged live) 无 ⇒ staged archive 含同 blockHash 块。
A5 提交层真相 = `manifest --diff HEAD :0`;删除三个会话基线文件;新条目 = 身份 HEAD 无;超长/Hook/Kernel(≤16KB)绝对上限;拒未来日期。PostToolUse 三 hook 合一 `pmm-hook.cjs`(realpath+小写;含 memory 即全跑),一次 manifest(worktree) fan-out 到检查/回显/推送/lessons-routing。
A6 消费者只吃 manifest JSON(含 body):trigger-recall/write-echo/redundancy/pointer-lint/fade/lessons-routing 删私有正则。blockHash = git blob 原始字节(不 join、剥 BOM)。
A7 迁移两提交:C0 影子(manifest v2 + `--plan/--apply/--verify`,canary 断言真库 `--plan` 恰报 7 组数);C1 一次切换(24 条补身份[D1 命名表]、6 条 `[user]`→`[user:jax]`、3 对同文件重复改名、3 对跨文件双写 D3、Index 行 REST≠标题者逐字节搬为 `Hook:`、3 条 marker-only 补 `Supersedes:`、删三处 Index 段;同提交切 precommit/config/emit/删旧闸/EXPECTED),10 条确定性断言(fab §3),`git revert` 回滚,切换后文件含 `## Index` 即红。

## B. 想得起(新增;fab/codex 未覆盖的目标)
B1 **因果与时间线成为一等结构**:`Cause: [[tag]]`(本条因它而起;多值)——manifest 派生反向边 `effects`;时间线 = 日期 + Supersedes 链(已有)。写入纪律:新教训/决策若由某条教训/决策/事故引出,必须写 `Cause:`;写闸 B10:`Cause:` 目标必须存在(含归档)。迁移不回填历史因果(判断题);dream 月步只提议,Jax 批后加。
B2 **推送(push)= 触发 → 条目 → 邻域**:命中条目后按固定顺序补位(名额 3):取代链头 → `Cause`/`effects` 邻居(标"较早/较晚"+"因/果")→ 类枢纽最近成员;每回合每 tag 一次。触发面扩到命令:`<!-- trigger: tool=Bash; repo=<id|*>; cmd=<子串> -->`(纯子串,不用正则;命令只记 sha256 不记文本;matched=0 事件写本机不入库);repo-id 解析改通用(git toplevel basename + 配置映射),dee/RAG/AxMem 都有触发面。
B3 **反馈闭环**:`pmm-trigger-recall.sh feedback <tag> hit|miss`(一行遥测,stage=followed/irrelevant);dream 月报每 trigger 的 injected/followed/irrelevant;30 天 followed=0 且 irrelevant>0 的 trigger 自动降级议案;推送渠道整体 D5 日落判据=数据。
B4 **拉取(pull)= 一条命令给邻域**:`pmm-search.sh "<q>"` 命中后附:链头、Cause/effects、同类计数、时间线位置(前后各一条同类);热度只记"用户查询串全等 tag 的主命中"(P19),供冷热与 fade。
B5 **检索金丝雀加图题**:现有 23 题 + 因果题(给一条教训,能否找到它的 Cause 与被它引出的条目)+ 时间线题(给一个 tag,答现行版)。
B6 **规则在场**:横幅 D4 节奏(开场/压缩后全文,每 5 回合全文,其余一行 tag 清单);横幅每行 tag 必须是 live 且 user-ratified 的 Kernel 条目(canary);banner/settings 接线串/CLAUDE.md/classes.md/pre-commit 入指纹册,册变更须同批 guard-change 收据。

## C. 少维护(减法与度量)
C1 名册目标"少而证明过":迁移后删除的闸见 fab §2.5;每台闸月报 30 天真阳性;零真阳性且无对照夹具 → 降级议案;冗余闸 D5。
C2 遥测节食:只有阳性 stage 入库;其余本机。收据 trailer 改 `commit-msg` 钩子精确结算(P9/P10);Jax 原话本机 spool(不入库)供 save/压缩后核对裁定。
C3 小活一并:fast-path fail-safe、拒 `path=*`、Q 诚实上限、盲攻纪律按提交区间、autopull 文案、pointer-lint 迁移指针内容核验(KNOWN-CEILING)。

## D. AxMem(不计成本)
同一架构:manifest v2 / 派生 Index / 迁移器 `axmem migrate v3` / pmm-hook 合一 / Cause 边 / cmd 触发 / 反馈 / 派生索引 emit / 适配 CC、codex、Hermes、generic;每件带自测与生产形态夹具;文档写目标形态与迁移。

## E. 顺序(每步独立提交、金丝雀绿、codex 审 diff)
1 C0 影子 → 2 C1 切换 → 3 消费者去正则 + hook 合一 → 4 B1/B2/B3/B4(因果边、cmd 触发、反馈、pull 邻域)→ 5 C2/C3 小活 → 6 检索金丝雀加题 → 7 AxMem 全量移植。
