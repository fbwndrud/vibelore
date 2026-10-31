import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sceneStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { createPreflightRelay } from '../src/provider/host-relay.js';
import { runCreativeDecisionTool } from '../src/tools/creative-decisions.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';

// A scene workflow follows the same preference pin as a chapter workflow.
const REQUEST = '우주 편의점에서 두 사람이 큰 사건 없이 대화한다.';
const casual = { action: 'adopt', level: 'subject', subjectId: 'hero', statement: '윤재는 누구에게나 반말을 쓴다.', userAnswer: 'USER_WORDS 윤재는 항상 반말로 말해' };
const drier = { action: 'adopt', level: 'work', statement: '서술은 감정어를 줄이고 건조하게 쓴다.', userAnswer: 'USER_WORDS 좀 더 건조하게' };
const decide = (store, args) => runCreativeDecisionTool({ store, workId, ...args });

function relayAnswer(request) {
  return contractResponse({ step: request.step, messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }] })?.text
    ?? outputs[request.step] ?? '{}';
}
async function relayPass(store, answers = {}) {
  const relay = createPreflightRelay(answers);
  const result = await runWriteWorkflow({ store, workId, autonomy: 'guided', form: 'scene', instruction: REQUEST, providers: relay });
  return { result, pending: relay.pending };
}

test('a scene drafts with the pinned preferences and a later adoption stales it without a redraft', async () => {
  const store = await sceneStore();
  await decide(store, casual);
  const first = await relayPass(store);
  const drafts = first.pending.filter((request) => request.step === 'draft');
  assert.equal(drafts.length, 1, JSON.stringify(first.result).slice(0, 300));
  assert.match(drafts[0].user, /윤재는 누구에게나 반말을 쓴다\./);
  assert.doesNotMatch(drafts[0].user, /USER_WORDS/);
  const pinned = (await store.loadWorkflow(workId)).creativePreferences;
  assert.equal(pinned.revision, 1);
  assert.deepEqual(pinned.items.map((item) => item.id), ['dec-1']);

  await decide(store, drier);
  const second = await relayPass(store, Object.fromEntries(drafts.map((request) => [request.id, relayAnswer(request)])));
  assert.ok(!second.pending.some((request) => request.step === 'draft'), 'the pinned scene draft must hit the cached answer');
  assert.equal(second.result.status, 'clean_fail');
  assert.equal(second.result.code, 'STALE_WORK_CONTRACT');
});
