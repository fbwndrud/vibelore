import { createHash } from 'node:crypto';
import { extractDelta, continuityCheck, computeExtractionContextHash } from '../../engine/src/continuity/continuity-check.js';
import { runChapterSummary } from '../../engine/src/generators/text/steps/chapter-summary.js';
import { emptyStoryState } from '../../engine/src/continuity/story-state.js';
import { evaluateChapterQuality } from '../../engine/src/continuity/quality-gate.js';
import { resolveWorkLanguage, usesChapterValidationGate } from '../core/work-language.js';
import { currentValidationContext, exactHash, sameIdentity, exceptionOnlyRebind, loadValidationSession, saveValidationSession, invalidateValidationSession } from '../core/validation-context.js';
import { chapterArtifactBundle, computeArtifactHash, continuityContextHash, evaluateChapterCoverage, evaluateChapterLanguage, issueChapterReceipt, lengthCoverage, liveCheckerPlan, overlayInvariantCoverage, publishedChapterProse, readSemanticValidation, requestLanguageCompliance, runPlannedDetectors, schemaCoverage } from '../core/validation-gate.js';
import { lexiconsForLanguage } from './lexicons.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const pending = (providers) => Boolean(providers?.pending?.length);
export async function shouldUseContractCheck({ store, workId, chapter, forceContract = false }) {
  const resolution = await resolveWorkLanguage({ store, workId });
  const workflow = await store.loadWorkflow(workId);
  return { gated: forceContract || usesChapterValidationGate({ resolution, workflow, chapter }), resolution, workflow };
}

