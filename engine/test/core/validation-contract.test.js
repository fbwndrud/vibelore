import { describe, expect, it } from '../_support/vitest-shim.mjs';
import {
    LanguagePolicyError,
    buildLanguageContract,
    computeLanguageContractHash,
} from '../../src/core/language-policy.js';
import {
    aggregateCheckerCoverage,
    describeCheckerPlan,
} from '../../src/continuity/checker-registry.js';
import {
    ALWAYS_MANDATORY_INVARIANTS,
    APPROVAL_FORBIDDEN_INVARIANTS,
    APPROVAL_REQUIRED_INVARIANTS,
    CHAPTER_CONDITIONAL_INVARIANTS,
    CHAPTER_REQUIRED_INVARIANTS,
    DEFAULT_LANGUAGE_FIELD_PROJECTION,
    LANGUAGE_FIELD_CLASSIFIER_VERSION,
    VALIDATION_ERROR_CODES,
    VALIDATOR_VERSION,
    ValidationContractError,
    artifactKindOf,
    buildApprovalBinding,
    buildValidationReceipt,
    canonicalApprovalArtifact,
    canonicalArtifact,
    canonicalizeArtifact,
    computeArtifactHash,
    computeCheckerPlanHash,
    computeCoverageHash,
    computeLanguageComplianceHash,
    computeLanguageFieldProjectionHash,
    computeReceiptCheckId,
    evaluateInvariantCoverage,
    evaluateLanguageCompliance,
    markReceiptConsumed,
    markReceiptStale,
    validateApprovalBinding,
    validateValidationReceipt,
} from '../../src/core/validation-contract.js';

/** 던진 오류를 잡아 코드를 확인한다. 성공하면 null 이 아니라 실패로 드러나게 한다. */
function caught(fn) {
    try {
        fn();
    }
    catch (err) {
        return err;
    }
    return null;
}

function expectCode(fn, code) {
    const err = caught(fn);
    expect(err).toBeInstanceOf(ValidationContractError);
    expect(err.code).toBe(code);
    return err;
}

/** JSON 저장·재적재를 통과시킨다. 저장된 객체는 신뢰 권한이 아니다. */
function persisted(value) {
    return JSON.parse(JSON.stringify(value));
}

// ─── 공통 fixture ───────────────────────────────────────────────────────────

/** 일본어 본문에 승인된 영어 고유명과 원문 인용이 섞인 정상 원고. */
const PROSE = '扉が開いた。Ann は振り返り、"I will go," と告げた。夜が明ける。';

/**
 * 시각적으로 같지만 code unit 길이가 다른 두 원고(조합형 / 완성형 악센트).
 * 편집기나 도구가 이 파일을 정규화해 구분이 사라지면 아래 길이 단언이 먼저 깨진다 —
 * 조용히 같은 문자열이 되어 회귀 검사를 무력화하지 않게 한다.
 */
const NFC_PROSE = 'Café の扉が開いた。';
const NFD_PROSE = 'Café の扉が開いた。';

function bundle(overrides = {}) {
    return {
        prose: PROSE,
        title: '扉の向こう',
        summary: { hook: 'Ann が扉を開ける', beats: ['扉', '夜明け'] },
        semanticDelta: [{ type: 'state', entityId: 'ann', value: '目覚めている' }],
        castManifestRaw: [{ id: 'ann', role: 'lead' }],
        ...overrides,
    };
}

const WORK_CONTRACT = buildLanguageContract({
    language: 'ja',
    allowedLanguageExceptions: [
        { kind: 'properNoun', language: 'en', scope: 'Ann', rationale: '원작 표기를 보존한다' },
        { kind: 'sourceQuote', language: 'en', scope: 'Ann 의 인용문', rationale: '승인된 원문 인용' },
    ],
});

function compliance(artifact, overrides = {}) {
    return {
        verdict: 'pass',
        artifactHash: computeArtifactHash(artifact),
        evidence: [],
        allowedExceptions: [],
        language: 'ja',
        ...overrides,
    };
}

function evaluate(artifact, overrides = {}) {
    return evaluateLanguageCompliance({
        compliance: compliance(artifact, overrides),
        artifact,
        workContract: WORK_CONTRACT,
    });
}

/** 실제 등록표에서 계획을 만든다. 필수 목록을 테스트가 지어내지 않는다. */
function registryPlan(input = {}) {
    return describeCheckerPlan({ language: 'ja', povMode: 'first-person', foundation: { characters: [] }, ...input });
}

function registryCoverage(plan, semanticEvidence, detectorResults = []) {
    return aggregateCheckerCoverage(plan, detectorResults, semanticEvidence);
}

const ALL_SEMANTIC_PASS = Object.freeze({
    SCHEMA: 'pass',
    INTRINSIC: 'pass',
    WORLD: 'pass',
    REGISTRATION: 'pass',
    POV: 'pass',
    FORMAT: 'pass',
    LENGTH: 'pass',
    OUTPUT_LANGUAGE: 'pass',
});

function completeCoverage(semanticEvidence = ALL_SEMANTIC_PASS, detectorResults = []) {
    const plan = registryPlan();
    return evaluateInvariantCoverage({
        plan,
        coverage: registryCoverage(plan, semanticEvidence, detectorResults),
        artifactKind: 'chapter',
    });
}

/** 등록표 없이 계획을 명시할 때도 화 원고의 필수 집합은 그대로다. */
function explicitChapterPlan(overrides = {}) {
    return {
        checkerPolicyVersion: 1,
        requiredInvariantIds: [...CHAPTER_REQUIRED_INVARIANTS, 'POV'],
        notApplicableInvariantIds: ['ADDRESSING'],
        advisoryInvariantIds: ['SENSITIVE'],
        ...overrides,
    };
}

function chapterCoverageMap(extra = {}) {
    const map = {
        ...Object.fromEntries(CHAPTER_REQUIRED_INVARIANTS.map((id) => [id, 'validated'])),
        POV: 'validated',
        ...extra,
    };
    for (const [id, value] of Object.entries(map)) {
        if (value === undefined)
            delete map[id];
    }
    return map;
}

const IDENTITY = Object.freeze({
    workId: 'w1',
    chapter: 12,
    workflowId: 'wf-7',
    validationEpoch: 3,
    sourceHead: 'head-abc',
    planSourceHash: 'plan-abc',
});

function issueReceipt(overrides = {}) {
    const artifact = canonicalArtifact(bundle());
    return buildValidationReceipt({
        ...IDENTITY,
        workContract: WORK_CONTRACT,
        artifact,
        checkerPlan: registryPlan(),
        languageCompliance: evaluate(artifact),
        coverage: completeCoverage(),
        issuedBy: 'check',
        ...overrides,
    });
}

function expectation(overrides = {}) {
    return {
        ...IDENTITY,
        runId: null,
        artifactKind: 'chapter',
        checkerPlan: registryPlan(),
        contractHash: computeLanguageContractHash(WORK_CONTRACT),
        artifactHash: computeArtifactHash(bundle()),
        ...overrides,
    };
}

/** 소비 게이트의 필수 실제 산출물·계약·판정·coverage. 생략은 통과가 아니다. */
function requiredProofs(overrides = {}) {
    const artifact = overrides.artifact ?? bundle();
    const workContract = overrides.workContract ?? WORK_CONTRACT;
    const languageFields = overrides.languageFields;
    const proofs = {
        artifact,
        workContract,
        coverage: completeCoverage(),
        ...overrides,
    };
    if (!Object.hasOwn(proofs, 'languageCompliance') || proofs.languageCompliance === undefined) {
        proofs.languageCompliance = evaluateLanguageCompliance({
            compliance: compliance(artifact),
            artifact,
            workContract,
            ...(languageFields ? { languageFields } : {}),
        });
    }
    return proofs;
}

// ─── 승인 묶음 fixture ──────────────────────────────────────────────────────

const EN_CONTRACT = buildLanguageContract({ language: 'en' });

function approvalBundle(overrides = {}) {
    return {
        kind: 'profile',
        revision: 3,
        value: {
            genreLabel: 'Modern fantasy',
            readerPromise: 'A door that answers back.',
            openingPressure: 'The house refuses to stay shut.',
            // 기계 계약: 한국어 enum 값이지만 언어 위반의 근거가 아니다.
            pov: '3인칭제한',
            engineGenre: 'other',
            // 사용자 제공 출처: 대화 언어 그대로 보존한다.
            sourceBrief: '문을 여는 이야기를 써줘',
        },
        ...overrides,
    };
}

const APPROVAL_PLAN = Object.freeze({
    checkerPolicyVersion: 1,
    requiredInvariantIds: [...APPROVAL_REQUIRED_INVARIANTS],
});

function approvalCompliance(artifact, overrides = {}) {
    return {
        verdict: 'pass',
        artifactHash: computeArtifactHash(artifact),
        evidence: [],
        allowedExceptions: [],
        language: 'en',
        ...overrides,
    };
}

function evaluateApproval(artifact, overrides = {}, extra = {}) {
    return evaluateLanguageCompliance({
        compliance: approvalCompliance(artifact, overrides),
        artifact,
        workContract: EN_CONTRACT,
        ...extra,
    });
}

// ─── 정본 산출물 묶음 ───────────────────────────────────────────────────────

