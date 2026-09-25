#!/usr/bin/env node
// AxMem Hermes bridge wiring — conservative-subset YAML hooks: writer.
// (P1 2.1, 2026-09-16)
// D9 ("无法证明就拒绝"): this is NOT a YAML parser. It proves a narrow set of
// textual invariants about the candidate config.yaml and REFUSES (rc 3, zero
// write, zero backup) the instant it cannot prove one of them, printing the
// YAML block + manual steps for the operator to apply by hand instead.
// There is no Hermes config-validate/load CLI usable against an arbitrary
// candidate path (builder-report §4.2: `hermes config` has no `--file`
// override and `hermes hooks list/doctor` only read the LIVE config path),
// so this conservative subset is the ONLY path available in P1 — never a
// fallback behind a loader this repo doesn't actually have access to.
//
// Usage: wire.cjs [--dry-run] [--config <path>]
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const ctx = require('../../lib/prelude.cjs');

const ROOT = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
const BRIDGE = `${ROOT}/adapters/hermes/bridge.cjs`;

// Mirrors Hermes's OWN resolution exactly (verified from source, builder
// report §4.5, hermes_constants.py _hermes_home_from_env() /
// get_hermes_home()): HERMES_HOME env var ALWAYS wins when set, checked
// BEFORE the platform-native default. Missing this env-var check was a
// real bug caught while producing the builder report's fresh-HOME doctor
// evidence — on a machine where HERMES_HOME is exported (pointing Hermes's
// real install at ~/.hermes rather than the Windows-native
// %LOCALAPPDATA%\hermes this function used to always return), doctor and
// wire.cjs would silently target the WRONG file: present=true on a
// same-shaped but functionally unrelated config.yaml.
function defaultHermesHome() {
  const envHome = (process.env.HERMES_HOME || '').trim();
  if (envHome) return envHome;
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA;
    return la ? path.join(la, 'hermes') : path.join(os.homedir(), 'AppData', 'Local', 'hermes');
  }
  return path.join(os.homedir(), '.hermes');
}

function resolveTargetPath(argv) {
  const ci = argv.indexOf('--config');
  if (ci >= 0 && argv[ci + 1]) return argv[ci + 1];
  const cfgVal = ctx.cfgGet('adapters.hermes.config_yaml', null);
  if (cfgVal) return String(cfgVal).replace(/^~(?=\/|$)/, ctx.HOME_DIR);
  return path.join(defaultHermesHome(), 'config.yaml');
}

// matcher is only meaningful (and only accepted by Hermes's parser) for
// pre_tool_call / post_tool_call — see shell_hooks.py `_parse_single_entry`
// (a matcher on any other event is warned-and-dropped at load time, so we
// never emit one there). Builder-verified write-tool names (§4.1):
// write_file, patch — matched here so Hermes filters BEFORE spawning the
// bridge at all; the bridge itself still independently verifies the
// tool_input path shape (defense in depth, §2.1 bridge table note).
// Single source of truth for both the rendered YAML and the lifecycle
// manifest's {event, matcher, normalized_command} identity triples (P1 2.3)
// — generating both from the same list means they can never drift apart.
function hooksIdentityList() {
  return [
    { event: 'post_tool_call', matcher: '^(write_file|patch)$', normalized_command: `node "${BRIDGE}" post_tool_call` },
    { event: 'pre_llm_call', matcher: null, normalized_command: `node "${BRIDGE}" pre_llm_call` },
    { event: 'on_session_start', matcher: null, normalized_command: `node "${BRIDGE}" on_session_start` },
    { event: 'on_session_end', matcher: null, normalized_command: `node "${BRIDGE}" on_session_end` },
  ];
}

function hooksYamlBlock() {
  const lines = ['hooks:'];
  for (const t of hooksIdentityList()) {
    lines.push(`  ${t.event}:`);
    lines.push(`    - command: "${t.normalized_command.replace(/"/g, '\\"')}"`);
    if (t.matcher) lines.push(`      matcher: "${t.matcher}"`);
    lines.push('      timeout: 10');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Conservative-subset validation
// ---------------------------------------------------------------------------

// Returns a list of "unclosed" problems for a stretch of text (used on the
// PREFIX only — everything strictly before the hooks: insertion point).
function findUnclosedFlowOrQuote(text) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inSingle) {
      if (c === "'") {
        if (text[i + 1] === "'") { i++; continue; } // doubled '' escape inside single-quoted scalar
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === '#') {
      // comment to end of line (only when not inside quotes, checked above)
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '{' || c === '[') { depth++; continue; }
    if (c === '}' || c === ']') { depth--; continue; }
  }
  const problems = [];
  if (inSingle || inDouble) problems.push('unclosed quote');
  if (depth !== 0) problems.push('unclosed flow collection ({ or [)');
  return problems;
}

