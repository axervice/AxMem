# AxMem P1 收口 spec v8.1(建后修订):Hermes 桥接器(检测 + 下一轮纠正,best-effort 投递)、generic 适配层、安装器生命周期、CC 接线补漏

状态:**v8 = v7 + 第 7 轮最小改动,codex 判 GO-WITH-CHANGES(`review-20260916T222421Z`,0H/1M/2L),可建**;v8 改动:持锁者无条件清扫全部 sibling `.claim-*`/`.released-*`(只有正式 `<lock>/` 的 owner 才适用 D9);事件全集加 `lock-sweep-failed`;新增「claim 后 owner 缺失/截断即崩溃 ⇒ 下一持锁者清零」与「清扫删除失败 ⇒ 记账且互斥不变」测试;`fbeefd3` 改称实现基线。**建造者报告必须逐条实证 §9 的七条。** v7 2026-09-16 18:50;v6 第 6 轮 `review-20260916T221417Z`(1H/2M,NO-GO)主脑全收:删除测试节残留的「torn 锁 60 秒回收」(r6 H1);落盘全部移入锁内,磁盘高水位硬上限成立(r6 M1);claim/released 目录有界清理 + Windows 进程启动时间取法(r6 M2)。v5 第 5 轮 `review-20260916T220245Z`(1H/2M,NO-GO)主脑全收:锁身份随 claim 原子发布 + 只按可证明已死回收 + fencing(r5 H1);队列全部目录移动进准入锁、quarantine 计入上限(r5 M1);恢复矩阵去「任意」行、COMMITTED 只在 current=new 收尾(r5 M2)。审查链:v1 `review-20260916T205639Z`(7H/4M)→ v2 `…211144Z`(5H/3M)→ v3 `…213740Z`(2H/2M)→ v4 `…215010Z`(1H/1M/1L),全部 NO-GO,主脑每轮全收。v5 对第 4 轮的处置:**队列投递承诺降为 best-effort**(单向 stdout 无接收确认,at-least-once 与只注入一次不可兼得,r4 H1);配额预留先于 incoming 落盘;restore 身份承诺收窄为「路径 + 内容字节」、锁以 mkdir 原子 claim、恢复矩阵枚举(r4 M1);修订折回正文、删失效测试(r4 LOW)。仓库 `C:/Users/<user>/Desktop/axmem`(main;**实现基线 = `fbeefd3`**,即 §3「core 不退化」的输出快照基线;当前 HEAD 以 `git log` 为准,派发 prompt 钉 SHA)。建造者仍须自己复核每条事实,核不到写 UNKNOWN。

## 0. 事实基线(出处见审查链;只列与设计直接相关的)
- 代码只消费 `adapters.claude_code.settings_json`、`adapters.codex.agents_md`;`install.sh` 只 `--claude-code`;doctor 只查 CC;`uninstall/upgrade/restore` 不存在;`migrate --backup` 无 manifest(`bin/axmem:84`)。
- CC `merge-hooks.cjs` 去重按「group 内任一 command 含 `axmem`」(:39-42),会吞掉新加条目。
- core 只解析顶层 `memory_dir`/`AXMEM_MEMORY_DIR`(`prelude.sh:29`、`prelude.cjs:36`);`prelude.sh` 被 source 即建 state dir(:53),继承的 `AXMEM_*` 优先于 HOME(:16,:29)。
- `core/write-gate.sh`:读固定 `AXMEM_MEMORY_DIR`(:23,:26);快路径路径判定是大小写折叠子串(:203-214);**违规时文本走 stderr + exit 2,stdout 无 `additionalContext`**(:315-317);成功时写 baseline(:289,:319)。`write-echo.cjs` 只在 gate 干净通过后由 gate 调用(:321),输出 CC 形状(:59)。`trigger-recall.cjs` 只认 `Edit|Write|MultiEdit|NotebookEdit` 与 `file_path|notebook_path`(:17,:31)。
- Hermes shell-hook(`hermes-agent/agent/shell_hooks.py`、`hermes_cli/plugins.py`):matcher 对 `tool_name` 正则 fullmatch(:225);**exit 2 只在 `pre_tool_call` 阻断,其他事件只 warning**(:55,:169,:693);`{"context"}` 只对 `pre_llm_call` 有注入承诺(:777);**Hermes 在子进程退出后由 `communicate()` 取完整 stdout,再解析、再注入**(:588,:611,:627,:816;plugins.py:5082)——**没有接收确认通道**;非零退出仍解析有效 stdout(:707,:716);未批准 hook 跳过 + warning(:298);接受渠道:TTY 逐条 / `HERMES_ACCEPT_HOOKS=1` / `hooks_auto_accept: true`(:1036);`session_id` 与 `parent_session_id` 已合并为单一输出字段(:739,:748),跨事件稳定性与事件相对顺序 **UNKNOWN**;`tool_input` 是未转换的 `args`,写工具完整 schema **UNKNOWN**(:744,:747);shell-hook 无专用注入字节上限(:569,:589,:816),有效上限 **UNKNOWN**;Hermes 用 Python `expanduser`,`USERPROFILE` 必设(:549);`get_hermes_home()` 定义不在已读范围(:827)。hook `timeout` 缺省 10 秒。
- `adapters/codex/wire.sh` 无 backup/dry-run、begin 无 end 丢余文、围栏含日期、跨目录 mv(:16,:18,:21)。`FINGERPRINTS.tsv` 含 `bin/axmem`、`core/*`,改动须 `fingerprint refresh "<reason>"`(`core/fingerprint.sh:45`)。
- Git Bash 无「交换两个非空目录」的单操作;Node `fs.rename` 不承诺崩溃持久性;断电级 `fsync + rename` 在 Windows 的保证 **UNKNOWN**。

