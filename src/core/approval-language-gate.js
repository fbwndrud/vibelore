/** Approval orchestration. Shared validation-contract owns every proof decision. */
import { createHash } from 'node:crypto';
import {
  canonicalApprovalArtifact, computeArtifactHash, buildValidationReceipt,
  validateValidationReceipt, evaluateLanguageCompliance,
} from '../../engine/src/core/validation-contract.js';
import { computeLanguageContractHash } from '../../engine/src/core/language-policy.js';
import { resolveWorkLanguage } from './work-language.js';
import { createPublicationUnit } from './publication-unit.js';
import { createGenreProfileRegistry } from '../../engine/src/continuity/genre-profile.js';
import { CHARACTER_ARC_BEATS } from '../../engine/src/continuity/character-arc.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const MAX_ATTEMPTS = 3;
const CONTROL = new Set(['createdAt', 'updatedAt', 'approvedAt', 'rejectedAt', 'activeAt', 'completedAt', 'status', 'approvalId', 'approvedBy', 'approvalLanguage', 'validationReceipt', 'confirmedByUser']);
const ENUMS = new Set(['depthMode', 'surfaceEase', 'conceptPacing', 'inferenceLoad', 'complexityRamp', 'phase', 'hookType', 'confidenceTarget', 'selectedCandidate', 'winnerId', 'candidateId', 'askedQuestionIds', 'weakDimensions', 'povCharacter', 'foregroundCharacters', 'cast', 'charactersPresent', 'choiceOwner', 'agendaIds', 'hooksTouched', 'sourceStep', 'ageBand', 'salienceClass', 'tier', 'viewpoint', 'scopePolicy', 'runtimeVersion', 'contractVersion', 'policyRevision', 'memoryVisibility', 'addressForm', 'relationType']);
const PROVENANCE = new Set(['sourceBrief', 'feedback', 'direction', 'userAnswerEvidence', 'userQuote', 'userSource']);
// Schema-owned engine configuration is not generated fiction. Its exact value is
// still bound to the artifact under a machine leaf.
const CONFIG = new Set(['genreProfile', 'workContract']);
const genreRegistry = createGenreProfileRegistry();
const HUMAN_FIELDS = `anchor observation locations narrativeReason negativeEvidence nonEvidence positiveEvidence saturationRisk visibleWant privateNeed protectedSecret lineTheyWillNotCross pressureThatMayBreakIt readerBelief characterBelief hiddenCausality evidenceToPlant revealPolicy startingVoice pressureVoice changedVoice sampleBefore sampleAfter unresolvedPressure previousPromise sourceEvidence objective power readerHypothesis hiddenPlan nextAction deadline resources consequence surfaceIntent hiddenIntent narrationFilter escalatingCosts mayResolve mustRemainCostly mustResolve actor adaptationTrigger independentGoal expectedPath minimumPayoff actionBias benefit public underPressure class missesFirst seesFirst privateDelights cannotDo firstMove unproductiveWant valueOrder birthOrder coreAppearance species form defaultRegister sentenceShape logicHabit emotionalLeak everyday lying intimate hair eyes build attire distinguishing vibe acceptedPronouns acceptedGenderedTerms forbiddenGenderedTerms statement canonicalName aliases roleHint contradiction competence flaw desire fear secret appearance personality background motivation relationships ability abilities weakness weaknesses speechPattern speechStyle occupation affiliation addressToOthers canonicalAddressToOthers currentGoal currentLocation currentEmotion signatureAction behavioralPattern worldEra fanficSource worldGroup brief worldbuild cast arc tracking engineBacked semantic settledDecisions worldbuilding usage trigger effect limitation examples forbidden preferred forbiddenExpressions preferredExpressions dramaticQuestion protagonistWant protagonistNeed falseBelief incitingDisruption initialStrategy causalChain midpointReframe finalChoice endingChange endingCost want actionThatChangesPlot protagonistAppeal competenceSignature emotionalDefect comedyEngines solutionPatternsToRotate beforeState firstFailure protagonistSpecificAction irreversibleChoice competenceProof humanHook seriesPromise closingQuestion withholdingInstinct payoffInstinct judgments omissions dialogueConduct selfBetrayal conflictSources escalationLaws protagonistError oppositionAdaptation commercialPromise fantasy humanComplication repeatableProof openingQuestion targetEmotion proofStandard escalationPromise turn carry readerExpectation payoff costCreatedByResolution exitValue conflict growth cost newConcept newConcepts complexityReason storySpineNodes lie truth test reward price voiceShift speakingPressure sampleLine coreDesire defensiveHabit oldStrategy newStrategy changeProof localWant obstacle choice outcome openingState immediateGoal likelyOutcome evidenceOnPage incompatibleGoods withheldByOther decisionDeadline brokenBelief priorClueReinterpreted immediate deferred beneficiary payer closedQuestion nextQuestion specificFutureValue reveals withheld powerChanges artifacts absurdity carryForward scarceConstraint agenda collision publicGoal privateGoal leverage risk willingnessToPay revelation truthRevealed falseInterpretation expectedInterpretation withheldReason audienceKnowledge newKnowledge authorityConstraint informationConstraint resourceConstraint consentConstraint consequenceConstraint timingConstraint physicalConstraint emotionalConstraint moralConstraint relationshipConstraint proceduralConstraint antagonisticPressure metricDramaturgy intrinsic traits values beliefs voiceNotes arcPromise startState endState milestones resistance pressurePoints desiredOutcome lossIfFail tactic boundary evidence constraint change titlePressure narrativeFunction sceneGoal sceneCost decision newFact focus targetCharacters availableEvidence hiddenEvidence knowledgeBoundary allowedInference forbiddenInference informationSource authoritySource sourceReliability motive salience justification rationale readerLegibility registerPolicy`.split(/\s+/);
export const APPROVAL_LANGUAGE_FIELDS = Object.freeze({ humanTextFields: Object.freeze([...new Set(HUMAN_FIELDS)].filter(name => !['rationale', 'role', 'scope', 'genre', 'kind'].includes(name))) });

