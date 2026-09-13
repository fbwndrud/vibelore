/**
 * Public new-contract chapter publication gate.
 *
 * Preparation/check run before a receipt is issued. Consume-only commit
 * publishes the exact checked bundle and never calls a provider.
 * The shared verifier is `core/validation-contract.js`; this module does not
 * invent a second one.
 */
import { createHash } from 'node:crypto';
import {
    DefaultEmotionVerbLexicon,
} from '../../continuity/emotion-verb-lexicon.js';
import { ENGINE_GENRES } from '../../continuity/genre-profile.js';
import { DefaultHonorificLexicon } from '../../continuity/honorific-lexicon.js';
import {
    aggregateCheckerCoverage,
    describeCheckerPlan,
    runDetector,
    skipKoLexical,
} from '../../continuity/checker-registry.js';
import {
    computeContinuityContextHash,
    continuityCheck,
    extractDelta,
    requiredSemanticInvariantIds,
} from '../../continuity/continuity-check.js';
import { detectCliffhanger } from '../../continuity/cliffhanger-detector.js';
import { scanDialogueMarkerVariety } from '../../continuity/dialogue-marker-variety.js';
import { scanDialogueRatio } from '../../continuity/dialogue-ratio.js';
import { scanFanficLeak } from '../../continuity/fanfic-leak-detector.js';
import { detectGapSkip } from '../../continuity/gap-skip-detector.js';
import { scanInfoRestate } from '../../continuity/info-restate-detector.js';
import { DefaultOnomatopoeiaLexicon } from '../../continuity/onomatopoeia-lexicon.js';
import { checkPov } from '../../continuity/pov-check.js';
import { resolveNarrator } from '../../continuity/pov-narrator.js';
import { scanQuality } from '../../continuity/quality-scan.js';
import {
    evaluateChapterQuality,
    failsToViolations,
} from '../../continuity/quality-gate.js';
import { runProsodyScan } from '../../continuity/prosody-scan.js';
import { DefaultSensitiveLexicon, scanSensitive } from '../../continuity/sensitive-lexicon.js';
import { scanSentenceStats } from '../../continuity/sentence-stats.js';
import { DefaultSimileMarkerLexicon } from '../../continuity/simile-marker-lexicon.js';
import { DefaultStyleLexicon } from '../../continuity/style-lexicon.js';
import { scanStyle } from '../../continuity/style-scan.js';
import { emptyStoryState, reduceStoryState } from '../../continuity/story-state.js';
import { scanWorldGroupConflict } from '../../continuity/world-group-conflict-detector.js';
import { scanEntityMentions } from '../../core/mention-scan.js';
import { countLength } from '../../core/length-measure.js';
import { validateLengthMeasurementResult } from '../../core/language-policy.js';
import {
    languageSystemLines,
    pickByFamily,
    resolveDialogueBreakMode,
    resolveWorkPromptLanguage,
} from '../../core/prompt-language.js';
import {
    ARTIFACT_KIND_CHAPTER,
    VALIDATION_ERROR_CODES,
    ValidationContractError,
    buildValidationReceipt,
    canonicalArtifact,
    computeArtifactHash,
    evaluateInvariantCoverage,
    evaluateLanguageCompliance,
    markReceiptConsumed,
    validateValidationReceipt,
    validatePublicationManifest,
} from '../../core/validation-contract.js';
import { runCoherenceJudge } from './steps/coherence-judge.js';
import { runChapterSummary } from './steps/chapter-summary.js';

export const CHAPTER_TITLE_SUMMARY_STEP = 'chapter-title-summary';
export const OUTPUT_LANGUAGE_COMPLIANCE_STEP = 'output-language-compliance';

/** Extra generated-text names owned by ChapterDelta that the verifier does not list yet. */
export const CHAPTER_LANGUAGE_FIELDS = Object.freeze({
    humanTextFields: Object.freeze([
        'anchor', 'message', 'noInfluenceReason',
    ]),
});

const FORMAT_LAYOUT_CODES = new Set([
    'WEBNOVEL_DIALOGUE_BURIED',
    'WEBNOVEL_DIALOGUE_NOT_ISOLATED',
    'WEBNOVEL_SOFT_LINEBREAKS',
]);

