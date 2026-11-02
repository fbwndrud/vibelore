import test from 'node:test';
import assert from 'node:assert/strict';
import { workId } from './fixtures/webtoon.js';
import { episodeSetup, provider, adaptationAnswer, adaptationReviewAnswer, withPages } from './fixtures/webtoon-episode.js';
import { runWebtoonEpisodeTool } from '../src/tools/webtoon-episode.js';
import { runConfigureStatus } from '../src/tools/configure.js';
import { OPTIONAL_REVIEWS } from '../src/core/review-policy.js';
import { WebtoonStore } from '../src/store/webtoon-store.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';

const tool = (store, args, providers) => runWebtoonEpisodeTool({ store, args, providers });
const saved = store => new WebtoonStore(store).load();
const steps = p => p.requests.map(r => r.step);

test('no image job exists before adaptation approval', async () => {
  const { store, args } = await episodeSetup();
  const r = await tool(store, args, provider());
  assert.equal(r.status, 'awaiting_adaptation_approval'); assert.equal(r.jobs, undefined);
  assert.equal(r.approvalView.estimatedImageCalls, r.approvalView.pages.length * 2);
  assert.equal(r.productionMode, 'episode-pages-v1'); assert.equal(r.approval, null);
  assert.deepEqual(r.pages, []);
});

test('the approval view shows the panel table, the five checks, the advisories and the independence label', async () => {
  const { store, args } = await episodeSetup();
  const { approvalView: v } = await tool(store, args, provider());
  assert.equal(v.focus.primary, '문 앞의 망설임');
  assert.equal(v.pages.length, 1); assert.equal(v.pages[0].panels.length, 3);
  assert.deepEqual(Object.keys(v.pages[0].panels[0]).sort(), ['bridge', 'id', 'shows', 'texts']);
  assert.equal(v.pages[0].panels[0].texts[0].kind, 'dialogue');
  assert.deepEqual(v.checks.map(c => c.name), ['readThrough', 'coreKept', 'showNotTell', 'pageFlow', 'fidelity']);
  assert.ok(v.checks.every(c => c.status === 'passed' && c.evidence));
  assert.equal(v.advisories.length, 1); assert.equal(v.advisories[0].severity, 'advisory');
  assert.equal(v.independence, 'same-host'); assert.match(v.approvalId, /^sha256:/);
});

test('start persists the episode workflow as current and pins budgets, cap and image settings', async () => {
  const { store, args } = await episodeSetup();
  const r = await tool(store, args, provider());
  const w = await saved(store);
  assert.equal(w.workflowId, r.workflowId); assert.equal(w.productionMode, 'episode-pages-v1');
  assert.deepEqual(r.budgets, { adaptation: { limit: 1, used: 0 }, page: { limit: 1 } });
  assert.equal(r.maxPages, 6); assert.equal(r.exactPages, null); assert.equal(r.imageQuality, null);
  assert.equal(r.imagePolicy.execution, 'openai-api'); assert.equal(r.imageSelection.id, 'selected-api');
  assert.equal((await new WebtoonStore(store).load()).workflowId, r.workflowId); assert.equal(r.references[0].id, 'ref');
});

test('approve with a stale approvalId is refused', async () => {
  const { store, args } = await episodeSetup();
  const first = await tool(store, args, provider());
  const revised = await tool(store, { workId, action: 'revise', target: 'adaptation', feedback: '문 앞에서 더 오래 머물게 해 주세요.' }, provider());
  assert.equal(revised.status, 'awaiting_adaptation_approval'); assert.notEqual(revised.approvalView.approvalId, first.approvalView.approvalId);
  await assert.rejects(tool(store, { workId, action: 'approve', approvalId: first.approvalView.approvalId, feedback: '좋아요' }, provider()), /ADAPTATION_APPROVAL_STALE/);
  const approved = await tool(store, { workId, action: 'approve', approvalId: revised.approvalView.approvalId, feedback: '좋아요' }, provider());
  assert.equal(approved.approval.id, revised.approvalView.approvalId);
});

