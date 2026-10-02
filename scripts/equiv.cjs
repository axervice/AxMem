#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runner = require('./equiv-runner.cjs');

function loadJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function normalizeText(value, prefixes) {
  let s = String(value === undefined || value === null ? '' : value);
  for (const p of prefixes || []) {
    if (!p) continue;
    const forms = new Set([String(p), String(p).replace(/\\/g, '/'), String(p).replace(/\//g, '\\')]);
    for (const f of forms) s = s.split(f).join('<ROOT>');
  }
  s = s.replace(/\b20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/g, '<TS>');
  return s;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = stable(value[k]);
  return out;
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function hashObject(value) {
  return sha256Text(JSON.stringify(stable(value)));
}

function reportError(code, message, detail) {
  throw new runner.EquivInfrastructureError(code, message, detail);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isByteInteger(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

function isRunnerSandboxRoot(value) {
  if (typeof value !== 'string' || !value) return false;
  if (!path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) return false;
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return /^axmem-equiv-case-[A-Za-z0-9_-]+$/.test(base);
}

function validateReportNormalization(report, side) {
  const normalization = report && report.normalization;
  const prefixes = normalization && normalization.pathPrefixes;
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    reportError('report-normalization-path-prefix-invalid', side + ' report must declare runner sandbox normalization prefixes', { side, field: 'normalization.pathPrefixes', prefix: null });
  }
  for (let i = 0; i < prefixes.length; i++) {
    if (!isRunnerSandboxRoot(prefixes[i])) {
      reportError('report-normalization-path-prefix-invalid', side + ' report normalization prefix is not an absolute runner sandbox root', { side, field: 'normalization.pathPrefixes[' + i + ']', index: i, prefix: prefixes[i], reason: 'not-runner-sandbox-root' });
    }
  }
  const roots = report.cases.map((c) => c && c.sandboxRoot);
  for (let i = 0; i < roots.length; i++) {
    if (!isRunnerSandboxRoot(roots[i])) {
      reportError('report-normalization-path-prefix-invalid', side + ' report case does not record a valid runner sandbox root', { side, field: 'cases[' + i + '].sandboxRoot', index: i, prefix: roots[i], reason: 'invalid-recorded-sandbox-root' });
    }
  }
  if (prefixes.length !== roots.length) {
    reportError('report-normalization-path-prefix-invalid', side + ' report normalization prefix count does not match recorded case sandbox roots', { side, field: 'normalization.pathPrefixes', prefix: prefixes[roots.length] === undefined ? null : prefixes[roots.length], actualCount: prefixes.length, expectedCount: roots.length });
  }
  for (let i = 0; i < roots.length; i++) {
    if (prefixes[i] !== roots[i]) {
      reportError('report-normalization-path-prefix-invalid', side + ' report normalization prefix is not the sandbox root recorded for that case', { side, field: 'normalization.pathPrefixes[' + i + ']', index: i, prefix: prefixes[i], expected: roots[i], reason: 'not-recorded-case-sandbox-root' });
    }
  }
  return prefixes;
}

function normalizeStateTree(tree, prefixes) {
  const out = {};
  for (const key of Object.keys(tree || {}).sort()) {
    const nk = normalizeText(key, prefixes).replace(/\\/g, '/');
    const v = tree[key];
    out[nk] = typeof v === 'string' ? normalizeText(v, prefixes) : stable(v);
  }
  return out;
}

const REQUIRED_EVENTS = ['Bash', 'Edit', 'Write', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreCompact'];

const REPORT_DISPOSITIONS = new Set(['port', 'replace', 'external-prerequisite', 'private-exclude']);
const RAN_DISPOSITIONS = new Set(['port', 'replace']);
const SKIPPED_DISPOSITIONS = new Set(['external-prerequisite', 'private-exclude']);
const INPUT_IDENTITY_FIELDS = new Set(['inputCanonical', 'inputSha256']);

function validateStateTreeEntries(tree, side, caseId) {
  for (const [entryPath, entry] of Object.entries(tree)) {
    const detail = { side, caseId, path: entryPath };
    if (!isPlainObject(entry)) {
      reportError('report-bad-state-entry', side + ' report case ' + caseId + ' has invalid stateTree entry for ' + entryPath,
        Object.assign(detail, { reason: 'entry-must-be-object', valueType: Array.isArray(entry) ? 'array' : typeof entry }));
    }
    const keys = Object.keys(entry).sort();
    if (Object.prototype.hasOwnProperty.call(entry, 'deleted')) {
      if (entry.deleted !== true || keys.length !== 1 || keys[0] !== 'deleted') {
        reportError('report-bad-state-entry', side + ' report case ' + caseId + ' has invalid deleted stateTree entry for ' + entryPath,
          Object.assign(detail, { reason: 'invalid-deleted-entry', keys, deleted: entry.deleted }));
      }
      continue;
    }
    const expectedKeys = ['binary', 'sha256', 'size'];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
        || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)
        || !Number.isInteger(entry.size) || entry.size < 0
        || typeof entry.binary !== 'boolean') {
      reportError('report-bad-state-entry', side + ' report case ' + caseId + ' has invalid file stateTree entry for ' + entryPath,
        Object.assign(detail, {
          reason: 'invalid-file-entry',
          keys,
          sha256Type: typeof entry.sha256,
          sizeType: typeof entry.size,
          binaryType: typeof entry.binary,
        }));
    }
  }
}

function normalizeHookResult(h) {
  return {
    logicalId: h.logicalId.trim(),
    phase: h.phase,
    matcher: h.matcher,
    disposition: String((h && h.disposition) || ''),
    status: String((h && h.status) || ''),
    exitCode: h && h.status === 'ran' ? h.exitCode : null,
    outcome: h && h.status === 'ran' ? String(h.outcome || (h.exitCode === 0 ? 'allow' : 'deny')) : null,
    businessExitCodes: h && h.status === 'ran' && Array.isArray(h.businessExitCodes) ? h.businessExitCodes.map(Number).sort((a, b) => a - b) : [],
    runtimeHealth: h && h.status === 'ran' && h.runtimeHealth && typeof h.runtimeHealth === 'object' ? stable(h.runtimeHealth) : null,
    reason: h && h.status === 'skipped' ? String(h.reason || '').trim() : '',
    externalDependencies: h && Array.isArray(h.externalDependencies) ? h.externalDependencies.map(String).sort() : [],
  };
}

function normalizeCase(c, prefixes) {
  return {
    id: c.id,
    event: c.event,
    inputCanonical: c.inputCanonical,
    inputSha256: c.inputSha256,
    exitCode: c.exitCode,
    stdout: normalizeText(c.stdout, prefixes),
    stderr: normalizeText(c.stderr, prefixes),
    stateTree: normalizeStateTree(c.stateTree, prefixes),
    executedHooks: c.executedHooks,
    hookResults: (c.hookResults || []).map(normalizeHookResult),
  };
}

function parseAllowanceSpec(value) {
  if (value === undefined || value === null) return { differences: [], hookMappings: [] };
  if (Array.isArray(value)) return { differences: value, hookMappings: [] };
  if (!value || typeof value !== 'object') throw new Error('allowance must be an array or an object');
  const differences = value.differences || value.allowedDifferences || [];
  const hookMappings = value.hookMappings || [];
  if (!Array.isArray(differences) || !Array.isArray(hookMappings)) throw new Error('allowance object needs differences[] and hookMappings[] arrays');
  return { differences, hookMappings };
}

function allowedSet(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (!r || typeof r.caseId !== 'string' || typeof r.field !== 'string' || typeof r.reason !== 'string' || !r.reason.trim()) {
      throw new Error('allowed difference requires caseId, field and non-empty reason');
    }
    if (INPUT_IDENTITY_FIELDS.has(r.field)) {
      reportError('allowance-forbidden-field', 'allowed difference cannot target input identity field ' + r.field,
        { caseId: r.caseId, field: r.field, reason: r.reason.trim() });
    }
    const key = r.caseId + '\u0000' + r.field;
    if (m.has(key)) throw new Error('duplicate allowed difference: ' + r.caseId + '/' + r.field);
    m.set(key, r.reason.trim());
  }
  return m;
}

function hookMappingList(rows) {
  const out = [];
  const keys = new Set();
  for (const r of rows || []) {
    if (!r || typeof r.leftId !== 'string' || !r.leftId.trim() || typeof r.rightId !== 'string' || !r.rightId.trim()
        || typeof r.leftDisposition !== 'string' || !r.leftDisposition.trim()
        || typeof r.rightDisposition !== 'string' || !r.rightDisposition.trim()
        || typeof r.reason !== 'string' || !r.reason.trim()) {
      throw new Error('hook mapping requires leftId, rightId, leftDisposition, rightDisposition and non-empty reason');
    }
    const row = {
      leftId: r.leftId.trim(), rightId: r.rightId.trim(),
      leftDisposition: r.leftDisposition.trim(), rightDisposition: r.rightDisposition.trim(),
      reason: r.reason.trim(),
    };
    const key = row.leftId + '\u0000' + row.rightId;
    if (keys.has(key)) throw new Error('duplicate hook mapping: ' + row.leftId + ' -> ' + row.rightId);
    keys.add(key);
    out.push(row);
  }
  return out;
}

function validateRuntimeHealth(health, report, caseId, event, h, side) {
  const label = side + ' report case ' + caseId + '/' + h.logicalId;
  if (!health || typeof health !== 'object' || Array.isArray(health)) throw new Error(label + ' lacks structured runtime health evidence');
  if (health.schema !== 'axmem-runtime-health/v1' || health.status !== 'healthy') throw new Error(label + ' has invalid runtime health schema/status');
  if (health.caseId !== caseId || health.event !== event || health.phase !== h.phase || health.logicalId !== h.logicalId) {
    throw new Error(label + ' runtime health case/phase/logical binding mismatch');
  }
  if (!report.source || health.sourceCommit !== report.source.commit || health.sourceTreeOid !== report.source.treeOid) {
    throw new Error(label + ' runtime health source binding mismatch');
  }
  if (typeof health.inputCanonical !== 'string' || !health.inputCanonical || sha256Text(health.inputCanonical) !== health.inputSha256) {
    throw new Error(label + ' runtime health input binding mismatch');
  }
  if (!Array.isArray(health.sourceFiles) || !health.sourceFiles.length || hashObject(health.sourceFiles) !== health.sourceBindingSha256) {
    throw new Error(label + ' runtime health source-file binding mismatch');
  }
  const reportFiles = new Map(((report.source && report.source.sourceFiles) || []).map((x) => [x.path, x.sha256]));
  for (const f of health.sourceFiles) {
    if (!f || reportFiles.get(f.path) !== f.sha256) throw new Error(label + ' runtime health stale/wrong source file binding');
  }
  if (typeof health.outerCommand !== 'string' || sha256Text(health.outerCommand) !== health.outerCommandSha256
      || typeof health.innerCommand !== 'string' || sha256Text(health.innerCommand) !== health.innerCommandSha256) {
    throw new Error(label + ' runtime health command binding mismatch');
  }
  if (!health.environment || typeof health.environment !== 'object' || hashObject(health.environment) !== health.environmentSha256) {
    throw new Error(label + ' runtime health environment binding mismatch');
  }
  if (health.initialStatesEqual !== true || health.probeContaminatedOuter !== false
      || health.initialOuterStateSha256 !== health.initialProbeStateSha256
      || health.outerStateAfterProbeSha256 !== health.initialOuterStateSha256) {
    throw new Error(label + ' runtime health sandbox independence proof failed');
  }
  if (!Number.isInteger(health.probeExitCode) || health.probeExitCode === 124 || health.probeExitCode === 126 || health.probeExitCode === 127) {
    throw new Error(label + ' runtime health infrastructure failure');
  }
  if (health.probeExitCode !== 0 && !h.businessExitCodes.includes(health.probeExitCode)) {
    throw new Error(label + ' runtime health undeclared inner exit: ' + health.probeExitCode);
  }
  if ((health.probeExitCode === 0 && health.probeOutcome !== 'allow') || (health.probeExitCode !== 0 && health.probeOutcome !== 'deny')) {
    throw new Error(label + ' runtime health outcome mismatch');
  }
}

function validateReport(report, side) {
  if (!report || report.schema !== 'axmem-equiv-report/v1') throw new Error(side + ' report must use schema axmem-equiv-report/v1');
  if (!report.source || !/^[0-9a-f]{40}$/i.test(String(report.source.commit || '')) || !/^[0-9a-f]{40}$/i.test(String(report.source.treeOid || ''))) {
    throw new Error(side + ' report has invalid source identity');
  }
  if (!Array.isArray(report.source.sourceFiles) || !report.source.sourceFiles.length
      || hashObject(report.source.sourceFiles) !== report.source.sourceFilesSha256) {
    throw new Error(side + ' report has invalid sourceFiles binding');
  }
  if (!Array.isArray(report.cases) || report.cases.length === 0) throw new Error(side + ' report must contain at least one case');
  const prefixes = validateReportNormalization(report, side);
  const counts = new Map(REQUIRED_EVENTS.map((e) => [e, 0]));
  const out = new Map();
  for (const raw of report.cases) {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) throw new Error(side + ' report has a case without a non-empty id');
    const id = raw.id.trim();
    if (out.has(id)) throw new Error(side + ' report has duplicate case id: ' + id);
    if (typeof raw.event !== 'string' || !raw.event.trim()) throw new Error(side + ' report case ' + id + ' has no event');
    if (typeof raw.inputCanonical !== 'string' || !raw.inputCanonical || typeof raw.inputSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.inputSha256)) {
      reportError('report-case-input-binding', side + ' report case ' + id + ' has invalid input binding fields', { side, caseId: id, field: typeof raw.inputCanonical !== 'string' || !raw.inputCanonical ? 'inputCanonical' : 'inputSha256' });
    }
    let parsedInput;
    try { parsedInput = JSON.parse(raw.inputCanonical); }
    catch (e) { reportError('report-case-input-binding', side + ' report case ' + id + ' inputCanonical is not valid JSON', { side, caseId: id, field: 'inputCanonical', cause: String(e && e.message || e) }); }
    const canonicalInput = JSON.stringify(stable(parsedInput));
    if (canonicalInput !== raw.inputCanonical || sha256Text(raw.inputCanonical) !== raw.inputSha256.toLowerCase()) {
      reportError('report-case-input-binding', side + ' report case ' + id + ' input binding hash/canonical mismatch', { side, caseId: id, field: canonicalInput !== raw.inputCanonical ? 'inputCanonical' : 'inputSha256' });
    }
    for (const field of ['exitCode', 'executedHooks']) {
      if (!isByteInteger(raw[field])) reportError('report-case-field-type', side + ' report case ' + id + ' has invalid ' + field, { side, caseId: id, field, valueType: Array.isArray(raw[field]) ? 'array' : typeof raw[field] });
    }
    for (const field of ['stdout', 'stderr']) {
      if (typeof raw[field] !== 'string') reportError('report-case-field-type', side + ' report case ' + id + ' has invalid ' + field, { side, caseId: id, field, valueType: Array.isArray(raw[field]) ? 'array' : typeof raw[field] });
    }
    if (!isPlainObject(raw.stateTree)) reportError('report-case-field-type', side + ' report case ' + id + ' has invalid stateTree', { side, caseId: id, field: 'stateTree', valueType: Array.isArray(raw.stateTree) ? 'array' : typeof raw.stateTree });
    validateStateTreeEntries(raw.stateTree, side, id);
    if (counts.has(raw.event)) counts.set(raw.event, counts.get(raw.event) + 1);
    if (!Array.isArray(raw.hookResults) || raw.hookResults.length === 0) throw new Error(side + ' report case ' + id + ' has no hook trace');
    let expectedCaseExit = 0;
    for (let i = 0; i < raw.hookResults.length; i++) {
      const rawHook = raw.hookResults[i];
      if (!rawHook || typeof rawHook !== 'object' || Array.isArray(rawHook)) reportError('report-hook-field-type', side + ' report case ' + id + ' has invalid hook record', { side, caseId: id, hookIndex: i, field: 'hook' });
      if (typeof rawHook.logicalId !== 'string' || !rawHook.logicalId.trim()) {
        reportError('report-bad-hook-record', side + ' report case ' + id + ' hook record requires non-empty string logicalId',
          { side, caseId: id, hookIndex: i, field: 'logicalId', reason: 'logicalId-nonempty-string-required', valueType: Array.isArray(rawHook.logicalId) ? 'array' : typeof rawHook.logicalId });
      }
      if (!Object.prototype.hasOwnProperty.call(rawHook, 'phase') || typeof rawHook.phase !== 'string' || !rawHook.phase.trim()) {
        reportError('report-bad-hook-record', side + ' report case ' + id + ' hook record requires non-empty string phase',
          { side, caseId: id, hookIndex: i, field: 'phase', reason: 'phase-nonempty-string-required', valueType: Array.isArray(rawHook.phase) ? 'array' : typeof rawHook.phase });
      }
      if (!Object.prototype.hasOwnProperty.call(rawHook, 'matcher') || !(rawHook.matcher === null || typeof rawHook.matcher === 'string')) {
        reportError('report-bad-hook-record', side + ' report case ' + id + ' hook record requires matcher to be present and null|string',
          { side, caseId: id, hookIndex: i, field: 'matcher', reason: 'matcher-null-or-string-required', valueType: Array.isArray(rawHook.matcher) ? 'array' : typeof rawHook.matcher });
      }
      if (!REPORT_DISPOSITIONS.has(rawHook.disposition)) {
        reportError('report-bad-disposition', side + ' report case ' + id + ' has invalid hook disposition',
          { side, caseId: id, hookIndex: i, status: rawHook.status, disposition: rawHook.disposition, reason: 'unknown-disposition' });
      }
      if (rawHook.status === 'ran' && !RAN_DISPOSITIONS.has(rawHook.disposition)) {
        reportError('report-bad-disposition', side + ' report case ' + id + ' ran hook has non-runnable disposition',
          { side, caseId: id, hookIndex: i, status: rawHook.status, disposition: rawHook.disposition, reason: 'ran-disposition-mismatch' });
      }
      if (rawHook.status === 'skipped' && !SKIPPED_DISPOSITIONS.has(rawHook.disposition)) {
        reportError('report-bad-disposition', side + ' report case ' + id + ' skipped hook has runnable disposition',
          { side, caseId: id, hookIndex: i, status: rawHook.status, disposition: rawHook.disposition, reason: 'skipped-disposition-mismatch' });
      }
      if (rawHook.status === 'ran') {
        if (!isByteInteger(rawHook.exitCode)) reportError('report-hook-field-type', side + ' report case ' + id + ' has invalid hook exitCode', { side, caseId: id, hookIndex: i, field: 'exitCode', valueType: Array.isArray(rawHook.exitCode) ? 'array' : typeof rawHook.exitCode });
        if (expectedCaseExit === 0 && rawHook.exitCode !== 0) expectedCaseExit = rawHook.exitCode;
      }
    }
    if (raw.exitCode !== expectedCaseExit) reportError('report-case-exit-mismatch', side + ' report case ' + id + ' exitCode does not equal first nonzero hook exit', { side, caseId: id, field: 'exitCode', actual: raw.exitCode, expected: expectedCaseExit });
    const c = normalizeCase(Object.assign({}, raw, { id }), prefixes);
    const hookIds = new Set();
    let ran = 0;
    for (const h of c.hookResults) {
      if (!h.logicalId) throw new Error(side + ' report case ' + id + ' has a hook without logicalId');
      if (hookIds.has(h.logicalId)) throw new Error(side + ' report case ' + id + ' repeats hook logicalId: ' + h.logicalId);
      hookIds.add(h.logicalId);
      if (h.status !== 'ran' && h.status !== 'skipped') throw new Error(side + ' report case ' + id + ' has invalid hook status for ' + h.logicalId);
      if (h.status === 'ran') {
        ran++;
        if (!Number.isFinite(h.exitCode)) throw new Error(side + ' report case ' + id + ' has invalid hook exitCode for ' + h.logicalId);
        const business = h.businessExitCodes;
        if (!Array.isArray(business) || business.some((x, i) => !Number.isInteger(x) || x <= 0 || x > 255 || x === 124 || x === 126 || x === 127 || (i > 0 && business[i - 1] === x))) {
          throw new Error(side + ' report case ' + id + ' has invalid businessExitCodes for ' + h.logicalId);
        }
        validateRuntimeHealth(h.runtimeHealth, report, id, raw.event, h, side);
        if (h.exitCode === 124 || h.exitCode === 126 || h.exitCode === 127 || h.outcome === 'infrastructure-error') {
          throw new Error(side + ' report contains infrastructure failure for ' + id + '/' + h.logicalId);
        }
        if (h.exitCode !== 0 && !business.includes(h.exitCode)) {
          throw new Error(side + ' report contains undeclared nonzero hook exit for ' + id + '/' + h.logicalId + ': ' + h.exitCode);
        }
        if ((h.exitCode === 0 && h.outcome !== 'allow') || (h.exitCode !== 0 && h.outcome !== 'deny')) {
          throw new Error(side + ' report case ' + id + ' has inconsistent outcome for ' + h.logicalId);
        }
      } else {
        if (!h.reason) throw new Error(side + ' report case ' + id + ' has unexplained skipped hook ' + h.logicalId);
        if (h.disposition === 'external-prerequisite' && h.externalDependencies.length === 0) {
          throw new Error(side + ' report case ' + id + ' has external skip without dependency list for ' + h.logicalId);
        }
      }
    }
    if (!Number.isInteger(c.executedHooks) || c.executedHooks < 0 || c.executedHooks !== ran) {
      throw new Error(side + ' report case ' + id + ' executedHooks does not match hook trace');
    }
    if (c.exitCode === 126 || c.exitCode === 127) throw new Error(side + ' report contains infrastructure exit code for case ' + id);
    out.set(id, c);
  }
  const missing = REQUIRED_EVENTS.filter((e) => counts.get(e) < 3);
  if (missing.length) throw new Error(side + ' report requires at least 3 cases for each required event; insufficient: ' + missing.join(', '));
  return out;
}

function compareHookTrace(caseId, leftHooks, rightHooks, mappings, unexpected, appliedMappings) {
  if (leftHooks.length !== rightHooks.length) {
    unexpected.push({ caseId, field: 'hookTrace.length', left: leftHooks.length, right: rightHooks.length });
    return;
  }
  for (let i = 0; i < leftHooks.length; i++) {
    const a = leftHooks[i], b = rightHooks[i];
    const map = mappings.find((m) => m.leftId === a.logicalId && m.rightId === b.logicalId) || null;
    if (a.logicalId !== b.logicalId && !map) {
      unexpected.push({ caseId, field: 'hookTrace[' + i + '].logicalId', left: a.logicalId, right: b.logicalId });
      continue;
    }
    if (a.disposition !== b.disposition) {
      if (!map || map.leftDisposition !== a.disposition || map.rightDisposition !== b.disposition) {
        unexpected.push({ caseId, field: 'hookTrace[' + i + '].disposition', left: a.disposition, right: b.disposition });
      } else {
        appliedMappings.push({ caseId, index: i, leftId: a.logicalId, rightId: b.logicalId, transition: a.disposition + '->' + b.disposition, reason: map.reason });
      }
    } else if (map && (map.leftDisposition !== a.disposition || map.rightDisposition !== b.disposition)) {
      unexpected.push({ caseId, field: 'hookTrace[' + i + '].mapping', left: a.disposition, right: b.disposition });
    }
    for (const field of ['phase', 'matcher', 'status']) {
      if (JSON.stringify(stable(a[field])) !== JSON.stringify(stable(b[field]))) {
        unexpected.push({ caseId, field: 'hookTrace[' + i + '].' + field, left: a[field], right: b[field] });
      }
    }
    if (a.status === 'ran' && b.status === 'ran') {
      for (const field of ['exitCode', 'outcome', 'businessExitCodes']) {
        if (JSON.stringify(stable(a[field])) !== JSON.stringify(stable(b[field]))) {
          unexpected.push({ caseId, field: 'hookTrace[' + i + '].' + field, left: a[field], right: b[field] });
        }
      }
      // runtimeHealth is provenance-heavy evidence, not a cross-source identity.
      // validateReport() has already fail-closed validated each side against its own
      // source/case/input/commands/environment/sandbox state. Across sources we only
      // compare the inner probe behavior that is semantically observable here.
      const ah = { probeExitCode: a.runtimeHealth.probeExitCode, probeOutcome: a.runtimeHealth.probeOutcome };
      const bh = { probeExitCode: b.runtimeHealth.probeExitCode, probeOutcome: b.runtimeHealth.probeOutcome };
      if (JSON.stringify(ah) !== JSON.stringify(bh)) {
        unexpected.push({ caseId, field: 'hookTrace[' + i + '].runtimeHealthBehavior', left: ah, right: bh });
      }
    } else if (a.status === 'skipped' && b.status === 'skipped') {
      for (const field of ['reason', 'externalDependencies']) {
        if (JSON.stringify(stable(a[field])) !== JSON.stringify(stable(b[field]))) {
          unexpected.push({ caseId, field: 'hookTrace[' + i + '].' + field, left: a[field], right: b[field] });
        }
      }
    }
  }
}

function compareReports(left, right, allowedRows) {
  const allowance = parseAllowanceSpec(allowedRows);
  const lm = validateReport(left, 'left');
  const rm = validateReport(right, 'right');
  const allow = allowedSet(allowance.differences);
  const mappings = hookMappingList(allowance.hookMappings);
  const unexpected = [], allowed = [], hookMappingsApplied = [];
  const ids = [...new Set([...lm.keys(), ...rm.keys()])].sort();
  const fields = ['event', 'inputSha256', 'exitCode', 'stdout', 'stderr', 'stateTree'];
  for (const id of ids) {
    if (!lm.has(id) || !rm.has(id)) {
      const d = { caseId: id, field: 'case', left: lm.has(id), right: rm.has(id) };
      const reason = allow.get(id + '\u0000case');
      (reason ? allowed : unexpected).push(Object.assign(d, reason ? { reason } : {}));
      continue;
    }
    const a = lm.get(id), b = rm.get(id);
    for (const field of fields) {
      const av = stable(a[field]), bv = stable(b[field]);
      if (JSON.stringify(av) === JSON.stringify(bv)) continue;
      const d = { caseId: id, field, left: av, right: bv };
      const reason = allow.get(id + '\u0000' + field);
      (reason ? allowed : unexpected).push(Object.assign(d, reason ? { reason } : {}));
    }
    compareHookTrace(id, a.hookResults, b.hookResults, mappings, unexpected, hookMappingsApplied);
  }
  return { equal: unexpected.length === 0, cases: ids.length, unexpected, allowed, hookMappingsApplied };
}

function parseCompareArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--left') o.left = argv[++i];
    else if (argv[i] === '--right') o.right = argv[++i];
    else if (argv[i] === '--allow') o.allow = argv[++i];
    else throw new Error('unknown compare arg: ' + argv[i]);
  }
  if (!o.left || !o.right) throw new Error('usage: equiv.cjs compare --left <report.json> --right <report.json> [--allow <allowed.json>]');
  return o;
}

function parseRunArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--freeze') o.freeze = argv[++i];
    else if (argv[i] === '--fixtures') o.fixtures = argv[++i];
    else if (argv[i] === '--repo') o.repo = argv[++i];
    else if (argv[i] === '--axmem-repo') o.axmemRepo = argv[++i];
    else if (argv[i] === '--source-root') o.sourceRoot = argv[++i];
    else if (argv[i] === '--out') o.out = argv[++i];
    else if (argv[i] === '--timeout-ms') o.timeoutMs = Number(argv[++i]);
    else throw new Error('unknown run arg: ' + argv[i]);
  }
  if (!o.freeze || !o.fixtures || !o.repo || !o.axmemRepo || !o.sourceRoot || !o.out) {
    throw new Error('usage: equiv.cjs run --freeze <FREEZE.json> --fixtures <events.json> --repo <source-git-root> --axmem-repo <AxMem-root> --source-root <live-.claude> --out <report.json> [--timeout-ms <ms>]');
  }
  return o;
}

module.exports = { normalizeText, normalizeStateTree, normalizeCase, compareReports, stable };

if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    const mode = argv[0] === 'run' || argv[0] === 'compare' ? argv.shift() : 'compare';
    if (mode === 'run') {
      const o = parseRunArgs(argv);
      const report = runner.runFreezeReport({
        freeze: path.resolve(o.freeze),
        fixture: path.resolve(o.fixtures),
        repoRoot: path.resolve(o.repo),
        axmemRepoRoot: path.resolve(o.axmemRepo),
        sourceRoot: path.resolve(o.sourceRoot),
        out: path.resolve(o.out),
        defaultTimeoutMs: o.timeoutMs,
      });
      process.stdout.write(JSON.stringify({ ok: true, out: path.resolve(o.out), cases: report.cases.length, commit: report.source.commit }) + '\n');
      process.exit(0);
    }
    const o = parseCompareArgs(argv);
    const left = loadJson(path.resolve(o.left));
    const right = loadJson(path.resolve(o.right));
    const allowed = o.allow ? loadJson(path.resolve(o.allow)) : [];
    const result = compareReports(left, right, allowed);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.equal ? 0 : 1);
  } catch (e) {
    process.stderr.write('[equiv] ' + e.message + '\n');
    process.exit(2);
  }
}
