# 修复简报 v2.9:Bash 管道闸 v2(codex 代码审 + 盲攻 + codex spec 审 ×3 + Opus 整包审 ×4 + Opus runner 修复轮全并入;§11–§17 修订覆盖前文冲突处)

状态:**v2.10 2026-09-17 00:40,第 8 轮 GO-WITH-CHANGES(0H/2M/6L),runner 末次小补后开建**;第 8 轮 `audits/OPUS-2026-09-16-pipe-gate-v2.9-round8.md`:第 7 轮十四条全部真闭合、无新 HIGH;MEDIUM-1(§5 旧公式句)已订正,MEDIUM-2 + LOW-1/3/4 派回修复者,LOW-2/5/6 落契约 v2.10;第 7 轮 `audits/OPUS-2026-09-16-pipe-gate-v2.8-round7.md`(3H/5M/6L,NO-GO,三条 HIGH 均定点改:D17 同段两 operand 同 impression 必红、L15b 并发 Pre 换了 id 与命令等于空跑、一段同中 A/B 的 instance 未定义)—— 主脑全收 → 契约 v2.9 + §17;runner 侧 H2/M1–M5/L1/L3/L6 派回修复者;runner 修复轮(Opus,`e9143fe`/`6f91d0f`,`--self-check` 十段全绿,每条修复用「装回缺陷」反证)提出三条契约缺陷,主脑三条实测后全收 → 契约 v2.8 + §16;第 6 轮 `audits/OPUS-2026-09-16-pipe-gate-v2.6-round6.md`(6H/11M/4L,GO-WITH-CHANGES,6 HIGH 阻断):judge 返回形状与预注册变异模块不一致、L09 探测串是已删文本、`redirects[].target` 修订 ⑤ 与 ② 互斥、blind 不变换 row-count、pending 计数全局、blind 轮 sentinel 用基线期望——主脑全收;v2.7 = 解析器修订 ⑥ + 契约 v2.7 + §15;runner 修复改派 Opus(五轮 Sonnet 迭代未收敛,信任根);第 5 轮 `audits/OPUS-2026-09-16-pipe-gate-v2.5-round5.md` 判 GO-WITH-CHANGES(6H/12M/5L,6 HIGH 阻断),第 4 轮的两个死结已解;v2.6 = 解析器修订 ⑤(PIPESTATUS 例外、重定向目标对象形状、调用粒度、flat 判据正文)+ 契约 v2.6(事件全集显式、无 `events` 键即空集、receipt-lost 归属、Z22 行为化、Z15 只导出 judge、L20 pending-conflict、`pending-expired` 进枚举、自测汇总行、derivation/probe_rule 文本同步)+ 本文 §5/§12 订正。审查链:codex 代码审 `review-20260916T200154Z`(NO-GO)→ 盲攻 → codex spec 审 `…204216Z`(6H/5M/1L)→ `…212149Z`(5H/7M/1L)→ `…231428Z` 整包(6H/2M/1L)→ Opus 整包 `audits/OPUS-2026-09-16-pipe-gate-v2.4-round4.md`(11H/12M/4L,NO-GO),主脑每轮全收。v2.5 = 解析器修订 ④(放弃段数冻结、切段判定表)+ 契约 v2.5(impression_id 加 gate-instance、处置映射表、L10/L11 数字、Z15 改口径、Z19–Z22 seam 负例与纯生产正例、步骤语法严格)+ §5 台账 21 列/枚举照抄附录 A + §11.4 seam 硬条件。v2 经 codex 审(`review-20260916T204216Z`,6 HIGH + 5 MEDIUM + 1 LOW,NO-GO)主脑全部收下,本版逐条落实,每处标 [审:编号]。范围**限定 Bash 工具的 PreToolUse/PostToolUse**;PowerShell 工具见 §10 [审 MEDIUM-5]。
仓库根 `C:/Users/<user>`,现役 `.claude/guards/bash-pipe-exitcode-watch.sh`(`0906408`)。前置文档:解析器契约 `specs/PMM-CMD-PARSE-CONTRACT.md`(v1.2)、**预注册测试契约 `specs/pipe-gate-v2-test-contract.json`(主脑先行提交,建造简报钉其 commit SHA;建造者不得改,验收比对 blob)** [审 HIGH-6]。缺陷证据:codex `review-20260916T200154Z`、盲攻 `audits/AUDIT-2026-09-16-pipe-gate-blind-attack.md`、主脑复现脚本 `verify-codex-pipe-gate.sh` / `verify-blind-pipe-gate.sh`。

## 0. 四个类与 23 项分类矩阵 [审 HIGH-1]
类 (a) 用 PreToolUse 文本推断「已发生」;(b) 台账无幂等键、记账时点错、两套契约;(c) 自带正则分词与语义脱节;(d) 本体现写临时 JS、异常面漏输出。
每项标 `fixed`(测试契约里有固定用例)/ `unsupported-but-counted`(解析器明确记 unsupported,不当 miss)/ `deferred`(§10,写明理由)/ `control`。

| 来源 | 项 | 分类 | 测试契约用例 |
|---|---|---|---|
| codex 代码审 | HIGH-1 posthoc 把后置/未执行重定向当既成事实 | fixed | D08 D09 D10 L01–L05 |
| codex 代码审 | HIGH-2 台账无幂等、emitted 记早、未转义、多行拼写 | fixed | L09 L10 L11 Z10 G01 G03 |
| codex 代码审 | MEDIUM-1 状态文件无锁读改写、nosess 归并 | fixed | L06 + §4 只追加、无 session ⇒ 不关联 |
| codex 代码审 | MEDIUM-2 shadow 非零输出、miss 写状态 | fixed | Z01 Z02 Z06 Z07 Z08 |
| codex 代码审 | MEDIUM-3 六处边界 | fixed | A02 A05 A06 B04 B05 D06 D07 |
| codex 代码审 | MEDIUM-4 变异强度、命令替换吞换行 | fixed | §6 三变异体 + 字节级 |
| codex 代码审 | LOW-1 TTL 边界 | fixed | L07 L08 |
| 盲攻 | H1 双引号内 `"$?"`、`rc="$?"`、`${?}` | fixed | A02 A03 A04 |
| 盲攻 | H2 只看第一个 `$?` | fixed | A12 |
| 盲攻 | H3 D 门对 MSYS/引号/变量路径是死的 | fixed(**限字面路径 + 同命令赋值展开子类**)[审 HIGH-3] | D02 D03 D04;其他变量 ⇒ D05 unsupported-but-counted |
| 盲攻 | H4 session_id 为顶层会话、子代理共用;夹具行进生产台账 | fixed(agent 列做分层,**分析单位仍 session×class**)[审 HIGH-5] | L06 G02 |
| 盲攻 | H5 B 漏裸/-c/-n +N/-$N/`\|&` | fixed | B01 B02 B03 B04 B11 |
| 盲攻 | M1 pipefail 变体与整串豁免 | fixed | A06 A07 A08 A09 A10 |
| 盲攻 | M2 heredoc 正文竖线、`[[ =~ (a\|b) ]]`、`case a\|b)` | fixed / unsupported-but-counted | A18 / A19 |
| 盲攻 | M3 heredoc 撇号失同步 | fixed(解析器 heredoc 正文跳过) | A18 |
| 盲攻 | M4 `\| tee/sort/jq` 算截断 | fixed | B06 B10 |
| 盲攻 | M5 状态文件撕裂后被 `{}` 覆盖 | fixed | Z07 + §4 |
| 盲攻 | M6 自测 D 例全幸福路径、`$(…)` 取值 | fixed | §6 |
| 盲攻 | M7 PowerShell 工具零覆盖 | **deferred**(§10:需 PowerShell hook 输入形态) | — |
| 盲攻 | M8 prose/heredoc 的 `>` 当重定向、状态被垃圾占满 | fixed | Z08 + 解析器 `target_kind` |
| 主脑 | F13 candidate 在 intervene 也输出 | fixed | D01 B12 |
| codex spec 审 | 负号 `! a \| b`、`x=$(a \| tail)` | unsupported-but-counted | A17 A22 |
| codex spec 审 | `cmd \| head \| cat` 中段 head | fixed | B07 |

## 1. 结构 [类 d;审 MEDIUM-1]
- 本体 `bash-pipe-exitcode-watch.cjs`(PreToolUse 与 PostToolUse 同一文件,按 `hook_event_name` 分派);`bash-pipe-exitcode-watch.sh` 改为薄包装:`command -v node >/dev/null 2>&1 || exit 0`(**不消费 stdin**);然后 `exec node "$DIR/bash-pipe-exitcode-watch.cjs" 2>/dev/null`(启动级 stderr 统一抑制;`--self-test` 直接跑 node 看得见错误)。settings.json 现有 PreToolUse 接线路径不变;新增 PostToolUse(matcher=Bash)一条,样式照抄现有 PostToolUse 行。
- 不再 mktemp、不再 heredoc 写 JS。stdin 关闭 / NUL / 坏 JSON / 空 / 台账不可写 / node 抛错:stdout 0、stderr 0、rc 0,全部在 .cjs 内 try/catch 收口。
- 镜像 `_local-config/`;`pmm-fingerprint.sh refresh`;guard-change 收据;金丝雀名册项名不变、EXPECTED 按新增守卫数调整。

## 2. 分词:只用 `pmm-cmd-parse.cjs` v1.2 [类 c;审 HIGH-2]
- 消费者以 `parser_version === '1.2'` 精确匹配;不匹配 ⇒ 记 `unsupported:parser-version`、零输出。  ← **v2.18 撤销此句(fab L11):闸不查解析器版本,契约是唯一真源;blind 变异体依赖版本列原样抄写。**
- 三个 gate 只用 `segments[].{scope_id, pipeline_id, pipeline_position, pipeline_length, negated, exe, sub, args, assignments, redirects[], status_refs[], shell_option_changes[], group, parse_status, sep_before}`;不从 args 二次推断 `$?`/`pipefail`(结构化字段已给)[审 MEDIUM-2]。
- 判定只在 `scope_id==='root'` 进行;内层 scope 的段(解析器给 ok + scope_id,见解析器契约修订 ② 第 9 条)由**闸**记 gate 级事件 `unsupported:nested-scope`,解析器不替闸做决定。任一涉及段 `parse_status` 非 `ok`、或 `negated`、或位于 `group` 内 ⇒ 该 gate 记 `event_kind=unsupported`,不当 miss。

