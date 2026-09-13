/**
 * prompt-language — 계열 라우팅/조립 helper (다국어 Phase 2A).
 *
 * 이 helper 는 언어 계약의 의미를 새로 정하지 않는다. 여기서 검증하는 것은
 * (1) 계열이 정확히 둘이라는 점, (2) 계약 없는 구형 호출의 ko 해석,
 * (3) 공급된 계약을 재해석하거나 조용히 override 하지 않는다는 점이다.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { buildLanguageContract, LANGUAGE_ERROR_CODES, LanguagePolicyError, } from '../../src/core/language-policy.js';
import { DEFAULT_PROMPT_LANGUAGE, PROMPT_FORMAT_ERROR_CODES, formatLengthTarget, isLanguageContract, isPromptLanguageContext, languageSystemLines, pickByFamily, promptFamilyCaptureContext, resolveDerivedLength, resolveDialogueBreakMode, resolvePromptLanguageContext, resolveStepPromptLanguage, resolveWorkPromptLanguage, } from '../../src/core/prompt-language.js';

/** 계약 오류 코드 확인용 — 오류가 아예 안 나면 실패한다. */
function codeOf(fn) {
    try {
        fn();
    }
    catch (err) {
        expect(err).toBeInstanceOf(LanguagePolicyError);
        return err.code;
    }
    throw new Error('expected a LanguagePolicyError');
}

describe('resolvePromptLanguageContext', () => {
    it('계약도 언어도 없으면 암묵적 ko 이며 지시문을 붙이지 않는다', () => {
        const ctx = resolvePromptLanguageContext();
        expect(ctx.language).toBe(DEFAULT_PROMPT_LANGUAGE);
        expect(ctx.promptFamily).toBe('ko');
        expect(ctx.isKo).toBe(true);
        expect(ctx.explicit).toBe(false);
        expect(ctx.systemLines).toEqual([]);
        // 계약 자체는 조립돼 있어 하위 단계가 단위를 읽을 수 있다.
        expect(ctx.length).toEqual({ unit: 'legacyCodeUnits', target: 3000 });
    });
    it('명시 언어는 지시문을 낸다', () => {
        const ctx = resolvePromptLanguageContext({ language: 'ja' });
        expect(ctx.explicit).toBe(true);
        expect(ctx.promptFamily).toBe('multilingual');
        expect(languageSystemLines(ctx)[0]).toBe('Target work language (BCP 47): ja.');
    });
    it('ko-KR 은 지역을 보존한 채 ko 계열로 라우팅한다', () => {
        const ctx = resolvePromptLanguageContext({ language: 'ko-kr' });
        expect(ctx.language).toBe('ko-KR');
        expect(ctx.isKo).toBe(true);
    });
    it('멱등이며 계약 객체를 직접 넘겨도 같은 컨텍스트가 된다', () => {
        const contract = buildLanguageContract({ language: 'zh-Hant' });
        const fromContract = resolvePromptLanguageContext(contract);
        expect(fromContract.language).toBe('zh-Hant');
        expect(isPromptLanguageContext(fromContract)).toBe(true);
        expect(resolvePromptLanguageContext(fromContract)).toBe(fromContract);
    });
    it('공급된 계약과 다른 언어/분량은 조용히 고르지 않고 거부한다', () => {
        const contract = buildLanguageContract({ language: 'ja', length: { unit: 'graphemes', target: 2400 } });
        try {
            resolvePromptLanguageContext({ workContract: contract, language: 'es' });
            throw new Error('expected a conflict');
        }
        catch (err) {
            expect(err).toBeInstanceOf(LanguagePolicyError);
            expect(err.code).toBe(LANGUAGE_ERROR_CODES.LANGUAGE_CONTRACT_CONFLICT);
        }
        try {
            resolvePromptLanguageContext({ workContract: contract, length: { unit: 'graphemes', target: 3000 } });
            throw new Error('expected a conflict');
        }
        catch (err) {
            expect(err).toBeInstanceOf(LanguagePolicyError);
            expect(err.code).toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
        }
    });
    it('구형 분량 인자는 이름과 무관하게 legacyCodeUnits 다', () => {
        const ctx = resolvePromptLanguageContext({ language: 'en', legacyLength: { chapterWordCount: 2500 } });
        expect(ctx.length).toEqual({ unit: 'legacyCodeUnits', target: 2500 });
    });
});

