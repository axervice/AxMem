#!/usr/bin/env node
// pmm-index-emit.cjs — C05-BUILD-SPEC.md 交付物 5(`pmm-index-emit.sh --shadow`)+ 补遗一第 10 条①
// 两例夹具的专属诊断消费者。
//
// 跑 `core --index --as-of $(date +%F)`(实现方式:直接 require pmm-core.cjs 的 parseAll/
// attachLegacyIndex/buildGraph/renderIndex/renderIndexText,而非新起一个 CLI——pmm-core.sh 本身只有
// --self-test,§交付物5 说的"跑 core --index"是"用 core 库算出 index"而非某个既有子命令),写本机
// `<resolveHome()>/.claude/.shadow/index-<mach>.txt` 与 LKG 缓存
// `<resolveHome()>/.claude/.pmm-index-lkg/<sha256(sourceOids+schemaVersion)>.txt`;与 HEAD 三处
// Index(decisions.md/lessons.md/standinginstructions.md 各自现存的手写 `## Index` 段)做归一化
// diff,配对算法与 pmm-verify-assertions.cjs 的 A4/A7(`派生 Index 与旧 Index 按 plan 映射对齐`)
// 同源:legacy bullet 的 tag 直接对应当前派生条目的 id——C0.5 阶段没有迁移 plan(C1 才切换),
// 所以"plan 映射"在这里退化为恒等映射(id→id),不需要 A7 代码里的 rename 表;bullet 解析复用
// `pmm-migrate-v3.cjs` 导出的 `parseLegacyIndexBullets`(只读引用,不改该文件,不复制其语法)。
//
// 视图选择:默认读 `core.snapshot('HEAD')`(不是 'worktree')——因为①本交付物的比对目标明确写的
// 是"HEAD 三处 Index",用同一个 HEAD 快照同时喂"派生侧"与"legacy 侧"最直接,不必再单独取一次
// worktree;②HEAD 视图的 sourceOids.treeOid 是真实 git 树哈希,LKG key(spec:
// sha(sourceOids+schemaVersion))才有实际内容寻址意义——'worktree' 视图的 treeOid 恒为 null,会让
// key 退化成只看 schemaVersion 的单一桶。可用 --dir <path> 切到 core.snapshotDir()(用于本文件自
// 己的故障注入自测,以及未来的夹具回放),不影响生产默认路径。
//
// 交付物 5 原文:"故障注入:core throw / 空快照 / 缺文件 → 必须输出 PMM-DEGRADED + 走
// LKG/标题末路,永不空输出且 0"。补遗一第 10 条①另加两例(文件在但 0 字节 / 尾部截断到一半条
// 目)且要求"专属诊断,不得当合法文件、不能用泛化 blocking 顶替"——core.check() 不做这个判断(那
// 正是 Opus 风险 4 指出的缺口),所以这里在调用 parseAll 之前先对每个文件做一次独立的结构哨兵
// (raw.length===0 / detectTruncation()),命中就短路成对应的专属 PMM-DEGRADED 码,绝不进入
// parseAll 让 core 把它当合法文件处理。
//
// **不接进 SessionStart**(交付物 5 原文;本文件没有,也不应该有,任何 settings.json 改动)。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const core = require('./pmm-core.cjs');
const ledger = require('./pmm-recall-ledger.cjs'); // resolveHome() 的唯一入口(简报 B4:不自己重实现)
// W4-E2(主脑裁定,2026-09-24):plan 查找从只认 treeOid 改为先认语料内容指纹——只读复用
// pmm-migrate-v3.cjs 刚导出的 computeCorpusFingerprint()/corpusFingerprintKey(),不在本文件
// 重新拼一份指纹算法(两处独立实现互相对不上正是本仓库反复踩过的缺陷模式)。见下方
// loadPlanForKey()/loadPlanForSnap()。
const migrate = require('./pmm-migrate-v3.cjs');

// HOME/MACH/SHADOW_DIR/LKG_DIR 复用 pmm-search-v2.cjs 已建立的同一套解析与命名惯例。
const HOME = ledger.resolveHome().replace(/\\/g, '/');
const MACH = (os.hostname() || 'unknown').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
const SHADOW_DIR = HOME + '/.claude/.shadow';
const LKG_DIR = HOME + '/.claude/.pmm-index-lkg';
const INDEX_FILE = SHADOW_DIR + '/index-' + MACH + '.txt';
const THREE_FILES = ['decisions.md', 'lessons.md', 'standinginstructions.md'];

// ── §10①:文件在但内容空/被截断的专属诊断 ──────────────────────────────────────────────────────
// detectTruncation(raw) — 只处理一种具体、可判定的截断特征:文件最后一个非空行以 v3 标题行的开头
// 形状开局(`**YYYY-MM-DD`)却没有在同一行内闭合(复用 core.TITLE_RE 本身判断"闭合"——不重新发明
// 标题语法,只是多加一条 core 完全没有的"EOF 前有一行没写完的标题"哨兵)。刻意不把"缺尾换行"当
// 信号:fixtures/v3/no-trailing-newline.md 是 core 已经承认合法的形状,不能被这里误伤。
function detectTruncation(raw) {
  const text = raw.toString('utf8');
  const lines = text.split(/\r?\n/);
  let li = lines.length - 1;
  while (li >= 0 && lines[li].trim() === '') li--;
  if (li < 0) return null;
  const last = lines[li];
  if (/^\*\*(20\d\d-\d\d-\d\d)/.test(last) && !core.TITLE_RE.test(last)) {
    return { line: li + 1, raw: last.slice(0, 120) };
  }
  return null;
}

// fileFaults(snap) — 只在 snap.missing 为空(全部 7 个文件都"在场")时才有意义调用;返回每个在场
// 文件里检出的 0 字节/截断故障列表,顺序 = core.ALL_FILES 顺序,诊断码互不相同(第 10 条①要求)。
function fileFaults(snap) {
  const out = [];
  for (const f of core.ALL_FILES) {
    const info = snap.files && snap.files[f];
    if (!info || info.missing) continue;
    const raw = info.raw;
    if (!raw || raw.length === 0) { out.push({ file: f, code: 'file-empty:' + f }); continue; }
    const trunc = detectTruncation(raw);
    if (trunc) out.push({ file: f, code: 'file-truncated:' + f, line: trunc.line });
  }
  return out;
}

// ── LKG key:sha256(JSON({sourceOids, schemaVersion})),即 spec 交付物 5 原文
// "sha(sourceOids+schemaVersion)"。core.sha256hex 是既有导出,复用而非重新拼 crypto 调用。 ──────
function lkgKeyFor(sourceOids, schemaVersion) {
  return core.sha256hex(Buffer.from(JSON.stringify({ sourceOids: sourceOids || null, schemaVersion }), 'utf8'));
}

