# Claude Code 阶段 1：真人试装／验收／回滚清单

## 一眼核对表（先核对这一页，再按后文逐条执行）
| 步骤／改哪个文件的哪一段 | 改前怎么备份 | 怎么验证生效 | 怎么一步回滚 |
|---|---|---|---|
| 1. 安装前检查：只读，不改文件 | 记下 settings 原 SHA256；确认 Trial 原来不存在 | 自测退出 0、无 FAIL；AXMEM_* 检查为空 | 无改动，无需回滚 |
| 2. 新建 `Trial/state/` 目录 | 不覆盖既有目录；记下“原来不存在” | 路径是独立 Trial 下的 state | 退线且确认无读写者后，整个目录移入回收站 |
| 3. 新建 `Trial/config.json` 全文（第 2 节） | 不覆盖既有文件；原来不存在，无旧版可备份 | 解析得到绝对 memoryRoot/stateRoot、external | 退线且确认无读取者后，该新文件移入回收站 |
| 4a. `settings.json` 的 `hooks.SessionStart` 末尾追加 1 组 | apply 自动先存原字节备份并校验 SHA256 | status 的第 1 个 count=1；新会话有一次健康状态 | 第 4 节同一条 `--rollback`，一次退掉本次全部 3 组 |
| 4b. `settings.json` 的 `hooks.UserPromptSubmit` 末尾追加 1 组 | 同一份自动备份；独立 Record 记下身份和 hash | status 的第 2 个 count=1；真实提问验收 | 同上，不逐组手删，不覆盖他人改动 |
| 4c. `settings.json` 的 `hooks.PreToolUse` 末尾追加 1 组，matcher=`Edit\|Write\|MultiEdit\|Bash` | 同一份自动备份；原 PMM 各组不动 | status 的第 3 个 count=1；真实工具前验收 | 同上；status 应退回 0/3 |
| 5. 验收／退线：只读回执；试验文件仅允许新建 | 保留 backup、`Trial/install-record.json` 和外部 hash 笔记 | 三件小任务、耗时、PMM 不重复；退线后新会话复查 | 第 4 节 `--rollback`；试验文件确认归属后移入回收站 |

> `Trial` = `C:/Users/jax-x/AppData/Local/AxMem/cc-phase1-trial`；settings = `C:/Users/jax-x/.claude/settings.json`。
> 这是**以后由 Jax 执行**的清单，不是已经安装的记录。本次只交付工具和临时夹具测试，未读写真实用户目录。
> 下列命令使用 **Windows PowerShell 5.1 或 PowerShell 7**；不是 Git Bash。
> **安装／回滚那一刻不要有别的程序在改 settings.json**；不要求先关掉所有会话。工具不是多写入者事务。
> 不运行 `merge-hooks.cjs` 的安装入口：它会添加 8 条，前 5 条与已经存在的 PMM 功能重叠。

### 影响面：不是只影响试装窗口

`~/.claude/settings.json` 是全局配置。装上后，**所有 Claude Code 会话（含桌面应用和其他正在运行的 agent 会话）**，
每次开会话、每次提问、每次 Edit／Write／MultiEdit／Bash 前都会运行这个钩子，单次约 **0.2 秒**（参考量级，实机可能更慢）。
repo 映射不等于钩子只会在这个 repo 启动。**以新会话为准，旧会话可能要重启才生效或才失效**；不保证热加载。
回滚后先保留 config/state，避免仍缓存旧接线的会话找不到配置。无需统一关掉所有会话来安装或退线；清理目录可以延后。

## 0. 固定范围，先看懂再打勾

- [ ] 本次根目录固定为 `C:/Users/jax-x/Desktop/AxMem-trees/cc-phase1`，**不是 a2-install，也不是 main**。
  整合者须先把 A2 的 `trial-install.cjs`、`test-trial-install.cjs` 和本清单交付到该树；旧 merge 的 helpers 已导出，无需改行为。
  如果文件不齐或自测不过，就停下，不要临时改成其他 root 安装。
  **换 root 后重装：先用旧 root/config 回滚，再使用新的 `--record` 路径，或把旧记录移入回收站，然后才按新 root 安装；不能直接改记录。**
  **apply 若被中断：先 rollback，确认退线后才可再次 apply；不要用重跑 apply 覆盖原备份链。** 保留原备份及外部笔记供核对。
- [ ] PMM 的现有 SessionStart／Prompt／Pre／Post／Stop 全部保留，包含现有 Kernel、banner、trigger-recall、write gate、receipt。
  试装只新增下表 3 个 command hook，各占事件末尾一个新组；不添加 session-lamp，不添加旧 Post／Stop 功能。

三个组里的 **command 全文完全相同**（这是 settings 的字符串值，不是让 PowerShell 直接执行的语法）：