/**
 * root 재현 결함 — 평범한 `{language, length}` 옵션이 "완성된 계약" 으로 오인되면
 * buildLanguageContract 를 건너뛰어 measurementPolicy 가 없는 반쪽 계약이 되고
 * legacyLength 중복 검사도 사라진다.
 */
describe('resolvePromptLanguageContext — 옵션과 완성된 계약의 구분', () => {
    it('{language, length} 옵션은 계약이 아니라 옵션이며 측정 정책까지 조립된다', () => {
        const ctx = resolvePromptLanguageContext({ language: 'en', length: { unit: 'words', target: 300 } });
        expect(isLanguageContract(ctx.contract)).toBe(true);
        expect(ctx.contract.measurementPolicy.unit).toBe('words');
        expect(ctx.contract.measurementPolicy.segmenterGranularity).toBe('word');
        // 측정 locale 은 목표 언어여야 한다(계약 소유). 계열은 다국어.
        expect(ctx.contract.measurementPolicy.language).toBe('en');
        expect(ctx.promptFamily).toBe('multilingual');
        expect(ctx.length).toEqual({ unit: 'words', target: 300 });
    });
    it('같은 옵션에 구형 인자를 더하면 단위가 달라 충돌로 거부한다', () => {
        expect(codeOf(() => resolvePromptLanguageContext({
            language: 'en',
            length: { unit: 'words', target: 300 },
            legacyLength: { chapterChars: 300 },
        }))).toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
    });
    it('workContract 를 담은 입력은 최상위 language/length 로 우회할 수 없다', () => {
        const ja = buildLanguageContract({ language: 'ja', length: { unit: 'graphemes', target: 2400 } });
        // 결함 재현: 예전에는 입력 자체가 계약처럼 보여 ja 계약이 통째로 무시됐다.
        expect(codeOf(() => resolvePromptLanguageContext({
            workContract: ja,
            language: 'en',
            length: { unit: 'words', target: 300 },
        }))).toBe(LANGUAGE_ERROR_CODES.LANGUAGE_CONTRACT_CONFLICT);
        // 언어가 같아도 분량이 다르면 여전히 충돌이다.
        expect(codeOf(() => resolvePromptLanguageContext({
            workContract: ja,
            language: 'ja',
            length: { unit: 'words', target: 300 },
        }))).toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
    });
    it('공급된 계약과 함께 온 구형 인자도 전부 확인 대상이다', () => {
        const ko = buildLanguageContract({ language: 'ko', legacyLength: { chapterChars: 3200 } });
        // 같은 legacyCodeUnits 목표면 통과하고 계약이 그대로 쓰인다.
        const ctx = resolvePromptLanguageContext({ workContract: ko, legacyLength: { targetChars: 3200 } });
        expect(ctx.contract).toBe(ko);
        expect(ctx.length).toEqual({ unit: 'legacyCodeUnits', target: 3200 });
        // 다른 목표면 조용히 버리지 않는다.
        expect(codeOf(() => resolvePromptLanguageContext({ workContract: ko, legacyLength: { targetChars: 2000 } })))
            .toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
        // 구형 인자끼리 어긋나도 전부 검사한다.
        expect(codeOf(() => resolvePromptLanguageContext({
            workContract: ko,
            legacyLength: { targetChars: 3200, chapterWordCount: 2000 },
        }))).toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
    });
    it('반쪽짜리 계약 객체는 계약으로 인정하지 않는다', () => {
        expect(isLanguageContract({ language: 'en', length: { unit: 'words', target: 300 } })).toBe(false);
        expect(isLanguageContract(buildLanguageContract({ language: 'en' }))).toBe(true);
        expect(codeOf(() => resolvePromptLanguageContext({ workContract: { language: 'en', length: { unit: 'words', target: 300 } } })))
            .toBe(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT);
    });
});

