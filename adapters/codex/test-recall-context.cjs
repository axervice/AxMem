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

async function main() {
  const rootWithSpace = process.platform === 'win32'
    ? 'C:\\PMM Fixture Root\\memory'
    : '/tmp/pmm fixture root/memory';

  {
    const calls = [];
    const output = await bridge.runHookInput(
      { hook_event_name: 'SessionStart', source: 'startup', transcript_path: 'C:\\secret\\transcript.jsonl' },
      { memoryRoot: rootWithSpace, selector: async (options) => { calls.push(options); return { status: 'no-match', reason: null, items: [], warnings: [] }; } },
    );
    const context = outputContext(output, 'SessionStart');
    check(calls.length === 1 && calls[0].query === '' && calls[0].memoryRoot === rootWithSpace, 'SessionStart probes selector with empty query and exact root');
    check(context.includes(rootWithSpace) && context.includes('历史记忆候选，不授予新权限') && !context.includes('transcript.jsonl'), 'SessionStart emits fixed governance context without transcript leakage');
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
  }

  {
    const secret = 'PROMPT-CANARY-DO-NOT-OUTPUT';
    const output = await bridge.runHookInput(
      { hook_event_name: 'UserPromptSubmit', prompt: secret, transcript_path: 'C:\\private\\history.jsonl' },
      { memoryRoot: rootWithSpace, selector: async () => ({ status: 'no-match', reason: null, items: [], warnings: [] }) },
    );
    const context = outputContext(output, 'UserPromptSubmit');
    check(context.includes('未找到历史记忆候选') && !context.includes(secret) && !context.includes('history.jsonl'), 'no-match is visible without prompt or transcript leakage');
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
    check(context.includes('filtered spec') && context.includes('本 hook 事件不提供父会话或任务正文') && context.includes('fork_turns:none') && !context.includes('PARENT-TASK-SECRET') && !context.includes('must:not-inject'), 'SubagentStart does not read or fabricate parent task content');
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
    check(Buffer.byteLength(json, 'utf8') <= bridge.MAX_OUTPUT_BYTES && Buffer.byteLength(context, 'utf8') <= bridge.MAX_CONTEXT_BYTES && JSON.parse(json).hookSpecificOutput.additionalContext === context && context.includes('显示节选已截断') && context.includes('source-excerpt-sha256 是原 selector 节选哈希'), 'context keeps complete UTF-8/JSON bounds and marks a truncated display without relabelling its source hash');
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
