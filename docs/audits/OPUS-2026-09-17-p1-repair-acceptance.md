# OPUS 验收 — AxMem P1 第四批(codex 终波 8 项)

审查者:Opus(与前三批同一验收者,只读;唯一写入 = 本文件)。日期 2026-09-17。
仓库 `C:/Users/<user>/Desktop/axmem`。核查时 HEAD = `b3bb3c7`,收尾时 HEAD = `cf3d8c3`(两者 `git diff --stat` 仅 `CHANGELOG.md` 一行,代码字节相同);
批次范围 `1364c7d..0aab97d`(8 提交),对照 `docs/audits/review-20260917T142024Z-codex-final-wave.md` 的 H1/H2/M3/M4/M5/M6/L7/L8。
前三批的审计正文在 `docs/audits/OPUS-2026-09-16-p1-repair-acceptance.md`(本文件是第四批的独立续篇)。
隔离:`HOME=USERPROFILE=HERMES_HOME=TMPDIR` 全部指向 scratchpad 临时目录;变异/falsify 在丢弃副本 `…\Temp\axmut4` 上做,跑完已删;真实仓库 `git status --porcelain` 跑前跑后均空。

---

# Batch 4 (codex final wave) incremental

## 总判

**GO(8/8 全部收口;0 新 HIGH / 0 新 MEDIUM / 2 新 LOW,均不阻断)。**
三条手工 falsify(H1 / M4 / M5)逐条真红;H2 的三态语义与 `AXMEM_SELFTEST_STRICT_ISOLATION=1` 由我本人整跑复现(32 passed / 2 skipped / 0 failed,`EXIT=1`,两处 SKIP 各自被标 fatal)。
附带确认:前一批我记为「残留风险」的 `core/precommit-gate.sh` 已由 `c94d241` 根因修好(TMPDIR 导出下 **8/8**),report-only 特判已从 `bin/axmem` 移除,该组件回到正常计分路径 —— 那条残留risk 关闭。

## 逐项

