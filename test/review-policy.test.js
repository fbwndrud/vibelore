import test from 'node:test';
import assert from 'node:assert/strict';

import { runWriteWorkflow } from '../src/tools/workflow.js';
import { runConfigureStatus } from '../src/tools/configure.js';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';

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
