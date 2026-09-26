#!/usr/bin/env bash
# guard-canary — L0 元守卫:定期喂每台守卫已知输入,把「静默失效」变成「响亮失效」。
#
# 为什么存在:2026-08-03 一轮审计发现存量机器坏了 6 件无人察觉(记忆注入器每次会话
# exit 1、hook 清单漏 5 个、检测工具造好没接线、守卫分支建好没合并……)。
# 守卫的头号死因不是被绕过,是静默死亡 —— 死守卫比没守卫更糟,因为它读起来像有覆盖。
#
# 用法:
#   guard-canary.sh              跑全部名册(每周一次;autopull 超 7 天会点灯提醒)
#   guard-canary.sh --self-test  证明金丝雀自己能变红(喂它一个必失败项)
#
# 纪律(2026-08-05 Fable 定,the maintainer 授权「杜绝重复犯错」框架):
#   - 名册就是守卫注册表:新守卫上线必须同时加一行,否则它不存在。
#   - 全绿才写 stamp;任何一台失败 → exit 1 + 点名,不写 stamp(autopull 的灯会持续亮)。
#   - 金丝雀自己也会被遗忘 —— 所以新鲜度检查在 autopull 里,不在这里(报警器不和火同源)。
set -uo pipefail

# part13 收口(2026-09-17,M-6a):家目录一律经 pmm-home.sh 拿 $PMM_HOME_RESOLVED,不直读 $HOME
# (pipe-gate-v2-acceptance.cjs self-check part13——本文件此前 24 处直读)。
source "$(dirname "${BASH_SOURCE[0]}")/pmm-home.sh"

STAMP="$PMM_HOME_RESOLVED/.claude/.guard-canary-stamp"
G="$PMM_HOME_RESOLVED/.claude/guards"
# 2026-09-23(A1-尾,契约 v2.26 part13,conventions.home_literal_scan):home_literal_scan 判据是
# 逐行正则命中——MSYS 形 `/c/Users/<name>` 和 Windows 形 `C:\Users\<name>`/`C:/Users/<name>`
# 只要以字面量出现在非注释代码行就算红,不管是在普通字符串里还是 JSON 夹具里。下面几个派生量
# 是本文件其余处硬编码字面量的唯一替代来源,统一从已经 source 过的 $PMM_HOME_RESOLVED(MSYS 形)
# 派生,不再另起一份新的家目录判断:
#   PMM_HOME_WIN      = Windows 正斜杠形(cygpath -m),给 node require()/JSON 消费。
#   PMM_HOME_WIN_JSON = 上面那个值先转成反斜杠形(cygpath -w)、再经 JSON.stringify 转义、
#                       去掉首尾引号——给要嵌进 JSON 载荷字符串里的 Windows 反斜杠路径夹具用
#                       (JSON.stringify 会把每个 `\` 转义成 `\\`,与生产 hook JSON 的转义形态
#                       一致)。cygpath 找不到就原样退回,不让整个金丝雀因为环境缺 cygpath 而死。
PMM_HOME_WIN="$(cygpath -m "$PMM_HOME_RESOLVED" 2>/dev/null)"
[ -n "$PMM_HOME_WIN" ] || PMM_HOME_WIN="$PMM_HOME_RESOLVED"
_pmm_home_backslash="$(cygpath -w "$PMM_HOME_RESOLVED" 2>/dev/null)"
[ -n "$_pmm_home_backslash" ] || _pmm_home_backslash="$PMM_HOME_WIN"
PMM_HOME_WIN_JSON="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]).slice(1,-1))' "$_pmm_home_backslash" 2>/dev/null)"
[ -n "$PMM_HOME_WIN_JSON" ] || PMM_HOME_WIN_JSON="$_pmm_home_backslash"
# OSS note: this canary can optionally also exercise a SECOND local repo's own itest/hook-wiring
# suite (useful if you run AxMem's guards against more than one codebase). Off by default — set
# PMM_SECOND_REPO_DIR to a dedicated worktree path to opt in; every AX-dependent check below is a
# silent PASS (not FAIL) when it is unset, so a fresh clone with no second repo configured stays green.
AX="${PMM_SECOND_REPO_DIR:-}"
# spec 26:ax_freshen 改成独立一行,红绿都靠 run() 统一计一次(之前只在失败时手动 fail++、成功时
# 什么都不加,导致「一件事报两次红」——失败时 pass+fail 总数比 EXPECTED 多算一次,连带触发不相关的
# 「名册计数 ≠ EXPECTED」告警)。函数本身只负责回显最后状态行 + 用 return 码交给 run() 计分。
ax_freshen() {
  [ -n "$AX" ] || return 0
  local ax_root="${AX%/.claude/worktrees/*}"
  [ -f "$AX/.env.local" ] || cp "$ax_root/.env.local" "$AX/.env.local" 2>/dev/null
  git -C "$AX" fetch -q origin main 2>/dev/null && git -C "$AX" merge --ff-only -q origin/main 2>/dev/null
  local want have stampf="$AX/.canary-lock-stamp"
  want="$(git -C "$AX" rev-parse origin/main:package-lock.json 2>/dev/null)"
  have="$(cat "$stampf" 2>/dev/null)"
  if [ "$want" != "$have" ] || [ ! -d "$AX/node_modules" ]; then
    (cd "$AX" && npm ci --prefer-offline --no-audit --no-fund >/dev/null 2>&1 && npx prisma generate >/dev/null 2>&1) && printf '%s' "$want" > "$stampf"
  fi
  # 2026-09-13 Opus 审计 P1:ff 失败(离网/树脏)时原版仍标"(origin/main)"——14 台守卫测旧代码
  # 而标签撒谎,正是建专属树要根治的病。不等即红。
  local h r; h="$(git -C "$AX" rev-parse HEAD 2>/dev/null)"; r="$(git -C "$AX" rev-parse origin/main 2>/dev/null)"
  if [ -n "$r" ] && [ "$h" = "$r" ]; then
    echo "ax 靶=${h:0:8}(=origin/main ✓)"
    return 0
  else
    echo "ax 靶 STALE:HEAD=${h:0:8} ≠ origin/main=${r:0:8}(离网/树脏?守卫在测旧代码)"
    return 1
  fi
}

# spec 26(落实 [process:summary-layer-must-not-count-skip-as-pass]):run() 三态。rc 0 → PASS;rc 77
# 且行名在下面这张 SKIPPABLE 表里(源码常量,每一项都带理由)→ SKIP;其余任何非 0(含 2)→ FAIL;
# 77 但不在表里 → FAIL(防止一个检查悄悄改用 77 当"随便放过"的万能出口)。
declare -A SKIPPABLE=(
  ["pmm-recall-ledger 未重新污染(基线 613)"]="真台账文件不存在(全新/干净环境,从未产生过任何真实事件)"
  ["trigger-log 旧位置未重新污染(基线 298)"]="冻结的历史 trigger-log 文件不存在(全新/干净环境)"
  ["夜巡活性(环3 codex-nightly 未静默停摆)"]="codex-nightly 从未安装/未跑过,或 state.json 缺 last_run_date/日期无法解析(onboarding 阶段)"
  ["synthetic-must-skip"]="--self-test 的合成用例:证明表内 77 判 SKIP"
)
pass=0; fail=0; skip=0; executed=0; report=""
run() { # $1=名字  其余=命令
  local name="$1"; shift
  local t0=$SECONDS
  local outfile; outfile="$(mktemp)"
  "$@" >"$outfile" 2>&1
  local rc=$?
  executed=$((executed+1))
  local lastline; lastline="$(tail -n1 "$outfile" 2>/dev/null)"
  if [ "$rc" -eq 0 ]; then
    pass=$((pass+1)); report="${report}  ✔ ${name} ($((SECONDS-t0))s)\n"
  elif [ "$rc" -eq 77 ] && [ -n "${SKIPPABLE[$name]+x}" ]; then
    skip=$((skip+1))
    [ -z "$lastline" ] && lastline="${SKIPPABLE[$name]}"
    report="${report}  ⊘ ${name}:${lastline}\n"
  else
    fail=$((fail+1))
    report="${report}  ✖ ${name} ← 守卫失效或自测失败,立刻查$( [ -n "$lastline" ] && printf ' (%s)' "$lastline" )\n"
  fi
  rm -f "$outfile"
}

