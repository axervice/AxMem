#!/usr/bin/env node
'use strict';
// pmm-precommit-shadow-replay.cjs — C0.5 交付物 4 回放引擎(见同目录 pmm-precommit-shadow-replay.sh
// 头注;spec: guards/specs/C05-BUILD-SPEC.md 交付物 4 + 补遗一第 12、16 条)。
//
// 只读、不参与任何真闸判定:对最近 N(默认 30)笔触及 .claude/memory 的真实提交,逐笔以「该提交
// 本身(after)」对「其父提交(before)」跑 v3 core 的快照 diff——这与交付物 4 描述的「core --diff
// HEAD :0」是同一机制在任意两个历史 git ref 上的复用(pmm-core.cjs 的 snapshot(ref) 本就接受任意
// git ref,不止 'HEAD'/'worktree'/':0';见该文件 homeDir() 上方注释:「HEAD/:0 : git -C <gitHome>
// show <ref>:.claude/memory/<file>」)。
//
// 输出两张清单:
//   ①「v3 会拦而当时放行」:该提交的 diff 让 v3 的 blocking 集合新增条目——它确实是一笔已存在
//      的提交,按 spec 原文「提交存在=没被拦」这一既成事实,历史上没被挡。
//   ②「当时拦而 v3 不拦」:spec 交付物 4 原文把「当时是否被拦」的取值定义死为「提交存在=没被
//      拦」——在这个定义下,「当时拦」这一侧对已存在的历史提交永远不成立,所以这张表在 C0.5
//      这一批结构性恒为空。这不是本引擎的漏统计,是 spec 原文定义的直接推论:如果之后想让它
//      统计真实的历史拦截事件(例如 --no-verify 绕过的记录),需要另一路数据源(git 提交本身
//      不携带"曾被拒绝"的痕迹),不在本批范围内——已在 B3 建造回报里作为 spec 歧义标注给
//      主脑/收口者复核,这里不擅自发明替代定义(执行层纪律:spec 不明处停下报告,不扩大范围)。
//
// 调用约定:必须以完整隔离环境启动(HOME=USERPROFILE=PMM_HOME=<T> + PMM_GIT_HOME=<要回放的
// git 仓库根>);见 pmm-precommit-shadow-replay.sh(生产包装,PMM_GIT_HOME 指向真 home)与本文件
// --self-test(fixture 包装,PMM_GIT_HOME 指向临时 fixture 仓库)。本文件自身不读写 HOME 下任何
// 东西,只经 pmm-core.cjs 的 homeDir()(PMM_GIT_HOME 优先于 ledger.resolveHome())只读 git 调用。
//
// 第 12 条(语料是移动靶):开工先取一次 `HEAD:.claude/memory` 的 OID 并钉住,收工再取一次;
// 若漂移(并发的 pmm save 之类在本轮回放期间改了语料),整轮结论作废、非零退出,不返回半新半
// 旧拼出来的结果。
// 第 16 条(隔离铁律):footprint.begin()/end() 包住整段计算,断言真根零足迹——本引擎理论上根本
// 不该碰真根任何文件(纯读 + 可选 --out 写用户指定路径),这里的 footprint 断言是双保险。
const path = require('path');
const { execFileSync } = require('child_process');
const core = require(path.join(__dirname, 'pmm-core.cjs'));
const iso = require(path.join(__dirname, 'selftest-iso.cjs'));

function evalRef(ref) {
  const snap = core.snapshot(ref, { requireAll: false });
  const parsed = core.parseAll(snap);
  const graph = core.buildGraph(parsed.entries);
  return core.check(snap, parsed, graph, {}).blocking;
}

function gitOut(gitHome, args) {
  return execFileSync('git', ['-C', gitHome].concat(args), { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 }).trim();
}

// M1 修复(guards/audits/OPUS-2026-09-24-c05-wave2-review.md「M1 B3 列① 8 实为 2 真新增」):blocking
// 字符串内嵌 `file:line`/字节数(pmm-core.cjs:1093-1237),原来的集合差(:83-86 旧版)把纯行号/字节
// 漂移(语料在两次快照之间因无关编辑挪了行、或某条目字节数变了,但违规类型本身没变)当成「新增」。
// 复现脚本 `scratchpad/w/b3norm.cjs` 的规范化公式(去 `.md:数字` 的行号、去 `数字B` 的字节数)先在这
// 里落地,再做「规范化后」的多重集(multiset)差——同一规范化 key 在 after 里的出现次数比 before 多
// 的部分才算真新增,而不是简单集合差(后者会把「before 有 1 条、after 恰好也还是同一类 1 条但行号
// 变了」误判成班新增,也会漏掉「before 1 条、after 因为另一处改动变成同类 2 条」这种真·新增 1 条)。
function normalizeBlockingKey(s) {
  return String(s).replace(/(\.md):\d+/g, '$1:#').replace(/\d+B\b/g, '#B');
}