## 1. 裁定
- **D1 单写者 + 单真相源**:永不读写 Hermes `MEMORY.md/USER.md/SOUL.md`;退役 `adapters.hermes.memory_md`(启动与 doctor 打显式弃用诊断);只新增 `adapters.hermes.config_yaml`;记忆目录用顶层 `memory_dir`。
- **D2 Hermes = 桥接器,enforcement 档位 `detect-and-correct`**:`post_tool_call` 上跑闸与召回、把结果排队,`pre_llm_call` 排空注入;**不接 `pre_tool_call`,P1 没有真阻断**;README/doctor/SNIPPET 三处一致。overlay 校验的前置要求记入 §7(P2)。
- **D3 同意不代办**:不改 `hooks_auto_accept`、不写 allowlist;推荐 TTY 逐条或一次性 `HERMES_ACCEPT_HOOKS=1`。
- **D4 generic = 约定级**,`enforcement=convention`。
- **D5 三档状态**:`configured / approved / active`;`active` 只在 Hermes 提供可查询的已加载 hook 列表时才报;围栏字节、allowlist 文件、直接执行命令都不是运行时事实。
- **D6 CC 补接线 + 逐条身份去重**。
- **D7 生命周期三命令进 P1**;restore 为 crash-consistent 两阶段,**不称原子**;恢复承诺 = 「下一次 axmem 命令可恢复或安全停止」,**不承诺并发 reader 看不到半态**。
- **D8 fail-open**;**core 零改动**。
- **D9 无法证明就拒绝**:YAML 上下文、tar 成员、manifest 所有物匹配、队列路由、锁归属——证明不了就 rc 3 / 记 unrouted / 拒绝并打印人工步骤。
- **D11 锁协议(新,`lib/lock.cjs`,队列准入锁与 restore 锁共用)**:claim = 先建临时目录 `<lock>.claim-<nonce>/` 并在其中写好 `owner.json`(pid、进程启动时间、host、nonce),再 `rename` 为 `<lock>/`——目标已存在则 rename 失败 = 未获锁;**锁目录存在即必有 owner,不存在 ownerless 窗口**。回收**只**在 owner 可证明已死时(host 相同 且(pid 不存在 或 该 pid 的启动时间 ≠ 记录值));host 不同或无法判断 ⇒ 不回收、按 D9 处理(队列侧 = 丢弃记账;restore 侧 = rc 3)。**不存在基于时间的回收**。**fencing**:持锁者在每次临界操作(目录 rename、journal 写、发布)前重读 `<lock>/owner.json` 并比对 nonce,不符 ⇒ 立即中止、记 `lock-fenced-abort`、不做任何写入。释放 = rename `<lock>/` 为 `<lock>.released-<nonce>/` 后删除(只有 nonce 匹配者能释放)。**清理(真正有界,v8.1 修订——Opus 验收 M4:无条件清扫在 NTFS 上与并发 claim 争用同一目录项,40 并发时 38/38 因 `claim-dir-lost-to-concurrent-sweep` 超时)**:claim 失败者立即删除自己的 `.claim-<nonce>/`;每个持锁者在锁内清扫同目录下 **mtime 早于 2 秒的** sibling `.claim-*`(正常 claim 只存活毫秒级,>2 秒即崩溃残留)与**全部** `.released-*`;**只有正式 `<lock>/` 的 owner 才适用 D9 的「无法证明不回收」**。claim 重试用指数退避 + 随机抖动(25ms 起,上限 250ms);本进程的 FILETIME 在模块加载时计算一次并缓存。清扫失败只记 `lock-sweep-failed`,且该事件必须经 `claim.events`/`release.events` 并入调用方台账(队列与 restore 两侧都可达)。**Windows 事实**:Node `renameSync` 经 libuv 调用 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`,目标为既存目录时失败——**任何 rename 错误一律视为未获锁,不看错误码**;进程启动时间无原生绑定,用 PowerShell `(Get-Process -Id <pid>).StartTime.ToFileTimeUtc()` 取 64 位 FILETIME,**存十进制字符串,不转 JS Number**;pid 不存在 ⇒ 死;命令失败/超时/访问受限 ⇒ UNKNOWN ⇒ **不判死**。缺失、损坏、不可读的 `owner.json` ⇒ 永久按 D9 处理,绝不按时间回收。
- **D10 队列投递 = best-effort(新)**:单向 stdout 无接收确认,桥接器在写完 stdout 后删除已排空记录;**桥接器在 stdout 之后、删除之前崩溃 ⇒ 可能重复注入;Hermes 在取到 stdout 之后、注入之前终止 ⇒ 可能丢失**。两者都是可接受的(纠正记录是提醒不是账本),README、doctor、台账事件名如实写「best-effort」;**不声称 at-least-once,不声称只注入一次**。同一次排空内按 `record_id` 去重。

## 2. 交付物(五件,各独立提交,顺序固定;触及名册文件的提交同批 `fingerprint refresh` + `FINGERPRINTS.tsv` + `fingerprint check` 绿)

### 2.0 `lib/fence.sh`
0/1 对完整 marker,重复/残缺 ⇒ rc 3 零写零备份;内容不含日期;同目录 staging + 原子 rename;保留权限/BOM/换行/末尾换行;`--dry-run`;写前备份到 `AXMEM_STATE_DIR/backups/`。codex `wire.sh` 迁到它(干净文件上字节不变,夹具证明)。

### 2.1 Hermes 桥接器(`adapters/hermes/bridge.cjs <event>`)
**事件表**(command 绝对路径、timeout 10;matcher 是 `tool_name` 正则 fullmatch,工具名集合由建造者从源码核实并写报告;核不到 ⇒ matcher `.*`,桥接器内按 `tool_input` 是否含可识别路径字段过滤,识别不出 ⇒ 记 `unmapped-tool` 跳过):

| 事件 | 桥接器行为 | stdout |
|---|---|---|
| `post_tool_call` | ① 正规化 `tool_input` → canonical JSON(`tool_name→Write`,路径→`file_path`);路径不在 `memory_dir` 内(realpath 后目录边界判定,拒绝 symlink/junction)⇒ 直接退出。② 跑 `axmem gate --block`(对真实目录,文件已落盘):捕获 rc 与 stderr;**rc=2 且 stderr 含 `<!-- axmem-write-gate -->` ⇒ 类型化纠正记录 `{kind:'write-gate', ts, file, excerpt(stderr 原文截 2KB)}`**;rc=0 ⇒ 无记录。③ 跑 `axmem trigger`(CC 格式):解析 stdout JSON 的 `hookSpecificOutput.additionalContext` ⇒ `{kind:'recall', ts, text}`;解析失败 ⇒ 记 `bridge-parse-error`,不入队。④ 按队列协议入队 | 无 |
| `pre_llm_call` | 排空本会话队列,输出 `{"context": "<合并文本>"}`;无记录 ⇒ 零输出 | context 或无 |
| `on_session_start` | `axmem receipt session-lamp` 文本作 `{kind:'lamp'}` 入队 | 无 |
| `on_session_end` | `axmem receipt stop-check --no-block`(新开关:只改退出码不改判定),结果只记台账 | 无 |

**队列协议**:
- 键 = `sha256(session_id)` 前 32 hex;`session_id` 缺失或空 ⇒ **不做跨事件注入**,记录写 `queue/unrouted/`(计入上限、受 TTL),doctor 报告条数;绝不落到共享文件。`session_id` 跨事件是否稳定由建造者核实(§4);不稳定 ⇒ 同样按 unrouted 处理并在 README 如实写明。
- 布局:`queue/.incoming/`(稳定,永不被 rename)、`queue/<key>/`(live)、`queue/<key>.draining-<uuid>/`、`queue/unrouted/`、`queue/quarantine/`、`queue/.admission.lock/`(目录锁)。
- **一把准入锁线性化全部结构操作**(D11 协议,`queue/.admission.lock/`,等待上限 3 秒,与 hook 10 秒 timeout 留余量):**发布、排空的目录 rename、启动恢复的目录移动、quarantine 移动、TTL 清扫、统计与准入判定全部在锁内**;锁外只允许内存序列化与读取已排空的 draining 目录;**任何落盘(含 `.incoming/*.tmp`)都在锁内**,磁盘高水位因此从不超过 2MB + 一条记录(≤ 64KB)。统计集合 = live + incoming + draining + unrouted + quarantine 的条数与序列化 UTF-8 字节(锁内扫描即一致快照);判定每会话 50 条/64KB、全局 2MB、quarantine ≤ 100 条(超出按最旧删除并记 `quarantine-dropped`);**通过才发布,不通过 ⇒ 丢弃并记 `queue-admission-dropped`**。3 秒内拿不到锁:生产侧 ⇒ 丢弃并记 `queue-lock-timeout`(不留存,硬上限成立);消费侧 ⇒ 本轮零输出;恢复侧 ⇒ 跳过本次恢复。
- 生产:锁外只做内存序列化并得到精确字节数;**取锁** → 统计(含本条字节)与准入 → 不通过 ⇒ 不写任何文件、记账;通过 ⇒ 锁内写 `.incoming/<uuid>.tmp` → close → 读回校验长度与 sha → rename `.incoming/<uuid>.json` → 发布 = rename 到 `<key>/<uuid>.json`(`<key>/` 不存在 ⇒ mkdir 后重试一次;仍失败 ⇒ 留在 `.incoming/` 待启动恢复)→ 释放锁。记录含 `record_id`(uuid)、`key`、`kind`、`ts`、`bytes`。
- 消费(`pre_llm_call`):**锁内**把 `<key>/` rename 为 `<key>.draining-<uuid>`,释放锁;锁外读取其中 `.json`(同一次排空内按 `record_id` 去重;malformed ⇒ **锁内**移 `quarantine/`,记 `record-malformed`);合并输出 `{"context"}`(单次 16KB 上限,超出截断并追加 `{kind:'truncated', dropped:n}`);**必须先把 stdout 写完并 flush,再删除 draining 目录**(v8.1 强调:`drain()` 返回 `commit()` 回调,由 bridge 在写完 stdout 之后调用;反序会把可恢复的重复变成不可恢复的丢失——Opus 验收 M1)。删除不需锁。rename 失败或拿不到锁 ⇒ 本轮零输出、不重试。**队列侧每次结构性操作(发布 rename、排空 rename、quarantine 移动、恢复移动)之前都做 D11 fencing 核对**,不符 ⇒ 中止并记 `lock-fenced-abort`(Opus 验收 H1:lib 有、产品没用)。
- 启动恢复(每个 bridge 进程开始时,**整体在锁内**,拿不到锁则跳过):`.incoming/*.json` 重新发布(走准入判定);`.incoming/*.tmp` 超过 10 分钟 ⇒ 删除并记 `queue-tmp-dropped`;陈旧 `*.draining-*`(mtime 超过 10 分钟)⇒ `.json` 移回对应 `<key>/`(按记录内 `key`),记 `draining-recovered`(**此即 D10 所述可能重复注入的来源,如实记账**)。
- 台账事件名全集:`queue-expired queue-admission-dropped queue-lock-timeout lock-fenced-abort lock-reclaimed-dead-owner lock-sweep-failed quarantine-dropped queue-tmp-dropped draining-recovered record-malformed unmapped-tool bridge-parse-error`。

**`wire.cjs [--dry-run] [--config <path>]`,YAML 保守可证明子集**:
- 优先:`hermes hooks list` 走 `load_config()` 读静态配置(建造者已核实),**用 `HERMES_HOME=<temp 副本目录>` 对原文件与候选文件各跑一次真 loader**(把候选放进 temp 的 `config.yaml` 位置),要求两次都加载成功、根下唯一 `hooks`;`hermes` 不在 PATH ⇒ 退回子集并在 doctor 报告「loader 未用」。(Opus 验收 M3:此前以「无 --file 覆盖」为由跳过,前提可反驳。)
- 子集(无 loader):**全文扫描**拒绝 `---`(首行除外)、`...`、`%` directive、任何位置的 `&anchor`/`*alias`/`<<:`/`!` tag、候选之后的重复顶层 key;**前缀扫描**(候选行之前)拒绝未闭合 flow collection(引号外 `{`/`[` 不平衡)、未闭合引号;`hooks:` 或 `hooks: {}`(允许行尾注释)须唯一、列 0、规范拼写;`hooks:` 之后到下一个非空非注释行缩进 > 0 ⇒ 非空 ⇒ 拒绝(列 0 新键 ⇒ 判空)。
- 任一条证明不了 ⇒ rc 3、零写入、零备份,打印要加的 YAML 与手动步骤。写入:保留 BOM/CRLF/末尾换行;同目录 staging + 原子 rename;写前备份;围栏 `# axmem:begin` / `# axmem:end`。

**doctor `hermes` 段**:三档状态 + 实际加载的配置路径 + allowlist 匹配 + `hooks_auto_accept` 值(只报告)+ unrouted/quarantine 条数 + 队列字节 + 固定字样 `enforcement=detect-and-correct, delivery=best-effort` + 用合成事件 JSON 经接线命令串实跑桥接器,断言 post(零输出、队列文件出现)/ pre_llm(context 形状、目录被排空)。`install.sh --hermes`;config 键改动(D1)。

### 2.2 generic 适配层(约定级)
`SNIPPET.md` 模板 + `wire.sh <instruction-file>`(用 `lib/fence.sh`)+ `schedule.sh --print`(cron / `schtasks` 的 `axmem doctor && axmem canary`,不代执行)+ doctor `generic` 段(目录已 init、围栏存在、最近 canary 时间、`enforcement=convention`)+ `install.sh --generic [--instruction-file <path>]`。

### 2.3 安装器生命周期
- **lifecycle manifest** `AXMEM_STATE_DIR/lifecycle.json`(版本化,原子写):每个已安装适配层 `{installed_at, owner_id(uuid), targets:[{path, kind:'fence'|'json-hook', identity, expected_count:1, pre_sha256, post_sha256}]}`;`identity` = fence 的 marker 对 / CC hook 的 `{event, matcher, normalized_command}` 精确三元组。
- `uninstall [--adapter <name>|--all] [--dry-run]`:按 identity 查找,**恰好一次匹配才移除**;0 次或 ≥2 次 ⇒ 拒绝并打印人工步骤;目标当前 sha256 ≠ `post_sha256` ⇒ 拒绝(`--force` 仅在 identity 唯一匹配时按 identity 移除);记忆目录不删只打印。
- `upgrade`:只对 manifest 里已安装的适配层重跑幂等接线;先 `migrate --backup`。
- `migrate --backup` 升级为写 `manifest.json`(文件列表、sha256、格式版本、成员数、总字节)。
- `restore <backup.tar> [--dry-run]`,**crash-consistent 两阶段**:
  - ① tar 成员校验:相对路径、无 `..`(含 `\` 形式)、无绝对/盘符/UNC/drive-relative 路径、无 symlink/hardlink/设备/FIFO/sparse/PAX 或 GNU longname、无 ADS 冒号、无尾随点/空格、无 Windows 保留名、按 Windows 最终命名规则(大小写折叠)查重、成员数 ≤ 10000、单文件 ≤ 64MB、总展开 ≤ 512MB、路径长度 ≤ 240;须含 `manifest.json` 且逐文件 sha256 一致;无 manifest ⇒ 拒绝并提示先 `migrate --backup`。
  - ② 布局检查:`AXMEM_STATE_DIR`、staging、prev **不得位于 memory dir 子树内**;拒绝 symlink/junction;违反 ⇒ rc 3。解到同文件系统的 staging(uuid 唯一名),复验 sha256。
  - ③ 锁:`AXMEM_STATE_DIR/restore.lock/` 按 D11 协议 claim(身份随 claim 原子发布,无 ownerless 窗口);回收只在 owner 可证明已死;否则 rc 3 打印人工步骤;⑤ 的每次 journal 写与 rename 之前做 fencing 核对,不符 ⇒ 中止、记 `lock-fenced-abort`、两侧保留。
  - ④ 事务目录 `AXMEM_STATE_DIR/restore/<uuid>/journal.json`(版本化 JSON:`txn, phase, current_abs, prev_abs, staging_abs, old_tree_hash, new_tree_hash, nonce, ts`;每次更新 = 写 `.tmp` → fsync → 原子 rename)。**树身份 = 路径清单 + 每文件内容 sha256**;明确**不覆盖** ACL/mode/所有者/hardlink 拓扑(README 写明恢复只保护路径与内容字节)。
  - ⑤ 状态机(journal 领先文件系统一步:先写目标阶段,再做 rename):`PREPARED`(staging 复验完成)→ 写 `OLD_MOVED` → rename `current→prev-<uuid>` → 写 `NEW_MOVED` → rename `staging→current` → 写 `COMMITTED` → 删 journal、释放锁。prev 缺省**永久保留**(用户手动清)。
  - ⑥ 启动恢复(任何 `axmem` 命令开始时,含 doctor)按下表,**表外组合一律停止、两侧保留、打印人工步骤、rc 3**:

| journal.phase | current | prev | staging | 动作 |
|---|---|---|---|---|
| PREPARED | =old | 无 | =new | 从 ⑤ 继续(写 OLD_MOVED…) |
| PREPARED | =old | 无 | ≠new 或无 | 回滚:删 staging(若在)、删 journal |
| OLD_MOVED | =old | 无 | =new | rename 尚未发生 ⇒ 视同 PREPARED 继续 |
| OLD_MOVED | 无 | =old | =new | 写 NEW_MOVED,rename staging→current,继续 |
| OLD_MOVED | 无 | =old | ≠new 或无 | 回滚:rename prev→current,删 journal |
| NEW_MOVED | 无 | =old | =new | rename 尚未发生 ⇒ 继续 |
| NEW_MOVED | =new | =old | 无 | 写 COMMITTED,删 journal |
| COMMITTED | =new | 任意 | 无 | 删 journal,释放锁 |
| COMMITTED | ≠new 或无 | — | — | 停止 rc 3,不静默收尾(journal 保留供人工) |
| PREPARED / OLD_MOVED / NEW_MOVED | 与 old/new 都不等(用户已改) | — | — | 停止 rc 3 |

行与行互斥:每行的 `current/prev/staging` 条件为精确谓词(`=old`、`=new`、`无`、`≠new 或无`、`与 old/new 都不等`),同一 phase 下各行条件两两不交;建造者自测须用穷举脚本证明「任一 (phase, current 状态, prev 状态, staging 状态) 组合最多命中一行」。

- doctor 覆盖四适配层;`install.sh` 四开关齐。

### 2.4 CC 适配层补接线
`WANT` 加 PostToolUse(Edit|Write|MultiEdit)→ trigger-recall;去重按 `{event, matcher, normalized_command}` 逐项;doctor 逐条验证。夹具:「同 group 已有 gate、缺 trigger」「已有第三方含 `axmem` 字样的 command」「两条完全相同条目」「JSON 重排语义相同」。

## 3. 测试
- **隔离**(每个 E2E):先在覆写 HOME 之前对真实 `~/.hermes`、`~/.claude`、`~/.codex`、`~/.axmem`、`~/.gitconfig`、`~/.config`、`~/AppData/Roaming`、`~/AppData/Local`、`~/.cache` 与 HOME 根下文件做全树内容 hash 清单;`env -i bash --noprofile --norc`,固定 PATH,temp cwd + temp git repo,显式设置 `HOME`、`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`TMP`(native 与 MSYS 两种形式)、`HERMES_HOME`、`AXMEM_HOME/CONFIG/MEMORY_DIR/STATE_DIR` 及 trigger/receipt/canary/fingerprint 路径、`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=<temp>`、`XDG_CONFIG_HOME/CACHE_HOME/DATA_HOME/STATE_HOME/RUNTIME_DIR=<temp>`;清除 `HERMES_ACCEPT_HOOKS`;**先用无副作用命令打印并断言** Node、Git、Python(若可用)、Hermes 各自解析的 home/config 路径都在 temp 内,通过后才启动安装/E2E;结束后全树 hash 清单逐项相同。**保证边界(README 原文)**:终态 hash 只证明「最终无残留」,不证明「未发生写后删除」;后者只能一次性用户/VM、deny-write ACL 或文件系统事件审计,P1 不做。temp 下拒绝 symlink/junction。
- **fresh-HOME E2E ×4**:空 HOME → `install.sh --<adapter>` → doctor 状态与预期档一致(Hermes = `configured`)→ 合成事件经接线命令串实跑 → stdout 形状与 rc(落文件 `wc -c`)。Hermes 的 fresh HOME 预置一条能命中的 trigger。
- **Hermes 桥接器**:post(违规写入)⇒ 零输出、队列出现 `write-gate` 记录且 excerpt 等于 gate stderr 原文(trigger 关闭);紧接 pre_llm ⇒ `{"context"}` 含之、目录已排空;并发两个 pre_llm ⇒ 至多一个有输出;pre 在 post 之前 ⇒ 零输出且记录留到下一次;空 sid ⇒ unrouted 有记录、queue 无目录;超长 sid ⇒ 键仍 32 hex;并发生产者 ×8 同时发布 ⇒ 全部记录发布或按账丢弃,总字节从不超过 2MB(硬上限);锁等待超 3 秒 ⇒ `queue-lock-timeout` 且不留存;缺失/损坏/不可读 owner 的锁 ⇒ 生产侧永远丢弃记账、绝不回收(等待期间无写入);临时 `.claim-<nonce>/` 存在但未发布 ⇒ 另一方可正常 claim;持锁者核对 nonce 后、临界操作前 owner 被外力替换并暂停 ⇒ 恢复后的下一次临界操作前核对中止(fencing 在每次临界操作之前);claim 失败者的 `.claim-*` 立即消失;注入 release 后崩溃 ⇒ 下一次持锁清扫后 `.released-*` 为 0;**注入「claim mkdir 后、owner 缺失或截断时崩溃」×N ⇒ 下一持锁者清扫后 `.claim-*` 为 0 且无双持**;注入清扫删除失败(只读目录)⇒ 台账出现 `lock-sweep-failed` 且互斥结果不变;**stdout 之后、删除之前崩溃**(注入模拟)⇒ 10 分钟后恢复重发布、台账有 `draining-recovered`(如实记录可能重复);`.incoming/*.json` 残留 ⇒ 启动恢复重发布;`.tmp` 残留超 10 分钟 ⇒ 删除记账;malformed ⇒ quarantine。
- **幂等**:每个 wire 跑两次字节相同;跨日重跑相同。
- **YAML**:接受态(干净文件、`hooks: {} # c`、CRLF、BOM、无末尾换行)结果字节等于预期;拒绝态(非空 block mapping 含注释、重复 key、残缺围栏、多 document——分隔符分别位于候选之前与之后各一例、候选之后的 `...`、多行 flow mapping 内的列 0 `hooks:`、未闭合引号、行内 `key: &a`/`<<: *a`、`!!str` tag、候选之后重复 key、directive)rc 3 / 字节不变 / 零备份。
- **生命周期**:uninstall 只移除所有物、保留用户后加 hook;identity 0 次或 2 次 ⇒ 拒绝;目标被改 ⇒ 拒绝;恶意 tar 每种形态各一例 ⇒ 拒绝且现目录不变;旧格式 tar ⇒ 拒绝;**restore 恢复矩阵每行各一例**(注入 journal + 目录状态)+ 矩阵互斥穷举脚本 + `COMMITTED` 且 current 缺失/第三态 ⇒ rc 3 + journal 半写(截断)⇒ 停止 rc 3 + 锁 owner 死/活两种 + **活 claimant 在 claim 后暂停超过 60 秒**(用暂停的子进程模拟)⇒ 第二方**不得**获锁、按 D9 处理 + **fencing**:持锁者的 owner.json 被外力替换 ⇒ 下一步临界操作前中止、记 `lock-fenced-abort`、两侧字节不变 + 恢复时 current 内容已被用户改动 ⇒ 停止 rc 3 两侧保留 + state dir 嵌套在 memory dir ⇒ rc 3 + prev 同名 ⇒ uuid 不覆盖。
- **队列硬上限线性化**:生产者统计期间并发排空/恢复移动目录(用锁内注入延时模拟)⇒ 因移动也持锁而串行化,总字节从不超过 2MB;**40 个生产者各 64KB 并发**(在取锁前设屏障同时放行)⇒ 磁盘高水位每 10ms 采样从不超过 2MB + 64KB,超额者全部 `queue-admission-dropped` 或 `queue-lock-timeout` 记账;malformed 移入 quarantine 后继续压满 ⇒ quarantine 计入,总字节仍不超 2MB,quarantine 超 100 条按最旧删除并记账。
- **core 不退化**:三组件自测项数 ≥ 现值;CC 形状输出字节等于 `fbeefd3` 基线。
- **变异臂**(各一,断言对应 E2E 翻红):doctor Hermes 段恒 green;matcher 改错;正规化映射删除;post→pre_llm 转运删除;gate stderr 标记判定删除;队列键改用原始 sid;准入检查移到落盘之后;allowlist 判定恒真;YAML 文档级扫描删除;CC 去重恢复「任意 axmem 字样」;identity 匹配改为「首个」;恢复矩阵表外组合改为继续;树 hash 改为只比路径;继承真实 `AXMEM_STATE_DIR`;继承真实 `XDG_CONFIG_HOME`;cwd 指向真实仓库。

## 4. 建造者必须从源码核实(报告逐条给文件:行号;核不到写 UNKNOWN)
1. Hermes 写文件类工具的 `tool_name` 集合与 `tool_input` 路径字段。
2. Hermes 是否有配置校验/加载命令、是否有已加载 hook 查询接口。
3. `session_id` 跨 `post_tool_call → pre_llm_call` 是否稳定;一轮内两事件的相对顺序。
4. gateway/cron 下未批准 hook 的处理是否与 TTY 一致。
5. `get_hermes_home()` 的解析规则。
6. Windows 上 `fs.mkdirSync` 作为原子 claim、`fs.renameSync` 目录改名的失败形态(句柄占用、跨卷)。

## 5. 硬约束
`git add <具体文件>` 绝不 `-A`;提交前 `git diff --cached --name-only`;`git commit -F <消息文件>`,绝不 `--no-verify`;五件各独立提交,末尾 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`;取退出码不经管道;夹具用 Write 工具、路径正斜杠;不碰 `hooks/`(legacy)与 `guards/`;不读不写 `~/.hermes/memories/`、`~/.hermes/SOUL.md`;不写真实 `~/.hermes`、`~/.claude`、`~/.codex`;不 push;报告开头自估时长、每件红→绿实证、§4 六条核实结果、变异臂翻红原文。

## 6. 不在本轮
活体 PMM 守卫回移(等 M 阶段稳定)、sanitizer 与公开评审(回移后)、`hooks/` legacy 裁决、Hermes skill 机制、PowerShell/其他 agent hook 形态、端到端 at-least-once(需 Hermes 侧确认通道)。

## 7. 待办:P2 Hermes 真阻断(overlay)的前置要求
完整 memory 快照并替换目标文件;`AXMEM_MEMORY_DIR/STATE_DIR/GATE_BASELINE` 全部指向隔离副本;传副本内路径;真实目标先 realpath + 目录边界 + 拒绝 symlink/junction;patch 类工具须在快照上严格应用 hunk(旧 hash/编码任一不确定 ⇒ `overlay-unavailable`);测试须同时断言真实 memory/state 字节不变、候选是唯一新增违规、gate 确实扫描了 overlay。任一未满足不得开建。

## 9. 建造者报告必须逐条实证(codex 第 7 轮列出;缺一不验收)
1. 缺失/损坏的**正式锁** owner 永不回收;活 owner 暂停超过 60 秒时第二方不得获锁。
2. 未发布 claim 不阻塞获锁;完整、缺失、截断 owner 的残留 `.claim-*` 均由下一持锁者清零,且没有双持。
3. fencing 在「先核对、暂停、owner 被替换、恢复」序列中,于临界写前再次核对并中止。
4. Windows 两个并发目录 claim 至多一个成功;任意 rename 错误均判定为未获锁。
5. Windows 存活检测分别证明:同 PID/同 FILETIME 为活、明确无进程为死、访问拒绝/超时/非预期失败为 UNKNOWN;FILETIME 全程十进制字符串,不经过 JS Number。
6. 40×64KB 屏障测试报告实际峰值、采样间隔、成功/丢弃/超时数量,峰值 ≤ 2MB + 64KB。
7. claim/released 清扫失败产生 `lock-sweep-failed`,互斥结果不变。
## 10. v8.1 建后修订(2026-09-16 22:00;三审:ECC typescript NO-GO 2H/7M/4L、ECC security GWC 1H/1M/4L、Opus 验收 GWC 4H/5M;主脑全收)
- **spec 侧改动**(本版):D11 清扫只清 >2 秒陈旧 claim + 退避抖动 + FILETIME 缓存;`lock-sweep-failed` 必须可达;队列侧 fencing 明写;drain 先 stdout 后删;YAML loader 用 `HERMES_HOME=<temp>` 真跑。
- **隔离与 E2E 夹具进仓库**(Opus H4):spec §3 的 `env -i` 隔离 E2E、fresh-HOME ×4、三条继承真实环境的变异臂,全部落 `tests/` 并进 `bin/axmem selftest` 名册;不在仓库 = 未完成。
- **`bin/axmem selftest` 必须遍历本仓库全部 `--self-test` 入口**(lib/adapters/lifecycle 的 .cjs 与 .sh),不只 `core/*.sh`。
- **每条边界/上限断言须报告「离触发多远」**(Opus lesson 1):峰值/上限类断言的输出里带实测值与上限的比值;比值 <10% 视为未实证。
- 修复清单原文见 `docs/audits/OPUS-2026-09-16-p1-acceptance.md` §最小改动、ECC typescript/security 报告(主脑转录于修复派发 prompt)。
## v8.2 修订(2026-09-17 02:25;主脑按 Opus 复审验收 M5 裁定;覆盖 §3 隔离清单对应句)
- §3 隔离 E2E 的落地范围钉为:fresh-home 臂同时覆写 `HOME`/`USERPROFILE`/`HOMEDRIVE`/`HOMEPATH`/`APPDATA`/`LOCALAPPDATA`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`HERMES_HOME`;`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`;temp cwd + temp git repo;启动前用无副作用命令打印并断言 Node / Git / Hermes 各自解析的 home/config 路径都在 temp 内;结束后对真实 `~/.claude`、`~/.codex`、`~/.hermes` 做全树 hash 清单两端比对,基准在覆写环境之前取,基准不存在时报 SKIPPED 不计 ok。
- **不做 `env -i bash --noprofile --norc`**:Git-Bash 下 `env -i` 会打掉 PATH 与 MSYS 变量,以固定 PATH 的显式导出替代;这是对 §3 原文的正式降级,理由记于此。
- `core/precommit-gate.sh` 自测在 `TMPDIR/TEMP/TMP` 导出时 6/8 误红(`fbeefd3` 起既有,`git diff 79e95e7..HEAD -- core/` 为空):P1 维持 D8「core 零改动」,`bin/axmem selftest` 对该组件标 report-only 并打印已知说明;core 修复另开。

- **v8.2 补注(2026-09-17 10:5x)**:`core/precommit-gate.sh` 自测 TMPDIR 误红根因已修(`c94d241`):`relmem()` 里 `$TOP` 经 git 给出的盘符路径落在 MSYS `/tmp` 挂载点下时被解析成 `/tmp/...`,与 `mktemp -d` 原始 POSIX 路径不匹配,前缀剥离静默失效;修法 = `mktemp -d` 后 `cygpath -m` 归一;四种 TMPDIR 拼写各 8/8,`bin/axmem selftest` 33/33 已恢复计分。上文 report-only 处置作废。
