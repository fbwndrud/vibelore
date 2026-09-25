/**
 * draft — 다국어 Phase 2A 프롬프트 계열 (최종 provider messages 기준).
 *
 * 검증 대상은 상수가 아니라 `runDraft` 가 실제로 provider 에 보내는 메시지다.
 * 확인하는 계약:
 *   1. ko / ko-KR 는 기존 한국어 작법 규칙·예시를 그대로 유지한다(구형 호출은
 *      byte-identical).
 *   2. 비ko 는 영어 기반 지시 + 검증된 목표 locale 지시문을 쓴다. "한국어 system
 *      에 목표 언어 한 줄" 형태는 허용하지 않는다 — system 에 한글이 남지 않는다.
 *   3. 기계 계약(JSON 키/enum/ID/sentinel)과 작품 데이터(한국어 값 포함)는 두
 *      계열에서 동일하게 보존한다.
 *   4. 분량 지시는 언어 계약의 단위를 그대로 부른다. 구형 인자는 이름과 무관하게
 *      legacyCodeUnits 이며 counter 가 문자를 셀 때 "단어" 라고 말하지 않는다.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { buildLanguageContract, LanguagePolicyError } from '../../src/core/language-policy.js';
import { runDraft, __buildDraftSystemForTest as buildDraftSystem, } from '../../src/generators/text/steps/draft.js';

const registry = createGenreProfileRegistry();
const HANGUL = /[가-힣]/;
const NONKO_LOCALES = ['en', 'en-US', 'ja', 'zh-Hant', 'es', 'ar', 'fr', 'th'];

function makeFoundation() {
    return {
        workId: 'work-lang',
        genre: 'action',
        // 작품 데이터는 한국어로 둔다 — 비ko 메시지 안에서도 그대로 보존돼야 한다.
        worldFacts: [{ id: 'wf1', statement: 'WORLDFACT_TOKEN 검은 탑은 무너지지 않는다.' }],
        characters: [
            {
                id: 'c1',
                canonicalName: '이서준',
                aliases: [],
                registeredAtChapter: 1,
                intrinsic: { gender: 'male', ageBand: '20대초반', role: '주인공', coreAppearance: ['흑발'] },
                mutable: { status: 'alive', knownFacts: [] },
                relationships: [],
            },
        ],
        intrinsicChanges: [],
        genreProfile: registry.get('action'),
    };
}
function prevStateWithKoreanEnum() {
    const state = emptyStoryState('work-lang');
    return {
        ...state,
        chapterNumber: 1,
        // 소스 코드가 비교하는 한국어 값은 기계 계약이다 — 번역 대상이 아니다.
        addressMap: { entries: [{ from: 'c1', to: 'c2', term: '도련님' }] },
    };
}
function capturingProvider() {
    const requests = [];
    return {
        requests,
        provider: {
            async complete(req) {
                requests.push(req);
                return { text: 'prose\n\n⟦vle:cast-manifest {"cast":[]}⟧', model: req.model };
            },
        },
    };
}
/**
 * 비ko 작품은 **생성 시점에 언어가 정해진 작품**이다. 저장된 Foundation 메타데이터가
 * 언어의 원천이므로(작품 언어는 불변) 테스트도 요청 언어를 Foundation 에 함께 둔다.
 * 메타데이터 없는 기존 작품에 다른 언어를 요구하는 경우는 아래 전용 테스트가 다룬다.
 */
function foundationFor(extra) {
    if (extra.foundation)
        return extra.foundation;
    const workLanguage = extra.workContract?.language ?? extra.promptLanguage?.language ?? extra.language ?? null;
    if (workLanguage === null)
        return makeFoundation();
    return { ...makeFoundation(), language: workLanguage };
}
async function capture(extra = {}) {
    const { provider, requests } = capturingProvider();
    await runDraft({
        foundation: foundationFor(extra),
        prevState: prevStateWithKoreanEnum(),
        chapterNumber: 2,
        plan: 'PLAN_TOKEN 주인공이 탑으로 돌아간다.',
        providers: provider,
        model: { provider: 'openai', modelId: 'gpt-4o-mini' },
        ...extra,
    });
    const [req] = requests;
    return {
        system: req.messages.find((m) => m.role === 'system').content,
        user: req.messages.find((m) => m.role === 'user').content,
        request: req,
    };
}
function arc(position = 'rising') {
    return {
        arcId: 'a1',
        arcNumber: 1,
        title: '탑의 약속',
        summary: '',
        promise: 'ARC_PROMISE_TOKEN 서준은 탑을 무너뜨린다',
        type: 'standard',
        estimatedEpisodes: 20,
        currentPosition: position,
        currentChapterInArc: 5,
    };
}

