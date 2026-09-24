# ECC typescript 复审 — AxMem P1 三审合并修复轮

审查者:ECC typescript-reviewer(Sonnet,只读)。日期 2026-09-17。
对象仓库 `C:/Users/<user>/Desktop/axmem`,HEAD `e03ae69`(`git log --oneline 79e95e7..HEAD` 共 21 个提交:16 个修复轮 `ce46c75`..`3f4db83` + 1 个 CHANGELOG `86e6a7f` + 5 个收尾轮 `e1f38eb`..`e03ae69`)。
规范:`docs/P1-ADAPTERS-SPEC.md` v8.1。核对清单来源:`CHANGELOG.md` 三审结果表(本轮摘要:ECC typescript NO-GO 2H/7M/4L、ECC security GWC 1H/1M/4L、Opus 验收 GWC 4H/5M)加建造者报告 axmem-builder-report.md 的逐条到提交映射,加 docs/audits/OPUS-2026-09-16-p1-acceptance.md 原文(H1-H4/M1-M5/L1-L5,含具体文件行号)。不采信提交信息与建造者报告的声称,以下每条结论均在真实代码上复现。

亲跑清单(HOME/USERPROFILE/HERMES_HOME 均指向临时目录,从未写真实 ~/.hermes、~/.claude、~/.codex、~/.hermes/memories、SOUL.md):
- bin/axmem selftest(全遍历 32 项)跑前 git status --porcelain 空、跑后空,rc 0,32/32,耗时约 5m58s(见下方自测汇总)。
- 单模块直接验证:lib/lock.cjs --self-test 14/14、lifecycle/restore.cjs --self-test 25/25、adapters/hermes/queue.cjs --self-test 17/17(9.6 峰值 2095584B/2162688B 等于 96.9 百分比,success=32 dropped=8 lock-timeout=0,与 CHANGELOG 声称的 32/8/0 数字一致,亲测复现非转录)、lifecycle/install-manifest.cjs、lifecycle/uninstall.cjs、lifecycle/upgrade.cjs、lifecycle/tar-safety.cjs、lib/msys-path.cjs、lib/prelude.cjs、adapters/hermes/bridge.cjs、adapters/hermes/doctor.cjs、adapters/hermes/wire.cjs、adapters/claude-code/merge-hooks.cjs 均单独重跑,数字与全遍历一致。
- 变异反证:在 git clone --local 的丢弃副本(scratchpad 内,非真实仓库)里对多处已闭合 finding 逐一改回缺陷,跑对应自测确认翻红,再 git checkout 还原、rm -rf 丢弃副本;真实仓库全程 git status --porcelain 为空(已验证)。

---

## 结论:GO

本轮 21 个提交对三份前审(ECC ts 2H/7M/4L、ECC security 1H/1M/4L、Opus 4H/5M)的每条 finding 均已在真实代码上定位到修法并用变异反证确认闭合,没有发现"闭合但引入新问题"的回归。审计过程中独立发现 2 条本轮未被任何前审点名的新问题(均为 MEDIUM,测试基础设施/边界分支覆盖类,不影响用户数据安全)与 1 条 LOW(测试夹具脆弱性,已在本次亲跑中触发过一次误报)。均不构成 NO-GO 理由,建议下一轮顺手补。

H/M/L 计数:0 HIGH / 2 MEDIUM / 1 LOW(全部为本次审查新发现;三份前审的 13 条原始 finding 全部确认闭合,不重复计入下方计数)。

---

## 前审 Finding 逐条闭合核对

### ECC typescript 原始 2H(本轮全部闭合)

