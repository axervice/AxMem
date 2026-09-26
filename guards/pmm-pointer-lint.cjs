#!/usr/bin/env node
// pmm-pointer-lint — 指针完整性 lint(2026-09-13,the maintainer 批[memory:pointer-integrity-lint-approved])。
// 双令合璧的后半:entry-cap 900B+[sole-record] 管"不能指的必须留全文",本件管"能指的必须指得准"。
// 起因:07-31 dedup 指针目标不覆盖、08-02 凭印象重述——指针失真两起实证。
//
// v1 范围(KNOWN-CEILING,刻意声明,不迭代成军备竞赛——见 [process:regex-tightening-has-a-ceiling-declare-it]):
//   A. 悬空双链 [[ns:tag]]:引用的 tag 在任何记忆文件(含归档/PERMANENT)都无单括号定义。
//   B. 无命名空间双链 [[word]]:legacy 形态,只计数列出(新增的由 entry-length-watch 拦)。
//   C. 断链路径指针:反引号包裹的路径样 token 解析后文件不存在(试 HOME/EXTRA_ROOTS 各根)。
//   不做:语义锚点核验(目标"是否真覆盖内容"是判断题,机器判=A3 校准砍的老路)。
// 模式:纯报告(exit 0),--strict 时有 A/C 类发现 exit 2(接线前必须先过校准期——
//   同类 lint 已死两台:08-03 悬空扫 48 误报当日砍、A3 20 命中全误报)。
'use strict';
const fs = require('fs');
const path = require('path');
const { resolveHome } = require('./pmm-recall-ledger.cjs');

const HOME = (process.env.PMM_HOME || resolveHome()).replace(/\\/g, '/');
const MEM = (process.env.PMM_MEM_DIR || HOME + '/.claude/memory').replace(/\\/g, '/');
const STRICT = process.argv.includes('--strict');

const REF_FILES = ['decisions.md', 'lessons.md', 'standinginstructions.md'];
// Extra project roots a backtick-quoted path pointer may resolve against, besides HOME/.claude/MEM —
// configure via PMM_POINTER_EXTRA_ROOTS (comma-separated absolute paths); empty by default.
const EXTRA_ROOTS = (process.env.PMM_POINTER_EXTRA_ROOTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ROOTS = [HOME, HOME + '/.claude', MEM, ...EXTRA_ROOTS];
// Cross-machine / conditionally-present pointer allowlist (skip existence check; these may
// legitimately not exist on this machine). Configure extra regex prefixes to skip via
// PMM_POINTER_SKIP_PREFIXES (comma-separated, matched case-insensitively as a path prefix).
const PATH_SKIP = [/\/\.vercel-token$/,
  ...(process.env.PMM_POINTER_SKIP_PREFIXES || '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((p) => new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))];

function listMd(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => dir + '/' + f); }
  catch { return []; }
}

// ── tag 清单:单括号 [ns:tag] 出现在任何记忆 md(含归档)+ PERMANENT ──
const defSources = [...listMd(MEM), ...listMd(MEM + '/dreams'),
  ...listMd((process.env.PMM_PERMANENT_DIR || HOME + '/.claude/pmm-permanent/permanent').replace(/\\/g, '/')),
  // Project-specific lessons live in each project repo's own LESSONS.md / LESSONS-CRITICAL.md
  // (lessons routing) rather than the shared memory dir; PMM cross-references them legally, so the
  // definition-source set must include them. Derived from EXTRA_ROOTS (PMM_POINTER_EXTRA_ROOTS) —
  // empty by default, so this adds nothing unless the deployment configures extra project roots.
  ...EXTRA_ROOTS.flatMap((root) => [root + '/LESSONS.md', root + '/LESSONS-CRITICAL.md'])
    .filter(f => { try { return fs.existsSync(f); } catch { return false; } })];
const defined = new Set();
const DEF_RE = /\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/g;
for (const f of defSources) {
  let s; try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const m of s.matchAll(DEF_RE)) {
    // 排除双链本身([[x]] 的内层匹配):前一字符是 [ 则跳过
    const i = m.index;
    if (i > 0 && s[i - 1] === '[') continue;
    defined.add(m[1]);
  }
}

