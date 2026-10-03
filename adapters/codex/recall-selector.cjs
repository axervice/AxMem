'use strict';

// Read-only lexical selector. The manifest CLI owns PMM syntax and replacement
// parsing; this module binds its metadata back to unchanged source bytes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const MiniSearch = require('../../guards/vendor/minisearch/index.cjs');

const MANIFEST = path.resolve(__dirname, '../../core/manifest.cjs');
const REPO = path.resolve(__dirname, '../..');
const FILES = Object.freeze(['decisions.md', 'lessons.md', 'standinginstructions.md',
  'classes.md', 'decisions-archive.md', 'lessons-archive.md', 'standinginstructions-archive.md']);
const REQUIRED = new Set(FILES.slice(0, 3));
const FILE_SET = new Set(FILES);
const TRUST = new Set(['observed', 'derived', 'user-ratified', null]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MANIFEST_TIMEOUT_MS = 5000;
const TAG = /^[a-z][a-z0-9-]*:[A-Za-z0-9._-]+$/;

class SelectorError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
function fail(reason) { throw new SelectorError(reason); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function result(status, reason, items = [], warnings = []) { return { status, reason, items, warnings }; }
function tagIn(text) { return typeof text === 'string' && TAG.test(text); }

function localMemoryRoot(memoryRoot, platform) {
  if (typeof memoryRoot !== 'string' || !memoryRoot || memoryRoot.includes('\0'))
    return false;
  const slashedRoot = memoryRoot.replace(/\\/g, '/');
  // Do this before any fs call. UNC and Win32 device namespaces may cross a
  // network boundary even when path.isAbsolute considers them valid paths.
  if (slashedRoot.startsWith('//') || /^\/(?:\?\?|Device)\//i.test(slashedRoot) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(slashedRoot) && !/^[A-Za-z]:\/(?!\/)/.test(slashedRoot))
    return false;
  return platform === 'win32' ? /^[A-Za-z]:\/(?!\/)/.test(slashedRoot) :
    !memoryRoot.includes('\\') && path.posix.isAbsolute(memoryRoot);
}
function readSources(memoryRoot) {
  if (!localMemoryRoot(memoryRoot, process.platform)) fail('invalid-input');
  let rootStat, root;
  try {
    rootStat = fs.lstatSync(memoryRoot);
    root = fs.realpathSync(memoryRoot);
  } catch { fail('source-unavailable'); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('source-unsafe');
  const files = new Map();
  let total = 0;
  for (const name of FILES) {
    const file = path.join(root, name);
    let before;
    try { before = fs.lstatSync(file); }
    catch (error) {
      if (error && error.code === 'ENOENT') {
        if (REQUIRED.has(name)) fail('missing-required-source');
        continue;
      }
      fail('source-unavailable');
    }
    if (!before.isFile() || before.isSymbolicLink()) fail('source-unsafe');
    let real;
    try { real = fs.realpathSync(file); } catch { fail('source-unavailable'); }
    const rel = path.relative(root, real);
    if (rel !== name || rel.startsWith('..') || path.isAbsolute(rel)) fail('source-unsafe');
    if (before.size > MAX_FILE_BYTES) fail('source-too-large');
    let bytes, after;
    try { bytes = fs.readFileSync(file); after = fs.lstatSync(file); }
    catch { fail('source-unavailable'); }
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || bytes.length !== after.size) fail('source-changed');
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) fail('source-too-large');
    files.set(name, { hash: sha(bytes), size: bytes.length, dev: after.dev, ino: after.ino,
      lines: bytes.toString('utf8').split(/\r?\n/) });
  }
  return { root, rootDev: rootStat.dev, rootIno: rootStat.ino, files };
}
function sameSources(a, b) {
  if (a.root !== b.root || a.rootDev !== b.rootDev || a.rootIno !== b.rootIno ||
      a.files.size !== b.files.size) return false;
  for (const [name, file] of a.files) {
    const other = b.files.get(name);
    if (!other || other.hash !== file.hash || other.size !== file.size ||
        other.dev !== file.dev || other.ino !== file.ino) return false;
  }
  return true;
}

function manifestEnv(root) {
  // All paths are explicit, including config and state, so prelude never falls
  // back to the user's HOME. The isolation directory is never created.
  const isolated = path.join(os.tmpdir(), 'axmem-selector-' + crypto.randomBytes(12).toString('hex'));
  return {
    AXMEM_MEMORY_DIR: root, AXMEM_HOME: isolated,
    AXMEM_CONFIG: path.join(isolated, 'config.json'), AXMEM_STATE_DIR: path.join(isolated, 'state'),
    HOME: isolated, USERPROFILE: isolated, APPDATA: isolated, LOCALAPPDATA: isolated,
    XDG_CONFIG_HOME: isolated, XDG_STATE_HOME: isolated, XDG_DATA_HOME: isolated,
    XDG_CACHE_HOME: isolated, TEMP: isolated, TMP: isolated, TMPDIR: isolated,
    SystemRoot: process.env.SystemRoot || '', WINDIR: process.env.WINDIR || '',
    PATH: process.env.PATH || '',
  };
}
function runManifest(root) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [MANIFEST, '--json'], {
        cwd: REPO, env: manifestEnv(root), windowsHide: true, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { resolve({ error: 'manifest-failed' }); return; }
    const chunks = [];
    let size = 0, stderrSize = 0, ended = false, failure = null;
    const timer = setTimeout(() => { failure = 'manifest-timeout'; child.kill(); }, MANIFEST_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_MANIFEST_BYTES) { failure = 'manifest-too-large'; child.kill(); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize > 65536) { failure = 'manifest-failed'; child.kill(); }
    });
    child.on('error', () => { failure = 'manifest-failed'; });
    child.on('close', (code) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (failure) { resolve({ error: failure }); return; }
      if (code !== 0 && code !== 2) { resolve({ error: 'manifest-failed' }); return; }
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { resolve({ error: 'manifest-invalid' }); return; }
      resolve({ code, parsed });
    });
  });
}

