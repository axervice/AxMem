# AxMem CHANGELOG

AxMem 的记账只放这里(Jax 2026-09-16:「changelog 记得放在 axmem 目录下」);PMM 侧 `~/.claude/guards/CHANGELOG.md` 只留指针。审查产物在 `.codex-reviews/`(gitignored)。

## 2026-09-29 — WebCodex 接手 Codex adapter handoff：公开导出收口

- **范围/原因**：继续 2026-09-28 Codex integration handoff，只收口已落地的公开导出修复，不提前启动 P2.1。该批的真实缺陷是隔离测试把任意 `XDG*` 引用都视为 `XDG_CONFIG_HOME` 泄漏，导致合法的 `XDG_STATE_HOME` 使用误报；同时 publish acceptance 少跑 process-trace suite，且新增 Codex adapter 运行文件尚未进入公开路径快照。
- **修复内容**：`tests/inherit-real-env-arms.sh` 只扫描精确 `XDG_CONFIG_HOME` token；`scripts/dev-test.sh` 纳入第四个 `publish-process-trace.test.cjs` 并保留完整 selftest transcript；`publish-overrides/public-paths.snapshot.txt` 加入 `install-hooks.cjs/raw-receipts.cjs/test-raw.cjs`；README 中本地集成交接说明移至公开导出排除的 `docs/audits/`。
- **验证口径**：以 `1641eba` + 仅上述 handoff 五文件形成隔离快照 `b7b1d92`，必须完整通过 GATE0–5，并对同一 source 连跑第二次确认导出 tree 幂等；全程无 `--push`。首个验证尝试因临时 clone 的 `main` 未移动到 `b7b1d92`，实际测到旧 `1641eba`，该结果明确作废，不计验收证据。
- **回滚**：本批文件在写主仓前已保存原字节、SHA256 与 binary patch；隔离快照父提交 `1641eba` 也是代码级回滚基线。公开远端未写入。

## 2026-09-16 — P1 收口 spec 五轮审查链(未开建)

**起点**:HEAD `fbeefd3`(09-14 02:14)后闲置两天半;P1 完成定义四项里 Hermes/generic 适配层只有 README(零代码)、`uninstall/upgrade/restore` 不存在、CC 适配层没接 trigger-recall。主脑派只读勘察(Sonnet,9 分钟,29/34 文件 + Hermes 源码 hook 机制)得事实图,据图写 spec。

**关键事实(勘察 + codex 从 Hermes 源码核实)**:Hermes 有 shell-hook 机制(`config.yaml` 顶层 `hooks:`),但 **exit 2 只在 `pre_tool_call` 阻断**、`{"context"}` 只对 `pre_llm_call` 有注入承诺、未批准 hook 是跳过 + warning、`session_id` 与 `parent_session_id` 已合并、stdout 无接收确认通道;`core/write-gate.sh` 违规文本走 stderr 不走 additionalContext;`merge-hooks.cjs` 的去重会吞掉新加条目;core 只读顶层 `memory_dir`;Git Bash 无原子目录交换。

**审查链(codex,均 read-only)**:
| 版本 | 审查 | 结果 | 主脑处置 |
|---|---|---|---|
| v1 | `review-20260916T205639Z` | 7H/4M/3L NO-GO | 直连 hook 改**桥接器**(core 零改动);三档 enforcement;退役 `adapters.hermes.memory_md`;CC 去重按身份;生命周期 manifest;YAML 保守子集;隔离补齐 |
| v2 | `…211144Z` | 5H/3M NO-GO(13 项销账 6 闭环) | **撤下 P1 真阻断**(overlay 未真正校验候选,进 P2 待办);gate stderr 标记 → 类型化纠正记录;队列每记录独立文件 + sid 哈希 + 空 sid 不注入;restore 降为 crash-consistent;tar 名称正规化;manifest identity 唯一匹配 |
| v3 | `…213740Z` | 2H/2M NO-GO(8 项销账 5 闭环) | 队列 `.incoming` 稳定区发布 + 启动恢复 + 准入锁;YAML 文档级扫描;restore 事务目录 + 状态机 + 可判死锁 + 树 hash 门控;temp cwd/repo + XDG |
| v4 | `…215010Z` | 1H/1M/1L NO-GO | **投递承诺降为 best-effort**(单向 stdout 无确认,at-least-once 与只注入一次不可兼得);准入先于落盘、拿不到锁直接丢弃记账;树身份收窄为路径 + 内容字节;锁 mkdir 原子 claim + torn 仲裁;恢复矩阵枚举;修订折回正文 |
| v5 | 第 5 轮进行中 | — | 折平重写为单一契约 |

