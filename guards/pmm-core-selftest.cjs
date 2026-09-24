#!/usr/bin/env node
// pmm-core-selftest.cjs — golden-corpus driver for `pmm-core.sh --self-test`.
// Loads guards/fixtures/v3/*.md (and the corpus-whole/ + migrate-index-bullets/ directories),
// runs them through pmm-core.cjs, and asserts specific expected properties per FINAL-SPEC §5's
// fixture list. Each case is red-or-green on a specific assertion (not full deep-equality against a
// hand-typed JSON blob) — kept maintainable while still exact on the properties that matter (byte
// fidelity spot-checked independently via `sha256sum`, not just self-consistency).
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const core = require('./pmm-core.cjs');

const FIX = path.join(__dirname, 'fixtures', 'v3');
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
function readFix(name) { return fs.readFileSync(path.join(FIX, name)); }

// Build a synthetic single-file "corpus" snapshot so file-scoped rules (B13/B19/B12/B9) can be
// exercised against fixtures that aren't literally checked in under the real filename.
function corpusOf(role, buf) {
  const files = {};
  for (const f of core.ALL_FILES) files[f] = { raw: null, missing: true };
  const { buf: stripped, hadBOM } = core.stripBOM(buf);
  files[role] = { raw: stripped, hadBOM, missing: false };
  return { view: 'fixture', sourceOids: {}, files };
}

// ── fence-aware.md ─────────────────────────────────────────────────────────────────────────────
{
  const buf = readFix('fence-aware.md');
  const r = core.parseFile('fence-aware.md', buf);
  const ids = r.entries.map(e => e.id);
  ok('fence-aware: exactly 3 real entries', ids.length === 3, JSON.stringify(ids));
  ok('fence-aware: fenced title never becomes an entry', !ids.includes('fx:fake-inside-fence'));
  ok('fence-aware: no B9 from fenced Index heading', !r.diagnostics.some(d => d.code === 'B9'));
  ok('fence-aware: no B8 from fenced near-title', !r.diagnostics.some(d => d.code === 'B8'));
  const before = r.entries.find(e => e.id === 'fx:before-fence');
  ok('fence-aware: backtick-span link NOT extracted', before && !before.links.includes('fx:not-a-real-link'), before && before.links.join(','));
  ok('fence-aware: real unquoted link IS extracted', before && before.links.includes('fx:before-fence'));
  ok('fence-aware: fenced content stays inert inside the block body', before && before.body.includes('## Index') && before.body.includes('fx:fake-inside-fence'));
}

// ── identity-edge-cases.md ─────────────────────────────────────────────────────────────────────
{
  const buf = readFix('identity-edge-cases.md');
  const r = core.parseFile('identity-edge-cases.md', buf);
  const byTitle = Object.fromEntries(r.entries.map(e => [e.title, e]));
  ok('identity: class ns is a valid identity', byTitle['class identity itself is a valid identity']?.id === 'class:widget-alpha');
  const attrOnly = byTitle['attribution-only title (system ns masquerades as identity)'];
  ok('identity: system: ns identity is invalid (id=null)', attrOnly && attrOnly.id === null);
  ok('identity: B8b fires for system: as identity', r.diagnostics.some(d => d.code === 'B8b' && d.tag === 'system:hydrate'));
  const bareUser = byTitle['bare [user] with no colon carries no identity'];
  ok('identity: bare [user] (no colon) => id=null', bareUser && bareUser.id === null);
  const soleOnly = byTitle['sole-record-only title, no real tag anywhere'];
  ok('identity: sole-record-only title => id=null, soleRecord=true', soleOnly && soleOnly.id === null && soleOnly.soleRecord === true);
  const upper = byTitle['uppercase existing tag is grandfathered (B8c report, not block)'];
  ok('identity: uppercase tag still resolves as a valid id (grandfathered)', upper && upper.id === 'Axervice:Legacy-Tag');
  ok('identity: B8c reported for the uppercase id', r.diagnostics.some(d => d.code === 'B8c' && d.tag === 'Axervice:Legacy-Tag'));
  ok('identity: leading-space near-title never becomes an entry', !r.entries.some(e => e.title.includes('leading-space title')));
  ok('identity: blockquote near-title never becomes an entry', !r.entries.some(e => e.title.includes('blockquote-prefixed title')));
  ok('identity: exactly 2 B8 diagnostics (leading-space + blockquote)', r.diagnostics.filter(d => d.code === 'B8').length === 2, r.diagnostics.filter(d => d.code === 'B8').length);
}

// ── duplicates.md (B7) ─────────────────────────────────────────────────────────────────────────
{
  const buf = readFix('duplicates.md');
  const snap = corpusOf('decisions.md', buf);
  const out = core.analyze(snap, { asOf: '2026-06-01' });
  ok('duplicates: B7 fires for same-file duplicate tag', out.blocking.some(b => b.startsWith('B7') && b.includes('fx:dup-tag')));
  ok('duplicates: unique tag is not flagged', !out.blocking.some(b => b.includes('fx:unique-tag')));
}

// ── links-and-hooks.md ─────────────────────────────────────────────────────────────────────────
{
  const buf = readFix('links-and-hooks.md');
  const r = core.parseFile('links-and-hooks.md', buf);
  const withLink = r.entries.find(e => e.id === 'fx:hook-with-link');
  ok('hooks: Hook value parsed', withLink && withLink.hook && withLink.hook.startsWith('see also'));
  ok('hooks: Hook opaque link lands in links[]', withLink && withLink.links.includes('fx:hook-target'));
  const oversize = r.entries.find(e => e.id === 'fx:hook-oversize');
  ok('hooks: oversize Hook line rejected (hook stays null)', oversize && oversize.hook === null);
  ok('hooks: B14 fires for oversize Hook', r.diagnostics.some(d => d.code === 'B14' && d.tag === 'fx:hook-oversize'));
  ok('hooks: B15 fires for bare [[x]]', r.diagnostics.some(d => d.code === 'B15' && /nope-no-namespace/.test(d.raw)));
}

