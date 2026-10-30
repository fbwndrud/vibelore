import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { createPreflightRelay } from '../src/provider/host-relay.js';
import { runCreativeDecisionTool } from '../src/tools/creative-decisions.js';
import { runConfigureStatus } from '../src/tools/configure.js';
import { runWriteWorkflow, runWorkflowDecide } from '../src/tools/workflow.js';
import { creativePreferencePin } from '../src/core/creative-decision-ledger.js';

const casual = { action: 'adopt', level: 'subject', subjectId: 'hero', statement: '윤재는 누구에게나 반말을 쓴다.', userAnswer: 'USER_WORDS 윤재는 항상 반말로 말해' };
const drier = { action: 'adopt', level: 'work', statement: '서술은 감정어를 줄이고 건조하게 쓴다.', userAnswer: 'USER_WORDS 좀 더 건조하게' };
const decide = (store, args) => runCreativeDecisionTool({ store, workId, ...args });
const INSERTED = '조용히 손을 내렸다.';
const REVISE = JSON.stringify({ replacements: [], insertions: [{ afterParagraph: 1, text: INSERTED }] });

const text = (req) => req.messages.map((message) => message.content).join('\n');
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

/** Direct provider; `overrides` replaces a step's answer, `hooks` run before it is answered. */
function recordingProvider({ overrides = {}, hooks = {} } = {}) {
  const requests = [];
  return {
    requests,
    async complete(req) {
      requests.push(req);
      await hooks[req.step]?.(req);
      if (overrides[req.step] !== undefined) return { text: overrides[req.step] };
      return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' };
    },
  };
}
const stepRequests = (providers, step) => providers.requests.filter((req) => req.step === step);

// Relay passes as lore_write runs them in production (src/server.js providerFor).
function relayAnswer(request, overrides = {}) {
  if (overrides[request.step] !== undefined) return overrides[request.step];
  return contractResponse({ step: request.step, messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }] })?.text
    ?? outputs[request.step] ?? '{}';
}
async function relayPass(store, answers = {}, args = {}) {
  const relay = createPreflightRelay(answers);
  const result = await runWriteWorkflow({ store, workId, autonomy: 'guided', ...args, providers: relay });
  return { result, pending: relay.pending };
}
async function driveRelay(store, answers = {}, { overrides = {}, args = {}, maxPasses = 12 } = {}) {
  const acc = { ...answers };
  const steps = [];
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const { result, pending } = await relayPass(store, acc, args);
    if (!pending.length) return { result, answers: acc, steps };
    for (const request of pending) { steps.push(request.step); acc[request.id] = relayAnswer(request, overrides); }
  }
  throw new Error('the relay did not settle');
}

const events = async (store, workflowId) => store.loadWorkflowEvents(workId, workflowId, 1000);

/** Every passed, unconsumed and live receipt must bind the ledger revision the workflow judged. */
async function assertNoForeignReceipt(store) {
  const dir = join(store.rootDir, '.vibelore', 'check-receipts');
  const files = await readdir(dir).catch(() => []);
  const sessions = (await store.loadValidationState(workId))?.sessions ?? {};
  for (const file of files) {
    const receipt = JSON.parse(await readFile(join(dir, file), 'utf8'));
    if (receipt.verdict !== 'passed' || receipt.consumedAt || receipt.stale) continue;
    const workflow = await store.loadWorkflow(workId);
    const session = sessions[receipt.validationScope];
    assert.equal(creativePreferencePin(session?.plans?.decisions ?? null, workId).revision, workflow.creativePreferences?.revision,
      `receipt ${receipt.checkId} binds another preference set than the workflow pin`);
  }
}

