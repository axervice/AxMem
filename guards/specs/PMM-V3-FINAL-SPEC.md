# PMM v3 最终可建 spec(fab 最终综合,2026-09-15;裁 fab 方向审 + codex v3 审 + TARGET-SPEC-V3/D1/C0/P1–P36)

> 依据只读扫描(HEAD `9a8ecd9`,memory 树 OID `ebe8516`;脚本在 scratchpad,真库零写)。记法 `文件:行` = 活体 `~/.claude/…`。
> **语料事实(本次复核)**:live 标题 **419**(dec 207 / les 149 / std 49 / classes 14)= codex ✓;archive `^\*\*20` 142(50/47/45);今日 manifest 识别 413 live / 107 arch、blocking 0、live trigger 70 条全 path 形态、cmd 0 条、`path=*` 0。
> 无身份 live = **24**(codex 报 23:漏了 `lessons.md:852` 首括号 `[pmm]` 非 ns-tag);同文件重复 **2 对**(`decisions.md:925/929` jax-looprig、`:1167/1170` m6-booking——D1 表行号已陈旧 +7,证明 plan 数必须绑 OID);跨文件 3 对;`[user]` 无冒号 6;Index 行 dec 207(33,981B,2 行 >320B:`:106` 435B、`:112` 368B,marker 11,非标 1)/ les 149(26,892B,1 行无 ns-tag)/ std 38(35 行无 tag);marker 12、`[[…]]` 声明目标 10、**单括号 `Supersedes:` 4 行**(`decisions.md:391,437,493`、`standinginstructions.md:33`——今日 manifest 不认,其中 437/493 正是「marker-only」3 条中的 2 条);无声明 marker-only 1(`prod-db-dedicated-account`→`prod-db-shared-until-10-subs`,目标存在 dec:810);`(晚)` 只在 Index 行 dec:53,标题 dec:1279 无;std 带 BOM、四文件全 LF、零代码围栏、反引号内 `[[…]]` 4 处;live 大写 tag 3;>900B 非 sole-record 5 条;裸 `[[x]]` 0;Kernel 11 条 15,136B;banner.md 7 行,单行最长 318B,其中 2 行无 tag、1 行 tag 指向非 Kernel 条目(`process:review-effort-tier-table` = std:165,Entries 区)。
> 遥测:trigger-log 3,537 行,injected+linked+class 34 = 0.96%;heat-resolved 3 行;收据 10 张全 guard-change、user-choice 0;指纹册 80 行;金丝雀 EXPECTED=37(逐行数过)。

## 1. 语法 v3 定稿(存储形态;每个事实只有一个手写位置)

**1.1 标题行**(条目起点;必须行首):`^\*\*(?<dateISO>20\d\d-\d\d-\d\d)(?<dateRaw>[^*]*?)\s+—\s+(?<title>[^*]+)\*\*(?<tail>.*)$`
- 身份 = `tail` 里**第一个** `\[([a-z][a-z0-9-]*):([a-z0-9._-]+)\]`(B7 按 ASCII 小写比对;新身份须已是小写 B8c;存量 3 个大写 tag 不改名)。身份 ns ∈ {user,agent,system,trust} = 红(B8b)。`class:` 是合法身份(14 枢纽)。
- 署名 `[user:x]|[agent:x]|[system:x]`、`[trust:user-ratified|observed|derived]`、`[sole-record]`、`[redundancy-ok]`:同行、身份之后任意序;**旗标只认标题行**(B24;写正文无效)。
- 前导空格/`>` 前缀/围栏内的 `**20…**` 不是标题(B8 拦"起行像标题却未成条目")。dateRaw(如 `(晚)`)逐字保留、不参与排序;拒 dateISO > as-of+1 天(B22)。
**1.2 字段行**(条目块内任意行、行首匹配;非下表者一律正文):

| 字段 | 精确正则(行) | 基数 | 图边 | 备注 |
|---|---|---|---|---|
| attribution | `^<!--\s*attribution:.*-->$` | 0..1 | 否 | Q 闸扫此行(B17) |
| trigger(path) | `^<!--\s*trigger:\s*tool=(Edit\|Write\|MultiEdit\|NotebookEdit)(\|…)*;\s*repo=([a-z0-9-]+);\s*path=([^*\s][^\s]*\*?)\s*-->$` | 0..n | 否 | 拒 `path=*`、前缀 ≥2 段(B5) |
| trigger(cmd) | `^<!--\s*trigger:\s*tool=Bash;\s*repo=([a-z0-9-]+\|\*);\s*cmd=([a-z0-9._-]+)( [a-z0-9._:-]+)?\s*-->$` | 0..n | 否 | exe[ 子命令] 两 token,非子串(§3.1) |
| Class | `^Class:\s*\[\[(class:[a-z0-9-]+)\]\]\s*$` | lessons 1,他 0..1 | 成员边(派生) | 目标 ∈ classes.md(B6) |
| Supersedes | `^Supersedes:\s*(\[\[[a-z][a-z0-9-]*:[a-z0-9._-]+\]\]\s*[·,]?\s*)+$` | 0..1 行 | **是**(old→this) | 只写被取代者;单括号形态 = 红(B23) |
| Cause | `^Cause:\s*(\[\[(ns:tag\|archive-sha256:[0-9a-f]{64})\]\]\s*)+$` | 0..n | **是**(cause→this),反向 `effects` 派生 | 目标须存在且唯一(B10) |
| Follows | 同上,`^Follows:` | 0..n | **是**(prev→this),反向 `precedes` 派生 | 非因果先后;日期逆向只报 |
| Hook | `^Hook:\s*(\S.{0,318})$`(UTF-8 ≤320B,无控制字符) | 0..1 | **否(opaque)** | 派生 Index 行文本;缺省用 title(B14) |
| Banner | `^Banner:\s*(\S.{0,318})$` | 0..n | 否 | 仅 standinginstructions 且 `[trust:user-ratified]` 条目;横幅由此派生(B19) |
| Rules | `^Rules:\s*(\[\[ns:tag\]\]\s*)+$` | classes 0..1 | 否(注记) | 随枢纽推出 |
`Ratified by:`/`Scope:`/`Reason:`/`What happened:`/`Superseded by:` 等 = 正文惯用标签,不解析(`Superseded by:` 与派生反向边不一致只报 B29)。

