import { validationFixtureResponse } from '../_support/validation-responses.mjs';
/**
 * revise / rewrite — 다국어 Phase 2A 계열 (최종 provider messages 기준).
 *
 * 상수를 읽는 대신 `runRevise` / `runRewrite` 가 `providers.complete` 로 **실제로
 * 보낸 요청**을 캡처해 검증한다. 확인하는 계약:
 *   1. 계약 없는 구형 호출은 기존 한국어 프롬프트 그대로다(상수 비교).
 *   2. 비ko 는 영어 교정/집필 지시 계열 전체이며 system 에 한글 지시가 남지 않는다
 *      — "한국어 system + 목표 언어 한 줄" 형태가 아니다.
 *   3. 위반 ID·JSON 키·sentinel 은 두 계열에서 동일하다.
 *   4. 분량 수정 계약은 작품 계약의 측정 단위로만 말한다. 코드 단위 계측값을
 *      graphemes/words 목표로 둔갑시키지 않고 충돌로 거부한다.
 *   5. 대사·문단 모드는 포맷 정책이 정한다(계약 고정값 > 승인된 인자 > 계열 기본).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '../_support/vitest-shim.mjs';
import { FileStateStore } from '../../src/core/state-store.js';
import { DefaultOutputSanitizer } from '../../src/core/output-sanitizer.js';
import { performChapterWriteBounded } from '../../src/generators/text/chapter-write-with-revise.js';
import { performChapterRewriteBounded } from '../../src/generators/text/chapter-rewrite-with-revise.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { buildLanguageContract, LanguagePolicyError } from '../../src/core/language-policy.js';
import { PROMPT_FORMAT_ERROR_CODES } from '../../src/core/prompt-language.js';
import { runRevise } from '../../src/generators/text/steps/revise.js';
import { runRewrite } from '../../src/generators/text/steps/rewrite.js';
import { REVISE_PATCH_SYSTEM, REVISE_SYSTEM } from '../../src/generators/text/prompts/revise.js';
import { REWRITE_SYSTEM } from '../../src/generators/text/prompts/rewrite.js';

const registry = createGenreProfileRegistry();
const HANGUL = /[가-힣]/;
const MODEL = { provider: 'openai', modelId: 'gpt-4o' };

function capturingProvider(text) {
    const body = text ?? '수정된 본문\n\n⟦vle:cast-manifest {"cast":[]}⟧';
    const requests = [];
    return {
        requests,
        providers: {
            async complete(req) {
                requests.push(req);
                return { text: body, model: req.model };
            },
        },
    };
}
function partsOf(req) {
    return {
        system: req.messages.find((m) => m.role === 'system').content,
        user: req.messages.find((m) => m.role === 'user').content,
        step: req.step,
    };
}
function foundation() {
    return {
        workId: 'work-rr',
        genre: 'action',
        worldFacts: [{ id: 'wf1', statement: 'WORLDFACT_TOKEN 검은 탑은 무너지지 않는다.' }],
        characters: [
            {
                id: 'c1',
                canonicalName: '이서준',
                aliases: [],
                registeredAtChapter: 1,
                intrinsic: { gender: 'male', ageBand: '20대초반', role: '주인공', coreAppearance: [] },
                mutable: { status: 'alive', knownFacts: [] },
                relationships: [],
            },
        ],
        intrinsicChanges: [],
        genreProfile: registry.get('action'),
    };
}
const ADDRESS_VIOLATION = {
    severity: 'hard',
    code: 'ADDRESS_TERM_MISMATCH',
    message: '호칭이 AddressMap 과 다르다.',
    characterId: 'c1',
};
function lengthViolation(extra = {}) {
    return {
        severity: 'hard',
        code: 'QUALITY_GATE_LENGTH',
        message: '본문이 짧다.',
        ...extra,
    };
}

const PATCH_RESPONSE = '{"replacements":[{"paragraph":1,"text":"고친 문단"}],"insertions":[]}';
/**
 * 비ko 작품은 생성 시점에 언어가 정해진 작품이다 — 저장된 Foundation 메타데이터가
 * 언어의 원천이므로(작품 언어 불변) 요청 언어를 Foundation 에도 둔다. 메타데이터
 * 없는 기존 작품에 다른 언어를 요구하는 경우는 전용 테스트가 다룬다.
 */
