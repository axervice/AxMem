#!/usr/bin/env node
// pmm-migrate-v3.cjs — PMM v3 migrator (C0 build, SHADOW ONLY).
// --plan                 read-only; computes actions ①–⑬ off HEAD:.claude/memory via buildFullPlan()
//                         (computePlan + buildEditOps + before/after content fingerprints — the ONLY
//                         place matching/bestMatch ever runs), writes a self-contained
//                         guards/specs/PLAN-<key>.json (key=corpusFingerprint 前40hex; edits[],
//                         contentFingerprint(After)), prints a summary. Exits non-zero if any D1
//                         match was AMBIGUOUS (refused). D1-PINNED/PLAN 文件名与新鲜度判断自
//                         2026-09-24(spec 补遗三 §32)起用「语料内容指纹」(sha256 of core.ALL_FILES
//                         内容,见 computeCorpusFingerprint()),不再用 treeOid —— treeOid 仍记入两份
//                         文件供人工参考，但从命名/比对中退场（receipts 落盘会挪动 treeOid 却不碰
//                         core.ALL_FILES 字节，旧方案因此会把已审的 pin/plan 误判成漂移）。
// --apply --dir <copy> --plan <PLAN-<oid>.json>
//                         CONSUMES a plan only — never re-matches/re-derives (Opus B-1/B-3). Checks
//                         --dir's content fingerprint against the plan's before/after fingerprints
//                         (idempotent re-run vs fresh apply vs wrong/drifted dir) and every edit's
//                         exact pre-edit bytes, then applies plan.edits verbatim. ONLY ever writes
//                         inside --dir (refuses any path that resolves under the real
//                         ~/.claude/memory — canonical-home guard).
// --verify --stage c0|c1 --before <dir> --after <dir> [--plan <file>]
//                         assertions A1–A22 (c0 = A1–A18+A20; c1 additionally needs A19/A21/A22,
//                         reported NOT-RUN in C0 since their infra — C0.5 shadow hooks / dual-machine
//                         / emit — does not exist yet). A10 and A20 are real checks, not stubs.
// Authoritative spec: guards/specs/PMM-V3-FINAL-SPEC.md §5. Never touches real memory content.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./pmm-core.cjs');

const GUARDS_DIR = path.resolve(__dirname).replace(/\\/g, '/');
const SPECS_DIR = GUARDS_DIR + '/specs';

// ── safety: refuse any write path that resolves under the real canonical memory dir (B30-style) ──
function realpathNative(p) {
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); }
  catch { return path.resolve(p); }
}
function refuseIfCanonicalMemory(dir) {
  const canonical = (process.env.PMM_CANONICAL_MEMORY || (core.homeDir() + '/.claude/memory')).replace(/\\/g, '/').toLowerCase();
  const real = realpathNative(dir).replace(/\\/g, '/').toLowerCase();
  if (real === canonical || real.startsWith(canonical + '/')) {
    console.error(`✖ 拒绝:--dir 解析到真实 canonical memory 目录(${real}) —— --apply 只许在副本上运行`);
    process.exit(2);
  }
}

