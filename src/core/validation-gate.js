/**
 * Plugin validation gate (Phase 3).
 *
 * Consumes the shared engine verifier and checker registry. Issues and
 * consumes receipts. Does not invent coverage, NFC-normalize strings, or
 * treat PendingModelWork as a counted validator attempt.
 */
import { createHash } from 'node:crypto';

import {
  ARTIFACT_KIND_APPROVAL,
  ARTIFACT_KIND_CHAPTER,
  VALIDATION_ERROR_CODES,
  VALIDATOR_VERSION,
  ValidationContractError,
  buildApprovalBinding,
  buildValidationReceipt,
  canonicalApprovalArtifact,
  canonicalArtifact,
  computeArtifactHash,
  evaluateInvariantCoverage,
  evaluateLanguageCompliance,
  markReceiptConsumed,
  markReceiptStale,
  validateApprovalBinding,
  validateValidationReceipt,
} from '../../engine/src/core/validation-contract.js';
import {
  aggregateCheckerCoverage,
  describeCheckerPlan,
  runDetector,
  skipKoLexical,
} from '../../engine/src/continuity/checker-registry.js';
import { countLength } from '../../engine/src/core/length-measure.js';
import { DefaultOutputSanitizer } from '../../engine/src/core/output-sanitizer.js';
import { buildLanguageDirective, computeLanguageContractHash } from '../../engine/src/core/language-policy.js';
import { scanLexicon } from '../../engine/src/continuity/lexicon-scan.js';
import { scanSensitive } from '../../engine/src/continuity/sensitive-lexicon.js';
import { scanQuality } from '../../engine/src/continuity/quality-scan.js';
import { checkPov } from '../../engine/src/continuity/pov-check.js';
import { scanDialogueRatio } from '../../engine/src/continuity/dialogue-ratio.js';
import { scanDialogueMarkerVariety } from '../../engine/src/continuity/dialogue-marker-variety.js';
import { scanInfoRestate } from '../../engine/src/continuity/info-restate-detector.js';
import { detectGapSkip } from '../../engine/src/continuity/gap-skip-detector.js';
import { detectCliffhanger } from '../../engine/src/continuity/cliffhanger-detector.js';
import { runProsodyScan } from '../../engine/src/continuity/prosody-scan.js';
import { scanFanficLeak } from '../../engine/src/continuity/fanfic-leak-detector.js';
import { scanWorldGroupConflict } from '../../engine/src/continuity/world-group-conflict-detector.js';
import { scanEntityMentions } from '../../engine/src/core/mention-scan.js';
import { scanSentenceStats } from '../../engine/src/continuity/sentence-stats.js';
import { scanStyle } from '../../engine/src/continuity/style-scan.js';
import * as continuityApi from '../../engine/src/continuity/continuity-check.js';
import { scanWebnovelFormat } from '../tools/webnovel-format.js';
import { lexiconsForLanguage } from '../tools/lexicons.js';
import { trailingCastMetadata } from '../tools/prose-integrity.js';
import { isNewContractWork } from './work-language.js';

export const MAX_VALIDATION_ATTEMPTS = 3;
export const SEMANTIC_INVARIANT_IDS = Object.freeze([
  'FORMAT', 'ADDRESSING', 'INTRINSIC', 'POV', 'REGISTRATION', 'SENSITIVE', 'WORLD',
]);
const sanitizer = new DefaultOutputSanitizer();
const MODEL = { provider: 'host', modelId: 'host-agent' };

export {
  ARTIFACT_KIND_APPROVAL,
  ARTIFACT_KIND_CHAPTER,
  VALIDATION_ERROR_CODES,
  VALIDATOR_VERSION,
  ValidationContractError,
  buildApprovalBinding,
  canonicalApprovalArtifact,
  canonicalArtifact,
  computeArtifactHash,
  isNewContractWork,
  markReceiptConsumed,
  markReceiptStale,
  validateApprovalBinding,
};

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computePlanSourceHash({ episodePlan = null, chapterPlan = null, workContract }) {
  return sha256(canonicalJson({
    episodePlan: episodePlan ?? null,
    chapterPlan: chapterPlan ?? null,
    contractHash: computeLanguageContractHash(workContract),
  }));
}

