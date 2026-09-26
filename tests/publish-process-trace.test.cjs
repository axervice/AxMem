#!/usr/bin/env node
// tests/publish-process-trace.test.cjs -- W22-U1b unit tests for scripts/publish-public.cjs's
// scrub.processTraces step (step5b_scrubProcessTraces, runs after `replacements` and before
// `sanitize`) and the GATE4 `processTrace:*` pattern group it feeds.
//
// EXCLUDED from the public export (see publish.manifest.json's exclude list,
// "_comment_PUBLISH_PROCESS_TRACE_TEST"): it requires scripts/publish-public.cjs and
// publish.manifest.json, both private-only. Deliberately does NOT contain the literal string
// "--self-test" so bin/axmem's component-selftest auto-discovery never sweeps it in.
//
// Every file this test writes lives in a mkdtemp'd scratch directory -- never the real repo's
// working tree, never a real ref/branch.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const pp = require('../scripts/publish-public.cjs');

let ok = 0;
let total = 0;
const failures = [];

function check(label, cond) {
  total++;
  if (cond) { ok++; console.log('  ok   ' + label); }
  else { failures.push(label); console.log('  FAIL ' + label); }
}

function expectThrows(label, fn) {
  total++;
  try {
    fn();
    failures.push(label + ' (did not throw)');
    console.log('  FAIL ' + label + ' (did not throw)');
  } catch (e) {
    ok++;
    console.log('  ok   ' + label + ' -> ' + String(e.message || e).slice(0, 140));
  }
}

function makeExportDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-pt-export-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function rule(id, pattern, mode, replace, flags, fallback) {
  const r = { id, pattern, flags: flags || 'g', mode, replace };
  if (fallback) r.fallback = fallback;
  return r;
}

// A minimal, self-contained fixture manifest -- deliberately NOT the real publish.manifest.json, so
// these tests stay stable even as the real rule set evolves.
function fixtureManifest(rules, opts) {
  opts = opts || {};
  return { scrub: { processTraces: {
    extensions: opts.extensions || ['.sh', '.cjs', '.js', '.md', '.json', '.txt', '.yml'],
    filenames: opts.filenames || [],
    paths: opts.paths || [],
    rules,
  } } };
}

console.log('== manifest schema validation ==');
{
  check('empty scrub is accepted', (() => { try { pp.validateProcessTraceRules(undefined); return true; } catch { return false; } })());
  check('valid rule set passes', (() => {
    try { pp.validateProcessTraceRules({ processTraces: { rules: [rule('r1', 'x', 'replace', 'y')] } }); return true; } catch (e) { console.log('    (' + e.message + ')'); return false; }
  })());
  expectThrows('missing "mode" is rejected', () => {
    pp.validateProcessTraceRules({ processTraces: { rules: [{ id: 'r1', pattern: 'x', replace: 'y' }] } });
  });
  expectThrows('mode "replace" without "replace" text is rejected', () => {
    pp.validateProcessTraceRules({ processTraces: { rules: [{ id: 'r1', pattern: 'x', mode: 'replace' }] } });
  });
  expectThrows('invalid mode value is rejected', () => {
    pp.validateProcessTraceRules({ processTraces: { rules: [rule('r1', 'x', 'delete-everything', 'y')] } });
  });
  expectThrows('duplicate rule id is rejected', () => {
    pp.validateProcessTraceRules({ processTraces: { rules: [rule('dup', 'x', 'replace', 'y'), rule('dup', 'z', 'replace', 'w')] } });
  });
  expectThrows('empty pattern is rejected', () => {
    pp.validateProcessTraceRules({ processTraces: { rules: [rule('r1', '', 'replace', 'y')] } });
  });
  // 'drop-line' mode does not require a "replace" field.
  check('mode "drop-line" without "replace" text passes', (() => {
    try { pp.validateProcessTraceRules({ processTraces: { rules: [{ id: 'r1', pattern: 'x', mode: 'drop-line' }] } }); return true; } catch (e) { console.log('    (' + e.message + ')'); return false; }
  })());
  // The real publish.manifest.json's own scrub section must validate cleanly end-to-end.
  check('real publish.manifest.json scrub section passes schema validation', (() => { try { pp.readManifest(); return true; } catch (e) { console.log('    (real manifest error: ' + e.message + ')'); return false; } })());
}

