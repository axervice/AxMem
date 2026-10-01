# WebCodex continuation handoff — 2026-09-29

本文件继续 2026-09-28 的 `WEBCODEX-HANDOFF.md`。只记录 WebCodex 实际观察/执行过的事实；未验证项保持未完成。

## TODO

- [x] 同步 PMM；home `HEAD == origin/master == f0523bae33cf652fd7cf927bc48bd1528e082aeb`，未对脏 home 做 rebase。
- [x] 读取全局 `AGENTS.md`、PMM 入口/config、AxMem North Star/P1/P2 计划和原 `WEBCODEX-HANDOFF.md`。
- [x] 核实 AxMem 原生 Windows Git 工作区：真实变更仅 handoff 的 5 个文件；此前 WSL `/mnt/c` 下显示 53 个修改是跨 Git/换行环境假象，不作为工作区事实。
- [x] 建立隔离验证 commit `b7b1d92977e3041a79520c98df5abef69aa32164`（parent `1641eba97723dd1e35da6cc152d7f64624d44c84`），仅含 handoff 5 文件。
- [x] 丢弃错误基线验证：临时 clone 的 `main` 一度仍指 `1641eba`；旧树 GATE3 的 `tests/inherit-real-env-arms.sh` 仍是宽泛 `grep -rq "XDG"`，所以 34 pass / 2 skip / 1 fail 不能用于评价 handoff 修复。
- [x] 修正临时 clone：`HEAD == main == b7b1d92`，工作树 clean。
- [x] 第一轮完整公开导出：GATE0=0 drift；GATE1=0；GATE2 PASS；GATE3 PASS；GATE4=158 entries/0 findings；GATE5=158 exact paths；`EXPORT_TREE=631369239f5b9b72f006cbaaa868016bcbcb7778`；未 push。
- [x] 第二轮同源公开导出完成：GATE0–5 再次全绿，`EXPORT_TREE=631369239f5b9b72f006cbaaa868016bcbcb7778` 与第一轮完全相同；导出器明确报告 `IDEMPOTENT`，无新 commit、无 push。
- [x] 已将修复原因、错误基线为何作废、验收口径与回滚说明写入主仓 `CHANGELOG.md`；因 `CHANGELOG.md` 是 overlay target，已按正式 `--update-overlay-baseline CHANGELOG.md` 流程刷新 baseline。
- [x] 最终内容审阅完成：主仓仅 8 个本批文件（handoff 原 5 个 + `CHANGELOG.md` + `publish.manifest.json` + 本 continuation handoff）；`git diff --check` 通过。刷新 CHANGELOG baseline 后又跑一轮完整 GATE0–5，仍为同一 `EXPORT_TREE=631369239f5b9b72f006cbaaa868016bcbcb7778` 且 `IDEMPOTENT`。
- [x] handoff Priority 1（`C:/Users/jax-x/codex-tools` 三项）：Runner 授权后发现前序收口已落 commit `06d61e0`（readiness 改用 `tomllib` 语义校验；写准入绑定实际选中/回退 home；协同日志区分 auto request 与 `CODEX_LAST_HOME` 实际服务账号）。WebCodex 独立复验 `tests/handoff-regressions.sh` **8/8**、既有 `tests/big-review-gate.sh` **15/15**、触及 shell `bash -n` 通过；未重复改生产代码，旧 untracked 文件保持不动。
- [x] handoff Priority 2（home PMM denial-ledger）：Runner 授权后按现行代码复核。当前总名册 `guard-canary.sh` 为 `EXPECTED=82`；对本批 4 个 denial-ledger 相关文件按依赖图计算并实际执行的**最终受影响子集为 51**。直接自测：ledger **162/162**、report **46/46**、write-gate **17/17**、isolation contract **244 pass / 0 fail / 6 report-only** + 两 mutant 精确匹配 + ledger wiring **19/19**；51 子集 **48 PASS / 3 FAIL / 0 SKIP**，三红均为 09-26 已登记既有残留（shadow-replay `.cjs/.sh` 12/13、migrate-v3 76/82）。T2c 夹具假红已闭合（reasonless duplicate 会被 W23-U3b 正确归 orphan；夹具需复制 decision+reason），生产 retry fail-safe 不变；收口 commit `746682d`，最终 canary 数字审计更正 commit `7915c13`。dreams/access-log/receipt 运行增量未纳入提交。
- [ ] P2.0 freeze：已开始机器尺子阶段；freeze generator + real frozen-hook replay/comparator + 21-event fixture + private `bin/axmem equiv` 已达 focused **19/19**。仍需 public tree 零变化、真实 live inventory、干净 live source 的正式 `FREEZE-*.json` 与 frozen-vs-frozen green report；这些完成前不得进入 P2.1。

