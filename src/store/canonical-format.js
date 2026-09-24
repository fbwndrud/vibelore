/**
 * 정본 Markdown 의 형식 계약 (다국어 Phase 1).
 *
 * 여기서 정하는 것: 소유 표제의 두 벌(한국어 v1 / 영문 v2), 문서에 기록된 형식
 * 버전과 언어 키의 해석, 그리고 저장 전에 감지해야 하는 형식 충돌.
 *
 * 지키는 규칙:
 * - 형식 버전은 **문서에 기록된 값**이 정한다. 매 저장마다 locale 에서 추론하지
 *   않는다. v1 파서는 한국어 소유 표제만, v2 파서는 영문 소유 표제만 읽는다.
 * - 키가 없던 구작 문서는 키가 없는 채로 남는다. 실행 해석만 암묵적 ko/버전 1 이다.
 * - 같은 의미의 소유 표제가 두 언어로 함께 있으면 합치거나 덮어쓰지 않고
 *   `CANONICAL_SECTION_CONFLICT` 로 멈춘다.
 * - 예상 소유 표제가 사라지고 반대 언어 표제만 있으면 `CANONICAL_FORMAT_MISMATCH`
 *   로 보고하고 파일은 그대로 둔다.
 * - 생성 기록(accepted creation record)이 있는 작품에서 language/형식 버전 키를
 *   지우거나 바꾸는 것은 레거시로 돌아가는 방법이 아니라 계약 불일치다.
 */
import {
  CANONICAL_FORMAT_VERSION_LEGACY_KO,
  CANONICAL_FORMAT_VERSION_MULTILINGUAL,
} from '../../engine/src/core/language-policy.js';

export const CANONICAL_FORMAT_ERROR_CODES = Object.freeze({
  CANONICAL_SECTION_CONFLICT: 'CANONICAL_SECTION_CONFLICT',
  CANONICAL_FORMAT_MISMATCH: 'CANONICAL_FORMAT_MISMATCH',
  CANONICAL_FORMAT_CONTRACT_MISMATCH: 'CANONICAL_FORMAT_CONTRACT_MISMATCH',
  INVALID_CANONICAL_FORMAT_VERSION: 'INVALID_CANONICAL_FORMAT_VERSION',
  WORK_LANGUAGE_IMMUTABLE: 'WORK_LANGUAGE_IMMUTABLE',
  CREATION_RECORD_IMMUTABLE: 'CREATION_RECORD_IMMUTABLE',
});

