/**
 * The post-review quality-gate revise is capped at MAX_ATTEMPTS (3) per
 * workflow: two revisions, then clean_fail if the gate still blocks. The loop
 * counter `attempt` is local to one runWriteWorkflow call, and a relayed host
 * resumes after every round trip, so each resume restarted at attempt 1 with
 * the latest revised prose. The cap then never fired and a reviewer that kept
 * blocking produced unlimited revise requests (reproduced: 7 revisions in 40
 * resumes, still needs_model). The count of applied quality revisions is now
 * persisted on the workflow.
 *
 * Trigger: a character-fidelity finding with a blocking code and a blank
 * message. reviewFindingAdvisories drops blank messages, so the dedupe no
 * longer folds the dimension violation into its advisory-only twin and the
 * gate blocks on every pass of the same answer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRelayedTool } from '../src/relay-runner.js';
import { createPreflightRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';
import { runWriteWorkflow, runWorkflowDecide } from '../src/tools/workflow.js';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';

const blockingFidelity = JSON.stringify({
  score: 88,
  dimensions: { voice: 88, motivation: 30, responseCausality: 88, relationshipContinuity: 88, dialogueIntent: 88 },
  findings: [{ dimension: 'motivation', code: 'QUALITY_GATE_LENGTH', message: ' ' }],
});

async function driveRelayed(store, { maxCalls, args = { workId, autonomy: 'auto' } }) {
  let reviseCount = 0;
  const invoke = async (previous) => {
    const run = previous?.runId ? await loadRun(store.rootDir, previous.runId) : null;
    const answers = { ...run?.answers };
    for (const req of previous?.requests ?? []) {
      const shaped = { step: req.step, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }] };
      if (req.step === 'revise') {
        reviseCount += 1;
        answers[req.id] = JSON.stringify({ replacements: [], insertions: [{ afterParagraph: 1, text: `조용히 손을 내렸다 ${reviseCount}.` }] });
        continue;
      }
      answers[req.id] = req.step === 'character-fidelity' ? blockingFidelity : (contractResponse(shaped)?.text ?? outputs[req.step] ?? '{}');
    }
    return runRelayedTool({ store, toolName: 'lore_write', args: run?.args ?? args, run, answers,
      providerForTool: (_name, seed) => createPreflightRelay(seed),
      executeTool: (s, _name, args, providers) => runWriteWorkflow({ store: s, ...args, providers }) });
  };
  let result = await invoke();
  let calls = 0;
  for (; calls < maxCalls && result.status === 'needs_model'; calls += 1) result = await invoke(result);
  return { result, reviseCount, calls };
}

test('the quality-gate revise cap holds across relayed resumes', async () => {
  const store = await qualityStore();
  const { result, reviseCount } = await driveRelayed(store, { maxCalls: 40 });
  assert.equal(result.status, 'clean_fail', `expected the cap to end the loop, got ${result.status} after ${reviseCount} revisions`);
  // Same budget as one uninterrupted call: attempt 1 and 2 revise, attempt 3 fails.
  assert.equal(reviseCount, 2);
  const workflow = await store.loadWorkflow(workId);
  assert.equal(workflow.stage, 'clean_fail');
  assert.equal(workflow.operation, 'quality_gate');
  assert.equal(workflow.qualityRevisions, 2);
});

test('a single uninterrupted call keeps the same quality revise budget', async () => {
  const store = await qualityStore();
  let reviseCount = 0;
  const providers = { async complete(req) {
    if (req.step === 'revise') { reviseCount += 1; return { text: JSON.stringify({ replacements: [], insertions: [{ afterParagraph: 1, text: `조용히 손을 내렸다 ${reviseCount}.` }] }) }; }
    if (req.step === 'character-fidelity') return { text: blockingFidelity };
    return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' };
  } };
  const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers });
  assert.equal(result.status, 'clean_fail', JSON.stringify(result).slice(0, 400));
  assert.equal(reviseCount, 2);
  assert.equal(result.attempts, 3);
});

// A new user-initiated round gets the full quality budget again (as at 52e5aee);
// automatic resumes inside that round still do not refill it.
test('a user request_revision starts a new round with the full quality revise budget', async () => {
  const store = await qualityStore();
  let phase = 1; let fidelityCalls = 0; let revises = 0; const perPhase = { 1: 0, 2: 0 };
  const providers = { async complete(req) {
    if (req.step === 'revise') { revises += 1; perPhase[phase] += 1; return { text: JSON.stringify({ replacements: [], insertions: [{ afterParagraph: 1, text: `조용히 손을 내렸다 ${revises}.` }] }) }; }
    if (req.step === 'character-fidelity') { fidelityCalls += 1; if (phase === 2 || fidelityCalls <= 2) return { text: blockingFidelity }; }
    return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' };
  } };
  const first = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.equal(first.status, 'awaiting_approval', JSON.stringify(first).slice(0, 300));
  assert.equal(perPhase[1], 2);
  assert.equal((await store.loadWorkflow(workId)).qualityRevisions, 2);
  await runWorkflowDecide({ store, workId, approvalId: first.approvalId, action: 'request_revision', feedback: '마지막에 조용한 몸짓을 더해 주세요.', providers });
  assert.equal((await store.loadWorkflow(workId)).qualityRevisions, undefined);
  phase = 2;
  const second = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.equal(second.status, 'clean_fail');
  // The user revision itself, then two quality revisions, then clean_fail.
  assert.equal(perPhase[2], 3);
  assert.equal(second.attempts, 3);
});

test('retryValidation after a quality_gate clean_fail gets the full budget, and its resumes do not refill it', async () => {
  const store = await qualityStore();
  const first = await driveRelayed(store, { maxCalls: 40 });
  assert.equal(first.result.status, 'clean_fail');
  assert.equal(first.reviseCount, 2);
  const retry = await driveRelayed(store, { maxCalls: 40, args: { workId, autonomy: 'auto', retryValidation: true } });
  assert.equal(retry.result.status, 'clean_fail', `retry ended ${retry.result.status} after ${retry.reviseCount} revisions`);
  assert.equal(retry.reviseCount, 2);
  const workflow = await store.loadWorkflow(workId);
  assert.equal(workflow.operation, 'quality_gate');
  assert.equal(workflow.qualityRevisions, 2);
});