## 回滚

- 接手前 handoff 五文件 + `CHANGELOG.md` 原字节、SHA256 和 `handoff-five.patch` 已保存到 session-local rollback 目录。
- 当前公开验证只更新隔离 clone 的本地 `public` ref；没有触碰公开远端。
- 若后续主仓提交有误，优先按该提交做 `git revert`；不要回滚其它会话/其它批次文件。

## 2026-09-30 — G1-R7 当前断点

- [x] G1-R6/R6a 主审有界通过；成熟 Bash AST 私有 helper / adapter / lock / fixture / publish exclusion 候选已按 R6a 最终字节精确落到本地产品工作树。源 patch SHA256=`68adcfe31f3879081b1d131ec2983facbd9a0e17497ea1a47a3d80d33b01ae6f`。
- [x] 应用前核 `main@28987fb4c85476c7ea305b8662a204597a2c6831`、既有 16 dirty 与 R6a 当前工作树基线无漂移；写前备份/缺失清单/hash/git status 在 `%LOCALAPPDATA%/Temp/axmem-p20-g1r7-local-integration-2026-09-30/`。未 commit/add 整树、未 push/reset/stash。
- [x] 固定私有 helper 用已验证 portable Go 1.26.1 离线构建，`GOPROXY=off`，SHA256=`4352c942f438a6a1183f05c64821157d54e46bdc835d3efb03881bee43bac6d7` 与 lock 一致；`.gitignore` 仅新增 `/scripts/private/p2-bash-ast/bin/`。helper 不进入 Git/public export。
- [x] 落地 smoke `tests/p2-generated-ast-integration.test.cjs` **23/23** exit0；日志 `SMOKE-INTEGRATION-23.log` SHA256=`e67ea4a78204ab31ffa9667c265ff65cbb16df554925e76a010f9d3da064fe32`。15 个 R6a 候选源码/文档/manifest 落地字节与 R6a 最终候选一致，因此 machine **97/97**、freeze-equiv **35/35** 直接引用已核 R6a 日志，不重复运行。
- [x] 冻结对象只读复核：历史 commit `7915c137ddc0900902d9c6e44d27689ed0183245` 的 `.claude/guards/pmm-shell-memory-watch.sh` blob=`70372bd9ce52b1bab22f156b8e131c3af9b4dd76`；JSON/CTX 从该 blob 用成熟 AST 均为 `artifact-verified`，但 `executionClosed=false`。同一 commit 缺 `.claude/pmm-entry-length-watch.sh`，scope 仍阻塞。当前 `docs/freeze` 只有 `draft-not-formal` inventory，无正式 `FREEZE-<date>.json`。
- [ ] 下一门只做正式 freeze 输入闭合：给 scope generator 建立 reviewed frozen source binding，并在 complete reviewed inventory + clean committed live source 上生成正式 freeze 与 frozen-vs-frozen green evidence。完成前 P2.1、正式 runner/export/freeze 仍禁止。

### G1-R7 精确撤销

