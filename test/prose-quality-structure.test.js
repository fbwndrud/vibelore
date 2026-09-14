import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runCommit } from '../src/tools/commit.js';
import { editorialQualityAdvisories, runEditorialQuality } from '../src/tools/editorial-quality.js';
import { assertProseIntegrity, inspectProseIntegrity } from '../src/tools/prose-integrity.js';
import { dramaticQualityViolations } from '../src/tools/workflow.js';
import { mergeFragmentedNarration, normalizeWebnovelLayout, scanWebnovelFormat, separateBuriedDialogue } from '../src/tools/webnovel-format.js';
import { characterFidelityAdvisories, characterFidelityViolations, runCharacterFidelity } from '../src/tools/character-fidelity.js';

describe('prose quality structure', () => {
  it('rejects leaked machine values before they can become canonical prose', async () => {
    const polluted = '그는 종료 휘슬을 들었다.\n\nnull\nnull';
    assert.equal(inspectProseIntegrity(polluted)[0].code, 'MACHINE_VALUE_LEAK');
    assert.throws(() => assertProseIntegrity(polluted), /본문 무결성 검사 실패/);
    await assert.rejects(
      () => runCommit({ store: {}, workId: 'football', chapter: 3, prose: polluted, providers: {} }),
      (error) => error.code === 'PROSE_INTEGRITY_FAILED',
    );
    assert.doesNotThrow(() => assertProseIntegrity('그는 아무 말 없이 전술판을 뒤집었다.'));
  });

  it('reviews prose blind without leaking the arc or episode answer key', async () => {
    let request;
    const providers = {
      async complete(input) {
        request = input;
        return { text: JSON.stringify({ score: 80, dimensions: {}, findings: [] }) };
      },
    };
    await runEditorialQuality({
      prose: '본문 고유 표식', context: '직전 상태', arcMap: '유출되면 안 될 전체 아크',
      episodePlan: '유출되면 안 될 회차 정답', providers,
    });
    const prompt = request.messages.map((message) => message.content).join('\n');
    assert.match(prompt, /본문 고유 표식/);
    assert.match(prompt, /직전 상태/);
    assert.doesNotMatch(prompt, /유출되면 안 될 전체 아크|유출되면 안 될 회차 정답/);
    assert.match(prompt, /powerShift/);
    assert.match(prompt, /consequenceResidue/);
  });

  it('fails a weak dramatic dimension even when the editorial average is high', () => {
    const violations = dramaticQualityViolations({
      score: 92,
      dimensions: { powerShift: 42, subtext: 80, consequenceResidue: 75, surpriseIntegrity: 70 },
      findings: [{ dimension: 'powerShift', code: 'STATIC_POWER', message: '협상 전후의 우위가 같다.' }],
    }, 3);
    assert.deepEqual(violations.map((item) => item.code), ['STATIC_POWER']);
    assert.equal(violations[0].chapterNumber, 3);
  });

  it('flags dense mobile paragraphs but accepts normally separated webnovel prose', () => {
    const denseParagraph = Array.from({ length: 14 }, (_, index) => `이것은 독자가 모바일 화면에서 읽기에는 지나치게 조밀하여 별도 문단으로 나눠야 하는 ${index + 1}번째 문장이다.`).join(' ');
    const dense = scanWebnovelFormat({ prose: denseParagraph, chapterNumber: 2 });
    assert.ok(dense.violations.some((item) => item.code === 'WEBNOVEL_DENSE_PARAGRAPH'));
    const readable = scanWebnovelFormat({ prose: '문이 열렸다.\n\n“들어가.”\n\n도윤은 대답하지 않고 신발 끈을 조였다.', chapterNumber: 2 });
    assert.deepEqual(readable.violations, []);
    const buried = `${'서술이 길게 이어졌다. '.repeat(8)}“지금 가.” 뒤의 행동도 계속됐다.`;
    const separated = separateBuriedDialogue(buried);
    assert.match(separated, /\n\n“지금 가.”\n\n/);
    assert.equal(separated.replace(/\s+/g, ''), buried.replace(/\s+/g, ''));
  });

  it('requires every quoted speech span to be its own paragraph by default', () => {
    const mixed = '“너, 받침 짐 이리 줘.” 그녀가 짐꾼 하나를 불렀다. “기둥 앞 교대 금지. 분류대 옆으로 빼.”';
    const strict = scanWebnovelFormat({ prose: mixed, chapterNumber: 1 });
    assert.ok(strict.violations.some((item) => item.code === 'WEBNOVEL_DIALOGUE_NOT_ISOLATED'));
    const separated = separateBuriedDialogue(mixed);
    assert.deepEqual(scanWebnovelFormat({ prose: separated, chapterNumber: 1 }).violations, []);
    assert.equal(separated.replace(/\s+/g, ''), mixed.replace(/\s+/g, ''));
    const relaxed = scanWebnovelFormat({ prose: mixed, chapterNumber: 1, dialogueBreakMode: 'relaxed' });
    assert.ok(!relaxed.violations.some((item) => item.code === 'WEBNOVEL_DIALOGUE_NOT_ISOLATED'));
  });

  it('advises when narration is fragmented into a long run of card-like beats', () => {
    const fragmented = Array.from({ length: 20 }, (_, index) => `그는 ${index + 1}번째 표시를 보았다.`).join('\n\n');
    const result = scanWebnovelFormat({ prose: fragmented, chapterNumber: 3 });
    assert.ok(result.violations.some((item) => item.code === 'WEBNOVEL_FRAGMENTED_RHYTHM'));
    assert.equal(result.stats.longestFragmentedRun, 20);
  });

  it('rejects many soft line breaks masquerading as merged webnovel paragraphs', () => {
    const prose = Array.from({ length: 25 }, (_, index) => `그는 ${index + 1}번째 표시를 확인했다.`).join('\n');
    const result = scanWebnovelFormat({ prose, chapterNumber: 8 });
    assert.ok(result.violations.some((item) => item.code === 'WEBNOVEL_SOFT_LINEBREAKS'));
    assert.equal(result.stats.softLineBreaks, 24);
    assert.equal(result.stats.multiLineParagraphs, 1);
  });

  it('merges only long narration runs and preserves every dialogue boundary', () => {
    const fragmented = Array.from({ length: 6 }, (_, index) => `그는 ${index + 1}번째 표시를 보았다.`).join('\n\n');
    const merged = mergeFragmentedNarration(fragmented);
    assert.ok(merged.split(/\n\s*\n/).length < 6);
    assert.equal(merged.replace(/\s+/g, ''), fragmented.replace(/\s+/g, ''));

    const withDialogue = `${fragmented}\n\n“멈춰.”\n\n${fragmented}`;
    const normalized = normalizeWebnovelLayout(withDialogue);
    assert.match(normalized, /\n\n“멈춰.”\n\n/);
    assert.equal(normalized.replace(/\s+/g, ''), withDialogue.replace(/\s+/g, ''));
    assert.equal(normalized, withDialogue, '서술 리듬은 soft 판단이므로 자동 병합하지 않는다');
    assert.ok(!scanWebnovelFormat({ prose: normalized, chapterNumber: 3 }).violations.some((item) => item.code === 'WEBNOVEL_DIALOGUE_NOT_ISOLATED'));
  });

  it('flags character voice independently from a high overall editorial score', async () => {
    let request;
    const result = await runCharacterFidelity({
      prose: '냉정한 대장이 아무 이유 없이 모든 책임을 포기했다.', chapter: 4, context: '직전까지 책임을 지켰다.',
      foundation: { characters: [{
        id: 'captain', canonicalName: '서미라', aliases: [], contradiction: '대원을 살리려 냉정해졌다.', description: '비용부터 말한다.', intrinsic: { role: '대장' }, relationships: [],
        speechProfile: { defaultRegister: '명령형 반말', sentenceShape: '짧게 끊고 비용을 먼저 말한다', samples: { underPressure: '후퇴하면 둘을 잃어. 남으면 하나로 끝난다.' } },
      }] },
      providers: { async complete(input) { request = input; return { text: JSON.stringify({ score: 86, dimensions: { voice: 42, motivation: 90, responseCausality: 88, relationshipContinuity: 90, dialogueIntent: 80 }, findings: [{ characterId: 'captain', dimension: 'voice', code: 'VOICE_MISMATCH', message: '비용을 따지던 말투가 근거 없이 사라졌다.' }] }) }; } },
    });
    assert.match(request.messages[1].content, /대원을 살리려 냉정해졌다/);
    assert.match(request.messages[1].content, /speechProfile/);
    assert.match(request.messages[1].content, /VOICE_SAMPLE_COPIED/);
    assert.equal(result.score, 78);
    assert.equal(result.reportedScore, 86);
    assert.deepEqual(characterFidelityViolations(result, 4).map((item) => item.code), ['VOICE_MISMATCH']);
  });

  it('uses a stricter floor for character voice than other fidelity dimensions', () => {
    const violations = characterFidelityViolations({
      score: 82,
      dimensions: { voice: 65, motivation: 80, responseCausality: 80, relationshipContinuity: 80, dialogueIntent: 80 },
      findings: [],
    }, 6);
    assert.deepEqual(violations.map((item) => item.code), ['CHARACTER_VOICE_LOW']);
    assert.match(violations[0].message, /기준 70점/);
  });

  it('surfaces evidence-backed character findings without lowering the average', () => {
    const result = {
      score: 91,
      dimensions: { voice: 90, motivation: 92, responseCausality: 91, relationshipContinuity: 90, dialogueIntent: 92 },
      findings: [
        { characterId: 'captain', code: 'RELATIONSHIP_DRIFT', message: '공격 책임이 사라졌다.', evidence: '직전 화의 공격자를 풀어준 뒤 아무도 항의하지 않는다.', confidence: 0.93 },
        { characterId: 'captain', code: 'VOICE_MISMATCH', message: '말투가 어긋난다.', evidence: '', confidence: 0.98 },
        { characterId: 'captain', code: 'UNCAUSED_RESPONSE', message: '반응 근거가 약하다.', evidence: '명령 위반 직후 농담한다.', confidence: 0.62 },
      ],
    };
    assert.deepEqual(characterFidelityViolations(result, 4), []);
    assert.deepEqual(characterFidelityAdvisories(result, 4).map((item) => item.code), ['RELATIONSHIP_DRIFT']);
    assert.equal(characterFidelityAdvisories(result, 4)[0].advisoryOnly, true);
  });

  it('surfaces a high-confidence clean conflict reset independently from editorial score', () => {
    const result = {
      score: 94, dimensions: { consequenceResidue: 82 },
      findings: [{ code: 'CLEAN_CONFLICT_RESET', message: '충돌의 후속이 사라졌다.', evidence: '공격 다음 장면에서 가해자와 곧바로 농담한다.', confidence: 0.9 }],
    };
    assert.deepEqual(editorialQualityAdvisories(result, 3).map((item) => item.code), ['CLEAN_CONFLICT_RESET']);
  });

  it('keeps the legacy fidelity score while gating profile overperformance separately', async () => {
    const result = await runCharacterFidelity({
      prose: '모든 대사에서 숫자를 먼저 말했다.', chapter: 7, context: '',
      foundation: { characters: [] },
      providers: { async complete() { return { text: JSON.stringify({
        score: 90,
        dimensions: { voice: 90, motivation: 90, responseCausality: 90, relationshipContinuity: 90, dialogueIntent: 90 },
        flexibilityDimensions: { voiceRange: 55, offAxisHumanity: 72, profileRestraint: 40 },
        findings: [{ characterId: 'hero', dimension: 'profileRestraint', code: 'PROFILE_OVERPERFORMANCE', message: '모든 대사가 숫자 습관을 과시한다.' }],
      }) }; } },
    });
    assert.equal(result.score, 90);
    assert.equal(result.flexibilityScore, 56);
    assert.deepEqual(characterFidelityViolations(result, 7).map((item) => item.code), [
      'CHARACTER_VOICERANGE_LOW', 'PROFILE_OVERPERFORMANCE',
    ]);
  });
});