```text
AXMEM_CONFIG="C:/Users/jax-x/AppData/Local/AxMem/cc-phase1-trial/config.json" node "C:/Users/jax-x/Desktop/AxMem-trees/cc-phase1/adapters/claude-code/hook.cjs"
```

| event | matcher | command |
|---|---|---|
| `SessionStart` | 无 | 上述完整命令 |
| `UserPromptSubmit` | 无 | 上述完整命令 |
| `PreToolUse` | `Edit\|Write\|MultiEdit\|Bash` | 上述完整命令 |

Claude Code 的钩子命令经 POSIX shell 执行，前置赋值仅作用于本次 node 子进程；与现有 PMM 前置变量写法相同。
不写 settings.env，不设置用户／系统持久变量，不要求从某个窗口启动 Claude。桌面应用也使用同一条显式配置命令。
身份是 `{event, matcher, normalized_command}`，只对 command 做首尾空白 trim，不做模糊子串匹配。
**裸 node 命令、另一个 config 前缀都不是这个身份**。同一 matcher 有多组也全部检查。
其他 hook 的对象内容、键顺序和数组顺序不变；settings 的缩进／换行会重排，**不是原文件字节不变**。

- [ ] 本次独立目录：`C:/Users/jax-x/AppData/Local/AxMem/cc-phase1-trial`。
  配置 `config.json`、状态 `state/`、安装记录 `install-record.json` 都放这里；不使用默认 `~/.axmem`，状态绝不放在 `~/.claude`。
  **唯一必须在 settings 旁新增的文件是原字节备份**：`settings.json.axmem-trial-backup-<UTC时间>-<UUID>`。
  工具也支持不传 `--record`：默认记录在 `<settings完整路径>.axmem-trial-install.json`；本清单总是显式指定独立位置。
- [ ] 记忆只读来源是 `C:/Users/jax-x/.claude/memory/`。不迁移、不复制回去、不改 ACL，不往里面写 config／缓存／receipt。
  没有名为 `read_only` 的配置开关；“只读”是此 hook 的源读取契约，不是操作系统沙箱。
  派生缓存可能含来源正文，也有隐私性；留在独立 state 下，不上传。
- [ ] PMM 是唯一 Kernel 发送者，AxMem 配置必须是 **`kernel_sender: "external"`**，不是 `axmem`。
  `off` 也不由 AxMem 发送，但这里选 external，明确表示有 PMM 发送。

### 为什么只在命令里设 AXMEM_CONFIG 就够（有前提）

- `lib/prelude.cjs:27-37`：显式 `AXMEM_CONFIG` 优先于 AXMEM_HOME 下的默认配置，require 时读取一次。
- `lib/prelude.cjs:79-80`：memory/state 的优先级是 **环境变量 > config > 默认值**；`:94-96`、`:135-137` 将目录按 config 所在位置解析。
  本清单的 `memory_dir`／`state_dir` 都是绝对路径，所以无须再设 AXMEM_HOME／AXMEM_MEMORY_DIR／AXMEM_STATE_DIR。
  **但继承到旧的 AXMEM_MEMORY_DIR／AXMEM_STATE_DIR 仍会覆盖 config**；必须先过第 1 节 User/Machine 两级和当前进程检查。
- `adapters/claude-code/hook.cjs:112-113`：实际 store 根为 `resolve(dirname(resolve(AXMEM_CONFIG)), STATE_DIR)`，不是工具 cwd。
  `core/recall-receipt.cjs:202-203`、`:248-256`：回执和 state 在该根的 `recall/<作用域hash>/` 下。
- `adapters/claude-code/hook.cjs:158-159`、`:189`：派生缓存在该根的 `recall-source`、`recall-topic`。
  `core/memory-source.cjs:75` 只读源文件；`:88-90` 的 mkdir／atomic write 目标是 cacheDir。
- `adapters/claude-code/hook.cjs:166-171`：仅 `kernel_sender === 'axmem'` 才取 Kernel 正文，external 不重复发送。
- `test-trial-install.cjs` 的 `config-command-exact-identity-and-config-only-runtime`：隔离子进程清除所有 AXMEM_*，仅传临时 AXMEM_CONFIG，
  断言解析到配置里的绝对 memory/state 和 external；再注入不同的 memory/state 环境变量，断言确实由环境覆盖。探测不读记忆、不创建 store。

## 1. 安装前检查（每项执行后对照预期）

下面的 PowerShell 变量只是命令参数的缩写，**不是给 Claude 进程传配置的环境变量**；换窗口可重建它们。
任何一项不符合预期就停，不要覆盖已有文件凑结果。本节真实路径检查均由未来操作者运行，本次交付者没有运行。