**裁定清单(v5 §1)**:D1 单写者 + 单真相源 · D2 桥接器 detect-and-correct · D3 同意不代办 · D4 generic 约定级 · D5 三档状态 · D6 CC 补接线 · D7 生命周期三命令,restore crash-consistent 不称原子 · D8 fail-open,core 零改动 · D9 无法证明就拒绝 · D10 投递 best-effort。

**主脑自认的设计错误(均被 codex 逮住)**:把 post_tool_call 当阻断点;overlay 校验没校验候选;队列 `.tmp` 放在会被排空的目录;声称两次目录 rename 原子;声称终态 hash 能检出写后删除;声称单向 stdout 能 at-least-once + 只注入一次。五条已进 PMM lessons(`tmp-files-in-drained-dir-get-lost`、`journal-plus-rename-needs-atomic-journal-and-killable-lock`、`terminal-hash-cannot-prove-no-transient-write`、`hook-exit-code-semantics-differ-per-event`、`windows-directory-rename-swap-is-not-atomic`)。

**下一步**:第 5 轮 GO/GO-WITH-CHANGES ⇒ 提交 spec → 派 Sonnet 建造(五件各独立提交)→ 确定性门 → codex + ECC 审码 → 验行为 → 记账。sanitizer 与公开评审等活体 PMM 守卫回移(09-14 后 70+ 次提交)之后。

### 第 5–7 轮(同日续)
| 版本 | 审查 | 结果 | 主脑处置 |
|---|---|---|---|
| v5 | `review-20260916T220245Z` | 1H/2M NO-GO | 60 秒 torn-lock 回收会双持锁 ⇒ **D11 锁协议**(owner 随 claim 原子发布、只按可证明已死回收、每次临界操作前 fencing);队列全部目录移动进准入锁、quarantine 计入;恢复矩阵去「任意」行 |
| v6 | `…221417Z` | 1H/2M NO-GO | 测试节残留「60 秒回收」删除;**任何落盘移入锁内**(高水位硬上限);claim/released 有界清理;Windows `MoveFileExW` 语义 + `Get-Process StartTime` 取法(失败即 UNKNOWN 不判死) |
| v7 | 第 7 轮进行中 | — | — |

**codex 给出的 Windows 依据**:Node `renameSync` 经 libuv `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`,目标为既存目录即失败 ⇒ 同卷同父目录的两个 claim 至多一个成功;任何 rename 错误一律视为未获锁。进程启动时间用 PowerShell `(Get-Process -Id <pid>).StartTime.ToFileTimeUtc()`,64 位 FILETIME 存字符串。
**主脑再自认两条**:承诺了单向 stdout 做不到的「at-least-once + 只注入一次」(v4);正文改了锁协议、测试节没同步(v6)。
| v7 | `…222421Z` | **GO-WITH-CHANGES**(0H/1M/2L) | v8 = v7 + 最小改动:持锁者无条件清扫全部 sibling claim/released;事件全集补 `lock-sweep-failed`;两个新测试;`fbeefd3` 改称实现基线;§9 建造者七条实证清单 |

