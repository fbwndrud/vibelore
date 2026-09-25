/**
 * 2026-09-24 ar/zh-Hant/th acceptance: review-mode profiles injected a fixed English
 * "Reading difficulty" question into designReview.openQuestions, and the approval
 * language gate rejected it as OUTPUT_LANGUAGE_MISMATCH four times out of four.
 *
 * Contract: like every other open question, the model writes the readability question
 * in the work language and the gate reviews it. When the model omits it, the host
 * inserts its static ko/en question; that static host text is bound to the approval
 * hash but is not a work-language artifact.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { projectApprovalValue } from '../src/core/approval-language-gate.js';
import { runStoryProfile, runStoryProfileDecide } from '../src/tools/story-profile.js';
import { phrases as multilingualPhrases } from '../src/prompts/multilingual.js';
import { phrases as koPhrases } from '../src/prompts/ko.js';
import { promptKit } from '../src/prompts/index.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';

const QUESTION_ID = 'reading-experience-contract';
const newStore = async () => new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'profile-readability-')));
const arabicQuestion = { id: QUESTION_ID, title: 'صعوبة القراءة', question: 'ما مدى صعوبة الجمل وسرعة المفاهيم الجديدة؟', recommendation: 'نوصي بجمل سهلة ومفاهيم تدخل ببطء.' };
const arabicProfile = (openQuestions = []) => ({
  genreLabel: 'دراما الميناء', engineGenre: 'other', subgenres: ['دراما'], tones: ['دافئ'],
  format: { pov: 'الغائب المحدود', serialization: 'رواية مسلسلة' },
  narrativeContract: { depthMode: 'commercial-dramatic', readerPromise: 'ثقة تبنى بالعمل', readerLegibility: 'هدف المشهد واضح', registerPolicy: 'لغة يومية' },
  designReview: { settledDecisions: [], openQuestions: [{ id: 'first-payoff', title: 'المكافأة الأولى', question: 'متى يرى القارئ أول نجاح؟', recommendation: 'في نهاية الفصل الأول.' }, ...openQuestions] },
});

/** A strict reviewer of the open questions: any Latin-letter phrase there is not Arabic. */
function strictArabicReviewer(profileJson) {
  const reviewed = [];
  return { reviewed, pending: [], async complete(request) {
    if (request.step === 'story-profile') return { text: JSON.stringify(profileJson) };
    const input = JSON.parse(request.messages[1].content);
    reviewed.push(input.artifact);
    const evidence = (input.artifact.value.designReview?.openQuestions ?? []).flatMap((item, index) => ['title', 'question', 'recommendation']
      .filter(key => typeof item[key] === 'string' && /[A-Za-z]{4,}/.test(item[key]))
      .map(key => ({ fieldPath: `value.designReview.openQuestions[${index}].${key}`, quote: item[key], reason: 'English, not Arabic' })));
    return { text: JSON.stringify({ language: 'ar', artifactHash: input.artifactHash, verdict: evidence.length ? 'fail' : 'pass', evidence, allowedExceptions: [] }) };
  } };
}

test('an Arabic review profile the model left without a readability question still passes the language gate', async () => {
  const store = await newStore();
  const providers = strictArabicReviewer(arabicProfile());
  const out = await runStoryProfile({ store, workId: 'book', language: 'ar', brief: 'قصة ميناء', mode: 'review', providers });
  assert.equal(out.status, undefined, JSON.stringify(out.validation?.failureDetails ?? out.code));
  const question = out.profile.designReview.openQuestions.find(item => item.id === QUESTION_ID);
  assert.equal(question.title, multilingualPhrases.profile.readabilityQuestionTitle, 'the host still asks its static question');
  // The reviewer never saw the static host text, but its exact value is bound in the hash.
  assert.equal(JSON.stringify(providers.reviewed.at(-1)).includes(question.title), false);
  const approved = await runStoryProfileDecide({ store, workId: 'book', action: 'approve', providers });
  assert.equal(approved.approved, true, JSON.stringify(approved.validation?.failureDetails ?? approved.code));
});

test('a readability question the model wrote in the work language is kept and reviewed like other open questions', async () => {
  const store = await newStore();
  const providers = strictArabicReviewer(arabicProfile([arabicQuestion]));
  const out = await runStoryProfile({ store, workId: 'book', language: 'ar', brief: 'قصة ميناء', mode: 'review', providers });
  assert.equal(out.status, undefined, JSON.stringify(out.validation?.failureDetails ?? out.code));
  const questions = out.profile.designReview.openQuestions;
  assert.deepEqual(questions.map(item => item.id), ['first-payoff', QUESTION_ID]);
  assert.deepEqual(questions.at(-1), arabicQuestion);
  assert.ok(JSON.stringify(providers.reviewed.at(-1)).includes(arabicQuestion.question), 'generated question text is language-reviewed');
});

