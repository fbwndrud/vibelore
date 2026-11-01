import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { runConfigureStatus } from '../src/tools/configure.js';
import { renderEpisodeOutcome, renderEpisodePlan, runEpisodePlan } from '../src/tools/episode-plan.js';
import { STAGE_REVIEW_FOCUS } from '../src/core/planning-stage-review.js';
import { WRITER_PACKET_MAX_TOKENS, compileWriterEpisodePacket } from '../src/core/writer-episode-packet.js';
import { promptKit } from '../src/prompts/index.js';
import { renderArcBeat, renderArcBeatShape, renderPreviousChapterHookEvents } from '../src/core/prompt-sections.js';
import { profileCheckInputs } from '../src/core/profile-check-input.js';
import { emptyStoryState } from '../engine/src/continuity/story-state.js';
import { qualityStore, workId } from './fixtures/quality-workflow.js';
import { approvalResponse } from './fixtures/approval-response.js';
import { EXPECTATION_HANDLING } from '../src/core/narrative-codes.js';

const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
const kit = promptKit({});
const enKit = promptKit({ language: 'en' });

const minimalPlan = {
  title: '두 번째 문', premise: '윤재가 잠긴 두 번째 문을 연다.', povCharacter: 'hero', cast: ['hero'], locations: ['탑 복도'],
  openingState: '복도에 선다', closingState: '문이 열린다',
  scenes: [
    { location: '탑 복도', characters: ['hero'], situation: '문이 잠겼다', choice: '열쇠를 찾는다', change: '열쇠를 얻는다' },
    { location: '문 앞', characters: ['hero'], situation: '문이 무겁다', choice: '민다', change: '열린다' },
  ],
};

async function capturedEpisodeRequest(t, { coded, chapter }) {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  await runConfigureStatus({ store, workId, planningReviews: { episode: false } });
  const arc = await store.loadArcPlan(workId);
  const codes = coded ? { role: 'peak', hookType: 'ability' } : {};
  await store.saveArcPlan(workId, { ...arc, episodes: arc.episodes.map((episode) => (episode.chapter === chapter ? { ...episode, ...codes } : episode)) });
  if (chapter > 1) {
    await store.saveStoryState({ ...emptyStoryState(workId), chapterNumber: chapter - 1,
      hooks: [{ id: 'h1', text: '잠긴 두 번째 문', status: 'open', plantedAtChapter: chapter - 1, lastMovedChapter: chapter - 1 }] });
  }
  let captured;
  await runEpisodePlan({ store, workId, chapter, mode: 'review',
    providers: { pending: [], async complete(req) {
      const approval = approvalResponse(req); if (approval) return approval;
      if (req.step === 'episode-plan') captured = req;
      return { text: JSON.stringify(minimalPlan) };
    } } });
  return { request: captured, store };
}

const hooksFor = (chapter, rows) => rows.map(([id, text, status, planted, moved]) => ({ id, text, status, plantedAtChapter: planted, lastMovedChapter: moved }));

test('previous-chapter hook events are classified, ordered and capped', () => {
  const hooks = hooksFor(3, [['h10', 'old', 'open', 1, 2], ['h2', 'new', 'open', 2, 2], ['h3', 'paid', 'paid', 1, 2], ['h4', 'quiet', 'open', 1, 1]]);
  const text = renderPreviousChapterHookEvents({ hooks }, 3, kit);
  assert.equal(text.split('\n')[0], kit.phrases.sections.prevHookEventsHeading);
  assert.deepEqual(text.split('\n').slice(1), ['h2: new (planted)', 'h3: paid (paid)', 'h10: old (advanced)']);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `h${i + 1}`, text: 't', status: 'open', plantedAtChapter: 2, lastMovedChapter: 2 }));
  assert.equal(renderPreviousChapterHookEvents({ hooks: many }, 3, kit).split('\n').length, 9);
});

