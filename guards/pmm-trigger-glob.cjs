#!/usr/bin/env node
// pmm-trigger-glob.cjs — trigger PATH glob compiler + B5 prefix policy (2026-09-15 round 5 extraction,
// guards/audits/CODEX-2026-09-15-cumulative-review.md MEDIUM-5 / FABLE-2026-09-15-codex-cumulative-
// triage.md R5-7 requirement ③). Pure, side-effect-free leaf module — no require() of pmm-core.cjs or
// pmm-trigger-recall.cjs, and never will (that is the whole point of this file existing).
//
// Why this file exists: this logic used to live INSIDE pmm-trigger-recall.cjs, which pmm-core.cjs
// requires (for checkTriggerPathB5, used by classifyTriggerLine's path-form branch). That created a
// one-directional dependency core.cjs → trigger-recall.cjs which made it IMPOSSIBLE for
// pmm-trigger-recall.cjs to also require pmm-core.cjs back (for classifyTriggerLine / FENCE_RE) without
// a genuine require() cycle — whichever file's require() resolves second gets the OTHER file's
// still-empty (mid-execution) module.exports, silently capturing `undefined` for whatever it imported
// (documented at length in pmm-trigger-recall.cjs's own former comment, and exercised by
// pmm-core-high4b-probe.cjs). That cycle was the root cause of R5-7 (guards/audits/
// FABLE-2026-09-15-codex-cumulative-triage.md): pmm-trigger-recall.cjs's PostToolUse trigger-collection
// scan could not reuse core.parseFile()'s fence-aware classifyTriggerLine, so it kept its own
// unfenced, looser regex — a trigger-comment EXAMPLE inside a ``` fenced code block (invisible to
// parseFile()/the write gate) was still collected and could fire a real push.
//
// Fix: pull the genuinely independent piece (glob compilation + the B5 prefix-length policy) OUT of
// pmm-trigger-recall.cjs into this leaf module. pmm-core.cjs now imports checkTriggerPathB5 from HERE,
// not from pmm-trigger-recall.cjs — so pmm-core.cjs no longer depends on pmm-trigger-recall.cjs AT ALL,
// and pmm-trigger-recall.cjs is free to require('./pmm-core.cjs') for classifyTriggerLine/FENCE_RE with
// zero cycle risk. pmm-trigger-recall.cjs re-exports these same names for full backward compatibility
// with every other caller (pmm-manifest.cjs, pmm-trigger-compat-replay.cjs, the self-tests) that still
// does require('./pmm-trigger-recall.cjs').
'use strict';

// ── glob → regex 编译器(唯一实现,2026-09-15 the maintainer 拍板加 glob;guards/specs/GLOB-TRIGGER-SPEC.md)──
// 今天 9 条中段通配 trigger 静默失效的根因就是「B5 写时闸」与「本引擎的运行时匹配」各写一份
// 「`*` 是什么意思」的判断、各自漂移。修法:本文件导出**唯一**的 compileTriggerPath(),
// pmm-core.cjs 的 B5、pmm-manifest.cjs(现役写入闸)、pmm-trigger-recall.cjs 自己的运行时匹配全部
// import 它,任何地方都不许再写第二份路径形态判断。
//
// 编译规则(按顺序,向后兼容是硬要求——全库 56 条末尾 `*` 前缀式的命中集合一个字节都不能变):
//   1. 整个 pattern 做正则元字符转义,但保留 `*`。
//   2. `**/` → `(?:[^/]+/)*`(零或多个目录层)。
//   3. 余下的 `**` → `.*`(跨段)。
//   4. 余下的单个 `*`:若是整个 pattern 的最后一个字符 → `.*`(跨段,今天的前缀语义);否则 → `[^/]*`(段内)。
//   5. 两端锚定 `^...$`,大小写不敏感(与 relLower 口径一致)。
class TriggerPatternError extends Error {}

// 编译结果按 pattern 缓存(§GLOB-TRIGGER-SPEC.md「每事件会对 83 条逐条匹配,别每次重编」)。
// 缓存成功结果与失败结果(TriggerPatternError 实例),都以 pattern 原文为 key。
const _compileCache = new Map();

