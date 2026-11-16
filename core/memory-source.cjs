'use strict';
// Bounded, local, content-bound source IO shared by the Codex and CC selectors.
// No stateful legacy hook, network access, or manifest subprocess on the CC path.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseFile } = require('../guards/pmm-core.cjs');
const FILES = Object.freeze(['decisions.md', 'lessons.md', 'standinginstructions.md',
  'classes.md', 'decisions-archive.md', 'lessons-archive.md', 'standinginstructions-archive.md']);
const REQUIRED = new Set(FILES.slice(0, 3));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
class SelectorError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
function fail(reason) { throw new SelectorError(reason); }
function localMemoryRoot(memoryRoot, platform) {
  if (typeof memoryRoot !== 'string' || !memoryRoot || /[\u0000-\u001f\u007f]/.test(memoryRoot)) return false;
  const slashedRoot = memoryRoot.replace(/\\/g, '/');
  if (slashedRoot.startsWith('//') || /^\/(?:\?\?|Device)\//i.test(slashedRoot) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(slashedRoot) && !/^[A-Za-z]:\/(?!\/)/.test(slashedRoot)) return false;
  return platform === 'win32' ? /^[A-Za-z]:\/(?!\/)/.test(slashedRoot) :
    !memoryRoot.includes('\\') && path.posix.isAbsolute(memoryRoot);
}
// Optional CC-only cache. The default readSources contract (used by Codex)
// still reads and hashes every byte, with no cache or state writes.
let cacheVersion;
function getCacheVersion() {
  return cacheVersion ||= 'cc-source-v2:' + sha(fs.readFileSync(require.resolve('../guards/pmm-core.cjs')));
}
function stamp(s) { return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]; }
function equalStamp(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function readSources(memoryRoot, options = {}) {
  if (!localMemoryRoot(memoryRoot, process.platform)) fail('invalid-input');
  let rootStat, root;
  try { rootStat = fs.lstatSync(memoryRoot); root = fs.realpathSync(memoryRoot); }
  catch { fail('source-unavailable'); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('source-unsafe');
  const files = new Map();
  let total = 0;
  for (const name of FILES) {
    options.checkDeadline?.();
    const file = path.join(root, name);
    let before;
    try { before = fs.lstatSync(file); }
    catch (error) {
      if (error && error.code === 'ENOENT') { if (REQUIRED.has(name)) fail('missing-required-source'); continue; }
      fail('source-unavailable');
    }
    if (!before.isFile() || before.isSymbolicLink()) fail('source-unsafe');
    let real;
    try { real = fs.realpathSync(file); } catch { fail('source-unavailable'); }
    const rel = path.relative(root, real);
    if (rel !== name || rel.startsWith('..') || path.isAbsolute(rel)) fail('source-unsafe');
    if (before.size > 4 * 1024 * 1024) fail('source-too-large');
    total += before.size;
    if (total > 12 * 1024 * 1024) fail('source-too-large');
    const cacheFile = options.cacheDir && path.join(options.cacheDir, sha(root), name + '.json');
    const version = cacheFile && getCacheVersion();
    let cached;
    if (cacheFile) {
      try {
        if (fs.statSync(cacheFile).size <= 32 * 1024 * 1024) {
          const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          if (c.version === version && equalStamp(c.stamp, stamp(before)) &&
              Array.isArray(c.lines) && Array.isArray(c.parsed?.entries) && Array.isArray(c.parsed?.diagnostics) &&
              /^[a-f0-9]{64}$/.test(c.hash)) cached = c;
        }
      } catch { /* Missing/corrupt derived cache: rebuild from the source. */ }
    }
    options.checkDeadline?.();
    let source;
    if (cached) source = { hash: cached.hash, lines: cached.lines, parsed: cached.parsed };
    else {
      let bytes;
      try { bytes = fs.readFileSync(file); } catch { fail('source-unavailable'); }
      if (bytes.length !== before.size) fail('source-changed');
      source = { hash: sha(bytes), bytes, lines: bytes.toString('utf8').split(/\r?\n/) };
      if (cacheFile) source.parsed = parseFile(name, bytes);
    }
    let after;
    try { after = fs.lstatSync(file); } catch { fail('source-unavailable'); }
    const changed = options.cacheDir || options.metadataChecks ? !equalStamp(stamp(before), stamp(after)) :
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size;
    if (!after.isFile() || after.isSymbolicLink() || changed) fail('source-changed');
    options.checkDeadline?.();
    if (cacheFile && !cached) {
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
        require('../lib/atomic-write.cjs').writeFileAtomicSync(cacheFile, JSON.stringify({ version, stamp: stamp(after),
          hash: source.hash, lines: source.lines, parsed: source.parsed }), { mode: 0o600 });
      } catch { /* Cache is an optimization, never a source availability gate. */ }
    }
    files.set(name, { ...source, size: after.size, dev: after.dev, ino: after.ino, stamp: stamp(after) });
  }
  return { root, rootDev: rootStat.dev, rootIno: rootStat.ino, files };
}
function sameSources(a, b) {
  if (a.root !== b.root || a.rootDev !== b.rootDev || a.rootIno !== b.rootIno || a.files.size !== b.files.size) return false;
  for (const [name, file] of a.files) {
    const other = b.files.get(name);
    if (!other || other.hash !== file.hash || other.size !== file.size || other.dev !== file.dev || other.ino !== file.ino) return false;
  }
  return true;
}
// Revalidation between stages uses metadata, not another full read. Include
// ctime/device/inode as well as mtime+size, and still reject symlink replacement.
function sourcesUnchanged(sources, checkDeadline) {
  checkDeadline?.();
  try {
    const root = fs.lstatSync(sources.root);
    if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== sources.rootDev || root.ino !== sources.rootIno) return false;
    for (const name of FILES) {
      checkDeadline?.();
      const old = sources.files.get(name);
      let s;
      try { s = fs.lstatSync(path.join(sources.root, name)); }
      catch (e) { if (e.code === 'ENOENT' && !old) continue; return false; }
      if (!old || !s.isFile() || s.isSymbolicLink() || !equalStamp(old.stamp, stamp(s))) return false;
    }
    return true;
  } catch (e) { if (e.reason === 'recall-deadline-exceeded') throw e; return false; }
}
function loadCorpus(memoryRoot, options = {}) {
  const sources = readSources(memoryRoot, { ...options, metadataChecks: true }), entries = [], diagnostics = [], badTags = new Set();
  for (const [file, source] of sources.files) {
    options.checkDeadline?.();
    const parsed = source.parsed || parseFile(file, source.bytes);
    source.parsed = parsed;
    for (const d of parsed.diagnostics) {
      // A handwritten Index and grandfathered uppercase identity are compatible.
      if (!['B9', 'B8c'].includes(d.code)) diagnostics.push({ code: d.code, file, line: d.line });
      if (['B8', 'B23', 'B32'].includes(d.code)) {
        for (const e of parsed.entries) {
          if (e.id && (e.id === d.tag || d.line >= e.lineRange[0] && d.line <= e.lineRange[1])) badTags.add(e.id);
        }
      }
    }
    for (const e of parsed.entries) {
      if (!e.id) continue;
      if (e.id.length > 512) { diagnostics.push({ code: 'identity-too-long', file, line: e.titleLineNo }); continue; }
      entries.push({ tag: e.id, file, line: e.lineRange[0], endLine: e.lineRange[1],
        title: e.title, date: e.dateISO, trust: e.trust, archived: e.archived,
        text: e.body.replace(/\r\n?/g, '\n').replace(/\n$/, ''), supersedes: e.supersedes,
        classId: e.class, triggers: e.triggers });
    }
  }
  if (entries.length > 5000) fail('source-too-large');
  const identities = new Map();
  for (const e of entries) {
    const key = e.tag.toLowerCase();
    if (identities.has(key)) { badTags.add(e.tag); badTags.add(identities.get(key)); }
    identities.set(key, e.tag);
  }
  // Legacy Index arrows cannot establish a current rule on their own. A
  // redirect must also be proved by the successor's parsed Supersedes field.
  for (const [file, source] of sources.files) for (const [i, line] of source.lines.entries()) {
    if (!/^- 20/.test(line) || !line.includes('superseded→')) continue;
    const old = /\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/.exec(line)?.[1];
    const target = /superseded→\[([A-Za-z0-9:._-]+)\]/.exec(line)?.[1];
    const head = target && (target.includes(':') ? target : old?.split(':')[0] + ':' + target);
    if (old && !entries.some((e) => e.tag === head && e.supersedes.includes(old))) {
      badTags.add(old); diagnostics.push({ code: 'unverified-index-redirect', file, line: i + 1 });
    }
  }
  if (!sourcesUnchanged(sources, options.checkDeadline)) fail('source-changed');
  const snapshotId = sha(JSON.stringify([...sources.files].map(([name, f]) => [name, f.hash])));
  return { sources, entries, diagnostics, badTags, snapshotId };
}
module.exports = { FILES, REQUIRED, SelectorError, readSources, sameSources, loadCorpus, sourcesUnchanged, sha };

if (require.main === module && process.argv.includes('--self-test')) {
  // Shared source integrity is exercised together with real hook transport.
  require('../adapters/claude-code/test-hook.cjs').componentSelfTest('source').catch((e) => { console.error(e); process.exitCode = 1; });
}
