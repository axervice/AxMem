#!/usr/bin/env node
// selftest-iso.cjs — shared isolation helper for guard self-tests (C05-BUILD-SPEC 补遗二 §22).
//
// Every guard self-test that touches the real root (v3 ledger / trigger-seen / trigger-log /
// shadow / index-lkg / len-baseline) must (1) launch its DUT subprocesses through isoEnv() so no
// ambient PMM_* leaks a real-root write into a "temp HOME" run, and (2) prove zero footprint on the
// REAL root via footprint.begin()/footprint.end() — not the redirected root, because after spec 21
// lands, HOME/USERPROFILE/PMM_HOME are themselves the isolation the gate polices, and a self-test
// that only checked "did MY redirected root grow" would stay green even while leaking into the real
// one (spec 审 K8). realHome() is therefore derived from this file's own location, never from an
// environment variable — the whole point is to have a real-root reference that survives redirection.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ledger = require('./pmm-recall-ledger.cjs'); // read-only reuse of sha16/NUL; this file is not modified.

// realHome() — MUST be derived from __dirname (this file lives at <realHome>/.claude/guards/), never
// from HOME/USERPROFILE/PMM_HOME/PMM_RECALL_ROOT (spec 审 K8: after 21 lands, self-tests only run
// under a redirected HOME, so an env-derived "real root" would just resolve to the temp dir itself).
function realHome() {
  return path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
}

// isoEnv(T, extra) — a full-isolation process.env copy for a DUT subprocess under temp root T.
//   - HOME = USERPROFILE = PMM_HOME = T
//   - PMM_RECALL_ROOT / PMM_TRIGGER_MEM / PMM_TRIGGER_STATE / PMM_TRIGGER_LOG all rooted under T,
//     mirroring the SAME default formulas pmm-trigger-recall.cjs / pmm-recall-ledger.cjs use for a
//     bare HOME=T (so isoEnv never diverges from "what HOME=T alone would have produced" -- it just
//     also removes every leftover ambient PMM_* the calling shell happened to carry).
//   - every other PMM_* key is deleted outright.
//   - extra may only ADD new keys, or re-point PMM_MEM_DIR at the real corpus for a READ-ONLY case;
//     it is applied last (Object.assign) so a caller cannot use it to smuggle T back to the real root.
function isoEnv(T, extra) {
  const root = String(T).replace(/\\/g, '/');
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) {
    if (k.indexOf('PMM_') === 0) delete env[k];
  }
  env.HOME = root;
  env.USERPROFILE = root;
  env.PMM_HOME = root;
  const recallRoot = root + '/.claude/.local/pmm-recall';
  env.PMM_RECALL_ROOT = recallRoot;
  env.PMM_TRIGGER_MEM = root + '/.claude/memory';
  env.PMM_TRIGGER_STATE = root + '/.claude';
  const mach = (require('os').hostname() || 'unknown').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
  env.PMM_TRIGGER_LOG = recallRoot + '/trigger-log-' + mach + '.tsv';
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) env[k] = extra[k];
  }
  return env;
}

// seenKeyOf(sid, agent) — the SAME formula as pmm-trigger-recall.cjs:143's `seenKey` constant
// (sha16((sid||'nosess') + NUL + (agent||''))), duplicated here read-only because that file is B's
// write face (spec 22 disciplines a builder to not import a not-yet-exported helper from it).
function seenKeyOf(sid, agent) {
  return ledger.sha16((sid || 'nosess') + ledger.NUL + (agent || ''));
}

// truncatedSession(sid) — same sanitize-then-slice(0,8) pmm-trigger-recall.cjs:121 uses for its own
// tlog `session` field.
function truncatedSession(sid) {
  return String(sid || 'nosess').replace(/[^A-Za-z0-9-]/g, '').slice(0, 8);
}

