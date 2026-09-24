#!/usr/bin/env bash
# pmm-c0-canary-check.sh — PMM v3 C0 canary check (Opus H-3 rewrite, 2026-09-15;
# 主脑裁决 spec 补遗三 §32 2026-09-24 改用「语料内容指纹」替换 treeOid 定键)。
#
# The pre-fix canary line ran `pmm-migrate-v3.cjs --plan` itself (writing a fresh
# specs/PLAN-<oid>.json) and then checked that file's own existence — a tautology (the file always
# exists because the line right before it just created it), and it silently wrote a NEW,
# never-reviewed plan into the repo every time the memory OID drifted, then called that "green".
#
# The 2026-09-15 rewrite instead: reads the CURRENT `git rev-parse HEAD:.claude/memory` tree OID
# (read-only), requires a COMMITTED `guards/specs/PLAN-<oid>.json` for that exact OID to already
# exist, validates the committed plan's schema, builds a read-only temp copy of the real corpus from
# HEAD, applies the COMMITTED plan to the copy and runs `--verify --stage c0` against it, then runs
# the v1-vs-v2 shadow comparator.
#
# 2026-09-24(主脑裁决,spec 补遗三 §32):收口者实证(CHANGELOG 09-24「收口 B 段」、Opus spec 审第 31
# 条)treeOid(`HEAD:.claude/memory` 整棵子树的 git 树 OID)把 D1-PINNED/PLAN 钉在了「memory/ 子树
# 一个字节都不能变」上 —— 但 `pmm-fingerprint.sh refresh` 写的收据落在 `memory/dreams/receipts/`
# (memRelPrefix 覆盖范围之内),收据一落,这棵子树的 OID 跟着变,已审的 D1-PINNED/PLAN 就被判成
# 「语料已漂移」而作废;而 PLAN/D1-PINNED 文件本身又在 pmm-fingerprint.sh 的覆盖集里,于是两套机制
# 互相使对方过期。根因是 treeOid 的粒度是「整棵子树」,而 D1-PINNED/PLAN 实际只关心 core.ALL_FILES
# 这 7 个身份化文件的字节——receipts、banner.md 之类的变化从未影响过它们,不该让它们过期。
# 改用「语料内容指纹」:sha256(core.ALL_FILES 按文件名排序后的原始字节依次拼接;缺失文件不贡献
# 字节,即「以空内容参与」)——定义见 pmm-migrate-v3.cjs 的 computeCorpusFingerprint() 头部注释。此处
# 用纯 bash 独立复算同一个指纹(git show | 拼接 + sha256sum),不 require pmm-migrate-v3.cjs 里的
# 同名实现 —— 两侧各自算才是「独立核对」,任一侧算错都会在这里暴露成不匹配,而不是同一份代码骗自己。
# treeOid 仍会被 pmm-migrate-v3.cjs 记入 D1-PINNED/PLAN 供人工参考,但从此不再是这里的判据。
#
# `--plan` itself is NEVER invoked here — regenerating the plan is a separate, human-reviewed step.
#
# Usage: pmm-c0-canary-check.sh          # 正常路径：核对真语料，跑 apply/verify/shadow
#        pmm-c0-canary-check.sh --self-test   # 自测：「键匹配绿 / 不匹配红」，不碰真根/真 specs
set -euo pipefail
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# core.ALL_FILES 按 JS 默认字符串序（`Array.prototype.sort()`,逐 UTF-16 code unit 比较）排序后的
# 顺序,必须与 pmm-migrate-v3.cjs 的 `core.ALL_FILES.slice().sort()` 逐字一致：'-'(0x2D) < '.'(0x2E),
# 故每个 `*-archive.md` 排在它对应的不带 `-archive` 的同名文件之前。
CORPUS_ORDERED_FILES="classes.md decisions-archive.md decisions.md lessons-archive.md lessons.md standinginstructions-archive.md standinginstructions.md"