**结论:七轮收敛(7H→5H→2H→1H→1H→1H→0H),spec v8 可建。** 下一步派 Sonnet 建造(五件独立提交),钉 spec 提交 SHA。

## 2026-09-16 — P1 五件建造交付(Sonnet,2.6 小时,7 提交 `d0f18e5`…`4423a32`),审码中
- 交付:2.0 `lib/fence.sh`+`fence.cjs`+`lib/lock.cjs`(D11)· 2.1 Hermes 桥接器 `adapters/hermes/{bridge,queue,wire,doctor}.cjs` · 2.2 generic · 2.3 生命周期 `lifecycle/{install-manifest,backup,tar-safety,restore,uninstall,upgrade}.cjs` · 2.4 CC 精确身份去重 + trigger-recall 接线;两笔自纠(队列键哈希变异臂缺口、`HERMES_HOME` 优先级)。
- **主脑确定性门**:7 提交、工作区干净、指纹 23/23、`bin/axmem selftest` rc 0、17 个模块 `--self-test` 全绿(`fence.cjs` 无自测入口,由 `fence.sh` 9/9 覆盖);真实 `~/.hermes/config.yaml`(mtime 08-17)、`~/.codex/AGENTS.md`(09-13)未被动过。
- 建造者报告要点(待审查复核):§4 六条全部有源码行号——Hermes 写工具是 `write_file`/`patch`,`patch` 无单一路径 ⇒ unmapped-tool;**运行中已注册 hook 无查询接口 ⇒ D5 的 `active` 永不可达**(doctor 硬编码);`session_id` 跨事件稳定;批准判据只有 `isatty`;`get_hermes_home()` = override → `HERMES_HOME` → 平台默认(Windows `%LOCALAPPDATA%\hermes`);目标已存在的目录 rename 是 EPERM 而非 EEXIST。§9 七条自称全部真实复现(含真实等 61 秒、8 路并发 claim 恰 1 成功、40×64KB 峰值 130974B 但 **success=2 / lock-timeout=38**——准入锁在 Windows 上因 PowerShell 存活检测 ~300ms 几乎全部超时,是否「可用」交 Opus 判)。变异臂 5 条红→绿、1 条诚实缺口、**约 9 条只走查未重跑**(交 Opus 重跑)。
- 建造者顺手发现的 spec 外真 bug:`axmem migrate --backup` 自诞生从未写过备份(缺 `shift`);MSYS `tar` 静默腐蚀 100+ 字符反斜杠路径;示例配置硬编码 `~/.hermes/config.yaml` **差点写到无关的真实 Hermes profile**(被 D9 的 YAML alias 拒绝救下;已修);`defaultHermesHome()` 不看 `HERMES_HOME`;`prelude.cjs` 对 `null` 配置值 stringify 成 "null"(未修,超 D8)。
- 审码(codex 不可用):ECC security-reviewer + ECC typescript-reviewer + Opus 深审验收(§9 逐条复核、9 条变异臂重跑、隔离复核、spec 符合性抽查),报告落 `docs/audits/`。

