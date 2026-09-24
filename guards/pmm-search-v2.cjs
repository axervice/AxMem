#!/usr/bin/env node
// pmm-search-v2.cjs — C05-BUILD-SPEC.md 交付物 6 (pmm-search v2 影子排名引擎).
//
// 按 PMM-V3-FINAL-SPEC.md §3.2 排名出结果;曝光记录(<resolveHome()>/.claude/.shadow/
// retrieval-impressions-<mach>.tsv:query sha256、top-k 身份、分数,曝光 id 按 M-SPEC 附录 A 公式、
// gate_instance_id = "search:<rank>",0-indexed,spec 审 K21)**默认关闭**——2026-09-24 主脑裁决:
// 曝光日志的语义是「生产会话里真实展示过的记录」,B2-2 影子比对靠它量「已展示」;`--baseline`/
// `--self-test`/临时 CLI 查询都不是真实展示,写了就是 session 为空的假曝光,污染 B2-2。三种入口
// 一律零写入;只有调用方显式传 `--record-exposure`(CLI)或 `{recordExposure:true}`(库用法,给将来
// hook 接线用)才写。不用环境变量做开关。
// 不改现有 memory/_local-config/pmm-search.sh(v1,融合通道,照旧独立存在)。
//
// 排序引擎(补遗二 §19,Jax 09-17 铁律「借用来源」):vendor lucaong/minisearch 7.2.0 到
// ./vendor/minisearch/(见 ./vendor/VENDOR.md)。§3.2 的精确命中置顶与字段权重在**本文件**
// (包装层)实现——本文件绝不重新实现一套手写倒排索引/BM25 打分;minisearch 只负责分词后的
// 多字段索引与匹配(`match`: 词 → 命中字段列表),字段加权求和、身份全等/子串加分、图重排
// (head +2 / superseded −5)、并列序全部是对 minisearch 原始匹配结果的一层确定性后处理。
//
// 上一版(分支 worktree-agent-a8bd4587eedf15829 @9858ad6)被 Opus 批审裁 NO-GO 并丢弃
// (guards/audits/OPUS-2026-09-24-c05-batch-review.md B7 节):①手写排序器违反第 19 条
// vendor 铁律;②临时 HOME 下 --self-test 因 core.snapshot 未包 try 而崩溃,且
// footprint.begin() 返回值被丢弃;③生产打分里 head+2 从未生效(entry.head 语义用错),
// identitySub 用「query 包含 tag 名」导致短 tag 被误加分;④曝光行缺 impression_id/K21 字段;
// ⑤基线只跑了 canary-set 23 题里的 2 道。本文件是按这份裁决重建的版本,逐条对应修正见下方
// 各函数的注释。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const core = require('./pmm-core.cjs');
const ledger = require('./pmm-recall-ledger.cjs');
const MiniSearch = require('./vendor/minisearch/index.cjs');

// ── constants ────────────────────────────────────────────────────────────────────────────────────
// HOME/MACH/SHADOW_DIR 复用 pmm-hook.cjs 的同一套解析规则:ledger.resolveHome() 是唯一允许
// 直读 PMM_HOME/USERPROFILE/HOME 的入口(HIGH-1 教训,不在此处重新实现)。
const HOME = ledger.resolveHome().replace(/\\/g, '/');
const MACH = (os.hostname() || 'unknown').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
const SHADOW_DIR = HOME + '/.claude/.shadow';
const RETRIEVAL_LOG = SHADOW_DIR + '/retrieval-impressions-' + MACH + '.tsv';

// §3.2 「score = Σ 字段命中 × 权重」的字段权重表(标题/Hook/Class/正文);身份全等与身份子串
// 不是 token 字段命中,是对原始 query/identity 字符串的直接比较,分开处理(见 identityBonus())。
const FIELD_WEIGHTS = { title: 10, hook: 8, class: 5, body: 1 };
const IDENTITY_EXACT_SCORE = 1000;
const IDENTITY_SUBSTRING_SCORE = 100;
const HEAD_BONUS = 2;
const SUPERSEDED_PENALTY = -5;
const TOP_K = 8;
// 身份子串最短长度:避免上一版的 bug(identitySub 用「query 包含 tag 名」——tag 短则几乎任何
// 较长 query 都会碰巧包含它的子串,产生大量假阳性)。本版方向反过来:要求 **identity 包含
// query**(用户搜的是 tag 名的一部分),且 query 本身不能太短,这是对「部分身份查找」更合理的
// 建模,同时天然避免了旧 bug 的那一类假阳性(见 OPUS 批审 §3 ③)。
const MIN_SUBSTRING_LEN = 3;

// ── §3.2 分词:NFC + ASCII 小写按 [^a-z0-9._:-] 切 + CJK 二元组 ─────────────────────────────────
// CJK 区间覆盖:CJK 统一表意 + 扩展 A + 兼容表意、平假名/片假名、谚文音节 —— 足够覆盖中日韩
// 常见字符;不追求覆盖全部 Unicode CJK 补充平面(本仓语料以简体中文为主)。
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힣豈-﫿]/;
function tokenizeV2(text) {
  const s = String(text == null ? '' : text).normalize('NFC').toLowerCase();
  const tokens = [];
  for (const t of s.split(/[^a-z0-9._:-]+/)) { if (t) tokens.push(t); }
  let run = '';
  const flushRun = () => {
    if (!run) return;
    if (run.length === 1) tokens.push(run);
    else { for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2)); }
    run = '';
  };
  for (const ch of s) {
    if (CJK_RE.test(ch)) run += ch; else flushRun();
  }
  flushRun();
  return tokens;
}

// normId(s): 身份比较前的归一化 —— NFC、去首尾空白、剥掉外层 `[...]`(横幅/canary 题库里的
// tag 经常带方括号)、小写。用于「身份全等/子串」判定,独立于上面的分词函数。
function normId(s) {
  return String(s == null ? '' : s).normalize('NFC').trim().replace(/^\[+/, '').replace(/\]+$/, '').toLowerCase();
}

// ── 读语料(生产路径,真读)────────────────────────────────────────────────────────────────────
// NO-GO 裁决②的修法:任何 core.snapshot/analyze 调用一律包 try,绝不让 PmmCoreError 变成未捕获
// 异常崩溃整个进程(临时 HOME 下语料目录可能不完整,--self-test 必须仍能 rc=0)。
//
// opts.view(默认 'worktree'):交互查询路径读活体可变 worktree(要新鲜);基线路径(runBaselineV2)
// 传 'HEAD',钉住 git 树而不是读易变的 worktree(补遗三第 30 条改写:「基线读 worktree,却按
// HEAD treeOid 命名」——两者不一致,并发会话写 worktree 时基线文件名与实际读到的内容对不上。
// core.snapshot('HEAD',...) 内部按 `git show HEAD:<rel>` 逐文件读,和 treeOid('HEAD') 是同一个
//被钉住的提交,天然一致,不需要另起一套 `git archive` 管线)。
function loadEntries(opts) {
  opts = opts || {};
  const view = opts.view || 'worktree';
  try {
    const snap = core.snapshot(view, { requireAll: opts.requireAll !== false });
    const analyzed = core.analyze(snap, {});
    return { ok: true, entries: analyzed.entries, error: null };
  } catch (e) {
    return { ok: false, entries: [], error: 'PMM-DEGRADED ' + (e && e.message ? e.message : String(e)) };
  }
}

// ── 单文件合成语料(golden 夹具用,同 pmm-core-selftest.cjs 的 corpusOf() 手法):把一个夹具文件的
// 原始字节当作某个 canonical 文件名(通常 decisions.md)的全部内容,其余 canonical 文件记 missing。
// 只用于 runGoldenBaseline——活体语料从不走这条路径。
function corpusOfFixture(role, buf) {
  const files = {};
  for (const f of core.ALL_FILES) files[f] = { raw: null, missing: true };
  const { buf: stripped, hadBOM } = core.stripBOM(buf);
  files[role] = { raw: stripped, hadBOM, missing: false };
  return { view: 'fixture', sourceOids: {}, files };
}
function loadEntriesFromFixture(fixtureBuf, role) {
  try {
    const snap = corpusOfFixture(role || 'decisions.md', fixtureBuf);
    const analyzed = core.analyze(snap, {});
    return { ok: true, entries: analyzed.entries, error: null };
  } catch (e) {
    return { ok: false, entries: [], error: 'PMM-DEGRADED ' + (e && e.message ? e.message : String(e)) };
  }
}