describe('resolveDialogueBreakMode — 포맷 정책', () => {
    it('계열 기본값은 ko=strict / 비ko=natural 이다', () => {
        expect(resolvePromptLanguageContext({}).dialogueBreakMode).toBe('strict');
        expect(resolveDialogueBreakMode({ language: 'ko' })).toBe('strict');
        expect(resolveDialogueBreakMode({ language: 'ja' })).toBe('natural');
        expect(resolveDialogueBreakMode({ language: 'en' })).toBe('natural');
    });
    it('명시 모드는 그대로 쓰고 알 수 없는 값은 거부한다', () => {
        expect(resolveDialogueBreakMode({ language: 'ja' }, 'strict')).toBe('strict');
        expect(resolveDialogueBreakMode({ language: 'ko' }, 'relaxed')).toBe('relaxed');
        expect(codeOf(() => resolveDialogueBreakMode({ language: 'ja' }, 'loose')))
            .toBe(PROMPT_FORMAT_ERROR_CODES.INVALID_DIALOGUE_BREAK_MODE);
    });
    it('계약에 고정된 모드가 있으면 그것이 원천이고 다른 요청은 충돌이다', () => {
        // phase 3 이 formatPolicy 에 승인 모드를 넣었을 때의 형태.
        const base = buildLanguageContract({ language: 'ja' });
        const pinned = { ...base, formatPolicy: { ...base.formatPolicy, dialogueBreakMode: 'strict' } };
        expect(resolvePromptLanguageContext({ workContract: pinned }).dialogueBreakMode).toBe('strict');
        expect(resolveDialogueBreakMode({ workContract: pinned }, 'strict')).toBe('strict');
        expect(codeOf(() => resolveDialogueBreakMode({ workContract: pinned }, 'natural')))
            .toBe(PROMPT_FORMAT_ERROR_CODES.FORMAT_POLICY_CONFLICT);
    });
});

describe('languageSystemLines / resolveDerivedLength', () => {
    it('회차 분량이 목표가 아닌 단계는 회차 분량 줄을 싣지 않는다', () => {
        const ctx = resolvePromptLanguageContext({ language: 'ja' });
        expect(languageSystemLines(ctx).some((l) => l.includes('3000 graphemes'))).toBe(true);
        const trimmed = languageSystemLines(ctx, { includeChapterLength: false });
        expect(trimmed.some((l) => l.includes('3000 graphemes'))).toBe(false);
        expect(trimmed[0]).toBe('Target work language (BCP 47): ja.');
        // ko 계열도 같은 방식으로 제거된다.
        const ko = resolvePromptLanguageContext({ language: 'ko' });
        expect(languageSystemLines(ko, { includeChapterLength: false }).some((l) => l.includes('분량 목표'))).toBe(false);
    });
    it('파생 분량은 계약의 측정 단위를 그대로 쓴다', () => {
        const ja = resolvePromptLanguageContext({ language: 'ja' });
        expect(resolveDerivedLength(ja, { defaultTarget: 400 })).toEqual({ unit: 'graphemes', target: 400, source: 'default' });
        expect(resolveDerivedLength(ja, { length: { unit: 'graphemes', target: 500 }, defaultTarget: 400 }))
            .toEqual({ unit: 'graphemes', target: 500, source: 'explicit' });
    });
    it('코드 단위 목표는 legacyCodeUnits 계약에서만 인정한다', () => {
        const ko = resolvePromptLanguageContext({});
        expect(resolveDerivedLength(ko, { legacyCodeUnitTarget: 400, defaultTarget: 400 }))
            .toEqual({ unit: 'legacyCodeUnits', target: 400, source: 'legacy' });
        // graphemes/words 계약에 "400자" 를 몰래 재해석하지 않는다.
        expect(codeOf(() => resolveDerivedLength({ language: 'ja' }, { legacyCodeUnitTarget: 400, defaultTarget: 400 })))
            .toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
        expect(codeOf(() => resolveDerivedLength({ language: 'en', length: { unit: 'words', target: 900 } }, { length: { unit: 'graphemes', target: 400 }, defaultTarget: 400 })))
            .toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
    });
    it('신규 목표와 구형 코드 단위 목표를 함께 넘기면 같은 값일 때만 허용한다', () => {
        const ko = resolvePromptLanguageContext({});
        // 같은 코드 단위 목표의 중복은 허용한다.
        expect(resolveDerivedLength(ko, { length: { unit: 'legacyCodeUnits', target: 10 }, legacyCodeUnitTarget: 10, defaultTarget: 400 }))
            .toEqual({ unit: 'legacyCodeUnits', target: 10, source: 'explicit' });
        // 값이 다른 중복은 앞선 값을 조용히 쓰지 않고 거부한다.
        expect(codeOf(() => resolveDerivedLength(ko, { length: { unit: 'legacyCodeUnits', target: 10 }, legacyCodeUnitTarget: 20, defaultTarget: 400 })))
            .toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
        // words 계약에서는 코드 단위 중복 자체가 충돌이다.
        expect(codeOf(() => resolveDerivedLength({ language: 'en', length: { unit: 'words', target: 900 } }, { length: { unit: 'words', target: 10 }, legacyCodeUnitTarget: 10, defaultTarget: 400 })))
            .toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
    });
});