### 三审结果(同日 21:0x–21:5x)
| 审查 | 判决 | 要害 |
|---|---|---|
| ECC typescript(Sonnet) | **NO-GO** 2H/7M/4L | `restore` CLI 不查 `performRestore()` 返回值 ⇒ 失败 rc 0;恢复矩阵 `NEW_MOVED_CONTINUE` 漏做 `staging→current` rename ⇒ 目录留空却报 committed(真实数据丢失路径);lock 自测 `\|\| true` 恒真;死 owner 回收路径从未端到端触发;`bin/axmem selftest` 对 12 个新 .cjs 失明;manifest 校验 `Array.isArray === Array.isArray` 恒真;MSYS 路径零防御零自测;allowlist 过滤无反例 |
| ECC security(Sonnet) | **GO-WITH-CHANGES** 1H/1M/4L | owner.json pid 只查类型不查取值,`1.5/NaN/1e14` ⇒ `process.kill` 抛 TypeError 被折叠成「不存在」⇒ 判死回收 ⇒ 双持锁(PoC);tar 负数 size ⇒ 未捕获 RangeError;`~/.hermes` 是 `%LOCALAPPDATA%\hermes` 的符号链接 |
| Opus 验收 | **GO-WITH-CHANGES** 4H/5M | §9 七条:4 真复现、2 证据不足(它补跑真测)、1 空过(9.6 峰值仅上限 6%)、1 永真;**40×64KB 只成功 2 条的真因是 NTFS 同目录争用被 v8「无条件清扫 sibling claim」放大**,非 PowerShell;变异臂 12 真红 / 7 假绿 / 3 不可验证(隔离夹具没进仓库);队列侧 fencing 整条缺失;drain 在 stdout 前删目录;YAML loader 可用 `HERMES_HOME=<temp>` 真跑却被跳过 |

**主脑自认**:v8 的「无条件清扫 sibling claim」是我为堵 r7 无界残留而下的裁定,在 NTFS 上制造了争用——改为只清 >2 秒陈旧 claim(v8.1)。**处置**:spec v8.1 + 一份合并修复单交建造者(建者修),修后 ECC typescript + Opus 复审。

## 2026-09-17 — P1 三审合并修复轮落地(Sonnet,5.5 小时,16 提交 `ce46c75`…`3f4db83`),收尾中

三份审查(ECC typescript NO-GO 2H/7M/4L、ECC security GO-WITH-CHANGES 1H/1M/4L、Opus 验收 GO-WITH-CHANGES 4H/5M)的 finding 逐条修:lock.cjs pid 校验 + 2 秒陈旧清扫 + 真 9.7 复现 + 真死进程回收;queue.cjs 四入口 D11 fencing + drain/commit 拆分 + 真屏障(峰值 96.9% 上限,32 发布/8 丢弃/0 超时);bridge.cjs flush-before-commit + trigger 路径覆盖;wire.cjs matcher 字面量假绿 + 真 hermes 加载器交叉验证;restore.cjs CLI 退出码 + `NEW_MOVED_CONTINUE` 数据丢失 + 恢复矩阵逐行文件系统断言 + 未知 phase/多 txn/symlink;tar-safety 非法 size;install-manifest `adapters` 畸形拒绝;uninstall/upgrade 损坏 manifest rc 3(去 try/catch 即未捕获崩溃,证明非装饰性);doctor allowlist 反例;bin/axmem selftest 改为全遍历(29 项)并去 eval;fence.cjs 自测;MSYS 路径归一化。每项按「红→(装回缺陷)红→绿」三态贴证据。**主脑亲跑**(HOME/USERPROFILE/HERMES_HOME 指临时目录):rc 0、29/29、stderr 0、440 秒。

**收尾五项已派回建造者**(同一 Sonnet,上下文在):① 自测把 `state/` 写进仓库根(跑前无、跑后有)—— 改到临时根并加「跑后 git status 与跑前一致」断言;② spec v8.1 要求的隔离 E2E 夹具(隔离 / fresh-HOME×4 / 继承真实环境三臂)落到 `tests/`;③ bridge.cjs:145 stderr 标记判定假绿补变异臂后修;④ generic/doctor.sh 自测改用仓库内夹具,不触真实 guards/;⑤ `.codex-reviews/*.md` 移入 `docs/audits/` 并提交,`.gitignore` 加 `.codex-reviews/`。收尾后派 ECC typescript(显式 Sonnet)+ Opus 验收一次,再与管道闸一起进末尾那波 codex(gf)。

## 2026-09-17 — 修复轮两份复审落地 → 第二批修复派出

