/**
 * lore_commit -- fold a finished chapter into the work's canonical state.
 *
 * Committing is the only operation here that changes what the world *is*, so
 * it refuses to run on a chapter that still has hard violations. Letting a
 * contradiction through is how a long work quietly becomes incoherent around
 * chapter forty, and by then it is unaffordable to fix. `force` exists for the
 * writer who has looked at the finding and decided it is wrong -- their
 * judgement beats the engine's, but it should cost a deliberate keystroke.
 */
import { extractDelta } from '../../engine/src/continuity/continuity-check.js';
import { reduceStoryState, emptyStoryState } from '../../engine/src/continuity/story-state.js';
import { applyEntityOps } from './entities.js';
import { advanceArcAfterCommit } from './arc.js';
import { completeEpisodePlan, upgradeEpisodePlanningContract } from './episode-plan.js';
import { runChapterSummary } from '../../engine/src/generators/text/steps/chapter-summary.js';
import { createHash } from 'node:crypto';
import { assertProseIntegrity, trailingCastMetadata } from './prose-integrity.js';
import { DefaultOutputSanitizer } from '../../engine/src/core/output-sanitizer.js';
import { createChapterSnapshot } from './snapshots.js';
import { createPublicationUnit } from '../core/publication-unit.js';
import { foldLegacyChapterCharacterDynamics } from '../core/character-dynamics-adapter.js';
import { openCanonRepository } from '../core/canon-repository.js';
import { prepareNarrativeCommit } from '../../engine/src/core/planning-authority.js';
import { captureWorkingTreeFingerprint } from '../core/working-tree-sync.js';
import { detectWorkingTreeDrift } from '../core/working-tree-sync.js';
import { runtimeVersion } from '../core/runtime-version.js';
import { assertCurrentChapterReceipt, loadValidationSession, saveValidationSession } from '../core/validation-context.js';
import { resolveWorkLanguage, usesChapterValidationGate } from '../core/work-language.js';
import {
  VALIDATION_ERROR_CODES,
  ValidationContractError,
  chapterArtifactBundle,
  consumeChapterReceipt,
  markReceiptConsumed,
  publishedChapterProse,
} from '../core/validation-gate.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const sanitizer = new DefaultOutputSanitizer();

