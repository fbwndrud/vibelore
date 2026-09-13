/**
 * Public new-contract foundation approval gate.
 *
 * Book-create and revise-foundation stay pure return paths. Explicit
 * new-contract activation adds a language-validated approval artifact and
 * receipt; legacy output shape is untouched.
 */
import { createHash } from 'node:crypto';
import { CHECKER_REGISTRY_VERSION } from '../../continuity/checker-registry.js';
import {
    languageSystemLines,
    pickByFamily,
    resolveStepPromptLanguage,
} from '../../core/prompt-language.js';
import {
    ARTIFACT_KIND_APPROVAL,
    VALIDATION_ERROR_CODES,
    ValidationContractError,
    buildValidationReceipt,
    canonicalApprovalArtifact,
    computeArtifactHash,
    evaluateInvariantCoverage,
    evaluateLanguageCompliance,
} from '../../core/validation-contract.js';
import { OUTPUT_LANGUAGE_COMPLIANCE_STEP } from './chapter-validation.js';

/** Extra Foundation natural-text names the approval classifier does not list yet. */
export const FOUNDATION_LANGUAGE_FIELDS = Object.freeze({
    humanTextFields: Object.freeze([
        'aliases', 'actionBias', 'ageBand', 'benefit', 'birthOrder', 'canonicalName', 'cost',
        'contradiction', 'coreAppearance', 'designViolations', 'form', 'formatVersionSource',
        'languageSource', 'lengthSource', 'public', 'species', 'statement',
        'trigger', 'underPressure', 'unicode',
    ]),
});

function hasOwn(obj, key) {
    return obj != null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function positiveInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function fail(code, details) {
    throw new ValidationContractError(code, details);
}

function gateSlot(ctx, input, key) {
    if (input && hasOwn(input, key) && input[key] != null)
        return input[key];
    if (ctx && hasOwn(ctx, key) && ctx[key] != null)
        return ctx[key];
    return undefined;
}

/** Stored or supplied language metadata requires validation before activation. */
export function isExplicitFoundationNewContract(ctx, input = {}) {
    return ['workContract', 'language'].some((key) => input?.[key] != null || ctx?.[key] != null || input.foundation?.[key] != null)
        || gateSlot(ctx, input, 'validationEpoch') != null
        || gateSlot(ctx, input, 'validationReceipt') != null
        || gateSlot(ctx, input, 'canonicalApprovalArtifact') != null;
}

export function describeApprovalCheckerPlan(promptLanguage) {
    const family = promptLanguage?.promptFamily ?? promptLanguage?.contract?.promptFamily ?? null;
    const row = (invariantId) => Object.freeze({
        checkerId: null,
        invariantId,
        runDetector: false,
        applicability: 'run',
        invariant: 'required',
        ifSkipped: 'none',
        skipReason: 'owned_by_approval_gate',
        requiresSemantic: false,
        exhaustive: true,
    });
    return Object.freeze({
        checkerPolicyVersion: CHECKER_REGISTRY_VERSION,
        promptFamily: family,
        legacy: family == null,
        rows: Object.freeze([row('SCHEMA'), row('OUTPUT_LANGUAGE')]),
    });
}

function foundationSchemaOk(foundation) {
    if (foundation == null || typeof foundation !== 'object' || Array.isArray(foundation))
        return false;
    if (!nonEmptyString(foundation.workId) || !nonEmptyString(foundation.genre))
        return false;
    if (!Array.isArray(foundation.characters) || foundation.characters.length === 0)
        return false;
    if (!Array.isArray(foundation.worldFacts))
        return false;
    return true;
}

function sha256Text(text) {
    return createHash('sha256').update(String(text)).digest('hex');
}

function resolveApprovalIdentity(ctx, { foundation, revision, promptLanguage, planSource }) {
    const missing = [];
    const workId = nonEmptyString(ctx?.workId) ? ctx.workId : (nonEmptyString(foundation?.workId) ? foundation.workId : null);
    if (!workId)
        missing.push('workId');
    const workflowId = nonEmptyString(ctx?.workflowId) ? ctx.workflowId : null;
    const runId = nonEmptyString(ctx?.runId) ? ctx.runId : null;
    if (!workflowId && !runId)
        missing.push('workflowId|runId');
    const validationEpoch = ctx?.validationEpoch;
    if (!positiveInteger(validationEpoch))
        missing.push('validationEpoch');
    if (missing.length > 0)
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, {
            reason: 'absent_trusted_identity',
            missing: [...new Set(missing)],
        });
    return Object.freeze({
        workId,
        chapter: null,
        workflowId,
        runId,
        validationEpoch,
        sourceHead: null,
        planSourceHash: sha256Text(typeof planSource === 'string' ? planSource : JSON.stringify(planSource ?? { kind: 'foundation', revision })),
        workContract: promptLanguage.contract,
        promptLanguage,
        artifactKind: ARTIFACT_KIND_APPROVAL,
        revision,
    });
}

const LANGUAGE_SYSTEM_KO = [
    '너는 승인 묶음(foundation)의 출력 언어를 판정하는 검사기다.',
    '문자 비율이나 문자 체계를 세어 언어를 추측하지 않는다.',
    '근거는 value 안의 생성된 자연어 필드뿐이다. ID·enum·revision·approvalKind 는 근거가 아니다.',
    '출력은 JSON 한 개: language, verdict, artifactHash, evidence, allowedExceptions. language는 목표 언어 태그를 그대로 쓴다.',
    'artifactHash 는 입력 값을 글자 그대로 되돌려 적는다.',
].join(' ');