// ── triggers.md ────────────────────────────────────────────────────────────────────────────────
{
  const buf = readFix('triggers.md');
  const r = core.parseFile('triggers.md', buf);
  const multi = r.entries.find(e => e.id === 'fx:multi-tool-trigger');
  ok('triggers: multi-tool path trigger parsed with 3 tools', multi && multi.triggers[0] && multi.triggers[0].tools.length === 3, JSON.stringify(multi && multi.triggers));
  const legal = r.entries.find(e => e.id === 'fx:cmd-legal');
  ok('triggers: repo=* legal exe accepted', legal && legal.triggers.length === 1 && legal.triggers[0].exe === 'jq');
  ok('triggers: repo=* illegal exe (git) is B5', r.diagnostics.some(d => d.code === 'B5' && d.tag === 'fx:cmd-illegal'));
  const withSub = r.entries.find(e => e.id === 'fx:cmd-with-sub');
  ok('triggers: cmd trigger sub-token captured', withSub && withSub.triggers[0] && withSub.triggers[0].sub === 'run');
  ok('triggers: missing repo= is B5', r.diagnostics.some(d => d.code === 'B5' && d.tag === 'fx:bad-trigger-form'));
  ok('triggers: path prefix <2 segments is B5', r.diagnostics.some(d => d.code === 'B5' && d.tag === 'fx:bad-path-prefix'));
  ok('triggers: path=* is B5 with the specific reason', r.diagnostics.some(d => d.code === 'B5' && d.tag === 'fx:bad-path-star' && /path=\*/.test(d.reason || '')));
  ok('triggers (09-15): root-level prefix >=3 bytes, no slash, is LEGAL', !r.diagnostics.some(d => d.tag === 'fx:good-root-prefix'));
  const goodRoot = r.entries.find(e => e.id === 'fx:good-root-prefix');
  ok('triggers (09-15): root-level trigger actually recorded', goodRoot && goodRoot.triggers.length === 1 && goodRoot.triggers[0].path === '.env*');

  // ── glob support (09-15, GLOB-TRIGGER-SPEC.md): mid-string/repeated `*` is now legal glob syntax,
  //    NOT automatically B5 — the write-time gate only rejects it via the prefix-length policy, which
  //    applies uniformly regardless of where the first `*` sits.
  ok('triggers (glob): mid-string/repeated * is NO LONGER auto-B5', !r.diagnostics.some(d => d.tag === 'fx:good-mid-star'));
  const goodMid = r.entries.find(e => e.id === 'fx:good-mid-star');
  ok('triggers (glob): mid-string-star trigger actually recorded (scripts/itest-*lock*.ts)', goodMid && goodMid.triggers.length === 1 && goodMid.triggers[0].path === 'scripts/itest-*lock*.ts');
  ok('triggers (glob): short (<3 byte) literal prefix before a MID-string star is still B5', r.diagnostics.some(d => d.code === 'B5' && d.tag === 'fx:bad-short-prefix-midstar' && /字面前缀/.test(d.reason || '')));
  ok('triggers (glob): leading-slash literal prefix before a MID-string star is still B5', r.diagnostics.some(d => d.code === 'B5' && d.tag === 'fx:bad-leading-slash-midstar' && /\/ 起/.test(d.reason || '')));
  ok('triggers (glob): real incident pattern docs/*-design.md compiles legal', !r.diagnostics.some(d => d.tag === 'fx:good-docs-design'));
  const goodDocs = r.entries.find(e => e.id === 'fx:good-docs-design');
  ok('triggers (glob): docs/*-design.md trigger recorded verbatim', goodDocs && goodDocs.triggers.length === 1 && goodDocs.triggers[0].path === 'docs/*-design.md');
  ok('triggers (glob): real incident pattern prisma/*.sql compiles legal', !r.diagnostics.some(d => d.tag === 'fx:good-prisma-sql'));

  // ── HIGH-4b (2026-09-15, FABLE-2026-09-15-glob-review-triage.md finding 4b / CODEX-2026-09-15-
  //    glob-spec-review.md finding 4): "闸与引擎共用同一实现" was previously only provable by calling
  //    compileTriggerPath/checkTriggerPathB5 directly (proves the shared function itself works, NEVER
  //    proves pmm-core.cjs's real B5 diagnostic pipeline — the thing every actual consumer runs —
  //    truly delegates to it instead of a silently-reforked local judgment). These two canaries go
  //    through `r.diagnostics`, i.e. core.parseFile()'s REAL B5 code path, and are each constructed so
  //    that a PLAUSIBLE independent reimplementation would misjudge them while the real shared
  //    compileTriggerPath gets them right — so if pmm-core.cjs's gate ever forks its own judgment
  //    again, one of these goes red even though the exported compileTriggerPath itself still passes
  //    every test above.
  ok('triggers (HIGH-4b): UTF-8 BYTE-length prefix (中* = 1 char/3 bytes) is legal at the GATE — a .length-based fork would wrongly reject it', !r.diagnostics.some(d => d.tag === 'fx:good-utf8-byte-prefix'));
  ok('triggers (HIGH-4b): the live multi-token glob src/lib/**/*lock* is legal at the GATE — a ternary-based fork could not even parse **', !r.diagnostics.some(d => d.tag === 'fx:good-lock-glob-gate'));

  // ── compileTriggerPath itself: the GLOB-TRIGGER-SPEC.md compile table, row-for-row, positive and
  //    negative examples both — this is the single shared implementation pmm-core.cjs's B5 gate,
  //    pmm-manifest.cjs's legacy write gate, and pmm-trigger-recall.cjs's own runtime matcher all
  //    delegate to (no second glob interpretation anywhere).
  {
    const trig = require('./pmm-trigger-recall.cjs');
    const table = [
      { pattern: 'src/lib/*', hit: ['src/lib/a/b.ts'], miss: ['src/libx/a.ts'] },
      { pattern: 'scripts/itest-*', hit: ['scripts/itest-lock.ts'], miss: ['scripts/db-x.ts'] },
      { pattern: '.env*', hit: ['.env.local'], miss: ['docs/.env'] },
      { pattern: 'docs/*', hit: ['docs/a/b-design.md'], miss: ['xdocs/a.md'] },
      { pattern: 'scripts/itest-*lock*.ts', hit: ['scripts/itest-ab-lock-x.ts'], miss: ['scripts/itest-a/lock.ts'] },
      // HIGH-1 (2026-09-15, FABLE-2026-09-15-glob-review-triage.md finding 1): the miss example below
      // used to be ONLY 'src/util/lock.ts', which never even starts with 'src/lib/' — it can't catch
      // the actual bug (trailing `*` compiling to cross-segment `.*` because it happened to sit last
      // in the pattern, not because it was the pattern's ONLY star). 'src/lib/lock-cache/unrelated.ts'
      // is the real repro: lock sits in a DIRECTORY name, the filename doesn't contain it at all — the
      // pre-fix regex `^src/lib/(?:[^/]+/)*[^/]*lock.*$` matched it anyway (trailing `.*` ate the `/`).
      { pattern: 'src/lib/**/*lock*', hit: ['src/lib/locks.ts', 'src/lib/a/b-lock.ts'], miss: ['src/util/lock.ts', 'src/lib/lock-cache/unrelated.ts'] },
      { pattern: 'prisma/*', hit: ['prisma/migrations/x.sql'], miss: [] },
    ];
    for (const row of table) {
      let compiled;
      try { compiled = trig.compileTriggerPath(row.pattern); }
      catch (e) { ok(`compileTriggerPath table row '${row.pattern}' compiles`, false, e.message); continue; }
      for (const h of row.hit) ok(`compileTriggerPath '${row.pattern}' MUST match '${h}'`, compiled.re.test(h.toLowerCase()));
      for (const mm of row.miss) ok(`compileTriggerPath '${row.pattern}' MUST NOT match '${mm}'`, !compiled.re.test(mm.toLowerCase()));
    }
    // exact (no `*`) row
    {
      const compiled = trig.compileTriggerPath('.claude/guards/foo.sh');
      ok("compileTriggerPath exact literal matches only itself", compiled.re.test('.claude/guards/foo.sh') && !compiled.re.test('.claude/guards/foo.sh.bak'));
    }
    // reject table
    ok('compileTriggerPath rejects bare *', (() => { try { trig.compileTriggerPath('*'); return false; } catch (e) { return e instanceof trig.TriggerPatternError; } })());
    ok('compileTriggerPath rejects bare **', (() => { try { trig.compileTriggerPath('**'); return false; } catch (e) { return e instanceof trig.TriggerPatternError; } })());
    ok('compileTriggerPath rejects empty path', (() => { try { trig.compileTriggerPath(''); return false; } catch (e) { return e instanceof trig.TriggerPatternError; } })());

    // ── HIGH-3 (2026-09-15, FABLE-2026-09-15-glob-review-triage.md finding 3 / CODEX-2026-09-15-glob-
    //    spec-review.md finding 3): B5 used to only ever fire when a `*` was present, so a malformed
    //    or star-free form that can NEVER match a normalized repo-relative POSIX event path sailed
    //    through with ok:true. These four are the audit's own repro set — 'src\*'/'C:/*'/'abc//**' all
    //    had a >=3-byte prefix and compiled fine; '/absolute/file' has no `*` at all so the old B5
    //    prefix rule never even looked at it. All four must now be refused at compile time.
    const rejectContract = ['src\\*', 'C:/*', 'abc//**', '/absolute/file'];
    for (const bad of rejectContract) {
      ok(`compileTriggerPath (HIGH-3) rejects malformed/unmatchable form '${bad}'`, (() => {
        try { trig.compileTriggerPath(bad); return false; }
        catch (e) { return e instanceof trig.TriggerPatternError; }
      })());
    }
    // same four via the write-time B5 gate (checkTriggerPathB5) — must ALSO refuse, not just compile.
    for (const bad of rejectContract) {
      const b5 = trig.checkTriggerPathB5(bad);
      ok(`checkTriggerPathB5 (HIGH-3) rejects '${bad}'`, b5.ok === false);
    }
    // a few more contract shapes not in the audit's own four but implied by "统一拒绝...空段(//)、
    // .`/`..` 段、控制字符、目录结尾": kept minimal (one each) so failures point at a specific rule.
    ok("compileTriggerPath (HIGH-3) rejects trailing-slash (directory) form", (() => { try { trig.compileTriggerPath('src/lib/'); return false; } catch (e) { return e instanceof trig.TriggerPatternError; } })());
    ok("compileTriggerPath (HIGH-3) rejects a '..' path segment", (() => { try { trig.compileTriggerPath('src/../etc/*'); return false; } catch (e) { return e instanceof trig.TriggerPatternError; } })());
    ok("compileTriggerPath (HIGH-3) rejects a control character", (() => { try { trig.compileTriggerPath('src/\x01lib/*'); return false; } catch (e) { return e instanceof trig.TriggerPatternError; } })());

    // ── HIGH-2 (2026-09-15, FABLE-2026-09-15-glob-review-triage.md finding 2, empirically reproduced
    //    in scratchpad/redos-probe.cjs): an unbounded wildcard-token count made the compiled regex
    //    susceptible to catastrophic backtracking (measured: 6 tokens against a crafted 83-byte
    //    failing candidate took ~4s). A pattern with more wildcard tokens than the new cap must be
    //    refused at COMPILE time (so it can never even reach the matcher); a pattern AT the cap must
    //    still compile and must resolve an adversarial failing match well under the vulnerable range.
    {
      const tooMany = 'abc*a*a*a*a*a*ab'; // 6 single-star tokens — the audit's own reproduction pattern
      ok('compileTriggerPath (HIGH-2) rejects a pattern with too many wildcard tokens', (() => {
        try { trig.compileTriggerPath(tooMany); return false; }
        catch (e) { return e instanceof trig.TriggerPatternError && /通配符/.test(e.message); }
      })());
      const atCap = 'abc*a*a*a*ab'; // 4 single-star tokens — at MAX_WILDCARD_TOKENS, must still compile
      let compiledAtCap = null;
      try { compiledAtCap = trig.compileTriggerPath(atCap); } catch (e) { compiledAtCap = null; }
      ok('compileTriggerPath (HIGH-2) still compiles a pattern AT the wildcard-token cap', compiledAtCap != null);
      if (compiledAtCap) {
        const adversarial = ('abc' + 'a'.repeat(80) + 'c').toLowerCase();
        const t0 = Date.now();
        const matched = compiledAtCap.re.test(adversarial);
        const elapsedMs = Date.now() - t0;
        ok('compileTriggerPath (HIGH-2) adversarial failing match at the cap stays well under 1s (was ~4s at 6 tokens)', elapsedMs < 1000, `elapsed=${elapsedMs}ms matched=${matched}`);
      }
      ok('compileTriggerPath (HIGH-2) rejects an overlong pattern', (() => {
        try { trig.compileTriggerPath('a/' + 'b'.repeat(250) + '*'); return false; }
        catch (e) { return e instanceof trig.TriggerPatternError && /过长/.test(e.message); }
      })());
      // a live-shaped pattern at the boundary must still work end-to-end: src/lib/**/*lock* has 3
      // wildcard TOKENS (`**/`, `*`, `*` — NOT 4, since raw `*` character count over-counts `**/`),
      // well under the cap — this guards against a future re-tightening of the cap silently breaking
      // the one multi-token pattern that is actually live in the real corpus.
      const liveShaped = trig.compileTriggerPath('src/lib/**/*lock*');
      ok('compileTriggerPath (HIGH-2) the one live multi-token pattern stays under the cap', liveShaped != null);
    }

    // ── O-9 (2026-09-15 round 2, guards/audits/OPUS-2026-09-15-repair-review.md): the HIGH-2 test
    //    above tested match time at exactly ONE candidate length (84 chars) — the audit's own finding
    //    was that this is a single point, not a length scan, and the real cost driver is the CANDIDATE
    //    string's length (~O(n⁴) for a 4-token pattern), which nothing bounded. Scan several lengths,
    //    including realistic repo-relative-path lengths (100–260 chars per the audit) and lengths past
    //    testTriggerPath()'s MAX_CANDIDATE_PATH_LEN cap, and assert the WRAPPED matcher (never the raw
    //    `.re.test()`) stays fast throughout — the raw regex is not required to be fast past the cap;
    //    testTriggerPath() short-circuiting before ever reaching it is what must be verified.
    {
      const atCapPattern = trig.compileTriggerPath('abc*a*a*a*ab'); // 4 tokens, matches the earlier test
      const lengths = [80, 120, 160, 200, 240, 400];
      let worstMs = 0;
      const perLength = [];
      for (const len of lengths) {
        const candidate = ('abc' + 'a'.repeat(Math.max(0, len - 4)) + 'c').toLowerCase();
        const t0 = Date.now();
        const matched = trig.testTriggerPath(atCapPattern, candidate);
        const elapsedMs = Date.now() - t0;
        perLength.push(`len=${candidate.length}ms=${elapsedMs}matched=${matched}`);
        worstMs = Math.max(worstMs, elapsedMs);
        if (candidate.length > trig.MAX_CANDIDATE_PATH_LEN) {
          ok(`testTriggerPath (O-9) rejects candidate over the cap (len=${candidate.length}) as non-match, near-instant`, matched === false && elapsedMs < 50, `elapsed=${elapsedMs}ms`);
        }
      }
      ok('testTriggerPath (O-9) length scan stays well under 1s at every point, cap included', worstMs < 1000, perLength.join(' '));
      // regression-lock: MAX_CANDIDATE_PATH_LEN itself must not silently grow past a value that would
      // let the ~O(n⁴) cost back in (this is a sanity bound, not a precision requirement).
      ok('testTriggerPath (O-9) MAX_CANDIDATE_PATH_LEN stays at or below 200', trig.MAX_CANDIDATE_PATH_LEN <= 200, `cap=${trig.MAX_CANDIDATE_PATH_LEN}`);
      // a legitimate candidate AT the cap must still match correctly (the cap must not silently break
      // real matching for paths that are long but within bounds) — construct one that actually SATISFIES
      // ^abc[^/]*a[^/]*a[^/]*a[^/]*ab$ (all filler in the first gap, exact length == the cap).
      const fillerLen = trig.MAX_CANDIDATE_PATH_LEN - ('abc'.length + 'a'.length * 3 + 'ab'.length);
      const atCapCandidate = ('abc' + 'x'.repeat(fillerLen) + 'a' + 'a' + 'a' + 'ab').toLowerCase();
      ok('testTriggerPath (O-9) a candidate exactly AT the cap still matches normally', atCapCandidate.length === trig.MAX_CANDIDATE_PATH_LEN && trig.testTriggerPath(atCapPattern, atCapCandidate) === true, `len=${atCapCandidate.length} matched=${trig.testTriggerPath(atCapPattern, atCapCandidate)}`);
    }

    // ── anti-drift assertion (GLOB-TRIGGER-SPEC.md): every trigger `path=` currently live in the
    //    real corpus must compile through compileTriggerPath without throwing — this is the guard
    //    against the gate and the engine ever silently disagreeing again.
    const liveSnap = core.snapshot('worktree');
    const liveParsed = core.parseAll(liveSnap);
    let allPaths = [];
    for (const e of liveParsed.entries) for (const tr of e.triggers) if (tr.kind === 'path') allPaths.push(tr.path);
    let driftFail = null;
    for (const p of allPaths) {
      try { trig.compileTriggerPath(p); }
      catch (e) { driftFail = `${p}: ${e.message}`; break; }
    }
    ok(`anti-drift: all ${allPaths.length} live trigger paths compile through compileTriggerPath`, driftFail === null, driftFail);
  }
}