test('approve without the user words is refused', async () => {
  const { store, args } = await episodeSetup();
  const r = await tool(store, args, provider());
  for (const feedback of [undefined, '', '   ']) {
    await assert.rejects(tool(store, { workId, action: 'approve', approvalId: r.approvalView.approvalId, feedback }, provider()), /ADAPTATION_USER_ANSWER_REQUIRED/);
  }
  assert.equal((await tool(store, { workId }, provider())).status, 'awaiting_adaptation_approval');
});

test('a user approval is recorded as the user and opens the first page brief request', async () => {
  const { store, args } = await episodeSetup();
  const r = await tool(store, args, provider());
  const p = provider();
  const done = await tool(store, { workId, action: 'approve', approvalId: r.approvalView.approvalId, feedback: '이대로 그려 주세요.' }, p);
  assert.equal(done.approval.by, 'user'); assert.equal(done.approval.feedback, '이대로 그려 주세요.'); assert.equal(done.approval.id, r.approvalView.approvalId);
  assert.equal(done.status, 'needs_model'); assert.deepEqual(steps(p), ['webtoon-page-brief']); assert.equal(done.requests[0].step, 'webtoon-page-brief');
  assert.deepEqual(done.pages.map(page => ({ id: page.id, stage: page.stage, brief: page.brief, image: page.image, tiles: page.tiles, review: page.review, attempts: page.attempts, revision: page.revision })),
    [{ id: 'page-1', stage: 'pending', brief: null, image: null, tiles: null, review: null, attempts: [], revision: 0 }]);
  assert.match(done.pages[0].digest, /^sha256:/); assert.equal(done.jobs, undefined);
});

test('approve is refused outside the approval gate', async () => {
  const { store, args } = await episodeSetup();
  const r = await tool(store, { ...args, delegation: { scope: 'production', userAnswer: '알아서' } }, provider());
  await assert.rejects(tool(store, { workId, action: 'approve', approvalId: r.approval.id, feedback: '네' }, provider()), /EPISODE_APPROVAL_NOT_AVAILABLE/);
});

test('a failing adaptation review re-adapts once, then stops', async () => {
  const { store, args } = await episodeSetup();
  const p = provider({ adaptationReview: 'fail' });
  const r = await tool(store, args, p);
  assert.equal(r.status, 'adaptation_needs_revision'); assert.equal(r.attempts.length, 1);
  assert.deepEqual(steps(p), ['webtoon-adaptation', 'webtoon-adaptation-review', 'webtoon-adaptation', 'webtoon-adaptation-review']);
  assert.deepEqual(r.budgets.adaptation, { limit: 1, used: 1 }); assert.equal(r.jobs, undefined); assert.equal(r.approvalView, undefined);
  const [attempt] = r.attempts;
  assert.equal(attempt.failedAt, 'adaptation_review'); assert.equal(attempt.checks.readThrough, 'failed'); assert.equal(attempt.checks.coreKept, 'passed');
  // The retry feedback names the failed check, its panel and the blocking finding as instructions, and leaves advisories out.
  const feedback = JSON.parse(p.requests[2].messages.at(-1).content).feedback;
  assert.equal(feedback, attempt.feedback);
  assert.match(feedback, /readThrough \(failed\): Panel p1-1 has an action with no visible cause\. \[panels: p1-1\]/);
  assert.match(feedback, /Panel p1-1: show what makes her stop\./); assert.doesNotMatch(feedback, /Minor polish/);
  assert.doesNotMatch(feedback, /coreKept/);
  assert.match(r.nextAction, /action="revise"/);
});

test('the adaptation revision budget follows adaptationRevisions and the user revise resets it', async () => {
  const { store, args } = await episodeSetup();
  const none = await tool(store, { ...args, adaptationRevisions: 0 }, provider({ adaptationReview: 'fail' }));
  assert.equal(none.status, 'adaptation_needs_revision'); assert.equal(none.attempts.length, 0);
  const { store: store2, args: args2 } = await episodeSetup();
  const two = await tool(store2, { ...args2, adaptationRevisions: 2 }, provider({ adaptationReview: 'fail' }));
  assert.equal(two.attempts.length, 2); assert.deepEqual(two.budgets.adaptation, { limit: 2, used: 2 });
  const p = provider();
  const revised = await tool(store2, { workId, action: 'revise', target: 'adaptation', feedback: '원인을 보여 주세요.' }, p);
  assert.equal(revised.status, 'awaiting_adaptation_approval'); assert.deepEqual(revised.budgets.adaptation, { limit: 2, used: 0 });
  assert.equal(revised.attempts.length, 2); assert.deepEqual(steps(p), ['webtoon-adaptation', 'webtoon-adaptation-review']);
  assert.equal(JSON.parse(p.requests[0].messages.at(-1).content).feedback, '원인을 보여 주세요.');
});