## 3. 三个 gate 的判定规则(按段) [类 c]
- **A `exit-status-masked`**:对**每一条**管道(同 `pipeline_id`,`pipeline_length ≥ 2`)独立判 [盲攻 H2]:设其尾段为 S[k];S[k+1] 存在、`sep_before ∈ {';','newline','&&','||'}`、`status_refs` 含 kind `$?` 或 `${?}` 且不含 `PIPESTATUS`;且 pipefail 状态为关。**pipefail 状态机**:按文本序累计 S[0..k-1] 的 `shell_option_changes`,`option==='pipefail'` 最后一次的 `on` 决定(`set -o/-eo/-euo/-o errexit -o pipefail` ⇒ 开,`set +o pipefail` ⇒ 关)。置信度 `recurrence`(直接命中)。
- **B `verification-output-truncated`**:任一段 `exe ∈ {head, tail}` 且 `sep_before ∈ {'|','|&'}`(**不限尾段** [审 MEDIUM-2];不看参数形态 [盲攻 H5];`sort/jq/tee` 不算 [盲攻 M4])。**永远 shadow**:`event_kind=would-warn`,任何模式不输出;解锁是常量,等 M1 精确率下界 > 80%。
- **D `posthoc-partial-read`**:段 `exe ∈ {tail, head}`,文件 operand = `args` 经 head/tail 选项表消费后剩余的非 `-` token(选项表:`-n N`/`-nN`/`--lines=N`、`-c N`/`--bytes=N`、旧式 `-N`、`-q/-v/-z/-f/-F`、`--`;`-` 或无 operand ⇒ 不判)[审 HIGH-2]。路径解析 = 解析器已做的同命令赋值展开 + `resolvePathArg(arg, cwd)` 纯函数(MSYS `/<盘>/x` ⇒ `<盘>:/x`;`~` ⇒ home;`.`/`..` 相对 hook cwd);`unresolved_variables` 非空的 operand ⇒ `event_kind=path_unresolved`,不判。`statSync().isFile()` 为真才判。**`cd` 只是 candidate 提示,不改基准目录** [审 HIGH-3]。置信度:
  - `candidate`:无回执证据(含同命令内文本序在前/在后的重定向、`cd` 提示、任何 UNKNOWN);**只记台账 + queue,任何模式不输出**(spec :42;F13)。
  - `recurrence`:§4 回执日志里**同 (session, agent)**、`0 ≤ age < TTL`、同一归一化路径、`class ∈ {created-nonempty, replaced-changed, appended-grown}` 的记录存在。只有它才在 intervene 输出,且 intervene 须由 §6 的分配函数给出(环境变量不解锁)[审 MEDIUM-4]。

## 4. 执行回执:Pre 快照 + Post 差分,每 (会话, agent) 只追加 [类 a;审 HIGH-4、MEDIUM-1、MEDIUM-3、LOW-1]
- **Pre**:对每个 `redirects[].target_kind==='file'` 且 `op ∈ {'>','>>','&>','2>'}` 的目标,归一化路径后记快照 `{path, op, exists, size, mtimeNs, fileId}`(`fileId` = `fs.statSync(p,{bigint:true})` 的 `dev+ino`,Windows 下即文件索引),写 `pending/<H(full_session_id, agent_id, tool_use_id)>.json`:同目录临时文件 + 原子 rename;已存在 ⇒ 比较 payload,相同 ⇒ 幂等跳过,不同 ⇒ 记 `pending-conflict` 并保留旧文件。**无重定向 ⇒ 零写入**;有重定向 ⇒ 恰好一个 pending 文件(这是被允许的观测状态,测试单独断言)[审 MEDIUM-1]。
- **Post**:找同名 pending,先原子 rename 为 `.processing` 再消费;对每个目标再 stat,分类:`created-nonempty`(之前不存在,现在 size > 0)/ `replaced-changed`(fileId 或 size 或内容指纹变化且 size > 0;**仅 mtime 变化 ⇒ candidate,见 §11.1**)/ `appended-grown`(`>>` 且 size 增长)/ `truncated-empty`(size 变 0)/ `unchanged` / `missing`;追加一行到 `receipts-<sid_sha16>-<agent_sha16>.log`:`ts<TAB>class<TAB>path<TAB>tool_use_id<TAB>rc`(单行 O_APPEND);删 `.processing`。`tool_response` 有退出码就记,**分类不看退出码**(非零但写了非空输出仍是证据)。rename 链(`> tmp && mv tmp f`)不追踪 ⇒ 后续 D 只能 candidate;PostToolUse 是否等待后台子进程 UNKNOWN ⇒ 后台写在 Post 时多为 `unchanged` ⇒ candidate。
- **读侧**:按时间窗读(文件按日轮转,读当天与前一天,过滤 `0 ≤ age < TTL`;不用固定行数)[审 LOW-1];`age < 0`(时钟回拨)一律不作 recurrence;TTL 用 `Number.isFinite`,0 表示 0。缺 `session_id` ⇒ 不做任何关联;缺 `agent_id` ⇒ 桶名 `main`。pending 超过 24h 只做垃圾回收,不承担正确性。

## 5. 台账:一个共用模块 [类 b;审 HIGH-5]
- 新建 `guards/pmm-recall-ledger.cjs`,**M0 的 `pmm-bash-impression.cjs` 与本闸同一提交内改为只调用它**(禁止照抄);导出:`COLUMNS`(表头常量)、`impressionId({session_id, agent_id, tool_use_id, trigger_or_gate_id, gate_instance_id})`(`gate_instance_id` 按 gate 种类钉死,**以 §17 为准**:A 行 `<pipeline_id>:<pipeline_id>`、B 行 `<pipeline_id>:<segment_index>`、D 行 `<pipeline_id>:<segment_index>:<operand_index>`;M0 trigger 曝光 = 段 index;observed/session-end 为空——一条命令两条管道 ⇒ 两个 impression,Opus HIGH-4;第 8 轮 MEDIUM-1 订正本句)、`eventId(impression_id, event_kind, ordinal)`、`sanitize(field)`、`writeEvent(row)`(单行 O_APPEND;**写入端不去重、不建 claims**——见 §11.3;写失败 ⇒ `write-failures.count` 追加一字节)、`writeQueue(row)`(脱敏片段 ≤120 字符,表头与附录 A 相同:`impression_id trigger_or_gate_id class_tag exe sub ts snippet`)。
- 列(v3,**与 M-SPEC 附录 A 逐字相同,21 列**):`schema_version ts sid_sha16 agent_sha16 agent_type prompt_id tool_use_id impression_id event_id event_kind gate confidence class_tag trigger_or_gate_id cmd_sha16 parser_version mode run_provenance sanitized id_missing agent_id_missing`。`event_kind ∈ {observed, eligible, suppressed, displayed, would-warn, emitted, emit-failed, recurrence-candidate, recurrence, unsupported, path_unresolved, cd-hint, pending-conflict, pending-corrupt, pending-expired, receipt-lost, session-end}`(17 个,= 契约 `conventions.event_universe`)。(gate × 处置)→(event_kind, confidence)映射以契约 `conventions.gate_disposition_map` 为准:A/B 命中 confidence=`recurrence`(B 永远只 would-warn);D 无回执 ⇒ `recurrence-candidate`/`recurrence-candidate`,有回执 ⇒ would-warn(+emitted)/`recurrence`。**`tag` 语义归 lesson/class tag;运行来源用 `run_provenance`**(`PMM_RECALL_TAG=test` 写入此列,分析可剔除但不是唯一依据)。
- `emitted` 只在 `fs.writeSync(1, payload)` 成功返回后记;失败记 `emit-failed`。`would-warn` 与 `emitted` 同 `impression_id`、不同 `event_id`。
- schema v3 轮换:旧台账整体改名 `*.discarded-<ts>`;M0 写入器同提交升级,**不允许旧写入器再写回旧列**(自测:两个钩子写同一文件后表头唯一)。
- 分析单位维持 M-SPEC 的 `session × class`;`agent_*` 列做分层与过滤,改单位须先改 M-SPEC。
- 金丝雀:生产台账不含测试契约里任何 `cmd` 的 `cmd_sha16`(金丝雀现算,不用可再生的哈希文件)[审 HIGH-5.8]。

## 6. 测试 [审 HIGH-6、MEDIUM-4]
- **测试契约先行**:`specs/pipe-gate-v2-test-contract.json` 由主脑提交(SHA 写进派发 prompt);自测 `--self-test` 读它执行;验收比对 blob 与钉住的 commit 相同。
- (本条已被 §11.4 取代:变异经 `PIPE_GATE_INJECT` seam 注入、失败集由 runner 从期望结构推导;`PIPE_GATE_MUTANT` 不存在。)
- **intervene 分配函数**:`assignment(full_session_id, class_tag)` 在 M0/M1 阶段是常量 `shadow`(M3 才改为哈希随机);A/D 的输出只看它;`PMM_RECALL_MODE` 环境变量在生产路径被忽略(Z09),自测 DI 强制 `intervene`。
- 静默断言一律落文件后 `wc -c`;生命周期用例按真实 Pre → 实际执行 → Post → 第二次 Pre 跑,断言台账精确行与 intervene payload。
- 通过 settings.json **实际接线的命令串**跑五种输入(正常/坏 JSON/空 stdin/台账不可写/unsupported)+ 一个正向(A01 经 DI intervene)。
- 金丝雀:自测 + 三变异体 + 表头一致 + 夹具哈希不在生产台账 + 契约 blob 未变。

## 7. 与 M-SPEC / M0 的接口
M0 的 impressions 由共用模块写;M0 已落地的 `observed`/`eligible` 行不变;M3 的观察窗用 `observed` 行计数。本闸的 `would-warn`/`candidate`/`recurrence` 与 M0 的 `eligible` 共用 `impression_id` 规则,同一 Bash 事件的两个钩子各自的 gate/trigger id 区分。

## 8. 交付顺序(各独立提交;前一件绿才开下一件)[审 HIGH-6、MEDIUM-4]
0. (主脑,先于建造)提交测试契约 + 解析器契约 + 本简报;派发 prompt 钉 SHA。
1. 解析器 v1.2 + 一致性夹具 + 自测 + 金丝雀登记(`PMM-CMD-PARSE-CONTRACT.md` v1.2 节)。
2. 共用台账模块 + M0 钩子迁移(含切到 parser_version 1.2)+ schema v3 轮换 + 两钩子共写自测。
3. 闸本体 .cjs + 薄包装 + Pre/Post 回执 + PostToolUse 接线 + 镜像 + 指纹 + 收据 + 金丝雀。
4. 自测执行契约 + 三变异体 + 生命周期 E2E + 全接线五输入;金丝雀红项集合按名字 ⊆ {plan-OID}。

## 9. 硬约束
不碰 `pmm-core.cjs`、`pmm-trigger-recall.cjs`、`pmm-migrate-v3.cjs`;`.claude/memory/*.md` 零编辑;不改测试契约与解析器契约(发现契约错 ⇒ 报告,主脑改并重新钉 SHA);`git add <具体文件>` 绝不 `-A`,提交前 `git diff --cached --name-only`;`git commit -F <消息文件>`,绝不 `--no-verify`;取退出码不经管道;夹具用 Write 工具、路径正斜杠;手工验证一律 `PMM_RECALL_TAG=test`;报告开头自估时长、每件红→绿实证、三变异体失败集合原文、金丝雀红项集合(按名字)。