// ── 建索引:minisearch 只做分词后的多字段倒排索引,不做本文件自己的加权 ──────────────────────────
function buildIndex(entries) {
  const seen = new Set();
  const docs = [];
  const byId = new Map();
  for (const e of entries) {
    if (!e || !e.id || seen.has(e.id)) continue; // 无 id 的条目不可寻址,重复 id 只取第一条(防御性)
    seen.add(e.id);
    byId.set(e.id, e);
    docs.push({ id: e.id, title: e.title || '', hook: e.hook || '', class: e.class || '', body: e.body || '' });
  }
  const mini = new MiniSearch({
    idField: 'id',
    fields: ['title', 'hook', 'class', 'body'],
    storeFields: [],
    tokenize: tokenizeV2,
    processTerm: (t) => t, // tokenizeV2 已经完成归一化,这里不再二次处理
    searchOptions: { combineWith: 'OR', prefix: false, fuzzy: false, boost: FIELD_WEIGHTS },
  });
  if (docs.length) mini.addAll(docs);
  // headSet: 被至少一个其它条目的 entry.head 指向的 id 集合 —— 即「某条链真正解析到的头」。
  // entry.head === entry.id 对**从未涉及任何 supersedes 链**的独立条目也成立(core.buildGraph()
  // 的 headOf() 对没有记录的 tag 直接返回它自身),所以不能用「entry.head===entry.id」本身当
  // 「链头」判据(NO-GO 裁决③指出的旧 bug 根源之一)。这里改用「是否有别的条目的解析头指向我」,
  // 只有真正处于一条 >1 节点的链上的头才会命中。
  const headSet = new Set();
  for (const e of entries) { if (e && e.head && e.id && e.head !== e.id) headSet.add(e.head); }
  return { mini, byId, headSet };
}

// ── 单次查询打分(纯函数,便于自测用合成语料直接调用,不依赖真语料/git)──────────────────────────
function rankQuery(index, query, opts) {
  opts = opts || {};
  const topK = opts.topK || TOP_K;
  // headBonus/supersededPenalty 可覆盖(仅供自测演示「规则关掉就翻车」用,生产路径从不传这两个
  // opts,永远吃模块常量 HEAD_BONUS/SUPERSEDED_PENALTY)。
  const headBonus = opts.headBonus === undefined ? HEAD_BONUS : opts.headBonus;
  const supersededPenalty = opts.supersededPenalty === undefined ? SUPERSEDED_PENALTY : opts.supersededPenalty;
  const { mini, byId, headSet } = index;
  const qNorm = normId(query);
  let miniResults = [];
  try { miniResults = mini.search(String(query == null ? '' : query)); } catch { miniResults = []; }
  const fieldScoreById = new Map();
  const fieldsHitById = new Map();
  for (const r of miniResults) {
    let fieldScore = 0;
    const fieldsHit = new Set();
    const match = r.match || {};
    for (const term of Object.keys(match)) {
      for (const field of match[term]) {
        fieldScore += FIELD_WEIGHTS[field] || 0;
        fieldsHit.add(field);
      }
    }
    fieldScoreById.set(r.id, fieldScore);
    fieldsHitById.set(r.id, Array.from(fieldsHit));
  }
  const results = [];
  for (const [id, entry] of byId) {
    let score = fieldScoreById.has(id) ? fieldScoreById.get(id) : 0;
    const reasons = fieldsHitById.get(id) || [];
    const idNorm = normId(id);
    let identityExact = false;
    let identitySub = false;
    if (qNorm && idNorm === qNorm) { score += IDENTITY_EXACT_SCORE; identityExact = true; }
    if (qNorm && qNorm.length >= MIN_SUBSTRING_LEN && idNorm.length > qNorm.length && idNorm.indexOf(qNorm) !== -1) {
      score += IDENTITY_SUBSTRING_SCORE; identitySub = true;
    }
    // H5(OPUS-2026-09-24-c05-wave2-review.md):图重排(head+2/superseded-5)只能施于已经有真实
    // 命中信号的候选(MiniSearch 字段命中,或身份全等/子串)——即这里 score!==0 才叫「命中集」。
    // 旧版在图重排**之后**才判「score===0 跳过」,于是一个与 query 毫无关系、fieldScore=0 且无
    // 身份匹配的条目,只要恰好是某条链的链头(+2)或被取代成员(-5),score 就不再是 0,于是被拉
    // 进结果——乱码查询也能凑出 7 条链头 + 1 条被取代(s2body.cjs/gibberish repro)。把门槛挪到
    // 图重排之前,graph bonus/penalty 只能调整已命中候选的名次,不能凭空造出候选。
    if (score === 0) continue; // 完全没有信号的条目不进候选(避免 682 条全部进排序)
    let superseded = false;
    let isHead = false;
    if (entry.head && entry.head !== id) { score += supersededPenalty; superseded = true; }
    if (headSet.has(id)) { score += headBonus; isHead = true; }
    results.push({ id, score, entry, reasons, identityExact, identitySub, superseded, isHead });
  }
  // 并列序:(dateISO desc, 文件序 dec<les<std<classes<archives, lineRange asc, tag asc)
  const FILE_ORDER = { 'decisions.md': 0, 'lessons.md': 1, 'standinginstructions.md': 2, 'classes.md': 3 };
  function fileRank(f) {
    if (Object.prototype.hasOwnProperty.call(FILE_ORDER, f || '')) return FILE_ORDER[f];
    return /archive/i.test(f || '') ? 4 : 3.5;
  }
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ad = a.entry.dateISO || '';
    const bd = b.entry.dateISO || '';
    if (ad !== bd) return ad < bd ? 1 : -1; // desc
    const fr = fileRank(a.entry.file) - fileRank(b.entry.file);
    if (fr !== 0) return fr;
    const al = (a.entry.lineRange && a.entry.lineRange[0]) || 0;
    const bl = (b.entry.lineRange && b.entry.lineRange[0]) || 0;
    if (al !== bl) return al - bl; // asc
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return results.slice(0, topK);
}

// ── 曝光记录(K21):impression_id 走 M-SPEC 附录 A 公式,gate_instance_id="search:<0-based rank>" ──
function sha256hexQuery(q) {
  return require('crypto').createHash('sha256').update(String(q == null ? '' : q), 'utf8').digest('hex');
}
function writeExposures(query, ranked) {
  try {
    fs.mkdirSync(SHADOW_DIR, { recursive: true });
    const qSha = sha256hexQuery(query);
    const ts = new Date().toISOString();
    const lines = ranked.map((r, idx) => {
      const gateInstanceId = 'search:' + idx;
      // 会话/agent/tool_use_id 留空:pmm-search-v2 是独立 CLI 工具,没有 hook 那样的真实会话上下文
      // 可读(不读 CLAUDE_CODE_SESSION_ID 之类的环境变量——那是父会话的变量,不在文档里,读了也只
      // 是把不确定性焊进曝光 id,而不是获得真实身份),固定空串,保持公式确定性、可自测。
      const impressionId = ledger.impressionId({
        session_id: '',
        agent_id: '',
        tool_use_id: '',
        trigger_or_gate_id: r.id,
        gate_instance_id: gateInstanceId,
      });
      return [ts, qSha, String(idx), gateInstanceId, impressionId, r.id, String(r.score)].join('\t');
    });
    if (lines.length) fs.appendFileSync(RETRIEVAL_LOG, lines.join('\n') + '\n');
  } catch {
    // 静默:影子记录失败绝不能影响调用方(与 pmm-hook.cjs --shadow 同一纪律)。
  }
}

// ── CLI 输出(拉取工具的人类可读格式)────────────────────────────────────────────────────────────
function formatResult(r, idx) {
  const e = r.entry;
  const flags = [];
  if (r.identityExact) flags.push('身份全等');
  if (r.identitySub) flags.push('身份子串');
  if (r.isHead) flags.push('链头+2');
  if (r.superseded) flags.push('已被 [' + e.head + '] 取代-5');
  const flagStr = flags.length ? ' {' + flags.join(',') + '}' : '';
  return '[' + r.score + '] #' + (idx + 1) + ' ' + r.id + ' — ' + (e.title || '(无标题)') + ' (' + e.file + ')' + flagStr;
}