describe('resolveStepPromptLanguage — 명시 인자를 버리지 않는다', () => {
    it('이미 해석된 컨텍스트와 함께 온 분량·구형 분량도 확인한다', () => {
        const promptLanguage = resolvePromptLanguageContext({ language: 'en', length: { unit: 'words', target: 300 } });
        // 일치하는 값은 통과하고 컨텍스트는 그대로다.
        expect(resolveStepPromptLanguage({ promptLanguage, length: { unit: 'words', target: 300 } })).toBe(promptLanguage);
        expect(codeOf(() => resolveStepPromptLanguage({ promptLanguage, length: { unit: 'words', target: 500 } })))
            .toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
        // 구형 인자도 버리지 않는다 — words 계약에 코드 단위 목표는 충돌이다.
        expect(codeOf(() => resolveStepPromptLanguage({ promptLanguage, legacyLength: { chapterChars: 300 } })))
            .toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
        expect(codeOf(() => resolveStepPromptLanguage({ promptLanguage, language: 'ja' })))
            .toBe(LANGUAGE_ERROR_CODES.LANGUAGE_CONTRACT_CONFLICT);
    });
    it('계약 없는 경로에서도 구형 분량 인자를 확인한다', () => {
        const ctx = resolveStepPromptLanguage({ language: 'ko', legacyLength: { chapterChars: 2800 } });
        expect(ctx.length).toEqual({ unit: 'legacyCodeUnits', target: 2800 });
        expect(codeOf(() => resolveStepPromptLanguage({
            language: 'en',
            length: { unit: 'words', target: 300 },
            legacyLength: { chapterChars: 300 },
        }))).toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
    });
    it('언어·분량이 같아도 포맷 정책·예외가 다른 계약은 조용히 하나를 고르지 않는다', () => {
        const base = buildLanguageContract({ language: 'ja' });
        const pinnedFormat = { ...base, formatPolicy: { ...base.formatPolicy, dialogueBreakMode: 'relaxed' } };
        expect(codeOf(() => resolveStepPromptLanguage({ promptLanguage: base, workContract: pinnedFormat })))
            .toBe(LANGUAGE_ERROR_CODES.LANGUAGE_CONTRACT_CONFLICT);
        const withException = buildLanguageContract({
            language: 'ja',
            allowedLanguageExceptions: [{
                kind: 'properNoun', language: 'en', scope: 'character:c1', rationale: '원어 고유명 유지',
            }],
        });
        expect(codeOf(() => resolveStepPromptLanguage({ promptLanguage: base, workContract: withException })))
            .toBe(LANGUAGE_ERROR_CODES.LANGUAGE_CONTRACT_CONFLICT);
        // 같은 의미의 계약(출처만 다른 경우)은 통과한다.
        expect(resolveStepPromptLanguage({
            promptLanguage: base,
            workContract: buildLanguageContract({ language: 'ja', languageSource: 'profile' }),
        }).language).toBe('ja');
    });
});

