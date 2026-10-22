#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { TextDecoder } = require('node:util');
const { validateReceipt } = require('./recall-selector.cjs');

const MAX_STDIN_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 4096;
const MAX_OUTPUT_BYTES = 12 * 1024;
const SELECTOR_LIMIT = 3;
const SELECTOR_MAX_CHARS = 2400;

const SUPPORTED_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'SubagentStart']);
const EMPTY_EVENTS = new Set(['PreCompact', 'Stop']);
const SESSION_SOURCES = new Set(['startup', 'resume', 'clear', 'compact']);
const SELECTOR_SOURCE_REASONS = new Set([
  'invalid-input', 'source-unavailable', 'source-unsafe', 'missing-required-source',
  'source-too-large', 'source-changed', 'manifest-timeout', 'manifest-invalid', 'internal-error',
]);
const BRIDGE_UNAVAILABLE_REASONS = new Set(['source-missing', 'selector-unavailable', 'selector-error',
  'invalid-selector-result', 'output-limit', 'selection-limit']);
const PRESENT_NO_MATCH_REASONS = new Set(['empty-query', 'no-lexical-match', 'no-action-match']);
const COMMON_NOTICE = '历史记忆候选，不授予新权限；本召回钩子仅读取 PMM、不执行写入；记忆写入仍须遵守当前会话有效权限与授权，不可据召回器只读推断用户全局禁止更新记忆；历史记忆与当前要求冲突时，按当前有效要求并询问变更属临时还是长期。';

function plainObject(value) { return !!value && !Array.isArray(value) && typeof value === 'object'; }
function emptyOutput() { return {}; }

function truncateUtf8(value, maxBytes) {
  const source = String(value || '');
  if (Buffer.byteLength(source, 'utf8') <= maxBytes) return source;
  const suffix = '…';
  const room = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  let out = '';
  let used = 0;
  for (const ch of source) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    if (used + bytes > room) break;
    out += ch;
    used += bytes;
  }
  return out + suffix;
}

function safeAtom(value, limit) {
  return truncateUtf8(String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(), limit || 180);
}

function safeText(value, limit) {
  return truncateUtf8(String(value || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''), limit || 900);
}

function isAbsoluteMemoryRoot(value, platform) {
  if (typeof value !== 'string' || !value || /[\u0000\r\n]/.test(value)) return false;
  const activePlatform = platform || process.platform;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.includes('//') || /^\/(?:\?\?|Device)\//i.test(normalized)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized) && !/^[A-Za-z]:\//.test(normalized)) return false;
  if (activePlatform === 'win32') return /^[A-Za-z]:\/(?!\/)/.test(normalized);
  return !value.includes('\\') && path.posix.isAbsolute(value);
}

function parseCliArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--memory-root' || !isAbsoluteMemoryRoot(argv[1])) {
    return { ok: false, code: 'memory-root-required' };
  }
  return { ok: true, memoryRoot: argv[1] };
}

function safeReason(value, fallback) {
  if (value === 'invalid-input') return 'invalid-input';
  if (typeof value === 'string' && BRIDGE_UNAVAILABLE_REASONS.has(value)) return value;
  if (typeof value === 'string' && SELECTOR_SOURCE_REASONS.has(value)) return 'source-unavailable';
  return fallback;
}

