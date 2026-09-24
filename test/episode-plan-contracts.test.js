import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runEpisodePlan } from '../src/tools/episode-plan.js';
import { createPreflightRelay } from '../src/provider/host-relay.js';
import { qualityStore, workId } from './fixtures/quality-workflow.js';
import { approvalResponse, approvalFixtureProvider } from './fixtures/approval-response.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runInit } from '../src/tools/init.js';

const enBasePlan = {
  title: 'The Second Door', premise: 'Ann opens the second locked door.', povCharacter: 'hero', cast: ['hero'], locations: ['tower hallway'],
  openingState: 'stands in the hallway', closingState: 'the door opens',
  scenes: [
    { location: 'tower hallway', characters: ['hero'], situation: 'the door is locked', choice: 'looks for a key', change: 'finds a key' },
    { location: 'in front of the door', characters: ['hero'], situation: 'the door is heavy', choice: 'pushes it', change: 'it opens' },
  ],
};
const enIncompleteAgenda = { characterId: 'hero', goal: 'open the door', nextAction: 'look for the key', resources: ['hands'], knowledge: ['the door is locked'], redLine: 'do not hurt anyone', fallback: 'go back' };
const enCompleteAgenda = { ...enIncompleteAgenda, deadline: 'before dark', misbelief: 'the door only opens by force' };
const enIncompleteReveal = { id: 'key-origin', inducedHypothesis: 'the key fell by chance', actualCause: 'the tax collector left it', dualUseClues: ['a stamp mark'], concealment: 'dust', recontextualizesSceneIds: [], triggeredByChoice: 'picks up the key', changes: { actions: ['opens the door'], relationships: [], costs: ['debt grows'] } };
const enCompleteReveal = { ...enIncompleteReveal, recontextualizesSceneIds: ['chapter-1-scene-1'] };

