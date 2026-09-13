/**
 * validation-contract — 발행 게이트가 공유하는 하나의 결정적 검증기 (다국어 Phase 3).
 *
 * 여기서 정하는 것: 발행 산출물 묶음의 정본화와 hash, 구조화된 `languageCompliance`
 * 판정의 검증, 필수 불변식 coverage 의 **별도** 검증, 검사 영수증과 승인의 결합 확인.
 * `workflow.js` / `check.js` / `sync.js` 가 발급하고 `commit.js` / workflow 승인 /
 * sync apply 가 소비하는 값이 전부 이 모듈을 지난다.
 *
 * 여기서 하지 않는 것: provider 호출, 파일 IO, 영수증 저장, 요약·delta 생성,
 * 문자 비율·문자 체계 추정, 실행하지 않은 검사의 통과 합성. 판정 근거가 없으면
 * 성공을 만들지 않고 안정적인 `.code` 를 가진 오류를 던진다.
 *
 * 언어 태그와 승인된 인용 예외의 구문 계약은 `language-policy.js` 가 유일한 결정
 * 지점이며(두 번째 resolver 를 만들지 않는다), wildcard 예외는 기존
 * `normalizeLanguageExceptions()` 가 그대로 거부한다. 검사 계획과 coverage 값의
 * 의미는 `continuity/checker-registry.js` 가 소유하고 이 모듈은 **판정만** 한다.
 */
import { createHash } from 'node:crypto';
import {
    computeLanguageContractHash,
    normalizeLanguageExceptions,
    normalizeLanguageTag,
} from './language-policy.js';

export const VALIDATION_CONTRACT_SCHEMA_VERSION = 1;
export const ARTIFACT_SCHEMA_VERSION = 1;
/** 영수증 재사용 키의 일부. 다른 버전이 발급한 영수증은 소비하지 않는다. */
export const VALIDATOR_VERSION = 'validation-contract-v1';

/** 모델이 돌려주는 판정. 영수증의 판정(`passed`)과 다른 축이다. */
export const VALIDATION_VERDICTS = Object.freeze(['pass', 'fail', 'uncertain']);
export const RECEIPT_VERDICT_PASSED = 'passed';

export const ARTIFACT_FIELDS = Object.freeze(['prose', 'title', 'summary', 'semanticDelta', 'castManifestRaw']);
/** 작품 언어 계약이 적용되는 발행 값. */
export const LANGUAGE_SCOPED_ARTIFACT_FIELDS = Object.freeze(['prose', 'title', 'summary', 'semanticDelta']);
/** 기계 계약(키·ID·enum). 언어 판정의 근거가 될 수 없다. */
export const MACHINE_EXEMPT_ARTIFACT_FIELDS = Object.freeze(['castManifestRaw']);

/** 계획이 이들을 필수에서 빼면 계획 자체가 잘못된 것이다. 가짜 통과를 막는다. */
export const ALWAYS_MANDATORY_INVARIANTS = Object.freeze(['SCHEMA', 'LENGTH', 'OUTPUT_LANGUAGE']);
/** 등록표의 coverage 값 + 실제로 들어올 수 있는 미완료 상태. */
export const COVERAGE_VALUES = Object.freeze([
    'validated', 'unvalidated', 'not_applicable', 'failed', 'uncertain', 'error',
]);

export const VALIDATION_ERROR_CODES = Object.freeze({
    INVALID_ARTIFACT_BUNDLE: 'INVALID_ARTIFACT_BUNDLE',
    UNKNOWN_ARTIFACT_FIELD: 'UNKNOWN_ARTIFACT_FIELD',
    NON_SERIALIZABLE_ARTIFACT_VALUE: 'NON_SERIALIZABLE_ARTIFACT_VALUE',
    INVALID_LANGUAGE_COMPLIANCE: 'INVALID_LANGUAGE_COMPLIANCE',
    ARTIFACT_HASH_MISMATCH: 'ARTIFACT_HASH_MISMATCH',
    INCOMPLETE_LANGUAGE_EVIDENCE: 'INCOMPLETE_LANGUAGE_EVIDENCE',
    UNAPPROVED_LANGUAGE_EXCEPTION: 'UNAPPROVED_LANGUAGE_EXCEPTION',
    LANGUAGE_TARGET_MISMATCH: 'LANGUAGE_TARGET_MISMATCH',
    INVALID_CHECKER_PLAN: 'INVALID_CHECKER_PLAN',
    INVALID_COVERAGE_REPORT: 'INVALID_COVERAGE_REPORT',
    COVERAGE_INCOMPLETE: 'COVERAGE_INCOMPLETE',
    OUTPUT_LANGUAGE_MISMATCH: 'OUTPUT_LANGUAGE_MISMATCH',
    VALIDATION_INCOMPLETE: 'VALIDATION_INCOMPLETE',
    MISSING_VALIDATION_RECEIPT: 'MISSING_VALIDATION_RECEIPT',
    INVALID_RECEIPT: 'INVALID_RECEIPT',
    INCOMPLETE_EXPECTATION: 'INCOMPLETE_EXPECTATION',
    RECEIPT_IDENTITY_MISMATCH: 'RECEIPT_IDENTITY_MISMATCH',
    CONTRACT_HASH_MISMATCH: 'CONTRACT_HASH_MISMATCH',
    LANGUAGE_COMPLIANCE_HASH_MISMATCH: 'LANGUAGE_COMPLIANCE_HASH_MISMATCH',
    COVERAGE_HASH_MISMATCH: 'COVERAGE_HASH_MISMATCH',
    STALE_VALIDATION_RECEIPT: 'STALE_VALIDATION_RECEIPT',
    RECEIPT_ALREADY_CONSUMED: 'RECEIPT_ALREADY_CONSUMED',
    VALIDATOR_VERSION_MISMATCH: 'VALIDATOR_VERSION_MISMATCH',
    INVALID_APPROVAL_BINDING: 'INVALID_APPROVAL_BINDING',
});

/**
 * 정적 사용자 안내 문구. 구체적인 값은 `err.details` 로만 전달하며 문구에 사용자
 * 입력이나 모델 출력을 끼워 넣지 않는다.
 */
