import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRelayedTool } from '../src/relay-runner.js';
import { describeRequestInputs } from '../src/core/request-input-report.js';

const prose = '리아는 방패를 세웠다. '.repeat(200);
const requests = [
  { id: 'a', step: 'coherence-judge', jsonMode: true, system: '평가자', user: `## 회차 8 본문\n${prose}\n## 직전 화 요약\n도윤이 운행을 끊었다.\n위 본문을 평가.` },
  { id: 'b', step: 'pattern-ledger', jsonMode: true, system: '패턴', user: `인물 ID: c1=리아\n\n본문:\n${prose}\nJSON: {}` },
];

test('each request is described by its sections, character counts and whether it shares the cached prose block', () => {
  const report = describeRequestInputs(requests, [{ id: 'chapter-prose', label: '8화 본문', text: prose }]);
  const coherence = report.find((row) => row.step === 'coherence-judge');
  assert.equal(coherence.chars.user, requests[0].user.length);
  assert.equal(coherence.chars.shared, prose.length);
  assert.equal(coherence.sharedPrefix, true);
  assert.deepEqual(coherence.sections.map((s) => s.heading), ['회차 8 본문', '직전 화 요약']);
  assert.equal(coherence.sections.find((s) => s.heading === '회차 8 본문').shared, true);
  const pattern = report.find((row) => row.step === 'pattern-ledger');
  assert.deepEqual(pattern.sections.map((s) => s.heading), ['인물 ID', '본문']);
});

test('a lone request still uses the shared prefix an earlier batch cached; one without the prose does not', () => {
  const [row] = describeRequestInputs([requests[0]], [{ id: 'chapter-prose', label: '8화 본문', text: prose }]);
  assert.equal(row.sharedPrefix, true);
  const [plain] = describeRequestInputs([{ id: 'x', step: 'draft', system: '', user: '계획만' }], [{ id: 'chapter-prose', label: '8화 본문', text: prose }]);
  assert.equal(plain.sharedPrefix, false);
});

test('needs_model responses carry the input report', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'vibelore-input-report-'));
  let workflow = null;
  const store = { rootDir, async loadWorkflow() { return workflow; }, async saveWorkflow(_w, next) { workflow = structuredClone(next); } };
  const parked = await runRelayedTool({ store, toolName: 'lore_rewrite', args: { workId: 'book', chapter: 1 },
    executeTool: async () => ({ preview: true }),
    providerForTool: () => ({ pending: requests, sharedContexts: [{ id: 'chapter-prose', label: '8화 본문', text: prose }] }) });
  assert.equal(parked.inputReport.length, 2);
  assert.equal(parked.inputReport[0].id, 'a');
});

test('lore_write keeps the last input report on the workflow so status can show it', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'vibelore-input-report-'));
  let workflow = { workflowId: 'wf', workId: 'book', chapter: 8, stage: 'awaiting_model', contextAudit: { memory: { trimmedSummaries: 2, droppedForBudget: 3 } } };
  const store = { rootDir, async loadWorkflow() { return workflow; }, async saveWorkflow(_w, next) { workflow = structuredClone(next); } };
  const parked = await runRelayedTool({ store, toolName: 'lore_write', args: { workId: 'book' },
    executeTool: async () => ({ preview: true }),
    providerForTool: () => ({ pending: requests, sharedContexts: [] }) });
  assert.equal(workflow.lastInputReport.length, 2);
  assert.deepEqual(parked.trimmedContext, { trimmedSummaries: 2, droppedForBudget: 3 });
});

test('with sharedOnce the prose block is sent once and each request points to it; joining restores the exact request', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'vibelore-shared-once-'));
  const store = { rootDir, async loadWorkflow() { return null; }, async saveWorkflow() {} };
  const shared = [{ id: 'chapter-prose', label: '8화 본문', text: prose }];
  const run = (args) => runRelayedTool({ store, toolName: 'lore_rewrite', args,
    executeTool: async () => ({ preview: true }), providerForTool: () => ({ pending: requests, sharedContexts: shared }) });
  const inline = await run({ workId: 'book', chapter: 1 });
  const once = await run({ workId: 'book', chapter: 1, sharedOnce: true });
  assert.equal(once.sharedBlocks.length, 1);
  const block = once.sharedBlocks[0];
  for (const [index, request] of once.requests.entries()) {
    assert.equal(request.user.split(prose).length - 1, 0, 'no prose inside the request');
    assert.equal(request.promptCache.sharedBlockId, block.id);
    assert.equal(block.text + request.user.slice(request.promptCache.sharedBlockRef.length), inline.requests[index].user);
  }
  assert.ok(JSON.stringify(once).length < JSON.stringify(inline).length - prose.length / 2, 'one copy of the prose instead of two');
});