- 恢复 `backup-before-apply/` 中应用前已存在的受影响文件；删除 `MISSING-BEFORE.txt` 列出的本轮新建路径。
- 恢复 `backup-before-apply/.gitignore`（其独立原 hash 见 `GITIGNORE-BACKUP.json`）。
- 恢复 `backup-before-doc-update/CHANGELOG.md` 与 `backup-before-doc-update/docs/audits/codex-closeout-2026-09-28/WEBCODEX-HANDOFF.md`。
- 删除生成的 `scripts/private/p2-bash-ast/bin/`；不要 reset/stash 或覆盖其它既有 dirty 文件。

## 2026-09-30 — R10 当前断点

- [x] R9-A 两路径已按主审核定 patch `1a1dfacd720cd421bd04c23969ac8c08764aa2e489864a78101c69072b1b2ec3` 精确本地落地；无 commit/stage。`scripts/p2-freeze.cjs`=`bc40cbab1445151c88161130b5322f6d71bb67310d4337a672690b11eae10111`，新 buildManifest 测试=`387b8329454977f9567c00915e17d74d657254b01aae27e1231896bf6b0a0690`。
- [x] `publish.manifest.json` 仅追加新私有测试精确 exclude；生产 `computeKeepList` 合成验证通过，未正式 export、未刷新 overlay baseline。
- [x] 落地验证：buildManifest **14/14**、machine acceptance **97/97**、freeze-equiv **35/35**，均 exit0；测试前后7个关键文件/二进制hash不变。
- [x] generatedArtifacts 已进入 inventory→normalize→closure verifier→manifest 正式候选数据流，但只能形成冻结blob核实的 `artifact-verified` 证据；不豁免 unresolved，`executionClosed=false`，不代表 P2 完成。
- [x] 5个 external-prerequisite 已形成6个 concrete record/ref 候选并通过当前schema路径；R10 inventory候选已不再卡 external refs，当前首个 hard block 是缺 structured runtimeHealthProbe。
- [ ] 7个 provisional disposition 仍需主审逐项批准。R10 只给 evidence-backed 建议 private-exclude 与明确风险，未自行转 final。
- [ ] 19项 runtime probe、剩余 closure、exact-path source-capture commit、formal freeze、execution equivalence、P2.1 仍在后续门。
- [ ] CHANGELOG overlay drift 仍作为单独 public-export 门处理，本轮未刷新。

### 后续 Git 提交署名常驻规则（Jax 2026-09-30）

任何后续**由执行层创建**的 Git commit，author 与 committer 均署名 `codex`，不得署 Jax。执行建议：不改 global/local 持久配置；每条允许的 commit 命令显式使用 `git -c user.name=codex -c user.email=codex@local.invalid commit ...`，并在提交后用 `git show -s --format='%an <%ae>|%cn <%ce>' HEAD` 核 author/committer。若环境存在 GIT_AUTHOR_*/GIT_COMMITTER_* 覆盖变量，提交前必须显式清除或在该单命令作用域内设为 codex；R10 本身没有创建 commit。

## 2026-09-30 — R11 当前断点

- [x] R9/R10 inventory 候选的非 ASCII mojibake 已定位并从权威来源重建；旧两份候选保留为失败证据，不再作为文本来源。
- [x] INVENTORY-V1-CANDIDATE-R11.json：32/32 hook identity 与活体 settings 一致；全部非 ASCII 字符串有来源映射且逐字节一致。
- [x] 7 个原 provisional 已按 Claude 主会话 2026-09-30 裁决记为 reviewer-approved private-exclude，作用域仅「P2.0 冻结清单与记忆等价量尺」，四个条件均写入每项 reviewDecision。
- [x] 两条 --shadow 的排除前提已核：port|replace 依赖闭包未发现任何 .shadow reader；tee 写入仍进入 equiv stateTree。
- [ ] R11 候选仍因 runtimeHealthProbe 等后续门阻塞，不是 formal inventory，不生成 FREEZE。
- [ ] 未决产品问题「常驻规则横幅是否做成产品功能」已按发布选择结果记入 docs/BACKLOG.md，待 Jax 裁决；不得用本次量尺排除作为产品删除依据。

## 2026-09-30 — R12b / R13 runtime-health witness 断点

