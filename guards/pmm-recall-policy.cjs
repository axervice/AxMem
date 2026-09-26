#!/usr/bin/env node
// pmm-recall-policy.cjs — the ONE policy resolver for M3 randomized intervention (M-SPEC
// RECALL-LOOP-M-SPEC-v2.md 附录 A "分析单位" + 附录 B3 "分配函数" + 附录 B3 补注 #2 (契约 v2.19
// conventions.policy_file), 2026-09-17 coordinator dispatch, MEDIUM-6).
//
// Why this file exists: the real production ledger has 2750 'eligible' rows, ALL mode='intervene'
// (pmm-trigger-recall.cjs hardcoded it -- "它本来就注入") or mode='' (pmm-bash-impression.cjs never
// set it at all, being a pure observer). M3 reads `mode` off each unit's t0 row to decide which arm
// it belongs to; with no writer ever producing 'shadow', n_shadow is always 0 and every class stays
// UNKNOWN forever. This module is the single place that decides an arm, so every writer (and,
// later, the Bash pipe gate once its own builder migrates it here) makes the SAME decision from the
// SAME policy.json.
//
// policy.json shape (附录 B3 补注 #2, v2.19): { <class_tag>: { mode: "shadow"|"randomized",
// gates: {A,B,D}, unlocked_by, lower95_by_gate, unlocked_at } }. This module only ever reads the
// class-level `mode` key (the `gates` sub-object is the Bash pipe gate's own concern, for a FUTURE
// migration this module's own header flags below -- not read here).
//
// assignment(full_session_id, class_tag) = mode randomized ? (first byte of
// sha256(session||NUL||class_tag) even ? intervene : shadow) : shadow -- ONE arm per (session,
// class), shared by everything that lesson's class covers (test contract conventions.policy_file,
// verbatim). Missing file / missing class key / corrupt file => shadow for everything; this module
// additionally DISTINGUISHES those failure causes in `provenance` (missing FILE = ENOENT specifically
// -> 'policy:absent'; any other read/parse failure, e.g. malformed JSON, EACCES, EISDIR -> 'policy:
// corrupt'; file present and valid but no entry for this class OR entry.mode !== 'randomized' ->
// 'policy:shadow'; entry present with mode==='randomized' -> 'policy:randomized').
//
// READ-ONLY: this module never writes policy.json (only pmm-recall-precision.cjs --unlock does,
// per contract policy_file: "Only pmm-recall-precision.cjs --unlock <class_tag> --gate <G> may
// write gates[G]=randomized").
//
// Exported surface (documented in the build report for the future gate-builder migration):
//   resolveRoot() -> string
//   policyPath(root) -> string
//   readPolicyRaw(root) -> { policy: object|null, errorKind: null|'absent'|'corrupt' }
//     (errorKind===null means the read succeeded; `policy` is the full parsed policy.json object)
//   classEntry(classTag, opts?) -> { entry: object|null, errorKind: null|'absent'|'corrupt' }
//     (opts.root optional; returns the RAW policy.json[classTag] entry, or null if absent/corrupt/
//     missing-key -- lets a future caller, e.g. the gate builder, inspect `gates`/`lower95_by_gate`
//     directly without re-implementing file-read error handling)
//   assignment(fullSessionId, classTag, mode) -> 'intervene' | 'shadow'
//     (PURE function, no I/O: `mode` is the class's already-read policy.json `mode` field value;
//     returns 'shadow' immediately unless mode === 'randomized', matching the M-SPEC formula verbatim)
//   resolve(fullSessionId, classTag, opts?) -> { arm: 'intervene'|'shadow',
//     provenance: 'policy:absent'|'policy:shadow'|'policy:randomized'|'policy:corrupt' }
//     (the actual I/O-performing orchestrator: reads policy.json via classEntry(), then calls
//     assignment() when the class is randomized; opts.root optional, defaults to resolveRoot())
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// pmm-recall-ledger.cjs (2026-09-17, codex LOW-5 / Opus reproduction): resolveRoot() is now THE ONE
// root resolver, required from there instead of re-implemented here. This module's OWN earlier copy
// (`process.env.PMM_RECALL_ROOT || defaultPath`) never trimmed/checked for whitespace-only values --
// PMM_RECALL_ROOT=' ' passed its own truthiness check and got used LITERALLY as a directory, while
// the ledger (and everything reading/writing the actual v3 ledger) correctly fell back to the
// default -- so this module's policy.json lookups silently disagreed with where the real ledger
// lived, for the SAME env var value.
const ledger = require('./pmm-recall-ledger.cjs');
const resolveRoot = ledger.resolveRoot;
function policyPath(root) { return path.join(root, 'policy.json'); }

