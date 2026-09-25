import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tokenUnits } from '../src/core/token-units.js';
import { compileWriterEpisodePacket } from '../src/core/writer-episode-packet.js';

const KO = '윤서는 등대 앞 공터에 붙여둔 배정표 앞에 서서, 검지로 6구역이라 적힌 칸을 짚었다. 아침 햇살이 아직 낮아 그림자가 길었다.';
const ES = 'Mara cree que el puerto puede reabrirse sin pedir ayuda a nadie, y por eso lleva sola la lista de reparaciones.';

test('Korean text keeps the legacy code-point / 2 estimate exactly', () => {
  assert.equal(tokenUnits(KO), Math.ceil([...KO].length / 2));
  assert.equal(tokenUnits(''), 1);
  assert.equal(tokenUnits(null), 1);
});

test('Latin-script text is estimated at four characters per token', () => {
  assert.equal(tokenUnits(ES), Math.ceil([...ES].length / 4));
  assert.ok(tokenUnits(ES) < Math.ceil([...ES].length / 2));
});

test('Han and Kana keep the / 2 estimate', () => {
  const ja = '朝の潮はまだ低く、旧港の桟橋には灰色の霧が薄くかかっていた。';
  const zh = '林澄把潮汐表攤在推車上，指尖點著明日清晨的退潮線。';
  assert.equal(tokenUnits(ja), Math.ceil([...ja].length / 2));
  assert.equal(tokenUnits(zh), Math.ceil([...zh].length / 2));
});

// 2026-09-15 th 표본: 타이 문자를 / 2 로 세어 같은 내용의 EpisodePlan 이 1930 > 1400 으로 EPISODE_PACKET_OVERFLOW.
// 같은 스키마의 응답이 한국어의 1.64배 문자라서 단위당 3자로 읽어야 같은 내용이 같은 단위가 된다.
test('Thai is estimated at three characters per unit like the other abugidas', () => {
  const th = 'หญิงผู้ดูแลประภาคารนับแผ่นไม้ก่อนที่ช่างซ่อมจะมาถึง';
  const letters = [...th].filter((char) => /\p{Script=Thai}/u.test(char)).length;
  assert.equal(tokenUnits(th), Math.ceil(letters / 3 + ([...th].length - letters) / 4));
});

// 2026-09-15 ar 표본: 아랍 문자를 CJK 급(/ 2)으로 세어 fr/es 와 같은 크기의 초고 packet 이 4225 > 4000 으로 CONTEXT_BUDGET_EXCEEDED.
test('Arabic and Hebrew are estimated at three characters per unit, spaces and punctuation at four', () => {
  const ar = 'كانت حارسة المنارة تعدّ الألواح قبل أن يصل المرمّم.';
  const letters = [...ar].filter((char) => /\p{Script=Arabic}/u.test(char)).length;
  const rest = [...ar].length - letters;
  assert.equal(tokenUnits(ar), Math.ceil(letters / 3 + rest / 4));
  assert.ok(tokenUnits(ar) < Math.ceil([...ar].length / 2));
  const he = 'שומרת המגדלור ספרה את הקרשים לפני שהגיע המשקם.';
  assert.ok(tokenUnits(he) < Math.ceil([...he].length / 2));
});

// 2026-09-15 es 표본: 7.4k 자 스페인어 EpisodePlan 이 / 2 추정으로 1400 예산을 넘겨 EPISODE_PACKET_OVERFLOW.
test('a long Spanish episode plan fits the default writer packet budget', () => {
  const sentence = 'Mara cuenta las tablas del muelle mientras Ellis cuenta la confianza que ella no le da, y ninguno de los dos cede antes de la marea. ';
  const long = (n) => sentence.repeat(n).trim();
  const plan = {
    status: 'active', chapter: 1, revision: 1, language: 'es', title: 'El muelle terco', premise: long(2), readerBridge: long(2),
    povCharacter: 'c1', cast: ['c1', 'c2'], foregroundCharacters: ['c1', 'c2'], openingState: long(1), closingState: long(2),
    immediateGoal: long(1), obstacle: long(1), choice: long(1), outcome: long(1), nextQuestion: long(1),
    readerLoad: { phase: 'onboarding', newConcepts: ['la marea de la fiesta'] },
    scenes: [1, 2, 3].map((i) => ({ location: 'muelle', characters: ['c1', 'c2'], situation: long(1), choice: long(1), change: long(1) })),
    costCreatedByResolution: { immediate: long(1), deferred: long(1) },
    episodeVoiceTargets: [1, 2].map((i) => ({ characterId: 'c1', sceneOrder: i, speakingPressure: long(1), surfaceIntent: long(1), hiddenIntent: long(1), sampleLine: long(1), narrationFilter: long(1) })),
    withheld: [long(1), long(1)],
    payoff: { promisePaid: long(1), proofOnPage: long(1) }, entryState: { protagonistImmediateWant: long(1) }, exitValue: { specificFutureValue: long(1) },
  };
  const result = compileWriterEpisodePacket({ episodePlan: plan, arcEpisode: { chapter: 1 }, characterNames: { c1: 'Mara', c2: 'Ellis' } });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.value.usage.usedTokens <= 1400);
  assert.ok([...result.value.writerText].length > 2800, 'the packet is longer than the old 2800-character ceiling');
});

test('the plugin re-exports the single engine implementation', async () => {
  const engine = await import('../engine/src/core/token-units.js');
  assert.equal(tokenUnits, engine.tokenUnits);
});