test('the workflow pins the set before its first draft and a relay resume reuses the draft answer after an adoption', async () => {
  const store = await qualityStore();
  const first = await relayPass(store);
  assert.equal(first.result.operation, 'draft', JSON.stringify(first.result).slice(0, 300));
  const draftRequests = first.pending.filter((request) => request.step === 'draft');
  assert.equal(draftRequests.length, 1);
  assert.deepEqual((await store.loadWorkflow(workId)).creativePreferences, { revision: null, items: [] });

  await decide(store, drier);
  const second = await relayPass(store, Object.fromEntries(draftRequests.map((request) => [request.id, relayAnswer(request)])));
  assert.ok(!second.pending.some((request) => request.step === 'draft'), 'the pinned draft request must hit the cached answer');
  assert.equal(second.result.status, 'clean_fail');
  assert.equal(second.result.code, 'STALE_WORK_CONTRACT');
  const stale = await store.loadWorkflow(workId);
  assert.equal(stale.stage, 'clean_fail');
  assert.ok(stale.draftProse.length > 1000);
  assert.equal(second.result.prose, stale.draftProse);
  const changed = (await events(store, stale.workflowId)).find((event) => event.event === 'creative_preferences_changed');
  assert.ok(changed, 'creative_preferences_changed event');
  assert.equal(changed.pinnedRevision, null);
  assert.equal(changed.liveRevision, 1);

  const providers = recordingProvider();
  const third = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.equal(third.status, 'awaiting_approval', JSON.stringify(third).slice(0, 300));
  assert.equal(third.prose, stale.draftProse);
  assert.equal(stepRequests(providers, 'draft').length, 0);
  const successor = await store.loadWorkflow(workId);
  assert.notEqual(successor.workflowId, stale.workflowId);
  assert.equal(successor.creativePreferences.revision, 1);
  const coherence = stepRequests(providers, 'coherence-judge');
  assert.equal(coherence.length, 1);
  assert.match(text(coherence[0]), /서술은 감정어를 줄이고 건조하게 쓴다\./);
});

test('a warn verdict surfaces as a soft advisory and does not revise', async () => {
  const store = await qualityStore();
  await decide(store, casual);
  const providers = recordingProvider({ overrides: { 'coherence-judge': JSON.stringify({ score: 88, reason: 'ok',
    creativePreferences: [{ id: 'dec-1', verdict: 'warn', evidence: '"그러십시오"' }] }) } });
  const result = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.equal(result.status, 'awaiting_approval', JSON.stringify(result).slice(0, 300));
  const advisory = result.quality.advisories.find((item) => item.code === 'CREATIVE_PREFERENCE');
  assert.ok(advisory, JSON.stringify(result.quality.advisories));
  assert.equal(advisory.decisionId, 'dec-1');
  assert.equal(advisory.advisoryOnly, true);
  assert.equal(advisory.severity, 'soft');
  assert.equal(advisory.chapterNumber, 1);
  assert.equal(advisory.message, '윤재는 누구에게나 반말을 쓴다.: "그러십시오"');
  assert.equal(stepRequests(providers, 'revise').length, 0);
  // The judge sees the subject's canonical name beside its id.
  assert.match(text(stepRequests(providers, 'coherence-judge')[0]), /인물 hero\(윤재\)/);
});

test('revisions in the workflow receive the pinned preferences', async () => {
  const store = await qualityStore();
  await decide(store, drier);
  const providers = recordingProvider({ overrides: { revise: REVISE } });
  const first = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.equal(first.status, 'awaiting_approval', JSON.stringify(first).slice(0, 300));
  assert.equal(stepRequests(providers, 'revise').length, 0);
  await runWorkflowDecide({ store, workId, approvalId: first.approvalId, action: 'request_revision', feedback: '대사를 줄여 줘', providers });
  const second = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.equal(second.status, 'awaiting_approval', JSON.stringify(second).slice(0, 300));
  const revise = stepRequests(providers, 'revise');
  assert.equal(revise.length, 1);
  assert.match(text(revise[0]), /"creativePreferences"/);
  assert.match(text(revise[0]), /서술은 감정어를 줄이고 건조하게 쓴다\./);
  assert.match(text(revise[0]), /대사를 줄여 줘/);
});

