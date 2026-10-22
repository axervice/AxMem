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
  if (typeof memoryRoot !== 'string' || !memoryRoot || /[\u0000-\u001f\u007f]/.test(memoryRoot))
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
    const dateInSource = /^\*\*(20[0-9-]{8})[^*]*\*\*/.exec(firstLine);
    const verifiedDate = dateInSource && dateInSource[1] === entry.date && validDate(entry.date)
      ? entry.date : null;
    entries.push({ ...entry, date: verifiedDate, text });
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
  // Strip terminal sentence periods but keep internal dot/colon identifiers.
  // Exact known dotted tags are separately resolved by citedTags.
  const words = (normalized.match(/[a-z0-9._:-]+/g) || [])
    .map((word) => word.replace(/^[.:-]+|[.]+$/g, '')).filter(Boolean);
  for (const run of normalized.match(/\p{Script=Han}+/gu) || []) {
    if (run.length === 1) words.push(run);
    else for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2));
  }
  return words;
}

// Never index metadata as lexical task evidence; all returned bytes remain
// unchanged and manifest-bound.
function searchableProse(entry) {
  return entry.text.split('\n').slice(1)
    .filter((line) => !/^\s*(?:Supersedes:|Class:|- 20)/i.test(line))
    .join('\n').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[\[[a-z][a-z0-9-]*:[A-Za-z0-9._-]+\]\]/g, ' ');
}
const GENERIC_QUERY_TERMS = new Set([
  'the', 'and', 'for', 'with', 'please', 'use', 'task', 'tasks',
  'project', 'projects', 'workflow', 'workflows', 'code', 'file', 'files',
  'update', 'change', 'changes', 'fix', 'review', 'status', 'run',
  'start', 'check', 'test', 'tests', 'this', 'that', 'from', 'into',
]);
function citedTags(scan, graph, limit = 4) {
  const found = [];
  // A tag appearing only inside a metadata/comment quote is not a citation.
  scan = scan.replace(/<!--[\s\S]*?-->/g, (comment) => ' '.repeat(comment.length));
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
    if (found.length >= limit) break;
  }
  return found;
}
function select(entries, graph, query, scan, limit) {
  const current = entries.filter((entry) => REQUIRED.has(entry.file) && !entry.archived && !graph.excluded.has(entry.tag) &&
    graph.byTag.get(entry.tag).length === 1 && !graph.next.has(entry.tag) && TRUST.has(entry.trust));
  const byTag = new Map(current.map((entry) => [entry.tag, entry]));
  const docs = current.map((entry) => ({
    id: entry.tag, title: entry.title || '', body: searchableProse(entry),
  }));
  const mini = new MiniSearch({ idField: 'id', fields: ['title', 'body'], storeFields: [],
    tokenize, processTerm: (term) => term, searchOptions: { combineWith: 'OR', prefix: false, fuzzy: false } });
  if (docs.length) mini.addAll(docs);
  // Match the same comment-free query text used for evidence. A cited tag
  // inside an HTML metadata comment is not lexical support either. The v1
  // receipt still digests the original, unmodified query window.
  const lexicalText = query.replace(/<!--[\s\S]*?-->/g, ' ');
  const documentTerms = new Map(docs.map((doc) =>
    [doc.id, new Set(tokenize(doc.title + '\n' + doc.body))]));
  const queryTerms = [...new Set(tokenize(lexicalText))].filter((term) =>
    !GENERIC_QUERY_TERMS.has(term) && !/^\d+$/.test(term));
  const allCitedTags = citedTags(scan, graph, Number.POSITIVE_INFINITY);
  const rankedCitedTags = allCitedTags.slice(0, 4);
  const ranked = [];
  for (const tag of rankedCitedTags) {
    if (graph.excluded.has(tag) || !graph.byTag.has(tag)) continue;
    const source = graph.byTag.get(tag)[0];
    if (!TRUST.has(source.trust)) continue;
    const head = graph.headOf(tag);
    if (head && byTag.has(head) && !ranked.includes(byTag.get(head))) ranked.push(byTag.get(head));
  }
  const lexicalHits = mini.search(lexicalText);
  // Admission is independent of corpus cardinality. Equal or complementary
  // verified query evidence may coexist; strict subsets cannot occupy spare
  // slots ahead of a stronger match. No undocumented project scope is inferred.
  const candidates = lexicalHits.map((hit) => {
    const entry = byTag.get(hit.id);
    const terms = documentTerms.get(hit.id);
    return entry && terms ? { entry, support: queryTerms.filter((term) => terms.has(term)) } : null;
  }).filter((candidate) => candidate && candidate.support.length);
  const strongest = candidates.filter((candidate) => !candidates.some((other) =>
    other !== candidate && other.support.length > candidate.support.length &&
    candidate.support.every((term) => other.support.includes(term))));
  const hitTags = new Set();
  for (const tag of allCitedTags) {
    if (graph.excluded.has(tag) || !graph.byTag.has(tag)) continue;
    const source = graph.byTag.get(tag)[0];
    if (!TRUST.has(source.trust)) continue;
    const head = graph.headOf(tag);
    if (head && byTag.has(head)) hitTags.add(head);
  }
  for (const { entry } of strongest) {
    hitTags.add(entry.tag);
    if (!ranked.includes(entry) && ranked.length < limit) ranked.push(entry);
  }
  const fromTags = new Map();
  for (const cited of rankedCitedTags) {
    const head = graph.headOf(cited);
    if (head && head !== cited && byTag.has(head) && !fromTags.has(head)) fromTags.set(head, cited);
  }
  return { ranked: ranked.slice(0, limit), current, matched: hitTags.size, fromTags,
    unknownTrustExcluded: entries.filter((e) => !TRUST.has(e.trust)).length };
}