**1.2a 可执行语法(权威;上表为摘要,表内 `\|` 是 Markdown 转义,不是字面)**——JS 正则,`u` 标志,逐行匹配(行 = 去掉 `\r?\n` 后的字节解码):
```
TAG      = [a-z][a-z0-9-]*:[a-z0-9._-]+
LOCATOR  = archive-sha256:[0-9a-f]{64}
TARGET   = \[\[(TAG|LOCATOR)\]\]
TITLE    = ^\*\*(?<dateISO>20\d\d-\d\d-\d\d)(?<dateRaw>[^*\n]*?)\s+—\s+(?<title>[^*\n]+?)\*\*(?<tail>.*)$
IDENTITY = 在 tail 中第一次匹配 \[(TAG)\] 的捕获(全串);无匹配 = 无身份
ATTRIB   = ^<!--\s*attribution:(?<text>.*?)\s*-->$
TRIG_P   = ^<!--\s*trigger:\s*tool=(?<tools>(Edit|Write|MultiEdit|NotebookEdit)(\|(Edit|Write|MultiEdit|NotebookEdit))*);\s*repo=(?<repo>[a-z0-9-]+);\s*path=(?<path>(?!\*)[^\s*]+\*?)\s*-->$
           约束:path 若以 * 结尾,去 * 后至少含一个 / 且非以 / 起(前缀 ≥2 段);否则为精确相对路径
TRIG_C   = ^<!--\s*trigger:\s*tool=Bash;\s*repo=(?<repo>[a-z0-9-]+|\*);\s*cmd=(?<exe>[a-z0-9._-]+)(\s(?<sub>[a-z0-9._:-]+))?\s*-->$
           约束:repo=* 时 exe ∉ {git,npm,npx,node,bash,sh,pwsh,powershell,python,py,cd,ls,cat,echo,rm,cp,mv}
CLASS    = ^Class:\s*\[\[(?<cls>class:[a-z0-9-]+)\]\]\s*$
SUPERS   = ^Supersedes:\s*(?<list>\[\[TAG\]\](\s*[·,]\s*\[\[TAG\]\])*)\s*$      (只允许 TAG,不允许 LOCATOR;其余形态 = B23 红)
CAUSE    = ^Cause:\s*(?<list>TARGET(\s*[·,]\s*TARGET)*)\s*$
FOLLOWS  = ^Follows:\s*(?<list>TARGET(\s*[·,]\s*TARGET)*)\s*$
HOOK     = ^Hook:\s(?<value>\S[^\r\n]*)$     约束:utf8ByteLength(value) ≤ 320;value 不含 U+0000–U+001F、U+007F
BANNER   = ^Banner:\s(?<value>\S[^\r\n]*)$   约束:同 HOOK(320B 限 value,不含 "Banner: " 前缀)
RULES    = ^Rules:\s*(?<list>\[\[TAG\]\](\s*\[\[TAG\]\])*)\s*$
LINK     = \[\[(TAG)\]\]  仅在"散文行"上取:散文行 = 不匹配上述任一字段的行,且位于围栏外;取链前先删除行内反引号 span(`[^`]*`)
```
golden corpus 必含逐值 oracle:多工具 trigger `tool=Edit|Write|MultiEdit`、`repo=*` 的合法 cmd(exe 不在禁用集)与非法 cmd(exe=git)、Cause 指向 live TAG、Cause 指向 LOCATOR、Follows 双目标、Supersedes 含 `·` 与 `,` 两种分隔。
**1.3 正文与链**:散文行里 `\[\[([a-z][a-z0-9-]*:[a-z0-9._-]+)\]\]` = 链(非边);行内反引号 span 与 ``` 围栏内不取(B-fixture,今日 4 处反引号内 `[[…]]` 即 P32 假阳源);裸 `[[x]]` = 红(B15,存量 0)。
**1.4 块与哈希(围栏感知)**:先做一遍围栏状态机——行首 ``` 或 ~~~(允许前导 ≤3 空格)切换 `inFence`;`inFence` 内的任何行都不是标题、不是 H2/H3、不是字段行、不取链。块 = 从标题行(围栏外、匹配 TITLE)首字节到下一个**围栏外**的 `^\*\*20`/`^## `/`^### `/EOF 的前一字节,**剔除尾部纯空白行**;文件级 BOM 在块外;CRLF 原样入哈希;`blockHash = sha256(块字节)` 全 64 hex(替代 `pmm-manifest.cjs:39` 的 `join('\n')`+16 hex)。同一输入只有一种合法切块;golden corpus 含「围栏内 `## Index`」与「围栏内 `**20…**`」两例,期望 byteRange/hash 逐字节固定。
**1.5 归档**:三 `*-archive.md` 条目逐字、无 Index、**零改写**;身份 = `archive-sha256:<64hex>`(tag 可缺可重);Cause/Follows 指向归档一律用 locator。退役 = 移动(F′,B21)。**归档条目不受 B7/B8/B8b/B8c/B13/B14/B15/B16/B22/B23 约束(09-15 补 B15/B23:归档里 3 条命中落在"禁止改写"的文件里又不在豁免表内 ⇒ 构造性不可达,A9 的 blocking=0 永远拿不到)。**豁免按 blockHash 白名单,不按文件名**:白名单 = C1 切换前已存在的归档块哈希集;F′「退役=移动」之后写进归档的**新块**不在白名单内,照常受闸 —— 否则豁免会从"历史事实免责"退化成"新写入免检"(Opus 复验风险 1)**(它们只对 live 生效;Opus C0 审 H-6:48/66 归档条目被误打 B8b)。
**1.7 tag 大小写**:TAG 的 tag 段允许 `[A-Za-z0-9._-]`(存量 3 个大写 tag 不改名);身份唯一性与链解析一律 **ASCII 小写比对**;B8c 只对 **新** 身份要求小写(Opus H-7)。
**1.8 未闭合围栏**:文件末尾 `inFence` 仍为真 = **B32 阻断**(写时/提交)并给出起始行诊断;绝不静默吞条目(Opus H-8)。
**1.6 派生量(文件里不再手写)**:Index 行与 `(superseded→[head])` 标记 · effects/precedes · heads(head 集 = 取代链可达终点集,|集|>1 = 红 B2′)· 类成员 · 冷/热(C1 = 非链头;C2 = D2:decisions ∧ 项目命名空间 ∧ >90 天 ∧ 无 live 反向链;教训只按 C1)· blockHash/lineRange/dateISO · 横幅 · 可寻址账本。

## 2. 不变量(B = 阻断,R = 只报;执行点:W = 写时 pmm-hook / C = 提交 `--diff HEAD :0` / K = 金丝雀 / D = dream 月步)

