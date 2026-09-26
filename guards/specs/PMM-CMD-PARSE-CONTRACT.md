# `pmm-cmd-parse.cjs` 契约:v1.1(已落地,钉死)与 v1.2(管道闸 v2 前置)

单一真相源:M0 impression 钩子与管道闸 v2 都只消费本文定义的形状;任何消费者不得自带分词。
codex 审管道闸 v2 简报 HIGH-2 指出「磁盘上的 M0 简报只承诺 `{dialect,index,exe,sub,parse_status}`,扩展字段只存在于对话消息里」——本文即写回。

## v1.1(已落地 `pmm-cmd-parse.cjs`,提交 `b3123bd`;主脑 2026-09-16 17:12 用真实调用核实形状)
```
parseCommand(cmdText, {tool:'Bash'}) → { parser_version: '1.1', segments: [Segment] }
Segment = {
  index: number,                 // 0 起,文本序
  dialect: 'posix'|'powershell'|'cmd',
  kind: 'command'|'assignment',  // assignment = 纯赋值段(exe=null,parse_status='ok',不算 unsupported)
  exe: string|null,              // 首 token basename 小写去 .exe;wrapper(sudo/env/timeout/command/nohup/bash -c 等)已剥
  sub: string|null,              // 首个不以 - 起的后续 token,跳过已知全局选项及其参数(git -C <p>、npm --prefix <p>、node -e ⇒ 无 sub)
  args: string[],                // exe/sub 之后的 token(引号已解析;重定向与前置赋值不在内);assignment 段为 ['VAR=val']
  redirects: [{op: string, target: string}],   // 已从 args 剥离;target 去引号
  has_exit_status_ref: boolean,  // 段内 $? / ${PIPESTATUS 出现且不在单引号内(双引号内算 true)
  sep_before: 'start'|';'|'newline'|'&&'|'||'|'|'|'|&'|'&',
  parse_status: 'ok' | 'unsupported:<reason>'
}
```
`unsupported:<reason>` 取值(v1.1 实测):`keyword:<word>`(if/then/fi/for/do/done/while/until/case/esac/function/time/{/!/[[ 等保留字打头的段)、`command-substitution`(`$(…)` 与反引号,**双引号内同样算**)、`heredoc`、`subshell`(`(…)`)、`unbalanced-quote`、`backtick`、`empty`。unsupported 段的 exe/sub 为 null、四个扩展字段为空/false。
真实语料(1935 条 Bash 命令、16551 段)分布:ok 14342 / command-substitution 1015 / keyword 821 / heredoc 139 / empty 115 / unbalanced-quote 49 / subshell 46 / backtick ≤3;命令级完整解析率 61.4%。

## v1.2(管道闸 v2 建造的第 ① 件;独立提交;向后兼容:v1.1 字段全部保留、语义不变)
新增段字段(codex 审管道闸 v2 简报 HIGH-2 / MEDIUM-2 逐条对应):
```
  scope_id: string,              // 顶层 'root';bash -c / powershell -Command / cmd /c 内层各一新 scope,形如 'root/1'(父段 index)
  source_span: {line: number, col: number, end_line: number, end_col: number},   // 1 起;多行命令按真实行号
  pipeline_id: number|null,      // 同一条管道(以 | 或 |& 相连的连续段)共享一个 id;非管道段 null
  pipeline_position: number|null,// 0 起;管道最后一段 = pipeline_length-1
  pipeline_length: number|null,
  negated: boolean,              // 段(或其所在管道)前有 ! 
  assignments: string[],         // 前置赋值(VAR=val cmd 的 VAR=val)与纯赋值段的赋值,原文;args 里不再出现
  status_refs: [{kind: '$?'|'${?}'|'PIPESTATUS', context: 'assignment-rhs'|'arg'|'double-quoted'|'nested', token_index: number}],
                                 // has_exit_status_ref 保留为 status_refs 非空的派生布尔
  shell_option_changes: [{option: 'pipefail'|'errexit'|'nounset'|'xtrace'|'other', on: boolean, token_index: number}],
                                 // 来自 exe=set 的段:set -o pipefail / -eo / -euo / +o / -o errexit -o pipefail 逐 token 展开;顺序即文本序
  redirects: [{op: string, fd: number|null, raw_target: string, target: string, target_kind: 'file'|'devnull'|'fd'|'unresolved', order: number}],
                                 // 取代 v1.1 的 {op,target}(保留 op/target 键名以兼容);target 为去引号并做同命令赋值展开后的文本
  group: {kind: 'keyword-block'|'brace-group'|'subshell'|'heredoc', span: {start_index: number, end_index: number}} | null
                                 // unsupported 的关键字/花括号/子壳/heredoc 结构标出闭合范围;范围内的段一律 unsupported,不得把内部片段当顶层命令
```
新增顶层字段:`parser_version: '1.2'`,`scopes: [{scope_id, dialect, parent_segment_index}]`,`unresolved_variables: string[]`(展开时遇到的未定义变量名,去重)。
语义规则:
- **同命令赋值展开**:`S=/x; tail $S/f` ⇒ 第二段 args 为 `['/x/f']`,`redirects[].target` 同理;仅展开本命令内、文本序更早的**字面**赋值(值不含 `$`/反引号/命令替换);其余 `$VAR` 保留原文并记入 `unresolved_variables`,`target_kind='unresolved'`。不读进程环境。
- **heredoc**:正文从 `<<TAG`/`<<'TAG'`/`<<-TAG` 跳到终止符行,该段 `parse_status='unsupported:heredoc'` 且 `group.kind='heredoc'`;终止符之后的行照常解析(v1.1 已如此;v1.2 只是把范围显式化)。
- **关键字块**:`if…fi`、`for/while/until…done`、`case…esac`、`{…}`、`function` 体:整块 `group.kind='keyword-block'|'brace-group'`,块内段全部 `unsupported:keyword:<起始词>`;`! cmd` 不是块,只置 `negated`。
- **PowerShell / cmd 内层**:各自 scope;PowerShell 的 `|` 仍是管道、`;` 分段、`&` 调用符剥掉;cmd 的 `&&`/`||`/`|` 同 POSIX;内层不再递归(最多一层,同 v1.1)。
- `sep_before='&'`(后台)保留;`pipeline_*` 对 `&` 结尾的管道照常计算。

## 一致性夹具(v1.2 交付必含;主脑预注册,建造者不得改)
`guards/specs/pmm-cmd-parse-conformance.json`:每例 `{cmd, expect: 段的字段子集}`,覆盖:v1.1 主脑矩阵 20 例(`verify-m0-parser.cjs` M01–M20,全部保留为回归)、管道闸测试契约 `pipe-gate-v2-test-contract.json` 里全部 `cmd`(只断言解析层字段:pipeline_*、status_refs、shell_option_changes、redirects、group、assignments 展开)、以及 8 例 scope/多行/负号/多选项 set。`--self-test` 必须跑这份夹具;金丝雀登记该自测。变异臂:`PMM_CMD_PARSE_MUTANT=flat`(status_refs 恒空、redirects 恒空、assignments 不展开)⇒ 夹具红例集合按名字等于预注册清单。

## 版本纪律
消费者以 `parser_version` 精确匹配(`=== '1.2'`),不匹配 ⇒ 该事件记 `unsupported:parser-version` 并零输出,不猜。任何字段语义变更 ⇒ 版本号升、本文同步、夹具同步、金丝雀同步,四者一提交。

## v1.2 修订(2026-09-16 18:05;codex 第 2 轮 HIGH-4 全部收下;本节覆盖上文 v1.2 节中对应字段)
- **赋值分两类**:`state_assignment`(独立段 `S=/x`,对文本序之后的段生效)与 `command_prefix_assignment`(`S=/x tail "$S/f"` 中的前缀,**只对该命令的进程环境生效,不为同一简单命令的其他词提供值**)。`assignments` 字段改为 `[{name, raw_value, decoded_value, kind}]`;展开只用 `state_assignment` 且 `decoded_value` 不含 `$`/反引号/命令替换的字面值。
- **每个 arg 与 redirect target 带来源元数据**:`args: [{raw, decoded, quote: 'none'|'single'|'double'|'mixed', expansion_refs: [{name, kind: 'plain'|'braced'|'parameter-op'|'array'|'special'}], unresolved_variables: [string]}]`;`redirects[].target` 同结构。顶层 `unresolved_variables` 保留为全局并集,但判定用 per-operand 字段。单引号内与反斜杠转义的 `$` 不产生 expansion_refs。
- **参数展开子集**:只展开 `$NAME` 与 `${NAME}`;`${NAME:-x}`、`${NAME%y}`、`${A[0]}`、数组赋值、`$'…'`(ANSI-C 引号)⇒ 该段 `parse_status='unsupported:parameter-expansion'`(ANSI-C 为 `unsupported:ansi-c-quote`);空值与未定义变量 ⇒ 记入 `unresolved_variables`、不展开。
- **续行**:反斜杠-换行在切段前消除(不产生 `sep_before='newline'`);`source_span` 记原始行列。
- **groups[]**:顶层 `groups: [{kind, span:{start_index,end_index}, parent: index|null}]` 表达嵌套;闭合文法:`if…fi`(含 `elif/else`)、`for/while/until…done`、`case…esac`(**先识别 case 模式 `a|b)`,再做管道切分**)、`{…}`、`(…)`、`function…{…}`、heredoc 到终止符;闭合失败 ⇒ 从起始段到末尾整段 `unsupported:unclosed-<kind>`。段的 `group` 字段保留为「最内层 group 的索引」。
- **scope 初始 option 状态**:`scopes[].initial_options: {pipefail: boolean, errexit: boolean}`;root 为全关;`bash -o pipefail -c …`/`set -o pipefail` 传入内层 scope 时置为开(内层 scope 在 v1.2 仍只记 `unsupported:nested-scope`,该字段供 v1.3 使用)。
- **一致性夹具** `pmm-cmd-parse-conformance.json` 由交付 ⓪(非建造者)预提交:每例 `{cmd, expect: {segments: [段的字段子集(含 assignments/args 元数据/groups/status_refs/shell_option_changes)]}}`,覆盖 v1.1 矩阵 20 例、测试契约全部 `cmd`、以及本节每条规则各 ≥2 例;变异体 `PMM_CMD_PARSE_MUTANT=flat` 的红例集合同样由 runner 从期望推导。

## v1.2 修订 ②(2026-09-16 18:20;夹具作者 `4204ddf` 报 8 处契约歧义 + 7 个 v1.1 矩阵外 bug,主脑逐条裁定;本节覆盖前文冲突处)
**版本化变更取代「语义不变」**:v1.2 保留 v1.1 全部字段名,但下列分类**明确变更**(消费者以 `parser_version` 钉版本,M0 impression 钩子在管道闸交付 ② 时切到 1.2):
1. `!` 不再是 `unsupported:keyword:!`:置其后管道各段 `negated=true`,`parse_status='ok'`。
2. **注释感知**:引号外的 `#` 到行尾在 token 化层不可见(`a | b; rc=$? # take it` ⇒ 第二段为 assignment `rc=$?`;`echo hi # > x` 无重定向)。
3. **引号感知的重定向抽取**:重定向判定用 token 的 raw 形态,单/双引号内的 `>`/`<`/`|` 一律是字面(`echo '>' x` 无重定向)。
4. 重定向算子全集:`>`、`>>`、`<`、`<<`(heredoc)、`<<<`、`N>`、`N>>`、`N>&M`、`&>`、`&>>`、`>|`、`>&`;`&>`/`&>>` 的前导 `&` 与 `>|` 的 `|` 不是分隔符。
5. `[[ … ]]`、`(( … ))` 为关键字段:`unsupported:keyword:[[` / `unsupported:keyword:((`(先于 subshell 检测)。
6. **数组赋值** `name=(…)` 与 `name+=(…)`:`unsupported:array-assignment`(先于 subshell 检测;取代前文的 parameter-expansion 归类)。
7. **反斜杠续行**在切段前消除,不产生空段(`a | \` + 换行 + `b` = 一条两段管道)。
8. **关键字块内部**(`if/for/while/until/case/{/function` 到闭合词):`|`、`|&`、`&&`、`||`、`;;`、`;&` **不作分隔符**;只按 `;`/换行切段并对 `then/do/else/elif/in/esac/fi/done/}` 前后各切一段(`sep_before='keyword'`);块内所有段 `unsupported:keyword:<起始词>`;case 模式 `a|b)` 与 `;;` 因此不再产生幽灵段;`if a | b; then` 的条件内管道同样不识别(不产生 pipeline_*)。闭合失败:保留多段,各标 `unsupported:unclosed-<kind>`,group span 从起始段到末尾。
9. **嵌套 scope**:v1.1 已把 `bash -c "…"` 递归成扁平段;v1.2 **保留 wrapper 段**(`exe='bash'`,`kind='wrapper'`,`parse_status='ok'`,占一个 index),内层段紧随其后、`scope_id='root/<wrapper index>'`、`parse_status` 按内层自身判定(**不是** `unsupported:nested-scope`);「只判根 scope」是管道闸的策略,由闸记 gate 级事件 `unsupported:nested-scope`,解析器不替闸做决定。递归仍最多一层。
10. `pipeline_id` = 该管道首段的 `index`(稳定、可派生);`pipeline_position` 0 起;非管道段三者皆 null。
11. `status_refs[]` 与 `shell_option_changes[]` 的定位改为 `position: {kind: 'arg'|'assignment'|'redirect', index}`(`index` 为对应数组的 0 起下标;`kind:'assignment'` 指该段 `assignments[]`);废弃 `token_index`。
12. 未解析 operand 的 `decoded` = 原文保留未展开引用(`$UNDEFINED_XYZ/x.txt`),`unresolved_variables=['UNDEFINED_XYZ']`,`expansion_refs` 照记。
13. `sep_before` 取值集合增加 `'keyword'`(见第 8 条)。
夹具 `pmm-cmd-parse-conformance.json` 的 11 条 `ambiguous` 按以上裁定改为 `exact`;7 个 v1.1 bug 各加一例按 v1.2 期望断言(不改 M01–M20 回归例:它们仍按 v1.1 实测值,v1.2 对这 20 例的 `exe/sub/sep_before/parse_status` 必须相同——这是「字段语义不变」的实际含义)。

## v1.2 修订 ③(2026-09-16 19:25;codex 整包第 3 轮 HIGH-3 全收;本节覆盖修订 ② 第 8/9 条与「M01–M20 语义不变」条款)
1. **版本化例外清单(取代「M01–M20 的 exe/sub/sep_before/parse_status 必须与 v1.1 相同」)**:v1.2 对 M01–M20 的这四个字段保持 v1.1 值,**除以下明列例外**——M08(`if…fi`):三段 `parse_status` 全部为 `unsupported:keyword:if`(v1.1 为 if/then/fi 各自);M09(`for…done`):三段全部 `unsupported:keyword:for`;M11(`powershell -Command "…"`)与 M19(`cmd.exe /d /c "…"`):**前面新增一个 wrapper 段**(`exe='powershell'`/`'cmd'`,`kind='wrapper'`,`parse_status='ok'`,`scope_id='root'`),内层段 index 顺延、`scope_id='root/<wrapper index>'`。修订 ② 第 9 条的 wrapper 规则**适用于全部三种 wrapper**(`bash -c`、`powershell -Command`、`cmd /c`),不只 Bash。
2. **关键字块切段算法(确定性优先级,取代修订 ② 第 8 条的散文)**:
   ① 词法层:引号外的 `;`、换行、`&&`、`||`、`|`、`|&`、`&` 为候选分隔符;反斜杠续行已先消除;注释已先剥除。
   ② 块状态:遇到段首 token ∈ 开启词 `{if, for, while, until, case, {, function, select}` ⇒ 压栈开启一个块;块内 `|`、`|&`、`&&`、`||`、`;;`、`;&`、`|&` **不作分隔符**(视为该段文本);只有 `;` 与换行仍切段。
   ③ 关键字边界:块内出现 token ∈ `{then, do, else, elif, in, esac, fi, done, }}`,或**嵌套开启词**(`if/for/while/until/case/{/function/select`)位于 token 起始位置 ⇒ 在该 token 之前强制切段,新段 `sep_before='keyword'`;紧邻其前的 `;`/换行被吸收(`a; then` 只产生一个边界,`sep_before='keyword'`,不是 `';'`)。关键字 token 本身归属新段(`then if b` ⇒ `then` 一段、`if b` 一段)。
   ④ 归属:每段归属栈顶块;`fi/done/esac/}` 使对应块出栈(出栈发生在该段归属之后);栈非空时文本结束 ⇒ 栈内所有块的段全部 `unsupported:unclosed-<开启词>`,`groups[].span.end_index` = 最后一段。
   ⑤ 状态:块内所有段 `parse_status='unsupported:keyword:<该段所属最内层块的开启词>'`;`groups[]` 记每个块 `{kind, opener, span, parent}`;段的 `group` = 最内层块的 `groups[]` 下标。
   夹具 R-group-nested-if 按此算法:`if a; then if b; then c; fi; fi` ⇒ 段:`if a`(sep start)/`then`(keyword)/`if b`(keyword)/`then`(keyword)/`c`(`;`)/`fi`(`;`)/`fi`(`;`),内层 4 段 `unsupported:keyword:if`(内层块)、外层 3 段 `unsupported:keyword:if`(外层块),两个 group,parent 关系 1→0。夹具作者据此改期望。
3. `case` 模式:块内 `a|b)` 与 `;;` 按 ② 不切;`in` 是关键字边界;`esac` 出栈。
4. `[[ … ]]` / `(( … ))`:不是块,是单段 `unsupported:keyword:[[` / `unsupported:keyword:((`(修订 ② 第 5 条不变)。
5. 版本标签:解析器交付时 `parser_version='1.2'`(非 draft);夹具 `version` 同步为 `1.2`;消费者精确匹配。

### 修订 ③ 勘误(2026-09-16 19:40;夹具作者 `af4cc38` 指出规则 ③ 与逐字示例矛盾,主脑采纳「示例优先」并改规则文字)
规则 ③ 改为:**只有块开启词**(`if/for/while/until/case/{/function/select`,位于 token 起始)**与过渡词**(`then/do/else/elif/in`)触发强制切段并置 `sep_before='keyword'`(其前紧邻的 `;`/换行被吸收);**收尾词**(`fi/done/esac/}`)不触发 keyword 边界——它们由其前的真实分隔符切段,`sep_before` 为该分隔符(`';'`/`'newline'`);若收尾词前没有分隔符(非法或罕见形态)才置 `'keyword'`。规则 ④ 的出栈时机不变。夹具 C-A23、C-Z11、R-case-2、R-group-unclosed、R-group-nested-if 已按此写定,为准。

## v1.2 修订 ④(2026-09-16 20:40;Opus 第 4 轮 HIGH-1/HIGH-2/LOW-2 全收;**本节取代修订 ③ 第 1 条与第 2 条 ③、勘误**)
1. **放弃段数冻结**:M01–M20 不再有任何「沿用 v1.1 分段」的例外;**M08 与 M09 按本节算法重算**(逐字见第 4 条)。「字段语义不变」只指 `exe/sub` 的取值规则与 `parse_status` 的字面格式,不指分段。
2. **关键字块切段算法(全文,取代修订 ③ 第 2 条 ①–⑤ 与勘误)**:
   ① 预处理:消除反斜杠续行;剥引号外注释;引号/heredoc 正文不参与后续判断。
   ② 词法分隔符(引号外):`;`、换行、`&&`、`||`、`|`、`|&`、`&`。**块内**(见 ③)`|`、`|&`、`&&`、`||`、`&` 不作分隔符;`;;`、`;&`、`;;&` **折叠为 `;`**(它们终止 case 分支)。
   ③ 块:段首 token ∈ 开启词 `{if, for, while, until, case, {, function, select}` ⇒ 压栈;闭合词 `{fi, done, esac, }}` 使栈顶出栈(出栈发生在闭合词所在段归属之后)。**过渡词** = `then, do, else, elif`,以及**仅在 `case` 块内**的 `in`(`for x in …` 的 `in` 是开启段文本)。
   ④ 过渡词自我隔离:过渡词永远单独成段(`then` / `do` / `else` / `elif <cond>`?——**`elif` 与其条件同段**,因为条件属于它;其余四个词单独成段);过渡词之前紧邻的 `;`/换行被吸收。
   ⑤ 嵌套开启词隔离:块内出现开启词位于 token 起始 ⇒ 之前强制切段(其前紧邻的 `;`/换行被吸收)。
   ⑥ `sep_before` 判定表(新段首 token 类别 × 前驱):

| 新段首 token | 前驱 | `sep_before` |
|---|---|---|
| 顶层开启词 | 文本开头 | `'start'` |
| 顶层开启词 | 真实分隔符 | 该分隔符(`';'`/`'newline'`/`'&&'`/`'||'`/`'&'`) |
| 嵌套开启词(块内) | 任意(`;`/换行被吸收) | `'keyword'` |
| 过渡词 | 任意(`;`/换行被吸收) | `'keyword'` |
| 紧接过渡词之后的段(无真实分隔符) | 过渡词 | `'keyword'` |
| 块内普通命令 | `;`/换行/折叠的 `;;` | `';'` / `'newline'` |
| 闭合词 | `;`/换行/折叠的 `;;` | `';'` / `'newline'` |
| 闭合词 | 无分隔符(非法/罕见) | `'keyword'` |
| case 分支首段(`pat) cmd`) | 紧接 `in` 之后 | `'keyword'` |
| case 后续分支首段 | 折叠的 `;;` | `';'` |

   ⑦ 归属与状态:每段归属栈顶块;块内所有段 `parse_status='unsupported:keyword:<最内层块开启词>'`;块内子壳 `(…)`/`$(…)` 不再单独判 `subshell`/`command-substitution`,随块归 `keyword`(**取代 LOW-2 的推断:R-group-nested-subshell 按此改期望**);顶层子壳仍 `unsupported:subshell`。
   ⑧ 未闭合:文本结束时栈非空 ⇒ 栈内各块的段全部 `unsupported:unclosed-<开启词>`,`groups[].span.end_index` = 最后一段。
3. `pipeline_*` 只在块外计算;块内段三者皆 null。
4. **逐字期望**(夹具作者照此写 M08/M09,并按 ⑥ 表重算全部块例):
   - M08 `if grep -qE "^plus +OK" $S/q.txt; then echo yes; fi` ⇒ 4 段:`if grep -qE "^plus +OK" $S/q.txt`(`'start'`)/ `then`(`'keyword'`)/ `echo yes`(`'keyword'`)/ `fi`(`';'`);四段 `parse_status='unsupported:keyword:if'`;一个 group(if,span 0–3)。
   - M09 `for f in a b; do echo $f; done` ⇒ 4 段:`for f in a b`(`'start'`)/ `do`(`'keyword'`)/ `echo $f`(`'keyword'`)/ `done`(`';'`);四段 `unsupported:keyword:for`。
   - C-Z11 `if a | b; then rc=$?; fi` ⇒ 4 段:`if a | b`(`'start'`)/ `then`(`'keyword'`)/ `rc=$?`(**`'keyword'`**,不是 `';'`)/ `fi`(`';'`)。
   - R-group-nested-if `if a; then if b; then c; fi; fi` ⇒ 7 段:`if a`(start)/ `then`(keyword)/ `if b`(keyword)/ `then`(keyword)/ `c`(**keyword**)/ `fi`(`;`)/ `fi`(`;`);内层块 = 段 2–5(`if b`/`then`/`c`/`fi`),外层块 = 段 0–1 与 6;两个 group,parent 1→0。
   - C-A23 `case x in a|b) echo hit;; esac; rc=$?` ⇒ `case x`(start)/ `in`(keyword)/ `a|b) echo hit`(keyword)/ `esac`(`';'`,来自折叠的 `;;`)/ `rc=$?`(`';'`,块外 assignment,ok)。
5. 夹具版本升 `1.2.1`;解析器交付 `parser_version='1.2'` 不变(夹具版本只标记期望修订)。

## v1.2 修订 ⑤(2026-09-16 21:50;Opus 第 5 轮 HIGH-4/HIGH-5/MEDIUM-8/LOW 全收;补充修订 ②/④,不推翻)
1. **`PIPESTATUS` 显式例外**(取代修订 ② 第 3 条对它的沉默):`$PIPESTATUS`、`${PIPESTATUS}`、`${PIPESTATUS[N]}`、`${PIPESTATUS[@]}` 不算 `parameter-expansion`/数组:段仍 `parse_status='ok'`,记 `status_refs[] = {kind:'PIPESTATUS', context, position}`。其他 `${A[i]}` 仍 `unsupported:parameter-expansion`。
2. **`status_refs[].context` 取值钉死**:`'arg'`(命令参数,不在引号内)、`'double-quoted'`(双引号内)、`'assignment-rhs'`(赋值右侧,任意引号)、`'nested'`(位于 `$(…)`/反引号内——此时段已 unsupported,仅供完整性)。单引号内不产生 status_refs。
3. **重定向目标对象形状**(取代夹具里的两种私形状,MEDIUM-8):`N>&M` / `>&M` / `<&M` ⇒ `{op:'>&'|'<&', fd:N|null, raw_target:'&M', target:'M', target_kind:'fd', order}`;`2>/dev/null` ⇒ `{op:'>', fd:2, raw_target:'/dev/null', target:'/dev/null', target_kind:'devnull'}`;`> f` ⇒ `{op:'>', fd:null, raw_target:'f', target:'<展开后>', target_kind:'file'|'unresolved'}`;`&>`/`&>>`/`>|`/`>>`/`<`/`<<<` 各自 `op` 原文、`fd:null`。夹具 C-A12 等按此统一。
4. **judge/parse 调用粒度**(HIGH-2 配套,供 runner 的 probe/推导与契约 A29 一致):`parse(cmd)` 每个 hook 事件恰好调用一次;`judge(parsed, ctx)` 每个 hook 事件恰好调用一次,**返回一个 findings 数组**(每条 finding 对应一个 gate 实例:`{gate, confidence, gate_instance_id, class_tag?, events?}`);A29 的两条管道 = 同一次 judge 调用返回两条 finding。probe 按调用计(每例每轮 judge 1 次、parse 1 次),sentinel 按 finding 计。
5. **flat 变异推导判据正文**(夹具 `mutant_flat` 与 runner 共同引用本条,不得各自改写):flat = 对真实 parse 输出深拷贝后 `status_refs=[]`、`redirects=[]`、`assignments=[]`、每个 arg `expansion_refs=[]`/`unresolved_variables=[]`/`decoded=raw`,**不改 `quote`**、不改其他字段。一条夹具用例在 flat 下应失败 ⇔ 其期望中出现下列任一:非空 `status_refs`;**非空 `redirects`**;非空 `assignments`;任一 arg 的 `expansion_refs` 非空或 `unresolved_variables` 非空或 `decoded ≠ raw`;`shell_option_changes` 非空(它由 status/assignment 解析派生)。不含「quote 条件」。
6. **判定表补行**(LOW):顶层普通命令 | 文本开头 ⇒ `'start'`;顶层普通命令 | 真实分隔符 ⇒ 该分隔符。
7. 夹具版本升 `1.2.2`;notes 里不得出现「my own construction / by analogy / inference / 契约未述」等措辞——runner 启动时机器扫描,命中即红(runner 作者实现)。

## v1.2 修订 ⑥(2026-09-16 22:30;Opus 第 6 轮 HIGH-3 / MEDIUM-5 全收;补充修订 ⑤ 第 3 条与第 4 条)
1. **`redirects[].target` 一律是对象**(结构按修订 ② 第 2 条:`{raw, decoded, quote, expansion_refs, unresolved_variables}`);修订 ⑤ 第 3 条**只钉 `op/fd/raw_target/target_kind/order`**,其示例里写成字符串的 `target` 作废,改为:`2>&1` ⇒ `{op:'>&', fd:2, raw_target:'&1', target:{raw:'1', decoded:'1', quote:'none', expansion_refs:[], unresolved_variables:[]}, target_kind:'fd', order}`;`2>/dev/null` ⇒ `target:{raw:'/dev/null', decoded:'/dev/null', …}, target_kind:'devnull'`;`> f` ⇒ `target:{raw:'f', decoded:'<展开后或原文>', …}, target_kind:'file'|'unresolved'`。夹具 C-A12/C-B08 现有对象形状即为准,不需改。
2. **judge 返回形状**(修订 ⑤ 第 4 条改写,与三个预注册变异模块一致):`judge(parsed, ctx)` 每个 hook 事件恰好调用一次,返回 **`{gates: Finding[], events: string[]}`**,`Finding = {gate, confidence, class_tag?}`;**`gate_instance_id` 不由 finding 携带,由闸从 `parsed`(pipeline_id / segment_index)派生**并写入台账;A29 = 一次调用 `gates` 里两条 A finding。probe 按调用计(每例每轮 judge 1 次、parse 1 次),sentinel 按 finding 计。
3. **assignment 的 `decoded_value`**:与 operand 同规则——只展开本命令内文本序更早的字面 `state_assignment`;未解析引用原文保留,并在该 assignment 上记 `unresolved_variables`(`assignments[]` 元素增加 `unresolved_variables: string[]`,无则 `[]`)。
4. **裸嵌套子壳**:顶层 `( … ( … ) … )` 整体为一个 `unsupported:subshell` 段;内层括号是该段文本,不产生嵌套 group;`groups[]` 只记一条 `{kind:'subshell', span, parent:null}`。夹具 R-group-nested-subshell 现有期望即为准;其 notes 改为引用本条。
5. **`time`**(LOW-2 补钉):`time` 打头的段是单段关键字 `unsupported:keyword:time`(不是块,不压栈);M16 期望以此为准。

## v1.2 修订 ⑦(2026-09-17 05:40;fab 盲攻 `audits/AUDIT-2026-09-17-fab-blind-pipe-gate-v2-build.md` HIGH-1 / MEDIUM-1 / MEDIUM-4 全收;补充修订 ② 与 §heredoc)
1. **heredoc 段保留首行结构**:含 `<<`/`<<-` 的简单命令仍是**一个**段、`parse_status: 'unsupported:heredoc'`,但 `exe / sub / args / redirects / has_exit_status_ref / status_refs` 一律取自**首行**(`<<` 所在行)按普通规则切出的结果;heredoc 操作符本身与其分隔词**不进** `redirects`;正文行是数据,不产生段;正文之后的段照常切(`sep_before: 'newline'`)。首行含裸 `|`/`|&` 时**不拆管道**,整行仍是这一个 unsupported:heredoc 段(闸只计数、不判 A/B)。夹具 C-H01/C-H02/C-H03 为准;M06 不再断言 `redirects`。
2. **函数定义**:`NAME()`(允许 `function NAME` 与括号内空白)后紧跟 `{` 或 `(` 视为函数定义,从 `NAME` 到匹配的 `}`/`)` 为**一个**段,`parse_status: 'unsupported:function-def'`,`exe/sub/kind` 为 null;函数体内的 `set -o pipefail`、管道、`$?` 都不外泄到 root scope(`shell_option_changes` 不记、`status_refs` 不记);闭合后的 `;`/换行照常分隔。夹具 C-F01 为准。
3. **flat 变异不再读环境变量**:生产 `parseCommand()` 不得读取 `PMM_CMD_PARSE_MUTANT`(契约 `single_handler`:环境变量不得切换判定实现);flat 变换改为导出的纯函数 `applyFlatMutant(result)`,由 runner 在 G08 的 flat 轮自行对真实输出调用;`parseCommand(cmd, {mutant:'flat'})` 亦可但仅供 runner。夹具 `mutant_flat` 文字不变(它定义的是变换,不是触发方式)。

## v1.2 修订 ⑧(2026-09-17 06:55;fab 盲攻 LOW-5 / LOW-7 / LOW-8 / LOW-12;上线后第一批)
1. **尾随空段不是 unsupported**:`ls; echo done;`、`a &&`(行尾)、连续 `;;`/空行产生的空段**丢弃**,不产生 `unsupported:empty` 段(语料 6% 的命令因此被计 unsupported)。夹具 C-E01(`ls; echo done;` ⇒ 2 段)、C-E02(`a; ; b` ⇒ 2 段)。
2. **反斜杠转义**:token 内 `\ `(转义空格)、`\$`、`\"`、`\\` 在 `decoded` 里解码为字面字符,`raw` 保留原文;`\$` 之后的 `?` **不是** status ref(`a | b; echo \$?` 不产生 `status_refs`);`tail -5 ABS/with\ space.txt` 的 operand `decoded` = `ABS/with space.txt`、`quote: 'none'`。夹具 C-BS01/C-BS02。
3. **尺寸上限**:输入超过 1 MiB(UTF-8 字节)或单个 token 超过 64 KiB 时,`parseCommand` 返回单段 `parse_status: 'unsupported:oversize'`(不解析、常数时间),其余字段按 unsupported 空白形状。夹具 C-OS01(1 MiB + 1 字节的单 token)。

### 修订 ⑨(2026-09-17,契约 v2.25 `wrapper_commands`;fab 盲攻 MEDIUM-5,Opus 更正;闸建造者 aaecf0e 实现)
- 在既有可递归的方言包装器识别(`bash/sh` 字面 `-c`、`wsl`、`pwsh/powershell` 字面 `-Command`、`cmd /c`)之后,新增**不递归**的盲包装器识别 `detectBlindWrapper`:仅当方言识别返回空时才参与;命中形态 = `eval`、`alias`、任意含 `c` 的 POSIX shell 短旗簇(`-c/-lc/-ic/-ec/-xc/--command`,壳 sh/bash/zsh/dash/ksh)、`powershell`/`pwsh` 的 `-c`/`-EncodedCommand`、以及 `xargs` 后接上述任一形态;命中时整段标 `unsupported:wrapper`(沿用 `unsupportedBlank()` 形态,不尝试递归)。
- 语义:全盲的判定器不得表现为真阴——闸对 `unsupported:*` 一律记一行信息行(A/A 归属、管道教训 class_tag),不产生闸行。
- 夹具:1.2.8 新增 C-W01–C-W05(`sh -lc`、`xargs sh -c`、`powershell -c`、`eval`、对照 `sh -c` 仍可递归);runner `REQUIRED_FIXTURE_VERSION` 同步升 1.2.8 并重钉 conformance pin。
- 解析器版本号不变(1.2),因为输出形态未变(只新增一个 `unsupported:` 子类)。

### 修订 ⑩(2026-09-23,契约 v2.26 `launcher_commands`;codex 终审 #2,Opus 裁决 CONFIRMED(`audits/OPUS-2026-09-23-codex-final-triage.md`);fab 盲攻 LOW「13 种启动器仍全哑」同源)
- 在修订 ⑨ 的盲包装器识别 `detectBlindWrapper` 之后,新增**不递归**的启动器识别 `detectLauncher`:仅当方言识别与盲包装器识别都返回空时才参与。启动器表:`ssh <host> <cmd…>`;`docker|podman exec [opts] <ctr> <cmd…>`;`kubectl exec … -- <cmd…>`;`docker|podman run … <img> <cmd…>`;`npx [--] <cmd…>`;`nice|stdbuf|ionice [opts] <cmd…>`;`find … -exec|-execdir <cmd…> \;|+`;`watch [opts] <cmd>`。
- 命中条件(三者任一):被携带的命令串含管道 `|`;含退出码引用(`$?`、`${?}`、`$status`、`%ERRORLEVEL%`、`$LASTEXITCODE`);被携带的是修订 ⑨ 集合里的 shell 包装器(`sh -c`、`bash -lc`、`eval`……)。命中即把**整个启动器段**标 `parse_status: unsupported:wrapper`(BLANK_UNSUPPORTED 形状:exe/sub/kind 为 null,args 空),不递归。
- 不命中(被携带的是普通命令,如 `ssh host ls -la`)→ 保持普通 `command` 段,不产生任何行(C-W19)。包在启动器外面的管道(`docker exec box npm test | tail -3`、`ssh host npm test | head`)照常按普通命令判定(C-W17、C-W18)。
- 语义同修订 ⑨:全盲的判定器不得表现为真阴——闸对 `unsupported:*` 一律记一行信息行(A/A 归属、管道教训 class_tag),不产生闸行。
- 扩表(fab 盲攻 LOW-4,Opus 裁决 CONFIRMED 并入):启动器表再加 `exec <cmd…>`、`builtin <cmd…>`、`su -c <str>`、`flock <lock> <cmd…>`、`script -c|-qc <str>`、`busybox <shell> …`、`cmd /k <str>`;解释器一行式 `node -e` / `python -c` / `perl -e` / `ruby -e` 的参数串含管道时同样整段 `unsupported:wrapper`(C-W20–C-W27)。
- 旗标止点(同源):包装器/启动器的旗标扫描在**第一个既不以 `-` 开头、也不是前一旗标取值的 token** 处停止;`bash run.sh --config x -c | head -1`、`sh ./scripts/test.sh -vc 2>&1 | tail -5` 里的 `-c`/`-vc` 属于脚本参数,不识别为包装器,保持普通 command(C-W28、C-W29;此前误标 unsupported)。
- 夹具:1.2.9 新增 C-W06–C-W16(11 种启动器形态)+ C-W17–C-W19(3 条对照)+ C-W20–C-W27(扩表 8 种)+ C-W28–C-W29(旗标止点对照);runner `REQUIRED_FIXTURE_VERSION` 同步升 1.2.9 并重钉 conformance pin。
- 解析器版本号不变(1.2),输出形态未变(复用 `unsupported:wrapper` 子类;不另设 `unsupported:launcher`,避免闸侧再加分支——闸对所有 `unsupported:*` 同一处理)。

### 修订 ⑩ 补充(2026-09-23,契约 v2.26 勘误 2;Opus B1+B2 合审 `audits/OPUS-2026-09-23-b1-b2-review.md` B2 MEDIUM-1(回归)/MEDIUM-2/LOW-1/LOW-2)
- **旗标取值表**:包装器/启动器的旗标扫描在判断止点前先跳过「取值旗标」的值。取值旗标按命令:`bash/sh/zsh/dash/ksh` `-o -O +o +O --rcfile --init-file`;`pwsh/powershell` `-ExecutionPolicy -ep -WorkingDirectory -WindowStyle -InputFormat -OutputFormat -ConfigurationName -Version -File`;`nice -n`;`ionice -c -n -p`;`watch -n`;`docker|podman exec|run` `-u -w -e --user --env --workdir --name -v -p`;`kubectl` `-n --namespace -c --container`;`ssh` `-p -i -l -o -F -J`;`flock -w`;`xargs -n -I -P`;`stdbuf -i -o -e`;`su -l -s`。因此 `bash -o pipefail -lc`、`pwsh -ExecutionPolicy Bypass -c`、`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand`、`nice -n 10 bash -lc`、`docker exec -u root ctr bash -lc`、`xargs -n 1 sh -o pipefail -lc` 都是包装器/启动器(C-W30–C-W32、C-W34–C-W36;这些形态 v2.25 已识别,B2 的止点实现漏掉取值子句造成回归,**不得再盲**)。
- **方言(递归)路径同样适用止点**:`detectDialectWrapper` 不再全段 `findIndex` 找 `-c/-Command//c`,同样在第一个「既不以 `-` 开头、也不是取值」的 token 处停;`bash run.sh -c ls | head -1` 的 `-c ls` 是脚本参数,保持普通 command(C-W33;此前把 `ls` 当内层命令,B 丢失且多记一行 unsupported)。
- **串式 vs argv 启动器**:「携带串含管道」条件只对把**字符串**交给另一个求值器的启动器生效(`ssh`、`watch`、`su -c`、`script -c|-qc`、`cmd /k`、解释器一行式);对执行 **argv 列表**的启动器(`find -exec|-execdir`、`nice`、`ionice`、`stdbuf`、`npx`、`flock`、`docker|podman|kubectl exec|run`、`busybox`、`exec`、`builtin`),只有携带的 argv 本身是修订 ⑨ 集合里的 shell 包装器才标 `unsupported:wrapper`——单个 argv 元素内的 `|` 不是 shell 管道,`find . -name '*.log' -exec grep -lE 'err|warn' {} \; | head -5` 不标 unsupported、find 保持普通 command(C-W37)。
- **表扩充**:解释器加 `python3`、`pythonw`,`node` 允许前置旗标(`node --no-warnings -e`);`kubectl -n|--namespace <ns> exec`;`docker compose exec`(C-W38–C-W41)。
- 夹具:1.2.10 新增 C-W30–C-W41(12 例);runner `REQUIRED_FIXTURE_VERSION` 同步升 1.2.10。解析器版本号仍 1.2。