// diffNormalizedBlocking(beforeList, afterList) — 规范化多重集差:对每个规范化 key,after 计数减
// before 计数,大于 0 的部分即「本次提交真新增」。返回值元素为可读字符串(规范化 key,若真新增
// 计数 >1 则附 ' x<N>' 后缀,与 b3norm.cjs 的输出约定一致),供报告直接打印。
function diffNormalizedBlocking(beforeList, afterList) {
  const beforeNorm = new Map();
  for (const x of beforeList) { const k = normalizeBlockingKey(x); beforeNorm.set(k, (beforeNorm.get(k) || 0) + 1); }
  const afterNorm = new Map();
  for (const x of afterList) { const k = normalizeBlockingKey(x); afterNorm.set(k, (afterNorm.get(k) || 0) + 1); }
  const out = [];
  for (const [k, n] of afterNorm) {
    const before = beforeNorm.get(k) || 0;
    if (n > before) out.push(k + ((n - before) > 1 ? ' x' + (n - before) : ''));
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  let n = 30;
  let out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--n') { n = parseInt(args[i + 1], 10) || 30; i++; }
    else if (args[i] === '--out') { out = args[i + 1]; i++; }
  }
  const gitHome = core.homeDir();

  let oidStart;
  try { oidStart = gitOut(gitHome, ['rev-parse', 'HEAD:.claude/memory']); }
  catch (e) {
    process.stderr.write('✖ 无法取 HEAD:.claude/memory 的 OID(第 12 条要求的快照钉)：' + String((e && e.message) || e) + '\n');
    process.exit(1);
  }

  const footSnap = iso.footprint.begin();

  let commits;
  try {
    const raw = gitOut(gitHome, ['log', '-' + n, '--format=%H', '--', '.claude/memory']);
    commits = raw ? raw.split('\n').filter(Boolean) : [];
  } catch (e) {
    process.stderr.write('✖ git log 失败：' + String((e && e.message) || e) + '\n');
    process.exit(1);
  }

  const col1 = []; // v3 会拦而当时放行
  const col2 = []; // 当时拦而 v3 不拦(见头注:spec 定义下结构性恒空)
  const errors = [];
  const skippedRoots = [];
  for (const c of commits) {
    let parent;
    try { parent = gitOut(gitHome, ['rev-parse', c + '^']); }
    catch (e) { skippedRoots.push(c); continue; }
    try {
      const before = evalRef(parent);
      const after = evalRef(c);
      const newOnes = diffNormalizedBlocking(before, after);
      if (newOnes.length) col1.push({ commit: c, parent: parent, new_blocking: newOnes });
    } catch (e) {
      errors.push({ commit: c, error: String((e && e.message) || e) });
    }
  }

  let oidEnd = null;
  try { oidEnd = gitOut(gitHome, ['rev-parse', 'HEAD:.claude/memory']); } catch (e) { oidEnd = null; }
  if (oidEnd !== oidStart) {
    process.stderr.write('✖ 语料 OID 在本轮回放期间漂移(开工 ' + oidStart + ' -> 收工 ' + oidEnd + ')，第 12 条：整轮作废，重跑\n');
    process.exit(1);
  }

  // B3 HOME 读取修复(简报 W3-D;CHANGELOG 09-24「主脑核 runner 自检」/E-7:runner --self-check
  // part13 家目录直读扫描命中此行的 process.env.HOME 直读,允许清单只放行经指定解析器的读取)。
  // iso.realHome() 派生自本文件自身位置(<realHome>/.claude/guards/),不依赖任何环境变量,满足
  // part13 判据(criterion: 「READ of HOME/USERPROFILE/os.homedir outside the resolver」)。
  const nonce = 'replayb3-' + process.pid + '-' + Date.now();
  const markers = iso.markersFromSource(__filename, nonce, path.basename(String(iso.realHome() || '')));
  const foot = iso.footprint.end(footSnap, markers);

  const lines = [];
  lines.push('PMM precommit shadow 回放(交付物 4；OID pin 第 12 条)');
  lines.push('OID(HEAD:.claude/memory) = ' + oidStart);
  lines.push('commits_checked = ' + commits.length + '(窗口 N=' + n + ')');
  lines.push('');
  lines.push('== 列①v3 会拦而当时放行(' + col1.length + ') ==');
  for (const row of col1) {
    lines.push('  ' + row.commit.slice(0, 10) + ' (parent ' + row.parent.slice(0, 10) + '): ' + row.new_blocking.length + ' 条新增 blocking');
    for (const b of row.new_blocking.slice(0, 5)) lines.push('    - ' + b);
    if (row.new_blocking.length > 5) lines.push('    ...(' + (row.new_blocking.length - 5) + ' 条省略)');
  }
  lines.push('');
  lines.push('== 列②当时拦而 v3 不拦(' + col2.length + ') ==');
  lines.push('  spec 交付物 4 原文把「当时是否被拦」定义死为「提交存在=没被拦」——在这个定义下');
  lines.push('  这一列对已存在的历史提交结构性恒为空，不是漏统计(见本文件头注 / 本批回报的歧义标注)。');
  if (skippedRoots.length) {
    lines.push('');
    lines.push('== 跳过(无父提交，窗口边界)(' + skippedRoots.length + ') ==');
    for (const s of skippedRoots) lines.push('  ' + s.slice(0, 10));
  }
  if (errors.length) {
    lines.push('');
    lines.push('== 出错(' + errors.length + ') ==');
    for (const e of errors) lines.push('  ' + e.commit.slice(0, 10) + ': ' + e.error);
  }
  lines.push('');
  lines.push(foot.line);
  const report = lines.join('\n') + '\n';
  if (out) {
    require('fs').writeFileSync(out, report);
    process.stdout.write('报告已写入 ' + out + '\n');
  } else {
    process.stdout.write(report);
  }
  process.exit(foot.red || errors.length ? 1 : 0);
}

main();
