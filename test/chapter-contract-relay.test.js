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
