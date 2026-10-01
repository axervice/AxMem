#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const RUN_DISPOSITIONS = new Set(['port', 'replace']);
const TOOL_EVENTS = new Set(['Bash', 'Edit', 'Write']);

function posix(p) { return String(p).replace(/\\/g, '/'); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function safeRel(p) {
  const n = posix(String(p || '').trim()).replace(/^\.\//, '');
  if (!n || path.posix.isAbsolute(n) || n === '..' || n.startsWith('../') || n.includes('/../')) {
    throw new Error('unsafe relative path: ' + p);
  }
  return n;
}
function loadJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function normalizeRuntimeText(value, prefixes) {
  let s = String(value === undefined || value === null ? '' : value).replace(/\r\n/g, '\n');
  for (const p of prefixes || []) {
    if (!p) continue;
    const forms = new Set([String(p), posix(p), String(p).replace(/\//g, '\\')]);
    for (const f of forms) if (f) s = s.split(f).join('<ROOT>');
  }
  s = s.replace(/\b20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/g, '<TS>');
  s = s.replace(/\b20\d\d-\d\d-\d\d[ T]\d\d:\d\d:\d\d\b/g, '<TS>');
  return s;
}

function gitBlob(repoRoot, spec) {
  return cp.execFileSync('git', ['-C', repoRoot, 'show', spec], {
    encoding: null, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
}

function materializeFreeze(freeze, repoRoot, sandboxHome) {
  if (!freeze || freeze.schema !== 'axmem-p2-freeze/v1') throw new Error('freeze schema must be axmem-p2-freeze/v1');
  if (!freeze.source || !/^[0-9a-f]{40}$/i.test(String(freeze.source.commit || ''))) throw new Error('freeze source commit missing/invalid');
  if (!Array.isArray(freeze.sourceFiles)) throw new Error('freeze sourceFiles must be an array');
  const liveRel = safeRel(freeze.source.liveRelativePath);
  const sourceDir = path.join(sandboxHome, ...liveRel.split('/'));
  for (const f of freeze.sourceFiles) {
    const rel = safeRel(f.path);
    const repoRel = path.posix.join(liveRel, rel);
    const blob = gitBlob(repoRoot, freeze.source.commit + ':' + repoRel);
    if (f.sha256 && sha256(blob) !== f.sha256) throw new Error('freeze blob hash mismatch: ' + rel);
    const dst = path.join(sourceDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, blob);
  }
  return sourceDir;
}

function rewriteSourceRoot(command, sourceRoot, sandboxSource) {
  let out = String(command || '');
  const src = new Set([String(sourceRoot), posix(sourceRoot), String(sourceRoot).replace(/\//g, '\\')]);
  const dstBy = (x) => x.indexOf('\\') >= 0 ? String(sandboxSource).replace(/\//g, '\\') : posix(sandboxSource);
  for (const f of src) if (f) out = out.split(f).join(dstBy(f));
  return out;
}

function matcherMatches(matcher, toolName) {
  if (matcher === null || matcher === undefined || matcher === '') return true;
  if (!toolName) return false;
  try { return new RegExp('^(?:' + matcher + ')$').test(toolName); }
  catch { return String(matcher).split('|').includes(String(toolName)); }
}

function hookEventsForGroup(group) {
  if (Array.isArray(group.hookEvents) && group.hookEvents.length) return group.hookEvents.slice();
  return TOOL_EVENTS.has(group.event) ? ['PreToolUse', 'PostToolUse'] : [group.event];
}

function casePayload(group, c, hookEvent, sandboxHome) {
  const input = JSON.parse(JSON.stringify(c.input || {}));
  input.hook_event_name = hookEvent;
  if (!input.cwd) input.cwd = posix(sandboxHome);
  if (TOOL_EVENTS.has(group.event) && !input.tool_name) input.tool_name = group.event;
  if (hookEvent === 'PostToolUse' && !Object.prototype.hasOwnProperty.call(input, 'tool_response')) input.tool_response = {};
  return input;
}

function findBash() {
  if (process.env.AXMEM_EQUIV_BASH) return process.env.AXMEM_EQUIV_BASH;
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const c = path.join(pf, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(c)) return c;
  }
  return 'bash';
}

function isolatedEnv(sandboxHome) {
  const home = posix(sandboxHome);
  const tmp = path.join(sandboxHome, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(?:PMM_|AXMEM_)/i.test(k)) continue;
    if (/^(?:CLAUDE_CONFIG_DIR|CLAUDE_HOME|XDG_CONFIG_HOME|XDG_STATE_HOME|XDG_CACHE_HOME)$/i.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    PMM_HOME: home,
    PMM_SELFTEST_ACTIVE: '1',
    PMM_SELFTEST_ROOT: home,
    AXMEM_HOME: posix(path.join(sandboxHome, '.axmem')),
    AXMEM_MEMORY_DIR: posix(path.join(sandboxHome, 'memory')),
    AXMEM_STATE_DIR: posix(path.join(sandboxHome, '.axmem-state')),
    CLAUDE_CONFIG_DIR: posix(path.join(sandboxHome, '.claude')),
    XDG_CONFIG_HOME: posix(path.join(sandboxHome, '.config')),
    XDG_STATE_HOME: posix(path.join(sandboxHome, '.local', 'state')),
    XDG_CACHE_HOME: posix(path.join(sandboxHome, '.cache')),
    TMPDIR: posix(tmp),
    TEMP: posix(tmp),
    TMP: posix(tmp),
    AXMEM_EQUIV_ACTIVE: '1',
  });
  if (process.platform === 'win32') {
    const toMsys = (p) => {
      const s = String(p || '').replace(/\\/g, '/');
      const m = s.match(/^([A-Za-z]):\/(.*)$/);
      return m ? '/' + m[1].toLowerCase() + '/' + m[2] : s;
    };
    const entries = [toMsys(path.dirname(process.execPath)), '/usr/bin', '/bin'];
    for (const e of String(process.env.PATH || '').split(';')) if (e.trim()) entries.push(toMsys(e.trim()));
    env.PATH = [...new Set(entries)].join(':');
  }
  return env;
}

function walkFiles(root) {
  const out = new Map();
  function rec(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) rec(abs);
      else if (ent.isFile()) out.set(posix(path.relative(root, abs)), fs.readFileSync(abs));
      else if (ent.isSymbolicLink()) out.set(posix(path.relative(root, abs)), Buffer.from('SYMLINK:' + fs.readlinkSync(abs), 'utf8'));
    }
  }
  rec(root);
  return out;
}

function normalizedFileDigest(buf, prefixes) {
  const binary = buf.includes(0);
  const norm = binary ? buf : Buffer.from(normalizeRuntimeText(buf.toString('utf8'), prefixes), 'utf8');
  return { sha256: sha256(norm), size: norm.length, binary };
}

function diffState(before, after, prefixes) {
  const out = {};
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const k of keys) {
    const a = before.get(k), b = after.get(k);
    if (a && b && a.equals(b)) continue;
    if (!b) out[k] = { deleted: true };
    else out[k] = normalizedFileDigest(b, prefixes);
  }
  return out;
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = stableObject(value[k]);
  return out;
}

function hashObject(value) {
  return sha256(Buffer.from(JSON.stringify(stableObject(value)), 'utf8'));
}

function stateDigest(root) {
  const files = walkFiles(root);
  const h = crypto.createHash('sha256');
  for (const k of [...files.keys()].sort()) {
    h.update(k); h.update('\0'); h.update(files.get(k)); h.update('\0');
  }
  return h.digest('hex');
}

function copySandbox(src) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-equiv-probe-'));
  fs.cpSync(src, dst, { recursive: true, force: true });
  return dst;
}

function bindingEnv(env, prefixes) {
  const out = {};
  for (const k of Object.keys(env).sort()) {
    if (/^(?:HOME|USERPROFILE|PATH|TMPDIR|TEMP|TMP|PMM_|AXMEM_|CLAUDE_CONFIG_DIR|XDG_)/i.test(k)) {
      out[k] = normalizeRuntimeText(env[k], prefixes);
    }
  }
  return out;
}

function sourceBindingForHook(freeze, h) {
  const by = new Map((freeze.sourceFiles || []).map((f) => [f.path, f]));
  const seen = new Set();
  const queue = (h.files || []).slice();
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const f = by.get(rel);
    if (!f || !/^[0-9a-f]{64}$/i.test(String(f.sha256 || ''))) {
      throw new EquivInfrastructureError('hook source hash binding missing for ' + rel);
    }
    for (const dep of Array.isArray(f.dependencies) ? f.dependencies : []) queue.push(dep);
  }
  const rows = [...seen].sort().map((rel) => {
    const f = by.get(rel);
    return { path: rel, sha256: String(f.sha256).toLowerCase() };
  });
  return { files: rows, sha256: hashObject(rows) };
}

function payloadBinding(payload, prefixes) {
  return sha256(Buffer.from(normalizeRuntimeText(JSON.stringify(stableObject(payload)), prefixes), 'utf8'));
}

class EquivInfrastructureError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'EquivInfrastructureError';
    this.code = 'equiv-infrastructure';
    this.detail = detail || null;
  }
}

function logicalHookId(h, phase) {
  if (typeof h.logicalId === 'string' && h.logicalId.trim()) return h.logicalId.trim();
  const matcher = h.matcher === null || h.matcher === undefined || h.matcher === '' ? '*' : String(h.matcher);
  return String(phase) + '|' + String(h.groupIndex) + '|' + String(h.hookIndex) + '|' + matcher;
}

function hookExitContract(h, logicalId) {
  if (!Array.isArray(h.businessExitCodes)) {
    throw new EquivInfrastructureError('hook runtime contract missing for ' + logicalId + ': businessExitCodes[] is required');
  }
  const codes = [];
  const seen = new Set();
  for (const raw of h.businessExitCodes) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n > 255 || n === 124 || n === 126 || n === 127 || seen.has(n)) {
      throw new EquivInfrastructureError('hook runtime contract invalid for ' + logicalId + ': businessExitCodes=' + JSON.stringify(h.businessExitCodes));
    }
    seen.add(n);
    codes.push(n);
  }
  codes.sort((a, b) => a - b);
  const p = h.runtimeHealthProbe;
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.version !== 1
      || typeof p.innerCommand !== 'string' || !p.innerCommand.trim()
      || typeof p.reliable !== 'boolean' || typeof p.notes !== 'string' || !p.notes.trim()) {
    throw new EquivInfrastructureError('hook runtime contract missing structured runtimeHealthProbe for ' + logicalId);
  }
  if (!p.reliable) {
    throw new EquivInfrastructureError('hook runtime health is explicitly unprovable for ' + logicalId + ': ' + p.notes.trim());
  }
  return { businessExitCodes: codes, runtimeHealthProbe: {
    version: 1, innerCommand: p.innerCommand, reliable: true, notes: p.notes.trim(),
  } };
}