// ── D1-NAMING.md parser (match by title text, never by stale line numbers — D1's own header) ─────
function fileKeyToFileName(key) {
  const k = key.trim().toLowerCase();
  if (k.startsWith('dec')) return 'decisions.md';
  if (k.startsWith('les')) return 'lessons.md';
  if (k.startsWith('std') || k.startsWith('standing')) return 'standinginstructions.md';
  if (k.startsWith('class')) return 'classes.md';
  return null;
}
function parseD1Naming(text) {
  const lines = text.split(/\r?\n/);
  const sections = { list24: [], sameFileDup: [], crossFileDup: [], userNoColonNote: null, restActions: [] };
  let cur = null;
  for (const line of lines) {
    if (/^## 24 条无身份/.test(line)) { cur = 'list24'; continue; }
    if (/^## \d+ 条 `\[user\]`/.test(line)) { cur = 'userNote'; continue; }
    if (/^## \d+ 对同文件重复身份/.test(line)) { cur = 'sameFileDup'; continue; }
    if (/^## \d+ 对跨文件双写/.test(line)) { cur = 'crossFileDup'; continue; }
    if (/^## 其余迁移动作/.test(line)) { cur = 'rest'; continue; }
    if (/^#/.test(line)) { cur = null; continue; }
    if (!/^\|/.test(line)) continue;
    if (/^\|\s*-+\s*\|/.test(line)) continue; // separator row
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cur === 'list24' && cells.length === 3) {
      if (/^文件/.test(cells[0])) continue; // header row
      const [fk, lineHint] = cells[0].split(':');
      const file = fileKeyToFileName(fk);
      const idM = /\[([a-z][a-z0-9-]*:[a-z0-9._-]+)\]/.exec(cells[2]);
      if (file && idM) sections.list24.push({ file, lineHint: lineHint || null, gist: cells[1], newId: idM[1], raw: cells });
    } else if (cur === 'sameFileDup' && cells.length === 3) {
      if (/^文件/.test(cells[0])) continue;
      const file = fileKeyToFileName(cells[0]);
      if (!file) continue;
      const keepGistM = /[「『]([^」』]+)[」』]/.exec(cells[1]);
      const keepIdM = /\[([a-z][a-z0-9-]*:[a-z0-9._-]+)\]/.exec(cells[1]);
      const renameGistM = /[「『]([^」』]+)[」』]/.exec(cells[2]);
      const newIdM = /\[([a-z][a-z0-9-]*:[a-z0-9._-]+)\]/.exec(cells[2]);
      if (keepGistM && renameGistM && newIdM) {
        sections.sameFileDup.push({
          file, keepGist: keepGistM[1], keepId: keepIdM ? keepIdM[1] : null,
          renameGist: renameGistM[1], newId: newIdM[1], raw: cells,
        });
      }
    } else if (cur === 'crossFileDup' && cells.length === 3) {
      if (/^tag/.test(cells[0])) continue;
      const tagM = /\[{1,2}([a-z][a-z0-9-]*:[a-z0-9._-]+)\]{1,2}/.exec(cells[0]);
      const newIdM = /\[([a-z][a-z0-9-]*:[a-z0-9._-]+-decided)\]/.exec(cells[2]);
      if (tagM && newIdM) sections.crossFileDup.push({ tag: tagM[1], newId: newIdM[1], raw: cells });
    } else if (cur === 'rest') {
      sections.restActions.push(cells);
    }
  }
  return sections;
}

// ── fuzzy title matching: D1 gist text vs actual parsed title (Chinese-aware token overlap) ──────
function normTokens(s) {
  if (!s) return [];
  // strip backtick/code spans and bracketed tags first
  const cleaned = s.replace(/`[^`]*`/g, ' ').replace(/\[\[?[^\]]*\]\]?/g, ' ');
  const asciiWords = (cleaned.match(/[A-Za-z0-9][A-Za-z0-9._-]{2,}/g) || []).map(w => w.toLowerCase());
  const cjk = cleaned.replace(/[^一-鿿]/g, '');
  const bigrams = [];
  for (let i = 0; i < cjk.length - 1; i++) bigrams.push(cjk.slice(i, i + 2));
  return [...asciiWords, ...bigrams];
}
function matchScore(gist, title) {
  const gt = new Set(normTokens(gist));
  const tt = new Set(normTokens(title));
  if (gt.size === 0) return 0;
  let hit = 0;
  for (const g of gt) if (tt.has(g)) hit++;
  return hit / gt.size;
}
// Opus B-2 fix: collect ALL scored candidates (not just track a running max via strict `>`, which
// silently keeps whichever candidate was encountered FIRST on a tie — the exact swap bug the review
// reproduced: a short gist scores 1.0 against both a long title (its superset) and its own exact
// title, and document order alone decided the winner). Ties or near-ties are now refused outright.
function scoreCandidates(gist, candidates, taken) {
  const scored = [];
  for (const c of candidates) {
    if (taken && taken.has(c)) continue;
    const s = matchScore(gist, c.title);
    if (s > 0) scored.push({ entry: c, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
function bestMatch(gist, candidates, taken) {
  const scored = scoreCandidates(gist, candidates, taken);
  if (!scored.length || scored[0].score < 0.34) {
    return { entry: null, score: scored.length ? scored[0].score : 0, ambiguous: false, candidates: scored };
  }
  const best = scored[0], second = scored[1];
  // FINAL-SPEC §5: "bestScore 并列或 second/best > 0.9 ⇒ 判 AMBIGUOUS" — refuse and list candidates
  // instead of silently taking the first-encountered top scorer.
  const ambiguous = !!second && (second.score === best.score || (second.score / best.score) > 0.9);
  if (ambiguous) return { entry: null, score: best.score, ambiguous: true, candidates: scored.slice(0, 5) };
  return { entry: best.entry, score: best.score, ambiguous: false, candidates: scored.slice(0, 5) };
}

// ── legacy hand-written `## Index` bullet parser (informational only; not part of the v3 grammar —
//    used purely to compute migration actions ⑤⑦⑨⑩) ────────────────────────────────────────────
const BULLET_RE = /^-\s*(20\d\d-\d\d-\d\d)(\([^)]*\))?\s*\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\s*(.*)$/;
function parseLegacyIndexBullets(rawText) {
  const lines = rawText.split(/\r?\n/);
  const out = [];
  let inFence = false, inIdx = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasFence = inFence;
    if (core.FENCE_RE.test(line)) inFence = !inFence;
    if (wasFence) continue;
    if (core.INDEX_HEADING_RE.test(line)) { inIdx = true; continue; }
    if (inIdx && (core.H2_RE.test(line) || core.H3_RE.test(line))) { inIdx = false; continue; }
    if (!inIdx) continue;
    const m = BULLET_RE.exec(line);
    if (!m) continue;
    const [, dateISO, dateRaw, tag, rest] = m;
    let restText = rest, marker = null;
    const markerM = /\(superseded→(.*)\)\s*$/.exec(rest);
    if (markerM) {
      restText = rest.slice(0, markerM.index).trim();
      const inner = markerM[1];
      const stdM = /^\[([A-Za-z0-9:._-]+)\]$/.exec(inner.trim());
      if (stdM) {
        let to = stdM[1];
        if (!to.includes(':')) to = tag.split(':')[0] + ':' + to;
        marker = { to, nonstandard: false, raw: inner };
      } else {
        marker = { to: null, nonstandard: true, raw: inner };
      }
    }
    out.push({ lineNo: i + 1, dateISO, dateRaw: dateRaw || '', tag, restText: restText.trim(), marker, raw: line });
  }
  return out;
}

// ── byte helpers for edit-op construction ─────────────────────────────────────────────────────────
function lineEndByte(rawBuf, startByte) {
  const nl = rawBuf.indexOf(0x0a, startByte);
  return nl === -1 ? rawBuf.length : nl + 1;
}
function utf8len(s) { return Buffer.byteLength(s, 'utf8'); }
function findLineStartByTitleLineNo(buf, titleLineNo) {
  let line = 1;
  if (titleLineNo === 1) return 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) { line++; if (line === titleLineNo) return i + 1; }
  }
  return null;
}
// Opus B-1: sha256 of a title line's raw pre-edit bytes — pinned into the plan so --apply can verify
// (without re-matching) that the line it is about to touch is still exactly what --plan saw.
function titleLineSha(buf, titleLineNo) {
  if (!buf) return null;
  const ls = findLineStartByTitleLineNo(buf, titleLineNo);
  if (ls == null) return null;
  const le = lineEndByte(buf, ls);
  return core.sha256hex(buf.slice(ls, le));
}

// ── computePlan(): the single source of truth used by both --plan and --apply ────────────────────
// snap: core.snapshot()-shaped object (files: {name: {raw, hadBOM}}).
// Returns { treeOid, groups: {...counts}, actions: [ {id, kind, file, tag, titleGist, byteOp:{offset,deleteLen,insertText}, note, matched} ], unmatchedD1: [...] }
// Coordinator follow-up (2026-09-15, "pin the D1 mapping"): locate the entry currently sitting at a
// pinned (file, titleLineNo) and verify its title line's sha256 still matches what was pinned. This
// is the ONLY thing pinned-mode ①③④⑬ do at --plan time — never bestMatch/matchScore.
function locatePinnedEntry(parsed, snap, file, titleLineNo, pinnedTitleLineSha256) {
  const fe = parsed.perFile[file];
  const entry = fe && fe.entries ? fe.entries.find(e => e.titleLineNo === titleLineNo) : null;
  if (!entry) return { ok: false, reason: `pin 指向的位置已不存在条目:${file}:${titleLineNo}(需重新 --pin-d1)` };
  const buf = snap.files[file] && snap.files[file].raw;
  const curSha = buf ? titleLineSha(buf, titleLineNo) : null;
  if (curSha !== pinnedTitleLineSha256) {
    return { ok: false, reason: `STALE PIN:${file}:${titleLineNo} 标题行 sha256 已变(pin=${pinnedTitleLineSha256} 现=${curSha || '(不可读)'}) —— 需重新 --pin-d1 并重审,绝不重新匹配` };
  }
  return { ok: true, entry };
}

function computePlan(snap, d1, opts) {
  opts = opts || {};
  const parsed = core.parseAll(snap);
  core.attachLegacyIndex(parsed, snap);
  const graph = core.buildGraph(parsed.entries);
  const actions = [];
  const unmatched = [];
  let ambiguousCount = 0;
  let staleCount = 0;
  const pin = opts.pin || null; // parsed D1-PINNED-<oid>.json, or null = fuzzy-match mode (--pin-d1 only)

  // -- ① identity-less live titles (no valid TAG identity: rawIdentity null OR ns ∈ ATTR) --------
  const idlessByFile = {};
  for (const f of core.LIVE_FILES) idlessByFile[f] = (parsed.perFile[f] ? parsed.perFile[f].entries : []).filter(e => !e.id);
  const taken = new Set();
  if (pin) {
    // Pinned mode: consume guards/specs/D1-PINNED-<oid>.json verbatim. No bestMatch call anywhere in
    // this branch — matching happened once, at --pin-d1 time, and is reviewable in that JSON file.
    for (const pe of pin.entries.filter(e => e.kind === '①insert-identity')) {
      if (pe.ambiguous) { ambiguousCount++; unmatched.push({ group: '①', file: pe.file, gist: pe.d1Row && pe.d1Row.gist, newId: pe.newTag, reason: `AMBIGUOUS(记录于 pin 文件,需人工裁定并重新 --pin-d1):${pe.note || ''}` }); continue; }
      const loc = locatePinnedEntry(parsed, snap, pe.file, pe.titleLineNo, pe.titleLineSha256);
      if (!loc.ok) { staleCount++; unmatched.push({ group: '①', file: pe.file, gist: pe.d1Row && pe.d1Row.gist, newId: pe.newTag, reason: loc.reason }); continue; }
      actions.push({
        kind: '①insert-identity', file: pe.file, matchedTitle: loc.entry.title, gist: pe.d1Row && pe.d1Row.gist,
        titleLineNo: loc.entry.titleLineNo, byteOffset: loc.entry.byteRange[0], newId: pe.newTag,
        titleLineSha256: pe.titleLineSha256, blockHash64: loc.entry.blockHash64,
        insertAfterTitleClose: true, score: pe.score, pinned: true,
      });
    }
  } else {
    for (const row of d1.list24) {
      const cands = idlessByFile[row.file] || [];
      const { entry, score, ambiguous, candidates } = bestMatch(row.gist, cands, taken);
      if (entry) {
        taken.add(entry);
        actions.push({
          kind: '①insert-identity', file: row.file, matchedTitle: entry.title, gist: row.gist,
          titleLineNo: entry.titleLineNo, byteOffset: entry.byteRange[0], newId: row.newId,
          titleLineSha256: titleLineSha(snap.files[row.file].raw, entry.titleLineNo),
          blockHash64: entry.blockHash64,
          insertAfterTitleClose: true, score,
        });
      } else if (ambiguous) {
        ambiguousCount++;
        unmatched.push({
          group: '①', file: row.file, gist: row.gist, newId: row.newId,
          reason: `AMBIGUOUS(并列/近并列,拒绝取先遇者):best=${candidates[0].score.toFixed(3)} second=${candidates[1] ? candidates[1].score.toFixed(3) : '-'} 候选=${candidates.slice(0, 3).map(c => JSON.stringify(c.entry.title)).join(' | ')}`,
          candidates: candidates.slice(0, 5).map(c => ({ file: row.file, title: c.entry.title, titleLineNo: c.entry.titleLineNo, score: c.score })),
        });
      } else {
        unmatched.push({ group: '①', file: row.file, gist: row.gist, newId: row.newId, reason: `未在当前 ${row.file} 的无身份条目里找到匹配标题(score=${score.toFixed(2)})` });
      }
    }
  }
  const list24Matched = actions.filter(a => a.kind === '①insert-identity').length;

  // -- ② bare `[user]` (no colon) anywhere in an entry's tail ---------------------------------------
  const bareUserAction = [];
  for (const e of parsed.entries) {
    if (e.archived) continue;
    if (/\[user\](?!:)/.test(e.tail)) {
      bareUserAction.push({ kind: '②user-no-colon', file: e.file, titleLineNo: e.titleLineNo, id: e.id, title: e.title });
    }
  }
  actions.push(...bareUserAction);

  // -- ③ same-file duplicate identities ---------------------------------------------------------
  const byFileId = new Map(); // file|id -> [entries]
  for (const e of parsed.entries) {
    if (e.archived || !e.id) continue;
    const key = e.file + '::' + e.id.toLowerCase();
    if (!byFileId.has(key)) byFileId.set(key, []);
    byFileId.get(key).push(e);
  }
  const sameFileDupActions = [];
  if (pin) {
    for (const pe of pin.entries.filter(e => e.kind === '③rename-same-file-dup')) {
      if (pe.ambiguous) { ambiguousCount++; sameFileDupActions.push({ kind: '③rename-same-file-dup', file: pe.file, id: pe.d1Row && pe.d1Row.oldId, matched: false, note: `AMBIGUOUS(记录于 pin 文件,需人工裁定并重新 --pin-d1):${pe.note || ''}` }); continue; }
      const loc = locatePinnedEntry(parsed, snap, pe.file, pe.titleLineNo, pe.titleLineSha256);
      if (!loc.ok) { staleCount++; sameFileDupActions.push({ kind: '③rename-same-file-dup', file: pe.file, matched: false, note: loc.reason }); continue; }
      sameFileDupActions.push({
        kind: '③rename-same-file-dup', file: pe.file, keepTitleLineNo: pe.keepTitleLineNo, renameTitleLineNo: loc.entry.titleLineNo,
        oldId: loc.entry.id, newId: pe.newTag, matched: true,
        titleLineSha256: pe.titleLineSha256, blockHash64: loc.entry.blockHash64, pinned: true,
      });
    }
  } else {
    for (const [key, arr] of byFileId) {
      if (arr.length < 2) continue;
      const [file] = key.split('::');
      const d1row = d1.sameFileDup.find(r => r.file === file && arr.some(e => matchScore(r.keepGist, e.title) >= 0.34) && arr.some(e => matchScore(r.renameGist, e.title) >= 0.34));
      if (d1row) {
        // Opus B-2: pick "keep" via the same ambiguity-aware bestMatch used for ①, then "rename" among
        // what's left — a plain first-above-threshold .find() (or a running-max `>`) can silently collide
        // when the two gists share a lot of vocabulary and the wrong (still above-threshold) entry gets
        // picked for a role. Any tie/near-tie in EITHER pick refuses the whole action (AMBIGUOUS).
        const keepPick = bestMatch(d1row.keepGist, arr, new Set());
        const renamePick = (keepPick.entry && !keepPick.ambiguous) ? bestMatch(d1row.renameGist, arr, new Set([keepPick.entry])) : null;
        const ok = keepPick.entry && !keepPick.ambiguous && renamePick && renamePick.entry && !renamePick.ambiguous;
        if (ok) {
          const renameE = renamePick.entry;
          sameFileDupActions.push({
            kind: '③rename-same-file-dup', file, keepTitleLineNo: keepPick.entry.titleLineNo, renameTitleLineNo: renameE.titleLineNo,
            oldId: renameE.id, newId: d1row.newId, matched: true,
            titleLineSha256: titleLineSha(snap.files[file].raw, renameE.titleLineNo), blockHash64: renameE.blockHash64,
          });
        } else {
          const isAmbiguous = keepPick.ambiguous || (renamePick && renamePick.ambiguous);
          if (isAmbiguous) ambiguousCount++;
          sameFileDupActions.push({
            kind: '③rename-same-file-dup', file, id: arr[0].id, occurrences: arr.map(e => e.titleLineNo), matched: false,
            note: isAmbiguous ? 'AMBIGUOUS: keep/rename 候选并列/近并列,拒绝取先遇者,需人工裁定' : '未在 D1-NAMING 找到对应行,需人工裁定保留哪条',
          });
        }
      } else {
        sameFileDupActions.push({ kind: '③rename-same-file-dup', file, id: arr[0].id, occurrences: arr.map(e => e.titleLineNo), matched: false, note: '未在 D1-NAMING 找到对应行,需人工裁定保留哪条' });
      }
    }
  }
  actions.push(...sameFileDupActions);

  // -- ④ cross-file duplicates: same id in exactly {decisions.md, standinginstructions.md} --------
  const byIdAcrossFiles = new Map();
  for (const e of parsed.entries) {
    if (e.archived || !e.id) continue;
    const key = e.id.toLowerCase();
    if (!byIdAcrossFiles.has(key)) byIdAcrossFiles.set(key, []);
    byIdAcrossFiles.get(key).push(e);
  }
  const crossFileDupActions = [];
  const pin4ByTag = pin ? new Map(pin.entries.filter(e => e.kind === '④cross-file-decided').map(e => [((e.d1Row && e.d1Row.tag) || '').toLowerCase(), e])) : null;
  for (const [key, arr] of byIdAcrossFiles) {
    const files = new Set(arr.map(e => e.file));
    if (files.size < 2) continue;
    if (files.has('decisions.md') && files.has('standinginstructions.md') && arr.length === files.size) {
      const decE = arr.find(e => e.file === 'decisions.md');
      const stdE = arr.find(e => e.file === 'standinginstructions.md');
      if (pin) {
        const pe = pin4ByTag.get(key);
        if (!pe) { staleCount++; crossFileDupActions.push({ kind: '④cross-file-decided', file: 'decisions.md', tag: decE.id, matched: false, note: `pin 文件无此跨文件重复的记录(需重新 --pin-d1):[${decE.id}]` }); continue; }
        if (pe.ambiguous) { ambiguousCount++; crossFileDupActions.push({ kind: '④cross-file-decided', file: 'decisions.md', tag: decE.id, matched: false, note: `AMBIGUOUS(记录于 pin 文件):${pe.note || ''}` }); continue; }
        const loc = locatePinnedEntry(parsed, snap, 'decisions.md', pe.titleLineNo, pe.titleLineSha256);
        if (!loc.ok) { staleCount++; crossFileDupActions.push({ kind: '④cross-file-decided', file: 'decisions.md', tag: decE.id, matched: false, note: loc.reason }); continue; }
        crossFileDupActions.push({
          kind: '④cross-file-decided', file: 'decisions.md', tag: decE.id, decisionsTitleLineNo: loc.entry.titleLineNo, standingTitleLineNo: stdE.titleLineNo, newId: pe.newTag, matched: true,
          titleLineSha256: pe.titleLineSha256, blockHash64: loc.entry.blockHash64, pinned: true,
        });
      } else {
        const d1row = d1.crossFileDup.find(r => r.tag.toLowerCase() === key);
        const newId = d1row ? d1row.newId : (decE.id + '-decided');
        crossFileDupActions.push({
          kind: '④cross-file-decided', file: 'decisions.md', tag: decE.id, decisionsTitleLineNo: decE.titleLineNo, standingTitleLineNo: stdE.titleLineNo, newId, matched: !!d1row,
          titleLineSha256: titleLineSha(snap.files['decisions.md'].raw, decE.titleLineNo), blockHash64: decE.blockHash64,
        });
      }
    }
  }
  actions.push(...crossFileDupActions);

  // -- ⑤⑦⑧⑨⑩: from legacy hand-written Index bullets, per live file --------------------------
  // Same-file duplicate tags (③) are ambiguous by id alone. Rather than excluding the about-to-be-
  // renamed occurrence (which would silently drop its Hook-move opportunity for a whole extra pass),
  // resolve each bullet against a per-tag QUEUE of entries consumed in file order — bullets mirror
  // Entries order in every real file, so bullet #1 for a duplicate tag pairs with entry-occurrence #1,
  // bullet #2 with occurrence #2, etc. This keeps the whole thing single-pass-convergent (needed for
  // A10 idempotency in one shot) without an ambiguous last-wins Map.
  const hookMoveActions = [], markerOnlyActions = [], nonstandardMarkerActions = [], lateActions = [], oversizedIndexRows = [];
  for (const f of ['decisions.md', 'lessons.md', 'standinginstructions.md']) {
    const info = snap.files[f];
    if (!info || info.missing) continue;
    const text = info.raw.toString('utf8');
    const bullets = parseLegacyIndexBullets(text);
    const entriesByIdQueue = new Map();
    for (const e of (parsed.perFile[f] ? parsed.perFile[f].entries : [])) {
      if (!e.id) continue;
      const k = e.id.toLowerCase();
      if (!entriesByIdQueue.has(k)) entriesByIdQueue.set(k, []);
      entriesByIdQueue.get(k).push(e);
    }
    const entriesById = { get(k) { const q = entriesByIdQueue.get(k); return q && q.length ? q.shift() : undefined; } };
    for (const b of bullets) {
      const rowBytes = utf8len(b.raw);
      if (rowBytes > 320) oversizedIndexRows.push({ file: f, lineNo: b.lineNo, bytes: rowBytes, raw: b.raw.slice(0, 200) });
      const target = entriesById.get(b.tag.toLowerCase());
      if (!target) continue; // dangling index bullet (pre-existing data issue; not a C1 action per se)
      // ⑤ Hook migration: REST != title and target has no Hook yet; oversized (>320B) REST is left
      // for the ⑩ manual-distillation list instead — auto-copying it would just relocate a B14
      // violation from "no Hook field yet" to "Hook >320B" (real bug caught by A17 in C0 testing).
      const restNorm = b.restText.trim();
      if (restNorm && restNorm !== target.title && !target.hook) {
        const restBytes = utf8len(restNorm);
        if (restBytes <= 320) {
          hookMoveActions.push({ kind: '⑤hook-from-index-rest', file: f, tag: target.id, titleLineNo: target.titleLineNo, hookText: restNorm, bytes: restBytes });
        }
      }
      // ⑨ (晚)/dateRaw suffix carried in the Index bullet but not on the title line itself
      if (b.dateRaw && !target.dateRaw) {
        lateActions.push({ kind: '⑨daterAW-to-hook', file: f, tag: target.id, titleLineNo: target.titleLineNo, dateRaw: b.dateRaw });
      }
      // ⑦/⑧ marker handling
      if (b.marker) {
        const hasFormalSupersedes = target.supersedes.length > 0; // this is the OLD entry being marked; formal edge would live on the NEW entry pointing back via Supersedes
        // does ANY live entry already formally supersede `target.id`?
        const formallySuperseded = graph.supNext.has(target.id) && graph.supNext.get(target.id).size > 0;
        if (b.marker.nonstandard) {
          const isClarify = /澄清|部分取代|部分/.test(b.marker.raw);
          nonstandardMarkerActions.push({ kind: isClarify ? '⑧prose-link-not-edge' : '⑧nonstandard-marker', file: f, tag: target.id, titleLineNo: target.titleLineNo, raw: b.marker.raw, isClarify });
        } else if (!formallySuperseded && b.marker.to) {
          // the edit actually lands on the TARGET entry (the one named by the marker), which may live
          // in a different file than the source `target` (the Index-bullet owner) — resolve it so the
          // action carries the real (file, titleLineNo) the byte-op will touch (needed by --verify's
          // per-entry pairing, not just by buildEditOps).
          let newTargetEntry = entriesById.get(b.marker.to.toLowerCase());
          if (!newTargetEntry) newTargetEntry = parsed.entries.find(e => e.id && e.id.toLowerCase() === b.marker.to.toLowerCase() && !e.archived);
          markerOnlyActions.push({
            kind: '⑦add-supersedes-to-target', file: newTargetEntry ? newTargetEntry.file : f,
            titleLineNo: newTargetEntry ? newTargetEntry.titleLineNo : null,
            sourceTag: target.id, sourceFile: f, sourceTitleLineNo: target.titleLineNo, newSupersededBy: b.marker.to,
          });
        }
      }
    }
  }
  actions.push(...hookMoveActions, ...markerOnlyActions, ...nonstandardMarkerActions, ...lateActions);

  // -- ⑥ single-bracket / malformed Supersedes lines (from core B23 diagnostics), excluding the ⑧
  //      prose-clarification ones already classified above ------------------------------------------
  const clarifyLineNos = new Set(nonstandardMarkerActions.filter(a => a.kind === '⑧prose-link-not-edge').map(a => a.file + ':' + a.titleLineNo));
  // archives are §1.5 "逐字、无 Index、零改写" (verbatim, zero rewrite) — B23 still fires there via
  // --check (reported globally), but it is never a migration ACTION since C1 never edits archives.
  const b23Diags = parsed.diagnostics.filter(d => d.code === 'B23' && !core.ARCHIVE_SET.has(d.file));
  const singleBracketActions = [];
  for (const d of b23Diags) {
    const isClarifyProse = /澄清|部分取代/.test(d.raw);
    singleBracketActions.push({ kind: isClarifyProse ? '⑧prose-link-not-edge(field-line)' : '⑥normalize-supersedes-brackets', file: d.file, lineNo: d.line, tag: d.tag, raw: d.raw });
  }
  actions.push(...singleBracketActions);

  // -- ⑪ banner.md → Banner: field lines on 4 standing entries, then delete banner.md -------------
  const bannerInfo = snap.files['banner.md'];
  let bannerAction = null;
  if (bannerInfo && !bannerInfo.missing) {
    const text = bannerInfo.raw.toString('utf8');
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    bannerAction = { kind: '⑪banner-to-fields', lineCount: lines.length, lines: lines.slice(1) }; // skip header line 1
  }
  if (bannerAction) actions.push(bannerAction);

  // -- ⑫ delete stray `## Index`/`### Index` headings (from core B9 diagnostics) ------------------
  const b9 = parsed.diagnostics.filter(d => d.code === 'B9');
  for (const d of b9) actions.push({ kind: '⑫delete-index-heading', file: d.file, lineNo: d.line, raw: d.raw });

  // -- ⑬ trust flag addition on process:review-effort-tier-table -----------------------------------
  // This tag is ambiguous pre-④ (exists in both decisions.md and standinginstructions.md — that's
  // exactly the ④ cross-file-duplicate pair). Per FINAL §5 ⑬ the target is explicitly the
  // standinginstructions.md "Entries 区" copy (Banner: hosting requires it there, B19) — pick it by
  // file, not by array-iteration order (which would otherwise nondeterministically prefer whichever
  // of decisions.md/standinginstructions.md is parsed first).
  const trustTarget = parsed.entries.find(e => e.id === 'process:review-effort-tier-table' && !e.archived && e.file === 'standinginstructions.md')
    || parsed.entries.find(e => e.id === 'process:review-effort-tier-table' && !e.archived);
  if (trustTarget && trustTarget.trust !== 'user-ratified') {
    if (pin) {
      const pe = pin.entries.find(e => e.kind === '⑬add-trust-flag');
      if (!pe) { staleCount++; unmatched.push({ group: '⑬', file: trustTarget.file, reason: 'pin 文件无 ⑬trust-flag 记录(需重新 --pin-d1)' }); }
      else if (pe.ambiguous) { ambiguousCount++; unmatched.push({ group: '⑬', file: trustTarget.file, reason: `AMBIGUOUS(记录于 pin 文件):${pe.note || ''}` }); }
      else {
        const loc = locatePinnedEntry(parsed, snap, pe.file, pe.titleLineNo, pe.titleLineSha256);
        if (!loc.ok) { staleCount++; unmatched.push({ group: '⑬', file: pe.file, reason: loc.reason }); }
        else actions.push({ kind: '⑬add-trust-flag', file: loc.entry.file, titleLineNo: loc.entry.titleLineNo, id: loc.entry.id, titleLineSha256: pe.titleLineSha256, blockHash64: loc.entry.blockHash64, pinned: true });
      }
    } else {
      actions.push({
        kind: '⑬add-trust-flag', file: trustTarget.file, titleLineNo: trustTarget.titleLineNo, id: trustTarget.id,
        titleLineSha256: titleLineSha(snap.files[trustTarget.file].raw, trustTarget.titleLineNo), blockHash64: trustTarget.blockHash64,
      });
    }
  }

  const list24Total = pin ? pin.entries.filter(e => e.kind === '①insert-identity').length : d1.list24.length;
  const groups = {
    '①identity-less-titles': list24Matched,
    '①identity-less-titles-unmatched': list24Total - list24Matched,
    '①③④⑬AMBIGUOUS(refused,需人工裁定)': ambiguousCount,
    '①③④⑬STALE-PIN(refused,需重新--pin-d1)': staleCount,
    '②user-no-colon': bareUserAction.length,
    '③same-file-duplicates': sameFileDupActions.length,
    '④cross-file-duplicates': crossFileDupActions.length,
    '⑤hook-from-index-rest': hookMoveActions.length,
    '⑥normalize-supersedes-brackets': singleBracketActions.filter(a => a.kind === '⑥normalize-supersedes-brackets').length,
    '⑦marker-only-supersedes': markerOnlyActions.length,
    '⑧prose-link-not-edge': nonstandardMarkerActions.filter(a => a.kind === '⑧prose-link-not-edge').length + singleBracketActions.filter(a => a.kind.startsWith('⑧')).length,
    '⑨dateRaw-to-hook': lateActions.length,
    '⑩oversized-index-rows(manual)': oversizedIndexRows.length,
    '⑪banner-lines': bannerAction ? bannerAction.lines.length : 0,
    '⑫stray-index-headings': b9.length,
    '⑬trust-flag-additions': trustTarget && trustTarget.trust !== 'user-ratified' ? 1 : 0,
  };

  return { groups, actions, unmatchedD1: unmatched, oversizedIndexRows, parsed, graph, ambiguousCount, staleCount };
}

// ── --plan ──────────────────────────────────────────────────────────────────────────────────────
// Files whose bytes participate in the plan↔apply content fingerprint (Opus B-1/B-3): the 7 core
// ALL_FILES plus banner.md, which ⑪ also reads/edits. Order-independent (contentFingerprint sorts).
const FINGERPRINT_FILES = core.ALL_FILES.concat(['banner.md']);
// R12-1 fix (2026-09-16 round 12, guards/audits/CODEX-2026-09-16-round11-review.md MEDIUM-1): the
// allowed corpus-file-name set for validateEditRecords' `file` check below, precomputed once as a Set
// so membership is decided by SameValueZero (no ToPropertyKey coercion) rather than by using `file` as
// an object property key — see validateEditRecords' own header comment for why that distinction is the
// entire point of this round's fix.
const FINGERPRINT_FILES_SET = new Set(FINGERPRINT_FILES);

// Fable 2026-09-15 (guards/audits/FABLE-2026-09-15-rollback-verify-false-alarm.md): the ONE place that
// builds a snapshot of an on-disk --dir suitable for fingerprinting FINGERPRINT_FILES. banner.md is
// NOT one of core.ALL_FILES (core.snapshotDir never populates it — it is not a `**title**` entry file),
// so any caller that fingerprints FINGERPRINT_FILES against a bare core.snapshotDir(dir) is hashing
// banner.md as "missing" while the before-write side hashes its real bytes — making the two
// fingerprints mathematically unequal REGARDLESS of whether --dir's content actually matches. Every
// site that fingerprints a --dir on disk against FINGERPRINT_FILES (before-write gate, post-write gate,
// and both rollback re-verifications) MUST go through this SAME function — no second implementation.
function snapshotForFingerprint(dir) {
  const snap = core.snapshotDir(dir); // throws PmmCoreError on any missing/unreadable core file (Opus B-4)
  const bannerPath = dir.replace(/\\/g, '/') + '/banner.md';
  let bannerRaw = null;
  try { bannerRaw = fs.readFileSync(bannerPath); } catch { bannerRaw = null; }
  if (bannerRaw == null) {
    snap.files['banner.md'] = { raw: null, missing: true };
  } else {
    const { buf, hadBOM } = core.stripBOM(bannerRaw);
    snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
  }
  return snap;
}

// Simulate applying a set of edits to a snap's buffers (in memory, no disk I/O) — used at --plan
// time only, to compute contentFingerprintAfter (the fingerprint --apply will see once it has
// actually written the edits) without a second real apply pass.
function simulateAfterSnap(snap, edits) {
  // R12-2 fix (2026-09-16 round 12, guards/audits/CODEX-2026-09-16-round11-review.md MEDIUM-1 companion
  // finding): Object.create(null) instead of `{}` — a plain object literal's `__proto__` is not a
  // regular own property, so `e.file === "__proto__"` makes `byFile[e.file]` read/write the object's
  // OWN PROTOTYPE instead of a real entry, which is either silently wrong (the grouping loop below) or
  // an uncaught TypeError (`.push` on a non-array) elsewhere this exact pattern appears. This call site
  // is reached only with buildEditOps-produced edits (safe by construction) or, via cmdApply's R-2
  // semantic gate, with plan.edits AFTER validateEditRecords has already rejected any file not in
  // FINGERPRINT_FILES_SET — so `__proto__` can no longer reach here today — but per the round-12 brief's
  // explicit ask, every `obj[planField]`-shaped map in this file is hardened the same way, not just the
  // one the audit happened to name, so a future call site added before the front gate doesn't reopen it.
  const byFile = Object.create(null);
  for (const e of edits) { if (!byFile[e.file]) byFile[e.file] = []; byFile[e.file].push(e); }
  const files = {};
  for (const f of FINGERPRINT_FILES) {
    const info = snap.files[f];
    if (!info || info.missing) { files[f] = { raw: null, missing: true }; continue; }
    const list = byFile[f] || [];
    const after = list.length ? applyEditsToBuffer(Buffer.from(info.raw), list) : info.raw;
    files[f] = { raw: after, hadBOM: info.hadBOM, missing: false, rawWithBOM: info.hadBOM ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), after]) : after };
  }
  return { view: 'simulated-after', files, sourceOids: {} };
}