function hasOwn(obj, key) {
    return obj != null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function positiveInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function sha256Text(text) {
    return createHash('sha256').update(String(text)).digest('hex');
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

const GATE_CTX_KEYS = Object.freeze([
    'validationEpoch', 'validationReceipt', 'workflowId', 'runId',
    'workContract', 'language', 'length', 'dialogueBreakMode', 'summaryLength',
]);

/** Copy explicit gate slots from input onto ctx without inventing defaults. */
export function withGateContext(ctx, input = {}) {
    const next = { ...ctx };
    for (const key of GATE_CTX_KEYS) {
        if (input && hasOwn(input, key) && input[key] !== undefined && next[key] === undefined)
            next[key] = input[key];
    }
    return next;
}

/**
 * Stored or supplied language contracts always require publication validation.
 */
export function isExplicitNewContractContext(ctx, input = {}) {
    return ['workContract', 'language'].some((key) => input?.[key] != null || ctx?.[key] != null || input.foundation?.[key] != null)
        || gateSlot(ctx, input, 'validationEpoch') != null
        || gateSlot(ctx, input, 'validationReceipt') != null
        || gateSlot(ctx, input, 'canonicalArtifact') != null;
}

export function describeChapterCheckerPlan({
    foundation,
    promptLanguage,
    dialogueBreakMode = null,
    sensitiveMode = 'adult',
} = {}) {
    return describeCheckerPlan({
        language: promptLanguage?.language,
        workContract: promptLanguage?.contract,
        promptFamily: promptLanguage?.promptFamily,
        foundation,
        formatPolicy: promptLanguage?.contract?.formatPolicy,
        dialogueBreakMode,
        sensitiveMode,
        povMode: foundation?.povMode,
    });
}

function sourceHeadFromArtifact(artifact) {
    if (!artifact || typeof artifact !== 'object')
        return null;
    if (hasOwn(artifact, 'prose')
        && hasOwn(artifact, 'title')
        && hasOwn(artifact, 'summary')
        && (hasOwn(artifact, 'semanticDelta') || hasOwn(artifact, 'delta'))
        && hasOwn(artifact, 'castManifestRaw')) {
        try {
            return computeArtifactHash({
                prose: artifact.prose,
                title: artifact.title,
                summary: artifact.summary,
                semanticDelta: artifact.semanticDelta ?? artifact.delta,
                castManifestRaw: artifact.castManifestRaw,
            });
        }
        catch {
            // Fall through to the stored-bytes digest.
        }
    }
    return sha256Text(JSON.stringify({
        workId: artifact.workId ?? null,
        chapterNumber: artifact.chapterNumber ?? null,
        prose: artifact.prose ?? null,
        delta: artifact.delta ?? artifact.semanticDelta ?? null,
    }));
}

/**
 * Identity the receipt is checked against. Never copied from the receipt.
 */
export async function resolveTrustedChapterIdentity(ctx, { foundation, chapterNumber, plan } = {}) {
    const missing = [];
    if (!nonEmptyString(ctx?.workId))
        missing.push('workId');
    const workflowId = nonEmptyString(ctx?.workflowId) ? ctx.workflowId : null;
    const runId = nonEmptyString(ctx?.runId) ? ctx.runId : null;
    if (!workflowId && !runId)
        missing.push('workflowId|runId');
    if (!positiveInteger(ctx?.validationEpoch))
        missing.push('validationEpoch');
    if (typeof ctx?.state?.loadFoundation !== 'function' || typeof ctx?.state?.loadArtifact !== 'function')
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, {
            reason: 'absent_state_provider',
            missing,
        });
    if (plan === undefined || plan === null || (typeof plan === 'string' && plan.trim() === ''))
        missing.push('planSourceHash');
    if (missing.length > 0)
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, {
            reason: 'absent_trusted_identity',
            missing,
        });

    const storedFoundation = await ctx.state.loadFoundation(ctx.workId);
    if (!storedFoundation || (foundation && JSON.stringify(foundation) !== JSON.stringify(storedFoundation)))
        fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, { reason: 'foundation_changed' });
    foundation = storedFoundation;
    const promptLanguage = resolveWorkPromptLanguage({
        foundation,
        workContract: ctx.workContract ?? null,
        language: ctx.language ?? null,
        length: ctx.length ?? null,
    });

    const existing = await ctx.state.loadArtifact(ctx.workId, chapterNumber);
    let sourceHead = null;
    if (existing)
        sourceHead = sourceHeadFromArtifact(existing);
    else if (chapterNumber > 1) {
        const previous = await ctx.state.loadArtifact(ctx.workId, chapterNumber - 1);
        sourceHead = previous ? sourceHeadFromArtifact(previous) : null;
    }

    const planSourceHash = sha256Text(typeof plan === 'string' ? plan : JSON.stringify(plan));
    const dialogueBreakMode = resolveDialogueBreakMode(promptLanguage, ctx.dialogueBreakMode ?? null);

    return Object.freeze({
        workId: ctx.workId,
        chapter: chapterNumber,
        workflowId,
        runId,
        validationEpoch: ctx.validationEpoch,
        sourceHead,
        planSourceHash,
        workContract: promptLanguage.contract,
        promptLanguage,
        dialogueBreakMode,
        artifactKind: ARTIFACT_KIND_CHAPTER,
    });
}

function publicationJobId(ctx, chapter) {
    return `validation-${sha256Text(JSON.stringify([ctx.workId, chapter]))}`;
}

async function publicationRecord(ctx, chapter) {
    if (typeof ctx.state?.loadJob !== 'function' || typeof ctx.state?.saveJob !== 'function')
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { reason: 'absent_validation_store' });
    return ctx.state.loadJob(publicationJobId(ctx, chapter));
}

async function priorState(ctx, chapter) {
    if (chapter === 1) return emptyStoryState(ctx.workId);
    if (typeof ctx.state.loadStoryState !== 'function')
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { reason: 'absent_story_state' });
    const state = await ctx.state.loadStoryState(ctx.workId, chapter - 1);
    if (!state) fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { reason: 'missing_previous_chapter' });
    return state;
}

function tryParseJson(raw) {
    if (typeof raw !== 'string' || raw.trim() === '')
        return null;
    try {
        return JSON.parse(raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim());
    }
    catch {
        return null;
    }
}