function preflightHookSources(h, sandboxSource, env, logicalId, timeoutMs) {
  if (!Array.isArray(h.files) || h.files.length === 0) {
    throw new EquivInfrastructureError('hook source contract missing for ' + logicalId + ': runnable hook needs files[]');
  }
  const checked = [];
  for (const raw of h.files) {
    const rel = safeRel(raw);
    const abs = path.join(sandboxSource, ...rel.split('/'));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new EquivInfrastructureError('hook source missing for ' + logicalId + ': ' + rel);
    }
    const ext = path.extname(rel).toLowerCase();
    let rr = null;
    if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
      rr = cp.spawnSync(process.execPath, ['--check', abs], {
        cwd: sandboxSource, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
      });
    } else if (ext === '.sh') {
      rr = cp.spawnSync(findBash(), ['--noprofile', '--norc', '-n', abs], {
        cwd: sandboxSource, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
      });
    }
    if (rr) {
      const timedOut = Boolean(rr.error && rr.error.code === 'ETIMEDOUT');
      if (timedOut || rr.error || rr.signal || rr.status !== 0) {
        const why = timedOut ? 'timeout' : rr.error ? ('spawn-error:' + String(rr.error.code || rr.error.message || 'unknown'))
          : rr.signal ? ('signal:' + rr.signal) : ('syntax-exit:' + rr.status);
        throw new EquivInfrastructureError('hook source health preflight failed for ' + logicalId + '/' + rel + ': ' + why);
      }
      checked.push(rel);
    }
  }
  return checked;
}

