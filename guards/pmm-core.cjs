// pmm-core.cjs — PMM v3 core parser/graph/check/index/diff/ledger library (2026-09-15, C0 build).
// require()-able. No private regex duplicated anywhere else — pmm-manifest-v2.cjs, pmm-migrate-v3.cjs
// and pmm-manifest-shadow.sh all go through this file. Authoritative grammar = guards/specs/PMM-V3-FINAL-SPEC.md
// §1.2a (executable grammar) + §1.4 (fence-aware block/hash rules). Invariant numbers (B1..B31) refer to
// FINAL-SPEC §2. This file is SHADOW-ONLY in C0: it never writes to ~/.claude/memory, never gates anything.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
// B5 trigger path glob (2026-09-15 Jax 拍板加 glob;guards/specs/GLOB-TRIGGER-SPEC.md): the ONLY
// implementation of "what does `*` mean in a trigger path" lives in pmm-trigger-glob.cjs (both the
// write-time B5 gate below and the runtime matching engine import it) — no second regex/judgment here.
// R5-7 fix (2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md MEDIUM-5 /
// FABLE-2026-09-15-codex-cumulative-triage.md R5-7 requirement ③): this used to
// require('./pmm-trigger-recall.cjs') directly, which created a one-directional dependency that made
// it impossible for pmm-trigger-recall.cjs to require pmm-core.cjs back (for
// classifyTriggerLine/FENCE_RE) without a genuine require() cycle — the documented root cause of the
// recall engine's trigger-collection scan never being fence-aware (a trigger EXAMPLE inside a fenced
// code block was still collected and could fire a real push). Import from the leaf module instead
// (pmm-trigger-glob.cjs has zero dependency on this file or pmm-trigger-recall.cjs), so this file no
// longer depends on pmm-trigger-recall.cjs AT ALL and that file is now free to require this one.
const { checkTriggerPathB5 } = require('./pmm-trigger-glob.cjs');
// part13 收口(2026-09-17,fab 盲攻 HIGH-1 家目录解析统一):pmm-recall-ledger.cjs 的 resolveHome()
// 是 conventions.home_resolution 点名的唯一家目录解析器,其它守卫直读 os.homedir()/HOME/
// USERPROFILE 会被 pipe-gate-v2-acceptance.cjs 的 self-check(part13)判红。它和 pmm-trigger-glob.cjs
// 一样是叶子模块(零反向依赖,只用内置 fs/os/path/crypto),此处引入不产生循环 require。
// 命名为 recallLedgerMod(不叫 `ledger`)——本文件下方已有同名的 `function ledger(parsed, graph)`
// 并已导出,撞名会在 module 顶层直接抛 SyntaxError,require 这个文件的每一处都会静默 fail-open。
const recallLedgerMod = require('./pmm-recall-ledger.cjs');

const SCHEMA_VERSION = 3;

// live-file order matters for A4/A7 std pairing and for deterministic iteration.
const LIVE_FILES = ['decisions.md', 'lessons.md', 'standinginstructions.md', 'classes.md'];
const ARCHIVE_FILES = ['decisions-archive.md', 'lessons-archive.md', 'standinginstructions-archive.md'];
const ALL_FILES = [...LIVE_FILES, ...ARCHIVE_FILES];
const ARCHIVE_SET = new Set(ARCHIVE_FILES);
const ATTR_NS = new Set(['user', 'agent', 'system', 'trust']);
// B5 repo=* exe denylist (§1.2a TRIG_C constraint)
const CMD_DENYLIST = new Set(['git', 'npm', 'npx', 'node', 'bash', 'sh', 'pwsh', 'powershell', 'python', 'py', 'cd', 'ls', 'cat', 'echo', 'rm', 'cp', 'mv']);
// B13 lessons.md routing namespaces (from lessons.md header pointer table, kept as a documented
// fallback default — callers should pass the live-parsed set when available; see parseLessonsRoutingNs()).
const LESSONS_ROUTED_NS_DEFAULT = new Set(['axervice', 'rag', 'cold-email', 'upwork']);

// ── grammar (§1.2a) ─────────────────────────────────────────────────────────────────────────────
// §1.7 (Opus H-7): the tag-part (after the colon) allows [A-Za-z0-9._-] — 3 grandfathered uppercase
// tags must remain addressable by [[…]] links/edges. The namespace part (before the colon) stays
// lowercase-only. Identity uniqueness and link/edge resolution are ASCII-lowercase compares
// everywhere (see idKey() below); B8c (new-identity-must-be-lowercase) is the only place case is
// still surfaced, and only as a report against NEW identities.
const TAG_SRC = '[a-z][a-z0-9-]*:[A-Za-z0-9._-]+';
const LOCATOR_SRC = 'archive-sha256:[0-9a-f]{64}';
const TARGET_SRC = `\\[\\[(?:${TAG_SRC}|${LOCATOR_SRC})\\]\\]`;
const TITLE_RE = /^\*\*(20\d\d-\d\d-\d\d)([^*\n]*?)\s+—\s+([^*\n]+?)\*\*(.*)$/;
// loose "looks like a title but isn't" — leading whitespace or a blockquote '>' prefix (B8).
const TITLEISH_RE = /^([ \t]+|>[ \t]*)\*\*(20\d\d-\d\d-\d\d)[^*\n]*\s+—\s+[^*\n]+\*\*/;
// column-0 line that opens like a title (date + em-dash) but never closes with `**` on the same
// line (real legacy-archive form found in this corpus, e.g. decisions-archive.md:21) — also B8.
const TITLE_OPEN_NOCLOSE_RE = /^\*\*(20\d\d-\d\d-\d\d)[^*\n]*\s+—\s+/;
const IDENTITY_IN_TAIL_RE = /\[([A-Za-z][A-Za-z0-9-]*:[A-Za-z0-9._-]+)\]/; // first match; case captured for B8c
const ATTRIB_RE = /^<!--\s*attribution:(.*?)\s*-->$/;
// §1.2a/B5 09-15 revision: the path VALUE is captured loosely here (any non-space run, star anywhere)
// — full validation (star position, path=* rejection, prefix-length rule) happens in code below, not
// in the regex, so a mid-string `*` still matches this regex and gets a SPECIFIC B5 reason instead of
// silently falling through to the generic "trigger 注释不合...形态" catch-all.
const TRIG_P_RE = /^<!--\s*trigger:\s*tool=((?:Edit|Write|MultiEdit|NotebookEdit)(?:\|(?:Edit|Write|MultiEdit|NotebookEdit))*);\s*repo=([a-z0-9-]+);\s*path=(\S+)\s*-->$/;
const TRIG_C_RE = /^<!--\s*trigger:\s*tool=Bash;\s*repo=([a-z0-9-]+|\*);\s*cmd=([a-z0-9._-]+)(?:\s([a-z0-9._:-]+))?\s*-->$/;
// 2026-09-17(Jax 派活,决策 [memory:trigger-plant-at-write-fine-grained]):写时「trigger 在场」闸
// (pmm-trigger-write-gate.cjs)需要一个显式的「判断过、答不出确定性判据、故意不种」逃生口——不是
// 生造第二套 trigger 语法,理由必须非空(空理由=敷衍占位,仍要当非法 trigger 拦,交给下面
// TRIGGERISH_RE 兜底分支处理,本正则不特殊放行)。
const TRIG_NONE_RE = /^<!--\s*trigger:\s*none;\s*理由=(.*?)\s*-->$/;
const TRIGGERISH_RE = /^<!--\s*trigger:/i;
const CLASS_RE = /^Class:\s*\[\[(class:[a-z0-9-]+)\]\]\s*$/;
const CLASSISH_RE = /^\s*Class:/i;
// B23 09-15 revision: `[[ns:tag]]` may be immediately followed by ONE `(说明)` — an explanation of the
// causal context for the supersession, which Jax explicitly wants preserved rather than stripped —
// still separated by `·`/`,` for multiple targets. A bare qualifier BEFORE the bracket (e.g. "澄清
// [[tag]]") is NOT covered by this — the item must START with `[[tag]]`, so prose before the first
// bracket still fails the whole-line match and correctly falls through to B23 (must move into parens).
const SUPERS_ITEM_SRC = `\\[\\[${TAG_SRC}\\]\\](?:\\([^()\\n]*\\))?`;
const SUPERS_RE = new RegExp(`^Supersedes:\\s*(${SUPERS_ITEM_SRC}(?:\\s*[·,]\\s*${SUPERS_ITEM_SRC})*)\\s*$`);
const SUPERSISH_RE = /^Supersedes:/;
const CAUSE_RE = new RegExp(`^Cause:\\s*(${TARGET_SRC}(?:\\s*[·,]\\s*${TARGET_SRC})*)\\s*$`);
const FOLLOWS_RE = new RegExp(`^Follows:\\s*(${TARGET_SRC}(?:\\s*[·,]\\s*${TARGET_SRC})*)\\s*$`);
const HOOK_RE = /^Hook:\s(\S[^\r\n]*)$/;
const BANNER_RE = /^Banner:\s(\S[^\r\n]*)$/;
const RULES_RE = new RegExp(`^Rules:\\s*(\\[\\[${TAG_SRC}\\]\\](?:\\s*\\[\\[${TAG_SRC}\\]\\])*)\\s*$`);
const LINK_G_RE = new RegExp(`\\[\\[(${TAG_SRC}|${LOCATOR_SRC})\\]\\]`, 'g');
const TARGET_G_RE = new RegExp(`\\[\\[((?:${TAG_SRC}|${LOCATOR_SRC}))\\]\\]`, 'g'); // capturing (embed sites use non-capturing TARGET_SRC)
const BACKTICK_SPAN_RE = /`[^`]*`/g;
const H2_RE = /^## /;
const H3_RE = /^### /;
const INDEX_HEADING_RE = /^(##|###) Index\b/;
const FENCE_RE = /^ {0,3}(```|~~~)/;

// ── PMM-CORE-ERROR (Opus B-4): core throws instead of silently returning null/empty on any read
// failure (git show, fs read, unresolvable ref, empty/incomplete snapshot). Callers (CLI shells)
// catch this and print `PMM-CORE-ERROR <reason>` + exit non-zero — never "blocking=0 exit 0".
class PmmCoreError extends Error {
  constructor(reason) { super(reason); this.name = 'PmmCoreError'; this.pmmCore = true; }
}

// ASCII-lowercase identity/link comparison key (§1.7, Opus H-7). Tag-part may carry grandfathered
// uppercase; identity uniqueness and all Supersedes/Cause/Follows target resolution normalize here.
function idKey(id) { return id == null ? id : id.toLowerCase(); }

function utf8ByteLength(s) { return Buffer.byteLength(s, 'utf8'); }
function hasControlChar(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0 && c <= 0x1f) || c === 0x7f) return true;
  }
  return false;
}
function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// ── byte-exact line splitting (safe for multi-byte UTF-8: 0x0A/0x0D never appear inside a
//    continuation byte of a valid UTF-8 sequence) ──────────────────────────────────────────────
function splitLinesBytes(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      let contentEnd = i;
      let crlf = false;
      if (i > start && buf[i - 1] === 0x0d) { contentEnd = i - 1; crlf = true; }
      lines.push({ startByte: start, contentEndByte: contentEnd, endByte: i + 1, crlf });
      start = i + 1;
    }
  }
  if (start < buf.length) lines.push({ startByte: start, contentEndByte: buf.length, endByte: buf.length, crlf: false, noTerm: true });
  return lines;
}

