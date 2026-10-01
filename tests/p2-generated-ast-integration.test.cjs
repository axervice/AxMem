'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const F = require('../scripts/p2-freeze.cjs');
const A = require('../scripts/private/p2-bash-ast/adapter.cjs');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
  ok ? pass++ : fail++;
};
const source = (rows) => rows.join('\n');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const inspect = (text, marker = 'END', variable = 'tmp') =>
  F.inspectLiteralGeneratedArtifact('guards/gen.sh', Buffer.from(text), { marker, variable });
const expectError = (name, text, code) => {
  let got = '';
  try { inspect(text); } catch (e) { got = e.code || e.message; }
  check(name, got === code, 'got=' + got);
};

const valid = source([
  '#!/usr/bin/env bash',
  'tmp="$(mktemp)"',
  'cat > "$tmp" <<\'END\'',
  "console.log('伪尾');",
  'END',
  'node "$tmp"',
  '',
]);
const body = Buffer.from("console.log('伪尾');\n");
const inspected = inspect(valid);
check('utf8 body/span binding',
  inspected.heredoc.startLine === 3 &&
  inspected.heredoc.endLine === 5 &&
  inspected.heredoc.bodyBytes === body.length &&
  inspected.heredoc.bodySha256 === sha256(body) &&
  inspected.body.equals(body) &&
  inspected.call.line === 6);

for (const q of [
  '# node "$tmp"',
  "echo 'node \"$tmp\"'",
  'echo node "$tmp"',
  'printf "%s" node "$tmp"',
  'test node "$tmp"',
]) {
  expectError('pseudo ' + q,
    source(['cat > "$tmp" <<\'END\'', "console.log('ok');", 'END', q, '']),
    'generated-call-ambiguous');
}
expectError('other heredoc pseudo',
  source(['cat > "$tmp" <<\'END\'', "console.log('ok');", 'END', 'cat > "$other" <<\'OTHER\'', 'node "$tmp"', 'OTHER', '']),
  'generated-call-ambiguous');
expectError('multiline quoted pseudo',
  source(['cat > "$tmp" <<\'END\'', "console.log('ok');", 'END', "echo 'text", 'node "$tmp"', "more'", '']),
  'generated-call-ambiguous');
expectError('quoted double node',
  source(['cat > "$tmp" <<\'END\'', "console.log('ok');", 'END', 'node "$tmp"', "'node' \"$tmp\"", '']),
  'generated-call-ambiguous');
expectError('unknown glob blocks',
  source(['cat > "$tmp" <<\'END\'', "console.log('ok');", 'END', 'node "$tmp"', 'n* "$tmp"', '']),
  'generated-shell-unsupported');
expectError('unknown dynamic blocks',
  source(['cat > "$tmp" <<\'END\'', "console.log('ok');", 'END', 'node "$tmp"', '"$cmd" "$tmp"', '']),
  'generated-shell-unsupported');

for (const opener of [
  'printf > "$tmp" <<\'END\'',
  'cat > "$other" <<\'END\'',
  'cat 2> "$tmp" <<\'END\'',
  'cat <<\'END\' > "$tmp"',
  'cat ignored > "$tmp" <<\'END\'',
]) {
  expectError('bad owner ' + opener,
    source([opener, "console.log('ok');", 'END', 'node "$tmp"', '']),
    'generated-heredoc-not-literal');
}
expectError('wrong stmt association',
  source(['cat > "$other" <<\'END\'', "console.log('a');", 'END', 'cat > "$tmp" <<\'OTHER\'', "console.log('b');", 'OTHER', 'node "$tmp"', '']),
  'generated-heredoc-not-literal');
expectError('duplicate marker',
  source(['cat > "$tmp" <<\'END\'', "console.log('a');", 'END', 'cat > "$tmp" <<\'END\'', "console.log('b');", 'END', 'node "$tmp"', '']),
  'generated-heredoc-ambiguous');

const parserDir = path.dirname(require.resolve('../scripts/private/p2-bash-ast/adapter.cjs'));
const sharedExe = path.join(parserDir, ...A.EXE_REL.split('/'));
const sharedLock = JSON.parse(fs.readFileSync(path.join(parserDir, 'helper.lock.json'), 'utf8'));
const sharedBefore = sha256(fs.readFileSync(sharedExe));
check('shared helper starts at locked hash', sharedBefore === sharedLock.executableSha256, sharedBefore);

function makeParserSandbox(label, helperPath) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-r6a-' + label + '-'));
  const dir = path.join(root, 'parser');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(parserDir, 'adapter.cjs'), path.join(dir, 'adapter.cjs'));
  fs.copyFileSync(path.join(parserDir, 'helper.lock.json'), path.join(dir, 'helper.lock.json'));
  if (helperPath) fs.copyFileSync(helperPath, path.join(dir, 'bin', 'p2-bash-ast.exe'));
  return { root, dir, exe: path.join(dir, 'bin', 'p2-bash-ast.exe') };
}
function runSandboxError(sandbox, expected) {
  let got = '';
  try { require(path.join(sandbox.dir, 'adapter.cjs')).parseShellAst(Buffer.from(valid)); }
  catch (e) { got = e.code || e.message; }
  check(expected, got === expected, 'got=' + got);
}

{
  const box = makeParserSandbox('missing', sharedExe);
  try {
    fs.rmSync(box.exe);
    runSandboxError(box, 'generated-parser-helper-missing');
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
}
{
  const box = makeParserSandbox('bad-hash', sharedExe);
  try {
    const bad = fs.readFileSync(box.exe);
    bad[bad.length - 1] ^= 1;
    fs.writeFileSync(box.exe, bad);
    runSandboxError(box, 'generated-parser-helper-hash');
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
}
{
  const badHelper = process.env.AXMEM_R6A_BAD_OUTPUT_HELPER;
  if (!badHelper || !fs.existsSync(badHelper)) {
    check('generated-parser-output-json', false, 'AXMEM_R6A_BAD_OUTPUT_HELPER missing');
  } else {
    const box = makeParserSandbox('bad-output', badHelper);
    try {
      const badHash = sha256(fs.readFileSync(box.exe));
      const lockPath = path.join(box.dir, 'helper.lock.json');
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const originalHash = lock.executableSha256;
      lock.executableSha256 = badHash;
      fs.writeFileSync(lockPath, JSON.stringify(lock));
      const adapterPath = path.join(box.dir, 'adapter.cjs');
      fs.writeFileSync(adapterPath, fs.readFileSync(adapterPath, 'utf8').replace(originalHash, badHash));
      runSandboxError(box, 'generated-parser-output-json');
    } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
  }
}

const sharedAfter = sha256(fs.readFileSync(sharedExe));
check('shared helper unchanged after isolation negatives',
  sharedAfter === sharedBefore && sharedAfter === sharedLock.executableSha256,
  JSON.stringify({ before: sharedBefore, after: sharedAfter }));

console.log('SUMMARY ' + JSON.stringify({ pass, fail, total: pass + fail }));
if (fail) process.exit(1);