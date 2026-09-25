/**
 * 프롬프트 계열 선택기 (다국어 Phase 2A, 플러그인 계층).
 *
 * 한 곳에서만 계열을 고른다: base language 가 ko 면 한국어 특화 계열, 그 외(영어
 * 포함)는 영어 기반 다국어 계열이다. 판정 자체는 전부
 * `engine/src/core/language-policy.js` 가 하며 이 모듈은 저장된 계약을 그 API 로
 * 넘기고 결과를 프롬프트 조립에 연결한다.
 *
 * 규칙:
 * - ko 계열은 기존 한국어 작법 텍스트와 예시를 그대로 쓴다. 한국어 프롬프트에 목표
 *   언어 한 줄을 덧붙이는 구현은 설계에서 반려됐다. (phase 3 이 출력 언어 계약을
 *   붙이면 ko 요청도 달라질 수 있다. 여기서 약속하는 것은 작법 텍스트·예시의 보존
 *   뿐이며 "언제나 바이트 동일" 이 아니다.)
 * - 다국어 계열은 영어 템플릿 + `buildLanguageDirective()` 가 검증된 값으로만
 *   조립한 목표 언어 지시문이다. 사용자 자유 텍스트는 지시문에 들어가지 않는다.
 * - 분량 지시는 **승인·명시된 값이 있을 때만** 붙인다. 언어 기본값을 프롬프트에
 *   주입하지 않는다.
 * - 언어 신호가 둘 이상이면 조용히 우선순위로 고르지 않는다. 서로 다르면 공유
 *   resolver 가 `WORK_LANGUAGE_IMMUTABLE`/`LANGUAGE_SELECTION_REQUIRED` 로 거부한다.
 *   키가 있는데 값이 비었으면 `INVALID_LANGUAGE_TAG` 다(부재와 구분한다).
 */
import {
  IMPLICIT_LEGACY_LANGUAGE,
  LANGUAGE_ERROR_CODES,
  LanguagePolicyError,
  PROMPT_FAMILY_KO,
  PROMPT_FAMILY_MULTILINGUAL,
  buildLanguageContract,
  buildLanguageDirective,
  normalizeLanguageTag,
  resolveExistingWorkLanguage,
} from '../../engine/src/core/language-policy.js';
import { readStoredLanguage } from '../core/work-language.js';

import * as koFamily from './ko.js';
import * as multilingualFamily from './multilingual.js';

const FAMILIES = Object.freeze({
  [PROMPT_FAMILY_KO]: koFamily,
  [PROMPT_FAMILY_MULTILINGUAL]: multilingualFamily,
});

export const PROMPT_STEPS = Object.freeze(Object.keys(koFamily.steps));

/**
 * 키가 실제로 전달됐는가. `undefined` 는 JSON 왕복에서 사라지는 값이므로 부재로
 * 보고, `null`/`''` 은 **전달된 잘못된 값**이므로 공유 resolver 가 거부하게 둔다.
 */
const provided = (source, key) => Object.hasOwn(source, key) && source[key] !== undefined;

/** 문서에 기록된 언어. 키가 없던 구작은 "미설정" 이 아니라 암묵적 ko 다. */
function documentTag(doc, scope) {
  if (doc === null || typeof doc !== 'object') {
    throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'not_a_document', scope });
  }
  const stored = readStoredLanguage(doc);
  if (!stored.hasKey) {
    return { scope, tag: normalizeLanguageTag(IMPLICIT_LEGACY_LANGUAGE), hasLanguageKey: false };
  }
  if (stored.language === null) {
    throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'missing_stored_language', scope });
  }
  return { scope, tag: normalizeLanguageTag(stored.language), hasLanguageKey: true };
}