function stripBOM(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { buf: buf.slice(3), hadBOM: true };
  return { buf, hadBOM: false };
}

// ── link extraction from a prose line: strip backtick spans first, then take TAG|LOCATOR [[..]] ─
function extractLinks(text) {
  const stripped = text.replace(BACKTICK_SPAN_RE, '');
  const out = [];
  let m;
  LINK_G_RE.lastIndex = 0;
  while ((m = LINK_G_RE.exec(stripped))) out.push(m[1]);
  return out;
}
// bare `[[x]]` without a valid namespace:name / locator shape (B15) — scan stripped text for any
// `[[...]]` span and flag ones that don't match TARGET_SRC.
const ANY_DOUBLE_BRACKET_RE = /\[\[([^\]]*)\]\]/g;
function findBareLinks(text) {
  const stripped = text.replace(BACKTICK_SPAN_RE, '');
  const out = [];
  let m;
  ANY_DOUBLE_BRACKET_RE.lastIndex = 0;
  while ((m = ANY_DOUBLE_BRACKET_RE.exec(stripped))) {
    const inner = m[1];
    if (!new RegExp(`^(?:${TAG_SRC}|${LOCATOR_SRC})$`).test(inner)) out.push(inner);
  }
  return out;
}

// ── git-backed snapshot ─────────────────────────────────────────────────────────────────────────
// worktree: fs reads from PMM_MEM_DIR (default $HOME/.claude/memory).
// HEAD/:0 : `git -C <gitHome> show <ref>:.claude/memory/<file>` (gitHome default $HOME).
function homeDir() {
  // part13 收口(2026-09-17):PMM_GIT_HOME 是本文件专属的 git 仓库位置覆盖(`git -C <gitHome> ...`
  // 用它——回答"git 仓库在哪",不是"我的家目录是哪",两个问题,保留这个专属覆盖不并进
  // resolveHome())。没设时的兜底不再自己直读 HOME/USERPROFILE,收敛到 ledger.resolveHome()
  // (PMM_HOME > USERPROFILE > HOME > os.homedir(),唯一被允许直读这些的解析器)。
  const g = process.env.PMM_GIT_HOME;
  if (typeof g === 'string' && g.trim() !== '') return g.replace(/\\/g, '/');
  return String(recallLedgerMod.resolveHome() || '.').replace(/\\/g, '/');
}
function memDir() {
  return (process.env.PMM_MEM_DIR || (homeDir() + '/.claude/memory')).replace(/\\/g, '/');
}
function memRelPrefix() {
  return process.env.PMM_MEM_REL || '.claude/memory';
}