test('revise needs a target, feedback and an adaptation to revise; page revision is not available yet', async () => {
  const { store, args } = await episodeSetup();
  await tool(store, args, provider());
  await assert.rejects(tool(store, { workId, action: 'revise', feedback: '고쳐 주세요' }, provider()), /INVALID_EPISODE_REVISE_TARGET/);
  await assert.rejects(tool(store, { workId, action: 'revise', target: 'adaptation' }, provider()), /EPISODE_REVISION_FEEDBACK_REQUIRED/);
  await assert.rejects(tool(store, { workId, action: 'revise', target: 'page', feedback: '고쳐 주세요', pageIds: ['page-1'] }, provider()), /EPISODE_PAGE_REVISE_UNAVAILABLE/);
});

test('delegated production auto-advances and records it as delegated', async () => {
  const { store, args } = await episodeSetup();
  const r = await tool(store, { ...args, delegation: { scope: 'production', userAnswer: '알아서' } }, provider());
  assert.equal(r.approval.by, 'delegated'); assert.equal(r.approval.feedback, '알아서'); assert.match(r.approval.id, /^sha256:/);
  assert.equal(r.status, 'needs_model'); assert.equal(r.requests[0].step, 'webtoon-page-brief');
  assert.equal(r.jobs, undefined); assert.equal(r.approvalView, undefined);
  const w = await saved(store);
  assert.equal(w.approval.by, 'delegated');
});

test('delegation without production scope is refused and never advances past the gate', async () => {
  const { store, args } = await episodeSetup();
  for (const scope of ['preview', 'style']) await assert.rejects(tool(store, { ...args, delegation: { scope, userAnswer: '알아서' } }, provider()), /EPISODE_DELEGATION_SCOPE/);
  await assert.rejects(tool(store, { ...args, delegation: { scope: 'production' } }, provider()), /INVALID_WEBTOON_DELEGATION/);
});

test('a delegated failing review still stops at adaptation_needs_revision', async () => {
  const { store, args } = await episodeSetup();
  const r = await tool(store, { ...args, delegation: { scope: 'production', userAnswer: '알아서' } }, provider({ adaptationReview: 'fail' }));
  assert.equal(r.status, 'adaptation_needs_revision'); assert.equal(r.approval, null);
});

test('automatic revision limits are integers 0-2 and cannot exceed the delegation limit', async () => {
  const { store, args } = await episodeSetup();
  for (const key of ['adaptationRevisions', 'pageRevisions']) for (const value of [-1, 3, 1.5, '1']) {
    await assert.rejects(tool(store, { ...args, [key]: value }, provider()), /INVALID_EPISODE_REVISIONS/, `${key}=${value}`);
  }
  const delegation = { scope: 'production', userAnswer: '알아서', maxAutoRevisions: 1 };
  await assert.rejects(tool(store, { ...args, delegation, adaptationRevisions: 2 }, provider()), /WEBTOON_DELEGATION_RETRY_LIMIT/);
  await assert.rejects(tool(store, { ...args, delegation, pageRevisions: 2 }, provider()), /WEBTOON_DELEGATION_RETRY_LIMIT/);
  const ok = await tool(store, { ...args, delegation: { ...delegation, maxAutoRevisions: 0 } }, provider({ adaptationReview: 'fail' }));
  assert.deepEqual(ok.budgets, { adaptation: { limit: 0, used: 0 }, page: { limit: 0 } }); assert.equal(ok.status, 'adaptation_needs_revision');
});

