/**
 * prompts/index.js 공개 표면 — 다국어 Phase 2A 계열.
 *
 * 이 표면은 실행 경로가 부르지 않지만 `engine/src/index.js` 공개 export 라 호환
 * 유지 대상이다(INVENTORY §3). 확인하는 계약:
 *   1. 기존 이름(`DRAFT_SYSTEM` 등)의 값은 한국어 계열 그대로다.
 *   2. 계열 선택은 새 이름으로만 얹힌다 — `*SystemFor(context)` / `*_MULTILINGUAL`.
 *   3. 공개 user 빌더도 `language` 를 표시값이 아니라 목표 언어 선택으로 쓰고,
 *      계약과 어긋나면 거부한다.
 *   4. static manifest 는 live 와 public 을 분리해 노출한다.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { buildLanguageContract, LanguagePolicyError } from '../../src/core/language-policy.js';
import {
    CAST_DESIGN_SYSTEM, CAST_DESIGN_SYSTEM_MULTILINGUAL, DRAFT_FEWSHOT, DRAFT_FEWSHOT_MULTILINGUAL,
    DRAFT_SYSTEM, DRAFT_SYSTEM_MULTILINGUAL, REVISE_FOUNDATION_SYSTEM, REVISE_PATCH_SYSTEM, REVISE_SYSTEM,
    REWRITE_SYSTEM, WORLDBUILD_SYSTEM, WORLDBUILD_SYSTEM_MULTILINGUAL, buildCastDesignUserPrompt,
    buildDraftUserPrompt, buildWorldbuildUserPrompt, castDesignInputFrom, castDesignSystemFor,
    draftSystemFor, reviseSystemFor, rewriteSystemFor, reviseFoundationSystemFor, worldbuildSystemFor,
} from '../../src/generators/text/prompts/index.js';
import {
    PUBLIC_PROMPT_SURFACES, STATIC_PROMPT_STEPS, capturePublicPromptFamily, capturePublicPromptManifest,
    captureStaticPromptFamily,
} from '../../src/generators/text/steps/static-prompt-manifest.js';

const HANGUL = /[가-힣]/;
const DRAFT_INPUT = {
    chapterNumber: 5,
    targetWordCount: 3500,
    foundation: { genre: 'action', worldFacts: ['WORLDFACT_TOKEN 탑은 무너지지 않는다.'] },
    prevState: { chapterNumber: 4 },
    plan: { plan: 'PLAN_TOKEN' },
};
const WORLDBUILD_INPUT = {
    title: 'TITLE_TOKEN',
    genre: 'action',
    brief: 'BRIEF_TOKEN',
    targetChapters: 40,
};

describe('공개 프롬프트 표면 — 계열 선택', () => {
    it('계약 없는 선택자는 기존 한국어 상수를 그대로 돌려준다', () => {
        const legacy = {};
        expect(draftSystemFor(legacy)).toBe(DRAFT_SYSTEM);
        expect(worldbuildSystemFor(legacy)).toBe(WORLDBUILD_SYSTEM);
        expect(castDesignSystemFor(legacy)).toBe(CAST_DESIGN_SYSTEM);
        expect(reviseSystemFor(legacy)).toBe(REVISE_SYSTEM);
        expect(reviseSystemFor(legacy, { patchMode: true })).toBe(REVISE_PATCH_SYSTEM);
        expect(rewriteSystemFor(legacy)).toBe(REWRITE_SYSTEM);
        expect(reviseFoundationSystemFor(legacy)).toBe(REVISE_FOUNDATION_SYSTEM);
    });
    it('비ko 선택자는 다국어 계열 상수를 돌려주고 한글 지시가 없다', () => {
        const ja = { language: 'ja' };
        expect(draftSystemFor(ja)).toBe(DRAFT_SYSTEM_MULTILINGUAL);
        expect(worldbuildSystemFor(ja)).toBe(WORLDBUILD_SYSTEM_MULTILINGUAL);
        expect(castDesignSystemFor(ja)).toBe(CAST_DESIGN_SYSTEM_MULTILINGUAL);
        for (const value of [DRAFT_SYSTEM_MULTILINGUAL, WORLDBUILD_SYSTEM_MULTILINGUAL, CAST_DESIGN_SYSTEM_MULTILINGUAL, DRAFT_FEWSHOT_MULTILINGUAL]) {
            expect(HANGUL.test(value)).toBe(false);
        }
        // sentinel 문법·JSON 키는 계열과 무관한 기계 계약이다.
        expect(DRAFT_SYSTEM_MULTILINGUAL).toContain('⟦vle:cast-manifest⟧');
        expect(DRAFT_SYSTEM_MULTILINGUAL).toContain('"characterId": "c1"');
        // ko exemplar 는 한국어 예시를 유지한다.
        expect(HANGUL.test(DRAFT_FEWSHOT)).toBe(true);
    });
    it('공개 draft user 프롬프트는 계약 단위로 분량을 말한다', () => {
        const ko = buildDraftUserPrompt({ ...DRAFT_INPUT, language: 'ko' });
        expect(ko).toContain('## 기준 분량 (하한 참고용)\n3500');
        expect(ko).toContain('## 언어\nko');
        const contract = buildLanguageContract({ language: 'en', length: { unit: 'words', target: 900 } });
        const en = buildDraftUserPrompt({ ...DRAFT_INPUT, targetWordCount: null, workContract: contract });
        expect(en).toContain('## Length target (a floor, for reference)\n900 words');
        expect(en).toContain('## Target work language (BCP 47)\nen');
        expect(en).toContain('## Plan for this chapter');
        // 작품 데이터는 원문 그대로다.
        expect(en).toContain('WORLDFACT_TOKEN 탑은 무너지지 않는다.');
    });
    it('공개 draft user 프롬프트도 계약과 어긋난 구형 목표를 거부한다', () => {
        const contract = buildLanguageContract({ language: 'en', length: { unit: 'words', target: 900 } });
        expect(() => buildDraftUserPrompt({ ...DRAFT_INPUT, workContract: contract })).toThrow(LanguagePolicyError);
    });
    it('공개 worldbuild / cast-design user 프롬프트도 계열을 따른다', () => {
        const ko = buildWorldbuildUserPrompt({ ...WORLDBUILD_INPUT, language: 'ko' });
        expect(ko).toContain('## 언어\nko');
        expect(ko).toContain('## 작업');
        const ja = buildWorldbuildUserPrompt({ ...WORLDBUILD_INPUT, language: 'ja' });
        expect(ja).toContain('## Target work language (BCP 47)\nja');
        expect(ja).toContain('## Output schema (emit this one JSON object only)');
        expect(ja).toContain('{ "id": "wf1"');
        const castInput = castDesignInputFrom({ ...WORLDBUILD_INPUT, language: 'ja' }, 'PREMISE_TOKEN', [{ id: 'wf1', statement: 'FACT_TOKEN' }]);
        const cast = buildCastDesignUserPrompt(castInput);
        expect(cast).toContain('## Target work language (BCP 47)\nja');
        expect(cast).toContain('"gender": "male|female|nonbinary|unspecified"');
        expect(cast).toContain('PREMISE_TOKEN');
        expect(cast).toContain('FACT_TOKEN');
    });
    it('castDesignInputFrom 은 계약을 이어 넘기고 구형 입력에 키를 더하지 않는다', () => {
        const contract = buildLanguageContract({ language: 'ja' });
        const withContract = castDesignInputFrom({ ...WORLDBUILD_INPUT, workContract: contract }, 'p', []);
        expect(withContract.workContract).toBe(contract);
        const legacy = castDesignInputFrom({ ...WORLDBUILD_INPUT, language: 'ko' }, 'p', []);
        expect('workContract' in legacy).toBe(false);
        expect('promptLanguage' in legacy).toBe(false);
    });
});

describe('static prompt manifest — public 표면 분리', () => {
    it('public 캡처는 live 와 다른 맵이며 ko 값은 기존 공개 상수와 같다', () => {
        expect(PUBLIC_PROMPT_SURFACES).toEqual(['cast-design', 'draft', 'worldbuild']);
        const manifest = capturePublicPromptManifest();
        expect(manifest.draft.ko).toBe(DRAFT_SYSTEM);
        expect(manifest.draft.multilingual).toBe(DRAFT_SYSTEM_MULTILINGUAL);
        expect(manifest.worldbuild.ko).toBe(WORLDBUILD_SYSTEM);
        expect(manifest['cast-design'].ko).toBe(CAST_DESIGN_SYSTEM);
        // live draft(steps/draft.js 자체 builder)는 공개 상수와 **다른** 문자열이다.
        expect(captureStaticPromptFamily('ko').draft).not.toBe(manifest.draft.ko);
        expect(capturePublicPromptFamily('ko').draft).toBe(DRAFT_SYSTEM);
        for (const id of ['revise', 'revise-patch', 'revise-foundation', 'rewrite', 'worldbuild', 'cast-design']) {
            expect(STATIC_PROMPT_STEPS).toContain(id);
        }
    });
    it('public 캡처에도 목표 언어 태그나 분량 수치가 들어가지 않는다', () => {
        const ml = capturePublicPromptFamily('multilingual');
        for (const id of PUBLIC_PROMPT_SURFACES) {
            expect(HANGUL.test(ml[id])).toBe(false);
            expect(ml[id]).not.toContain('Target work language (BCP 47)');
            expect(ml[id]).not.toContain('3000');
        }
        expect(() => capturePublicPromptFamily('en')).toThrow(TypeError);
    });
});
