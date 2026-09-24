# 建造简报:召回侧闭环 M0 · 纯观测契约(零行为改动)

主仓库绝对路径 `C:/Users/<user>`(git repo,`.claude/` 是子目录)。**在主仓库里直接工作,不要切到任何 worktree。**
权威 spec:`guards/specs/RECALL-LOOP-M-SPEC-v2.md` 的 **M0 节**(先完整读它,再读审查档
`audits/CODEX-2026-09-16-recall-M-spec-review.md` 的 HIGH-4/5/6 与 MEDIUM-1/2,那是 M0 每条要求的来源)。

**前置**:管道闸 `bash-pipe-exitcode-watch.*` 已由上一位建造者交付并合入(shadow/intervene 双态、三 gate-id、台账在
`~/.claude/.local/pmm-recall/`)。**你的台账 schema 必须与它一致**——先读它的台账写入代码,字段名照抄,不另起一套。

## M0 交付物(四件,各独立提交)

### 1. 命令解析库 `guards/pmm-cmd-parse.cjs`(零依赖叶子)
导出 `parseCommand(cmdText, ctx) → { segments: [{ dialect, index, exe, sub, parse_status }], parser_version }`。
- 第一层 POSIX:未引号的 `;` `&&` `||` `|` 换行切段;剥 `VAR=val`、`sudo [-u x] [-E]`、`timeout [-k x] N`、`env [-i] [VAR=v…]`、
  `command`、`nohup`——**wrapper 自身带参数的选项必须定义**(`sudo -u root`、`env -i PATH=…`)。
- **方言子解析器,各最多递归一层**:`bash -c`/`sh -c` → POSIX;`powershell(.exe) -Command`/`pwsh` → PowerShell
  (处理 `&` call operator、`|` 在 PowerShell 内、scriptblock `{}`、单/双引号规则);`cmd(.exe) /c` → cmd;`wsl` → POSIX。
- exe = 首 token 的 basename 小写去 `.exe`;sub = 首个不以 `-` 起的后续 token,**跳过已知全局选项及其参数**
  (至少:`git -C <p>`、`git --git-dir=<p>`、`npm --prefix <p>`、`node -e` 视为无 sub)。
- `(…)`、`$(…)`、`` `…` ``、heredoc、引号不平衡、未知 wrapper ⇒ **`parse_status = 'unsupported:<reason>'`**,该段 exe/sub 置空;
  **绝不把它记成 matched=0**。正常 ⇒ `parse_status='ok'`。
