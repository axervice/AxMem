#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const acorn = require('../guards/vendor/acorn.js');
const bashAst = require('./private/p2-bash-ast/adapter.cjs');
const hookSemantics = require('./p2-hook-semantics.cjs');

const DISPOSITIONS = hookSemantics.DISPOSITIONS;
const EXTERNAL_KINDS = new Set(['file', 'repo', 'command', 'network']);

class FreezeError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'FreezeError';
    this.code = code;
    this.detail = detail || null;
  }
}

function git(cwd, args, opts = {}) {
  try {
    return cp.execFileSync('git', ['-C', cwd].concat(args), {
      encoding: opts.binary ? null : 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = String((e.stderr && e.stderr.toString()) || e.message || e).trim();
    throw new FreezeError('git-failed', 'git ' + args.join(' ') + ' failed: ' + err);
  }
}

function posix(p) { return String(p).replace(/\\/g, '/'); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function inventorySnapshotCommit(repoRoot, relPath, bytes) {
  const head = String(git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  try {
    const committed = git(repoRoot, ['show', head + ':' + relPath], { binary: true });
    if (Buffer.isBuffer(committed) && committed.equals(bytes)) return head;
  } catch {}
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-p2-inventory-index-'));
  const indexPath = path.join(temp, 'index');
  const env = Object.assign({}, process.env, {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: 'AxMem Freeze Snapshot',
    GIT_AUTHOR_EMAIL: 'axmem-freeze@local.invalid',
    GIT_COMMITTER_NAME: 'AxMem Freeze Snapshot',
    GIT_COMMITTER_EMAIL: 'axmem-freeze@local.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  });
  const rawGit = (args, opts = {}) => cp.execFileSync('git', ['-C', repoRoot].concat(args), {
    env, encoding: opts.binary ? null : 'utf8', input: opts.input, stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    rawGit(['read-tree', head]);
    const blobOid = String(rawGit(['hash-object', '-w', '--stdin'], { input: bytes })).trim();
    rawGit(['update-index', '--add', '--cacheinfo', '100644,' + blobOid + ',' + relPath]);
    const treeOid = String(rawGit(['write-tree'])).trim();
    return String(rawGit(['commit-tree', treeOid, '-p', head], { input: 'AxMem inventory buildManifest snapshot\n' })).trim();
  } catch (e) {
    const err = String((e.stderr && e.stderr.toString()) || e.message || e).trim();
    throw new FreezeError('inventory-snapshot-commit', 'cannot create detached inventory snapshot commit: ' + err);
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  }
}

function safeRelativeFile(p) {
  if (typeof p !== 'string' || !p.trim()) throw new FreezeError('bad-file-path', 'inventory file path must be a non-empty string');
  const n = posix(p.trim()).replace(/^\.\//, '');
  if (path.posix.isAbsolute(n) || n === '..' || n.startsWith('../') || n.includes('/../')) {
    throw new FreezeError('bad-file-path', 'inventory file path escapes live root: ' + p);
  }
  return n;
}

function hookSemanticsOptions() {
  return {
    unsupportedMatcher: 'reject',
    fail(code, message, detail) {
      if (/^hook-matcher-/.test(String(code || ''))) {
        throw new FreezeError('bad-inventory', message, Object.assign({ matcherErrorCode: code }, detail || {}));
      }
      throw new FreezeError(code, message, detail);
    },
  };
}

function flattenHooks(settings) {
  return hookSemantics.flattenHooks(settings, hookSemanticsOptions());
}

function shellVariableRoots(fromPath, text) {
  const roots = new Map();
  // Legacy PMM guards conventionally use G for the live .claude root.
  roots.set('G', '');
  const fromDir = path.posix.dirname(fromPath);
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const m = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const name = m[1], rhs = m[2];
    if (/\$\{?HOME\}?\/\.claude(?:["']|$)|\$\{?CLAUDE_CONFIG_DIR\}?/.test(rhs)) {
      roots.set(name, '');
      continue;
    }
    if (/BASH_SOURCE\[0\]|\$0/.test(rhs) && /dirname/.test(rhs)) {
      let base = fromDir;
      const parents = (rhs.match(/\/\.\./g) || []).length;
      for (let i = 0; i < parents; i++) base = path.posix.dirname(base);
      roots.set(name, base === '.' ? '' : base);
    }
  }
  return roots;
}

function nodeResolutionCandidates(fromPath, raw) {
  const fromDir = path.posix.dirname(fromPath);
  const base = safeRelativeFile(path.posix.normalize(path.posix.join(fromDir, posix(raw))));
  if (path.posix.extname(base)) return [base];
  return [
    base,
    base + '.js',
    base + '.cjs',
    base + '.json',
    path.posix.join(base, 'index.js'),
    path.posix.join(base, 'index.cjs'),
    path.posix.join(base, 'index.json'),
  ].map(safeRelativeFile);
}

function shellResolution(fromPath, token, roots) {
  const raw = posix(String(token || '').trim());
  if (!raw) return { candidates: [], unresolved: 'empty shell dependency token' };
  const fromDir = path.posix.dirname(fromPath);
  let expanded = raw;
  const vm = expanded.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\/(.*)$/);
  if (vm) {
    if (!roots.has(vm[1])) return { candidates: [], unresolved: 'unknown shell root variable ' + vm[1] };
    expanded = path.posix.join(roots.get(vm[1]), vm[2]);
  } else if (/^\$\(dirname/.test(expanded)) {
    const suffix = expanded.replace(/^\$\(dirname[^)]*\)\/?/, '');
    expanded = path.posix.join(fromDir, suffix);
  } else if (expanded.startsWith('./') || expanded.startsWith('../')) {
    expanded = path.posix.join(fromDir, expanded);
  } else if (expanded.includes('$')) {
    return { candidates: [], unresolved: 'dynamic shell dependency expression' };
  } else {
    // A bare shell path is cwd-sensitive, so do not guess a source-relative edge.
    return { candidates: [], unresolved: 'cwd-relative shell dependency has no known root' };
  }
  if (expanded.includes('$')) return { candidates: [], unresolved: 'dynamic shell dependency expression' };
  try { return { candidates: [safeRelativeFile(path.posix.normalize(expanded))], unresolved: null }; }
  catch { return { candidates: [], unresolved: 'shell dependency escapes live root' }; }
}

function staticJsString(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked === null ? q.value.raw : q.value.cooked).join('');
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const a = staticJsString(node.left), b = staticJsString(node.right);
    return a === null || b === null ? null : a + b;
  }
  return null;
}

function dirnameJoinSpec(node) {
  if (!node || node.type !== 'CallExpression' || !node.callee || node.callee.type !== 'MemberExpression') return null;
  const obj = node.callee.object, prop = node.callee.property;
  const isJoin = obj && obj.type === 'Identifier' && obj.name === 'path'
    && ((node.callee.computed && prop.type === 'Literal' && prop.value === 'join')
      || (!node.callee.computed && prop.type === 'Identifier' && prop.name === 'join'));
  if (!isJoin || node.arguments.length === 0 || node.arguments[0].type !== 'Identifier' || node.arguments[0].name !== '__dirname') return null;
  const parts = [];
  for (const arg of node.arguments.slice(1)) {
    const s = staticJsString(arg);
    if (s === null) return { dynamic: true, spec: null };
    parts.push(s);
  }
  return { dynamic: false, spec: './' + parts.join('/') };
}

function walkAst(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') fn(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
    if (Array.isArray(v)) for (const x of v) walkAst(x, fn);
    else if (v && typeof v === 'object') walkAst(v, fn);
  }
}

function astPatternBindsName(node, name) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Identifier') return node.name === name;
  if (node.type === 'RestElement') return astPatternBindsName(node.argument, name);
  if (node.type === 'AssignmentPattern') return astPatternBindsName(node.left, name);
  if (node.type === 'ArrayPattern') return node.elements.some((x) => astPatternBindsName(x, name));
  if (node.type === 'ObjectPattern') return node.properties.some((p) => p && (
    p.type === 'RestElement' ? astPatternBindsName(p.argument, name) : astPatternBindsName(p.value, name)
  ));
  return false;
}

function astPreservesNativeFilename(ast) {
  let safe = true;
  walkAst(ast, (node) => {
    if (!safe) return;
    if (node.type === 'AssignmentExpression' && astPatternBindsName(node.left, '__filename')) safe = false;
    else if (node.type === 'UpdateExpression' && astPatternBindsName(node.argument, '__filename')) safe = false;
    else if (node.type === 'VariableDeclarator' && astPatternBindsName(node.id, '__filename')) safe = false;
    else if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')
      && ((node.id && node.id.name === '__filename') || node.params.some((p) => astPatternBindsName(p, '__filename')))) safe = false;
    else if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.id && node.id.name === '__filename') safe = false;
    else if (node.type === 'CatchClause' && astPatternBindsName(node.param, '__filename')) safe = false;
    else if ((node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier')
      && node.local && node.local.name === '__filename') safe = false;
  });
  return safe;
}

function parseJsAst(fromPath, text) {
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
  try { return acorn.parse(text, Object.assign({}, opts, { sourceType: 'script' })); }
  catch (scriptErr) {
    try { return acorn.parse(text, Object.assign({}, opts, { sourceType: 'module' })); }
    catch (moduleErr) {
      throw new FreezeError('dependency-js-parse-failed', fromPath + ' cannot be parsed for dependency closure: ' + moduleErr.message);
    }
  }
}

function analyzeDependencyReferences(fromPath, text) {
  const refs = [];
  const sourceBindings = [];
  const unresolved = [];
  const seen = new Set();
  const addRef = (expression, candidates, kind) => {
    const clean = [...new Set((candidates || []).filter((x) => x && x !== fromPath))];
    if (!clean.length) return;
    const key = kind + '\u0000' + expression + '\u0000' + clean.join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ expression, kind, candidates: clean });
  };
  const addSourceBinding = (expression, kind) => {
    const key = kind + '\u0000' + expression + '\u0000' + fromPath;
    if (seen.has(key)) return;
    seen.add(key);
    sourceBindings.push({ expression, kind, target: fromPath });
  };
  const addUnresolved = (expression, reason, kind) => {
    const key = kind + '\u0000' + expression + '\u0000' + reason;
    if (seen.has(key)) return;
    seen.add(key);
    unresolved.push({ expression, reason, kind });
  };

  const ext = path.posix.extname(fromPath).toLowerCase();
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
    const src = String(text || '');
    const ast = parseJsAst(fromPath, src);
    const nativeFilenameSafe = ext === '.cjs' && astPreservesNativeFilename(ast);
    walkAst(ast, (node) => {
      const expr = typeof node.start === 'number' && typeof node.end === 'number' ? src.slice(node.start, node.end) : '<unknown>';
      if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier' && node.callee.name === 'require') {
        if (node.arguments.length !== 1) return addUnresolved(expr, 'require() must have exactly one dependency argument', 'node-require');
        const arg = node.arguments[0];
        if (arg && arg.type === 'Identifier' && arg.name === '__filename') {
          if (nativeFilenameSafe) addSourceBinding(expr, 'node-self');
          else addUnresolved(expr, '__filename source identity is not provable (non-CJS or identifier is assigned/shadowed)', 'node-require');
          return;
        }
        const literal = staticJsString(arg);
        if (literal !== null) {
          if (literal.startsWith('.')) addRef(expr, nodeResolutionCandidates(fromPath, literal), 'node-require');
          return;
        }
        const joined = dirnameJoinSpec(arg);
        if (joined && !joined.dynamic) return addRef(expr, nodeResolutionCandidates(fromPath, joined.spec), 'node-require');
        return addUnresolved(expr, joined ? 'dynamic path.join(__dirname, ...) dependency' : 'dynamic require() dependency', 'node-require');
      }
      if (node.type === 'ImportExpression') {
        const literal = staticJsString(node.source);
        if (literal !== null) {
          if (literal.startsWith('.')) addRef(expr, nodeResolutionCandidates(fromPath, literal), 'node-import');
        } else addUnresolved(expr, 'dynamic import() dependency', 'node-import');
        return;
      }
      if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
        const literal = staticJsString(node.source);
        if (literal !== null && literal.startsWith('.')) addRef(expr, nodeResolutionCandidates(fromPath, literal), 'node-import');
      }
    });
    return { references: refs, sourceBindings, unresolved };
  }

  const shellText = String(text || '');
  const roots = shellVariableRoots(fromPath, shellText);
  let m;
  for (const rawLine of shellText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let dirnameExpression = null;
    const quotedDirname = line.match(/(?:^|[;&|()]\s*)(source|\.)\s+"(\$\(dirname\s+"\$([A-Za-z_][A-Za-z0-9_]*|0)"\)\/[^"]+)"/);
    const unquotedDirname = line.match(/(?:^|[;&|()]\s*)(source|\.)\s+(\$\(dirname\s+["']?\$([A-Za-z_][A-Za-z0-9_]*|0)["']?\)\/[^\s;&|]+)/);
    const dirnameMatch = quotedDirname || unquotedDirname;
    if (dirnameMatch) {
      dirnameExpression = dirnameMatch[2];
      addUnresolved(dirnameExpression, 'dirname-based shell dependency requires explicit proof of the referenced script identity/execution entry', 'shell-relative-entry');
    }

    const cmd = /(?:^|[;&|()]\s*)(source|\.|bash|node)\s+["']?([^"'\s;&|)]+)["']?/g;
    while ((m = cmd.exec(line))) {
      const token = m[2];
      if (token === '$0' && m[1] === 'bash') {
        addUnresolved(token, '$0 is caller-dependent unless execution-entry identity is proven', 'shell-bash');
        continue;
      }
      const vm = token.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
      if (vm && m[1] === 'bash') {
        addUnresolved(token, 'shell variable target requires syntax/control-flow proof; automatic shell self-binding is disabled', 'shell-bash');
        continue;
      }
      if (/^\$\(dirname/.test(token)) {
        if (!dirnameExpression) addUnresolved(token, 'unparsed dirname-based shell dependency expression', 'shell-' + m[1]);
        continue;
      }
      if ((m[1] === 'bash' || m[1] === 'node') && !/[\/$]/.test(token) && !token.startsWith('.')) continue;
      const rr = shellResolution(fromPath, token, roots);
      if (rr.unresolved) addUnresolved(token, rr.unresolved, 'shell-' + m[1]);
      else addRef(token, rr.candidates, 'shell-' + m[1]);
    }
  }
  return { references: refs, sourceBindings, unresolved };
}

function lineEvidenceAtOffset(buf, offset) {
  const source = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    throw new FreezeError('generated-parser-source-binding', 'line evidence offset is outside generator source');
  }
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === 0x0a) line++;
  let start = offset;
  while (start > 0 && source[start - 1] !== 0x0a) start--;
  let end = offset;
  while (end < source.length && source[end] !== 0x0a) end++;
  if (end > start && source[end - 1] === 0x0d) end--;
  const bytes = source.subarray(start, end);
  return { line, bytes, text: bytes.toString('utf8') };
}

function parseGeneratedShellAst(rel, blob) {
  try {
    return bashAst.parseShellAst(blob);
  } catch (e) {
    const code = e && e.code ? String(e.code) : 'generated-shell-unsupported';
    const message = rel + ' parser: ' + String((e && e.message) || e);
    if (code === 'unsupported-heredoc') {
      throw new FreezeError('generated-heredoc-not-literal', message);
    }
    if (code === 'parse-error') {
      if (/here-document|heredoc/i.test(message)) throw new FreezeError('generated-heredoc-ambiguous', message);
      throw new FreezeError('generated-shell-unsupported', message);
    }
    if (code.startsWith('generated-parser-')) throw new FreezeError(code, message);
    throw new FreezeError('generated-shell-unsupported', message);
  }
}

function sameSpan(a, b) {
  return !!a && !!b && a.start === b.start && a.end === b.end;
}

function inspectLiteralGeneratedArtifact(generatorPath, generatorBlob, spec) {
  const rel = safeRelativeFile(generatorPath);
  if (!spec || typeof spec !== 'object') throw new FreezeError('generated-artifact-bad-spec', rel + ' generated artifact spec must be an object');
  const variable = String(spec.variable || '').trim();
  const marker = String(spec.marker || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new FreezeError('generated-artifact-bad-spec', rel + ' generated artifact variable is invalid');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(marker)) throw new FreezeError('generated-artifact-bad-spec', rel + ' generated artifact marker is invalid');

  const blob = Buffer.isBuffer(generatorBlob) ? generatorBlob : Buffer.from(generatorBlob || '');
  const ast = parseGeneratedShellAst(rel, blob);
  if (!bashAst.hasNoUnsupportedCommandWords(ast)) {
    const detail = ast.unsupportedCommands.map((x) => x.source + '@' + x.start).join(', ');
    throw new FreezeError('generated-shell-unsupported', rel + ' has unsupported/dynamic command words: ' + detail);
  }

  const matching = ast.heredocs.filter((h) => h.marker === marker);
  if (matching.length !== 1) {
    throw new FreezeError('generated-heredoc-ambiguous', rel + ' marker ' + marker + ' must have exactly one AST heredoc; found ' + matching.length);
  }
  const target = matching[0];

  const associated = [];
  for (const stmt of ast.heredocStatements) {
    for (let i = 0; i < stmt.redirs.length; i++) {
      const r = stmt.redirs[i];
      if (r.hdoc && r.hdoc.marker === marker &&
          sameSpan(r.hdoc.word, target.word) && sameSpan(r.hdoc.body, target.body) && sameSpan(r.hdoc.closing, target.closing)) {
        associated.push({ stmt, redirIndex: i, redir: r });
      }
    }
  }
  if (associated.length !== 1) {
    throw new FreezeError('generated-heredoc-ambiguous', rel + ' marker ' + marker + ' must bind to exactly one AST statement; found ' + associated.length);
  }

  const owner = associated[0].stmt;
  const exactShape =
    owner.simpleCall === true &&
    owner.commandStatic === true &&
    owner.commandValue === 'cat' &&
    owner.argCount === 1 &&
    owner.assignCount === 0 &&
    owner.redirs.length === 2 &&
    owner.redirs[0].op === '>' &&
    owner.redirs[0].fd === '' &&
    owner.redirs[0].hdoc === null &&
    owner.redirs[0].exactQuotedParam === true &&
    owner.redirs[0].paramName === variable &&
    owner.redirs[1].op === '<<' &&
    owner.redirs[1].fd === '' &&
    owner.redirs[1].hdoc !== null &&
    owner.redirs[1].hdoc.marker === marker &&
    sameSpan(owner.redirs[1].hdoc.word, target.word) &&
    sameSpan(owner.redirs[1].hdoc.body, target.body) &&
    sameSpan(owner.redirs[1].hdoc.closing, target.closing);
  if (!exactShape) {
    const ev = lineEvidenceAtOffset(blob, target.word.start);
    throw new FreezeError('generated-heredoc-not-literal',
      rel + ':' + ev.line + ' target heredoc must be owned by exactly: cat > "$' + variable + '" <<\'' + marker + '\'');
  }

  const calls = ast.calls.filter((c) => c.exactQuotedParam === true && c.paramName === variable);
  if (calls.length !== 1) {
    throw new FreezeError('generated-call-ambiguous',
      rel + ' generated variable $' + variable + ' must have exactly one AST node "$' + variable + '" invocation; found ' + calls.length);
  }
  const call = calls[0];

  const body = Buffer.from(blob.subarray(target.body.start, target.body.end));
  const openerEvidence = lineEvidenceAtOffset(blob, target.word.start);
  const closingEvidence = lineEvidenceAtOffset(blob, target.closing.start);
  const callEvidence = lineEvidenceAtOffset(blob, call.start);
  const sourceCandidatePath = path.posix.join(path.posix.dirname(rel), '.generated-' + marker.toLowerCase() + '.cjs');
  const dependencyAnalysis = analyzeDependencyReferences(sourceCandidatePath, body.toString('utf8'));

  return {
    generatorPath: rel,
    generatorSha256: sha256(blob),
    heredoc: {
      variable,
      marker,
      startLine: openerEvidence.line,
      endLine: closingEvidence.line,
      bodyBytes: body.length,
      bodySha256: sha256(body),
      bodyEndsWithLf: body.length > 0 && body[body.length - 1] === 0x0a,
    },
    call: {
      line: callEvidence.line,
      expression: callEvidence.text,
      lineSha256: sha256(callEvidence.bytes),
    },
    body,
    candidateSourceGraph: {
      sourceCandidatePath,
      references: dependencyAnalysis.references,
      sourceBindings: dependencyAnalysis.sourceBindings || [],
      unresolved: dependencyAnalysis.unresolved,
    },
  };
}
function gitTreeEntry(repoRoot, commit, repoRel) {
  const out = String(git(repoRoot, ['ls-tree', commit, '--', repoRel])).trim();
  if (!out) return null;
  const m = out.match(/^(\d+)\s+(\S+)\s+([0-9a-f]+)\t(.+)$/);
  if (!m) throw new FreezeError('generated-generator-tree-entry', 'cannot parse git tree entry for ' + repoRel);
  return { mode: m[1], type: m[2], oid: m[3], path: posix(m[4]) };
}

function verifyGeneratedArtifactEvidence({ record, fileMap, repoRoot, commit, relLive, blobs }) {
  if (!record || record.version !== 1 || typeof record.id !== 'string' || !record.id.trim()) {
    throw new FreezeError('generated-artifact-bad-record', 'generated artifact record requires version=1 and non-empty id');
  }
  const generatorPath = safeRelativeFile(record.generatorPath);
  const repoRel = posix(path.posix.join(relLive, generatorPath));
  const entry = gitTreeEntry(repoRoot, commit, repoRel);
  if (!entry || entry.type !== 'blob') throw new FreezeError('generated-generator-missing', record.id + ' generator is not a frozen git blob: ' + generatorPath);
  if (entry.mode === '120000') throw new FreezeError('generated-generator-symlink', record.id + ' generator path is a symlink and is not admissible: ' + generatorPath);
  if (entry.mode !== '100644' && entry.mode !== '100755') throw new FreezeError('generated-generator-mode', record.id + ' generator has unsupported git mode ' + entry.mode);
  if (!fileMap || !fileMap.has(generatorPath) || !blobs || !blobs.has(generatorPath)) {
    throw new FreezeError('generated-generator-not-in-scope', record.id + ' generator must be present in frozen source scope: ' + generatorPath);
  }
  const blob = blobs.get(generatorPath);
  const frozenBlob = git(repoRoot, ['show', commit + ':' + repoRel], { binary: true });
  if (!Buffer.isBuffer(blob) || !blob.equals(frozenBlob)) {
    throw new FreezeError('generated-generator-blob-mismatch', record.id + ' generator bytes do not match frozen commit blob');
  }
  if (record.generatorSha256 !== sha256(blob)) {
    throw new FreezeError('generated-generator-hash-mismatch', record.id + ' generator sha256 does not match frozen blob');
  }
  if (!record.heredoc || !record.call) throw new FreezeError('generated-artifact-bad-record', record.id + ' requires heredoc and call anchors');
  const actual = inspectLiteralGeneratedArtifact(generatorPath, blob, {
    variable: record.heredoc.variable,
    marker: record.heredoc.marker,
  });
  for (const k of ['startLine', 'endLine', 'bodyBytes', 'bodySha256']) {
    if (record.heredoc[k] !== actual.heredoc[k]) {
      throw new FreezeError('generated-heredoc-evidence-mismatch', record.id + ' heredoc ' + k + ' mismatch');
    }
  }
  if (record.heredoc.bodyEndsWithLf !== true || actual.heredoc.bodyEndsWithLf !== true) {
    throw new FreezeError('generated-heredoc-newline', record.id + ' generated literal body must end with LF exactly as frozen');
  }
  for (const k of ['line', 'expression', 'lineSha256']) {
    if (record.call[k] !== actual.call[k]) throw new FreezeError('generated-call-evidence-mismatch', record.id + ' call anchor ' + k + ' mismatch');
  }

  const tracked = (dep) => {
    const depRepoRel = posix(path.posix.join(relLive, dep));
    const e = gitTreeEntry(repoRoot, commit, depRepoRel);
    return !!e && e.type === 'blob' && e.mode !== '120000';
  };
  const transitiveCandidates = [];
  for (const ref of actual.candidateSourceGraph.references) {
    const dep = ref.candidates.find(tracked);
    if (!dep) {
      throw new FreezeError('generated-dependency-unresolved', record.id + ' generated content has unresolved static dependency ' + ref.expression + '; candidates=' + ref.candidates.join(','));
    }
    if (!fileMap.has(dep) || !blobs.has(dep)) {
      throw new FreezeError('generated-dependency-out-of-scope', record.id + ' generated content dependency is absent from frozen source scope: ' + dep);
    }
    transitiveCandidates.push({ expression: ref.expression, dependency: dep });
  }

  return {
    id: record.id.trim(),
    status: 'artifact-verified',
    executionClosed: false,
    generatorPath,
    generatorSha256: actual.generatorSha256,
    heredoc: actual.heredoc,
    call: actual.call,
    candidateSourceGraph: {
      sourceCandidatePath: actual.candidateSourceGraph.sourceCandidatePath,
      transitiveCandidates,
      unresolved: actual.candidateSourceGraph.unresolved,
      sourceBindings: actual.candidateSourceGraph.sourceBindings,
    },
    executionBlocker: 'artifact evidence proves frozen source -> literal generated bytes only; call target/arguments/execution condition and runner materialization/startup evidence are not proven',
  };
}

function detectLiteralDependencies(fromPath, text) {
  const out = new Set();
  for (const r of analyzeDependencyReferences(fromPath, text).references) for (const c of r.candidates) out.add(c);
  return [...out].sort();
}

function verifyDependencyClosure({ fileMap, repoRoot, commit, relLive, blobs, generatedArtifacts = [] }) {
  const generatedEvidence = [];
  for (const record of generatedArtifacts || []) {
    generatedEvidence.push(verifyGeneratedArtifactEvidence({ record, fileMap, repoRoot, commit, relLive, blobs }));
  }
  const tracked = (dep) => {
    const repoRel = posix(path.posix.join(relLive, dep));
    try { return String(git(repoRoot, ['cat-file', '-t', commit + ':' + repoRel])).trim() === 'blob'; }
    catch { return false; }
  };
  for (const f of [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const blob = blobs.get(f.path);
    if (!blob) throw new FreezeError('dependency-scan-missing-blob', 'dependency scan has no source blob for ' + f.path);
    const analysis = analyzeDependencyReferences(f.path, blob.toString('utf8'));
    for (const binding of analysis.sourceBindings || []) {
      if (binding.target !== f.path || !tracked(binding.target) || !fileMap.has(binding.target) || !blobs.has(binding.target)) {
        throw new FreezeError('dependency-source-binding-invalid', f.path + ' has invalid source identity binding for ' + binding.expression);
      }
    }
    for (const ref of analysis.references) {
      const dep = ref.candidates.find(tracked);
      if (!dep) {
        throw new FreezeError('dependency-unresolved', f.path + ' dependency cannot be resolved from ' + ref.expression + '; candidates=' + ref.candidates.join(','));
      }
      if (!fileMap.has(dep)) throw new FreezeError('dependency-closure-missing', f.path + ' references tracked local dependency absent from inventory: ' + dep);
      if (!f.dependencies.includes(dep)) throw new FreezeError('dependency-edge-missing', f.path + ' local dependency is not declared in dependencies[]: ' + dep);
    }
    const reviewed = new Map((f.unresolvedDependencies || []).map((x) => [x.expression, x]));
    for (const u of analysis.unresolved) {
      const review = reviewed.get(u.expression);
      if (!review) {
        throw new FreezeError('dependency-unresolved-dynamic', f.path + ' has unresolved dynamic dependency ' + u.expression + ' (' + u.reason + '); add exact unresolvedDependencies[] expression + dependencies[] + reason');
      }
      if (!Array.isArray(review.dependencies) || review.dependencies.length === 0) {
        throw new FreezeError('dependency-review-empty', f.path + ' dynamic dependency review cannot close ' + u.expression + ' with an empty dependency list');
      }
      for (const dep of review.dependencies) {
        if (!tracked(dep)) throw new FreezeError('dependency-review-target-missing', f.path + ' manual dependency review names a non-blob/nonexistent target: ' + dep);
        if (!fileMap.has(dep)) throw new FreezeError('dependency-closure-missing', f.path + ' manual dynamic dependency absent from inventory: ' + dep);
        if (!f.dependencies.includes(dep)) throw new FreezeError('dependency-edge-missing', f.path + ' manual dynamic dependency is not declared in dependencies[]: ' + dep);
      }
    }
    for (const expression of reviewed.keys()) {
      if (!analysis.unresolved.some((u) => u.expression === expression)) {
        throw new FreezeError('dependency-review-stale', f.path + ' declares unresolved dependency review not observed by scanner: ' + expression);
      }
    }
  }
  return { generatedArtifacts: generatedEvidence };
}

function hookIdentity(h) {
  return hookSemantics.hookIdentity(h);
}

function hookIdentitySha256(rows) {
  return sha256(Buffer.from(rows.map((h) => hookIdentity(h)).join('\n'), 'utf8'));
}

function normalizeExternalDependencies(inv) {
  const rows = inv.externalDependencies === undefined ? [] : inv.externalDependencies;
  if (!Array.isArray(rows)) throw new FreezeError('bad-inventory', 'externalDependencies must be an array');
  const out = new Map();
  for (const x of rows) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id.trim()) throw new FreezeError('bad-inventory', 'external dependency id must be a non-empty string');
    const id = x.id.trim();
    if (out.has(id)) throw new FreezeError('bad-inventory', 'duplicate external dependency id: ' + id);
    if (!EXTERNAL_KINDS.has(x.kind)) throw new FreezeError('bad-inventory', 'invalid external dependency kind for ' + id);
    const row = Object.assign({}, x, { id });
    if (x.kind === 'file' || x.kind === 'repo') row.path = safeRelativeFile(x.path);
    if (x.kind === 'command' && (typeof x.command !== 'string' || !x.command.trim())) throw new FreezeError('bad-inventory', 'command external dependency needs command: ' + id);
    if (typeof x.notes !== 'string' || !x.notes.trim()) throw new FreezeError('bad-inventory', 'external dependency needs non-empty notes: ' + id);
    out.set(id, row);
  }
  return out;
}

