'use strict';

const path = require('path');
const acorn = require('../../../guards/vendor/acorn.js');
let projector = null;

function bindProjector(api) {
  if (!api || typeof api.parseMaterialized !== 'function' ||
      typeof api.projectWord !== 'function' ||
      typeof api.hasUnquotedRuntimePattern !== 'function') {
    throw new TypeError('target-rules requires the verified projector API');
  }
  projector = api;
}

function requireProjector() {
  if (!projector) throw new TypeError('target-rules must be initialized through adapter.cjs');
  return projector;
}
const { ERROR_CODES } = require('./protocol.cjs');

const SCAN_SCHEMA = 'axmem-p2-bash-target-scan/v1';

function cloneBindings(bindings) {
  return new Map(bindings instanceof Map ? bindings : Object.entries(bindings || {}));
}

function spanOf(node) {
  return node && Number.isSafeInteger(node.pos) && Number.isSafeInteger(node.end) ?
    { start: node.pos, end: node.end } : null;
}

function asWord(node, source) {
  if (!node || typeof node !== 'object' || typeof node.text !== 'string' ||
      !Number.isSafeInteger(node.pos) || !Number.isSafeInteger(node.end)) return null;
  return requireProjector().projectWord(node, source);
}

function shellWordValue(node, source, bindings) {
  const projected = asWord(node, source);
  if (!projected) return { resolved: false, value: null, projected: null };
  if (!projected.dynamic) return { resolved: true, value: projected.resolvedLiteral, projected };
  // A standalone "[" is Bash's test builtin name, not a pathname bracket expression.
  // Keep the projector/golden byte contract unchanged, but do not turn this command
  // name into a dependency-scan dynamic/unresolved record.
  if (node.text === '[' && projected.expansionKinds.length === 0) {
    return { resolved: true, value: '[', projected };
  }

  function resolveParts(parts) {
    let out = '';
    for (const part of parts || []) {
      if (!part || typeof part !== 'object') return null;
      if (part.type === 'Literal' || part.type === 'SingleQuoted' || part.type === 'AnsiCQuoted') {
        out += typeof part.value === 'string' ? part.value : (part.text || '');
        continue;
      }
      if (part.type === 'DoubleQuoted') {
        const inner = resolveParts(part.parts || []);
        if (inner === null) return null;
        out += inner;
        continue;
      }
      if (part.type === 'SimpleExpansion') {
        const name = String(part.text || '').replace(/^\$/, '');
        if (!bindings.has(name)) return null;
        out += String(bindings.get(name));
        continue;
      }
      if (part.type === 'ParameterExpansion' && !part.operator && !part.index) {
        const name = part.parameter;
        if (!bindings.has(name)) return null;
        out += String(bindings.get(name));
        continue;
      }
      return null;
    }
    return out;
  }

  const resolved = resolveParts(node.parts || []);
  if (resolved === null) return { resolved: false, value: null, projected };
  if (requireProjector().hasUnquotedRuntimePattern(node.text)) return { resolved: false, value: null, projected };
  return { resolved: true, value: resolved, projected };
}

function parseJs(code) {
  const opts = {
    ecmaVersion: 'latest',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  };
  try {
    return acorn.parse(code, { ...opts, sourceType: 'script' });
  } catch (scriptError) {
    try {
      return acorn.parse(code, { ...opts, sourceType: 'module' });
    } catch (moduleError) {
      return null;
    }
  }
}

function walkJs(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) {
      for (const item of value) walkJs(item, visit);
    } else if (value && typeof value === 'object') {
      walkJs(value, visit);
    }
  }
}

function staticJsString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked).join('');
  }
  return null;
}

function processArgIndex(node) {
  if (!node || node.type !== 'MemberExpression' || !node.computed) return null;
  const obj = node.object;
  if (!obj || obj.type !== 'MemberExpression' || obj.computed) return null;
  if (!obj.object || obj.object.type !== 'Identifier' || obj.object.name !== 'process') return null;
  if (!obj.property || obj.property.type !== 'Identifier' || obj.property.name !== 'argv') return null;
  const p = node.property;
  if (p.type === 'Literal' && Number.isSafeInteger(p.value) && p.value >= 0) return p.value;
  return null;
}

function targetFromWord(word, source, bindings) {
  if (!word) return { expression: '', resolved: false, value: null, word: null };
  const v = shellWordValue(word, source, bindings);
  return {
    expression: word.text,
    resolved: v.resolved,
    value: v.value,
    word: v.projected,
  };
}