function machineLeaf(key, path, value) {
  const parent = path.at(-1);
  if (key === 'cast') return path.length === 0;
  if (key === 'beat' && (path.includes('characterArcs') || path.includes('characterArcBeats'))) return CHARACTER_ARC_BEATS.includes(value);
  if (key === 'previousBeat') return parent === 'inheritedState' && CHARACTER_ARC_BEATS.includes(value);
  if (key === 'languageChangedFrom') return path.length === 0;
  if (key === 'characters' && Array.isArray(value) && value.every(item => typeof item === 'string')) return path.includes('scenes');
  if (['species', 'form', 'birthOrder'].includes(key)) return parent === 'intrinsic' && ['human', 'humanoid', 'amorphous', 'polymorphic', 'not_applicable'].includes(value);
  if (key === 'phase') return parent === 'readerLoad';
  if (key === 'askedQuestionIds') return parent === 'designReview';
  if (key === 'choiceOwner') return parent === 'scenePressure';
  if (key === 'confidenceTarget') return parent === 'readerExpectation';
  if (key === 'verdict') return ['quality', 'targetedReview'].includes(parent);
  if (['surfaceEase', 'conceptPacing', 'inferenceLoad', 'complexityRamp'].includes(key)) return parent === 'readabilityContract';
  return ENUMS.has(key);
}

// Entity attrs are a schema-owned open record. Preserve every key and value in
// the hash, while classifying string values (including nested ones) as prose.
function projectEntityAttributes(value) {
  if (typeof value === 'string') return { description: value };
  if (Array.isArray(value)) return value.map(projectEntityAttributes);
  if (value && typeof value === 'object') return { entries: Object.entries(value).map(([id, item]) => ({ id, value: projectEntityAttributes(item) })) };
  return value;
}

export function projectApprovalValue(value, path = []) {
  if (Array.isArray(value)) return value.map(item => projectApprovalValue(item, path));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (CONTROL.has(key) || item === undefined) continue;
    if (key === 'attrs' && path.length === 1 && path[0] === 'seededEntities') out[key] = projectEntityAttributes(item);
    else if (PROVENANCE.has(key)) out[key] = typeof item === 'string' ? item : JSON.stringify(item);
    else if (CONFIG.has(key)) out[key] = { id: JSON.stringify(item) };
    else if (machineLeaf(key, path, item) && (typeof item === 'string' || Array.isArray(item) && item.every(v => typeof v === 'string'))) out[key] = { id: item };
    else if (['rationale', 'serialization'].includes(key) && typeof item === 'string') out[key] = { description: item };
    else out[key] = projectApprovalValue(item, [...path, key]);
  }
  return out;
}

