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
function readSources(memoryRoot) {
  if (!localMemoryRoot(memoryRoot, process.platform)) fail('invalid-input');
  let rootStat, root;
  try { rootStat = fs.lstatSync(memoryRoot); root = fs.realpathSync(memoryRoot); }
  catch { fail('source-unavailable'); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('source-unsafe');
  const files = new Map();
  let total = 0;
  for (const name of FILES) {
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
    let bytes, after;
    try { bytes = fs.readFileSync(file); after = fs.lstatSync(file); } catch { fail('source-unavailable'); }
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || bytes.length !== after.size) fail('source-changed');
    total += bytes.length;
    if (total > 12 * 1024 * 1024) fail('source-too-large');
    files.set(name, { hash: sha(bytes), size: bytes.length, dev: after.dev, ino: after.ino,
      bytes, lines: bytes.toString('utf8').split(/\r?\n/) });
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
function loadCorpus(memoryRoot) {
  const sources = readSources(memoryRoot), entries = [], diagnostics = [], badTags = new Set();
  for (const [file, source] of sources.files) {
    const parsed = parseFile(file, source.bytes);
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
  if (!sameSources(sources, readSources(memoryRoot))) fail('source-changed');
  const snapshotId = sha(JSON.stringify([...sources.files].map(([name, f]) => [name, f.hash])));
  return { sources, entries, diagnostics, badTags, snapshotId };
}
module.exports = { FILES, REQUIRED, SelectorError, readSources, sameSources, loadCorpus, sha };

if (require.main === module && process.argv.includes('--self-test')) {
  // Shared source integrity is exercised together with real hook transport.
  require('../adapters/claude-code/test-hook.cjs').componentSelfTest('source').catch((e) => { console.error(e); process.exitCode = 1; });
}
