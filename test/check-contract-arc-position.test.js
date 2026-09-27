import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runContractCheck } from '../src/tools/check-contract.js';
import { qualityStore, workId } from './fixtures/quality-workflow.js';
import { SYNTHETIC_LONG_PROSE } from './fixtures/synthetic-prose.js';
import { contractResponse } from './fixtures/contract-response.js';
import { loadValidationSession, saveValidationSession } from '../src/core/validation-context.js';
import { reviewLedgerOps } from '../engine/src/continuity/ledger.js';
import { emptyStoryState } from '../engine/src/continuity/story-state.js';

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

// Runs the check with extra fields merged into the canned extraction answer,
// on top of a saved chapter-0 state when one is given. `extraction` may be a
// function of the extraction call count, for answers that change on a re-ask.
async function checkWithExtraction(extraction, { prevState, issueReceipt = false, prose = SYNTHETIC_LONG_PROSE, store: given } = {}) {
  const store = given ?? await qualityStore();
  if (prevState) await store.saveStoryState({ ...emptyStoryState(workId), chapterNumber: 0, ...prevState });
  const extractions = [];
  const provider = { pending: [], async complete(req) {
    const answer = contractResponse(req);
    if (req.step !== 'continuity-extract' || !answer) return answer ?? { text: '{}' };
    extractions.push(req);
    const extra = typeof extraction === 'function' ? extraction(extractions.length) : extraction;
    return { text: JSON.stringify({ ...JSON.parse(answer.text), ...extra }) };
  } };
  const result = await runContractCheck({ store, workId, chapter: 1, prose, title: '첫 문', providers: provider, issueReceipt });
  return { ...result, store, extractions };
}

const destroyedSword = { ledger: { records: [{ id: 'o2', feature: 'objects', label: '물건', name: '낡은 검', aliases: [], status: 'destroyed', fields: {}, recent: [] }] } };
const repairSword = { ledgerOps: [{ op: 'event', id: 'o2', event: 'changed', set: { state: '수리' } }] };

test('a paid hook without a quote is stored as advanced and reported', async () => {
  const result = await checkWithExtraction({
    ledgerOps: [{ op: 'hook', id: 'h1', event: 'paid', evidence: '본문에 없는 문장' }],
  }, { prevState: { hooks: [{ id: 'h1', text: '누가', status: 'open' }] } });
  assert.equal(result.delta.ledgerOps[0].event, 'advanced');
  assert.ok(result.violations.some((v) => v.code === 'HOOK_PAID_WITHOUT_EVIDENCE' && v.severity === 'soft'), JSON.stringify(result.violations.map((v) => v.code)));
  // Each run reviews the stored ops again; a reviewed list stays as it is.
  const again = reviewLedgerOps({ state: { hooks: [{ id: 'h1', text: '누가', status: 'open' }] }, ops: result.delta.ledgerOps, prose: SYNTHETIC_LONG_PROSE });
  assert.deepEqual(again.ops, result.delta.ledgerOps);
});

test('the receipt carries the reviewed ledger ops, so commit stores the downgraded hook', async () => {
  const result = await checkWithExtraction({
    ledgerOps: [{ op: 'hook', id: 'h1', event: 'paid', evidence: '본문에 없는 문장' }],
  }, { prevState: { hooks: [{ id: 'h1', text: '누가', status: 'open' }] }, issueReceipt: true });
  assert.ok(result.checkId, JSON.stringify({ status: result.status, code: result.code, violations: result.violations?.map((v) => v.code) }));
  const receipt = await result.store.loadCheckReceipt(workId, result.checkId);
  assert.equal(receipt.delta.ledgerOps[0].event, 'advanced');
  assert.equal(receipt.artifact.semanticDelta.ledgerOps[0].event, 'advanced');
});

test('a destroyed record changed by the extraction is asked again once, without spending an attempt', async () => {
  const result = await checkWithExtraction((call) => (call === 1 ? repairSword : { ledgerOps: [] }), { prevState: destroyedSword });
  assert.equal(result.extractions.length, 2);
  assert.equal(result.validationComplete, true, JSON.stringify({ status: result.status, codes: result.violations.map((v) => v.code) }));
  assert.ok(!result.violations.some((v) => v.code === 'LEDGER_UPDATE_AFTER_DESTROY'));
  const session = await loadValidationSession(result.store, workId, 'manual-1');
  assert.equal(session.failures, 0);
  const asked = (req) => req.messages.map((m) => m.content).join('\n').includes('Ledger records "낡은 검"');
  assert.deepEqual(result.extractions.map(asked), [false, true]);
  // The re-ask is spent once it is answered: later extractions in the session are not steered by it.
  assert.equal(session.ledgerRecheck, undefined);
});

