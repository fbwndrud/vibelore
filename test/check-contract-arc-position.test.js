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
  assert.match(extraction.messages.map((m) => m.content).join('\n'), /`bridge-sword` \[item\] 다리검 · destroyed/);
  const mention = result.violations.find((violation) => violation.code === 'DESTROYED_ENTITY_MENTION');
  assert.equal(mention?.severity, 'soft');
});

test('contract check surfaces an address entry the extractor could not support', async () => {
  const store = await qualityStore();
  const foundation = await store.loadFoundation(workId);
  const [first] = foundation.characters;
  const provider = { pending: [], async complete(req) {
    const answer = contractResponse(req);
    if (req.step !== 'continuity-extract' || !answer) return answer ?? { text: '{}' };
    const parsed = JSON.parse(answer.text);
    parsed.newAddressEntries = [{ speakerId: first.id, targetId: first.id, term: 'NOT_IN_PROSE_TERM', register: 'formal' }];
    return { text: JSON.stringify(parsed) };
  } };
  const result = await runContractCheck({ store, workId, chapter: 1, prose: SYNTHETIC_LONG_PROSE, title: '첫 문', providers: provider, issueReceipt: false });
  const warning = result.violations.find((violation) => violation.code === 'ADDRESS_ENTRY_REJECTED');
  assert.equal(warning?.severity, 'soft', JSON.stringify(result.violations.map((v) => v.code)));
  assert.deepEqual(result.delta?.newAddressEntries ?? [], []);
});

test('extract and check requests carry text sections, not JSON, before the output schema', async () => {
  const store = await qualityStore();
  const requests = [];
  const recording = { pending: [], async complete(req) { requests.push(req); return contractResponse(req) ?? { text: '{}' }; } };
  await runContractCheck({ store, workId, chapter: 1, prose: SYNTHETIC_LONG_PROSE, title: '첫 문', providers: recording, issueReceipt: false });
  for (const step of ['continuity-extract', 'continuity-check']) {
    const request = requests.find((req) => req.step === step);
    assert.ok(request, `${step}: ${requests.map((req) => req.step).join(',')}`);
    const user = request.messages.find((m) => m.role === 'user').content;
    const input = user.slice(0, user.indexOf('## 본문'));
    assert.doesNotMatch(input, /[{}]|\["/, `${step} input has no JSON`);
  }
  const check = requests.find((req) => req.step === 'continuity-check').messages.find((m) => m.role === 'user').content;
  assert.match(check, /\[foundation\.characters\[0\]\]/);
});

test('the profile check reads the profile, beat and deferred results as text instead of profile and plan JSON', async () => {
  const store = await qualityStore();
  const requests = [];
  const recording = { pending: [], async complete(req) { requests.push(req); return contractResponse(req) ?? { text: '{}' }; } };
  await runContractCheck({ store, workId, chapter: 1, prose: SYNTHETIC_LONG_PROSE, title: '첫 문', providers: recording, issueReceipt: false });
  const request = requests.find((req) => req.step === 'story-profile-check');
  assert.ok(request, requests.map((req) => req.step).join(','));
  const user = request.messages.find((m) => m.role === 'user').content;
  const input = user.slice(0, user.lastIndexOf('JSON:'));
  assert.doesNotMatch(input, /[{}]|\["/, 'no JSON before the output schema');
  assert.match(input, /## 승인된 작품 StoryProfile/);
  assert.match(input, /윤재 \(hero\)/);
});