// Full-document scan for constructs this conservative subset refuses to
// reason about anywhere in the file.
function fullDocumentViolations(lines) {
  const violations = [];
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const stripped = line.replace(/#.*$/, ''); // best-effort: strip trailing comment (does not handle '#' inside quotes, which is fine — a violation construct inside a quoted string is not one of the constructs below since our regexes require them unquoted-ish at line scope; being conservative in the reject direction is safe)
    if (/^---(\s|$)/.test(line) && lineNo !== 1) violations.push(`line ${lineNo}: '---' document separator outside the first line`);
    if (/^\.\.\.(\s|$)/.test(line)) violations.push(`line ${lineNo}: '...' document-end marker`);
    if (/^%/.test(line)) violations.push(`line ${lineNo}: '%' YAML directive`);
    if (/&[A-Za-z0-9_-]+/.test(stripped)) violations.push(`line ${lineNo}: YAML anchor (&...)`);
    if (/\*[A-Za-z0-9_-]+/.test(stripped)) violations.push(`line ${lineNo}: YAML alias (*...)`);
    if (/<<\s*:/.test(stripped)) violations.push(`line ${lineNo}: YAML merge key (<<:)`);
    if (/(^|\s)!{1,2}[A-Za-z!]/.test(stripped)) violations.push(`line ${lineNo}: YAML tag (!...)`);
  });
  return violations;
}

function topLevelKeyOccurrences(lines) {
  const seen = new Map();
  lines.forEach((line, i) => {
    const m = /^([A-Za-z0-9_.-]+):(\s|$)/.exec(line);
    if (m) {
      const key = m[1];
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(i + 1);
    }
  });
  return seen;
}

// Returns { ok: true, mode: 'append' } |
//         { ok: true, mode: 'replace', startLine, endLine } |
//         { ok: false, reason }
function analyze(lines) {
  const violations = fullDocumentViolations(lines);
  if (violations.length) return { ok: false, reason: `full-document scan rejected:\n  ${violations.join('\n  ')}` };

  const occ = topLevelKeyOccurrences(lines);
  for (const [key, positions] of occ) {
    if (positions.length > 1) return { ok: false, reason: `duplicate top-level key '${key}' at lines ${positions.join(', ')}` };
  }

  const hooksLineIdx = lines.findIndex((l) => /^hooks:\s*(#.*)?$/.test(l) || /^hooks:\s*\{\s*\}\s*(#.*)?$/.test(l));
  if (hooksLineIdx === -1) {
    // No hooks: key anywhere — but ALSO reject if some other spelling of it
    // exists (e.g. indented, or "Hooks:") since that would be a human error
    // we should not silently ignore. Canonical-spelling-only scan below.
    const nearMiss = lines.findIndex((l) => /^\s+hooks\s*:/i.test(l) || /^Hooks\s*:/.test(l));
    if (nearMiss !== -1) return { ok: false, reason: `line ${nearMiss + 1}: a 'hooks' key exists but is not column-0 canonical spelling 'hooks:' — refusing to guess` };
    const prefix = lines.slice(0, lines.length).join('\n'); // whole file is "before" the append point
    const prefixProblems = findUnclosedFlowOrQuote(prefix);
    if (prefixProblems.length) return { ok: false, reason: `prefix scan rejected: ${prefixProblems.join(', ')}` };
    return { ok: true, mode: 'append' };
  }

  // hooks: exists — prefix is everything strictly before it.
  const prefix = lines.slice(0, hooksLineIdx).join('\n');
  const prefixProblems = findUnclosedFlowOrQuote(prefix);
  if (prefixProblems.length) return { ok: false, reason: `prefix scan (before line ${hooksLineIdx + 1}) rejected: ${prefixProblems.join(', ')}` };

  const isInlineEmpty = /^hooks:\s*\{\s*\}\s*(#.*)?$/.test(lines[hooksLineIdx]);
  if (isInlineEmpty) {
    return { ok: true, mode: 'replace', startLine: hooksLineIdx, endLine: hooksLineIdx };
  }

  // hooks: (block form) — find where its block ends: the next line with
  // indent 0 that isn't blank/comment, or EOF.
  let end = lines.length;
  let sawNonEmptyChild = false;
  for (let i = hooksLineIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    const indentMatch = /^(\s*)/.exec(l);
    const indent = indentMatch[1].length;
    if (indent === 0) { end = i; break; }
    sawNonEmptyChild = true;
  }
  if (sawNonEmptyChild) {
    return { ok: false, reason: `line ${hooksLineIdx + 1}: 'hooks:' already has child entries — this conservative writer only handles an ABSENT or EMPTY hooks: key, never merging into existing entries` };
  }
  return { ok: true, mode: 'replace', startLine: hooksLineIdx, endLine: end - 1 };
}

// ---------------------------------------------------------------------------
// [Opus M3] Real-loader cross-check. This file's analyze()/
// fullDocumentViolations() only prove generic YAML-syntax invariants —
// they have no way to detect a Hermes-schema-level rejection (an unknown
// top-level key shape, a hooks: entry field Hermes's own parser refuses,
// etc). When the real `hermes` CLI is reachable, run ITS OWN loader
// (`hermes hooks list`) against both the ORIGINAL and CANDIDATE config
// text in isolated temp HERMES_HOME copies — never against the real
// config.yaml, never against the real ~/.hermes — before ever writing.
// When `hermes` is not on PATH (the common case in this build/test
// environment), this check is skipped entirely and wire.cjs falls back to
// the conservative-subset-only behavior it already had; doctor.cjs reports
// this fallback explicitly ("loader unused") rather than silently.
// ---------------------------------------------------------------------------

// Returns the absolute path to a real `hermes` executable if one is
// reachable on PATH, or null (never guessed, never assumed) — D9's
// "unprovable ⇒ refuse/fallback" applies here too: an unresolvable
// binary means "conservative subset only", not "try anyway and see".
function resolveHermesCommand() {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, 'hermes' + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* not here, keep looking */ }
    }
  }
  return null;
}

