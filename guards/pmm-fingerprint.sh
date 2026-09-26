#!/usr/bin/env bash
# 守卫代码指纹册(2026-09-14,fab 盲攻元层1,the maintainer 批「A 上」)
# 病根:守卫脚本随记忆 git 同步,记忆写权≈跨机代码持久化权;漂移检查只说"活体≠备份",
#       不定义谁是真相。改守卫无人知=最便宜的一招。
# 机制:名册记每台守卫的 sha256;check 时任何指纹变化/新增/缺失 → 红;
#       合法变更唯一入口 = refresh "<理由>":重写名册 + 逐字落一张 guard-change 收据
#       (谁改、为什么,月度 dream 列清单)。没走 refresh 的改动 = 报警。
# 用法: init | check | refresh "<理由>" | --self-test
set -u
# part13 收口(2026-09-17,M-6a):家目录一律经 pmm-home.sh 拿 $PMM_HOME_RESOLVED,不直读 $HOME
# (pipe-gate-v2-acceptance.cjs self-check part13——本文件此前 2 处直读)。
source "$(dirname "${BASH_SOURCE[0]}")/pmm-home.sh"
FPHOME="${PMM_FP_HOME:-$PMM_HOME_RESOLVED}"
ROSTER="${PMM_FP_ROSTER:-$FPHOME/.claude/guards/FINGERPRINTS.tsv}"
RECEIPT="${PMM_FP_RECEIPT:-$PMM_HOME_RESOLVED/.claude/memory/_local-config/pmm-receipt.sh}"

