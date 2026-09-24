import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runWriteWorkflow, runWorkflowDecide, runWorkflowHistory, runWorkflowInspect, proseHash } from '../src/tools/workflow.js';
import { runSyncStatus } from '../src/tools/sync.js';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';

// continuity-check answers with an unbound '{}' until `healthy` is set, which
// spends the three-attempt validation budget and parks the draft as clean_fail.
function scriptedProviders() {
  const state = { healthy: false, drafts: 0, steps: [], requests: [] };
  state.providers = { pending: [], async complete(req) {
    state.steps.push(req.step);
    state.requests.push(req);
    if (req.step === 'draft') state.drafts += 1;
    if (req.step === 'revise') return { text: JSON.stringify({ replacements: [{ paragraph: 1, text: '윤재는 입구의 표시를 확인하며 마지막 선택의 대가를 떠올렸다.' }] }) };
    if (req.step === 'continuity-check' && !state.healthy) return { text: '{}' };
    return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' };
  } };
  return state;
}

async function cleanFailedStore() {
  const store = await qualityStore();
  const model = scriptedProviders();
  const failed = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers });
  assert.equal(failed.status, 'clean_fail', JSON.stringify(failed));
  const workflow = await store.loadWorkflow(workId);
  assert.equal(workflow.stage, 'clean_fail');
  return { store, model, failedId: workflow.workflowId };
}

async function assertSuperseded(store, failedId) {
  const current = await store.loadWorkflow(workId);
  assert.notEqual(current.workflowId, failedId);
  assert.equal(current.supersedes, failedId);
  const old = await store.loadWorkflow(workId, failedId);
  assert.equal(old.stage, 'clean_fail');
  assert.equal(old.supersededBy, current.workflowId);
  const history = await runWorkflowHistory({ store, workId, workflowId: failedId });
  assert.ok(history.events.some((event) => event.event === 'clean_fail'), JSON.stringify(history.events));
  assert.ok(history.events.some((event) => event.event === 'workflow_superseded' && event.by === current.workflowId));
  return { current, old };
}

// The kept draft is re-validated, not redrafted: the superseding workflow
// records the exact prose it inherited, and the commit carries that prose.
async function assertRevalidated(store, failedId, keptProse, mode) {
  const { current } = await assertSuperseded(store, failedId);
  assert.deepEqual(current.inheritedDraft, { workflowId: failedId, proseHash: proseHash(keptProse) });
  const history = await runWorkflowHistory({ store, workId, workflowId: failedId });
  assert.equal(history.events.find((event) => event.event === 'workflow_superseded').mode, mode);
  const started = (await runWorkflowHistory({ store, workId })).events.find((event) => event.event === 'workflow_started');
  assert.equal(started.inheritedDraft.proseHash, proseHash(keptProse));
  return current;
}

test('after an arc-plan edit, retryValidation re-validates the kept draft under the current contract', async () => {
  const { store, model, failedId } = await cleanFailedStore();
  const kept = (await store.loadWorkflow(workId)).draftProse;
  const arc = await store.loadArcPlan(workId);
  await store.saveArcPlan(workId, { ...arc, episodes: arc.episodes.map((episode) => episode.chapter === 1 ? { ...episode, beat: '문을 열고 안을 둘러본다' } : episode) });

  model.healthy = true;
  const draftsBefore = model.drafts;
  const fresh = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers, retryValidation: true });
  assert.equal(fresh.status, 'completed', JSON.stringify(fresh));
  assert.equal(model.drafts, draftsBefore);
  await assertRevalidated(store, failedId, kept, 'revalidate');
  assert.equal((await readFile(join(store.rootDir, 'chapters', '001.md'), 'utf8')).includes(kept.slice(0, 80)), true);
});

test('an arc-plan edit alone makes the next bare lore_write re-validate the stale clean_fail draft without drafting', async () => {
  const { store, model, failedId } = await cleanFailedStore();
  const kept = (await store.loadWorkflow(workId)).draftProse;
  const arc = await store.loadArcPlan(workId);
  await store.saveArcPlan(workId, { ...arc, promise: '문 너머의 놀이와 첫 대가' });
  model.healthy = true;
  const draftsBefore = model.drafts;
  const fresh = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers });
  assert.equal(fresh.status, 'completed', JSON.stringify(fresh));
  assert.equal(model.drafts, draftsBefore);
  await assertRevalidated(store, failedId, kept, 'revalidate');
});

