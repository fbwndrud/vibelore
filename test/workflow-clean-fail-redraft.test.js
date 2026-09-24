import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runWriteWorkflow, runWorkflowHistory } from '../src/tools/workflow.js';
import { runSyncStatus } from '../src/tools/sync.js';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';

// continuity-check answers with an unbound '{}' until `healthy` is set, which
// spends the three-attempt validation budget and parks the draft as clean_fail.
function scriptedProviders() {
  const state = { healthy: false, drafts: 0 };
  state.providers = { pending: [], async complete(req) {
    if (req.step === 'draft') state.drafts += 1;
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
  const history = await runWorkflowHistory({ store, workId, workflowId: failedId });
  assert.ok(history.events.some((event) => event.event === 'clean_fail'), JSON.stringify(history.events));
  assert.ok(history.events.some((event) => event.event === 'workflow_superseded' && event.by === current.workflowId));
}

test('after an arc-plan edit, lore_write drafts the clean_fail chapter anew under the current contract', async () => {
  const { store, model, failedId } = await cleanFailedStore();
  const arc = await store.loadArcPlan(workId);
  await store.saveArcPlan(workId, { ...arc, episodes: arc.episodes.map((episode) => episode.chapter === 1 ? { ...episode, beat: '문을 열고 안을 둘러본다' } : episode) });

  const retried = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers, retryValidation: true });
  assert.equal(retried.code, 'STALE_WORK_CONTRACT', JSON.stringify(retried));
  assert.match(retried.nextAction, /retryValidation/);

  model.healthy = true;
  const draftsBefore = model.drafts;
  const fresh = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers });
  assert.equal(fresh.status, 'completed', JSON.stringify(fresh));
  assert.equal(model.drafts, draftsBefore + 1);
  await assertSuperseded(store, failedId);
});

test('an arc-plan edit alone makes the next bare lore_write redraft the stale clean_fail chapter', async () => {
  const { store, model, failedId } = await cleanFailedStore();
  const arc = await store.loadArcPlan(workId);
  await store.saveArcPlan(workId, { ...arc, promise: '문 너머의 놀이와 첫 대가' });
  model.healthy = true;
  const draftsBefore = model.drafts;
  const fresh = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers });
  assert.equal(fresh.status, 'completed', JSON.stringify(fresh));
  assert.equal(model.drafts, draftsBefore + 1);
  await assertSuperseded(store, failedId);
});

test('a new instruction after clean_fail starts a fresh attempt; a bare lore_write keeps the preserved draft', async () => {
  const { store, model, failedId } = await cleanFailedStore();
  model.healthy = true;
  const draftsBefore = model.drafts;
  const preserved = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: model.providers });
  assert.equal(preserved.status, 'clean_fail');
  assert.equal(model.drafts, draftsBefore);
  assert.equal((await store.loadWorkflow(workId)).workflowId, failedId);

  const fresh = await runWriteWorkflow({ store, workId, autonomy: 'auto', instruction: '문 앞에서 망설이는 장면을 줄인다', providers: model.providers });
  assert.equal(fresh.status, 'completed', JSON.stringify(fresh));
  assert.equal(model.drafts, draftsBefore + 1);
  await assertSuperseded(store, failedId);
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

test('a hand edit during approval, then lore_sync, lets lore_write draft the chapter anew', async () => {
  const { store, model } = await completedChapterOne();
  const plan = await store.loadEpisodePlan(workId, 1);
  await store.saveEpisodePlan(workId, { ...plan, chapter: 2, status: 'active' });
  const guided = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: model.providers });
  assert.equal(guided.status, 'awaiting_approval', JSON.stringify(guided));
  assert.equal(guided.chapter, 2);
  const parkedId = guided.workflowId;

  await handEditChapterOne(store);
  const blocked = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: model.providers });
  assert.equal(blocked.status, 'needs_sync', JSON.stringify(blocked));
  assert.equal((await store.loadWorkflow(workId)).stage, 'clean_fail');

  const validated = await runSyncStatus({ store, workId, action: 'validate', providers: model.providers });
  assert.equal(validated.status, 'awaiting_approval', JSON.stringify(validated));
  await runSyncStatus({ store, workId, action: 'apply', approvalId: validated.approvalId, providers: model.providers });

  const draftsBefore = model.drafts;
  const fresh = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: model.providers });
  assert.equal(fresh.status, 'awaiting_approval', JSON.stringify(fresh));
  assert.equal(fresh.chapter, 2);
  assert.notEqual(fresh.workflowId, parkedId);
  assert.equal(model.drafts, draftsBefore + 1);
  await assertSuperseded(store, parkedId);
});