covered() { # 相对 FPHOME 的守卫文件清单——变更追踪范围(哪类代码功能强、需要被盯防),不是可执行性
            # 声明:指纹一致只证明"备份字节==活体字节",从不断言"这份文件能在它所在目录被独立执行"
            # ——两者是不同维度(2026-09-15 round-8 R8-3,guards/audits/OPUS-2026-09-15-round8-review.md
            # MEDIUM-2:_local-config/ 下的守卫镜像有三个字节一致却原地跑不动,见该目录 RESTORE.md
            # 的「可执行性契约」一节;那类问题此清单天生看不见,也不打算看见)。
  # 2026-09-17(M-7,fab 盲攻 + Opus 复现):覆盖面扩到四类此前看不见的守卫相关代码/数据——
  # guards/mutants/*.cjs(v2 验收跑的变异体,判断力本身该被盯防)、guards/fixtures/**(含
  # trigger-write-gate-probe.cjs 这类探针脚本、corpus-whole/ 这类喂给守卫的夹具数据,递归)、
  # guards/specs/*.json(含各 *-PINNED-*.json/*-pins*.json 这类"pins"文件——它们本就是 .json,
  # 落在这条 glob 里)、guards/specs/*.md、guards/vendor/**(vendor 代码换了但没走 refresh =
  # 同样的"改守卫无人知")。fixtures/、vendor/ 都是目录树,globstar 未必开着,用 find 递归列
  # 文件,不靠 shell 的 **。
  # 2026-09-24(M7,主脑批审 + spec 22 勘误 E-16):`guards/vendor/*.cjs`/`*.LICENSE` 曾是顶层 glob,
  # 盖不到子目录(`vendor/minisearch/index.cjs`、`vendor/minisearch/LICENSE`)也盖不到非 .cjs/
  # .LICENSE 扩展名(`vendor/acorn.js`、`vendor/VENDOR.md`)——实测旧 covered() 只收 3/7 个 vendor
  # 文件。改成 `find guards/vendor -type f` 递归(与 fixtures/ 同一手法),不再枚举扩展名。
  # 2026-09-23(A1 批,codex#10 HIGH,「指纹册不覆盖 settings/manifest/git hook」):四类此前完全不在
  # 变更追踪范围里的配置/接线文件——settings.json 的活体与镜像(deny 列表、hooks 段接线全在这
  # 一个文件,改了没人知道)、_local-config/hook-manifest.txt(接线清单本身)、家仓 git hooks 的
  # pre-commit/post-commit(不入 git 版本控制——.gitignore 挡了 .git/ 目录,指纹只能按活体文件算,
  # 唯一的"提交记录"就是这份指纹册+它的收据)。这里只扩 covered() 的清单本身;名册项(旧哈希→新
  # 哈希那一行)照纪律留到收口时统一 refresh 生成,这次不刷。
  # 2026-09-24(主脑裁决,spec 补遗三 §32,收口者实证 CHANGELOG 09-24「收口 B 段」/ Opus spec 审第
  # 31 条):`.claude/guards/specs/*.json` 这个 glob 此前也收 `specs/D1-PINNED-*.json` 与
  # `specs/PLAN-*.json`——但这两类文件从 2026-09-24 起改按「语料内容指纹」定键/定新鲜度(见
  # pmm-migrate-v3.cjs 的 computeCorpusFingerprint()/pmm-c0-canary-check.sh),不再依赖 treeOid;
  # 它们自身的完整性因此已经由 pmm-c0-canary-check.sh 按内容指纹核对(文件名 + 内部字段双重校验),
  # 不需要再让这本按 sha256 逐字节盯防「改动无收据」的指纹册重复盯防一遍。反过来,若仍留在覆盖集里,
  # 每次为语料重新生成 D1-PINNED/PLAN(纯粹的正常工作流,不是「改守卫」)都会被 check 判成「未入册/
  # 已变」的红——这本是指纹册该管的「谁在没人知道的情况下悄悄改了守卫代码」,不该管「语料变了所以
  # 生成了一个新文件名的计划文件」。故显式排除这两类,交给 c0-canary-check 专责。
  ( cd "$FPHOME" && {
      ls .claude/guards/*.sh .claude/guards/*.cjs .claude/pmm-*.sh .claude/pmm-*.cjs \
         .claude/hooks/*.sh .claude/memory/_local-config/*.sh .claude/memory/_local-config/*.cjs \
         .claude/guards/mutants/*.cjs \
         .claude/guards/specs/*.json .claude/guards/specs/*.md \
         .claude/settings.json .claude/memory/_local-config/settings.json \
         .claude/memory/_local-config/hook-manifest.txt \
         .git/hooks/pre-commit .git/hooks/post-commit 2>/dev/null
      find .claude/guards/fixtures -type f 2>/dev/null
      find .claude/guards/vendor -type f 2>/dev/null
    } ) | grep -v 'FINGERPRINTS' | grep -vE '^\.claude/guards/specs/(D1-PINNED|PLAN)-' | sort -u
}
sha() { ( cd "$FPHOME" && sha256sum "$1" 2>/dev/null | cut -c1-16 ); }

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  init)
    : > "$ROSTER"
    while IFS= read -r f; do [ -n "$f" ] && printf '%s\t%s\n' "$f" "$(sha "$f")" >> "$ROSTER"; done < <(covered)
    echo "指纹册初始化:$(wc -l < "$ROSTER" | tr -d ' ') 台"
    ;;
  check)
    [ -f "$ROSTER" ] || { echo "✖ 指纹册不存在,先 init"; exit 1; }
    bad=""
    while IFS=$'\t' read -r f h; do
      [ -z "$f" ] && continue
      cur="$(sha "$f")"
      if [ -z "$cur" ]; then bad="$bad
  缺失 $f"; elif [ "$cur" != "$h" ]; then bad="$bad
  已变 $f"; fi
    done < "$ROSTER"
    while IFS= read -r f; do
      [ -n "$f" ] && ! grep -q "^$f	" "$ROSTER" && bad="$bad
  未入册 $f"
    done < <(covered)
    if [ -n "$bad" ]; then
      echo "✖ 守卫指纹变化且无 refresh 收据:$bad"
      echo "  合法变更:bash ~/.claude/guards/pmm-fingerprint.sh refresh \"<理由>\""
      exit 1
    fi
    echo "指纹册 $(wc -l < "$ROSTER" | tr -d ' ') 台全部一致"
    ;;
  refresh)
    reason="${*:-}"
    [ -n "$reason" ] || { echo "✖ refresh 必须带理由(收据逐字入账)" >&2; exit 1; }
    changed=""
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      cur="$(sha "$f")"; old="$(grep "^$f	" "$ROSTER" 2>/dev/null | cut -f2)"
      [ "$cur" != "$old" ] && changed="$changed $f"
    done < <(covered)
    # 删除的文件也算变更
    while IFS=$'\t' read -r f h; do [ -n "$f" ] && [ -z "$(sha "$f")" ] && changed="$changed $f(删)"; done < "$ROSTER"
    [ -n "$changed" ] || { echo "无变化,名册照旧"; exit 0; }
    # 2026-09-23(A1 批,codex#10 HIGH,「收据失败被 || true 吞掉」):此前顺序是先重写名册、后跑收据,
    # 收据失败还用 `|| true` 吞掉——名册已经改了,却没人知道改动没留痕(唯一能靠 git 历史里的
    # FINGERPRINTS.tsv diff 事后追,严重度才被降成 LOW,但这本身仍是个可以直接堵上的洞)。
    # 改成收据优先:先落收据,失败就整个 refresh 失败退出、名册保持原样一个字节不动;收据成功了
    # 才重写名册。这样"名册变了"和"收据落了"这两件事在因果上再也分不开。
    if [ -x "$RECEIPT" ] || [ -f "$RECEIPT" ]; then
      if ! bash "$RECEIPT" add guard-change "$(printf '%s' "$changed" | cut -c1-200)" "$reason" >/dev/null 2>&1; then
        echo "✖ refresh 失败:收据落盘失败(RECEIPT=$RECEIPT),名册未写" >&2
        exit 1
      fi
    else
      echo "✖ refresh 失败:收据脚本不存在或不可读($RECEIPT),名册未写" >&2
      exit 1
    fi
    : > "$ROSTER"
    while IFS= read -r f; do [ -n "$f" ] && printf '%s\t%s\n' "$f" "$(sha "$f")" >> "$ROSTER"; done < <(covered)
    echo "指纹册已刷新,变更:$changed;收据已落(理由:$reason)"
    ;;
  --self-test)
    T="$(mktemp -d)"; mkdir -p "$T/.claude/guards" "$T/.claude/memory/_local-config" "$T/r"
    printf 'v1\n' > "$T/.claude/guards/g.sh"
    ok=0
    # 2026-09-23(A1-尾,Opus A1 review MEDIUM-2):refresh 现在要求收据脚本必须存在——此前 e() 把
    # PMM_FP_RECEIPT 指向外层默认值(真实 $PMM_HOME_RESOLVED 下的 pmm-receipt.sh)。HOME 被整体
    # 重定向到临时目录时,pmm-home.sh 解析出的真实 home 也变成临时目录,那个真实收据脚本在临时
    # 家里根本不存在——refresh 失败,自测从 5/5 回归到 5/6(与本批修的 fab MEDIUM-7「自测只在真
    # HOME 绿」是同一类病)。放一个「必成功」的收据桩在临时家里(与下面 case 6 的「必败」桩对称),
    # 两种环境都能跑通。
    _goodreceipt="$T/good-receipt.sh"; printf '#!/usr/bin/env bash\nexit 0\n' > "$_goodreceipt"; chmod +x "$_goodreceipt"
    e() { PMM_FP_HOME="$T" PMM_FP_ROSTER="$T/roster.tsv" PMM_FP_RECEIPT="$_goodreceipt" PMM_RECEIPTS_DIR="$T/r" bash "$0" "$@" >/dev/null 2>&1; }
    e init && e check && ok=$((ok+1))                       # 1 init 后一致
    printf 'v2\n' > "$T/.claude/guards/g.sh"
    e check; [ $? -eq 1 ] && ok=$((ok+1))                   # 2 改了无收据 → 红
    e refresh; [ $? -eq 1 ] && ok=$((ok+1))                 # 3 无理由 refresh → 拒
    e refresh "测试理由" && e check && ok=$((ok+1))          # 4 带理由 refresh → 绿
    printf 'x\n' > "$T/.claude/guards/new.sh"
    e check; [ $? -eq 1 ] && ok=$((ok+1))                   # 5 新文件未入册 → 红
    # 2026-09-23(A1 批,codex#10 HIGH):6 收据失败 → refresh 必须非 0 退出,且名册字节不动
    # (此前的顺序是先重写名册、后跑收据、失败用 || true 吞掉——名册已经悄悄变了)。
    cp "$T/roster.tsv" "$T/roster.before6" 2>/dev/null
    printf 'v3\n' > "$T/.claude/guards/g.sh"
    _badreceipt="$T/bad-receipt.sh"; printf '#!/usr/bin/env bash\nexit 1\n' > "$_badreceipt"; chmod +x "$_badreceipt"
    PMM_FP_HOME="$T" PMM_FP_ROSTER="$T/roster.tsv" PMM_FP_RECEIPT="$_badreceipt" PMM_RECEIPTS_DIR="$T/r" \
      bash "$0" refresh "测试理由6" >/dev/null 2>&1
    _r6=$?
    if [ "$_r6" -ne 0 ] && diff -q "$T/roster.tsv" "$T/roster.before6" >/dev/null 2>&1; then ok=$((ok+1)); fi   # 6
    # 2026-09-24(M7,主脑批审 + spec 22 勘误 E-16):covered() 现在用 `find guards/vendor -type f`
    # 递归,而不是顶层 `*.cjs`/`*.LICENSE` glob——旧 glob 盖不到子目录文件(实测真 vendor/ 下只收
    # 3/7:漏 acorn.js 扩展名不对、minisearch/{index.cjs,LICENSE} 在子目录、VENDOR.md 扩展名不对)。
    # 7 用嵌套子目录里的一个 vendor 文件验证「改一字节必红」:先建档(与 case 1 的初始 init 同理,
    # 让它进名册),改一字节,check 必须非 0。
    mkdir -p "$T/.claude/guards/vendor/sub"
    printf 'v1\n' > "$T/.claude/guards/vendor/sub/x.cjs"
    e refresh "vendor 建档"
    printf 'v2\n' > "$T/.claude/guards/vendor/sub/x.cjs"
    e check; [ $? -eq 1 ] && ok=$((ok+1))                   # 7 vendor 子目录文件改一字节 → 红
    # 2026-09-24(主脑裁决,spec 补遗三 §32):`specs/D1-PINNED-*.json`/`specs/PLAN-*.json` 已从
    # covered() 排除(它们改按语料内容指纹定键,完整性归 pmm-c0-canary-check.sh 管,不归这本按字节
    # 盯防「改守卫无人知」的指纹册管——理由见 covered() 里 2026-09-24 那段注释)。8 证明排除生效:
    # 建两个匹配这两个前缀的假文件、check(建档前,应仍绿——它们从未进 covered() 所以不会被当成
    # 「未入册」),再改内容、check 仍必须绿(而不是像 case 5 的新文件那样翻红)。先把 case 7 故意
    # 留下的 vendor 红态 refresh 掉,让 case 8 从一个干净的绿态量起,不然 r8a/r8b 会被 case 7 的
    # 遗留红态污染,测不出「排除」这件事本身。
    e refresh "case8 前置:清掉 case7 遗留的 vendor 红态"
    mkdir -p "$T/.claude/guards/specs"
    printf 'v1\n' > "$T/.claude/guards/specs/D1-PINNED-deadbeefdeadbeefdeadbeefdeadbeefdeadbeef.json"
    printf 'v1\n' > "$T/.claude/guards/specs/PLAN-deadbeefdeadbeefdeadbeefdeadbeefdeadbeef.json"
    e check; _r8a=$?
    printf 'v2\n' > "$T/.claude/guards/specs/D1-PINNED-deadbeefdeadbeefdeadbeefdeadbeefdeadbeef.json"
    printf 'v2\n' > "$T/.claude/guards/specs/PLAN-deadbeefdeadbeefdeadbeefdeadbeefdeadbeef.json"
    e check; _r8b=$?
    [ "$_r8a" -eq 0 ] && [ "$_r8b" -eq 0 ] && ok=$((ok+1))  # 8 D1-PINNED-*/PLAN-* 已排除:建+改内容均不影响 check
    rm -rf "$T"
    if [ "$ok" -eq 8 ]; then echo "pmm-fingerprint 自证 8/8"; exit 0; fi
    echo "✖ pmm-fingerprint 自证 $ok/8"; exit 1
    ;;
  *) echo "usage: pmm-fingerprint.sh init|check|refresh \"<理由>\"|--self-test" >&2; exit 1 ;;
esac