test('a new instruction after clean_fail starts a fresh draft; a bare lore_write keeps the preserved draft without a model call', async () => {
  const { store, model, failedId } = await cleanFailedStore();
  model.healthy = true;
  const draftsBefore = model.drafts;
  const callsBefore = model.steps.length;
  const preserved = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers });
  assert.equal(preserved.status, 'clean_fail');
  assert.equal(model.steps.length, callsBefore, 'no model call when nothing changed');
  assert.equal((await store.loadWorkflow(workId)).workflowId, failedId);

  const fresh = await runWriteWorkflow({ store, workId, autonomy: 'auto', instruction: '문 앞에서 망설이는 장면을 줄인다', providers: model.providers });
  assert.equal(fresh.status, 'completed', JSON.stringify(fresh));
  assert.equal(model.drafts, draftsBefore + 1);
  const { current } = await assertSuperseded(store, failedId);
  assert.equal(current.inheritedDraft, undefined);
  const history = await runWorkflowHistory({ store, workId, workflowId: failedId });
  assert.equal(history.events.find((event) => event.event === 'workflow_superseded').mode, 'redraft');
});

test('lore_workflow_inspect returns the kept clean_fail draft prose', async () => {
  const { store } = await cleanFailedStore();
  const kept = (await store.loadWorkflow(workId)).draftProse;
  const summary = await runWorkflowInspect({ store, workId });
  assert.equal(summary.draftProse, undefined, 'summary detail omits the prose');
  const inspected = await runWorkflowInspect({ store, workId, detail: 'full' });
  assert.equal(inspected.draftProse, kept);
  assert.equal(inspected.workflow.draftProse, undefined);
});

async function completedChapterOne() {
  const store = await qualityStore();
  const model = scriptedProviders();
  model.healthy = true;
  const done = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers });
  assert.equal(done.status, 'completed', JSON.stringify(done));
  return { store, model };
}

async function handEditChapterOne(store) {
  const path = join(store.rootDir, 'chapters', '001.md');
  const text = await readFile(path, 'utf8');
  await writeFile(path, `${text.trimEnd()}\n\n윤재는 문턱에서 잠시 숨을 골랐다.\n`, 'utf8');
}

test('working-tree drift never rewrites a completed workflow', async () => {
  const { store, model } = await completedChapterOne();
  const before = await store.loadWorkflow(workId);
  await handEditChapterOne(store);
  const blocked = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers });
  assert.equal(blocked.status, 'needs_sync', JSON.stringify(blocked));
  const after = await store.loadWorkflow(workId);
  assert.equal(after.stage, 'completed');
  assert.equal(after.failure, undefined);
  const history = await runWorkflowHistory({ store, workId, workflowId: before.workflowId });
  assert.ok(!history.events.some((event) => event.event === 'clean_fail'), JSON.stringify(history.events));
});

test('a hand edit during approval, then lore_sync, lets lore_write re-validate the parked draft', async () => {
  const { store, model } = await completedChapterOne();
  const plan = await store.loadEpisodePlan(workId, 1);
  await store.saveEpisodePlan(workId, { ...plan, chapter: 2, status: 'active' });
  const guided = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: model.providers });
  assert.equal(guided.status, 'awaiting_approval', JSON.stringify(guided));
  assert.equal(guided.chapter, 2);
  const parkedId = guided.workflowId;
  const oldCheckId = (await store.loadWorkflow(workId)).checkId;

  await handEditChapterOne(store);
  const blocked = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: model.providers });
  assert.equal(blocked.status, 'needs_sync', JSON.stringify(blocked));
  assert.equal((await store.loadWorkflow(workId)).stage, 'clean_fail');

  const validated = await runSyncStatus({ store, workId, action: 'validate', providers: model.providers });
  assert.equal(validated.status, 'awaiting_approval', JSON.stringify(validated));
  await runSyncStatus({ store, workId, action: 'apply', approvalId: validated.approvalId, providers: model.providers });

  const draftsBefore = model.drafts;
  // The draft was waiting for the user's decision: an auto call must not commit it.
  const fresh = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers });
  assert.equal(fresh.status, 'awaiting_approval', JSON.stringify(fresh));
  assert.equal((await store.loadWorkflow(workId)).autonomy, 'guided');
  assert.equal(fresh.chapter, 2);
  assert.notEqual(fresh.workflowId, parkedId);
  assert.equal(model.drafts, draftsBefore);
  assert.equal(fresh.prose, guided.prose);
  const current = await assertRevalidated(store, parkedId, guided.prose, 'revalidate');
  assert.notEqual(current.checkId, oldCheckId);
  assert.equal((await store.loadCheckReceipt(workId, oldCheckId)).stale, true);
  const approved = await runWorkflowDecide({ store, workId, approvalId: fresh.approvalId, action: 'approve', providers: model.providers });
  assert.equal(approved.status, 'completed', JSON.stringify(approved));
});