export async function runCommit({
  store, workId, chapter, prose, title, summary, castManifestRaw, providers, delta: presetDelta, checkId,
  commitFault = null, allowWorkingTreeDrift = false, validationScope,
}) {
  const manifest = sanitizer.extractBlock(prose, 'cast-manifest');
  const sanitized = sanitizer.sanitize(prose);
  if (sanitized.leaked) throw new Error('본문에 제거되지 않은 내부 sentinel이 남았습니다.');
  prose = sanitized.clean.trim();
  castManifestRaw ??= manifest?.body;
  assertProseIntegrity(prose);
  const publicationUnit = createPublicationUnit({
    rootDir: store.rootDir,
    ...(commitFault && commitFault !== 'afterPublicationBeforeMaterialization' ? { failAt: commitFault } : {}),
  });
  const canonicalStore = await openCanonRepository({ store, publicationUnit });
  const resolution = await resolveWorkLanguage({ store: canonicalStore, workId });
  const foundation = await canonicalStore.loadFoundation(workId);
  if (!foundation) throw new Error('이 디렉터리에 작품이 없습니다. 먼저 lore_init 을 실행하세요.');
  const workflow = await store.loadWorkflow(workId);
  const contractCommit = Boolean(validationScope) || usesChapterValidationGate({
    resolution, workflow, chapter,
  });
  if (contractCommit && !checkId) {
    throw new ValidationContractError(VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT, { reason: 'absent' });
  }
  const leakedId = foundation.characters.find((character) => character.id.includes('_')
    && new RegExp(`(^|[^A-Za-z0-9_])${character.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'm').test(prose));
  if (leakedId) throw new Error(`본문에 내부 캐릭터 ID "${leakedId.id}"가 남았습니다.`);
  if (trailingCastMetadata(prose, foundation.characters).length > 0) throw new Error('본문 말미에 내부 캐스트 이름 목록 또는 ID 매핑이 남았습니다.');

  // An active integrated workflow owns this chapter. Low-level callers may
  // still commit legacy/manual chapters, but cannot bypass a workflow's check.
  let checkReceipt = null;
  const workflowOwnsChapter = workflow && workflow.chapter === chapter && !['completed', 'rejected', 'clean_fail'].includes(workflow.stage);
  if (workflowOwnsChapter) {
    if (!checkId || checkId !== workflow.checkId) throw new Error('활성 집필 워크플로의 검사 영수증이 필요합니다. lore_write/lore_decide 흐름을 완료하세요.');
    const receipt = await store.loadCheckReceipt(workId, checkId);
    const hash = `sha256:${createHash('sha256').update(String(prose)).digest('hex')}`;
    if (!receipt || receipt.verdict !== 'passed' || receipt.consumedAt || receipt.consumed || receipt.chapter !== chapter || (receipt.proseHash && receipt.proseHash !== hash)) {
      throw new Error('검사 영수증이 유효하지 않거나 본문이 검사 이후 변경됐습니다.');
    }
    checkReceipt = receipt;
  } else if (checkId) {
    const receipt = await store.loadCheckReceipt(workId, checkId);
    const hash = `sha256:${createHash('sha256').update(String(prose)).digest('hex')}`;
    if (!receipt || receipt.verdict !== 'passed' || receipt.consumedAt || receipt.consumed || receipt.chapter !== chapter || (receipt.proseHash && receipt.proseHash !== hash)) {
      throw new Error('검사 영수증이 유효하지 않거나 본문이 검사 이후 변경됐습니다.');
    }
    checkReceipt = receipt;
  }

  let contractArtifact = null;
  let validatedContext = null;
  if (contractCommit) {
    if (!checkReceipt?.checkerPlan || !checkReceipt.workContract)
      throw new ValidationContractError(VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT, { reason: 'incomplete_envelope' });
    const published = publishedChapterProse(prose);
    contractArtifact = chapterArtifactBundle({
      prose: published,
      title: title !== undefined && title !== null ? title : checkReceipt.artifact.title,
      summary: summary !== undefined && summary !== null ? summary : checkReceipt.artifact.summary,
      semanticDelta: presetDelta !== undefined && presetDelta !== null ? presetDelta : checkReceipt.artifact?.semanticDelta,
      castManifestRaw: castManifestRaw !== undefined && castManifestRaw !== null
        ? castManifestRaw
        : checkReceipt.artifact?.castManifestRaw,
    });
    validatedContext = await assertCurrentChapterReceipt({ store, workId, chapter, receipt: checkReceipt,
      artifact: contractArtifact, allowWorkingTreeDrift, validationScope });
    prose = contractArtifact.prose;
    title = contractArtifact.title;
    summary = typeof contractArtifact.summary === 'string'
      ? contractArtifact.summary
      : contractArtifact.summary?.text;
    castManifestRaw = contractArtifact.castManifestRaw;
  }

  const prev = (await canonicalStore.loadStoryState(workId, chapter - 1)) ?? emptyStoryState(workId);
  const delta = contractCommit
    ? (contractArtifact.semanticDelta ?? checkReceipt.delta)
    : (presetDelta ?? checkReceipt?.delta ?? (await extractDelta({
      prose, chapterNumber: chapter, foundation, providers, model: MODEL, prevState: prev,
      castManifestRaw: castManifestRaw ?? '',
    })).delta);

  const next = reduceStoryState(prev, delta);

  let entities = await canonicalStore.loadEntitySnapshots(workId);
  if (delta.entityOps?.length) {
    try { entities = applyEntityOps(entities, delta.entityOps, chapter).snapshots; }
    catch (err) { /* entity ops are advisory; a malformed op must not lose the chapter */ }
  }

  const generatedSummary = contractCommit ? (typeof contractArtifact.summary === 'object' ? contractArtifact.summary : null) : summary ? null : await runChapterSummary({
    prose,
    chapterNumber: chapter,
    writerModel: MODEL,
    summaryModel: MODEL,
    providers,
  });
  const chapterSummary = summary ?? generatedSummary?.summary;

  const [storyProfile, storySpine, writerSkill, storyIdentity, pilotContract, arcPlan, loadedEpisodePlan] = await Promise.all([
    validatedContext ? validatedContext.plans.profile : canonicalStore.loadStoryProfile(workId),
    validatedContext ? validatedContext.plans.spine : canonicalStore.loadStorySpine(workId),
    validatedContext ? validatedContext.plans.writer : canonicalStore.loadWriterSkill(workId),
    validatedContext ? validatedContext.plans.identity : canonicalStore.loadStoryIdentity(workId),
    validatedContext ? validatedContext.plans.pilot : canonicalStore.loadPilotContract(workId),
    validatedContext ? validatedContext.plans.arc : canonicalStore.loadArcPlan(workId),
    validatedContext ? validatedContext.plans.episode : canonicalStore.loadEpisodePlan(workId, chapter),
  ]);
  const episodePlan = upgradeEpisodePlanningContract(loadedEpisodePlan, foundation);
  const publishedEpisodes = (arcPlan?.episodes ?? []).map((item) => item.chapter === chapter ? { ...item, status: 'completed' } : item);
  const publishedArcCompleted = publishedEpisodes.length > 0 && publishedEpisodes.every((item) => item.status === 'completed');
  const publishedArcPlan = arcPlan ? {
    ...arcPlan,
    episodes: publishedEpisodes,
    ...(publishedArcCompleted ? {
      status: 'completed',
      completedAt: arcPlan.completedAt ?? new Date().toISOString(),
    } : {}),
  } : null;
  const publishedEpisodePlan = episodePlan?.status === 'active'
    ? { ...episodePlan, status: 'completed' }
    : episodePlan;

  // Seal the complete candidate generation before materializing its
  // human-editable Markdown projections. Published readers can therefore only
  // observe the previous complete generation or this complete generation.
  const publishedBefore = canonicalStore.publishedRevision
    ? { ok: true, value: canonicalStore.publishedRevision }
    : await publicationUnit.readPublished();
  if (!publishedBefore.ok) throw new Error(`정사 publication을 읽을 수 없습니다: ${publishedBefore.error.code}`);
  const token = await publicationUnit.issueFencingToken();
  if (!token.ok) throw new Error(`정사 fencing token을 발급할 수 없습니다: ${token.error.code}`);
  const previousHead = publishedBefore.value?.head ?? null;
  const executionContext = {
    snapshotId: previousHead ?? 'genesis', expectedHead: previousHead,
    storyTimeScope: { worldline: 'main', through: chapter }, publicationOrder: chapter,
    transactionTime: new Date().toISOString(), policyRevision: 'vibelore-1',
    semanticGeneration: 'vibelore-1', fencingToken: token.value.fencingToken,
  };
  const proseHash = `sha256:${createHash('sha256').update(prose).digest('hex')}`;
  const influenceEvents = Array.isArray(delta.influenceEvents) ? delta.influenceEvents : [];
  const strictPlanningRequired = storySpine?.status === 'active' && (foundation.characters?.length ?? 0) >= 2;
  if (strictPlanningRequired && influenceEvents.length === 0 && !String(delta.noInfluenceReason ?? '').trim()) {
    throw new Error('INFLUENCE_OBSERVATION_REQUIRED: 선택·비용·인식·관계 변화 또는 명시적 noInfluenceReason이 필요합니다.');
  }
  const assertionValidity = {
    storyValidity: { from: chapter, to: null }, publicationValidity: { from: chapter, to: null }, transactionValidity: { from: chapter, to: null },
  };
  const observationArtifact = {
    observationId: checkReceipt ? `check:${checkReceipt.checkId}` : `legacy-manual:${chapter}:${proseHash}`,
    sourceHash: proseHash, status: 'accepted', acceptedAt: executionContext.transactionTime,
    policyRevision: executionContext.policyRevision, worldline: 'main', influenceEvents,
    noInfluenceReason: influenceEvents.length ? null : String(delta.noInfluenceReason ?? '').trim() || null,
    temporal: {
      storyTimeScope: { worldline: 'main', startOrdinal: chapter, endOrdinalExclusive: null, precision: 'chapter', tieGroup: null },
      publicationFrom: chapter, publicationTo: null, transactionFrom: chapter, transactionTo: null,
    },
    epistemic: {
      truthAssertions: [{ status: 'established', evidenceIds: [], ...assertionValidity }],
      readerAssertions: [{ visibility: 'revealed', evidenceIds: [], ...assertionValidity }],
      knowers: [], believers: influenceEvents.flatMap((event) => (event.relationshipClaims ?? []).map((claim) => ({ characterId: claim.from, confidence: 1, ...assertionValidity }))), disbelievers: [],
    },
    acceptance: checkReceipt ? {
      kind: 'workflow_check_and_canon_acceptance', checkId: checkReceipt.checkId,
      workflowId: checkReceipt.workflowId, checkedAt: checkReceipt.checkedAt, proseHash: checkReceipt.proseHash,
    } : { kind: 'legacy_manual_commit', migrationRequired: true },
  };
  const dynamics = foldLegacyChapterCharacterDynamics(executionContext, {
    foundation, delta: { ...delta, chapterNumber: chapter }, episodePlan,
    previous: publishedBefore.value?.projections?.characterDynamics,
    acceptedObservation: observationArtifact,
  });
  if (!dynamics.ok) throw new Error(`CharacterDynamics fold 실패: ${dynamics.error.code}`);
  if (strictPlanningRequired && episodePlan && episodePlan.planningContractVersion !== 2) {
    throw new Error('PLANNING_MIGRATION_REQUIRED: EpisodePlan을 현재 planning contract로 승격할 수 없습니다.');
  }
  const planning = strictPlanningRequired && episodePlan
    ? prepareNarrativeCommit(executionContext, {
      storySpine, arcPlan, episodePlan, storyState: next,
      audienceState: publishedBefore.value?.projections?.audienceState,
    })
    : { ok: true, value: {
      audienceState: publishedBefore.value?.projections?.audienceState ?? { known: [], suspected: [], misled: [], forbidden: [], promises: [] },
      planImpact: { status: 'legacy_migration_required', invalidated: [] }, impactClosure: [], foldReceipt: null,
    } };
  if (!planning.ok) {
    const details = planning.error.details && Object.keys(planning.error.details).length
      ? ` ${JSON.stringify(planning.error.details)}`
      : '';
    throw new Error(`${planning.error.code}: ${planning.error.message}${details}`);
  }
  if (contractCommit) await assertCurrentChapterReceipt({ store, workId, chapter, receipt: checkReceipt,
    artifact: contractArtifact, allowWorkingTreeDrift, validationScope });
  const publication = await publicationUnit.publish({
    context: executionContext,
    candidate: {
      tree: {
        workId, foundation,
        plans: {
          storyProfile, storySpine, writerSkill, storyIdentity, pilotContract,
          arcPlan: publishedArcPlan, episodePlans: { [chapter]: publishedEpisodePlan },
        },
        chapters: { [chapter]: { chapterNumber: chapter, title: title ?? null, prose, delta } },
        summaries: { [chapter]: chapterSummary ?? null },
        observations: { [chapter]: observationArtifact },
        editorialDecisions: { [chapter]: observationArtifact.acceptance },
      },
      projections: {
        storyState: next, entities, summary: chapterSummary ?? null, characterDynamics: dynamics.value,
        audienceState: planning.value.audienceState, planImpact: planning.value.planImpact, planningFoldReceipt: planning.value.foldReceipt,
      },
      impactClosure: planning.value.impactClosure,
    },
  });
  if (!publication.ok) throw new Error(`정사 publication 실패: ${publication.error.code}`);

  // HEAD is the published truth. Markdown is a human-editable materialization;
  // if it fails, recovery must replay this sealed immutable generation rather
  // than rolling HEAD back or exposing a half-published truth state.
  if (commitFault === 'afterPublicationBeforeMaterialization') {
    throw new Error('injected live Markdown materialization failure');
  }

  await store.saveArtifact({ workId, chapterNumber: chapter, prose, ...(title ? { title } : {}), delta });
  await store.saveStoryState(next);
  if (entities.length > 0) await store.saveEntitySnapshots(workId, entities);
  if (chapterSummary) {
    await store.saveChapterSummary({
      workId,
      chapterNumber: chapter,
      summary: chapterSummary,
      ...(generatedSummary ? {
        plotBeat: generatedSummary.plotBeat,
        sceneTags: generatedSummary.sceneTags,
        povCharacter: generatedSummary.povCharacter,
      } : {}),
    });
  }
  const arc = await advanceArcAfterCommit({ store, workId, chapter });
  const episode = await completeEpisodePlan({ store, workId, chapter });
  const workingTreeFingerprint = await captureWorkingTreeFingerprint({ store, sourceHead: publication.value.head });
  let snapshot;
  try { snapshot = await createChapterSnapshot({ store, workId, chapter }); }
  catch (error) { snapshot = { created: false, error: error.message }; }

  if (checkReceipt) {
    if (contractCommit) {
      const state = await loadValidationSession(store, workId, checkReceipt.validationScope);
      await saveValidationSession(store, workId, checkReceipt.validationScope, { ...state, status: 'consumed' });
      checkReceipt.consumed = true;
    }
    checkReceipt.consumedAt = new Date().toISOString();
    await store.saveCheckReceipt(workId, checkReceipt);
  }

  return {
    committed: chapter,
    files: [
      `chapters/${String(chapter).padStart(3, '0')}.md`,
      ...(chapterSummary ? [`summaries/${String(chapter).padStart(3, '0')}.md`] : []),
    ],
    state: {
      hooks: next.hooks?.length ?? 0,
      relationships: next.relationships?.length ?? 0,
      addressEntries: Object.keys(next.addressMap?.entries ?? {}).length,
      trackedEntities: entities.length,
    },
    summary: {
      source: summary ? 'provided' : 'generated',
      text: chapterSummary,
      ...(generatedSummary ? {
        plotBeat: generatedSummary.plotBeat,
        sceneTags: generatedSummary.sceneTags,
        povCharacter: generatedSummary.povCharacter,
      } : {}),
    },
    ...(arc ? { arc } : {}),
    ...(episode ? { episode } : {}),
    snapshot,
    publication: { head: publication.value.head, previousHead: publication.value.previousHead, atomic: true },
    workingTreeFingerprint: { digest: workingTreeFingerprint.digest, sourceHead: workingTreeFingerprint.sourceHead },
  };
}

export async function runStatus({ store, workId }) {
  const workingStore = store;
  const publicationUnit = createPublicationUnit({ rootDir: store.rootDir });
  store = await openCanonRepository({ store, publicationUnit });
  const foundation = await store.loadFoundation(workId);
  if (!foundation) return { initialized: false, message: '이 디렉터리에 작품이 없습니다.', runtime: runtimeVersion() };
  const chapters = await store.listChapters();
  const last = chapters.length ? chapters[chapters.length - 1] : 0;
  const state = last > 0 ? await store.loadStoryState(workId, last) : null;
  const arcPlan = await store.loadArcPlan(workId);
  const storyProfile = await store.loadStoryProfile(workId);
  const nextDetailedEpisode = await store.loadEpisodePlan(workId, last + 1);
  const nextEpisode = arcPlan?.status === 'active'
    ? arcPlan.episodes?.find((episode) => episode.chapter === last + 1) ?? null
    : null;
  const workingTree = store.publishedRevision
    ? await detectWorkingTreeDrift({ store: workingStore, sourceHead: store.publishedRevision.head })
    : { status: 'unpublished', changed: [] };
  return {
    initialized: true,
    workId: foundation.workId,
    genre: foundation.genre,
    povMode: foundation.povMode ?? null,
    chapters: { count: chapters.length, last, numbers: chapters },
    nextChapter: last + 1,
    characters: foundation.characters.map((c) => ({
      id: c.id, name: c.canonicalName, since: c.registeredAtChapter,
    })),
    worldFacts: foundation.worldFacts.length,
    openHooks: (state?.hooks ?? []).map((h) => h.text || h.id),
    arcCursor: state?.arcCursor ?? {},
    arc: arcPlan ? {
      number: arcPlan.arcNumber, title: arcPlan.title, status: arcPlan.status,
      promise: arcPlan.promise, progress: `${arcPlan.episodes.filter((e) => e.status === 'completed').length}/${arcPlan.estimatedEpisodes}`,
      nextEpisode,
    } : { status: 'missing', instruction: '집필 전에 lore_arc_plan을 호출하세요.' },
    storyProfile: storyProfile ? {
      status: storyProfile.status, genreLabel: storyProfile.genreLabel, engineGenre: storyProfile.engineGenre,
      tones: storyProfile.tones, storyEngines: storyProfile.storyEngines,
    } : { status: 'missing', instruction: '자유 장르 요청은 lore_profile로 작품 프로필을 먼저 만드세요.' },
    episodePlan: nextDetailedEpisode ? {
      status: nextDetailedEpisode.status, chapter: nextDetailedEpisode.chapter, title: nextDetailedEpisode.title,
      scenes: nextDetailedEpisode.scenes?.length ?? 0,
    } : { status: 'missing', chapter: last + 1, instruction: 'lore_episode_plan으로 현재 아크 비트를 상세화하세요.' },
    workingTree,
    runtime: runtimeVersion(),
  };
}