function foundationFor(extra) {
    if (extra.foundation)
        return extra.foundation;
    const workLanguage = extra.workContract?.language ?? extra.promptLanguage?.language ?? extra.language ?? null;
    return workLanguage === null ? foundation() : { ...foundation(), language: workLanguage };
}
async function captureRevise(extra = {}) {
    // patchMode 는 응답이 JSON 패치여야 하므로 모드에 맞는 응답을 돌려준다.
    const { providers, requests } = capturingProvider(extra.patchMode === true ? PATCH_RESPONSE : undefined);
    await runRevise({
        prose: 'PROSE_TOKEN 첫 문단이다.\n\n두 번째 문단이다.',
        violations: [ADDRESS_VIOLATION],
        foundation: foundationFor(extra),
        chapterNumber: 7,
        providers,
        model: MODEL,
        ...extra,
    });
    return partsOf(requests[0]);
}
async function captureRewrite(extra = {}) {
    const { providers, requests } = capturingProvider('다시 쓴 본문\n\n⟦vle:cast-manifest {"cast":[]}⟧');
    await runRewrite({
        previousProse: 'PREVIOUS_TOKEN 원본 본문이다.',
        intentSummary: 'INTENT_TOKEN 갈등을 강화하라',
        prevState: { ...emptyStoryState('work-rr'), chapterNumber: 6 },
        chapterNumber: 7,
        foundation: foundationFor(extra),
        providers,
        model: MODEL,
        ...extra,
    });
    return partsOf(requests[0]);
}