- [ ] 建立操作变量：

```powershell
& { $script:Root='C:/Users/jax-x/Desktop/AxMem-trees/cc-phase1'; $script:Settings='C:/Users/jax-x/.claude/settings.json'; $script:Trial='C:/Users/jax-x/AppData/Local/AxMem/cc-phase1-trial'; $script:Config="$Trial/config.json"; $script:State="$Trial/state"; $script:Record="$Trial/install-record.json"; $Root; $Trial }
```

预期：打印上述 root 和独立目录。后续命令使用这些普通 PowerShell 变量。

- [ ] 检查 **User／Machine 两级持久 AXMEM_* 及当前 Process 环境**（只报告非空变量名，不打印值）：

```powershell
& {
$found = @(foreach ($scope in @('User','Machine','Process')) {
  [Environment]::GetEnvironmentVariables($scope).Keys | Where-Object { $_ -like 'AXMEM_*' } | ForEach-Object {
    if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable([string]$_,$scope))) { "$scope $_ = NONEMPTY" }
  }
})
if ($found.Count -gt 0) { $found; throw 'Stop: review existing AXMEM_* overrides; do not install yet' }
'AXMEM_* empty: User/Machine/Process'
}
```

预期：`AXMEM_* empty: User/Machine/Process`，User／Machine 各级的 AXMEM_* **全部为空**。
非空就先找负责人核对旧用途，不要用 setx 或临时清变量掩盖冲突。另确认已知启动脚本、应用环境及 settings.env 没有注入 AXMEM_*。
当前窗口的检查不能证明每个旧桌面宿主／agent 的进程环境都干净；它们可能保留过去继承的覆盖值。
如有这种情况，应在合适时机重启对应宿主／会话，并以新会话的实际回执位置为准；不能宣布所有旧会话已立即切换。

- [ ] Node 版本：

```powershell
node --version
```

预期：`v20.x` 或更高。各 Claude Code 入口（含桌面应用）的 hook PATH 也必须能找到 Node，以新会话实测为准。

- [ ] 根目录交付文件齐全：

```powershell
@('hook.cjs','trial-install.cjs','test-trial-install.cjs') | ForEach-Object { "$_ = $(Test-Path -LiteralPath "$Root/adapters/claude-code/$_" -PathType Leaf)" }
```

预期：三项全部 `True`。只检查文件存在，不执行安装。

- [ ] 根目录 hook 自测：

```powershell
node "$Root/adapters/claude-code/hook.cjs" --self-test
```

预期：**退出码 0、无 FAIL**。A1 收尾整合后的参考输出为 `A1 delta self-test 10/10`、`A1 R3 edge self-test 5/5`、
`A1 review self-test 13/13`、`claude-code hook self-test 40/40`；数字仅作版本核对参考，不替代退出码和失败检查。
这是合成环境测试，不是拿真实记忆测试；本 A2 分支尚未整合的 A1 收尾不能据此宣称已通过。

- [ ] 试装工具自测：

```powershell
node "$Root/adapters/claude-code/test-trial-install.cjs"
```

预期：**退出码 0、无 FAIL**；本轮参考 `trial-install self-test 37/37; guard-removal red evidence 37/37`，另有 `mutation-harness classification 5/5`。
`EXPECTED-RED` 必须由同一用例中的 `AssertionError` 捕获缺失约束；普通异常、子进程异常退出／崩溃不算红证据。
这些都是临时破坏副本的预期失败，不是对真实 settings 做破坏实验。

- [ ] 记下 settings 原始 SHA256（抄到外部验收笔记，关窗口后也要能找回）：

```powershell
& { $script:BeforeSha=(Get-FileHash -LiteralPath $Settings -Algorithm SHA256).Hash.ToLowerInvariant(); $BeforeSha }
```

预期：64 位十六进制；具体值以现场为准。此处不得写死示例 hash。

- [ ] 检查试装目录、配置、状态、记录是否已经存在：

```powershell
@($Trial,$Config,$State,$Record) | ForEach-Object { "$_ = $(Test-Path -LiteralPath $_)" }
```

预期首次：四项 `False`。如已存在，先停下核对来源；**不得覆盖或清空既有配置／状态目录**。
记下“config/state 原来不存在”，回滚后才允许把本次新建文件／目录移入回收站。

- [ ] 只检查三个必需记忆源是否存在，不改它们：

```powershell
@('decisions.md','lessons.md','standinginstructions.md') | ForEach-Object { "$_ = $(Test-Path -LiteralPath "C:/Users/jax-x/.claude/memory/$_" -PathType Leaf)" }
```

预期：三项 `True`。缺失就停，不为让测试通过而在真实 PMM memory 造文件。源目录／文件不能是符号链接；不支持网络共享源。