| # | codex finding | ① 修前是否真实 | ② 修法是否收口 / 有无新问题 | ③ 能否真红 | 判定 |
|---|---|---|---|---|---|
| **H1** | `recoverOnStartup()` 的全局上限把 `.incoming` 文件重复计数,接近 2MB 时永久 `unlinkSync` 合法记录 | **真实**。`git show 1364c7d~1:adapters/hermes/queue.cjs` 处为 `stats.globalBytes + bytes > GLOBAL_MAX_BYTES`;而 `scanStats()` 的 `addDir(.incoming, null)` 虽不计 perKey,**确实已把 `.incoming/*.json` 累进 `globalBytes`** —— 同一文件被算两次 | **收口**。`queue.cjs:451` 改为 `stats.globalBytes > GLOBAL_MAX_BYTES`(恢复是 counted-location 之间的**移动**,不新增字节);perKey 侧保留 `cur.bytes + bytes` 是**正确**的,因为 `.incoming` 从不计入 perKey(注释已写明这条不对称)。新增自测 #13 用 31 条 live + 1 条 .incoming 恰好等于 `GLOBAL_MAX_BYTES`,并断言**记录集合与总字节前后完全相同**(递归计数,不按位置),不是只看那一条活没活 | **真红** | **GO** |
| **H2** | 隔离检查全 SKIPPED 仍被汇总为 `32/32 passed` | **真实**。codex 用 `git archive 82ed6a3` 精确复现;两个脚本的内部门是 `ok + skipped == total` ⇒ rc 0,顶层只看 rc ⇒ 计为 ok | **收口**。`bin/axmem:322-347` 引入 PASS/SKIP/FAIL 三态(从组件末行解析 `N skipped`),末行改为 `N passed / N skipped / N failed (of N components)`,**永不再打印 `N/N passed`**;`AXMEM_SELFTEST_STRICT_ISOLATION=1` 下任一 SKIP ⇒ `rc=1` 且单独打印 `STRICT_ISOLATION: this skip is fatal`。新问题见 **N1**(SKIP 识别是自由文本约定,只有那两个脚本加入了约定) | 我本人整跑两态(见下「strict 验证」) | **GO** |
| **M3** | `inherit-real-env-arms` 自测往**真实** `~/.axmem/state/backups` 落备份 | **真实**。`git show 704867b~1:tests/inherit-real-env-arms.sh` 的 arm 3 用 `env -u AXMEM_STATE_DIR -u AXMEM_HOME …` 跑真 `fence.cjs apply`,`ctx.resolveStateDir()` 必然落到真实 `$HOME/.axmem/state/backups`;本机该目录确实被这条测试创建出来(mtime 09-17 11:03),**现已清空(0 个文件)** | **收口**。拆成 3a(仍是真 fence 写,但 `AXMEM_STATE_DIR` 指向本测试自己的 fixture)+ 3b(**只读字符串断言**:两个变量真正 unset 时解析必须是 `$HOME/.axmem/state`,绝不是 `$(pwd)/state`)。既保住 e1f38eb 的原始主张,又不再碰任何真实家目录 | 组件 6/6(整跑日志) | **GO** |
| **M4** | restore 每个 phase 只 fence 一次,journal 写完到 rename 之间可失去所有权仍改树 | **真实**。codex 给出 `{"oldWasMovedDespiteLostFence":true}`;`git show e750ef4~1` 处三个 phase 各只有入口一次 `fenceOrAbort()` | **收口**。每个 phase 变成 `fence → writeJournalAtomic → fence → rename`;新增 test-only 钩子 `onAfterJournalWrite`(生产调用点从不传)把 owner 替换注入**恰好那个窗口**。注释还写明了「journal 已宣称 OLD_MOVED 但此处中止」为何安全(current_abs 未动,后续恢复会在非空目标上干净失败) | **真红** | **GO** |
| **M5** | manifest 只校验「已列出的文件」,未声明的 tar 成员照样被解出并恢复 | **真实**。`git show 62e08df~1` 的 `extractAndVerify()` 只遍历 `manifest.files`,从不比对 tar 成员集合 | **收口**。新增 `validateManifestSchema()`(format_version / files[] / member_count / total_bytes / 每条 path+sha256 正则+size / 路径查重 / **member_count 与 total_bytes 重算一致**),并把 `validateArchive()` 解析出的成员表传进来做**双向集合比对**(missing + undeclared)。新问题见 **N2**(`--allow-unlisted` 逃生口) | **真红** | **GO** |
| **M6** | POSIX 下 `stdout.write() === true` 被当成已 flush | **真实(平台性)**。布尔返回只是背压信号;`git show 969c0f5~1` 的 `const flushed = …; if (flushed) commit();` 正是这个误读。Windows 管道同步写,所以本机不会丢,POSIX 下窗口真实存在 | **收口**。改为 `process.stdout.write(data, (err) => { if (!err) { commit(); } })`,**只在回调无错时** commit;写错误则保留 draining(下一轮 `draining-recovered` 兜底,符合 D10)。自测 #12 的顺序断言从 2 行升为 3 行(`stdout-write-returned` → `stdout-write-callback-ok` → `commit-called`),并把夹具从 1 条记录改成 10 条累积(断言 stdout > 2500 字节,确认真的多条累积而非偶然单条) | 组件 16/16(含 #12/#13/#14) | **GO** |
| **L7** | 16KB context 上限未给截断标记预留空间(实测 16408 > 16384) | **真实**。旧 `buildContextText()` 先按 `CONTEXT_MAX_BYTES` 收行,再无条件 `parts.push(marker)` | **收口**。先算 `totalIfUnbounded` 判断是否会截断,会截断才预留 `markerReserve`(按最坏情况 `dropped: records.length` 的字节数 + 1),收行时用 `budget = CAP - markerReserve`。新增 #10b 用 2000 条极小记录(旧实现的盲区正是「固定 2KB 记录恰好留够余量」)断言**含 marker 在内**仍 ≤ CAP | 组件 19/19 | **GO** |
| **L8** | `doctor` 的 `bash -c "$2"` 单引号拼接,路径含单引号即 FAIL | **真实**。codex 在含 `'quote'` 的临时根下复现 `FAIL memory skeleton` / `FAIL state dir writable` / `RC_DOCTOR=1` | **收口**。`chk()` 改为 `bash -c "$_cmd" _ "$@"`,路径全部走位置参数(`"$1"`),再不拼进命令字符串;新增 `tests/doctor-quoted-path.sh`(在 `"$T/it's a quote"` 下跑真 `axmem doctor`),已进 selftest 名册 | 组件 2/2 | **GO** |