// markersFromSource(file, nonce, runRootBase) — the full union of leak markers for one self-test run:
//   1. the run's own nonce (every synthetic id embeds it: test:<nonce>-..., toolu_selftest_<nonce>-...)
//   2. the run root's mkdtemp basename
//   3. every session_id/sessionId/tool_use_id STRING LITERAL found by a static scan of `file`, plus
//      each literal's sha16, its seenKey-derived ".trigger-seen-<key>" name AND ".shadow/seen-<key>"
//      name (agent='' and every literal agent_id/agentId found in the same file -- E-8③, spec 22
//      勘误: the shadow hook's own seen file is the same seenKey family as the legacy
//      .trigger-seen-<key> one, just rooted under .shadow/ instead of directly under .claude/), and
//      its truncated-session form -- this is what lets footprint.end() catch a self-test's own
//      hard-coded fixture id leaking into the real root even when that id does not contain this run's
//      nonce (spec 审 终审勘误候选 3; A3-N1).
function markersFromSource(file, nonce, runRootBase) {
  const markers = new Set();
  if (nonce) markers.add(String(nonce));
  if (runRootBase) markers.add(String(runRootBase));
  if (file) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
    const sids = new Set();
    const agents = new Set(['']);
    const sidRe = /\b(?:session_id|sessionId)\b["']?\s*[:=]\s*["']([^"'\\]*)["']/g;
    const agentRe = /\b(?:agent_id|agentId)\b["']?\s*[:=]\s*["']([^"'\\]*)["']/g;
    let m;
    while ((m = sidRe.exec(text))) sids.add(m[1]);
    while ((m = agentRe.exec(text))) agents.add(m[1]);
    for (const sid of sids) {
      if (!sid) continue;
      markers.add(sid);
      markers.add(ledger.sha16(sid));
      markers.add(truncatedSession(sid));
      for (const agent of agents) {
        const key = seenKeyOf(sid, agent);
        markers.add('.trigger-seen-' + key);
        // E-8③ (spec 22 勘误, "markersFromSource 派生标记加 .shadow/seen-<seenKey>"): the shadow
        // hook's own dedup file lives at <realHome>/.claude/.shadow/seen-<seenKey> -- same seenKey
        // family as legacy .trigger-seen-<key>, just one directory level down. footprint.end()'s
        // "newly created" path (rule ②) matches a leaked file's BASENAME (path.basename(f), never the
        // dir-qualified path -- verified against WATCH_SET's ['.claude/.shadow', '*'] entry and real
        // on-disk samples, which are named bare `seen-<hash>` with no further prefix), so the marker
        // that actually has to appear in that basename is the bare `seen-<key>` form; the dir-qualified
        // `.shadow/seen-<key>` form from the spec text is kept alongside it (harmless, >= MIN_MARKER_LEN,
        // never collides with real content) purely so a marker byte-identical to the spec's own
        // notation is always present too.
        markers.add('seen-' + key);
        markers.add('.shadow/seen-' + key);
      }
    }
    // tool_use_id literals are watched verbatim (no derived form defined by spec).
    const tuRe = /\b(?:tool_use_id|toolUseId)\b["']?\s*[:=]\s*["']([^"'\\]*)["']/g;
    while ((m = tuRe.exec(text))) { if (m[1]) markers.add(m[1]); }
  }
  // MIN_MARKER_LEN guard: a fixture built from a printf placeholder (e.g. a shell template's
  // '"session_id":"%s"', substituted at RUN TIME, not at static-scan time) yields a degenerate raw
  // literal ("%s") whose sanitize-and-truncate derivation collapses to a 1-character string ("s") --
  // measured: this alone false-positived pmm-trigger-recall.sh's footprint check against ordinary
  // concurrent production traffic (any real row containing the letter "s" anywhere).
  //
  // 2026-09-24 (主脑批审 M6): raised 4 -> 8. A source-code-concatenated literal like
  // `'session_id': 'test:' + id` (bash-pipe-exitcode-watch.cjs:2451) is statically scanned as the
  // BARE quoted fragment "test:" (the `+ id` half is invisible to the regex) -- truncatedSession()
  // sanitizes it to "test" (colon stripped, leaving exactly 4 chars), which used to clear the old
  // MIN_MARKER_LEN=4 bar and become a standalone marker. Every REAL row that happens to
  // contain the English word "test" anywhere (an unrelated concurrent session editing a `*.test.ts`
  // file, a real `tooling:selftest-must-redirect-...` recall tag) then false-positived footprint.end()
  // -- measured 315/6092 real trigger-log rows and 110/1413 real hook-log rows contain "test".
  // length alone is not enough: a similarly degenerate `'session_id': 'selftest-' + rest` literal
  // sanitizes+truncates to exactly "selftest" (8 chars, clears the raised bar) and is ALSO a live,
  // legitimate word this codebase's own recall tags use verbatim (`tooling:selftest-*`) -- hence
  // COMMON_WORD_DENYLIST below, checked in addition to length. Every marker this function actually
  // needs to defend (nonce, mkdtemp basename, sha16/seenKey hex digests, a real full-literal fixture
  // id) is comfortably >= 8 chars AND never equal to one of these generic tokens, so a survivor here
  // that fails either test is always noise, never signal.
  const MIN_MARKER_LEN = 8;
  const COMMON_WORD_DENYLIST = new Set(['test', 'tests', 'testing', 'selftest', 'selftests', 'self-test']);
  // stripEdgePunct: the denylist check runs against the marker with LEADING/TRAILING non-alnum
  // stripped (colons, hyphens) -- a statically-scanned literal that is only the fixed HALF of a
  // concatenated id (`'selftest-' + rest`) keeps its trailing "-" verbatim (the regex captures exactly
  // the quoted text, nothing normalizes it), so a bare equality check against "selftest" would miss
  // "selftest-" even though it is exactly the same degenerate-prefix bug the length bar already
  // guards against. Only edges are stripped (never interior characters), so a genuine long/specific
  // literal like "test:selftest-iso-fixture-abc" or "toolu_selftest_iso_fixture" -- which starts and
  // ends on alnum already -- is completely unaffected and still survives.
  const stripEdgePunct = (s) => String(s).toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return Array.from(markers).filter((mk) => {
    if (!mk || mk.length < MIN_MARKER_LEN) return false;
    if (COMMON_WORD_DENYLIST.has(stripEdgePunct(mk))) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// footprint -- zero-attributable-change proof on the REAL root's watch set (= contract
// home_only_proof(b) union spec 22's C0.5 additions, spec 审 K23).
// ---------------------------------------------------------------------------------------------

// Fixed (dir, name-glob) pairs, every dir relative to realHome(). Kept as an explicit list rather
// than a generic glob engine because the watch set itself is a spec-pinned enumeration, not a
// pattern the builder should be inferring at runtime.
const WATCH_SET = [
  ['.claude/.local/pmm-recall', 'events-v3-*.tsv'],
  ['.claude/.local/pmm-recall', 'queue-*.tsv'],
  ['.claude/.local/pmm-recall', 'quarantine-*.tsv'],
  ['.claude/.local/pmm-recall', 'trigger-log-*.tsv'],
  ['.claude/.local/pmm-recall', 'isolation-denials-*.tsv'],
  ['.claude/.local/pmm-recall', 'policy.json'],
  ['.claude/.local/pmm-recall', 'receipts-*.log'],
  ['.claude/.local/pmm-recall/pending', '*'],
  ['.claude', '.trigger-seen-*'],
  ['.claude/memory/dreams', 'trigger-log-*.tsv'],
  ['.claude/.shadow', '*'],
  ['.claude/.pmm-index-lkg', '*'],
  ['.claude', '.pmm-len-baseline*'],
];

// rule ③: these basename shapes are machine-named ledger-family files -- their mere creation is red,
// marker or not (spec 22's judged-red bullet ③). isolation-denials-*.tsv is deliberately NOT in this
// set (spec text lists exactly events-v3/queue/quarantine/trigger-log/policy.json); it is only red
// via ① or ② like the rest of the watch set.
const MACHINE_NAMED_RE = /^(events-v3-.*\.tsv|queue-.*\.tsv|quarantine-.*\.tsv|trigger-log-.*\.tsv|policy\.json)$/i;

function globToRe(glob) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$');
}

function listWatchFiles() {
  const home = realHome();
  const out = [];
  for (const [dirRel, namePattern] of WATCH_SET) {
    const dirAbs = path.join(home, dirRel);
    let names;
    try { names = fs.readdirSync(dirAbs); } catch { continue; }
    const re = globToRe(namePattern);
    for (const name of names) {
      if (re.test(name)) out.push(path.join(dirAbs, name).replace(/\\/g, '/'));
    }
  }
  return out;
}

function statSize(p) {
  try { return fs.statSync(p).size; } catch { return -1; }
}

function begin() {
  const before = new Map();
  for (const f of listWatchFiles()) before.set(f, statSize(f));
  return { before, ts: Date.now() };
}

function containsAnyMarker(buf, markers) {
  if (!markers || !markers.length) return null;
  const text = buf.toString('utf8');
  for (const mk of markers) {
    if (mk && text.indexOf(mk) !== -1) return mk;
  }
  return null;
}

function readTail(file, fromByte, toByte) {
  try {
    const fd = fs.openSync(file, 'r');
    const len = Math.max(0, toByte - fromByte);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromByte);
    fs.closeSync(fd);
    return buf;
  } catch {
    return Buffer.alloc(0);
  }
}