describe('resolveWorkPromptLanguage — 저장된 작품 언어가 원천', () => {
    it('저장된 계약을 그대로 쓰고 호출 인자가 없어도 ko 로 떨어지지 않는다', () => {
        const contract = buildLanguageContract({ language: 'ja', length: { unit: 'graphemes', target: 2600 } });
        const ctx = resolveWorkPromptLanguage({ foundation: { workContract: contract, language: 'ja' } });
        expect(ctx.language).toBe('ja');
        expect(ctx.contract).toBe(contract);
        expect(ctx.explicit).toBe(true);
        expect(ctx.length).toEqual({ unit: 'graphemes', target: 2600 });
    });
    it('저장된 language(+length)로 계약을 조립한다', () => {
        const ctx = resolveWorkPromptLanguage({
            foundation: { language: 'en', length: { unit: 'words', target: 900 } },
        });
        expect(ctx.language).toBe('en');
        expect(ctx.length).toEqual({ unit: 'words', target: 900 });
    });
    it('저장된 언어와 어긋난 호출 인자는 거부한다', () => {
        const contract = buildLanguageContract({ language: 'ja' });
        expect(codeOf(() => resolveWorkPromptLanguage({
            foundation: { workContract: contract, language: 'ja' },
            language: 'en',
        }))).toBe(LANGUAGE_ERROR_CODES.LANGUAGE_CONTRACT_CONFLICT);
        // Foundation 안에서 계약과 length 메타데이터가 서로 다른 손상 상태도 거부한다.
        expect(codeOf(() => resolveWorkPromptLanguage({
            foundation: { workContract: contract, length: { unit: 'graphemes', target: 9999 } },
        }))).toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
    });
    it('저장된 분량은 기본값이라 회차별 분량 요청이 이긴다', () => {
        // 회차별 분량 지정은 기존에 지원되는 기능이다 — 생성 시점 값이 상한이 아니다.
        const stored = buildLanguageContract({ language: 'ko', length: { unit: 'legacyCodeUnits', target: 3000 } });
        const ctx = resolveWorkPromptLanguage({
            foundation: { workContract: stored, language: 'ko', length: stored.length },
            legacyLength: { chapterWordCount: 1000 },
        });
        expect(ctx.language).toBe('ko');
        expect(ctx.length).toEqual({ unit: 'legacyCodeUnits', target: 1000 });
        const fromLanguageOnly = resolveWorkPromptLanguage({
            foundation: { language: 'en', length: { unit: 'words', target: 900 } },
            length: { unit: 'words', target: 1200 },
        });
        expect(fromLanguageOnly.length).toEqual({ unit: 'words', target: 1200 });
    });
    it('측정 단위를 바꾸는 분량 요청과 승인된 계약의 분량 불일치는 거부한다', () => {
        const stored = buildLanguageContract({ language: 'en', length: { unit: 'words', target: 900 } });
        // 작품은 단어로 세는데 이 회차만 코드 단위로 세라는 요청은 다른 것을 세는 것이다.
        expect(codeOf(() => resolveWorkPromptLanguage({
            foundation: { workContract: stored },
            legacyLength: { chapterChars: 3000 },
        }))).toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
        // 이 호출에 승인된 계약이 함께 왔다면 그 계약의 분량이 고정값이다.
        expect(codeOf(() => resolveWorkPromptLanguage({
            foundation: { workContract: stored },
            workContract: stored,
            length: { unit: 'words', target: 1200 },
        }))).toBe(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT);
    });
    it('회차 분량만 바뀐 계약도 고정된 포맷 정책·예외를 잃지 않는다', () => {
        const base = buildLanguageContract({
            language: 'ja',
            length: { unit: 'graphemes', target: 3000 },
            allowedLanguageExceptions: [{
                kind: 'properNoun', language: 'en', scope: 'character:c1', rationale: '원어 고유명 유지',
            }],
        });
        const stored = { ...base, formatPolicy: { ...base.formatPolicy, dialogueBreakMode: 'relaxed' } };
        const ctx = resolveWorkPromptLanguage({
            foundation: { workContract: stored },
            length: { unit: 'graphemes', target: 2400 },
        });
        expect(ctx.length).toEqual({ unit: 'graphemes', target: 2400 });
        expect(ctx.dialogueBreakMode).toBe('relaxed');
        expect(ctx.contract.allowedLanguageExceptions).toHaveLength(1);
        expect(ctx.contract.measurementPolicy).toEqual(stored.measurementPolicy);
    });
    it('언어 메타데이터가 없는 구형 작품은 기존 동작 그대로다', () => {
        const ctx = resolveWorkPromptLanguage({ foundation: { workId: 'w', genre: 'action' } });
        expect(ctx.language).toBe(DEFAULT_PROMPT_LANGUAGE);
        expect(ctx.explicit).toBe(false);
        expect(ctx.systemLines).toEqual([]);
        // 구형 작품에 호출자가 언어를 주면 그 값이 쓰인다.
        expect(resolveWorkPromptLanguage({ foundation: { workId: 'w' }, language: 'ja' }).language).toBe('ja');
    });
});