const TITLE_SUMMARY_SYSTEM_KO = [
    '너는 회차 제목과 요약만 쓰는 편집자다.',
    '본문을 읽고 JSON 객체 하나만 출력한다. 키는 title, summary 뿐이다.',
    'title 과 summary 는 작품 언어로 쓴다. JSON 키는 번역하지 않는다.',
    '본문에 없는 사건을 지어내지 않는다.',
].join(' ');

const TITLE_SUMMARY_SYSTEM_EN = [
    'You write only the chapter title and summary.',
    'Read the chapter and output one JSON object. The only keys are title and summary.',
    'Write title and summary in the target work language. Do not translate JSON keys.',
    'Do not invent events that are not in the chapter.',
].join(' ');

async function generateTitleAndSummary(ctx, {
    prose,
    chapterNumber,
    promptLanguage,
    title,
    summary,
}) {
    if (nonEmptyString(title) && summary != null && (typeof summary !== 'string' || summary.trim() !== ''))
        return { title, summary, generated: false };
    const system = [
        pickByFamily(promptLanguage, { ko: TITLE_SUMMARY_SYSTEM_KO, multilingual: TITLE_SUMMARY_SYSTEM_EN }),
        ...languageSystemLines(promptLanguage, { includeChapterLength: false }),
    ].join(' ');
    const labels = pickByFamily(promptLanguage, {
        ko: {
            heading: (n) => `## 회차 ${n} 본문`,
            ask: '위 본문의 title 과 summary 를 JSON 한 개로 출력하라.',
        },
        multilingual: {
            heading: (n) => `## Chapter ${n} text`,
            ask: 'Output title and summary for the chapter above as one JSON object.',
        },
    });
    const res = await ctx.providers.complete({
        model: ctx.model,
        step: CHAPTER_TITLE_SUMMARY_STEP,
        jsonMode: true,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: `${labels.heading(chapterNumber)}\n${prose}\n\n${labels.ask}` },
        ],
    });
    const parsed = tryParseJson(res?.text ?? '');
    const nextTitle = nonEmptyString(title)
        ? title
        : (typeof parsed?.title === 'string' ? parsed.title : '');
    const nextSummary = summary != null && (typeof summary !== 'string' || summary.trim() !== '')
        ? summary
        : (typeof parsed?.summary === 'string' ? parsed.summary : '');
    if (!nonEmptyString(nextTitle) || (typeof nextSummary === 'string' && nextSummary.trim() === ''))
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
            reason: 'title_or_summary_unvalidated',
            field: !nonEmptyString(nextTitle) ? 'title' : 'summary',
        });
    return { title: nextTitle, summary: nextSummary, generated: true };
}

const LANGUAGE_SYSTEM_KO = [
    '너는 발행 묶음의 출력 언어를 판정하는 검사기다.',
    '문자 비율이나 문자 체계를 세어 언어를 추측하지 않는다.',
    '판정은 실제 자연어 필드(prose, title, summary, semanticDelta 의 설명 값)의 인용에만 근거한다.',
    'JSON 키, ID, enum, castManifestRaw, 기계 필드는 근거가 아니다.',
    '출력은 JSON 한 개: language, verdict, artifactHash, evidence, allowedExceptions. language는 목표 언어 태그를 그대로 쓴다.',
    'verdict 는 pass | fail | uncertain 뿐이다.',
    'artifactHash 는 입력에 주어진 값을 글자 그대로 되돌려 적는다.',
    'fail 이면 evidence 에 fieldPath, quote, reason 을 넣는다. quote 는 해당 필드에 실제로 있는 부분 문자열이어야 한다.',
].join(' ');

const LANGUAGE_SYSTEM_EN = [
    'You judge the output language of a publication bundle.',
    'Do not guess the language by character ratios or script counts.',
    'Ground the judgment only in quotes from natural-language fields (prose, title, summary, and descriptive values inside semanticDelta).',
    'JSON keys, IDs, enums, castManifestRaw and other machine fields are not evidence.',
    'Output one JSON object: language, verdict, artifactHash, evidence, allowedExceptions. Echo the target language exactly.',
    'verdict must be pass, fail, or uncertain.',
    'Echo artifactHash from the input exactly.',
    'A fail needs evidence entries with fieldPath, quote and reason. The quote must actually occur in that field.',
].join(' ');