export function liveCheckerPlan({ workContract, foundation = null, profile = null, language = null } = {}) {
  return describeCheckerPlan({
    language: language ?? workContract?.language,
    workContract,
    foundation,
    approvedProfile: profile,
    formatPolicy: workContract?.formatPolicy,
    dialogueBreakMode: workContract?.formatPolicy?.dialogueBreakMode,
    povMode: foundation?.povMode ?? profile?.format?.pov ?? null,
  });
}

export function publishedChapterProse(prose) {
  const sanitized = sanitizer.sanitize(String(prose ?? ''));
  if (sanitized.leaked)
    throw new Error('본문에 제거되지 않은 내부 sentinel이 남았습니다.');
  return sanitized.clean.trim();
}

export function chapterArtifactBundle({
  prose, title, summary, semanticDelta, castManifestRaw,
}) {
  const published = publishedChapterProse(prose);
  return canonicalArtifact({
    prose: published,
    title, summary, semanticDelta, castManifestRaw,
  });
}

const FORMAT_LAYOUT = new Set([
  'WEBNOVEL_DIALOGUE_BURIED',
  'WEBNOVEL_DIALOGUE_NOT_ISOLATED',
  'WEBNOVEL_SOFT_LINEBREAKS',
]);

function blockingFormat(violations) {
  return (violations ?? []).some((item) => item?.severity === 'hard' || FORMAT_LAYOUT.has(item?.code));
}

export function requiredSemanticInvariantIds(plan) {
  const ids = new Set();
  for (const row of plan?.rows ?? []) {
    if (!SEMANTIC_INVARIANT_IDS.includes(row.invariantId))
      continue;
    if (row.invariant !== 'required')
      continue;
    if (row.applicability === 'not_applicable')
      continue;
    if (row.requiresSemantic)
      ids.add(row.invariantId);
  }
  return [...ids].sort();
}

function parseJsonBlock(raw) {
  const text = String(raw ?? '').replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();
  try {
    return { ok: true, value: JSON.parse(text) };
  }
  catch {
    return { ok: false, value: null };
  }
}

/**
 * Consume engine `result.semanticValidation` when present. The same
 * continuity-check model response may already carry the frozen block; that is
 * reuse of the existing request, not a fabricated pass from empty findings.
 */
export function readSemanticValidation(continuityResult, _rawText, { expectedContextHash } = {}) {
  const result = continuityResult?.semanticValidation;
  if (!expectedContextHash || !result || result.contextHash !== expectedContextHash)
    return { status: 'invalid', contextHash: expectedContextHash ?? null, verdicts: {}, evidence: [] };
  return result;
}

export function continuityContextHash(input) {
  return continuityApi.computeContinuityContextHash(input);
}

function detectorFns(ctx) {
  const { prose, chapter, foundation, lex, workContract, arcPosition } = ctx;
  const languageInput = {
    prose, chapterNumber: chapter, foundation, workContract,
    language: workContract.language,
    formatPolicy: workContract.formatPolicy,
    dialogueBreakMode: workContract.formatPolicy?.dialogueBreakMode,
  };
  return {
    checkPov: () => checkPov({
      ...languageInput, narratorId: foundation?.narratorId, emotionLexicon: lex.emotion,
    }),
    scanLexicon: () => scanLexicon({ ...languageInput, lexicon: lex.honorific }),
    scanSensitive: () => scanSensitive({ ...languageInput, lexicon: lex.sensitive }),
    scanQuality: () => scanQuality({
      ...languageInput, emotionLexicon: lex.emotion, simileLexicon: lex.simile, onomatopoeiaLexicon: lex.onomatopoeia,
    }),
    scanStyle: () => scanStyle({ ...languageInput }),
    scanDialogueRatio: () => scanDialogueRatio({ ...languageInput, genreProfile: foundation?.genreProfile }),
    scanDialogueMarkerVariety: () => scanDialogueMarkerVariety({ ...languageInput }),
    scanInfoRestate: () => scanInfoRestate({ ...languageInput }),
    detectGapSkip: () => detectGapSkip({ ...languageInput }),
    detectCliffhanger: () => detectCliffhanger({ ...languageInput, arcPosition }),
    scanSentenceStats: () => scanSentenceStats({ ...languageInput }),
    runProsodyScan: () => runProsodyScan(prose),
    scanFanficLeak: () => scanFanficLeak({ ...languageInput }),
    scanWorldGroupConflict: () => scanWorldGroupConflict({ ...languageInput }),
    scanWebnovelFormat: () => scanWebnovelFormat({ ...languageInput }),
    scanEntityMentions: () => scanEntityMentions({ text: prose ?? '', snapshots: ctx.entities ?? [] }),
    countLength: () => countLength(prose, workContract.measurementPolicy),
  };
}

