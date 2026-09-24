# OPUS 深审验收 — AxMem P1 收口交付(`e0959ba..4423a32`,7 提交)

审查者:Opus(验收层,只读;唯一写入 = 本文件)。日期 2026-09-16。
对象仓库 `C:/Users/<user>/Desktop/axmem`,spec `docs/P1-ADAPTERS-SPEC.md` v8。
**所有结论均由本人在本机重跑复现**;建造者报告未被采信,只作对照。
变异臂在 scratchpad 的临时副本(`.../scratchpad/axmem-mut`)上进行,真实仓库工作区未被改动
(复核:`lib/lock.cjs` sha256 与仓库一致;`git status` 除既有 `.codex-reviews/` 外干净)。

---

## HIGH

### H1 §2.1 队列侧完全没有 fencing —— D11 明确要求的临界写前核对缺失

`lib/lock.cjs:326 fenceCheck()` 实现了,`lifecycle/restore.cjs:205,213,225,236` 用了,
**`adapters/hermes/queue.cjs` 全文 0 处调用**(`grep -rn "fenceCheck" adapters/` 零命中)。
但 queue 的临界写一个不少:

- `adapters/hermes/queue.cjs:185` 写 `.incoming/<uuid>.tmp`
- `adapters/hermes/queue.cjs:192` rename → `.incoming/<uuid>.json`
- `adapters/hermes/queue.cjs:199` rename → `<key>/<uuid>.json`(发布)
- `adapters/hermes/queue.cjs:286` rename `<key>/` → `<key>.draining-<uuid>`
- `adapters/hermes/queue.cjs:355,375,392` 恢复期的 quarantine / 重发布 / draining 回迁

spec §1 D11 原文:「持锁者在**每次**临界操作(目录 rename、journal 写、发布)前重读
`<lock>/owner.json` 并比对 nonce,不符 ⇒ 立即中止、记 `lock-fenced-abort`」。
连带后果:§2.1 台账事件全集里的 `lock-fenced-abort` 在队列侧**永远不可能被发出**。

触发路径代码级真实存在:`lib/lock.cjs:276-285` 判定 owner 已死后**无条件** `rmSync(lockPath)`,
两个并发回收者读到同一个死 owner 时,第二个的 rmSync 会删掉第一个刚发布的**活**锁。
实测缓解:我用 8 并发 × 4 轮针对「人造死 owner」的锁做了双持探测(`scratchpad/rr2.cjs`,
持有者保持存活 4 秒并每 500ms fence 一次),**未复现双持**:每轮 acquired=1;
唯一一次 acquired=2 是第一持有者 4.4 秒后已退出、成为合法死 owner 后的顺位回收;
fence 失败计数 0/32。故实际风险很低,**但规格点名的兜底控制确实缺席,而它正是兜这条路径的**。

改法:`produce()` / `drain()` / `recoverOnStartup()` / `quarantineMalformed()` 在每次
rename / writeFileSync 之前调 `lock.fenceCheck(lp, claim.nonce)`,false ⇒ 立即 return 并
`ledger([{event:'lock-fenced-abort'}])`。

### H2 §9.6 的 40×64KB 屏障断言是**空过** —— 峰值只到上限的 6%,硬上限从未被逼近

我重跑 `node adapters/hermes/queue.cjs --self-test`,逐字输出:

```
-- §9.6 40x64KB barrier: peak=130974B ceiling=2162688B samples=251 (10ms interval)
   success=2 dropped=0 lock-timeout=38 unparsed=0 elapsed=4686ms
ok   12 (§9.6) peak on-disk bytes under 40x64KB barrier stays <= 2MB + 64KB
```

`130974B = 2 × 65487B`。断言 `peak <= 2162688` 在只有两条记录落盘时**恒真**,
它没有证明任何关于 2MB 上限的事;要真正压到上限需要 ≈32 条发布成功。
**这是 spec §9 七条里唯一明确要求「报告实际峰值」的一条,而报出的峰值恰恰说明测试无效。**

改法(二选一):① 把屏障子进程的 `timeoutMs` 从 3000 提到足以让 ≥32 条真发布(或分批放行),
再断言峰值 ≤ 2MB+64KB 且出现 `queue-admission-dropped`;
② 保留现状,但自测输出与 README 如实写「本轮未逼近上限,硬上限未被实证」。