## ③ 手工 falsify 原文(在丢弃副本上改回原逻辑,跑该组件 self-test)

基线(未变异):`queue self-test 19/19` · `restore self-test 27/27`

```
=== FALSIFY 1 (H1): 把 globalBytes 检查改回 "+ bytes" ===
[H1 globalBytes + bytes] rc=1 ::   FAIL 13 (codex HIGH #1) 31 live + 1 .incoming, all exactly at
  GLOBAL_MAX_BYTES combined -> recovery republishes the orphan (not dropped), byte total and record
  count identical before/after | queue self-test 18/19 |

=== FALSIFY 2 (M4): 删掉 PREPARED->OLD_MOVED rename 之前的第二次 fence ===
[M4 second fence removed] rc=1 ::   FAIL 6b (codex(gf) MEDIUM #4) owner replaced in the window between
  journal write and rename -> aborts BEFORE the rename, current tree untouched (not
  "oldWasMovedDespiteLostFence") | restore self-test 26/27 |

=== FALSIFY 3 (M5): 让未声明的 tar 成员重新被接受 ===
[M5 undeclared check disabled] rc=1 ::   FAIL 15 (codex(gf) MEDIUM #5) tar member not listed in
  manifest.json refused by default (named in the reason), accepted only with --allow-unlisted
  | restore self-test 26/27 |

(三次变异均为「改一处 → 跑 → 还原」,还原后副本 git status --porcelain 为空)
```

## H2 三态语义:我本人整跑验证(丢弃副本,HEAD 代码,34 组件全遍历)

`AXMEM_SELFTEST_STRICT_ISOLATION=1 bash bin/axmem selftest`:

```
  ok   core/precommit-gate.sh — precommit-gate self-test 8/8        <-- c94d241 根因已修(TMPDIR 已导出)
  ok   adapters/hermes/bridge.cjs — bridge self-test 16/16
  ok   adapters/hermes/queue.cjs — queue self-test 19/19
  ok   lifecycle/restore.cjs — restore self-test 27/27
  ok   lifecycle/tar-safety.cjs — tar-safety self-test 24/24
  ok   tests/doctor-quoted-path.sh — doctor-quoted-path self-test 2/2
  ok   tests/inherit-real-env-arms.sh — inherit-real-env-arms self-test 6/6
  SKIP tests/full-env-isolation.sh — full-env-isolation self-test 4/6 ok, 2 skipped (baseline absent visible to this script)
         STRICT_ISOLATION: this skip is fatal in strict-isolation mode
  SKIP tests/isolation-real-configs.sh — isolation-real-configs self-test 1/3 ok, 2 skipped (baseline absent on this machine)
         STRICT_ISOLATION: this skip is fatal in strict-isolation mode
axmem selftest: FAILED — 32 passed / 2 skipped / 0 failed (of 34 components)
EXIT=1
```

即:**SKIP 不再混入 passed 计数**(32 + 2 + 0 = 34,三个数分列),**strict 模式下 SKIP ⇒ 非零**,且 SKIP 与 FAIL 用不同标签、不会混淆。与建造者报告的 32/2/0 完全一致。

## 新观察(本批引入,LOW,不阻断)