const VALIDATION_ERROR_MESSAGES = Object.freeze({
    INVALID_ARTIFACT_BUNDLE: {
        ko: '발행 산출물 묶음이 올바르지 않다. 필수 값이 빠지면 빈 값으로 대신하지 않는다.',
        en: 'The publication artifact bundle is invalid. A missing required value is not silently empty.',
    },
    UNKNOWN_ARTIFACT_FIELD: {
        ko: '계약에 없는 산출물 필드가 있다. 발행 값을 hash 밖에 둘 수 없다.',
        en: 'The bundle contains a field outside the contract. Publishable values cannot sit outside the hash.',
    },
    NON_SERIALIZABLE_ARTIFACT_VALUE: {
        ko: '결정적으로 직렬화할 수 없는 값이 산출물에 있다.',
        en: 'The bundle contains a value that cannot be serialized deterministically.',
    },
    INVALID_LANGUAGE_COMPLIANCE: {
        ko: '출력 언어 판정의 형식이 올바르지 않다. 이는 판정 성공이 아니다.',
        en: 'The output-language judgment is malformed. This is not a successful judgment.',
    },
    ARTIFACT_HASH_MISMATCH: {
        ko: '판정이 가리키는 산출물이 실제로 결합된 묶음과 다르다.',
        en: 'The judgment refers to a different artifact than the bound bundle.',
    },
    INCOMPLETE_LANGUAGE_EVIDENCE: {
        ko: '출력 언어 판정의 근거가 불완전하다. 실패에는 실제 필드의 인용과 사유가 필요하다.',
        en: 'The output-language evidence is incomplete. A failure needs a real in-field quote and a reason.',
    },
    UNAPPROVED_LANGUAGE_EXCEPTION: {
        ko: '판정이 승인되지 않은 인용 예외를 주장한다.',
        en: 'The judgment claims a language exception that was never approved.',
    },
    LANGUAGE_TARGET_MISMATCH: {
        ko: '판정의 대상 언어가 작품의 목표 언어와 다르다.',
        en: 'The judgment targets a different language than the work contract.',
    },
    INVALID_CHECKER_PLAN: {
        ko: '검사 계획이 올바르지 않다. 필수 불변식 집합은 등록된 계획에서만 나온다.',
        en: 'The checker plan is invalid. The mandatory invariant set comes only from a registered plan.',
    },
    INVALID_COVERAGE_REPORT: {
        ko: '불변식 coverage 보고의 형식이 올바르지 않다.',
        en: 'The invariant coverage report is malformed.',
    },
    COVERAGE_INCOMPLETE: {
        ko: '필수 불변식이 검증되지 않았다. 검사 완료로 처리하지 않는다.',
        en: 'A mandatory invariant is not validated. The check is not complete.',
    },
    OUTPUT_LANGUAGE_MISMATCH: {
        ko: '출력 언어 계약 위반이 확인됐다.',
        en: 'An output-language contract violation was confirmed.',
    },
    VALIDATION_INCOMPLETE: {
        ko: '검증이 완료되지 않았다. 미검증 항목이 남아 있다.',
        en: 'Validation is incomplete. Unvalidated items remain.',
    },
    MISSING_VALIDATION_RECEIPT: {
        ko: '검사 영수증이 없다. 발행 전에 검사를 거쳐야 한다.',
        en: 'The validation receipt is missing. The artifact must be checked before publication.',
    },
    INVALID_RECEIPT: {
        ko: '검사 영수증의 형식이 올바르지 않거나 신원 값이 위조됐다.',
        en: 'The validation receipt is malformed or its identity was forged.',
    },
    INCOMPLETE_EXPECTATION: {
        ko: '확인해야 할 기대 신원 값이 빠졌다. 확인하지 않은 값을 통과로 처리하지 않는다.',
        en: 'A required expectation is missing. Unverified values are not treated as verified.',
    },
    RECEIPT_IDENTITY_MISMATCH: {
        ko: '검사 영수증이 다른 작업·화·원천·계획에 속한다.',
        en: 'The receipt belongs to a different work, chapter, source or plan.',
    },
    CONTRACT_HASH_MISMATCH: {
        ko: '핀된 작업 계약 hash 가 현재 계약과 다르다.',
        en: 'The pinned work-contract hash differs from the current contract.',
    },
    LANGUAGE_COMPLIANCE_HASH_MISMATCH: {
        ko: '결합된 출력 언어 판정이 영수증의 판정과 다르다.',
        en: 'The bound output-language judgment differs from the one in the receipt.',
    },
    COVERAGE_HASH_MISMATCH: {
        ko: '결합된 불변식 coverage 가 영수증의 coverage 와 다르다.',
        en: 'The bound invariant coverage differs from the one in the receipt.',
    },
    STALE_VALIDATION_RECEIPT: {
        ko: '오래된 검사 영수증이다. 값이 원래대로 돌아와도 부활하지 않으며 새 epoch 로 재검사한다.',
        en: 'The receipt is stale. Reverting values does not revive it; re-validate under a new epoch.',
    },
    RECEIPT_ALREADY_CONSUMED: {
        ko: '이미 소비된 검사 영수증이다.',
        en: 'The validation receipt was already consumed.',
    },
    VALIDATOR_VERSION_MISMATCH: {
        ko: '다른 검증기 버전이 발급한 영수증이다.',
        en: 'The receipt was issued by a different validator version.',
    },
    INVALID_APPROVAL_BINDING: {
        ko: '승인이 해당 검사에 묶여 있지 않다.',
        en: 'The approval is not bound to this validation.',
    },
});

/** 결정적 오류. `.code` 는 안정적인 계약이며 호스트가 그대로 노출할 수 있다. */
export class ValidationContractError extends Error {
    constructor(code, details = {}) {
        const messages = VALIDATION_ERROR_MESSAGES[code] ?? { ko: code, en: code };
        super(messages.en);
        this.name = 'ValidationContractError';
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.messages = Object.freeze({ ...messages });
    }
}

function fail(code, details) {
    throw new ValidationContractError(code, details);
}

// ─── 결정적 직렬화 ──────────────────────────────────────────────────────────

