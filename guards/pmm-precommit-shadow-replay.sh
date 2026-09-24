#!/usr/bin/env bash
# pmm-precommit-shadow-replay.sh — C0.5 交付物 4:precommit 影子的 30 笔历史回放。
# spec: guards/specs/C05-BUILD-SPEC.md 交付物 4 + 补遗一第 12 条(快照钉住)、第 16 条(isoEnv/零足迹)。
#
# 对最近 N(默认 30)笔触及 .claude/memory 的真实提交,逐笔跑 v3 core 的 git-ref 快照 diff(引擎见
# pmm-precommit-shadow-replay.cjs,该文件头注有完整设计说明,包括「列②当时拦而 v3 不拦」在
# spec 原文定义下为何结构性恒空)。只读:不写真根任何文件;报告默认 stdout,--out <file> 才落盘
# 到调用者指定的路径(不落到 .shadow/ ——本工具不是「统一 hook」那类持续写盘的影子,是按需跑
# 的回放报告)。
#
# 隔离(第 16 条):本包装脚本自己经 selftest-iso.cjs 的 isoEnv(T, {PMM_GIT_HOME: 真 home}) 起
# 子进程——HOME/USERPROFILE/PMM_HOME 全部指向临时 T(引擎本身不写任何东西,这里只是纵深防御,
# 万一引擎将来有 bug 也不会误写真根的 .claude/.shadow 等路径);PMM_GIT_HOME 单独覆盖指回真
# home,这是 pmm-core.cjs 的 homeDir() 本就支持的「git 仓库在哪」专属覆盖(与「家目录重定向」
# 是两件事,见该文件 homeDir() 函数头注),让引擎的只读 git 调用读到真实历史。
#
# 路径形态(tooling:node-e-embedded-posix-path-silent-fallback):任何要塞进「env 变量值」(不是
# argv)的路径,在喂给原生 node.exe 前一律先 `cygpath -m` 成 Windows 混合斜杠形式——MSYS 只自动
# 转换「argv 字面量传给非 MSYS 程序」这一种情况,一条 POSIX 路径原样塞进 HOME=... 这种变量值,
# 原生 node 读到的就是这串没被翻译过的字符,会在当前盘符根下找不到路径而静默各种失败。下面
# 所有 TW/RW 都是这一处理的产物,和 selftest-iso.sh 的 selftest_iso_env() 同一约定。
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REALHOME="$(cd "$G/../.." && pwd)"
RW="$(cygpath -m "$REALHOME" 2>/dev/null || printf '%s' "$REALHOME")"

# git「可疑所有权」护栏(实测,本机 C:/Users/<user> 的所有权元数据是 SYSTEM,不是当前用户):git 只信
# $HOME/.gitconfig 里的 safe.directory 例外——真根下这个例外本来就配好了,但 isoEnv 把 HOME 重定向
# 到临时 T 后,git 找不到这条例外,任何指向真 home 的 `git -C <真home> ...`(包括 pmm-core.cjs 内部
# 自己发的那些,不只是本文件自己发的)都会直接 fatal。修法不碰 selftest-iso.cjs/pmm-core.cjs(都不
# 在本批写面内),只在这个包装脚本里现造一个只含这一条例外的临时 gitconfig,用 GIT_CONFIG_GLOBAL
# (git ≥2.32)整体替换掉 git 会找的全局配置来源——这是 isoEnv(T, extra) 的 extra 允许的"新增键"用法
# (不碰 HOME/USERPROFILE/PMM_HOME 三个字段本身)。
mk_safe_gitconfig() { # $1=写到哪个文件(已经是 cygpath -m 过的 Windows 形式所在目录也行,内容本身只认 posix 分隔)
  printf '[safe]\n\tdirectory = %s\n' "$RW" > "$1"
}