console.log('== replace mode ==');
{
  const manifest = fixtureManifest([rule('jax-ruling', 'Jax[^\\n]{0,10}拍板', 'replace', '(project decision)')]);
  const dir = makeExportDir({
    'guards/x.sh': '#!/usr/bin/env bash\n# 2026-01-01 Jax 拍板 加 glob 支持\necho hi\n',
  });
  pp.step5b_scrubProcessTraces(dir, manifest);
  const out = fs.readFileSync(path.join(dir, 'guards/x.sh'), 'utf8');
  check('replace mode neutralizes the match in place, keeps rest of the comment', out.includes('# 2026-01-01 (project decision) 加 glob 支持') && out.includes('echo hi'));
  check('replace mode does not touch unrelated lines', out.includes('#!/usr/bin/env bash'));
}

console.log('== drop-line mode: four comment syntaxes ==');
{
  // bash '#'
  {
    const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line')]);
    const dir = makeExportDir({ 'a.sh': '#!/usr/bin/env bash\n# TRACE-MARKER internal note\necho keep\n' });
    pp.step5b_scrubProcessTraces(dir, manifest);
    const out = fs.readFileSync(path.join(dir, 'a.sh'), 'utf8');
    check('bash "#" comment line is dropped whole', !out.includes('TRACE-MARKER') && out.includes('echo keep') && out.includes('#!/usr/bin/env bash'));
  }
  // JS '//'
  {
    const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line')]);
    const dir = makeExportDir({ 'a.cjs': "'use strict';\n// TRACE-MARKER internal note\nconsole.log('keep');\n" });
    pp.step5b_scrubProcessTraces(dir, manifest);
    const out = fs.readFileSync(path.join(dir, 'a.cjs'), 'utf8');
    check('JS "//" comment line is dropped whole', !out.includes('TRACE-MARKER') && out.includes("console.log('keep')"));
  }
  // JS '/* ... */' block (multi-line)
  {
    const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line')]);
    const dir = makeExportDir({ 'a.cjs': "/*\n * intro\n * TRACE-MARKER internal note\n * more\n */\nconsole.log('keep');\n" });
    pp.step5b_scrubProcessTraces(dir, manifest);
    const out = fs.readFileSync(path.join(dir, 'a.cjs'), 'utf8');
    check('JS multi-line block-comment line is dropped whole', !out.includes('TRACE-MARKER') && out.includes('intro') && out.includes('more') && out.includes("console.log('keep')"));
  }
  // JS single-line '/* ... */'
  {
    const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line')]);
    const dir = makeExportDir({ 'a.cjs': "/* TRACE-MARKER inline block comment */\nconsole.log('keep');\n" });
    pp.step5b_scrubProcessTraces(dir, manifest);
    const out = fs.readFileSync(path.join(dir, 'a.cjs'), 'utf8');
    check('JS single-line block comment is dropped whole', !out.includes('TRACE-MARKER') && out.includes("console.log('keep')"));
  }
  // Markdown prose (outside a fence)
  {
    const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line')]);
    const dir = makeExportDir({ 'a.md': '# Title\n\nTRACE-MARKER internal note.\n\nKeep this line.\n' });
    pp.step5b_scrubProcessTraces(dir, manifest);
    const out = fs.readFileSync(path.join(dir, 'a.md'), 'utf8');
    check('Markdown prose line is dropped whole', !out.includes('TRACE-MARKER') && out.includes('Keep this line.') && out.includes('# Title'));
  }
  // Markdown fenced code block -- NOT prose, must fail closed
  expectThrows('Markdown line inside a fenced code block is refused (not prose)', () => {
    const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line')]);
    const dir = makeExportDir({ 'a.md': '# Title\n\n```js\nconst x = "TRACE-MARKER";\n```\n' });
    pp.step5b_scrubProcessTraces(dir, manifest);
  });
  // JSON "_comment*" string value
  {
    const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line')]);
    const dir = makeExportDir({ 'a.json': '{\n "_comment_x": "TRACE-MARKER internal note",\n "keep": "value"\n}\n' });
    pp.step5b_scrubProcessTraces(dir, manifest);
    const out = fs.readFileSync(path.join(dir, 'a.json'), 'utf8');
    check('JSON "_comment*" line is dropped whole, rest of the object survives', !out.includes('TRACE-MARKER') && out.includes('"keep": "value"'));
    check('the result is still valid JSON', (() => { try { JSON.parse(out); return true; } catch { return false; } })());
  }
}