function compareCodePoints(a, b) {
    if (a === b)
        return 0;
    return a < b ? -1 : 1;
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/** hash 전용 직렬화. 키는 코드 포인트 순, 배열 순서는 데이터이므로 보존한다. */
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort(compareCodePoints);
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;

// ─── 정본 산출물 묶음 ───────────────────────────────────────────────────────

/**
 * 산출물 값의 정규화 겸 검증. 결정적으로 직렬화할 수 없는 값은 조용히 버리지 않고
 * 경로와 함께 거부한다. 문자열은 NFC 로 통일해 같은 원고가 인코딩 차이로 다른
 * hash 가 되지 않게 한다.
 */
function canonicalValue(value, path, seen) {
    if (typeof value === 'string')
        return value.normalize('NFC');
    if (typeof value === 'boolean' || value === null)
        return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            fail(VALIDATION_ERROR_CODES.NON_SERIALIZABLE_ARTIFACT_VALUE, { path, reason: 'non_finite_number' });
        return value;
    }
    if (Array.isArray(value) || isPlainObject(value)) {
        if (seen.has(value))
            fail(VALIDATION_ERROR_CODES.NON_SERIALIZABLE_ARTIFACT_VALUE, { path, reason: 'circular_reference' });
        seen.add(value);
        let out;
        if (Array.isArray(value)) {
            out = Object.freeze(value.map((item, index) => canonicalValue(item, `${path}[${index}]`, seen)));
        }
        else {
            const result = {};
            for (const key of Object.keys(value).sort(compareCodePoints)) {
                const child = value[key];
                if (child === undefined)
                    fail(VALIDATION_ERROR_CODES.NON_SERIALIZABLE_ARTIFACT_VALUE, {
                        path: `${path}.${key}`,
                        reason: 'undefined_value',
                    });
                result[key] = canonicalValue(child, `${path}.${key}`, seen);
            }
            out = Object.freeze(result);
        }
        seen.delete(value);
        return out;
    }
    fail(VALIDATION_ERROR_CODES.NON_SERIALIZABLE_ARTIFACT_VALUE, { path, reason: 'unsupported_type', received: typeof value });
    return null;
}

function requiredText(value, field) {
    if (typeof value !== 'string')
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { field, reason: 'not_a_string', received: typeof value });
    const text = value.normalize('NFC').trim();
    if (text === '')
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { field, reason: 'empty_required_field' });
    return text;
}

function isEmptyContainer(value) {
    return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
}

/**
 * 발행 직전 묶음의 정본화. `prose` 만이 아니라 제목·요약·의미 delta·cast manifest 를
 * 함께 묶는다. 누락은 빈 값이 아니라 오류이며, 계약에 없는 키는 hash 밖의 발행 값을
 * 만들지 않도록 거부한다. 요약을 자동 생성하지 않는다.
 *
 * @param {{ prose: string, title: string, summary: string|object|Array,
 *           semanticDelta: object|Array, castManifestRaw: string|object|Array }} bundle
 */
export function canonicalArtifact(bundle) {
    if (!isPlainObject(bundle))
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { reason: 'not_an_object', received: bundle === null ? 'null' : typeof bundle });

    const allowed = new Set([...ARTIFACT_FIELDS, 'artifactSchemaVersion']);
    for (const key of Object.keys(bundle)) {
        if (!allowed.has(key))
            fail(VALIDATION_ERROR_CODES.UNKNOWN_ARTIFACT_FIELD, { field: key });
    }
    if (Object.hasOwn(bundle, 'artifactSchemaVersion') && bundle.artifactSchemaVersion !== ARTIFACT_SCHEMA_VERSION)
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
            reason: 'unknown_artifact_schema_version',
            received: bundle.artifactSchemaVersion ?? null,
        });
    for (const field of ARTIFACT_FIELDS) {
        if (!Object.hasOwn(bundle, field) || bundle[field] === undefined || bundle[field] === null)
            fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { reason: 'missing_required_field', field });
    }

    const prose = requiredText(bundle.prose, 'prose');
    const title = requiredText(bundle.title, 'title');

    let summary;
    if (typeof bundle.summary === 'string') {
        summary = requiredText(bundle.summary, 'summary');
    }
    else if (Array.isArray(bundle.summary) || isPlainObject(bundle.summary)) {
        if (isEmptyContainer(bundle.summary))
            fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { field: 'summary', reason: 'empty_required_field' });
        summary = canonicalValue(bundle.summary, 'summary', new Set());
    }
    else {
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { field: 'summary', reason: 'invalid_type', received: typeof bundle.summary });
    }

    // delta 와 manifest 는 "명시적으로 비어 있음" 이 정당한 값이다. 키 자체의 부재만 오류다.
    if (!Array.isArray(bundle.semanticDelta) && !isPlainObject(bundle.semanticDelta))
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
            field: 'semanticDelta', reason: 'invalid_type', received: typeof bundle.semanticDelta,
        });
    const semanticDelta = canonicalValue(bundle.semanticDelta, 'semanticDelta', new Set());

    let castManifestRaw;
    if (typeof bundle.castManifestRaw === 'string')
        castManifestRaw = requiredText(bundle.castManifestRaw, 'castManifestRaw');
    else if (Array.isArray(bundle.castManifestRaw) || isPlainObject(bundle.castManifestRaw))
        castManifestRaw = canonicalValue(bundle.castManifestRaw, 'castManifestRaw', new Set());
    else
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
            field: 'castManifestRaw', reason: 'invalid_type', received: typeof bundle.castManifestRaw,
        });

    return Object.freeze({
        artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
        prose,
        title,
        summary,
        semanticDelta,
        castManifestRaw,
    });
}

/** 묶음이든 정본 산출물이든 같은 canonical JSON 을 만든다(멱등). */
export function canonicalizeArtifact(input) {
    return canonicalJson(canonicalArtifact(input));
}

/**
 * 항상 다시 정규화해서 계산한다. 입력에 hash 필드를 넣어 파생 hash 를 위조할 수
 * 없으며(계약 밖 키는 거부), 제목·요약·delta·manifest 중 무엇이 바뀌어도 값이 바뀐다.
 */
export function computeArtifactHash(input) {
    return sha256(canonicalizeArtifact(input));
}

// ─── 출력 언어 판정 ─────────────────────────────────────────────────────────

const COMPLIANCE_KEYS = new Set(['verdict', 'artifactHash', 'evidence', 'allowedExceptions', 'language', 'notes']);
const EVIDENCE_KEYS = new Set(['fieldPath', 'quote', 'reason']);
const EXCEPTION_KEYS = new Set(['kind', 'language', 'scope', 'rationale']);

