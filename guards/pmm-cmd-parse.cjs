#!/usr/bin/env node
// pmm-cmd-parse.cjs — M0 command-parsing leaf module (zero deps besides Node's built-in `path`).
//
// v1.2 (guards/specs/PMM-CMD-PARSE-CONTRACT.md base + 修订 ①–⑥). Backward-compatible with v1.1's
// field NAMES (dialect/index/exe/sub/kind/args/redirects/has_exit_status_ref/sep_before/parse_status)
// but several VALUE SHAPES change under parser_version==='1.2' (contract 修订②: "版本化变更取代
// 「语义不变」" — consumers must key off parser_version, never assume v1.1 shapes).
//
// Exported surface: parseCommand(cmdText, ctx) -> { parser_version, segments, scopes, unresolved_variables }.
'use strict';
const path = require('path');

const PARSER_VERSION = '1.2';

// ── reserved words ──────────────────────────────────────────────────────────────────────────────────
const BLOCK_OPENERS = new Set(['if', 'for', 'while', 'until', 'case', '{', 'function', 'select']);
const BLOCK_CLOSERS = new Set(['fi', 'done', 'esac', '}']);
const SELF_ISOLATING_TRANSITIONS = new Set(['then', 'do', 'else']);
const KEYWORD_CANDIDATES = [
  'function', 'select', 'while', 'until', 'case', 'esac', 'then', 'elif', 'else', 'done', 'time',
  'for', 'if', 'fi', 'do', 'in', '{', '}', '!', '[[', '((',
];

// ── only these exes have a real "subcommand" slot ───────────────────────────────────────────────────
const SUBCOMMAND_EXES = new Set(['git', 'npm']);
const GLOBAL_OPTS = {
  git: { withArg: new Set(['-C']) },
  npm: { withArg: new Set(['--prefix']) },
};
const FUSED_LONG_OPT_RE = /^--[A-Za-z][A-Za-z0-9-]*=/;

const VARASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ARRAY_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=\(/;

// ── quote/comment masking (structural scanning; same-length output) ────────────────────────────────
function maskQuotesAndComments(s) {
  let out = '';
  let state = 'normal';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (state === 'normal') {
      if (c === "'") { state = 'squote'; out += ' '; continue; }
      if (c === '"') { state = 'dquote'; out += ' '; continue; }
      if (c === '#') {
        const prev = i === 0 ? '' : s[i - 1];
        const isCommentStart = prev === '' || /\s/.test(prev) || ';&|(\n'.indexOf(prev) !== -1;
        if (isCommentStart) {
          while (i < s.length && s[i] !== '\n') { out += ' '; i++; }
          if (i < s.length) out += s[i];
          continue;
        }
      }
      out += c;
      continue;
    }
    if (state === 'squote') {
      if (c === "'") state = 'normal';
      out += ' ';
      continue;
    }
    if (c === '"' && s[i - 1] !== '\\') state = 'normal';
    out += ' ';
  }
  return out;
}

function maskSingleQuoteAndComments(s) {
  let out = '';
  let state = 'normal';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (state === 'normal') {
      if (c === "'") { state = 'squote'; out += ' '; continue; }
      if (c === '"') { state = 'dquote'; out += c; continue; }
      if (c === '#') {
        const prev = i === 0 ? '' : s[i - 1];
        const isCommentStart = prev === '' || /\s/.test(prev) || ';&|(\n'.indexOf(prev) !== -1;
        if (isCommentStart) {
          while (i < s.length && s[i] !== '\n') { out += ' '; i++; }
          if (i < s.length) out += s[i];
          continue;
        }
      }
      out += c;
      continue;
    }
    if (state === 'squote') {
      if (c === "'") state = 'normal';
      out += ' ';
      continue;
    }
    if (c === '"' && s[i - 1] !== '\\') state = 'normal';
    out += c;
  }
  return out;
}

// blanks ONLY single-quoted spans (double-quote content stays visible, no comment handling) — used to
// scan for ${...} parameter-expansion forms where double-quoting does not suppress real shell semantics,
// and for comment-detection within an already-isolated single segment's text.
function maskSingleQuoteOnly(s) {
  let out = '';
  let state = 'normal';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (state === 'normal') {
      if (c === "'") { state = 'squote'; out += ' '; continue; }
      if (c === '"') { state = 'dquote'; out += c; continue; }
      out += c;
      continue;
    }
    if (state === 'squote') {
      if (c === "'") state = 'normal';
      out += ' ';
      continue;
    }
    if (c === '"' && s[i - 1] !== '\\') state = 'normal';
    out += c;
  }
  return out;
}

// blanks BOTH single and double quoted spans — used to find a segment's own trailing comment without
// mistaking a quoted '#' for one.
function maskBothQuotesOnly(s) {
  let out = '';
  let state = 'normal';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (state === 'normal') {
      if (c === "'") { state = 'squote'; out += ' '; continue; }
      if (c === '"') { state = 'dquote'; out += ' '; continue; }
      out += c; continue;
    }
    if (state === 'squote') { if (c === "'") state = 'normal'; out += ' '; continue; }
    if (c === '"' && s[i - 1] !== '\\') state = 'normal';
    out += ' ';
  }
  return out;
}

function findDquoteSubstitutionTaints(text) {
  const maskFull = maskQuotesAndComments(text);
  const maskSub = maskSingleQuoteAndComments(text);
  const taints = [];
  for (let i = 0; i < text.length; i++) {
    if (maskFull[i] !== ' ' || maskSub[i] === ' ') continue;
    if (text[i] === '$' && text[i + 1] === '(') taints.push({ pos: i, kind: 'command-substitution' });
    else if (text[i] === '`') taints.push({ pos: i, kind: 'backtick' });
  }
  return taints;
}

// amendment 8 item 3: whole input over 1 MiB (UTF-8 bytes) or a single whitespace-delimited token
// over 64 KiB (UTF-8 bytes) -> oversize. One Buffer.byteLength call for the whole input, then a
// single left-to-right pass splitting on whitespace with one more Buffer.byteLength call per run.
const OVERSIZE_MAX_INPUT_BYTES = 1024 * 1024;
const OVERSIZE_MAX_TOKEN_BYTES = 64 * 1024;
function checkOversize(text) {
  if (Buffer.byteLength(text, 'utf8') > OVERSIZE_MAX_INPUT_BYTES) return true;
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    const start = i;
    while (i < n && !/\s/.test(text[i])) i++;
    if (i > start && Buffer.byteLength(text.slice(start, i), 'utf8') > OVERSIZE_MAX_TOKEN_BYTES) return true;
  }
  return false;
}

function checkQuoteBalance(text) {
  let state = 'normal';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === 'normal') {
      if (c === "'") state = 'squote';
      else if (c === '"') state = 'dquote';
      else if (c === '#') {
        const prev = i === 0 ? '' : text[i - 1];
        if (prev === '' || /\s/.test(prev) || ';&|(\n'.indexOf(prev) !== -1) {
          while (i < text.length && text[i] !== '\n') i++;
        }
      }
    } else if (state === 'squote') {
      if (c === "'") state = 'normal';
    } else {
      if (c === '"' && text[i - 1] !== '\\') state = 'normal';
    }
  }
  return { balanced: state === 'normal' };
}

// ── line-continuation elimination (revision① "续行"): backslash-newline removed before segmenting,
// except inside single quotes (literal there). Runs once on the whole command text before any scanning.
function stripLineContinuations(text) {
  return stripLineContinuationsWithMap(text).text;
}

// same transform as stripLineContinuations, but also returns origIndex: origIndex[k] is the position
// in the ORIGINAL `text` that output character k came from (length = out.length + 1; the last entry is
// text.length, an end-of-string sentinel) — lets source_span report real original line/col even though
// the segmenter scans the continuation-collapsed buffer (contract 修订① "续行": "source_span 记原始行列").
function stripLineContinuationsWithMap(text) {
  let out = '';
  const origIndex = [];
  let state = 'normal';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === 'normal' && c === '\\' && text[i + 1] === '\n') { i++; continue; }
    if (state === 'normal') {
      if (c === "'") state = 'squote';
      else if (c === '"') state = 'dquote';
    } else if (state === 'squote') {
      if (c === "'") state = 'normal';
    } else if (state === 'dquote') {
      if (c === '"' && text[i - 1] !== '\\') state = 'normal';
    }
    out += c;
    origIndex.push(i);
  }
  origIndex.push(text.length);
  return { text: out, origIndex };
}

function buildLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function makePosToLineCol(lineStarts) {
  return function (absPos) {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= absPos) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: absPos - lineStarts[lo] + 1 };
  };
}

function hasAnsiCQuote(text) {
  let state = 'normal';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === 'squote') { if (c === "'") state = 'normal'; continue; }
    if (state === 'dquote') { if (c === '"' && text[i - 1] !== '\\') state = 'normal'; continue; }
    if (c === "'") { state = 'squote'; continue; }
    if (c === '"') { state = 'dquote'; continue; }
    if (c === '$' && text[i + 1] === "'") return true;
  }
  return false;
}

function findDisallowedParamExpansion(text) {
  const masked = maskSingleQuoteOnly(text);
  const re = /\$\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(masked))) {
    const inner = m[1];
    if (inner === '?') continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) continue;
    if (/^PIPESTATUS(\[[^\]]*\])?$/.test(inner)) continue;
    return true;
  }
  return false;
}

function stripTrailingComment(text) {
  const masked = maskBothQuotesOnly(text);
  for (let i = 0; i < text.length; i++) {
    if (masked[i] === '#') {
      const prev = i === 0 ? '' : text[i - 1];
      if (prev === '' || /\s/.test(prev) || ';&|(\n'.indexOf(prev) !== -1) return text.slice(0, i);
    }
  }
  return text;
}

// ── heredoc skip-range detection (structural scan uses the fully-blanked mask) ─────────────────────
function findHeredocSkips(text, masked) {
  const skips = [];
  const re = /<<-?~?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let m;
  while ((m = re.exec(text))) {
    const idx = m.index;
    if (masked[idx] !== '<') continue;
    const delim = m[2];
    const afterMarker = idx + m[0].length;
    const markerLineEnd = text.indexOf('\n', afterMarker);
    if (markerLineEnd === -1) continue;
    let searchFrom = markerLineEnd + 1;
    let bodyEnd = -1;
    while (searchFrom <= text.length) {
      const nextNL = text.indexOf('\n', searchFrom);
      const lineText = nextNL === -1 ? text.slice(searchFrom) : text.slice(searchFrom, nextNL);
      if (lineText.trim() === delim) { bodyEnd = nextNL === -1 ? text.length : nextNL; break; }
      if (nextNL === -1) break;
      searchFrom = nextNL + 1;
    }
    if (bodyEnd !== -1) skips.push({ markerStart: idx, bodyEnd, markerLineEnd, markerMatch: m[0], markerMatchStart: idx });
  }
  return skips;
}

// ── quote-aware word tokenizer: raw (verbatim incl. quote chars), value (quote-stripped), pieces
// (ordered spans of {text, quoted}) so callers can tell which parts came from single quotes (fully
// inert — no expansion) vs double-quoted/bare (live for $NAME expansion).
function buildPiecesFromRaw(raw) {
  const pieces = [];
  let value = '';
  let i = 0;
  const n = raw.length;
  let cur = null;
  function push(kind, ch) {
    if (!cur || cur.quoted !== kind) { cur = { text: '', quoted: kind }; pieces.push(cur); }
    cur.text += ch;
    value += ch;
  }
  while (i < n) {
    const c = raw[i];
    if (c === "'") {
      i++;
      while (i < n && raw[i] !== "'") { push('single', raw[i]); i++; }
      if (i < n) i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && !(raw[i] === '"' && raw[i - 1] !== '\\')) { push('double', raw[i]); i++; }
      if (i < n) i++;
      continue;
    }
    push('none', c);
    i++;
  }
  return { value, pieces };
}