| # | 规则 | 级 | 执行点 | 来源/今日位置 |
|---|---|---|---|---|
| B1 | Supersedes/Cause/Follows 目标在全库(含归档)存在 | B | W,C | 今 `pmm-manifest.cjs:105-107` |
| B2′ | 取代图无环;每节点 head 集大小 =1(分叉允许,多终点不许) | B | W,C | 今 `:115-133`(FORK 只报) |
| B5 | trigger 形态严格。**唯一判据:第一个 `*` 之前的字面前缀 ≥3 字节且不以 `/` 起**,`*`/`**` 可在其后任意位置;拒 `path=*`/`path=**`/空;**必须能通过匹配器导出的唯一 `compileTriggerPath()` 编译**(闸与引擎共用一份实现,禁止第二份判断),编译失败即红并回显编译错误。语法与向后兼容见 `specs/GLOB-TRIGGER-SPEC.md`(Jax 09-15 拍板加 glob,不降级粒度)。**此前"只能末尾 `*`"与"(≥2 段)或(根级前缀 ≥3 字符)"两种写法均已作废**——它们与本判据不等价(`a/*` 满足"≥2 段"却不满足"≥3 字节"),09-15 建造者实施时点出该行并存两条判据、语义含糊,已按本行归一;cmd 形态 §1.2;`repo=*` 禁配常用 exe(git/npm/npx/node/bash/sh/pwsh/python/cd/ls/cat/echo/rm) | B | W,C | 今 `:156-158`(放行 `*`,P13);09-15 修订:`.env*`/`docs/*` 与中段通配(`src/lib/**/*lock*`)均合法 |
| B6 | Class 严格形态、目标在 classes.md、一条一类;lessons **新条目**(身份 ∉ HEAD)必有 Class | B | W,C | 今 `:159-172` 按标题日期(P9)→ 改按 diff |
| B7 | live 身份小写唯一(全库四文件) | B | W,C | 新;今 DUP 只报 `:174-179` |
| B8/8b/8c | `**20` 起行(含前导空白/`>`)未成条目;身份 ns ∈ ATTR;新身份非小写 | B | W,C | 今 C3 `pmm-entry-length-watch.sh:96-101`、precommit `:105` `\[[a-z]`(P2) |
| B9 | cutover 后任何真实 H2/H3 `## Index`/`### Index` 存在 = 红(围栏内不算) | B | W,C,K | 新 |
| B10 | Cause/Follows:目标唯一解析(live 用 tag,归档/歧义用 locator)、无自边、无重复边、无环;日期逆向 R | B | W,C | 新 |
| B11 | 派生 Index 总字节 | R | K,D | 新 |
| B12 | Kernel 段 ≤16KB;单 Kernel 条目 ≤5KB(今日最大 `workflow-current` 块 ≈4.4KB;超者须拆条目而非压缩) | B | W,C | 新(P15) |
| B13 | lessons 身份 ns ∈ 项目集(= lessons.md 头部 `[xxx:*]` 指针表 ∪ 固定集)= 红 | B | W,C | 今 `pmm-lessons-routing.sh:12-16` 第 8 解析器 → 并入 |
| B14 | Hook ≤320B UTF-8、单行、无 NUL/控制字符、opaque | B | W,C | 今 I 闸 `:58-60,158`(基线相对,P4/P5)→ 绝对 |
| B15 | 裸 `[[x]]`(无命名空间) | B | W,C | 今 D `:127-130` |
| B16 | 条目块 ≤900B(sole-record 免),**只对新/改块**生效:改块 = 去掉 plan 枚举的机械插入行(Hook/Banner/Supersedes/Class/身份 tag/trust)后的块字节 ≠ HEAD 对应块;C1 的 plan-only 变换**不触发**;cutover 后普通编辑触发 → 5 条存量免、零基线文件 | B | W,C | 今 `:41-52,152-155`(基线相对,P1) |
| B17 | Q:**只扫 `<!-- attribution: -->` 字段行**(与今日 Q 闸同口径;正文不扫——正文里「原话」二字常是规则本身的措辞)含「原话/逐字/verbatim」或 ≥120B 单段『』「」“”引文;KNOWN-CEILING(关键字 lint,非语义闸) | B | W,C | 今 `:61-64`(P6);09-15 修订:v2 扫正文造成 2 处假红 |
| B18 | 冗余 R1–R4 只数不判;R2 gram 索引含归档(P14);逃生口 `[redundancy-ok]` | B(R2/R3)/R | W,C | 今 `pmm-redundancy-lint.cjs` 私有解析 `:29-35` → 吃 core |
| B19 | Banner 行宿主 = standing live ∧ user-ratified;横幅总 ≤2560B;每行 ≤320B | B | W,C,K | 今 `pmm-banner.sh:7-13` 零校验(P12) |
| B20 | progress.md `## Active` ≤3000B | B | W,C | 今 `:118-121,180` |
| B21 | F′ 退役=移动:身份 ∈ HEAD live ∧ ∉ :0 live ⇒ :0 对应 archive 含同 blockHash 块;改名 = 块(去标题行)哈希相等且入链已全改(否则按退役) | B | C | 今 `pmm-precommit-gate.sh:124-175`(awk 身份 `:144`,P3 假红人口 386/404) |
| B22 | 新条目 dateISO ≤ as-of+1 天;所有条目 dateISO ≤ as-of+1 | B | W,C | 新(P9) |
| B23 | `Supersedes:` 行语法:`[[ns:tag]]` 后**可紧跟一个 `(说明)`**(说明=取代的因果语境,Jax 要求保留);多条用 `,` 或 ` · ` 分隔;**单括号 `[x]` = 红**;链接前的裸限定词(如「澄清」)= 红,须移入括号。存量 **8 行** C1 归一(3 行纯单括号走 plan ⑥;5 行含说明/前导词) | B | W,C | 新(本次发现);09-15 修订:存量实测 8 行非 4 行;禁说明文字会毁掉因果语境 |
| B24 | 旗标只认标题行 | — | 解析规则 | 今三处口径不一(P7) |
| B25 | `--index --as-of D` 同 OID 同 D 双机字节相同(排序 (dateISO desc, lineRange asc);无时区/本地时间输入) | B | K(双机),D | 新(codex 12,fab N4) |
| B26 | emit 行数 == live − 冷;fail 路径必带 `PMM-DEGRADED` | B | K | 新 |
| B27 | 指纹册含伪文件 `wiring`(settings.json 全部 hook 命令串排序 sha)+ `~/.git/hooks/{pre-commit,commit-msg}` + classes.md + `~/.claude/CLAUDE.md` + hook-manifest.txt + canary-set.tsv;册变 ⇒ 同批暂存 guard-change 收据(ref ⊇ 变更文件) | B | C,K | 今 `pmm-fingerprint.sh:14-18`(P11) |
| B28 | hook 故障语义:memory 路径闸 fail-closed(exit 2 + `PMM-HOOK-DEGRADED`);推送/回显 fail-open 但 stderr 响亮 + 本机 error 行;绝不"空输出且绿" | B | W,K(故障注入) | fab N1 + codex A5 |
| B29 | `Superseded by:` 正文标签与派生反向边不一致 | R | D | 新 |
| B30 | canonical-home:路径含 `/.claude/memory/` 但 realpath 不在 `$HOME/.claude/memory/` ⇒ exit 2 | B | W | fab2 想法 2(Kernel `[pmm:canonical-home-only]` 今只有正文) |
| B31 | 改名后无悬空链(pointer-lint A 类对 live 身份集) | B | C | 今 `pmm-pointer-lint.cjs` 只报 |
| B32 | 文件末尾围栏未闭合(inFence 为真)= 红,诊断给起始行 | B | W,C | 新(Opus C0 审 H-8) |
删除的不变量:B3(标记≠声明,`:108-114`)、B4(Index↔Entries 双射 `:138-155`)、奇偶 `p()` `:71-82`、孤儿 C `:85-90`、E-sup `:136-140`、I 基线、SessionStart 基线刷新 `:201`——它们的存在条件(手写 Index/基线文件)消失。

## 3. 想得起(每项:机制 → 可数指标 → 验收)