const LANGUAGE_SYSTEM_EN = [
    'You judge the output language of a foundation approval bundle.',
    'Do not guess the language by character ratios or script counts.',
    'Ground the judgment only in generated natural-language fields inside value. IDs, enums, revision and approvalKind are not evidence.',
    'Output one JSON object: language, verdict, artifactHash, evidence, allowedExceptions. Echo the target language tag exactly.',
    'Echo artifactHash from the input exactly.',
].join(' ');

async function requestApprovalLanguage(ctx, { artifact, artifactHash, promptLanguage, workContract }) {
    const system = [
        pickByFamily(promptLanguage, { ko: LANGUAGE_SYSTEM_KO, multilingual: LANGUAGE_SYSTEM_EN }),
        ...languageSystemLines(promptLanguage, { includeChapterLength: false }),
    ].join(' ');
    const labels = pickByFamily(promptLanguage, {
        ko: { language: '## 목표 언어', artifact: '## 승인 묶음', ask: 'OUTPUT_LANGUAGE를 판정하고 JSON 한 개만 출력하라.' },
        multilingual: { language: '## Target language', artifact: '## Approval artifact', ask: 'Judge OUTPUT_LANGUAGE and output one JSON object.' },
    });
    const res = await ctx.providers.complete({
        model: ctx.model,
        step: OUTPUT_LANGUAGE_COMPLIANCE_STEP,
        jsonMode: true,
        messages: [
            { role: 'system', content: system },
            {
                role: 'user',
                content: [
                    '## artifactHash',
                    artifactHash,
                    '',
                    `${labels.language}\n${workContract.language}`,
                    `language: ${workContract.language}`,
                    '',
                    labels.artifact,
                    JSON.stringify({
                        approvalKind: artifact.approvalKind,
                        revision: artifact.revision,
                        value: artifact.value,
                    }),
                    '',
                    labels.ask,
                ].join('\n'),
            },
        ],
    });
    return res?.text ?? '';
}

/**
 * Language-validate a created or revised Foundation. Does not write state.
 */
export async function checkFoundationApproval(ctx, input) {
    const foundation = input.foundation;
    const revision = input.revision ?? foundation?.revision ?? 1;
    const promptLanguage = input.promptLanguage
        ?? resolveStepPromptLanguage({
            foundation,
            workContract: input.workContract ?? ctx.workContract ?? null,
            language: input.language ?? ctx.language ?? null,
        });
    const identity = resolveApprovalIdentity(ctx, {
        foundation,
        revision,
        promptLanguage,
        planSource: input.planSource ?? { kind: 'foundation', workId: foundation.workId, revision },
    });
    const checkerPlan = describeApprovalCheckerPlan(promptLanguage);
    const canonical = canonicalApprovalArtifact({
        kind: 'foundation',
        revision,
        value: foundation,
    });
    const schemaOk = foundationSchemaOk(foundation);

    const coverageMap = {
        SCHEMA: schemaOk ? 'validated' : 'unvalidated',
        OUTPUT_LANGUAGE: 'unvalidated',
    };

    if (!schemaOk)
        fail(VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE, {
            blocked: [{ id: 'SCHEMA', coverage: 'unvalidated', reason: 'invalid_foundation_schema' }],
            draft: foundation,
        });

    let languageCompliance = null;
    if (!languageCompliance) {
        languageCompliance = await requestApprovalLanguage(ctx, {
            artifact: canonical,
            artifactHash: computeArtifactHash(canonical),
            promptLanguage,
            workContract: identity.workContract,
        });
    }
    const evaluatedLanguage = evaluateLanguageCompliance({
        compliance: languageCompliance,
        artifact: canonical,
        workContract: identity.workContract,
        languageFields: FOUNDATION_LANGUAGE_FIELDS,
    });
    if (evaluatedLanguage.verdict === 'fail')
        fail(VALIDATION_ERROR_CODES.OUTPUT_LANGUAGE_MISMATCH, {
            evidence: evaluatedLanguage.evidence,
            draft: foundation,
        });
    if (evaluatedLanguage.verdict === 'uncertain')
        fail(VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE, {
            reason: 'language_verdict_uncertain',
            draft: foundation,
        });

    coverageMap.OUTPUT_LANGUAGE = 'validated';
    const coverage = evaluateInvariantCoverage({
        plan: checkerPlan,
        coverage: coverageMap,
        artifactKind: ARTIFACT_KIND_APPROVAL,
    });
    if (!coverage.complete)
        fail(VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE, { blocked: coverage.blocked, draft: foundation });

    const receipt = buildValidationReceipt({
        workId: identity.workId,
        chapter: null,
        workflowId: identity.workflowId,
        runId: identity.runId,
        validationEpoch: identity.validationEpoch,
        sourceHead: identity.sourceHead,
        planSourceHash: identity.planSourceHash,
        workContract: identity.workContract,
        artifact: canonical,
        artifactKind: ARTIFACT_KIND_APPROVAL,
        checkerPlan,
        languageCompliance: evaluatedLanguage,
        coverage,
        languageFields: FOUNDATION_LANGUAGE_FIELDS,
        issuedBy: 'engine-foundation-validation',
    });
    return {
        foundation,
        canonicalApprovalArtifact: canonical,
        validationReceipt: receipt,
        reusedReceipt: false,
        languageCompliance: evaluatedLanguage,
        coverage,
    };
}



export const PUBLIC_FOUNDATION_PROMPT_SYSTEMS = Object.freeze({
    'foundation-output-language-compliance': Object.freeze({ ko: LANGUAGE_SYSTEM_KO, multilingual: LANGUAGE_SYSTEM_EN }),
});