describe('revise — 계열', () => {
    it('구형 호출은 기존 한국어 교정 프롬프트 그대로다', async () => {
        const { system, user, step } = await captureRevise();
        expect(system).toBe(REVISE_SYSTEM);
        expect(step).toBe('revise');
        expect(user).toContain('## 회차 번호');
        expect(user).toContain('## 언어\nko');
        expect(user).toContain('## 위반 사항 (이것과 관련된 장면만 수정)');
        expect(user).toContain('## 원본 본문');
    });
    it('patchMode 구형 호출도 기존 한국어 국소 교정 프롬프트 그대로다', async () => {
        const { system, user } = await captureRevise({ patchMode: true });
        expect(system).toBe(REVISE_PATCH_SYSTEM);
        expect(user).toContain('## 번호가 붙은 원문 문단');
        expect(user).toContain('## 수정 한도');
    });
    it('비ko 는 영어 교정 지시 + 검증된 목표 언어 지시문이다', async () => {
        const { system, user } = await captureRevise({ language: 'ja' });
        expect(HANGUL.test(system)).toBe(false);
        expect(system).toContain('You are a copy-editor for serial fiction written in the target work language.');
        expect(system).toContain('Target work language (BCP 47): ja.');
        // 위반 코드·sentinel 은 기계 계약이라 두 계열에서 동일하다.
        expect(system).toContain('QUALITY_GATE_LENGTH');
        expect(system).toContain('⟦vle:cast-manifest');
        expect(user).toContain('## Target work language (BCP 47)\nja');
        expect(user).toContain('## Violations (repair only the scenes these point at)');
        // 작품 데이터(한국어 고유명·본문)는 원문 그대로 실린다.
        expect(user).toContain('이서준');
        expect(user).toContain('PROSE_TOKEN');
        // 이 단계의 분량 기준은 위반이 지시한 수정 목표다 — 회차 목표는 싣지 않는다.
        expect(`${system}\n${user}`).not.toContain('Chapter length target');
    });
    it('비ko patchMode 도 영어 계열이며 JSON 키는 그대로다', async () => {
        const { system, user } = await captureRevise({ language: 'fr', patchMode: true });
        expect(HANGUL.test(system)).toBe(false);
        expect(system).toContain('Produce only a JSON patch applied to the numbered source paragraphs.');
        expect(user).toContain('"replacements"');
        expect(user).toContain('"afterParagraph"');
        expect(user).toContain('## Numbered source paragraphs');
    });
    it('대사·문단 모드는 계열이 아니라 포맷 정책이 정한다', async () => {
        const koStrict = await captureRevise();
        expect(koStrict.system).toContain('서로 다른 문단과 독립 대사 앞뒤에는 빈 줄을 둔다.');
        const koRelaxed = await captureRevise({ language: 'ko', dialogueBreakMode: 'relaxed' });
        expect(koRelaxed.system).toContain('대사는 서술 문단 안에 놓을 수 있지만 긴 서술 뒤에 파묻지 않는다.');
        // 비ko 기본은 natural — 목표 언어 산문 관습을 따른다(한국어식 고립 강제 금지).
        const nonKo = await captureRevise({ language: 'de' });
        expect(nonKo.system).toContain('Place dialogue and paragraphs by the prose conventions of the target language');
        const pinnedStrict = await captureRevise({ language: 'de', dialogueBreakMode: 'strict' });
        expect(pinnedStrict.system).toContain('Give each line of dialogue its own paragraph');
        // 계약에 고정된 모드와 어긋난 인자는 조용히 덮지 않고 거부한다.
        const contract = buildLanguageContract({ language: 'de' });
        const pinned = {
            ...contract,
            formatPolicy: { ...contract.formatPolicy, dialogueBreakMode: 'natural' },
        };
        await expect(captureRevise({ workContract: pinned, dialogueBreakMode: 'strict' }))
            .rejects.toThrow(LanguagePolicyError);
    });
    it('구형 코드 단위 분량 계측은 legacyCodeUnits 계약에서만 인정한다', async () => {
        const ko = await captureRevise({
            violations: [lengthViolation({ actualChars: 2100, minChars: 2550, recommendedChars: 3000 })],
        });
        expect(ko.user).toContain('## 분량 수정 계약');
        expect(ko.user).toContain('현재 본문: 2100자');
        expect(ko.user).toContain('통과 하한: 2550자');
        expect(ko.user).toContain('이번 수정 목표: 3000자 이상');
        // graphemes/words 계약에서 "자" 로 잰 수치를 목표 단위인 척 싣지 않는다.
        await expect(captureRevise({
            language: 'ja',
            violations: [lengthViolation({ actualChars: 2100, minChars: 2550, recommendedChars: 3000 })],
        })).rejects.toThrow(LanguagePolicyError);
        await expect(captureRevise({
            language: 'en',
            length: { unit: 'words', target: 900 },
            violations: [lengthViolation({ recommendedChars: 3000 })],
        })).rejects.toThrow(LanguagePolicyError);
    });
    it('계약 단위로 계측된 분량은 그 단위로 말한다', async () => {
        const contract = buildLanguageContract({ language: 'en', length: { unit: 'words', target: 900 } });
        const { user } = await captureRevise({
            workContract: contract,
            violations: [lengthViolation({
                lengthMeasurement: { unit: 'words', actual: 700, min: 765, recommended: 900 },
            })],
        });
        expect(user).toContain('## Length repair contract');
        expect(user).toContain('Current prose: 700 words');
        expect(user).toContain('Passing floor: 765 words');
        expect(user).toContain('Repair target: at least 900 words');
        expect(user).not.toContain('자');
    });
    it('계측 단위가 계약과 다르면 거부한다', async () => {
        const contract = buildLanguageContract({ language: 'en', length: { unit: 'words', target: 900 } });
        await expect(captureRevise({
            workContract: contract,
            violations: [lengthViolation({ lengthMeasurement: { unit: 'graphemes', actual: 4000 } })],
        })).rejects.toThrow(LanguagePolicyError);
    });
    it('계약과 어긋난 명시 언어·분량은 거부한다', async () => {
        const contract = buildLanguageContract({ language: 'ja' });
        await expect(captureRevise({ workContract: contract, language: 'ko' })).rejects.toThrow(LanguagePolicyError);
        await expect(captureRevise({ workContract: contract, length: { unit: 'graphemes', target: 1234 } }))
            .rejects.toThrow(LanguagePolicyError);
    });
});

