'use strict';

const path = require('path');
const acorn = require('../../../guards/vendor/acorn.js');
let projector = null;

function bindProjector(api, verificationToken) {
  const adapter = require('./adapter.cjs');
  const accepts = adapter && adapter.__acceptPinnedVerificationToken;
  if (typeof accepts !== 'function' || !accepts(verificationToken) ||
      !api || typeof api.parseMaterialized !== 'function' ||
      typeof api.projectWord !== 'function' ||
      typeof api.hasUnquotedRuntimePattern !== 'function' ||
      typeof api.acceptsVerificationToken !== 'function' ||
      !api.acceptsVerificationToken(verificationToken)) {
    throw new TypeError('target-rules requires the adapter-verified projector token');
  }
  projector = api;
}

function requireProjector() {
  if (!projector) throw new TypeError('target-rules must be initialized through adapter.cjs');
  return projector;
}
const { ERROR_CODES } = require('./protocol.cjs');

const SCAN_SCHEMA = 'axmem-p2-bash-target-scan/v1';
const POSITIONAL_UNKNOWN = '__axmem_positional_parameters_unknown__';

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
        if (/^[0-9]+$/.test(name) && bindings.get(POSITIONAL_UNKNOWN) === true) return null;
        if (!bindings.has(name)) return null;
        out += String(bindings.get(name));
        continue;
      }
      if (part.type === 'ParameterExpansion' && !part.operator && !part.index) {
        const name = part.parameter;
        if (/^[0-9]+$/.test(String(name)) && bindings.get(POSITIONAL_UNKNOWN) === true) return null;
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
  let functions = options._functions instanceof Map ? new Map(options._functions) : new Map();
  let exportedFunctions = new Set(options._exportedFunctions || []);
  let poisonedFunctions = new Set(options._poisonedFunctions || []);
  let functionTableUnknown = options._functionTableUnknown === true;
  let commandResolutionUnknown = options._commandResolutionUnknown === true;
  let cwdUnknown = options._cwdUnknown === true;
  let posixMode = options._posixMode === true;
  let bashEnvActive = options._bashEnvActive === true;
  let positional1Values = Array.isArray(options.productionArgv1Values) &&
      options.productionArgv1Values.every((x) => typeof x === 'string') &&
      options.productionArgv1Unknown !== true ?
    new Set(options.productionArgv1Values) : null;
  let currentDormantRule = typeof options._dormantRule === 'string' ? options._dormantRule : null;
  let functionDepth = 0;
  const records = new Map();
  const functionStack = new Set();
  const assumptions = new Set();

  function walkAst(value, visit, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    visit(value);
    if (Array.isArray(value)) {
      for (const item of value) walkAst(item, visit, seen);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'body' && value.operator && value.target) continue;
      walkAst(child, visit, seen);
    }
  }

  function functionNamesIn(value) {
    const names = new Set();
    walkAst(value, (node) => {
      if (node.type === 'Function' && node.name && typeof node.name.value === 'string') {
        names.add(node.name.value);
      }
    });
    return names;
  }

  const fileFunctionNames = functionNamesIn(ast);
  const productionInvocationPaths = Array.isArray(options.productionInvocationPaths) ?
    options.productionInvocationPaths.filter((x) => typeof x === 'string').map((x) => x.replace(/\\/g, '/')) : [];
  const uniqueInvocationPaths = [...new Set(productionInvocationPaths)];
  const productionSourcePaths = Array.isArray(options.productionSourcePaths) ?
    options.productionSourcePaths.filter((x) => typeof x === 'string').map((x) => x.replace(/\\/g, '/')) : [];
  const uniqueSourcePaths = [...new Set(productionSourcePaths)];
  function singleAbsoluteSpelling(values) {
    if (values.length !== 1) return null;
    const value = values[0];
    return path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value) ? value : null;
  }
  const directInvocationSpelling = options.sourcedOnProductionPath !== true ?
    singleAbsoluteSpelling(uniqueInvocationPaths) : null;
  const bashSourceSpelling = options.sourcedOnProductionPath === true ?
    singleAbsoluteSpelling(uniqueSourcePaths) : directInvocationSpelling;
  const localLiteralCalls = new Set();
  let localDynamicCall = false;
  walkAst(ast, (node) => {
    if (!node || node.type !== 'Command' || !node.name) return;
    const commandWord = shellWordValue(node.name, source, new Map());
    if (commandWord.resolved) localLiteralCalls.add(commandWord.value);
    else localDynamicCall = true;
  });
  const requestedNeverCalledFunctions = options.proveWholeClosureFunctions === true ?
    new Set(options.wholeClosureNeverCalledFunctions || []) : new Set();
  const closureNeverCalledFunctions = new Set([...requestedNeverCalledFunctions].filter((name) =>
    fileFunctionNames.has(name) && !localLiteralCalls.has(name) && !localDynamicCall));

  function commandProofSafe(name, spelling) {
    return !!spelling &&
      !functionTableUnknown && !commandResolutionUnknown &&
      !functions.has(name) && !poisonedFunctions.has(name) && !fileFunctionNames.has(name);
  }

  function specialInvocationWordValue(word) {
    if (!word || typeof word.text !== 'string') return null;
    const raw = word.text.endsWith('\r') ? word.text.slice(0, -1) : word.text;
    if (raw === '"$0"') return directInvocationSpelling;
    if (raw === '"${BASH_SOURCE[0]}"') return bashSourceSpelling;

    let m = /^"\$\(dirname "\$0"\)([^"]*)"$/.exec(raw);
    if (m && commandProofSafe('dirname', directInvocationSpelling)) {
      return path.posix.dirname(directInvocationSpelling) + m[1];
    }
    m = /^"\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)([^"]*)"$/.exec(raw);
    if (m && commandProofSafe('dirname', bashSourceSpelling)) {
      return path.posix.dirname(bashSourceSpelling) + m[1];
    }
    if (raw === '"$(cd "$(dirname "$0")" && pwd)"' &&
        commandProofSafe('dirname', directInvocationSpelling) &&
        commandProofSafe('cd', directInvocationSpelling) &&
        commandProofSafe('pwd', directInvocationSpelling)) {
      return path.posix.dirname(directInvocationSpelling);
    }
    if (raw === '"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"' &&
        commandProofSafe('dirname', bashSourceSpelling) &&
        commandProofSafe('cd', bashSourceSpelling) &&
        commandProofSafe('pwd', bashSourceSpelling)) {
      return path.posix.dirname(bashSourceSpelling);
    }
    return null;
  }

  function targetFromWord(word, ignoredSource, bindings) {
    if (!word) return { expression: '', resolved: false, value: null, word: null };
    const v = shellWordValue(word, source, bindings);
    if (v.resolved) {
      return { expression: word.text, resolved: true, value: v.value, word: v.projected };
    }
    const special = specialInvocationWordValue(word);
    if (special !== null) {
      return { expression: word.text, resolved: true, value: special, word: v.projected };
    }
    return { expression: word.text, resolved: false, value: null, word: v.projected };
  }

  const fileDefinesTerminatorFunction =
    fileFunctionNames.has('exit') || fileFunctionNames.has('exec') || fileFunctionNames.has('return');

  const fileDisablesControlFlowShortcuts = (() => {
    if (fileDefinesTerminatorFunction || fileHasEscapingFunctionLoopControl()) return true;
    let disabled = false;
    walkAst(ast, (node) => {
      if (disabled || !node || node.type !== 'Command' ||
          !node.name || typeof node.name.value !== 'string') return;
      const command = node.name.value;
      const args = (node.suffix || []).map((word) =>
        word && typeof word.value === 'string' ? word.value : null).filter((x) => x !== null);
      if (command === 'enable') {
        disabled = true;
        return;
      }
      if (command === 'shopt') {
        const setIndex = args.indexOf('-s');
        if (setIndex >= 0 && args.slice(setIndex + 1).some((x) => x === 'extdebug' || x === 'execfail')) {
          disabled = true;
        }
        return;
      }
      if (command === 'set') {
        if (args.includes('-T')) disabled = true;
        for (let i = 0; i + 1 < args.length; i++) {
          if (args[i] === '-o' && args[i + 1] === 'functrace') disabled = true;
        }
      }
    });
    return disabled;
  })();

  function snapshotShellState() {
    return {
      functions: new Map(functions),
      exportedFunctions: new Set(exportedFunctions),
      poisonedFunctions: new Set(poisonedFunctions),
      functionTableUnknown,
      commandResolutionUnknown,
      cwdUnknown,
      posixMode,
      bashEnvActive,
      positional1Values: positional1Values ? new Set(positional1Values) : null,
    };
  }

  function withShellState(state, fn) {
    const saved = snapshotShellState();
    functions = state.functions;
    exportedFunctions = state.exportedFunctions;
    poisonedFunctions = state.poisonedFunctions;
    functionTableUnknown = state.functionTableUnknown;
    commandResolutionUnknown = state.commandResolutionUnknown;
    cwdUnknown = state.cwdUnknown;
    posixMode = state.posixMode;
    bashEnvActive = state.bashEnvActive;
    positional1Values = state.positional1Values ? new Set(state.positional1Values) : null;
    try {
      return fn();
    } finally {
      functions = saved.functions;
      exportedFunctions = saved.exportedFunctions;
      poisonedFunctions = saved.poisonedFunctions;
      functionTableUnknown = saved.functionTableUnknown;
      commandResolutionUnknown = saved.commandResolutionUnknown;
      cwdUnknown = saved.cwdUnknown;
      posixMode = saved.posixMode;
      bashEnvActive = saved.bashEnvActive;
      positional1Values = saved.positional1Values ? new Set(saved.positional1Values) : null;
    }
  }

  function cloneShellState() {
    return snapshotShellState();
  }

  function poisonFunctionNames(names) {
    for (const name of names || []) {
      functions.delete(name);
      exportedFunctions.delete(name);
      poisonedFunctions.add(name);
    }
  }

  function clearKnownFunctions() {
    functions.clear();
    exportedFunctions.clear();
    poisonedFunctions.clear();
  }

  function clearFunctionProof() {
    functions.clear();
    exportedFunctions.clear();
    poisonedFunctions.clear();
    functionTableUnknown = true;
  }
  function markFunctionsUnknownPreservingPoison() {
    functions.clear();
    exportedFunctions.clear();
    functionTableUnknown = true;
  }

  function emptyEffects() {
    return {
      names: new Set(),
      clearAll: false,
      poisonFunctions: new Set(),
      clearFunctions: false,
      functionsUnknown: false,
      commandResolutionUnknown: false,
      cwdUnknown: false,
      positionalUnknown: false,
    };
  }

  function poisonEffects(effects) {
    effects.clearAll = true;
    effects.clearFunctions = true;
    effects.functionsUnknown = true;
    effects.cwdUnknown = true;
    effects.positionalUnknown = true;
    return effects;
  }

  function mergeEffects(into, other) {
    if (!other) return into;
    if (other.clearAll) into.clearAll = true;
    if (other.clearFunctions) into.clearFunctions = true;    if (other.functionsUnknown) into.functionsUnknown = true;
    if (other.commandResolutionUnknown) into.commandResolutionUnknown = true;
    if (other.cwdUnknown) into.cwdUnknown = true;
    if (other.positionalUnknown) into.positionalUnknown = true;
    for (const name of other.names || []) into.names.add(name);
    for (const name of other.poisonFunctions || []) into.poisonFunctions.add(name);
    return into;
  }

  function applyEffects(bindings, effects) {
    if (!effects) return;
    if (effects.clearAll) bindings.clear();
    else for (const name of effects.names) bindings.delete(name);
    if (effects.functionsUnknown) {
      clearFunctionProof();
    } else if (effects.clearFunctions) {
      functions.clear();
      poisonedFunctions.clear();
    }
    poisonFunctionNames(effects.poisonFunctions);
    if (effects.commandResolutionUnknown) commandResolutionUnknown = true;
    if (effects.cwdUnknown) cwdUnknown = true;
    if (effects.positionalUnknown) positional1Values = null;
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

  function addVariableName(effects, word, bindings) {
    const got = wordVariableName(word, bindings);
    if (got.unknown) effects.clearAll = true;
    else if (got.name) effects.names.add(got.name);
  }

  function readWriterEffects(args, bindings) {
    const effects = emptyEffects();
    const variables = [];
    let i = 0;
    let endOptions = false;
    while (i < args.length) {
      const w = targetFromWord(args[i], source, bindings);
      if (!w.resolved) {
        effects.clearAll = true;
        return effects;
      }
      const value = w.value;
      if (!endOptions && value === '--') {
        endOptions = true;
        i++;
        continue;
      }
      if (!endOptions && value.length > 1 && value[0] === '-') {
        let rest = value.slice(1);
        let consumedOperand = false;
        while (rest.length > 0) {
          const flag = rest[0];
          rest = rest.slice(1);
          if ('adinNptu'.includes(flag)) {
            let operandWord = null;
            if (rest.length > 0) {
              const fake = { text: rest, value: rest, pos: args[i].pos, end: args[i].end };
              operandWord = fake;
              rest = '';
            } else {
              operandWord = args[i + 1] || null;
              if (operandWord) i++;
            }
            if (!operandWord) {
              effects.clearAll = true;
              return effects;
            }
            if (flag === 'a') addVariableName(effects, operandWord, bindings);
            consumedOperand = true;
            break;
          }
          if (!'ersE'.includes(flag)) {
            effects.clearAll = true;
            return effects;
          }
        }
        i++;
        if (consumedOperand) continue;
        continue;
      }
      variables.push(args[i]);
      i++;
    }
    if (variables.length === 0 && effects.names.size === 0 && !effects.clearAll) {
      effects.names.add('REPLY');
    } else {
      for (const word of variables) addVariableName(effects, word, bindings);
    }
    return effects;
  }

  function printfWriterEffects(args, bindings) {
    const effects = emptyEffects();
    for (let i = 0; i < args.length; i++) {
      const w = targetFromWord(args[i], source, bindings);
      if (!w.resolved) {
        effects.clearAll = true;
        return effects;
      }
      if (w.value === '--') break;
      if (w.value === '-v') {
        if (!args[i + 1]) effects.clearAll = true;
        else addVariableName(effects, args[i + 1], bindings);
        return effects;
      }
      if (/^-v[A-Za-z_][A-Za-z0-9_]*$/.test(w.value)) {
        effects.names.add(w.value.slice(2));
        return effects;
      }
      if (!w.value.startsWith('-')) break;
    }
    return effects;
  }

  function mapfileWriterEffects(args, bindings) {
    const effects = emptyEffects();
    let arrayWord = null;
    for (let i = 0; i < args.length; i++) {
      const w = targetFromWord(args[i], source, bindings);
      if (!w.resolved) {
        effects.clearAll = true;
        return effects;
      }
      if (w.value === '--') {
        arrayWord = args[i + 1] || null;
        break;
      }
      if (['-n', '-O', '-s', '-u', '-C', '-c'].includes(w.value)) {
        if (!args[i + 1]) {
          effects.clearAll = true;
          return effects;
        }
        i++;
        continue;
      }
      if (w.value === '-t') continue;
      if (w.value.startsWith('-')) {
        effects.clearAll = true;
        return effects;
      }
      arrayWord = args[i];
    }
    if (arrayWord) addVariableName(effects, arrayWord, bindings);
    else effects.names.add('MAPFILE');
    return effects;
  }

  function writerEffects(command, words, bindings) {
    const effects = emptyEffects();
    const args = words.slice(1);
    if (['declare', 'local', 'typeset'].includes(command)) {
      const opts = args.map((word) => targetFromWord(word, source, bindings))
        .filter((x) => x.resolved && x.value.startsWith('-')).map((x) => x.value).join('');
      if (opts.includes('n')) {
        effects.clearAll = true;
        return effects;
      }
    }
    if (['export', 'declare', 'local', 'typeset', 'readonly'].includes(command)) {
      for (const word of args) {
        const w = targetFromWord(word, source, bindings);
        if (!w.resolved) {
          effects.clearAll = true;
          return effects;
        }
        if (w.value.startsWith('-')) continue;
        addVariableName(effects, word, bindings);
      }
      return effects;
    }
    if (command === 'unset') {
      let functionMode = false;
      for (const word of args) {
        const w = targetFromWord(word, source, bindings);
        if (!w.resolved) {
          effects.clearAll = true;
          effects.clearFunctions = true;
          return effects;
        }
        if (w.value === '-f') {
          functionMode = true;
          continue;
        }
        if (w.value.startsWith('-')) continue;
        const got = wordVariableName(word, bindings);
        if (got.unknown || !got.name) {
          if (functionMode) effects.clearFunctions = true;
          else effects.clearAll = true;
        } else if (functionMode) {
          effects.poisonFunctions.add(got.name);
        } else {
          effects.names.add(got.name);
        }
      }
      return effects;
    }
    if (command === 'read') return readWriterEffects(args, bindings);
    if (command === 'printf') return printfWriterEffects(args, bindings);
    if (command === 'mapfile' || command === 'readarray') return mapfileWriterEffects(args, bindings);
    if (command === 'getopts') {
      effects.names.add('OPTIND');
      effects.names.add('OPTARG');
      if (args[1]) addVariableName(effects, args[1], bindings);
      else effects.clearAll = true;
      return effects;
    }
    if (command === 'wait') {
      for (let i = 0; i < args.length; i++) {
        const w = targetFromWord(args[i], source, bindings);
        if (!w.resolved) {
          effects.clearAll = true;
          return effects;
        }
        if (w.value === '-p') {
          if (!args[i + 1]) effects.clearAll = true;
          else addVariableName(effects, args[i + 1], bindings);
          return effects;
        }
        if (/^-p[A-Za-z_]/.test(w.value)) {
          effects.names.add(w.value.slice(2));
          return effects;
        }
      }
      return effects;
    }
    return effects;
  }

  function arithmeticEffects(value) {
    const effects = emptyEffects();
    function literalLvalue(node) {
      if (node && node.type === 'ArithmeticWord' &&
          typeof node.value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.value)) {
        return node.value;
      }
      return null;
    }
    walkAst(value, (node) => {
      if (node.type === 'ArithmeticBinary' &&
          ['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|='].includes(node.operator)) {
        const name = literalLvalue(node.left);
        if (name) effects.names.add(name);
        else effects.clearAll = true;
      }
      if (node.type === 'ArithmeticUnary' && ['++', '--'].includes(node.operator)) {
        const operand = node.argument || node.operand || node.expression;
        const name = literalLvalue(operand);
        if (name) effects.names.add(name);
        else effects.clearAll = true;
      }
      if (node.type === 'ParameterExpansion' && ['=', ':='].includes(node.operator)) {
        if (typeof node.parameter === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.parameter)) {
          effects.names.add(node.parameter);
        } else {
          effects.clearAll = true;
        }
      }
    });
    return effects;
  }

  function wordEffects(word) {
    const effects = emptyEffects();
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CommandExpansion' || node.type === 'ProcessSubstitution') return;
      if (node.type === 'ArithmeticExpansion' || node.type === 'ParameterExpansion') {
        mergeEffects(effects, arithmeticEffects(node));
      }
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      for (const child of Object.values(node)) visit(child);
    }
    visit(word && word.parts || []);
    return effects;
  }

  function letEffects(words) {
    const effects = emptyEffects();
    for (const word of words.slice(1)) {
      const w = targetFromWord(word, source, new Map());
      if (!w.resolved) {
        effects.clearAll = true;
        continue;
      }
      const text = w.value;
      const re = /(?:^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+\+|--|(?:<<|>>|[+\-*\/%&^|])?=)/g;
      let hit = false;
      let m;
      while ((m = re.exec(text)) !== null) {
        effects.names.add(m[1]);
        hit = true;
      }
      if (!hit && /[=+]{2}|--/.test(text)) effects.clearAll = true;
    }
    return effects;
  }

  function unsupportedWordReason(word) {
    const raw = word && typeof word.text === 'string' ? word.text : '';
    if (raw.includes('$((')) return 'arithmetic expansion in a shell word is outside the supported subset';
    if (/\$\{[A-Za-z_][A-Za-z0-9_]*(?::?=)/.test(raw)) {
      return 'parameter assignment expansion is outside the supported subset';
    }
    if (/\[[^\]]*(?:\+\+|--|[A-Za-z_][A-Za-z0-9_]*\s*(?:<<=|>>=|[+\-*\/%&^|]?=))[^\]]*\]/.test(raw)) {
      return 'assignment in an array subscript is outside the supported subset';
    }
    return null;
  }

  function testCommandHasAssignment(node) {
    let hit = false;
    walkAst(node && node.expression, (part) => {
      if (hit || !part || typeof part !== 'object') return;
      for (const value of [part.text, part.value]) {
        if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]+\])?=[^=]/.test(value)) {
          hit = true;
          break;
        }
      }
    });
    return hit;
  }

  function redirectUnsupportedReason(redir) {
    if (!redir || typeof redir !== 'object') return null;
    if (typeof redir.variableName === 'string' && redir.variableName) {
      return 'file-descriptor allocation writes a shell variable';
    }
    return redir.target ? unsupportedWordReason(redir.target) : null;
  }

  function poisonUnsupported(construct, reason, reachability, node, bindings, expression) {
    addUnsupported(construct, expression || construct, reason, reachability, node);
    bindings.clear();
    clearFunctionProof();
    cwdUnknown = true;
  }

  function invalidatePositionalParameters(bindings) {
    for (const key of [...bindings.keys()]) if (/^[0-9]+$/.test(String(key))) bindings.delete(key);
    bindings.set(POSITIONAL_UNKNOWN, true);
  }

  function containsLiteralCommand(value, names) {
    let found = false;
    walkAst(value, (node) => {
      if (found || !node || node.type !== 'Command' || !node.name || typeof node.name.value !== 'string') return;
      if (names.has(node.name.value)) found = true;
    });
    return found;
  }

  function loopControlLevel(command) {
    if (!command || command.type !== 'Command' || !command.name ||
        (command.name.value !== 'break' && command.name.value !== 'continue')) return null;
    const args = command.suffix || [];
    if (args.length === 0) return 1;
    if (args.length !== 1 || !args[0] || typeof args[0].text !== 'string' ||
        !/^[0-9]+$/.test(args[0].text)) return Infinity;
    const value = Number(args[0].text);
    return Number.isSafeInteger(value) ? value : Infinity;
  }

  function hasEscapingLoopControl(value) {
    let escaped = false;
    function visit(node, loopDepth, isRoot = false) {
      if (escaped || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, loopDepth, false);
        return;
      }
      if (!isRoot && node.type === 'Function') return;
      const level = loopControlLevel(node);
      if (level !== null && level > loopDepth) {
        escaped = true;
        return;
      }
      const childDepth = ['For', 'While', 'Select'].includes(node.type) ? loopDepth + 1 : loopDepth;
      for (const [key, child] of Object.entries(node)) {
        if (key === 'body' && node.operator && node.target) continue;
        visit(child, childDepth, false);
      }
    }
    visit(value, 0, true);
    return escaped;
  }

  function fileHasEscapingFunctionLoopControl() {
    let escaped = false;
    walkAst(ast, (node) => {
      if (escaped || !node || node.type !== 'Function') return;
      if (hasEscapingLoopControl(node.body)) escaped = true;
    });
    return escaped;
  }

  function execHasCommandOperand(node) {
    const words = node && Array.isArray(node.suffix) ? node.suffix : [];
    let i = 0;
    while (i < words.length) {
      const value = words[i] && typeof words[i].value === 'string' ? words[i].value : null;
      if (value === null) return false;
      if (value === '--') { i++; break; }
      if (value === '-a') {
        if (!words[i + 1] || typeof words[i + 1].value !== 'string') return false;
        i += 2;
        continue;
      }
      if (/^-[cl]+$/.test(value)) { i++; continue; }
      if (value.startsWith('-')) return false;
      break;
    }
    return i < words.length;
  }

  function nodeTerminates(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'Statement') {
      if (node.background || (node.redirects || []).length > 0) return false;
      return nodeTerminates(node.command);
    }
    if (node.type === 'Command') {
      if ((node.redirects || []).length > 0 || !node.name || typeof node.name.value !== 'string') return false;
      if (node.name.value === 'exit') return true;
      if (node.name.value === 'exec') return execHasCommandOperand(node);
      return false;
    }
    if (node.type === 'BraceGroup') return nodeTerminates(node.body);
    if (node.type === 'CompoundList' || node.type === 'Script') {
      const commands = node.commands || [];
      if (commands.length === 0 || hasEscapingLoopControl(node)) return false;
      return nodeTerminates(commands[commands.length - 1]);
    }
    if (node.type === 'If') {
      return !!node.then && !!node.else && nodeTerminates(node.then) && nodeTerminates(node.else);
    }
    return false;
  }

  function nodeReturns(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'Statement') {
      if (node.background || (node.redirects || []).length > 0) return false;
      return nodeReturns(node.command);
    }
    return node.type === 'Command' && (node.redirects || []).length === 0 &&
      node.name && node.name.value === 'return';
  }

  function scopeTerminator(node) {
    if (fileDisablesControlFlowShortcuts) return false;
    if (nodeTerminates(node)) return true;
    return functionDepth > 0 && nodeReturns(node);
  }

  function terminatingArm(node) {
    return options.disableTerminatingArms !== true &&
      !fileDisablesControlFlowShortcuts && nodeTerminates(node);
  }

  function collectEffects(node, localFunctions = new Map(functions), seenFunctions = new Set()) {
    const effects = emptyEffects();
    if (!node || typeof node !== 'object') return effects;
    switch (node.type) {
      case 'Script':
      case 'CompoundList':
        for (const child of node.commands || []) mergeEffects(effects, collectEffects(child, localFunctions, seenFunctions));
        return effects;
      case 'Statement': {
        if (node.background) {
          for (const name of functionNamesIn(node.command)) effects.poisonFunctions.add(name);
          return effects;
        }
        const statementEffects = collectEffects(node.command, localFunctions, seenFunctions);
        for (const redir of node.redirects || []) {
          if (redirectUnsupportedReason(redir)) return poisonEffects(statementEffects);
        }
        return statementEffects;
      }
      case 'Command': {
        for (const assignment of node.prefix || []) {
          if (assignment && assignment.type === 'Assignment') {
            if (assignment.value) mergeEffects(effects, wordEffects(assignment.value));
            effects.names.add(assignment.name);
          }
        }
        if (!node.name) return effects;
        mergeEffects(effects, wordEffects(node.name));
        for (const word of node.suffix || []) mergeEffects(effects, wordEffects(word));
        for (const redir of node.redirects || []) if (redir && redir.target) mergeEffects(effects, wordEffects(redir.target));
        const words = [node.name, ...(node.suffix || []).filter((w) => w && typeof w.text === 'string')];
        const unsupportedSyntax = [
          ...(node.prefix || []).filter((x) => x && x.type === 'Assignment' && x.value).map((x) => x.value),
          node.name,
          ...(node.suffix || []),
        ].map((word) => unsupportedWordReason(word)).find(Boolean) ||
          (node.redirects || []).map((redir) => redirectUnsupportedReason(redir)).find(Boolean);
        if (unsupportedSyntax) return poisonEffects(effects);
        let resolved = targetFromWord(node.name, source, new Map());
        if (!resolved.resolved) {
          effects.clearAll = true;
          effects.clearFunctions = true;          effects.functionsUnknown = true;
          return effects;
        }
        let command = resolved.value;
        if (command === 'command' || command === 'builtin') {
          let i = 1;
          while (i < words.length) {
            const w = targetFromWord(words[i], source, new Map());
            if (!w.resolved) {
              effects.clearAll = true;
              effects.clearFunctions = true;              effects.functionsUnknown = true;
              return effects;
            }
            if (w.value === '--') { i++; break; }
            if (w.value.startsWith('-')) { i++; continue; }
            break;
          }
          if (!words[i]) return effects;
          resolved = targetFromWord(words[i], source, new Map());
          if (!resolved.resolved) {
            effects.clearAll = true;
            effects.clearFunctions = true;            effects.functionsUnknown = true;
            return effects;
          }
          command = resolved.value;
          words.splice(0, i);
        }
        const argValues = words.slice(1).map((word) => targetFromWord(word, source, new Map()))
          .filter((x) => x.resolved).map((x) => x.value);
        if (['trap', 'mapfile', 'readarray', 'let', 'readonly'].includes(command)) {
          return poisonEffects(effects);
        }
        if (['declare', 'local', 'typeset'].includes(command) && argValues.some((x) => x.startsWith('-'))) {
          return poisonEffects(effects);
        }
        if (command === 'set' && (argValues.includes('-n') ||
            argValues.some((x, index) => x === '-o' && argValues[index + 1] === 'posix'))) {
          return poisonEffects(effects);
        }
        if (localFunctions.has(command) && !seenFunctions.has(command)) {
          const nextSeen = new Set(seenFunctions);
          nextSeen.add(command);
          const functionEffects = collectEffects(localFunctions.get(command).body, localFunctions, nextSeen);
          functionEffects.positionalUnknown = false;
          mergeEffects(effects, functionEffects);
          return effects;
        }
        if (poisonedFunctions.has(command) || functionTableUnknown) {
          effects.clearAll = true;
          effects.clearFunctions = true;          effects.functionsUnknown = true;
          return effects;
        }
        if (command === 'source' || command === '.' || command === 'eval') {
          effects.clearAll = true;
          effects.clearFunctions = true;          effects.functionsUnknown = true;
          effects.positionalUnknown = true;
          return effects;
        }
        if (['read', 'export', 'declare', 'local', 'typeset', 'readonly', 'unset',
          'printf', 'mapfile', 'readarray', 'getopts', 'wait'].includes(command)) {
          mergeEffects(effects, writerEffects(command, words, new Map()));
          return effects;
        }
        if (command === 'let') {
          mergeEffects(effects, letEffects(words));
          return effects;
        }
        if (['cd', 'pushd', 'popd'].includes(command)) {
          effects.clearAll = true;
          effects.clearFunctions = true;
          effects.cwdUnknown = true;
          return effects;
        }
        if (['set', 'shift', 'shopt', 'enable', 'alias', 'hash'].includes(command)) {
          effects.clearAll = true;
          effects.clearFunctions = true;
          if (command === 'shift' || (command === 'set' && argValues[0] === '--')) effects.positionalUnknown = true;
          if (['enable', 'alias', 'hash'].includes(command)) effects.commandResolutionUnknown = true;
          return effects;
        }
        return effects;
      }
      case 'Function':
        if (node.name && typeof node.name.value === 'string') {
          localFunctions.set(node.name.value, node);
          effects.poisonFunctions.add(node.name.value);
        } else {
          effects.clearFunctions = true;
        }
        return effects;
      case 'BraceGroup':
        return collectEffects(node.body, localFunctions, seenFunctions);
      case 'Subshell':
        for (const name of functionNamesIn(node.body)) effects.poisonFunctions.add(name);
        return effects;
      case 'Pipeline': {
        const commands = node.commands || [];
        if (commands.length === 1) return collectEffects(commands[0], localFunctions, seenFunctions);
        for (const child of commands) {
          for (const name of functionNamesIn(child)) effects.poisonFunctions.add(name);
        }
        if (commands.length > 0) {
          mergeEffects(effects, collectEffects(commands[commands.length - 1], new Map(localFunctions), seenFunctions));
        }
        return effects;
      }
      case 'AndOr':
        if (node.commands && node.commands[0]) mergeEffects(effects, collectEffects(node.commands[0], localFunctions, seenFunctions));
        for (let i = 1; i < (node.commands || []).length; i++) {
          const child = node.commands[i];
          if (!terminatingArm(child)) mergeEffects(effects, collectEffects(child, new Map(localFunctions), seenFunctions));
        }
        return effects;
      case 'If':
        mergeEffects(effects, collectEffects(node.clause, localFunctions, seenFunctions));
        if (node.then && !terminatingArm(node.then)) mergeEffects(effects, collectEffects(node.then, new Map(localFunctions), seenFunctions));
        if (node.else && !terminatingArm(node.else)) mergeEffects(effects, collectEffects(node.else, new Map(localFunctions), seenFunctions));
        return effects;
      case 'Case':
        if (unsupportedWordReason(node.word)) return poisonEffects(effects);
        mergeEffects(effects, wordEffects(node.word));
        for (const item of node.items || []) {
          for (const pattern of item.pattern || []) {
            if (unsupportedWordReason(pattern)) return poisonEffects(effects);
            mergeEffects(effects, wordEffects(pattern));
          }
          if (!terminatingArm(item.body)) mergeEffects(effects, collectEffects(item.body, new Map(localFunctions), seenFunctions));
        }
        return effects;
      case 'While':
        mergeEffects(effects, collectEffects(node.clause, localFunctions, seenFunctions));
        if (!terminatingArm(node.body)) mergeEffects(effects, collectEffects(node.body, new Map(localFunctions), seenFunctions));
        return effects;
      case 'For':
        for (const word of node.wordlist || []) {
          if (unsupportedWordReason(word)) return poisonEffects(effects);
          mergeEffects(effects, wordEffects(word));
        }
        if (node.name && typeof node.name.value === 'string') effects.names.add(node.name.value);
        else effects.clearAll = true;
        if (!terminatingArm(node.body)) mergeEffects(effects, collectEffects(node.body, new Map(localFunctions), seenFunctions));
        return effects;
      case 'ArithmeticCommand':
      case 'ArithmeticFor':
      case 'TestCommand':
      case 'Select':
      case 'Coproc':
      default:
        return poisonEffects(effects);
    }
  }

  function scanIsolated(node, reachability, bindings) {
    const names = functionNamesIn(node);
    const innerState = cloneShellState();
    withShellState(innerState, () => scanNode(node, reachability, cloneBindings(bindings)));
    poisonFunctionNames(names);
  }

  function withDormantRule(rule, fn) {
    const saved = currentDormantRule;
    currentDormantRule = rule || null;
    try {
      return fn();
    } finally {
      currentDormantRule = saved;
    }
  }

  function scanBranchAndInvalidate(node, bindings, branchReachability = 'conditional', dormantRule = null) {
    if (!node) return;
    const innerState = cloneShellState();
    const rule = branchReachability === 'dormant' ? (dormantRule || currentDormantRule) : null;
    withShellState(innerState, () => withDormantRule(rule,
      () => scanNode(node, branchReachability, cloneBindings(bindings))));
    if (branchReachability === 'dormant') return;
    if (terminatingArm(node)) {
      assumptions.add('no-exit-function');
      return;
    }
    applyEffects(bindings, collectEffects(node));
  }

  function childConditionalReachability(parentReachability) {
    return parentReachability === 'dormant' ? 'dormant' : 'conditional';
  }

  function rank(reachability) {
    if (reachability === 'production') return 3;
    if (reachability === 'conditional') return 2;
    return 1;
  }

  function addRecord(record) {
    const key = [
      record.kind,
      record.command,
      record.expression,
      record.span ? record.span.start : '',
      record.span ? record.span.end : '',
      record.target || '',
      record.origin || '',
    ].join('\u0000');
    const old = records.get(key);
    if (!old || rank(record.reachability) > rank(old.reachability)) records.set(key, record);
  }

  function addTarget(kind, command, expression, target, resolved, reason, reachability, node, extra = {}) {
    const status = resolved ? 'resolved' : 'unresolved';
    const finalReason = resolved ? (reason || null) : (reason || 'target cannot be proven statically');
    addRecord({
      kind,
      command,
      expression,
      target: resolved ? target : null,
      status,
      reason: finalReason,
      reachability,
      span: spanOf(node),
      ...(reachability === 'dormant' && currentDormantRule ? { dormantRule: currentDormantRule } : {}),
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
      const relative = !path.posix.isAbsolute(t.value) && !/^[A-Za-z]:[\\/]/.test(t.value);
      if (cwdUnknown && relative) {
        addUnresolved('shell-source', command, t.expression,
          'relative source target after shell cwd change cannot be proven', reachability, word);
      } else {
        addTarget('shell-source', command, t.expression, t.value, true, null, reachability, word);
      }
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

  function functionPreamble(exportedOnly = false) {
    const chunks = [];
    for (const [name, fn] of functions.entries()) {
      if ((exportedOnly && !exportedFunctions.has(name)) || poisonedFunctions.has(name) || !fn ||
          !Number.isSafeInteger(fn.pos) || !Number.isSafeInteger(fn.end)) continue;
      chunks.push(source.slice(fn.pos, fn.end));
    }
    return chunks.join('\n');
  }

  function scanNestedShellCode(code, reachability, bindings, origin, nestedOptions = {}) {
    const preamble = functionPreamble(nestedOptions.exportedOnlyFunctions === true);
    const combined = preamble ? preamble + '\n' + code : code;
    const codeOffset = preamble ? preamble.length + 1 : 0;
    const nested = scanDependencyTargets(combined, {
      bindings: Object.fromEntries(bindings),
      sourceSearchProof: options.sourceSearchProof || {},
      inlineParent: origin,
      _poisonedFunctions: [...poisonedFunctions],
      _exportedFunctions: [...exportedFunctions],
      _functionTableUnknown: functionTableUnknown,
      _commandResolutionUnknown: commandResolutionUnknown,
      _cwdUnknown: cwdUnknown,
      _posixMode: posixMode,
      _bashEnvActive: bashEnvActive,
      _dormantRule: currentDormantRule,
    });
    for (const assumption of nested.assumptions || []) assumptions.add(assumption);
    for (const rec of nested.targets) {
      const nestedReach = reachability === 'production' ? rec.reachability :
        (reachability === 'dormant' ? 'dormant' : 'conditional');
      addRecord({
        ...rec,
        reachability: nestedReach,
        status: rec.status,
        reason: rec.reason,
        ...(nestedReach === 'dormant' && !rec.dormantRule && currentDormantRule ?
          { dormantRule: currentDormantRule } : {}),
        origin,
      });
    }
  }

  function parseShellOptionWords(words, command, reachability, bindings, node, shellOptions = {}) {
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
        if (command === 'bash' && (bashEnvActive || shellOptions.bashEnvPrefix === true)) {
          addUnresolved('shell-inline-code', command, code.expression,
            'BASH_ENV may execute unscanned startup code before bash -c', reachability, codeWord);
          return;
        }
        scanNestedShellCode(code.value, reachability, bindings, command + '-c', { exportedOnlyFunctions: true });
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
        const relative = !path.posix.isAbsolute(w.value) && !/^[A-Za-z]:[\\/]/.test(w.value);
        if (cwdUnknown && relative) {
          addUnresolved('shell-script', command, w.expression,
            'relative shell script target after shell cwd change cannot be proven', reachability, words[i]);
        } else {
          addTarget('shell-script', command, w.expression, w.value, true, null, reachability, words[i]);
        }
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
      } else if (cwdUnknown && /^\.{0,2}\//.test(w.value)) {
        addUnresolved('node-script', 'node', w.expression,
          'relative Node script target after shell cwd change cannot be proven', reachability, words[i]);
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
    processWords(words.slice(i), reachability, bindings, node, 'exec', false, true);
  }

  function scanEnv(words, reachability, bindings, node) {
    let i = 1;
    let endOptions = false;
    let bashEnvPrefix = false;
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
        if (/^BASH_ENV=/.test(assignmentText)) bashEnvPrefix = true;
        i++;
        continue;
      }
      break;
    }
    if (i < words.length) processWords(words.slice(i), reachability, bindings, node,
      'env', false, true, { bashEnvPrefix });
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
      if (!SHELL_BUILTINS.has(delegated.value)) return;
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
    if (i < words.length) processWords(words.slice(i), reachability, bindings, node, 'nohup', false, true);
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
    if (i < words.length) processWords(words.slice(i), reachability, bindings, node, 'nice', false, true);
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
    if (i < words.length) processWords(words.slice(i), reachability, bindings, node, 'timeout', false, true);
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
    if (i < words.length) processWords(words.slice(i), reachability, bindings, node, 'stdbuf', false, true);
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
    scanNestedShellCode(code, reachability, bindings, 'eval');
    let evalAst = null;
    try {
      evalAst = requireProjector().parseMaterialized(code);
    } catch (error) {
      evalAst = null;
    }
    if (evalAst) poisonFunctionNames(functionNamesIn(evalAst));
  }

  const SHELL_BUILTINS = new Set([
    '.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command',
    'compgen', 'complete', 'compopt', 'continue', 'declare', 'dirs', 'disown', 'echo',
    'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg', 'getopts', 'hash',
    'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd',
    'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return', 'set', 'shift',
    'shopt', 'source', 'suspend', 'test', 'times', 'trap', 'true', 'type', 'typeset',
    'ulimit', 'umask', 'unalias', 'unset', 'wait'
  ]);

  function scanDependencyShapeWithUnprovenCommand(command, words, reachability, bindings, node, reason) {
    const before = new Set(records.keys());
    let handled = true;
    if (command === 'node') scanNodeCommand(words, reachability, bindings, node);
    else if (command === 'bash' || command === 'sh') parseShellOptionWords(words, command, reachability, bindings, node);
    else if (command === 'env') scanEnv(words, reachability, bindings, node);
    else if (command === 'nohup') scanNohup(words, reachability, bindings, node);
    else if (command === 'nice') scanNice(words, reachability, bindings, node);
    else if (command === 'timeout') scanTimeout(words, reachability, bindings, node);
    else if (command === 'stdbuf') scanStdbuf(words, reachability, bindings, node);
    else handled = false;
    if (!handled) return false;
    for (const [key, record] of [...records.entries()]) {
      if (before.has(key)) continue;
      records.delete(key);
      addRecord({
        ...record,
        target: null,
        status: 'unresolved',
        reason: reason + (record.reason ? '; ' + record.reason : ''),
      });
    }
    return true;
  }

  function recordExportState(words, bindings) {
    let functionMode = false;
    for (let i = 1; i < words.length; i++) {
      const w = targetFromWord(words[i], source, bindings);
      if (!w.resolved) continue;
      if (w.value === '--') continue;
      if (w.value === '-f') { functionMode = true; continue; }
      if (w.value.startsWith('-')) continue;
      if (functionMode) {
        const name = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(w.value);
        if (name && functions.has(name[1]) && !poisonedFunctions.has(name[1])) exportedFunctions.add(name[1]);
        continue;
      }
      if (/^BASH_ENV(?:=|$)/.test(w.value)) bashEnvActive = true;
    }
  }

  function processWords(words, reachability, bindings, node, origin, allowFunctionLookup = true, externalWrapper = false, commandOptions = {}) {
    if (!words.length) return;
    const commandWord = targetFromWord(words[0], source, bindings);
    if (!commandWord.resolved) {
      addUnresolved('command-name', origin || 'shell', commandWord.expression,
        'dynamic command name prevents command-specific dependency classification', reachability, words[0]);
      bindings.clear();
      clearFunctionProof();
      return;
    }
    const command = commandWord.value;
    if (externalWrapper && SHELL_BUILTINS.has(command)) {
      addUnresolved('external-wrapper-command', origin || 'external-wrapper', commandWord.expression,
        'PATH 可执行文件未证明：external wrapper delegated to shell builtin',
        reachability, words[0], { delegatedCommand: command });
      return;
    }
    if (poisonedFunctions.has(command)) {
      addUnresolved('function-name', command, commandWord.expression,
        'function name is poisoned by an unproven or isolated definition',
        reachability, words[0], { poisoned: true });
      bindings.clear();
      clearFunctionProof();
      return;
    }
    if (allowFunctionLookup && functions.has(command)) {
      if (!functionStack.has(command)) {
        functionStack.add(command);
        const fn = functions.get(command);
        const hasLocal = containsLiteralCommand(fn.body, new Set(['local']));
        functionDepth++;
        try {
          const savedPositional1Values = positional1Values;
          positional1Values = null;
          try {
            scanNode(fn.body, reachability === 'dormant' ? 'dormant' : 'conditional', bindings);
          } finally {
            positional1Values = savedPositional1Values;
          }
          if (reachability === 'production') {
            applyEffects(bindings, collectEffects(fn.body, new Map(functions), new Set([command])));
            if (hasLocal) bindings.clear();
          }
        } finally {
          functionDepth--;
          functionStack.delete(command);
        }
      }
      return;
    }
    if (functionTableUnknown && allowFunctionLookup) {
      const unknownReason = 'function table is unknown after code-loading command';
      addUnresolved('command-name', command, commandWord.expression, unknownReason, reachability, words[0]);
      bindings.clear();
    } else if (commandResolutionUnknown && !SHELL_BUILTINS.has(command)) {
      const unknownReason = 'shell command resolution state is unknown';
      addUnresolved('command-name', command, commandWord.expression, unknownReason, reachability, words[0]);
      bindings.clear();
      scanDependencyShapeWithUnprovenCommand(command, words, reachability, bindings, node, unknownReason);
      return;
    }
    if (['trap', 'mapfile', 'readarray', 'let', 'readonly'].includes(command)) {
      poisonUnsupported(command, command + ' is outside the supported scanner subset',
        reachability, node, bindings, commandWord.expression);
      return;
    }
    if (['declare', 'local', 'typeset'].includes(command)) {
      const values = words.slice(1).map((word) => targetFromWord(word, source, bindings));
      if (values.some((x) => x.resolved && x.value.startsWith('-'))) {
        poisonUnsupported(command, command + ' with options is outside the supported scanner subset',
          reachability, node, bindings, commandWord.expression);
        return;
      }
    }
    if (command === 'set') {
      const values = words.slice(1).map((word) => targetFromWord(word, source, bindings));
      const args = values.filter((x) => x.resolved).map((x) => x.value);
      if (args.includes('-n') || args.some((x, index) => x === '-o' && args[index + 1] === 'posix')) {
        poisonUnsupported('set', 'set -n / set -o posix is outside the supported scanner subset',
          reachability, node, bindings, commandWord.expression);
        return;
      }
    }
    if (command === 'source' || command === '.') {
      resolveSourceLike(command, words[1], reachability, bindings, node);
      bindings.clear();
      clearFunctionProof();
      if (reachability !== 'dormant') positional1Values = null;
      return;
    }
    if (command === 'bash' || command === 'sh') {
      parseShellOptionWords(words, command, reachability, bindings, node, commandOptions);
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
      bindings.clear();
      markFunctionsUnknownPreservingPoison();
      if (reachability !== 'dormant') positional1Values = null;
      return;
    }
    if (command === 'mapfile' || command === 'readarray') {
      for (let i = 1; i < words.length; i++) {
        const w = targetFromWord(words[i], source, bindings);
        if (!w.resolved) continue;
        if (w.value === '-C' && words[i + 1]) {
          const code = targetFromWord(words[i + 1], source, bindings);
          if (code.resolved) scanNestedShellCode(code.value, reachability, bindings, command + '-C');
          else addUnresolved('shell-inline-code', command, code.expression,
            'dynamic mapfile callback cannot be recursively scanned', reachability, words[i + 1]);
          break;
        }
      }
      applyEffects(bindings, writerEffects(command, words, bindings));
      return;
    }
    if (command === 'export') {
      recordExportState(words, bindings);
      applyEffects(bindings, writerEffects(command, words, bindings));
      return;
    }
    if (['read', 'declare', 'local', 'typeset', 'unset', 'printf', 'getopts', 'wait'].includes(command)) {
      applyEffects(bindings, writerEffects(command, words, bindings));
      return;
    }
    if (command === 'trap') {
      if (words[1]) {
        const code = targetFromWord(words[1], source, bindings);
        if (code.resolved) scanNestedShellCode(code.value, reachability, bindings, 'trap');
        else addUnresolved('shell-inline-code', 'trap', code.expression,
          'dynamic trap code cannot be recursively scanned', reachability, words[1]);
      }
      return;
    }
    if (['cd', 'pushd', 'popd'].includes(command)) {
      bindings.clear();
      clearKnownFunctions();
      cwdUnknown = true;
      return;
    }
    if (command === 'set') {
      const values = words.slice(1).map((word) => targetFromWord(word, source, bindings));
      if (values.length >= 2 && values[0].resolved && values[1].resolved &&
          values[0].value === '-o' && values[1].value === 'posix') {
        posixMode = true;
        return;
      }
      if (values.length >= 1 && values[0].resolved && values[0].value === '--') {
        invalidatePositionalParameters(bindings);
        if (reachability !== 'dormant') positional1Values = null;
        return;
      }
      bindings.clear();
      clearKnownFunctions();
      return;
    }
    if (command === 'shift') {
      invalidatePositionalParameters(bindings);
      if (reachability !== 'dormant') positional1Values = null;
      return;
    }
    if (command === 'shopt') {
      bindings.clear();
      clearKnownFunctions();
      return;
    }
    if (['enable', 'alias', 'hash'].includes(command)) {
      bindings.clear();
      clearKnownFunctions();
      commandResolutionUnknown = true;
      return;
    }
    if (command === 'xargs') {
      addUnsupported('xargs', commandWord.expression,
        'xargs command execution semantics are not modeled', reachability, words[0],
        { wrapper: 'xargs' });
      bindings.clear();
      clearKnownFunctions();
      return;
    }
  }

  function scanWordNested(word, reachability, bindings) {
    if (!word || typeof word !== 'object') return;
    function visitPart(part) {
      if (!part || typeof part !== 'object') return;
      if ((part.type === 'CommandExpansion' || part.type === 'ProcessSubstitution') && part.script) {
        scanIsolated(part.script, reachability, bindings);
        return;
      }
      if (part.type === 'DoubleQuoted' || Array.isArray(part.parts)) {
        for (const inner of part.parts || []) visitPart(inner);
      }
      if (part.operand) visitPart(part.operand);
    }
    for (const part of word.parts || []) visitPart(part);
  }

  function scanNestedAstExecutions(value, reachability, bindings, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if ((value.type === 'CommandExpansion' || value.type === 'ProcessSubstitution' || value.type === 'ArithmeticCommandExpansion') && value.script) {
      scanIsolated(value.script, reachability, bindings);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) scanNestedAstExecutions(item, reachability, bindings, seen);
      return;
    }
    for (const child of Object.values(value)) {
      scanNestedAstExecutions(child, reachability, bindings, seen);
    }
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
      const direct = targetFromWord(assignment.value, source, bindings);
      if (direct.resolved) return direct.value;
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
    const assignments = (command.prefix || []).filter((x) => x && x.type === 'Assignment');
    const syntaxWords = [
      ...assignments.filter((x) => x.value).map((x) => x.value),
      ...(command.name ? [command.name] : []),
      ...(command.suffix || []),
    ];
    const unsupportedSyntax = syntaxWords.map((word) => unsupportedWordReason(word)).find(Boolean) ||
      (command.redirects || []).map((redir) => redirectUnsupportedReason(redir)).find(Boolean);
    if (unsupportedSyntax) {
      poisonUnsupported('shell-word', unsupportedSyntax, reachability, command, bindings,
        source.slice(command.pos, command.end));
      return;
    }
    const bashEnvPrefix = assignments.some((assignment) => assignment.name === 'BASH_ENV');
    let assignmentValueUnsafe = false;
    for (const assignment of assignments) {
      if (!assignment.value) continue;
      scanWordNested(assignment.value, reachability, bindings);
      const effects = wordEffects(assignment.value);
      if (effects.clearAll || effects.names.size > 0) assignmentValueUnsafe = true;
      applyEffects(bindings, effects);
    }
    if (command.name) {
      scanWordNested(command.name, reachability, bindings);
      applyEffects(bindings, wordEffects(command.name));
    }
    for (const w of command.suffix || []) {
      scanWordNested(w, reachability, bindings);
      applyEffects(bindings, wordEffects(w));
    }
    for (const redir of command.redirects || []) {
      scanRedirectNested(redir, reachability, bindings);
      if (redir && redir.target) applyEffects(bindings, wordEffects(redir.target));
    }

    const words = [];
    if (command.name) words.push(command.name);
    for (const w of command.suffix || []) if (w && typeof w.text === 'string') words.push(w);
    if (words.length) processWords(words, reachability, bindings, command,
      undefined, true, false, { bashEnvPrefix });

    if (!command.name && reachability === 'production') {
      for (const assignment of assignments) {
        if (assignmentValueUnsafe) {
          bindings.delete(assignment.name);
          continue;
        }
        const binding = inferAssignmentBinding(assignment, bindings);
        if (binding !== null) bindings.set(assignment.name, binding);
        else bindings.delete(assignment.name);
      }
    }

    if (command.name && posixMode && assignments.length > 0) {
      const name = targetFromWord(command.name, source, bindings);
      const special = new Set([':', '.', 'break', 'continue', 'eval', 'exec', 'exit',
        'export', 'readonly', 'return', 'set', 'shift', 'source', 'times', 'trap', 'unset']);
      if (name.resolved && special.has(name.value)) {
        for (const assignment of assignments) {
          const binding = assignmentValueUnsafe ? null : inferAssignmentBinding(assignment, bindings);
          if (binding !== null) bindings.set(assignment.name, binding);
          else bindings.delete(assignment.name);
        }
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
        value.type === 'Select' || value.type === 'Coproc' || value.type === 'ArithmeticCommand' ||
        value.type === 'ArithmeticFor' || value.type === 'TestCommand') return true;
    if (Array.isArray(value)) return value.some((item) => containsCommandBearingDescendant(item, seen));
    for (const [key, child] of Object.entries(value)) {
      if (key === 'body' && value.operator && value.target) continue;
      if (containsCommandBearingDescendant(child, seen)) return true;
    }
    return false;
  }

  function positionalComparisonTruth(atom, bareDoubleBracket = false) {
    if (!positional1Values || positional1Values.size === 0) return { truth: null, usesPositional: false };
    let text = String(atom || '').trim().replace(/;$/, '').trim();
    let m = null;
    if (bareDoubleBracket) {
      m = /^"(?:\$1|\$\{1:-\})"\s*(=|==|!=)\s*("[^"]*"|[A-Za-z0-9_.:+\/-]+)$/.exec(text);
    } else {
      m = /^\[\s*"(?:\$1|\$\{1:-\})"\s*(=|==|!=)\s*("[^"]*"|[A-Za-z0-9_.:+\/-]+)\s*\]$/.exec(text) ||
        /^test\s+"(?:\$1|\$\{1:-\})"\s*(=|==|!=)\s*("[^"]*"|[A-Za-z0-9_.:+\/-]+)$/.exec(text);
    }
    if (!m) return { truth: null, usesPositional: false };
    const op = m[1];
    const token = m[2];
    const literal = token.startsWith('"') ? token.slice(1, -1) : token;
    const results = [...positional1Values].map((value) => op === '!=' ? value !== literal : value === literal);
    if (results.every(Boolean)) return { truth: true, usesPositional: true };
    if (results.every((x) => !x)) return { truth: false, usesPositional: true };
    return { truth: null, usesPositional: true };
  }

  function combineGuard(parts, mode, bareDoubleBracket) {
    const values = parts.map((part) => guardTruthText(part, bareDoubleBracket));
    const usesPositional = values.some((x) => x.usesPositional);
    if (mode === 'and') {
      if (values.some((x) => x.truth === false)) return { truth: false, usesPositional };
      if (values.every((x) => x.truth === true)) return { truth: true, usesPositional };
      return { truth: null, usesPositional };
    }
    if (values.every((x) => x.truth === false)) return { truth: false, usesPositional };
    if (values.some((x) => x.truth === true)) return { truth: true, usesPositional };
    return { truth: null, usesPositional };
  }

  function guardTruthText(raw, bareDoubleBracket = false) {
    let text = String(raw || '').trim().replace(/;$/, '').trim();
    if (!bareDoubleBracket && text.startsWith('[[') && text.endsWith(']]')) {
      return guardTruthText(text.slice(2, -2).trim(), true);
    }
    const orParts = text.split(/\s+\|\|\s+/);
    if (orParts.length > 1) return combineGuard(orParts, 'or', bareDoubleBracket);
    const andParts = text.split(/\s+&&\s+/);
    if (andParts.length > 1) return combineGuard(andParts, 'and', bareDoubleBracket);
    return positionalComparisonTruth(text, bareDoubleBracket);
  }

  function guardTruth(node) {
    if (!node || !Number.isSafeInteger(node.pos) || !Number.isSafeInteger(node.end)) {
      return { truth: null, usesPositional: false };
    }
    return guardTruthText(source.slice(node.pos, node.end));
  }

  function caseItemReachability(caseNode, item, parentReachability) {
    if (parentReachability === 'dormant') return 'dormant';
    if (!positional1Values || positional1Values.size === 0 || !caseNode || !caseNode.word) return 'conditional';
    const wordText = String(caseNode.word.text || '').trim();
    if (wordText !== '"$1"' && wordText !== '"${1:-}"') return 'conditional';
    const literals = [];
    for (const pattern of item.pattern || []) {
      const p = targetFromWord(pattern, source, new Map());
      if (!p.resolved || /[*?[]/.test(p.value)) return 'conditional';
      literals.push(p.value);
    }
    if (literals.length === 0) return 'conditional';
    return [...positional1Values].every((value) => !literals.includes(value)) ? 'dormant' : 'conditional';
  }

  function scanNode(node, reachability, bindings) {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'Script':
      case 'CompoundList': {
        let activeReachability = reachability;
        let activeDormantRule = reachability === 'dormant' ? currentDormantRule : null;
        for (const statement of node.commands || []) {
          withDormantRule(activeReachability === 'dormant' ? activeDormantRule : null,
            () => scanNode(statement, activeReachability, bindings));
          if (activeReachability !== 'dormant' && scopeTerminator(statement)) {
            activeReachability = 'dormant';
            activeDormantRule = 'rule1-definite-terminator';
          }
        }
        return;
      }
      case 'Statement':
        if (node.background) {
          const innerState = cloneShellState();
          withShellState(innerState, () => {
            const innerBindings = cloneBindings(bindings);
            scanNode(node.command, reachability, innerBindings);
            for (const redir of node.redirects || []) {
              const reason = redirectUnsupportedReason(redir);
              if (reason) poisonUnsupported('redirect', reason, reachability, redir, innerBindings,
                source.slice(redir.pos, redir.end));
              else scanRedirectNested(redir, reachability, innerBindings);
            }
          });
          poisonFunctionNames(functionNamesIn(node.command));
          return;
        }
        scanNode(node.command, reachability, bindings);
        for (const redir of node.redirects || []) {
          const reason = redirectUnsupportedReason(redir);
          if (reason) poisonUnsupported('redirect', reason, reachability, redir, bindings,
            source.slice(redir.pos, redir.end));
          else scanRedirectNested(redir, reachability, bindings);
        }
        return;
      case 'Command':
        scanSimpleCommand(node, reachability, bindings);
        return;
      case 'Function': {
        const name = node.name && typeof node.name.value === 'string' ? node.name.value : null;
        if (name) {
          functions.set(name, node);
          poisonedFunctions.delete(name);
        } else {
          clearFunctionProof();
        }
        const innerState = cloneShellState();
        innerState.positional1Values = null;
        const provenNeverCalled = !!(name && closureNeverCalledFunctions.has(name));
        const bodyReachability = reachability === 'dormant' || provenNeverCalled ? 'dormant' : 'conditional';
        const bodyDormantRule = reachability === 'dormant' ? currentDormantRule :
          (provenNeverCalled ? 'rule3-never-called-function' : null);
        functionDepth++;
        try {
          withShellState(innerState, () => withDormantRule(bodyDormantRule,
            () => scanNode(node.body, bodyReachability, new Map())));
        } finally {
          functionDepth--;
        }
        return;
      }
      case 'BraceGroup':
        scanNode(node.body, reachability, bindings);
        return;
      case 'Subshell':
        scanIsolated(node.body, reachability, bindings);
        return;
      case 'Select':
        poisonUnsupported('select', 'select command execution semantics are not modeled',
          reachability, node, bindings, 'select');
        return;
      case 'Coproc':
        poisonUnsupported('coproc', 'coproc command execution semantics are not modeled',
          reachability, node, bindings, 'coproc');
        return;
      case 'Pipeline': {
        const commands = node.commands || [];
        if (commands.length === 1) {
          scanNode(commands[0], reachability, bindings);
          return;
        }
        for (let i = 0; i < commands.length; i++) scanIsolated(commands[i], reachability, bindings);
        if (commands.length > 0) {
          applyEffects(bindings, collectEffects(commands[commands.length - 1], new Map(functions)));
        }
        return;
      }
      case 'AndOr':
        if (node.commands && node.commands[0]) scanNode(node.commands[0], reachability, bindings);
        for (let i = 1; i < (node.commands || []).length; i++) {
          scanBranchAndInvalidate(node.commands[i], bindings, childConditionalReachability(reachability));
        }
        return;
      case 'If': {
        scanNode(node.clause, reachability, bindings);
        const proof = guardTruth(node.clause);
        const thenReach = reachability === 'dormant' ? 'dormant' :
          (proof.usesPositional && proof.truth === false ? 'dormant' : 'conditional');
        const elseReach = reachability === 'dormant' ? 'dormant' :
          (proof.usesPositional && proof.truth === true ? 'dormant' : 'conditional');
        const thenRule = reachability === 'dormant' ? currentDormantRule :
          (proof.usesPositional && proof.truth === false ? 'rule2-argv1-guard-false' : null);
        const elseRule = reachability === 'dormant' ? currentDormantRule :
          (proof.usesPositional && proof.truth === true ? 'rule2-argv1-guard-false' : null);
        if (node.then) scanBranchAndInvalidate(node.then, bindings, thenReach, thenRule);
        if (node.else) scanBranchAndInvalidate(node.else, bindings, elseReach, elseRule);
        return;
      }
      case 'Case': {
        const caseReason = unsupportedWordReason(node.word);
        if (caseReason) {
          poisonUnsupported('case-word', caseReason, reachability, node.word, bindings, node.word.text);
          return;
        }
        scanWordNested(node.word, reachability, bindings);
        applyEffects(bindings, wordEffects(node.word));
        let patternIndex = 0;
        for (const item of node.items || []) {
          for (const pattern of item.pattern || []) {
            const patternReason = unsupportedWordReason(pattern);
            if (patternReason) {
              poisonUnsupported('case-pattern', patternReason, reachability, pattern, bindings, pattern.text);
              return;
            }
            const first = patternIndex++ === 0;
            scanWordNested(pattern, first ? reachability : childConditionalReachability(reachability),
              first ? bindings : new Map());
            applyEffects(bindings, wordEffects(pattern));
          }
          const itemReachability = caseItemReachability(node, item, reachability);
          const itemRule = itemReachability === 'dormant' ?
            (reachability === 'dormant' ? currentDormantRule : 'rule2-argv1-guard-false') : null;
          scanBranchAndInvalidate(item.body, bindings, itemReachability, itemRule);
        }
        return;
      }
      case 'While':
        scanNode(node.clause, reachability, bindings);
        scanBranchAndInvalidate(node.body, bindings, childConditionalReachability(reachability));
        return;
      case 'For':
        for (const word of node.wordlist || []) {
          const reason = unsupportedWordReason(word);
          if (reason) {
            poisonUnsupported('for-word', reason, reachability, word, bindings, word.text);
            return;
          }
          scanWordNested(word, reachability, bindings);
          applyEffects(bindings, wordEffects(word));
        }
        if (node.name && typeof node.name.value === 'string') bindings.delete(node.name.value);
        else bindings.clear();
        scanBranchAndInvalidate(node.body, bindings, childConditionalReachability(reachability));
        return;
      case 'ArithmeticCommand':
        scanNestedAstExecutions(node, reachability, bindings);
        poisonUnsupported('ArithmeticCommand', 'arithmetic command is outside the supported scanner subset',
          reachability, node, bindings, 'ArithmeticCommand');
        return;
      case 'ArithmeticFor':
        scanNestedAstExecutions(node, reachability, bindings);
        poisonUnsupported('ArithmeticFor', 'arithmetic for-loop is outside the supported scanner subset',
          reachability, node, bindings, 'ArithmeticFor');
        if (node.body) scanNode(node.body, childConditionalReachability(reachability), new Map());
        return;
      case 'TestCommand':
        scanNestedAstExecutions(node, reachability, bindings);
        if (testCommandHasAssignment(node)) {
          poisonUnsupported('TestCommand', 'assignment inside [[ ... ]] is outside the supported scanner subset',
            reachability, node, bindings, 'TestCommand');
        }
        return;
      case 'ArithmeticGroup':
      case 'ArithmeticCommandExpansion':
        poisonUnsupported(node.type, 'arithmetic construct is outside the supported scanner subset',
          reachability, node, bindings, node.type);
        return;
      default:
        if (containsCommandBearingDescendant(node)) {
          const construct = typeof node.type === 'string' ? node.type : 'unknown';
          poisonUnsupported(construct, 'unmodeled command-bearing AST construct: ' + construct,
            reachability, node, bindings, construct);
        }
        return;
    }
  }

  scanNode(ast, 'production', initialBindings);

  return {
    schema: SCAN_SCHEMA,
    targets: [...records.values()],
    assumptions: [...assumptions].sort(),
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