function readWhole(file) {
  try { return fs.readFileSync(file); } catch { return Buffer.alloc(0); }
}

// end(markers) -- re-scans the SAME watch set and judges red per spec 22:
//   ① existing file, bytes appended between old/new size contain a marker -> red
//   ② newly-created file whose NAME or CONTENT contains a marker -> red
//   ③ newly-created file whose basename is machine-named (ledger family) -> red regardless of marker
//   not red: size growth alone, file deletion, an unmarked new file (treated as environmental).
function end(snapshot, markers) {
  const before = snapshot && snapshot.before instanceof Map ? snapshot.before : new Map();
  const hits = [];
  const after = listWatchFiles();
  const afterSet = new Set(after);
  for (const f of after) {
    const oldSize = before.has(f) ? before.get(f) : undefined;
    if (oldSize === undefined) {
      // newly created since begin()
      const base = path.basename(f);
      if (MACHINE_NAMED_RE.test(base)) {
        hits.push({ file: f, reason: 'new-machine-named-file', marker: null });
        continue;
      }
      const nameHit = containsAnyMarker(Buffer.from(base), markers);
      if (nameHit) { hits.push({ file: f, reason: 'new-file-name-marker', marker: nameHit }); continue; }
      const contentHit = containsAnyMarker(readWhole(f), markers);
      if (contentHit) { hits.push({ file: f, reason: 'new-file-content-marker', marker: contentHit }); continue; }
      // unmarked new file: environmental, not red.
      continue;
    }
    const newSize = statSize(f);
    if (newSize > oldSize) {
      const appended = readTail(f, oldSize, newSize);
      const hit = containsAnyMarker(appended, markers);
      if (hit) hits.push({ file: f, reason: 'appended-bytes-marker', marker: hit });
    }
    // newSize <= oldSize (shrink / unchanged): never red.
  }
  // files present before but gone now: deletion, never red (spec explicit).
  void afterSet;
  const red = hits.length > 0;
  const line = red
    ? ('footprint FAIL ' + hits.map((h) => h.file + ':' + h.reason + (h.marker ? ('(' + h.marker + ')') : '')).join('; '))
    : 'footprint pass';
  return { red, hits, line };
}