**3.1 推送(push,PostToolUse 全工具)**
- 触发匹配:path 同今日(`pmm-trigger-recall.cjs:130-132` 精确/前缀,repo-id 通用化 = git toplevel basename ∪ 配置映射,P33);**cmd = token-segment**:命令按未引号的 `;`/`&&`/`||`/`|`/换行切段;每段剥 `VAR=val`、`sudo`、`timeout N`、`env`、`command`、`nohup`,`bash -c "…"`/`sh -c` 递归一层;exe = 首 token basename 小写去 `.exe`;sub = 首个不以 `-` 起的后续 token;命中 iff exe 相等 ∧ (trigger 无 sub ∨ sub 相等);引号不平衡/heredoc 解析失败 ⇒ matched=0。命令文本只记 sha256。
- 名额:每事件 **含直接命中共 ≤3 行、≤1.2KB**;同 tag 每会话一次(保留 `.trigger-seen-<sid>`,不退化成每回合);每会话新 tag ≤12。邻域固定序:① 直接命中(沿 head)② 每条的 Cause 目标与 effects(标「因/果」+「较早/较晚」by dateISO)③ Follows/precedes ④ 类枢纽命中 → 只给成员计数 + `pmm-search "class:x"` 指针,**不填成员**(改今日 `:177-187`)。
- 日志(impression 台账):`ts sid impression-id trigger-id(身份+序号+trigger 行 sha) repo rel|cmd-sha tag source(direct|cause|effect|follows|class) position`;matched=0 与 suppressed 写本机未跟踪文件(P24:入库行 3,537→≈35/天);阳性入库分片按机器。
- 反馈:`bash ~/.claude/guards/pmm-feedback.sh <impression-id> useful|irrelevant`,一曝光一票(后写覆盖,计一次);提示文案改「不相关请跑 …feedback <id> irrelevant」。
- 降级议案(dream 月步,脚本**绝不改 trigger**):某 trigger 已标注曝光 ≥30 ∧ 会话 ≥10 ∧ 双机各自最近 30 天每日心跳行完整 ∧ useful 精确率 <80% ⇒ 议案;未标注 = UNKNOWN。渠道整体日落 = 同判据下 Jax 裁定(D5 定稿,见 §8)。
- 指标/验收:曝光数、useful 精确率、每千回合噪音行;cmd 触发先只记 impression 不注入,取得 ≥200 条 Bash 事件误报基线后才启用注入。

**3.2 拉取(pull,`pmm-search.sh` v2 吃 core 快照)**
- 排名确定性:`score = Σ 字段命中 × 权重`——身份全等 1000 · 身份子串 100 · 标题 token 10 · Hook token 8 · Class 名 5 · 正文 token 1;图 rerank:链头 +2、被取代 −5(仍可见,标「已被 [head] 取代」);分词 = NFC + ASCII 小写按 `[^a-z0-9._:-]` 切 + CJK 二元组;同分按 `(dateISO desc, 文件序 dec<les<std<classes<archives, lineRange asc, tag asc)`;top-k=8;命中附邻域:head、Cause/effects、Follows/precedes、同类计数、同类时间线前后各一条。语义通道(gbrain)照旧并行、只定位。
- 热度:仅「查询串全等身份」的主命中记 heat-resolved(P19);其余命中记本机 retrieval-impressions(query sha256 + 命中身份),不伪装成零热度。
- 指标:canary-set(今 29 行)+ 图题(给 tag 答 Cause/effects、给 tag 答现行 head、归档 locator、分叉/环、同日、多 Cause、无结果负例)全为 CLI/JSON 断言;报 Recall@1/Recall@3/MRR/0-hit 率;验收 = C0.5 记录基线,C1 后不降。

**3.3 压缩后工作集恢复**:本机 `.pmm-workset-<sid>.tsv` 记本会话 feedback=useful 的身份 + 经 pmm-search 取过全文的身份;SessionStart 在同 sid 重跑(= 压缩后,`pmm-autopull.sh:79-86` 已实证)时注入 ≤12 条「工作集恢复」(标题+head 解析),不注全文。指标:retained-tag 覆盖率(目标 1.0)、压缩后重复检索率。
**3.4 零命中回放**:pmm-search 0-hit ⇒ 本机 `zero-hits-<mach>.tsv`(日期、query sha256、规范化 token 列);`pmm-search --replay` 在索引/Hook/身份变化后确定性重放;指标 0-hit recovery rate(dream 月报)。
**3.5 可寻址账本**:`pmm-core --ledger`:每 live 条目可达路径 {tag, Hook/标题 token ≥3, path trigger, cmd trigger, class, 入/出边};仅 tag 可达 = 孤儿;报 live 孤儿数、user-ratified 孤儿数;canary 报趋势,dream 提议补 Hook/trigger(提议不自动写)。
**3.6 横幅(D4 节奏)**:全文 = 头行 + 所有 `Banner:` 行(派生,B19);SessionStart(含压缩后重跑)与每第 5 次 UserPromptSubmit 注全文,其余回合一行 `🎗️ 铁律 tag: [a] [b] …`(≤200B);计数器 `.banner-turn-<sid>` 本机,SessionStart 清零。指标:每 100 回合横幅字节(今 ≈165KB → ≈67KB)。**C1 迁移把 banner.md 7 行按字节搬为 4 条 standing 条目的 `Banner:` 行**(总方针/①/④ → `process:workflow-current`;② → `process:review-effort-tier-table`(它在 Entries 区,须带 `[trust:user-ratified]`,今日已带则零改);③ → `process:subagent-model-visibility`;⑤ → `process:workstyle-core`),删 banner.md。

## 4. 提交层与 hook 层

- **core 单库** `guards/pmm-core.cjs`(`require` 复用,零 CLI 私有正则):`snapshot(view)`(view = `worktree|HEAD|:0`,文件清单 = `git ls-files --cached ':(glob).claude/memory/*.md'` 同 `pmm-precommit-gate.sh:188`;`git show` 原始字节;剥 BOM;按 `\r?\n` 切行但哈希用原字节)→ `{schemaVersion:3, sourceOids, entries[{id,file,lineRange,byteRange,blockHash64,dateISO,dateRaw,title,hook,banner[],attribution,trust,sole,ok,class,links,triggers[],supersedes[],cause[],follows[],effects[],precedes[],head,archived,body(原始字节 utf8)}], edges, heads, cold, blocking, report, diagnostics}`;`check/index/diff/ledger/search/feedback` 全在库内;CLI 薄壳:`pmm-manifest.cjs`(保留名)、`pmm-hook.cjs`、`pmm-index-emit.sh`、`pmm-migrate-v3.cjs`、`pmm-search.sh`(调 node)、`pmm-feedback.sh`。
- **统一 hook** `pmm-hook.cjs`,`settings.json:100-126` 三条目(`:106,110,114` + NotebookEdit `:123`)合一,matcher `Edit|Write|MultiEdit|NotebookEdit`:① 1 秒读 stdin(同 `pmm-entry-length-watch.sh:22`)② 路径 `\\→/`、折叠 `//`、`path.resolve`、`realpathSync.native`(try)、小写;`isMemory` = realpath 含 `/.claude/memory/`;原串含 `memory`/`claude~` 而 realpath 失败 ⇒ 按 memory 全跑(默认失败方向)③ B30 ④ 一次 `snapshot('worktree')` fan-out:isMemory ⇒ 闸(§2 W 列)→ 回显 → routing(B13);所有工具 ⇒ 推送(§3.1)⑤ 故障语义 B28。每次编辑 1 进程(今 3)。
- **precommit** `pmm-precommit-gate.sh` v3:`core --diff HEAD :0` ⇒ blocking(B21 F′、新条目 B6/B22、改块 B16/B14/B12 绝对、B7/B8/B9/B10/B23/B31)+ G 备份漂移(`:197-224` 原样)+ B27。删 `check_file`(`:91-108`)、`check_retire`(`:124-175`)、E2 沉井(`:180-195`,含 `:189` 默认真基线)。**删除 `.pmm-len-baseline{,.idx,.quote}`**——P1/P5 失去存在条件。`git rev-parse`/`git show` 无会话状态。
- **commit-msg** 新钩子 `~/.git/hooks/commit-msg → pmm-commit-msg.sh`:trailer `PMM-Receipt: <id>[,<id>…]`;每 id 必须在 spool 且其 `ref`(tag/path/hash)出现在 `:0` 快照(身份 ∪ 链 ∪ 暂存路径),否则拒;通过 ⇒ 写 covered `via=commit`(post-commit 回填 sha);`cover` 逐张要求「提交时间 > 收据时间」(修 `pmm-receipt.sh:69-75` 一刀切,P10);普通 prompt 裁定保持 pending(KNOWN-CEILING,P18),原话本机 spool `.prompt-spool-<sid>.tsv`(UserPromptSubmit 逐字前 300 字,不入库,autopull `:96` 同扫)。
- **注入** `pmm-index-emit.sh`(SessionStart 排 autopull 后、size-watch 前;`/read-pmm` 第 4 步与 `pmm-codex-session-start.sh:28` 同调):`config.md:94,98,106` 三文件改 `skip`(Kernel 全文改由 emit 打印 `## Hot` 段);正常 = core `--index --as-of $(date +%F)` 并写 LKG `~/.claude/.pmm-index-lkg/<sha(sourceOids+schemaVersion)>.txt`;core 失败 ⇒ 首行 `🔴 PMM-DEGRADED <err>`,用 LKG(key 命中才用),无 LKG 再退标题行(仍带 🔴);LKG 只服务注入,永不参与闸。`pmm-autopull.sh:76` 文案改「注入由 pmm-session-start/index-emit 完成」(P23)。