- [x] R12b candidate `INVENTORY-V1-CANDIDATE-R12b.json` SHA256=`2e41253426cd7c07eebe8529b7e7f1d10e40ba8af6fa731a9f6410f043e2abc0`；R13c 更新后的 R12b evidence index SHA256=`193611119265db4db2ccacd255a5c08dc2d409e0cea36a402f7e4f4b36831afc`。候选状态保持 `candidate-blocked-review-not-formal-freeze-input`。
- [x] R12b leave-one-out 最终语义统计仍为 **41 detected / 17 silent-change / 33 no-effect**；旧 `DEEP-PROBE-RESULTS.json` 17/17 继续作废。R13c `STRICT-LOAD-FAULT-MATRIX.json` 为 **21/21 healthy baseline + 21/21 exact-attributed detected**，`not-attributed=0`、`probe-error=0`；其中 13 条 `probeTarget==removed` 仅证明直接模块预检能检出删除，8 条经 `pmm-core` 等中间模块证明真实传递加载依赖。`PREFLIGHT-EDGES.json` 为 21 mandatory production edge + 1 selftest-only，0 optional-degradable。
- [x] 主审裁定下一版 `runtimeHealthProbe` 采用 **v2 witness contract**：所有 reliable=true 必须有登记的可观察效果见证（Option B）；上述 6 个 fail-open silent 族（新增 `PreToolUse/2/0`）还必须叠加只针对该 hook `files[]` 闭包内、经审查标记 mandatory 边的模块加载预检（Option A），即混合 C。P2.0 不修改 live 守卫；“闸失效时留一条记录”另记守卫待办。
- [x] R13b witness 复审：wrapper `PMM_TEE_LOG` 路径不再算 effect；`PreToolUse/2/0` 以 R13 fixture 的 `permissionDecision=deny` 与 `.claude/.local/pmm-recall/denials-JaxStuuu.tsv` 主体写入关闭原 fixture-gap。相反，`PostToolUse/0/2`、`PostToolUse/1/0` 只观测到 trigger-recall `matched=0` 快速路径，未演示 `pmm-trigger-recall.cjs:663` 的 `additionalContext` 判决分支，均改为 fixture-gap。修订后的 19 条 registry 为 **16 demonstrated / 2 fixture-gap / 1 external-gap**；每条 demonstrated 都登记主体源码位置。
- [x] R13c 复核补正：`PostToolUse/6/0 → pmm-recall-ledger.cjs` 由 `shell-memory-watch → trigger-write-gate:225 → pmm-core:31` 硬路径改判 mandatory，22 条 edge 均补 `branch/hardPath`；`PreToolUse/2/0` 四条 mandatory edge 已进入 21 行严格矩阵。`PostToolUse/0/1` 另用隔离主体夹具真实演示 block `rc=2 + stderr`，旧 R12b rc0/baseline 写入仅保留为 pass 分支附证；F3 旧 fixture-gap 与“ledger 可选遥测”残留已关闭。
- [x] R13d 订正(2026-10-01):上一条「F3 旧 fixture-gap 与"ledger 可选遥测"残留已关闭」不准确——R13c 收口时 PREFLIGHT-EDGES.json 的 ledger 边 rationale、STRICT-LOAD-FAULT-MATRIX.json 对应行与 R12b 旧文件仍有「可选遥测」旧文,registry 的 PostToolUse/0/1 fixture 仍指 R12b 旧夹具,block 夹具 stderr 被 GBK 误解码入库。R13d 已在证据目录改正或加 superseded 标注(R12b 索引 dac349f4…、R13 索引 c289e5d5…,Sonnet 复核 7/7 PASS);其余 7 条同类残留列入 R17 证据入库前清理。
- [ ] P2 WIP（`scripts/p2-freeze.cjs`、`scripts/equiv-runner.cjs`、`scripts/equiv.cjs`、private Bash AST、tests/p2-*、publish override / manifest / bin 增量）**先审后合**：先由 codex(xhigh)只读审 v2 spec 与工具代码，再按审查结果修正，之后才允许逻辑提交；R13 不提交、不切分支、不 push。