// ── M2 修复(guards/audits/OPUS-2026-09-24-c05-wave2-review.md「M2 B4 未按 plan 对齐」)────────────
// 「C0.5 无 plan」不实:迁移计划钉在 `specs/PLAN-<key>.json`。该计划的 `⑤hook-from-index-rest` 动作
// (每条形如 `{file, action:{tag, ...}}`,来自 pmm-migrate-v3.cjs:407-414「REST != title 且目标条目
// 还没有 Hook」)与下面 compareIndexToLegacy 的 mismatched 判据(REST != hookOrTitle)是**同一条件的
// 两次独立实现**——两者对同一批条目给出同一个结论,所以把 mismatched 里这批「计划已经排定要在 C1
// 把 REST 挪进 Hook 字段」的条目,单独计成 planExpected(计划内/预期),不算进 mismatched(真差异)。
// 找不到已提交 plan 文件(语料已漂移、还没人为新语料重新生成/审查)时优雅退化:planExpectedSet 为
// 空,mismatched 按原样全报(不静默假装对齐——pmm-c0-canary-check.sh 同一原则:绝不自动重新生成
// plan,漂移就如实报漂移)。
//
// W4-E(7138cc7,spec 补遗三 §32)把 PLAN 文件名/新鲜度判据从 treeOid 改成了语料内容指纹(receipts
// 落盘会挪动 treeOid 却不碰 core.ALL_FILES 字节,旧 treeOid 判据因此把已审的 plan 误判成漂移)。W4-E2
// (主脑裁定)把这里的查找拆成两层:loadPlanForKey() 是新的主路径,按 corpusFingerprintKey(内容指纹
// 前 40 hex)查 `PLAN-<key>.json` 并核对 JSON 内部 corpusFingerprint 字段;loadPlanForTreeOid()
// 保留原样(仅加一个可选 specsDir 参数便于自测注入,查找/校验逻辑一字未改)作为**兼容旧文件**的
// 回退——W4-E 的提交信息明确写了「旧的 treeOid 命名文件不删」,所以两种命名可能在 specs/ 下并存。
// 两者的编排见下方 loadPlanForSnap():先按内容键找,找不到才回退 treeOid 命名,都找不到就如实报
// no-plan(不伪造匹配)。
function loadPlanForTreeOid(treeOid, specsDir) {
  if (!treeOid) return { plan: null, status: 'no-treeOid' };
  const dir = specsDir || path.join(__dirname, 'specs');
  const p = path.join(dir, 'PLAN-' + treeOid + '.json');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return { plan: null, status: 'no-plan-for-treeOid:' + treeOid }; }
  let j;
  try { j = JSON.parse(raw); } catch (e) { return { plan: null, status: 'plan-parse-error:' + p }; }
  if (j.treeOid !== treeOid) return { plan: null, status: 'plan-treeOid-mismatch:' + p };
  return { plan: j, status: 'loaded:' + p };
}

// loadPlanForKey(key, corpusFingerprint, specsDir) — W4-E2 新主路径。key 是
// migrate.corpusFingerprintKey(fp)(内容指纹前 40 hex,与 PLAN 文件名字段等长,沿用同一套「够长到不
// 会意外碰撞、够短到文件名可读」的取舍);新鲜度校验比对 JSON 内部**完整** corpusFingerprint 字段
// (pmm-migrate-v3.cjs cmdPlan() 写入的是未截断的 sha256 hex,不是截断后的 key——见该文件 cmdPlan()
// 里 `corpusFingerprint` 与 `key` 是两个不同长度的变量),原理与 loadPlanForTreeOid 的
// `j.treeOid !== treeOid` 校验同构,只是换了一套字段名。specsDir 可选(默认与 loadPlanForTreeOid
// 同一个真实 `guards/specs` 目录),自测用于注入临时夹具目录,不改变生产默认路径。
function loadPlanForKey(key, corpusFingerprint, specsDir) {
  if (!key) return { plan: null, status: 'no-key' };
  const dir = specsDir || path.join(__dirname, 'specs');
  const p = path.join(dir, 'PLAN-' + key + '.json');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return { plan: null, status: 'no-plan-for-key:' + key }; }
  let j;
  try { j = JSON.parse(raw); } catch (e) { return { plan: null, status: 'plan-parse-error:' + p }; }
  if (j.corpusFingerprint !== corpusFingerprint) return { plan: null, status: 'plan-corpusFingerprint-mismatch:' + p };
  return { plan: j, status: 'loaded-by-key:' + p };
}

// loadPlanForSnap(snap, opts) — 编排层,取代原先直接调用 loadPlanForTreeOid(treeOid) 的唯一查找口径:
// ①算出 snap 的语料内容指纹(migrate.computeCorpusFingerprint,只读复用、不重新实现)与其 40-hex
// key,按 loadPlanForKey 查;②命中就返回,matchedBy='content-key';③未命中(含 snap 没有可指纹化的
// files,例如测试用的合成快照)就回退 loadPlanForTreeOid(treeOid),命中则 matchedBy='treeOid-legacy'
// (兼容旧命名文件);④两条路都未命中,返回 plan:null、matchedBy:'none',status 里把两条路各自的
// status 都带上(便于诊断到底是「没算出 key」「key 有但文件不在/不新鲜」还是「treeOid 也没有」)——
// 不静默假装找到,也不吞掉两次查找各自的诊断信息。opts.specsDir 可选,同时喂给两条查找路径(自测
// 用一个临时目录同时验证「都没有」的场景;生产默认两者都落在真实 guards/specs)。
function loadPlanForSnap(snap, opts) {
  opts = opts || {};
  const specsDir = opts.specsDir;
  const treeOid = (snap && snap.sourceOids && snap.sourceOids.treeOid) || null;
  let corpusFingerprint = null, key = null;
  try {
    if (snap && snap.files) {
      corpusFingerprint = migrate.computeCorpusFingerprint(snap);
      key = migrate.corpusFingerprintKey(corpusFingerprint);
    }
  } catch (e) { /* 合成/残缺快照算不出指纹 -- 落到下面的 treeOid 回退,不让指纹计算异常盖过查找本身 */ }

  const byKey = key ? loadPlanForKey(key, corpusFingerprint, specsDir) : { plan: null, status: 'no-key' };
  if (byKey.plan) return { plan: byKey.plan, status: byKey.status, matchedBy: 'content-key', key, treeOid };

  const byTreeOid = loadPlanForTreeOid(treeOid, specsDir);
  if (byTreeOid.plan) return { plan: byTreeOid.plan, status: byTreeOid.status, matchedBy: 'treeOid-legacy', key, treeOid };

  return {
    plan: null,
    status: 'no-plan(key:' + byKey.status + '; treeOid:' + byTreeOid.status + ')',
    matchedBy: 'none', key, treeOid,
  };
}

