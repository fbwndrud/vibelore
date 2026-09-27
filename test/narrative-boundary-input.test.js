import test from 'node:test';
import assert from 'node:assert/strict';

import { runNarrativeBoundary } from '../src/tools/narrative-boundary.js';
import { promptKit } from '../src/prompts/index.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';

const kit = promptKit({ contract: buildLanguageContract({ language: 'ko' }) });
const episode = (chapter, tag) => ({ chapter, index: chapter, title: `T${tag}`, beat: `EVENT_${tag}`, pressure: `PRESSURE_${tag}`, turn: `TURN_${tag}`, payoff: `PAYOFF_${tag}`, carry: `CARRY_${tag}` });
const arcPlan = { status: 'active', arcNumber: 2, title: '가벼운 통행', promise: 'ARC_PROMISE', estimatedEpisodes: 3,
  readerContract: { openingQuestion: 'OPENING_Q', minimumPayoff: 'MIN_PAYOFF' },
  commercialPromise: { fantasy: 'REPEAT_PLEASURE', humanComplication: 'x' },
  oppositionAgency: { actor: 'OPPONENT', independentGoal: 'g', adaptationTrigger: 't' },
  episodes: [episode(4, 'PREV'), episode(5, 'CUR'), episode(6, 'NEXT')],
  characterArcs: [{ characterId: 'c1', promise: 'CURVE', beats: [{ episodeIndex: 1, beat: 'b', note: 'n' }] }],
  arcVoiceShifts: [{ characterId: 'c1', startingVoice: 'VOICE_SHIFT', pressureVoice: 'p', changedVoice: 'c' }] };
const episodePlan = { status: 'active', chapter: 5, title: '뒤를 채운 굽이', premise: 'PLAN_PREMISE',
  turn: { causedByChoice: 'PLAN_CHOICE' }, payoff: { promisePaid: 'PLAN_RESULT' }, exitValue: { nextQuestion: 'NEXT_Q' },
  scenes: [{ order: 1, location: 'L', situation: 'SCENE_SITUATION', choice: 'SCENE_CHOICE', change: 'SCENE_CHANGE' }],
  episodeVoiceTargets: [{ characterId: 'c1', sampleLine: 'VOICE_TARGET' }] };

async function userOf(plan) {
  let request;
  await runNarrativeBoundary({ arcPlan: plan, episodePlan, chapter: 5, prose: '본문', kit,
    providers: { async complete(req) { request = req; return { text: '{}' }; } } });
  return request.messages.find((m) => m.role === 'user').content;
}

test('boundary judge sees the arc promise, the current beat in full, the next beat and the plan results only', async () => {
  const user = await userOf(arcPlan);
  for (const kept of ['ARC_PROMISE', 'OPENING_Q', 'EVENT_CUR', 'TURN_CUR', 'PAYOFF_CUR', 'EVENT_NEXT', 'PLAN_CHOICE', 'PLAN_RESULT', 'NEXT_Q', 'SCENE_CHANGE']) {
    assert.match(user, new RegExp(kept), kept);
  }
  for (const dropped of ['EVENT_PREV', 'PRESSURE_NEXT', 'REPEAT_PLEASURE', 'OPPONENT', 'CURVE', 'VOICE_SHIFT', 'VOICE_TARGET', 'SCENE_SITUATION']) {
    assert.doesNotMatch(user, new RegExp(dropped), dropped);
  }
});

test('on the last beat the character curves are shown, since completing the arc settles them', async () => {
  const last = { ...arcPlan, episodes: [episode(4, 'PREV'), episode(5, 'CUR')] };
  const user = await userOf(last);
  assert.match(user, /CURVE/);
  assert.match(user, /마지막 화인가: true/);
});