// ── supersedes-cause-follows.md ───────────────────────────────────────────────────────────────
{
  const buf = readFix('supersedes-cause-follows.md');
  const snap = corpusOf('decisions.md', buf);
  const out = core.analyze(snap, { asOf: '2026-06-01' });
  const byId = Object.fromEntries(out.entries.map(e => [e.id, e]));
  ok('scf: legal Supersedes edge recorded', byId['fx:scf-new'] && byId['fx:scf-new'].supersedes.includes('fx:scf-old'));
  ok('scf: single-bracket Supersedes is B23, no edge', out.blocking.some(b => b.startsWith('B23') && b.includes('fx:scf-singlebracket')) && !byId['fx:scf-singlebracket'].supersedes.includes('fx:scf-old'));
  ok('scf: prose "clarify" Supersedes is B23, no edge', out.blocking.some(b => b.startsWith('B23') && b.includes('fx:scf-prose')) && byId['fx:scf-prose'].supersedes.length === 0);
  ok('scf: Cause with · separator, two targets', byId['fx:scf-cause-dot'] && byId['fx:scf-cause-dot'].cause.length === 2);
  ok('scf: Cause self-edge is B10', out.blocking.some(b => b.startsWith('B10') && b.includes('自边') && b.includes('fx:scf-cause-self')));
  ok('scf: Cause duplicate edge is B10', out.blocking.some(b => b.startsWith('B10') && b.includes('重复边') && b.includes('fx:scf-cause-dup')));
  ok('scf: Follows with two targets (comma sep)', byId['fx:scf-follows-two'] && byId['fx:scf-follows-two'].follows.length === 2);
  ok('scf: Cause cycle detected', out.blocking.some(b => b.startsWith('B10') && b.includes('成环')));
  ok('scf: dangling Cause target is B1', out.blocking.some(b => b.startsWith('B1') && b.includes('fx:scf-never-defined-anywhere')));
}

