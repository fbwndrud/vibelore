import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualityStore, workId } from './fixtures/quality-workflow.js';
import { runReviseTool } from '../src/tools/generate.js';
import { runCreativeDecisionTool } from '../src/tools/creative-decisions.js';
import { revisePreferenceContext } from '../src/core/draft-input-compiler.js';
import { promptKit } from '../src/prompts/index.js';

const casual = { action: 'adopt', level: 'subject', subjectId: 'hero', statement: '윤재는 누구에게나 반말을 쓴다.', userAnswer: 'USER_WORDS 윤재는 항상 반말로 말해' };
const drier = { action: 'adopt', level: 'work', statement: '서술은 감정어를 줄이고 건조하게 쓴다.', userAnswer: 'USER_WORDS 좀 더 건조하게' };
const decide = (store, args) => runCreativeDecisionTool({ store, workId, ...args });
const violation = [{ severity: 'hard', code: 'X', chapterNumber: 1, message: '문장을 고친다.' }];

function recordingProvider() {
  const requests = [];
  return {
    requests,
    async complete(req) {
      requests.push(req);
      return { text: '{"replacements":[],"insertions":[],"castManifest":{"cast":[]}}' };
    },
  };
}
const reviseText = (providers) => providers.requests.find((req) => req.step === 'revise').messages.at(-1).content;
async function revise(store, extra = {}) {
  const providers = recordingProvider();
  await runReviseTool({ store, workId, chapter: 1, prose: '윤재가 문을 열었다.', violations: violation, providers, ...extra });
  return reviseText(providers);
}

test('a revision request carries the active preferences as soft style context', async () => {
  const store = await qualityStore();
  await decide(store, drier);
  await decide(store, casual);
  const text = await revise(store);
  assert.match(text, /"creativePreferences": \{\n\s+"rule": "사용자가 직접 채택한 부드러운 선호다\./);
  assert.match(text, /"work": \[\n\s+"서술은 감정어를 줄이고 건조하게 쓴다\."/);
  assert.match(text, /"subjects": \{\n\s+"hero": \[\n\s+"윤재는 누구에게나 반말을 쓴다\."/);
  assert.doesNotMatch(text, /USER_WORDS/);
});

test('an explicit list replaces the live ledger', async () => {
  const store = await qualityStore();
  await decide(store, drier);
  const plain = await revise(await qualityStore());
  assert.equal(await revise(store, { creativePreferences: [] }), plain);
});

test('a work whose preferences are all retired sends the same revise request as a work without a ledger', async () => {
  const store = await qualityStore();
  await decide(store, casual);
  await decide(store, { action: 'retire', id: 'dec-1' });
  assert.equal(await revise(store), await revise(await qualityStore()));
});

test('revisePreferenceContext refuses an invalid list and returns null for an empty one', () => {
  const kit = promptKit({ contract: undefined });
  assert.equal(revisePreferenceContext([], kit), null);
  assert.throws(() => revisePreferenceContext([{ id: 'bad' }], kit), /INVALID_DRAFT_INPUT: creativePreferences invalid-preference-shape/);
});

test('revisePreferenceContext groups character ids that name Object.prototype members', () => {
  const kit = promptKit({ contract: undefined });
  const subject = (id, ref, statement) => ({ id, level: 'subject', ref, statement });
  const context = revisePreferenceContext([
    subject('dec-1', 'constructor', '건축가는 짧게 말한다.'),
    subject('dec-2', 'hero', '윤재는 누구에게나 반말을 쓴다.'),
    subject('dec-3', '__proto__', '원형은 말이 없다.'),
    subject('dec-4', 'toString', '서기는 숫자로 말한다.'),
    subject('dec-5', 'constructor', '건축가는 도면 이야기만 한다.'),
  ], kit);
  assert.equal(JSON.stringify(context.subjects), JSON.stringify(Object.fromEntries([
    ['constructor', ['건축가는 짧게 말한다.', '건축가는 도면 이야기만 한다.']],
    ['hero', ['윤재는 누구에게나 반말을 쓴다.']],
    ['__proto__', ['원형은 말이 없다.']],
    ['toString', ['서기는 숫자로 말한다.']],
  ])));
});
