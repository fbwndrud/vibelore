/**
 * B5 (2026-09-24 acceptance follow-up): when the model omitted a profile value, the host
 * filled English defaults ("Design question N", "web serial", the reader-legibility
 * and register-policy guidance) into work-language fields, which fail the language
 * gate for every work other than ko/en.
 *
 * Contract: the multilingual prompt asks the model for these values in the work
 * language. When it still omits one, the host writes nothing into that work-language
 * field; the runtime prompt guidance falls back to the family's static instruction
 * (prompt text, not canon). The ko family keeps its Korean defaults byte for byte.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runStoryProfile, runStoryProfileDecide, compileBriefWithProfile } from '../src/tools/story-profile.js';
import { compileNarrativeContract } from '../src/core/narrative-contract.js';
import { phrases as koPhrases } from '../src/prompts/ko.js';
import { phrases as multilingualPhrases } from '../src/prompts/multilingual.js';
import { promptKit } from '../src/prompts/index.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';

const newStore = async () => new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'profile-defaults-')));
const WORKS = {
  ar: { brief: 'قصة ميناء', genreLabel: 'دراما الميناء', question: 'متى يرى القارئ أول نجاح؟', readerPromise: 'ثقة تبنى بالعمل' },
  th: { brief: 'เรื่องท่าเรือ', genreLabel: 'ดราม่าท่าเรือ', question: 'ผู้อ่านจะเห็นความสำเร็จครั้งแรกเมื่อไร', readerPromise: 'ความไว้ใจที่สร้างจากการทำงาน' },
};
/** A profile answer that omits every field the host used to fill with English. */
const omittingProfile = (work) => ({
  genreLabel: work.genreLabel, engineGenre: 'other',
  format: { pov: work.genreLabel },
  narrativeContract: { depthMode: 'commercial-dramatic', readerPromise: work.readerPromise },
  readabilityContract: { confirmedByUser: false },
  designReview: { settledDecisions: [], openQuestions: [{ id: 'first-payoff', question: work.question, recommendation: work.readerPromise }] },
});

/** A strict reviewer: any Latin-letter phrase in a reviewed string is not the work language. */
function strictReviewer(language, profileJson) {
  const reviewed = [];
  return { reviewed, pending: [], async complete(request) {
    if (request.step === 'story-profile') return { text: JSON.stringify(profileJson) };
    const input = JSON.parse(request.messages[1].content);
    reviewed.push(input.artifact);
    const value = input.artifact.value;
    const candidates = [
      ...(value.designReview?.openQuestions ?? []).flatMap((item, index) => ['title', 'question', 'recommendation']
        .map(key => [`value.designReview.openQuestions[${index}].${key}`, item[key]])),
      ['value.format.serialization.description', value.format?.serialization?.description],
      ['value.narrativeContract.readerLegibility', value.narrativeContract?.readerLegibility],
      ['value.narrativeContract.registerPolicy', value.narrativeContract?.registerPolicy],
    ];
    const evidence = candidates.filter(([, text]) => typeof text === 'string' && /[A-Za-z]{4,}/.test(text))
      .map(([fieldPath, quote]) => ({ fieldPath, quote, reason: 'English, not the work language' }));
    return { text: JSON.stringify({ language, artifactHash: input.artifactHash, verdict: evidence.length ? 'fail' : 'pass', evidence, allowedExceptions: [] }) };
  } };
}

for (const [language, work] of Object.entries(WORKS)) {
  test(`${language}: a profile that omits title, serialization, legibility and register policy passes and stores no English`, async () => {
    const store = await newStore();
    const providers = strictReviewer(language, omittingProfile(work));
    const out = await runStoryProfile({ store, workId: 'book', language, brief: work.brief, mode: 'review', providers });
    assert.equal(out.status, undefined, JSON.stringify(out.validation?.failureDetails ?? out.code));
    const { profile } = out;
    assert.equal(profile.designReview.openQuestions[0].title, '');
    assert.equal(profile.format.serialization, '');
    assert.equal(profile.narrativeContract.readerLegibility, '');
    assert.equal(profile.narrativeContract.registerPolicy, '');
    const approved = await runStoryProfileDecide({ store, workId: 'book', action: 'approve', providers });
    assert.equal(approved.approved, true, JSON.stringify(approved.validation?.failureDetails ?? approved.code));
    // Runtime prompt guidance still carries the family's static instruction (prompt text, not canon).
    const kit = promptKit({ contract: buildLanguageContract({ language }) });
    const contract = compileNarrativeContract({ profile: approved.profile, kit });
    assert.equal(contract.readerLegibility, multilingualPhrases.contract.defaultReaderLegibility);
    assert.equal(contract.registerPolicy, multilingualPhrases.contract.defaultRegisterPolicy);
    const brief = compileBriefWithProfile('brief', approved.profile, 'worldbuild', kit);
    assert.ok(brief.includes(`Reader legibility: ${multilingualPhrases.contract.defaultReaderLegibility}`));
    assert.ok(brief.includes(`Register policy: ${multilingualPhrases.contract.defaultRegisterPolicy}`));
  });
}

test('ko keeps its Korean host defaults byte for byte', async () => {
  const store = await newStore();
  const providers = strictReviewer('ko', omittingProfile({ ...WORKS.ar, genreLabel: '항구 드라마', question: '첫 성공은 언제 보이나?', readerPromise: '일로 쌓는 신뢰' }));
  const out = await runStoryProfile({ store, workId: 'book', language: 'ko', brief: '항구 이야기', mode: 'review', providers });
  const { profile } = out;
  assert.equal(profile.designReview.openQuestions[0].title, '설계 질문 1');
  assert.equal(profile.format.serialization, '웹소설 연재');
  assert.equal(profile.narrativeContract.readerLegibility, koPhrases.profile.defaultReaderLegibility);
  assert.equal(profile.narrativeContract.registerPolicy, koPhrases.profile.defaultRegisterPolicy);
});

test('the multilingual profile prompt asks the model for these values in the work language', () => {
  const kit = promptKit({ contract: buildLanguageContract({ language: 'th' }) });
  const text = kit.messages('story-profile', { source: 'x', genre: 'x', existingJson: 'x', feedback: 'x', engineGenres: 'other' }).map(m => m.content).join('\n');
  assert.match(text, /every open question's title, format\.serialization, narrativeContract\.readerLegibility and narrativeContract\.registerPolicy[^.]*target work language/);
});