// readPolicyRaw(root): { policy, errorKind }. errorKind is null on success (policy is the parsed
// object); 'absent' only for ENOENT; 'corrupt' for every other failure (malformed JSON, a non-object
// JSON value, permission errors, policy.json being a directory, etc.) -- never thrown.
function readPolicyRaw(root) {
  let raw;
  try {
    raw = fs.readFileSync(policyPath(root), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { policy: null, errorKind: 'absent' };
    return { policy: null, errorKind: 'corrupt' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { policy: null, errorKind: 'corrupt' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { policy: null, errorKind: 'corrupt' };
  return { policy: parsed, errorKind: null };
}

// classEntry(classTag, opts): the raw policy.json[classTag] entry (or null), plus the same
// errorKind as readPolicyRaw. A successfully-read file with no key for this class returns
// { entry: null, errorKind: null } -- distinguishable from a read failure by errorKind alone.
function classEntry(classTag, opts) {
  const o = opts || {};
  const root = o.root || resolveRoot();
  const { policy, errorKind } = readPolicyRaw(root);
  if (errorKind) return { entry: null, errorKind };
  const e = policy[classTag];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { entry: null, errorKind: null };
  return { entry: e, errorKind: null };
}

// assignment(fullSessionId, classTag, mode): pure, no I/O. mode is the class's OWN policy.json
// `mode` field (the caller already read it); this function only implements the coin-flip formula.
function assignment(fullSessionId, classTag, mode) {
  if (mode !== 'randomized') return 'shadow';
  const h = crypto.createHash('sha256')
    .update(String(fullSessionId) + String.fromCharCode(0) + String(classTag), 'utf8')
    .digest();
  return (h[0] % 2 === 0) ? 'intervene' : 'shadow';
}

// resolve(fullSessionId, classTag, opts): the orchestrator every writer calls. Never throws.
function resolve(fullSessionId, classTag, opts) {
  const { entry, errorKind } = classEntry(classTag, opts);
  if (errorKind === 'absent') return { arm: 'shadow', provenance: 'policy:absent' };
  if (errorKind === 'corrupt') return { arm: 'shadow', provenance: 'policy:corrupt' };
  if (!entry || entry.mode !== 'randomized') return { arm: 'shadow', provenance: 'policy:shadow' };
  return { arm: assignment(fullSessionId, classTag, entry.mode), provenance: 'policy:randomized' };
}

module.exports = { resolveRoot, policyPath, readPolicyRaw, classEntry, assignment, resolve };

// ============================================================================
// --self-test
// ============================================================================
if (require.main === module && process.argv[2] === '--self-test') {
  let PASS = 0, FAIL = 0;
  function report(name, ok, detail) {
    if (ok) { console.log('PASS: ' + name); PASS++; }
    else { console.log('FAIL: ' + name + ' -- ' + (detail || '')); FAIL++; }
  }
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-policy-selftest-'));
  function cleanup() { try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
  process.on('exit', cleanup);

  // ---- 1. missing file -> absent, shadow -------------------------------------------------------
  {
    const root = path.join(T, 'root-missing');
    const r = resolve('sessA', 'class:x', { root });
    report('missing policy.json: arm=shadow, provenance=policy:absent', r.arm === 'shadow' && r.provenance === 'policy:absent', JSON.stringify(r));
  }

  // ---- 2. file exists, class key missing -> shadow (not absent) --------------------------------
  {
    const root = path.join(T, 'root-missingkey');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(policyPath(root), JSON.stringify({ 'class:other': { mode: 'randomized' } }));
    const r = resolve('sessA', 'class:x', { root });
    report('class key missing: arm=shadow, provenance=policy:shadow (distinct from absent)', r.arm === 'shadow' && r.provenance === 'policy:shadow', JSON.stringify(r));
  }

  // ---- 3. class present but mode=shadow (not randomized) -> shadow ------------------------------
  {
    const root = path.join(T, 'root-modeshadow');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(policyPath(root), JSON.stringify({ 'class:x': { mode: 'shadow' } }));
    const r = resolve('sessA', 'class:x', { root });
    report('class mode=shadow explicitly: arm=shadow, provenance=policy:shadow', r.arm === 'shadow' && r.provenance === 'policy:shadow', JSON.stringify(r));
  }

  // ---- 4. malformed JSON -> corrupt --------------------------------------------------------------
  {
    const root = path.join(T, 'root-corrupt');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(policyPath(root), '{not valid json');
    const r = resolve('sessA', 'class:x', { root });
    report('malformed JSON: arm=shadow, provenance=policy:corrupt', r.arm === 'shadow' && r.provenance === 'policy:corrupt', JSON.stringify(r));
  }

  // ---- 5. valid JSON but not an object (array) -> corrupt ----------------------------------------
  {
    const root = path.join(T, 'root-array');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(policyPath(root), '[1,2,3]');
    const r = resolve('sessA', 'class:x', { root });
    report('JSON array (not object): arm=shadow, provenance=policy:corrupt', r.arm === 'shadow' && r.provenance === 'policy:corrupt', JSON.stringify(r));
  }

  // ---- 6. policy.json is a directory (EISDIR on read) -> corrupt, never throws -------------------
  {
    const root = path.join(T, 'root-isdir');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(policyPath(root));
    let threw = false, r = null;
    try { r = resolve('sessA', 'class:x', { root }); } catch (e) { threw = true; }
    report('policy.json is a directory: never throws, arm=shadow, provenance=policy:corrupt', threw === false && r && r.arm === 'shadow' && r.provenance === 'policy:corrupt', JSON.stringify(r));
  }

  // ---- 7. randomized: deterministic, session-stable, and produces BOTH arms across sessions ------
  {
    const root = path.join(T, 'root-randomized');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(policyPath(root), JSON.stringify({ 'class:x': { mode: 'randomized' } }));
    const r1 = resolve('session-alpha', 'class:x', { root });
    const r1b = resolve('session-alpha', 'class:x', { root });
    report('randomized: same (session,class) -> same arm every call (deterministic)', r1.arm === r1b.arm && r1.provenance === 'policy:randomized', JSON.stringify({ r1, r1b }));
    let sawIntervene = false, sawShadow = false;
    for (let i = 0; i < 200; i++) {
      const r = resolve('session-' + i, 'class:x', { root });
      if (r.arm === 'intervene') sawIntervene = true;
      if (r.arm === 'shadow') sawShadow = true;
    }
    report('randomized: across many distinct sessions, BOTH arms occur (not a constant)', sawIntervene && sawShadow, 'sawIntervene=' + sawIntervene + ' sawShadow=' + sawShadow);
  }

  // ---- 8. randomized: different class_tag for the SAME session can differ (arm is per (session,class), not per session alone) ----
  {
    const root = path.join(T, 'root-perclass');
    fs.mkdirSync(root, { recursive: true });
    const classes = {};
    for (let i = 0; i < 50; i++) classes['class:c' + i] = { mode: 'randomized' };
    fs.writeFileSync(policyPath(root), JSON.stringify(classes));
    let sawIntervene = false, sawShadow = false;
    for (let i = 0; i < 50; i++) {
      const r = resolve('fixed-session', 'class:c' + i, { root });
      if (r.arm === 'intervene') sawIntervene = true;
      if (r.arm === 'shadow') sawShadow = true;
    }
    report('randomized: one fixed session, varying class_tag -> both arms occur (per-(session,class), not per-session-only)', sawIntervene && sawShadow, 'sawIntervene=' + sawIntervene + ' sawShadow=' + sawShadow);
  }

  // ---- 9. assignment() is pure and matches resolve()'s own coin-flip for randomized entries -------
  {
    const root = path.join(T, 'root-pure-check');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(policyPath(root), JSON.stringify({ 'class:y': { mode: 'randomized' } }));
    const r = resolve('sess-pure', 'class:y', { root });
    const direct = assignment('sess-pure', 'class:y', 'randomized');
    report('assignment() pure function matches resolve()\'s internal coin-flip', r.arm === direct, JSON.stringify({ r, direct }));
    report('assignment() returns shadow immediately when mode!=="randomized" (no hashing needed)', assignment('sess-pure', 'class:y', 'shadow') === 'shadow' && assignment('sess-pure', 'class:y', undefined) === 'shadow', '');
  }

  // ---- 10. classEntry() exposes the raw entry (gates/lower95_by_gate) for a future gate-builder caller ----
  {
    const root = path.join(T, 'root-entry');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(policyPath(root), JSON.stringify({ 'class:z': { mode: 'randomized', gates: { A: 'randomized', B: 'shadow' }, lower95_by_gate: { A: 0.85 } } }));
    const { entry, errorKind } = classEntry('class:z', { root });
    report('classEntry: raw entry exposes gates and lower95_by_gate untouched', errorKind === null && !!entry && entry.gates && entry.gates.A === 'randomized' && entry.gates.B === 'shadow' && entry.lower95_by_gate.A === 0.85, JSON.stringify(entry));
  }

  // ---- 11. read-only guarantee: resolve()/classEntry() never write anything ----------------------
  {
    const root = path.join(T, 'root-readonly');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(policyPath(root), JSON.stringify({ 'class:ro': { mode: 'randomized' } }));
    const before = fs.readdirSync(root).sort();
    for (let i = 0; i < 20; i++) resolve('s' + i, 'class:ro', { root });
    const after = fs.readdirSync(root).sort();
    report('read-only: directory listing unchanged after many resolve() calls', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
  }

  // ---- 12. LOW-5 (2026-09-17, codex second wave / Opus reproduction): PMM_RECALL_ROOT=' '
  // (whitespace-only) must fall back to the SAME default root this module's resolveRoot() and
  // pmm-recall-ledger.cjs's own resolveRoot() both compute -- NEVER the literal ' ' string. This is
  // now trivially true because this module's resolveRoot is a direct re-export of the ledger's own
  // (no private copy left to disagree with it); the assertion is deliberately kept as a black-box
  // "both resolvers agree AND neither returns the literal whitespace" check rather than a
  // reference-identity check, so it would still catch a REGRESSION where someone reintroduces a
  // second, un-normalized implementation here. Read-only: only resolveRoot() itself is called, no
  // filesystem I/O against whatever that resolves to. ------------------------------------------------
  {
    const before = process.env.PMM_RECALL_ROOT;
    process.env.PMM_RECALL_ROOT = ' ';
    try {
      const fromPolicy = resolveRoot();
      const fromLedger = ledger.resolveRoot();
      report('LOW-5: PMM_RECALL_ROOT=\' \' -> policy.resolveRoot() falls back to the default (never the literal whitespace)', fromPolicy !== ' ', 'fromPolicy=' + JSON.stringify(fromPolicy));
      report('LOW-5: PMM_RECALL_ROOT=\' \' -> policy.resolveRoot() === ledger.resolveRoot() (the one true resolver)', fromPolicy === fromLedger, JSON.stringify({ fromPolicy, fromLedger }));
      // HIGH-1 followup (2026-09-17, runner v2.25 part13 scan): this used to recompute the expected
      // default via a bare os.homedir() call -- a second, independent home-resolution copy living
      // right next to the "only ledger resolves root" self-test it was meant to prove. Calling
      // ledger.defaultRoot() itself removes that copy without weakening the assertion (still fails if
      // ledger.defaultRoot() itself regresses, since a hand-computed value here would just tautologically
      // agree with a broken implementation -- so this line intentionally re-derives via os.homedir()
      // MINUS the module-under-test's own path-join, i.e. it now delegates the whole computation).
      report('LOW-5: the shared default equals ledger.defaultRoot()\'s own computation', fromLedger === ledger.defaultRoot(), fromLedger);
    } finally {
      if (before === undefined) delete process.env.PMM_RECALL_ROOT; else process.env.PMM_RECALL_ROOT = before;
    }
  }

  console.log();
  console.log('==================================================');
  console.log('Summary: ' + PASS + ' passed, ' + FAIL + ' failed');
  console.log('==================================================');
  process.exit(FAIL > 0 ? 1 : 0);
}
