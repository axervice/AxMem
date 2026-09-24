# C0.5 建造 spec:运行时影子(旧行为仍是权威;新实现只记录、只对照,不拦、不注入)

依据:`PMM-V3-FINAL-SPEC.md` §3/§4/§5(C0.5 段)与 §9 步 2;C0 已落地(`e620760`:`pmm-core.cjs` 库、`pmm-migrate-v3.cjs`、golden corpus、shadow 对照)。codex/Opus 对 C0 的审查结论并入本步开工前的修补清单。
边界:只在 `~/.claude/guards/`、`~/.claude/pmm-hook.cjs`(新)、`settings.json` **追加两条**影子接线(PostToolUse `Edit|Write|MultiEdit|NotebookEdit` → `pmm-hook.cjs --shadow`;PreToolUse `Edit|Write|MultiEdit` → `pmm-hook.cjs --shadow --pre`;不删旧条目)(spec 审 K20)、`~/.claude/memory/_local-config/`(备份)下动;真库内容零改动;不改任何旧闸行为——**唯一例外**是补遗二的 21(新隔离闸)、23 R2(`pmm-trigger-recall.cjs` 再推)、26(金丝雀三态),它们是本批显式批准的活体改动,标题里「不拦、不注入」的影子不变量不适用于它们(spec 审 K12);不 push(post-commit 会自动推)。

## 交付物
1. **`pmm-hook.cjs --shadow`**(统一 hook,§4):读 stdin hook JSON(1s 超时同今日 fast-path);路径归一(`\\→/`、折叠 `//`、`path.resolve`、`realpathSync.native` try、小写);`isMemory` 判定含 §4 默认失败方向(原串含 `memory`/`claude~` 而 realpath 失败 ⇒ 按 memory);B30 canonical-home 判定;一次 `core.snapshot('worktree')` → 在**影子模式**下只把「若为权威会做什么」写进本机 `~/.claude/.shadow/hook-<mach>.log`(一行 JSON:ts、sid、tool、rel、isMemory、gate blocking 列表、echo 输出、push 候选 impression 列表、routing 判定),**不向 stdout 输出任何 additionalContext、不 exit 2**。故障语义 B28 在影子日志里标 `DEGRADED`。settings.json 追加 PostToolUse(matcher `Edit|Write|MultiEdit|NotebookEdit`,**不含 Bash**,与 13③ 一致)与 PreToolUse `--shadow --pre`(matcher `Edit|Write|MultiEdit`)各一条;两者 stdout 0 字节、rc 0、不影响权限决定(spec 审 K20)。影子日志路径一律 `<resolveHome()>/.claude/.shadow/`(spec 审 K23);每行记 `tool_use_id` 作对照连接键(spec 审 K18);push 候选的曝光 id 按 M-SPEC 附录 A 公式,`gate_instance_id` 加 `shadow:` 命名空间以免与真曝光碰撞(spec 审 K21);push 候选同时记**截断前**候选序列与截断后选择(spec 审 K19);seen 状态见第 14 条(spec 审 K17)。
2. **`pmm-shadow-compare.cjs`**:把影子日志与旧三 hook 的真实输出对照——旧输出从哪来?给旧三脚本各加一个**只读 tee**:`PMM_TEE_LOG=~/.claude/.shadow/legacy-<mach>.log` 环境存在时把自己的 stdout/exit code 追加一行(不改行为;这是旧脚本唯一改动,须走指纹 refresh)。对照规则:同一事件(连接键 = `tool_use_id`,tee 行与影子行都记;缺失时才退回 sid+ts±2s+rel)下,写闸 blocking 集合、回显 tag 集合、推送 tag 集合逐项相等;差异分类=允许(v3 语法新识别/B23/⑧/`v3-untyped-link-not-carried`(旧 hook 一跳携带正文 `[[链]]`,v3 只带类型边)/`v3-class-count-not-members`(v3 类枢纽只给计数+指针,不填成员)/`quota`,每类由对照器按规则机械判定并逐条列出)或未解释(spec 审 K18);输出 `shadow-compare.md` 报告 + 未解释计数。
3. **事件回放** `pmm-shadow-replay.cjs`:从 `memory/dreams/trigger-log-*.tsv` 的 `event` 行重建 hook JSON(tool、file_path 由 repo+rel 反推;Bash 事件无命令文本→跳过),喂给 `pmm-hook.cjs --shadow` 与旧 trigger-recall(只读 dry-run;子进程环境一律经 22 的 `isoEnv()` 起,完整重定向——原文只列 `PMM_TRIGGER_STATE`/`PMM_TRIGGER_LOG` 两个变量不足,以第 16 条为准)(spec 审 K2),对照推送候选;回放目标 ≥200 条事件零未解释差异,回放计数单列、不替代实时(spec 审 K22)。
4. **precommit `--shadow`**:`pmm-precommit-gate.sh` 加环境开关 `PMM_PRECOMMIT_SHADOW=1`(默认关):在现有检查之后额外跑 `core --diff HEAD :0`,把 blocking 列表与旧闸的 fail/msg 写本机 `precommit-<mach>.log`,**不改变退出码**;另提供 `pmm-precommit-shadow-replay.sh`:对最近 30 笔真实提交(`git log -30 -- .claude/memory`)逐笔以 `HEAD~k` vs `HEAD~k+1` 跑 `--diff`,与当时是否被拦(提交存在=没被拦)对照,列出 v3 会拦而当时放行的、和当时拦而 v3 不拦的(后者需人工判)。
5. **`pmm-index-emit.sh --shadow`**:跑 `core --index --as-of $(date +%F)`,写本机 `<resolveHome()>/.claude/.shadow/index-<mach>.txt` 与 LKG 缓存 `<resolveHome()>/.claude/.pmm-index-lkg/<sha(sourceOids+schemaVersion)>.txt`(两处都纳入金丝雀 M-2 与 22 的足迹监视集)(spec 审 K23);与 HEAD 三处 Index 做归一化 diff(按 plan 映射对齐,A7 口径),报告差异;故障注入:core throw / 空快照 / 缺文件 → 必须输出 `PMM-DEGRADED` + 走 LKG/标题末路,永不"空输出且 0"。**不接进 SessionStart**。
6. **pmm-search v2 影子**:`pmm-search-v2.sh "<q>"` 按 §3.2 排名出结果但只写本机 `<resolveHome()>/.claude/.shadow/retrieval-impressions-<mach>.tsv`(query sha256、top-k 身份、分数)(spec 审 K23),曝光 id 按 M-SPEC 附录 A 公式、`gate_instance_id` = `search:<rank>`(spec 审 K21),不改现有 `pmm-search.sh`;检索基线:跑 `memory/_local-config/canary-set.tsv` 全部问题,记录 Recall@1/Recall@3/MRR/0-hit 率到 `guards/specs/RETRIEVAL-BASELINE-<treeOid>.json`。
7. ~~**反馈入口** `pmm-feedback.sh <impression-id> useful|irrelevant`(写本机 feedback-<mach>.tsv;impression-id 由 hook 影子日志与 search v2 生成,格式 `<sid>-<seq>`)——C0.5 只落盘,不进任何判定。~~ **作废**:`<sid>-<seq>` 要靠进程内计数(每个 hook 是新进程,必然撞号;附录 A 明令不用进程计数),二值 `useful|irrelevant` 又与现行 M1 三值(useful/noise/useful-not-followed)冲突。反馈一律复用 `pmm-recall-label.cjs`;影子与 search-v2 的曝光 id 见第 1、6 条(spec 审 K21)。
8. **故障注入夹具矩阵**(`guards/fixtures/v3/faults/`):core throw、单消费者 throw、stale LKG、缺文件、Windows 路径变体(`/./`、`/../`、8.3 短名、UNC、大小写、正斜杠盘符)、hook JSON 双反斜杠(E7 形态)——每例期望:影子日志有 `DEGRADED` 或正确判定,永不静默。
9. 金丝雀:+1 行「C0.5 影子:对照零未解释差异 ∧ 回放 ≥200」(读 shadow-compare 报告);EXPECTED 不写死(09-23 实值 70),收口者按「建造时 HEAD 值 + 本批新增行数」一次改(spec 审 K24)。指纹 refresh(理由含清单)。文档 `docs/PMM-V3.md` 加「C0.5 影子操作与退出判据」。

## 退出判据(C1 前置)
- 影子对照:Bash 事件不计(13③);≥200 条事件中**实时** ≥100 且双机各 ≥1 天,回放单列、不替代实时;连续 7 天零未解释差异(按第 2 条的允许类别)(spec 审 K22);precommit 回放 30 笔一致(差异逐条人工判定后归零)。
- 故障注入矩阵全绿;检索基线已入库;LKG 命中路径实测。
- codex + Opus 审 C0.5 diff GO;fab 盲攻 #4(读 §9 步 2)。

## 09-15 复验后追加(Opus C0 复验报告 §4 里落在 C0.5 面的两条 + 一条并发发现)

