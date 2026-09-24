#!/usr/bin/env node
// AxMem lifecycle uninstall. (P1 2.3, 2026-09-16)
// Finds each manifest target back by its EXACT identity; removes it only
// when identity matches EXACTLY ONCE and the target's current sha256 still
// equals what we recorded at install time (spec: 0 or >=2 matches, or a
// modified target, both refuse with manual steps — never guess).
'use strict';
const fs = require('fs');
const path = require('path');
const lm = require('./install-manifest.cjs');

function fail(msg) {
  console.error(`uninstall: ${msg}`);
  process.exit(3);
}

// --- kind: 'fence' -----------------------------------------------------
// identity = {begin, end}. Counts occurrences of the marker pair (0 or 1 by
// fence.cjs's own construction, but verified rather than assumed) and, if
// exactly one, strips those lines out — leaving everything else untouched.
function removeFenceTarget(target, { dryRun = false } = {}) {
  let buf;
  try { buf = fs.readFileSync(target.path); } catch (e) { return { ok: false, reason: `cannot read ${target.path}: ${e.message}` }; }
  const curSha = require('crypto').createHash('sha256').update(buf).digest('hex');
  if (target.post_sha256 && curSha !== target.post_sha256) {
    return { ok: false, reason: `${target.path} has changed since install (sha256 mismatch) — refusing; inspect and remove the ${target.identity.begin} / ${target.identity.end} block by hand` };
  }
  let bom = Buffer.alloc(0);
  let body = buf;
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) { bom = buf.slice(0, 3); body = buf.slice(3); }
  const text = body.toString('utf8');
  const useCRLF = /\r\n/.test(text);
  const hadTrailingNewline = text.length === 0 ? true : /\n$/.test(text.replace(/\r\n/g, '\n'));
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.length === 0 ? [] : (normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n'));
  const beginIdxs = [];
  const endIdxs = [];
  lines.forEach((l, i) => { if (l === target.identity.begin) beginIdxs.push(i); if (l === target.identity.end) endIdxs.push(i); });
  if (beginIdxs.length !== 1 || endIdxs.length !== 1) {
    return { ok: false, reason: `expected exactly 1 match of the ${target.identity.begin}/${target.identity.end} marker pair in ${target.path}, found begin=${beginIdxs.length} end=${endIdxs.length} — refusing` };
  }
  if (dryRun) return { ok: true, dryRun: true };
  const newLines = [...lines.slice(0, beginIdxs[0]), ...lines.slice(endIdxs[0] + 1)];
  let newText = newLines.join('\n');
  if (hadTrailingNewline && newLines.length) newText += '\n';
  if (useCRLF) newText = newText.replace(/\n/g, '\r\n');
  const newBuf = Buffer.concat([bom, Buffer.from(newText, 'utf8')]);
  const dir = path.dirname(path.resolve(target.path));
  const staging = path.join(dir, `.${path.basename(target.path)}.axmem-staging-${process.pid}-${Date.now()}`);
  fs.writeFileSync(staging, newBuf);
  fs.renameSync(staging, target.path);
  return { ok: true };
}

// --- kind: 'json-hook' on a JSON file (Claude Code) ---------------------
function removeJsonHookTarget(target, { dryRun = false } = {}) {
  let raw;
  try { raw = fs.readFileSync(target.path, 'utf8'); } catch (e) { return { ok: false, reason: `cannot read ${target.path}: ${e.message}` }; }
  const curSha = lm.sha256Text(raw);
  if (target.post_sha256 && curSha !== target.post_sha256) {
    return { ok: false, reason: `${target.path} has changed since install (sha256 mismatch) — refusing; remove the ${target.identity.event}/${target.identity.matcher} hook by hand` };
  }
  let settings;
  try { settings = JSON.parse(raw); } catch (e) { return { ok: false, reason: `cannot parse ${target.path}: ${e.message}` }; }
  const groups = (settings.hooks && settings.hooks[target.identity.event]) || [];
  let matches = 0;
  for (const g of groups) {
    const matcherOk = target.identity.matcher ? g.matcher === target.identity.matcher : !g.matcher;
    if (!matcherOk || !Array.isArray(g.hooks)) continue;
    matches += g.hooks.filter((h) => h.command === target.identity.normalized_command).length;
  }
  if (matches !== 1) {
    return { ok: false, reason: `expected exactly 1 match for ${target.identity.event}/${target.identity.matcher}/"${target.identity.normalized_command}" in ${target.path}, found ${matches} — refusing` };
  }
  if (dryRun) return { ok: true, dryRun: true };
  for (const g of groups) {
    const matcherOk = target.identity.matcher ? g.matcher === target.identity.matcher : !g.matcher;
    if (!matcherOk || !Array.isArray(g.hooks)) continue;
    g.hooks = g.hooks.filter((h) => h.command !== target.identity.normalized_command);
  }
  settings.hooks[target.identity.event] = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length > 0);
  if (settings.hooks[target.identity.event].length === 0) delete settings.hooks[target.identity.event];
  fs.writeFileSync(target.path, JSON.stringify(settings, null, 2) + '\n');
  return { ok: true };
}