// ── shared canonical-path containment check (2026-09-17, fab 盲攻 HIGH-2 + Opus 复现;Jax 铁律
// 「基建先抄开源再优化」——vendor 现成实现而非手写判「在前缀内」,调查见
// C:SERS<USER>\Desktop\axmem\docs\audits\OSS-CANDIDATES-2026-09-17.md §5)──────────────────────
// pmm-trigger-write-gate.cjs 此前只做 `\→/` + 盘符小写就直接字符串前缀比对,对 `\\?\C:\…`
// (Windows 扩展/设备命名空间前缀)、`C://Users/…`(双斜杠)、canonical 前缀内嵌 `/./` 三种形态
// 均误判"不在 canonical 内"而放行(exit 0);pmm-entry-length-watch.sh 的宽松子串匹配"碰巧"没被
// 这三招绕过,但那不是设计出来的正确,是另一种脆弱(它反过来可能对已经 `../` 跳出 canonical 的
// 路径产生假阳性)。两处不该各自维护一份"是否在目录内"的逻辑——收敛到这一个函数,两闸都改叫它。
//
// 前缀剥离条件取自 jonschlinkert/normalize-path v3.0.0 index.js 第 19-27 行(MIT,
// https://github.com/jonschlinkert/normalize-path/blob/3.0.0/index.js)判断 Windows 扩展/设备
// 命名空间前缀(`\\?\` 或 `\\.\`)的边界条件(len>4 且 path[3]==='\\' 且 path[2] 是 '?'/'.' 且
// 开头两字符是 '\\\\')——该库检出后把它转写成 `//?/` 形式**保留**(它的目标是跨平台 glob 归一化,
// 不是剥掉这个有真实语义的前缀);这里的目标不同(要能和一个不带该前缀的 canonical 目录直接
// 比较),检出后改成把 4 个字符整段剥掉,不保留 `//?/` 标记。
function stripWin32DeviceNamespacePrefix(p) {
  const s = String(p);
  if (s.length > 4 && s[3] === '\\' && (s[2] === '?' || s[2] === '.') && s.slice(0, 2) === '\\\\') {
    return s.slice(4);
  }
  return s;
}
// MEDIUM-N3 (2026-09-17/18, Opus 增量核冻结 cb70d64): `\\?\UNC\<host>\<letter>$\...` is Windows'
// device-namespace form of a UNC path to an ADMINISTRATIVE SHARE (`\\<host>\<letter>$\...` — the
// hidden per-drive share every machine exposes). When <host> is THIS machine (localhost / 127.0.0.1
// / "." / the live os.hostname()), that share is just the local drive under a different spelling —
// `\\?\UNC\localhost\c$\Users\x\...` reaches the exact same file as `C:\Users\x\...` and must not
// sail past isUnderCanonical() as "a different, out-of-scope host". Must run BEFORE
// stripWin32DeviceNamespacePrefix() (which only knows the plain `\\?\C:\...` shape and would mangle
// this one) — must match the FULL `\\?\UNC\...` prefix while it is still intact. A genuinely REMOTE
// host's admin share is a different machine's filesystem and is deliberately left untouched (return
// the input unchanged) rather than treated as interchangeable with a local drive letter.
// M-2 fix (2026-09-23, guards/audits/OPUS-2026-09-23-a2-a5-review.md M-2; confirmed — 5 more spellings
// of "this machine's own admin share" ALLOWed and LANDED in canonical: an IPv6-loopback UNC literal
// `\\0--1.ipv6-literal.net\c$\...`, a real LAN IP bound to this host `\\10.0.0.1\c$\...`, and the
// `\\.\UNC\...` device-namespace spelling; the forward-slash device forms `//?/UNC/...`/`//./UNC/...`
// were ALSO reachable via the Edit path specifically, root-caused separately below). isLocal used to be
// a fixed enumeration of exactly 4 literal strings (localhost/127.0.0.1/"."/one os.hostname() value) —
// every OTHER valid way to address this same machine (any 127.0.0.0/8 loopback address, ::1 and its
// Windows ipv6-literal spelling, EVERY address actually bound to a real interface on this host in either
// address family, and a hostname differing from os.hostname() only by case or FQDN-vs-short-name) sailed
// past it as "a different, out-of-scope host" even though each one reaches the exact same local file.
function ipv6ToUncLiteral(addr) {
  // Windows UNC IPv6-literal convention (used in \\<literal>\share\... paths): ':' -> '-', a zone id
  // suffix '%eth0' -> 's'eth0, fixed '.ipv6-literal.net' suffix. A NetBIOS/DNS label cannot START with
  // '-', which the naive substitution above produces for any address beginning with '::' (e.g. the
  // loopback address itself) -- Windows prepends a literal '0' in that case, so '::1' becomes
  // '0--1.ipv6-literal.net', not '--1.ipv6-literal.net' (confirmed against
  // guards/audits/OPUS-2026-09-23-a2-a5-review.md M-2's own empirically-verified test case). Build-
  // direction only (never parses a literal back into an address — not needed here, only membership in
  // a built alias SET is).
  let s = String(addr).toLowerCase().replace(/%/g, 's').replace(/:/g, '-');
  if (s.charAt(0) === '-') s = '0' + s;
  return s + '.ipv6-literal.net';
}
function localHostAliasSet() {
  const set = new Set(['localhost', '.']);
  try {
    const hn = String(os.hostname() || '').toLowerCase();
    if (hn) {
      set.add(hn);
      const dot = hn.indexOf('.');
      if (dot > 0) set.add(hn.slice(0, dot)); // os.hostname() is an FQDN -> also accept its short form
    }
  } catch { /* os.hostname() failing must never widen or narrow this set unpredictably — just skip it */ }
  try {
    const ifaces = os.networkInterfaces() || {};
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] || []) {
        const addr = String((info && info.address) || '').toLowerCase();
        if (!addr) continue;
        set.add(addr);
        if ((info && info.family === 'IPv6') || addr.indexOf(':') !== -1) set.add(ipv6ToUncLiteral(addr));
      }
    }
  } catch { /* os.networkInterfaces() failing must never widen or narrow this set unpredictably */ }
  set.add(ipv6ToUncLiteral('::1'));
  set.add(ipv6ToUncLiteral('0:0:0:0:0:0:0:1')); // fully-expanded loopback spelling some tools emit
  return set;
}
// isLocalHost(): the ONE place that answers "does this UNC/admin-share host token refer to THIS
// machine" — normalizeWin32UncAdminShare() below and the L-6 remote-UNC perf short-circuit in
// isUnderCanonical() both call this, so there is exactly one enumeration of "what counts as local", not
// two that can silently drift apart.
function isLocalHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // 127.0.0.0/8 — the WHOLE /8 is loopback
  const aliases = localHostAliasSet();
  if (aliases.has(h)) return true;
  const dot = h.indexOf('.');
  if (dot > 0 && aliases.has(h.slice(0, dot))) return true; // h is an FQDN; its short form is a known local alias (or vice versa, since the set already carries os.hostname()'s own short form)
  return false;
}
function normalizeWin32UncAdminShare(p) {
  const s = String(p);
  // M-2(d): widened from `\\?\UNC\...` only to ALSO accept `\\.\UNC\...` — both are Windows device-
  // namespace spellings of the same UNC admin-share path; before this fix, `\\.\UNC\localhost\c$\...`
  // fell through to stripWin32DeviceNamespacePrefix() below, which blindly strips the 4-char `\\.\ `
  // prefix and leaves a bare `UNC\localhost\c$\...` that path.resolve() then glues onto whatever cwd
  // the caller happens to have — nothing here recognizes it as an admin share at all.
  let m = /^\\\\[?.]\\UNC\\([^\\]+)\\([A-Za-z])\$(\\.*)?$/i.exec(s);
  let host, drive, rest;
  if (m) {
    host = m[1]; drive = m[2]; rest = m[3];
  } else {
    // MEDIUM-1 fix (2026-09-23, guards/audits/OPUS-2026-09-23-fab-delta-triage.md MEDIUM-1; confirmed
    // — `\\localhost\C$\...`, `\\127.0.0.1\C$\...` and the forward-slash form `//localhost/C$/...` all
    // ALLOWed and the write LANDED in canonical, because only the `\\?\UNC\...` device-namespace SPELLING
    // of a local admin share was recognized above). The plain (non-device-namespace) admin-share form
    // reaches the exact same local file as `\\?\UNC\...` does and is the MORE common way to spell it —
    // `95b8fc3` already established the precedent that "this machine's own admin share == a local drive
    // letter" is this gate's job to recognize, it just didn't cover this spelling of it yet. The negative
    // lookahead `(?![?.][\\/])` deliberately excludes `\\?\...`/`\\.\...` device-namespace prefixes —
    // those are handled by the branch above (or, if genuinely a plain `\\?\C:\...` device path with no
    // `UNC\` component, by stripWin32DeviceNamespacePrefix() further down the pipeline) — so this branch
    // never double-processes a device-namespace path under a second, subtly different regex.
    const m2 = /^[\\/]{2}(?![?.][\\/])([^\\/]+)[\\/]([A-Za-z])\$([\\/].*)?$/.exec(s);
    if (!m2) return s;
    host = m2[1]; drive = m2[2]; rest = m2[3];
  }
  if (!isLocalHost(host)) return s;
  return drive.toUpperCase() + ':' + (rest || '\\');
}
// MEDIUM-2 fix (2026-09-23, guards/audits/OPUS-2026-09-23-fab-delta-triage.md MEDIUM-2; confirmed —
// `lessons.md::$DATA` and `lessons.md::$data` both ALLOWed and the write LANDED in the real canonical
// file): the DEFAULT, UNNAMED NTFS data stream — written explicitly as `<file>::$DATA` or `<file>:$DATA`
// — addresses the EXACT SAME bytes as `<file>` with no suffix at all (NTFS treats a bare filename as an
// implicit reference to its own unnamed stream); it is the same "same file, different spelling" bypass
// class MEDIUM-N3 already closed for trailing dot/space and admin-share UNC forms, just one spelling this
// gate hadn't seen yet. A GENUINELY named alternate stream (`<file>:foo`) is DIFFERENT content living
// alongside the file, not an alias for it — stripping that one would make every later check (ALL_FILES
// membership, core.parseFile()) treat an unrelated stream write as if it were a canonical-file write, so
// it is deliberately left untouched: it falls out of scope naturally because its (unstripped) basename
// does not match any of core.ALL_FILES, exactly the same "correctly permissive" outcome canonical-outside
// paths already get. Only the LAST path segment is touched — streams attach to a file component, never a
// directory component.
function stripWin32AdsSuffix(p) {
  const s = String(p);
  const lastSep = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const dir = lastSep === -1 ? '' : s.slice(0, lastSep + 1);
  const last = lastSep === -1 ? s : s.slice(lastSep + 1);
  const ci = last.indexOf(':');
  if (ci === -1) return s;
  const base = last.slice(0, ci);
  const stream = last.slice(ci); // includes the leading ':' (":$DATA" or "::$DATA" or a genuine ":name")
  if (!/^:?:\$data$/i.test(stream)) return s; // a genuinely different named stream — leave untouched
  return dir + base; // default data stream — same bytes as the bare file, strip the suffix entirely
}
// MEDIUM-N3: Windows silently strips trailing '.' and ' ' characters from the FINAL path component
// when resolving a file/directory for real I/O (a legacy DOS/CreateFile compatibility quirk) —
// `lessons.md.` and `lessons.md ` (and any mix, `lessons.md. . `) on disk are both literally
// `lessons.md`. path.win32.normalize() does NOT implement this (confirmed: it leaves a trailing `.`
// or space on the last segment untouched), so without this step a write to `lessons.md.` reads as a
// DIFFERENT basename than the real `core.ALL_FILES` entry it silently becomes on disk, and the gate
// treats it as out-of-scope. Only the LAST segment is touched (per Windows semantics — intermediate
// directory names are not silently corrected the same way in practice); a segment that IS ENTIRELY
// `.`/`..`/empty keeps its traversal meaning and is left alone (path.win32.normalize() resolves
// those correctly on its own — stripping them here would corrupt `..` into nothing).
function stripWin32TrailingDotSpace(p) {
  const s = String(p);
  const lastSep = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const dir = lastSep === -1 ? '' : s.slice(0, lastSep + 1);
  const last = lastSep === -1 ? s : s.slice(lastSep + 1);
  if (last === '.' || last === '..' || last === '') return s;
  const stripped = last.replace(/[. ]+$/, '');
  return stripped === '' ? s : dir + stripped;
}
// domenic/path-is-inside v1.0.2(WTFPL/MIT 双许可)vendor 于 ./vendor/path-is-inside.cjs ——
// 不用简单的 startsWith(canonical+'/') 手写前缀比对,用它经过测试的边界处理(尾斜杠归一、
// Windows 大小写折叠、防止 '/foo/barbaz' 误判成在 '/foo/bar' 内的边界字符检查)。
const pathIsInside = require('./vendor/path-is-inside.cjs');
// normalizeWin32PathForCompareOnce(): a SINGLE pass of the pipeline (UNC-admin-share needs the
// untouched `\\?\UNC\...`/`\\.\UNC\...` prefix; device-namespace strip runs next for the plain
// `\\?\C:\...`/`\\.\C:\...` shape the UNC step doesn't touch; ADS-suffix strip runs on the now-
// un-prefixed last segment so a stray device/UNC prefix never confuses its own last-segment split;
// trailing dot/space is last-segment-only too and must see the already-ADS-stripped name so
// `lessons.md.::$DATA` style stacking resolves correctly; path.win32.normalize closes it out). Slashes
// are unified to `\` FIRST (M-2(b)/(d)) — the UNC-admin-share/device-namespace detectors above are all
// anchored on an EXACT leading `\\` and never recognized a forward-slash spelling
// (`//?/UNC/...`/`//./UNC/...`), so without this step those forms sailed through this ENTIRE function
// untouched on a single pass; path.win32.normalize() itself would eventually convert the slashes, but
// only as its own LAST step, by which point the admin-share/device detectors earlier in this same pass
// have already run and found nothing to do.
function normalizeWin32PathForCompareOnce(p) {
  const unified = String(p).replace(/\//g, '\\');
  return path.win32.normalize(stripWin32TrailingDotSpace(stripWin32AdsSuffix(stripWin32DeviceNamespacePrefix(normalizeWin32UncAdminShare(unified)))));
}
// M-2(b) fix (2026-09-23, guards/audits/OPUS-2026-09-23-a2-a5-review.md M-2 root cause b; confirmed —
// `//?/UNC/localhost/c$/...` needed a SECOND call to fully resolve to `C:\...`, and this function was
// only ever called once per comparison): normalizeWin32PathForCompareOnce() is not idempotent in one
// specific case — a forward-slash device-namespace form gets its slashes unified and normalized to
// `\\?\UNC\...` by ITS OWN path.win32.normalize() step, but that happens AFTER this same pass's
// normalizeWin32UncAdminShare() call already ran (and found nothing, since the input was still
// forward-slash at that point) — the now-recognizable `\\?\UNC\...` form only gets converted to
// `C:\...` on a SECOND pass. Loop to a fixed point (bounded — this pipeline can only ever take 2 passes
// to stabilize for any known input shape; 5 is a generous safety margin, never an infinite loop).
// Exported so callers needing a normalized `fp` for basename/fs use (not just the boolean
// isUnderCanonical()/matchCanonical() checks) get the identical, fully-stabilized pipeline.
function normalizeWin32PathForCompare(p) {
  let s = String(p);
  for (let i = 0; i < 5; i++) {
    const next = normalizeWin32PathForCompareOnce(s);
    if (next === s) return next;
    s = next;
  }
  return s; // hit the iteration cap without stabilizing — return the best-effort result, never loop forever
}
// codex#8 fix (2026-09-23, guards/audits/OPUS-2026-09-23-codex-final-triage.md #8; confirmed — a
// junction placed OUTSIDE canonical whose reparse target IS canonical ALLOWed and the write LANDED in
// the real canonical file): every step above is purely LEXICAL string manipulation — none of it ever
// asks the filesystem what a path ACTUALLY resolves to, so an NTFS reparse point (junction/symlink) is
// completely invisible to it. realpathForCompare() answers "what does this path resolve to on disk
// right now": if the target itself exists, fs.realpathSync.native() resolves the WHOLE chain including
// any reparse points along the way in one call. If it does not exist yet (the common case for a Write
// creating a new file, or an Edit's target that legitimately doesn't exist), there is nothing for
// realpath to resolve directly — walk up to the nearest EXISTING ancestor directory, resolve that (which
// still resolves any reparse point earlier in the chain), and re-attach ALL the still-nonexistent tail
// segments unchanged (they cannot themselves be reparse points if they don't exist) — L-3 fix
// (guards/audits/OPUS-2026-09-23-a2-a5-review.md L-3; confirmed — the walk-up loop used to overwrite a
// single `tailSeg` variable each iteration instead of accumulating every segment it passed on the way
// up, so `memory\a\b\c\lessons.md` (only `memory` existing) returned `…\memory\a` instead of
// `…\memory\a\b\c\lessons.md`, silently dropping `b\c\lessons.md`; correctness of isUnderCanonical()
// itself was unaffected by this — when canonical exists and the tail doesn't, "prefix is inside" iff
// "full path is inside" either way — but this function is exported for other callers to use as a real
// path/basename, and any of them would have silently gotten a truncated result).
function realpathForCompare(p) {
  const s = String(p);
  try {
    return fs.realpathSync.native(s);
  } catch {
    let cur = s;
    const tail = [];
    for (let i = 0; i < 64; i++) {
      const parent = path.dirname(cur);
      if (parent === cur) return s; // reached a root (e.g. "C:\\") without finding anything real — give up, lexical form
      tail.unshift(path.basename(cur));
      try {
        const real = fs.realpathSync.native(parent);
        return real + path.sep + tail.join(path.sep);
      } catch {
        cur = parent; // parent doesn't exist either — keep walking up toward the nearest real ancestor
      }
    }
    return s; // hit the walk-up cap without finding a real ancestor — fall back to the lexical form
  }
}
// extractUncHost(): the bare host token out of a (already normalizeWin32PathForCompare()-passed, so
// backslash-unified) UNC-shaped path — `\\<host>\...` directly, or, for a device-namespace UNC form
// that normalizeWin32UncAdminShare() did NOT rewrite (i.e. a genuinely remote admin share, or a
// device-namespace UNC path to a non-admin share), the host inside `\\?\UNC\<host>\...`/
// `\\.\UNC\<host>\...`. Returns null for anything that isn't UNC-shaped at all (a plain drive-letter
// path, or a bare `\\?\C:\...`/`\\.\C:\...` device path with no UNC component).
function extractUncHost(p) {
  const s = String(p);
  const dev = /^\\\\[?.]\\UNC\\([^\\]+)\\/i.exec(s);
  if (dev) return dev[1];
  const plain = /^\\\\([^\\]+)\\/.exec(s);
  if (plain && plain[1] !== '?' && plain[1] !== '.') return plain[1];
  return null;
}
// resolveCanonicalMatch(): THE ONE place that decides whether `fp` targets something inside
// `canonical`, and (L-4 fix, guards/audits/OPUS-2026-09-23-a2-a5-review.md L-4) WHICH resolved path
// form proved it — isUnderCanonical() (boolean) and matchCanonical() (basename-aware, for
// pmm-trigger-write-gate.cjs) both call this instead of each maintaining its own copy of the
// lexical/realpath/hardlink match logic.
function resolveCanonicalMatch(fp, canonical) {
  const canonNorm = normalizeWin32PathForCompare(canonical);
  const canonLower = canonNorm.toLowerCase();
  const lexNorm = normalizeWin32PathForCompare(fp);
  const lexLower = lexNorm.toLowerCase();
  if (lexLower === canonLower || pathIsInside(lexLower, canonLower)) {
    return { via: 'lexical', resolved: lexNorm };
  }
  // L-6 perf fix (guards/audits/OPUS-2026-09-23-a2-a5-review.md L-6; confirmed — a single scope
  // decision on an unreachable UNC host took 2.7s (a DNS-shaped name) to 21s (an unreachable LAN IP),
  // because fs.realpathSync.native() below has to wait for the network stack to give up before it can
  // report "doesn't exist"): a UNC path whose host is NOT this machine can never resolve, via realpath,
  // back into a LOCAL canonical directory — Windows has no reparse mechanism that crosses machines — so
  // there is nothing for a filesystem call to usefully discover for a genuinely remote host. Skip
  // straight to "not matched here" for a remote UNC host; only a local-looking path (a drive letter, or
  // a UNC host that IS this machine — which normalizeWin32PathForCompare() above would already have
  // rewritten to a drive letter, so a UNC prefix still being present here at all means either a
  // genuinely remote host, or a local non-admin-share UNC path, which isLocalHost() distinguishes) pays
  // the realpath/stat cost below.
  const uncHost = extractUncHost(lexNorm);
  const remoteUnc = uncHost !== null && !isLocalHost(uncHost);
  if (!remoteUnc) {
    // codex#8: judge the RESOLVED (reparse-point-aware) form too — a junction/symlink that lexically
    // looks out-of-scope but actually resolves back inside canonical must be denied the same as a direct
    // write would be (fail-closed toward "still in scope"); this never widens an ALLOW into a DENY for a
    // genuinely unrelated path, since that path's resolved form won't land inside canonical either.
    try {
      const realFp = realpathForCompare(fp);
      const realCanon = realpathForCompare(canonical);
      const realFpNorm = normalizeWin32PathForCompare(realFp);
      const realCanonNorm = normalizeWin32PathForCompare(realCanon);
      const realFpLower = realFpNorm.toLowerCase();
      const realCanonLower = realCanonNorm.toLowerCase();
      if (realFpLower === realCanonLower || pathIsInside(realFpLower, realCanonLower)) {
        return { via: 'realpath', resolved: realFpNorm };
      }
    } catch { /* realpath resolution failing must never itself flip an in-scope path to out-of-scope */ }
    // L-4 fix: a hard link (`mklink /H`, no elevation required) shares the SAME inode/MFT record as its
    // target; there is no reparse point for realpath to resolve and no privileged "original" side of a
    // hard link, so a hard-linked write to lessons.md through an unrelated-looking path is invisible to
    // both checks above but changes the EXACT SAME bytes on disk. When the target exists and has
    // nlink>1, compare its (dev, ino) against every entry directly inside canonical — a match means
    // this path and a real canonical entry are the same file on disk, regardless of what either path
    // string says.
    try {
      const st = fs.statSync(fp);
      if (st.nlink > 1) {
        let names = [];
        try { names = fs.readdirSync(canonical); } catch { names = []; }
        for (const name of names) {
          try {
            const cst = fs.statSync(path.join(canonical, name));
            if (cst.dev === st.dev && cst.ino === st.ino) {
              return { via: 'hardlink', resolved: path.join(canonical, name) };
            }
          } catch { /* an unreadable canonical entry must never crash this loop or flip the verdict */ }
        }
      }
    } catch { /* fp not stat-able (doesn't exist, or a stream/reparse form stat can't open) — nothing to compare */ }
  }
  return { via: null, resolved: null };
}
function isUnderCanonical(fp, canonical) {
  if (!fp || !canonical) return false;
  return resolveCanonicalMatch(fp, canonical).via !== null;
}
// matchCanonical(): for callers (pmm-trigger-write-gate.cjs) that need not just "is this in scope" but
// ALSO the basename to compare against core.ALL_FILES and the RESOLVED path to actually read from disk
// — L-4 fix: when the match came from realpath or a hard link, the basename must come from the
// RESOLVED path, not the original lexical `fp` (a symlink/junction/hard link can legitimately have a
// completely different name than the canonical file it resolves to); using resolvedPath for the
// subsequent fs.readFileSync also sidesteps M-2 root cause (c) — the caller no longer needs its own
// fragile `fp.replace(/\\/g,'/').replace(/\/{2,}\//g,'/')` collapse (which mangled a UNC path's
// required leading `\\` into a single `\`, breaking readFileSync for every UNC-shaped in-scope path).
function matchCanonical(fp, canonical) {
  if (!fp || !canonical) return { inScope: false, basename: null, resolvedPath: null, via: null };
  const m = resolveCanonicalMatch(fp, canonical);
  if (!m.via) return { inScope: false, basename: null, resolvedPath: null, via: null };
  const r = m.resolved;
  const basename = r.slice(Math.max(r.lastIndexOf('/'), r.lastIndexOf('\\')) + 1).toLowerCase();
  return { inScope: true, basename, resolvedPath: r, via: m.via };
}

function readFileRawWorktree(file) {
  const p = memDir() + '/' + file;
  try { return fs.readFileSync(p); } catch { return null; }
}
function readFileRawGit(ref, file) {
  const gitHome = homeDir();
  const rel = memRelPrefix() + '/' + file;
  try {
    return execFileSync('git', ['-C', gitHome, 'show', `${ref}:${rel}`], { maxBuffer: 1024 * 1024 * 64 });
  } catch {
    return null;
  }
}
function treeOid(ref) {
  const gitHome = homeDir();
  try {
    return execFileSync('git', ['-C', gitHome, 'rev-parse', `${ref}:${memRelPrefix()}`], { maxBuffer: 1024 * 1024 }).toString().trim();
  } catch { return null; }
}
function headCommitOid() {
  const gitHome = homeDir();
  try { return execFileSync('git', ['-C', gitHome, 'rev-parse', 'HEAD'], { maxBuffer: 1024 * 1024 }).toString().trim(); }
  catch { return null; }
}

// snapshot(view) → { view, files: { <file>: {raw:Buffer, hadBOM, missing} }, sourceOids }
// opts.requireAll (default true, Opus B-4): any missing/unreadable file, or an unresolvable git ref,
// throws PmmCoreError instead of silently returning a snapshot with holes in it. Pass
// {requireAll:false} only for callers that intentionally read a partial/synthetic corpus.
function snapshot(view, opts) {
  opts = opts || {};
  const requireAll = opts.requireAll !== false;
  if (view !== 'worktree') {
    const oid = treeOid(view);
    if (oid == null && requireAll) {
      throw new PmmCoreError(`git rev-parse 无法解析 ${view}:${memRelPrefix()}(无效 ref 或树不存在)`);
    }
  }
  const files = {};
  const missing = [];
  for (const f of ALL_FILES) {
    let raw = null;
    if (view === 'worktree') raw = readFileRawWorktree(f);
    else raw = readFileRawGit(view, f);
    if (raw == null) { files[f] = { raw: null, missing: true }; missing.push(f); continue; }
    const { buf, hadBOM } = stripBOM(raw);
    files[f] = { raw: buf, hadBOM, missing: false, rawWithBOM: raw };
  }
  if (missing.length && requireAll) {
    throw new PmmCoreError(`快照缺失文件(${view}): ${missing.join(', ')}`);
  }
  const sourceOids = { view };
  if (view === 'worktree') sourceOids.treeOid = null;
  else sourceOids.treeOid = treeOid(view);
  if (view === 'HEAD') sourceOids.commitOid = headCommitOid();
  return { view, files, sourceOids, missing };
}

// snapshot from an explicit directory (used by migrate --apply/--verify on a --dir copy).
// opts.requireAll (default true, Opus B-4): see snapshot() above — same contract.
function snapshotDir(dir, opts) {
  opts = opts || {};
  const requireAll = opts.requireAll !== false;
  const files = {};
  const missing = [];
  for (const f of ALL_FILES) {
    const p = (dir.replace(/\\/g, '/')) + '/' + f;
    let raw;
    try { raw = fs.readFileSync(p); } catch (e) { files[f] = { raw: null, missing: true }; missing.push(f); continue; }
    const { buf, hadBOM } = stripBOM(raw);
    files[f] = { raw: buf, hadBOM, missing: false, rawWithBOM: raw };
  }
  if (missing.length && requireAll) {
    throw new PmmCoreError(`--dir 快照缺失文件(${dir}): ${missing.join(', ')}`);
  }
  return { view: 'dir:' + dir, files, sourceOids: { view: 'dir', dir }, missing };
}

// Content fingerprint (Opus B-1/B-3 plan↔apply contract): a git-tree-OID-independent, deterministic
// sha256 over a named file set's exact bytes (BOM included) — used to bind a plan to the exact
// snapshot it was computed from, and to detect "already applied" (idempotent re-run) vs "wrong/
// drifted directory" at --apply time without needing a full git-tree-hash reimplementation for a
// bare (non-git) --dir copy. See guards/specs/PMM-V3-FINAL-SPEC.md §5 "plan 与 apply 的契约".
function contentFingerprint(snap, files) {
  const list = (files || ALL_FILES).slice().sort();
  const parts = [];
  for (const f of list) {
    const info = snap.files[f];
    if (!info || info.missing) { parts.push(`${f}\0MISSING\n`); continue; }
    const bytes = info.rawWithBOM != null ? info.rawWithBOM : info.raw;
    parts.push(`${f}\0${sha256hex(bytes)}\n`);
  }
  return sha256hex(Buffer.from(parts.join(''), 'utf8'));
}

// snapshotWithOverrides(baseSnap, overrides) — C05-BUILD-SPEC 补遗三第 28 条新增导出: builds a NEW
// snapshot object with the same shape snapshot()/snapshotDir() return, reusing baseSnap's files
// verbatim EXCEPT for the keys named in `overrides` (a plain {<file in ALL_FILES>: Buffer|string}
// map), which are substituted in-memory — never touching disk. This is what lets a caller (the C0.5
// shadow hook's Pre-phase "writer" dimension, spec 28) compute an "after this prospective edit lands"
// full-corpus snapshot from an "on-disk right now" one, entirely in memory, so core.check()/analyze()
// can be run on BOTH and diffed via diffBlocking() below — without ever writing the prospective bytes
// to disk first. Unlisted files are passed through by reference (same {raw,hadBOM,missing,...} object
// baseSnap already had) — this function never mutates baseSnap itself. A null/undefined override value
// marks that file MISSING in the result (mirrors snapshot()'s own missing-file shape), matching how a
// caller would represent "this file doesn't exist in the prospective state".
function snapshotWithOverrides(baseSnap, overrides) {
  overrides = overrides || {};
  const files = {};
  for (const f of ALL_FILES) {
    if (Object.prototype.hasOwnProperty.call(overrides, f)) {
      const val = overrides[f];
      if (val == null) { files[f] = { raw: null, missing: true }; continue; }
      const buf = Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf8');
      const { buf: stripped, hadBOM } = stripBOM(buf);
      files[f] = { raw: stripped, hadBOM, missing: false, rawWithBOM: buf };
    } else {
      files[f] = (baseSnap && baseSnap.files && baseSnap.files[f]) || { raw: null, missing: true };
    }
  }
  const missing = ALL_FILES.filter((f) => files[f].missing);
  const view = ((baseSnap && baseSnap.view) || 'worktree') + '+overrides';
  return { view, files, sourceOids: (baseSnap && baseSnap.sourceOids) || {}, missing };
}

// diffBlocking(beforeList, afterList) — C05-BUILD-SPEC 补遗三第 28 条新增导出: the SAME normalized
// multiset diff pmm-precommit-shadow-replay.cjs's normalizeBlockingKey (:55-57) + diffNormalizedBlocking
// (:62-73) implement, hoisted here so the C0.5 shadow hook's "v3 预观察" field (spec 28) can reuse the
// identical algorithm without duplicating it a third time. `beforeList`/`afterList` are arrays of
// blocking-line strings (e.g. check(...).blocking / analyze(...).blocking on two different snapshots of
// the SAME corpus) — never snapshots themselves. Blocking strings embed `file:line` and byte counts
// (pmm-core.cjs's own check() output, e.g. "B14 lessons.md:412 … 987B"), which drift between two
// snapshots of the SAME underlying violation whenever unrelated edits shift line numbers or byte
// counts elsewhere in the file; a naive set difference would misreport that drift as a new/removed
// violation. Normalizing away the digits after `.md:` and the trailing `<N>B` collapses same-class
// occurrences onto one key, and the multiset (count-aware) diff then reports only a GENUINE increase in
// how many times a given normalized violation occurs between before and after — not a same-count
// occurrence that merely moved. See pmm-precommit-shadow-replay.cjs's own header comment (§ M1 fix,
// `guards/audits/OPUS-2026-09-24-c05-wave2-review.md` "M1 B3 列① 8 实为 2 真新增") for the original
// bug this normalization fixes. This export does not change pmm-precommit-shadow-replay.cjs's own
// local copy — that file is out of this batch's write surface (W4-B1 brief: "只新增两个导出与其自测,
// 不改既有行为"); a future batch may switch it to call this export instead (spec 28 flags that as
// "顺带收掉 MEDIUM-6", not done here).
function normalizeBlockingKey(s) {
  return String(s).replace(/(\.md):\d+/g, '$1:#').replace(/\d+B\b/g, '#B');
}
function diffBlocking(beforeList, afterList) {
  const beforeNorm = new Map();
  for (const x of (beforeList || [])) { const k = normalizeBlockingKey(x); beforeNorm.set(k, (beforeNorm.get(k) || 0) + 1); }
  const afterNorm = new Map();
  for (const x of (afterList || [])) { const k = normalizeBlockingKey(x); afterNorm.set(k, (afterNorm.get(k) || 0) + 1); }
  const out = [];
  for (const [k, n] of afterNorm) {
    const before = beforeNorm.get(k) || 0;
    if (n > before) out.push(k + ((n - before) > 1 ? ' x' + (n - before) : ''));
  }
  return out;
}

const TAG_G_RE = new RegExp(`\\[\\[(${TAG_SRC})\\]\\]`, 'g');

// Fable HIGH-5 fix (2026-09-15, guards/audits/FABLE-2026-09-15-glob-review-triage.md finding 5 /
// CODEX-2026-09-15-glob-spec-review.md finding 5): extracted out of classifyFieldLine() (which used
// to inline this) so a PreToolUse write-time interceptor (guards/pmm-trigger-write-gate.cjs) can
// validate a PROSPECTIVE trigger comment line before the Edit/Write/MultiEdit tool call that would
// introduce it is ever allowed to run — using the EXACT SAME judgment parseFile() uses at read time,
// not a second, driftable reimplementation. 09-15 revision (glob support, GLOB-TRIGGER-SPEC.md): star
// position is no longer "end only" — `*`/`**` may appear anywhere after the literal prefix.
// compileTriggerPath() is the ONLY place that interprets glob syntax; checkTriggerPathB5() layers the
// write-time prefix-length policy (>=3 UTF-8 bytes, no leading `/`) on top of it using
// compileTriggerPath's OWN literalPrefix — no path-form judgment is duplicated here.
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

// ── per-file parse: fence-aware block cutter + field classifier (§1.2a, §1.4) ────────────────────
function parseFile(fileName, buf) {
  const isArchive = ARCHIVE_SET.has(fileName);
  const lines = splitLinesBytes(buf);
  const entries = [];
  const diagnostics = []; // {code, file, line, tag, raw, reason}
  let inFence = false;
  let cur = null;

  const lineText = (ln) => buf.slice(ln.startByte, ln.contentEndByte).toString('utf8');

  function startEntry(lineIdx, lineNo, ln, titleM) {
    const dateISO = titleM[1];
    const dateRaw = titleM[2] || '';
    const title = titleM[3].trim();
    const tail = titleM[4] || '';
    const idMatch = IDENTITY_IN_TAIL_RE.exec(tail);
    const rawId = idMatch ? idMatch[1] : null;
    const ns = rawId ? rawId.split(':')[0] : null;
    const nsLower = ns ? ns.toLowerCase() : null;
    const identityNsInvalid = ns != null && ATTR_NS.has(nsLower);
    const identityUppercase = rawId != null && /[A-Z]/.test(rawId);
    return {
      file: fileName, archived: isArchive,
      _titleLineIdx: lineIdx, titleLineNo: lineNo, startByte: ln.startByte,
      dateISO, dateRaw, title, tail,
      rawIdentity: rawId, identityNsInvalid, identityUppercase,
      id: (rawId && !identityNsInvalid) ? rawId : null,
      soleRecord: /\[sole-record\]/.test(tail),
      redundancyOk: /\[redundancy-ok\]/.test(tail),
      trust: (tail.match(/\[trust:([a-z-]+)\]/) || [])[1] || null,
      attribution: null, hook: null, banner: [], class: null,
      links: [], triggers: [], triggerNone: null, supersedes: [], cause: [], follows: [], rules: [],
      _classLineCount: 0, _hookLineCount: 0, _supersLineCount: 0,
      ok: true,
    };
  }

  function classifyFieldLine(lineNo, text) {
    let m;
    if ((m = ATTRIB_RE.exec(text))) { cur.attribution = m[1].trim(); return; }
    {
      const trigRes = classifyTriggerLine(text);
      if (trigRes) {
        if (trigRes.ok) {
          // 2026-09-17: kind==='none' is a deliberate "no trigger, and here's why" sentinel consumed
          // by the presence gate (pmm-trigger-write-gate.cjs) — kept OUT of cur.triggers so every
          // existing consumer of that array (pmm-fade.cjs's `.triggers.length` check, pmm-manifest.cjs,
          // pmm-trigger-compat-replay.cjs, pmm-core-selftest.cjs) is unaffected; it never denotes an
          // actual recall trigger.
          if (trigRes.trigger.kind === 'none') cur.triggerNone = Object.assign({ line: lineNo }, trigRes.trigger);
          else cur.triggers.push(Object.assign({ line: lineNo }, trigRes.trigger));
        } else {
          diagnostics.push({ code: 'B5', file: fileName, line: lineNo, tag: cur.rawIdentity, raw: text.slice(0, 160), reason: trigRes.reason });
        }
        return;
      }
    }
    if ((m = CLASS_RE.exec(text))) {
      cur._classLineCount++;
      if (cur._classLineCount > 1) diagnostics.push({ code: 'B6', file: fileName, line: lineNo, tag: cur.rawIdentity, raw: text.slice(0, 160), reason: '多于一个 Class 行' });
      else cur.class = m[1];
      return;
    }
    if (CLASSISH_RE.test(text)) {
      diagnostics.push({ code: 'B6', file: fileName, line: lineNo, tag: cur.rawIdentity, raw: text.slice(0, 160), reason: 'Class 行非标形态' });
      return;
    }
    if ((m = SUPERS_RE.exec(text))) {
      cur._supersLineCount++;
      // §1.5 09-15 revision: archives are exempt from B23 too (zero-rewrite; a malformed historical
      // Supersedes line there is a fact, not a live violation) — see the SUPERSISH_RE branch below for
      // the fuller rationale/caveat about the (currently simplified) blockHash-whitelist semantics.
      if (cur._supersLineCount > 1 && !isArchive) diagnostics.push({ code: 'B23', file: fileName, line: lineNo, tag: cur.rawIdentity, raw: text.slice(0, 160), reason: '多于一个 Supersedes 行(0..1)' });
      let mm; TAG_G_RE.lastIndex = 0;
      while ((mm = TAG_G_RE.exec(m[1]))) cur.supersedes.push(mm[1]);
      return;
    }
    if (SUPERSISH_RE.test(text)) {
      // §1.5 09-15 revision: exempt archives from B23 (malformed Supersedes line is a historical fact
      // in a zero-rewrite file). Spec's intent is a blockHash WHITELIST (pre-C1-cutover blocks only) —
      // not a blanket by-filename exemption, so that a future F' retirement writing a NEW malformed
      // block into an archive still gets caught. C0 never writes to archives at all (nothing has ever
      // retired under this system yet), so "all current archive blocks" == "the whitelist" today;
      // a real per-blockHash whitelist file is C1/C2 infrastructure this build doesn't have yet.
      if (!isArchive) diagnostics.push({ code: 'B23', file: fileName, line: lineNo, tag: cur.rawIdentity, raw: text.slice(0, 160), reason: 'Supersedes 行只认 [[tag]]·/,连接,其余形态(单括号/说明文字)非法' });
      return;
    }
    if ((m = CAUSE_RE.exec(text))) {
      let mm; TARGET_G_RE.lastIndex = 0;
      while ((mm = TARGET_G_RE.exec(m[1]))) cur.cause.push({ target: mm[1], line: lineNo });
      return;
    }
    if ((m = FOLLOWS_RE.exec(text))) {
      let mm; TARGET_G_RE.lastIndex = 0;
      while ((mm = TARGET_G_RE.exec(m[1]))) cur.follows.push({ target: mm[1], line: lineNo });
      return;
    }
    if ((m = HOOK_RE.exec(text))) {
      const value = m[1];
      const bad = [];
      if (utf8ByteLength(value) > 320) bad.push('Hook >320B');
      if (hasControlChar(value)) bad.push('Hook 含控制字符');
      cur._hookLineCount++;
      if (cur._hookLineCount > 1) bad.push('Hook 重复行(0..1)');
      // §1.5: archived entries are exempt from B14 (archives are verbatim/zero-rewrite; a Hook that
      // is too long or malformed there is a historical fact, not something C0/C1 will ever touch) —
      // suppress the diagnostic only, keep the same accept/reject-into-cur.hook logic either way.
      if (bad.length) { if (!isArchive) diagnostics.push({ code: 'B14', file: fileName, line: lineNo, tag: cur.rawIdentity, raw: text.slice(0, 160), reason: bad.join(';') }); }
      else cur.hook = value;
      for (const l of extractLinks(value)) if (!cur.links.includes(l)) cur.links.push(l);
      return;
    }
    if ((m = BANNER_RE.exec(text))) {
      const value = m[1];
      const bad = [];
      if (utf8ByteLength(value) > 320) bad.push('Banner >320B');
      if (hasControlChar(value)) bad.push('Banner 含控制字符');
      if (bad.length) diagnostics.push({ code: 'B19', file: fileName, line: lineNo, tag: cur.rawIdentity, raw: text.slice(0, 160), reason: bad.join(';') });
      else cur.banner.push(value);
      for (const l of extractLinks(value)) if (!cur.links.includes(l)) cur.links.push(l);
      return;
    }
    if ((m = RULES_RE.exec(text))) {
      let mm; TAG_G_RE.lastIndex = 0;
      while ((mm = TAG_G_RE.exec(m[1]))) cur.rules.push(mm[1]);
      return;
    }
    // prose line: extract links (backtick spans stripped) + flag bare `[[x]]`
    for (const l of extractLinks(text)) if (!cur.links.includes(l)) cur.links.push(l);
    // §1.5 09-15 revision: archives exempt from B15 too (same blockHash-whitelist-in-spirit rationale
    // as the B23 exemption above — simplified to blanket-by-file since C0 never writes to archives).
    if (!isArchive) for (const b of findBareLinks(text)) diagnostics.push({ code: 'B15', file: fileName, line: lineNo, tag: cur.rawIdentity, raw: `[[${b}]]` });
  }

  function finalizeAndPush(boundaryStartByte, lastLineIdxInSpan) {
    // trim trailing pure-whitespace lines
    let trimEnd = boundaryStartByte;
    let li = lastLineIdxInSpan;
    while (li > cur._titleLineIdx) {
      const ln = lines[li];
      const text = lineText(ln);
      if (text.trim() === '') { trimEnd = ln.startByte; li--; } else break;
    }
    const blockBytes = buf.slice(cur.startByte, trimEnd);
    cur.byteRange = [cur.startByte, trimEnd];
    cur.lineRange = [cur.titleLineNo, li + 1];
    cur.blockHash64 = sha256hex(blockBytes);
    cur.body = blockBytes.toString('utf8');
    delete cur._titleLineIdx; delete cur._classLineCount; delete cur._hookLineCount; delete cur._supersLineCount;
    entries.push(cur);
  }

  let fenceStartLine = null;
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    const text = lineText(ln);
    const wasFence = inFence;
    const lineNo = li + 1;
    if (FENCE_RE.test(text)) { inFence = !inFence; if (inFence) fenceStartLine = lineNo; }
    if (wasFence) continue; // inside fence: invisible to the grammar entirely

    const titleM = TITLE_RE.exec(text);
    if (titleM) {
      if (cur) finalizeAndPush(ln.startByte, li - 1);
      cur = startEntry(li, lineNo, ln, titleM);
      continue;
    }
    // §1.5: archives are exempt from B8 (both forms) — several real archive entries are legacy
    // records whose title line never closed `**` on the same line (M-8); they are a historical fact,
    // not something C0/C1 will ever rewrite (zero-rewrite policy).
    if (!isArchive && TITLEISH_RE.test(text)) {
      diagnostics.push({ code: 'B8', file: fileName, line: lineNo, tag: null, raw: text.slice(0, 160), reason: '起行像标题(前导空白/> 前缀)却未成条目' });
      // does not end/start a block
    } else if (!isArchive && TITLE_OPEN_NOCLOSE_RE.test(text)) {
      diagnostics.push({ code: 'B8', file: fileName, line: lineNo, tag: null, raw: text.slice(0, 160), reason: '起行像标题(日期+破折号)但整行内未闭合 ** 却未成条目(内容并入前一条目正文)' });
    }
    if (H2_RE.test(text) || H3_RE.test(text)) {
      if (INDEX_HEADING_RE.test(text)) diagnostics.push({ code: 'B9', file: fileName, line: lineNo, tag: null, raw: text.slice(0, 160), reason: '文件仍含手写 Index 段(cutover 前为 report)' });
      if (cur) finalizeAndPush(ln.startByte, li - 1);
      cur = null;
      continue;
    }
    if (!cur) continue;
    classifyFieldLine(lineNo, text);
  }
  if (cur) finalizeAndPush(buf.length, lines.length - 1);

  // B32 (Opus H-8): file ends with inFence still true ⇒ blocking, diagnostic points at the fence's
  // OPENING line (not EOF) so the operator can find and close it. Never silently swallow the tail.
  if (inFence) {
    diagnostics.push({ code: 'B32', file: fileName, line: fenceStartLine, tag: null, raw: '', reason: `文件末尾未闭合围栏(起于第 ${fenceStartLine} 行),其后内容可能被静默吞掉` });
  }

  // B8b/B8c reports derived from entries (kept alongside file diagnostics for convenience).
  // §1.5: archives are exempt from B8b/B8c — a historical attribution-style or uppercase identity in
  // an archive entry is a fact of the record, not a live-corpus violation to fix.
  for (const e of entries) {
    if (isArchive) continue;
    if (e.identityNsInvalid) diagnostics.push({ code: 'B8b', file: fileName, line: e.titleLineNo, tag: e.rawIdentity, raw: e.title, reason: `身份 ns=${e.rawIdentity.split(':')[0]} ∈ {user,agent,system,trust}(attribution 命名空间,不得当身份)` });
    if (e.id && e.identityUppercase) diagnostics.push({ code: 'B8c', file: fileName, line: e.titleLineNo, tag: e.id, raw: e.title, reason: '身份含大写字符(新身份须小写;存量大写 tag 免改名,仅报)' });
  }

  return { file: fileName, archived: isArchive, entries, diagnostics, lineCount: lines.length, byteLength: buf.length };
}

