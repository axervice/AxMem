# trigger path glob 支持 — 建造 spec(the maintainer 2026-09-15 拍板:加 glob,不降级粒度)

## 为什么

今天实证:`5e9f57b` 一次带入 **9 条中段通配 trigger**(`docs/*-design.md`、`prisma/*.sql`、`src/lib/**/*`、`src/lib/**/*lock*`、`scripts/itest-*.ts`、`scripts/itest-*lock*.ts`、`scripts/db-simulate*.ts`),在当前匹配器下**全部静默失效**。匹配器 `pmm-trigger-recall.cjs:129-132` 只有两支:

```js
tr.path.endsWith('*') ? relLower.startsWith(tr.path.slice(0, -1)) : relLower === tr.path
```

末尾 `*` = 前缀匹配;否则全等。中段 `*` 落进全等分支 ⇒ 要求存在一个字面叫 `docs/*-design.md` 的文件 ⇒ 永不命中。`src/lib/**/*` 虽以 `*` 结尾,前缀是 `src/lib/**/`,同样永不命中。

我已把其中 7 条改成前缀式;剩 2 条语义是「文件名里含 lock」,前缀表达不了。the maintainer 裁定:**加 glob 支持**,保住已拍板的 `[memory:trigger-plant-at-write-fine-grained]`「粒度越细越好」,而不是把教训降级成粗前缀去抢 ≤3 名额。

## 核心设计原则(这条比语法本身重要)

**闸与引擎必须共用同一个实现。** 这一整类缺陷的根源就是「规则怎么写」与「引擎怎么匹配」是两份代码、各自演化。因此:

- 匹配器导出**唯一**的 `compileTriggerPath(pattern) -> {re: RegExp, literalPrefix: string}`(或抛 `TriggerPatternError`)。
- 写时闸(B5)、v3 core、推送引擎、任何校验器**一律 import 这一个函数**,禁止任何地方再写第二份正则/判断。
- 自测里加一条**反漂移断言**:全库所有 trigger 的 `path` 逐条喂给 `compileTriggerPath`,必须全部编译成功。

## 语法(向后兼容是硬要求)

全库现有 trigger 的形态分布**必须动态分类,不得写死**(2026-09-15 codex MED-7:本文件原写的「83 条 / 56 条前缀」在 7 条被改成前缀式后当天即过期,而验收条款仍引用旧数,可在未被充分执行时通过)。当日实测基线:89 条 path trigger,末尾 `*` 前缀式那一类**行为一个字节都不能变**。
**兼容性验收不得用「零命中对零命中」冒充**:当日 52 个带 trigger 的条目里有 13 个在真实日志窗口内一次都没命中过,对它们回放恒等成立却零证明力。验收须**逐 trigger 要求至少一条正例命中**,覆盖不到的单独列出并说明为何无法构造正例,不计入零差异。

编译规则,按顺序:

1. 先对整个 pattern 做正则元字符转义,但**保留 `*`**。
2. `**/` → `(?:[^/]+/)*`(零或多个目录层)
3. 余下的 `**` → `.*`(跨段)
4. 余下的单个 `*`(**2026-09-15 订正,codex HIGH-1 坐实**):
   - 若它是整个 pattern 的最后一个字符 **且是该 pattern 里唯一的通配符** → `.*`(**跨段**,这正是旧的前缀语义,向后兼容全靠这一支)
   - **否则一律** → `[^/]*`(**段内**),**末尾那个也不例外**
   - 原写法「只要在末尾就跨段」是错的:`src/lib/**/*lock*` 会编译出末尾 `.*`,于是在**目录名**里匹到 lock 之后把剩余路径连斜杠一起吃掉,`src/lib/lock-cache/unrelated.ts` 被误命中,与作者「文件名里含 lock」的意图相反,还会挤占每事件仅 3 个的名额。
5. 两端锚定 `^...$`,大小写不敏感(与今日 `relLower` 口径一致)。

验算(必须写成夹具):

| pattern | 编译结果 | 必须命中 | 必须不命中 |
|---|---|---|---|
| `src/lib/*` | `^src/lib/.*$` | `src/lib/a/b.ts` | `src/libx/a.ts` |
| `scripts/itest-*` | `^scripts/itest-.*$` | `scripts/itest-lock.ts` | `scripts/db-x.ts` |
| `.env*` | `^\.env.*$` | `.env.local` | `docs/.env` |
| `docs/*` | `^docs/.*$` | `docs/a/b-design.md` | `xdocs/a.md` |
| `scripts/itest-*lock*.ts` | `^scripts/itest-[^/]*lock[^/]*\.ts$` | `scripts/itest-ab-lock-x.ts` | `scripts/itest-a/lock.ts` |
| `src/lib/**/*lock*` | `^src/lib/(?:[^/]+/)*[^/]*lock[^/]*$` | `src/lib/locks.ts`、`src/lib/a/b-lock.ts` | `src/util/lock.ts`、**`src/lib/lock-cache/unrelated.ts`**(lock 在目录名上,必须不中) |
| `prisma/*` | `^prisma/.*$` | `prisma/migrations/x.sql` | — |
| 精确(无 `*`) | `^<literal>$` | 仅自身 | 其余一切 |