// runQuery(query, opts): opts.recordExposure(默认 false)——2026-09-24 主脑裁决:曝光日志代表
// 「真实展示过」,`--baseline`/`--self-test`/临时 CLI 查询默认都不是,写了就是假曝光,污染 B2-2
// 影子比对。只有调用方显式要求(将来的 hook 接线)才落盘;不读任何环境变量做开关。
function runQuery(query, opts) {
  opts = opts || {};
  const loaded = loadEntries({ requireAll: opts.requireAll });
  if (!loaded.ok) {
    return { ok: false, error: loaded.error, ranked: [] };
  }
  const index = buildIndex(loaded.entries);
  const ranked = rankQuery(index, query, { topK: opts.topK });
  if (opts.recordExposure === true) writeExposures(query, ranked);
  return { ok: true, ranked };
}

// slugToFile(slug):gbrain slug("pmm-" + 文件 basename,如 pmm-decisions、pmm-decisions-archive、
// pmm-timeline-archive)→ memory/*.md 文件名。仅供 semantic 题的基线判定口径用(见下方)——不是
// v2 索引 tag 的命名空间,不能拿来跟 entry.id 比。
function slugToFile(slug) {
  return normId(slug).replace(/^pmm-/, '') + '.md';
}

// ── 检索基线(spec 交付物 6 末句):跑 canary-set.tsv 全部问题,记录 Recall@1/@3/MRR/0-hit 率 ──────
// NO-GO 裁决⑤的修法:上一版只跑了 type=search 的 2 行;canary-set.tsv 实际有 23 道非注释题
// (text/search/semantic 三类),spec 原文写的是「全部问题」。三类题目对 target 列的含义不同
// (见下方 parseCanaryRow),本函数统一按「query 送进 v2 引擎、检查 expectedId 是否出现在
// top-k」的口径跑全部 23 题——text 类应几乎全中(query 本身就是 tag,命中身份全等分支);
// search 类是真正的排名质量测试。
//
// H5(OPUS-2026-09-24-c05-wave2-review.md)基线判定口径修法:semantic 类的 target 列是 gbrain
// slug,不是 v2 索引的 PMM tag id,拿 normId(target) 去跟 entry.id 比字符串永远不可能命中——这不
// 是 v2 排名的真实表现,是把「两条检索通道命名空间不同」误判成「v2 排名 bug」。审者复现:23 题
// 基线记了 4 道 semantic 题全 MISS,但其中「跨店流动的员工不进公平排班引擎」「半月发薪周期与加班
// 互斥的服务端联锁」两题 v2 引擎第一名其实就是语义正确的条目(rank1 所在文件 == slug 对应的
// PMM 文件),只是旧口径没有能力判断出来。改判口径(仅 semantic,text/search 口径不变):
// 「引擎第一名 == 目标条目」——第一名结果所在文件等于 target slug 映射到的 PMM 文件才算命中,
// 只看第一名,不看 top-3/8 里更靠后才出现的同文件结果(那仍然是诚实的 0-hit,不是这道题在问的
// 「排名质量」)。
function parseCanaryRow(type, target, query) {
  type = String(type || '').replace(/\r$/, '');
  target = String(target || '').replace(/\r$/, '');
  query = String(query || '').replace(/\r$/, '');
  let expectedId;
  let expectedFile = null;
  if (type === 'text') {
    // target 列是文件(decisions/lessons/standing/timeline),query 列本身就是 tag —— 期望
    // v2 引擎对「查询字符串本身即身份」的自我查找命中身份全等分支。
    expectedId = normId(query);
  } else if (type === 'semantic') {
    // target 列是 gbrain slug;expectedId 仍保留原样(normId(target),不带方括号)供旧读者/自测
    // 兼容,但 runBaseline 判定 semantic 行命中时改用下面的 expectedFile,不用 expectedId。
    expectedId = normId(target);
    expectedFile = slugToFile(target);
  } else {
    // search:target 列是 [tag],去掉方括号。
    expectedId = normId(target);
  }
  return { type, target, query, expectedId, expectedFile };
}

function loadCanarySet(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const l = line.replace(/\r$/, '');
    if (!l || l.trimStart().startsWith('#')) continue;
    const parts = l.split('\t');
    if (parts.length < 3) continue;
    rows.push(parseCanaryRow(parts[0], parts[1], parts[2]));
  }
  return rows;
}

// ── 检索基线 v2(C05-BUILD-SPEC.md 补遗三第 30 条改写版;wave3-review.md MEDIUM「基线 text 行以
// query 作身份」的修法 = 不再拿裸 query 字符串当身份,改用「目标条目 id」——对 text 类这就是
// normId(query) 本身(canary-set 的 text 题设计上 query 列就是 tag),转写进 retrieval-canary-v2.tsv
// 时已经写死,这里不再重算,避免两处口径分裂)────────────────────────────────────────────────

// loadCanaryV2Set(file):解析 guards/specs/retrieval-canary-v2.tsv,4 列 type/query/expected_ids/note。
// **不改** memory/_local-config/canary-set.tsv(pmm-canary.sh 按 3 列读,加列会把期望 id 并进 query、
// 未知 type 落 else 分支被记 FAIL)——这是完全独立的新文件,旧消费者看不见它,负例天然不会被
// pmm-canary.sh 误记 FAIL。
function loadCanaryV2Set(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const l = line.replace(/\r$/, '');
    if (!l || l.trimStart().startsWith('#')) continue;
    const parts = l.split('\t');
    if (parts.length < 3) continue;
    const type = String(parts[0] || '').trim();
    const query = String(parts[1] || '');
    const expectedIdsRaw = String(parts[2] || '');
    const note = String(parts[3] || '');
    const expectedIds = expectedIdsRaw.split(',').map((s) => normId(s)).filter(Boolean);
    rows.push({ type, query, expectedIds, note });
  }
  return rows;
}

// judgeRankByIds(ranked, expectedIds):expected_ids 任一命中即算(spec 原文「逗号分隔,任一命中即
// 算」),取其中最靠前的排名。ranked 已经是 rankQuery() 的 topK 输出。
function judgeRankByIds(ranked, expectedIds) {
  if (!expectedIds || !expectedIds.length) return null;
  const idSet = new Set(expectedIds);
  for (let i = 0; i < ranked.length; i++) {
    if (idSet.has(normId(ranked[i].id))) return i + 1;
  }
  return null;
}

function emptyTypeAgg() { return { count: 0, hitsAt1: 0, hitsAt3: 0, mrrSum: 0 }; }
function finalizeTypeAgg(agg) {
  const n = agg.count || 1;
  return {
    count: agg.count,
    recallAt1: agg.count ? agg.hitsAt1 / n : 0,
    recallAt3: agg.count ? agg.hitsAt3 / n : 0,
    mrr: agg.count ? agg.mrrSum / n : 0,
  };
}
function accumulate(agg, rank) {
  agg.count++;
  if (rank !== null) {
    if (rank === 1) agg.hitsAt1++;
    if (rank <= 3) agg.hitsAt3++;
    agg.mrrSum += 1 / rank;
  }
}

