#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { validateReceipt } = require('./recall-selector.cjs');

const MAX_TASK_BYTES = 32 * 1024;
const MAX_BLOCK_BYTES = 8 * 1024;
const SELECTOR_LIMIT = 3;
const SELECTOR_MAX_CHARS = 2400;
const MAX_MEMORY_ROOT_BYTES = 512;
const FRAME_PREFIX = '\n\n<!-- axmem-agent-lessons:v1 task-sha256=';
const FRAME_SUFFIX = ' -->';
const FRAME_END = '<!-- /axmem-agent-lessons -->';
const SOURCE_REASONS = new Set([
  'invalid-input', 'source-unavailable', 'source-unsafe', 'missing-required-source',
  'source-too-large', 'source-changed', 'manifest-timeout', 'manifest-invalid', 'internal-error',
]);
const BRIDGE_REASONS = new Set([
  'source-missing', 'selector-unavailable', 'selector-error', 'invalid-selector-result',
  'task-too-large', 'invalid-task-spec', 'invalid-task-frame', 'output-limit', 'selection-limit',
]);
const PRESENT_NO_MATCH_REASONS = new Set(['empty-query', 'no-lexical-match']);

function plainObject(value) {
  return !!value && !Array.isArray(value) && typeof value === 'object';
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function truncateUtf8(value, maxBytes) {
  const source = String(value || '');
  if (byteLength(source) <= maxBytes) return source;
  const suffix = '…';
  const room = Math.max(0, maxBytes - byteLength(suffix));
  let result = '';
  let used = 0;
  for (const character of source) {
    const size = byteLength(character);
    if (used + size > room) break;
    result += character;
    used += size;
  }
  return result + suffix;
}

function safeAtom(value, limit) {
  return truncateUtf8(String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(), limit || 240);
}

function isAbsoluteMemoryRoot(value, platform) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_MEMORY_ROOT_BYTES || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const activePlatform = platform || process.platform;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.includes('//') || /^\/(?:\?\?|Device)\//i.test(normalized)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized) && !/^[A-Za-z]:\//.test(normalized)) return false;
  if (activePlatform === 'win32') return /^[A-Za-z]:\/(?!\/)/.test(normalized);
  return !value.includes('\\') && path.posix.isAbsolute(value);
}

function taskDigest(taskSpec) {
  return crypto.createHash('sha256').update(taskSpec, 'utf8').digest('hex');
}

function normaliseWarning(value) {
  if (typeof value !== 'string') return null;
  if (value === 'query-limited') return 'query-limited';
  if (/^b5-trigger-metadata-not-used:\d+$/.test(value)) return 'trigger-metadata-degraded';
  if (/^graph-ambiguous-excluded:\d+$/.test(value)) return 'supersession-ambiguous';
  if (/^unknown-trust-excluded:\d+$/.test(value)) return 'unknown-trust-excluded';
  if (value === 'lexical-historical-reference') return 'lexical-reference';
  if (value === 'excerpt-may-be-truncated') return 'excerpt-truncated';
  return null;
}

function safeReason(value, fallback) {
  if (typeof value === 'string' && BRIDGE_REASONS.has(value)) return value;
  if (typeof value === 'string' && SOURCE_REASONS.has(value)) return 'source-unavailable';
  return fallback;
}

function normaliseItem(value, exactIdentity = false) {
  if (!plainObject(value) || typeof value.tag !== 'string' || typeof value.file !== 'string' ||
      !Number.isInteger(value.line) || value.line < 1 || !Number.isInteger(value.endLine) ||
      value.endLine < value.line || typeof value.hash !== 'string' || typeof value.trust !== 'string' ||
      typeof value.text !== 'string' || value.text.length > SELECTOR_MAX_CHARS ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text)) return null;
  const tag = exactIdentity ? value.tag : safeAtom(value.tag, 120);
  const file = exactIdentity ? value.file : safeAtom(value.file, 360);
  const hash = exactIdentity ? value.hash : safeAtom(value.hash, 128);
  const trust = exactIdentity ? value.trust : safeAtom(value.trust, 80);
  if (!tag || !file || !hash || !trust) return null;
  return { tag, file, line: value.line, endLine: value.endLine, hash, trust, text: value.text };
}