/**
 * 여러 언어 신호를 하나로 좁힌다. 이 함수는 판정을 새로 만들지 않고 공유
 * resolver 에 넘겨 거부하게 한다.
 *
 * - 저장 원천끼리 어긋나면 `WORK_LANGUAGE_IMMUTABLE`.
 * - 명시 `language` 와 저장 원천이 어긋나도 `WORK_LANGUAGE_IMMUTABLE`(구작의
 *   암묵적 ko 도 이미 선택된 언어이므로 비ko 로 조용히 라우팅하지 않는다).
 * - 명시 `family` 는 템플릿 선택일 뿐이며 해결된 계열과 어긋나면
 *   `LANGUAGE_SELECTION_REQUIRED`. 언어 없이 multilingual 만 고르는 것도 거부한다
 *   (검증된 목표 언어 지시문을 만들 수 없다).
 */
function resolveLanguageTag(source) {
  const carriers = [];
  if (provided(source, 'contract')) {
    if (source.contract === null || typeof source.contract !== 'object') {
      throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'not_a_contract', scope: 'contract' });
    }
    carriers.push({ scope: 'contract', tag: normalizeLanguageTag(source.contract.language), hasLanguageKey: true });
  }
  if (provided(source, 'creationRecord')) carriers.push(documentTag(source.creationRecord, 'creation-record'));
  if (provided(source, 'foundation')) carriers.push(documentTag(source.foundation, 'work'));
  if (provided(source, 'profile')) carriers.push(documentTag(source.profile, 'profile'));

  const stored = carriers[0] ?? null;
  for (const other of carriers.slice(1)) {
    // 저장된 원천끼리의 불일치도 조용한 우선순위 대체 대상이 아니다.
    resolveExistingWorkLanguage({
      requested: other.tag.tag,
      workLanguage: stored.tag.tag,
      workHasLanguageKey: stored.hasLanguageKey,
    });
  }

  if (!provided(source, 'language')) return stored?.tag ?? null;
  // 명시 값은 검증한다. `''`/`null` 은 부재가 아니라 잘못된 입력이다.
  const requested = normalizeLanguageTag(source.language);
  if (!stored) return requested;
  return resolveExistingWorkLanguage({
    requested: requested.tag,
    workLanguage: stored.tag.tag,
    workHasLanguageKey: stored.hasLanguageKey,
  }).language;
}

/**
 * 목표 언어 지시문. 분량 줄은 계약의 `lengthSource` 가 기본값이 아닐 때만 남긴다.
 * 슬롯 값(정수 목표, enum 단위)만으로 식별하므로 문구 변경에 흔들리지 않는다.
 */
function directiveLines(contract) {
  const directive = buildLanguageDirective(contract);
  const approvedLength = contract?.provenance?.lengthSource
    && contract.provenance.lengthSource !== 'default';
  if (approvedLength) return [...directive.system];
  const lengthFragment = `${directive.slots.lengthTarget} ${directive.slots.lengthUnit}`;
  return directive.system.filter((line) => !line.includes(lengthFragment));
}

/**
 * 단계별 프롬프트와 라벨을 제공하는 조립기.
 *
 * @param {{ contract?: object|null, language?: string|object|null,
 *           foundation?: object|null, profile?: object|null,
 *           creationRecord?: object|null, family?: string|null }} [source]
 *   아무 것도 주지 않으면 ko(구작의 암묵적 언어)로 해석한다.
 */