// ── B23 09-15 revision: `[[tag]](说明)` is LEGAL; a bare qualifier BEFORE the bracket still B23 ──
{
  const buf = Buffer.from(
    '**2026-01-01 — target of a Supersedes with explanation** [fx:b23-target]\nbody.\n\n' +
    '**2026-01-02 — Supersedes with a trailing (explanation), must be a legal edge, no B23** [fx:b23-explained]\nSupersedes: [[fx:b23-target]](旧决定的取代原因说明)\n\n' +
    '**2026-01-03 — two targets with · separator, each with its own explanation** [fx:b23-multi-explained]\nSupersedes: [[fx:b23-target]](原因A) · [[fx:b23-explained]](原因B)\n\n' +
    '**2026-01-04 — bare qualifier BEFORE the bracket, must still be B23 (move into parens instead)** [fx:b23-bare-qualifier]\nSupersedes: 澄清 [[fx:b23-target]]\n',
    'utf8');
  const snap = corpusOf('decisions.md', buf);
  const out = core.analyze(snap, { asOf: '2026-06-01' });
  const byId = Object.fromEntries(out.entries.map(e => [e.id, e]));
  ok('B23 (09-15): [[tag]](说明) is a legal edge, no B23', byId['fx:b23-explained'] && byId['fx:b23-explained'].supersedes.includes('fx:b23-target') && !out.blocking.some(b => b.startsWith('B23') && b.includes('fx:b23-explained')));
  ok('B23 (09-15): multiple explained targets via · both resolve', byId['fx:b23-multi-explained'] && byId['fx:b23-multi-explained'].supersedes.includes('fx:b23-target') && byId['fx:b23-multi-explained'].supersedes.includes('fx:b23-explained'));
  ok('B23 (09-15): a bare qualifier BEFORE the bracket is still B23 (not silently legalized)', out.blocking.some(b => b.startsWith('B23') && b.includes('fx:b23-bare-qualifier')) && byId['fx:b23-bare-qualifier'].supersedes.length === 0);
}

