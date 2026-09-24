<!-- STATUS: 与迁移线一并暂停(2026-09-16)。其中 Q-1 codex 包装器与 Q-3 引擎+语料同提交闸不依赖迁移,可独立复活。 -->
# 积压清单一次排干(与第十四轮同一建造者,串行,在第十四轮 Part A/B/C 之后执行)

主仓库绝对路径 `C:/Users/<user>`。硬约束与验证纪律同 `spec-round14.md`。**每项独立提交,便于回溯。**

## Q-1 · codex 包装器:死回退分支覆盖原始故障码

`~/codex-tools/bin/codex-review.sh` 的 `codex_exec_with_gf_fallback`:主账号 rc=2(限流,可恢复)时回退到 gf;
gf 对当前模型永久不可用(rc=1「model not supported」),最终只暴露 rc=1「非认证非限流」,**原始限流信号被覆盖**,
triage 被引向查认证。实证:2026-09-15 一次审查烧 495k token 零产物后即因此误判。

**要求**:
1. 回退失败时,若其失败原因**不是**限流,则最终 rc 与 stderr 以**主账号**为准,并额外打一行「fallback 亦失败:<gf 原因>」。
2. 回退前先做一次廉价探测(或读 `.codex-gf/.last-fail.log` 的最近失败类型);若 gf 的最近失败是「model not supported」
   一类永久性错误,**跳过回退**,直接以主账号结果收场。
3. 自测:模拟「主 rc=2 + gf rc=1」→ 最终 rc 必须为 2;模拟「主 rc=2 + gf rc=0」→ 最终 rc=0;模拟「主 rc=0」→ 不触发回退。
4. 镜像到 `_local-config`;这不在 `guards/`,指纹册按现行规则决定是否入册。

## Q-2 · 金丝雀执行器丢弃输出

`guard-canary.sh` 以 `"$@" >/dev/null 2>&1` 执行每台守卫,翻红只给名字。实证:一次一次性红耗一整轮诊断,成因至今未证。

**要求**:
1. 每台守卫的 stdout/stderr 落到 `$LOG_DIR/<序号>-<slug>.log`(目录可配,默认临时目录,跑完打印路径);
2. 记录每台耗时(秒)与退出码到汇总行;**「有没有耗时」本身是诊断信息**;
3. 翻红时汇总行直接给出该台日志路径;
4. 名册行数、EXPECTED、`--self-test` 分支的 synthetic-must-fail 臂**一律不动**;
5. 自测:造一台必红的假守卫,断言其日志文件存在且非空、汇总行含路径与耗时。

## Q-3 · pre-commit 闸:同一笔提交不得同时含引擎与语料

**依据**:2026-09-15 并发会话一笔自称产品上线的提交卷走了本会话代理未提交的守卫改动(内容未丢,归属被污染,
破坏「审查戳绑定 diff」模型)。

**要求**:
1. `.githooks/pre-commit`(或现有 `pmm-precommit-gate.sh`,以现行接线为准)增加检查:暂存区若**同时**含
   `.claude/guards/**/*.{cjs,sh}` 与 `.claude/memory/*.md`(不含 `dreams/`、`_local-config/`、`CHANGELOG.md`、`audits/`),
   拒绝并列出两侧文件;
2. 环境变量 `PMM_ALLOW_ENGINE_CORPUS_COMMIT=1` 放行(C1 切换那一笔要用),放行时打一行留痕;
3. 自测:三例——只引擎/只语料/两者混合,前两例过、第三例拒;第四例混合 + 放行变量 → 过且留痕;
4. 镜像 `_local-config`,入指纹册,入金丝雀名册(EXPECTED +1)。

## Q-4 · 重生成并提交当前 OID 的 pin+plan(**主会话的账,建造者不做**)

在 Part C 落地后由主会话执行:`--pin-d1` + `--plan` 写入真 `specs/`,提交;8 份旧文件不删,
在 `specs/README.md` 标明「排序语义过期,仅作历史证据」。目的是让 C0 模式的金丝雀转绿。

## 完成标准(叠加在 spec-round14 之上)
Q-1 至 Q-3 各自独立提交;各自的自测先红后绿;金丝雀名册 43 → 44(Q-3);指纹册 check 为 0;
`pmm-manifest-v2.cjs --check` 阻断分布不变。报告写出简报写错或没想到的地方。
