# C0 建造 spec:core 库 + 迁移器(影子;不接线、不拦、不改任何记忆内容)

**权威依据 = `guards/specs/PMM-V3-FINAL-SPEC.md`(定稿,codex GO-WITH-CHANGES 六组修补已并入:§1.2a 可执行语法、§1.4 围栏感知切块、⑧ 边差事实、⑬ trust、A5/A6/A7/A15 修订、B12/B16 口径、verify 分期)。本文件只是 C0 的交付清单;与定稿冲突处以定稿为准。** 参考:fab #3(`guards/audits/AUDIT-2026-09-15-fable-direction.md`)、D1-NAMING.md、KNOWN-PROBLEMS.md。
命名对齐定稿:核心库文件名 `guards/pmm-core.cjs`(下文「pmm-manifest-v2.cjs」即其 CLI 薄壳,保留名 `pmm-manifest.cjs` 到 C1 才替换;C0 期间新壳名 `pmm-manifest-v2.cjs`);迁移器 `guards/pmm-migrate-v3.cjs` 支持 `--verify --stage c0|c1`;golden corpus 目录 `guards/fixtures/v3/`;plan 文件 `guards/specs/PLAN-<treeOid>.json`(数字绑 OID,不写死);影子对照 allowlist = 6 条 `[user]` + 4 行单括号 Supersedes + ⑧ 的 2 条边差。
边界:只在 `~/.claude/guards/` 新增文件与 `guards/guard-canary.sh` 加 1 行;不改 `pmm-entry-length-watch.sh`/`pmm-precommit-gate.sh`/settings.json/任何 memory 文件;不 push;不 `--apply` 真库(只 `--plan`/`--verify` 于临时副本)。

## 交付物
1. `guards/pmm-manifest-v2.cjs`(新文件,不覆盖 v1):
   - 输入三视图:`--from worktree|HEAD|:0`(git show 读 blob,原始字节;剥 UTF-8 BOM;CRLF 原样保留于 hash、解析时按行归一)。
   - 语法 v3(TARGET-SPEC §A1/A2):身份=闭 `**` 后第一个 `[ns:tag]`;署名/trust/sole-record/redundancy-ok 旗标;字段行 attribution/trigger(path= 与 cmd= 两形态,cmd 纯子串,拒 `path=*`)/Class/Supersedes(只写被取代者)/Cause/Rules/Hook(≤320B);正文;`Ratified by:` 可缺。
   - 输出 `--json`:entries[{id, file, lineRange, blockHash(原始字节 sha256), date(前十位), dateSuffix, title, hook, attribution, trust, sole, flags, class, links(仅字段行与散文行;反引号/围栏内不取), triggers[], supersedes[], cause[], effects[](派生), head(派生), archived, body}],counts,blocking,report,schemaVersion:3。
   - `--check`:B1 悬空 Supersedes、B2 环、B5 trigger 形态、B6 Class(lessons 必填、目标须在 classes.md)、B7 live 身份重复、B8 `**20` 起行未成条目(含前导空格/`>` 前缀)、B8b 身份 ns ∈ {user,agent,system,trust}、B9 文件含 `## Index` 段(cutover 后生效,C0 阶段为 report)、B10 Cause 目标须存在(含归档)、B11 Index 总字节只报、B12 Kernel ≤16KB、拒 > as-of 日期。
   - `--index [--as-of D] [--cold]`:渲染派生 Index(`- DATE [id] Hook或标题` + 派生 `(superseded→[head])`,日期降序);D2 冷判据(已取代;decisions 项目命名空间 >90 天且无 live 反向链;lessons 只按取代);冷行折叠一行计数;`--legacy`:文件仍含 `## Index` 时直接打印原段。
   - `--diff HEAD :0`:退役(F′)、新条目、超限(Hook/条目/Kernel)、身份变更,输出 blocking 列表。
2. `guards/pmm-migrate-v3.cjs`:`--plan`(只读,报 7 组数字:无身份 24 / 无冒号 6 / 同文件重复 3 / std 配对 38 / marker-only 3 / 非标 marker 1 / `(晚)` 1,并列出每一项的 file:line 与拟动作)· `--apply --dir <副本目录> --names D1-NAMING.md`(只对副本目录执行 fab §3 的五种字节动作;真库路径直接拒绝)· `--verify --before <dir> --after <dir>`(fab §3 的 10 条断言,全部确定性;任一失败 exit 2 并列出)。
3. 自测 `guards/pmm-manifest-v2.sh --self-test`:生产形态夹具矩阵——class 身份、attribution-only 标题、`[user]` 无冒号、sole-record-only 标题、同文件重复、跨文件重复、Index 续行、正文示例 `[[ns:tag]]`、代码围栏内 tag、BOM、CRLF、`(晚)` 日期、marker-only 边、非标 marker、archive 无 tag 条目、Cause 悬空、Hook 超长、未来日期;每条红/绿各一。`pmm-migrate-v3.sh --self-test`:在临时副本上 `--plan`→`--apply`→`--verify` 全绿 + 幂等二跑零 diff + 每条断言各一个"故意破坏→红"夹具。
4. 影子对照 `guards/pmm-manifest-shadow.sh`:真库上 v1 `--json` 与 v2 `--json` 的 live 身份集合、Supersedes 边集合、blocking 列表逐项比较;差异只允许是 v2 新识别的 6 条 `[user]` 条目与 v1 已知假阳(列出)。
5. 金丝雀加 1 行(EXPECTED 37→38):`pmm-migrate-v3.cjs --plan` 在真库上恰好报上述 7 组数字 + `pmm-manifest-shadow.sh` 零意外差异。
6. `docs/PMM-V3.md`(放 `guards/`):语法 v3、断言清单、迁移动作、回滚。

## 验收
所有自测绿;金丝雀 38/38;真库零改动(`git status` 只允许 guards/ 新文件与 canary);`--plan` 输出与 fab #3 §0 数字一致;codex(09-19 后)与 Opus 各审一次 diff。