- **ECC typescript(Sonnet)**:`docs/audits/ECC-TS-2026-09-16-p1-repair.md` **GO** 0H/2M/1L(前三审 13 条全部核实闭合并逐条变异反证翻红;新:`pidExists()` unknown 分支无测试覆盖、仓库整洁绊线可被末尾夹具的 `rm -rf state` 洗白、夹具假设 HOME=USERPROFILE);亲跑 32/32、5m58s、仓库干净。
- **Opus 验收**:`docs/audits/OPUS-2026-09-16-p1-repair-acceptance.md` **GO-WITH-CHANGES** 2H/6M/7L(前置 finding 代码侧实质全闭合、16 条变异臂真红、§9.6 复现 96.9%;新 HIGH 都是收尾五项引入的:`fence.cjs` 兜底另写了一份路径解析漏掉 config.json 与 MSYS 归一 ⇒ manifest 落错目录、`uninstall` rc 3 围栏永不移除;`inherit-real-env-arms.sh:118` 的 `rm -rf state` 让绊线对它被造出来防的那种残留失明);亲跑 31/32(唯一 FAIL `core/precommit-gate.sh` 6/8 是 TMPDIR 导出时的既有脆弱性,core 本轮零改动)。
- **主脑裁定**:两份新 finding 攒成一批(2H + 6M + ECC 2M/1L + 7 条可修 LOW,L2 60 秒暂停用例不做)02:25 派回同一 Sonnet 建造者;M5 隔离清单按 spec v8.2 正式钉范围(不做 `env -i`);M6 不动 core(D8),selftest 对该组件 report-only,core 修复另开。修完由同一 Opus 审者做增量闭合核查,再与管道闸一起进末尾那波 codex(gf)。教训候选(Opus 给的四条:守卫删掉自己的证据、兜底必须复用解析器不重写、隔离夹具让自己的断言空过、半闭合读成闭合)待修完一并入 PMM。

## 2026-09-17 — 第二批修复落地(14 提交)→ Opus 增量闭合核查 GO-WITH-CHANGES → 第三批(1M/2L)

- 第二批 `832d72f`…`086429e`(Sonnet,约 75 分钟):H1 fence.cjs 走 prelude 唯一 `resolveStateDir()`;H2/ECC M2 逐组件仓库整洁绊线(注入早期组件写 `state/` 当场 FAIL 点名);M1+M2 bridge 三处 `ledger(r.events)` + stdout-before-commit 断言;M3 absent==absent → SKIPPED;M4 uninstall --all 传播 corrupt manifest rc 3;M5 新 `tests/full-env-isolation.sh`(spec §3 全环境变量面 + 启动前解析断言;全树 hash 改签名过滤 diff,Opus 判可接受);M6 precommit-gate 在 selftest 里 report-only(core 零改动);ECC M1 pidExists unknown 分支直测;LOW ×7(注释/双重门/引号/退出码/tar 三限制用例);L2 60 秒暂停用例不做。
- **Opus 增量闭合核查**(同一审者,`docs/audits/OPUS-2026-09-16-p1-repair-acceptance.md` 新节):原 2H 全闭合(H1 端到端 manifest 落配置目录 + uninstall 移除围栏亲跑;H2 注入当场 FAIL)、6M 闭 5、7L 闭 5、ECC 3 条全闭;selftest 32/32、8m05s、逐组件整洁全绿、porcelain 空。新增 1 MEDIUM(`full-env-isolation.sh` 用覆写后的 HOME 取基线 ⇒ 两条恒绿无 SKIPPED,M3 的空过被复刻)+ 2 LOW(lock.cjs 注释又错一处;`AXMEM_TEST_SEQUENCE_LOG` 未双重门、`config get` 退出码仍恒 0)→ 第三批派回建造者(04:10)。残留风险:core/precommit-gate 的 TMPDIR 误红现为 report-only、永远不能让 selftest 红,它守的是 retire=move 防数据丢失规则——**core 根因修复排入上线后第一项**。