export function runPlannedDetectors({ plan, prose, chapter, foundation, workContract, arcPosition = 'rising', entities = [] }) {
  const lexPack = lexiconsForLanguage(workContract.language);
  const lex = lexPack;
  const fns = detectorFns({ prose, chapter, foundation, lex, workContract, arcPosition, entities });
  const input = {
    prose, chapterNumber: chapter, foundation, workContract,
    language: workContract.language, formatPolicy: workContract.formatPolicy,
    dialogueBreakMode: workContract.formatPolicy?.dialogueBreakMode,
  };
  const results = [];
  const violations = [];
  for (const row of plan.rows) {
    if (!row.checkerId)
      continue;
    if (!row.runDetector) {
      const skipped = skipKoLexical(input, row.checkerId) ?? {
        checkerId: row.checkerId, status: 'skipped', skipReason: row.skipReason, violations: [],
        stats: null, score: null,
      };
      results.push(skipped);
      continue;
    }
    const fn = fns[row.checkerId];
    const ran = runDetector(row.checkerId, () => { if (!fn) throw new Error(`Missing detector: ${row.checkerId}`); return fn(); }, input);
    results.push(ran);
    if (Array.isArray(ran.violations))
      violations.push(...ran.violations);
  }
  return { detectorResults: results, violations };
}