- **自测** `--self-test`:审查给的 8 行矩阵逐条 + ≥6 条 happy-path,每例断言四元组 `dialect/exe/sub/parse_status`。
  矩阵(必须全部通过):`git -C C:/repo status` → sub=status;`sudo -u root git status` → exe=git sub=status;
  `powershell.exe -Command "git status; npm test"` → dialect=powershell 且内层两段各自 exe/sub;`cmd.exe /d /c "git status && npm test"`
  → dialect=cmd 两段;`& 'C:/Program Files/Git/cmd/git.exe' status` → exe=git sub=status;`Get-Content x | Select-Object -First 10`
  → dialect=powershell 两段;`env -i PATH=x git status` → exe=git;`(git status; npm test)` → parse_status=unsupported:subshell。
  **矩阵里的路径一律用正斜杠写进测试源码**(Bash 工具折半反斜杠,别在 heredoc 里写 `C:\`)。

### 2. impression 钩子 `guards/pmm-bash-impression.cjs`(PreToolUse,matcher=Bash)
- 读 hook JSON;repo 由 `data.cwd` 经 realpath → git toplevel basename → 配置映射解析,**不硬编码**。
- 用 `core.classifyTriggerLine` 收集语料里 `kind==='cmd'` 的触发(语法在 `pmm-core.cjs:284-289`,不新写解析器);
  用 `parseCommand` 切段;匹配规则:某段 `parse_status==='ok'` 且 `exe` 相等 且(触发无 sub 或 sub 相等)。
- **只写台账,stdout 0 字节、stderr 0 字节、rc 0。** 台账路径与 schema 与管道闸一致:
  `~/.claude/.local/pmm-recall/<机器名>/impressions.tsv`,字段 `schema_version ts session_sha256 tool_use_id
  event_kind(eligible|suppressed) trigger_id class_tag dialect segment_index exe sub parse_status cmd_sha256 parser_version`。
  impression-id = `sha256(session_sha256 + tool_use_id + trigger_id)`,同 id 不重写(幂等)。命令文本只记 sha256。
- **另存脱敏展示层**(审 HIGH-5,否则没人能标注):同目录 `queue.tsv`,含 impression-id、tag、exe/sub、时间、**脱敏命令片段**
  (去 `/Users/<name>/` 与 `C:/Users/<name>/` 中的用户名、去引号内内容、截 120 字符),7 天滚动清理。
- **全通道零输出测试**(审 MEDIUM-1):通过 `settings.json` 里**实际接线的命令串**跑,对五种输入
  「正常 / 坏 JSON / 空 stdin / 台账目录不可写 / 命令含 unsupported 结构」各断言:stdout 0 字节、stderr 0 字节、rc 0、
  除 `~/.claude/.local/pmm-recall/` 外无任何文件变化(`.trigger-seen-*`、`memory/*.md`、`settings.json` 逐字节不变)、单次 < 500ms。

### 3. 种子 trigger(唯一允许的语料编辑)
在 `memory/lessons.md` 的 `process:pipe-hides-exit-code-and-truncates-evidence` 条目标题行之后(与其既有 path 触发并列)加两行:
`<!-- trigger: tool=Bash; repo=*; cmd=tail -->` 与 `<!-- trigger: tool=Bash; repo=*; cmd=head -->`。
`repo=*` 合法(`tail`/`head` 不在 denylist,denylist 见 `pmm-core.cjs:33`)。**经现役写时闸提交,闸拒就停并报告。**
金丝雀新增断言:生产语料 `cmd trigger count ≥ 1`(用 `core.classifyTriggerLine` 数,不用 grep)。

### 4. gitignore 与登记
- 根 `.gitignore` 须覆盖 `.claude/.local/`;若不覆盖就加一行。验收:`git check-ignore -v .claude/.local/pmm-recall/x` 命中,
  且 `git ls-files .claude/.local` 为空。
- `settings.json` PreToolUse 增 matcher=Bash 指向 impression 钩子(**与管道闸的那条并存**,先读现有结构照样式加);
  镜像 `_local-config`;`pmm-fingerprint.sh refresh`;guard-change 收据;金丝雀名册 +2(解析库自测、impression 钩子零输出自测),
  **每个新守卫配 synthetic mutation 臂**(审 MEDIUM-4:把零输出断言故意打破一次,确认名册翻红)。

## 硬约束
不碰 `pmm-trigger-recall.cjs` / `pmm-core.cjs` / `pmm-migrate-v3.cjs`(M0 是旁路观测,不改引擎);`.claude/memory/*.md` 只允许第 3 件
那两行;`git add <具体文件>` 绝不 `-A`,提交前 `git diff --cached --name-only` 核对;**四件各独立提交**;取退出码不经管道
(管道闸现在会提醒你);正则与含路径的夹具用 Write 工具写,不经 Bash heredoc。

## 完成标准
七套既有自测项数不减;金丝雀 42→44,**红项集合精确等于 `{已知的 plan-OID 那台}`**(按名字断言,不按数量);指纹册 check 为 0;
`pmm-manifest-v2.cjs --check` 阻断分布 B8b 18 / B23 6 / B7 5、B5 0 不变;**跑一次真实会话级验证**:用 Bash 工具执行
`tail -1 /dev/null`,然后读 `impressions.tsv` 确认多了一行 `eligible`、`queue.tsv` 多了一行脱敏片段,且**你的上下文里没有出现任何注入**。
报告写自估时长(开头)、每件的红→绿实证、`parse_status` 在你自测里的分布、以及你认为简报或 spec 写错或没想到的地方。

## 落地记录(2026-09-16 17:21,主脑独立验收通过)
提交:`e5f31b0` `b3123bd`(解析器)· `b3c9139` `50d369e`(impression 钩子)· `8412db5`(种子 trigger)· `f0d79df`(接线/金丝雀 +2/指纹)。
**解析器实际契约以 `PMM-CMD-PARSE-CONTRACT.md` v1.1 节为准**(本简报第 1 件所写的字段是最小集,落地时已扩展 sep_before/redirects/args/has_exit_status_ref/kind,并把保留字、双引号内命令替换、纯赋值段的口径改正)。
建造者的合理偏离:`sub` 只对 git/npm 提取;台账平铺 `impressions-<主机名>.tsv`(照抄管道闸);列 22(含 agent_id/agent_type/prompt_id/agent_id_missing/impression_id/event_id/id_missing/sanitized)。
待 v2 台账模块修:无表头行、schema 改动未轮转(21/22 列混存)、抑制按 session 而非 (session, agent)、write-failures 兜底同目录。钩子实收 JSON 顶层 key:agent_id, agent_type, cwd, effort, hook_event_name, permission_mode, prompt_id, scratchpad_dir, session_id, tool_input, tool_name, tool_use_id, transcript_path。