export function promptKit(source = {}) {
  const tag = resolveLanguageTag(source);
  const resolvedFamily = tag?.promptFamily ?? PROMPT_FAMILY_KO;
  if (provided(source, 'family')) {
    // family 는 내부 템플릿 선택일 뿐이다. 검증된 목표 언어를 덮거나 다국어 요청의
    // 언어 지시문을 조용히 없애는 통로로 쓰지 않는다.
    if (!FAMILIES[source.family]) {
      throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LANGUAGE_SELECTION_REQUIRED, { reason: 'unknown_prompt_family', family: source.family ?? null });
    }
    if (source.family === PROMPT_FAMILY_MULTILINGUAL && !tag) {
      throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LANGUAGE_SELECTION_REQUIRED, { reason: 'multilingual_family_requires_language' });
    }
    if (source.family !== resolvedFamily) {
      throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LANGUAGE_SELECTION_REQUIRED, {
        reason: 'prompt_family_conflicts_with_language',
        family: source.family, resolved: resolvedFamily, language: tag?.tag ?? null,
      });
    }
  }
  const family = resolvedFamily;
  const pack = FAMILIES[family];
  // 계약이 없으면 해결된 태그만으로 세운다. 분량은 언어 기본값이 되고
  // `directiveLines()` 가 그 줄을 떨어뜨리므로 미승인 분량이 프롬프트에 새지 않는다.
  const contract = source.contract
    ?? (family === PROMPT_FAMILY_MULTILINGUAL && tag ? contractForLanguage(tag) : null);
  const directive = family === PROMPT_FAMILY_KO || !contract
    ? []
    : directiveLines(contract);

  return Object.freeze({
    family,
    language: tag?.tag ?? contract?.language ?? null,
    contract,
    phrases: pack.phrases,
    directive: Object.freeze([...directive]),
    /** 단계의 system 메시지. 다국어 계열만 검증된 언어 지시문을 덧붙인다. */
    system(step) {
      const template = pack.steps[step];
      if (!template) throw new Error(`UNKNOWN_PROMPT_STEP: ${step}`);
      return [template.system, ...directive].join(' ');
    },
    /** 단계의 user 메시지. 작품 데이터는 호출자가 그대로 넘긴다. */
    user(step, context) {
      const template = pack.steps[step];
      if (!template) throw new Error(`UNKNOWN_PROMPT_STEP: ${step}`);
      return template.user(context ?? {});
    },
    /** provider 에 그대로 넘길 messages 쌍. */
    messages(step, context) {
      return [
        { role: 'system', content: this.system(step) },
        { role: 'user', content: this.user(step, context) },
      ];
    },
  });
}

/**
 * 저장소에서 작품 계약을 읽어 kit 을 만든다. 저수준 도구는 `loadFoundation` 이 없는
 * 최소 store 로도 호출되므로, 계약을 물어볼 수 없으면 문서 또는 구작의 암묵적 ko 로
 * 물러난다. 프롬프트 계열 때문에 기존 호출 형태를 깨지 않는다.
 */
export async function resolveWorkKit({ store, workId, foundation, profile, kit } = {}) {
  if (kit) return asKit(kit);
  if (store && typeof store.loadFoundation === 'function' && workId) {
    const { resolveWorkLanguage } = await import('../core/work-language.js');
    const resolved = await resolveWorkLanguage({ store, workId, ...(foundation === undefined ? {} : { foundation }) });
    return promptKit({ contract: resolved.contract });
  }
  return asKit({ foundation, profile });
}

/**
 * 렌더러의 선택적 두 번째 인자를 받아들인다. 이미 kit 이면 그대로 쓰고, 계약·언어·
 * 문서를 주면 kit 을 만든다. 아무 것도 없으면 구작의 암묵적 ko 다(기존 동작).
 */
export function asKit(value) {
  if (value && typeof value.system === 'function' && typeof value.phrases === 'object') return value;
  return promptKit(value ?? {});
}

/**
 * 계약이 필요한데 아직 없는 호출부를 위한 보조. 저장된 언어만 아는 경우에도
 * 지시문을 만들 수 있게 언어만으로 계약을 세운다. 분량은 언어 기본값이 되므로
 * `directiveLines()` 가 분량 줄을 떨어뜨린다.
 */
export function contractForLanguage(language) {
  const tag = normalizeLanguageTag(language);
  const cached = LANGUAGE_CONTRACT_CACHE.get(tag.tag);
  if (cached) return cached;
  const contract = buildLanguageContract({ language: tag, languageSource: 'requested' });
  LANGUAGE_CONTRACT_CACHE.set(tag.tag, contract);
  return contract;
}

/** 같은 태그의 합성 계약은 결정적이므로 렌더러가 반복 호출해도 다시 만들지 않는다. */
const LANGUAGE_CONTRACT_CACHE = new Map();

export { PROMPT_FAMILY_KO, PROMPT_FAMILY_MULTILINGUAL };