## 5. 迁移:C0(代码影子)→ C0.5(运行时影子)→ C1(一次切换)→ C2(删旧)

**C0(不接线、不拦、不改内容)**:core + `pmm-migrate-v3.cjs --plan|--apply --dir <副本>|--verify --before --after --plan <file>` + golden corpus + `pmm-manifest-shadow.sh` + 金丝雀 1 行(EXPECTED 37→38)。
- 影子对照 allowlist(Opus H-5/H-9 修订):差异只许 = ① 6 条 `[user]`(v2 新识别)② **B23 行集合**(单括号或 `[[tag]]` 后带说明文字;v1 对其中双括号形态**仍解析成边**,故这些边在 onlyV1 里出现并以 B23 诊断解释;⑥ 归一后消失)③ ⑧ 的行(v1 解析成边、v2 不建边,标「⑧ 有意删除」)④ 归档:v1/v2 归档条目集也必须对照(按 blockHash),差异只许是 v2 新识别的无闭合 `**` 条目并逐条列出;**onlyV2 一律不得无条件判"已解释"**。比对以**身份/边的集合**为准,不比条数。
- 金丝雀行(Opus H-3 修订):**不得在行内重跑 `--plan` 后再查文件存在**。正确形态:`plan=guards/specs/PLAN-<oid>.json` 中的 oid 必须 == `git rev-parse HEAD:.claude/memory`(树 OID 漂移 ⇒ 红,提示重生成并重审)∧ 用该 plan 跑 `--verify --stage c0` 于临时副本 ∧ shadow 零意外差异。`--plan` 的 CLI 解析必须与 `--verify --plan <file>` 区分(Opus H-2:参数位置解析错误导致 verify 触发 plan 并覆盖 plan 文件)。
- 派生 Index 必须真渲染(Opus H-1):`renderIndex` 只有在传 `--legacy` 时才直通旧 `## Index`;默认渲染派生视图;C0 自测含「真库派生 Index 与旧 Index 按 plan 映射归一后逐字节相等」(A7 口径)。
**golden corpus(`guards/fixtures/v3/*.md` + 期望 JSON,字节精确)**:class 身份 · attribution-only 标题 · `[user]` 无冒号 · sole-record-only 标题 · 同文件/跨文件重复 · Index 续行 · 正文示例 `[[ns:tag]]` · 反引号内 tag · ``` 围栏内 `## Index` 与 `**20` 标题 · BOM · CRLF · 无尾换行 · `(晚)` dateRaw · marker-only · 非标 marker · 单括号 Supersedes · 部分取代说明文字 · archive 无 tag 条目 · Cause 悬空/自边/重复/环/归档 locator · Hook 超长/含换行/含 `[[链]]`(须 opaque)· Banner 在非 user-ratified 条目 · 未来日期 · 前导空格/`>` 标题 · 大写 tag · 多终点分叉 · 空文件 · 只有标题无正文。每条红/绿各一,期望输出逐字节。
**C0.5(运行时影子;旧行为仍权威)**:`pmm-hook.cjs --shadow` 作第 4 条 PostToolUse 挂上,输出只写本机 `shadow-hook.log` 并与旧三进程输出比对;precommit 加 `--shadow`(算 `--diff` 只记日志);`pmm-index-emit.sh --shadow` 写本机文件并记「派生 vs HEAD Index 归一化 diff」;pmm-search v2 只记 impression;故障注入夹具(core throw / 单消费者 throw / stale LKG / Windows 路径变体 `/./`、`/../`、8.3、UNC、大小写)。**退出判据**:双机合计 ≥200 条事件(含项目编辑、记忆编辑、NotebookEdit、Bash)零未解释差异连续 7 天;precommit 影子对最近 30 笔真实提交 + 红绿夹具判决一致;检索基线 Recall@k 已记录。
**plan 与 apply 的契约(Opus C0 审 B-1/B-2/B-3 后钉死)**:`--plan` 是唯一的判断点,产物 `PLAN-<treeOid>.json` 必须**逐条**记录:动作类型、文件、条目 blockHash64、**旧标题行 sha256**、字节区间、旧字节、新字节;①③④⑬ 的映射(标题 hash → 新 tag)在 plan 里显式写死,D1 表的匹配只在 `--plan` 阶段发生,且**同分/歧义 = 拒绝并列出候选**(不取先遇者);`--apply` **只消费 plan**:先校 `plan.treeOid == 当前 --dir 树 OID`(或 `--dir` 的 HEAD 副本 OID)与每条编辑的旧字节逐字节相等,任一不符即拒;apply 不得重跑任何匹配;A10 幂等断言必须真跑(二次 apply 对同一 plan 的每条编辑因旧字节已不匹配而**全部跳过**且产物零 diff——不是硬编码 PASS)。
**故障语义(Opus B-4)**:`git show` 失败、文件缺失/不可读、空快照、树 OID 不可得 ⇒ core 抛错,CLI 非零退出并打印 `PMM-CORE-ERROR <原因>`;`--check`/`--index`/`--diff` 永不"空输出且 0";缺文件时 `report` 必含缺失文件名。
**C1(唯一一次内容切换,一个提交)**——`--apply` 字节动作全部可枚举、来自 plan:
① 24 条标题闭 `**` 后插一个 `[ns:tag]`(D1 表命名)② 6 条 `[user]`→`[user:jax]` ③ 同文件重复第二条改名 2(dec:929、dec:1170;D1)④ 跨文件双写 3 对:decisions 版改名 `-decided` + 双方各加一行互链(D3)⑤ Index 行 REST(剥日期/tag/marker,trim)≠ title 者加 `Hook: REST`(plan 报数;不写死 ≈180)⑥ 单括号 `Supersedes:` 归一:dec:437、dec:493、std:33 → `[[…]]`(std:33 三目标须在归档存在,否则列人)⑦ 无声明 marker-only 1:`axervice:prod-db-shared-until-10-subs` 加 `Supersedes: [[axervice:prod-db-dedicated-account]]` ⑧ dec:391「部分取代」与 dec:53/54「澄清」marker → 正文 `参见: [[…]]` 链,**不建边**。**事实更正(codex 实跑):今日 manifest 把 `Supersedes: 澄清 [[watchdog…]]` 当正式取代边(campaign→watchdog 存在于 `--json` 的 supersedes),dec:391 亦然;因此 ⑧ 是有意删除 2 条现有机器边,不是"保持现状"。**C0 影子对照的 allowlist = 6 条 `[user]` 新识别 + 4 行单括号 Supersedes(v1 不认、v2 B23 红)+ **⑧ 的 2 条边差(v1 有、v2 无)**;A5 差集必须逐条列出这 2 条边并标「⑧ 有意删除」(见 §10 决策 1)⑨ `(晚)` 移入该条 Hook 前缀 ⑩ 2 行 >320B Index(dec:106/112)→ 人工提炼 ≤320B Hook(D1,Jax 读)⑪ banner.md 第 2–7 行 → 4 条 standing 条目的 `Banner:` 行(§3.6;320B 限 value),**同笔删 banner.md(C2 不再重复此动作)** ⑫ 删三处 `## Index`/`### Index` 段(std 的在 `## Hot` 内 `:112-154`)⑬ `process:review-effort-tier-table`(std:165,Entries 区,attribution 已记 Jax 08-06 拍板)标题行追加 `[trust:user-ratified]`——这是 B19 允许它承载 Banner 的前提,列为 A3 允许的第 5 种标题差异、A6 的显式例外。同提交:precommit 切 `--diff`、`config.md` 三 skip、emit 接线、pmm-hook 转正(旧三行接线删)、EXPECTED 改数、cutover 日期写进 core(B9 生效)。**其余字节一律不动。**
**`--verify` 断言(fab 10 + codex 12 去重 = A1–A22,任一失败 exit 2)**:
A1 正文守恒**逐条配对**(plan 身份映射 old→new):块去标题行、去新增字段行后的字节相等 · A2 **plan 外字节全等**:对 HEAD 字节施加 plan 列出的编辑区间必须逐字节 == staged(含 BOM/LF/CRLF/尾换行/空行;subsume fab 2)· A3 标题 diff 只允许 ①②③④⑬ 五种且只在 plan 行 · A4 Index 文本守恒 multiset(HEAD REST)== multiset(staged Hook ∪ 无 Hook 者 title) per 文件;std 38 行按 (dateISO,文本) 配对,配不上的列人 · A5 边守恒:staged 声明边 == HEAD v1 实跑边集(含标准 marker 与被 v1 解析的「澄清」行)∪ HEAD 单括号整条声明(⑥ 归一)− {⑧ 的 2 条边};差集逐条列 plan 并标注来源 · A6 每条目 dateISO/dateRaw/trust/sole/ok/attribution/trigger/Class/links multiset 相等;显式例外只有:④(互链 3 对 = 6 条新增 links)、⑧(2 条 `参见:` 新增 links)、⑬(1 条 trust 新增)——逐条枚举于 plan · A7 派生 Index 与旧 Index 的对齐**按 plan 映射**(旧 Index 行 → 目标条目身份;std 35 行无 tag 者用 (dateISO,文本) 配对结果),对齐后 REST 逐字节相等;例外只有 ⑨(1 行)⑩(2 行),显式批 · A8 三 archive sha256 不变、classes.md 不变、banner.md 删除且 multiset(Banner value)== banner.md 第 2–7 行 · A9 staged `--check` blocking=0、live == plan.live、B7/B8/B23=0 · A10 幂等:`--apply` 二跑零 diff · A11 `git diff --numstat` 上限 == plan 计算值 · A12 Hook/Banner opaque:links(staged) == links(HEAD) ∪ A6 枚举新增 · A13 反引号/围栏 tag 不入身份/边(4 处实例 + 夹具)· A14 dateRaw 逐条守恒 · A15 未在 plan 内的块:块字节与 blockHash 前后相等;byteRange **允许位移**,但每块新偏移必须等于「旧偏移 + plan 推导的位移」(删 Index 段、插字段行的累计字节数)· A16 B10 图不变量 staged 全绿 · A17 B14 Hook/Banner 字节/控制字符 · A18 B9 只认围栏外真实 H2/H3 · A19 C0.5 故障注入矩阵已绿(**C1 前置,不属 C0 自测**)· A20 plan `treeOid` == `HEAD:.claude/memory`,不等即拒 · A21 双机同 OID 同 as-of `--index` sha256 相等(**C1 前置**)· A22 emit 行数 == live − 冷 ∧ LKG 写成且 key 命中(**C1 前置**)。
**verify 分期**:`--verify --stage c0` = A1–A18 + A20(对副本目录;C0 自测的确定通过条件);`--verify --stage c1` = 全部 A1–A22。
人工只剩:D1 命名表复核、std 配对残差、⑧⑩ 三行文本、Banner 行归属。
**C1 硬前置(Opus 09-15 复验裁定;七条均不阻 C0.5,但 C1 切换前必须逐条关闭并留实跑证据)**:
1. **B-1′ apply 写入安全**:275 条编辑里 **264 条是纯插入**(`deleteLen==0`),`oldBytesBase64` 恒为空串,`raw.slice(off,off+0)` 对任意 offset 都等于空串 ⇒ 逐条旧字节校验**对纯插入恒真**。实证:把 `edits[0].offset` 人为 +7,`--apply` 仍 exit 0 写满 275 处且产物指纹 ≠ `contentFingerprintAfter`,apply 自身毫无察觉(靠下游 A10 才翻红)。修法两条缺一不可:apply 逐条复核 plan 的 `titleLineSha256`;**写完后断言产物指纹 == `contentFingerprintAfter`**。**09-15 实证结论:该洞未堵上,`70f67005` 的说法不成立。** 主会话独立复现(`audits/FABLE-2026-09-15-b1prime-confirmed.md`):291 条编辑里 280 条纯插入,只把 `edits[0]` 的 offset 由 118714 改成 118721,`--apply` **退出码 0**、写满 3 文件、零诊断。根因是 `titleLineSha256` 校的是 `titleLineNo` 那一行本身,**未把 `edit.offset` 绑定到该标题行**;且**写完之后**不再算一次产物指纹去断言等于 `contentFingerprintAfter`(该字段并非没被读:`:746` 要求 plan 带它、`:765` 用它做幂等短路;缺的只是写后那一步)。另有独立问题:`:766-768` 的注释把「旧字节在新位置会匹配失败」当作幂等成立的机制,而这对纯插入不成立(空 oldBytes 处处匹配),真正生效的是整份指纹短路——错误理由若被后人当真而移除短路,幂等会当场失效。下游 `--verify` 16 通过 2 失败,**唯一抓住它的是 A10 且为间接**(靠二跑 apply 指纹不匹配反推),而 **A2「plan 外字节全等」在被污染产物上通过**——它重放的是同一份被篡改的编辑,自己跟自己对账。`--self-test` 当时 20/20 全绿含 12 项 break-测试,**无一项覆盖偏移挪动**。⇒ 修补要求见审计档五条,其中 self-test 必须新增「挪动纯插入 offset ⇒ apply 拒绝」的阳性对照。
2. **H-9 影子归档比对**用 `(file,id)` **集合**,12 条重名归档条目被静默折叠(带 id 59 + 无 id 76 = 135,而 key 只有 47,`47+76=123≠135`);改为**逐条目**对账,代码注释自称的「every archive entry must be accounted for」才成立。
3. **A13/A18 仍是硬编码 PASS**;`applyEditsToBuffer` **无区间重叠护栏** —— 纯插入的空 oldBytes 使重叠无法被逐条校验发现,必须独立加区间不相交断言。
4. **`isCold` 与 `renderIndex` 大小写口径不一**(前者区分大小写、后者用 `idKey`)。§1.7 刚放开大写 tag 段,一旦出现大写合法身份,同一条目会被判「冷」却不标 `(superseded→)`。统一走 `idKey`。
5. **「文件存在但内容为空/被截断」今天被当合法输入** —— 空/截断 decisions.md 都给 `blocking=25 exit 2`,**退出码碰巧非零但理由是错的**,无一条诊断说文件不完整;金丝雀的 `git show … || true` 在 git 失败时会留下 0 字节文件而不报错。须显式判 `-s` + 专属诊断码,B-4 只堵了「缺文件」没堵「文件在但内容没了」。
6. **归档豁免改按 blockHash 白名单**(见 §1.5),防 F′「退役=移动」写进归档的新块永久免检。
7. **语料是移动靶**:并发会话 09-15 当天两次自动存盘,树 OID `3ac657b7→46e8ef0e→0109e2e9`,同一条 `--check` 三次给出三组行号。⇒ plan/pin 必须在切换前按当前 OID 重生成;任何跑 plan/apply/影子对照的批次,**开工与收工各取一次 `HEAD:.claude/memory`,不一致即整批作废重跑**,绝不交跨快照拼出来的产物。
8. **每个 `--self-test` 必须自带 synthetic-must-fail 臂**:09-15 实证 `pmm-precommit-gate.sh --self-test` 因夹具的手写文件清单漏拷新依赖 `pmm-trigger-recall.cjs`,子进程以 `MODULE_NOT_FOUND` 崩溃,而其 stderr 被 `2>/dev/null` 吞掉 ⇒ **自测照样报绿,实际一项都没测**。金丝雀自己早有这个臂(`guard-canary.sh:199-206` 的 `synthetic-must-fail`/`must-pass`),各守卫自测没有。缺它时「工具没跑起来」与「工具跑了且没发现异常」在退出码上不可区分,这正是本仓库反复付费的那一类。同族:夹具输入集必须从真相源派生而非手写清单。
9. **同点多插入必须有显式排序契约**(09-15 实测):真实 plan 的 291 条编辑里,`(file@offset)` 去重后 286 个键,**有 5 处同一文件同一 offset 的合法插入**,全部 `deleteLen=0` —— `decisions.md@60958`、`@61468`、`@78412` 是 ④+⑤,`@63138`、`@101677` 是 ⑤+⑦。三条要求:①**区间不相交断言绝不能写成「同 offset 即冲突」**,那会拒掉这 5 处、拦死真实 C1(第二轮修复正确地拒绝了简报里「`>` 改 `>=`」的字面要求,只修了与实现矛盾的注释——**照字面改会把生产搞坏,属于辩护方该拦下的假修法**);②但**同点插入的先后决定产物字节**,该顺序必须由 action kind **显式定序**并写进契约,不得依赖数组下标或 plan 生成顺序,否则重生成 plan 时顺序一变产物就变,而指纹会"正确地"跟着变、无人察觉;③break-测试须覆盖「交换同点两条的先后 ⇒ 产物不同 ⇒ 必须被独立重导或指纹捕获」。
**双机协议**:两机停写(关会话);各 `git -C ~ pull --ff-only`;A/B 同 OID(核 `HEAD:.claude/memory`);A 跑 apply+verify+commit+push;B ff 拉后跑 `--verify --plan` + A21;失败 = **A 一人 `git revert C1` 并 push,B 只跟随**;emit 带 `--legacy`(文件有 `## Index` 即直接打印它)保证 revert 后注入不断;LKG 按 OID key 自动失效;C2 前旧脚本仍在盘上。
**C2(验证窗 7 天/≥2 机后,删旧;指纹 refresh + 收据)**:删文件 `pmm-entry-length-watch.sh`、`pmm-lessons-routing.sh`、`guards/pmm-supersede-fixture-test.sh`(banner.md 已在 C1 ⑪ 删)、`_local-config` 同名备份、`pmm-manifest.cjs` v1 正文(壳保留);删 `pmm-precommit-gate.sh:91-108,124-175,180-195`;删私有正则 `pmm-trigger-recall.cjs:82,93-119`、`pmm-write-echo.cjs:35-44`、`pmm-redundancy-lint.cjs:29-35`、`pmm-pointer-lint.cjs:41-49`(定义集改 core 身份集)、`pmm-fade.cjs:83`(`includes`→精确)、`pmm-grep.sh:48`(heat-resolved 改 pmm-search v2 记)、`pmm-manifest.cjs:47,60-70,138-155`;删 `DREAM-PROMPT.md:33-34`(Index 校验/孤儿检测);金丝雀删 #18 #19 #20 #21 #22 #23 #24(`guard-canary.sh:106-130`)与 C0 plan 行;`settings.json:100-126` 三 hook 行→一行;`hook-manifest.txt` 同步;emit `--legacy` 分支删除。