## 2. 写独立配置，然后预检接线／预演／应用

- [ ] 只创建本次独立的 state 目录（连同父目录）：

```powershell
[System.IO.Directory]::CreateDirectory($State).FullName
```

预期：打印 `C:\Users\jax-x\AppData\Local\AxMem\cc-phase1-trial\state`，不是 `.claude` 下的目录。

- [ ] 新建**以下完整 config.json**，用 UTF-8 **无 BOM**（Windows PowerShell 的普通 `Set-Content -Encoding UTF8` 会加 BOM，不能用于这里）：

```powershell
& {
$text = @'
{
  "$schema_version": 1,
  "memory_dir": "C:/Users/jax-x/.claude/memory/",
  "state_dir": "C:/Users/jax-x/AppData/Local/AxMem/cc-phase1-trial/state",
  "repos": [
    {
      "id": "axmem",
      "roots": ["C:/Users/jax-x/Desktop/AxMem-trees/cc-phase1"]
    }
  ],
  "adapters": {
    "claude_code": {
      "enabled": true,
      "settings_json": "C:/Users/jax-x/.claude/settings.json",
      "recall": {
        "mode": "remind-only",
        "on_unavailable": "warn-and-continue",
        "max_items": 3,
        "max_bytes": 4096,
        "min_topic_terms": 2,
        "kernel_sender": "external",
        "kernel_max_bytes": 4096
      }
    }
  }
}
'@
if (Test-Path -LiteralPath $Config) { throw 'Refuse to overwrite existing config' }
[System.IO.File]::WriteAllText($Config,$text,[System.Text.UTF8Encoding]::new($false))
'config written (UTF-8 no BOM)'
}
```

预期：`config written (UTF-8 no BOM)`。仅配置这个试装仓库，不能用 HOME 根当 repo 来扩大匹配。
如要验收其他项目，须另行确认 repo ID／真实 root，再改此独立配置，不能假造映射。

- [ ] 验证实际配置解析结果（仅给这一个 Node 子进程传入 AXMEM_CONFIG；不修改窗口环境、不读记忆正文、不创建 store）：

```powershell
node -e "process.env.AXMEM_CONFIG=process.argv[2]; const c=require(process.argv[1]); console.log(JSON.stringify({config:c.AXMEM_CONFIG,...c.resolveRuntimeConfig()},null,2));" "$Root/lib/prelude.cjs" "$Config"
```

预期：`config` 为独立 config.json；`memoryRoot` 为 PMM memory；`stateRoot` 为独立 state；`enabled: true`；`kernel_sender: external`；`max_items: 3`。
任何 `.claude` 下的 stateRoot／非 external 发送者都不能继续。其他宿主继承环境的风险仍按第 1 节处理。

- [ ] 先确认还没接上（本清单在创建配置后核对；status 本身不要求 config/root 仍存在）：

```powershell
node "$Root/adapters/claude-code/trial-install.cjs" --settings "$Settings" --root "$Root" --config "$Config" --record "$Record" --status
```

预期首次：`0/3 present; counts=0,0,0`、`active=none`、`exists=false; sha256_matches=n/a`，command 行为第 0 节全文。
工具所有模式都必填 `--root <绝对路径>`、`--config <绝对路径>`，统一转为正斜杠；相对路径或路径含双引号、美元号、反引号、换行会拒绝，零改动（另保守拒绝其他控制字符、% 和 !）。
**仅 apply／dry-run 检查 config 为已有文件、root 内有 hook.cjs；rollback／status 只规范化这两个路径，不检查它们是否存在**，以便原目录或配置被移动／删除后仍可退线。
若是已有记录或部分接线，先找负责人核对，不要借本清单接管别人的条目。还须确认没有上一轮的裸 node 接线：
它与带 config 的命令是不同身份，若两者并存会重复运行；本工具不会猜测并删除旧身份。

- [ ] 预演：

```powershell
node "$Root/adapters/claude-code/trial-install.cjs" --settings "$Settings" --root "$Root" --config "$Config" --record "$Record" --dry-run
```

预期：退出码 0，`would add 3 hook(s); no writes`，随后只有第 0 节 3 个身份，**各命令均含相同 AXMEM_CONFIG 前缀**。
此时不产生备份／记录、不改 settings。不是 3 就停。工具只检查 config 路径安全且为已有文件，不代替上述配置语义验证，不检查记忆源，也不代写配置。

- [ ] 确认此刻没有别的程序在改 settings.json，再应用一次：

```powershell
node "$Root/adapters/claude-code/trial-install.cjs" --settings "$Settings" --root "$Root" --config "$Config" --record "$Record" --apply
```

