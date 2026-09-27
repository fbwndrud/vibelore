import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureLedgerLog, proposeLedgerMerges } from '../src/tools/ledger-migration.js';
import { ledgerBaseState, ledgerLogStatus, rebuildLedgerLog } from '../src/tools/ledger-log.js';
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
  const pending = [];
  const providers = { pending, complete: async (req) => { pending.push(req); return { text: '{}' }; } };
  assert.equal((await proposeLedgerMerges({ store, workId, providers, kit })).status, 'pending');
  assert.equal(await store.loadMergeCandidates(workId), null);
});

const record = (id, feature, name, extra = {}) => ({ id, feature, label: '', name, aliases: [], status: feature === 'knowledge' ? 'secret' : 'active', fields: {}, registeredAt: 1, recent: [], ...extra });
async function saveLedgerState(store, workId, records) {
  const state = await store.loadStoryState(workId, 2);
  await store.saveStoryState({ ...state, trackedEntities: [], ledger: { records } });
}

test('a ledger with no flagged pair and no legacy migration is not asked', async () => {
  const { store, workId } = await legacyWorkWithDuplicates();
  await saveLedgerState(store, workId, [record('o1', 'objects', '서명 쪽지'), record('o2', 'objects', '낡은 검')]);
  let asked = 0;
  const result = await proposeLedgerMerges({ store, workId, providers: { complete: async () => { asked += 1; return answer([]); } }, kit });
  assert.equal(result.status, 'none');
  assert.equal(asked, 0);
});

test('declined candidates are not asked again; a new flagged pair is asked about alone', async () => {
  const { store, workId } = await legacyWorkWithDuplicates();
  const requests = [];
  let groups = [{ into: 'o1', from: ['o2'], reason: '같은 쪽지' }];
  const providers = { complete: async (req) => { requests.push(req); return answer(groups); } };
  await proposeLedgerMerges({ store, workId, providers, kit });
  assert.equal(requests.length, 1, 'the legacy migration is asked once');
  // The user does not approve; the next chapter commits a ledger with the same flag.
  await saveLedgerState(store, workId, [record('o1', 'objects', '서명 쪽지'), record('k1', 'knowledge', '은빛 열쇠'),
    record('o2', 'objects', '재서명된 쪽지', { possibleDuplicateOf: 'o1' })]);
  assert.equal((await proposeLedgerMerges({ store, workId, providers, kit })).status, 'none');
  assert.equal(requests.length, 1, 'no new flag, nothing asked');
  // A later chapter flags a new pair.
  await saveLedgerState(store, workId, [record('o1', 'objects', '서명 쪽지'), record('k1', 'knowledge', '은빛 열쇠'),
    record('o2', 'objects', '재서명된 쪽지', { possibleDuplicateOf: 'o1' }), record('o3', 'objects', '서명 쪽지 사본', { possibleDuplicateOf: 'o1' })]);
  groups = [{ into: 'o1', from: ['o3'], reason: '사본도 같은 쪽지' }];
  const third = await proposeLedgerMerges({ store, workId, providers, kit });
  assert.equal(requests.length, 2);
  const user = requests[1].messages.map((m) => m.content).join('\n');
  assert.ok(user.includes('"o3"') && user.includes('"o1"'), user);
  assert.ok(!user.includes('"o2"') && !user.includes('"k1"'), user);
  assert.deepEqual(third.candidates, [{ into: 'o1', from: ['o2'], reason: '같은 쪽지' }, { into: 'o1', from: ['o3'], reason: '사본도 같은 쪽지' }]);
  assert.deepEqual((await store.loadMergeCandidates(workId)).candidates, third.candidates);
  assert.equal((await proposeLedgerMerges({ store, workId, providers, kit })).status, 'none');
  assert.equal(requests.length, 2);
});

test('a group may not reuse a record already merged from or into', async () => {
  const { store, workId } = await legacyWorkWithDuplicates();
  const result = await proposeLedgerMerges({ store, workId, providers: { complete: async () => answer([
    { into: 'o1', from: ['o2'], reason: 'a' },
    { into: 'o2', from: ['o1'], reason: 'into was a from' },
    { into: 'o1', from: ['o2'], reason: 'from reused' }]) }, kit });
  assert.deepEqual(result.candidates, [{ into: 'o1', from: ['o2'], reason: 'a' }]);
  const { store: other } = await legacyWorkWithDuplicates();
  await saveLedgerState(other, workId, [record('o1', 'objects', '서명 쪽지'), record('o2', 'objects', '재서명된 쪽지', { possibleDuplicateOf: 'o1' }),
    record('o3', 'objects', '쪽지 조각', { possibleDuplicateOf: 'o1' })]);
  const chained = await proposeLedgerMerges({ store: other, workId, providers: { complete: async () => answer([
    { into: 'o1', from: ['o2'], reason: 'a' },
    { into: 'o3', from: ['o1'], reason: 'from was an into' }]) }, kit });
  assert.deepEqual(chained.candidates, [{ into: 'o1', from: ['o2'], reason: 'a' }]);
});

