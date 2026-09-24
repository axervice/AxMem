# D1-NAMING.md (migrate-selftest fixture — minimal naming table for pmm-migrate-v3.sh --self-test)

## 24 条无身份 live 标题 → 新身份
| 文件:行 | 标题要点 | 新身份 |
|---|---|---|
| decisions:1 | plain identity-less title with no ns:tag bracket at all | [ms:new-identity] |

## 6 条 `[user]` 无冒号(标准:std:3)→ `[user:jax]`(与上表同行处理)

## 3 对同文件重复身份
| 文件 | 第一条(保留) | 第二条 → 新身份 |
|---|---|---|
| decisions | 「first occurrence of a same-file duplicate tag, kept as-is」保留 [ms:dup-tag] | 「second occurrence of a same-file duplicate tag, renamed by D1」→ [ms:dup-tag-renamed] |

## 3 对跨文件双写
| tag | standing(权威,不动) | decisions 版 → |
|---|---|---|
| [ms:cross-tag] | 规则 | [ms:cross-tag-decided] + 正文加「规则版 → [[ms:cross-tag]]」 |