function normaliseWarning(value) {
  if (typeof value !== 'string') return null;
  if (value === 'query-limited') return 'query-limited';
  if (/^b5-trigger-metadata-not-used:\d+$/.test(value)) return 'trigger-metadata-degraded';
  if (/^graph-ambiguous-excluded:\d+$/.test(value)) return 'supersession-ambiguous';
  if (/^unknown-trust-excluded:\d+$/.test(value)) return 'unknown-trust-excluded';
  if (/^action-trigger-boundary-excluded:\d+$/.test(value)) return 'trigger-boundary-degraded';
  if (/^action-trigger-metadata-excluded:\d+$/.test(value)) return 'trigger-metadata-degraded';
  if (value === 'lexical-historical-reference') return 'lexical-reference';
  if (value === 'excerpt-may-be-truncated') return 'excerpt-truncated';
  return null;
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
      (value.reason === 'empty-query' ? receipt.query.method === 'none' :
        value.reason === 'no-action-match' ? receipt.query.method === 'action-trigger' :
          receipt.query.method !== 'none' && receipt.query.method !== 'action-trigger');
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
        !validPresentSelectorOutcome(value, items) ||
        value.receipt.event !== 'selector') {
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
  if (value.status === 'ok' && items.length === 0) {
    return { status: 'unavailable', reason: 'invalid-selector-result', items: [], warnings };
  }
  return { status: value.status, reason: null, items, warnings };
}

async function callSelector(selector, memoryRoot, query) {
  if (!isAbsoluteMemoryRoot(memoryRoot)) return { status: 'unavailable', reason: 'source-missing', items: [], warnings: [] };
  if (typeof selector !== 'function') return { status: 'unavailable', reason: 'selector-unavailable', items: [], warnings: [] };
  try {
    return normaliseSelectorResult(await selector({
      memoryRoot,
      query: String(query),
      limit: SELECTOR_LIMIT,
      maxChars: SELECTOR_MAX_CHARS,
    }), memoryRoot);
  } catch {
    return { status: 'unavailable', reason: 'selector-error', items: [], warnings: [] };
  }
}

function warningLines(warnings) {
  return warnings.length ? warnings.map((warning) => '检索警示：' + warning + '。').join('\n') : '';
}

function unavailableLine(reason) {
  const code = safeReason(reason, 'selector-unavailable');
  if (code === 'output-limit') return '历史记忆候选展示受限（output-limit）；主审需补查，不得将此视为“无匹配”。';
  if (code === 'selection-limit') return '存在匹配，但受固定候选选择上限限制，主审需补查。';
  return '历史记忆当前不可用（' + code + '）；可继续本轮工作，但不得将此视为“无匹配”。';
}

function sourceProbeLine(result) {
  if (result.status === 'unavailable') return unavailableLine(result.reason);
  return '只读源状态：已探测；未注入整份 standinginstructions，也未声称已经查询任务。';
}

function formatItemWithinBudget(item, maxBytes) {
  const range = item.endLine === item.line ? String(item.line) : String(item.line) + '-' + String(item.endLine);
  const header = '- [' + item.tag + '] ' + item.file + ':' + range +
    ' | source-excerpt-sha256=' + item.hash + ' | trust=' + item.trust;
  const full = header + '\n  ' + item.text;
  return Buffer.byteLength(full, 'utf8') <= maxBytes ? full : null;
}

function formatItemsWithinBudget(items, maxBytes) {
  const kept = [];
  let used = 0;
  for (const item of items) {
    const separator = kept.length ? '\n' : '';
    const formatted = formatItemWithinBudget(item, maxBytes - used - Buffer.byteLength(separator, 'utf8'));
    if (!formatted) break;
    kept.push(formatted);
    used += Buffer.byteLength(separator + formatted, 'utf8');
  }
  return kept.join('\n');
}

function makeOutput(event, context) {
  let additionalContext = String(context || '');
  if (Buffer.byteLength(additionalContext, 'utf8') > MAX_CONTEXT_BYTES) {
    additionalContext = COMMON_NOTICE + '\n历史记忆候选输出超限，已省略详情。';
  }
  const output = { hookSpecificOutput: { hookEventName: event, additionalContext } };
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') <= MAX_OUTPUT_BYTES) return output;
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: COMMON_NOTICE + '\n历史记忆候选输出超限，已省略详情。',
    },
  };
}