function tokenizeWordsV2(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    let raw = '';
    while (i < n && !/\s/.test(text[i])) {
      const c = text[i];
      // amendment 8 item 2: an unquoted backslash escapes exactly the next character (space
      // included) -- consumed as an inseparable pair so a backslash-escaped space never ends the
      // token, and so a backslash-escaped quote never opens a quote span.
      if (c === '\\' && i + 1 < n) { raw += c + text[i + 1]; i += 2; continue; }
      if (c === "'") {
        raw += c; i++;
        while (i < n && text[i] !== "'") { raw += text[i]; i++; }
        if (i < n) { raw += text[i]; i++; }
        continue;
      }
      if (c === '"') {
        raw += c; i++;
        while (i < n && !(text[i] === '"' && text[i - 1] !== '\\')) { raw += text[i]; i++; }
        if (i < n) { raw += text[i]; i++; }
        continue;
      }
      raw += c; i++;
    }
    const { value, pieces } = buildPiecesFromRaw(raw);
    tokens.push({ raw, value, pieces });
  }
  return tokens;
}

function trivialUnquotedToken(text) {
  return { raw: text, value: text, pieces: text.length ? [{ text, quoted: 'none' }] : [] };
}

function classifyQuote(pieces) {
  let hasNone = false, hasSingle = false, hasDouble = false;
  for (const p of pieces) {
    if (p.text.length === 0) continue;
    if (p.quoted === 'none') hasNone = true;
    else if (p.quoted === 'single') hasSingle = true;
    else if (p.quoted === 'double') hasDouble = true;
  }
  const count = [hasNone, hasSingle, hasDouble].filter(Boolean).length;
  if (count > 1) return 'mixed';
  if (hasSingle) return 'single';
  if (hasDouble) return 'double';
  return 'none';
}

// expands only $NAME / ${NAME} against literal state_assignments known so far in THIS command.
// amendment 8 item 2: token-internal backslash escapes decode to the literal character (raw keeps
// the backslash); a backslash-escaped "$" is not a $NAME/${NAME} expansion trigger, so "\$?" never
// produces a status_refs entry. Other backslash-<char> pairs (not one of these 4) are left verbatim
// (untested by the fixture; passing both characters through is the conservative default).
const BACKSLASH_ESCAPES = { ' ': ' ', $: '$', '"': '"', '\\': '\\' };
function decodePieceText(text, stateAssignments, expansionRefs, unresolvedNames) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && Object.prototype.hasOwnProperty.call(BACKSLASH_ESCAPES, text[i + 1])) {
      out += BACKSLASH_ESCAPES[text[i + 1]];
      i += 2;
      continue;
    }
    if (text[i] === '$') {
      const m = /^\$(\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(text.slice(i));
      if (m) {
        const braced = m[1][0] === '{';
        const name = braced ? m[2] : m[3];
        if (name === 'PIPESTATUS') { out += m[0]; i += m[0].length; continue; }
        expansionRefs.push({ name, kind: braced ? 'braced' : 'plain' });
        const st = stateAssignments.get(name);
        if (st && st.isLiteral) out += st.decodedValue;
        else { out += m[0]; unresolvedNames.add(name); }
        i += m[0].length;
        continue;
      }
    }
    out += text[i]; i++;
  }
  return out;
}

function decodeOperand(tok, stateAssignments) {
  const expansionRefs = [];
  const unresolvedNames = new Set();
  let decoded = '';
  for (const p of tok.pieces) {
    if (p.quoted === 'single') { decoded += p.text; continue; }
    decoded += decodePieceText(p.text, stateAssignments, expansionRefs, unresolvedNames);
  }
  return {
    raw: tok.value,
    decoded,
    quote: classifyQuote(tok.pieces),
    expansion_refs: expansionRefs,
    unresolved_variables: [...unresolvedNames],
  };
}

// ── status_refs scanning: $? / ${?} / PIPESTATUS forms, outside single quotes ──────────────────────
function scanStatusRefsInPiece(pieceText) {
  const found = [];
  let i = 0;
  while (i < pieceText.length) {
    // amendment 8 item 2: a backslash-escaped "$" is a literal, never a status ref trigger.
    if (pieceText[i] === '\\' && Object.prototype.hasOwnProperty.call(BACKSLASH_ESCAPES, pieceText[i + 1])) {
      i += 2; continue;
    }
    if (pieceText[i] === '$' && pieceText[i + 1] === '?') { found.push('$?'); i += 2; continue; }
    if (pieceText.startsWith('${?}', i)) { found.push('${?}'); i += 4; continue; }
    const m = /^\$\{(PIPESTATUS(\[[^\]]*\])?)\}/.exec(pieceText.slice(i));
    if (m) { found.push('PIPESTATUS'); i += m[0].length; continue; }
    i++;
  }
  return found;
}

function scanStatusRefsInRaw(raw) {
  const { pieces } = buildPiecesFromRaw(raw);
  const out = [];
  for (const p of pieces) {
    if (p.quoted === 'single') continue;
    for (const kind of scanStatusRefsInPiece(p.text)) out.push({ kind, quoted: p.quoted });
  }
  return out;
}

function statusRefContext(quoted, positionKind) {
  if (positionKind === 'assignment') return 'assignment-rhs';
  return quoted === 'double' ? 'double-quoted' : 'arg';
}

// ── redirect operator matching (only called on tokens with raw===value, i.e. wholly unquoted) ──────
function matchRedirectOnToken(v) {
  let m;
  if ((m = /^(\d*)<<<(.*)$/.exec(v))) return { op: '<<<', fd: m[1] ? Number(m[1]) : null, rest: m[2] };
  if ((m = /^(\d*)<&(.*)$/.exec(v))) return { op: '<&', fd: m[1] ? Number(m[1]) : null, rest: m[2], isDup: true };
  if ((m = /^&>>(.*)$/.exec(v))) return { op: '&>>', fd: null, rest: m[1] };
  if ((m = /^&>(.*)$/.exec(v))) return { op: '&>', fd: null, rest: m[1] };
  if ((m = /^(\d*)>>(.*)$/.exec(v))) return { op: '>>', fd: m[1] ? Number(m[1]) : null, rest: m[2] };
  if ((m = /^(\d*)>\|(.*)$/.exec(v))) return { op: '>|', fd: m[1] ? Number(m[1]) : null, rest: m[2] };
  if ((m = /^(\d*)>&(.*)$/.exec(v))) return { op: '>&', fd: m[1] ? Number(m[1]) : null, rest: m[2], isDup: true };
  if ((m = /^(\d*)>(.*)$/.exec(v))) return { op: '>', fd: m[1] ? Number(m[1]) : null, rest: m[2] };
  if ((m = /^(\d*)<(.*)$/.exec(v))) return { op: '<', fd: m[1] ? Number(m[1]) : null, rest: m[2] };
  return null;
}

function stripRedirectsV2(tokens, stateAssignments) {
  const clean = [];
  const redirects = [];
  let order = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.raw !== tok.value) { clean.push(tok); continue; }
    const m = matchRedirectOnToken(tok.value);
    if (!m) { clean.push(tok); continue; }
    let targetTok, rawTarget;
    if (m.rest !== '') {
      targetTok = trivialUnquotedToken(m.rest);
      rawTarget = m.isDup ? '&' + m.rest : m.rest;
    } else if (i + 1 < tokens.length) {
      targetTok = tokens[i + 1];
      rawTarget = m.isDup ? '&' + targetTok.raw : targetTok.raw;
      i++;
    } else {
      targetTok = trivialUnquotedToken('');
      rawTarget = m.isDup ? '&' : '';
    }
    const targetObj = decodeOperand(targetTok, stateAssignments);
    let targetKind;
    if (m.isDup) targetKind = 'fd';
    else if (targetObj.unresolved_variables.length > 0) targetKind = 'unresolved';
    else if (targetObj.decoded === '/dev/null') targetKind = 'devnull';
    else targetKind = 'file';
    redirects.push({ op: m.op, fd: m.fd, raw_target: rawTarget, target: targetObj, target_kind: targetKind, order: order++ });
  }
  return { clean, redirects };
}

// ── wrapper stripping: VAR=val (captured as command_prefix_assignment), sudo/timeout/env/command/nohup ─
function stripWrappersV2(tokens) {
  let toks = tokens.slice();
  const prefixAssignments = [];
  let changed = true;
  let guard = 0;
  while (changed && guard < 20 && toks.length > 0) {
    changed = false; guard++;
    const v = toks[0].value;
    if (VARASSIGN_RE.test(toks[0].raw)) {
      prefixAssignments.push(toks[0]);
      toks.shift(); changed = true; continue;
    }
    if (v === 'sudo') {
      toks.shift(); changed = true;
      let inner = true;
      while (inner) {
        inner = false;
        if (toks[0] && toks[0].value === '-u') { toks.shift(); if (toks.length) toks.shift(); inner = true; }
        else if (toks[0] && toks[0].value === '-E') { toks.shift(); inner = true; }
      }
      continue;
    }
    if (v === 'timeout') {
      toks.shift(); changed = true;
      if (toks[0] && toks[0].value === '-k') { toks.shift(); if (toks.length) toks.shift(); }
      if (toks[0] && /^\d+[a-zA-Z]*$/.test(toks[0].value)) { toks.shift(); }
      continue;
    }
    if (v === 'env') {
      toks.shift(); changed = true;
      let inner = true;
      while (inner) {
        inner = false;
        if (toks[0] && toks[0].value === '-i') { toks.shift(); inner = true; }
        else if (toks[0] && VARASSIGN_RE.test(toks[0].raw)) { toks.shift(); inner = true; }
      }
      continue;
    }
    if (v === 'command') { toks.shift(); changed = true; continue; }
    if (v === 'nohup') { toks.shift(); changed = true; continue; }
  }
  return { toks, prefixAssignments };
}

function basenameLower(p) {
  let b = path.win32.basename(String(p || ''));
  b = b.toLowerCase();
  if (b.endsWith('.exe')) b = b.slice(0, -4);
  return b;
}

function findSub(exe, tokens) {
  const opts = GLOBAL_OPTS[exe] || { withArg: new Set() };
  let i = 0;
  while (i < tokens.length) {
    const v = tokens[i].value;
    if (FUSED_LONG_OPT_RE.test(v)) { i++; continue; }
    if (opts.withArg.has(v)) { i += 2; continue; }
    if (v.charAt(0) === '-') { i++; continue; }
    return { sub: v, afterIndex: i + 1 };
  }
  return { sub: null, afterIndex: i };
}