// planExpectedSetFrom(plan) — file+tag(小写)的集合,来自 plan.edits 里 kind==='⑤hook-from-index-rest'
// 的动作(tag 在 `edit.action.tag`,顶层 `edit.tag` 作后备——两种取法与下面 pmm-migrate-v3.cjs 实际
// 产出的记录形状对齐,见该文件 :415 hookMoveActions.push 的字段名)。
function planExpectedSetFrom(plan) {
  const set = new Set();
  if (!plan || !Array.isArray(plan.edits)) return set;
  for (const e of plan.edits) {
    if (e.kind !== '⑤hook-from-index-rest') continue;
    const tag = (e.action && e.action.tag) || e.tag;
    const file = e.file || (e.action && e.action.file);
    if (!file || !tag) continue;
    set.add(file + '|' + String(tag).toLowerCase());
  }
  return set;
}

// ── HEAD 三处 Index 归一化 diff(A7 口径,见文件头注释)──────────────────────────────────────────
// 对 decisions.md/lessons.md/standinginstructions.md 三个文件各自:①用 pmm-migrate-v3.cjs 的
// parseLegacyIndexBullets() 从同一个快照的原始字节里抽出手写 Index 的每一行(tag/restText/
// dateRaw);②按 tag(大小写不敏感、同文件同 tag 按出现顺序排队,镜像 A4/A7 处理同文件重复 tag 的
// queue 写法)配对到 parsed.entries 里对应的当前派生条目;③逐对比较
// hookOrTitle(entry)(= entry.hook!=null? entry.hook: entry.title,与 pmm-verify-assertions.cjs:401
// 同一行内联写法,不是新逻辑)是否等于 bullet 的 REST 文本。
// 归类(供报告,不做通过/失败判定——本交付物只"报告差异",不像 shadow-compare 那样要求零未解释):
//   matched      — REST 逐字节相等;
//   mismatched   — 都在,REST 不等且不在钉住的迁移计划⑤类覆盖范围内(真差异);
//   planExpected — 都在,REST 不等,但钉住的迁移计划⑤类动作已经排定要在 C1 把这条 REST 挪进
//                  Hook 字段(计划内/预期,不是需要现在处理的差异——M2 修复新增的分类);
//   dangling     — 旧 Index 有这一行,当前派生语料里找不到对应条目(已删/改名/未到 as-of);
//   derivedOnly  — 当前派生语料有这条目,旧手写 Index 没有对应行(新增/旧 Index 未跟上);
//   exempt       — bullet 带 dateRaw 后缀((...) 括注),A4/A7 同款例外(⑨),不做字节比较。
// opts.plan(可选,默认省略):测试专用注入点——传一个已解析的 plan 对象(或显式 null)绕过磁盘读取,
// 让纯函数自测不必依赖某个具体 treeOid 是否真的有已提交的 plan 文件;生产路径(不传 opts.plan)按
// snap.sourceOids.treeOid 现查磁盘,行为见上面 loadPlanForTreeOid 的头注。
function compareIndexToLegacy(snap, parsed, asOf, opts) {
  opts = opts || {};
  // migrate 现是模块顶层 require(见文件头),这里不再重复 require 一遍——parseLegacyIndexBullets
  // 与 loadPlanForSnap 内部用的 computeCorpusFingerprint/corpusFingerprintKey 共用同一个模块实例。
  const treeOid = snap.sourceOids && snap.sourceOids.treeOid;
  const planLoad = Object.prototype.hasOwnProperty.call(opts, 'plan')
    ? { plan: opts.plan, status: opts.plan ? 'injected' : 'injected-null', matchedBy: 'injected', key: null, treeOid }
    : loadPlanForSnap(snap, opts.planLookup);
  const planExpectedSet = planExpectedSetFrom(planLoad.plan);
  const perFile = {};
  let matched = 0, mismatched = 0, dangling = 0, derivedOnly = 0, exempt = 0, planExpected = 0;
  const mismatchDetails = [], danglingDetails = [], derivedOnlyDetails = [], planExpectedDetails = [];
  for (const f of THREE_FILES) {
    const info = snap.files[f];
    if (!info || info.missing) { perFile[f] = { skipped: 'missing' }; continue; }
    const text = info.raw.toString('utf8');
    const bullets = migrate.parseLegacyIndexBullets(text);
    const queueByTag = new Map();
    for (const e of parsed.entries) {
      if (e.file !== f || !e.id || e.archived) continue;
      if (!(e.dateISO <= asOf)) continue; // 只有 as-of 之前(含当天)的条目才会出现在派生 index 里
      const k = e.id.toLowerCase();
      if (!queueByTag.has(k)) queueByTag.set(k, []);
      queueByTag.get(k).push(e);
    }
    for (const b of bullets) {
      const k = b.tag.toLowerCase();
      const queue = queueByTag.get(k);
      const e = queue && queue.length ? queue.shift() : null;
      if (!e) { dangling++; danglingDetails.push(f + ' [' + b.tag + '] 旧 Index 指向的条目在当前派生语料里缺失(已删/改名/未到 as-of)'); continue; }
      if (b.dateRaw) { exempt++; continue; }
      const restNorm = (b.restText || '').trim();
      const expected = restNorm && restNorm !== e.title ? restNorm : e.title;
      const got = e.hook != null ? e.hook : e.title; // hookOrTitle,内联写法见文件头注释
      if (got === expected) { matched++; continue; }
      if (planExpectedSet.has(f + '|' + k)) {
        planExpected++;
        planExpectedDetails.push(f + ' [' + b.tag + '] 旧="' + expected.slice(0, 60) + '" 派生="' + got.slice(0, 60) + '"(计划⑤hook-from-index-rest 已排定,C1 前非真差异)');
        continue;
      }
      mismatched++; mismatchDetails.push(f + ' [' + b.tag + '] 旧="' + expected.slice(0, 60) + '" 派生="' + got.slice(0, 60) + '"');
    }
    for (const [, queue] of queueByTag) {
      for (const e of queue) { derivedOnly++; derivedOnlyDetails.push(f + ' [' + e.id + '] 派生 Index 含此条目,旧手写 Index 未列'); }
    }
    perFile[f] = { bulletCount: bullets.length };
  }
  return {
    matched, mismatched, planExpected, dangling, derivedOnly, exempt,
    planOid: planLoad.plan ? planLoad.plan.treeOid : null, planStatus: planLoad.status,
    // W4-E2:报告里打印所用键与匹配方式(主脑裁定原文要求)——planKey 是查找时算出的内容指纹 40-hex
    // key(可能为 null,例如合成快照算不出指纹或走的是 injected 分支);planMatchedBy 是
    // 'content-key'(新主路径命中)/'treeOid-legacy'(回退到旧 treeOid 命名文件命中)/'injected'
    // (自测注入)/'none'(两条路都未命中,如实报 no-plan,不伪造匹配)之一。
    planKey: planLoad.key, planMatchedBy: planLoad.matchedBy,
    planExpectedDetails: planExpectedDetails.slice(0, 20),
    total: matched + mismatched + planExpected + dangling + derivedOnly + exempt,
    perFile,
    mismatchDetails: mismatchDetails.slice(0, 20),
    danglingDetails: danglingDetails.slice(0, 20),
    derivedOnlyDetails: derivedOnlyDetails.slice(0, 20),
  };
}

