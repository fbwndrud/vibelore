import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRelayedTool } from '../src/relay-runner.js';
import { createPreflightRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { loadValidationSession } from '../src/core/validation-context.js';

test('real writer relay counts three distinct invalid semantic answers, never preflight/replay, and retains the failed draft',async()=>{
 const store=await qualityStore(); const ids=[];
 const invoke=async(previous,answer=true)=>{
  const run=previous?.runId?await loadRun(store.rootDir,previous.runId):null;const answers={...run?.answers};
  if(answer)for(const req of previous?.requests??[]){
   if(req.step==='continuity-check'){ids.push(req.id);answers[req.id]='{}';}
   else {const shaped={step:req.step,messages:[{role:'system',content:req.system},{role:'user',content:req.user}]};answers[req.id]=contractResponse(shaped)?.text??outputs[req.step]??'{}';}
  }
  return runRelayedTool({store,toolName:'lore_write',args:run?.args??{workId,autonomy:'auto'},run,answers,
   providerForTool:(_name,seed)=>createPreflightRelay(seed),executeTool:(store,_name,args,providers)=>runWriteWorkflow({store,...args,providers})});
 };
 let result=await invoke();
 for(let n=0;n<15 && result.status==='needs_model';n++){
  if(result.requests.some(r=>r.step==='continuity-check')){
   const wf=await store.loadWorkflow(workId);const before=await loadValidationSession(store,workId,`workflow-${wf.workflowId}`);
   const replay=await invoke(result,false);assert.equal(replay.requests[0].id,result.requests[0].id);
   assert.equal((await loadValidationSession(store,workId,`workflow-${wf.workflowId}`)).failures,before.failures);
   result=replay;
  }
  result=await invoke(result);
 }
 assert.equal(result.status,'clean_fail',JSON.stringify(result));assert.equal(ids.length,3);assert.equal(new Set(ids).size,3);
 const wf=await store.loadWorkflow(workId);assert.ok(wf.draftProse);assert.equal(wf.stage,'clean_fail');
 const again=await runWriteWorkflow({store,workId,providers:{complete(){throw Error('terminal workflow must not call models');}}});assert.equal(again.status,'clean_fail');
});

test('confirmed prose language failure receives one scoped repair before publication',async()=>{
 const store=await qualityStore();let languageCalls=0;const repairs=[];
 const providers={async complete(req){
  if(req.step==='draft')return{text:outputs.draft+'\n\nForeign sentence.'};
  if(req.step==='revise'){repairs.push(req);const text=req.messages.map(m=>m.content).join('\n');const paragraph=Number(text.match(/"paragraph":\s*(\d+),\s*"text":\s*"Foreign sentence\./)?.[1]);return{text:JSON.stringify({replacements:[{paragraph,text:''}],insertions:[]})};}
  if(req.step==='language-contract' && languageCalls++===0){const text=req.messages.map(m=>m.content).join('\n');return{text:JSON.stringify({language:'ko',artifactHash:text.match(/artifactHash: ([a-f0-9]{64})/)[1],verdict:'fail',evidence:[{fieldPath:'prose',quote:'Foreign sentence.',reason:'The generated sentence is in English.'}],allowedExceptions:[]})};}
  return contractResponse(req)??{text:outputs[req.step]??'{}'};
 }};
 const result=await runWriteWorkflow({store,workId,autonomy:'auto',providers});
 assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(repairs.length,1);assert.match(JSON.stringify(repairs[0]),/OUTPUT_LANGUAGE_MISMATCH/);
 assert.doesNotMatch((await store.loadArtifact(workId,1)).prose,/Foreign sentence/);
});

test('guided user revision clears the old approval receipt and resumes its new validation requests',async()=>{
 const { runWorkflowDecide }=await import('../src/tools/workflow.js');
 const store=await qualityStore();
 const provider={async complete(req){return contractResponse(req)??{text:outputs[req.step]??'{}'};}};
 const first=await runWriteWorkflow({store,workId,autonomy:'guided',providers:provider});assert.equal(first.status,'awaiting_approval');
 const before=await store.loadWorkflow(workId);
 await runWorkflowDecide({store,workId,approvalId:first.approvalId,action:'request_revision',feedback:'Add a quiet final gesture.',providers:provider});
 assert.equal((await store.loadWorkflow(workId)).checkId,undefined);
 const executeTool=(store,_name,args,providers)=>runWriteWorkflow({store,...args,providers});
 let result=await runRelayedTool({store,toolName:'lore_write',args:{workId,autonomy:'guided'},executeTool,providerForTool:(_name,answers)=>createPreflightRelay(answers)});
 for(let index=0;index<16&&result.status==='needs_model';index++){
  const run=await loadRun(store.rootDir,result.runId);const answers={...run.answers};
  for(const req of result.requests){const shaped={step:req.step,messages:[{role:'system',content:req.system},{role:'user',content:req.user}]};answers[req.id]=req.step==='revise'?JSON.stringify({replacements:[],insertions:[{afterParagraph:1,text:'조용히 손을 내렸다.'}]}):(contractResponse(shaped)?.text??outputs[req.step]??'{}');}
  result=await runRelayedTool({store,toolName:'lore_write',args:run.args,run,answers,executeTool,providerForTool:(_name,seed)=>createPreflightRelay(seed)});
 }
 assert.equal(result.status,'awaiting_approval',JSON.stringify(result));
 const after=await store.loadWorkflow(workId);assert.equal(after.workflowId,before.workflowId);assert.notEqual(after.checkId,before.checkId);assert.equal(after.userApproval,undefined);
});

// 2026-09-15 es 표본: pass 판정에 딸린 배열 경로 인용(semanticDelta.hookOps)이 receipt 발급의 strict 재판정에서
// field_not_text 로 다시 튕겨 세 번의 pass 가 전부 소진됐다. receipt 는 유효 인용만 남긴 평가 결과를 담아야 한다.
test('a pass with a decorative array-path citation still issues the chapter receipt',async()=>{
 const store=await qualityStore();
 const providers={async complete(req){
  if(req.step==='language-contract'){const text=req.messages.map(m=>m.content).join('\n');return{text:JSON.stringify({language:'ko',artifactHash:text.match(/artifactHash: ([a-f0-9]{64})/)[1],verdict:'pass',evidence:[{fieldPath:'semanticDelta.hookOps',quote:'x',reason:'array path'},{fieldPath:'title',quote:'첫 문',reason:'Korean'}],allowedExceptions:[]})};}
  return contractResponse(req)??{text:outputs[req.step]??'{}'};
 }};
 const result=await runWriteWorkflow({store,workId,autonomy:'auto',providers});
 assert.equal(result.status,'completed',JSON.stringify(result));
 const receipt=await store.loadCheckReceipt(workId,(await store.loadWorkflow(workId)).checkId);
 assert.deepEqual(receipt.languageCompliance.evidence.map(e=>e.fieldPath),['title']);
});

// 2026-09-15 zh-Hant 표본: 초안 검증이 두 번 실패 뒤 통과했는데, 사용자 수정본의 정당한 fail 한 번이 남은 예산(1)을 소진해 clean_fail.
// 통과한 뒤의 새 원고는 새 epoch 와 온전한 예산으로 시작한다.
test('a revision after a passed check starts a new validation epoch with a full budget',async()=>{
 const { runWorkflowDecide }=await import('../src/tools/workflow.js');
 const store=await qualityStore();
 let uncertainLeft=1;let reviseCalls=0;
 const providers={async complete(req){
  if(req.step==='language-contract'){const text=req.messages.map(m=>m.content).join('\n');const hash=text.match(/artifactHash: ([a-f0-9]{64})/)[1];
   if(uncertainLeft>0){uncertainLeft-=1;return{text:JSON.stringify({language:'ko',artifactHash:hash,verdict:'uncertain',evidence:[],allowedExceptions:[]})};}
   return{text:JSON.stringify({language:'ko',artifactHash:hash,verdict:'pass',evidence:[],allowedExceptions:[]})};}
  if(req.step==='revise'){reviseCalls+=1;return{text:JSON.stringify({replacements:[],insertions:[{afterParagraph:1,text:'조용히 손을 내렸다.'}]})};}
  return contractResponse(req)??{text:outputs[req.step]??'{}'};
 }};
 const first=await runWriteWorkflow({store,workId,autonomy:'guided',providers});
 assert.equal(first.status,'awaiting_approval',JSON.stringify(first));
 const wf=await store.loadWorkflow(workId);
 const passed=await loadValidationSession(store,workId,`workflow-${wf.workflowId}`);
 assert.equal(passed.failures,1);assert.equal(passed.epoch,1);
 await runWorkflowDecide({store,workId,approvalId:first.approvalId,action:'request_revision',feedback:'Add a quiet final gesture.',providers});
 uncertainLeft=2;
 const revised=await runWriteWorkflow({store,workId,autonomy:'guided',providers});
 assert.equal(revised.status,'awaiting_approval',JSON.stringify(revised));
 assert.equal(reviseCalls,1);
 const after=await loadValidationSession(store,workId,`workflow-${wf.workflowId}`);
 assert.equal(after.epoch,2);assert.equal(after.failures,2);
});