console.log('== drop-line mode: code-line match FAILS the export (path:line) ==');
{
  expectThrows('a match on an executable JS code line is refused, not silently dropped', () => {
    const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line')]);
    const dir = makeExportDir({ 'guards/x.cjs': "'use strict';\nconst TRACE_MARKER_TOKEN = 'TRACE-MARKER';\n" });
    pp.step5b_scrubProcessTraces(dir, manifest);
  });
  {
    // Confirm the thrown message actually names path:line (not just "some code line somewhere").
    const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line')]);
    const dir = makeExportDir({ 'guards/x.cjs': "'use strict';\nconst TRACE_MARKER_TOKEN = 'TRACE-MARKER';\n" });
    let message = null;
    try { pp.step5b_scrubProcessTraces(dir, manifest); } catch (e) { message = e.message; }
    check('error names the offending path and 1-based line number', !!message && message.indexOf('guards/x.cjs:2') !== -1 || (message || '').indexOf('guards' + require('path').sep + 'x.cjs:2') !== -1);
  }
  expectThrows('a match on a JSON data field (not "_comment*") is refused, not silently dropped', () => {
    const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line')]);
    const dir = makeExportDir({ 'a.json': '{\n "notes": "TRACE-MARKER real data field, not a _comment"\n}\n' });
    pp.step5b_scrubProcessTraces(dir, manifest);
  });
}

console.log('== extensions gating ==');
{
  const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'replace', '(x)')], { extensions: ['.sh'] });
  const dir = makeExportDir({ 'a.sh': '# TRACE-MARKER\n', 'a.py': '# TRACE-MARKER\n' });
  pp.step5b_scrubProcessTraces(dir, manifest);
  check('a file whose extension is not in processTraces.extensions is left untouched', fs.readFileSync(path.join(dir, 'a.py'), 'utf8').includes('TRACE-MARKER'));
  check('a file whose extension IS in processTraces.extensions is scrubbed', !fs.readFileSync(path.join(dir, 'a.sh'), 'utf8').includes('TRACE-MARKER'));
}

console.log('== manifest-driven: adding a rule with no code change alters the output ==');
{
  const dirA = makeExportDir({ 'a.sh': '# alpha TRACE-ONE beta TRACE-TWO gamma\n' });
  const dirB = makeExportDir({ 'a.sh': '# alpha TRACE-ONE beta TRACE-TWO gamma\n' });
  pp.step5b_scrubProcessTraces(dirA, fixtureManifest([rule('r1', 'TRACE-ONE', 'replace', '(x)')]));
  pp.step5b_scrubProcessTraces(dirB, fixtureManifest([rule('r1', 'TRACE-ONE', 'replace', '(x)'), rule('r2', 'TRACE-TWO', 'replace', '(y)')]));
  const outA = fs.readFileSync(path.join(dirA, 'a.sh'), 'utf8');
  const outB = fs.readFileSync(path.join(dirB, 'a.sh'), 'utf8');
  check('one-rule manifest leaves the second marker untouched', outA.includes('TRACE-TWO'));
  check('two-rule manifest (same code, one more manifest entry) neutralizes both', !outB.includes('TRACE-ONE') && !outB.includes('TRACE-TWO'));
}