function boundEntries(manifest, sources) {
  if (!manifest || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_ENTRIES ||
      !Array.isArray(manifest.blocking) || !Array.isArray(manifest.report) ||
      !manifest.heads || typeof manifest.heads !== 'object' || Array.isArray(manifest.heads))
    fail('manifest-invalid');
  const entries = [];
  for (const entry of manifest.entries) {
    if (!entry || !tagIn(entry.tag) || !FILE_SET.has(entry.file) ||
        !Number.isInteger(entry.line) || !Number.isInteger(entry.endLine) ||
        !Array.isArray(entry.supersedes) || typeof entry.blockHash !== 'string' ||
        !/^[a-f0-9]{16}$/.test(entry.blockHash) ||
        entry.archived !== entry.file.includes('-archive')) fail('manifest-invalid');
    const source = sources.files.get(entry.file);
    if (!source || entry.line < 1 || entry.endLine < entry.line || entry.endLine > source.lines.length)
      fail('manifest-source-mismatch');
    const blockLines = source.lines.slice(entry.line - 1, entry.endLine);
    const text = blockLines.join('\n');
    const firstLine = source.lines[entry.line - 1];
    // manifest.cjs deliberately skips every `- 20...` line while building
    // _body, even when it occurs inside an entry. Bind to that projection,
    // while the returned item's hash covers its actual unfiltered excerpt.
    const parserProjection = blockLines.filter((line) => !line.startsWith('- 20')).join('\n');
    if (!firstLine.includes('[' + entry.tag + ']') ||
        sha(Buffer.from(parserProjection, 'utf8')).slice(0, 16) !== entry.blockHash)
      fail('manifest-source-mismatch');
    if (entry.supersedes.some((old) => !tagIn(old))) fail('manifest-invalid');
    entries.push({ ...entry, text });
  }
  return entries;
}

