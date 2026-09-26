# 结论：NO-GO

存在 1 个已经进入当前 `public` 树的高严重度信息泄漏，以及多项会绕过 overlay 审核、破坏隔离或使自动发布不可靠的问题。建议修复后再发布。

## Findings

1. **HIGH — 当前 public 树仍公开了真实内部项目标识。**  
   证据：[guards/specs/KNOWN-PROBLEMS.md:5](/C:/Users/jax-x/Desktop/AxMem/guards/specs/KNOWN-PROBLEMS.md:5) 包含 `project:jax-looprig`、`axervice:m6-booking`、`dee/RAG`；[hooks/pmm-size-watch.sh:24](/C:/Users/jax-x/Desktop/AxMem/hooks/pmm-size-watch.sh:24) 包含 `Looprig`、`Dee`、`Freelance` 等真实工作上下文。我已确认这些字符串存在于 `git show public:<path>`。清洗规则只覆盖 `axervice-booking` 和少量身份字面量（[publish.manifest.json:138](/C:/Users/jax-x/Desktop/AxMem/publish.manifest.json:138)、[publish.manifest.json:152](/C:/Users/jax-x/Desktop/AxMem/publish.manifest.json:152)）。完整导出仍报告 residual scan 为 0，因为清洗和扫描使用同一份不完整规则（[scripts/publish-public.cjs:332](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:332)、[scripts/publish-public.cjs:388](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:388)）。  
   **最小修复：**从 public tier 排除 `KNOWN-PROBLEMS.md`；清理产品脚本中的私有项目注释；建立显式、大小写不敏感的内部名称 denylist，并直接对最终 Git tree 做独立扫描。

2. **MEDIUM — overlay rebaseline 会一次认可全部漂移，且不要求 review note。**  
   [scripts/publish-public.cjs:527](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:527) 遍历所有 overlay，[scripts/publish-public.cjs:539](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:539) 一次重写整个基线块；CLI 只检查布尔旗标（[scripts/publish-public.cjs:634](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:634)）。如果 README 和 `guard-canary.sh` 同时漂移，而操作者只审了 README，命令仍会认可两者，下一次导出可发布陈旧 guard overlay。没有 exporter 单测覆盖此路径。  
   **最小修复：**改为 `--update-overlay-baseline <target> --review-note <note>`，每次只允许一个已知目标；拒绝空 note、多目标和未变更 overlay。

3. **MEDIUM — source ref 未冻结，overlay gate 与归档之间存在 TOCTOU。**  
   overlay hash 在 [scripts/publish-public.cjs:503](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:503) 针对当时的 `main` 计算；之后 short SHA、keep-list 和 archive 又分别解析可变的 `main`（[scripts/publish-public.cjs:645](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:645)、[scripts/publish-public.cjs:216](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:216)、[scripts/publish-public.cjs:222](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:222)）。若另一个进程在 gate 后移动本地 `main`，新源码会配旧 overlay 发布，提交消息也可能标错 SHA。  
   **最小修复：**启动时只解析一次完整 source OID，并把该不可变 OID传给 drift check、`ls-tree`、`archive` 和提交消息。

4. **MEDIUM — exclude 匹配大小写敏感，可由 case variant 绕过。**  
   glob 明确使用大小写敏感正则（[scripts/publish-public.cjs:62](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:62)），归档和二次 exclude 都复用它。例如新增 `Scripts/private.cjs` 不匹配 `scripts/**`，会进入 public；在 Windows 上还可能造成路径折叠。当前树没有 case-only 命中，但没有阻止未来提交。  
   **最小修复：**在导出前拒绝任何与 exclude/其他路径仅大小写不同的路径；Windows 目标建议按大小写不敏感语义验证。

5. **MEDIUM — overlay 能把已 exclude 的路径重新带回公开树。**  
   exclude 在 [scripts/publish-public.cjs:650](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:650) 执行，overlay 随后无条件复制（[scripts/publish-public.cjs:652](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:652)、[scripts/publish-public.cjs:275](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:275)）。若以后把 `guards/guard-canary.sh` 加入 exclude，却保留 overlay，它仍会被公开。现有清单的五个 overlay 都在 keep-list，但脚本没有一致性断言。  
   **最小修复：**启动时验证每个 overlay target 必须存在于冻结 source tree 且必须通过 keep-list；否则拒绝。

