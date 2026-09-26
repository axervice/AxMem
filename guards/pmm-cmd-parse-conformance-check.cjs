#!/usr/bin/env node
// pmm-cmd-parse-conformance-check.cjs — guard-canary line for "104/104 conformance fixture against the
// production parser, via the acceptance runner's OWN exported runParserConformance (same code path G08
// uses, not a second assertion set)".
//
// Exists as its own file (not an inline `node -e "..."` in guard-canary.sh) because a path embedded
// inside a `-e` JS source string is never argv-translated by MSYS/Git Bash the way a bash-passed argv
// element is (`node "$G/x.cjs"` works; `node -e "require('$G/x.cjs')"` does NOT when $HOME resolves to a
// POSIX-style "/c/Users/..." path, which this host's Git Bash does) — require() then sees a literal
// "/c/..." path no native-Windows node.exe can resolve, and the check throws MODULE_NOT_FOUND before it
// ever touches the conformance fixture. __dirname-relative requires in an actual file are unaffected: the
// script PATH itself is a normal argv element bash already translated for node.exe.
'use strict';
const path = require('path');
const runner = require(path.join(__dirname, 'pipe-gate-v2-acceptance.cjs'));

const conformancePath = path.join(__dirname, 'specs', 'pmm-cmd-parse-conformance.json');
const parserModulePath = path.join(__dirname, 'pmm-cmd-parse.cjs');
const r = runner.runParserConformance(conformancePath, parserModulePath);
const passed = r.results.filter((x) => x.pass).length;
if (passed !== r.results.length) {
  process.stderr.write('pmm-cmd-parse-conformance: ' + passed + '/' + r.results.length + ' passed\n');
  process.exit(1);
}
process.exit(0);