// runBaselineV2:统一跑 legacy canary-set.tsv(只取 search/semantic,text 已转写进 v2 文件,不重复
// 计入避免同题两处口径打架)+ retrieval-canary-v2.tsv(text/graph/negative)。语料固定读 HEAD 钉住树
// (loadEntries({view:'HEAD'})),不读 worktree——文件名里的 treeOid 与实际读到的内容天然一致。
// 一律零写入曝光日志,同旧 runBaseline 的纪律(基线是测量动作,不是真实展示)。
// computeBaselineReport(index, legacyRows, v2Rows):纯函数——给定一个已建好的索引和两路已解析的
// 题目,算出分 type 的 R@1/R@3/MRR + negative 的 0-hit 率/误命中列表。拆成纯函数是为了自测能喂合成
// 语料 + 合成题库直接调用,不依赖真语料/真 HEAD(同文件里 rankQuery 已有的先例、同一个理由)。
function computeBaselineReport(index, legacyRows, v2Rows) {
  const byType = { text: emptyTypeAgg(), search: emptyTypeAgg(), semantic: emptyTypeAgg(), graph: emptyTypeAgg() };
  const negative = { count: 0, zeroHits: 0, falseHits: [] };
  const perQuestion = [];

  // legacy 源:只取 search/semantic(text 已转写进 v2,不重复算,避免同一道题两套口径各算一次)。
  for (const row of legacyRows) {
    if (row.type !== 'search' && row.type !== 'semantic') continue;
    const ranked = rankQuery(index, row.query, { topK: TOP_K });
    let rank;
    if (row.type === 'semantic') {
      // H5 口径不变:semantic 只看「引擎第一名」所在文件是否等于目标文件。
      rank = (ranked.length && ranked[0].entry && ranked[0].entry.file === row.expectedFile) ? 1 : null;
    } else {
      rank = judgeRankByIds(ranked, [row.expectedId]);
    }
    accumulate(byType[row.type], rank);
    perQuestion.push({ type: row.type, source: 'legacy', query: row.query, expectedIds: row.type === 'semantic' ? [row.expectedFile] : [row.expectedId], rank, topScore: ranked.length ? ranked[0].score : 0 });
  }

  // v2 源:text/graph/negative。
  for (const row of v2Rows) {
    const ranked = rankQuery(index, row.query, { topK: TOP_K });
    if (row.type === 'negative') {
      negative.count++;
      const hitIds = ranked.map((r) => r.id);
      if (hitIds.length === 0) { negative.zeroHits++; }
      else { negative.falseHits.push({ query: row.query, hits: hitIds }); }
      perQuestion.push({ type: 'negative', source: 'v2', query: row.query, expectedIds: [], rank: null, hitCount: hitIds.length, topScore: ranked.length ? ranked[0].score : 0 });
      continue;
    }
    if (!byType[row.type]) byType[row.type] = emptyTypeAgg(); // 防御性:未来 type 扩展时不静默丢题
    const rank = judgeRankByIds(ranked, row.expectedIds);
    accumulate(byType[row.type], rank);
    perQuestion.push({ type: row.type, source: 'v2', query: row.query, expectedIds: row.expectedIds, rank, topScore: ranked.length ? ranked[0].score : 0 });
  }

  return {
    byType: {
      text: finalizeTypeAgg(byType.text),
      search: finalizeTypeAgg(byType.search),
      semantic: finalizeTypeAgg(byType.semantic),
      graph: finalizeTypeAgg(byType.graph),
    },
    negative: {
      count: negative.count,
      zeroHitRate: negative.count ? negative.zeroHits / negative.count : 0,
      falseHits: negative.falseHits,
    },
    perQuestion,
  };
}

// runBaselineV2:I/O 外壳——读真 HEAD 钉住语料 + 两份题库文件,委派给 computeBaselineReport()。
// 一律零写入曝光日志,同旧 runBaseline 的纪律(基线是测量动作,不是真实展示)。
function runBaselineV2(opts) {
  opts = opts || {};
  const legacyFile = opts.legacyFile;
  const v2File = opts.v2File;
  const outFile = opts.outFile || null;
  const loaded = loadEntries({ requireAll: true, view: 'HEAD' });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const index = buildIndex(loaded.entries);
  // NO-GO 裁决②同款纪律(本文件开头 loadEntries 注释):题库文件读取一律包 try,临时 HOME/缺
  // 题库文件时必须是受控 PMM-DEGRADED,不能是未捕获异常堆栈崩溃整个进程。
  let legacyRows, v2Rows;
  try { legacyRows = loadCanarySet(legacyFile); }
  catch (e) { return { ok: false, error: 'PMM-DEGRADED legacy 题库读取失败(' + legacyFile + '): ' + (e && e.message ? e.message : String(e)) }; }
  try { v2Rows = loadCanaryV2Set(v2File); }
  catch (e) { return { ok: false, error: 'PMM-DEGRADED v2 题库读取失败(' + v2File + '): ' + (e && e.message ? e.message : String(e)) }; }
  const computed = computeBaselineReport(index, legacyRows, v2Rows);
  const report = Object.assign({
    treeOid: core.treeOid('HEAD'),
    generatedAt: new Date().toISOString(),
    sources: { legacy: path.basename(legacyFile), v2: path.basename(v2File) },
  }, computed);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  return { ok: true, report };
}

// ── golden Cause-chain 基线(补遗三第 30 条:活体语料 Cause: 字段行为 0,只能在 fixtures/v3/ golden
// 夹具上出题)。pmm-search-v2 的排序引擎本身没有 Cause 专属加权(buildIndex/rankQuery 只认
// entry.head/supersedes,§3.2 权重表也没有 Cause 字段)——所以这里诚实测的是两件事:①同一夹具里的
// 真实 supersedes 链头依旧正确排 rank1(与活体图题同一套判据,只是换了语料来源);②带 Cause:/
// Follows: 字段的条目本身不会因为这些元数据行而检索不到(Cause:/Follows: 是条目正文的一部分,
// 会被当 body token 索引——回归哨兵:证明「解析出 Cause 边」不会连带破坏该条目自身的可检索性)。
// 不虚构一套「Cause 语义加权」——engine 没有就诚实地不测,基线只记录当前真实能力。
const GOLDEN_FIXTURE_REL = 'fixtures/v3/supersedes-cause-follows.md';
const GOLDEN_QUESTIONS = [
  // G1: 与活体图题同一模式(query=被取代条目标题词的子集,不整句转写——理由同 retrieval-canary-v2.tsv
  // 的 graph 注释:整句会让被取代条目的独有词把 title 分优势拉得过大,盖过 head+2/superseded-5)。
  { type: 'graph', query: 'supersedes target', expectedIds: ['fx:scf-new'], note: 'supersedes chain head: fx:scf-old -> fx:scf-new' },
  // G2/G3: Cause:/Follows: 字段条目自身可被正常检索到(标题词能找到自己,不被元数据行破坏索引)。
  { type: 'graph', query: 'Cause with two targets via middle-dot separator', expectedIds: ['fx:scf-cause-dot'], note: 'entry carrying a valid Cause: line is still indexable/findable by its own title' },
  { type: 'graph', query: 'Follows with two targets comma separator', expectedIds: ['fx:scf-follows-two'], note: 'entry carrying a valid Follows: line is still indexable/findable by its own title' },
];
function runGoldenBaseline(fixtureFile, outFile) {
  let buf;
  try { buf = fs.readFileSync(fixtureFile); } catch (e) { return { ok: false, error: 'PMM-DEGRADED fixture 读取失败: ' + (e && e.message ? e.message : String(e)) }; }
  const loaded = loadEntriesFromFixture(buf, 'decisions.md');
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const index = buildIndex(loaded.entries);
  let fixtureSha = null;
  try {
    fixtureSha = require('child_process').execFileSync('git', ['hash-object', fixtureFile], { cwd: path.dirname(fixtureFile) }).toString().trim();
  } catch { fixtureSha = require('crypto').createHash('sha256').update(buf).digest('hex'); } // git 不可用时退回内容 sha256,仍确定性可复现
  const agg = emptyTypeAgg();
  const perQuestion = [];
  for (const q of GOLDEN_QUESTIONS) {
    const ranked = rankQuery(index, q.query, { topK: TOP_K });
    const rank = judgeRankByIds(ranked, q.expectedIds);
    accumulate(agg, rank);
    perQuestion.push({ type: q.type, query: q.query, expectedIds: q.expectedIds, note: q.note, rank, topScore: ranked.length ? ranked[0].score : 0 });
  }
  const report = {
    fixtureFile: GOLDEN_FIXTURE_REL,
    fixtureSha,
    generatedAt: new Date().toISOString(),
    byType: { graph: finalizeTypeAgg(agg) },
    perQuestion,
  };
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  return { ok: true, report };
}

// SELFTEST-BEGIN
// spec 22(C05-BUILD-SPEC 补遗二 §22):本自测所有 DUT 子进程必须经 selftest-iso.cjs 的 isoEnv()
// 起,首尾对真根(realHome())做零足迹断言;不读写活体 v3 台账/trigger-seen/trigger-log。
// NO-GO 裁决②的两个具体修法在这里体现:(a)任何 core 调用都在 loadEntries() 里已经包了 try,本
// 自测额外验证「临时 HOME、语料目录不存在」时 rc 仍为 0、不抛未捕获异常;(b)footprint.begin()
// 的返回值这里正确捕获进 fpSnap 变量,end() 收到的就是它,不是别的什么快照对象。
const iso = require('./selftest-iso.cjs');