# ── --self-test:证明引擎的「新增 blocking 才算」判据是对的,而不是随手打印一堆提交(改前必红/
# 改后必绿见回报)。构造一个独立的 fixture 仓库(不碰真历史):base 提交(取自 pmm-core 自身的
# corpus-whole 金丝雀语料,已知能被 core.parseAll/check 正常解析,零发明语法风险)→ 提交 A 新增
# 一条带悬空 Supersedes 的条目(必须落进列①)→ 提交 B 只改已有条目正文(不得落进列①)。
# 全程经 selftest-iso 的 footprint 包住,断言真根零足迹(第 16 条)。
if [ "${1:-}" = "--self-test" ]; then
  _rc=0
  source "$G/selftest-iso.sh"

  # ISO-ENTRIES: st_run_engine
  # 自测结构名册(spec 22 + E-8②):自测里对引擎 `pmm-precommit-shadow-replay.cjs` 的两处裸调用
  # (下方 fixture 跑法与 --n 999 边界跑法)此前直接手写 `HOME=... USERPROFILE=... PMM_HOME=...
  # PMM_GIT_HOME=... node "$G/pmm-precommit-shadow-replay.cjs" ...`,名册检查要求 DUT-ENTRY 调用
  # 必须落在一个登记在 `# ISO-ENTRIES:` 头注里的函数体内、且该函数体调用共享的 selftest_iso_env
  # (guards/selftest-iso.sh,上面已 source)——不得自己拼 env。st_run_engine 把这两处调用收拢成
  # 单一入口:在子 shell 里调 selftest_iso_env "$_t"(把 HOME/USERPROFILE/PMM_HOME/PMM_RECALL_ROOT/
  # PMM_TRIGGER_* 全部钉在 $_t 上,并清掉其余杂散 PMM_*),再单独 export PMM_GIT_HOME 指回同一个
  # $_t(自测用的 fixture 仓库本身就是「git 仓库在哪」,与生产路径下 PMM_GIT_HOME 指回真 home 是
  # 两回事,见本文件头注)。子 shell 括号把这层重定向限制在这一次调用内,不泄漏到本脚本其余部分。
  st_run_engine() {
    local _t="$1"; shift
    local _tw; _tw="$(cygpath -m "$_t" 2>/dev/null || printf '%s' "$_t")"
    ( selftest_iso_env "$_t"
      export PMM_GIT_HOME="$_tw"
      node "$G/pmm-precommit-shadow-replay.cjs" "$@"  # DUT-ENTRY
    )
  }

  _fixture_src="$G/fixtures/v3/corpus-whole"
  if [ ! -d "$_fixture_src" ]; then
    echo "✖ 自测:找不到 fixtures/v3/corpus-whole(引擎自测的语料底座)"; exit 1
  fi

  _snap="$(mktemp)" || { echo "✖ mktemp 失败"; exit 1; }
  node -e '
    const iso = require(process.argv[1]);
    const fs = require("fs");
    const snap = iso.footprint.begin();
    fs.writeFileSync(process.argv[2], JSON.stringify({ before: Array.from(snap.before.entries()), ts: snap.ts }));
  ' "$G/selftest-iso.cjs" "$_snap" || { echo "✖ footprint.begin 失败"; exit 1; }

  T="$(mktemp -d)" || { echo "✖ mktemp -d 失败"; exit 1; }
  TW="$(cygpath -m "$T" 2>/dev/null || printf '%s' "$T")"
  mkdir -p "$T/.claude/memory"
  cp "$_fixture_src"/*.md "$T/.claude/memory/" 2>/dev/null
  ( cd "$T" && git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm base ) >/dev/null 2>&1

  # 提交 A:新增一条带悬空 Supersedes 的条目 —— 必须被引擎判成「新增 blocking」(B1)。
  printf '\n**2026-09-20 — fixture 新增(带悬空 Supersedes,B1 必拦)** [fx:new-with-dangling]\nSupersedes: [[fx:does-not-exist-anywhere]]\n引入这条只为验证引擎能识别"这一步新增的 blocking",不测别的语义。\n' >> "$T/.claude/memory/lessons.md"
  ( cd "$T" && git add -A && git commit -qm commitA ) >/dev/null 2>&1
  _commitA="$(cd "$T" && git rev-parse HEAD)"

  # 提交 B:只改已有条目的正文措辞,不动任何 tag/Supersedes/Class —— 不得出现在列①。
  sed -i 's/引入这条只为验证引擎能识别"这一步新增的 blocking",不测别的语义。/引入这条只为验证引擎能识别"这一步新增的 blocking"(提交 B 改写正文,不应新增 blocking)。/' "$T/.claude/memory/lessons.md" 2>/dev/null
  ( cd "$T" && git add -A && git commit -qm commitB ) >/dev/null 2>&1
  _commitB="$(cd "$T" && git rev-parse HEAD)"

  _out="$T/.report.txt"
  _outw="$TW/.report.txt"
  _engine_out=$(st_run_engine "$T" --n 30 --out "$_outw" 2>&1)
  _engine_rc=$?

  if [ ! -f "$_out" ]; then
    echo "✖ 自测:引擎没有写出 --out 报告文件($_engine_out)"; _rc=1
  else
    _report_body="$(cat "$_out")"
    case "$_report_body" in
      *"列①v3 会拦而当时放行(1)"*) : ;;
      *) echo "✖ 自测:列①计数不是 1(期望恰好提交 A 一条):$(printf '%s' "$_report_body" | grep '列①')"; _rc=1 ;;
    esac
    case "$_report_body" in
      *"${_commitA:0:10}"*) : ;;
      *) echo "✖ 自测:列①里没有提交 A 的 sha 前缀"; _rc=1 ;;
    esac
    case "$_report_body" in
      *"${_commitB:0:10}"*) echo "✖ 自测:提交 B(纯正文改写,不应新增 blocking)竟出现在报告里"; _rc=1 ;;
      *) : ;;
    esac
    case "$_report_body" in
      *"fx:does-not-exist-anywhere"*) : ;;
      *) echo "✖ 自测:列①里缺 B1 悬空 Supersedes 的诊断行"; _rc=1 ;;
    esac
    case "$_report_body" in
      *"列②当时拦而 v3 不拦(0)"*) : ;;
      *) echo "✖ 自测:列②计数不是 0(spec 定义下应结构性恒空):$(printf '%s' "$_report_body" | grep '列②')"; _rc=1 ;;
    esac
    case "$_report_body" in
      *"OID(HEAD:.claude/memory) ="*) : ;;
      *) echo "✖ 自测:报告缺 OID 行(第 12 条要求打印)"; _rc=1 ;;
    esac
  fi
  if [ "$_engine_rc" -ne 0 ]; then
    echo "✖ 自测:引擎对干净 fixture 仓库 rc=$_engine_rc(期望 0):$_engine_out"; _rc=1
  fi

  # 边界:非法父提交(root)不应崩溃 —— 这里改跑一次 --n 999 把 base 自己(root)也纳入窗口,
  # 只要不崩且报告里出现「跳过(无父提交…」一行即可。
  _wide_out=$(st_run_engine "$T" --n 999 2>&1)
  _wide_rc=$?
  if [ "$_wide_rc" -ne 0 ]; then
    echo "✖ 自测:--n 999(把 root 提交也纳入窗口,验证「无父提交」分支不崩)rc=$_wide_rc:$_wide_out"; _rc=1
  fi
  case "$_wide_out" in
    *"跳过(无父提交"*) : ;;
    *) echo "✖ 自测:--n 999 时没有出现「跳过(无父提交…」一行(root 提交应该被跳过而不是报错)"; _rc=1 ;;
  esac

  rm -rf "$T"

  # 第二段:对真历史跑一次「烟雾测试」(只读,不断言具体计数,因为真历史会变)——验证包装脚本
  # 自己那条 PMM_GIT_HOME=真 home 的接线没坏,输出结构完整、rc 属于 {0,1}(1 只应该来自 footprint
  # 或 error,不应该是崩溃),且过程里真的没往真根写任何东西(用同一个 footprint 快照收尾一起测)。
  _real_out=$(bash "$G/$(basename "${BASH_SOURCE[0]}")" 2>&1)
  _real_rc=$?
  case "$_real_out" in
    *"OID(HEAD:.claude/memory) ="*) : ;;
    *) echo "✖ 自测:对真历史跑一次,输出缺 OID 行 — 包装脚本的接线可能坏了:$_real_out"; _rc=1 ;;
  esac
  case "$_real_out" in
    *"commits_checked ="*) : ;;
    *) echo "✖ 自测:对真历史跑一次,输出缺 commits_checked — 包装脚本的接线可能坏了"; _rc=1 ;;
  esac
  if [ "$_real_rc" -ne 0 ] && [ "$_real_rc" -ne 1 ]; then
    echo "✖ 自测:对真历史跑一次,rc=$_real_rc 不在 {0,1}(疑似崩溃而不是正常判定)"; _rc=1
  fi

  _foot_line=$(node -e '
    const iso = require(process.argv[1]);
    const fs = require("fs");
    const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const before = new Map(raw.before);
    const markers = iso.markersFromSource(process.argv[5] || "", process.argv[3], process.argv[4]);
    const res = iso.footprint.end({ before, ts: raw.ts }, markers);
    console.log(res.line);
    process.exit(res.red ? 1 : 0);
  ' "$G/selftest-iso.cjs" "$_snap" "toolu_selftest_precommit_replay_b3" "selftest-precommit-replay" "$G/pmm-precommit-shadow-replay.sh")
  _foot_rc=$?
  echo "  footprint: $_foot_line"
  [ "$_foot_rc" -ne 0 ] && { echo "✖ 自测:真根足迹非零"; _rc=1; }
  rm -f "$_snap"

  [ "$_rc" -eq 0 ] && echo "✅ pmm-precommit-shadow-replay 自测:fixture 列①/列②计数对、root 边界不崩、真历史烟雾测试通过、零足迹"
  exit "$_rc"
fi

OUT_FLAG=()
N_FLAG=30
_args=("$@")
_i=0
while [ "$_i" -lt "${#_args[@]}" ]; do
  case "${_args[$_i]}" in
    --out) OUT_FLAG=(--out "${_args[$((_i+1))]}"); _i=$((_i+2)) ;;
    --n) N_FLAG="${_args[$((_i+1))]}"; _i=$((_i+2)) ;;
    *) echo "usage: $(basename "${BASH_SOURCE[0]}") [--out <file>] [--n <N>] [--self-test]" >&2; exit 2 ;;
  esac
done

T="$(mktemp -d)" || { echo "✖ mktemp -d 失败" >&2; exit 1; }
trap 'rm -rf "$T"' EXIT
TW="$(cygpath -m "$T" 2>/dev/null || printf '%s' "$T")"
_safegitcfg="$T/.gitconfig-safe"
mk_safe_gitconfig "$_safegitcfg"
_safegitcfgw="$(cygpath -m "$_safegitcfg" 2>/dev/null || printf '%s' "$_safegitcfg")"

node -e '
  const iso = require(process.argv[1]);
  const { spawnSync } = require("child_process");
  const T = process.argv[2];
  const realHome = process.argv[3];
  const engine = process.argv[4];
  const gitConfigGlobal = process.argv[5];
  const rest = process.argv.slice(6);
  const env = iso.isoEnv(T, { PMM_GIT_HOME: realHome, GIT_CONFIG_GLOBAL: gitConfigGlobal });
  const r = spawnSync(process.execPath, [engine].concat(rest), { env: env, stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
' "$G/selftest-iso.cjs" "$TW" "$RW" "$G/pmm-precommit-shadow-replay.cjs" "$_safegitcfgw" --n "$N_FLAG" "${OUT_FLAG[@]}"
exit $?