describe('rewrite — 계열', () => {
    it('구형 호출은 기존 한국어 다시쓰기 프롬프트 그대로다', async () => {
        const { system, user, step } = await captureRewrite();
        expect(system).toBe(REWRITE_SYSTEM);
        expect(step).toBe('rewrite');
        expect(user).toContain('## 회차 번호');
        expect(user).toContain('## 언어\nko');
        expect(user).toContain('## 작가 다시쓰기 지시 (intent)');
        expect(user).toContain('INTENT_TOKEN 갈등을 강화하라');
    });
    it('비ko 는 영어 집필 지시 계열이며 한국어 system 에 한 줄 얹는 형태가 아니다', async () => {
        const { system, user } = await captureRewrite({ language: 'es' });
        expect(HANGUL.test(system)).toBe(false);
        expect(system).toContain('Rewrite an existing chapter according to the author\'s rewrite intent.');
        expect(system).toContain('Target work language (BCP 47): es.');
        expect(system).toContain('⟦vle:cast-manifest');
        expect(user).toContain('## Target work language (BCP 47)\nes');
        expect(user).toContain('## Author rewrite intent');
        // 작가 지시와 원본 본문은 작품 데이터라 번역하지 않고 그대로 싣는다.
        expect(user).toContain('INTENT_TOKEN 갈등을 강화하라');
        expect(user).toContain('PREVIOUS_TOKEN 원본 본문이다.');
        // 분량은 원본 대비 ±20% 라 회차 분량 목표 줄을 싣지 않는다.
        expect(system).not.toContain('Chapter length target');
        expect(system).toContain('Keep the length close to the original (within ±20%).');
    });
    it('대사 모드는 포맷 정책을 따르고 ko strict 는 규칙을 추가하지 않는다', async () => {
        const ko = await captureRewrite({ language: 'ko' });
        expect(ko.system).toContain('작품 언어(BCP 47): ko.');
        // ko + strict 는 구형 프롬프트에 없던 줄을 새로 넣지 않는다.
        expect(ko.system).not.toContain('9)');
        const koNatural = await captureRewrite({ language: 'ko', dialogueBreakMode: 'natural' });
        expect(koNatural.system).toContain('9) 대사와 문단의 배치는 목표 독자의 산문 관습에 맞춘다.');
        const nonKo = await captureRewrite({ language: 'pt' });
        expect(nonKo.system).toContain('9) Follow the dialogue and paragraph conventions of the target language');
    });
    it('계약과 어긋난 명시 언어는 거부한다', async () => {
        const contract = buildLanguageContract({ language: 'ja' });
        await expect(captureRewrite({ workContract: contract, language: 'en' })).rejects.toThrow(LanguagePolicyError);
    });
});

describe('revise / rewrite — 저장된 Foundation 언어 메타데이터 상속', () => {
    it('단독 호출도 Foundation 에 저장된 언어로 라우팅한다', async () => {
        const contract = buildLanguageContract({ language: 'ja', length: { unit: 'graphemes', target: 2600 } });
        const stored = { ...foundation(), language: 'ja', workContract: contract, length: contract.length };
        const revise = await captureRevise({ foundation: stored });
        expect(revise.system).toContain('Target work language (BCP 47): ja.');
        expect(HANGUL.test(revise.system)).toBe(false);
        const rewrite = await captureRewrite({ foundation: stored });
        expect(rewrite.system).toContain('Target work language (BCP 47): ja.');
    });
    it('저장값과 어긋난 호출 인자는 거부한다', async () => {
        const stored = { ...foundation(), language: 'ja' };
        await expect(captureRevise({ foundation: stored, language: 'en' })).rejects.toThrow(LanguagePolicyError);
        await expect(captureRewrite({ foundation: stored, language: 'en' })).rejects.toThrow(LanguagePolicyError);
        // 파이프라인이 이미 해석한 컨텍스트와도 대조한다.
        await expect(captureRevise({ foundation: stored, promptLanguage: { language: 'es' } }))
            .rejects.toThrow(LanguagePolicyError);
    });
    it('언어 메타데이터가 없는 구형 작품은 기존 한국어 프롬프트 그대로다', async () => {
        const revise = await captureRevise({ foundation: foundation() });
        expect(revise.system).toBe(REVISE_SYSTEM);
    });
});

// ─── bounded loop 배선 ──────────────────────────────────────────────────────
/**
 * `ctx.workContract` 가 draft → revise → rewrite 까지 이어지는지 실제 요청으로
 * 확인한다. extractDelta / continuityCheck 프롬프트는 이번 범위(2A) 밖이라 한국어
 * 그대로이며, 여기서는 **수정 단계가 작품 계약을 본다**는 것만 본다.
 */
