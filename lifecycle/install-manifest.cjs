#!/usr/bin/env node
// AxMem lifecycle manifest. (P1 2.3, 2026-09-16)
// AXMEM_STATE_DIR/lifecycle.json — one entry per installed adapter, each
// listing the exact targets it touched with enough identity to find them
// again UNAMBIGUOUSLY at uninstall time (spec §2.3): a fence's marker pair
// + the exact inner content it wrote (kind:'fence'), or a hook's precise
// {event, matcher, normalized_command} triple (kind:'json-hook', used for
// both Claude Code's JSON settings and Hermes's YAML hooks: block — same
// identity shape, different host file format).
// Versioned, atomically written (same-directory staging + rename), never
// silently loses a prior adapter's entry when recording a new one.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_VERSION = 1;

function manifestPath(stateDir) {
  return path.join(stateDir, 'lifecycle.json');
}

// [ts M5] Thrown (never silently swallowed) when lifecycle.json EXISTS but
// is unparseable or has a malformed `adapters` field. A missing file
// (ENOENT) is the normal "no adapters installed yet" first-run case and
// still returns a fresh manifest — but a file that exists with garbage
// content means real, already-recorded install state may be present and
// unreadable; silently replacing it with an empty manifest (the old
// behavior) would make uninstall/upgrade believe nothing is installed,
// orphaning fence markers and hook entries with nothing left to find them
// by. Exported so callers can `instanceof` it.
class ManifestCorruptError extends Error {}

function readManifest(stateDir) {
  const p = manifestPath(stateDir);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { version: MANIFEST_VERSION, adapters: {} };
    throw new ManifestCorruptError(`cannot read manifest "${p}": ${e.message}. Manual steps: inspect the file's permissions/existence by hand, then retry.`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new ManifestCorruptError(`manifest "${p}" is not valid JSON: ${e.message}. Manual steps: inspect and repair "${p}" by hand (it should be {"version":${MANIFEST_VERSION},"adapters":{...}}), or move it aside ONLY if you are certain no adapters are currently installed, then retry.`);
  }
  // The previous check here (`typeof data.adapters === 'object'`) also
  // accepted `adapters: null` (typeof null === 'object' in JS) and
  // `adapters: []` (typeof [] === 'object' too) — both silently fell
  // through to the SAME fresh-empty-manifest fallback as a missing file,
  // discarding whatever real install records existed instead of flagging
  // the corruption.
  const adaptersOk = data && typeof data === 'object' && data.adapters && typeof data.adapters === 'object' && !Array.isArray(data.adapters);
  if (!adaptersOk) {
    throw new ManifestCorruptError(`manifest "${p}" has a malformed "adapters" field (expected a non-null, non-array object, got ${JSON.stringify(data && data.adapters)}) — refusing to silently treat existing installs as empty. Manual steps: inspect and repair "${p}" by hand, or move it aside ONLY if you are certain no adapters are currently installed, then retry.`);
  }
  return data;
}