test('a plan edit during guided approval re-validates the same prose without a draft request and asks for approval again', async () => {
  const store = await qualityStore();
  const model = scriptedProviders();
  model.healthy = true;
  const guided = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: model.providers });
  assert.equal(guided.status, 'awaiting_approval', JSON.stringify(guided));
  const parkedId = guided.workflowId;
  const oldCheckId = (await store.loadWorkflow(workId)).checkId;

  const unchanged = model.steps.length;
  const again = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: model.providers });
  assert.equal(again.approvalId, guided.approvalId);
  assert.equal(model.steps.length, unchanged, 'no model call when nothing changed');

  const plan = await store.loadEpisodePlan(workId, 1);
  await store.saveEpisodePlan(workId, { ...plan, premise: '지도에서 본 길을 찾아 문을 연다' });
  const stepsBefore = model.steps.length;
  const fresh = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: model.providers });
  assert.equal(fresh.status, 'awaiting_approval', JSON.stringify(fresh));
  const asked = model.steps.slice(stepsBefore);
  assert.ok(!asked.includes('draft'), JSON.stringify(asked));
  assert.ok(asked.includes('continuity-extract') && asked.includes('language-contract'), JSON.stringify(asked));
  assert.equal(fresh.prose, guided.prose);
  assert.notEqual(fresh.approvalId, guided.approvalId);
  const current = await assertRevalidated(store, parkedId, guided.prose, 'revalidate');
  assert.notEqual(current.checkId, oldCheckId);
  const receipt = await store.loadCheckReceipt(workId, current.checkId);
  assert.equal(receipt.proseHash, proseHash(guided.prose));
  assert.equal(receipt.workflowId, current.workflowId);
  assert.equal((await store.loadCheckReceipt(workId, oldCheckId)).stale, true);
  await assert.rejects(runWorkflowDecide({ store, workId, approvalId: guided.approvalId, action: 'approve', providers: model.providers }));
  const inspected = await runWorkflowInspect({ store, workId, detail: 'full' });
  assert.equal(inspected.draftProse, guided.prose);
  const approved = await runWorkflowDecide({ store, workId, approvalId: fresh.approvalId, action: 'approve', providers: model.providers });
  assert.equal(approved.status, 'completed', JSON.stringify(approved));
});

test('through the host relay, re-validation after a plan edit supersedes once and asks no draft request', async () => {
  const { createPreflightRelay } = await import('../src/provider/host-relay.js');
  const store = await qualityStore();
  const model = scriptedProviders();
  model.healthy = true;
  const guided = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: model.providers });
  assert.equal(guided.status, 'awaiting_approval', JSON.stringify(guided));
  const plan = await store.loadEpisodePlan(workId, 1);
  await store.saveEpisodePlan(workId, { ...plan, premise: '지도에서 본 길을 찾아 문을 연다' });

  const answers = {};
  const passes = [];
  const successors = new Set();
  let result;
  for (let pass = 0; pass < 12; pass += 1) {
    const relay = createPreflightRelay(answers);
    // Every resumed pass asks for auto; the draft waited for approval, so it stays guided.
    result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: relay });
    successors.add((await store.loadWorkflow(workId)).workflowId);
    if (!relay.pending.length) break;
    passes.push(relay.pending.map((req) => req.step));
    for (const req of relay.pending) {
      const contract = contractResponse({ step: req.step, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }] });
      answers[req.id] = contract?.text ?? outputs[req.step] ?? '{}';
    }
  }
  assert.equal(result.status, 'awaiting_approval', JSON.stringify(result));
  assert.equal(result.prose, guided.prose);
  assert.equal(successors.size, 1, 'resumed passes stay in the one superseding workflow');
  assert.ok(!passes.flat().includes('draft'), JSON.stringify(passes));
  assert.equal(passes.length, 4, JSON.stringify(passes));
  assert.deepEqual(passes.at(-1), ['language-contract']);
});