## 6. AxMem(不计成本;同一架构、一次抽取)

- **core**(`axmem-core`,semver;schemaVersion 3):schema + parser(§1)+ graph(edges/heads/cold)+ ranker(§3.2)+ index/banner/ledger 渲染 + diff(§4)+ migrate(`axmem migrate v3 --plan/--apply/--verify` = §5 同一实现)+ golden corpus(§5 夹具即产品夹具,adapter 全跑同一套)。
- **adapters**:cc(hook JSON、settings 接线、pre-commit/commit-msg 安装器)· codex(`pmm-codex-session-start.sh` 形态:pull→emit→permanent)· hermes(只读 emit;SOUL.md「CC 记忆只读」不变)· generic(CLI `axmem emit|check|search|feedback|ledger`,stdin/stdout,无 hook 假设)。**不复制 PMM 绝对路径与 hook JSON 假设进 core**。
- 文档:目标形态 + 迁移 + 不变量表(§2)+ 指标定义(§3);每件带自测与生产形态夹具。

## 7. 维护面(前/后)与名册

| 面 | 今 | 后 | 备注 |
|---|---:|---:|---|
| 语料解析器 | 8(+pmm-grep 热度正则 1) | **1** | manifest/trigger/echo/redundancy/pointer/entry-length awk/precommit awk/lessons-routing → core |
| manifest 外 grammar/regex 识别点 | codex 计 47(本文点名 ≥20 处) | **0** | §5 C2 清单 |
| 手写 Index 行 | 394(207+149+38) | **0**(≈180 Hook 行在条目内) | |
| 校验基线文件 | 3 | **0**(LKG 缓存不参与放行) | |
| 每次编辑 hook 进程 | 3 | **1** | |
| 身份世代 | 混杂 | 1 | |
| 手写横幅文件 | 1 | 0(Banner 字段派生) | |
| 顶层金丝雀 | 37 | **33** | 删 #18–#24(7)+ #11 改「core 自测(golden corpus)」+ 加「pmm-hook 红/绿矩阵」「派生 Index 行数==live−冷」「检索金丝雀 Recall@3≥基线+图题」;C0 plan 行在 C1 撤下沉入夹具 |
| 指纹册 | 80 | ≈80 + 伪文件 wiring + 5 高权面 − 删文件 | B27 |
| 不变量条数 | 25 | 31(集中在一套 schema/test suite) | 减法在结构,不在条数(codex ✓) |
| 遥测入库 | ≈2,490 行/天 | ≈35 行/天 | 阳性 stage 入库 |

