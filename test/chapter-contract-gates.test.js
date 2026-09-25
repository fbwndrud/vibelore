import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runInit } from '../src/tools/init.js';
import { runCheck } from '../src/tools/check.js';
import { runCommit } from '../src/tools/commit.js';
import { approvalFixtureProvider } from './fixtures/approval-response.js';

export function chapterProvider({ badLanguage = false, invalidSemantic = false, onLanguage } = {}) {
  const requests = [];
  return { requests, pending: [], async complete(req) {
    requests.push(req);
    const text = req.messages.map(m=>m.content).join('\n');
    const hash = text.match(/contextHash: ([a-f0-9]{64})/)?.[1];
    if (req.step === 'continuity-extract') return { text: JSON.stringify({ appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], hookOps: [], mutableChanges: [], influenceEvents: [], trackedEntityOps: [], noInfluenceReason: 'No lasting change.', extractionValidation: { contextHash: hash } }) };
    if (req.step === 'continuity-check') {
      const ids = text.match(/these invariants: ([A-Z_, ]+)\./)?.[1]?.split(', ') ?? text.match(/판정한다: ([A-Z_, ]+)\./)?.[1]?.split(', ') ?? [];
      return { text: JSON.stringify({ violations: [], semanticValidation: { contextHash: invalidSemantic ? 'invalid' : hash, verdicts: Object.fromEntries(ids.map(id=>[id,'pass'])), evidence: [] } }) };
    }
    if (req.step === 'chapter-summary') return { text: JSON.stringify({ summary: 'A door opens.', plotBeat: 'A door opens.', sceneTags: [], povCharacter: '' }) };
    if (req.step === 'language-contract') {
      await onLanguage?.();
      return { text: JSON.stringify({ language: 'en', artifactHash: text.match(/artifactHash: ([a-f0-9]{64})/)?.[1], verdict: badLanguage ? 'uncertain' : 'pass', evidence: [], allowedExceptions: [] }) };
    }
    throw new Error(`Unexpected model request ${req.step}`);
  } };
}
export async function chapterStore() {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'contract-chapter-')));
  await runInit({ store, workId: 'w', genre: 'other', language: 'en', worldFacts: ['The door is closed.'], providers: approvalFixtureProvider() });
  await store.saveStoryProfile('w', { status: 'active', revision: 1, language: 'en', format: { length: { unit: 'words', target: 10 }, dialogueBreakMode: 'natural' } });
  return store;
}
const prose = 'The rain stopped before dawn. Beyond the courtyard, a door slowly opened into the quiet garden.';
const input = store => ({ store, workId: 'w', chapter: 1, prose, title: 'The door', castManifestRaw: '', issueReceipt: true });

test('full chapter validation issues a consumed-only receipt and commit makes zero model calls', async () => {
  const store = await chapterStore(); const providers = chapterProvider();
  const checked = await runCheck({ ...input(store), providers });
  assert.equal(checked.validationComplete, true, JSON.stringify(checked));
  const count = providers.requests.length;
  const result = await runCommit({ ...input(store), providers, checkId: checked.checkId });
  assert.equal(result.committed, 1); assert.equal(providers.requests.length, count);
  await assert.rejects(runCommit({ ...input(store), providers, checkId: checked.checkId }));
});
test('three invalid semantic responses preserve terminal state until explicit retry', async () => {
  const store = await chapterStore(); const providers = chapterProvider({ invalidSemantic: true });
  for(let n=1;n<=3;n++) { const result=await runCheck({ ...input(store), workflowId:'wf-test', providers }); assert.equal(result.validationAttempts,n,JSON.stringify(result)); }
  const count=providers.requests.length;
  assert.equal((await runCheck({ ...input(store), workflowId:'wf-test', providers })).status,'clean_fail');
  assert.equal(providers.requests.length,count);
  const retried=await runCheck({ ...input(store), workflowId:'wf-test', providers:chapterProvider(), retryValidation:true });
  assert.equal(retried.validationEpoch,2); assert.equal(retried.validationComplete,true,JSON.stringify(retried));
});
test('live plan mutation during model validation cannot issue or revive a receipt', async () => {
  const store=await chapterStore();
  const providers=chapterProvider({ onLanguage: async()=>{ await store.saveStoryProfile('w',{ status:'active',revision:2,language:'en',format:{length:{unit:'words',target:10},dialogueBreakMode:'natural'} }); } });
  const result=await runCheck({ ...input(store),providers });
  assert.equal(result.status,'clean_fail',JSON.stringify(result)); assert.equal(result.code,'STALE_WORK_CONTRACT');
});
test('changing checked metadata prevents commit even with the original prose', async()=>{
  const store=await chapterStore();const providers=chapterProvider();const checked=await runCheck({...input(store),providers});
  assert.equal(checked.validationComplete,true,JSON.stringify(checked));
  await assert.rejects(runCommit({...input(store),providers,checkId:checked.checkId,title:'Changed title'}));
  assert.equal((await store.listChapters()).length,0);
});