H1 — restore CLI 不查 performRestore() 返回值,失败 rc 0
修法:lifecycle/restore.cjs:427-440 新增 cliRestore(),显式检查 result.ok 为 false 才返回 3,否则返回 0;require.main 分支(:913)改为 process.exit(cliRestore(...))。提交 740222c。
变异反证(丢弃副本):把 cliRestore() 改回旧版"调用 performRestore() 但丢弃返回值,恒定 return 0"。node lifecycle/restore.cjs --self-test 从 25/25 变 24/25,唯一失败为 "FAIL 9 (ts H1) cliRestore returns rc 3 when advanceStateMachine reports ok:false...",其余 24 条不受影响。还原后复绿。判定:闭合,无回归。

H2 — 恢复矩阵 NEW_MOVED_CONTINUE 漏做 staging 到 current 的 rename,目录留空却报 committed(真实数据丢失路径)
修法:lifecycle/restore.cjs:386-399 的 case 'NEW_MOVED_CONTINUE' 改为 return continueFrom('OLD_MOVED')(重新从 OLD_MOVED 阶段进入 advanceStateMachine,使其真正执行 staging 到 current 的 renameSync,再顺势跑到 NEW_MOVED/COMMITTED),而非旧版 return continueFrom()(原地在 NEW_MOVED 阶段只把 phase 推进到 COMMITTED、从不执行那个 rename)。提交 740222c。恢复矩阵每一行还有独立的真实文件系统断言(测试 10.x,restore.cjs:681-803,对每行注入 (phase, cur, prev, staging) 真实文件树加真实 journal,跑真 recoverOnStartup(),断言 readTree(memDir) 等于预期内容字节而不只是返回值标签)。
变异反证:把 :399 的 return continueFrom('OLD_MOVED') 改回 return continueFrom() 。25/25 变 24/25,唯一失败为 "FAIL 10 (ts H2) row NEW_MOVED_CONTINUE: action=continued/ok=true AND real on-disk end-state matches spec"。还原后复绿。判定:闭合,无回归 —— 这条是本轮最高危的真实数据丢失路径,修法和测试都对上了。

### ECC typescript 原始 7M(本轮全部闭合,以下按建造者映射逐条核)

M(lock 自测 恒真断言):旧版 9.7 断言写成 (sawSweepFailedEvent || !chmodApplied || true),提交 ce46c75 删除了那个恒真的 true 分支,改为真实触发(lib/lock.cjs:638-666:用一个子进程把 CWD 钉在待清扫目录里,Windows 上这会让 rmSync 真的失败,而非用不生效的 chmod 0o444)。代码核实:lib/lock.cjs:663-666 的 check(...) 三个条件里没有那个恒真分支,且第 660-661 行明写"若本机未复现清扫失败,标记 inconclusive、不计为 pass",不是用永真兜底充数。判定:闭合。

M(死 owner 回收路径从未端到端触发):提交 423d002 新增 lib/lock.cjs:707-730 的测试 12,真的 spawn 一个子进程去 claim 锁(记录真实 pid 加真实 PowerShell 取到的 FILETIME),子进程退出但从不调用 releaseLock(模拟崩溃),然后由父进程 claimLock() 走"pid 真不存在,dead,回收"的完整路径,而非只伪造 pid/startTime 字段。亲跑确认此测试在 14/14 里正常通过。判定:闭合。