test('an English question under the readability id that is not the exact host text is still language-reviewed', async () => {
  const store = await newStore();
  const forged = { id: QUESTION_ID, title: 'Reading difficulty', question: 'How hard should the prose be?', recommendation: 'Easy.' };
  const providers = strictArabicReviewer(arabicProfile([forged]));
  const out = await runStoryProfile({ store, workId: 'book', language: 'ar', brief: 'قصة ميناء', mode: 'review', providers });
  assert.equal(out.status, 'clean_fail');
  assert.equal(out.validation.failureCode, 'OUTPUT_LANGUAGE_MISMATCH');
});

test('only the exact multilingual host question, only in a non-ko work, only at designReview.openQuestions, is exempt', () => {
  const question = (kitPhrases) => ({ id: QUESTION_ID, title: kitPhrases.profile.readabilityQuestionTitle, question: kitPhrases.profile.readabilityQuestion, recommendation: kitPhrases.profile.readabilityRecommendation });
  const project = (value, promptFamily) => projectApprovalValue(value, [], { promptFamily });
  const exempt = project({ designReview: { openQuestions: [question(multilingualPhrases)] } }, 'multilingual').designReview.openQuestions[0];
  assert.deepEqual(Object.keys(exempt), ['id']);
  assert.match(exempt.id, /^[0-9a-f]{64}$/);
  // An edited copy is generated text and is reviewed.
  assert.equal(project({ designReview: { openQuestions: [{ ...question(multilingualPhrases), recommendation: 'changed' }] } }, 'multilingual').designReview.openQuestions[0].recommendation, 'changed');
  // ko works: the Korean question is Korean text in a Korean work; nothing is exempt and the projection is as before B2.
  for (const kitPhrases of [koPhrases, multilingualPhrases]) {
    const value = { designReview: { openQuestions: [question(kitPhrases)] } };
    assert.deepEqual(project(value, 'ko'), value);
    assert.deepEqual(projectApprovalValue(value), value, 'the default projection exempts nothing');
  }
  // The ko text is not exempt in a non-ko work either.
  assert.deepEqual(project({ designReview: { openQuestions: [question(koPhrases)] } }, 'multilingual').designReview.openQuestions[0], question(koPhrases));
  // Anchored at the root designReview only.
  const nested = { wrapper: { designReview: { openQuestions: [question(multilingualPhrases)] } } };
  assert.deepEqual(project(nested, 'multilingual').wrapper.designReview.openQuestions[0], question(multilingualPhrases));
});

// Review 2026-09-24 Important 2: before B2 the ko path always replaced a model-written
// readability question with the static ko question. ko must stay exactly that way.
test('ko replaces a model-written readability question with the static ko question, as before', async () => {
  const store = await newStore();
  const own = { id: QUESTION_ID, title: '읽기', question: '모델이 쓴 난도 질문', recommendation: '모델 추천' };
  const providers = { pending: [], async complete(request) {
    if (request.step === 'story-profile') return { text: JSON.stringify({ genreLabel: '항구 드라마', engineGenre: 'other', designReview: { settledDecisions: [], openQuestions: [own] } }) };
    const input = JSON.parse(request.messages[1].content);
    reviewed.push(input.artifact);
    return { text: JSON.stringify({ language: 'ko', artifactHash: input.artifactHash, verdict: 'pass', evidence: [], allowedExceptions: [] }) };
  } };
  const reviewed = [];
  const out = await runStoryProfile({ store, workId: 'book', language: 'ko', brief: '항구 이야기', mode: 'review', providers });
  // Review Minor 3: a ko work's reviewer sees the Korean question text, as before B2 (no digest).
  assert.ok(JSON.stringify(reviewed.at(-1)).includes(koPhrases.profile.readabilityQuestion));
  assert.deepEqual(out.profile.designReview.openQuestions, [{ id: QUESTION_ID, title: koPhrases.profile.readabilityQuestionTitle, question: koPhrases.profile.readabilityQuestion, recommendation: koPhrases.profile.readabilityRecommendation }]);
});

test('the multilingual profile prompt asks the model for the readability question in the work language', () => {
  const kit = promptKit({ contract: buildLanguageContract({ language: 'ar' }) });
  const messages = kit.messages('story-profile', { source: 'x', genre: 'x', existingJson: 'x', feedback: 'x', engineGenres: 'other' });
  const text = messages.map(m => m.content).join('\n');
  assert.match(text, /openQuestions[^.]*"reading-experience-contract"[^.]*target work language/);
});
