# 建造简报:管道后取 `$?` 的 PreToolUse 警告闸(设计已经 codex 审过,按审查修正版建)

主仓库绝对路径 `C:/Users/<user>`(git repo,`.claude/` 是子目录)。**在主仓库里直接工作,不要切到任何 worktree。**
这是「机器而非警惕」的第一道自建闸:本会话主脑犯「管道后取 `$?` / 截断读验证输出」五次,教训入库仍复发。

## 设计(审查修正后,`audits/CODEX-2026-09-16-round14-spec-review.md` HIGH-3 + MEDIUM-6)
- 文件 `~/.claude/guards/bash-pipe-exitcode-watch.sh`(或 `.cjs`,选更稳的),PreToolUse hook,matcher=Bash。
- 从 stdin 读 hook JSON,取 `tool_input.command`。
- **命中时输出且只输出**结构化 JSON,**不设 permissionDecision,exit 0**(警告不拦):
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"[process:pipe-hides-exit-code-and-truncates-evidence] 检测到管道后取 $? / 截断读取验证输出;正确写法 cmd > f 2>&1; rc=$? 先取码再读全文"}}`
  **纯 stdout 文本到不了模型**(审查 HIGH-3),必须是这个 JSON。未命中时 stdout 为空,exit 0。
- 触发条件(报告模式,宁可多报):
  (a) 同一命令串内任意管道 `|` 后再读 `$?`;
  (b) `head|tail` 截断验证类命令(`--self-test|--check|canary|verify`)的输出,含 `head -n N`、`tail --lines=N`、`| tee`、`| jq`、`| sort`;
  (c) `… | wc -l` 读行数;
  (d) **无管道但用 `tail -N <文件>` / `head -N <文件>` 读一个刚重定向的输出文件**(当日第四次实际误判形态)。
- 例外(不触发):含 `PIPESTATUS[`、含 `set -o pipefail`、匹配落在 `#` 注释或引号字符串内。
- 已知最可能误报:`producer | grep -q pattern; rc=$?`(有意读 grep 状态)——报告模式先容忍,不处理。
- 命中时另追加一行到本机未跟踪台账 `~/.claude/memory/dreams/recurrence-<机器名>.tsv`:
  `ts sid class=process:pipe-hides-exit-code-and-truncates-evidence gate=bash-pipe-exitcode-watch cmd-sha256`
  (命令文本只记 sha256;这是召回闭环 M3 的复发探测器,字段固定,别改名)。

## 自测 `--self-test`
- **解析 JSON 断言** `hookEventName==="PreToolUse"` 且 `additionalContext` 含教训 tag,不得只 grep 文字。
- ≥6 例必触发,须含:`cmd | tail -3; echo $?` · `cmd | head -60 | wc -l` · `tail -6 out.txt`(无管道,文件是刚重定向的)·
  `bash x.sh --self-test 2>&1 | tail -5` · `cmd | tee f; rc=$?` · `cmd | sort | head -n 10`。
- ≥4 例必不触发:`cmd > f 2>&1; rc=$?` · `echo ${PIPESTATUS[0]}` · `set -o pipefail; a | b; rc=$?` · `cmd | grep -q x`(无 `$?`)。
- 断言未命中时 stdout **为空**(不能输出任何东西,否则会污染其他 hook 的 JSON 通道)。

## 接线与登记
- `settings.json` PreToolUse 增一条 matcher=Bash 指向本脚本(先读现有 PreToolUse 结构照样式加,别破坏别的 hook);
- 镜像到 `.claude/memory/_local-config/`;`pmm-fingerprint.sh refresh "<理由>"`;guard-change 收据同批;
- 入金丝雀名册(`guard-canary.sh` EXPECTED +1,跑其 `--self-test`)。

## 硬约束
不碰 `.claude/memory/*.md`;不碰 `pmm-migrate-v3.cjs`/`pmm-trigger-recall.cjs`/`pmm-core.cjs`(M spec 审查正在读它们);
`git add <具体文件>` 绝不 `-A`;提交前 `git diff --cached --name-only` 核对;**自己完成提交**;
取退出码不经管道(本闸建好后会提醒你);**脚本里的正则不经 Bash 工具的 heredoc 写**(工具折半反斜杠)——用 Write 工具
或 node 在源码里控制转义;先红后绿:先写自测看它红(脚本不存在/空实现),再实现到绿。

## 完成标准
自测全绿且含上述例数;金丝雀 41→42、红项仍只有已知的 plan-OID 那台;指纹册 check 为 0;
`pmm-manifest-v2.cjs --check` 阻断分布不变;**手工验证一次**:用 Bash 工具跑一条 `echo hi | tail -1; echo $?`,
确认 additionalContext 真的出现在下一轮上下文里(这是 HIGH-3 的核心——到不了模型的闸不算闸)。
报告写自估时长、红→绿实证、你认为简报写错或没想到的地方。