// Runs `hermes hooks list` with HERMES_HOME pointed at a throwaway temp
// copy containing ONLY the given config text — never the real ~/.hermes,
// never the real candidate/target path. Never throws.
function runHermesHooksList(hermesCmd, configText) {
  const os = require('os');
  const { execFileSync } = require('child_process');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-hermes-loader-'));
  try {
    fs.writeFileSync(path.join(tmpHome, 'config.yaml'), configText);
    try {
      const isWin = process.platform === 'win32';
      // [Opus L5, 2026-09-17] Under shell:true on Windows, execFileSync
      // concatenates `file` + args into ONE command string and hands it to
      // cmd.exe — Node does NOT quote `file` for you. An unquoted hermesCmd
      // containing a space (a wholly ordinary case: e.g. an install under
      // "C:\Program Files\...") gets split at the first space, and cmd.exe
      // tries to run the truncated prefix as the command, e.g. literally
      // 'C:\Program' — reproduced directly before this fix: cmd.exe reports
      // "'C:\Program' 不是内部或外部命令" (not recognized as an internal or
      // external command). Quoting hermesCmd here closes it; a path with no
      // spaces is unaffected by being quoted too.
      const shellCmd = isWin ? `"${hermesCmd}"` : hermesCmd;
      const out = execFileSync(shellCmd, ['hooks', 'list'], {
        env: { ...process.env, HERMES_HOME: tmpHome },
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows npm-installed CLIs are commonly a .cmd/.bat shim, not a
        // raw .exe — execFileSync throws EINVAL invoking those directly
        // without shell:true (a documented Node/Windows quirk). Args here
        // are always the fixed literal ['hooks', 'list'], never
        // user/candidate-controlled, so shell interpretation introduces no
        // injection surface.
        shell: isWin,
      });
      return { ok: true, output: out };
    } catch (e) {
      return { ok: false, output: (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '') };
    }
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// `hermesCmdOverride`: test-only seam (default: real PATH resolution).
// Passing `null` explicitly simulates "hermes not found"; passing a path
// simulates "hermes found at this location" without touching real PATH.
function verifyWithRealLoader(origText, candidateText, hermesCmdOverride) {
  const hermesCmd = hermesCmdOverride !== undefined ? hermesCmdOverride : resolveHermesCommand();
  if (!hermesCmd) return { used: false, ok: true, reason: 'hermes not found on PATH' };
  const origResult = runHermesHooksList(hermesCmd, origText);
  const candResult = runHermesHooksList(hermesCmd, candidateText);
  return { used: true, ok: origResult.ok && candResult.ok, origResult, candResult };
}

function fail(reason) {
  console.error(`hermes wire: refusing to modify config.yaml (rc 3, zero write, zero backup) — ${reason}`);
  console.error('Add this block to your Hermes config.yaml by hand instead:\n');
  console.error(hooksYamlBlock());
  process.exit(3);
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const target = resolveTargetPath(argv);

  let origBuf = Buffer.alloc(0);
  let existed = false;
  try { origBuf = fs.readFileSync(target); existed = true; } catch (e) {
    if (e.code !== 'ENOENT') fail(`cannot read ${target}: ${e.message}`);
  }

  let bom = Buffer.alloc(0);
  let body = origBuf;
  if (origBuf.length >= 3 && origBuf[0] === 0xEF && origBuf[1] === 0xBB && origBuf[2] === 0xBF) {
    bom = origBuf.slice(0, 3);
    body = origBuf.slice(3);
  }
  const text = body.toString('utf8');
  const useCRLF = /\r\n/.test(text);
  const hadTrailingNewline = text.length === 0 ? true : /\n$/.test(text.replace(/\r\n/g, '\n'));
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.length === 0 ? [] : (normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n'));

  const result = analyze(lines);
  if (!result.ok) fail(result.reason);

  const block = hooksYamlBlock().split('\n');
  let newLines;
  if (result.mode === 'append') {
    newLines = lines.length ? [...lines, ...block] : [...block];
  } else {
    newLines = [...lines.slice(0, result.startLine), ...block, ...lines.slice(result.endLine + 1)];
  }

  let newText = newLines.join('\n');
  if (hadTrailingNewline) newText += '\n';
  if (useCRLF) newText = newText.replace(/\n/g, '\r\n');
  const newBuf = Buffer.concat([bom, Buffer.from(newText, 'utf8')]);

  if (existed && Buffer.compare(newBuf, origBuf) === 0) {
    recordLifecycleTargets(target, origBuf, newBuf);
    console.log(`hermes wire: ${target} already up to date (no change)`);
    process.exit(0);
  }

  if (dryRun) {
    console.log(`hermes wire (dry-run): would ${result.mode === 'append' ? 'append' : 'replace'} the hooks: section in ${target} (no write, no backup)`);
    process.exit(0);
  }

  // [Opus M3] Real-loader cross-check, right before the write. If `hermes`
  // is reachable, both the ORIGINAL and CANDIDATE config text must load
  // successfully via Hermes's own `hooks list` — a real, non-fabricated
  // loader failure on either side aborts the write (rc 3) rather than
  // trusting this file's own conservative-subset analysis alone.
  // Test-only seam: when AXMEM_TEST_HERMES_CMD_OVERRIDE is explicitly set
  // in the environment (never the case in normal use), it overrides real
  // PATH resolution — an empty value simulates "hermes not found". Never
  // read anywhere except here.
  const hermesCmdOverride = Object.prototype.hasOwnProperty.call(process.env, 'AXMEM_TEST_HERMES_CMD_OVERRIDE')
    ? (process.env.AXMEM_TEST_HERMES_CMD_OVERRIDE || null)
    : undefined;
  const loaderCheck = verifyWithRealLoader(text, newText, hermesCmdOverride);
  if (loaderCheck.used && !loaderCheck.ok) {
    fail(
      `real Hermes loader ('hermes hooks list') rejected the config — ` +
      `original-load-ok=${loaderCheck.origResult.ok} candidate-load-ok=${loaderCheck.candResult.ok}` +
      (loaderCheck.candResult.ok ? '' : `\ncandidate loader output:\n${loaderCheck.candResult.output}`) +
      (loaderCheck.origResult.ok ? '' : `\noriginal loader output:\n${loaderCheck.origResult.output}`)
    );
  }

  if (existed) {
    const backupDir = path.join(ctx.STATE_DIR, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(target, path.join(backupDir, path.basename(target) + '.' + ts + '.bak'));
  }

  let mode = null;
  if (existed) { try { mode = fs.statSync(target).mode; } catch { /* best-effort */ } }
  const dir = path.dirname(path.resolve(target));
  fs.mkdirSync(dir, { recursive: true });
  const staging = path.join(dir, `.${path.basename(target)}.axmem-staging-${process.pid}-${Date.now()}`);
  fs.writeFileSync(staging, newBuf);
  if (mode !== null) { try { fs.chmodSync(staging, mode); } catch { /* best-effort */ } }
  fs.renameSync(staging, target);

  recordLifecycleTargets(target, existed ? origBuf : null, newBuf);

  console.log(`hermes wire: ${result.mode === 'append' ? 'appended' : 'replaced'} hooks: section in ${target}`);
  process.exit(0);
}

// Records one lifecycle manifest target per wired event (P1 2.3) — same
// identity shape CC uses ({event, matcher, normalized_command}), so
// uninstall/upgrade can treat both hook-style adapters uniformly.
function recordLifecycleTargets(target, origBuf, newBuf) {
  try {
    const lm = require('../../lifecycle/install-manifest.cjs');
    const stateDir = ctx.STATE_DIR;
    const preSha = origBuf ? require('crypto').createHash('sha256').update(origBuf).digest('hex') : null;
    const postSha = require('crypto').createHash('sha256').update(newBuf).digest('hex');
    for (const t of hooksIdentityList()) {
      lm.recordTarget(stateDir, 'hermes', {
        path: path.resolve(target),
        kind: 'json-hook',
        identity: t,
        expected_count: 1,
        pre_sha256: preSha,
        post_sha256: postSha,
      });
    }
  } catch (e) {
    console.error(`hermes wire: warning — could not record lifecycle manifest entry: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------
function runWire(target, extraArgs = [], envOverride = null) {
  const { spawnSync } = require('child_process');
  // ALWAYS isolate AXMEM_STATE_DIR/HOME — wire.cjs backs up the pre-existing
  // target under AXMEM_STATE_DIR/backups/ before writing, and this self-test
  // must never let that land in a real ~/.axmem regardless of the calling
  // shell's ambient environment (the same class of leak fence.sh's
  // self-test had before it was caught and fixed in the 2.0 commit).
  const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-wire-iso-'));
  const env = envOverride || { ...process.env, AXMEM_STATE_DIR: path.join(isoDir, 'state'), AXMEM_HOME: path.join(isoDir, 'home') };
  const r = spawnSync(process.execPath, [__filename, ...extraArgs, '--config', target], { encoding: 'utf8', env });
  return { rc: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function selfTest() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-hermes-wire-selftest-'));
  let ok = 0;
  let total = 0;
  let skipped = 0;
  const results = [];
  function check(name, cond) { total++; if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }
  // A platform-conditional check group that genuinely cannot run on this
  // platform (the .cmd/shell:true integration checks are Windows-only) —
  // counted separately from ok/total so it neither inflates a pass nor,
  // via the OLD hardcoded `ok === 26` check, gets silently miscounted as a
  // failure just because fewer checks ran (CI ubuntu-latest bug: printed
  // "24/26" — every executed check actually passed — yet still exited 1).
  function skip(name) { skipped++; results.push(`  --   SKIP ${name}`); }

  // 0 (H3/L5, ECC ts/Opus acceptance mutation-arm fix: "matcher 改错" was
  // found to be a FALSE GREEN — wire/doctor/install-manifest self-tests all
  // stayed green when the rendered matcher literal was changed to
  // '^(Write|Edit)$' (Claude Code's tool names, which Hermes never emits —
  // that matcher would never fire on a real Hermes install). Assert the
  // EXACT literal directly against the builder-verified real tool names
  // (§4.1: write_file, patch — see tools/file_tools.py).
  {
    const identity = hooksIdentityList();
    const postToolCall = identity.find((t) => t.event === 'post_tool_call');
    check("0 (H3/L5) post_tool_call matcher literal is exactly '^(write_file|patch)$' (Hermes's real tool names)", postToolCall && postToolCall.matcher === '^(write_file|patch)$');
  }

  // 1. accept: clean file, no hooks: key -> append; surrounding bytes preserved
  {
    const f = path.join(T, 'c1.yaml');
    fs.writeFileSync(f, 'model:\n  default: x\n');
    const r = runWire(f);
    const txt = fs.readFileSync(f, 'utf8');
    check('1 accept: clean file, no hooks -> append, prefix preserved', r.rc === 0 && txt.startsWith('model:\n  default: x\n') && /^hooks:/m.test(txt));
  }

  // 2. accept: hooks: {} with trailing comment -> replaced
  {
    const f = path.join(T, 'c2.yaml');
    fs.writeFileSync(f, 'model:\n  default: x\nhooks: {} # managed elsewhere\nother: 1\n');
    const r = runWire(f);
    const txt = fs.readFileSync(f, 'utf8');
    check('2 accept: hooks: {} # comment -> replaced with block', r.rc === 0 && /post_tool_call/.test(txt) && /other: 1/.test(txt) && !/hooks: \{\}/.test(txt));
  }

  // 3. accept: CRLF preserved
  {
    const f = path.join(T, 'c3.yaml');
    fs.writeFileSync(f, 'model:\r\n  default: x\r\n');
    runWire(f);
    const raw = fs.readFileSync(f, 'utf8');
    check('3 accept: CRLF convention preserved', /\r\n/.test(raw) && /post_tool_call/.test(raw));
  }

  // 4. accept: BOM preserved
  {
    const f = path.join(T, 'c4.yaml');
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('model:\n  default: x\n', 'utf8')]));
    runWire(f);
    const raw = fs.readFileSync(f);
    check('4 accept: BOM preserved', raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF);
  }

  // 5. accept: no trailing newline preserved
  {
    const f = path.join(T, 'c5.yaml');
    fs.writeFileSync(f, 'model:\n  default: x'); // no trailing \n
    runWire(f);
    const raw = fs.readFileSync(f, 'utf8');
    check('5 accept: file with no trailing newline stays without one', !raw.endsWith('\n\n') && !raw.endsWith('\n'));
  }

  // 6. accept: missing file entirely -> created fresh
  {
    const f = path.join(T, 'c6.yaml');
    const r = runWire(f);
    check('6 accept: missing file created fresh with hooks: block', r.rc === 0 && fs.existsSync(f) && /post_tool_call/.test(fs.readFileSync(f, 'utf8')));
  }

  // 6b (bug found + fixed while producing the builder report): HERMES_HOME
  // env var must take priority over the platform-native default (mirrors
  // Hermes's OWN get_hermes_home() resolution exactly, per §4.5). Without
  // --config and without adapters.hermes.config_yaml configured, the
  // resolved target must land inside HERMES_HOME when it's set, even on
  // win32 where LOCALAPPDATA is ALSO set (HERMES_HOME wins).
  {
    const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-wire-hermeshome-'));
    const hermesHomeDir = path.join(isoDir, 'custom-hermes-home');
    fs.mkdirSync(hermesHomeDir, { recursive: true });
    const env = { ...process.env, AXMEM_STATE_DIR: path.join(isoDir, 'state'), AXMEM_HOME: path.join(isoDir, 'axmemhome'), HERMES_HOME: hermesHomeDir, LOCALAPPDATA: path.join(isoDir, 'AppData', 'Local') };
    const r = require('child_process').spawnSync(process.execPath, [__filename], { encoding: 'utf8', env });
    const expectedTarget = path.join(hermesHomeDir, 'config.yaml');
    check('6b HERMES_HOME env var takes priority over the platform default', r.status === 0 && fs.existsSync(expectedTarget) && /post_tool_call/.test(fs.readFileSync(expectedTarget, 'utf8')));
  }

  // 7. reject: hooks: already has child entries (non-empty block, with a comment) -> rc 3, bytes unchanged, zero backup
  {
    const f = path.join(T, 'r1.yaml');
    const before = 'model:\n  default: x\nhooks:\n  # user-managed\n  pre_llm_call:\n    - command: "echo hi"\n';
    fs.writeFileSync(f, before);
    const stateDir = path.join(T, 'r1-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const r = require('child_process').spawnSync(process.execPath, [__filename, '--config', f], { encoding: 'utf8', env: { ...process.env, AXMEM_STATE_DIR: stateDir } });
    const after = fs.readFileSync(f, 'utf8');
    check('7 reject: non-empty hooks: with comment -> rc3, unchanged, no backup', r.status === 3 && after === before && !fs.existsSync(path.join(stateDir, 'backups')));
  }

  // 8. reject: duplicate top-level key
  {
    const f = path.join(T, 'r2.yaml');
    fs.writeFileSync(f, 'model:\n  default: x\nmodel:\n  default: y\n');
    const r = runWire(f);
    check('8 reject: duplicate top-level key', r.rc === 3);
  }

  // 9. reject: multi-document separator BEFORE candidate
  {
    const f = path.join(T, 'r3.yaml');
    fs.writeFileSync(f, 'a: 1\n---\nb: 2\n');
    const r = runWire(f);
    check('9 reject: --- separator before candidate', r.rc === 3);
  }

  // 10. reject: multi-document separator AFTER candidate (after hooks: {})
  {
    const f = path.join(T, 'r4.yaml');
    fs.writeFileSync(f, 'hooks: {}\n---\nb: 2\n');
    const r = runWire(f);
    check('10 reject: --- separator after candidate', r.rc === 3);
  }

  // 11. reject: '...' document-end marker
  {
    const f = path.join(T, 'r5.yaml');
    fs.writeFileSync(f, 'a: 1\n...\n');
    const r = runWire(f);
    check('11 reject: ... document-end marker', r.rc === 3);
  }

  // 12. reject: a line matching the "hooks:" pattern exactly sits at column 0
  // while a flow mapping opened EARLIER in the file is still unclosed —
  // proves the prefix scan (not just a net brace-balance over the whole
  // file) is what gates acceptance, since the file's TOTAL brace count is
  // balanced (one { ... one }) and only position-aware scanning catches it.
  {
    const f = path.join(T, 'r6.yaml');
    fs.writeFileSync(f, 'weird: {\nhooks:\n  other: 1\n}\n');
    const r = runWire(f);
    check('12 reject: column-0 "hooks:" line preceded by an still-open flow mapping', r.rc === 3);
  }

  // 13. reject: unclosed quote
  {
    const f = path.join(T, 'r7.yaml');
    fs.writeFileSync(f, 'a: "unterminated\nhooks: {}\n');
    const r = runWire(f);
    check('13 reject: unclosed quote before candidate', r.rc === 3);
  }

  // 14. reject: inline anchor
  {
    const f = path.join(T, 'r8.yaml');
    fs.writeFileSync(f, 'a: &anchor value\n');
    const r = runWire(f);
    check('14 reject: inline anchor (&a)', r.rc === 3);
  }

  // 15. reject: merge key <<: *a
  {
    const f = path.join(T, 'r9.yaml');
    fs.writeFileSync(f, 'a: &base\n  x: 1\nb:\n  <<: *base\n');
    const r = runWire(f);
    check('15 reject: merge key (<<: *a)', r.rc === 3);
  }

  // 16. reject: !!str tag
  {
    const f = path.join(T, 'r10.yaml');
    fs.writeFileSync(f, 'a: !!str 123\n');
    const r = runWire(f);
    check('16 reject: explicit tag (!!str)', r.rc === 3);
  }

  // 17. reject: % directive
  {
    const f = path.join(T, 'r11.yaml');
    fs.writeFileSync(f, '%YAML 1.2\n---\na: 1\n');
    const r = runWire(f);
    check('17 reject: % directive', r.rc === 3);
  }

  // 18. reject: duplicate top-level key appearing AFTER the candidate
  {
    const f = path.join(T, 'r12.yaml');
    fs.writeFileSync(f, 'hooks: {}\na: 1\na: 2\n');
    const r = runWire(f);
    check('18 reject: duplicate top-level key after candidate', r.rc === 3);
  }

  // 19. idempotent: wiring twice produces byte-identical output
  {
    const f = path.join(T, 'idem.yaml');
    fs.writeFileSync(f, 'model:\n  default: x\n');
    runWire(f);
    const first = fs.readFileSync(f);
    runWire(f);
    const second = fs.readFileSync(f);
    check('19 idempotent: wiring twice -> byte-identical', Buffer.compare(first, second) === 0);
  }

  // 20 (Opus M3): verifyWithRealLoader's three states, directly exercised.
  // `hermes` is not installed in this build/test environment, so real PATH
  // resolution can only ever prove the "not found -> skipped" branch on
  // its own; the "found, ok" and "found, rejects" branches are proven with
  // a real, executable fake "hermes" (a tiny .cmd script) injected via the
  // hermesCmdOverride test seam — this genuinely spawns and inspects a
  // real child process exit code, not a mocked function call.
  {
    const noneResult = verifyWithRealLoader('a: 1\n', 'b: 2\n', null);
    check('20a (Opus M3) hermes not found (override=null) -> used:false, ok:true (skipped, falls back to conservative-subset-only)', noneResult.used === false && noneResult.ok === true);
  }
  if (process.platform === 'win32') {
    const okScript = path.join(T, 'fake-hermes-ok.cmd');
    fs.writeFileSync(okScript, '@echo off\r\necho hooks listed ok\r\nexit /b 0\r\n');
    const okResult = verifyWithRealLoader('a: 1\n', 'b: 2\n', okScript);
    check('20b (Opus M3) fake hermes that always exits 0 -> used:true, ok:true (both original and candidate "loaded")', okResult.used === true && okResult.ok === true && okResult.origResult.ok && okResult.candResult.ok);

    const failScript = path.join(T, 'fake-hermes-fail.cmd');
    fs.writeFileSync(failScript, '@echo off\r\necho simulated real Hermes loader rejection 1>&2\r\nexit /b 1\r\n');
    const failResult = verifyWithRealLoader('a: 1\n', 'b: 2\n', failScript);
    check('20c (Opus M3) fake hermes that always exits nonzero -> used:true, ok:false (a real loader rejection is never silently ignored)', failResult.used === true && failResult.ok === false && !failResult.origResult.ok && !failResult.candResult.ok);

    // 20d: end-to-end through main()/runWire() — a rejecting real loader
    // must abort the actual CLI write (rc 3), never write the candidate.
    const f20 = path.join(T, 'r20.yaml');
    fs.writeFileSync(f20, 'model:\n  default: x\n');
    const before20 = fs.readFileSync(f20);
    const isoDir20 = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-wire-iso-20d-'));
    const r20 = runWire(f20, [], { ...process.env, AXMEM_STATE_DIR: path.join(isoDir20, 'state'), AXMEM_HOME: path.join(isoDir20, 'home'), AXMEM_TEST_HERMES_CMD_OVERRIDE: failScript });
    const after20 = fs.readFileSync(f20);
    check('20d (Opus M3) end-to-end: a rejecting real loader aborts the CLI write entirely (rc 3, file untouched)', r20.rc === 3 && Buffer.compare(before20, after20) === 0);
  } else {
    skip('20b-20d (Opus M3) fake-hermes CLI-integration tests: not running on win32 (.cmd scripts are Windows-specific)');
  }

  // 21 (Opus L5): runHermesHooksList's execFileSync uses shell:true on
  // win32 — Node does NOT quote the `file` argument for a shell-spawned
  // command, so an hermesCmd path containing a space (an ordinary case,
  // e.g. an install under "C:\Program Files\...") used to get split at
  // the first space and fail: cmd.exe tried to run the truncated prefix
  // ("C:\Program") as the command. Real repro, not synthetic: a real
  // executable .cmd placed under a directory whose name itself contains
  // a space.
  if (process.platform === 'win32') {
    const spacedDir = path.join(T, 'space dir');
    fs.mkdirSync(spacedDir, { recursive: true });
    const spacedScript = path.join(spacedDir, 'fake-hermes.cmd');
    fs.writeFileSync(spacedScript, '@echo off\r\necho hooks listed ok\r\nexit /b 0\r\n');
    const spacedResult = runHermesHooksList(spacedScript, 'a: 1\n');
    check('21 (Opus L5) hermesCmd containing a space in its path is correctly quoted under shell:true (not silently broken)', spacedResult.ok === true && /hooks listed ok/.test(spacedResult.output));
  } else {
    skip('21 (Opus L5) space-in-path hermesCmd test: not running on win32 (shell:true .cmd quoting is Windows-specific)');
  }

  console.log(results.join('\n'));
  console.log(skipped > 0
    ? `hermes wire self-test ${ok}/${total} ok, ${skipped} skipped (non-win32: .cmd/shell:true integration checks unavailable)`
    : `hermes wire self-test ${ok}/${total}`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
  return ok === total ? 0 : 1;
}

if (require.main === module) {
  if (process.argv[2] === '--self-test') {
    process.exit(selfTest());
  } else {
    main(process.argv.slice(2));
  }
}

module.exports = { analyze, hooksYamlBlock, hooksIdentityList, findUnclosedFlowOrQuote, fullDocumentViolations, resolveTargetPath, resolveHermesCommand, runHermesHooksList, verifyWithRealLoader };