function parseCompliance(compliance) {
    let value = compliance;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        }
        catch {
            fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'invalid_json' });
        }
    }
    if (!isPlainObject(value))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, {
            reason: 'not_an_object',
            received: value === null ? 'null' : typeof value,
        });
    for (const key of Object.keys(value)) {
        if (!COMPLIANCE_KEYS.has(key))
            fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'unknown_field', field: key });
    }
    for (const key of ['verdict', 'artifactHash', 'evidence', 'allowedExceptions']) {
        if (!Object.hasOwn(value, key))
            fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'missing_field', field: key });
    }
    if (!Array.isArray(value.evidence))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'evidence_not_an_array' });
    if (!Array.isArray(value.allowedExceptions))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'allowed_exceptions_not_an_array' });
    return value;
}

/** `summary.beats[0]` 같은 경로를 segment 목록으로. 문법 위반은 null. */
function parseFieldPath(raw) {
    if (typeof raw !== 'string' || raw === '')
        return null;
    const root = /^[A-Za-z][A-Za-z0-9_]*/.exec(raw);
    if (!root)
        return null;
    const segments = [{ type: 'key', value: root[0] }];
    let rest = raw.slice(root[0].length);
    while (rest !== '') {
        const key = /^\.([A-Za-z0-9_]+)/.exec(rest);
        if (key) {
            segments.push({ type: 'key', value: key[1] });
            rest = rest.slice(key[0].length);
            continue;
        }
        const index = /^\[(\d+)\]/.exec(rest);
        if (index) {
            segments.push({ type: 'index', value: Number(index[1]) });
            rest = rest.slice(index[0].length);
            continue;
        }
        return null;
    }
    return segments;
}

function resolveFieldPath(artifact, segments) {
    let cursor = artifact;
    for (const segment of segments) {
        if (segment.type === 'index') {
            if (!Array.isArray(cursor) || segment.value >= cursor.length)
                return { found: false, value: null };
            cursor = cursor[segment.value];
            continue;
        }
        if (!isPlainObject(cursor) || !Object.hasOwn(cursor, segment.value))
            return { found: false, value: null };
        cursor = cursor[segment.value];
    }
    return { found: true, value: cursor };
}

function evidenceFail(reason, index, extra = {}) {
    fail(VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE, { reason, index, ...extra });
}

/**
 * 근거 한 건의 검증. 인용이 **지목한 필드에 실제로 있는지**까지 확인한다. 문자
 * 비율이나 문자 체계 추정은 쓰지 않는다.
 */
function validateEvidenceEntry(entry, index, artifact) {
    if (!isPlainObject(entry))
        evidenceFail('entry_not_an_object', index);
    for (const key of Object.keys(entry)) {
        if (!EVIDENCE_KEYS.has(key))
            evidenceFail('unknown_field', index, { field: key });
    }
    const fieldPath = typeof entry.fieldPath === 'string' ? entry.fieldPath.trim() : '';
    const quote = typeof entry.quote === 'string' ? entry.quote.normalize('NFC').trim() : '';
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (fieldPath === '')
        evidenceFail('missing_field_path', index);
    if (quote === '')
        evidenceFail('missing_quote', index, { fieldPath });
    if (reason === '')
        evidenceFail('missing_reason', index, { fieldPath });

    const segments = parseFieldPath(fieldPath);
    if (!segments)
        evidenceFail('malformed_field_path', index, { fieldPath });
    const root = segments[0].value;
    if (!ARTIFACT_FIELDS.includes(root))
        evidenceFail('unknown_field_path', index, { fieldPath });
    // 기계 계약(키·ID·enum)은 언어 판정 대상이 아니므로 실패 근거가 될 수 없다.
    if (MACHINE_EXEMPT_ARTIFACT_FIELDS.includes(root))
        evidenceFail('machine_exempt_field', index, { fieldPath });

    const resolved = resolveFieldPath(artifact, segments);
    if (!resolved.found)
        evidenceFail('field_path_not_found', index, { fieldPath });
    if (typeof resolved.value !== 'string')
        evidenceFail('field_not_text', index, { fieldPath });
    if (!resolved.value.includes(quote))
        evidenceFail('quote_not_in_field', index, { fieldPath });

    return Object.freeze({ fieldPath, quote, reason });
}

function exceptionKey(entry) {
    return canonicalJson({ kind: entry.kind, language: entry.language, scope: entry.scope });
}

function validateClaimedException(entry, index, approvedKeys) {
    if (!isPlainObject(entry))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'exception_not_an_object', index });
    for (const key of Object.keys(entry)) {
        if (!EXCEPTION_KEYS.has(key))
            fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'unknown_exception_field', index, field: key });
    }
    const kind = typeof entry.kind === 'string' ? entry.kind.trim() : '';
    const scope = typeof entry.scope === 'string' ? entry.scope.trim() : '';
    if (kind === '' || scope === '' || entry.language === undefined || entry.language === null)
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'incomplete_exception', index });
    const claimed = Object.freeze({ kind, language: normalizeLanguageTag(entry.language).tag, scope });
    if (!approvedKeys.has(exceptionKey(claimed)))
        fail(VALIDATION_ERROR_CODES.UNAPPROVED_LANGUAGE_EXCEPTION, {
            index, kind: claimed.kind, language: claimed.language, scope: claimed.scope,
        });
    return claimed;
}

/**
 * 구조화된 `languageCompliance` 를 **실제로 결합된 묶음**·목표 언어·승인된 예외와
 * 대조한다. 해석 가능한 판정(`pass`/`fail`/`uncertain`)은 결과로 돌려주고,
 * 해석 불가능한 응답(잘못된 JSON·모양·hash, 근거 없는 실패, 지목한 필드에 없는
 * 인용)은 **판정이 아니므로** 던진다.
 *
 * @param {{ compliance: object|string, artifact: object, workContract?: object|null,
 *           targetLanguage?: string|object|null, allowedLanguageExceptions?: Array|null }} input
 */