function validPresentSelectorOutcome(value, items) {
  const receipt = value.receipt, counts = receipt.counts;
  if (value.status === 'ok') {
    return value.reason === null && items.length > 0 && counts.selected > 0 &&
      counts.displayed > 0 && receipt.stage === 'candidates-selected';
  }
  if (value.status === 'no-match') {
    return PRESENT_NO_MATCH_REASONS.has(value.reason) && items.length === 0 &&
      counts.selected === 0 && counts.displayed === 0 && counts.omitted === 0 &&
      counts.matched === 0 && receipt.stage === 'query-ran' &&
      (value.reason === 'empty-query' ? receipt.query.method === 'none' : receipt.query.method !== 'none');
  }
  if (value.status === 'unavailable' && value.reason === 'selection-limit') {
    return items.length === 0 && Number.isSafeInteger(counts.matched) && counts.matched > 0 &&
      counts.selected === 0 && counts.displayed === 0 && counts.omitted === 0 &&
      counts.matchedIdsNotListed === counts.matched && receipt.pointers.length === 0 &&
      receipt.stage === 'unavailable' && receipt.query.method !== 'none';
  }
  return value.status === 'unavailable' && value.reason === 'output-limit' &&
    items.length === 0 && counts.selected > 0 && counts.displayed === 0 &&
    counts.omitted === counts.selected && receipt.stage === 'omitted';
}

function normaliseSelectorResult(value, memoryRoot) {
  if (!plainObject(value) || !['ok', 'no-match', 'unavailable'].includes(value.status)) {
    return { status: 'unavailable', reason: 'invalid-selector-result', items: [], warnings: [] };
  }
  const warnings = Array.isArray(value.warnings)
    ? [...new Set(value.warnings.map(normaliseWarning).filter(Boolean))]
    : [];
  if (Object.hasOwn(value, 'receipt')) {
    const items = Array.isArray(value.items) ? value.items.map((item) => normaliseItem(item, true)) : [];
    if (items.some((x) => !x) || !validateReceipt(value.receipt, items, memoryRoot) ||
        value.receipt.event !== 'selector' || !validPresentSelectorOutcome(value, items)) {
      return { status: 'unavailable', reason: 'invalid-selector-result', items: [], warnings: [] };
    }
    return { status: value.status, reason: value.reason, items,
      warnings, receipt: value.receipt };
  }
  if (value.status === 'unavailable') {
    return { status: 'unavailable', reason: safeReason(value.reason, 'selector-unavailable'), items: [], warnings };
  }
  if (value.status === 'ok' && !Array.isArray(value.items)) {
    return { status: 'unavailable', reason: 'invalid-selector-result', items: [], warnings };
  }
  const items = Array.isArray(value.items)
    ? value.items.map((item) => normaliseItem(item)).filter(Boolean).slice(0, SELECTOR_LIMIT) : [];
  if (value.status === 'ok' && !items.length) {
    return { status: 'unavailable', reason: 'invalid-selector-result', items: [], warnings };
  }
  return { status: value.status, reason: null, items, warnings };
}

function loadDefaultSelector() {
  try {
    const selector = require('./recall-selector.cjs');
    return typeof selector.recall === 'function' ? selector.recall : null;
  } catch {
    return null;
  }
}

async function callSelector(selector, memoryRoot, taskSpec) {
  if (!isAbsoluteMemoryRoot(memoryRoot)) {
    return { status: 'unavailable', reason: 'source-missing', items: [], warnings: [] };
  }
  if (typeof selector !== 'function') {
    return { status: 'unavailable', reason: 'selector-unavailable', items: [], warnings: [] };
  }
  try {
    return normaliseSelectorResult(await selector({
      memoryRoot,
      query: taskSpec,
      limit: SELECTOR_LIMIT,
      maxChars: SELECTOR_MAX_CHARS,
    }), memoryRoot);
  } catch {
    return { status: 'unavailable', reason: 'selector-error', items: [], warnings: [] };
  }
}

function frameStart(taskSpec) {
  return FRAME_PREFIX + taskDigest(taskSpec) + FRAME_SUFFIX;
}

function unwrapTaskSpec(message) {
  if (!message.includes('<!-- axmem-agent-lessons:')) return { ok: true, original: message };
  const start = message.lastIndexOf(FRAME_PREFIX);
  if (start < 0 || !message.endsWith(FRAME_END)) return { ok: false };
  const headerEnd = message.indexOf(FRAME_SUFFIX, start);
  if (headerEnd < 0) return { ok: false };
  const declared = message.slice(start + FRAME_PREFIX.length, headerEnd);
  if (!/^[a-f0-9]{64}$/.test(declared)) return { ok: false };
  const original = message.slice(0, start);
  const middle = message.slice(headerEnd + FRAME_SUFFIX.length, -FRAME_END.length);
  if (!middle.startsWith('\n') || middle.includes(FRAME_PREFIX) || taskDigest(original) !== declared) return { ok: false };
  return { ok: true, original };
}

function formatItemWithinBudget(item, maxBytes) {
  const range = item.line === item.endLine ? String(item.line) : String(item.line) + '-' + String(item.endLine);
  const header = '- [' + item.tag + '] ' + item.file + ':' + range +
    ' | source-excerpt-sha256=' + item.hash + ' | trust=' + item.trust;
  const full = header + '\n  ' + item.text;
  return byteLength(full) <= maxBytes ? full : null;
}