const checkerPlan = Object.freeze({ rows: [
  { invariantId: 'SCHEMA', invariant: 'required', applicability: 'run' },
  { invariantId: 'OUTPUT_LANGUAGE', invariant: 'required', applicability: 'run' },
] });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function approvalSchemaErrors(kind, value, stateKey = kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['value must be an object'];
  const required = kind === 'profile' ? ['genreLabel']
    : kind === 'writer' ? ['aestheticThesis', 'audition']
      : kind === 'arc' ? ['title', 'promise']
        : kind === 'episode' ? ['title', 'premise']
          : stateKey === 'story-identity' ? ['readerPromise', 'protagonistAppeal', 'emotionalDefect']
            : stateKey === 'pilot' ? ['beforeState', 'firstFailure', 'protagonistSpecificAction', 'irreversibleChoice', 'competenceProof', 'humanHook', 'seriesPromise', 'closingQuestion']
              : kind === 'story' ? ['dramaticQuestion', 'protagonistWant', 'protagonistNeed', 'falseBelief', 'incitingDisruption', 'initialStrategy', 'midpointReframe', 'finalChoice', 'endingChange', 'endingCost'] : [];
  const errors = required.filter(key => !nonempty(value[key])).map(key => `missing ${key}`);
  if (kind === 'foundation') {
    if (!Array.isArray(value.worldFacts) || value.worldFacts.some(f => !nonempty(f.statement))) errors.push('invalid worldFacts');
    if (!Array.isArray(value.characters) || value.characters.some(c => !nonempty(c.id) || !nonempty(c.canonicalName))) errors.push('invalid characters');
  }
  if (kind === 'profile' && (!value.format?.length?.unit || !(value.format.length.target > 0))) errors.push('invalid profile length');
  if (kind === 'arc' && (!Array.isArray(value.episodes) || value.episodes.length < 3 || value.episodes.some(e => !nonempty(e.title) || !nonempty(e.beat)))) errors.push('invalid arc episodes');
  if (kind === 'episode' && (!Array.isArray(value.scenes) || !value.scenes.length)) errors.push('missing scenes');
  if (stateKey === 'story-identity') for (const key of ['competenceSignature', 'comedyEngines', 'solutionPatternsToRotate']) if (!Array.isArray(value[key]) || !value[key].some(nonempty)) errors.push(`missing ${key}`);
  return errors;
}

export async function approvalSourceHead(store) {
  const published = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
  if (!published.ok) throw new Error(`CORRUPT_PUBLICATION: ${published.error.code}`);
  return published.value?.head ?? null;
}

export function approvalLanguageMessages({ artifact, workContract, epoch, attempt }) {
  const instruction = workContract.promptFamily === 'ko'
    ? '승인할 작품 산출물 전체의 생성된 자연어가 한국어인지 검토한다. 변경하거나 번역하지 말고 모든 제목·예시·설명·계획·설정 값을 읽는다. 기계 ID/enum 및 사용자 원문 출처는 언어 위반이 아니다. 고유명과 승인된 인용 예외만 허용하며, 정보가 불충분하면 uncertain이다.'
    : `Review ALL generated natural-language values in this approval artifact for the target language ${workContract.language}. Do not rewrite or translate. Include titles, examples, questions, explanations, plans and world/character text. Machine IDs/enums and actual user source fields are exempt. Only proper names and scoped approved quotation exceptions may use another language. Return uncertain if evidence is insufficient.`;
  return [
    { role: 'system', content: instruction + '\nReturn only JSON: {"languageCompliance":{"language":"exact target tag","artifactHash":"exact supplied hash","verdict":"pass|fail|uncertain","evidence":[{"fieldPath":"value.exact.path","quote":"exact substring","reason":"linguistic evidence"}],"allowedExceptions":[]}}. A fail requires evidence. Read nested generated text even under metadata. Do not infer pass from script counts.' },
    { role: 'user', content: JSON.stringify({ language: workContract.language, artifactHash: computeArtifactHash(artifact), epoch, attempt, allowedLanguageExceptions: workContract.allowedLanguageExceptions ?? [], artifact }) },
  ];
}

function resultFailure(state, code = 'VALIDATION_INCOMPLETE', details = null) {
  return { ok: false, status: 'clean_fail', cleanFail: true, code, details, validation: state };
}