console.log('== GATE4 processTrace pattern group ==');
{
  const { execFileSync } = require('child_process');
  const REPO_ROOT = pp.REPO_ROOT;
  function hashObject(buf) { return execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: REPO_ROOT, input: buf }).toString('utf8').trim(); }
  function buildTree(entries) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-pt-idx-'));
    const tmpIndex = path.join(tmpDir, 'index');
    const env = Object.assign({}, process.env, { GIT_INDEX_FILE: tmpIndex, GIT_DIR: path.join(REPO_ROOT, '.git') });
    for (const e of entries) execFileSync('git', ['update-index', '--add', '--cacheinfo', e.mode + ',' + e.sha + ',' + e.testPath], { cwd: REPO_ROOT, env });
    const tree = execFileSync('git', ['write-tree'], { cwd: REPO_ROOT, env, encoding: 'utf8' }).trim();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return tree;
  }
  function blobEntry(testPath, content) { return { testPath, mode: '100644', sha: hashObject(Buffer.from(content, 'utf8')) }; }

  const fixtureManifestForGate4 = {
    sanitizeLiteralFallback: {},
    denylist: { identityLiterals: [], internalNames: [] },
    binaryAllowlist: [],
    scrub: { processTraces: { rules: [rule('leaked-review-id', 'OPUS-20\\d\\d-\\d\\d-\\d\\d', 'replace', '(review report)')] } },
  };

  const clean = blobEntry('clean.txt', 'nothing interesting here\n');
  // Simulates a real bug: this trace slipped through step5b (e.g. a hand-added file that bypassed the
  // scrub step, or a future code change to step5b that regresses) and reached the final tree unscrubbed.
  const slipped = blobEntry('leak.md', 'see OPUS-2026-09-26-defense-export-pipeline.md for the full review\n');
  const tree = buildTree([clean, slipped]);
  const findings = pp.gate4_finalTreeScan(tree, fixtureManifestForGate4);
  check('GATE4 catches a process-trace that slipped past scrub, names the path', findings.some((f) => f.path === 'leak.md' && /processTrace:leaked-review-id/.test(f.issue)));
  check('a clean file produces no processTrace finding', !findings.some((f) => f.path === 'clean.txt' && /processTrace:/.test(f.issue)));

  const scrubbed = blobEntry('ok.md', 'see (review report) for the full review\n');
  const tree2 = buildTree([clean, scrubbed]);
  const findings2 = pp.gate4_finalTreeScan(tree2, fixtureManifestForGate4);
  check('a properly-scrubbed file produces no processTrace finding', !findings2.some((f) => /processTrace:/.test(f.issue)));
}