### N1 — 三态的 SKIP 识别是「自由文本约定」,只有那两个脚本加入了约定
`bin/axmem:322-323` 用 `grep -oE '[0-9]+ skipped'` 解析组件的**末行**。目前只有 `isolation-real-configs.sh` 与
`full-env-isolation.sh` 会打印该措辞。其他组件的**平台条件跳过**依旧在组件内部计为 `ok`、末行不含 "skipped":
`bridge.cjs` #6b(junction 建不了则 SKIPPED 但 `check(..., true)`)、#9(非 win32 跳过)、#11(非 win32 跳过);
`lock.cjs` §9.7 的 `--   … inconclusive` 提示行不是末行;`wire.cjs` #20b-20d/#21(非 win32 跳过)。
于是 `bridge self-test 16/16` 在 Linux 上可能有 3 条其实没跑,仍被顶层判 PASS —— 正是 codex H2 攻击的同一类,只是没覆盖到这些组件。
**改法**:把约定机器化(例如约定 `exit 2` = "全部/部分跳过",或强制每个组件末行输出 `… N skipped`),并让所有含条件跳过的组件都吐出该字段。

### N2 — `restore --allow-unlisted` 是一个未文档化的逃生口,且被它放行的成员**完全不做 sha256 校验**
`lifecycle/restore.cjs:147,178-180` 新增的 `allowUnlisted` 在打开时只跳过「未声明成员」的拒绝;
后面的校验循环只遍历 `manifest.files`,所以那个未声明成员**被 tar 解出来、被一起 rename 进 current,却从未被任何哈希验证过**。
默认关闭、拒绝信息里点了名,这点是好的;但 `bin/axmem` 的 `usage()` 里 `restore`/`uninstall`/`upgrade`/`migrate` **一个都没列**(既有缺口,非本批引入),所以这个开关在 CLI 帮助里不可见。
**改法**:① `usage()` 补上四条命令与 `--allow-unlisted`;② 用它恢复时打一条醒目 warning,逐条列出「已恢复但未经校验」的成员名。

---

## 取证结论 —— `%LOCALAPPDATA%\Temp\claude` 于 11:58 被清空

### 结论:**不可能由 AxMem 的 selftest 组件造成**(attribution 另说,见末尾)

先确认提问的前提成立:

```
$ mount | grep -i tmp
C:/Users/<user>/AppData/Local/Temp on /tmp type ntfs (binary,noacl,posix=0,usertemp)
$ cygpath -m /tmp
C:/Users/<user>/AppData/Local/Temp
```
⇒ `/tmp/claude` ≡ `%LOCALAPPDATA%\Temp\claude` ≡ 被清空的那棵树。前提正确。

### 排除依据(代码侧,穷举而非抽样)

1. **仓库里没有任何一处裸 `claude` 路径分量**。`git ls-files | xargs grep` 全仓搜 `/claude/`、`'claude'`、`Temp…claude`:**零命中**。出现的只有 `.claude`(带点,且只作为 `settings_json` 的默认**读写目标文件**,从不删目录)与仓库自己的源码目录 `adapters/claude-code/`。
2. **全仓每一处递归删除(约 90 个调用点,已逐条列举)只属于三类**:
   - (a) 本进程自己 `mktemp -d` / `fs.mkdtempSync()` 刚创建的唯一目录 —— 按定义不可能是一个**既存**目录;
   - (b) 末段是**固定字面量**的路径:`state`、`backups`、`.admission.lock`、`restore.lock`、`<key>.draining-<uuid>`、`restore/<txn>`、`restore-staging/<uuid>`、`restore-prev/<uuid>`、`quarantine/<file>`;
   - (c) **前缀匹配的兄弟目录**:`sweepSiblings()` 只删 `<base>.claim-*` / `<base>.released-*` —— `claude` 不匹配任何一条。