// Opus B-1/B-3: the single function that computes a full, self-contained plan (actions + concrete
// byte edits + before/after content fingerprints). `opts.pin` (coordinator follow-up, "pin the D1
// mapping"): when given a parsed D1-PINNED-<oid>.json, ①③④⑬ are consumed from it (with a
// titleLineSha256 staleness check against the CURRENT corpus) instead of running bestMatch — the
// fuzzy matcher only ever runs when `opts.pin` is absent, i.e. inside `cmdPinD1`. Both `cmdPlan`
// (real corpus, HEAD, always passes `opts.pin` once a pin file exists) and the hermetic self-test
// call this SAME function so they exercise identical code. `--apply` never calls this again; it only
// ever consumes the `edits` a prior call to this function produced.
function buildFullPlan(snap, d1, opts) {
  const plan = computePlan(snap, d1, opts || {});
  const edits = buildEditOps(plan, snap);
  const contentFingerprint = core.contentFingerprint(snap, FINGERPRINT_FILES);
  const afterSnap = simulateAfterSnap(snap, edits);
  const contentFingerprintAfter = core.contentFingerprint(afterSnap, FINGERPRINT_FILES);
  return { plan, edits, contentFingerprint, contentFingerprintAfter };
}

function titleLineText(buf, titleLineNo) {
  const ls = findLineStartByTitleLineNo(buf, titleLineNo);
  if (ls == null) return null;
  const le = lineEndByte(buf, ls);
  return buf.slice(ls, le).toString('utf8');
}

// ── corpus content fingerprint: the D1-PINNED/PLAN naming+freshness key (spec 补遗三 §32, 主脑裁决
// 2026-09-24) ───────────────────────────────────────────────────────────────────────────────────
// 收口者实证(CHANGELOG 09-24「收口 B 段」、Opus spec 审第 31 条):treeOid(`HEAD:.claude/memory`的
// git 树 OID)把 D1-PINNED/PLAN 钉在了「整个 memory/ 子树没变过一个字节」上,但
// `pmm-fingerprint.sh refresh` 写的收据落在 `memory/dreams/receipts/`(memDir 之下、memRelPrefix
// 覆盖范围之内)——收据一落,receipts 目录变了,memory/ 这棵树的 OID 跟着变,已审的 D1-PINNED/PLAN
// 就被当成「语料已漂移」而作废,而 PLAN/D1-PINNED 文件本身又在指纹覆盖集里,于是两套机制互相使
// 对方过期。根因是 treeOid 的粒度是「整棵子树」,而 D1-PINNED/PLAN 实际关心的只是 core.ALL_FILES
// 这 7 个文件的字节内容——receipts、banner.md 之类的变化对它们从未有影响,不该让它们过期。
// 换成「语料内容指纹」:sha256(core.ALL_FILES 按文件名排序后的原始字节依次拼接;缺失文件不贡献
// 字节,即「以空内容参与」——排序是固定的,因此某文件缺失只是少了它那一段,不会与相邻文件的字节
// 产生歧义式的错位覆盖,因为这里从不需要从指纹反推出「文件在哪切」)。刻意只覆盖 core.ALL_FILES,
// 不包 FINGERPRINT_FILES 里额外的 banner.md ——D1/plan 的钉子只关心这 7 个身份化文件,banner.md
// 的证据仍由 FINGERPRINT_FILES/contentFingerprint 走既有的 plan↔apply 契约,两件事不合流。
// 字节来源刻意选 rawWithBOM(而非去 BOM 后的 raw):`git show <ref>:<path>` 吐出的就是未加工的
// blob 原始字节(有没有 BOM 全凭文件本身),c0-canary-check.sh 用纯 bash（git show | cat 拼接 +
// sha256sum）独立复算这同一个指纹时不可能重放 stripBOM() 的判断逻辑——两侧必须喂同一份未加工字节,
// 否则"两处算法各自正确但互相对不上"这类缺陷会在这里重演一次。
function computeCorpusFingerprint(snap) {
  const list = core.ALL_FILES.slice().sort();
  const parts = [];
  for (const f of list) {
    const info = snap.files[f];
    if (!info || info.missing) continue; // 缺失 = 参与但贡献 0 字节，不是跳过这个文件这件事本身
    const bytes = info.rawWithBOM != null ? info.rawWithBOM : info.raw;
    parts.push(bytes);
  }
  return crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex');
}
// D1-PINNED-<key>.json / PLAN-<key>.json 的文件名 key：内容指纹前 40 hex（与旧 treeOid 命名等长，
// 沿用同一套「够长到不会意外碰撞、够短到文件名可读」的取舍，不是巧合复用旧字段名）。
function corpusFingerprintKey(fp) { return fp.slice(0, 40); }

// ── --pin-d1: the ONLY place the fuzzy matcher (bestMatch/matchScore) runs for ①③④⑬ ───────────
// Reads D1-NAMING.md (or --names), runs computePlan()'s fuzzy path once against HEAD, and writes a
// reviewable, deterministic guards/specs/D1-PINNED-<treeOid>.json — {file, lineRange, titleLineSha256,
// blockHash64, oldTitleLine, newTag, d1Row, score, ambiguous, candidates?} per ①③④⑬ item. `--plan`
// and `--apply` never run bestMatch again; they only verify this file's pins are still fresh.
// Extract the ①③④⑬ pin entries from a (fuzzy-matched) computePlan() result. Shared by cmdPinD1 (real
// corpus, HEAD) and the hermetic self-test (a --dir fixture) so both exercise identical pin-building
// logic — the only difference between them is where `plan`/`snap` came from.
function buildD1PinEntries(plan, snap) {
  const entries = [];
  for (const a of plan.actions) {
    if (a.kind === '①insert-identity') {
      entries.push({
        kind: a.kind, file: a.file, lineRange: [a.titleLineNo, a.titleLineNo], titleLineNo: a.titleLineNo,
        titleLineSha256: a.titleLineSha256, blockHash64: a.blockHash64,
        oldTitleLine: titleLineText(snap.files[a.file].raw, a.titleLineNo),
        newTag: a.newId, d1Row: { file: a.file, gist: a.gist }, score: a.score, ambiguous: false,
      });
    } else if (a.kind === '③rename-same-file-dup' && a.matched) {
      entries.push({
        kind: a.kind, file: a.file, lineRange: [a.renameTitleLineNo, a.renameTitleLineNo], titleLineNo: a.renameTitleLineNo,
        keepTitleLineNo: a.keepTitleLineNo, titleLineSha256: a.titleLineSha256, blockHash64: a.blockHash64,
        oldTitleLine: titleLineText(snap.files[a.file].raw, a.renameTitleLineNo),
        newTag: a.newId, d1Row: { file: a.file, oldId: a.oldId }, score: null, ambiguous: false,
      });
    } else if (a.kind === '④cross-file-decided') {
      entries.push({
        kind: a.kind, file: a.file, lineRange: [a.decisionsTitleLineNo, a.decisionsTitleLineNo], titleLineNo: a.decisionsTitleLineNo,
        standingTitleLineNo: a.standingTitleLineNo, titleLineSha256: a.titleLineSha256, blockHash64: a.blockHash64,
        oldTitleLine: titleLineText(snap.files[a.file].raw, a.decisionsTitleLineNo),
        newTag: a.newId, d1Row: { tag: a.tag }, score: null, ambiguous: false,
      });
    } else if (a.kind === '⑬add-trust-flag') {
      entries.push({
        kind: a.kind, file: a.file, lineRange: [a.titleLineNo, a.titleLineNo], titleLineNo: a.titleLineNo,
        titleLineSha256: a.titleLineSha256, blockHash64: a.blockHash64,
        oldTitleLine: titleLineText(snap.files[a.file].raw, a.titleLineNo),
        newTag: null, action: 'add-trust-flag', d1Row: { id: a.id }, score: null, ambiguous: false,
      });
    }
  }
  // ambiguous ① entries (from unmatchedD1) and ambiguous ③ entries (pushed into actions with matched:false)
  for (const u of plan.unmatchedD1) {
    if (u.group === '①' && /AMBIGUOUS/.test(u.reason || '')) {
      entries.push({ kind: '①insert-identity', file: u.file, ambiguous: true, newTag: u.newId, d1Row: { file: u.file, gist: u.gist }, candidates: u.candidates || [], note: u.reason });
    } else if (u.group === '①') {
      entries.push({ kind: '①insert-identity', file: u.file, ambiguous: true, newTag: u.newId, d1Row: { file: u.file, gist: u.gist }, candidates: [], note: u.reason });
    } else if (u.group === '⑬') {
      entries.push({ kind: '⑬add-trust-flag', file: u.file, ambiguous: true, candidates: [], note: u.reason });
    }
  }
  for (const a of plan.actions) {
    if (a.kind === '③rename-same-file-dup' && a.matched === false) {
      entries.push({ kind: a.kind, file: a.file, ambiguous: true, d1Row: { file: a.file, id: a.id }, candidates: [], note: a.note });
    }
  }
  return entries;
}

function cmdPinD1(args) {
  const namesPath = argVal(args, '--names', SPECS_DIR + '/D1-NAMING.md');
  const snap = core.snapshot('HEAD'); // throws PmmCoreError on any read failure/bad ref (Opus B-4)
  // 主脑裁决(spec 补遗三 §32,2026-09-24):命名/新鲜度键改用语料内容指纹，不再用 treeOid ——
  // treeOid 仍算出来、仍记进文件，但只作参考（例如人工核对「这份 pin 生成时 HEAD 是哪一次提交」），
  // 不再是任何比对/文件命名依据。见 computeCorpusFingerprint() 头部注释。
  const treeOid = core.treeOid('HEAD'); // 仅参考，不参与命名/新鲜度判断
  const corpusFingerprint = computeCorpusFingerprint(snap);
  const key = corpusFingerprintKey(corpusFingerprint);
  const bannerSnap = readBannerIntoSnap(snap);
  const d1 = parseD1Naming(fs.readFileSync(namesPath, 'utf8'));
  const plan = computePlan(bannerSnap, d1, {}); // fuzzy matching — sanctioned ONLY here
  const entries = buildD1PinEntries(plan, bannerSnap);
  const out = { schemaVersion: 1, generatedAt: new Date().toISOString(), corpusFingerprint, treeOid, sourceD1: namesPath, entries };
  fs.mkdirSync(SPECS_DIR, { recursive: true });
  const outPath = SPECS_DIR + `/D1-PINNED-${key}.json`;
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  const ambiguousN = entries.filter(e => e.ambiguous).length;
  console.log(`pmm-migrate-v3 --pin-d1 (corpusFingerprint=${key}…, treeOid=${treeOid} 仅参考): ${entries.length} 条 pin(其中 AMBIGUOUS ${ambiguousN})`);
  console.log(`  写入: ${outPath}`);
  process.exit(ambiguousN > 0 ? 2 : 0);
}