// ── banner-and-trust.md (loaded AS standinginstructions.md — B19 requires that file identity) ───
{
  const buf = readFix('banner-and-trust.md');
  const snap = corpusOf('standinginstructions.md', buf);
  const out = core.analyze(snap, { asOf: '2026-06-01' });
  ok('banner: legal banner (ratified host) — no B19 for fx:banner-ok', !out.blocking.some(b => b.startsWith('B19') && b.includes('fx:banner-ok')));
  ok('banner: illegal banner (non-ratified host) — B19 for fx:banner-no-trust', out.blocking.some(b => b.startsWith('B19') && b.includes('fx:banner-no-trust')));
}

// ── multi-terminal-fork.md (B2') ──────────────────────────────────────────────────────────────
{
  const buf = readFix('multi-terminal-fork.md');
  const snap = corpusOf('decisions.md', buf);
  const out = core.analyze(snap, { asOf: '2026-06-01' });
  ok('fork: report-level FORK noted (single fork point is allowed)', out.report.some(r => r.startsWith('FORK') && r.includes('fx:fork-root')));
  ok("fork: B2' multi-terminal blocking fires", out.blocking.some(b => b.startsWith("B2'") && b.includes('fx:fork-root')));
}

// ── diamond-dag.md / true-cycle.md (B2', coordinator-confirmed defect 2026-09-15) ────────────────
// resolveHeads() used one flat "seen" set for both visited-dedup and cycle detection — a diamond DAG
// node reached twice via two DIFFERENT paths (not a back-edge) was misjudged as a cycle. Fixed to a
// proper GRAY(on current DFS path)/BLACK(fully explored) three-color scheme, matching B10's Cause-
// graph cycle detector. This pair of fixtures pins both directions of that fix.
{
  const buf = readFix('diamond-dag.md');
  const snap = corpusOf('decisions.md', buf);
  const out = core.analyze(snap, { asOf: '2026-06-01' });
  ok('diamond-dag: no B2\' cycle/multi-terminal blocking for a converging (non-cyclic) diamond', !out.blocking.some(b => b.startsWith("B2'")), JSON.stringify(out.blocking.filter(b => b.startsWith("B2'"))));
  const byId = Object.fromEntries(out.entries.map(e => [e.id, e]));
  ok('diamond-dag: headOf(fx:dd-a) uniquely resolves to fx:dd-d', byId['fx:dd-a'] && byId['fx:dd-a'].head === 'fx:dd-d', byId['fx:dd-a'] && byId['fx:dd-a'].head);
  ok('diamond-dag: headOf(fx:dd-b) and headOf(fx:dd-c) both also resolve to fx:dd-d', byId['fx:dd-b'] && byId['fx:dd-b'].head === 'fx:dd-d' && byId['fx:dd-c'] && byId['fx:dd-c'].head === 'fx:dd-d');
}
{
  const buf = readFix('true-cycle.md');
  const snap = corpusOf('decisions.md', buf);
  const out = core.analyze(snap, { asOf: '2026-06-01' });
  ok("true-cycle: B2' still fires for a REAL 2-node back-edge cycle (fix must not over-correct)", out.blocking.some(b => b.startsWith("B2'") && /fx:tc-(x|y)/.test(b)), JSON.stringify(out.blocking.filter(b => b.startsWith("B2'"))));
}

// ── empty-file.md / title-only-entry.md ───────────────────────────────────────────────────────
{
  const buf = readFix('empty-file.md');
  ok('empty-file: zero bytes', buf.length === 0);
  const r = core.parseFile('empty-file.md', buf);
  ok('empty-file: zero entries, zero diagnostics', r.entries.length === 0 && r.diagnostics.length === 0);
}
{
  const buf = readFix('title-only-entry.md');
  const r = core.parseFile('title-only-entry.md', buf);
  ok('title-only: exactly 1 entry', r.entries.length === 1);
  ok('title-only: block spans the whole file (title line + its own terminator, no trailing blanks to trim)', r.entries[0] && r.entries[0].byteRange[0] === 0 && r.entries[0].byteRange[1] === buf.length, r.entries[0] && JSON.stringify(r.entries[0].byteRange) + ' vs file len ' + buf.length);
}

// ── future-date.md (B22) — inline, no separate file needed ───────────────────────────────────
{
  const buf = Buffer.from('**2099-01-01 — a decision from the future** [fx:future-date]\nbody.\n', 'utf8');
  const snap = corpusOf('decisions.md', buf);
  const out = core.analyze(snap, { asOf: '2026-06-01' });
  ok('future-date: B22 fires', out.blocking.some(b => b.startsWith('B22') && b.includes('fx:future-date')));
}

// ── B17 (Q 闸) 09-15 revision — attribution field only, body never scanned ────────────────────
{
  // body text containing the KEYWORD "原话" is common when the rule itself is being described in
  // prose (not a real verbatim quote) — must NOT fire B17 now that body scanning is removed.
  const buf1 = Buffer.from('**2026-01-01 — body mentions the word verbatim but is not itself a quote** [fx:b17-body-word]\n原话 逐字 这两个词本身在正文里出现,不该被当真引用。\n', 'utf8');
  const out1 = core.analyze(corpusOf('decisions.md', buf1), { asOf: '2026-06-01' });
  ok('B17 (09-15): body containing the keyword "原话/逐字" is NOT flagged (body no longer scanned)', !out1.blocking.some(b => b.startsWith('B17')));

  // a long (>=120B) quoted span sitting in the BODY must likewise no longer fire.
  const longQuote = '「' + 'a'.repeat(130) + '」';
  const buf2 = Buffer.from(`**2026-01-02 — long quoted span in the body, not attribution** [fx:b17-body-span]\n${longQuote}\n`, 'utf8');
  const out2 = core.analyze(corpusOf('decisions.md', buf2), { asOf: '2026-06-01' });
  ok('B17 (09-15): long quoted span in the BODY is NOT flagged (body no longer scanned)', !out2.blocking.some(b => b.startsWith('B17')));

  // the SAME keyword, in the attribution field, must still fire — B17 isn't neutered, just re-scoped.
  const buf3 = Buffer.from('**2026-01-03 — attribution claims a verbatim quote** [fx:b17-attrib-word]\n<!-- attribution: Jax 原话 -->\nbody.\n', 'utf8');
  const out3 = core.analyze(corpusOf('decisions.md', buf3), { asOf: '2026-06-01' });
  ok('B17 (09-15): attribution field containing "原话" still fires', out3.blocking.some(b => b.startsWith('B17') && b.includes('fx:b17-attrib-word')));
}