test('changing a destroyed record again after the re-ask is a hard violation that blocks the check', async () => {
  const result = await checkWithExtraction(repairSword, { prevState: destroyedSword });
  assert.equal(result.extractions.length, 2);
  const hard = result.violations.find((v) => v.code === 'LEDGER_UPDATE_AFTER_DESTROY');
  assert.equal(hard?.severity, 'hard', JSON.stringify(result.violations.map((v) => v.code)));
  assert.match(hard.message, /낡은 검/);
  assert.match(hard.message, /changed/);
  assert.match(hard.message, /수리/);
  assert.equal(result.status, 'validation_incomplete');
  assert.notEqual(result.validationComplete, true);
  assert.equal(result.validationAttempts, 1);
});

test('a hard custom rule blocks at once, without a re-ask', async () => {
  const store = await qualityStore();
  await store.saveReviewPolicy(workId, { customTracking: [{ id: 'o3', name: '금화', feature: 'objects', rules: [{ type: 'monotonic', field: 'amount', direction: 'down', severity: 'hard' }] }] });
  const result = await checkWithExtraction({ ledgerOps: [{ op: 'event', id: 'o3', event: 'changed', set: { amount: '12' } }] }, { store,
    prevState: { ledger: { records: [{ id: 'o3', feature: 'objects', label: '물건', name: '금화', aliases: [], status: 'present', fields: { amount: '10' }, recent: [] }] } } });
  assert.equal(result.extractions.length, 1);
  assert.ok(result.violations.some((v) => v.code === 'CUSTOM_RULE_MONOTONIC' && v.severity === 'hard'), JSON.stringify(result.violations.map((v) => v.code)));
  assert.equal(result.status, 'validation_incomplete');
});

test('ledger findings follow the current config on every run of a session', async () => {
  const store = await qualityStore();
  await store.saveStoryState({ ...emptyStoryState(workId), chapterNumber: 0,
    ledger: { records: [{ id: 'o3', feature: 'objects', label: '물건', name: '금화', aliases: [], status: 'present', fields: { amount: '10' }, recent: [] }] } });
  const extraction = { ledgerOps: [{ op: 'event', id: 'o3', event: 'changed', set: { amount: '12' } }] };
  const provider = { pending: [], async complete(req) {
    const answer = contractResponse(req);
    if (req.step !== 'continuity-extract' || !answer) return answer ?? { text: '{}' };
    return { text: JSON.stringify({ ...JSON.parse(answer.text), ...extraction }) };
  } };
  const run = () => runContractCheck({ store, workId, chapter: 1, prose: SYNTHETIC_LONG_PROSE, title: '첫 문', providers: provider, issueReceipt: false, includeSemanticContinuity: false });
  const before = await run();
  assert.ok(!before.violations.some((v) => v.code === 'CUSTOM_RULE_MONOTONIC'));
  await store.saveReviewPolicy(workId, { customTracking: [{ id: 'o3', name: '금화', feature: 'objects', rules: [{ type: 'monotonic', field: 'amount', direction: 'down' }] }] });
  const after = await run();
  assert.ok(after.violations.some((v) => v.code === 'CUSTOM_RULE_MONOTONIC' && v.severity === 'soft'), JSON.stringify(after.violations.map((v) => v.code)));
});

test('an extraction saved before ledger ops existed still checks when replayed', async () => {
  const store = await qualityStore();
  const run = (extra = {}) => runContractCheck({ store, workId, chapter: 1, prose: SYNTHETIC_LONG_PROSE, title: '첫 문', providers, issueReceipt: false, ...extra });
  await run({ includeSemanticContinuity: false });
  const session = await loadValidationSession(store, workId, 'manual-1');
  const { ledgerOps, ...legacyDelta } = session.extracted.delta;
  await saveValidationSession(store, workId, 'manual-1', { ...session, extracted: { ...session.extracted, delta: legacyDelta } });
  const result = await run();
  assert.equal(result.validationComplete, true, JSON.stringify({ status: result.status, code: result.code, error: result.validationError }));
  assert.ok(!result.violations.some((v) => v.code.startsWith('LEDGER_')), JSON.stringify(result.violations.map((v) => v.code)));
});