export function schemaCoverage({ prose, foundation, artifact, extractionValidation, extractionContextHash }) {
  try {
    const published = publishedChapterProse(prose);
    if (!published)
      return 'failed';
    if (trailingCastMetadata(published, foundation?.characters ?? []).length > 0)
      return 'failed';
    for (const character of foundation?.characters ?? []) {
      if (character.id?.includes('_') && new RegExp(`(^|[^A-Za-z0-9_])${character.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'm').test(published))
        return 'failed';
    }
    if (!artifact || extractionValidation?.status !== 'completed' || extractionValidation.contextHash !== extractionContextHash)
      return 'unvalidated';
    canonicalArtifact(artifact);
    return 'validated';
  }
  catch {
    return 'failed';
  }
}

export function lengthCoverage({ workContract, prose }) {
  try {
    const measured = countLength(prose, workContract.measurementPolicy);
    const target = workContract.length.target;
    const min = Math.max(1, Math.floor(target * 0.85));
    const coverage = measured.count < min ? 'failed' : 'validated';
    return {
      coverage,
      measurement: {
        unit: measured.unit,
        actual: measured.count,
        min,
        recommended: target,
        target,
      },
    };
  }
  catch (err) {
    return {
      coverage: 'unvalidated',
      measurement: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function overlayInvariantCoverage({
  plan, detectorResults, semanticValidation, languageCompliance, schema, length, formatRan,
}) {
  const semanticEvidence = {};
  const requiredSemantic = requiredSemanticInvariantIds(plan);
  if (semanticValidation?.status === 'completed') {
    for (const id of requiredSemantic) {
      const verdict = semanticValidation.verdicts?.[id];
      if (verdict === 'pass')
        semanticEvidence[id] = 'pass';
      else if (verdict === 'fail')
        semanticEvidence[id] = 'fail';
      else
        semanticEvidence[id] = 'uncertain';
    }
  }
  const aggregated = aggregateCheckerCoverage(plan, detectorResults, semanticEvidence);
  const invariants = { ...aggregated.invariants };
  const set = (id, coverage) => {
    invariants[id] = { id, coverage, required: true, requiresSemantic: Boolean(invariants[id]?.requiresSemantic) };
  };
  if (schema)
    set('SCHEMA', schema);
  if (length)
    set('LENGTH', length);
  if (languageCompliance?.verdict === 'pass')
    set('OUTPUT_LANGUAGE', 'validated');
  else if (languageCompliance?.verdict === 'fail')
    set('OUTPUT_LANGUAGE', 'failed');
  else if (languageCompliance)
    set('OUTPUT_LANGUAGE', 'unvalidated');

  const formatRow = detectorResults.find((item) => item?.checkerId === 'scanWebnovelFormat');
  if (!invariants.FORMAT?.requiresSemantic && invariants.FORMAT?.coverage !== 'failed' && formatRan && formatRow && formatRow.status !== 'error' && formatRow.status !== 'skipped' && !blockingFormat(formatRow.violations))
    set('FORMAT', 'validated');
  else if (formatRow && blockingFormat(formatRow.violations))
    set('FORMAT', 'failed');

  return { aggregated, invariants };
}

const LANGUAGE_STEPS = Object.freeze({
  ko: {
    system: [
      '너는 발행 산출물 묶음의 출력 언어를 판정한다.',
      '목표 언어로 쓰인 본문·제목·요약·의미 delta 의 자연어만 본다.',
      '고유명, JSON 키, ID, enum, 실제 사용자 출처 필드는 예외다. 생성된 본문·설명의 외국어 인용은 승인된 범위별 예외에 해당할 때만 허용한다.',
      '문자 비율이나 문자 체계 추정으로 통과시키지 마라.',
      '순수 JSON만 출력한다.',
    ].join('\n'),
    user: (payload) => `목표 언어: ${payload.language}\nartifactHash: ${payload.artifactHash}\nvalidationEpoch: ${payload.epoch}\nattempt: ${payload.attempt}\n허용 예외: ${JSON.stringify(payload.exceptions)}\n산출물:\n${payload.artifactJson}\n\nJSON: {"verdict":"pass|fail|uncertain","language":"${payload.language}","artifactHash":"${payload.artifactHash}","evidence":[{"fieldPath":"prose|title|summary|semanticDelta","quote":"산출물에 있는 인용","reason":"이유"}],"allowedExceptions":[]}`,
  },
  multilingual: {
    system: [
      'Judge the output language of a publication artifact bundle.',
      'Only generated natural-language values in prose, title, summary, and semantic delta must be in the target language.',
      'Proper names, JSON keys, IDs, enums, and actual user-provenance fields are exempt. Foreign quotations in generated prose or descriptions require an approved scoped exception.',
      'Do not pass or fail by script ratio or script detection.',
      'Return JSON only.',
    ].join('\n'),
    user: (payload) => `Target language: ${payload.language}\nartifactHash: ${payload.artifactHash}\nvalidationEpoch: ${payload.epoch}\nattempt: ${payload.attempt}\nAllowed exceptions: ${JSON.stringify(payload.exceptions)}\nArtifact:\n${payload.artifactJson}\n\nJSON: {"verdict":"pass|fail|uncertain","language":"${payload.language}","artifactHash":"${payload.artifactHash}","evidence":[{"fieldPath":"prose|title|summary|semanticDelta","quote":"a quote that actually appears","reason":"why"}],"allowedExceptions":[]}`,
  },
});

export function languageComplianceMessages({ workContract, artifact, epoch, attempt }) {
  const family = workContract.promptFamily === 'ko' ? 'ko' : 'multilingual';
  const pack = LANGUAGE_STEPS[family];
  const directive = buildLanguageDirective(workContract);
  const artifactJson = JSON.stringify({
    prose: artifact.prose,
    title: artifact.title,
    summary: artifact.summary,
    semanticDelta: artifact.semanticDelta,
  });
  const payload = {
    language: workContract.language,
    artifactHash: computeArtifactHash(artifact),
    epoch,
    attempt,
    exceptions: workContract.allowedLanguageExceptions ?? [],
    artifactJson,
  };
  const system = family === 'ko'
    ? pack.system
    : [pack.system, ...(directive.system ?? [])].join('\n');
  return {
    system,
    user: pack.user(payload),
    artifactHash: payload.artifactHash,
  };
}

export async function requestLanguageCompliance({
  providers, workContract, artifact, epoch = 1, attempt = 1, model = MODEL,
}) {
  const messages = languageComplianceMessages({ workContract, artifact, epoch, attempt });
  const response = await providers.complete({
    model, jsonMode: true, step: 'language-contract',
    messages: [
      { role: 'system', content: messages.system },
      { role: 'user', content: messages.user },
    ],
  });
  return parseLanguageComplianceAnswer(response?.text, {
    targetLanguage: workContract.language,
    artifactHash: messages.artifactHash,
  });
}

export function parseLanguageComplianceAnswer(raw, { targetLanguage, artifactHash }) {
  const parsed = parseJsonBlock(raw);
  if (!parsed.ok)
    return { status: 'invalid', reason: 'invalid_json', compliance: null };
  const body = parsed.value?.languageCompliance && typeof parsed.value.languageCompliance === 'object'
    ? parsed.value.languageCompliance
    : parsed.value;
  if (!body || typeof body !== 'object')
    return { status: 'invalid', reason: 'not_an_object', compliance: null };
  if (body.language == null || body.language === '')
    return { status: 'invalid', reason: 'missing_language', compliance: null };
  if (String(body.language) !== String(targetLanguage))
    return { status: 'invalid', reason: 'language_mismatch', compliance: body };
  if (body.artifactHash !== artifactHash)
    return { status: 'invalid', reason: 'artifact_hash_mismatch', compliance: body };
  if (!['pass', 'fail', 'uncertain'].includes(body.verdict))
    return { status: 'invalid', reason: 'unknown_verdict', compliance: body };
  return {
    status: body.verdict === 'uncertain' ? 'uncertain' : 'ok',
    reason: null,
    compliance: {
      verdict: body.verdict,
      language: body.language,
      artifactHash: body.artifactHash,
      evidence: body.evidence,
      allowedExceptions: body.allowedExceptions,
    },
  };
}

/**
 * Count real invalid/uncertain validator answers. PendingModelWork is not an
 * attempt. The same fingerprint on replay is not counted twice.
 */
export function recordValidatorAttempt(state, { fingerprint, kind }) {
  const current = {
    epoch: Number(state?.epoch) > 0 ? Number(state.epoch) : 1,
    counted: Number(state?.counted) > 0 ? Number(state.counted) : 0,
    fingerprints: { ...(state?.fingerprints ?? {}) },
    attempt: Number(state?.attempt) > 0 ? Number(state.attempt) : 1,
  };
  if (!fingerprint)
    return current;
  if (current.fingerprints[fingerprint])
    return current;
  current.fingerprints[fingerprint] = { kind, countedAt: current.counted + 1 };
  current.counted += 1;
  return current;
}

export function retryValidationState(state) {
  return {
    epoch: (Number(state?.epoch) > 0 ? Number(state.epoch) : 1) + 1,
    counted: 0,
    fingerprints: {},
    attempt: 1,
  };
}

export function validationBudgetExhausted(state) {
  return Number(state?.counted) >= MAX_VALIDATION_ATTEMPTS;
}

export function evaluateChapterLanguage({ compliance, artifact, workContract }) {
  return evaluateLanguageCompliance({ compliance, artifact, workContract, targetLanguage: workContract.language });
}

export function evaluateChapterCoverage({ plan, coverage, artifactKind = ARTIFACT_KIND_CHAPTER }) {
  return evaluateInvariantCoverage({ plan, coverage, artifactKind });
}

export function issueChapterReceipt({
  workId, chapter, workflowId = null, runId = null, validationEpoch, sourceHead,
  planSourceHash, workContract, artifact, checkerPlan, languageCompliance, coverage, issuedBy = 'check',
}) {
  return buildValidationReceipt({
    workId, chapter, workflowId, runId, validationEpoch, sourceHead, planSourceHash,
    workContract, artifact, artifactKind: ARTIFACT_KIND_CHAPTER, checkerPlan,
    languageCompliance, coverage, issuedBy,
  });
}

export function consumeChapterReceipt({
  receipt, expected, artifact, workContract, languageCompliance, coverage,
}) {
  if (receipt == null)
    throw new ValidationContractError(VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT, { reason: 'absent' });
  return validateValidationReceipt({
    receipt,
    expected: {
      ...expected,
      artifactKind: expected.artifactKind ?? ARTIFACT_KIND_CHAPTER,
    },
    artifact,
    workContract,
    languageCompliance,
    coverage,
  });
}

export function approvalCheckerPlan() {
  return Object.freeze({
    checkerPolicyVersion: 1,
    promptFamily: null,
    rows: Object.freeze([
      Object.freeze({ invariantId: 'SCHEMA', invariant: 'required', applicability: 'run', requiresSemantic: false }),
      Object.freeze({ invariantId: 'OUTPUT_LANGUAGE', invariant: 'required', applicability: 'run', requiresSemantic: true }),
    ]),
  });
}

export function issueApprovalReceipt({
  workId, chapter = null, workflowId = null, runId = null, validationEpoch, sourceHead,
  planSourceHash, workContract, artifact, languageCompliance, coverage, issuedBy = 'approval',
}) {
  return buildValidationReceipt({
    workId, chapter, workflowId, runId, validationEpoch, sourceHead, planSourceHash,
    workContract, artifact, artifactKind: ARTIFACT_KIND_APPROVAL, checkerPlan: approvalCheckerPlan(),
    languageCompliance, coverage, issuedBy,
  });
}

export function consumeApprovalReceipt({ receipt, expected, artifact, workContract, languageCompliance, coverage }) {
  if (receipt == null)
    throw new ValidationContractError(VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT, { reason: 'absent' });
  return validateValidationReceipt({
    receipt,
    expected: { ...expected, artifactKind: ARTIFACT_KIND_APPROVAL, checkerPlan: expected.checkerPlan ?? approvalCheckerPlan() },
    artifact, workContract, languageCompliance, coverage,
  });
}

export function validateExceptionScopes({ exceptions, foundation, approvedQuotes = [] }) {
  const list = exceptions ?? [];
  const characterIds = new Set((foundation?.characters ?? []).map((item) => item.id));
  const quotes = new Set(approvedQuotes.map((item) => String(item)));
  for (const entry of list) {
    if (entry.kind === 'characterDialogue' && !characterIds.has(entry.scope)) {
      throw new ValidationContractError(VALIDATION_ERROR_CODES.UNAPPROVED_LANGUAGE_EXCEPTION ?? 'UNAPPROVED_LANGUAGE_EXCEPTION', {
        reason: 'character_dialogue_scope_unknown', scope: entry.scope,
      });
    }
    if (entry.kind === 'sourceQuote' && quotes.size > 0 && !quotes.has(entry.scope)) {
      throw new ValidationContractError(VALIDATION_ERROR_CODES.UNAPPROVED_LANGUAGE_EXCEPTION ?? 'UNAPPROVED_LANGUAGE_EXCEPTION', {
        reason: 'source_quote_not_approved', scope: entry.scope,
      });
    }
  }
  return list;
}

export function gateError(err) {
  if (err instanceof ValidationContractError)
    return err;
  return err;
}
