<!-- STATUS: 迁移线于 2026-09-16 暂停(Jax 拍板);本 spec 已经 codex 审为「改后可建」并修订到 v2,留档待某召回功能真需改语料格式时续用。见 CHANGELOG §一″。 -->
# 第十四轮 spec v2(codex spec 审查后修订;审查判「改后可建」,4H/6M/1L 已逐条并入)

仓库根 `C:/Users/<user>`,代码在 `.claude/guards/`。本版取代 `spec-round14.md`(v1);审查产物
`~/.codex-reviews/review-20260916T123427Z.md`。**审查逮住的每一条都标了 [审:编号]。**

## 背景(不变)
六轮修复全是同一类:生成器产字段、消费端读、校验器没覆盖,或同字段两套语义。逐字段补必在下一字段重演。
根因是契约与生成器两份手写清单。本轮做 schema 单一来源 + 两项流程闸。
**v1 自身也复现了这个类**(审查 HIGH-1:我的覆盖检查对可选字段天然全绿;MEDIUM-1:我漏了第 10 个字段
`blockHash64`,照 v1 建会拒掉全部 1144 条已提交编辑)——这恰恰证明只能靠机器闸,不能靠作者。

## Part A · schema 单一来源

### A1 声明 [审 MEDIUM-1:9→10 字段;审 LOW-1:冻结]
新建零依赖叶子模块 `pmm-edit-schema.cjs`。字段集**以四份已提交计划 1144 条编辑的实测为准 = 恰好 10 个顶层键**
(审查已实测:无第 11 个键):

```
file            required check: typeof==='string' && ctx.allowedFiles.has(v)
offset          required check: Number.isSafeInteger(v) && v>=0
deleteLen       required check: Number.isSafeInteger(v) && v>=0
insertText      required check: typeof==='string'
oldBytesBase64  required check: typeof==='string'
titleLineNo     required check: Number.isSafeInteger(v) && v>=1
titleLineSha256 required check: typeof==='string' && /^[0-9a-f]{64}$/.test(v)
blockHash64     required check: v===null || /^[0-9a-f]{64}$/.test(v)   ← 审查漏项;②⑤⑦ 上为 null
kind            required check: typeof==='string' && ctx.kindKeys.has(v)
action          required check: 见 A1′
```
- **十个字段全部 `required:true`**;「可空」写进 `check`(如 `blockHash64` 允许 null),**不得表达为「键可缺席」**
  [审 HIGH-1 建议]。schema 数组与每个字段描述 `Object.freeze`,导出只读字段名 Set [审 LOW-1]。
- 校验**严格形状**:出现 10 个之外的顶层键即拒(未知键拒)。
- 导出 `validateEditRecords(edits, ctx) → {ok, failures[]}` 与 `makeEditRecord(fields, ctx) → record|throw`。

### A1′ `action` 字段的完整契约 [审 MEDIUM-2:不能只验「是对象」]
A1 会消费 `e.action.titleLineNo/renameTitleLineNo/decisionsTitleLineNo`,且逻辑上要求 `e.action.kind === e.kind`。
**首选方案**:从 edit record **删除整份 action 副本**,改存 `actionIndex`(指向 `plan.actions[i]`),
消费端按 index 回 `plan.actions` 取,并校验 `plan.actions[actionIndex].kind === e.kind`。
**若建造者实测该重构触及面过大**(action 被多处直接读),退为 tagged-union:按 `kind` 校验 action 的必需嵌套字段 +
跨字段一致性 `action.kind === e.kind`。**二选一由建造者按实测决定并在报告说明**,不得停在「只验是对象」。

### A2 接线 [审 MEDIUM-3:A10 的 NOT-RUN 漏洞]
- `buildEditOps` 全部 **8 个** push 点(审查已定位:①1332 ②1349 ③1359 ④1369/1372 ⑤1378 ⑦1389 ⑬1407)
  改经 `makeEditRecord`。
