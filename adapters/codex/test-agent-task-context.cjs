#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const helper = require('./agent-task-context.cjs');

let passed = 0;
let total = 0;

function check(condition, name) {
  total += 1;
  try {
    assert.ok(condition);
    passed += 1;
    process.stdout.write('ok ' + total + ' - ' + name + '\n');
  } catch (error) {
    process.stderr.write('not ok ' + total + ' - ' + name + ': ' + error.message + '\n');
    process.exitCode = 1;
  }
}

function lesson(tag, text) {
  return {
    tag: tag || 'governance:review',
    file: 'lessons.md',
    line: 7,
    endLine: 9,
    hash: 'a'.repeat(64),
    trust: 'user-ratified',
    text: text || 'Use only the approved isolated worktree and report the verified result.',
  };
}

function lessonBlock(message, original) {
  return message.slice(original.length);
}


function strictFixture(root, specifications, omitAll = false) {
  const crypto = require('node:crypto');
  const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const items = [];
  const pointers = specifications.map(([tag, text], i) => {
    const hash = sha(text), omitted = omitAll;
    if (!omitted) items.push({ tag, file: 'lessons.md', line: i * 4 + 7,
      endLine: i * 4 + 9, hash, trust: 'observed', text });
    return { rank: i + 1, sourceRoot: root, file: 'lessons.md',
      line: i * 4 + 7, endLine: i * 4 + 9, tag, trust: 'observed',
      sourceFileSha256: 'f'.repeat(64), fullEntrySha256: hash,
      displayedTextSha256: omitted ? null : hash, date: '2026-01-01', scope: 'unknown',
      resolvedFromTag: null, visibility: omitted ? 'omitted' : 'whole',
      reason: omitted ? 'selector-budget' : 'none' };
  });
  return { status: omitAll ? 'unavailable' : 'ok', reason: omitAll ? 'output-limit' : null,
    items, warnings: [],
    receipt: { v: 1, event: 'selector', stage: omitAll ? 'omitted' : 'candidates-selected',
      query: { method: 'lexical', originalChars: 1, effectiveChars: 1, sha256: 'c'.repeat(64) },
      counts: { eligible: specifications.length, matched: specifications.length,
        selected: specifications.length, displayed: omitAll ? 0 : specifications.length,
        omitted: omitAll ? specifications.length : 0, matchedIdsNotListed: 0 }, pointers } };
}

function strictNoMatchFixture(root, reason = 'no-lexical-match') {
  const none = reason === 'empty-query';
  return { status: 'no-match', reason, items: [], warnings: [],
    receipt: { v: 1, event: 'selector', stage: 'query-ran',
      query: { method: none ? 'none' : 'lexical', originalChars: none ? 0 : 1,
        effectiveChars: none ? 0 : 1, sha256: none ? null : 'c'.repeat(64) },
      counts: { eligible: 1, matched: 0, selected: 0, displayed: 0, omitted: 0,
        matchedIdsNotListed: 0 }, pointers: [] } };
}

function strictSelectionLimitFixture(root) {
  return { status: 'unavailable', reason: 'selection-limit', items: [], warnings: ['query-limited'],
    receipt: { v: 1, event: 'selector', stage: 'unavailable',
      query: { method: 'mixed', originalChars: 400, effectiveChars: 400, sha256: 'c'.repeat(64) },
      counts: { eligible: 1, matched: 1, selected: 0, displayed: 0, omitted: 0,
        matchedIdsNotListed: 1 }, pointers: [] } };
}

