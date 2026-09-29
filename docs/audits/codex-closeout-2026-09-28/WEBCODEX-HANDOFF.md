# WebCodex continuation handoff — 2026-09-29

本文件继续 2026-09-28 的 `WEBCODEX-HANDOFF.md`。只记录 WebCodex 实际观察/执行过的事实；未验证项保持未完成。

## TODO

- [x] 同步 PMM；home `HEAD == origin/master == f0523bae33cf652fd7cf927bc48bd1528e082aeb`，未对脏 home 做 rebase。
- [x] 读取全局 `AGENTS.md`、PMM 入口/config、AxMem North Star/P1/P2 计划和原 `WEBCODEX-HANDOFF.md`。
- [x] 核实 AxMem 原生 Windows Git 工作区：真实变更仅 handoff 的 5 个文件；此前 WSL `/mnt/c` 下显示 53 个修改是跨 Git/换行环境假象，不作为工作区事实。
- [x] 建立隔离验证 commit `b7b1d92977e3041a79520c98df5abef69aa32164`（parent `1641eba97723dd1e35da6cc152d7f64624d44c84`），仅含 handoff 5 文件。
- [x] 丢弃错误基线验证：临时 clone 的 `main` 一度仍指 `1641eba`；旧树 GATE3 的 `tests/inherit-real-env-arms.sh` 仍是宽泛 `grep -rq "XDG"`，所以 34 pass / 2 skip / 1 fail 不能用于评价 handoff 修复。
- [x] 修正临时 clone：`HEAD == main == b7b1d92`，工作树 clean。
- [x] 第一轮完整公开导出：GATE0=0 drift；GATE1=0；GATE2 PASS；GATE3 PASS；GATE4=158 entries/0 findings；GATE5=158 exact paths；`EXPORT_TREE=631369239f5b9b72f006cbaaa868016bcbcb7778`；未 push。
- [x] 第二轮同源公开导出完成：GATE0–5 再次全绿，`EXPORT_TREE=631369239f5b9b72f006cbaaa868016bcbcb7778` 与第一轮完全相同；导出器明确报告 `IDEMPOTENT`，无新 commit、无 push。
- [x] 已将修复原因、错误基线为何作废、验收口径与回滚说明写入主仓 `CHANGELOG.md`；因 `CHANGELOG.md` 是 overlay target，已按正式 `--update-overlay-baseline CHANGELOG.md` 流程刷新 baseline。
- [x] 最终内容审阅完成：主仓仅 8 个本批文件（handoff 原 5 个 + `CHANGELOG.md` + `publish.manifest.json` + 本 continuation handoff）；`git diff --check` 通过。刷新 CHANGELOG baseline 后又跑一轮完整 GATE0–5，仍为同一 `EXPORT_TREE=631369239f5b9b72f006cbaaa868016bcbcb7778` 且 `IDEMPOTENT`。
- [ ] handoff Priority 1（`C:/Users/jax-x/codex-tools` 三项已复现 bug）：WebCodex 当前 Runner allowed root 只有 AxMem，正规 project bootstrap 被 `path_outside_allowed_roots` 拒绝；取得对应项目访问后继续，不绕权限。
- [ ] handoff Priority 2（home PMM ledger 直接测试/51 canary）：同理需要对应 home 项目权限后按原 handoff 验证，不在 AxMem project 里直接写。
- [ ] P2.0 freeze：仅在当前遗留 closeout 和活体审计前置满足后开始；没有 FREEZE 清单时不得进入 P2.1。

## 回滚

- 接手前 handoff 五文件 + `CHANGELOG.md` 原字节、SHA256 和 `handoff-five.patch` 已保存到 session-local rollback 目录。
- 当前公开验证只更新隔离 clone 的本地 `public` ref；没有触碰公开远端。
- 若后续主仓提交有误，优先按该提交做 `git revert`；不要回滚其它会话/其它批次文件。