**第 4 步的"唯一通配符且在末尾"分支是向后兼容的全部要害**,夹具必须覆盖前两行与倒数第二行,任何一条回归即判失败。
另两条硬约束(2026-09-15 codex HIGH-2/HIGH-3 坐实后加):**通配 token 数与 pattern 长度必须设上限**(实测 6 个重叠通配符对对抗性失败输入约 4 秒,而匹配跑在**每次文件编辑**上);**编译前必须校验输入契约**——拒反斜杠、盘符、前导 `/`、空段 `//`、`.`/`..` 段、控制字符、目录结尾,且**该校验对无星形态同样生效**(否则 `/absolute/file` 这类永不命中的形态照样进库,静默失效的根因就没封死)。

## B5 规则改写(替换今日「`*` 只能在末尾」)

- 拒 `path=*`、`path=**`、空 path。
- **第一个 `*` 之前的字面前缀** ≥3 **UTF-8 字节**(不是字符、不是 UTF-16 code unit;`中*` = 3 字节合格,`💥*` = 4 字节合格),且不以 `/` 起。**单位只许由共享的校验函数计算,消费者不得自行测量**(codex 09-15 审 MED-8:本文件原写「字符」而 `PMM-V3-FINAL-SPEC.md` 写「字节」,同一 pattern 会得到相反判决而所有 compile 自测仍绿)。(`.env*`✓ `docs/*`✓ `scripts/itest-*lock*.ts`✓ `src/lib/**/*lock*`✓;`a*`✗ `/x*`✗)
- `*`/`**` 可出现在前缀之后的任意位置。
- **必须能通过 `compileTriggerPath` 编译**,否则红,诊断里给出编译错误原文。
- `repo=*` 禁配常用 exe 的既有条款不变;`cmd=` 形态不变。

## 交付物

1. `pmm-trigger-recall.cjs`:新增并导出 `compileTriggerPath`;第 129-132 行的两支三元改为用它;**编译结果按 pattern 缓存**(每事件会对 83 条逐条匹配,别每次重编)。编译失败的 trigger:**跳过该条 + stderr 响亮 + 本机 error 行**,绝不整体崩(fail-open,与 B28 推送侧口径一致)。
2. `pmm-core.cjs`:B5 改为上面的规则,import 同一个 `compileTriggerPath`,删掉本地任何 path 形态判断。
3. 夹具:上表 8 行逐条,正反例都要;外加「全库 83 条 path 全部可编译」这条反漂移断言。
4. `specs/PMM-V3-FINAL-SPEC.md` 的 B5 行同步改写(我已改,建造时核对一致)。
5. **写时闸**:让现役写入闸在写入含 trigger 的条目时调用同一个 `compileTriggerPath` + B5 前缀规则,不合格即拦。这是本次的**防复发机器**——今天这 9 条正是因为写时无人拦才进库的。
   - **2026-09-15 措辞订正(codex 评审 HIGH-5 坐实,guards/audits/FABLE-2026-09-15-glob-review-triage.md /
     CODEX-2026-09-15-glob-spec-review.md finding 5)**:建造当天接的是 **PostToolUse**(`settings.json`
     的 `Edit|Write|MultiEdit` 矩阵 → `pmm-entry-length-watch.sh --block` → 内部转调 B5),文件**已经
     写入磁盘之后**才跑校验——这只是事后报警,拦不住坏 trigger 真正落库(会话中止/错误被忽略时它就
     留在活库)。「不合格即拦」当时的实际强度只到「写完之后能检测到」,不是「写之前能挡住」,措辞
     比实现强,已改正。**现状(本批修复后)**:`guards/pmm-trigger-write-gate.cjs` 挂在真正的
     **PreToolUse**(同一 `Edit|Write|MultiEdit` matcher,`settings.json`),在 Edit/Write/MultiEdit
     工具调用**执行前**读 `tool_input` 里即将落盘的文本(`new_string`/`content`/`edits[].new_string`),
     逐行跑 `core.classifyTriggerLine()`(与 parseFile() 读时同一份判断,零第二实现),不合格即
     `permissionDecision:"deny"` 拒绝该次工具调用——文件从未被写入。原 PostToolUse
     (`pmm-entry-length-watch.sh --block`)与 pre-commit 校验保留作为**纵深防线**(万一 PreToolUse 闸
     自身故障 fail-open 放行,仍有第二道网)。
6. 修完把 `lessons.md:211/212` 两条 `*lock*` trigger **保持原样**(它们在新语义下本来就是对的),并复跑 `--check`,B5 计数应为 **0**。

## 验收

- `pmm-core.sh --self-test`、`pmm-migrate-v3.sh --self-test` 全绿;`guard-canary.sh` 不掉格。
- 真库 `--check` 的 B5 从 2 降到 0,其余类别计数**一条不变**(不许顺手改别的)。
- 用 `memory/dreams/trigger-log-*.tsv` 里的真实事件回放:改前改后,**56 条前缀式 trigger 的命中集合逐事件完全相同**(向后兼容的实证,不是口头保证)。
- 构造一条会命中 `src/lib/**/*lock*` 的真实路径事件,确认改后能推送、改前推不出来。