function selfTest() {
  const nonce = 'search-v2-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const fpSnap = iso.footprint.begin(); // (a) 修法:正确捕获返回值
  let pass = 0, fail = 0;
  const details = [];
  function report(name, ok, detail) {
    if (ok) { pass++; } else { fail++; details.push({ name, detail }); }
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : (detail !== undefined ? (' :: ' + JSON.stringify(detail)) : '')));
  }

  // ── 分词器 ──
  report('tokenizeV2: ASCII 标点切分,冒号/点/下划线/连字符保留在 token 内',
    JSON.stringify(tokenizeV2('Axervice:Payments-Strategy, v1.0!')) === JSON.stringify(['axervice:payments-strategy', 'v1.0']),
    tokenizeV2('Axervice:Payments-Strategy, v1.0!'));
  report('tokenizeV2: CJK 二元组切分',
    JSON.stringify(tokenizeV2('跨店流动')) === JSON.stringify(['跨店', '店流', '流动']),
    tokenizeV2('跨店流动'));
  report('tokenizeV2: 单个 CJK 字符也产出 1 个 token',
    JSON.stringify(tokenizeV2('单')) === JSON.stringify(['单']), tokenizeV2('单'));
  report('tokenizeV2: 混合 ASCII+CJK 两套 token 都产出',
    (() => { const t = tokenizeV2('axmem 跨店流动'); return t.includes('axmem') && t.includes('跨店') && t.includes('店流') && t.includes('流动'); })(),
    tokenizeV2('axmem 跨店流动'));

  // ── 合成语料(纯函数路径,不读真语料/git)──
  function mk(id, title, hook, cls, body, head, dateISO, file, lineRange) {
    return { id, title: title || '', hook: hook || null, class: cls || null, body: body || '', head, dateISO, file, lineRange };
  }
  const synthEntries = [
    mk('ns:title-hit', 'apple banana cherry', null, null, 'zzz', 'ns:title-hit', '2026-01-01', 'decisions.md', [10, 12]),
    mk('ns:body-hit', 'zzz', null, null, 'apple banana cherry', 'ns:body-hit', '2026-01-01', 'decisions.md', [20, 22]),
    mk('ns:chain-old', 'durian fig', null, null, '', 'ns:chain-new', '2026-01-01', 'decisions.md', [1, 3]),
    mk('ns:chain-new', 'durian fig', null, null, '', 'ns:chain-new', '2026-01-01', 'decisions.md', [50, 52]),
    mk('ns:standalone', 'grape', null, null, '', 'ns:standalone', '2026-01-01', 'decisions.md', [60, 62]),
    mk('ns:sql-routing-decision', 'kiwi', null, null, '', 'ns:sql-routing-decision', '2026-01-01', 'decisions.md', [70, 72]),
    mk('ns:tie-a', 'lemon', null, null, '', 'ns:tie-a', '2026-03-01', 'decisions.md', [1, 3]),
    mk('ns:tie-b', 'lemon', null, null, '', 'ns:tie-b', '2026-03-01', 'decisions.md', [9, 11]),
    // H5 回归夹具:唯一 body token 命中(fieldScore=1,小于 HEAD_BONUS=2),用来证明弱命中不会被
    // 与 query 毫无关系的 ns:chain-new(纯图重排 +2)/ns:chain-old(纯图重排 -5)盖过或拉进结果。
    mk('ns:single-hit', 'zzz', null, null, 'elderberry', 'ns:single-hit', '2026-01-01', 'decisions.md', [90, 92]),
  ];
  // 补 8 条只为填满 top-k 截断测试(各自有一个不会被别的 query 命中的独有 title token)
  for (let i = 0; i < 8; i++) {
    synthEntries.push(mk('ns:filler-' + i, 'mango' + i, null, null, '', 'ns:filler-' + i, '2026-01-01', 'decisions.md', [100 + i, 101 + i]));
  }
  const index = buildIndex(synthEntries);

  // 字段权重:title token(10) 应该跑赢 body token(1)。
  {
    const ranked = rankQuery(index, 'apple banana cherry', { topK: 8 });
    report('字段权重:title 命中排在 body 命中之前',
      ranked.length >= 2 && ranked[0].id === 'ns:title-hit' && ranked[1].id === 'ns:body-hit',
      ranked.map((r) => [r.id, r.score]));
  }

  // 身份全等:查询=tag 本身 -> 该条目获 1000 分并置顶。
  {
    const ranked = rankQuery(index, 'ns:standalone', { topK: 8 });
    report('身份全等置顶(+1000)',
      ranked.length >= 1 && ranked[0].id === 'ns:standalone' && ranked[0].score >= IDENTITY_EXACT_SCORE,
      ranked[0]);
  }

  // 身份子串(正确方向:identity 包含 query,而不是旧 bug 的反方向):
  //   - query 是较长 identity 的子串 -> 命中;
  //   - identity 是较长 query(自然语言长句)的子串 -> 不命中(这正是上一版被 Opus 批审点名的
  //     bug:「identitySub 用了 query 包含 tag 名,短 tag 会被误加 100 分」)。
  {
    const ranked = rankQuery(index, 'sql-routing', { topK: 8 });
    const hit = ranked.find((r) => r.id === 'ns:sql-routing-decision');
    report('身份子串:query 是 identity 子串 -> 命中 +100',
      !!hit && hit.identitySub === true, hit);
  }
  {
    // 长句里字面包含 "ns:tie-a"(6 字符 tag),旧版方向(query.includes(identity))会给它加 100 分;
    // 正确方向(identity.includes(query))不应该加,因为 identity 'ns:tie-a' 并不包含这整句 query。
    const longQuery = 'this is a long natural language sentence that happens to mention ns:tie-a in passing';
    const ranked = rankQuery(index, longQuery, { topK: 8 });
    const hit = ranked.find((r) => r.id === 'ns:tie-a');
    report('身份子串方向修复:长句字面包含短 tag 不应触发子串加分(旧 bug 的反例)',
      !hit || hit.identitySub !== true, hit || '(未进入候选,同样合规)');
  }

  // ── 图重排:head+2 / superseded-5,改前红/改后绿(headBonus/supersededPenalty=0 模拟旧行为)──
  {
    const rankedFixed = rankQuery(index, 'durian fig', { topK: 8 });
    const orderFixed = rankedFixed.filter((r) => r.id === 'ns:chain-old' || r.id === 'ns:chain-new').map((r) => r.id);
    report('图重排开启(生产路径):链头排在被取代条目之前',
      orderFixed[0] === 'ns:chain-new' && orderFixed[1] === 'ns:chain-old', orderFixed);

    // 改前红:字段分相同、dateISO 相同、file 相同 -> 不开图重排时,并列序按 lineRange asc 决定,
    // chain-old(lineRange[1,3])会排在 chain-new(lineRange[50,52])前面 —— 这正是旧版的错误顺序,
    // 用来证明「不加这条规则」确实会翻车,而不是这条规则从来没被真正检验过。
    const rankedNoRerank = rankQuery(index, 'durian fig', { topK: 8, headBonus: 0, supersededPenalty: 0 });
    const orderNoRerank = rankedNoRerank.filter((r) => r.id === 'ns:chain-old' || r.id === 'ns:chain-new').map((r) => r.id);
    report('图重排关闭时会翻车(改前红的证据,非生产路径,仅自测用 opts 覆盖)',
      orderNoRerank[0] === 'ns:chain-old' && orderNoRerank[1] === 'ns:chain-new', orderNoRerank);
  }
  {
    // 旧 bug ③另一半:entry.head===entry.id 对「从未涉及任何链」的独立条目也成立,若天真地把它
    // 当「链头」判据,几乎所有条目都会被加 +2(不是真的挑出链头)。这里断言一个真正独立、从未
    // 参与任何 supersedes 关系的条目**不会**获得链头加分。
    const ranked = rankQuery(index, 'grape', { topK: 8 });
    const standalone = ranked.find((r) => r.id === 'ns:standalone');
    report('独立条目(从未被任何条目当作解析头)不应被误判为链头',
      !!standalone && standalone.isHead === false, standalone);
  }

  // ── H5(OPUS-2026-09-24-c05-wave2-review.md):图重排只施于命中集,不得凭空拉入未命中条目 ──
  {
    // 乱码查询:任何字段 token 都不命中、任何 id 也不构成身份全等/子串 -> 结果必须是 0 条。旧版
    // 在图重排**之后**才判 score===0,于是 ns:chain-new(纯 +2 链头分)与 ns:chain-old(纯 -5 取代
    // 分)会被无条件拉进结果,即使它们与这个查询毫无关系(真实语料复现见 s2body.cjs:乱码查询
    // 曾返回 7 条链头 + 1 条被取代)。
    const ranked = rankQuery(index, 'zzznonexistentqueryxyz123doesnotmatchanything', { topK: 8 });
    report('H5:乱码查询(无字段命中、无身份匹配)返回 0 条,图重排不得凭空造出候选',
      ranked.length === 0, ranked.map((r) => [r.id, r.score]));
  }
  {
    // 单命中词:ns:single-hit 靠唯一 body token 命中,fieldScore=1(小于 HEAD_BONUS=2)。旧版
    // ns:chain-new 无论 query 是什么都会因为是链头被无条件加 2 分并入选,只比 1 分高,会把唯一
    // 真正相关的 ns:single-hit 挤出第一名(真实语料复现见 s2body.cjs:389/400 次被无关链头压过)。
    const ranked = rankQuery(index, 'elderberry', { topK: 8 });
    report('H5:单命中词的唯一相关条目排第一名(不被无关链头/取代盖过)',
      ranked.length >= 1 && ranked[0].id === 'ns:single-hit', ranked.map((r) => [r.id, r.score]));
  }

  // ── 并列序:date desc, file 序, lineRange asc, tag asc ──
  {
    const ranked = rankQuery(index, 'lemon', { topK: 8 });
    const order = ranked.filter((r) => r.id === 'ns:tie-a' || r.id === 'ns:tie-b').map((r) => r.id);
    report('并列序:同分同日同文件时按 lineRange asc',
      order[0] === 'ns:tie-a' && order[1] === 'ns:tie-b', order);
  }

  // ── top-k 截断(8 条合成候选全部命中,topK=5 应该恰好只留前 5,证明真的在截断而不是候选本来
  //    就不够 8 条)──
  {
    const q = 'mango0 mango1 mango2 mango3 mango4 mango5 mango6 mango7';
    const rankedFull = rankQuery(index, q, { topK: 8 });
    report('候选构造正确:8 条 filler 全部命中(截断测试的前提)', rankedFull.length === 8, rankedFull.length);
    const rankedCut = rankQuery(index, q, { topK: 5 });
    report('topK=5 截断生效(候选 8 条只返回 5 条,且是并列序里的前 5)',
      rankedCut.length === 5 && rankedCut.every((r, i) => r.id === 'ns:filler-' + i),
      rankedCut.map((r) => r.id));
  }

  // ── canary 题库解析(纯函数,合成小 TSV,不读真语料)──
  {
    const T0 = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'search-v2-canary-');
    const canaryFixture = [
      '# comment line',
      '',
      'text\tdecisions\tns:foo:bar',
      'search\t[ns:baz]\t自然语言查询',
      'semantic\tsome-archive-slug\t另一个自然语言查询',
    ].join('\r\n');
    const canaryPath = path.join(T0, 'canary.tsv');
    fs.writeFileSync(canaryPath, canaryFixture);
    const rows = loadCanarySet(canaryPath);
    report('loadCanarySet: 跳过注释/空行,CRLF 容忍,解析出 3 行', rows.length === 3, rows);
    report('parseCanaryRow: type=text 的 expectedId 取 query 本身', rows[0] && rows[0].expectedId === 'ns:foo:bar', rows[0]);
    report('parseCanaryRow: type=search 的 expectedId 剥掉方括号', rows[1] && rows[1].expectedId === 'ns:baz', rows[1]);
    report('parseCanaryRow: type=semantic 的 expectedId 取 target(无方括号则原样)', rows[2] && rows[2].expectedId === 'some-archive-slug', rows[2]);
    try { fs.rmSync(T0, { recursive: true, force: true }); } catch {}
  }

  // ── H5 基线判定口径:semantic 行不再拿 id 比 gbrain slug,改比「第一名所在文件」──────────────
  {
    report('slugToFile: 剥 "pmm-" 前缀补 ".md" 后缀',
      slugToFile('pmm-decisions-archive') === 'decisions-archive.md', slugToFile('pmm-decisions-archive'));
    const row = parseCanaryRow('semantic', 'pmm-decisions', '跨店流动的员工不进公平排班引擎');
    report('parseCanaryRow: type=semantic 附带 expectedFile(slug -> PMM 文件名)',
      row.expectedFile === 'decisions.md', row);
    report('parseCanaryRow: type=text/search 不产出 expectedFile(口径不变,H5 只改 semantic)',
      parseCanaryRow('text', 'decisions', 'ns:foo').expectedFile === null &&
      parseCanaryRow('search', '[ns:baz]', 'q').expectedFile === null, null);
  }

  // ── 补遗三第 30 条(检索基线口径改写版):loadCanaryV2Set / judgeRankByIds / computeBaselineReport /
  // runGoldenBaseline 的自测。每类(text/search/semantic/graph/negative)至少一例红→绿(brief ⑥)。
  {
    // loadCanaryV2Set:4 列 TSV,注释/空行跳过,CRLF 容忍,expected_ids 逗号分隔转 normId 数组。
    const T1 = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'search-v2-v2set-');
    const v2Fixture = [
      '# comment',
      '',
      'text\tns:foo:bar\tns:foo:bar\tnote1',
      'graph\ttitle words\tns:head-a,ns:head-b\tnote2(多 id 逗号分隔)',
      'negative\tzzz gibberish qqq\t\tnote3(expected_ids 留空)',
    ].join('\r\n');
    const v2Path = path.join(T1, 'v2.tsv');
    fs.writeFileSync(v2Path, v2Fixture);
    const rows = loadCanaryV2Set(v2Path);
    report('loadCanaryV2Set: 跳过注释/空行,CRLF 容忍,解析出 3 行', rows.length === 3, rows);
    report('loadCanaryV2Set: type=text 单 id 解析正确', rows[0] && rows[0].type === 'text' && JSON.stringify(rows[0].expectedIds) === JSON.stringify(['ns:foo:bar']), rows[0]);
    report('loadCanaryV2Set: type=graph 多 id 逗号分隔解析正确(与 W4-C 简报③一致的「任一命中即算」前提)', rows[1] && JSON.stringify(rows[1].expectedIds) === JSON.stringify(['ns:head-a', 'ns:head-b']), rows[1]);
    report('loadCanaryV2Set: type=negative 空 expected_ids 解析为空数组(不是 [""])', rows[2] && Array.isArray(rows[2].expectedIds) && rows[2].expectedIds.length === 0, rows[2]);
    try { fs.rmSync(T1, { recursive: true, force: true }); } catch {}
  }

  // ── judgeRankByIds:红→绿(brief③「任一命中即算」——只查列表首个 id 的旧逻辑会漏判)。
  {
    const rankedSample = [{ id: 'ns:decoy' }, { id: 'ns:head-b' }, { id: 'ns:other' }];
    const onlyFirstIdBuggy = (ranked, ids) => { // 改前红:只查 expected_ids[0],不查整个列表
      for (let i = 0; i < ranked.length; i++) if (normId(ranked[i].id) === normId(ids[0])) return i + 1;
      return null;
    };
    report('judgeRankByIds 改前红的证据:只查首个 id 的旧写法在本例漏判(head-b 在列表第二位,排名第二)',
      onlyFirstIdBuggy(rankedSample, ['ns:head-a', 'ns:head-b']) === null, null);
    report('judgeRankByIds:任一 expected_ids 命中即算,取最靠前排名(改后绿)',
      judgeRankByIds(rankedSample, ['ns:head-a', 'ns:head-b']) === 2, judgeRankByIds(rankedSample, ['ns:head-a', 'ns:head-b']));
    report('judgeRankByIds:expected_ids 为空数组时返回 null(negative 型题目的形状,不应误判命中)',
      judgeRankByIds(rankedSample, []) === null, null);
  }

  // ── computeBaselineReport:合成语料 + 合成题库,text/search/semantic/graph/negative 五类各过一遍
  // (纯函数,不依赖真语料/真 HEAD——同 rankQuery 自测的先例)。
  {
    const synth = [
      mk('ns:text-target', 'irrelevant title', null, null, '', 'ns:text-target', '2026-01-01', 'decisions.md', [1, 2]),
      mk('ns:search-target', 'unique search phrase apple', null, null, '', 'ns:search-target', '2026-01-01', 'decisions.md', [3, 4]),
      mk('ns:semantic-target', 'semantic body content banana', null, null, '', 'ns:semantic-target', '2026-01-01', 'lessons.md', [5, 6]),
      mk('ns:graph-old', 'graph chain cherry', null, null, '', 'ns:graph-new', '2026-01-01', 'decisions.md', [7, 8]),
      mk('ns:graph-new', 'graph chain cherry', null, null, '', 'ns:graph-new', '2026-01-01', 'decisions.md', [9, 10]),
    ];
    const idx = buildIndex(synth);
    const legacyRows = [
      parseCanaryRow('search', '[ns:search-target]', 'unique search phrase'),
      parseCanaryRow('semantic', 'ns-semantic-target', 'semantic body content'),
    ];
    // H5 口径靠 expectedFile(slug->文件名);合成语料里 semantic-target 落在 lessons.md,slug 须写成
    // 会被 slugToFile 转成 'lessons.md' 的形式,不能直接沿用 parseCanaryRow 的默认 'pmm-'+target。
    legacyRows[1] = parseCanaryRow('semantic', 'pmm-lessons', 'semantic body content banana');
    const v2Rows = [
      { type: 'text', query: 'ns:text-target', expectedIds: ['ns:text-target'], note: '' },
      { type: 'graph', query: 'graph chain cherry', expectedIds: ['ns:graph-new'], note: '' },
      { type: 'negative', query: 'zzznonexistentgibberish999', expectedIds: [], note: '' },
    ];
    const rep = computeBaselineReport(idx, legacyRows, v2Rows);
    report('computeBaselineReport: text 类 R@1=1(合成语料单条命中)', rep.byType.text.count === 1 && rep.byType.text.recallAt1 === 1, rep.byType.text);
    report('computeBaselineReport: search 类 R@1=1', rep.byType.search.count === 1 && rep.byType.search.recallAt1 === 1, rep.byType.search);
    report('computeBaselineReport: semantic 类 R@1=1(H5 口径:第一名所在文件匹配)', rep.byType.semantic.count === 1 && rep.byType.semantic.recallAt1 === 1, rep.byType.semantic);
    report('computeBaselineReport: graph 类 R@1=1(head 而非 superseded 排第一)', rep.byType.graph.count === 1 && rep.byType.graph.recallAt1 === 1, rep.byType.graph);
    report('computeBaselineReport: negative 类 0-hit 率=1、无误命中(合成乱码查询真的 0 命中)', rep.negative.count === 1 && rep.negative.zeroHitRate === 1 && rep.negative.falseHits.length === 0, rep.negative);

    // 红→绿(negative 维,brief⑥):把 negative 题目的 query 换成一个真会命中语料的词,证明
    // falseHits 不是摆设——「0-hit 率恒 1」的假绿(判据形同虚设)在这里必须翻车。
    const v2RowsRed = [{ type: 'negative', query: 'ns:text-target', expectedIds: [], note: '' }];
    const repRed = computeBaselineReport(idx, [], v2RowsRed);
    report('computeBaselineReport 红证据:negative 题若真命中语料,falseHits 必须记录、zeroHitRate 必须 <1',
      repRed.negative.zeroHitRate === 0 && repRed.negative.falseHits.length === 1 && repRed.negative.falseHits[0].hits.includes('ns:text-target'),
      repRed.negative);
  }

  // ── runGoldenBaseline:golden 夹具(fixtures/v3/supersedes-cause-follows.md)上的 Cause 链基线
  // (活体语料 Cause: 字段行为 0,只能在这个夹具上出题——补遗三第 30 条)。
  {
    const fixturePath = path.join(__dirname, GOLDEN_FIXTURE_REL.split('/').join(path.sep));
    const res1 = runGoldenBaseline(fixturePath, null);
    report('runGoldenBaseline: rc=ok,graph 类题数=GOLDEN_QUESTIONS.length', res1.ok && res1.report.byType.graph.count === GOLDEN_QUESTIONS.length, res1.ok ? res1.report.byType.graph : res1.error);
    report('runGoldenBaseline: fixtureSha 非空(git hash-object 或 sha256 回退,确定性)', res1.ok && typeof res1.report.fixtureSha === 'string' && res1.report.fixtureSha.length > 0, res1.ok ? res1.report.fixtureSha : res1.error);
    const res2 = runGoldenBaseline(fixturePath, null);
    report('runGoldenBaseline: 同一夹具两次调用 fixtureSha 相同(内容寻址,确定性可复现)', res1.ok && res2.ok && res1.report.fixtureSha === res2.report.fixtureSha, { a: res1.report && res1.report.fixtureSha, b: res2.report && res2.report.fixtureSha });
    // 红→绿(graph 维在 golden 语料上,brief④):不存在的夹具路径必须走 PMM-DEGRADED,不能崩溃/假绿。
    const resMissing = runGoldenBaseline(fixturePath + '.does-not-exist', null);
    report('runGoldenBaseline: 夹具路径不存在时受控失败(ok=false),不是静默假绿', resMissing.ok === false && /PMM-DEGRADED/.test(resMissing.error || ''), resMissing);
  }

  // ── 曝光默认关闭(2026-09-24 主脑裁决):三个子用例分别在各自的隔离子进程里跑(iso.isoEnv 临时
  // HOME + PMM_MEM_DIR 指向真语料只读),每个子用例各自套一次 footprint 零足迹(不共用同一个
  // begin/end,免得一个子用例的残留文件掩盖另一个子用例本该测的「不存在」)。
  const { spawnSync } = require('child_process');
  function shadowFileUnder(T) {
    return T.replace(/\\/g, '/') + '/.claude/.shadow/retrieval-impressions-' + MACH + '.tsv';
  }
  function runIsolated(argsAfterFilename, tag) {
    const T = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'search-v2-' + tag + '-');
    const REAL_TREE_HOME = iso.realHome();
    // PMM_GIT_HOME 只读复用真语料所在的 git 仓库(--baseline 现在按补遗三第 30 条钉 HEAD 读,
    // core.homeDir() 需要它才能找到真仓库,不然会去 T 这个空临时目录跑 git,报「不是仓库」)。
    // GIT_CONFIG_* 三件套只在**这一个被 spawn 的子进程**生效(进程级环境变量,不改任何配置文件、
    // 不是 `git config --global`),用来绕开本机沙箱一个已知环境怪癖:`C:SERS<USER>` 整个目录在
    // 这台机器上被判定属主是 SYSTEM,git 从 T(它是 `%TEMP%` 下的子目录,而 `%TEMP%` 恰好嵌套在
    // `C:SERS<USER>` 之下)按父目录发现算法一路找上去,会命中真仓库根并触发「dubious ownership」
    // 拒绝——这与本文件的改动无关,是环境本身的属主怪癖,只读操作按 git 官方文档的方式豁免。
    const env = iso.isoEnv(T, {
      PMM_MEM_DIR: REAL_TREE_HOME + '/.claude/memory', // 只读复用真语料
      PMM_GIT_HOME: REAL_TREE_HOME,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*',
    });
    const caseSnap = iso.footprint.begin();
    const r = spawnSync(process.execPath, [__filename].concat(argsAfterFilename), { env, encoding: 'utf8', timeout: 15000 });
    const fp = iso.footprint.end(caseSnap, iso.markersFromSource(__filename, nonce, path.basename(T)));
    let shadowLines = [];
    try { shadowLines = fs.readFileSync(shadowFileUnder(T), 'utf8').trim().split('\n').filter(Boolean); } catch {}
    const cleanup = () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} };
    return { T, r, fp, shadowLines, cleanup };
  }

  // ① --baseline 跑完,隔离 HOME 的 .shadow/ 下不存在曝光文件(runBaseline 结构上不调用
  //    writeExposures,与是否传 --record-exposure 无关——这里刻意不传该 flag,证明「默认」就是零写)。
  {
    // 真语料的两份题库路径——不能用模块级 HOME(那是本进程自己的 resolveHome(),在自测场景下已经
    // 指向外层调用者传进来的隔离 HOME,不是真根);必须用 iso.realHome()。CLI 现在是
    // `--baseline [legacyFile] [v2File] [outFile]`(补遗三第 30 条改写版新增了 v2File 这一位),
    // outFile 留空 = 不写任何文件,只测 rc + 曝光文件缺席。
    const legacyPath = iso.realHome() + '/.claude/memory/_local-config/canary-set.tsv';
    const v2Path = iso.realHome() + '/.claude/guards/specs/retrieval-canary-v2.tsv';
    const { r, fp, shadowLines, cleanup } = runIsolated(['--baseline', legacyPath, v2Path], 'baseline');
    report('①--baseline:隔离子进程 rc=0', r.status === 0, { status: r.status, stderr: (r.stderr || '').slice(0, 300) });
    report('①--baseline:.shadow/ 下不存在曝光文件(默认零写入)', shadowLines.length === 0, shadowLines.length);
    report('①--baseline:真根本次调用零足迹', !fp.red, fp.line);
    cleanup();
  }

  // ② 普通查询、不带 --record-exposure -> 同样不存在曝光文件。
  {
    const { r, fp, shadowLines, cleanup } = runIsolated(['pmm:canonical-home-only'], 'query-noflag');
    report('②普通查询(无 --record-exposure):隔离子进程 rc=0', r.status === 0, { status: r.status, stderr: (r.stderr || '').slice(0, 300) });
    report('②普通查询(无 --record-exposure):.shadow/ 下不存在曝光文件', shadowLines.length === 0, shadowLines.length);
    report('②普通查询(无 --record-exposure):真根本次调用零足迹', !fp.red, fp.line);
    cleanup();
  }

  // ③ 带 --record-exposure 的查询 -> 曝光文件存在,K21 字段齐全(原 K21 断言搬到这里)。
  {
    const { r, fp, shadowLines, cleanup } = runIsolated(['pmm:canonical-home-only', '--record-exposure'], 'query-flag');
    report('③--record-exposure:隔离子进程 rc=0', r.status === 0, { status: r.status, stderr: (r.stderr || '').slice(0, 300) });
    report('③--record-exposure:曝光文件写在隔离 HOME 下的 .shadow/,不是真根', shadowLines.length > 0, shadowLines.length);
    if (shadowLines.length) {
      const cols = shadowLines[0].split('\t');
      report('③--record-exposure:曝光行列数 = 7(ts,query_sha256,rank,gate_instance_id,impression_id,identity,score)', cols.length === 7, cols);
      report('③--record-exposure:曝光行 gate_instance_id = "search:0"(top-1,0-indexed)', cols[3] === 'search:0', cols[3]);
      const expectedImpId = ledger.impressionId({ session_id: '', agent_id: '', tool_use_id: '', trigger_or_gate_id: cols[5], gate_instance_id: cols[3] });
      report('③--record-exposure:曝光行 impression_id 精确等于 M-SPEC 附录 A 公式值', cols[4] === expectedImpId, { got: cols[4], want: expectedImpId });
    }
    report('③--record-exposure:真根本次调用零足迹', !fp.red, fp.line);
    cleanup();
  }

  // ── 临时 HOME、语料目录不存在时:绝不抛未捕获异常/堆栈崩溃(NO-GO 裁决②的直接回归用例)。
  //    查询模式下语料确实读不到是一个真实失败,rc 非 0 是正确行为——但必须是「controlled
  //    PMM-DEGRADED + 干净 exit」,不是 node 的未捕获异常堆栈(旧版 bug 正是后者:core.snapshot
  //    没包 try,抛出 PmmCoreError 直接冒到顶层,stdout 空、stderr 是一整段 "Error: ... at ...”
  //    调用栈,而不是这里期望的单行 PMM-DEGRADED 消息)。──
  {
    const T2 = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'search-v2-empty-');
    const env2 = iso.isoEnv(T2, {});
    const r2 = spawnSync(process.execPath, [__filename, 'anything'], { env: env2, encoding: 'utf8', timeout: 15000 });
    const stderr2 = r2.stderr || '';
    const isControlledDegraded = stderr2.trim().indexOf('PMM-DEGRADED') === 0;
    const isUncaughtCrash = /^\s*at\s|Error\n\s+at\s|node:internal/.test(stderr2);
    report('空语料临时 HOME 下不崩溃(受控 PMM-DEGRADED,非未捕获异常堆栈)',
      r2.status !== 0 && isControlledDegraded && !isUncaughtCrash,
      { status: r2.status, stdout: (r2.stdout || '').slice(0, 200), stderr: stderr2.slice(0, 300) });
    try { fs.rmSync(T2, { recursive: true, force: true }); } catch {}
  }

  const fp = iso.footprint.end(fpSnap, iso.markersFromSource(__filename, nonce, ''));
  report('footprint: 本自测对真根零可归因改动', !fp.red, fp.line);

  console.log('SELFTEST-SEARCH-V2 {"pass":' + pass + ',"fail":' + fail + '}');
  process.exitCode = fail > 0 ? 1 : 0;
  return { pass, fail, details };
}
// SELFTEST-END

