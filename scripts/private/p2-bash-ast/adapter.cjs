'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { TextDecoder } = require('util');

const PROTOCOL = 'axmem-p2-bash-ast/v1';
const PARSER = 'mvdan.cc/sh/v3@v3.13.1';
const EXE_REL = 'bin/p2-bash-ast.exe';
const EXPECTED = Object.freeze({
  executableSha256: 'ce8b9c1e72511e1347b927387108ce0f57ac52acd92404c2c67d32c9882693e6',
  sourceSha256: '821288387088c543dad09bebfaa4025c538f084ddaa755c1c02abae5ebc740f1',
  goModSha256: 'f1491f323bb58aee1a88eabb74b1e90db331ae1108f98984025be3bef16f84ee',
  goSumSha256: 'c6cfc2b595a285388027e0b1626224a068adb37518bab024f7946e1bc6130987',
});
const LIMITS = Object.freeze({ source: 1 << 20, wallMs: 2000, stdout: 4 << 20, stderr: 64 << 10 });
const ROOT = __dirname;
const EXE = path.join(ROOT, ...EXE_REL.split('/'));
const LOCK = path.join(ROOT, 'helper.lock.json');

class BashAstError extends Error {
  constructor(code, message) { super(message || code); this.name = 'BashAstError'; this.code = code; }
}
function hard(code, detail) { throw new BashAstError(code, detail); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function int(x) { return Number.isSafeInteger(x); }
function exactKeys(o, keys) {
  return isObj(o) && JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());
}
function spanOK(s, n) {
  return exactKeys(s, ['start','end']) && int(s.start) && int(s.end) && s.start >= 0 && s.start <= s.end && s.end <= n;
}
function fatalUtf8(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { hard('generated-parser-output-encoding', 'parser stdout is not strict UTF-8'); }
}
function readLock() {
  if (!fs.existsSync(LOCK)) hard('generated-parser-lock-missing', 'private parser lock file is missing');
  let lock;
  try { lock = JSON.parse(fs.readFileSync(LOCK, 'utf8')); }
  catch { hard('generated-parser-lock-invalid', 'private parser lock file is invalid JSON'); }
  const keys = ['schema','protocol','parser','goToolchain','executable','executableSha256','sourceSha256','goModSha256','goSumSha256','build'];
  if (!exactKeys(lock, keys) || lock.schema !== 'axmem-p2-bash-ast-lock/v1' || lock.protocol !== PROTOCOL ||
      lock.parser !== PARSER || lock.executable !== EXE_REL || !Array.isArray(lock.build)) {
    hard('generated-parser-lock-invalid', 'private parser lock metadata mismatch');
  }
  for (const k of Object.keys(EXPECTED)) {
    if (lock[k] !== EXPECTED[k]) hard('generated-parser-lock-invalid', 'private parser lock ' + k + ' mismatch');
  }
  return lock;
}
function assertPrivateHelper() {
  readLock();
  if (!fs.existsSync(EXE)) hard('generated-parser-helper-missing', 'private parser helper is absent at fixed path ' + EXE_REL);
  const st = fs.statSync(EXE);
  if (!st.isFile()) hard('generated-parser-helper-missing', 'private parser helper fixed path is not a file');
  const got = sha256(fs.readFileSync(EXE));
  if (got !== EXPECTED.executableSha256) hard('generated-parser-helper-hash', 'private parser helper sha256 mismatch');
}
function parseJson(buf) {
  const text = fatalUtf8(buf);
  try { return JSON.parse(text); }
  catch { hard('generated-parser-output-json', 'private parser stdout is not exactly one JSON document'); }
}
function validateHdoc(h, input) {
  if (!exactKeys(h, ['op','marker','word','body','closing','bodyBytes']) ||
      h.op !== '<<' || typeof h.marker !== 'string' || !h.marker ||
      !spanOK(h.word,input.length) || !spanOK(h.body,input.length) || !spanOK(h.closing,input.length) ||
      !int(h.bodyBytes) || h.bodyBytes <= 0 || h.bodyBytes !== h.body.end - h.body.start ||
      h.body.end !== h.closing.start) hard('generated-parser-schema', 'invalid heredoc record');
  const word = fatalUtf8(input.subarray(h.word.start,h.word.end));
  const closing = fatalUtf8(input.subarray(h.closing.start,h.closing.end));
  if (word !== "'" + h.marker + "'" || closing !== h.marker) hard('generated-parser-source-binding', 'heredoc marker span mismatch');
  if (input.subarray(h.body.start,h.body.end).includes(13)) hard('generated-parser-schema', 'CR heredoc is unsupported');
}
function validateCall(c, input) {
  const keys=['start','end','command','commandValue','firstArgPresent','firstArg','firstArgSource','exactQuotedParam','paramName'];
  if (!exactKeys(c,keys) || !int(c.start) || !int(c.end) || c.start<0 || c.start>c.end || c.end>input.length ||
      !spanOK(c.command,input.length) || c.command.start<c.start || c.command.end>c.end ||
      c.commandValue!=='node' || typeof c.firstArgPresent!=='boolean' || typeof c.firstArgSource!=='string' ||
      typeof c.exactQuotedParam!=='boolean' || typeof c.paramName!=='string' || !spanOK(c.firstArg,input.length)) {
    hard('generated-parser-schema','invalid call record');
  }
  if (!c.firstArgPresent) {
    if (c.firstArg.start!==0 || c.firstArg.end!==0 || c.firstArgSource!=='' || c.exactQuotedParam || c.paramName!=='') {
      hard('generated-parser-schema','invalid absent first arg');
    }
    return;
  }
  if (c.firstArg.start<c.start || c.firstArg.end>c.end) hard('generated-parser-schema','call first arg outside call span');
  const raw=fatalUtf8(input.subarray(c.firstArg.start,c.firstArg.end));
  if (raw!==c.firstArgSource) hard('generated-parser-source-binding','call first arg source mismatch');
  const m=/^"\$([A-Za-z_][A-Za-z0-9_]*)"$/.exec(raw);
  if (c.exactQuotedParam!==!!m || (m ? c.paramName!==m[1] : c.paramName!=='')) hard('generated-parser-schema','call target flags mismatch');
}
function validateUnsupported(u,input) {
  if (!exactKeys(u,['start','end','source','reason']) || !int(u.start) || !int(u.end) || u.start<0 || u.start>=u.end || u.end>input.length ||
      typeof u.source!=='string' || u.reason!=='dynamic-or-unsupported-word') hard('generated-parser-schema','invalid unsupported command');
  if (fatalUtf8(input.subarray(u.start,u.end))!==u.source) hard('generated-parser-source-binding','unsupported command source mismatch');
}
function validateRedir(r,input) {
  if (!exactKeys(r,['op','fd','word','wordSource','exactQuotedParam','paramName','hdoc']) ||
      typeof r.op!=='string' || typeof r.fd!=='string' || !spanOK(r.word,input.length) || typeof r.wordSource!=='string' ||
      typeof r.exactQuotedParam!=='boolean' || typeof r.paramName!=='string') hard('generated-parser-schema','invalid redirection record');
  const raw=fatalUtf8(input.subarray(r.word.start,r.word.end));
  if (raw!==r.wordSource) hard('generated-parser-source-binding','redirection word source mismatch');
  const m=/^"\$([A-Za-z_][A-Za-z0-9_]*)"$/.exec(raw);
  if (r.exactQuotedParam!==!!m || (m ? r.paramName!==m[1] : r.paramName!=='')) hard('generated-parser-schema','redirection target flags mismatch');
  if (r.hdoc===null) return;
  if (!isObj(r.hdoc)) hard('generated-parser-schema','redirection hdoc must be null or object');
  validateHdoc(r.hdoc,input);
  if (r.op!=='<<') hard('generated-parser-schema','heredoc attached to non-heredoc redirection');
}
function validateStmt(s,input) {
  const keys=['start','end','simpleCall','command','commandStatic','commandValue','argCount','assignCount','redirs'];
  if (!exactKeys(s,keys) || !int(s.start) || !int(s.end) || s.start<0 || s.start>s.end || s.end>input.length ||
      typeof s.simpleCall!=='boolean' || !spanOK(s.command,input.length) || typeof s.commandStatic!=='boolean' ||
      typeof s.commandValue!=='string' || !int(s.argCount) || s.argCount<0 || !int(s.assignCount) || s.assignCount<0 ||
      !Array.isArray(s.redirs) || s.redirs.length>64) hard('generated-parser-schema','invalid heredoc statement');
  if (!s.simpleCall) {
    if (s.command.start!==0 || s.command.end!==0 || s.commandStatic || s.commandValue!=='' || s.argCount!==0 || s.assignCount!==0) {
      hard('generated-parser-schema','invalid non-simple heredoc statement');
    }
  } else {
    if (s.command.end<=s.command.start || s.command.start<s.start || s.command.end>s.end) hard('generated-parser-schema','command span outside statement');
    if (!s.commandStatic && s.commandValue!=='') hard('generated-parser-schema','dynamic statement command has value');
  }
  for (const r of s.redirs) {
    validateRedir(r,input);
    if (r.word.start<s.start || r.word.end>s.end) hard('generated-parser-schema','redirection outside statement');
  }
  if (!s.redirs.some(r=>r.hdoc!==null)) hard('generated-parser-schema','heredoc statement has no heredoc');
}
function validateDoc(d,input) {
  const keys=['ok','protocol','parser','sourceBytes','sourceSha256','calls','unsupportedCommands','heredocs','heredocStatements','stats'];
  if (!exactKeys(d,keys) || d.ok!==true || d.protocol!==PROTOCOL || d.parser!==PARSER ||
      !int(d.sourceBytes) || d.sourceBytes!==input.length || typeof d.sourceSha256!=='string' ||
      d.sourceSha256!==sha256(input) || !Array.isArray(d.calls) || !Array.isArray(d.unsupportedCommands) ||
      !Array.isArray(d.heredocs) || !Array.isArray(d.heredocStatements) ||
      !exactKeys(d.stats,['nodes','maxDepth']) || !int(d.stats.nodes) || !int(d.stats.maxDepth) ||
      d.stats.nodes<0 || d.stats.nodes>200000 || d.stats.maxDepth<0 || d.stats.maxDepth>256 ||
      d.calls.length>200000 || d.unsupportedCommands.length>200000 || d.heredocs.length>200000 || d.heredocStatements.length>200000) {
    hard('generated-parser-schema','invalid parser success schema');
  }
  for (const c of d.calls) validateCall(c,input);
  for (const u of d.unsupportedCommands) validateUnsupported(u,input);
  for (const h of d.heredocs) validateHdoc(h,input);
  for (const s of d.heredocStatements) validateStmt(s,input);
  return d;
}
function parseShellAst(source) {
  const input=Buffer.isBuffer(source)?source:Buffer.from(source||'');
  if (input.length>LIMITS.source) hard('generated-parser-source-limit','generator source exceeds 1 MiB');
  assertPrivateHelper();
  const r=cp.spawnSync(EXE,[],{
    input,encoding:null,windowsHide:true,timeout:LIMITS.wallMs,maxBuffer:LIMITS.stdout+1,
    stdio:['pipe','pipe','pipe'],
  });
  if (r.error) {
    if (r.error.code==='ETIMEDOUT') hard('generated-parser-timeout','private parser exceeded 2000ms');
    if (r.error.code==='ENOBUFS') hard('generated-parser-output-limit','private parser stdout exceeded limit');
    hard('generated-parser-spawn','private parser failed to start: '+r.error.message);
  }
  const out=Buffer.isBuffer(r.stdout)?r.stdout:Buffer.alloc(0);
  const err=Buffer.isBuffer(r.stderr)?r.stderr:Buffer.alloc(0);
  if (out.length>LIMITS.stdout || err.length>LIMITS.stderr) hard('generated-parser-output-limit','private parser output exceeded limit');
  if (r.status!==0 || r.signal) {
    let doc=null; try{doc=parseJson(out);}catch{}
    const code=doc && typeof doc.error==='string' ? doc.error : 'generated-parser-exit';
    const detail=doc && typeof doc.detail==='string' ? doc.detail : fatalUtf8(err);
    hard(code,detail||'private parser exited nonzero');
  }
  return validateDoc(parseJson(out),input);
}
function hasNoUnsupportedCommandWords(doc) {
  return !!doc && Array.isArray(doc.unsupportedCommands) && doc.unsupportedCommands.length===0;
}
module.exports={BashAstError,parseShellAst,validateDoc,hasNoUnsupportedCommandWords,PROTOCOL,PARSER,EXE_REL};