test('start needs references and keeps the previous-page and adopted-style ids reserved', async () => {
  const { store, args } = await episodeSetup();
  const [ref] = args.references, noAnswer = provider();
  for (const references of [undefined, [], [{ ...ref, id: 'previous-page' }], [{ ...ref, id: 'adopted-style' }], [ref, ref], [{ ...ref, description: '윤의 얼굴' }]]) {
    await assert.rejects(tool(store, { ...args, references }, noAnswer), /EPISODE_REFERENCES_REQUIRED/);
  }
  assert.deepEqual(noAnswer.requests, []);
});

test('the page count is an integer 1-20; pages fixes it even above the work cap and an exact count is enforced', async () => {
  const { store, args } = await episodeSetup();
  for (const key of ['pages', 'maxPages']) for (const value of [0, 21, 1.5, '2']) await assert.rejects(tool(store, { ...args, [key]: value }, provider()), /INVALID_EPISODE_PAGE_COUNT/);
  const seven = (d, request) => request.step === 'webtoon-adaptation' ? JSON.stringify(withPages(adaptationAnswer(d), 7)) : undefined;
  const wrap = base => ({ ...base, async complete(request) { const d = JSON.parse(request.messages.at(-1).content); return { text: seven(d, request) ?? (await base.complete(request)).text }; } });
  await assert.rejects(tool(store, { ...args, maxPages: 5 }, wrap(provider())), /EPISODE_PAGE_COUNT/);
  const { store: s2, args: a2 } = await episodeSetup();
  const r = await tool(s2, { ...a2, pages: 7 }, wrap(provider()));
  assert.equal(r.status, 'awaiting_adaptation_approval'); assert.equal(r.approvalView.pages.length, 7); assert.equal(r.exactPages, 7); assert.equal(r.maxPages, 7);
  assert.equal(r.approvalView.estimatedImageCalls, 14);
  const { store: s3, args: a3 } = await episodeSetup();
  await assert.rejects(tool(s3, { ...a3, pages: 3 }, provider()), /EPISODE_PAGE_COUNT/);
});

test('the work page cap from lore_configure bounds the adaptation', async () => {
  const { store, args } = await episodeSetup();
  await runConfigureStatus({ store, workId, webtoonPageCap: 1 });
  const r = await tool(store, args, provider());
  assert.equal(r.maxPages, 1); assert.equal(r.status, 'awaiting_adaptation_approval');
  const { store: s2, args: a2 } = await episodeSetup();
  await runConfigureStatus({ store: s2, workId, webtoonPageCap: 2 });
  const base = provider();
  const three = { ...base, async complete(request) { const d = JSON.parse(request.messages.at(-1).content);
    return request.step === 'webtoon-adaptation' ? { text: JSON.stringify(withPages(adaptationAnswer(d), 3)) } : base.complete(request); } };
  await assert.rejects(tool(s2, a2, three), /EPISODE_PAGE_COUNT/);
});

test('an adaptation the validator rejects stops at model_failed and retry asks for a new answer', async () => {
  const { store, args } = await episodeSetup();
  let calls = 0; const base = provider();
  const flaky = { ...base, async complete(request) {
    if (request.step === 'webtoon-adaptation' && calls++ === 0) { const d = JSON.parse(request.messages.at(-1).content); const a = adaptationAnswer(d); a.pages[0].panels[0].texts[0].text = '원문에 없는 대사'; return { text: JSON.stringify(a) }; }
    return base.complete(request);
  } };
  await assert.rejects(tool(store, args, flaky), /EPISODE_TEXT_NOT_VERBATIM/);
  const failed = await saved(store);
  assert.equal(failed.stage, 'model_failed');
  const r = await tool(store, { workId, action: 'retry' }, flaky);
  assert.equal(r.status, 'awaiting_adaptation_approval'); assert.equal(r.revision, 2);
  await assert.rejects(tool(store, { workId, action: 'retry' }, flaky), /EPISODE_RETRY_NOT_AVAILABLE/);
});

