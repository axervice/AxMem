#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');

const bridgePath = path.join(__dirname, 'recall-context.cjs');
const bridge = require('./recall-context.cjs');

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

function outputContext(output, event) {
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  assert.equal(output.hookSpecificOutput.hookEventName, event);
  return output.hookSpecificOutput.additionalContext;
}

function item(tag, text) {
  return {
    tag,
    file: 'lessons.md',
    line: 12,
    endLine: 14,
    hash: '0123456789abcdef',
    trust: 'observed',
    text: text || 'A bounded historical note.',
  };
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
  const rootWithSpace = process.platform === 'win32'
    ? 'C:\\PMM Fixture Root\\memory'
    : '/tmp/pmm fixture root/memory';

  const lifecycleIdentity = (event) => 'AxMem lifecycle event=' + event + ' adapter=codex-recall-v1';
  async function maximalLifecycleContext(event) {
    const memoryRoot = process.platform === 'win32' ? 'C:/' + '根'.repeat(1000) : '/' + '根'.repeat(1000);
    const warnings = ['query-limited', 'b5-trigger-metadata-not-used:999', 'graph-ambiguous-excluded:999',
      'unknown-trust-excluded:999', 'lexical-historical-reference', 'excerpt-may-be-truncated'];
    const output = await bridge.runHookInput({ hook_event_name: event, source: 'startup' },
      { memoryRoot, selector: async () => ({ status: 'no-match', reason: null, items: [], warnings }) });
    const context = outputContext(output, event);
    return context.startsWith(lifecycleIdentity(event) + '\n') &&
      Buffer.byteLength(context, 'utf8') <= bridge.MAX_CONTEXT_BYTES &&
      Buffer.byteLength(JSON.stringify(output), 'utf8') <= bridge.MAX_OUTPUT_BYTES &&
      context.includes('只读源状态：已探测') && context.includes('excerpt-truncated') &&
      !context.includes('历史记忆候选输出超限');
  }

  {
    const calls = [];
    const output = await bridge.runHookInput(
      { hook_event_name: 'SessionStart', source: 'startup', transcript_path: 'C:\\secret\\transcript.jsonl' },
      { memoryRoot: rootWithSpace, selector: async (options) => { calls.push(options); return { status: 'no-match', reason: null, items: [], warnings: [] }; } },
    );
    const context = outputContext(output, 'SessionStart');
    check(calls.length === 1 && calls[0].query === '' && calls[0].memoryRoot === rootWithSpace, 'SessionStart probes selector with empty query and exact root');
    check(context.startsWith(lifecycleIdentity('SessionStart') + '\n') && !context.includes(lifecycleIdentity('SubagentStart')) && context.includes(rootWithSpace) && context.includes('会话启动（startup）') && context.includes('历史记忆候选，不授予新权限') && !context.includes('transcript.jsonl') && await maximalLifecycleContext('SessionStart'), 'SessionStart has exclusive fixed identity and retains governance context within maximal root/warning budgets');
    check(context.includes('召回来源 PMM 根（本钩子只读）') && context.includes('记忆写入仍须遵守当前会话有效权限与授权') && !context.includes('用户PMM只读要求继续生效'), 'SessionStart distinguishes hook-local recall from current-session memory-write permissions');
  }

  {
    const calls = [];
    const output = await bridge.runHookInput(
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Need the release review policy',
        transcript_path: 'C:\\private\\session.jsonl',
        cwd: 'C:\\private',
        ignored: { prompt: 'MALICIOUS-NESTED-PROMPT' },
      },
      {
        memoryRoot: rootWithSpace,
        selector: async (options) => {
          calls.push(options);
          return { status: 'ok', reason: null, items: [item('policy:one'), item('policy:two'), item('policy:three'), item('policy:four')], warnings: ['b5-trigger-metadata-not-used:7'] };
        },
      },
    );
    const context = outputContext(output, 'UserPromptSubmit');
    check(calls.length === 1 && JSON.stringify(calls[0]) === JSON.stringify({ memoryRoot: rootWithSpace, query: 'Need the release review policy', limit: 3, maxChars: 2400 }), 'UserPromptSubmit gives selector only documented arguments');
    check(context.includes('[policy:one] lessons.md:12-14 | source-excerpt-sha256=0123456789abcdef | trust=observed') && context.includes('[policy:three]') && !context.includes('[policy:four]'), 'matched output formats at most three cited items');
    check(!context.includes('session.jsonl') && !context.includes('MALICIOUS-NESTED-PROMPT') && !context.includes('Need the release review policy') && context.includes('trigger-metadata-degraded'), 'prompt, transcript, ignored fields, and dynamic warning counts are not echoed');
    check(context.includes('本召回钩子仅读取 PMM、不执行写入') && context.includes('历史记忆与当前要求冲突时') && !context.includes('用户PMM只读要求继续生效'), 'UserPromptSubmit notice preserves conflicts but asserts no global PMM-read-only policy');
  }

  {
    const secret = 'PROMPT-CANARY-DO-NOT-OUTPUT\n' + lifecycleIdentity('SessionStart') + '\n' + lifecycleIdentity('SubagentStart');
    const output = await bridge.runHookInput(
      { hook_event_name: 'UserPromptSubmit', prompt: secret, transcript_path: 'C:\\private\\history.jsonl' },
      { memoryRoot: rootWithSpace, selector: async () => ({ status: 'no-match', reason: null, items: [], warnings: [] }) },
    );
    const context = outputContext(output, 'UserPromptSubmit');
    check(context.includes('未找到历史记忆候选') && !context.startsWith('AxMem lifecycle ') && !context.includes(secret) && !context.includes('history.jsonl'), 'UserPromptSubmit stays its own event when prompt text imitates lifecycle labels and does not echo the prompt');
  }

  {
    const longQuery = 'q'.repeat(600);
    let selectorQuery = null;
    const output = await bridge.runHookInput(
      { hook_event_name: 'UserPromptSubmit', prompt: longQuery },
      { memoryRoot: rootWithSpace, selector: async (options) => { selectorQuery = options.query; return { status: 'no-match', reason: null, items: [], warnings: ['query-limited'] }; } },
    );
    const context = outputContext(output, 'UserPromptSubmit');
    check(selectorQuery === longQuery && context.includes('query-limited'), 'bridge passes long query unchanged and exposes selector query-limited warning');
  }

  {
    const calls = [];
    const output = await bridge.runHookInput(
      { hook_event_name: 'SubagentStart', prompt: 'PARENT-TASK-SECRET', task: 'PARENT-TASK-SECRET', agent_id: 'child-1' },
      { memoryRoot: rootWithSpace, selector: async (options) => { calls.push(options); return { status: 'ok', reason: null, items: [item('must:not-inject')], warnings: [] }; } },
    );
    const context = outputContext(output, 'SubagentStart');
    check(calls.length === 1 && calls[0].query === '', 'SubagentStart probes only with empty query');
    check(context.startsWith(lifecycleIdentity('SubagentStart') + '\n') && !context.includes(lifecycleIdentity('SessionStart')) && context.includes('filtered spec') && context.includes('本 hook 事件不提供父会话或任务正文') && context.includes('fork_turns:none') && !context.includes('PARENT-TASK-SECRET') && !context.includes('must:not-inject') && await maximalLifecycleContext('SubagentStart'), 'SubagentStart has exclusive fixed identity within maximal budgets without parent task disclosure');
    check(context.includes('查询 PMM 历史候选（本钩子只读）') && context.includes('召回来源 PMM 根：') && !context.includes('用户PMM只读要求继续生效'), 'SubagentStart marks recall-root source and keeps hook-local read-only scope');
  }

  {
    check(bridge.isAbsoluteMemoryRoot('/tmp/pmm-fixture', 'linux') && !bridge.isAbsoluteMemoryRoot('/tmp\\pmm-fixture', 'linux'), 'POSIX simulation accepts slash absolute roots and rejects backslash spellings before filesystem access');
  }

  {
    const unsafeRoots = ['//server/share', '//?/C:/memory', '/??/C:/memory', 'file:///memory', 'https://example/memory', 'C://memory'];
    let calls = 0;
    const contexts = [];
    for (const unsafeRoot of unsafeRoots) {
      const output = await bridge.runHookInput(
        { hook_event_name: 'UserPromptSubmit', prompt: 'x' },
        { memoryRoot: unsafeRoot, selector: async () => { calls += 1; return { status: 'ok', items: [item('unexpected')], warnings: [] }; } },
      );
      contexts.push(outputContext(output, 'UserPromptSubmit'));
    }
    check(calls === 0 && contexts.every((context) => context.includes('source-missing')), 'UNC, device, URL, and doubled-slash roots are rejected before selector invocation');
  }

  {
    const output = await bridge.runHookInput(
      { hook_event_name: 'UserPromptSubmit', prompt: 'x' },
      { memoryRoot: null, selector: async () => { throw new Error('must not run'); } },
    );
    const context = outputContext(output, 'UserPromptSubmit');
    check(context.includes('source-missing') && context.includes('不得将此视为“无匹配”'), 'missing source becomes model-visible unavailable');
  }

  {
    const output = await bridge.runHookInput(
      { hook_event_name: 'UserPromptSubmit', prompt: 'x' },
      { memoryRoot: rootWithSpace, selector: async () => { throw new Error('RAW SELECTOR FAILURE MUST NOT LEAK'); } },
    );
    const context = outputContext(output, 'UserPromptSubmit');
    check(context.includes('selector-error') && !context.includes('RAW SELECTOR FAILURE'), 'selector exception uses a finite safe unavailable reason');
  }

  {
    const output = await bridge.runHookInput(
      { hook_event_name: 'UserPromptSubmit', prompt: 'x' },
      { memoryRoot: rootWithSpace, selector: async () => ({ status: 'unavailable', reason: 'output-limit', items: [], warnings: [] }) },
    );
    const context = outputContext(output, 'UserPromptSubmit');
    check(context.includes('展示受限') && context.includes('output-limit') && context.includes('主审需补查') && !context.includes('未找到历史记忆候选'), 'selector output-limit stays model-visible as display-limited unavailable');
  }

  {
    const invalid = bridge.normaliseSelectorResult({ status: 'ok', items: [{ tag: 'bad' }], warnings: ['query-limited'] });
    check(invalid.status === 'unavailable' && invalid.reason === 'invalid-selector-result' && invalid.warnings[0] === 'query-limited', 'an ok selector result with no valid items is unavailable, not a false no-match');
  }

  {
    let calls = 0;
    const selector = async () => { calls += 1; return { status: 'ok', items: [item('unexpected')] }; };
    const precompact = await bridge.runHookInput({ hook_event_name: 'PreCompact', prompt: 'x' }, { memoryRoot: rootWithSpace, selector });
    const unknown = await bridge.runHookInput({ hook_event_name: 'UnknownEvent', prompt: 'x' }, { memoryRoot: rootWithSpace, selector });
    const badStart = await bridge.runHookInput({ hook_event_name: 'SessionStart', source: 'bad-source' }, { memoryRoot: rootWithSpace, selector });
    check(JSON.stringify(precompact) === '{}' && JSON.stringify(unknown) === '{}' && JSON.stringify(badStart) === '{}' && calls === 0, 'unknown, PreCompact, and malformed SessionStart are inert');
  }

  {
    const long = '记'.repeat(2400);
    const output = await bridge.runHookInput(
      { hook_event_name: 'UserPromptSubmit', prompt: 'x' },
      { memoryRoot: rootWithSpace, selector: async () => ({ status: 'ok', reason: null, items: [item('policy:long', long), item('policy:long2', long), item('policy:long3', long)], warnings: [] }) },
    );
    const json = JSON.stringify(output);
    const context = outputContext(output, 'UserPromptSubmit');
    check(Buffer.byteLength(json, 'utf8') <= bridge.MAX_OUTPUT_BYTES && Buffer.byteLength(context, 'utf8') <= bridge.MAX_CONTEXT_BYTES && JSON.parse(json).hookSpecificOutput.additionalContext === context && !context.includes('显示节选已截断') && !context.includes('记'.repeat(40)) && context.includes('候选元数据超出展示预算'), 'legacy result lacks verified completeness and never emits a partial rule');
  }

  {
    const parsed = bridge.parseCliArgs(['--memory-root', rootWithSpace]);
    const rejected = bridge.parseCliArgs(['--memory-root', rootWithSpace, 'PROMPT-IN-ARGV']);
    check(parsed.ok && parsed.memoryRoot === rootWithSpace && !rejected.ok, 'CLI accepts only explicit absolute memory root including spaces');
  }

  {
    const oversized = Buffer.alloc(bridge.MAX_STDIN_BYTES + 1, 0x61);
    const res = childProcess.spawnSync(process.execPath, [bridgePath, '--memory-root', rootWithSpace], { input: oversized, encoding: 'utf8' });
    check(res.status === 0 && res.stdout === '{}' && res.stderr.includes('input-too-large') && !res.stderr.includes('aaaa'), 'CLI rejects over-64KiB stdin without echoing input');
  }

  {
    const res = childProcess.spawnSync(process.execPath, [bridgePath], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'CLI-PROMPT-CANARY' }),
      encoding: 'utf8',
    });
    const parsed = JSON.parse(res.stdout);
    const context = outputContext(parsed, 'UserPromptSubmit');
    check(res.status === 0 && context.includes('source-missing') && !context.includes('CLI-PROMPT-CANARY') && res.stderr.includes('memory-root-required'), 'CLI missing root reports unavailable without prompt leakage');
  }


  {
    const whole = strictFixture(rootWithSpace, [['syn:verified', 'WHOLE VERIFIED BODY']]);
    const output = await bridge.runHookInput({ hook_event_name: 'UserPromptSubmit', prompt: 'test-canary' },
      { memoryRoot: rootWithSpace, selector: async () => whole });
    const context = outputContext(output, 'UserPromptSubmit');
    check(context.includes('WHOLE VERIFIED BODY') && context.includes('fullEntrySHA256=') &&
      context.includes('selected=1 displayed=1 omitted=0') && context.includes('stage=emitted') &&
      !context.includes('c'.repeat(64)) && !context.includes('f'.repeat(64)) &&
      !context.includes('test-canary') && !context.includes('"sourceRoot"'),
      'valid v1 whole entry is constructed with compact safe pointer; query/source-file hashes and raw prompt are not projected');
  }
  {
    const text = '记'.repeat(2200) + 'FINAL-EXCEPTION';
    const whole = strictFixture(rootWithSpace, [['syn:budget', text]]);
    const output = await bridge.runHookInput({ hook_event_name: 'UserPromptSubmit', prompt: 'synthetic' },
      { memoryRoot: rootWithSpace, selector: async () => whole });
    const context = outputContext(output, 'UserPromptSubmit');
    check(Buffer.byteLength(context, 'utf8') <= bridge.MAX_CONTEXT_BYTES &&
      Buffer.byteLength(JSON.stringify(output), 'utf8') <= bridge.MAX_OUTPUT_BYTES &&
      context.includes('syn:budget') && context.includes('omitted/bridge-budget') &&
      context.includes('displayed=0 omitted=1') && !context.includes('FINAL-EXCEPTION') &&
      !context.includes('记'.repeat(30)) && context.includes('output-limit'),
      'bridge omits entire verified multibyte entry with bound pointer and exact final wire budget');
  }
  {
    const omitted = strictFixture(rootWithSpace, [['syn:omitted', 'SECRETS-NOT-DISPLAYED']], true);
    const output = await bridge.runHookInput({ hook_event_name: 'UserPromptSubmit', prompt: 'x' },
      { memoryRoot: rootWithSpace, selector: async () => omitted });
    const context = outputContext(output, 'UserPromptSubmit');
    check(context.includes('syn:omitted') && context.includes('selector-budget') &&
      context.includes('output-limit') && !context.includes('SECRETS-NOT-DISPLAYED') &&
      !context.includes('未找到历史记忆候选'),
      'selector all-omitted unavailable retains verified v1 pointer at bridge');
  }
  {
    const longTag = 'demo:' + 'x'.repeat(130);
    const accepted = bridge.normaliseSelectorResult(
      strictFixture(rootWithSpace, [[longTag, 'LONG TAG BODY']]), rootWithSpace);
    const rejected = bridge.normaliseSelectorResult(
      strictFixture(rootWithSpace, [['demo:' + 'x'.repeat(508), 'TOO LONG']]), rootWithSpace);
    check(accepted.status === 'ok' && accepted.items[0].tag === longTag &&
      accepted.receipt.pointers[0].tag === longTag && rejected.status === 'unavailable' &&
      rejected.reason === 'invalid-selector-result' && !Object.hasOwn(rejected, 'receipt'),
      'bridge preserves a valid 135-character identity and rejects a receipt tag over 512 characters');
  }
  {
    const dirty = { tag: 'demo:legacy\n' + 't'.repeat(180),
      file: 'lessons.md\r\n' + 'f'.repeat(380), line: 7, endLine: 9,
      hash: 'bad\t' + 'h'.repeat(180), trust: 'observed\n' + 'r'.repeat(120), text: 'legacy body' };
    const normalized = bridge.normaliseSelectorResult(
      { status: 'ok', reason: null, items: [dirty], warnings: [] }, rootWithSpace);
    const legacy = normalized.items[0], metadata = legacy.tag + legacy.file + legacy.hash + legacy.trust;
    check(normalized.status === 'ok' && !/[\u0000-\u001f\u007f]/.test(metadata) &&
      Buffer.byteLength(legacy.tag, 'utf8') <= 120 && Buffer.byteLength(legacy.file, 'utf8') <= 360 &&
      Buffer.byteLength(legacy.hash, 'utf8') <= 128 && Buffer.byteLength(legacy.trust, 'utf8') <= 80,
      'receipt-absent bridge legacy metadata keeps control cleaning and historical byte caps');
  }
  {
    const limited = strictSelectionLimitFixture(rootWithSpace);
    const normalized = bridge.normaliseSelectorResult(limited, rootWithSpace);
    const output = await bridge.runHookInput({ hook_event_name: 'UserPromptSubmit', prompt: 'synthetic' },
      { memoryRoot: rootWithSpace, selector: async () => limited });
    const context = outputContext(output, 'UserPromptSubmit');
    check(normalized.status === 'unavailable' && normalized.reason === 'selection-limit' &&
      normalized.receipt.counts.matched === 1 && normalized.receipt.pointers.length === 0 &&
      context.includes('存在匹配，但受固定候选选择上限限制，主审需补查') &&
      !context.includes('未找到历史记忆候选') && !context.includes('output-limit') &&
      !context.includes('demo:limited-safe5') && !context.includes('SAFE-FIFTH-BODY'),
      'bridge preserves finite selection-limit receipt and emits truthful no-ID follow-up text');
  }
  {
    const valid = [strictNoMatchFixture(rootWithSpace),
      strictNoMatchFixture(rootWithSpace, 'empty-query'),
      strictFixture(rootWithSpace, [['syn:omitted-control', 'HIDDEN']], true)];
    const base = strictNoMatchFixture(rootWithSpace);
    const invalid = [
      { ...base, reason: 'output-limit' }, { ...base, reason: null },
      { ...base, reason: 7 }, { ...base, reason: 'future-reason' },
      { ...base, receipt: { ...base.receipt, stage: 'omitted' } },
      { ...base, receipt: { ...base.receipt, counts: { ...base.receipt.counts,
        matched: 1, matchedIdsNotListed: 1 } } },
      { ...base, receipt: { ...base.receipt, counts: { ...base.receipt.counts,
        matched: 2, matchedIdsNotListed: 2 } } },
    ].map((value) => bridge.normaliseSelectorResult(value, rootWithSpace));
    const normalized = valid.map((value) => bridge.normaliseSelectorResult(value, rootWithSpace));
    check(normalized[0].status === 'no-match' && normalized[0].reason === 'no-lexical-match' &&
      normalized[1].status === 'no-match' && normalized[1].reason === 'empty-query' &&
      normalized[2].status === 'unavailable' && normalized[2].reason === 'output-limit' &&
      invalid.every((value) => value.status === 'unavailable' &&
        value.reason === 'invalid-selector-result' && !Object.hasOwn(value, 'receipt')),
      'bridge accepts coherent finite receipt outcomes and rejects contradictory reasons/stages/counts');
  }
  {
    const original = strictFixture(rootWithSpace, [['syn:invalid', 'VALID BODY SHOULD NOT APPEAR']]);
    const malformed = [
      { ...original.receipt, v: 2 },
      { ...original.receipt, extra: 'untrusted' },
      { ...original.receipt, counts: { ...original.receipt.counts, selected: 2 } },
      { ...original.receipt, pointers: [{ ...original.receipt.pointers[0], sourceRoot: rootWithSpace + '-evil' }] },
      { ...original.receipt, pointers: [{ ...original.receipt.pointers[0], file: '../lessons.md' }] },
      { ...original.receipt, pointers: [{ ...original.receipt.pointers[0], fullEntrySha256: '0'.repeat(64) }] },
    ];
    const results = [];
    for (const receipt of malformed) {
      const output = await bridge.runHookInput({ hook_event_name: 'UserPromptSubmit', prompt: 'x' },
        { memoryRoot: rootWithSpace, selector: async () => ({ ...original, receipt }) });
      results.push(outputContext(output, 'UserPromptSubmit'));
    }
    check(results.length === 6 && results.every((s) => s.includes('invalid-selector-result') &&
      !s.includes('VALID BODY SHOULD NOT APPEAR') && !s.includes('syn:invalid')),
      'unknown/malformed receipt never becomes a false bridge ok, no-match or private body projection');
  }

  process.stdout.write((passed === total ? 'PASS' : 'FAIL') + ' codex recall context self-test ' + passed + '/' + total + '\n');
  if (passed !== total) process.exitCode = 1;
}

const selfTestArgs = process.argv.slice(2);
if (selfTestArgs.length && (selfTestArgs.length !== 1 || selfTestArgs[0] !== '--self-test')) {
  process.stderr.write('usage: node test-recall-context.cjs [--self-test]\n');
  process.exitCode = 2;
} else {
  main().catch((error) => {
    process.stderr.write('test harness failure: ' + (error && error.name ? error.name : 'Error') + '\n');
    process.exitCode = 1;
  });
}