test('a fixed none line for chapter 1, tracking off and no events', () => {
  for (const k of [kit, enKit]) {
    const none = k.phrases.sections.prevHookEventsNone;
    assert.ok(renderPreviousChapterHookEvents(null, 1, k).endsWith(none));
    assert.ok(renderPreviousChapterHookEvents({ hooks: [{ id: 'h1', text: 't', status: 'open', plantedAtChapter: 1, lastMovedChapter: 1 }] }, 2, k, { tracking: { hooks: false } }).endsWith(none));
    assert.ok(renderPreviousChapterHookEvents({ hooks: [] }, 2, k).endsWith(none));
    assert.ok(renderPreviousChapterHookEvents({ hooks: [{ id: 'h1', text: 't', status: 'open', plantedAtChapter: 1, lastMovedChapter: 1 }] }, 3, k).endsWith(none));
  }
  assert.doesNotMatch(enKit.phrases.sections.prevHookEventsHeading + enKit.phrases.sections.prevHookEventsNone, HANGUL);
  assert.deepEqual(Object.keys(enKit.phrases.sections).sort(), Object.keys(kit.phrases.sections).sort());
});

test('episode-plan messages carry arcShapeText and the hook events, in the contract order, only for coded arcs', async (t) => {
  const { request, store } = await capturedEpisodeRequest(t, { coded: true, chapter: 2 });
  const user = request.messages[1].content;
  const arcBeat = renderArcBeat((await store.loadArcPlan(workId)).episodes[1], kit);
  const shapeLine = renderArcBeatShape({ role: 'peak', hookType: 'ability' }, kit);
  assert.ok(shapeLine && user.includes(`\n${shapeLine}\n`));
  assert.ok(user.indexOf(arcBeat) < user.indexOf(shapeLine) && user.indexOf(shapeLine) < user.indexOf('사용자 추가 방향'));
  const heading = kit.phrases.sections.prevHookEventsHeading;
  assert.ok(user.indexOf(kit.phrases.sections.currentStateHeading) < user.indexOf(heading) && user.indexOf(heading) < user.indexOf('필수 JSON 스키마:'));
  assert.ok(user.indexOf(heading) < user.indexOf('recap'));
  assert.match(user, /^h1: .* \(planted\)$/m);
  const plain = (await capturedEpisodeRequest(t, { coded: false, chapter: 1 })).request.messages[1].content;
  assert.equal(plain.includes(kit.phrases.arc.shape.prefix), false);
  assert.ok(plain.includes(kit.phrases.sections.prevHookEventsNone));
});

test('system and schema carry the shape sentence, the recap instruction and the report keys', async (t) => {
  const { request } = await capturedEpisodeRequest(t, { coded: true, chapter: 2 });
  const [system, user] = request.messages.map((m) => m.content);
  assert.match(system, /planConflict/);
  assert.match(user, /"recap":""/);
  assert.match(user, /"planConflict":\{"beatAssumption":"","actualState":"","evidence":""\}/);
  assert.ok(user.includes(`"handling":"${EXPECTATION_HANDLING.join('|')}"`));
  assert.ok(user.indexOf('"recap":""') < user.indexOf('"title":"가제"'));
  const en = enKit.messages('episode-plan', { arcShapeText: 'Shape: peak', hookEventsText: enKit.phrases.sections.prevHookEventsNone, stateText: 'S', direction: 'd', feedback: 'f' });
  assert.match(en[0].content, /planConflict/);
  assert.match(en[1].content, /"recap":""/);
  assert.match(en[1].content, /"planConflict":\{"beatAssumption":"","actualState":"","evidence":""\}/);
  assert.ok(en[1].content.includes(`"handling":"${EXPECTATION_HANDLING.join('|')}"`));
  assert.ok(en[1].content.indexOf('Shape: peak') > en[1].content.indexOf('Fixed beat for the current chapter:'));
  assert.doesNotMatch(en.map((m) => m.content).join('\n'), HANGUL);
});

test('the story-profile-check input does not get the shape line', () => {
  const arcEpisode = { index: 2, chapter: 2, title: '문', beat: '문이 열린다', role: 'peak', hookType: 'ability' };
  const shapeLine = renderArcBeatShape(arcEpisode, kit);
  assert.ok(shapeLine);
  const inputs = profileCheckInputs({ profile: {}, arcEpisode, episodePlan: {}, foundation: {}, prose: 'p', kit });
  assert.equal(inputs.arcBeatText.includes(kit.phrases.arc.shape.prefix), false);
  assert.equal(inputs.arcBeatText, renderArcBeat(arcEpisode, kit));
});