async function enQualityStore() {
  const enWorkId = 'quality-regression-en';
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-quality-en-')));
  await runInit({ providers: approvalFixtureProvider(), store, workId: enWorkId, genre: 'litrpg', language: 'en', povMode: '3인칭제한', worldFacts: ['The tower collects a toll.'] });
  const foundation = await store.loadFoundation(enWorkId);
  await store.saveFoundation({ ...foundation, characters: [{ id: 'hero', canonicalName: 'Ann', aliases: [], registeredAtChapter: 1,
    intrinsic: { gender: 'female', ageBand: '20s', role: 'protagonist', coreAppearance: [] }, mutable: { status: 'alive', knownFacts: ['already learned to zoom the map.'] } }] });
  await store.saveStoryProfile(enWorkId, { workId: enWorkId, language: 'en', status: 'active', revision: 1, engineGenre: 'litrpg', genreLabel: 'Lighthearted adventure', subgenres: [], themes: [], tracking: { semantic: [], engineBacked: [] }, tones: ['upbeat'], storyEngines: ['enjoying playtime bought with power'],
    format: { pov: '3인칭제한', chapterChars: 3300, dialogueBreakMode: 'relaxed' },
    narrativeContract: { readerPromise: 'the promise of genuinely enjoying playtime' },
    voiceContract: { genreVoiceRecipe: { narration: 'reacts with wry calm while learning the unknown.', exposition: 'keeps the 2006 experience separate from the 2026 usage.' },
      narrationExamples: [{ situation: 'map', example: 'She had learned the map. Now it was time to find the sea.' }],
      dialogueExamples: [{ situation: 'meal', example: '"The world is saved, so let\'s eat first."' }] },
    promptGuidance: { avoid: [], worldbuild: [], cast: [], arc: [], draft: ['use the learned map trick in the next action.'] },
  });
  await store.saveStorySpine(enWorkId, { status: 'active', causalChain: ['opens the door', 'plays together', 'finds a new path'] });
  await store.saveWriterSkill(enWorkId, { status: 'active', revision: 1, authorCraft: { judgments: ['shows joy through action'] } });
  await store.saveStoryIdentity(enWorkId, { readerPromise: 'play', protagonistAppeal: 'someone easy to ask things of', emotionalDefect: '', competenceSignature: ['controls her strength'], comedyEngines: ['the familiar meeting the new culture'], solutionPatternsToRotate: ['combat'] });
  await store.savePilotContract(enWorkId, { seriesPromise: 'play' });
  const scenes = [{ situation: 'stands before a closed door', choice: 'pushes the door', change: 'the door opens' }, { situation: 'a path appears', choice: 'walks forward', change: 'goes inside' }];
  await store.saveArcPlan(enWorkId, { status: 'active', arcNumber: 1, title: 'The First Door', promise: 'the play beyond the door', startChapter: 1, estimatedEpisodes: 3,
    episodes: [1, 2, 3].map((chapter) => ({ chapter, index: chapter, beat: `event ${chapter}`, goal: 'opens the door', pressure: 'locked door', carry: 'play' })) });
  await store.saveEpisodePlan(enWorkId, { status: 'active', revision: 1, chapter: 1, arcNumber: 1, premise: 'follows the path seen on the map', cast: ['hero'], povCharacter: 'hero', locations: ['tower entrance'],
    openingState: 'at the entrance', closingState: 'goes inside', scenes, payoff: { promisePaid: 'opens the door', proofOnPage: 'goes inside' }, entryState: { protagonistImmediateWant: 'entry' }, exitValue: { specificFutureValue: 'goes inside' } });
  return { store, workId: enWorkId };
}

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
    // The episode approval gate asks for a language proof; answer it without counting it as planning.
    const approval = approvalResponse(req); if (approval) return approval;
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
    const long = (label) => `${label} `.repeat(300).trim();
    const bloated = { ...basePlan, readerBridge: long('다리'), closingState: long('결말'), withheld: Array.from({ length: 8 }, (_, i) => long(`숨김${i}`)), scenes: basePlan.scenes.map((scene) => ({ ...scene, situation: long('상황'), choice: long('선택'), change: long('변화') })) };
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
    const long = (label) => `${label} `.repeat(300).trim();
    const bloated = { ...basePlan, readerBridge: long('다리'), closingState: long('결말'), withheld: Array.from({ length: 8 }, (_, i) => long(`숨김${i}`)), scenes: basePlan.scenes.map((scene) => ({ ...scene, situation: long('상황'), choice: long('선택'), change: long('변화') })) };
    const providers = sequenceProvider({ 'episode-plan': [JSON.stringify(bloated)], 'episode-plan-repair': [JSON.stringify(bloated)] });
    await assert.rejects(runEpisodePlan({ store, workId, chapter: 2, mode: 'auto', providers }), /EPISODE_PACKET_OVERFLOW/);
    assert.equal(await store.loadEpisodePlan(workId, 2), null);
  });

  const KO_REPAIR_INSTRUCTION = '제목·장면·선택 모듈의 기존 내용은 유지하고, 위 오류에 해당하는 누락되거나 빈 필드만 채워 전체 계획 JSON을 다시 출력한다. 선택 모듈을 쓰려면 그 모듈의 모든 필드를 채우고, 정말 필요 없는 모듈이면 키 자체를 제거한다.';

  it('keeps the ko repair instruction byte-identical', async () => {
    const store = await qualityStore();
    const requests = [];
    const providers = sequenceProvider({
      'episode-plan': [JSON.stringify({ ...basePlan, characterAgendas: [incompleteAgenda], revealContracts: [incompleteReveal] })],
      'episode-plan-repair': [JSON.stringify({ ...basePlan, characterAgendas: [completeAgenda], revealContracts: [completeReveal] })],
    }, requests);
    await runEpisodePlan({ store, workId, chapter: 2, mode: 'auto', providers });
    const repair = requests.find((req) => req.step === 'episode-plan-repair');
    const instructionLine = repair.messages[1].content.split('\n').pop();
    assert.equal(instructionLine, KO_REPAIR_INSTRUCTION);
  });

  it('requests a repair in the work language family instead of hardcoded Korean', async () => {
    const { store: enStore, workId: enWorkId } = await enQualityStore();
    const requests = [];
    const providers = sequenceProvider({
      'episode-plan': [JSON.stringify({ ...enBasePlan, characterAgendas: [enIncompleteAgenda], revealContracts: [enIncompleteReveal] })],
      'episode-plan-repair': [JSON.stringify({ ...enBasePlan, characterAgendas: [enCompleteAgenda], revealContracts: [enCompleteReveal] })],
    }, requests);
    const result = await runEpisodePlan({ store: enStore, workId: enWorkId, chapter: 2, mode: 'auto', providers });
    const repair = requests.find((req) => req.step === 'episode-plan-repair');
    assert.ok(repair, 'repair request issued for en work');
    const instructionLine = repair.messages[1].content.split('\n').pop();
    assert.doesNotMatch(instructionLine, /[가-힣]/u, 'en repair instruction must not contain Korean');
    assert.equal(result.plan.status, 'active');
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