// ── bom-crlf.md / no-trailing-newline.md (byte fidelity) ─────────────────────────────────────
{
  const buf = readFix('bom-crlf.md');
  ok('bom-crlf: file starts with UTF-8 BOM', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf);
  const r = core.parseFile('bom-crlf.md', buf.slice(3)); // core.parseFile expects BOM already stripped (parseAll does this); replicate that contract here
  ok('bom-crlf: 2 entries parsed despite CRLF', r.entries.length === 2, r.entries.length);
  const one = r.entries.find(e => e.id === 'fx:bomcrlf-one');
  ok('bom-crlf: CRLF bytes included in blockHash (spot-check vs independent sha256sum)', one && independentSha256Matches(one, buf.slice(3)));
}
{
  const buf = readFix('no-trailing-newline.md');
  ok('no-trailing-newline: last byte is not 0x0a', buf[buf.length - 1] !== 0x0a);
  const r = core.parseFile('no-trailing-newline.md', buf);
  ok('no-trailing-newline: 1 entry, byteRange reaches EOF', r.entries.length === 1 && r.entries[0].byteRange[1] === buf.length, (r.entries[0] && JSON.stringify(r.entries[0].byteRange)) + ' vs len ' + buf.length);
}

function independentSha256Matches(entry, fullBufNoBOM) {
  const slice = fullBufNoBOM.slice(entry.byteRange[0], entry.byteRange[1]);
  const tmpName = `.spot-check-${process.pid}-${Math.random().toString(36).slice(2)}.bin`;
  const tmp = path.join(__dirname, tmpName); // guards/ dir — avoids os.tmpdir() path-escaping issues
  fs.writeFileSync(tmp, slice);
  try {
    const out = execSync(`sha256sum ${JSON.stringify(tmpName)}`, { encoding: 'utf8', cwd: __dirname });
    const independentHash = out.trim().split(/\s+/)[0];
    return independentHash === entry.blockHash64;
  } finally { fs.unlinkSync(tmp); }
}

// ── corpus-whole/ (whole-corpus, multi-file checks: B7 cross-file, B13, B6-class-target,
//    B19-per-file-identity, B9 (## / ###) Index headings, archive-no-tag) ─────────────────────
{
  const dir = path.join(FIX, 'corpus-whole');
  const snap = core.snapshotDir(dir);
  const out = core.analyze(snap, { asOf: '2026-06-01' });
  ok('corpus-whole: B7 cross-file duplicate (decisions vs standing)', out.blocking.some(b => b.startsWith('B7') && b.includes('fx:cross-tag') && b.includes('decisions.md') && b.includes('standinginstructions.md')));
  ok('corpus-whole: B13 routed-namespace lesson', out.blocking.some(b => b.startsWith('B13') && b.includes('axervice:should-be-in-project-repo')));
  ok('corpus-whole: B6 lessons missing Class (new, >= cutoff)', out.blocking.some(b => b.startsWith('B6') && b.includes('fx:les-missing-class')));
  ok('corpus-whole: B6 decisions Class target missing', out.blocking.some(b => b.startsWith('B6') && b.includes('fx:dec-badclass')));
  ok('corpus-whole: legal Class resolves (no B6 for fx:les-ok)', !out.blocking.some(b => b.includes('fx:les-ok') && b.startsWith('B6')));
  ok('corpus-whole: B1 dangling archive locator', out.blocking.some(b => b.startsWith('B1') && b.includes('fx:dec-cause-archive-bad')));
  ok('corpus-whole: Banner legal host (no B19 for fx:kernel-small)', !out.blocking.some(b => b.startsWith('B19') && b.includes('fx:kernel-small')));
  ok('corpus-whole: Banner illegal host (B19 for fx:banner-illegal-host)', out.blocking.some(b => b.startsWith('B19') && b.includes('fx:banner-illegal-host')));
  ok('corpus-whole: B9 fires for both ## and ### Index headings', out.report.filter(r => r.startsWith('B9')).length >= 2, out.report.filter(r => r.startsWith('B9')).length);
  const archivedEntries = out.entries.filter(e => e.archived && e.file === 'decisions-archive.md');
  ok('corpus-whole: archive entry without any tag still parses (id=null, valid archive block)', archivedEntries.some(e => e.id === null));
  ok('corpus-whole: archive entry WITH tag keeps it', archivedEntries.some(e => e.id === 'fx:dec-archived-with-tag'));

  // dynamic positive case: Cause resolving to a REAL archive locator (computed, not hand-typed)
  const archived = out.entries.find(e => e.id === 'fx:dec-archived-with-tag');
  ok('corpus-whole: dynamic archive-locator setup found its target block', !!archived);
  if (archived) {
    const causeLine = `Cause: [[archive-sha256:${archived.blockHash64}]]\n`;
    const buf2 = Buffer.concat([
      snap.files['decisions.md'].raw,
      Buffer.from(`\n**2026-01-09 — dynamic Cause→real archive locator (must resolve, no B1)** [fx:dec-cause-archive-dynamic]\n${causeLine}`, 'utf8'),
    ]);
    const snap2 = Object.assign({}, snap, { files: Object.assign({}, snap.files, { 'decisions.md': { raw: buf2, hadBOM: false, missing: false } }) });
    const out2 = core.analyze(snap2, { asOf: '2026-06-01' });
    ok('corpus-whole(dynamic): Cause→real archive locator resolves (no B1 for the dynamic entry)', !out2.blocking.some(b => b.startsWith('B1') && b.includes('fx:dec-cause-archive-dynamic')));
  }
}

// ── migrate-index-bullets/ (via pmm-migrate-v3.computePlan) ──────────────────────────────────
{
  const migrate = require('./pmm-migrate-v3.cjs');
  const dir = path.join(FIX, 'migrate-index-bullets');
  const snap = core.snapshotDir(dir, { requireAll: false }); // fixture intentionally has only decisions.md
  const d1 = { list24: [], sameFileDup: [], crossFileDup: [] };
  const plan = migrate.computePlan(snap, d1, {});
  const kinds = plan.actions.map(a => a.kind);
  ok('mib: ⑤ hook-from-index-rest detected', plan.actions.some(a => a.kind === '⑤hook-from-index-rest' && a.tag === 'fx:mib-hookmove'));
  ok('mib: ⑤ NOT emitted for the oversized row (belongs in ⑩ instead)', !plan.actions.some(a => a.kind === '⑤hook-from-index-rest' && a.tag === 'fx:mib-oversized'));
  ok('mib: ⑩ oversized index row listed', plan.oversizedIndexRows.some(r => r.raw.includes('fx:mib-oversized')));
  ok('mib: ⑦ marker-only supersedes proposed on the correct target', plan.actions.some(a => a.kind === '⑦add-supersedes-to-target' && a.newSupersededBy === 'fx:mib-markeronly-target' && a.sourceTag === 'fx:mib-markeronly-source'));
  ok('mib: ⑦ NOT proposed where a formal Supersedes edge already exists (fx:mib-new→fx:mib-old)', !plan.actions.some(a => a.kind === '⑦add-supersedes-to-target' && a.newSupersededBy === 'fx:mib-old'));
  ok('mib: ⑧ non-standard "clarify" marker classified as prose-link-not-edge', plan.actions.some(a => a.kind === '⑧prose-link-not-edge' && a.tag === 'fx:mib-clarify-target'));
  ok('mib: ⑨ dateRaw-to-hook detected for the (晚) bullet', plan.actions.some(a => a.kind === '⑨daterAW-to-hook' && a.tag === 'fx:mib-late' && a.dateRaw === '(晚)'));
}

