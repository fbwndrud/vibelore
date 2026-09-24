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

test('only the exact static host readability question of either family is exempt from the work-language review', () => {
  for (const kitPhrases of [multilingualPhrases, koPhrases]) {
    const staticQuestion = { id: QUESTION_ID, title: kitPhrases.profile.readabilityQuestionTitle, question: kitPhrases.profile.readabilityQuestion, recommendation: kitPhrases.profile.readabilityRecommendation };
    const projected = projectApprovalValue({ designReview: { openQuestions: [staticQuestion] } }).designReview.openQuestions[0];
    assert.deepEqual(Object.keys(projected), ['id']);
    assert.match(projected.id, /^[0-9a-f]{64}$/);
    const edited = projectApprovalValue({ designReview: { openQuestions: [{ ...staticQuestion, recommendation: 'changed' }] } }).designReview.openQuestions[0];
    assert.equal(edited.recommendation, 'changed');
  }
});

test('the multilingual profile prompt asks the model for the readability question in the work language', () => {
  const kit = promptKit({ contract: buildLanguageContract({ language: 'ar' }) });
  const messages = kit.messages('story-profile', { source: 'x', genre: 'x', existingJson: 'x', feedback: 'x', engineGenres: 'other' });
  const text = messages.map(m => m.content).join('\n');
  assert.match(text, /openQuestions[^.]*"reading-experience-contract"[^.]*target work language/);
});