test('a stale review is refused by the validator and stops at model_failed', async () => {
  const { store, args } = await episodeSetup();
  const base = provider();
  const stale = { ...base, async complete(request) {
    if (request.step !== 'webtoon-adaptation-review') return base.complete(request);
    const d = JSON.parse(request.messages.at(-1).content);
    return { text: JSON.stringify({ ...adaptationReviewAnswer(d, request), subjectHash: 'sha256:other' }) };
  } };
  await assert.rejects(tool(store, args, stale), /STALE_ADAPTATION_REVIEW/);
  assert.equal((await saved(store)).stage, 'model_failed');
});

test('novel disabledReviews does not disable the adaptation check', async () => {
  const { store, args } = await episodeSetup();
  await runConfigureStatus({ store, workId, disabledReviews: [...OPTIONAL_REVIEWS] });
  const p = provider();
  const r = await tool(store, args, p);
  assert.ok(steps(p).includes('webtoon-adaptation-review'));
  assert.equal(r.status, 'awaiting_adaptation_approval'); assert.equal(r.approvalView.checks.length, 5);
});

test('the adaptation review goes to the configured reviewer and is labelled by independence', async () => {
  const { store, args } = await episodeSetup();
  await runConfigureStatus({ store, workId, webtoonAdaptationReviewModel: { provider: 'host', modelId: 'reviewer-model' }, webtoonReviewModel: { provider: 'host', modelId: 'image-reviewer' } });
  const p = provider();
  const r = await tool(store, args, p);
  const [adapt, review] = p.requests;
  assert.deepEqual(adapt.model, { provider: 'host', modelId: 'host-agent' });
  assert.equal(review.model.modelId, 'reviewer-model');
  assert.equal(r.adaptationReviewModel.modelId, 'reviewer-model'); assert.equal(r.approvalView.independence, 'configured-model');
  const d = JSON.parse(review.messages.at(-1).content);
  assert.deepEqual(Object.keys(d).sort(), ['revision', 'schema', 'scriptOnly', 'sourceComparison', 'workflowId']);
  assert.match(review.messages[0].content, /scriptOnly/);
  // Without reviewer evidence the configured model's verdict is refused.
  const { store: s2, args: a2 } = await episodeSetup();
  await runConfigureStatus({ store: s2, workId, webtoonAdaptationReviewModel: { provider: 'host', modelId: 'reviewer-model' } });
  const base = provider();
  const noEvidence = { ...base, async complete(request) {
    if (request.step !== 'webtoon-adaptation-review') return base.complete(request);
    const { reviewerEvidence, ...answer } = adaptationReviewAnswer(JSON.parse(request.messages.at(-1).content), request); return { text: JSON.stringify(answer) };
  } };
  await assert.rejects(tool(s2, a2, noEvidence), /ADAPTATION_REVIEWER_EVIDENCE_REQUIRED/);
});

test('host relay resumes exact request ids through adaptation and review', async () => {
  const { store, args } = await episodeSetup();
  await runConfigureStatus({ store, workId, webtoonAdaptationReviewModel: { provider: 'host', modelId: 'reviewer-model' } });
  let r = await tool(store, args, createHostRelay());
  assert.equal(r.status, 'needs_model'); assert.equal(r.requests.length, 1);
  const q = r.requests[0], data = JSON.parse(q.user);
  assert.equal(q.step, 'webtoon-adaptation'); assert.equal(q.model, undefined);
  const run = await loadRun(store.rootDir, r.runId); assert.equal(run.tool, 'lore_webtoon_episode');
  // The reviewer changes after the review request was issued; the pending request stays pinned to the model it was issued for.
  r = await runWebtoonEpisodeTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(adaptationAnswer(data)) }) });
  assert.equal(r.status, 'needs_model'); const q2 = r.requests[0], d2 = JSON.parse(q2.user);
  assert.equal(q2.step, 'webtoon-adaptation-review'); assert.equal(q2.model.modelId, 'reviewer-model');
  assert.ok(d2.scriptOnly && d2.sourceComparison && d2.schema.subjectHash);
  await runConfigureStatus({ store, workId, webtoonAdaptationReviewModel: { provider: 'host', modelId: 'someone-else' } });
  const run2 = await loadRun(store.rootDir, r.runId); assert.equal(run2.tool, 'lore_webtoon_episode');
  r = await runWebtoonEpisodeTool({ store, args: run2.args, run: run2, providers: createHostRelay({ [q2.id]: JSON.stringify(adaptationReviewAnswer(d2, q2)) }) });
  assert.equal(r.status, 'awaiting_adaptation_approval'); assert.equal(r.approvalView.independence, 'configured-model');
  assert.equal(r.adaptationReviewModel.modelId, 'reviewer-model');
  assert.equal((await saved(store)).productionMode, 'episode-pages-v1');
  // A resume for a request that is no longer pending is stale.
  await assert.rejects(runWebtoonEpisodeTool({ store, args: run2.args, run: run2, providers: createHostRelay() }), /STALE_WEBTOON_RUN/);
});

