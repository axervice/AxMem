# P2.0 freeze execution plan — 2026-09-29

Scope: **P2.0 only** from `docs/P2-CC-PERFECT-SPEC.md`. P2.1 remains hard-blocked until a real `docs/freeze/FREEZE-<date>.json` exists and its self-equivalence report is green.

## Facts already closed

- [x] Legacy AxMem public-export handoff closed at `00bd338`; follow-up status at `28987fb`.
- [x] codex-tools CT-A/B/C + `06d61e0` 已整合并在主仓验收到 `25666766d2fbf3aeb47764d7344d736b9b483d3a`；130 测试及独立反例通过。本 P2.0 收口不重跑该批。
- [x] live PMM denial-ledger handoff closed at home commit `746682d`; direct ledgers/gates green; final current affected canary subset **48/51** with the three reds proven pre-existing; audit-count correction recorded at home commit `7915c13`.
- [x] historical live audit hard gate exists in the live CHANGELOG: fab blind attack findings fixed, codex(gf) final-wave findings fixed, Opus final incremental 13/13 GO.
- [x] current live code candidate is committed; only tracked dreams runtime-data rows remain dirty. They are **not** silently excluded from the formal clean-source predicate.

## P2.0 machine contract

1. `scripts/p2-freeze.cjs` generates a freeze only from a committed, clean live source scope. Any tracked or untracked change in that scope is fatal and no output file is written.
2. Freeze input inventory must account for every live hook by exact event/group/hook order, matcher and command, and every hook must name its file/dependency closure plus one disposition: `port | replace | external-prerequisite | private-exclude`.
3. Freeze output records source commit, live-tree OID, an explicitly empty patch state, exact hook order, per-source-file SHA256, dependency references, audit evidence and allowed differences.
4. `scripts/equiv.cjs` compares normalized hook-result reports case by case: exit code, stdout, stderr and normalized state tree. Unexpected differences are fatal; allowed differences require an exact case+field entry with a reason.
5. `tests/fixtures/p2-equiv/events.json` contains at least 3 cases for each required event: Bash, Edit, Write, SessionStart, SessionEnd, UserPromptSubmit, PreCompact.
6. P2.0 self-proof first compares a frozen report with itself and must be exactly equal. A deliberately mutated report must go red.
7. Public free-tier export must remain byte-identical: `scripts/**`, `docs/freeze/**` and P2 fixture/test material are excluded; the private `bin/axmem equiv` usage/case is removed by exact publish replacement.
8. No formal `FREEZE-*.json` is created while the live source is dirty. No P2.1 work starts before that file + a green self-equivalence report exist.

## TODO

- [x] Freeze generator + hermetic tests.
- [x] Equivalence **runner + comparator** + 21-event fixture + hermetic tests. Initial comparator-only design was insufficient: two hand-authored identical reports could false-green without executing any hook. Fixed by materializing exact frozen blobs into a temp HOME, executing `port|replace` hooks, capturing rc/stdout/stderr/state delta, normalizing paths/timestamps, and proving external prerequisites are skipped. R2 有界验收：machine **33/33** + regression **34/34**；主审另独立复验缺模块+隐藏 stderr 双次阻断、合法 exit2 双次 21 例等价、动态/静态依赖识别。source freshness 仍为 `unproven`，不得外推为全项目无 bug。
- [x] Wire private `bin/axmem equiv <run|compare>`; isolated CLI smoke green. Public export removes this private entry via exact replacement.
- [ ] Prove **current-source** public export tree unchanged. 旧 `a8f8c6d`/旧快照结果仅作历史证据；当前验证必须在无网络、无真实 HOME、无 push 的隔离临时仓内，将现工作树精确合成为临时提交后运行 exporter，并与当前 `public` 基线做字节/路径对比。
- [ ] Build real live inventory/dependency closure against current live settings. 2026-09-29 复核：live `settings.json` 与 tracked mirror SHA256 均为 `199f52f1f75f2dd8c509f8bfa6d22e729bf210a3fdd2131eb521c82cd8d2eaec`，32-hook 顺序/command/matcher 一致；现 v0 draft 仍缺逐 hook 可机验退出健康证据，并存在静态漏边/动态依赖待补，禁止升为 formal inventory。
- [ ] Obtain a clean freeze source and generate `FREEZE-<date>.json`.
- [ ] Run frozen-live vs frozen-live report and archive green evidence.
- [ ] Only then mark P2.0 complete / permit P2.1.