function normalizeGeneratedArtifacts(inv) {
  const rows = inv.generatedArtifacts === undefined ? [] : inv.generatedArtifacts;
  if (!Array.isArray(rows)) throw new FreezeError('bad-inventory', 'generatedArtifacts must be an array');
  const out = [];
  const ids = new Set();
  const anchors = new Map();
  const hex64 = (value, label) => {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
      throw new FreezeError('generated-artifact-bad-record', label + ' must be a 64-hex sha256');
    }
    return value.toLowerCase();
  };
  const posInt = (value, label, allowZero = false) => {
    if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new FreezeError('generated-artifact-bad-record', label + ' must be an integer ' + (allowZero ? '>= 0' : '>= 1'));
    }
    return value;
  };
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 || typeof raw.id !== 'string' || !raw.id.trim()) {
      throw new FreezeError('generated-artifact-bad-record', 'generated artifact record requires object, version=1 and non-empty id');
    }
    const id = raw.id.trim();
    if (ids.has(id)) throw new FreezeError('generated-artifact-duplicate-id', 'duplicate generated artifact id: ' + id);
    ids.add(id);
    const generatorPath = safeRelativeFile(raw.generatorPath);
    if (!raw.heredoc || typeof raw.heredoc !== 'object' || Array.isArray(raw.heredoc)
        || !raw.call || typeof raw.call !== 'object' || Array.isArray(raw.call)) {
      throw new FreezeError('generated-artifact-bad-record', id + ' requires object heredoc and call anchors');
    }
    const variable = typeof raw.heredoc.variable === 'string' ? raw.heredoc.variable.trim() : '';
    const marker = typeof raw.heredoc.marker === 'string' ? raw.heredoc.marker.trim() : '';
    if (!variable || !marker) throw new FreezeError('generated-artifact-bad-record', id + ' heredoc variable/marker must be non-empty strings');
    if (typeof raw.call.expression !== 'string' || !raw.call.expression.length) {
      throw new FreezeError('generated-artifact-bad-record', id + ' call.expression must be a non-empty string');
    }
    if (raw.heredoc.bodyEndsWithLf !== true) {
      throw new FreezeError('generated-artifact-bad-record', id + ' heredoc.bodyEndsWithLf must be true');
    }
    const anchorKey = JSON.stringify([generatorPath, variable, marker]);
    if (anchors.has(anchorKey)) {
      throw new FreezeError('generated-artifact-conflict', 'generated artifact anchor conflicts with ' + anchors.get(anchorKey) + ': ' + id);
    }
    anchors.set(anchorKey, id);
    out.push({
      version: 1,
      id,
      generatorPath,
      generatorSha256: hex64(raw.generatorSha256, id + ' generatorSha256'),
      heredoc: {
        variable,
        marker,
        startLine: posInt(raw.heredoc.startLine, id + ' heredoc.startLine'),
        endLine: posInt(raw.heredoc.endLine, id + ' heredoc.endLine'),
        bodyBytes: posInt(raw.heredoc.bodyBytes, id + ' heredoc.bodyBytes', true),
        bodySha256: hex64(raw.heredoc.bodySha256, id + ' heredoc.bodySha256'),
        bodyEndsWithLf: true,
      },
      call: {
        line: posInt(raw.call.line, id + ' call.line'),
        expression: raw.call.expression,
        lineSha256: hex64(raw.call.lineSha256, id + ' call.lineSha256'),
      },
    });
  }
  return out;
}
function loadJson(file, code) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    throw new FreezeError(code || 'read-failed', 'cannot read ' + file + ': ' + e.message);
  }
  try { return JSON.parse(raw); } catch (e) {
    throw new FreezeError(code || 'invalid-json', 'invalid JSON ' + file + ': ' + e.message);
  }
}