test('a relay-routed failing review feeds the next adaptation request with its feedback', async () => {
  const { store, args } = await episodeSetup();
  let r = await tool(store, args, createHostRelay());
  let q = r.requests[0], run = await loadRun(store.rootDir, r.runId);
  r = await runWebtoonEpisodeTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(adaptationAnswer(JSON.parse(q.user))) }) });
  q = r.requests[0]; run = await loadRun(store.rootDir, r.runId);
  r = await runWebtoonEpisodeTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(adaptationReviewAnswer(JSON.parse(q.user), q, { fail: true })) }) });
  assert.equal(r.status, 'needs_model'); assert.equal(r.requests[0].step, 'webtoon-adaptation');
  assert.match(JSON.parse(r.requests[0].user).feedback, /readThrough \(failed\)/); assert.equal(r.attempts.length, 1);
});

test('reject stops the workflow and keeps the user words; later calls cannot approve', async () => {
  const { store, args } = await episodeSetup();
  const r = await tool(store, args, provider());
  await assert.rejects(tool(store, { workId, action: 'reject' }, provider()), /EPISODE_USER_ANSWER_REQUIRED/);
  const rejected = await tool(store, { workId, action: 'reject', feedback: '이 회차는 만들지 않겠습니다.' }, provider());
  assert.equal(rejected.status, 'rejected');
  await assert.rejects(tool(store, { workId, action: 'approve', approvalId: r.approvalView.approvalId, feedback: '네' }, provider()), /EPISODE_APPROVAL_NOT_AVAILABLE/);
  const next = await tool(store, args, provider());
  assert.equal(next.status, 'awaiting_adaptation_approval'); assert.notEqual(next.workflowId, r.workflowId);
});

test('a second start is refused while an episode workflow is active', async () => {
  const { store, args } = await episodeSetup();
  await tool(store, args, provider());
  await assert.rejects(tool(store, args, provider()), /WEBTOON_WORKFLOW_ACTIVE/);
});

test('verify is read-only and reports the adaptation and approval on record', async () => {
  const { store, args } = await episodeSetup();
  const r = await tool(store, args, provider());
  const before = JSON.stringify(await saved(store));
  const v = await tool(store, { workId, action: 'verify' }, provider());
  assert.equal(v.status, 'verified'); assert.equal(v.stage, 'awaiting_adaptation_approval'); assert.equal(v.approval, null);
  assert.deepEqual(v.checks.map(c => c.check), ['source', 'reference-bytes', 'adaptation']);
  assert.equal(JSON.stringify(await saved(store)), before);
  assert.equal(v.workflowId, r.workflowId);
  await assert.rejects(tool(store, { workId: 'other-work', action: 'verify', workflowId: r.workflowId }, provider()), /WORKFLOW_WORK_MISMATCH/);
});

test('other tools\' workflows are not episode workflows', async () => {
  const { store } = await episodeSetup();
  await assert.rejects(tool(store, { workId }, provider()), /EPISODE_WORKFLOW_NOT_FOUND/);
  await assert.rejects(tool(store, { workId, action: 'approve', approvalId: 'x', feedback: '네' }, provider()), /EPISODE_WORKFLOW_NOT_FOUND/);
});

test('English direction is required for every work language', async () => {
  const { store, args } = await episodeSetup();
  await assert.rejects(tool(store, { ...args, direction: '윤이 문 앞에 선다' }, provider()), /EPISODE_ENGLISH_DIRECTION_REQUIRED/);
});