// ── PMM-DEGRADED:走 LKG/标题末路,永不空输出且 rc 0 ───────────────────────────────────────────
// M3 修复(guards/audits/OPUS-2026-09-24-c05-wave2-review.md「M3 LKG 兜底与 FINAL-SPEC §4 冲突」):
// PMM-V3-FINAL-SPEC.md 原文(§ SessionStart 注入 / 校验基线表 / fail-open 注入表三处一致)—— 「core
// 失败 ⇒ 首行 PMM-DEGRADED <err>,用 LKG(key 命中才用),无 LKG 再退标题行」「校验基线文件:0(LKG
// 缓存不参与放行)」「LKG + PMM-DEGRADED,标题为末路」。旧版在 key 未命中时退到「LKG 桶目录里 mtime
// 最新的一份」——这会把**另一个 treeOid**(可能是另一次语料内容、他库、甚至已被后续提交推翻的
// 旧版本)伪装成当前故障的兜底服务给消费者,B5 夹具 stale-lkg-old-file-served 就是拿这个行为当
// 期望钉住的(fixtures/v3/faults/stale-lkg-old-file-served/expect.json;该夹具与其消费者
// pmm-fault-matrix.cjs 不在本批写面内,删除 mtime 兜底后它会转红——按简报纪律单列供主脑处理,不在
// 本文件之外扩大范围去改它)。sourceOids 可用时按 spec 的 key 公式精确查 LKG;key 未命中(或根本没有
// sourceOids,例如 core 在拿到快照之前就炸了)一律直接走标题末路,不再用任何目录级兜底猜一份「大概
// 相关」的旧缓存出来冒充。
function degraded(code, err, ctx) {
  const shadowDir = ctx.shadowDir, lkgDir = ctx.lkgDir, indexFile = ctx.indexFile;
  let fallbackBody = null, fallbackSource = null;
  try {
    if (ctx.sourceOids) {
      const key = lkgKeyFor(ctx.sourceOids, core.SCHEMA_VERSION);
      const lkgFile = lkgDir + '/' + key + '.txt';
      if (fs.existsSync(lkgFile)) { fallbackBody = fs.readFileSync(lkgFile, 'utf8'); fallbackSource = 'lkg-key:' + key; }
    }
  } catch { /* 兜底查找本身失败,继续走标题末路,不让兜底逻辑的异常盖过原始故障 */ }
  const header = 'PMM-DEGRADED ' + code + (err ? (' :: ' + String((err && err.message) || err).slice(0, 300)) : '');
  const body = header + '\n' + (fallbackBody != null
    ? ('(fallback source: ' + fallbackSource + ')\n' + fallbackBody)
    : '(no LKG available -- 标题末路,仅诊断头,从不空输出)\n');
  try { fs.mkdirSync(shadowDir, { recursive: true }); fs.writeFileSync(indexFile, body); } catch { /* 尽力而为 */ }
  console.log(header);
  if (fallbackSource) console.log('LKG-FALLBACK ' + fallbackSource);
  process.exitCode = 1;
  return { ok: false, degraded: true, code, header, indexFile, fallbackSource };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────────────────────────
function runEmit(opts) {
  opts = opts || {};
  const asOf = opts.asOf || core.today();
  const shadowDir = opts.shadowDir || SHADOW_DIR;
  const lkgDir = opts.lkgDir || LKG_DIR;
  const indexFile = opts.indexFile || INDEX_FILE;
  const ctx = { shadowDir, lkgDir, indexFile };

  let snap;
  try {
    snap = opts.snapshotFn ? opts.snapshotFn() : core.snapshot('HEAD');
  } catch (e) {
    return degraded('core-throw', e, ctx);
  }

  ctx.sourceOids = snap.sourceOids; // 快照本身取得(哪怕内容有毛病),故障回落可以按 key 精确查 LKG

  const missing = snap.missing || [];
  if (missing.length && missing.length === core.ALL_FILES.length) {
    return degraded('empty-snapshot', null, ctx);
  }
  if (missing.length) {
    return degraded(missing.map((f) => 'missing-file:' + f).join(','), null, ctx);
  }

  const faults = fileFaults(snap);
  if (faults.length) {
    return degraded(faults.map((x) => x.code).join(','), null, ctx);
  }

  let parsed, graph, idx;
  try {
    parsed = core.parseAll(snap);
    core.attachLegacyIndex(parsed, snap);
    graph = core.buildGraph(parsed.entries);
    idx = core.renderIndex(parsed, graph, { asOf });
  } catch (e) {
    return degraded('core-throw', e, ctx);
  }

  const text = core.renderIndexText(idx);
  const key = lkgKeyFor(snap.sourceOids, core.SCHEMA_VERSION);
  const lkgFile = lkgDir + '/' + key + '.txt';
  let lkgHit = false;
  try { lkgHit = fs.existsSync(lkgFile); } catch { /* treat as miss */ }
  try { fs.mkdirSync(shadowDir, { recursive: true }); fs.writeFileSync(indexFile, text); } catch { /* best-effort */ }
  try { fs.mkdirSync(lkgDir, { recursive: true }); fs.writeFileSync(lkgFile, text); } catch { /* best-effort */ }

  let compare;
  try { compare = compareIndexToLegacy(snap, parsed, asOf); } catch (e) { compare = { error: String((e && e.message) || e) }; }

  const summary = {
    ok: true, degraded: false, view: snap.sourceOids && snap.sourceOids.view, sourceOids: snap.sourceOids,
    schemaVersion: core.SCHEMA_VERSION, asOf, indexFile, lkgFile, lkgKey: key, lkgHit, compare,
  };
  console.log('PMM-INDEX-EMIT ' + JSON.stringify(summary));
  process.exitCode = 0;
  return summary;
}

// SELFTEST-BEGIN
// spec 22(C05-BUILD-SPEC 补遗二 §22):本自测所有 DUT 子进程一律经 selftest-iso.cjs 的 isoEnv() 起,
// 首尾对真根做零足迹断言;简报 B4 第三条纪律:五个故障例(core throw/空快照/缺文件/空文件/截断)
// 都要在隔离子进程下证明 PMM-DEGRADED 出现且 rc 非 0,LKG 命中路径另外单独实测一次。
const iso = require('./selftest-iso.cjs');

function selfTest() {
  const nonce = 'index-emit-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const fpSnap = iso.footprint.begin();
  let pass = 0, fail = 0;
  const details = [];
  function report(name, ok, detail) {
    if (ok) { pass++; } else { fail++; details.push({ name, detail }); }
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : (detail !== undefined ? (' :: ' + JSON.stringify(detail)) : '')));
  }

  const CORPUS_WHOLE = path.resolve(__dirname, 'fixtures/v3/corpus-whole');
  const FAULT_EMPTY = path.resolve(__dirname, 'fixtures/v3/faults/index-emit-file-empty');
  const FAULT_TRUNC = path.resolve(__dirname, 'fixtures/v3/faults/index-emit-file-truncated');

  // ── 纯函数层(不隔离,合成输入,不读真语料/git)──────────────────────────────────────────────
  report('detectTruncation: 良构标题行(有闭合 **)不判截断',
    detectTruncation(Buffer.from('**2026-01-01 — well formed title** [fx:ok]\nbody\n', 'utf8')) === null);
  report('detectTruncation: 缺尾换行但标题闭合的良构文件不判截断(不得误伤 no-trailing-newline.md 那类合法形状)',
    detectTruncation(Buffer.from('**2026-01-01 — well formed title** [fx:ok]', 'utf8')) === null);
  report('detectTruncation: 标题行开局未闭合(尾部截断到一半)判定命中',
    (() => { const r = detectTruncation(Buffer.from('intro\n\n**2026-01-02 — routed-namespace identity must be B1', 'utf8')); return !!r && r.line === 3; })());
  report('lkgKeyFor: 相同 sourceOids+schemaVersion 得相同 key',
    lkgKeyFor({ view: 'dir', dir: '/x' }, 3) === lkgKeyFor({ view: 'dir', dir: '/x' }, 3));
  report('lkgKeyFor: sourceOids 不同则 key 不同',
    lkgKeyFor({ view: 'dir', dir: '/x' }, 3) !== lkgKeyFor({ view: 'dir', dir: '/y' }, 3));
  report('fileFaults: 0 字节文件与截断文件各自给出互不相同、含文件名的诊断码(第 10 条①)',
    (() => {
      const snap = { files: {} };
      for (const f of core.ALL_FILES) snap.files[f] = { raw: Buffer.from('# ' + f + '\n\n**2026-01-01 — ok** [fx:' + f + ']\nbody\n', 'utf8'), missing: false };
      snap.files['decisions.md'] = { raw: Buffer.alloc(0), missing: false };
      snap.files['lessons.md'] = { raw: Buffer.from('intro\n**2026-01-02 — cut off mid titl', 'utf8'), missing: false };
      const faults = fileFaults(snap);
      const codes = faults.map((x) => x.code);
      return codes.includes('file-empty:decisions.md') && codes.includes('file-truncated:lessons.md') &&
        codes[0] !== codes[1] && !codes.some((c) => c === 'blocking' || /^blocking/.test(c));
    })());

  // ── M2 修复自测(guards/audits/OPUS-2026-09-24-c05-wave2-review.md「M2 B4 未按 plan 对齐」)───
  // 纯函数、合成输入:不依赖真语料的任何具体 treeOid 是否恰好有已提交 plan 文件(那会随并发提交
  // 漂移,自测不能靠运气)。opts.plan 注入点直接喂一个最小合成 plan 对象。
  report('compareIndexToLegacy: 计划⑤hook-from-index-rest 覆盖的条目归 planExpected,不进 mismatched(先红:改前这类条目全落 mismatched)',
    (() => {
      const snap = { sourceOids: { treeOid: 'test-treeoid-m2' }, files: {
        'lessons.md': { missing: false, raw: Buffer.from('## Index\n- 2026-01-01 [fx:plan-a] Old REST differs from title\n### Entries\n', 'utf8') },
        'decisions.md': { missing: true },
        'standinginstructions.md': { missing: true },
      } };
      const parsed = { entries: [{ file: 'lessons.md', id: 'fx:plan-a', archived: false, dateISO: '2026-01-01', title: 'New Title', hook: null }] };
      const plan = { treeOid: 'test-treeoid-m2', edits: [{ file: 'lessons.md', kind: '⑤hook-from-index-rest', action: { tag: 'fx:plan-a' } }] };
      const withPlan = compareIndexToLegacy(snap, parsed, '2026-01-02', { plan });
      return withPlan.planExpected === 1 && withPlan.mismatched === 0 && withPlan.planOid === 'test-treeoid-m2' && withPlan.planStatus === 'injected';
    })());
  report('compareIndexToLegacy: 同一条目,没有 plan(注入显式 null)时仍归 mismatched(对照组——证明上一例的 planExpected 不是判据变松,而是精确对齐 plan)',
    (() => {
      const snap = { sourceOids: { treeOid: 'test-treeoid-m2' }, files: {
        'lessons.md': { missing: false, raw: Buffer.from('## Index\n- 2026-01-01 [fx:plan-a] Old REST differs from title\n### Entries\n', 'utf8') },
        'decisions.md': { missing: true },
        'standinginstructions.md': { missing: true },
      } };
      const parsed = { entries: [{ file: 'lessons.md', id: 'fx:plan-a', archived: false, dateISO: '2026-01-01', title: 'New Title', hook: null }] };
      const noPlan = compareIndexToLegacy(snap, parsed, '2026-01-02', { plan: null });
      return noPlan.planExpected === 0 && noPlan.mismatched === 1 && noPlan.planOid === null && noPlan.planStatus === 'injected-null';
    })());
  report('compareIndexToLegacy: 一个不在 plan ⑤类里的 mismatch(不同 tag)不受 planExpectedSet 影响,仍归 mismatched(证明匹配按 file+tag 精确对齐,不是"有 plan 就全放过")',
    (() => {
      const snap = { sourceOids: { treeOid: 'test-treeoid-m2' }, files: {
        'lessons.md': { missing: false, raw: Buffer.from('## Index\n- 2026-01-01 [fx:not-in-plan] Old REST differs from title\n### Entries\n', 'utf8') },
        'decisions.md': { missing: true },
        'standinginstructions.md': { missing: true },
      } };
      const parsed = { entries: [{ file: 'lessons.md', id: 'fx:not-in-plan', archived: false, dateISO: '2026-01-01', title: 'New Title', hook: null }] };
      const plan = { treeOid: 'test-treeoid-m2', edits: [{ file: 'lessons.md', kind: '⑤hook-from-index-rest', action: { tag: 'fx:plan-a' } }] };
      const r = compareIndexToLegacy(snap, parsed, '2026-01-02', { plan });
      return r.planExpected === 0 && r.mismatched === 1;
    })());
  report('loadPlanForTreeOid: 当前 treeOid 在 specs/ 下没有对应已提交 plan 文件时优雅退化(不抛、不假装找到),status 前缀 no-plan-for-treeOid:(spec:绝不自动重生成 plan,漂移就如实报漂移)',
    (() => { const r = loadPlanForTreeOid('does-not-exist-oid-m2-selftest'); return r.plan === null && r.status.indexOf('no-plan-for-treeOid:') === 0; })());

  // ── W4-E2 自测(主脑裁定):plan 查找改按内容键优先,治旧代码硬写死 treeOid 查找的复现路径 ─────
  // 纯函数、临时目录夹具:不写真 guards/specs(specsDir 注入),不依赖任何具体 treeOid/语料内容是否
  // 恰好在真仓库里有已提交文件(那会随并发提交漂移)。构造一个覆盖全部 core.ALL_FILES 的合成 snap,
  // 用 migrate.computeCorpusFingerprint 现算出它的真实指纹与 40-hex key,再手写一份匹配的
  // PLAN-<key>.json 落到临时 specsDir——这样断言的是"生产路径真的会算出同一把 key 并读到同一份
  // 文件",不是自我复述一遍常量。
  report('loadPlanForSnap: 内容键命中优先于 treeOid 回退(specs 目录下存在 PLAN-<corpusFingerprintKey>.json 且内部 corpusFingerprint 字段匹配),报告携带 matchedBy=content-key 与所用 key',
    (() => {
      const T = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'index-emit-plankey-hit-');
      try {
        const snap = { sourceOids: { treeOid: 'irrelevant-treeoid-should-not-be-tried-first' }, files: {} };
        for (const f of core.ALL_FILES) {
          const bytes = Buffer.from('fixture content for ' + f + '\n', 'utf8');
          snap.files[f] = { raw: bytes, rawWithBOM: bytes, missing: false };
        }
        const fp = migrate.computeCorpusFingerprint(snap);
        const key = migrate.corpusFingerprintKey(fp);
        fs.writeFileSync(path.join(T, 'PLAN-' + key + '.json'), JSON.stringify({ corpusFingerprint: fp, marker: 'w4e2-plankey-fixture', edits: [] }));
        const r = loadPlanForSnap(snap, { specsDir: T });
        return !!r.plan && r.plan.marker === 'w4e2-plankey-fixture' && r.matchedBy === 'content-key' &&
          r.key === key && r.status.indexOf('loaded-by-key:') === 0;
      } finally { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} }
    })());
  report('loadPlanForSnap: 内容键与 treeOid 命名文件在 specsDir 下均不存在时,如实退化为 no-plan(matchedBy=none),不伪造匹配、也不抛异常(对照组:证明上一例的命中不是永远返回 truthy)',
    (() => {
      const T = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'index-emit-plankey-miss-');
      try {
        const snap = { sourceOids: { treeOid: 'does-not-exist-treeoid-plankey-miss' }, files: {} };
        for (const f of core.ALL_FILES) {
          const bytes = Buffer.from('other fixture content for ' + f + '\n', 'utf8');
          snap.files[f] = { raw: bytes, rawWithBOM: bytes, missing: false };
        }
        // T 是全新空临时目录:既没有按这份 snap 算出的 key 命名的文件,也没有按 treeOid 命名的文件。
        const r = loadPlanForSnap(snap, { specsDir: T });
        return r.plan === null && r.matchedBy === 'none' && r.status.indexOf('no-plan(') === 0 &&
          r.status.indexOf('no-plan-for-key:') !== -1 && r.status.indexOf('no-plan-for-treeOid:') !== -1;
      } finally { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} }
    })());

  // ── 隔离子进程:五个故障例 + 一个 LKG 命中例 ────────────────────────────────────────────────
  function runIsolated(argsAfterFilename, tag, sameT) {
    const T = sameT || fs.mkdtempSync(require('os').tmpdir() + path.sep + 'index-emit-' + tag + '-');
    const env = iso.isoEnv(T, {});
    const caseSnap = iso.footprint.begin();
    const r = require('child_process').spawnSync(process.execPath, [__filename].concat(argsAfterFilename), { env, encoding: 'utf8', timeout: 15000 });
    const fp = iso.footprint.end(caseSnap, iso.markersFromSource(__filename, nonce, path.basename(T)));
    return { T, r, fp };
  }
  function isDegradedClean(r) {
    const out = (r.stdout || '') + (r.stderr || '');
    const isDegraded = out.indexOf('PMM-DEGRADED') !== -1;
    const isUncaughtCrash = /^\s*at\s|Error\n\s+at\s|node:internal/.test(r.stderr || '');
    return { isDegraded, isUncaughtCrash, out };
  }

  // ① core throw:隔离 HOME 下没有 git 仓库,默认(无 --dir)HEAD 视图快照必然 PmmCoreError。
  {
    const { r, fp, T } = runIsolated([], 'core-throw');
    const d = isDegradedClean(r);
    report('①core-throw:隔离子进程 rc 非 0 且输出 PMM-DEGRADED(非未捕获堆栈)',
      r.status !== 0 && d.isDegraded && !d.isUncaughtCrash, { status: r.status, out: d.out.slice(0, 300) });
    report('①core-throw:诊断码含 core-throw', d.out.indexOf('PMM-DEGRADED core-throw') !== -1, d.out.slice(0, 200));
    report('①core-throw:真根本次调用零足迹', !fp.red, fp.line);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  }

  // ② 空快照:--dir 指向一个完全空的目录(7 个文件全缺)。
  {
    const T = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'index-emit-empty-snap-src-');
    const emptyDir = T + path.sep + 'empty-corpus';
    fs.mkdirSync(emptyDir, { recursive: true });
    const { r, fp, T: T2 } = runIsolated(['--dir', emptyDir], 'empty-snapshot');
    const d = isDegradedClean(r);
    report('②空快照:隔离子进程 rc 非 0 且输出 PMM-DEGRADED empty-snapshot(非未捕获堆栈)',
      r.status !== 0 && d.isDegraded && !d.isUncaughtCrash && d.out.indexOf('PMM-DEGRADED empty-snapshot') !== -1,
      { status: r.status, out: d.out.slice(0, 300) });
    report('②空快照:真根本次调用零足迹', !fp.red, fp.line);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(T2, { recursive: true, force: true }); } catch {}
  }

  // ③ 缺文件:--dir 指向一个复制自 corpus-whole 但拿掉一个文件(classes.md)的目录。
  {
    const T = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'index-emit-missing-src-');
    const partialDir = T + path.sep + 'partial-corpus';
    fs.mkdirSync(partialDir, { recursive: true });
    for (const f of core.ALL_FILES) {
      if (f === 'classes.md') continue;
      fs.copyFileSync(path.join(CORPUS_WHOLE, f), path.join(partialDir, f));
    }
    const { r, fp, T: T2 } = runIsolated(['--dir', partialDir], 'missing-file');
    const d = isDegradedClean(r);
    report('③缺文件:隔离子进程 rc 非 0 且输出 PMM-DEGRADED missing-file:classes.md',
      r.status !== 0 && d.isDegraded && !d.isUncaughtCrash && d.out.indexOf('missing-file:classes.md') !== -1,
      { status: r.status, out: d.out.slice(0, 300) });
    report('③缺文件:真根本次调用零足迹', !fp.red, fp.line);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(T2, { recursive: true, force: true }); } catch {}
  }

  // ④ 0 字节文件:--dir 指向仓库里新落的 faults/index-emit-file-empty 夹具。
  let emptyFileCode = null;
  {
    const { r, fp, T } = runIsolated(['--dir', FAULT_EMPTY], 'file-empty');
    const d = isDegradedClean(r);
    report('④0 字节文件:隔离子进程 rc 非 0 且输出 PMM-DEGRADED file-empty:decisions.md(专属诊断,非 blocking)',
      r.status !== 0 && d.isDegraded && !d.isUncaughtCrash && d.out.indexOf('file-empty:decisions.md') !== -1 && d.out.indexOf('PMM-DEGRADED blocking') === -1,
      { status: r.status, out: d.out.slice(0, 300) });
    report('④0 字节文件:真根本次调用零足迹', !fp.red, fp.line);
    const m = /PMM-DEGRADED (\S+)/.exec(d.out);
    emptyFileCode = m && m[1];
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  }

  // ⑤ 截断文件:--dir 指向仓库里新落的 faults/index-emit-file-truncated 夹具。
  let truncFileCode = null;
  {
    const { r, fp, T } = runIsolated(['--dir', FAULT_TRUNC], 'file-truncated');
    const d = isDegradedClean(r);
    report('⑤截断文件:隔离子进程 rc 非 0 且输出 PMM-DEGRADED file-truncated:lessons.md(专属诊断,非 blocking)',
      r.status !== 0 && d.isDegraded && !d.isUncaughtCrash && d.out.indexOf('file-truncated:lessons.md') !== -1 && d.out.indexOf('PMM-DEGRADED blocking') === -1,
      { status: r.status, out: d.out.slice(0, 300) });
    report('⑤截断文件:真根本次调用零足迹', !fp.red, fp.line);
    const m = /PMM-DEGRADED (\S+)/.exec(d.out);
    truncFileCode = m && m[1];
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  }
  report('④⑤:0 字节 与 截断 两例的诊断码互不相同(第 10 条①硬性要求)',
    !!emptyFileCode && !!truncFileCode && emptyFileCode !== truncFileCode, { emptyFileCode, truncFileCode });

  // ⑥ LKG 命中路径:同一个隔离 HOME(同一个 T,故意不新建)对同一个 --dir 跑两次,第二次必须命中
  //    第一次写下的 LKG(sourceOids 相同 -> key 相同 -> 文件已存在)。
  {
    const T = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'index-emit-lkg-hit-');
    const fpSnapLocal = iso.footprint.begin();
    const run1 = runIsolated(['--dir', CORPUS_WHOLE], 'lkg-1', T);
    const run2 = runIsolated(['--dir', CORPUS_WHOLE], 'lkg-2', T);
    const fpLocal = iso.footprint.end(fpSnapLocal, iso.markersFromSource(__filename, nonce, path.basename(T)));
    let j1 = null, j2 = null;
    try { j1 = JSON.parse(/PMM-INDEX-EMIT (\{.*\})/.exec(run1.r.stdout || '')[1]); } catch {}
    try { j2 = JSON.parse(/PMM-INDEX-EMIT (\{.*\})/.exec(run2.r.stdout || '')[1]); } catch {}
    report('⑥LKG:两次运行都 rc 0(成功路径,非故障)', run1.r.status === 0 && run2.r.status === 0, { s1: run1.r.status, s2: run2.r.status });
    report('⑥LKG:两次运行 lkgKey 相同(同一 sourceOids+schemaVersion)', !!j1 && !!j2 && j1.lkgKey === j2.lkgKey, { k1: j1 && j1.lkgKey, k2: j2 && j2.lkgKey });
    report('⑥LKG:第一次运行 lkgHit=false(还没有缓存)', !!j1 && j1.lkgHit === false, j1);
    report('⑥LKG:第二次运行 lkgHit=true(命中第一次写下的缓存,sha 相同)', !!j2 && j2.lkgHit === true, j2);
    report('⑥LKG:真根零足迹', !fpLocal.red, fpLocal.line);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  }

  // ⑥b M3 修复自测(guards/audits/OPUS-2026-09-24-c05-wave2-review.md「M3 LKG 兜底与 FINAL-SPEC §4
  //    冲突」):「key 不命中不得用旧 LKG」。同一个隔离 HOME(同一个 T,LKG_DIR 因此共享)下:①先对
  //    corpus-whole 跑一次成功路径,写下一份真 LKG(key = sourceOids_A);②再对一个不同 --dir(0 字节
  //    文件夹具,sourceOids 必然不同 => key_B != key_A,key 必然不命中)跑一次,断言输出**不含**
  //    LKG-FALLBACK 行(旧版会退到 lkg-latest: 把第①步那份不相关的缓存端出来当兜底;B5 夹具
  //    stale-lkg-old-file-served 钉的就是这个旧行为——修复前跑这个断言必红,修复后必绿)。
  {
    const T = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'index-emit-lkg-no-stale-');
    const fpSnapLocal = iso.footprint.begin();
    const primeRun = runIsolated(['--dir', CORPUS_WHOLE], 'lkg-nostale-prime', T);
    const degradeRun = runIsolated(['--dir', FAULT_EMPTY], 'lkg-nostale-degrade', T);
    const fpLocal = iso.footprint.end(fpSnapLocal, iso.markersFromSource(__filename, nonce, path.basename(T)));
    const dPrime = isDegradedClean(primeRun.r);
    const dDegrade = isDegradedClean(degradeRun.r);
    report('⑥b prime:对 corpus-whole 的第一次运行 rc 0、成功写下一份真 LKG(非故障路径)', primeRun.r.status === 0 && !dPrime.isDegraded, { status: primeRun.r.status, out: dPrime.out.slice(0, 200) });
    report('⑥b degrade:对不同 --dir(0 字节文件夹具,sourceOids 必然不同)跑,rc 非 0 且是 PMM-DEGRADED file-empty:decisions.md(key 必然不命中,不是别的故障码)',
      degradeRun.r.status !== 0 && dDegrade.isDegraded && !dDegrade.isUncaughtCrash && dDegrade.out.indexOf('file-empty:decisions.md') !== -1,
      { status: degradeRun.r.status, out: dDegrade.out.slice(0, 300) });
    report('⑥b key 不命中不得用旧 LKG:degrade 输出不含 LKG-FALLBACK(FINAL-SPEC §4「LKG 只在 key 命中才用」;旧版 mtime 兜底会在这里把 prime 那份不相关缓存当 lkg-latest 端出来)',
      dDegrade.out.indexOf('LKG-FALLBACK') === -1, dDegrade.out.slice(0, 300));
    let degradeIndexFileBody = '';
    try { degradeIndexFileBody = fs.readFileSync(T + '/.claude/.shadow/index-' + MACH + '.txt', 'utf8'); } catch {}
    report('⑥b degrade 落盘的诊断文件走标题末路(no LKG available),不是拿 prime 那份不相关内容顶替',
      degradeIndexFileBody.indexOf('no LKG available') !== -1 && degradeIndexFileBody.indexOf('fallback source') === -1,
      degradeIndexFileBody.slice(0, 200));
    report('⑥b 真根零足迹', !fpLocal.red, fpLocal.line);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  }

  // ⑦(报告用,非 pass/fail 判据):隔离写 + 真根只读,对真实 HEAD 语料算一次"与 HEAD 三处 Index
  //    的归一化 diff",数字进最终回报。真根只读靠 PMM_GIT_HOME(core.homeDir() 的读入口)+
  //    PMM_MEM_DIR(worktree 视图会用到,这里默认 HEAD 视图不依赖它,一并给上只为对称)指向
  //    iso.realHome(),写路径(HOME/USERPROFILE/PMM_HOME -> resolveHome())仍然是隔离 T,两者互不
  //    干扰(pmm-core.cjs:171-177 的分离设计原文)。绝不在真根写 .shadow/.pmm-index-lkg——本用例
  //    的 HOME 全程是隔离 T,真根只经 git 只读命令(rev-parse/show)触达。
  let realCompareSummary = null;
  {
    const T = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'index-emit-real-head-');
    const realHome = iso.realHome();
    // 隔离 HOME 下没有 ~/.gitconfig,git 2.35+ 的 safe.directory 会以"当前用户不是真根目录的
    // owner"（本机曾用 SYSTEM 账户碰过该目录）为由拒绝只读的 rev-parse/show——用 GIT_CONFIG_COUNT/
    // KEY_0/VALUE_0(git 2.31+ 支持,不依赖 HOME/.gitconfig 文件)临时信任它,只影响这一个只读子
    // 进程,不写任何全局 git 配置、不影响其它并发会话。
    const env = iso.isoEnv(T, {
      PMM_GIT_HOME: realHome, PMM_MEM_DIR: realHome + '/.claude/memory',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*',
    });
    const caseSnap = iso.footprint.begin();
    const r = require('child_process').spawnSync(process.execPath, [__filename], { env, encoding: 'utf8', timeout: 20000 });
    const fp = iso.footprint.end(caseSnap, iso.markersFromSource(__filename, nonce, path.basename(T)));
    let j = null;
    try { j = JSON.parse(/PMM-INDEX-EMIT (\{.*\})/.exec(r.stdout || '')[1]); } catch {}
    report('⑦真实 HEAD 语料(隔离写/真根只读):子进程 rc 0', r.status === 0, { status: r.status, stderr: (r.stderr || '').slice(0, 300) });
    report('⑦真实 HEAD 语料:输出携带 view=HEAD 与非空 treeOid(证明真的读到了真根 git 历史,不是空快照侥幸绿)',
      !!j && j.view === 'HEAD' && j.sourceOids && !!j.sourceOids.treeOid, j && j.sourceOids);
    report('⑦真实 HEAD 语料:真根本次调用零足迹(只读未写)', !fp.red, fp.line);
    if (j) realCompareSummary = { sourceOids: j.sourceOids, compare: j.compare };
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  }
  if (realCompareSummary) console.log('REAL-HEAD-COMPARE ' + JSON.stringify(realCompareSummary));

  const fp = iso.footprint.end(fpSnap, iso.markersFromSource(__filename, nonce, ''));
  report('footprint: 本自测对真根零可归因改动', !fp.red, fp.line);

  console.log('SELFTEST-INDEX-EMIT {"pass":' + pass + ',"fail":' + fail + '}');
  process.exitCode = fail > 0 ? 1 : 0;
  return { pass, fail, details };
}
// SELFTEST-END

