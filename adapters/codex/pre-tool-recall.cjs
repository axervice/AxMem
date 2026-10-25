'use strict';
// Minimal Codex apply_patch adapter; not a general patch or shell parser.
// Wire reference: https://learn.chatgpt.com/docs/hooks (2026-10-23).
// Scope is supplied/pinned by the trusted hook command, never by prompt/cwd inference.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {recall}=require('./recall-selector.cjs');
const {renderActionHookOutput,readStdinLimited,isAbsoluteMemoryRoot,SELECTOR_LIMIT,SELECTOR_MAX_CHARS}=require('./recall-context.cjs');
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(v));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const contained=(root,p)=>{const r=path.relative(root,p);return !r||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));};
const fail=(reason)=>({status:'unavailable',reason,output:{systemMessage:'AxMem PreToolUse unavailable: '+reason}});
function actionFromHook(input,scope){
  if(!plain(input)||input.hook_event_name!=='PreToolUse'||input.tool_name!=='apply_patch')
    return {status:'unsupported',reason:'unsupported-event-or-tool',output:{}};
  if(!plain(scope)||scope.schemaVersion!==1||typeof scope.repo!=='string'||
    !/^[a-z0-9-]{1,80}$/.test(scope.repo)||typeof scope.repoRoot!=='string'||
    !path.isAbsolute(scope.repoRoot)||typeof scope.taskSpecSha256!=='string'||
    !/^[a-f0-9]{64}$/.test(scope.taskSpecSha256))return fail('missing-source-scope');
  const root=path.resolve(scope.repoRoot);
  try {
    if(path.relative(root,fs.realpathSync(root))!=='')return fail('scope-root-is-link');
    // cwd validates an explicit binding; it never selects the repo label.
    if(typeof input.cwd!=='string'||!path.isAbsolute(input.cwd)||
      path.relative(root,fs.realpathSync(input.cwd))!=='')return fail('scope-cwd-mismatch');
  }catch{return fail('scope-root-unavailable');}
  const command=plain(input.tool_input)?input.tool_input.command:null;
  if(typeof command!=='string'||Buffer.byteLength(command,'utf8')>32768||/\0/.test(command))return fail('invalid-patch-input');
  const lines=command.replace(/\r\n/g,'\n').split('\n');
  while(lines.at(-1)==='')lines.pop();
  if(lines[0]!=='*** Begin Patch'||lines.at(-1)!=='*** End Patch')return fail('unsupported-patch-envelope');
  const headers=lines.filter(l=>/^\*\*\* (?:Update File|Add File|Delete File|Move to):/.test(l));
  if(headers.length!==1||lines.some(l=>l.startsWith('*** Move to:')))return fail('unsupported-multi-file-or-move');
  const m=/^\*\*\* (Update File|Add File): (.+)$/.exec(headers[0]);
  if(!m||lines[1]!==headers[0])return fail('unsupported-file-operation');
  const file=m[2];
  if(file.trim()!==file||/[\u0000-\u001f\u007f]/.test(file)||
    file.replace(/\\/g,'/').split('/').some(v=>v==='..'||v==='.'))return fail('invalid-file-path');
  const absolute=path.resolve(root,file);
  if(!contained(root,absolute)||absolute===root)return fail('path-outside-scope');
  try {
    let ancestor=absolute;
    while(!fs.existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)return fail('missing-path-anchor');ancestor=parent;}
    if(!contained(root,fs.realpathSync(ancestor)))return fail('path-link-outside-scope');
  }catch{return fail('path-source-unavailable');}
  const relative=path.relative(root,absolute).split(path.sep).join('/');
  if(!relative||/[\\:*?]/.test(relative))return fail('invalid-selector-path');
  return {status:'ok',action:{tool:m[1]==='Add File'?'Write':'Edit',repo:scope.repo,path:relative}};
}
async function runPreToolUse(input,options={}){
  const mapped=actionFromHook(input,options.sourceScope);
  if(mapped.status!=='ok')return mapped;
  if(!isAbsoluteMemoryRoot(options.memoryRoot))return fail('invalid-memory-root');
  const selector=options.selector||recall;
  let result;
  try{result=await selector({memoryRoot:options.memoryRoot,query:'',actionContext:mapped.action,limit:SELECTOR_LIMIT,maxChars:SELECTOR_MAX_CHARS});}
  catch{return fail('selector-failed');}
  const output=renderActionHookOutput(result,options.memoryRoot);
  if(result.status==='no-match'&&result.receipt?.counts?.matched===0&&output.hookSpecificOutput)
    return {status:'no-match',reason:result.reason,action:mapped.action,receipt:result.receipt,output:{}};
  return {status:output.hookSpecificOutput?result.status:'unavailable',reason:result.reason,
    action:mapped.action,receipt:result.receipt,output};
}
async function main(){
  const a=process.argv.slice(2);
  if(a.length!==6||a[0]!=='--memory-root'||a[2]!=='--scope-file'||a[4]!=='--scope-sha256'||
    !path.isAbsolute(a[3])||!/^[a-f0-9]{64}$/.test(a[5]))throw Error('invalid-args');
  const stat=fs.lstatSync(a[3]);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)throw Error('invalid-scope-file');
  const bytes=fs.readFileSync(a[3]);
  if(sha(bytes)!==a[5])throw Error('scope-sha-mismatch');
  const stdin=await readStdinLimited(process.stdin);
  if(!stdin.ok)throw Error(stdin.code);
  const result=await runPreToolUse(JSON.parse(stdin.text),{memoryRoot:a[1],sourceScope:JSON.parse(bytes.toString('utf8'))});
  process.stdout.write(JSON.stringify(result.output));
}
if(require.main===module)main().catch(()=>{process.stderr.write('pre-tool-recall: unavailable\n');process.stdout.write('{}');process.exitCode=1;});
module.exports={actionFromHook,runPreToolUse};