test('with the coherence review off no preference is judged and the review does not fail', async () => {
  const store = await qualityStore();
  await decide(store, casual);
  await runConfigureStatus({ store, workId, disabledReviews: ['coherence-judge'] });
  const providers = recordingProvider();
  const result = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.equal(result.status, 'awaiting_approval', JSON.stringify(result).slice(0, 300));
  assert.equal(stepRequests(providers, 'coherence-judge').length, 0);
  assert.ok(!result.quality.advisories.some((item) => item.code === 'CREATIVE_PREFERENCE'));
  assert.equal(result.quality.review.status, 'completed');
  assert.ok(result.quality.review.disabled.includes('coherence-judge'));
});

/** Guided draft, an adoption, a user revision request, and a relay pass that leaves the successor's revise pending. */
async function pendingSuccessorRevision(store) {
  const first = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: recordingProvider() });
  assert.equal(first.status, 'awaiting_approval', JSON.stringify(first).slice(0, 300));
  await decide(store, drier);
  await runWorkflowDecide({ store, workId, approvalId: first.approvalId, action: 'request_revision', feedback: '대사를 줄여 줘', providers: recordingProvider() });
  const pass = await relayPass(store);
  assert.equal(pass.result.operation, 'user_revision', JSON.stringify(pass.result).slice(0, 300));
  const revise = pass.pending.filter((request) => request.step === 'revise');
  assert.equal(revise.length, 1);
  assert.deepEqual(pass.pending.map((request) => request.step), ['revise']);
  const successor = await store.loadWorkflow(workId);
  assert.equal(successor.operation, 'user_revision');
  assert.equal(successor.stage, 'awaiting_model');
  assert.equal(successor.creativePreferences.revision, 1);
  assert.match(revise[0].user + revise[0].system, /서술은 감정어를 줄이고 건조하게 쓴다\./);
  return { first, successor, reviseAnswer: { [revise[0].id]: REVISE } };
}

test('a change while a successor user revision is pending applies the feedback once', async () => {
  const store = await qualityStore();
  const { first, successor, reviseAnswer } = await pendingSuccessorRevision(store);
  await decide(store, casual);
  const seeded = await relayPass(store, reviseAnswer);
  assert.equal(seeded.result.status, 'clean_fail', JSON.stringify(seeded.result).slice(0, 300));
  assert.equal(seeded.result.code, 'STALE_WORK_CONTRACT');
  assert.ok(!seeded.pending.some((request) => request.step === 'revise'));
  const stale = await store.loadWorkflow(workId);
  assert.equal(stale.workflowId, successor.workflowId);
  assert.equal(stale.autonomyLock, 'guided');
  assert.notEqual(stale.operation, 'user_revision');
  assert.equal(occurrences(stale.draftProse, INSERTED), 1);
  assert.notEqual(stale.draftProse, first.prose);

  const providers = recordingProvider({ overrides: { revise: REVISE } });
  const next = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers });
  assert.equal(stepRequests(providers, 'revise').length, 0);
  assert.equal(stepRequests(providers, 'draft').length, 0);
  assert.equal(next.status, 'awaiting_approval', JSON.stringify(next).slice(0, 300));
  assert.equal(occurrences(next.prose, INSERTED), 1);
  const revalidated = await store.loadWorkflow(workId);
  assert.notEqual(revalidated.workflowId, stale.workflowId);
  assert.equal(revalidated.autonomyLock, 'guided');
  assert.equal(revalidated.creativePreferences.revision, 2);
});

