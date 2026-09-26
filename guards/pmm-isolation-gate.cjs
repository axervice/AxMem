#!/usr/bin/env node
// pmm-isolation-gate.cjs — PreToolUse Bash isolation gate (C05-BUILD-SPEC 补遗三 第27条 v1.3 判据,
// 借用来源段 2026-09-24 重写:shell 解析层换成 vendor 的 unbash——guards/vendor/unbash/parser.js,一棵带
// 源码位置的真 AST(heredoc 正文/命令替换/进程替换/source 参数/包装命令透传的参数都是可遍历节点,不再是
// 手写 pmm-cmd-parse.cjs 的启发式 token 流)。pmm-cmd-parse.cjs 仍在(bash-pipe-exitcode-watch.cjs 等其他
// 消费者用),但本闸不再 require 它、不再依赖它的 segment 编号(契约 v1.5:denied_segments/reason_code 降为
// 信息项,只判 decision + denial_rows,commit f5ccd984、blob 89e607eb208dddd3e74e686b17f8c55de84a2721)。
//
// Deterministic, fail-open ON THE GATE'S OWN INTERNAL FAULTS ONLY (production entry: uncaught exception
// in main() -> rc 1, settings.json's own `|| exit 0` fallback is what makes an internal-fault case
// visible-as-allow at the wired-entry level — this file itself never swallows its own exceptions into a
// synthetic allow). DUT-invocation judgment is fail-CLOSED end to end: a parse throw, a parse producing
// unbash's own `.errors` (including its built-in MAX_SYNTAX_NESTING=256 command-substitution-depth cap),
// or this file's own defense-in-depth walk-depth guard all resolve to `deny` (reason_code `parse-error` /
// `nesting-too-deep`), never to the old v1.0-v1.2 "catch { return allow }" shape.
//
// Judgment model (借用来源段): parse the whole command with unbash once; walk EVERY node reachable from
// it (top-level statements, pipeline/AndOr stages, if/for/while/case/function/subshell/brace-group/
// select/coproc bodies, and — critically — every nested command-substitution/process-substitution/
// arithmetic-command-expansion `.script` found inside any Word, at any depth) looking for `Command`
// nodes (POSIX "simple commands"). For each Command found: does ANY text it owns — its own exe name,
// every prefix-assignment VALUE, every suffix operand, every redirect target, every heredoc body — carry
// a DUT (a guard script) path or basename after N-normalization? If so, AND that Command's own
// prefix-assignments don't carry a complete HOME=USERPROFILE=PMM_HOME redirect away from the real home,
// it denies. `NON_EXEC_EXE` (read-only tools: cat/grep/sed/etc, sed's own -e script argument excepted),
// ALLOW_ANY/ALLOW_PROD (token exemption, rule a/b only — i.e. only when the exempted name IS the exe
// itself or the interpreter's own script operand, never an incidental mention elsewhere in the same
// command), git's restricted -c-key/subcommand scan (a git commit message merely MENTIONING a guard name
// is not scanned — A13/A28/A29/A36 must stay allow), and the E-7 `:`-anchored家目录拼写表(isHomeRelativeRef,
// below)全部原样保留. Control-structure OWN fields with no assignment-prefix syntax to attach a redirect
// to (a `for`'s wordlist, a `case`'s word/patterns, a `select`'s wordlist) always deny on a hit — there is
// no supported way to redirect them (see ALT_WRITE below), matching A22's precedent.
//
// See specs/isolation-gate-contract.json v1.5 (162 cases + 2 mutants; scoring_v1_5: decision + denial_rows
// only, denied_segments/reason_code informational — segment numbering was an artifact of the retired
// hand-written splitter and the AST engine numbers control structures as single nodes, coordinator ruling
// 2026-09-24) for the full case-by-case behavior this file is built against.
//
// KNOWN-GAP (spec 头注, unchanged): PowerShell tool out of scope (no PreToolUse matcher for it in
// settings.json); indirect invocation (a script that itself calls a guard) is invisible to a
// command-string parser; deliberate variable-based bypass is not defended against (same posture as
// review-stamp.sh) — pinned as report_only case R01 (V06 shape: `node $DUTPATH`, variable value from
// outside the command).
'use strict';
// vendor/unbash's dist/*.js files are ESM without a package.json "type" field (see VENDOR.md — adding
// one to guards/vendor/unbash/ was blocked by the harness's own self-modification guard when this file
// was built; a bare require() of an extensionless-ESM file makes Node print a
// MODULE_TYPELESS_PACKAGE_JSON warning to STDERR on every fresh process, which would break every allow
// case's "stdout 0 bytes AND stderr 0 bytes" contract requirement). Strip all 'warning' listeners before
// the require() below triggers it — standard Node suppression, touches no vendor file, no file rename.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const { parse: unbashParse } = require('./vendor/unbash/parser.js');
const ledger = require('./pmm-recall-ledger.cjs');
// 2026-09-24 open-core cut: this gate only ever used two pure Win32 filename-safety helpers off of
// guards/pmm-core.cjs (the causal shadow-memory engine, moved to AxMem Pro) — extracted verbatim into
// guards/pmm-win32-path-safety.cjs so this gate stays fully self-contained in the open-core repo.
const { stripWin32AdsSuffix, stripWin32TrailingDotSpace } = require('./pmm-win32-path-safety.cjs');

// realHome() — never from HOME/USERPROFILE/PMM_HOME; this file lives at <realHome>/.claude/guards/.
function realHome() {
  return path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
}

const REAL_HOME = realHome();

// ---------------------------------------------------------------------------------------------
// DUT set: basename(<realHome>/.claude/guards/*.cjs|*.sh) UNION basename(every hook-manifest.txt
// entry), listed at RUN TIME (never a hardcoded list), compared lowercase.
// ---------------------------------------------------------------------------------------------
function computeDutSet(home) {
  const set = new Set();
  const guardsDir = path.join(home, '.claude', 'guards');
  let names = [];
  try { names = fs.readdirSync(guardsDir); } catch { names = []; }
  for (const n of names) {
    if (/\.(cjs|sh)$/i.test(n)) set.add(n.toLowerCase());
  }
  const manifestPath = path.join(home, '.claude', 'memory', '_local-config', 'hook-manifest.txt');
  let text = '';
  try { text = fs.readFileSync(manifestPath, 'utf8'); } catch { text = ''; }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const base = path.basename(line).toLowerCase();
    if (base) set.add(base);
  }
  return set;
}

// allow_any / allow_prod — source-level constants (contract conventions.allow_any/allow_prod,
// verbatim). Changing this list is a fingerprint-tracked edit and must be mirrored in the contract AND
// in C05-BUILD-SPEC.md 第21条 (three-way sync, spec item 27 "ALLOW_PROD" bullet).
const ALLOW_ANY = new Set(['guard-canary.sh', 'pipe-gate-v2-acceptance.cjs']);
const ALLOW_PROD = new Set([
  'pmm-recall-label.cjs', 'pmm-recall-precision.cjs', 'pmm-recall-queue.cjs', 'pmm-recall-baseline.cjs',
  'pmm-recall-m3.cjs', 'pmm-recall-classify.cjs',
  'pmm-fingerprint.sh', 'review-stamp.sh', 'review-gate.sh', 'lesson-channel-lint.sh', 'pmm-c0-canary-check.sh',
  'pmm-core.sh', 'pmm-core.cjs', 'pmm-manifest.cjs', 'pmm-manifest.sh', 'pmm-manifest-v2.cjs',
  'pmm-manifest-shadow.sh', 'pmm-manifest-shadow.cjs', 'pmm-migrate-v3.cjs', 'pmm-migrate-v3.sh',
  'pmm-trigger-compat-replay.cjs',
  'pmm-size-watch.sh',
  // pmm-autopull.sh intentionally NOT a member (v1.3, C05-BUILD-SPEC.md 补遗三 第27条 "ALLOW_PROD" bullet):
  // its bare SessionStart invocation runs `git pull --ff-only` against the real root unconditionally, no
  // sub-command gate, so it fails the "无参数 + 空 stdin 运行,前后 $T 全树 sha 不变" admission proof every
  // other member here must pass. It still runs as a SessionStart hook (never through this Bash gate).
  'pmm-shadow-compare.cjs', 'pmm-shadow-replay.cjs', 'pmm-precommit-shadow-replay.sh',
  'pmm-index-emit.sh', 'pmm-search-v2.sh', 'pmm-search-v2.cjs',
  'pmm-receipt.sh', 'pmm-search.sh', 'pmm-grep.sh', 'pmm-recall.sh', 'pmm-pointer-lint.sh', 'pmm-redundancy-lint.sh',
  'pmm-banner.sh', 'hermes-memory-freshness.sh', 'pmm-canary.sh',
]);
const SELFTEST_TOKENS = new Set(['--self-test', '--self-check', '--selftest']);

const AMBIENT_VARS = ['PMM_RECALL_ROOT', 'PMM_TRIGGER_MEM', 'PMM_TRIGGER_STATE', 'PMM_TRIGGER_LOG', 'PMM_MEM_DIR'];
const HOME_TRIO = ['HOME', 'USERPROFILE', 'PMM_HOME'];