function graphOf(entries, manifest) {
  const byTag = new Map(), next = new Map(), adjacent = new Map(), bad = new Set();
  function link(a, b) {
    if (!tagIn(a) || !tagIn(b)) fail('manifest-invalid');
    if (!adjacent.has(a)) adjacent.set(a, new Set());
    if (!adjacent.has(b)) adjacent.set(b, new Set());
    adjacent.get(a).add(b); adjacent.get(b).add(a);
  }
  function edge(a, b) {
    link(a, b);
    if (!next.has(a)) next.set(a, new Set());
    next.get(a).add(b);
  }
  for (const entry of entries) {
    if (!byTag.has(entry.tag)) byTag.set(entry.tag, []);
    byTag.get(entry.tag).push(entry);
    if (!adjacent.has(entry.tag)) adjacent.set(entry.tag, new Set());
    for (const old of entry.supersedes) edge(old, entry.tag);
  }
  for (const [tag, group] of byTag) if (group.length !== 1) bad.add(tag);
  for (const [old, head] of Object.entries(manifest.heads)) {
    if (!tagIn(old) || !tagIn(head)) fail('manifest-invalid');
    link(old, head);
    if (!next.has(old) && old !== head) edge(old, head);
    if (!byTag.has(head)) bad.add(old);
    // A marker-only chain can be collapsed by manifest's eight-hop headOf.
    // If that purported head itself still has a successor, the value is a
    // truncation, not a unique current head; quarantine its whole component.
    if (Object.hasOwn(manifest.heads, head) && manifest.heads[head] !== head) bad.add(old);
  }
  for (const line of manifest.report) {
    if (typeof line !== 'string') fail('manifest-invalid');
    if (line.startsWith('FORK ')) {
      const tags = line.match(/[a-z][a-z0-9-]*:[A-Za-z0-9._-]+/g) || [];
      if (!tags.length) fail('manifest-invalid');
      bad.add(tags[0]);
      for (const tag of tags.slice(1)) link(tags[0], tag);
    } else if (line.startsWith('DUP ') || line.startsWith('NONSTD ')) {
      const tag = /\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/.exec(line);
      if (!tag) fail('manifest-invalid');
      bad.add(tag[1]);
    }
  }
  // Manifest's headOf stops after eight hops; never use that truncated value.
  function headOf(tag) {
    let current = tag;
    const seen = new Set();
    for (let depth = 0; depth <= 8; depth++) {
      if (seen.has(current)) { bad.add(tag); return null; }
      seen.add(current);
      const to = next.get(current);
      if (!to || to.size === 0) return current;
      if (to.size !== 1 || depth === 8) { bad.add(tag); return null; }
      current = [...to][0];
    }
    bad.add(tag); return null;
  }
  for (const tag of byTag.keys()) headOf(tag);
  const excluded = new Set(), queue = [...bad];
  while (queue.length) {
    const tag = queue.pop();
    if (excluded.has(tag)) continue;
    excluded.add(tag);
    for (const other of adjacent.get(tag) || []) queue.push(other);
  }
  return { byTag, next, excluded, headOf };
}