describe('draft — ko 계열 보존', () => {
    it('언어 미지정 구형 호출은 기존 한국어 프롬프트 그대로다', async () => {
        const { system, user } = await capture();
        expect(system).toContain('당신은 한국어 웹소설 작가이다.');
        expect(system).toContain('본문 작성 규칙');
        expect(system).toContain('한 회차에 갈등 1개, 진행 1개, 다음 회차 훅 1개');
        expect(system).toContain('분량은 목표 글자 수 ±15% 내.');
        // ko 예시(fewshot)와 manifest 규칙이 그대로 유지된다.
        expect(system).toContain('[예시 1]');
        expect(system).toContain('회차 종료 시 반드시 다음 sentinel 블록');
        expect(user).toContain('## 목표 글자 수\n3500');
        expect(user).toContain('## 회차 기획');
        // 계약이 없으므로 언어 지시문 줄도 붙지 않는다.
        expect(system).not.toContain('작품 언어(BCP 47)');
        expect(system).not.toContain('Target work language');
    });
    it('언어 미지정 system 은 legacy builder 와 byte-identical 이다', async () => {
        const { system } = await capture();
        expect(system).toBe(buildDraftSystem());
    });
    it('ko-KR 명시 계약도 같은 한국어 작법 규칙을 쓰고 지시문만 더한다', async () => {
        const { system, user } = await capture({ language: 'ko-KR' });
        expect(system).toContain('당신은 한국어 웹소설 작가이다.');
        expect(system).toContain('[예시 1]');
        expect(system).toContain('작품 언어(BCP 47): ko-KR.');
        expect(system).toContain('화당 분량 목표: 3000 legacyCodeUnits');
        // ko 계열에 영어 계열 지시가 섞이지 않는다.
        expect(system).not.toContain('Target work language');
        expect(system).not.toContain('Chapter writing rules:');
        expect(user).toContain('## 목표 글자 수\n3000');
    });
});

describe('draft — 비ko 계열은 영어 기반 지시 + 목표 locale', () => {
    for (const locale of NONKO_LOCALES) {
        it(`${locale}: system 에 한글 집필 지시가 남지 않는다`, async () => {
            const { system } = await capture({ language: locale });
            expect(HANGUL.test(system)).toBe(false);
            expect(system).toContain(`Target work language (BCP 47): ${locale}`);
            expect(system).toContain('Chapter writing rules:');
            expect(system).toContain('Write all prose, titles, summaries');
            // ko 전용 작법 규칙·예시가 흘러들지 않는다.
            expect(system).not.toContain('[예시 1]');
        });
    }
    it('zh-Hant 는 문자 체계 지시를 함께 준다', async () => {
        const { system } = await capture({ language: 'zh-Hant' });
        expect(system).toContain('Use the Hant script consistently.');
    });
    it('사용자 프롬프트 라벨과 fallback 도 영어 계열이다', async () => {
        const { user } = await capture({ language: 'ja', plan: '' });
        expect(user).toContain('## Chapter number');
        expect(user).toContain('## Length target');
        expect(user).toContain('## Foundation summary');
        expect(user).toContain('## Previous state summary (StoryState N-1)');
        expect(user).toContain('(No plan supplied');
        expect(user).toContain('<chapter prose in the target work language>');
        expect(user).not.toContain('## 회차 번호');
        expect(user).not.toContain('<본문 한국어 prose>');
    });
    it('arc 헤더·긴장·오프닝 계약의 동적 라벨도 계열을 따른다', async () => {
        const { user } = await capture({
            language: 'es',
            chapterNumber: 1,
            arc: arc('rising'),
            tension: { ticking: 'TICK_TOKEN', stake: 'STAKE_TOKEN' },
            openingContract: { surfaceEvent: 'SURFACE_TOKEN', viewpointReason: 'POV_TOKEN' },
        });
        expect(user).toContain('## Position in the arc');
        expect(user).toContain('Chapter 5 of 20 in the arc — Rising');
        expect(user).toContain('## Tension design for this chapter');
        expect(user).toContain('Time or external pressure (ticking): TICK_TOKEN');
        expect(user).toContain('## Opening contract for chapter 1');
        expect(user).toContain('Surface event: SURFACE_TOKEN');
        expect(user).not.toContain('## 회차 위치');
        expect(user).not.toContain('## 이번 화 긴장 설계');
    });
    it('알려진 임의 locale 을 allowlist 없이 받고, 식별 불가 태그만 거부한다', async () => {
        // kr 는 Kanuri 다 — 한국어의 오타로 일괄 거부하지 않는다.
        const { system } = await capture({ language: 'kr' });
        expect(system).toContain('Target work language (BCP 47): kr');
        await expect(capture({ language: 'zz' })).rejects.toThrow(LanguagePolicyError);
    });
});