const HEX64 = /^[a-f0-9]{64}$/;
const ITEM_FILES = new Set(FILES.slice(0, 3));
const RECEIPT_EVENTS = new Set(['selector', 'SessionStart', 'UserPromptSubmit', 'SubagentStart', 'agent-task']);
const RECEIPT_STAGES = new Set(['source-probed', 'query-ran', 'candidates-selected', 'emitted', 'omitted', 'unavailable']);
const QUERY_METHODS = new Set(['none', 'lexical', 'explicit-tag', 'mixed']);
const VISIBILITIES = new Set(['whole', 'omitted']);
const OMISSION_REASONS = new Set(['none', 'selector-budget', 'bridge-budget', 'task-budget']);
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
const R_KEYS = ['v', 'event', 'stage', 'query', 'counts', 'pointers'];
const Q_KEYS = ['method', 'originalChars', 'effectiveChars', 'sha256'];
const C_KEYS = ['eligible', 'matched', 'selected', 'displayed', 'omitted', 'matchedIdsNotListed'];
const P_KEYS = ['rank', 'sourceRoot', 'file', 'line', 'endLine', 'tag', 'trust', 'sourceFileSha256',
  'fullEntrySha256', 'displayedTextSha256', 'date', 'scope', 'resolvedFromTag', 'visibility', 'reason'];