// Fable glob HIGH-1 fix (2026-09-15, guards/audits/FABLE-2026-09-15-glob-review-triage.md /
// CODEX-2026-09-15-glob-spec-review.md finding 1): reject any pattern with a leading `*`, backslash,
// drive letter, empty segment, `.`/`..` segment, control char, or (HIGH-3) a form that could never
// match a normalized repo-relative POSIX path. See the dedicated validateTriggerPathContract() below
// (HIGH-3's fix) — it is called before any glob compilation happens, including for star-free literals.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
function validateTriggerPathContract(pattern) {
  if (pattern.indexOf('\\') !== -1) throw new TriggerPatternError('path 含反斜杠(契约=规范化 repo 相对 POSIX 路径,不接受 \\)');
  if (/^[A-Za-z]:/.test(pattern)) throw new TriggerPatternError('path 含盘符(契约=repo 相对路径,不接受绝对 Windows 路径)');
  if (pattern.startsWith('/')) throw new TriggerPatternError('path 以 / 起(契约=repo 相对路径,不接受前导 /)');
  if (pattern.indexOf('//') !== -1) throw new TriggerPatternError('path 含空段(//)');
  if (CONTROL_CHAR_RE.test(pattern)) throw new TriggerPatternError('path 含控制字符');
  if (pattern.endsWith('/')) throw new TriggerPatternError('path 以 / 结尾(目录形态,契约要求指向文件)');
  const segs = pattern.split('/');
  for (const seg of segs) {
    if (seg === '.' || seg === '..') throw new TriggerPatternError(`path 含 . 或 .. 段(${seg})`);
  }
}

function _compileTriggerPathUncached(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) throw new TriggerPatternError('空 path');
  if (pattern === '*' || pattern === '**') throw new TriggerPatternError('拒 path=' + pattern);
  // HIGH-3: the contract check below applies UNIFORMLY to star-bearing AND star-free (literal) forms
  // alike — the old B5 prefix-length rule only ever fired when a `*` was present, so a star-free
  // pattern like `/absolute/file` (or a glob whose literal prefix happens to satisfy the length rule
  // while the REST of the pattern is nonsense, e.g. `src\*`, `C:/*`, `abc//**`) sailed straight through
  // with `ok:true` despite being unable to ever match a normalized repo-relative POSIX event path.
  validateTriggerPathContract(pattern);
  const starAt = pattern.indexOf('*');
  const literalPrefix = starAt === -1 ? pattern : pattern.slice(0, starAt);
  const ESC_RE = /[.*+?^${}()|[\]\\]/g; // 通用转义集;'*' 在下面按 glob 语义单独处理,永远不会落进这个 replace
  // HIGH-1: "trailing `*` means cross-segment `.*`" is the classic single-star-prefix backward-compat
  // rule (`docs/*`, `scripts/itest-*`, … — the 56 pre-existing trigger paths this must stay byte-for-
  // byte compatible with). It must NOT ALSO fire just because some OTHER `*` in the pattern happens to
  // sit last — `src/lib/**/*lock*` compiled its trailing `*` to `.*` under the naive "is this the
  // pattern's last character" test, and that cross-segment `.*` ate straight through a `/`, matching
  // `src/lib/lock-cache/unrelated.ts` (lock in a DIRECTORY name, not the file name the author meant).
  // Fix: cross-segment trailing-star semantics apply ONLY when the ENTIRE pattern contains EXACTLY ONE
  // `*` character total. Any pattern with more than one `*` (including the two making up a `**` token)
  // — every remaining single `*` in it, trailing one included, compiles to `[^/]*` (segment-only).
  const totalStars = (pattern.match(/\*/g) || []).length;
  const trailingStarIsCrossSegment = totalStars === 1;
  // HIGH-2 (2026-09-15, guards/audits/FABLE-2026-09-15-glob-review-triage.md finding 2, empirically
  // reproduced in scratchpad/redos-probe.cjs): each `[^/]*`-style wildcard TOKEN roughly multiplies
  // worst-case backtracking cost on a failing match (measured against 'abc'+80×'a'+'c': 4 tokens=17ms,
  // 5=308ms, 6=4026ms — exponential, matching the audit's reproduction). Count semantic wildcard
  // TOKENS (a `**/`  or bare `**` run counts as ONE token, same as a lone `*` — NOT raw `*` characters,
  // so `src/lib/**/*lock*`'s 3 tokens (`**/`, `*`, `*`) are correctly budgeted, not its 4 raw stars),
  // and bound both that count and the pattern's raw length.
  // CORRECTION (2026-09-15 round 2, Opus O-9, guards/audits/OPUS-2026-09-15-repair-review.md): this
  // comment used to claim these two caps bound match cost "independent of … the candidate event path's
  // length or content" — that is FALSE. They bound only the PATTERN; match time against a long
  // CANDIDATE string still grows ~O(n⁴) for a multi-token pattern (measured: 80 chars=4.1ms, 240
  // chars=308ms), and real repo-relative paths commonly run 100–260 chars. The actual fix is
  // MAX_CANDIDATE_PATH_LEN, enforced in testTriggerPath() below — every production caller must route
  // matching through that function, not call `compiled.re.test()` directly, to get the cap.
  const MAX_PATTERN_LEN = 200;
  const MAX_WILDCARD_TOKENS = 4;
  if (pattern.length > MAX_PATTERN_LEN) throw new TriggerPatternError(`path 过长(>${MAX_PATTERN_LEN} 字符),拒绝以防病态回溯`);
  let wildcardTokenCount = 0;
  {
    let j = 0;
    const jn = pattern.length;
    while (j < jn) {
      if (pattern[j] === '*') {
        wildcardTokenCount++;
        if (pattern.slice(j, j + 3) === '**/') j += 3;
        else if (pattern.slice(j, j + 2) === '**') j += 2;
        else j += 1;
      } else {
        j++;
      }
    }
  }
  if (wildcardTokenCount > MAX_WILDCARD_TOKENS) throw new TriggerPatternError(`path 通配符 token 过多(${wildcardTokenCount} 个 > ${MAX_WILDCARD_TOKENS} 个),拒绝以防病态回溯`);
  let src = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern.slice(i, i + 3) === '**/') { src += '(?:[^/]+/)*'; i += 3; continue; }
      if (pattern.slice(i, i + 2) === '**') { src += '.*'; i += 2; continue; }
      src += (trailingStarIsCrossSegment && i === n - 1) ? '.*' : '[^/]*';
      i += 1; continue;
    }
    src += c.replace(ESC_RE, '\\$&');
    i += 1;
  }
  let re;
  try { re = new RegExp('^' + src + '$', 'i'); }
  catch (e) { throw new TriggerPatternError('regex 编译失败: ' + e.message); }
  return { re, literalPrefix };
}

