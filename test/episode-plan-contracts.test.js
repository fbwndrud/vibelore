import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runEpisodePlan } from '../src/tools/episode-plan.js';
import { createPreflightRelay } from '../src/provider/host-relay.js';
import { qualityStore, workId } from './fixtures/quality-workflow.js';

const basePlan = {
  title: '두 번째 문', premise: '윤재가 잠긴 두 번째 문을 연다.', povCharacter: 'hero', cast: ['hero'], locations: ['탑 복도'],
  openingState: '복도에 선다', closingState: '문이 열린다',
  scenes: [
    { location: '탑 복도', characters: ['hero'], situation: '문이 잠겼다', choice: '열쇠를 찾는다', change: '열쇠를 얻는다' },
    { location: '문 앞', characters: ['hero'], situation: '문이 무겁다', choice: '민다', change: '열린다' },
  ],
};
const incompleteAgenda = { characterId: 'hero', goal: '문을 연다', nextAction: '열쇠를 찾는다', resources: ['손'], knowledge: ['문이 잠겼다'], redLine: '남을 다치게 하지 않는다', fallback: '돌아간다' };
const completeAgenda = { ...incompleteAgenda, deadline: '해 지기 전', misbelief: '문은 힘으로만 열린다' };
const incompleteReveal = { id: 'key-origin', inducedHypothesis: '열쇠는 우연히 떨어졌다', actualCause: '징수관이 두고 갔다', dualUseClues: ['도장 자국'], concealment: '먼지', recontextualizesSceneIds: [], triggeredByChoice: '열쇠를 줍는다', changes: { actions: ['문을 연다'], relationships: [], costs: ['빚이 는다'] } };
const completeReveal = { ...incompleteReveal, recontextualizesSceneIds: ['chapter-1-scene-1'] };

function sequenceProvider(answers, requests = []) {
  const queues = Object.fromEntries(Object.entries(answers).map(([step, list]) => [step, [...list]]));
  return { register() {}, has() { return true; }, get pending() { return []; }, async complete(req) {
    requests.push(req);
    const queue = queues[req.step];
    if (!queue || !queue.length) throw new Error(`unexpected step ${req.step}`);
    return { text: queue.shift() };
  } };
}

describe('episode plan contracts are validated before drafting', () => {
  it('requests a repair for an incomplete optional module instead of saving it', async () => {
    const store = await qualityStore();
    const requests = [];
    const providers = sequenceProvider({
      'episode-plan': [JSON.stringify({ ...basePlan, characterAgendas: [incompleteAgenda], revealContracts: [incompleteReveal] })],
      'episode-plan-repair': [JSON.stringify({ ...basePlan, characterAgendas: [completeAgenda], revealContracts: [completeReveal] })],
    }, requests);
    const result = await runEpisodePlan({ store, workId, chapter: 2, mode: 'auto', providers });
    const repair = requests.find((req) => req.step === 'episode-plan-repair');
    assert.ok(repair, 'repair request issued');
    const repairText = repair.messages.map((m) => m.content).join('\n');
    assert.match(repairText, /deadline/);
    assert.match(repairText, /misbelief/);
    assert.match(repairText, /recontextualizesSceneIds/);
    assert.match(repairText, /key-origin/);
    assert.equal(result.plan.status, 'active');
    assert.equal(result.plan.characterAgendas[0].deadline, '해 지기 전');
    assert.deepEqual(result.plan.revealContracts[0].recontextualizesSceneIds, ['chapter-1-scene-1']);
  });

  it('fails clearly when the repaired plan is still incomplete', async () => {
    const store = await qualityStore();
    const providers = sequenceProvider({
      'episode-plan': [JSON.stringify({ ...basePlan, characterAgendas: [incompleteAgenda] })],
      'episode-plan-repair': [JSON.stringify({ ...basePlan, characterAgendas: [incompleteAgenda] })],
    });
    await assert.rejects(runEpisodePlan({ store, workId, chapter: 2, mode: 'auto', providers }), /EPISODE_PLAN_CONTRACT_INVALID/);
    assert.equal(await store.loadEpisodePlan(workId, 2), null);
  });

  it('requests a repair when the accepted plan overflows the writer packet budget', async () => {
    const store = await qualityStore();
    const requests = [];
    const long = (label) => `${label} `.repeat(120).trim();
    const bloated = { ...basePlan, readerBridge: long('다리'), closingState: long('결말'), scenes: basePlan.scenes.map((scene) => ({ ...scene, situation: long('상황'), choice: long('선택'), change: long('변화') })) };
    const providers = sequenceProvider({ 'episode-plan': [JSON.stringify(bloated)], 'episode-plan-repair': [JSON.stringify(basePlan)] }, requests);
    const result = await runEpisodePlan({ store, workId, chapter: 2, mode: 'auto', providers });
    const repair = requests.find((req) => req.step === 'episode-plan-repair');
    assert.ok(repair, 'repair request issued');
    const repairText = repair.messages.map((m) => m.content).join('\n');
    assert.match(repairText, /EPISODE_PACKET_OVERFLOW/);
    assert.match(repairText, /requiredTokens/);
    assert.equal(result.plan.status, 'active');
    assert.equal(result.plan.closingState, '문이 열린다');
  });

  it('fails at planning time when the repaired plan still overflows the packet budget', async () => {
    const store = await qualityStore();
    const long = (label) => `${label} `.repeat(120).trim();
    const bloated = { ...basePlan, readerBridge: long('다리'), closingState: long('결말'), scenes: basePlan.scenes.map((scene) => ({ ...scene, situation: long('상황'), choice: long('선택'), change: long('변화') })) };
    const providers = sequenceProvider({ 'episode-plan': [JSON.stringify(bloated)], 'episode-plan-repair': [JSON.stringify(bloated)] });
    await assert.rejects(runEpisodePlan({ store, workId, chapter: 2, mode: 'auto', providers }), /EPISODE_PACKET_OVERFLOW/);
    assert.equal(await store.loadEpisodePlan(workId, 2), null);
  });

  it('does not request a repair when optional modules are complete or absent', async () => {
    const store = await qualityStore();
    const requests = [];
    const providers = sequenceProvider({ 'episode-plan': [JSON.stringify({ ...basePlan, characterAgendas: [completeAgenda] })] }, requests);
    const result = await runEpisodePlan({ store, workId, chapter: 2, mode: 'auto', providers });
    assert.deepEqual(requests.map((req) => req.step), ['episode-plan']);
    assert.equal(result.plan.status, 'active');
  });

  it('keeps the first host round trip to the plan request alone', async () => {
    const store = await qualityStore();
    const relay = createPreflightRelay({});
    const result = await runEpisodePlan({ store, workId, chapter: 2, mode: 'auto', providers: relay });
    assert.equal(result.preview, true);
    assert.deepEqual(relay.pending.map((req) => req.step), ['episode-plan']);
  });

  it('tells the model that optional modules must be complete when present', async () => {
    const store = await qualityStore();
    const requests = [];
    await runEpisodePlan({ store, workId, chapter: 2, mode: 'auto', providers: sequenceProvider({ 'episode-plan': [JSON.stringify(basePlan)] }, requests) });
    const text = requests[0].messages.map((m) => m.content).join('\n');
    assert.match(text, /모든 필드를 채운다|모두 채운다/);
  });
});