function parseAll(snap) {
  const perFile = {};
  const entries = [];
  const diagnostics = [];
  for (const f of ALL_FILES) {
    const info = snap.files[f];
    if (!info || info.missing) { perFile[f] = { file: f, missing: true, entries: [], diagnostics: [] }; continue; }
    const r = parseFile(f, info.raw);
    r.hadBOM = info.hadBOM;
    perFile[f] = r;
    for (const e of r.entries) entries.push(e);
    for (const d of r.diagnostics) diagnostics.push(d);
  }
  // assign stable per-file+identity index ids for entries lacking a valid tag (for internal addressing only)
  entries.forEach((e, i) => { e._idx = i; });
  return { perFile, entries, diagnostics };
}

// ── lessons.md B13 routing-namespace pointer table (`- Axervice(\`[axervice:*]\`)→ ...`) ─────────
function parseLessonsRoutingNs(lessonsRawText) {
  const ns = new Set();
  const re = /`\[([a-z][a-z0-9-]*):\*\]`/g;
  let m;
  while ((m = re.exec(lessonsRawText))) ns.add(m[1]);
  return ns.size ? ns : LESSONS_ROUTED_NS_DEFAULT;
}

// ── graph: supersedes / cause / follows edges, heads, cycles ─────────────────────────────────────
// Case-insensitive Map wrapper (§1.7, Opus H-7): keys are normalized via idKey() on every
// get/has/set, so every EXISTING call site (`byId.get(e.id)`, `supNext.has(target.id)`, …) becomes
// case-insensitive for free — callers keep passing original-cased ids/tags, comparisons just work.
function ciMap() {
  const m = new Map();
  return {
    get(k) { return m.get(idKey(k)); },
    has(k) { return m.has(idKey(k)); },
    set(k, v) { m.set(idKey(k), v); return this; },
    keys() { return m.keys(); },
    entries() { return m.entries(); },
    get size() { return m.size; },
  };
}