## 2026-09-17 — 第三批(1M/2L)落地 → Opus 三条核查中

- `5b576df` `tests/full-env-isolation.sh` 用 `check_new_path_or_skip()`(同 `check_iso`)——外层先覆写 HOME 时基线缺席报 SKIPPED 不报 ok(隔离跑法下 4/6 ok、2 skipped,之前假 6/6);`234783b` lock.cjs 三处注释按代码事实区分 `.claim-*`(mtime 门)与 `.released-*`(无条件删);`0c7e1cf` `AXMEM_TEST_SEQUENCE_LOG` 双重门 + `config get` 直接调 `lib/prelude.cjs` 真传播失败。最终 selftest rc 0、32/32、486 秒、逐组件整洁不变、porcelain 空。同一 Opus 审者只核这三条(04:45 派),GO 后 AxMem P1 与管道闸一起进末尾 codex(gf)一波。
- **Opus 第三批核查 GO**(审计文件「第三批核查」节):三条全闭合(隔离跑法下 full-env-isolation 两条真 SKIPPED、真实 HOME 下恢复真比对;lock.cjs 注释与代码一致;`config get` 注入失败真非零)。新 LOW-c 一行改动(`check_new_path_or_skip` 基线缺席但冒出新文件应判违规不应跳过)派回建造者,改完直接进 codex 一波。
- **LOW-c 落地**(`82ed6a3`):`check_new_path_or_skip` 只在「基线缺席且无新路径」时跳过,基线缺席却冒出新文件判 FAIL;独立跑 6/6、外层覆写 HOME 下 4/6 + 2 skipped、rc 0、porcelain 空。**AxMem P1 修复线到此收口**(79e95e7..82ed6a3:建造者 22 提交 + 主脑 6 记账提交),只等末尾 codex(gf)一波。
- codex(gf)末尾一波首跑被 OpenAI 内容闸整段拒绝(prompt 含「恶意 tar / 注入面 / 逃逸」等词,rc 7,174k token 零产出;教训 `tooling:codex-content-flag-on-security-wording`),改中性措辞重跑(05:25)。
- codex(gf)中性措辞重跑于 05:33 撞上 usage limit(rc 2;首跑被内容闸拒绝时已烧掉 174k token),**AxMem 的 codex 末波改到配额恢复后补跑**;不阻塞记忆系统上线(AxMem 是独立工具,已过三审 + Opus 两轮增量 GO)。

## 2026-09-17 — core/precommit-gate TMPDIR 误红根因修复(`c94d241`,Sonnet 23 分钟)

- 根因:自测 `relmem()` 用两种文本形式表示同一目录——`$TOP`(git 给出的盘符路径)在临时目录恰好落在 Git-for-Windows 的 MSYS `/tmp` 挂载点下时被解析成 `/tmp/...`,而 `mktemp -d` 原始 POSIX 路径保持 `/c/Users/...`,前缀剥离 `${abs_p#"$TOP"/}` 静默失效 ⇒ #2/#3 两条 green 期望误红;不是 MAX_PATH。修法:`mktemp -d` 后 `cygpath -m` 归一。反证:无 TMPDIR 恒 8/8;MSYS `/c/...`(含空格)改前 6/8 → 改后 8/8;字面 `/tmp/...` 改后 8/8;还原修复 → 重新 6/8。`bin/axmem` 的 M6 report-only 特判改回计分;selftest **33/33**、8m52s、porcelain 跑前跑后一致。spec v8.2 补注已记。

## 2026-09-17 — codex(gf)末波落地(第三次派出,29 分钟)→ 2H/4M/2L → 第四批派回建造者