test('ja episode-plan messages contain no Hangul instructions and are identical on a repeat call', () => {
  const ja = promptKit({ language: 'ja' });
  const state = { hooks: hooksFor(3, [['h1', '鍵の謎', 'open', 2, 2], ['h2', '約束', 'paid', 1, 2]]) };
  const build = () => ja.messages('episode-plan', {
    arcBeatText: 'beat', arcShapeText: renderArcBeatShape({ role: 'peak', hookType: 'ability' }, ja),
    hookEventsText: renderPreviousChapterHookEvents(state, 3, ja), stateText: 'S', direction: 'd', feedback: 'f' });
  assert.deepEqual(build(), build());
  for (const message of build()) assert.doesNotMatch(message.content, HANGUL);
  assert.match(build()[1].content, /^h1: 鍵の謎 \(planted\)$/m);
});

// Runs the episode planner once with the model answer overlaid on a valid plan.
async function runWith(t, overrides, arcCodes = {}, { chapter = 1 } = {}) {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  await runConfigureStatus({ store, workId, planningReviews: { episode: false } });
  const arc = await store.loadArcPlan(workId);
  await store.saveArcPlan(workId, { ...arc, episodes: arc.episodes.map((episode) => (episode.chapter === chapter ? { ...episode, ...arcCodes } : episode)) });
  return runEpisodePlan({ store, workId, chapter, mode: 'review',
    providers: { pending: [], async complete(req) {
      return approvalResponse(req) ?? { text: JSON.stringify({ ...minimalPlan, ...overrides }) };
    } } });
}

test('recap and a complete planConflict are stored with length caps; an incomplete or malformed report is dropped', async (t) => {
  const kept = (await runWith(t, { recap: 'r'.repeat(500), planConflict: { beatAssumption: 'a', actualState: 'b', evidence: 'e'.repeat(400) } })).plan;
  assert.equal(kept.recap.length, 400);
  assert.equal(kept.planConflict.evidence.length, 300);
  assert.deepEqual(Object.keys(kept.planConflict), ['beatAssumption', 'actualState', 'evidence']);
  const noEvidence = (await runWith(t, { planConflict: { beatAssumption: 'a', actualState: 'b' } })).plan;
  assert.equal(noEvidence.planConflict.evidence, '');
  assert.equal('planConflict' in (await runWith(t, { planConflict: { beatAssumption: 'a', actualState: '' } })).plan, false);
  assert.equal('planConflict' in (await runWith(t, { planConflict: { beatAssumption: '', actualState: 'b', evidence: 'e' } })).plan, false);
  assert.equal('recap' in (await runWith(t, {})).plan, false);
  assert.equal('recap' in (await runWith(t, { recap: '   ' })).plan, false);
  for (const bad of [42, ['x'], { text: 'x' }, null]) {
    const plan = (await runWith(t, { recap: bad, planConflict: bad })).plan;
    assert.equal('recap' in plan, false);
    assert.equal('planConflict' in plan, false);
    assert.equal(plan.title, minimalPlan.title);
  }
  assert.equal('planConflict' in (await runWith(t, { planConflict: 'conflict' })).plan, false);
});

test('handling and hookType inherit from the arc beat; invalid codes fall back', async (t) => {
  const coded = { expectationHandling: 'twist', hookType: 'ability' };
  assert.equal((await runWith(t, {}, coded)).plan.readerExpectation.handling, 'twist');
  assert.equal((await runWith(t, { readerExpectation: { handling: 'delay' } }, coded)).plan.readerExpectation.handling, 'delay');
  assert.equal((await runWith(t, { readerExpectation: { handling: 'bogus' } }, coded)).plan.readerExpectation.handling, 'twist');
  assert.equal('handling' in (await runWith(t, { readerExpectation: { handling: 'bogus' } })).plan.readerExpectation, false);
  assert.equal('handling' in (await runWith(t, {})).plan.readerExpectation, false);
  assert.equal((await runWith(t, {}, coded)).plan.exitValue.hookType, 'ability');
  assert.equal((await runWith(t, {})).plan.exitValue.hookType, 'result');
  assert.equal((await runWith(t, { exitValue: { hookType: 'moral' } }, coded)).plan.exitValue.hookType, 'moral');
});

