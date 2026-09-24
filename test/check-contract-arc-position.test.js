import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runContractCheck } from '../src/tools/check-contract.js';
import { qualityStore, workId } from './fixtures/quality-workflow.js';
import { SYNTHETIC_LONG_PROSE } from './fixtures/synthetic-prose.js';
import { contractResponse } from './fixtures/contract-response.js';

const providers = { pending: [], async complete(req) { return contractResponse(req) ?? { text: '{}' }; } };

async function scanWithArc(estimatedEpisodes, index) {
  const store = await qualityStore();
  const arc = await store.loadArcPlan(workId);
  await store.saveArcPlan(workId, { ...arc, estimatedEpisodes, episodes: [{ ...arc.episodes[0], index }] });
  const result = await runContractCheck({ store, workId, chapter: 1, prose: SYNTHETIC_LONG_PROSE, title: '첫 문', providers, issueReceipt: false });
  return result.violations.map((violation) => violation.code);
}

test('contract check passes the arc position so a closing chapter keeps the cliffhanger advisory', async () => {
  const closing = await scanWithArc(6, 6);
  assert.ok(closing.includes('CLIFFHANGER_MISSING'), JSON.stringify(closing));
  const rising = await scanWithArc(6, 2);
  assert.ok(!rising.includes('CLIFFHANGER_MISSING'), JSON.stringify(rising));
});