function runHook(command, payload, env, cwd, timeoutMs, businessExitCodes = []) {
  const bash = findBash();
  const r = cp.spawnSync(bash, ['--noprofile', '--norc', '-c', command], {
    cwd, env, input: JSON.stringify(payload) + '\n', encoding: 'utf8',
    timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
  });
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  const spawnError = Boolean(r.error && !timedOut);
  const signal = r.signal || null;
  let exitCode = r.status;
  if (timedOut) exitCode = 124;
  else if (exitCode === null) exitCode = 1;
  const allowedBusiness = new Set((businessExitCodes || []).map(Number));
  let infrastructureReason = null;
  if (timedOut) infrastructureReason = 'timeout';
  else if (spawnError) infrastructureReason = 'spawn-error:' + String(r.error.code || r.error.message || 'unknown');
  else if (signal) infrastructureReason = 'signal:' + signal;
  else if (exitCode === 126 || exitCode === 127) infrastructureReason = 'command-start:' + exitCode;
  else if (exitCode !== 0 && !allowedBusiness.has(exitCode)) infrastructureReason = 'unexpected-exit:' + exitCode;
  return {
    exitCode,
    stdout: r.stdout || '',
    stderr: (r.stderr || '') + (spawnError ? String(r.error.message || r.error) : ''),
    timedOut,
    signal,
    infrastructureFailure: infrastructureReason !== null,
    infrastructureReason,
    outcome: infrastructureReason ? 'infrastructure-error' : (exitCode === 0 ? 'allow' : 'deny'),
  };
}