预期：退出码 0、`added 3 hook(s)`，打印 backup 路径、原 SHA256 和 record 路径；hash 应与外部笔记一致，把 backup 路径也记下来。
三个事件各追加一组，PMM 原组不动。写任何文件前先检查 settings 的 JSON 结构和语义往返：拒绝重复键（含转义后相同的键）、超出安全整数范围的整数，或 parse/stringify 后不再 deep-equal 的值（如 -0／溢出数），拒绝时不生成备份／记录、不改 settings；dry-run 同样预检。
检查通过后，工具以 `wx` 独占创建原字节备份并读回校验，再原子写安装记录，再用 `lib/atomic-write.cjs` 原子发布 settings。
记录含绝对 settings/root/config、备份路径、备份 SHA256、安装后 SHA256、本次实际新增完整命令身份、active 状态。
第二次 apply 是 no-op，不改备份／记录／mtime；不必为了安装再运行第二次。

- [ ] 确认接线：

```powershell
node "$Root/adapters/claude-code/trial-install.cjs" --settings "$Settings" --root "$Root" --config "$Config" --record "$Record" --status
```

预期：`3/3 present; counts=1,1,1`、`active=true`、`exists=true; sha256_matches=true`，command 行包含明确 config 路径。
`counts` 不是全 1 表示已有重复／缺项，不能把“3/3 present”单独当成功。status 只核对接线／备份，不证明宿主已加载或输出已送达。

## 3. 新会话里的三件真实小任务

- [ ] 先确保试验文件名没被占用：

```powershell
Test-Path -LiteralPath "$Root/trial-recall-note.md"
```

预期：`False`；若 True，换一个已确认不存在的文件名，不能覆盖用户文件。

- [ ] 到验收 repo 启动**全新** Claude Code 会话（不是 resume，不是在旧会话里输入测试；也可从其他平常入口开全新会话）：

```powershell
& { Set-Location -LiteralPath $Root; claude }
```

预期：PMM 原有 banner／Kernel 照旧；AxMem 只有一次 SessionStart 来源／健康状态，并说明 external、不发第二份 Kernel。
- [ ] **首次验收须确认宿主确实通过 POSIX shell 运行这 3 个 hooks**：出现 SessionStart AxMem 状态行，表示带环境变量前缀的命令生效；若该状态行没有出现，立即回滚，不继续验收。随后按下列 Prompt／PreToolUse 实测核对另两个事件。

不依赖启动窗口的 AXMEM_*；桌面应用的新会话也应读到相同独立配置。旧会话可能要重启才生效或失效，不保证立即切换。
如果来源不可用／degraded，先回滚；不能把故障解释成“零匹配”。已有 PMM 脚本是否理会 AXMEM_CONFIG 也须实机观察，本次未检查其私有实现。

以下是发给 Claude 的三条任务，不是 PowerShell 命令。用真实现有记忆来判断相关性，不新造规则、不改真实 memory。

- [ ] **纯问答**：`这个项目对 Markdown 文档格式有什么约定？只回答，不调用工具。`
  如果这不是你已有记忆中的真实主题，改问一个你能判断是否相关的真实小问题（可带一个已知真实 tag）。
  看 UserPromptSubmit 的召回：相关才出现，**动态正文最多 3 条**，有 tag／文件／行号，提醒不变成新命令，不重复 PMM banner。
  如果本来没有匹配，应当安静，无“本地查询完成”一类刷屏；SessionStart 一次性心跳不算每轮刷屏。
- [ ] **改一个小文件**：`在当前仓库新建 trial-recall-note.md，只写一行 phase-1 recall trial，不改其他文件。`
  看真实 Write／Edit 调用前是否出现适用的 `[AxMem 动手前召回：仅提醒，不拦截]`，不是执行后才补一句。
  没有适用规则时保持安静；有时最多 3 条，整条展示或明确 omitted，不把截断规则当完整正文。
  观察 PMM 原有 Post trigger-recall：不能在工具后再把刚才同一规则重复刷一遍；旧写闸／receipt 不能丢失或变成两套。
- [ ] **跑一条 Bash 命令**：`在当前工作目录用 Bash 运行 node --version，只运行这一条，不用管道、引号、重定向、变量或 cd 组合。`
  看 PreToolUse 召回是否在 Bash 之前、是否相关／最多 3 条、命令是否正常完成、PMM 的 Bash hooks 是否仍正常。
  简单 Bash 才在阶段 1 的已支持范围；shell 包装器／复合语法会在回执中记 unknown，不该刷提示。

三项都要记录：Claude Code 版本、时间、是否命中、工具前／后顺序、是否重复、对应 receipt 的 invocation_id。
**三项全无命中不能证明“有命中时 Pre 确实送达”**。若遇到这种情况，用已知真实 tag／已知适用路径替换相应任务再验，
不要编造“看到了提醒”；仍无法触发就记验收未完成并回滚。
Prompt 已提醒后，Pre 对本次真实动作仍可再提醒；这是阶段口径，不等于 PMM 在 Post 又重复正文。