test('a damaged ledger stops the pass before a pending user revision is applied', async () => {
  const store = await qualityStore();
  const { successor, reviseAnswer } = await pendingSuccessorRevision(store);
  const ledgerPath = join(store.rootDir, '.vibelore', 'creative-decisions.json');
  const saved = await readFile(ledgerPath, 'utf8');
  await writeFile(ledgerPath, '{"broken":');
  await assert.rejects(relayPass(store, reviseAnswer), { code: 'INVALID_CREATIVE_DECISION' });
  const untouched = await store.loadWorkflow(workId);
  assert.equal(untouched.workflowId, successor.workflowId);
  assert.equal(untouched.draftProse, successor.draftProse);
  assert.equal(occurrences(untouched.draftProse, INSERTED), 0);

  await writeFile(ledgerPath, saved);
  const { result, steps } = await driveRelay(store, reviseAnswer);
  assert.ok(!steps.includes('revise'), `no second revise request: ${steps}`);
  assert.equal(result.status, 'awaiting_approval', JSON.stringify(result).slice(0, 300));
  assert.equal(occurrences(result.prose, INSERTED), 1);
  const done = await store.loadWorkflow(workId);
  assert.equal(done.workflowId, successor.workflowId);
  assert.equal(occurrences(done.draftProse, INSERTED), 1);
});

test('a change between the pin comparison and the check never yields a receipt bound to another set', async () => {
  const store = await qualityStore();
  await decide(store, drier);
  let adopted = false;
  const providers = recordingProvider({ hooks: { 'continuity-extract': async () => {
    if (!adopted) { adopted = true; await decide(store, casual); }
  } } });
  const result = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.ok(adopted);
  assert.equal(result.status, 'clean_fail', JSON.stringify(result).slice(0, 300));
  assert.equal(result.code, 'STALE_WORK_CONTRACT');
  assert.equal((await store.loadWorkflow(workId)).creativePreferences.revision, 1);
  await assertNoForeignReceipt(store);
});

test('a change during the draft call is caught by the receipt-time guard', async () => {
  // The pass compares its pin with the ledger it read before drafting, so this
  // change slips past that comparison; the check then binds the newer ledger.
  const store = await qualityStore();
  await decide(store, drier);
  let adopted = false;
  const providers = recordingProvider({ hooks: { draft: async () => {
    if (!adopted) { adopted = true; await decide(store, casual); }
  } } });
  const result = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.ok(adopted);
  assert.equal(result.status, 'clean_fail', JSON.stringify(result).slice(0, 300));
  assert.equal(result.code, 'STALE_WORK_CONTRACT');
  const workflow = await store.loadWorkflow(workId);
  assert.equal(workflow.creativePreferences.revision, 1);
  assert.equal(workflow.failure.code, 'STALE_WORK_CONTRACT');
  // The reviews ran against the pin; the stop came after the check bound revision 2.
  assert.equal(stepRequests(providers, 'coherence-judge').length, 1);
  const changed = (await events(store, workflow.workflowId)).find((event) => event.event === 'creative_preferences_changed');
  assert.deepEqual([changed?.pinnedRevision, changed?.liveRevision], [1, 2]);
  await assertNoForeignReceipt(store);

  const next = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.equal(next.status, 'awaiting_approval', JSON.stringify(next).slice(0, 300));
  assert.equal(next.prose, result.prose);
  assert.equal(stepRequests(providers, 'draft').length, 1);
  assert.equal((await store.loadWorkflow(workId)).creativePreferences.revision, 2);
});

test('a work without preferences sends the same coherence request and review audit as before', async () => {
  const plain = await qualityStore();
  const retired = await qualityStore();
  await decide(retired, casual);
  await decide(retired, { action: 'retire', id: 'dec-1' });
  const run = async (store) => {
    const providers = recordingProvider();
    const result = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
    assert.equal(result.status, 'awaiting_approval', JSON.stringify(result).slice(0, 300));
    const workflow = await store.loadWorkflow(workId);
    const receipt = await store.loadCheckReceipt(workId, workflow.checkId);
    return { providers, workflow, receipt };
  };
  const a = await run(plain);
  const b = await run(retired);
  const coherence = (side) => stepRequests(side.providers, 'coherence-judge').map(text);
  assert.equal(coherence(a).length, 1);
  assert.deepEqual(coherence(a), coherence(b));
  assert.deepEqual(a.receipt.review.records.map((record) => record.requestId), b.receipt.review.records.map((record) => record.requestId));
  assert.doesNotMatch(coherence(a)[0], /사용자가 채택한 창작 선호/);
  assert.deepEqual(a.workflow.creativePreferences, { revision: null, items: [] });
  assert.deepEqual(b.workflow.creativePreferences, { revision: 2, items: [] });
  assert.ok(!(await events(plain, a.workflow.workflowId)).some((event) => event.event === 'creative_preferences_pinned'));
  const pinned = (await events(retired, b.workflow.workflowId)).find((event) => event.event === 'creative_preferences_pinned');
  assert.deepEqual([pinned?.revision, pinned?.ids], [2, []]);
});