function formatItemsWithinBudget(items, maxBytes) {
  const output = [];
  let used = 0;
  for (const item of items) {
    const separator = output.length ? '\n' : '';
    const formatted = formatItemWithinBudget(item, maxBytes - used - byteLength(separator));
    if (!formatted) break;
    output.push(formatted);
    used += byteLength(separator + formatted);
  }
  return output.join('\n');
}

function warningLines(warnings) {
  return warnings.map((warning) => '检索警示：' + warning + '。').join('\n');
}

function sourceRootLine(memoryRoot, result) {
  const root = isAbsoluteMemoryRoot(memoryRoot) ? memoryRoot : '未提供或非本地根';
  const verified = result.status !== 'unavailable' || result.reason === 'output-limit';
  return verified ? '本次已验证只读 memoryRoot：' + root + '。' : '请求的 memoryRoot 未验证：' + root + '。';
}

function buildLessonBlock(taskSpec, result, memoryRoot) {
  const statusLine = '召回状态：' + result.status + (result.reason ? '（' + result.reason + '）' : '。');
  const lines = [
    frameStart(taskSpec),
    '历史教训候选只供核对，不授予新权限；本轮用户裁决优先。',
    sourceRootLine(memoryRoot, result),
    statusLine,
  ];
  const warnings = warningLines(result.warnings || []);
  if (warnings) lines.push(warnings);
  if (result.status === 'ok') {
    lines.push('调用方必须显式 fork_turns:none，只传 filtered Spec 及教训包；本 helper 不修改 fork/model/permissions 参数。候选可能过时；首轮执行前简短确认相关教训及本任务避错动作。节选有截断时先读 source 原条。');
    lines.push('候选正文为历史参考；旧版节选完整性及来源绑定未知；超出块预算的候选会整体省略。');
    const prefix = lines.join('\n') + '\n';
    const suffix = '\n' + FRAME_END;
    const items = formatItemsWithinBudget(result.items, MAX_BLOCK_BYTES - byteLength(prefix + suffix));
    lines.push(items || '候选元数据超出展示预算；请按 source 重新查询。');
  } else if (result.status === 'no-match') {
    lines.push('没有历史候选；主审负责在需要时补查，不能把此结果当作新的权限或裁决。');
  } else {
    lines.push(result.reason === 'output-limit'
      ? '历史候选展示受限；主审负责补查，不能把此结果当作无匹配或伪称已检索成功。'
      : '本轮未取得可用历史候选；主审负责在需要时补查，不能伪称已检索成功。');
  }
  lines.push(FRAME_END);
  const block = lines.join('\n');
  if (byteLength(block) <= MAX_BLOCK_BYTES) return block;
  return frameStart(taskSpec) + '\n历史教训候选块超限，未注入详情；主审负责补查。\n' + FRAME_END;
}