function compileTriggerPath(pattern) {
  if (_compileCache.has(pattern)) {
    const cached = _compileCache.get(pattern);
    if (cached instanceof TriggerPatternError) throw cached;
    return cached;
  }
  try {
    const result = _compileTriggerPathUncached(pattern);
    _compileCache.set(pattern, result);
    return result;
  } catch (e) {
    if (e instanceof TriggerPatternError) _compileCache.set(pattern, e);
    throw e;
  }
}

// Opus O-9 fix (2026-09-15 round 2): the ONE function every production caller (pmm-trigger-recall's
// own runtime matcher, pmm-trigger-compat-replay's --check) must route a compiled pattern ↔ candidate
// test through — bounds the CANDIDATE string length before ever touching the (possibly multi-token,
// backtracking-prone) regex. A candidate over the cap fails safe as "no match" (this is a reminder
// mechanism, not a gate — a silent miss on a pathologically long path is a far smaller cost than a
// multi-hundred-ms stall on every edit event). 200 is chosen to match MAX_PATTERN_LEN's own bound and
// keeps the worst-case (4-token) match time under ~150ms even on the slowest measured shape.
const MAX_CANDIDATE_PATH_LEN = 200;
function testTriggerPath(compiled, candidateLower) {
  if (typeof candidateLower === 'string' && candidateLower.length > MAX_CANDIDATE_PATH_LEN) return false;
  return compiled.re.test(candidateLower);
}

// B5 前缀策略(写时闸专用政策层,不是编译器的一部分——运行时匹配从不套用这条,只有写入闸套用):
// 带 `*` 的 path,第一个 `*` 之前的字面前缀(直接取自 compileTriggerPath 的返回值,不重新解析
// pattern——这是「零第二份判断」的关键)必须 ≥3 UTF-8 字节且不以 `/` 起。无 `*` 的精确路径不受限。
function checkTriggerPathB5(pattern) {
  let compiled;
  try { compiled = compileTriggerPath(pattern); }
  catch (e) { return { ok: false, reason: e.message }; }
  if (typeof pattern === 'string' && pattern.indexOf('*') !== -1) {
    const lp = compiled.literalPrefix;
    if (lp.startsWith('/')) return { ok: false, reason: 'path 前缀以 / 起' };
    if (Buffer.byteLength(lp, 'utf8') < 3) return { ok: false, reason: '第一个 `*` 之前的字面前缀 <3 字符' };
  }
  return { ok: true, literalPrefix: compiled.literalPrefix };
}