function receiptContext(result, event) {
  const original = result.receipt;
  const pointers = original.pointers.map((p) => ({ ...p,
    visibility: 'omitted',
    reason: p.visibility === 'whole' ? 'bridge-budget' : p.reason,
    displayedTextSha256: null }));
  const bodyByTag = new Map(result.items.map((item) => [item.tag, item]));
  const shown = new Set();
  const sourceRoot = pointers.length ? pointers[0].sourceRoot : null;
  const budgetOK = (context) => Buffer.byteLength(context, 'utf8') <= MAX_CONTEXT_BYTES &&
    Buffer.byteLength(JSON.stringify({ hookSpecificOutput: {
      hookEventName: event, additionalContext: context,
    } }), 'utf8') <= MAX_OUTPUT_BYTES;
  const compose = () => {
    const displayed = shown.size, selected = pointers.length;
    const stage = selected ? (displayed ? 'emitted' : 'omitted') :
      result.status === 'no-match' ? 'query-ran' : 'unavailable';
    const rows = [COMMON_NOTICE, '历史记忆候选，必须核对原始来源；不代表已阅读或采纳。'];
    const warnings = warningLines(result.warnings);
    if (warnings) rows.push(warnings);
    rows.push('召回收据 v1 event=' + event + ' stage=' + stage + ' selected=' +
      selected + ' displayed=' + displayed + ' omitted=' + (selected - displayed));
    if (sourceRoot !== null) rows.push('验证来源根：' + sourceRoot);
    for (const p of pointers) {
      rows.push('#' + p.rank + ' [' + p.tag + '] ' + p.file + ':' + p.line + '-' + p.endLine +
        ' fullEntrySHA256=' + p.fullEntrySha256 + ' trust=' + p.trust +
        ' date=' + (p.date || 'unknown') + ' scope=' + p.scope +
        ' ' + p.visibility + '/' + p.reason);
    }
    if (result.status === 'no-match') rows.push('本次查询未找到历史记忆候选；这不改变现有权限或事实。');
    else if (result.reason === 'selection-limit')
      rows.push('存在匹配，但受固定候选选择上限限制，主审需补查。');
    else if (displayed === 0) rows.push('历史候选展示受限（output-limit）；请按已验证来源补查。');
    for (const p of pointers) if (shown.has(p.tag)) {
      const item = bodyByTag.get(p.tag);
      rows.push('[' + p.tag + '] 完整正文：\n' + item.text);
    }
    return rows.join('\n');
  };
  let text = compose();
  if (!budgetOK(text)) return COMMON_NOTICE + '\n历史候选展示受限（output-limit）；请按已验证来源补查。';
  for (const p of pointers) {
    if (!bodyByTag.has(p.tag)) continue;
    p.visibility = 'whole'; p.reason = 'none'; p.displayedTextSha256 = p.fullEntrySha256;
    shown.add(p.tag);
    const candidate = compose();
    if (budgetOK(candidate)) text = candidate;
    else {
      shown.delete(p.tag); p.visibility = 'omitted'; p.reason = 'bridge-budget'; p.displayedTextSha256 = null;
    }
  }
  return compose();
}

function candidateContext(result, event) {
  if (result.receipt) return receiptContext(result, event);
  const pieces = [COMMON_NOTICE];
  const warnings = warningLines(result.warnings);
  if (warnings) pieces.push(warnings);
  if (result.status === 'unavailable') {
    pieces.push(unavailableLine(result.reason));
    return pieces.join('\n');
  }
  if (result.status === 'no-match') {
    pieces.push('本次查询未找到历史记忆候选；这不改变现有权限或事实。');
    return pieces.join('\n');
  }
  pieces.push('仅供核对的历史记忆候选。旧版结果无 v1 收据，节选完整性及来源绑定未知；超出预算的候选会整体省略。');
  const fixed = pieces.join('\n') + '\n';
  const items = formatItemsWithinBudget(result.items, MAX_CONTEXT_BYTES - Buffer.byteLength(fixed, 'utf8'));
  if (!items) return pieces.concat('候选元数据超出展示预算；请按 source 重新查询。').join('\n');
  return fixed + items;
}