## 8. 分歧裁定表

| 分歧点 | fab | codex | **裁定** | 一句理由 |
|---|---|---|---|---|
| 身份 | 位置规则(闭 `**` 后首 ns-tag) | 撤回 UID+registry,同意 | **位置规则** | 无发号问题;registry = 第二个手写 Index |
| class 是否身份 | 是 | 是(主会话候选笔误) | **是** | 14 枢纽以 class 为唯一身份 |
| Effect 手写 | (未提) | 派生 | **派生 effects/precedes;手写只有 Cause/Follows** | 反向边手写 = 双写源 |
| Follows 边 | (未提) | 加 | **加(0..n)** | 非因果先后无处表达 |
| cmd 触发 | 纯子串 | NO-GO,token-segment | **token-segment(§3.1)** | `echo "git commit"`/注释/搜索文本必误中;样本 0 无从声称误报率 |
| fail-open 注入 | 只打印标题 | 响亮降级 + LKG | **LKG + `PMM-DEGRADED`,标题为末路** | 静默退化把召回损失伪装成成功 |
| archive 身份 | blockHash 16 hex | 64 hex + locator | **64 hex + `[[archive-sha256:]]`** | 跨生命周期边不能引可缺可重的 tag |
| 邻域名额 | 名额 3 补位;TARGET 写「每回合每 tag 一次」 | 含直接命中共 3、≤1.2KB、≤12/会话、同 tag 每会话一次 | **codex 版** | 今日 seen 语义已是每会话(`:136-157`),退化成每回合 = 墙纸 |
| 类枢纽补位 | 最近成员 | 只计数+指针 | **只计数+指针** | 弱相关成员填空位 = 噪音 |
| 反馈键 | `<tag>` | `<impression-id>` | **impression-id** | 否则无法归因到具体 trigger |
| D5 日落 | 30 天零阳性即砍 | 足量曝光+完整覆盖才出议案 | **codex 版;砍渠道 = Jax 裁定** | 零曝光/零标注也是零正例 |
| 切换节奏 | 两提交 C0/C1 | 代码先影子、语料一次切 | **C0 → C0.5 影子 → C1 → C2** | fab 自己的 N1 要求影子对照;codex E 反对 C1 同切数据与未影子路径 |
| 消费者去正则时机 | C1 后第 3 步 | C1 前完成影子 | **C0.5 影子、C1 转正、C2 删旧** | 同一快照必须在切换前被六消费者吃过 |
| plan 数字 | 写死 24/6/3 | 绑 OID | **绑 OID**(D1 行号已陈旧 +7) | 语料已漂 418→419 |
| `(晚)` | 例外批准 | dateRaw 守恒 | **dateRaw 字段守恒 + 该 1 行 Index 归一例外(D1 已裁)** | 标题本无 `(晚)`,只在 Index 行 |
| Hook 内链 | (未提) | opaque | **opaque(A12)** | Index REST 含 15 行附加 tag,不是关系 |
| 横幅 | banner.md 每行 tag ∈ user-ratified Kernel | 从 Kernel Hook 派生 | **`Banner:` 字段派生(§3.6),删 banner.md** | Hook 是检索钩子且 ≤320B/条,而 workflow-current 需 3 行 813B;② 指向非 Kernel 条目,按 fab 判据今天就红 |
| 「澄清」/「部分」标记 | 转标准 marker(D1) | (未提) | **转正文链、不建边** | 今日机器上都不是边;建边会让 watchdog 裁定被判「已取代」而它仍现行 |
| 单括号 `Supersedes:` | (未发现) | (未发现) | **B23 新增;4 行 C1 归一** | 今日 3 条 Kernel 取代关系对机器不存在 |
| B16 900B 绝对化 | 提交层绝对 | — | **绝对但只对新/改块** | 5 条存量不被逼改写,基线文件仍归零 |
| 不变量数量 | 25→? | ≥32 | **31,不当指标** | 减法在解析器/工件/进程 |
| Q 闸 | 搬进 manifest + KNOWN-CEILING | 同 | **B17 阻断如今,声明上限** | 今已绝对(`:161-164`) |