// ── CLI 入口 ─────────────────────────────────────────────────────────────────────────────────────
function mainCli(argv) {
  const args = argv.slice(2).filter((a) => a !== '--shadow'); // --shadow 是本工具唯一模式,接受但不改变行为
  if (args.includes('--self-test') || args.includes('--self-check')) { selfTest(); return; }
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx !== -1 ? args[dirIdx + 1] : null;
  const asOfIdx = args.indexOf('--as-of');
  const asOf = asOfIdx !== -1 ? args[asOfIdx + 1] : core.today();
  const opts = { asOf };
  if (dir) opts.snapshotFn = () => core.snapshotDir(dir, { requireAll: false });
  runEmit(opts);
}

module.exports = {
  runEmit, degraded, detectTruncation, fileFaults, lkgKeyFor, compareIndexToLegacy, selfTest,
  // M2 修复(guards/audits/OPUS-2026-09-24-c05-wave2-review.md):导出供自测直接调用,以及给未来
  // 想复算「当前 treeOid 是否有已提交 plan」的只读工具复用(镜像 lkgKeyFor 等既有导出的惯例)。
  loadPlanForTreeOid, planExpectedSetFrom,
  // W4-E2(主脑裁定):新主查找路径 + 编排层,导出理由与上面 loadPlanForTreeOid 同款——供自测直接
  // 调用,也给未来想复算「当前语料内容指纹是否有已提交 plan」的只读工具复用。
  loadPlanForKey, loadPlanForSnap,
};

if (require.main === module) mainCli(process.argv);