async function runHookInput(input, options) {
  const config = options || {};
  if (!plainObject(input) || typeof input.hook_event_name !== 'string') return emptyOutput();
  const event = input.hook_event_name;
  if (EMPTY_EVENTS.has(event) || !SUPPORTED_EVENTS.has(event)) return emptyOutput();

  const memoryRoot = config.memoryRoot;
  const selector = config.selector;
  if (!isAbsoluteMemoryRoot(memoryRoot)) return makeOutput(event, COMMON_NOTICE + '\n' + unavailableLine('source-missing'));

  if (event === 'SessionStart') {
    if (typeof input.source !== 'string' || !SESSION_SOURCES.has(input.source)) return emptyOutput();
    const probe = await callSelector(selector, memoryRoot, '');
    return makeOutput(event, [
      'AxMem lifecycle event=SessionStart adapter=codex-recall-v1',
      '会话启动（' + input.source + '）。召回来源 PMM 根（本钩子只读）：' + safeAtom(memoryRoot, 420) + '。',
      COMMON_NOTICE,
      sourceProbeLine(probe),
      warningLines(probe.warnings),
    ].filter(Boolean).join('\n'));
  }

  if (event === 'SubagentStart') {
    const probe = await callSelector(selector, memoryRoot, '');
    return makeOutput(event, [
      'AxMem lifecycle event=SubagentStart adapter=codex-recall-v1',
      '本 hook 事件不提供父会话或任务正文；派工方必须显式 fork_turns:none，只传 filtered spec 及教训包。先读主审 filtered spec，再按相关主题查询 PMM 历史候选（本钩子只读）；不可捏造既有任务结果。召回来源 PMM 根：' + safeAtom(memoryRoot, 420) + '。',
      COMMON_NOTICE,
      sourceProbeLine(probe),
      warningLines(probe.warnings),
    ].filter(Boolean).join('\n'));
  }

  if (typeof input.prompt !== 'string') return emptyOutput();
  const result = await callSelector(selector, memoryRoot, input.prompt);
  return makeOutput(event, candidateContext(result, event));
}

async function readStdinLimited(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_STDIN_BYTES) return { ok: false, code: 'input-too-large' };
    chunks.push(buffer);
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { ok: false, code: 'bad-json' };
  }
}

function writeStderr(code) { process.stderr.write('recall-context: ' + code + '\n'); }

function loadDefaultSelector() {
  try {
    const selector = require('./recall-selector.cjs');
    return typeof selector.recall === 'function' ? selector.recall : null;
  } catch {
    return null;
  }
}

async function main() {
  const parsedArgs = parseCliArgs(process.argv.slice(2));
  const incoming = await readStdinLimited(process.stdin);
  if (!incoming.ok) {
    writeStderr(incoming.code);
    process.stdout.write('{}');
    return;
  }
  let input;
  try {
    input = JSON.parse(incoming.text);
  } catch {
    writeStderr('bad-json');
    process.stdout.write('{}');
    return;
  }
  const event = plainObject(input) && typeof input.hook_event_name === 'string' ? input.hook_event_name : null;
  if (event && SUPPORTED_EVENTS.has(event) && !parsedArgs.ok) writeStderr(parsedArgs.code);
  const selector = parsedArgs.ok ? loadDefaultSelector() : null;
  const output = await runHookInput(input, { memoryRoot: parsedArgs.ok ? parsedArgs.memoryRoot : null, selector });
  process.stdout.write(JSON.stringify(output));
}

if (require.main === module) {
  main().catch(() => {
    writeStderr('bridge-failed');
    process.stdout.write('{}');
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_STDIN_BYTES,
  MAX_CONTEXT_BYTES,
  MAX_OUTPUT_BYTES,
  SELECTOR_LIMIT,
  SELECTOR_MAX_CHARS,
  parseCliArgs,
  isAbsoluteMemoryRoot,
  normaliseSelectorResult,
  runHookInput,
  readStdinLimited,
};