/** 안정적인 `.code` 를 갖는 정본 형식 오류. 파일은 절대 건드리지 않은 상태로 던진다. */
export class CanonicalFormatError extends Error {
  constructor(code, details = {}) {
    super(`${code}: ${JSON.stringify(details)}`);
    this.name = 'CanonicalFormatError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * 여섯 쌍으로 고정한 소유 표제. 표시 언어마다 표제를 추가하지 않는다.
 * key 는 의미 식별자이며 파일에는 언어별 표제만 나타난다.
 */
export const CANONICAL_HEADINGS = Object.freeze({
  [CANONICAL_FORMAT_VERSION_LEGACY_KO]: Object.freeze({
    worldFacts: '세계 사실',
    contradiction: '모순',
    description: '설명',
    dramaticModel: '극적 모델',
    speechProfile: '말투 프로필',
    summary: '요약',
  }),
  [CANONICAL_FORMAT_VERSION_MULTILINGUAL]: Object.freeze({
    worldFacts: 'World facts',
    contradiction: 'Contradiction',
    description: 'Description',
    dramaticModel: 'Dramatic model',
    speechProfile: 'Speech profile',
    summary: 'Summary',
  }),
});

export const SETTING_SECTION_KEYS = Object.freeze(['worldFacts']);
export const CHARACTER_SECTION_KEYS = Object.freeze(['contradiction', 'description', 'dramaticModel', 'speechProfile']);
/** summaries/NNN.md 의 소유 표제. */
export const SUMMARY_SECTION_KEYS = Object.freeze(['summary']);

export const CANONICAL_FORMAT_VERSIONS = Object.freeze([
  CANONICAL_FORMAT_VERSION_LEGACY_KO,
  CANONICAL_FORMAT_VERSION_MULTILINGUAL,
]);

/** 문서 frontmatter 가 소유하는 형식 키. 저장 시 사용자 키와 섞이지 않게 한다. */
export const CANONICAL_FORMAT_KEYS = Object.freeze(['language', 'canonicalFormatVersion']);

export function headingsFor(version) {
  const table = CANONICAL_HEADINGS[version];
  if (!table) throw new CanonicalFormatError(CANONICAL_FORMAT_ERROR_CODES.INVALID_CANONICAL_FORMAT_VERSION, { version });
  return table;
}

/** 두 계열의 소유 표제 전부. preserveForeignSections 가 사용자 섹션만 남기도록 쓴다. */
export function allOwnedHeadings(keys) {
  const out = [];
  for (const version of CANONICAL_FORMAT_VERSIONS) {
    for (const key of keys) out.push(CANONICAL_HEADINGS[version][key]);
  }
  return out;
}

function documentHeadings(body) {
  const found = new Set();
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const m = /^##\s+(.*)$/.exec(line.trim());
    if (m) found.add(m[1].trim());
  }
  return found;
}

/**
 * 문서에 실제로 기록된 언어/형식 키를 읽는다. 값이 없다는 사실(`*Present:false`)을
 * 그대로 보고하는 것이 이 함수의 목적이다.
 */
export function readDocumentFormatKeys(data, context = {}) {
  const languageKeyPresent = Object.hasOwn(data ?? {}, 'language');
  const formatVersionKeyPresent = Object.hasOwn(data ?? {}, 'canonicalFormatVersion');
  const rawVersion = formatVersionKeyPresent ? Number(data.canonicalFormatVersion) : null;
  if (formatVersionKeyPresent && !CANONICAL_FORMAT_VERSIONS.includes(rawVersion)) {
    throw new CanonicalFormatError(CANONICAL_FORMAT_ERROR_CODES.INVALID_CANONICAL_FORMAT_VERSION, {
      ...context, stored: data.canonicalFormatVersion ?? null,
    });
  }
  const language = languageKeyPresent && data.language !== '' && data.language !== null
    ? String(data.language)
    : null;
  if (languageKeyPresent && language === null) {
    throw new CanonicalFormatError(CANONICAL_FORMAT_ERROR_CODES.WORK_LANGUAGE_IMMUTABLE, {
      ...context, reason: 'empty_language_key',
    });
  }
  return { language, languageKeyPresent, canonicalFormatVersion: rawVersion, formatVersionKeyPresent };
}

/**
 * 문서의 형식 계약을 확정한다.
 *
 * `contract` 는 이 작품의 수락된 생성 기록(`{ language, canonicalFormatVersion }`)
 * 이거나 null 이다. 기록이 있으면 language/형식 버전 키의 삭제·변경은 레거시
 * 복귀가 아니라 계약 불일치다. 기록이 없는 구작은 키의 부재를 그대로 보존하고
 * 실행 해석만 암묵적 ko + 버전 1 이다.
 */
export function resolveDocumentFormat({ data, contract = null, doc }) {
  const keys = readDocumentFormatKeys(data, { doc });
  if (contract) {
    if (!keys.formatVersionKeyPresent || keys.canonicalFormatVersion !== contract.canonicalFormatVersion) {
      throw new CanonicalFormatError(CANONICAL_FORMAT_ERROR_CODES.CANONICAL_FORMAT_CONTRACT_MISMATCH, {
        doc,
        expected: contract.canonicalFormatVersion,
        stored: keys.formatVersionKeyPresent ? keys.canonicalFormatVersion : null,
        reason: keys.formatVersionKeyPresent ? 'version_changed' : 'version_key_removed',
      });
    }
    if (!keys.languageKeyPresent || keys.language !== contract.language) {
      throw new CanonicalFormatError(CANONICAL_FORMAT_ERROR_CODES.WORK_LANGUAGE_IMMUTABLE, {
        doc,
        expected: contract.language,
        stored: keys.languageKeyPresent ? keys.language : null,
        reason: keys.languageKeyPresent ? 'language_changed' : 'language_key_removed',
      });
    }
    return { ...keys, canonicalFormatVersion: contract.canonicalFormatVersion, language: contract.language, source: 'creation-record' };
  }
  if (keys.formatVersionKeyPresent) return { ...keys, source: 'document' };
  return {
    ...keys,
    canonicalFormatVersion: CANONICAL_FORMAT_VERSION_LEGACY_KO,
    source: 'legacy-implicit',
  };
}

/**
 * 저장 전 검증. 파일을 고치기 전에 전부 확인하기 위해 분리했다.
 * - 같은 의미의 표제가 두 언어로 있으면 `CANONICAL_SECTION_CONFLICT`.
 * - 예상 표제 없이 반대 언어 표제만 있으면 `CANONICAL_FORMAT_MISMATCH`.
 */
export function assertCanonicalSections({ body, version, keys, doc }) {
  const owned = headingsFor(version);
  const other = headingsFor(version === CANONICAL_FORMAT_VERSION_LEGACY_KO
    ? CANONICAL_FORMAT_VERSION_MULTILINGUAL
    : CANONICAL_FORMAT_VERSION_LEGACY_KO);
  const present = documentHeadings(body);
  const mismatched = [];
  for (const key of keys) {
    const hasOwn = present.has(owned[key]);
    const hasOther = present.has(other[key]);
    if (hasOwn && hasOther) {
      throw new CanonicalFormatError(CANONICAL_FORMAT_ERROR_CODES.CANONICAL_SECTION_CONFLICT, {
        doc, version, section: key, headings: [owned[key], other[key]],
      });
    }
    if (!hasOwn && hasOther) mismatched.push({ section: key, expected: owned[key], found: other[key] });
  }
  if (mismatched.length > 0) {
    throw new CanonicalFormatError(CANONICAL_FORMAT_ERROR_CODES.CANONICAL_FORMAT_MISMATCH, {
      doc, version, sections: mismatched,
    });
  }
}

/**
 * frontmatter 에 언어/형식 키를 쓸지 결정한다.
 *
 * "소유 키로 등록한다" 는 구작의 첫 쓰기에 키를 추가한다는 뜻이 아니다. 키가
 * 원래 있던 문서와, 생성 기록을 가진 작품에서 이번에 새로 만드는 문서에만 쓴다.
 */
export function formatKeysToWrite({ priorData, exists, contract }) {
  const hadLanguage = exists && Object.hasOwn(priorData ?? {}, 'language');
  const hadVersion = exists && Object.hasOwn(priorData ?? {}, 'canonicalFormatVersion');
  if (!contract) {
    // 구작: 원래 있던 키만 그대로 유지한다. 없던 키를 새로 넣지 않는다.
    if (!hadLanguage && !hadVersion) return {};
    return {
      ...(hadLanguage ? { language: priorData.language } : {}),
      ...(hadVersion ? { canonicalFormatVersion: priorData.canonicalFormatVersion } : {}),
    };
  }
  return { language: contract.language, canonicalFormatVersion: contract.canonicalFormatVersion };
}
