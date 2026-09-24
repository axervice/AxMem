# 记忆系统「最优方向」候选(主会话 2026-09-15 提出;待 codex 判定)

标准(Jax):必须能解决系统现存全部已知问题,并且之后能维持稳定、减少维护。

## 结构诊断
今天两次盲攻共 20 个逃逸,一半同源:条目"身份"没有单一来源——`[ns:tag]`(身份)、`[user:jax]`/`[agent:x]`/`[system:x]`(署名)、`[trust:x]`、`[sole-record]`、`(superseded→[x])` 全在一种方括号语法里,六个解析器(写闸 awk/grep、precommit 的 check_file/check_retire、manifest、trigger-recall、write-echo、redundancy-lint、pointer-lint、fade)各自猜哪个括号是身份。每修一处正则,另一处出洞(E1 修法→E3 假红;fast-path→E7)。加闸是事件触发、减闸是判断触发→名册单向长(26→37/天),每次编辑多起进程;而唯一重要的结果(已知错误是否不再重犯)几乎没有度量(retrieval-misses 2 行、recall-timing 1 行、推送零反馈)。

## 方向(六条)
1. **身份单源化**:`pmm-manifest.cjs` 成为唯一解析器,输出 JSON:每条目 {id, file, lineRange, blockHash, date, class, links, triggers, supersedes, soleRecord, indexRows[], archived}。身份 = 闭 `**` 后第一个命名空间 ∉ {user, agent, system, trust, class} 的 `[ns:tag]`;署名/trust 标记可在任意位置但不参与身份。所有闸与消费者只吃 manifest JSON,不再各写正则:写闸(900B/奇偶/C3/D/E-sup/E-graph/I/Q)、precommit(退役/奇偶/沉井)、trigger-recall、write-echo、redundancy、pointer-lint、fade、未来的热索引。不变量集中在 manifest:B1–B6 现有 + B7 重复身份 + B8 `**20` 起行却未解析成条目 / Index 行无身份 + B9 Index 区非行文本 + Kernel/standing 字节上限 + 拒未来日期。
2. **提交层真相来自 git,不借会话状态**:precommit 用 manifest(HEAD) vs manifest(staged) 做 diff:退役 = 身份在 HEAD 有、staged 无且 archive 无同 blockHash;新条目 = 身份 HEAD 无(B6 缺 Class 按此判,不按标题日期);超长 = staged 超限计数 > HEAD(不读会话基线,沉井绝对)。PostToolUse 写闸保留为即时提醒,但不再是真相边界。
3. **先测结果再扩面**:推送反馈入口 `feedback <tag> hit|miss`(可数精确率);Jax 原话逐字本机 spool(不入库,save/压缩后读回核对裁定是否失真);每台闸月报 30 天真阳性数;试点(推送渠道)给日落日期,30 天按数据留/砍;cmd= 触发等扩面在此之后。
4. **省 token 只动"注入什么"**:SessionStart 派生热索引(文件不动、fail-open、判据同 codex 修订:取代非头 + 项目命名空间>60 天零精确热度且分片完整;教训只按取代);横幅按节奏(全文每 N 回合,其余一行 tag 清单,N 由 Jax 定);遥测节食(只有阳性 stage 入库)。
5. **最高权限面入册并绑收据**:settings.json 接线串 sha、`~/.git/hooks/pre-commit`、banner.md、classes.md、`~/.claude/CLAUDE.md`、hook-manifest 进 FINGERPRINTS;FINGERPRINTS 变更须同批 guard-change 收据(precommit/commit-msg 核);横幅每行须引用 live 且 user-ratified 的 Kernel tag。
6. **减法制度化**:dream 月步:零真阳性且无对照夹具的闸 → 降级/合并议案;名册目标是"少而证明过",不是"多"。

## 迁移与稳定
分四个独立可回滚提交:① manifest 身份规则 + B7/B8/B9 + 扶正 8–16 条署名在前的标题 + 2 处重复 tag(先报后修)② 消费者逐个切到 manifest JSON(写闸、precommit、trigger-recall、write-echo、redundancy、pointer-lint、fade),每切一个删它自己的正则并加"生产形态"夹具 ③ 提交层 git-diff 真相(沉井绝对)④ 入册+反馈入口+遥测节食+热索引。每步金丝雀全绿、codex 审 diff。