// Coordinator follow-up: --plan NEVER runs the fuzzy matcher itself — it consumes a pinned D1 file
// (default guards/specs/D1-PINNED-<key>.json, key=语料内容指纹前 40 hex; --names may point
// elsewhere). Missing pin file = hard error (no silent fuzzy fallback).
function cmdPlan(args) {
  const snap = core.snapshot('HEAD'); // throws PmmCoreError on any read failure/bad ref (Opus B-4)
  const treeOid = core.treeOid('HEAD'); // 仅参考，不参与命名/新鲜度判断（见 cmdPinD1 头部注释）
  const corpusFingerprint = computeCorpusFingerprint(snap);
  const key = corpusFingerprintKey(corpusFingerprint);
  const bannerSnap = readBannerIntoSnap(snap);
  const pinPath = argVal(args, '--names', SPECS_DIR + `/D1-PINNED-${key}.json`);
  if (!fs.existsSync(pinPath)) {
    console.error(`✖ 找不到已 pin 的 D1 映射文件: ${pinPath}`);
    console.error(`  --plan 不再自己跑模糊匹配 —— 先运行 pmm-migrate-v3.cjs --pin-d1 [--names <D1-NAMING.md>] 生成并人工复核,再重跑 --plan。`);
    process.exit(2);
  }
  let pin;
  try { pin = JSON.parse(fs.readFileSync(pinPath, 'utf8')); }
  catch (e) { console.error(`✖ 无法读取/解析 pin 文件: ${pinPath}(${e.message})`); process.exit(2); }
  if (pin.corpusFingerprint !== corpusFingerprint) {
    console.error(`✖ pin 文件的语料内容指纹(${pin.corpusFingerprint}) != 当前 HEAD:.claude/memory 语料内容指纹(${corpusFingerprint}) —— 语料已漂移(core.ALL_FILES 字节变了),需重新 --pin-d1 并人工复核。`);
    process.exit(2);
  }
  const d1Stub = { list24: [], sameFileDup: [], crossFileDup: [] }; // unused in pinned mode; kept for computePlan's signature
  const { plan, edits, contentFingerprint, contentFingerprintAfter } = buildFullPlan(bannerSnap, d1Stub, { pin });
  const out = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    corpusFingerprint,
    treeOid, // 仅参考——不用于比对/命名，纯记录「生成时 HEAD commit 对应的 memory/ 树 OID」
    contentFingerprint,
    contentFingerprintAfter,
    d1Path: pinPath,
    groups: plan.groups,
    actions: plan.actions,
    edits,
    unmatchedD1: plan.unmatchedD1,
    oversizedIndexRows: plan.oversizedIndexRows,
    ambiguousCount: plan.ambiguousCount,
    staleCount: plan.staleCount,
  };
  fs.mkdirSync(SPECS_DIR, { recursive: true });
  const outPath = SPECS_DIR + `/PLAN-${key}.json`;
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`pmm-migrate-v3 --plan (corpusFingerprint=${key}…, treeOid=${treeOid} 仅参考, pin=${pinPath}):`);
  for (const [k, v] of Object.entries(plan.groups)) console.log(`  ${k}: ${v}`);
  if (plan.unmatchedD1.length) {
    console.log(`  UNMATCHED/STALE/AMBIGUOUS (需人工核对): ${plan.unmatchedD1.length}`);
    for (const u of plan.unmatchedD1) console.log(`    ${u.group} ${u.file} "${u.gist || ''}" → ${u.newId || ''} —— ${u.reason}`);
  }
  if (plan.oversizedIndexRows.length) {
    console.log(`  >320B Index 行(需人工提炼 Hook,不自动缩写):`);
    for (const r of plan.oversizedIndexRows) console.log(`    ${r.file}:${r.lineNo} (${r.bytes}B) ${r.raw}`);
  }
  console.log(`  写入: ${outPath}(edits=${edits.length} contentFingerprint=${contentFingerprint.slice(0, 12)}… after=${contentFingerprintAfter.slice(0, 12)}…)`);
  // FINAL-SPEC §5 / Opus B-2: an AMBIGUOUS D1 match (tie/near-tie, refused rather than guessed) or a
  // STALE pin (title changed since --pin-d1) must fail the --plan run so it can never be silently
  // trusted downstream — the plan file is still written (so the operator can see exactly what's
  // wrong), but the exit code says "not clean". Never re-matches to work around either case.
  if (plan.ambiguousCount > 0 || plan.staleCount > 0) {
    console.error(`✖ ${plan.ambiguousCount} 处 AMBIGUOUS + ${plan.staleCount} 处 STALE-PIN(见上方)—— 需人工裁定/重新 --pin-d1 后重跑 --plan,绝不重新匹配`);
    process.exit(2);
  }
  process.exit(0);
}
function readBannerIntoSnap(snap) {
  // banner.md is not one of core's ALL_FILES (it is not a `**title**` entry file), but the migrator
  // needs its raw bytes for action ⑪ — read it directly and splice into a shallow-cloned snap.
  const bannerPath = core.memDir() + '/banner.md';
  let raw = null;
  try {
    if (snap.view === 'worktree') raw = fs.readFileSync(bannerPath);
    else {
      const { execFileSync } = require('child_process');
      raw = execFileSync('git', ['-C', core.homeDir(), 'show', `${snap.view}:${core.memRelPrefix()}/banner.md`]);
    }
  } catch { raw = null; }
  const clone = { view: snap.view, sourceOids: snap.sourceOids, files: Object.assign({}, snap.files) };
  if (raw == null) {
    clone.files['banner.md'] = { raw: null, missing: true };
  } else {
    const { buf, hadBOM } = core.stripBOM(raw);
    clone.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: raw };
  }
  return clone;
}

// R10-1 fix (2026-09-15 round 10, guards/audits/CODEX-2026-09-15-round9-review.md HIGH-1, the SAME
// defect class surviving a FOURTH repair round after R5-1/R7-1/R8-1 each closed one more reported
// shape of it): the byte-gate (findEditsNotReflectedInSnap → computeAfterPositions,
// `Buffer.from(e.insertText || '', 'utf8')`) and the round-8 coverage invariant
// (`(e.insertText || '').length === 0`, below) each independently decide whether a given edit's
// insertText counts as "empty" — and for an array-like object such as `{length:'0'}`, they DISAGREE:
// Buffer.from treats it as array-like input and produces a zero-length buffer (so the byte-gate calls
// it empty and skips verification), while `({length:'0'} || {length:'0'}).length` is the STRING `'0'`
// (not the number 0), and `'0' === 0` is false under strict equality — so the coverage invariant
// decides this SAME edit is non-empty, i.e. that the byte-gate must have already verified it. Neither
// check is internally wrong; the defect is that a single field had two different definitions of
// "empty" at all. Round 8 required "enumerate the same-class shapes and add a break-test per shape" —
// that was done (four shapes excluded with reasons) and a cross-model re-review still found a member
// the enumeration missed ({length:'0'}, {type:'Buffer',data:[]}). Enumerating further shapes cannot
// close this: the class is "plan.edits[] fields consumed without a type check", not "these specific
// literal shapes". Reject anything that is not ALREADY the type every real buildEditOps-produced edit
// always has (see the `push` helper below, in buildEditOps: deleteLen is always a plain non-negative
// integer, insertText and oldBytesBase64 are always plain strings — even for a deleteLen=0 pure
// insertion, oldBytesBase64 is the empty STRING, never omitted or null) — BEFORE either the idempotency
// short-circuit or the real-apply path reads these fields, so both are downstream of one definition,
// not two. This also retires a second, quieter instance of the same pattern: the old-bytes-absence
// loop below decides "uncheckable" via `if (!e.deleteLen)` (truthy) while the coverage invariant and
// sortAndValidateEdits/applyEditsToBuffer read `e.deleteLen` numerically/arithmetically — harmless
// today only because every currently-reachable bad value happens to be falsy under both readings, but
// that was never asserted anywhere, and validating deleteLen structurally up front makes it true by
// construction instead of by accident.
//
// R12-1 fix (2026-09-16 round 12, guards/audits/CODEX-2026-09-16-round11-review.md MEDIUM-1 — the SAME
// defect class surviving a FIFTH repair round, now on `file`/`offset`/`kind` instead of `insertText`):
// round 10's fix above (renamed validateEditFieldTypes → validateEditRecords here) type-checked exactly
// the three fields the round-9 audit had named — deleteLen/insertText/oldBytesBase64 — and left `file`,
// `offset` and `kind` completely unchecked. The round-11 audit's confirmed repro: an edit whose `file`
// and `kind` are each wrapped in a single-element array (`file:["memory.md"]`, `kind:["①insert-
// identity"]`) sails through the idempotency short-circuit's `snap.files[e.file]` (:~904) and
// `byFile[e.file]` (findEditsNotReflectedInSnap) object-key lookups UNCHANGED, because a single-element
// array's ToPropertyKey coercion (`String(["x"]) === "x"`) makes `obj[["x"]]` and `obj["x"]` look up the
// SAME property — the exact "one field, two silently-agreeing-by-accident readings" pattern this file
// keeps re-discovering, just relocated to a field this round's own predecessor fix didn't cover. Per
// round 8's own lesson (see the R10-1 comment above): enumerating one more literal shape does not close
// the class. The class is "plan.edits[] fields consumed without a type AND domain check before the
// first read", full stop — for EVERY field the generator's own `push` helper (buildEditOps, below)
// always produces with a fixed type: file is always one of FINGERPRINT_FILES, offset is always a plain
// non-negative safe integer, kind is always one of KIND_ORDER's own keys. Renamed (was
// validateEditFieldTypes) and extended to check all six fields validateEditFieldTypes' three checks were
// silently a strict subset of; nothing downstream of this call in cmdApply (the idempotency short-
// circuit AND the real-apply path) is allowed to be the first place any of these six fields' legality is
// decided.
//
// kind gets one more requirement the other fields don't: this function's own object literal
// `KIND_ORDER[kind]` lookup would reproduce the exact coercion bug it exists to close (an array key
// coerces to the same property name as its single string element) — so kind membership here is decided
// by `KIND_KEYS.has(kind)`, a Set whose `.has()` uses SameValueZero with NO key coercion, THE SAME CHECK
// kindRank() itself now uses (see kindRank's own comment, below, for the companion half of this fix:
// sortAndValidateEdits' unconditional `kindRank(e.kind)` loop and the `prev.kind === cur.kind` tie-break
// a few lines under it were reading the very same field through two different lookups — object-key
// (coercing) vs strict equality (non-coercing) — which is R12's own headline finding, restated as code
// instead of JSON shape). One Set, referenced from both this front gate and kindRank, is now the only
// place "is this kind legal" is decided.
function validateEditRecords(edits, allowedFiles) {
  const failures = [];
  edits.forEach((e, i) => {
    const isPlainObject = !!e && typeof e === 'object' && !Array.isArray(e);
    const where = `#${i}(${isPlainObject && e.file != null ? JSON.stringify(e.file) : '(file 缺失/类型有误)'}@${isPlainObject ? JSON.stringify(e.offset) : '?'})`;
    if (!isPlainObject) {
      failures.push(`${where}: 整条 edit 不是普通对象(实际类型=${Array.isArray(e) ? 'array' : typeof e})`);
      return;
    }
    if (typeof e.file !== 'string' || !allowedFiles.has(e.file)) {
      failures.push(`${where}: file 必须是字符串且属于允许的语料文件名集合(FINGERPRINT_FILES),实际类型=${typeof e.file} 值=${JSON.stringify(e.file)}`);
    }
    if (!(Number.isSafeInteger(e.offset) && e.offset >= 0)) {
      failures.push(`${where}: offset 必须是 >=0 的安全整数,实际类型=${typeof e.offset} 值=${JSON.stringify(e.offset)}`);
    }
    if (!(Number.isSafeInteger(e.deleteLen) && e.deleteLen >= 0)) {
      failures.push(`${where}: deleteLen 必须是 >=0 的安全整数,实际类型=${typeof e.deleteLen} 值=${JSON.stringify(e.deleteLen)}`);
    }
    if (typeof e.insertText !== 'string') {
      failures.push(`${where}: insertText 必须是字符串,实际类型=${typeof e.insertText} 值=${JSON.stringify(e.insertText)}`);
    }
    if (typeof e.oldBytesBase64 !== 'string') {
      failures.push(`${where}: oldBytesBase64 必须是字符串,实际类型=${typeof e.oldBytesBase64} 值=${JSON.stringify(e.oldBytesBase64)}`);
    }
    // KIND_KEYS is defined later in this file (with KIND_ORDER) but is resolved lazily here — this
    // function is only ever CALLED at cmdApply-time, long after module load has finished executing
    // KIND_ORDER/KIND_KEYS's own top-level `const` — never at module-evaluation time itself.
    if (typeof e.kind !== 'string' || !KIND_KEYS.has(e.kind)) {
      failures.push(`${where}: kind 必须是字符串且属于 KIND_ORDER 键集(Set.has 严格相等判定,不得用对象键查找),实际类型=${typeof e.kind} 值=${JSON.stringify(e.kind)}`);
    }
  });
  return failures;
}