// --- kind: 'json-hook' on a YAML file (Hermes) ---------------------------
// Simplification (documented in the builder report): this conservative
// writer never merges into a populated hooks: block (see adapters/hermes/
// wire.cjs's own refusal for that shape), so ALL FOUR Hermes targets are
// tied to the exact same hooks: block text it wrote. Uninstall therefore
// treats them as one atomic unit: if every target's recorded post_sha256
// still matches the file's current sha256, the whole hooks: block (and
// only that block) is removed textually via the same begin/end style scan
// wire.cjs's own analyze() uses to find it.
function removeYamlHooksBlock(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) { return { ok: false, reason: `cannot read ${filePath}: ${e.message}` }; }
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const hooksIdx = lines.findIndex((l) => /^hooks:\s*(#.*)?$/.test(l));
  if (hooksIdx === -1) return { ok: false, reason: `no hooks: key found in ${filePath} — refusing` };
  let end = lines.length;
  for (let i = hooksIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    if (/^(\s*)/.exec(l)[1].length === 0) { end = i; break; }
  }
  const newLines = [...lines.slice(0, hooksIdx), ...lines.slice(end)];
  fs.writeFileSync(filePath, newLines.join('\n'));
  return { ok: true };
}

function removeAdapterHermes(entry, { dryRun = false } = {}) {
  const byPath = new Map();
  for (const t of entry.targets) {
    if (!byPath.has(t.path)) byPath.set(t.path, []);
    byPath.get(t.path).push(t);
  }
  for (const [filePath, targets] of byPath) {
    let curSha;
    try { curSha = lm.sha256Text(fs.readFileSync(filePath, 'utf8')); } catch (e) { return { ok: false, reason: `cannot read ${filePath}: ${e.message}` }; }
    for (const t of targets) {
      if (t.post_sha256 && curSha !== t.post_sha256) {
        return { ok: false, reason: `${filePath} has changed since install (sha256 mismatch for ${t.identity.event}) — refusing; remove the hooks: block by hand` };
      }
    }
    if (dryRun) continue;
    const r = removeYamlHooksBlock(filePath);
    if (!r.ok) return r;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Top-level: uninstall one adapter
// ---------------------------------------------------------------------------
function uninstallAdapter(stateDir, adapterName, { dryRun = false } = {}) {
  let manifest;
  try {
    manifest = lm.readManifest(stateDir);
  } catch (e) {
    // [ts M5] A corrupt manifest must never be treated as "adapter not
    // installed" (silently doing nothing while real fence/hook state may
    // still be live on disk) — surface it as the same {ok:false} shape
    // every other refusal here uses, which the CLI dispatch below already
    // turns into fail()'s rc 3 + printed manual-steps message.
    if (e instanceof lm.ManifestCorruptError) return { ok: false, reason: e.message };
    throw e;
  }
  const entry = manifest.adapters[adapterName];
  if (!entry || entry.targets.length === 0) {
    return { ok: false, reason: `no manifest entry for adapter "${adapterName}" — nothing to uninstall` };
  }

  if (adapterName === 'hermes') {
    const r = removeAdapterHermes(entry, { dryRun });
    if (!r.ok) return r;
  } else {
    for (const t of entry.targets) {
      const r = t.kind === 'fence' ? removeFenceTarget(t, { dryRun }) : removeJsonHookTarget(t, { dryRun });
      if (!r.ok) return r;
    }
  }

  if (!dryRun) lm.removeAdapter(stateDir, adapterName);
  return { ok: true };
}

module.exports = { uninstallAdapter, removeFenceTarget, removeJsonHookTarget, removeYamlHooksBlock };

// ---------------------------------------------------------------------------
// CLI + self-test
// ---------------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--self-test') {
    process.exit(selfTest());
  } else {
    const dryRun = argv.includes('--dry-run');
    const ai = argv.indexOf('--adapter');
    const adapterName = ai >= 0 ? argv[ai + 1] : null;
    // Same resolution chain (env > config.json > default) every other .cjs
    // component uses — NOT a bare process.env read, since bin/axmem's shell
    // variables are never `export`ed to child processes (pre-existing repo
    // convention: each component re-resolves via prelude itself).
    const stateDir = process.env.AXMEM_STATE_DIR || require('../lib/prelude.cjs').STATE_DIR;
    if (!adapterName) {
      console.error('usage: node uninstall.cjs --adapter <name> [--dry-run]');
      process.exit(1);
    }
    const r = uninstallAdapter(stateDir, adapterName, { dryRun });
    if (!r.ok) fail(r.reason);
    console.log(`uninstall: ${adapterName} ${dryRun ? 'would be removed (dry-run)' : 'removed'}`);
    process.exit(0);
  }
}

function selfTest() {
  const os = require('os');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-uninstall-selftest-'));
  let ok = 0;
  const results = [];
  function check(name, cond) { if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }

  // 1. fence uninstall: removes exactly the marked block, preserves surrounding content
  {
    const stateDir = path.join(T, 's1');
    const target = path.join(T, 'AGENTS.md');
    fs.writeFileSync(target, 'keep before\n<!-- axmem:begin -->\nour content\n<!-- axmem:end -->\nkeep after\n');
    const sha = lm.sha256Text(fs.readFileSync(target, 'utf8'));
    lm.recordTarget(stateDir, 'codex', { path: target, kind: 'fence', identity: { begin: '<!-- axmem:begin -->', end: '<!-- axmem:end -->' }, expected_count: 1, pre_sha256: null, post_sha256: sha });
    const r = uninstallAdapter(stateDir, 'codex');
    const finalText = fs.readFileSync(target, 'utf8');
    check('1 fence uninstall: block removed, surrounding content intact', r.ok && finalText.includes('keep before') && finalText.includes('keep after') && !finalText.includes('our content'));
  }

  // 2. fence uninstall refuses when target was modified since install (sha mismatch)
  {
    const stateDir = path.join(T, 's2');
    const target = path.join(T, 'AGENTS2.md');
    fs.writeFileSync(target, '<!-- axmem:begin -->\nx\n<!-- axmem:end -->\n');
    lm.recordTarget(stateDir, 'codex', { path: target, kind: 'fence', identity: { begin: '<!-- axmem:begin -->', end: '<!-- axmem:end -->' }, expected_count: 1, pre_sha256: null, post_sha256: 'deadbeef' });
    const r = uninstallAdapter(stateDir, 'codex');
    check('2 fence uninstall refuses on sha256 mismatch (target modified since install)', r.ok === false);
  }

  // 3. JSON hook uninstall: removes exactly the matching hook, keeps a user's other hooks
  {
    const stateDir = path.join(T, 's3');
    const settingsPath = path.join(T, 'settings.json');
    const settings = { hooks: { PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'bash gate.sh' }, { type: 'command', command: 'echo user-owned' }] }] } };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    const sha = lm.sha256Text(fs.readFileSync(settingsPath, 'utf8'));
    lm.recordTarget(stateDir, 'claude_code', { path: settingsPath, kind: 'json-hook', identity: { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', normalized_command: 'bash gate.sh' }, expected_count: 1, pre_sha256: null, post_sha256: sha });
    const r = uninstallAdapter(stateDir, 'claude_code');
    const final = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const remaining = final.hooks.PostToolUse[0].hooks.map((h) => h.command);
    check('3 json-hook uninstall: removes only our entry, keeps the user-owned one', r.ok && remaining.length === 1 && remaining[0] === 'echo user-owned');
  }

  // 4. JSON hook uninstall refuses when identity matches 0 times (already removed by hand)
  {
    const stateDir = path.join(T, 's4');
    const settingsPath = path.join(T, 'settings4.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2) + '\n');
    const sha = lm.sha256Text(fs.readFileSync(settingsPath, 'utf8'));
    lm.recordTarget(stateDir, 'claude_code', { path: settingsPath, kind: 'json-hook', identity: { event: 'PostToolUse', matcher: 'Edit', normalized_command: 'bash gate.sh' }, expected_count: 1, pre_sha256: null, post_sha256: sha });
    const r = uninstallAdapter(stateDir, 'claude_code');
    check('4 json-hook uninstall refuses on 0 matches', r.ok === false);
  }

  // 5. JSON hook uninstall refuses when identity matches 2+ times (duplicate entries)
  {
    const stateDir = path.join(T, 's5');
    const settingsPath = path.join(T, 'settings5.json');
    const settings = { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'bash gate.sh' }, { type: 'command', command: 'bash gate.sh' }] }] } };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    const sha = lm.sha256Text(fs.readFileSync(settingsPath, 'utf8'));
    lm.recordTarget(stateDir, 'claude_code', { path: settingsPath, kind: 'json-hook', identity: { event: 'PostToolUse', matcher: 'Edit', normalized_command: 'bash gate.sh' }, expected_count: 1, pre_sha256: null, post_sha256: sha });
    const r = uninstallAdapter(stateDir, 'claude_code');
    check('5 json-hook uninstall refuses on 2+ matches (duplicate entries)', r.ok === false);
  }

  // 6. no manifest entry -> refuses
  {
    const stateDir = path.join(T, 's6-empty');
    fs.mkdirSync(stateDir, { recursive: true });
    const r = uninstallAdapter(stateDir, 'codex');
    check('6 no manifest entry -> refuses', r.ok === false);
  }

  // 7. --dry-run performs the same checks but writes nothing
  {
    const stateDir = path.join(T, 's7');
    const target = path.join(T, 'AGENTS7.md');
    fs.writeFileSync(target, 'keep\n<!-- axmem:begin -->\nx\n<!-- axmem:end -->\n');
    const before = fs.readFileSync(target);
    const sha = lm.sha256Text(before.toString('utf8'));
    lm.recordTarget(stateDir, 'codex', { path: target, kind: 'fence', identity: { begin: '<!-- axmem:begin -->', end: '<!-- axmem:end -->' }, expected_count: 1, pre_sha256: null, post_sha256: sha });
    const r = uninstallAdapter(stateDir, 'codex', { dryRun: true });
    const after = fs.readFileSync(target);
    check('7 --dry-run makes no changes', r.ok && Buffer.compare(before, after) === 0 && lm.readManifest(stateDir).adapters.codex);
  }

  // 8 (Opus H3 false-green): fence uninstall refuses when the marker pair
  // is missing (0 matches) — mirrors test 4's json-hook coverage, which
  // previously had no fence-kind equivalent, so a mutation breaking the
  // fence form's uniqueness check (line ~39) went undetected.
  {
    const stateDir = path.join(T, 's8');
    const target = path.join(T, 'AGENTS8.md');
    fs.writeFileSync(target, 'no markers here at all\n');
    const sha = lm.sha256Text(fs.readFileSync(target, 'utf8'));
    lm.recordTarget(stateDir, 'codex', { path: target, kind: 'fence', identity: { begin: '<!-- axmem:begin -->', end: '<!-- axmem:end -->' }, expected_count: 1, pre_sha256: null, post_sha256: sha });
    const r = uninstallAdapter(stateDir, 'codex');
    check('8 (Opus H3) fence uninstall refuses on 0 matches (markers missing)', r.ok === false && fs.readFileSync(target, 'utf8') === 'no markers here at all\n');
  }

  // 8b (Opus H3 false-green): fence uninstall refuses when the marker
  // pair appears twice (2+ matches) — the fence-kind mirror of test 5.
  {
    const stateDir = path.join(T, 's8b');
    const target = path.join(T, 'AGENTS8b.md');
    const content = '<!-- axmem:begin -->\nfirst\n<!-- axmem:end -->\nmiddle\n<!-- axmem:begin -->\nsecond\n<!-- axmem:end -->\n';
    fs.writeFileSync(target, content);
    const sha = lm.sha256Text(content);
    lm.recordTarget(stateDir, 'codex', { path: target, kind: 'fence', identity: { begin: '<!-- axmem:begin -->', end: '<!-- axmem:end -->' }, expected_count: 1, pre_sha256: null, post_sha256: sha });
    const r = uninstallAdapter(stateDir, 'codex');
    check('8b (Opus H3) fence uninstall refuses on 2+ matches (duplicate marker pairs)', r.ok === false && fs.readFileSync(target, 'utf8') === content);
  }

  // 9 (ts M5): a corrupt manifest (adapters:null) must surface as {ok:false}
  // via ManifestCorruptError, not "no manifest entry" (which would look
  // identical to a genuinely-never-installed adapter and hide real
  // corruption of already-recorded install state).
  {
    const stateDir = path.join(T, 's9');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lm.manifestPath(stateDir), JSON.stringify({ version: lm.MANIFEST_VERSION, adapters: null }));
    const r = uninstallAdapter(stateDir, 'codex');
    check('9 (ts M5) corrupt manifest (adapters:null) refuses with the ManifestCorruptError message, not a generic "no entry"', r.ok === false && /malformed "adapters" field/.test(r.reason));
  }

  console.log(results.join('\n'));
  console.log(`uninstall self-test ${ok}/10`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
  return ok === 10 ? 0 : 1;
}