## 10. 待办(不进本轮,写明理由)
- PowerShell 工具 matcher(盲攻 M7):本环境主 shell,但需先拿到 PowerShell 工具的 hook 输入形态;独立立项,不计入本轮覆盖率。
- 新 gate E `exit-status-consumed`(`cmd | grep x || echo FAIL`):真实类,新 gate = 新的精确率未知,M1 后按同流程立项。
- 工具级截断形态(`Read(offset,limit)`、`Grep(head_limit)`):Bash 闸看不见,M-spec 设计层备忘。
- rename 链回执、后台写等待语义:待 PostToolUse 等待行为核实后再定。

## 11. v2.2 修订(2026-09-16 18:05;codex 第 2 轮 `review-20260916T212149Z` 5H/7M/1L 全部收下;**本节条款覆盖 §0/§4/§5/§6/§8 中对应内容**)

### 11.1 回执分类按重定向算子,mtime-only 永远 candidate [审2 HIGH-3、MEDIUM-4]
- `>` / `&>` / `2>`:`recurrence` 证据 = ①之前不存在且现在 size>0(created-nonempty),或 ②fileId 变化且 size>0(replaced),或 ③size 变化且 size>0,或 ④size 相同但**内容指纹**变化(指纹 = sha256(size ‖ 首 64KB ‖ 末 64KB),Pre/Post 各算一次)。**仅 mtime 变化 ⇒ candidate**;size 变 0 ⇒ `truncated-empty` ⇒ candidate。
- `>>`:只有 size 增长或指纹变化 ⇒ `appended-grown` ⇒ 证据;零字节追加、mtime-only ⇒ candidate。
- `fileId` 只作辅助信号:记录文件系统类型(本地 NTFS / 其他 / 网络或 UNKNOWN);非本地或取不到 ⇒ 不参与判定;路径同时保存归一化路径与 `realpath`。
- 外部进程在窗口内 touch 同一文件 ⇒ mtime-only ⇒ candidate(用例 L14)。
- 分类分支优先级写死:先按算子取证据规则,任何规则不满足即 candidate;不存在通用「任一变化」分支。

### 11.2 pending 状态机 [审2 MEDIUM-3]
- 最终槽位 `pending/<H(session,agent,tool_use_id)>.json` 用 `fs.openSync(p,'wx')` 创建(create-if-absent 原子),内容含 `payload_len` 与 `payload_sha`;半写检测 = 长度或校验不符 ⇒ 视为损坏,记 `pending-corrupt` 并跳过。
- Pre 同时识别 `pending` 与 `.processing`:同键已存在 ⇒ 比较 payload;相同 ⇒ 幂等跳过;不同 ⇒ 记 `pending-conflict`,不覆盖。
- Post:rename 为 `.processing.<lease>`(lease = Post 的 pid ‖ ts);消费后写 receipt 再删。`.processing.*` 超过 1h 无 owner ⇒ GC 记 `receipt-lost` 行后删除;`pending` 超过 24h ⇒ GC 记 `pending-expired`。GC 只处理可证明无 owner 的文件。
- 用例:并发 Pre×2 同键、Pre 与 Post 交错、rename 后 receipt 前崩溃(用 `.processing` 注入模拟)、损坏 pending。

### 11.3 台账:写入端不去重,读取端去重 [审2 HIGH-5]
- 「不重」与「不漏」在无事务持久层上只能二选一,**选不漏**:每个事件一行 append,行内带 `impression_id` 与 `event_id`;**写入端不做任何去重、不建 claims**;读取端(M1 报表、金丝雀、runner)按 `event_id` 去重并统计重复率(重复率本身进报表)。
- `ordinal` 从稳定标识派生:`H(gate_id ‖ gate_instance_id ‖ event_kind)` 的序数化(v2.9 起用 `gate_instance_id` 取代 `pipeline_id ‖ segment_index`,见 §17),不用进程内计数。
- 文件名 `events-v3-<host>.tsv`(不原地轮换;旧 `pipe-gate-*.tsv`/`impressions-*.tsv` 改名 `.discarded-<ts>` 后只读);表头由首个写入者用 `wx` 创建文件时写入,后续 append;`wx` 失败(已存在)⇒ 直接 append。M0 钩子同提交切到共用模块与新文件名,旧写入路径删除。
- 可注入 root:`PMM_RECALL_ROOT` 决定 ledger/pending/receipts/queue 的根目录(只改位置不改行为),缺省 `~/.claude/.local/pmm-recall/`;自测与 runner 必须设置独立 root。
- 事件名与 M-SPEC 对齐:`recurrence-candidate`(取代本文此前的 `candidate`)、`recurrence`、`would-warn`、`emitted`、`emit-failed`、`unsupported`、`path_unresolved`、`cd-hint`、`pending-conflict`、`pending-corrupt`、`receipt-lost`、`session-end`;M0 的 `observed/eligible/suppressed/displayed` 不变。`session-end` 行由共用模块提供 `writeSessionEnd()`,接在 Claude Code 的 `SessionEnd` hook(接线属交付 ③);M-SPEC 同步附录见 `RECALL-LOOP-M-SPEC-v2.md` 末节。
- queue 表头统一为 `impression_id trigger_or_gate_id class_tag exe sub ts snippet`(M0 的 `tag` 列改名 `trigger_or_gate_id`,同提交)。

### 11.4 测试信任根:契约 + 一致性夹具 + 验收 runner + 变异模块,全部由建造者之外的人先行提交 [审2 HIGH-1、HIGH-2、MEDIUM-6]
- 交付 ⓪(非建造者:主脑 + 一名独立 Sonnet「验收作者」):`pipe-gate-v2-test-contract.json`(v2.2)、`pmm-cmd-parse-conformance.json`(逐字段期望)、`pipe-gate-v2-acceptance.cjs`(runner)、`mutants/{null,always,blind-parser}.cjs`。先提交;派发 prompt 写死 commit SHA 与四文件 blob SHA;建造者允许写面排除四者;验收比对 blob。
- runner 只走生产入口 `bash bash-pipe-exitcode-watch.sh`(与 settings.json 接线相同的命令串),输入为契约里的**结构化** hook JSON 模板(`session_id/agent_id/tool_use_id/cwd/tool_input.command`,`ABS`/`MSYS` 由 runner 替换为它自己创建的 temp 目录)、环境(`PMM_RECALL_ROOT` 指向 runner 的 temp root)、文件前后状态;自然语言步骤全部改为机器步骤(`pre/exec/post/clock` 四种操作,exec = runner 亲自写文件)。
- **DI 缝**由契约规定、建造者实现:`PIPE_GATE_INJECT=<模块绝对路径>` 仅当该路径位于 `PMM_RECALL_ROOT` 之内且 `PIPE_GATE_SELFTEST=1` 时生效;生产路径两者缺一即忽略。**seam 生效硬条件(Opus MEDIUM-5)**:`PIPE_GATE_SELFTEST=1` 且 `PMM_RECALL_ROOT` 已设且解析后 ≠ 缺省生产 root 且注入路径解析后位于该 root 内——四者缺一,闸完全忽略 `PIPE_GATE_INJECT`(不加载、不 probe、不 sentinel);契约 Z19/Z20/Z21/Z22 为负例与纯生产正例。被注入模块导出 `{judge, parse}` 之一或两者;闸本体必须把**唯一**的判定函数 `judge(parsed, ctx)` 与解析入口 `parse(cmd)` 经该缝解析。变异模块每次被调用都向 root 内 `probe.log` 追加一行;runner 断言每例的 probe 行数 ≥ 1(证明生产判定路径确实穿过注入函数),否则整轮红。
- **变异体失败集不手写**:契约只给三个变异体的精确定义(替换哪个函数、返回什么、保留哪些字段);runner 对每例按定义推导「变异后的预期结果」,与契约期望不等 ⇒ 该例应失败;实际失败集与推导集按名字相等才算过。
- `null` = `judge` 恒返回空(解析正常,回执正常);`always` = `judge` 对每个事件返回一条 A/recurrence(其余不变);`blind-parser` = `parse` 返回 v1.2 形状但 `status_refs/redirects/assignments/expansion_refs` 全空、`args` 不展开(`exe/sub/sep_before/pipeline_*/parse_status` 保留)。
- 生产隔离断言取代夹具哈希金丝雀:runner 在运行前后对生产 root(缺省路径)的 ledger/pending/receipts/queue 做逐字节 hash,要求完全不变;命令哈希只作纵深检查,不作来源判定。

### 11.5 契约自相矛盾修正与用例补充 [审2 MEDIUM-1、MEDIUM-2、MEDIUM-7、LOW-1]
- D12(`cd ABS && tail -5 existing.txt`)期望改为 **无 gate**(相对路径按 hook cwd 解析不存在;`cd` 不是证据)。Z05 改为「ledger 文件路径被目录占用、父目录可写」,`write-failures.count` delta=1;父目录本身为文件的形态另立 Z05b 只断言静默。Z09 改为 `mode: shadow` + `env.PMM_RECALL_MODE=intervene` + `di_assignment: null`,只期望 would-warn。
- 分类枚举增加 `unresolved-but-counted`(`path_unresolved` 事件);D05 归此类;矩阵中盲攻 H3 拆为「字面 + 同命令赋值 = fixed」与「其他展开 = unresolved-but-counted」两行。
- 新增用例(runner 同样从期望推导变异集):A23 `case x in a|b) echo;; esac; rc=$?`(unsupported)、A24 同段 `set -o pipefail; set +o pipefail`、A25 `rc=$?` 作 assignment-only 段、A26 反斜杠续行 `a | \` + 换行 + `b; rc=$?`(亮 A)、A27 后台管道 `a | b &`、A28 `echo "${PIPESTATUS[0]}"`(不亮)、A29 一命令两条独立管道均亮、A30 初始 pipefail 由 scope 声明为开时不亮;D15 `--lines 5`/`--bytes 5` 分离参数、D16 `-n5` 与 `+5`、D17 多文件 operand、D18 `-- -weird.txt`、D19 带空格文件名(引号)、D20 `1>`/`2>>`/`&>>`/`>|` 各一、D21 大小写不同路径同文件、D22 `${VAR:-x}` ⇒ unsupported:parameter-expansion;L12 mtime-only、L13 同尺寸覆盖(指纹变)、L14 外部并发 touch、L15 并发 Pre×2、L16 rename 后 receipt 前崩溃、L17 `age === TTL`、L18 损坏 pending、L19 损坏 receipt 行;Z12 无 session_id、Z13 无 agent_id、Z14 只输出一个换行的泄漏(字节级)、Z15 子进程捕获保真(`$(…)` 尾换行)、Z16 `echo '>'`、Z17 注释 `# > f`、Z18 heredoc prose 里的 `>`。
- 矩阵 §0 按审2 MEDIUM-1 表重分类(部分落实项写明缺的用例 id);盲攻 H4 的 G02 改为 11.4 的生产隔离断言。

