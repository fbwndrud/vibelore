import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { it } from 'node:test';
import { runWriteWorkflow, runWorkflowDecide } from '../src/tools/workflow.js';
import { createPublicationUnit } from '../src/core/publication-unit.js';
import { loadCurrentExperienceLedger } from '../src/core/experience-ledger.js';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';

const providers = { async complete(req) {
  return contractResponse(req) ?? { text: req.step === 'narrative-boundary'
    ? JSON.stringify({ decision: 'extend_arc', reason: '더 필요', continuation: { title: '추가', beat: '새 사건', pressure: '압력', turn: '전환', carry: '다음' } })
    : outputs[req.step] ?? '{}' };
} };

for (const fault of ['boundary', 'ledger', 'completed', 'receipt', 'event', 'completedEvent']) {
  for (const [autonomy, retry] of [['auto', 'write'], ['guided', 'write'], ['guided', 'approve']]) {
    it(`recovers published postprocessing after ${fault} failure via ${autonomy} ${retry}`, async (t) => {
      const store = await qualityStore();
      t.after(() => rm(store.rootDir, { recursive: true, force: true }));
      // A legacy ledger entry must survive the HEAD change and retry.
      await store.saveExperienceLedger(workId, { sourceHead: null, entries: [{ chapter: 0, solutionPattern: 'prior' }] });
      const methods = { boundary: 'saveArcPlan', ledger: 'saveExperienceLedger', completed: 'saveWorkflow', receipt: 'saveCheckReceipt', event: 'appendWorkflowEvent', completedEvent: 'appendWorkflowEvent' };
      const method = methods[fault];
      const original = store[method].bind(store);
      let armed = true;
      store[method] = async (...args) => {
        const value = args.at(-1);
        const matches = fault === 'boundary' ? value.episodes?.length > 3
          : fault === 'completed' ? value.stage === 'completed'
          : fault === 'receipt' ? value.consumedAt
          : fault === 'event' ? value.event === 'narrative_boundary'
          : fault === 'completedEvent' ? value.event === 'completed' : true;
        if (armed && matches) {
          armed = false;
          // Also cover a durable write whose caller observes an exception.
          if (fault === 'boundary' || fault === 'event') await original(...args);
          throw new Error(`INJECTED ${fault}`);
        }
        return original(...args);
      };
      let approvalId;
      if (autonomy === 'guided') {
        const draft = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
        approvalId = draft.approvalId;
        await assert.rejects(runWorkflowDecide({ store, workId, approvalId, action: 'approve', providers }), /INJECTED/);
      } else {
        await assert.rejects(runWriteWorkflow({ store, workId, autonomy: 'auto', providers }), /INJECTED/);
      }
      const old = await store.loadWorkflow(workId);
      const head = (await createPublicationUnit({ rootDir: store.rootDir }).readPublished()).value.head;
      const result = retry === 'approve'
        ? await runWorkflowDecide({ store, workId, approvalId, action: 'approve', providers })
        : await runWriteWorkflow({ store, workId, autonomy: 'auto', providers });
      assert.equal(result.status, 'completed');
      assert.equal(result.recovered, true);
      assert.equal(result.chapter, 1);
      assert.equal(result.workflowId, old.workflowId);
      assert.deepEqual(await store.listChapters(), [1]);
      assert.equal((await createPublicationUnit({ rootDir: store.rootDir }).readPublished()).value.head, head);
      assert.equal((await store.loadArcPlan(workId)).episodes.length, 4);
      const ledger = await loadCurrentExperienceLedger({ store, workId });
      assert.equal(ledger.sourceHead, head);
      assert.equal(ledger.status, 'fresh');
      assert.deepEqual(ledger.entries.map(e => e.chapter), [0, 1]);
      assert.equal((await store.loadWorkflow(workId, old.workflowId)).stage, 'completed');
      assert.ok((await store.loadCheckReceipt(workId, old.checkId)).consumedAt);
      const events = await store.loadWorkflowEvents(workId, old.workflowId, Infinity);
      for (const event of ['completed', 'chapter_committed', 'narrative_boundary', 'commit_postprocess_recovered']) {
        assert.equal(events.filter(e => e.event === event).length, 1, event);
      }
    });
  }
}