function normalizeBusinessExitContract(h, label) {
  if (!Array.isArray(h.businessExitCodes)) {
    throw new FreezeError('bad-inventory', label + ' must declare businessExitCodes[] explicitly (empty means only exit 0 is healthy)');
  }
  const codes = [];
  const seen = new Set();
  for (const raw of h.businessExitCodes) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n > 255 || n === 124 || n === 126 || n === 127) {
      throw new FreezeError('bad-inventory', label + ' has invalid business exit code: ' + raw);
    }
    if (seen.has(n)) throw new FreezeError('bad-inventory', label + ' duplicates business exit code: ' + n);
    seen.add(n);
    codes.push(n);
  }
  codes.sort((a, b) => a - b);
  return { businessExitCodes: codes };
}

function normalizeCommandWhitespace(value) {
  return String(value === undefined || value === null ? '' : value).trim().replace(/\s+/g, ' ');
}

const REVIEWED_INNER_REDIRS = new Set(['>/dev/null', '2>/dev/null', '2>&1', '>&2']);
const REVIEWED_INNER_ARG_RE = /^(?:--?)?[A-Za-z0-9][A-Za-z0-9._/=-]*$/;
const REVIEWED_INNER_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REVIEWED_INNER_ENV_WORD_RE = /^[A-Za-z0-9._/:-]+$/;
const REVIEWED_INNER_QUOTED_RE = /^"[^"$\x60\\]*"$/;
const REVIEWED_INNER_SHELL_SYNTAX_RE = /(?:\|\||&&|[;|&(){}!\x60#<]|\$\()/;

function reviewedInnerTokens(command) {
  const input = normalizeCommandWhitespace(command);
  const tokens = [];
  let token = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      quoted = !quoted;
      token += ch;
      continue;
    }
    if (ch === ' ' && !quoted) {
      if (token) {
        tokens.push(token);
        token = '';
      }
      continue;
    }
    token += ch;
  }
  if (quoted) {
    return { input, tokens, error: { tokenIndex: tokens.length, token: token || '<eof>', reason: 'unterminated-double-quote' } };
  }
  if (token) tokens.push(token);
  return { input, tokens, error: null };
}