async function main() {
  const memoryRoot = process.platform === 'win32'
    ? 'C:\\PMM Fixture Root\\memory'
    : '/tmp/pmm-fixture-root/memory';
  const taskSpec = 'Review the isolated adapter and report only verified checks.';

  {
    let calls = 0;
    const result = await helper.prepareAgentTask(
      { memoryRoot, taskSpec },
      { selector: async () => { calls += 1; return { status: 'ok', items: [lesson()], warnings: [] }; } },
    );
    check(result.status === 'ok' && result.reason === null && calls === 1, 'synthetic selector result is evaluated by the real helper');
    check(result.message.startsWith(taskSpec) && result.message.slice(0, taskSpec.length) === taskSpec && result.lessons.length === 1 && result.message.includes(memoryRoot) && result.message.includes('lessons.md:7-9'), 'original filtered taskSpec remains the byte prefix and has complete source locator while metadata omits lesson body');
    check(result.message.includes('source-excerpt-sha256=' + 'a'.repeat(64)) && result.message.includes('trust=user-ratified') && result.message.includes('首轮执行前简短确认相关教训及本任务避错动作') && result.message.includes('fork_turns:none') && result.message.includes('不授予新权限'), 'message supplies cited historical lesson and execution acknowledgement without granting permission');
    check(Buffer.byteLength(lessonBlock(result.message, taskSpec), 'utf8') <= helper.MAX_BLOCK_BYTES, 'lesson frame stays inside its independent 8KiB budget');
  }

  {
    const calls = [];
    const result = await helper.prepareAgentTask(
      { memoryRoot, taskSpec },
      {
        selector: async (options) => {
          calls.push(options);
          return {
            status: 'ok',
            reason: null,
            items: [lesson('release:one'), lesson('release:two'), lesson('release:three'), lesson('release:four')],
            warnings: ['query-limited', 'b5-trigger-metadata-not-used:3', 'lexical-historical-reference'],
          };
        },
      },
    );
    check(calls.length === 1 && JSON.stringify(calls[0]) === JSON.stringify({ memoryRoot, query: taskSpec, limit: 3, maxChars: 2400 }), 'selector receives only root, filtered taskSpec, and fixed retrieval limits');
    check(result.lessons.length === 3 && result.message.includes('query-limited') && result.message.includes('trigger-metadata-degraded') && result.message.includes('lexical-reference') && !result.message.includes('metadata-not-used:3') && !result.message.includes('release:four'), 'warnings are finite and output has at most three candidates');
  }

  {
    const result = await helper.prepareAgentTask(
      { memoryRoot, taskSpec },
      { selector: async () => ({ status: 'no-match', reason: null, items: [], warnings: [] }) },
    );
    check(result.status === 'no-match' && result.reason === null && result.lessons.length === 0 && result.message.includes('召回状态：no-match') && result.message.includes('主审负责'), 'no-match is explicit and does not pretend a lesson was retrieved');
  }

  {
    const result = await helper.prepareAgentTask(
      { memoryRoot, taskSpec },
      { selector: async () => ({ status: 'unavailable', reason: 'manifest-timeout', items: [], warnings: [] }) },
    );
    check(result.status === 'unavailable' && result.reason === 'source-unavailable' && result.message.includes('召回状态：unavailable') && result.message.includes('不能伪称已检索成功'), 'source failure remains unavailable and visible to the task recipient');
  }

  {
    const result = await helper.prepareAgentTask(
      { memoryRoot, taskSpec },
      { selector: async () => ({ status: 'ok', items: [{ tag: 'bad' }], warnings: [] }) },
    );
    check(result.status === 'unavailable' && result.reason === 'invalid-selector-result' && result.lessons.length === 0, 'malformed ok selector payload is rejected rather than converted to no-match');
  }

  {
    const result = await helper.prepareAgentTask(
      { memoryRoot, taskSpec },
      { selector: async () => ({ status: 'unavailable', reason: 'output-limit', items: [], warnings: [] }) },
    );
    check(result.status === 'unavailable' && result.reason === 'output-limit' && result.message.includes('展示受限') && result.message.includes('主审负责补查') && !result.message.includes('没有历史候选'), 'selector output-limit stays display-limited unavailable and asks the reviewer to supplement');
  }

  {
    check(helper.isAbsoluteMemoryRoot('/tmp/pmm-fixture', 'linux') && !helper.isAbsoluteMemoryRoot('/tmp\\pmm-fixture', 'linux'), 'POSIX simulation rejects a backslash spelling before any selector call');
  }

  {
    const unsafeRoots = ['//server/share', '//?/C:/memory', '/??/C:/memory', 'file:///memory', 'https://example/memory', 'C://memory'];
    let calls = 0;
    const results = [];
    for (const unsafeRoot of unsafeRoots) {
      results.push(await helper.prepareAgentTask(
        { memoryRoot: unsafeRoot, taskSpec },
        { selector: async () => { calls += 1; return { status: 'ok', items: [lesson()], warnings: [] }; } },
      ));
    }
    check(calls === 0 && results.every((result) => result.status === 'unavailable' && result.reason === 'source-missing'), 'UNC, device, URL, and doubled-slash roots are rejected before selector invocation');
  }

  {
    let calls = 0;
    const result = await helper.prepareAgentTask(
      { memoryRoot: null, taskSpec },
      { selector: async () => { calls += 1; return { status: 'ok', items: [lesson()], warnings: [] }; } },
    );
    check(result.status === 'unavailable' && result.reason === 'source-missing' && calls === 0 && result.message.startsWith(taskSpec), 'missing source does not fall back or invoke the selector');
  }

  {
    const maxSpec = 's'.repeat(helper.MAX_TASK_BYTES);
    const first = await helper.prepareAgentTask(
      { memoryRoot, taskSpec: maxSpec },
      { selector: async () => ({ status: 'no-match', items: [], warnings: [] }) },
    );
    let calls = 0;
    const refreshed = await helper.prepareAgentTask(
      { memoryRoot, taskSpec: first.message },
      { selector: async (options) => { calls += 1; return { status: 'no-match', items: [], warnings: [] }; } },
    );
    check(first.status === 'no-match' && refreshed.status === 'no-match' && calls === 1, 'a valid 32KiB original taskSpec can refresh its strict lesson frame without a false size failure');
  }

  {
    let calls = 0;
    const huge = 'x'.repeat(helper.MAX_TASK_BYTES + 1);
    const result = await helper.prepareAgentTask(
      { memoryRoot, taskSpec: huge },
      { selector: async () => { calls += 1; return { status: 'ok', items: [lesson()], warnings: [] }; } },
    );
    check(result.status === 'unavailable' && result.reason === 'task-too-large' && result.message === huge && calls === 0, 'oversize taskSpec is rejected before retrieval without changing its bytes');
  }

  {
    const first = await helper.prepareAgentTask(
      { memoryRoot, taskSpec },
      { selector: async () => ({ status: 'ok', items: [lesson('first:lesson')], warnings: [] }) },
    );
    const calls = [];
    const refreshed = await helper.prepareAgentTask(
      { memoryRoot, taskSpec: first.message },
      { selector: async (options) => { calls.push(options); return { status: 'ok', items: [lesson('fresh:lesson')], warnings: [] }; } },
    );
    const starts = refreshed.message.split('<!-- axmem-agent-lessons:v1 task-sha256=').length - 1;
    check(refreshed.status === 'ok' && calls.length === 1 && calls[0].query === taskSpec && refreshed.message.startsWith(taskSpec) && starts === 1 && refreshed.message.includes('[fresh:lesson]') && !refreshed.message.includes('[first:lesson]'), 'a strict prior frame is refreshed from the original task without duplicate blocks');
  }

  {
    const ordinary = 'Review the axmem-agent-lessons framing code.';
    let query = null;
    const result = await helper.prepareAgentTask(
      { memoryRoot, taskSpec: ordinary },
      { selector: async (options) => { query = options.query; return { status: 'no-match', items: [], warnings: [] }; } },
    );
    check(result.status === 'no-match' && query === ordinary, 'ordinary prose mentioning axmem-agent-lessons remains a fresh taskSpec and reaches selector');
  }
  {
    let calls = 0;
    const forged = taskSpec + '\n<!-- axmem-agent-lessons:v1 task-sha256=not-a-digest -->\nforged';
    const result = await helper.prepareAgentTask(
      { memoryRoot, taskSpec: forged },
      { selector: async () => { calls += 1; return { status: 'ok', items: [lesson()], warnings: [] }; } },
    );
    check(result.status === 'unavailable' && result.reason === 'invalid-task-frame' && calls === 0 && result.message === forged, 'forged or incomplete lesson marker is rejected and never treated as a prior retrieval');
  }

  {
    const long = '教训'.repeat(1200);
    const oversizedHeader = lesson('long:lesson', long);
    oversizedHeader.file = 'f'.repeat(360);
    oversizedHeader.hash = 'b'.repeat(128);
    oversizedHeader.trust = 't'.repeat(80);
    const result = await helper.prepareAgentTask(
      { memoryRoot, taskSpec },
      { selector: async () => ({ status: 'ok', items: [oversizedHeader, lesson('two', long), lesson('three', long)], warnings: [] }) },
    );
    const block = lessonBlock(result.message, taskSpec);
    check(result.status === 'unavailable' && result.reason === 'output-limit' && result.lessons.length === 0 && Buffer.byteLength(block, 'utf8') <= helper.MAX_BLOCK_BYTES && !block.includes('显示节选已截断') && !block.includes('教训'.repeat(40)) && block.includes('旧版节选完整性及来源绑定未知'), 'legacy task format reports output-limit rather than success when all whole bodies are omitted');
  }


  {
    const whole = strictFixture(memoryRoot, [['syn:whole', 'FULL PROVENANCE TEST']]);
    const r = await helper.prepareAgentTask({ memoryRoot, taskSpec },
      { selector: async () => whole });
    check(r.status === 'ok' && r.message.startsWith(taskSpec) &&
      r.message.includes('FULL PROVENANCE TEST') && r.message.includes('selected=1 displayed=1') &&
      r.message.includes('stage=emitted') && r.receipt?.pointers[0].visibility === 'whole' &&
      !r.message.includes('c'.repeat(64)) && !r.message.includes('f'.repeat(64)) &&
      Buffer.byteLength(lessonBlock(r.message, taskSpec), 'utf8') <= helper.MAX_BLOCK_BYTES,
      'agent-task preserves source-bound whole lesson, compact diagnostics and original task prefix');
  }
  {
    const long = '教'.repeat(1900) + 'FINAL-EXCEPTION';
    const data = strictFixture(memoryRoot, [['syn:huge1', long],
      ['syn:huge2', long], ['syn:huge3', 'short complete']]);
    const r = await helper.prepareAgentTask({ memoryRoot, taskSpec },
      { selector: async () => data });
    check(r.message.startsWith(taskSpec) && r.receipt?.counts.selected === 3 &&
      r.receipt.counts.omitted >= 1 && r.receipt.pointers.some((p) => p.reason === 'task-budget') &&
      Buffer.byteLength(lessonBlock(r.message, taskSpec), 'utf8') <= helper.MAX_BLOCK_BYTES &&
      r.message.includes('fullEntrySHA256=') &&
      (!r.message.includes('教'.repeat(40)) || r.message.includes('FINAL-EXCEPTION')) &&
      r.message.includes('short complete'), 'agent-task retains three ranked pointers without partial long entry');
  }
  {
    const omitted = strictFixture(memoryRoot, [['syn:omitted', 'HIDDEN']], true);
    const r = await helper.prepareAgentTask({ memoryRoot, taskSpec },
      { selector: async () => omitted });
    check(r.status === 'unavailable' && r.reason === 'output-limit' &&
      r.receipt?.counts.selected === 1 && r.receipt.counts.displayed === 0 &&
      r.message.includes('syn:omitted') && r.message.includes('selector-budget') &&
      !r.message.includes('HIDDEN') && r.lessons.length === 1,
      'agent-task preserves selector all-omitted receipts and source pointer despite unavailable status');
  }
  {
    const longTag = 'demo:' + 'x'.repeat(130);
    const accepted = helper.normaliseSelectorResult(
      strictFixture(memoryRoot, [[longTag, 'LONG TAG BODY']]), memoryRoot);
    const rejected = helper.normaliseSelectorResult(
      strictFixture(memoryRoot, [['demo:' + 'x'.repeat(508), 'TOO LONG']]), memoryRoot);
    check(accepted.status === 'ok' && accepted.items[0].tag === longTag &&
      accepted.receipt.pointers[0].tag === longTag && rejected.status === 'unavailable' &&
      rejected.reason === 'invalid-selector-result' && !Object.hasOwn(rejected, 'receipt'),
      'agent-task preserves a valid 135-character identity and rejects a receipt tag over 512 characters');
  }
  {
    const dirty = { tag: 'demo:legacy\n' + 't'.repeat(180),
      file: 'lessons.md\r\n' + 'f'.repeat(380), line: 7, endLine: 9,
      hash: 'bad\t' + 'h'.repeat(180), trust: 'observed\n' + 'r'.repeat(120), text: 'legacy body' };
    const normalized = helper.normaliseSelectorResult(
      { status: 'ok', reason: null, items: [dirty], warnings: [] }, memoryRoot);
    const legacy = normalized.items[0], metadata = legacy.tag + legacy.file + legacy.hash + legacy.trust;
    check(normalized.status === 'ok' && !/[\u0000-\u001f\u007f]/.test(metadata) &&
      Buffer.byteLength(legacy.tag, 'utf8') <= 120 && Buffer.byteLength(legacy.file, 'utf8') <= 360 &&
      Buffer.byteLength(legacy.hash, 'utf8') <= 128 && Buffer.byteLength(legacy.trust, 'utf8') <= 80,
      'receipt-absent agent-task legacy metadata keeps control cleaning and historical byte caps');
  }
  {
    const limited = strictSelectionLimitFixture(memoryRoot);
    const normalized = helper.normaliseSelectorResult(limited, memoryRoot);
    const result = await helper.prepareAgentTask({ memoryRoot, taskSpec },
      { selector: async () => limited });
    check(normalized.status === 'unavailable' && normalized.reason === 'selection-limit' &&
      normalized.receipt.counts.matched === 1 && result.status === 'unavailable' &&
      result.reason === 'selection-limit' && result.lessons.length === 0 &&
      result.message.startsWith(taskSpec) &&
      result.message.includes('存在匹配，但受固定候选选择上限限制，主审需补查') &&
      !result.message.includes('没有历史候选') && !result.message.includes('output-limit') &&
      !result.message.includes('demo:limited-safe5') && !result.message.includes('SAFE-FIFTH-BODY'),
      'agent-task preserves finite selection-limit receipt, task prefix and truthful no-ID text');
  }
  {
    const valid = [strictNoMatchFixture(memoryRoot), strictNoMatchFixture(memoryRoot, 'empty-query'),
      strictFixture(memoryRoot, [['syn:omitted-control', 'HIDDEN']], true)];
    const base = strictNoMatchFixture(memoryRoot);
    const invalid = [
      { ...base, reason: 'output-limit' }, { ...base, reason: null },
      { ...base, reason: 7 }, { ...base, reason: 'future-reason' },
      { ...base, receipt: { ...base.receipt, stage: 'omitted' } },
      { ...base, receipt: { ...base.receipt, counts: { ...base.receipt.counts,
        matched: 1, matchedIdsNotListed: 1 } } },
      { ...base, receipt: { ...base.receipt, counts: { ...base.receipt.counts,
        matched: 2, matchedIdsNotListed: 2 } } },
    ].map((value) => helper.normaliseSelectorResult(value, memoryRoot));
    const normalized = valid.map((value) => helper.normaliseSelectorResult(value, memoryRoot));
    check(normalized[0].status === 'no-match' && normalized[0].reason === 'no-lexical-match' &&
      normalized[1].status === 'no-match' && normalized[1].reason === 'empty-query' &&
      normalized[2].status === 'unavailable' && normalized[2].reason === 'output-limit' &&
      invalid.every((value) => value.status === 'unavailable' &&
        value.reason === 'invalid-selector-result' && !Object.hasOwn(value, 'receipt')),
      'agent-task accepts coherent finite receipt outcomes and rejects contradictory reasons/stages/counts');
  }
  {
    const original = strictFixture(memoryRoot, [['syn:invalid', 'SHOULD NEVER BE RENDERED']]);
    const wrong = [ { ...original.receipt, v: 7 },
      { ...original.receipt, extra: 1 },
      { ...original.receipt, counts: { ...original.receipt.counts, omitted: 1 } },
      { ...original.receipt, pointers: [{ ...original.receipt.pointers[0], sourceRoot: memoryRoot + 'other' }] },
      { ...original.receipt, pointers: [{ ...original.receipt.pointers[0], tag: 'another:tag' }] } ];
    const outcomes = [];
    for (const receipt of wrong) outcomes.push(await helper.prepareAgentTask({ memoryRoot, taskSpec },
      { selector: async () => ({ ...original, receipt }) }));
    check(outcomes.every((r) => r.status === 'unavailable' &&
      r.reason === 'invalid-selector-result' && r.lessons.length === 0 &&
      r.message.startsWith(taskSpec) && !r.message.includes('SHOULD NEVER BE RENDERED')),
      'agent-task invalid v1 receipt fails closed with task prefix unchanged');
  }


  // C1 integration: actual prepared task text and v1 receipt retain a whole,
  // hash-bound entry from the real selector, within the 8192-byte frame.
  {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const { recall, validateReceipt } = require('./recall-selector.cjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-task-synthetic-'));
    const body = 'C1_TASK_WHOLE_' + 'T'.repeat(745);
    try {
      fs.writeFileSync(path.join(root, 'decisions.md'),
        '## Index\n- 2026-01-01 Task rule [syn:task]\n\n## Entries\n' +
        '**2026-01-01 — Task rule** [syn:task] [trust:observed]\n' + body + '\n');
      fs.writeFileSync(path.join(root, 'lessons.md'), '## Index\n\n## Entries\n');
      fs.writeFileSync(path.join(root, 'standinginstructions.md'), '## Index\n\n## Entries\n');
      const task = 'Inspect the synthetic rule [syn:task] without changing product code.';
      let original;
      const response = await helper.prepareAgentTask({ memoryRoot: root, taskSpec: task },
        { selector: async (input) => { original = await recall(input); return original; } });
      const hash = crypto.createHash('sha256').update(original.items[0]?.text || '').digest('hex');
      check(original.status === 'ok' && validateReceipt(original.receipt, original.items, root) &&
        response.status === 'ok' && response.receipt?.event === 'agent-task' &&
        response.receipt.counts.selected === 1 && response.receipt.counts.displayed === 1 &&
        response.receipt.counts.omitted === 0 && response.receipt.pointers[0].fullEntrySha256 === hash &&
        response.lessons[0].hash === hash && response.message.startsWith(task) &&
        response.message.includes(body) && response.message.includes('stage=emitted selected=1 displayed=1 omitted=0') &&
        Buffer.byteLength(response.message.slice(task.length), 'utf8') <= helper.MAX_BLOCK_BYTES,
        'real selector to prepareAgentTask keeps exact whole body/hash and final truthful 8KiB counts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // C8: real prepareAgentTask forwards only owned actionContext; verified
  // source bytes, full-body receipt, task prefix and frame hash survive.
  {
    const fs = require('node:fs'), os = require('node:os');
    const path = require('node:path'), crypto = require('node:crypto');
    const { recall, validateReceipt } = require('./recall-selector.cjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c8-task-action-'));
    const bodyA = 'C8_TASK_VERIFIED_ATLAS';
    const bodyB = 'C8_TASK_VERIFIED_ORBIT';
    try {
      fs.writeFileSync(path.join(root, 'decisions.md'),
        '## Index\n- 2026-01-01 Atlas [syn:atlas]\n- 2026-01-01 Orbit [syn:orbit]\n\n## Entries\n' +
        '**2026-01-01 — Atlas** [syn:atlas] [trust:observed]\n' + bodyA +
        '\n<!-- trigger: tool=Edit; repo=atlas; path=src/action.ts -->\n' +
        '**2026-01-01 — Orbit** [syn:orbit] [trust:observed]\n' + bodyB +
        '\n<!-- trigger: tool=Edit; repo=orbit; path=src/action.ts -->\n');
      for (const name of ['lessons.md','standinginstructions.md'])
        fs.writeFileSync(path.join(root,name),'## Index\n\n## Entries\n');
      const task = 'Inspect synthetic [syn:orbit] for the current explicit action.';
      const ctx = { tool:'Edit',repo:'atlas',path:'SRC/ACTION.TS' };
      const calls=[];
      const selector = async (options) => { calls.push(options); return recall(options); };
      const supplied = await helper.prepareAgentTask({memoryRoot:root,taskSpec:task,actionContext:ctx},
        {selector});
      const taskHash = crypto.createHash('sha256').update(task,'utf8').digest('hex');
      check(calls.length===1 && Object.hasOwn(calls[0],'actionContext') &&
        calls[0].actionContext === ctx && supplied.status === 'ok' &&
        supplied.receipt?.query.method === 'action-trigger' &&
        supplied.receipt.pointers[0]?.tag === 'syn:atlas' &&
        supplied.receipt.counts.matched === 1 &&
        supplied.message.startsWith(task) &&
        supplied.message.includes('task-sha256='+taskHash) &&
        supplied.message.includes(bodyA) && !supplied.message.includes(bodyB) &&
        supplied.message.includes('stage=emitted selected=1 displayed=1 omitted=0') &&
        Buffer.byteLength(supplied.message.slice(task.length),'utf8')<=helper.MAX_BLOCK_BYTES,
        'C8 explicit owned context reaches real selector and whole task frame/hash');
      const direct = await recall({memoryRoot:root,query:task,actionContext:ctx});
      check(validateReceipt(direct.receipt,direct.items,root) &&
        direct.items[0].hash === supplied.lessons[0]?.hash,
        'C8 helper source pointer is bound to direct selector entry');
      const absent=[];
      await helper.prepareAgentTask({memoryRoot:root,taskSpec:task},
        {selector:async(options)=>{absent.push(options);return {status:'no-match',reason:'no-lexical-match',
          items:[],warnings:[]};}});
      check(absent.length===1 && !Object.hasOwn(absent[0],'actionContext'),
        'C8 omitted context is not inferred from task text');
      const invalid = await helper.prepareAgentTask(
        {memoryRoot:root,taskSpec:task,actionContext:null},{selector});
      check(invalid.status==='unavailable' && invalid.reason==='invalid-input' &&
        !invalid.message.includes(bodyA) && !invalid.message.includes(bodyB),
        'C8 invalid owned context fails finite without lexical fallback');
      const noMatch = await helper.prepareAgentTask(
        {memoryRoot:root,taskSpec:task,actionContext:{tool:'Edit',repo:'wrong',path:'src/action.ts'}},
        {selector});
      check(noMatch.status==='no-match' && noMatch.reason==='no-action-match' &&
        noMatch.receipt?.query.method==='action-trigger' && noMatch.receipt.counts.matched===0 &&
        !noMatch.message.includes(bodyA),
        'C8 no action match keeps a valid coherent agent-task receipt');
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  }

  process.stdout.write((passed === total ? 'PASS' : 'FAIL') + ' agent task context self-test ' + passed + '/' + total + '\n');
  if (passed !== total) process.exitCode = 1;
}

const selfTestArgs = process.argv.slice(2);
if (selfTestArgs.length && (selfTestArgs.length !== 1 || selfTestArgs[0] !== '--self-test')) {
  process.stderr.write('usage: node test-agent-task-context.cjs [--self-test]\n');
  process.exitCode = 2;
} else {
  main().catch((error) => {
    process.stderr.write('test harness failure: ' + (error && error.name ? error.name : 'Error') + '\n');
    process.exitCode = 1;
  });
}
