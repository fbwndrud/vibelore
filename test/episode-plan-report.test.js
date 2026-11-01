import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { runConfigureStatus } from '../src/tools/configure.js';
import { runEpisodePlan } from '../src/tools/episode-plan.js';
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
