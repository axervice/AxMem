'use strict';

const DISPOSITIONS = new Set(['port', 'replace', 'external-prerequisite', 'private-exclude']);
const MATCH_FIELDS = Object.freeze({
  PreToolUse: 'tool_name',
  PostToolUse: 'tool_name',
  PostToolUseFailure: 'tool_name',
  PermissionRequest: 'tool_name',
  PermissionDenied: 'tool_name',
  SessionStart: 'source',
  SessionEnd: 'reason',
  PreCompact: 'trigger',
  PostCompact: 'trigger',
  Notification: 'notification_type',
  SubagentStart: 'agent_type',
  SubagentStop: 'agent_type',
});
const NO_MATCHER_EVENTS = new Set([
  'UserPromptSubmit', 'Stop', 'TeammateIdle', 'TaskCompleted',
  'ConfigChange', 'WorktreeCreate', 'WorktreeRemove',
]);
const SIMPLE_MATCHER_RE = /^[A-Za-z0-9_\- ,|]+$/;

function fail(opts, code, message, detail) {
  if (opts && typeof opts.fail === 'function') return opts.fail(code, message, detail || null);
  const e = new Error(message);
  e.code = code;
  e.detail = detail || null;
  throw e;
}

function compileMatcher(event, matcher, opts = {}) {
  if (matcher !== undefined && matcher !== null && typeof matcher !== 'string') {
    fail(opts, 'hook-matcher-type', 'matcher must be a string, null, or omitted for ' + event,
      { event, matcherType: Array.isArray(matcher) ? 'array' : typeof matcher });
  }
  const field = MATCH_FIELDS[event] || null;
  const empty = matcher === undefined || matcher === null || matcher === '' || matcher.trim() === '';
  if (!field) {
    if (empty || matcher === '*') return { kind: 'all', field: null };
    if (NO_MATCHER_EVENTS.has(event)) {
      if (opts.unsupportedMatcher === 'reject') {
        fail(opts, 'hook-matcher-not-supported', 'event does not support matcher: ' + event, { event, matcher });
      }
      return { kind: 'all', field: null };
    }
    fail(opts, 'hook-matcher-event-unsupported',
      'non-empty matcher on event with unsupported matcher semantics: ' + event,
      { event, matcher });
  }
  if (empty || matcher === '*') return { kind: 'all', field };
  if (SIMPLE_MATCHER_RE.test(matcher)) {
    const rawValues = matcher.split(/[|,]/);
    const emptyAlternative = rawValues.findIndex((x) => x.trim() === '');
    if (emptyAlternative !== -1) {
      fail(opts, 'hook-matcher-empty-alternative',
        'simple matcher list contains an empty alternative for ' + event,
        { event, matcher, alternativeIndex: emptyAlternative });
    }
    return { kind: 'exact', field, values: rawValues.map((x) => x.trim()) };
  }
  let regex;
  try { regex = new RegExp(matcher); }
  catch (e) {
    fail(opts, 'hook-matcher-regex', 'invalid matcher regular expression for ' + event,
      { event, matcher, regexError: String(e && e.message || e) });
  }
  return { kind: 'regex', field, regex };
}

function matcherMatches(event, matcher, payload, opts = {}) {
  const compiled = compileMatcher(event, matcher, opts);
  if (compiled.kind === 'all') return true;
  const value = payload && compiled.field ? payload[compiled.field] : undefined;
  if (value === undefined || value === null) return false;
  const text = String(value);
  if (compiled.kind === 'exact') return compiled.values.includes(text);
  compiled.regex.lastIndex = 0;
  return compiled.regex.test(text);
}

function flattenHooks(settings, opts = {}) {
  const hooks = settings && settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    fail(opts, 'bad-settings', 'settings.json hooks must be an object');
  }
  const rows = [];
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) fail(opts, 'bad-settings', 'hooks.' + event + ' must be an array');
    groups.forEach((group, groupIndex) => {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        fail(opts, 'bad-settings', 'hooks.' + event + '[' + groupIndex + '].hooks must be an array');
      }
      const matcher = Object.prototype.hasOwnProperty.call(group, 'matcher') ? group.matcher : null;
      compileMatcher(event, matcher, opts);
      group.hooks.forEach((hook, hookIndex) => {
        if (!hook || typeof hook !== 'object' || typeof hook.command !== 'string' || !hook.command) {
          fail(opts, 'bad-settings', 'hook command must be a non-empty string at ' + event + '/' + groupIndex + '/' + hookIndex);
        }
        rows.push({
          event, groupIndex, hookIndex, matcher,
          command: hook.command,
          timeout: Object.prototype.hasOwnProperty.call(hook, 'timeout') ? hook.timeout : null,
        });
      });
    });
  }
  return rows;
}

function hookIdentity(h) {
  return JSON.stringify([
    h.event,
    h.groupIndex,
    h.hookIndex,
    h.matcher === undefined ? null : h.matcher,
    h.command,
    h.timeout === undefined ? null : h.timeout,
  ]);
}

module.exports = {
  DISPOSITIONS,
  MATCH_FIELDS,
  NO_MATCHER_EVENTS,
  compileMatcher,
  matcherMatches,
  flattenHooks,
  hookIdentity,
};