## 9. 建造顺序(每步独立提交;builder=Sonnet;codex 只审(Kernel §1「不建码」);建者≠审者)

| # | 步 | 交付物 | 审者 | 验收 |
|--:|---|---|---|---|
| 1 | **C0 core+迁移器** | `pmm-core.cjs`、`pmm-migrate-v3.cjs`、golden corpus、`pmm-manifest-shadow.sh`、金丝雀 plan 行、`guards/specs/PLAN-<oid>.json` | codex(read-only,09-19 后)+ Opus | 自测全绿;真库零改动;plan==§0 数字;shadow 差异只有 6+4+已列;38/38 |
| 2 | **C0.5 运行时影子** | `pmm-hook.cjs --shadow`、precommit `--shadow`、`pmm-index-emit.sh --shadow`、pmm-search v2(impression-only)、故障注入夹具、检索基线报告 | codex + Opus;**fab 盲攻 #4** | §5 退出判据;Recall@k 基线入 `guards/specs/` |
| 3 | **C1 切换** | apply 产物 + A1–A22 报告 + 接线/EXPECTED/config 改动,双机协议记录 | Opus 独立重跑 verify;codex 审 diff;Jax 读 §5 人工四项 | 22 断言绿;双机 A21;金丝雀绿;revert 演练一次(影子副本) |
| 4 | **C2 删旧** | §5 C2 清单、指纹 refresh + 收据、hook-manifest | codex(低风险)+ code-reviewer | 名册 33/33;`grep` 全库无旧正则;fab 盲攻 #5 |
| 5 | **想得起 B 组** | Cause/Follows 写入纪律(config ① 一句)+ B10;cmd 触发(impression-only)+ 反馈 + 台账;pull 排名 + 邻域;工作集恢复;零命中回放;横幅节奏 | codex + Opus;每件 Sonnet 建 | 各指标可数且有基线;cmd 注入启用条件 §3.1 |
| 6 | **C2/C3 小活** | commit-msg trailer、原话 spool、遥测节食、autopull 文案、盲攻按提交区间、pointer-lint 迁移指针核验、Q/pointer KNOWN-CEILING 文本 | code-reviewer + codex | 各 ≤50 行,自测 |
| 7 | **检索金丝雀加题** | 图题 + Recall@k 报告入名册 | codex | 33/33 |
| 8 | **AxMem 抽取** | core 包 + 4 adapter + 同一 golden corpus + `axmem migrate v3` + 文档 | codex + Opus(架构)+ 安全审(adapter 接线) | 4 adapter 跑同一夹具全绿 |

## 10. 剩余 owner 决策(其余全部在本文裁定)

1. **⑧ 两处关系不建边**:dec:53/54「澄清」与 dec:391「部分取代」按「参见链、非取代」处理(watchdog 收尾裁定与 campaign-continues **并存现行**)。
   **裁定(主会话,2026-09-15,Jax 已授权工程决策):确认「参见链、不建边」。** 理由:watchdog 的裁定是"系统侧收尾、注意力转销售",campaign-continues 澄清的是"campaign 不因注意力转移而停"——两条同时为真,后者不推翻前者;建取代边会让一条仍现行的裁定被 redirect。C1 ⑧ 按此执行。