export function evaluateLanguageCompliance({
    compliance,
    artifact,
    workContract = null,
    targetLanguage = null,
    allowedLanguageExceptions = null,
} = {}) {
    const canonical = canonicalArtifact(artifact);
    const artifactHash = computeArtifactHash(canonical);

    const languageInput = targetLanguage ?? workContract?.language ?? null;
    if (languageInput === null || languageInput === undefined)
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { missing: ['targetLanguage'] });
    const target = normalizeLanguageTag(languageInput);
    // wildcard 예외 등 승인 목록 자체의 구문 위반은 기존 언어 계약 resolver 가 거부한다.
    const approved = normalizeLanguageExceptions(
        allowedLanguageExceptions ?? workContract?.allowedLanguageExceptions ?? [],
        { language: target },
    );
    const approvedKeys = new Set(approved.map((entry) => exceptionKey(entry)));

    const parsed = parseCompliance(compliance);
    if (!VALIDATION_VERDICTS.includes(parsed.verdict))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, {
            reason: 'unknown_verdict',
            received: typeof parsed.verdict === 'string' ? parsed.verdict : null,
        });
    if (typeof parsed.artifactHash !== 'string' || !HEX64.test(parsed.artifactHash))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'invalid_artifact_hash' });
    if (parsed.artifactHash !== artifactHash)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH, { expected: artifactHash, received: parsed.artifactHash });
    if (Object.hasOwn(parsed, 'language')) {
        const judged = normalizeLanguageTag(parsed.language);
        if (judged.tag !== target.tag)
            fail(VALIDATION_ERROR_CODES.LANGUAGE_TARGET_MISMATCH, { expected: target.tag, received: judged.tag });
    }

    const evidence = parsed.evidence.map((entry, index) => validateEvidenceEntry(entry, index, canonical));
    if (parsed.verdict === 'fail' && evidence.length === 0)
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE, { reason: 'fail_without_evidence' });
    const claimedExceptions = parsed.allowedExceptions
        .map((entry, index) => validateClaimedException(entry, index, approvedKeys));

    let failureCode = null;
    if (parsed.verdict === 'fail')
        failureCode = VALIDATION_ERROR_CODES.OUTPUT_LANGUAGE_MISMATCH;
    else if (parsed.verdict === 'uncertain')
        failureCode = VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE;

    return Object.freeze({
        schemaVersion: VALIDATION_CONTRACT_SCHEMA_VERSION,
        verdict: parsed.verdict,
        satisfied: parsed.verdict === 'pass',
        artifactHash,
        targetLanguage: target.tag,
        evidence: Object.freeze(evidence),
        allowedExceptions: Object.freeze(claimedExceptions),
        failureCode,
    });
}

/** 파생 값(`satisfied`/`failureCode`)은 hash 대상이 아니다. */
export function computeLanguageComplianceHash(result) {
    if (!isPlainObject(result)
        || !VALIDATION_VERDICTS.includes(result.verdict)
        || typeof result.artifactHash !== 'string'
        || typeof result.targetLanguage !== 'string'
        || !Array.isArray(result.evidence)
        || !Array.isArray(result.allowedExceptions))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'not_an_evaluated_result' });
    return sha256(canonicalJson({
        schemaVersion: result.schemaVersion ?? VALIDATION_CONTRACT_SCHEMA_VERSION,
        verdict: result.verdict,
        artifactHash: result.artifactHash,
        targetLanguage: result.targetLanguage,
        evidence: result.evidence,
        allowedExceptions: result.allowedExceptions,
    }));
}

// ─── 필수 불변식 coverage ───────────────────────────────────────────────────

function requiredIdsFromRows(rows) {
    const required = new Set();
    const notApplicable = new Set();
    const advisory = new Set();
    for (const row of rows) {
        if (!isPlainObject(row))
            fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, { reason: 'row_not_an_object' });
        const id = row.invariantId;
        if (id === null || id === undefined)
            continue;
        if (typeof id !== 'string' || id.trim() === '')
            fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, { reason: 'invalid_invariant_id' });
        if (row.invariant === 'required')
            required.add(id);
        else if (row.invariant === 'not_applicable')
            notApplicable.add(id);
        else if (row.invariant === 'advisory')
            advisory.add(id);
        else
            // `conditional` 같은 미해결 요구도는 계획 단계에서 확정돼야 한다.
            fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, {
                reason: 'unresolved_requirement',
                invariantId: id,
                received: typeof row.invariant === 'string' ? row.invariant : null,
            });
    }
    return { required, notApplicable, advisory };
}

function idSet(list, reason) {
    const out = new Set();
    for (const id of list) {
        if (typeof id !== 'string' || id.trim() === '')
            fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, { reason });
        out.add(id);
    }
    return out;
}

function resolvePlan(plan) {
    let rows = null;
    let meta = {};
    if (Array.isArray(plan)) {
        rows = plan;
    }
    else if (isPlainObject(plan)) {
        meta = plan;
        if (Array.isArray(plan.rows))
            rows = plan.rows;
        else if (Array.isArray(plan.requiredInvariantIds)) {
            const required = idSet(plan.requiredInvariantIds, 'invalid_invariant_id');
            const notApplicable = idSet(plan.notApplicableInvariantIds ?? [], 'invalid_invariant_id');
            const advisory = idSet(plan.advisoryInvariantIds ?? [], 'invalid_invariant_id');
            return { required, notApplicable, advisory, meta };
        }
    }
    if (rows === null)
        fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, { reason: 'unknown_plan_shape' });
    return { ...requiredIdsFromRows(rows), meta };
}

function coverageValueOf(raw, id) {
    let value = raw;
    if (isPlainObject(value))
        value = value.coverage;
    if (typeof value !== 'string')
        fail(VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT, { reason: 'invalid_entry', invariantId: id });
    if (!COVERAGE_VALUES.includes(value))
        fail(VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT, { reason: 'unknown_coverage_value', invariantId: id, received: value });
    return value;
}

function resolveCoverage(coverage) {
    const map = new Map();
    if (Array.isArray(coverage)) {
        for (const entry of coverage) {
            if (!isPlainObject(entry) || typeof entry.id !== 'string')
                fail(VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT, { reason: 'invalid_entry' });
            map.set(entry.id, coverageValueOf(entry, entry.id));
        }
        return map;
    }
    if (!isPlainObject(coverage))
        fail(VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT, {
            reason: 'unknown_report_shape',
            received: coverage === null ? 'null' : typeof coverage,
        });
    const source = isPlainObject(coverage.invariants) ? coverage.invariants : coverage;
    for (const id of Object.keys(source)) {
        map.set(id, coverageValueOf(source[id], id));
    }
    return map;
}

/** 필수 불변식별 차단 사유. 제출된 not_applicable 은 필수를 면제하지 못한다. */
function blockingReason(value) {
    if (value === null)
        return 'missing';
    if (value === 'not_applicable')
        return 'not_applicable_cannot_waive';
    return value;
}