// v1.2 修订⑩ 勘误2 (Opus B1+B2 review, B2 MEDIUM-1 regression): per-command table of flags that take a
// SEPARATE value token, consulted by every bounded flag-scan below (detectDialectWrapper,
// detectBlindWrapper, detectLauncher's launcherCarried_* helpers) so scanning correctly skips a
// value-taking flag's OWN value before deciding whether the next token is another flag or the start of
// the carried/wrapped command. Without this, `bash -o pipefail -lc '...'`'s scan stopped at 'pipefail'
// (mistaken for the carried command) and never reached the real wrapper flag '-lc', going fully blind
// (Wx30-32/34-36). pwsh/powershell flag names are matched case-insensitively (real pwsh flags are); every
// other command's flags are matched exactly as the contract lists them (ssh's -F/-J are genuinely
// case-sensitive, distinct from any lowercase -f/-j).
const FLAG_VALUE_TABLE = {
  bash: ['-o', '-O', '+o', '+O', '--rcfile', '--init-file'],
  sh: ['-o', '-O', '+o', '+O', '--rcfile', '--init-file'],
  zsh: ['-o', '-O', '+o', '+O', '--rcfile', '--init-file'],
  dash: ['-o', '-O', '+o', '+O', '--rcfile', '--init-file'],
  ksh: ['-o', '-O', '+o', '+O', '--rcfile', '--init-file'],
  pwsh: ['-executionpolicy', '-ep', '-workingdirectory', '-windowstyle', '-inputformat', '-outputformat', '-configurationname', '-version', '-file'],
  powershell: ['-executionpolicy', '-ep', '-workingdirectory', '-windowstyle', '-inputformat', '-outputformat', '-configurationname', '-version', '-file'],
  nice: ['-n'],
  ionice: ['-c', '-n', '-p'],
  watch: ['-n'],
  docker: ['-u', '-w', '-e', '--user', '--env', '--workdir', '--name', '-v', '-p'],
  podman: ['-u', '-w', '-e', '--user', '--env', '--workdir', '--name', '-v', '-p'],
  kubectl: ['-n', '--namespace', '-c', '--container'],
  ssh: ['-p', '-i', '-l', '-o', '-F', '-J'],
  flock: ['-w'],
  xargs: ['-n', '-I', '-P'],
  stdbuf: ['-i', '-o', '-e'],
  su: ['-l', '-s'],
};
function flagTakesValue(exeName, token) {
  const list = FLAG_VALUE_TABLE[exeName];
  if (!list) return false;
  if (exeName === 'pwsh' || exeName === 'powershell') return list.indexOf(token.toLowerCase()) !== -1;
  return list.indexOf(token) !== -1;
}

// v1.2 修订⑩ 勘误2 (Opus B1+B2 review, B2 MEDIUM-2): the dialect (recursible) path used an unbounded
// `findIndex` for '-c'/'-Command'/'/c', scanning every token in the segment regardless of position --
// `bash run.sh -c ls | head -1` took the script's OWN `-c ls` as the inner wrapped command, losing gate
// B (a false negative) and adding a spurious unsupported row. The same bounded flag-scan rule as
// detectBlindWrapper/detectLauncher applies here: only a '-c'/'-Command'/'/c' found before the first
// non-flag, non-value token is a wrapper flag; one found after (Wx33: 'run.sh' stops the scan before
// '-c' is ever reached) belongs to the script's own arguments.
function detectDialectWrapper(toks) {
  if (!toks[0]) return null;
  const exe0 = basenameLower(toks[0].value);
  if (exe0 === 'bash' || exe0 === 'sh') {
    let i = 1;
    while (i < toks.length && toks[i].value.charAt(0) === '-') {
      if (toks[i].value === '-c') {
        return toks[i + 1] ? { kind: 'posix', inner: toks[i + 1].value, wrapperToks: toks.slice(0, i) } : null;
      }
      if (flagTakesValue(exe0, toks[i].value) && i + 1 < toks.length) { i += 2; continue; }
      i++;
    }
    return null;
  }
  if (exe0 === 'wsl') {
    const rest = toks.slice(1).map((t) => t.value).join(' ');
    if (rest) return { kind: 'posix', inner: rest, wrapperToks: toks.slice(0, 1) };
    return null;
  }
  if (exe0 === 'powershell' || exe0 === 'pwsh') {
    let i = 1;
    while (i < toks.length && toks[i].value.charAt(0) === '-') {
      if (/^-command$/i.test(toks[i].value)) {
        return toks[i + 1] ? { kind: 'powershell', inner: toks[i + 1].value, wrapperToks: toks.slice(0, i) } : null;
      }
      if (flagTakesValue(exe0, toks[i].value) && i + 1 < toks.length) { i += 2; continue; }
      i++;
    }
    return null;
  }
  if (exe0 === 'cmd') {
    // cmd's own flags are '/'-prefixed, not '-'-prefixed -- a separate bounded scan on that marker
    // character; no cmd flag in the value table takes a separate value token.
    let i = 1;
    while (i < toks.length && toks[i].value.charAt(0) === '/') {
      if (/^\/c$/i.test(toks[i].value)) {
        return toks[i + 1] ? { kind: 'cmd', inner: toks[i + 1].value, wrapperToks: toks.slice(0, i) } : null;
      }
      i++;
    }
    return null;
  }
  return null;
}

// v2.25 wrapper_commands (fab blind attack MEDIUM-5): detectDialectWrapper above only recognizes 4
// narrow, literal-token shapes that CAN be recursively re-parsed (bash/sh literal -c, wsl, pwsh/
// powershell literal -Command, cmd literal /c). Every other shell-wrapper shape -- eval, alias, any
// short-flag-combination invocation of a POSIX shell (-lc/-ic/-ec/-xc/--command), powershell/pwsh
// -c/-EncodedCommand, and xargs followed by any such wrapper -- is invisible to the parser today,
// so the gate sees an ordinary unmarked segment and emits nothing (fully blind: zero rows looks like
// a true negative). detectBlindWrapper below is a SEPARATE, non-recursive detector: it never attempts
// to parse the wrapped command string, it only recognizes the outer shape so the caller can mark the
// whole segment unsupported:wrapper. It is only consulted when detectDialectWrapper already returned
// null, so it can never fire for a shape the recursible path already handles (that path is checked
// first at the call site) -- this keeps the existing bash/sh -c and pwsh/powershell -Command recursion
// (and the sh -c "control" case, contract Wx05) completely unchanged.
const POSIX_WRAPPER_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const POWERSHELL_WRAPPER_EXES = new Set(['powershell', 'pwsh']);
// any short-flag cluster containing the letter c (-c, -lc, -ic, -ec, -xc, -cl, ...) -- deliberately
// permissive since the contract lists these as illustrative, not exhaustive, examples of "short-flag
// combination" wrappers.
const POSIX_WRAPPER_SHORT_FLAG_RE = /^-[a-zA-Z]*c[a-zA-Z]*$/;
function isPosixWrapperFlag(v) {
  return POSIX_WRAPPER_SHORT_FLAG_RE.test(v) || v === '--command';
}
function isPowershellWrapperFlag(v) {
  return /^-c$/i.test(v) || /^-encodedcommand$/i.test(v);
}
function isCmdWrapperFlag(v) {
  return /^\/c$/i.test(v);
}
function isWrapperFlagForExe(exeName, v) {
  if (POSIX_WRAPPER_SHELLS.has(exeName)) return isPosixWrapperFlag(v);
  if (POWERSHELL_WRAPPER_EXES.has(exeName)) return isPowershellWrapperFlag(v);
  if (exeName === 'cmd') return isCmdWrapperFlag(v);
  return false;
}
function isBlindWrapperExe(exeName) {
  return POSIX_WRAPPER_SHELLS.has(exeName) || POWERSHELL_WRAPPER_EXES.has(exeName) || exeName === 'cmd';
}
// v1.2 修订⑩ (contract v2.26 launcher_commands, fab LOW-4 旗标止点; 勘误2 (Opus B1+B2 review, B2
// MEDIUM-1 regression) flag-value skip): flag scanning for the blind-wrapper detector and the launcher
// detector below stops at the first token that neither starts with '-' NOR is the value of a preceding
// value-taking flag (FLAG_VALUE_TABLE above) -- everything from that point on belongs to the wrapped/
// carried command's OWN arguments, not to the outer invocation's own flags. `bash run.sh --config x -c |
// head -1` and `sh ./scripts/test.sh -vc 2>&1 | tail -5` (contract Wx28/Wx29) were misjudged
// unsupported:wrapper because the pre-v2.26 scan checked every token in the segment regardless of
// position; `bash -o pipefail -lc '...'` (Wx30) went fully blind after that first fix because the scan
// stopped at 'pipefail' (the VALUE of -o), never reaching '-lc' -- exeName lets the scan skip a known
// flag's value instead of mistaking it for the carried command's start.
function flagScanStopIndex(toks, start, exeName) {
  let i = start;
  while (i < toks.length && toks[i].value.charAt(0) === '-') {
    if (flagTakesValue(exeName, toks[i].value) && i + 1 < toks.length) { i += 2; continue; }
    i++;
  }
  return i;
}
function detectBlindWrapper(toks) {
  if (!toks[0]) return false;
  const exe0 = basenameLower(toks[0].value);
  if (exe0 === 'eval' || exe0 === 'alias') return true;
  if (isBlindWrapperExe(exe0)) {
    const stop = flagScanStopIndex(toks, 1, exe0);
    for (let i = 1; i < stop; i++) {
      if (isWrapperFlagForExe(exe0, toks[i].value)) return true;
    }
    return false;
  }
  if (exe0 === 'xargs') {
    for (let i = 1; i < toks.length; i++) {
      const innerExe = basenameLower(toks[i].value);
      if (!isBlindWrapperExe(innerExe)) continue;
      const innerStop = flagScanStopIndex(toks, i + 1, innerExe);
      for (let j = i + 1; j < innerStop; j++) {
        if (isWrapperFlagForExe(innerExe, toks[j].value)) return true;
      }
    }
    return false;
  }
  return false;
}

// v1.2 修订⑩ (contract v2.26 launcher_commands, codex 终审 #2 / fab LOW-4): a LAUNCHER hands a carried
// command to another executor (ssh <host> <cmd...>, docker/podman exec/run, kubectl exec, npx, nice/
// stdbuf/ionice, find -exec/-execdir, watch, exec/builtin/su -c/flock/script -c|-qc/busybox/cmd /k, and
// interpreter one-liners node -e/python -c/perl -e/ruby -e). Only consulted when BOTH detectDialectWrapper
// and detectBlindWrapper already returned null/false (call site order), so it can never fire for a shape
// either of those recursible/blind paths already handles. detectLauncher returns the CARRIED tokens (the
// portion of the segment handed to the other executor) only when the hit condition for that launcher's
// KIND holds (carriedHitsLauncherCondition below); otherwise it returns null and the segment falls
// through to ordinary command parsing unmarked (contract Wx19: "ssh host ls -la" carries an ordinary
// command, stays `command`). Never recurses into the carried tokens -- a hit marks the WHOLE outer
// segment unsupported:wrapper (BLANK_UNSUPPORTED shape), same sub-class as detectBlindWrapper, no new
// parse_status.
//
// v1.2 修订⑩ 勘误2 (Opus B1+B2 review, B2 LOW-1): the carried-pipe/exit-status-ref conditions apply only
// to STRING launchers -- ones that hand a single STRING to another evaluator (ssh, watch, su -c, script
// -c|-qc, cmd /k, interpreter one-liners) -- where a `|` genuinely sits inside shell-interpretable text.
// ARGV launchers (find -exec|-execdir, nice, ionice, stdbuf, npx, flock, docker|podman|kubectl exec|run,
// busybox, exec, builtin) hand an argv LIST to execve(); a `|` inside one argv element is just a byte in
// that element's own value, never a shell pipe, so they hit ONLY when the carried argv is itself an
// amendment-9 wrapper -- `find . -name '*.log' -exec grep -lE 'err|warn' {} \; | head -5` (Wx37) records
// nothing (find is browse; the '|' inside grep's own -E pattern is not a pipe).
const LAUNCHER_EXIT_STATUS_RE = /\$\?|\$\{\?\}|\$status\b|%ERRORLEVEL%|\$LASTEXITCODE/i;
function carriedContainsPipe(carriedToks) {
  return carriedToks.some((t) => t.value.indexOf('|') !== -1);
}
function carriedContainsExitStatusRef(carriedToks) {
  return carriedToks.some((t) => LAUNCHER_EXIT_STATUS_RE.test(t.value));
}
function carriedIsAmendment9Wrapper(carriedToks) {
  if (!carriedToks.length) return false;
  if (detectDialectWrapper(carriedToks)) return true;
  return detectBlindWrapper(carriedToks);
}
function carriedHitsLauncherCondition(carriedToks, isStringLauncher) {
  if (!carriedToks || carriedToks.length === 0) return false;
  if (isStringLauncher) {
    return carriedContainsPipe(carriedToks) || carriedContainsExitStatusRef(carriedToks) || carriedIsAmendment9Wrapper(carriedToks);
  }
  return carriedIsAmendment9Wrapper(carriedToks);
}