// ── unclosed-fence.md (§1.8 / B32, Opus H-8) ──────────────────────────────────────────────────
{
  const buf = readFix('unclosed-fence.md');
  const r = core.parseFile('unclosed-fence.md', buf);
  ok('unclosed-fence: exactly 1 real entry (before the fence)', r.entries.length === 1, JSON.stringify(r.entries.map(e => e.id)));
  ok('unclosed-fence: swallowed near-title never becomes an entry', !r.entries.some(e => e.id === 'fx:swallowed-by-unclosed-fence'));
  const b32 = r.diagnostics.filter(d => d.code === 'B32');
  ok('unclosed-fence: exactly 1 B32 diagnostic', b32.length === 1, JSON.stringify(b32));
  ok('unclosed-fence: B32 points at the FENCE-OPEN line, not EOF', b32[0] && b32[0].line === 10, b32[0] && b32[0].line);
}

// ── §1.7 tag-case symmetry (Opus H-7): identity/link resolution must be symmetric for a ─────────
//    grandfathered uppercase tag — a [[…]] pointing at it must resolve (not become a bare-link B15),
//    and Supersedes/Cause edges to/from it must resolve via ASCII-lowercase compare.
{
  const buf = Buffer.from(
    '**2026-01-01 — uppercase grandfathered tag as identity** [ns:Legacy-Tag]\n' +
    'body.\n\n' +
    '**2026-01-02 — prose link to the uppercase tag, must resolve, not be B15** [ns:linker]\n' +
    'See [[ns:Legacy-Tag]] and also lowercase-spelled [[ns:legacy-tag]] (still the same identity).\n\n' +
    '**2026-01-03 — Cause edge to the uppercase tag via lowercase spelling, must resolve (no B1)** [ns:causer]\n' +
    'Cause: [[ns:legacy-tag]]\n', 'utf8');
  const snap = corpusOf('decisions.md', buf);
  const out = core.analyze(snap, { asOf: '2026-06-01' });
  const byId = Object.fromEntries(out.entries.map(e => [e.id, e]));
  ok('tag-case: uppercase tag resolves as identity', byId['ns:Legacy-Tag'] !== undefined);
  ok('tag-case: link to uppercase tag (exact case) is NOT B15 bare-link', !out.blocking.some(b => b.startsWith('B15') && b.includes('Legacy-Tag')));
  ok('tag-case: link to uppercase tag via lowercase spelling resolves as the SAME link target', byId['ns:linker'].links.includes('ns:legacy-tag') || byId['ns:linker'].links.includes('ns:Legacy-Tag'));
  ok('tag-case: Cause via lowercase spelling to an uppercase-declared identity has no B1 (dangling)', !out.blocking.some(b => b.startsWith('B1') && b.includes('ns:causer')));
}

// ── §1.5 archive exemptions (Opus H-6): B7/B8/B8b/B8c/B13/B14/B16/B22 never fire on archived ────
//    entries — construct a synthetic archive file with several would-be violations and assert zero
//    blocking from those specific codes. 09-15 revision: B15/B23 are now ALSO archive-exempt (spec's
//    intent is a blockHash whitelist of pre-cutover blocks, simplified here to blanket-by-file since
//    C0 never writes to archives — see the code comments at the B15/B23 diagnostic sites); B1/B2'/B5/
//    B6/B17/B19 remain NOT exempt and must still fire where applicable.
{
  const buf = Buffer.from(
    '**2026-01-01 — archived attribution-style ns [user] as identity, no closing issue** [user:legacy]\n' +
    'body one.\n\n' +
    '**2026-01-02 — archived oversized Hook, would be B14 if live**\n' +
    'Hook: ' + 'a'.repeat(400) + '\n\n' +
    '**2099-01-01 — archived future date, would be B22 if live** [ns:archived-future]\n' +
    'body three.\n\n' +
    '**2026-01-03 — archived malformed Supersedes, would be B23 if live** [ns:archived-supersedes]\n' +
    'Supersedes: 澄清 [[ns:archived-future]]\n\n' +
    '**2026-01-04 — archived bare link, would be B15 if live** [ns:archived-barelink]\n' +
    'see [[nope-no-namespace-here]] for context.\n', 'utf8');
  const files = {};
  for (const f of core.ALL_FILES) files[f] = { raw: null, missing: true };
  const { buf: stripped } = core.stripBOM(buf);
  files['decisions-archive.md'] = { raw: stripped, hadBOM: false, missing: false };
  const snap = { view: 'fixture', sourceOids: {}, files };
  const out = core.analyze(snap, { asOf: '2026-06-01' });
  ok('archive-exempt: no B8b for archived [user:*]-style identity', !out.blocking.some(b => b.startsWith('B8b')));
  ok('archive-exempt: no B14 for archived oversized Hook', !out.blocking.some(b => b.startsWith('B14')));
  ok('archive-exempt: no B22 for archived future date', !out.blocking.some(b => b.startsWith('B22')));
  ok('archive-exempt (09-15): no B23 for archived malformed Supersedes', !out.blocking.some(b => b.startsWith('B23')));
  ok('archive-exempt (09-15): no B15 for archived bare link', !out.blocking.some(b => b.startsWith('B15')));
}