// ── --apply ─────────────────────────────────────────────────────────────────────────────────────
// Opus B-1/B-3: --apply CONSUMES a plan only. It never calls computePlan/bestMatch again — it just
// (1) checks plan.contentFingerprint(After) against the --dir's own fingerprint (whole-snapshot gate:
// tells "fresh apply" from "already applied" from "wrong/drifted dir"), (2) verifies every edit's
// exact pre-edit bytes still match at its recorded offset (per-edit gate, defense in depth), then
// (3) applies plan.edits verbatim. No bestMatch/computePlan call exists anywhere below this line.
function cmdApply(args) {
  const dir = argVal(args, '--dir');
  const planPath = argVal(args, '--plan');
  if (!dir || !planPath) { console.error('用法: --apply --dir <copy> --plan <PLAN-<oid>.json>'); process.exit(2); }
  refuseIfCanonicalMemory(dir);
  if (!fs.existsSync(dir)) { console.error(`✖ --dir 不存在: ${dir}`); process.exit(2); }

  let plan;
  try { plan = JSON.parse(fs.readFileSync(planPath, 'utf8')); }
  catch (e) { console.error(`✖ 无法读取/解析 plan 文件: ${planPath}(${e.message})`); process.exit(2); }
  if (!Array.isArray(plan.edits) || typeof plan.contentFingerprint !== 'string' || typeof plan.contentFingerprintAfter !== 'string') {
    console.error(`✖ plan 文件缺少 edits/contentFingerprint(After)(旧格式? 需用 --plan 重新生成): ${planPath}`);
    process.exit(2);
  }
  // R10-1/R12-1 fix (see validateEditRecords' header comment above): run BEFORE the self-contradiction
  // check and BEFORE either the idempotency short-circuit or the real-apply path below ever reads
  // file/offset/deleteLen/insertText/oldBytesBase64/kind off any edit — this is now the ONLY place that
  // decides whether these six fields have a legal type/shape/domain; nothing downstream re-decides any
  // of them its own way (in particular: kindRank()'s Set-based membership check is the SAME check this
  // gate uses for `kind`, not a second one that could silently drift from it).
  const editTypeFails = validateEditRecords(plan.edits, FINGERPRINT_FILES_SET);
  if (editTypeFails.length) {
    console.error(`✖ 拒绝:plan.edits 中 ${editTypeFails.length} 处编辑未通过消费前的契约校验(file/offset/deleteLen/insertText/oldBytesBase64/kind)—— 这些字段必须先经过统一的类型与取值域校验,不能任由幂等短路的字节闸、覆盖不变量与排序比较器各自用不同定义解读同一字段。不写入:`);
    for (const m of editTypeFails.slice(0, 10)) console.error(`    ${m}`);
    process.exit(2);
  }
  // R5-1 fix (2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md HIGH-1 /
  // FABLE-2026-09-15-codex-cumulative-triage.md R5-1, requirement 1): a plan claiming
  // contentFingerprintAfter === contentFingerprint while carrying non-empty edits is SELF-
  // CONTRADICTORY — "after" cannot equal "before" if edits were meant to change anything. The
  // confirmed repro: take a real plan, change ONLY contentFingerprintAfter to equal contentFingerprint
  // (edits/actions untouched), run --apply against a --dir that is still genuinely UNMIGRATED. Before
  // this check, `fp === plan.contentFingerprint` trivially also means `fp === plan.contentFingerprintAfter`
  // (both fields now hold the same string), which hits the idempotency short-circuit below and exits 0
  // having written nothing — the corpus is silently left unmigrated while the command reports success.
  //
  // CORRECTION (2026-09-15 round 7, guards/audits/OPUS-2026-09-15-round6-review.md HIGH-1): the
  // ORIGINAL comment here claimed "this check runs BEFORE the --dir fingerprint is even computed, so a
  // doctored/corrupted plan can never reach the short-circuit at all, regardless of what --dir's actual
  // content is" — that is FALSE, and is the third instance today of this file's comments overstating
  // what the code actually guarantees (the other two: the rollback-verify false alarm, and this same
  // short-circuit's old success message — see R5-1 fix requirement 3 below). scratchpad/
  // verify-r7-1-v2.cjs's "V2" construction sets contentFingerprintAfter to a DIFFERENT value than
  // contentFingerprint (so this check does not fire) while ALSO compressing every deleteLen>0 edit into
  // a deleteLen=0 pure insertion, and reaches the short-circuit below just fine against a genuinely
  // UNMIGRATED --dir. This check only rejects the ONE shape where the two fields are literally equal;
  // it says nothing about whether contentFingerprintAfter is an HONEST function of contentFingerprint
  // and edits. That gap is closed by findEditsNotReflectedInSnap inside the short-circuit branch below,
  // not here.
  if (plan.edits.length > 0 && plan.contentFingerprintAfter === plan.contentFingerprint) {
    console.error(`✖ 拒绝:plan 结构自相矛盾 —— contentFingerprintAfter 等于 contentFingerprint,但 edits 非空(${plan.edits.length} 条)。`);
    console.error(`  应用前后指纹相等只在 edits 为空(真正的"无事可做"计划)时才合法;这份 plan 声称有编辑却又声称内容不变,拒绝当成幂等 plan 消费,不写入,不重新生成。`);
    process.exit(2);
  }

  const snap = snapshotForFingerprint(dir); // shared with post-write/rollback re-verification below (Fable 2026-09-15)
  const fp = core.contentFingerprint(snap, FINGERPRINT_FILES);
  const manifestPath = dir.replace(/\\/g, '/') + '/PLAN-applied.json';

  if (fp === plan.contentFingerprintAfter) {
    // Opus A10 (real idempotency), corrected 2026-09-15 (Fable B-1′ fix — the ORIGINAL comment here
    // claimed "every edit's old bytes would fail to match at its recorded offset now — that IS the
    // mechanism, not a special case bolted on top", and guards/audits/FABLE-2026-09-15-b1prime-
    // confirmed.md showed that claim is FALSE for the common case: a pure insertion has
    // deleteLen=0, so oldBytesBase64 is the empty string, which trivially "matches" at ANY offset —
    // the per-edit byte check below can never fail for those edits no matter where --dir's content
    // actually is. The whole-snapshot fingerprint short-circuit below is not a redundant optimization
    // on top of a real per-edit mechanism — for deleteLen=0 edits it is THE ONLY mechanism. Do not
    // remove it on the theory that the per-edit loop already covers this case; it does not.
    //
    // R5-1 fix requirement 2 (2026-09-15 round 5): the whole-snapshot fingerprint match above is now
    // guarded by the self-consistency check just above (requirement 1), but that alone still leaves
    // this branch trusting a single hash equality with zero corroboration. Add real, honest
    // corroboration for the subset of edits where it is actually possible: any edit with deleteLen>0
    // carries the exact pre-edit bytes it expected to delete (`oldBytesBase64`) — if those bytes STILL
    // match at the recorded offset, that edit has demonstrably NOT been applied yet, which directly
    // contradicts "this --dir is already in the after state" no matter what the whole-file hash says.
    // Pure insertions (deleteLen=0) cannot be checked this way (oldBytesBase64 is the empty string,
    // which "matches" at any offset — see the comment above) — round 5 honestly reported those as
    // unverified-by-byte-check rather than silently counting them as confirmed. Round 7
    // (findEditsNotReflectedInSnap, below) closes that remaining gap with a POSITIVE check instead of
    // leaving it merely "honestly disclosed" — 291/291 real edits are covered end to end once both
    // loops have run.
    const stillApplicable = [];
    let uncheckable = 0;
    for (const e of plan.edits) {
      // R10-1 fix: was `if (!e.deleteLen)` (truthy read) while the coverage invariant a few lines down
      // reads the SAME field numerically (`e.deleteLen > 0`) — two semantics for one field, the exact
      // pattern this round's fix retires everywhere it's found. Now that validateEditFieldTypes has
      // already guaranteed deleteLen is a safe non-negative integer, the two readings are provably
      // identical (a non-negative integer is falsy iff it is 0, which is also the only case `> 0` is
      // false), so normalize this to the numeric form instead of leaving two spellings that only
      // happen to agree by construction.
      if (!(e.deleteLen > 0)) { uncheckable++; continue; }
      const info = snap.files[e.file];
      if (!info || info.missing) continue; // a missing file can't be "still applicable" either way
      const actual = info.raw.slice(e.offset, e.offset + e.deleteLen).toString('base64');
      if (actual === e.oldBytesBase64) stillApplicable.push(`${e.file}@${e.offset}(len=${e.deleteLen},kind=${e.kind || (e.action && e.action.kind)})`);
    }
    if (stillApplicable.length) {
      console.error(`✖ 拒绝:--dir 内容指纹等于 plan 声明的应用后指纹,但逐条核验发现 ${stillApplicable.length} 处编辑在其记录的偏移处仍能匹配到"应用前"的旧字节 —— 这与"已是应用后状态"矛盾(指纹巧合或 plan/--dir 配对有误)。不宣称幂等,不写入:`);
      for (const m of stillApplicable.slice(0, 10)) console.error(`    ${m}`);
      process.exit(2);
    }
    // R7-1 fix (2026-09-15 round 7, guards/audits/OPUS-2026-09-15-round6-review.md 转 GO 最小集 #1):
    // the loop above only ever produces a NEGATIVE signal ("old bytes gone"), and only for deleteLen>0
    // edits — see findEditsNotReflectedInSnap's own header comment for the full "V2" repro this closes.
    // Require POSITIVE evidence for every edit that has any (i.e. every edit buildEditOps actually
    // produces — all seven producing kinds emit a non-empty insertText): the new bytes it claims to
    // have inserted must actually be present at their predicted position in --dir's CURRENT content.
    const notReflected = findEditsNotReflectedInSnap(snap, plan.edits);
    if (notReflected.length) {
      console.error(`✖ 拒绝:--dir 内容指纹等于 plan 声明的应用后指纹,但 ${notReflected.length} 处编辑应插入的新字节在其预期落点未找到 —— 这与"已是应用后状态"矛盾(指纹巧合、plan/--dir 配对有误,或 plan 的 deleteLen/oldBytesBase64 字段被篡改成纯插入形状以绕过旧字节核验)。不宣称幂等,不写入:`);
      for (const m of notReflected.slice(0, 10)) console.error(`    ${m}`);
      process.exit(2);
    }
    const checkedCount = plan.edits.length - uncheckable;
    // R10-1 fix: insertText is now guaranteed a string by validateEditFieldTypes above, so `|| ''` can
    // no longer change its type — but keep the emptiness test expressed in BYTES (Buffer.byteLength),
    // the same unit the byte-gate (computeAfterPositions/Buffer.from) actually verifies, rather than in
    // UTF-16 code units (`.length`). For the zero/non-zero boundary these coincide for any real string
    // (only '' has both zero chars and zero bytes), but stating it in the byte-gate's own unit is what
    // makes "one definition, shared by both sides" true by construction rather than by coincidence.
    const newBytesCheckedCount = plan.edits.filter(e => Buffer.byteLength(e.insertText, 'utf8') > 0).length;
    // R8-1 fix (2026-09-15 round 8, guards/audits/OPUS-2026-09-15-round8-review.md HIGH-1 — the SAME
    // defect surviving a THIRD repair round: round 5 closed the "contentFingerprintAfter ===
    // contentFingerprint" shape, round 7 closed the "compress every deleteLen>0 edit into a pure
    // insertion" shape — each round closed the ONE reported shape, not the underlying class). The two
    // loops above are each an independent per-edit OR-branch: the old-bytes-absence loop a few lines up
    // only ever FIRES when `e.deleteLen` is truthy; findEditsNotReflectedInSnap's new-bytes-presence
    // check only ever FIRES when `(e.insertText || '').length > 0`. Nothing before this line has ever
    // asserted the DISJUNCTION covers every edit — an edit with BOTH deleteLen falsy (0/null/undefined/
    // '') AND insertText falsy/empty/absent satisfies NEITHER firing condition and reaches the manifest
    // write below with ZERO evidence on either side, regardless of what --dir's actual bytes are. This
    // is not a hypothetical requiring a forged value: deleteLen/insertText/oldBytesBase64 simply ABSENT
    // from an edits[] entry (truncated JSON, an older schema, a serializer that omits falsy/empty
    // fields) produces exactly this shape with no field needing to be forged at all — see IDEMFP-V5 in
    // pmm-migrate-v3.sh (missing keys, the actual class boundary) and IDEMFP-V6/V7 (explicit JSON
    // `null` / an empty-array insertText — the `|| ''` fallback above and Buffer.from's array-argument
    // behavior in findEditsNotReflectedInSnap both collapse these to the identical zero-length
    // "unchecked" shape, so the same single filter below closes all of them, not just one literal
    // construction). Refuse BEFORE writing the manifest or printing the success line below — that
    // line's "全部至少有一侧核验通过" claim is now a machine-enforced postcondition of reaching it, not
    // a bare assertion (see the correction to findEditsNotReflectedInSnap's header comment, which used
    // to claim "every edit shape has at least one side that can actually fail" — that claim was FALSE,
    // per the round-8 audit).
    // R10-1 fix: same normalization as newBytesCheckedCount above — insertText is guaranteed a string
    // now, so express "empty" in bytes (Buffer.byteLength) rather than `(e.insertText || '').length`,
    // matching the byte-gate's own unit instead of merely agreeing with it at zero by coincidence.
    const uncoveredEdits = plan.edits.filter(e => !(e.deleteLen > 0) && Buffer.byteLength(e.insertText, 'utf8') === 0);
    if (uncoveredEdits.length) {
      console.error(`✖ 拒绝:--dir 内容指纹等于 plan 声明的应用后指纹,但 ${uncoveredEdits.length} 处编辑的 deleteLen 与 insertText 双双为假/空/缺失 —— 旧字节核验(deleteLen>0 时才触发)与新字节核验(insertText 非空时才触发)对它们均未开火,这一侧完全没有被检查过,不能宣称幂等,不写入:`);
      for (const e of uncoveredEdits.slice(0, 10)) {
        console.error(`    ${e.file}@${e.offset}(kind=${e.kind || (e.action && e.action.kind)}): deleteLen=${JSON.stringify(e.deleteLen)} insertText=${JSON.stringify(e.insertText)}`);
      }
      process.exit(2);
    }
    // R10-2 fix (2026-09-15 round 10, guards/audits/CODEX-2026-09-15-round9-review.md MEDIUM-1): this
    // branch used to ALWAYS overwrite manifestPath with `edits: []` and (bug) no contentFingerprintAfter
    // at all — "zero files/edits written this run" and "an existing full audit manifest gets clobbered
    // and schema-downgraded" were simultaneously true, and the round-9 audit's read-code inference is
    // that a manifest missing contentFingerprintAfter fails --apply's own format check (see the
    // `editTypeFails`-adjacent check near the top of this function) and fails --verify's A10 (which
    // defaults to reading afterDir/PLAN-applied.json as its `plan` when no --plan is given, then
    // re-invokes --apply with it).
    //
    // Two fixes were on the table: (a) keep writing, but with full `edits` and a real
    // `contentFingerprintAfter`; (b) don't write anything on this branch at all. (a) looks like the
    // smaller change but is actually unsound: the only HONEST value for `contentFingerprintAfter` here
    // is `fp` itself (nothing changed during this run — the dir was already in the after-state when it
    // started and still is), which means `contentFingerprint === contentFingerprintAfter` while
    // `edits` stays non-empty — EXACTLY the shape the R5-1 self-contradiction guard near the top of
    // this function exists to reject. A10's own re-invocation of `--apply` with this "fixed" manifest
    // would walk straight into that guard and fail again — (a) does not actually restore
    // consumability, it just relocates the rejection to a different, unconditional guard, and does so
    // silently (the guard's error message talks about "自相矛盾", which would be a confusing thing to
    // see fall out of a plan this file itself just wrote).
    //
    // (b) is both simpler and strictly correct: nothing was written to `dir` this run, so nothing
    // should be written to its manifest either. Whatever manifest already exists (from a genuine prior
    // --apply, if any) is the fully-typed, non-self-contradictory audit record of what actually
    // happened, and leaving it untouched keeps it exactly as consumable by --apply/--verify (A10
    // included) as it always was — this is what lets the "幂等:二跑" self-test below assert the
    // manifest's sha256 is byte-identical before and after, rather than merely "still parses". If no
    // manifest exists yet (this --dir reached the idempotent branch without this tool ever having
    // written one — e.g. migrated by other means, or a manifest was manually removed), none is
    // fabricated: downstream --verify assertions that need a plan (A10) correctly report NOT-RUN
    // instead of being fed a lossy substitute dressed up as success.
    const manifestNote = fs.existsSync(manifestPath)
      ? `既有 manifest 未改动(幂等短路不写入、不覆盖):${manifestPath}`
      : `未写 manifest(--dir 到达幂等短路时本工具此前从未在此写过 manifest)`;
    // R5-1 fix requirement 3, extended R7-1 (2026-09-15 round 7): this message states only what was
    // actually verified on BOTH sides — old-bytes-absence for deleteLen>0 edits (unchanged from round
    // 5) AND, new this round, new-bytes-presence for every edit with non-empty insertText. It no longer
    // describes any edit as merely "无法独立核验" (unverifiable) when a positive check was in fact run
    // and passed — that phrasing is what let V2 through undetected.
    console.log(`pmm-migrate-v3 --apply --dir ${dir}: 写入 0 文件,编辑 0 处(幂等:--dir 内容指纹等于 plan 声明的应用后指纹;其中 ${checkedCount}/${plan.edits.length} 处可核验编辑(deleteLen>0)已逐条确认旧字节不再匹配,${newBytesCheckedCount}/${plan.edits.length} 处编辑(insertText 非空)已逐条确认新字节确在其预期落点出现;${plan.edits.length} 处编辑全部至少有一侧核验通过)`);
    console.log(`  ${manifestNote}`);
    process.exit(0);
  }
  if (fp !== plan.contentFingerprint) {
    console.error(`✖ 拒绝:--dir 当前内容指纹(${fp})既不等于 plan 的应用前指纹(${plan.contentFingerprint})也不等于应用后指纹(${plan.contentFingerprintAfter})。`);
    console.error(`  --dir 与这份 plan 不对应(内容已漂移,或这份 plan 是为另一份语料生成的)。请用 --plan 针对当前语料重新生成,或确认 --dir 路径。`);
    process.exit(2);
  }

  // Per-edit byte verification (defense in depth on top of the whole-file fingerprint match above).
  // Coordinator follow-up ("pin the D1 mapping"): also re-verify titleLineSha256 for every edit that
  // carries one — this is the pinned ①③④⑬ actions' own staleness guarantee, checked again here
  // (independently of --plan's own check) right before the bytes it protects are touched.
  const mismatches = [];
  for (const e of plan.edits) {
    const info = snap.files[e.file];
    if (!info || info.missing) { mismatches.push(`${e.file}: 文件缺失`); continue; }
    const actual = info.raw.slice(e.offset, e.offset + e.deleteLen).toString('base64');
    if (actual !== e.oldBytesBase64) mismatches.push(`${e.file}@${e.offset}(len=${e.deleteLen},kind=${e.kind || (e.action && e.action.kind)}): 旧字节与 plan 记录不符`);
    if (e.titleLineSha256 && e.titleLineNo != null) {
      const curSha = titleLineSha(info.raw, e.titleLineNo);
      if (curSha !== e.titleLineSha256) mismatches.push(`${e.file}:${e.titleLineNo}(kind=${e.kind}): 标题行 sha256 与 plan 记录不符(pin=${e.titleLineSha256} 现=${curSha || '(不可读)'})`);
    }
    // Fable B-1′ fix item 2 (2026-09-15): titleLineSha256 above only proves "the title line's own
    // bytes are unchanged" — it never proved `e.offset` actually falls inside the block that title
    // line anchors. A deleteLen=0 edit (empty oldBytesBase64, matches anywhere) whose `offset` was
    // moved to an unrelated location would pass BOTH checks above unchanged. Bind them: recompute
    // the anchored line's own [lineStart, lineEnd) byte range from the CURRENT buffer (never trust
    // plan's own offset for this) and require e.offset (and its whole deleteLen span) to land inside
    // it — every buildEditOps() edit kind inserts/deletes only within its anchor line's own bytes.
    if (e.titleLineNo != null) {
      const lineStart = findLineStartByTitleLineNo(info.raw, e.titleLineNo);
      const lineEnd = lineStart == null ? null : lineEndByte(info.raw, lineStart);
      if (lineStart == null || e.offset < lineStart || e.offset > lineEnd || (e.offset + e.deleteLen) > lineEnd) {
        mismatches.push(`${e.file}@${e.offset}(titleLineNo=${e.titleLineNo},kind=${e.kind}): offset 不落在该标题行的块内(块=[${lineStart},${lineEnd}])——疑似 offset 被挪动`);
      }
    }
  }
  if (mismatches.length) {
    console.error(`✖ 拒绝:${mismatches.length} 处编辑的旧字节与 plan 记录不符(整份指纹已核对相等,但逐条校验发现不一致 —— 拒绝,不重新匹配):`);
    for (const m of mismatches.slice(0, 10)) console.error(`    ${m}`);
    process.exit(2);
  }

  // Opus O-1 fix (2026-09-15 round 2, guards/audits/OPUS-2026-09-15-repair-review.md "O-1"): the
  // per-edit check above only requires e.offset to fall SOMEWHERE inside its anchor title line's own
  // byte range — for a pure insertion that is up to 611 bytes of free play on the real corpus, because
  // deleteLen=0 makes oldBytesBase64 the empty string, which "matches" at ANY offset in that range. A
  // hand-edited (or buggy-upstream) plan can move edits[].offset anywhere inside that range while
  // recomputing contentFingerprintAfter to match its OWN (now-wrong) edit set — both checks above are
  // self-consistent with a wrong plan; neither is independent of plan.edits[].offset itself, and their
  // effective coverage has empty intersection (round-2 brief's exact framing). Close that: recompute
  // the ENTIRE edits array from plan.actions (never from plan.edits' own offset numbers) against
  // --dir's OWN current bytes — already proven identical to the plan's before-state by the fingerprint
  // check above — using the same buildEditOps() --plan itself uses, called FRESH here against a parse
  // of --dir, never against anything stored in the JSON. Require byte-for-byte positional equality
  // with plan.edits; any divergence (including an offset moved inside the same anchor line) is
  // rejected before a single byte is written.
  let independentEdits;
  let freshParsedForSemanticGate = null; // hoisted out of the try block — R-2 fix below reuses it
  try {
    const freshParsed = core.parseAll(snap);
    core.attachLegacyIndex(freshParsed, snap);
    freshParsedForSemanticGate = freshParsed;
    independentEdits = buildEditOps({ actions: plan.actions, parsed: freshParsed }, snap);
  } catch (e) {
    console.error(`✖ 拒绝:独立重导编辑区间时异常(${e.message || e}) —— 拒绝,不写入`);
    process.exit(2);
  }
  const indepMismatches = [];
  if (!Array.isArray(plan.actions) || independentEdits.length !== plan.edits.length) {
    indepMismatches.push(`编辑条数不符:独立重导 ${independentEdits.length} 条(基于 plan.actions),plan.edits 记录 ${plan.edits.length} 条`);
  } else {
    // R-1 fix requirement 3 (2026-09-15 round 3, OPUS-2026-09-15-round2-review.md "R-1"): compare as a
    // NORMALIZED-SORT MULTISET keyed on (file, offset, deleteLen, insertText, kind) rather than pairing
    // by raw array index. Per-index pairing was never a meaningful equality check to begin with — array
    // order is an incidental byproduct of how buildEditOps happens to iterate plan.actions, not part of
    // either side's actual content — and it was actively misleading: a tampered plan.actions whose two
    // same-offset actions were swapped reorders BOTH `independentEdits` (rebuilt from that SAME
    // plan.actions) and the stored `plan.edits` (built from it too, at --plan time) identically, so
    // index-pairing found "no diff" even though genuinely different bytes were about to be written —
    // the "一致重排,下标配对无差异" the audit named. Comparing canonicalized, independently-sorted
    // multisets makes this check mean what its name claims — "these two edit sets are the same, full
    // stop" — never mind what order either side happened to construct them in. (The KIND_ORDER fix in
    // applyEditsToBuffer above is what actually neutralizes the swap attack at the byte level; this is
    // a separate, honest-by-construction defense-in-depth check, not a second mechanism for the same
    // fix.)
    const canon = (e) => JSON.stringify([e.file, e.offset, e.deleteLen, e.insertText, e.kind]);
    const indA = independentEdits.map(canon).sort();
    const indB = plan.edits.map(canon).sort();
    for (let i = 0; i < indA.length; i++) {
      if (indA[i] !== indB[i]) {
        indepMismatches.push(`#${i}(按 file/offset/deleteLen/insertText/kind 规范化排序后比较,非下标配对):独立重导=${indA[i]},plan.edits=${indB[i]}`);
      }
    }
  }
  if (indepMismatches.length) {
    console.error(`✖ 拒绝:${indepMismatches.length} 处编辑的落点与从 plan.actions + --dir 当前字节独立重导的结果不符(疑似 plan.edits 的 offset 被篡改/挪动 —— 绝不信任 plan 里的 offset 数字,不写入):`);
    for (const m of indepMismatches.slice(0, 10)) console.error(`    ${m}`);
    process.exit(2);
  }

  // R-2 fix (2026-09-15 round 3, OPUS-2026-09-15-round2-review.md "R-2"): checkA2Semantic (the
  // core.parseFile()-based structural check that asks what the resulting text actually MEANS, never
  // calling buildEditOps at all) used to live ONLY inside --verify's A2 — --apply's own decision chain
  // never called it. A bug living inside buildEditOps ITSELF (not a tampered plan JSON — the function's
  // own branch/offset logic, e.g. the confirmed ②user-no-colon coverage gap) reproduces identically in
  // both "what got written" (applyEditsToDir below) and "what the independent redo above recomputed"
  // (both call buildEditOps), so neither of the checks above can ever catch it; only re-parsing the
  // RESULT independently can. Run that check HERE, on an in-memory simulation of what disk would look
  // like after this exact plan.edits is applied (simulateAfterSnap — the same function --plan itself
  // uses to compute contentFingerprintAfter) — BEFORE a single byte is actually written — so a
  // buildEditOps defect is refused pre-write, not merely discovered post-hoc by a separate --verify run
  // an operator might skip or ignore.
  let semanticFails;
  try {
    const { checkA2Semantic } = require('./pmm-verify-assertions.cjs');
    const simulatedAfter = simulateAfterSnap(snap, plan.edits);
    const afterParsedSim = core.parseAll(simulatedAfter);
    semanticFails = checkA2Semantic(core, { actions: plan.actions }, freshParsedForSemanticGate, afterParsedSim);
  } catch (e) {
    semanticFails = [`语义核验异常(${e.message || e})`];
  }
  if (semanticFails.length) {
    console.error(`✖ 拒绝:写入前语义核验(不经 buildEditOps 的结构重解析,对 plan.edits 应用后的模拟结果)发现 ${semanticFails.length} 处不一致 —— 不写入:`);
    for (const m of semanticFails.slice(0, 10)) console.error(`    ${m}`);
    process.exit(2);
  }

  let writeSummary;
  try {
    writeSummary = applyEditsToDir(dir, snap, plan.edits);
  } catch (e) {
    const rb = e.rollback;
    if (rb && rb.ok) {
      // O-3: verify the rollback actually restored the pre-write fingerprint before trusting it — a
      // rollback that "succeeded" (no fs errors) but wrote the wrong bytes must not be believed blind.
      let rbFp = null;
      try { rbFp = core.contentFingerprint(snapshotForFingerprint(dir), FINGERPRINT_FILES); } catch { rbFp = null; }
      if (rbFp === plan.contentFingerprint) {
        console.error(`✖ 拒绝:写入阶段异常(${e.message || e})—— 已回滚 ${rb.restored.length} 个已写入文件到写入前字节并核实指纹相符,未留下半写状态。`);
      } else {
        console.error(`✖ 拒绝:写入阶段异常(${e.message || e})—— 已尝试回滚 ${rb.restored.length} 个文件,但回滚后指纹(${rbFp || '(读取失败)'})不等于写入前指纹(${plan.contentFingerprint})—— 不得信任「已回滚」,--dir 可能仍处于半写状态,需人工核对。`);
      }
    } else if (rb) {
      console.error(`✖ 拒绝:写入阶段异常(${e.message || e})—— 回滚失败!以下文件可能处于半写状态,需人工核对并从 plan.contentFingerprint(${plan.contentFingerprint})对应的版本控制状态手动恢复:${rb.failed.map(x => x.file + '(' + x.error + ')').join(', ')}`);
    } else {
      console.error(`✖ 拒绝:写入阶段异常(${e.message || e})—— 写入尚未开始或无法判定回滚状态,请人工核对 --dir 内容。`);
    }
    process.exit(2);
  }

  // Fable B-1′ fix item 1 (2026-09-15, the audit's headline finding): `contentFingerprintAfter` was
  // already READ (line ~746) and used for the idempotency short-circuit (line ~765), but nothing
  // ever verified it AFTER a real write — a plan whose edits carry a wrong/shifted offset (e.g.
  // hand-edited, or produced by a buggy upstream step) would sail through every check above and get
  // written verbatim. Recompute the fingerprint over what is now ACTUALLY on disk (never trust
  // plan.edits or the in-memory `snap` for this — re-read from `dir`) and require it to equal what
  // the plan promised. On mismatch, restore every touched file to its pre-write bytes (captured in
  // `snap` before any write happened) and refuse — never leave the corpus half-applied.
  let postFp = null;
  try {
    postFp = core.contentFingerprint(snapshotForFingerprint(dir), FINGERPRINT_FILES);
  } catch (e) {
    postFp = null; // a read failure right after our own write is itself a fatal integrity problem
  }
  if (postFp !== plan.contentFingerprintAfter) {
    // Opus O-3 fix (2026-09-15 round 2): this rollback used to be a bare fs.writeFileSync loop — no
    // try/catch (one failing restore threw UNCAUGHT and abandoned every remaining file) and no post-
    // restore verification (a restore that silently wrote the wrong bytes would still print "不留下
    // 半写状态"). Route through the same restoreFiles() O-2 now uses and actually check the result.
    const rollback = restoreFiles(dir, snap, writeSummary.filesWritten);
    let rbFp = null;
    if (rollback.ok) { try { rbFp = core.contentFingerprint(snapshotForFingerprint(dir), FINGERPRINT_FILES); } catch { rbFp = null; } }
    console.error(`✖ 拒绝:写入后的产物指纹(${postFp || '(读取失败)'})不等于 plan 声明的应用后指纹(${plan.contentFingerprintAfter})。`);
    if (rollback.ok && rbFp === plan.contentFingerprint) {
      console.error(`  已把 ${rollback.restored.length} 个被写入的文件还原为写入前的字节并核实指纹相符 —— plan 与实际写入结果不一致(常见成因:某条编辑的 offset 被挪动),未留下半写状态。`);
    } else if (rollback.ok) {
      console.error(`  已把 ${rollback.restored.length} 个文件还原,但回滚后指纹(${rbFp || '(读取失败)'})不等于写入前指纹(${plan.contentFingerprint})—— 不得信任「已回滚」,--dir 可能仍处于半写状态,需人工核对。`);
    } else {
      console.error(`  回滚失败!以下文件可能处于半写状态,需人工核对并手动恢复:${rollback.failed.map(x => x.file + '(' + x.error + ')').join(', ')}`);
    }
    process.exit(2);
  }

  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 3, appliedAt: new Date().toISOString(), sourcePlan: planPath, treeOid: plan.treeOid,
    contentFingerprint: fp, contentFingerprintAfter: plan.contentFingerprintAfter,
    groups: plan.groups, actions: plan.actions, edits: plan.edits,
    oversizedIndexRows: plan.oversizedIndexRows, unmatchedD1: plan.unmatchedD1, d1Path: plan.d1Path,
  }, null, 2));
  console.log(`pmm-migrate-v3 --apply --dir ${dir}: 写入 ${writeSummary.filesWritten.length} 文件,编辑 ${plan.edits.length} 处`);
  for (const f of writeSummary.filesWritten) console.log(`  已写: ${f}`);
  console.log(`  manifest: ${manifestPath}`);
  process.exit(0);
}