### H3 七条变异臂实测为**假绿**

详见〈变异臂重跑表〉。其中两条最关键,且都在建造者列的「只做代码走查未重跑」那批里:

- **matcher 改错**:`adapters/hermes/wire.cjs:66` 的 `'^(write_file|patch)$'` 改成 `'^(Write|Edit)$'`,
  `wire.cjs 20/20`、`doctor.cjs 4/4`、`install-manifest.cjs 6/6` **全绿**。
  即:接线出一个 Hermes 永远不会触发的 matcher,四层自测无一发现。
- **准入检查移到落盘之后**:在 `queue.cjs:169` 的 `scanStats` 之前插入一次
  `fs.writeFileSync('.incoming/<uuid>.tmp')`,`queue self-test 13/13` **全绿**。
  「磁盘高水位硬上限」这条 v7 才收进 spec 的不变量,**没有任何一条测试守着它**。

### H4 spec §3 规定的隔离夹具 / fresh-HOME E2E / 夹具文件**一个都没进仓库**

`git ls-files` 里没有任何 test/fixture 目录;全部证据寄生在各模块的 `--self-test` 里。直接后果:

- §3「隔离」清单(全树 hash 前后比对、`env -i`、先验路径断言)**无法被任何人重跑**;
- 变异臂「继承真实 `AXMEM_STATE_DIR`」「继承真实 `XDG_CONFIG_HOME`」「cwd 指向真实仓库」
  **永久不可验证** —— 它们保护的正是「别写到用户真家目录」,而建造者自报的险情
  (示例配置硬编码 `~/.hermes/config.yaml`)恰恰属于这一类;
- §3 的「fresh-HOME E2E ×4」「YAML 接受态字节等于预期」「恶意 tar 每形态一例且现目录不变」
  在仓库里找不到可执行对应物(YAML/tar 的**拒绝**态确在 `--self-test` 里;
  接受态的「字节等于预期」与 tar 的「现目录不变」没有)。

改法:把跑过的 E2E/隔离脚本落到 `tests/` 并进 `bin/axmem selftest` 名册;
至少把三条隔离变异臂对应的前置断言(state dir / XDG / cwd 必须在 temp 内)做成可执行检查。

---

## MEDIUM

### M1 `drain()` 在写 stdout **之前**就删掉 draining 目录,与 §2.1 明文相反