### 在哪里看耗时和失败

- [ ] 在操作 PowerShell 窗口读本次独立回执：

```powershell
Get-ChildItem -LiteralPath "$State/recall" -Recurse -File -Filter '*.jsonl' | ForEach-Object { Get-Content -LiteralPath $_.FullName | ForEach-Object { $_ | ConvertFrom-Json } } | Where-Object { $_.schema -eq 'axmem.cc.recall.v1' -and $_.stage -in @('completed','no-match','unsupported','suppressed','unavailable','emission-failed') } | Sort-Object invocation_started_at | Select-Object -Last 12 invocation_id,event,stage,tool,selected,displayed,elapsed_ms,stdout_result,error_codes
```

预期：三个事件有对应行；健康的无命中是 no-match／unsupported、displayed=0、stdout_result=not-attempted，error_codes 为空。
有其他会话活动时回执也可能来自其他会话，要按 invocation_id／时间对应本次任务，不只看最新一行。
延迟读最终结算行的 **`elapsed_ms`**，不是 prepared 的初始 0；同时看宿主是否有明显卡住／超时。
`elapsed_ms` 从 handler 开始，**不包含 stdin 最多 1 秒等待及 Node 启动**，不能把它当端到端硬上限。
另外可看 `maintenance_errors`（维护诊断，不等同本次召回失败）、`action_reason`、`path_status`。
只生成 prepared、不生成 emitted 不算正文送达；hostConfirmed 恒为 unknown，回执不能替代真人看顺序。

**PMM 与 AxMem 是两个独立入口。** 本次不改真实 PMM trigger-recall，不能保证它读取 AxMem 的 Pre marker 来跨入口去重；
合成测试中的 AxMem Post 兼容去重不等于真实 PMM 去重已经通过。若实际双推，就判试装失败并回滚，不删 PMM hook 来掩盖问题。

### 立即停用并回滚的红线

- [ ] 任一 hook 报错并挡住任何工具。
- [ ] 单次 hook 超过 **2 秒**（receipt.elapsed_ms > 2000，或宿主观测端到端 > 2 秒，也不能放过）。
- [ ] Kernel／常驻规则注入两遍。
- [ ] 召回正文肉眼明显不相关。
- [ ] PMM 原有 banner／trigger-recall 被重复刷出，或者接线数／来源／状态位置不符。

## 4. 回滚（正常验收结束也可随时执行）

- [ ] **回滚那一刻不要有别的程序在改 settings.json**；不用先关掉所有会话。先保留 config、备份和安装记录。
  如果窗口已经关闭，重做第 1 节“建立操作变量”，再从外部笔记重建 `$BeforeSha`（不要重新对当前 settings 求 hash 来冒充原值）：

```powershell
& { $v=(Read-Host '粘贴外部笔记中的安装前 SHA256').Trim().ToLowerInvariant(); if ($v -notmatch '^[a-f0-9]{64}$') { throw 'Invalid original SHA256' }; $script:BeforeSha=$v; $BeforeSha }
```

  回滚工具不依赖 AXMEM_* 环境，仍须传原来的 root/config 路径以匹配身份，**但原 root／hook.cjs 和 config 文件已不存在也能 rollback／status**。
  若旧 root 已被删，请用一个仍存在、已交付并自测通过的副本来运行 `trial-install.cjs`（替换下面命令的脚本路径），`--root "$Root"`／`--config "$Config"` 参数仍保留旧值；settings、原备份和记录必须可读。
- [ ] 一步退掉本次接线：

```powershell
node "$Root/adapters/claude-code/trial-install.cjs" --settings "$Settings" --root "$Root" --config "$Config" --record "$Record" --rollback
```

预期退出码 0，并明确打印下列分支之一：

1. `exact-restore (backup bytes restored)`：当前 JSON 仍等于“原备份 + 本次实际新增条目”，恢复**原始字节**（含 CRLF、缩进）。
2. `identity-only (settings changed; ... other edits kept)`：有人做过别的改动，只按本次记录的带 config 完整命令身份移除本次新增条目，保留其他人的改动和原有空组。
   **实际移除 0 条时保留 settings 原字节和 mtime，不重排、不清理空组**（例如 apply 在发布前中断，或他人已手工移除条目）。
   仅在移除 >0 时清理本次创建、且现在为空的组／事件数组／顶层 hooks；有新 metadata／其他 hook 的组不会删。
   若外部制造了多份完全不可区分的空组，工具保守保留，不猜归属；人工核对，不能为了“干净”批量删除其他人的组。