// ── Opus B-4: failure semantics — core throws PmmCoreError instead of silent blocking=0/exit=0 ──
{
  ok('B-4: snapshotDir on a completely empty dir throws', (() => {
    const emptyDir = path.join(require('os').tmpdir(), `pmm-c0-empty-${process.pid}-${Date.now()}`);
    fs.mkdirSync(emptyDir, { recursive: true });
    try { core.snapshotDir(emptyDir); return false; }
    catch (e) { return e instanceof core.PmmCoreError && /缺失文件/.test(e.message); }
    finally { try { fs.rmdirSync(emptyDir); } catch {} }
  })());
  ok('B-4: snapshotDir with one file missing throws and NAMES it', (() => {
    const dir = path.join(require('os').tmpdir(), `pmm-c0-partial-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of core.ALL_FILES) { if (f !== 'decisions.md') fs.writeFileSync(path.join(dir, f), ''); }
    try { core.snapshotDir(dir); return false; }
    catch (e) { return e instanceof core.PmmCoreError && e.message.includes('decisions.md'); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  })());
  ok('B-4: snapshot() on an unresolvable git ref throws (bad ref), never silent blocking=0', (() => {
    try { core.snapshot('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'); return false; }
    catch (e) { return e instanceof core.PmmCoreError; }
  })());
  ok('B-4: {requireAll:false} still allows a deliberately partial snapshot (no throw)', (() => {
    const dir = path.join(require('os').tmpdir(), `pmm-c0-partial2-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'decisions.md'), '');
    try { core.snapshotDir(dir, { requireAll: false }); return true; }
    catch (e) { return false; }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  })());
}

// ── W4-B1: snapshotWithOverrides + diffBlocking (C05-BUILD-SPEC 补遗三第 28 条新增导出) ───────────
// Only new exports asserted here — spec 28's "只新增导出,不改既有行为" — every OTHER self-test in
// this file is untouched proof the rest of pmm-core.cjs's behavior didn't move.
{
  const baseFiles = {};
  for (const f of core.ALL_FILES) baseFiles[f] = { raw: Buffer.from(`base ${f}`, 'utf8'), missing: false };
  const baseSnap = { view: 'fixture-base', sourceOids: {}, files: baseFiles };

  const overridden = core.snapshotWithOverrides(baseSnap, { 'lessons.md': Buffer.from('overridden lessons', 'utf8') });
  ok('snapshotWithOverrides: overridden file carries the NEW bytes',
    overridden.files['lessons.md'].raw.toString('utf8') === 'overridden lessons', overridden.files['lessons.md'].raw.toString('utf8'));
  ok('snapshotWithOverrides: untouched file passes through the base snapshot UNCHANGED',
    overridden.files['decisions.md'].raw.toString('utf8') === 'base decisions.md');
  ok('snapshotWithOverrides: base snapshot object itself is not mutated (no shared-reference leak)',
    baseSnap.files['lessons.md'].raw.toString('utf8') === 'base lessons.md');
  const overriddenMissing = core.snapshotWithOverrides(baseSnap, { 'lessons.md': null });
  ok("snapshotWithOverrides: a null override marks that file missing (matches snapshot()'s own shape)",
    overriddenMissing.files['lessons.md'].missing === true && overriddenMissing.missing.includes('lessons.md'));

  // diffBlocking: normalized multiset diff (same algorithm as pmm-precommit-shadow-replay.cjs:55-73,
  // hoisted into core so it isn't duplicated a third time). A same-class violation whose embedded
  // file:line / byte count merely shifted between two snapshots must NOT be reported as new (the exact
  // M1 bug that file's own header documents, `guards/audits/OPUS-2026-09-24-c05-wave2-review.md`);
  // a genuinely new class, or a second occurrence of the SAME class, must be.
  const before = ['B14 lessons.md:100 [x:one] 超长条目 987B', 'B1 decisions.md:5 [x:two] Supersedes 悬空目标'];
  const afterSameClassMovedLine = ['B14 lessons.md:412 [x:one] 超长条目 1200B', 'B1 decisions.md:5 [x:two] Supersedes 悬空目标'];
  ok('diffBlocking: same violation class with only file:line/byte-count drift => no false new entry',
    core.diffBlocking(before, afterSameClassMovedLine).length === 0, core.diffBlocking(before, afterSameClassMovedLine));
  const afterGenuineNew = afterSameClassMovedLine.concat(['B14 lessons.md:900 [x:three] 超长条目 950B']);
  ok('diffBlocking: a genuinely new violation (different tag) IS reported',
    afterGenuineNew && core.diffBlocking(before, afterGenuineNew).includes('B14 lessons.md:# [x:three] 超长条目 #B'),
    core.diffBlocking(before, afterGenuineNew));
  const afterDuplicateSameClass = before.concat(['B14 lessons.md:955 [x:one] 超长条目 1050B']);
  ok('diffBlocking: a SECOND occurrence of the SAME normalized class counts as +1 new (multiset, not set)',
    core.diffBlocking(before, afterDuplicateSameClass).includes('B14 lessons.md:# [x:one] 超长条目 #B'),
    core.diffBlocking(before, afterDuplicateSameClass));
}

// ── CLI-level fault semantics (Opus B-4): pmm-manifest-v2.cjs must surface PMM-CORE-ERROR + ─────
//    non-zero exit, never "blocking=0 exit 0" or empty --index output, on the same fault classes
//    Opus reproduced live against the real corpus.
{
  const { execFileSync } = require('child_process');
  function runCli(args, env) {
    try {
      const out = execFileSync('node', [path.join(__dirname, 'pmm-manifest-v2.cjs'), ...args], { env: Object.assign({}, process.env, env), maxBuffer: 1024 * 1024 * 8 });
      return { code: 0, stdout: out.toString('utf8'), stderr: '' };
    } catch (e) {
      return { code: e.status == null ? 1 : e.status, stdout: (e.stdout || '').toString('utf8'), stderr: (e.stderr || '').toString('utf8') };
    }
  }
  const emptyDir = path.join(require('os').tmpdir(), `pmm-c0-cli-empty-${process.pid}-${Date.now()}`);
  fs.mkdirSync(emptyDir, { recursive: true });
  try {
    let r = runCli(['--check'], { PMM_MEM_DIR: emptyDir });
    ok('B-4 CLI: --check on empty dir exits non-zero', r.code !== 0, r.code);
    ok('B-4 CLI: --check on empty dir prints PMM-CORE-ERROR', /PMM-CORE-ERROR/.test(r.stdout + r.stderr));

    r = runCli(['--index'], { PMM_MEM_DIR: emptyDir });
    ok('B-4 CLI: --index on empty dir exits non-zero (not empty-output-and-0)', r.code !== 0, r.code);
    ok('B-4 CLI: --index on empty dir prints PMM-CORE-ERROR (not silent "## file\\n\\n" stubs)', /PMM-CORE-ERROR/.test(r.stdout + r.stderr));

    r = runCli(['--check', '--from', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']);
    ok('B-4 CLI: --check on a bad git ref exits non-zero', r.code !== 0, r.code);
    ok('B-4 CLI: --check on a bad git ref prints PMM-CORE-ERROR', /PMM-CORE-ERROR/.test(r.stdout + r.stderr));
  } finally {
    try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch {}
  }
}

console.log(`pmm-core golden corpus self-test: ${pass}/${pass + fail}`);
if (fail) {
  console.log('FAILED:');
  for (const f of fails) console.log('  ✖ ' + f);
  process.exit(1);
}
process.exit(0);