describe('canonicalArtifact', () => {
    it('binds prose, title, summary, semantic delta and cast manifest into one hash', () => {
        const base = computeArtifactHash(bundle());
        // 검사 뒤 요약만 바꾼 묶음을 본문 해시로 발행할 수 없다.
        expect(computeArtifactHash(bundle({ summary: { hook: '다른 요약', beats: ['扉'] } }))).not.toBe(base);
        expect(computeArtifactHash(bundle({ title: '別の扉' }))).not.toBe(base);
        expect(computeArtifactHash(bundle({ semanticDelta: [{ type: 'state', entityId: 'ann', value: '眠っている' }] }))).not.toBe(base);
        expect(computeArtifactHash(bundle({ castManifestRaw: [{ id: 'ann', role: 'support' }] }))).not.toBe(base);
        expect(computeArtifactHash(bundle({ prose: `${PROSE} 追記。` }))).not.toBe(base);
    });

    it('is deterministic across key order and re-canonicalization', () => {
        const shuffled = {
            castManifestRaw: [{ role: 'lead', id: 'ann' }],
            title: '扉の向こう',
            semanticDelta: [{ value: '目覚めている', entityId: 'ann', type: 'state' }],
            summary: { beats: ['扉', '夜明け'], hook: 'Ann が扉を開ける' },
            prose: PROSE,
        };
        expect(computeArtifactHash(shuffled)).toBe(computeArtifactHash(bundle()));
        const canonical = canonicalArtifact(bundle());
        expect(computeArtifactHash(canonical)).toBe(computeArtifactHash(bundle()));
        expect(Object.keys(JSON.parse(canonicalizeArtifact(bundle())))).toEqual([
            'artifactKind', 'artifactSchemaVersion', 'castManifestRaw', 'prose', 'semanticDelta', 'summary', 'title',
        ]);
        // 배열 순서는 데이터이므로 보존한다.
        expect(computeArtifactHash(bundle({ summary: { hook: 'Ann が扉を開ける', beats: ['夜明け', '扉'] } })))
            .not.toBe(computeArtifactHash(bundle()));
    });

    it('preserves exact Unicode instead of folding NFD into NFC', () => {
        // 같은 hash 가 되면 짧은 NFC 치환이 이미 검사된 legacyCodeUnits 길이를 우회한다.
        expect(NFD_PROSE.normalize('NFC')).toBe(NFC_PROSE.normalize('NFC'));
        expect(NFD_PROSE.length).toBe(NFC_PROSE.length + 1);
        expect(computeArtifactHash(bundle({ prose: NFD_PROSE })))
            .not.toBe(computeArtifactHash(bundle({ prose: NFC_PROSE })));

        // 정본화는 키 순서만 정한다. 발행 문자열은 그대로 남는다.
        const canonical = canonicalArtifact(bundle({ prose: NFD_PROSE, title: NFD_PROSE, summary: NFD_PROSE }));
        expect(canonical.prose).toBe(NFD_PROSE);
        expect(canonical.prose.length).toBe(NFD_PROSE.length);
        expect(canonical.title).toBe(NFD_PROSE);
        expect(canonical.summary).toBe(NFD_PROSE);
        // delta·manifest 안의 값도 접지 않는다.
        expect(canonicalArtifact(bundle({ semanticDelta: [{ fact: NFD_PROSE }] })).semanticDelta[0].fact).toBe(NFD_PROSE);
        expect(canonicalArtifact(bundle({ castManifestRaw: NFD_PROSE })).castManifestRaw).toBe(NFD_PROSE);
    });

    it('preserves leading and trailing whitespace of published values', () => {
        const spaced = `  ${PROSE}\n\n`;
        expect(canonicalArtifact(bundle({ prose: spaced })).prose).toBe(spaced);
        expect(computeArtifactHash(bundle({ prose: spaced }))).not.toBe(computeArtifactHash(bundle()));
    });

    it('fails missing required values instead of publishing silently empty ones', () => {
        for (const field of ['prose', 'title', 'summary', 'semanticDelta', 'castManifestRaw']) {
            const incomplete = bundle();
            delete incomplete[field];
            const err = expectCode(() => canonicalArtifact(incomplete), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
            expect(err.details).toEqual({ reason: 'missing_required_field', field });
            expectCode(() => canonicalArtifact(bundle({ [field]: null })), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
            expectCode(() => canonicalArtifact(bundle({ [field]: undefined })), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
        }
        expectCode(() => canonicalArtifact(bundle({ title: '   ' })), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
        expectCode(() => canonicalArtifact(bundle({ summary: {} })), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
        expectCode(() => canonicalArtifact(null), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
    });

    it('accepts explicitly empty delta and manifest but never invents a summary', () => {
        expect(computeArtifactHash(bundle({ semanticDelta: [], castManifestRaw: {} }))).toMatch(/^[0-9a-f]{64}$/);
        expectCode(() => canonicalArtifact(bundle({ summary: '' })), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
    });

    it('accepts an explicitly empty cast manifest string and keeps its exact bytes', () => {
        // 기존 엔진에서 "manifest 없음" 의 정당한 표현은 빈 문자열이다.
        expect(canonicalArtifact(bundle({ castManifestRaw: '' })).castManifestRaw).toBe('');
        expect(computeArtifactHash(bundle({ castManifestRaw: '' }))).toMatch(/^[0-9a-f]{64}$/);
        // 공백·구두점을 그대로 두므로 표현이 다르면 hash 도 다르다.
        expect(canonicalArtifact(bundle({ castManifestRaw: '  \n' })).castManifestRaw).toBe('  \n');
        expect(computeArtifactHash(bundle({ castManifestRaw: '  \n' })))
            .not.toBe(computeArtifactHash(bundle({ castManifestRaw: '' })));
        const raw = '{"cast":[{"characterId":"ann"}]}\n';
        expect(canonicalArtifact(bundle({ castManifestRaw: raw })).castManifestRaw).toBe(raw);
        // 키 부재·null·undefined 는 여전히 오류다. 빈 문자열만 명시적 "없음" 이다.
        for (const value of [null, undefined])
            expectCode(() => canonicalArtifact(bundle({ castManifestRaw: value })), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
        const withoutKey = bundle();
        delete withoutKey.castManifestRaw;
        expectCode(() => canonicalArtifact(withoutKey), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
    });

    it('rejects unknown publishable fields and forged derived hashes', () => {
        const err = expectCode(
            () => canonicalArtifact({ ...bundle(), influenceObservation: '추가 발행 값' }),
            VALIDATION_ERROR_CODES.UNKNOWN_ARTIFACT_FIELD,
        );
        expect(err.details.field).toBe('influenceObservation');
        expectCode(
            () => computeArtifactHash({ ...bundle(), artifactHash: 'f'.repeat(64) }),
            VALIDATION_ERROR_CODES.UNKNOWN_ARTIFACT_FIELD,
        );
    });

    it('rejects values that cannot be serialized deterministically', () => {
        expectCode(
            () => canonicalArtifact(bundle({ semanticDelta: [{ at: new Date(0) }] })),
            VALIDATION_ERROR_CODES.NON_SERIALIZABLE_ARTIFACT_VALUE,
        );
        expectCode(
            () => canonicalArtifact(bundle({ castManifestRaw: [{ id: 'ann', score: Number.NaN }] })),
            VALIDATION_ERROR_CODES.NON_SERIALIZABLE_ARTIFACT_VALUE,
        );
        const cyclic = { id: 'ann' };
        cyclic.self = cyclic;
        expectCode(
            () => canonicalArtifact(bundle({ castManifestRaw: [cyclic] })),
            VALIDATION_ERROR_CODES.NON_SERIALIZABLE_ARTIFACT_VALUE,
        );
    });
});

// ─── 승인 산출물 묶음 ───────────────────────────────────────────────────────

describe('canonicalApprovalArtifact', () => {
    it('is a typed artifact of its own kind, not a chapter bundle', () => {
        const artifact = canonicalApprovalArtifact(approvalBundle());
        expect(artifact.artifactKind).toBe('approval');
        expect(artifact.approvalKind).toBe('profile');
        expect(artifact.revision).toBe(3);
        expect(Object.hasOwn(artifact, 'prose')).toBe(false);
        expect(Object.hasOwn(artifact, 'title')).toBe(false);
        expect(artifactKindOf(artifact)).toBe('approval');
        expect(artifactKindOf(bundle())).toBe('chapter');
        // 멱등: 정본을 다시 넣어도 같은 hash 다.
        expect(computeArtifactHash(artifact)).toBe(computeArtifactHash(approvalBundle()));
    });

    it('never shares a hash space with a chapter bundle', () => {
        const approvalHash = computeArtifactHash(approvalBundle());
        expect(approvalHash).not.toBe(computeArtifactHash(bundle()));
        // 개정본이 hash 에 묶인다 — 승인은 특정 revision 의 승인이다.
        expect(computeArtifactHash(approvalBundle({ revision: 4 }))).not.toBe(approvalHash);
        expect(computeArtifactHash(approvalBundle({ kind: 'arc' }))).not.toBe(approvalHash);
    });

    it('supports every pre-publication approval gate', () => {
        for (const kind of ['profile', 'foundation', 'story', 'writer', 'arc', 'episode']) {
            expect(canonicalApprovalArtifact(approvalBundle({ kind })).approvalKind).toBe(kind);
        }
        expectCode(
            () => canonicalApprovalArtifact(approvalBundle({ kind: 'chapter' })),
            VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE,
        );
    });

    it('requires a real revision and a non-empty value', () => {
        for (const field of ['kind', 'revision', 'value']) {
            const incomplete = approvalBundle();
            delete incomplete[field];
            expectCode(() => canonicalApprovalArtifact(incomplete), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
        }
        expectCode(() => canonicalApprovalArtifact(approvalBundle({ revision: 0 })), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
        expectCode(() => canonicalApprovalArtifact(approvalBundle({ revision: '   ' })), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
        expectCode(() => canonicalApprovalArtifact(approvalBundle({ value: {} })), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
        expectCode(
            () => canonicalApprovalArtifact({ ...approvalBundle(), prose: '가짜 본문' }),
            VALIDATION_ERROR_CODES.UNKNOWN_ARTIFACT_FIELD,
        );
        // 문자열 revision 은 그대로 보존한다.
        expect(canonicalApprovalArtifact(approvalBundle({ revision: 'rev-2026-09-13' })).revision).toBe('rev-2026-09-13');
    });

    it('keeps chapter and approval canonicalization from impersonating each other', () => {
        expectCode(
            () => canonicalArtifact({ ...bundle(), artifactKind: 'approval' }),
            VALIDATION_ERROR_CODES.ARTIFACT_KIND_MISMATCH,
        );
        expectCode(
            () => canonicalApprovalArtifact({ ...approvalBundle(), artifactKind: 'chapter' }),
            VALIDATION_ERROR_CODES.ARTIFACT_KIND_MISMATCH,
        );
    });
});

// ─── 출력 언어 판정 ─────────────────────────────────────────────────────────

describe('evaluateLanguageCompliance', () => {
    const artifact = canonicalArtifact(bundle());

    it('accepts a structured pass and judges only the structured answer', () => {
        const result = evaluate(artifact, {
            allowedExceptions: [
                { kind: 'properNoun', language: 'en', scope: 'Ann' },
                { kind: 'sourceQuote', language: 'en', scope: 'Ann 의 인용문' },
            ],
            language: 'ja',
        });
        expect(result.verdict).toBe('pass');
        expect(result.satisfied).toBe(true);
        expect(result.targetLanguage).toBe('ja');
        expect(result.artifactKind).toBe('chapter');
        expect(result.failureCode).toBeNull();
        // 본문에 라틴 문자 고유명·영어 인용이 있어도 문자 비율로 실패시키지 않는다.
        expect(result.artifactHash).toBe(computeArtifactHash(bundle()));
    });

    it('accepts a JSON string response but not malformed JSON or shapes', () => {
        const asText = JSON.stringify(compliance(artifact));
        expect(evaluateLanguageCompliance({ compliance: asText, artifact, workContract: WORK_CONTRACT }).verdict).toBe('pass');

        expectCode(
            () => evaluateLanguageCompliance({ compliance: '{"verdict":"pass"', artifact, workContract: WORK_CONTRACT }),
            VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE,
        );
        expectCode(() => evaluate(artifact, { verdict: 'ok' }), VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE);
        expectCode(
            () => evaluateLanguageCompliance({
                compliance: { verdict: 'pass', artifactHash: computeArtifactHash(artifact), evidence: [] },
                artifact,
                workContract: WORK_CONTRACT,
            }),
            VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE,
        );
        expectCode(
            () => evaluate(artifact, { score: 0.98 }),
            VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE,
        );
    });

    it('rejects a judgment bound to a different artifact', () => {
        const err = expectCode(
            () => evaluate(artifact, { artifactHash: computeArtifactHash(bundle({ title: '別の扉' })) }),
            VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH,
        );
        expect(err.details.expected).toBe(computeArtifactHash(bundle()));
        expectCode(() => evaluate(artifact, { artifactHash: 'not-a-hash' }), VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE);
    });

    it('rejects a failure without usable evidence', () => {
        const err = expectCode(
            () => evaluate(artifact, { verdict: 'fail' }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expect(err.details.reason).toBe('fail_without_evidence');
        expectCode(
            () => evaluate(artifact, { verdict: 'fail', evidence: [{ fieldPath: 'prose', reason: '영어 서술' }] }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expectCode(
            () => evaluate(artifact, { verdict: 'fail', evidence: [{ fieldPath: 'prose', quote: '扉が開いた。' }] }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
    });

    it('rejects a quote that is not actually in the indicated field', () => {
        const err = expectCode(
            () => evaluate(artifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'prose', quote: 'The door opened.', reason: '본문 전체가 영어' }],
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expect(err.details.reason).toBe('quote_not_in_field');
        // 본문에 있는 문장이라도 다른 필드를 지목하면 근거가 아니다.
        expectCode(
            () => evaluate(artifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'title', quote: '扉が開いた。', reason: '제목이 오언어' }],
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expectCode(
            () => evaluate(artifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'summary.missing', quote: 'Ann', reason: '요약이 오언어' }],
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
    });

    it('compares quotes against the exact published string without normalizing', () => {
        const nfdArtifact = canonicalArtifact(bundle({ prose: NFD_PROSE }));
        const usable = evaluateLanguageCompliance({
            compliance: compliance(nfdArtifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'prose', quote: 'Café', reason: '본문에 라틴 서술이 섞였다' }],
            }),
            artifact: nfdArtifact,
            workContract: WORK_CONTRACT,
        });
        expect(usable.verdict).toBe('fail');
        // 같은 글자로 보여도 합성 형태가 다르면 그 문자열은 발행된 본문에 없다.
        expectCode(
            () => evaluateLanguageCompliance({
                compliance: compliance(nfdArtifact, {
                    verdict: 'fail',
                    evidence: [{ fieldPath: 'prose', quote: 'Café', reason: '본문에 라틴 서술이 섞였다' }],
                }),
                artifact: nfdArtifact,
                workContract: WORK_CONTRACT,
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
    });

    it('returns a usable fail when the evidence really is in the field', () => {
        const result = evaluate(artifact, {
            verdict: 'fail',
            evidence: [
                { fieldPath: 'summary.hook', quote: 'Ann が扉を開ける', reason: '요약 문장이 목표 언어가 아니다' },
                { fieldPath: 'semanticDelta[0].value', quote: '目覚めている', reason: '설명 값 확인' },
            ],
        });
        expect(result.verdict).toBe('fail');
        expect(result.satisfied).toBe(false);
        expect(result.failureCode).toBe(VALIDATION_ERROR_CODES.OUTPUT_LANGUAGE_MISMATCH);
        expect(result.evidence).toHaveLength(2);
    });

    it('treats machine enum and key fields as exempt evidence targets', () => {
        const err = expectCode(
            () => evaluate(artifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'castManifestRaw[0].role', quote: 'lead', reason: 'enum 이 영어' }],
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expect(err.details.reason).toBe('machine_exempt_field');
        expectCode(
            () => evaluate(artifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'summary', quote: 'hook', reason: 'JSON 키가 영어' }],
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
    });

    it('does not accept machine ids or enums inside semanticDelta as language evidence', () => {
        // 모든 중첩 문자열을 언어 대상으로 두면 기계 ID 불일치가 언어 실패로 둔갑한다.
        const machine = expectCode(
            () => evaluate(artifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'semanticDelta[0].entityId', quote: 'ann', reason: 'ID 가 영어' }],
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expect(machine.details.reason).toBe('machine_field');
        const enumFail = expectCode(
            () => evaluate(artifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'semanticDelta[0].type', quote: 'state', reason: 'enum 이 영어' }],
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expect(enumFail.details.reason).toBe('machine_field');
        // 뿌리 자체를 지목하는 것도 구체적인 자연어 필드가 아니다.
        const bare = canonicalArtifact(bundle({ semanticDelta: ['目覚めている'] }));
        expectCode(
            () => evaluate(bare, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'semanticDelta[0]', quote: '目覚めている', reason: 'delta 가 오언어' }],
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
    });

    it('keeps real generated human text inside semanticDelta language-scoped', () => {
        const rich = canonicalArtifact(bundle({
            semanticDelta: [{
                op: 'update',
                entityId: 'ann',
                fact: 'Ann remembers the door.',
                interpretation: 'She reads the silence as consent.',
                nextChoiceBias: 'She will open it again.',
                behavioralProof: { hypothesis: 'She trusts the house.', status: 'open' },
            }],
        }));
        for (const [fieldPath, quote] of [
            ['semanticDelta[0].fact', 'Ann remembers the door.'],
            ['semanticDelta[0].interpretation', 'She reads the silence as consent.'],
            ['semanticDelta[0].nextChoiceBias', 'She will open it again.'],
            ['semanticDelta[0].behavioralProof.hypothesis', 'She trusts the house.'],
        ]) {
            const result = evaluateLanguageCompliance({
                compliance: compliance(rich, { verdict: 'fail', evidence: [{ fieldPath, quote, reason: '영어 서술' }] }),
                artifact: rich,
                workContract: WORK_CONTRACT,
            });
            expect(result.verdict).toBe('fail');
            expect(result.evidence[0].fieldPath).toBe(fieldPath);
        }
        // 같은 묶음 안의 기계 상태 enum 은 여전히 근거가 아니다.
        expectCode(
            () => evaluateLanguageCompliance({
                compliance: compliance(rich, {
                    verdict: 'fail',
                    evidence: [{ fieldPath: 'semanticDelta[0].behavioralProof.status', quote: 'open', reason: 'enum' }],
                }),
                artifact: rich,
                workContract: WORK_CONTRACT,
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
    });

    it('classifies by leaf, so a structural container does not exempt its generated text', () => {
        // `ops` 는 구조 컨테이너다. 그 아래 생성된 이름·설명까지 기계로 묶으면 오언어 출력을 못 잡는다.
        const withOps = canonicalArtifact(bundle({
            semanticDelta: {
                schemaVersion: 1,
                ops: [{
                    op: 'register',
                    entityId: 'hall',
                    kind: 'place',
                    name: 'The Long Hall',
                    description: 'A corridor that never ends.',
                    term: 'hall-speak',
                    location: 'North wing',
                    knownFactsAdded: ['The hall counts its guests.'],
                }],
            },
        }));
        for (const [fieldPath, quote] of [
            ['semanticDelta.ops[0].name', 'The Long Hall'],
            ['semanticDelta.ops[0].description', 'A corridor that never ends.'],
            ['semanticDelta.ops[0].term', 'hall-speak'],
            ['semanticDelta.ops[0].location', 'North wing'],
            ['semanticDelta.ops[0].knownFactsAdded[0]', 'The hall counts its guests.'],
        ]) {
            const result = evaluateLanguageCompliance({
                compliance: compliance(withOps, { verdict: 'fail', evidence: [{ fieldPath, quote, reason: '영어 서술' }] }),
                artifact: withOps,
                workContract: WORK_CONTRACT,
            });
            expect(result.evidence[0].fieldPath).toBe(fieldPath);
        }
        // 같은 payload 안의 진짜 ID/enum 잎은 여전히 면제된다.
        for (const [fieldPath, quote] of [
            ['semanticDelta.ops[0].op', 'register'],
            ['semanticDelta.ops[0].entityId', 'hall'],
            ['semanticDelta.ops[0].kind', 'place'],
        ]) {
            const err = expectCode(
                () => evaluateLanguageCompliance({
                    compliance: compliance(withOps, { verdict: 'fail', evidence: [{ fieldPath, quote, reason: 'enum' }] }),
                    artifact: withOps,
                    workContract: WORK_CONTRACT,
                }),
                VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
            );
            expect(err.details.reason).toBe('machine_field');
        }
        // 통과 판정도 이 묶음을 그대로 받아들인다(모든 잎이 분류돼 있다).
        expect(evaluateLanguageCompliance({
            compliance: compliance(withOps), artifact: withOps, workContract: WORK_CONTRACT,
        }).verdict).toBe('pass');
    });

    it('separates a free-text intrinsic.role from a machine role enum', () => {
        const withRole = canonicalArtifact(bundle({
            semanticDelta: [{
                entityId: 'ann',
                role: 'lead',
                intrinsic: { role: '문을 지키는 사람으로 불린다' },
            }],
        }));
        // 캐릭터 intrinsic.role 은 자유 서술이므로 언어 판정 대상이다.
        const scoped = evaluateLanguageCompliance({
            compliance: compliance(withRole, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'semanticDelta[0].intrinsic.role', quote: '문을 지키는 사람으로 불린다', reason: '오언어' }],
            }),
            artifact: withRole,
            workContract: WORK_CONTRACT,
        });
        expect(scoped.evidence[0].fieldPath).toBe('semanticDelta[0].intrinsic.role');
        // 같은 이름이라도 workflow 의 role 은 enum 이다.
        const err = expectCode(
            () => evaluateLanguageCompliance({
                compliance: compliance(withRole, {
                    verdict: 'fail',
                    evidence: [{ fieldPath: 'semanticDelta[0].role', quote: 'lead', reason: 'enum' }],
                }),
                artifact: withRole,
                workContract: WORK_CONTRACT,
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expect(err.details.reason).toBe('machine_field');
    });

    it('refuses a pass while an unclassified generated value sits in the artifact', () => {
        // 근거가 비어 있다는 이유로 새 생성 필드가 조용히 검증을 건너뛰지 못한다.
        const withNewField = canonicalArtifact(bundle({
            semanticDelta: [{ entityId: 'ann', freshlyAddedProsePolicy: 'The corridor answers in English.' }],
        }));
        const err = expectCode(
            () => evaluateLanguageCompliance({
                compliance: compliance(withNewField, { verdict: 'pass', evidence: [] }),
                artifact: withNewField,
                workContract: WORK_CONTRACT,
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expect(err.details.reason).toBe('unclassified_generated_field');
        expect(err.details.fieldPaths).toEqual(['semanticDelta[0].freshlyAddedProsePolicy']);
        // 명시적 투영을 주면 같은 묶음이 통과할 수 있다.
        const projectedPass = evaluateLanguageCompliance({
            compliance: compliance(withNewField, { verdict: 'pass', evidence: [] }),
            artifact: withNewField,
            workContract: WORK_CONTRACT,
            languageFields: { humanTextFields: ['freshlyAddedProsePolicy'] },
        });
        expect(projectedPass.verdict).toBe('pass');
        expect(projectedPass.classifierVersion).toBe(LANGUAGE_FIELD_CLASSIFIER_VERSION);
        expect(projectedPass.languageFieldProjection).toEqual({ humanTextFields: ['freshlyAddedProsePolicy'] });
        // 승인 묶음도 같다. 기계·출처 값은 대상이 아니다.
        const approval = canonicalApprovalArtifact(approvalBundle({
            value: { ...approvalBundle().value, extraGeneratedField: 'An unreviewed generated line.' },
        }));
        const approvalErr = expectCode(
            () => evaluateApproval(approval),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expect(approvalErr.details.fieldPaths).toEqual(['value.extraGeneratedField']);
        // 기계 enum·사용자 브리프만 남은 정상 묶음은 통과한다.
        expect(evaluateApproval(canonicalApprovalArtifact(approvalBundle())).verdict).toBe('pass');
        // 영수증 발급도 같은 벽을 지난다.
        expectCode(
            () => issueReceipt({
                artifact: withNewField,
                languageCompliance: compliance(withNewField, { verdict: 'pass', evidence: [] }),
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
    });

    it('requires an explicit projection for an unknown generated field instead of ignoring it', () => {
        const withNewField = canonicalArtifact(bundle({
            semanticDelta: [{ entityId: 'ann', freshlyAddedProsePolicy: 'The corridor answers in English.' }],
        }));
        const evidence = [{
            fieldPath: 'semanticDelta[0].freshlyAddedProsePolicy',
            quote: 'The corridor answers in English.',
            reason: '새 생성 필드가 목표 언어가 아니다',
        }];
        const err = expectCode(
            () => evaluateLanguageCompliance({
                compliance: compliance(withNewField, { verdict: 'fail', evidence }),
                artifact: withNewField,
                workContract: WORK_CONTRACT,
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expect(err.details.reason).toBe('unclassified_field');
        // 스키마에 묶인 명시적 투영을 주면 검증할 수 있다(조용히 통과시키는 것이 아니다).
        const projected = evaluateLanguageCompliance({
            compliance: compliance(withNewField, { verdict: 'fail', evidence }),
            artifact: withNewField,
            workContract: WORK_CONTRACT,
            languageFields: { humanTextFields: ['freshlyAddedProsePolicy'] },
        });
        expect(projected.verdict).toBe('fail');
        // 투영으로 기계 계약 필드나 사용자 출처 필드를 자연어로 바꿀 수는 없다.
        for (const name of ['entityId', 'sourceBrief']) {
            expectCode(
                () => evaluateLanguageCompliance({
                    compliance: compliance(withNewField),
                    artifact: withNewField,
                    workContract: WORK_CONTRACT,
                    languageFields: { humanTextFields: [name] },
                }),
                VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE,
            );
        }
    });

    it('keeps uncertain as a non-success judgment', () => {
        const result = evaluate(artifact, { verdict: 'uncertain' });
        expect(result.satisfied).toBe(false);
        expect(result.failureCode).toBe(VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE);
    });

    it('rejects exceptions that were never approved and wildcard approvals', () => {
        expectCode(
            () => evaluate(artifact, { allowedExceptions: [{ kind: 'characterDialogue', language: 'en', scope: 'ann' }] }),
            VALIDATION_ERROR_CODES.UNAPPROVED_LANGUAGE_EXCEPTION,
        );
        expectCode(
            () => evaluate(artifact, { allowedExceptions: [{ kind: 'properNoun', language: 'fr', scope: 'Ann' }] }),
            VALIDATION_ERROR_CODES.UNAPPROVED_LANGUAGE_EXCEPTION,
        );
        // wildcard 는 기존 언어 계약 resolver 가 거부한다.
        const err = caught(() => evaluateLanguageCompliance({
            compliance: compliance(artifact),
            artifact,
            targetLanguage: 'ja',
            allowedLanguageExceptions: [{ kind: 'properNoun', language: 'en', scope: '본문', rationale: '전체 허용' }],
        }));
        expect(err).toBeInstanceOf(LanguagePolicyError);
        expect(err.code).toBe('INVALID_LANGUAGE_EXCEPTION');
    });

    it('rejects a judgment aimed at another language and a missing target', () => {
        expectCode(() => evaluate(artifact, { language: 'en' }), VALIDATION_ERROR_CODES.LANGUAGE_TARGET_MISMATCH);
        expectCode(
            () => evaluateLanguageCompliance({ compliance: compliance(artifact), artifact }),
            VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION,
        );
        const raw = {
            verdict: 'pass',
            artifactHash: computeArtifactHash(artifact),
            evidence: [],
            allowedExceptions: [],
        };
        const missingLanguage = expectCode(
            () => evaluateLanguageCompliance({ compliance: raw, artifact, workContract: WORK_CONTRACT }),
            VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE,
        );
        expect(missingLanguage.details.field).toBe('language');
        expectCode(
            () => evaluateLanguageCompliance({
                compliance: { ...raw, language: 'en' },
                artifact,
                workContract: WORK_CONTRACT,
            }),
            VALIDATION_ERROR_CODES.LANGUAGE_TARGET_MISMATCH,
        );
    });

    it('does not let an explicit target or exception list override the work contract', () => {
        const err = expectCode(
            () => evaluateLanguageCompliance({
                compliance: compliance(artifact),
                artifact,
                workContract: WORK_CONTRACT,
                targetLanguage: 'en',
            }),
            VALIDATION_ERROR_CODES.LANGUAGE_TARGET_MISMATCH,
        );
        expect(err.details.reason).toBe('explicit_target_conflicts_with_contract');
        // 같은 언어를 명시하는 것은 허용된다.
        expect(evaluateLanguageCompliance({
            compliance: compliance(artifact), artifact, workContract: WORK_CONTRACT, targetLanguage: 'ja',
        }).targetLanguage).toBe('ja');

        const wider = expectCode(
            () => evaluateLanguageCompliance({
                compliance: compliance(artifact),
                artifact,
                workContract: WORK_CONTRACT,
                allowedLanguageExceptions: [
                    ...WORK_CONTRACT.allowedLanguageExceptions,
                    { kind: 'characterDialogue', language: 'fr', scope: 'ann', rationale: '조용한 확장' },
                ],
            }),
            VALIDATION_ERROR_CODES.UNAPPROVED_LANGUAGE_EXCEPTION,
        );
        expect(wider.details.reason).toBe('exception_override_conflict');
    });

    it('hashes the judgment without its derived fields', () => {
        const first = evaluate(artifact);
        const second = evaluateLanguageCompliance({
            compliance: JSON.stringify(compliance(artifact)),
            artifact,
            targetLanguage: 'ja',
            allowedLanguageExceptions: WORK_CONTRACT.allowedLanguageExceptions,
        });
        expect(first.classifierVersion).toBe(LANGUAGE_FIELD_CLASSIFIER_VERSION);
        expect(first.languageFieldProjection).toEqual(DEFAULT_LANGUAGE_FIELD_PROJECTION);
        expect(computeLanguageComplianceHash(first)).toBe(computeLanguageComplianceHash(second));
        expect(computeLanguageComplianceHash(evaluate(artifact, { verdict: 'uncertain' })))
            .not.toBe(computeLanguageComplianceHash(first));
        expect(computeLanguageComplianceHash(persisted(first))).toBe(computeLanguageComplianceHash(first));
    });

    it('binds the caller projection and classifier version to the judgment hash', () => {
        const extras = { humanTextFields: ['freshlyAddedProsePolicy'] };
        const omitted = evaluate(artifact);
        const empty = evaluateLanguageCompliance({
            compliance: compliance(artifact),
            artifact,
            workContract: WORK_CONTRACT,
            languageFields: { humanTextFields: [] },
        });
        const projected = evaluateLanguageCompliance({
            compliance: compliance(artifact),
            artifact,
            workContract: WORK_CONTRACT,
            languageFields: extras,
        });
        const reordered = evaluateLanguageCompliance({
            compliance: compliance(artifact),
            artifact,
            workContract: WORK_CONTRACT,
            languageFields: { humanTextFields: ['freshlyAddedProsePolicy', 'freshlyAddedProsePolicy'] },
        });
        // 생략과 빈 추가는 같은 기본 투영이다. 기본 API 는 그대로 동작한다.
        expect(computeLanguageComplianceHash(omitted)).toBe(computeLanguageComplianceHash(empty));
        expect(computeLanguageFieldProjectionHash(null))
            .toBe(computeLanguageFieldProjectionHash({ humanTextFields: [] }));
        // 같은 판정·같은 근거라도 추가 이름이 있으면 스키마 해석이 달라지므로 hash 가 달라진다.
        expect(computeLanguageComplianceHash(projected)).not.toBe(computeLanguageComplianceHash(omitted));
        expect(projected.languageFieldProjection).toEqual({ humanTextFields: ['freshlyAddedProsePolicy'] });
        expect(computeLanguageComplianceHash(reordered)).toBe(computeLanguageComplianceHash(projected));
        expect(computeLanguageFieldProjectionHash({ humanTextFields: ['zetaLeaf', 'alphaLeaf'] }))
            .toBe(computeLanguageFieldProjectionHash({ humanTextFields: ['alphaLeaf', 'zetaLeaf'] }));
    });
});

describe('evaluateLanguageCompliance on approval artifacts', () => {
    const artifact = canonicalApprovalArtifact(approvalBundle());

    it('judges the approval value without inventing chapter prose or title', () => {
        const result = evaluateApproval(artifact);
        expect(result.verdict).toBe('pass');
        expect(result.artifactKind).toBe('approval');
        expect(result.targetLanguage).toBe('en');
        expect(result.artifactHash).toBe(computeArtifactHash(approvalBundle()));
    });

    it('resolves evidence against the actual value fields', () => {
        const result = evaluateApproval(artifact, {
            verdict: 'fail',
            evidence: [
                { fieldPath: 'value.readerPromise', quote: 'A door that answers back.', reason: '독자 약속이 목표 언어가 아니다' },
                { fieldPath: 'value.openingPressure', quote: 'The house refuses to stay shut.', reason: '도입 압력 확인' },
            ],
        });
        expect(result.verdict).toBe('fail');
        expect(result.evidence).toHaveLength(2);
        // chapter 필드 경로는 승인 묶음에 존재하지 않는다.
        expectCode(
            () => evaluateApproval(artifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'prose', quote: 'A door', reason: '본문이 오언어' }],
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
    });

    it('exempts machine enums, revision and the user-provided brief', () => {
        const koEnum = expectCode(
            () => evaluateApproval(artifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'value.pov', quote: '3인칭제한', reason: '한국어 값이 섞였다' }],
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expect(koEnum.details.reason).toBe('machine_field');
        const engineGenre = expectCode(
            () => evaluateApproval(artifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'value.engineGenre', quote: 'other', reason: 'enum' }],
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expect(engineGenre.details.reason).toBe('machine_field');
        // 사용자가 한국어로 준 브리프는 영어 작품에서도 위반이 아니다.
        const brief = expectCode(
            () => evaluateApproval(artifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'value.sourceBrief', quote: '문을 여는 이야기를 써줘', reason: '한국어 브리프' }],
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expect(brief.details.reason).toBe('user_provenance_field');
        const revision = expectCode(
            () => evaluateApproval(artifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'revision', quote: '3', reason: '개정 번호' }],
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        expect(revision.details.reason).toBe('machine_exempt_field');
    });

    it('covers generated arc, writer and episode fields', () => {
        const arc = canonicalApprovalArtifact({
            kind: 'arc',
            revision: 1,
            value: {
                title: 'The Shut House',
                promise: 'The door will answer.',
                openingContract: {
                    surfaceEvent: 'A knock at dawn.',
                    worldPressure: 'The town counts its doors.',
                    characterWound: 'She was locked out once.',
                    misbelief: 'Doors only open for the invited.',
                    firstIrreversibleChoice: 'She turns the handle.',
                    withheldContext: 'The house remembers her.',
                    viewpointReason: 'Her ignorance is the suspense.',
                },
                audition: 'A writer who hears hinges.',
                craftReason: 'Keeps the reader at the threshold.',
                premise: 'A house that refuses guests.',
                promisePaid: 'The door opens inward.',
            },
        });
        const jaContract = buildLanguageContract({ language: 'ja' });
        for (const [fieldPath, quote] of [
            ['value.title', 'The Shut House'],
            ['value.promise', 'The door will answer.'],
            ['value.openingContract.surfaceEvent', 'A knock at dawn.'],
            ['value.openingContract.worldPressure', 'The town counts its doors.'],
            ['value.openingContract.characterWound', 'She was locked out once.'],
            ['value.openingContract.misbelief', 'Doors only open for the invited.'],
            ['value.openingContract.firstIrreversibleChoice', 'She turns the handle.'],
            ['value.openingContract.withheldContext', 'The house remembers her.'],
            ['value.openingContract.viewpointReason', 'Her ignorance is the suspense.'],
            ['value.audition', 'A writer who hears hinges.'],
            ['value.craftReason', 'Keeps the reader at the threshold.'],
            ['value.premise', 'A house that refuses guests.'],
            ['value.promisePaid', 'The door opens inward.'],
        ]) {
            const result = evaluateLanguageCompliance({
                compliance: approvalCompliance(arc, {
                    verdict: 'fail',
                    language: 'ja',
                    evidence: [{ fieldPath, quote, reason: '목표 언어가 아니다' }],
                }),
                artifact: arc,
                workContract: jaContract,
            });
            expect(result.evidence[0].fieldPath).toBe(fieldPath);
        }
    });

    it('accepts a scalar approval value as one natural-text field', () => {
        const scalar = canonicalApprovalArtifact({ kind: 'story', revision: 2, value: 'A door that answers back.' });
        const result = evaluateLanguageCompliance({
            compliance: approvalCompliance(scalar, {
                verdict: 'fail',
                language: 'ja',
                evidence: [{ fieldPath: 'value', quote: 'A door that answers back.', reason: '목표 언어가 아니다' }],
            }),
            artifact: scalar,
            workContract: buildLanguageContract({ language: 'ja' }),
        });
        expect(result.verdict).toBe('fail');
    });
});

// ─── 필수 불변식 coverage ───────────────────────────────────────────────────

describe('evaluateInvariantCoverage', () => {
    it('accepts a plan whose mandatory invariants are all validated', () => {
        const result = completeCoverage();
        expect(result.complete).toBe(true);
        expect(result.blocked).toEqual([]);
        expect(result.artifactKind).toBe('chapter');
        for (const id of ALWAYS_MANDATORY_INVARIANTS)
            expect(result.requiredIds).toContain(id);
        // 화 원고의 필수 집합은 등록표의 무조건 불변식 전부다.
        for (const id of CHAPTER_REQUIRED_INVARIANTS)
            expect(result.requiredIds).toContain(id);
        expect(result.requiredIds).toEqual([...result.requiredIds].sort());
        expect(result.checkerPlanHash).toBe(computeCheckerPlanHash({ plan: registryPlan(), artifactKind: 'chapter' }));
    });

    it('rejects a chapter plan that silently omits registry invariants', () => {
        // SCHEMA/LENGTH/OUTPUT_LANGUAGE 만으로는 화 원고 coverage 가 성립하지 않는다.
        const err = expectCode(
            () => evaluateInvariantCoverage({
                plan: { requiredInvariantIds: ['SCHEMA', 'LENGTH', 'OUTPUT_LANGUAGE'] },
                coverage: { SCHEMA: 'validated', LENGTH: 'validated', OUTPUT_LANGUAGE: 'validated' },
                artifactKind: 'chapter',
            }),
            VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN,
        );
        expect(err.details.reason).toBe('missing_mandatory_invariant');
        expect(err.details.missing).toEqual(['INTRINSIC', 'WORLD', 'REGISTRATION', 'FORMAT']);
        // artifactKind 를 밝히지 않은 호출도 같은(가장 엄격한) 필수 집합을 받는다.
        expectCode(
            () => evaluateInvariantCoverage({
                plan: { requiredInvariantIds: ['SCHEMA', 'LENGTH', 'OUTPUT_LANGUAGE'] },
                coverage: { SCHEMA: 'validated', LENGTH: 'validated', OUTPUT_LANGUAGE: 'validated' },
            }),
            VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN,
        );
    });

    it('requires the conditional invariants to be resolved by the live plan', () => {
        const err = expectCode(
            () => evaluateInvariantCoverage({
                plan: { requiredInvariantIds: [...CHAPTER_REQUIRED_INVARIANTS] },
                coverage: chapterCoverageMap(),
                artifactKind: 'chapter',
            }),
            VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN,
        );
        expect(err.details.reason).toBe('unresolved_conditional_invariant');
        expect(err.details.missing).toEqual([...CHAPTER_CONDITIONAL_INVARIANTS]);
        // 계획이 실제 맥락으로 확정하면(required / not_applicable / advisory) 통과한다.
        expect(evaluateInvariantCoverage({
            plan: explicitChapterPlan(), coverage: chapterCoverageMap(), artifactKind: 'chapter',
        }).complete).toBe(true);
    });

    it('uses a smaller required set for approval bundles but refuses chapter-only checks', () => {
        const approval = evaluateInvariantCoverage({
            plan: APPROVAL_PLAN,
            coverage: { SCHEMA: 'validated', OUTPUT_LANGUAGE: 'validated' },
            artifactKind: 'approval',
        });
        expect(approval.complete).toBe(true);
        expect(approval.requiredIds).toEqual([...APPROVAL_REQUIRED_INVARIANTS].sort());
        expect(approval.artifactKind).toBe('approval');
        // 승인 묶음에는 원고가 없다. 가짜 LENGTH 게이트를 붙이지 않는다.
        for (const id of APPROVAL_FORBIDDEN_INVARIANTS) {
            const err = expectCode(
                () => evaluateInvariantCoverage({
                    plan: { requiredInvariantIds: [...APPROVAL_REQUIRED_INVARIANTS, id] },
                    coverage: { SCHEMA: 'validated', OUTPUT_LANGUAGE: 'validated', [id]: 'validated' },
                    artifactKind: 'approval',
                }),
                VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN,
            );
            expect(err.details.reason).toBe('chapter_only_invariant');
        }
        // 실제로 필요한 구조 검사는 더할 수 있다.
        expect(evaluateInvariantCoverage({
            plan: { requiredInvariantIds: [...APPROVAL_REQUIRED_INVARIANTS, 'REGISTRATION'] },
            coverage: { SCHEMA: 'validated', OUTPUT_LANGUAGE: 'validated', REGISTRATION: 'validated' },
            artifactKind: 'approval',
        }).complete).toBe(true);
        // 승인용 계획을 화 원고에 쓰면 필수가 빠진다.
        expectCode(
            () => evaluateInvariantCoverage({ plan: APPROVAL_PLAN, coverage: {}, artifactKind: 'chapter' }),
            VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN,
        );
    });

    it('binds the plan hash to the artifact kind and the resolved rows', () => {
        const chapterHash = computeCheckerPlanHash({ plan: explicitChapterPlan(), artifactKind: 'chapter' });
        expect(chapterHash).toMatch(/^[0-9a-f]{64}$/);
        expect(chapterHash).toBe(computeCheckerPlanHash({ plan: explicitChapterPlan(), artifactKind: 'chapter' }));
        expect(computeCheckerPlanHash({
            plan: explicitChapterPlan({
                requiredInvariantIds: [...CHAPTER_REQUIRED_INVARIANTS, 'POV', 'ADDRESSING'],
                notApplicableInvariantIds: [],
            }),
            artifactKind: 'chapter',
        })).not.toBe(chapterHash);
        expect(computeCheckerPlanHash({ plan: APPROVAL_PLAN, artifactKind: 'approval' })).not.toBe(chapterHash);
    });

    it('blocks a required invariant that is missing, unvalidated, failed, uncertain or error', () => {
        const plan = registryPlan();
        const withoutPov = { ...ALL_SEMANTIC_PASS };
        delete withoutPov.POV;
        const uncertainPov = evaluateInvariantCoverage({
            plan, coverage: registryCoverage(plan, withoutPov), artifactKind: 'chapter',
        });
        expect(uncertainPov.complete).toBe(false);
        expect(uncertainPov.blocked).toContainEqual({ id: 'POV', coverage: 'unvalidated', reason: 'unvalidated' });
        // 출력 언어 통과가 미검증 의미 불변식을 대신하지 못한다.
        expect(uncertainPov.coverageById.OUTPUT_LANGUAGE).toBe('validated');

        for (const [value, reason] of [['failed', 'failed'], ['uncertain', 'uncertain'], ['error', 'error']]) {
            const result = evaluateInvariantCoverage({
                plan: explicitChapterPlan(),
                coverage: chapterCoverageMap({ POV: value }),
                artifactKind: 'chapter',
            });
            expect(result.complete).toBe(false);
            expect(result.blocked).toContainEqual({ id: 'POV', coverage: value, reason });
        }
        const missing = evaluateInvariantCoverage({
            plan: explicitChapterPlan(),
            coverage: chapterCoverageMap({ POV: undefined }),
            artifactKind: 'chapter',
        });
        expect(missing.blocked).toContainEqual({ id: 'POV', coverage: null, reason: 'missing' });
    });

    it('keeps a detector error unvalidated even when the semantic answer passed', () => {
        // 정정된 등록표(a18317f)의 의미를 그대로 판정한다.
        const errored = completeCoverage(ALL_SEMANTIC_PASS, [
            { checkerId: 'scanWebnovelFormat', status: 'error', violations: [], error: 'boom' },
        ]);
        expect(errored.complete).toBe(false);
        expect(errored.blocked).toContainEqual({ id: 'FORMAT', coverage: 'unvalidated', reason: 'unvalidated' });
    });

    it('does not let a submitted not_applicable waive a required invariant', () => {
        const result = evaluateInvariantCoverage({
            plan: explicitChapterPlan(),
            coverage: chapterCoverageMap({ POV: 'not_applicable' }),
            artifactKind: 'chapter',
        });
        expect(result.complete).toBe(false);
        expect(result.blocked).toContainEqual({ id: 'POV', coverage: 'not_applicable', reason: 'not_applicable_cannot_waive' });
    });

    it('accepts non-applicability only when the plan itself marks no contract', () => {
        // 시점 계약이 없는 작품: 계획이 POV 를 not_applicable 로 확정한다.
        const plan = registryPlan({ povMode: 'none' });
        const coverage = registryCoverage(plan, ALL_SEMANTIC_PASS);
        const result = evaluateInvariantCoverage({ plan, coverage, artifactKind: 'chapter' });
        expect(result.requiredIds).not.toContain('POV');
        expect(result.notApplicableIds).toContain('POV');
        expect(result.complete).toBe(true);
    });

    it('never lets soft or advisory results block', () => {
        const plan = registryPlan();
        const result = evaluateInvariantCoverage({
            plan,
            artifactKind: 'chapter',
            coverage: {
                ...Object.fromEntries(plan.rows
                    .filter((row) => row.invariantId && row.invariant === 'required')
                    .map((row) => [row.invariantId, 'validated'])),
                SENSITIVE: 'failed',
                STYLE_ADVISORY: 'failed',
            },
        });
        expect(result.complete).toBe(true);
        expect(result.advisory).toContainEqual({ id: 'SENSITIVE', coverage: 'failed' });
        expect(result.unrecognized).toContain('STYLE_ADVISORY');
    });

    it('refuses empty, unresolved and unknown-kind plans', () => {
        expectCode(
            () => evaluateInvariantCoverage({ plan: { requiredInvariantIds: [] }, coverage: {}, artifactKind: 'chapter' }),
            VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN,
        );
        expectCode(
            () => evaluateInvariantCoverage({
                plan: { rows: [{ invariantId: 'SCHEMA', invariant: 'conditional' }] },
                coverage: {},
                artifactKind: 'chapter',
            }),
            VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN,
        );
        expectCode(
            () => evaluateInvariantCoverage({ plan: explicitChapterPlan(), coverage: {}, artifactKind: 'novel' }),
            VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN,
        );
    });

    it('rejects malformed coverage reports instead of guessing', () => {
        expectCode(
            () => evaluateInvariantCoverage({
                plan: explicitChapterPlan(), coverage: { SCHEMA: 'passed' }, artifactKind: 'chapter',
            }),
            VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT,
        );
        expectCode(
            () => evaluateInvariantCoverage({ plan: explicitChapterPlan(), coverage: 'validated', artifactKind: 'chapter' }),
            VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT,
        );
    });

    it('hashes coverage over the kind, plan, required set and its values', () => {
        const complete = completeCoverage();
        const noPov = { ...ALL_SEMANTIC_PASS };
        delete noPov.POV;
        expect(computeCoverageHash(complete)).toBe(computeCoverageHash(completeCoverage()));
        expect(computeCoverageHash(completeCoverage(noPov))).not.toBe(computeCoverageHash(complete));
        // 저장·재적재를 거쳐도 같은 값이어야 hash 비교가 성립한다.
        expect(computeCoverageHash(persisted(complete))).toBe(computeCoverageHash(complete));
    });
});

// ─── 검사 영수증 ────────────────────────────────────────────────────────────

describe('buildValidationReceipt', () => {
    it('issues a passed receipt pinned to contract, artifact, plan, judgment and coverage', () => {
        const receipt = issueReceipt();
        expect(receipt.verdict).toBe('passed');
        expect(receipt.artifactKind).toBe('chapter');
        expect(receipt.contractHash).toBe(computeLanguageContractHash(WORK_CONTRACT));
        expect(receipt.artifactHash).toBe(computeArtifactHash(bundle()));
        expect(receipt.checkerPlanHash).toBe(computeCheckerPlanHash({ plan: registryPlan(), artifactKind: 'chapter' }));
        expect(receipt.consumed).toBe(false);
        expect(receipt.stale).toBe(false);
        expect(receipt.checkId).toBe(computeReceiptCheckId(receipt));
        expect(receipt.validatorVersion).toBe(VALIDATOR_VERSION);
        expect(receipt.languageFieldProjectionHash).toBe(computeLanguageFieldProjectionHash(null));
    });

    it('accepts either the raw registry report or an evaluated coverage object', () => {
        const plan = registryPlan();
        const raw = issueReceipt({ coverage: registryCoverage(plan, ALL_SEMANTIC_PASS) });
        expect(raw.coverageHash).toBe(issueReceipt().coverageHash);
        // 저장됐다 돌아온 결과도 같은 계획으로 다시 평가된다.
        expect(issueReceipt({ coverage: persisted(completeCoverage()) }).coverageHash).toBe(raw.coverageHash);
    });

    it('refuses to issue on fail, uncertain or incomplete coverage', () => {
        const artifact = canonicalArtifact(bundle());
        expectCode(() => issueReceipt({
            languageCompliance: evaluate(artifact, {
                verdict: 'fail',
                evidence: [{ fieldPath: 'title', quote: '扉の向こう', reason: '제목이 목표 언어가 아니다' }],
            }),
        }), VALIDATION_ERROR_CODES.OUTPUT_LANGUAGE_MISMATCH);
        expectCode(
            () => issueReceipt({ languageCompliance: evaluate(artifact, { verdict: 'uncertain' }) }),
            VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE,
        );
        const withoutPov = { ...ALL_SEMANTIC_PASS };
        delete withoutPov.POV;
        // 출력 언어가 통과여도 미검증 의미 불변식이 남으면 영수증이 없다.
        expectCode(() => issueReceipt({ coverage: completeCoverage(withoutPov) }), VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE);
    });

    it('refuses a judgment that was made about another artifact', () => {
        const other = canonicalArtifact(bundle({ title: '別の扉' }));
        expectCode(
            () => issueReceipt({ languageCompliance: evaluate(other) }),
            VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH,
        );
    });

    it('does not issue an English-contract receipt when a Japanese artifact omits or mismatches language', () => {
        const artifact = canonicalArtifact(bundle());
        const raw = {
            verdict: 'pass',
            artifactHash: computeArtifactHash(artifact),
            evidence: [],
            allowedExceptions: [],
        };
        expectCode(
            () => buildValidationReceipt({
                ...IDENTITY,
                workContract: EN_CONTRACT,
                artifact,
                checkerPlan: registryPlan(),
                languageCompliance: raw,
                coverage: completeCoverage(),
            }),
            VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE,
        );
        expectCode(
            () => buildValidationReceipt({
                ...IDENTITY,
                workContract: EN_CONTRACT,
                artifact,
                checkerPlan: registryPlan(),
                languageCompliance: { ...raw, language: 'ja' },
                coverage: completeCoverage(),
            }),
            VALIDATION_ERROR_CODES.LANGUAGE_TARGET_MISMATCH,
        );
    });

    it('does not trust a caller-supplied pass verdict', () => {
        const artifact = canonicalArtifact(bundle());
        const honest = evaluate(artifact);
        // 판정 대상 언어를 바꿔 저장한 결과.
        expectCode(
            () => issueReceipt({ languageCompliance: { ...honest, targetLanguage: 'en' } }),
            VALIDATION_ERROR_CODES.LANGUAGE_TARGET_MISMATCH,
        );
        // 실제로는 본문에 없는 인용을 근거로 붙인 채 'pass' 라고 신고한 결과.
        expectCode(
            () => issueReceipt({
                languageCompliance: {
                    ...honest,
                    evidence: [{ fieldPath: 'prose', quote: 'The door opened.', reason: '조작된 근거' }],
                },
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
        // 승인되지 않은 예외를 스스로 붙인 결과.
        expectCode(
            () => issueReceipt({
                languageCompliance: {
                    ...honest,
                    allowedExceptions: [{ kind: 'characterDialogue', language: 'fr', scope: 'ann' }],
                },
            }),
            VALIDATION_ERROR_CODES.UNAPPROVED_LANGUAGE_EXCEPTION,
        );
        // 평가 결과 모양을 흉내 낸 임의 객체도 권한이 아니다.
        expectCode(
            () => issueReceipt({ languageCompliance: { ...honest, branded: true } }),
            VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE,
        );
    });

    it('does not trust a caller-supplied complete coverage', () => {
        // 자기 신고 requiredIds 는 필수 집합을 낮추지 못한다.
        const err = expectCode(
            () => issueReceipt({ coverage: { complete: true, requiredIds: [], coverageById: {} } }),
            VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE,
        );
        expect(err.details.blocked.map((row) => row.id)).toContain('WORLD');
        const tampered = persisted(completeCoverage());
        tampered.coverageById.WORLD = 'unvalidated';
        expectCode(() => issueReceipt({ coverage: tampered }), VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE);
        const dropped = persisted(completeCoverage());
        delete dropped.coverageById.INTRINSIC;
        dropped.requiredIds = dropped.requiredIds.filter((id) => id !== 'INTRINSIC');
        expectCode(() => issueReceipt({ coverage: dropped }), VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE);
    });

    it('requires an explicit trusted checker plan and an explicit source head key', () => {
        expectCode(() => issueReceipt({ checkerPlan: null }), VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION);
        const noHead = { ...IDENTITY };
        delete noHead.sourceHead;
        const artifact = canonicalArtifact(bundle());
        const err = expectCode(() => buildValidationReceipt({
            ...noHead,
            workContract: WORK_CONTRACT,
            artifact,
            checkerPlan: registryPlan(),
            languageCompliance: evaluate(artifact),
            coverage: completeCoverage(),
        }), VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION);
        expect(err.details.missing).toEqual(['sourceHead']);
        expectCode(() => issueReceipt({ sourceHead: undefined }), VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION);
    });

    it('accepts sourceHead null before the first publication', () => {
        // 최초 발행 전에는 원천 HEAD 가 없다. 가짜 genesis 식별자를 지어내지 않는다.
        const receipt = issueReceipt({ sourceHead: null });
        expect(receipt.sourceHead).toBeNull();
        const result = validateValidationReceipt({
            receipt,
            expected: expectation({ sourceHead: null }),
            ...requiredProofs(),
        });
        expect(result.sourceHead).toBeNull();
        // 최초 발행 뒤의 실제 HEAD 와는 다른 검사다.
        expect(receipt.checkId).not.toBe(issueReceipt().checkId);
        expectCode(
            () => validateValidationReceipt({ receipt, expected: expectation(), ...requiredProofs() }),
            VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH,
        );
        // planSourceHash 는 여전히 실제 digest 여야 한다.
        expectCode(() => issueReceipt({ planSourceHash: null }), VALIDATION_ERROR_CODES.INVALID_RECEIPT);
    });

    it('issues an approval receipt without fabricating chapter fields', () => {
        const artifact = canonicalApprovalArtifact(approvalBundle());
        const coverage = evaluateInvariantCoverage({
            plan: APPROVAL_PLAN,
            coverage: { SCHEMA: 'validated', OUTPUT_LANGUAGE: 'validated' },
            artifactKind: 'approval',
        });
        const receipt = buildValidationReceipt({
            workId: 'w1',
            chapter: null,
            workflowId: 'wf-profile',
            validationEpoch: 1,
            sourceHead: null,
            planSourceHash: 'plan-profile',
            workContract: EN_CONTRACT,
            artifact,
            checkerPlan: APPROVAL_PLAN,
            languageCompliance: evaluateApproval(artifact),
            coverage,
        });
        expect(receipt.artifactKind).toBe('approval');
        expect(receipt.chapter).toBeNull();
        expect(receipt.artifactHash).toBe(computeArtifactHash(approvalBundle()));
        const expected = {
            workId: 'w1',
            chapter: null,
            workflowId: 'wf-profile',
            validationEpoch: 1,
            sourceHead: null,
            planSourceHash: 'plan-profile',
            artifactKind: 'approval',
            checkerPlan: APPROVAL_PLAN,
            contractHash: computeLanguageContractHash(EN_CONTRACT),
            artifactHash: computeArtifactHash(approvalBundle()),
        };
        expect(validateValidationReceipt({
            receipt,
            expected,
            artifact: approvalBundle(),
            workContract: EN_CONTRACT,
            languageCompliance: evaluateApproval(artifact),
            coverage,
        }).ok).toBe(true);
        // 승인 영수증을 화 원고 검사로 소비할 수 없다.
        expectCode(
            () => validateValidationReceipt({
                receipt,
                expected: { ...expected, artifactKind: 'chapter' },
                artifact: approvalBundle(),
                workContract: EN_CONTRACT,
                languageCompliance: evaluateApproval(artifact),
                coverage,
            }),
            VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH,
        );
    });
});

describe('validateValidationReceipt', () => {
    it('accepts the receipt it issued for the same bundle, contract and plan', () => {
        const receipt = issueReceipt();
        const result = validateValidationReceipt({
            receipt,
            expected: expectation({ minValidationEpoch: 3 }),
            ...requiredProofs(),
        });
        expect(result.ok).toBe(true);
        expect(result.checkId).toBe(receipt.checkId);
        expect(result.artifactKind).toBe('chapter');
    });

    it('survives JSON persistence without loosening any check', () => {
        const receipt = persisted(issueReceipt());
        expect(validateValidationReceipt({
            receipt,
            expected: expectation(),
            ...requiredProofs({
                languageCompliance: persisted(evaluate(canonicalArtifact(bundle()))),
                coverage: persisted(completeCoverage()),
            }),
        }).ok).toBe(true);

        // 재적재 뒤 한 항목만 낮춘 보고는 통과하지 못한다.
        const forged = persisted(completeCoverage());
        forged.coverageById.REGISTRATION = 'uncertain';
        expectCode(
            () => validateValidationReceipt({
                receipt, expected: expectation(), ...requiredProofs({ coverage: forged }),
            }),
            VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE,
        );

        // 자기 신고 complete 는 신뢰 계획으로 다시 평가되므로 근거가 아니다.
        const empty = expectCode(
            () => validateValidationReceipt({
                receipt,
                expected: expectation(),
                ...requiredProofs({ coverage: { complete: true, requiredIds: [], coverageById: {} } }),
            }),
            VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE,
        );
        expect(empty.details.blocked.map((row) => row.id)).toContain('WORLD');
        const missingEntry = persisted(completeCoverage());
        delete missingEntry.coverageById.FORMAT;
        expectCode(
            () => validateValidationReceipt({
                receipt, expected: expectation(), ...requiredProofs({ coverage: missingEntry }),
            }),
            VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE,
        );
        // 언어 판정도 마찬가지다.
        expectCode(
            () => validateValidationReceipt({
                receipt,
                expected: expectation(),
                ...requiredProofs({
                    languageCompliance: { ...persisted(evaluate(canonicalArtifact(bundle()))), targetLanguage: 'en' },
                }),
            }),
            VALIDATION_ERROR_CODES.LANGUAGE_TARGET_MISMATCH,
        );
        expectCode(
            () => validateValidationReceipt({
                receipt,
                expected: expectation(),
                ...requiredProofs({
                    languageCompliance: {
                        ...persisted(evaluate(canonicalArtifact(bundle()))),
                        evidence: [{ fieldPath: 'prose', quote: 'The door opened.', reason: '조작된 근거' }],
                    },
                }),
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE,
        );
    });

    it('rejects a hash-only checker plan and omitted consumption proofs', () => {
        const receipt = issueReceipt();
        const hashOnly = expectation({ checkerPlanHash: receipt.checkerPlanHash });
        delete hashOnly.checkerPlan;
        const omittedPlan = expectCode(
            () => validateValidationReceipt({ receipt, expected: hashOnly, ...requiredProofs() }),
            VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION,
        );
        expect(omittedPlan.details.missing).toContain('checkerPlan');

        const omittedProofs = expectCode(
            () => validateValidationReceipt({ receipt, expected: expectation() }),
            VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION,
        );
        expect(omittedProofs.details.missing).toEqual(expect.arrayContaining([
            'artifact', 'workContract', 'languageCompliance', 'coverage',
        ]));

        // 검사한 적 없는 영수증에 신원 hash 와 checkId 만 맞춰 넣어도 보고서 없이는 통과가 아니다.
        const dummy = {
            schemaVersion: 1,
            validatorVersion: VALIDATOR_VERSION,
            verdict: 'passed',
            ...IDENTITY,
            runId: null,
            artifactKind: 'chapter',
            checkerPlanHash: computeCheckerPlanHash({ plan: registryPlan(), artifactKind: 'chapter' }),
            languageFieldProjectionHash: computeLanguageFieldProjectionHash(null),
            contractHash: computeLanguageContractHash(WORK_CONTRACT),
            artifactHash: computeArtifactHash(bundle()),
            languageComplianceHash: 'b'.repeat(64),
            coverageHash: 'c'.repeat(64),
            consumed: false,
            stale: false,
            staleReason: null,
            issuedBy: 'forged',
            checkId: '',
        };
        dummy.checkId = computeReceiptCheckId(dummy);
        const dummyExpected = expectation({
            checkerPlanHash: dummy.checkerPlanHash,
            contractHash: dummy.contractHash,
            artifactHash: dummy.artifactHash,
            languageComplianceHash: dummy.languageComplianceHash,
            coverageHash: dummy.coverageHash,
        });
        expectCode(
            () => validateValidationReceipt({ receipt: dummy, expected: dummyExpected }),
            VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION,
        );
        expectCode(
            () => validateValidationReceipt({ receipt: dummy, expected: dummyExpected, ...requiredProofs() }),
            VALIDATION_ERROR_CODES.LANGUAGE_COMPLIANCE_HASH_MISMATCH,
        );
    });

    it('does not let an expected plan hash override a mismatching trusted plan', () => {
        const receipt = issueReceipt();
        const widerPlan = explicitChapterPlan({
            requiredInvariantIds: [...CHAPTER_REQUIRED_INVARIANTS, 'POV', 'ADDRESSING'],
            notApplicableInvariantIds: [],
        });
        expectCode(
            () => validateValidationReceipt({
                receipt,
                expected: expectation({
                    checkerPlan: widerPlan,
                    checkerPlanHash: receipt.checkerPlanHash,
                }),
                ...requiredProofs(),
            }),
            VALIDATION_ERROR_CODES.CHECKER_PLAN_MISMATCH,
        );
    });

    it('blocks a missing, malformed or forged receipt', () => {
        expectCode(
            () => validateValidationReceipt({ receipt: null, expected: expectation() }),
            VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT,
        );
        expectCode(
            () => validateValidationReceipt({
                receipt: { workId: 'w1' }, expected: expectation(), ...requiredProofs(),
            }),
            VALIDATION_ERROR_CODES.INVALID_RECEIPT,
        );
        // 신원 값을 바꾸고 checkId 를 그대로 둔 영수증은 위조다.
        const forged = { ...issueReceipt(), sourceHead: 'head-xyz' };
        const err = expectCode(
            () => validateValidationReceipt({
                receipt: forged, expected: expectation({ sourceHead: 'head-xyz' }), ...requiredProofs(),
            }),
            VALIDATION_ERROR_CODES.INVALID_RECEIPT,
        );
        expect(err.details.reason).toBe('check_id_mismatch');
    });

    it('refuses to verify against an incomplete expectation', () => {
        const receipt = issueReceipt();
        const partial = expectation();
        delete partial.planSourceHash;
        const err = expectCode(
            () => validateValidationReceipt({ receipt, expected: partial, ...requiredProofs() }),
            VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION,
        );
        expect(err.details.missing).toContain('planSourceHash');
        const noArtifact = expectCode(
            () => validateValidationReceipt({
                receipt,
                expected: expectation(),
                workContract: WORK_CONTRACT,
                languageCompliance: evaluate(canonicalArtifact(bundle())),
                coverage: completeCoverage(),
            }),
            VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION,
        );
        expect(noArtifact.details.missing).toContain('artifact');
        // 원천 HEAD 는 null 이 정당하지만 키 자체가 빠지면 확인하지 않은 값이다.
        const noHead = expectation();
        delete noHead.sourceHead;
        expect(expectCode(
            () => validateValidationReceipt({ receipt, expected: noHead, ...requiredProofs() }),
            VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION,
        ).details.missing).toContain('sourceHead');
        // 검사 계획 없이는 조건부 필수 집합을 재구성할 수 없다.
        const noPlan = expectation();
        delete noPlan.checkerPlan;
        expect(expectCode(
            () => validateValidationReceipt({ receipt, expected: noPlan, ...requiredProofs() }),
            VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION,
        ).details.missing).toContain('checkerPlan');
        const noKind = expectation();
        delete noKind.artifactKind;
        expect(expectCode(
            () => validateValidationReceipt({ receipt, expected: noKind, ...requiredProofs() }),
            VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION,
        ).details.missing).toContain('artifactKind');
    });

    it('blocks cross-work, cross-chapter, cross-run, head and plan mismatches', () => {
        const receipt = issueReceipt();
        for (const [field, value] of [
            ['workId', 'w2'],
            ['chapter', 13],
            ['sourceHead', 'head-xyz'],
            ['planSourceHash', 'plan-xyz'],
            ['workflowId', 'wf-8'],
        ]) {
            const err = expectCode(
                () => validateValidationReceipt({
                    receipt, expected: expectation({ [field]: value }), ...requiredProofs(),
                }),
                VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH,
            );
            expect(err.details.field).toBe(field);
        }
        expectCode(
            () => validateValidationReceipt({
                receipt, expected: expectation({ runId: 'run-1' }), ...requiredProofs(),
            }),
            VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH,
        );
    });

    it('blocks a receipt issued under a different checker plan', () => {
        const receipt = issueReceipt();
        const widerPlan = explicitChapterPlan({
            requiredInvariantIds: [...CHAPTER_REQUIRED_INVARIANTS, 'POV', 'ADDRESSING'],
            notApplicableInvariantIds: [],
        });
        expectCode(
            () => validateValidationReceipt({
                receipt, expected: expectation({ checkerPlan: widerPlan }), ...requiredProofs(),
            }),
            VALIDATION_ERROR_CODES.CHECKER_PLAN_MISMATCH,
        );
        // 계획이 실제로 요구하는 것보다 적게 신고한 coverage 는 재평가에서 막힌다.
        const narrowed = persisted(completeCoverage());
        narrowed.coverageById.POV = 'unvalidated';
        expectCode(
            () => validateValidationReceipt({
                receipt, expected: expectation(), ...requiredProofs({ coverage: narrowed }),
            }),
            VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE,
        );
    });

    it('blocks contract, artifact, judgment and coverage hash drift', () => {
        const receipt = issueReceipt();
        const otherContract = buildLanguageContract({ language: 'ja', length: { unit: 'graphemes', target: 2400 } });
        expectCode(
            () => validateValidationReceipt({
                receipt, expected: expectation(), ...requiredProofs({ workContract: otherContract }),
            }),
            VALIDATION_ERROR_CODES.CONTRACT_HASH_MISMATCH,
        );
        // 검사 뒤 요약만 바꾼 묶음은 같은 영수증으로 발행할 수 없다.
        expectCode(
            () => validateValidationReceipt({
                receipt,
                expected: expectation({ artifactHash: computeArtifactHash(bundle({ summary: '다시 쓴 요약' })) }),
                ...requiredProofs({ artifact: bundle({ summary: '다시 쓴 요약' }) }),
            }),
            VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH,
        );
        expectCode(
            () => validateValidationReceipt({
                receipt,
                expected: expectation(),
                ...requiredProofs({
                    // 같은 묶음·같은 verdict 라도 근거·예외가 다르면 다른 판정이다.
                    languageCompliance: evaluate(canonicalArtifact(bundle()), {
                        allowedExceptions: [{ kind: 'properNoun', language: 'en', scope: 'Ann' }],
                    }),
                }),
            }),
            VALIDATION_ERROR_CODES.LANGUAGE_COMPLIANCE_HASH_MISMATCH,
        );
        const withoutPov = { ...ALL_SEMANTIC_PASS };
        delete withoutPov.POV;
        expectCode(
            () => validateValidationReceipt({
                receipt, expected: expectation(), ...requiredProofs({ coverage: completeCoverage(withoutPov) }),
            }),
            VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE,
        );
    });

    it('blocks consumed receipts and validator version drift', () => {
        const receipt = issueReceipt();
        expectCode(
            () => validateValidationReceipt({
                receipt: markReceiptConsumed(receipt), expected: expectation(), ...requiredProofs(),
            }),
            VALIDATION_ERROR_CODES.RECEIPT_ALREADY_CONSUMED,
        );
        expectCode(
            () => validateValidationReceipt({
                receipt: issueReceipt({ validatorVersion: 'validation-contract-v0' }),
                expected: expectation(),
                ...requiredProofs(),
            }),
            VALIDATION_ERROR_CODES.VALIDATOR_VERSION_MISMATCH,
        );
    });

    it('requires an explicit fresh epoch after a stale judgment', () => {
        const receipt = issueReceipt();
        const stale = markReceiptStale(receipt, 'contract_drift');
        // 태그·HEAD 가 원래 값으로 돌아와도 stale 영수증은 부활하지 않는다.
        const err = expectCode(
            () => validateValidationReceipt({
                receipt: stale,
                expected: expectation(),
                ...requiredProofs(),
            }),
            VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT,
        );
        expect(err.details.reason).toBe('receipt_marked_stale');

        // 이전 epoch 의 영수증도 새 epoch 기대에 재사용되지 않는다.
        expectCode(
            () => validateValidationReceipt({
                receipt, expected: expectation({ validationEpoch: 4 }), ...requiredProofs(),
            }),
            VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT,
        );
        expectCode(
            () => validateValidationReceipt({
                receipt, expected: expectation({ minValidationEpoch: 4 }), ...requiredProofs(),
            }),
            VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT,
        );

        const reissued = issueReceipt({ validationEpoch: 4 });
        const ok = validateValidationReceipt({
            receipt: reissued,
            expected: expectation({ validationEpoch: 4, minValidationEpoch: 4 }),
            ...requiredProofs(),
        });
        expect(ok.validationEpoch).toBe(4);
        expect(ok.checkId).not.toBe(receipt.checkId);
    });

    it('binds the issued language-field projection and refuses omitted or different replay', () => {
        const extras = { humanTextFields: ['freshlyAddedProsePolicy'] };
        // 같은 묶음이라도 추가 투영은 다른 검사다. 분류 결과가 같아 보여도 신원이 갈린다.
        const extraOnClean = issueReceipt({ languageFields: extras });
        expect(extraOnClean.languageFieldProjectionHash).toBe(computeLanguageFieldProjectionHash(extras));
        expect(extraOnClean.checkId).not.toBe(issueReceipt().checkId);

        const withNewField = canonicalArtifact(bundle({
            semanticDelta: [{ entityId: 'ann', freshlyAddedProsePolicy: 'The corridor answers in English.' }],
        }));
        const projectedCompliance = evaluateLanguageCompliance({
            compliance: compliance(withNewField),
            artifact: withNewField,
            workContract: WORK_CONTRACT,
            languageFields: extras,
        });
        const projectedReceipt = buildValidationReceipt({
            ...IDENTITY,
            workContract: WORK_CONTRACT,
            artifact: withNewField,
            checkerPlan: registryPlan(),
            languageCompliance: projectedCompliance,
            coverage: completeCoverage(),
            languageFields: extras,
        });
        expect(projectedReceipt.languageFieldProjectionHash).toBe(computeLanguageFieldProjectionHash(extras));
        expect(projectedReceipt.checkId).not.toBe(issueReceipt().checkId);

        const expectedProjected = expectation({
            artifactHash: computeArtifactHash(withNewField),
            languageFields: extras,
        });
        expect(validateValidationReceipt({
            receipt: projectedReceipt,
            expected: expectedProjected,
            ...requiredProofs({
                artifact: withNewField,
                languageCompliance: persisted(projectedCompliance),
                languageFields: extras,
            }),
        }).languageFieldProjectionHash).toBe(projectedReceipt.languageFieldProjectionHash);

        // 생략된 기본 투영으로 같은 영수증을 재사용할 수 없다.
        expect(expectCode(
            () => validateValidationReceipt({
                receipt: projectedReceipt,
                expected: expectation({ artifactHash: computeArtifactHash(withNewField) }),
                ...requiredProofs({
                    artifact: withNewField,
                    languageCompliance: persisted(projectedCompliance),
                }),
            }),
            VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH,
        ).details.field).toBe('languageFieldProjectionHash');
        // 다른 추가 이름표로 재평가할 수 없다.
        expect(expectCode(
            () => validateValidationReceipt({
                receipt: projectedReceipt,
                expected: expectation({
                    artifactHash: computeArtifactHash(withNewField),
                    languageFields: { humanTextFields: ['anotherGeneratedLeaf'] },
                }),
                ...requiredProofs({
                    artifact: withNewField,
                    languageCompliance: persisted(projectedCompliance),
                    languageFields: { humanTextFields: ['anotherGeneratedLeaf'] },
                }),
            }),
            VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH,
        ).details.field).toBe('languageFieldProjectionHash');

        // 기본 발급을 추가 투영으로 소비하는 것도 다른 검사다.
        const defaultReceipt = issueReceipt();
        expect(expectCode(
            () => validateValidationReceipt({
                receipt: defaultReceipt,
                expected: expectation({ languageFields: extras }),
                ...requiredProofs({ languageFields: extras }),
            }),
            VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH,
        ).details.field).toBe('languageFieldProjectionHash');
        expect(validateValidationReceipt({
            receipt: defaultReceipt,
            expected: expectation({ languageFields: { humanTextFields: [] } }),
            ...requiredProofs(),
        }).ok).toBe(true);
    });
});

describe('approval binding', () => {
    it('binds an approval to the same check, epoch and artifact', () => {
        const receipt = issueReceipt();
        const approval = buildApprovalBinding(receipt, { approvedBy: 'user', decision: 'approve' });
        expect(validateApprovalBinding({ approval, receipt }).ok).toBe(true);
        expect(approval.artifactKind).toBe('chapter');

        const reissued = issueReceipt({ validationEpoch: 4 });
        const err = expectCode(
            () => validateApprovalBinding({ approval, receipt: reissued }),
            VALIDATION_ERROR_CODES.INVALID_APPROVAL_BINDING,
        );
        expect(err.details.field).toBe('checkId');
        expectCode(
            () => validateApprovalBinding({ approval: { approvedBy: 'user' }, receipt }),
            VALIDATION_ERROR_CODES.INVALID_APPROVAL_BINDING,
        );
        expectCode(
            () => validateApprovalBinding({ approval: null, receipt }),
            VALIDATION_ERROR_CODES.INVALID_APPROVAL_BINDING,
        );
    });
});


it('treats extracted appearedCharacterIds as machine identifiers, not language evidence', () => {
    const artifact = canonicalArtifact({ prose: PROSE, title: '扉', summary: '夜明け', semanticDelta: { appearedCharacterIds: ['c1'] }, castManifestRaw: '' });
    const raw = { language: 'ja', verdict: 'pass', artifactHash: computeArtifactHash(artifact), evidence: [], allowedExceptions: [] };
    expect(evaluateLanguageCompliance({ artifact, workContract: WORK_CONTRACT, compliance: raw }).satisfied).toBe(true);
    expectCode(() => evaluateLanguageCompliance({ artifact, workContract: WORK_CONTRACT, compliance: { ...raw, verdict: 'fail', evidence: [{ fieldPath: 'semanticDelta.appearedCharacterIds[0]', quote: 'c1', reason: 'not Japanese' }] } }), VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE);
});


it('classifies fixed measurement and character enums as machine values', () => {
 const artifact = canonicalApprovalArtifact({ kind: 'foundation', revision: 1, value: { description: '扉が開く。', characters: [{ intrinsic: { gender: 'female', role: '旅人' }, addressMap: { register: 'formal' } }], workContract: { measurementPolicy: { requestedLocale: 'en', resolvedLocale: 'en', segmenterGranularity: 'word', baseLanguage: 'en', icu: '77.1' } } } });
 const result = evaluateLanguageCompliance({ artifact, workContract: WORK_CONTRACT, compliance: compliance(artifact) });
 expect(result.satisfied).toBe(true);
});

it('classifies the concrete chapter summary and empty-change explanation schema', () => {
 const artifact = bundle({ summary: { text: '扉が開く。', plotBeat: '一歩進む。', sceneTags: ['庭'], povCharacter: 'c1' }, semanticDelta: { noInfluenceReason: '状態は変わらない。', appearedCharacterIds: ['c1'] } });
 expect(evaluate(artifact).satisfied).toBe(true);
});