test('a plan edit never lets an auto call commit a draft that was waiting for approval', async () => {
  const store = await qualityStore();
  const model = scriptedProviders();
  model.healthy = true;
  const guided = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: model.providers });
  assert.equal(guided.status, 'awaiting_approval', JSON.stringify(guided));
  const plan = await store.loadEpisodePlan(workId, 1);
  await store.saveEpisodePlan(workId, { ...plan, premise: '지도에서 본 길을 찾아 문을 연다' });
  const fresh = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers });
  assert.equal(fresh.status, 'awaiting_approval', JSON.stringify(fresh));
  const current = await assertRevalidated(store, guided.workflowId, guided.prose, 'revalidate');
  assert.equal(current.autonomy, 'guided');
  assert.equal(current.autonomyLock, 'guided');
  assert.deepEqual(await store.listChapters(), []);
  const approved = await runWorkflowDecide({ store, workId, approvalId: fresh.approvalId, action: 'approve', providers: model.providers });
  assert.equal(approved.status, 'completed', JSON.stringify(approved));
});

test('pending user revision feedback survives a plan edit and is applied to the kept draft', async () => {
  const store = await qualityStore();
  const model = scriptedProviders();
  model.healthy = true;
  const guided = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: model.providers });
  assert.equal(guided.status, 'awaiting_approval', JSON.stringify(guided));
  const feedback = '마지막 선택의 대가를 장면으로 보여줘.';
  await runWorkflowDecide({ store, workId, approvalId: guided.approvalId, action: 'request_revision', feedback, providers: model.providers });
  const plan = await store.loadEpisodePlan(workId, 1);
  await store.saveEpisodePlan(workId, { ...plan, premise: '지도에서 본 길을 찾아 문을 연다' });

  const stepsBefore = model.steps.length;
  const fresh = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers });
  assert.equal(fresh.status, 'awaiting_approval', JSON.stringify(fresh));
  const asked = model.requests.slice(stepsBefore);
  assert.ok(!asked.some((req) => req.step === 'draft'), JSON.stringify(asked.map((req) => req.step)));
  const revise = asked.find((req) => req.step === 'revise');
  assert.ok(revise, JSON.stringify(asked.map((req) => req.step)));
  assert.match(revise.messages.map((m) => m.content).join('\n'), /마지막 선택의 대가/);
  assert.match(fresh.prose, /마지막 선택의 대가를 떠올렸다/);
  assert.notEqual(fresh.prose, guided.prose);
  const { current } = await assertSuperseded(store, guided.workflowId);
  assert.equal(current.revisionFeedback, feedback);
  assert.equal(current.autonomy, 'guided');
  assert.deepEqual(current.inheritedDraft, { workflowId: guided.workflowId, proseHash: proseHash(guided.prose) });
  const history = await runWorkflowHistory({ store, workId, workflowId: guided.workflowId });
  assert.equal(history.events.find((event) => event.event === 'workflow_superseded').mode, 'revise');
});

test('a ready_to_commit draft whose auto-commit failed is re-validated after a plan edit', async () => {
  const store = await qualityStore();
  const model = scriptedProviders();
  model.healthy = true;
  const guided = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: model.providers });
  const parked = await store.loadWorkflow(workId);
  // Simulate an auto run whose commit step failed after the receipt was issued.
  await store.saveWorkflow(workId, { ...parked, autonomy: 'auto', stage: 'ready_to_commit', approvalId: undefined });
  const plan = await store.loadEpisodePlan(workId, 1);
  await store.saveEpisodePlan(workId, { ...plan, premise: '지도에서 본 길을 찾아 문을 연다' });
  const draftsBefore = model.drafts;
  const fresh = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers });
  assert.equal(fresh.status, 'completed', JSON.stringify(fresh));
  assert.equal(model.drafts, draftsBefore);
  await assertRevalidated(store, parked.workflowId, guided.prose, 'revalidate');
  assert.equal((await store.loadCheckReceipt(workId, parked.checkId)).stale, true);
});

test('a guided re-validation stays guided when a later call asks for auto', async () => {
  const store = await qualityStore();
  const model = scriptedProviders();
  model.healthy = true;
  const guided = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: model.providers });
  const plan = await store.loadEpisodePlan(workId, 1);
  await store.saveEpisodePlan(workId, { ...plan, premise: '지도에서 본 길을 찾아 문을 연다' });
  const { createPreflightRelay } = await import('../src/provider/host-relay.js');
  const first = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: createPreflightRelay({}) });
  assert.equal(first.preview, true, JSON.stringify(first));
  assert.equal((await store.loadWorkflow(workId)).autonomyLock, 'guided');
  const later = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers });
  assert.equal(later.status, 'awaiting_approval', JSON.stringify(later));
  assert.equal(later.prose, guided.prose);
  assert.deepEqual(await store.listChapters(), []);
});
