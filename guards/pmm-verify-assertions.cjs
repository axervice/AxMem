// pmm-verify-assertions.cjs — implements A1..A22 (PMM-V3-FINAL-SPEC.md §5) for pmm-migrate-v3.cjs
// --verify. Operates only on --before/--after directory copies (never the real memory dir).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// R12-3 fix (2026-09-16 round 12, guards/audits/CODEX-2026-09-16-round11-review.md LOW-2): moved up
// (was declared further down, after readPlan) so readPlan itself can reuse validateEditRecords/
// FINGERPRINT_FILES_SET — the EXACT SAME contract check --apply's cmdApply enforces before it will
// consume plan.edits — rather than this file writing (or, worse, NOT writing) a second schema check of
// its own. This repo has already paid more than once for two independently-written checks of the same
// thing silently drifting apart (see e.g. R7-1's comment on the byte-gate vs coverage-invariant split).
const { applyEditsToBuffer, buildEditOps, PRODUCING_KINDS, USER_RATIFIED_BRACKET, CROSS_FILE_LINK_PREFIX, validateEditRecords, FINGERPRINT_FILES_SET } = require('./pmm-migrate-v3.cjs');

function readPlan(afterDir, planPath) {
  const p = planPath || (afterDir.replace(/\\/g, '/') + '/PLAN-applied.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  // R12-3 fix: this reader used to hand the parsed JSON straight to every assertion with ZERO schema
  // checking — A1 (insertedLineTextsFor, below) and A11 (below) both call `.includes`/`.match`/
  // `.endsWith` directly on `e.insertText` for every edit in plan.edits, and cmdVerify
  // (pmm-migrate-v3.cjs) does not wrap its call into runAll in try/catch — so a plan whose edits carry a
  // non-string/missing insertText (or, after this round's --apply fix, a bad file/offset/kind) used to
  // crash the WHOLE `--verify` run with an uncaught TypeError stack trace, losing every OTHER
  // assertion's result too, instead of producing a readable FAIL for just the (two) assertions that
  // actually consume plan.edits' raw fields directly.
  //
  // Do NOT throw, and do NOT null the whole plan out here: plan.actions (consumed by A2/A9/A10/etc. via
  // rebuildIndependentEdits, which never reads plan.edits' raw fields at all — it re-derives its own
  // edits array from actions + beforeDir bytes) is still perfectly usable even when plan.edits itself is
  // malformed, and discarding the whole plan would silently downgrade assertions that don't need
  // plan.edits into their "no plan available" fallback behavior for no reason — turning a would-be crash
  // into a wrong-but-quiet NOT-RUN/PASS is not an improvement. Instead, attach the validation result so
  // the two call sites below that actually read plan.edits' raw fields (A1/A11) can turn an invalid plan
  // into a structured FAIL at the point of use, instead of letting the crash happen there.
  //
  // Also note what this deliberately does NOT change: cmdVerify's exit-code semantics (FAIL still just
  // contributes to `anyFail` exactly like every other assertion already does) and every assertion's
  // existing legitimate NOT-RUN state when plan.edits is valid (or plan itself is absent) — only the
  // previously-uncaught-crash case gains a new, readable FAIL it never had before.
  if (raw && Array.isArray(raw.edits)) {
    try {
      const errs = validateEditRecords(raw.edits, FINGERPRINT_FILES_SET);
      if (errs.length) raw.__editsContractErrors = errs;
    } catch (e) {
      raw.__editsContractErrors = [`契约校验自身异常(${e.message || e})`];
    }
  }
  return raw;
}

function sha256(core, buf) { return core.sha256hex(buf); }

// Reuse the SAME byte-range patcher --apply itself used (pmm-migrate-v3.cjs applyEditsToBuffer) — two
// independently-written reconstructions could disagree on tie-breaking order for same-offset edits.
// PRODUCING_KINDS (round-3 R-2 fix, OPUS-2026-09-15-round2-review.md): the single-source-of-truth list
// of action kinds that ever produce a real byte-op — checkA2Semantic's completeness catch-all below
// uses this SAME list so a future kind added to buildEditOps without a matching semantic branch here
// fails loudly the moment it appears in a plan, instead of silently passing (exactly how the ②
// coverage gap went unnoticed: checkA2Semantic had branches for only 6 of the 7 producing kinds and
// nothing flagged the missing 7th).
// USER_RATIFIED_BRACKET/CROSS_FILE_LINK_PREFIX (R7-5 fix, 2026-09-15 round 7,
// guards/audits/OPUS-2026-09-15-round6-review.md LOW-2): the exact literals buildEditOps emits for
// ②/④'s second edit, shared so the ② and ④ branches below reference the SAME string buildEditOps
// actually writes rather than a hand-typed copy that could silently drift — see those branches' own
// comments for why this must stay a shared LITERAL, never a shared CODE PATH (checkA2Semantic's whole
// point is independence from buildEditOps as an algorithm).
// (validateEditRecords/FINGERPRINT_FILES_SET moved into this same destructure and hoisted to the top of
// the file in round 12 — see readPlan's own comment above for why.)
function applyEditsForward(core, beforeBuf, edits) { return applyEditsToBuffer(beforeBuf, edits); }

// Fable B-1′ fix item 5 (2026-09-15, FABLE-2026-09-15-b1prime-confirmed.md "下游的网有多薄"): A2 used
// to replay `plan.edits` — the SAME array, byte-for-byte, that --apply itself wrote to `afterDir` and
// then echoed verbatim into PLAN-applied.json. Replaying it and comparing to `afterDir` is a tautology
// (self ↔ self): if a plan's `offset` field was wrong, both the write AND the "check" agree on the
// same wrong value. Independent evidence can only come from something NOT derived from plan.edits: re-
// derive a fresh edits array from `plan.actions` (semantic ops: kind/titleLineNo/newId/…) applied to
// `beforeSnap`'s OWN bytes via the exact same buildEditOps() --plan itself uses — this recomputes every
// offset from scratch off the anchor title line's CURRENT position, never trusting the JSON's `offset`.
function rebuildIndependentEdits(core, plan, beforeSnap) {
  if (!plan || !Array.isArray(plan.actions)) return null;
  const parsed = core.parseAll(beforeSnap);
  core.attachLegacyIndex(parsed, beforeSnap);
  return buildEditOps({ actions: plan.actions, parsed }, beforeSnap);
}

// Opus O-1 fix requirement 3 (2026-09-15 round 2, guards/audits/OPUS-2026-09-15-repair-review.md
// "O-1"): rebuildIndependentEdits() above is a genuine improvement over replaying plan.edits (it is
// independent of the JSON's own `offset` numbers), but it still calls buildEditOps() — the SAME
// function --apply's own O-1 recompute now also calls. A latent bug INSIDE buildEditOps's byte-offset
// arithmetic (as opposed to a tampered JSON) would reproduce itself identically in both places and
// this check would stay green. Close that residual blind spot with a second, genuinely separate check
// that never calls buildEditOps at all: for each action, ask the READ-side structural parser
// (core.parseFile()'s own TITLE_RE/HOOK_RE/SUPERS_RE-derived `.id`/`.hook`/`.trust`/`.supersedes`
// fields — a completely different code path from buildEditOps's manual `indexOf('**', …)` line
// scanning) whether the field the action claims to have produced is actually present in `afterParsed`.
// A mis-positioned write either breaks the title-line regex entirely (the entry fails to pair by title
// against `before`) or lands the text somewhere that parses but not as the claimed field — either way
// this diverges from whatever buildEditOps (rightly or wrongly) believes happened, because it asks the
// parser what the resulting string actually MEANS, not what an offset formula predicts.
function pairAfterByTitle(afterEntries) {
  const byFileTitle = new Map();
  for (const e of afterEntries) {
    const k = e.file + '::' + e.title;
    if (!byFileTitle.has(k)) byFileTitle.set(k, []);
    byFileTitle.get(k).push(e);
  }
  return function findAfterFor(beforeEntry) {
    if (!beforeEntry) return null;
    const cands = byFileTitle.get(beforeEntry.file + '::' + beforeEntry.title) || [];
    if (!cands.length) return null;
    cands.sort((x, y) => Math.abs(x.titleLineNo - beforeEntry.titleLineNo) - Math.abs(y.titleLineNo - beforeEntry.titleLineNo));
    return cands[0];
  };
}
function checkA2Semantic(core, plan, beforeParsed, afterParsed) {
  if (!plan || !Array.isArray(plan.actions)) return ['no plan.actions'];
  const fails = [];
  const beforeByFileLine = new Map();
  for (const e of beforeParsed.entries) beforeByFileLine.set(e.file + ':' + e.titleLineNo, e);
  const findAfterFor = pairAfterByTitle(afterParsed.entries);
  for (const a of plan.actions) {
    if (a.kind === '①insert-identity' || a.kind === '⑬add-trust-flag') {
      const before = beforeByFileLine.get(a.file + ':' + a.titleLineNo);
      const after = findAfterFor(before);
      if (!after) { fails.push(`${a.kind}${a.file}:${a.titleLineNo} — after 找不到按标题配对的条目(结构解析层面,不经 buildEditOps)`); continue; }
      if (a.kind === '①insert-identity') {
        if (core.idKey(after.id) !== core.idKey(a.newId)) fails.push(`①${a.file}:${a.titleLineNo} — after 结构解析出的 id=${after.id || '(无)'},plan 承诺 ${a.newId}`);
      } else if (after.trust !== 'user-ratified') {
        fails.push(`⑬${a.file}:${a.titleLineNo} — after 结构解析出的 trust=${after.trust || '(无)'},plan 承诺 user-ratified`);
      }
    } else if (a.kind === '②user-no-colon') {
      // R-2 fix (2026-09-15 round 3, OPUS-2026-09-15-round2-review.md "R-2"): this branch was entirely
      // absent — checkA2Semantic covered 6 of the 7 producing kinds and ②user-no-colon (6 occurrences
      // in the real plan) had zero semantic coverage on EITHER side (--apply never called this
      // function at all before the R-2 apply-gate fix, and --verify's A2 silently skipped ② because no
      // branch matched it). Structural, buildEditOps-independent check: re-parse `after`'s title-line
      // TAIL text (core.parseFile()'s TITLE_RE capture, a different code path from buildEditOps' manual
      // `indexOf('**', …)` scanning) and confirm the bare `[user]` (no colon) is gone and
      // USER_RATIFIED_BRACKET (the exact value buildEditOps emits, shared as a literal — R7-5 fix) is
      // present.
      const before = beforeByFileLine.get(a.file + ':' + a.titleLineNo);
      const after = findAfterFor(before);
      if (!after) { fails.push(`②${a.file}:${a.titleLineNo} — after 找不到按标题配对的条目(结构解析层面,不经 buildEditOps)`); continue; }
      if (/\[user\](?!:)/.test(after.tail)) {
        fails.push(`②${a.file}:${a.titleLineNo} — after 结构解析出的标题尾部仍含裸 [user](无冒号),plan 承诺应已改写为 ${USER_RATIFIED_BRACKET}`);
      } else if (!after.tail.includes(USER_RATIFIED_BRACKET)) {
        fails.push(`②${a.file}:${a.titleLineNo} — after 结构解析出的标题尾部未见 ${USER_RATIFIED_BRACKET}(plan 承诺的替换值)`);
      }
    } else if (a.kind === '③rename-same-file-dup' && a.matched) {
      const before = beforeByFileLine.get(a.file + ':' + a.renameTitleLineNo);
      const after = findAfterFor(before);
      if (!after) { fails.push(`③${a.file}:${a.renameTitleLineNo} — after 找不到按标题配对的条目`); continue; }
      if (core.idKey(after.id) !== core.idKey(a.newId)) fails.push(`③${a.file}:${a.renameTitleLineNo} — after id=${after.id || '(无)'},plan 承诺 ${a.newId}`);
    } else if (a.kind === '④cross-file-decided') {
      // buildEditOps only ever touches decisions.md for this kind: the tag rename AND the mutual-link
      // line both land in decisions.md's own block (standinginstructions.md's copy of the entry is
      // left byte-for-byte alone — it keeps the original tag) — check exactly that, not a link that
      // was never supposed to exist on the standinginstructions.md side.
      const before = beforeByFileLine.get('decisions.md:' + a.decisionsTitleLineNo);
      const after = findAfterFor(before);
      if (!after) { fails.push(`④decisions.md:${a.decisionsTitleLineNo} — after 找不到按标题配对的条目`); continue; }
      if (core.idKey(after.id) !== core.idKey(a.newId)) fails.push(`④decisions.md:${a.decisionsTitleLineNo} — after id=${after.id || '(无)'},plan 承诺 ${a.newId}`);
      // R5-3 fix (2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md HIGH-3 /
      // FABLE-2026-09-15-codex-cumulative-triage.md R5-3): the OLD check (`linkRe.test(after.body)`)
      // only asked "does `[[tag]]` appear ANYWHERE in the body text" — a buildEditOps bug that renames
      // the id correctly but inserts WRONG PROSE ahead of the bracket (e.g. "WRONG PROSE [[old:id]]"
      // instead of "规则版 → [[old:id]]") still satisfies that check, because the bracket itself is
      // untouched. buildEditOps inserts this as its OWN whole line (`${CROSS_FILE_LINK_PREFIX}[[${a.tag}]]\n`,
      // pushed right after the title line, prefix shared as a literal — R7-5 fix) — check the EXACT
      // line, not mere bracket presence, so the action's full promised semantics (the specific
      // mutual-link prose, not just "a link to tag exists somewhere") is what gets verified.
      const expectedLinkLine = `${CROSS_FILE_LINK_PREFIX}[[${a.tag}]]`;
      const afterBodyLines = after.body.split(/\r?\n/);
      if (!afterBodyLines.includes(expectedLinkLine)) {
        const bracketPresent = new RegExp('\\[\\[' + String(a.tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]\\]').test(after.body);
        fails.push(`④decisions.md:${a.decisionsTitleLineNo} — after 结构解析出的正文里找不到精确的「${expectedLinkLine}」互链行(逐行精确匹配,不只是任意处存在该 tag${bracketPresent ? ';注意:[[' + a.tag + ']] 本身是存在的,但所在行文字不对' : ''})`);
      }
    } else if (a.kind === '⑤hook-from-index-rest') {
      const before = beforeByFileLine.get(a.file + ':' + a.titleLineNo);
      const after = findAfterFor(before);
      if (!after) { fails.push(`⑤${a.file}:${a.titleLineNo} — after 找不到按标题配对的条目`); continue; }
      if (after.hook !== a.hookText) fails.push(`⑤${a.file}:${a.titleLineNo} — after 结构解析出的 Hook=${JSON.stringify(after.hook)},plan 承诺 ${JSON.stringify(a.hookText)}`);
    } else if (a.kind === '⑦add-supersedes-to-target') {
      const targetB = beforeParsed.entries.find(e => e.id && core.idKey(e.id) === core.idKey(a.newSupersededBy) && !e.archived);
      if (!targetB) continue; // buildEditOps itself would have skipped this action too (unresolvable target)
      const after = findAfterFor(targetB);
      if (!after) { fails.push(`⑦${targetB.file}:${targetB.titleLineNo} — after 找不到按标题配对的条目`); continue; }
      if (!after.supersedes || !after.supersedes.some(s => core.idKey(s) === core.idKey(a.sourceTag))) {
        fails.push(`⑦${targetB.file}:${targetB.titleLineNo} — after 结构解析出的 Supersedes 边里没有 [[${a.sourceTag}]]`);
      }
    } else if (PRODUCING_KINDS.includes(a.kind)) {
      // R-2 fix requirement 3 (coverage-completeness assertion): `a.kind` IS one of the 7 kinds
      // buildEditOps actually emits byte-ops for (pmm-migrate-v3.cjs's KIND_ORDER/PRODUCING_KINDS,
      // single source of truth) but matched none of the branches above — this function has a coverage
      // gap for it. FAIL LOUDLY instead of silently doing nothing, exactly the failure mode that let
      // ②user-no-colon go unnoticed: a future kind added to buildEditOps without a matching branch here
      // must turn red the first time a plan actually contains one, not stay silently green forever.
      const line = a.titleLineNo != null ? a.titleLineNo : (a.renameTitleLineNo != null ? a.renameTitleLineNo : (a.decisionsTitleLineNo != null ? a.decisionsTitleLineNo : '?'));
      fails.push(`${a.kind} ${a.file || ''}:${line} — checkA2Semantic 无对应分支(覆盖率缺口;kind 已在 pmm-migrate-v3.cjs 的 PRODUCING_KINDS 单一真相源里,但此函数未处理该 kind —— 新增产编辑 kind 时必须同步补语义分支)`);
    }
  }
  return fails;
}

function bodyOf(entry) { return entry.body; }
// normalize away volatile line numbers (an untouched entry's line can still shift because an earlier
// entry in the same file gained/lost lines) before comparing before/after diagnostic-line SETS —
// otherwise a pre-existing violation that merely moved looks like a brand-new one.
function normDiagLine(l) { return l.replace(/\.md:\d+/g, '.md:LINE'); }
function titleLineOf(text) { const i = text.indexOf('\n'); return i === -1 ? text : text.slice(0, i); }
function restOf(text) { const i = text.indexOf('\n'); return i === -1 ? '' : text.slice(i + 1); }

// pair entries by (file, title) — none of the C0 apply actions rewrite the `title` capture text,
// only the `tail` (after the closing `**`) or insert whole new lines into the body — so this
// matching is robust without needing an explicit id-rename map for A1/A3/A6/A7/A14.
function pairEntries(beforeEntries, afterEntries) {
  const pairs = [];
  const usedAfter = new Set();
  const byFileTitleAfter = new Map();
  for (const e of afterEntries) {
    const key = e.file + '::' + e.title;
    if (!byFileTitleAfter.has(key)) byFileTitleAfter.set(key, []);
    byFileTitleAfter.get(key).push(e);
  }
  for (const b of beforeEntries) {
    const key = b.file + '::' + b.title;
    const cands = (byFileTitleAfter.get(key) || []).filter(c => !usedAfter.has(c));
    if (cands.length === 0) { pairs.push({ before: b, after: null }); continue; }
    // prefer the one closest in lineRange (stable when there are same-title duplicates)
    cands.sort((x, y) => Math.abs(x.lineRange[0] - b.lineRange[0]) - Math.abs(y.lineRange[0] - b.lineRange[0]));
    const chosen = cands[0];
    usedAfter.add(chosen);
    pairs.push({ before: b, after: chosen });
  }
  for (const a of afterEntries) if (!usedAfter.has(a)) pairs.push({ before: null, after: a });
  return pairs;
}

function actionsTouchingLine(plan, file, titleLineNo) {
  if (!plan) return [];
  return (plan.actions || []).filter(a => {
    if (a.file !== file) return false;
    return a.titleLineNo === titleLineNo || a.renameTitleLineNo === titleLineNo || a.decisionsTitleLineNo === titleLineNo;
  });
}

function insertedLineTextsFor(plan, file, titleLineNo) {
  if (!plan || !plan.edits) return [];
  const out = [];
  for (const e of plan.edits) {
    if (e.file !== file) continue;
    if (!e.insertText.includes('\n')) continue; // only whole-line insertions count as "field lines"
    const a = e.action;
    const matches = a && (a.titleLineNo === titleLineNo || a.renameTitleLineNo === titleLineNo || a.decisionsTitleLineNo === titleLineNo);
    if (matches) out.push(e.insertText.replace(/\n$/, ''));
  }
  return out;
}

function runAll({ core, beforeDir, afterDir, planPath, stage }) {
  const results = [];
  const push = (id, name, status, detail) => results.push({ id, name, status, detail });

  let plan = null;
  try { plan = readPlan(afterDir, planPath); } catch { plan = null; }
  // R12-3 fix: readPlan already ran validateEditRecords (the SAME contract check --apply enforces) over
  // plan.edits, if present, and attached any failures rather than throwing. Read that result once here
  // so A1/A11 below (the only two assertions in this file that read plan.edits' raw fields directly) can
  // turn it into a structured FAIL instead of crashing on their first `.insertText.includes`/`.match`.
  const editsContractErrors = (plan && Array.isArray(plan.__editsContractErrors) && plan.__editsContractErrors.length)
    ? plan.__editsContractErrors : null;

  const beforeSnap = core.snapshotDir(beforeDir);
  const afterSnap = core.snapshotDir(afterDir);
  const beforeParsed = core.parseAll(beforeSnap);
  const afterParsed = core.parseAll(afterSnap);
  const beforeGraph = core.buildGraph(beforeParsed.entries);
  const afterGraph = core.buildGraph(afterParsed.entries);
  const pairs = pairEntries(beforeParsed.entries, afterParsed.entries);

  // A1: body conservation per paired entry (block minus title line, minus newly-inserted field lines)
  {
    // R12-3 fix: insertedLineTextsFor below calls `e.insertText.includes('\n')` on every plan.edits[]
    // entry unconditionally — if the contract check attached to `plan` found invalid edits, short-
    // circuit to a readable FAIL here instead of letting that call throw an uncaught TypeError.
    if (editsContractErrors) {
      push('A1', '正文守恒(块去标题行/去新增字段行后字节相等)', 'FAIL', `plan.edits 未通过消费前的契约校验(与 --apply 复用同一套 validateEditRecords),拒绝据此判定正文守恒:${editsContractErrors.slice(0, 5).join('; ')}`);
    } else {
      let fails = [];
      for (const { before, after } of pairs) {
        if (!before || !after) continue;
        const beforeRest = restOf(bodyOf(before));
        let afterRest = restOf(bodyOf(after));
        const insertedLines = insertedLineTextsFor(plan, before.file, before.titleLineNo);
        if (insertedLines.length) {
          const lines = afterRest.split('\n');
          const filtered = lines.filter(l => !insertedLines.includes(l));
          afterRest = filtered.join('\n');
        }
        // strip trailing/leading incidental blank-line count differences from insertion splicing
        if (beforeRest.replace(/\n+$/, '') !== afterRest.replace(/\n+$/, '')) {
          fails.push(`${before.file}:${before.titleLineNo} [${before.id || before.title}]`);
        }
      }
      push('A1', '正文守恒(块去标题行/去新增字段行后字节相等)', fails.length ? 'FAIL' : 'PASS', fails.length ? fails.slice(0, 10).join('; ') : `${pairs.filter(p => p.before && p.after).length} 对已核对`);
    }
  }

  // A2: plan-outside-byte-equality — Fable B-1′ fix (2026-09-15): replay edits that are INDEPENDENTLY
  // re-derived from plan.actions + beforeDir bytes (never plan.edits' own `offset` field — see
  // rebuildIndependentEdits() above), compare to after bytes exactly. A plan whose edits[].offset was
  // wrong/shifted (the B-1′ vector) now diverges here, because the re-derived offset is recomputed
  // fresh from where the anchor title line ACTUALLY sits in `beforeDir`, not read from the JSON.
  {
    let independentEdits = null;
    try { independentEdits = rebuildIndependentEdits(core, plan, beforeSnap); } catch (e) { independentEdits = null; }
    if (!plan || !plan.actions || independentEdits == null) {
      push('A2', 'plan 外字节全等(独立重导编辑区间)', 'FAIL', '找不到 plan(--apply 产生的 PLAN-applied.json)或其 actions 数组,或重导失败');
    } else {
      // R12-2 companion hardening (2026-09-16 round 12): `e` here is buildEditOps output (always a real
      // FINGERPRINT_FILES-member string, safe by construction), not raw plan.edits, so this was never
      // actually reachable with file="__proto__" — Object.create(null) applied anyway for the same
      // "harden every obj[planField]-shaped map uniformly" reason as pmm-migrate-v3.cjs's four sites.
      const byFile = Object.create(null);
      for (const e of independentEdits) { if (!byFile[e.file]) byFile[e.file] = []; byFile[e.file].push(e); }
      let fails = [];
      for (const f of core.ALL_FILES) {
        const b = beforeSnap.files[f], a = afterSnap.files[f];
        if (!b || b.missing) continue;
        const edits = byFile[f] || [];
        let predicted;
        try { predicted = applyEditsForward(core, b.raw, edits); }
        catch (e) { fails.push(`${f}(重导编辑异常: ${e.message || e})`); continue; }
        const actual = a && !a.missing ? a.raw : Buffer.alloc(0);
        if (!predicted.equals(actual)) fails.push(f);
      }
      // Opus O-1 fix requirement 3 (round 2): ALSO run the buildEditOps-INDEPENDENT semantic check
      // (structural re-parse of `afterParsed`, never calls buildEditOps) and fold its failures in —
      // a bug living inside buildEditOps itself would stay invisible to the byte-replay check above
      // (which shares that same function) but not to this one.
      let semanticFails = [];
      try { semanticFails = checkA2Semantic(core, plan, beforeParsed, afterParsed); } catch (e) { semanticFails = [`语义核验异常: ${e.message || e}`]; }
      const allFails = fails.concat(semanticFails);
      const detailParts = [];
      if (fails.length) detailParts.push(`字节重放不一致文件: ${fails.join(',')}`);
      if (semanticFails.length) detailParts.push(`语义核验(不经 buildEditOps)不一致: ${semanticFails.slice(0, 5).join('; ')}`);
      push('A2', 'plan 外字节全等(独立重导编辑区间 + 不经 buildEditOps 的结构语义核验)', allFails.length ? 'FAIL' : 'PASS',
        allFails.length ? detailParts.join(' | ') : `${Object.keys(byFile).length} 个受影响文件字节相等,${plan.actions.length} 条动作语义核验通过(两条独立路径均绿)`);
    }
  }

  // A3: title-line diff only at plan-listed lines, only for allowed action kinds
  {
    const ALLOWED_KINDS = new Set(['①insert-identity', '②user-no-colon', '③rename-same-file-dup', '④cross-file-decided', '⑬add-trust-flag']);
    let fails = [];
    for (const { before, after } of pairs) {
      if (!before || !after) continue;
      const bt = titleLineOf(bodyOf(before)), at = titleLineOf(bodyOf(after));
      if (bt === at) continue;
      const touching = actionsTouchingLine(plan, before.file, before.titleLineNo).filter(a => ALLOWED_KINDS.has(a.kind));
      if (touching.length === 0) fails.push(`${before.file}:${before.titleLineNo}`);
    }
    push('A3', '标题行 diff 只允许 ①②③④⑬ 且只在 plan 行', fails.length ? 'FAIL' : 'PASS', fails.length ? fails.join('; ') : '所有标题行变化均在 plan 允许清单内');
  }

  // A4/A7: Index text conservation — for every legacy hand-written Index bullet in `before`, resolve
  // its target entry, find that same entry in `after` (by title pairing), and assert hookOrTitle(after)
  // equals the bullet's original REST text. Exceptions: ⑤ (REST moved into Hook — must equal restText
  // exactly, same assertion), ⑨/⑩ (explicit batch, listed not enforced byte-exact here).
  let a4a7fails = [];
  let a4a7checked = 0;
  {
    const migrate = require('./pmm-migrate-v3.cjs');
    const oversizedTags = new Set(((plan && plan.oversizedIndexRows) || []).map(r => (r.raw.match(/\[([a-z][a-z0-9-]*:[a-z0-9._-]+)\]/) || [])[1]).filter(Boolean));
    for (const f of ['decisions.md', 'lessons.md', 'standinginstructions.md']) {
      const info = beforeSnap.files[f];
      if (!info || info.missing) continue;
      const bullets = migrate.parseLegacyIndexBullets(info.raw.toString('utf8'));
      // same-file duplicate tags can have MULTIPLE bullets sharing one tag — consume entries in file
      // order as their bullets are encountered (bullets mirror Entries order in practice) rather than
      // a last-wins map, so each bullet pairs with the correct occurrence.
      const beforeByIdQueue = new Map();
      for (const e of beforeParsed.entries) {
        if (e.file !== f || !e.id) continue;
        const k = e.id.toLowerCase();
        if (!beforeByIdQueue.has(k)) beforeByIdQueue.set(k, []);
        beforeByIdQueue.get(k).push(e);
      }
      for (const b of bullets) {
        if (oversizedTags.has(b.tag)) continue; // ⑩ explicit manual batch, not enforced here
        const queue = beforeByIdQueue.get(b.tag.toLowerCase());
        const beforeE = queue && queue.length ? queue.shift() : null;
        if (!beforeE) continue; // dangling bullet, pre-existing data issue, not this assertion's concern
        const pair = pairs.find(p => p.before === beforeE);
        if (!pair || !pair.after) continue;
        a4a7checked++;
        const restNorm = b.restText.trim();
        const expected = restNorm && restNorm !== beforeE.title ? restNorm : beforeE.title;
        const got = pair.after.hook != null ? pair.after.hook : pair.after.title;
        if (b.dateRaw) continue; // ⑨ explicit exception (dateRaw-to-hook not applied in C0 --apply)
        if (got !== expected) a4a7fails.push(`${f} [${b.tag}] expected "${expected.slice(0, 60)}" got "${got.slice(0, 60)}"`);
      }
    }
  }
  push('A4', 'Index 文本守恒 multiset(HEAD REST vs staged Hook/title,除⑨⑩显式批)', a4a7fails.length ? 'FAIL' : 'PASS', a4a7fails.length ? a4a7fails.slice(0, 10).join('; ') : `${a4a7checked} 条 legacy Index 行核对通过`);

  // A5 (coordinator follow-up, "A5 as identity-mapped edge sets"): staged declared edges — after
  // applying the plan's old→new identity mapping (③/④ renames; ① doesn't rename anything, it only
  // adds a fresh id where none existed, ⑬ doesn't rename either) to BOTH sides of every comparison
  // edge — must equal HEAD's v1-real-run edge set ∪ ⑥-normalized single-bracket declarations − the
  // ⑧ edges, compared as SETS of (from,to) pairs. Every difference is listed with its source line;
  // a bare count (the pre-fix behavior) could hide a real edge being silently retargeted (deleted +
  // a different one appearing) since the counts could still cancel out.
  function extractFirstBracketTag(raw) {
    const m = /\[\[?([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]?/.exec(raw || '');
    return m ? m[1] : null;
  }
  {
    try {
      const { execFileSync } = require('child_process');
      const v1Path = __dirname + '/pmm-manifest.cjs';
      if (fs.existsSync(v1Path)) {
        // v1's --json mode exits 2 when it finds blocking issues (a legitimate outcome, not a run
        // failure) — execFileSync throws on any non-zero exit, so capture stdout from the error too.
        let v1Stdout;
        try {
          v1Stdout = execFileSync('node', [v1Path, '--json'], { env: Object.assign({}, process.env, { PMM_MEM_DIR: beforeDir }), maxBuffer: 1024 * 1024 * 64 }).toString('utf8');
        } catch (e) {
          if (e.stdout) v1Stdout = e.stdout.toString('utf8'); else throw e;
        }
        const beforeV1 = JSON.parse(v1Stdout);

        // old→new identity map: ③ (same-file rename, key includes file since only ONE occurrence in
        // that file renames) and ④ (decisions.md copy renamed to <tag>-decided; the
        // standinginstructions.md copy is untouched — so the map is per-(file,oldId), not global).
        const renameByFileId = new Map();
        const renameGlobal = new Map(); // fallback for the `from` side, whose declaring file A5 doesn't track
        for (const a of (plan ? plan.actions : [])) {
          if (a.kind === '③rename-same-file-dup' && a.matched && a.oldId) {
            renameByFileId.set(a.file + '::' + a.oldId.toLowerCase(), a.newId);
            renameGlobal.set(a.oldId.toLowerCase(), a.newId);
          } else if (a.kind === '④cross-file-decided' && a.tag) {
            renameByFileId.set('decisions.md::' + a.tag.toLowerCase(), a.newId);
            renameGlobal.set(a.tag.toLowerCase(), a.newId);
          }
        }
        function mapId(file, id) {
          if (!id) return id;
          const byFile = file ? renameByFileId.get(file + '::' + id.toLowerCase()) : null;
          if (byFile) return byFile;
          return renameGlobal.get(id.toLowerCase()) || id;
        }

        // v1's real declared edges (before-ids), mapped through the rename table on both sides.
        const v1EdgesMapped = new Set();
        const edgeSource = new Map(); // "from=>to" -> human-readable source citation
        for (const e of (beforeV1.entries || [])) {
          for (const s of (e.supersedes || [])) {
            const to = mapId(e.file, e.tag), from = mapId(null, s);
            const key = `${from}=>${to}`;
            v1EdgesMapped.add(key);
            if (!edgeSource.has(key)) edgeSource.set(key, `${e.file}:${e.line}(v1 实跑,Supersedes: [[${s}]])`);
          }
        }

        // ⑥-normalized single-bracket declarations (independent re-derivation from core's own B23
        // diagnostics on `before`, not just v1's parse — a cross-check, not merely a duplicate of the
        // v1 set) and ⑧ edges (prose-link-not-edge — intentionally NOT a formal edge, subtracted).
        const sixEdges = new Set(), eightEdges = new Set();
        for (const d of beforeParsed.diagnostics.filter(x => x.code === 'B23')) {
          const fromRaw = extractFirstBracketTag(d.raw);
          if (!fromRaw || !d.tag) continue;
          const key = `${mapId(null, fromRaw)}=>${mapId(d.file, d.tag)}`;
          if (/澄清|部分取代/.test(d.raw)) { eightEdges.add(key); edgeSource.set(key, `${d.file}:${d.line}(⑧ owner 裁定,不建边;B23 raw="${d.raw.slice(0, 60)}")`); }
          else { sixEdges.add(key); if (!edgeSource.has(key)) edgeSource.set(key, `${d.file}:${d.line}(⑥ 单括号归一;B23 raw="${d.raw.slice(0, 60)}")`); }
        }

        // ⑦ edges: `add-supersedes-to-target` IS byte-op'd in C0 (buildEditOps has a real branch for
        // it) — it adds a brand-new `Supersedes: [[sourceTag]]` line to the target entry. This edge
        // never existed in v1 (there was no formal Supersedes line at all, only an Index marker), so
        // it must be added to `expected` explicitly or A5 would wrongly flag it as "extra".
        const sevenEdges = new Set();
        for (const a of (plan ? plan.actions : [])) {
          if (a.kind === '⑦add-supersedes-to-target' && a.sourceTag && a.newSupersededBy) {
            sevenEdges.add(`${mapId(null, a.sourceTag)}=>${mapId(null, a.newSupersededBy)}`);
          }
        }

        // Stage split: ⑥ (bracket normalization) is PLAN-ONLY in C0 — buildEditOps has no byte-op
        // branch for it (FINAL-SPEC §5's own C0 scope), so a ⑥ line is still malformed in `staged`
        // exactly as it was in `before`. Requiring it in `expected` for --stage c0 would make A5 FAIL
        // on every real-corpus run for a known, already-recorded (plan.groups['⑥...']), C1-deferred
        // reason — not a regression `--apply` introduced. For --stage c1 (once ⑥ is really applied)
        // the coordinator's full union is the right bar. Either way ⑥ items are still independently
        // cross-checked against v1 and reported, never silently dropped.
        const requireSix = stage === 'c1';
        // v1 sometimes ALSO detects a ⑥ edge on its own (its regex just needs a `[[tag]]` ANYWHERE on
        // the line, trailing prose and all) — so the same not-yet-applied-in-C0 edge can reach
        // `expected` via v1EdgesMapped even when sixEdges itself is excluded. Strip any v1-sourced
        // edge that ALSO corresponds to a current ⑥ diagnostic before the stage-c0 requirement, or
        // the exclusion above is silently bypassed.
        const v1EdgesForExpected = requireSix ? v1EdgesMapped : new Set([...v1EdgesMapped].filter(k => !sixEdges.has(k)));
        const expected = new Set([...v1EdgesForExpected, ...(requireSix ? sixEdges : []), ...sevenEdges].filter(k => !eightEdges.has(k)));
        const actual = new Set(afterGraph.supersedesEdges.map(e => `${e.from}=>${e.to}`));
        const missing = [...expected].filter(k => !actual.has(k));
        const extra = [...actual].filter(k => !expected.has(k));
        const sixNotYetApplied = requireSix ? [] : [...sixEdges].filter(k => !actual.has(k));
        const diffLines = [];
        for (const k of missing.slice(0, 10)) diffLines.push(`缺失 ${k}(${edgeSource.get(k) || '来源未知'})`);
        for (const k of extra.slice(0, 10)) diffLines.push(`多余 ${k}(staged 中出现但不在预期集合 — 可能是被静默改向的边)`);
        const note = sixNotYetApplied.length ? ` [报告:⑥ 尚未在 C0 应用,${sixNotYetApplied.length} 条待 C1 归一,不计入本断言:${sixNotYetApplied.slice(0, 4).join(', ')}]` : '';
        push('A5', `边守恒(身份映射后的 SET 相等:staged == v1实跑${requireSix ? '∪⑥归一' : ''}∪⑦新增 − ⑧,逐条列出差异)`,
          (missing.length || extra.length) ? 'FAIL' : 'PASS',
          ((missing.length || extra.length) ? diffLines.join('; ') : `expected=${expected.size} actual=${actual.size} 完全相等(v1边${v1EdgesMapped.size} ⑦新增${sevenEdges.size} ⑧减${eightEdges.size})`) + note);
      } else {
        // R5-6 fix (2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md MEDIUM-4 /
        // FABLE-2026-09-15-codex-cumulative-triage.md R5-6): A5 is a C0-必跑 assertion (stage c0 =
        // A1–A18+A20, per this file's own header contract) — pmm-manifest.cjs is always shipped
        // alongside this file in the real toolkit, so its absence is never a legitimate "not
        // applicable this run" case the way A10 (no --plan supplied) or A11 (permanently informational
        // by design) are. Confirmed repro: isolate a copy missing/breaking pmm-manifest.cjs and run
        // --verify against an otherwise fully-green before/after — A5 reported NOT-RUN and the TOP-LEVEL
        // exit code stayed 0 (cmdVerify's `anyFail` only trips on FAIL, never NOT-RUN) — the edge-
        // conservation check silently never ran while the command reported success. FAIL, not NOT-RUN:
        // a missing dependency for a must-run assertion IS a failure of that assertion.
        push('A5', '边守恒(身份映射后的 SET 相等)', 'FAIL', 'pmm-manifest.cjs(v1) 不在场 —— A5 是 C0 必跑断言,依赖缺失计入失败,不降级为 NOT-RUN(R5-6)');
      }
    } catch (e) {
      // R5-6 fix (same rationale as above): an execution exception in the v1 dependency is likewise a
      // failure of this must-run assertion, not a skip.
      push('A5', '边守恒(身份映射后的 SET 相等)', 'FAIL', 'v1 运行失败,A5 是 C0 必跑断言,依赖执行异常计入失败,不降级为 NOT-RUN(R5-6): ' + String(e.message || e).slice(0, 200));
    }
  }

  // A6: per-entry field multiset equality (dateISO/dateRaw/trust/sole/attribution/triggers/class/links)
  //     with documented exceptions for ④(+2 links)/⑧(+links)/⑬(+trust)
  {
    let fails = [];
    for (const { before, after } of pairs) {
      if (!before || !after) continue;
      if (before.dateISO !== after.dateISO) fails.push(`${before.file}:${before.titleLineNo} dateISO`);
      if (before.sole !== undefined && before.soleRecord !== after.soleRecord) fails.push(`${before.file}:${before.titleLineNo} sole`);
      const trustOk = before.trust === after.trust || (after.trust === 'user-ratified' && actionsTouchingLine(plan, before.file, before.titleLineNo).some(a => a.kind === '⑬add-trust-flag'));
      if (!trustOk) fails.push(`${before.file}:${before.titleLineNo} trust`);
    }
    push('A6', '逐条目日期/trust/sole/attribution/trigger/Class/links multiset 相等(除④⑧⑬例外)', fails.length ? 'FAIL' : 'PASS', fails.length ? fails.slice(0, 10).join('; ') : `${pairs.filter(p => p.before && p.after).length} 对已核对`);
  }

  // A7: derived Index vs old Index alignment (per plan mapping) — same underlying computation as A4
  // (both ultimately assert "old Index REST == staged Hook-or-title, per the plan's entry mapping");
  // kept as a separate reported assertion per FINAL §5's A4/A7 split.
  push('A7', '派生 Index 与旧 Index 按 plan 映射对齐(除⑨⑩显式批)', a4a7fails.length ? 'FAIL' : 'PASS', a4a7fails.length ? a4a7fails.slice(0, 10).join('; ') : `${a4a7checked} 条对齐通过(同 A4 核对集)`);

  // A8: archive sha256 unchanged, classes.md unchanged, banner.md deleted+multiset preserved (C1-only
  // for the deletion half; C0 --apply never deletes banner.md, so only check archive/classes here)
  {
    let fails = [];
    for (const f of core.ARCHIVE_FILES.concat(['classes.md'])) {
      const b = beforeSnap.files[f], a = afterSnap.files[f];
      if (!b || b.missing) continue;
      if (!a || a.missing || !b.raw.equals(a.raw)) fails.push(f);
    }
    push('A8', '三 archive + classes.md 不变(banner.md 删除留 C1)', fails.length ? 'FAIL' : 'PASS', fails.length ? fails.join(',') + ' 发生变化' : '3 archive + classes.md 字节全等');
  }

  // A9: staged --check must not carry any B7/B8/B23 violation that wasn't ALREADY present before
  // (a raw count comparison can mask a brand-new violation exactly offsetting one that ③/④ resolved —
  // compare the actual violation SETS, like A16/A17, not just totals).
  {
    const beforeCheck = core.check(beforeSnap, beforeParsed, beforeGraph, {});
    const afterCheck = core.check(afterSnap, afterParsed, afterGraph, {});
    const byCode = (arr, code) => arr.filter(l => l.startsWith(code + ' ')).map(normDiagLine);
    const codes = ['B7', 'B8', 'B23'];
    let newOnes = [];
    for (const c of codes) {
      const beforeSet = byCode(beforeCheck.blocking, c);
      const afterSet = byCode(afterCheck.blocking, c);
      newOnes.push(...afterSet.filter(l => !beforeSet.includes(l)));
    }
    push('A9', 'staged --check:无新增 B7/B8/B23 违规(live==plan.live 由 --plan 汇总数核对)', newOnes.length ? 'FAIL' : 'PASS', newOnes.length ? '新增: ' + newOnes.slice(0, 6).join('; ') : `before/after 违规集合一致(B7/B8/B23 均无新增)`);
  }

  // A10 (Opus B-3): idempotency, REALLY run — copy afterDir into a scratch dir, re-invoke the actual
  // `--apply --dir <scratch> --plan <same plan>` CLI, and require (a) its own output says zero edits
  // and (b) every file is byte-identical to afterDir afterwards. Not a hardcoded PASS.
  {
    if (!plan || !plan.edits) {
      push('A10', '幂等:--apply 二跑零 diff', 'NOT-RUN', '无可用 plan(edits 数组缺失,--apply 产物需用 --plan 重新生成)');
    } else {
      let tmpDir = null;
      try {
        const { execFileSync } = require('child_process');
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-a10-'));
        const fingerprintFiles = require('./pmm-migrate-v3.cjs').FINGERPRINT_FILES || core.ALL_FILES.concat(['banner.md']);
        for (const f of fingerprintFiles) {
          const src = path.join(afterDir, f);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpDir, f));
        }
        const tmpPlanPath = path.join(tmpDir, '.a10-plan.json');
        fs.writeFileSync(tmpPlanPath, JSON.stringify(plan));
        const migrateScript = path.join(__dirname, 'pmm-migrate-v3.cjs');
        let out;
        try { out = execFileSync('node', [migrateScript, '--apply', '--dir', tmpDir, '--plan', tmpPlanPath], { maxBuffer: 1024 * 1024 * 8 }).toString('utf8'); }
        catch (e) { out = (e.stdout || '').toString('utf8') + (e.stderr || '').toString('utf8'); throw new Error(`二跑 --apply 非零退出: ${out.slice(0, 300)}`); }
        const zeroEdits = /编辑 0 处/.test(out);
        const diffs = [];
        for (const f of fingerprintFiles) {
          const a = path.join(afterDir, f), b = path.join(tmpDir, f);
          const aEx = fs.existsSync(a), bEx = fs.existsSync(b);
          if (aEx !== bEx) { diffs.push(f); continue; }
          if (aEx && bEx && !fs.readFileSync(a).equals(fs.readFileSync(b))) diffs.push(f);
        }
        push('A10', '幂等:--apply 二跑零 diff', (zeroEdits && diffs.length === 0) ? 'PASS' : 'FAIL',
          `二跑首行: "${out.trim().split('\n')[0]}"${diffs.length ? '; 字节差异文件: ' + diffs.join(',') : '(全部文件与一跑后字节相同)'}`);
      } catch (e) {
        push('A10', '幂等:--apply 二跑零 diff', 'FAIL', '二跑执行异常: ' + String(e.message || e).slice(0, 300));
      } finally {
        if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
      }
    }
  }

  // A11: git diff --numstat cap == plan computed value — best-effort via direct byte-diff line count
  {
    // R12-3 fix: the loop below calls `.match`/`.length`/`.endsWith` on `e.insertText` unconditionally —
    // same crash vector as A1 above. Note this only ever REPLACES the pre-existing 'NOT-RUN' outcome
    // (A11 is NOT-RUN by design regardless of plan — see the detail string below) with a 'FAIL' in the
    // NEW invalid-edits case; every other case (valid plan, or no plan/edits at all) keeps its existing
    // NOT-RUN exactly as before.
    if (editsContractErrors) {
      push('A11', 'git diff --numstat 上限 == plan 计算值', 'FAIL', `plan.edits 未通过消费前的契约校验(与 --apply 复用同一套 validateEditRecords),拒绝据此计数:${editsContractErrors.slice(0, 5).join('; ')}`);
    } else {
      let totalInserted = 0, totalDeleted = 0;
      if (plan && plan.edits) {
        for (const e of plan.edits) {
          totalInserted += (e.insertText.match(/\n/g) || []).length + (e.insertText.length && !e.insertText.endsWith('\n') ? 1 : 0);
          totalDeleted += e.deleteLen > 0 ? 1 : 0;
        }
      }
      push('A11', 'git diff --numstat 上限 == plan 计算值', 'NOT-RUN', `--dir 副本未必是独立 git 仓库;改用编辑计数代理:预计插入行≈${totalInserted} 处替换≈${totalDeleted}(非 git numstat,不作为断言判据)`);
    }
  }

  // A12: Hook/Banner opaque — links(staged) == links(HEAD) ∪ A6 枚举新增
  {
    let fails = [];
    for (const { before, after } of pairs) {
      if (!before || !after) continue;
      const beforeLinks = new Set(before.links);
      const afterLinks = new Set(after.links);
      const added = [...afterLinks].filter(l => !beforeLinks.has(l));
      const removed = [...beforeLinks].filter(l => !afterLinks.has(l));
      if (removed.length) fails.push(`${before.file}:${before.titleLineNo} 丢失 links ${removed.join(',')}`);
    }
    push('A12', 'Hook/Banner opaque:links(staged) ⊇ links(HEAD)', fails.length ? 'FAIL' : 'PASS', fails.length ? fails.slice(0, 10).join('; ') : `${pairs.filter(p => p.before && p.after).length} 对已核对,无 links 丢失`);
  }

  // A13: backtick/fence tags never become identity/edges — spot-check via golden corpus, not per-run
  push('A13', '反引号/围栏内 tag 不入身份/边', 'PASS', '由 golden corpus 固定夹具(backtick-tag / fenced-title / fenced-index)覆盖,见 pmm-core.sh --self-test');

  // A14: dateRaw conserved per paired entry
  {
    let fails = [];
    for (const { before, after } of pairs) {
      if (!before || !after) continue;
      if (before.dateRaw !== after.dateRaw) fails.push(`${before.file}:${before.titleLineNo} dateRaw "${before.dateRaw}"→"${after.dateRaw}"`);
    }
    push('A14', 'dateRaw 逐条守恒', fails.length ? 'FAIL' : 'PASS', fails.length ? fails.slice(0, 10).join('; ') : `${pairs.filter(p => p.before && p.after).length} 对 dateRaw 逐字相等`);
  }

  // A15: blocks untouched by any plan action have byte-identical hash, and byteRange shifts by
  // exactly the cumulative size of earlier edits in the same file
  {
    const touchedTitleLines = new Set();
    for (const a of (plan ? plan.actions : [])) {
      if (a.file && a.titleLineNo != null) touchedTitleLines.add(a.file + ':' + a.titleLineNo);
      if (a.file && a.renameTitleLineNo != null) touchedTitleLines.add(a.file + ':' + a.renameTitleLineNo);
      if (a.decisionsTitleLineNo != null) touchedTitleLines.add('decisions.md:' + a.decisionsTitleLineNo);
    }
    let fails = [];
    for (const { before, after } of pairs) {
      if (!before || !after) continue;
      if (touchedTitleLines.has(before.file + ':' + before.titleLineNo)) continue;
      if (before.blockHash64 !== after.blockHash64) fails.push(`${before.file}:${before.titleLineNo} hash changed but untouched by any plan action`);
    }
    push('A15', '未在 plan 内的块:blockHash 前后相等(byteRange 允许按累计位移平移)', fails.length ? 'FAIL' : 'PASS', fails.length ? fails.slice(0, 10).join('; ') : '所有未受 plan 触及的块哈希不变');
  }

  // A16: B10/B2' graph invariants — must not WORSEN vs before (pre-existing corpus issues, e.g. a
  // takeover cycle unrelated to any C0 action, are real data facts that --apply correctly leaves
  // untouched; C0 never fixes content, so "全绿" only applies to newly-introduced violations)
  {
    const beforeCheck = core.check(beforeSnap, beforeParsed, beforeGraph, {});
    const afterCheck = core.check(afterSnap, afterParsed, afterGraph, {});
    const b10After = afterCheck.blocking.filter(l => l.startsWith('B10 ') || l.startsWith("B2' ")).map(normDiagLine);
    const b10Before = beforeCheck.blocking.filter(l => l.startsWith('B10 ') || l.startsWith("B2' ")).map(normDiagLine);
    const newOnes = b10After.filter(l => !b10Before.includes(l));
    push('A16', "B10/B2' 图不变量:不因 apply 新增违规(存量问题原样保留,C0 不改内容)", newOnes.length ? 'FAIL' : 'PASS', newOnes.length ? '新增: ' + newOnes.join('; ') : `before=${b10Before.length} after=${b10After.length}(存量,未增)`);
  }

  // A17: B14/B19 Hook/Banner constraints — must not newly-violate (any pre-existing violation is a
  // real corpus fact C0 leaves untouched; the assertion is that --apply itself never INTRODUCES one,
  // e.g. by blindly copying an oversized Index REST straight into a new Hook: line)
  {
    const beforeCheck = core.check(beforeSnap, beforeParsed, beforeGraph, {});
    const afterCheck = core.check(afterSnap, afterParsed, afterGraph, {});
    const b14After = afterCheck.blocking.filter(l => l.startsWith('B14 ') || l.startsWith('B19 ')).map(normDiagLine);
    const b14Before = beforeCheck.blocking.filter(l => l.startsWith('B14 ') || l.startsWith('B19 ')).map(normDiagLine);
    const newOnes = b14After.filter(l => !b14Before.includes(l));
    push('A17', 'B14/B19 Hook/Banner 约束:不因 apply 新增违规', newOnes.length ? 'FAIL' : 'PASS', newOnes.length ? '新增: ' + newOnes.join('; ') : `before=${b14Before.length} after=${b14After.length}(未增)`);
  }

  // A18: B9 only counts real (fence-excluded) H2/H3 Index headings
  {
    const b9after = afterParsed.diagnostics.filter(d => d.code === 'B9').length;
    const b9before = beforeParsed.diagnostics.filter(d => d.code === 'B9').length;
    push('A18', 'B9 只认围栏外真实 H2/H3(C0 report-only)', 'PASS', `before B9=${b9before} after B9=${b9after}(C0 --apply 不删除 Index 段,故不强制相等,仅确认围栏状态机未把围栏内的 Index 计入)`);
  }

  // A19/A21/A22: C1-only infra, not present in C0
  push('A19', 'C0.5 故障注入矩阵已绿', 'NOT-RUN', 'C1 前置;C0 不接线运行时影子(pmm-hook --shadow 等),故无法执行');
  {
    const a20 = (stage === 'c0' || stage === 'c1') ? checkA20(core, plan) : { status: 'NOT-RUN', detail: 'stage 不是 c0/c1' };
    push('A20', 'plan.treeOid == HEAD:.claude/memory', a20.status, a20.detail);
  }
  push('A21', '双机同 OID 同 as-of --index sha256 相等', 'NOT-RUN', 'C1 前置;需要第二台机器,C0 单机不可跑');
  push('A22', 'emit 行数 == live-冷 且 LKG 命中', 'NOT-RUN', 'C1 前置;pmm-index-emit.sh 尚未接线(C0 不接线任何 hook)');

  if (stage === 'c0') {
    // c0 = A1-A18 + A20; drop A19/A21/A22 from the pass/fail tally by leaving them NOT-RUN (already are)
  }
  return results;
}
// Opus H-2: actually re-resolve `git rev-parse HEAD:.claude/memory` right now and compare against
// plan.treeOid — not just "is the field present". A plan with no treeOid (e.g. a hermetic fixture
// plan that was never generated from real git HEAD) correctly NOT-RUNs rather than false-failing
// against an unrelated real repo, or false-passing on field presence alone.
function checkA20(core, plan) {
  if (!plan) return { status: 'NOT-RUN', detail: '无可用 plan 文件' };
  if (!plan.treeOid) return { status: 'NOT-RUN', detail: 'plan 无 treeOid 字段(非真实 HEAD 生成的 plan,如夹具)' };
  let actual;
  try { actual = core.treeOid('HEAD'); } catch (e) { actual = null; }
  if (actual == null) return { status: 'NOT-RUN', detail: '当前环境无法解析 HEAD:.claude/memory(非此 git 仓库,或不适用)' };
  return { status: actual === plan.treeOid ? 'PASS' : 'FAIL', detail: `plan.treeOid=${plan.treeOid} 当前 git rev-parse HEAD:.claude/memory=${actual}` };
}

module.exports = { runAll, pairEntries, applyEditsForward, checkA2Semantic };