// Each launcherCarried_* returns the carried-command token slice for its shape, or null when the tokens
// don't structurally match that launcher's own syntax at all (e.g. `docker` without an `exec`/`run` sub,
// or `su` without a literal `-c`) -- distinct from "matched the shape but nothing follows", which returns
// an empty array (also treated as no-hit by carriedHitsLauncherCondition's length check).
function launcherCarried_ssh(toks) {
  const i = flagScanStopIndex(toks, 1, 'ssh');
  if (i >= toks.length) return null; // no host token
  return toks.slice(i + 1);
}
// v1.2 修订⑩ 勘误2 (B2 LOW-2): also recognizes `docker|podman compose exec|run` (the sub-subcommand
// sits one token further in; opts are still scanned with the outer exe's own value table).
function launcherCarried_dockerPodmanExecOrRun(toks) {
  if (!toks[1]) return null;
  const exeForFlags = basenameLower(toks[0].value);
  let subIdx = 1;
  if (toks[1].value === 'compose' && toks[2] && (toks[2].value === 'exec' || toks[2].value === 'run')) subIdx = 2;
  const sub = toks[subIdx];
  if (!sub || (sub.value !== 'exec' && sub.value !== 'run')) return null;
  const i = flagScanStopIndex(toks, subIdx + 1, exeForFlags);
  if (i >= toks.length) return null; // no container/image token
  return toks.slice(i + 1);
}
// v1.2 修订⑩ 勘误2 (B2 LOW-2): kubectl's global flags (-n/--namespace, -c/--container) can precede
// `exec`, not only follow it -- `kubectl -n ns exec p -- ...` (Wx39) -- so the scan for `exec` itself
// must skip them first, using the same bounded flag-value scan as every other launcher.
function launcherCarried_kubectlExec(toks) {
  const i = flagScanStopIndex(toks, 1, 'kubectl');
  if (!toks[i] || toks[i].value !== 'exec') return null;
  const dashIdx = toks.findIndex((t, idx) => idx > i && t.value === '--');
  if (dashIdx === -1) return null;
  return toks.slice(dashIdx + 1);
}
function launcherCarried_npx(toks) {
  if (toks.length < 2) return null;
  if (toks[1].value === '--') return toks.slice(2);
  return toks.slice(1);
}
function launcherCarried_niceStdbufIonice(toks) {
  if (toks.length < 2) return null;
  const i = flagScanStopIndex(toks, 1, basenameLower(toks[0].value));
  if (i >= toks.length) return null;
  return toks.slice(i);
}
function launcherCarried_findExec(toks) {
  const idx = toks.findIndex((t) => t.value === '-exec' || t.value === '-execdir');
  if (idx === -1) return null;
  let end = toks.length;
  for (let j = idx + 1; j < toks.length; j++) {
    const v = toks[j].value;
    if (v === '+' || v === ';' || v === '\\;') { end = j; break; }
  }
  return toks.slice(idx + 1, end);
}
function launcherCarried_watch(toks) {
  if (toks.length < 2) return null;
  const i = flagScanStopIndex(toks, 1, 'watch');
  if (i >= toks.length) return null;
  return toks.slice(i);
}
function launcherCarried_restFromIndex1(toks) {
  return toks.length > 1 ? toks.slice(1) : null;
}
function launcherCarried_suC(toks) {
  if (toks.length < 2 || toks[1].value !== '-c') return null;
  return toks.length > 2 ? toks.slice(2) : null;
}
function launcherCarried_flock(toks) {
  if (toks.length < 2) return null;
  const i = flagScanStopIndex(toks, 1, 'flock');
  if (i >= toks.length) return null; // no lock token
  return toks.slice(i + 1);
}
function launcherCarried_singleTokenAfterFlagAt1(toks, flagTest) {
  if (toks.length < 2 || !flagTest(toks[1].value)) return null;
  return toks[2] ? [toks[2]] : null;
}
function launcherCarried_scriptC(toks) {
  return launcherCarried_singleTokenAfterFlagAt1(toks, (v) => v === '-c' || v === '-qc');
}
function launcherCarried_cmdK(toks) {
  return launcherCarried_singleTokenAfterFlagAt1(toks, (v) => /^\/k$/i.test(v));
}
// v1.2 修订⑩ 勘误2 (B2 LOW-2): python3/pythonw carry a pipe the same way python does (Wx38); node's own
// leading flags (--no-warnings, ...) can precede -e (Wx41) -- scanned with node's own value table (none
// registered, so any '-'-prefixed token before -e is skipped as a no-value flag).
const INTERPRETER_ONE_LINER_FLAGS = { node: '-e', python: '-c', python3: '-c', pythonw: '-c', perl: '-e', ruby: '-e' };
function launcherCarried_interpreterOneLiner(toks, exeName, flag) {
  let i = 1;
  while (i < toks.length && toks[i].value.charAt(0) === '-') {
    if (toks[i].value === flag) return toks[i + 1] ? [toks[i + 1]] : null;
    if (flagTakesValue(exeName, toks[i].value) && i + 1 < toks.length) { i += 2; continue; }
    i++;
  }
  return null;
}
// v1.2 修订⑩ 勘误2 (B2 LOW-1): which launchers hand a STRING to another evaluator (get the pipe/exit-ref
// conditions too) vs. an ARGV list (amendment-9-wrapper condition only) -- interpreter one-liners are
// always STRING launchers (their argument is source text, not an argv element to execve()).
const STRING_LAUNCHER_EXES = new Set(['ssh', 'watch', 'su', 'script', 'cmd']);
function isStringLauncherExe(exe0) {
  return STRING_LAUNCHER_EXES.has(exe0) || Object.prototype.hasOwnProperty.call(INTERPRETER_ONE_LINER_FLAGS, exe0);
}
function launcherCarriedFor(exe0, toks) {
  switch (exe0) {
    case 'ssh': return launcherCarried_ssh(toks);
    case 'docker':
    case 'podman': return launcherCarried_dockerPodmanExecOrRun(toks);
    case 'kubectl': return launcherCarried_kubectlExec(toks);
    case 'npx': return launcherCarried_npx(toks);
    case 'nice':
    case 'stdbuf':
    case 'ionice': return launcherCarried_niceStdbufIonice(toks);
    case 'find': return launcherCarried_findExec(toks);
    case 'watch': return launcherCarried_watch(toks);
    case 'exec':
    case 'builtin':
    case 'busybox': return launcherCarried_restFromIndex1(toks);
    case 'su': return launcherCarried_suC(toks);
    case 'flock': return launcherCarried_flock(toks);
    case 'script': return launcherCarried_scriptC(toks);
    case 'cmd': return launcherCarried_cmdK(toks);
    default: {
      const flag = INTERPRETER_ONE_LINER_FLAGS[exe0];
      return flag ? launcherCarried_interpreterOneLiner(toks, exe0, flag) : null;
    }
  }
}
function detectLauncher(toks) {
  if (!toks[0]) return null;
  const exe0 = basenameLower(toks[0].value);
  const carried = launcherCarriedFor(exe0, toks);
  if (!carried || carried.length === 0) return null;
  return carriedHitsLauncherCondition(carried, isStringLauncherExe(exe0)) ? carried : null;
}

// ── shell option changes (from `set` segments): -o/+o NAME, fused -euo / +eu letters ────────────────
const OPTION_LETTER_MAP = { e: 'errexit', u: 'nounset', x: 'xtrace' };
function parseShellOptionChanges(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].raw;
    if (a === '-o' || a === '+o') {
      const on = a === '-o';
      if (i + 1 < args.length) {
        const name = args[i + 1].raw;
        const option = ['pipefail', 'errexit', 'nounset', 'xtrace'].includes(name) ? name : 'other';
        out.push({ option, on, position: { kind: 'arg', index: i + 1 } });
        i++;
      }
      continue;
    }
    const m = /^([+-])([a-zA-Z]+)$/.exec(a);
    if (m) {
      const on = m[1] === '-';
      for (const ch of m[2]) {
        if (ch === 'o') {
          if (i + 1 < args.length) {
            const name = args[i + 1].raw;
            const option = ['pipefail', 'errexit', 'nounset', 'xtrace'].includes(name) ? name : 'other';
            out.push({ option, on, position: { kind: 'arg', index: i + 1 } });
            i++;
          }
        } else if (OPTION_LETTER_MAP[ch]) {
          out.push({ option: OPTION_LETTER_MAP[ch], on, position: { kind: 'arg', index: i } });
        } else {
          out.push({ option: 'other', on, position: { kind: 'arg', index: i } });
        }
      }
    }
  }
  return out;
}

// ============================================================================
// block-aware POSIX top-level segmenter
// ============================================================================
function classifyFirstWord(word, blockStack) {
  if (BLOCK_OPENERS.has(word)) return 'opener';
  if (BLOCK_CLOSERS.has(word)) return 'closer';
  if (word === 'elif') return blockStack.length > 0 ? 'elif' : null;
  if (SELF_ISOLATING_TRANSITIONS.has(word)) return blockStack.length > 0 ? 'transition' : null;
  if (word === 'in') {
    if (blockStack.length > 0 && blockStack[blockStack.length - 1].opener === 'case') return 'transition';
    return null;
  }
  return null;
}

function peekKeywordAt(text, i) {
  for (const kw of KEYWORD_CANDIDATES) {
    if (text.startsWith(kw, i)) {
      const after = text[i + kw.length];
      const afterOk = after === undefined || /\s/.test(after) || ';&|()\n'.indexOf(after) !== -1;
      if (afterOk) return kw;
    }
  }
  return null;
}

// amendment 7 item 2: "NAME()" (whitespace allowed inside the parens) or "function NAME" (an
// optional trailing "()" also allowed), immediately followed by "{" or "(", opens a function
// definition. Returns {opener} at the position of that "{"/"(" if `pos` starts such a header, else null.
const FUNC_DEF_NAME_PAREN_RE = /^[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*/;
const FUNC_DEF_FUNCTION_KW_RE = /^function\s+[A-Za-z_][A-Za-z0-9_]*\s*(\(\s*\))?\s*/;
function matchFunctionDefHeaderAt(text, pos) {
  let m = FUNC_DEF_NAME_PAREN_RE.exec(text.slice(pos));
  if (!m) m = FUNC_DEF_FUNCTION_KW_RE.exec(text.slice(pos));
  if (!m) return null;
  const headerEnd = pos + m[0].length;
  const opener = text[headerEnd];
  if (opener === '{' || opener === '(') return { openerPos: headerEnd, opener };
  return null;
}

// scans from just after an opening "{"/"(" (openPos points AT the opener) for its matching close,
// quote/comment-aware, counting nested occurrences of the SAME bracket kind. Returns the index right
// AFTER the matching close, or -1 if the text ends first (unclosed).
function findMatchingBracketEnd(text, openPos) {
  const openChar = text[openPos];
  const closeChar = openChar === '{' ? '}' : ')';
  let depth = 1;
  let i = openPos + 1;
  let quoteState = 'normal';
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoteState === 'squote') { if (c === "'") quoteState = 'normal'; i++; continue; }
    if (quoteState === 'dquote') { if (c === '"' && text[i - 1] !== '\\') quoteState = 'normal'; i++; continue; }
    if (c === "'") { quoteState = 'squote'; i++; continue; }
    if (c === '"') { quoteState = 'dquote'; i++; continue; }
    if (c === '#') {
      const prev = i === 0 ? '' : text[i - 1];
      if (prev === '' || /\s/.test(prev) || ';&|(\n'.indexOf(prev) !== -1) {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
    }
    if (c === openChar) { depth++; i++; continue; }
    if (c === closeChar) { depth--; i++; if (depth === 0) return i; continue; }
    i++;
  }
  return -1;
}

