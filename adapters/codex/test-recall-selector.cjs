'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recall, validateReceipt } = require('./recall-selector.cjs');

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
    const badRoots = ['//server/share/memory', 'C:/synthetic\ninjected', String.raw`\\server\share\memory`,
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
    const blocked = await recall({ memoryRoot: normal, query: 'demo:new', maxChars: 512 });
    assert.equal(blocked.status, 'unavailable');
    assert.equal(blocked.reason, 'output-limit');
    assert.deepEqual(blocked.items, []);
    assert(!Object.hasOwn(blocked, 'receipt'), 'integrity metadata may not be truncated to fit 512');
    assert(JSON.stringify(blocked).length <= 512);
    const full = await recall({ memoryRoot: normal, query: 'demo:new' });
    assertItem(full, 'demo:new');
    assert.equal(full.receipt.pointers[0].visibility, 'whole');
    assert.equal(full.receipt.pointers[0].fullEntrySha256, full.items[0].hash);
    assert.equal(full.receipt.pointers[0].sourceFileSha256,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(normal, 'decisions.md'))).digest('hex'));
  });
  const entire = fixture('entire-a1', [
    entry('demo:oversized', 'Long rule', 'Start.\n' + 'A'.repeat(3600) +
      '\nDECISIVE EXCEPTION: never confuse a prefix with the full rule.', '[trust:observed]'),
    entry('demo:short1', 'Short rule one', 'complete one', '[trust:derived]'),
    entry('demo:short2', 'Short rule two', 'complete two', '[trust:observed]'),
  ]);
  await check(async () => {
    const r = await recall({ memoryRoot: entire,
      query: 'demo:oversized demo:short1 demo:short2', maxChars: 4000 });
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.equal(r.receipt.counts.selected, 3);
    assert.equal(r.receipt.counts.displayed, 2);
    assert.equal(r.receipt.counts.omitted, 1);
    assert.deepEqual(r.items.map((x) => x.tag), ['demo:short1', 'demo:short2']);
    assert.deepEqual(r.receipt.pointers.map((x) => x.rank), [1, 2, 3]);
    assert.equal(r.receipt.pointers[0].reason, 'selector-budget');
    assert.equal(r.receipt.pointers[0].displayedTextSha256, null);
    assert.equal(r.receipt.pointers[0].sourceRoot, entire);
    const original = fs.readFileSync(path.join(entire, 'decisions.md'), 'utf8').split('\n');
    const pointer = r.receipt.pointers[0];
    assert.equal(pointer.fullEntrySha256, sha(original.slice(pointer.line - 1, pointer.endLine).join('\n')));
    assert(r.items.every((item) => r.receipt.pointers.find((p) => p.tag === item.tag).fullEntrySha256 === item.hash));
    assert(!JSON.stringify(r).includes('DECISIVE EXCEPTION'));
  });
  await check(async () => {
    const r = await recall({ memoryRoot: entire, query: 'demo:oversized', maxChars: 2400 });
    assert.equal(r.status, 'unavailable');
    assert.equal(r.reason, 'output-limit');
    assert.equal(r.receipt.counts.selected, 1);
    assert.equal(r.receipt.counts.displayed, 0);
    assert.equal(r.receipt.pointers[0].visibility, 'omitted');
    assert.deepEqual(r.items, []);
  });
  const longTag = 'demo:' + 'x'.repeat(490);
  const metadataHeavy = fixture('metadata-heavy', [entry(longTag, 'Metadata', 'short body')]);
  await check(async () => {
    const blocked = await recall({ memoryRoot: metadataHeavy, query: longTag, maxChars: 512 });
    assert.equal(blocked.status, 'unavailable');
    assert.equal(blocked.reason, 'output-limit');
    assert.deepEqual(blocked.items, []);
  });
  const countedTags = Array.from({ length: 5 }, (_, i) => 'demo:count' + (i + 1));
  const counted = fixture('counted-citations', countedTags.map((tag, i) =>
    entry(tag, 'Count ' + (i + 1), i === 4 ? 'lexical-overlap-token' : 'body ' + (i + 1))));
  await check(async () => {
    const four = await recall({ memoryRoot: counted,
      query: 'z'.repeat(300) + ' ' + countedTags.slice(0, 4).join(' ') });
    const five = await recall({ memoryRoot: counted,
      query: 'lexical-overlap-token ' + 'z'.repeat(280) + ' ' +
        countedTags.concat(countedTags[0], 'demo:unknown').join(' ') });
    for (const [found, expectedMatched] of [[four, 4], [five, 5]]) {
      assert.equal(found.status, 'ok', JSON.stringify(found));
      assert.equal(validateReceipt(found.receipt, found.items, counted), true);
      assert.equal(found.receipt.counts.matched, expectedMatched);
      assert(found.receipt.counts.selected >= 1 && found.receipt.counts.selected <= 3);
      assert(found.receipt.counts.displayed >= 1, 'a short whole entry must fit');
      assert.equal(found.receipt.counts.displayed + found.receipt.counts.omitted,
        found.receipt.counts.selected);
      assert.equal(found.receipt.counts.matchedIdsNotListed,
        expectedMatched - found.receipt.counts.selected);
      const tags = found.receipt.pointers.map((pointer) => pointer.tag);
      assert(tags.every((tag) => countedTags.slice(0, 3).includes(tag)));
      assert(tags.every((tag, i) => i === 0 ||
        countedTags.indexOf(tags[i - 1]) < countedTags.indexOf(tag)));
      for (const item of found.items) assert.equal(item.hash, sha(item.text));
    }
  });
  const limitedEntries = Array.from({ length: 4 }, (_, i) =>
    entry('demo:limited-unsafe' + (i + 1), 'Limited unsafe ' + (i + 1),
      'unsafe body ' + (i + 1), '[trust:future]'));
  const limitedSafeTag = 'demo:limited-safe5';
  const limited = fixture('selection-limit', limitedEntries.concat(
    entry(limitedSafeTag, 'Limited safe fifth', 'SAFE-FIFTH-BODY', '[trust:observed]')));
  await check(async () => {
    const prefix = 'z'.repeat(300) + ' ';
    const firstFour = limitedEntries.map((value) => value.tag);
    const noFifth = await recall({ memoryRoot: limited, query: prefix + firstFour.join(' ') });
    assert.equal(noFifth.status, 'no-match');
    assert.equal(noFifth.reason, 'no-lexical-match');
    assert.equal(noFifth.receipt.counts.matched, 0);
    assert.equal(noFifth.receipt.stage, 'query-ran');
    const fifth = await recall({ memoryRoot: limited,
      query: prefix + firstFour.concat(limitedSafeTag).join(' ') });
    assert.equal(fifth.status, 'unavailable');
    assert.equal(fifth.reason, 'selection-limit');
    assert.deepEqual(fifth.receipt.counts, { eligible: 1, matched: 1, selected: 0,
      displayed: 0, omitted: 0, matchedIdsNotListed: 1 });
    assert.equal(fifth.receipt.stage, 'unavailable');
    assert.equal(fifth.receipt.query.method, 'mixed');
    assert.deepEqual(fifth.receipt.pointers, []);
    assert.deepEqual(fifth.items, []);
    assert(!JSON.stringify(fifth).includes(limitedSafeTag));
    assert(!JSON.stringify(fifth).includes('SAFE-FIFTH-BODY'));
  });
  await check(async () => {
    const found = await recall({ memoryRoot: normal, query: 'demo:new', limit: 30 });
    assert(found.items.length <= 3);
    assert(JSON.stringify(found).length <= 2400);
  });
  await check(async () => {
    const found = await recall({ memoryRoot: normal, query: 'x'.repeat(300) + ' [demo:old]' });
    assertItem(found, 'demo:new');
    assert(!found.warnings.includes('query-limited'));
    const beyond = await recall({ memoryRoot: normal,
      query: 'demo:old ' + 'x'.repeat(8195) });
    assertItem(beyond, 'demo:new');
    assert(beyond.warnings.includes('query-limited'));
    assert.equal(beyond.receipt.query.effectiveChars, 8192);
  });
  await check(async () => {
    const found = await recall({ memoryRoot: normal, query: 'x'.repeat(65537) });
    assert.equal(found.status, 'unavailable');
    assert.equal(found.reason, 'invalid-input');
  });


  // C1: healthy punctuation control, bounded long-query recovery and
  // explicit-tag override; all source bodies remain immutable for recall.
  const punct = fixture('c1-punctuation', [
    entry('demo:axmem', 'Violet atlas', 'Synthetic signal axmemneedle.'),
    entry('demo:browser', 'Green browser', 'Synthetic signal browserlabel.'),
  ]);
  await check(async () => {
    for (const query of ['axmemneedle', 'axmemneedle.']) {
      const found = await recall({ memoryRoot: punct, query });
      assertItem(found, 'demo:axmem');
      assert.equal(validateReceipt(found.receipt, found.items, punct), true);
    }
    assertItem(await recall({ memoryRoot: punct, query: 'browserlabel.' }), 'demo:browser');
    // Keep an actual lexical boundary before the tail; fused x...target
    // is intentionally not a fuzzy or substring match.
    const prefix = 'browserlabel. ' + 'x'.repeat(325) + ' ';
    assert.equal(prefix.length, 340);
    const spaced = await recall({ memoryRoot: punct,
      query: ' '.repeat(340) + 'axmemneedle.' });
    assert(spaced.items.some((item) => item.tag === 'demo:axmem'));
    const distracted = await recall({ memoryRoot: punct,
      query: prefix + 'axmemneedle.' });
    assert(distracted.items.some((item) => item.tag === 'demo:axmem'));
    const tagged = prefix.slice(0, 275) + ' [demo:axmem] ' + prefix.slice(289);
    const explicit = await recall({ memoryRoot: punct, query: tagged + 'axmemneedle.' });
    assert.equal(explicit.receipt.query.method, 'mixed');
    assert.equal(explicit.receipt.pointers[0].tag, 'demo:axmem');
    assert.equal(explicit.receipt.query.effectiveChars, 352);
  });
  // Generic workflow words cannot decide between unrelated projects in a
  // manifest without verified scope; task-specific lexical evidence can.
  const contextual = fixture('c1-contextual', [
    entry('demo:atlas', 'Atlas workflow release', 'atlas-only scheduler action for violet appointments.'),
    entry('demo:orbit', 'Orbit workflow release', 'orbit-only billing action for green invoices.'),
  ]);
  await check(async () => {
    const generic = await recall({ memoryRoot: contextual, query: 'review workflow project change' });
    assert.equal(generic.status, 'no-match');
    assert.equal(generic.receipt.counts.matched, 0);
    const related = await recall({ memoryRoot: contextual,
      query: 'atlas-only scheduler workflow change' });
    assert.deepEqual(related.items.map((item) => item.tag), ['demo:atlas']);
    const comment = await recall({ memoryRoot: contextual,
      query: '<!-- [demo:orbit] --> atlas-only scheduler' });
    assert.deepEqual(comment.items.map((item) => item.tag), ['demo:atlas']);
  });
  // C2 main's cardinality counterexample: adding an unrelated third rule
  // cannot turn two equally relevant valid matches from zero into two.
  const cardinalityTwo = fixture('c2-cardinality-two', [
    entry('demo:a', 'Capacity safeguard', 'Cardinality prevents mismatches.', '[trust:observed]'),
    entry('demo:b', 'Relationship safeguard', 'Cardinality prevents broken links.', '[trust:observed]'),
  ]);
  const cardinalityThree = fixture('c2-cardinality-three', [
    entry('demo:a', 'Capacity safeguard', 'Cardinality prevents mismatches.', '[trust:observed]'),
    entry('demo:b', 'Relationship safeguard', 'Cardinality prevents broken links.', '[trust:observed]'),
    entry('demo:stock', 'Stock room', 'Shelves hold boxes.', '[trust:observed]'),
  ]);
  await check(async () => {
    for (const memoryRoot of [cardinalityTwo, cardinalityThree]) {
      const found = await recall({ memoryRoot, query: 'cardinality' });
      assert.equal(found.status, 'ok', JSON.stringify(found));
      assert.deepEqual(found.items.map((item) => item.tag), ['demo:a', 'demo:b']);
      assert.equal(found.receipt.counts.matched, 2);
      assert.equal(found.receipt.counts.selected, 2);
      assert.equal(found.receipt.counts.displayed, 2);
      assert.equal(validateReceipt(found.receipt, found.items, memoryRoot), true);
    }
  });
  const sameChinese = fixture('c2-chinese', [
    entry('demo:a', '租户检查', '租户隔离需要核验。', '[trust:observed]'),
    entry('demo:b', '租户边界', '租户隔离需要保持。', '[trust:observed]'),
  ]);
  await check(async () => {
    const found = await recall({ memoryRoot: sameChinese, query: '租户隔离' });
    assert.equal(found.status, 'ok', JSON.stringify(found));
    assert.deepEqual(found.items.map((item) => item.tag), ['demo:a', 'demo:b']);
    assert.equal(found.receipt.counts.matched, 2);
    assert.equal(validateReceipt(found.receipt, found.items, sameChinese), true);
  });
  const dominance = fixture('c2-dominance', [
    entry('demo:axmem', 'AxMem recall integrity', 'workflow release verification', '[trust:observed]'),
    entry('demo:cargo', 'Cargo manifest verification', 'workflow release verification', '[trust:observed]'),
    entry('demo:stock', 'Stock shelves', 'Inventory boxes', '[trust:observed]'),
  ]);
  await check(async () => {
    const found = await recall({ memoryRoot: dominance, query: 'AxMem verification' });
    assert.equal(found.status, 'ok', JSON.stringify(found));
    assert.deepEqual(found.items.map((item) => item.tag), ['demo:axmem']);
    assert.equal(found.receipt.counts.matched, 1);
    assert.equal(validateReceipt(found.receipt, found.items, dominance), true);
    const anchored = await recall({ memoryRoot: dominance,
      query: '[demo:cargo] AxMem verification' });
    assert.equal(anchored.status, 'ok');
    assert.equal(anchored.items[0].tag, 'demo:cargo', 'explicit valid anchor keeps precedence');
    assert.equal(validateReceipt(anchored.receipt, anchored.items, dominance), true);
    const comment = await recall({ memoryRoot: dominance,
      query: '<!-- Cargo manifest verification [demo:cargo] --> AxMem verification' });
    assert.deepEqual(comment.items.map((item) => item.tag), ['demo:axmem']);
    assert.equal(validateReceipt(comment.receipt, comment.items, dominance), true);
    assert.equal(comment.receipt.query.originalChars,
      '<!-- Cargo manifest verification [demo:cargo] --> AxMem verification'.length);
  });
  const complementary = fixture('c2-complementary', [
    entry('demo:left', 'Blue module', 'signalalpha direct relevance.', '[trust:observed]'),
    entry('demo:right', 'Green module', 'signalbeta direct relevance.', '[trust:observed]'),
  ]);
  await check(async () => {
    const found = await recall({ memoryRoot: complementary, query: 'signalalpha signalbeta' });
    assert.equal(found.status, 'ok', JSON.stringify(found));
    assert.deepEqual(found.items.map((item) => item.tag), ['demo:left', 'demo:right']);
    assert.equal(found.receipt.counts.matched, 2);
    assert.equal(validateReceipt(found.receipt, found.items, complementary), true);
  });

  // C3: continuation scaffolding is not topical evidence even when two
  // unrelated projects' verified prose contains the same Chinese bigrams.
  const continuation = fixture('c3-continuation', [
    entry('demo:atlas', 'Atlas 租户隔离 执行官 项目隔离',
      '请继续执行任务；继续推进项目。租户隔离需要验证。执行官审查项目隔离。',
      '[trust:observed]'),
    entry('demo:orbit', 'Orbit 任务调度',
      '请继续执行任务；继续推进项目。任务调度检查工作。',
      '[trust:observed]'),
  ]);
  await check(async () => {
    for (const query of [
      '继续执行任务', '继续推进项目',
      '请继续执行任务，Please continue workflow，谢谢！',
      '请继续推进项目，检查状态一下。2026!!!',
      'Please resume task; continue work.',
    ]) {
      const found = await recall({ memoryRoot: continuation, query });
      assert.equal(found.status, 'no-match', query + ': ' + JSON.stringify(found));
      assert.equal(found.reason, 'no-lexical-match');
      assert.deepEqual(found.items, []);
      assert.equal(found.receipt.counts.eligible, 2);
      assert.deepEqual(found.receipt.counts,
        { eligible: 2, matched: 0, selected: 0, displayed: 0,
          omitted: 0, matchedIdsNotListed: 0 });
      assert.equal(found.receipt.query.originalChars, query.length);
      assert.equal(found.receipt.query.effectiveChars, query.length);
      assert.equal(validateReceipt(found.receipt, found.items, continuation), true);
      assert(!found.warnings.includes('lexical-historical-reference'));
    }
  });
  await check(async () => {
    const positive = [
      ['租户隔离', 'demo:atlas'],
      ['继续执行租户隔离验证', 'demo:atlas'],
      ['执行官', 'demo:atlas'],
      ['任务调度', 'demo:orbit'],
      ['项目隔离', 'demo:atlas'],
    ];
    for (const [query, tag] of positive) {
      const found = await recall({ memoryRoot: continuation, query });
      assertItem(found, tag);
      assert.deepEqual(found.items.map((item) => item.tag), [tag]);
      assert.equal(validateReceipt(found.receipt, found.items, continuation), true);
    }
    const tagged = await recall({ memoryRoot: continuation,
      query: '请继续执行任务。 [demo:orbit] 请继续推进项目！' });
    assertItem(tagged, 'demo:orbit');
    assert.equal(tagged.receipt.query.method, 'mixed');
    assert.equal(validateReceipt(tagged.receipt, tagged.items, continuation), true);
  });
  await check(async () => {
    // If the native capability disappears, return finite unavailable rather
    // than falsely interpreting a Chinese generic query as topical.
    const nativeSegmenter = Intl.Segmenter;
    try {
      Intl.Segmenter = undefined;
      const missing = await recall({ memoryRoot: continuation,
        query: '继续执行任务' });
      assert.equal(missing.status, 'unavailable');
      assert.equal(missing.reason, 'topic-segmentation-unavailable');
      assert.deepEqual(missing.items, []);
      assert(!Object.hasOwn(missing, 'receipt'));
      const anchored = await recall({ memoryRoot: continuation,
        query: '[demo:orbit] 继续执行任务' });
      assertItem(anchored, 'demo:orbit');
      assert.equal(validateReceipt(anchored.receipt, anchored.items, continuation), true);
      assert(anchored.warnings.includes('topic-segmentation-unavailable'));
    } finally {
      Intl.Segmenter = nativeSegmenter;
    }
  });

  // C5: a topic elsewhere in the task cannot authorize a candidate whose
  // only overlap is neutral continuation wording from another project.
  const sharedScaffold = '继续自动推进项目，检查验证完成状态。';
  const c5Atlas = entry('demo:atlas', 'Atlas appointments',
    'Atlas scheduling keeps tenant-guard.v2 safe. ' + sharedScaffold, '[trust:observed]');
  const c5Orbit = entry('demo:orbit', 'Orbit invoices',
    'Orbit billing reconciles blue.release-v2. ' + sharedScaffold, '[trust:observed]');
  const c5Single = fixture('c5-single', [c5Atlas]);
  const c5Double = fixture('c5-double', [c5Atlas, c5Orbit]);
  const c5Unrelated = fixture('c5-extra-unrelated', [c5Atlas, c5Orbit,
    entry('demo:stock', 'Stock shelves', 'Boxes are stored in bins.', '[trust:observed]')]);
  await check(async () => {
    const query = '未收录紫晶校准任务，继续自动推进项目，检查验证完成状态';
    for (const memoryRoot of [c5Single, c5Double, c5Unrelated]) {
      const found = await recall({ memoryRoot, query });
      assert.equal(found.status, 'no-match', JSON.stringify(found));
      assert.equal(found.reason, 'no-lexical-match');
      assert.deepEqual(found.items, []);
      assert.equal(found.receipt.counts.matched, 0);
      assert.equal(found.receipt.counts.selected, 0);
      assert.equal(found.receipt.counts.displayed, 0);
      assert.equal(found.receipt.query.originalChars, query.length);
      assert.equal(found.receipt.query.effectiveChars, query.length);
      assert.equal(validateReceipt(found.receipt, found.items, memoryRoot), true);
    }
    const englishQuery = 'amethyst calibration continue work next';
    for (const memoryRoot of [c5Single, c5Double, c5Unrelated]) {
      const found = await recall({ memoryRoot, query: englishQuery });
      assert.equal(found.status, 'no-match', JSON.stringify(found));
      assert.equal(found.receipt.counts.matched, 0);
      assert.equal(validateReceipt(found.receipt, found.items, memoryRoot), true);
    }
  });
  const c5Topical = fixture('c5-topic', [
    entry('demo:tenant', 'Atlas 租户隔离 执行官',
      '租户隔离执行官核验。' + sharedScaffold, '[trust:observed]'),
    entry('demo:schedule', 'Orbit 任务调度',
      '任务调度处理队列。' + sharedScaffold, '[trust:observed]'),
  ]);
  await check(async () => {
    for (const [query, tag] of [
      ['租户隔离，' + sharedScaffold, 'demo:tenant'],
      ['继续执行租户隔离验证，' + sharedScaffold, 'demo:tenant'],
      ['执行官，' + sharedScaffold, 'demo:tenant'],
      ['任务调度，' + sharedScaffold, 'demo:schedule'],
    ]) {
      const found = await recall({ memoryRoot: c5Topical, query });
      assert.equal(found.status, 'ok', query + ' ' + JSON.stringify(found));
      assert.deepEqual(found.items.map((item) => item.tag), [tag]);
      assert.equal(found.receipt.counts.matched, 1);
      assert.equal(validateReceipt(found.receipt, found.items, c5Topical), true);
    }
    const explicit = await recall({ memoryRoot: c5Topical,
      query: '未收录紫晶校准任务。 [demo:schedule] ' + sharedScaffold });
    assert.equal(explicit.status, 'ok');
    assert.equal(explicit.items[0].tag, 'demo:schedule');
    assert.equal(validateReceipt(explicit.receipt, explicit.items, c5Topical), true);
  });
  await check(async () => {
    for (const [query, tag] of [
      ['tenant-guard.v2 continue work next', 'demo:atlas'],
      ['blue.release-v2 continue work next', 'demo:orbit'],
    ]) {
      const found = await recall({ memoryRoot: c5Double, query });
      assert.equal(found.status, 'ok', query + ': ' + JSON.stringify(found));
      assert.deepEqual(found.items.map((item) => item.tag), [tag]);
      assert.equal(found.receipt.counts.matched, 1);
      assert.equal(validateReceipt(found.receipt, found.items, c5Double), true);
    }
  });

  // Budget selection may remove pointer overhead only if the full ranked
  // selection delivered ZERO bodies; selected/matched counts remain honest.
  const moderate = fixture('c1-moderate', [
    entry('demo:one', 'Moderate one', 'A'.repeat(745)),
    entry('demo:two', 'Moderate two', 'B'.repeat(745)),
    entry('demo:three', 'Moderate three', 'C'.repeat(745)),
  ]);
  await check(async () => {
    const found = await recall({ memoryRoot: moderate,
      query: '[demo:one] [demo:two] [demo:three]', maxChars: 2400, limit: 3 });
    assert.equal(found.status, 'ok', JSON.stringify(found));
    assert.equal(found.receipt.counts.eligible, 3);
    assert.equal(found.receipt.counts.matched, 3);
    assert(found.receipt.counts.selected >= 1 && found.receipt.counts.selected <= 2);
    assert(found.receipt.counts.displayed >= 1);
    assert.equal(found.receipt.counts.matchedIdsNotListed,
      3 - found.receipt.counts.selected);
    assert.equal(validateReceipt(found.receipt, found.items, moderate), true);
    for (const item of found.items)
      assert.equal(item.hash, sha(item.text));
    assert(JSON.stringify(found).length <= 2400);
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
    assert.equal(blocked.receipt.counts.matched, 0);
    assert(blocked.warnings.some((w) => /^graph-ambiguous-excluded:3$/.test(w)));
    assertItem(await recall({ memoryRoot: fork, query: 'demo:safe' }), 'demo:safe');
    const mixed = await recall({ memoryRoot: fork,
      query: 'z'.repeat(300) + ' demo:base demo:safe' });
    assert.equal(mixed.receipt.counts.matched, 1, 'ambiguous citation is not counted');
    assert.deepEqual(mixed.items.map((value) => value.tag), ['demo:safe']);
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
    assert.equal(blocked.receipt.counts.matched, 0);
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
    assert.equal(blocked.receipt.counts.matched, 0);
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
