import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { runConfigureStatus } from '../src/tools/configure.js';
import { runArcPlan, renderArcMap, renderArcRhythmStrip } from '../src/tools/arc.js';
import { deterministicArcViolations } from '../src/tools/arc-quality.js';
import { promptKit } from '../src/prompts/index.js';
import { qualityStore, workId } from './fixtures/quality-workflow.js';
import { approvalResponse } from './fixtures/approval-response.js';
import { EPISODE_ROLES, RHYTHM_CADENCE, rhythmModeOf } from '../src/core/narrative-codes.js';

async function plan(t, shapes) {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  await runConfigureStatus({ store, workId, planningReviews: { arc: false } });
  const raw = { title: '문 안', promise: '같이 논다', episodes: [1, 2, 3].map((i) => ({ title: `놀이 ${i}`, beat: `다른 사건 ${i}`, pressure: `장애 ${i}`, turn: `선택 ${i}`, carry: `다음 결과 ${i}`, ...shapes[i - 1] })) };
  return runArcPlan({ store, workId, mode: 'review', episodes: 3, replaceActive: true,
    providers: { pending: [], async complete(req) { return approvalResponse(req) ?? { text: JSON.stringify(raw) }; } } });
}

test('valid codes are kept, junk is dropped and never raises ARC_QUALITY', async (t) => {
  const result = await plan(t, [
    { role: 'setup', twistLevel: '2', expectationHandling: 'delay', hookType: 'ability', hookOps: [{ op: 'planted', label: 'key' }, { op: 'plant', label: 'x' }, { op: 'paid', label: '' }] },
    { role: 'hero', twistLevel: 4, expectationHandling: 'maybe', hookType: 'cliffhanger', hookOps: 'x' },
    { twistLevel: 0 }]);
  const [a, b, c] = result.plan.episodes;
  assert.deepEqual([a.role, a.twistLevel, a.expectationHandling, a.hookType, a.hookOps], ['setup', 2, 'delay', 'ability', [{ op: 'planted', label: 'key' }]]);
  for (const k of ['role', 'twistLevel', 'expectationHandling', 'hookType', 'hookOps']) assert.equal(k in b, false);
  assert.equal(c.twistLevel, 0); assert.equal(result.plan.arcPlanSchemaVersion, 2);
});

test('codes never change deterministic violations; an arc without codes stores and renders as before', async (t) => {
  const withCodes = (await plan(t, [{ role: 'peak', twistLevel: 3 }, {}, {}])).plan;
  const stripped = { ...withCodes, episodes: withCodes.episodes.map(({ role, twistLevel, ...rest }) => rest) };
  assert.deepEqual(deterministicArcViolations(withCodes), deterministicArcViolations(stripped));
  const plain = (await plan(t, [{}, {}, {}]));
  assert.equal(JSON.stringify(plain.plan.episodes[0]).includes('role'), false);
  assert.equal('rhythmStrip' in plain, false);
  assert.equal(renderArcRhythmStrip(plain.plan, promptKit({})), '');
  assert.equal(renderArcMap({ ...plain.plan, status: 'active' }, 1, promptKit({})).includes('shape'), false);
});

test('the active map of an arc without codes is byte-identical to the format before shapes existed', () => {
  const noCodes = { status: 'active', arcNumber: 1, title: '문 안', promise: '같이 논다', estimatedEpisodes: 2,
    episodes: [1, 2].map((i) => ({ index: i, chapter: i, title: `놀이 ${i}`, beat: `사건 ${i}`, pressure: `장애 ${i}`, turn: `선택 ${i}`, carry: `결과 ${i}` })) };
  assert.equal(renderArcMap(noCodes, 1, promptKit({})),
    '## 전체 활성 아크 지도 — Arc 1 「문 안」\n- 아크 약속: 같이 논다\n- ▶ 1/2화 「놀이 1」 / 사건=사건 1 / 압력=장애 1 / 전환=선택 1 / 전달=결과 1\n-   2/2화 「놀이 2」 / 사건=사건 2 / 압력=장애 2 / 전환=선택 2 / 전달=결과 2\n- 현재 화 이후 비트는 복선과 축적에만 참고하고, 사건 자체를 미리 소모하지 않는다.');
  assert.equal(renderArcMap(noCodes, 1, promptKit({ language: 'en' })),
    '## Full active arc map — Arc 1 "문 안"\n- Arc promise: 같이 논다\n- ▶ 1/2 "놀이 1" / event=사건 1 / pressure=장애 1 / turn=선택 1 / carries=결과 1\n-   2/2 "놀이 2" / event=사건 2 / pressure=장애 2 / turn=선택 2 / carries=결과 2\n- Beats after the current chapter are for foreshadowing and accumulation only; do not consume those events in advance.');
});

