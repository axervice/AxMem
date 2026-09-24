结论：`NO-GO`。在指定的 `82ed6a3` 上确认 2 HIGH、4 MEDIUM、2 LOW。最严重的是队列恢复会删除合法记录，以及顶层 selftest 会把完全跳过的隔离检查汇总为全绿。

当前 `HEAD=7d8a7b1`，相对 `82ed6a3` 仅多三个文档提交；审查中工作树又被外部流程改动了 `bin/axmem`、`core/precommit-gate.sh`。关键结论均以 `82ed6a3` 的精确归档副本复核，我未改仓库文件。

## Findings

### 1. HIGH — `.incoming` 恢复把同一记录计两次，接近 2MB 时直接删掉合法记录

- 锚点：[queue.cjs:103](C:/Users/<user>/Desktop/axmem/adapters/hermes/queue.cjs:103)、[queue.cjs:395](C:/Users/<user>/Desktop/axmem/adapters/hermes/queue.cjs:395)、[queue.cjs:431](C:/Users/<user>/Desktop/axmem/adapters/hermes/queue.cjs:431)、[queue.cjs:440](C:/Users/<user>/Desktop/axmem/adapters/hermes/queue.cjs:440)。
- 缺陷：`scanStats()` 已把 `.incoming/*.json` 计入 `globalBytes`；恢复时又判断 `stats.globalBytes + bytes`，等于重复计数，随后 `unlinkSync()` 永久删除。
- 复现：先合法投递 32 条约 64KB 记录，再把最后一条移回 `.incoming` 模拟“写完 incoming、发布前崩溃”，然后执行 `recoverOnStartup()`：

```text
{"published":32,"before":2095584,"after":2030097,
 "orphanStillExists":false,"republished":false,
 "drop":{"event":"queue-admission-dropped","reason":"recovery-republish"}}
```

- 测试盲区：[queue.cjs:630](C:/Users/<user>/Desktop/axmem/adapters/hermes/queue.cjs:630) 只在空队列恢复一条 orphan；[queue.cjs:805](C:/Users/<user>/Desktop/axmem/adapters/hermes/queue.cjs:805) 只测并发生产，不测满载后的恢复。
- 改法：恢复是 counted-location 间的移动，全局检查应使用 `stats.globalBytes > GLOBAL_MAX_BYTES`，不能再加当前记录；补“31/32 条 live + 1 条 incoming、恢复前后字节与记录集合完全相同”的回归测试。

### 2. HIGH — 隔离检查全 SKIPPED 仍被汇总为 `32/32 passed`

- 锚点：目标提交 `bin/axmem:262-322`；[isolation-real-configs.sh:121](C:/Users/<user>/Desktop/axmem/tests/isolation-real-configs.sh:121)、[full-env-isolation.sh:221](C:/Users/<user>/Desktop/axmem/tests/full-env-isolation.sh:221)。
- 缺陷：两个脚本用 `ok + skipped == total` 返回 0；顶层仅看 rc，把 `0/3 ok, 3 skipped` 标成组件级 `ok`，最终声称全部通过。目标提交还在 `bin/axmem:267-280` 明确吞掉 `core/precommit-gate.sh` 的任意失败。
- 精确 `git archive 82ed6a3` 复现原文：

```text
ok tests/full-env-isolation.sh — full-env-isolation self-test 3/6 ok, 3 skipped
ok tests/isolation-real-configs.sh — isolation-real-configs self-test 0/3 ok, 3 skipped
ok repo-cleanliness: git status --porcelain unchanged after every one of the 32 component runs
axmem selftest: 32/32 component self-tests passed
RC_EXACT_SELFTEST=0
```

- 测试盲区：脚本自身把 SKIPPED 设计为 rc 0；[bin/axmem:281](C:/Users/<user>/Desktop/axmem/bin/axmem:281) 又把任何 rc 0 计为通过。仓库整洁检查只比较 Git 状态，无法证明真实用户目录隔离。
- 改法：使用 PASS/SKIP/FAIL 三态；顶层分别统计，不得输出 `N/N passed`。强制隔离验收模式下，任何关键基线 SKIP 应使验收非零。

### 3. MEDIUM — `inherit-real-env-arms` 自测会写默认真实 `~/.axmem/state/backups`