// ── 扫引用 ──
const dangling = [], naked = [], broken = [];
const REF_RE = /\[\[([^\[\]\n]+)\]\]/g;
const TICK_RE = /`([^`\n]+)`/g;
const PATHISH = /^(~\/|[A-Za-z]:\/|\.claude\/|guards\/|docs\/|dreams\/|memory\/|scripts\/)[^ *<>|"?]*$/;

function resolveCandidates(tok) {
  let t = tok.replace(/\\/g, '/');
  t = t.replace(/[@#§].*$/, '');            // 剥 @commit / #anchor / §节
  t = t.replace(/[),;:。:、]+$/, '');        // 剥尾部标点
  t = t.replace(/:\d+([-,]\d+)?$/, '');      // 剥 :line 后缀
  if (!t.includes('/') || /\s/.test(t)) return null;
  if (t.startsWith('~/')) return [HOME + t.slice(1)];
  if (/^[A-Za-z]:\//.test(t)) return [t];
  return ROOTS.map(r => r + '/' + t);
}

for (const name of REF_FILES) {
  const f = MEM + '/' + name;
  let s; try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const lines = s.split('\n');
  lines.forEach((line, idx) => {
    const loc = name + ':' + (idx + 1);
    for (const m of line.matchAll(REF_RE)) {
      const tag = m[1].trim();
      if (!tag.includes(':')) { naked.push({ loc, tag }); continue; }
      if (!/^[a-z][a-z0-9-]*:[A-Za-z0-9._-]+$/.test(tag)) continue; // 非 tag 形态(如中文说明)不判
      if (!defined.has(tag)) dangling.push({ loc, tag });
    }
    for (const m of line.matchAll(TICK_RE)) {
      const tok = m[1];
      if (!PATHISH.test(tok.replace(/\\/g, '/'))) continue;
      if (PATH_SKIP.some(re => re.test(tok.replace(/\\/g, '/').replace(/^~/, '')))) continue;
      const cands = resolveCandidates(tok);
      if (!cands) continue;
      if (!cands.some(c => { try { return fs.existsSync(c); } catch { return false; } })) {
        // 后备眼睛:工作树没有 ≠ 不存在——主 checkout 常落后 origin/main 上千 commit(09-13 实证:
        // BUG-TAXONOMY.md 被误报断链,实际在 origin/main 活跃维护)。相对路径再问一次 git 远端快照。
        const rel = tok.replace(/\\/g, '/').replace(/[@#§].*$/, '').replace(/[),;:。:、]+$/, '');
        // execFileSync 参数数组(2026-09-13 Opus P2:PATHISH 放行 % & $,字符串拼 shell 有注入面)
        const inGit = !rel.startsWith('~') && !/^[A-Za-z]:\//.test(rel) && EXTRA_ROOTS.some(root => {
          try {
            require('child_process').execFileSync('git', ['-C', root, 'cat-file', '-e', 'origin/main:' + rel], { stdio: 'pipe', timeout: 5000 });
            return true;
          } catch { return false; }
        });
        if (!inGit) broken.push({ loc, tok, tried: cands.length });
      }
    }
  });
}

// ── 报告 ──
const asof = new Date().toISOString().slice(0, 10);
console.log(`pmm-pointer-lint 报告(as-of ${asof};tag 定义源 ${defSources.length} 文件,已定义 ${defined.size} tag)`);
console.log(`DANGLING_TAGS=${dangling.length}`);
for (const d of dangling) console.log(`  A 悬空双链  ${d.loc}  [[${d.tag}]]`);
console.log(`NAKED_REFS=${naked.length}`);
for (const n of naked) console.log(`  B 无命名空间  ${n.loc}  [[${n.tag}]]`);
console.log(`BROKEN_PATHS=${broken.length}`);
for (const b of broken) console.log(`  C 断链路径  ${b.loc}  \`${b.tok}\`(试 ${b.tried} 根)`);
if (STRICT && (dangling.length || broken.length)) process.exit(2);