/**
 * 언어 판정과 **분리된** 필수 불변식 검증. 필수 집합은 호출자가 넘긴 등록 계획에서만
 * 나오며 이 모듈이 계획을 지어내지 않는다. advisory/soft 는 값이 무엇이든 막지 않고,
 * 계획이 표시한 비적용만 정당한 not_applicable 이다.
 *
 * @param {{ plan: object|Array, coverage: object|Array }} input
 */
export function evaluateInvariantCoverage({ plan, coverage } = {}) {
    const { required, notApplicable, advisory, meta } = resolvePlan(plan);
    if (required.size === 0)
        fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, { reason: 'no_required_invariants' });
    const missingMandatory = ALWAYS_MANDATORY_INVARIANTS.filter((id) => !required.has(id));
    if (missingMandatory.length > 0)
        fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, {
            reason: 'missing_mandatory_invariant',
            missing: missingMandatory,
        });

    const reported = resolveCoverage(coverage);
    const requiredIds = [...required].sort(compareCodePoints);
    const coverageById = {};
    const satisfiedIds = [];
    const blocked = [];
    for (const id of requiredIds) {
        const value = reported.has(id) ? reported.get(id) : null;
        coverageById[id] = value;
        if (value === 'validated')
            satisfiedIds.push(id);
        else
            blocked.push(Object.freeze({ id, coverage: value, reason: blockingReason(value) }));
    }

    const notApplicableIds = [...notApplicable].filter((id) => !required.has(id)).sort(compareCodePoints);
    for (const id of notApplicableIds) {
        coverageById[id] = reported.has(id) ? reported.get(id) : null;
    }
    const advisoryIds = [...advisory].filter((id) => !required.has(id) && !notApplicable.has(id)).sort(compareCodePoints);
    const advisoryRows = advisoryIds.map((id) => Object.freeze({
        id,
        coverage: reported.has(id) ? reported.get(id) : null,
    }));
    const unrecognized = [...reported.keys()]
        .filter((id) => !required.has(id) && !notApplicable.has(id) && !advisory.has(id))
        .sort(compareCodePoints);

    return Object.freeze({
        schemaVersion: VALIDATION_CONTRACT_SCHEMA_VERSION,
        checkerPolicyVersion: meta.checkerPolicyVersion ?? null,
        promptFamily: meta.promptFamily ?? null,
        requiredIds: Object.freeze(requiredIds),
        coverageById: Object.freeze(coverageById),
        satisfiedIds: Object.freeze(satisfiedIds),
        notApplicableIds: Object.freeze(notApplicableIds),
        advisory: Object.freeze(advisoryRows),
        unrecognized: Object.freeze(unrecognized),
        blocked: Object.freeze(blocked),
        complete: blocked.length === 0,
    });
}

export function computeCoverageHash(result) {
    if (!isPlainObject(result)
        || !Array.isArray(result.requiredIds)
        || !isPlainObject(result.coverageById)
        || typeof result.complete !== 'boolean')
        fail(VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT, { reason: 'not_an_evaluated_result' });
    return sha256(canonicalJson({
        schemaVersion: result.schemaVersion ?? VALIDATION_CONTRACT_SCHEMA_VERSION,
        checkerPolicyVersion: result.checkerPolicyVersion ?? null,
        requiredIds: result.requiredIds,
        coverageById: result.coverageById,
        complete: result.complete,
    }));
}

// ─── 검사 영수증 ────────────────────────────────────────────────────────────

const RECEIPT_IDENTITY_FIELDS = Object.freeze([
    'schemaVersion', 'validatorVersion', 'workId', 'chapter', 'workflowId', 'runId',
    'validationEpoch', 'sourceHead', 'planSourceHash',
    'contractHash', 'artifactHash', 'languageComplianceHash', 'coverageHash',
]);
const RECEIPT_FIELDS = Object.freeze([
    ...RECEIPT_IDENTITY_FIELDS, 'verdict', 'consumed', 'stale', 'staleReason', 'issuedBy', 'checkId',
]);

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function positiveInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function assertReceiptShape(receipt) {
    if (!isPlainObject(receipt))
        fail(VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT, {
            reason: 'not_an_object',
            received: receipt === null || receipt === undefined ? 'absent' : typeof receipt,
        });
    for (const key of Object.keys(receipt)) {
        if (!RECEIPT_FIELDS.includes(key))
            fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'unknown_field', field: key });
    }
    for (const key of RECEIPT_FIELDS) {
        if (!Object.hasOwn(receipt, key))
            fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'missing_field', field: key });
    }
    if (receipt.schemaVersion !== VALIDATION_CONTRACT_SCHEMA_VERSION)
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'unknown_schema_version', received: receipt.schemaVersion ?? null });
    if (!nonEmptyString(receipt.validatorVersion))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_validator_version' });
    if (!nonEmptyString(receipt.workId))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_work_id' });
    if (receipt.chapter !== null && !positiveInteger(receipt.chapter))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_chapter' });
    if (!nonEmptyString(receipt.workflowId) && !nonEmptyString(receipt.runId))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'missing_workflow_or_run_id' });
    if (!positiveInteger(receipt.validationEpoch))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_validation_epoch' });
    for (const key of ['sourceHead', 'planSourceHash', 'contractHash', 'artifactHash', 'languageComplianceHash', 'coverageHash']) {
        if (!nonEmptyString(receipt[key]))
            fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_hash_member', field: key });
    }
    if (typeof receipt.consumed !== 'boolean' || typeof receipt.stale !== 'boolean')
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_lifecycle_flag' });
    if (!nonEmptyString(receipt.checkId))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_check_id' });
}

/** 신원 + 네 개의 hash 만으로 계산한다. 소비/stale/발급처는 신원이 아니다. */
export function computeReceiptCheckId(receipt) {
    if (!isPlainObject(receipt))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'not_an_object' });
    const identity = {};
    for (const key of RECEIPT_IDENTITY_FIELDS) {
        identity[key] = receipt[key] ?? null;
    }
    return sha256(canonicalJson(identity));
}

/**
 * 통과 영수증 발급. 언어 판정이 `pass` 이고 필수 불변식 coverage 가 완료된 경우에만
 * 발급되며, 그 밖에는 계획의 terminal 원인 코드로 던진다.
 */
