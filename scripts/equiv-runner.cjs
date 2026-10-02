#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { TextDecoder } = require('util');
const hookSemantics = require('./p2-hook-semantics.cjs');
const freezeTool = require('./p2-freeze.cjs');

const RUN_DISPOSITIONS = new Set(['port', 'replace']);
const ALL_DISPOSITIONS = hookSemantics.DISPOSITIONS;
const TOOL_EVENTS = new Set(['Bash', 'Edit', 'Write']);

function posix(p) { return String(p).replace(/\\/g, '/'); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function safeRel(p) {
  const n = posix(String(p || '').trim()).replace(/^\.\//, '');
  if (!n || path.posix.isAbsolute(n) || n === '..' || n.startsWith('../') || n.includes('/../')) {
    throw new EquivInfrastructureError('unsafe-relative-path', 'unsafe relative path: ' + p, { path: p });
  }
  return n;
}
function loadJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new EquivInfrastructureError('json-read-failed', 'cannot read JSON: ' + file, { file, cause: String(e && e.message || e) }); }
  try { return JSON.parse(raw); }
  catch (e) { throw new EquivInfrastructureError('json-invalid', 'invalid JSON: ' + file, { file, cause: String(e && e.message || e) }); }
}

function normalizeRuntimeText(value, prefixes) {
  let s = String(value === undefined || value === null ? '' : value);
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

function materializeFreeze(freeze, repoRoot, sandboxHome, axmemRepoRoot) {
  if (!freeze || freeze.schema !== 'axmem-p2-freeze/v1') throw new EquivInfrastructureError('freeze-schema-invalid', 'freeze schema must be axmem-p2-freeze/v1');
  if (!freeze.source || !/^[0-9a-f]{40}$/i.test(String(freeze.source.commit || '')) || !/^[0-9a-f]{40}$/i.test(String(freeze.source.treeOid || ''))) {
    throw new EquivInfrastructureError('freeze-source-invalid', 'freeze source commit/treeOid missing or invalid', { source: freeze.source });
  }
  if (!Array.isArray(freeze.sourceFiles) || freeze.sourceFiles.length === 0) throw new EquivInfrastructureError('freeze-source-files-invalid', 'freeze sourceFiles must be a non-empty array');
  validateFreezeHooks(freeze);
  const liveRel = safeRel(freeze.source.liveRelativePath);
  let actualTree;
  try {
    actualTree = String(cp.execFileSync('git', ['-C', repoRoot, 'rev-parse', freeze.source.commit + ':' + liveRel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  } catch {
    throw new EquivInfrastructureError('freeze-tree-read-failed', 'cannot resolve frozen live-root tree', { commit: freeze.source.commit, liveRelativePath: liveRel });
  }
  if (actualTree.toLowerCase() !== String(freeze.source.treeOid).toLowerCase()) {
    throw new EquivInfrastructureError('freeze-tree-oid-mismatch', 'freeze source treeOid does not match source commit', { expected: freeze.source.treeOid, actual: actualTree });
  }
  const sourceDir = path.join(sandboxHome, ...liveRel.split('/'));
  const materializedPathCaseMap = new Map();
  for (const row of freeze.sourceFiles) {
    const rel = safeRel(row.path);
    const folded = rel.toLowerCase();
    if (materializedPathCaseMap.has(folded)) {
      throw new EquivInfrastructureError('freeze-source-file-duplicate', 'freeze sourceFiles paths must be unique under case folding before materialization', {
        path: rel, existingPath: materializedPathCaseMap.get(folded), reason: 'path-case-collision',
      });
    }
    materializedPathCaseMap.set(folded, rel);
  }
  for (const f of freeze.sourceFiles) {
    const rel = safeRel(f.path);
    if (!/^[0-9a-f]{64}$/i.test(String(f.sha256 || ''))) throw new EquivInfrastructureError('freeze-source-hash-missing', 'freeze source file sha256 is required', { path: rel, sha256: f.sha256 });
    const repoRel = path.posix.join(liveRel, rel);
    let blob;
    try { blob = gitBlob(repoRoot, freeze.source.commit + ':' + repoRel); }
    catch { throw new EquivInfrastructureError('freeze-source-blob-read-failed', 'cannot read frozen source blob', { path: rel, commit: freeze.source.commit }); }
    const got = sha256(blob);
    if (got.toLowerCase() !== String(f.sha256).toLowerCase()) throw new EquivInfrastructureError('freeze-source-hash-mismatch', 'freeze blob hash mismatch', { path: rel, expected: f.sha256, actual: got });
    const dst = path.join(sourceDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, blob);
  }
  const se = freeze.settingsEvidence;
  if (!se || typeof se !== 'object' || Array.isArray(se) || typeof se.mirrorPath !== 'string' || !se.mirrorPath.trim()
      || !/^[0-9a-f]{64}$/i.test(String(se.mirrorSha256 || '')) || !/^[0-9a-f]{64}$/i.test(String(se.hookIdentitySha256 || ''))) {
    throw new EquivInfrastructureError('freeze-settings-evidence-missing', 'freeze settingsEvidence mirror binding is required', { settingsEvidence: se });
  }
  const mirrorRel = safeRel(se.mirrorPath);
  let mirrorBlob;
  try { mirrorBlob = gitBlob(repoRoot, freeze.source.commit + ':' + path.posix.join(liveRel, mirrorRel)); }
  catch { throw new EquivInfrastructureError('freeze-settings-mirror-read-failed', 'cannot read frozen settings mirror', { mirrorPath: mirrorRel }); }
  const mirrorSha = sha256(mirrorBlob);
  if (mirrorSha.toLowerCase() !== String(se.mirrorSha256).toLowerCase()) throw new EquivInfrastructureError('freeze-settings-mirror-hash-mismatch', 'settings mirror sha256 mismatch', { mirrorPath: mirrorRel, expected: se.mirrorSha256, actual: mirrorSha });
  let mirrorSettings;
  try { mirrorSettings = JSON.parse(mirrorBlob.toString('utf8')); }
  catch (e) { throw new EquivInfrastructureError('freeze-settings-mirror-json-invalid', 'settings mirror is invalid JSON', { mirrorPath: mirrorRel, cause: String(e && e.message || e) }); }
  const settingsHooks = hookSemantics.flattenHooks(mirrorSettings, { unsupportedMatcher: 'reject', fail: semanticsFail });
  const hookIdentitySha256 = sha256(Buffer.from(settingsHooks.map((h) => hookSemantics.hookIdentity(h)).join('\n'), 'utf8'));
  if (hookIdentitySha256.toLowerCase() !== String(se.hookIdentitySha256).toLowerCase()) throw new EquivInfrastructureError('freeze-settings-hook-hash-mismatch', 'settings mirror hook identity sha256 mismatch', { expected: se.hookIdentitySha256, actual: hookIdentitySha256 });
  validateInventoryBinding(freeze, axmemRepoRoot, settingsHooks, repoRoot);
  return sourceDir;
}

function regexEscape(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function portablePathInfo(value) {
  const native = posix(path.resolve(String(value)));
  const m = /^([A-Za-z]):\/(.*)$/.exec(native);
  if (!m) return { native, drive: null, rest: native.replace(/^\/+/, '').split('/').filter(Boolean) };
  return { native, drive: m[1], rest: m[2].split('/').filter(Boolean) };
}

function toMsysPath(value) {
  const p = posix(path.resolve(String(value)));
  const m = /^([A-Za-z]):\/(.*)$/.exec(p);
  return m ? '/' + m[1].toLowerCase() + '/' + m[2] : p;
}

function toCygdrivePath(value) {
  const p = posix(path.resolve(String(value)));
  const m = /^([A-Za-z]):\/(.*)$/.exec(p);
  return m ? '/cygdrive/' + m[1].toLowerCase() + '/' + m[2] : p;
}

function canonicalPathForComparison(value) {
  let x = String(value || '').replace(/\\/g, '/');
  x = x.replace(/\/cygdrive\/([A-Za-z])\//g, '$1:/');
  x = x.replace(/\/([A-Za-z])\//g, '$1:/');
  x = x.replace(/\/+/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? x.toLowerCase() : x;
}

function sameSourcePath(a, b) {
  return canonicalPathForComparison(path.resolve(String(a))) === canonicalPathForComparison(path.resolve(String(b)));
}

function sourceRootResidual(command, sourceRoot) {
  const hay = canonicalPathForComparison(command);
  const needle = canonicalPathForComparison(sourceRoot);
  let from = 0;
  while (needle && (from = hay.indexOf(needle, from)) >= 0) {
    const before = from === 0 ? '' : hay[from - 1];
    const after = hay[from + needle.length] || '';
    const boundary = (ch) => !ch || !/[A-Za-z0-9_.~-]/.test(ch);
    if (boundary(before) && boundary(after)) return true;
    from += needle.length;
  }
  return false;
}

function rewriteSourceRoot(command, sourceRoot, sandboxSource) {
  const info = portablePathInfo(sourceRoot);
  let variants;
  if (info.drive) {
    const tail = info.rest.map(regexEscape).join('[\\\\/]+');
    const drive = regexEscape(info.drive);
    variants = [
      drive + ':[\\\\/]+' + tail,
      '[\\\\/]+cygdrive[\\\\/]+' + drive + '[\\\\/]+' + tail,
      '[\\\\/]+' + drive + '[\\\\/]+' + tail,
    ];
  } else {
    variants = [info.rest.map(regexEscape).join('[\\\\/]+')];
  }
  const re = new RegExp('(^|[^A-Za-z0-9_.~-])(' + variants.join('|') + ')(?=$|[^A-Za-z0-9_.~-])', process.platform === 'win32' ? 'gi' : 'g');
  let replacements = 0;
  const out = String(command || '').replace(re, (all, prefix, matched) => {
    replacements++;
    let dst;
    if (/^[\\/]+cygdrive[\\/]+/i.test(matched)) dst = toCygdrivePath(sandboxSource);
    else if (/^[\\/]+[A-Za-z][\\/]+/.test(matched)) dst = toMsysPath(sandboxSource);
    else if (matched.includes('\\')) dst = String(path.resolve(sandboxSource)).replace(/\//g, '\\');
    else dst = posix(path.resolve(sandboxSource));
    return prefix + dst;
  });
  if (replacements === 0) {
    throw new EquivInfrastructureError('source-root-rewrite-zero', 'hook command does not contain the reviewed live source root', { sourceRoot, command: String(command || '') });
  }
  if (sourceRootResidual(out, sourceRoot)) {
    throw new EquivInfrastructureError('source-root-rewrite-residual', 'hook command still contains the reviewed live source root after rewrite', { sourceRoot, command: String(command || ''), rewritten: out });
  }
  return out;
}

function matcherOptions() {
  return {
    unsupportedMatcher: 'ignore',
    fail(code, message, detail) { throw new EquivInfrastructureError(code, message, detail); },
  };
}

function matcherMatches(event, matcher, payload) {
  return hookSemantics.matcherMatches(event, matcher, payload, matcherOptions());
}

function hookEventsForGroup(group) {
  if (Array.isArray(group.hookEvents) && group.hookEvents.length) return group.hookEvents.slice();
  return TOOL_EVENTS.has(group.event) ? ['PreToolUse', 'PostToolUse'] : [group.event];
}

function isDevicePath(value) {
  return /^NUL$/i.test(String(value || '')) || String(value || '') === '/dev/null';
}

function portableAbsoluteToNative(value) {
  const raw = String(value || '');
  let m = /^\/cygdrive\/([A-Za-z])\/(.*)$/.exec(raw);
  if (m) return m[1] + ':/' + m[2];
  m = /^\/([A-Za-z])\/(.*)$/.exec(raw);
  if (m) return m[1] + ':/' + m[2];
  return raw;
}

function isAbsolutePortable(value) {
  const s = String(value || '');
  return path.win32.isAbsolute(s) || path.posix.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s) || /^\/[A-Za-z]\//.test(s) || /^\/cygdrive\/[A-Za-z]\//.test(s) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(s);
}

function pathInsideSandbox(value, sandboxHome) {
  const native = portableAbsoluteToNative(value);
  if (/^(?:\\\\|\/\/)/.test(native)) return false;
  const root = canonicalPathForComparison(path.resolve(sandboxHome));
  const target = canonicalPathForComparison(path.resolve(native));
  return target === root || target.startsWith(root + '/');
}

const SANDBOX_LITERAL_TMP_RE = /(^|[^A-Za-z0-9_.~:])\/tmp(?:[\\/]|(?=$)|(?=[\s"'`;|&()<>{}\[\]]))/i;
const LITERAL_TMP_DEFAULT_EXPANSIONS = ['${TMPDIR:-/tmp}', '${TMPDIR-/tmp}'];
const LITERAL_TMP_EXCEPTIONS = Object.freeze({
  'guards/pmm-shell-memory-watch.sh': Object.freeze({
    lineSha256: 'c0787a56bb619e4e55e565c79431d1d8f5e23c8634560c1ec7dbc1c609ec5618',
    reason: 'case 模式匹配,不写文件;仅 --self-test 分支',
  }),
});

function scanLiteralTmpSource(relPath, text, options = {}) {
  const rel = safeRel(relPath);
  const src = String(text);
  const ext = path.extname(rel).toLowerCase();
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const shebang = firstLine.startsWith('#!') ? firstLine.slice(2).trim() : null;
  const sourceTypeHint = options.sourceTypeHint === undefined || options.sourceTypeHint === null ? null : String(options.sourceTypeHint);
  if (sourceTypeHint !== null && sourceTypeHint !== 'shell' && sourceTypeHint !== 'js') {
    throw new EquivInfrastructureError('sandbox-source-type-unknown', 'invalid executable source type hint for literal /tmp preflight', { path: rel, sourceTypeHint });
  }
  let shell = sourceTypeHint === 'shell' || (!sourceTypeHint && (ext === '.sh' || ext === '.bash'));
  let js = sourceTypeHint === 'js' || (!sourceTypeHint && (ext === '.js' || ext === '.cjs' || ext === '.mjs'));
  if (!shell && !js && shebang) {
    if (/(?:^|[\\/\s])(?:ba|z|k)?sh(?:\s|$)/i.test(shebang) || /(?:^|[\\/\s])sh(?:\s|$)/i.test(shebang)) shell = true;
    else if (/(?:^|[\\/\s])node(?:\.exe)?(?:\s|$)/i.test(shebang)) js = true;
    else if (options.executableHint) throw new EquivInfrastructureError('sandbox-source-type-unknown', 'executable source has an unsupported shebang for literal /tmp preflight', { path: rel, shebang });
  }
  let parseableJson = false;
  if (ext === '.json' && !shebang) {
    try { JSON.parse(src); parseableJson = true; } catch {}
  }
  const pureData = ext === '.json' && parseableJson && !options.executableHint;
  if (pureData) return { path: rel, checked: false, notApplicable: true, reason: 'pure-data-json', sourceType: 'data', exceptionsUsed: [] };
  if (!shell && !js && options.executableHint) {
    throw new EquivInfrastructureError('sandbox-source-type-unknown', 'executable source type cannot be determined for literal /tmp preflight', { path: rel, shebang });
  }
  let inBlockComment = false;
  const exceptionsUsed = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (shell && /^#(?!\!)/.test(trimmed)) continue;
    if (js) {
      if (inBlockComment) {
        const close = line.indexOf('*/');
        if (close < 0) continue;
        inBlockComment = false;
        if (!line.slice(close + 2).trim()) continue;
      } else {
        if (/^\/\//.test(trimmed)) continue;
        if (/^\/\*/.test(trimmed)) {
          const close = trimmed.indexOf('*/', 2);
          if (close < 0) { inBlockComment = true; continue; }
          if (!trimmed.slice(close + 2).trim()) continue;
        }
      }
    }
    let candidate = line;
    for (const exact of LITERAL_TMP_DEFAULT_EXPANSIONS) candidate = candidate.split(exact).join('<TMPDIR_DEFAULT>');
    SANDBOX_LITERAL_TMP_RE.lastIndex = 0;
    if (!SANDBOX_LITERAL_TMP_RE.test(candidate)) continue;
    const normalizedLine = line.replace(/[ \t]+$/, '');
    const lineSha256 = sha256(Buffer.from(normalizedLine, 'utf8'));
    const approved = LITERAL_TMP_EXCEPTIONS[rel];
    if (approved && approved.lineSha256 === lineSha256) {
      exceptionsUsed.push({ path: rel, line: i + 1, lineSha256, reason: approved.reason });
      continue;
    }
    throw new EquivInfrastructureError('sandbox-literal-tmp', 'hook source contains an unapproved literal /tmp path', {
      path: rel, line: i + 1, lineSha256, text: normalizedLine,
    });
  }
  return { path: rel, checked: true, sourceType: shell ? 'shell' : js ? 'js' : 'generic', exceptionsUsed };
}

function preflightMaterializedSources(freeze, sandboxSource) {
  const checked = [];
  for (const row of freeze.sourceFiles || []) {
    const rel = safeRel(row.path);
    const abs = path.join(sandboxSource, ...rel.split('/'));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new EquivInfrastructureError('sandbox-materialized-source-missing', 'materialized source file is missing before literal /tmp preflight', { path: rel });
    }
    const scan = scanLiteralTmpSource(rel, fs.readFileSync(abs, 'utf8'));
    checked.push({ path: rel, checked: scan.checked, sourceType: scan.sourceType, notApplicable: Boolean(scan.notApplicable) });
  }
  return checked;
}

function assertSandboxTmpdir(env, sandboxHome) {
  const key = Object.keys(env || {}).find((k) => k.toLowerCase() === 'tmpdir');
  const value = key ? env[key] : null;
  if (typeof value !== 'string' || !value || !isAbsolutePortable(value) || !pathInsideSandbox(value, sandboxHome)) {
    throw new EquivInfrastructureError('sandbox-tmpdir-invalid', 'TMPDIR must be set to an absolute path inside the case sandbox', {
      tmpdir: value, sandboxHome: posix(path.resolve(sandboxHome)),
    });
  }
  return value;
}

function prepareCaseInput(rawInput, sandboxHome) {
  const input = JSON.parse(JSON.stringify(rawInput || {}));
  const expandTmp = (value) => {
    let out = String(value);
    if (out === '<TMP>') out = posix(sandboxHome);
    else if (out.startsWith('<TMP>/') || out.startsWith('<TMP>\\')) out = posix(sandboxHome) + '/' + out.slice(6).replace(/^[\\/]+/, '');
    return out;
  };
  if (Object.prototype.hasOwnProperty.call(input, 'cwd') && typeof input.cwd === 'string') {
    input.cwd = expandTmp(input.cwd);
    if (!isAbsolutePortable(input.cwd) || isDevicePath(input.cwd)) {
      throw new EquivInfrastructureError('payload-path-not-absolute', 'payload cwd must be absolute', { field: '$.cwd', value: input.cwd });
    }
    if (!pathInsideSandbox(input.cwd, sandboxHome)) {
      throw new EquivInfrastructureError('payload-path-outside-sandbox', 'payload path escapes the case sandbox: $.cwd', { field: '$.cwd', value: input.cwd, sandboxHome: posix(sandboxHome) });
    }
  } else if (!input.cwd) input.cwd = posix(sandboxHome);

  const targets = [[input, 'transcript_path', '$.transcript_path', true]];
  if (input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input)) {
    for (const key of ['file_path', 'path', 'notebook_path']) targets.push([input.tool_input, key, '$.tool_input.' + key, false]);
    if (Array.isArray(input.tool_input.edits)) {
      for (let i = 0; i < input.tool_input.edits.length; i++) {
        const edit = input.tool_input.edits[i];
        if (edit && typeof edit === 'object' && !Array.isArray(edit)) targets.push([edit, 'file_path', '$.tool_input.edits[' + i + '].file_path', false]);
      }
    }
  }
  for (const [obj, key, label, mustBeAbsolute] of targets) {
    if (!Object.prototype.hasOwnProperty.call(obj, key) || typeof obj[key] !== 'string') continue;
    let value = expandTmp(obj[key]);
    if (isDevicePath(value)) {
      if (mustBeAbsolute) throw new EquivInfrastructureError('payload-path-not-absolute', 'payload path must be absolute: ' + label, { field: label, value });
      obj[key] = value;
      continue;
    }
    if (!isAbsolutePortable(value)) {
      if (mustBeAbsolute) throw new EquivInfrastructureError('payload-path-not-absolute', 'payload path must be absolute: ' + label, { field: label, value });
      value = posix(path.resolve(portableAbsoluteToNative(input.cwd), value));
    }
    obj[key] = value;
    if (!pathInsideSandbox(value, sandboxHome)) {
      throw new EquivInfrastructureError('payload-path-outside-sandbox', 'payload path escapes the case sandbox: ' + label, { field: label, value, sandboxHome: posix(sandboxHome) });
    }
  }
  return input;
}

function casePayload(group, c, hookEvent, sandboxHome) {
  const input = JSON.parse(JSON.stringify(c.input || {}));
  input.hook_event_name = hookEvent;
  if (!input.cwd) input.cwd = posix(sandboxHome);
  if (TOOL_EVENTS.has(group.event) && !input.tool_name) input.tool_name = group.event;
  if (hookEvent === 'PostToolUse' && !Object.prototype.hasOwnProperty.call(input, 'tool_response')) input.tool_response = {};
  return input;
}

function inheritedEnvValue(env, name) {
  if (process.platform !== 'win32') return env[name];
  const want = String(name).toLowerCase();
  for (const key of Object.keys(env || {})) if (key.toLowerCase() === want) return env[key];
  return undefined;
}

function findBash() {
  const override = inheritedEnvValue(process.env, 'AXMEM_EQUIV_BASH');
  if (override) return override;
  if (process.platform === 'win32') {
    const pf = inheritedEnvValue(process.env, 'ProgramFiles') || 'C:\\Program Files';
    const c = path.join(pf, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(c)) return c;
  }
  return 'bash';
}

function bashInterpreterProvenance() {
  const executable = findBash();
  let resolved = executable;
  if (path.win32.isAbsolute(executable) || path.posix.isAbsolute(executable)) {
    try { resolved = fs.realpathSync.native(executable); }
    catch { resolved = path.resolve(executable); }
  } else {
    const probe = cp.spawnSync(executable, ['-lc', 'printf "%s\\n" "$BASH"'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    });
    const candidate = String(probe.stdout || '').split(/\r?\n/).find((x) => x.trim());
    if (probe.error || probe.signal || probe.status !== 0 || !candidate
        || (!path.win32.isAbsolute(candidate.trim()) && !path.posix.isAbsolute(candidate.trim()))) {
      throw new EquivInfrastructureError('bash-provenance-failed', 'cannot resolve bash interpreter path', {
        executable, status: probe.status, signal: probe.signal || null,
        cause: probe.error ? String(probe.error.message || probe.error) : String(probe.stderr || '').trim(),
      });
    }
    resolved = candidate.trim();
  }
  const version = cp.spawnSync(executable, ['--version'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
  });
  const versionFirstLine = String(version.stdout || '').split(/\r?\n/).find((x) => x.trim()) || '';
  if (version.error || version.signal || version.status !== 0 || !versionFirstLine) {
    throw new EquivInfrastructureError('bash-provenance-failed', 'cannot record bash --version provenance', {
      executable, resolvedPath: resolved, status: version.status, signal: version.signal || null,
      cause: version.error ? String(version.error.message || version.error) : String(version.stderr || '').trim(),
    });
  }
  return { path: posix(resolved), versionFirstLine: versionFirstLine.trim() };
}

const GIT_LOCAL_ENV_VARS_STATIC = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_NAMESPACE', 'GIT_QUARANTINE_PATH',
  'GIT_INTERNAL_SUPER_PREFIX', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
];
const DANGEROUS_ENV_EXACT = ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_PATH', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'PROMPT_COMMAND', 'CDPATH', 'GLOBIGNORE', 'CLAUDE_SETTINGS_JSON_OVERRIDE'];
let gitLocalEnvVarsCache = null;

function deleteEnvKeyCI(env, name) {
  const want = String(name).toLowerCase();
  for (const k of Object.keys(env)) if (k.toLowerCase() === want) delete env[k];
}
function setEnvKeyCI(env, name, value) { deleteEnvKeyCI(env, name); env[name] = value; }
function deleteEnvPatternCI(env, re) { for (const k of Object.keys(env)) if (re.test(k)) delete env[k]; }
function gitLocalEnvVars() {
  if (gitLocalEnvVarsCache) return gitLocalEnvVarsCache.slice();
  const set = new Set(GIT_LOCAL_ENV_VARS_STATIC);
  try {
    const clean = Object.assign({}, process.env);
    for (const k of Object.keys(clean)) if (/^GIT_/i.test(k)) delete clean[k];
    const r = cp.spawnSync('git', ['rev-parse', '--local-env-vars'], { env: clean, encoding: 'utf8', timeout: 10000 });
    if (r.status === 0 && r.stdout) for (const line of String(r.stdout).split(/\r?\n/)) { const v = line.trim(); if (/^GIT_[A-Z0-9_]+$/.test(v)) set.add(v); }
  } catch {}
  gitLocalEnvVarsCache = [...set];
  return gitLocalEnvVarsCache.slice();
}
function gitCeilingForSandbox(sandboxHome) {
  let parent = path.dirname(path.resolve(sandboxHome));
  try { parent = fs.realpathSync.native(parent); } catch {}
  return String(parent).replace(/\\/g, '/').replace(/\/+$/, '');
}
const ENV_SCRUBBED_KEYS = Symbol('axmem-env-scrubbed-keys');

function portableRootRegex(root) {
  const info = portablePathInfo(root);
  const tail = info.rest.map(regexEscape).join('[\\\\/]+');
  if (!tail) return null;
  const variants = info.drive ? [
    regexEscape(info.drive) + ':[\\\\/]+' + tail,
    '[\\\\/]+cygdrive[\\\\/]+' + regexEscape(info.drive) + '[\\\\/]+' + tail,
    '[\\\\/]+' + regexEscape(info.drive) + '[\\\\/]+' + tail,
    '[\\\\/]+' + tail,
  ] : ['[\\\\/]+' + tail];
  return new RegExp('(^|[^A-Za-z0-9_.~-])(' + variants.join('|') + ')(?=$|[^A-Za-z0-9_.~-])', process.platform === 'win32' ? 'gi' : 'g');
}

function maskPortableRoot(value, root) {
  const re = root ? portableRootRegex(root) : null;
  return re ? String(value || '').replace(re, (all, prefix) => prefix + '<SANDBOX>') : String(value || '');
}

function inheritedValueLeaksRoot(value, roots, sandboxHome) {
  let candidate = maskPortableRoot(value, sandboxHome);
  for (const root of roots) {
    const re = root ? portableRootRegex(root) : null;
    if (re && re.test(candidate)) return true;
  }
  return false;
}

function isolatedEnv(sandboxHome, sessionId, context = {}) {
  const absHome = path.resolve(sandboxHome);
  const home = posix(absHome);
  const tmp = path.join(absHome, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const inherited = Object.assign({}, process.env);
  const env = Object.assign({}, inherited);
  const scrubbed = new Set();
  const deletePattern = (re) => {
    for (const k of Object.keys(env)) if (re.test(k)) { scrubbed.add(k); delete env[k]; }
  };
  const deleteExact = (name) => {
    const want = String(name).toLowerCase();
    for (const k of Object.keys(env)) if (k.toLowerCase() === want) { scrubbed.add(k); delete env[k]; }
  };
  deletePattern(/^BASH_FUNC_.*%%$/i);
  deletePattern(/^(?:PMM_|AXMEM_)/i);
  deletePattern(/^XDG_/i);
  deletePattern(/^PIPE_GATE_/i);
  deletePattern(/^CLAUDE_/i);
  deletePattern(/^CLAUDECODE$/i);
  deletePattern(/^GIT_TRACE/i);
  deletePattern(/^NODE_/i);
  for (const name of DANGEROUS_ENV_EXACT) deleteExact(name);
  for (const name of gitLocalEnvVars()) deleteExact(name);
  deletePattern(/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/i);
  const parsed = path.parse(absHome);
  const drive = process.platform === 'win32' ? parsed.root.replace(/[\\/]+$/, '') : '';
  const homePath = process.platform === 'win32' && drive ? posix(absHome).slice(drive.length) : home;
  const safe = {
    HOME: home, USERPROFILE: home, HOMEDRIVE: drive, HOMEPATH: homePath,
    APPDATA: posix(path.join(absHome, 'AppData', 'Roaming')),
    LOCALAPPDATA: posix(path.join(absHome, 'AppData', 'Local')),
    XDG_CONFIG_HOME: posix(path.join(absHome, '.config')),
    XDG_DATA_HOME: posix(path.join(absHome, '.local', 'share')),
    XDG_STATE_HOME: posix(path.join(absHome, '.local', 'state')),
    XDG_CACHE_HOME: posix(path.join(absHome, '.cache')),
    HERMES_HOME: posix(path.join(absHome, '.hermes')),
    TEMP: posix(tmp), TMP: posix(tmp), TMPDIR: posix(tmp),
    CLAUDE_CONFIG_DIR: posix(path.join(absHome, '.claude')),
    PMM_HOME: home, PMM_SELFTEST_ACTIVE: '1', PMM_SELFTEST_ROOT: home,
    AXMEM_HOME: posix(path.join(absHome, '.axmem')),
    AXMEM_MEMORY_DIR: posix(path.join(absHome, 'memory')),
    AXMEM_STATE_DIR: posix(path.join(absHome, '.axmem-state')),
    AXMEM_EQUIV_ACTIVE: '1',
    GIT_CEILING_DIRECTORIES: gitCeilingForSandbox(absHome),
  };
  const managed = new Set(Object.keys(safe).concat(['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'PATH']).map((k) => k.toLowerCase()));
  const sensitiveRoots = [inheritedEnvValue(inherited, 'USERPROFILE') || inheritedEnvValue(inherited, 'HOME') || '', context.sourceRoot || '', context.axmemRepoRoot || ''].filter(Boolean);
  for (const k of Object.keys(env)) {
    if (managed.has(k.toLowerCase())) continue;
    if (inheritedValueLeaksRoot(env[k], sensitiveRoots, absHome)) { scrubbed.add(k); delete env[k]; }
  }
  for (const [k, v] of Object.entries(safe)) setEnvKeyCI(env, k, v);
  if (typeof sessionId === 'string' && sessionId) {
    setEnvKeyCI(env, 'CLAUDE_SESSION_ID', sessionId);
    setEnvKeyCI(env, 'CLAUDE_CODE_SESSION_ID', sessionId);
  } else {
    deleteEnvKeyCI(env, 'CLAUDE_SESSION_ID');
    deleteEnvKeyCI(env, 'CLAUDE_CODE_SESSION_ID');
  }
  const parentPath = String(inheritedEnvValue(inherited, 'PATH') || '');
  if (process.platform === 'win32') {
    const toMsys = (p) => {
      const s = String(p || '').replace(/\\/g, '/');
      const m = s.match(/^([A-Za-z]):\/(.*)$/);
      return m ? '/' + m[1].toLowerCase() + '/' + m[2] : s;
    };
    const entries = [toMsys(path.dirname(process.execPath)), '/usr/bin', '/bin'];
    for (const e of parentPath.split(';')) {
      if (!e.trim()) continue;
      if (context.sourceRoot && inheritedValueLeaksRoot(e.trim(), [context.sourceRoot], absHome)) { scrubbed.add('PATH'); continue; }
      entries.push(toMsys(e.trim()));
    }
    setEnvKeyCI(env, 'PATH', [...new Set(entries)].join(':'));
  } else if (parentPath) {
    const entries = [];
    for (const e of parentPath.split(path.delimiter)) {
      if (!e.trim()) continue;
      if (context.sourceRoot && inheritedValueLeaksRoot(e.trim(), [context.sourceRoot], absHome)) { scrubbed.add('PATH'); continue; }
      entries.push(e.trim());
    }
    setEnvKeyCI(env, 'PATH', [...new Set(entries)].join(path.delimiter));
  }
  Object.defineProperty(env, ENV_SCRUBBED_KEYS, { value: [...scrubbed].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), enumerable: false });
  return env;
}

function spawnSyncSandboxed(file, args, options) {
  const savedNodeEnv = [];
  for (const k of Object.keys(process.env)) {
    if (!/^NODE_/i.test(k)) continue;
    savedNodeEnv.push([k, process.env[k]]);
    delete process.env[k];
  }
  try {
    const opts = Object.assign({}, options || {});
    if (opts.env) opts.env = Object.assign({}, opts.env);
    return cp.spawnSync(file, args, opts);
  } finally {
    for (const [k, v] of savedNodeEnv) process.env[k] = v;
  }
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
  let text, encoding = 'utf8', invalidUtf8 = false;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); }
  catch { text = buf.toString('latin1'); encoding = 'latin1'; invalidUtf8 = true; }
  const normalized = normalizeRuntimeText(text, prefixes);
  const norm = Buffer.from(normalized, encoding);
  return { sha256: sha256(norm), size: norm.length, binary: invalidUtf8 };
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

function fixtureInputBinding(c) {
  const raw = c && Object.prototype.hasOwnProperty.call(c, 'input') && c.input !== undefined ? c.input : {};
  const inputCanonical = JSON.stringify(stableObject(raw));
  return { inputCanonical, inputSha256: sha256(Buffer.from(inputCanonical, 'utf8')) };
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
    if (/^(?:HOME|USERPROFILE|TMPDIR|TEMP|TMP|CLAUDE_CONFIG_DIR|PMM_.*|AXMEM_.*|XDG_.*)$/i.test(k)) {
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
  constructor(codeOrMessage, messageOrDetail, detail) {
    let code, message, resolvedDetail;
    if (typeof messageOrDetail === 'string' || arguments.length >= 3) {
      code = String(codeOrMessage || 'equiv-infrastructure');
      message = String(messageOrDetail || code);
      resolvedDetail = detail || null;
    } else {
      code = 'equiv-infrastructure';
      message = String(codeOrMessage || code);
      resolvedDetail = messageOrDetail || null;
    }
    super(message);
    this.name = 'EquivInfrastructureError';
    this.code = code;
    this.detail = resolvedDetail;
  }
}

function semanticsFail(code, message, detail) { throw new EquivInfrastructureError(code, message, detail); }

function validateFreezeHooks(freeze) {
  if (!freeze || !Array.isArray(freeze.hooks)) throw new EquivInfrastructureError('freeze-hooks-invalid', 'freeze.hooks must be an array');
  const identities = new Set();
  for (const h of freeze.hooks) {
    if (!h || typeof h !== 'object' || Array.isArray(h) || typeof h.event !== 'string' || !h.event.trim()
        || !Number.isInteger(h.groupIndex) || h.groupIndex < 0 || !Number.isInteger(h.hookIndex) || h.hookIndex < 0
        || typeof h.command !== 'string' || !h.command) {
      throw new EquivInfrastructureError('freeze-hook-identity-invalid', 'freeze hook identity fields are invalid', { hook: h });
    }
    if (!ALL_DISPOSITIONS.has(h.disposition)) throw new EquivInfrastructureError('freeze-hook-disposition-invalid', 'freeze hook disposition is invalid', { identity: hookSemantics.hookIdentity(h), disposition: h.disposition });
    hookSemantics.compileMatcher(h.event, Object.prototype.hasOwnProperty.call(h, 'matcher') ? h.matcher : null, matcherOptions());
    const identity = hookSemantics.hookIdentity(h);
    if (identities.has(identity)) throw new EquivInfrastructureError('freeze-hook-identity-duplicate', 'duplicate freeze hook identity', { identity });
    identities.add(identity);
    if (!RUN_DISPOSITIONS.has(h.disposition)) {
      const reason = typeof h.notes === 'string' ? h.notes.trim() : '';
      if (!reason) throw new EquivInfrastructureError('freeze-hook-skip-rationale-missing', 'skipped hook lacks explicit rationale', { identity, disposition: h.disposition });
      if (h.disposition === 'external-prerequisite' && (!Array.isArray(h.externalDependencies) || h.externalDependencies.length === 0)) throw new EquivInfrastructureError('freeze-hook-external-dependency-missing', 'external-prerequisite hook lacks dependency list', { identity });
    }
  }
  return identities.size;
}

function normalizeInventoryDerivedHook(h) {
  if (!h || typeof h !== 'object' || !ALL_DISPOSITIONS.has(h.disposition)) throw new EquivInfrastructureError('freeze-inventory-hook-invalid', 'inventory hook disposition is missing/invalid', { hook: h });
  const sourceRequired = h.disposition === 'port' || h.disposition === 'replace';
  const files = Array.isArray(h.files) ? h.files.map(safeRel) : null;
  if (!files) throw new EquivInfrastructureError('freeze-inventory-hook-invalid', 'inventory hook files must be an array');
  const externalDependencies = Array.isArray(h.externalDependencies) ? h.externalDependencies.map((x) => String(x || '').trim()) : [];
  if (externalDependencies.some((x) => !x)) throw new EquivInfrastructureError('freeze-inventory-hook-invalid', 'inventory hook externalDependencies contains empty id');
  let businessExitCodes = [], runtimeHealthProbe = null;
  if (sourceRequired) {
    if (!Array.isArray(h.businessExitCodes)) throw new EquivInfrastructureError('freeze-inventory-hook-invalid', 'inventory hook businessExitCodes[] missing');
    businessExitCodes = h.businessExitCodes.map((x) => Number(x)).sort((a, b) => a - b);
    if (businessExitCodes.some((x, i) => !Number.isInteger(x) || x <= 0 || x > 255 || x === 124 || x === 126 || x === 127 || (i > 0 && businessExitCodes[i - 1] === x))) throw new EquivInfrastructureError('freeze-inventory-hook-invalid', 'inventory hook businessExitCodes[] invalid');
    const p = h.runtimeHealthProbe;
    if (!p || typeof p !== 'object' || Array.isArray(p) || p.version !== 1 || typeof p.innerCommand !== 'string' || !p.innerCommand.trim()
        || typeof p.reliable !== 'boolean' || typeof p.notes !== 'string' || !p.notes.trim()) throw new EquivInfrastructureError('freeze-inventory-hook-invalid', 'inventory hook runtimeHealthProbe invalid');
    runtimeHealthProbe = { version: 1, innerCommand: p.innerCommand, reliable: p.reliable, notes: p.notes.trim() };
  }
  return { disposition: h.disposition, files, implementation: h.implementation || null, notes: h.notes || '', externalDependencies, businessExitCodes, runtimeHealthProbe };
}

function validateInventoryBinding(freeze, axmemRepoRoot, settingsHooks, sourceRepoRoot) {
  if (typeof freeze.inventoryPath !== 'string' || !freeze.inventoryPath.trim()
      || !/^[0-9a-f]{40}$/i.test(String(freeze.inventoryCommit || ''))
      || !/^[0-9a-f]{64}$/i.test(String(freeze.inventorySha256 || ''))) {
    throw new EquivInfrastructureError('freeze-inventory-binding-missing', 'freeze inventoryCommit/inventoryPath/inventorySha256 are required', { inventoryCommit: freeze.inventoryCommit, inventoryPath: freeze.inventoryPath, inventorySha256: freeze.inventorySha256 });
  }
  if (!axmemRepoRoot) throw new EquivInfrastructureError('freeze-axmem-root-missing', 'AxMem repository root is required for inventory verification');
  const rel = safeRel(freeze.inventoryPath);
  const axmemRoot = path.resolve(axmemRepoRoot);
  const ancestry = cp.spawnSync('git', ['-C', axmemRoot, 'merge-base', '--is-ancestor', freeze.inventoryCommit, 'HEAD'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
  });
  if (ancestry.error || ancestry.signal || ancestry.status !== 0) {
    throw new EquivInfrastructureError('inventory-commit-unreachable', 'freeze inventoryCommit must be reachable from AxMem HEAD before inventory bytes are read', {
      commit: freeze.inventoryCommit,
      axmemRepoRoot: axmemRoot,
      status: ancestry.status,
      signal: ancestry.signal || null,
      cause: ancestry.error ? String(ancestry.error.message || ancestry.error) : String(ancestry.stderr || '').trim(),
    });
  }
  let bytes;
  try { bytes = gitBlob(path.resolve(axmemRepoRoot), freeze.inventoryCommit + ':' + rel); }
  catch (e) { throw new EquivInfrastructureError('freeze-inventory-blob-read-failed', 'cannot read bound inventory blob from recorded AxMem commit', { commit: freeze.inventoryCommit, path: rel, cause: String(e && e.message || e) }); }
  const got = sha256(bytes);
  if (got.toLowerCase() !== String(freeze.inventorySha256).toLowerCase()) throw new EquivInfrastructureError('freeze-inventory-hash-mismatch', 'bound inventory sha256 mismatch', { commit: freeze.inventoryCommit, path: rel, expected: freeze.inventorySha256, actual: got });
  let inv;
  try { inv = JSON.parse(bytes.toString('utf8')); }
  catch (e) { throw new EquivInfrastructureError('freeze-inventory-json-invalid', 'bound inventory is invalid JSON', { commit: freeze.inventoryCommit, path: rel, cause: String(e && e.message || e) }); }
  if (settingsHooks.length !== freeze.hooks.length) throw new EquivInfrastructureError('freeze-settings-hook-mismatch', 'settings mirror hook count differs from freeze hooks');
  for (let i = 0; i < settingsHooks.length; i++) if (hookSemantics.hookIdentity(settingsHooks[i]) !== hookSemantics.hookIdentity(freeze.hooks[i])) throw new EquivInfrastructureError('freeze-settings-hook-mismatch', 'settings mirror hook identity/order differs from freeze hooks', { index: i });

  let validated;
  const liveRelativePath = safeRel(freeze.source.liveRelativePath);
  try { validated = freezeTool.validateInventory(inv, settingsHooks, liveRelativePath); }
  catch (e) { throw new EquivInfrastructureError('freeze-inventory-validation-failed', 'p2-freeze validateInventory rejected the pinned inventory', { commit: freeze.inventoryCommit, path: rel, freezeCode: e && e.code ? String(e.code) : null, cause: String(e && e.message || e), freezeDetail: e && e.detail ? e.detail : null }); }
  const invByIdentity = validated.inventoryHooks;
  const fields = ['disposition', 'files', 'implementation', 'notes', 'externalDependencies', 'businessExitCodes', 'runtimeHealthProbe'];
  for (const h of freeze.hooks) {
    const id = hookSemantics.hookIdentity(h);
    const invHook = invByIdentity.get(id);
    if (!invHook) throw new EquivInfrastructureError('freeze-inventory-hook-mismatch', 'freeze hook absent from bound inventory', { identity: id });
    const expected = normalizeInventoryDerivedHook(invHook);
    for (const field of fields) {
      if (JSON.stringify(stableObject(h[field] === undefined ? null : h[field])) !== JSON.stringify(stableObject(expected[field] === undefined ? null : expected[field]))) throw new EquivInfrastructureError('freeze-inventory-derived-mismatch', 'freeze hook inventory-derived field mismatch', { identity: id, field, expected: expected[field], actual: h[field] });
    }
  }

  const freezeFiles = new Map();
  const freezeFileCaseMap = new Map();
  for (const row of freeze.sourceFiles || []) {
    const filePath = safeRel(row.path);
    if (freezeFiles.has(filePath)) throw new EquivInfrastructureError('freeze-source-file-duplicate', 'freeze sourceFiles contains duplicate path', { path: filePath });
    const foldedPath = filePath.toLowerCase();
    if (freezeFileCaseMap.has(foldedPath)) {
      throw new EquivInfrastructureError('freeze-source-file-duplicate', 'freeze sourceFiles paths must be unique under case folding', {
        path: filePath, existingPath: freezeFileCaseMap.get(foldedPath), reason: 'path-case-collision',
      });
    }
    freezeFileCaseMap.set(foldedPath, filePath);
    freezeFiles.set(filePath, row);
  }
  if (freezeFiles.size !== validated.fileMap.size) throw new EquivInfrastructureError('freeze-source-files-inventory-mismatch', 'freeze sourceFiles path set differs from pinned inventory files[]', { freezeCount: freezeFiles.size, inventoryCount: validated.fileMap.size });
  const blobs = new Map();
  const liveRel = safeRel(freeze.source.liveRelativePath);
  for (const [filePath, invFile] of validated.fileMap.entries()) {
    const row = freezeFiles.get(filePath);
    if (!row) throw new EquivInfrastructureError('freeze-source-files-inventory-mismatch', 'freeze sourceFiles is missing pinned inventory file', { path: filePath });
    const actualDeps = Array.isArray(row.dependencies) ? row.dependencies.map(safeRel) : [];
    const expectedDeps = Array.isArray(invFile.dependencies) ? invFile.dependencies.slice() : [];
    if (JSON.stringify(actualDeps) !== JSON.stringify(expectedDeps)) throw new EquivInfrastructureError('freeze-source-dependencies-mismatch', 'freeze sourceFiles dependencies differ from pinned inventory', { path: filePath, expected: expectedDeps, actual: actualDeps });
    if (!sourceRepoRoot) throw new EquivInfrastructureError('freeze-source-repo-missing', 'source repository root is required for dependency closure verification');
    let blob;
    try { blob = gitBlob(sourceRepoRoot, freeze.source.commit + ':' + path.posix.join(liveRel, filePath)); }
    catch (e) { throw new EquivInfrastructureError('freeze-source-blob-read-failed', 'cannot read source blob while recomputing dependency closure', { path: filePath, commit: freeze.source.commit, cause: String(e && e.message || e) }); }
    blobs.set(filePath, blob);
  }
  try { freezeTool.verifyDependencyClosure({ fileMap: validated.fileMap, repoRoot: sourceRepoRoot, commit: freeze.source.commit, relLive: liveRel, blobs, generatedArtifacts: validated.generatedArtifacts }); }
  catch (e) { throw new EquivInfrastructureError('freeze-source-dependency-closure-invalid', 'p2-freeze dependency closure verification rejected the frozen source', { freezeCode: e && e.code ? String(e.code) : null, cause: String(e && e.message || e) }); }
  return { commit: freeze.inventoryCommit, path: rel, sha256: got, fileCount: validated.fileMap.size };
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

function preflightHookSources(freeze, h, sandboxSource, env, logicalId, timeoutMs, sourceRoot) {
  if (!Array.isArray(h.files) || h.files.length === 0) {
    throw new EquivInfrastructureError('hook source contract missing for ' + logicalId + ': runnable hook needs files[]');
  }
  const checked = [];
  const closure = sourceBindingForHook(freeze, h).files.map((f) => f.path);
  const closureSet = new Set(closure);
  const executable = new Set(h.files.map(safeRel));
  let entryRel = null, entrySourceType = null;
  try {
    const entryInfo = freezeTool.reviewedInnerCommandInfo(h.runtimeHealthProbe.innerCommand, logicalId);
    entryRel = freezeTool.entryRelativeToLiveRoot(entryInfo.entryPath, sourceRoot, logicalId);
    entrySourceType = entryInfo.interpreter === 'node' ? 'js' : 'shell';
  } catch (e) {
    throw new EquivInfrastructureError('hook-source-entry-binding-invalid', 'cannot bind reviewed hook entry for source preflight', { logicalId, cause: String(e && e.message || e), detail: e && e.detail ? e.detail : null });
  }
  const texts = new Map();
  for (const raw of closure) {
    const rel = safeRel(raw);
    const abs = path.join(sandboxSource, ...rel.split('/'));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new EquivInfrastructureError('hook source missing for ' + logicalId + ': ' + rel);
    }
    texts.set(rel, fs.readFileSync(abs, 'utf8'));
  }
  for (const [rel, text] of texts.entries()) {
    let analysis;
    try { analysis = freezeTool.analyzeDependencyReferences(rel, text); }
    catch (e) { throw new EquivInfrastructureError('hook-source-dependency-analysis', 'cannot classify hook dependency source type', { path: rel, cause: String(e && e.message || e) }); }
    for (const ref of analysis.references || []) for (const candidate of ref.candidates || []) if (closureSet.has(candidate)) executable.add(candidate);
  }
  for (const rel of closure) {
    const abs = path.join(sandboxSource, ...rel.split('/'));
    const scan = scanLiteralTmpSource(rel, texts.get(rel), { executableHint: executable.has(rel), sourceTypeHint: rel === entryRel ? entrySourceType : null });
    let rr = null;
    if (scan.sourceType === 'js') {
      rr = spawnSyncSandboxed(process.execPath, ['--check', abs], {
        cwd: sandboxSource, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
      });
    } else if (scan.sourceType === 'shell') {
      rr = spawnSyncSandboxed(findBash(), ['--noprofile', '--norc', '-n', abs], {
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
  assertSandboxTmpdir(env, cwd);
  const bash = findBash();
  const r = spawnSyncSandboxed(bash, ['--noprofile', '--norc', '-c', command], {
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

function runRuntimeHealthProbe({ freeze, h, logicalId, phase, c, group, sourceRoot, axmemRepoRoot,
  outerHome, outerSource, outerEnv, outerPayload, timeoutMs, contract }) {
  const initialOuter = stateDigest(outerHome);
  const probeHome = copySandbox(outerHome);
  try {
    const initialProbe = stateDigest(probeHome);
    if (initialOuter !== initialProbe) throw new EquivInfrastructureError('runtime health sandbox clone mismatch for ' + logicalId);
    const liveRel = safeRel(freeze.source.liveRelativePath);
    const probeSource = path.join(probeHome, ...liveRel.split('/'));
    const probeInput = prepareCaseInput(c && c.input ? c.input : {}, probeHome);
    const probeCase = Object.assign({}, c, { input: probeInput });
    const probeEnv = isolatedEnv(probeHome, probeInput.session_id, { sourceRoot, axmemRepoRoot });
    const probePayload = casePayload(group, probeCase, phase, probeHome);
    const sourceBinding = sourceBindingForHook(freeze, h);
    const outerCommand = String(h.command || '');
    const innerCommand = String(contract.runtimeHealthProbe.innerCommand || '');
    const rewrittenInner = rewriteSourceRoot(innerCommand, sourceRoot, probeSource);
    const sourceSyntaxChecked = preflightHookSources(freeze, h, probeSource, probeEnv, logicalId, timeoutMs, sourceRoot);
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

function runCase({ freeze, group, c, repoRoot, sourceRoot, axmemRepoRoot, defaultTimeoutMs }) {
  validateFreezeHooks(freeze);
  const inputBinding = fixtureInputBinding(c);
  const expectedSourceRoot = path.join(path.resolve(repoRoot), ...safeRel(freeze.source.liveRelativePath).split('/'));
  if (!sameSourcePath(sourceRoot, expectedSourceRoot)) throw new EquivInfrastructureError('source-root-mismatch', '--source-root must identify the frozen live source directory', { provided: path.resolve(sourceRoot), expected: expectedSourceRoot });
  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-equiv-case-'));
  try {
    const sandboxSource = materializeFreeze(freeze, repoRoot, sandboxHome, axmemRepoRoot);
    preflightMaterializedSources(freeze, sandboxSource);
    const preparedInput = prepareCaseInput(c && c.input ? c.input : {}, sandboxHome);
    const runCaseDef = Object.assign({}, c, { input: preparedInput });
    const before = walkFiles(sandboxHome);
    const env = isolatedEnv(sandboxHome, preparedInput.session_id, { sourceRoot, axmemRepoRoot });
    const hookResults = [];
    const stdout = [], stderr = [];
    let exitCode = 0, executed = 0;
    const phases = hookEventsForGroup(group);
    for (const phase of phases) {
      const payload = casePayload(group, runCaseDef, phase, sandboxHome);
      for (const h of freeze.hooks || []) {
        if (h.event !== phase || !matcherMatches(phase, h.matcher, payload)) continue;
        const logicalId = logicalHookId(h, phase);
        const matcher = h.matcher === undefined ? null : h.matcher;
        if (!RUN_DISPOSITIONS.has(h.disposition)) {
          hookResults.push({ logicalId, phase, matcher, disposition: h.disposition, status: 'skipped', reason: typeof h.notes === 'string' ? h.notes.trim() : '', externalDependencies: Array.isArray(h.externalDependencies) ? h.externalDependencies.slice() : [] });
          continue;
        }
        const command = rewriteSourceRoot(h.command, sourceRoot, sandboxSource);
        const timeoutMs = Number.isFinite(Number(h.timeout)) && Number(h.timeout) > 0 ? Number(h.timeout) * 1000 : defaultTimeoutMs;
        const contract = hookExitContract(h, logicalId);
        const runtimeHealth = runRuntimeHealthProbe({ freeze, h, logicalId, phase, c, group, sourceRoot, axmemRepoRoot, outerHome: sandboxHome, outerSource: sandboxSource, outerEnv: env, outerPayload: payload, timeoutMs, contract });
        const sourceSyntaxChecked = preflightHookSources(freeze, h, sandboxSource, env, logicalId, timeoutMs, sourceRoot);
        const rr = runHook(command, payload, env, sandboxHome, timeoutMs, contract.businessExitCodes);
        if (rr.infrastructureFailure) throw new EquivInfrastructureError('hook-infrastructure-failure', 'hook infrastructure failure for ' + logicalId + ': ' + rr.infrastructureReason, { logicalId, phase, disposition: h.disposition, exitCode: rr.exitCode, reason: rr.infrastructureReason, businessExitCodes: contract.businessExitCodes, runtimeHealth });
        executed++;
        hookResults.push({ logicalId, phase, matcher, disposition: h.disposition, status: 'ran', exitCode: rr.exitCode, outcome: rr.outcome, businessExitCodes: contract.businessExitCodes, runtimeHealth, sourceSyntaxChecked });
        if (rr.stdout) stdout.push('[' + logicalId + ']\n' + rr.stdout);
        if (rr.stderr) stderr.push('[' + logicalId + ']\n' + rr.stderr);
        if (exitCode === 0 && rr.exitCode !== 0) exitCode = rr.exitCode;
      }
    }
    if (hookResults.length === 0) throw new EquivInfrastructureError('fixture-no-matching-hooks', 'no matching hooks for fixture case ' + c.id + ' (' + group.event + ')', { caseId: c.id, event: group.event });
    const prefixes = [sandboxHome, sandboxSource, sourceRoot];
    const after = walkFiles(sandboxHome);
    const result = { id: c.id, event: group.event, inputCanonical: inputBinding.inputCanonical, inputSha256: inputBinding.inputSha256, exitCode, stdout: normalizeRuntimeText(stdout.join(''), prefixes), stderr: normalizeRuntimeText(stderr.join(''), prefixes), stateTree: diffState(before, after, prefixes), hookResults, executedHooks: executed, environmentScrubbedKeys: (env[ENV_SCRUBBED_KEYS] || []).slice() };
    Object.defineProperty(result, 'sandboxRoot', { value: posix(sandboxHome), enumerable: false });
    return result;
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
  const axmemRepoRoot = opts.axmemRepoRoot ? path.resolve(opts.axmemRepoRoot) : null;
  validateFreezeHooks(freeze);
  const expectedSourceRoot = path.join(repoRoot, ...safeRel(freeze.source.liveRelativePath).split('/'));
  if (!sameSourcePath(sourceRoot, expectedSourceRoot)) throw new EquivInfrastructureError('source-root-mismatch', '--source-root must identify the frozen live source directory', { provided: sourceRoot, expected: expectedSourceRoot });
  const interpreterProvenance = { bash: bashInterpreterProvenance() };
  const defaultTimeoutMs = Number.isFinite(Number(opts.defaultTimeoutMs)) && Number(opts.defaultTimeoutMs) > 0 ? Number(opts.defaultTimeoutMs) : 60000;
  const cases = [];
  for (const group of fixture.events) for (const c of group.cases) {
    const result = runCase({ freeze, group, c: Object.assign({}, c, { id: c.id.trim() }), repoRoot, sourceRoot, axmemRepoRoot, defaultTimeoutMs });
    cases.push(Object.assign({ sandboxRoot: result.sandboxRoot }, result));
  }
  const report = {
    schema: 'axmem-equiv-report/v1', generatedAt: new Date().toISOString(),
    source: { commit: freeze.source.commit, treeOid: freeze.source.treeOid, sourceFiles: (freeze.sourceFiles || []).map((f) => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => a.path.localeCompare(b.path)), sourceFilesSha256: hashObject((freeze.sourceFiles || []).map((f) => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => a.path.localeCompare(b.path))) },
    interpreterProvenance,
    normalization: { pathPrefixes: cases.map((c) => c.sandboxRoot) }, fixtureCoverage: coverage, cases,
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
  materializeFreeze, rewriteSourceRoot, sourceRootResidual, sameSourcePath, prepareCaseInput, isolatedEnv, bindingEnv,
  scanLiteralTmpSource, preflightMaterializedSources, assertSandboxTmpdir, validateFreezeHooks, validateInventoryBinding, diffState, logicalHookId, hookExitContract, preflightHookSources,
  runHook, runRuntimeHealthProbe, validateFixture, runCase, runFreezeReport, stateDigest, hashObject, sourceBindingForHook,
};