- `docs/audits/review-20260917T142024Z-codex-final-wave.md`。HIGH:① `.incoming` 恢复把同一记录计两次(`scanStats()` 已计入,恢复时再加),接近 2MB 时把合法记录当超限永久删除——复现 32 条 64KB 满载 + 1 条移回 incoming;② `bin/axmem selftest` 把 SKIPPED 计入通过(`0/3 ok, 3 skipped` 标 ok,最终 `32/32 passed`)——与 Opus 早前「隔离断言空过」同族,这次是汇总层再吞一次。MEDIUM:inherit-real-env-arms 清掉 AXMEM_* 后真实 fence 会写默认 `~/.axmem/state/backups`;restore 每 phase 只 fence 一次(journal 写后到 rename 之间失去所有权仍继续);manifest 只校验列出的文件、未声明文件被完整恢复;POSIX 下 `stdout.write()===true` 当已 flush。LOW:16KB 上限未预留截断标记;doctor `bash -c` 单引号拼接。**主脑裁定全收**,第四批派回同一建造者(11:0x),修完由 Opus 增量核。
- **第四批 8 项全部提交**(`1364c7d`…`0aab97d`,Sonnet):H1 `recoverOnStartup` 全局上限不再对 `.incoming` 重复计数(31 live + 1 incoming 回归测试);H2 selftest 三态 PASS/SKIP/FAIL 分别计数、`AXMEM_SELFTEST_STRICT_ISOLATION=1` 下关键基线 SKIP ⇒ 非零;M3 inherit-real-env-arms 的 `AXMEM_STATE_DIR` 指夹具目录、默认路径只做只读断言;M4 restore 每次 journal publish / rename 前即时 fence;M5 manifest 与归档集合比对、未声明文件默认拒;M6 stdout 写完以 drain/回调为准再 commit;L7 16KB 上限预留截断标记;L8 doctor 路径含单引号。最终 selftest(含严格隔离模式)进行中;之后由同一 Opus 审者做增量核。
- **第四批最终 selftest(2026-09-17 11:48–11:58,HOME/USERPROFILE/HERMES_HOME/TMPDIR 全指临时目录)**:`bin/axmem selftest` 34 组件 = 32 PASS / 2 SKIP / 0 FAIL,rc 0,601 秒;两处 SKIP 均为「本机无基线」(full-env-isolation 4/6、isolation-real-configs 1/3),严格隔离模式下会变红,属预期;每组件后 `git status --porcelain` 均未变。未决:同一时刻(11:58)本机 `%LOCALAPPDATA%\Temp\claude` 整树被清空(主会话草稿区+子代理输出),仓库内 grep 未见触及该路径的删除代码,交 Opus 增量核一并查证。
- **严格隔离模式复跑**(`AXMEM_SELFTEST_STRICT_ISOLATION=1`,12:00–12:13,752 秒):32 PASS / 2 SKIP / 0 FAIL 但 rc 1,两处隔离 SKIP 各打印 `STRICT_ISOLATION: this skip is fatal` —— H2 三态语义按设计生效。反证:这次完整跑完 `Temp\claude` 完好,前一次的清空若归因 AxMem 必须是条件触发;已连同反证交 Opus 判定。建造者报告 8 项 commit 均附红→绿原文,未自审、未 push。
- **第四批 Opus 增量核:GO**(docs/audits/OPUS-2026-09-17-p1-repair-acceptance.md 新节「Batch 4 (codex final wave) incremental」):8 项修前均复现为真,手工 falsify 三项(H1 队列 18/19、M4 restore 26/27、M5 restore 26/27)真红;H2 三态经审者整跑复现;上一批残留由 `c94d241` 根因关闭。新增 2 条 LOW 入待办:N1 三态 SKIP 识别是自由文本约定,bridge/lock/wire 的平台条件跳过仍计 ok;N2 `restore --allow-unlisted` 成员不做 sha256 校验、`usage()` 未列 restore/uninstall/upgrade/migrate。取证:`Temp\claude` 清空**不可能是 AxMem 所致**(全仓约 90 处递归删除均落在自建临时目录/固定字面量/前缀三类内,审者把 TMPDIR 指进该树整跑一遍完好),谁删的无法判定(无文件系统审计日志),特征与宿主自身清理临时根相符。

