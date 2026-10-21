import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { runRangeReview, RANGE_REVIEW_FOCUS } from '../src/tools/range-review.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';
import { runRelayedTool } from '../src/relay-runner.js';
import { createPreflightRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';
import { qualityStore, workId, outputs } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { createPublicationUnit } from '../src/core/publication-unit.js';

function memoryStore(prose) {
  const reports = new Map(); let latest = null;
  return {
    reports, loadFoundation: async () => ({ workId, characters: [], worldFacts: ['문은 두 사람이 함께 열 수 있다.'] }),
    loadStoryProfile: async () => ({ status: 'active', revision: 2, narrativeContract: { readerPromise: '협력' } }),
    loadStorySpine: async () => ({ status: 'active', causalChain: ['문을 연다', '함께 논다'] }),
    loadArcPlan: async () => null, listChapters: async () => prose.map((_, i) => i + 1),
    loadArtifact: async (_w, chapter) => ({ prose: prose[chapter - 1] }),
    loadRangeReview: async (_w, id) => reports.get(id ?? latest) ?? null,
    saveRangeReview: async (_w, report) => { latest = report.reviewId; reports.set(latest, report); },
  };
}

function answer(step, input, long = false) {
  if (step === 'range-review-read') return {
    summary: long ? '구간에서 선택과 관계가 변한다.'.repeat(75) : `${input.chapter}화 ${input.part}조각의 선택과 관계`,
    evidence: [{ quote: input.prose.slice(0, 100), observation: '주인공이 행동했다.' }],
  };
  const ids = input.notes.flatMap(note => note.evidenceIds);
  if (step === 'range-review-merge') return { summary: '여러 화에서 관계가 변하고 약속을 회수했다.', evidenceIds: ids.slice(0, 12) };
  assert.equal(step, 'range-review-synthesis');
  return { checks: RANGE_REVIEW_FOCUS.map(focus => ({ focus, result: 'met', reason: '행동과 후속 결과로 약속을 지킨다.', evidenceIds: ids.slice(0, 2) })),
    findings: [], strengths: [{ message: '관계가 행동으로 변한다.', evidenceIds: ids.slice(0, 2) }] };
}

const provider = (requests = [], long = false) => ({ pending: [], async complete(req) {
  requests.push(req); return { text: JSON.stringify(answer(req.step, JSON.parse(req.messages[1].content), long)) };
} });

test('range reads every code unit of long prose, saves actual quotes and never changes manuscripts', async () => {
  const original = ['가'.repeat(11999) + '😀' + '끝의 선택'.repeat(3500), '다음 화의 관계 변화.'];
  const store = memoryStore(original), requests = [];
  const result = await runRangeReview({ store, workId, providers: provider(requests), focus: '관계 변화' });
  const reads = requests.filter(req => req.step === 'range-review-read').map(req => JSON.parse(req.messages[1].content));
  assert.equal(reads.filter(input => input.chapter === 1).map(input => input.prose).join(''), original[0]);
  assert.equal(reads.filter(input => input.chapter === 2).map(input => input.prose).join(''), original[1]);
  assert.ok(reads.length > 2);
  assert.ok(reads.every(input => input.prose.length <= 12000));
  assert.equal(result.review.coverage.mode, 'all-prose-parts');
  assert.equal(result.review.coverage.parts, reads.length);
  assert.equal((await store.loadRangeReview(workId)).notes.length, reads.length);
  assert.equal(result.review.designBasis, 'current-approved-plans');
  assert.equal(result.review.independence, 'not-established');
  assert.equal(result.review.advisoryOnly, true);
  assert.deepEqual(await store.loadArtifact(workId, 1), { prose: original[0] });
  const status = await runRangeReview({ store, workId, action: 'status', reviewId: result.review.reviewId });
  assert.deepEqual(status.review, result.review);
  original[1] = '검토 후 바뀐 두 번째 화.';
  assert.equal((await runRangeReview({ store, workId, action: 'status' })).review.freshness, 'stale');
  original[1] = '다음 화의 관계 변화.';
  assert.equal((await runRangeReview({ store, workId, action: 'status' })).review.freshness, 'current');
  store.loadStorySpine = async () => ({ status: 'active', causalChain: ['새로 승인한 이야기'] });
  const stale = await runRangeReview({ store, workId, action: 'status' });
  assert.equal(stale.review.freshness, 'stale');
  assert.equal(stale.review.reviewId, result.review.reviewId);
});

test('large ranges read all chapters before bounded hierarchical synthesis', async () => {
  const store = memoryStore(Array.from({ length: 60 }, (_, i) => `${i + 1}화: 문을 열고 다음 선택을 했다.`));
  const requests = [];
  const result = await runRangeReview({ store, workId, providers: provider(requests, true) });
  const stored = await store.loadRangeReview(workId);
  assert.equal(stored.notes.length, 60);
  assert.equal(result.review.coverage.parts, 60);
  assert.ok(result.review.coverage.synthesisLevels > 0);
  assert.ok(requests.some(req => req.step === 'range-review-merge'));
  assert.equal(requests.at(-1).step, 'range-review-synthesis');
  assert.deepEqual(stored.manifest.map(row => row.chapter), Array.from({ length: 60 }, (_, i) => i + 1));
});

test('invented source quotes and synthesis citations are refused, with no success report saved', async () => {
  for (const badStep of ['range-review-read', 'range-review-merge', 'range-review-synthesis']) {
    const long = badStep === 'range-review-merge';
    const store = memoryStore(Array.from({ length: long ? 60 : 1 }, () => '문을 열고 함께 놀았다.'));
    await assert.rejects(runRangeReview({ store, workId, providers: { async complete(req) {
      const out = answer(req.step, JSON.parse(req.messages[1].content), long);
      if (req.step === badStep) {
        if (badStep === 'range-review-read') out.evidence[0].quote = '원고에 없는 가짜 인용';
        else if (badStep === 'range-review-merge') out.evidenceIds = ['made-up'];
        else out.checks[0].evidenceIds = ['made-up'];
      }
      return { text: JSON.stringify(out) };
    } } }), /INVALID_RANGE_REVIEW/);
    assert.equal(store.reports.size, 0);
  }
});

test('range, missing prose, excessive context and status identifiers are validated before claiming success', async () => {
  const store = memoryStore(['한 화 본문']), never = { complete() { throw Error('must not request a model'); } };
  for (const args of [{ fromChapter: 0 }, { throughChapter: 2 }, { throughChapter: 0 }, { throughChapter: 1.5 }]) {
    await assert.rejects(runRangeReview({ store, workId, ...args, providers: never }), /RANGE_REVIEW/);
  }
  await assert.rejects(runRangeReview({ store: memoryStore(['']), workId, providers: never }), /MISSING_PROSE/);
  await assert.rejects(runRangeReview({ store, workId, action: 'status', reviewId: '../escape' }), /INVALID_RANGE_REVIEW_ID/);
  const big = { ...store, loadStorySpine: async () => ({ status: 'active', text: '가'.repeat(50000) }) };
  await assert.rejects(runRangeReview({ store: big, workId, providers: never }), /RANGE_REVIEW_CONTEXT_BUDGET/);
  assert.equal((await runRangeReview({ store, workId, action: 'status' })).status, 'missing');
});

test('published canon takes precedence over unapproved working manuscript edits', async t => {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  const written = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: { async complete(req) {
    return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' };
  } } });
  assert.equal(written.status, 'completed');
  const original = await store.loadArtifact(workId, 1);
  await store.saveArtifact({ ...original, prose: '아직 승인하지 않은 변경 원고.' });
  const spine = await store.loadStorySpine(workId), arc = await store.loadArcPlan(workId);
  await store.saveStorySpine(workId, { ...spine, status: 'pending', causalChain: ['아직 승인하지 않은 전체 이야기'] });
  await store.saveArcPlan(workId, { ...arc, status: 'pending', promise: '아직 승인하지 않은 아크' });
  const requests = [];
  const result = await runRangeReview({ store, workId, providers: provider(requests) });
  const actual = requests.filter(req => req.step === 'range-review-read').map(req => JSON.parse(req.messages[1].content).prose).join('');
  assert.equal(actual, original.prose);
  const input = JSON.parse(requests.find(req => req.step === 'range-review-read').messages[1].content);
  assert.deepEqual(input.context.design.storySpine.causalChain, spine.causalChain);
  assert.equal(input.context.arcPlan.promise, arc.promise);
  assert.notEqual(result.review.sourceHead, 'legacy-working-tree');
  assert.equal((await store.loadArtifact(workId, 1)).prose, '아직 승인하지 않은 변경 원고.');
  assert.equal((await store.loadRangeReview(workId)).reviewId, result.review.reviewId);
});