// ---------------------------------------------------------------------------------------------
// v1.3 closed sets (C05-BUILD-SPEC.md 补遗三 第27条; 主脑裁决 2026-09-24: NON_EXEC_EXE 闭集 = spec 审
// 报告第72行名单定稿). Unchanged by the AST rewrite — a generic node walk still needs an exemption list
// for genuinely read-only tools (`cat <DUT>` alone must stay allow), and git's own -c-key/subcommand
// closed set (a git commit message merely mentioning a guard name must stay allow — A13/A28/A29/A36).
// ---------------------------------------------------------------------------------------------
const NON_EXEC_EXE = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'wc', 'ls', 'stat', 'file',
  'diff', 'cmp', 'comm', 'sha256sum', 'sha1sum', 'md5sum', 'cksum', 'sort', 'uniq', 'cut', 'tr', 'basename',
  'dirname', 'realpath', 'readlink', 'echo', 'printf', 'test', '[', 'jq', 'cp', 'mv', 'rm', 'mkdir', 'touch',
  'chmod', 'ln', 'base64', 'xxd', 'od', 'cd', 'pwd', 'true', 'false',
]);
const SOURCE_LIB_OK = new Set(['pmm-home.sh', 'selftest-iso.sh']);
const GIT_C_KEYS_LITERAL = new Set([
  'core.editor', 'core.pager', 'core.sshcommand', 'core.fsmonitor', 'core.hookspath', 'sequence.editor',
  'diff.external', 'credential.helper', 'gpg.program',
]);
const GIT_RISKY_SUBCOMMANDS = new Set(['rebase', 'bisect', 'submodule', 'filter-branch', 'difftool']);
const NODE_STDIN_SHAPES = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);
const INTERPRETER_EXES = new Set(['node', 'bash', 'sh', 'zsh', 'dash']);
const VALUE_TAKING_BASH_FLAGS = new Set(['-o', '-O']);
// Env-var names whose VALUE controls what a later process executes (git/editor/pager hooks, node's
// require-on-boot). A general per-Word scan already finds any DUT reference inside an assignment's own
// VALUE regardless of name (A23's `n=$(grep -c TODO <DUT>)` denies via the same general scan on the
// bare-assignment Command's own prefix, not a name-gated check) — this set is not consulted by the new
// engine (kept only as a comment pointer to the old v1.3 FRONT_ASSIGN_NAMES set it superseded).

function gitCKeyMatches(key, value) {
  const k = String(key).toLowerCase();
  if (/^alias\..+$/.test(k)) return String(value).trimStart().indexOf('!') === 0;
  if (GIT_C_KEYS_LITERAL.has(k)) return true;
  if (/^diff\.[^.]+\.(textconv|command)$/.test(k)) return true;
  if (/^merge\.[^.]+\.driver$/.test(k)) return true;
  if (/^filter\.[^.]+\.(clean|smudge|process)$/.test(k)) return true;
  return false;
}
function gitSubcommandTriggersScan(sub, argsDecoded) {
  if (!GIT_RISKY_SUBCOMMANDS.has(sub)) return false;
  if (sub === 'rebase') return argsDecoded.some((a) => a === '-x' || a === '--exec');
  if (sub === 'bisect') return argsDecoded.includes('run');
  if (sub === 'submodule') return argsDecoded.includes('foreach');
  if (sub === 'filter-branch') return argsDecoded.some((a) => /^--.*-filter$/.test(String(a)));
  if (sub === 'difftool') return argsDecoded.some((a) => a === '-x' || a === '--extcmd');
  return false;
}

// ---------------------------------------------------------------------------------------------
// N normalization + findHit (C05-BUILD-SPEC.md 补遗三 第27条 "归一 N") — UNCHANGED by the AST rewrite.
// These operate on plain text strings regardless of which parser produced them; the only thing the
// rewrite changes is WHERE the text comes from (unbash Word.text instead of pmm-cmd-parse.cjs
// arg.decoded). ① lowercase ② $'...' ANSI-C decode ③ quote/backslash-aware strip (single-quoted spans
// keep backslashes literal per POSIX) ④ $(...)/`...`/${...}/$NAME -> placeholder '*' ⑤ brace expansion
// (per-token, capped at 64 combined candidates; overflow counts as a hit) ⑥ basename trailing dot/space
// + :stream suffix strip (core.stripWin32TrailingDotSpace/stripWin32AdsSuffix).
// ---------------------------------------------------------------------------------------------
function decodeAnsiCEscapes(inner) {
  return String(inner)
    .replace(/\\x([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-7]{1,3})/g, (m, o) => String.fromCharCode(parseInt(o, 8) & 0xff))
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\').replace(/\\'/g, "'");
}
function applyAnsiCQuotes(text) {
  const s = String(text);
  let out = ''; let i = 0;
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === "'") {
      let j = i + 2; let inner = '';
      while (j < s.length && !(s[j] === "'" && s[j - 1] !== '\\')) { inner += s[j]; j++; }
      out += decodeAnsiCEscapes(inner);
      i = j + 1;
      continue;
    }
    out += s[i]; i++;
  }
  return out;
}
function stripQuotesAndEscapes(text, preQuotedSingle) {
  const s = String(text);
  let out = ''; let state = preQuotedSingle ? 'single' : 'none'; // 'none' | 'single' | 'double'
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (state === 'single') {
      if (ch === "'") { state = 'none'; continue; }
      out += ch;
      continue;
    }
    if (ch === "'") { state = 'single'; continue; }
    if (ch === '"') { state = (state === 'double') ? 'none' : 'double'; continue; }
    if (ch === '\\') {
      if (i + 1 < s.length) { out += s[i + 1]; i++; }
      continue;
    }
    out += ch;
  }
  return out;
}
function findSubstitutionSpans(text) {
  const spans = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '(') {
      let depth = 1; let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') depth--;
        j++;
      }
      spans.push([i, j]);
      i = j - 1;
    }
  }
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') {
      if (start === -1) start = i; else { spans.push([start, i + 1]); start = -1; }
    }
  }
  return spans;
}
function placeholderizeSubstitutions(text) {
  let s = String(text);
  const spans = findSubstitutionSpans(s);
  for (let k = spans.length - 1; k >= 0; k--) {
    const [a, b] = spans[k];
    s = s.slice(0, a) + '*' + s.slice(b);
  }
  s = s.replace(/\$\{[^}]*\}/g, '*');
  s = s.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '*');
  return s;
}
function normText(rawText, preQuotedSingle) {
  let s = String(rawText).toLowerCase(); // step 1
  s = applyAnsiCQuotes(s); // step 2
  s = stripQuotesAndEscapes(s, preQuotedSingle); // step 3
  s = placeholderizeSubstitutions(s); // step 4
  return s;
}
// hitSubstring(nText, dutSet) -- when MULTIPLE dut basenames are substrings of the same text (e.g. a
// heredoc comment mentioning one guard by name while the real DUT invocation two lines down mentions
// another), prefer a NON-allow-exempt match: dutSet is a plain Set with no defined precedence, and
// letting Set-iteration order arbitrarily decide "which name matched" can accidentally pick an
// ALLOW_ANY/ALLOW_PROD member and wrongly exempt a segment that also, elsewhere in the very same text,
// names a real non-exempt DUT (confirmed empirically against the v1.5 contract: D77's heredoc comment
// "// see guard-canary.sh" was winning the match over its own body's `require('...pmm-trigger-recall.cjs')`).
function hitSubstring(nText, dutSet) {
  let fallback = null;
  for (const base of dutSet) {
    if (nText.indexOf(base) === -1) continue;
    if (!ALLOW_ANY.has(base) && !ALLOW_PROD.has(base)) return base;
    if (fallback === null) fallback = base;
  }
  return fallback;
}
const BRACE_OVERFLOW = Symbol('brace-overflow');
function expandBraces(text, depth) {
  if (depth > 8) return [text];
  const m = String(text).match(/\{([^{}]*)\}/);
  if (!m) return [text];
  const body = m[1];
  let alts = null;
  if (body.indexOf(',') !== -1) {
    alts = body.split(',');
  } else {
    const numRange = body.match(/^(-?\d+)\.\.(-?\d+)$/);
    const alphaRange = body.match(/^([A-Za-z])\.\.([A-Za-z])$/);
    if (numRange) {
      alts = [];
      let a = parseInt(numRange[1], 10); const b = parseInt(numRange[2], 10);
      const step = a <= b ? 1 : -1;
      for (let v = a; step > 0 ? v <= b : v >= b; v += step) { alts.push(String(v)); if (alts.length > 64) break; }
    } else if (alphaRange) {
      alts = [];
      let a = alphaRange[1].charCodeAt(0); const b = alphaRange[2].charCodeAt(0);
      const step = a <= b ? 1 : -1;
      for (let v = a; step > 0 ? v <= b : v >= b; v += step) { alts.push(String.fromCharCode(v)); if (alts.length > 64) break; }
    } else {
      return [text]; // bare {...}, no comma, no range -- literal, not expanded (matches bash)
    }
  }
  if (alts.length > 64) return BRACE_OVERFLOW;
  const pre = text.slice(0, m.index); const post = text.slice(m.index + m[0].length);
  const out = [];
  for (const alt of alts) {
    const sub = expandBraces(pre + alt + post, depth + 1);
    if (sub === BRACE_OVERFLOW) return BRACE_OVERFLOW;
    for (const cand of sub) { out.push(cand); if (out.length > 64) return BRACE_OVERFLOW; }
  }
  return out;
}
function cleanBasenameTail(b) {
  return stripWin32TrailingDotSpace(stripWin32AdsSuffix(String(b)));
}
function tokenBasename(token) {
  const parts = String(token).split(/[\/\\]/);
  return parts[parts.length - 1] || '';
}
function globPatternToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      let j = i + 1; let cls = '[';
      if (pattern[j] === '!' || pattern[j] === '^') { cls += '^'; j++; }
      while (j < pattern.length && pattern[j] !== ']') { cls += pattern[j].replace(/[\\^\]]/g, '\\$&'); j++; }
      cls += ']'; re += cls; i = j;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