module.exports = { realHome, isoEnv, footprint: { begin, end }, markersFromSource, seenKeyOf, truncatedSession, WATCH_SET, MACHINE_NAMED_RE };

// --self-test -- a minimal sanity pass for this helper itself (not part of the SELFTEST_STRUCTURE_ROSTER;
// it is the roster's shared dependency, not a member).
if (require.main === module && (process.argv[2] === '--self-test' || process.argv[2] === '--self-check')) {
  let pass = 0, fail = 0;
  function report(name, ok, detail) {
    if (ok) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (detail !== undefined ? (' :: ' + JSON.stringify(detail)) : '')); }
  }
  const home = realHome();
  report('realHome() resolves to an existing directory', fs.existsSync(home), home);
  report('realHome() does not depend on env (still stable with HOME/USERPROFILE/PMM_HOME unset)', (() => {
    // part13 (conventions.home_resolution) reds any bare process.env.HOME/USERPROFILE read outside
    // pmm-recall-ledger.cjs's resolveHome() -- so this proof spawns a CHILD whose env never carries
    // those three keys at all (built on a COPY named childEnv, never on process.env itself) instead of
    // mutating and restoring this process's own environment in place.
    const childEnv = {};
    for (const k of Object.keys(process.env)) {
      if (k === 'HOME' || k === 'USERPROFILE' || k === 'PMM_HOME') continue;
      childEnv[k] = process.env[k];
    }
    const r = require('child_process').spawnSync(process.execPath,
      ['-e', 'process.stdout.write(require(process.argv[1]).realHome())', __filename],
      { env: childEnv, encoding: 'utf8' });
    return r.status === 0 && r.stdout === home;
  })());
  const T = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'selftest-iso-');
  const env = isoEnv(T, { PMM_EXTRA_OK: '1' });
  report('isoEnv sets HOME=USERPROFILE=PMM_HOME=T', env.HOME === T.replace(/\\/g, '/') && env.USERPROFILE === env.HOME && env.PMM_HOME === env.HOME);
  report('isoEnv derives PMM_RECALL_ROOT under T', env.PMM_RECALL_ROOT === (T.replace(/\\/g, '/') + '/.claude/.local/pmm-recall'));
  report('isoEnv strips ambient PMM_* not explicitly set', (() => {
    const dirty = Object.assign({}, process.env, { PMM_FOO_BAR_SHOULD_BE_STRIPPED: 'x' });
    const saved = process.env.PMM_FOO_BAR_SHOULD_BE_STRIPPED;
    process.env.PMM_FOO_BAR_SHOULD_BE_STRIPPED = 'x';
    const e2 = isoEnv(T, {});
    if (saved === undefined) delete process.env.PMM_FOO_BAR_SHOULD_BE_STRIPPED; else process.env.PMM_FOO_BAR_SHOULD_BE_STRIPPED = saved;
    void dirty;
    return e2.PMM_FOO_BAR_SHOULD_BE_STRIPPED === undefined;
  })());
  report('isoEnv extra can add new keys', env.PMM_EXTRA_OK === '1');
  const nonce = 'nonce-' + Date.now();
  const tmpSrc = T + path.sep + 'fixture-src.js';
  fs.writeFileSync(tmpSrc, 'const x = {"session_id":"test:selftest-iso-fixture-abc","tool_use_id":"toolu_selftest_iso_fixture"};');
  const markers = markersFromSource(tmpSrc, nonce, path.basename(T));
  report('markersFromSource includes the nonce', markers.indexOf(nonce) !== -1);
  report('markersFromSource includes the literal session_id', markers.indexOf('test:selftest-iso-fixture-abc') !== -1);
  report('markersFromSource includes sha16(sid)', markers.indexOf(ledger.sha16('test:selftest-iso-fixture-abc')) !== -1);
  report('markersFromSource includes a .trigger-seen-<seenKey> derivation', markers.some((m) => m.indexOf('.trigger-seen-') === 0));
  report('markersFromSource includes the literal tool_use_id', markers.indexOf('toolu_selftest_iso_fixture') !== -1);
  // E-8③: shadow hook's seen-<seenKey> derivation (basename form -- see the comment at its call site
  // for why the bare form, not just the dir-qualified one, is what footprint.end() can actually match).
  report('markersFromSource includes a seen-<seenKey> (.shadow family) derivation', markers.some((m) => m.indexOf('seen-') === 0 && m.indexOf('.trigger-seen-') !== 0));
  report('markersFromSource includes the .shadow/seen-<seenKey> spec-text form', markers.some((m) => m.indexOf('.shadow/seen-') === 0));

  // M6 (主脑批审): a source literal that is only a PREFIX of a concatenated id (the `+ id`/`+ rest`
  // half is invisible to markersFromSource's static regex scan) must never degenerate, via
  // truncatedSession()'s sanitize+slice(0,8), into a bare common word that collides with ordinary real
  // traffic. Reproduced at the pure markersFromSource level -- no real-root writes needed or wanted.
  {
    const tmpSrcDeg = T + path.sep + 'fixture-src-degenerate.js';
    fs.writeFileSync(tmpSrcDeg, 'const x = {"session_id":"test:" + id};'); // static scan only sees "test:"
    const markersDeg = markersFromSource(tmpSrcDeg, 'nonce-degshort-' + Date.now(), 'rrbase-degshort-01');
    report('markersFromSource no longer yields a bare "test" marker from a "test:"-prefix literal',
      markersDeg.indexOf('test') === -1, markersDeg);
    report('markersFromSource markers do not collide with an unrelated *.test.ts filename (concurrent-session repro: a real session editing stripe-live-env-bootstrap.test.ts must not go red)',
      !markersDeg.some((mk) => 'stripe-live-env-bootstrap.test.ts'.indexOf(mk) !== -1), markersDeg);

    fs.writeFileSync(tmpSrcDeg, 'const y = {"session_id":"test:selftest-" + rest};'); // static scan sees "test:selftest-" -> "selftest-" (test: prefix keeps runner part16 honest)
    const markersDeg2 = markersFromSource(tmpSrcDeg, 'nonce-degshort2-' + Date.now(), 'rrbase-degshort-02');
    report('markersFromSource no longer yields the bare common word "selftest" from a "selftest-"-prefix literal',
      markersDeg2.indexOf('selftest') === -1, markersDeg2);
    report('markersFromSource markers do not collide with a real "tooling:selftest-must-redirect-..." recall tag',
      !markersDeg2.some((mk) => 'tooling:selftest-must-redirect-something'.indexOf(mk) !== -1), markersDeg2);
  }

  // footprint round-trip (proves begin/end mechanics against the REAL watch set -- this self-test
  // never mutates HOME/USERPROFILE/PMM_HOME to get here, so `begin()`/`end()` here really are watching
  // realHome(), not some substituted directory).
  {
    const snap = begin();
    const res = end(snap, ['no-such-marker-xyz']);
    report('footprint.end reports pass when nothing changed', res.red === false, res.line);
  }
  // Positive case (M6: the length/denylist tightening above must not blind real-leak detection):
  // footprint.end() must still flag a genuine real-root touch red. Constructed with ZERO writes to the
  // real root -- begin() takes a real, unmodified snapshot; this test then fabricates a "before" view
  // that omits ONE already-existing real machine-named file (as if this run had never observed it),
  // forcing end() down the "newly observed" path against genuinely-unmodified real content and
  // asserting rule ③ (machine-named basename, e.g. queue-<host>.tsv / events-v3-<host>.tsv) still
  // fires red regardless of marker content.
  {
    const snap2 = begin();
    const machineNamedFile = Array.from(snap2.before.keys()).find((f) => MACHINE_NAMED_RE.test(path.basename(f)));
    if (machineNamedFile) {
      const fakeBefore = new Map(snap2.before);
      fakeBefore.delete(machineNamedFile);
      const res2 = end({ before: fakeBefore }, ['no-such-marker-xyz']);
      report('footprint.end still flags a genuine machine-named real-root file as red (rule 3, read-only fabricated-snapshot proof)', res2.red === true, res2.line);
    } else {
      report('footprint.end still flags a genuine machine-named real-root file as red (rule 3, read-only fabricated-snapshot proof)', false, 'no machine-named real-root file found under WATCH_SET to test against');
    }
  }
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log('SELFTEST-ISO {"pass":' + pass + ',"fail":' + fail + '}');
  process.exit(fail > 0 ? 1 : 0);
}