function argVal(args, name, def) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return def;
  return args[i + 1];
}

// Build concrete byte-level edit operations {file, offset, deleteLen, insertText} from the action
// list. Every op's `offset` is expressed against the ORIGINAL (pre-edit) bytes of that file. This is
// now called ONLY at --plan time (Opus B-1): each edit is pinned with the exact pre-edit bytes it
// deletes (`oldBytesBase64`) and the sha256 of the title line it is anchored to (`titleLineSha256`)
// so --apply can verify byte-for-byte without ever re-matching/re-deriving offsets itself.

// R7-5 fix (2026-09-15 round 7, guards/audits/OPUS-2026-09-15-round6-review.md LOW-2 /
// FABLE-2026-09-15-codex-cumulative-triage.md R5-3): pmm-verify-assertions.cjs's checkA2Semantic
// re-derives what ②user-no-colon and ④cross-file-decided's mutual-link edit are supposed to produce
// WITHOUT calling buildEditOps (that independence is its entire reason for existing — see the R5-3
// comment on ④ below), which means it used to hand-type these two exact literal strings a second time.
// A future edit to either literal here that forgets the copy in pmm-verify-assertions.cjs (or that
// copies the SAME wrong value into both, e.g. a search-and-replace mistake) would pass unnoticed either
// way — the check would still agree with the bug. Sharing the LITERAL (not the function, not the code
// path — checkA2Semantic must stay independent of buildEditOps as an algorithm) closes that: both
// files reference this one export, so a change to the text takes effect on both sides atomically.
//
// HONEST LIMITATION (found while updating fixtures/v3/apply-time-semantic-gate-probe.cjs for this
// change): sharing the literal via THIS module reopens a narrower blind spot — a bug that corrupts
// these two `const` definitions THEMSELVES (as opposed to a bug in one of buildEditOps' branches that
// bypasses the constant and writes something else) would corrupt checkA2Semantic's expectation
// identically, since it imports the SAME constant from the SAME file. That specific shape is NOT
// independently checkable without going back to two separately-typed literals (R7-5's option ①,
// rejected in favor of this one — see the round-7 repair report for the tradeoff discussion). The
// probe above deliberately injects its bug at buildEditOps' CALL SITES (bypassing the constant with a
// hardcoded wrong literal — the realistic shape, matching R5-3's actual historical bug), not at these
// definitions, and that is why it still catches something real rather than being tautological.
const USER_RATIFIED_BRACKET = '[user:jax]'; // ②user-no-colon's replacement bracket
const CROSS_FILE_LINK_PREFIX = '规则版 → '; // ④cross-file-decided's second edit — the mutual-link line's prose prefix, before "[[tag]]"
function buildEditOps(plan, snap) {
  const edits = [];
  // R12-2 companion hardening (2026-09-16 round 12): out of R12-1/R12-2's named scope (this key set is
  // only ever POPULATED from the fixed core.ALL_FILES list, never from plan JSON), but it is READ via
  // `byFileBuf[a.file]` below where `a.file` comes from plan.actions — a plan field this round's front
  // gate does not validate (only plan.edits is in scope). Every call site that reaches this function
  // with attacker-controllable plan.actions (cmdApply's R-2 independent-rebuild gate at cmdApply, and
  // pmm-verify-assertions.cjs's rebuildIndependentEdits) already wraps the call in try/catch and turns
  // any thrown error into a structured rejection/FAIL, so `a.file === "__proto__"` was already
  // fail-closed (rc=2 with a stack-shaped message) before this change — Object.create(null) here just
  // makes that failure mode disappear entirely instead of merely being caught.
  const byFileBuf = Object.create(null);
  for (const f of core.ALL_FILES) if (snap.files[f] && !snap.files[f].missing) byFileBuf[f] = snap.files[f].raw;

  function push(file, offset, deleteLen, insertText, a, titleLineNo, buf) {
    edits.push({
      file, offset, deleteLen, insertText,
      oldBytesBase64: buf.slice(offset, offset + deleteLen).toString('base64'),
      titleLineNo: titleLineNo != null ? titleLineNo : null, // explicit — a.titleLineNo isn't the right field for every kind (③=renameTitleLineNo, ④=decisionsTitleLineNo)
      titleLineSha256: titleLineNo != null ? titleLineSha(buf, titleLineNo) : (a.titleLineSha256 || null),
      blockHash64: a.blockHash64 || null,
      kind: a.kind,
      action: a,
    });
  }

  for (const a of plan.actions) {
    if (a.kind === '①insert-identity') {
      const buf = byFileBuf[a.file]; if (!buf) continue;
      // insert ` [newId]` right after the closing `**` of the title line, i.e. right after byteOffset's
      // title line prefix. We locate the closing `**` by scanning the title line text.
      const lineEnd = lineEndByte(buf, a.byteOffset);
      const lineText = buf.slice(a.byteOffset, lineEnd).toString('utf8');
      const closeIdx = lineText.indexOf('**', lineText.indexOf('—') + 1);
      if (closeIdx === -1) continue;
      const insertCharOffset = closeIdx + 2;
      const insertByteOffset = a.byteOffset + Buffer.byteLength(lineText.slice(0, insertCharOffset), 'utf8');
      push(a.file, insertByteOffset, 0, ` [${a.newId}]`, a, a.titleLineNo, buf);
    } else if (a.kind === '②user-no-colon') {
      const buf = byFileBuf[a.file]; if (!buf) continue;
      const lineStart = findLineStartByTitleLineNo(buf, a.titleLineNo);
      if (lineStart == null) continue;
      const lineEnd = lineEndByte(buf, lineStart);
      const lineText = buf.slice(lineStart, lineEnd).toString('utf8');
      // scope the search to the TAIL (text after the closing `**`) — the human-readable title text
      // itself may innocently contain the literal substring "[user]" (e.g. describing this very
      // migration), which must never be mistaken for the real bare-signature bracket in the tail.
      const closeIdx = lineText.indexOf('**', lineText.indexOf('—') + 1);
      if (closeIdx === -1) continue;
      const tailStart = closeIdx + 2;
      const tailText = lineText.slice(tailStart);
      const idx = tailText.search(/\[user\](?!:)/);
      if (idx === -1) continue;
      const byteOff = lineStart + Buffer.byteLength(lineText.slice(0, tailStart + idx), 'utf8');
      push(a.file, byteOff, Buffer.byteLength('[user]', 'utf8'), USER_RATIFIED_BRACKET, a, a.titleLineNo, buf);
    } else if (a.kind === '③rename-same-file-dup' && a.matched) {
      const buf = byFileBuf[a.file]; if (!buf) continue;
      const lineStart = findLineStartByTitleLineNo(buf, a.renameTitleLineNo);
      if (lineStart == null) continue;
      const lineEnd = lineEndByte(buf, lineStart);
      const lineText = buf.slice(lineStart, lineEnd).toString('utf8');
      const idx = lineText.indexOf(`[${a.oldId}]`);
      if (idx === -1) continue;
      const byteOff = lineStart + Buffer.byteLength(lineText.slice(0, idx), 'utf8');
      push(a.file, byteOff, Buffer.byteLength(`[${a.oldId}]`, 'utf8'), `[${a.newId}]`, a, a.renameTitleLineNo, buf);
    } else if (a.kind === '④cross-file-decided') {
      const buf = byFileBuf['decisions.md']; if (!buf) continue;
      const lineStart = findLineStartByTitleLineNo(buf, a.decisionsTitleLineNo);
      if (lineStart == null) continue;
      const lineEnd = lineEndByte(buf, lineStart);
      const lineText = buf.slice(lineStart, lineEnd).toString('utf8');
      const idx = lineText.indexOf(`[${a.tag}]`);
      if (idx === -1) continue;
      const byteOff = lineStart + Buffer.byteLength(lineText.slice(0, idx), 'utf8');
      push('decisions.md', byteOff, Buffer.byteLength(`[${a.tag}]`, 'utf8'), `[${a.newId}]`, a, a.decisionsTitleLineNo, buf);
      // mutual link line insertion right after the decisions.md title line
      const afterTitle = lineEnd;
      push('decisions.md', afterTitle, 0, `${CROSS_FILE_LINK_PREFIX}[[${a.tag}]]\n`, a, a.decisionsTitleLineNo, buf);
    } else if (a.kind === '⑤hook-from-index-rest') {
      const buf = byFileBuf[a.file]; if (!buf) continue;
      const lineStart = findLineStartByTitleLineNo(buf, a.titleLineNo);
      if (lineStart == null) continue;
      const insertAt = lineEndByte(buf, lineStart);
      push(a.file, insertAt, 0, `Hook: ${a.hookText}\n`, a, a.titleLineNo, buf);
    } else if (a.kind === '⑦add-supersedes-to-target') {
      // the ENTRY named by newSupersededBy must gain a `Supersedes: [[sourceTag]]` line — but that
      // target entry may not exist in this parsed snapshot under that exact id (best-effort; only
      // emitted when resolvable).
      const targetE = findEntryById(plan.parsed, a.newSupersededBy);
      if (!targetE) continue;
      const buf = byFileBuf[targetE.file]; if (!buf) continue;
      const lineStart = findLineStartByTitleLineNo(buf, targetE.titleLineNo);
      if (lineStart == null) continue;
      const insertAt = lineEndByte(buf, lineStart);
      push(targetE.file, insertAt, 0, `Supersedes: [[${a.sourceTag}]]\n`, a, targetE.titleLineNo, buf);
    } else if (a.kind === '⑨daterAW-to-hook') {
      // handled conservatively: append dateRaw marker into a Hook line prefix if no Hook action
      // already covers this entry; otherwise it's folded into the ⑤ hook text by a human at C1.
      continue; // no independent byte-op in C0 (informational only; see docs §"未能做到完全确定性之处")
    } else if (a.kind === '⑫delete-index-heading') {
      // C0 never deletes; recorded for information only. (C1-only action.)
      continue;
    } else if (a.kind === '⑬add-trust-flag') {
      const buf = byFileBuf[a.file]; if (!buf) continue;
      const lineStart = findLineStartByTitleLineNo(buf, a.titleLineNo);
      if (lineStart == null) continue;
      const lineEnd = lineEndByte(buf, lineStart);
      const lineText = buf.slice(lineStart, lineEnd).toString('utf8');
      const closeIdx = lineText.indexOf('**', lineText.indexOf('—') + 1);
      if (closeIdx === -1) continue;
      const insertCharOffset = closeIdx + 2;
      const insertByteOffset = lineStart + Buffer.byteLength(lineText.slice(0, insertCharOffset), 'utf8');
      push(a.file, insertByteOffset, 0, ` [trust:user-ratified]`, a, a.titleLineNo, buf);
    }
    // ⑥/⑧/⑪ are left as informational-only actions in C0's --apply (they require either deleting the
    // whole malformed Supersedes line and choosing normalized replacement text, or restructuring
    // banner.md into 4 different target files at once — high-risk multi-file edits reserved for the
    // human-reviewed C1 step per FINAL §5's "人工只剩" list). Recorded in the plan/manifest either way.
  }
  return edits;
}

