'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const F = require('../scripts/p2-freeze.cjs');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
  ok ? pass++ : fail++;
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function git(root, args) {
  return cp.execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }

const generatorText = [
  '#!/usr/bin/env bash',
  'tmp="$(mktemp)"',
  'cat > "$tmp" <<\'GEN_EOF\'',
  'console.log("ok");',
  'GEN_EOF',
  'node "$tmp"',
  '',
].join('\n');

function makeBaseInventory() {
  const generator = Buffer.from(generatorText);
  const actual = F.inspectLiteralGeneratedArtifact('generator.sh', generator, { variable: 'tmp', marker: 'GEN_EOF' });
  return {
    version: 1,
    settingsJson: 'settings.json',
    settingsMirror: 'settings-mirror.json',
    hooks: [],
    files: [
      { path: 'settings-mirror.json', disposition: 'port', dependencies: [], unresolvedDependencies: [], notes: 'synthetic tracked settings mirror' },
      {
        path: 'generator.sh',
        disposition: 'port',
        dependencies: ['generated-dep.cjs'],
        unresolvedDependencies: [{
          expression: '$tmp',
          dependencies: ['generated-dep.cjs'],
          reason: 'synthetic fixture closure target; generated evidence itself is not a waiver',
        }],
        notes: 'synthetic generated artifact owner',
      },
      { path: 'generated-dep.cjs', disposition: 'port', dependencies: [], unresolvedDependencies: [], notes: 'synthetic reviewed closure target' },
    ],
    externalDependencies: [],
    auditEvidence: ['synthetic R9 generated-artifact buildManifest fixture'],
    allowedDifferences: [],
    generatedArtifacts: [{
      version: 1,
      id: 'generated-main',
      generatorPath: 'generator.sh',
      generatorSha256: actual.generatorSha256,
      heredoc: { ...actual.heredoc },
      call: { ...actual.call },
      untrustedClaim: 'must-not-survive-normalization',
    }],
  };
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-r9-ga-'));
  const live = path.join(root, '.claude');
  fs.mkdirSync(live, { recursive: true });
  writeJson(path.join(live, 'settings.json'), { hooks: {} });
  writeJson(path.join(live, 'settings-mirror.json'), { hooks: {} });
  fs.writeFileSync(path.join(live, 'generator.sh'), generatorText);
  fs.writeFileSync(path.join(live, 'generated-dep.cjs'), 'module.exports = 1;\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'R9']);
  git(root, ['config', 'user.email', 'r9@example.invalid']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['add', '.claude']);
  git(root, ['commit', '-qm', 'synthetic frozen source']);
  return { root, live, inventory: makeBaseInventory(), inventoryPath: path.join(root, 'inventory.json') };
}
function runBuild(fx, inv = fx.inventory) {
  writeJson(fx.inventoryPath, inv);
  return F.buildManifest({ liveDir: fx.live, inventoryPath: fx.inventoryPath, generatedAt: '2026-09-30T00:00:00.000Z' });
}
function expectError(name, mutate, code) {
  const fx = makeFixture();
  let got = '';
  try {
    const inv = structuredClone(fx.inventory);
    mutate(inv, fx);
    runBuild(fx, inv);
  } catch (e) {
    got = e && e.code ? e.code : String(e && e.message || e);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
  check(name, got === code, 'got=' + got);
}

{
  const fx = makeFixture();
  try {
    const m = runBuild(fx);
    const g = m.generatedArtifacts;
    check('verified record reaches manifest', Array.isArray(g) && g.length === 1 && g[0].id === 'generated-main');
    check('manifest record is verifier output', g[0].status === 'artifact-verified' && g[0].executionClosed === false && !Object.prototype.hasOwnProperty.call(g[0], 'untrustedClaim'));
    check('verified hash bound to frozen generator', g[0].generatorSha256 === sha256(fs.readFileSync(path.join(fx.live, 'generator.sh'))));
    check('existing manifest schema unchanged', m.schema === 'axmem-p2-freeze/v1' && Array.isArray(m.sourceFiles) && Array.isArray(m.hooks));
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
}

{
  const fx = makeFixture();
  try {
    const inv = structuredClone(fx.inventory);
    delete inv.generatedArtifacts;
    const m = runBuild(fx, inv);
    check('missing generatedArtifacts stays backward compatible', Array.isArray(m.generatedArtifacts) && m.generatedArtifacts.length === 0);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
}

{
  const fx = makeFixture();
  try {
    const inv = structuredClone(fx.inventory);
    inv.generatedArtifacts = [];
    const m = runBuild(fx, inv);
    check('explicit empty generatedArtifacts stays compatible', Array.isArray(m.generatedArtifacts) && m.generatedArtifacts.length === 0);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
}

expectError('generatedArtifacts null rejected', (inv) => {
  inv.generatedArtifacts = null;
}, 'bad-inventory');

expectError('forged generator hash rejected', (inv) => {
  inv.generatedArtifacts[0].generatorSha256 = '0'.repeat(64);
}, 'generated-generator-hash-mismatch');

expectError('missing frozen generator rejected', (inv) => {
  inv.generatedArtifacts[0].generatorPath = 'missing-generator.sh';
}, 'generated-generator-missing');

expectError('duplicate id rejected', (inv) => {
  inv.generatedArtifacts.push(structuredClone(inv.generatedArtifacts[0]));
}, 'generated-artifact-duplicate-id');

expectError('conflicting duplicate anchor rejected', (inv) => {
  const second = structuredClone(inv.generatedArtifacts[0]);
  second.id = 'generated-second';
  inv.generatedArtifacts.push(second);
}, 'generated-artifact-conflict');

expectError('generatedArtifacts wrong type rejected', (inv) => {
  inv.generatedArtifacts = {};
}, 'bad-inventory');

expectError('bad record field type rejected', (inv) => {
  inv.generatedArtifacts[0].heredoc.bodyBytes = '17';
}, 'generated-artifact-bad-record');

expectError('generated evidence cannot waive unresolved dependency review', (inv) => {
  inv.files.find((x) => x.path === 'generator.sh').unresolvedDependencies = [];
}, 'dependency-unresolved-dynamic');

console.log('SUMMARY ' + JSON.stringify({ pass, fail, total: pass + fail }));
if (fail) process.exit(1);