function segmentPosixBlockAware(text) {
  const n = text.length;
  const maskedForHeredoc = maskQuotesAndComments(text);
  const heredocSkips = findHeredocSkips(text, maskedForHeredoc);
  const dquoteTaints = findDquoteSubstitutionTaints(text);

  const groups = [];
  const blockStack = [];
  const finalSegs = [];

  let quoteState = 'normal';
  let parenDepth = 0;
  let segStart = 0;
  let sepBefore = 'start';
  let flags = { subshell: false, cmdsubst: false, backtick: false, heredoc: false, functionDef: false };
  let firstWordOfSeg = null;
  let forceNextWordCut = false;

  function finalizeSeg(endIdx, nextSepReal, nextStart) {
    for (const t of dquoteTaints) {
      if (t.pos >= segStart && t.pos < endIdx) {
        if (t.kind === 'command-substitution') flags.cmdsubst = true; else flags.backtick = true;
      }
    }
    let structReason = null;
    if (flags.functionDef) structReason = 'function-def';
    else if (flags.subshell) structReason = 'subshell';
    else if (flags.cmdsubst) structReason = 'command-substitution';
    else if (flags.backtick) structReason = 'backtick';
    else if (flags.heredoc) structReason = 'heredoc';

    const stackBeforeLen = blockStack.length;
    const cls = firstWordOfSeg ? classifyFirstWord(firstWordOfSeg, blockStack) : null;

    let finalSep = sepBefore;
    if (cls === 'transition' || cls === 'elif' || (cls === 'opener' && stackBeforeLen > 0)) {
      finalSep = 'keyword';
    }

    let groupIdx = stackBeforeLen > 0 ? blockStack[blockStack.length - 1].groupIndex : null;
    let finalStructReason = structReason;

    if (cls === 'opener') {
      finalStructReason = null;
      const gIdx = groups.length;
      const parentIdx = stackBeforeLen > 0 ? blockStack[blockStack.length - 1].groupIndex : null;
      groups.push({
        kind: firstWordOfSeg === '{' ? 'brace-group' : 'keyword-block',
        opener: firstWordOfSeg,
        span: { start_index: finalSegs.length, end_index: finalSegs.length },
        parent: parentIdx,
      });
      groupIdx = gIdx;
      blockStack.push({ opener: firstWordOfSeg, groupIndex: gIdx });
    } else if (stackBeforeLen > 0) {
      finalStructReason = null;
      if (cls === 'closer') {
        const popped = blockStack.pop();
        groups[popped.groupIndex].span.end_index = finalSegs.length;
      }
    } else if (structReason === 'subshell' || structReason === 'heredoc') {
      const gIdx = groups.length;
      groups.push({ kind: structReason, span: { start_index: finalSegs.length, end_index: finalSegs.length }, parent: null });
      groupIdx = gIdx;
    }

    // amendment 7: a heredoc segment whose terminator was found keeps its first-line structure
    // (exe/sub/args/redirects/has_exit_status_ref/status_refs from normal parsing of the "<<" line,
    // with the heredoc marker token itself excluded) instead of the fully-blanked v1.1 shape.
    let heredocFirstLineText = null;
    if (structReason === 'heredoc' && flags.heredocSkip) {
      const lineEnd = flags.heredocSkip.markerLineEnd;
      const raw = text.slice(segStart, lineEnd);
      const markerOffsetInSeg = flags.heredocSkip.markerMatchStart - segStart;
      heredocFirstLineText = raw.slice(0, markerOffsetInSeg) + raw.slice(markerOffsetInSeg + flags.heredocSkip.markerMatch.length);
    }

    finalSegs.push({
      text: text.slice(segStart, endIdx),
      sepBefore: finalSep,
      group: groupIdx,
      structReason: finalStructReason,
      blockOpener: groupIdx !== null && groups[groupIdx] ? groups[groupIdx].opener : null,
      isKeywordBlockMember: groupIdx !== null && groups[groupIdx] && (groups[groupIdx].kind === 'keyword-block' || groups[groupIdx].kind === 'brace-group'),
      spanStart: segStart,
      spanEnd: endIdx,
      heredocFirstLineText,
    });

    segStart = nextStart;
    sepBefore = nextSepReal;
    flags = { subshell: false, cmdsubst: false, backtick: false, heredoc: false, functionDef: false };
    firstWordOfSeg = null;
  }

  // amendment 8 item 1: a real separator with NOTHING accumulated since segStart (trailing ";",
  // consecutive ";;" with only whitespace between, a blank line) must still act as a real separator
  // (advancing segStart/sepBefore so the NEXT real segment gets the right sep_before) but must NOT
  // finalize a phantom empty segment. Previously the operator branches below only acted when
  // `contentSoFar` was true, silently doing nothing otherwise -- which let a second ";" in "a; ; b"
  // fall through as ordinary text (gluing onto the next segment, e.g. exe becoming ";") instead of
  // being recognized as a separator at all. This helper is the single place that decides "finalize a
  // real segment" vs "just skip past the empty gap" for every operator branch below.
  function advanceOrFinalize(endIdx, sepLabel, nextStart) {
    if (text.slice(segStart, endIdx).trim() !== '') {
      finalizeSeg(endIdx, sepLabel, nextStart);
    } else {
      segStart = nextStart;
      sepBefore = sepLabel;
    }
  }

  let i = 0;
  while (i < n) {
    const c = text[i];

    if (quoteState === 'squote') { if (c === "'") quoteState = 'normal'; i++; continue; }
    if (quoteState === 'dquote') { if (c === '"' && text[i - 1] !== '\\') quoteState = 'normal'; i++; continue; }
    if (c === "'") { quoteState = 'squote'; i++; continue; }
    if (c === '"') { quoteState = 'dquote'; i++; continue; }
    if (c === '#') {
      const prev = i === 0 ? '' : text[i - 1];
      if (prev === '' || /\s/.test(prev) || ';&|(\n'.indexOf(prev) !== -1) {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
    }

    if (parenDepth === 0) {
      if (c === ';' && text[i + 1] === ';' && text[i + 2] === '&') {
        advanceOrFinalize(i, ';', i + 3); i += 3; continue;
      }
      if (c === ';' && text[i + 1] === ';') {
        advanceOrFinalize(i, ';', i + 2); i += 2; continue;
      }
      if (c === ';' && text[i + 1] === '&') {
        advanceOrFinalize(i, ';', i + 2); i += 2; continue;
      }
      if (c === ';') {
        advanceOrFinalize(i, ';', i + 1); i += 1; continue;
      }
      if (c === '\n') {
        advanceOrFinalize(i, 'newline', i + 1); i += 1; continue;
      }
      const ampIsRedirectDup = text[i - 1] === '>' || text[i - 1] === '<';
      const ampPrecedesRedirect = c === '&' && text[i + 1] === '>';
      // suppressed inside a block AND while still accumulating the opener segment itself (its own
      // condition/args text is already "inside" the construct even though the push onto blockStack
      // only happens once this segment is finalized) — e.g. "if a | b; then" must not split on "|".
      const accumulatingOpener = firstWordOfSeg !== null && BLOCK_OPENERS.has(firstWordOfSeg);
      if (blockStack.length === 0 && !accumulatingOpener) {
        if (c === '&' && text[i + 1] === '&' && !ampIsRedirectDup) {
          advanceOrFinalize(i, '&&', i + 2); i += 2; continue;
        } else if (c === '|' && text[i + 1] === '|' && text[i - 1] !== '>') {
          advanceOrFinalize(i, '||', i + 2); i += 2; continue;
        } else if (c === '|' && text[i + 1] === '&' && text[i - 1] !== '>') {
          advanceOrFinalize(i, '|&', i + 2); i += 2; continue;
        } else if (c === '|' && text[i - 1] !== '>') {
          // "|" immediately after ">" is bash's noclobber-override redirect ">|", never a real pipe.
          advanceOrFinalize(i, '|', i + 1); i += 1; continue;
        } else if (c === '&' && !ampIsRedirectDup && !ampPrecedesRedirect) {
          // a bare leading "&" (segStart===i, nothing accumulated) is left as literal content rather
          // than consumed as a separator -- preserves pre-amendment-8 behavior for this untested edge
          // case (v1.1's PowerShell call-operator note) instead of introducing a new sep_before='&'
          // reading for it; not fixture-tested either way.
          if (segStart === i) { i += 1; continue; }
          advanceOrFinalize(i, '&', i + 1); i += 1; continue;
        }
      }

      const atWordStart = !/\s/.test(c) && (i === 0 || /\s/.test(text[i - 1]) || i === segStart);
      if (atWordStart) {
        // amendment 7 item 2: "NAME()"/"function NAME" immediately followed by "{"/"(" opens a
        // function definition -- only recognized as the genuine first word of a fresh segment (not
        // mid-accumulation), matching "从 NAME 到匹配的 }/)" as one opaque unsupported:function-def span.
        if (segStart === i && firstWordOfSeg === null && !forceNextWordCut) {
          const fnHeader = matchFunctionDefHeaderAt(text, i);
          if (fnHeader) {
            const closeEnd = findMatchingBracketEnd(text, fnHeader.openerPos);
            flags.functionDef = true;
            firstWordOfSeg = '';
            i = closeEnd === -1 ? n : closeEnd;
            continue;
          }
        }
        const kw = peekKeywordAt(text, i);
        let justSet = false;
        if (forceNextWordCut) {
          finalizeSeg(i, 'keyword', i);
          forceNextWordCut = false;
          firstWordOfSeg = kw || '';
          justSet = true;
        } else if (firstWordOfSeg === null) {
          firstWordOfSeg = kw || '';
          justSet = true;
        } else if (kw) {
          // effective stack: if we are still mid-accumulation of an opener segment (e.g. scanning
          // "case x" itself), that opener has not been pushed onto blockStack yet (the push happens
          // inside finalizeSeg) but "in"/nested-opener/transition recognition must already treat it
          // as if it had been, or "case x in a|b)" would never see "in" as a trigger.
          const effStack = blockStack.length > 0 ? blockStack
            : (firstWordOfSeg !== null && BLOCK_OPENERS.has(firstWordOfSeg) ? [{ opener: firstWordOfSeg, groupIndex: -1 }] : blockStack);
          if (effStack.length > 0) {
            const clsPeek = classifyFirstWord(kw, effStack);
            if (clsPeek === 'opener' || clsPeek === 'elif' || clsPeek === 'transition') {
              finalizeSeg(i, 'keyword', i);
              firstWordOfSeg = kw;
              justSet = true;
            }
          }
        }
        if (justSet && kw) {
          const clsNow = classifyFirstWord(kw, blockStack);
          if (clsNow === 'transition') forceNextWordCut = true;
        }
        if (kw) { i += kw.length; continue; }
      }
    }

    if (c === '$' && text[i + 1] === '(') { flags.cmdsubst = true; parenDepth++; i += 2; continue; }
    if (c === '(') { if (parenDepth === 0) flags.subshell = true; parenDepth++; i++; continue; }
    if (c === ')') { if (parenDepth > 0) parenDepth--; i++; continue; }
    if (c === '`') { flags.backtick = true; i++; continue; }
    if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      flags.heredoc = true;
      const skip = heredocSkips.find((s) => s.markerStart === i);
      // amendment 7: only a heredoc whose terminator was actually found (a real body+terminator
      // exists) gets first-line structure extraction; a marker with no room for a body (single-line
      // command, no terminator found) keeps the old fully-blanked v1.1 behavior (M06 stays frozen).
      if (skip) flags.heredocSkip = skip;
      i = skip ? skip.bodyEnd : i + 2;
      continue;
    }
    i++;
  }
  finalizeSeg(n, null, n);

  if (blockStack.length > 0) {
    const openIndices = new Set(blockStack.map((b) => b.groupIndex));
    for (const b of blockStack) groups[b.groupIndex].span.end_index = finalSegs.length - 1;
    for (const s of finalSegs) {
      if (s.group !== null && openIndices.has(s.group)) s.unclosedOpener = groups[s.group].opener;
    }
  }

  return { segs: finalSegs, groups };
}

