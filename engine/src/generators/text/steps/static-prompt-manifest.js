/**
 * static-prompt-manifest — ADR-0006 promptManifest 수집을 위한 **계열별 정적 표면**.
 *
 * 계열이 둘(ko / multilingual)이 된 뒤로 "엔진이 쓰는 정적 프롬프트" 도 둘이다.
 * 이 모듈은 그 값을 한곳에서 노출만 한다. 실제 수집·hash·버전 기록은
 * `engine-version.js`(다른 소유자)가 하며 이 모듈은 그것을 import 하지 않는다.
 *
 * 담는 것 / 담지 않는 것:
 *   - 담는다: 계열별 정적 system 지시문. arc·작가 override·작품 데이터가 없는 상태.
 *   - 담지 않는다: 작품 데이터(인물/세계관/기획/요약), 목표 언어 태그, 작품별 분량
 *     수치. 캡처 컨텍스트(`promptFamilyCaptureContext`)가 `explicit:false` 라서
 *     언어 지시문 줄 자체가 붙지 않는다 — 같은 계열이면 작품과 무관하게 같은 값이다.
 *   - 포맷 정책(`dialogueBreakMode`)이 문구를 바꾸는 단계(draft/revise/rewrite)는
 *     **계열 기본 모드**(ko=strict / 비ko=natural)로 캡처한다. 승인된 다른 모드는
 *     작품별 값이므로 정적 manifest 에 들어가지 않는다.
 *
 * 두 개의 표면을 나눠 노출한다:
 *   - `captureStaticPromptManifest()` — MCP/플러그인 실행 경로가 실제로 부르는
 *     **live** step 들. step id 는 `providers.complete({step})` 값과 같은 기계 값이다.
 *   - `capturePublicPromptManifest()` — `engine/src/index.js` 가 re-export 하는
 *     **public** 프롬프트 표면(`prompts/*.js`). 미사용이어도 호환 유지 대상이라
 *     같은 방식으로 캡처한다. live 와 id 가 겹치므로 맵을 분리한다.
 *
 * ko 값은 기존 hash 입력과 동일하다(`CHAPTER_PLAN_STATIC`, `REVISE_SYSTEM` 등).
 * 다국어 계열 값을 manifest 에 함께 기록할지, 계열별로 분리해 기록할지는 수집 측
 * (`engine-version.js`) 결정이다.
 */
import { PROMPT_FAMILIES, PROMPT_FAMILY_KO, PROMPT_FAMILY_MULTILINGUAL, } from '../../../core/language-policy.js';
import { publicCastDesignSystemStatic } from '../prompts/cast-design.js';
import { publicDraftSystemStatic } from '../prompts/draft.js';
import { reviseFoundationSystemStatic } from '../prompts/revise-foundation.js';
import { revisePatchSystemStatic, reviseSystemStatic } from '../prompts/revise.js';
import { rewriteSystemStatic } from '../prompts/rewrite.js';
import { publicWorldbuildSystemStatic } from '../prompts/worldbuild.js';
import { castDesignSystemStatic } from './cast-design.js';
import { chapterPlanStatic } from './chapter-plan.js';
import { chapterSummaryStatic } from './chapter-summary.js';
import { coherenceJudgeStatic } from './coherence-judge.js';
import { draftSystemStatic } from './draft.js';
import { entitySeedStatic } from './entity-seed.js';
import { nextArcProposalStatic } from './next-arc-proposal.js';
import { worldbuildSystemStatic } from './worldbuild.js';

/** live step id → 계열별 정적 system 프롬프트 캡처 함수. step id 는 기계 값이다. */
const STATIC_PROMPT_CAPTURES = Object.freeze({
    'cast-design': castDesignSystemStatic,
    'chapter-plan': chapterPlanStatic,
    'chapter-summary': chapterSummaryStatic,
    'coherence-judge': coherenceJudgeStatic,
    draft: draftSystemStatic,
    'entity-seed': entitySeedStatic,
    'next-arc-proposal': nextArcProposalStatic,
    revise: reviseSystemStatic,
    // patch 모드는 같은 `step:'revise'` 요청의 다른 system 이라 별도 id 로 캡처한다.
    'revise-patch': revisePatchSystemStatic,
    'revise-foundation': reviseFoundationSystemStatic,
    rewrite: rewriteSystemStatic,
    worldbuild: worldbuildSystemStatic,
});

/**
 * public(비-live) 프롬프트 표면 id → 캡처 함수.
 *
 * `prompts/{draft,worldbuild,cast-design}.js` 의 `*_SYSTEM` 은 실행 경로가 부르지
 * 않는 **별도 문자열**이다(live 는 `steps/*.js` 의 자체 builder). 공개 export 라
 * 호환 유지 대상이므로 여기서 따로 캡처한다.
 *
 * `revise` / `revise-patch` / `rewrite` / `revise-foundation` 은 prompts 모듈이
 * 곧 live 표면이라 live 맵에만 있다(같은 문자열을 두 번 hash 하지 않는다).
 */
const PUBLIC_PROMPT_CAPTURES = Object.freeze({
    'cast-design': publicCastDesignSystemStatic,
    draft: publicDraftSystemStatic,
    worldbuild: publicWorldbuildSystemStatic,
});

/** 수집 대상 live step id 목록(정렬 고정 — 수집 순서가 hash 를 흔들지 않게). */
export const STATIC_PROMPT_STEPS = Object.freeze(Object.keys(STATIC_PROMPT_CAPTURES).sort());
/** 수집 대상 public 프롬프트 id 목록(정렬 고정). */
export const PUBLIC_PROMPT_SURFACES = Object.freeze(Object.keys(PUBLIC_PROMPT_CAPTURES).sort());

function captureAll(captures, ids) {
    const out = {};
    for (const id of ids) {
        const capture = captures[id];
        out[id] = Object.freeze({
            [PROMPT_FAMILY_KO]: capture(PROMPT_FAMILY_KO),
            [PROMPT_FAMILY_MULTILINGUAL]: capture(PROMPT_FAMILY_MULTILINGUAL),
        });
    }
    return Object.freeze(out);
}

function captureFamily(captures, ids, family, fnName) {
    if (!PROMPT_FAMILIES.includes(family))
        throw new TypeError(`${fnName}: unknown prompt family '${String(family)}'`);
    const out = {};
    for (const id of ids)
        out[id] = captures[id](family);
    return Object.freeze(out);
}

/**
 * live step 의 계열별 정적 프롬프트 캡처 맵.
 *
 * @returns {Readonly<Record<string, Readonly<Record<'ko'|'multilingual', string>>>>}
 */
export function captureStaticPromptManifest() {
    return captureAll(STATIC_PROMPT_CAPTURES, STATIC_PROMPT_STEPS);
}

/** 한 계열만 필요한 수집기를 위한 평면 맵(live). */
export function captureStaticPromptFamily(family) {
    return captureFamily(STATIC_PROMPT_CAPTURES, STATIC_PROMPT_STEPS, family, 'captureStaticPromptFamily');
}

/** public 프롬프트 표면의 계열별 캡처 맵. live 맵과 id 공간이 분리돼 있다. */
export function capturePublicPromptManifest() {
    return captureAll(PUBLIC_PROMPT_CAPTURES, PUBLIC_PROMPT_SURFACES);
}

/** 한 계열만 필요한 수집기를 위한 평면 맵(public). */
export function capturePublicPromptFamily(family) {
    return captureFamily(PUBLIC_PROMPT_CAPTURES, PUBLIC_PROMPT_SURFACES, family, 'capturePublicPromptFamily');
}