若原来已经有相同身份，本工具不会记作“自己新增”，也不会在回滚时删除它；本清单首次预检 0/3 所以预期全退到 0/3。
裸 node 命令／其他 config 前缀不属于本次身份，不会被误删。记录绑定 root/config/settings，不可用另一个 config 接管；上一轮无 config 的旧记录也不会被自动迁移。
备份缺失／SHA 不符会拒绝回滚；不要直接覆盖 settings，先找负责人处理备份完整性。
异常中断发生在 settings 发布之前时，也有先写好的备份／记录可用于安全回滚；但这不是跨文件的事务系统。
工具在发布前复核 settings 字节，仍**不是多个写入者的原子 compare-and-swap**，所以安装／回滚时不能有其他 settings 写入者。

- [ ] 确认退线（仍用原 config）：

```powershell
node "$Root/adapters/claude-code/trial-install.cjs" --settings "$Settings" --root "$Root" --config "$Config" --record "$Record" --status
```

预期：`0/3 present; counts=0,0,0`、`active=false`、`exists=true; sha256_matches=true`。
备份／记录保留用于审计，重复 rollback 是 no-op，不会误删后来重新出现的同身份条目。

- [ ] 核对原 SHA256：

```powershell
& { $now=(Get-FileHash -LiteralPath $Settings -Algorithm SHA256).Hash.ToLowerInvariant(); "current=$now"; "before=$BeforeSha"; "equal=$($now -eq $BeforeSha)" }
```

预期 **exact-restore 分支**为 `equal=True`，且和外部笔记原 hash 一致。若不是 True，停下核对，不能宣布精确回滚成功。
**identity-only 分支有他人改动时 hash 应当不同**；此时验收标准是 0/3 且他人改动仍在，绝不能为追求 hash 相同而强制恢复旧备份。

- [ ] 从任意平常入口再开一个**全新 Claude Code 会话**。
  预期：AxMem 额外 SessionStart 状态／召回输出消失，PMM 原有 Kernel／banner／纪律 hook 仍正常。
  **以新会话为准，旧会话可能要重启才失效**。如旧会话仍输出，安排其重启；不要先删 config/state 迫使它落回默认目录。
  关闭操作窗口不是回滚：配置已经固定在 settings 的命令里，必须先移除接线。

- [ ] 可选、可延后清理本次独立 state（仅在第 1 节确认为原来不存在、已退线且确认没有旧会话／在途 hook 再读写它之后）：

```powershell
& { if ($State -cne 'C:/Users/jax-x/AppData/Local/AxMem/cc-phase1-trial/state') { throw 'unexpected state path' }; $i=Get-Item -LiteralPath $State -ErrorAction Stop; if ($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'refuse linked state' }; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($State,[Microsoft.VisualBasic.FileIO.UIOption]::AllDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin) }
```

预期：**弹出系统确认对话框，核对目标并确认移到 Windows 回收站；取消则保留目录**。若系统提示永久删除，不确认；失败就用资源管理器选中准确的 state 文件夹，普通 Delete 移到回收站，再核对。
不能确认无读写者就保留它；不要求为清理而现在结束所有工作会话。
config.json 同样可在确认无读取者后用资源管理器移入回收站；移走后仍可用原 root/config 路径运行 status／重复 rollback，这两个模式不要求原 config 存在。
**禁止 Shift+Delete、`Remove-Item -Recurse`、`rm -rf` 或任何永久删除**；不要删父目录 Trial，不要删 `~/.claude/memory`、settings、备份或其他 AxMem state。
如须清除试验生成的 `trial-recall-note.md`，也仅在确认是本次新建、无后续用户编辑后移入回收站，不删除其他仓库文件。

## 5. Codex pin 闭包（只交接，不在这次试装中执行）

**结论：A1 第一轮前的 Codex action-receipt base manifest 需要重建／重新 pin**。
`core/memory-source.cjs` 在 A1 第一轮改过原始字节，且在 `adapters/codex/action-receipt-opt-in.cjs:7-22` 的 14 文件 EXPECTED_BASE 内；
`:84-98` 校验原始字节 SHA256 和 bytes，不按 LF 逻辑等价放行。本轮 A2 仅改安装工具／测试／清单，不增加闭包变更；后续 A1 收尾以整合后的实际字节为准。
本次未查看真实 manifest，**不知道负责人是否已经更新过**。旧 manifest 必须更换；若已按当前字节更新，只需常规核验，不要盲目重签。
这里所谓“重签”是重建 hash pin 清单及其外层 SHA256，不涉及私钥数字签名，也不启用 ACK。

交给 Codex 负责人，在单独批准的后续工作中审核 14 个文件后运行下列命令（替换两个占位路径；使用 Codex 自己批准的配置，**本清单不执行**）：