// ---------------------------------------------------------------------------------------------
// 2026-09-26 GATE4 follow-up: real end-to-end export caught `.gitignore`'s ".codex-reviews" ignore-entry
// and `bin/axmem`'s "codex(gf) LOW #8" citation both shipping unscrubbed -- step5b never scanned either
// file at all, because hasProcessTraceExtension() only matches a SUFFIX and neither path ends in any of
// .sh/.cjs/.js/.md/.json/.txt/.yml. These tests reproduce that exact real-shaped failure (RED without
// the `filenames`/`paths` fix) and confirm the fix (GREEN with it).
console.log('== filenames/paths: dotfiles and extensionless scripts are in scope ==');
{
  // RED: without `filenames`, a `.gitignore`-shaped file is invisible to step5b entirely.
  {
    const manifest = fixtureManifest([rule('codex-reviews-dir', '\\.codex-reviews', 'replace', '.review-notes')]);
    const dir = makeExportDir({ '.gitignore': 'node_modules/\n.codex-reviews/\n' });
    pp.step5b_scrubProcessTraces(dir, manifest);
    check('RED (pre-fix shape): a .gitignore-like dotfile with no `filenames` entry is left untouched', fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('.codex-reviews'));
  }
  // GREEN: with `filenames: ['.gitignore']`, the same file gets scrubbed.
  {
    const manifest = fixtureManifest([rule('codex-reviews-dir', '\\.codex-reviews', 'replace', '.review-notes')], { filenames: ['.gitignore'] });
    const dir = makeExportDir({ '.gitignore': 'node_modules/\n.codex-reviews/\n' });
    pp.step5b_scrubProcessTraces(dir, manifest);
    const out = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    check('GREEN: a .gitignore matched via `filenames` is scrubbed, the real ignore entry survives renamed', !out.includes('.codex-reviews') && out.includes('.review-notes/') && out.includes('node_modules/'));
  }
  // RED: an extensionless shebang script (bin/axmem-shaped) is invisible without `paths`.
  {
    const manifest = fixtureManifest([rule('codex-finding', 'codex\\([a-z]+\\)\\s*(?:HIGH|LOW|MEDIUM)?\\s*#\\d+', 'replace', '(review finding)')]);
    const dir = makeExportDir({ 'bin/axmem': "#!/usr/bin/env bash\n# [codex(gf) LOW #8, 2026-09-17] quoting fix\necho hi\n" });
    pp.step5b_scrubProcessTraces(dir, manifest);
    check('RED (pre-fix shape): an extensionless script with no `paths` entry is left untouched', fs.readFileSync(path.join(dir, 'bin/axmem'), 'utf8').includes('codex(gf)'));
  }
  // GREEN: with `paths: ['bin/axmem']`, the same file gets scrubbed (and is classified 'hash'/bash for
  // drop-line purposes, per resolveScrubKind()'s documented default for a `paths` match).
  {
    const manifest = fixtureManifest([rule('codex-finding', 'codex\\([a-z]+\\)\\s*(?:HIGH|LOW|MEDIUM)?\\s*#\\d+', 'replace', '(review finding)')], { paths: ['bin/axmem'] });
    const dir = makeExportDir({ 'bin/axmem': "#!/usr/bin/env bash\n# [codex(gf) LOW #8, 2026-09-17] quoting fix\necho hi\n" });
    pp.step5b_scrubProcessTraces(dir, manifest);
    const out = fs.readFileSync(path.join(dir, 'bin/axmem'), 'utf8');
    check('GREEN: bin/axmem matched via `paths` is scrubbed, rest of the script survives', out.includes('(review finding)') && !out.includes('codex(gf)') && out.includes('echo hi'));
  }
  check('resolveScrubKind: a `filenames` match resolves to the hash-comment kind', pp.resolveScrubKind('.gitignore', { scrub: { processTraces: { filenames: ['.gitignore'] } } }) === 'hash');
  check('resolveScrubKind: a `paths` match resolves to the hash-comment kind', pp.resolveScrubKind('bin/axmem', { scrub: { processTraces: { paths: ['bin/axmem'] } } }) === 'hash');
  check('resolveScrubKind: an unmatched extensionless path resolves to null (out of scope)', pp.resolveScrubKind('bin/other-tool', { scrub: { processTraces: {} } }) === null);
}

console.log('== drop-line classifier: ignore-file syntax (.gitignore/.gitattributes/.npmignore) ==');
{
  const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line')], { filenames: ['.gitignore'] });
  const dir = makeExportDir({ '.gitignore': '# TRACE-MARKER internal note\nnode_modules/\n.env\n' });
  pp.step5b_scrubProcessTraces(dir, manifest);
  const out = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  check('a "#" comment line in an ignore-file is dropped whole', !out.includes('TRACE-MARKER') && out.includes('node_modules/') && out.includes('.env'));

  expectThrows('a real ignore-pattern line (not a comment) is refused, not silently dropped', () => {
    const m = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line')], { filenames: ['.gitignore'] });
    const d = makeExportDir({ '.gitignore': 'node_modules/\nTRACE-MARKER/\n' });
    pp.step5b_scrubProcessTraces(d, m);
  });
}

