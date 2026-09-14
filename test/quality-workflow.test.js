import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runWriteWorkflow, runWorkflowDecide, runWorkflowHistory, proseHash } from '../src/tools/workflow.js';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';

describe('first-draft quality through the writing workflow', () => {
  it('does not publish a resumed legacy ready draft without a completed review', async () => {
    const store = await qualityStore();
    let calls = 0;
    const providers = { async complete(req) { calls++; return { text: outputs[req.step] ?? '{}' }; } };
    await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
    const workflow = await store.loadWorkflow(workId);
    const receipt = await store.loadCheckReceipt(workId, workflow.checkId);
    delete receipt.review;
    await store.saveCheckReceipt(workId, receipt);
    workflow.stage = 'ready_to_commit';
    await store.saveWorkflow(workId, workflow);
    const before = calls;
    const resumed = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers });
    assert.equal(resumed.status, 'awaiting_approval');
    assert.equal(resumed.degraded.code, 'CRITIC_INCOMPLETE');
    assert.equal(calls, before);
    assert.deepEqual(await store.listChapters(), []);
  });

  it('delivers approved voice and prior knowledge, preserves high-score findings and replays exact exchanges', async () => {
    const store = await qualityStore();
    const requests = [];
    const finding = { code: 'OVERLONG_DENSITY', message: '현장 설명이 길다', evidence: '문', confidence: 0.81, scope: 'chapter' };
    const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: {
      provenance: { kind: 'test', contextIsolation: 'request-messages-only' },
      async complete(req) {
        requests.push(req);
        return { text: req.step === 'editorial-quality' ? JSON.stringify({ score: 87, dimensions: { density: 80 }, findings: [finding] }) : outputs[req.step] ?? '{}' };
      },
    } });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const draft = requests.find((req) => req.step === 'draft');
    const text = draft.messages.map((m) => m.content).join('\n');
    assert.match(text, /놀이를 실제로 즐기는 약속/);
    assert.match(text, /능청스럽게/);
    assert.match(text, /2006.*2026/);
    assert.match(text, /지도 확대는 이미 배웠다/);
    assert.match(text, /지도는 배웠다. 이제 바다/);
    assert.match(text, /세상은 구했으니/);
    const editorialText = requests.find((req) => req.step === 'editorial-quality').messages.map((m) => m.content).join('\n');
    assert.doesNotMatch(editorialText, /EpisodePlan|놀이를 실제로 즐기는 약속/);
    assert.equal(requests.filter((req) => req.step === 'revise').length, 0);
    assert.ok(result.quality.advisories.some((item) => item.code === 'OVERLONG_DENSITY'));
    assert.equal(result.quality.review.status, 'completed');
    const workflow = await store.loadWorkflow(workId);
    const receipt = await store.loadCheckReceipt(workId, workflow.checkId);
    assert.equal(receipt.review.proseHash, receipt.proseHash);
    assert.equal(receipt.review.records.find((r) => r.step === 'editorial-quality').findings[0].message, finding.message);
    const concise = await runWorkflowHistory({ store, workId });
    assert.equal(concise.modelExchanges, undefined);
    const history = await runWorkflowHistory({ store, workId, includeModelExchanges: true });
    assert.ok(history.events.some((e) => e.event === 'runtime_identified' && e.runtime.sourceTreeHash.startsWith('sha256:')));
    const saved = history.modelExchanges.find((item) => item.exchange.request.step === 'draft');
    assert.deepEqual(saved.exchange.request, draft);
    assert.equal(history.events.filter((e) => e.event === 'reviews_completed').length, 1);
  });

  for (const failure of ['malformed', 'missing', 'exception']) {
    it(`preserves the auto draft for guided approval after a ${failure} review`, async () => {
      const store = await qualityStore();
      let calls = 0;
      const providers = { async complete(req) {
        calls++;
        if (req.step === 'editorial-quality') {
          if (failure === 'exception') throw new Error('provider unavailable');
          return { text: failure === 'malformed' ? '{no json' : '{}' };
        }
        return { text: outputs[req.step] ?? '{}' };
      } };
      const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers });
      assert.equal(result.status, 'awaiting_approval');
      assert.equal(result.degraded.code, 'CRITIC_INCOMPLETE');
      assert.equal(result.quality.review.status, 'failed');
      assert.deepEqual(await store.listChapters(), []);
      const count = calls;
      const again = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers });
      assert.equal(calls, count);
      assert.equal(again.approvalId, result.approvalId);
      assert.equal(again.degraded.code, result.degraded.code);
      const approved = await runWorkflowDecide({ store, workId, approvalId: result.approvalId, action: 'approve', providers });
      assert.equal(approved.status, 'completed');
      const workflow = await store.loadWorkflow(workId);
      const receipt = await store.loadCheckReceipt(workId, workflow.checkId);
      assert.equal(receipt.proseHash, proseHash(result.prose));
      assert.equal(receipt.review.status, 'failed');
      assert.ok(receipt.consumedAt);
    });
  }
});