```powershell
node -e "const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'); const hash=b=>c.createHash('sha256').update(b).digest('hex'); const names=['adapters/codex/action-receipt-gate.cjs','adapters/codex/action-receipt-state.cjs','adapters/codex/action-receipt-opt-in.cjs','adapters/codex/pre-tool-recall.cjs','adapters/codex/recall-context.cjs','adapters/codex/recall-selector.cjs','core/memory-source.cjs','guards/pmm-core.cjs','guards/pmm-trigger-glob.cjs','guards/pmm-trigger-recall.cjs','guards/pmm-recall-ledger.cjs','guards/pmm-recall-policy.cjs','guards/vendor/minisearch/index.cjs','guards/vendor/path-is-inside.cjs'].sort(); const files=names.map(path=>{const b=fs.readFileSync(p.join(process.argv[1],path));return {path,sha256:hash(b),bytes:b.length};}); const b=Buffer.from(JSON.stringify({schemaVersion:1,files},null,2)+String.fromCharCode(10)); fs.writeFileSync(process.argv[2],b,{flag:'wx'}); console.log('base-manifest-sha256='+hash(b));" '<Codex批准的base-root绝对路径>' '<新manifest绝对路径>'
```

这是创建新 manifest 的命令，不会覆盖旧文件。负责人还须在其原 Codex 验证调用中同时更新
`--base-manifest-file <新路径> --base-manifest-sha256 <刚打印的hash>`，复核原 scope/policy pin，不修改它们来凑通过。
不要把这条命令放进 CC hook，不运行 `action-receipt-opt-in.cjs` 来尝试签名（它没有签名子命令）。
**本次试装不接线、不启用、不卸载、不改写任何真实 Codex 配置或 manifest。**

## 6. 本交付的自动化证据（不代表真人验收通过）

- `node adapters/claude-code/test-trial-install.cjs`：退出 0，**37/37；guard-removal red evidence 37/37**。
  原有 23 项保留：dry-run、仅 3 条／保序、二次 no-op、原字节回滚、他人修改保留、坏 JSON、坏 root、缺参、跨组 trim 去重、
  空容器归属、移动组／他人空组保留、预存身份不接管、备份 hash、原子发布中断、status 只读、先记录再发布，
  以及 config 前缀／精确身份／仅 AXMEM_CONFIG 解析及环境覆盖、config 必填、相对路径拒绝、缺文件／目录拒绝、
  双引号／美元号／反引号／换行拒绝、记录绑定原 config、config 不得与 settings/record 同路径。
  原存在性用例按本轮契约区分模式：apply/dry-run 仍拒绝缺失输入；rollback/status 不再 stat root/config，而不是削弱安装检查。
  本轮新增 14 项：
  - apply 后删除 root 和 config，status 仍为 3/3、rollback 成功，随后 status 为 0/3；
  - 9 个补缺 guard：active record 缺一条仍拒绝重装且备份链不变、record 不得声称预存身份、applied_sha256 计划校验、
    备份读回校验、assertUnchanged（三个写入边界）、备份 wx 碰撞保护、settings 结构校验、record 备份路径绑定、root 美元号／反引号安全检查；
  - 移除 0 条时 CRLF／缩进／键序／空组／mtime 全保留；大整数、重复键（含嵌套及转义同名）、语义往返丢失各一项零写入检查。
  合法文件名中的美元号／反引号有真实临时 root/hook 和 config，不以“文件不存在”代替安全拒绝。
  每项在临时源码副本中移除对应 guard／约束，再运行同一断言，必须捕获 **AssertionError** 才记 EXPECTED-RED；
  普通异常记 MUTANT-CRASH，启动／超时错误、信号、异常退出码、无正常 CLI refusal 的未捕获子进程异常均不计红证据。
  构造变异副本／夹具发生的断言也不计。另有 **mutation-harness classification 5/5**：存活、断言失败、普通异常、exit(7)、未捕获子进程异常分类探针。
  这是可重复的 guard-removal mutation 证据，不声称生产实现曾按时间顺序留在一个红的工作树里；不删除原有用例。
- `node adapters/claude-code/merge-hooks.cjs --self-test`：退出 0、无 FAIL（6/6）；merge 行为未改。
- 本轮只运行上述两条 allow-cmd；未运行 hook 自测（本轮未获准），第 1 节 A1 数字仅供未来整合验收，不冒充本次输出。
  未运行 fresh-home shell 测试或其他命令，未做真实安装／真实记忆读取／真机显示与热加载测试，未做 Codex 重签。
  未读取真实 `~/.claude`／`~/.codex*`／`~/.axmem`，不运行 git；只改允许的三个文件，变更留在工作树未提交。
