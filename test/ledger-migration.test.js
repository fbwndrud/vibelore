import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureLedgerLog, proposeLedgerMerges } from '../src/tools/ledger-migration.js';
import { ledgerLogStatus } from '../src/tools/ledger-log.js';
import { runConfigureStatus } from '../src/tools/configure.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';
import { promptKit } from '../src/prompts/index.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';
import { addLegacyChapters, legacyWorkWithDuplicates } from './fixtures/ledger-works.js';
import { qualityStore, outputs, workId as qualityWorkId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';

const kit = promptKit({ contract: buildLanguageContract({ language: 'ko' }) });
const answer = (groups) => ({ text: JSON.stringify({ groups }) });

test('proposes merges once per ledger and keeps only valid groups', async () => {
  const { store, workId } = await legacyWorkWithDuplicates();
  let asked = 0;
  const providers = { complete: async () => { asked += 1; return answer([
    { into: 'o1', from: ['o2'], reason: '같은 쪽지' },
    { into: 'o1', from: ['k1'], reason: '기능이 다름' },
    { into: 'o9', from: ['o1'], reason: '없는 id' }]); } };
  const first = await proposeLedgerMerges({ store, workId, providers, kit });
  assert.deepEqual(first.candidates, [{ into: 'o1', from: ['o2'], reason: '같은 쪽지' }]);
  await proposeLedgerMerges({ store, workId, providers, kit });
  assert.equal(asked, 1);
});

test('the request lists every record by feature and a record merged into itself is dropped', async () => {
  const { store, workId } = await legacyWorkWithDuplicates();
  const requests = [];
  const providers = { complete: async (req) => { requests.push(req); return answer([{ into: 'o1', from: ['o1'], reason: '자기 자신' }]); } };
  const result = await proposeLedgerMerges({ store, workId, providers, kit });
  assert.equal(result.status, 'done');
  assert.deepEqual(result.candidates, []);
  assert.equal(requests[0].step, 'ledger-merge');
  const user = requests[0].messages.map((m) => m.content).join('\n');
  for (const text of ['o1', '서명 쪽지', 'o2', '재서명된 쪽지', 'k1', '은빛 열쇠']) assert.ok(user.includes(text), text);
});

test('an unusable answer is not stored, so the ledger is asked again', async () => {
  const { store, workId } = await legacyWorkWithDuplicates();
  let asked = 0;
  const providers = { complete: async () => { asked += 1; return { text: asked === 1 ? 'not json' : JSON.stringify({ groups: [] }) }; } };
  assert.equal((await proposeLedgerMerges({ store, workId, providers, kit })).status, 'failed');
  assert.equal(await store.loadMergeCandidates(workId), null);
  assert.equal((await proposeLedgerMerges({ store, workId, providers, kit })).status, 'done');
  assert.equal(asked, 2);
});

test('a pending host answer is reported and nothing is stored', async () => {
  const { store, workId } = await legacyWorkWithDuplicates();
  const providers = { pending: [{ id: 'x' }], complete: async () => ({ text: '{}' }) };
  assert.equal((await proposeLedgerMerges({ store, workId, providers, kit })).status, 'pending');
  assert.equal(await store.loadMergeCandidates(workId), null);
});

test('a ledger with fewer than two records in every feature is not asked', async () => {
  const { store, workId } = await legacyWorkWithDuplicates();
  const state = await store.loadStoryState(workId, 2);
  await store.saveStoryState({ ...state, ledger: undefined, trackedEntities: [{ kind: 'Artifact', data: { name: '서명 쪽지' }, updatedChapter: 1 }] });
  let asked = 0;
  const result = await proposeLedgerMerges({ store, workId, providers: { complete: async () => { asked += 1; return answer([]); } }, kit });
  assert.equal(result.status, 'none');
  assert.equal(asked, 0);
});

test('ensureLedgerLog builds the log of a legacy work once and says it was legacy', async () => {
  const { store, workId } = await legacyWorkWithDuplicates();
  const first = await ensureLedgerLog({ store, workId });
  assert.deepEqual(first, { rebuilt: true, legacy: true });
  assert.equal((await ledgerLogStatus({ store, workId })).ok, true);
  assert.ok((await store.loadLedgerEvents(workId)).some((event) => event.id === 'o2' && event.event === 'registered'));
  assert.deepEqual(await ensureLedgerLog({ store, workId }), { rebuilt: false, legacy: true });
});

test('lore_configure shows the stored candidates next to the approved merges', async () => {
  const { store, workId } = await legacyWorkWithDuplicates();
  await proposeLedgerMerges({ store, workId, providers: { complete: async () => answer([{ into: 'o1', from: ['o2'], reason: '같은 쪽지' }]) }, kit });
  const shown = await runConfigureStatus({ store, workId });
  assert.deepEqual(shown.mergeCandidates, [{ into: 'o1', from: ['o2'], reason: '같은 쪽지' }]);
  assert.deepEqual(shown.merges, []);
  const approved = await runConfigureStatus({ store, workId, mergeRecords: [{ from: 'o2', into: 'o1' }] });
  assert.deepEqual(approved.merges, [{ from: 'o2', into: 'o1' }]);
});

async function legacyQualityStore() {
  const store = await qualityStore();
  await addLegacyChapters(store, qualityWorkId);
  const plan = await store.loadEpisodePlan(qualityWorkId, 1);
  await store.saveEpisodePlan(qualityWorkId, { ...plan, chapter: 3 });
  return store;
}

const workflowProviders = (steps) => ({ async complete(req) {
  steps.push(req.step);
  const contract = contractResponse(req); if (contract) return contract;
  if (req.step === 'ledger-merge') return answer([{ into: 'o1', from: ['o2'], reason: '같은 쪽지' }]);
  return { text: outputs[req.step] ?? '{}' };
} });

test('guided lore_write on a legacy work asks for merge candidates before drafting; auto never asks', async () => {
  const guided = await legacyQualityStore();
  const steps = [];
  await runWriteWorkflow({ store: guided, workId: qualityWorkId, autonomy: 'guided', providers: workflowProviders(steps) });
  assert.ok(steps.includes('ledger-merge'), steps.join(','));
  assert.ok(steps.indexOf('ledger-merge') < steps.indexOf('draft'));
  assert.deepEqual((await guided.loadMergeCandidates(qualityWorkId)).candidates, [{ into: 'o1', from: ['o2'], reason: '같은 쪽지' }]);
  assert.equal((await ledgerLogStatus({ store: guided, workId: qualityWorkId })).ok, true);

  const auto = await legacyQualityStore();
  const autoSteps = [];
  await runWriteWorkflow({ store: auto, workId: qualityWorkId, autonomy: 'auto', providers: workflowProviders(autoSteps) });
  assert.ok(!autoSteps.includes('ledger-merge'), autoSteps.join(','));
});

test('an unusable merge answer never blocks the chapter and is recorded', async () => {
  const store = await legacyQualityStore();
  const result = await runWriteWorkflow({ store, workId: qualityWorkId, autonomy: 'guided', providers: { async complete(req) {
    const contract = contractResponse(req); if (contract) return contract;
    if (req.step === 'ledger-merge') return { text: 'broken' };
    return { text: outputs[req.step] ?? '{}' };
  } } });
  assert.equal(result.status, 'awaiting_approval', JSON.stringify(result).slice(0, 300));
  const history = await store.loadWorkflowEvents(qualityWorkId, result.workflowId);
  assert.ok(history.some((event) => event.event === 'ledger_merge_incomplete'));
});

test('a pending merge request rides with the chapter plan in one host round trip', async () => {
  const { createPreflightRelay } = await import('../src/provider/host-relay.js');
  const store = await qualityStore();
  await addLegacyChapters(store, qualityWorkId);
  const relay = createPreflightRelay({});
  const result = await runWriteWorkflow({ store, workId: qualityWorkId, autonomy: 'guided', providers: relay });
  assert.equal(result.preview, true, JSON.stringify(result).slice(0, 300));
  const steps = relay.pending.map((request) => request.step);
  assert.ok(steps.includes('ledger-merge') && steps.includes('episode-plan'), steps.join(','));
});
