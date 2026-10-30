import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { runDraftTool } from '../src/tools/generate.js';
import { runCreativeDecisionTool } from '../src/tools/creative-decisions.js';
import { runWriteWorkflow, runWorkflowDecide } from '../src/tools/workflow.js';
import { creativePreferencePin } from '../src/core/creative-decision-ledger.js';
import { currentValidationContext, exactHash } from '../src/core/validation-context.js';

const casual = { action: 'adopt', level: 'subject', subjectId: 'hero', statement: '윤재는 누구에게나 반말을 쓴다.', userAnswer: 'USER_WORDS 윤재는 항상 반말로 말해' };
const drier = { action: 'adopt', level: 'work', statement: '서술은 감정어를 줄이고 건조하게 쓴다.', userAnswer: 'USER_WORDS 좀 더 건조하게' };
const decide = (store, args) => runCreativeDecisionTool({ store, workId, ...args });

function recordingProvider(onDraft = async () => {}) {
  const requests = [];
  return {
    requests,
    async complete(req) {
      requests.push(req);
      if (req.step === 'draft') await onDraft();
      return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' };
    },
  };
}
const draftText = (providers) => providers.requests.filter((req) => req.step === 'draft')
  .flatMap((req) => req.messages.map((message) => message.content)).join('\n');

test('the writer request carries the adopted statements and never the user answer', async () => {
  const store = await qualityStore();
  await decide(store, casual);
  await decide(store, drier);
  const providers = recordingProvider();
  const result = await runDraftTool({ store, workId, chapter: 1, providers });
  const prompt = draftText(providers);
  assert.match(prompt, /사용자가 채택한 창작 선호/);
  assert.match(prompt, /작품 전체:\n- 서술은 감정어를 줄이고 건조하게 쓴다\.\n인물 hero:\n- 윤재는 누구에게나 반말을 쓴다\./);
  assert.doesNotMatch(prompt, /USER_WORDS/);
  assert.equal(result.contextAudit.decisionsRevision, 2);
  assert.deepEqual(result.contextAudit.creativePreferenceIds, ['dec-2', 'dec-1']);
});

test('a work without active decisions sends the same draft request as a work without the ledger', async () => {
  const store = await qualityStore();
  const before = await runDraftTool({ store, workId, chapter: 1, providers: recordingProvider() });
  assert.equal(before.contextAudit.decisionsRevision, null);
  assert.deepEqual(before.contextAudit.creativePreferenceIds, []);
  await decide(store, casual);
  await decide(store, { action: 'retire', id: 'dec-1' });
  const after = await runDraftTool({ store, workId, chapter: 1, providers: recordingProvider() });
  assert.equal(after.contextAudit.providerRequestHash, before.contextAudit.providerRequestHash);
  assert.equal(after.contextAudit.decisionsRevision, 2);
  assert.deepEqual(after.contextAudit.creativePreferenceIds, []);
});

test('a decision adopted while the draft is being written is a stale draft identity', async () => {
  const store = await qualityStore();
  const providers = recordingProvider(() => decide(store, casual));
  await assert.rejects(() => runDraftTool({ store, workId, chapter: 1, providers }), /STALE_DRAFT_IDENTITY: planSource/);
});

test('the receipt plan source is unchanged without a ledger and binds the ledger once one exists', async () => {
  const store = await qualityStore();
  const context = await currentValidationContext({ store, workId, chapter: 1 });
  assert.equal(context.plans.decisions, undefined);
  const { decisions, ...withoutDecisions } = context.plans;
  assert.equal(context.identity.planSourceHash, exactHash(withoutDecisions));
  await decide(store, drier);
  const bound = await currentValidationContext({ store, workId, chapter: 1 });
  assert.equal(bound.plans.decisions.revision, 1);
  assert.notEqual(bound.identity.planSourceHash, context.identity.planSourceHash);
});

test('adopting a preference after a check stales the receipt, and lore_write re-checks the kept prose without redrafting', async () => {
  const store = await qualityStore();
  const providers = recordingProvider();
  const first = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.equal(first.status, 'awaiting_approval', JSON.stringify(first).slice(0, 300));
  const drafts = providers.requests.filter((req) => req.step === 'draft').length;
  await decide(store, drier);
  await assert.rejects(runWorkflowDecide({ store, workId, approvalId: first.approvalId, action: 'approve', providers }),
    { code: 'STALE_WORK_CONTRACT' });
  const second = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.equal(second.status, 'awaiting_approval', JSON.stringify(second).slice(0, 300));
  assert.equal(second.prose, first.prose);
  assert.equal(providers.requests.filter((req) => req.step === 'draft').length, drafts);
});

test('a pinned set is drafted as given, even after the live ledger changed', async () => {
  const store = await qualityStore();
  await decide(store, drier);
  const pin = creativePreferencePin(await store.loadCreativeDecisions(workId), workId);
  const providers = recordingProvider(() => decide(store, casual));
  const result = await runDraftTool({ store, workId, chapter: 1, providers, creativePreferences: pin });
  const prompt = draftText(providers);
  assert.match(prompt, /서술은 감정어를 줄이고 건조하게 쓴다/);
  assert.doesNotMatch(prompt, /윤재는 누구에게나 반말을 쓴다/);
  assert.equal(result.contextAudit.decisionsRevision, 1);
  assert.deepEqual(result.contextAudit.creativePreferenceIds, ['dec-1']);
});

test('an empty pin without a ledger drafts exactly like no pin', async () => {
  const store = await qualityStore();
  const plain = await runDraftTool({ store, workId, chapter: 1, providers: recordingProvider() });
  const pinned = await runDraftTool({ store, workId, chapter: 1, providers: recordingProvider(), creativePreferences: { revision: null, items: [] } });
  assert.equal(pinned.contextAudit.providerRequestHash, plain.contextAudit.providerRequestHash);
  assert.equal(pinned.contextAudit.decisionsRevision, null);
});