test('ensureLedgerLog builds the log of a legacy work once', async () => {
  const { store, workId } = await legacyWorkWithDuplicates();
  assert.deepEqual(await ensureLedgerLog({ store, workId }), { rebuilt: true });
  assert.equal((await ledgerLogStatus({ store, workId })).ok, true);
  assert.ok((await store.loadLedgerEvents(workId)).some((event) => event.id === 'o2' && event.event === 'registered'));
  assert.deepEqual(await ensureLedgerLog({ store, workId }), { rebuilt: false });
});

test('lore_configure shows the stored candidates next to the approved merges', async () => {
  const { store, workId } = await legacyWorkWithDuplicates();
  await proposeLedgerMerges({ store, workId, providers: { complete: async () => answer([{ into: 'o1', from: ['o2'], reason: '같은 쪽지' }]) }, kit });
  const shown = await runConfigureStatus({ store, workId });
  assert.deepEqual(shown.mergeCandidates, [{ into: 'o1', from: ['o2'], reason: '같은 쪽지' }]);
  assert.deepEqual(shown.merges, []);
  const approved = await runConfigureStatus({ store, workId, mergeRecords: [{ from: 'o2', into: 'o1' }] });
  assert.deepEqual(approved.merges, [{ from: 'o2', into: 'o1', atChapter: 3 }]);
  assert.deepEqual(approved.mergeCandidates, [], 'an approved candidate is no longer offered');
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

test('a legacy work builds on the ledger its delta replay ends with, ids and names as in the log', async () => {
  // The last legacy state kept only the renamed note; ledgerFromLegacy alone would call it o1.
  const { store, workId } = await legacyWorkWithDuplicates({ keepLast: [{ kind: 'Artifact', data: { name: '재서명된 쪽지', holder: 'c2' }, updatedChapter: 2 }] });
  const base = await ledgerBaseState({ store, workId, chapter: 2 });
  const { events } = await rebuildLedgerLog({ store, workId });
  const registered = events.filter((event) => event.event === 'registered').map((event) => event.id);
  assert.deepEqual(base.ledger.records.map((record) => [record.id, record.name]), [['o1', '서명 쪽지'], ['k1', '은빛 열쇠'], ['o2', '재서명된 쪽지']]);
  assert.deepEqual(base.ledger.records.map((record) => record.id).sort(), registered.sort());
  assert.equal(base.ledger.records.find((record) => record.id === 'o2').possibleDuplicateOf, 'o1');
  assert.equal(base.chapterNumber, 2);
  assert.deepEqual(base.hooks.map((hook) => hook.id), ['wrist']);

  // A merge approved on a live id applies from the next chapter: the chapters written keep their history,
  // and the state the next chapter builds on has the merged record.
  await runConfigureStatus({ store, workId, mergeRecords: [{ from: 'o2', into: 'o1' }] });
  const { loadLedgerConfig } = await import('../src/core/review-policy.js');
  const rebuilt = await rebuildLedgerLog({ store, workId, config: await loadLedgerConfig(store, workId) });
  assert.deepEqual(rebuilt.events.filter((event) => event.event === 'merged'), []);
  const merged = (await ledgerBaseState({ store, workId, chapter: 2 })).ledger.records.find((record) => record.id === 'o1');
  assert.equal(merged.name, '서명 쪽지');
  assert.deepEqual(merged.mergedIds, ['o2']);
});

test('a state that carries a ledger is used as it is, without a replay', async () => {
  const { store, workId } = await legacyWorkWithDuplicates();
  const state = await store.loadStoryState(workId, 2);
  const ledger = { records: [{ id: 'o7', feature: 'objects', label: '', name: '새 기록', aliases: [], status: 'active', fields: {}, registeredAt: 2, recent: [] }] };
  await store.saveStoryState({ ...state, trackedEntities: [], ledger });
  assert.deepEqual((await ledgerBaseState({ store, workId, chapter: 2 })).ledger.records.map((record) => record.id), ['o7']);
  // No chapter yet: the seeded state.
  assert.deepEqual((await ledgerBaseState({ store, workId, chapter: 0 })).ledger.records, []);
});

test('a work is legacy when its latest state has no ledger of its own, whatever it tracked', async () => {
  const { store, workId } = await legacyWorkWithDuplicates({ keepLast: [] });
  let asked = 0;
  const providers = { complete: async () => { asked += 1; return answer([]); } };
  assert.equal((await proposeLedgerMerges({ store, workId, providers, kit })).status, 'done');
  assert.equal(asked, 1, 'legacy: asked even though the last state tracked nothing');
  const { store: current } = await legacyWorkWithDuplicates();
  await current.saveStoryState({ ...(await current.loadStoryState(workId, 2)), trackedEntities: [{ kind: 'Artifact', data: { name: '서명 쪽지' } }],
    ledger: { records: [record('o1', 'objects', '서명 쪽지'), record('o2', 'objects', '낡은 검')] } });
  assert.equal((await proposeLedgerMerges({ store: current, workId, providers, kit })).status, 'none');
  assert.equal(asked, 1);
});