const integer = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
function validDate(v) {
  if (v === null) return true;
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00.000Z');
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === v;
}
function validateReceipt(receipt, items, memoryRoot) {
  if (!exactKeys(receipt, R_KEYS) || receipt.v !== 1 ||
      !RECEIPT_EVENTS.has(receipt.event) || !RECEIPT_STAGES.has(receipt.stage) ||
      !exactKeys(receipt.query, Q_KEYS) || !exactKeys(receipt.counts, C_KEYS) ||
      !Array.isArray(receipt.pointers)) return false;
  const q = receipt.query, c = receipt.counts;
  if (!QUERY_METHODS.has(q.method) || !integer(q.originalChars, 65536) ||
      !integer(q.effectiveChars, 65536) || q.effectiveChars > q.originalChars ||
      !(q.sha256 === null || typeof q.sha256 === 'string' && HEX64.test(q.sha256)) ||
      (q.method === 'none' && (q.effectiveChars !== 0 || q.sha256 !== null)) ||
      (q.method !== 'none' && (q.effectiveChars === 0 || q.sha256 === null))) return false;
  if (!integer(c.eligible, 5000) || !(c.matched === null || integer(c.matched, 5000)) ||
      !integer(c.selected, 3) || !integer(c.displayed, 3) || !integer(c.omitted, 3) ||
      c.displayed + c.omitted !== c.selected || c.selected > c.eligible ||
      c.matched !== null && (c.matched < c.selected || c.matched > c.eligible) ||
      !(c.matchedIdsNotListed === null || integer(c.matchedIdsNotListed, 5000)) ||
      (c.matched === null ? c.matchedIdsNotListed !== null : c.matchedIdsNotListed !== c.matched - c.selected) ||
      receipt.pointers.length !== c.selected || items.length !== c.displayed) return false;
  const selected = new Set();
  let itemIndex = 0;
  for (let i = 0; i < receipt.pointers.length; i++) {
    const p = receipt.pointers[i];
    if (!exactKeys(p, P_KEYS) || p.rank !== i + 1 ||
        typeof p.sourceRoot !== 'string' || p.sourceRoot !== memoryRoot ||
        Buffer.byteLength(p.sourceRoot, 'utf8') > 512 ||
        !ITEM_FILES.has(p.file) || !integer(p.line, 4194305) || p.line < 1 ||
        !integer(p.endLine, 4194305) || p.endLine < p.line ||
        !tagIn(p.tag) || p.tag.length > 512 || selected.has(p.tag) ||
        !['observed', 'derived', 'user-ratified', 'undeclared'].includes(p.trust) ||
        typeof p.sourceFileSha256 !== 'string' || !HEX64.test(p.sourceFileSha256) ||
        typeof p.fullEntrySha256 !== 'string' || !HEX64.test(p.fullEntrySha256) ||
        !(p.displayedTextSha256 === null ||
          typeof p.displayedTextSha256 === 'string' && HEX64.test(p.displayedTextSha256)) ||
        !validDate(p.date) || p.scope !== 'unknown' ||
        !(p.resolvedFromTag === null || tagIn(p.resolvedFromTag) && p.resolvedFromTag.length <= 512) ||
        !VISIBILITIES.has(p.visibility) || !OMISSION_REASONS.has(p.reason) ||
        (p.visibility === 'whole' && (p.reason !== 'none' ||
          p.displayedTextSha256 !== p.fullEntrySha256)) ||
        (p.visibility === 'omitted' && (p.reason === 'none' || p.displayedTextSha256 !== null)))
      return false;
    selected.add(p.tag);
    if (p.visibility === 'whole') {
      const item = items[itemIndex++];
      if (!item || item.tag !== p.tag || item.file !== p.file ||
          item.line !== p.line || item.endLine !== p.endLine || item.trust !== p.trust ||
          typeof item.text !== 'string' || item.hash !== p.fullEntrySha256 ||
          sha(Buffer.from(item.text, 'utf8')) !== p.fullEntrySha256) return false;
    }
  }
  return true;
}
function digestQuery(query, method) {
  const scan = method === 'none' ? '' : query.slice(0, 8192);
  return { method, originalChars: query.length, effectiveChars: scan.length,
    sha256: method === 'none' ? null : sha(Buffer.from('axmem-recall-q:v1\0' + scan, 'utf8')) };
}
function compactReceiptResult(receipt, warnings, items, maxChars, status, reason) {
  const obj = { status, reason, items, warnings, receipt };
  return JSON.stringify(obj).length <= maxChars ? obj : null;
}
function outputLimit() { return result('unavailable', 'output-limit'); }
function entryPointer(entry, rank, memoryRoot, sources, fromTag) {
  const rootFile = sources.files.get(entry.file);
  const textHash = sha(Buffer.from(entry.text, 'utf8'));
  return {
    rank, sourceRoot: memoryRoot, file: entry.file, line: entry.line, endLine: entry.endLine,
    tag: entry.tag, trust: entry.trust === null ? 'undeclared' : entry.trust,
    sourceFileSha256: rootFile.hash, fullEntrySha256: textHash,
    displayedTextSha256: null, date: validDate(entry.date) && entry.date !== null ? entry.date : null,
    scope: 'unknown', resolvedFromTag: fromTag || null, visibility: 'omitted', reason: 'selector-budget',
  };
}
function packSelected(selected, warnings, maxChars, memoryRoot, sources, queryInfo, eligible, matched, fromTags) {
  if (Buffer.byteLength(memoryRoot, 'utf8') > 512 || selected.some((e) => e.tag.length > 512))
    return outputLimit();
  const pointers = selected.map((entry, i) => entryPointer(entry, i + 1, memoryRoot, sources, fromTags.get(entry.tag)));
  const counts = { eligible, matched, selected: selected.length, displayed: 0, omitted: selected.length,
    matchedIdsNotListed: matched === null ? null : matched - selected.length };
  const selectionLimited = selected.length === 0 && matched !== null && matched > 0;
  const receipt = { v: 1, event: 'selector',
    stage: selected.length ? 'omitted' : selectionLimited ? 'unavailable' : 'query-ran',
    query: queryInfo, counts, pointers };
  // Integrity-critical metadata must fit before any body. Never truncate a pointer.
  const emptyStatus = selected.length || selectionLimited ? 'unavailable' : 'no-match';
  const emptyReason = selected.length ? 'output-limit' : selectionLimited ? 'selection-limit' : 'no-lexical-match';
  if (!compactReceiptResult(receipt, warnings, [], maxChars, emptyStatus, emptyReason)) return outputLimit();
  const items = [];
  for (let i = 0; i < selected.length; i++) {
    const entry = selected[i], p = pointers[i];
    const item = { tag: entry.tag, file: entry.file, line: entry.line, endLine: entry.endLine,
      hash: p.fullEntrySha256, trust: p.trust, text: entry.text };
    p.visibility = 'whole'; p.reason = 'none'; p.displayedTextSha256 = p.fullEntrySha256;
    counts.displayed++; counts.omitted--;
    receipt.stage = 'candidates-selected';
    if (compactReceiptResult(receipt, warnings, [...items, item], maxChars, 'ok', null)) items.push(item);
    else {
      p.visibility = 'omitted'; p.reason = 'selector-budget'; p.displayedTextSha256 = null;
      counts.displayed--; counts.omitted++;
    }
  }
  receipt.stage = !selected.length ? (selectionLimited ? 'unavailable' : 'query-ran') :
    counts.displayed ? 'candidates-selected' : 'omitted';
  const status = !selected.length ? (selectionLimited ? 'unavailable' : 'no-match') :
    counts.displayed ? 'ok' : 'unavailable';
  const reason = !selected.length ? (selectionLimited ? 'selection-limit' : 'no-lexical-match') :
    counts.displayed ? null : 'output-limit';
  return compactReceiptResult(receipt, warnings, items, maxChars, status, reason) || outputLimit();
}