function writeManifestAtomic(stateDir, data) {
  fs.mkdirSync(stateDir, { recursive: true });
  const p = manifestPath(stateDir);
  const staging = path.join(stateDir, `.lifecycle.json.axmem-staging-${process.pid}-${Date.now()}`);
  fs.writeFileSync(staging, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(staging, p);
}

function sha256File(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Records/updates ONE target under an adapter's entry. `target` shape:
//   { path, kind: 'fence'|'json-hook', identity, expected_count, pre_sha256, post_sha256 }
// Re-recording the SAME (adapter, path, identity) triple updates in place
// (idempotent wiring re-runs must not accumulate duplicate manifest rows).
function recordTarget(stateDir, adapterName, target) {
  const data = readManifest(stateDir);
  if (!data.adapters[adapterName]) {
    data.adapters[adapterName] = { installed_at: new Date().toISOString(), owner_id: crypto.randomUUID(), targets: [] };
  }
  const entry = data.adapters[adapterName];
  const idx = entry.targets.findIndex((t) => t.path === target.path && JSON.stringify(t.identity) === JSON.stringify(target.identity));
  if (idx >= 0) entry.targets[idx] = target; else entry.targets.push(target);
  writeManifestAtomic(stateDir, data);
  return data;
}

function removeTarget(stateDir, adapterName, path_, identity) {
  const data = readManifest(stateDir);
  const entry = data.adapters[adapterName];
  if (!entry) return data;
  entry.targets = entry.targets.filter((t) => !(t.path === path_ && JSON.stringify(t.identity) === JSON.stringify(identity)));
  if (entry.targets.length === 0) delete data.adapters[adapterName];
  writeManifestAtomic(stateDir, data);
  return data;
}

function removeAdapter(stateDir, adapterName) {
  const data = readManifest(stateDir);
  delete data.adapters[adapterName];
  writeManifestAtomic(stateDir, data);
  return data;
}

module.exports = {
  MANIFEST_VERSION,
  manifestPath,
  readManifest,
  writeManifestAtomic,
  sha256File,
  sha256Text,
  recordTarget,
  removeTarget,
  removeAdapter,
  ManifestCorruptError,
};

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------
function selfTest() {
  const os = require('os');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-lifecycle-manifest-selftest-'));
  let ok = 0;
  const results = [];
  function check(name, cond) { if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }

  // 1. fresh manifest is empty and well-formed
  {
    const m = readManifest(T);
    check('1 fresh manifest well-formed', m.version === MANIFEST_VERSION && typeof m.adapters === 'object' && Object.keys(m.adapters).length === 0);
  }

  // 2. recordTarget creates the adapter entry and persists across re-reads
  {
    recordTarget(T, 'codex', { path: '/x/AGENTS.md', kind: 'fence', identity: { begin: 'B', end: 'E' }, expected_count: 1, pre_sha256: null, post_sha256: 'abc' });
    const m = readManifest(T);
    check('2 recordTarget persists', !!m.adapters.codex && m.adapters.codex.targets.length === 1 && m.adapters.codex.targets[0].post_sha256 === 'abc');
  }

  // 3. re-recording the SAME (path, identity) updates in place, no duplicate
  {
    recordTarget(T, 'codex', { path: '/x/AGENTS.md', kind: 'fence', identity: { begin: 'B', end: 'E' }, expected_count: 1, pre_sha256: 'abc', post_sha256: 'def' });
    const m = readManifest(T);
    check('3 re-record updates in place, no duplicate', m.adapters.codex.targets.length === 1 && m.adapters.codex.targets[0].post_sha256 === 'def');
  }

  // 4. a second adapter's entry never clobbers the first
  {
    recordTarget(T, 'hermes', { path: '/x/config.yaml', kind: 'json-hook', identity: { event: 'post_tool_call', matcher: 'm', normalized_command: 'c' }, expected_count: 1, pre_sha256: null, post_sha256: 'zzz' });
    const m = readManifest(T);
    check('4 second adapter does not clobber the first', !!m.adapters.codex && !!m.adapters.hermes);
  }

  // 5. removeTarget drops just that target, and drops the adapter entirely once empty
  {
    removeTarget(T, 'hermes', '/x/config.yaml', { event: 'post_tool_call', matcher: 'm', normalized_command: 'c' });
    const m = readManifest(T);
    check('5 removeTarget drops the adapter once its last target is gone', !m.adapters.hermes && !!m.adapters.codex);
  }

  // 6. sha256Text is stable and distinguishes different content
  {
    check('6 sha256Text stable + distinguishing', sha256Text('a') === sha256Text('a') && sha256Text('a') !== sha256Text('b'));
  }

  // 7 (ts M5): a manifest file with `adapters: null` on disk must throw
  // ManifestCorruptError, NOT be silently treated as an empty manifest
  // (the old `typeof null === 'object'` bug let this pass validation).
  {
    const T7 = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-lifecycle-manifest-selftest-badadapters-'));
    fs.writeFileSync(manifestPath(T7), JSON.stringify({ version: MANIFEST_VERSION, adapters: null }));
    let threw = false;
    let isRightType = false;
    try {
      readManifest(T7);
    } catch (e) {
      threw = true;
      isRightType = e instanceof ManifestCorruptError;
    }
    check('7 (ts M5) manifest with adapters:null throws ManifestCorruptError instead of silently returning an empty manifest', threw && isRightType);
    try { fs.rmSync(T7, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // 7b (ts M5): a manifest file with `adapters: []` (an array, also
  // `typeof === 'object'`) is equally rejected.
  {
    const T7b = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-lifecycle-manifest-selftest-arrayadapters-'));
    fs.writeFileSync(manifestPath(T7b), JSON.stringify({ version: MANIFEST_VERSION, adapters: [] }));
    let threw = false;
    try {
      readManifest(T7b);
    } catch (e) {
      threw = e instanceof ManifestCorruptError;
    }
    check('7b (ts M5) manifest with adapters:[] (array) also throws ManifestCorruptError', threw);
    try { fs.rmSync(T7b, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // 7c: a genuinely MISSING manifest file (first run, no lifecycle.json
  // yet) is NOT corruption — must still return a fresh empty manifest,
  // never throw. (Guards against an over-broad fix that would break the
  // normal first-install path.)
  {
    const T7c = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-lifecycle-manifest-selftest-missing-'));
    let threw = false;
    let m = null;
    try {
      m = readManifest(T7c);
    } catch (e) {
      threw = true;
    }
    check('7c missing manifest file (no prior install) still returns a fresh empty manifest, does not throw', !threw && m && m.version === MANIFEST_VERSION && Object.keys(m.adapters).length === 0);
    try { fs.rmSync(T7c, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(results.join('\n'));
  console.log(`install-manifest self-test ${ok}/9`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
  return ok === 9 ? 0 : 1;
}

if (require.main === module && process.argv[2] === '--self-test') {
  process.exit(selfTest());
}