function reviewedInnerSyntaxError(label, input, tokenIndex, token, reason) {
  throw new FreezeError('bad-inventory', label + ' runtimeHealthProbe.innerCommand must be one reviewed simple command', {
    field: 'runtimeHealthProbe.innerCommand',
    label,
    actualInnerCommand: input,
    tokenIndex,
    token,
    reason,
  });
}

function validateReviewedInnerSimpleCommand(command, label) {
  const parsed = reviewedInnerTokens(command);
  const tokens = parsed.tokens;
  if (parsed.error) {
    reviewedInnerSyntaxError(label, parsed.input, parsed.error.tokenIndex, parsed.error.token, parsed.error.reason);
  }
  let i = 0;
  while (i < tokens.length) {
    const eq = tokens[i].indexOf('=');
    if (eq <= 0) break;
    const name = tokens[i].slice(0, eq);
    const value = tokens[i].slice(eq + 1);
    if (!REVIEWED_INNER_ENV_NAME_RE.test(name)
        || !(REVIEWED_INNER_QUOTED_RE.test(value) || REVIEWED_INNER_ENV_WORD_RE.test(value))) {
      reviewedInnerSyntaxError(label, parsed.input, i, tokens[i], 'invalid-env-assignment');
    }
    i++;
  }
  if (i >= tokens.length) reviewedInnerSyntaxError(label, parsed.input, i, '<eof>', 'missing-interpreter');
  if (REVIEWED_INNER_SHELL_SYNTAX_RE.test(tokens[i])) {
    reviewedInnerSyntaxError(label, parsed.input, i, tokens[i], 'shell-control-syntax-not-allowed');
  }
  if (tokens[i] !== 'bash' && tokens[i] !== 'node') {
    reviewedInnerSyntaxError(label, parsed.input, i, tokens[i], 'interpreter-must-be-bash-or-node');
  }
  const interpreter = tokens[i];
  i++;
  if (i >= tokens.length) reviewedInnerSyntaxError(label, parsed.input, i, '<eof>', 'missing-path');
  if (!REVIEWED_INNER_QUOTED_RE.test(tokens[i])) {
    const reason = REVIEWED_INNER_SHELL_SYNTAX_RE.test(tokens[i])
      ? 'shell-control-syntax-not-allowed'
      : 'path-must-be-double-quoted-literal';
    reviewedInnerSyntaxError(label, parsed.input, i, tokens[i], reason);
  }
  const entryPath = tokens[i].slice(1, -1);
  i++;
  let redirections = false;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (REVIEWED_INNER_REDIRS.has(t)) {
      redirections = true;
      continue;
    }
    if (REVIEWED_INNER_SHELL_SYNTAX_RE.test(t)) {
      reviewedInnerSyntaxError(label, parsed.input, i, t, 'shell-control-syntax-not-allowed');
    }
    if (redirections) reviewedInnerSyntaxError(label, parsed.input, i, t, 'argument-after-redirection');
    if (!REVIEWED_INNER_ARG_RE.test(t)) reviewedInnerSyntaxError(label, parsed.input, i, t, 'invalid-argument');
  }
  return { input: parsed.input, interpreter, entryPath };
}

