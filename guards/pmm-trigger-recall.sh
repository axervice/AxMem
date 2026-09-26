#!/usr/bin/env bash
# 触发式召回包装器 — 逻辑在同目录 .cjs。用法: hook 直连 | --self-test
# --self-test 必须在两种环境下都跑通(2026-09-23, Opus 复现;见块内 HOMEW 注释详述):
#   (a) 正常调用,真实环境 HOME:          bash pmm-trigger-recall.sh --self-test
#   (b) 只重定向 HOME+USERPROFILE(不设任何 PMM_*):
#       HOME=<tmp> USERPROFILE=<tmp> bash pmm-trigger-recall.sh --self-test
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── C05-BUILD-SPEC B2 tee (2026-09-24, read-only; PMM_TEE_LOG unset ⇒ zero behavior change) ──
if [ -n "${PMM_TEE_LOG:-}" ] && [ -z "${_PMM_TEE_INNER:-}" ] && [ "${1:-}" != "--self-test" ] && [ "${1:-}" != "--self-check" ]; then
  _tee_in="$(mktemp)"; _tee_out="$(mktemp)"; _tee_err="$(mktemp)"
  cat > "$_tee_in" 2>/dev/null || true
  _PMM_TEE_INNER=1 "$0" "$@" < "$_tee_in" > "$_tee_out" 2> "$_tee_err"
  _tee_rc=$?
  cat "$_tee_out"
  cat "$_tee_err" >&2
  _tee_tuid="$(grep -o '"tool_use_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$_tee_in" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  [ -z "$_tee_tuid" ] && _tee_tuid="$(grep -o '"toolUseId"[[:space:]]*:[[:space:]]*"[^"]*"' "$_tee_in" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  # M-10 fix (2026-09-24, audit `guards/audits/OPUS-2026-09-24-c05-batch-review.md` §2 / errata E-6):
  # record the hook's IDENTITY and its stdout's ORIGINAL text (spec item 2 says "把自己的 stdout/exit
  # code 追加一行", not a hash of it) instead of just sha256(stdout) with no way to tell which of the
  # four legacy hooks a line came from. base64-encodes stdout so embedded tabs/newlines never break
  # this TSV row; caps at 1200B of RAW stdout (item 20/23's existing payload ceiling, reused here since
  # no separate tee-specific cap exists in spec) before truncating, and always also records sha256 of
  # the FULL untruncated stdout so a truncated line still has something to verify a candidate blob
  # against.
  # E-6b fix (2026-09-24, C05-BUILD-SPEC addendum 3 item 29, main-brain ruling): 7 cols -> 9. stderr is
  # now captured to its own temp file (instead of inheriting fd 2 straight through) so it can be
  # base64-encoded into the tee row for the comparator to decode routing/length failures from; it is
  # still forwarded byte-for-byte to the real caller via `cat >&2` right after stdout, so --block mode's
  # stderr+exit-2 feedback path sees identical bytes as before -- only the timing (buffered vs live)
  # changes, and only while PMM_TEE_LOG is set.
  _tee_hook="$(basename "$0")"
  _tee_out_size="$(wc -c < "$_tee_out" 2>/dev/null | tr -d '[:space:]')"
  _tee_sha="$(sha256sum "$_tee_out" 2>/dev/null | cut -d' ' -f1)"
  if [ -n "$_tee_out_size" ] && [ "$_tee_out_size" -gt 1200 ]; then
    _tee_trunc=1
    _tee_b64="$(head -c 1200 "$_tee_out" 2>/dev/null | base64 2>/dev/null | tr -d '\n')"
  else
    _tee_trunc=0
    _tee_b64="$(base64 < "$_tee_out" 2>/dev/null | tr -d '\n')"
  fi
  _tee_err_size="$(wc -c < "$_tee_err" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$_tee_err_size" ] && [ "$_tee_err_size" -gt 1200 ]; then
    _tee_err_trunc=1
    _tee_err_b64="$(head -c 1200 "$_tee_err" 2>/dev/null | base64 2>/dev/null | tr -d '\n')"
  else
    _tee_err_trunc=0
    _tee_err_b64="$(base64 < "$_tee_err" 2>/dev/null | tr -d '\n')"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$_tee_hook" "${_tee_tuid:--}" "$_tee_trunc" "${_tee_b64:--}" "${_tee_sha:--}" "$_tee_rc" "${_tee_err_b64:--}" "$_tee_err_trunc" >> "$PMM_TEE_LOG" 2>/dev/null || true
  rm -f "$_tee_in" "$_tee_out" "$_tee_err"
  exit "$_tee_rc"
fi