test('the review result carries a localized rhythm strip and the active map repeats the shape', async (t) => {
  const result = await plan(t, [{ role: 'peak', twistLevel: 1 }, { role: 'breather' }, {}]);
  assert.match(result.rhythmStrip, /1\/3/); assert.equal(result.rhythmStrip.split('\n').length, 2);
  assert.match(renderArcMap({ ...result.plan, status: 'active' }, 1, promptKit({})), /peak|정점/);
  assert.equal('rhythmStrip' in result.plan, false);
});

async function capturedArcRequest(t, { depthMode }) {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  await runConfigureStatus({ store, workId, planningReviews: { arc: false } });
  const profile = await store.loadStoryProfile(workId);
  await store.saveStoryProfile(workId, { ...profile, narrativeContract: { ...profile.narrativeContract, ...(depthMode ? { depthMode } : {}) } });
  const raw = { title: '문 안', promise: '같이 논다', episodes: [1, 2, 3].map((i) => ({ title: `놀이 ${i}`, beat: `다른 사건 ${i}`, pressure: `장애 ${i}`, turn: `선택 ${i}`, carry: `다음 결과 ${i}` })) };
  let captured;
  await runArcPlan({ store, workId, mode: 'review', episodes: 3, replaceActive: true,
    providers: { pending: [], async complete(req) {
      const approval = approvalResponse(req); if (approval) return approval;
      if (req.step === 'arc-plan') captured = req;
      return { text: JSON.stringify(raw) };
    } } });
  return captured;
}

test('rhythm text follows depthMode and sits right after the direction line', async (t) => {
  const kit = promptKit({});
  const directionLabel = '사용자 방향과 StoryProfile:';
  for (const mode of [...Object.keys(RHYTHM_CADENCE), undefined]) {
    const { messages } = await capturedArcRequest(t, { depthMode: mode });
    const expected = kit.phrases.arc.rhythm(rhythmModeOf(mode), RHYTHM_CADENCE[rhythmModeOf(mode)]);
    const user = messages[1].content;
    assert.ok(user.includes(expected), String(mode));
    assert.ok(user.indexOf(directionLabel) < user.indexOf(expected) && user.indexOf(expected) < user.indexOf(kit.phrases.spine.heading), String(mode));
  }
});

test('the English family places the rhythm text between the direction line and the spine', () => {
  const kit = promptKit({ language: 'en' });
  const rhythmText = kit.phrases.arc.rhythm('commercial-dramatic', RHYTHM_CADENCE['commercial-dramatic']);
  const user = kit.messages('arc-plan', { title: 'T', genre: 'g', arcNumber: 1, startChapter: 1, count: 3, direction: 'D', rhythmText,
    spineRender: kit.phrases.spine.heading, feedback: 'none', worldFacts: [], characters: [], seedsRender: '', summaries: [], previousArcReviewJson: '{}' })[1].content;
  assert.ok(user.indexOf('User direction') < user.indexOf(rhythmText) && user.indexOf(rhythmText) < user.indexOf(kit.phrases.spine.heading));
  assert.doesNotMatch(user, /[가-힣]/);
});

test('same inputs give identical arc-plan messages', async (t) => {
  assert.deepEqual((await capturedArcRequest(t, {})).messages, (await capturedArcRequest(t, {})).messages);
});

test('system defines the five keys as intent, schema lists the codes', async (t) => {
  const { messages } = await capturedArcRequest(t, {});
  assert.match(messages[1].content, new RegExp(`"role":"${EPISODE_ROLES.join('\\|')}"`));
  assert.match(messages[1].content, /"hookOps":\[\{"op":"planted\|advanced\|paid","label":""\}\]/);
  for (const key of ['role', 'twistLevel', 'expectationHandling', 'hookType', 'hookOps']) assert.ok(messages[0].content.includes(key));
  const en = promptKit({ language: 'en' }).system('arc-plan');
  for (const key of ['role', 'twistLevel', 'expectationHandling', 'hookType', 'hookOps']) assert.ok(en.includes(key));
  assert.doesNotMatch(en, /[가-힣]/);
});