function buildGraph(entries) {
  const byId = ciMap();
  for (const e of entries) if (e.id) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  const supersedesEdges = []; // {from(old), to(new-entry id)} — original-cased text, for display
  const causeEdges = [];      // {from(target), to(entry id)}
  const followsEdges = [];    // {from(target), to(entry id)}
  const supNext = ciMap();    // old -> Set(new) — for head resolution (case-insensitive keys)

  for (const e of entries) {
    if (!e.id) continue;
    for (const old of e.supersedes) {
      supersedesEdges.push({ from: old, to: e.id });
      if (!supNext.has(old)) supNext.set(old, new Set());
      supNext.get(old).add(e.id);
    }
    for (const c of e.cause) causeEdges.push({ from: c.target, to: e.id, line: c.line });
    for (const fo of e.follows) followsEdges.push({ from: fo.target, to: e.id, line: fo.line });
  }
  // derived reverse edges
  const effectsOf = ciMap(); // cause-target -> [entry ids that cite it]
  for (const ce of causeEdges) { if (!effectsOf.has(ce.from)) effectsOf.set(ce.from, []); effectsOf.get(ce.from).push(ce.to); }
  const precedesOf = ciMap();
  for (const fe of followsEdges) { if (!precedesOf.has(fe.from)) precedesOf.set(fe.from, []); precedesOf.get(fe.from).push(fe.to); }

  // heads + cycles (B2') — keyed by idKey(old) throughout (case-insensitive canonical form)
  const heads = {}; // idKey(tag) -> {head, forked, cycle}
  const cycles = [];
  const forks = [];
  // Coordinator-confirmed defect (2026-09-15, C0 blocking): the pre-fix version used a single
  // "seen" set for BOTH visited-dedup and cycle detection — a diamond DAG (A→B→D and A→C→D, D
  // reached twice by two DIFFERENT paths, no back-edge) hit `seen.has(...)` on the second arrival
  // and got misjudged as a cycle. Cycle detection needs the RECURSION-STACK ancestor set (GRAY),
  // not the flat "ever visited" set (BLACK) — same GRAY/BLACK three-color scheme B10's Cause-graph
  // cycle detector already uses below (`:702-714`), just as an iterative (not recursive) DFS here to
  // preserve the original's stack-depth safety margin for long chains.
  function resolveHeads(startTag) {
    const color = new Map(); // idKey -> 1(GRAY, on current DFS path) | 2(BLACK, fully explored)
    const terminals = new Set();
    let cycle = false;
    let steps = 0;
    const stack = [{ node: startTag, childIdx: 0, children: null }];
    color.set(idKey(startTag), 1);
    while (stack.length) {
      if (++steps > 10000) { cycle = true; break; }
      const frame = stack[stack.length - 1];
      if (frame.children === null) {
        const nx = supNext.get(frame.node);
        if (!nx || nx.size === 0) { terminals.add(frame.node); frame.children = []; }
        else {
          if (nx.size > 1) forks.push({ node: frame.node, to: [...nx] });
          frame.children = [...nx];
        }
      }
      if (frame.childIdx >= frame.children.length) {
        color.set(idKey(frame.node), 2); // BLACK: done with this node and everything under it
        stack.pop();
        continue;
      }
      const child = frame.children[frame.childIdx++];
      const ck = idKey(child);
      const c = color.get(ck);
      if (c === 1) { cycle = true; continue; }       // GRAY ancestor re-hit: a REAL back-edge/cycle
      if (c === 2) continue;                          // BLACK: already fully explored via another path
                                                        // (diamond/transitive shortcut) — NOT a cycle
      color.set(ck, 1);
      stack.push({ node: child, childIdx: 0, children: null });
    }
    return { terminals: [...terminals], cycle };
  }
  for (const old of supNext.keys()) {
    const r = resolveHeads(old);
    if (r.cycle) cycles.push(old);
    heads[idKey(old)] = { heads: r.terminals, forkedButSingleHead: r.terminals.length === 1, multiTerminal: r.terminals.length > 1 };
  }
  function headOf(tag) {
    const h = heads[idKey(tag)];
    if (h) {
      if (h.heads.length === 1) return h.heads[0];
      return tag; // ambiguous/cycle: no single resolvable head
    }
    return tag; // never superseded: it is its own head
  }

  return { byId, supersedesEdges, causeEdges, followsEdges, effectsOf, precedesOf, heads, cycles, forks, headOf, supNext };
}