export function buildValidationReceipt({
    workId,
    chapter = null,
    workflowId = null,
    runId = null,
    validationEpoch,
    sourceHead,
    planSourceHash,
    workContract,
    artifact,
    languageCompliance,
    coverage,
    validatorVersion = VALIDATOR_VERSION,
    issuedBy = null,
} = {}) {
    if (!isPlainObject(workContract) || !nonEmptyString(workContract.language))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_work_contract' });
    const contractHash = computeLanguageContractHash(workContract);
    const artifactHash = computeArtifactHash(artifact);

    if (!isPlainObject(languageCompliance) || !VALIDATION_VERDICTS.includes(languageCompliance.verdict))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'not_an_evaluated_result' });
    if (languageCompliance.artifactHash !== artifactHash)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH, {
            expected: artifactHash,
            received: typeof languageCompliance.artifactHash === 'string' ? languageCompliance.artifactHash : null,
        });
    if (languageCompliance.verdict === 'fail')
        fail(VALIDATION_ERROR_CODES.OUTPUT_LANGUAGE_MISMATCH, { evidence: languageCompliance.evidence ?? [] });
    if (languageCompliance.verdict === 'uncertain')
        fail(VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE, { reason: 'language_verdict_uncertain' });

    if (!isPlainObject(coverage) || typeof coverage.complete !== 'boolean')
        fail(VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT, { reason: 'not_an_evaluated_result' });
    if (!coverage.complete)
        fail(VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE, { blocked: coverage.blocked ?? [] });

    const receipt = {
        schemaVersion: VALIDATION_CONTRACT_SCHEMA_VERSION,
        validatorVersion,
        verdict: RECEIPT_VERDICT_PASSED,
        workId,
        chapter,
        workflowId: nonEmptyString(workflowId) ? workflowId : null,
        runId: nonEmptyString(runId) ? runId : null,
        validationEpoch,
        sourceHead,
        planSourceHash,
        contractHash,
        artifactHash,
        languageComplianceHash: computeLanguageComplianceHash(languageCompliance),
        coverageHash: computeCoverageHash(coverage),
        consumed: false,
        stale: false,
        staleReason: null,
        issuedBy,
        checkId: '',
    };
    receipt.checkId = computeReceiptCheckId(receipt);
    assertReceiptShape(receipt);
    return Object.freeze(receipt);
}

/**
 * stale 표시는 순수 변환이며 되돌릴 수 없다. 태그·HEAD 가 원래 값으로 복구돼도 같은
 * 영수증은 부활하지 않으며, 명시적인 새 epoch 의 새 영수증이 필요하다.
 */
export function markReceiptStale(receipt, reason = 'contract_drift') {
    assertReceiptShape(receipt);
    return Object.freeze({ ...receipt, stale: true, staleReason: nonEmptyString(reason) ? reason : 'contract_drift' });
}

export function markReceiptConsumed(receipt) {
    assertReceiptShape(receipt);
    return Object.freeze({ ...receipt, consumed: true });
}

const EXPECTED_REQUIRED_KEYS = Object.freeze(['workId', 'chapter', 'validationEpoch', 'sourceHead', 'planSourceHash']);

function assertExpectation(expected, { hasArtifact, hasWorkContract }) {
    if (!isPlainObject(expected))
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { reason: 'not_an_object' });
    const missing = EXPECTED_REQUIRED_KEYS.filter((key) => !Object.hasOwn(expected, key));
    if (!Object.hasOwn(expected, 'workflowId') && !Object.hasOwn(expected, 'runId'))
        missing.push('workflowId|runId');
    if (!Object.hasOwn(expected, 'contractHash') && !hasWorkContract)
        missing.push('contractHash|workContract');
    if (!Object.hasOwn(expected, 'artifactHash') && !hasArtifact)
        missing.push('artifactHash|artifact');
    if (missing.length > 0)
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { missing });
    if (!positiveInteger(expected.validationEpoch))
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { reason: 'invalid_validation_epoch' });
    if (Object.hasOwn(expected, 'minValidationEpoch') && !positiveInteger(expected.minValidationEpoch))
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { reason: 'invalid_min_validation_epoch' });
}

function assertIdentity(receipt, expected, field) {
    if (receipt[field] !== expected[field])
        fail(VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH, {
            field,
            expected: expected[field] ?? null,
            received: receipt[field] ?? null,
        });
}

/**
 * 소비처(commit / workflow 승인 / sync apply)가 쓰는 단일 게이트.
 *
 * 검사 순서가 계약의 일부다: 존재 → 기대값 완전성 → 모양 → checkId 재계산 →
 * verdict → consumed → stale → validator 버전 → epoch → 신원 → 계약/산출물 hash →
 * 언어·coverage hash. stale/consumed 를 신원 비교보다 먼저 보므로 값이 원상 복구돼도
 * 죽은 영수증이 살아나지 않는다.
 */