describe('draft — 기계 계약과 작품 데이터 보존', () => {
    it('sentinel·JSON 키·enum 은 두 계열에서 동일하다', async () => {
        const ko = await capture({ arc: arc('closing') });
        const ja = await capture({ language: 'ja', arc: arc('closing') });
        for (const { system, user } of [ko, ja]) {
            expect(system).toContain('⟦vle:cast-manifest');
            expect(system).toContain('characterId');
            expect(system).toContain('addressTermsUsed');
            expect(user).toContain('type=standard');
            expect(user).toContain('"canonicalName"');
            expect(user).toContain('"addressMap"');
        }
        // 구간 라벨만 계열별이고 enum 키는 그대로다.
        expect(ko.user).toContain('종결 (Closing)');
        expect(ja.user).toContain('— Closing');
    });
    it('비ko 메시지 안의 한국어 작품 데이터·기존 한국어 enum 값은 그대로 실린다', async () => {
        const { user } = await capture({ language: 'ar', arc: arc() });
        expect(user).toContain('WORLDFACT_TOKEN 검은 탑은 무너지지 않는다.');
        expect(user).toContain('이서준');
        expect(user).toContain('20대초반');
        expect(user).toContain('도련님');
        expect(user).toContain('ARC_PROMISE_TOKEN 서준은 탑을 무너뜨린다');
        expect(user).toContain('PLAN_TOKEN 주인공이 탑으로 돌아간다.');
    });
});

describe('draft — 분량 계약이 생성 지시를 결정한다', () => {
    it('비ko 기본은 graphemes 이며 단어로 말하지 않는다', async () => {
        const { system, user } = await capture({ language: 'ja' });
        expect(system).toContain('Chapter length target: 3000 graphemes');
        expect(system).toContain('- Stay within ±15% of the length target, measured in graphemes.');
        expect(user).toContain('## Length target\n3000 graphemes');
        expect(system).not.toContain(' words');
        expect(user).not.toContain('words');
    });
    it('구형 targetWordCount 는 이름과 무관하게 legacyCodeUnits 로만 해석한다', async () => {
        const { system, user } = await capture({ language: 'en', targetWordCount: 2500 });
        expect(system).toContain('Chapter length target: 2500 legacyCodeUnits');
        expect(system).toContain('measured in legacyCodeUnits');
        expect(user).toContain('## Length target\n2500 legacyCodeUnits');
        expect(system).not.toContain(' words');
    });
    it('words 를 명시한 계약만 단어로 말한다', async () => {
        const contract = buildLanguageContract({ language: 'en', length: { unit: 'words', target: 900 } });
        const { system, user } = await capture({ workContract: contract });
        expect(system).toContain('Chapter length target: 900 words');
        expect(user).toContain('## Length target\n900 words');
    });
    it('1000~10000 clamp 를 재적용하지 않는다', async () => {
        const { user } = await capture({ language: 'fr', length: { unit: 'graphemes', target: 250 } });
        expect(user).toContain('## Length target\n250 graphemes');
    });
});