test('recap and planConflict stay out of the writer packet and every rendered plan', async (t) => {
  const recap = 'RECAP-MARKER 지난 화 요약';
  const planConflict = { beatAssumption: 'ASSUME-MARKER', actualState: 'ACTUAL-MARKER', evidence: 'EVIDENCE-MARKER' };
  const { plan } = await runWith(t, { recap, planConflict });
  assert.equal(plan.recap, recap);
  const packet = compileWriterEpisodePacket({ episodePlan: { ...plan, status: 'active' }, arcEpisode: plan.arcBeat, prevState: emptyStoryState(workId), budget: { maxTokens: WRITER_PACKET_MAX_TOKENS } });
  assert.ok(packet.ok, JSON.stringify(packet));
  const rendered = [JSON.stringify(packet), renderEpisodePlan(plan, kit), renderEpisodePlan(plan, enKit), renderEpisodeOutcome(plan, kit)].join('\n');
  for (const marker of ['RECAP-MARKER', 'ASSUME-MARKER', 'ACTUAL-MARKER', 'EVIDENCE-MARKER']) assert.equal(rendered.includes(marker), false, marker);
});

test('a planning-stage revision cannot change or erase the first pass report', async (t) => {
  for (const revisedReport of [{}, { recap: 'changed', planConflict: { beatAssumption: 'x', actualState: 'y', evidence: 'z' } }]) {
    const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
    const profile = await store.loadStoryProfile(workId);
    await store.saveStoryProfile(workId, { ...profile, discovery: { depth: 'deep', authority: 'user', userAnswer: '함께 자세히 준비해요.' } });
    const review = (findings) => ({ checks: STAGE_REVIEW_FOCUS.episode.map((focus) => ({ focus, result: 'met', evidence: '선택이 사건을 바꾼다.' })), findings });
    const repair = { id: 'promise', evidence: '목표가 약하다.', reason: '확정한 목표와 다르다.', action: 'repair', contractEvidence: '문을 연다', revision: '목표를 되살린다.' };
    const steps = [];
    const first = { ...minimalPlan, recap: 'r', planConflict: { beatAssumption: 'a', actualState: 'b', evidence: 'e' } };
    let reviews = 0;
    const { plan } = await runEpisodePlan({ store, workId, chapter: 1, mode: 'review',
      providers: { pending: [], async complete(req) {
        steps.push(req.step);
        const approval = approvalResponse(req); if (approval) return approval;
        if (req.step === 'episode-plan') return { text: JSON.stringify(first) };
        if (req.step === 'episode-plan-review') return { text: JSON.stringify(review(reviews++ === 0 ? [repair] : [])) };
        if (req.step === 'episode-plan-revision') return { text: JSON.stringify({ ...minimalPlan, title: '수정된 제목', ...revisedReport }) };
        throw new Error(`unexpected ${req.step}`);
      } } });
    assert.ok(steps.includes('episode-plan-revision'), steps.join(','));
    assert.equal(plan.title, '수정된 제목');
    assert.equal(plan.recap, 'r');
    assert.deepEqual(plan.planConflict, { beatAssumption: 'a', actualState: 'b', evidence: 'e' });
  }
});

test('a revision cannot add a report the first pass did not make', async (t) => {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  const profile = await store.loadStoryProfile(workId);
  await store.saveStoryProfile(workId, { ...profile, discovery: { depth: 'deep', authority: 'user', userAnswer: '함께 자세히 준비해요.' } });
  const review = (findings) => ({ checks: STAGE_REVIEW_FOCUS.episode.map((focus) => ({ focus, result: 'met', evidence: '선택이 사건을 바꾼다.' })), findings });
  const repair = { id: 'promise', evidence: '목표가 약하다.', reason: '확정한 목표와 다르다.', action: 'repair', contractEvidence: '문을 연다', revision: '목표를 되살린다.' };
  let reviews = 0;
  const { plan } = await runEpisodePlan({ store, workId, chapter: 1, mode: 'review',
    providers: { pending: [], async complete(req) {
      const approval = approvalResponse(req); if (approval) return approval;
      if (req.step === 'episode-plan') return { text: JSON.stringify(minimalPlan) };
      if (req.step === 'episode-plan-review') return { text: JSON.stringify(review(reviews++ === 0 ? [repair] : [])) };
      if (req.step === 'episode-plan-revision') return { text: JSON.stringify({ ...minimalPlan, title: '수정된 제목', recap: 'new', planConflict: { beatAssumption: 'x', actualState: 'y' } }) };
      throw new Error(`unexpected ${req.step}`);
    } } });
  assert.equal(plan.title, '수정된 제목');
  assert.equal('recap' in plan, false);
  assert.equal('planConflict' in plan, false);
});