const CLASS_REQUIRED_FROM = '2026-09-15';
const SUPERSEDED_BY_PROSE_RE = new RegExp(`Superseded by:\\s*\\[\\[(${TAG_SRC})\\]\\]`);
const QUOTE_KEYWORD_RE = /原话|逐字|verbatim/;
const QUOTE_SPAN_RE = /[『「“]([^』」”]{20,})[』」”]/g;
const GLOBAL_DECISIONS_NS = new Set(['process', 'pmm', 'memory', 'system', 'tooling']); // heuristic: "not project-scoped" for D2/C2 cold rule

function today() { return new Date().toISOString().slice(0, 10); }
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(iso1, iso2) {
  const a = new Date(iso1 + 'T00:00:00Z').getTime();
  const b = new Date(iso2 + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

// byte offset (within a UTF-8 decoded string `text`) of a given char index — used for structural
// (non-entry) byte-range computations like the Kernel section span.
function byteOffsetOfCharIndex(text, charIndex) {
  return Buffer.byteLength(text.slice(0, charIndex), 'utf8');
}

function computeKernelByteRange(rawText) {
  const startM = /^### Kernel\b.*$/m.exec(rawText);
  if (!startM) return null;
  const afterStart = startM.index + startM[0].length;
  const nextHeadingRe = /^(##|###) /gm;
  nextHeadingRe.lastIndex = afterStart;
  const nm = nextHeadingRe.exec(rawText);
  const endChar = nm ? nm.index : rawText.length;
  return [byteOffsetOfCharIndex(rawText, startM.index), byteOffsetOfCharIndex(rawText, endChar)];
}

// D2 cold rule. C1 = 非链头(已被取代);C2(decisions.md only)= 项目命名空间 ∧ >90 天 ∧ 无 live 反向链。
// 教训只按 C1。namespace 判据是启发式(见 docs/PMM-V3.md「未能做到完全确定性之处」)。
function isCold(e, graph, linkedFromSet, asOf) {
  if (e.archived || !e.id) return false;
  const headTag = graph.headOf(e.id);
  if (headTag !== e.id) return true; // C1
  if (e.file === 'decisions.md') {
    const ns = e.id.split(':')[0];
    const isProjectNs = !GLOBAL_DECISIONS_NS.has(ns);
    const age = daysBetween(e.dateISO, asOf);
    if (isProjectNs && age > 90) {
      const hasReverse = (graph.effectsOf.get(e.id) || []).length > 0 ||
        (graph.precedesOf.get(e.id) || []).length > 0 ||
        linkedFromSet.has(e.id);
      if (!hasReverse) return true; // C2
    }
  }
  return false;
}

// ── check(): assembles all invariants into {blocking[], report[]} ────────────────────────────────
function check(snap, parsed, graph, opts) {
  opts = opts || {};
  const asOf = opts.asOf || today();
  const cutover = !!opts.cutover;
  const blocking = [];
  const report = [];

  // parse-time diagnostics (B5/B6/B8/B8b/B9/B14/B15/B19/B23). B9 and B8c are report-level in C0
  // (pre-cutover / no-diff-context respectively — see docs "未能做到完全确定性之处").
  const REPORT_CODES = new Set(['B9', 'B8c']);
  for (const d of parsed.diagnostics) {
    const line = `${d.code} ${d.file}:${d.line}${d.tag ? ` [${d.tag}]` : ''} ${d.reason || d.raw}`;
    if (REPORT_CODES.has(d.code) && !(d.code === 'B9' && cutover)) report.push(line);
    else if (d.code === 'B9' && cutover) blocking.push(line);
    else blocking.push(line);
  }

  const byId = graph.byId;
  const allIds = new Set(byId.keys());
  const archiveHashSet = new Set();
  for (const e of parsed.entries) if (e.archived) archiveHashSet.add(e.blockHash64);
  function targetExists(t) {
    if (t.startsWith('archive-sha256:')) return archiveHashSet.has(t.slice('archive-sha256:'.length));
    return allIds.has(idKey(t)); // §1.7: link/edge target resolution is ASCII-lowercase
  }

  // B1: Supersedes/Cause/Follows targets exist (incl. archive)
  for (const e of parsed.entries) {
    if (!e.id) continue;
    for (const old of e.supersedes) if (!targetExists(old)) blocking.push(`B1 ${e.file}:${e.titleLineNo} [${e.id}] Supersedes 悬空目标 [[${old}]](全库无定义)`);
    for (const c of e.cause) if (!targetExists(c.target)) blocking.push(`B1 ${e.file}:${e.titleLineNo} [${e.id}] Cause 悬空目标 [[${c.target}]]`);
    for (const f of e.follows) if (!targetExists(f.target)) blocking.push(`B1 ${e.file}:${e.titleLineNo} [${e.id}] Follows 悬空目标 [[${f.target}]]`);
  }

  // B2′: no cycles; per-node head-set size ==1 (fork allowed, multi-terminal not)
  for (const c of graph.cycles) blocking.push(`B2' [${c}] 取代链成环`);
  for (const [old, h] of Object.entries(graph.heads)) {
    if (h.multiTerminal) blocking.push(`B2' [${old}] 取代链多终点(head 集 ${h.heads.length}>1):${h.heads.join(',')}`);
  }
  for (const fk of graph.forks) report.push(`FORK [${fk.node}] 有多个直接取代者:${fk.to.join(',')}(分叉允许,只要最终收敛到单一终点)`);

  // B7: live identity uniqueness (ASCII-lowercase compare), across all 4 live files
  const idMap = new Map();
  for (const e of parsed.entries) {
    if (e.archived || !e.id) continue;
    const key = e.id.toLowerCase();
    if (!idMap.has(key)) idMap.set(key, []);
    idMap.get(key).push(e);
  }
  for (const [key, arr] of idMap) {
    if (arr.length > 1) blocking.push(`B7 live 身份重复(不区分大小写)[${key}]:${arr.map(a => a.file + ':' + a.titleLineNo).join(' 与 ')}`);
  }

  // B6 (semantic part): Class target exists in classes.md; lessons.md new entries require Class
  const classDefs = new Set(parsed.entries.filter(e => e.file === 'classes.md' && e.id).map(e => e.id));
  for (const e of parsed.entries) {
    if (e.archived || e.file === 'classes.md') continue;
    if (e.class && !classDefs.has(e.class)) blocking.push(`B6 ${e.file}:${e.titleLineNo} [${e.id || '?'}] Class 目标 [${e.class}] 未在 classes.md 定义`);
    if (e.file === 'lessons.md' && !e.class) {
      if (e.dateISO >= CLASS_REQUIRED_FROM) blocking.push(`B6 lessons.md:${e.titleLineNo} [${e.id || '?'}] 新教训(≥${CLASS_REQUIRED_FROM})缺 Class: 行`);
      else report.push(`UNCLASSIFIED lessons.md:${e.titleLineNo} [${e.id || '?'}] 旧教训尚未归类`);
    }
  }

  // B10: Cause/Follows semantics — self-edge, duplicate edge, cycle (cause only; follows = non-causal
  // per FINAL §8 "非因果先后无处表达", no cycle check); date-reverse = report only.
  for (const e of parsed.entries) {
    if (!e.id) continue;
    const seenC = new Set();
    for (const c of e.cause) {
      if (c.target === e.id) blocking.push(`B10 ${e.file}:${e.titleLineNo} [${e.id}] Cause 自边 [[${c.target}]]`);
      if (seenC.has(c.target)) blocking.push(`B10 ${e.file}:${e.titleLineNo} [${e.id}] Cause 重复边 [[${c.target}]]`);
      seenC.add(c.target);
      const targetEntry = byId.has(c.target) ? byId.get(c.target)[0] : null;
      if (targetEntry && targetEntry.dateISO > e.dateISO) report.push(`B10(日期逆向) ${e.file}:${e.titleLineNo} [${e.id}] Cause 目标 [[${c.target}]] 日期(${targetEntry.dateISO}) 晚于本条(${e.dateISO})`);
    }
    const seenF = new Set();
    for (const f of e.follows) {
      if (f.target === e.id) blocking.push(`B10 ${e.file}:${e.titleLineNo} [${e.id}] Follows 自边 [[${f.target}]]`);
      if (seenF.has(f.target)) blocking.push(`B10 ${e.file}:${e.titleLineNo} [${e.id}] Follows 重复边 [[${f.target}]]`);
      seenF.add(f.target);
      const targetEntry = byId.has(f.target) ? byId.get(f.target)[0] : null;
      if (targetEntry && targetEntry.dateISO > e.dateISO) report.push(`B10(日期逆向) ${e.file}:${e.titleLineNo} [${e.id}] Follows 目标 [[${f.target}]] 日期(${targetEntry.dateISO}) 晚于本条(${e.dateISO})`);
    }
  }
  // cause-graph cycle detection (target -> entry edges)
  {
    const adj = new Map();
    for (const e of parsed.entries) if (e.id) for (const c of e.cause) {
      if (!adj.has(c.target)) adj.set(c.target, new Set());
      adj.get(c.target).add(e.id);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    const cycleNodes = new Set();
    function dfs(u, stack) {
      color.set(u, GRAY); stack.push(u);
      for (const v of (adj.get(u) || [])) {
        if (color.get(v) === GRAY) { cycleNodes.add(v); cycleNodes.add(u); }
        else if (color.get(v) !== BLACK) dfs(v, stack);
      }
      stack.pop(); color.set(u, BLACK);
    }
    for (const u of adj.keys()) if (color.get(u) !== BLACK) dfs(u, []);
    for (const n of cycleNodes) blocking.push(`B10 [${n}] Cause 图成环`);
  }

  // B12: Kernel section ≤16KB; single Kernel entry ≤5KB
  const stdInfo = snap.files['standinginstructions.md'];
  if (stdInfo && !stdInfo.missing) {
    const text = stdInfo.raw.toString('utf8');
    const kr = computeKernelByteRange(text);
    if (kr) {
      const [kStart, kEnd] = kr;
      const kernelBytes = kEnd - kStart;
      if (kernelBytes > 16 * 1024) blocking.push(`B12 standinginstructions.md Kernel 段 ${kernelBytes}B > 16KB`);
      for (const e of (parsed.perFile['standinginstructions.md'].entries || [])) {
        if (e.byteRange[0] >= kStart && e.byteRange[0] < kEnd) {
          const sz = e.byteRange[1] - e.byteRange[0];
          if (sz > 5 * 1024) blocking.push(`B12 standinginstructions.md:${e.titleLineNo} [${e.id || '?'}] Kernel 单条目 ${sz}B > 5KB`);
        }
      }
    }
  }

  // B13: lessons.md identity ns ∈ 项目路由集 = 红
  const lessonsInfo = snap.files['lessons.md'];
  const routedNs = lessonsInfo && !lessonsInfo.missing ? parseLessonsRoutingNs(lessonsInfo.raw.toString('utf8')) : LESSONS_ROUTED_NS_DEFAULT;
  for (const e of (parsed.perFile['lessons.md'] ? parsed.perFile['lessons.md'].entries : [])) {
    if (!e.id || e.archived) continue;
    const ns = e.id.split(':')[0];
    if (routedNs.has(ns)) blocking.push(`B13 lessons.md:${e.titleLineNo} [${e.id}] 身份命名空间属项目专属集(路由到项目 LESSONS.md,不应留在全局 lessons.md)`);
  }

  // B16 (single-snapshot, report-only — "新/改块" needs HEAD diff context; see diffCheckB16())
  for (const e of parsed.entries) {
    if (e.archived) continue;
    const size = e.byteRange[1] - e.byteRange[0];
    if (size > 900 && !e.soleRecord) report.push(`B16(单快照未做新旧判定) ${e.file}:${e.titleLineNo} [${e.id || '?'}] 块 ${size}B > 900B 且非 sole-record`);
  }

  // B17: Q 闸 — 09-15 修订:只扫 `<!-- attribution: -->` 字段行,正文不扫(正文里「原话」二字常是
  // 规则本身的措辞而非真实逐字引用,扫正文在真库造成 2 处假红)。
  for (const e of parsed.entries) {
    if (e.archived) continue;
    if (!e.attribution) continue;
    let hit = false;
    if (QUOTE_KEYWORD_RE.test(e.attribution)) hit = true;
    if (!hit) {
      QUOTE_SPAN_RE.lastIndex = 0;
      let m;
      while ((m = QUOTE_SPAN_RE.exec(e.attribution))) if (utf8ByteLength(m[1]) >= 120) { hit = true; break; }
    }
    if (hit) blocking.push(`B17 ${e.file}:${e.titleLineNo} [${e.id || '?'}] attribution 字段含疑似逐字引用(Q 闸,关键字/长引文 lint,非语义判断)`);
  }

  // B19: Banner host must be standing live [trust:user-ratified]; total ≤2560B (per-line ≤320B
  // already enforced at parse time)
  let totalBannerBytes = 0;
  for (const e of parsed.entries) {
    if (e.banner.length === 0) continue;
    for (const b of e.banner) totalBannerBytes += utf8ByteLength(b);
    if (e.archived || e.file !== 'standinginstructions.md' || e.trust !== 'user-ratified') {
      blocking.push(`B19 ${e.file}:${e.titleLineNo} [${e.id || '?'}] Banner 宿主必须是 standinginstructions.md 的 live [trust:user-ratified] 条目`);
    }
  }
  if (totalBannerBytes > 2560) blocking.push(`B19 横幅派生总字节 ${totalBannerBytes}B > 2560B`);

  // B22: dateISO ≤ as-of+1 (§1.5: archives exempt — a historical record's date is a fact, not a
  // live-corpus violation; only live entries can newly regress this)
  const ceiling = addDaysISO(asOf, 1);
  for (const e of parsed.entries) {
    if (e.archived) continue;
    if (e.dateISO > ceiling) blocking.push(`B22 ${e.file}:${e.titleLineNo} [${e.id || '?'}] dateISO ${e.dateISO} > as-of(${asOf})+1(${ceiling})`);
  }

  // B29 (report): 正文「Superseded by: [[x]]」与派生反向边不一致
  for (const e of parsed.entries) {
    if (!e.id) continue;
    const m = SUPERSEDED_BY_PROSE_RE.exec(e.body);
    if (m) {
      const claimed = m[1];
      const actual = graph.supNext.get(e.id);
      if (!actual || !actual.has(claimed)) report.push(`B29 ${e.file}:${e.titleLineNo} [${e.id}] 正文声明「Superseded by: [[${claimed}]]」与派生反向边不一致(实际=${actual ? [...actual].join(',') : '(无)'})`);
    }
  }

  return { blocking, report };
}

// ── index rendering (derived, deterministic) ──────────────────────────────────────────────────────
function hookOrTitle(e) { return e.hook != null ? e.hook : e.title; }
function computeLinkedFromSet(entries) {
  const s = new Set();
  for (const e of entries) for (const l of e.links) s.add(l);
  return s;
}
function renderIndex(parsed, graph, opts) {
  opts = opts || {};
  const asOf = opts.asOf || today();
  const showCold = !!opts.cold;
  const linkedFromSet = computeLinkedFromSet(parsed.entries);
  const out = {};
  for (const f of ['decisions.md', 'lessons.md', 'standinginstructions.md']) {
    const fileInfo = parsed.perFile[f];
    const fileEntries = (fileInfo && fileInfo.entries) || [];
    // Opus H-1: legacy passthrough ONLY on explicit --legacy — default is always the derived render.
    if (opts.legacy && fileInfo && fileInfo.legacyIndexText != null) { out[f] = { legacy: true, text: fileInfo.legacyIndexText }; continue; }
    const rows = [];
    let coldCount = 0;
    const live = fileEntries.filter(e => !e.archived && e.id && e.dateISO <= asOf);
    live.sort((a, b) => {
      if (a.dateISO !== b.dateISO) return a.dateISO < b.dateISO ? 1 : -1;
      return a.lineRange[0] - b.lineRange[0];
    });
    for (const e of live) {
      const cold = isCold(e, graph, linkedFromSet, asOf);
      if (cold && !showCold) { coldCount++; continue; }
      const headTag = graph.headOf(e.id);
      const supTag = idKey(headTag) !== idKey(e.id) ? ` (superseded→[${headTag}])` : '';
      rows.push(`- ${e.dateISO} [${e.id}] ${hookOrTitle(e)}${supTag}${cold ? ' (cold)' : ''}`);
    }
    if (coldCount > 0 && !showCold) rows.push(`- (冷条目折叠 ${coldCount} 条;--cold 展开)`);
    out[f] = { legacy: false, rows };
  }
  return out;
}
function renderIndexText(idx) {
  const parts = [];
  for (const f of Object.keys(idx)) {
    parts.push(`## ${f}`);
    if (idx[f].legacy) parts.push(idx[f].text);
    else parts.push(...idx[f].rows);
    parts.push('');
  }
  return parts.join('\n');
}

// legacy passthrough: if a file's raw text still has a real (non-fenced) `## Index` section, capture
// its verbatim lines for `--index --legacy`.
function attachLegacyIndex(parsed, snap) {
  for (const f of Object.keys(parsed.perFile)) {
    const info = snap.files[f];
    if (!info || info.missing) continue;
    const text = info.raw.toString('utf8');
    const lines = text.split(/\r?\n/);
    let inFence = false, inIdx = false;
    const out = [];
    for (const line of lines) {
      const wasFence = inFence;
      if (FENCE_RE.test(line)) inFence = !inFence;
      if (wasFence) continue;
      if (INDEX_HEADING_RE.test(line)) { inIdx = true; continue; }
      if (inIdx && (H2_RE.test(line) || H3_RE.test(line))) { inIdx = false; continue; }
      if (inIdx) out.push(line);
    }
    if (out.length) parsed.perFile[f].legacyIndexText = out.join('\n');
  }
  return parsed;
}

// ── ledger: addressability (§3.5) ──────────────────────────────────────────────────────────────
function tokenize(s) {
  return Array.from(new Set((s || '').toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(t => t.length >= 3)));
}
function ledger(parsed, graph) {
  const rows = [];
  let liveOrphans = 0, ratifiedOrphans = 0;
  for (const e of parsed.entries) {
    if (e.archived || !e.id) continue;
    const tokens = tokenize((e.hook || '') + ' ' + e.title);
    const pathTrig = e.triggers.some(t => t.kind === 'path');
    const cmdTrig = e.triggers.some(t => t.kind === 'cmd');
    const hasClass = !!e.class;
    const hasEdge = e.supersedes.length > 0 || e.cause.length > 0 || e.follows.length > 0 ||
      (graph.effectsOf.get(e.id) || []).length > 0 || (graph.precedesOf.get(e.id) || []).length > 0 ||
      (graph.supNext.get(e.id) || new Set()).size > 0;
    const addressable = tokens.length >= 3 || pathTrig || cmdTrig || hasClass || hasEdge;
    const orphan = !addressable;
    if (orphan) { liveOrphans++; if (e.trust === 'user-ratified') ratifiedOrphans++; }
    rows.push({ id: e.id, file: e.file, orphan, tokenCount: tokens.length, pathTrig, cmdTrig, hasClass, hasEdge });
  }
  return { rows, liveOrphans, ratifiedOrphans };
}

// ── top-level analyze(): FINAL §4 JSON shape ──────────────────────────────────────────────────────
function analyze(snap, opts) {
  opts = opts || {};
  const parsed = parseAll(snap);
  attachLegacyIndex(parsed, snap);
  const graph = buildGraph(parsed.entries);
  const { blocking, report } = check(snap, parsed, graph, opts);
  const linkedFromSet = computeLinkedFromSet(parsed.entries);
  const asOf = opts.asOf || today();
  const entries = parsed.entries.map(e => ({
    id: e.id, file: e.file, lineRange: e.lineRange, byteRange: e.byteRange, blockHash64: e.blockHash64,
    dateISO: e.dateISO, dateRaw: e.dateRaw, title: e.title, hook: e.hook, banner: e.banner,
    attribution: e.attribution, trust: e.trust, sole: e.soleRecord,
    ok: !(e.id && blocking.some(b => b.includes(`[${e.id}]`))),
    class: e.class, links: e.links, triggers: e.triggers, supersedes: e.supersedes,
    cause: e.cause.map(c => c.target), follows: e.follows.map(f => f.target),
    effects: e.id ? (graph.effectsOf.get(e.id) || []) : [],
    precedes: e.id ? (graph.precedesOf.get(e.id) || []) : [],
    head: e.id ? graph.headOf(e.id) : null,
    archived: e.archived, body: e.body,
  }));
  const heads = {};
  for (const [k, v] of Object.entries(graph.heads)) heads[k] = v.heads.length === 1 ? v.heads[0] : v.heads;
  const cold = parsed.entries.filter(e => !e.archived && e.id && isCold(e, graph, linkedFromSet, asOf)).map(e => e.id);
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceOids: snap.sourceOids,
    entries,
    edges: { supersedes: graph.supersedesEdges, cause: graph.causeEdges, follows: graph.followsEdges },
    heads, cold, blocking, report,
    diagnostics: parsed.diagnostics,
  };
}

module.exports = {
  SCHEMA_VERSION, LIVE_FILES, ARCHIVE_FILES, ALL_FILES, ARCHIVE_SET, ATTR_NS, CMD_DENYLIST,
  LESSONS_ROUTED_NS_DEFAULT, CLASS_REQUIRED_FROM,
  TAG_SRC, LOCATOR_SRC, TARGET_SRC, TITLE_RE, TITLEISH_RE, IDENTITY_IN_TAIL_RE,
  ATTRIB_RE, TRIG_P_RE, TRIG_C_RE, TRIG_NONE_RE, TRIGGERISH_RE, CLASS_RE, CLASSISH_RE,
  SUPERS_RE, SUPERSISH_RE, CAUSE_RE, FOLLOWS_RE, HOOK_RE, BANNER_RE, RULES_RE,
  LINK_G_RE, TARGET_G_RE, TAG_G_RE, H2_RE, H3_RE, INDEX_HEADING_RE, FENCE_RE,
  utf8ByteLength, hasControlChar, sha256hex, splitLinesBytes, stripBOM,
  extractLinks, findBareLinks,
  homeDir, memDir, memRelPrefix, treeOid, headCommitOid, isUnderCanonical, stripWin32DeviceNamespacePrefix,
  normalizeWin32UncAdminShare, stripWin32AdsSuffix, stripWin32TrailingDotSpace, normalizeWin32PathForCompare,
  realpathForCompare, isLocalHost, extractUncHost, matchCanonical,
  snapshot, snapshotDir, snapshotWithOverrides, contentFingerprint, diffBlocking, PmmCoreError, idKey, ciMap,
  parseFile, parseAll, parseLessonsRoutingNs, buildGraph, classifyTriggerLine,
  check, renderIndex, renderIndexText, attachLegacyIndex, ledger, analyze,
  isCold, today, addDaysISO, daysBetween, computeKernelByteRange, tokenize,
};