function wholeItems(selected, warnings, maxChars, memoryRoot, sources, queryInfo, eligible, matched, fromTags) {
  const full = packSelected(selected, warnings, maxChars, memoryRoot, sources, queryInfo, eligible, matched, fromTags);
  // Preserve all pointers when later short entries already fit after an
  // oversized rank 1. Only reconsider a selection displaying zero bodies.
  if (full.items.length || selected.length < 2) return full;
  let best = null;
  for (let mask = 1; mask < (1 << selected.length) - 1; mask++) {
    const subset = selected.filter((_, i) => mask & (1 << i));
    const candidate = packSelected(subset, warnings, maxChars, memoryRoot,
      sources, queryInfo, eligible, matched, fromTags);
    if (!candidate.items.length) continue;
    const shown = candidate.items.length;
    const rankSum = selected.reduce((sum, item, i) =>
      sum + (candidate.items.some((whole) => whole.tag === item.tag) ? i : 0), 0);
    if (!best || shown > best.shown ||
        shown === best.shown && (subset.length < best.size ||
          subset.length === best.size && rankSum < best.rankSum)) {
      best = { candidate, shown, size: subset.length, rankSum };
    }
  }
  return best ? best.candidate : full;
}

async function recall({ memoryRoot, query = '', limit = 3, maxChars = 2400 } = {}) {
  if (typeof query !== 'string' || Buffer.byteLength(query, 'utf8') > 64 * 1024 ||
      !Number.isInteger(limit) || limit < 1 ||
      !Number.isInteger(maxChars) || maxChars < 512 || maxChars > 4000)
    return result('unavailable', 'invalid-input');
  const boundedLimit = Math.min(limit, 3);
  const lexicalQuery = query.slice(0, 8192);
  const scan = lexicalQuery;
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
    if (query.length > 8192) warnings.push('query-limited');
    const b5 = manifest.blocking.filter((line) => /^B5\b/.test(line)).length;
    if (b5) warnings.push('b5-trigger-metadata-not-used:' + b5);
    const graph = graphOf(entries, manifest);
    const graphCount = entries.filter((entry) => graph.excluded.has(entry.tag)).length;
    if (graphCount) warnings.push('graph-ambiguous-excluded:' + graphCount);
    if (!query.trim()) {
      const empty = select(entries, graph, '', '', boundedLimit);
      const r = { v: 1, event: 'selector', stage: 'query-ran', query: digestQuery(query, 'none'),
        counts: { eligible: empty.current.length, matched: 0, selected: 0, displayed: 0, omitted: 0,
          matchedIdsNotListed: 0 }, pointers: [] };
      return compactReceiptResult(r, warnings, [], maxChars, 'no-match', 'empty-query') || outputLimit();
    }
    const selected = select(entries, graph, lexicalQuery, scan, boundedLimit);
    if (selected.unknownTrustExcluded) warnings.push('unknown-trust-excluded:' + selected.unknownTrustExcluded);
    const hasCites = citedTags(scan, graph, Number.POSITIVE_INFINITY)
      .some((tag) => !graph.excluded.has(tag));
    const method = hasCites ? 'mixed' : 'lexical';
    const q = digestQuery(query, method);
    return wholeItems(selected.ranked,
      selected.ranked.length ? [...warnings, 'lexical-historical-reference'] : warnings, maxChars,
      memoryRoot, before, q, selected.current.length, selected.matched, selected.fromTags);
  } catch (error) {
    return result('unavailable', error instanceof SelectorError ? error.reason : 'internal-error');
  }
}

module.exports = { recall, validateReceipt };