console.log('== fallback: a drop-line rule that hits a non-droppable line neutralizes in place instead of failing ==');
{
  // RED equivalent (already covered above by expectThrows without a fallback) -- these confirm the
  // fallback actually fires and the file otherwise stays intact, for the two real-shaped cases the
  // ruling's follow-up named: an ignore-file pattern line, and a code-line string literal.
  {
    const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line', null, 'g', { mode: 'replace', with: '(x)' })], { filenames: ['.gitignore'] });
    const dir = makeExportDir({ '.gitignore': 'node_modules/\nTRACE-MARKER/\n.env\n' });
    pp.step5b_scrubProcessTraces(dir, manifest);
    const out = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    check('fallback on an ignore-pattern line: substring replaced, line (and file) survives', out.includes('(x)/') && !out.includes('TRACE-MARKER') && out.includes('node_modules/') && out.includes('.env'));
  }
  {
    const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line', null, 'g', { mode: 'replace', with: '(y)' })]);
    const dir = makeExportDir({ 'guards/x.cjs': "'use strict';\nconst TOKEN = 'TRACE-MARKER';\nconsole.log(TOKEN);\n" });
    pp.step5b_scrubProcessTraces(dir, manifest);
    const out = fs.readFileSync(path.join(dir, 'guards/x.cjs'), 'utf8');
    check('fallback on a code-line string literal: substring replaced, code structure survives', out.includes("const TOKEN = '(y)';") && out.includes('console.log(TOKEN);'));
  }
  // A rule that ALSO matches a real comment line elsewhere in the same file: comment lines still drop
  // normally, only the non-droppable line falls back.
  {
    const manifest = fixtureManifest([rule('trace', 'TRACE-MARKER', 'drop-line', null, 'g', { mode: 'replace', with: '(z)' })]);
    const dir = makeExportDir({ 'guards/x.sh': '#!/usr/bin/env bash\n# TRACE-MARKER in a comment\nVAR="TRACE-MARKER"\necho "$VAR"\n' });
    pp.step5b_scrubProcessTraces(dir, manifest);
    const out = fs.readFileSync(path.join(dir, 'guards/x.sh'), 'utf8');
    check('mixed file: the comment line is dropped AND the code line falls back to replace, both in one pass', !out.includes('# TRACE-MARKER') && out.includes('VAR="(z)"') && out.includes('echo "$VAR"'));
  }
}

console.log('== fallback schema validation ==');
{
  expectThrows('"fallback" on a "replace"-mode rule is rejected', () => {
    pp.validateProcessTraceRules({ processTraces: { rules: [rule('r1', 'x', 'replace', 'y', 'g', { mode: 'replace', with: 'z' })] } });
  });
  expectThrows('"fallback.mode" other than "replace" is rejected', () => {
    pp.validateProcessTraceRules({ processTraces: { rules: [rule('r1', 'x', 'drop-line', null, 'g', { mode: 'drop-line', with: 'z' })] } });
  });
  expectThrows('"fallback" missing "with" is rejected', () => {
    pp.validateProcessTraceRules({ processTraces: { rules: [rule('r1', 'x', 'drop-line', null, 'g', { mode: 'replace' })] } });
  });
  check('a valid drop-line + fallback rule passes schema validation', (() => {
    try { pp.validateProcessTraceRules({ processTraces: { rules: [rule('r1', 'x', 'drop-line', null, 'g', { mode: 'replace', with: 'y' })] } }); return true; } catch (e) { console.log('    (' + e.message + ')'); return false; }
  })());
  // The real publish.manifest.json's new `filenames`/`paths` fields must validate cleanly too.
  check('real publish.manifest.json filenames/paths pass schema validation', (() => { try { pp.readManifest(); return true; } catch (e) { console.log('    (real manifest error: ' + e.message + ')'); return false; } })());
}

console.log('\npublish-process-trace self-test ' + ok + '/' + total);
if (ok !== total) {
  console.error('FAILED: ' + failures.join('; '));
  process.exitCode = 1;
}