// ── CLI 入口 ─────────────────────────────────────────────────────────────────────────────────────
function mainCli(argv) {
  const args = argv.slice(2);
  if (args[0] === '--self-test' || args[0] === '--self-check') {
    return selfTest();
  }
  if (args[0] === '--baseline') {
    // 补遗三第 30 条改写版:题库拆成两源(legacy canary-set.tsv 的 search/semantic + 新
    // guards/specs/retrieval-canary-v2.tsv 的 text/graph/negative),语料钉在 HEAD(不读 worktree)。
    // 三个位置参数全可选(同旧 CLI `--baseline [canary.tsv] [out.json]` 的形状延伸一位):
    // --baseline [legacyFile] [v2File] [outFile],缺省时都从 HOME 派生(自测用隔离 HOME 时
    // 必须显式传前两个,否则会去读隔离临时目录下并不存在的题库文件)。
    const legacyFile = args[1] || (HOME + '/.claude/memory/_local-config/canary-set.tsv');
    const v2File = args[2] || (HOME + '/.claude/guards/specs/retrieval-canary-v2.tsv');
    const outFile = args[3] || null;
    const res = runBaselineV2({ legacyFile, v2File, outFile });
    if (!res.ok) { console.error(res.error); process.exitCode = 1; return; }
    console.log(JSON.stringify({
      treeOid: res.report.treeOid, byType: res.report.byType, negative: {
        count: res.report.negative.count, zeroHitRate: res.report.negative.zeroHitRate,
        falseHitCount: res.report.negative.falseHits.length,
      },
    }, null, 2));
    return;
  }
  if (args[0] === '--baseline-golden') {
    const outFile = args[1] || null;
    const fixtureFile = HOME + '/.claude/guards/' + GOLDEN_FIXTURE_REL;
    const res = runGoldenBaseline(fixtureFile, outFile);
    if (!res.ok) { console.error(res.error); process.exitCode = 1; return; }
    console.log(JSON.stringify({ fixtureSha: res.report.fixtureSha, byType: res.report.byType }, null, 2));
    return;
  }
  // --record-exposure:唯一打开曝光落盘的开关(不读任何环境变量);可以出现在参数列表任意位置,
  // 剩余 token 拼回查询词。
  const recordExposure = args.includes('--record-exposure');
  const query = args.filter((a) => a !== '--record-exposure').join(' ');
  if (!query) { console.error('usage: pmm-search-v2.cjs "<query>" [--record-exposure] | --baseline [out.json] | --baseline-golden [out.json] | --self-test'); process.exitCode = 1; return; }
  const res = runQuery(query, { recordExposure });
  if (!res.ok) { console.error(res.error); process.exitCode = 1; return; }
  if (!res.ranked.length) { console.log('(0 命中)'); return; }
  res.ranked.forEach((r, idx) => console.log(formatResult(r, idx)));
}

module.exports = {
  tokenizeV2, normId, loadEntries, loadEntriesFromFixture, buildIndex, rankQuery, writeExposures, runQuery,
  parseCanaryRow, loadCanarySet, loadCanaryV2Set, judgeRankByIds, computeBaselineReport, runBaselineV2, runGoldenBaseline,
  formatResult, slugToFile,
  FIELD_WEIGHTS, IDENTITY_EXACT_SCORE, IDENTITY_SUBSTRING_SCORE, HEAD_BONUS, SUPERSEDED_PENALTY, TOP_K,
  HOME, MACH, SHADOW_DIR, RETRIEVAL_LOG,
};

if (require.main === module) {
  mainCli(process.argv);
}