3. **唯一一处「向上走」的删除**是 `lifecycle/restore.cjs:378/494/502/521` 的 `fs.rmSync(path.dirname(jPath))`,而 `jPath = path.join(stateDir,'restore',txn,'journal.json')` —— 它产出的路径**永远含字面量分量 `restore`**,要变成 `…/Temp/claude` 就得是 `…/Temp/restore/claude`,构造上不可达。
4. **不存在其它破坏性原语**:全仓无 `git clean`、`find … -delete`、`-exec rm`、`xargs rm`、`rmtree`、`rd /s`、`Remove-Item -Recurse`、`git worktree remove`。
5. `bridge.cjs` 的 `hasReparsePointAncestor()` 确实逐级向上走祖先目录 —— 但它**只 `lstat`**,没有任何写/删。
6. 点名的那几个 `T` 变量来源已逐一核对:`tests/{doctor-quoted-path,fresh-home-adapters,full-env-isolation,inherit-real-env-arms,isolation-real-configs}.sh` 全是 `T="$(mktemp -d)"`(部分再过一次 `cygpath -m`);`merge-hooks.cjs:244`、`uninstall.cjs:200`、`tar-safety.cjs:283` 全是 `fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-…-'))`。**没有一个是「读来的路径」**。
7. 关于「条件触发」的那条唯一可疑通道也已排除:`bin/axmem` 每条命令都会跑 `restore.cjs --recover-on-startup "$AXMEM_STATE_DIR"`,其中 `PREPARED_ROLLBACK` 分支会 `rmSync(j.staging_abs)` —— 这是全仓**唯一**一个「删除一个从磁盘读来的路径」的分支。但:(i) 本代码写出的 journal,`staging_abs` 恒为 `<stateDir>/restore-staging/<uuid>/<memdir-basename>`、`prev_abs` 恒为 `<stateDir>/restore-prev/<uuid>`,永远不可能是 `Temp\claude`;(ii) 本机真实 `~/.axmem/state/` 下**根本没有 `restore/` 目录**(实测 ABSENT),即这条分支在那次运行里无事可做;(iii) `current_abs`(memory dir)在任何分支下都只被 rename,从不被删。
8. 被审代码与出事那次运行的代码**逐字节相同**:`git diff --stat 0aab97d..b3bb3c7` 只有 `CHANGELOG.md`。

### 实验侧的反证(四次同构运行,只出事一次)

| # | 运行 | 结果 |
|---|---|---|
| 1 | 建造者 11:48–11:58 完整 selftest | Temp\claude 被清空 |
| 2 | 建造者 12:00:37–12:13:09 完整 strict selftest(752s,32/2/0,rc 1) | Temp\claude **完好**(草稿区 39 个文件全在) |
| 3 | **我本人**刚跑的完整 strict selftest(34 组件,HEAD 代码,丢弃副本) | Temp\claude **完好** |
| 4 | 我在前三批里跑过的多次完整 selftest(09-17 凌晨) | 从未出现该现象 |

其中第 3 次是**最强的直接反证**:我的 harness 把 `TMPDIR/TEMP/TMP` 指向
`…\Temp\claude\<worktree-key>\<session-uuid>\scratchpad\opus4\tmp` —— 也就是说
**`Temp\claude` 在那次运行里就是 TMPDIR 的第 5 级祖先**。若真存在「删掉临时目录某级祖先」的路径,那一跑必然把我自己的草稿区一并抹掉。
实测:跑完后 `Temp\claude` 下 364 项俱在、我的 scratchpad 62 个文件俱在、`Temp\claude\<worktree-key>` 的 mtime 仍停在 11:58(未被我的运行改动)。

### 现场特征指向宿主侧(只作旁证,不作断言)