- 锚点：[inherit-real-env-arms.sh:118](C:/Users/<user>/Desktop/axmem/tests/inherit-real-env-arms.sh:118)、[inherit-real-env-arms.sh:124](C:/Users/<user>/Desktop/axmem/tests/inherit-real-env-arms.sh:124)、[fence.cjs:186](C:/Users/<user>/Desktop/axmem/lib/fence.cjs:186)。
- 缺陷：测试显式清除四个 `AXMEM_*` 变量后，对已存在目标运行真实 fence；fence 必然在默认 `$HOME/.axmem/state/backups` 写备份。
- 复现：本轮外层 HOME 已安全重定向，仍观察到：

```text
...\.axmem\state\backups\AGENTS.md.2026-09-17T....bak
inherit-real-env-arms self-test 5/5
```

正常用户直接运行时，该路径就是其真实 `~/.axmem`。
- 测试盲区：第 123–127 行只比较仓库 `git status`，外部 HOME 写入不会变红；顶层 repo-cleanliness 同样只看仓库。
- 改法：保留 cwd=仓库，但把 `AXMEM_STATE_DIR` 单独指向夹具目录；另行只读断言默认解析字符串，禁止实际调用落盘路径。

### 4. MEDIUM — restore 每个 phase 只 fence 一次，journal 写后到目录 rename 之间可失去所有权仍继续改树

- 锚点：[restore.cjs:230](C:/Users/<user>/Desktop/axmem/lifecycle/restore.cjs:230)、[restore.cjs:233](C:/Users/<user>/Desktop/axmem/lifecycle/restore.cjs:233)、[restore.cjs:236](C:/Users/<user>/Desktop/axmem/lifecycle/restore.cjs:236)、[restore.cjs:242](C:/Users/<user>/Desktop/axmem/lifecycle/restore.cjs:242)。
- 缺陷：代码 fence → 写 journal → rename；journal 写后 owner 若被替换，没有第二次 fence，旧持有者仍执行 rename。
- 复现：在 `journal.json` 原子 rename 完成后替换 owner：

```text
{"ownerReplacedImmediatelyAfterJournalRename":true,
 "result":{"ok":false,"reason":"lock-fenced-abort"},
 "currentExists":false,
 "oldWasMovedDespiteLostFence":true,
 "journalPhase":"OLD_MOVED"}
```

旧树已在丢失所有权后被移动；直到下一阶段才中止。
- 测试盲区：[restore.cjs:606](C:/Users/<user>/Desktop/axmem/lifecycle/restore.cjs:606) 在调用状态机前就替换 owner，只证明第一次 fence，没有覆盖 fence 与 rename 之间的暂停窗口。
- 改法：每个 journal publish、`current→prev`、`staging→current` 前分别即时 fence；增加“journal publish 后替换 owner，目录 rename 必须未发生”的测试。

### 5. MEDIUM — manifest 只校验“列出的文件”，未声明文件会被完整恢复

- 锚点：[restore.cjs:77](C:/Users/<user>/Desktop/axmem/lifecycle/restore.cjs:77)、[restore.cjs:102](C:/Users/<user>/Desktop/axmem/lifecycle/restore.cjs:102)、[tar-safety.cjs:160](C:/Users/<user>/Desktop/axmem/lifecycle/tar-safety.cjs:160)。
- 缺陷：只要求 tar 中存在 `manifest.json`，随后遍历 `manifest.files` 校验；没有证明“tar 普通文件集合 = manifest 文件集合”，也不核实 `member_count/total_bytes`。
- 复现：manifest 仅声明 `memory/decisions.md`，tar 额外放入 `memory/extra.md`：

```text
{"archiveAccepted":true,"manifestVerificationAccepted":true,"undeclaredExtracted":true}
{"ok":true,"restoredDeclared":"declared\n","undeclaredRestored":"UNDECLARED\n"}
```

- 测试盲区：backup 自测只检查自己生成的正常 manifest；restore 只测“无 manifest”；tar-safety 只测成员路径/类型/大小，不测清单集合完整性。
- 改法：校验 manifest schema、版本、唯一安全路径、大小字段，并对 tar 普通成员与 manifest 做严格一一集合比对；`member_count` 和 `total_bytes` 必须重新计算一致。

### 6. MEDIUM — POSIX 下 `stdout.write() === true` 被错误当作已 flush