function globMatchesAnyDut(pattern, dutSet) {
  const rx = globPatternToRegExp(pattern);
  let fallback = null;
  for (const base of dutSet) {
    if (!rx.test(base)) continue;
    if (!ALLOW_ANY.has(base) && !ALLOW_PROD.has(base)) return base;
    if (fallback === null) fallback = base;
  }
  return fallback;
}
const EIGHT_DOT_THREE_RE = /^[^~/]{1,6}~\d{1,2}\.(cjs|sh)$/;
function hasDirLiteralOrCwd(token, effectiveCwd) {
  const idx = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  const dir = idx === -1 ? '' : token.slice(0, idx);
  if (dir.indexOf('.claude/guards') !== -1 || dir.indexOf('.claude\\guards') !== -1) return true;
  if (dir.indexOf('.claude/memory/_local-config') !== -1 || dir.indexOf('.claude\\memory\\_local-config') !== -1) return true;
  if (dir === '' && effectiveCwd) {
    const cwd = normalizePath(effectiveCwd);
    if (cwd.indexOf('.claude/guards') !== -1 || cwd.indexOf('.claude/memory/_local-config') !== -1) return true;
  }
  return false;
}
function tokenHit(token, dutSet, effectiveCwd) {
  const base = cleanBasenameTail(tokenBasename(token));
  if (!base) return null;
  if (/[*?[]/.test(base)) {
    const m = globMatchesAnyDut(base, dutSet);
    if (m) {
      const literalChars = base.replace(/\.[^.]*$/, '').replace(/[*?[\]!^]/g, '');
      if (literalChars.length > 0 || hasDirLiteralOrCwd(token, effectiveCwd)) return m;
    }
  }
  if (EIGHT_DOT_THREE_RE.test(base)) return base;
  return null;
}
function findHit(rawText, dutSet, effectiveCwd, preQuotedSingle) {
  const raw = String(rawText);
  if (!preQuotedSingle) {
    for (const [s, e] of findSubstitutionSpans(raw)) {
      const openLen = raw[s] === '$' ? 2 : 1;
      const inner = raw.slice(s + openLen, e - 1);
      const innerHit = findHit(inner, dutSet, effectiveCwd);
      if (innerHit) return innerHit;
    }
  }
  const n = normText(raw, preQuotedSingle);
  const sub = hitSubstring(n, dutSet);
  if (sub) return sub;
  const tokens = n.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const expanded = expandBraces(tok, 0);
    if (expanded === BRACE_OVERFLOW) return tok;
    for (const cand of expanded) {
      const subHit = hitSubstring(cand, dutSet);
      if (subHit) return subHit;
      const th = tokenHit(cand, dutSet, effectiveCwd);
      if (th) return th;
    }
  }
  return null;
}
function basenameLower(p) {
  return path.basename(String(p)).toLowerCase();
}
function normalizePath(p) {
  let s = String(p).replace(/\\/g, '/').toLowerCase();
  s = s.replace(/^\/([a-z])\//, '$1:/');
  s = s.replace(/\/+$/, '');
  return s;
}

// ---------------------------------------------------------------------------------------------
// unbash Word helpers.
// ---------------------------------------------------------------------------------------------
function isPureSingleQuoted(word) {
  return !!(word && word.parts && word.parts.length === 1 && word.parts[0].type === 'SingleQuoted');
}
// wordItem(word) -- preQuotedSingle's contract (see stripQuotesAndEscapes's header) is "the text handed
// in already had its single-quote DELIMITERS stripped before this function ever saw it". unbash's own
// Word.text is the RAW source span and STILL CARRIES those delimiters (confirmed empirically: a
// single-quoted assignment value's .text is `'$T'`, not `$T`) -- passing .text straight through here was
// a bug (fuzz-caught, perturb-run's dut-path-backslash/bash-dot-exe families): the state machine's own
// preQuotedSingle=true start state then IMMEDIATELY sees the leftover opening delimiter char, treats it
// as the matching close of a (nonexistent) preceding quote, and desyncs for the rest of the token. Use
// .value (already delimiter-stripped by unbash) for a purely single-quoted word instead.
function wordItem(word) {
  if (!word) return null;
  const pureSingle = isPureSingleQuoted(word);
  return { text: pureSingle ? word.value : word.text, preQuotedSingle: pureSingle };
}
function hasUnresolvedRef(word) {
  if (!word || !word.parts) return false;
  for (const p of word.parts) {
    if (p.type === 'SimpleExpansion' || p.type === 'ParameterExpansion' || p.type === 'CommandExpansion' ||
        p.type === 'ArithmeticExpansion' || p.type === 'ProcessSubstitution') return true;
    if (p.type === 'DoubleQuoted' || p.type === 'LocaleString') {
      for (const q of p.parts || []) {
        if (q.type === 'SimpleExpansion' || q.type === 'ParameterExpansion' || q.type === 'CommandExpansion' || q.type === 'ArithmeticExpansion') return true;
      }
    }
  }
  return false;
}
function scanForHit(items, dutSet, effectiveCwd) {
  for (const it of items) {
    if (!it) continue;
    const hit = findHit(it.text, dutSet, effectiveCwd, it.preQuotedSingle);
    if (hit) return hit;
  }
  return null;
}

// collectOwnTexts(cmd) -- every Word-bearing field a Command node owns DIRECTLY (name, every
// prefix-assignment value, every suffix operand, every redirect target, every heredoc body). A nested
// command-substitution/process-substitution/arithmetic-expansion's OWN raw text (e.g. `$(cat <DUT>)`) is
// naturally included here as a SUBSTRING of whichever Word contains it (Word.text is the exact source
// span, nesting and all) -- findHit's own recurse-into-$()-first step additionally guarantees a literal
// DUT mention inside a substitution is found even after placeholder substitution would otherwise erase
// it. The nested Command(s) INSIDE that substitution are separately judged in their own right by the
// walker below (walkNestedScriptsInCommand) -- this function only covers "does this command's own
// argument text literally mention a DUT", not "what commands live inside its substitutions".
function collectOwnTexts(cmd, opts) {
  const skipName = !!(opts && opts.skipName);
  const skipPrefix = !!(opts && opts.skipPrefix);
  const skipRedirects = !!(opts && opts.skipRedirects);
  const items = [];
  if (!skipName && cmd.name) items.push(wordItem(cmd.name));
  for (const w of cmd.suffix || []) items.push(wordItem(w));
  if (!skipPrefix) for (const a of cmd.prefix || []) { if (a.value) items.push(wordItem(a.value)); }
  if (!skipRedirects) for (const rd of cmd.redirects || []) {
    if (rd.target) items.push(wordItem(rd.target));
    if (typeof rd.content === 'string') items.push({ text: rd.content, preQuotedSingle: !!rd.heredocQuoted });
    else if (rd.body) items.push(wordItem(rd.body));
  }
  return items;
}
function commandOwnRawText(cmd) {
  return collectOwnTexts(cmd).map((it) => it.text).join(' ');
}
// prefixAndRedirectItems(cmd) -- the two "unconditional" categories (借用来源段: 参数/重定向目标/heredoc
// 正文 are peer node categories, not subordinate to the exe-based NON_EXEC_EXE/git closed sets below):
// a prefix-assignment's own VALUE (any name, not just the old FRONT_ASSIGN_NAMES closed set -- A23's
// `n=$(grep -c TODO <DUT>)` denies via a bare assignment's own value with an arbitrary variable name, so
// gating this by variable name would under-cover; P03's `GIT_EDITOR=<DUT> git commit` needs the SAME
// unconditional value scan on a command that DOES have an exe), and a redirect's target/heredoc body --
// DATA a command owns regardless of which program consumes it (A21's bare `cat <<EOF` mentioning a guard
// name in the heredoc BODY denies even though cat is otherwise NON_EXEC_EXE-exempt for its own operands;
// A24/A25/A46-A48's `git commit -m "$(cat <<EOF ...EOF)"` denies via the NESTED cat's own heredoc, found
// by the walker's recursion into the command-substitution's `.script`, not via git's restricted scan).
function prefixAndRedirectItems(cmd) {
  const items = [];
  for (const a of cmd.prefix || []) { if (a.value) items.push(wordItem(a.value)); }
  for (const rd of cmd.redirects || []) {
    if (rd.target) items.push(wordItem(rd.target));
    if (typeof rd.content === 'string') items.push({ text: rd.content, preQuotedSingle: !!rd.heredocQuoted });
    else if (rd.body) items.push(wordItem(rd.body));
  }
  return items;
}

// assignmentsOf(cmd) -- adapts unbash's Command.prefix (AssignmentPrefix[]) into the {name,
// decoded_value, unresolved_variables} shape judgeRedirect/isHomeRelativeRef/violatesRealHomeRule
// already expect (those three functions are UNCHANGED by the rewrite).
function assignmentsOf(cmd) {
  return (cmd.prefix || []).map((a) => ({
    name: a.name,
    decoded_value: a.value ? a.value.value : '',
    unresolved_variables: (a.value && hasUnresolvedRef(a.value)) ? ['x'] : [],
  }));
}

// ---------------------------------------------------------------------------------------------
// Redirect-completeness (spec 21 rules ①②③) — UNCHANGED logic; only its input shape (assignmentsOf)
// changed. `:796`-area home-spelling table (isHomeRelativeRef) kept byte-identical per E-7 (runner
// HOME_SCAN_LINE_ALLOWLIST entry, "数据非读取").
// ---------------------------------------------------------------------------------------------
function isHomeRelativeRef(value) {
  const v = String(value);
  const refs = ['${HOME}', '${USERPROFILE}', '$HOME', '$USERPROFILE', '~'];
  for (const ref of refs) {
    if (v === ref || v.indexOf(ref) === 0) return true;
  }
  return false;
}
function violatesRealHomeRule(decodedValue, unresolvedVars) {
  if (isHomeRelativeRef(decodedValue)) return true; // rule ①
  const isLiteral = !unresolvedVars || unresolvedVars.length === 0;
  if (isLiteral) { // rule ②
    const nv = normalizePath(decodedValue);
    const nh = normalizePath(REAL_HOME);
    if (nv === nh) return true;
    if (nv.indexOf(nh + '/.claude') === 0) return true;
  }
  return false;
}
function judgeRedirect(cmd, mutant) {
  const prefixes = assignmentsOf(cmd);
  const byName = new Map(prefixes.map((a) => [a.name, a]));

  if (mutant === 'any-one-redirect') {
    const candidates = HOME_TRIO.concat(AMBIENT_VARS);
    const anyOk = candidates.some((name) => {
      const a = byName.get(name);
      return a && !violatesRealHomeRule(a.decoded_value, a.unresolved_variables);
    });
    if (anyOk) return judgeAmbient(byName);
    return { reason_code: 'missing-redirect', missing: HOME_TRIO.filter((n) => !byName.has(n)) };
  }

  const missingTrio = HOME_TRIO.filter((n) => !byName.has(n));
  if (missingTrio.length > 0) {
    return { reason_code: 'missing-redirect', missing: missingTrio };
  }
  const values = HOME_TRIO.map((n) => byName.get(n).decoded_value);
  if (values[0] !== values[1] || values[1] !== values[2]) {
    return { reason_code: 'value-mismatch', missing: null };
  }
  const rep = byName.get('HOME');
  if (violatesRealHomeRule(rep.decoded_value, rep.unresolved_variables)) {
    return { reason_code: 'real-home-value', missing: null };
  }
  return judgeAmbient(byName);
}
function judgeAmbient(byName) {
  const missingAmbient = [];
  for (const name of AMBIENT_VARS) {
    const ambientVal = process.env[name];
    if (typeof ambientVal !== 'string' || ambientVal.trim() === '') continue;
    const override = byName.get(name);
    if (!override || violatesRealHomeRule(override.decoded_value, override.unresolved_variables)) {
      missingAmbient.push(name);
    }
  }
  if (missingAmbient.length > 0) {
    return { reason_code: 'ambient-not-overridden', missing: missingAmbient };
  }
  return null;
}
const ALWAYS_DENY_NO_REDIRECT = { reason_code: 'missing-redirect', missing: HOME_TRIO.slice() };

// ---------------------------------------------------------------------------------------------
// Per-Command judgment (借用来源段 generalized rule, replacing the old classifySegment closed-set
// dispatch). exe-family special cases that remain: NON_EXEC_EXE (exempt; sed's own script argument
// excepted), git (restricted -c-key/subcommand scan only, never a blanket argument scan), source/.
// (SOURCE_LIB_OK exemption + stdin-tracing), interpreters (stdin-tracing + rule a/b ALLOW exemption).
// Everything else (nice/xargs/env/timeout/awk/python/an unrecognized exe/exe-itself-is-a-DUT-basename)
// falls through to the general own-text scan uniformly -- this is what "包装命令透传的参数" means: no
// per-wrapper special-casing is needed because the scan already covers every suffix word regardless of
// which program is doing the wrapping.
// ---------------------------------------------------------------------------------------------
function isAllowName(name, cmd) {
  if (ALLOW_ANY.has(name)) return true;
  if (ALLOW_PROD.has(name)) {
    const hasSelfTestToken = (cmd.suffix || []).some((w) => SELFTEST_TOKENS.has(w.value));
    return !hasSelfTestToken;
  }
  return false;
}
// hasSubstitutionComplexity(word) -- true when a Word contains a nested command-substitution /
// process-substitution / arithmetic-command-expansion part (the shapes pmm-cmd-parse.cjs's v1.0-v1.3
// hand-written splitter could never structurally represent and fell back to opaque
// `unsupported:command-substitution`/`unsupported:heredoc` segments for -- rule (d) then unconditionally
// scanned that WHOLE opaque segment's raw text, which is how A24/A25/A46-A48's `git commit -m "$(cat
// <<EOF ...EOF)" -- .claude/guards/<DUT>` denied under v1.0-v1.3: not because the -m VALUE itself named a
// DUT, but because the pathspec trailing the substitution was swept in by the same blanket text scan. The
// AST engine parses this construct cleanly (no "unsupported" fallback), so git's restricted -c-key/
// subcommand scan (needed to keep A13/A28/A29/A36 -- plain, substitution-free commit messages that merely
// MENTION a guard name -- allow) would otherwise never look at that pathspec. Restoring the old opaque-
// segment breadth ONLY when the git command's own arguments are non-literal (built via a substitution)
// keeps both invariants: a plain-literal commit message/pathspec is never blanket-scanned (A13/A28/A29/
// A36 stay allow), but once ANY argument is assembled from a nested command a structurally-complex git
// invocation is treated with the same conservatism rule (d) always gave opaque constructs.
function hasSubstitutionComplexity(word) {
  if (!word || !word.parts) return false;
  for (const p of word.parts) {
    if (p.type === 'CommandExpansion' || p.type === 'ProcessSubstitution' || p.type === 'ArithmeticExpansion') return true;
    if (p.type === 'DoubleQuoted' || p.type === 'LocaleString') {
      for (const q of p.parts || []) {
        if (q.type === 'CommandExpansion' || q.type === 'ArithmeticExpansion') return true;
      }
    }
  }
  return false;
}
function gitRestrictedHit(cmd, dutSet, effectiveCwd) {
  const suffix = cmd.suffix || [];
  const decoded = suffix.map((w) => w.value);
  if (suffix.some((w) => hasSubstitutionComplexity(w))) {
    const hit = scanForHit(suffix.map((w) => wordItem(w)), dutSet, effectiveCwd);
    if (hit) return hit;
  }
  let sub = null;
  for (let i = 0; i < suffix.length; i++) {
    const tok = decoded[i];
    if (typeof tok !== 'string') continue;
    if (tok === '-c' && i + 1 < suffix.length) {
      const kv = decoded[i + 1];
      const eq = typeof kv === 'string' ? kv.indexOf('=') : -1;
      if (eq !== -1) {
        const key = kv.slice(0, eq); const val = kv.slice(eq + 1);
        if (gitCKeyMatches(key, val)) {
          const hit = findHit(val, dutSet, effectiveCwd);
          if (hit) return hit;
        }
      }
      i++; continue;
    }
    if (tok === '-C' && i + 1 < suffix.length) { i++; continue; }
    if (tok.indexOf('-') === 0) continue;
    if (!sub) sub = tok;
  }
  if (sub && gitSubcommandTriggersScan(sub, decoded)) {
    const hit = findHit(decoded.filter((d) => typeof d === 'string').join(' '), dutSet, effectiveCwd);
    if (hit) return hit;
  }
  return null;
}
function sedScriptHit(cmd, dutSet, effectiveCwd) {
  const suffix = cmd.suffix || [];
  const decoded = suffix.map((w) => w.value);
  const eIdx = decoded.indexOf('-e');
  let scriptText = null; let preQuotedSingle = false;
  if (eIdx !== -1 && eIdx + 1 < suffix.length) { scriptText = decoded[eIdx + 1]; preQuotedSingle = isPureSingleQuoted(suffix[eIdx + 1]); }
  else {
    const idx = suffix.findIndex((w) => typeof w.value === 'string' && w.value.indexOf('-') !== 0);
    if (idx !== -1) { scriptText = decoded[idx]; preQuotedSingle = isPureSingleQuoted(suffix[idx]); }
  }
  if (scriptText == null) return null;
  return findHit(scriptText, dutSet, effectiveCwd, preQuotedSingle);
}
function commandReadsStdin(cmd) {
  const suffix = cmd.suffix || [];
  const decoded = suffix.map((w) => w.value);
  let scriptOperand = null;
  for (let i = 0; i < suffix.length; i++) {
    const dec = decoded[i];
    if (typeof dec !== 'string') continue;
    if (i > 0 && VALUE_TAKING_BASH_FLAGS.has(decoded[i - 1])) continue;
    if (dec.indexOf('-') !== 0) { scriptOperand = dec; break; }
  }
  return !scriptOperand || NODE_STDIN_SHAPES.has(scriptOperand) || decoded.includes('-s');
}

// judgePathSubstringCommand(cmd) -- the "path-substring" self-test mutant (contract mutants.path-
// substring): a DELIBERATELY crude stand-in judgment that completely bypasses judgeCommandNode's real
// closed-set dispatch (NON_EXEC_EXE/git-restricted/syntax-check/stdin-tracing all skipped, matching the
// v1.3 mutant's own shape at the bottom of this file's judge() -- old code ran this as an entirely
// separate loop over segments, never through classifySegment): does this command's own RAW text (NO
// backslash normalization -- the old mutant's `/\.claude\/guards\//i` test never normalized either,
// which is WHY D108's backslash-only Windows path is pinned to flip under this mutant while the real
// engine correctly denies it) contain the literal substring ".claude/guards/"? exemptBase mirrors the old
// mutant's own rule: the first non-option suffix operand's basename if there is one, else the exe's own
// basename (this is what let `bash ~/.claude/guards/guard-canary.sh` exempt via the SCRIPT name rather
// than "bash" itself). judgeRedirect is always called WITHOUT the outer mutant name (old code's literal
// `judgeRedirect(seg, undefined)` -- the path-substring mutant never also relaxes redirect-completeness).
function judgePathSubstringCommand(cmd) {
  const text = commandOwnRawText(cmd);
  if (!/\.claude\/guards\//i.test(text)) return null;
  const suffix = cmd.suffix || [];
  const firstOperand = suffix.find((w) => typeof w.value === 'string' && w.value.indexOf('-') !== 0);
  const exemptBase = firstOperand ? cleanBasenameTail(tokenBasename(firstOperand.value)).toLowerCase()
    : (cmd.name ? cleanBasenameTail(tokenBasename(cmd.name.value)).toLowerCase() : '');
  if (isAllowName(exemptBase, cmd)) return null;
  const verdict = judgeRedirect(cmd, undefined);
  return verdict ? Object.assign({ basenames: [exemptBase] }, verdict) : null;
}

// judgeCommandNode(cmd, dutSet, effectiveCwd, upstreamTextGetter, mutant, pathSubstringMode) -> null |
// {basenames, reason_code, missing}
function judgeCommandNode(cmd, dutSet, effectiveCwd, upstreamTextGetter, mutant, pathSubstringMode) {
  if (pathSubstringMode) return judgePathSubstringCommand(cmd);
  if (!cmd.name) {
    // Assignment-only Command (`FOO=bar` alone, no command word) -- never exemption-eligible (no exe to
    // check against ALLOW_ANY/PROD, no supported redirect form attaches to a bare assignment statement
    // the way it does to the FOLLOWING command in a `;`-chain). A22/A23 precedent: deny unconditionally
    // on a hit found in its own prefix-assignment value(s).
    const hit = scanForHit(collectOwnTexts(cmd), dutSet, effectiveCwd);
    if (!hit) return null;
    return Object.assign({ basenames: [hit] }, ALWAYS_DENY_NO_REDIRECT);
  }
  const exeRaw = cmd.name.value;
  // exe -- used ONLY for the closed-set family checks below (NON_EXEC_EXE/git/INTERPRETER_EXES/xargs/
  // source/./syntax-flag exemptions), so a Windows ".exe" suffix (perturbation-family fuzz-caught:
  // `bash.exe` piped-into via stdin-tracing must still be recognized as the "bash" family) is stripped
  // here; exeBaseLower (used for DUT-set/ALLOW-list membership, a DIFFERENT kind of name) is not -- no
  // DUT or ALLOW member ever carries a .exe extension, so stripping it there would be a no-op at best and
  // could theoretically create a false collision at worst.
  const exe = typeof exeRaw === 'string' ? exeRaw.toLowerCase().replace(/\.exe$/, '') : '';
  const exeBaseLower = typeof exeRaw === 'string' ? cleanBasenameTail(tokenBasename(exeRaw)).toLowerCase() : '';

  // syntax-only checks (never DUT, regardless of what basename appears) -- bash -n / sh -n / node
  // --check / node -c, per spec 第21条's non_dut convention.
  const suffixDecoded = (cmd.suffix || []).map((w) => w.value);
  if ((exe === 'bash' || exe === 'sh') && suffixDecoded.includes('-n')) return null;
  if (exe === 'node' && (suffixDecoded.includes('--check') || suffixDecoded.includes('-c'))) return null;

  // exe itself IS a DUT basename (direct invocation) -- short-circuits: the rest of this command's own
  // text is not independently scanned (matching old rule 'b', which never fell through to a general
  // scan once exe matched); ALLOW exemption applies here too (rule b). This is the ONLY case where an
  // ALLOW_ANY/ALLOW_PROD member is trusted to self-isolate its OWN prefix/heredoc/redirect content too
  // (guard-canary.sh legitimately needs to read the real root; that is the whole point of ALLOW_ANY).
  if (dutSet.has(exeBaseLower)) {
    if (isAllowName(exeBaseLower, cmd)) return null;
    const verdict = judgeRedirect(cmd, mutant);
    return verdict ? Object.assign({ basenames: [exeBaseLower] }, verdict) : null;
  }

  // Unconditional prefix-assignment-value / redirect-target / heredoc-body scan (see
  // prefixAndRedirectItems' header comment) -- NEVER ALLOW-exempt (matching old rule (d)'s "rule (d) 段
  // 不适用任何 ALLOW 豁免": this is the same "opaque data this command owns" category rule d used to
  // catch via the whole segment's source text, now scanned structurally instead of via parse-failure).
  const unconditionalHit = scanForHit(prefixAndRedirectItems(cmd), dutSet, effectiveCwd);
  if (unconditionalHit) {
    const verdict = judgeRedirect(cmd, mutant);
    return verdict ? Object.assign({ basenames: [unconditionalHit] }, verdict) : null;
  }

  if (NON_EXEC_EXE.has(exe)) {
    if (exe !== 'sed') return null; // read-only tool, entirely exempt (cat/grep/etc reading a DUT path)
    const hit = sedScriptHit(cmd, dutSet, effectiveCwd);
    if (!hit) return null;
    const verdict = judgeRedirect(cmd, mutant);
    return verdict ? Object.assign({ basenames: [hit] }, verdict) : null;
  }

  if (exe === 'git') {
    const hit = gitRestrictedHit(cmd, dutSet, effectiveCwd);
    if (!hit) return null;
    const verdict = judgeRedirect(cmd, mutant);
    return verdict ? Object.assign({ basenames: [hit] }, verdict) : null;
  }

  // General scan: every suffix operand this command owns (prefix/redirects already covered by the
  // unconditional check above, and must not be re-scanned here or a hit there could wrongly become
  // ALLOW-eligible below via the interpreter/xargs branch, which only rule a's OWN script operand is).
  let hit = scanForHit(collectOwnTexts(cmd, { skipName: true, skipPrefix: true, skipRedirects: true }), dutSet, effectiveCwd);

  if ((exe === 'source' || exe === '.') && hit && SOURCE_LIB_OK.has(hit)) hit = null;

  // stdin-tracing: interpreters/source/. reading their PROGRAM from stdin, and xargs (借用来源段 names it
  // explicitly as a wrapper whose "透传的参数" come from upstream when piped -- D81's `echo <DUT> | xargs
  // node` has no DUT text as xargs's own literal operand; the DUT only ever appears in the piped-in
  // argument stream xargs turns into node's argv).
  const stdinTraceEligible = INTERPRETER_EXES.has(exe) || exe === 'source' || exe === '.' ||
    (exe === 'xargs' && upstreamTextGetter);
  if (!hit && stdinTraceEligible && (exe === 'xargs' || commandReadsStdin(cmd))) {
    const upstreamText = upstreamTextGetter ? upstreamTextGetter() : null;
    if (upstreamText != null) {
      const uHit = findHit(upstreamText, dutSet, effectiveCwd);
      if (uHit) hit = uHit;
    }
  }

  if (!hit) return null;
  // ALLOW exemption (rule a): ONLY when the exe is an interpreter AND the matched name is what it is
  // actually running (the general scan already found it via a suffix operand in that case) -- an
  // incidental ALLOW-listed mention via a wrapper (`nice guard-canary.sh` is not how guard-canary.sh is
  // meant to be run) or via git/source is never exempt, matching old isExempt's "rule a/b only".
  if (INTERPRETER_EXES.has(exe) && isAllowName(hit, cmd)) return null;

  const verdict = judgeRedirect(cmd, mutant);
  return verdict ? Object.assign({ basenames: [hit] }, verdict) : null;
}
// pathSubstringHit(text) -- same crude, deliberately-not-backslash-normalized test as
// judgePathSubstringCommand (see its header comment for why no normalization: D108's pinned expected-
// failing membership depends on it).
function pathSubstringHit(text) {
  return /\.claude\/guards\//i.test(String(text)) ? 'x' : null;
}

// ---------------------------------------------------------------------------------------------
// AST walk (借用来源段: "遍历所有节点"). Finds every Command node reachable from the parsed script --
// top-level statements, pipeline/AndOr stages, if/for/while/case/function/subshell/brace-group/select/
// coproc bodies, and every nested command-substitution/process-substitution/arithmetic-command-expansion
// `.script` found inside any Word at any depth (heredoc bodies are plain text, not further parsed by
// unbash, unless fed into source/an interpreter reading stdin -- covered by commandReadsStdin's upstream
// tracing, not by re-parsing the heredoc body as a nested script). A defense-in-depth recursion-depth
// guard (independent of unbash's own MAX_SYNTAX_NESTING=256 cap on the PARSE side) throws a tagged error
// the caller turns into `nesting-too-deep`.
// ---------------------------------------------------------------------------------------------
const WALK_DEPTH_LIMIT = 300;
function depthExceededError() {
  const e = new Error('pmm-isolation-gate: AST walk depth exceeded');
  e.__depthExceeded = true;
  return e;
}
function collectFindings(script, dutSet, hookCwd, mutant, pathSubstringMode) {
  const findings = [];
  let effectiveCwd = hookCwd || null;

  function noteAlwaysDenyWords(words) {
    for (const w of (words || [])) {
      if (!w) continue;
      const it = wordItem(w); // .value (delimiter-stripped) for a pure-single-quoted word -- see wordItem's header
      const hit = pathSubstringMode ? pathSubstringHit(it.text) : findHit(it.text, dutSet, effectiveCwd, it.preQuotedSingle);
      if (hit) findings.push(Object.assign({ basenames: [typeof hit === 'string' ? hit : '<path>'] }, ALWAYS_DENY_NO_REDIRECT));
    }
  }

  function walkScript(scr, depth) {
    if (depth > WALK_DEPTH_LIMIT) throw depthExceededError();
    for (const stmt of scr.commands || []) walkStatementLike(stmt, depth + 1);
  }
  function walkCompoundList(cl, depth) {
    if (!cl || depth > WALK_DEPTH_LIMIT) { if (depth > WALK_DEPTH_LIMIT) throw depthExceededError(); return; }
    for (const stmt of cl.commands || []) walkStatementLike(stmt, depth + 1);
  }
  function walkStatementLike(stmt, depth) {
    if (depth > WALK_DEPTH_LIMIT) throw depthExceededError();
    walkNode(stmt.command, depth + 1, null);
    for (const rd of stmt.redirects || []) {
      const texts = [];
      if (rd.target) texts.push(rd.target);
      if (typeof rd.content === 'string') texts.push({ text: rd.content });
      noteAlwaysDenyWords(texts);
    }
  }
  function walkPipelineOrAndOr(node, depth) {
    const cmds = node.commands || [];
    for (let i = 0; i < cmds.length; i++) {
      const upstream = i > 0 ? cmds[i - 1] : null;
      walkNode(cmds[i], depth + 1, upstream ? () => commandOwnRawText(upstream.type === 'Command' ? upstream : { name: null, prefix: [], suffix: [{ text: '', value: '' }], redirects: [] }) : null);
    }
  }
  function walkTestExpr(expr, depth) {
    if (!expr || depth > WALK_DEPTH_LIMIT) { if (expr && depth > WALK_DEPTH_LIMIT) throw depthExceededError(); return; }
    if (expr.type === 'TestUnary') noteAlwaysDenyWords([expr.operand]);
    else if (expr.type === 'TestBinary') noteAlwaysDenyWords([expr.left, expr.right]);
    else if (expr.type === 'TestLogical') { walkTestExpr(expr.left, depth + 1); walkTestExpr(expr.right, depth + 1); }
    else if (expr.type === 'TestNot') walkTestExpr(expr.operand, depth + 1);
    else if (expr.type === 'TestGroup') walkTestExpr(expr.expression, depth + 1);
  }
  function walkArithForScripts(expr, depth) {
    if (!expr || depth > WALK_DEPTH_LIMIT) { if (expr && depth > WALK_DEPTH_LIMIT) throw depthExceededError(); return; }
    if (expr.type === 'ArithmeticCommandExpansion' && expr.script) walkScript(expr.script, depth + 1);
    if (expr.left) walkArithForScripts(expr.left, depth + 1);
    if (expr.right) walkArithForScripts(expr.right, depth + 1);
    if (expr.operand) walkArithForScripts(expr.operand, depth + 1);
    if (expr.expression) walkArithForScripts(expr.expression, depth + 1);
    if (expr.test && expr.consequent) { walkArithForScripts(expr.test, depth + 1); walkArithForScripts(expr.consequent, depth + 1); walkArithForScripts(expr.alternate, depth + 1); }
  }
  function walkPartForNestedScripts(p, depth) {
    if (!p || depth > WALK_DEPTH_LIMIT) { if (p && depth > WALK_DEPTH_LIMIT) throw depthExceededError(); return; }
    if ((p.type === 'CommandExpansion' || p.type === 'ProcessSubstitution') && p.script) walkScript(p.script, depth + 1);
    else if (p.type === 'ArithmeticExpansion' && p.expression) walkArithForScripts(p.expression, depth + 1);
    else if (p.type === 'DoubleQuoted' || p.type === 'LocaleString') { for (const q of p.parts || []) walkPartForNestedScripts(q, depth + 1); }
    else if (p.type === 'ParameterExpansion') {
      if (p.operand) walkWordForNestedScripts(p.operand, depth + 1);
      if (p.slice) { walkWordForNestedScripts(p.slice.offset, depth + 1); if (p.slice.length) walkWordForNestedScripts(p.slice.length, depth + 1); }
      if (p.replace) { walkWordForNestedScripts(p.replace.pattern, depth + 1); walkWordForNestedScripts(p.replace.replacement, depth + 1); }
      if (p.indexParts) for (const ip of p.indexParts) walkPartForNestedScripts(ip, depth + 1);
    } else if (p.type === 'BraceExpansion' || p.type === 'ExtendedGlob') {
      for (const q of p.parts || []) walkPartForNestedScripts(q, depth + 1);
    }
  }
  function walkWordForNestedScripts(word, depth) {
    if (!word || !word.parts || depth > WALK_DEPTH_LIMIT) { if (word && depth > WALK_DEPTH_LIMIT) throw depthExceededError(); return; }
    for (const p of word.parts) walkPartForNestedScripts(p, depth + 1);
  }
  function walkNestedScriptsInCommand(cmd, depth) {
    const words = [];
    if (cmd.name) words.push(cmd.name);
    for (const a of cmd.prefix || []) if (a.value) words.push(a.value);
    for (const w of cmd.suffix || []) words.push(w);
    for (const rd of cmd.redirects || []) { if (rd.target) words.push(rd.target); if (rd.body) words.push(rd.body); }
    for (const w of words) walkWordForNestedScripts(w, depth + 1);
  }

  function walkNode(node, depth, upstreamTextGetter) {
    if (!node) return;
    if (depth > WALK_DEPTH_LIMIT) throw depthExceededError();
    switch (node.type) {
      case 'Command': {
        const res = judgeCommandNode(node, dutSet, effectiveCwd, upstreamTextGetter, mutant, pathSubstringMode);
        if (res) findings.push(res);
        walkNestedScriptsInCommand(node, depth + 1);
        break;
      }
      case 'Pipeline': walkPipelineOrAndOr(node, depth); break;
      case 'AndOr': walkPipelineOrAndOr(node, depth); break;
      case 'If':
        walkCompoundList(node.clause, depth); walkCompoundList(node.then, depth);
        if (node.else) { if (node.else.type === 'If') walkNode(node.else, depth + 1, null); else walkCompoundList(node.else, depth); }
        break;
      case 'For':
        noteAlwaysDenyWords(node.wordlist);
        walkCompoundList(node.body, depth);
        break;
      case 'ArithmeticFor':
        walkArithForScripts(node.initialize, depth); walkArithForScripts(node.test, depth); walkArithForScripts(node.update, depth);
        walkCompoundList(node.body, depth);
        break;
      case 'While':
        walkCompoundList(node.clause, depth); walkCompoundList(node.body, depth);
        break;
      case 'Function':
        walkNode(node.body, depth + 1, null);
        break;
      case 'Subshell': walkCompoundList(node.body, depth); break;
      case 'BraceGroup': walkCompoundList(node.body, depth); break;
      case 'CompoundList': walkCompoundList(node, depth); break;
      case 'Case':
        noteAlwaysDenyWords([node.word]);
        for (const item of node.items || []) { noteAlwaysDenyWords(item.pattern); walkCompoundList(item.body, depth); }
        break;
      case 'Select':
        noteAlwaysDenyWords(node.wordlist);
        walkCompoundList(node.body, depth);
        break;
      case 'Coproc': walkNode(node.body, depth + 1, null); break;
      case 'TestCommand': walkTestExpr(node.expression, depth); break;
      case 'ArithmeticCommand': break; // body is a raw string (types.d.ts); no separate AST child to walk
      default: break;
    }
  }

  walkScript(script, 0);
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Main judgment: judge(command, dutSet, mutant, hookCwd) -> {decision:'allow'} |
// {decision:'deny', denials} ; mutant is undefined in production; only --self-test ever sets it.
// A parse throw, unbash's own `.errors` (including its MAX_SYNTAX_NESTING=256 cap), or this file's own
// walk-depth guard all resolve to deny (fail-closed) -- never to the old v1.0-v1.2 "catch return allow".
// ---------------------------------------------------------------------------------------------
function judge(command, dutSet, mutant, hookCwd) {
  let script;
  try {
    script = unbashParse(command);
  } catch {
    return { decision: 'deny', denials: [{ index: 0, basenames: [], reason_code: 'parse-error', missing: null }] };
  }
  if (script.errors && script.errors.length) {
    const deep = script.errors.some((e) => /nesting/i.test(e.message || ''));
    return { decision: 'deny', denials: [{ index: 0, basenames: [], reason_code: deep ? 'nesting-too-deep' : 'parse-error', missing: null }] };
  }
  const pathSubstringMode = mutant === 'path-substring';
  let findings;
  try {
    findings = collectFindings(script, dutSet, hookCwd, mutant, pathSubstringMode);
  } catch (e) {
    if (e && e.__depthExceeded) return { decision: 'deny', denials: [{ index: 0, basenames: [], reason_code: 'nesting-too-deep', missing: null }] };
    return { decision: 'deny', denials: [{ index: 0, basenames: [], reason_code: 'parse-error', missing: null }] };
  }
  if (findings.length === 0) return { decision: 'allow' };
  return { decision: 'deny', denials: findings.map((f, i) => Object.assign({ index: i }, f)) };
}

// ---------------------------------------------------------------------------------------------
// Denial output + logging.
// ---------------------------------------------------------------------------------------------
const ALT_WRITE_UNSUPPORTED = [
  '改成受支持的单命令形态:',
  '  · 提交信息用 $(cat <<EOF ... EOF) 组装 -> git -C ~ commit -F <文件>(消息先用 Write 工具落盘),或多行双引号 -m "…"',
  '  · 捕获只读结果 x=$(cmd <守卫>) -> 不捕获直接跑,或先写文件再读',
  '  · 遍历守卫目录的只读循环(for/glob)-> 单条多文件命令:cat/head/wc -l/grep -c 后跟 ~/.claude/guards/*.sh',
  '  · 探针/提示词用 heredoc 传入且提到守卫文件名 -> 提示词先用 Write 工具落盘,再传路径',
  '  · 金丝雀外面套 time/子壳/$(…)捕获 -> 直接 bash ~/.claude/guards/guard-canary.sh 或接管道,不要捕获包裹',
  '  · 按文件名的镜像校验循环 -> 逐个 cmp a b,或 diff -rq <dir1> <dir2>(operand 是目录,不含守卫文件名)',
  '  · 进程替换做 diff -> git -C ~ diff HEAD -- .claude/guards/<名>',
].join('\n');
function buildAltWrite(reasonCode) {
  if (reasonCode === 'unsupported-structure' || reasonCode === 'parse-error' || reasonCode === 'nesting-too-deep') return ALT_WRITE_UNSUPPORTED;
  return '唯一正确写法: HOME=$T USERPROFILE=$T PMM_HOME=$T <原段>(T 是不在 <真 home>/.claude 下的临时目录)。';
}
function buildDenyReason(denials) {
  const lowest = denials[0];
  const segIdxList = denials.map((d) => d.index).join(',');
  const missing = lowest.missing ? lowest.missing.join(',') : '';
  const allBasenames = Array.from(new Set(denials.reduce((acc, d) => acc.concat(d.basenames || []), []))).join(',');
  const lines = [
    'pmm-isolation-gate: 拒绝 -- 段 ' + segIdxList + ' 调用了守卫工具(' + allBasenames + ')但缺少完整的 HOME/USERPROFILE/PMM_HOME 隔离重定向。',
    'iso-reason=' + lowest.reason_code + (missing ? (' missing=' + missing) : '') + ' segments=' + segIdxList,
    buildAltWrite(lowest.reason_code),
    '如果这是生产写入工具被误拦,请让主脑把它加进 ALLOW_PROD。',
    '教训指针: [[tooling:selftest-must-redirect-every-root-the-tool-writes]]',
  ];
  return lines.join('\n');
}
function writeDenialLog(root, row) {
  try {
    const p = path.join(root, 'isolation-denials-' + require('os').hostname() + '.tsv');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fd = fs.openSync(p, 'a');
    fs.writeSync(fd, row + '\n');
    fs.closeSync(fd);
  } catch { /* silent */ }
}
function sha16(s) { return ledger.sha16(s); }

// ---------------------------------------------------------------------------------------------
// Hook entry point.
// ---------------------------------------------------------------------------------------------
function runHook(hookJsonText, mutant) {
  let hook;
  try { hook = JSON.parse(hookJsonText); } catch { return { stdout: '', stderr: '', rc: 0 }; }
  if (!hook || typeof hook !== 'object') return { stdout: '', stderr: '', rc: 0 };
  if (hook.tool_name !== 'Bash') return { stdout: '', stderr: '', rc: 0 };
  const command = hook.tool_input && typeof hook.tool_input.command === 'string' ? hook.tool_input.command : '';
  if (!command) return { stdout: '', stderr: '', rc: 0 };

  const dutSet = computeDutSet(REAL_HOME);
  const verdict = judge(command, dutSet, mutant, hook.cwd);
  if (verdict.decision === 'allow') return { stdout: '', stderr: '', rc: 0 };

  const reason = buildDenyReason(verdict.denials);
  const root = ledger.resolveRoot();
  const sidSha = sha16(hook.session_id || '');
  const agentSha = sha16(hook.agent_id || '');
  const row = [
    new Date().toISOString(), sidSha, agentSha, hook.tool_use_id || '',
    verdict.denials.map((d) => d.index).join(','),
    verdict.denials.map((d) => d.basenames ? d.basenames.join('|') : '').join(','),
    verdict.denials[0].missing ? verdict.denials[0].missing.join(',') : '',
  ].join('\t');
  writeDenialLog(root, row);

  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  return { stdout: JSON.stringify(out) + '\n', stderr: '', rc: 0 };
}

// ---------------------------------------------------------------------------------------------
// Self-test / contract executor.
// ---------------------------------------------------------------------------------------------
// SELFTEST-BEGIN
function runSelfTestContract(contractPath, opts) {
  opts = opts || {};
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const { spawn } = require('child_process');
  const os = require('os');
  const iso = require('./selftest-iso.cjs');
  const GATE_SH = path.join(__dirname, 'pmm-isolation-gate.sh');
  const CONCURRENCY = opts.concurrency || Math.max(4, Math.min(16, os.cpus().length * 2));
  const scoringV15 = !!(contract.conventions && contract.conventions.scoring_v1_5);

  function runCaseAsync(kase, mutantName) {
    return new Promise((resolve) => {
      const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isogate-contract-'));
      const home = path.join(runRoot, 'home');
      fs.mkdirSync(home, { recursive: true });
      const cwd = path.join(runRoot, 'cwd');
      fs.mkdirSync(cwd, { recursive: true });
      const REALHOME = REAL_HOME;
      const REALHOME_MSYS = '/' + REALHOME.replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase());
      const RUNROOT = runRoot.replace(/\\/g, '/');
      function sub(text) {
        return String(text)
          .replace(/\bREALHOME_MSYS\b/g, REALHOME_MSYS)
          .replace(/\bREALHOME\b/g, REALHOME)
          .replace(/\bRUNROOT\b/g, RUNROOT);
      }
      const commandText = sub(kase.command || '');
      const sessionId = 'test:' + require('crypto').randomUUID();
      const toolUseId = 'toolu_selftest_' + require('crypto').randomUUID();
      const hookJson = {
        session_id: sessionId, agent_id: kase.agent_id !== undefined ? kase.agent_id : '',
        agent_type: '', prompt_id: 'p1', tool_use_id: toolUseId, cwd: cwd.replace(/\\/g, '/'),
        hook_event_name: 'PreToolUse', tool_name: kase.tool_name || 'Bash', tool_input: { command: commandText },
      };
      const stdinText = kase.stdin_raw !== undefined ? kase.stdin_raw : JSON.stringify(hookJson);
      const env = iso.isoEnv(home, {});
      delete env.PMM_RECALL_ROOT; delete env.PMM_TRIGGER_MEM; delete env.PMM_TRIGGER_STATE; delete env.PMM_TRIGGER_LOG;
      if (kase.hook_env) {
        for (const k of Object.keys(kase.hook_env)) env[k] = sub(kase.hook_env[k]);
      }
      const gateInvoke = 'bash "' + GATE_SH.replace(/\\/g, '/') + '"' + (mutantName ? (' --mutant ' + mutantName) : '');
      const wired = gateInvoke + ' || { echo "pmm-isolation-gate 自身故障 — fail-open 放行" >&2; exit 0; }';
      const child = spawn('bash', ['-c', wired], { env });
      let out = ''; let err = ''; let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); finish(null); } }, 15000);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', () => { if (!done) { done = true; clearTimeout(timer); finish(null); } });
      child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); finish(code); } });
      child.stdin.on('error', () => {}); // EPIPE if the gate exits before consuming stdin -- non-fatal
      child.stdin.write(stdinText); child.stdin.end();
      function finish(code) {
        const r = { stdout: out, stderr: err, status: code };
        const denialRoot = (kase.hook_env && kase.hook_env.PMM_RECALL_ROOT) ? sub(kase.hook_env.PMM_RECALL_ROOT) : path.join(home, '.claude', '.local', 'pmm-recall');
        const denialFile = path.join(denialRoot, 'isolation-denials-' + require('os').hostname() + '.tsv');
        let denialRows = 0;
        try {
          const lines = fs.readFileSync(denialFile, 'utf8').split('\n').filter(Boolean);
          denialRows = lines.filter((l) => l.indexOf(toolUseId) !== -1).length;
        } catch { denialRows = 0; }
        try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {}
        resolve({ r, denialRows });
      }
    });
  }

  async function runPool(items, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function lane() {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    }
    const lanes = [];
    for (let i = 0; i < Math.min(CONCURRENCY, items.length); i++) lanes.push(lane());
    await Promise.all(lanes);
    return results;
  }

  // evaluate(kase, r, denialRows) -- v1.5 scoring_v1_5: expect.decision and expect.denial_rows (when
  // present) are the only HARD pass/fail criteria; expect.denied_segments/expect.reason_code are
  // informational only (reported, never fail the case) per contract.conventions.scoring_v1_5
  // (coordinator ruling 2026-09-24, contract v1.5 commit f5ccd984). A case whose note contains
  // "临时预测" carries no informational assertion either (provisional value, not to be diffed at all).
  function evaluate(kase, r, denialRows) {
    const out = r.stdout || ''; const err = r.stderr || ''; const rc = r.status === null ? -1 : r.status;
    const info = [];
    if (kase.expect.decision === 'allow') {
      const problems = [];
      if (!(out === '' && err === '' && rc === 0)) problems.push('expected allow (0/0/0), got out=' + out.length + ' err=' + err.length + ' rc=' + rc);
      if (kase.expect.denial_rows !== undefined && denialRows !== kase.expect.denial_rows) problems.push('denial_rows mismatch want=' + kase.expect.denial_rows + ' got=' + denialRows);
      return { ok: problems.length === 0, detail: problems[0], info };
    }
    let parsed = null;
    try { parsed = JSON.parse(out.trim()); } catch {}
    const isDeny = rc === 0 && err === '' && parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.hookEventName === 'PreToolUse' && parsed.hookSpecificOutput.permissionDecision === 'deny';
    if (!isDeny) return { ok: false, detail: 'expected deny JSON, got out=' + JSON.stringify(out).slice(0, 200) + ' err=' + JSON.stringify(err).slice(0, 100) + ' rc=' + rc, info };
    const reasonText = parsed.hookSpecificOutput.permissionDecisionReason || '';
    const problems = [];
    const provisional = scoringV15 && typeof kase.note === 'string' && kase.note.indexOf('临时预测') !== -1;
    if (kase.expect.reason_code) {
      const ok = reasonText.indexOf('iso-reason=' + kase.expect.reason_code) !== -1;
      if (!ok) {
        const msg = 'reason_code mismatch, reason=' + reasonText.split('\n')[1];
        if (scoringV15) { if (!provisional) info.push(msg); } else problems.push(msg);
      }
    }
    if (kase.expect.denied_segments) {
      const m = reasonText.match(/segments=([0-9,]+)/);
      const got = m ? m[1].split(',').map(Number) : [];
      const want = kase.expect.denied_segments.slice().sort((a, b) => a - b);
      const gotSorted = got.slice().sort((a, b) => a - b);
      if (JSON.stringify(want) !== JSON.stringify(gotSorted)) {
        const msg = 'denied_segments mismatch want=' + JSON.stringify(want) + ' got=' + JSON.stringify(gotSorted);
        if (scoringV15) { if (!provisional) info.push(msg); } else problems.push(msg);
      }
    }
    if (kase.expect.missing) {
      const m = reasonText.match(/missing=([^\s]+)/);
      const got = m ? m[1].split(',') : [];
      const want = kase.expect.missing.slice().sort();
      const gotSorted = got.slice().sort();
      if (JSON.stringify(want) !== JSON.stringify(gotSorted)) {
        const msg = 'missing mismatch want=' + JSON.stringify(want) + ' got=' + JSON.stringify(gotSorted);
        if (scoringV15) { if (!provisional) info.push(msg); } else problems.push(msg);
      }
    }
    if (kase.expect.denial_rows !== undefined && denialRows !== kase.expect.denial_rows) problems.push('denial_rows mismatch want=' + kase.expect.denial_rows + ' got=' + denialRows);
    return { ok: problems.length === 0, detail: problems[0], info };
  }

  const selftestNonce = 'nonce-' + require('crypto').randomBytes(6).toString('hex');
  const footprintSnap = iso.footprint.begin();

  return (async () => {
    const targetCases = opts.caseId ? contract.cases.filter((c) => c.id === opts.caseId) : contract.cases;
    if (opts.caseId && targetCases.length === 0) { console.log('NO SUCH CASE: ' + opts.caseId); return 1; }

    let pass = 0, fail = 0, reported = 0, infoCount = 0; const failIds = [];
    const contractResults = await runPool(targetCases, async (kase) => {
      const { r, denialRows } = await runCaseAsync(kase, undefined);
      return { kase, res: evaluate(kase, r, denialRows) };
    });
    for (const { kase, res } of contractResults) {
      infoCount += (res.info || []).length;
      if (kase.classification === 'report_only') {
        reported++;
        console.log('REPORT_ONLY ' + kase.id + ' observed=' + (res.ok ? 'matches-expect' : ('DIFFERS:' + res.detail)));
        continue;
      }
      if (res.ok) pass++; else { fail++; failIds.push(kase.id + (res.detail ? (':' + res.detail) : '')); }
    }
    console.log('ISOGATE-CONTRACT ' + JSON.stringify({ cases: targetCases.length, pass, fail, report_only: reported, info: infoCount }));
    for (const f of failIds) console.log('FAIL ' + f);

    if (opts.caseId) return fail === 0 ? 0 : 1; // --case: no mutant/footprint pass, single-case debug mode

    let mutantsOk = true;
    for (const mutantName of Object.keys(contract.mutants || {})) {
      if (mutantName === 'scoring') continue;
      const expectedFailing = (contract.mutants[mutantName].expected_failing || []).slice().sort();
      const mutantResults = await runPool(contract.cases.filter((c) => c.classification !== 'report_only'), async (kase) => {
        const { r } = await runCaseAsync(kase, mutantName);
        return { kase, r };
      });
      const actualFailing = [];
      for (const { kase, r } of mutantResults) {
        const out = r.stdout || ''; const err = r.stderr || ''; const rc = r.status === null ? -1 : r.status;
        let observedDecision;
        if (out === '' && err === '' && rc === 0) observedDecision = 'allow';
        else {
          let parsed = null; try { parsed = JSON.parse(out.trim()); } catch {}
          observedDecision = (rc === 0 && err === '' && parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'deny') ? 'deny' : 'other';
        }
        if (observedDecision !== kase.expect.decision) actualFailing.push(kase.id);
      }
      actualFailing.sort();
      const matches = JSON.stringify(actualFailing) === JSON.stringify(expectedFailing);
      if (!matches) mutantsOk = false;
      console.log('ISOGATE-MUTANT ' + JSON.stringify({ mutant: mutantName, expected_failing: expectedFailing, actual_failing: actualFailing, matches }));
    }

    const footprintMarkers = iso.markersFromSource(__filename, selftestNonce, '');
    const fp = iso.footprint.end(footprintSnap, footprintMarkers);
    console.log(fp.line);

    return (fail === 0 && mutantsOk && !fp.red) ? 0 : 1;
  })();
}
// SELFTEST-END

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--self-test') {
    const contractIdx = argv.indexOf('--contract');
    const contractPath = contractIdx !== -1 ? argv[contractIdx + 1] : path.join(__dirname, 'specs', 'isolation-gate-contract.json');
    const caseIdx = argv.indexOf('--case');
    const caseId = caseIdx !== -1 ? argv[caseIdx + 1] : undefined;
    const concIdx = argv.indexOf('--concurrency');
    const concurrency = concIdx !== -1 ? parseInt(argv[concIdx + 1], 10) : undefined;
    return runSelfTestContract(contractPath, { caseId, concurrency });
  }
  // production entry: read stdin, judge, write stdout.
  let mutant;
  const mIdx = argv.indexOf('--mutant');
  if (mIdx !== -1) mutant = argv[mIdx + 1];
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      const res = runHook(text, mutant);
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exit(0);
    } catch (e) {
      process.stderr.write('pmm-isolation-gate 内部异常 — fail-open 放行: ' + (e && e.message) + '\n');
      process.exit(1);
    }
  });
  process.stdin.on('error', () => { process.exit(0); });
}

module.exports = { realHome, computeDutSet, judge, judgeRedirect, findHit, normText };

if (require.main === module) {
  const rc = main();
  if (rc && typeof rc.then === 'function') {
    rc.then((code) => { process.exitCode = code; }).catch((e) => { console.error(e); process.exitCode = 1; });
  } else if (typeof rc === 'number') {
    process.exitCode = rc;
  }
}