function createScanner(source, options = {}) {
  const ast = requireProjector().parseMaterialized(source);
  const fromPath = typeof options.fromPath === 'string' ? options.fromPath.replace(/\\/g, '/') : '';
  const initialBindings = cloneBindings(options.bindings);
  const functions = new Map();
  const records = new Map();
  const functionStack = new Set();

  function emptyEffects() {
    return { names: new Set(), clearAll: false };
  }

  function mergeEffects(into, other) {
    if (!other) return into;
    if (other.clearAll) into.clearAll = true;
    for (const name of other.names || []) into.names.add(name);
    return into;
  }

  function invalidateBindings(bindings, effects) {
    if (!bindings || !effects) return;
    if (effects.clearAll) {
      bindings.clear();
      return;
    }
    for (const name of effects.names) bindings.delete(name);
  }

  function wordVariableName(word, bindings) {
    const raw = word && typeof word.text === 'string' ? word.text : '';
    const rawMatch = /^([A-Za-z_][A-Za-z0-9_]*)(?:=|$)/.exec(raw);
    if (rawMatch) return { name: rawMatch[1], unknown: false };
    const w = targetFromWord(word, source, bindings || new Map());
    if (!w.resolved) return { name: null, unknown: true };
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=.*)?$/.exec(w.value);
    return { name: m ? m[1] : null, unknown: false };
  }

  function writerEffects(command, words, bindings) {
    const effects = emptyEffects();
    const args = words.slice(1);
    const addWordName = (word) => {
      const got = wordVariableName(word, bindings);
      if (got.unknown) effects.clearAll = true;
      else if (got.name) effects.names.add(got.name);
    };
    if (['export', 'declare', 'local', 'typeset', 'readonly', 'unset'].includes(command)) {
      for (const word of args) {
        const w = targetFromWord(word, source, bindings);
        if (w.resolved && w.value.startsWith('-')) continue;
        addWordName(word);
      }
      return effects;
    }
    if (command === 'read') {
      let any = false;
      for (const word of args) {
        const w = targetFromWord(word, source, bindings);
        if (w.resolved && w.value.startsWith('-')) continue;
        const before = effects.names.size;
        addWordName(word);
        if (effects.names.size > before) any = true;
      }
      if (!any && !effects.clearAll) effects.names.add('REPLY');
      return effects;
    }
    if (command === 'printf') {
      for (let i = 0; i < args.length; i++) {
        const w = targetFromWord(args[i], source, bindings);
        if (w.resolved && w.value === '-v') {
          if (args[i + 1]) addWordName(args[i + 1]);
          else effects.clearAll = true;
          break;
        }
      }
      return effects;
    }
    if (command === 'mapfile' || command === 'readarray') {
      let chosen = null;
      for (const word of args) {
        const w = targetFromWord(word, source, bindings);
        if (!w.resolved) {
          effects.clearAll = true;
          continue;
        }
        if (!w.value.startsWith('-') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w.value)) chosen = word;
      }
      if (chosen) addWordName(chosen);
      else if (!effects.clearAll) effects.names.add('MAPFILE');
      return effects;
    }
    if (command === 'getopts') {
      if (args[1]) addWordName(args[1]);
      else effects.clearAll = true;
      return effects;
    }
    return effects;
  }

  function collectBindingEffects(node, seenFunctions = new Set(), sourceClears = true) {
    const effects = emptyEffects();
    if (!node || typeof node !== 'object') return effects;
    switch (node.type) {
      case 'Script':
      case 'CompoundList':
        for (const child of node.commands || []) {
          mergeEffects(effects, collectBindingEffects(child, seenFunctions, sourceClears));
        }
        return effects;
      case 'Statement':
        return collectBindingEffects(node.command, seenFunctions, sourceClears);
      case 'Command': {
        const words = [];
        if (node.name) words.push(node.name);
        for (const word of node.suffix || []) if (word && typeof word.text === 'string') words.push(word);
        if (!node.name) {
          for (const assignment of node.prefix || []) {
            if (assignment && assignment.type === 'Assignment' && assignment.name) effects.names.add(assignment.name);
          }
          return effects;
        }
        const commandWord = targetFromWord(node.name, source, new Map());
        if (!commandWord.resolved) return effects;
        const command = commandWord.value;
        if (command === 'source' || command === '.') {
          if (sourceClears) effects.clearAll = true;
          return effects;
        }
        if (command === 'eval') {
          effects.clearAll = true;
          return effects;
        }
        mergeEffects(effects, writerEffects(command, words, new Map()));
        if (functions.has(command) && !seenFunctions.has(command)) {
          const nextSeen = new Set(seenFunctions);
          nextSeen.add(command);
          mergeEffects(effects, collectBindingEffects(functions.get(command).body, nextSeen, sourceClears));
        }
        return effects;
      }
      case 'Function':
        return effects;
      case 'BraceGroup':
        return collectBindingEffects(node.body, seenFunctions, sourceClears);
      case 'Subshell':
      case 'Pipeline':
        return effects;
      case 'AndOr': {
        const commands = node.commands || [];
        if (commands[0]) mergeEffects(effects, collectBindingEffects(commands[0], seenFunctions, sourceClears));
        for (let i = 1; i < commands.length; i++) {
          mergeEffects(effects, collectBindingEffects(commands[i], seenFunctions, false));
        }
        return effects;
      }
      case 'If':
        mergeEffects(effects, collectBindingEffects(node.clause, seenFunctions, sourceClears));
        mergeEffects(effects, collectBindingEffects(node.then, seenFunctions, false));
        mergeEffects(effects, collectBindingEffects(node.else, seenFunctions, false));
        return effects;
      case 'Case':
        for (const item of node.items || []) {
          mergeEffects(effects, collectBindingEffects(item.body, seenFunctions, false));
        }
        return effects;
      case 'While':
        mergeEffects(effects, collectBindingEffects(node.clause, seenFunctions, sourceClears));
        mergeEffects(effects, collectBindingEffects(node.body, seenFunctions, false));
        return effects;
      case 'For':
        if (node.name && typeof node.name.value === 'string') effects.names.add(node.name.value);
        else effects.clearAll = true;
        mergeEffects(effects, collectBindingEffects(node.body, seenFunctions, false));
        return effects;
      default:
        return effects;
    }
  }

  function scanCandidateAndInvalidate(node, bindings) {
    if (!node) return;
    scanNode(node, 'candidate', new Map());
    invalidateBindings(bindings, collectBindingEffects(node, new Set(), false));
  }


  function rank(reachability) {
    return reachability === 'production' ? 2 : 1;
  }

  function addRecord(record) {
    const key = [
      record.kind,
      record.command,
      record.expression,
      record.span ? record.span.start : '',
      record.span ? record.span.end : '',
      record.target || '',
    ].join('\u0000');
    const old = records.get(key);
    if (!old || rank(record.reachability) > rank(old.reachability)) records.set(key, record);
  }

  function addTarget(kind, command, expression, target, resolved, reason, reachability, node, extra = {}) {
    let status;
    let finalReason = reason || null;
    if (reachability !== 'production') {
      status = 'candidate';
      finalReason = finalReason || 'command reachability is not proven';
    } else if (resolved) {
      status = 'resolved';
    } else {
      status = 'unresolved';
      finalReason = finalReason || 'target cannot be proven statically';
    }
    addRecord({
      kind,
      command,
      expression,
      target: resolved ? target : null,
      status,
      reason: finalReason,
      reachability,
      span: spanOf(node),
      ...extra,
    });
  }

  function addUnresolved(kind, command, expression, reason, reachability, node, extra = {}) {
    addTarget(kind, command, expression, null, false, reason, reachability, node, extra);
  }

  function addUnsupported(construct, expression, reason, reachability, node, extra = {}) {
    addUnresolved(
      'unsupported-construct',
      construct,
      expression || construct,
      reason || ('unmodeled command-bearing construct: ' + construct),
      reachability,
      node,
      { code: ERROR_CODES.UNSUPPORTED, construct, ...extra });
  }

  function resolveSourceLike(command, word, reachability, bindings, node) {
    const t = targetFromWord(word, source, bindings);
    if (!t.word) {
      addUnresolved('shell-source', command, '', 'missing source target', reachability, node);
      return;
    }
    if (!t.resolved) {
      addUnresolved('shell-source', command, t.expression, 'dynamic source target requires a binding proof', reachability, word);
      return;
    }
    if (t.value.includes('/')) {
      addTarget('shell-source', command, t.expression, t.value, true, null, reachability, word);
      return;
    }
    const proof = options.sourceSearchProof && options.sourceSearchProof[t.value];
    if (typeof proof === 'string' && proof) {
      addTarget('shell-source', command, t.expression, proof, true, null, reachability, word, { proof: 'source-search' });
    } else {
      addUnresolved('shell-source', command, t.expression,
        'source target has no slash and no frozen PATH/source-search proof', reachability, word);
    }
  }

  function parseShellOptionWords(words, command, reachability, bindings, node) {
    let i = 1;
    let endOptions = false;
    while (i < words.length) {
      const w = targetFromWord(words[i], source, bindings);
      if (!endOptions && w.resolved && w.value === '--') {
        endOptions = true;
        i++;
        continue;
      }
      if (!endOptions && w.resolved && w.value === '-c') {
        const codeWord = words[i + 1];
        const code = targetFromWord(codeWord, source, bindings);
        if (!codeWord) {
          addUnresolved('shell-inline-code', command, '-c', 'missing -c code operand', reachability, node);
          return;
        }
        if (!code.resolved) {
          addUnresolved('shell-inline-code', command, code.expression, 'dynamic -c code cannot be recursively scanned', reachability, codeWord);
          return;
        }
        const nested = scanDependencyTargets(code.value, {
          bindings: Object.fromEntries(bindings),
          sourceSearchProof: options.sourceSearchProof || {},
          inlineParent: command,
        });
        for (const rec of nested.targets) {
          const nestedReach = reachability === 'production' ? rec.reachability : 'candidate';
          addRecord({ ...rec, reachability: nestedReach, status: nestedReach === 'production' ? rec.status : 'candidate',
            reason: nestedReach === 'production' ? rec.reason : (rec.reason || 'parent inline shell command is not proven reachable'),
            origin: command + '-c' });
        }
        return;
      }
      if (!endOptions && w.resolved && /^-[a-zA-Z]+$/.test(w.value)) {
        const chars = w.value.slice(1);
        if (/^[euxnvfhitBEP]+$/.test(chars)) {
          i++;
          continue;
        }
        if (w.value === '-o' || w.value === '-O') {
          if (!words[i + 1]) {
            addUnresolved('shell-option-sequence', command, w.expression, 'option requires an operand', reachability, words[i]);
            return;
          }
          i += 2;
          continue;
        }
        addUnresolved('shell-option-sequence', command, w.expression, 'unrecognized shell option sequence', reachability, words[i]);
        return;
      }
      if (!endOptions && w.resolved && w.value.startsWith('--')) {
        if (['--noprofile', '--norc', '--posix', '--restricted', '--verbose'].includes(w.value)) {
          i++;
          continue;
        }
        if (['--rcfile', '--init-file'].includes(w.value)) {
          if (!words[i + 1]) {
            addUnresolved('shell-option-sequence', command, w.expression, 'option requires an operand', reachability, words[i]);
            return;
          }
          i += 2;
          continue;
        }
        addUnresolved('shell-option-sequence', command, w.expression, 'unrecognized shell option sequence', reachability, words[i]);
        return;
      }
      if (!w.resolved && !endOptions && w.expression.startsWith('-')) {
        addUnresolved('shell-option-sequence', command, w.expression, 'dynamic shell option sequence', reachability, words[i]);
        return;
      }
      if (!w.resolved) {
        addUnresolved('shell-script', command, w.expression, 'dynamic shell script target', reachability, words[i]);
      } else {
        addTarget('shell-script', command, w.expression, w.value, true, null, reachability, words[i]);
      }
      return;
    }
  }

  function nodeOptions(words, reachability, bindings, node) {
    let i = 1;
    let inline = null;
    let endOptions = false;
    const effectiveArgs = [];
    while (i < words.length) {
      const w = targetFromWord(words[i], source, bindings);
      const value = w.resolved ? w.value : null;
      if (!endOptions && value === '--') {
        endOptions = true;
        i++;
        continue;
      }
      if (!endOptions && value && (value === '-e' || value === '--eval' || value === '-p' || value === '--print')) {
        const codeWord = words[i + 1];
        if (!codeWord) {
          addUnresolved('node-inline-code', 'node', value, 'inline-code option is missing its code operand', reachability, words[i]);
          return { stop: true };
        }
        inline = { mode: value, codeWord };
        i += 2;
        continue;
      }
      if (!endOptions && value && (/^--(?:eval|print)=/.test(value) || /^-[ep].+/.test(value))) {
        const split = value.startsWith('--') ? value.indexOf('=') + 1 : 2;
        const code = value.slice(split);
        inline = { mode: value.startsWith('--print') || value.startsWith('-p') ? '-p' : '-e',
          syntheticCode: code, codeWord: words[i] };
        i++;
        continue;
      }
      if (!endOptions && value && (value === '-r' || value === '--require' ||
          value === '--import' || value === '--loader')) {
        const option = value === '-r' ? '--require' : value;
        const kind = option === '--require' ? 'node-require-option' : 'node-option-module';
        const modWord = words[i + 1];
        if (!modWord) {
          addUnresolved(kind, 'node', value, option + ' is missing its module operand',
            reachability, words[i], option === '--require' ? {} : { option });
          return { stop: true };
        }
        const mod = targetFromWord(modWord, source, bindings);
        if (mod.resolved) addTarget(kind, 'node', mod.expression, mod.value, true, null, reachability, modWord,
          option === '--require' ? {} : { option });
        else addUnresolved(kind, 'node', mod.expression, 'dynamic node ' + option + ' target',
          reachability, modWord, option === '--require' ? {} : { option });
        i += 2;
        continue;
      }
      if (!endOptions && value && value.startsWith('--require=')) {
        const mod = value.slice('--require='.length);
        addTarget('node-require-option', 'node', w.expression, mod, true, null, reachability, words[i]);
        i++;
        continue;
      }
      if (!endOptions && value && (/^--(?:import|loader)=/.test(value))) {
        const eq = value.indexOf('=');
        const option = value.slice(0, eq);
        addTarget('node-option-module', 'node', w.expression, value.slice(eq + 1), true, null,
          reachability, words[i], { option });
        i++;
        continue;
      }
      if (!endOptions && !w.resolved && /^--(?:import|loader)=/.test(w.expression)) {
        const option = w.expression.slice(0, w.expression.indexOf('='));
        addUnresolved('node-option-module', 'node', w.expression,
          'dynamic node ' + option + ' target', reachability, words[i], { option });
        i++;
        continue;
      }
      if (!endOptions && value && [
        '--no-warnings', '--trace-warnings', '--experimental-require-module',
        '--experimental-strip-types', '--no-deprecation', '--trace-deprecation'
      ].includes(value)) {
        i++;
        continue;
      }
      if (!endOptions && value && /^--(?:input-type|conditions|inspect-port|title|icu-data-dir|openssl-config)$/.test(value)) {
        if (!words[i + 1]) {
          addUnresolved('node-option-sequence', 'node', w.expression, 'Node option requires an operand', reachability, words[i]);
          return { stop: true };
        }
        i += 2;
        continue;
      }
      if (!endOptions && value && /^--(?:input-type|conditions|inspect-port|title|icu-data-dir|openssl-config)=/.test(value)) {
        i++;
        continue;
      }
      if (!endOptions && ((value && value.startsWith('-')) || (!w.resolved && w.expression.startsWith('-')))) {
        addUnresolved('node-option-sequence', 'node', w.expression,
          w.resolved ? 'unrecognized Node option sequence' : 'dynamic Node option sequence',
          reachability, words[i]);
        return { stop: true };
      }

      if (inline) {
        effectiveArgs.push(words[i]);
        i++;
        while (i < words.length) effectiveArgs.push(words[i++]);
        break;
      }

      if (!w.resolved) {
        addUnresolved('node-script', 'node', w.expression, 'dynamic Node script target', reachability, words[i]);
      } else {
        addTarget('node-script', 'node', w.expression, w.value, true, null, reachability, words[i]);
      }
      return { stop: true };
    }
    return { inline, effectiveArgs, stop: false };
  }

  function scanInlineJs(inline, effectiveArgs, reachability, bindings, node) {
    let code;
    let expression;
    if (inline.syntheticCode !== undefined) {
      code = inline.syntheticCode;
      expression = inline.codeWord.text;
    } else {
      const w = targetFromWord(inline.codeWord, source, bindings);
      expression = w.expression;
      if (!w.resolved) {
        addUnresolved('node-inline-code', 'node', expression, 'dynamic inline JavaScript cannot be scanned', reachability, inline.codeWord);
        return;
      }
      code = w.value;
    }
    const jsAst = parseJs(code);
    if (!jsAst) {
      addUnresolved('node-inline-code', 'node', expression, 'Acorn could not parse inline JavaScript', reachability, inline.codeWord);
      return;
    }
    walkJs(jsAst, (jsNode) => {
      let depNode = null;
      let kind = null;
      if (jsNode.type === 'CallExpression' &&
          jsNode.callee && jsNode.callee.type === 'Identifier' &&
          jsNode.callee.name === 'require' && jsNode.arguments.length === 1) {
        depNode = jsNode.arguments[0];
        kind = 'node-inline-require';
      } else if (jsNode.type === 'ImportExpression') {
        depNode = jsNode.source;
        kind = 'node-inline-import';
      } else if ((jsNode.type === 'ImportDeclaration' ||
                  jsNode.type === 'ExportNamedDeclaration' ||
                  jsNode.type === 'ExportAllDeclaration') && jsNode.source) {
        depNode = jsNode.source;
        kind = 'node-inline-import';
      }
      if (!depNode || !kind) return;
      const literal = staticJsString(depNode);
      if (literal !== null) {
        addTarget(kind, 'node', code.slice(depNode.start, depNode.end), literal, true, null, reachability, inline.codeWord,
          { inlineCode: expression });
        return;
      }
      const index = processArgIndex(depNode);
      if (index !== null) {
        if (index === 0) {
          addUnresolved(kind, 'node', 'process.argv[0]', 'process.argv[0] is the Node executable, not a dependency operand',
            reachability, inline.codeWord, { inlineCode: expression });
          return;
        }
        const argWord = effectiveArgs[index - 1];
        if (!argWord) {
          addUnresolved(kind, 'node', 'process.argv[' + index + ']', 'process.argv reference has no bound effective argv entry',
            reachability, inline.codeWord, { inlineCode: expression, argvIndex: index });
          return;
        }
        const bound = targetFromWord(argWord, source, bindings);
        if (bound.resolved) {
          addTarget(kind, 'node', bound.expression, bound.value, true, null, reachability, argWord,
            { inlineCode: expression, argvIndex: index });
        } else {
          addUnresolved(kind, 'node', bound.expression, 'effective argv binding remains dynamic/unproved',
            reachability, argWord, { inlineCode: expression, argvIndex: index });
        }
        return;
      }
      addUnresolved(kind, 'node', code.slice(depNode.start, depNode.end),
        'inline JavaScript dependency target is dynamic or unsupported', reachability, inline.codeWord,
        { inlineCode: expression });
    });
  }

  function scanNodeCommand(words, reachability, bindings, node) {
    const parsed = nodeOptions(words, reachability, bindings, node);
    if (parsed.inline) scanInlineJs(parsed.inline, parsed.effectiveArgs, reachability, bindings, node);
  }

  function scanExec(words, reachability, bindings, node) {
    let i = 1;
    while (i < words.length) {
      const w = targetFromWord(words[i], source, bindings);
      if (w.resolved && w.value === '--') {
        i++;
        break;
      }
      if (w.resolved && w.value === '-a') {
        if (!words[i + 1]) {
          addUnresolved('exec-option-sequence', 'exec', w.expression, 'exec -a requires NAME', reachability, words[i]);
          return;
        }
        i += 2;
        continue;
      }
      if (w.resolved && /^-[cl]+$/.test(w.value)) {
        i++;
        continue;
      }
      if ((w.resolved && w.value.startsWith('-')) || (!w.resolved && w.expression.startsWith('-'))) {
        addUnresolved('exec-option-sequence', 'exec', w.expression, 'unrecognized or dynamic exec option sequence',
          reachability, words[i]);
        return;
      }
      break;
    }
    if (i >= words.length) return;
    processWords(words.slice(i), reachability, bindings, node, 'exec', false);
  }

  function scanEnv(words, reachability, bindings, node) {
    let i = 1;
    let endOptions = false;
    while (i < words.length) {
      const w = targetFromWord(words[i], source, bindings);
      const raw = w.expression || '';
      if (!endOptions && w.resolved && w.value === '--') {
        endOptions = true;
        i++;
        continue;
      }
      if (!endOptions && w.resolved && ['-i', '--ignore-environment', '-0', '--null'].includes(w.value)) {
        i++;
        continue;
      }
      if (!endOptions && w.resolved && ['-u', '--unset', '-C', '--chdir'].includes(w.value)) {
        if (!words[i + 1]) {
          addUnsupported('env', raw, 'env option requires an operand', reachability, words[i], { wrapper: 'env' });
          return;
        }
        i += 2;
        continue;
      }
      if (!endOptions && w.resolved && /^--(?:unset|chdir)=/.test(w.value)) {
        i++;
        continue;
      }
      if (!endOptions && (w.resolved ? w.value.startsWith('-') : raw.startsWith('-'))) {
        addUnsupported('env', raw, 'unrecognized or dynamic env option sequence', reachability, words[i], { wrapper: 'env' });
        return;
      }
      const assignmentText = w.resolved ? w.value : raw;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(assignmentText)) {
        i++;
        continue;
      }
      break;
    }
    if (i < words.length) processWords(words.slice(i), reachability, bindings, node, 'env', false);
  }

  function scanCommandWrapper(words, reachability, bindings, node) {
    let i = 1;
    while (i < words.length) {
      const w = targetFromWord(words[i], source, bindings);
      if (w.resolved && w.value === '--') {
        i++;
        break;
      }
      if (w.resolved && w.value === '-p') {
        i++;
        continue;
      }
      if (w.resolved && (w.value === '-v' || w.value === '-V')) {
        return;
      }
      if ((w.resolved && w.value.startsWith('-')) || (!w.resolved && w.expression.startsWith('-'))) {
        addUnsupported('command', w.expression, 'unrecognized or dynamic command wrapper option', reachability, words[i], { wrapper: 'command' });
        return;
      }
      break;
    }
    if (i < words.length) processWords(words.slice(i), reachability, bindings, node, 'command', false);
  }

  function scanBuiltinWrapper(words, reachability, bindings, node) {
    let i = 1;
    if (words[i]) {
      const w = targetFromWord(words[i], source, bindings);
      if (w.resolved && w.value === '--') i++;
      else if ((w.resolved && w.value.startsWith('-')) || (!w.resolved && w.expression.startsWith('-'))) {
        addUnsupported('builtin', w.expression, 'unrecognized or dynamic builtin option', reachability, words[i], { wrapper: 'builtin' });
        return;
      }
    }
    if (i < words.length) {
      const delegated = targetFromWord(words[i], source, bindings);
      if (!delegated.resolved) {
        addUnsupported('builtin', delegated.expression, 'dynamic builtin name cannot be proven',
          reachability, words[i], { wrapper: 'builtin' });
        return;
      }
      const builtins = new Set([
        'source', '.', 'eval', 'exec', 'command', 'builtin',
        'read', 'export', 'declare', 'local', 'typeset', 'readonly', 'unset',
        'printf', 'mapfile', 'readarray', 'getopts',
      ]);
      if (!builtins.has(delegated.value)) return;
      processWords(words.slice(i), reachability, bindings, node, 'builtin', false);
    }
  }

  function scanNohup(words, reachability, bindings, node) {
    let i = 1;
    if (words[i]) {
      const w = targetFromWord(words[i], source, bindings);
      if (w.resolved && w.value === '--') i++;
      else if (w.resolved && (w.value === '--help' || w.value === '--version')) return;
      else if ((w.resolved && w.value.startsWith('-')) || (!w.resolved && w.expression.startsWith('-'))) {
        addUnsupported('nohup', w.expression, 'unrecognized or dynamic nohup option', reachability, words[i], { wrapper: 'nohup' });
        return;
      }
    }
    if (i < words.length) processWords(words.slice(i), reachability, bindings, node, 'nohup', false);
  }

  function scanNice(words, reachability, bindings, node) {
    let i = 1;
    while (i < words.length) {
      const w = targetFromWord(words[i], source, bindings);
      if (w.resolved && w.value === '--') {
        i++;
        break;
      }
      if (w.resolved && (w.value === '-n' || w.value === '--adjustment')) {
        if (!words[i + 1]) {
          addUnsupported('nice', w.expression, 'nice adjustment option requires an operand', reachability, words[i], { wrapper: 'nice' });
          return;
        }
        i += 2;
        continue;
      }
      if (w.resolved && (/^--adjustment=/.test(w.value) || /^-[0-9]+$/.test(w.value))) {
        i++;
        continue;
      }
      if ((w.resolved && w.value.startsWith('-')) || (!w.resolved && w.expression.startsWith('-'))) {
        addUnsupported('nice', w.expression, 'unrecognized or dynamic nice option sequence', reachability, words[i], { wrapper: 'nice' });
        return;
      }
      break;
    }
    if (i < words.length) processWords(words.slice(i), reachability, bindings, node, 'nice', false);
  }

  function scanTimeout(words, reachability, bindings, node) {
    let i = 1;
    while (i < words.length) {
      const w = targetFromWord(words[i], source, bindings);
      if (w.resolved && w.value === '--') {
        i++;
        break;
      }
      if (w.resolved && ['-k', '--kill-after', '-s', '--signal'].includes(w.value)) {
        if (!words[i + 1]) {
          addUnsupported('timeout', w.expression, 'timeout option requires an operand', reachability, words[i], { wrapper: 'timeout' });
          return;
        }
        i += 2;
        continue;
      }
      if (w.resolved && (/^--(?:kill-after|signal)=/.test(w.value) ||
          ['--foreground', '--preserve-status', '--verbose'].includes(w.value))) {
        i++;
        continue;
      }
      if (w.resolved && (w.value === '--help' || w.value === '--version')) return;
      if ((w.resolved && w.value.startsWith('-')) || (!w.resolved && w.expression.startsWith('-'))) {
        addUnsupported('timeout', w.expression, 'unrecognized or dynamic timeout option sequence', reachability, words[i], { wrapper: 'timeout' });
        return;
      }
      break;
    }
    if (!words[i]) return;
    i++; // DURATION
    if (i < words.length) processWords(words.slice(i), reachability, bindings, node, 'timeout', false);
  }

  function scanStdbuf(words, reachability, bindings, node) {
    let i = 1;
    while (i < words.length) {
      const w = targetFromWord(words[i], source, bindings);
      if (w.resolved && w.value === '--') {
        i++;
        break;
      }
      if (w.resolved && /^-[ioe].+/.test(w.value)) {
        i++;
        continue;
      }
      if (w.resolved && ['-i', '-o', '-e'].includes(w.value)) {
        if (!words[i + 1]) {
          addUnsupported('stdbuf', w.expression, 'stdbuf option requires a mode operand', reachability, words[i], { wrapper: 'stdbuf' });
          return;
        }
        i += 2;
        continue;
      }
      if (w.resolved && /^--(?:input|output|error)=/.test(w.value)) {
        i++;
        continue;
      }
      if (w.resolved && (w.value === '--help' || w.value === '--version')) return;
      if ((w.resolved && w.value.startsWith('-')) || (!w.resolved && w.expression.startsWith('-'))) {
        addUnsupported('stdbuf', w.expression, 'unrecognized or dynamic stdbuf option sequence', reachability, words[i], { wrapper: 'stdbuf' });
        return;
      }
      break;
    }
    if (i < words.length) processWords(words.slice(i), reachability, bindings, node, 'stdbuf', false);
  }

  function scanEval(words, reachability, bindings, node) {
    if (words.length <= 1) return;
    let start = 1;
    const first = targetFromWord(words[start], source, bindings);
    if (first.resolved && first.value === '--') {
      start++;
    } else if ((first.resolved && first.value.startsWith('-')) ||
        (!first.resolved && first.expression.startsWith('-'))) {
      addUnsupported('eval', first.expression, 'eval accepts only a leading -- option marker',
        reachability, words[start], { wrapper: 'eval', phase: 'options' });
      return;
    }
    if (start >= words.length) return;
    const pieces = [];
    for (let i = start; i < words.length; i++) {
      const w = targetFromWord(words[i], source, bindings);
      if (!w.resolved) {
        addUnsupported('eval', w.expression, 'dynamic eval code cannot be recursively scanned', reachability, words[i],
          { wrapper: 'eval', phase: 'code-text' });
        return;
      }
      pieces.push(w.value);
    }
    const code = pieces.join(' ');
    const nested = scanDependencyTargets(code, {
      bindings: Object.fromEntries(bindings),
      sourceSearchProof: options.sourceSearchProof || {},
      inlineParent: 'eval',
    });
    for (const rec of nested.targets) {
      const nestedReach = reachability === 'production' ? rec.reachability : 'candidate';
      addRecord({
        ...rec,
        reachability: nestedReach,
        status: nestedReach === 'production' ? rec.status : 'candidate',
        reason: nestedReach === 'production' ? rec.reason :
          (rec.reason || 'parent eval command is not proven reachable'),
        origin: 'eval',
      });
    }
  }

  function processWords(words, reachability, bindings, node, origin, allowFunctionLookup = true) {
    if (!words.length) return;
    const commandWord = targetFromWord(words[0], source, bindings);
    if (!commandWord.resolved) {
      addUnresolved('command-name', origin || 'shell', commandWord.expression,
        'dynamic command name prevents command-specific dependency classification', reachability, words[0]);
      return;
    }
    const command = commandWord.value;
    if (allowFunctionLookup && functions.has(command)) {
      if (reachability === 'production' && !functionStack.has(command)) {
        functionStack.add(command);
        const fn = functions.get(command);
        scanNode(fn.body, 'production', cloneBindings(bindings));
        invalidateBindings(bindings, collectBindingEffects(fn.body, new Set([command])));
        functionStack.delete(command);
      }
      return;
    }
    if (command === 'source' || command === '.') {
      resolveSourceLike(command, words[1], reachability, bindings, node);
      if (reachability === 'production') bindings.clear();
      return;
    }
    if (command === 'bash' || command === 'sh') {
      parseShellOptionWords(words, command, reachability, bindings, node);
      return;
    }
    if (command === 'node') {
      scanNodeCommand(words, reachability, bindings, node);
      return;
    }
    if (command === 'exec') {
      scanExec(words, reachability, bindings, node);
      return;
    }
    if (command === 'env') {
      scanEnv(words, reachability, bindings, node);
      return;
    }
    if (command === 'command') {
      scanCommandWrapper(words, reachability, bindings, node);
      return;
    }
    if (command === 'builtin') {
      scanBuiltinWrapper(words, reachability, bindings, node);
      return;
    }
    if (command === 'nohup') {
      scanNohup(words, reachability, bindings, node);
      return;
    }
    if (command === 'nice') {
      scanNice(words, reachability, bindings, node);
      return;
    }
    if (command === 'timeout') {
      scanTimeout(words, reachability, bindings, node);
      return;
    }
    if (command === 'stdbuf') {
      scanStdbuf(words, reachability, bindings, node);
      return;
    }
    if (command === 'eval') {
      scanEval(words, reachability, bindings, node);
      if (reachability === 'production') bindings.clear();
      return;
    }
    if (['read', 'export', 'declare', 'local', 'typeset', 'readonly', 'unset',
      'printf', 'mapfile', 'readarray', 'getopts'].includes(command)) {
      if (reachability === 'production') invalidateBindings(bindings, writerEffects(command, words, bindings));
      return;
    }
    if (command === 'xargs') {
      addUnsupported('xargs', commandWord.expression,
        'xargs command execution semantics are not modeled', reachability, words[0],
        { wrapper: 'xargs' });
      return;
    }
  }

  function scanWordNested(word, reachability, bindings) {
    if (!word || typeof word !== 'object') return;
    function visitPart(part) {
      if (!part || typeof part !== 'object') return;
      if ((part.type === 'CommandExpansion' || part.type === 'ProcessSubstitution') && part.script) {
        scanNode(part.script, reachability, cloneBindings(bindings));
        return;
      }
      if (part.type === 'DoubleQuoted' || Array.isArray(part.parts)) {
        for (const inner of part.parts || []) visitPart(inner);
      }
      if (part.operand) visitPart(part.operand);
    }
    for (const part of word.parts || []) visitPart(part);
  }

  function scanRedirectNested(redir, reachability, bindings) {
    if (!redir || typeof redir !== 'object') return;
    if (redir.target) scanWordNested(redir.target, reachability, bindings);
    if ((redir.operator === '<<' || redir.operator === '<<-') &&
        redir.heredocQuoted !== true && redir.body) {
      scanWordNested(redir.body, reachability, bindings);
    }
  }

  function inferAssignmentBinding(assignment, bindings) {
    if (!assignment || !assignment.name) return null;
    if (assignment.value) {
      const direct = shellWordValue(assignment.value, source, bindings);
      if (direct.resolved) return direct.value;
      const rawText = assignment.value.text || '';
      const text = rawText.endsWith('\r') ? rawText.slice(0, -1) : rawText;
      const bindingText = text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"' ? text.slice(1, -1) : text;
      if (fromPath && /^\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)$/.test(bindingText)) {
        return path.posix.dirname(fromPath);
      }
      const parts = assignment.value.parts || [];
      for (const part of parts) {
        if (!part || part.type !== 'DoubleQuoted') continue;
        for (const inner of part.parts || []) {
          if (!inner || inner.type !== 'CommandExpansion' || !inner.script) continue;
          const names = [];
          const candidates = [];
          (function collect(n) {
            if (!n || typeof n !== 'object') return;
            if (n.type === 'Command') {
              if (n.name && typeof n.name.value === 'string') names.push(n.name.value);
              const words = [];
              if (n.name) words.push(n.name);
              for (const w of n.suffix || []) words.push(w);
              for (const w of words) {
                const r = shellWordValue(w, source, bindings);
                if (r.resolved && /\.(?:cjs|mjs|js|sh)$/.test(r.value)) candidates.push(r.value);
              }
            }
            if (Array.isArray(n)) for (const v of n) collect(v);
            else for (const v of Object.values(n)) collect(v);
          })(inner.script);
          const unique = [...new Set(candidates)];
          if (unique.length === 1 && candidates.length >= 2 &&
              names.every((name) => ['cygpath', 'printf'].includes(name))) return unique[0];
        }
      }
    }
    return null;
  }

  function scanSimpleCommand(command, reachability, bindings) {
    for (const assignment of command.prefix || []) {
      if (assignment && assignment.type === 'Assignment' && assignment.value) {
        scanWordNested(assignment.value, reachability, bindings);
      }
    }
    if (command.name) scanWordNested(command.name, reachability, bindings);
    for (const w of command.suffix || []) scanWordNested(w, reachability, bindings);
    for (const redir of command.redirects || []) scanRedirectNested(redir, reachability, bindings);

    const words = [];
    if (command.name) words.push(command.name);
    for (const w of command.suffix || []) if (w && typeof w.text === 'string') words.push(w);
    if (words.length) processWords(words, reachability, bindings, command);

    const assignments = (command.prefix || []).filter((x) => x && x.type === 'Assignment');
    if (!command.name && reachability === 'production') {
      for (const assignment of assignments) {
        const binding = inferAssignmentBinding(assignment, bindings);
        if (binding !== null) bindings.set(assignment.name, binding);
        else bindings.delete(assignment.name);
      }
    }
  }

  function containsCommandBearingDescendant(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (value.type === 'Command' || value.type === 'Statement' || value.type === 'CompoundList' ||
        value.type === 'Pipeline' || value.type === 'AndOr' || value.type === 'Subshell' ||
        value.type === 'BraceGroup' || value.type === 'Function' || value.type === 'If' ||
        value.type === 'Case' || value.type === 'While' || value.type === 'For' ||
        value.type === 'Select' || value.type === 'Coproc') return true;
    if (Array.isArray(value)) return value.some((item) => containsCommandBearingDescendant(item, seen));
    for (const [key, child] of Object.entries(value)) {
      if (key === 'body' && value.operator && value.target) continue;
      if (containsCommandBearingDescendant(child, seen)) return true;
    }
    return false;
  }

  function scanNode(node, reachability, bindings) {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'Script':
      case 'CompoundList':
        for (const statement of node.commands || []) scanNode(statement, reachability, bindings);
        return;
      case 'Statement':
        scanNode(node.command, reachability, bindings);
        if (node.redirects) {
          for (const redir of node.redirects) scanRedirectNested(redir, reachability, bindings);
        }
        return;
      case 'Command':
        scanSimpleCommand(node, reachability, bindings);
        return;
      case 'Function':
        if (reachability === 'production' && node.name && typeof node.name.value === 'string') {
          functions.set(node.name.value, node);
        }
        scanNode(node.body, 'candidate', new Map());
        return;
      case 'BraceGroup':
        scanNode(node.body, reachability, bindings);
        return;
      case 'Subshell':
        scanNode(node.body, reachability, cloneBindings(bindings));
        return;
      case 'Select':
        addUnsupported('select', 'select', 'select command execution semantics are not modeled',
          reachability, node);
        return;
      case 'Coproc':
        addUnsupported('coproc', 'coproc', 'coproc command execution semantics are not modeled',
          reachability, node);
        return;
      case 'Pipeline':
        for (const child of node.commands || []) scanNode(child, reachability, cloneBindings(bindings));
        return;
      case 'AndOr':
        if (node.commands && node.commands[0]) scanNode(node.commands[0], reachability, bindings);
        for (let i = 1; i < (node.commands || []).length; i++) {
          scanCandidateAndInvalidate(node.commands[i], bindings);
        }
        return;
      case 'If':
        scanNode(node.clause, reachability, bindings);
        if (node.then) scanCandidateAndInvalidate(node.then, bindings);
        if (node.else) scanCandidateAndInvalidate(node.else, bindings);
        return;
      case 'Case': {
        scanWordNested(node.word, reachability, bindings);
        let patternIndex = 0;
        for (const item of node.items || []) {
          for (const pattern of item.pattern || []) {
            const first = patternIndex++ === 0;
            scanWordNested(pattern, first ? reachability : 'candidate',
              first ? bindings : new Map());
          }
          scanCandidateAndInvalidate(item.body, bindings);
        }
        return;
      }
      case 'While':
        scanNode(node.clause, reachability, bindings);
        scanCandidateAndInvalidate(node.body, bindings);
        return;
      case 'For':
        for (const word of node.wordlist || []) scanWordNested(word, reachability, bindings);
        if (node.name && typeof node.name.value === 'string') bindings.delete(node.name.value);
        else bindings.clear();
        scanCandidateAndInvalidate(node.body, bindings);
        return;
      case 'ArithmeticGroup':
      case 'ArithmeticCommandExpansion':
        return;
      default:
        if (containsCommandBearingDescendant(node)) {
          const construct = typeof node.type === 'string' ? node.type : 'unknown';
          addUnsupported(construct, construct,
            'unmodeled command-bearing AST construct: ' + construct,
            reachability, node);
        }
        return;
    }
  }

  scanNode(ast, 'production', initialBindings);

  return {
    schema: SCAN_SCHEMA,
    targets: [...records.values()],
  };
}

function scanDependencyTargets(input, options = {}) {
  const source = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  if (typeof source !== 'string') throw new TypeError('dependency scan source must be a string or Buffer');
  return createScanner(source, options);
}

module.exports = {
  SCAN_SCHEMA,
  bindProjector,
  scanDependencyTargets,
};