test('restoring edited plans and flipping consumed receipt flags cannot revive live validation state', async () => {
 const store=await chapterStore(); const original=await store.loadStoryProfile('w'); const providers=chapterProvider();
 const checked=await runCheck({...input(store),providers});
 await store.saveStoryProfile('w',{...original,revision:2});
 await assert.rejects(runCommit({...input(store),providers,checkId:checked.checkId}));
 await store.saveStoryProfile('w',original);
 const receipt=await store.loadCheckReceipt('w',checked.checkId);
 await store.saveCheckReceipt('w',{...receipt,stale:false,consumed:false,consumedAt:null,validationReceipt:{...receipt.validationReceipt,stale:false,consumed:false}});
 const count=providers.requests.length;
 await assert.rejects(runCommit({...input(store),providers,checkId:checked.checkId}));
 assert.equal(providers.requests.length,count);
 assert.equal((await runCheck({...input(store),providers})).status,'clean_fail');
});

test('metadata language repair changes only the failing summary before validating the complete bundle again', async()=>{
 const store=await chapterStore(); const base=chapterProvider();let calls=0;let repairProse;
 const providers={pending:[],async complete(req){
  if(req.step==='chapter-language-repair'){repairProse=JSON.parse(req.messages.find(m=>m.role==='user').content).prose;return{text:JSON.stringify({summary:'The door opens.'})};}
  if(req.step==='language-contract' && calls++===0){const text=req.messages.map(m=>m.content).join('\n');return{text:JSON.stringify({language:'en',artifactHash:text.match(/artifactHash: ([a-f0-9]{64})/)[1],verdict:'fail',evidence:[{fieldPath:'summary',quote:'문이 열린다.',reason:'This generated summary is in Korean.'}],allowedExceptions:[]})};}
  return base.complete(req);
 }};
 const args={...input(store),summary:'문이 열린다.',providers,workflowId:'metadata'};
 assert.equal((await runCheck(args)).code,'OUTPUT_LANGUAGE_MISMATCH');
 const result=await runCheck(args);assert.equal(result.validationComplete,true,JSON.stringify(result));assert.equal(result.artifact.summary,'The door opens.');assert.equal(result.artifact.prose,prose);assert.equal(repairProse,prose);
});

test('exceptions-only approved profile revision rebinds unchanged failed draft in a new epoch and publishes latest profile',async()=>{
 const store=await chapterStore();const original=await store.loadStoryProfile('w');const invalid=chapterProvider({badLanguage:true});
 const args={...input(store),workflowId:'exception-retry'};
 for(let index=0;index<3;index++)await runCheck({...args,providers:invalid});
 const revised={...original,revision:2,allowedLanguageExceptions:[{kind:'properNoun',language:'fr',scope:'Jardin',rationale:'Preserve the approved place name.'}]};
 await store.saveStoryProfile('w',revised);
 const result=await runCheck({...args,providers:chapterProvider(),retryValidation:true});
 assert.equal(result.validationComplete,true,JSON.stringify(result));assert.equal(result.validationEpoch,2);assert.equal(result.artifact.prose,prose);
 await runCommit({...input(store),providers:{complete(){throw Error('consume only');}},checkId:result.checkId});
 const {createPublicationUnit}=await import('../src/core/publication-unit.js');
 const published=await createPublicationUnit({rootDir:store.rootDir}).readPublished();
 assert.equal(published.value.tree.plans.storyProfile.revision,2);
 assert.deepEqual(published.value.tree.plans.storyProfile.allowedLanguageExceptions,revised.allowedLanguageExceptions);
});

test('a fresh manual check after its own publication opens a new epoch without reviving the consumed receipt',async()=>{
 const store=await chapterStore();const providers=chapterProvider();
 const first=await runCheck({...input(store),providers});await runCommit({...input(store),providers,checkId:first.checkId});
 const next=await runCheck({...input(store),prose:prose+' A bell rang across the courtyard.',providers});
 assert.equal(next.validationComplete,true,JSON.stringify(next));assert.equal(next.validationEpoch,2);assert.notEqual(next.checkId,first.checkId);
 assert.equal((await store.loadCheckReceipt('w',first.checkId)).consumed,true);
 await assert.rejects(runCommit({...input(store),providers,checkId:first.checkId}));
});

test('malformed or unregistered cast metadata never supplies mandatory schema proof',async()=>{
 for(const castManifestRaw of ['not valid JSON','{"cast":[{"characterId":"missing"}]}']){
  const store=await chapterStore();const result=await runCheck({...input(store),castManifestRaw,providers:chapterProvider()});
  assert.notEqual(result.validationComplete,true);assert.equal(result.coverage.coverageById.SCHEMA,'failed');assert.equal(result.checkId,undefined);
 }
});
