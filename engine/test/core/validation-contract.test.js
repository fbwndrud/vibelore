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
    VALIDATION_ERROR_CODES,
    VALIDATOR_VERSION,
    ValidationContractError,
    buildApprovalBinding,
    buildValidationReceipt,
    canonicalArtifact,
    canonicalizeArtifact,
    computeArtifactHash,
    computeCoverageHash,
    computeLanguageComplianceHash,
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

// ─── 공통 fixture ───────────────────────────────────────────────────────────

/** 일본어 본문에 승인된 영어 고유명과 원문 인용이 섞인 정상 원고. */
const PROSE = '扉が開いた。Ann は振り返り、"I will go," と告げた。夜が明ける。';

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

function registryCoverage(plan, semanticEvidence) {
    return aggregateCheckerCoverage(plan, [], semanticEvidence);
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

function completeCoverage(semanticEvidence = ALL_SEMANTIC_PASS) {
    const plan = registryPlan();
    return evaluateInvariantCoverage({ plan, coverage: registryCoverage(plan, semanticEvidence) });
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
        contractHash: computeLanguageContractHash(WORK_CONTRACT),
        artifactHash: computeArtifactHash(bundle()),
        ...overrides,
    };
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
            'artifactSchemaVersion', 'castManifestRaw', 'prose', 'semanticDelta', 'summary', 'title',
        ]);
        // 배열 순서는 데이터이므로 보존한다.
        expect(computeArtifactHash(bundle({ summary: { hook: 'Ann が扉を開ける', beats: ['夜明け', '扉'] } })))
            .not.toBe(computeArtifactHash(bundle()));
    });

    it('fails missing required values instead of publishing silently empty ones', () => {
        for (const field of ['prose', 'title', 'summary', 'semanticDelta', 'castManifestRaw']) {
            const incomplete = bundle();
            delete incomplete[field];
            const err = expectCode(() => canonicalArtifact(incomplete), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
            expect(err.details).toEqual({ reason: 'missing_required_field', field });
            expectCode(() => canonicalArtifact(bundle({ [field]: null })), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
        }
        expectCode(() => canonicalArtifact(bundle({ title: '   ' })), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
        expectCode(() => canonicalArtifact(bundle({ summary: {} })), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
        expectCode(() => canonicalArtifact(null), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
    });

    it('accepts explicitly empty delta and manifest but never invents a summary', () => {
        expect(computeArtifactHash(bundle({ semanticDelta: [], castManifestRaw: {} }))).toMatch(/^[0-9a-f]{64}$/);
        expectCode(() => canonicalArtifact(bundle({ summary: '' })), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
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
    });

    it('hashes the judgment without its derived fields', () => {
        const first = evaluate(artifact);
        const second = evaluateLanguageCompliance({
            compliance: JSON.stringify(compliance(artifact)),
            artifact,
            targetLanguage: 'ja',
            allowedLanguageExceptions: WORK_CONTRACT.allowedLanguageExceptions,
        });
        expect(computeLanguageComplianceHash(first)).toBe(computeLanguageComplianceHash(second));
        expect(computeLanguageComplianceHash(evaluate(artifact, { verdict: 'uncertain' })))
            .not.toBe(computeLanguageComplianceHash(first));
    });
});

// ─── 필수 불변식 coverage ───────────────────────────────────────────────────

describe('evaluateInvariantCoverage', () => {
    it('accepts a plan whose mandatory invariants are all validated', () => {
        const result = completeCoverage();
        expect(result.complete).toBe(true);
        expect(result.blocked).toEqual([]);
        for (const id of ALWAYS_MANDATORY_INVARIANTS)
            expect(result.requiredIds).toContain(id);
        expect(result.requiredIds).toEqual([...result.requiredIds].sort());
    });

    it('blocks a required invariant that is missing, unvalidated, failed, uncertain or error', () => {
        const plan = registryPlan();
        const withoutPov = { ...ALL_SEMANTIC_PASS };
        delete withoutPov.POV;
        const uncertainPov = evaluateInvariantCoverage({ plan, coverage: registryCoverage(plan, withoutPov) });
        expect(uncertainPov.complete).toBe(false);
        expect(uncertainPov.blocked).toContainEqual({ id: 'POV', coverage: 'unvalidated', reason: 'unvalidated' });
        // 출력 언어 통과가 미검증 의미 불변식을 대신하지 못한다.
        expect(uncertainPov.coverageById.OUTPUT_LANGUAGE).toBe('validated');

        const explicit = { checkerPolicyVersion: 1, requiredInvariantIds: [...ALWAYS_MANDATORY_INVARIANTS, 'POV'] };
        for (const [value, reason] of [['failed', 'failed'], ['uncertain', 'uncertain'], ['error', 'error']]) {
            const result = evaluateInvariantCoverage({
                plan: explicit,
                coverage: { SCHEMA: 'validated', LENGTH: 'validated', OUTPUT_LANGUAGE: 'validated', POV: value },
            });
            expect(result.complete).toBe(false);
            expect(result.blocked).toContainEqual({ id: 'POV', coverage: value, reason });
        }
        const missing = evaluateInvariantCoverage({
            plan: explicit,
            coverage: { SCHEMA: 'validated', LENGTH: 'validated', OUTPUT_LANGUAGE: 'validated' },
        });
        expect(missing.blocked).toContainEqual({ id: 'POV', coverage: null, reason: 'missing' });
    });

    it('does not let a submitted not_applicable waive a required invariant', () => {
        const result = evaluateInvariantCoverage({
            plan: { requiredInvariantIds: [...ALWAYS_MANDATORY_INVARIANTS, 'POV'] },
            coverage: { SCHEMA: 'validated', LENGTH: 'validated', OUTPUT_LANGUAGE: 'validated', POV: 'not_applicable' },
        });
        expect(result.complete).toBe(false);
        expect(result.blocked).toContainEqual({ id: 'POV', coverage: 'not_applicable', reason: 'not_applicable_cannot_waive' });
    });

    it('accepts non-applicability only when the plan itself marks no contract', () => {
        // 시점 계약이 없는 작품: 계획이 POV 를 not_applicable 로 확정한다.
        const plan = registryPlan({ povMode: 'none' });
        const coverage = registryCoverage(plan, ALL_SEMANTIC_PASS);
        const result = evaluateInvariantCoverage({ plan, coverage });
        expect(result.requiredIds).not.toContain('POV');
        expect(result.notApplicableIds).toContain('POV');
        expect(result.complete).toBe(true);
    });

    it('never lets soft or advisory results block', () => {
        const plan = registryPlan();
        const result = evaluateInvariantCoverage({
            plan,
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

    it('refuses plans that could fabricate SCHEMA, LENGTH or OUTPUT_LANGUAGE passes', () => {
        const err = expectCode(
            () => evaluateInvariantCoverage({
                plan: { requiredInvariantIds: ['SCHEMA', 'LENGTH'] },
                coverage: { SCHEMA: 'validated', LENGTH: 'validated' },
            }),
            VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN,
        );
        expect(err.details.missing).toEqual(['OUTPUT_LANGUAGE']);
        expectCode(
            () => evaluateInvariantCoverage({ plan: { requiredInvariantIds: [] }, coverage: {} }),
            VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN,
        );
        expectCode(
            () => evaluateInvariantCoverage({ plan: { rows: [{ invariantId: 'SCHEMA', invariant: 'conditional' }] }, coverage: {} }),
            VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN,
        );
    });

    it('rejects malformed coverage reports instead of guessing', () => {
        const plan = { requiredInvariantIds: ALWAYS_MANDATORY_INVARIANTS };
        expectCode(
            () => evaluateInvariantCoverage({ plan, coverage: { SCHEMA: 'passed' } }),
            VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT,
        );
        expectCode(() => evaluateInvariantCoverage({ plan, coverage: 'validated' }), VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT);
    });

    it('hashes coverage over the required set and its values', () => {
        const complete = completeCoverage();
        const noPov = { ...ALL_SEMANTIC_PASS };
        delete noPov.POV;
        expect(computeCoverageHash(complete)).toBe(computeCoverageHash(completeCoverage()));
        expect(computeCoverageHash(completeCoverage(noPov))).not.toBe(computeCoverageHash(complete));
    });
});

// ─── 검사 영수증 ────────────────────────────────────────────────────────────

describe('buildValidationReceipt', () => {
    it('issues a passed receipt pinned to contract, artifact, judgment and coverage', () => {
        const receipt = issueReceipt();
        expect(receipt.verdict).toBe('passed');
        expect(receipt.contractHash).toBe(computeLanguageContractHash(WORK_CONTRACT));
        expect(receipt.artifactHash).toBe(computeArtifactHash(bundle()));
        expect(receipt.consumed).toBe(false);
        expect(receipt.stale).toBe(false);
        expect(receipt.checkId).toBe(computeReceiptCheckId(receipt));
        expect(receipt.validatorVersion).toBe(VALIDATOR_VERSION);
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
});

describe('validateValidationReceipt', () => {
    it('accepts the receipt it issued for the same bundle and contract', () => {
        const receipt = issueReceipt();
        const result = validateValidationReceipt({
            receipt,
            expected: expectation({ minValidationEpoch: 3 }),
            artifact: bundle(),
            workContract: WORK_CONTRACT,
            languageCompliance: evaluate(canonicalArtifact(bundle())),
            coverage: completeCoverage(),
        });
        expect(result.ok).toBe(true);
        expect(result.checkId).toBe(receipt.checkId);
    });

    it('blocks a missing, malformed or forged receipt', () => {
        expectCode(
            () => validateValidationReceipt({ receipt: null, expected: expectation() }),
            VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT,
        );
        expectCode(
            () => validateValidationReceipt({ receipt: { workId: 'w1' }, expected: expectation() }),
            VALIDATION_ERROR_CODES.INVALID_RECEIPT,
        );
        // 신원 값을 바꾸고 checkId 를 그대로 둔 영수증은 위조다.
        const forged = { ...issueReceipt(), sourceHead: 'head-xyz' };
        const err = expectCode(
            () => validateValidationReceipt({ receipt: forged, expected: expectation({ sourceHead: 'head-xyz' }) }),
            VALIDATION_ERROR_CODES.INVALID_RECEIPT,
        );
        expect(err.details.reason).toBe('check_id_mismatch');
    });

    it('refuses to verify against an incomplete expectation', () => {
        const receipt = issueReceipt();
        const partial = expectation();
        delete partial.planSourceHash;
        const err = expectCode(
            () => validateValidationReceipt({ receipt, expected: partial }),
            VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION,
        );
        expect(err.details.missing).toContain('planSourceHash');
        const noSource = expectation();
        delete noSource.artifactHash;
        expectCode(
            () => validateValidationReceipt({ receipt, expected: noSource }),
            VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION,
        );
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
                () => validateValidationReceipt({ receipt, expected: expectation({ [field]: value }) }),
                VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH,
            );
            expect(err.details.field).toBe(field);
        }
        expectCode(
            () => validateValidationReceipt({ receipt, expected: expectation({ runId: 'run-1' }) }),
            VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH,
        );
    });

    it('blocks contract, artifact, judgment and coverage hash drift', () => {
        const receipt = issueReceipt();
        const otherContract = buildLanguageContract({ language: 'ja', length: { unit: 'graphemes', target: 2400 } });
        expectCode(
            () => validateValidationReceipt({ receipt, expected: expectation(), workContract: otherContract }),
            VALIDATION_ERROR_CODES.CONTRACT_HASH_MISMATCH,
        );
        // 검사 뒤 요약만 바꾼 묶음은 같은 영수증으로 발행할 수 없다.
        expectCode(
            () => validateValidationReceipt({
                receipt,
                expected: expectation({ artifactHash: computeArtifactHash(bundle({ summary: '다시 쓴 요약' })) }),
                artifact: bundle({ summary: '다시 쓴 요약' }),
            }),
            VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH,
        );
        expectCode(
            () => validateValidationReceipt({
                receipt,
                expected: expectation(),
                // 같은 묶음·같은 verdict 라도 근거·예외가 다르면 다른 판정이다.
                languageCompliance: evaluate(canonicalArtifact(bundle()), {
                    allowedExceptions: [{ kind: 'properNoun', language: 'en', scope: 'Ann' }],
                }),
                coverage: completeCoverage(),
            }),
            VALIDATION_ERROR_CODES.LANGUAGE_COMPLIANCE_HASH_MISMATCH,
        );
        const withoutPov = { ...ALL_SEMANTIC_PASS };
        delete withoutPov.POV;
        expectCode(
            () => validateValidationReceipt({ receipt, expected: expectation(), coverage: completeCoverage(withoutPov) }),
            VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE,
        );
    });

    it('blocks consumed receipts and validator version drift', () => {
        const receipt = issueReceipt();
        expectCode(
            () => validateValidationReceipt({ receipt: markReceiptConsumed(receipt), expected: expectation() }),
            VALIDATION_ERROR_CODES.RECEIPT_ALREADY_CONSUMED,
        );
        expectCode(
            () => validateValidationReceipt({
                receipt: issueReceipt({ validatorVersion: 'validation-contract-v0' }),
                expected: expectation(),
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
                artifact: bundle(),
                workContract: WORK_CONTRACT,
            }),
            VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT,
        );
        expect(err.details.reason).toBe('receipt_marked_stale');

        // 이전 epoch 의 영수증도 새 epoch 기대에 재사용되지 않는다.
        expectCode(
            () => validateValidationReceipt({ receipt, expected: expectation({ validationEpoch: 4 }) }),
            VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT,
        );
        expectCode(
            () => validateValidationReceipt({ receipt, expected: expectation({ minValidationEpoch: 4 }) }),
            VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT,
        );

        const reissued = issueReceipt({ validationEpoch: 4 });
        const ok = validateValidationReceipt({
            receipt: reissued,
            expected: expectation({ validationEpoch: 4, minValidationEpoch: 4 }),
            artifact: bundle(),
            workContract: WORK_CONTRACT,
        });
        expect(ok.validationEpoch).toBe(4);
        expect(ok.checkId).not.toBe(receipt.checkId);
    });
});

describe('approval binding', () => {
    it('binds an approval to the same check, epoch and artifact', () => {
        const receipt = issueReceipt();
        const approval = buildApprovalBinding(receipt, { approvedBy: 'user', decision: 'approve' });
        expect(validateApprovalBinding({ approval, receipt }).ok).toBe(true);

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