describe('draft — 공급된 계약을 재해석하지 않는다', () => {
    it('계약과 다른 언어를 함께 넘기면 조용히 고르지 않고 충돌로 거부한다', async () => {
        const contract = buildLanguageContract({ language: 'ja' });
        await expect(capture({ workContract: contract, language: 'es' })).rejects.toThrow(LanguagePolicyError);
    });
    it('계약과 다른 분량을 함께 넘겨도 override 하지 않는다', async () => {
        const contract = buildLanguageContract({ language: 'ja', length: { unit: 'graphemes', target: 2400 } });
        await expect(capture({ workContract: contract, length: { unit: 'graphemes', target: 3000 } }))
            .rejects.toThrow(LanguagePolicyError);
    });
    it('승인된 예외는 종류만 지시문에 들어가고 scope·rationale 은 데이터로 남는다', async () => {
        const contract = buildLanguageContract({
            language: 'ja',
            allowedLanguageExceptions: [
                { kind: 'sourceQuote', language: 'ko', scope: 'SCOPE_SECRET_TOKEN', rationale: 'RATIONALE_SECRET_TOKEN' },
            ],
        });
        const { system, user } = await capture({ workContract: contract });
        expect(system).toContain('Approved foreign-language exceptions are limited to: sourceQuote.');
        expect(system).not.toContain('SCOPE_SECRET_TOKEN');
        expect(system).not.toContain('RATIONALE_SECRET_TOKEN');
        expect(user).not.toContain('RATIONALE_SECRET_TOKEN');
    });
});

/**
 * root 재현 결함 — 승인된 계약이 있으면 호출자가 적은 구형 목표를 조용히 버렸다.
 * 생략된 기본값은 중복이 아니지만, 명시된 목표는 반드시 확인 대상이다.
 */
describe('draft — 구형 targetWordCount 중복 지정', () => {
    it('계약과 같은 legacyCodeUnits 목표는 통과한다', async () => {
        const contract = buildLanguageContract({ language: 'en', legacyLength: { chapterChars: 2500 } });
        const { system } = await capture({ workContract: contract, targetWordCount: 2500 });
        expect(system).toContain('Chapter length target: 2500 legacyCodeUnits');
    });
    it('계약과 다른 목표는 조용히 버리지 않고 충돌로 거부한다', async () => {
        const contract = buildLanguageContract({ language: 'en', legacyLength: { chapterChars: 2500 } });
        await expect(capture({ workContract: contract, targetWordCount: 3200 })).rejects.toThrow(LanguagePolicyError);
        // 단위가 다른 계약에 코드 단위 목표를 얹는 것도 충돌이다.
        const graphemeContract = buildLanguageContract({ language: 'ja' });
        await expect(capture({ workContract: graphemeContract, targetWordCount: 3000 })).rejects.toThrow(LanguagePolicyError);
    });
    it('목표를 생략하면 계약이 그대로 쓰인다(중복 아님)', async () => {
        const contract = buildLanguageContract({ language: 'ja' });
        const { user } = await capture({ workContract: contract });
        expect(user).toContain('## Length target\n3000 graphemes');
    });
});