function findEntryById(parsed, id) {
  // §1.7 (Opus H-7): identity resolution is ASCII-lowercase.
  for (const e of parsed.entries) if (e.id && core.idKey(e.id) === core.idKey(id) && !e.archived) return e;
  return null;
}

// ── same-offset insertion ordering contract (round-3 fix, 2026-09-15, R-1 in
// guards/audits/OPUS-2026-09-15-round2-review.md; spec §9②③ in PMM-V3-FINAL-SPEC.md's C1 硬前置) ──
// When two DIFFERENT actions both insert (deleteLen=0) at the exact same (file, offset) — a real,
// legitimate shape: 5 occurrences in the true 291-edit C1 plan (decisions.md@60958/@61468/@78412 are
// ④+⑤, @63138/@101677 are ⑤+⑦) — the order those inserts concatenate in DETERMINES THE PRODUCT BYTES.
// Before this fix, that order fell out of wherever the two actions happened to sit in `plan.actions`
// (JS Array#sort is stable, so `applyEditsToBuffer`'s old `sort((a,b)=>a.offset-b.offset)` silently
// preserved same-offset ties in INPUT order) — itself an implementation detail of computePlan's push
// sequence, with zero contractual meaning. Swapping two same-offset actions' positions in
// `plan.actions` and regenerating `edits`/`contentFingerprintAfter` the SAME way `--plan` does produced
// a self-consistent-but-different plan that sailed through every existing check (round2-review.md's
// repro: --apply rc=0, --verify's A2 printed "两条独立路径均绿", yet the written bytes differed).
//
// Fix: a FIXED, INPUT-ORDER-INDEPENDENT total order over every action `kind` that can ever produce a
// byte-op. The enumeration below is also the single source of truth for "which kinds produce edits"
// (buildEditOps' own branches — nothing else does), reused by R-2's coverage-completeness check as
// PRODUCING_KINDS so a future kind added to one but not the other fails loudly instead of silently.
// Rank is used ONLY to break a tie when two edits share the exact same `offset` — it never affects
// ordering between edits at different offsets (offset always compares first).
//
// Rationale for the specific order (this comment block IS the "written into the contract" spec §9②
// requires — never again to be re-derived from array position or generation order):
//   ①②③ — in-place edits INSIDE a title line's own tail text (insert/replace a bracket). These can
//         never structurally tie with anything else (their offset is always strictly less than the
//         title line's own lineEnd byte, which is where every field/prose insertion below anchors),
//         but a total order needs every kind ranked; kept in spec-numeral order.
//   ⑦ Supersedes — a genuine §1.2 FIELD line. FINAL-SPEC §1.2's field table lists Supersedes BEFORE
//         Cause/Follows/Hook — reusing that already-authoritative table (rather than inventing an
//         unrelated fresh order) is the least arbitrary choice available.
//   ⑤ Hook — also a §1.2 FIELD line, ranked AFTER Supersedes per that same table.
//   ④ cross-file-decided's SECOND edit ("规则版 → [[tag]]\n") is NOT a §1.2 field row — it's a prose
//         cross-reference line (§1.3 "正文与链"). Structured fields belong together directly under the
//         title (that's the whole point of a field-order table); free-form prose commentary reads
//         naturally AFTER the fields it discusses. Ranked last among the colliding trio. (④'s FIRST
//         edit — the title-line tag rename — reuses the same kind string but, per the ①②③ note above,
//         never actually ties with anything, so this placement is inert there.)
//   ⑬ trust-flag — another title-line-tail edit (same "never ties" case as ①②③); placed last only for
//         readability (spec-numeral order among the non-field kinds).
const KIND_ORDER = Object.freeze({
  '①insert-identity': 1,
  '②user-no-colon': 2,
  '③rename-same-file-dup': 3,
  '⑦add-supersedes-to-target': 4, // §1.2 field order: Supersedes before Hook
  '⑤hook-from-index-rest': 5,      // §1.2 field order: Hook after Supersedes
  '④cross-file-decided': 6,        // prose cross-reference line, ranked after structured fields
  '⑬add-trust-flag': 7,
});
// R-2 companion (same single source of truth, spec §9's "任何一种没有语义分支即自测失败" completeness
// requirement): the exact set of action kinds buildEditOps ever emits a real byte-op for. Anything NOT
// in this set (⑥/⑧/⑨/⑩/⑪/⑫) is recorded in the plan for information only in C0 and never reaches
// applyEditsToBuffer, so it never needs a rank or a semantic-check branch.
const PRODUCING_KINDS = Object.freeze(Object.keys(KIND_ORDER));
// R12-1 fix (2026-09-16 round 12, guards/audits/CODEX-2026-09-16-round11-review.md MEDIUM-1): precompute
// the legal-kind Set ONCE, alongside KIND_ORDER itself, so both validateEditRecords (the front gate in
// cmdApply, above) and kindRank (this function) decide "is this kind legal" via the exact same
// SameValueZero membership check — no ToPropertyKey coercion, so a single-element array like
// `["①insert-identity"]` can never be mistaken for its own wrapped string.
const KIND_KEYS = new Set(Object.keys(KIND_ORDER));
function kindRank(kind) {
  // R12-1 fix: was `KIND_ORDER[kind]` — a plain-object PROPERTY lookup. `[]`/`{}` bracket access
  // coerces its key argument via ToPropertyKey → ToString before comparing, so a single-element array
  // `["①insert-identity"]` stringifies to exactly its wrapped element and `KIND_ORDER[["①insert-
  // identity"]]` silently returns the SAME rank as the legitimate string kind — the round-11 audit's
  // confirmed repro. `KIND_KEYS.has(kind)` uses SameValueZero instead: no coercion, so a non-string
  // value can never match a string Set member no matter what it would stringify to. This is now the
  // ONLY place "is this kind legal" is decided for every caller of kindRank — including the tie-break
  // comparison a few lines below (`prev.kind === cur.kind`) and the sort comparator, both of which run
  // strictly AFTER every edit in the list has already passed THIS check via the unconditional loop in
  // sortAndValidateEdits — so by the time any strict `===` on `.kind` runs, both sides are guaranteed to
  // already be validated strings, and "same field, two disagreeing semantics" (this round's headline
  // finding, and R10-1's before it on `insertText`) can no longer happen for `kind`.
  if (typeof kind !== 'string' || !KIND_KEYS.has(kind)) {
    throw new core.PmmCoreError(`kindRank: 未知的 action kind ${JSON.stringify(kind)} —— 同偏移排序表(KIND_ORDER)没有它的条目;拒绝猜测顺序,不写入。新增产编辑 kind 时必须同步在 KIND_ORDER 里给它定序。`);
  }
  return KIND_ORDER[kind];
}

// Shared by applyEditsToBuffer (building the after-buffer) AND findEditsNotReflectedInSnap (the R7-1
// positive-evidence check below): kind validation + KIND_ORDER sort + same-offset/same-kind tie-break
// rejection + overlap rejection must come from exactly ONE place. A second, independently-written copy
// of this validation silently drifting from the first is the "gate and engine diverge" pattern this
// file has already hit more than once (R-1/R5-5 right here; the B5 glob matcher and the manifest's
// fence-awareness elsewhere) — extracted 2026-09-15 round 7 specifically so the new check can compute
// "the order these edits would really apply in" without re-deriving it.
function sortAndValidateEdits(edits) {
  // R5-5 fix (2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md MEDIUM-1/
  // MEDIUM-2 / FABLE-2026-09-15-codex-cumulative-triage.md R5-5 requirement ①): validate every edit's
  // kind UNCONDITIONALLY before sorting. The sort comparator below only ever calls kindRank() when two
  // edits are compared AND already tie on offset (`||` short-circuits otherwise — an unknown kind whose
  // offset never collides with anything else's is never checked), and Array.prototype.sort never even
  // invokes its comparator for an array of length ≤ 1 (confirmed: a single unregistered-kind edit sails
  // straight through with zero validation). Loop explicitly over every edit first so an unknown kind is
  // always rejected, regardless of array length or whether it happens to tie with anything.
  for (const e of edits) kindRank(e.kind); // throws PmmCoreError for any kind not in KIND_ORDER

  // R-1 fix (2026-09-15 round 3): sort key is (offset, kindRank) — NOT offset alone with a stable-sort
  // tie-break on whatever order `edits` happened to arrive in. See the KIND_ORDER block above for why.
  const list = edits.slice().sort((a, b) => (a.offset - b.offset) || (kindRank(a.kind) - kindRank(b.kind)));

  // R5-5 fix requirement ②: two edits sharing BOTH the same offset AND the same kind have no
  // deterministic tie-break left — (offset - offset) is 0 AND (kindRank - kindRank) is also 0, so the
  // comparator returns 0 (a tie) and Array.prototype.sort's guaranteed stability then falls back to
  // preserving whatever order the INCOMING `edits` array happened to be in — exactly the array-order
  // dependency spec §9② forbids. Confirmed: `[X,Y]` input produces "aXYb", `[Y,X]` input (the same two
  // edits, reordered) produces "aYXb" — both are legitimate re-orderings of the same plan.actions set,
  // so the final byte-for-byte result silently depends on an incidental construction order. This should
  // never legitimately happen (a given action anchors at most one edit of a given kind to a given
  // point) — refuse outright rather than invent a value for a free parameter.
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1], cur = list[i];
    if (prev.offset === cur.offset && prev.kind === cur.kind) {
      throw new core.PmmCoreError(`sortAndValidateEdits: 同偏移同 kind 的两条编辑无确定性次序(${cur.file || prev.file || ''}@${cur.offset} kind=${cur.kind});拒绝猜测顺序,不写入`);
    }
  }
  // Fable B-1′ fix (2026-09-15, guards/audits/FABLE-2026-09-15-b1prime-confirmed.md item 3), comment
  // corrected 2026-09-15 round 2 (Opus O-8, guards/audits/OPUS-2026-09-15-repair-review.md), corrected
  // AGAIN 2026-09-15 round 3 (Opus round-2 review "R-1"): two edits whose [offset, offset+deleteLen)
  // ranges TRULY overlap (at least one has deleteLen>0 reaching into the other's start) would silently
  // mangle bytes — assert pairwise non-overlap BEFORE building the buffer. This is deliberately
  // independent of the per-edit oldBytesBase64 check in cmdApply (byte-content-based, silent for
  // deleteLen=0 inserts since empty old bytes "match" at any offset).
  // CORRECTION to the ORIGINAL comment here: this strict `>` does NOT reject two deleteLen=0 pure
  // inserts that share the EXACT SAME offset — and it must not, because the real 291-edit C1 plan
  // legitimately produces exactly that shape 5 times (e.g. a ④cross-file-decided mutual-link line and
  // a ⑤hook-from-index-rest Hook line both anchored at the same title line's lineEnd byte). Two same-
  // offset deleteLen=0 inserts are NOT a conflict — they concatenate deterministically in `list`'s
  // KIND_ORDER-sorted order (fixed, independent of both the incoming array's order and of whatever
  // order computePlan/buildEditOps happened to construct them in — the ROUND-2 CORRECTION: the
  // original round-2 comment here claimed this was "the fixed group-then-file construction order
  // buildEditOps produced them in", which is exactly the array-order dependency spec §9② forbids and
  // that OPUS-2026-09-15-round2-review.md's R-1 demonstrated was silently wrong). What this assertion
  // DOES catch is any edit whose deleteLen reaches PAST another edit's start offset — a genuine
  // byte-range collision, same-offset or not.
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1], cur = list[i];
    if (prev.offset + prev.deleteLen > cur.offset) {
      throw new core.PmmCoreError(`sortAndValidateEdits: 编辑区间重叠(${prev.file || ''}@${prev.offset}+${prev.deleteLen} 与 @${cur.offset});拒绝写入`);
    }
  }
  return list;
}

