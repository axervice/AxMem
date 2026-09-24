# D1 命名表(主会话裁定 2026-09-15;C1 迁移 `--apply` 的输入;codex 审)

原则:tag = 有语义的检索别名(不用 legacy: 占位);命名空间按内容:process(工作方式)/pmm(记忆系统)/tooling(工具事实)/axervice(项目专属);slug 英文、≤6 词、说清"是什么规则"。署名标记保持在身份之后;`[user]` 无冒号 → `[user:jax]`。

## 24 条无身份 live 标题 → 新身份(插在闭 `**` 后第一位)
| 文件:行 | 标题要点 | 新身份 |
|---|---|---|
| lessons:849 | git-bash vs PowerShell here-strings in commit messages | [tooling:powershell-here-string-in-git-bash-commit] |
| lessons:852 | Audit a PMM maintain agent's edits before committing | [pmm:audit-maintain-agent-edits-before-commit] |
| standing:206 | Default response language is Chinese | [process:default-response-language-chinese] |
| standing:211 | Never assume Jax is in China / no China-specific workarounds | [process:no-china-network-assumption] |
| standing:216 | Back up Hermes files before modifying | [tooling:hermes-backup-before-modify] |
| standing:221 | GBrain command spelling "gbrain" | [tooling:gbrain-command-spelling] |
| standing:226 | Manual terminal operations: short direct commands only | [process:manual-terminal-short-direct-commands] |
| standing:231 | Hermes terminal uses Git Bash syntax, C:/Users/... paths | [tooling:hermes-terminal-git-bash-paths] |
| standing:236 | PMM is primary memory — no duplication in auto-memory | [pmm:primary-memory-not-auto-memory] |
| standing:241 | ECC Memory 和 PMM 的分工边界 | [pmm:ecc-memory-vs-pmm-boundary] |
| standing:252 | Korean strictly forbidden | [process:no-korean-output] |
| standing:257 | COST CRITICAL warnings: report numbers, continue | [process:cost-warning-report-then-continue] |
| standing:262 | Enterprise migration plans documented in CHANGELOG | [process:enterprise-migration-plans-in-changelog] |
| standing:268 | Python interpreter: C-root py3.11 only | [tooling:python-c-root-py311-only] |
| standing:273 | PMM 自动保精简:maintain 派发附写入纪律+diff 审计+体量预算 | [pmm:maintain-dispatch-discipline-audit-budget] |
| standing:284 | builder 任务头部必带压缩版硬边界 | [process:builder-brief-hard-boundary-header] |
| standing:289 | Axervice 验收 push/合 main 长期授权,全自动循环 | [axervice:acceptance-loop-standing-authorization] |
| standing:295 | 追查潜在 bug 风险=自主执行不请示 | [process:bug-risk-investigation-is-autonomous] |
| standing:300 | Axervice 会话结束/里程碑自动 pmm:save | [axervice:auto-pmm-save-at-milestone] |
| standing:305 | PMM 压缩政策:protected 文件可压缩不丢关键信息 | [pmm:protected-files-compressible-lossless] |
| standing:311 | 监督/运维 loop 不灌 PMM;progress 只留最近 3 条 | [pmm:ops-loop-not-in-pmm-progress-rolling-3] |
| standing:315 | 经验教训分文件治理:项目→repo LESSONS.md,跨项目→PMM | [pmm:lessons-routing-project-vs-global] |
| standing:326 | 自主执行最大化:设计师+codex 意见收敛自行推进 | [process:autonomy-maximize-design-then-codex] |
| standing:375 | 「优化模型配置」= 自动执行完整模型优化流程 | [tooling:model-config-optimization-flow] |

## 6 条 `[user]` 无冒号(241/252/257/262/268/375)→ `[user:jax]`(与上表同行处理)

## 3 对同文件重复身份(第二条改名;零链引用已核)
| 文件 | 第一条(保留) | 第二条 → 新身份 |
|---|---|---|
| decisions | dec:1160「M6 Serializable race guard + bounded retry」保留 [axervice:m6-booking] | dec:1163「Server-side slot re-validation in createOnlineBooking」→ [axervice:m6-booking-slot-revalidation] |
| decisions | dec:922「Phase 2:Hermes 定时只读浏览 X」保留 [project:jax-looprig] | dec:918「LinkedIn 养号器只点赞、暂停 read_dm」→ [project:jax-looprig-linkedin-warmer-likes] |
| lessons | [agent:claude] 被当身份的 849 条 | 已在上表命名为 [tooling:powershell-here-string-in-git-bash-commit] |

## 3 对跨文件双写(D3:standing 版为权威;decisions 版改名 `-decided` 并互链)
| tag | standing(权威,不动) | decisions 版 → |
|---|---|---|
| [axervice:bughunt-token-conserve-tier] | 规则 | [axervice:bughunt-token-conserve-tier-decided] + 正文加「规则版 → [[axervice:bughunt-token-conserve-tier]]」 |
| [axervice:full-audit-scope-254-files-ordered] | 规则 | [axervice:full-audit-scope-254-files-ordered-decided] + 互链 |
| [process:review-effort-tier-table] | 规则 | [process:review-effort-tier-table-decided] + 互链 |

## 其余迁移动作(fab §3 ④⑤)
- Index 行 REST ≠ 标题者 → 逐字节搬为该条目 `Hook:` 行(剥日期/tag/marker);standing 38 行按日期+文本配对,配不上的行 `--plan` 列出,由主会话人工配。
- 3 条 marker-only 取代边 → 取代者加 `Supersedes:` 行;1 条非标 marker(`superseded→澄清[…]`,dec:53)→ 标准形态;1 行 `2026-09-10(晚)` → 日期取前十位,`(晚)` 移入 Hook 文本。
- 2 行 Index >320B(dec)→ 主会话手工提炼成 ≤320B Hook(语义不变),不标 sole-record。