# selftest_structure_roster_check_src -- prints the node source for the "自测结构名册" canary row
# (spec 22's static judgment, embedded here rather than as its own committed file: guard-canary.sh is
# this batch's only writer of this file, and this check's whole purpose IS a canary row, not a
# standalone tool). Echoed into a single-quoted heredoc at call time (tooling:node-e-inline-strips-
# backslashes-in-claude-bash: never `node -e` for content with backslashes/regex -- write it to a real
# .cjs file first). Takes argv[1]=guards dir, argv[2..]=roster basenames; reuses
# pmm-isolation-gate.cjs's own computeDutSet()/realHome() so the DUT-basename union this check scans
# for is byte-identical to what the gate itself judges against, never a second copy.
selftest_structure_roster_check_src() {
  cat <<'ROSTER_SRC_EOF'
'use strict';
const fs = require('fs');
const path = require('path');
const guardsDir = process.argv[2];
const roster = process.argv.slice(3);
const { computeDutSet, realHome } = require(path.join(guardsDir, 'pmm-isolation-gate.cjs'));
const home = realHome();
const dutSet = computeDutSet(home);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dutBasenamesRe = Array.from(dutSet).map(escRe).join('|');
const problems = [];

// spec 22: session_id/sessionId/tool_use_id literals must be test:/toolu_selftest_-prefixed. Scope
// (A 批建造纪律,spec 审 K7 的落地判断): for a .sh roster file this batch owns whole (pmm-trigger-
// recall.sh), scan the WHOLE file; for a .cjs file this batch was restricted to editing only inside
// // SELFTEST-BEGIN..END (bash-pipe-exitcode-watch.cjs / pmm-bash-impression.cjs each carry many
// PRE-EXISTING unprefixed tool_use_id fixtures far outside that region, entirely out of this batch's
// write face to touch), scope the scan to the SAME region text every other .cjs structural check
// below already uses -- this check enforces exactly what this batch touched and could fix, not a
// blanket full-file sweep that would flag pre-existing, out-of-scope content as if it were new.
function checkSessionLiterals(fname, scanText) {
  const sidRe = /\b(?:session_id|sessionId|tool_use_id)\b["']?\s*[:=]\s*["']([^"'\\]*)["']/g;
  let m;
  while ((m = sidRe.exec(scanText))) {
    const val = m[1];
    if (!val || val === '%s') continue; // printf placeholder, not a literal id (substituted at runtime)
    if (val.indexOf('test:') !== 0 && val.indexOf('toolu_selftest_') !== 0) {
      problems.push(fname + ': unprefixed session/tool_use literal "' + val + '"');
    }
  }
}

for (const fname of roster) {
  const fpath = path.join(guardsDir, fname);
  let text;
  try { text = fs.readFileSync(fpath, 'utf8'); } catch (e) { problems.push(fname + ': cannot read (' + e.message + ')'); continue; }

  // 2026-09-24(收口者 A 段任务1):memory/_local-config/pmm-hook.cjs 是活体 <真home>/.claude/pmm-hook.cjs
  // 的镜像——活体被 .gitignore 排除、不入库,登记的是镜像路径,这里额外对活体做一次逐字节 cmp
  // (同 M-7「settings.json 活体≡镜像」的手法,只是比较对象换成 pmm-hook.cjs)。漂移只算这一项的
  // problem,不影响下面 .cjs 分支给这个文件的其余判据(两者并存,各自独立累加进 problems)。
  if (/([\\/])_local-config[\\/]pmm-hook\.cjs$/.test(fname)) {
    const livePath = path.join(home, '.claude', 'pmm-hook.cjs');
    let liveText = null;
    try { liveText = fs.readFileSync(livePath, 'utf8'); } catch (e) { problems.push(fname + ': live counterpart unreadable at ' + livePath + ' (' + e.message + ')'); }
    if (liveText !== null && liveText !== text) {
      problems.push(fname + ': mirror drifted from live ' + livePath + ' (byte-for-byte mismatch)');
    }
  }

  if (/\.sh$/i.test(fname)) {
    checkSessionLiterals(fname, text);
    const isoEntriesMatch = text.match(/#\s*ISO-ENTRIES:\s*(.+)/);
    const isoEntries = isoEntriesMatch ? isoEntriesMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (isoEntries.length === 0) problems.push(fname + ': no "# ISO-ENTRIES:" header comment found');
    // lineOf(idx) -- 1-based line number that a character offset into `text` falls on (count of '\n'
    // before it, plus 1). Used below to turn each ISO-ENTRIES function's regex match (a character
    // range) into a line-number range, so a `# DUT-ENTRY` tag's location can be checked against it.
    const lineOf = (idx) => text.slice(0, idx).split('\n').length;
    const isoRanges = [];
    for (const fn of isoEntries) {
      // function body up to the matching closing brace at THIS SAME (or lesser) indentation level --
      // a bare `\n}` at column 0 never matches an indented function nested inside `if ...; then`.
      // .exec() (not .match(), though for a non-global regex they're equivalent) so `fm.index` /
      // `fm[0].length` are documented as always present -- used to compute the body's line range.
      const fnRe = new RegExp(escRe(fn) + '\\s*\\(\\)\\s*\\{([\\s\\S]*?)\\n[ \\t]*\\}', 'm');
      const fm = fnRe.exec(text);
      if (!fm || fm[1].indexOf('selftest_iso_env') === -1) {
        problems.push(fname + ': ISO-ENTRIES function "' + fn + '" body missing a selftest_iso_env call');
      }
      if (fm) {
        // range = from just after the opening `{` through just after the matched closing `}`
        // (inclusive on both ends) -- generous enough to cover a tag on the brace lines themselves,
        // tight enough to exclude everything before/after this one function's block.
        const braceOffset = fm[0].indexOf('{');
        const bodyStart = fm.index + braceOffset + 1;
        const bodyEnd = fm.index + fm[0].length;
        isoRanges.push({ fn: fn, startLine: lineOf(bodyStart), endLine: lineOf(bodyEnd) });
      }
    }
    const dutLineRe = new RegExp('(node|bash|sh)[ \\t]+("?[^"\\s]*/)?(' + dutBasenamesRe + ')\\b', 'i');
    text.split('\n').forEach((line, i) => {
      const lineNo = i + 1;
      const trimmed = line.trim();
      if (!trimmed || trimmed.indexOf('#') === 0) return;
      const isDutCallLine = dutLineRe.test(line);
      const hasDutEntryTag = line.indexOf('# DUT-ENTRY') !== -1;
      const hasProdEntryTag = line.indexOf('# PROD-ENTRY') !== -1;
      if (isDutCallLine && !hasDutEntryTag && !hasProdEntryTag) {
        problems.push(fname + ':' + lineNo + ': bare DUT-basename call not tagged # DUT-ENTRY / # PROD-ENTRY');
      }
      // location check scoped to the SAME population as the "bare call" check above (an actual
      // DUT-invocation-shaped line, not a pure-comment or quoted-string mention of the literal tag
      // text elsewhere in the file, e.g. this file's own convention-explaining prose or a
      // grep -v '# DUT-ENTRY' filter pattern a few hundred lines away -- neither is a call site and
      // neither should be judged against the ISO-ENTRIES function ranges).
      if (isDutCallLine && hasDutEntryTag) {
        const inside = isoRanges.some((r) => lineNo >= r.startLine && lineNo <= r.endLine);
        if (!inside) {
          problems.push(fname + ':' + lineNo + ': # DUT-ENTRY tag falls outside every ISO-ENTRIES function body');
        }
      }
      // E-8② (spec 22 三点补写第 2 条): # PROD-ENTRY previously exempted ANY DUT-basename call line
      // unconditionally (no location check at all) -- that let a self-test call inside an
      // ISO-ENTRIES function body dodge the # DUT-ENTRY discipline just by wearing the "production"
      // tag instead. # PROD-ENTRY may only mark a line OUTSIDE every ISO-ENTRIES function body (a
      // real production entry point is by definition not inside a self-test-only isolated function).
      if (isDutCallLine && hasProdEntryTag) {
        const insideIso = isoRanges.some((r) => lineNo >= r.startLine && lineNo <= r.endLine);
        if (insideIso) {
          problems.push(fname + ':' + lineNo + ': # PROD-ENTRY tag falls inside an ISO-ENTRIES function body (not a real production entry; use # DUT-ENTRY there instead)');
        }
      }
    });
  } else if (/\.cjs$/i.test(fname)) {
    const regionRe = /\/\/\s*SELFTEST-BEGIN([\s\S]*?)\/\/\s*SELFTEST-END/g;
    const regions = [];
    let rm;
    while ((rm = regionRe.exec(text))) regions.push(rm[1]);
    if (regions.length === 0) { problems.push(fname + ': no // SELFTEST-BEGIN..END region found'); continue; }
    const combined = regions.join('\n');
    checkSessionLiterals(fname, combined);
    if (/Object\.assign\(\{\},\s*process\.env|\.\.\.process\.env|env:\s*process\.env/.test(combined)) {
      problems.push(fname + ': a bare ambient-env clone was found inside a SELFTEST region');
    }
    if (combined.indexOf('isoEnv(') === -1) problems.push(fname + ': isoEnv( never called inside any SELFTEST region');
    const regionLines = combined.split('\n');
    regionLines.forEach((line, i) => {
      if (/\b(spawnSync|execFileSync|execSync|spawn)\s*\(/.test(line)) {
        const windowText = regionLines.slice(i, i + 6).join('\n');
        if (windowText.indexOf('env') === -1) problems.push(fname + ': a spawn-family call has no `env` within 6 lines');
      }
      if (/\bwriteEvent\s*\(/.test(line)) {
        const windowText = regionLines.slice(i, i + 6).join('\n');
        if (windowText.indexOf('root') === -1) problems.push(fname + ': a writeEvent( call has no `root` within 6 lines');
      }
    });
    if (!/footprint\.begin|selftest_footprint_begin/.test(combined) || !/footprint\.end|selftest_footprint_end/.test(combined)) {
      problems.push(fname + ': footprint begin/end are not both present inside a SELFTEST region');
    }
  }
}

if (problems.length) {
  console.log('自测结构名册 FAIL (' + problems.length + '):');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
} else {
  console.log('自测结构名册 pass:' + roster.length + ' 个文件全部合规');
  process.exit(0);
}
ROSTER_SRC_EOF
}

# check_selftest_structure_roster -- runs the source above as a real .cjs (heredoc to a temp file,
# never `node -e`) against SELFTEST_STRUCTURE_ROSTER (spec 22, 6 members: A 批新建/补齐的 5 个
# 自测 + pmm-isolation-gate.cjs 自己). Plain bash function (not a `bash -c "<string>"` row) precisely
# to avoid double-escaping the embedded JS through two layers of shell quoting.
# 2026-09-24(收口者 A 段任务1,C05-BUILD-SPEC 补遗二 + CHANGELOG「留收口:名册登记」逐条落地):
# 追加 6 个 C0.5 建造者产物 + 1 个镜像,登记但不改被测文件——静态检查真跑,红的照实报告(见上方
# selftest_structure_roster_check_src 的判据;pmm-precommit-shadow-replay.sh 没有 `# ISO-ENTRIES:`
# 头注释、pmm-hook.cjs 镜像不是自测文件,两者预期都会各自命中若干条 problem,不是本条目的 bug,
# 是登记后如实呈现的现状)。memory/_local-config/pmm-hook.cjs 是活体 <真home>/.claude/pmm-hook.cjs
# 的镜像(活体被 .gitignore 排除、不入库),对活体的逐字节 cmp 见上方专属分支。
# 2026-09-24(收口者 C 段任务1,W4 新增自测):追加 pmm-c0-canary-check.sh(补遗三第 32 条改写版,
# 语料内容指纹定键)。登记但不改被测文件——它没有 `# ISO-ENTRIES:` 头注释/isoEnv 标记,静态检查预期
# 会照实报若干 problem(同 pmm-precommit-shadow-replay.sh 的先例),不是本条目要修的 bug。
# OSS open-core cut (2026-09-24): pmm-trigger-compat-replay.cjs/pmm-index-emit.cjs/
# pmm-shadow-compare.cjs/pmm-shadow-replay.cjs/pmm-precommit-shadow-replay.sh/pmm-search-v2.cjs/
# pmm-fault-matrix.cjs/pmm-c0-canary-check.sh (all premium) and the live pmm-hook.cjs mirror
# entry (pmm-hook.cjs itself moved out) removed from this roster.
SELFTEST_STRUCTURE_ROSTER=(
  pmm-trigger-recall.sh
  bash-pipe-exitcode-watch.cjs
  pmm-bash-impression.cjs
  pmm-recall-m3.cjs
  pmm-isolation-gate.cjs
)
check_selftest_structure_roster() {
  local t; t="$(mktemp -d)"
  selftest_structure_roster_check_src > "$t/check.cjs"
  node "$t/check.cjs" "$G" "${SELFTEST_STRUCTURE_ROSTER[@]}"
  local rc=$?
  rm -rf "$t"
  return "$rc"
}

# check_recall_ledger_not_recontaminated (2026-09-17, coordinator LOW-K2-followup, baseline updated
# same day per M-6a): the ONE canary check in this whole roster that deliberately reads the REAL
# production ledger (not an isolated temp root, unlike every self-test above/below) -- its job is to
# catch a RECURRENCE of the pmm-trigger-recall.sh self-test leak (fixed at the source this round).
# Baseline raised 572→574 (coordinator-reported: the two extra rows are the runner's own part14
# legitimate synthetic-session verification pass, not a new leak -- confirmed distinct from the
# original incident's rows). Per M-SPEC append-only discipline these historical rows are NEVER
# deleted/rewritten -- this check only asserts the count never GROWS past the frozen baseline (a
# strict increase means a NEW leak). Criterion widened to match isContaminatedRow() (defined
# identically -- same return expression -- in pmm-recall-baseline/label/m3/precision/queue.cjs; NOT
# currently exported from pmm-recall-ledger.cjs or pmm-recall-policy.cjs despite being the pinned
# cross-tool criterion, so this reproduces the same boolean test rather than calling a shared export
# that does not yet exist -- flagged separately, not fixed here, out of this round's write surface).
# Column indices are pmm-recall-ledger.cjs's own exported COLUMNS order (line ~23): sid_sha16=$3,
# tool_use_id=$7, run_provenance=$18, id_missing=$20.
# 2026-09-23(A1 批,Opus codex-final-triage §6 CONFIRMED 子点 + fab-delta LOW-5):基线 574→579——
# 5 行是 09-18 06:58–08:13Z 的 pending-expired 空 sid GC 回落行(写入口已被 bac617a 关闭,不会再长)。
# 判据 `$7 ~ /^tu-/` 改成 `$7!="" && $7 !~ /^toolu_/`(精确一些:只要第 7 列非空又不是 toolu_ 前缀
# 就算可疑,不再局限于 tu- 这一种拼法),再加 `$7 ~ /selftest/` 作为第三个判据——但**只看第 7 列**:
# 真台账里对整行做 `grep selftest` 会命中 152 行真实 tag(如 tooling:selftest-sandbox-deps-derive),
# 这些不是自测泄漏,是合法教训标签,整行 grep 会把它们全部误判(fab-delta 真跑验证过)。
# 2026-09-23(建造任务 CO,A1-尾 13:55 交接):基线 579→613——+34 = 2026-09-23T16:46:02Z session
# sha16 b62105393532ca93("s-cyc")探针泄漏,tool_use_id 空;写入方为一次未重定向根的探针调用
# (repo=home,rel=.claude/guards/cycprobe.sh),见 CHANGELOG 13:55。这 34 行已满足
# id_missing='1' 这条既有判据(哨兵靠它抓住,若探针带了 tool id 就会漏——勘误 2 的 `test:`
# session 约定正是为此);b62105393532ca93 现也入下方 pmm-recall-ledger.cjs 的 named poisoned-sid
# 名单,给未来同一探针会话的重复写入再加一道写边界拦截,不是给这 34 行本身再加一层(它们已被
# id_missing 排除,append-only 不改写/不删除)。旧位置 legacy/活体 trigger-log 的判据与处理不变
# (不在这条冻结判据内,见 check_trigger_log_legacy_not_recontaminated())。
check_recall_ledger_not_recontaminated() {
  local root="$PMM_HOME_RESOLVED/.claude/.local/pmm-recall" host baseline=613 f n
  host="$(hostname)"
  f="$root/events-v3-$host.tsv"
  if [ ! -f "$f" ]; then echo "真台账文件不存在:$f(全新/干净环境,从未产生过任何真实事件)"; return 77; fi
  n=$(awk -F'\t' 'NR>1 && ($20=="1" || $3=="" || $18 ~ /^test/ || ($7!="" && $7 !~ /^toolu_/) || $7 ~ /selftest/) {c++} END{print c+0}' "$f")
  [ "$n" -le "$baseline" ]
}

# check_trigger_log_legacy_not_recontaminated (2026-09-17, M-6a): memory/dreams/trigger-log-<host>.tsv
# is a committed, historical artifact frozen as of the migration to <PMM_RECALL_ROOT>/
# trigger-log-<host>.tsv (see that file's own header) -- nothing should write to it going forward, so
# its already-committed non-8-hex-session-key row count (column 2 not matching a real Claude Code
# session_id's ^[0-9a-f]{8}$ hex prefix) must never exceed the frozen baseline. Baseline=298
# (coordinator-reported, exact reproduction command copied verbatim from
# memory/dreams/trigger-log-<host>.contaminated-keys.txt: 294 rows across 9 named synthetic fixture
# keys + 4 rows using the literal "-" sentinel).
# 2026-09-23(A1 批,Opus codex-final-triage §6 CONFIRMED):行数判据是「外形」判据——一行外形合法的
# 8-hex 会话键追加进这个冻结文件,行数会涨但这条旧判据的 grep -vcE 计数不受影响(实测:临时副本
# 追加一行 8-hex 键,旧判据 298→298,行数 25354→25355 却没人看)。改成精确判据:先断言活体文件
# 相对 HEAD 逐字节未变(`git diff --quiet HEAD`),再断言行数恰好等于冻结值 25354(冻结值出处见
# commit 86ac755,该 commit 是迁移完成、冻结这个位置的那次提交)。旧的非 8-hex 计数判据**保留**,
# 作为第二判据并存(不是替换)——两者任一为红即红。
check_trigger_log_legacy_not_recontaminated() {
  local host f n baseline=298 frozen_lines=25354 lines
  host="$(hostname)"
  f="$PMM_HOME_RESOLVED/.claude/memory/dreams/trigger-log-$host.tsv"
  if [ ! -f "$f" ]; then echo "冻结的历史 trigger-log 文件不存在:$f(全新/干净环境)"; return 77; fi
  git -C "$PMM_HOME_RESOLVED" diff --quiet HEAD -- ".claude/memory/dreams/trigger-log-$host.tsv" 2>/dev/null || return 1
  lines=$(wc -l < "$f" | tr -d ' ')
  [ "$lines" -eq "$frozen_lines" ] || return 1
  n=$(awk -F'\t' '{print $2}' "$f" | grep -vcE '^[0-9a-f]{8}$')
  [ "$n" -le "$baseline" ]
}

# ── M-2(2026-09-17,fab 盲攻 + Opus 复现):金丝雀首尾真根三件套对账 ──────────────
# 真根三件套(唯一真相,绝不能被本文件自己名册里的任何自测污染):
#   ① ~/.claude/.local/pmm-recall/events-v3-<host>.tsv  (v3 ledger,唯一持续被真实生产写入的)
#   ② ~/.claude/.trigger-seen-*                          (M3 去重标记文件集,pmm-trigger-recall.cjs
#      的 seenkey() 产出,文件名后缀 = sha16(session_id NUL agent_id),16 位小写十六进制)
#   ③ ~/.claude/memory/dreams/trigger-log-<host>.tsv    (旧位置,已冻结,见上一条哨兵注释)
# 开跑前拍快照(①③行数、②文件名集合),名册全跑完后对账。不能要求「一字节不变」——生产钩子
# 在金丝雀跑的这几分钟里可能被别的真实会话真实触发,那是合法的并发活动,不是回归。能接受的只是
# 「新增的看起来像真会话」:①③新增的行必须不满足上面两个哨兵已经在用的「合成/污染」判据
# (sid_sha16 结构不对/run_provenance 以 test 开头/tool_use_id 是 tu-* 形态/session 不是 8-hex);
# ②新增的文件名后缀必须是合法的 16 位小写十六进制(真 sha16 输出的形状)。任何一条新增不满足,
# 或者③(理论上不该再涨的冻结文件)只要涨了不看内容就算数——都判红,判据来源与上面两条哨兵、
# 与 pmm-recall-baseline.cjs 等五工具的 isContaminatedRow() 同一套,不新发明一套。
_m2_host="$(hostname)"
_m2_ledger="$PMM_HOME_RESOLVED/.claude/.local/pmm-recall/events-v3-$_m2_host.tsv"
_m2_triglog="$PMM_HOME_RESOLVED/.claude/memory/dreams/trigger-log-$_m2_host.tsv"
_m2_recall_root="$PMM_HOME_RESOLVED/.claude/.local/pmm-recall"
# 2026-09-24(收口者 A 段任务2,C05-BUILD-SPEC 补遗二第 9/11 条 + B4「留收口:M-2 加 .shadow/
# .pmm-index-lkg 两目录对账」):C0.5 影子面新增的两处真根写入目标,同一套三件套纪律扩到五件套。
_m2_shadow_dir="$PMM_HOME_RESOLVED/.claude/.shadow"
_m2_lkg_dir="$PMM_HOME_RESOLVED/.claude/.pmm-index-lkg"
# 2026-09-23(A1 批,codex#6/fab LOW-5;补丁 2026-09-23 A1-尾,Opus A1 review MEDIUM-1):此前只拍
# ledger/triglog 的行数 + seen 的文件名集合——「往已有的真 seen 文件里追加内容」和「root 目录里除
# ledger/triglog 外的其它文件」两类都看不见。改为「文件名\t字节数」快照,对象扩到 pmm-recall root
# 全目录(不含 receipts-*——那是逐会话 append-only 收据日志,没有定义好的合法性判据,归属另一批)
# 和全部 .trigger-seen-*。root 里 policy.json/quarantine-* 只要「新出现」或者已存在时字节数变化都
# 直接红——这两类文件在正常运作里本就不该在金丝雀这几分钟的窗口内被摸。
# **MEDIUM-1 更正(初版的说法不成立)**:初版这里写着「没有把已有 seen 文件字节数变化做成硬红」,
# 但 `_m2_seen_snapshot()` 当时定义了却从没被任何地方调用,首尾比较仍然只看文件名集合——不是
# 「刻意不判」,是「代码没有真的按设计跑」,提交信息里「tracked but not hard-failed」同样不成立。
# 读过 pmm-trigger-recall.cjs:391-393 确认同一个 session 会在自己的生命周期里对同一个 seen 文件
# 反复 read-modify-write(每多推一个不同的 tag 就追加一行内容)——这在几分钟窗口内是常态,今天
# 收尾复核时生产就真实追加过一次(160B,3 个 `tooling:` 真 tag)。但这恰好说明**内容归因法可行**,
# 不需要放弃这条检查:只看新增的字节,命中 `^test:` 前缀或含 `selftest` 子串的行才判红(与本文件
# 其余处对 tool_use_id/run_provenance 的判据同一套口径),真实生产 tag 追加不判红。
_m2_root_snapshot() { # 输出 "name\tsize" 行,root 目录直属文件(不递归),排除 receipts-*
  [ -d "$_m2_recall_root" ] || return 0
  find "$_m2_recall_root" -maxdepth 1 -type f ! -name 'receipts-*' 2>/dev/null | sort | while IFS= read -r f; do
    printf '%s\t%s\n' "$(basename "$f")" "$(wc -c < "$f" 2>/dev/null | tr -d ' ')"
  done
}
_m2_seen_snapshot() { # 输出 "name\tsize" 行,全部 .trigger-seen-*
  ls "$PMM_HOME_RESOLVED/.claude"/.trigger-seen-* 2>/dev/null | sort | while IFS= read -r f; do
    printf '%s\t%s\n' "$(basename "$f")" "$(wc -c < "$f" 2>/dev/null | tr -d ' ')"
  done
}
# 2026-09-24(收口者 A 段任务2):.shadow/ 与 .pmm-index-lkg/ 的「文件名+字节数」快照,复用上面同一种
# find -maxdepth 1 -type f 手法(不递归——两个目录本身都只放直属文件,没有子目录约定)。
_m2_dir_snapshot() { # $1=目录 -> "name\tsize" 行
  [ -d "$1" ] || return 0
  find "$1" -maxdepth 1 -type f 2>/dev/null | sort | while IFS= read -r f; do
    printf '%s\t%s\n' "$(basename "$f")" "$(wc -c < "$f" 2>/dev/null | tr -d ' ')"
  done
}
# 已知命名规律(与 pmm-hook.cjs/pmm-index-emit.cjs/pmm-shadow-*.cjs/pmm-search-v2.cjs 的 mach() 命名
# 惯例同源;本机 hostname 实测不含需要 sanitize 的字符,不在 bash 侧重复那份 node 正则,直接用
# $_m2_host)。新文件名不落在下面任一规律 ⇒ 视为「不认识/疑似别机器文件」,判红(任务2「新出现的
# 其他机器命名文件仍红」)。
_m2_known_shadow_name() { # $1=basename;rc=0 已知合法,rc=1 不认识
  case "$1" in
    hook-"$_m2_host".log|index-"$_m2_host".txt|legacy-"$_m2_host".log|retrieval-impressions-"$_m2_host".tsv|precommit-"$_m2_host".log) return 0 ;;
    seen-????????????????) # 影子 hook 自己的 seen 状态,与 .trigger-seen-* 同族(补遗二勘误 E-8③)
      printf '%s' "${1#seen-}" | grep -qE '^[0-9a-f]{16}$' && return 0
      return 1 ;;
    *) return 1 ;;
  esac
}
_m2_known_lkg_name() { # $1=basename;rc=0 已知合法(LKG key = sha256(sourceOids+schemaVersion) 的十六进制 + .txt)
  case "$1" in
    *.txt) printf '%s' "${1%.txt}" | grep -qE '^[0-9a-f]{64}$' && return 0; return 1 ;;
    *) return 1 ;;
  esac
}
snapshot_real_roots() {
  _m2_ledger_n0=0; [ -f "$_m2_ledger" ] && _m2_ledger_n0=$(wc -l < "$_m2_ledger" | tr -d ' ')
  _m2_triglog_n0=0; [ -f "$_m2_triglog" ] && _m2_triglog_n0=$(wc -l < "$_m2_triglog" | tr -d ' ')
  _m2_seen_before="$(ls "$PMM_HOME_RESOLVED/.claude"/.trigger-seen-* 2>/dev/null | sort)"
  # 2026-09-23(A1-尾,Opus A1 review MEDIUM-1):实际调用 _m2_seen_snapshot()——初版只定义了它,
  # 首尾比较从没真的用上,是这条检查的盲区根因。
  _m2_seen_before_ns="$(_m2_seen_snapshot)"
  _m2_root_before="$(_m2_root_snapshot)"
  # 2026-09-24(收口者 A 段任务2):.shadow/ 与 .pmm-index-lkg/ 首尾快照。
  _m2_shadow_before="$(_m2_dir_snapshot "$_m2_shadow_dir")"
  _m2_lkg_before="$(_m2_dir_snapshot "$_m2_lkg_dir")"
}
check_real_roots_only_grew_by_real_activity() {
  local bad="" n1 seen_after new_seen badrows badkeys newcount
  if [ -f "$_m2_ledger" ]; then
    n1=$(wc -l < "$_m2_ledger" | tr -d ' ')
    if [ "$n1" -gt "${_m2_ledger_n0:-0}" ]; then
      # 2026-09-23(A1 批,codex#6):^tu- 改按第 7 列精确判「非空且不是 toolu_ 形」,再加 selftest
      # 判据(同样只看第 7 列——整行 grep 会命中真实 tag 里带 "selftest" 子串的合法行,见下方
      # check_recall_ledger_not_recontaminated 同批注释的实证)。
      badrows=$(tail -n +"$((${_m2_ledger_n0:-0}+1))" "$_m2_ledger" | awk -F'\t' '
        $20=="1" || $3=="" || $18 ~ /^test/ || ($7!="" && $7 !~ /^toolu_/) || $7 ~ /selftest/ {c++} END{print c+0}')
      [ "${badrows:-0}" -gt 0 ] && bad="$bad ledger(+$((n1-${_m2_ledger_n0:-0}))行,疑似合成 ${badrows} 行)"
    fi
  fi
  if [ -f "$_m2_triglog" ]; then
    n1=$(wc -l < "$_m2_triglog" | tr -d ' ')
    [ "$n1" -gt "${_m2_triglog_n0:-0}" ] && bad="$bad trigger-log-旧位置(冻结位置仍涨:${_m2_triglog_n0:-0}→${n1})"
  fi
  seen_after="$(ls "$PMM_HOME_RESOLVED/.claude"/.trigger-seen-* 2>/dev/null | sort)"
  new_seen=$(comm -13 <(printf '%s\n' "${_m2_seen_before:-}") <(printf '%s\n' "$seen_after"))
  if [ -n "$new_seen" ]; then
    badkeys=0
    while IFS= read -r _f; do
      [ -z "$_f" ] && continue
      _bn=$(basename "$_f"); _key="${_bn#.trigger-seen-}"
      printf '%s' "$_key" | grep -qE '^[0-9a-f]{16}$' || badkeys=$((badkeys+1))
    done <<< "$new_seen"
    newcount=$(printf '%s\n' "$new_seen" | grep -c .)
    [ "$badkeys" -gt 0 ] && bad="$bad trigger-seen(新增 ${newcount} 个,疑似合成 ${badkeys} 个)"
  fi
  # 2026-09-23(A1-尾,Opus A1 review MEDIUM-1):已有 seen 文件被追加内容——真的调用
  # _m2_seen_snapshot()、真的比字节数,对追加的新增字节按内容归因:只有新增字节里出现
  # `^test:` 前缀或含 `selftest` 子串的行才判红,真实生产 tag(如 `tooling:xxx`)追加不判红。
  # tail -c "+N" 取从第 N 字节起到文件尾(GNU coreutils 语义,Git Bash 自带的就是),N=旧字节数+1。
  local seen_ns_after grown_existing badgrown _gn _oldsz _newsz _gf _delta
  seen_ns_after="$(_m2_seen_snapshot)"
  grown_existing=$(awk -F'\t' '
    NR==FNR{b[$1]=$2;next}
    ($1 in b) && b[$1]!=$2 {print $1"\t"b[$1]"\t"$2}
  ' <(printf '%s\n' "${_m2_seen_before_ns:-}") <(printf '%s\n' "$seen_ns_after"))
  if [ -n "$grown_existing" ]; then
    badgrown=""
    while IFS=$'\t' read -r _gn _oldsz _newsz; do
      [ -z "$_gn" ] && continue
      [ "${_newsz:-0}" -gt "${_oldsz:-0}" ] || continue
      _gf="$PMM_HOME_RESOLVED/.claude/$_gn"
      [ -f "$_gf" ] || continue
      _delta=$(tail -c "+$((_oldsz+1))" "$_gf" 2>/dev/null)
      if printf '%s\n' "$_delta" | grep -qE '(^|[[:space:]])test:|selftest'; then
        badgrown="$badgrown $_gn"
      fi
    done <<< "$grown_existing"
    [ -n "$badgrown" ] && bad="$bad trigger-seen(既有文件被追加,新增字节含可疑标记:${badgrown})"
  fi
  # root 目录首尾对账(2026-09-23 A1 批,LOW-5;补丁 2026-09-23 A1-尾,Opus A1 review MEDIUM-1 收尾
  # 一句「policy.json/quarantine-* 字节变化也纳入」):新出现 = 直接红;已存在时字节数变化也直接红
  # ——这两类文件在正常运作里本就不该在金丝雀这几分钟的窗口内被摸,不需要内容归因,存在变化即红。
  local root_after new_root_names bad_rootnew _rn changed_root_names bad_rootchg _cn
  root_after="$(_m2_root_snapshot)"
  new_root_names=$(awk -F'\t' 'NR==FNR{b[$1]=1;next} !($1 in b){print $1}' \
    <(printf '%s\n' "${_m2_root_before:-}") <(printf '%s\n' "$root_after"))
  bad_rootnew=""
  while IFS= read -r _rn; do
    [ -z "$_rn" ] && continue
    case "$_rn" in
      policy.json|quarantine-*) bad_rootnew="$bad_rootnew $_rn" ;;
      # 2026-09-24(收口者 A 段任务2,F1 CHANGELOG「新增真根 .read-signal-cache-<mach>.json,收口时纳入
      # M-2 允许名单」):本机新出现该文件不判红——显式记录这条允许名单决定,不是遗漏。
      ".read-signal-cache-$_m2_host.json") : ;;
    esac
  done <<< "$new_root_names"
  [ -n "$bad_rootnew" ] && bad="$bad root目录新出现敏感文件:${bad_rootnew}(policy.json/quarantine-* 一旦新出现直接判红)"
  changed_root_names=$(awk -F'\t' '
    NR==FNR{b[$1]=$2;next}
    ($1 in b) && b[$1]!=$2 {print $1}
  ' <(printf '%s\n' "${_m2_root_before:-}") <(printf '%s\n' "$root_after"))
  bad_rootchg=""
  while IFS= read -r _cn; do
    [ -z "$_cn" ] && continue
    case "$_cn" in
      policy.json|quarantine-*) bad_rootchg="$bad_rootchg $_cn" ;;
      # 任务2 允许名单(同上):既有 .read-signal-cache-<mach>.json 增长(F1 L-8 缓存命中率越用越高)
      # 不判红——这正是这份生产缓存的设计用途。
      ".read-signal-cache-$_m2_host.json") : ;;
    esac
  done <<< "$changed_root_names"
  [ -n "$bad_rootchg" ] && bad="$bad root目录敏感文件字节变化:${bad_rootchg}(policy.json/quarantine-* 已存在时被改写也判红)"
  # 2026-09-24(收口者 A 段任务2,同上批注):.shadow/、.pmm-index-lkg/ 首尾对账。新文件名不落在
  # _m2_known_shadow_name/_m2_known_lkg_name 已知规律 ⇒ 红(含「同名但机器段不是本机 hostname」,
  # 例如从别的机器同步过来的 hook-otherhost.log);既有文件字节增长本身不判红(hook 日志/LKG 缓存
  # 随真实生产活动持续增长是常态),但新增字节里出现 `"sid":"test:…"`/`"tool_use_id":"toolu_selftest_…"`
  # 这两个 JSON 字段值前缀(spec 22 markersFromSource 定义的合成标记,要求字段名+冒号+前缀整串匹配,
  # 不用裸 `test`/`selftest` 短字符串——主脑批审 M6:裸短字符串会被并发会话改动的真实 `*.test.ts`/
  # 含"test"正文误红,与 selftest-iso 足迹助手从 `test:` 截出 4 字符 `test` 同一类误报)则判红。
  local shadow_after new_shadow_names bad_shadownew _sn changed_shadow_names bad_shadowchg _scn _sf _soldsz _snewsz _sdelta
  shadow_after="$(_m2_dir_snapshot "$_m2_shadow_dir")"
  new_shadow_names=$(awk -F'\t' 'NR==FNR{b[$1]=1;next} !($1 in b){print $1}' \
    <(printf '%s\n' "${_m2_shadow_before:-}") <(printf '%s\n' "$shadow_after"))
  bad_shadownew=""
  while IFS= read -r _sn; do
    [ -z "$_sn" ] && continue
    _m2_known_shadow_name "$_sn" || bad_shadownew="$bad_shadownew $_sn"
  done <<< "$new_shadow_names"
  [ -n "$bad_shadownew" ] && bad="$bad .shadow新出现不认识的文件名:${bad_shadownew}(不符合 hook-/index-/legacy-/retrieval-impressions-/precommit-<本机hostname> 或 seen-<sha16> 规律)"
  changed_shadow_names=$(awk -F'\t' '
    NR==FNR{b[$1]=$2;next}
    ($1 in b) && b[$1]!=$2 {print $1"\t"b[$1]"\t"$2}
  ' <(printf '%s\n' "${_m2_shadow_before:-}") <(printf '%s\n' "$shadow_after"))
  if [ -n "$changed_shadow_names" ]; then
    bad_shadowchg=""
    while IFS=$'\t' read -r _scn _soldsz _snewsz; do
      [ -z "$_scn" ] && continue
      [ "${_snewsz:-0}" -gt "${_soldsz:-0}" ] || continue
      _sf="$_m2_shadow_dir/$_scn"
      [ -f "$_sf" ] || continue
      _sdelta=$(tail -c "+$((_soldsz+1))" "$_sf" 2>/dev/null)
      # 2026-09-24(主脑批审 M6 补丁):不用裸 `test`/`selftest` 短字符串——并发会话改动一个真实的
      # `*.test.ts`/含"test"的正文都会误红(与 selftest-iso 足迹助手从 `test:` 截出 4 字符 `test`
      # 同一类误报)。.shadow/hook-<mach>.log 是逐行 JSON,真伪只看这两个字段的值是否带合成前缀:
      # `"sid":"test:…"`、`"tool_use_id":"toolu_selftest_…"`(spec 22 markersFromSource 定义的唯二
      # 前缀形态)——要求「字段名+引号+冒号+前缀」整串,真实 session/tool_use_id(UUID/toolu_ 形)
      # 不可能巧合命中。
      if printf '%s\n' "$_sdelta" | grep -qE '"sid":"test:|"tool_use_id":"toolu_selftest_'; then
        bad_shadowchg="$bad_shadowchg $_scn"
      fi
    done <<< "$changed_shadow_names"
    [ -n "$bad_shadowchg" ] && bad="$bad .shadow既有文件被追加,新增字节含可疑标记:${bad_shadowchg}"
  fi
  local lkg_after new_lkg_names bad_lkgnew _ln
  lkg_after="$(_m2_dir_snapshot "$_m2_lkg_dir")"
  new_lkg_names=$(awk -F'\t' 'NR==FNR{b[$1]=1;next} !($1 in b){print $1}' \
    <(printf '%s\n' "${_m2_lkg_before:-}") <(printf '%s\n' "$lkg_after"))
  bad_lkgnew=""
  while IFS= read -r _ln; do
    [ -z "$_ln" ] && continue
    _m2_known_lkg_name "$_ln" || bad_lkgnew="$bad_lkgnew $_ln"
  done <<< "$new_lkg_names"
  [ -n "$bad_lkgnew" ] && bad="$bad .pmm-index-lkg新出现不认识的文件名:${bad_lkgnew}(不符合 <sha256 hex>.txt 规律)"
  # LKG 条目按内容寻址(文件名即 key),正常运作里不应改写既有 key 的内容——沿用 root 的
  # policy.json/quarantine-* 口径,已存在文件字节变化直接判红,不做内容归因。
  local changed_lkg_names bad_lkgchg _lcn
  changed_lkg_names=$(awk -F'\t' '
    NR==FNR{b[$1]=$2;next}
    ($1 in b) && b[$1]!=$2 {print $1}
  ' <(printf '%s\n' "${_m2_lkg_before:-}") <(printf '%s\n' "$lkg_after"))
  bad_lkgchg=""
  while IFS= read -r _lcn; do
    [ -z "$_lcn" ] && continue
    bad_lkgchg="$bad_lkgchg $_lcn"
  done <<< "$changed_lkg_names"
  [ -n "$bad_lkgchg" ] && bad="$bad .pmm-index-lkg既有文件字节变化:${bad_lkgchg}(内容寻址缓存,既有 key 不应被改写)"
  _m2_detail="$bad"
  [ -z "$bad" ]
}

# check_precommit_hook_wired_behaviorally (2026-09-23, A1 批, Opus codex-final-triage §10 HIGH +
# fab-delta triage §10): the check this replaces only asserted the hook file is +x and its text
# contains the substring "pmm-precommit-gate" -- neither catches `git config core.hooksPath` being
# pointed elsewhere (hook file itself untouched, git silently stops invoking it) nor a hook whose
# body has degraded to a no-op that still happens to contain that substring (literally demonstrated
# in the triage: `exit 0 # pmm-precommit-gate` passes the old substring check and is still green).
# Three checks, all required for green:
#  ① `git -C "$PMM_HOME_RESOLVED" rev-parse --git-path hooks/pre-commit` must resolve to the
#     canonical in-tree path `.git/hooks/pre-commit` -- proves core.hooksPath has not been hijacked.
#  ② the live hook's content sha256 must equal the committed mirror
#     `_local-config/git-hooks/pre-commit` (the mirror is the reviewed, in-git copy of a file that
#     itself cannot be tracked by git -- see .gitignore; any drift between them means the version
#     under review is not the version actually running).
#  ③ end-to-end: install this *exact* hook + this *exact* gate into a scratch git repo under a temp
#     dir that doubles as HOME (this matches production's own shape -- $HOME IS the repo root here).
#     A bad memory edit (retire-without-archive, the F check) must make `git commit` fail (rc!=0); a
#     clean edit of the same repo must then succeed (rc=0). This is the only one of the three that
#     proves the hook actually vetoes a commit, not merely that the file is present and unmodified.
check_precommit_hook_wired_behaviorally() {
  local live="$PMM_HOME_RESOLVED/.git/hooks/pre-commit"
  local mirror="$PMM_HOME_RESOLVED/.claude/memory/_local-config/git-hooks/pre-commit"
  local gitpath live_sha mirror_sha tp bad_rc good_rc
  # 2026-09-23(A1-尾,Opus A1 review LOW-2):清掉调用方可能继承来的 git 局部环境变量——实测
  # GIT_INDEX_FILE=<victim> 时,下面 scratch 仓的写入会悄悄暂存进 victim 的索引而不是 scratch 仓
  # 自己的索引,而这里的判断仍然 rc=0(scratch 仓自身的 add/commit 序列照样按预期成功/失败,
  # 只是操作对象被偷换了——今天没有从 git hook 里调金丝雀的调用方,是潜伏问题,不是今天在炸)。
  # 清单取自 `git rev-parse --local-env-vars`,不手写清单以免随 git 版本过期。
  local _geu=() _gv
  while IFS= read -r _gv; do [ -n "$_gv" ] && _geu+=(-u "$_gv"); done < <(git rev-parse --local-env-vars 2>/dev/null)
  [ -x "$live" ] || return 1
  gitpath="$(env "${_geu[@]}" git -C "$PMM_HOME_RESOLVED" rev-parse --git-path hooks/pre-commit 2>/dev/null)"
  [ "$gitpath" = ".git/hooks/pre-commit" ] || return 1
  [ -f "$mirror" ] || return 1
  live_sha="$(sha256sum "$live" 2>/dev/null | cut -d' ' -f1)"
  mirror_sha="$(sha256sum "$mirror" 2>/dev/null | cut -d' ' -f1)"
  [ -n "$live_sha" ] && [ "$live_sha" = "$mirror_sha" ] || return 1
  tp=$(mktemp -d)
  case "$tp" in /tmp/*|/var/*|"${TMPDIR:-/nonexistent}"*) : ;; *) return 1;; esac
  mkdir -p "$tp/.claude/memory/_local-config" "$tp/.claude/guards" "$tp/.git/hooks"
  ( cd "$tp" && env "${_geu[@]}" git init -q && env "${_geu[@]}" git config user.email t@t && env "${_geu[@]}" git config user.name t ) >/dev/null 2>&1
  cp "$live" "$tp/.git/hooks/pre-commit" && chmod +x "$tp/.git/hooks/pre-commit"
  cp "$PMM_HOME_RESOLVED/.claude/pmm-precommit-gate.sh" "$tp/.claude/pmm-precommit-gate.sh"
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n\n## Entries\n\n**2026-01-01 — keep** [a:keep]\nbody\n' > "$tp/.claude/memory/lessons.md"
  printf '# archive\n' > "$tp/.claude/memory/lessons-archive.md"
  ( cd "$tp" && env "${_geu[@]}" git add -A && env "${_geu[@]}" HOME="$tp" USERPROFILE="$tp" git commit -qm base ) >/dev/null 2>&1
  # 坏:删条目不入档 → git commit 必须失败
  printf '## Index\n\n## Entries\n\n' > "$tp/.claude/memory/lessons.md"
  ( cd "$tp" && env "${_geu[@]}" git add -A ) >/dev/null 2>&1
  ( cd "$tp" && env "${_geu[@]}" HOME="$tp" USERPROFILE="$tp" git commit -qm bad ) >/dev/null 2>&1
  bad_rc=$?
  if [ "$bad_rc" -eq 0 ]; then rm -rf "$tp"; return 1; fi
  # 好:合规新增 → git commit 必须放行
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n- 2026-01-02 [a:new] n\n\n## Entries\n\n**2026-01-01 — keep** [a:keep]\nbody\n\n**2026-01-02 — new** [a:new]\nbody\n' > "$tp/.claude/memory/lessons.md"
  ( cd "$tp" && env "${_geu[@]}" git add -A ) >/dev/null 2>&1
  ( cd "$tp" && env "${_geu[@]}" HOME="$tp" USERPROFILE="$tp" git commit -qm good ) >/dev/null 2>&1
  good_rc=$?
  rm -rf "$tp"
  [ "$good_rc" -eq 0 ]
}

# OSS open-core cut (2026-09-24): check_c05_shadow_replay() (drove pmm-shadow-replay.cjs /
# pmm-shadow-compare.cjs, both premium, moved out of the public repo) removed along with its
# roster row in roster() below.

roster() {
  # ── 全局守卫(~/.claude/guards)──
  run "review-gate 自测"          bash "$G/review-gate.sh" --self-test
  run "review-stamp 自测"         bash "$G/review-stamp.sh" --self-test
  run "lesson-channel-lint 自测"  bash "$G/lesson-channel-lint.sh" --self-test
  # A6(2026-08-20):两台合并为一个入口 model-guard.sh(分发器),实现文件保持两个、已冻结
  # (试用期至 2026-10-14;再有过拦/自修即退役评估)。名册按守卫记一行,三件套单层引用。
  run "model-guard 双面套件"      bash "$G/agent-model-guard.test.sh"
  # ⚠️ 已知偶发(the maintainer 2026-08-27 裁定记录不修):本行单独报红、单跑复现不出 = 大概率**并发互踩**,
  # 不是回归。机制:套件靠预置共享戳文件隔离旧用例,任何并发会话/金丝雀删它(rm .wf-model-asked*)
  # → extra-green 被模糊层误拦 → 84/1。已实证:隔离 HOME 下同用例 5/5 放行(2026-08-27,两会话对撞后定论)。
  # 处置:先查「刚才是否有另一会话在跑套件/清戳」;要定性就在隔离 HOME 单跑。属残余清单 #6(共享状态)。
  # 不修的原因:根治要动测试害具 = 对冻结守卫的第二次自修 → 触发退役评估;the maintainer 选择带病记录。
  run "model-guard 双面套件 wf"   bash "$G/workflow-model-guard.test.sh"
  run "model-guard 分发器自证"    bash "$G/model-guard.sh" --self-test
  # 2026-08-24:并列新守卫(不属冻结家族):贵模型派发须带 [OPUS:理由] 标记(成本闸,fail-open)
  run "opus-justification 自证"   bash "$G/opus-justification-guard.sh" --self-test
  # 2026-09-13 上线(the maintainer [memory:pointer-integrity-lint-approved]):指针完整性 lint,v1 报告模式。
  # 首照 23 发现全部处置(4 真失真修复/8 补前缀/4 lint 视野扩/白名单 4/1 台账建档)。--strict 接线待校准期。
  run "pmm-pointer-lint 自证"     bash "$G/pmm-pointer-lint.sh" --self-test
  # 2026-09-23(A1 批,补充事实:A4 已落地 1ae6437,pmm-home.sh 改经 resolveHome() 走 argv、导出
  # PMM_HOME_RESOLVED_VIA):A4 建的行为探针(HOME/USERPROFILE/PMM_HOME 三者分裂+node 缺失回落+
  # MSYS_NO_PATHCONV=1 共六项)此前没有入册——「造好没通电」的同一种病。这里先顺带补这一行;
  # 金丝雀首行的 PMM_HOME_RESOLVED_VIA 红灯见下方 main 流程(snapshot_real_roots 之前)。
  run "pmm-home-split-probe(六项行为探针:HOME/USERPROFILE/PMM_HOME 分裂+node 缺失回落+MSYS_NO_PATHCONV)" bash "$G/pmm-home-split-probe.sh"
  # 2026-09-13 推送/沉淀 v2(codex 评审后,the maintainer 批):收据=P0 确定性沉淀,触发召回=P1 窄试点(4 trigger,
  # 止损=30 标注样本后精确率<80% 砍)。telemetry 运行时只有 event/injected/suppressed-*/wt-normalized;
  # opened/followed 由校准期离线 join(access-log search 行 × trigger-log injected 行)推得——
  # 注释不许宣称不存在的列(Opus 审计 P2 抓的原话病)。
  run "pmm-receipt 自证"          bash "$PMM_HOME_RESOLVED/.claude/memory/_local-config/pmm-receipt.sh" --self-test
  run "pmm-trigger-recall 自证"   bash "$G/pmm-trigger-recall.sh" --self-test
  # 2026-09-17 LOW-K2-followup(coordinator 补充线索,真实台账 sid_sha16 分组核实):真实台账不再重新
  # 污染的哨兵——读上方 pmm-trigger-recall 自证这一行本身的历史事故(此前它反复把自己的自测夹具
  # 写进真根,见 pmm-trigger-recall.sh 头部「确定性契约」注释旁的 LOW-K2-followup 说明)。
  # 基线 2026-09-17 M-6a 改 574(见 check_recall_ledger_not_recontaminated 注释)。
  run "pmm-recall-ledger 未重新污染(基线 613)" check_recall_ledger_not_recontaminated
  # 2026-09-17(M-6a):旧位置 memory/dreams/trigger-log-<host>.tsv 已冻结不该再涨的姊妹哨兵。
  run "trigger-log 旧位置未重新污染(基线 298)" check_trigger_log_legacy_not_recontaminated
  # OSS open-core cut (2026-09-24): pmm-manifest.sh/pmm-manifest.cjs (统一解析器+取代图不变量)
  # were premium-tier, moved out of the public repo — self-test row removed.
  # 2026-09-15 HIGH-5 修复(FABLE-2026-09-15-glob-review-triage.md finding 5):trigger 注释写时拦截,
  # 真正接在 PreToolUse(settings.json Edit|Write|MultiEdit matcher),不是事后报警——上线即入册
  # (本文件头部铁律:「名册就是守卫注册表,新守卫上线必须同时加一行,否则它不存在」)。
  run "pmm-trigger-write-gate 自证" bash "$G/pmm-trigger-write-gate.sh" --self-test
  # 2026-09-17 上线(the maintainer 派活,决策 [memory:trigger-plant-at-write-fine-grained]「写教训须同笔种
  # trigger」):上面那道 B5/B32 只校验 trigger 注释语法合不合法,从不检查一条新条目有没有 trigger——
  # 规则只剩纪律没有在场闸,自己在衰减(lessons.md 239 条只 34 条带 trigger)。同入口扩展
  # pmm-trigger-write-gate.cjs 补上「新增条目必须带 trigger(合法 trigger 或显式
  # <!-- trigger: none; 理由=非空 -->),存量条目不追溯」——settings.json 接线不变(同一个已挂的
  # PreToolUse 脚本,没有新增 hook)。自证的 25 例已含 5 例 presence 专属红绿(见
  # fixtures/v3/trigger-write-gate-probe.cjs 用例 19-23),这里再独立起两行、直接对生产脚本喂一次
  # 真实 hook JSON,让在场性红绿本身在名册里可单独看见,不被上面 25 例大合集吞掉。
  local tp; tp=$(mktemp -d)
  case "$tp" in /tmp/*|/var/*|"${TMPDIR:-/nonexistent}"*) : ;; *) echo "mktemp 异常路径 $tp,拒绝继续"; exit 1;; esac
  local wtp; wtp=$(cygpath -m "$tp")
  printf 'ANCHOR\n' > "$tp/lessons.md"
  printf '%s' '{"session_id":"presence-canary-red","tool_name":"Edit","tool_input":{"file_path":"'"$wtp"'/lessons.md","old_string":"ANCHOR","new_string":"ANCHOR\n**2026-03-05 — canary-red** [canary:presence-red]\n<!-- attribution: canary -->\nbody 没有 trigger 行\n"}}' > "$tp/presence-red.json"
  run "pmm-trigger-presence 红(新增条目缺 trigger 必拦)" bash -c "
    out=\$(PMM_CANONICAL_MEMORY='$wtp' node '$G/pmm-trigger-write-gate.cjs' < '$tp/presence-red.json')
    printf '%s' \"\$out\" | grep -q '\"permissionDecision\":\"deny\"'
  "
  printf 'ANCHOR\n' > "$tp/lessons.md"
  printf '%s' '{"session_id":"presence-canary-green","tool_name":"Edit","tool_input":{"file_path":"'"$wtp"'/lessons.md","old_string":"ANCHOR","new_string":"ANCHOR\n**2026-03-06 — canary-green** [canary:presence-green]\n<!-- attribution: canary -->\n<!-- trigger: tool=Edit; repo=home; path=.claude/guards/* -->\nbody\n"}}' > "$tp/presence-green.json"
  run "pmm-trigger-presence 绿(新增条目带合法 trigger 必放)" bash -c "
    out=\$(PMM_CANONICAL_MEMORY='$wtp' node '$G/pmm-trigger-write-gate.cjs' < '$tp/presence-green.json')
    ! printf '%s' \"\$out\" | grep -q '\"permissionDecision\":\"deny\"'
  "
  rm -rf "$tp"
  # 2026-09-16 上线(guards/specs/PIPE-GATE-BRIEF.md,round-14 spec 审查 HIGH-3/MEDIUM-6 修正版建造,
  # 建造途中又按 round-16 review-20260916T181348Z.md HIGH-1/HIGH-3/MEDIUM-1/MEDIUM-2 并入 5 处修正:
  # shadow/intervene 双模默认 shadow、拆 3 个 gate-id、pipefail 只豁免 exit-status-masked、posthoc-
  # partial-read 用同会话重定向关联分 candidate/recurrence、台账搬到 .claude/.local/pmm-recall/(已用
  # git check-ignore + git ls-files 双断言核实未跟踪))。PreToolUse matcher=Bash,报告闸,不拦不阻断。
  # 2026-09-17 v1→v2 换代(guards/specs/PIPE-GATE-V2-REPAIR-BRIEF.md §11.8 delivery ③):本体改
  # bash-pipe-exitcode-watch.cjs(Pre/Post/--self-test 同文件按 hook_event_name 分派,.sh 改薄包装),
  # 判定改用共用台账模块 pmm-recall-ledger.cjs;--self-test 现打印 SELFTEST {load,silence,positive,
  # header} 摘要行(见下一行),35 例的旧计数已随 v1 退役。
  run "bash-pipe-exitcode-watch v2 自证(load/header/五静默/一正例,经实际接线命令,SELFTEST 摘要行)" bash "$G/bash-pipe-exitcode-watch.sh" --self-test
  # 2026-09-16 M0 召回侧闭环两件(guards/specs/RECALL-LOOP-M-SPEC-v2.md M0,audits/CODEX-2026-09-16-
  # recall-M-spec-review.md HIGH-4/5/6、MEDIUM-1/2):零依赖命令解析库(跨 shell dialect + 保留字段
  # unsupported:keyword:* 绝不算 exe+ok,HIGH-6)、PreToolUse impression 观测钩子(matcher=Bash,纯观测,
  # 只写 ~/.claude/.local/pmm-recall/ 下的台账,零 stdout/stderr;每个 Bash 事件都记一行
  # event_kind=observed 供 M3 观察窗重建,event_id 与 impression_id 分离作真正幂等键)。两台均做过
  # synthetic mutation 验证(故意打破零输出/匹配断言一次,确认本行会翻红,再复原;证据见 M0 建造报告)。
  run "pmm-cmd-parse 自证(v1.2;13 例;跨 shell dialect + 保留字段 + 关键字块算法 + 重定向目标对象 + per-operand 展开 + !/array-assign/[[)" node "$G/pmm-cmd-parse.cjs" --self-test
  run "pmm-bash-impression 自证(59 例;v3 共用台账 + segment-index gate_instance_id + 端到端零输出锁 + repo 解析 + MEDIUM-6 policy mode/run_provenance + LOW-5 空白 root 一致性)" bash "$G/pmm-bash-impression.sh" --self-test
  run "pmm-recall-ledger 自证(35 例;COLUMNS/impressionId/eventId/ordinal/writeEvent/writeQueue/writeSessionEnd/resolveRoot 唯一解析器/LOW-K2-followup 写入边界拒收 sid_sha16 poisoned 值)" node "$G/pmm-recall-ledger.cjs" --self-test
  # pipe-gate-v2-acceptance.cjs 是预注册验收 runner(建造者不可改;specs/pipe-gate-v2-pins.json 钉四个
  # 手核 blob:契约/夹具/runner 本身/三变异体 mutants/null.cjs、mutants/always.cjs、mutants/blind-parser.cjs、
  # mutants/di-intervene.cjs)。--non-interactive --pins 全绿 = 119 例 + G01-G10 + G09(内嵌 always/null
  # 两轮 spy)+ 生产 --self-test;HOME/USERPROFILE 全指临时目录,从不碰真实 ~/.claude/.local/pmm-recall/
  # (G02 逐字节前后一致断言,--non-interactive 下强制 assert)。
  run "pipe-gate-v2 runner 全绿(--non-interactive --pins,含 G09 内嵌 always/null 轮)" bash -c "
    t=\$(mktemp -d)
    HOME=\"\$t\" USERPROFILE=\"\$t\" node \"$G/pipe-gate-v2-acceptance.cjs\" --non-interactive --pins \"$G/specs/pipe-gate-v2-pins.json\" >\"\$t/out.json\" 2>\"\$t/err.txt\"
    rc=\$?
    rm -rf \"\$t\"
    exit \$rc
  "
  # blind-parser 轮单独跑(不在 G09 覆盖范围内):status_refs/redirects/assignments/expansion_refs 清空,
  # parser_version 打 1.2-blind-<nonce> 因果哨兵;derived_fail_ids 与 actual_fail_ids 按名字集合相等。
  run "pipe-gate-v2 mutant blind-parser 全绿(mutants/blind-parser.cjs;sets_equal+probe_ok+sentinel_ok)" bash -c "
    t=\$(mktemp -d)
    HOME=\"\$t\" USERPROFILE=\"\$t\" node \"$G/pipe-gate-v2-acceptance.cjs\" --mutant blind-parser >\"\$t/out.json\" 2>\"\$t/err.txt\"
    rc=\$?
    rm -rf \"\$t\"
    exit \$rc
  "
  # 104 例解析器一致性夹具,经 runner 自己导出的 runParserConformance()对生产 pmm-cmd-parse.cjs 跑一遍
  # (与 runner 内部 G08 用的是同一条代码路径,不是另起一套断言)。独立文件而非内联 `node -e`:见该文件
  # 头部注释——POSIX 风格 $HOME(这台 Git Bash 的常态)嵌进 -e 的 JS 源字符串时不经 MSYS argv 翻译,
  # require() 会直接 MODULE_NOT_FOUND(2026-09-17 金丝雀首跑抓到,已用真实 $HOME 复现并改用此文件修复)。
  run "pmm-cmd-parse-conformance 104/104(经 runner 导出的 runParserConformance,对生产解析器)" node "$G/pmm-cmd-parse-conformance-check.cjs"
  run "pmm-recall-queue 自证(25 例;m0/v3 双适配器+分层抽样+畸形行硬化+LOW-K2 resolveRoot 收敛ledger+空白root)" node "$G/pmm-recall-queue.cjs" --self-test
  run "pmm-recall-label 自证(30 例;三值+undo 追加+rc0/1/2/3 全覆盖+LOW-K2 resolveRoot 收敛ledger+空白root)" node "$G/pmm-recall-label.cjs" --self-test
  # 2026-09-17 M-SPEC 附录 B1-B4(RECALL-LOOP-M-SPEC-v2.md):pmm-trigger-recall.cjs 改双写 v3 台账
  # (上方 pmm-trigger-recall 自证一行覆盖,17->22 例);pmm-recall-precision.cjs 加 --unlock(30->39 例,
  # 含 P05 的 24/30 拒绝 rc2 与 29/30 写 randomized 两例);新增 pmm-recall-baseline(B2 M2 描述统计)与
  # pmm-recall-m3(B3 M3 随机干预分析 + 会话层 bootstrap)两个新守卫。
  # 2026-09-17 codex 一波审 + Opus 复现 MEDIUM-6/MEDIUM-7:新增 pmm-recall-policy.cjs(唯一策略解析器,
  # assignment/resolve)与 pmm-recall-classify.cjs(共用 class_tag 回填 + (pre-class_tag)/(n/a) 分桶,
  # 从 baseline 抽出、precision 改用同一份);两个 eligible writer(pmm-trigger-recall.cjs、
  # pmm-bash-impression.cjs)接入 policy.resolve() 记真实臂;m3 自测新增「经真实两个 writer 生成样本」
  # 用例(11a-11e,含红→绿:writer 改回常量 intervene 时 11c 翻红,已手工验证并复原)。
  run "pmm-recall-policy 自证(16 例;唯一策略解析器 resolve/assignment,ENOENT=absent 其余读错=corrupt,resolveRoot 复用 ledger 导出+LOW-5 空白root)" node "$G/pmm-recall-policy.cjs" --self-test
  run "pmm-recall-classify 自证(13 例;共用 class_tag 回填 + (pre-class_tag)/(n/a) 分桶 + switchover)" node "$G/pmm-recall-classify.cjs" --self-test
  run "pmm-recall-precision 自证(54 例;Wilson+UNKNOWN字面量闸+--unlock --gate P05+MEDIUM-7 (n/a)/(pre-class_tag) 分桶+LOW-K2 resolveRoot 收敛ledger+空白root)" node "$G/pmm-recall-precision.cjs" --self-test
  run "pmm-recall-baseline 自证(39 例;M2 DESCRIPTIVE+主/次结局分列+读侧(pre-class_tag)/(n/a)分桶+switchover+LOW-K2 resolveRoot 收敛ledger+空白root)" node "$G/pmm-recall-baseline.cjs" --self-test
  run "pmm-recall-m3 自证(47 例;M3 单位+预注册样本量闸+主/次结局+MEDIUM-6真实writer样本红绿证据+LOW-H5未随机化单位排除+LOW-K2 resolveRoot 收敛ledger+空白root)" node "$G/pmm-recall-m3.cjs" --self-test
  # OSS open-core cut (2026-09-24): pmm-trigger-compat-replay.cjs (--self-test + --check rows)
  # and pmm-c0-canary-check.sh / pmm-core.sh / pmm-migrate-v3.sh (PMM v3 C0 shadow build) were
  # premium-tier — all moved out of the public repo, rows removed.
  # 2026-09-14 the maintainer 批 B(精简闸):冗余只数不判——R1/R2/R3 红 + 引用行/逃生口/重复用词 绿
  run "pmm-redundancy-lint 自证"    bash "$G/pmm-redundancy-lint.sh" --self-test
  # 2026-09-14 the maintainer「規則像橫幅一樣一直顯示」:横幅文件非空≤2KB,且 UserPromptSubmit 与 SessionStart 都接线
  run "铁律横幅在场(banner.md + 双钩子接线)" bash -c '
    [ -s "$PMM_HOME_RESOLVED/.claude/memory/banner.md" ] && [ "$(wc -c < "$PMM_HOME_RESOLVED/.claude/memory/banner.md" | tr -d " ")" -le 2560 ] &&
    [ "$(grep -c "pmm-banner.sh" "$PMM_HOME_RESOLVED/.claude/settings.json")" -ge 2 ] &&
    bash "$PMM_HOME_RESOLVED/.claude/pmm-banner.sh" | grep -q "铁律横幅"'
  # OSS open-core cut (2026-09-24): "教训分类覆盖 100%" relied on pmm-manifest.cjs (premium,
  # moved out of the public repo) — row removed.
  # 2026-09-14 fab 盲攻元层1(the maintainer 批 A):守卫代码指纹册——改守卫必须走 refresh+收据,否则红
  run "pmm-fingerprint 自证"       bash "$G/pmm-fingerprint.sh" --self-test
  run "守卫指纹册(无收据不许变)"    bash "$G/pmm-fingerprint.sh" check
  # 2026-09-14 the maintainer 批 C:盲攻纪律——当日守卫/闸提交 ≥3 次,必须有同日盲攻档才算收口
  run "盲攻纪律(守卫大改日须同日盲攻档)" bash -c '
    n=$(git -C "$PMM_HOME_RESOLVED" log --since=midnight --format=%h -- .claude/guards .claude/memory/_local-config 2>/dev/null | wc -l)
    [ "$n" -lt 3 ] && exit 0
    ls "$PMM_HOME_RESOLVED/.claude/guards/audits/AUDIT-$(date +%F)"*.md >/dev/null 2>&1'
  # 2026-09-16 上线(the maintainer 派活:插件缓存里夹带的「指挥 agent 行为」条件指令,只报不拦):
  # 上游插件仓库自带说明(如 plugins/cache/claude-community/pmm/2.7.0/CLAUDE.md)可能含
  # 「if/遇到 … run/执行 `command`」式的隐藏指令——Claude Code 本身不加载插件缓存里的
  # CLAUDE.md/SKILL.md,但任何"读全部文件"的通用代理都可能误读。缓存会被插件更新覆盖,
  # 不能靠改缓存文件本身消音;这台只做可见性(命中打印 + 与上次快照的新增/消失计数,
  # 快照见 ~/.claude/.local/plugin-scan-last.tsv,已 gitignore),生产模式退出码恒 0。
  # 名册项标 [report-only]:这里测的是探测逻辑本身没坏(真实缓存至少命中已知样本一次),
  # 不是"零命中才算过"——命中多是预期(PMM 自家 SKILL.md 里大量合法的「if X, run Y」用语)。
  run "plugin-cache-instruction-scan 自证 [report-only](依赖真缓存,非封闭)" bash "$G/plugin-cache-instruction-scan.sh" --self-test
  run "settings.json hooks 段与 _local-config 镜像一致(Opus 验收 HIGH-1:镜像漏接线 = 恢复后静默降级)" bash -c "diff <(node -e 'process.stdout.write(JSON.stringify(require(\"$PMM_HOME_WIN/.claude/settings.json\").hooks,null,1))') <(node -e 'process.stdout.write(JSON.stringify(require(\"$PMM_HOME_WIN/.claude/memory/_local-config/settings.json\").hooks,null,1))') >/dev/null"

  # ── PMM 写入闸:红(坏夹具必须拦)+ 绿(好夹具必须过),经 env override,不碰真记忆/真基线 ──
  local t; t=$(mktemp -d)
  case "$t" in /tmp/*|/var/*|"${TMPDIR:-/nonexistent}"*) : ;; *) echo "mktemp 异常路径 $t,拒绝继续"; exit 1;; esac
  # 2026-09-23(建造任务 CO,E7 假红修复):$t 自己的 JSON 转义 Windows 反斜杠形——与上面 PMM_HOME_WIN_JSON
  # 同一手法(cygpath -w → node JSON.stringify 去引号),派给 E7 用,取代此前误用 $PMM_HOME_WIN_JSON 的写法。
  local _t_backslash T_WIN_JSON
  _t_backslash="$(cygpath -w "$t" 2>/dev/null)"
  [ -n "$_t_backslash" ] || _t_backslash="$t"
  T_WIN_JSON="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]).slice(1,-1))' "$_t_backslash" 2>/dev/null)"
  [ -n "$T_WIN_JSON" ] || T_WIN_JSON="$_t_backslash"
  printf '## Index\n\n## Entries\n\n**2026-01-01 — bad** [a:b]\nbody\n' > "$t/lessons.md"
  run "pmm-write-integrity 红(奇偶不平必须拦)" \
    bash -c "PMM_MEM_DIR='$t' PMM_STATE_FILE='$t/state' bash '$PMM_HOME_RESOLVED/.claude/pmm-entry-length-watch.sh' --block; [ \$? -eq 2 ]"
  printf '## Index\n\n- 2026-01-01 [a:b] good\n\n## Entries\n\n**2026-01-01 — good** [a:b]\nbody\n' > "$t/lessons.md"
  run "pmm-write-integrity 绿(合规必须过)" \
    bash -c "PMM_MEM_DIR='$t' PMM_STATE_FILE='$t/state' bash '$PMM_HOME_RESOLVED/.claude/pmm-entry-length-watch.sh' --block"
  # E-sup 取代记账(2026-09-13 the maintainer「旧记忆被取代要当场标记」):声明 Supersedes 而旧条 Index 未标 → 拦
  run "pmm-write-integrity 取代记账(红拦绿放)"  bash "$G/pmm-supersede-fixture-test.sh"
  # E7(2026-09-14 自查):fast-path 必须认**生产形态**的 hook JSON——Windows 路径在 JSON 里是双反斜杠转义。
  # 09-13 起该形态被当"非记忆路径"零成本放行,整个写闸对 Edit 工具失效一天。夹具 JSON 逐字写在本文件里
  # (经 Bash 工具输入会被折半反斜杠,那正是盲攻与自审都漏掉它的原因)。红:记忆路径+坏夹具必须拦。
  # 2026-09-23(建造任务 CO,E7 假红修复,A2-尾建造者定位):A2 落地的权威 scope 判定
  # (core.isUnderCanonical(fp, process.argv[2]))第二参是 $MEM=$PMM_MEM_DIR(这里是 $t),不是
  # $HOME——此前 hook-mem.json 的 file_path 却建在**真**家目录下($PMM_HOME_WIN_JSON\.claude\memory\
  # lessons.md),与 PMM_MEM_DIR=$t 不同根,helper 如今正确判定"确实不在 canonical 内"(scope_rc=3)
  # → 提前 exit 0,五检函数体从未跑,红测断言的 rc=2 落空。A2 之前 scope helper 是死代码(`--` 参数
  # 错位导致 rc 恒为 2,不等于 3,从不触发提前退出),这个错配一直被死代码掩盖到今天才暴露。改法:
  # file_path 建在 $t 下(用上面新算的 T_WIN_JSON,与 PMM_MEM_DIR 同根),JSON 转义形式保留不变。
  printf '## Index\n\n## Entries\n\n**2026-01-01 — bad** [a:b]\nbody\n' > "$t/lessons.md"
  printf '%s' '{"session_id":"e7","hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"'"$T_WIN_JSON"'\\lessons.md","old_string":"a","new_string":"b"}}' > "$t/hook-mem.json"
  printf '%s' '{"session_id":"e7","hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"'"$T_WIN_JSON"'\\Desktop\\repo\\src\\index.ts","old_string":"a","new_string":"b"}}' > "$t/hook-other.json"
  run "pmm-write-integrity E7 红(JSON 转义的记忆路径必须全跑)" \
    bash -c "PMM_MEM_DIR='$t' PMM_STATE_FILE='$t/state' bash '$PMM_HOME_RESOLVED/.claude/pmm-entry-length-watch.sh' --block < '$t/hook-mem.json'; [ \$? -eq 2 ]"
  run "pmm-write-integrity E7 绿(非记忆路径零成本放行)" \
    bash -c "PMM_MEM_DIR='$t' PMM_STATE_FILE='$t/state' bash '$PMM_HOME_RESOLVED/.claude/pmm-entry-length-watch.sh' --block < '$t/hook-other.json'"
  # E7 对照(2026-09-23,建造任务 CO,spec 要求「加一条对照」):复用旧版 E7 红夹具原来的
  # file_path(真家目录下的 .claude\memory\lessons.md)—— basename 是 .md,会进 scope helper,
  # 但在本环境里 PMM_MEM_DIR=$t、canonical 根不是真家目录,所以它其实落在 canonical 范围**外**。
  # 权威判定必须给 scope_rc=3、提前 exit 0(正确跳过,不跑五检函数体)——这是设计内行为,不是缺陷,
  # rc=0 记为绿,证明「域外 .md 正确跳过」与上面 E7 红「域内 .md 必须全跑」是同一枚硬币的两面,
  # 不是同一断言误判两次。
  printf '%s' '{"session_id":"e7","hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"'"$PMM_HOME_WIN_JSON"'\\.claude\\memory\\lessons.md","old_string":"a","new_string":"b"}}' > "$t/hook-outofscope-md.json"
  run "pmm-write-integrity E7 对照(.md 但落在 PMM_MEM_DIR 范围外 → 正确跳过 rc=0,不算红)" \
    bash -c "PMM_MEM_DIR='$t' PMM_STATE_FILE='$t/state' bash '$PMM_HOME_RESOLVED/.claude/pmm-entry-length-watch.sh' --block < '$t/hook-outofscope-md.json'"
  # 提炼闸 I/Q(2026-09-14 the maintainer「給記憶設置一個提煉守衛」):基线 0 → 新增超长 Index 行 / 原话引用必拦
  echo 0 > "$t/state.idx"; echo 0 > "$t/state.quote"
  printf '## Index\n\n- 2026-01-01 [a:b] %s\n\n## Entries\n\n**2026-01-01 — good** [a:b]\nbody\n' "$(printf '很长的索引行%.0s' $(seq 1 30))" > "$t/lessons.md"
  run "pmm-write-integrity I 红(Index 行 >320B 必拦)" \
    bash -c "PMM_MEM_DIR='$t' PMM_STATE_FILE='$t/state' bash '$PMM_HOME_RESOLVED/.claude/pmm-entry-length-watch.sh' --block </dev/null; [ \$? -eq 2 ]"
  printf '## Index\n\n- 2026-01-01 [a:b] good\n\n## Entries\n\n**2026-01-01 — good** [a:b]\n<!-- attribution: the maintainer 2026-01-01 原话「这里是一段被逐字抄进来的用户原话」 -->\nbody\n' > "$t/lessons.md"
  run "pmm-write-integrity Q 红(attribution 引原话必拦)" \
    bash -c "PMM_MEM_DIR='$t' PMM_STATE_FILE='$t/state' bash '$PMM_HOME_RESOLVED/.claude/pmm-entry-length-watch.sh' --block </dev/null; [ \$? -eq 2 ]"
  rm -rf "$t"
  # 2026-09-23(A1-尾,codex#8/fab MEDIUM-4,A2 已落地 81c46b0):scope 预筛 + node scope-helper 的
  # 红绿探针独立起一个文件(避免和 A1 抢 guard-canary.sh 的写面,见该文件头注),两批都落地后由 A1
  # 这一笔把它的名册行补上——「造好没通电」的同一种病,建完的探针必须立刻入册才算数。
  # 2026-09-23(建造任务 CO,A2-尾 L-2 已落地 1a85373):该脚本现按「fail>0 → rc=1;fail=0 且
  # skip>0 → rc=2;全过 → rc=0」三态退出(见其自身头注 L-2 段)——rc=2 不再与「全绿」同码,但
  # run() 只看退出码非零就判红、把标准输出/错误全丢进 /dev/null(PMM lessons
  # process:guard-runner-discards-output-makes-reds-undiagnosable:闸的执行器丢弃输出,翻红就无法
  # 事后诊断);单独跑真实环境已验证六例全过、`skip=0`(见该收口批回报)。改判据:直接断言输出的
  # 摘要行是 `pass=N fail=0 skip=0`(N 恰为 6)且 rc=0——同时满足 spec 的「rc=2 视为红」(任何
  # skip>0 都不再满足这条 grep,run() 判红)与「断言输出 SKIP=0」两种写法要求的效果,而不是只信任
  # 裸退出码。同时把陈旧的「4 例」标签改成实际的六例(M-1 processes.md 与 L-5
  # MSYS_NO_PATHCONV=1 两例此前没同步进这行标签)。
  run "pmm-entry-length-watch-scope-test(6 例:①.claude\\.\\memory 别名 ②..逃逸 ③junction ④非 .md 零成本放行 ⑤M-1 processes.md ⑥L-5 MSYS_NO_PATHCONV=1;断言 pass=6 fail=0 skip=0)" bash -c "
    out=\$(bash '$G/pmm-entry-length-watch-scope-test.sh' 2>&1)
    rc=\$?
    printf '%s\n' \"\$out\" | grep -qE '^pmm-entry-length-watch-scope-test: pass=6 fail=0 skip=0\$' && [ \$rc -eq 0 ]
  "
  # 2026-09-23(建造任务C,codex 终审#9 附录A选项B,guards/audits/OPUS-2026-09-23-codex-final-triage.md
  # #9):Bash/PowerShell 直改活体 memory 此前只有 git commit 提交闸兜底——PostToolUse Bash|PowerShell
  # 内容变更校验,复用同一份 pmm-entry-length-watch.sh --block + pmm-trigger-write-gate.cjs 判断
  # 逻辑,report-only。自证 7 例(引导静默 + ①无变化 + ②非法追加报告 + ③合法追加不报告 +
  # ④PowerShell 同样触发 + ⑤tool_name=Edit 直接退出且不偷偷推进快照),临时 HOME,不碰真记忆。
  run "pmm-shell-memory-watch 自证(7例:引导静默/无变化/非法追加报告/合法追加不报告/PowerShell同样触发/Edit直接退出/Edit不推进快照)" bash "$G/pmm-shell-memory-watch.sh" --self-test

  # ── PMM commit 级闸(F 退役=移动 · G 备份漂移):自测在假 HOME 造仿真仓库跑红绿,不碰真记忆 ──
  run "pmm-precommit-gate 自测(F/G 各红各绿)" bash "$PMM_HOME_RESOLVED/.claude/pmm-precommit-gate.sh" --self-test

  # ── 工作流协议 kernel canary(size-watch 内嵌;输出含 pmm-kernel-canary = 协议掉出注入)──
  # 独立复核抓到的假绿(2026-08-05):第一版是 `! …size-watch | grep -q 标记`,
  # size-watch 自己死掉(改名/语法错/依赖缺失)时 grep 找不到标记 → 反而判过 ——
  # 「工具没跑起来」和「工具跑了且没发现异常」被判成同一结果,全绿建立在死检测器上。
  # 修法:先拿 size-watch 自己的退出码,rc≠0 直接 FAIL,再看输出里有没有坏标记。
  run "工作流协议在注入里(且检测器活着)" \
    bash -c "out=\$(bash '$PMM_HOME_RESOLVED/.claude/pmm-size-watch.sh' 2>&1); rc=\$?; [ \$rc -eq 0 ] && ! printf '%s' \"\$out\" | grep -q pmm-kernel-canary"

  # ── second-repo static/itest suite (opt-in via PMM_SECOND_REPO_DIR; silent PASS when unset — see
  #    the AX= comment above) ──
  run "dbpush-chain 守卫"         bash -c "[ -n '$AX' ] || exit 0; cd '$AX' && npm run -s itest:dbpush-chain"
  run "promo-field-parity 守卫"   bash -c "[ -n '$AX' ] || exit 0; cd '$AX' && npm run -s itest:promo-field-parity"

  # ── second-repo DB-touching itest (opt-in; silent PASS when PMM_SECOND_REPO_DIR unset) ──
  run "membership 竞态 itest(~40s,防已取消会员被复活)" bash -c "[ -n '$AX' ] || exit 0; cd '$AX' && npm run -s itest:membership-race"
  run "customer-merge itest(~13s,防姓名误合并)"        bash -c "[ -n '$AX' ] || exit 0; cd '$AX' && npm run -s itest:merge-customers"
  run "state-crossing 类级守卫"    bash -c "[ -n '$AX' ] || exit 0; cd '$AX' && npm run -s itest:state-crossing"
  run "config-divergence 类级守卫" bash -c "[ -n '$AX' ] || exit 0; cd '$AX' && npm run -s itest:config-divergence"

  # ── second-repo wiring canary (file present ≠ on the effective hook path; opt-in via
  #    PMM_SECOND_REPO_DIR, mirrors the home-repo wiring canary below)──
  # 2026-09-23(A1 批,codex#10 HIGH):原判据只看文件存在+可执行+文本里有个子串——`git config
  # core.hooksPath` 一劫持,或者 hook 内容退化成 `exit 0 # pmm-precommit-gate` 这种仍带子串的
  # 空转,原判据照样绿。改成行为验证(见 check_precommit_hook_wired_behaviorally 定义处的三点说明)。
  run "家仓 pre-commit 闸已接线(行为验证:git-path 未劫持+活体≡镜像 sha+端到端红绿)" check_precommit_hook_wired_behaviorally
  # 2026-09-23(A1 批,codex#10 HIGH 修复 spec 第二条):提交闸挡不挡得住 --no-verify/-n/core.hooksPath=
  # 绕过,最终还是取决于 permissions.deny 里有没有这几条——这条断言 settings.json 的 deny 集合
  # ⊇ 这个固定集合(字符串逐字核对自 settings.json 现有写法,不是凭印象猜的)。
  run "permissions.deny ⊇ 固定 no-verify/core.hooksPath 集合(codex#10)" bash -c "node -e '
    var need = [\"Bash(git commit*--no-verify*)\",\"Bash(git push*--no-verify*)\",\"Bash(git*--no-verify*)\",\"Bash(git commit*-n*)\",\"Bash(git*-c core.hooksPath=*)\"];
    var s = require(\"$PMM_HOME_WIN/.claude/settings.json\");
    var have = {};
    ((s.permissions && s.permissions.deny) || []).forEach(function(x){ have[x] = 1; });
    var missing = need.filter(function(x){ return !have[x]; });
    if (missing.length) { process.exit(1); }
  '"
  # 2026-09-17(M-7,[process:gitignored-config-needs-a-mirror-diff-canary]):settings.json 被
  # gitignore(活体不入库),_local-config 镜像是唯一可审记录——此前只有 *.sh/*.cjs 有活体≠镜像
  # 检查(pmm-precommit-gate.sh 的 G),settings.json 这类 .json 配置漏在外面,漂移无人报。
  run "settings.json 活体≡镜像"   bash -c "diff -q \"\$PMM_HOME_RESOLVED/.claude/settings.json\" \"\$PMM_HOME_RESOLVED/.claude/memory/_local-config/settings.json\" >/dev/null"
  run "pre-push 关卡已接线"       bash -c "[ -n '$AX' ] || exit 0; [ -x '$AX/.githooks/pre-push' ] && git -C '$AX' config core.hooksPath | grep -qi githooks"
  run "pre-commit 闸已接线"       bash -c "[ -n '$AX' ] || exit 0; [ -x '$AX/.githooks/pre-commit' ] && git -C '$AX' config core.hooksPath | grep -qi githooks"
  run "7 条路径规则在库且被跟踪"  bash -c "[ -n '$AX' ] || exit 0; [ \$(git -C '$AX' ls-files .claude/rules/lessons/ | wc -l) -ge 7 ]"

  # ── 环3 夜巡(codex-nightly)静默失效检测(2026-09-10 补,由本次事故直接催生)──
  # 事故:CodexNightlyAudit 计划任务连续 12 晚(2026-08-30..09-10)静默跳过——
  # 探针 cwd 被 Task Scheduler 落在 C:\Windows\System32(未配 "start in"),codex
  # 的 git-repo-trust 检查拒绝执行,两号连续 ERROR/ERROR;state.json 全程原地
  # 不动、cron.log 每晚都是"正常退出码 0",没有任何东西会响,只能翻 log 肉眼发现。
  # codex-nightly.sh 现在把"两号连续 ERROR(非 LIMITED)"计进 state.json 的
  # consecutive_probe_error_nights;这里做的是让"活性"本身进闸——
  # 红 = last_run_date 距今 >3 天 且 上一次记录的 skip 原因确实是 ERROR。
  # 只查 last_run_date 陈旧不够(正常按额度休息几天也会陈旧,不该报红);
  # 只查 cpen>=1 也不够(cpen 会在下一晚探针一旦恢复 OK 就自动清零,不该在
  # 已经自愈之后还报红)——两个条件同时成立才是"真的静默停摆了"。
  run "夜巡活性(环3 codex-nightly 未静默停摆)" bash -c '
    sf="$PMM_HOME_RESOLVED/.codex-nightly/state.json"
    if [ ! -f "$sf" ]; then echo "codex-nightly 从未安装/未跑过(onboarding 阶段):$sf 不存在"; exit 77; fi
    lr=$(grep -oE "\"last_run_date\":\"[0-9]{8}\"" "$sf" | grep -oE "[0-9]{8}")
    cpen=$(grep -oE "\"consecutive_probe_error_nights\":[0-9]+" "$sf" | grep -oE "[0-9]+")
    cpen=${cpen:-0}
    if [ -z "$lr" ]; then echo "state.json 缺 last_run_date 字段,无法判断活性"; exit 77; fi
    lr_epoch=$(date -u -d "${lr:0:4}-${lr:4:2}-${lr:6:2}" +%s 2>/dev/null) || { echo "last_run_date 日期格式无法解析:$lr"; exit 77; }
    now_epoch=$(date -u +%s)
    age_days=$(( (now_epoch - lr_epoch) / 86400 ))
    if [ "$age_days" -gt 3 ] && [ "$cpen" -ge 1 ]; then echo "last_run_date 距今 ${age_days} 天且 consecutive_probe_error_nights=${cpen} —— 夜巡疑似静默停摆"; exit 1; fi
    exit 0
  '

  # 2026-09-23(A1-尾,B1 5336b44 + B1-尾 1d4aaec 已落地:runner --self-check 现有 part1–16,part14
  # 默认跑、--home-only-ledger 已是 no-op):runner 自己的自检此前建好了却没人在名册里真的跑过它——
  # 「造好没通电」的同一种病。放在名册最后一行:约 1–2 分钟,比其余几乎所有检查都慢,排前面会拖慢
  # 日常快速失败的反馈。--self-check 的进程退出码就是 overall_ok 的布尔值(0=true/1=false,见该文件
  # `exitCode = sc.self_check.overall_ok ? 0 : 1`),不用另外解析 JSON。隔离 HOME/USERPROFILE,不设
  # 任何 PMM_*(与其余 pipe-gate-v2-acceptance.cjs 调用同一套隔离纪律)。
  run "pipe-gate-v2-acceptance --self-check(part1–16 全跑,overall_ok 即退出码)" bash -c "
    t=\$(mktemp -d)
    HOME=\"\$t\" USERPROFILE=\"\$t\" node \"$G/pipe-gate-v2-acceptance.cjs\" --self-check >\"\$t/out.json\" 2>\"\$t/err.txt\"
    rc=\$?
    rm -rf \"\$t\"
    exit \$rc
  "

  # 2026-09-23(C05-BUILD-SPEC 补遗二 §21):新闸自证,46 例契约 + 2 个仅自测生效的变异开关。
  run "pmm-isolation-gate 自证(46 例契约 + 2 变异)" bash -c "
    t=\$(mktemp -d)
    HOME=\"\$t\" USERPROFILE=\"\$t\" PMM_HOME=\"\$t\" node \"$G/pmm-isolation-gate.cjs\" --self-test --contract \"$G/specs/isolation-gate-contract.json\" >\"\$t/out.txt\" 2>\"\$t/err.txt\"
    rc=\$?
    tail -n1 \"\$t/out.txt\"
    rm -rf \"\$t\"
    exit \$rc
  "

  # 2026-09-24(收口者 C 段任务1,E-12/C05-BUILD-SPEC 补遗三第 31 条③:「金丝雀里逐个执行名册自测的
  # 行与 SELFTEST_STRUCTURE_ROSTER 按 basename 一一对应,行数 = 名册长度」)。收口者 A 段任务1 把这
  # 7 个文件登记进了 SELFTEST_STRUCTURE_ROSTER(见上方名册 2026-09-24 注释),但没有新增 run() 调用
  # ——静态结构名册检查(下方一行)只查源码里的 isoEnv/footprint/DUT-ENTRY 标记,从不实际执行。这 7
  # 行才是「真的跑一遍」的证据,不带 HOME/USERPROFILE/PMM_HOME 前缀(与 pmm-trigger-recall/
  # pmm-recall-m3 等既有真 HOME「自证」行同一写法),验证的正是 ambient 真 HOME 下自测本身仍能 rc=0
  # (而非只在被 HOME=$T 包裹的隔离环境里才绿)——每个文件内部仍用 selftest-iso.cjs 的 isoEnv() 给
  # 自己 spawn 的 DUT 子进程隔离,这层 ambient 调用不会写真根。
  run "bash-pipe-exitcode-watch.cjs 真 HOME 自证(E-12,与 :765 的 .sh 薄壳分列,basename 对应名册)" node "$G/bash-pipe-exitcode-watch.cjs" --self-test
  run "pmm-bash-impression.cjs 真 HOME 自证(E-12,与 :773 的 .sh 薄壳分列,basename 对应名册)" node "$G/pmm-bash-impression.cjs" --self-test
  # OSS open-core cut (2026-09-24): pmm-index-emit.cjs/pmm-shadow-compare.cjs/
  # pmm-precommit-shadow-replay.sh/pmm-search-v2.cjs/pmm-fault-matrix.cjs were premium-tier
  # components moved out of the public repo — their "真 HOME 自证" run() rows removed (EXPECTED
  # adjusted accordingly, see EXPECTED= below).

  # 2026-09-23(spec 22 的静态判据,落在这里因为 canary 文件只提交一次)。SELFTEST_STRUCTURE_ROSTER
  # 是本行的唯一入口:新增的自测若要用共用 selftest-iso.cjs 的隔离/零足迹机制,必须入这张表,否则
  # 只 report-only(spec 22:"名册外的守卫只 report-only,打印缺项计数")——本批 6 个成员全部入表。
  run "自测结构名册(spec 22 静态判据:isoEnv/footprint/DUT-ENTRY 标记/session 前缀)" check_selftest_structure_roster
  # OSS open-core cut (2026-09-24): check_c05_shadow_replay()'s "C0.5 影子" row exercised
  # pmm-shadow-replay.cjs (premium, moved out) — row and its function definition removed.
}

if [ "${1:-}" = "--self-test" ]; then
  echo "guard-canary 自证(喂必失败/必跳过/必报错项,runner 必须正确三态分类):"
  run "synthetic-must-fail" false
  run "synthetic-must-pass" true
  # spec 26 三态新增三项:表内 77→SKIP、表外 77→FAIL(防止 77 被当成随便放过的万能出口)、
  # rc 2→FAIL(改前 77 一律算 fail,所以"skip 单列"这条断言改前必红——这就是本项的红/绿证据)。
  run "synthetic-must-skip" bash -c "exit 77"
  run "synthetic-skip-not-allowlisted" bash -c "exit 77"
  run "synthetic-rc2-is-fail" bash -c "exit 2"
  printf "%b" "$report"
  if [ "$pass" -eq 1 ] && [ "$fail" -eq 3 ] && [ "$skip" -eq 1 ]; then
    echo "✅ 金丝雀 runner 三态分类正确(pass=1 fail=3 skip=1)"; exit 0
  else
    echo "✖ 金丝雀 runner 坏了:pass=$pass fail=$fail skip=$skip(期望 pass=1 fail=3 skip=1)"; exit 1
  fi
fi

# 2026-09-13 Opus 审计 P1:无期望数断言=名册被掏空照样"全绿"。新守卫入册必须同步改 EXPECTED。
# 2026-09-15 +2(HIGH-5 pmm-trigger-write-gate + MED-7 pmm-trigger-compat-replay,见上方名册新增两行)。
# 2026-09-15 round 2 +1(Opus O-4:pmm-trigger-compat-replay --check 此前不在名册上,现补一行)。
# 2026-09-16 +2(M0 召回侧闭环:pmm-cmd-parse 自证 + pmm-bash-impression 自证,见上方名册新增两行)。
# 2026-09-16 +3(M1 标注工具:pmm-recall-queue/label/precision 自证,见名册)。
# 2026-09-16 +1(插件缓存指令扫描 plugin-cache-instruction-scan,report-only,见上方名册新增一行)。
# 2026-09-17 +4(pipe-gate v2 换代 delivery ③:pmm-recall-ledger 自证 + runner --non-interactive --pins
# 全绿 + runner mutant blind-parser 全绿 + pmm-cmd-parse-conformance 104/104,见上方名册新增四行;
# bash-pipe-exitcode-watch/pmm-bash-impression 两行原地换代,不增行数)。
# 2026-09-17 +2(M-SPEC 附录 B1-B4:pmm-recall-baseline 自证 + pmm-recall-m3 自证两行新增;
# pmm-trigger-recall/pmm-recall-precision 两行原地换代——例数变了但仍各一行,不增行数)。
# 2026-09-17 +2(trigger 写时闸新增「在场性」检查:pmm-trigger-presence 红/绿两行新增,见上方
# 「pmm-trigger-write-gate 自证」行紧随其后;自证本身的 20→25 例是同一行原地换代,不增行数)。
# 2026-09-17 +2(codex 一波审 + Opus 复现 MEDIUM-6/MEDIUM-7:pmm-recall-policy 自证 + pmm-recall-classify
# 自证两行新增;pmm-trigger-recall/pmm-bash-impression/pmm-recall-baseline/pmm-recall-m3/
# pmm-recall-precision 五行原地换代——例数变了但仍各一行,不增行数)。
# 2026-09-17 +0(Opus 增量核 LOW-K2:读侧五工具 pmm-recall-baseline/label/m3/precision/queue 的
# resolveRoot() 收敛为 pmm-recall-ledger.cjs 导出的唯一实现,不再各带一份 PMM_RECALL_ROOT=' ' 时
# 会返回字面量空白目录的旧写法;五行原地换代(22→25/26→30/44→47/51→54/36→39),不增行数)。
# 2026-09-17 +1(LOW-K2-followup,coordinator 发现真实台账被 pmm-trigger-recall.sh 自测反复污染
# 572 行:根因已修——该 .sh 自测 12 处调用补齐 PMM_RECALL_ROOT 隔离;新增「pmm-recall-ledger 未
# 重新污染(基线 572)」一行读真实台账做哨兵,见上方 check_recall_ledger_not_recontaminated();
# 读侧五工具 baseline/label/m3/precision/queue 五行原地换代(id_missing/blank-sid 排除 +
# excluded_contaminated 字段,39→44/30→33/47→52/54→59/25→30),不增行数;pmm-recall-ledger 自证
# 一行原地换代(27→35,写入边界拒收 sid_sha16 为字面量 "undefined"/"null" 的行)。)
# 2026-09-17 +2(M-6a:「trigger-log 旧位置未重新污染(基线 298)」一行新增,见上方
# check_trigger_log_legacy_not_recontaminated();「pmm-recall-ledger 未重新污染」基线原地
# 572→574,不增行数)。M-2:「真根三件套首尾对账」一行新增,见下方 check_real_roots_only_
# grew_by_real_activity() 手动记分(不走 run(),手法同 ax_freshen)。
# 2026-09-17 +1(M-7,[process:gitignored-config-needs-a-mirror-diff-canary]:「settings.json
# 活体≡镜像」一行新增——被 gitignore 的活配置此前没有镜像 diff 金丝雀,漂移无人报)。
# 2026-09-23 +1(A1 批,codex#10 + fab-delta triage §10:「家仓 pre-commit 闸已接线」一行原地换代
# 为行为验证,不增行数;新增「permissions.deny ⊇ 固定 no-verify/core.hooksPath 集合」一行——此前
# 提交闸的接线检查只认文件存在+子串,没人断言 --no-verify/-n/core.hooksPath= 这几条真被 deny 挡住)。
# 2026-09-23 +2(A1 批,补充事实:A4 已落地 1ae6437):roster() 里新增「pmm-home-split-probe」一行
# (A4 建的六项行为探针,此前没入册);main 流程新增「PMM_HOME_RESOLVED_VIA 首行红灯」一项手动记分
# (不走 run(),手法同 M-2/ax_freshen——见下方 snapshot_real_roots 之前那几行)。
# 2026-09-23 +2(A1-尾,前置 A2 81c46b0 + B1/B1-尾 5336b44/1d4aaec 均已落地):roster() 里新增
# 「pmm-entry-length-watch-scope-test」(A2 建的独立探针文件,此前没入册)与
# 「pipe-gate-v2-acceptance --self-check」(runner 自己的自检,part1–16,此前也没入册)两行。
# 2026-09-23 +1(建造任务C,codex 终审#9 附录A选项B):roster() 里新增「pmm-shell-memory-watch 自证」
# 一行——新建的 PostToolUse Bash|PowerShell 内容变更校验闸(report-only),见该行紧邻的注释。
# 2026-09-23 +1(建造任务 CO,E7 假红修复):roster() 里新增「pmm-write-integrity E7 对照」一行——
# .md 但落在 PMM_MEM_DIR 范围外必须正确跳过(rc=0)的对照用例,紧随 E7 红/绿两行之后;
# 「pmm-entry-length-watch-scope-test」一行原地换代为断言 `pass=6 fail=0 skip=0`(A2-尾 SKIP=rc2
# 语义落地后的判据修法),不增行数。
# 2026-09-23/24(C05-BUILD-SPEC 补遗二,A 闸批 22→21→26,建造者 A 收口的这一笔;spec 26 EXPECTED
# 算术:「开工时 HEAD 值(70)+ 3」,+3 = 21 自证(「pmm-isolation-gate 自证」一行新增)+ 22 名册行
# (「自测结构名册」一行新增)+ ax_freshen 独立成行(此前只在失败时手动 fail++、成功时不计入
# pass+fail 总数的那半行,现改走 run() 统一计一次,变成一条完整的「已执行行」)。B 批的 C0.5 影子行
# +1 由收口者另加,不在这一笔里(A 是 guard-canary.sh 在本批的唯一写者,不代表 A 决定 B 的那一行)。
# 2026-09-24(C0.5 第二波收口者 A 段,任务3,补遗二第 9 条「C0.5 影子行由 B 批另外 +1」的这一笔):
# 73+1=74。任务1(名册登记 7 个新文件)与任务2(M-2 扩到 .shadow/.pmm-index-lkg)都是扩充既有一行的
# 判据/输入,不新增 run() 调用,不占 EXPECTED;只有本任务新增的「C0.5 影子」这一行 run() 调用 +1。
# 2026-09-24(收口者 C 段任务1,E-12/补遗三第 31 条③):74+7=81。补齐 A 段任务1 登记进
# SELFTEST_STRUCTURE_ROSTER 却一直没有对应 run() 调用的 7 个文件(bash-pipe-exitcode-watch.cjs/
# pmm-bash-impression.cjs/pmm-index-emit.cjs/pmm-shadow-compare.cjs/pmm-precommit-shadow-replay.sh/
# pmm-search-v2.cjs/pmm-fault-matrix.cjs)各一行真 HOME 自证,见上方「自测结构名册」之前的新增块;
# 名册剩余 6 个成员(pmm-trigger-recall.sh/pmm-trigger-compat-replay.cjs/pmm-recall-m3.cjs/
# pmm-isolation-gate.cjs/pmm-shadow-replay.cjs/pmm-hook.cjs 镜像)已各自有既有 run() 行覆盖(其中
# pmm-isolation-gate.cjs 现有一行是隔离态契约自证、pmm-hook.cjs 镜像走 sha256 cmp 而非 --self-test,
# 两者性质与「真 HOME 自证」不同,本任务不重复新增)。
# OSS open-core cut (2026-09-24): 81-11=70 — 11 run() rows removed for premium components moved
# out of the public repo (pmm-manifest.sh, pmm-trigger-compat-replay.cjs x2 rows, pmm-c0-canary-
# check.sh, pmm-manifest.cjs 教训分类覆盖, pmm-index-emit.cjs, pmm-shadow-compare.cjs,
# pmm-precommit-shadow-replay.sh, pmm-search-v2.cjs, pmm-fault-matrix.cjs, check_c05_shadow_replay
# [pmm-shadow-replay.cjs]). Not independently re-run against a live ~/.claude install (this file
# targets the live installed environment via $PMM_HOME_RESOLVED and is outside bin/axmem
# selftest's own scope per its "guards/ and hooks/ deliberately excluded" comment) — arithmetic
# only, verify against a real install before relying on this count.
EXPECTED=70

echo "guard-canary $(date +%F):"
# 2026-09-23(A1 批,补充事实:A4 已落地 1ae6437「导出 PMM_HOME_RESOLVED_VIA」):金丝雀自己在
# 文件头 source pmm-home.sh 时就已经解析过一次自己的家目录——这里首行就断言那次解析没有静默
# 走回落分支(fallback 只应该在 node 缺失时发生,见 pmm-home.sh 头注)。放在最前面,一盏红灯,
# 不与下面任何一台具体守卫的判断混在一起。
executed=$((executed+1))
if [ "${PMM_HOME_RESOLVED_VIA:-}" = "fallback" ]; then
  fail=$((fail+1))
  report="${report}  ✖ PMM_HOME_RESOLVED_VIA=fallback ——金丝雀自己的家目录解析都在走回落分支(正常只应在 node 缺失时发生),下面全部读 \$PMM_HOME_RESOLVED 的检查这次跑的可能不是预期的家目录,先查 node 在不在 PATH 里\n"
else
  pass=$((pass+1))
  report="${report}  ✔ PMM_HOME_RESOLVED_VIA=${PMM_HOME_RESOLVED_VIA:-<未设置>}(未回落)\n"
fi
snapshot_real_roots
run "second-repo canary 树已 ff 到 origin/main(ax_freshen;PMM_SECOND_REPO_DIR 未设时 no-op)" ax_freshen
roster
executed=$((executed+1))
if check_real_roots_only_grew_by_real_activity; then
  pass=$((pass+1)); report="${report}  ✔ 真根三件套首尾对账(M-2)\n"
else
  fail=$((fail+1)); report="${report}  ✖ 真根三件套首尾对账(M-2):${_m2_detail} —— 新增内容不像真会话,查是不是本轮自测又漏隔离了\n"
fi
# spec 26:判据改为「已执行行数」== EXPECTED(run() 每跑一行 +1,VIA/M-2 手动计分两行也各 +1 过),
# 取代原来的 pass+fail(那个口径下 ax_freshen 失败时会多算一次,一件事报两次红)。这条计数检查本身
# 出错时按 FAIL 计(不占用 executed,只占 fail),与原逻辑一致。
if [ "$executed" -ne "$EXPECTED" ]; then
  fail=$((fail+1)); report="${report}  ✖ 名册计数 executed=${executed} ≠ EXPECTED=${EXPECTED} —— 守卫被摘或忘改 EXPECTED\n"
fi
printf "%b" "$report"
echo "guard-canary: pass=${pass} fail=${fail} skip=${skip} expected=${EXPECTED}"
if [ "$fail" -gt 0 ]; then
  echo "✖ ${fail} 台守卫失效 —— 修好前 stamp 不更新,autopull 的灯会一直亮。"
  exit 1
fi
# ── B1(2026-08-20,v3 方案):R_gated 一行报——不是闸,是仪表。
# 定义在 guards/BASELINE-2026-08-19.md:R_gated=已建闸教训的重演次数,必须与「未分类数」同示
# (漏填对应规则列就能把指标做成零——codex 终审点名的可操纵性)。数据源=recall-timing-misses.md
# 观察期表。精确 tag 匹配 + 日期运算,无语义判断;行为=纯打印,绝不影响退出码。
MISS="$PMM_HOME_RESOLVED/.claude/memory/dreams/recall-timing-misses.md"
if [ -f "$MISS" ]; then
  _obsrows=$(awk '/## 观察期记录/{f=1;next} /^## /{f=0} f&&/^\| 20/' "$MISS")
  _rows=$(printf '%s' "$_obsrows" | grep -c . || true)
  _esc=$(printf '%s' "$_obsrows" | grep -c '已逃逸' || true)
  _uncls=$(printf '%s' "$_obsrows" | grep -c '待定' || true)
  _gated=0
  while IFS= read -r _tag; do
    [ -z "$_tag" ] && continue
    if grep -A3 "\[$_tag\]" "$PMM_HOME_RESOLVED/.claude/memory/lessons.md" 2>/dev/null | grep -qE 'channel:[[:space:]]*(test|ci|rule|permission)'; then
      _gated=$((_gated+1))
    fi
  done < <(printf '%s' "$_obsrows" | grep -oE '\[[a-z0-9:._-]+\]' | tr -d '[]' | sort -u)
  echo "R_gated 观察(as-of $(date +%F)):观察期 ${_rows} 行 · 已逃逸 ${_esc} · 命中已建闸教训 ${_gated} · 未分类 ${_uncls}"
  [ "$_gated" -gt 0 ] && echo "⚠️ R_gated 违约 >0:已建闸的错误又发生了 = 闸的 bug —— 修闸,不写教训(BASELINE 判据 1)。"
fi

# ── M-6a session-end 活性灯(2026-09-17,report-only,不影响退出码)──────────────
# settings.json 接了 `pmm-recall-ledger.cjs --session-end`(见 hook-manifest.txt 本轮补的第 5 台),
# 但从没有任何东西确认它真的写过 kind=session-end 行——「造好没通电」的同一种病(O-5 named
# 的那个类)。只报,不判红:大量真实会话此刻可能都还没触发过 SessionEnd(比如都还开着),这不是缺陷。
if [ -f "$_m2_ledger" ]; then
  if awk -F'\t' 'NR>1 && $10=="session-end" {f=1; exit} END{exit !f}' "$_m2_ledger"; then
    echo "🟢 session-end 活性灯:真台账里已出现 kind=session-end 行(钩子确认真的写过)"
  else
    echo "🟡 session-end 活性灯:真台账里还没见过 kind=session-end 行(report-only,可能只是还没有会话真正结束过)"
  fi
fi

# ── M-6a C:\tmp 自测残留卫生灯(2026-09-17,report-only,不影响退出码)──────────────
# coordinator 核实:C:\tmp 下的 bash-pipe-exitcode-watch-selftest.* 是闸自身自测的遗留,清理归
# 闸建造者管,这里只负责让"攒了多少"这件事可见——不清、不判红,纯计数。
_tmphygiene_n=$(ls /c/tmp/bash-pipe-exitcode-watch-selftest.* 2>/dev/null | grep -c . || true)
[ "${_tmphygiene_n:-0}" -gt 0 ] && echo "🟡 C:\\tmp 自测残留卫生灯:bash-pipe-exitcode-watch-selftest.* 共 ${_tmphygiene_n} 个(闸自身自测遗留,report-only,清理归闸建造者)"

# spec 26:stamp 只在 fail=0 时写(已在上面 fail>0 分支 exit 1,不会跑到这里);skip>0 时不用
# "N/N 全绿"这种措辞(pass/pass 在有 SKIP 时是误导性的 100% 覆盖假象),改成显式带 skip 数的句子。
# stamp 文件本身的格式(单行日期)不变——pmm-autopull.sh 用 `date -d "$(cat "$_cs")"` 直接解析整份
# 文件内容,追加第二行会喂给 date -d 一段它解析不了的多行文本,把新鲜度灯变成假红(实测优先修正);
# 把 skip 计数写进 stamp 供 autopull 的灯显示「S 台跳过」列入 backlog,不在本批写面内。
date +%F > "$STAMP"
if [ "$skip" -gt 0 ]; then
  echo "✅ pass=${pass} fail=0 skip=${skip},stamp 已更新 → $STAMP"
else
  echo "✅ ${pass}/${pass} 全绿,stamp 已更新 → $STAMP"
fi