10. **「文件在但内容空/被截断」必须有专属诊断**(Opus 风险 4):实测 core 把空文件与截断文件都当**合法文件**处理,退出码碰巧非零但**理由是错的**,没有任何一条诊断说文件不完整。金丝雀那句 `git show … > "$f" 2>/dev/null || true` 在 git 失败时会留下 **0 字节文件**且不报错。C0.5 要做两件:① 交付物 8 的故障夹具矩阵**增加两例**(0 字节文件、尾部截断到一半条目),期望输出必须含明确的「文件不完整」诊断码而非泛化 blocking;② 金丝雀那行改成显式判 `[ -s "$f" ]` 并在失败时硬 FAIL,不再 `|| true`。
11. **两套文件集并存的重复必须在影子期收口**(Opus 风险 3,原 C0.5 缺口 #6 未动):`FINGERPRINT_FILES` 含 `banner.md` 而 `core.ALL_FILES` 不含。C0.5 新写的 hook/emit/precommit **三个消费者一律只从 `core` 取文件集**,任何本地再列一份清单 = 建造期就判不合格;`banner.md` 由 core 显式标注为「指纹覆盖、非语料」而不是各处各记一份。
12. **语料在影子期是移动靶,对照必须按快照而非按"当前"**(09-15 实证):并发的 axervice 会话当天两次 `pmm save` 自动提交(`5e9f57b`、`23f1f74`),语料树对象 `3ac657b7…→46e8ef0e…`,同一条 `--check` 命令三次给出三组行号(315/347/355),阻断数 39→48。⇒ 影子对照器与回放器**每轮开工先 `git rev-parse HEAD:.claude/memory` 取一次 OID 并钉住**,全轮只读该 OID 的快照;轮末再取一次,**若已漂移则整轮结论作废重跑**(而不是拿跨快照的两半结果做对照)。报告里必须打印本轮的 OID。

## 2026-09-17 追加(主脑;C0.5 开工前必读,覆盖 09-15 原文与之冲突处)

13. **活体自 09-15 起的变化,C0.5 必须对齐**:①`pmm-trigger-recall.cjs` 现在双写 v3 台账(eligible/displayed/suppressed,带 `inst:<sha16>`、mode=实际臂、run_provenance=policy 状态),臂由唯一解析器 `guards/pmm-recall-policy.cjs` 决定;②新增 PreToolUse 写时闸 `guards/pmm-trigger-write-gate.cjs/.sh`(Edit|Write|MultiEdit,trigger 在场/合法);③Bash 事件另有管道闸 v2 + M0 impression(PreToolUse/PostToolUse/PostToolUseFailure)与 SessionEnd 台账 flush——**不在 C0.5 范围,统一 hook 不碰 Bash 事件**;④金丝雀 EXPECTED 按第 9 条不写死(09-23 实值 70,不是 60)(spec 审 K24);⑤读侧工具有 `isContaminatedRow()` 排除、写入边界拒 sid "undefined"。
14. **统一 hook(交付物 1)的推送候选必须复用 `pmm-recall-policy.cjs` 的 `resolve()` 得臂**,影子日志逐条记 `{tag, arm, provenance}`;**影子模式绝不写 v3 台账**(不调用 ledger 写入;自测断言临时根台账行数为 0),只写 `<resolveHome()>/.claude/.shadow/` 下文件。**seen 用自有状态** `.shadow/seen-<seenKey>`:键函数与 trigger-recall 共用 `pmm-recall-ledger.cjs` 导出的 `seenKey(session_id, agent_id)`(M-SPEC 备注 #5③,含 `nosess` 回落),**绝不读写** `.trigger-seen-*`、trigger-log、`.pmm-len-baseline`、v3 台账。原因:影子 hook 与权威 hook 在同一事件上并行跑,写活体 seen 等于抑制权威推送,读活体 seen 则是竞态。自测断言这些活体文件首尾 sha 不变(spec 审 K17)。
15. **旧 hook 由三变四**:tee 与对照覆盖 `pmm-entry-length-watch.sh`、`pmm-trigger-recall.sh`、`pmm-lessons-routing.sh` **加 `pmm-trigger-write-gate.sh`(PreToolUse)**;对照项加「写时闸 blocking 集合」;统一 hook 的 PreToolUse 形态(`--shadow --pre`)与 PostToolUse 形态分别记录(接线见第 1 条的两条追加)(spec 审 K20)。
16. **隔离铁律(09-17 台账污染事故)**:C0.5 所有自测与回放必须同时重定向 `HOME`、`USERPROFILE`、`PMM_HOME`、`PMM_TRIGGER_STATE`、`PMM_TRIGGER_LOG`、`PMM_RECALL_ROOT`(一律经 22 的 `isoEnv()`);~~每个自测末尾断言真实台账 `events-v3-*.tsv` 行数与开始时相同~~ 改为:每个自测首尾经 22 的共享足迹助手断言**零足迹**——首尾之间真根**新增内容**里没有本次运行标记(run nonce、运行根 basename、本自测源码静态扫出的全部 session_id/tool_use_id 字面量及其派生哈希),且没有新建带标记的文件、没有新建机器命名文件;**行数增长本身不判红**。原因:并发的生产会话不断写真台账,契约勘误 3 的 (e)(i)(k) 已裁定环境性增长不算红(spec 审 K7)。真根一律由脚本自身位置推出,不由环境变量推出(spec 审 K8)。监视集 = 契约 home_only_proof(b) ∪ `.shadow/*` ∪ `.pmm-index-lkg/*`(spec 审 K23)。金丝雀「台账不再污染」哨兵(基线现为 613,不是 572)必须保持绿(spec 审 K24)。
17. **开工时序**:活体 fab 盲攻 + codex 终审的 confirmed 修复落地并冻结(HEAD 记入本节:`506a370`,v2.26 批收口)(spec 审 K24)后开工;建造期间活体其它守卫冻结,一文件一建造者。
18. **退出判据补一条**:C1 前置清单(FINAL-SPEC §5「C1 硬前置」**九条** 1–9;该节标题写「七条」是笔误)(spec 审 K24)逐条实跑证据附在 C0.5 收口报告;`Cause:` 边的推送(v3 §3 邻域固定序第③项)在影子日志中可见且与 golden corpus 的图题答案一致(图题金丝雀在 C0.5 先以影子模式跑出 Recall@1/@3/MRR 基线)。活体语料的 `Cause:` 字段行为 0,所以这一项只能在 golden 夹具上验收:对 `fixtures/v3/`(如 `supersedes-cause-follows.md`)构造 Edit 事件,断言影子日志里**截断前**的候选序列满足 §3.1 固定序(①直接 ②因/果 + 较早/较晚 ③Follows ④类计数),并与夹具期望 JSON 逐项相等;变异「删掉 Cause 分支」必须变红;≥200 条实时事件的对照不承担此项(spec 审 K19)。
19. **借用来源(Jax 09-17 铁律)**:交付物 6(`pmm-search-v2`)的排序引擎 vendor `lucaong/minisearch` 7.2.0(MIT)到 `guards/vendor/minisearch/`,精确命中置顶与字段权重(§3.2)在包装层实现,不改 vendor 文件;Wilson 下界如需在 C0.5 出现,用 `msn0/wilson-score-interval`;路径判定复用已 vendor 的 `guards/vendor/path-is-inside.cjs`。来源 URL、版本、许可证与上游正文 sha256 统一记在 `guards/vendor/VENDOR.md`;文件头只允许加前置注释,正文与上游逐字节一致;指纹 glob 由 `vendor/*.cjs` 改为 `vendor/*`——今天的 `acorn.js` 就没被覆盖,minisearch 的 `.js` 同样不会被覆盖(spec 审 K25)。
20. **fab 盲攻 09-17 落到 C0.5 面的项**:MEDIUM-4② `Cause:` 语义(写时不拒不改但被拍扁成普通链接;manifest B1 不验 Cause 目标)在 C0.5 统一 hook 的推送候选里实现 v3 §3 邻域固定序第③项(Cause 边);~~manifest `--check` 加 Cause 目标校验~~ 删除:core 里已有(`pmm-core.cjs:1094` B1 Cause 悬空、`:1128` B10);若指 v1 `pmm-manifest.cjs`,则属于改旧闸,违反边界(spec 审 K19)。LOW-1 ≤1.2KB 配额加代码闸(超出即截断并记 `quota-truncated`),实现在影子 hook 的推送装箱里;活体 `pmm-trigger-recall.cjs` 只有 23 R2 的再推载荷受同一道闸(spec 审 K12)。seen 键按 (session, agent) 已在 9e4f477 落地,统一 hook 沿用同一**键函数**,状态落自有的 `.shadow/seen-*`(见第 14 条)(spec 审 K17)。


## 补遗二(2026-09-23 定稿;Jax 拍板「执行」,来源 = s-cyc 探针泄漏「已推送仍复发」样本 + 吸收的建议卡;spec 审 `audits/OPUS-2026-09-23-c05-spec-review.md` 的 27 条裁决全部采纳,本节按裁决整节重写)

头注:21、23 R2、26 是活体闸改动,不受本文件标题「不拦、不注入」约束(spec 审 K12)。建造顺序与审查见节末。

21. **隔离闸 `guards/pmm-isolation-gate.cjs` + 薄壳 `pmm-isolation-gate.sh`**(PreToolUse `Bash`;确定性;fail-open;用例 = `specs/isolation-gate-contract.json` v1.0,建前注册,不属于 pipe-gate 契约)(spec 审 K1–K6、K27)
   - **判定单位 = 段**:取 `pmm-cmd-parse.parseCommand(command).segments` 的全部段,包括方言递归出来的子段(`scope_id≠root`,例如 `bash -c '…'` 的内层)。**不改解析器**(spec 审 K3)。
   - **DUT 段**,满足任一即是:
     - (a) exe ∈ {node, bash, sh},且首个非选项参数(跳过以 `-` 起的 token)的 basename ∈ DUT 集;
     - (b) exe 本身是被直接执行的脚本(`./x.sh`、`~/…/x.sh`),其 basename ∈ DUT 集;
     - (c) exe=node 且带 `-e|-p|--eval|--print`,代码串里含 DUT 集任一 basename;
     - (d) 段的 `parse_status=unsupported:*`,且其源文本(`source_span`)含 DUT 集任一 basename——保守判,例如 `out=$(… | node …/pmm-trigger-recall.cjs)`;
     - (e) exe 以 `-` 开头,且段源文本含 DUT 集任一 basename。这是解析器对 `env -u/-i/-C …` 的已知误解析:实测 `env -u PMM_HOME bash g.sh` 会被解析成 exe=`-u`,按 (a)(b) 会漏判,所以单列一条保守判(spec 审 K3,落笔补)。
   - **不是 DUT 段**:
     - 只查语法的调用:`bash -n`、`sh -n`、`node --check`、`node -c`;
     - exe ∈ {`source`, `.`};
     - exe 不在 {node, bash, sh}、自身也不在 DUT 集的段,例如以守卫路径为参数的 `grep`、`sed`、`cat`、`git`、`cp`、`diff`。
     - basename 比较一律小写(spec 审 K4)。
   - **DUT 集** = basename(`<真 home>/.claude/guards/*.cjs|*.sh`) ∪ basename(`<真 home>/.claude/memory/_local-config/hook-manifest.txt` 的全部条目)。
     - **真 home** = 闸自身位置 `path.resolve(__dirname,'..','..')`,不读 HOME/USERPROFILE/PMM_HOME。
     - 集合在运行时列目录得出,不写死清单(spec 审 K1/K4)。
   - **允许名单**:写成闸源码里的常量;改名单要走指纹,并同步改契约用例。
     - `ALLOW_ANY`(任何参数都放行,因为它们内部自行隔离,而且必须读真根):`guard-canary.sh`、`pipe-gate-v2-acceptance.cjs`。
     - `ALLOW_PROD`(生产读写工具):**段里没有独立 token `--self-test|--self-check|--selftest` 时**放行;带了这些 token 就按 DUT 判。成员:
       - 召回工具:`pmm-recall-label.cjs`、`pmm-recall-precision.cjs`、`pmm-recall-queue.cjs`、`pmm-recall-baseline.cjs`、`pmm-recall-m3.cjs`、`pmm-recall-classify.cjs`;
       - 守卫运维:`pmm-fingerprint.sh`、`review-stamp.sh`、`review-gate.sh`、`lesson-channel-lint.sh`、`pmm-c0-canary-check.sh`;
       - core/manifest/迁移:`pmm-core.sh`、`pmm-core.cjs`、`pmm-manifest.cjs`、`pmm-manifest.sh`、`pmm-manifest-v2.cjs`、`pmm-manifest-shadow.sh`、`pmm-manifest-shadow.cjs`、`pmm-migrate-v3.cjs`、`pmm-migrate-v3.sh`、`pmm-trigger-compat-replay.cjs`;
       - 手动跑的 hook 脚本:`pmm-size-watch.sh`(`/read-pmm` 第 5 步要跑)。`pmm-autopull.sh` 已于 v1.3(第27条)移出——它的裸跑(无参数)本身就对真根 `git pull --ff-only`,过不了 27 条的 ALLOW_PROD 准入证明(「无参数 + 空 stdin」运行前后 `$T` 全树 sha 不变);它仍照常接在 SessionStart hook 上运行,不经本闸,移出只是收回「不带三变量前缀裸跑」的许可;
       - C0.5 预留名:`pmm-shadow-compare.cjs`、`pmm-shadow-replay.cjs`、`pmm-precommit-shadow-replay.sh`、`pmm-index-emit.sh`、`pmm-search-v2.sh`、`pmm-search-v2.cjs`。这些工具的 DUT 子进程必须在工具内部经 22 的 `isoEnv()` 起,由 22 的名册核验。
       - 记忆运维 CLI(2026-09-24 主脑补,Opus 批审 K1/K2 误拦 + 停机钩子提示被拒实证;同日代码侧已加,契约/本条文当时未同步,v1.3 收口补齐):`pmm-receipt.sh`、`pmm-search.sh`、`pmm-grep.sh`、`pmm-recall.sh`、`pmm-pointer-lint.sh`、`pmm-redundancy-lint.sh`、`pmm-banner.sh`、`hermes-memory-freshness.sh`、`pmm-canary.sh`——一个 agent 会主动在 Bash 里直接敲的生产记忆运维工具,其真根写入(收据 spool、热度日志、名册刷新等)是被有意调用时的设计行为,不是裸跑泄漏。
     - 名单**只豁免本段**,同一命令里的其他段照判(spec 审 K1)。
   - **完整重定向集**——DUT 段放行的唯一条件(spec 审 K2):
     - 同段**前缀赋值**(`segment.assignments` 中 kind=`command_prefix_assignment` 的项)必须同时含 `HOME`、`USERPROFILE`、`PMM_HOME`,且三者的 `decoded_value` 相同。
     - 该值须满足:
       - ① 不等于、也不以 `$HOME`、`${HOME}`、`$USERPROFILE`、`${USERPROFILE}`、`~` 开头;
       - ② 如果解析出来是字面值(没有未解析变量),则不能等于真 home,也不能落在 `<真 home>/.claude` 之下。比较前先把 `\\` 换成 `/`、转小写、去掉结尾的 `/`,并把 MSYS 的 `/c/…` 与 `C:/…` 视为等价。**注意:这里不能写成「不在真 home 之下」**——Windows 的临时目录 `<真 home>/AppData/Local/Temp` 本来就在真 home 下,而且是合法隔离点(spec 审 K2,落笔修正)。
       - ③ 如果 hook 进程自身的环境里有 `PMM_RECALL_ROOT`、`PMM_TRIGGER_MEM`、`PMM_TRIGGER_STATE`、`PMM_TRIGGER_LOG`、`PMM_MEM_DIR` 中的任一个,该变量也必须出现在同段前缀里,值同样受 ①② 约束。
     - 下列写法一律**不算**:`env X=…`、`env -u …`、`export …;`、`set -a`,以及写在别的段上的前缀(实测解析器会丢掉 `env` 的赋值,并把 `env -u` 的 exe 认成 `-u`)(spec 审 K3)。
     - 变量形式的值(例如 `T=$(mktemp -d); HOME=$T …`)按原文比较后放行。本闸只挡遗漏,不挡蓄意绕过(与 review-stamp 同样的取舍)。
   - **输出**:
     - 放行:stdout 和 stderr 都是 0 字节,rc 0。
     - 拒绝:stdout 输出一行 JSON `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":…}}`,rc 0(照 `pmm-trigger-write-gate.cjs:84` 的做法)。**绝不能用 exit 2**:fail-open 包装 `|| {…; exit 0; }` 会把它吞成放行。
     - reason 用静态文案,包含:机器可读的 token `iso-reason=<code>`(码表见契约 `conventions.reason_codes`)、段号、DUT 的 basename、缺了哪几个变量、唯一正确写法 `HOME=$T USERPROFILE=$T PMM_HOME=$T <原段>`(T 是不在 `<真 home>/.claude` 下的临时目录)、「生产写入工具被误拦时,由主脑把它加进 ALLOW_PROD」,以及教训指针 `[tooling:selftest-must-redirect-every-root-the-tool-writes]`。
     - **不在热路径上读语料**(spec 审 K27)。
   - **拒绝留痕**(裁决:`blocked` 事件暂不加;spec 审 K6):
     - 拒绝时向 `<resolveRoot()>/isolation-denials-<host>.tsv` 以 O_APPEND 追加一行:`ts sid_sha16 agent_sha16 tool_use_id segment_indexes dut_basenames missing`。写失败时静默。
     - 不写 v3 台账。
     - 已知偏差(实测):被拒命令的并行 Pre 钩子照样会写 `observed`、`would-warn`,还会留下等不到 Post 的 pending。M2/M3 暂时不剔除这些行;这个文件就是将来加 `blocked` 勘误时回填的数据源。
   - **接线与故障**:
     - `settings.json` 的 PreToolUse matcher `Bash` 追加一条:`bash "<abs>/guards/pmm-isolation-gate.sh" || { echo "pmm-isolation-gate 自身故障 — fail-open 放行" >&2; exit 0; }`。镜像 `_local-config/settings.json` 与 `hook-manifest.txt` 同步修改。
     - 内部异常:rc 1,由包装器打印一行 fail-open 提示,不静默。坏 JSON、空 stdin、tool_name 不是 Bash:放行,且 0 字节输出。
     - 同一事件的各 hook 是并行跑的,settings 里的书写顺序不代表执行顺序。
     - 时延:测 20 次,中位数写进报告(目标 ≤150 ms,只报告,不判红)。
   - **范围外**(KNOWN-GAP,写进闸的头注):
     - PowerShell 工具:settings 里没有 PowerShell 的 PreToolUse matcher,本批不做(spec 审 K5);
     - 由脚本内部间接调用守卫,例如 `bash my-probe.sh`;
     - 蓄意用变量绕过。
   - **自证**:`--self-test --contract <path>` 对契约的每一例,都从**接线命令串**起一个进程,用临时根。同时跑契约里定义的两个变异,要求得到精确的失败集。金丝雀 +1 行。

22. **自测结构名册**(A 批第一步,**先于 21**;spec 审 K7–K10)
   - **共享助手**(新建):`guards/selftest-iso.cjs` 导出 `realHome()`、`isoEnv(T, extra)`、`footprint.begin()`、`footprint.end(markers)`、`markersFromSource(file, nonce, runRootBase)`;`guards/selftest-iso.sh` 提供同名的 shell 版(`selftest_iso_env`、`selftest_footprint_begin`、`selftest_footprint_end`),内部调用 `.cjs` 求值。
     - `realHome()` = `path.resolve(__dirname,'..','..')`。**禁止**从 HOME、USERPROFILE、PMM_HOME、PMM_RECALL_ROOT 推出。原因:21 落地后,自测只能在重定向下跑;真根若随环境变量走,零足迹断言查的就成了临时目录(spec 审 K8)。
     - `isoEnv(T, extra)` 返回 process.env 的副本,其中:
       - HOME=USERPROFILE=PMM_HOME=T;
       - `PMM_RECALL_ROOT=T/.claude/.local/pmm-recall`;
       - `PMM_TRIGGER_MEM`、`PMM_TRIGGER_STATE`、`PMM_TRIGGER_LOG` 都落在 T 下;
       - 删掉环境里其余所有 `PMM_*`;
       - `extra` 只能新增键,或者把 `PMM_MEM_DIR` 指向真语料(仅限只读用途)。
     - **监视集**(= 契约 home_only_proof(b) ∪ C0.5 新写面,spec 审 K23),都在真 home 下:
       - `.claude/.local/pmm-recall/` 下的 `{events-v3-*,queue-*,quarantine-*,trigger-log-*,isolation-denials-*}.tsv`、`policy.json`、`receipts-*.log`、`pending/*`;
       - `.claude/.trigger-seen-*`;
       - `.claude/memory/dreams/trigger-log-*.tsv`;
       - `.claude/.shadow/*`、`.claude/.pmm-index-lkg/*`、`.claude/.pmm-len-baseline*`。
     - **判红**(与契约勘误 3 同一口径,spec 审 K7):
       - ① 已存在的文件,首尾之间新增的字节里含任一标记;
       - ② 新建文件的文件名或内容含标记;
       - ③ 新建了机器命名文件(events-v3、queue、quarantine、trigger-log、policy.json)。
       - **不判红**:行数增长本身、文件删除、不带标记的新增(视为环境性)。
     - **标记** = 下列各项之并:
       - 本次运行的 nonce(所有合成 id 都嵌入它:`test:<nonce>-…`、`toolu_selftest_<nonce>-…`);
       - 运行根的 mkdtemp basename;
       - `markersFromSource`:静态扫描本自测源码里全部的 `session_id`、`sessionId`、`tool_use_id` 字面量,并派生出 `sha16(sid)`、`.trigger-seen-<seenKey(sid,agent)>`、截断后的 session。这一条关掉 A3-N1 和终审勘误候选 3,不再依赖「经入口登记」。
   - **名册 `SELFTEST_STRUCTURE_ROSTER`**(金丝雀源码里的常量)初始有 5 个:`guards/pmm-trigger-recall.sh`、`guards/pmm-trigger-compat-replay.cjs`、`guards/bash-pipe-exitcode-watch.cjs`、`guards/pmm-bash-impression.cjs`、`guards/pmm-recall-m3.cjs`。
     - 名册外的守卫只 report-only,打印缺项计数。
     - 新增的守卫自测必须入册,或者登记豁免并写明理由(spec 审 K10)。
   - **金丝雀新增一行「自测结构名册」**:静态检查,秒级完成。对名册里每个文件:
     - `.sh` 文件:
       - 非注释行里,匹配 `(node|bash|sh)[[:space:]]+("?[^"[:space:]]*/)?(<DUT 集 basename 的正则并集>)`、但行尾不带 `# DUT-ENTRY` 或 `# PROD-ENTRY` 的行数必须 = 0。
       - `# DUT-ENTRY` 行只能出现在文件头 `# ISO-ENTRIES:` 注释所列函数的函数体内,而且这些函数体都要调用 `selftest_iso_env`(spec 审 K9:不再只认字面的 `node "$G/…cjs"`)。
     - `.cjs` 文件:在 `// SELFTEST-BEGIN` 与 `// SELFTEST-END` 之间检查(标记由建者加;缺标记 = 红):
       - `Object.assign({}, process.env`、`...process.env`、`env: process.env` 出现次数都 = 0;
       - 每一处 `spawnSync(`、`execFileSync(`、`execSync(`、`spawn(` 调用,从调用处起 6 行内要含 `env`;
       - 进程内的 `writeEvent(` 调用要含 `root`;
       - `isoEnv(` 至少出现一次。
     - 两类文件都要求:源码里有 `footprint.begin` / `selftest_footprint_begin` 以及对应的 end,并且 end 的结果并入 rc(有泄漏 ⇒ rc≠0)。
     - 名册文件(**包括 `.sh`**)里的 `session_id`、`sessionId`、`tool_use_id` 字面量必须带 `test:` 或 `toolu_selftest_` 前缀。这一条补上终审勘误候选 1 指出的 `.sh` 缺口,而且不用改 runner。
   - **现状**(审计 §2.2):5 个里没有一个两项都齐全。
     - trigger-recall:① 和 ② 都只做到一部分;
     - compat-replay:缺 ①;
     - bash-pipe:② 只比较文件名集合;
     - impression:缺 ①,② 不含台账;
     - m3:① 和 ② 都缺。
     - A 批逐个补齐。其中 `bash-pipe-exitcode-watch.cjs` 和 `pmm-bash-impression.cjs` **只改 SELFTEST 段**,`SELFTEST` 摘要行的格式(契约 `self_test_summary`)保持不变。
   - **双环境都要绿**:名册里每个自测,在真实 HOME 下和在 `HOME=USERPROFILE=PMM_HOME=$T` 下都必须 rc 0。

23. **风险时刻再推**(B 批;同时写进 M-SPEC 备注 #6;spec 审 K11/K12)
   - 风险动作是一个闭集,每种动作有且只有一个宿主:
     - **R1**:Bash 段调用了 DUT,且没有完整重定向。由 21 的拒绝文案承载;不另外推送,也不改 seen。
     - **R2**:对 `<repo=home>/.claude/guards/**` 做 Edit 或 MultiEdit,`tool_input.old_string`(MultiEdit 取各 edit 的并集)里含 `HOME=|USERPROFILE=|PMM_HOME=|PMM_RECALL_ROOT=|PMM_TRIGGER_(MEM|STATE|LOG)=|PMM_MEM_DIR=` 中任一赋值,而对应的 `new_string` 里已经没有**这个变量名**的赋值。由 `pmm-trigger-recall.cjs` 承载。Write 工具没有 old_string,所以不判 R2(KNOWN-GAP)。
   - **R2 的行为**:
     - 对本事件直接命中的 tag,如果它已经在 seen 里、而且**还没再推过**,就再推一次。
     - seen 键 = `seenKey(session_id, agent_id)`,即 M-SPEC 备注 #5③,含 `nosess` 回落。这个键函数由 B 从 trigger-recall 挪到 `pmm-recall-ledger.cjs` 导出,trigger-recall 和影子 hook 共用。
     - 每个 (seenKey, tag) 最多再推一次。记账方式:在同一个 seen 文件里追加一行 `repush:<tag>`。这样 `/^\.trigger-seen-/` 覆盖的全部哨兵和 autopull 的 GC 都自动覆盖到;**不得**另起前缀。
   - **臂**:再推要经过 `pmm-recall-policy.resolve()`。
     - randomized 且落在 shadow 臂:只写 `eligible` 和 `suppressed(policy-shadow)`,stdout 不含这条推送。
     - intervene 臂或未随机化:写 `displayed`,`run_provenance` 追加 `repush:R2`,供 M3 分层。
   - **载荷**(只用于 R2 再推;普通推送的载荷不变):
     - 取条目里第一个 `^What to do instead:` 行,去掉前缀,按码点边界截到 ≤320 B,截断时结尾加 `…`;没有这一行就退回标题。
     - 整条 additionalContext ≤1200 B(按 UTF-8 计);超出就逐条截断,并在 tlog 记 `quota-truncated`。
     - 这是对 M-SPEC M4「等 M1 精确率闸」的显式豁免,范围只限 R2。
   - 切换时刻写进 CHANGELOG。当前真根没有 `policy.json`,也没有正在进行的随机化实验。

24. **读信号**(B 批,可拆给 C;需要契约 v2.26 勘误 4,即 `event_universe` 加 `read`;spec 审 K13/K14)
   - **写者 = `pmm-bash-impression.cjs`**(PreToolUse Bash,它手里已经有 session_id、agent_id、tool_use_id)。
     - `pmm-search.sh` **不改**:它拿不到 agent_id。Bash 环境里只有父会话的 `CLAUDE_CODE_SESSION_ID`,这个变量也不在文档里;而且该脚本位于 memory 仓。
   - **条件**:段的脚本操作数 basename 是 `pmm-search.sh` 或 `pmm-grep.sh`(exe 为 bash/sh,或者直接执行)。
     - 取参数:`pmm-search.sh` 取第一个非选项参数,`pmm-grep.sh` 取第二个参数;去掉引号、转小写。
     - 只有与某个 live 身份 tag **完全相等**时才写一行;非身份的查询不写。
     - stdout 仍然是 0 字节(契约的 silence 不变)。
   - **列**(审计 §2.4):
     - `event_kind=read`;`trigger_or_gate_id` = 匹配到的身份;`gate_instance_id` = `read:<segment_index>`;
     - `class_tag` = 该条目的 `Class:` 目标,没有就留空;
     - `gate`、`confidence`、`mode` 留空;
     - `run_provenance` = `read:pmm-search` 或 `read:pmm-grep`;
     - `read` **不**放进 `informational_events`。
   - **报告**:`pmm-recall-baseline.cjs --report`(M2)增加两列:
     - `proxy_pushed_not_read_via_search`:同一 sid_sha16+agent_sha16+tag 有 `displayed`,但之后没有 `read`;
     - `proxy_read_then_recurred`:`read` 之后,在同一 (session, agent, class) 的窗口内复发;复发口径同 B3 补注。
     - 口径里注明:Grep 工具、Read 工具、裸 grep 都不计入读信号。M1 报告不改。

25. **~~建造者纪律自动注入~~ 移出本批,见 backlog**(spec 审 K15)
   - 移出原因:
     - 原文点名的 `workflow-model-guard.sh` 管的是 Workflow 工具;
     - Agent 派发由 `agent-model-guard.sh` 负责,经 `model-guard.sh` 分发,而后者处于冻结期(至 2026-10-14)且 fail-closed;
     - 全仓没有用过 `updatedInput`,文档里也没有 Agent 的示例,必须先用新会话做 nonce 探针。
   - backlog 设计要点:
     - 独立的 fail-open hook `guards/agent-discipline-inject.sh`(PreToolUse `Agent`),是全仓唯一返回 `updatedInput` 的 hook;
     - 只返回 `{prompt}`,不带 `permissionDecision`;用 `<!-- DISCIPLINE v1 -->` 保证幂等;
     - 是否算 builder,按该 subagent 定义里的工具集判断;
     - 已知不覆盖:SendMessage 续派、Workflow 内的 `agent()`、codex 或 `claude -p` 起的执行体。
   - 本批用建造简报里的纪律段代替。

26. **金丝雀三态**(A 批;落实 `[process:summary-layer-must-not-count-skip-as-pass]`;spec 审 K16)
   - **`run()` 三态**:
     - rc 0 → PASS;
     - rc **77**,且行名在 `SKIPPABLE` 表里(源码常量表,每一项都带理由)→ SKIP;
     - 其余非 0(**包括 2**)→ FAIL;
     - rc 77 但不在表里 → FAIL。
   - **计数**:
     - 用一个「已执行行」计数器:run() 每跑一行 +1,手动计分的 VIA、M-2 两行也各 +1。判据改为 `executed == EXPECTED`,替换现在的 `pass+fail`。
     - `ax_freshen` 改成独立的一行,红绿都计入,消除现在「一件事报两次红」的问题。
   - **摘要行**:`guard-canary: pass=P fail=F skip=S expected=E`,字段顺序与 scope-test 的摘要行一致。
     - SKIP 行打印 `⊘ <名>:<理由>`,理由取该行命令 stdout 的最后一行。现在 `run()` 把输出全丢进 /dev/null,SKIP 和 FAIL 事后都没法诊断。
     - 只要本次跑法里有 SKIP,就不许出现 `N/N` 式的措辞。
   - **rc**:F>0 → 1;F=0 → 0。
     - stamp 只在 F=0 时写,内容附上 `skip=S`。
     - autopull 的灯要不要显示「S 台跳过」,列入 backlog,不在本批写面内。
   - **现有的「不适用」静默出口**改成 `exit 77`,并加进 SKIPPABLE:`:108`(真台账缺失)、`:131`(冻结 trigger-log 缺失)、`:655`/`:659`/`:660`(夜巡未装或未跑)。
     - scope-test 那一行保持「SKIP 即红」,**不进表**,守住 CO 已验收的性质。
   - **`--self-test` 新增三项**:`synthetic-must-skip`(表内的 77 → SKIP)、`synthetic-skip-not-allowlisted`(表外的 77 → FAIL)、`synthetic-rc2-is-fail`(rc 2 → FAIL)。连同原有两项,期望结果为 pass=1 fail=3 skip=1。
   - runner 的名册检查按子串匹配(`pipe-gate-v2-acceptance.cjs:4857-4870`),行格式改动不影响它。
   - **EXPECTED 算术**:
     - 本批:+1(21 自证)+1(22 名册行)+1(`ax_freshen` 独立成行);
     - 26 自身 +0,它的自证在 `--self-test` 里;
     - 25 已移出;C0.5 影子行由 B 批另外 +1;
     - 不写死数值。A 批由 A 在 26 那一笔里改为「开工时 HEAD 值 + 3」(A 是 `guard-canary.sh` 在本批的唯一写者);B 批的 +1 由收口者改。

**顺序与审查**(spec 审 K8/K26):
- **A 闸批**:**22 → 21 → 26** 串行,由一个建造者完成。22 必须先于 21,理由见 K8。
- **B 主体批**:第 1–6、8、10–12、14–18、20 条加 23、24;第 7 条作废,25 已移出。A 收口之后开工。第 6 条与 24 可以拆给 C,和 B 并行,写面不相交(见审计 §4);不开 C 就全部并入 B。
- **审查**:A 批建完做一次 Opus 审;B 批在批末做一次 Opus 审。
- **契约**:
  - v2.26 勘误 4(`event_universe` 加 `read`)由主脑在 24 开工前注册。
  - 21 的用例放在新契约 `specs/isolation-gate-contract.json`,建前注册,不并入 pipe-gate 契约。
  - B2-N1(改 `bash-pipe-exitcode-watch.cjs` 和 `pmm-cmd-parse.cjs`)不能与 A 并发。

## 勘误(2026-09-24 批审 `audits/OPUS-2026-09-24-c05-batch-review.md` E-5/E-6/E-9/E-10;主脑注册,与 F1 落地 `6bac91d` 对齐;E-1/E-2 已由隔离闸契约 v1.1 `87ccad5` 承载;E-3/E-4/E-7 走代码不走勘误;E-8 待 F2 落地后补)

- **E-5(第 23 条「载荷」补三点)**:① 装箱:普通推送块先装,R2 再推块只装进 **剩余** 预算;「整条 additionalContext ≤1200 B」指普通推送与再推同现时的整条;装不下的再推条整条不发,不截半条。② 台账 `displayed` 只记真正进了 stdout 的行;因预算未发出的记 `suppressed(cap)`,不记 displayed。③ R2 事件里新推(非再推)的 tag 进入 seen 后,在下一次 R2 事件可被再推一次——这是「每 (seenKey, tag) 最多再推一次」的规格行为,不是缺陷;建造简报「同一事件再来一次 → suppressed」只在前一次没有新推时成立。
- **E-6(交付物 2 tee 行格式,取代「追加一行 stdout/exit code」的原文)**:tee 行 = 7 列 TSV:`ts(UTC)`、hook 名(脚本 basename)、`tool_use_id`(缺则 `-`;从 stdin JSON 取 `tool_use_id`/`toolUseId`)、截断旗标、base64(stdout 原文,按 **原始字节 ≤1200 B** 截断后编码)、sha256(**完整** stdout)、rc。四个旧 hook 同格式;`PMM_TEE_LOG` 未设时行为逐字节不变;`--self-test`/`--self-check` 不 tee。建造简报「stdout sha」写法作废。
- **E-9(第 26 条 stamp)**:接受建者偏离——stamp 内容保持仅时间戳,**不附 `skip=S`**(autopull 用 `date -d` 解析 stamp,附加字段会破坏解析);S 只出现在摘要行 `guard-canary: pass=P fail=F skip=S expected=E`。autopull 灯显示 S 仍在 backlog。
- **E-7(第 21 条,runner part13 对 `pmm-isolation-gate.cjs` 规则①模式表的命中)**:该行是闸用来**拒绝**重定向值的家目录拼写表(`$HOME`/`${HOME}`/`$USERPROFILE`/`~`),是数据不是环境读取。裁定:**不得**用字符串拼接/转义/fromCharCode 等混淆躲扫描(09-24 三种写法均被自动模式判「绕过」,主脑否决此路);正解 = runner `HOME_SCAN_LINE_ALLOWLIST` 加一条精确行条目(kind=read,不限 pattern,理由写明「数据非读取」)+ pipe-gate 契约 `home_literal_scan` 记为 v2.26 勘误 5。主脑的加条目脚本同样被自动模式拦下,**由 Jax 亲自执行**(scratchpad `e7-allowlist.cjs`);落地前 runner part13 保持 1 处已知命中,金丝雀相应行按红计,不改 EXPECTED。
- **E-8(第 22 条三点补写)**:①「SELFTEST 段」= 整个 `--self-test`(含 `--self-check`)块,`// SELFTEST-BEGIN`/`END` 必须是**单一对**把它整体包住(嵌套或分段标记会被 runner 非贪婪匹配截断,视为缺标记=红);②`# PROD-ENTRY` 只能出现在文件的生产入口段(不在任何 `# ISO-ENTRIES:` 所列函数体内),且一个文件最多标注实际的生产调用行,不得用它给自测调用免检;③`markersFromSource` 派生标记加 `.shadow/seen-<seenKey>`(影子 hook 的 seen 文件与 `.trigger-seen-` 同族)。
- **E-11(交付物 4 列②数据源)**:「当时拦而 v3 不拦」在「提交存在=当时未被拦」定义下对历史提交**结构性恒空**(被拦的提交不存在,也无拒绝记录)。C0.5 接受字面实现,列②保留但恒 0 并在报告里注明;要让列②非平凡需要拒绝记录(precommit 影子日志 `precommit-<mach>.log` 自 B3 起开始积累的 fail/msg 即为此数据源),留 C1 用真实拒绝记录回填。
- **E-12(第 22 条「双环境都要绿」与第 21 条闸的冲突;Opus wave-2 裁定)**:名册自测「真实 HOME 下也 rc 0」这一半改由**金丝雀那次运行**承担(金丝雀自身在壳内隔离后跑名册);建造者与主脑只需报临时 HOME(`HOME=$T USERPROFILE=$T PMM_HOME=$T`)下的结果。隔离闸**不**为 `.sh` 壳放行(放行即重开 `bash pmm-trigger-recall.sh` 裸调的原始事故形态);`node <DUT>.cjs --self-test` 形态对没有该分支的工具(如 `pmm-trigger-recall.cjs`)等于 hook 模式,自测一律走 `.sh` 壳。
- **E-13(交付物 1/2 影子日志的 echo/routing 字段;Opus wave-2 H2①)**:spec 未定义影子日志 `echo`/`routing` 的语义,W3-B 依「spec 不明处停手」未填。定义:`echo` = 权威 `pmm-write-echo` 对本事件会回显的 tag 集合(按其现行规则重算,不调用它);`routing` = 权威 `pmm-lessons-routing` 对本事件的路由判定(目标文件/ns);二者在影子 hook 内按与权威逐字一致的规则计算(同 H1 对推送的要求),对照器三维全部计入未解释。这是 C1 前置(统一 hook 替代四旧 hook 的必要条件),列下批 W4 首项,不在本波修。
- **E-10(第 21 条时延目标写明测量点)**:「≤150 ms 中位数」的测量点 = `pmm-isolation-gate.cjs` 进程本体(stdin 到决定输出,不含 bash 薄壳与 node 启动);接线全链(壳 + node 启动 + 闸)另报一个数(09-24 实测约 240 ms),两数不可比,报告必须标明测量点;二者都只报告不判红。

## 补遗三(2026-09-24 W4;来源 = Opus 复审 NO-GO #2 `audits/OPUS-2026-09-24-c05-wave3-review.md`;主脑裁决,spec 审后开建)(2026-09-24 Opus spec 审后改写,审查档 scratchpad/OPUS-spec-review-addendum3.md → 主脑落档)

27. **隔离闸 v1.3:结束窄化,回到 fail-closed**(HIGH-1 同类第二次复发)。只改 `pmm-isolation-gate.cjs`,不改 `pmm-cmd-parse.cjs`(K3);`:427` 家目录拼写表逐字节不动,不新增含家目录拼写字面量的行(E-7)。
   - **归一 N**(规则 a–e 共用;施于段源文本、每个 operand、前缀赋值值、重定向目标):① 小写;② `$'…'` 按 ANSI-C 解码 `\xHH`/`\NNN`/`\uHHHH`;③ 删除全部 `\`、`'`、`"`;④ `$(…)`、`` `…` ``、`${…}`、`$NAME` 各替换为占位 `*`;⑤ 花括号展开(每 token ≤64 项,超出即算命中);⑥ basename 去尾随 `.`/空格与 `:流` 后缀(同 `core.normalizeWin32PathForCompare`)。**命中**,满足任一:(i) N 后文本含 DUT basename 子串;(ii) 某 token 的 basename 是含 `*?[` 的模式,能匹配 ≥1 个 DUT basename,并且 [basename 除扩展名外至少有 1 个字面字符,或字面目录部分含 `.claude/guards` 或 `.claude/memory/_local-config`,或没有目录部分而有效 cwd 在上述目录下(有效 cwd = hook JSON 的 `cwd`,经同一命令中先于本段的 `cd <字面路径>` 更新;`cd` 目标含变量时有效 cwd 视为未知,按不满足处理并列入 KNOWN-GAP)];(iii) basename 符合 8.3 别名形态 `^[^~/]{1,6}~\d{1,2}\.(cjs|sh)$`(不查文件系统,保守判)。
   - **rule (d)**:`unsupported:*` 段 N 后命中 → **无条件拒**(`unsupported-structure`,不看前缀赋值,同 v1.0)。对 unsupported 段先求 rule (d);`source`/`.` 与语法检查豁免只对 `parse_status=ok` 的段生效。rule (d) 段不适用任何 ALLOW 豁免。解析器抛错时,原命令 N 后命中 → 拒(新码 `parse-error`),未命中 → 放行。
   - **ok 段**(以下是闭集,替代「包装形态…等」):
     - exe ∈ {node,bash,sh,zsh,dash}:满足任一即 DUT 段 —— 任一 operand 的 N-basename ∈ DUT;node 带 `-e/-p/--eval/--print`(含 `-pe` 这类合并短旗标、`=` 融合形式)时任一 operand 的 N 文本含 DUT 名;`-r/--require/--import/--loader/--experimental-loader`(含 `=` 形式)的值 N-basename ∈ DUT;`<` 目标 N-basename ∈ DUT;没有脚本 operand、或 operand ∈ {`-`,`/dev/stdin`,`/dev/fd/0`,`/proc/self/fd/0`}、或带 `-s`,且同一管道组上游段或 stdin 重定向目标 N 后命中。
     - exe ∈ {source,.}:operand 的 N-basename ∈ DUT 且 ∉ `SOURCE_LIB_OK`={`pmm-home.sh`,`selftest-iso.sh`}(逐个证明无副作用;改名单走指纹) → DUT 段;以 stdin 为源、上游或 heredoc 命中 → DUT 段。
     - exe ∈ `NON_EXEC_EXE` 闭集(cat head tail less more grep egrep fgrep rg sed wc ls stat file diff cmp comm sha256sum sha1sum md5sum cksum sort uniq cut tr basename dirname realpath readlink echo printf test [ jq cp mv rm mkdir touch chmod ln base64 xxd od cd pwd true false;主脑定稿):非 DUT 段。例外:sed 的脚本参数(`-e` 值或首个非选项参数)N 后含 DUT 名 → DUT 段。
     - git:默认非 DUT 段。满足任一即对其代码串做 N 扫描,命中即 DUT 段:`-c k=v` 的 k ∈ {alias.*(值以 `!` 开头), core.editor, core.pager, core.sshCommand, core.fsmonitor, core.hooksPath, sequence.editor, diff.external, diff.*.textconv, diff.*.command, merge.*.driver, filter.*.clean, filter.*.smudge, filter.*.process, credential.helper, gpg.program};子命令 `rebase -x/--exec`、`bisect run`、`submodule foreach`、`filter-branch --*-filter`、`difftool -x/--extcmd`。
     - 任一 exe 的前缀赋值:名字 ∈ {GIT_EDITOR, GIT_SEQUENCE_EDITOR, GIT_PAGER, GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF, GIT_ASKPASS, SSH_ASKPASS, EDITOR, VISUAL, PAGER, BASH_ENV, ENV, NODE_OPTIONS},且值 N 后含 DUT 名 → DUT 段。
     - 其余一切 exe(含 nice/ionice/stdbuf/exec/builtin/command/nohup/timeout/sudo/env/xargs/find/watch/flock/npx/winpty/script/cmd/powershell/pwsh/python/perl/ruby/awk 以及任何未列名命令):任一 operand、前缀赋值值或重定向目标 N 后含 DUT 名 → DUT 段。误拦的非守卫工具加完整重定向即可放行,或经指纹改动并入 `NON_EXEC_EXE`。
   - **豁免**:ALLOW_ANY/ALLOW_PROD 只对 ok 段生效,并且要求被豁免名恰好是该段判定出的**命令词**(node/bash/sh 跳过旗标值后的首个脚本 operand,或 rule (b) 的 exe),满足时豁免整段;名字出现在其他位置不豁免。对照组 = 去掉豁免名后,同一段必拒。
   - **契约 v1.3**(主脑建前注册,建者不写期望):
     - A21–A25 改判 deny(A22 命中 (ii),只读循环改用单条多文件命令)。A12–A16、A26 不变。D25–D48 保留。
     - 新增 deny:esc5 里「v1.0 拒/v1.2 放」的 25 例(H01、H04–H17、H19、S01–S06、S08–S10);esc5「三版全放」的 30 例去掉 W24 后的 29 例;esc6 的 10 例去掉 V06 后的 9 例;本审 X1–X8。
     - W24、V06 作为 allow 入契约,note 写「KNOWN-GAP:运行期 fail-closed / 变量来自命令外」。
     - 上面 ③ 表中每种替代写法各加一例 allow。
     - 每例 precheck 记 v1.0/v1.2 现状。两变异的 expected_failing 由 precheck 脚本对 v1.3 用例机械算出,主脑钉住,不手写。
     - v1_1/v1_2 addendum 里过时的「DRAFT…not yet copied」状态同时清理。
   - **扰动族**:对每个 deny 例机械生成扰动,全部必须 deny。扰动包括:连接符前插 `2>/dev/null`;解释器加 `.exe`、`-o pipefail`、`-O extglob`、`--no-warnings`;前置 `timeout 5`、`nice`、`stdbuf -oL`、`env`、`command`、`exec`;DUT 名做引号拼接、扩展名大写、路径改反斜杠、加尾随点。生成器放进 `guards/fixtures/`(`h3-verify` 同样迁入,不留 scratchpad)。
   - **ALLOW_PROD**:去掉 `pmm-autopull.sh`。代码常量、契约 `conventions.allow_prod`、第 21 条正文三处同步。准入证明逐个成员进行:在 isoEnv 下预置真根相关文件的副本,「无参数 + 空 stdin」运行,前后 `$T` 全树 sha 不变;源码里没有未经子命令门控的 `git pull|fetch|push|clone`。生产子命令的写集合逐个列进契约(ALLOW_PROD 的设计用途,不要求为零)。
   - **拒绝文案按 reason 码分写**。`unsupported-structure`/`parse-error` 给出「改成受支持的单命令形态」的具体换写法(提交信息用 `-F <文件>`;探针和提示词用 Write 工具落盘;循环改成单条多文件命令;捕获改成先写文件),不再写「前缀重定向」。其余码保持原文。
   - **自测**:契约全绿 + 两变异精确 + 扰动族全 deny + 坏契约 rc 1 + 时延按 E-10 双测点报告。E-12 不变。**建者不自验**:由 Opus 定向复审 rule (d)、ok 段判定和扰动族。
   - 主脑裁决(2026-09-24):`NON_EXEC_EXE` 闭集按报告第 72 行名单定稿
   - **借用来源(2026-09-24 调查 `scratchpad/BORROW-SURVEY-c05.md` → 落档 audits/):shell 解析层 vendor `unbash`(ISC,0 生产依赖,285KB,纯 JS AST)到 `guards/vendor/unbash/`,rule (d) 改为 AST 遍历(任何节点引用 DUT 路径且所属简单命令无完整重定向前缀即拒;heredoc 正文/命令替换/进程替换/source/包装命令均为 AST 节点,不再逐形态打补丁);备选 `sh-syntax`(mvdan/sh wasm)。手写 `pmm-cmd-parse.cjs` 退役为兼容层或删除。因果图与对照器不抄(领域算法/私有 schema,见调查)。扰动模糊测试改 vendor `fast-check`(MIT)。**
28. **影子写闸维度 = 旧写闸同口径重算**(HIGH-2)。
   - **相位**:只在 `--shadow --pre` 计算(旧写闸是 PreToolUse);Post 行不写写闸字段。
   - **输入**:编辑前 = Pre 时刻磁盘上的目标文件(同 `pmm-trigger-write-gate.cjs:120-122,150-157,196-201`);编辑后 = 与 `:178-192` 同算法在内存重建。
   - **规则逐字对齐旧闸**:作用域 = canonical 且 basename ∈ `core.ALL_FILES`;B5/B32 = 编辑后整文件经 `core.parseFile` 得出的诊断(绝对判定);B5/B32 非空即短路;presence = LIVE 三文件按 `titleKey` 新增、既无合法 trigger 也无 `trigger: none`;`parseFile` 抛错 → 两侧皆空;`PMM_TRIGGER_WRITE_GATE_DISABLE=1` → 标「旧闸停用」,不可比。
   - **键**:B5/B32 → `code|basename|L<行>`;presence → `presence|basename|<dateISO><dateRaw> — <title>`。影子与旧闸一样每类只截前 5 条并另记总数(旧侧总数取文案里的「含 N 处」「新增了 N 条」)。**对照** = 总数相等且前 5 键集合相等。旧侧键由对照器对 deny reason 做行首锚定解析,不再用全文 `[tag]` 扫描(`pmm-shadow-compare.cjs:366-367` 改掉)。
   - **v3 预观察**:B30 与 v3 全量 blocking 移到 `v3Pre` 字段,内容为 B30 + `core.check` 在编辑前/编辑后两快照上的**规范化多重集差**。仅当目标 ∈ `core.ALL_FILES` 时计算,报告单列,不计未解释。
   - **接口**(均为新增):core 导出 `snapshotWithOverrides(baseSnap, {<file>: Buffer})` 与 `diffBlocking(before, after)`(规范化同 `pmm-precommit-shadow-replay.cjs:55-57`,多重集差);precommit 影子块与 replay 改用它(顺带收掉 MEDIUM-6)。`reconstructProspective`/`titleKey` 二选一:(甲)移入 core 导出,旧闸改为调用。这属于旧闸改动,行为逐字节不变,旧闸 probe 自测全绿 + 指纹 refresh。(乙)影子侧保留副本,另加对照自测:≥30 组 Edit/MultiEdit/replace_all/Write/old_string 找不到的输入,两个实现输出逐字节相等。
   - **验收**(isoEnv,`$T` 下预置语料副本;不在活体语料上做,第 12 条):三文件各做一次内容不变的编辑 → 双侧皆空;引入一处非法 trigger 行 → 双侧同键;新增一个无 trigger 条目 → 双侧同键;一次引入 >5 处 B5 → 总数相同、前 5 键相同;引入 B7 重复身份 → 写闸维双侧皆空,`v3Pre` 含 B7,未解释 0;`DISABLE=1` → 不可比 1。影子自测不得再往真 `~/.claude` 写变异体(wave-3 LOW,`pmm-hook.cjs:906,988`)。
29. **E-13 扩写(五维定义;阻塞 C1 与 7 天起算)**
   - **E-6b(先于本条落地)**:四旧 hook 的 tee 行由 7 列扩为 9 列,在原 7 列后加 `base64(stderr ≤1200B)` 与 stderr 截断旗标。stderr 照常转发(先 `2>` 到临时文件,再 `cat >&2`)。`PMM_TEE_LOG` 未设时逐字节不变。四脚本同步修改,镜像同步,指纹 refresh。对照器同时接受 7 列与 9 列;7 列行的 routing/length 只比 rc。(如果主脑不批 E-6b:routing、length 两维降为 rc 维,下面的「命中行/检查类」对照删掉。)
   - **echo**:旧侧 = hook 名为 `pmm-entry-length-watch.sh`、带 tool_use_id 的 Post 行,**只在 rc=0 时**取其 stdout;rc=2 记 `echo-gated-off`,不比较,单列计数。值 = 回显行 `- [[tag]] …` 与 `- 你声明取代 [tag] …` 解析出的(tag, 状态)对,状态 ∈ {未在记忆库, 已被[X]取代, 现行, 已标记, 未标记},行首锚定解析。影子逐字复刻 `pmm-write-echo.cjs:9-64`(用它自己的正则与扫描序,不用 `core.analyze`)与前置筛 `pmm-entry-length-watch.sh:51-141`,记录「若完整性闸通过,会回显的(tag,状态)集合」。
   - **length**:旧侧 = 同一行的 rc(0/2)+(9 列时)stderr 中 `⚠️ <检查名>` 行映射出的检查类集合 {超长净增, Index 超长净增, 原话引用, Index 奇偶, 孤儿块, 伪装标题, 缺命名空间, 取代记账, 取代图, 冗余, Active 体积}。影子复刻这 11 项。
     - 第 14 条增补:影子**只在 Pre 相只读快照** `.pmm-len-baseline{,.idx}`(旧 hook 只在 Post/SessionStart 写,Pre 相读不会与本事件的写者竞态),按 tool_use_id 存成 `.shadow/pre-<tuid>.json` 给 Post 用;快照缺失 → 该事件 length 不可比。
     - 「取代图」「冗余」通过调用 `pmm-manifest.cjs --check`、`pmm-redundancy-lint.cjs` 计算,前提是二者先按第 27 条的准入协议证明只读;做不到证明时这两类记为不可比。
     - 第 11 条对 length 维例外:文件集由 core 新增导出 `LENGTH_WATCH_FILES()` 给出(`$MEM/*.md` 全体 + `progress.md`),影子本地不再列一份。
   - **routing**:旧侧 = hook 名为 `pmm-lessons-routing.sh`、带 tool_use_id 的 Post 行,值 = rc +(9 列时)stderr 命中行集合 `<行号>:<标题行>`。旧 hook 不读事件,所以删掉「目标文件」。影子复刻 `pmm-lessons-routing.sh:42-49`,对每个 Edit/Write/MultiEdit 的 Post 事件都计算。本维只验证复刻;C1 若用 B13 替代,另立允许类。
   - **push**:行锚定正则以生产者 `pmm-trigger-recall.cjs:609` 为准:直推行为 `^- \[`;链接行为 `^\s+↳ (同类成员|关联(\([^)]*\))?) \[`。R2 再推行(`pmm-trigger-recall.cjs:632` 的形态)归入允许类 `r2-repush`。自测夹具用真实 tee 行的 base64 原文,不手写。
   - **writer**:见第 28 条。
   - **配对**:按(tool_use_id, 维)配对。在域矩阵为:Pre × {Edit, Write, MultiEdit} → writer;Post × {Edit, Write, MultiEdit} → push/echo/length/routing;Post × NotebookEdit → 只有 push。在域内一侧有行、另一侧没有 = 未解释(`one-sided:<维>:<侧>`)。
     - **域外,不计**:tool_use_id 为 `-` 的 routing/length 行(SessionStart);影子的 `tool-not-in-scope` 行。
     - **未解释**:`pmm-trigger-recall.sh`/`pmm-trigger-write-gate.sh` 出现 `-` 行;影子 `stdin-read-failed|empty-stdin|bad-json` 行(记为 `shadow-intake`)。
     - **接线窗口**:CHANGELOG 登记的 [起, 止] UTC 区间入对照器配置作白名单,并打印在报告首行。
   - **不可比**:tee 截断旗标 = 1 → 该行派生的所有维不可比;截断旗标 = 0 但 sha 校验失败 → 未解释(`tee-corrupt`)。
   - **报告首行**:每维给 4 个数 —— 在域事件 / 可比 / 其中非空(至少一侧非空)/ 不可比。
   - **「零未解释」生效条件**:每维可比数和非空数都达到下限。建议值:push 可比 ≥100、非空 ≥30;writer 可比 ≥30(目标 ∈ ALL_FILES 的 Pre 事件);echo 可比 ≥30、非空 ≥10;length、routing 可比 ≥100。writer/length/routing 若 7 天内非空 <3,用第 28/29 条验收夹具在 isoEnv 下注入的事件补证(单列,不计入实时)。数值由主脑定。
   - **7 天起算**:本条与第 28 条落地且自测绿之后,五维各自独立起算。
   - 主脑裁决(2026-09-24):采纳 E-6b,tee 扩为 9 列(原 7 列后加 base64(stderr ≤1200B) 与 stderr 截断旗标),先于本条落地
   - 主脑裁决(2026-09-24):五维下限采纳报告第 162 行建议值
30. **检索基线口径**(MEDIUM-4)。
   - 题库另立 `guards/specs/retrieval-canary-v2.tsv`,4 列:type、query、expected_ids(逗号分隔,任一命中即算)、note。**不改** `canary-set.tsv`(`pmm-canary.sh` 按 3 列读)。
   - text 行由 canary-set 的 17 道 text 题转写。expected_ids 由主脑建前逐题指定,随题库注册(建者不写期望)。短语题列出全部可接受条目。
   - 图题 ≥5,只出 head/superseded 题:以被取代条目 X 的标题词为 query,期望 head(X) 位于 rank1。Cause 链题在 `fixtures/v3/` golden 语料上跑,另出 `RETRIEVAL-BASELINE-golden-<fixture sha>.json`。
   - 负例 ≥5:词表外的乱码与离域短语,判据是 0 结果。
   - 基线 json 按 type 分组:text/search/semantic/graph 各记 R@1、R@3、MRR 与题数;negative 记 0-hit 率与误命中列表。C1「不降」= 每组 R@1 不低于基线,且 negative 的 0-hit 率 = 100%。
   - 基线只读钉住的 HEAD 树(`git archive`,与 replay 相同),文件名里的 treeOid 就是读取来源。
31. **收口纪律**
   - **PLAN/指纹循环**:PLAN 改以 `core.contentFingerprint(snap, ALL_FILES)` 为键查找(收据不在 ALL_FILES 内,文件名里的 treeOid 只作注释);或者指纹册排除 `specs/PLAN-*.json`,由 PLAN 自带的 contentFingerprint 自证。二选一,主脑定;先后顺序不再作为规则。
   - **收口三件,缺一不收**:① 全量金丝雀摘要 `pass=P fail=0 skip=S expected=E`,且 `P+S=E`,每个 SKIP 行都在 SKIPPABLE 表内;② 收据 pending = 0;③ 金丝雀里逐个执行名册自测的行与 `SELFTEST_STRUCTURE_ROSTER` 按 basename 一一对应(行数 = 名册长度,EXPECTED 随之 +N)。
   - 另须:codex + Opus 审 GO(退出判据原文);wave-3「收口 B 缺项」逐项关闭。
32. **PLAN 定键与指纹循环(E-14)**:PLAN/D1-PINNED 的键改为语料内容指纹 = sha256(ALL_FILES 各文件内容按文件名排序拼接),不再用 `HEAD:.claude/memory` treeOid(它对 `dreams/receipts/` 敏感,指纹 refresh 的收据即令其过期);`pmm-c0-canary-check.sh` 按同一内容指纹核对;PLAN/D1-PINNED 文件从指纹册覆盖集移出(其完整性由 c0-canary-check 承担)。收口顺序随之简化:任意顺序,互不使旧。

33. **召回触发面补洞(2026-09-24 实证:主会话用 Bash 脚本改 spec,`[process:copy-open-source-before-building-infra]` 推送 0 次;推给子代理 4 次、另一会话 42 次)**:Bash 命令写入 `.claude/guards/specs/*`、`.claude/memory/*.md`(node 脚本 writeFileSync / `>`/`>>` 重定向 / `cp` 目标)视为该路径的 Edit 事件,走同一召回(`pmm-bash-impression.cjs` 或影子 hook 的 Bash 相);台账记 `via=bash-write`。**确定性闸**:PMM 预提交对 `guards/specs/*.md` 新增/改动的编号条目,凡含「解析|检索|图|因果|对照|回放|安装|校验|指纹」词而条目内无「借用来源」字样 → 拒。两者自测各一例红→绿。

## 下批候选(2026-09-23 Jax 批):档位标签闸 `pmm-dispatch-tier-gate`
PreToolUse Agent(独立小钩子,不改冻结中的 model-guard):①`model=haiku` 且 prompt 无 `[HAIKU-OK: 验收命令=…]` → deny;②prompt 命中机械词表(镜像同步|字面量改写|refresh|摘要|记账|rename|mirror)且 `model∈{sonnet,opus,fable}` 且无 `[SONNET:…]`/`[OPUS:…]` 标签 → deny;③既有 `[OPUS:理由]` 规则不变。只判标签在不在,不判语义。红绿各一例进金丝雀;settings.json 两份 + hook-manifest 接线。排在 C0.5 收口之后,不插队。