if [ "${1:-}" = "--self-test" ]; then
  # part13 fix (2026-09-23, runner --self-check / Opus reproduction): case 30 below used to read the
  # real $HOME directly (three times) to snapshot the un-redirected production paths -- a literal
  # $HOME read outside pmm-recall-ledger.cjs's resolveHome() is exactly what part13 flags. Sourced
  # ONCE here, at the very top of the self-test block, before any test case runs or redirects
  # anything -- PMM_HOME_RESOLVED is computed from THIS shell's own untouched environment and never
  # recomputed later, so it stays the correct "real home" reference for the whole run even though
  # later cases pass HOME=<fake> only as a prefix to spawned `node` child processes (which never
  # mutates this parent shell's own variables).
  source "$(dirname "$0")/pmm-home.sh"
  # HOMEW = PMM_HOME_RESOLVED normalized to forward-slash Windows form via cygpath -m (idempotent on
  # an already-Windows-style value) -- 2026-09-23, Opus reproduction (independent of the G11 finding,
  # same defect class): every fixture below that exercises repo='home' matching used to hardcode the
  # literal path C:SERS<USER>\.claude\guards\... as the "edited file". That literal only resolves to
  # repo='home' when HOME happens to equal the real machine home -- under a self-test run with ONLY
  # HOME+USERPROFILE redirected (no PMM_*), pmm-trigger-recall.cjs's own HOME (also resolveHome()-
  # derived, per the HIGH-1 contract) no longer prefixes that literal, so `repo` resolves to null and
  # the fixture silently matches nothing (measured before this fix: 13/31). Every such fixture now
  # builds its file_path from $HOMEW instead, so it falls under WHATEVER HOME this run resolves to --
  # this file's own self-test is therefore environment-agnostic and must pass identically run either
  # way:
  #   (a) normal invocation, ambient real HOME:      bash pmm-trigger-recall.sh --self-test
  #   (b) HOME-redirected invocation (no PMM_* set):  HOME=<tmp> USERPROFILE=<tmp> bash pmm-trigger-recall.sh --self-test
  # A handful of cases (18, M6 shadow/interv arm split, 29/M-4①) deliberately keep this same
  # $HOMEW-based construction; a few OTHERS (the determinism case using $T10W, and case 30's own HIGH-1
  # real-root proof) already build their own self-contained HOME override per case and are unaffected.
  HOMEW="$(cygpath -m "$PMM_HOME_RESOLVED")"
  # seenkey $1=session_id $2=agent_id -> sha16(session_id NUL agent_id), the M-SPEC 附录 B 补注 #5
  # (2026-09-17, fab blind attack item 3) dedup-file key this .cjs now uses for `.trigger-seen-<key>`
  # (replacing the old first-8-chars-of-session_id naming) -- computed via the SAME ledger.sha16()/NUL
  # the production code calls, never a second hash reimplementation here.
  seenkey() {
    node -e "
const ledger = require(process.argv[1]);
process.stdout.write(ledger.sha16(process.argv[2] + ledger.NUL + (process.argv[3]||'')));
" "$G/pmm-recall-ledger.cjs" "$1" "${2:-}"
  }

  # ══════════════════════════════════════════════════════════════════════════════════════════════
  # 单一 DUT 入口(2026-09-23,A3-尾-3,复现 [tooling:selftest-must-redirect-every-root-the-tool-writes]):
  # 今天这条教训在本文件的一次真实编辑里复发过一次(LOW-2 加 timeout 时手滑删掉了四个重定向变量,
  # 裸调用打到了真根,事故记录见 audits/ 同日报告)——光靠"编辑时被推送提醒"不够,得把它做成结构:
  # 全文件里对 pmm-trigger-recall.cjs 的调用只有两个入口,任何用例都不能再手写
  # `node "$G/pmm-trigger-recall.cjs"`。两个入口都在设置 PMM_TRIGGER_MEM/STATE/LOG/PMM_RECALL_ROOT
  # 四个变量的同时,**也**把 HOME/USERPROFILE(以及 run_dut_custom 里的 PMM_HOME)钉死在调用者传入的
  # 临时根上——即使调用者漏传某个 PMM_TRIGGER_* 覆盖,resolveHome() 兜底链条也只会落回同一个临时根,
  # 不会落回真实家目录。行尾 `# DUT-ENTRY` 标记这两处是唯一合法的字面调用点,供本文件末尾的结构闸核对。
  #
  # ISO-ENTRIES: run_dut_custom, run_dut_bare_redirect
  # spec 22 (K9): both bodies below now call selftest_iso_env (guards/selftest-iso.sh, sourced above)
  # instead of hand-rolling their own HOME/USERPROFILE/PMM_HOME/PMM_TRIGGER_*/PMM_RECALL_ROOT
  # assignments -- the roster's structural check (step 26) recognizes a DUT-ENTRY line only inside a
  # function body listed here that actually calls the shared helper, not just any literal env prefix.
  # run_dut_custom <mem> <state> <log> <root> <home_base> <payload> [timeout_secs=60] — 底层入口,
  # 四个内容目录与 HOME 落点全部显式传参,零共享可变状态。
  run_dut_custom() {
    local mem="$1" state="$2" log="$3" root="$4" base="$5" payload="$6" tmo="${7:-60}"
    selftest_iso_env "$base"
    # [Builder W9, 2026-09-24] PMM_REPO_MARKERS=example-project: the fixtures below that exercise
    # repo!=home matching (cases 3/12/13) used to rely on pmm-trigger-recall.cjs's own hardcoded
    # real-project-name literal; that hardcode is gone (see pmm-trigger-recall.cjs), so this DUT
    # entry now supplies the SAME marker the fixtures reference via the env knob the production code
    # reads instead. selftest_iso_env just wildcard-unset every PMM_* var above, so this is the only
    # place it needs setting — every run_dut/run_dut_custom-based case gets it uniformly; the one case
    # that must NOT see any PMM_* at all (30, via run_dut_bare_redirect) never calls this function.
    export PMM_TRIGGER_MEM="$mem" PMM_TRIGGER_STATE="$state" PMM_TRIGGER_LOG="$log" PMM_RECALL_ROOT="$root" PMM_REPO_MARKERS="example-project"
    printf '%s' "$payload" | timeout "$tmo" node "$G/pmm-trigger-recall.cjs"  # DUT-ENTRY
  }
  # run_dut <base> <payload> [timeout_secs=60] — 标准入口:mem/state/log/root 全部用 <base> 的默认
  # 子目录(<base>/mem、<base>/state、<base>/log.tsv、<base>/ledger);<base> 同时是 HOME/USERPROFILE/
  # PMM_HOME 的落点。需要 mem/state/log/root 与 HOME 分开变化的用例(27/28 的确定性对照、34 的全新
  # nested root)直接调 run_dut_custom。
  run_dut() {
    local base="$1" payload="$2" tmo="${3:-60}"
    run_dut_custom "$base/mem" "$base/state" "$base/log.tsv" "$base/ledger" "$base" "$payload" "$tmo"
  }
  # run_dut_bare_redirect <base> <payload> — case 30 的专属入口。case 30 测的正是"只重定向
  # HOME+USERPROFILE、完全不设 PMM_HOME/PMM_TRIGGER_*/PMM_RECALL_ROOT 也必须足够隔离"这件事本身
  # (HIGH-1 的原始契约),所以这里**不能**像 run_dut 一样兜底设 PMM_HOME——那样会让测试对象本身失效。
  # 仍然调用 selftest_iso_env(spec 22 K9 要求 DUT-ENTRY 函数体必须调用它),随即撤掉它设的
  # PMM_HOME/PMM_TRIGGER_*/PMM_RECALL_ROOT 四项,只留 HOME/USERPROFILE——这正是本用例要测的那个更窄
  # 的场景本身,不是绕过。安全性不降低:HOME/USERPROFILE 仍然钉死在 <base>,resolveHome() 的兜底链条
  # (PMM_HOME>USERPROFILE>HOME>os.homedir())在 PMM_HOME 缺失时下一顺位就是 USERPROFILE,同样落在
  # <base> 内,不会漏到真根;selftest_iso_env 顺带清掉的其它杂散 PMM_* 只会让隔离更严,不会更松。
  run_dut_bare_redirect() {
    local base="$1" payload="$2"
    selftest_iso_env "$base"
    unset PMM_HOME PMM_TRIGGER_MEM PMM_TRIGGER_STATE PMM_TRIGGER_LOG PMM_RECALL_ROOT
    printf '%s' "$payload" | timeout 60 node "$G/pmm-trigger-recall.cjs"  # DUT-ENTRY
  }
  # ══════════════════════════════════════════════════════════════════════════════════════════════

  T="$(mktemp -d)"; mkdir -p "$T/mem/dreams" "$T/state" "$T/ledger"
  # TW(2026-09-23,A3-尾-3):$T 现在**同时**是 run_dut() 对"标准"用例(repo=home 匹配)的 HOME 落点——
  # run_dut 会把 HOME/USERPROFILE/PMM_HOME 都钉在它的第一个参数上,所以任何靠"file_path 前缀等于
  # resolveHome() 的结果"来命中 repo=home 的夹具,前缀必须用 $TW(= cygpath -m "$T"),不能再用
  # $HOMEW(那是外层环境本身的家目录,和 run_dut 传的 base 是两个不同的目录)。repo=example-project
  # 的夹具(3/12/13,经 PMM_REPO_MARKERS=example-project)靠路径里 `/example-project/` 子串匹配,与
  # HOME 无关,继续用 $HOMEW 没有影响;case 4 是反例,故意用一个不在 PMM_REPO_MARKERS 里的
  # `unrelated-repo` 占位,证明不会 basename/跨仓误配。
  TW="$(cygpath -m "$T")"
  {
    printf '%s\n' '**2026-01-01 — 测试教训甲** [test:trig-alpha]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/* -->'
    printf '%s\n' 'body'
    printf '%s\n' '**2026-01-02 — 测试教训乙(精确路径)** [test:trig-beta]'
    printf '%s\n' '<!-- trigger: tool=Write; repo=example-project; path=.github/workflows/ci.yml -->'
    printf '%s\n' 'body'
  } > "$T/mem/lessons.md"
  : > "$T/mem/decisions.md"; : > "$T/mem/standinginstructions.md"
  run() { run_dut "$T" "$1"; }
  ok=0

  # SELFTEST-BEGIN
  # 真根零足迹断言,起点快照(2026-09-23,A3-尾-3;superseded 2026-09-23 by spec 22 K8): the ORIGINAL
  # version keyed off PMM_HOME_RESOLVED (pmm-home.sh's resolveHome() -- PMM_HOME>USERPROFILE>HOME>
  # os.homedir()), which is exactly the env-dependent read this whole assertion exists to be immune
  # to: once 21's isolation gate requires this self-test ITSELF to run under a redirected HOME (as
  # the gates brief's own discipline rule §70 now mandates), PMM_HOME_RESOLVED silently resolves to
  # the REDIRECTED temp root instead of the true machine home, and the assertion starts watching the
  # wrong directory while still printing "real-root zero footprint" pass. Replaced by the shared
  # selftest-iso.sh helper, whose realHome() is derived from selftest-iso.cjs's own __dirname --
  # stable regardless of what HOME/USERPROFILE/PMM_HOME this self-test run itself is invoked under.
  source "$G/selftest-iso.sh"
  SELFTEST_NONCE="nonce-$(node -e 'process.stdout.write(require("crypto").randomBytes(6).toString("hex"))')"
  FP_SNAP="$(mktemp)"
  selftest_footprint_begin "$FP_SNAP"
  # REAL_HOME_KSAFE (K8-safe real home, derived from $G = this script's own on-disk directory, never
  # from HOME/USERPROFILE/PMM_HOME): case 30 below runs its OWN narrower before/after check (real_files())
  # and used to key it off PMM_HOME_RESOLVED too -- same K8 exposure, fixed the same way here.
  REAL_HOME_KSAFE="$(cd "$G/../.." && pwd)"
  # SELFTEST-END

  # 1 正例:home guards 前缀命中
  out="$(run '{"session_id":"test:s1","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/x.sh"}}')"
  printf '%s' "$out" | grep -q 'test:trig-alpha' && ok=$((ok+1))
  # 2 会话内去重:同 tag 第二次静默
  out="$(run '{"session_id":"test:s1","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/y.sh"}}')"
  [ -z "$out" ] && ok=$((ok+1))
  # 3 worktree 物理根归一:仓库相对路径照样命中精确 trigger
  out="$(run '{"session_id":"test:s2","tool_name":"Write","tool_input":{"file_path":"'"$HOMEW"'/Desktop/example-project/.claude/worktrees/kj/.github/workflows/ci.yml"}}')"
  printf '%s' "$out" | grep -q 'test:trig-beta' && ok=$((ok+1))
  # 4 负例:同名文件在别的仓不匹配(禁 basename 兜底)—— unrelated-repo 故意不在 PMM_REPO_MARKERS 里
  out="$(run '{"session_id":"test:s3","tool_name":"Write","tool_input":{"file_path":"D:/unrelated-repo/.github/workflows/ci.yml"}}')"
  [ -z "$out" ] && ok=$((ok+1))
  # 5 坏输入 fail-open
  out="$(run_dut "$T" 'not-json'; echo "rc=$?")"
  printf '%s' "$out" | grep -q 'rc=0' && ok=$((ok+1))
  # 6 telemetry 分段:log 含 event 与 injected 两级
  grep -q "$(printf '\t')injected$(printf '\t')" "$T/log.tsv" && grep -q "$(printf '\t')event$(printf '\t')" "$T/log.tsv" && ok=$((ok+1))
  # 6b. LOW-6->MEDIUM (2026-09-17, fab blind attack): the bad-json 'error' row's note carries
  #     sha16(first 64 raw bytes of stdin) + the total byte length, so a source can be pinpointed
  #     without changing the fail-open behavior (rc=0 above already proved that). "not-json" is 8
  #     bytes, well under the 64-byte cap, so this is sha256("not-json")[0:16] verbatim (no truncation
  #     ambiguity to worry about).
  grep -q "bad-json:len=8;head64sha16=0c21a879c732a679" "$T/log.tsv" && ok=$((ok+1))
  # 7 关联携带(the maintainer 2026-09-13):命中 alpha 时,其正文 [[test:gamma]] 的标题要一起推,
  #   遥测 stage=injected-linked 与直接命中分列
  {
    printf '%s\n' '**2026-01-03 — 测试教训丙(被关联)** [test:trig-gamma]'
    printf '%s\n' 'gamma body'
  } >> "$T/mem/lessons.md"
  node -e "
