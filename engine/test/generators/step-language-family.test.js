/**
 * chapter-plan / chapter-summary / coherence-judge / entity-seed /
 * next-arc-proposal — 다국어 Phase 2A 계열 (최종 provider messages 기준).
 *
 * 상수가 아니라 각 `run*` 이 provider 로 **실제로 보낸 요청**을 캡처해 검증한다.
 * 확인하는 계약:
 *   1. 계약 없는 구형 호출은 기존 한국어 프롬프트 그대로다.
 *   2. 비ko 는 영어 정적 지시 + 검증된 목표 locale 지시문이며 system 에 한글
 *      집필 지시가 남지 않는다. 계열은 정확히 둘이다.
 *   3. JSON 키·enum·ID·catalog id 는 두 계열에서 동일하다.
 *   4. 회차 분량 목표는 요약/기획/평가 프롬프트에 섞이지 않는다.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { buildLanguageContract, LanguagePolicyError, resolveMeasurementPolicy } from '../../src/core/language-policy.js';
import { countLength } from '../../src/core/length-measure.js';
import { runChapterPlan, CHAPTER_PLAN_STATIC, CHAPTER_PLAN_STATIC_MULTILINGUAL, } from '../../src/generators/text/steps/chapter-plan.js';
import { runChapterSummary } from '../../src/generators/text/steps/chapter-summary.js';
import { runCoherenceJudge } from '../../src/generators/text/steps/coherence-judge.js';
import { runEntitySeed } from '../../src/generators/text/steps/entity-seed.js';
import { runNextArcProposal } from '../../src/generators/text/steps/next-arc-proposal.js';
import { captureStaticPromptManifest, captureStaticPromptFamily, STATIC_PROMPT_STEPS, } from '../../src/generators/text/steps/static-prompt-manifest.js';

const registry = createGenreProfileRegistry();
const HANGUL = /[가-힣]/;
const MODEL = { provider: 'openai', modelId: 'gpt-4o-mini' };

function capturingProvider(text = '{}') {
    const requests = [];
    return {
        requests,
        providers: {
            async complete(req) {
                requests.push(req);
                return { text, model: req.model };
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
        workId: 'work-step',
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

async function capturePlan(extra = {}) {
    const { providers, requests } = capturingProvider('{"plan":"p"}');
    await runChapterPlan({
        foundation: foundation(),
        prevState: { ...emptyStoryState('work-step'), chapterNumber: 1 },
        chapterNumber: 2,
        providers,
        model: MODEL,
        ...extra,
    });
    return partsOf(requests[0]);
}
async function captureSummary(extra = {}) {
    const { providers, requests } = capturingProvider('{"summary":"s"}');
    const result = await runChapterSummary({
        prose: 'PROSE_TOKEN 본문이다.',
        chapterNumber: 3,
        writerModel: MODEL,
        providers,
        ...extra,
    });
    return { ...partsOf(requests[0]), result };
}
async function captureJudge(extra = {}) {
    const { providers, requests } = capturingProvider('{"score":80,"reason":"r"}');
    await runCoherenceJudge({
        prose: 'PROSE_TOKEN',
        chapterNumber: 4,
        plan: 'PLAN_TOKEN',
        prevSummary: 'PREV_TOKEN',
        writerModel: MODEL,
        providers,
        ...extra,
    });
    return partsOf(requests[0]);
}
async function captureSeed(extra = {}) {
    const { providers, requests } = capturingProvider('{"entities":[]}');
    await runEntitySeed({
        title: 'TITLE_TOKEN',
        genre: 'action',
        language: 'ko',
        brief: 'BRIEF_TOKEN',
        writerModel: MODEL,
        providers,
        ...extra,
    });
    return partsOf(requests[0]);
}
async function captureProposal(extra = {}) {
    const { providers, requests } = capturingProvider('{"title":"t","promise":"p"}');
    await runNextArcProposal({
        currentArc: {
            arcNumber: 2,
            promise: '',
            type: 'standard',
            currentChapterInArc: 9,
            estimatedEpisodes: 10,
        },
        workMeta: { genre: 'action', totalChaptersSoFar: 19 },
        characters: [{ id: 'c1', canonicalName: '이서준', role: '주인공' }],
        entities: [{ kind: 'location', canonicalName: '검은 탑' }],
        workSummary: 'SUMMARY_TOKEN',
        writerModel: MODEL,
        providers,
        ...extra,
    });
    return partsOf(requests[0]);
}

describe('chapter-plan — 계열', () => {
    it('구형 호출은 기존 한국어 기획 프롬프트 그대로다', async () => {
        const { system, user } = await capturePlan();
        expect(system).toBe(CHAPTER_PLAN_STATIC);
        expect(user).toContain('## 회차 번호');
        expect(user).toContain('## 출력 스키마 (이 JSON 한 개만 출력)');
        expect(user).toContain('"plan": "이번 회차 전개 한 문단 한국어 요약"');
    });
    it('비ko 는 영어 지시 + 목표 언어 산문 요구이며 스키마 키는 그대로다', async () => {
        const { system, user } = await capturePlan({ language: 'ja' });
        expect(HANGUL.test(system)).toBe(false);
        expect(system).toContain('You are a serial-fiction chapter planner.');
        expect(system).toContain('Target work language (BCP 47): ja.');
        expect(system).toContain('one paragraph (3-5 sentences) written in the target work language');
        expect(system).toContain('Do not translate JSON keys, enum values or entity ids.');
        // 스키마 설명은 영어 지시, 값은 목표 언어로 요구한다.
        expect(user).toContain('## Output schema (emit this one JSON object only)');
        expect(user).toContain('"plan": "<one paragraph in the target work language');
        expect(user).toContain('"tension": { "ticking": "", "stake": "", "escalation": "" }');
        expect(user).not.toContain('한국어 요약');
        // 작품 데이터는 원문 그대로 실린다.
        expect(user).toContain('WORLDFACT_TOKEN 검은 탑은 무너지지 않는다.');
        expect(user).toContain('이서준');
    });
    it('기획 프롬프트에 회차 분량 목표를 싣지 않는다', async () => {
        const { system } = await capturePlan({ language: 'ja' });
        expect(system).not.toContain('3000 graphemes');
        expect(system).not.toContain('Chapter length target');
    });
    it('arc 박자와 1화 cold-open 지시도 계열을 따른다', async () => {
        const arc = { currentPosition: 'closing' };
        const ko = await capturePlan({ chapterNumber: 1, arc });
        const en = await capturePlan({ chapterNumber: 1, arc, language: 'en' });
        expect(ko.system).toContain('이번 화는 Arc 종결 박자.');
        expect(ko.system).toContain('## 1화 독자 계약');
        expect(ko.system).toContain('- 사망: 가족·동료·라이벌 중 1인의 사망');
        expect(en.system).toContain('This chapter is the arc\'s closing beat.');
        expect(en.system).toContain('## Reader contract for chapter 1');
        expect(en.system).toContain('- Death: The death of a family member');
        expect(HANGUL.test(en.system)).toBe(false);
        // openingContract 키는 두 계열에서 동일한 기계 계약이다.
        for (const s of [ko.system, en.system]) {
            expect(s).toContain('firstIrreversibleChoice');
            expect(s).toContain('withheldContext');
        }
    });
    it('rising 박자의 tension 강조도 계열을 따른다', async () => {
        const { system } = await capturePlan({ arc: { currentPosition: 'rising' }, language: 'fr' });
        expect(system).toContain('tension.escalation must be filled on this beat');
    });
});

describe('chapter-summary — 요약 분량은 회차 분량이 아니다', () => {
    it('구형 호출은 기존 한국어 프롬프트와 400자 요청 그대로다', async () => {
        const { system, user } = await captureSummary();
        expect(system).toContain('당신은 한국어 웹소설 회차 요약 작가다.');
        expect(user).toContain('## 회차 3 본문');
        expect(user).toContain('위 본문을 400자 내외로 요약하고');
    });
    it('비ko 는 영어 지시 + 계약 단위의 요약 목표를 쓰고 회차 목표는 싣지 않는다', async () => {
        const { system, user } = await captureSummary({ language: 'ja' });
        expect(HANGUL.test(system)).toBe(false);
        expect(system).toContain('Target work language (BCP 47): ja.');
        expect(user).toContain('Summarise the chapter above in about 400 graphemes');
        // 회차 3000 과 요약 400 을 같은 프롬프트에 나란히 두지 않는다.
        expect(system).not.toContain('3000 graphemes');
        expect(`${system}\n${user}`).not.toContain('Chapter length target');
        // plotBeat enum 은 기계 값이라 그대로다.
        expect(system).toContain('["inciting", "rising", "climax", "falling", "denouement"]');
    });
    it('words 계약은 요약도 단어로 말한다', async () => {
        const contract = buildLanguageContract({ language: 'en', length: { unit: 'words', target: 900 } });
        const { user } = await captureSummary({ workContract: contract, summaryLength: { unit: 'words', target: 120 } });
        expect(user).toContain('about 120 words');
        expect(user).not.toContain('900');
    });
    it('구형 targetChars 는 코드 단위 계약에서만 인정한다', async () => {
        const { user } = await captureSummary({ targetChars: 250 });
        expect(user).toContain('위 본문을 250자 내외로 요약하고');
        // graphemes 계약에 "자" 목표를 몰래 재해석하지 않는다.
        await expect(captureSummary({ language: 'ja', targetChars: 250 })).rejects.toThrow(LanguagePolicyError);
    });
    it('요약 목표를 중복 지정하면 provider 호출 전에 거부한다', async () => {
        const calls = [];
        const providers = {
            async complete(req) {
                calls.push(req);
                return { text: '{"summary":"s"}' };
            },
        };
        const args = { prose: 'PROSE_TOKEN', chapterNumber: 3, writerModel: MODEL, providers };
        // words 요약 목표 + 코드 단위 targetChars — 단위가 다른 중복이다.
        await expect(runChapterSummary({
            ...args,
            workContract: buildLanguageContract({ language: 'en', length: { unit: 'words', target: 900 } }),
            summaryLength: { unit: 'words', target: 10 },
            targetChars: 10,
        })).rejects.toThrow(LanguagePolicyError);
        // 같은 코드 단위 계약에서 값이 다른 중복도 거부한다.
        await expect(runChapterSummary({
            ...args,
            summaryLength: { unit: 'legacyCodeUnits', target: 10 },
            targetChars: 20,
        })).rejects.toThrow(LanguagePolicyError);
        expect(calls).toHaveLength(0);
        // 정확히 같은 코드 단위 중복은 허용한다.
        const ok = await runChapterSummary({
            ...args,
            summaryLength: { unit: 'legacyCodeUnits', target: 10 },
            targetChars: 10,
        });
        expect(ok.summary).toBe('s');
        expect(calls).toHaveLength(1);
    });
    it('LLM 실패 시 fallback 은 공유 truncateLength 로 계약 단위에서 자른다', async () => {
        const failing = {
            async complete() {
                throw new Error('provider down');
            },
        };
        const long = '가'.repeat(50);
        const ko = await runChapterSummary({
            prose: long, chapterNumber: 1, writerModel: MODEL, providers: failing, targetChars: 10,
        });
        expect(ko.summary).toBe('가'.repeat(9) + '…');
        // graphemes 계약은 문자군 단위로 자른다 — surrogate pair 를 쪼개지 않는다.
        const emoji = '🙂'.repeat(50);
        const ja = await runChapterSummary({
            prose: emoji,
            chapterNumber: 1,
            writerModel: MODEL,
            providers: failing,
            language: 'ja',
            summaryLength: { unit: 'graphemes', target: 10 },
        });
        expect(ja.summary).toBe('🙂'.repeat(9) + '…');
        expect(ja.summary).not.toContain('�');
        // words 계약은 단어 경계에서 자른다 — 코드 단위 절단으로 대체하지 않는다.
        const en = await runChapterSummary({
            prose: 'alpha beta gamma delta epsilon zeta eta theta',
            chapterNumber: 1,
            writerModel: MODEL,
            providers: failing,
            workContract: buildLanguageContract({ language: 'en', length: { unit: 'words', target: 900 } }),
            summaryLength: { unit: 'words', target: 4 },
        });
        // 말줄임표는 단어로 세지 않으므로 목표 4단어가 그대로 남는다.
        expect(en.summary).toBe('alpha beta gamma delta …');
        expect(countLength(en.summary, resolveMeasurementPolicy({ language: 'en', unit: 'words' })).count)
            .toBeLessThanOrEqual(4);
    });
    it('계약이 명시된 fallback 은 출처를 밝히고 구형 shape 은 그대로다', async () => {
        const failing = {
            async complete() {
                throw new Error('provider down');
            },
        };
        const malformed = {
            async complete() {
                return { text: 'not json at all' };
            },
        };
        const contract = buildLanguageContract({ language: 'ja' });
        const args = { prose: '본문이다.', chapterNumber: 2, writerModel: MODEL };
        const providerFailure = await runChapterSummary({ ...args, providers: failing, workContract: contract });
        expect(providerFailure.summaryStatus).toBe('fallback');
        expect(providerFailure.fallbackReason).toBe('provider_failure');
        const malformedResult = await runChapterSummary({ ...args, providers: malformed, workContract: contract });
        expect(malformedResult.summaryStatus).toBe('fallback');
        expect(malformedResult.fallbackReason).toBe('malformed_result');
        // 단위·언어 검증을 통과했다는 주장은 하지 않는다(검증은 phase 3 게이트 소유).
        for (const result of [providerFailure, malformedResult]) {
            expect(result.summary).toBe('본문이다.');
            expect('validated' in result).toBe(false);
            expect('measurementPolicyHash' in result).toBe(false);
            expect('language' in result).toBe(false);
        }
        // 구형(암묵적 ko) 호출은 새 키를 얻지 않는다.
        const legacy = await runChapterSummary({ ...args, providers: failing });
        expect(legacy).toEqual({ summary: '본문이다.', plotBeat: null, sceneTags: [], povCharacter: null });
        expect('summaryStatus' in legacy).toBe(false);
        expect('fallbackReason' in legacy).toBe(false);
        // 모델이 요약을 준 정상 경로에는 fallback 표시가 붙지 않는다.
        const ok = await captureSummary({ workContract: contract });
        expect(ok.result.summary).toBe('s');
        expect('summaryStatus' in ok.result).toBe(false);
    });
});

describe('coherence-judge / entity-seed / next-arc-proposal — 계열', () => {
    it('평가자 구형 호출은 기존 한국어, 비ko 는 영어 지시 + 목표 언어 reason', async () => {
        const ko = await captureJudge();
        expect(ko.system).toContain('당신은 한국어 웹소설 회차 logical-coherence 평가자다.');
        expect(ko.user).toContain('## 이번 화 plan');
        const en = await captureJudge({ language: 'es' });
        expect(HANGUL.test(en.system)).toBe(false);
        expect(en.system).toContain('"reason": "one line in the target work language"');
        expect(en.user).toContain('## Plan for this chapter');
        expect(en.user).toContain('## Previous chapter summary');
        expect(en.system).not.toContain('Chapter length target');
    });
    it('entity-seed 의 language 는 표시값이 아니라 목표 언어 선택이다', async () => {
        const ko = await captureSeed();
        expect(ko.system).toContain('당신은 한국어 웹소설 발의 단계의 entity 디자이너이다.');
        // 계약 태그를 그대로 적는다 — 프롬프트가 지시문과 다른 언어를 말하지 않는다.
        expect(ko.user).toContain('언어: ko');
        expect(ko.user).toContain('- location: 3개');
        const en = await captureSeed({ language: 'de' });
        expect(HANGUL.test(en.system)).toBe(false);
        expect(en.system).toContain('location|monster|item|skill|faction|lore|organization|event|concept');
        expect(en.system).toContain('Target work language (BCP 47): de.');
        expect(en.user).toContain('## Work information');
        expect(en.user).toContain('Language: de');
        expect(en.user).toContain('- location: 3');
        // 작품 데이터는 계열과 무관하게 원문 그대로 실린다.
        expect(en.user).toContain('BRIEF_TOKEN');
    });
    it('entity-seed 의 language 는 검증되며 계약과 어긋나면 거부한다', async () => {
        // 허용 목록이 아니라 태그 식별 가능성으로 판정한다. 표시 문자열은 조용히
        // 표시값으로 강등되지 않는다.
        await expect(captureSeed({ language: '한국어' })).rejects.toThrow(LanguagePolicyError);
        await expect(captureSeed({
            language: 'de',
            workContract: buildLanguageContract({ language: 'ja' }),
        })).rejects.toThrow(LanguagePolicyError);
        // 계약만 오면 계약이 목표를 정한다.
        const ja = await captureSeed({ language: null, workContract: buildLanguageContract({ language: 'ja' }) });
        expect(ja.user).toContain('Language: ja');
    });
    it('next-arc-proposal 은 type enum 과 characterId 를 유지한다', async () => {
        const ko = await captureProposal();
        expect(ko.user).toContain('## 현재 Arc 2');
        expect(ko.user).toContain('promise: (미설정)');
        expect(ko.user).toContain('목표 화수: 미설정');
        const en = await captureProposal({ language: 'pt' });
        expect(HANGUL.test(en.system)).toBe(false);
        expect(en.system).toContain('"type": "small|standard|volume"');
        expect(en.user).toContain('## Current arc 2');
        expect(en.user).toContain('promise: (not set)');
        expect(en.user).toContain('Target chapter count: (not set)');
        // 작품 데이터(한국어 고유명)는 그대로 실린다.
        expect(en.user).toContain('- c1 / 이서준 / 주인공');
        expect(en.user).toContain('- location / 검은 탑');
    });
});

describe('static prompt manifest — 계열별 정적 표면', () => {
    it('두 계열 모두 수집되고 ko 값은 기존 hash 입력과 같다', () => {
        const manifest = captureStaticPromptManifest();
        expect(STATIC_PROMPT_STEPS).toEqual([
            'cast-design', 'chapter-plan', 'chapter-summary', 'coherence-judge', 'draft', 'entity-seed',
            'next-arc-proposal', 'revise', 'revise-foundation', 'revise-patch', 'rewrite', 'worldbuild',
        ]);
        expect(manifest['chapter-plan'].ko).toBe(CHAPTER_PLAN_STATIC);
        expect(manifest['chapter-plan'].multilingual).toBe(CHAPTER_PLAN_STATIC_MULTILINGUAL);
        for (const step of STATIC_PROMPT_STEPS) {
            expect(typeof manifest[step].ko).toBe('string');
            expect(typeof manifest[step].multilingual).toBe('string');
            expect(manifest[step].ko).not.toBe(manifest[step].multilingual);
        }
    });
    it('캡처에는 작품 데이터도 목표 언어 태그도 분량 수치도 들어가지 않는다', () => {
        const ml = captureStaticPromptFamily('multilingual');
        for (const step of STATIC_PROMPT_STEPS) {
            expect(HANGUL.test(ml[step])).toBe(false);
            expect(ml[step]).not.toContain('Target work language (BCP 47)');
            expect(ml[step]).not.toContain('3000');
        }
        // draft 만 회차 분량 단위를 규칙으로 말한다(수치 없이 단위만).
        expect(ml.draft).toContain('measured in graphemes');
        expect(() => captureStaticPromptFamily('en')).toThrow(TypeError);
    });
});
