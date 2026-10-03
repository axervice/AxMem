'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recall } = require('./recall-selector.cjs');

// `bin/axmem selftest` discovers adapter tests by the literal --self-test.
// Both direct invocation and that flag run this same isolated synthetic suite.
if (process.argv.length > 2 && (process.argv.length !== 3 || process.argv[2] !== '--self-test'))
  throw new Error('unsupported test arguments');

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-selector-synthetic-'));
let passed = 0;
async function check(fn) { await fn(); passed++; }
function entry(tag, title, body, extra = '') {
  return { tag, title, body, extra };
}
function render(entries, markers = {}) {
  const index = entries.map((e) => '- 2026-01-01 ' + e.title + ' [' + e.tag + ']' +
    (markers[e.tag] || '')).join('\n');
  const blocks = entries.map((e) => '**2026-01-01 — ' + e.title + '** [' + e.tag + ']' +
    (e.extra ? ' ' + e.extra : '') + '\n' + e.body).join('\n');
  return '## Index\n' + (index ? index + '\n' : '') + '\n## Entries\n' + (blocks ? blocks + '\n' : '');
}
function fixture(name, decisions = [], lessons = [], standing = [], markers = {}) {
  const root = path.join(temp, name);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'decisions.md'), render(decisions, markers));
  fs.writeFileSync(path.join(root, 'lessons.md'), render(lessons));
  fs.writeFileSync(path.join(root, 'standinginstructions.md'), render(standing));
  return root;
}
function assertItem(result, tag) {
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.items[0].tag, tag);
  assert.equal(result.items[0].hash, sha(result.items[0].text));
  assert.equal(result.items[0].file, 'decisions.md');
}