/**
 * A successor's user revision is applied while a change lands (it slips past
 * the pass's pin comparison and the check binds it); the next relay pass, past
 * the user revision with the check pending, takes the preference stale path.
 * Between passes a change is caught by the identity the check bound instead.
 */
async function revisedProseCaughtLater(store, { dropLock = false } = {}) {
  const { first, successor, reviseAnswer } = await pendingSuccessorRevision(store);
  const save = store.saveWorkflow.bind(store);
  let adopted = false;
  store.saveWorkflow = async (id, workflow) => {
    await save(id, workflow);
    if (!adopted && occurrences(workflow.draftProse ?? '', INSERTED) === 1) { adopted = true; await decide(store, casual); }
  };
  const acc = { ...reviseAnswer };
  const applied = await relayPass(store, acc);
  store.saveWorkflow = save;
  assert.ok(adopted);
  assert.ok(applied.pending.length, JSON.stringify(applied.result).slice(0, 300));
  assert.ok(!applied.pending.some((request) => request.step === 'revise'));
  for (const request of applied.pending) acc[request.id] = relayAnswer(request);
  const waiting = await store.loadWorkflow(workId);
  assert.equal(waiting.workflowId, successor.workflowId);
  assert.equal(waiting.stage, 'awaiting_model');
  assert.notEqual(waiting.operation, 'user_revision');
  assert.equal(occurrences(waiting.draftProse, INSERTED), 1);
  if (dropLock) { delete waiting.autonomyLock; await save(workId, waiting); }

  const seeded = await relayPass(store, acc);
  assert.equal(seeded.result.status, 'clean_fail', JSON.stringify(seeded.result).slice(0, 300));
  assert.equal(seeded.result.code, 'STALE_WORK_CONTRACT');
  const stale = await store.loadWorkflow(workId);
  assert.equal(stale.workflowId, successor.workflowId);
  assert.equal(stale.operation, 'creative_preferences');
  const changed = (await events(store, stale.workflowId)).find((event) => event.event === 'creative_preferences_changed');
  assert.deepEqual([changed?.pinnedRevision, changed?.liveRevision], [1, 2]);
  assert.equal(stale.autonomyLock, 'guided');

  const providers = recordingProvider();
  const next = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers });
  assert.equal(next.status, 'awaiting_approval', JSON.stringify(next).slice(0, 300));
  assert.equal(stepRequests(providers, 'revise').length, 0);
  assert.equal(occurrences(next.prose, INSERTED), 1);
  assert.notEqual(next.prose, first.prose);
  const revalidated = await store.loadWorkflow(workId);
  assert.notEqual(revalidated.workflowId, stale.workflowId);
  assert.equal(revalidated.autonomyLock, 'guided');
}

test('a change caught after a user revision was applied keeps the revised prose guided', async () => {
  await revisedProseCaughtLater(await qualityStore());
});

test('the guided lock follows the revision feedback, not the operation', async () => {
  // Defence in depth: a successor always inherits the lock, so the stale path
  // must not depend on it. Without it the lock comes from revisionFeedback.
  await revisedProseCaughtLater(await qualityStore(), { dropLock: true });
});