# 对指定 git 仓库根目录的 `HEAD:.claude/memory` 语料算「语料内容指纹」——只读 git show,从不碰工作区
# /索引/任何文件系统写入。$1 = 仓库根(如 $PMM_HOME_RESOLVED)。
corpus_fingerprint() {
  local home="$1" f tmp
  tmp="$(mktemp)"
  : > "$tmp"
  for f in $CORPUS_ORDERED_FILES; do
    git -C "$home" show "HEAD:.claude/memory/$f" >> "$tmp" 2>/dev/null || true
  done
  sha256sum "$tmp" | cut -d' ' -f1
  rm -f "$tmp"
}

# 按语料内容指纹在 $1(specs 目录)下定位并校验一份已提交 plan。成功：把 plan 路径打到 stdout,
# return 0。失败(文件不存在 / 内部 corpusFingerprint 字段与当前指纹不符 / 缺 edits 等新字段)：
# 诊断打到 stderr,return 1 —— 从不自己 exit,留给调用者(正常路径 vs 自测)决定后续。正常路径与
# 自测调用同一个函数,不是两套各自可能漂移的实现。
locate_and_validate_plan() {
  local specsdir="$1" fp="$2"
  local key="${fp:0:40}"
  local planfile="$specsdir/PLAN-${key}.json"
  if [ ! -f "$planfile" ]; then
    echo "✖ 没有对应当前语料内容指纹(${key}…)的已提交 plan 文件: $planfile" >&2
    echo "  语料已漂移(core.ALL_FILES 字节变了)—— 需要 builder 用 --plan 针对当前语料重新生成、经审查后提交,金丝雀本身绝不自动重生成 plan。" >&2
    return 1
  fi
  if ! node -e "
const j = require(process.argv[1]);
if (j.corpusFingerprint !== process.argv[2]) { console.error('plan.corpusFingerprint(' + j.corpusFingerprint + ') != 当前语料内容指纹(' + process.argv[2] + ')'); process.exit(1); }
if (!Array.isArray(j.edits) || typeof j.contentFingerprint !== 'string' || typeof j.contentFingerprintAfter !== 'string') {
  console.error('plan 文件缺 edits[]/contentFingerprint(After)(旧格式 plan,需重新生成)');
  process.exit(1);
}
" "$planfile" "$fp"; then
    return 1
  fi
  printf '%s\n' "$planfile"
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  source "$(dirname "$0")/selftest-iso.sh"

  # ISO-ENTRIES: st_run_fingerprint_in_env
  st_run_fingerprint_in_env() {
    local _t="$1"
    ( selftest_iso_env "$_t"
      corpus_fingerprint "$_t/repo"  # DUT-ENTRY
    )
  }

  # 只测本批改的东西(语料内容指纹的算法 + 按指纹定位/校验 plan 的判据)，不重跑 --apply/--verify/
  # pmm-manifest-shadow.sh 这条不属于本批写面、本就有自己覆盖的既有管线。三例覆盖「键匹配绿」
  # 与两种「不匹配红」(文件缺失 / 文件名对得上但内部字段对不上——后者是防「有人把旧 plan 改名当新
  # 的用」，与旧 treeOid 版本「文件存在性 + 内部字段」双重校验同款)。
  ok=0; total=3
  T="$(mktemp -d)"
  case "$T" in /tmp/*|/var/*|"${TMPDIR:-/nonexistent}"*) : ;; *) echo "mktemp 异常路径 $T,拒绝继续" >&2; exit 1;; esac
  cleanup_st() { rm -rf "$T"; }
  trap cleanup_st EXIT
  mkdir -p "$T/repo/.claude/memory" "$T/specs"
  git -C "$T/repo" init -q
  git -C "$T/repo" config user.email "t@example.com"
  git -C "$T/repo" config user.name "t"
  for f in $CORPUS_ORDERED_FILES; do printf '# %s fixture s0\n' "$f" > "$T/repo/.claude/memory/$f"; done
  git -C "$T/repo" add -A >/dev/null
  git -C "$T/repo" commit -q -m "s0"
  fp0="$(st_run_fingerprint_in_env "$T")"
  key0="${fp0:0:40}"
  cat > "$T/specs/PLAN-${key0}.json" <<EOF
{"schemaVersion":3,"corpusFingerprint":"${fp0}","treeOid":"irrelevant-ref-only","edits":[],"contentFingerprint":"x","contentFingerprintAfter":"x"}
EOF

  # 1: 键匹配(现算指纹 == plan 内部字段,文件名也对得上)→ 绿
  if p="$(locate_and_validate_plan "$T/specs" "$fp0")" && [ "$p" = "$T/specs/PLAN-${key0}.json" ]; then
    ok=$((ok+1))
  fi

  # 2: 语料漂移(改 decisions.md 一个字节、提交,不重新生成 plan)→ 新指纹没有对应文件 → 红
  printf '# decisions.md fixture s1 (mutated)\n' > "$T/repo/.claude/memory/decisions.md"
  git -C "$T/repo" add -A >/dev/null
  git -C "$T/repo" commit -q -m "s1 mutate decisions.md"
  fp1="$(st_run_fingerprint_in_env "$T")"
  if [ "$fp1" != "$fp0" ] && ! locate_and_validate_plan "$T/specs" "$fp1" >/dev/null 2>&1; then
    ok=$((ok+1))
  fi

  # 3: 把 case1 的旧 plan 复制改名成当前 key 的文件名(文件名骗得过「存在性」检查),但内部
  #    corpusFingerprint 字段仍是旧值 → 仍判红(必须核对内部字段,不能只信文件名)。
  cp "$T/specs/PLAN-${key0}.json" "$T/specs/PLAN-${fp1:0:40}.json"
  if ! locate_and_validate_plan "$T/specs" "$fp1" >/dev/null 2>&1; then
    ok=$((ok+1))
  fi

  if [ "$ok" -eq "$total" ]; then
    echo "pmm-c0-canary-check 自测 ${ok}/${total}(1键匹配绿 + 2不匹配红:文件缺失/内部字段对不上)"
    exit 0
  fi
  echo "✖ pmm-c0-canary-check 自测 ${ok}/${total}" >&2
  exit 1
fi

# ── 正常路径(不变——只是判据从 treeOid 换成语料内容指纹)───────────────────────────────────────
# pmm-home.sh's own node resolution can fail internally (its result is only
# used via a `[ -n ... ] || fallback` guard, never propagated as a hard
# error) -- but a plain `source` of it under THIS script's `set -e` would
# make that internal failure abort this whole script before the fallback
# line inside pmm-home.sh ever runs, since a sourced file's failing command
# triggers -e in the CALLER's shell, not a mere non-zero return from
# `source`. -e is toggled off only around the source call so pmm-home.sh's
# own fallback logic can complete exactly as it does when run standalone.
set +e
# shellcheck source=./pmm-home.sh
source "$G/pmm-home.sh"
set -e

fp="$(corpus_fingerprint "$PMM_HOME_RESOLVED")"  # PROD-ENTRY
planfile="$(locate_and_validate_plan "$G/specs" "$fp")" || exit 1

TMP_RAW="$(mktemp -d)"
case "$TMP_RAW" in /tmp/*|/var/*|"${TMPDIR:-/nonexistent}"*) : ;; *) echo "mktemp 异常路径 $TMP_RAW,拒绝继续" >&2; exit 1;; esac
cleanup() { rm -rf "$TMP_RAW"; }
trap cleanup EXIT
BEFORE_RAW="$TMP_RAW/before"; AFTER_RAW="$TMP_RAW/after"
mkdir -p "$BEFORE_RAW" "$AFTER_RAW"
BEFORE="$(cygpath -m "$BEFORE_RAW")"; AFTER="$(cygpath -m "$AFTER_RAW")"

for f in decisions.md lessons.md standinginstructions.md classes.md \
         decisions-archive.md lessons-archive.md standinginstructions-archive.md banner.md; do
  git -C "$PMM_HOME_RESOLVED" show "HEAD:.claude/memory/$f" > "$BEFORE_RAW/$f" 2>/dev/null || true
done
cp -r "$BEFORE_RAW/." "$AFTER_RAW/"

node "$G/pmm-migrate-v3.cjs" --apply --dir "$AFTER" --plan "$planfile" >/dev/null  # PROD-ENTRY
node "$G/pmm-migrate-v3.cjs" --verify --stage c0 --before "$BEFORE" --after "$AFTER" --plan "$AFTER/PLAN-applied.json"  # PROD-ENTRY

bash "$G/pmm-manifest-shadow.sh"  # PROD-ENTRY