function tokenize(text) {
  const normalized = String(text).normalize('NFC').toLowerCase();
  const words = normalized.match(/[a-z0-9._:-]+/g) || [];
  for (const run of normalized.match(/\p{Script=Han}+/gu) || []) {
    if (run.length === 1) words.push(run);
    else for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2));
  }
  return words;
}
function citedTags(scan, graph) {
  const found = [];
  const left = (ch) => ch === undefined || /[\s"'([{,;，。；、\p{Script=Han}]/u.test(ch);
  const right = (ch) => ch === undefined || /[\s"')\]},;!?，。；、\p{Script=Han}]/u.test(ch);
  for (const match of scan.matchAll(/[a-z][a-z0-9-]*:[A-Za-z0-9._-]+/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!left(scan[start - 1]) || !right(scan[end])) continue;
    let tag = match[0];
    if (!graph.byTag.has(tag) && /\.$/.test(tag)) {
      // A complete known tag ending in a dot wins. Only otherwise interpret
      // terminal dots as sentence punctuation; never peel `.txt` or suffixes.
      const withoutTerminalDots = tag.replace(/\.+$/, '');
      if (graph.byTag.get(withoutTerminalDots)?.length === 1 &&
          !graph.excluded.has(withoutTerminalDots)) tag = withoutTerminalDots;
    }
    if (graph.byTag.has(tag) && !found.includes(tag)) found.push(tag);
    if (found.length >= 4) break;
  }
  return found;
}
function select(entries, graph, query, scan, limit) {
  const current = entries.filter((entry) => REQUIRED.has(entry.file) && !entry.archived && !graph.excluded.has(entry.tag) &&
    graph.byTag.get(entry.tag).length === 1 && !graph.next.has(entry.tag) && TRUST.has(entry.trust));
  const byTag = new Map(current.map((entry) => [entry.tag, entry]));
  const docs = current.map((entry) => ({ id: entry.tag, title: entry.title || '', body: entry.text }));
  const mini = new MiniSearch({ idField: 'id', fields: ['title', 'body'], storeFields: [],
    tokenize, processTerm: (term) => term, searchOptions: { combineWith: 'OR', prefix: false, fuzzy: false } });
  if (docs.length) mini.addAll(docs);
  const ranked = [];
  for (const tag of citedTags(scan, graph)) {
    if (graph.excluded.has(tag) || !graph.byTag.has(tag)) continue;
    const source = graph.byTag.get(tag)[0];
    if (!TRUST.has(source.trust)) continue;
    const head = graph.headOf(tag);
    if (head && byTag.has(head) && !ranked.includes(byTag.get(head))) ranked.push(byTag.get(head));
  }
  for (const found of mini.search(query).slice(0, limit + 20)) {
    const entry = byTag.get(found.id);
    if (entry && !ranked.includes(entry)) ranked.push(entry);
    if (ranked.length >= limit) break;
  }
  return { ranked: ranked.slice(0, limit), current, unknownTrustExcluded: entries.filter((e) => !TRUST.has(e.trust)).length };
}

function boundedItems(selected, warnings, maxChars) {
  const items = [];
  let clipped = false;
  for (const entry of selected) {
    const base = { tag: entry.tag, file: entry.file, line: entry.line, endLine: entry.endLine,
      hash: '', trust: entry.trust === null ? 'undeclared' : entry.trust, text: '' };
    let low = 0, high = entry.text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const text = entry.text.slice(0, mid).replace(/[\uD800-\uDBFF]$/, '');
      const item = { ...base, text, hash: sha(Buffer.from(text, 'utf8')) };
      const trial = result('ok', null, [...items, item], [...warnings, 'lexical-historical-reference', 'excerpt-may-be-truncated']);
      if (JSON.stringify(trial).length <= maxChars) low = mid;
      else high = mid - 1;
    }
    if (low === 0) break;
    const text = entry.text.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
    if (text.length === 0) break;
    clipped ||= text.length < entry.text.length;
    items.push({ ...base, text, hash: sha(Buffer.from(text, 'utf8')) });
  }
  if (!items.length) return result('unavailable', 'output-limit', [], warnings);
  const final = result('ok', null, items, [...warnings, 'lexical-historical-reference',
    ...(clipped ? ['excerpt-may-be-truncated'] : [])]);
  if (JSON.stringify(final).length > maxChars) fail('output-limit');
  return final;
}

async function recall({ memoryRoot, query = '', limit = 3, maxChars = 2400 } = {}) {
  if (typeof query !== 'string' || Buffer.byteLength(query, 'utf8') > 64 * 1024 ||
      !Number.isInteger(limit) || limit < 1 ||
      !Number.isInteger(maxChars) || maxChars < 512 || maxChars > 4000)
    return result('unavailable', 'invalid-input');
  const boundedLimit = Math.min(limit, 3);
  const lexicalQuery = query.slice(0, 256);
  const scan = query.slice(0, 8192);
  try {
    const before = readSources(memoryRoot);
    const run = await runManifest(before.root);
    if (run.error) fail(run.error);
    const after = readSources(memoryRoot);
    if (!sameSources(before, after)) fail('source-changed');
    const manifest = run.parsed;
    const entries = boundEntries(manifest, before);
    if (manifest.blocking.some((line) => typeof line !== 'string')) fail('manifest-invalid');
    const otherBlocking = manifest.blocking.filter((line) => !/^B5\b/.test(line));
    if (otherBlocking.length) fail('manifest-blocking');
    if ((run.code === 2) !== (manifest.blocking.length > 0)) fail('manifest-invalid');
    const warnings = [];
    if (query.length > 256) warnings.push('query-limited');
    const b5 = manifest.blocking.filter((line) => /^B5\b/.test(line)).length;
    if (b5) warnings.push('b5-trigger-metadata-not-used:' + b5);
    const graph = graphOf(entries, manifest);
    const graphCount = entries.filter((entry) => graph.excluded.has(entry.tag)).length;
    if (graphCount) warnings.push('graph-ambiguous-excluded:' + graphCount);
    if (!query.trim()) return result('no-match', 'empty-query', [], warnings);
    const selected = select(entries, graph, lexicalQuery, scan, boundedLimit);
    if (selected.unknownTrustExcluded) warnings.push('unknown-trust-excluded:' + selected.unknownTrustExcluded);
    if (!selected.ranked.length) return result('no-match', 'no-lexical-match', [], warnings);
    return boundedItems(selected.ranked, warnings, maxChars);
  } catch (error) {
    return result('unavailable', error instanceof SelectorError ? error.reason : 'internal-error');
  }
}

module.exports = { recall };