- `cmdApply` 与 `readPlan()` 调同一份 `validateEditRecords`(删本地六字段版)。
- `readPlan()`:先验 `Array.isArray(edits)`(容器,审 LOW-1 第十三轮),非数组 → 结构化错误挂 `__editsContractErrors`。
- **新增独立断言 `EDIT-CONTRACT`(PASS/FAIL)** [审 MEDIUM-3]:契约红不再只靠 A1/A11 承载;
  且 **A10 必须先判 `__editsContractErrors` 并 FAIL,再判「无 plan」的 NOT-RUN**——否则 `edits=null` 会得到
  非法 NOT-RUN(plan 在场但契约坏)。沿用第十二轮边界:不改 `cmdVerify` 退出码语义、不改合法 NOT-RUN 态。
- 以 schema 字段作键的映射继续 `Object.create(null)`(勿回退)。

### A3 「不可能只加一边」的机器保证 [审 HIGH-1:v1 此处失效,重写]
自测 `SCHEMA-COVERS-GENERATOR`:
1. **夹具必须覆盖全部七种 producing kind**;先断言 `Set(现场生成的 kind) === Set(PRODUCING_KINDS)`
   (v1 夹具漏 `⑦`,是 HIGH-1 的根)。
2. 取所有生成 edit 的顶层键并集 U;断言 **`U === schemaNames`(双向严格相等,不再有「∪ 可选」的免责)**。
3. 新增**静态断言**:grep/AST 确认 `buildEditOps` 内**不存在**绕过 `makeEditRecord` 的裸 `.push(`
   [审 HIGH-1 建议]——否则运行时构造器保证可被静态旁路。

### A4 mutant 实测敏感性 [审 HIGH-4:v1 集合不足且共源双盲]
`pmm-migrate-v3-mutants.sh`,**oracle(预期翻红断言清单)先验 hash 锁定、存在临时副本之外**,每个补丁必须
恰好命中预期次数、baseline 先绿、mutant 由指定断言翻红。最低 mutant 集合(审查开列,全收):
- 每个十字段各一个:缺失 mutant + 错型/错域 mutant。
- 关闭未知键拒绝;给生成器加未知键;给 schema 加从不生成的可选幽灵键(必须被 A3 步骤 2 抓)。
- `buildEditOps` 绕过构造器裸 push。
- **分别**移除 `cmdApply` 校验、`readPlan` 容器校验、`readPlan` 逐项校验(三个接线点各自承重)。
- 让 A1、A11、A10 分别忽略 `__editsContractErrors`。
- `kindRank` 回退对象键查找。
- **专门在当前未覆盖的 `⑦` 分支加字段**(证明 A3 步骤 1/2 真能抓)。
- 「去掉 `makeEditRecord` 校验」必须配一个**直接调用构造器的坏输入测试**,否则该 mutant 对正常生成全绿(审 HIGH-4)。
汇总行输出**实测**的 mutant→翻红断言映射,取代人工标签。脚本入金丝雀名册。