export async function runContractCheck({ store, workId, chapter, prose, title, summary, castManifestRaw = '', providers,
  includeSemanticContinuity = true, requireInfluenceObservation = false, issueReceipt = true,
  workflowId = null, retryValidation = false, allowWorkingTreeDrift = false, validationScope }) {
  const scope = validationScope ?? (workflowId ? `workflow-${workflowId}` : `manual-${chapter}`);
  let state = await loadValidationSession(store, workId, scope);
  const invocation = providers?.validationContext?.runId ?? null;
  let context;
  try { context = await currentValidationContext({ store, workId, chapter, allowWorkingTreeDrift }); }
  catch (error) {
    if (state) await invalidateValidationSession(store, workId, scope, state, error.code ?? 'STALE_WORK_CONTRACT');
    throw error;
  }
  const input = { prose: publishedChapterProse(prose), title, summary, castManifestRaw };
  const inputHash = exactHash(input);
  if (!workflowId && state?.status === 'consumed') {
    state = { epoch: state.epoch + 1, failures: 0, invocation, identity: context.identity, plans: context.plans, workContract: context.workContract, inputHash, input };
  }
  const retryRequested = retryValidation && (!invocation || state?.retryInvocation !== invocation);
  const freshManualInvocation = !workflowId && invocation && state?.invocation !== invocation && state?.status === 'clean_fail';
  if (retryRequested || freshManualInvocation) {
    if (state && !sameIdentity(state.identity, context.identity) && !exceptionOnlyRebind(state, context)) {
      await invalidateValidationSession(store, workId, scope, state);
      throw Object.assign(new Error('STALE_WORK_CONTRACT'), { code: 'STALE_WORK_CONTRACT' });
    }
    state = { epoch: (state?.epoch ?? 0) + 1, failures: 0, retryInvocation: invocation, invocation,
      identity: context.identity, plans: context.plans, workContract: context.workContract, inputHash, input,
      prepared: state?.inputHash === inputHash ? state.prepared : null };
  }
  if (state && !sameIdentity(state.identity, context.identity)) {
    state = await invalidateValidationSession(store, workId, scope, state);
  }
  if (state?.stale || state?.status === 'clean_fail') return { ...state.result, status: 'clean_fail', code: state.code ?? 'VALIDATION_INCOMPLETE', validationAttempts: state.failures, validationEpoch: state.epoch };
  if (!state) state = { epoch: 1, failures: 0, invocation, identity: context.identity, plans: context.plans, workContract: context.workContract, inputHash, input };
  if (state.inputHash !== inputHash) {
    if (state.checkId) {
      const old = await store.loadCheckReceipt(workId, state.checkId);
      if (old) await store.saveCheckReceipt(workId, { ...old, stale: true, staleReason: 'artifact_changed' });
    }
    // A new artifact after a passed check (a user-requested revision) opens a
    // new epoch with a full budget. Only artifacts revised inside a failing
    // epoch keep sharing its three attempts (2026-09-15 zh-Hant sample: one
    // legitimate fail on the revision became clean_fail because the two
    // failures of the already-passed draft were still counted).
    const passedBefore = state.status === 'passed';
    state = { ...state, input, inputHash, prepared: null, extracted: null, semantic: null, result: null, checkId: null, status: null,
      ...(passedBefore ? { epoch: state.epoch + 1, failures: 0 } : {}) };
  }
  const save = () => saveValidationSession(store, workId, scope, state);
  await save();
  if (state.status === 'passed' && state.result) return state.result;
  const { workContract, foundation, canonicalStore } = context;
  const plan = liveCheckerPlan({ workContract, foundation, profile: context.plans.profile });
  const scan = runPlannedDetectors({ plan, prose: input.prose, chapter, foundation, workContract, entities: await canonicalStore.loadEntitySnapshots(workId) });
  const length = lengthCoverage({ workContract, prose: input.prose });
  const prosody = scan.detectorResults.find(row => row.checkerId === 'runProsodyScan' && ['passed','failed'].includes(row.status));
  const base = {
    verdict: 'blocked', counts: { hard: 0, soft: 0, total: 0 }, violations: [...scan.violations],
    detectorResults: scan.detectorResults, workContract, contractHash: context.identity.contractHash,
    lengthAssessment: length.measurement, prosody: { score: prosody?.score ?? null, breakdown: prosody?.breakdown ?? null },
    qualityGate: evaluateChapterQuality({ prosodyScore: prosody?.score ?? null, coherenceScore: null }),
    validationEpoch: state.epoch, validationScope: scope,
  };
  if (length.coverage === 'failed') base.violations.push({ severity: 'hard', code: 'QUALITY_GATE_LENGTH', chapterNumber: chapter, lengthMeasurement: length.measurement, message: `Length ${length.measurement.actual} ${length.measurement.unit}; minimum ${length.measurement.min}.` });
  const refreshCounts = () => { base.counts = { hard: base.violations.filter(v => v.severity === 'hard').length, soft: base.violations.filter(v => v.severity === 'soft').length, total: base.violations.length }; };
  const preview = async () => { refreshCounts(); await save(); return { ...base, preview: true }; };
  const fail = async (code, detail = {}) => {
    state.failures += 1;
    state.status = state.failures >= 3 ? 'clean_fail' : 'validation_incomplete';
    state.code = code;
    refreshCounts();
    state.result = { ...base, ...detail, status: state.status, code, validationIncomplete: true, validationAttempts: state.failures };
    await save(); return state.result;
  };
  // A failed transport (session limit, timeout, crashed CLI) is not a judged
  // answer. It used to be counted like one: three provider errors in a row
  // burned the whole budget in seconds and turned a resumable draft into
  // clean_fail (2026-09-15 fr sample, revision after approval). The caller
  // gets a distinct, retryable status and the budget stays where it was.
  let providerFailure = null;
  const providerError = async () => {
    refreshCounts();
    state.result = null; await save();
    return { ...base, status: 'provider_error', code: 'MODEL_PROVIDER_ERROR', validationIncomplete: true, retryable: true,
      providerError: providerFailure?.message ?? String(providerFailure), validationAttempts: state.failures };
  };
  const wrapped = {
    validationContext: providers?.validationContext,
    provenance: providers?.provenance,
    get pending() { return providers?.pending ?? []; },
    async complete(request) {
      if (!providers?.complete) throw new Error('MODEL_PROVIDER_REQUIRED');
      try {
        return await providers.complete({ ...request, messages: [...request.messages,
        { role: 'system', content: `Validation identity: ${scope}; epoch ${state.epoch}; attempt ${state.failures + 1}. This identifies this evaluation, not fictional content.${state.languageEvidence ? ` Previous output-language evidence; correct only the affected generated fields: ${JSON.stringify(state.languageEvidence)}` : ''}` }] });
      } catch (error) {
        if (error?.name !== 'PendingModelWork') providerFailure = error;
        throw error;
      }
    },
  };
  const prevState = await canonicalStore.loadStoryState(workId, chapter - 1) ?? emptyStoryState(workId);
  const extractionInput = { prose: input.prose, chapterNumber: chapter, foundation, providers: wrapped, model: MODEL, prevState,
    castManifestRaw: input.castManifestRaw, requireInfluenceObservation, workContract, language: workContract.language };
  try {
    if (!state.extracted) {
      const extracted = await extractDelta(extractionInput);
      if (pending(wrapped)) return preview();
      if (providerFailure) return providerError();
      if (extracted.extractionValidation?.status !== 'completed' || extracted.extractionValidation.contextHash !== computeExtractionContextHash(extractionInput))
        return fail('VALIDATION_INCOMPLETE', { extractionValidation: extracted.extractionValidation });
      if (context.plans.episode?.characterArcBeats?.length) {
        extracted.delta = { ...extracted.delta, arcCursorOps: context.plans.episode.characterArcBeats.map(({ characterId, beat, note }) => ({ characterId, nextBeat: beat, ...(note !== undefined ? { note } : {}) })) };
      }
      state.extracted = extracted; await save();
    }
    base.delta = state.extracted.delta;
    base.extractionValidation = state.extracted.extractionValidation;
    base.unregisteredNamed = state.extracted.unregisteredNamed ?? [];
    if (!includeSemanticContinuity) return fail('VALIDATION_INCOMPLETE');
    const semanticInput = { ...extractionInput, delta: state.extracted.delta, checkerPlan: plan, lexicon: lexiconsForLanguage(workContract.language).honorific };
    if (!state.semantic) {
      const semantic = await continuityCheck(semanticInput);
      if (pending(wrapped)) return preview();
      const validation = readSemanticValidation(semantic, null, { expectedContextHash: continuityContextHash(semanticInput) });
      base.semanticValidation = validation;
      if (providerFailure) return providerError();
      if (validation.status !== 'completed' || Object.values(validation.verdicts).some(v => v === 'uncertain')) return fail('VALIDATION_INCOMPLETE');
      state.semantic = semantic; await save();
    }
    base.semanticValidation = state.semantic.semanticValidation;
    base.violations.push(...(state.semantic.violations ?? []));
    if (!state.prepared) {
      let preparedTitle = input.title ?? context.plans.episode?.title;
      if (!preparedTitle) {
        const response = await wrapped.complete({ model: MODEL, step: 'chapter-title', jsonMode: true,
          messages: [{ role: 'system', content: workContract.promptFamily === 'ko' ? '본문의 짧은 제목을 작품 언어로 만든다. JSON {"title":"..."}만 출력한다.' : 'Give this chapter a short title in the target work language. Return JSON {"title":"..."}.' }, { role: 'user', content: `Language: ${workContract.language}\n${input.prose}` }] });
        if (pending(wrapped)) return preview();
        preparedTitle = JSON.parse(response.text).title;
      }
      let preparedSummary = input.summary;
      if (preparedSummary === undefined || preparedSummary === null) {
        const generated = await runChapterSummary({ prose: input.prose, chapterNumber: chapter, writerModel: MODEL, summaryModel: MODEL, providers: wrapped, workContract, language: workContract.language, foundation });
        if (pending(wrapped)) return preview();
        preparedSummary = { text: generated.summary, plotBeat: generated.plotBeat, sceneTags: generated.sceneTags, povCharacter: generated.povCharacter };
        preparedSummary = Object.fromEntries(Object.entries(preparedSummary).filter(([,v]) => v !== undefined));
      }
      state.prepared = { title: preparedTitle, summary: preparedSummary }; await save();
    }
    if (state.metadataRepair?.length) {
      const fields = state.metadataRepair;
      const response = await wrapped.complete({ model: MODEL, step: 'chapter-language-repair', jsonMode: true,
        messages: [{ role: 'system', content: workContract.promptFamily === 'ko'
          ? '지적된 제목/요약 필드만 작품 언어로 최소 수정한다. 사건, 사실, 이름, 기계 ID와 구조를 유지한다. 요청된 필드의 JSON 객체만 출력한다.'
          : 'Repair only the indicated title/summary fields into the target language. Preserve events, facts, names, machine IDs and structure. Return only a JSON object of the requested fields.' },
          { role: 'user', content: JSON.stringify({ language: workContract.language, fields, evidence: state.languageEvidence, prose: input.prose, current: state.prepared }) }] });
      if (pending(wrapped)) return preview();
      const repaired = JSON.parse(response.text);
      if (!repaired || typeof repaired !== 'object' || fields.some(field => repaired[field] == null)) return fail('VALIDATION_INCOMPLETE');
      state.prepared = { ...state.prepared, ...Object.fromEntries(fields.map(field => [field, repaired[field]])) };
      state.metadataRepair = null; await save();
    }
    const artifact = chapterArtifactBundle({ ...input, ...state.prepared, semanticDelta: state.extracted.delta });
    base.artifact = artifact; base.artifactHash = computeArtifactHash(artifact);
    const answer = await requestLanguageCompliance({ providers: wrapped, workContract, artifact, epoch: state.epoch, attempt: state.failures + 1 });
    if (pending(wrapped)) return preview();
    if (answer.status !== 'ok') return fail('VALIDATION_INCOMPLETE', { languageCompliance: answer.compliance });
    const languageCompliance = evaluateChapterLanguage({ compliance: answer.compliance, artifact, workContract });
    base.languageCompliance = languageCompliance;
    const schema = schemaCoverage({ prose: input.prose, foundation, artifact, extractionValidation: state.extracted.extractionValidation, extractionContextHash: computeExtractionContextHash(extractionInput) });
    const overlaid = overlayInvariantCoverage({ plan, detectorResults: scan.detectorResults, semanticValidation: base.semanticValidation, languageCompliance, schema, length: length.coverage, formatRan: true });
    const coverage = evaluateChapterCoverage({ plan, coverage: { invariants: overlaid.invariants } });
    base.coverage = coverage;
    if (!languageCompliance.satisfied || !coverage.complete) {
      if (languageCompliance.verdict === 'fail') {
        state.languageEvidence = answer.compliance.evidence;
        if (answer.compliance.evidence.some(e => String(e.fieldPath).split(/[.\[]/)[0] === 'prose'))
          base.violations.push({ severity: 'hard', code: 'OUTPUT_LANGUAGE_MISMATCH', chapterNumber: chapter,
            targetLanguage: workContract.language, evidence: answer.compliance.evidence.filter(e => String(e.fieldPath).split(/[.\[]/)[0] === 'prose'),
            message: `Repair the evidenced foreign-language prose into ${workContract.language}. Preserve facts, events, names, machine IDs, manifest and unaffected passages.` });
        if (answer.compliance.evidence.some(e => String(e.fieldPath).split(/[.\[]/)[0] === 'semanticDelta')) {
          state.extracted = null; state.semantic = null;
        }
        state.metadataRepair = [...new Set(answer.compliance.evidence.map(e => String(e.fieldPath).split(/[.\[]/)[0]).filter(field => ['title', 'summary'].includes(field)))];
      }
      // A failed semantic judgment must be requested again in the next attempt.
      if (Object.values(base.semanticValidation?.verdicts ?? {}).some(v => v === 'fail')) state.semantic = null;
      return fail(languageCompliance.verdict === 'fail' ? 'OUTPUT_LANGUAGE_MISMATCH' : 'VALIDATION_INCOMPLETE');
    }
    refreshCounts();
    if (base.counts.hard) return fail('VALIDATION_INCOMPLETE');
    base.verdict = base.violations.length ? 'soft-only' : 'clean';
    if (!issueReceipt) return { ...base, validationComplete: true };
    const latest = await currentValidationContext({ store, workId, chapter, allowWorkingTreeDrift });
    if (!sameIdentity(context.identity, latest.identity)) {
      await invalidateValidationSession(store, workId, scope, state);
      return { ...base, status: 'clean_fail', code: 'STALE_WORK_CONTRACT', validationIncomplete: true };
    }
    const receipt = issueChapterReceipt({ workId, chapter, workflowId, runId: workflowId ? undefined : scope,
      validationEpoch: state.epoch, sourceHead: context.identity.sourceHead, planSourceHash: context.identity.planSourceHash,
      // The receipt carries the evaluated record: a pass keeps only its valid
      // citations, and the strict re-reading at receipt time must see exactly
      // that record, not the raw answer (2026-09-15 es sample: three passes,
      // each thrown out again by a decorative citation on an array path).
      workContract, artifact, checkerPlan: plan, languageCompliance, coverage: { invariants: overlaid.invariants }, issuedBy: 'check' });
    const envelope = { ...receipt, validationReceipt: receipt, artifact, workContract, languageCompliance, coverage,
      checkerPlan: plan, validationScope: scope, identity: context.identity,
      proseHash: `sha256:${createHash('sha256').update(artifact.prose).digest('hex')}`, delta: artifact.semanticDelta,
      checkedAt: new Date().toISOString(), consumedAt: null };
    await store.saveCheckReceipt(workId, envelope);
    state.checkId = receipt.checkId; state.status = 'passed';
    state.result = { ...base, checkId: receipt.checkId, validationReceipt: receipt, validationComplete: true };
    await save(); return state.result;
  } catch (error) {
    if (pending(wrapped)) return preview();
    if (providerFailure) return providerError();
    if (['WORKING_TREE_DRIFT','STALE_WORK_CONTRACT'].includes(error.code)) {
      await invalidateValidationSession(store, workId, scope, state, error.code);
      return { ...base, status: 'clean_fail', code: error.code, validationIncomplete: true };
    }
    return fail(error.code ?? 'VALIDATION_INCOMPLETE', { validationError: error.message, validationDetails: error.details });
  }
}