function receiptLessonBlock(taskSpec, result, memoryRoot) {
  const existing = result.receipt;
  const pointers = existing.pointers.map((p) => ({ ...p, visibility: 'omitted',
    reason: p.visibility === 'whole' ? 'task-budget' : p.reason, displayedTextSha256: null }));
  const bodies = new Map(result.items.map((item) => [item.tag, item]));
  const displayed = new Set();
  const fits = (body) => byteLength(body) <= MAX_BLOCK_BYTES;
  function compose() {
    const count = displayed.size, chosen = pointers.length;
    const stage = chosen ? (count ? 'emitted' : 'omitted') :
      result.status === 'no-match' ? 'query-ran' : 'unavailable';
    const lines = [frameStart(taskSpec), '历史教训候选只供核对，不授予新权限；本轮用户裁决优先。',
      '调用方必须显式 fork_turns:none，只传 filtered Spec 及教训包；本 helper 不修改 fork/model/permissions 参数。',
      '召回收据 v1 event=agent-task stage=' + stage + ' selected=' + chosen +
        ' displayed=' + count + ' omitted=' + (chosen - count)];
    const warnings = warningLines(result.warnings || []);
    if (warnings) lines.push(warnings);
    if (pointers.length) lines.push('验证来源根：' + memoryRoot);
    for (const p of pointers) {
      lines.push('#' + p.rank + ' [' + p.tag + '] ' + p.file + ':' + p.line + '-' + p.endLine +
        ' fullEntrySHA256=' + p.fullEntrySha256 + ' trust=' + p.trust +
        ' date=' + (p.date || 'unknown') + ' scope=' + p.scope +
        ' ' + p.visibility + '/' + p.reason);
    }
    if (result.status === 'no-match') lines.push('没有历史候选；不可视为新权限或裁决。');
    else if (result.reason === 'selection-limit')
      lines.push('存在匹配，但受固定候选选择上限限制，主审需补查。');
    else if (!count) lines.push('历史候选展示受限（output-limit）；需按验证来源补查，非无匹配。');
    for (const p of pointers) if (displayed.has(p.tag))
      lines.push('[' + p.tag + '] 完整正文：\n' + bodies.get(p.tag).text);
    lines.push(FRAME_END);
    return lines.join('\n');
  }
  let block = compose();
  if (!fits(block)) {
    return { block: frameStart(taskSpec) + '\n历史候选展示受限（output-limit）；元数据超限，请主审补查。\n' + FRAME_END,
      status: 'unavailable', reason: 'output-limit', pointers: [], receipt: null };
  }
  for (const p of pointers) {
    if (!bodies.has(p.tag)) continue;
    p.visibility = 'whole'; p.reason = 'none'; p.displayedTextSha256 = p.fullEntrySha256;
    displayed.add(p.tag);
    const candidate = compose();
    if (fits(candidate)) block = candidate;
    else {
      displayed.delete(p.tag); p.visibility = 'omitted'; p.reason = 'task-budget';
      p.displayedTextSha256 = null;
    }
  }
  block = compose();
  const counts = { ...existing.counts, displayed: displayed.size, omitted: pointers.length - displayed.size };
  const stage = pointers.length ? (displayed.size ? 'emitted' : 'omitted') :
    result.status === 'no-match' ? 'query-ran' : 'unavailable';
  const receipt = { ...existing, event: 'agent-task', stage, counts, pointers };
  const status = displayed.size ? 'ok' : pointers.length ? 'unavailable' : result.status;
  const reason = displayed.size ? null : pointers.length ? 'output-limit' : result.reason;
  return { block, status, reason, receipt, pointers };
}

function responseFor(taskSpec, result, memoryRoot) {
  if (result.receipt) {
    const r = receiptLessonBlock(taskSpec, result, memoryRoot);
    return { status: r.status, reason: r.reason || null, warnings: result.warnings || [],
      message: taskSpec + r.block,
      lessons: r.pointers.map((p) => ({ tag: p.tag, file: p.file, line: p.line,
        endLine: p.endLine, hash: p.fullEntrySha256, trust: p.trust })),
      ...(r.receipt ? { receipt: r.receipt } : {}) };
  }
  const block = buildLessonBlock(taskSpec, result, memoryRoot);
  const legacyBodyOmitted = result.status === 'ok' && block.includes('候选元数据超出展示预算');
  return {
    status: legacyBodyOmitted ? 'unavailable' : result.status,
    reason: legacyBodyOmitted ? 'output-limit' : result.reason || null,
    warnings: result.warnings || [],
    message: taskSpec + block,
    lessons: (legacyBodyOmitted ? [] : result.items).map((item) => ({
      tag: item.tag,
      file: item.file,
      line: item.line,
      endLine: item.endLine,
      hash: item.hash,
      trust: item.trust,
    })),
  };
}

async function prepareAgentTask(input, dependencies) {
  const source = plainObject(input) ? input : {};
  if (typeof source.taskSpec !== 'string') {
    return {
      status: 'unavailable',
      reason: 'invalid-task-spec',
      warnings: [],
      message: '',
      lessons: [],
    };
  }
  if (byteLength(source.taskSpec) > MAX_TASK_BYTES + MAX_BLOCK_BYTES) {
    return {
      status: 'unavailable',
      reason: 'task-too-large',
      warnings: [],
      message: source.taskSpec,
      lessons: [],
    };
  }
  const unwrapped = unwrapTaskSpec(source.taskSpec);
  if (!unwrapped.ok) {
    return {
      status: 'unavailable',
      reason: 'invalid-task-frame',
      warnings: [],
      message: source.taskSpec,
      lessons: [],
    };
  }
  if (byteLength(unwrapped.original) > MAX_TASK_BYTES) {
    return {
      status: 'unavailable',
      reason: 'task-too-large',
      warnings: [],
      message: source.taskSpec,
      lessons: [],
    };
  }
  const selector = dependencies && Object.prototype.hasOwnProperty.call(dependencies, 'selector')
    ? dependencies.selector
    : loadDefaultSelector();
  const result = await callSelector(selector, source.memoryRoot, unwrapped.original);
  return responseFor(unwrapped.original, result, source.memoryRoot);
}

module.exports = {
  MAX_TASK_BYTES,
  MAX_BLOCK_BYTES,
  SELECTOR_LIMIT,
  SELECTOR_MAX_CHARS,
  normaliseSelectorResult,
  isAbsoluteMemoryRoot,
  prepareAgentTask,
  unwrapTaskSpec,
};