function runRuntimeHealthProbe({ freeze, h, logicalId, phase, c, group, sourceRoot,
  outerHome, outerSource, outerEnv, outerPayload, timeoutMs, contract }) {
  const initialOuter = stateDigest(outerHome);
  const probeHome = copySandbox(outerHome);
  try {
    const initialProbe = stateDigest(probeHome);
    if (initialOuter !== initialProbe) throw new EquivInfrastructureError('runtime health sandbox clone mismatch for ' + logicalId);
    const liveRel = safeRel(freeze.source.liveRelativePath);
    const probeSource = path.join(probeHome, ...liveRel.split('/'));
    const probeEnv = isolatedEnv(probeHome);
    const probePayload = casePayload(group, c, phase, probeHome);
    const sourceBinding = sourceBindingForHook(freeze, h);
    const outerCommand = String(h.command || '');
    const innerCommand = String(contract.runtimeHealthProbe.innerCommand || '');
    const rewrittenInner = rewriteSourceRoot(innerCommand, sourceRoot, probeSource);
    const sourceSyntaxChecked = preflightHookSources(h, probeSource, probeEnv, logicalId, timeoutMs);
    const rr = runHook(rewrittenInner, probePayload, probeEnv, probeHome, timeoutMs, contract.businessExitCodes);
    if (rr.infrastructureFailure) {
      throw new EquivInfrastructureError('hook runtime health probe failed for ' + logicalId + ': ' + rr.infrastructureReason,
        { logicalId, phase, exitCode: rr.exitCode, reason: rr.infrastructureReason });
    }
    const outerAfterProbe = stateDigest(outerHome);
    if (outerAfterProbe !== initialOuter) throw new EquivInfrastructureError('runtime health probe contaminated outer sandbox for ' + logicalId);
    const outerPrefixes = [outerHome, outerSource, sourceRoot];
    const probePrefixes = [probeHome, probeSource, sourceRoot];
    const outerInputSha256 = payloadBinding(outerPayload, outerPrefixes);
    const probeInputSha256 = payloadBinding(probePayload, probePrefixes);
    if (outerInputSha256 !== probeInputSha256) throw new EquivInfrastructureError('runtime health probe input binding mismatch for ' + logicalId);
    const outerEnvBinding = bindingEnv(outerEnv, outerPrefixes);
    const probeEnvBinding = bindingEnv(probeEnv, probePrefixes);
    if (hashObject(outerEnvBinding) !== hashObject(probeEnvBinding)) {
      throw new EquivInfrastructureError('runtime health probe environment binding mismatch for ' + logicalId);
    }
    return {
      schema: 'axmem-runtime-health/v1', status: 'healthy',
      caseId: String(c.id), event: String(group.event), phase: String(phase), logicalId,
      inputSha256: outerInputSha256,
      inputCanonical: normalizeRuntimeText(JSON.stringify(stableObject(outerPayload)), outerPrefixes),
      sourceCommit: String(freeze.source.commit), sourceTreeOid: String(freeze.source.treeOid),
      sourceBindingSha256: sourceBinding.sha256, sourceFiles: sourceBinding.files,
      outerCommand, outerCommandSha256: sha256(Buffer.from(outerCommand, 'utf8')),
      innerCommand, innerCommandSha256: sha256(Buffer.from(innerCommand, 'utf8')),
      environment: outerEnvBinding, environmentSha256: hashObject(outerEnvBinding),
      initialOuterStateSha256: initialOuter, initialProbeStateSha256: initialProbe, initialStatesEqual: true,
      outerStateAfterProbeSha256: outerAfterProbe, probeContaminatedOuter: false,
      probeExitCode: rr.exitCode, probeOutcome: rr.outcome, sourceSyntaxChecked,
      probeNotes: contract.runtimeHealthProbe.notes,
    };
  } finally {
    try { fs.rmSync(probeHome, { recursive: true, force: true }); } catch {}
  }
}