### 11.6 与 M-SPEC 的同步 [审2 MEDIUM-5]
开建前 `RECALL-LOOP-M-SPEC-v2.md` 增补附录:schema v3 列表、impression/event 双 id、`trigger_or_gate_id`/`class_tag`/`run_provenance` 三个术语、事件名集合(含 `recurrence-candidate`)、观察窗终止 = `session-end` 行或 20 个 `observed`、分析单位 session×class 与 agent 分层。附录未提交则本简报不得开建。

### 11.7 解析器 v1.2 契约修订 [审2 HIGH-4]
见 `PMM-CMD-PARSE-CONTRACT.md` 末节「v1.2 修订(2026-09-16 18:05)」:赋值分 `state_assignment` / `command_prefix_assignment`、每个 arg/redirect 带 `{raw, decoded, expansion_refs[], unresolved_variables[]}`、参数展开子集、ANSI-C 引号与转义续行、`groups[]` 与闭合文法、scope 初始 option 状态、case 模式先于管道切分。一致性夹具 `pmm-cmd-parse-conformance.json` 由交付 ⓪ 预提交。

### 11.8 交付顺序(覆盖 §8)
⓪ 非建造者:契约 v2.2 + 一致性夹具 + runner + 变异模块 + M-SPEC 附录,一并提交并在派发 prompt 钉 SHA → ① 解析器 v1.2 → ② 共用台账模块 + M0 迁移 + 新文件名 → ③ 闸本体 + 回执 + PostToolUse/SessionEnd 接线 + 镜像/指纹/收据/金丝雀 → ④ 建造者自测只允许调用 runner(不另写断言)+ 金丝雀登记 runner 与三变异体。