// Single canonical byte-range patcher, shared by --apply and by --verify's A2 replay so both use the
// EXACT same algorithm (no risk of a second, independently-written reconstruction disagreeing on tie
// -breaking order when two edits share the same offset). Sort ascending by (offset, kindRank) and
// build forward in one pass; never a decode→string→encode round trip.
function applyEditsToBuffer(beforeBuf, edits) {
  const list = sortAndValidateEdits(edits);
  const parts = [];
  let cursor = 0;
  for (const e of list) {
    parts.push(beforeBuf.slice(cursor, e.offset));
    parts.push(Buffer.from(e.insertText, 'utf8'));
    cursor = e.offset + e.deleteLen;
  }
  parts.push(beforeBuf.slice(cursor));
  return Buffer.concat(parts);
}

// R7-1 fix (2026-09-15 round 7, guards/audits/OPUS-2026-09-15-round6-review.md 转 GO 最小集 #1):
// given ONE file's edits already sorted+validated by sortAndValidateEdits, return each edit's
// predicted byte position in the AFTER buffer — computed by pure arithmetic over the edit list itself,
// with NO before-buffer bytes needed: the identical cumulative-shift bookkeeping applyEditsToBuffer
// performs while it walks `beforeBuf` and builds `parts` (edit i's insertText starts at
// `beforeBuf.slice(cursor, e.offset)`'s length, which is exactly `e.offset` plus the net length change
// of every earlier edit in the sorted list — see the `cursor = e.offset + e.deleteLen` bookkeeping
// above). This lets findEditsNotReflectedInSnap ask "if these edits had really been applied to SOME
// before-buffer, where would edit i's insertText land in the result" without ever needing that
// before-buffer to exist.
function computeAfterPositions(sortedEdits) {
  let delta = 0;
  const out = [];
  for (const e of sortedEdits) {
    const insertBuf = Buffer.from(e.insertText || '', 'utf8');
    out.push({ edit: e, afterOffset: e.offset + delta, insertBuf });
    delta += insertBuf.length - (e.deleteLen || 0);
  }
  return out;
}

// R7-1 fix (2026-09-15 round 7, guards/audits/OPUS-2026-09-15-round6-review.md HIGH-1, confirmed by
// scratchpad/verify-r7-1-v2.cjs — the round-6 "V2" repro): cmdApply's idempotency short-circuit used to
// trust `fp === plan.contentFingerprintAfter` (one whole-snapshot hash equality against an attacker/
// upstream-controlled JSON number) corroborated ONLY by a NEGATIVE signal — "no deleteLen>0 edit's old
// bytes are still present at its offset" — which is VACUOUSLY true for every deleteLen=0 pure insertion
// (empty oldBytesBase64 "matches" at any offset) and was therefore already true for 280 of the real
// plan's 291 edits before any tampering at all. Compressing the remaining 11 deleteLen>0 edits into
// pure insertions (V2) silences that negative check completely while --dir stays byte-for-byte
// unmigrated — the short-circuit's own success message admits it: "291 处纯插入编辑无法用旧字节独立
// 核验,依赖前述整份指纹比对与 plan 自洽性校验" — i.e. it had no positive evidence at all for that
// subset, only the absence of a contradiction.
//
// This closes the gap with an actual POSITIVE requirement: for every edit whose insertText is
// non-empty (every ①②③④⑤⑦⑬-kind edit buildEditOps ever produces has one — see buildEditOps above,
// none of the 7 producing kinds ever emits an empty insertText), the bytes it claims to have inserted
// must ACTUALLY be present, at the position computeAfterPositions predicts, in the CURRENT --dir
// content. That position is derived purely from the edits list's own offsets/lengths — no before-
// buffer needed — so it works identically whether --dir is genuinely already-migrated (the bytes ARE
// there; a real idempotent rerun is unaffected — step 2's "幂等:二次 --apply" self-test in
// pmm-migrate-v3.sh already exercises this path end to end, still green after this fix) or still
// pristine (the bytes are NOT there; V2 and any insertion-shaped variant of it is rejected — see
// IDEMFP-V2 in pmm-migrate-v3.sh). This is complementary to, not a replacement for, the pre-existing old-bytes-
// ABSENT loop in cmdApply below, which remains the only positive-ish signal for a hypothetical pure
// DELETION (deleteLen>0, insertText='') — a shape buildEditOps never actually emits today, but nothing
// stops a hand-edited plan from claiming one, and an empty expected string trivially "matches" any
// position, the mirror-image blind spot.
//
// CORRECTION (2026-09-15 round 8, guards/audits/OPUS-2026-09-15-round8-review.md HIGH-1): the sentence
// that used to end this comment — "Between the two checks, every edit shape has at least one side that
// can actually fail" — was FALSE, and is the fourth instance in one day of this file's own comments
// overstating what the code actually guarantees. `deleteLen` falsy (0/null/undefined/'') AND
// `insertText` falsy/empty/absent on the SAME edit fires neither this check nor the old-bytes-absence
// loop — proven against the real 291-edit plan by IDEMFP-V5 (missing keys, no forged value needed) and
// IDEMFP-V6/V7 (explicit null / empty-array insertText) in pmm-migrate-v3.sh. These two checks were
// NEVER individually sufficient for full coverage; coverage is enforced by a separate, explicit
// invariant in cmdApply run immediately after both of them (search for `uncoveredEdits`) — not by any
// claim about these two checks' shapes being mutually exhaustive.
function findEditsNotReflectedInSnap(snap, edits) {
  // R12-2 fix (2026-09-16 round 12, guards/audits/CODEX-2026-09-16-round11-review.md MEDIUM-1 companion
  // finding, this round's own confirmed PROTO repro): this call site is reached from cmdApply's
  // idempotency short-circuit with RAW plan.edits, downstream of validateEditRecords (which now rejects
  // any `file` not in FINGERPRINT_FILES_SET, closing this specific vector) — but `Object.create(null)`
  // is cheap, removes an entire defect CLASS (not just this one instance), and does not depend on the
  // front gate staying correct forever. Before the front gate covered `file`, `file: "__proto__"` on a
  // deleteLen=0 edit made `byFile[e.file]` read the object's OWN PROTOTYPE (a plain `{}` literal's
  // `__proto__` is Object.prototype, not a regular own property) — truthy, so the `if (!byFile[e.file])`
  // initialization was skipped, and `byFile[e.file].push(e)` then called `.push` on Object.prototype
  // itself, an uncaught TypeError (rc=1, stack trace, no diagnostic) — the round-11 audit's "PROTO" row.
  const byFile = Object.create(null);
  for (const e of edits) { if (!byFile[e.file]) byFile[e.file] = []; byFile[e.file].push(e); }
  const failures = [];
  for (const file of Object.keys(byFile)) {
    const info = snap.files[file];
    if (!info || info.missing) {
      failures.push(`${file}: 文件缺失(该文件本应在已迁移语料中存在,但此编辑列表期待对它有编辑)`);
      continue;
    }
    let sorted;
    try { sorted = sortAndValidateEdits(byFile[file]); }
    catch (e) { failures.push(`${file}: 排序/校验该文件的编辑列表时异常(${e.message || e})`); continue; }
    for (const { edit: e, afterOffset, insertBuf } of computeAfterPositions(sorted)) {
      if (insertBuf.length === 0) continue; // pure deletion shape: nothing to look for (see old-bytes loop)
      const actual = info.raw.slice(afterOffset, afterOffset + insertBuf.length);
      if (!actual.equals(insertBuf)) {
        failures.push(`${file}@${e.offset}(预期落点=${afterOffset},len=${insertBuf.length},kind=${e.kind || (e.action && e.action.kind)}): 该编辑应插入的新字节在 --dir 当前内容的预期位置未找到`);
      }
    }
  }
  return failures;
}

// Roll `files` back to the pre-write bytes captured in `beforeSnap` (Opus O-2/O-3 fix, 2026-09-15
// round 2 — guards/audits/OPUS-2026-09-15-repair-review.md): shared by BOTH failure paths that need
// to undo a partially-applied --dir — a write-time exception mid-loop (O-2) and a post-write
// fingerprint mismatch (the pre-existing path, now hardened for O-3). Previously only the latter even
// attempted a restore, and that restore was a bare fs.writeFileSync loop with no try/catch (one
// failing file left an UNCAUGHT exception and abandoned every remaining file) and no post-restore
// verification. Never silently declare success here: return {ok, restored, failed} and require
// callers to check `ok` — and ideally re-fingerprint the dir — before claiming "no half-write state".
function restoreFiles(dir, beforeSnap, files) {
  const restored = [];
  const failed = [];
  for (const f of files) {
    try {
      const info = beforeSnap.files[f];
      if (!info || info.missing) { failed.push({ file: f, error: '没有可用的写入前快照可还原' }); continue; }
      const restoreBuf = info.hadBOM ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), info.raw]) : info.raw;
      fs.writeFileSync(dir.replace(/\\/g, '/') + '/' + f, restoreBuf);
      restored.push(f);
    } catch (e) {
      failed.push({ file: f, error: e.message || String(e) });
    }
  }
  return { ok: failed.length === 0, restored, failed };
}

function applyEditsToDir(dir, snap, edits) {
  // R12-2 companion hardening (2026-09-16 round 12): only reached from cmdApply's real-write path, after
  // validateEditRecords, the independent-rebuild multiset comparison, AND the pre-write semantic gate
  // have all already passed for this exact `edits` array — so `__proto__` cannot reach here today. Same
  // one-line Object.create(null) hardening as the other three `byFile`/`byFileBuf` sites in this file,
  // applied uniformly per the round-12 brief's "scan the whole apply path, not just the named line".
  const byFile = Object.create(null);
  for (const e of edits) { if (!byFile[e.file]) byFile[e.file] = []; byFile[e.file].push(e); }
  const filesWritten = [];
  for (const [file, list] of Object.entries(byFile)) {
    try {
      const buf = applyEditsToBuffer(Buffer.from(snap.files[file].raw), list);
      const outBuf = snap.files[file].hadBOM ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]) : buf;
      fs.writeFileSync(dir.replace(/\\/g, '/') + '/' + file, outBuf);
      filesWritten.push(file);
    } catch (e) {
      // Opus O-2 fix (2026-09-15 round 2): this used to propagate straight to cmdApply's catch block,
      // which printed a message CLAIMING "不留下半写状态" while doing NOTHING to make that true — any
      // file already written earlier in THIS loop (`filesWritten`) stayed on disk, half-migrated. Roll
      // those back here, where `filesWritten` is still in scope, and attach the outcome to the thrown
      // error so the caller reports the TRUE state — never silently assert a clean rollback happened.
      const rollback = restoreFiles(dir, snap, filesWritten);
      const err = new core.PmmCoreError(`写入 ${file} 时异常: ${e.message || e}`);
      err.filesWrittenBeforeFailure = filesWritten.slice();
      err.rollback = rollback;
      throw err;
    }
  }
  return { filesWritten };
}

// ── --verify: assertions A1–A22 ────────────────────────────────────────────────────────────────
function cmdVerify(args) {
  const stage = argVal(args, '--stage', 'c0');
  const beforeDir = argVal(args, '--before');
  const afterDir = argVal(args, '--after');
  const planPath = argVal(args, '--plan');
  if (!beforeDir || !afterDir) { console.error('用法: --verify --stage c0|c1 --before <dir> --after <dir> [--plan <file>]'); process.exit(2); }
  const results = require('./pmm-verify-assertions.cjs').runAll({ core, beforeDir, afterDir, planPath, stage });
  let anyFail = false;
  for (const r of results) {
    const label = r.status === 'PASS' ? '✅' : r.status === 'NOT-RUN' ? '⏭️' : '❌';
    console.log(`${label} ${r.id} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    if (r.status === 'FAIL') anyFail = true;
  }
  process.exit(anyFail ? 2 : 0);
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
// Opus H-2: verb flags (--apply / --verify) are checked BEFORE the generic --plan flag, because both
// `--apply --dir X --plan Y` and `--verify --stage c0 ... --plan Y` legitimately contain the
// substring "--plan" as an OPTION VALUE, not as the command verb. Checking `args.includes('--plan')`
// first (the pre-fix order) made `--verify ... --plan X` silently run cmdPlan instead of cmdVerify.
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--apply')) return cmdApply(args);
  if (args.includes('--verify')) return cmdVerify(args);
  if (args.includes('--pin-d1')) return cmdPinD1(args);
  if (args.includes('--plan')) return cmdPlan(args);
  console.error('用法: pmm-migrate-v3.cjs --pin-d1 [--names <D1-NAMING.md>] | --plan [--names <D1-PINNED-<oid>.json>] | --apply --dir <copy> --plan <file> | --verify --stage c0|c1 --before <dir> --after <dir> [--plan <file>]');
  process.exit(2);
}

module.exports = {
  parseD1Naming, parseLegacyIndexBullets, computePlan, buildEditOps, applyEditsToDir, applyEditsToBuffer,
  cmdPinD1, locatePinnedEntry, titleLineText, buildD1PinEntries,
  matchScore, bestMatch, scoreCandidates, fileKeyToFileName, refuseIfCanonicalMemory,
  buildFullPlan, simulateAfterSnap, titleLineSha, findEntryById, FINGERPRINT_FILES,
  // exported 2026-09-16 round 12 (R12-1/R12-3 fix, CODEX-2026-09-16-round11-review.md MEDIUM-1/LOW-2):
  // the front-gate contract check and its allowed-file-name Set, so pmm-verify-assertions.cjs's own
  // readPlan() can reuse the EXACT SAME validation --apply enforces instead of writing a second,
  // independently-maintained schema check that could silently drift from this one.
  validateEditRecords, FINGERPRINT_FILES_SET,
  // exported 2026-09-15 round 2 (Opus O-1 fix break-test): pure byte-range helpers so the self-test
  // can construct an offset shift that provably stays inside [lineStart, lineEnd) — the exact blind-
  // spot intersection the round-2 repair brief requires (guards/audits/OPUS-2026-09-15-repair-review.md).
  findLineStartByTitleLineNo, lineEndByte, restoreFiles,
  // exported 2026-09-15 round 3 (R-1/R-2 fix, OPUS-2026-09-15-round2-review.md): the same-offset
  // insertion ordering contract, and the single-source-of-truth list of edit-producing kinds it also
  // serves as the coverage-completeness reference for (pmm-verify-assertions.cjs's checkA2Semantic).
  KIND_ORDER, PRODUCING_KINDS, kindRank,
  // exported 2026-09-15 round 7 (R7-1 fix, OPUS-2026-09-15-round6-review.md HIGH-1): the shared
  // sort/validate helper and the new positive-evidence idempotency check, so the self-test can drive
  // them directly (in addition to the black-box CLI repro in scratchpad/verify-r7-1-v2.cjs).
  sortAndValidateEdits, computeAfterPositions, findEditsNotReflectedInSnap,
  // exported 2026-09-15 round 7 (R7-5 fix, OPUS-2026-09-15-round6-review.md LOW-2): the literal
  // strings buildEditOps emits for ②/④'s second edit, shared with pmm-verify-assertions.cjs so its
  // independent structural re-check can't silently drift onto a different (or a matching-but-wrong)
  // value than what this file actually writes.
  USER_RATIFIED_BRACKET, CROSS_FILE_LINK_PREFIX,
  // exported 2026-09-24(主脑裁定,W4-E2):pmm-index-emit.cjs 的 loadPlanForTreeOid() 是 W4-E
  // (7138cc7)前的 M2 特性,PLAN/D1-PINNED 文件名与新鲜度判据已改用语料内容指纹(见本文件
  // computeCorpusFingerprint()/corpusFingerprintKey() 头部注释),但该消费者仍只按 treeOid 查找,
  // 真根按新 key 生成 PLAN 后会一路退化到 no-plan-for-treeOid。导出这两个既有函数供其只读复用,
  // 不重复实现指纹算法——函数体本身未改一行。
  computeCorpusFingerprint, corpusFingerprintKey,
};
if (require.main === module) main();