it('retries an unpublished ready workflow with the same receipt and no new model calls', async (t) => {
  const store = await qualityStore();
  t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  const load = store.loadReviewPolicy.bind(store);
  let armed = true;
  store.loadReviewPolicy = async (...args) => {
    const workflow = await store.loadWorkflow(workId);
    if (armed && workflow?.stage === 'ready_to_commit') {
      armed = false;
      throw new Error('INJECTED before publication');
    }
    return load(...args);
  };
  await assert.rejects(runWriteWorkflow({ store, workId, autonomy: 'auto', providers }), /INJECTED before publication/);
  const before = await store.loadWorkflow(workId);
  assert.deepEqual(await store.listChapters(), []);
  assert.equal((await store.loadCheckReceipt(workId, before.checkId)).consumedAt, null);
  const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: {
    complete() { throw new Error('must reuse the checked draft'); },
  } });
  assert.equal(result.status, 'completed');
  assert.equal(result.workflowId, before.workflowId);
  assert.equal(result.recovered, undefined);
  assert.equal((await store.loadWorkflow(workId)).checkId, before.checkId);
});

it('recovers a legacy pending workflow whose boundary was already saved without a marker', async (t) => {
  const store = await qualityStore();
  t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  await store.saveExperienceLedger(workId, { sourceHead: null, entries: [{ chapter: 0 }] });
  const save = store.saveExperienceLedger.bind(store);
  let armed = true;
  store.saveExperienceLedger = async (...args) => {
    if (armed) { armed = false; throw new Error('INJECTED ledger'); }
    return save(...args);
  };
  await assert.rejects(runWriteWorkflow({ store, workId, autonomy: 'auto', providers }), /INJECTED/);
  const workflow = await store.loadWorkflow(workId);
  delete workflow.finalization;
  delete workflow.publishedHead;
  await store.saveWorkflow(workId, workflow);
  const arc = await store.loadArcPlan(workId);
  delete arc.appliedBoundaries;
  await store.saveArcPlan(workId, arc);
  const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers });
  assert.equal(result.recovered, true);
  assert.equal(result.status, 'completed');
  assert.equal((await store.loadArcPlan(workId)).episodes.length, 4);
  assert.deepEqual((await loadCurrentExperienceLedger({ store, workId })).entries.map(e => e.chapter), [0, 1]);
});

it('recovers extend_arc and ArcReview at the final episode without extending twice', async (t) => {
  const store = await qualityStore();
  t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  const arc = await store.loadArcPlan(workId);
  // Keep just the final episode in this synthetic fixture to reach ArcReview.
  await store.saveArcPlan(workId, { ...arc, estimatedEpisodes: 1, episodes: arc.episodes.slice(0, 1) });
  const save = store.saveArcReview.bind(store);
  let armed = true;
  store.saveArcReview = async (...args) => {
    if (armed) { armed = false; throw new Error('INJECTED ArcReview'); }
    return save(...args);
  };
  await assert.rejects(runWriteWorkflow({ store, workId, autonomy: 'auto', providers }), /INJECTED/);
  const workflow = await store.loadWorkflow(workId);
  assert.equal(workflow.boundary.decision, 'extend_arc');
  assert.equal((await store.loadArcPlan(workId)).episodes.length, 2);
  const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers });
  assert.equal(result.recovered, true);
  assert.equal((await store.loadArcPlan(workId)).episodes.length, 2);
  assert.equal((await store.loadArcPlan(workId)).status, 'active');
  assert.equal((await store.loadArcReview(workId, arc.arcNumber, 1)).sourceHead, result.commit.publication.head);
});

it('guided approve can retry a pre-publication commit failure without approving twice', async (t) => {
  const store = await qualityStore();
  t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  const draft = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  const load = store.loadReviewPolicy.bind(store);
  let armed = true;
  store.loadReviewPolicy = async (...args) => {
    if (armed && (await store.loadWorkflow(workId)).stage === 'ready_to_commit') {
      armed = false;
      throw new Error('INJECTED before publication');
    }
    return load(...args);
  };
  await assert.rejects(runWorkflowDecide({ store, workId, approvalId: draft.approvalId, action: 'approve', providers }), /INJECTED/);
  assert.deepEqual(await store.listChapters(), []);
  const result = await runWorkflowDecide({ store, workId, approvalId: draft.approvalId, action: 'approve', providers });
  assert.equal(result.status, 'completed');
  assert.equal(result.workflowId, draft.workflowId);
  const events = await store.loadWorkflowEvents(workId, draft.workflowId, Infinity);
  assert.equal(events.filter(e => e.event === 'user_approved').length, 1);
});