function validateFixture(fixture) {
  if (!fixture || fixture.version !== 1 || !Array.isArray(fixture.events) || fixture.events.length === 0) {
    throw new Error('fixture.version must be 1 with a non-empty events[]');
  }
  const required = ['Bash', 'Edit', 'Write', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreCompact'];
  const counts = new Map(required.map((e) => [e, 0]));
  const ids = new Set();
  for (const group of fixture.events) {
    if (!group || typeof group.event !== 'string' || !group.event.trim() || !Array.isArray(group.cases) || group.cases.length === 0) {
      throw new Error('each fixture event needs a non-empty event and cases[]');
    }
    if (counts.has(group.event)) counts.set(group.event, counts.get(group.event) + group.cases.length);
    for (const c of group.cases) {
      if (!c || typeof c.id !== 'string' || !c.id.trim()) throw new Error('fixture case id must be a non-empty string');
      const id = c.id.trim();
      if (ids.has(id)) throw new Error('duplicate fixture case id: ' + id);
      ids.add(id);
    }
  }
  const missing = required.filter((e) => counts.get(e) < 3);
  if (missing.length) throw new Error('fixture requires at least 3 cases for each required event; insufficient: ' + missing.join(', '));
  return { requiredEvents: required, counts: Object.fromEntries(counts), caseCount: ids.size };
}

function runCase({ freeze, group, c, repoRoot, sourceRoot, defaultTimeoutMs }) {
  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-equiv-case-'));
  try {
    const sandboxSource = materializeFreeze(freeze, repoRoot, sandboxHome);
    const before = walkFiles(sandboxHome);
    const env = isolatedEnv(sandboxHome);
    const hookResults = [];
    const stdout = [], stderr = [];
    let exitCode = 0, executed = 0;
    const phases = hookEventsForGroup(group);
    for (const phase of phases) {
      const toolName = TOOL_EVENTS.has(group.event) ? group.event : (c.input && c.input.tool_name);
      for (const h of freeze.hooks || []) {
        if (h.event !== phase || !matcherMatches(h.matcher, toolName)) continue;
        const logicalId = logicalHookId(h, phase);
        const matcher = h.matcher === undefined ? null : h.matcher;
        if (!RUN_DISPOSITIONS.has(h.disposition)) {
          const reason = typeof h.notes === 'string' ? h.notes.trim() : '';
          if (!reason) throw new Error('skipped hook lacks explicit rationale: ' + logicalId + ' (' + h.disposition + ')');
          const externalDependencies = Array.isArray(h.externalDependencies) ? h.externalDependencies.slice() : [];
          if (h.disposition === 'external-prerequisite' && externalDependencies.length === 0) {
            throw new Error('external-prerequisite hook lacks explicit dependency list: ' + logicalId);
          }
          hookResults.push({
            logicalId, phase, matcher, disposition: h.disposition, status: 'skipped',
            reason, externalDependencies,
          });
          continue;
        }
        const command = rewriteSourceRoot(h.command, sourceRoot, sandboxSource);
        const payload = casePayload(group, c, phase, sandboxHome);
        const timeoutMs = Number.isFinite(Number(h.timeout)) && Number(h.timeout) > 0 ? Number(h.timeout) * 1000 : defaultTimeoutMs;
        const contract = hookExitContract(h, logicalId);
        const runtimeHealth = runRuntimeHealthProbe({
          freeze, h, logicalId, phase, c, group, sourceRoot,
          outerHome: sandboxHome, outerSource: sandboxSource, outerEnv: env, outerPayload: payload,
          timeoutMs, contract,
        });
        const sourceSyntaxChecked = preflightHookSources(h, sandboxSource, env, logicalId, timeoutMs);
        const rr = runHook(command, payload, env, sandboxHome, timeoutMs, contract.businessExitCodes);
        if (rr.infrastructureFailure) {
          throw new EquivInfrastructureError(
            'hook infrastructure failure for ' + logicalId + ': ' + rr.infrastructureReason,
            { logicalId, phase, disposition: h.disposition, exitCode: rr.exitCode, reason: rr.infrastructureReason,
              businessExitCodes: contract.businessExitCodes, runtimeHealth }
          );
        }
        executed++;
        hookResults.push({
          logicalId, phase, matcher, disposition: h.disposition, status: 'ran',
          exitCode: rr.exitCode, outcome: rr.outcome,
          businessExitCodes: contract.businessExitCodes,
          runtimeHealth,
          sourceSyntaxChecked,
        });
        if (rr.stdout) stdout.push('[' + logicalId + ']\n' + rr.stdout);
        if (rr.stderr) stderr.push('[' + logicalId + ']\n' + rr.stderr);
        if (exitCode === 0 && rr.exitCode !== 0) exitCode = rr.exitCode;
      }
    }
    if (hookResults.length === 0) throw new Error('no matching hooks for fixture case ' + c.id + ' (' + group.event + ')');
    const prefixes = [sandboxHome, sandboxSource, sourceRoot];
    const after = walkFiles(sandboxHome);
    return {
      id: c.id,
      event: group.event,
      exitCode,
      stdout: normalizeRuntimeText(stdout.join(''), prefixes),
      stderr: normalizeRuntimeText(stderr.join(''), prefixes),
      stateTree: diffState(before, after, prefixes),
      hookResults,
      executedHooks: executed,
    };
  } finally {
    try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch {}
  }
}

function runFreezeReport(opts) {
  const freeze = typeof opts.freeze === 'string' ? loadJson(opts.freeze) : opts.freeze;
  const fixture = typeof opts.fixture === 'string' ? loadJson(opts.fixture) : opts.fixture;
  const coverage = validateFixture(fixture);
  const repoRoot = path.resolve(opts.repoRoot);
  const sourceRoot = path.resolve(opts.sourceRoot);
  const defaultTimeoutMs = Number.isFinite(Number(opts.defaultTimeoutMs)) && Number(opts.defaultTimeoutMs) > 0 ? Number(opts.defaultTimeoutMs) : 60000;
  const cases = [];
  for (const group of fixture.events) {
    for (const c of group.cases) {
      cases.push(runCase({ freeze, group, c: Object.assign({}, c, { id: c.id.trim() }), repoRoot, sourceRoot, defaultTimeoutMs }));
    }
  }
  const report = {
    schema: 'axmem-equiv-report/v1',
    generatedAt: new Date().toISOString(),
    source: {
      commit: freeze.source.commit,
      treeOid: freeze.source.treeOid,
      sourceFiles: (freeze.sourceFiles || []).map((f) => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
      sourceFilesSha256: hashObject((freeze.sourceFiles || []).map((f) => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => a.path.localeCompare(b.path))),
    },
    normalization: { pathPrefixes: [sourceRoot] },
    fixtureCoverage: coverage,
    cases,
  };
  if (opts.out) {
    const out = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = out + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n');
    fs.renameSync(tmp, out);
  }
  return report;
}

module.exports = {
  EquivInfrastructureError, normalizeRuntimeText, matcherMatches, hookEventsForGroup,
  materializeFreeze, rewriteSourceRoot, diffState, logicalHookId, hookExitContract, preflightHookSources,
  runHook, runRuntimeHealthProbe, validateFixture, runCase, runFreezeReport, stateDigest, hashObject, sourceBindingForHook,
};