## 12. v2.4 修订(2026-09-16 19:25;codex 整包第 3 轮 `review-20260916T231428Z` 6H/2M/1L 全收;覆盖 §6/§11.4 对应条款)
- **版本统一**:测试契约 `2.4`、解析器 `1.2`、夹具 `1.2`、runner 读契约版本并拒绝其他;本文自此称「v2.4 包」。
- **runner 职责扩到七项**(契约 `conventions.runner_duties`):执行全部用例;**执行 104 例解析器夹具**(段数精确、字段深比较)+ `flat` 变异(失败集由期望结构变换推导);调用生产 `--self-test` 并要求 rc 0;检查 settings 接线(PreToolUse Bash 两条、PostToolUse Bash、SessionEnd);检查金丝雀名册按名字含 runner/三变异体/夹具自测;检查四文件 blob 与派发 pins 相等;读侧先按 event_id 去重、每 impression 唯一 `{gate,confidence}`、再比多重集。
- **因果 sentinel 取代「probe 只证被调用」**:变异模块嵌入 runner 传入的 nonce,闸把 `class_tag`/`parser_version` 原样写台账,runner 断言 nonce 出现;`null` 以「零 gate 行且零 judge 信息事件」证明。**单一生产 handler**:baseline / 变异 / `--self-test` 都经同一导出 handler,禁止环境变量切换到另一套判定。
- **id 不可预测**:session/agent/prompt/tool_use_id 每次运行随机,不含 case id。
- **生命周期执行器规格**:clock 改写 receipts 文件行内 `ts`;receipts 位于 root(不在子目录);closed-stdout 用 `bash -c "exec 1>&-; …"` 真关闭;L15 真并发(异步 spawn + 屏障文件);L19 在正式 receipts 文件注入撕裂行并追加有效行(L19b);L11 改为 raw=4 / dedup=2 / distinct_event_ids=2 / distinct_impression_ids=1(每次 intervene 写 would-warn + emitted;写端不去重)。
- **pending key** = `sha256(session_id ‖ NUL ‖ agent_id ‖ NUL ‖ tool_use_id)`(NUL 分隔防拼接碰撞)。
- **闸的 `--self-test` 角色**(取代 §6 与 §11.8 ④ 的不一致):单元级——模块加载、五种静默输入经接线命令串字节级零输出、表头等于共用模块常量;**验收唯一 oracle 是 runner**,建造者不得另写断言;runner 把生产 `--self-test` 当一个步骤调用。
- **解析器契约修订 ③**:关键字切段算法五步优先级、版本化例外清单(M08/M09 全按开启词、M11/M19 增 wrapper 段)、wrapper 规则适用于三种 wrapper——夹具作者据此改四例;runner 作者据此实现夹具解释器。
- **矩阵 §0 状态**:在上述 executor 修好并经 codex 第 4 轮确认前,不再声称 23 项「全部钉死」;codex 点名的 8 项(代码审 HIGH-2/MEDIUM-1/MEDIUM-4/LOW-1、盲攻 H4/M5/M6/M7)标为「待 executor 修复后重验」。
## 13. v2.5 修订(2026-09-16 20:45;Opus 第 4 轮全收)
- **闸 `--self-test` 的最低内容**(Opus HIGH-9):模块加载;五种静默输入经接线命令串字节级零输出;**至少一条成功判定路径**(如 A01 shadow ⇒ 台账出现 would-warn 行)且 stdout/stderr 字节断言;表头等于共用模块 `COLUMNS`;**结束时打印一行 `SELFTEST {"load":n,"silence":n,"positive":n,"header":n}`**(契约 `conventions.self_test_summary`),runner 断言 rc 0 且各计数 ≥ 最低值。runner 不把「自测发现了问题吗」当 oracle。
- **建造者报告必须逐条实证**(Opus 第 4 轮原文,缺一不验收):三轮变异的 `derived_fail_ids` 与 `actual_fail_ids` 原文两行;`G08` 的 `conformance_passed/total` 与 `flat_mutant.sets_equal` 原文;生产 `--self-test` 在有注入与无注入两种环境下的 rc 各一次;L06/L16/L18 各自的 ledger 行原文;L07/L08/L17 回执文件被 clock 改写前后的首列 ts 原文;台账表头一行原文 + `pmm-recall-ledger.cjs` 的 `COLUMNS` 原文;不带 `PIPE_GATE_INJECT/PIPE_GATE_SELFTEST` 时 A01 的 ledger 行原文;金丝雀调用串原文(含 `--non-interactive --pins`)。
- 解析器契约修订 ④、契约 v2.5、附录 A 的 impression_id 分量已同步;夹具升 1.2.1(作者重算全部块例);runner 作者按 Opus 清单第 7–10 项 + MEDIUM-3/4/6/7/8/9/10/11/12 + LOW-3/4 改。
## 14. v2.6 修订(2026-09-16 21:55;Opus 第 5 轮全收)
- **事件全集显式化**:契约 `conventions.event_universe`(17 个,= 附录 A + `pending-expired`)与 `informational_events`(8 个);`expect.events` 是信息事件的**精确集**,无 `events` 键的用例视为空集——多写事件不再免费。
- **行归属**(`conventions.row_attribution`):`receipt-lost`/`pending-expired` 归属**原始** pending 的 tool_use_id,不归发现它的 GC 事件。
- **调用粒度**(`conventions.call_granularity`):每个 hook 事件 parse 一次、judge 一次并返回 findings 数组;probe 按调用计,sentinel 按 finding 计。
- **Z22 行为化**:HOME/USERPROFILE 重定向到 temp 使缺省生产 root 落在 temp 内,再以 `PMM_RECALL_ROOT` 未设 + SELFTEST + INJECT 断言 seam 被忽略;静态 grep 不再是 pass 项。
- **夹具 notes 机器扫描**:runner 启动时扫描夹具 notes 中的推断措辞(my own construction / by analogy / inference / 契约未述),命中即红。
- 建造者八条实证 + 第 5 轮新增三条:① L01 全部 ledger 行原文(emitted 与 would-warn 同 impression 不同 event_id,`events` 精确集通过);② A11/A28 的 ledger 行原文 + 解析器对这两条命令 `segments[2]` 原文(PIPESTATUS 例外);③ Z22 行为化断言输出原文。
## 15. v2.7 修订(2026-09-16 22:35;Opus 第 6 轮全收)
- **judge 返回形状**(HIGH-1):`{gates: Finding[], events: string[]}`,`Finding = {gate, confidence, class_tag?}`;`gate_instance_id` 由闸从 `parsed` 派生写台账,finding 不带;always 变异恒一条 finding(A29 在 always 轮必红,推导同此)。解析器契约修订 ⑥ 第 2 条同步。
- **`redirects[].target` 一律对象**(HIGH-3):修订 ⑥ 第 1 条;夹具不动。
- **契约 v2.7**:`derivation` 三分句与 `probe_rule/probe_coverage` 写死为 runner 应有行为(null 的 row-count 键置 0、always 恒一条、blind 用变异后期望判 sentinel);`pending_files` 按本例 key 计;`row_attribution` 严格无并集;Z14 `report_only`;`required_fixture_version=1.2.2`。
- **runner 修复改派 Opus**(理由:五轮 Sonnet 迭代每轮仍出 5–6 HIGH,runner 是验收信任根;档位表「Sonnet 做不了的复杂/高风险活升 Opus」);审者另派。
- **建造者必须逐条实证(第 6 轮版,取代 §13/§14 清单)**:三轮变异的 `derived_fail_ids` 与 `actual_fail_ids` 原文两行 + `sentinel_ok`/`probe_ok` 布尔原文;`G08` 的 `conformance_passed/total` 与 `flat_mutant.sets_equal` 原文;生产 `--self-test` 有注入/无注入两种环境 rc 各一次 + `SELFTEST {...}` 行原文;L06/L16/L18 各自 ledger 行原文;L07/L08/L17 回执 clock 改写前后首列 ts 原文;台账表头一行 + `COLUMNS` 原文;不带 seam 变量时 A01 的 ledger 行原文;金丝雀调用串原文(含 `--non-interactive --pins`);L01 全部 ledger 行原文;A11/A28 ledger 行 + 解析器 `segments[2]` 原文;Z22 行为化断言输出原文;**L09 的 stderr/stdout 字节数 + ledger 行原文 + runner 走 `runGateProcessClosedStdout` 的证据**;**L15/L15b/L20 的 `actual.pending_files*` 原文 + 该时刻 `pending/` 的 `ls` 原文**;**A29/L10/L11 的 actual 原文**;**任一带重定向用例的 `redirects[0]` 原文**;**judge 真实返回形状原文(一次调用的 JSON)**。
## 16. v2.8 修订(2026-09-16 22:50;Opus runner 修复轮提出、主脑复现后全收)
- **closed stdout 配方改为只读 fd 1**:`bash -c "exec 1</dev/null; exec bash <gate.sh>"`。原配方 `exec 1>&-` 对 Node 闸无效——Node 启动时把已关闭的 fd 0-2 重开到空设备,写成功、`fstat(1)` 是字符设备;本机三条实测:closed → 写成功;只读 → EBADF;`/usr/bin/printf` 在 closed 下 → EBADF。runner 自检须先用 `node -e` 预检配方在本机产生 EBADF/EPIPE,预检不过 L09 记 unscored 带理由而非红。L09 期望不变(`emit-failed`,stdout 0)。
- **always 推导撤回「intervene cases expecting stdout 0 fail」分句**:全契约只对 L09 生效,而 L09 在 always 下仍是一条 A finding → 尝试输出 → 失败 → `emit-failed`,应为绿;其他 intervene+stdout 0 用例早已因 gates 转红。runner 不实现该分句(修复者已留注释)。
- **sentinel 跳过规则措辞与 `probe_rule` 统一**:按**变异后的期望**是否零 gate 行决定跳过。
- **runner 修复轮结论**(问 2 表):A2–A5/A7 已封(反证证据在修复者回复);A8/A9 封于解析器修订 ⑥;A1/A6(L09)由本节封;B1/B2/B3/B5 已封;B4(`--self-test` 只查计数)§13 明确接受;B6 公开命令集靠盲攻覆盖(§14)。
- 版本:契约 `2.8`,runner 常量同步;其余文件不动(夹具 1.2.2、解析器契约修订 ⑥、变异模块一字未动)。
## 17. v2.9 修订(2026-09-16 23:45;Opus 第 7 轮全收;覆盖 §3/§5/§11.3 对应句)
- **`gate_instance_id` 按 gate 种类钉死**(HIGH-1、HIGH-3):A 行 = `<pipeline_id>:<pipeline_id>`(被判管道,以首段 index 标识,与修订 ② 第 10 条同源);B 行 = `<pipeline_id>:<segment_index>`(被判段);D 行 = `<pipeline_id>:<segment_index>:<operand_index>`(operand_index = §3 D 规则经选项表消费后剩余文件 operand 的 0 起序号);M0 trigger 曝光 = `<segment_index>`;observed/session-end 为空。钉死的推论:一段可同时产出 B 行与其所属管道的 A 行,两者 impression 不同(A12);同段多个文件 operand 各产一条 D 行、各自 impression(D17);两条独立管道两条 impression(A29)。契约 `conventions.impression_id`、M-SPEC 附录 A 同句、`gate_disposition_map` 的 D candidate 注同步。
- **`ordinal = H(gate_id ‖ gate_instance_id ‖ event_kind)`**(§11.3 改句),operand 级 D 行与管道级 A 行不再可能撞 event_id。
- **L15b 真正的同 key 重入**(HIGH-2):并发 Pre 必须用**原 tool_use_id 与原重定向命令**(同 key、同 payload);按 §11.4「同键已存在 ⇒ 比较 payload;相同 ⇒ 幂等跳过」,`pending-conflict`/`pending-corrupt` 都不得出现;竞争后本例 pending 计数 0 或 1 皆合法 → 新键 `pending_files_after_in: [0,1]`(契约 `lifecycle_expect_keys` 定义;parse-driven,null/always 不变、blind 重推)。runner 的 `execPostPreInterleave` 改为重入原命令与原 id。
- **MEDIUM-4 裁定**:always 分句「row-count 键按恰好一条 A finding 重算」**保留**,runner 实现之;L11 加入变异自检子集。
- **LOW-2**:L09 的 `stdout` 键删除(执行器使 stdout 恒 0,不携带信息);判别力全在 `events == [emit-failed]`。
- **runner 侧派回修复者**:HIGH-2 实现;MEDIUM-1 生产轮与变异轮也做 fd 预检(不过 ⇒ L09 report_only 带理由);MEDIUM-2 `dispositionOk`(按 `gate_disposition_map` 校验 event_kind 序列与行数);MEDIUM-3 lifecycle actual 无条件带 `stderr_size`/`rc`;MEDIUM-5 silence 已知键表 + `events` 精确集;LOW-1 `z01_read_failure_verified` 提到 report 顶层;LOW-3 全局列数断言;LOW-6 桩闸包装不再丢 stderr;LOW-5 措辞模式扩到审计给的 11 词;LOW-4 记录。
- 版本:契约 `2.9`,runner 常量同步;夹具 1.2.2、解析器契约修订 ⑥、变异模块不动。
## 18. v2.10 修订(2026-09-17 00:40;Opus 第 8 轮 GO-WITH-CHANGES 全收)
- **G10 列形状**(LOW-2):runner 已在 allPass 里断言的「每行恰好 21 列」正式写进契约 `ledger_cases` G10;Z10 用独占 state 目录,共享台账不会被它的控制字符劈行。
- **`operand_index` 基准钉死**(LOW-5):按选项消费后**全部**剩余文件 operand 的文本序 0 起编号,不存在/非文件的 operand 占号不产行;台账里的值因此与「哪些 operand 被判」无关。
- **措辞扫描四个宽泛英文词降 report-only**(LOW-6):assume/probably/likely/seems 只列报告不判红。
- **runner 侧末次小补**(派回修复者,之后钉 pin 开建):MEDIUM-2 `execSilenceCase` 统一兜底 `silenceEventsCheck`(拿不到 tool_use_id 的 Z03/Z14 显式豁免并写进 report);LOW-1 `dispositionOk` 接到 Z09/Z12/Z21;LOW-3 always 轮 sentinel 跳过规则改用变异后期望;LOW-4 L15b 交错进程的 stderr/rc 进 report(照 L15 的 `interleave_stderr_total`);契约常量 `2.10`,G10 键名 `row_column_shape`。
- 版本:契约 `2.10`(119 例);夹具 1.2.2、解析器契约修订 ⑥、变异模块不动。
## 19. v2.11 修订(2026-09-17 01:45;建造者 ① 停手报告全收)
- **夹具 1.2.3**:M 系 11 例的 `args` 是 v1.1 的 `string[]`、M03/M04/M17 的 `redirects` 是 v1.1 的 `{op,target}`,与 C/R 系的 v1.2 对象形状互斥,`compareParserExpectation` 逐键 deepEqual ⇒ 任何单一解析器都不可能 104/104;八轮审查(含两轮亲跑 part4)没人问「同一字段在各族形状是否一致」。改法:只删这 14 处 v1.1 形状的键(空数组保留),M 系只断言 v1.1 时代的结构字段;夹具自带形状一致性自证。
- **契约 v2.11**:`required_fixture_version=1.2.3`;新增 `conventions.fixture_shape_consistency`,runner 加载夹具时对全部族做字段形状断言,违反 rc 2。
- **runner**:`REQUIRED_FIXTURE_VERSION` 1.2.3、契约常量 2.11、加载期形状断言;此后再冻结,重新钉 pin,建造者 ① 续跑(同一 Sonnet,上下文在,零代码已写)。
- 教训:`process:fixture-families-must-share-one-shape`。
## 20. v2.12 修订(2026-09-17 02:35;建造者 ① 交付报告全收)
- **解析器 1.2 已落地**(`2bc8d85`,Sonnet 两阶段共 80 分钟,103/104;自测 13/13;金丝雀那行同步;指纹 109 台一致)。唯一红 `C-scope-root`:该例只有 `expect.scopes`、没有 `segments` 键,runner 把缺键当「期望 0 段」而同一命令在 C-A01 要求 3 段;且 runner 从未读过 `.scopes`——C-A30 的 scopes 断言同样是死的。
- **夹具 1.2.4**:C-scope-root 补上与 C-A01 相同的 3 段;每例必须带 `expect.segments`(加载期断言)。
- **契约 v2.12**:`required_fixture_version=1.2.4`;新增 `conventions.parser_scopes_comparison`(数量相等 + 只比期望里出现的键);`fixture_shape_consistency` 加「每例必带 segments」。
- **runner**:两个版本常量、`compareParserExpectation` 加 scopes 比较、加载期「每例必带 segments」;此后再冻结、重钉 pin;主脑亲跑 104 例应全绿(预演 scopes 比较器对 C-A30/C-scope-root 已通过),不必再派建造者 ①;直接派 ②③④。
## 21. v2.13 修订(2026-09-17 03:55;建造者 ②③④ 交付报告全收)
- **②③④ 已落地**(`b71ea78` 台账 v3 + M0 迁移;`c734da1` 闸本体 + 接线 + 金丝雀;`7776c6b`/`56cc179` 收尾;1h13m):runner `--non-interactive --pins` 108 计分例 106 绿、G01–G10 全绿、G08 104/104 + flat 相等、null/always 两轮 derived=actual、sentinel/probe 全真;settings.json 新增 PostToolUse Bash + SessionEnd(parse 通过,备份在 scratchpad);金丝雀 EXPECTED 48→52;指纹 114 台一致;manifest 零 ⛔。
- **两个红 + blind 一处差集都不是闸的缺陷**(建造者按协议停手取证,未改 runner):L19b 在共用 files 目录下与 L16/L17 写出字节相同的 12 字节 ⇒ 回执 class=`unchanged`(§11.1 四条证据规则都不适用,仅 mtime 变 ⇒ 按规则只能 candidate,而用例期望 recurrence)——契约 v2.13 钉「runner 的 write N bytes 内容按用例唯一」;Z06 用 `PATH=/usr/bin:/bin` spawn `bash` 在本机 ENOENT(MSYS 虚拟路径 Node 解析不了),闸根本没启动——契约加「受限 PATH 执行器:bash 绝对路径在收窄 PATH 之前解析」;blind 轮 L18 多出一个 derived:runner 自己合成损坏 pending 的步骤不依赖 redirect——契约 `mutants.derivation` 加澄清。三处均 runner 侧实现,派回修复者后 runner 四冻。
- 金丝雀另两红(`PMM v3 C0 影子`、`盲攻纪律`)建造者证明为登记前已红:C0 影子是 PLAN OID 不匹配(既有);盲攻纪律 = 今日 guards 提交 ≥3 次需同日盲攻——上线前安排一次 fab 盲攻(max)对闸本体与台账。
## 22. v2.14 修订(2026-09-17 04:45;Opus 建造产物验收 `audits/OPUS-2026-09-17-pipe-gate-v2-build-acceptance.md` GO-WITH-CHANGES 1H/3M/5L 全收)
- **判定逻辑无洞**:验收者五处闸体变异全按方向转红(去 pipefail → A07/A08/A10;只信尾段 → 26 例;TTL 0 → L01/L03/L13/L19b/Z12;非 wx → L20;emit 顺序 → L09);runner 108/108、三轮变异双向差集空;末四次 runner 修复独立核对闭合。三条改动全在交付完整性与纪律。
- **HIGH-1 settings.json 镜像漏 PostToolUse/SessionEnd**:实机 settings.json 被 .gitignore 排除、不在指纹册,镜像是唯一可审记录;按 RESTORE.md 恢复的机器只剩 Pre ⇒ pending 永不消费、回执永不写、D 死在 candidate、无 session-end ⇒ 静默降级。改法:镜像同步 + **新增金丝雀「settings.json hooks 段与镜像 diff 为空」**(同一个洞 `f0d79df` 时已发生过一次)。
- **MEDIUM-1 命令失败 ⇒ PostToolUse 不到闸**:Claude Code 对失败的工具调用不发 PostToolUse、改发 `PostToolUseFailure`(本机 claude.exe 与 agent-sdk 类型里均存在);接线加 PostToolUseFailure(matcher Bash)走同一包装,闸把它当 Post 处理(exit_code 缺省记 -1,回执 class 不依赖退出码);真实 root 现存 4 个此因孤儿由 24h GC 回收。契约 `lifecycle_ops` v2.14 句。
- **MEDIUM-2 informational 行的 gate 列从未被比较**(与 scopes 同族第三例):契约钉死 path_unresolved/cd-hint → D/D、unsupported → A/A、pending/receipt 族 → D/D、session-end 空;runner 对每例每条 informational 行断言两列;闸按此写;v2.14 前已落库的 220 行只按 class_tag 归属。
- **MEDIUM-3 金丝雀「盲攻纪律」**:今日 guards 提交 ≥3 次需同日盲攻,glob 为 `audits/AUDIT-2026-09-17*.md` —— fab 盲攻报告按此命名,验收后立即派。
- LOW:pins 手核栏简报 blob 刷新;简报对 wx 变异的预测用例订正为 **L20**(L15/L15b 同载荷不可区分,契约无「并发不同命令」用例,L20 已足够);G02 在临时 HOME 下 0 vs 0(契约 `g02_note`);runner `disposition` 报告 `instances[]` 让 §15 的 instance 串可复核;C0 影子红是记忆语料 OID 漂移(既有)。
- 版本:契约 `2.14`,runner 常量同步并加 informational 行断言 + instances 报告;闸与接线由建造者改;夹具/变异模块不动。
## 23. v2.15 修订(2026-09-17 05:20;codex(gf)末尾一波 `~/.codex-reviews/review-20260917T085234Z.md` 6H/2M,主脑逐条实测后全收)
- **H1 runner 对空 pins 全绿**:`checkBlobPins` 只遍历 pins 里实际有的键,`{}` 时 `every` 恒真;且哈希的是默认契约/夹具路径而非 `--contract/--conformance` 实际执行的文件。契约 G07 v2.15:pins 键集合必须精确、缺/多/空即 rc 2;哈希实际路径。(其第二段「公开命令集可被查表假闸骗过」= 既知 B6,由 fab 盲攻覆盖。)
- **H2 回执写失败仍删 `.processing`**:receipt append 被 catch 吞掉后无条件删租约,杀毒/备份/权限造成的临时不可写永久丢证据。契约 `receipt_commit_and_lease`:先 append + fsync 成功才删租约;失败保留租约待重试,只由 TTL 后 GC 记 receipt-lost。闸自测加「receipts 文件被同名目录占住」用例;契约用例 L21 排入上线后第一批。
- **H3 新租约继承旧 pending 的 mtime 被立即 GC,且不查 owner 存活**:Windows rename 保留 mtime。改法:租约龄按租约名内 claim 时间计,rename 后 `utimes` 到 claim 时间;owner pid 仍活(kill(pid,0) 成功或 EPERM)禁止 GC。
- **H4 台账写侧未在最终 writer 边界 sanitize**:`--session-end` 的 `agent_type` 含 TAB/LF 把一行撕成三行(21/6/17 列),M1 读侧丢弃碎片,观察窗永久 open。改法:`writeEvent()` 对每列统一清洗并自派生 `sanitized`;调用者清洗只是纵深。
- **H5 解析器 1.2 缺契约必填 `source_span`、纯赋值段 `args` 仍含原始赋值串,却 104/104**:夹具只比期望里列出的键。契约 `parser_mandatory_fields`:runner 对**实际输出**做完整 schema 断言(每段全部必填键与类型),与夹具是否列出无关;纯赋值段 `args=[]`。解析器补 `source_span`(1 起行列,续行按真实行号)与赋值段 args。
- **H6 G05 接线验收只查文件名子串**:`echo bash-pipe-exitcode-watch.sh` 能绿,且没查 PostToolUseFailure。契约 G05 v2.15:五个精确接线实例、argv 解析、绝对路径存在且等于 guards 文件、含空格临时路径真启动一次、timeout 缺省或 ≥10s。
- **M7 GC 行的 sid/agent 归发现者**:pending 载荷存原始 sid/agent/agent_type/prompt_id,GC 行全部身份列取自 pending;runner 对 L16 与新增跨会话 GC 用例断言 sid/agent。
- **M8 `--lines 5`/`--bytes 5` 分离形式没消费参数**,operand_index 错位使等价命令 impression 不同。§3 选项表补分离形式(契约 `head_tail_option_table`)。
- 派发:runner(H1/H5 schema 门/H6/M7 断言)→ 修复者;闸 + 台账(H2/H3/H4/M7/M8)→ 建造者 ②③④;解析器(H5)→ 建造者 ①;三者写面不重叠并行;之后重钉 pin、主脑整跑、Opus 增量核 8 条、上线。
## 24. v2.16 修订(2026-09-17 05:30;fab 盲攻 `audits/AUDIT-2026-09-17-fab-blind-pipe-gate-v2-build.md` 1H/4M/14L,HIGH-1 与 MEDIUM 1–4 全收;§0 M2/M3 的「heredoc 不判」与 A18 豁免被本节覆盖)
- **判定逻辑经 1935 条真实命令 + 130 条构造形态没有非 heredoc 的静默漏判**;七个攻击面里 seam+sentinel、生命周期状态机、Z 系静默用例都承重。挡不住的:「只认公开语料」的查表假闸(既知 B6,靠盲攻/语料轮换,不靠 runner)。
- **HIGH-1 heredoc**:解析器把含 `<<` 的整行折成空段(`redirects: []`)+ 闸只从 redirects 收 pending ⇒ `cat > f <<'EOF'`(真实语料 134/1935,6.9%)永远无回执,后续 `tail f` 只能 candidate;heredoc 行带 `|` 再下一行 `$?` 零行。修法(解析器契约修订 ⑦):heredoc 段仍单段 `unsupported:heredoc`,但首行的 exe/args/redirects/status_refs 照常切出、heredoc 操作符不进 redirects、首行含裸 `|` 不拆管道;闸对所有段(含 unsupported:heredoc)读 redirects 开 pending,heredoc 段计 unsupported(A/A)不判 A/B,A18 单段豁免撤销。夹具 1.2.5 C-H01/H02/H03;契约 H01/H03(生命周期回执)、H02(计数不静默)。
- **MEDIUM-1 `PMM_CMD_PARSE_MUTANT=flat` 是生产路径上的环境开关**:一行 export 整闸静默失明,runner 不在同一环境看不见。修订 ⑦ 第 3 条:生产 `parseCommand()` 不读 env,flat 改导出纯函数 `applyFlatMutant` 由 runner 调用;契约 Z23(该 env 在场时 A01 仍 would-warn);runner 纵深 grep 扩到解析器。
- **MEDIUM-2 Post rename 零重试**:租约被外部独占句柄(索引器/备份/安全软件)短暂占住 ⇒ 回执静默丢、D 永远 candidate。契约 `receipt_commit_and_lease` v2.16:Post 侧 rename 重试 ≤60×5ms,仍失败则原地读 pending、写回执、再尝试 unlink;契约 L22 + 执行器「FileShare.None 持有 300ms」。
- **MEDIUM-3 M0 包装缺 `command -v node` 守卫**:node 不在 PATH 时每次 Bash 调用吐 149B stderr(rc 0)。M0 包装照抄闸包装那行;契约 G05 v2.16:PreToolUse 组每条接线 + Post/PostFailure 在无 node 的 PATH 下真启动一次,stdout/stderr 均 0。
- **MEDIUM-4 函数定义错切**:`f() { set -o pipefail; a | b; rc=$?; }; f` 函数体当 root 判、pipefail 被吞 ⇒ 假 A/recurrence(语料 16 条函数定义形态)。修订 ⑦ 第 2 条:函数定义整体一段 `unsupported:function-def`,体内 option/status 不外泄;夹具 C-F01;契约 A31。
- LOW 14 条:L1 占位符随机化(下一 runner 修复轮)、L3/L4/L10/L11 文档与清洗(随 codex H4 落地)、L5/L6 噪声(M1 开测前)、其余记录;详见审计 §1 LOW 与 §6 排序。
- 派发:与 codex 末波(§23)同一批次 —— 解析器建造者(修订 ⑦ 三条)、闸+台账建造者(heredoc 段读 redirects、Post rename 重试、M0 包装守卫)、runner 修复者(版本 2.16/1.2.5、H01–H03/Z23/A31/L22、G05 无 node 逐条、flat 轮改调 `applyFlatMutant`、纵深 grep 扩解析器)。
## 25. v2.18 修订(2026-09-17 07:00;上线后第一批,主脑裁定;Jax 07:00「继续,别停,要 100%」)
- **上线状态**:v2.17 包 06:15 上线(shadow),Opus 最终增量核 13/13 GO,主脑整跑 114/114 + 三轮变异双向差集空,金丝雀 52/53(唯一红 C0 影子既有)。本节起为上线后批次,同一套「契约先行 → runner → 建 → 验」流程。
- **codex 后续**:L21 receipts 文件不可写(同名目录占住)⇒ 保留租约、不写任何行、D 只 candidate;L23 跨会话 GC 行身份取自原始 pending(执行器 `cross-session pre`)。
- **fab LOW**:L3 `run_provenance` 走 writer 边界清洗(H4 已覆盖,契约写明);L4 sanitize 扩到 VT/FF/NEL/LS/PS(Z10b);L5 尾随空段不计 unsupported(解析器修订 ⑧ 第 1 条,夹具 C-E01/E02);L6 `cd-hint` 只在有相对且不存在的 operand 时(`cd_hint_rule`,Dc01/Dc02);L7/L8 反斜杠转义(修订 ⑧ 第 2 条,C-BS01/BS02,A32);L12 尺寸上限(修订 ⑧ 第 3 条,C-OS01,Z24,2 秒内);L13 rc 列 -1 文档化;L10 附录 A 措辞改「sha256 前 16 hex」;L11 删 §2「parser_version !== '1.2' ⇒ unsupported:parser-version」句(契约是唯一真源,闸不查版本)。L1(公开语料查表假闸)与 L2(NODE_OPTIONS 投毒)只记录;L9(exec/变量 exe)文档化;L14 前半(无租约后缀的 .processing)闸不产生,记录。
- **M0 补全**(M-SPEC 附录 B1):Edit/Write 触发召回钩子双写 v3(eligible / displayed / suppressed),G11 由 runner 真跑一次钩子断言。
- **M3 策略与分配函数**(附录 B3):`policy.json` + `assignment()` 取代 §6 常量 `shadow`;P01–P05;`pmm-recall-precision.cjs --unlock` 是唯一写入口且自核 Wilson 下界。
- **M2/M3 工具**(附录 B2/B3):`pmm-recall-baseline.cjs`、`pmm-recall-m3.cjs`,只读、DESCRIPTIVE/UNKNOWN 字面量闸,金丝雀登记。
- 派发(写面不重叠):runner 修复者(常量 2.18/1.2.7、L21/L23 执行器、Dc01/Dc02、Z10b/Z24/A32、G11、P01–P05 与 policy 模式、`wall_clock_under_ms`/`lease_kept`/`gc_row_identity`/`mode_column`/`arm_*` 新键)· 解析器建造者(修订 ⑧)· 闸+台账建造者(cd-hint 规则、sanitize 集、oversize 行、run_provenance、`assignment()` 读 policy、M3 mode 列)· 新建造者(trigger-recall 双写 B1、baseline B2、m3 分析 B3、precision `--unlock`)。
## 26. v2.19 修订(2026-09-17 11:10;主脑整跑 v2.18 批 121/125 的四红全收;覆盖 §5 台账列语义与附录 B3 policy 键)
- **闸的 gate 行 `class_tag` 为空**:真实台账 A/B/D 共 1019 行 class_tag 全空(闸的注释自认「production findings 的 class_tag 今天恒为 ''」)。后果:policy.json 按 class_tag 查找永远匹配不到(P03/P04 红,臂恒 shadow);M1/M3 按 class 归组全落 `(unknown)`。钉死:gate 行与闸写的 informational 行 `class_tag` = 闸实现的教训 tag `process:pipe-hides-exit-code-and-truncates-evidence`(三个 gate 同一教训),`trigger_or_gate_id` 仍 A/B/D;空即红(runner 逐行断言)。
- **policy 结构改为 class + 每 gate 子键**:`{class_tag: {mode, gates: {A,B,D}, unlocked_by, lower95_by_gate, unlocked_at}}`;臂按 (session, class) 一次抛硬币、全 class 共用;某 gate 只有自己的 (class, gate) 精确率下界 > 0.80(≥30 标注)且被 `--unlock <class> --gate <G>` 写成 randomized 才真正在 intervene 臂输出,否则该 gate 行记 mode=shadow、`policy:shadow-gate`。理由:B(截断验证输出)曝光 582 但大概率噪声多,不能因为它拖住 A/D 的解锁,也不能让它搭 A 的便车。
- **cd-hint 两处误判**:D11 `head -60 .`——`.` 是存在的目录,「不存在」= `existsSync` 为假,不是「不是文件」;D16 `tail +5 f`——`+5` 是计数不是 operand,cd-hint 用与 D 相同的选项消费后 operand 列表。
- 派发:闸建造者(class_tag 写入、policy 子键与 shadow-gate、cd-hint 两处)· runner 修复者(常量 2.19、gate 行 class_tag 断言、policy 三模式按新结构、P05 新签名)· 新工具建造者(`--unlock <class> --gate <G>`,`lower95_by_gate`;m3/baseline 按 class_tag 归组时用新值)。
## 27. v2.20 修订(2026-09-17;M1 首批标注 + Opus 增量核 3M/2L 全收;覆盖 §3 B 规则、附录 B3 run_provenance 语义)
- **B 闸浏览类白名单**(M1:B 14 useful / 16 noise,噪声全是 git log/ls/grep/cat 预览):B 对「紧邻上游段」exe ∈ {ls, dir, cat, find, fd, grep, rg, ag, wc, du, df, echo, printf, env, which, type, jq, yq, sed, awk, cut, sort, uniq, tr, column} 或 git 子命令 ∈ {log, show, blame, ls-files, status, branch, tag, stash, reflog} 时**不报**;其余(含未知 `cmd`、git diff、测试/构建/lint)照报;上游段 unsupported 时保守照报。契约 `gate_b_browse_denylist`,用例 Bx01–Bx06。A/D 不变。
- **`run_provenance` 记策略模式不记臂**:`policy:absent|shadow|randomized|corrupt|shadow-gate`,臂只在 `mode` 列;P03/P04 两臂都 `policy:randomized`(契约 `run_provenance_policy`)。
- **Z24b** 单 token 上限独立用例;**G11** 复算 impression_id(repo 名 + 相对路径正斜杠无前导 `./`,行 `run_provenance` 带 `inst:<sha16>`)。
- M2/M3「复发」主/次结局分开;gate 行旧空 class_tag 不回填、读侧派生、报告拆 `(pre-class_tag)`/`(n/a)`(附录 B 补注 #3)。
- 派发:闸建造者(B 白名单)· runner 修复者(常量 2.20、Bx01–Bx06、Z24b、G11 复算、`run_provenance_policy` 断言)· 新工具建造者(G11 的 inst 写入已在附录 B 补注 #3 派出)。
## 28. v2.21 修订(2026-09-17 12:10;v2.20 冻结整跑 131/132 唯一红 A12)
- **A12 与 B 白名单矛盾**:`cmd > f 2>&1; rc=$?; cat f | tail -3; echo $?` 的 head/tail 段紧邻上游是 `cat`(白名单 exe),按 §27 规则 B 不响;A12 旧预期 A+B 是 v2.20 前的产物。裁定:**白名单语义优先、只看紧邻上游段、同行更早的 `;` 命令一律不参考**(保持规则机械、与 M1 标注一致);A12 改为只期望 A(`echo $?` 掩 rc)。契约 `gate_b_browse_denylist` 补句,版本 2.21。
- 盲解析变异轮 `sentinel_ok=false` 同源(A12 在盲解析下零行 ⇒ 哨兵「nowhere」);A12 修正后由 runner 修复者复核该轮是否恢复绿,若仍红须说明 runner 对「预期 A 但盲解析零行」用例的哨兵判定规则。
- **吸收 Jax 关掉的建议卡(execFileSync 看不见 stderr)**:`execFileSync/execSync` 不带 `stdio` 捕获时,子进程 rc=0 的 stderr 直通父进程、返回值里恒为空,靠它断言「stderr 0 字节」的自测是假绿。runner 本体用文件捕获(`statSync(stderrPath)`)不受影响;闸的 75 项自测与其它 guards 自测须扫同类,交本轮 Opus 增量核逐条判定并 falsify。
- 派发:runner 修复者(常量 2.21;复核盲解析轮哨兵)· 主脑重钉 pin、冻结整跑 · Opus 增量核(v2.19+v2.20+v2.21 全部改动 + execFileSync 同类扫)。

## 29. v2.22 修订(2026-09-17 12:50;Opus 对 v2.19–v2.21 冻结版增量核 GO,MEDIUM F1 收口)
- **F1 盲区**:白名单键在「读的人」身上——`npm test > out.txt 2>&1; cat out.txt | tail -3` 两段都不响,而一步式 `npm test 2>&1 | tail -3` 会响 B;grep/sed/awk 同形。契约 rationale 写的是「不豁免验证类命令」,这个形态正是验证输出被截断。
- **裁定(契约 `gate_b_browse_denylist` v2.22 补句)**:紧邻上游浏览段的任一 operand(与 D/cd-hint 同一套选项消费与路径解析)若是 (a) 同一命令更早段中**非浏览 exe** 的写重定向目标,或 (b) 本会话回执表里 TTL 内 `created-nonempty/replaced-changed/appended-grown` 的路径(与 D 同一证据表、同一 TTL),则白名单**失效**、B 照报;写入者本身是浏览 exe(`ls > list.txt; cat list.txt | head`)仍豁免;pattern/脚本 token 永不解析为路径。A12 回到 A+B。
- 用例:Bx07(同命令、非浏览写入者 ⇒ B)· Bx08(同命令、浏览写入者 ⇒ 不报)· Bx09(生命周期:回执 TTL 内 ⇒ B)· Bx10(回执过期 ⇒ 不报)· Bx11(grep 变体 ⇒ B)。
- Opus LOW×4 记录不动:契约两处「class 键缺失」措辞、`pmm-core-selftest.cjs:575 runCli` 硬编码 stderr(失效方向假红)、闸自测 :1789 `toolErrLen` 恒 0 被打印、注入 stderr 后 SELFTEST 摘要行不变;闸建造者顺手修第三条(打印改为真值或删掉)。
- 派发:闸建造者(失效规则两路 + Bx07–Bx11 自测红→绿 + :1789)· runner 修复者(常量 2.22;确认生命周期 DSL 对 B 期望与 `clock:` 步骤通用;Bx09–Bx11 走既有执行器)· 主脑重钉 pin、冻结整跑 · Opus 增量核。

## 30. v2.23 修订(2026-09-17 14:00;codex 一波审 2H/5M/4L,Opus 辩护+复现 10/11 confirmed;8 条进契约,3 条直接派建)
- **process_liveness(HIGH-1,比 codex 报的更重)**:契约 cases 79 例、lifecycle 30 例声明 rc 的是 0 个;闸 `uncaughtException → exit(0)` 让崩溃与正确沉默同形,死闸下 Bx08/Bx10/A08/A11/D11 仍绿。钉死:runner 每一次 hook 调用默认断言 `spawnError===null && rc===0 && stderrSize===0`,lifecycle 逐步聚合,用例只能在自己的 expect 里显式声明不同值来豁免;`clock:` 步骤断言回执文件存在且至少改写一行;`--self-check` 加 part9「死 DUT 证明」(stub 开局 exit 9 ⇒ 所有原本空期望用例必须红)。
- **B 闸(MEDIUM-3/4,取高频项)**:浏览名单补 `head`/`tail` 自身、git 只读子命令补 `grep/ls-tree/cat-file/rev-list`;豁免判据改为「head/tail 上游整条 pipeline 自源头起全为浏览」(`npm test 2>&1 | grep -i error | head -5` 是验证截断,B 报);写入证据扩到 `tee` 位置参数与 `verification_output_flags`(--junitxml/--report/--output/-o…);「浏览写者保豁免」只在写入 pipeline 的源头段是浏览时成立。不进:`$(… > file)`(有 unsupported 兜底)、symlink 同一性。用例 Bx12–Bx22。
- **配对行 mode(MEDIUM-5)**:一个 finding 的全部行同一 `mode`=所分配臂;区分 would-warn/emitted 的是 event_kind;runner 逐行断言臂,不用存在性判据。闸 `:765 let rowMode='shadow'` 与 `:757` 注释冲突,一行改。
- **policy 读错(LOW-8)**:只有 ENOENT ⇒ absent,其它读错 ⇒ corrupt;P06(policy 路径是目录)。**sanitize(LOW-9)**:整段 C0/C1 + LS/PS;Z10c(BEL)/Z10d(DEL)。**G11(LOW-10)**:impression_id 与 inst 均恒等重算值。**盲轮推导(LOW-11)**:基于变换后 parse 与逐 instance 证据,不用原始文本 every();Bx21/Bx22。
- **不经契约直接派建**:E2 沉井退出码逐个保存、非零/信号即红(HIGH-2,同一 Sonnet);M3 臂在两个 eligible writer 处经唯一解析器 `pmm-recall-policy.cjs` 落账、randomized 且 shadow 臂真不显示(MEDIUM-6);precision 复用 baseline 分桶(MEDIUM-7)。闸在 v2.23 切到同一 `pmm-recall-policy.cjs`。
- 派发:runner 修复者(常量 2.23、process_liveness 与 part9、逐行 mode、P06 模式、Z10c/Z10d、G11 恒等、盲轮推导重写)· 闸建造者(B 规则四项、rowMode、policy 读错分类、sanitize 扩展、切换到共用解析器)· 主脑重钉 pin、冻结整跑 · Opus 增量核 · 之后 codex 再攒一波。

## 31. v2.24 修订(2026-09-17 15:50;codex 第二波 1H/3M/2L,Opus 辩护+复现 6/6 confirmed;主脑按新规矩先用草稿契约对现有闸经验预检)
- **liveness 计数式断言(HIGH-1)**:全绿跑里 L15 的 liveness 是 `{checked:false, steps:0, ok:true}` 而它 spawn 了 2 个并发闸进程——`execConcurrentPre`/`execPostPreInterleave` 从不 push 进 `state.log`,`mergeLiveness([])` 返回 ok:true。钉死:每次 hook 调用(顺序/并发/交错/policy `bRun`/Z12 正控/自检桩)都产生 liveness 记录,每例聚合须 `steps === 实际 spawn 次数`,`checked===0` 或 `steps<invocations` 自身即红;part9 遍历全部用例而非固定 ID 列表。
- **carve-out 只看源头段(MEDIUM-2,闸实现错、契约 (iv) 本就写的是 SOURCE segment)**:`ls | tee list.txt; cat list.txt | head` 当前误报 B;Bx23 保豁免。
- **jq/yq -e 取消豁免(MEDIUM-3)**:`-e/--exit-status` 时退出状态即验证、被管道吞 ⇒ B(Bx24);无 -e 仍浏览(Bx25)。**输出参数表集中到契约**并补驼峰(`--outputFile` 等;Bx26 Jest)。
- **只读 git 子命令补 rev-parse/remote/worktree/describe;工具+子命令表 docker/kubectl/podman logs 为浏览(LOW-4;Bx27–Bx29);curl 不进**(只读与否取决于 -X/-d)。
- **不经契约直接派建**:E2 及全部红控改共用断言(精确 rc=1 + `⛔ PMM pre-commit 完整性闸` 诊断前缀;MEDIUM-6,Opus 更正约定码是 1 不是 2)· `resolveRoot()` 收敛为 ledger 唯一导出、policy 复用、bash-impression 显式传 root(LOW-5)。
- **预检记录**:草稿契约(v2.23 + 七例)对 v2.23 闸整跑:Bx23/27/28/29 误报 B、Bx24/26 漏报、Bx25 ok——与六条 finding 一一对应,无意外列/事件。
- 派发:runner 修复者(常量 2.24、计数式 liveness、并发/交错记录入 log、part9 全量)· 闸建造者(carve-out 源头段、jq/yq -e、输出参数表读契约、git 子命令与容器 logs 表)· 主脑重钉 pin、冻结整跑 · Opus 增量核 · codex 第三波(与后续批次攒一起)。

## 32. v2.25 修订(2026-09-17 19:45;fab 盲攻(活体 d1cfd9b)2H/7M/6L,Opus 辩护复现 15/15 confirmed;本节只收管道闸相关两条,其余直接派建)
- **包装命令不得全盲(MEDIUM-5,Opus 更正)**:`sh -c`/`bash -c`/`pwsh -Command` 今已记 `unsupported`;`sh -lc`、`xargs … sh -c`、`powershell -c`、`eval` 今**零行**。钉死:eval、alias、任意短旗组合的 shell 包装器(-c/-lc/-ic/-ec/-xc/--command/-Command/-EncodedCommand;sh/bash/zsh/dash/ksh/pwsh/powershell/cmd /c)与 xargs+包装器,无法递归判定时记一行 `unsupported:wrapper`(A/A 归属、管道教训 class_tag);能递归判定的记内层闸行。用例 Wx01–Wx04(期望 events [unsupported]、gates [])+ 对照 Wx05(sh -c)。草稿预检结果与判定一致。
- **家目录解析唯一(MEDIUM-1)**:所有守卫经 `pmm-recall-ledger.cjs` 导出的 `resolveHome()`(PMM_HOME > USERPROFILE > HOME > os.homedir())派生一切根;直接读 os.homedir()/HOME/USERPROFILE 的守卫在自检 grep(part13)判红;runner 对每 section 一例断言「只重定向 HOME+USERPROFILE(不设 PMM_*)时真根三件套逐字节不变」。
- **直接派建(不经契约)**:HIGH-1 trigger-recall 家目录硬编码 + trigger-log 迁 `.local/` + 合成键 sidecar + 金丝雀基线 ≤298;HIGH-2 写时闸与 entry-length-watch 共用一套路径规范化(去 `\\?\` → win32.normalize → 小写 → relative 不以 `..` 开头且不含 `:`),探针加 unc/dbl/dot-in-prefix;M-2 金丝雀首尾真根三件套对账;M-3 按 M-SPEC 补注 #5(session × agent × class;seen 键 (session, agent));M-4① 悬空链不占名额;M-6 hook-manifest 补 5 行 + session-end 活性灯(report-only)+ PowerShell 接 M0 观测(单列一轮);M-7 deny 补 `git commit -n`/`-c core.hooksPath=`、fingerprint covered 加 mutants/fixtures/specs 与 pins;LOW-2 policy.json 原子写;LOW-3 自测 tmp 清理;LOW-6(升 MEDIUM)非 JSON stdin 62 次:先记 stdin 前 64 字节 hash 定位来源。记录不修:LOW-1、LOW-5。
- 派发:闸建造者(wrapper 行 + resolveHome 切换)· runner 修复者(常量 2.25、part13 grep、每 section 一例 HOME-only 真根对账)· 召回工具建造者(HIGH-1/M-3/M-4①/M-1 读侧/LOW-2/LOW-3/LOW-6)· E2/金丝雀建造者(HIGH-2/M-2/M-7/M-6a)。

## §33 v2.26(2026-09-23;codex 终审 `.codex-reviews/review-20260923T132224Z.md` 10 条 → Opus 裁决 `audits/OPUS-2026-09-23-codex-final-triage.md`;fab 盲攻 `audits/AUDIT-2026-09-23-fab-blind-delta.md` → Opus 裁决 `audits/OPUS-2026-09-23-fab-delta-triage.md`;Opus 验收附录 GO-WITH-CHANGES)

预注册(主脑,建造者不得改):契约 v2.26(207 例;新增 Wx06–Wx29、Bx30–Bx34、Bx36、Bx37;惯例 `launcher_commands`(含 fab LOW-4 扩表 + 旗标止点)、`gate_b_exempt_flag_clusters`、`writer_segment_rule`、`verification_output_flags` 补 `--cov-report`、`home_literal_scan`(含 fab MEDIUM-6 四条便宜正则)、`home_only_proof`(含 (g) part15 非空断言)、`selftest_id_convention`;`required_fixture_version` 1.2.9)、一致性夹具 1.2.9(142 例;C-W06–C-W29)、解析器契约修订 ⑩。

预检(对 HEAD `b1a74c2` 代码态的 v2.25 闸,草稿契约,临时 HOME):194 计分 = 168 绿 / **26 红**,红的恰是 Wx06–Wx16 + Wx20–Wx27(19,启动器/解释器零行)+ Wx28/Wx29(2,脚本参数 `-c` 被误标 unsupported;B 今日已触发、保留)+ Bx30/31/32/34/36(5,Gate B 漏报);5 条对照(Wx17/18/19、Bx33、Bx37)今日已绿。解析器草稿夹具:C-W06–C-W16、C-W20–C-W27 今日均为普通段(红),C-W28/C-W29 今日误标 unsupported(红),C-W17–C-W19 今日已同。

### 批次(写面不重叠才并发;建造者一律 `git commit -- <paths>`,禁止 `git add -A`;不刷指纹册、不 re-pin,收口由主脑统一做)
- **A1**(Sonnet):#10 提交闸行为金丝雀(`git rev-parse --git-path hooks/pre-commit` 断言、hook 内容 sha ≡ 入库镜像 `_local-config/git-hooks/pre-commit`、临时仓必红/必绿提交)+ deny 语义断言(固定集合)+ `covered()` 加 settings/manifest/git hooks + refresh 收据失败即非 0;#6 legacy 精确判据(`git diff --quiet` + 行数 25354)+ 基线 574→579(注明 5 行归属)+ `selftest` 计数;#1 precommit 自测 11 处补 `USERPROFILE`。写面:`guard-canary.sh`、`pmm-fingerprint.sh`、`.claude/pmm-precommit-gate.sh`(+镜像)、新增 `_local-config/git-hooks/pre-commit`。
- **A2**(Sonnet):#8 basename 小写比较 + `pmm-core.cjs` `realpathForCompare()`(最终路径/最近现存父目录 realpath)+ 探针 4 例;Opus 验收 MEDIUM:探针 #27/#28 在 HOME 未重定向时也不得写真冻结文件。写面:`pmm-trigger-write-gate.cjs`(+镜像)、`pmm-core.cjs`、`fixtures/v3/trigger-write-gate-probe.cjs`。(fab 并入项按 `OPUS-2026-09-23-fab-delta-triage.md` 合并表)
- **A3**(Sonnet):#7 `:445` 用 `resolvedSlots`、悬空占位封顶 `max(0, 3 − inject.length)`、`head()` visited-Set + `supersede-cycle` tlog;自测 (a)(b)(c) + (d) report-only 1.2KB 字节断言。写面:`pmm-trigger-recall.cjs`、`pmm-trigger-recall.sh`(+镜像)。
- **B1**(Opus 建 + 另派审;测量地基):runner 契约 v2.26 —— `REQUIRED_CONTRACT_VERSION` 2.26、`REQUIRED_FIXTURE_VERSION` 1.2.9;part13 `home-literal` 扫描(逐行白名单,历史两行必命中);part14 默认跑、监视集补 `.local` trigger-log/quarantine/queue/policy、G11 id + 计算出的 seen 文件名进 markers、`attributeChanges` 匹配文件名、run-nonce id;part15 非空断言 (g);`:4273` 过时注释。写面:`pipe-gate-v2-acceptance.cjs` 仅此一文件。
- **B2**(Sonnet):`pmm-cmd-parse.cjs` `detectLauncher`(修订 ⑩;`unsupported:wrapper`,不递归)+ conformance 1.2.9 全绿;`bash-pipe-exitcode-watch.cjs` `hasNoExemptFlag` 短旗簇、writer 段判据、`--cov-report` 入表;自测合成 id 改 `toolu_selftest_<…>`(含 `bac617a` 的 `deadbeef…`/`toolu_01deadbeefqueue1`)。写面:`pmm-cmd-parse.cjs`、`bash-pipe-exitcode-watch.cjs`(+镜像)。
- **C**(Sonnet,A1 之后):#9 选项 B(PostToolUse `Bash|PowerShell` 内容变更校验,复用 `pmm-entry-length-watch.sh --block`,先 report-only)。**主脑按 Opus 推荐先行,Jax 可否决**。
- 收口:指纹 refresh、re-pin(contract/conformance/runner)、冻结整跑 + 三突变体 + 金丝雀、各批独立审(建者≠审者)、C0 plan 重生成。
