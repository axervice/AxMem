'use strict';
// S1 F1 isolated candidate: synthetic PMM, source-shaped hook events, no native/provider calls.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto'),cp=require('node:child_process');
const {Readable}=require('node:stream');
const {run,nativeRootEnvelope}=require('./action-receipt-opt-in.cjs');
const {runPreToolUse}=require('./pre-tool-recall.cjs');
const {recall}=require('./recall-selector.cjs');
const W=path.resolve(__dirname,'../..');
const CLI=path.join(__dirname,'action-receipt-opt-in.cjs');
const paths=[
 'adapters/codex/action-receipt-gate.cjs',
 'adapters/codex/action-receipt-state.cjs',
 'adapters/codex/action-receipt-opt-in.cjs',
 'adapters/codex/pre-tool-recall.cjs',
 'adapters/codex/recall-context.cjs',
 'adapters/codex/recall-selector.cjs',
 'core/memory-source.cjs',
 'guards/pmm-core.cjs','guards/pmm-trigger-glob.cjs',
 'guards/pmm-trigger-recall.cjs','guards/pmm-recall-ledger.cjs',
 'guards/pmm-recall-policy.cjs','guards/vendor/minisearch/index.cjs',
 'guards/vendor/path-is-inside.cjs',
].sort();
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const fileSha=f=>sha(fs.readFileSync(f));
const checks=[],start=process.hrtime.bigint();
let serial=0,childCalls=0,childRC=null,childMs=null;
let temp=null,alias=null;
async function test(id,fn){
 try{await fn();checks.push({id,ok:true});}
 catch(e){checks.push({id,ok:false,errorClass:e&&e.name||'Unknown',error:String(e?.message||'').slice(0,1000)});}
}
function expectCode(result,code){
 assert.equal(result.code,code);
 assert.equal(result.output.hookSpecificOutput.permissionDecision,'deny');
}
function stateCount(state){return fs.readdirSync(state).length;}
function event(repo,command){
 return {hook_event_name:'PreToolUse',tool_name:'apply_patch',cwd:repo,
  session_id:'f1-synthetic-session',turn_id:'f1-synthetic-turn',
  tool_use_id:'syn-call-'+String(++serial),tool_input:{command},
  policy:{enabled:true,mode:'scoped-native-validation',route:'SPOOFED_FROM_JSON'}};
}
async function invoke(args,input){
 return run(args,Readable.from([Buffer.from(JSON.stringify(input),'utf8')]));
}
function protocol(output){
 const ctx=output?.hookSpecificOutput?.additionalContext;
 const begin='AXMEM_ACK_PROTOCOL_V1_BEGIN\nnativeTool=apply_patch\nnativeDecision=deny\nCONTROL_PATCH_BEGIN\n';
 const end='\nCONTROL_PATCH_END\nAXMEM_ACK_PROTOCOL_V1_END';
 assert(typeof ctx==='string'&&ctx.endsWith(end));
 const at=ctx.lastIndexOf(begin);assert(at>=0);
 const control=ctx.slice(at+begin.length,-end.length);
 assert(control.startsWith('*** Begin Patch\n*** Add File: '));
 assert(control.endsWith('*** End Patch'));
 assert(/^\+challenge=[a-f0-9]{64}$/m.test(control));
 return control;
}
async function main(){
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'axmem-s1-f1-synthetic-'));
 const repo=path.join(temp,'repo'),memory=path.join(temp,'synthetic-memory');
 const validationRoot=path.join(temp,'validation-root'),state=path.join(validationRoot,'state');
 const patch='*** Begin Patch\n*** Update File: src/one.ts\n@@\n-old\n+new\n*** End Patch';
 const other='*** Begin Patch\n*** Update File: src/other.ts\n@@\n-old\n+new\n*** End Patch';
 fs.mkdirSync(path.join(repo,'src'),{recursive:true});
 fs.writeFileSync(path.join(repo,'src','one.ts'),'old');
 fs.writeFileSync(path.join(repo,'src','other.ts'),'old');
 fs.mkdirSync(memory);
 const entry='**2026-01-01 — syn:action** [syn:action] [trust:observed]\n'+
   'Synthetic reviewed sentence.\n'+
   '<!-- trigger: tool=Edit|Write; repo=atlas; path=src/one.ts -->\n';
 fs.writeFileSync(path.join(memory,'decisions.md'),
   '## Index\n- 2026-01-01 Rule [syn:action]\n\n## Entries\n'+entry);
 for(const n of ['lessons.md','standinginstructions.md'])
   fs.writeFileSync(path.join(memory,n),'## Index\n\n## Entries\n');
 const scope={schemaVersion:1,repo:'atlas',repoRoot:repo,taskSpecSha256:'a'.repeat(64)};
 const scopeFile=path.join(temp,'scope.json');
 fs.writeFileSync(scopeFile,JSON.stringify(scope));
 const scopeHash=fileSha(scopeFile);
 const manifest={schemaVersion:1,files:paths.map(rel=>{
  const buf=fs.readFileSync(path.join(W,rel));
  return {path:rel,bytes:buf.length,sha256:sha(buf)};
 })};
 const manifestFile=path.join(temp,'manifest.json');
 fs.writeFileSync(manifestFile,JSON.stringify(manifest));
 const manifestSha=fileSha(manifestFile);
 const policy={schemaVersion:1,enabled:true,validationOnly:true,
  route:'ROOT_NATIVE_HOOK_CONTRACT_V1',nativeSourceVersion:'rust-v0.160.0',
  declaredCodeMode:false,hostBindingMode:'REGISTERED_NATIVE_ROOT_EVENT',
  validationRoot,allowedTarget:'src/one.ts',scopeSha256:scopeHash,
  memoryRoot:memory,stateDir:state};
 const policyFile=path.join(temp,'policy.json');
 fs.writeFileSync(policyFile,JSON.stringify(policy));
 const policySha=fileSha(policyFile);
 const disabledFile=path.join(temp,'disabled-policy.json');
 fs.writeFileSync(disabledFile,JSON.stringify({schemaVersion:1,enabled:false}));
 const baseArgs=(mode,manifestPath=manifestFile,manifestHash=manifestSha)=>
  ['--base-root',W,'--base-manifest-file',manifestPath,
   '--base-manifest-sha256',manifestHash,'--scope-file',scopeFile,
   '--scope-sha256',scopeHash,'--memory-root',memory,
   '--state-dir',state,'--mode',mode,'--operation','hook'];
 const policyArgs=(mode='scoped-native-validation',name=policyFile,hash=policySha,
  mPath=manifestFile,mHash=manifestSha)=>
  [...baseArgs(mode,mPath,mHash),'--policy-file',name,'--policy-sha256',hash];
 const empty=()=>assert.equal(stateCount(state),0);
 const writeManifest=modified=>{
  const file=path.join(temp,'manifest-'+String(++serial)+'.json');
  fs.writeFileSync(file,JSON.stringify(modified));
  return [file,fileSha(file)];
 };
 await test('closure-exact-14-and-R-gate-state-identities',()=>{
  assert.equal(paths.length,14);
  assert.deepEqual(manifest.files.map(x=>x.path),paths);
  for(const x of manifest.files){
   assert(x.bytes>0&&x.bytes<=200000);
   assert.equal(fileSha(path.join(W,x.path)),x.sha256);
  }
  // Reference source identities use LF; raw checkout bytes (including CRLF)
  // remain pinned and checked independently by the manifest loop above.
  const sourceSha=name=>sha(fs.readFileSync(path.join(__dirname,name),'utf8').replace(/\r\n/g,'\n'));
  assert.equal(sourceSha('action-receipt-gate.cjs'),
   'e1261ea51c3212ab395dcfdd2c11aedee952dc3863bc27815ca76bf6ba084a4c');
  assert.equal(sourceSha('action-receipt-state.cjs'),
   'b66cc4294ef161d74649e43ef5c46066fbaf1f19716a84e3946090d277fc1ceb');
 });
 await test('default-off-stdin-policy-spoof-parity-no-state',async()=>{
  const input=event(repo,patch);
  const native=await invoke(baseArgs('normal'),input);
  const readonly=await runPreToolUse(input,{memoryRoot:memory,sourceScope:scope,selector:recall});
  assert.equal(native.code,'READONLY_DELEGATED');
  assert.deepEqual(native.output,readonly.output||{});
  assert(!fs.existsSync(state));
 });
 await test('explicit-disabled-policy-parity-no-state',async()=>{
  const input=event(repo,patch);
  const native=await invoke(policyArgs('normal',disabledFile,fileSha(disabledFile)),input);
  const readonly=await runPreToolUse(input,{memoryRoot:memory,sourceScope:scope,selector:recall});
  assert.deepEqual(native.output,readonly.output||{});
  assert(!fs.existsSync(state));
 });
 await test('cli-child-rc0-default-off-and-no-state',async()=>{
  const input=event(repo,patch);
  const t=process.hrtime.bigint();
  const proc=cp.spawnSync(process.execPath,[CLI,...baseArgs('normal')],{
   input:Buffer.from(JSON.stringify(input)),cwd:W,timeout:6000,maxBuffer:16000,windowsHide:true});
  childCalls++;childRC=proc.status;childMs=Number(process.hrtime.bigint()-t)/1e6;
  assert.equal(proc.error,undefined);assert.equal(proc.signal,null);assert.equal(proc.status,0);
  assert.equal((proc.stderr||Buffer.alloc(0)).length,0);
  const expected=await runPreToolUse(input,{memoryRoot:memory,sourceScope:scope,selector:recall});
  assert.deepEqual(JSON.parse(proc.stdout.toString('utf8')),expected.output||{});
  assert(!fs.existsSync(state));
 });
 fs.mkdirSync(state,{recursive:true});
 await test('enabled-policy-normal-mode-denied',async()=>{
  const r=await invoke(policyArgs('normal'),event(repo,patch));
  expectCode(r,'ROUTING_UNVERIFIED');empty();
 });
 await test('enabled-policy-hash-mismatch-denied-before-state',async()=>{
  const r=await invoke(policyArgs('scoped-native-validation',policyFile,'0'.repeat(64)),event(repo,patch));
  expectCode(r,'CLI_FAULT');empty();
 });
 for(const name of ['action-receipt-gate.cjs','action-receipt-state.cjs','action-receipt-opt-in.cjs']){
  await test('integrated-'+name+'-pin-mismatch-denied-before-state',async()=>{
   const modified=structuredClone(manifest);
   const row=modified.files.find(x=>x.path==='adapters/codex/'+name);
   row.sha256='0'.repeat(64);
   const [f,h]=writeManifest(modified);
   const r=await invoke(policyArgs('scoped-native-validation',policyFile,policySha,f,h),event(repo,patch));
   expectCode(r,'CLI_FAULT');empty();
  });
 }
 await test('manifest-missing-integrated-module-denied-before-state',async()=>{
  const modified=structuredClone(manifest);
  modified.files=modified.files.filter(x=>x.path!=='adapters/codex/action-receipt-state.cjs');
  const [f,h]=writeManifest(modified);
  const r=await invoke(policyArgs('scoped-native-validation',policyFile,policySha,f,h),event(repo,patch));
  expectCode(r,'CLI_FAULT');empty();
 });
 await test('enabled-within-root-junction-alias-denied',async()=>{
  alias=path.join(repo,'alias');
  fs.symlinkSync(path.join(repo,'src'),alias,'junction');
  const aliasPatch='*** Begin Patch\n*** Update File: alias/one.ts\n@@\n-old\n+new\n*** End Patch';
  const aliasPolicy={...policy,allowedTarget:'alias/one.ts'};
  const aliasFile=path.join(temp,'alias-policy.json');
  fs.writeFileSync(aliasFile,JSON.stringify(aliasPolicy));
  const mapped=require('./pre-tool-recall.cjs').actionFromHook(event(repo,aliasPatch),scope);
  assert.notEqual(mapped.status,'ok');
  assert.equal(mapped.reason,'path-link-alias-unsupported');
  const r=await invoke(policyArgs('scoped-native-validation',aliasFile,fileSha(aliasFile)),
   event(repo,aliasPatch));
  expectCode(r,'TARGET_OUT_OF_SCOPE');empty();
 });
 let original=null,ack=null;
 await test('enabled-exact-path-produces-real-gate-challenge',async()=>{
  original=event(repo,patch);
  const r=await invoke(policyArgs(),original);
  assert.equal(nativeRootEnvelope(original).ok,true);
  assert.equal(r.code,'CHALLENGE_RESERVED');
  assert.equal(r.output.hookSpecificOutput.permissionDecisionReason,'AXMEM_GATE_CHALLENGE_RESERVED');
  assert(r.output.hookSpecificOutput.additionalContext.includes('[syn:action] 完整正文：'));
  ack=protocol(r.output);
  assert.equal(stateCount(state),1);
 });
 await test('child-actor-rejected-and-pending-preserved',async()=>{
  const wrong={...event(repo,patch),agent_id:'synthetic-child'};
  const r=await invoke(policyArgs(),wrong);
  expectCode(r,'CHILD_OUT_OF_SCOPE');assert.equal(stateCount(state),1);
 });
 await test('wrong-target-rejected-while-pending',async()=>{
  const r=await invoke(policyArgs(),event(repo,other));
  expectCode(r,'TARGET_OUT_OF_SCOPE');assert.equal(stateCount(state),1);
 });
 await test('response-derived-ACK-denied-no-control-file',async()=>{
  assert(typeof ack==='string');
  const r=await invoke(policyArgs(),event(repo,ack));
  assert.equal(r.code,'ACK_RECORDED');
  assert.equal(r.output.hookSpecificOutput.permissionDecisionReason,'AXMEM_GATE_ACK_RECORDED');
  assert.equal(stateCount(state),1);
  assert.equal(fs.existsSync(path.join(repo,'.codex-reviews/axmem-action-ack/receipt.txt')),false);
 });
 await test('exact-original-after-ACK-consumed-once-no-target-write',async()=>{
  const r=await invoke(policyArgs(),event(repo,patch));
  assert.deepEqual(r.output,{});assert.equal(r.code,'ACK_CONSUMED');
  empty();assert.equal(fs.readFileSync(path.join(repo,'src/one.ts'),'utf8'),'old');
 });
 await test('stale-ACK-replay-denied-not-reused',async()=>{
  const r=await invoke(policyArgs(),event(repo,ack));
  assert.equal(r.output.hookSpecificOutput.permissionDecision,'deny');
  empty();
 });
 await test('source-scope-pin-mismatch-denied-after-consume',async()=>{
  const modified=baseArgs('scoped-native-validation');
  const at=modified.indexOf('--scope-sha256');modified[at+1]='0'.repeat(64);
  const r=await invoke([...modified,'--policy-file',policyFile,'--policy-sha256',policySha],
   event(repo,patch));
  expectCode(r,'CLI_FAULT');empty();
 });
 const total=checks.length,passed=checks.filter(c=>c.ok).length;
 const durationMs=Number(process.hrtime.bigint()-start)/1e6;
 console.log(JSON.stringify({suite:'AXMEM-S1-F1-SYNTHETIC',total,passed,failed:total-passed,
  childCalls,childRC,childMs:Number((childMs||0).toFixed(3)),
  durationMs:Number(durationMs.toFixed(3)),cases:checks}));
 if(passed!==total)process.exitCode=1;
}
main().catch(e=>{
 console.log(JSON.stringify({suite:'AXMEM-S1-F1-SYNTHETIC',fatalClass:e&&e.name||'Unknown',
  completed:checks.length,failed:checks.filter(c=>!c.ok).length}));
 process.exitCode=1;
}).finally(()=>{
 if(temp&&fs.existsSync(temp)){
  try{
   if(alias&&fs.existsSync(alias))fs.unlinkSync(alias);
   const allowed=path.basename(temp).startsWith('axmem-s1-f1-synthetic-')&&
     path.dirname(temp)===os.tmpdir();
   if(allowed)fs.rmSync(temp,{recursive:true,force:false});
  }catch{process.exitCode=1;console.log(JSON.stringify({syntheticCleanup:'FAILED'}));}
 }
});