- 锚点：[bridge.cjs:250](C:/Users/<user>/Desktop/axmem/adapters/hermes/bridge.cjs:250)、[queue.cjs:381](C:/Users/<user>/Desktop/axmem/adapters/hermes/queue.cjs:381)、[bridge.cjs:666](C:/Users/<user>/Desktop/axmem/adapters/hermes/bridge.cjs:666)。
- 缺陷：布尔返回值只表示缓冲区是否低于高水位；完成/flush 应由 write callback 表示。Windows 管道写是同步的，因此本机 Hermes 管道没有复现实际丢失；POSIX 管道是异步的，崩溃窗口仍存在。[Node 官方说明](https://nodejs.org/api/process.html)
- 对抗模型中，write 接受到用户态待写缓冲并返回 true 后，队列已被删除：

```text
{"writeReturnedTrueButOnlyPendingInUserland":true,
 "liveExists":false,"drainingExists":false}
```

- 测试盲区：现有测试只断言日志顺序为 `stdout-write-returned` → `commit-called`，没有等待 callback，也没有在 callback 前终止进程。
- 改法：始终用 `process.stdout.write(data, callback)`，仅在 callback 无错误时 commit；写错误或进程中断时保留 draining。

### 7. LOW — 16KB context 上限未预留截断标记空间

- 锚点：[queue.cjs:271](C:/Users/<user>/Desktop/axmem/adapters/hermes/queue.cjs:271)、[queue.cjs:278](C:/Users/<user>/Desktop/axmem/adapters/hermes/queue.cjs:278)、[queue.cjs:282](C:/Users/<user>/Desktop/axmem/adapters/hermes/queue.cjs:282)。
- 复现：

```text
{"contextBytes":16408,"cap":16384,"hasMarker":true}
```

- 测试盲区：[queue.cjs:671](C:/Users/<user>/Desktop/axmem/adapters/hermes/queue.cjs:671) 的固定 2KB 记录组合偶然留下足够余量。
- 改法：预留 marker 的 UTF-8 字节，或追加 marker 后循环弹出最后一条记录直到总长不超过上限。

### 8. LOW — `doctor` 的 `bash -c` 单引号拼接不支持路径含单引号

- 锚点：[bin/axmem:85](C:/Users/<user>/Desktop/axmem/bin/axmem:85)、[bin/axmem:89](C:/Users/<user>/Desktop/axmem/bin/axmem:89)、[bin/axmem:91](C:/Users/<user>/Desktop/axmem/bin/axmem:91)。
- 复现：同一临时根含空格和 `'quote'`；`init/config/migrate/restore/uninstall/upgrade` 均 rc 0，只有 doctor：

```text
FAIL memory skeleton
FAIL state dir writable
RC_DOCTOR=1
```

- 测试盲区：fresh-home 与组件测试的 `mktemp` 路径不含单引号。
- 改法：不要拼接 `bash -c "$2"` 命令字符串；让 `chk` 接收命令和 argv，或通过位置参数传路径。

## 检查过且干净的面

- `lib/lock.cjs`：两真实进程各成功 claim 100 次，共 200 次，临界区重叠 `0`；PID 当前=`alive`、模拟 EPERM=`alive`、其它错误=`unknown`；FILETIME 保持十进制字符串。
- restore 恢复矩阵：现有 `25/25`，10 个命名行均有真实文件系统终态断言；PREPARED/OLD_MOVED/NEW_MOVED 中断终态正确。除 finding 4 的 fence 间隙外未见矩阵错误。
- tar 拒绝面：绝对路径、盘符/UNC、正反斜杠 `..`、symlink、hardlink、设备/FIFO、PAX、GNU longname/sparse、非法 size、单文件/总展开/路径长度上限均拒绝；`24/24`。
- CLI 失败传播：坏 tar=`rc 3`、坏 lifecycle manifest 的 uninstall/upgrade=`rc 3`、init 目录创建失败=`rc 1`，未见静默 rc 0。
- 路径：空格和单引号下 init/config/migrate/restore/uninstall/upgrade 均正常；仅 doctor 命中 finding 8。
- `uninstall.cjs`、`upgrade.cjs`、`install-manifest.cjs`、Hermes wire、Claude hook merge 未发现新的可走通正确性缺陷。

## LESSON CANDIDATES

- 队列恢复在 counted-location 之间移动文件时不可重新累加该文件字节；建议归属 `LESSONS.md`。
- 隔离测试必须使用 PASS/SKIP/FAIL 三态，顶层不得把全 SKIP 汇总成全绿；建议归属 `LESSONS-CRITICAL.md`。
- fencing 必须紧贴每一个不可逆操作，不能只在一个 phase 开头检查一次；建议归属 `LESSONS.md`。
- `Writable.write()` 的布尔值是背压信号，不是通用 flush 证明；建议归属 `LESSONS.md`。