/** A gate never writes canonical records. Callers save only after ok=true. */
export async function gateApprovalActivation({ store, workId, kind, value, providers, revision = value?.revision ?? 1,
  resolution = null, stateKey = kind, structuralErrors = [], consumeOnly = false, retryValidation = false }) {
  const workLanguage = resolution ?? await resolveWorkLanguage({ store, workId });
  const newContract = !workLanguage.implicitLegacy || Object.hasOwn(value ?? {}, 'language');
  if (!newContract) return { ok: true, skipped: true };
  if (typeof store.loadApprovalValidation !== 'function' || typeof store.saveApprovalValidation !== 'function') return resultFailure(null, 'VALIDATION_INCOMPLETE', { reason: 'approval_state_store_missing' });
  const approvalValue = kind === 'foundation' && Object.hasOwn(value, 'brief')
    ? { ...value, brief: { sourceBrief: value.brief } } : value;
  const artifact = canonicalApprovalArtifact({ kind, revision, value: projectApprovalValue(approvalValue) });
  const artifactHash = computeArtifactHash(artifact);
  const workContract = workLanguage.contract;
  const contractHash = computeLanguageContractHash(workContract);
  const sourceHead = await approvalSourceHead(store);
  const sourceProfile = await store.loadStoryProfile?.(workId);
  const priorProfileHash = hash(sourceProfile ?? null);
  const sourceFoundationHash = hash(await store.loadFoundation(workId));
  const planSourceHash = hash({ sourceHead, contractHash, sourceFoundationHash, sourceProfileRevision: kind === 'profile' ? revision : sourceProfile?.revision ?? null, artifactHash });
  const binding = hash({ artifactHash, contractHash, sourceHead, planSourceHash });
  let state = await store.loadApprovalValidation(workId, stateKey);
  const requestId = providers?.validationContext?.runId ?? null;
  const freshRequest = requestId && state?.requestId && requestId !== state.requestId;
  const freshGeneration = freshRequest && !consumeOnly;
  const retryToken = requestId ?? 'direct';
  const explicitRetry = retryValidation && state?.lastRetryToken !== retryToken;
  if (state?.status === 'stale' && !explicitRetry && !freshGeneration) return resultFailure(state, 'STALE_VALIDATION_RECEIPT');
  if (state?.binding !== binding && state?.status === 'pending' && !freshRequest && !explicitRetry) {
    state = { ...state, status: 'stale', failureCode: 'STALE_VALIDATION_RECEIPT' };
    await store.saveApprovalValidation(workId, stateKey, state);
    return resultFailure(state, state.failureCode);
  }
  if (state && state.binding !== binding && consumeOnly) {
    state = { ...state, status: 'stale', receipt: state.receipt ? { ...state.receipt, stale: true } : null };
    await store.saveApprovalValidation(workId, stateKey, state);
    return resultFailure(state, 'STALE_VALIDATION_RECEIPT');
  }
  if (state?.status === 'clean_fail' && !explicitRetry && !freshGeneration) return resultFailure(state, state.failureCode);
  if (!state || state.binding !== binding || explicitRetry || freshGeneration && ['clean_fail', 'stale'].includes(state.status)) {
    state = { schemaVersion: 1, kind, revision, binding, artifactHash, contractHash, sourceHead, planSourceHash,
      requestId, lastRetryToken: explicitRetry ? retryToken : state?.lastRetryToken ?? null,
      epoch: (state?.epoch ?? 0) + 1, attempt: 0, status: 'pending', artifact, fingerprints: [] };
    await store.saveApprovalValidation(workId, stateKey, state);
  }
  const identity = { workId, chapter: kind === 'episode' ? value.chapter : null, runId: `approval-${stateKey}`, workflowId: null,
    validationEpoch: state.epoch, sourceHead, planSourceHash, artifactKind: 'approval', checkerPlan, languageFields: APPROVAL_LANGUAGE_FIELDS };
  const errors = [...approvalSchemaErrors(kind, value, stateKey), ...structuralErrors];
  // Only exact engine-owned configuration is exempt. Unknown prose smuggled
  // into one of these slots is a schema error, never an ID exemption.
  const configHash = object => computeArtifactHash(canonicalApprovalArtifact({ kind: 'foundation', revision: 1, value: object }));
  function checkConfig(object) {
    if (!object || typeof object !== 'object') return;
    for (const [key, item] of Object.entries(object)) {
      if (key === 'genreProfile') {
        if (!genreRegistry.has(value.genre) || configHash(item) !== configHash(genreRegistry.get(value.genre))) errors.push('unrecognized genreProfile configuration');
      } else if (key === 'workContract') {
        if (configHash(item) !== configHash(workContract)) errors.push('workContract configuration mismatch');
      } else checkConfig(item);
    }
  }
  checkConfig(value);
  if (errors.length) {
    state = { ...state, status: 'clean_fail', failureCode: 'APPROVAL_SCHEMA_INVALID', errors };
    await store.saveApprovalValidation(workId, stateKey, state);
    return resultFailure(state, state.failureCode, errors);
  }
  if (state.status === 'passed') {
    try {
      validateValidationReceipt({ receipt: state.receipt, expected: identity, artifact, workContract, languageCompliance: state.languageCompliance, coverage: state.coverage, languageFields: APPROVAL_LANGUAGE_FIELDS });
      return { ok: true, artifactHash, receipt: state.receipt, validation: state };
    } catch (error) {
      state = { ...state, status: 'stale', failureCode: error.code ?? 'VALIDATION_INCOMPLETE' };
      await store.saveApprovalValidation(workId, stateKey, state);
      return resultFailure(state, state.failureCode);
    }
  }
  if (consumeOnly) return resultFailure(state, 'MISSING_VALIDATION_RECEIPT');
  if (!providers?.complete) return resultFailure(state, 'VALIDATION_INCOMPLETE', { reason: 'provider_missing' });
  while (state.attempt < MAX_ATTEMPTS) {
    const attempt = state.attempt + 1;
    const messages = approvalLanguageMessages({ artifact, workContract, epoch: state.epoch, attempt });
    let response;
    try { response = await providers.complete({ model: MODEL, step: 'approval-language-contract', jsonMode: true, messages }); }
    catch (error) {
      if (error.name === 'PendingModelWork' || (providers.pending?.length ?? 0) > 0) return { ok: false, preview: true, status: 'needs_model', validation: state };
      // A failed transport is incomplete, not a returned invalid model answer.
      return resultFailure(state, 'VALIDATION_INCOMPLETE', { reason: 'provider_error', message: error.message });
    }
    if ((providers.pending?.length ?? 0) > 0) return { ok: false, preview: true, status: 'needs_model', validation: state };
    const fingerprint = hash({ messages, response: response?.text });
    try {
      const parsed = JSON.parse(String(response?.text).trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
      const compliance = parsed.languageCompliance ?? parsed;
      const languageCompliance = evaluateLanguageCompliance({ artifact, workContract, compliance, languageFields: APPROVAL_LANGUAGE_FIELDS });
      const coverage = { SCHEMA: 'validated', OUTPUT_LANGUAGE: languageCompliance.verdict === 'pass' ? 'validated' : 'failed' };
      const receipt = buildValidationReceipt({ ...identity, artifact, workContract, languageCompliance, coverage, languageFields: APPROVAL_LANGUAGE_FIELDS, issuedBy: 'approval-language-gate' });
      // Fresh authority is checked again after the asynchronous model round trip.
      if (await approvalSourceHead(store) !== sourceHead) throw Object.assign(new Error('source changed'), { code: 'STALE_VALIDATION_RECEIPT' });
      const latestProfile = await store.loadStoryProfile?.(workId);
      if (hash(latestProfile ?? null) !== priorProfileHash) throw Object.assign(new Error('profile changed'), { code: 'STALE_VALIDATION_RECEIPT' });
      if (hash(await store.loadFoundation(workId)) !== sourceFoundationHash) throw Object.assign(new Error('foundation changed'), { code: 'STALE_VALIDATION_RECEIPT' });
      state = { ...state, status: 'passed', receipt, languageCompliance, coverage };
      await store.saveApprovalValidation(workId, stateKey, state);
      validateValidationReceipt({ receipt, expected: identity, artifact, workContract, languageCompliance, coverage, languageFields: APPROVAL_LANGUAGE_FIELDS });
      return { ok: true, artifactHash, receipt, validation: state };
    } catch (error) {
      if (error.code === 'STALE_VALIDATION_RECEIPT') {
        state = { ...state, status: 'stale', failureCode: error.code };
        await store.saveApprovalValidation(workId, stateKey, state);
        return resultFailure(state, error.code);
      }
      state = { ...state, attempt, fingerprints: [...state.fingerprints, fingerprint], failureCode: error.code ?? 'VALIDATION_INCOMPLETE', failureMessage: error.message, failureDetails: error.details ?? null,
        status: attempt >= MAX_ATTEMPTS ? 'clean_fail' : 'pending' };
      await store.saveApprovalValidation(workId, stateKey, state);
    }
  }
  return resultFailure(state, state.failureCode);
}

export function requireApprovalResult(result) {
  if (result.ok) return true;
  if (result.preview) return false;
  throw Object.assign(new Error(result.code ?? 'VALIDATION_INCOMPLETE'), { code: result.code, validation: result.validation });
}