// ============================================================================
// finalize an "ordinary" raw segment into its final output shape(s)
// ============================================================================
const BLANK_UNSUPPORTED = {
  sep_before: '', redirects: [], args: [], has_exit_status_ref: false,
  assignments: [], status_refs: [], shell_option_changes: [], negated: false,
  group: null,
};

function unsupportedBlank(dialect, reason, extra) {
  return Object.assign(
    { dialect, exe: null, sub: null, kind: null, parse_status: 'unsupported:' + reason },
    BLANK_UNSUPPORTED, extra || {},
  );
}

const PS_VERB_NOUN_RE = /^[A-Z][A-Za-z0-9]*-[A-Z][A-Za-z0-9]*$/;

function segmentSimple(text, ops) {
  const masked = maskQuotesAndComments(text);
  const n = masked.length;
  const segs = [];
  let segStart = 0;
  let sepBefore = 'start';
  let i = 0;
  while (i < n) {
    const contentSoFar = text.slice(segStart, i).trim() !== '';
    let matchedOp = null;
    for (const op of ops) {
      if (op === 'newline') { if (masked[i] === '\n') { matchedOp = 'newline'; break; } continue; }
      if (masked.startsWith(op, i)) { matchedOp = op; break; }
    }
    if (matchedOp && contentSoFar) {
      segs.push({ text: text.slice(segStart, i), sepBefore, group: null, structReason: null, spanStart: segStart, spanEnd: i });
      segStart = i + matchedOp.length;
      sepBefore = matchedOp;
      i = segStart;
      continue;
    }
    i++;
  }
  segs.push({ text: text.slice(segStart), sepBefore, group: null, structReason: null, spanStart: segStart, spanEnd: n });
  return segs;
}

function buildAssignmentFromToken(t, stateAssignments, globalUnresolved, kind) {
  const eq = t.raw.indexOf('=');
  const name = t.raw.slice(0, eq);
  const rhsRaw = t.raw.slice(eq + 1);
  const rhsTok = Object.assign({ raw: rhsRaw }, buildPiecesFromRaw(rhsRaw));
  const decodedObj = decodeOperand(rhsTok, stateAssignments);
  for (const u of decodedObj.unresolved_variables) globalUnresolved.add(u);
  return {
    name, raw_value: rhsRaw, decoded_value: decodedObj.decoded,
    kind, unresolved_variables: decodedObj.unresolved_variables,
  };
}

