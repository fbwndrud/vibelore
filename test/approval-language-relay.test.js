import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runRelayedTool } from '../src/relay-runner.js';
import { createPreflightRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';
import { runStoryProfile, runStoryProfileDecide } from '../src/tools/story-profile.js';
import { gateApprovalActivation } from '../src/core/approval-language-gate.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';

const newStore = async () => new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'approval-relay-')));
const profile = { genreLabel: 'Harbor drama', engineGenre: 'other', format: { pov: '3인칭제한', serialization: 'Serial' }, narrativeContract: { depthMode: 'commercial-dramatic' }, promptGuidance: {}, designReview: { settledDecisions: [], openQuestions: [] } };
function languageAnswer(request) {
  const input = JSON.parse(request.user);
  return JSON.stringify({ language: input.language, artifactHash: input.artifactHash, verdict: 'pass', evidence: [], allowedExceptions: [] });
}
async function invoke({ store, toolName = 'lore_profile', args, executeTool, previous = null, response = null }) {
  const run = previous?.runId ? await loadRun(store.rootDir, previous.runId) : null;
  const answers = { ...(run?.answers ?? {}) };
  if (response !== null) for (const request of previous.requests) answers[request.id] = typeof response === 'function' ? response(request) : response;
  return runRelayedTool({ store, toolName, args: run?.args ?? args, run, answers,
    executeTool, providerForTool: (_name, accumulated) => createPreflightRelay(accumulated) });
}

test('real preflight → resume → profile decide uses stable exact proof despite timestamps', async () => {
  const store = await newStore();
  const args = { workId: 'book', language: 'en', brief: '한국어 원문', mode: 'review' };
  const executeTool = (store, _name, args, providers) => runStoryProfile({ store, ...args, providers });
  const first = await invoke({ store, args, executeTool });
  assert.equal(first.status, 'needs_model'); assert.equal(first.requests[0].step, 'story-profile');
  const second = await invoke({ store, args, executeTool, previous: first, response: JSON.stringify(profile) });
  assert.equal(second.status, 'needs_model'); assert.equal(second.requests[0].step, 'approval-language-contract');
  assert.equal((await store.loadApprovalValidation('book', 'profile')).attempt, 0);
  const again = await invoke({ store, args, executeTool, previous: second });
  assert.equal(again.requests[0].id, second.requests[0].id);
  assert.equal((await store.loadApprovalValidation('book', 'profile')).attempt, 0);
  const ready = await invoke({ store, args, executeTool, previous: again, response: languageAnswer });
  assert.equal(ready.profile.status, 'pending');
  const before = await store.loadApprovalValidation('book', 'profile');
  const decided = await invoke({ store, toolName: 'lore_profile_decide', args: { workId: 'book', action: 'approve' },
    executeTool: (store, _name, args, providers) => runStoryProfileDecide({ store, ...args, providers }) });
  assert.equal(decided.approved, true); assert.equal(decided.requests, undefined);
  assert.equal((await store.loadApprovalValidation('book', 'profile')).artifactHash, before.artifactHash);
});

test('three actual invalid replies exhaust across resume; new generation and explicit retry each reset once', async () => {
  const store = await newStore();
  const value = { readerPromise: 'A promise', protagonistAppeal: 'A keeper', emotionalDefect: 'Distrust', competenceSignature: ['Mending'], comedyEngines: ['Orders'], solutionPatternsToRotate: ['Cooperation'] };
  const args = { workId: 'book' };
  const executeTool = (store, _name, args, providers) => gateApprovalActivation({ store, workId: args.workId, kind: 'story', stateKey: 'story-identity', value,
    resolution: { implicitLegacy: false, contract: buildLanguageContract({ language: 'en' }) }, providers, retryValidation: args.retryValidation });
  let parked = await invoke({ store, args, executeTool });
  const firstId = parked.requests[0].id;
  for (let index = 1; index <= 3; index++) {
    parked = await invoke({ store, args, executeTool, previous: parked, response: '{' });
    assert.equal((await store.loadApprovalValidation('book', 'story-identity')).attempt, index);
    if (index < 3) { assert.equal(parked.status, 'needs_model'); assert.notEqual(parked.requests[0].id, firstId); }
  }
  assert.equal(parked.status, 'clean_fail');
  const failed = await store.loadApprovalValidation('book', 'story-identity');
  const noRestart = await gateApprovalActivation({ store, workId: 'book', kind: 'story', stateKey: 'story-identity', value,
    resolution: { implicitLegacy: false, contract: buildLanguageContract({ language: 'en' }) }, consumeOnly: true,
    providers: { validationContext: { runId: 'different-decide' }, complete() { throw Error('decide must not restart'); } } });
  assert.equal(noRestart.status, 'clean_fail');
  assert.equal((await store.loadApprovalValidation('book', 'story-identity')).epoch, failed.epoch);
  const fresh = await invoke({ store, args, executeTool });
  assert.equal((await store.loadApprovalValidation('book', 'story-identity')).epoch, failed.epoch + 1);
  assert.equal(fresh.status, 'needs_model');
  const retry = await invoke({ store, args: { workId: 'book', retryValidation: true }, executeTool });
  const epoch = (await store.loadApprovalValidation('book', 'story-identity')).epoch;
  const retryAgain = await invoke({ store, args, executeTool, previous: retry });
  assert.equal((await store.loadApprovalValidation('book', 'story-identity')).epoch, epoch);
  assert.equal(retryAgain.requests[0].id, retry.requests[0].id);
  const pass = await invoke({ store, args, executeTool, previous: retryAgain, response: languageAnswer });
  assert.equal(pass.ok, true);
});
