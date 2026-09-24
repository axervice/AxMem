#!/usr/bin/env node
// AxMem pointer-lint — every pointer must resolve. (P1 port, 2026-09-13)
// Compression is only legal when the detail is alive somewhere else; this is
// the machine that checks "somewhere else" is real. Categories:
//   A dangling wiki-refs [[ns:tag]] with no definition anywhere in scope
//   B naked wiki-refs [[word]] (legacy form, listed only)
//   C broken backtick path pointers (tried against every configured root,
//     then against origin/<default-branch> of repo roots — a stale checkout
//     must not convict a live pointer)
// KNOWN-CEILING (declared, not iterated): no semantic "does the target cover
// the content" check — that is a judgment call and judgment-metadata rots.
'use strict';
const fs = require('fs');
const cp = require('child_process');
const ctx = require('../lib/prelude.cjs');

const MEM = ctx.MEMORY_DIR;
const STRICT = process.argv.includes('--strict');
const REF_FILES = ['decisions.md', 'lessons.md', 'standinginstructions.md'];

function listMd(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => dir + '/' + f); } catch { return []; }
}
function exp(p) { p = String(p).replace(/\\/g, '/'); return p.startsWith('~/') ? ctx.HOME_DIR + p.slice(1) : p; }

// definition sources: whole memory dir (+ dreams/) + configured extras
// (e.g. per-project LESSONS.md files that own project-scoped tags)
const defSources = [
  ...listMd(MEM), ...listMd(MEM + '/dreams'),
  ...ctx.cfgGet('pointer_lint.extra_def_sources', []).map(exp).filter(f => { try { return fs.existsSync(f); } catch { return false; } }),
];
const defined = new Set();
const DEF_RE = /\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/g;
for (const f of defSources) {
  let s; try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const m of s.matchAll(DEF_RE)) {
    if (m.index > 0 && s[m.index - 1] === '[') continue; // inner part of [[...]]
    defined.add(m[1]);
  }
}

const ROOTS = [ctx.AXMEM_HOME, MEM, ...ctx.repos.flatMap(r => (r.roots || []).map(exp))];
const SKIP = ctx.cfgGet('pointer_lint.skip_patterns', []).map(p => new RegExp(p, 'i'));

const dangling = [], naked = [], broken = [];
const REF_RE = /\[\[([^\[\]\n]+)\]\]/g;
const TICK_RE = /`([^`\n]+)`/g;
const PATHISH = /^(~\/|[A-Za-z]:\/|\.claude\/|docs\/|guards\/|dreams\/|memory\/|scripts\/|core\/|lib\/|adapters\/)[^ *<>|"?]*$/;

function cands(tok) {
  let t = tok.replace(/\\/g, '/').replace(/[@#§].*$/, '').replace(/[),;:。:、]+$/, '').replace(/:\d+([-,]\d+)?$/, '');
  if (!t.includes('/') || /\s/.test(t)) return null;
  if (t.startsWith('~/')) return { rel: null, list: [ctx.HOME_DIR + t.slice(1)] };
  if (/^[A-Za-z]:\//.test(t)) return { rel: null, list: [t] };
  return { rel: t, list: ROOTS.map(r => r.replace(/\/$/, '') + '/' + t) };
}

for (const name of REF_FILES) {
  let s; try { s = fs.readFileSync(MEM + '/' + name, 'utf8'); } catch { continue; }
  s.split(/\r?\n/).forEach((line, idx) => {
    const loc = name + ':' + (idx + 1);
    for (const m of line.matchAll(REF_RE)) {
      const tag = m[1].trim();
      if (!tag.includes(':')) { naked.push({ loc, tag }); continue; }
      if (!/^[a-z][a-z0-9-]*:[A-Za-z0-9._-]+$/.test(tag)) continue;
      if (!defined.has(tag)) dangling.push({ loc, tag });
    }
    for (const m of line.matchAll(TICK_RE)) {
      const tok = m[1];
      if (!PATHISH.test(tok.replace(/\\/g, '/'))) continue;
      if (SKIP.some(re => re.test(tok.replace(/\\/g, '/')))) continue;
      const c = cands(tok);
      if (!c) continue;
      if (c.list.some(p => { try { return fs.existsSync(p); } catch { return false; } })) continue;
      // stale-checkout fallback: repo-relative tokens get a second look at the
      // remote default branch before being declared broken
      const inGit = c.rel && ctx.repos.some(r => (r.roots || []).some(rootRaw => {
        try {
          cp.execFileSync('git', ['-C', exp(rootRaw), 'cat-file', '-e', 'origin/HEAD:' + c.rel], { stdio: 'pipe', timeout: 5000 });
          return true;
        } catch {
          try {
            cp.execFileSync('git', ['-C', exp(rootRaw), 'cat-file', '-e', 'origin/main:' + c.rel], { stdio: 'pipe', timeout: 5000 });
            return true;
          } catch { return false; }
        }
      }));
      if (!inGit) broken.push({ loc, tok, tried: c.list.length });
    }
  });
}

console.log(`axmem pointer-lint (as-of ${new Date().toISOString().slice(0, 10)}; ${defSources.length} def sources, ${defined.size} tags)`);
console.log(`DANGLING_TAGS=${dangling.length}`);
for (const d of dangling) console.log(`  A ${d.loc}  [[${d.tag}]]`);
console.log(`NAKED_REFS=${naked.length}`);
for (const n of naked) console.log(`  B ${n.loc}  [[${n.tag}]]`);
console.log(`BROKEN_PATHS=${broken.length}`);
for (const b of broken) console.log(`  C ${b.loc}  \`${b.tok}\` (${b.tried} roots tried)`);
if (STRICT && (dangling.length || broken.length)) process.exit(2);