describe('promptFamilyCaptureContext', () => {
    it('계열만 고르고 지시문·작품 수치는 붙이지 않는다', () => {
        const ko = promptFamilyCaptureContext('ko');
        const ml = promptFamilyCaptureContext('multilingual');
        expect(ko.isKo).toBe(true);
        expect(ml.isKo).toBe(false);
        for (const ctx of [ko, ml]) {
            expect(ctx.explicit).toBe(false);
            expect(ctx.systemLines).toEqual([]);
            expect(isPromptLanguageContext(ctx)).toBe(true);
        }
        expect(() => promptFamilyCaptureContext('en')).toThrow(TypeError);
    });
});

describe('pickByFamily', () => {
    const variants = { ko: 'KO', multilingual: 'ML' };
    it('계열은 정확히 둘이다', () => {
        expect(pickByFamily({ language: 'ko' }, variants)).toBe('KO');
        expect(pickByFamily({ language: 'ja' }, variants)).toBe('ML');
        // 영어도 다국어 계열이다.
        expect(pickByFamily({ language: 'en-US' }, variants)).toBe('ML');
    });
    it('계열 하나만 정의하면 오류다 — 한국어 system + 목표 언어 한 줄 방지', () => {
        expect(() => pickByFamily({ language: 'ja' }, { ko: 'KO' })).toThrow(TypeError);
        expect(() => pickByFamily({ language: 'ja' }, { multilingual: 'ML' })).toThrow(TypeError);
    });
    it('함수 variant 에는 컨텍스트를 넘긴다', () => {
        const out = pickByFamily({ language: 'ja' }, { ko: () => 'ko', multilingual: (ctx) => ctx.language });
        expect(out).toBe('ja');
    });
});

describe('formatLengthTarget', () => {
    it('구형 ko 목표는 숫자만 쓴다(기존 프롬프트 유지)', () => {
        expect(formatLengthTarget(resolvePromptLanguageContext())).toBe('3000');
    });
    it('그 밖에는 단위를 함께 적어 counter 와 어긋나지 않게 한다', () => {
        expect(formatLengthTarget({ language: 'ja' })).toBe('3000 graphemes');
        expect(formatLengthTarget({ language: 'en', length: { unit: 'words', target: 900 } })).toBe('900 words');
        expect(formatLengthTarget({ language: 'ko', length: { unit: 'graphemes', target: 1200 } })).toBe('1200 graphemes');
    });
});