function reviewedInnerCommandInfo(command, label) {
  return validateReviewedInnerSimpleCommand(command, label);
}

function normalizePortableBindingPath(value) {
  let s = posix(String(value || '').trim());
  let m = /^\/cygdrive\/([A-Za-z])\/(.*)$/.exec(s);
  if (m) s = m[1].toUpperCase() + ':/' + m[2];
  else {
    m = /^\/([A-Za-z])\/(.*)$/.exec(s);
    if (m) s = m[1].toUpperCase() + ':/' + m[2];
    else if (/^[A-Za-z]:\//.test(s)) s = s[0].toUpperCase() + s.slice(1);
  }
  s = path.posix.normalize(s);
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

function entryRelativeToLiveRoot(entryPath, liveRoot, label) {
  if (typeof liveRoot !== 'string' || !liveRoot.trim()) {
    throw new FreezeError('bad-inventory', label + ' runtimeHealthProbe entry binding requires the live root', {
      field: 'runtimeHealthProbe.innerCommand', label, entryPath, reason: 'entry-live-root-missing',
    });
  }
  const root = normalizePortableBindingPath(path.resolve(liveRoot));
  const target = normalizePortableBindingPath(entryPath);
  const fold = process.platform === 'win32' ? (x) => x.toLowerCase() : (x) => x;
  const rootFold = fold(root), targetFold = fold(target);
  if (!target || targetFold === rootFold || !targetFold.startsWith(rootFold + '/')) {
    throw new FreezeError('bad-inventory', label + ' runtimeHealthProbe entry path must be inside the live root', {
      field: 'runtimeHealthProbe.innerCommand', label, entryPath, liveRoot: root, reason: 'entry-path-outside-live-root',
    });
  }
  return safeRelativeFile(target.slice(root.length + 1));
}

function reviewedInnerCommandForOuter(command) {
  const outer = normalizeCommandWhitespace(command);
  let match = /^(.*\S)\s+\|\|\s+exit\s+0$/.exec(outer);
  let kind = null;
  let inner = outer;
  if (match) {
    kind = 'exit-0';
    inner = match[1].trim();
  } else {
    match = /^(.*\S)\s+\|\|\s+\{\s*(.+;)\s*\}$/.exec(outer);
    if (match) {
      kind = 'brace-group';
      inner = match[1].trim();
    }
  }
  if (kind) {
    const nested = reviewedInnerCommandForOuter(inner);
    if (nested.kind) return { outer, inner, kind, multipleTails: true };
  }
  return { outer, inner, kind, multipleTails: false };
}
function normalizeRuntimeHealthProbe(h, label) {
  const p = h.runtimeHealthProbe;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw new FreezeError('bad-inventory', label + ' must declare structured runtimeHealthProbe');
  }
  if (p.version !== 1) throw new FreezeError('bad-inventory', label + ' runtimeHealthProbe.version must be 1');
  if (typeof p.innerCommand !== 'string' || !p.innerCommand.trim()) {
    throw new FreezeError('bad-inventory', label + ' runtimeHealthProbe.innerCommand must be a non-empty reviewed command');
  }
  const relation = reviewedInnerCommandForOuter(h.command);
  const reviewedInner = normalizeCommandWhitespace(p.innerCommand);
  if (!relation.outer) {
    throw new FreezeError('bad-inventory', label + ' runtimeHealthProbe.innerCommand requires a non-empty outer command', {
      field: 'runtimeHealthProbe.innerCommand', label, outerCommand: relation.outer, expectedInnerCommand: relation.inner,
      actualInnerCommand: reviewedInner, failOpenTail: relation.kind, multipleFailOpenTails: relation.multipleTails,
      reason: 'empty-outer-command',
    });
  }
  if (relation.multipleTails) {
    throw new FreezeError('bad-inventory', label + ' runtimeHealthProbe.innerCommand cannot rely on multiple approved fail-open tails', {
      field: 'runtimeHealthProbe.innerCommand', label, outerCommand: relation.outer, expectedInnerCommand: relation.inner,
      actualInnerCommand: reviewedInner, failOpenTail: relation.kind, multipleFailOpenTails: true,
      reason: 'multiple-approved-fail-open-tails',
    });
  }
  validateReviewedInnerSimpleCommand(reviewedInner, label);
  if (reviewedInner !== relation.inner) {
    throw new FreezeError('bad-inventory', label + ' runtimeHealthProbe.innerCommand must mechanically match the outer command after removing one approved fail-open tail', {
      field: 'runtimeHealthProbe.innerCommand', label, outerCommand: relation.outer, expectedInnerCommand: relation.inner,
      actualInnerCommand: reviewedInner, failOpenTail: relation.kind, multipleFailOpenTails: relation.multipleTails,
      reason: 'inner-command-does-not-match-outer',
    });
  }
  if (typeof p.reliable !== 'boolean') {
    throw new FreezeError('bad-inventory', label + ' runtimeHealthProbe.reliable must be boolean');
  }
  if (typeof p.notes !== 'string' || !p.notes.trim()) {
    throw new FreezeError('bad-inventory', label + ' runtimeHealthProbe.notes must be non-empty');
  }
  return { version: 1, innerCommand: p.innerCommand, reliable: p.reliable, notes: p.notes.trim() };
}

function validateInventory(inv, liveHooks, liveRoot) {
  if (!inv || inv.version !== 1) throw new FreezeError('bad-inventory', 'inventory.version must be 1');
  if (!Array.isArray(inv.hooks) || !Array.isArray(inv.files)) throw new FreezeError('bad-inventory', 'inventory hooks/files must be arrays');

  const fileMap = new Map();
  for (const f of inv.files) {
    if (!f || typeof f !== 'object') throw new FreezeError('bad-inventory', 'inventory file entry must be an object');
    const rel = safeRelativeFile(f.path);
    if (fileMap.has(rel)) throw new FreezeError('bad-inventory', 'duplicate inventory file: ' + rel);
    if (!DISPOSITIONS.has(f.disposition)) throw new FreezeError('bad-inventory', 'invalid disposition for ' + rel);
    const deps = Array.isArray(f.dependencies) ? f.dependencies.map(safeRelativeFile) : [];
    const unresolvedDependencies = Array.isArray(f.unresolvedDependencies) ? f.unresolvedDependencies.map((x) => {
      if (!x || typeof x.expression !== 'string' || !x.expression.trim() || typeof x.reason !== 'string' || !x.reason.trim()
          || !Array.isArray(x.dependencies)) {
        throw new FreezeError('bad-inventory', rel + ' unresolvedDependencies[] requires exact expression + dependencies[] + non-empty reason');
      }
      const manualDeps = x.dependencies.map(safeRelativeFile);
      if (manualDeps.length === 0) {
        throw new FreezeError('bad-inventory', rel + ' unresolved dependency cannot use empty dependencies[] as closure evidence: ' + x.expression);
      }
      if (new Set(manualDeps).size !== manualDeps.length) {
        throw new FreezeError('bad-inventory', rel + ' unresolved dependency duplicates a manual dependency: ' + x.expression);
      }
      return { expression: x.expression.trim(), dependencies: manualDeps, reason: x.reason.trim() };
    }) : [];
    const unresolvedKeys = new Set();
    for (const x of unresolvedDependencies) {
      if (unresolvedKeys.has(x.expression)) throw new FreezeError('bad-inventory', rel + ' duplicates unresolved dependency review: ' + x.expression);
      unresolvedKeys.add(x.expression);
    }
    fileMap.set(rel, Object.assign({}, f, { path: rel, dependencies: deps, unresolvedDependencies }));
  }
  for (const f of fileMap.values()) {
    for (const dep of f.dependencies) if (!fileMap.has(dep)) throw new FreezeError('bad-inventory', f.path + ' dependency missing from inventory: ' + dep);
  }

  const externalMap = normalizeExternalDependencies(inv);
  const generatedArtifacts = normalizeGeneratedArtifacts(inv);

  const entryBindingChecks = [];
  const inventoryHooks = new Map();
  for (const h of inv.hooks) {
    if (!h || typeof h !== 'object' || !DISPOSITIONS.has(h.disposition)) throw new FreezeError('bad-inventory', 'hook disposition is missing/invalid');
    if (!Array.isArray(h.files)) throw new FreezeError('bad-inventory', 'hook files must be an array');
    const sourceRequired = h.disposition === 'port' || h.disposition === 'replace';
    if (sourceRequired && h.files.length === 0) throw new FreezeError('bad-inventory', h.disposition + ' hook must name at least one tracked source/dependency file');
    if (!sourceRequired && (typeof h.notes !== 'string' || h.notes.trim() === '')) {
      throw new FreezeError('bad-inventory', h.disposition + ' hook with excluded source must carry a non-empty notes rationale');
    }
    const externalDependencies = Array.isArray(h.externalDependencies) ? h.externalDependencies.map((x) => String(x || '').trim()) : [];
    if (h.disposition === 'external-prerequisite' && externalDependencies.length === 0) {
      throw new FreezeError('bad-inventory', 'external-prerequisite hook must declare externalDependencies[]');
    }
    if (externalDependencies.some((x) => !x)) throw new FreezeError('bad-inventory', 'hook externalDependencies contains an empty id');
    for (const id of externalDependencies) if (!externalMap.has(id)) throw new FreezeError('bad-inventory', 'hook references unknown external dependency: ' + id);
    const label = h.event + '/' + h.groupIndex + '/' + h.hookIndex;
    const exitContract = sourceRequired ? normalizeBusinessExitContract(h, label) : { businessExitCodes: [] };
    const runtimeHealthProbe = sourceRequired ? normalizeRuntimeHealthProbe(h, label) : null;
    const normalized = Object.assign({}, h, {
      matcher: Object.prototype.hasOwnProperty.call(h, 'matcher') ? h.matcher : null,
      timeout: Object.prototype.hasOwnProperty.call(h, 'timeout') ? h.timeout : null,
      files: h.files.map(safeRelativeFile),
      externalDependencies,
      businessExitCodes: exitContract.businessExitCodes,
      runtimeHealthProbe,
    });
    for (const f of normalized.files) if (!fileMap.has(f)) throw new FreezeError('bad-inventory', 'hook references file absent from inventory: ' + f);
    if (sourceRequired) entryBindingChecks.push({ label, hook: normalized });
    const key = hookIdentity(normalized);
    if (inventoryHooks.has(key)) throw new FreezeError('bad-inventory', 'duplicate hook inventory identity: ' + key);
    inventoryHooks.set(key, normalized);
  }

  if (inventoryHooks.size !== liveHooks.length) {
    throw new FreezeError('hook-inventory-mismatch', 'inventory hook count ' + inventoryHooks.size + ' != live hook count ' + liveHooks.length);
  }
  for (const h of liveHooks) {
    const key = hookIdentity(h);
    if (!inventoryHooks.has(key)) throw new FreezeError('hook-inventory-mismatch', 'live hook is not exactly inventoried: ' + key);
  }
  for (const check of entryBindingChecks) {
    const entryInfo = reviewedInnerCommandInfo(check.hook.runtimeHealthProbe.innerCommand, check.label);
    const entryRel = entryRelativeToLiveRoot(entryInfo.entryPath, liveRoot, check.label);
    if (!check.hook.files.includes(entryRel)) {
      throw new FreezeError('bad-inventory', check.label + ' runtimeHealthProbe entry path must be declared in this hook files[]', {
        field: 'runtimeHealthProbe.innerCommand', label: check.label, entryPath: entryInfo.entryPath, entryRelativePath: entryRel,
        files: check.hook.files.slice(), reason: 'inner-command-entry-not-in-files',
      });
    }
  }

  if (!Array.isArray(inv.allowedDifferences)) throw new FreezeError('bad-inventory', 'allowedDifferences must be an array');
  if (!Array.isArray(inv.auditEvidence) || inv.auditEvidence.length === 0) throw new FreezeError('bad-inventory', 'auditEvidence must be a non-empty array');

  return { fileMap, inventoryHooks, externalMap, generatedArtifacts };
}

function buildManifest({ liveDir, inventoryPath, generatedAt }) {
  const live = path.resolve(liveDir);
  const repoRoot = String(git(live, ['rev-parse', '--show-toplevel'])).trim();
  const relLive = posix(path.relative(repoRoot, live));
  if (!relLive || relLive === '.' || relLive.startsWith('../')) throw new FreezeError('bad-live-root', 'liveDir must be a tracked subdirectory of a git repository');

  const dirty = String(git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', relLive])).trim();
  if (dirty) throw new FreezeError('dirty-live-source', 'live source is not clean; formal freeze requires an empty patch bundle:\n' + dirty);

  const commit = String(git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  let treeOid;
  try { treeOid = String(git(repoRoot, ['rev-parse', commit + ':' + relLive])).trim(); }
  catch { throw new FreezeError('untracked-live-root', 'live root is not present in source commit: ' + relLive); }

  const inventoryAbs = path.resolve(inventoryPath);
  let inventoryRepoRoot;
  try { inventoryRepoRoot = String(git(path.dirname(inventoryAbs), ['rev-parse', '--show-toplevel'])).trim(); }
  catch { throw new FreezeError('bad-inventory', 'inventory must be inside a git repository: ' + inventoryAbs); }
  const inventoryRel = posix(path.relative(inventoryRepoRoot, inventoryAbs));
  if (!inventoryRel || inventoryRel === '.' || inventoryRel.startsWith('../') || path.posix.isAbsolute(inventoryRel)) {
    throw new FreezeError('bad-inventory', 'inventory path must be inside its repository: ' + inventoryAbs);
  }
  let inventoryBytes;
  try { inventoryBytes = fs.readFileSync(inventoryAbs); }
  catch (e) { throw new FreezeError('bad-inventory', 'cannot read inventory: ' + e.message); }
  let inv;
  try { inv = JSON.parse(inventoryBytes.toString('utf8')); }
  catch (e) { throw new FreezeError('bad-inventory', 'invalid inventory JSON: ' + e.message); }
  const inventorySha256 = sha256(inventoryBytes);
  const inventoryCommit = inventorySnapshotCommit(inventoryRepoRoot, inventoryRel, inventoryBytes);
  const settingsRel = safeRelativeFile(inv.settingsJson || 'settings.json');
  const settingsAbs = path.join(live, ...settingsRel.split('/'));
  let settingsBytes;
  try { settingsBytes = fs.readFileSync(settingsAbs); }
  catch (e) { throw new FreezeError('bad-settings', 'cannot read ' + settingsAbs + ': ' + e.message); }
  let settings;
  try { settings = JSON.parse(settingsBytes.toString('utf8')); }
  catch (e) { throw new FreezeError('bad-settings', 'cannot parse ' + settingsAbs + ': ' + e.message); }
  const settingsSha256 = sha256(settingsBytes);
  const liveHooks = flattenHooks(settings);
  if (typeof inv.settingsMirror !== 'string' || !inv.settingsMirror.trim()) throw new FreezeError('bad-inventory', 'formal inventory must declare tracked settingsMirror');
  const settingsMirrorRel = safeRelativeFile(inv.settingsMirror);
  const mirrorAbs = path.join(live, ...settingsMirrorRel.split('/'));
  const mirrorSettings = loadJson(mirrorAbs, 'bad-settings-mirror');
  const mirrorHooks = flattenHooks(mirrorSettings);
  if (liveHooks.length !== mirrorHooks.length || liveHooks.some((h, i) => hookIdentity(h) !== hookIdentity(mirrorHooks[i]))) {
    throw new FreezeError('settings-mirror-mismatch', 'live settings hooks do not exactly match tracked mirror: ' + settingsMirrorRel);
  }
  const settingsHookIdentitySha256 = hookIdentitySha256(liveHooks);
  const { fileMap, inventoryHooks, externalMap, generatedArtifacts } = validateInventory(inv, liveHooks, live);
  if (!fileMap.has(settingsMirrorRel)) throw new FreezeError('bad-inventory', 'settingsMirror must also appear in files[] so its commit blob is frozen: ' + settingsMirrorRel);

  const blobs = new Map();
  const sourceFiles = [];
  for (const f of [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const repoRel = posix(path.posix.join(relLive, f.path));
    let blob;
    try { blob = git(repoRoot, ['show', commit + ':' + repoRel], { binary: true }); }
    catch { throw new FreezeError('untracked-source-file', 'inventory file is not tracked at source commit: ' + f.path); }
    blobs.set(f.path, blob);
    const dependencyAnalysis = analyzeDependencyReferences(f.path, blob.toString('utf8'));
    sourceFiles.push({
      path: f.path,
      sha256: sha256(blob),
      disposition: f.disposition,
      dependencies: f.dependencies,
      sourceBindings: (dependencyAnalysis.sourceBindings || []).map((x) => ({
        expression: x.expression,
        kind: x.kind,
        target: x.target,
        sourceSha256: sha256(blob),
      })),
      unresolvedDependencies: f.unresolvedDependencies,
      notes: typeof f.notes === 'string' ? f.notes : '',
    });
  }
  const closureEvidence = verifyDependencyClosure({ fileMap, repoRoot, commit, relLive, blobs, generatedArtifacts });

  const externalDependencies = [];
  for (const e of [...externalMap.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const row = { id: e.id, kind: e.kind, notes: e.notes };
    if (typeof e.version === 'string' && e.version.trim()) row.version = e.version.trim();
    if (e.kind === 'file') {
      const abs = path.join(live, ...e.path.split('/'));
      let bytes;
      try { bytes = fs.readFileSync(abs); } catch (err) { throw new FreezeError('external-dependency-missing', 'cannot read external file ' + e.id + ' at ' + e.path + ': ' + err.message); }
      row.path = e.path;
      row.sha256 = sha256(bytes);
    } else if (e.kind === 'repo') {
      const abs = path.join(live, ...e.path.split('/'));
      row.path = e.path;
      try { row.head = String(git(abs, ['rev-parse', 'HEAD'])).trim(); }
      catch (err) { throw new FreezeError('external-dependency-missing', 'cannot resolve external repo ' + e.id + ' at ' + e.path); }
    } else if (e.kind === 'command') {
      row.command = e.command.trim();
    }
    externalDependencies.push(row);
  }

  const hookRows = liveHooks.map((h) => {
    const invHook = inventoryHooks.get(hookIdentity(h));
    return Object.assign({}, h, {
      disposition: invHook.disposition,
      files: invHook.files,
      implementation: invHook.implementation || null,
      notes: invHook.notes || '',
      externalDependencies: invHook.externalDependencies,
      businessExitCodes: invHook.businessExitCodes,
      runtimeHealthProbe: invHook.runtimeHealthProbe,
    });
  });

  return {
    schema: 'axmem-p2-freeze/v1',
    generatedAt: generatedAt || new Date().toISOString(),
    source: {
      commit,
      liveRelativePath: relLive,
      treeOid,
      clean: true,
      uncommittedPatch: { empty: true, sha256: null },
    },
    inventoryPath: inventoryRel,
    inventorySha256,
    inventoryCommit,
    settingsJson: settingsRel,
    settingsSha256,
    settingsEvidence: {
      livePath: settingsRel,
      liveSha256: settingsSha256,
      mirrorPath: settingsMirrorRel,
      mirrorSha256: sourceFiles.find((x) => x.path === settingsMirrorRel).sha256,
      hookIdentitySha256: settingsHookIdentitySha256,
    },
    hooks: hookRows,
    sourceFiles,
    externalDependencies,
    generatedArtifacts: closureEvidence.generatedArtifacts,
    auditEvidence: inv.auditEvidence,
    allowedDifferences: inv.allowedDifferences,
    fixtureSet: inv.fixtureSet || 'tests/fixtures/p2-equiv/events.json',
  };
}

function writeJsonAtomic(file, value) {
  const out = path.resolve(file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, out);
}

function generate(opts) {
  const manifest = buildManifest(opts);
  const inventoryAbs = path.resolve(opts.inventoryPath);
  let inventoryRepoRoot;
  try { inventoryRepoRoot = String(git(path.dirname(inventoryAbs), ['rev-parse', '--show-toplevel'])).trim(); }
  catch { throw new FreezeError('bad-inventory', 'inventory must be inside a git repository: ' + inventoryAbs); }
  const inventoryHead = String(git(inventoryRepoRoot, ['rev-parse', 'HEAD'])).trim();
  if (manifest.inventoryCommit !== inventoryHead) {
    throw new FreezeError('inventory-commit-binding', 'formal FREEZE requires inventory bytes to be present in the current inventory repository HEAD; commit inventory before generation');
  }
  let committedInventory;
  try { committedInventory = git(inventoryRepoRoot, ['show', manifest.inventoryCommit + ':' + manifest.inventoryPath], { binary: true }); }
  catch { throw new FreezeError('inventory-commit-binding', 'inventory path is not present at recorded inventory commit: ' + manifest.inventoryCommit + ':' + manifest.inventoryPath); }
  const committedSha256 = sha256(committedInventory);
  if (committedSha256 !== manifest.inventorySha256) {
    throw new FreezeError('inventory-commit-binding', 'working inventory differs from recorded inventory commit; commit inventory before generating formal FREEZE');
  }
  writeJsonAtomic(opts.out, manifest);
  return manifest;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') o.liveDir = argv[++i];
    else if (a === '--inventory') o.inventoryPath = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--generated-at') o.generatedAt = argv[++i];
    else throw new FreezeError('bad-args', 'unknown arg: ' + a);
  }
  if (!o.liveDir || !o.inventoryPath || !o.out) throw new FreezeError('bad-args', 'usage: p2-freeze.cjs generate --live <.claude> --inventory <json> --out <FREEZE-date.json>');
  return o;
}

module.exports = { FreezeError, flattenHooks, hookIdentity, validateInventory, normalizeGeneratedArtifacts, normalizeBusinessExitContract, normalizeRuntimeHealthProbe, reviewedInnerCommandInfo, entryRelativeToLiveRoot, analyzeDependencyReferences, inspectLiteralGeneratedArtifact, verifyGeneratedArtifactEvidence, detectLiteralDependencies, verifyDependencyClosure, buildManifest, generate, writeJsonAtomic, safeRelativeFile };

if (require.main === module) {
  try {
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd !== 'generate') throw new FreezeError('bad-args', 'usage: p2-freeze.cjs generate --live <.claude> --inventory <json> --out <FREEZE-date.json>');
    const manifest = generate(parseArgs(rest));
    process.stdout.write(JSON.stringify({ ok: true, out: path.resolve(parseArgs(rest).out), commit: manifest.source.commit, treeOid: manifest.source.treeOid, hooks: manifest.hooks.length, files: manifest.sourceFiles.length }) + '\n');
  } catch (e) {
    const code = e instanceof FreezeError ? e.code : 'unexpected';
    process.stderr.write('[p2-freeze] ' + code + ': ' + e.message + '\n');
    process.exit(2);
  }
}