6. **MEDIUM — 全新 Windows checkout 会因 CRLF 直接无法导出。**  
   archive 被强制为 LF（[scripts/publish-public.cjs:53](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:53)），但 find/replace 和 overlay 从工作树读取（[scripts/publish-public.cjs:294](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:294)、[scripts/publish-public.cjs:279](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:279)）。我在 `core.autocrlf=true` 的全新一次性 clone 中复现：第一个 find-string 即不匹配，rc=1。即使只修 find 文件，overlay/addFiles 的 CRLF 仍会让导出树随平台变化。顶层 selftest 不扫描 `scripts/`（[bin/axmem:334](/C:/Users/jax-x/Desktop/AxMem/bin/axmem:334)、[bin/axmem:415](/C:/Users/jax-x/Desktop/AxMem/bin/axmem:415)），所以接不住。  
   **最小修复：**给所有发布输入加 `.gitattributes` 强制 LF，或从冻结 Git OID读取 overlay/patch blob，不从工作树读取。

7. **MEDIUM — manifest 路径没有 containment/tracked-file 校验；`auto:true` 时可导出任意本地文件。**  
   `addFiles`、overlay、replacement 直接 `path.join` 并读写（[scripts/publish-public.cjs:264](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:264)、[scripts/publish-public.cjs:277](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:277)、[scripts/publish-public.cjs:292](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:292)）。例如把 addFiles source 设为 `.git/config`，CI 可把 checkout 凭据配置公开；`../../...` 还能逃出 repo/export 根。workflow 会在 `auto:true` 后自动推送（[.github/workflows/publish-public.yml:34](/C:/Users/jax-x/Desktop/AxMem/.github/workflows/publish-public.yml:34)）。  
   **最小修复：**规范化后验证 source/target containment；source 必须是冻结 source OID 中的已跟踪 blob或受控 `publish-overrides/` blob；拒绝 `.git`、绝对路径、`..`、symlink 和非普通文件。

8. **MEDIUM — stale-temp sweep 按可伪造前缀删除，并可能删掉长时间运行的并发导出。**  
   任何 `os.tmpdir()` 下以 `axmem-publish-` 开头且 mtime 超过 10 分钟的条目都会递归删除（[scripts/publish-public.cjs:111](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:111)、[scripts/publish-public.cjs:162](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:162)、[scripts/publish-public.cjs:170](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:170)）。因此用户自己的 `axmem-publish-important`，或运行超过十分钟的兄弟进程目录，都可能被删除。  
   **最小修复：**使用随机 run ID、所有权 marker、严格 suffix 格式和进程存活检查；删除前拒绝 symlink/junction，并验证 realpath 仍是预期子目录。

9. **MEDIUM — orphan 幂等只比较 tree，未验证历史形状，也没有并发 CAS。**  
   [scripts/publish-public.cjs:568](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:568) 在 tree 相同后直接返回。若 `public` 指向“相同干净 tree + 含敏感父提交”的链式提交，orphan 模式也不会重建，敏感历史继续可达。另有两个并发导出都可在旧 ref 上创建同 tree 的不同 commit；[scripts/publish-public.cjs:582](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:582) 的 `update-ref` 没有 expected-old CAS，最后完成者静默覆盖。  
   **最小修复：**orphan 模式只有在 tree 相同且 HEAD 无父提交时才幂等；用 `git update-ref <ref> <new> <expected-old>` 或锁，并在 CAS 失败后重新比较。

10. **MEDIUM — public remote 识别不可靠，并把 PAT 永久写入本地 `.git/config`。**  
    remote 仅按 URL 尾部匹配（[scripts/publish-public.cjs:596](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:596)）：常见 `git@github.com:axervice/AxMem.git` 不会命中，而 `https://evil.example/axervice/AxMem.git` 会命中。找不到时，PAT 被嵌入 URL并通过 `git remote add` 持久保存（[scripts/publish-public.cjs:602](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:602)）。本地手动发布后，`git remote -v` 会暴露凭据。  
    **最小修复：**严格解析并校验 `github.com`、owner、repo，同时支持 SSH/scp URL；拒绝歧义；不要持久化 token URL，使用一次性认证环境并在 finally 中移除临时 remote。

11. **MEDIUM — manifest 多个声明字段实际上未被消费。**  
    `sourceBranch`、`publicBranch`、`sanitize.rules`、`residualScanPatterns` 和若干 gate expectation 定义于 [publish.manifest.json:6](/C:/Users/jax-x/Desktop/AxMem/publish.manifest.json:6)、[publish.manifest.json:144](/C:/Users/jax-x/Desktop/AxMem/publish.manifest.json:144)、[publish.manifest.json:157](/C:/Users/jax-x/Desktop/AxMem/publish.manifest.json:157)，但脚本硬编码 `main`、`public` 和清洗规则。例如维护者往 manifest 新增内部名称规则后，导出行为不会改变。  
    **最小修复：**真正从 manifest 编译规则和分支名，并严格验证 schema、未知字段、重复 rule ID及 expectation。