test('a canon HEAD change during reading prevents a stale success report', async t => {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: { async complete(req) {
    return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' };
  } } });
  const unit = createPublicationUnit({ rootDir: store.rootDir }); let changed = false;
  await assert.rejects(runRangeReview({ store, workId, providers: { async complete(req) {
    if (!changed) {
      changed = true;
      const head = (await unit.readPublished()).value.head, token = await unit.issueFencingToken();
      const result = await unit.publish({
        context: { snapshotId: head, expectedHead: head, storyTimeScope: { worldline: 'main', through: 1 }, publicationOrder: 2,
          transactionTime: '2026-10-10T00:00:00.000Z', policyRevision: 'vibelore-1', semanticGeneration: 'vibelore-1', fencingToken: token.value.fencingToken },
        candidate: { tree: { reviewEpoch: 1 }, projections: {}, impactClosure: [] },
      });
      assert.equal(result.ok, true);
    }
    return { text: JSON.stringify(answer(req.step, JSON.parse(req.messages[1].content))) };
  } } }), { code: 'RANGE_REVIEW_HEAD_CHANGED' });
  assert.equal(await store.loadRangeReview(workId), null);
});

test('actual host relay resumes each prose read and synthesis without changing request identities', async t => {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  for (const chapterNumber of [1, 2]) await store.saveArtifact({ workId, chapterNumber, prose: `${chapterNumber}화 원고. 문을 열고 함께 놀았다.` });
  const args = { workId, scope: 'range', fromChapter: 1, throughChapter: 2 }, steps = [];
  let result;
  for (let round = 0; round < 6; round++) {
    const run = result?.runId ? await loadRun(store.rootDir, result.runId) : null;
    const answers = { ...(run?.answers ?? {}) };
    for (const request of result?.requests ?? []) {
      steps.push(request.step); answers[request.id] = JSON.stringify(answer(request.step, JSON.parse(request.user)));
    }
    result = await runRelayedTool({ store, toolName: 'lore_arc_review', args, run, answers,
      executeTool: (store, _name, args, providers) => runRangeReview({ store, ...args, providers }),
      providerForTool: (_name, accumulated) => createPreflightRelay(accumulated) });
    if (result.review) break;
  }
  assert.ok(result.review, JSON.stringify(result));
  assert.deepEqual(steps, ['range-review-read', 'range-review-read', 'range-review-synthesis']);
});