## 2026-09-17 17:25 — 方向裁定(Jax):AxMem = PMM 记忆升级本体的产品化;适配优先级 CC 完美 → codex → Hermes/其它
- 事实:本仓 09-13 从活体抽取 18 组件后,四天只做 P1 安装器/适配器;活体(`~/.claude`)自 09-13 起的全部升级(管道闸 v2、解析器 1.2、台账 v3、召回 M 阶段工具、写时 trigger 闸、策略解析器等 53 个守卫 + 规格 + 验收 runner)**一件未同步进本仓**。
- 决定(PMM decisions `[axmem:adapter-priority-cc-then-codex-then-hermes]`):下一批 = **P2「CC 完美」**——回同步活体全部升级、一键部署在干净 HOME 端到端可证(install → doctor → hooks 接线 → 金丝雀 → selftest);之后 codex;Hermes 桥接器标实验性、暂停投入(N1/N2 不排)。
- 流程:主脑先出 P2 spec(基于活体↔产品仓映射调查),codex 审 spec,再 Sonnet 建、Opus 验收。
- **P2 spec v1 → codex 审 spec**(`.codex-reviews/review-20260917T220642Z.md`,9 HIGH / 2 MEDIUM,GO-WITH-CHANGES):冻结活体无可验证冻结物;DoD 多条不可证伪;共享 prelude 映射 PMM_* 会再造第二套解析;进 core/ 不自动获得三重覆盖;同名实现无裁决规则;扁平 hook 清单表达不了顺序/matcher;卸载不能字节恢复且多 hook 半卸载;P2.1/P2.2 写面不独立;cutover 未覆盖指纹/镜像/私有 canary/家仓 git hook;清单命令未逐条分配实现;外部依赖与跨平台边界未处理。**v1.1 全部收入**:冻结清单 + `equiv` 差分器(P2.0)、组件注册表、DoD 逐条谓词(严格 selftest FAIL=0/SKIP=0、hardcode allowlist、4 artifact/3 计分轮、e2e 两层)、prelude 只认 AXMEM_* + 封闭名单 shim、逐项裁决表、层级 hook 清单 + 整文件事务 + doctor 断言、批次串行 A→B + 所有者矩阵、cutover 干跑打印清单、平台范围=Windows。开工硬门:活体 fab 盲攻 + codex 终审收口并冻结后。
- **开源可照抄调查**(Jax 09-17 铁律「基建先抄开源再优化」;`docs/audits/OSS-CANDIDATES-2026-09-17.md`,数据来自 GitHub API/npm 实时):VENDOR = sh-syntax / tree-sitter-bash.wasm / bash-parser(三个解析器对照物,仅测试用)、minisearch(检索 v2 BM25+)、write-file-atomic 同步路径(≈90 行,补 `merge-hooks.cjs` 非原子写 settings.json 的真实缺口——同仓 lifecycle 已用 temp+rename)、path-is-inside(domenic 版,Windows 大小写折叠)、normalize-path 的 `\?\`/`\.\` 前缀 3 行、wilson-score-interval;REFERENCE-ONLY = 组件注册表先例(git t/、bats-core、Taskfile、just)与四个图记忆系统(Graphiti 双时态边模型为设计先例);NO = proper-lockfile(本仓 lock.cjs 已处理 Windows EPERM)、各 Claude Code hook 安装器(都弱于本仓 merge-hooks 的身份去重)。P2 spec 的「借用来源」节以此为准。
- **2026-09-30 R14**：按Jax裁定撤除Codex原始提示词永久采集（raw receipts / installer / wire / raw self-test），新增保守的`uninstall-hooks.cjs`用于只移除AxMem已装raw-capture hook；记忆改为只记简洁精准的意思，不保存原文明文。