async function requestLanguageCompliance(ctx, { artifact, artifactHash, promptLanguage, workContract }) {
    const system = [
        pickByFamily(promptLanguage, { ko: LANGUAGE_SYSTEM_KO, multilingual: LANGUAGE_SYSTEM_EN }),
        ...languageSystemLines(promptLanguage, { includeChapterLength: false }),
    ].join(' ');
    const labels = pickByFamily(promptLanguage, {
        ko: {
            hash: '## artifactHash',
            language: (tag) => `## 목표 언어\n${tag}`,
            bundle: '## 발행 묶음',
            ask: '위 묶음의 출력 언어를 판정하고 JSON 한 개만 출력하라.',
        },
        multilingual: {
            hash: '## artifactHash',
            language: (tag) => `## Target language\n${tag}`,
            bundle: '## Publication bundle',
            ask: 'Judge the output language of the bundle above and output one JSON object.',
        },
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
                    labels.hash,
                    artifactHash,
                    '',
                    labels.language(workContract.language),
                    '',
                    `language: ${workContract.language}`,
                    '',
                    labels.bundle,
                    JSON.stringify({
                        prose: artifact.prose,
                        title: artifact.title,
                        summary: artifact.summary,
                        semanticDelta: artifact.semanticDelta,
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
 * Blocking FORMAT layout only. Isolation is not applied in `natural` mode
 * (skip ≠ pass). Soft line-breaks remain blocking in every mode.
 */
export function scanBlockingFormat({ prose, chapterNumber, dialogueBreakMode = 'strict' }) {
    const text = String(prose ?? '').replace(/\r\n/g, '\n');
    const paragraphs = text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
    const violations = [];
    const multiLineParagraphs = paragraphs.filter((paragraph) => paragraph.split('\n').filter((line) => line.trim()).length > 1);
    const softLineBreaks = multiLineParagraphs.reduce((total, paragraph) => (
        total + Math.max(0, paragraph.split('\n').filter((line) => line.trim()).length - 1)
    ), 0);
    if (softLineBreaks >= 20 || multiLineParagraphs.length >= 12) {
        violations.push({
            severity: 'soft',
            code: 'WEBNOVEL_SOFT_LINEBREAKS',
            chapterNumber,
        });
    }
    if (dialogueBreakMode !== 'natural') {
        const mixedDialogue = paragraphs.filter((paragraph) => {
            const lines = paragraph.split('\n').filter((line) => line.trim());
            if (lines.length !== 1)
                return false;
            const line = lines[0];
            const quotes = line.match(/["“][^"”]+["”]|「[^」]+」|『[^』]+』/g) ?? [];
            if (!quotes.length)
                return false;
            if (dialogueBreakMode !== 'relaxed')
                return quotes.length !== 1 || paragraph.trim() !== quotes[0].trim();
            const outside = quotes.reduce((rest, quote) => rest.replace(quote, ''), line).trim();
            return outside.length > 100;
        });
        if (mixedDialogue.length) {
            violations.push({
                severity: 'soft',
                code: dialogueBreakMode === 'relaxed' ? 'WEBNOVEL_DIALOGUE_BURIED' : 'WEBNOVEL_DIALOGUE_NOT_ISOLATED',
                chapterNumber,
            });
        }
    }
    return { violations };
}

const KO_LEXICAL_CHECKERS = new Set([
    'checkPov',
    'scanLexicon',
    'scanSensitive',
    'scanWorldGroupConflict',
    'scanQuality',
    'scanStyle',
    'scanSentenceStats',
    'runProsodyScan',
    'scanDialogueMarkerVariety',
    'detectGapSkip',
    'detectCliffhanger',
    'scanDialogueRatio',
]);

function detectorEnvelope(checkerId, fn, input) {
    if (KO_LEXICAL_CHECKERS.has(checkerId)) {
        const skip = skipKoLexical(input, checkerId);
        if (skip)
            return skip;
    }
    return runDetector(checkerId, fn, input);
}

function runChapterDetectors({
    prose,
    chapterNumber,
    foundation,
    sensitiveMode,
    castManifest,
    arcPosition,
    promptLanguage,
    dialogueBreakMode,
}) {
    const input = {
        prose,
        chapterNumber,
        foundation,
        language: promptLanguage.language,
        workContract: promptLanguage.contract,
        promptFamily: promptLanguage.promptFamily,
        dialogueBreakMode,
        sensitiveMode,
        povMode: foundation?.povMode,
    };
    const emotionLexicon = new DefaultEmotionVerbLexicon();
    const results = [];
    const push = (checkerId, fn) => {
        results.push(detectorEnvelope(checkerId, fn, input));
    };

    if (ENGINE_GENRES.includes(foundation.genre)) {
        push('scanStyle', () => scanStyle({
            prose, chapterNumber, genre: foundation.genre, lexicon: new DefaultStyleLexicon(),
        }));
    }
    push('scanQuality', () => scanQuality({
        prose,
        chapterNumber,
        emotionLexicon,
        simileLexicon: new DefaultSimileMarkerLexicon(),
        onomatopoeiaLexicon: new DefaultOnomatopoeiaLexicon(),
    }));
    push('scanSentenceStats', () => scanSentenceStats({ prose, chapterNumber }));
    push('scanDialogueMarkerVariety', () => scanDialogueMarkerVariety({ prose, chapterNumber }));
    push('detectCliffhanger', () => detectCliffhanger({ prose, chapterNumber, arcPosition }));
    push('detectGapSkip', () => detectGapSkip({ prose, chapterNumber }));
    push('scanDialogueRatio', () => scanDialogueRatio({
        prose, chapterNumber, genreProfile: foundation.genreProfile,
    }));
    push('scanInfoRestate', () => scanInfoRestate({ prose, chapterNumber, foundation }));
    push('scanFanficLeak', () => scanFanficLeak({ prose, chapterNumber, foundation }));
    push('scanWorldGroupConflict', () => scanWorldGroupConflict({ prose, chapterNumber, foundation }));
    push('scanSensitive', () => scanSensitive({
        prose, chapterNumber, lexicon: new DefaultSensitiveLexicon(), mode: sensitiveMode,
    }));
    const narratorId = promptLanguage.promptFamily === 'ko'
        ? resolveNarrator({ prose, foundation, castManifest }).narratorId : null;
    push('checkPov', () => checkPov({
        prose, chapterNumber, foundation, narratorId, emotionLexicon,
    }));
    push('scanEntityMentions', () => {
        const snapshots = (foundation.entities ?? foundation.entitySnapshots ?? []);
        return Array.isArray(snapshots) && snapshots.length > 0
            ? scanEntityMentions({ text: prose, snapshots })
            : { violations: [] };
    });
    push('scanWebnovelFormat', () => scanBlockingFormat({ prose, chapterNumber, dialogueBreakMode }));
    push('countLength', () => {
        const measured = countLength(prose, promptLanguage.contract.measurementPolicy);
        validateLengthMeasurementResult(measured, promptLanguage.contract.measurementPolicy);
        return { violations: [], stats: measured };
    });
    return results;
}

function schemaValidated({ extractionValidation, delta, chapterNumber, bundle, foundation }) {
    if (!validatePublicationManifest(bundle.castManifestRaw, { foundation }).valid)
        return false;
    if (extractionValidation?.status !== 'completed')
        return false;
    if (delta == null || typeof delta !== 'object' || Array.isArray(delta))
        return false;
    if (delta.chapterNumber !== chapterNumber)
        return false;
    for (const key of ['appearedCharacterIds', 'newAddressEntries', 'relationshipOps', 'hookOps', 'mutableChanges', 'influenceEvents']) {
        if (!Array.isArray(delta[key]))
            return false;
    }
    try {
        canonicalArtifact(bundle);
        return true;
    }
    catch {
        return false;
    }
}

function lengthValidated(prose, workContract) {
    try {
        const measured = countLength(prose, workContract.measurementPolicy);
        validateLengthMeasurementResult(measured, workContract.measurementPolicy);
        return measured.count > 0;
    }
    catch {
        return false;
    }
}

function formatRow(plan) {
    return (plan.rows ?? []).find((row) => row.invariantId === 'FORMAT' && row.invariant === 'required') ?? null;
}

function blockingFormat(result) {
    const violations = result?.violations;
    if (!Array.isArray(violations))
        return false;
    return violations.some((item) => item && FORMAT_LAYOUT_CODES.has(item.code));
}

function semanticEvidenceFrom({
    semanticValidation,
    plan,
    schemaOk,
    lengthOk,
    languageOk,
    formatResult,
    dialogueBreakMode,
}) {
    const evidence = {};
    if (schemaOk)
        evidence.SCHEMA = 'pass';
    if (lengthOk)
        evidence.LENGTH = 'pass';
    if (languageOk)
        evidence.OUTPUT_LANGUAGE = 'pass';

    const requiredSemantic = new Set([
        ...requiredSemanticInvariantIds(plan),
        ...((plan.rows ?? [])
            .filter((row) => row.requiresSemantic === true
                && row.invariant === 'required'
                && row.applicability !== 'not_applicable'
                && row.invariantId)
            .map((row) => row.invariantId)),
    ]);

    if (semanticValidation?.status === 'completed') {
        for (const [id, verdict] of Object.entries(semanticValidation.verdicts ?? {})) {
            if (verdict === 'pass' || verdict === 'fail' || verdict === 'uncertain')
                evidence[id] = verdict;
        }
    }

    const format = formatRow(plan);
    if (format) {
        if (format.requiresSemantic) {
            if (evidence.FORMAT !== 'pass' && evidence.FORMAT !== 'fail') {
                // Continuity may not yet verdict FORMAT. Do not fabricate a pass.
                delete evidence.FORMAT;
            }
        }
        else if (blockingFormat(formatResult))
            evidence.FORMAT = 'fail';
        else if (formatResult && formatResult.status !== 'error' && formatResult.status !== 'unrun') {
            if (dialogueBreakMode === 'natural' && (formatResult.status === 'skipped')) {
                // Isolation skip is not FORMAT pass.
            }
            else if (formatResult.status === 'skipped' && (format.ifSkipped === 'semantic_required' || format.requiresSemantic)) {
                delete evidence.FORMAT;
            }
            else
                evidence.FORMAT = 'pass';
        }
    }

    for (const id of requiredSemantic) {
        if (semanticValidation?.status !== 'completed') {
            if (id !== 'SCHEMA' && id !== 'LENGTH' && id !== 'OUTPUT_LANGUAGE' && id !== 'FORMAT')
                delete evidence[id];
            else if (id === 'FORMAT' && format?.requiresSemantic)
                delete evidence[id];
        }
    }
    return evidence;
}

function expectedFromIdentity(identity, { artifactHash = null, checkerPlan, languageFields = CHAPTER_LANGUAGE_FIELDS }) {
    const expected = {
        workId: identity.workId,
        chapter: identity.chapter,
        validationEpoch: identity.validationEpoch,
        sourceHead: identity.sourceHead,
        planSourceHash: identity.planSourceHash,
        artifactKind: identity.artifactKind,
        checkerPlan,
        workContract: identity.workContract,
        languageFields,
    };
    if (identity.workflowId)
        expected.workflowId = identity.workflowId;
    if (identity.runId)
        expected.runId = identity.runId;
    if (artifactHash)
        expected.artifactHash = artifactHash;
    return expected;
}

/**
 * Build the checked 5-field bundle, run real checks, issue a receipt.
 * Does not persist. Continuity/sanitize/quality failures are returned so the
 * existing bounded loop can throw its own error types (no import cycle).
 */
export async function prepareChapterPublication(ctx, args) {
    const {
        prose: raw,
        foundation,
        prevState,
        chapterNumber,
        plan,
    } = args;
    const sensitiveMode = args.sensitiveMode ?? 'adult';
    const identity = await resolveTrustedChapterIdentity(ctx, { foundation, chapterNumber, plan });
    const { promptLanguage, workContract, dialogueBreakMode } = identity;
    const previousRecord = await publicationRecord(ctx, chapterNumber);
    if (previousRecord?.validationEpoch > identity.validationEpoch
        || (previousRecord?.status === 'consumed' && previousRecord.validationEpoch === identity.validationEpoch))
        fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, { reason: 'epoch_regressed' });
    const attempt = previousRecord?.validationEpoch === identity.validationEpoch
        ? (previousRecord.attempt ?? 0) + 1 : 1;
    if (attempt > 3) fail(VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE, { reason: 'validation_budget_exhausted', attempts: 3 });
    const storedPrevState = await priorState(ctx, chapterNumber);
    if (JSON.stringify(storedPrevState) !== JSON.stringify(prevState))
        fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, { reason: 'previous_state_changed' });
    await ctx.state.saveJob({ id: publicationJobId(ctx, chapterNumber), workId: ctx.workId,
        validationEpoch: identity.validationEpoch, attempt, status: 'validating' });

    const checkerPlan = describeChapterCheckerPlan({
        foundation,
        promptLanguage,
        dialogueBreakMode,
        sensitiveMode,
    });

    const sanitizer = ctx.sanitizer;
    if (!sanitizer || typeof sanitizer.extractBlock !== 'function' || typeof sanitizer.sanitize !== 'function')
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { reason: 'absent_sanitizer' });

    const manifestBlock = sanitizer.extractBlock(raw, 'cast-manifest');
    const castManifestRaw = manifestBlock?.body ?? '';
    const sanitize = sanitizer.sanitize(raw);
    if (sanitize.leaked) {
        return {
            ok: false,
            failure: 'sanitize-leak',
            message: `ChapterWrite: output-sanitizer detected residual sentinel/leak in chapter ${chapterNumber}`,
            identity,
        };
    }
    const prose = sanitize.clean.trim();

    const lexicon = new DefaultHonorificLexicon();
    const extracted = await extractDelta({
        prose: raw,
        castManifestRaw: castManifestRaw === '' ? '{"cast":[]}' : castManifestRaw,
        chapterNumber,
        foundation,
        prevState,
        providers: ctx.providers,
        model: ctx.model,
        workContract,
        promptLanguage,
        language: promptLanguage.language,
        checkerPlan,
    });
    const { delta, manifest, unregisteredNamed, extractionValidation } = extracted;

    const check = await continuityCheck({
        prose: raw,
        chapterNumber,
        delta,
        prevState,
        foundation,
        lexicon,
        providers: ctx.providers,
        model: ctx.model,
        workContract,
        promptLanguage,
        language: promptLanguage.language,
        checkerPlan,
    });
    if (!check.passed) {
        return {
            ok: false,
            failure: 'continuity',
            violations: check.violations,
            identity,
            draft: { prose, delta, castManifestRaw },
        };
    }

    const detectorResults = runChapterDetectors({
        prose,
        chapterNumber,
        foundation,
        sensitiveMode,
        castManifest: manifest,
        arcPosition: ctx.arc?.currentPosition,
        promptLanguage,
        dialogueBreakMode,
    });
    const auxHard = detectorResults.flatMap((result) => (result?.violations ?? []).filter((v) => v && v.severity === 'hard'));
    if (auxHard.length > 0) {
        return {
            ok: false,
            failure: 'continuity',
            violations: [...check.violations, ...auxHard],
            identity,
            draft: { prose, delta, castManifestRaw },
        };
    }

    if (ctx.qualityThreshold) {
        const prosody = promptLanguage.promptFamily === 'ko' ? runProsodyScan(prose) : { score: null };
        let coherence = { score: null, reason: null };
        if (ctx.qualityThreshold.coherence !== null) {
            coherence = await runCoherenceJudge({
                prose,
                chapterNumber,
                plan,
                writerModel: ctx.model,
                providers: ctx.providers,
                promptLanguage,
            });
        }
        const qualityResult = evaluateChapterQuality({
            chapterNumber,
            prosodyScore: prosody.score,
            coherenceScore: coherence.score,
            threshold: ctx.qualityThreshold,
        });
        if (prosody.score === null) {
            qualityResult.fails = qualityResult.fails.filter((item) => item.axis !== 'prosody');
            qualityResult.pass = qualityResult.fails.length === 0;
        }
        if (!qualityResult.pass) {
            return {
                ok: false,
                failure: 'quality',
                fails: qualityResult.fails,
                violations: failsToViolations(chapterNumber, qualityResult.fails),
                identity,
                draft: { prose, delta, castManifestRaw },
            };
        }
    }

    let title = args.title;
    let summary = args.summary;
    if (summary == null && typeof ctx.state?.loadChapterSummary !== 'function') {
        // Caller may still supply summary via the combined title-summary request.
    }
    if (!nonEmptyString(title) || summary == null) {
        if (nonEmptyString(title) && summary == null) {
            const generated = await runChapterSummary({
                prose,
                chapterNumber,
                writerModel: ctx.model,
                providers: ctx.providers,
                promptLanguage,
                summaryLength: ctx.summaryLength ?? null,
            });
            if (generated.summaryStatus === 'fallback')
                fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
                    reason: 'summary_unvalidated_fallback',
                    field: 'summary',
                });
            summary = generated.summary;
        }
        else {
            const generated = await generateTitleAndSummary(ctx, {
                prose, chapterNumber, promptLanguage, title, summary,
            });
            title = generated.title;
            summary = generated.summary;
        }
    }

    if (hasOwn(args, 'castManifestRaw') && args.castManifestRaw !== castManifestRaw)
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { reason: 'cast_manifest_changed_after_extraction' });
    const publishedCast = castManifestRaw;
    const bundle = {
        prose,
        title,
        summary,
        semanticDelta: delta,
        castManifestRaw: publishedCast,
    };
    const canonical = canonicalArtifact(bundle);
    const artifactHash = computeArtifactHash(canonical);

    const schemaOk = schemaValidated({
        extractionValidation,
        delta,
        chapterNumber,
        bundle: canonical,
        foundation,
    });
    const lengthOk = lengthValidated(prose, workContract);
    const formatResult = detectorResults.find((row) => row?.checkerId === 'scanWebnovelFormat') ?? null;

    let languageCompliance = null;

    if (!languageCompliance) {
        const rawCompliance = await requestLanguageCompliance(ctx, {
            artifact: canonical,
            artifactHash,
            promptLanguage,
            workContract,
        });
        languageCompliance = rawCompliance;
    }

    let evaluatedLanguage;
    try {
        evaluatedLanguage = evaluateLanguageCompliance({
            compliance: languageCompliance,
            artifact: canonical,
            workContract,
            languageFields: CHAPTER_LANGUAGE_FIELDS,
        });
    }
    catch (err) {
        throw err;
    }
    if (evaluatedLanguage.verdict === 'fail')
        fail(VALIDATION_ERROR_CODES.OUTPUT_LANGUAGE_MISMATCH, {
            evidence: evaluatedLanguage.evidence,
            draft: { prose, title, summary, semanticDelta: delta, castManifestRaw: publishedCast },
        });
    if (evaluatedLanguage.verdict === 'uncertain')
        fail(VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE, {
            reason: 'language_verdict_uncertain',
            draft: { prose, title, summary, semanticDelta: delta, castManifestRaw: publishedCast },
        });

    const semanticEvidence = semanticEvidenceFrom({
        semanticValidation: check.semanticValidation,
        plan: checkerPlan,
        schemaOk,
        lengthOk,
        languageOk: evaluatedLanguage.verdict === 'pass',
        formatResult,
        dialogueBreakMode,
    });
    const aggregated = aggregateCheckerCoverage(checkerPlan, detectorResults, semanticEvidence);
    const coverage = evaluateInvariantCoverage({
        plan: checkerPlan,
        coverage: aggregated,
        artifactKind: ARTIFACT_KIND_CHAPTER,
    });
    if (!coverage.complete) {
        fail(VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE, {
            blocked: coverage.blocked,
            semanticValidation: check.semanticValidation ?? null,
            extractionValidation: extractionValidation ?? null,
            draft: { prose, title, summary, semanticDelta: delta, castManifestRaw: publishedCast },
        });
    }

    const receipt = buildValidationReceipt({
        workId: identity.workId,
        chapter: identity.chapter,
        workflowId: identity.workflowId,
        runId: identity.runId,
        validationEpoch: identity.validationEpoch,
        sourceHead: identity.sourceHead,
        planSourceHash: identity.planSourceHash,
        workContract,
        artifact: canonical,
        artifactKind: ARTIFACT_KIND_CHAPTER,
        checkerPlan,
        languageCompliance: evaluatedLanguage,
        coverage,
        languageFields: CHAPTER_LANGUAGE_FIELDS,
        issuedBy: 'engine-chapter-validation',
    });

    await ctx.state.saveJob({
        id: publicationJobId(ctx, chapterNumber), workId: ctx.workId,
        validationEpoch: identity.validationEpoch, attempt, status: 'checked',
        receipt, canonical, languageCompliance: evaluatedLanguage, coverage, checkerPlan,
        identity, plan, prevState, sensitiveMode, foundationHash: sha256Text(JSON.stringify(foundation)),
    });

    return {
        ok: true,
        canonical,
        receipt,
        reusedReceipt: false,
        languageCompliance: evaluatedLanguage,
        coverage,
        checkerPlan,
        identity,
        delta,
        manifest,
        unregisteredNamed,
        extractionValidation,
        semanticValidation: check.semanticValidation,
        continuityContextHash: computeContinuityContextHash({
            chapterNumber,
            prose: raw,
            foundation,
            delta,
            prevState,
            workContract,
        }),
    };
}

export async function checkChapterPublication(ctx, prepared) {
    if (!prepared?.ok)
        return prepared;
    const { identity, canonical, receipt, checkerPlan, languageCompliance, coverage } = prepared;
    validateValidationReceipt({
        receipt,
        expected: expectedFromIdentity(identity, {
            artifactHash: computeArtifactHash(canonical),
            checkerPlan,
        }),
        artifact: canonical,
        workContract: identity.workContract,
        languageCompliance,
        coverage,
        languageFields: CHAPTER_LANGUAGE_FIELDS,
    });
    return prepared;
}

/**
 * Consume-only commit. Zero provider calls. No summary generation, no delta
 * repair, no Unicode normalization.
 */
export async function consumeChapterPublication(ctx, args) {
    const receipt = gateSlot(ctx, args, 'validationReceipt') ?? args.receipt ?? null;
    if (receipt == null)
        fail(VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT, { reason: 'absent' });

    if (receipt.stale) fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, { reason: 'stale' });
    if (receipt.consumed) fail(VALIDATION_ERROR_CODES.RECEIPT_ALREADY_CONSUMED, { checkId: receipt.checkId });
    const chapterNumber = args.chapterNumber;
    const record = await publicationRecord(ctx, chapterNumber);
    if (record?.status === 'consumed' && record.receipt?.checkId === receipt.checkId)
        fail(VALIDATION_ERROR_CODES.RECEIPT_ALREADY_CONSUMED, { checkId: receipt.checkId });
    if (record?.status !== 'checked' || record.receipt?.checkId !== receipt.checkId)
        fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, { reason: 'no_current_checked_candidate' });
    const foundation = await ctx.state.loadFoundation(ctx.workId);
    if (record.foundationHash !== sha256Text(JSON.stringify(foundation)))
        fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, { reason: 'foundation_changed' });
    const identity = await resolveTrustedChapterIdentity(ctx, {
        foundation, chapterNumber, plan: record.plan,
    });
    if (args.plan != null && sha256Text(typeof args.plan === 'string' ? args.plan : JSON.stringify(args.plan)) !== identity.planSourceHash)
        fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, { reason: 'plan_changed' });
    const checkerPlan = describeChapterCheckerPlan({
        foundation, promptLanguage: identity.promptLanguage,
        dialogueBreakMode: identity.dialogueBreakMode,
        sensitiveMode: record.sensitiveMode,
    });
    if (args.sensitiveMode != null && args.sensitiveMode !== record.sensitiveMode)
        fail(VALIDATION_ERROR_CODES.CHECKER_PLAN_MISMATCH, { reason: 'sensitive_policy_changed' });
    const prevState = await priorState(ctx, chapterNumber);
    if (JSON.stringify(prevState) !== JSON.stringify(record.prevState))
        fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, { reason: 'previous_state_changed' });

    const bundle = args.canonical ?? args.canonicalArtifact ?? args.artifact;
    if (!bundle)
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { reason: 'missing_canonical_artifact' });
    const canonical = canonicalArtifact({
        prose: bundle.prose,
        title: bundle.title,
        summary: bundle.summary,
        semanticDelta: bundle.semanticDelta ?? bundle.delta,
        castManifestRaw: bundle.castManifestRaw,
    });

    const manifestValidation = validatePublicationManifest(canonical.castManifestRaw, { foundation });
    if (!manifestValidation.valid)
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
            invariantId: 'SCHEMA', reason: manifestValidation.reason,
        });

    validateValidationReceipt({
        receipt,
        expected: expectedFromIdentity(identity, {
            artifactHash: computeArtifactHash(canonical),
            checkerPlan,
        }),
        artifact: canonical,
        workContract: identity.workContract,
        languageCompliance: record.languageCompliance,
        coverage: record.coverage,
        languageFields: CHAPTER_LANGUAGE_FIELDS,
    });

    const consumed = markReceiptConsumed(receipt);
    const nextDelta = canonical.semanticDelta;
    const nextState = reduceStoryState(prevState, nextDelta);
    await ctx.state.saveJob({ ...record, receipt: consumed, status: 'consumed' });
    await ctx.state.saveStoryState(nextState);
    const artifact = {
        workId: ctx.workId,
        chapterNumber,
        prose: canonical.prose,
        title: canonical.title,
        summary: canonical.summary,
        delta: nextDelta,
        castManifestRaw: canonical.castManifestRaw,
        validationReceipt: consumed,
        validationEvidence: { languageCompliance: record.languageCompliance, coverage: record.coverage, checkerPlan },
    };
    await ctx.state.saveArtifact(artifact);
    if (typeof ctx.state.saveChapterSummary === 'function') {
        const summaryText = typeof canonical.summary === 'string'
            ? canonical.summary
            : (canonical.summary && typeof canonical.summary === 'object' && typeof canonical.summary.summary === 'string'
                ? canonical.summary.summary
                : JSON.stringify(canonical.summary));
        await ctx.state.saveChapterSummary({
            workId: ctx.workId,
            chapterNumber,
            summary: summaryText,
            plotBeat: args.summaryMeta?.plotBeat ?? null,
            sceneTags: args.summaryMeta?.sceneTags ?? [],
            povCharacter: args.summaryMeta?.povCharacter ?? null,
            registeredEntities: [],
        });
    }
    return { artifact, validationReceipt: consumed };
}

/** Static system families for engine-version prompt capture. */
export const PUBLIC_CHAPTER_PROMPT_SYSTEMS = Object.freeze({
    'chapter-title-summary': Object.freeze({ ko: TITLE_SUMMARY_SYSTEM_KO, multilingual: TITLE_SUMMARY_SYSTEM_EN }),
    'output-language-compliance': Object.freeze({ ko: LANGUAGE_SYSTEM_KO, multilingual: LANGUAGE_SYSTEM_EN }),
});