## Part B · 管道后取 `$?` 的 PreToolUse 闸 [审 HIGH-3 + MEDIUM-6:全面重写]
`~/.claude/guards/bash-pipe-exitcode-watch.sh`,PreToolUse hook。
- **命中时输出且只输出结构化 JSON**(审 HIGH-3,纯 stdout 到不了模型):
  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"[process:pipe-hides-exit-code-and-truncates-evidence] 检测到管道后取 $? / 截断读取验证输出;正确写法 cmd > f 2>&1; rc=$?"}}
  ```
  **不设 `permissionDecision`,exit 0,仍是警告不拦。**
- 触发条件(审 MEDIUM-6 扩充,报告模式):**任意管道后再读 `$?`**,外加两条专门规则——
  `head|tail` 截断验证类命令(`--self-test|--check|canary|verify`)输出;`… | wc -l` 读行数。
  必须覆盖审查点名的实际漏网写法:`tail -6 <重定向文件>`(无管道)、`git log … | head -60 | wc -l`(无 `$?`)、
  `head -n 60`、`tail --lines=6`、`| tee`、`| jq`、`| sort`。
- **例外**(不触发):`PIPESTATUS[...]`、显式 `set -o pipefail`、注释/字符串内的匹配。
- **删除 v1 的错误绿例** `cmd 2>&1 | tee file` 后 `rc=$?`(审 MEDIUM-6:tee 后取的是管道状态,不是原命令,
  这本身该触发,不该当绿例)。已知最可能误报:`producer | grep -q pattern; rc=$?`(有意读 grep 匹配状态)——
  报告模式先容忍,累计一周误报率后再决定是否升拦。
- **自测须解析 JSON 断言 `hookEventName` 与 `additionalContext`**,不得只 grep 一行文字(审 HIGH-3)。
  ≥6 例必触发(含上面两条漏网写法 + 当日实际踩的三种)+ ≥4 例必不触发(PIPESTATUS/pipefail/grep-q 有意读/无管道无 `$?`)。
- 接线 `settings.json`;镜像 `_local-config`;入指纹册;入金丝雀名册。

## Part C · 金丝雀 provenance 参数化 [审 HIGH-2 + MEDIUM-4/5:重写]
**不直接取消 A20,而是参数化其来源**(审 HIGH-2:直接 C0 关 A20 只是把错误藏掉):
- verify 显式接收 `expectedSourceTreeOid`;A20 比 `plan.treeOid === expectedSourceTreeOid`,**不再隐式绑当前 HEAD**。
- **拆成两条显式断言**(审 MEDIUM-4):
  - `C0 engine replay PASS`:显式审定的 LKG 计划对**其自身源 OID**(= `expectedSourceTreeOid`)可 apply+verify c0。
  - `C1 readiness BLOCK/PASS`:当前 `HEAD:.claude/memory` 是否有已审 plan。C0 期间这条是 BLOCK 但**非阻断金丝雀**,
    仅提示 C1 前须重生成。
- **LKG 指针用显式已提交文件,不用 generatedAt**(审 MEDIUM-5:generatedAt 是 plan 内自报字段,可被未来时间/
  时钟漂移/glob 误选未提交 plan 夺走「最新」):新增已提交 `specs/C0-LKG.json`,钉 `planPath/treeOid/planBlobOid/reviewCommit`,
  指针与计划都用 `git show HEAD:<path>` 读。
- 旧 plan 若因排序语义过期而首跑失败,是真红不是假红,**不得为此放宽**。
- 不把 LKG replay 描述成「当前语料验证」(审 MEDIUM-4);当前生成器正确性由 A3/A4 网负责。

## 硬约束与验证纪律(同前十三轮)
绝不对真库 `--apply`;`.claude/memory/*.md` 一字不改;`git add <具体文件>`;守卫改动同批指纹 refresh + 收据 +
`_local-config` 同步;取退出码不经管道;夹具不经 shell 构造;物化用 `git show`(非 `git archive`);对照组只留一个
变量;复用旧脚本先读判定逻辑;引用「真实」先分清实现/语料/已提交计划。

## 完成标准
七套自测全绿项数只增;`pmm-manifest-v2.cjs --check` 阻断分布 B8b 18 / B23 6 / B7 5 一条不变、B5 为 0;
指纹册 check 为 0;金丝雀名册红项 ≤1 且若有红须为「当前 OID 无已审 plan」这一 BLOCK(非阻断)或
「LKG 语义过期」这一真红之一,不得有其他红;**每条改动配先红后绿 break-测试,断言具体退出码/诊断**;
mutant 敏感性为实测输出;**A3 的三步都要有对应 mutant 证明其非空洞**。报告分列「回退敏感/夹具前提」,
写出 spec 写错或没想到处。**自估时长开头给。**

## LESSON CANDIDATES(审查提的,主会话择机入库)
- 可选字段不能从 `schema ⊆ generated-union` 免责,否则幽灵字段永久全绿。
- 历史 replay 的 provenance 断言必须参数化源 OID,不能隐式绑当前 HEAD。
- PreToolUse 非阻断警告须用结构化 `additionalContext`,纯 stdout 不构成可见告警。