const fs=require('fs');const p=process.argv[1];
let s=fs.readFileSync(p,'utf8');
s=s.replace('body\n**2026-01-02','body 关联 [[test:trig-gamma]]\n**2026-01-02');
fs.writeFileSync(p,s);" "$T/mem/lessons.md"
  out="$(run '{"session_id":"test:s7","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/z.sh"}}')"
  printf '%s' "$out" | grep -q 'test:trig-alpha' && printf '%s' "$out" | grep -q '关联.*\[test:trig-gamma\]' && grep -q "injected-linked" "$T/log.tsv" && ok=$((ok+1))
  # 8 取代链感知 + 时间线标注(the maintainer 2026-09-13):trigger 种在旧条目上,推送必须沿
  #   Supersedes 链跳到最新版并标注来源;关联条带 较新/较旧 标注
  T2="$(mktemp -d)"; mkdir -p "$T2/mem" "$T2/state" "$T2/ledger"
  {
    printf '%s\n' '**2026-01-01 — 测试教训甲(旧版)** [test:trig-alpha]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/* -->'
    printf '%s\n' 'old body 关联 [[test:trig-gamma]]'
    printf '%s\n' '**2026-01-15 — 测试教训丙(被关联,较旧)** [test:trig-gamma]'
    printf '%s\n' 'gamma body'
    printf '%s\n' '**2026-02-01 — 测试教训丁(取代甲)** [test:trig-delta]'
    printf '%s\n' 'delta body'
    printf '%s\n' 'Supersedes: [[test:trig-alpha]]'
  } > "$T2/mem/lessons.md"
  : > "$T2/mem/decisions.md"; : > "$T2/mem/standinginstructions.md"
  out="$(run_dut_custom "$T2/mem" "$T2/state" "$T2/log.tsv" "$T2/ledger" "$T" '{"session_id":"test:s8","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/sup.sh"}}')"
  printf '%s' "$out" | grep -q 'test:trig-delta' && printf '%s' "$out" | grep -q '取代了 \[test:trig-alpha\]' && grep -q "superseded-redirect" "$T2/log.tsv" && ok=$((ok+1))
  # 9 归档后 redirect 仍活(codex Finding-1):带 trigger 的旧条 A 已在 archive,
  #   live 只剩取代者 B —— 编辑命中 A 的 trigger 必须推出 B
  T3="$(mktemp -d)"; mkdir -p "$T3/mem" "$T3/state" "$T3/ledger"
  {
    printf '%s\n' '**2026-01-01 — 旧条甲(已归档)** [test:arch-old]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/* -->'
    printf '%s\n' 'archived body'
  } > "$T3/mem/lessons-archive.md"
  {
    printf '%s\n' '**2026-02-01 — 新条乙(现行)** [test:arch-new]'
    printf '%s\n' 'live body'
    printf '%s\n' 'Supersedes: [[test:arch-old]]'
  } > "$T3/mem/lessons.md"
  : > "$T3/mem/decisions.md"; : > "$T3/mem/standinginstructions.md"
  out="$(run_dut_custom "$T3/mem" "$T3/state" "$T3/log.tsv" "$T3/ledger" "$T" '{"session_id":"test:s9","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/a.sh"}}')"
  printf '%s' "$out" | grep -q 'test:arch-new' && grep -q "superseded-redirect" "$T3/log.tsv" && ok=$((ok+1))
  # 10 分类法(2026-09-14):命中类枢纽 trigger → 推枢纽 + 该类最近成员(stage=injected-class-member)
  T4="$(mktemp -d)"; mkdir -p "$T4/mem/dreams" "$T4/state" "$T4/ledger"
  {
    printf '%s\n' '**2026-09-14 — 类:甲类** [class:alpha]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/hooks/* -->'
    printf '%s\n' '判据:x'
  } > "$T4/mem/classes.md"
  {
    printf '%s\n' '**2026-01-01 — 成员旧** [test:mem-old]'
    printf '%s\n' 'Class: [[class:alpha]]'
    printf '%s\n' 'body'
    printf '%s\n' '**2026-02-01 — 成员新** [test:mem-new]'
    printf '%s\n' 'Class: [[class:alpha]]'
    printf '%s\n' 'body'
    printf '%s\n' '**2026-03-01 — 成员带自触发** [test:mem-trig]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/pmm-x.sh -->'
    printf '%s\n' 'Class: [[class:alpha]]'
    printf '%s\n' 'body'
  } > "$T4/mem/lessons.md"
  : > "$T4/mem/decisions.md"; : > "$T4/mem/standinginstructions.md"
  out="$(run_dut_custom "$T4/mem" "$T4/state" "$T4/log.tsv" "$T4/ledger" "$T" '{"session_id":"test:s10","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/hooks/h.sh"}}')"
  printf '%s' "$out" | grep -q 'class:alpha' && printf '%s' "$out" | grep -q '同类成员.*test:mem-trig' && grep -q 'injected-class-member' "$T4/log.tsv" && ok=$((ok+1))
  # 11 命中成员 → 报「同类另 N 条」(不占名额,不推全文)
  out="$(run_dut_custom "$T4/mem" "$T4/state" "$T4/log.tsv" "$T4/ledger" "$T" '{"session_id":"test:s11","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/pmm-x.sh"}}')"
  printf '%s' "$out" | grep -q 'test:mem-trig.*同类 \[class:alpha\] 另 2 条' && ok=$((ok+1))
  # 12 glob 支持(2026-09-15 the maintainer 拍板):中段通配 trigger(src/lib/**/*lock*)必须真的命中一个真实
  #    路径事件——这正是 9 条死 trigger 里因为匹配器只有前缀/全等两支而永远推不出来的那一类;
  #    同一条 path 在旧两支匹配器下(relLower.startsWith(prefix) / relLower===path)对这个事件
  #    必然是 false(prefix 剥完星号后是整串含星号的原文,startsWith 永不成立),新实现必须是 true。
  T5="$(mktemp -d)"; mkdir -p "$T5/mem/dreams" "$T5/state" "$T5/ledger"
  {
    printf '%s\n' '**2026-01-01 — 测试教训戊(中段通配)** [test:trig-epsilon]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=example-project; path=src/lib/**/*lock* -->'
    printf '%s\n' 'body'
  } > "$T5/mem/lessons.md"
  : > "$T5/mem/decisions.md"; : > "$T5/mem/standinginstructions.md"
  out="$(run_dut "$T5" '{"session_id":"test:s12","tool_name":"Edit","tool_input":{"file_path":"'"$HOMEW"'/Desktop/example-project/src/lib/appointments/resource-lock.ts"}}')"
  printf '%s' "$out" | grep -q 'test:trig-epsilon' && ok=$((ok+1))
  # 13 glob HIGH-1 反例(2026-09-15,FABLE-2026-09-15-glob-review-triage.md finding 1,端到端):同一条
  #    src/lib/**/*lock* trigger,编辑一个 lock 只出现在【目录名】、文件名里完全不含 lock 的路径,必须
  #    不推送——这正是 HIGH-1 的实证场景(src/lib/lock-cache/unrelated.ts),修前旧的「末尾 * 跨段」
  #    实现会让 .* 吃穿 / 而误判命中。
  out="$(run_dut "$T5" '{"session_id":"test:s13","tool_name":"Edit","tool_input":{"file_path":"'"$HOMEW"'/Desktop/example-project/src/lib/lock-cache/unrelated.ts"}}')"
  [ -z "$out" ] && ok=$((ok+1))
  # 14 R-4 fix(2026-09-15 round 3,guards/audits/OPUS-2026-09-15-round2-review.md「R-4」):缩进的
  #    trigger 注释——读侧(classifyTriggerLine)完全看不见它(TRIGGERISH_RE 要求 <!-- 在行首),
  #    锚定 TRIG_RE 后引擎也必须看不见、不得命中推送(修前:未锚定的 TRIG_RE 用 .match() 在行内任意
  #    位置找,缩进/尾随垃圾照样命中——闸与引擎各写一份判断,判断还不一致)。
  T6="$(mktemp -d)"; mkdir -p "$T6/mem/dreams" "$T6/state" "$T6/ledger"
  {
    printf '%s\n' '**2026-01-01 — 测试教训己(缩进 trigger,非法形态)** [test:trig-indent]'
    printf '%s\n' '    <!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/* -->'
    printf '%s\n' 'body'
  } > "$T6/mem/lessons.md"
  : > "$T6/mem/decisions.md"; : > "$T6/mem/standinginstructions.md"
  out="$(run_dut_custom "$T6/mem" "$T6/state" "$T6/log.tsv" "$T6/ledger" "$T" '{"session_id":"test:s14","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/indent.sh"}}')"
  { [ -z "$out" ] || ! printf '%s' "$out" | grep -q 'trig-indent'; } && ok=$((ok+1))
  # 15 R-4 反例控制组:同一条 trigger 去掉缩进(顶格)必须照常命中——证明上一条测的确是「缩进」的效
  #    果,不是语法本身被测坏了。
  {
    printf '%s\n' '**2026-01-01 — 测试教训己(缩进 trigger,非法形态)** [test:trig-indent]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/* -->'
    printf '%s\n' 'body'
  } > "$T6/mem/lessons.md"
  out="$(run_dut_custom "$T6/mem" "$T6/state" "$T6/log.tsv" "$T6/ledger" "$T" '{"session_id":"test:s15","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/indent2.sh"}}')"
  printf '%s' "$out" | grep -q 'test:trig-indent' && ok=$((ok+1))
  # 16. R5-7 fix (2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md MEDIUM-5 /
  #     FABLE-2026-09-15-codex-cumulative-triage.md R5-7): a syntactically-legal trigger comment
  #     written INSIDE a fenced code block (a documentation example) must NOT be collected/matched —
  #     core.parseFile()/the write gate both treat fenced content as invisible to the grammar; the
  #     recall engine's own scan used to have no fence state at all and would push on it regardless.
  T7="$(mktemp -d)"; mkdir -p "$T7/mem/dreams" "$T7/state" "$T7/ledger"
  {
    printf '%s\n' '**2026-01-01 — 测试教训庚(围栏内的合法 trigger 示例)** [test:trig-fenced]'
    printf '%s\n' '文档示例,以下三行仅作说明,不是真 trigger:'
    printf '%s\n' '```'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/* -->'
    printf '%s\n' '```'
    printf '%s\n' 'body'
  } > "$T7/mem/lessons.md"
  : > "$T7/mem/decisions.md"; : > "$T7/mem/standinginstructions.md"
  out="$(run_dut_custom "$T7/mem" "$T7/state" "$T7/log.tsv" "$T7/ledger" "$T" '{"session_id":"test:s16","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/fenced.sh"}}')"
  { [ -z "$out" ] || ! printf '%s' "$out" | grep -q 'trig-fenced'; } && ok=$((ok+1))
  # 17. R5-7 反例控制组:同一条 trigger 去掉围栏(顶格、不在 ``` 内)必须照常命中——证明上一条测的
  #     确是「围栏」的效果,不是语法本身被测坏了。
  {
    printf '%s\n' '**2026-01-01 — 测试教训庚(围栏内的合法 trigger 示例)** [test:trig-fenced]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/* -->'
    printf '%s\n' 'body'
  } > "$T7/mem/lessons.md"
  out="$(run_dut_custom "$T7/mem" "$T7/state" "$T7/log.tsv" "$T7/ledger" "$T" '{"session_id":"test:s17","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/fenced2.sh"}}')"
  printf '%s' "$out" | grep -q 'test:trig-fenced' && ok=$((ok+1))
  rm -rf "$T7"
  rm -rf "$T6"

  # 18. M-SPEC 附录 B1 (2026-09-17): v3 ledger dual-write. Two triggers match the same Edit event;
  #     one tag is already in the session's .trigger-seen file. Asserts: eligible row per matched
  #     tag (2), suppressed row for the already-seen tag (run_provenance=seen), displayed row for the
  #     newly-injected tag (written after stdout); every row has exactly 21 TAB-separated columns;
  #     gate/confidence columns are empty; trigger_or_gate_id is non-empty; mode=intervene; the
  #     impression_id column recomputes from the pinned formula
  #     sha16(session_id||NUL||agent_id||NUL||tool_use_id||NUL||tag||NUL||sha16(repo||NUL||rel));
  #     and the legacy dreams/trigger-log-*.tsv line is still written alongside it (old behavior
  #     untouched — separately golden-diffed byte-for-byte against the pre-B1 binary in the build
  #     report, not re-checked here since this script IS the post-B1 binary).
  T8="$(mktemp -d)"; mkdir -p "$T8/mem" "$T8/state" "$T8/ledger"
  {
    printf '%s\n' '**2026-01-01 — B18 教训甲(旧,已 seen)** [test:b18-old]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/* -->'
    printf '%s\n' 'Class: [[class:b18-class]]'
    printf '%s\n' 'body one'
    printf '%s\n' '**2026-01-02 — B18 教训乙(新)** [test:b18-new]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/*s18target* -->'
    printf '%s\n' 'Class: [[class:b18-class]]'
    printf '%s\n' 'body two'
  } > "$T8/mem/lessons.md"
  : > "$T8/mem/decisions.md"; : > "$T8/mem/standinginstructions.md"
  printf 'test:b18-old\n' > "$T8/state/.trigger-seen-$(seenkey "test:s18full1" "s18-agent")"
  out18="$(run_dut_custom "$T8/mem" "$T8/state" "$T8/log.tsv" "$T8/ledger" "$T" '{"session_id":"test:s18full1","tool_use_id":"toolu_selftest_s18-tu1","agent_id":"s18-agent","agent_type":"builder","prompt_id":"s18-prompt","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/s18target.sh"}}')"
  ledger18="$T8/ledger/events-v3-$(node -e 'console.log(require("os").hostname())').tsv"
  # column indices (1-based, per pmm-recall-ledger.cjs COLUMNS): 8=impression_id 10=event_kind
  # 11=gate 12=confidence 14=trigger_or_gate_id 17=mode 18=run_provenance
  if [ -f "$ledger18" ] \
    && [ "$(awk -F'\t' 'NR>1 && $10=="eligible"' "$ledger18" | wc -l)" -ge 2 ] \
    && [ "$(awk -F'\t' 'NR>1 && $10=="suppressed" && $18 ~ /^seen;inst:/' "$ledger18" | wc -l)" -ge 1 ] \
    && [ "$(awk -F'\t' 'NR>1 && $10=="displayed"' "$ledger18" | wc -l)" -ge 1 ] \
    && [ "$(awk -F'\t' 'NR>1 {print NF}' "$ledger18" | sort -u)" = "21" ] \
    && ! awk -F'\t' 'NR>1 && ($11!="" || $12!="")' "$ledger18" | grep -q . \
    && ! awk -F'\t' 'NR>1 && $14==""' "$ledger18" | grep -q . \
    && ! awk -F'\t' 'NR>1 && $10=="suppressed" && $18 !~ /^seen;inst:/' "$ledger18" | grep -q .; then
    ok=$((ok+1))
  fi
  # mode column == intervene on every row
  if [ -f "$ledger18" ] && [ "$(awk -F'\t' 'NR>1 && $17!="intervene"' "$ledger18" | wc -l)" -eq 0 ]; then ok=$((ok+1)); fi
  # impression_id recompute for the newly-injected tag (eligible + displayed rows share one impression_id)
  eligNewImp="$(awk -F'\t' 'NR>1 && $10=="eligible" && $14=="test:b18-new"{print $8; exit}' "$ledger18")"
  dispNewImp="$(awk -F'\t' 'NR>1 && $10=="displayed" && $14=="test:b18-new"{print $8; exit}' "$ledger18")"
  recomputed="$(node -e '
    const crypto = require("crypto");
    function sha16(s){ return crypto.createHash("sha256").update(String(s),"utf8").digest("hex").slice(0,16); }
    const NUL = String.fromCharCode(0);
    const gi = sha16(["home",".claude/guards/s18target.sh"].join(NUL));
    console.log(sha16(["test:s18full1","s18-agent","toolu_selftest_s18-tu1","test:b18-new",gi].join(NUL)));
  ')"
  if [ -n "$eligNewImp" ] && [ "$eligNewImp" = "$dispNewImp" ] && [ "$eligNewImp" = "$recomputed" ]; then ok=$((ok+1)); fi

  # Opus review (2026-09-17, "G11 的 impression 可核"): an EXTERNAL verifier (no hook internals, just
  # the pinned repo/rel convention + the ledger row) must be able to recompute gate_instance_id from
  # run_provenance's appended inst:<sha16> tag, and from there recompute the full impression_id --
  # proving G11 is actually checkable, not just internally self-consistent.
  eligNewProv="$(awk -F'\t' 'NR>1 && $10=="eligible" && $14=="test:b18-new"{print $18; exit}' "$ledger18")"
  suppOldProv="$(awk -F'\t' 'NR>1 && $10=="suppressed" && $14=="test:b18-old"{print $18; exit}' "$ledger18")"
  suppOldImp="$(awk -F'\t' 'NR>1 && $10=="suppressed" && $14=="test:b18-old"{print $8; exit}' "$ledger18")"
  # eligible/displayed run_provenance is now "policy:<state>;inst:<hex>" (MEDIUM-6 coordinator
  # dispatch: no policy.json in this fixture -> policy:absent); suppressed-seen stays "seen;inst:<hex>".
  # Extraction is deliberately tolerant of whatever precedes "inst:" so it does not re-break the next
  # time run_provenance's prefix convention changes.
  extInstFromEligible="$(printf '%s' "$eligNewProv" | sed -n 's/.*inst:\([0-9a-f]\{16\}\)$/\1/p')"
  extInstFromSuppressed="$(printf '%s' "$suppOldProv" | sed -n 's/.*inst:\([0-9a-f]\{16\}\)$/\1/p')"
  extGateInstanceId="$(node -e '
    const crypto = require("crypto");
    function sha16(s){ return crypto.createHash("sha256").update(String(s),"utf8").digest("hex").slice(0,16); }
    const NUL = String.fromCharCode(0);
    console.log(sha16(["home",".claude/guards/s18target.sh"].join(NUL)));
  ')"
  if [ -n "$extInstFromEligible" ] && [ "$extInstFromEligible" = "$extGateInstanceId" ] \
    && [ -n "$extInstFromSuppressed" ] && [ "$extInstFromSuppressed" = "$extGateInstanceId" ]; then
    ok=$((ok+1))
  fi
  extImpFromInst="$(node -e '
    const crypto = require("crypto");
    function sha16(s){ return crypto.createHash("sha256").update(String(s),"utf8").digest("hex").slice(0,16); }
    const NUL = String.fromCharCode(0);
    console.log(sha16(["test:s18full1","s18-agent","toolu_selftest_s18-tu1","test:b18-old",process.argv[1]].join(NUL)));
  ' "$extInstFromSuppressed")"
  if [ -n "$suppOldImp" ] && [ "$extImpFromInst" = "$suppOldImp" ]; then ok=$((ok+1)); fi
  # legacy dreams/trigger-log-*.tsv still written (dual-write, not replaced)
  grep -q "$(printf '\t')event$(printf '\t')" "$T8/log.tsv" && grep -q "$(printf '\t')injected$(printf '\t')" "$T8/log.tsv" && grep -q "$(printf '\t')suppressed-seen$(printf '\t')" "$T8/log.tsv" && ok=$((ok+1))
  # stdout still carries the injection for the new tag (dual-write didn't swallow the real behavior)
  printf '%s' "$out18" | grep -q 'test:b18-new' && ok=$((ok+1))
  rm -rf "$T8"

  # 19-20. MEDIUM-6 (2026-09-17, coordinator dispatch): policy.resolve() shadow/intervene fork.
  #        Same trigger fixture, policy.json marks class:test-class randomized; a session whose
  #        (session,class) hash lands on shadow must NOT be displayed (zero stdout bytes) and must
  #        write eligible+suppressed(reason=policy-shadow) with mode=shadow; a session landing on
  #        intervene must display normally with mode=intervene, run_provenance=policy:randomized.
  T9="$(mktemp -d)"; mkdir -p "$T9/mem" "$T9/state" "$T9/ledger"
  {
    printf '%s\n' '**2026-01-01 — 测试教训甲** [test:trig-alpha]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/* -->'
    printf '%s\n' 'Class: [[class:m6-class]]'
    printf '%s\n' 'body'
  } > "$T9/mem/lessons.md"
  : > "$T9/mem/decisions.md"; : > "$T9/mem/standinginstructions.md"
  printf '{"class:m6-class":{"mode":"randomized"}}' > "$T9/ledger/policy.json"
  shadowSid="$(node -e '
    const policy = require(process.argv[1]);
    for (let i = 0; i < 500; i++) { const sid = "shd" + i + "xxxxxxxxxxxxxx"; if (policy.assignment(sid, "class:m6-class", "randomized") === "shadow") { console.log(sid); process.exit(0); } }
  ' "$G/pmm-recall-policy.cjs")"
  intervSid="$(node -e '
    const policy = require(process.argv[1]);
    for (let i = 0; i < 500; i++) { const sid = "itv" + i + "xxxxxxxxxxxxxx"; if (policy.assignment(sid, "class:m6-class", "randomized") === "intervene") { console.log(sid); process.exit(0); } }
  ' "$G/pmm-recall-policy.cjs")"
  outShadowPayload="$(printf '{"session_id":"%s","tool_use_id":"toolu_selftest_m6-tu-shd","agent_id":"m6-agent","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/m6shadow.sh"}}' "$shadowSid")"
  outShadow="$(run_dut_custom "$T9/mem" "$T9/state" "$T9/log.tsv" "$T9/ledger" "$T" "$outShadowPayload")"
  ledger9="$T9/ledger/events-v3-$(node -e 'console.log(require("os").hostname())').tsv"
  if [ -z "$outShadow" ] \
    && [ "$(awk -F'\t' 'NR>1 && $10=="eligible" && $17=="shadow"' "$ledger9" | wc -l)" -ge 1 ] \
    && [ "$(awk -F'\t' 'NR>1 && $10=="suppressed" && $17=="shadow" && $18 ~ /^policy-shadow;inst:/' "$ledger9" | wc -l)" -ge 1 ] \
    && [ "$(awk -F'\t' 'NR>1 && $10=="displayed"' "$ledger9" | wc -l)" -eq 0 ]; then
    ok=$((ok+1))
  fi
  outIntervPayload="$(printf '{"session_id":"%s","tool_use_id":"toolu_selftest_m6-tu-itv","agent_id":"m6-agent","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/m6interv.sh"}}' "$intervSid")"
  outInterv="$(run_dut_custom "$T9/mem" "$T9/state" "$T9/log.tsv" "$T9/ledger" "$T" "$outIntervPayload")"
  if printf '%s' "$outInterv" | grep -q 'test:trig-alpha' \
    && [ "$(awk -F'\t' 'NR>1 && $10=="displayed" && $17=="intervene" && $18 ~ /^policy:randomized;inst:/' "$ledger9" | wc -l)" -ge 1 ]; then
    ok=$((ok+1))
  fi
  rm -rf "$T9"

  # 27-28. 确定性契约(2026-09-17, Opus 复现「两个全新 PMM_RECALL_ROOT 选中不相交的三条教训」):
  #        5 条触发器竞争 3 个名额,证明 (a) MEM+STATE+ROOT 三者都全新且相互独立时,两次调用输出
  #        逐字节相同;(b) 反例控制组:MEM+STATE 相同、只换 ROOT 时,seen 去重生效,第二次输出必然
  #        与第一次不同(证明上一条测的确是"三者都全新"的效果,不是巧合)。
  T10="$(mktemp -d)"; T10W="$(cygpath -m "$T10")"
  mkdir -p "$T10/mem"
  {
    printf '%s\n' '**2026-01-01 — 确定性教训一** [test:det-one]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/detprobe*.sh -->'
    printf '%s\n' 'body'
    printf '%s\n' '**2026-01-02 — 确定性教训二** [test:det-two]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/detprobe*.sh -->'
    printf '%s\n' 'body'
    printf '%s\n' '**2026-01-03 — 确定性教训三** [test:det-three]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/detprobe*.sh -->'
    printf '%s\n' 'body'
    printf '%s\n' '**2026-01-04 — 确定性教训四** [test:det-four]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/detprobe*.sh -->'
    printf '%s\n' 'body'
    printf '%s\n' '**2026-01-05 — 确定性教训五** [test:det-five]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/detprobe*.sh -->'
    printf '%s\n' 'body'
  } > "$T10/mem/lessons.md"
  : > "$T10/mem/decisions.md"; : > "$T10/mem/standinginstructions.md"
  detHook="$(printf '{"session_id":"test:det-sess-1","tool_use_id":"toolu_selftest_det-tu-1","tool_name":"Edit","tool_input":{"file_path":"%s/.claude/guards/detprobe.sh"}}' "$T10W")"

  # (a) positive: MEM+STATE+ROOT all fresh & independent for EACH call -> byte-identical stdout.
  detMemW="$T10W/mem"
  S1="$(mktemp -d)"; R1="$(mktemp -d)"
  outA="$(run_dut_custom "$detMemW" "$(cygpath -m "$S1")" "" "$(cygpath -m "$R1")" "$T10W" "$detHook")"
  S2="$(mktemp -d)"; R2="$(mktemp -d)"
  outB="$(run_dut_custom "$detMemW" "$(cygpath -m "$S2")" "" "$(cygpath -m "$R2")" "$T10W" "$detHook")"
  if [ -n "$outA" ] && [ "$outA" = "$outB" ] \
    && printf '%s' "$outA" | grep -q 'test:det-one' && printf '%s' "$outA" | grep -q 'test:det-two' && printf '%s' "$outA" | grep -q 'test:det-three'; then
    ok=$((ok+1))
  fi

  # (b) negative control: SAME STATE (same session's seen-file persists), only ROOT changes -> the
  #     second call's output MUST differ (seen-dedup suppresses the first call's 3 winners, so
  #     different candidates fill the 3 slots) -- proving (a)'s identity was genuinely about STATE
  #     being fresh too, not an accident.
  S3="$(mktemp -d)"; R3="$(mktemp -d)"; R4="$(mktemp -d)"
  outC="$(run_dut_custom "$detMemW" "$(cygpath -m "$S3")" "" "$(cygpath -m "$R3")" "$T10W" "$detHook")"
  outD="$(run_dut_custom "$detMemW" "$(cygpath -m "$S3")" "" "$(cygpath -m "$R4")" "$T10W" "$detHook")"
  if [ -n "$outC" ] && [ "$outC" != "$outD" ] \
    && printf '%s' "$outD" | grep -q 'test:det-four' && printf '%s' "$outD" | grep -q 'test:det-five'; then
    ok=$((ok+1))
  fi
  rm -rf "$T10" "$S1" "$S2" "$S3" "$R1" "$R2" "$R3" "$R4"

  # 29. M-4① (2026-09-17, fab blind attack / Opus reproduction): a DANGLING [[link]] (no title
  #     anywhere in the scanned files -- the fixture below uses two such links) must never occupy a
  #     push slot; a genuinely resolvable linked entry sitting AFTER the dangling ones in the source
  #     order must still show, not get crowded out. Old behavior: dangling1+dangling2 alone would fill
  #     both of the direct hit's remaining 2 slots (1 hit + 3-cap), and test:m4-b would never appear.
  T11="$(mktemp -d)"; mkdir -p "$T11/mem/dreams" "$T11/state" "$T11/ledger"
  {
    printf '%s\n' '**2026-01-01 — 测试教训 M4A** [test:m4-a]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/m4probe*.sh -->'
    printf '%s\n' 'body 关联 [[test:m4-dangling1]] 也关联 [[test:m4-dangling2]] 还关联 [[test:m4-b]]'
    printf '%s\n' '**2026-01-02 — 测试教训 M4B(真实关联目标)** [test:m4-b]'
    printf '%s\n' 'body'
  } > "$T11/mem/lessons.md"
  : > "$T11/mem/decisions.md"; : > "$T11/mem/standinginstructions.md"
  out11="$(run_dut_custom "$T11/mem" "$T11/state" "$T11/log.tsv" "$T11/ledger" "$T" '{"session_id":"test:s-m4","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/m4probe.sh"}}')"
  if printf '%s' "$out11" | grep -q 'test:m4-a' \
    && printf '%s' "$out11" | grep -q 'test:m4-dangling1' \
    && printf '%s' "$out11" | grep -q 'test:m4-dangling2' \
    && printf '%s' "$out11" | grep -q 'test:m4-b' \
    && printf '%s' "$out11" | grep -q '冷区/项目档,标题不在三文件'; then
    ok=$((ok+1))
  fi
  rm -rf "$T11"

  # 30. HIGH-1 (2026-09-17, fab blind attack / Opus reproduction): redirecting ONLY HOME+USERPROFILE
  #     (no PMM_HOME, no PMM_TRIGGER_MEM/STATE/LOG, no PMM_RECALL_ROOT at all) must be SUFFICIENT to
  #     fully isolate every path this hook touches -- STATE/MEM default off HOME, and RECALL_ROOT/LOG
  #     default off resolveHome() too, so a bare HOME+USERPROFILE redirect covers all four.
  #     LOW-7 fix (2026-09-23, fab blind delta / Opus reproduction, 批 A3): this used to snapshot the
  #     REAL production paths as one combined content sha256 before/after the isolated call and assert
  #     byte-identical -- real production hooks append to these SAME files at a measured ~0.44 lines/sec,
  #     so any genuinely concurrent real event landing inside the ~0.25s window failed this case for a
  #     reason that has nothing to do with this test (estimated ~10% false-red per run). Replaced with
  #     the SAME attribution method codex#5's part14 fix uses: compare file name + byte SIZE (not
  #     content), and for any file that grew or newly appeared, inspect ONLY the newly appended bytes
  #     (or the whole file, for a brand-new one) for THIS case's own markers -- the literal tag
  #     `test:high1-probe`, sha16('test:s-high1') (would appear in a leaked ledger row's sid_sha16 column),
  #     or the exact computed `.trigger-seen-<key>` basename this case's own session/agent would produce.
  #     Only a marker match is judged a leak (red); unrelated real growth is real production traffic and
  #     must not fail an isolation proof it had nothing to do with.
  real_files() {
    { find "$REAL_HOME_KSAFE/.claude" -maxdepth 1 -name '.trigger-seen-*' -type f 2>/dev/null
      find "$REAL_HOME_KSAFE/.claude/memory/dreams" -maxdepth 1 -name 'trigger-log-*.tsv' -type f 2>/dev/null
      find "$REAL_HOME_KSAFE/.claude/.local/pmm-recall" -maxdepth 1 \( -name 'trigger-log-*.tsv' -o -name 'events-v3-*.tsv' \) -type f 2>/dev/null
    } | sort
  }
  snapshot_sizes() { real_files | while IFS= read -r f; do printf '%s\t%s\n' "$f" "$(wc -c < "$f" 2>/dev/null | tr -d ' \r')"; done; }
  snap_before="$(snapshot_sizes)"
  T12="$(mktemp -d)"; mkdir -p "$T12/.claude/memory/dreams" "$T12/.claude/guards"
  {
    printf '%s\n' '**2026-01-01 — 测试教训 HIGH1** [test:high1-probe]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/high1probe*.sh -->'
    printf '%s\n' 'body'
  } > "$T12/.claude/memory/lessons.md"
  : > "$T12/.claude/memory/decisions.md"; : > "$T12/.claude/memory/standinginstructions.md"
  T12W="$(cygpath -m "$T12")"
  out12="$(run_dut_bare_redirect "$T12W" '{"session_id":"test:s-high1","tool_name":"Edit","tool_input":{"file_path":"'"$T12W"'/.claude/guards/high1probe.sh"}}')"
  snap_after="$(snapshot_sizes)"
  fakeSeenExists=0; [ -f "$T12/.claude/.trigger-seen-"* ] 2>/dev/null && fakeSeenExists=1
  fakeLedgerExists=0; ls "$T12/.claude/.local/pmm-recall/events-v3-"*.tsv >/dev/null 2>&1 && fakeLedgerExists=1
  s_high1_sha="$(node -e 'const c=require("crypto");process.stdout.write(c.createHash("sha256").update("test:s-high1","utf8").digest("hex").slice(0,16));')"
  seen_marker_name=".trigger-seen-$(seenkey "test:s-high1" "")"
  leak=0
  while IFS="$(printf '\t')" read -r f szAfter; do
    [ -z "$f" ] && continue
    szBefore="$(printf '%s\n' "$snap_before" | awk -F'\t' -v p="$f" '$1==p{print $2; exit}')"
    [ -z "$szBefore" ] && szBefore=0
    if [ "$szAfter" -gt "$szBefore" ] 2>/dev/null; then
      base="$(basename "$f")"
      tail_bytes="$(tail -c +"$((szBefore+1))" "$f" 2>/dev/null)"
      if [ "$base" = "$seen_marker_name" ] \
        || printf '%s' "$tail_bytes" | grep -qF -e 'test:high1-probe' -e "$s_high1_sha"; then
        leak=1
      fi
    fi
  done <<< "$snap_after"
  if printf '%s' "$out12" | grep -q 'test:high1-probe' \
    && [ "$leak" -eq 0 ] \
    && [ "$fakeSeenExists" -eq 1 ] \
    && [ "$fakeLedgerExists" -eq 1 ]; then
    ok=$((ok+1))
  fi
  rm -rf "$T12"

  # 31. codex 终审 #7(2026-09-23,批 A3):类枢纽 [class:zz](带 trigger)+ 正文 30 个悬空链 + 2 个
  #     Class: [[class:zz]] 成员——修前 30 个悬空链把 ≤3 名额全占满(类成员那半用的是
  #     `inject.length + linked.length` 判额,linked 里全是悬空占位),两个真同类成员全部缺席;修后
  #     悬空占位单独封顶 max(0, 3−inject.length)=2 条,类成员改按 resolvedSlots 判额,两个成员都进。
  T13="$(mktemp -d)"; mkdir -p "$T13/mem" "$T13/state" "$T13/ledger"
  {
    printf '%s\n' '**2026-01-01 — 类:zz类** [class:zz]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/zzhub*.sh -->'
    zzbody='判据:x'
    for zi in $(seq 1 30); do zzbody="$zzbody [[test:zzdangle$zi]]"; done
    printf '%s\n' "$zzbody"
  } > "$T13/mem/classes.md"
  {
    printf '%s\n' '**2026-01-01 — zz 成员一** [test:zz-mem1]'
    printf '%s\n' 'Class: [[class:zz]]'
    printf '%s\n' 'body'
    printf '%s\n' '**2026-01-02 — zz 成员二** [test:zz-mem2]'
    printf '%s\n' 'Class: [[class:zz]]'
    printf '%s\n' 'body'
  } > "$T13/mem/lessons.md"
  : > "$T13/mem/decisions.md"; : > "$T13/mem/standinginstructions.md"
  out13="$(run_dut_custom "$T13/mem" "$T13/state" "$T13/log.tsv" "$T13/ledger" "$T" '{"session_id":"test:s-zz","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/zzhub.sh"}}')"
  danglingShown="$(printf '%s' "$out13" | grep -oE 'test:zzdangle[0-9]+' | sort -u | wc -l)"
  danglingCapped="$(awk -F'\t' '$3=="dangling-capped"' "$T13/log.tsv" 2>/dev/null | wc -l)"
  if printf '%s' "$out13" | grep -q 'test:zz-mem1' && printf '%s' "$out13" | grep -q 'test:zz-mem2' \
    && [ "$danglingShown" -le 2 ] && [ "$danglingCapped" -ge 1 ]; then
    ok=$((ok+1))
  fi
  # (report-only, M4 前不判红) 这条同一次推送的 additionalContext UTF-8 字节数——M4 才把 ≤1.2KB 转成
  # 硬闸(RECALL-LOOP-M-SPEC-v2.md:70-75),这里先打印一个真实数字备用,不影响 ok/N。
  # LOW-3 fix(2026-09-23,Opus A3 审查):`wc -c` 之前量的是整段 stdout(`JSON.stringify({hookSpecificOutput:
  # {...}})`,含字段名、大括号、转义序列),不是标签写的 additionalContext 字段本身——两者不同(639B vs
  # 真实 552B)。改成解析 JSON 后只量 additionalContext 的解码后 UTF-8 字节数(JSON 转义的 `\n` 等不该算
  # 进字节数,必须先解码)。
  out13Bytes="$(printf '%s' "$out13" | node -e '
    const fs = require("fs");
    let n = -1;
    try {
      const obj = JSON.parse(fs.readFileSync(0, "utf8"));
      const ctx = (obj.hookSpecificOutput && obj.hookSpecificOutput.additionalContext) || "";
      n = Buffer.byteLength(ctx, "utf8");
    } catch (e) {}
    process.stdout.write(String(n));
  ')"
  echo "[report-only] case-31 additionalContext UTF-8 字节数 = ${out13Bytes}(M4 前不判红,目标 ≤1200)"
  rm -rf "$T13"

  # 32. codex 终审 #7(2026-09-23,批 A3):7 节点取代链 s1→s2→…→s7,trigger 种在 s1——修前
  #     `hops++ < 5` 固定跳数在第 5 跳停在 s6(不是最新);修后 visited-Set 一直追到真正的链头 s7。
  T14="$(mktemp -d)"; mkdir -p "$T14/mem" "$T14/state" "$T14/ledger"
  {
    printf '%s\n' '**2026-01-01 — 链节点一(旧,trigger 种这)** [test:chain-s1]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/chainprobe*.sh -->'
    printf '%s\n' 'body'
    printf '%s\n' '**2026-01-02 — 链节点二** [test:chain-s2]'
    printf '%s\n' 'body'
    printf '%s\n' 'Supersedes: [[test:chain-s1]]'
    printf '%s\n' '**2026-01-03 — 链节点三** [test:chain-s3]'
    printf '%s\n' 'body'
    printf '%s\n' 'Supersedes: [[test:chain-s2]]'
    printf '%s\n' '**2026-01-04 — 链节点四** [test:chain-s4]'
    printf '%s\n' 'body'
    printf '%s\n' 'Supersedes: [[test:chain-s3]]'
    printf '%s\n' '**2026-01-05 — 链节点五** [test:chain-s5]'
    printf '%s\n' 'body'
    printf '%s\n' 'Supersedes: [[test:chain-s4]]'
    printf '%s\n' '**2026-01-06 — 链节点六** [test:chain-s6]'
    printf '%s\n' 'body'
    printf '%s\n' 'Supersedes: [[test:chain-s5]]'
    printf '%s\n' '**2026-01-07 — 链节点七(最新)** [test:chain-s7]'
    printf '%s\n' 'body'
    printf '%s\n' 'Supersedes: [[test:chain-s6]]'
  } > "$T14/mem/lessons.md"
  : > "$T14/mem/decisions.md"; : > "$T14/mem/standinginstructions.md"
  out14="$(run_dut_custom "$T14/mem" "$T14/state" "$T14/log.tsv" "$T14/ledger" "$T" '{"session_id":"test:s-chain","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/chainprobe.sh"}}')"
  # primary bullet only ("- [tag]"), not a "↳ 关联" carry-along line -- s5's own Supersedes line makes
  # s7 reachable as a linked entry even under the old buggy head() for an unrelated reason (Supersedes
  # lines also register as outgoing [[link]]s, a pre-existing side effect this batch does not touch),
  # so the real signal is which tag is the PRIMARY injection.
  if printf '%s' "$out14" | grep -q -- '- \[test:chain-s7\]' && ! printf '%s' "$out14" | grep -q -- '- \[test:chain-s6\]'; then
    ok=$((ok+1))
  fi
  rm -rf "$T14"

  # 33. codex 终审 #7(2026-09-23,批 A3):a↔b 取代环——修前固定跳数没有环检测(也不写 tlog,只是
  #     悄悄在环上转几圈后停);修后 visited-Set 检出重复,停在第一次重复之前并记 tlog('supersede-cycle')。
  T15="$(mktemp -d)"; mkdir -p "$T15/mem" "$T15/state" "$T15/ledger"
  {
    printf '%s\n' '**2026-01-01 — 环节点甲(trigger 种这)** [test:cyc-a]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/cycprobe*.sh -->'
    printf '%s\n' 'body'
    printf '%s\n' 'Supersedes: [[test:cyc-b]]'
    printf '%s\n' '**2026-01-02 — 环节点乙** [test:cyc-b]'
    printf '%s\n' 'body'
    printf '%s\n' 'Supersedes: [[test:cyc-a]]'
  } > "$T15/mem/lessons.md"
  : > "$T15/mem/decisions.md"; : > "$T15/mem/standinginstructions.md"
  # LOW-2 fix(2026-09-23,Opus A3 审查):这条金丝雀不带超时——环检测一旦被删(裸 `while` 回归),
  # `head()` 会在 supNext 环上永久打转,这个 `node` 调用会**挂死**,而不是变红;拖住的是整个自证
  # 脚本(后续用例永远跑不到),不是"case 33 不通过"这种可诊断的红。run_dut 第三参传 20 秒超时,
  # 超时(rc=124)显式判红并打印原因,不计入 ok。
  #
  # 反例(2026-09-23 真实事故,绝不可执行——A3-尾-3 复现的正是这一行:直接裸调用 DUT,四个
  # PMM_TRIGGER_*/PMM_RECALL_ROOT 重定向变量全部缺失,当天真的打到了真根;本文件末尾的结构闸
  # 就是为了让这一行不可能再次悄悄溜进来):
  #   out15="$(printf '%s' '{"session_id":"test:s-cyc",...}' | timeout 20 node "$G/pmm-trigger-recall.cjs")"
  out15="$(run_dut_custom "$T15/mem" "$T15/state" "$T15/log.tsv" "$T15/ledger" "$T" '{"session_id":"test:s-cyc","tool_name":"Edit","tool_input":{"file_path":"'"$TW"'/.claude/guards/cycprobe.sh"}}' 20)"
  rc15=$?
  if [ "$rc15" -eq 124 ]; then
    echo "  ✖ case-33 超时(rc=124)——环检测挂死,不是变红;此例判负,不计入 ok"
  elif [ -n "$out15" ] && grep -q "$(printf '\t')supersede-cycle$(printf '\t')" "$T15/log.tsv"; then
    ok=$((ok+1))
  fi
  rm -rf "$T15"

  # 34. fab blind delta LOW-2(2026-09-23,批 A3):一个全新 PMM_RECALL_ROOT(连父目录都还不存在)+
  #     一个 no-repo 事件(tlog('event',{note:'no-repo matched=0'}) 是这个进程对这个 root 的第一次
  #     写)——修前 fs.appendFileSync 直接 ENOENT,被空 catch 悄悄吞掉,trigger-log 文件从未出现;
  #     修后 append 前先 mkdirSync(recursive:true),文件必须存在且含这行 no-repo 记录。
  T16="$(mktemp -d)"; ROOT16="$T16/fresh/nested/root"
  MEM16="$T16/mem"; mkdir -p "$MEM16"
  : > "$MEM16/lessons.md"; : > "$MEM16/decisions.md"; : > "$MEM16/standinginstructions.md"
  LOG16="$ROOT16/trigger-log-selftest.tsv"
  out16="$(run_dut_custom "$MEM16" "$T16/state" "$LOG16" "$ROOT16" "$T16" '{"session_id":"test:s-noroot","tool_name":"Edit","tool_input":{"file_path":"D:/elsewhere/notrepo/x.sh"}}')"
  if [ -f "$LOG16" ] && grep -q "$(printf '\t')event$(printf '\t').*no-repo" "$LOG16"; then
    ok=$((ok+1))
  fi
  rm -rf "$T16"

  rm -rf "$T5" "$T4" "$T3" "$T2" "$T"
  N=35

  # ── 结构闸(2026-09-23,A3-尾-3;basename 正则化 spec 22):全文件只允许两处调用 DUT(本文件自身配对
  #    的 .cjs——`run_dut_custom`/`run_dut_bare_redirect` 各一处,行尾都带 `# DUT-ENTRY`);文件末尾的
  #    生产直连入口带 `# PROD-ENTRY`;纯注释行(反例文档、这段说明本身)一律排除。凡是不属于这三类的
  #    裸调用命中数必须为 0——这正是今天事故发生的那种写法。DUT basename 从本文件自己的文件名推出
  #    (pmm-trigger-recall.sh -> pmm-trigger-recall.cjs),不再写死两遍字面量字符串。
  DUT_CJS_BASENAME="$(basename "${BASH_SOURCE[0]}" .sh).cjs"
  DUT_CJS_BASENAME_RE="$(printf '%s' "$DUT_CJS_BASENAME" | sed 's/\./\\./g')"
  # (node|bash|sh) + optional quoted path prefix + basename -- same shape as spec 26's canary regex
  # (an optional "<path>/" prefix, not a literal "$G" match: avoids a hand-rolled backslash-dollar
  # escape sequence, which measured unreliable to build correctly across this repo's nested quoting).
  _bare_dut_calls=$(grep -nE '(node|bash|sh)[[:space:]]+("?[^"[:space:]]*/)?'"$DUT_CJS_BASENAME_RE"'"?' "$0" \
    | sed 's/^[0-9]*://' \
    | grep -v '# DUT-ENTRY' \
    | grep -v '# PROD-ENTRY' \
    | grep -vE '^[[:space:]]*#' \
    | wc -l | tr -d ' \r')

  # SELFTEST-BEGIN
  # 真根零足迹断言,终点核验(2026-09-23,A3-尾-3;superseded 2026-09-23 by spec 22 K8/终审勘误候选3):
  # candidate 集合原来完全来自 run_dut()/run_dut_bare_redirect() 自己的运行期登记(ALL_SIDS_FILE)——
  # 任何绕过这两个入口的裸调用永远不会被登记,泄漏因此可能漏判(A3-N1 同类)。改用共享
  # selftest-iso.sh 的 selftest_footprint_end,其 markersFromSource 对本文件做**静态源码扫描**(不
  # 依赖任何运行期登记),同时把这次运行根的 mkdtemp basename 与 nonce 也并入标记集合。
  FP_LINE="$(selftest_footprint_end "$FP_SNAP" "$SELFTEST_NONCE" "$(basename "$T")" "$0")"
  FP_RC=$?
  FP_FAIL=0; [ "$FP_RC" -ne 0 ] && FP_FAIL=1
  # SELFTEST-END

  if [ "$ok" -eq "$N" ] && [ "$_bare_dut_calls" -eq 0 ] && [ "$FP_FAIL" -eq 0 ]; then
    echo "pmm-trigger-recall 自证 $N/$N;结构闸绿(0 处裸调用);$FP_LINE"
    exit 0
  else
    [ "$ok" -ne "$N" ] && echo "✖ pmm-trigger-recall 自证 $ok/$N"
    [ "$_bare_dut_calls" -ne 0 ] && echo "✖ 结构闸:发现 $_bare_dut_calls 处未经 run_dut/run_dut_bare_redirect 的裸调用"
    [ "$FP_FAIL" -ne 0 ] && echo "✖ 真根零足迹断言失败:$FP_LINE"
    exit 1
  fi
fi

exec node "$G/pmm-trigger-recall.cjs"  # PROD-ENTRY
