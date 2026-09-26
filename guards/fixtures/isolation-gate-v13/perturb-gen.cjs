'use strict';
// Mechanical perturbation-family generator (C05-BUILD-SPEC.md 补遗三 第27条 "扰动族" bullet). Takes
// every classification=deny case from the registered contract and produces perturbed variants; every
// variant must still deny. Perturbations are TEXTUAL and best-effort (this is a fuzzer, not a shell
// lexer) -- a perturbation that does not cleanly apply to a given command (no matching anchor) is
// skipped for that command rather than corrupting it.
const fs = require('fs');
const CONTRACT = 'C:/Users/<user>/.claude/guards/specs/isolation-gate-contract.json';
const c = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'));
const denyCases = c.cases.filter((k) => k.classification === 'deny' && typeof k.command === 'string');
// D18-shape cases need their hook_env (ambient PMM_RECALL_ROOT override) carried through to every
// perturbed variant too, or the ambient-not-overridden check this pins never triggers regardless of
// the command text perturbation.

function firstMatch(text, re) { const m = text.match(re); return m ? m.index : -1; }

const PERTURBERS = {
  'redirect-before-connector': (cmd) => {
    for (const re of [/\|\|/, /&&/, /;/, /\|/]) {
      const i = firstMatch(cmd, re);
      if (i !== -1) return cmd.slice(0, i) + ' 2>/dev/null ' + cmd.slice(i);
    }
    return cmd + ' 2>/dev/null';
  },
  'node-dot-exe': (cmd) => (/\bnode\b/.test(cmd) ? cmd.replace(/\bnode\b/, 'node.exe') : null),
  'bash-dot-exe': (cmd) => (/\bbash\b/.test(cmd) ? cmd.replace(/\bbash\b/, 'bash.exe') : null),
  'sh-dot-exe': (cmd) => (/(^|[^a-z.])sh\b/.test(cmd) ? cmd.replace(/(^|[^a-z.])sh\b/, '$1sh.exe') : null),
  'bash-pipefail': (cmd) => (/\bbash\b/.test(cmd) ? cmd.replace(/\bbash\b/, 'bash -o pipefail') : null),
  'bash-extglob': (cmd) => (/\bbash\b/.test(cmd) ? cmd.replace(/\bbash\b/, 'bash -O extglob') : null),
  'node-no-warnings': (cmd) => (/\bnode\b/.test(cmd) ? cmd.replace(/\bnode\b/, 'node --no-warnings') : null),
  // prefix-{timeout,nice,stdbuf,env,command,exec}: skipped (return null) when the command's own FIRST
  // token is itself a bare "NAME=value" assignment (front-assignment-leading shapes, e.g. D111's
  // `BASH_ENV=<DUT> bash -c true`) -- inserting a real command word BEFORE that assignment breaks it
  // in genuine POSIX semantics too (a leading "VAR=val" is only special immediately before a command
  // name; "timeout 5 VAR=val bash..." makes "VAR=val" a literal, non-special argument to timeout, not
  // an env override for bash), so this is not a meaningful perturbation of that shape.
  'prefix-timeout': (cmd) => (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd) ? null : 'timeout 5 ' + cmd),
  'prefix-nice': (cmd) => (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd) ? null : 'nice ' + cmd),
  'prefix-stdbuf': (cmd) => (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd) ? null : 'stdbuf -oL ' + cmd),
  'prefix-env': (cmd) => (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd) ? null : 'env ' + cmd),
  'prefix-command': (cmd) => (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd) ? null : 'command ' + cmd),
  'prefix-exec': (cmd) => (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd) ? null : 'exec ' + cmd),
  'dut-quote-splice': (cmd) => {
    const m = cmd.match(/([a-z0-9][a-z0-9-]*?)([a-z0-9])((\.cjs)|(\.sh))\b/i);
    if (!m) return null;
    const idx = m.index + m[1].length + 1; // split after first char of the middle group, arbitrary mid-point
    return cmd.slice(0, idx) + "''" + cmd.slice(idx);
  },
  'dut-ext-upper': (cmd) => {
    if (/\.cjs\b/.test(cmd)) return cmd.replace(/\.cjs\b/, '.CJS');
    if (/\.sh\b/.test(cmd)) return cmd.replace(/\.sh\b/, '.SH');
    return null;
  },
  // dut-path-backslash: converts a bare "~/.claude/guards/<name>" TOKEN to backslash separators AND
  // single-quotes the whole token (matching the only real-bash-valid way to write it -- an UNQUOTED
  // backslash is a POSIX escape that bash strips, concatenating the path into nonsense; the registered
  // V10 contract case already pins this exact single-quoted shape). Only applied when a clean
  // whitespace-delimited token boundary exists.
  'dut-path-backslash': (cmd) => {
    // token boundary stops at whitespace AND shell metacharacters (; | & < > $ ` ( ) " ') -- a naive
    // [^\s]+ match ran past the true token into a trailing `;`/`$(...)`  on several cases, corrupting
    // the command's structure rather than perturbing just the path. Skipped (null) when the matched
    // span already contains a backslash (esc6 D105/V05-shape: an UNQUOTED escape-backslash already
    // inside the basename, e.g. "pmm-trigger-rec\all.cjs" -- wrapping THAT in single quotes changes
    // its meaning, since a quoted backslash is literal rather than an escape, producing a genuinely
    // different (non-DUT) filename, not a perturbed-but-equivalent DUT reference).
    const m = cmd.match(/~\/\.claude\/guards\/[^\s'";|&<>$`()]+/);
    if (!m || m[0].indexOf('\\') !== -1) return null;
    const winPath = m[0].replace(/\//g, '\\');
    return cmd.slice(0, m.index) + "'" + winPath + "'" + cmd.slice(m.index + m[0].length);
  },
  'dut-trailing-dot': (cmd) => {
    if (/\.cjs\b/.test(cmd)) return cmd.replace(/\.cjs\b/, '.cjs.');
    if (/\.sh\b/.test(cmd)) return cmd.replace(/\.sh\b/, '.sh.');
    return null;
  },
};

const out = [];
for (const kase of denyCases) {
  for (const [name, fn] of Object.entries(PERTURBERS)) {
    let variant;
    try { variant = fn(kase.command); } catch { variant = null; }
    if (variant == null || variant === kase.command) continue;
    out.push({ id: kase.id + '~' + name, base_id: kase.id, perturbation: name, command: variant, hook_env: kase.hook_env });
  }
}
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + '\n', 'utf8');
console.log('generated', out.length, 'perturbed variants from', denyCases.length, 'deny cases');