function boundedStubRegistry(continuitySequence) {
    const calls = [];
    let continuityIdx = 0;
    const prose = 'Seojun let out a slow breath. Something familiar leaked from beyond the gate.';
    const raw = `${prose}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧`;
    return {
        calls,
        providers: {
            register: () => undefined,
            has: () => true,
            async complete(req) {
                const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
                let kind = 'unknown';
                let text = '{}';
                if (sys.includes('serial-fiction chapter planner')) {
                    kind = 'plan';
                    text = '{"plan":"An ordinary chapter."}';
                }
                else if (sys.includes('serial-fiction novelist') && sys.includes('Rewrite an existing chapter')) {
                    kind = 'rewrite';
                    text = raw;
                }
                else if (sys.includes('serial-fiction novelist')) {
                    kind = 'draft';
                    text = raw;
                }
                else if (sys.includes('연속성 분석기') || sys.includes('continuity analyser')) {
                    kind = 'extractDelta';
                }
                else if (sys.includes('연속성 검수기') || sys.includes('continuity reviewer')) {
                    kind = 'continuityCheck';
                    const i = Math.min(continuityIdx, continuitySequence.length - 1);
                    continuityIdx += 1;
                    text = JSON.stringify(continuitySequence[i]);
                }
                else if (sys.includes('copy-editor for serial fiction')) {
                    kind = 'revise';
                    text = raw;
                }
                calls.push({ kind, request: req });
                return { text: validationFixtureResponse(req, text), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
            },
        },
    };
}
describe('bounded loop — 작품 계약 배선', () => {
    let rootDir;
    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'vle-revise-lang-'));
    });
    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true });
    });
    const WORK_CONTRACT = buildLanguageContract({ language: 'ja', length: { unit: 'graphemes', target: 2600 } });
    async function ctxFor(providers) {
        const state = new FileStateStore(rootDir);
        // ja 로 생성된 작품 — 저장된 Foundation 메타데이터가 언어의 원천이다.
        await state.saveFoundation({
            ...foundation(),
            workId: 'work-rr',
            language: 'ja',
            workContract: WORK_CONTRACT,
            length: WORK_CONTRACT.length,
        });
        return {
            jobId: 'job-rr',
            workflowId: 'wf-rr',
            validationEpoch: 1,
            workId: 'work-rr',
            kind: 'chapter-write',
            model: MODEL,
            state,
            providers,
            sanitizer: new DefaultOutputSanitizer(),
            log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
            workContract: WORK_CONTRACT,
        };
    }
    it('draft 와 revise 가 같은 계약을 본다', async () => {
        const { providers, calls } = boundedStubRegistry([
            { intrinsicViolations: [{ characterId: 'c1', message: '성별 충돌' }] },
            {},
        ]);
        const ctx = await ctxFor(providers);
        await performChapterWriteBounded(ctx, { chapterNumber: 1 });
        const revise = calls.filter((c) => c.kind === 'revise');
        expect(revise).toHaveLength(1);
        const system = revise[0].request.messages.find((m) => m.role === 'system').content;
        expect(system).toContain('Target work language (BCP 47): ja.');
        expect(HANGUL.test(system)).toBe(false);
        const draft = calls.find((c) => c.kind === 'draft').request.messages.find((m) => m.role === 'system').content;
        expect(draft).toContain('Target work language (BCP 47): ja.');
        expect(draft).toContain('2600 graphemes');
    });
    it('rewrite 경로도 같은 계약을 이어 넘긴다', async () => {
        const { providers, calls } = boundedStubRegistry([{}]);
        const ctx = await ctxFor(providers);
        await performChapterRewriteBounded(ctx, {
            chapterNumber: 1,
            previousProse: 'The original chapter.',
            intentSummary: 'Sharpen the conflict.',
        });
        const rewrite = calls.find((c) => c.kind === 'rewrite').request.messages.find((m) => m.role === 'system').content;
        expect(rewrite).toContain('Target work language (BCP 47): ja.');
        expect(HANGUL.test(rewrite)).toBe(false);
        // 다시쓰기는 원본 대비 ±20% 라 회차 분량 목표 줄을 싣지 않는다.
        expect(rewrite).not.toContain('2600 graphemes');
    });
});
