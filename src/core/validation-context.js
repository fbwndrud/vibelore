import { validatePublicationManifest } from '../../engine/src/core/validation-contract.js';
import { createHash } from 'node:crypto';
import { createPublicationUnit } from './publication-unit.js';
import { openCanonRepository } from './canon-repository.js';
import { detectWorkingTreeDrift, fingerprintWorkingTree } from './working-tree-sync.js';
import { resolveWorkLanguage, executionFoundationSnapshot, isExceptionOnlyProfileRevision } from './work-language.js';

export function exactHash(value) {
  const stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export async function currentValidationContext({ store, workId, chapter, allowWorkingTreeDrift = false }) {
  const publicationUnit = createPublicationUnit({ rootDir: store.rootDir });
  const canonicalStore = await openCanonRepository({ store, publicationUnit });
  const sourceHead = canonicalStore.publishedRevision?.head ?? null;
  // Parse the human source even when Published HEAD supplies execution data: deleted
  // metadata or invalid owned headings must not disappear behind a valid snapshot.
  const workingFoundation = await store.loadFoundation(workId);
  const canonicalFoundation = await canonicalStore.loadFoundation(workId);
  const profile = await store.loadStoryProfile(workId);
  if (profile && profile.status !== 'active') throw Object.assign(new Error('PROFILE_NOT_ACTIVE'), { code: 'PROFILE_NOT_ACTIVE' });
  const resolution = await resolveWorkLanguage({ store, workId, foundation: canonicalFoundation, profile });
  if (sourceHead && !allowWorkingTreeDrift) {
    const drift = await detectWorkingTreeDrift({ store, sourceHead });
    if (drift.status !== 'clean') throw Object.assign(new Error('WORKING_TREE_DRIFT'), { code: 'WORKING_TREE_DRIFT', drift });
  }
  if (sourceHead && (workingFoundation?.language !== canonicalFoundation?.language
      || workingFoundation?.canonicalFormatVersion !== canonicalFoundation?.canonicalFormatVersion)) {
    throw Object.assign(new Error('STALE_WORK_CONTRACT'), { code: 'STALE_WORK_CONTRACT' });
  }
  const plans = {
    profile, arc: await store.loadArcPlan(workId), episode: await store.loadEpisodePlan(workId, chapter),
    spine: await store.loadStorySpine(workId), writer: await store.loadWriterSkill(workId),
    identity: await store.loadStoryIdentity(workId), pilot: await store.loadPilotContract(workId),
    style: await store.loadStyleAnchor?.(workId) ?? null,
  };
  const fingerprint = await fingerprintWorkingTree(store.rootDir);
  return {
    canonicalStore, resolution, workContract: resolution.contract,
    foundation: executionFoundationSnapshot(canonicalFoundation, resolution.contract), plans,
    identity: { workId, chapter, sourceHead, planSourceHash: exactHash(plans), contractHash: resolution.contractHash, workingTreeDigest: fingerprint.digest },
  };
}

export const sameIdentity = (a, b) => exactHash(a) === exactHash(b);
export function exceptionOnlyRebind(previous, next) {
  if (!previous?.plans || !isExceptionOnlyProfileRevision({ previous: previous.plans.profile, next: next.plans.profile })) return false;
  if (previous.identity.sourceHead !== next.identity.sourceHead || previous.identity.workingTreeDigest !== next.identity.workingTreeDigest) return false;
  const beforePlans = { ...previous.plans, profile: null };
  const afterPlans = { ...next.plans, profile: null };
  const strip = ({ allowedLanguageExceptions, ...contract }) => contract;
  return exactHash(beforePlans) === exactHash(afterPlans)
    && exactHash(strip(previous.workContract)) === exactHash(strip(next.workContract));
}

export async function loadValidationSession(store, workId, scope) {
  const document = await store.loadValidationState(workId) ?? { sessions: {} };
  return document.sessions?.[scope] ?? null;
}
export async function saveValidationSession(store, workId, scope, state) {
  const document = await store.loadValidationState(workId) ?? { sessions: {} };
  document.sessions = { ...document.sessions, [scope]: state };
  await store.saveValidationState(workId, document);
}
export async function invalidateValidationSession(store, workId, scope, state, code = 'STALE_WORK_CONTRACT') {
  const invalidated = { ...state, epoch: (state?.epoch ?? 0) + 1, stale: true, status: 'clean_fail', code };
  await saveValidationSession(store, workId, scope, invalidated);
  if (state?.checkId) {
    const receipt = await store.loadCheckReceipt(workId, state.checkId);
    if (receipt) await store.saveCheckReceipt(workId, { ...receipt, stale: true, staleReason: code });
  }
  return invalidated;
}

export async function assertCurrentChapterReceipt({ store, workId, chapter, receipt, artifact, allowWorkingTreeDrift = false, validationScope }) {
  const { consumeChapterReceipt, liveCheckerPlan } = await import('./validation-gate.js');
  const scope = validationScope ?? receipt?.validationScope;
  if (!scope) throw Object.assign(new Error('MISSING_VALIDATION_RECEIPT'), { code: 'MISSING_VALIDATION_RECEIPT' });
  const state = await loadValidationSession(store, workId, scope);
  let context;
  try {
    context = await currentValidationContext({ store, workId, chapter, allowWorkingTreeDrift });
    if (!receipt?.validationReceipt || receipt.validationReceipt.checkId !== receipt.checkId) throw new Error('MISSING_VALIDATION_RECEIPT');
    if (!state || state.stale || state.status !== 'passed' || state.checkId !== receipt?.checkId
        || state.epoch !== receipt.validationEpoch || !sameIdentity(state.identity, context.identity))
      throw Object.assign(new Error('STALE_WORK_CONTRACT'), { code: 'STALE_WORK_CONTRACT' });
    if (!validatePublicationManifest(artifact?.castManifestRaw, { foundation: context.foundation }).valid) throw Object.assign(new Error('INVALID_CAST_MANIFEST'), { code: 'INVALID_CAST_MANIFEST' });
    consumeChapterReceipt({ receipt: receipt.validationReceipt, artifact, workContract: context.workContract,
      languageCompliance: receipt.languageCompliance, coverage: receipt.coverage,
      expected: { workId, chapter, workflowId: receipt.workflowId, runId: receipt.runId,
        validationEpoch: state.epoch, sourceHead: context.identity.sourceHead,
        planSourceHash: context.identity.planSourceHash, artifactKind: 'chapter',
        checkerPlan: liveCheckerPlan({ workContract: context.workContract, foundation: context.foundation, profile: context.plans.profile }) } });
    return context;
  } catch (error) {
    if (state) await invalidateValidationSession(store, workId, scope, state, error.code ?? 'STALE_WORK_CONTRACT');
    throw error;
  }
}