`adapters/hermes/queue.cjs:316` 先 `rmSync(drainingDir)` 再 return,
`adapters/hermes/bridge.cjs:184` 才 `process.stdout.write(...)`。
spec §2.1 原文:「**写完 stdout 后删除 draining 目录**」。
D10 两种失败都可接受,但顺序一反,崩溃窗口从「可能重复注入(可由 `draining-recovered` 恢复)」
变成「静默丢失(不可恢复)」—— 而 §3 里那条「stdout 之后、删除之前崩溃 ⇒ 10 分钟后
`draining-recovered`」在真实路径上已无对应窗口(queue 自测 #9 是直接伪造 draining 目录,绕过了 `drain()`)。
改法:`drain()` 返回 `{context, commit()}`,由 bridge 写完 stdout 后再调 `commit()` 删除。

### M2 `lock-sweep-failed` 在队列侧永远进不了台账

`claimLock()` 把 sweep 事件放在返回值 `events` 里(`lib/lock.cjs:292-293`),但
`queue.cjs:154`(produce)、`:276`(drain)、`:329`(recover)、`:251`(quarantine)
**全部丢弃 `claim.events`**;`produce()` 的 `finally` 更写了个空循环把 release 的事件也吃掉:

```js
// adapters/hermes/queue.cjs:212-213
const rel = lock.releaseLock(lp, claim.nonce);
for (const e of rel.events) { /* lock-sweep-failed — surfaced via caller ledger if it wants it */ }
```

§9.7 要求「清扫失败产生 `lock-sweep-failed`」—— `lib/lock.cjs` 层产生了,产品层丢了。

### M3 §2.1「优先用 Hermes 的配置校验/加载命令」这条分支基于一个**可反驳的前提**被跳过

`adapters/hermes/wire.cjs:9-12` 写:「`hermes config` 没有 `--file`,`hermes hooks list/doctor`
只读 LIVE 配置路径,所以只能用保守子集」。
但 Hermes 的 home 解析是 `HERMES_HOME` 优先 —— **这正是建造者自己在 `4423a32` 查实并修的**
(`wire.cjs:35-37 defaultHermesHome()`)。因此 `HERMES_HOME=<temp> hermes hooks list`
(temp 内放候选 config.yaml)就是一条能对**任意候选**跑真 loader 的通道。
我已确认 `hermes hooks list` 走真 loader:
`AppData/Local/hermes/hermes-agent/hermes_cli/hooks.py:_cmd_list` → `load_config()` + `shell_hooks.iter_configured_hooks(cfg)`。
风险方向是安全的(子集只会更保守),但结论是:通过文本子集 ≠ Hermes 真能加载,
而这个写入**落在用户真实 config.yaml 上**。
改法:写入前用 `HERMES_HOME=<temp>` 对原文件与候选各跑一次 `hermes hooks list`,
任一非零 ⇒ rc 3;`hermes` 不在 PATH 时退回现子集。

### M4 D11 锁在 NTFS 上的并发吞吐 ≈ 2–3 次/3 秒预算,且与 PowerShell 存活检测**无关**(实测)

主脑问的「是不是 PowerShell ~300ms 导致准入锁在 Windows 上实际不可用」—— **不是**。逐项实测:

- `processStartTime()` 单次 = **325ms**;无争用 `claimLock()` = **341ms**;`releaseLock()` = 2ms;
  无争用 `produce()` = **354ms**。
- 纯锁争用探测(`scratchpad/probe2.cjs` / `probe3.cjs`,完全不碰队列 IO):N=40 时
  `won=2 lost=38 attempts(min/med/max)=1/2/2`,失败原因 **38/38 全是
  `claim-dir-lost-to-concurrent-sweep`**,单次 `tryClaimOnce` 耗时 **1.7–2.7 秒**。
- 对照实验:把 PowerShell 整条短路掉(`processStartTime` 直接返回 `unknown`)—— N=40 仍
  **2–3 成功**,单次尝试仍 1.7–2.7 秒;再把 `sweepSiblings` 也关掉 —— 仍是 2。
  ⇒ 瓶颈是 **NTFS 上 40 个进程在同一目录里 mkdir + 写 `owner.json` + `rmSync` 的目录项争用**,
  被 v8 新加的「持锁者无条件清扫 sibling」放大(持锁者删光 39 个在途 claim 目录,
  在途者落在 mkdir→rename 窗口里被删,只能重试)。
- 规模:N=3 → 3/3(1.2s);N=8 → 6/8;N=40 → 2/40。

**定性:这是诚实的失败安全** —— 38 条全部记 `queue-lock-timeout`,无静默丢失,字节上限从未被逼近;
**不是「锁不可用」** —— 真实 Hermes 负载是每个 hook 一个 bridge 进程,并发度 1–2,该区间实测 100% 成功。
但它是 H2 的直接成因;另外每次 `produce()` 固定 ~354ms,`post_tool_call` 调两次 produce、
`pre_llm_call` 取两次锁 ⇒ 每轮 LLM 前固定 +0.7s 延迟。
可选改法(非阻断):`lib/lock.cjs:231-234` 每次 claim 都重算本进程 FILETIME,
而它在进程生命周期内恒定 —— 模块加载时算一次并缓存,可把 mkdir→rename 的被扫窗口压到亚毫秒;
再给 `claimLock` 退避加抖动。

### M5 `fence.cjs` 没有 `--self-test` 入口(主脑观察到的 rc=1 已查明,但结论要修正)

`node lib/fence.cjs --self-test` → 打印 usage、rc 1(`lib/fence.cjs:200-207` 的 `main()` 无该分支)。
CHANGELOG:41 称「由 `fence.sh` 9/9 覆盖」。`lib/fence.sh` 的自测确实覆盖围栏语义,
但 `fence.cjs` 独有的 `recordLifecycleTarget()`(写 lifecycle manifest 的 pre/post sha256)
不在 `fence.sh` 路径上,属真空。

---

## LOW

- **L1** `lib/lock.cjs:481-483` 自测 #8 的「等子进程退出」循环用同步 `spawnSync` 轮询 `child.exitCode`,
  而同步循环里事件循环不转,`exitCode` 恒为 null ⇒ 该循环**必然**跑满 10 秒。
  测试靠超时而非条件结束(整个 `--self-test` 我实测 **14.3 秒**,其中 10 秒在这里空转)。
- **L2** `adapters/hermes/queue.cjs:110` 算出的 `quarantineCount` 从未被 `produce()` 的准入判定读取(死变量);
  quarantine ≤100 只靠 `dropOldestFromQuarantineIfOverCap` 事后删除。行为符合 spec,变量是死码。
- **L3** `bin/axmem:19` 每条 axmem 命令都 spawn 一次 node 跑 `--recover-on-startup`;
  注释称「cheap no-op」,实测 node 冷启 ≈50–80ms,不是 no-op。
- **L4** `lifecycle/tar-safety.cjs` 的三条限制(总展开 512MB、路径长度 240、GNU sparse `S`)
  代码里有(`:19-22,:96`),19 条自测里没有对应用例。
- **L5** `adapters/hermes/bridge.cjs` 的 9 条自测里**没有一条断言 `kind:'recall'` 记录出现**,
  §2.1 表格第 ③ 步(trigger 正规化 → 入队)整条支路零覆盖 —— 这正是 M2a/M2b 假绿的根因。
  spec §3 要求「Hermes 的 fresh HOME 预置一条能命中的 trigger」,仓库里的自测没有预置。

---

## §9 复核表(七条,逐条判「真实复现 / 结构推理」)

| # | 要求 | 建造者证据 | **本人复核结论** |
|---|---|---|---|
| 9.1a | 缺失/损坏的正式锁 owner 永不回收 | `lock.cjs` 自测 #2/#3 | **真实复现**。我重跑得 `9/9`;#2/#3 真造了 ownerless / 截断 owner 的锁目录并确认「未获锁且锁仍在」 |
| 9.1b | **活 owner 暂停 >60 秒时第二方不得获锁** | 自测 #4 是同进程瞬时二次 claim,**既没暂停也没 60 秒**,属结构推理 | **建造者证据不足;我另跑真测补齐**:子进程 claim 后 `Atomics.wait` 挂起 100 秒,父进程在 t=+6/36/66/76s 各试一次 → 四次全为 `acquired=false reason=owner-alive ownerStatus=alive ownerNonceUnchanged=true`。**结论成立,但功劳不在提交的自测里** |
| 9.2 | 未发布 claim 不阻塞;完整/缺失/截断 owner 的 `.claim-*` 由下一持锁者清零且无双持 | 自测 #5/#6 | **真实复现**。#6 用 `injectCrashAfterClaimDir` 真造了 missing/truncated 两种残留,`strayBefore=2 → strayAfter=0`,且 `readOwner(lp).nonce === real.nonce` |
| 9.3 | fencing 在「核对→暂停→owner 被替换→恢复」序列中于临界写前再次核对并中止 | `lock.cjs` #7 只是 `fenceCheck()` 的单元断言;`restore.cjs` #6 才是真临界路径 | **restore 侧真实复现**(`restore.cjs:555`:`r.reason === 'lock-fenced-abort'` 且 `decisions.md` 字节不变)。**队列侧不存在**(见 H1) |
| 9.4 | 两个并发目录 claim 至多一个成功;任意 rename 错误均判未获锁 | 自测 #8(8 并发,got 1) | **真实复现 + 我加测**:我另跑 N=8 得 won=7(分时序,任一时刻仅一持有)、N=40 得 won=2,从未观察到同时双持;`rename` 到既存目录实测抛 **EPERM(errno -4048)**,不是 EEXIST —— 佐证「不看错误码」是必要的,`lock.cjs:266-268` 的 catch-all 正确 |
| 9.5 | 三态存活检测;FILETIME 全程十进制字符串 | 自测只有一条正则断言,**dead / unknown 两态没有测** | **建造者证据不足;我逐态实测补齐**:活 = `{"status":"alive","startTime":"134340825676413131"}`(十进制字符串,`BigInt > 2^53` 为真 ⇒ 确实不能过 JS Number);死 = 不存在的 pid 60000 → `{"status":"dead"}`;UNKNOWN = pid 4(System,访问受限)→ `{"status":"unknown"}` 且 `pidExists=true`,`timeoutMs:1` 强制超时 → `{"status":"unknown"}`。另测:异机 host → unknown;无 startTime 记录 → unknown;startTime 不符(pid 复用)→ dead。**三态与规格完全一致** |
| 9.6 | 40×64KB 屏障报告实际峰值/采样间隔/成功-丢弃-超时,峰值 ≤ 2MB+64KB | peak=130974B success=2 lock-timeout=38 | **数字真实(我复现 3 次,peak 恒为 130974B),但断言空过**(见 H2)。成功只有 2 的成因我已定位到 NTFS 目录项争用而非 PowerShell(见 M4) |
| 9.7 | 清扫失败产生 `lock-sweep-failed`,互斥不变 | 自测 #9 的断言写成 `(sawSweepFailedEvent \|\| !chmodApplied \|\| true)`,**永真** | **该断言无效**(`lib/lock.cjs:516` 的 `\|\| true` 让整个括号恒真)。`sweepSiblings()` 的 catch 确实 push 了事件(`:203-205`),「互斥不受影响」那半(`r.acquired && fs.existsSync(lp)`)有效;但 Windows 上 `chmod 0o444` 挡不住 `rmSync`,所以**失败分支在本机从未真正复现过**。叠加 M2(队列侧丢弃事件),§9.7 在产品层等于未验证 |

---

## 变异臂重跑表

在 `scratchpad/axmem-mut` 临时副本上逐条改一行 → 跑对应自测 → 还原。

> 方法学注记:第一版 harness 用 `String.replace(old, new)`,替换串里的 `$'` 被 JS 当成
> 「匹配之后的部分」特殊标记,污染了 M1 的结果(误报 RED)。改用 `replace(old, () => new)`
> 后复跑确认 M1 实为 GREEN。下列结论均出自修正后的 harness。

| 变异臂 | 改动位置 | 结果 | 证据 |
|---|---|---|---|
| matcher 改错 | `wire.cjs:66` `'^(write_file\|patch)$'` → `'^(Write\|Edit)$'` | **假绿** | wire 20/20、doctor 4/4、install-manifest 6/6 全 rc=0 |
| 正规化映射删除(`tool_name→Write`) | `bridge.cjs:160` | **假绿** | bridge 9/9 rc=0 |
| 正规化映射删除(路径→`file_path`) | `bridge.cjs:160` 改回 `path:` | **假绿** | bridge 9/9 rc=0 |
| post→pre_llm 转运删除 | `bridge.cjs:147-152` 去掉 write-gate 入队 | 真红 | bridge 5/9,FAIL #1/#2/#3 |
| gate stderr 标记判定删除 | `bridge.cjs:145` 去掉 `includes('<!-- axmem-write-gate -->')` | **假绿**(建造者已自报) | bridge 9/9 rc=0 |
| 队列键改原始 sid | `queue.cjs:45` → `return sessionId` | 真红 | queue 12/13,FAIL #0(`63ef010` 补的那条确实有效) |
| 准入检查移到落盘之后 | `queue.cjs:169` 前插一次 `writeFileSync('.incoming/*.tmp')` | **假绿** | queue 13/13 rc=0 |
| allowlist 判定恒真 | `doctor.cjs:57` 直接 `return {approved:4,...}` | 真红 | doctor 3/4,FAIL #2 |
| doctor Hermes 段恒 green | `doctor.cjs:143` 追加 `tier='approved'` | 真红 | doctor 3/4,FAIL #1 |
| YAML 文档级扫描删除 | `wire.cjs` `fullDocumentViolations` 直接 `return []` | 真红 | wire 13/20,FAIL #9/#10/#11… |
| CC 去重恢复「任意 axmem 字样」 | `merge-hooks.cjs:57` → `includes('axmem')` | 真红 | merge-hooks 3/5,FAIL #3/#5 |
| identity 匹配改为「首个」(json-hook) | `uninstall.cjs:73` 去掉「≥2 拒绝」 | 真红 | uninstall 6/7,FAIL #5 |
| identity 匹配改为「首个」(**fence 形态**) | `uninstall.cjs:39` `!== 1` → `< 1` | **假绿** | uninstall 7/7 rc=0 —— json-hook 形态有测,fence 形态没测 |
| 恢复矩阵表外改续跑(PREPARED) | `restore.cjs:277` | 真红 | restore 9/10,FAIL「matrix exhaustive」 |
| 恢复矩阵表外改续跑(OLD_MOVED) | `restore.cjs:283` | 真红 | 同上 |
| 恢复矩阵表外改续跑(NEW_MOVED) | `restore.cjs:288` | 真红 | 同上 |
| 恢复矩阵表外改续跑(COMMITTED) | `restore.cjs:293` | 真红 | 同上 |
| 恢复矩阵表外改续跑(**未知 phase**) | `restore.cjs:295` → `PREPARED_CONTINUE` | **假绿** | restore 10/10 rc=0 —— 穷举脚本只枚举四个已知 phase |
| 树 hash 改为只比路径 | `restore.cjs:32` 去掉每文件 sha256 | 真红 | restore 9/10,FAIL #1 |
| 继承真实 `AXMEM_STATE_DIR` | —— | **不可验证** | 仓库内无隔离夹具(H4) |
| 继承真实 `XDG_CONFIG_HOME` | —— | **不可验证** | 同上 |
| cwd 指向真实仓库 | —— | **不可验证** | 同上 |

**合计:真红 12 条,假绿 7 条,不可验证 3 条。**
建造者列为「只做代码走查未重跑」的那批里,**matcher 改错**与**准入检查后置**两条实为假绿。

---

## 隔离与险情复核

- **真实 Hermes 配置未被改动**。一个建造者报告没点破的事实:`~/.hermes` 在本机是
  **指向 `AppData/Local/hermes` 的符号链接**(`ls -d` 显示 `.hermes@`),
  所谓「两个真实 config.yaml」其实是**同一个文件**:两条路径 sha256 同为 `b677c1c0973f46d3…`,
  mtime 同为 `2026-08-17 09:46:19`(早于本次全部 7 个提交的 09-16 18:28+)。未被写过。
  `~/.codex/AGENTS.md` mtime `2026-09-13`,亦未被动。
  `~/.hermes/shell-hooks-allowlist.json` 不存在(与 doctor 自测 #2「allowlist 缺席 ⇒ configured」一致)。
  这条链接关系还意味着:D9 那次拒绝所避免的破坏面比报告写的更大 —— 写 `~/.hermes/config.yaml`
  就是写 `%LOCALAPPDATA%\hermes\config.yaml` 本体,没有「另一份副本」可作退路。
- **`HERMES_HOME` 优先级修正(`4423a32`)属实且必要**:`wire.cjs:35-37`、`doctor.cjs` 同款,
  与 Hermes 自身 `_hermes_home_from_env()` 一致。
- **隔离清单(§3)在代码里落实程度 = 部分,且不可复核**:`env -i` / 固定 PATH / temp git repo /
  `GIT_CONFIG_NOSYSTEM` / `XDG_*` / 先验路径断言 / 全树 hash 前后比对 —— **仓库里没有任何脚本包含这些**
  (`git ls-files` 无 `tests/`;在交付文件里 grep `env -i` / `GIT_CONFIG_NOSYSTEM` / `XDG_STATE_HOME` 零命中)。
  各模块 `--self-test` 用的是 `mkdtemp` + `{...process.env, AXMEM_*}` **继承式**环境
  (如 `bridge.cjs:248`),这恰恰是三条隔离变异臂要防的形态。P1 没有出事,但护栏不在仓库里。

---

## spec 符合性抽查

| 条目 | 判定 | 依据 |
|---|---|---|
| §2.1 准入锁内完成全部结构操作 | **符合** | `produce/drain/recoverOnStartup/quarantineMalformed` 四个入口都先 `claimLock` 后操作,`finally` 释放 |
| §2.1 `.incoming` 落盘在锁内 | **符合** | `queue.cjs:185` 的 `writeFileSync` 在 `claim.acquired` 分支内 |
| §2.1 quarantine 计入统计 | **符合**(`quarantineCount` 是死码,见 L2) | `queue.cjs:108-112` 把 quarantine 字节并入 `globalBytes` |
| §2.1 消费:写完 stdout 后删 draining | **偏离** | `queue.cjs:316` 删除 → `bridge.cjs:184` 才写 stdout(M1) |
| §2.1 fencing 在每次临界操作前 | **偏离(队列侧完全缺失)** | H1 |
| §2.1 台账事件全集可达 | **偏离** | `lock-fenced-abort`、`lock-sweep-failed` 队列侧不可达(H1、M2) |
| §2.1 YAML「优先用 loader」 | **偏离(前提可反驳)** | M3;拒绝清单本身覆盖完整,20/20,`fullDocumentViolations` 删掉即红 |
| §2.3 ① tar 成员校验 | **符合** | 19 条自测覆盖绝对路径/盘符/UNC/`..`(含 `\`)/symlink/hardlink/设备/FIFO/PAX/GNU longname/ADS/尾随点/保留名(含带扩展名)/大小写折叠查重/成员数/64MB;总展开 512MB、路径 240、sparse 有码无测(L4) |
| §2.3 ⑤ journal 领先文件系统一步 | **符合** | `restore.cjs:213-236`:每步先 `writeJournalAtomic` 再 rename,且每步前 `fenceOrAbort()` |
| §2.3 ⑥ 恢复矩阵每行一个分支 | **符合** | `classifyRecoveryRow` 十个 row id 一一对应 spec 十行;有独立谓词穷举比对自测 |
| §2.3 ⑥ 表外组合停止 rc 3 | **基本符合,一处漏网** | 四个已知 phase 的表外分支都在;**未知 phase 字符串**那条改成续跑不翻红 |
| §2.3 ⑥ 每条 axmem 命令都跑启动恢复 | **符合** | `bin/axmem:19`,失败 `exit 3` |
| §1 D5 三档,`active` 硬编码不可达 | **判定正确** | 我查了 Hermes 源:`hermes hooks list/test/revoke/doctor` 确实存在,但 `hermes_cli/hooks.py:_cmd_list` 走的是 `load_config()` + `iter_configured_hooks(cfg)` —— **读的是静态 config.yaml + allowlist,不是运行时已加载列表**。D5 要求的「可查询的已加载 hook 列表」在 Hermes 里确实不存在,`active` 不可达是对的。建议把 doctor 那行措辞从「no live-hook-list query interface exists」改成「`hermes hooks list` 只反映静态配置,无已加载列表接口」,把已核实到的东西写明 |

---

## 判决

**GO-WITH-CHANGES** —— 没有发现会损坏用户数据或写到真实家目录的缺陷(真实 `config.yaml` 确认未被动过;
restore / tar / 恢复矩阵这三处高危面经得起逐条复核);但**验收证据本身有洞**:
§9.6 的断言空过、§9.7 的断言写成永真、七条变异臂实为假绿、spec §3 的隔离夹具一个字都没进仓库,
外加 D11 的 fencing 在 2.1 整条缺席。这些不阻断合并,
但**不能按原样声称「§9 七条全部真实复现」**。

### 最小改动清单(交建造者,按优先级)

1. **H1** `queue.cjs` 四个入口在每次 rename/write 前加 `lock.fenceCheck`,失败 ⇒ 中止 + `ledger('lock-fenced-abort')`。
2. **H2** 把 §9.6 屏障子进程的 `timeoutMs` 放大到能让 ≥32 条真发布(或分批放行),让断言真正压到 2MB;
   若不改,自测输出与 README 必须写明「本轮峰值仅达上限 6%,硬上限未被实证」。
3. **H3/L5** 补三条测试关掉假绿:① bridge 自测预置一条能命中的 trigger,断言 `kind:'recall'` 记录出现
   且传给 `trigger-recall.cjs` 的是 `tool_name:'Write'` + `file_path`;② `wire.cjs` 自测断言渲染出的
   matcher 字面量等于 `^(write_file|patch)$`;③ `queue.cjs` 自测断言「被 `queue-admission-dropped`
   拒掉的记录,`.incoming/` 里零残留」。
4. **9.7** 删掉 `lib/lock.cjs:516` 断言里的 `|| true`,在 Windows 上改用真能挡住删除的手段
   (如对目录持有打开句柄)制造失败分支;做不到就把这条标为「本平台无法制造反例」,别用永真断言充数。
5. **M2** 三处把 `claim.events` / `rel.events` 并入返回事件,让 `lock-sweep-failed` 能进台账。
6. **M1** `drain()` 改成返回 `commit()`,由 bridge 写完 stdout 再删 draining。
7. **M3** wire 写入前用 `HERMES_HOME=<temp>` 对原文件与候选各跑一次 `hermes hooks list`;
   `hermes` 不在 PATH ⇒ 退回现子集。
8. **H4** 把跑过的隔离/E2E 脚本落进 `tests/` 并进 `bin/axmem selftest` 名册;
   至少把三条隔离变异臂的前置断言做成可执行的。
9. **变异臂两处漏网**:`restore.cjs:295` 未知 phase、`uninstall.cjs:39` fence 形态 identity —— 各补一条断言。
10. **M5** 给 `lib/fence.cjs` 加 `--self-test`(至少覆盖 `recordLifecycleTarget` 的 pre/post sha256 记账)。
11. (可选,非阻断)**M4** `lib/lock.cjs` 把本进程 FILETIME 在模块加载时算一次并缓存;`claimLock` 退避加抖动。

---

## LESSON CANDIDATES(建议进 PMM lessons)

1. **`[[process:green-assertion-that-cannot-fail]]`** —— 「测试绿」不等于「断言有效」,验收必须看断言的
   *可失败性*。本轮两例:§9.6 断言 `peak <= 2162688` 而实测 peak 只有 130974(6%);
   §9.7 断言括号里直接写了 `|| true`。两条都是 spec 点名要求实证的条目,两条都绿,两条都什么也没证明。
   验收动作:对每条「上限/边界」断言问一句「这次运行里它离触发有多远?」—— 距离 >10× 就当作未验证。
2. **`[[process:mutation-arm-must-be-rerun-not-walked]]`** —— 变异臂「代码走查」与「真跑」的命中率差距实测约 50%。
   建造者走查认定会红的那批里,matcher 改错、准入检查后置等多条实为假绿。
   规则:变异臂不重跑 = 没做;走查结论不得写进验收报告。
3. **`[[process:string-replace-dollar-in-mutation-harness]]`** —— 用 `String.replace(a, b)` 做机械变异时,
   替换串里的 `$'` / `$&` / 反引号 `$\`` 会被当成特殊标记,静默污染结果(本轮把一条假绿误报成真红)。
   一律用 `replace(a, () => b)` 或整行替换。
4. **`[[axmem:fencing-implemented-in-lib-unused-in-product]]`** —— 「控制已实现」≠「控制已生效」。
   `fenceCheck` 在 `lib/lock.cjs` 有、在 `restore.cjs` 用了、在 `queue.cjs` 一处没用,
   而单元自测只测 lib 层那一处,所以全绿。验收动作:对规格点名的兜底控制,
   用 `grep -rn <控制名> <产品目录>` 数调用点,再对着规格里「每次临界操作」的清单逐条点名,不看测试结果。
5. **`[[axmem:spec-tests-not-in-repo-are-unverifiable-forever]]`** —— spec §3 写了一整套隔离/E2E 夹具,
   交付里一个文件都没有,全部证据寄生在 `--self-test`。后果是三条「防写到真实家目录」的变异臂
   永久不可验证 —— 而它们防的正是建造者当天自己踩到的那次险情。
   规则:凡 spec 里作为验收条件的测试,产物必须进仓库并进 canary 名册,否则该条按未完成计。
6. **`[[axmem:symlinked-home-means-one-file-not-two]]`** —— 本机 `~/.hermes` 是指向
   `%LOCALAPPDATA%\hermes` 的符号链接。任何「我检查了两个位置的 config.yaml 都没被改」的说法
   在这里其实只检查了一个文件;反过来,任何误写也没有第二份副本兜底。
   涉及用户真实配置的隔离核查,先 `ls -ld` 看路径本身是不是链接。
7. **`[[axmem:d11-lock-throughput-is-ntfs-bound-not-powershell-bound]]`** —— 目录 claim 锁在 NTFS 上
   40 并发时单次尝试耗时 1.7–2.7 秒,把 PowerShell 存活检测整个短路掉也不改善;
   瓶颈是同目录 mkdir/写/删的目录项争用,被「持锁者无条件清扫 sibling claim」放大。
   结论:诊断「慢」时别停在最显眼的子进程调用上,做一次短路对照实验再下结论。