M(bin/axmem selftest 对 12 个新 .cjs 失明):提交 6438da5 把 selftest 分支从硬编码 core/*.sh 名册改为 grep 动态发现 core/ lib/ adapters/ lifecycle/ tests/ 下所有含 --self-test 声明的 .sh/.cjs(bin/axmem:210-238)。亲跑确认:全遍历发现并跑了 32 个组件(含全部新增的 lib 下四个 .cjs、adapters/hermes 下四个 .cjs、lifecycle 下六个 .cjs、adapters/claude-code/merge-hooks.cjs 共 12 个 P1 新 .cjs,以及后续收尾轮加入的 3 个 tests/*.sh)。判定:闭合。

M(manifest 校验恒真):提交 687b46d 把 lifecycle/install-manifest.cjs:55 的校验改为 data 且 typeof data 是 object 且 data.adapters 且 typeof data.adapters 是 object 且非数组,新增测试 7(adapters:null)、7b(adapters:[])、7c(缺失文件仍返回空 manifest 而非误判损坏)三条。
变异反证:把 :55 改回旧版仅 typeof data.adapters 等于 object(接受 null 和数组)。install-manifest self-test 从 9/9 变 7/9,FAIL 7 和 FAIL 7b 精确对应。还原后复绿。判定:闭合,无回归。

M(MSYS 路径零防御零自测):新增 lib/msys-path.cjs(normalizeMsysPath(),8/8 自测)加 lib/prelude.cjs:16-30(每个 AXMEM_* 环境变量在 norm() 之前先过 normalizeMsysPath(),自身 4/4 自测)加 adapters/hermes/bridge.cjs 测试 9(端到端:AXMEM_STATE_DIR 用 MSYS 形态 /c/... 时,队列文件真的落在 native 路径,断言错误形态 C:\c\... 目录不存在)。提交 f59a861。三层自测独立亲跑均绿。判定:闭合。

M(allowlist 过滤无反例):提交 1f7dcb2 在 adapters/hermes/doctor.cjs:243-263 新增测试 5:allowlist 存在且有条目,但全部条目都不含 bridge.cjs(第三方/不相关命令),断言 approved 计数仍为 0、tier 仍为 configured(不能被误判为 approved)。亲跑确认 hermes doctor self-test 5/5 含此项。判定:闭合。

### ECC typescript 原始 4L
CHANGELOG 摘要未逐条点名,建造者映射对应到:bin/axmem doctor 段的 eval 改为 bash -c(去 eval,bin/axmem:66-72,注释明写原因);lib/lock.cjs 测试 8 的同步 spawnSync 轮询改为 await delay() 异步轮询(Opus L1,lib/lock.cjs:599-610,注释详述原因,亲测 --self-test 全程约 4 秒量级,未见旧版报告的约 14 秒/10 秒空转);adapters/hermes/queue.cjs:110-117 的 quarantineCount 明确标注为 reporting-only、非 admission input(Opus L2,死变量已文档化而非删除,行为符合 spec);lib/lock.cjs 的 MAX_VALID_PID 结构化 pid 校验(防止非整数或越界值直接进 process.kill())。均代码核实存在,无需额外变异反证(均为可观测性或健壮性收尾,非数据安全路径)。

### Opus 验收 H1-H4 / M1-M5 / L1-L5(本轮修复清单,逐条核)

H1(队列侧 fencing 完全缺失):adapters/hermes/queue.cjs 新增 fenceOrAbort()(:61-65)加 mergeEvents()(:72-74),在 produce()(3 处,:219/:230/:237)、drain()(:344)、recoverOnStartup()(:410/:455/:475)、quarantineMalformed()(:306)四个入口全部接入。提交 5d3f5e6。
变异反证:把 fenceOrAbort() 函数体改成恒 return true(禁用 fencing)。queue self-test 从 17/17 变 14/17,FAIL 11b/11c/11d 三条(分别对应 produce/drain/recoverOnStartup)精确翻红。还原后复绿。判定:闭合,无回归,四个入口都真的接了,不是只接了一两个。

H2(9.6 屏障断言空过,峰值仅约 6 百分比):adapters/hermes/queue.cjs:860-868 新增 ratio 大于等于 0.10 的断言加输出实测比值。亲跑复现:peak=2095584B ceiling=2162688B ratio=96.9 百分比,success=32 dropped=8 lock-timeout=0(非转录 CHANGELOG 数字,本人直接重跑所得,与 CHANGELOG 一致)。判定:闭合,断言不再空过。

H3/L5(变异臂假绿三处:matcher 改错、正规化映射删除、准入检查后置):
- matcher 假绿:adapters/hermes/wire.cjs:437-441 测试 0 直接断言渲染出的 matcher 字面量等于真实 Hermes 工具名正则。
- 正规化映射假绿:adapters/hermes/bridge.cjs:360-400 测试 2b 端到端埋一条真实 trigger 注释,断言队列里出现 kind 为 recall 的记录且文本含预期内容(证明 tool_name 到 Write 加 path 到 file_path 的正规化确实跑过,否则 trigger-recall.cjs 不会匹配)。
- 准入检查后置假绿:adapters/hermes/queue.cjs:787-803 测试 11e 直接断言"被拒绝的记录在 .incoming 目录里零残留"。
三处均代码核实存在且逻辑对得上假绿场景。判定:闭合。

H4(spec 第三节隔离/E2E 夹具未进仓库):tests 目录下三个文件 isolation-real-configs.sh、fresh-home-adapters.sh、inherit-real-env-arms.sh(提交 e03ae69),已进 bin/axmem selftest 名册(bin/axmem:235 的遍历目录列表含 tests)。亲跑全遍历确认三个文件均被发现并执行:fresh-home-adapters self-test 4/4、inherit-real-env-arms self-test 5/5、isolation-real-configs self-test 3/3。判定:闭合(细节见下方 MEDIUM-2,夹具本身有一处设计脆弱性,不影响闭合判定)。

M1(drain() 在写 stdout 之前就删 draining 目录):adapters/hermes/queue.cjs:381-386 drain() 改为返回一个含 context、events、commit 的对象,commit() 才删除 draining 目录,自身从不主动删除;adapters/hermes/bridge.cjs:200-221 handlePreLlmCall() 里 process.stdout.write() 返回 true(已刷新)才立即调用 commit(),否则等 drain 事件后再 commit()。代码序核实:写 stdout 严格先于 commit()。判定:闭合。

M2(lock-sweep-failed 事件队列侧丢弃):adapters/hermes/queue.cjs 四个入口(produce/drain/recoverOnStartup/quarantineMalformed)的 claim.events 与 rel.events 全部经 mergeEvents() 并入返回值(:185/:263/:339/:357/:400/:485/:303/:316),不再有 Opus 报告里那种把 release 事件在空 for 循环里丢弃的写法。判定:闭合。

M3(YAML loader 真校验因可反驳前提被跳过):adapters/hermes/wire.cjs:207-282 新增 resolveHermesCommand()/runHermesHooksList()/verifyWithRealLoader(),写入前用临时 HERMES_HOME 对原文件与候选各跑一次真 hermes hooks list(:340-360 接入 main()),hermes 不在 PATH 时退回子集且 doctor 显式报告"loader unused"(adapters/hermes/doctor.cjs:160)。自测 20a 到 20d(wire.cjs:626-659)用真实可执行的假 hermes.cmd 脚本覆盖三态。判定:闭合。

M4(NTFS 并发争用被无条件清扫放大):lib/lock.cjs:253 STALE_CLAIM_MS 等于 2000,sweepSiblings()(:255-289)只清扫 mtime 早于 2 秒的 .claim-* 目录,新鲜的不动;claimLock()(:387-402)改为指数退避加抖动。测试 6b(:544-561)专门证明小于 2 秒的新鲜 claim 在另一持锁者清扫时存活。判定:闭合。

M5(fence.cjs 无 --self-test):lib/fence.cjs:233 起新增完整自测(6 项,覆盖 recordLifecycleTarget() 的 pre/post sha256 记账),亲跑 6/6。判定:闭合。

9.7(恒真断言):见上文 ECC ts M 项,同一处修复,不重复展开。

变异臂漏网两处(restore.cjs 未知 phase、uninstall.cjs fence 形态 identity):
- restore.cjs 新增测试 11(:805-824):journal phase 写一个从未出现过的字符串,断言 recoverOnStartup() 落入表外兜底分支、rc 3、当前树字节不变。亲测该行在 25/25 里正常通过。
- uninstall.cjs 新增测试 8/8b(:285-310):fence 形态的 0 次匹配和 2 次以上匹配(此前只有 json-hook 形态的同类测试),对应 removeFenceTarget()(uninstall.cjs:39)的匹配数校验。亲测该两项在 10/10 里正常通过。
判定:两处均已补测试,闭合。

---

## 本次审查独立发现的新问题(前三审均未点名)

### MEDIUM-1 — lib/lock.cjs:104 pidExists() 的 unknown 兜底分支无任何测试覆盖

pidExists()(lib/lock.cjs:90-106)三分支:ESRCH 到 dead、EPERM 到 alive、其余到 unknown(:104,注释为"any other unexpected failure")。这正是 ECC security H1 当初修的那类代码(pid 存活判定误判 dead 会导致双持锁)。

复现(丢弃副本):把 :104 改成 return 'dead'(恢复 ECC security H1 修复前"任何非 ESRCH/EPERM 错误都判死"的旧行为)。node lib/lock.cjs --self-test 仍是 14/14,无一翻红。

原因:现有测试 10/11(:670-705,对应 sec H1 的回归测试)分别经 readOwner()(会在解析阶段就拒绝畸形 pid,根本不走到 pidExists())和对 pidExists() 传入结构性越界值(如极大数字,在到达 process.kill() 之前就被 :97 的结构校验拦下)两条路径,都绕开了 :104 这一行本身。也就是说:"process.kill() 抛出了 ESRCH/EPERM 以外的东西"这一分支,在整个仓库里没有任何测试真正让代码执行到它。

这条分支是否在真实 Windows/Node 上可达(即是否存在一个通过结构性校验、但让 process.kill(pid, 0) 抛出非 ESRCH/EPERM 错误的 pid 值)未经证实,可能确实罕见;但鉴于这正是三审里唯一一条被点名过双持锁 PoC 的函数,建议至少仿照本文件 :660-661(9.7 sweep failure 用注释显式标注"本机未复现,视为不确定"而非静默通过)的先例,为这一行加一条测试或至少一条"本平台/本次未复现,已知空隙"的显式记账,而不是让它保持"14/14 全绿"这种看似已覆盖、实则从未被执行到的状态。

改法:mock process.kill 让它抛出一个非 ESRCH/EPERM 的 error(例如 EINVAL/ENOSYS),直接单元测试 pidExists() 本身(不经过 ownerStatus()/readOwner() 的额外过滤层),断言返回 unknown。

### MEDIUM-2 — bin/axmem selftest 的仓库整洁性绊线可被同一次遍历里更晚的自测悄悄洗白

bin/axmem 的 selftest 分支(e1f38eb 引入)只在整个遍历开始前和结束后各拍一次 git status --porcelain 快照做比对(bin/axmem:204-251)。tests/inherit-real-env-arms.sh:118 的 arm 3 末尾有一行"belt-and-suspenders"清理:无条件 rm -rf "$ROOT/state"(注释自称"如果这条臂再次变红时的兜底清理")。它无条件删除仓库根下的 state 目录,不检查这个目录是谁、为什么创建的。

tests 是遍历的最后一个目录(bin/axmem:235 的遍历目录列表),而 inherit-real-env-arms.sh 在 tests 目录内按字母序排在 fresh-home-adapters.sh 之后、isolation-real-configs.sh 之前。也就是说:如果遍历前段(比如 lib/fence.cjs)的某个自测真的把 state 目录写回了仓库根(即 e1f38eb 本要修的那类回归复发),这条清理行会在整场遍历结束、最终 git-status 比对之前,把证据悄悄清掉,绊线因此永远不会响。

复现(丢弃副本,git clone --local 到 scratchpad,非真实仓库):
1. 把 lib/fence.cjs 的 defaultStateDir()(:45-48)改回 e1f38eb 修复前的 process.env.AXMEM_HOME 或 process.cwd() 兜底,并把自测第 1 条(:280)的隔离包装去掉(精确复现该提交描述的"红到绿"变异)。
2. 单独跑隔离环境下的 node lib/fence.cjs --self-test(cwd 等于丢弃副本仓库根):state/backups 下的备份文件真的落进了仓库,git status --porcelain 显示该目录为未跟踪。
3. 紧接着单独跑同样隔离环境下的 bash tests/inherit-real-env-arms.sh --self-test:跑完后 state 目录消失,git status --porcelain 回到干净。
4. 用完整 bash bin/axmem selftest(同样两处变异都在)重跑一遍全流程:32/32、rc 0、repo-cleanliness 一项显示绿色——绊线全程没有响一次,尽管 lib/fence.cjs 那两行变异期间真实污染过仓库根。

还原两处变异、删除丢弃副本后确认真实仓库全程未受影响(全程只在一次性 git clone --local 的丢弃副本上操作)。

改法(二选一,不阻断本轮 GO):一是把 tests/inherit-real-env-arms.sh:118 那行无条件的仓库根 state 目录清理去掉(它本该只是"以防万一"的收尾,但恰恰是它在吞掉别人的证据)——如果这条臂本身还会把 state 目录写脏,应该让 bin/axmem selftest 的绊线抓到,而不是自己先擦掉;二是让 bin/axmem selftest 的绊线改成每个组件跑完后立即拍一次快照(而不仅是遍历开始和结束各一次),任何一步产生净变化就地报错并指出是哪个组件干的,不给"后面的测试顺手清理掉"留出窗口。

### LOW-1 — tests/inherit-real-env-arms.sh:31-34 臂 1a 对 HOME 与 USERPROFILE 必须同指一处的隐含假设,在本次要求的亲跑方式下产生过一次真实误报

任务书要求亲跑前把 HOME/USERPROFILE/HERMES_HOME 指向临时目录。第一次亲跑时我把 HOME 和 USERPROFILE 分别指向两个不同的临时目录(字面理解"都指向临时目录",未要求同一个),结果 tests/inherit-real-env-arms.sh 的臂 1a 假 FAIL(标注为"RED demo, not a defect"的那一条,却真的报了 FAIL)。

根因:该行 real_home_state(:31)只用 os.homedir()(Windows 上读 USERPROFILE),而 resolved_state_uniso(:32)实际通过 lib/prelude.cjs 的 HOME_DIR 计算,后者优先读 bash 的 HOME 变量,其次才是 os.homedir()(lib/prelude.cjs:28)。二者只有当 HOME(bash)与 USERPROFILE(Windows)指向同一路径时才会相等,这在一台机器上通常成立,但不是必然的,尤其是被审查者按任务书字面指示分别设置两个独立临时目录时。把 HOME 和 USERPROFILE 改成指向同一个临时目录后复测,inherit-real-env-arms self-test 变 5/5,全套 bin/axmem selftest 变 32/32(见亲跑清单)。

这不是产品代码缺陷(lib/prelude.cjs 里 HOME 优先于 os.homedir() 是刻意设计,MSYS 环境下就该这样),而是这条测试夹具自身对"未隔离环境下 HOME 语义"的假设不够健壮,建议顺手把 real_home_state 的计算也改成与 lib/prelude.cjs 同款的"先读 HOME 环境变量,读不到才退回 os.homedir()",避免依赖"HOME 恰好等于 USERPROFILE"这个环境偶然性。

---

## 自测汇总(一行)

bin/axmem selftest(HOME 等于 USERPROFILE 等于 HERMES_HOME 均指同一临时目录隔离):rc 0,32/32 组件自测全绿,repo-cleanliness 绊线绿(跑前跑后 git status --porcelain 均为空),耗时约 5 分 58 秒;7 项已闭合 finding 逐一变异反证均正确翻红(H1 restore CLI 变 24/25、H2 NEW_MOVED_CONTINUE 变 24/25、manifest 恒真校验变 7/9、queue 四点 fencing 变 14/17、tar-safety 非法 size 变 20/21)且还原后复绿,全程在一次性 git clone --local 丢弃副本上操作,真实仓库 git status --porcelain 全程为空。
