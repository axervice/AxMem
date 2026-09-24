# OPUS 复审验收 — AxMem P1 三审合并修复轮 + 收尾五项(`79e95e7..e03ae69`,21 提交 + 1 CHANGELOG)

审查者:Opus(验收层,只读;唯一写入 = 本文件)。日期 2026-09-17。
对象仓库 `C:/Users/<user>/Desktop/axmem`,HEAD `e03ae69f4a142f6918cc541d83bb561fefac24d8`,spec `docs/P1-ADAPTERS-SPEC.md` v8.1。
**所有结论均由本人在本机重跑/变异复现**;建造者报告与提交信息未被采信,只作对照。
变异臂在丢弃副本 `C:/Users/<user>/AppData/Local/Temp/axmut` 上进行,跑完已删;真实仓库工作区全程 `git status --porcelain` 为空(见附录 A)。
隔离:`HOME`/`USERPROFILE`/`HERMES_HOME` 全程指向 scratchpad 临时目录;未读未写 `~/.hermes/memories`、`SOUL.md`;真实 `~/.claude`、`~/.codex`、`%LOCALAPPDATA%\hermes\config.yaml` 未被写。

## 结论

**GO-WITH-CHANGES(2H / 6M / 7L)。**
上一轮 Opus 的 4H/5M、ECC typescript 的 2H/7M、ECC security 的 1H/1M **代码侧 finding 全部实质闭合**,
且 12 条变异臂逐条真红(附录 B)——包括上一轮记为「假绿」的全部 7 条。§9.6 由空过变为
**峰值 2095584B / 上限 2162688B = 96.9%,32 发布 / 8 丢弃 / 0 超时**(我本人复现),§9.7 的 `|| true` 已删且
失败分支在本机真复现。**但收尾五项引入了两个新的 HIGH**:一个让 `axmem uninstall` 在受支持的配置下静默失效,
一个让新加的「仓库清洁绊线」对它自己要防的那种残留失明。二者修完才可称 P1 verified。

---

## HIGH

### H1 `lib/fence.cjs:45-48 defaultStateDir()` 只读环境变量,不读 `config.json`,也不做 MSYS 归一化 ⇒ 生命周期 manifest 落错目录 ⇒ `axmem uninstall` 静默失效

```js
// lib/fence.cjs:45-48
function defaultStateDir() {
  const home = process.env.AXMEM_HOME || path.join(os.homedir(), '.axmem');
  return process.env.AXMEM_STATE_DIR || path.join(home, 'state');
}
```
该函数同时决定 ① 写前备份目录 `<state>/backups/`(spec §2.0 强制)和 ② `recordLifecycleTarget()` 写
`lifecycle.json` 的目录。而**其余每个消费者都走 env > config.json > 默认 的完整链**:
`lib/prelude.cjs:50` `cfgGet('state_dir', …)`、`lifecycle/uninstall.cjs:186`
`process.env.AXMEM_STATE_DIR || require('../lib/prelude.cjs').STATE_DIR`、`lifecycle/upgrade.cjs:88` 同款。
`lib/prelude.sh` **不 export** `AXMEM_STATE_DIR`,所以 `adapters/*/wire.sh` 调 `fence.cjs` 时它通常是空的。
commit `e1f38eb` 把兜底从 `process.cwd()` 改成 `os.homedir()+'/.axmem'`,注释与 CHANGELOG 称
「与 prelude.cjs 一致 / Mirrors lib/prelude.cjs's own AXMEM_HOME default exactly」——**不成立**。

复现(真实 `bin/axmem` + `adapters/codex/wire.sh`,`config.json` 里设 `state_dir`,不 export `AXMEM_STATE_DIR`):
```
wire rc= 0 codex adapter: AxMem section written to …\AGENTS.md
fence written into target? true
manifest at CONFIGURED state_dir? false
manifest at AXMEM_HOME/state?     true
uninstall rc= 3
uninstall stdout/stderr: uninstall: no manifest entry for adapter "codex" — nothing to uninstall
fence STILL in target after uninstall? true
```
第二形态(Git Bash 导出 MSYS 形式 `AXMEM_STATE_DIR=/c/...`,即 `lib/msys-path.cjs` 头注释称「the documented,
expected way to configure this tool」的那种):`prelude.cjs` 解析为 `C:/Users/.../st`,而 `fence.cjs` 把备份写到
`C:\c\Users\...\st\backups\AGENTS.md.*.bak` —— 正是本轮 ts M6 宣称已修的 bug class,在本轮改过的文件里复发。

**影响**:P1 交付物 `uninstall`(D7/§2.3「按 identity 恰好一次匹配才移除」)在受支持配置下永远找不到自己的安装记录;
spec §2.0 要求的写前备份也不在文档所说的位置。无数据丢失(uninstall 是安全拒绝),但契约静默失效。
**改法**:`defaultStateDir()`(`lib/fence.cjs:45-48`)走 `lib/prelude.cjs` 的同一条链(env > `cfgGet('state_dir')` > 默认,且经
`normalizeMsysPath`)。若需保持 fence.cjs 自测「每次调用重新求值」,把解析器从 prelude.cjs 导出为函数而非模块加载期常量。

### H2 `tests/inherit-real-env-arms.sh:118` 的 `rm -rf "$ROOT/state"` 让收尾项①的仓库清洁绊线对它自己要防的残留失明

`bin/axmem:203-231` 的绊线在**整轮遍历之后**才取 `git status --porcelain` 的 after 快照;
`bin/axmem:234-236` 的遍历顺序是 `core lib adapters lifecycle tests | sort` ⇒ `tests/` 永远最后,
而 `tests/inherit-real-env-arms.sh` 在自己结尾无条件 `rm -rf "$ROOT/state"`。
于是**任何自测在仓库里留下的 `state/`(= `e1f38eb` 修掉的那个 bug 的确切形状)都会在 after 快照之前被删掉**。

复现(丢弃副本,加一个故意往仓库写两处残留的 `lifecycle/zz-repo-writer.cjs`,跑完整 `bin/axmem selftest`):
```
  FAIL repo-cleanliness: git status --porcelain CHANGED during selftest (…)
  --- before ---
         ?? lifecycle/zz-repo-writer.cjs
  --- after ---
         ?? lifecycle/zz-repo-writer.cjs
         ?? zzjunk.txt          <-- 仓库根残留被抓到
                                 <-- ?? state/ 不见了:被 tests/ 删掉了
axmem selftest: 33/33 component self-tests passed
EXIT=1
```
单独证明删除动作:
```
--- git status BEFORE tests/inherit-real-env-arms.sh ---
?? state/
inherit-real-env-arms self-test 5/5
--- git status AFTER ---
(空)
```
即:**若只回归了 `state/` 这一种残留,整轮 selftest 会是绿的**。绊线对通用残留有效(zzjunk.txt 被抓),
对它的目标残留无效。附带问题:一个测试无条件 `rm -rf` 仓库内路径,本身是危险动作。
**改法**:删掉 `:118` 那行(arm 3 已经用 `git status` 前后对照断言了,不需要事后清理);
若确实要兜底,改成「只在 arm3 判红时清理,并让整个自测 FAIL」。

---

## MEDIUM

### M1 `lock-sweep-failed` 只闭合了一半 —— `bridge.cjs` 的三个 `produce()` 调用点仍整包丢弃 `r.events`
`queue.cjs` 四个入口确实按 spec v8.1 用 `mergeEvents()` 并入了 `claim.events`/`rel.events`(`queue.cjs:72` 的 `mergeEvents`,八处调用 `:185,263,303,316,339,357,400,485`),
但产品层的台账写在 `bridge.cjs`:
```js
// adapters/hermes/bridge.cjs:161-166 / :190-191 / :231-232
const r = queue.produce(QUEUE_ROOT, {...});
if (r.status === 'dropped') ledger([{ event: r.event, reason: r.reason }]);   // r.events 从不入账
```
复现(在副本里让 `sweepSiblings` 恒返回一条 `lock-sweep-failed`,跑真实 `post_tool_call`):
```
--- queue records (proves produce() ran) --- …/hermes-queue/<key>/<uuid>.json
--- ledger after post_tool_call ---  (NO LEDGER FILE — produce() 的 lock-sweep-failed 被 bridge.cjs 丢弃)
```
`pre_llm_call` 路径(`bridge.cjs:199,201,227` ledger 了 drain/recover 的 events)确实写出了两行
`lock-sweep-failed`,所以 spec 的「队列侧可达」勉强成立;但 spec v8.1 D11 写的是「必须经
`claim.events`/`release.events` 并入**调用方**台账」,produce 路径未做。
**改法**:三处改成 `ledger(r.events); if (r.status === 'dropped') ledger([...])`。