// ── trigger-LINE grammar (2026-09-24 open-core cut extraction) ───────────────────────────────────
// classifyTriggerLine() + its regex/set constants used to live in guards/pmm-core.cjs (the causal
// shadow-memory engine, moved to AxMem Pro / a commercial license, not part of this open-core repo).
// This file already owns the trigger-PATH grammar (compileTriggerPath/checkTriggerPathB5, above) and
// classifyTriggerLine's path-form branch calls checkTriggerPathB5 right here, so the trigger-LINE
// grammar moved into this same leaf module rather than being removed along with the rest of
// pmm-core.cjs — guards/pmm-trigger-recall.cjs (kept, base tier) needs it for the SAME fence-aware,
// authoritative trigger-line classification the write gate uses. Extracted verbatim (byte-identical),
// no behavior change.
const FENCE_RE = /^ {0,3}(```|~~~)/;
const TRIG_P_RE = /^<!--\s*trigger:\s*tool=((?:Edit|Write|MultiEdit|NotebookEdit)(?:\|(?:Edit|Write|MultiEdit|NotebookEdit))*);\s*repo=([a-z0-9-]+);\s*path=(\S+)\s*-->$/;
const TRIG_C_RE = /^<!--\s*trigger:\s*tool=Bash;\s*repo=([a-z0-9-]+|\*);\s*cmd=([a-z0-9._-]+)(?:\s([a-z0-9._:-]+))?\s*-->$/;
const TRIG_NONE_RE = /^<!--\s*trigger:\s*none;\s*理由=(.*?)\s*-->$/;
const TRIGGERISH_RE = /^<!--\s*trigger:/i;
// B5 repo=* exe denylist (§1.2a TRIG_C constraint)
const CMD_DENYLIST = new Set(['git', 'npm', 'npx', 'node', 'bash', 'sh', 'pwsh', 'powershell', 'python', 'py', 'cd', 'ls', 'cat', 'echo', 'rm', 'cp', 'mv']);

// Returns null if `text` is not trigger-comment-shaped at all (caller falls through to its other
// field-line checks); otherwise `{ ok: true, trigger: {...} }` or `{ ok: false, reason: string }`.
function classifyTriggerLine(text) {
  let m;
  if ((m = TRIG_P_RE.exec(text))) {
    const tools = m[1], repo = m[2], p = m[3];
    const b5 = checkTriggerPathB5(p);
    if (b5.ok) return { ok: true, trigger: { kind: 'path', tools: tools.split('|'), repo, path: p } };
    return { ok: false, reason: b5.reason };
  }
  if ((m = TRIG_C_RE.exec(text))) {
    const repo = m[1], exe = m[2], sub = m[3] || null;
    if (repo === '*' && CMD_DENYLIST.has(exe)) {
      return { ok: false, reason: `repo=* 禁配常用 exe=${exe}` };
    }
    return { ok: true, trigger: { kind: 'cmd', tools: ['Bash'], repo, exe, sub } };
  }
  if ((m = TRIG_NONE_RE.exec(text))) {
    const reason = m[1].trim();
    if (reason === '') return { ok: false, reason: 'trigger: none 的理由不得为空(占位式 none 仍算非法 trigger)' };
    return { ok: true, trigger: { kind: 'none', reason } };
  }
  if (TRIGGERISH_RE.test(text)) {
    return { ok: false, reason: 'trigger 注释不合 tool=;repo=;path=|cmd=|none;理由= 形态' };
  }
  return null;
}

module.exports = {
  TriggerPatternError, compileTriggerPath, checkTriggerPathB5, testTriggerPath,
  MAX_CANDIDATE_PATH_LEN, validateTriggerPathContract,
  FENCE_RE, TRIG_P_RE, TRIG_C_RE, TRIG_NONE_RE, TRIGGERISH_RE, CMD_DENYLIST, classifyTriggerLine,
};