describe('draft — 대사 문단 규칙은 포맷 정책이 정한다', () => {
    it('비ko 기본은 natural 이며 한국어식 대사 고립을 강요하지 않는다', async () => {
        const { system } = await capture({ language: 'ja' });
        expect(system).toContain('Follow the dialogue and paragraph conventions of the target language');
        expect(system).toContain('inline speech attribution');
        expect(system).not.toContain('own paragraph');
        expect(system).not.toContain('read on a phone');
    });
    it('ko 기본은 strict 이며 기존 문구 그대로다', async () => {
        const { system } = await capture();
        expect(system).toContain('- 대사와 서술은 모바일에서 구분하되, 하나의 원인·반응·결과로 이어지는 짧은 서술은 한 문단에 묶어 호흡을 만든다.');
    });
    it('승인된 모드를 넘기면 계열과 무관하게 그 의미를 유지한다', async () => {
        const strict = await capture({ language: 'ja', dialogueBreakMode: 'strict' });
        expect(strict.system).toContain('Give each line of dialogue its own paragraph');
        const relaxed = await capture({ dialogueBreakMode: 'relaxed' });
        expect(relaxed.system).toContain('- 대사는 서술 문단 안에 놓을 수 있지만 긴 서술 뒤에 파묻지 않는다.');
        const natural = await capture({ dialogueBreakMode: 'natural' });
        expect(natural.system).toContain('- 대사와 서술의 배치는 목표 독자의 산문 관습에 맞춘다.');
    });
    it('계약에 고정된 모드가 있으면 다른 요청을 조용히 덮지 않는다', async () => {
        const base = buildLanguageContract({ language: 'ja' });
        const pinned = { ...base, formatPolicy: { ...base.formatPolicy, dialogueBreakMode: 'strict' } };
        const { system } = await capture({ workContract: pinned });
        expect(system).toContain('Give each line of dialogue its own paragraph');
        await expect(capture({ workContract: pinned, dialogueBreakMode: 'natural' })).rejects.toThrow(LanguagePolicyError);
    });
});

describe('draft — 작가 커스텀 지침은 자유 텍스트 데이터다', () => {
    const override = { genrePolicy: 'GENRE_TOKEN 느와르. PG-13.', freeNotes: 'NOTES_TOKEN', worldStylePreset: 'sci-fi' };
    it('비ko 에서는 영어 라벨 + 데이터 표시로 렌더링하고 값은 원문 그대로 둔다', async () => {
        const { system } = await capture({ language: 'ja', customPromptOverride: override });
        expect(system).toContain('## Author custom directions (work-level)');
        expect(system).toContain('author-supplied direction data');
        expect(system).toContain('Genre / content policy: GENRE_TOKEN 느와르. PG-13.');
        expect(system).toContain('Author notes: NOTES_TOKEN');
        expect(system).toContain('World style: Science fiction setting.');
        expect(system).not.toContain('작가 커스텀 지침');
    });
    it('override 는 구조·sentinel 규칙을 밀어내지 않는다', async () => {
        const { system } = await capture({ language: 'ja', customPromptOverride: override });
        expect(system).toContain('Manifest rules:');
        expect(system.indexOf('⟦vle:cast-manifest')).toBeLessThan(system.indexOf('## Author custom directions'));
    });
    it('ko 계열의 커스텀 지침 블록은 기존과 같다', async () => {
        const { system } = await capture({ customPromptOverride: override });
        expect(system).toContain('## 작가 커스텀 지침 (작품 단위)');
        expect(system).toContain('- 장르/콘텐츠 정책: GENRE_TOKEN 느와르. PG-13.');
        expect(system).toContain('- 세계관 스타일: SF 배경');
        // 계약 없는 구형 호출에는 우선순위 줄이 붙지 않는다(byte-identical).
        expect(system).not.toContain('작품 언어 계약(목표 언어·분량 단위)');
    });
    it('언어 계약이 있으면 계약·구조 규칙이 작가 지침보다 위임을 명시한다', async () => {
        const ja = await capture({ language: 'ja', customPromptOverride: override });
        expect(ja.system).toContain('The work language contract (target language and length unit) and the structural, sentinel and continuity rules above take precedence over this block.');
        expect(ja.system).toContain('Nothing written here is a language directive');
        // 작가 슬롯 자체는 그대로 유지된다 — 통제 수단을 없애지 않는다.
        expect(ja.system).toContain('Genre / content policy: GENRE_TOKEN');
        expect(ja.system).toContain('Author notes: NOTES_TOKEN');
        const ko = await capture({ language: 'ko-KR', customPromptOverride: override });
        expect(ko.system).toContain('작품 언어 계약(목표 언어·분량 단위)과 위의 구조·sentinel·연속성 규칙이 이 지침보다 우선한다.');
        expect(ko.system).toContain('- 장르/콘텐츠 정책: GENRE_TOKEN 느와르. PG-13.');
    });
    it('override 가 없으면 두 계열 모두 블록을 생략한다', async () => {
        const { system } = await capture({ language: 'ja' });
        expect(system).not.toContain('## Author custom directions');
    });
});