(async () => {
  const normal = fixture('normal', [
    entry('demo:old', 'Older vehicle rule', 'old wording', '[trust:observed]'),
    entry('demo:new', 'Replacement vehicle rule', '机组检查完成。\nSupersedes: [[demo:old]]', '[trust:user-ratified]'),
    entry('demo:other', 'Unrelated', 'separate unrelated text'),
  ]);
  await check(async () => {
    const found = await recall({ memoryRoot: normal, query: 'demo:old' });
    assertItem(found, 'demo:new');
    assert.equal(found.items[0].trust, 'user-ratified');
    assert(!found.items.some((item) => item.tag === 'demo:old'));
  });
  await check(async () => assertItem(await recall({ memoryRoot: normal,
    query: '修复前查询 [demo:old] 请找最新规则' }), 'demo:new'));
  const markerOnly = fixture('marker-only', [
    entry('demo:old-marker', 'Past policy', 'obsolete statement'),
    entry('demo:new-marker', 'Current policy', 'replacement statement'),
  ], [], [], { 'demo:old-marker': ' superseded→[demo:new-marker]' });
  await check(async () => {
    for (const query of ['Please enforce demo:old-marker today',
      'Please enforce demo:old-marker.', 'Please enforce "demo:old-marker" today',
      "Please enforce 'demo:old-marker' today", 'Please enforce (demo:old-marker) today',
      '请按demo:old-marker执行', '请按 demo:old-marker，今天执行']) {
      assertItem(await recall({ memoryRoot: markerOnly, query }), 'demo:new-marker');
    }
  });
  await check(async () => {
    for (const query of ['https://example.invalid/demo:old-marker',
      'namespace:demo:old-marker', 'demo:old-marker/suffix',
      'prefix.demo:old-marker', 'demo:old-marker.txt']) {
      const found = await recall({ memoryRoot: markerOnly, query });
      assert.equal(found.status, 'no-match', query);
    }
  });
  const dotted = fixture('dotted', [entry('demo:note', 'Undotted', 'undotted body'),
    entry('demo:note.', 'Dotted', 'dotted body')]);
  await check(async () => {
    assertItem(await recall({ memoryRoot: dotted, query: 'Use demo:note. today' }), 'demo:note.');
    const unknownFileStyle = await recall({ memoryRoot: dotted, query: 'demo:note.txt' });
    assert.equal(unknownFileStyle.status, 'no-match');
  });
  await check(async () => assertItem(await recall({ memoryRoot: normal, query: '机组' }), 'demo:new'));
  await check(async () => {
    const found = await recall({ memoryRoot: normal, query: 'Unrelated' });
    assertItem(found, 'demo:other');
    assert.equal(found.items[0].trust, 'undeclared');
  });
  await check(async () => {
    const found = await recall({ memoryRoot: normal, query: 'no_such_keyword_923' });
    assert.equal(found.status, 'no-match');
    assert.deepEqual(found.items, []);
  });
  await check(async () => {
    const found = await recall({ memoryRoot: normal, query: '' });
    assert.equal(found.status, 'no-match');
    assert.equal(found.reason, 'empty-query');
  });
  await check(async () => {
    const badRoots = ['//server/share/memory', String.raw`\\server\share\memory`,
      String.raw`\\?\C:\memory`, String.raw`\\.\C:\memory`,
      '/??/C:/memory', '/Device/HarddiskVolume1/memory',
      'file:/C:/memory', 'file://server/memory', 'https://example.invalid/memory'];
    const original = { lstatSync: fs.lstatSync, realpathSync: fs.realpathSync,
      readFileSync: fs.readFileSync };
    let touches = 0;
    for (const key of Object.keys(original)) fs[key] = () => { touches++; throw new Error('fs touched'); };
    try {
      for (const memoryRoot of badRoots) {
        const blocked = await recall({ memoryRoot, query: 'demo:new' });
        assert.equal(blocked.status, 'unavailable');
        assert.equal(blocked.reason, 'invalid-input');
      }
      assert.equal(touches, 0, 'nonlocal roots must fail before any fs call');
    } finally { Object.assign(fs, original); }
  });
  await check(async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const lstat = fs.lstatSync;
    let touches = 0;
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    fs.lstatSync = () => { touches++; throw Object.assign(new Error('synthetic absent'), { code: 'ENOENT' }); };
    try {
      const local = await recall({ memoryRoot: '/tmp/selector-local', query: 'demo:new' });
      assert.equal(local.reason, 'source-unavailable');
      assert.equal(touches, 1, 'a local POSIX path reaches the source reader');
      for (const memoryRoot of ['//server/share', String.raw`\\server\share`,
        String.raw`\tmp\memory`,
        String.raw`\\?\C:\device`, '/??/C:/device', '/Device/HarddiskVolume1',
        'file:/tmp/source', 'https://example.invalid/source']) {
        const blocked = await recall({ memoryRoot, query: 'demo:new' });
        assert.equal(blocked.reason, 'invalid-input');
      }
      assert.equal(touches, 1, 'nonlocal roots are rejected before fs on POSIX too');
    } finally {
      fs.lstatSync = lstat;
      Object.defineProperty(process, 'platform', platform);
    }
  });
  await check(async () => {
    const found = await recall({ memoryRoot: normal, query: 'demo:new', maxChars: 512 });
    assertItem(found, 'demo:new');
    assert(JSON.stringify(found).length <= 512);
    assert(found.items[0].text.length < fs.readFileSync(path.join(normal, 'decisions.md'), 'utf8').length);
  });
  const longTag = 'demo:' + 'x'.repeat(490);
  const metadataHeavy = fixture('metadata-heavy', [entry(longTag, 'Metadata', 'short body')]);
  await check(async () => {
    const blocked = await recall({ memoryRoot: metadataHeavy, query: longTag, maxChars: 512 });
    assert.equal(blocked.status, 'unavailable');
    assert.equal(blocked.reason, 'output-limit');
    assert.deepEqual(blocked.items, []);
  });
  await check(async () => {
    const found = await recall({ memoryRoot: normal, query: 'demo:new', limit: 30 });
    assert(found.items.length <= 3);
    assert(JSON.stringify(found).length <= 2400);
  });
  await check(async () => {
    const found = await recall({ memoryRoot: normal, query: 'x'.repeat(300) + ' [demo:old]' });
    assertItem(found, 'demo:new');
    assert(found.warnings.includes('query-limited'));
  });
  await check(async () => {
    const found = await recall({ memoryRoot: normal, query: 'x'.repeat(65537) });
    assert.equal(found.status, 'unavailable');
    assert.equal(found.reason, 'invalid-input');
  });

  const projection = fixture('projection', [entry('demo:dash', 'Numbered prose',
    'A decision line\n- 2026 note within body\nB decision line', '[trust:derived]')]);
  await check(async () => {
    const found = await recall({ memoryRoot: projection, query: 'demo:dash' });
    assertItem(found, 'demo:dash');
    assert(found.items[0].text.includes('- 2026 note within body'));
    assert.equal(found.items[0].hash, sha(found.items[0].text));
  });

  const b5 = fixture('b5', [entry('demo:b5', 'Trigger note',
    '<!-- trigger: path=bad -->\nRelevant trigger explanation', '[trust:observed]')]);
  await check(async () => {
    const found = await recall({ memoryRoot: b5, query: 'demo:b5' });
    assertItem(found, 'demo:b5');
    assert(found.warnings.includes('b5-trigger-metadata-not-used:1'));
  });

  const fork = fixture('fork', [
    entry('demo:base', 'Base', 'legacy'),
    entry('demo:left', 'Left', 'left branch\nSupersedes: [[demo:base]]'),
    entry('demo:right', 'Right', 'right branch\nSupersedes: [[demo:base]]'),
    entry('demo:safe', 'Safe', 'unrelated healthy'),
  ]);
  await check(async () => {
    const blocked = await recall({ memoryRoot: fork, query: '[demo:base]' });
    assert.equal(blocked.status, 'no-match');
    assert(blocked.warnings.some((w) => /^graph-ambiguous-excluded:3$/.test(w)));
    assertItem(await recall({ memoryRoot: fork, query: 'demo:safe' }), 'demo:safe');
  });

  const duplicate = fixture('duplicate', [
    entry('demo:dup', 'Duplicate one', 'first'),
    entry('demo:dup', 'Duplicate two', 'second'),
    entry('demo:successor', 'Successor', 'next\nSupersedes: [[demo:dup]]'),
    entry('demo:clean', 'Clean', 'clean safe'),
  ]);
  await check(async () => {
    const blocked = await recall({ memoryRoot: duplicate, query: 'demo:dup' });
    assert.equal(blocked.status, 'no-match');
    assert(blocked.warnings.some((w) => w.startsWith('graph-ambiguous-excluded:')));
    assertItem(await recall({ memoryRoot: duplicate, query: 'demo:clean' }), 'demo:clean');
  });

  const nonstandard = fixture('nonstandard', [entry('demo:odd', 'Odd', 'odd text'),
    entry('demo:free', 'Free', 'free text')], [], [], { 'demo:odd': ' superseded→oops' });
  await check(async () => {
    const blocked = await recall({ memoryRoot: nonstandard, query: 'demo:odd' });
    assert.equal(blocked.status, 'no-match');
    assert(blocked.warnings.some((w) => w.startsWith('graph-ambiguous-excluded:')));
  });

  const cycle = fixture('cycle', [entry('demo:a', 'Cycle A', 'Supersedes: [[demo:b]]'),
    entry('demo:b', 'Cycle B', 'Supersedes: [[demo:a]]')]);
  await check(async () => {
    const blocked = await recall({ memoryRoot: cycle, query: 'demo:a' });
    assert.equal(blocked.status, 'unavailable');
    assert.equal(blocked.reason, 'manifest-blocking');
  });
  const dangling = fixture('dangling', [entry('demo:dangling', 'Dangling',
    'Supersedes: [[demo:absent]]')]);
  await check(async () => {
    const blocked = await recall({ memoryRoot: dangling, query: 'demo:dangling' });
    assert.equal(blocked.status, 'unavailable');
    assert.equal(blocked.reason, 'manifest-blocking');
  });

  const archived = fixture('archived', [entry('demo:live', 'Live', 'live content')]);
  fs.writeFileSync(path.join(archived, 'decisions-archive.md'),
    render([entry('demo:archived', 'Archived', 'archive-only wording')]));
  await check(async () => {
    const blocked = await recall({ memoryRoot: archived, query: 'demo:archived' });
    assert.equal(blocked.status, 'no-match');
    assert.deepEqual(blocked.items, []);
  });

  const chain = [];
  for (let i = 0; i < 11; i++) chain.push(entry('demo:chain' + i, 'Chain ' + i,
    i === 0 ? 'start' : 'next\nSupersedes: [[demo:chain' + (i - 1) + ']]'));
  chain.push(entry('demo:independent', 'Independent', 'standalone'));
  const longChain = fixture('long-chain', chain);
  await check(async () => {
    const blocked = await recall({ memoryRoot: longChain, query: 'demo:chain0' });
    assert.equal(blocked.status, 'no-match');
    assert(blocked.warnings.some((w) => w.startsWith('graph-ambiguous-excluded:')));
    assertItem(await recall({ memoryRoot: longChain, query: 'demo:independent' }), 'demo:independent');
  });
  const markerRows = [];
  const markerEdges = {};
  for (let i = 0; i < 11; i++) {
    markerRows.push(entry('demo:marker' + i, 'Marker ' + i, 'marker body ' + i));
    if (i < 10) markerEdges['demo:marker' + i] = ' superseded→[demo:marker' + (i + 1) + ']';
  }
  markerRows.push(entry('demo:marker-safe', 'Marker safe', 'unrelated current'));
  const markerChain = fixture('marker-chain', markerRows, [], [], markerEdges);
  await check(async () => {
    const blocked = await recall({ memoryRoot: markerChain, query: 'demo:marker0' });
    assert.equal(blocked.status, 'no-match');
    assert(blocked.warnings.some((w) => w.startsWith('graph-ambiguous-excluded:')));
    assertItem(await recall({ memoryRoot: markerChain, query: 'demo:marker-safe' }), 'demo:marker-safe');
  });

  const unknown = fixture('unknown-trust', [entry('demo:mystery', 'Mystery', 'mystery', '[trust:future]')]);
  await check(async () => {
    const blocked = await recall({ memoryRoot: unknown, query: 'demo:mystery' });
    assert.equal(blocked.status, 'no-match');
    assert(blocked.warnings.includes('unknown-trust-excluded:1'));
  });

  const missing = fixture('missing', [entry('demo:one', 'One', 'one')]);
  fs.unlinkSync(path.join(missing, 'lessons.md'));
  await check(async () => {
    const blocked = await recall({ memoryRoot: missing, query: 'demo:one' });
    assert.equal(blocked.status, 'unavailable');
    assert.equal(blocked.reason, 'missing-required-source');
    const empty = await recall({ memoryRoot: missing, query: '' });
    assert.equal(empty.status, 'unavailable');
  });

  const escape = fixture('escape', [entry('demo:escape', 'Escape', 'escape')]);
  const outside = path.join(temp, 'outside.md');
  fs.writeFileSync(outside, render([entry('demo:escape', 'Escape', 'escape')]));
  fs.unlinkSync(path.join(escape, 'decisions.md'));
  let symlinked = false;
  try { fs.symlinkSync(outside, path.join(escape, 'decisions.md'), 'file'); symlinked = true; }
  catch { fs.writeFileSync(path.join(escape, 'decisions.md'), fs.readFileSync(outside)); }
  await check(async () => {
    if (symlinked) {
      const blocked = await recall({ memoryRoot: escape, query: 'demo:escape' });
      assert.equal(blocked.status, 'unavailable');
      assert.equal(blocked.reason, 'source-unsafe');
    } else {
      const real = fs.realpathSync;
      fs.realpathSync = function (...args) {
        if (String(args[0]) === path.join(escape, 'decisions.md')) return outside;
        return real.apply(this, args);
      };
      try {
        const blocked = await recall({ memoryRoot: escape, query: 'demo:escape' });
        assert.equal(blocked.status, 'unavailable');
        assert.equal(blocked.reason, 'source-unsafe');
      } finally { fs.realpathSync = real; }
    }
  });

  const changing = fixture('changing', [entry('demo:change', 'Change', 'before')]);
  await check(async () => {
    const read = fs.readFileSync;
    let reads = 0;
    const target = path.join(changing, 'decisions.md');
    fs.readFileSync = function (...args) {
      if (String(args[0]) === target && ++reads === 2) {
        fs.writeFileSync(target, render([entry('demo:change', 'Change', 'after')]));
      }
      return read.apply(this, args);
    };
    try {
      const blocked = await recall({ memoryRoot: changing, query: 'demo:change' });
      assert.equal(blocked.status, 'unavailable');
      assert.equal(blocked.reason, 'source-changed');
    } finally { fs.readFileSync = read; }
  });

  await check(async () => {
    const before = fs.readdirSync(normal).sort();
    const hashes = before.map((name) => sha(fs.readFileSync(path.join(normal, name), 'utf8')));
    const found = await recall({ memoryRoot: normal, query: 'demo:new' });
    assertItem(found, 'demo:new');
    assert.deepEqual(fs.readdirSync(normal).sort(), before);
    assert.deepEqual(before.map((name) => sha(fs.readFileSync(path.join(normal, name), 'utf8'))), hashes);
  });

  process.stdout.write('PASS recall-selector synthetic ' + passed + '/' + passed + '\n');
})().catch((error) => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; })
  .finally(() => { fs.rmSync(temp, { recursive: true, force: true }); });