12. **LOW — step1 在主 finally 之外，早期失败不会清理本轮 exportDir。**  
    `step1_archiveMainToTemp()` 在进入 try 前调用（[scripts/publish-public.cjs:648](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:648)）；tar/写文件/解包失败发生在 [scripts/publish-public.cjs:221](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:221) 至 [scripts/publish-public.cjs:230](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:230)，不会进入 [scripts/publish-public.cjs:693](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:693) 的 cleanup。  
    **最小修复：**让 step1 自身 cleanup-on-error，或在创建 temp 后立即进入覆盖全部步骤的 try/finally。

13. **LOW — symlink和二进制/UTF-16 文件绕过 identity scrub。**  
    `walk()` 只收普通文件，忽略 symlink（[scripts/publish-public.cjs:91](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:91)）；包含 NUL 的文件又被跳过（[scripts/publish-public.cjs:142](/C:/Users/jax-x/Desktop/AxMem/scripts/publish-public.cjs:142)）。例如 public symlink 的 blob target 为 `C:/Users/jax-x/...`，或 UTF-16/PDF metadata 带身份值，sanitize 与 residual scan 都不会看到。当前 `main/public` 没有 symlink或非普通 Git mode。  
    **最小修复：**默认拒绝 symlink/gitlink；对所有 blob 做字节级 ASCII denylist 扫描，未知二进制类型 fail closed。

14. **LOW — build-only `CHANGELOG.public.md` 被重复发布。**  
    manifest 排除了两个 README overlay source，却没排除 `CHANGELOG.public.md`（[publish.manifest.json:12](/C:/Users/jax-x/Desktop/AxMem/publish.manifest.json:12)、[publish.manifest.json:88](/C:/Users/jax-x/Desktop/AxMem/publish.manifest.json:88)）。当前 public tree 同时含 `CHANGELOG.md` 与 `CHANGELOG.public.md`，且两者 blob 完全相同。  
    **最小修复：**把 `CHANGELOG.public.md` 加入 exclude，并增加最终路径 allowlist/snapshot 测试。

## 检查过且干净的面

- 当前 keep-list 为 156/334；实际 public tree 与 exclude 精确交集为 0，case-only 交集为 0。
- 当前五个 overlay baseline 全部与 `main:<path>` blob SHA 相符。
- 所有 23 个 find-string 按真实应用顺序对 Git blob 精确命中一次；两个 Pro 缺失提示已存在于实际 public tree。
- 精确字面量 `jax-x`、`JaxStuuu`、`192.168.1.151`、`D:/RAG`、`axervice-booking`、`AxMem-dev` 在 public tree 中未命中；但 finding 1 的其他内部名称仍存在。
- 本地一次性 bare repo 验证：远端在 `ls-remote` 后移动时 lease push 以 `stale info` 拒绝且保留新 ref；首次无 `main` 时空 expected lease 成功创建分支。
- LF checkout 完整隔离导出通过三道 gate；导出 tree 为 `3f681dc…`，与当前 public tree 相同，public ref 未变化；当前 public commit 无父提交。
- export 主 try 内的清理失败会保留原始失败 rc=1，不会把失败改成成功。
- 完整自测使用隔离 HOME/USERPROFILE/PMM/AXMEM/STATE/TEMP，rc=0；真实工作树保持干净。

## 未覆盖面

- 未连接或推送真实 GitHub public repo；只验证了本地 bare repo 的 Git lease 语义。
- 未注入真实 EPERM/EBUSY、断电或进程强杀来验证 cleanup 重试。
- 未在 Linux CI runner 上实际执行 workflow，也未验证 GitHub token权限和保护规则。
- 未构造恶意 symlink/tar checkout；该路径依据 Git mode和源码静态审计判断。

## LESSON CANDIDATES

- 发布流水线必须先冻结 source OID；“先检查 `main`、后再次读取 `main`”会形成 overlay/keep-list TOCTOU。建议归属 `LESSONS-CRITICAL.md`。
- 数据驱动发布清单仍是高权限输入；所有 source/target 必须做 containment、tracked-blob和文件类型验证。建议归属 `LESSONS-CRITICAL.md`。
- 清洗 gate 不能与 sanitizer 共用同一份有限规则后就宣称零泄漏；最终 tree 需独立 denylist和字节级扫描。建议归属 `LESSONS.md`。
- `core.autocrlf=false` 只约束 Git 命令，不约束从工作树读取的 patch/overlay；发布输入应来自 Git blob或由 `.gitattributes` 固定 LF。建议归属 `LESSONS.md`。