function finalizeOrdinarySegment(ctx) {
  const { rawText, dialect, sepBefore, depth, groupIdx, structReason, unclosedOpener, blockOpener,
    isKeywordBlockMember, stateAssignments, globalUnresolved, spanStart, spanEnd, posToLineCol,
    heredocFirstLineText } = ctx;

  // contract PMM-CMD-PARSE-CONTRACT.md :29/:62 — every segment carries source_span (1-indexed;
  // continuation lines resolved against the REAL original text, not the backslash-newline-collapsed
  // scanning buffer). Computed once here and attached to every segment this call returns via finish(),
  // UNLESS a segment already carries its own (the wrapper branch's inner segments, which computed their
  // own span from their own recursive call over the inner scope's text).
  const span = posToLineCol ? {
    line: posToLineCol(spanStart).line, col: posToLineCol(spanStart).col,
    end_line: posToLineCol(spanEnd).line, end_col: posToLineCol(spanEnd).col,
  } : { line: 1, col: 1, end_line: 1, end_col: 1 };
  function finish(segs) {
    for (const s of segs) if (s.source_span === undefined) s.source_span = span;
    return segs;
  }

  if (isKeywordBlockMember || unclosedOpener) {
    const opener = unclosedOpener || blockOpener;
    const reason = unclosedOpener ? 'unclosed-' + opener : 'keyword:' + opener;
    return finish([Object.assign(unsupportedBlank(dialect, reason), { sep_before: sepBefore, group: groupIdx })]);
  }

  if (structReason === 'heredoc') {
    // amendment 7: when the segmenter found a real terminator (heredocFirstLineText present), the
    // segment keeps its first-line exe/sub/args/redirects/has_exit_status_ref/status_refs from
    // ordinary parsing of that line (heredoc marker token excluded) -- only parse_status/group are
    // forced. A marker with no terminator found (heredocFirstLineText null, e.g. M06's single-line,
    // no-body-room case) keeps the old fully-blanked v1.1 shape.
    if (heredocFirstLineText !== null && heredocFirstLineText !== undefined) {
      const subResults = finalizeOrdinarySegment({
        rawText: heredocFirstLineText, dialect, sepBefore, depth,
        groupIdx: null, structReason: null, unclosedOpener: null, blockOpener: null,
        isKeywordBlockMember: false, stateAssignments, globalUnresolved,
        spanStart, spanEnd, posToLineCol,
      });
      const base = subResults[0] || unsupportedBlank(dialect, 'heredoc');
      return finish([Object.assign({}, base, { parse_status: 'unsupported:heredoc', group: groupIdx })]);
    }
    return finish([Object.assign(unsupportedBlank(dialect, structReason), { group: groupIdx })]);
  }
  if (structReason === 'command-substitution' || structReason === 'backtick') {
    return finish([unsupportedBlank(dialect, structReason)]);
  }
  if (structReason === 'function-def') {
    // amendment 7 item 2: the whole NAME()/function-NAME body is one opaque segment; nothing inside
    // it (set -o pipefail, a pipeline, $?) leaks to root scope -- exe/sub/kind stay null. Unlike the
    // older "cannot safely tokenize" reasons (heredoc/cmdsubst/backtick, which keep the v1.1 blank
    // sep_before per the frozen M06/M07 cases), function-def is new with no v1.1 precedent to match,
    // and its only fixture case (C-F01) asserts the real separator -- so sep_before is NOT blanked.
    return finish([Object.assign(unsupportedBlank(dialect, structReason), { sep_before: sepBefore })]);
  }

  const commentStripped = stripTrailingComment(rawText);
  if (hasAnsiCQuote(commentStripped)) return finish([unsupportedBlank(dialect, 'ansi-c-quote')]);

  // array-assignment ("name=(...)"/"name+=(...)") must be detected BEFORE a bare "(" is allowed to
  // fall through to the generic subshell classification the segmenter already computed (contract
  // revision② ruling #6: "先于 subshell 检测").
  const arrayAssignHead = /^[A-Za-z_][A-Za-z0-9_]*\+?=\(/.exec(commentStripped.replace(/^\s+/, ''));
  if (arrayAssignHead) return finish([unsupportedBlank(dialect, 'array-assignment')]);

  const tokensRaw = tokenizeWordsV2(commentStripped);
  let { clean, redirects } = stripRedirectsV2(tokensRaw, stateAssignments);
  // a bare unquoted "|"/"|&" can only appear here via the heredoc-first-line sub-parse (amendment 7:
  // "首行含裸 |/|& 不拆管道仍单段" -- the top-level segmenter deliberately did not split it out); an
  // ordinary segment's text never contains one (the segmenter already split on it), so this is a no-op
  // everywhere else. Truncate there so the piped tail doesn't pollute this segment's own exe/args.
  const barePipeIdx = clean.findIndex((t) => t.raw === t.value && (t.value === '|' || t.value === '|&'));
  if (barePipeIdx !== -1) clean = clean.slice(0, barePipeIdx);

  if (clean.length > 0 && clean.every((t) => VARASSIGN_RE.test(t.raw))) {
    if (findDisallowedParamExpansion(commentStripped)) return finish([unsupportedBlank(dialect, 'parameter-expansion')]);
    const assignments = clean.map((t) => buildAssignmentFromToken(t, stateAssignments, globalUnresolved, 'state_assignment'));
    assignments.forEach((a) => { stateAssignments.set(a.name, { isLiteral: a.unresolved_variables.length === 0 && !/[$`]/.test(a.decoded_value), decodedValue: a.decoded_value }); });
    const statusRefs = [];
    assignments.forEach((a, idx) => {
      for (const hit of scanStatusRefsInRaw(a.raw_value)) {
        statusRefs.push({ kind: hit.kind, context: 'assignment-rhs', position: { kind: 'assignment', index: idx } });
      }
    });
    // contract :34 "assignments...原文;args 里不再出现": a pure-assignment segment's tokens move
    // entirely into assignments[]; v1.2's args is the per-operand-object array and a state_assignment
    // segment names no command, so it has no operands at all (args=[], not the raw "NAME=value" strings).
    return finish([{
      dialect, exe: null, sub: null, kind: 'assignment', parse_status: 'ok',
      sep_before: sepBefore, redirects: [], args: [],
      assignments, status_refs: statusRefs, shell_option_changes: [],
      has_exit_status_ref: statusRefs.length > 0, group: groupIdx, negated: false,
    }]);
  }

  const { toks: afterWrappers, prefixAssignments } = stripWrappersV2(clean);
  let toks = afterWrappers;
  let negated = false;
  if (toks[0] && toks[0].raw === '!' && toks[0].raw === toks[0].value) {
    toks = toks.slice(1);
    negated = true;
  }

  // amendment 8 item 1: a segment with no real content (trailing/consecutive separator, blank line)
  // is dropped entirely rather than reported as unsupported:empty; the caller's post-loop
  // `segments.forEach((s,i)=>{s.index=i})` densely renumbers what remains.
  if (toks.length === 0) return [];

  if (toks[0].raw === '[[' && toks[0].raw === toks[0].value) return finish([unsupportedBlank(dialect, 'keyword:[[')]);
  if (toks[0].raw === '((' && toks[0].raw === toks[0].value) return finish([unsupportedBlank(dialect, 'keyword:((')]);
  if (toks[0].value === 'time' && toks[0].raw === toks[0].value) return finish([unsupportedBlank(dialect, 'keyword:time')]);

  if (structReason === 'subshell') {
    return finish([Object.assign(unsupportedBlank(dialect, structReason), { group: groupIdx })]);
  }

  if (findDisallowedParamExpansion(commentStripped)) return finish([unsupportedBlank(dialect, 'parameter-expansion')]);

  if (depth === 0) {
    const wrap = detectDialectWrapper(toks);
    if (wrap) {
      const wrapperExe = basenameLower(toks[0].value);
      let pipefail = false, errexit = false;
      for (let k = 0; k < wrap.wrapperToks.length; k++) {
        const v = wrap.wrapperToks[k].value;
        if ((v === '-o' || v === '+o') && wrap.wrapperToks[k + 1]) {
          if (wrap.wrapperToks[k + 1].value === 'pipefail') pipefail = (v === '-o');
          if (wrap.wrapperToks[k + 1].value === 'errexit') errexit = (v === '-o');
        }
      }
      const wrapperSeg = {
        dialect, exe: wrapperExe, sub: null, kind: 'wrapper', parse_status: 'ok',
        sep_before: sepBefore, redirects: [], args: [], has_exit_status_ref: false,
        assignments: [], status_refs: [], shell_option_changes: [],
        negated, group: groupIdx, _wrapper: true, _initialOptions: { pipefail, errexit },
      };
      let innerDialect, innerRaw;
      if (wrap.kind === 'posix') { innerDialect = 'posix'; innerRaw = segmentPosixBlockAware(wrap.inner); }
      else if (wrap.kind === 'powershell') { innerDialect = 'powershell'; innerRaw = { segs: segmentSimple(wrap.inner, [';', '|', 'newline']) }; }
      else { innerDialect = 'cmd'; innerRaw = { segs: segmentSimple(wrap.inner, ['&&', '||', '&', '|', 'newline']) }; }

      // best-effort inner source_span: wrap.inner is a quote-stripped substring of the outer token, so
      // its characters have no exact 1:1 offset back into the original cmdText; self-consistent
      // line/col counted from (1,1) at the start of the inner text is still real, typed, present data
      // (not fabricated placeholders) — precise cross-scope mapping is unresolved-but-not-fixture-tested.
      const innerLineStarts = [0];
      for (let ii = 0; ii < wrap.inner.length; ii++) if (wrap.inner[ii] === '\n') innerLineStarts.push(ii + 1);
      const innerPosToLineCol = (pos) => {
        let lo = 0, hi = innerLineStarts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (innerLineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
        return { line: lo + 1, col: pos - innerLineStarts[lo] + 1 };
      };

      const innerStateAssignments = new Map();
      const innerSegments = [];
      for (const rs of innerRaw.segs) {
        const rsStart = wrap.inner.indexOf(rs.text.replace(/^\s+/, ''));
        const finalized = finalizeOrdinarySegment({
          rawText: rs.text, dialect: innerDialect, sepBefore: rs.sepBefore, depth: 1,
          groupIdx: rs.group !== undefined ? rs.group : null,
          structReason: rs.structReason, unclosedOpener: rs.unclosedOpener,
          blockOpener: rs.blockOpener, isKeywordBlockMember: rs.isKeywordBlockMember,
          stateAssignments: innerStateAssignments, globalUnresolved,
          spanStart: rsStart >= 0 ? rsStart : 0, spanEnd: rsStart >= 0 ? rsStart + rs.text.length : rs.text.length,
          posToLineCol: innerPosToLineCol, heredocFirstLineText: rs.heredocFirstLineText,
        });
        for (const f of finalized) { f._innerScope = true; innerSegments.push(f); }
      }
      return finish([wrapperSeg, ...innerSegments]);
    }
    // v2.25 wrapper_commands: a shell-wrapper shape that CANNOT be recursively parsed (eval, alias,
    // any POSIX-shell short-flag combo carrying a command string, powershell/pwsh -c/-EncodedCommand,
    // xargs followed by any such wrapper) still must not fall through as an ordinary, unmarked
    // segment -- that is exactly the "fully blind" gap the contract calls out (zero rows looks like a
    // true negative). Mark the whole segment unsupported:wrapper instead of guessing at its contents.
    if (detectBlindWrapper(toks)) {
      return finish([Object.assign(unsupportedBlank(dialect, 'wrapper'), { sep_before: sepBefore, group: groupIdx })]);
    }
    // v1.2 修订⑩ (contract v2.26 launcher_commands): only consulted when neither the recursible dialect
    // wrapper nor the blind wrapper matched above -- a launcher handing off a carried command that
    // contains a pipe, an exit-status reference, or is itself an amendment-⑨ shell wrapper is just as
    // "fully blind" as the shapes above (zero rows looks like a true negative); mark the whole segment
    // unsupported:wrapper the same way, never recursing into the carried tokens. A launcher whose carried
    // command is ordinary (Wx19: `ssh host ls -la`) or that isn't a recognized launcher shape at all
    // falls through unmarked to ordinary command parsing below.
    if (detectLauncher(toks)) {
      return finish([Object.assign(unsupportedBlank(dialect, 'wrapper'), { sep_before: sepBefore, group: groupIdx })]);
    }
  }

  const exe = basenameLower(toks[0].value);
  const restToks = toks.slice(1);
  let sub = null, argToks;
  if (exe !== 'node' && SUBCOMMAND_EXES.has(exe)) {
    const found = findSub(exe, restToks);
    sub = found.sub;
    argToks = restToks.slice(found.afterIndex);
  } else {
    sub = null;
    argToks = restToks;
  }

  const args = argToks.map((t) => decodeOperand(t, stateAssignments));
  for (const a of args) for (const u of a.unresolved_variables) globalUnresolved.add(u);
  for (const r of redirects) for (const u of r.target.unresolved_variables) globalUnresolved.add(u);

  const assignments = prefixAssignments.map((t) => buildAssignmentFromToken(t, stateAssignments, globalUnresolved, 'command_prefix_assignment'));

  const statusRefs = [];
  assignments.forEach((a, idx) => {
    for (const hit of scanStatusRefsInRaw(a.raw_value)) {
      statusRefs.push({ kind: hit.kind, context: 'assignment-rhs', position: { kind: 'assignment', index: idx } });
    }
  });
  argToks.forEach((t, idx) => {
    for (const p of t.pieces) {
      if (p.quoted === 'single') continue;
      for (const kind of scanStatusRefsInPiece(p.text)) {
        statusRefs.push({ kind, context: statusRefContext(p.quoted, 'arg'), position: { kind: 'arg', index: idx } });
      }
    }
  });

  const shellOptionChanges = exe === 'set' ? parseShellOptionChanges(args) : [];

  return finish([{
    dialect, exe, sub, kind: 'command', parse_status: 'ok',
    sep_before: sepBefore, redirects, args, assignments, status_refs: statusRefs,
    shell_option_changes: shellOptionChanges,
    has_exit_status_ref: statusRefs.length > 0,
    group: groupIdx, negated,
  }]);
}

// ── pipeline_id / pipeline_position / pipeline_length: contiguous runs connected by real '|'/'|&'
// sep_before, skipping block-owned segments and wrapper segments entirely.
function assignPipelineFields(segments) {
  let idx = 0;
  while (idx < segments.length) {
    if (segments[idx].group !== null && segments[idx].group !== undefined) {
      segments[idx].pipeline_id = null; segments[idx].pipeline_position = null; segments[idx].pipeline_length = null;
      idx++; continue;
    }
    if (segments[idx]._wrapper) {
      segments[idx].pipeline_id = null; segments[idx].pipeline_position = null; segments[idx].pipeline_length = null;
      idx++; continue;
    }
    let end = idx;
    while (end + 1 < segments.length &&
      !(segments[end + 1].group !== null && segments[end + 1].group !== undefined) &&
      !segments[end + 1]._wrapper &&
      (segments[end + 1].sep_before === '|' || segments[end + 1].sep_before === '|&')) {
      end++;
    }
    const len = end - idx + 1;
    if (len > 1) {
      const pid = idx;
      let anyNegated = false;
      for (let k = idx; k <= end; k++) if (segments[k].negated) anyNegated = true;
      for (let k = idx; k <= end; k++) {
        segments[k].pipeline_id = pid;
        segments[k].pipeline_position = k - idx;
        segments[k].pipeline_length = len;
        if (anyNegated) segments[k].negated = true;
      }
    } else {
      segments[idx].pipeline_id = null;
      segments[idx].pipeline_position = null;
      segments[idx].pipeline_length = null;
    }
    idx = end + 1;
  }
}

// flat mutant (contract PMM-CMD-PARSE-CONTRACT.md v1.2 修订⑤ item 5): deep-clone the REAL parse
// output, then status_refs=[], redirects=[], assignments=[], shell_option_changes=[] on every
// segment, and per arg expansion_refs=[]/unresolved_variables=[]/decoded=raw — quote and every other
// field (scope_id, groups, scopes, negated, group, pipeline_*, parse_status, exe/sub/dialect/kind,
// sep_before, top-level unresolved_variables) untouched.
function applyFlatMutant(result) {
  const out = JSON.parse(JSON.stringify(result));
  for (const seg of out.segments || []) {
    seg.status_refs = [];
    seg.redirects = [];
    seg.assignments = [];
    seg.shell_option_changes = [];
    if (Array.isArray(seg.args)) {
      seg.args = seg.args.map((a) => (a && typeof a === 'object')
        ? Object.assign({}, a, { expansion_refs: [], unresolved_variables: [], decoded: a.raw })
        : a);
    }
  }
  return out;
}

// amendment 7 item 3: production parseCommand() must not read PMM_CMD_PARSE_MUTANT (contract
// single_handler: no environment variable may switch the judgment implementation). The flat
// transform is exported as the pure function applyFlatMutant(result) for the runner's G08 flat
// round to call directly on a real parse; parseCommand(cmd, {mutant:'flat'}) is kept ONLY as a
// convenience call form for the runner (ctx-based, never env-based) -- it is equivalent to calling
// applyFlatMutant(parseCommand(cmd, ctx)) and is not itself a second judgment implementation.
function parseCommand(cmdText, ctx) {
  const result = parseCommandReal(cmdText, ctx);
  if (ctx && ctx.mutant === 'flat') return applyFlatMutant(result);
  return result;
}

function parseCommandReal(cmdText, ctx) {
  void ctx;
  if (typeof cmdText !== 'string' || cmdText.trim() === '') {
    return { segments: [], parser_version: PARSER_VERSION, scopes: [], unresolved_variables: [] };
  }

  // amendment 8 item 3: oversize guard runs FIRST, before any quote-balance/segmenting work, so an
  // oversized input never reaches the heavier passes -- checkOversize is a single O(n) scan (one
  // Buffer.byteLength call for the whole input, plus one per whitespace-delimited run), no regex
  // backtracking, no tokenizing.
  if (checkOversize(cmdText)) {
    const seg = Object.assign(unsupportedBlank('posix', 'oversize'), { index: 0, scope_id: 'root', source_span: { line: 1, col: 1, end_line: 1, end_col: 1 }, pipeline_id: null, pipeline_position: null, pipeline_length: null });
    return {
      segments: [seg], parser_version: PARSER_VERSION,
      scopes: [{ scope_id: 'root', dialect: 'posix', parent_segment_index: null, initial_options: { pipefail: false, errexit: false } }],
      unresolved_variables: [],
    };
  }

  const bal = checkQuoteBalance(cmdText);
  if (!bal.balanced) {
    const balLineStarts = buildLineStarts(cmdText);
    const balPosToLineCol = makePosToLineCol(balLineStarts);
    const balSpan = {
      line: balPosToLineCol(0).line, col: balPosToLineCol(0).col,
      end_line: balPosToLineCol(cmdText.length).line, end_col: balPosToLineCol(cmdText.length).col,
    };
    const seg = Object.assign(unsupportedBlank('posix', 'unbalanced-quote'), { index: 0, scope_id: 'root', source_span: balSpan, pipeline_id: null, pipeline_position: null, pipeline_length: null });
    return {
      segments: [seg], parser_version: PARSER_VERSION,
      scopes: [{ scope_id: 'root', dialect: 'posix', parent_segment_index: null, initial_options: { pipefail: false, errexit: false } }],
      unresolved_variables: [],
    };
  }

  const contMap = stripLineContinuationsWithMap(cmdText);
  const text = contMap.text;
  const origLineStarts = buildLineStarts(cmdText);
  const origPosToLineCol = makePosToLineCol(origLineStarts);
  // maps a position in the continuation-collapsed `text` back to real {line,col} in cmdText
  const posToLineCol = (textPos) => origPosToLineCol(contMap.origIndex[Math.min(textPos, contMap.origIndex.length - 1)]);

  const firstWordM = /^\s*(\S+)/.exec(text);
  const firstWord = firstWordM ? firstWordM[1] : '';

  const globalUnresolved = new Set();
  const stateAssignments = new Map();
  let rawSegs, dialect;
  if (PS_VERB_NOUN_RE.test(firstWord)) {
    rawSegs = segmentSimple(text, [';', '|', 'newline']);
    dialect = 'powershell';
  } else {
    rawSegs = segmentPosixBlockAware(text).segs;
    dialect = 'posix';
  }

  const segments = [];
  for (const rs of rawSegs) {
    const finalized = finalizeOrdinarySegment({
      rawText: rs.text, dialect, sepBefore: rs.sepBefore, depth: 0,
      groupIdx: rs.group !== undefined ? rs.group : null,
      structReason: rs.structReason, unclosedOpener: rs.unclosedOpener,
      blockOpener: rs.blockOpener, isKeywordBlockMember: rs.isKeywordBlockMember,
      stateAssignments, globalUnresolved,
      spanStart: rs.spanStart, spanEnd: rs.spanEnd, posToLineCol,
      heredocFirstLineText: rs.heredocFirstLineText,
    });
    for (const f of finalized) segments.push(f);
  }
  segments.forEach((s, i) => { s.index = i; });

  const scopes = [{ scope_id: 'root', dialect, parent_segment_index: null, initial_options: { pipefail: false, errexit: false } }];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]._wrapper) {
      segments[i].scope_id = 'root';
      const innerScopeId = 'root/' + i;
      let j = i + 1;
      let innerDialectSeen = dialect;
      while (j < segments.length && segments[j]._innerScope) {
        segments[j].scope_id = innerScopeId;
        innerDialectSeen = segments[j].dialect;
        j++;
      }
      scopes.push({ scope_id: innerScopeId, dialect: innerDialectSeen, parent_segment_index: i, initial_options: segments[i]._initialOptions });
      i = j - 1;
    } else if (segments[i].scope_id === undefined) {
      segments[i].scope_id = 'root';
    }
  }

  assignPipelineFields(segments);

  for (const s of segments) {
    delete s._wrapper;
    delete s._initialOptions;
    delete s._innerScope;
  }

  return {
    parser_version: PARSER_VERSION,
    segments,
    scopes,
    unresolved_variables: [...globalUnresolved].sort(),
  };
}

module.exports = { parseCommand, PARSER_VERSION, applyFlatMutant };

// ============================================================================
// --self-test
// ============================================================================
if (require.main === module && process.argv[2] === '--self-test') {
  let PASS = 0, FAIL = 0;
  function report(name, ok, detail) {
    if (ok) { console.log('PASS: ' + name); PASS++; }
    else { console.log('FAIL: ' + name + ' -- ' + (detail || '')); FAIL++; }
  }
  function seg(cmd, i) { return parseCommand(cmd).segments[i]; }
  function assertField(name, cmd, i, field, want) {
    const s = seg(cmd, i);
    const got = s ? s[field] : undefined;
    const ok = JSON.stringify(got) === JSON.stringify(want);
    report(name, ok, 'segment[' + i + '].' + field + '=' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }
  function assertExists(name, cmd, pred) {
    const segs = parseCommand(cmd).segments;
    report(name, segs.some(pred), 'segs=' + JSON.stringify(segs));
  }

  console.log('=== v1.1 regression basics ===');
  assertField('git -C /c/repo status -> sub=status', 'git -C /c/repo status', 0, 'sub', 'status');
  assertField('sudo -u root git status -> exe=git', 'sudo -u root git status', 0, 'exe', 'git');
  report('parser_version field', parseCommand('true').parser_version === '1.2', parseCommand('true').parser_version);

  console.log('=== revision 1: continuation / per-operand metadata ===');
  {
    const segs = parseCommand('a | \\\nb; rc=$?').segments;
    report('backslash-newline collapses to 3 segments', segs.length === 3, JSON.stringify(segs.map((s) => s.parse_status)));
  }
  assertField('R-assign-prefix-1 FOO=1 echo $FOO -> arg unresolved', 'FOO=1 echo $FOO', 0, 'args',
    [{ raw: '$FOO', decoded: '$FOO', quote: 'none', expansion_refs: [{ name: 'FOO', kind: 'plain' }], unresolved_variables: ['FOO'] }]);

  console.log('=== revision 2: !, comments, quoted redirects, array/[[ ===');
  assertExists('! negation sets negated=true, parse_status ok', '! grep -q x f', (s) => s.negated === true && s.parse_status === 'ok');
  assertField("C-Z16 quoted > is not a redirect", "echo '>' x", 0, 'redirects', []);
  assertField('R-array-assign', 'a=(1 2 3)', 0, 'parse_status', 'unsupported:array-assignment');
  assertField('N-double-bracket [[ -f x ]]', '[[ -f x ]]', 0, 'parse_status', 'unsupported:keyword:[[');

  console.log('=== revision 4/5/6: block algorithm, redirect target objects, time ===');
  {
    const segs = parseCommand('if grep -qE "^plus +OK" $S/q.txt; then echo yes; fi').segments;
    report('M08 4 segments all unsupported:keyword:if', segs.length === 4 && segs.every((s) => s.parse_status === 'unsupported:keyword:if'),
      JSON.stringify(segs.map((s) => [s.sep_before, s.parse_status])));
    report('M08 sep_before sequence', JSON.stringify(segs.map((s) => s.sep_before)) === JSON.stringify(['start', 'keyword', 'keyword', ';']),
      JSON.stringify(segs.map((s) => s.sep_before)));
  }
  assertField('M16 time keyword', 'time git status', 0, 'parse_status', 'unsupported:keyword:time');
  {
    const segs = parseCommand('cmd 2>&1 | tail -5').segments;
    report('C-B08 dup redirect target object', JSON.stringify(segs[0].redirects[0]) === JSON.stringify({
      op: '>&', fd: 2, raw_target: '&1', target: { raw: '1', decoded: '1', quote: 'none', expansion_refs: [], unresolved_variables: [] }, target_kind: 'fd', order: 0,
    }), JSON.stringify(segs[0].redirects));
  }

  console.log('=== codex review 2026-09-17T085234Z finding #5: source_span + assignment args ===');
  {
    const segs = parseCommand('git status\necho hi').segments;
    report('multi-line command: seg0 source_span on line 1', JSON.stringify(segs[0].source_span) === JSON.stringify({ line: 1, col: 1, end_line: 1, end_col: 11 }), JSON.stringify(segs[0].source_span));
    report('multi-line command: seg1 source_span on line 2 (real line number, not line 1)', JSON.stringify(segs[1].source_span) === JSON.stringify({ line: 2, col: 1, end_line: 2, end_col: 8 }), JSON.stringify(segs[1].source_span));
  }
  assertField('pure state_assignment segment (rc=$?) -> args=[] (moved into assignments[], contract :25/:34)', 'rc=$?', 0, 'args', []);
  {
    const s = seg('FOO=1 echo hello world', 0);
    report('command_prefix_assignment (FOO=1 echo hello world) -> FOO=1 not in args, only echo\'s own operands',
      JSON.stringify(s.args.map((a) => a.raw)) === JSON.stringify(['hello', 'world']) &&
      s.assignments.length === 1 && s.assignments[0].name === 'FOO' && s.assignments[0].kind === 'command_prefix_assignment',
      JSON.stringify({ args: s.args, assignments: s.assignments }));
  }

  console.log('=== v1.2 修订 ⑦ (fab blind attack HIGH-1/MEDIUM-1/MEDIUM-4): heredoc first line, function-def, flat as exported fn ===');
  {
    const s = seg("cat > ABS/h.txt <<'EOF'\nhello\nEOF", 0);
    report('C-H01 heredoc keeps first-line exe/redirects (not fully blanked)',
      s.exe === 'cat' && s.parse_status === 'unsupported:heredoc' && s.redirects.length === 1 && s.redirects[0].op === '>' && s.redirects[0].target.decoded === 'ABS/h.txt' && JSON.stringify(s.args) === '[]',
      JSON.stringify(s));
  }
  {
    const s = seg("cat > $S/msg.txt <<'EOF'", 0);
    report('M06 (no terminator found, no body room) keeps OLD fully-blanked heredoc shape',
      s.exe === null && s.sub === null && s.kind === null && s.sep_before === '' && s.parse_status === 'unsupported:heredoc',
      JSON.stringify(s));
  }
  {
    const segs = parseCommand('f() { set -o pipefail; a | b; rc=$?; }; f').segments;
    report('C-F01 function-def is one opaque segment, call after ; is ordinary',
      segs.length === 2 && segs[0].parse_status === 'unsupported:function-def' && segs[0].exe === null &&
      segs[0].sep_before === 'start' && segs[1].exe === 'f' && segs[1].parse_status === 'ok' && segs[1].sep_before === ';',
      JSON.stringify(segs));
  }
  {
    const before = process.env.PMM_CMD_PARSE_MUTANT;
    process.env.PMM_CMD_PARSE_MUTANT = 'flat';
    const s = seg('a | b; echo "$?"', 2);
    if (before === undefined) delete process.env.PMM_CMD_PARSE_MUTANT; else process.env.PMM_CMD_PARSE_MUTANT = before;
    report('production parseCommand() ignores PMM_CMD_PARSE_MUTANT env var (amendment 7 item 3)',
      s.status_refs.length === 1 && s.status_refs[0].kind === '$?', JSON.stringify(s));
  }
  {
    const real = parseCommand('a | b; echo "$?"');
    const flat = applyFlatMutant(real);
    report('applyFlatMutant(result) is the exported pure transform (status_refs cleared, quote untouched)',
      flat.segments[2].status_refs.length === 0 && flat.segments[2].args[0].quote === real.segments[2].args[0].quote,
      JSON.stringify(flat.segments[2]));
  }

  console.log('=== v1.2 修订 ⑧ (fab blind attack LOW-5/LOW-7/LOW-8/LOW-12, post-go-live batch 1) ===');
  {
    const segs = parseCommand('a; ; b').segments;
    report('C-E02 consecutive ";" drops the empty segment, densely reindexed, real separator kept',
      segs.length === 2 && segs[0].exe === 'a' && segs[1].exe === 'b' && segs[1].sep_before === ';' && segs[1].index === 1,
      JSON.stringify(segs));
  }
  {
    const s = seg('tail -5 ABS/with\\ space.txt', 0);
    report('C-BS01 backslash-escaped space stays one token, raw keeps "\\\\", decoded has a real space',
      s.args.length === 2 && s.args[1].raw === 'ABS/with\\ space.txt' && s.args[1].decoded === 'ABS/with space.txt' && s.args[1].quote === 'none',
      JSON.stringify(s.args));
  }
  {
    const s = seg('a | b; echo \\$?', 2);
    report('C-BS02 escaped "\\$?" decodes to literal $? and is NOT a status ref',
      s.args[0].decoded === '$?' && s.status_refs.length === 0 && s.has_exit_status_ref === false,
      JSON.stringify(s));
  }
  {
    const t0 = process.hrtime.bigint();
    const s = seg('echo ' + 'x'.repeat(65537), 0);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    report('C-OS01-style oversize token (>64KiB) -> unsupported:oversize in well under 100ms',
      s.parse_status === 'unsupported:oversize' && s.exe === null && ms < 100,
      'parse_status=' + s.parse_status + ' elapsed_ms=' + ms.toFixed(3));
  }

  console.log('=== Summary: ' + PASS + ' passed, ' + FAIL + ' failed ===');
  process.exit(FAIL > 0 ? 1 : 0);
}
