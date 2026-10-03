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
    check(Buffer.byteLength(block, 'utf8') <= helper.MAX_BLOCK_BYTES && block.includes('显示节选已截断') && block.includes('source-excerpt-sha256 是原 selector 节选哈希'), 'block uses complete-item budgeting and labels a truncated display hash correctly');
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