describe('draft — 저장된 Foundation 언어 메타데이터 상속', () => {
    it('언어 인자 없이도 Foundation 에 저장된 언어로 라우팅한다', async () => {
        const contract = buildLanguageContract({ language: 'ja', length: { unit: 'graphemes', target: 2600 } });
        const { system, user } = await capture({
            foundation: { ...makeFoundation(), language: 'ja', workContract: contract, length: contract.length },
            targetWordCount: null,
        });
        expect(HANGUL.test(system)).toBe(false);
        expect(system).toContain('Target work language (BCP 47): ja.');
        expect(user).toContain('## Length target\n2600 graphemes');
    });
    it('저장된 language 만 있어도 계열이 정해진다', async () => {
        const { system } = await capture({
            foundation: { ...makeFoundation(), language: 'en' },
            targetWordCount: null,
        });
        expect(system).toContain('Target work language (BCP 47): en.');
    });
    it('저장값과 어긋난 호출 인자는 거부한다', async () => {
        const contract = buildLanguageContract({ language: 'ja' });
        await expect(capture({
            foundation: { ...makeFoundation(), language: 'ja', workContract: contract },
            language: 'en',
            targetWordCount: null,
        })).rejects.toThrow(LanguagePolicyError);
        // 파이프라인이 이미 해석한 컨텍스트와도 대조한다.
        await expect(capture({
            foundation: { ...makeFoundation(), language: 'ja', workContract: contract },
            promptLanguage: { language: 'es' },
            targetWordCount: null,
        })).rejects.toThrow(LanguagePolicyError);
    });
    it('상속된 workContract 분량은 회차별 targetWordCount 로 덮지 않는다', async () => {
        const contract = buildLanguageContract({ language: 'en', length: { unit: 'words', target: 3000 } });
        await expect(capture({
            foundation: { ...makeFoundation(), language: 'en', workContract: contract, length: contract.length },
            length: { unit: 'words', target: 3300 },
        })).rejects.toThrow(LanguagePolicyError);
        const words = buildLanguageContract({ language: 'en', length: { unit: 'words', target: 900 } });
        await expect(capture({
            foundation: { ...makeFoundation(), language: 'en', workContract: words },
            targetWordCount: 1000,
        })).rejects.toThrow(LanguagePolicyError);
        const same = await capture({
            foundation: { ...makeFoundation(), language: 'en', workContract: contract, length: contract.length },
            length: { unit: 'words', target: 3000 },
        });
        expect(same.user).toContain('## Length target\n3000 words');
    });
    it('메타데이터 없는 기존 작품은 암묵적 ko 이며 다른 언어 요구를 거부한다', async () => {
        // 기존 작품은 "언어 미선택" 이 아니라 이미 ko 로 선택된 작품이다.
        const legacy = makeFoundation();
        await expect(capture({ foundation: legacy, language: 'ja' })).rejects.toThrow(LanguagePolicyError);
        await expect(capture({ foundation: legacy, workContract: buildLanguageContract({ language: 'ja' }) }))
            .rejects.toThrow(LanguagePolicyError);
        // 같은 ko 를 명시하는 기존 호출자는 그대로 동작한다.
        const ko = await capture({ foundation: legacy, language: 'ko' });
        expect(ko.system).toContain('당신은 한국어 웹소설 작가이다.');
        expect(ko.system).toContain('작품 언어(BCP 47): ko.');
        // 인자가 없으면 구형 프롬프트와 byte-identical 이다.
        const legacyCall = await capture({ foundation: legacy });
        expect(legacyCall.system).toBe(buildDraftSystem());
    });
    it('언어 메타데이터가 없는 구형 Foundation 은 기존 기본값을 지킨다', async () => {
        const { system, user } = await capture();
        expect(system).toContain('당신은 한국어 웹소설 작가이다.');
        expect(user).toContain('## 목표 글자 수\n3500');
    });
});