### M2 M1(先 stdout 后删 draining)在产品层仍是假绿 —— 把顺序改回去,bridge 自测 12/12 全绿
`queue.cjs:381-389` 侧有断言(自测 #1 证明 `drain()` 自己不删);但 spec v8.1 §2.1 要求的行为是
「由 bridge 在写完 stdout **之后**调用 `commit()`」,而这一半没有任何断言守着。
变异(`bridge.cjs:214-219` 改成 `commit(); process.stdout.write(...)`):
```
bridge self-test 12/12     <-- 假绿
```
**改法**:bridge 自测加一条:注入一个「写 stdout 时抛错/延迟」的桩,断言 draining 目录在 stdout 完成前仍存在;
或直接断言 `commit` 在 `process.stdout.write` 之后被调用(可用可观测的调用序列记录)。

### M3 `tests/isolation-real-configs.sh` 的 1/3 在**规定的隔离跑法**下是空过
该文件用 `$HOME/.claude/settings.json`、`$HOME/.codex/AGENTS.md` 做前后 sha 对照,而验收规程要求
`HOME` 指向临时目录 ⇒ 两条路径恒不存在,断言退化成 `absent == absent`,代码怎么错都不会红。
本人在规定环境下实跑原文:
```
  ok 1 real Claude Code settings.json (…/scratchpad/opusrun/home/.claude/settings.json) untouched (sha256/absence unchanged: absent)
  ok 2 real Codex AGENTS.md          (…/scratchpad/opusrun/home/.codex/AGENTS.md)      untouched (… : absent)
  ok 3 real Hermes config.yaml (C:SERS<USER>\AppData\Local/hermes/config.yaml) untouched (… : \b677c1c…)
```
只有第 3 条是真的(它读 `LOCALAPPDATA`,而隔离没覆盖它)。这正是本轮自己记下的
`[[process:green-assertion-that-cannot-fail]]` 复发。
**改法**:快照前把路径解析**固定为覆写 HOME 之前的真实值**(启动时先存一份),或当路径 absent 时打印
`-- SKIPPED` 且**不计入 ok**;`sha256sum` 输出前的 `\` 前缀也应剥掉。

### M4 `bin/axmem uninstall --all` 把「manifest 损坏」压成「没有已安装适配层」并退出 0
```bash
# bin/axmem:164-166
_names="$(node -e "…lm.readManifest(…).adapters…" …)"
[ -z "$_names" ] && { echo "uninstall: no adapters installed"; exit 0; }
```
`readManifest` 现在(正确地)对 `adapters:null` 抛 `ManifestCorruptError` ⇒ 内层 node rc 1、`_names` 为空 ⇒
CLI 打印一行未捕获的 Node 堆栈到 stderr,然后**说「no adapters installed」并 rc 0**。实测:
```
inner node rc=1   (Error: manifest "…lifecycle.json" has a malformed "adapters" field …)
uninstall: no adapters installed
CLI rc=0
```
对照:`axmem uninstall --adapter codex` 与 `axmem upgrade` 同样场景均 rc 3(已闭合)。
这是 ts M5 那条 finding 在 `--all` 路径上的残留。
**改法**:`bin/axmem:164-166` 捕获内层 rc,非零 ⇒ 打印 `readManifest` 的原始消息并 `exit 3`;别把 stderr 堆栈当输出。

### M5 spec §3 的隔离清单仍只部分落地(H4 降级,未全闭)
`tests/` 三个夹具确实进了仓库并进了 `bin/axmem selftest` 名册(H4 的核心指控已消解),但对照 spec §3 原文仍缺:
`env -i bash --noprofile --norc`、固定 PATH、temp cwd + temp git repo、`GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL`、
`XDG_*`、`HOMEDRIVE/HOMEPATH/APPDATA/LOCALAPPDATA`、**「先用无副作用命令打印并断言 Node/Git/Hermes 各自解析的
home/config 路径都在 temp 内,通过后才启动 E2E」**、以及结束后的**全树 hash 清单逐项比对**。
`tests/fresh-home-adapters.sh` 只覆写 `AXMEM_*`(+ hermes 用例的 `HERMES_HOME`),`HOME` 全程是真的;
spec §3 的 fresh-HOME E2E 还要求「合成事件经接线命令串实跑 → stdout 形状与 rc(落文件 `wc -c`)」,夹具里没有字节断言。
**改法**:按 §3 清单补 env 前置断言与全树 hash 两端比对;或在 spec 侧明确降级并写清降级理由。

### M6 `core/precommit-gate.sh --self-test` 在 `TMPDIR/TEMP/TMP` 被导出时**确定性** 6/8 FAIL ⇒ 本轮的验收证据(`selftest 32/32`)是环境条件绿
本人首跑(按任务书要求把 `HOME/USERPROFILE/HERMES_HOME` 与 `TMPDIR/TEMP/TMP` 一并指向 scratchpad):
`axmem selftest: 31/32`,`EXIT=1`,唯一 FAIL = `core/precommit-gate.sh (exit 1) — precommit-gate self-test 6/8 FAIL`,6m08s。
三次重跑同一环境:3/3 次 6/8。`TMPDIR` 不设时:8/8(短路径与长路径都一样,**不是 MAX_PATH**,是「TMPDIR 被设置」本身)。
逐步插桩定位到失败的是两条 **green 期望**(#2 verbatim-archived、#3 title-rewrite),即 gate 在该环境下误红。
`git diff 79e95e7..HEAD -- core/` **为空** ⇒ 与本修复轮无关,是 `fbeefd3` 起的既有脆弱性(大概率是
`core/precommit-gate.sh` 里那条「Path-form trap」注释所指的 MSYS `/tmp` vs 原生路径分歧)。
记在这里的理由:`bin/axmem selftest` 是本轮唯一的整体验收门,而它的绿取决于跑的人有没有导出 `TMPDIR`。
**改法**:让 `precommit-gate.sh` 自测对 mktemp 结果做一次 `cygpath -m` 归一(与 `tests/*.sh` 已经做的一样),
或在报告里如实写明「绿仅在 TMPDIR 未设置时成立」。

---

## LOW

- **L1** `lib/lock.cjs:35-46`(文件头,原文在 `:37`)与 `:369` 仍写「holder **unconditionally** sweeps ALL sibling `.claim-*`」,
  与 v8.1 实现的「只清 mtime > 2 秒」(`:253`、`:280`)矛盾。注释腐烂,正是下一个审者会照着信的东西。
- **L2** §9.1b(**活 owner 暂停 >60 秒时第二方不得获锁**)在仓库里仍无自动化用例:`lock.cjs` 自测 #4 依旧是
  同进程瞬时二次 claim。上一轮 Opus 手工补跑过并通过;代码层面也确实不存在任何基于时间回收**已发布锁**的路径
  (`lib/lock.cjs:352-365` 只在 `ownerStatus==='dead'` 时删)。但 spec §3 把它列为必测项。
- **L3** `lifecycle/tar-safety.cjs` 的三条限制(总展开 512MB `:174`、路径长度 240、GNU sparse `S` `:96`)仍有码无测(上一轮 L4 原样结转)。
  另:第二层防线 `:132 if (!Number.isSafeInteger(size) || size < 0)` 单独变异掉仍 21/21 全绿——真正被测的是
  `readOctal` 抛 `TarFieldError`(变异它 ⇒ 15b 真红),该第二层属无覆盖的冗余防御。
- **L4** `adapters/hermes/bridge.cjs:157` 生产路径读 `AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE`,可整体替换闸脚本。
  P1 是 detect-only 故影响有限,但这是一个「只给测试用」的后门留在产品路径上;建议加 `AXMEM_SELFTEST=1` 之类的双重门。
- **L5** `adapters/hermes/wire.cjs:250-262` 用 `shell: process.platform === 'win32'` 调 `execFileSync(hermesCmd, …)`,
  Node 在 `shell:true` 下不给 `file` 加引号 ⇒ PATH 上的 `C:\Program Files\...\hermes.cmd` 会被切断。
  失败方向安全(两侧都 load 失败 ⇒ rc 3 拒写),但会把「装了 hermes」误报成「loader 拒绝」。
- **L6** `bin/axmem:252` 在绊线判红之后仍打印 `axmem selftest: N/N component self-tests passed`,
  只看最后一行的人会读成全绿(实际 rc=1)。建议判红时把汇总行也改成 FAILED。
- **L7** `bin/axmem` 的 `init)` 与 `config get` 分支恒以最后一条 `echo` 的状态退出 ⇒ `mkdir`/`cp` 失败也 rc 0(既有问题,非本轮引入)。

---

## 上一轮 finding 逐条销账

| 来源 | finding | 判定 | 证据(文件:行 / 变异臂) |
|---|---|---|---|
| Opus H1 | 队列侧无 fencing | **闭合** | `queue.cjs:61 fenceOrAbort` + 8 个调用点(`:219,230,237,306,344,410,455,475`);变异「禁 fence」⇒ 11b/11c/11d 真红,14/17 |
| Opus H2 | §9.6 断言空过 | **闭合** | `queue.cjs:868` 加 `peak / ceiling >= 0.10`;我复现 **peak=2095584B / 2162688B = 96.9%,success=32 dropped=8 lock-timeout=0**;变异「payload 缩到 200B」⇒ 12 真红 |
| Opus H3 | 7 条假绿 | **闭合** | matcher(`wire.cjs:440` 字面量断言;变异 `wire.cjs:64` ⇒ 24/25 红)· tool_name 正规化 / path 正规化(`bridge.cjs` 2b;两种变异各 11/12 红)· gate stderr 标记(`bridge.cjs` #10 + `AXMEM_TEST_…` 注入;变异 ⇒ 11/12 红)· 准入后置(`queue.cjs` 11e;变异 ⇒ 红)· uninstall fence 形态 identity(`uninstall.cjs` 8b;`!== 1` → `< 1` ⇒ 9/10 红)· restore 未知 phase(`restore.cjs` #11;变异 NEW_MOVED_CONTINUE ⇒ 24/25 红) |
| Opus H4 | 隔离/E2E 夹具不在仓库 | **闭合但打折** | `tests/` 三文件已进仓库且进 selftest 名册;但见 **M3**(1/3 空过)与 **M5**(§3 清单缺项) |
| Opus M1 | drain 先删后 stdout | **闭合但引入新问题** | `queue.cjs:381-389` 返回 `commit()`,`bridge.cjs:214-219` 后调用;**产品层顺序无断言,见 M2** |
| Opus M2 | `lock-sweep-failed` 进不了台账 | **半闭合** | queue 四入口已 merge;**bridge 三个 produce 调用点仍丢弃,见 M1** |
| Opus M3 | 未用 Hermes 真 loader | **闭合** | `wire.cjs:208-282` `HERMES_HOME=<temp>` 双跑;20a-20d 四条用例;`hermes` 不在 PATH ⇒ doctor 报 `loader unused`(`doctor.cjs:160`) |
| Opus M4 | NTFS 锁吞吐 2-3/40 | **闭合** | v8.1 `STALE_CLAIM_MS=2000`(`lock.cjs:253`、`:280`)+ 退避抖动(`:378-401`)+ FILETIME 缓存(`:165-180`);实测 40 并发 **0 次 lock-timeout**(此前 38);变异「去掉 2 秒判定」⇒ 6b 真红 |
| Opus M5 | `fence.cjs` 无 `--self-test` | **闭合** | `fence.cjs:233` 起,6/6,覆盖 `recordLifecycleTarget` 的 pre/post sha256 四种分支 |
| Opus §9.7 | 断言写成 `|| true` | **闭合** | `lock.cjs:629-668` 改用「子进程 CWD 占用目录」制造真失败;`|| true` 全仓已无(见附录 C);我本机跑 lock 14/14 ⇒ 该分支真复现 |
| Opus L1/L2/L3 | 自测空转 10s / 死变量 / 冷启注释 | 闭合 / 已说明 / 未动 | `lock.cjs:599-610` 改 `await delay`;`queue.cjs:111-117` 注明为 doctor 报告用非死码;L3 未处理(非阻断) |
| ts H1 | restore CLI 不查返回值 | **闭合** | `restore.cjs:427-441 cliRestore`(判定在 `:435`);#9;变异 `if (false)` ⇒ 24/25 红 |
| ts H2 | `NEW_MOVED_CONTINUE` 数据丢失 | **闭合** | `restore.cjs:390-399` 改 `continueFrom('OLD_MOVED')`;**10 行恢复矩阵各一条真文件系统终态断言**(`restore.cjs:739` 起的 rows 表);变异 ⇒ 真红 |
| ts M2 | 死 owner 回收从未端到端 | **闭合** | `lock.cjs:707-730` 真子进程 claim 后退出 |
| ts M3/M4 | fence.cjs 无自测 / selftest 只走 core | **闭合** | 见 Opus M5;`bin/axmem:168-253` 改为全遍历 + `chk()` 去 `eval`(`bin/axmem:60`) |
| ts M5 | `Array.isArray === Array.isArray` 恒真 | **闭合(CLI `--all` 除外)** | `install-manifest.cjs:55-58`;#7/7b/7c;uninstall #9、upgrade #4;变异 ⇒ 各真红。**`bin/axmem uninstall --all` 仍 rc 0,见 M4** |
| ts M6 | MSYS 路径零防御 | **闭合(fence.cjs 除外)** | `lib/msys-path.cjs` 8/8 + `prelude.cjs:28-30,49-50` + `bridge.cjs` #9。**`fence.cjs` 未走这条链,见 H1** |
| ts M7 | allowlist 过滤无反例 | **闭合** | `doctor.cjs:261`;变异「过滤恒真」⇒ 4/5 红 |
| sec H1 | owner.json pid 只查类型 | **闭合** | `lock.cjs:90-106 pidExists` 三分 + `:203-207 readOwner` 拒绝;#10/#11;变异「去两处校验 + 其它错误判死」⇒ 12/14 红 |
| sec M1 | tar 负数 size 抛 RangeError | **闭合** | `tar-safety.cjs:40-72 readOctal` 抛 `TarFieldError`;#15/#15b;变异 readOctal ⇒ 20/21 红 |
| sec L | `~/.hermes` 是符号链接 | 已记录 | `tests/isolation-real-configs.sh:33-37` 直接查 `%LOCALAPPDATA%\hermes\config.yaml` 本体 |

### 收尾五项
| # | 项 | 判定 |
|---|---|---|
| ① | `state/` 残留 + 跑后 git status 断言 | **闭合但被自己人打了洞** — `fence.cjs` 兜底已改(变异回 `process.cwd()` ⇒ arm3 真红)、绊线确实会响(我实测 FAIL + EXIT=1);但见 **H2**(对 `state/` 失明)与 **H1**(兜底本身改错了目标) |
| ② | 三臂 E2E 夹具 | **闭合但打折** — 见 M3 / M5 |
| ③ | bridge 假绿 | **闭合** — `bridge.cjs` #10,变异真红 |
| ④ | doctor.sh 去耦 | **闭合** — `adapters/generic/doctor.sh:43-47` 直接写 stamp,不再跑真 canary;4/4 |
| ⑤ | 归档 + `.gitignore` | **闭合** — 7 份 codex 审查 + 上轮 Opus 验收已在 `docs/audits/`(`git ls-files` 可见),`.gitignore:4` 加了 `.codex-reviews/` |

---

## 附录 A — 本人亲跑清单(原文)

```
# 跑前     cd C:/Users/<user>/Desktop/axmem && git status --porcelain
(空)                              HEAD = e03ae69f4a142f6918cc541d83bb561fefac24d8

# bash bin/axmem selftest   (HOME/USERPROFILE/HERMES_HOME/TMPDIR 全指 scratchpad 临时目录)
  ok   adapters/claude-code/merge-hooks.cjs — claude-code merge-hooks self-test 5/5
  ok   adapters/codex/wire.sh — codex wire self-test 5/5
  ok   adapters/generic/doctor.sh — generic doctor self-test 4/4
  ok   adapters/generic/schedule.sh — schedule self-test 5/5
  ok   adapters/generic/wire.sh — generic wire self-test 6/6
  ok   adapters/hermes/bridge.cjs — bridge self-test 12/12
  ok   adapters/hermes/doctor.cjs — hermes doctor self-test 5/5
  ok   adapters/hermes/queue.cjs — queue self-test 17/17
  ok   adapters/hermes/wire.cjs — hermes wire self-test 25/25
  ok   core/canary.sh · core/fingerprint.sh 5/5 · core/manifest.sh 9/9 · core/pointer-lint.sh 2/2
  FAIL core/precommit-gate.sh (exit 1)
         precommit-gate self-test 6/8 FAIL                     <-- 见 M6(TMPDIR 被导出所致,与本轮无关)
  ok   core/receipt.sh 7/7 · core/redundancy-lint.sh 7/7 · core/trigger-recall.sh 12/12 · core/write-gate.sh 10/10
  ok   lib/fence.cjs 6/6 · lib/fence.sh 9/9 · lib/lock.cjs 14/14 · lib/msys-path.cjs 8/8 · lib/prelude.cjs 4/4
  ok   lifecycle/backup.cjs 5/5 · install-manifest.cjs 9/9 · restore.cjs 25/25 · tar-safety.cjs 21/21
  ok   lifecycle/uninstall.cjs 10/10 · lifecycle/upgrade.cjs 4/4
  ok   tests/fresh-home-adapters.sh 4/4 · tests/inherit-real-env-arms.sh 5/5 · tests/isolation-real-configs.sh 3/3
  ok   repo-cleanliness: git status --porcelain unchanged by this run
axmem selftest: 31/32 component self-tests passed
real 6m8.121s      EXIT=1

# 跑后     git status --porcelain
(空)

# 单跑复核
bash core/precommit-gate.sh --self-test              (TMPDIR 未设) -> 8/8, rc 0   x2
bash core/precommit-gate.sh --self-test              (TMPDIR 已设) -> 6/8, rc 1   x3  (短/长路径均同)
node adapters/hermes/queue.cjs --self-test           -> 17/17;§9.6 peak=2095584B ceiling=2162688B ratio=96.9%
                                                        samples=354 (10ms) success=32 dropped=8 lock-timeout=0 unparsed=0 elapsed=5870ms
bash bin/axmem fingerprint check                     -> fingerprint roster: 24 file(s) all consistent, rc 0
bash tests/isolation-real-configs.sh --self-test     -> 3/3(其中 2 条为 absent==absent,见 M3)
# 丢弃副本上的整轮 selftest(带注入的仓库写入自测): 33/33 组件绿 + repo-cleanliness FAIL + EXIT=1(见 H2)
```

## 附录 B — 变异反证表(全部在丢弃副本上,跑完已删)

| 变异 | 位置 | 结果 |
|---|---|---|
| 禁用队列 fencing | `queue.cjs:61-65` | **真红** 14/17(11b/11c/11d) |
| 准入检查移到落盘之后 | `queue.cjs:205`(scanStats)前插 writeFileSync | **真红** 14/17(11b/11e/12) |
| 屏障 payload 缩到 200B(上限不再被逼近) | `queue.cjs:814` | **真红** 16/17(#12 ratio 子句) |
| 去掉 gate stderr 标记判定 | `bridge.cjs:159` | **真红** 11/12(#10) |
| 删除 `tool_name → Write` 正规化 | `bridge.cjs:179` | **真红** 11/12(#2b) |
| 删除 `path → file_path` 正规化 | `bridge.cjs:179` | **真红** 11/12(#2b) |
| matcher 字面量改 `^(Write\|Edit)$`(只改 `:64`,不改断言) | `wire.cjs:64` | **真红** 24/25(#0) |
| 去掉 owner.pid 结构校验 + 其它错误判死 | `lock.cjs:97,207,104` | **真红** 12/14(#10/#11) |
| 去掉 2 秒陈旧判定(恢复无条件清扫) | `lock.cjs:280` | **真红** 13/14(#6b) |
| `NEW_MOVED_CONTINUE` 改回 `continueFrom()` | `restore.cjs:399` | **真红** 24/25(#10 row) |
| `cliRestore` 忽略 `performRestore` 返回值 | `restore.cjs:435` | **真红** 24/25(#9) |
| fence identity 改「首个匹配」(`!== 1` → `< 1`) | `uninstall.cjs:39` | **真红** 9/10(#8b) |
| manifest `adapters` 改回 `typeof === 'object'` | `install-manifest.cjs:55` | **真红** 7/9(#7/#7b) |
| `readOctal` 非八进制字段改为静默 coerce | `tar-safety.cjs:65` | **真红** 20/21(#15b) |
| allowlist 过滤恒真 | `doctor.cjs:61` | **真红** 4/5(#5) |
| `fence.cjs` state-dir 兜底改回 `process.cwd()` | `lib/fence.cjs:46` | **真红** 4/5(inherit-real-env arm 3) |
| **bridge 层先 `commit()` 后写 stdout** | `bridge.cjs:214-219` | **假绿 12/12 ⇒ M2** |
| **自测往仓库写 `state/` + 根文件** | 注入 `lifecycle/zz-repo-writer.cjs` | 绊线**只抓到根文件**,`state/` 被 tests/ 删掉 ⇒ **H2** |
| **强制 `sweepSiblings` 报失败 + 真 `post_tool_call`** | `lock.cjs:255` / `bridge.cjs:161-166` | 台账**零行** ⇒ **M1** |
| 真实 `wire.sh` + `config.json` 设 `state_dir` ⇒ `uninstall` | `lib/fence.cjs:45-48` | `uninstall rc=3 "no manifest entry"`,围栏未移除 ⇒ **H1** |

**合计:16 条真红 / 2 条假绿(M2、H2)/ 2 条新缺陷复现(M1、H1)。上一轮的 7 条假绿与 3 条不可验证,现已全部可验证且真红。**

## 附录 C — 专项 lint(本人跑,原文)

```
# '|| true' in lib/ adapters/ lifecycle/ bin/ tests/ (排除 core/)
lib/fence.sh:94:  crlf_count="$(grep -c $'\r' "$T/target8.md" || true)"      # grep -c 计数,非断言
lib/lock.cjs:629: // …the old assertion had `|| true` … removed             # 注释
lib/prelude.sh:53: mkdir -p "$AXMEM_STATE_DIR" 2>/dev/null || true          # 非断言
=> 断言里的 '|| true' 全仓已无

# 同名操作数比较 (X === X) / typeof null:零命中(3 处正则命中均为 t.path === path.resolve(target) 之类的异操作数)
# 恒真/恒假子句 (if (true) / && true / || 1):零命中
# 同名顶层函数重复定义:15 个 .cjs 逐个扫描,零命中
# git diff --stat 79e95e7..HEAD -- core/ :空(D8「core 零改动」成立)
```

---

## 最小改动清单(按优先级)

1. **H1** `lib/fence.cjs:45-48` 改走 prelude 的 env > config.json > 默认 + `normalizeMsysPath` 链;加一条自测:
   `config.json` 里设 `state_dir` ⇒ wire ⇒ `lifecycle.json` 必须落在**配置的** state_dir ⇒ `uninstall` 必须成功移除。
2. **H2** 删 `tests/inherit-real-env-arms.sh:118` 的 `rm -rf "$ROOT/state"`;并在 `bin/axmem` 的绊线里对
   `state/` 这一路径加一条显式断言(它是已知的回归形状,值得单点守)。
3. **M1** `bridge.cjs:161-166 / :190-191 / :231-232` 三处补 `ledger(r.events)`。
4. **M2** 给「stdout 完成后才 commit」加一条可失败的断言。
5. **M4** `bin/axmem:164-166` 捕获内层 rc,非零 ⇒ 原样打印 `readManifest` 消息并 `exit 3`。
6. **M3** 隔离夹具在覆写 HOME **之前**解析真实路径,或 absent 时报 SKIPPED 且不计 ok。
7. **M6** `core/precommit-gate.sh` 自测对 mktemp 结果做 `cygpath -m` 归一(或在验收口径里写明 TMPDIR 条件)。
8. **M5** 按 spec §3 补 `env -i` / 固定 PATH / temp git repo / `GIT_CONFIG_NOSYSTEM` / `XDG_*` / 前置路径断言 / 全树 hash 两端比对;或在 spec 侧正式降级。
9. **L1** 修 `lib/lock.cjs` 里两处与 v8.1 矛盾的「unconditionally sweeps ALL」注释。
10. (非阻断)L2 §9.1b 60 秒暂停用例 · L3 tar 三条限制的用例 · L4 gate 覆盖 env 加双重门 · L5 `shell:true` 加引号 · L6 汇总行判红 · L7 `init`/`config get` 退出码。

## LESSON CANDIDATES

1. **`[[axmem:guard-deleted-its-own-evidence]]`** —— 新加的回归绊线(跑后 `git status` 对照)被同一批次里另一个
   测试结尾的 `rm -rf "$ROOT/state"` 打穿:绊线还在、还会对别的残留响,唯独对**它被造出来防的那一种**失明。
   验收动作:对任何「前后快照」型守卫,先问「这轮里有谁会在两次快照之间清理现场?」——按执行顺序数一遍写路径的人。
2. **`[[process:fallback-must-reuse-the-resolver-not-reimplement-it]]`** —— `fence.cjs` 把「兜底目录」从
   `process.cwd()` 改成 `os.homedir()+'/.axmem'`,注释宣称「与 prelude.cjs 一致」,实际漏掉了 config.json 与 MSYS 归一化两层,
   结果 manifest 与 uninstall 各写各的目录。规则:同一个路径概念只许有**一个**解析函数;第二份实现即使今天等价,
   也会在第一份长出第三层时静默分叉。
3. **`[[process:isolation-harness-can-make-its-own-assertion-vacuous]]`** —— 「证明真实 `~/.claude` 未被改」的断言,
   在规定的隔离跑法(HOME 指向 temp)下退化成 `absent == absent`。凡是拿**真实环境**做对照的断言,
   必须在覆写环境**之前**取基准,并在基准不存在时报 SKIPPED 而不是 ok。
4. **`[[process:half-closed-finding-reads-as-closed]]`** —— `lock-sweep-failed` 在库层与 queue 层都接好了,
   只有产品层 3 个调用点丢弃 —— 提交信息、CHANGELOG、自测三者都显示「已闭合」。
   验收动作:对「事件必须到达台账」这类端到端要求,只认**最终落盘产物**(这里是 ledger TSV)里的那一行,不认中间层的返回值。
5. **`[[process:env-conditional-green]]`** —— 同一条 `axmem selftest`,导出 `TMPDIR` 则 31/32 红、不导出则 32/32 绿,
   三跑三同。声称「全绿」时必须连同**环境指纹**(哪些变量被设置)一起声称,否则两个人报的是两个实验。

---

# 增量闭合核查(第二批修复:`df0d569..086429e`,14 提交)

审查者:Opus(同一验收者,只读;唯一写入 = 本文件)。日期 2026-09-17。
HEAD `086429e2992650939a0b780cc1d158cb0e1464a9`。范围:**只核本文件上半部的 2H/6M/7L 与 ECC typescript 的 2M/1L**,不重审整包。
同样全程 `HOME=USERPROFILE=HERMES_HOME=TMPDIR` 指向 scratchpad 临时目录;变异/注入在丢弃副本 `…\Temp\axmut2` 上做,跑完已删;真实仓库 `git status --porcelain` 跑前跑后均空。

## 结论

**GO-WITH-CHANGES(0 新 HIGH / 1 新 MEDIUM / 2 新 LOW;原 2H 全闭合,原 6M 中 5 条闭合、1 条闭合但引入新问题,原 7L 中 5 条闭合、1 条闭合但引入新问题、1 条按指示不做;ECC 3 条全闭合)。**
两个 HIGH 我都按要求亲跑端到端复现了闭合。**唯一需要再动一次的是 M5**:新文件 `tests/full-env-isolation.sh` 把
M3 刚修掉的「absent==absent 算 ok」原样复刻了一遍(6/6 里有 2 条在规定跑法下是空过)。这是一处小改动,
不阻断合并,但**在它修掉之前,不能把 `full-env-isolation 6/6` 当作「真实 ~/.claude、~/.codex 未被写」的证据**。

## 逐条销账

| # | 原 finding | 判定 | 证据(HEAD 真实代码 + 我的复现) |
|---|---|---|---|
| **H1** | `fence.cjs` state-dir 解析与 prelude 分叉 ⇒ uninstall 失效 | **闭合** | `832d72f`。`lib/prelude.cjs:47-59` 新增唯一解析器 `resolveStateDir()`(env > config.json `state_dir` > 默认,经 `normalizeMsysPath` + `tilde`),`lib/fence.cjs:30` 改 `require('./prelude.cjs')`、`:158` 与 `:187` 改调 `ctx.resolveStateDir()`,旧的手写 `defaultStateDir()` 已删。**亲跑端到端(与我上轮判红用的是同一个脚本)**:`wire rc= 0` / `manifest at CONFIGURED state_dir? true` / `manifest at AXMEM_HOME/state? false` / `uninstall rc= 0` / `uninstall: codex removed` / `fence STILL in target after uninstall? false`。第二形态(MSYS `AXMEM_STATE_DIR=/c/...`)同样复跑:备份落在 `…\st\backups`(true)、`C:\c\…`(false),事后 `C:\c` 不存在。回归测试已入仓:`tests/fresh-home-adapters.sh` 第 5 例(5/5) |
| **H2** | `tests/inherit-real-env-arms.sh` 的 `rm -rf "$ROOT/state"` 把绊线的目标证据洗掉 | **闭合** | `9f5eac1`。那行已删(`tests/inherit-real-env-arms.sh:129-141` 改为解释性注释);`bin/axmem:291-306` 改为**每个组件跑完各取一次快照**与上一个组件比对,并对 `$ROOT/state` 单独做存在性判定。**亲跑注入验证**(丢弃副本里放一个排序最前的 `adapters/aa-early-repo-writer.cjs`,自测里往仓库根写 `state/backups/probe.bak`):`ok adapters/aa-early-repo-writer.cjs — self-test 1/1` → `FAIL repo-cleanliness: "…/state" exists after adapters/aa-early-repo-writer.cjs (this exact path has regressed before — commit e1f38eb)` → `FAIL repo-cleanliness: git status --porcelain changed by adapters/aa-early-repo-writer.cjs`(after 段显示 `?? state/`)。整轮 `axmem selftest: FAILED (33/33 …)`、`EXIT=1`。**当场红、点名到组件,两种判据各响一次** |
| **M1** | `lock-sweep-failed` 只到 queue 层,bridge 三个 produce 调用点丢弃 `r.events` | **闭合** | `d30de2d`。`bridge.cjs:180`、`:208`、`:263` 各加 `ledger(r.events)`。**亲跑**(副本里让 `sweepSiblings` 恒报失败,跑真 `post_tool_call`):队列记录发布成功,且台账 TSV 出现 `2026-09-17T07:57:32.270Z<TAB>lock-sweep-failed<TAB>FORCED` —— 上一轮同一探针得到的是「无台账文件」。仓库内也有自测(`bridge.cjs` #11,用子进程 CWD 钉住陈旧 `.claim-*` 造真失败) |
| **M2** | 「先 stdout 后 commit」在产品层无断言(改回去仍 12/12) | **闭合** | `d30de2d`。`bridge.cjs:229-230` 加只读观测钩子 `AXMEM_TEST_SEQUENCE_LOG`,`:243-250` 在 write 返回与 commit 处各记一行;自测 #12 读回文件断言顺序。**变异反证**:把 `commit()` 挪到 `stdout.write()` 之前 ⇒ `FAIL 12 (Opus M2) …`,`bridge self-test 14/15`(上一轮同一变异是 12/12 假绿) |
| **M3** | `isolation-real-configs.sh` 在规定跑法下 2/3 空过 | **闭合** | `9afca26`。`tests/isolation-real-configs.sh:29-46` 新增 `check_iso`:before/after 同为 `absent` ⇒ 记 SKIPPED、不计入 `$ok`;before=absent 而 after 出现文件仍走 `check` 判红。**亲跑整轮时真触发**:`isolation-real-configs self-test 1/3 ok, 2 skipped (baseline absent on this machine)` |
| **M4** | `uninstall --all` 把损坏 manifest 压成「没有已安装适配层」+ rc 0 | **闭合** | `1794256`。`bin/axmem:178-200` 内联脚本自己 catch 并 `process.exit(3)`,外层 `_names_rc=$?` 后 `exit`。**亲跑**:`uninstall: manifest "…lifecycle.json" has a malformed "adapters" field …`,`rc=3`(上一轮同一场景是未捕获 Node 堆栈 +「no adapters installed」+ rc 0) |
| **M5** | spec §3 隔离清单只部分落地 | **闭合但引入新问题(见下「新 MEDIUM」)** | `ac6f7f1` 新增 `tests/full-env-isolation.sh`(193 行)。**我要的那一半确实到位**:`:94-106` 覆写 HOME/USERPROFILE/HOMEDRIVE/HOMEPATH/APPDATA/LOCALAPPDATA/XDG_CONFIG_HOME/XDG_DATA_HOME/HERMES_HOME/GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL + temp cwd + temp git repo;`:112-143` 三条**无副作用前置断言**(Node `os.homedir()`、`git config --show-origin --get user.name`、`wire.cjs resolveTargetPath()`)在 E2E 之前就要求解析结果落在 temp 内。我亲跑三条前置断言均真绿且打印了真实解析值 |
| **M6** | `core/precommit-gate.sh` 在 TMPDIR 导出时 6/8 ⇒ 整体绿是环境条件绿 | **闭合(按 report-only 路由)**,残留风险如实记账 | `905460c`。`bin/axmem:267-280` 只对 `_rel = core/precommit-gate.sh` 一条路径特判:`count` 减一、不计 `passcount`、**不置 `rc`**,失败时仍完整打印输出。**亲跑确认路由生效且未掩盖别的红**:整轮日志第 15-16 行 `known core/precommit-gate.sh — report-only, not counted toward rc (…): precommit-gate self-test 6/8 FAIL`,同轮 `EXIT=0`;单跑复核 TMPDIR 导出 ⇒ 6/8 rc 1、TMPDIR 未设 ⇒ 8/8 rc 0(**该 flake 在我环境稳定复现,建造者自报复现不出**);`grep -n 'core/precommit-gate.sh' bin/axmem` 确认特判只命中这一条路径,其余组件仍走原 `else` 分支置 `rc=1`(H2 注入实验里非 precommit 的失败确实让整轮 `EXIT=1`) |
| **L1** | `lock.cjs` 注释仍称「unconditionally sweeps ALL sibling」 | **闭合但引入新问题(见下「新 LOW-a」)** | `4b017f6` 改了三处 |
| **L2** | §9.1b 60 秒暂停用例 | **未做(按主脑指示)** | 代码层论据不变:`lib/lock.cjs:361-374` 只在 `ownerStatus==='dead'` 时回收,不存在对**已发布锁**的时间回收 |
| **L3** | tar 三条限制有码无测 | **闭合** | `086429e`。新增 #16(总展开 >512MB,用 9 个各 60MB 的合法成员凑出)、#17(路径长 246 > 240,用 prefix+name 拼)、#18(GNU sparse `S`);`tar-safety self-test 24/24`。同提交删掉了我在 L3 里点名的那条可证不可达的重复 size 检查 |
| **L4** | `AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE` 是产品路径上的测试后门 | **闭合** | `35b4e13`。`bridge.cjs:163` 改为 `(process.env.AXMEM_SELFTEST === '1' && process.env.AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE) || <真 gate>`;自测 #13 用「假 gate 会 touch 一个标记文件」直接证明单独设 override 时假 gate **根本没被调用** |
| **L5** | `shell:true` 下 `hermesCmd` 未加引号 | **闭合** | `aa66316`。`wire.cjs:250-263` win32 下加引号;自测 #21 用真放在 `space dir/` 里的 `.cmd` 复现并断言 `ok===true`;`hermes wire self-test 26/26` |
| **L6** | 判红后汇总行仍打印 N/N passed | **闭合** | `9f5eac1`。`bin/axmem:316-320`;H2 注入实验实测末行 `axmem selftest: FAILED (33/33 component self-tests passed)` |
| **L7** | `init`/`config get` 恒 rc 0 | **闭合(`init`);`config get` 那半仍是空转** | `1b9fb0b`。`bin/axmem:49-74` 每步 `|| _init_rc=1` 并显式 `exit`;**亲跑**把 AXMEM_HOME 指向一个不可能建的路径 ⇒ `init rc=1`(此前为 0)。`config get`(`:322`)虽然捕获了 `$?`,但 `axmem_cfg` 本身是 `node … || printf '%s' "$2"`,失败会被 `||` 吞成 0 ⇒ 该分支退出码实际仍恒 0(见「新 LOW-b」) |
| **ECC M1** | `pidExists()` 的 unknown 分支从未被真正走到 | **闭合** | `551ff7c`。`lock.cjs` 自测 #13 直接 mock 出一个非 ESRCH/EPERM 的抛错并断言 `=== 'unknown'`;`lock self-test 15/15` |
| **ECC M2** | 仓库整洁只在首尾比对 | **闭合** | 与 H2 同一处修法(`9f5eac1`,逐组件比对),证据同 H2 |
| **ECC L1** | `real_home_state` 基线只看 `os.homedir()`,忽略 `HOME` | **闭合** | `05565be`。`tests/inherit-real-env-arms.sh:31-42` 改为与 `prelude.cjs` 同款 `normalizeMsysPath(process.env.HOME) || os.homedir()` |

## 新发现(本批引入)

### 新 MEDIUM — `tests/full-env-isolation.sh` 把 M3 刚修掉的空过原样复刻了一遍

`:75-86` 用**脚本启动时的 `$HOME`** 解析 `~/.claude`、`~/.codex` 基线 —— 而验收规程要求 `HOME` 指向临时目录,
于是这两棵树在 before 与 after 都是 `__AXMEM_ABSENT__`,`comm -13` 恒为空,两条断言恒绿,**且没有 M3 那套 SKIPPED 记账**,
直接计进 `ok` 凑成 6/6。我在规定环境下实跑原文:

```
  ok   no AxMem-shaped new path appeared under real ~/.claude (…/scratchpad/opusrun2/home/.claude) during the isolated run
  ok   no AxMem-shaped new path appeared under real ~/.codex  (…/scratchpad/opusrun2/home/.codex)  during the isolated run
  ok   no AxMem-shaped new path appeared under real Hermes home (C:SERS<USER>\AppData\Local/hermes) during the isolated run
full-env-isolation self-test 6/6
```

(第 3 条是真的:它走 `LOCALAPPDATA`,隔离没覆盖它;`ls -d "$HOME/.claude" "$HOME/.codex"` 确认前两条的目标根本不存在。)

**对「签名过滤 diff 取代全树 hash」本身的判定:可接受。** 理由:① `~/.claude` 5.5 万 + `~/.codex` 4.9 万文件、
且本机确有并发后台写入者,全树内容 hash 必然产生与 AxMem 无关的假红 —— 这正是 CLAUDE.md 残余风险第 6 条
(共享的东西先问「谁还会写它」)的正例,建造者没有硬做而是记账,是对的;② 它保留了**全树扫描**(`find`),
只在 diff 阶段按签名过滤,不是把范围缩小到几个已知文件;③ 文件头把丢掉的那一类(既有文件的原地内容改写、
不产生新路径)写清楚了,并指明由 `isolation-real-configs.sh` 的 sha256 覆盖那 3 个具体目标。
**但 ③ 这条补偿控制在规定跑法下正好是 SKIPPED 的** —— 两个文件的空过口子叠在一起,结果是
**在本机的验收跑法下,没有任何一条活着的断言在证明真实 `~/.claude`/`~/.codex` 未被写**。

**我能接受的最小改法(二选一,不必都做)**:
1. 把 `isolation-real-configs.sh:29-46` 的 `check_iso` 搬过来复用:before 与 after 同为 `__AXMEM_ABSENT__` ⇒ 记 SKIPPED、不计 `$ok`(与 M3 口径一致,最小、零新概念);**或**
2. 在覆写 HOME **之前**把三条真实路径解析结果存下来并从那份基线走(例如 `:75` 之前先取 `REAL_HOME="${AXMEM_REAL_HOME:-$HOME}"`,由 `bin/axmem selftest` 在覆写前传入),让断言在隔离跑法下也真正指向用户的真实目录。

做 1 就足以消除「假绿」;做 2 才能真正恢复这条断言的覆盖面。

### 新 LOW-a — `lib/lock.cjs:37-40` 的注释把一个错说法换成了另一个

修正后的文件头写的是「sweeps sibling `.claim-*` **and** `.released-*` … **older than STALE_CLAIM_MS**」,
但 `sweepSiblings()`(`:275-284`)的 mtime 判定在 `if (isClaim)` 里,`.released-*` 仍是**无条件**删除;
同文件 `:249-252` 的函数级注释对此解释得完全正确(release 已经 fence 过,不存在 in-flight 状态)。
即文件头与函数体互相矛盾。**改法**:文件头补一句「`.released-*` 不受 2 秒判定约束,理由见 sweepSiblings 上方注释」。

### 新 LOW-b — 新加的 `AXMEM_TEST_SEQUENCE_LOG` 没有沿用 L4 刚立的双重门;`config get` 的退出码修法是空转

- `bridge.cjs:229-230` 的观测钩子只看一个环境变量就 `fs.appendFileSync(process.env.AXMEM_TEST_SEQUENCE_LOG, …)`,
  即产品路径上一个由环境变量指定目标的追加写原语 —— 与 `:163` 刚加上 `AXMEM_SELFTEST === '1'` 双重门的那个后门同类。
  **改法**:同样挂在 `AXMEM_SELFTEST === '1'` 之后。
- `bin/axmem:322` 捕获了 `axmem_cfg` 的退出码,但 `lib/prelude.sh:25` 的 `axmem_cfg` 是 `node … || printf '%s' "$2"`,
  `||` 分支成功即整体成功 ⇒ `_cfg_rc` 实际恒为 0。L7 的 `config get` 那一半没有真正生效(`init` 那一半是真的,已实测)。
  **改法**:要么让 `axmem_cfg` 在 fallback 时返回非零,要么把这半条如实记为「不修」。

## 亲跑清单(原文)

```
HEAD = 086429e2992650939a0b780cc1d158cb0e1464a9
# 跑前 git status --porcelain : (空)

bash bin/axmem selftest   (HOME=USERPROFILE=HERMES_HOME=TMPDIR 同指 scratchpad 临时目录)
  ok   adapters/hermes/bridge.cjs — bridge self-test 15/15
  ok   adapters/hermes/wire.cjs   — hermes wire self-test 26/26
  ok   adapters/hermes/queue.cjs  — queue self-test 17/17
  known core/precommit-gate.sh — report-only, not counted toward rc (TMPDIR-export flakiness, pre-existing since fbeefd3): precommit-gate self-test 6/8 FAIL
  ok   lib/lock.cjs — lock self-test 15/15
  ok   lifecycle/tar-safety.cjs — tar-safety self-test 24/24
  ok   lifecycle/restore.cjs — restore self-test 25/25
  ok   tests/fresh-home-adapters.sh — fresh-home-adapters self-test 5/5
  ok   tests/full-env-isolation.sh — full-env-isolation self-test 6/6
  ok   tests/inherit-real-env-arms.sh — inherit-real-env-arms self-test 5/5
  ok   tests/isolation-real-configs.sh — isolation-real-configs self-test 1/3 ok, 2 skipped (baseline absent on this machine)
  ok   repo-cleanliness: git status --porcelain unchanged after every one of the 32 component runs (checked per-component, not just start/end)
axmem selftest: 32/32 component self-tests passed
real 8m5.458s      EXIT=0
# 跑后 git status --porcelain : (空)

bash bin/axmem fingerprint check            -> fingerprint roster: 24 file(s) all consistent
bash core/precommit-gate.sh --self-test     -> TMPDIR 导出 6/8 rc 1 · TMPDIR 未设 8/8 rc 0
H1 端到端(config.json 设 state_dir)       -> manifest 落配置目录 true / uninstall rc 0 "codex removed" / 围栏已移除
H1 第二形态(MSYS AXMEM_STATE_DIR=/c/...)  -> 备份落原生 st\backups true · C:\c\... false
M1 台账探针(强制 sweep 失败 + 真 post_tool_call) -> ledger TSV 出现 lock-sweep-failed
M4 CLI 探针(损坏 manifest + uninstall --all)     -> 干净报错 + rc 3
L7 探针(init 指向不可建路径)                     -> rc 1
M2 变异(commit 挪到 stdout.write 之前)           -> FAIL #12,bridge 14/15
H2 注入(排序最前的组件往仓库写 state/)           -> 当场 FAIL 并点名该组件,末行 "axmem selftest: FAILED (33/33 …)",EXIT=1
恒真/恒假子句 lint、同名顶层函数重复 lint          -> 与上一轮相同:断言里零命中
# 丢弃副本已删;C:\c 不存在;真实仓库 git status --porcelain 仍为空
```

## 残留风险(非缺陷,记账用)

`core/precommit-gate.sh` 现在**永远不能让 `axmem selftest` 变红**。它守的是「retire = move:删一条 entry 必须在同一提交里
verbatim 出现在 archive」这条结构性防数据丢失规则 —— 把它从验收门里摘出去是主脑已拍板的临时处置(spec v8.2 已记),
但要给根因修复定一个期限:在它回到门内之前,这条规则的回归只能靠人看。

## LESSON CANDIDATE(追加一条)

**`[[process:fixing-a-vacuous-assertion-doesnt-fix-its-copy]]`** —— M3 把「absent==absent 算通过」修成 SKIPPED,
同一批次里新写的 `full-env-isolation.sh` 又原样写了一遍同样的空过,而且没带 SKIPPED 记账。
「见一个缺陷当场扫同类」(CLAUDE.md 残余风险 8)要扫的不只是**已有**代码,还包括**同一批次里正在新写**的代码:
修完一个空过断言,立刻 grep 一次同批 diff 里有没有同形状的新断言。

---

# 第三批核查(`086429e..0c7e1cf`,3 个修复提交)

审查者:Opus(同一验收者,只读;唯一写入 = 本文件)。日期 2026-09-17。
HEAD `0c7e1cf188e696b1bb2c7b44f2a0acd7a7cc7d78`。范围:**只核上一节「新发现」里的 1 MEDIUM + 2 LOW**,未重跑整包。
真实仓库 `git status --porcelain` 跑前跑后均空;注入探针在丢弃副本 `…\Temp\axmut3` 上做,跑完已删。

## 结论

**GO(3 条全部闭合)** —— 三条都在 HEAD 真实代码上定位到修法,并各自亲跑复现;隔离跑法与真实 HOME 跑法我都跑了。
遗留 1 条 **LOW-c**(新引入、很窄):`check_new_path_or_skip` 的跳过谓词比它声称要对标的 `check_iso` 少了一半,
一行可改,不阻断。

## 逐条

### ① `tests/full-env-isolation.sh` 的空过 —— **闭合**

`5b576df`。`:84-93` 新增 `check_new_path_or_skip()`:基线为 `__AXMEM_ABSENT__` ⇒ 记 SKIPPED、**不计入 `$ok`**;
`:206/:209/:212` 三处改为调它;`:218-222` 收尾门从 `ok -eq 6` 改为 `ok + skipped -eq 6`。

**(a) 规定的隔离跑法**(`HOME/USERPROFILE/HERMES_HOME/TMPDIR` 同指临时目录)—— 两条确实是 SKIPPED,不再计 ok:

```
  ok      pre-flight: Node os.homedir() resolves inside temp (…/tmp.KDCLg27Nfw/home)
  ok      pre-flight: git config --show-origin --get user.name finds nothing outside temp (result: '')
  ok      pre-flight: Hermes adapter's resolved config path is inside temp (…\tmp.KDCLg27Nfw\home\.hermes\config.yaml)
  SKIPPED no AxMem-shaped new path appeared under real ~/.claude (…/scratchpad/opusrun2/home/.claude) …
  SKIPPED no AxMem-shaped new path appeared under real ~/.codex  (…/scratchpad/opusrun2/home/.codex)  …
  ok      no AxMem-shaped new path appeared under real Hermes home (C:SERS<USER>\AppData\Local/hermes) …
full-env-isolation self-test 4/6 ok, 2 skipped (baseline absent visible to this script)
rc=0
```

**(b) 非隔离(真实 HOME)跑法** —— 真比对恢复,三条全部落在用户的真实目录上,0 skipped:

```
  ok   pre-flight: Node os.homedir() resolves inside temp (C:/Users/<user>/AppData/Local/Temp/tmp.ezKRm5RgXM/home)
  ok   pre-flight: git config --show-origin --get user.name finds nothing outside temp (result: '')
  ok   pre-flight: Hermes adapter's resolved config path is inside temp (…\tmp.ezKRm5RgXM\home\.hermes\config.yaml)
  ok   no AxMem-shaped new path appeared under real ~/.claude (/c/Users/<user>/.claude) during the isolated run
  ok   no AxMem-shaped new path appeared under real ~/.codex (/c/Users/<user>/.codex) during the isolated run
  ok   no AxMem-shaped new path appeared under real Hermes home (C:SERS<USER>\AppData\Local/hermes) during the isolated run
full-env-isolation self-test 6/6 ok, 0 skipped (baseline absent visible to this script)
rc=0
```

即:**「6/6」不再是隔离跑法下拿得到的数字**,拿到 6/6 的那次确实扫了真实的 `/c/Users/<user>/.claude`(5.5 万文件)
与 `/c/Users/<user>/.codex`,前置三条断言两次都打印了真实解析值。上一节那条 MEDIUM 就此关闭。

### ② `lib/lock.cjs` 三处注释与代码事实 —— **闭合**

`234783b`。现在三处说法与实现完全一致:

| 位置 | 现文本要点 | 代码事实 |
|---|---|---|
| `:37-49`(文件头) | 「`.claim-*` 只在**早于** STALE_CLAIM_MS(2s)时清;`.released-*` **无条件**清,理由:release() 已按 nonce fence 过,不存在 in-flight 态」 | ✔ |
| `:248-260`(`sweepSiblings` 上方) | 同上,并给出 v8.1/M4 的 NTFS 实测由来 | ✔ |
| `:378-386`(`tryClaimOnce` 取锁后) | 「两个前缀**不同待遇**,spec 的『无条件清扫全部 sibling』是简写」 | ✔ |

代码:`:281-289` 的 mtime 判定确实包在 `if (isClaim)` 里,`.released-*` 走到 `:290` 的 `rmSync` 无条件删除。
上一节 LOW-a(把一个错说法换成另一个)就此关闭。

### ③ `AXMEM_TEST_SEQUENCE_LOG` 双重门 + `config get` 退出码 —— **闭合**

`0c7e1cf`。

- `adapters/hermes/bridge.cjs:236` 改为
  `const _seqLog = process.env.AXMEM_SELFTEST === '1' ? process.env.AXMEM_TEST_SEQUENCE_LOG : undefined;`
  —— 与 `:163` 的 `AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE` 同款双重门;新增自测 #14 单独证明「只设 SEQUENCE_LOG、不设
  `AXMEM_SELFTEST=1` ⇒ 根本不写日志文件」。**亲跑** `node adapters/hermes/bridge.cjs --self-test`:
  ```
    ok   12 (Opus M2) real pre_llm_call: observable call sequence proves stdout.write() happens strictly before commit()
    ok   13 (Opus L4) AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE without AXMEM_SELFTEST=1 is inert (fake gate script never invoked)
    ok   14 (Opus incremental-closure LOW-b) AXMEM_TEST_SEQUENCE_LOG without AXMEM_SELFTEST=1 is inert (no sequence log written)
  bridge self-test 16/16      rc=0
  ```
  (#12 仍在,说明加双重门没有把 M2 的顺序断言弄成空过。)

- `bin/axmem:324-347` 的 `config get` 改为**绕过** `axmem_cfg` 的 `|| printf` 兜底,直接调
  `node "$ROOT/lib/prelude.cjs" get`,取其真实 `$?`;失败时仍打印默认值,但以该 rc 退出。
  **注入一次库层失败亲跑**(丢弃副本里把 `lib/prelude.cjs` 的 `get` 分支改成 `process.exit(7)`):
  ```
  ### baseline (healthy library layer) ###
  1
  rc=0
  ### injected library-layer failure ###
  42
  rc=7   <-- 非零,且默认值仍照常打印
  ```
  上一节 LOW-b 两半就此关闭。

## 本批新引入的遗留(不阻断)

### LOW-c — `check_new_path_or_skip` 的跳过谓词只看 before,漏掉了 `check_iso` 明确保留的「泄漏」分支

`tests/full-env-isolation.sh:86-91`:

```sh
if [ "$before" = "__AXMEM_ABSENT__" ]; then
  skipped=$((skipped + 1)); lines+=("  SKIPPED …"); return
fi
```

它的注释说「mirrors check_iso()」,但 `tests/isolation-real-configs.sh:41-45` 的 `check_iso` 是
`if [ "$before" = "absent" ] && [ "$after" = "absent" ]`,并在自己注释里点名保留了另一半:
**before=absent 而 after 出现文件 = 隔离真漏了,是违规不是跳过**。

后果(窄但真实):若隔离泄漏并在一个**基线不存在**的路径下创建了 AxMem 形状的新路径,
`comm -13` 会把它算成 new(因为 before 侧只有 `__AXMEM_ABSENT__` 这一行),`$new_paths` 非空——
但函数在看 `$new_paths` 之前就已 `return`,于是记 SKIPPED,`ok + skipped` 仍等于 6,**rc 0**。
换句话说:这条断言现在能抓「基线存在的目录被写」,抓不到「基线不存在的目录被新建出来」。

**改法(一行)**:`if [ "$before" = "__AXMEM_ABSENT__" ] && [ -z "$new_paths" ]; then`
——与 `check_iso` 口径对齐,SKIPPED 仍只用于「两端都没有东西」的真·无可验证情形。

## 亲跑清单(原文)

```
HEAD = 0c7e1cf188e696b1bb2c7b44f2a0acd7a7cc7d78 ; git status --porcelain 跑前跑后均空
bash tests/full-env-isolation.sh --self-test  (隔离跑法)    -> 4/6 ok, 2 skipped, rc 0
bash tests/full-env-isolation.sh --self-test  (真实 HOME)    -> 6/6 ok, 0 skipped, rc 0(真扫 /c/Users/<user>/.claude 与 /c/Users/<user>/.codex)
node adapters/hermes/bridge.cjs --self-test                  -> 16/16, rc 0(#12/#13/#14 全绿)
bash bin/axmem config get '$schema_version' 0                -> "1", rc 0
bash bin/axmem config get '$schema_version' 42（注入 prelude.cjs get 分支 exit 7)-> "42", rc 7
lib/lock.cjs :37-49 / :248-260 / :378-386 三处注释 vs :281-290 代码 -> 一致
# 丢弃副本已删;真实仓库工作区仅本审计文件被改
```