export function validateValidationReceipt({
    receipt,
    expected,
    artifact = null,
    workContract = null,
    languageCompliance = null,
    coverage = null,
} = {}) {
    if (receipt === null || receipt === undefined)
        fail(VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT, { reason: 'absent' });
    assertExpectation(expected, { hasArtifact: artifact !== null, hasWorkContract: workContract !== null });
    assertReceiptShape(receipt);

    if (computeReceiptCheckId(receipt) !== receipt.checkId)
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'check_id_mismatch' });
    if (receipt.verdict !== RECEIPT_VERDICT_PASSED)
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, {
            reason: 'verdict_not_passed',
            received: typeof receipt.verdict === 'string' ? receipt.verdict : null,
        });
    if (receipt.consumed)
        fail(VALIDATION_ERROR_CODES.RECEIPT_ALREADY_CONSUMED, { checkId: receipt.checkId });
    if (receipt.stale)
        fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, {
            reason: 'receipt_marked_stale',
            staleReason: receipt.staleReason ?? null,
            checkId: receipt.checkId,
        });

    const expectedValidator = Object.hasOwn(expected, 'validatorVersion') ? expected.validatorVersion : VALIDATOR_VERSION;
    if (receipt.validatorVersion !== expectedValidator)
        fail(VALIDATION_ERROR_CODES.VALIDATOR_VERSION_MISMATCH, {
            expected: expectedValidator, received: receipt.validatorVersion,
        });

    if (receipt.validationEpoch < expected.validationEpoch)
        fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, {
            reason: 'epoch_superseded', expected: expected.validationEpoch, received: receipt.validationEpoch,
        });
    if (receipt.validationEpoch !== expected.validationEpoch)
        fail(VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH, {
            field: 'validationEpoch', expected: expected.validationEpoch, received: receipt.validationEpoch,
        });
    if (Object.hasOwn(expected, 'minValidationEpoch') && receipt.validationEpoch < expected.minValidationEpoch)
        fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, {
            reason: 'epoch_below_minimum', expected: expected.minValidationEpoch, received: receipt.validationEpoch,
        });

    assertIdentity(receipt, expected, 'workId');
    assertIdentity(receipt, expected, 'chapter');
    assertIdentity(receipt, expected, 'sourceHead');
    assertIdentity(receipt, expected, 'planSourceHash');
    if (Object.hasOwn(expected, 'workflowId'))
        assertIdentity(receipt, expected, 'workflowId');
    if (Object.hasOwn(expected, 'runId'))
        assertIdentity(receipt, expected, 'runId');

    if (workContract !== null) {
        const contractHash = computeLanguageContractHash(workContract);
        if (contractHash !== receipt.contractHash)
            fail(VALIDATION_ERROR_CODES.CONTRACT_HASH_MISMATCH, { expected: contractHash, received: receipt.contractHash });
    }
    if (Object.hasOwn(expected, 'contractHash') && expected.contractHash !== receipt.contractHash)
        fail(VALIDATION_ERROR_CODES.CONTRACT_HASH_MISMATCH, { expected: expected.contractHash, received: receipt.contractHash });

    if (artifact !== null) {
        const artifactHash = computeArtifactHash(artifact);
        if (artifactHash !== receipt.artifactHash)
            fail(VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH, { expected: artifactHash, received: receipt.artifactHash });
    }
    if (Object.hasOwn(expected, 'artifactHash') && expected.artifactHash !== receipt.artifactHash)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH, { expected: expected.artifactHash, received: receipt.artifactHash });

    if (languageCompliance !== null) {
        if (languageCompliance.verdict === 'fail')
            fail(VALIDATION_ERROR_CODES.OUTPUT_LANGUAGE_MISMATCH, { evidence: languageCompliance.evidence ?? [] });
        if (languageCompliance.verdict === 'uncertain')
            fail(VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE, { reason: 'language_verdict_uncertain' });
        const hash = computeLanguageComplianceHash(languageCompliance);
        if (hash !== receipt.languageComplianceHash)
            fail(VALIDATION_ERROR_CODES.LANGUAGE_COMPLIANCE_HASH_MISMATCH, {
                expected: hash, received: receipt.languageComplianceHash,
            });
    }
    if (Object.hasOwn(expected, 'languageComplianceHash') && expected.languageComplianceHash !== receipt.languageComplianceHash)
        fail(VALIDATION_ERROR_CODES.LANGUAGE_COMPLIANCE_HASH_MISMATCH, {
            expected: expected.languageComplianceHash, received: receipt.languageComplianceHash,
        });

    if (coverage !== null) {
        if (!isPlainObject(coverage) || typeof coverage.complete !== 'boolean')
            fail(VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT, { reason: 'not_an_evaluated_result' });
        if (!coverage.complete)
            fail(VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE, { blocked: coverage.blocked ?? [] });
        const hash = computeCoverageHash(coverage);
        if (hash !== receipt.coverageHash)
            fail(VALIDATION_ERROR_CODES.COVERAGE_HASH_MISMATCH, { expected: hash, received: receipt.coverageHash });
    }
    if (Object.hasOwn(expected, 'coverageHash') && expected.coverageHash !== receipt.coverageHash)
        fail(VALIDATION_ERROR_CODES.COVERAGE_HASH_MISMATCH, { expected: expected.coverageHash, received: receipt.coverageHash });

    return Object.freeze({
        ok: true,
        checkId: receipt.checkId,
        workId: receipt.workId,
        chapter: receipt.chapter,
        workflowId: receipt.workflowId,
        runId: receipt.runId,
        validationEpoch: receipt.validationEpoch,
        sourceHead: receipt.sourceHead,
        planSourceHash: receipt.planSourceHash,
        contractHash: receipt.contractHash,
        artifactHash: receipt.artifactHash,
        languageComplianceHash: receipt.languageComplianceHash,
        coverageHash: receipt.coverageHash,
        validatorVersion: receipt.validatorVersion,
    });
}

// ─── 승인 결합 ──────────────────────────────────────────────────────────────

const APPROVAL_BINDING_FIELDS = Object.freeze(['checkId', 'validationEpoch', 'artifactHash']);

/** 승인 descriptor 조립. 문체 승인이 언어 검증을 대신하지 못하도록 같은 검사에 묶는다. */
export function buildApprovalBinding(receipt, { approvedBy = null, decision = 'approve' } = {}) {
    assertReceiptShape(receipt);
    return Object.freeze({
        checkId: receipt.checkId,
        validationEpoch: receipt.validationEpoch,
        artifactHash: receipt.artifactHash,
        contractHash: receipt.contractHash,
        approvedBy,
        decision,
    });
}

export function validateApprovalBinding({ approval, receipt } = {}) {
    assertReceiptShape(receipt);
    if (!isPlainObject(approval))
        fail(VALIDATION_ERROR_CODES.INVALID_APPROVAL_BINDING, {
            reason: 'missing_approval',
            received: approval === null || approval === undefined ? 'absent' : typeof approval,
        });
    for (const field of APPROVAL_BINDING_FIELDS) {
        if (!Object.hasOwn(approval, field))
            fail(VALIDATION_ERROR_CODES.INVALID_APPROVAL_BINDING, { reason: 'missing_binding_member', field });
        if (approval[field] !== receipt[field])
            fail(VALIDATION_ERROR_CODES.INVALID_APPROVAL_BINDING, {
                reason: 'binding_mismatch', field, expected: receipt[field], received: approval[field] ?? null,
            });
    }
    if (Object.hasOwn(approval, 'contractHash') && approval.contractHash !== receipt.contractHash)
        fail(VALIDATION_ERROR_CODES.INVALID_APPROVAL_BINDING, {
            reason: 'binding_mismatch', field: 'contractHash', expected: receipt.contractHash, received: approval.contractHash ?? null,
        });
    return Object.freeze({
        ok: true,
        checkId: receipt.checkId,
        validationEpoch: receipt.validationEpoch,
        artifactHash: receipt.artifactHash,
        contractHash: receipt.contractHash,
    });
}