- `Temp\claude` 下**没有任何一项的 mtime 早于 11:58:53** —— 整棵树被移除后重建,而不是被选择性删除。
- 被一并抹掉的包括**一个当时处于空闲状态的旁侧 Claude Code 会话(我这个会话)的 `scratchpad/` 与 `tasks/`** —— 这条路径从来没有出现在任何 AxMem 进程的任何变量里。
- `Temp\claude` 是 **Claude Code 自己的临时根**:它同时装着 `bash-edit-diff/<hash>/` 裸 git 目录(Claude Code 内部实现)、`cache-break-state-<session-uuid>.json`、以及 `<worktree-key>/<session-uuid>/{scratchpad,tasks}` —— 这些都在 11:58–11:59 由 Claude Code 重建。
- AxMem 的全部写入面是 `$AXMEM_*` / `$HOME/.axmem` / 仓库自身,三者都不含 `Temp\claude`。

### 我不声称的部分(按指示不硬凑)

我能证明的是**否定命题**:AxMem selftest 的任一组件都不可能推导出 `%LOCALAPPDATA%\Temp\claude`(或 `/tmp/claude`)并递归删除它 —— 上面 8 条构造性排除 + 4 次运行(含一次 TMPDIR 就在该树内)的实验反证。
我**不能**证明是谁删的:本机没有文件系统审计日志,`Temp\claude` 下也没有留下任何早于 11:58:53 的痕迹可供追溯。现场特征与「宿主自身清理临时根」相符,但那属于 Claude Code 侧,超出我能取证的范围。
如果要把这条彻底钉死,唯一可行的取法是事前布控:在该目录放一个 canary 文件 + 打开 Windows 的对象访问审计(`auditpol` + 该目录的 SACL),再复跑一次完整 selftest。

**三选一答案:不可能(AxMem 所致)。**

---

## 亲跑清单(原文)

```
HEAD(核查时) = b3bb3c7 ; 收尾 HEAD = cf3d8c3(仅 CHANGELOG 差一行)
真实仓库 git status --porcelain:跑前空、跑后空(本文件为唯一新增)

丢弃副本 …\Temp\axmut4 上:
  node adapters/hermes/queue.cjs --self-test          -> 19/19  (基线)
  node lifecycle/restore.cjs --self-test              -> 27/27  (基线)
  falsify H1 (globalBytes + bytes)                    -> 18/19,FAIL #13
  falsify M4 (删第二次 fence)                          -> 26/27,FAIL #6b
  falsify M5 (放行未声明成员)                          -> 26/27,FAIL #15
  AXMEM_SELFTEST_STRICT_ISOLATION=1 bash bin/axmem selftest
                                                      -> 32 passed / 2 skipped / 0 failed (of 34), EXIT=1
                                                         两处 SKIP 各带 "STRICT_ISOLATION: this skip is fatal"
  组件抽查(整跑日志内):bridge 16/16 · wire 26/26 · tar-safety 24/24 · lock 15/15 ·
                        doctor-quoted-path 2/2 · inherit-real-env-arms 6/6 · precommit-gate 8/8

取证用的只读取证命令:
  mount | grep tmp                     -> /tmp = C:/Users/<user>/AppData/Local/Temp
  find %LOCALAPPDATA%\Temp\claude -newermt … ! -newermt "11:58"  -> 空(无任何早于 11:58 的幸存项)
  ls ~/.axmem/state/                   -> 无 restore/ 目录(条件触发通道无事可做)
  ls ~/.axmem/state/backups/           -> 0 个文件(M3 留下的空目录,已清理)
  git ls-files | xargs grep <删除原语>  -> 已全列,见「排除依据」
丢弃副本已删;真实仓库工作区仅本文件新增。
```

## LESSON CANDIDATE

**`[[process:prove-the-negative-by-running-inside-the-suspect-path]]`** —— 排查「某次运行是否删了沙箱外的目录」时,
比通读代码更有力的一步是:**把被怀疑的目录做成本次运行临时目录的祖先,再跑一遍**。
本轮把 `TMPDIR` 指到 `Temp\claude\…\opus4\tmp`,于是「删掉临时目录某级祖先」这一整类假设只需一次运行就能被直接证伪 ——
代码穷举给的是「找不到这样的路径」,这一跑给的是「即使存在也没触发」,两者性质不同、互补。
