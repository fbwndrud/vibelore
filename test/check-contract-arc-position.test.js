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

test('contract check shows the extractor known entities and flags a destroyed one mentioned again', async () => {
  const store = await qualityStore();
  await store.saveEntitySnapshots(workId, [
    { entityId: 'bridge-sword', kind: 'item', canonicalName: '다리검', aliases: [], status: 'destroyed', attrs: {}, registeredAtChapter: 1 },
  ]);
  const requests = [];
  const recording = { pending: [], async complete(req) { requests.push(req); return contractResponse(req) ?? { text: '{}' }; } };
  const result = await runContractCheck({ store, workId, chapter: 1, prose: `${SYNTHETIC_LONG_PROSE}\n\n그는 다리검을 다시 뽑았다.`, title: '첫 문', providers: recording, issueReceipt: false });
  const extraction = requests.find((req) => req.step === 'continuity-extract');
  assert.ok(extraction, requests.map((req) => req.step).join(','));
  assert.match(extraction.messages.map((m) => m.content).join('\n'), /"knownEntities":\[\{"entityId":"bridge-sword"/);
  const mention = result.violations.find((violation) => violation.code === 'DESTROYED_ENTITY_MENTION');
  assert.equal(mention?.severity, 'soft');
});
