import test from 'node:test';
import assert from 'node:assert/strict';

import { runWriteWorkflow } from '../src/tools/workflow.js';
import { runConfigureStatus } from '../src/tools/configure.js';
import { loadLedgerConfig, saveWriterSupportPolicy } from '../src/core/review-policy.js';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';

function memoryStore() {
  let policy = null;
  return { loadReviewPolicy: async () => policy, saveReviewPolicy: async (_w, next) => { policy = next; } };
}

test('stores tracking switches, author items with stable ids, and merges', async () => {
  const store = memoryStore();
  await saveWriterSupportPolicy(store, 'w', { tracking: { scheduled: false }, customTracking: [{ name: '금화', feature: 'objects', pinned: true, rules: [{ type: 'monotonic', field: 'amount', direction: 'down' }] }] });
  await saveWriterSupportPolicy(store, 'w', { customTracking: [{ name: '계절', feature: 'objects', pinned: true }, { name: '금화', feature: 'objects', pinned: true }], mergeRecords: [{ from: 'o3', into: 'o1' }] });
  const config = await loadLedgerConfig(store, 'w');
  assert.deepEqual(config.tracking, { scheduled: false });
  assert.deepEqual(config.customTracking.map((item) => [item.id, item.name]), [['u2', '계절'], ['u1', '금화']]);
  assert.deepEqual(config.merges, [{ from: 'o3', into: 'o1' }]);
  await assert.rejects(saveWriterSupportPolicy(store, 'w', { tracking: { genre: true } }), /INVALID_TRACKING_FEATURE/);
  await assert.rejects(saveWriterSupportPolicy(store, 'w', { customTracking: [{ name: 'x', feature: 'objects', rules: [{ type: 'magic' }] }] }), /INVALID_CUSTOM_TRACKING/);
});

test('lore_configure result exposes tracking switches, author items and merges', async () => {
  const store = await qualityStore();
  const status = await runConfigureStatus({
    store, workId,
    tracking: { scheduled: false },
    customTracking: [{ name: '금화', feature: 'objects', pinned: true }],
  });
  assert.deepEqual(status.tracking.enabled, { objects: true, knowledge: true, scheduled: false, hooks: true });
  assert.deepEqual(status.tracking.available, ['objects', 'knowledge', 'scheduled', 'hooks']);
  assert.deepEqual(status.customTracking.map((item) => item.name), ['금화']);
  assert.deepEqual(status.merges, []);
});

test('lore_configure stores which reviews are off and rejects names it does not know', async () => {
  const store = await qualityStore();
  const status = await runConfigureStatus({ store, workId, disabledReviews: ['editorial-quality', 'character-fidelity'] });
  assert.deepEqual(status.reviewPolicy.disabled, ['editorial-quality', 'character-fidelity']);
  assert.ok(status.reviewPolicy.available.includes('reader-hook'));
  assert.deepEqual((await runConfigureStatus({ store, workId })).reviewPolicy.disabled, ['editorial-quality', 'character-fidelity']);
  await assert.rejects(runConfigureStatus({ store, workId, disabledReviews: ['continuity-check'] }), /continuity-check/);
});

test('turned-off reviews are not requested, auto still commits, and the result says which were off', async () => {
  const store = await qualityStore();
  await runConfigureStatus({ store, workId, disabledReviews: ['editorial-quality', 'character-fidelity', 'story-profile-check'] });
  const steps = [];
  const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: { async complete(req) { steps.push(req.step); const contract = contractResponse(req); if (contract) return contract; return { text: outputs[req.step] ?? '{}' }; } } });
  assert.equal(result.status, 'completed', JSON.stringify(result).slice(0, 400));
  for (const step of ['editorial-quality', 'character-fidelity', 'story-profile-check']) assert.ok(!steps.includes(step), step);
  assert.ok(steps.includes('reader-hook'));
  assert.deepEqual([...result.quality.disabledReviews].sort(), ['character-fidelity', 'editorial-quality', 'story-profile-check']);
});

test('with the pattern review off no placeholder entry is written to the experience ledger', async () => {
  const store = await qualityStore();
  await runConfigureStatus({ store, workId, disabledReviews: ['pattern-ledger'] });
  const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: { async complete(req) { const contract = contractResponse(req); if (contract) return contract; return { text: outputs[req.step] ?? '{}' }; } } });
  assert.equal(result.status, 'completed');
  const { loadCurrentExperienceLedger } = await import('../src/core/experience-ledger.js');
  const ledger = await loadCurrentExperienceLedger({ store, workId });
  assert.equal(ledger.entries.filter((entry) => entry.chapter === 1).length, 0, JSON.stringify(ledger.entries));
});

test('a turned-off profile check is listed in the review audit like the other reviews', async () => {
  const store = await qualityStore();
  await runConfigureStatus({ store, workId, disabledReviews: ['story-profile-check'] });
  await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: { async complete(req) { const contract = contractResponse(req); if (contract) return contract; return { text: outputs[req.step] ?? '{}' }; } } });
  const workflow = await store.loadWorkflow(workId);
  assert.ok(workflow.quality.review.disabled.includes('story-profile-check'), JSON.stringify(workflow.quality.review.disabled));
});
