import { gateApprovalActivation } from '../core/approval-language-gate.js';
/** Phase 2 generation tools: keep host-facing interfaces small and reuse engine steps. */
import { createHash } from 'node:crypto';
import { prepareBookFoundationCandidate } from '../../engine/src/generators/text/steps/worldbuild.js';
import { runEntitySeed } from '../../engine/src/generators/text/steps/entity-seed.js';
import { runRevise } from '../../engine/src/generators/text/steps/revise.js';
import { runRewrite } from '../../engine/src/generators/text/steps/rewrite.js';
import { runNextArcProposal } from '../../engine/src/generators/text/steps/next-arc-proposal.js';
import { emptyStoryState, reduceStoryState } from '../../engine/src/continuity/story-state.js';
import { arcPositionFromRatio } from '../../engine/src/core/arc-context.js';
import { buildContext } from './context.js';
import { applyEntityOps } from './entities.js';
import { episodeForChapter, renderArcMap } from './arc.js';
import { compileBriefWithProfile, profileToPromptOverride } from './story-profile.js';
import { renderEpisodePlan } from './episode-plan.js';
import { renderPatternLedger, renderPilotContract, renderStoryIdentity } from './story-experience.js';
import { compileAuthorCraftPacket } from './writer-skill.js';
import { createPublicationUnit } from '../core/publication-unit.js';
import { openCanonRepository } from '../core/canon-repository.js';
import { foldLegacyChapterCharacterDynamics } from '../core/character-dynamics-adapter.js';
import { compileCharacterArcSeeds, renderCharacterArcSeeds } from '../core/character-arc-seeds.js';
import { WRITER_PACKET_MAX_TOKENS, compileWriterEpisodePacket } from '../core/writer-episode-packet.js';
import { MCP_CONTRACT_VERSION } from '../core/runtime-version.js';
import { buildAcceptedCreationRecord, resolveWorkLanguage } from '../core/work-language.js';
import { promptKit } from '../prompts/index.js';
import { executePinnedDraft } from '../core/draft-execution.js';
import { validateSalienceProfile } from '../../engine/src/continuity/character-design.js';
import { compileArcIntent, compileEpisodeIntent, compileNarrativeContract, compileDraftContract, renderNarrativeContract } from '../core/narrative-contract.js';
import { loadCurrentExperienceLedger } from '../core/experience-ledger.js';
import { advanceWorkingTreeFingerprint } from '../core/working-tree-sync.js';
import { renderStyleAnchor } from '../core/style-continuity.js';
import { DefaultOutputSanitizer } from '../../engine/src/core/output-sanitizer.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const canonicalObject = (value) => {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalObject(value[key])]));
  return typeof value === 'string' ? value.normalize('NFC') : value;
};
const sourceDigest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(canonicalObject(value))).digest('hex')}`;

export async function runCreate({ store, workId, title, brief, genre, povMode, targetChapters = 40, chapterWordCount, language = null, length = null, providers, retryValidation = false }) {
  if (await store.loadFoundation(workId)) throw new Error('이미 작품이 있습니다. 자동 생성으로 덮어쓰지 않습니다.');
  const storyProfile = await store.loadStoryProfile(workId);
  if (storyProfile && storyProfile.status !== 'active') throw new Error('StoryProfile이 승인되지 않았습니다. lore_profile_decide로 승인하거나 다시 생성하세요.');
  const engineGenre = storyProfile?.engineGenre ?? genre;
  if (!engineGenre) throw new Error('genre를 넘기거나 먼저 lore_profile로 StoryProfile을 만드세요.');
  // 언어와 분량은 생성 전에 하나의 계약으로 확정한다. 구형 chapterWordCount 는
  // 이름과 무관하게 legacyCodeUnits 로만 해석하며 신규 length 와 충돌하면 거부한다.
  const resolution = await resolveWorkLanguage({
    store, workId, requested: language, length,
    legacyLength: chapterWordCount != null ? { chapterWordCount } : null,
    requireApprovedProfile: true, foundation: null,
  });
  const compiledBrief = compileBriefWithProfile(brief, storyProfile, ['worldbuild', 'cast'], promptKit({ contract: resolution.contract }));
  const input = {
    title, brief: compiledBrief, genre: engineGenre, povMode: povMode ?? storyProfile?.format?.pov, targetChapters,
    length: { unit: resolution.length.unit, target: resolution.length.target },
    language: resolution.language,
    workContract: resolution.contract,
    // strict 인물 설계 위반·JSON 파싱 실패는 같은 요청 안에서 한 번만 수정 재요청한다.
    // 실제 표본에서 조연의 behaviorTraits 1개 같은 경미한 미달이 전체 생성을 즉시 끝냈다.
    castDesignRepairAttempts: 1,
  };
  const { foundation: base } = await prepareBookFoundationCandidate({ workId, providers, model: MODEL }, input);
  const foundation = {
    ...base,
    characters: base.characters.map(({ designViolations, ...character }) => character),
    targetChapters, title, brief, genreLabel: storyProfile?.genreLabel,
  };
  const seeded = await runEntitySeed({ ...input, writerModel: MODEL, seedModel: MODEL, providers });
  const entities = seeded.entities.map((entity, index) => ({
    entityId: `seed-${index + 1}`,
    kind: entity.kind,
    canonicalName: entity.canonicalName,
    aliases: entity.aliases ?? [],
    status: 'active',
    attrs: entity.attrs ?? {},
  }));
  if ((providers.pending?.length ?? 0) > 0) {
    return { preview: true, message: 'pre-flight 질문 수집 중이며 아직 파일을 저장하지 않았습니다.' };
  }
  const designFailures = base.characters.flatMap((character) =>
    (character.designViolations ?? []).map((code) => ({ characterId: character.id, code })));
  designFailures.push(...validateSalienceProfile(base.narrativeSalienceProfile, { strict: true })
    .map((code) => ({ characterId: null, code })));
  if (designFailures.length) {
    throw new Error(`CHARACTER_DESIGN_INVALID: ${JSON.stringify(designFailures)}`);
  }
  const approval = await gateApprovalActivation({ store, workId, kind: 'foundation', value: { ...foundation, language: resolution.language, canonicalFormatVersion: resolution.canonicalFormatVersion, seededEntities: entities }, resolution, providers, retryValidation });
  if (!approval.ok) return { ...approval, created: false };
  await store.saveAcceptedCreation(workId, buildAcceptedCreationRecord({
    workId, resolution, profile: storyProfile,
  }));
  await store.saveFoundation({
    ...foundation,
    language: resolution.language,
    canonicalFormatVersion: resolution.canonicalFormatVersion,
  });
  if (entities.length) await store.saveEntitySnapshots(workId, entities);
  return {
    created: true, workId, genre: engineGenre, genreLabel: storyProfile?.genreLabel ?? engineGenre,
    language: resolution.language,
    canonicalFormatVersion: resolution.canonicalFormatVersion,
    length: { unit: resolution.length.unit, target: resolution.length.target },
    worldFacts: foundation.worldFacts.length,
    characters: foundation.characters.map((c) => ({ id: c.id, name: c.canonicalName, contradiction: c.contradiction })),
    entities: entities.map((e) => ({ id: e.entityId, kind: e.kind, name: e.canonicalName })),
  };
}

/**
 * 이번 실행이 따르는 계약을 못 박은 실행용 foundation 스냅샷.
 * 저장된 정본은 건드리지 않고 현재 승인된 계약을 엔진에 전달한다.
 */
function executionFoundation(foundation, workLanguage) {
  return {
    ...foundation,
    language: workLanguage.language,
    length: { unit: workLanguage.length.unit, target: workLanguage.length.target },
    workContract: workLanguage.contract,
  };
}

/**
 * 실행 스냅샷과 같은 계약을 엔진 호출 인자로 적는다. 구형 `targetWordCount` 는
 * 이름과 무관하게 legacyCodeUnits 목표라서, 다른 단위로 세는 작품에는 싣지 않는다
 * (같은 숫자를 다른 단위로 중복 지정하면 계약 충돌이다).
 */
function engineLanguageArgs(workLanguage, { legacyTarget = false } = {}) {
  return {
    language: workLanguage.language,
    workContract: workLanguage.contract,
    ...(legacyTarget && workLanguage.length.unit === 'legacyCodeUnits'
      ? { targetWordCount: workLanguage.length.target }
      : {}),
  };
}

export async function runDraftTool({ store, workId, chapter, plan = '', tension, targetChars, language = null, length = null, providers, workflowId = null }) {
  const publicationUnit = createPublicationUnit({ rootDir: store.rootDir });
  const draftStore = await openCanonRepository({ store, publicationUnit });
  const pinnedCanonHead = draftStore.publishedRevision?.head ?? 'legacy-working-tree';
  const foundation = await draftStore.loadFoundation(workId);
  if (!foundation) throw new Error('작품이 없습니다. 먼저 lore_init 또는 lore_create를 실행하세요.');
  // 발행된 정본이 있으면 그 foundation 이 실행 원천이다. 명시 language 는 일치
  // 확인용이며 일회성 출력 override 가 아니다.
  const workLanguage = await resolveWorkLanguage({
    store: draftStore, workId, requested: language, length,
    legacyLength: targetChars != null ? { targetChars } : null, foundation,
  });
  // 이 초고를 만드는 모든 엔진 단계가 같은 계약 하나를 본다.
  const executionSnapshot = executionFoundation(foundation, workLanguage);
  const arcPlan = await store.loadArcPlan(workId);
  const arcEpisode = episodeForChapter(arcPlan, chapter);
  if (!arcEpisode) throw new Error('승인된 아크의 해당 회차 비트가 없습니다. lore_arc_plan으로 계획하고 승인하세요.');
  const detailedPlan = await store.loadEpisodePlan(workId, chapter);
  if (!detailedPlan || detailedPlan.status !== 'active') throw new Error('승인된 상세 EpisodePlan이 없습니다. lore_episode_plan을 먼저 실행하세요.');
  const prevState = (await draftStore.loadStoryState(workId, chapter - 1)) ?? emptyStoryState(workId);
  const storyProfile = await store.loadStoryProfile(workId);
  const storyIdentity = await store.loadStoryIdentity(workId);
  const pilotContract = chapter === 1 ? await store.loadPilotContract(workId) : null;
  const patternLedger = (await loadCurrentExperienceLedger({ store, workId })).entries;
  const writerSkill = await store.loadWriterSkill(workId);
  const styleAnchor = await store.loadStyleAnchor?.(workId);
  // 초고 요청에 들어가는 모든 플러그인 렌더링은 이 계약 하나로 계열을 정한다.
  const kit = promptKit({ contract: workLanguage.contract });
  const narrativeContract = compileNarrativeContract({ profile: storyProfile, identity: storyIdentity, writerSkill, kit });
  const arcIntent = compileArcIntent(arcPlan);
  const episodeIntent = compileEpisodeIntent({ episodePlan: detailedPlan, arcEpisode, chapter });
  const pinnedPlanSourceHash = sourceDigest({ arcPlan, detailedPlan, storyProfile, storyIdentity, pilotContract, patternLedger, writerSkill, styleAnchor, narrativeContract, arcIntent, episodeIntent });
  const { context, meta: contextMeta } = await buildContext({ store: draftStore, workId, chapter });
  const planningArc = {
    arcNumber: arcPlan.arcNumber, title: arcPlan.title, promise: arcPlan.promise, type: arcPlan.type,
    currentChapterInArc: arcEpisode.index, estimatedEpisodes: arcPlan.estimatedEpisodes,
    currentPosition: arcPositionFromRatio(arcEpisode.index, arcPlan.estimatedEpisodes),
    summary: renderArcMap(arcPlan, chapter, kit),
  };
  // The draft prompt takes its chapter plan from the approved EpisodePlan
  // packet (draft-input-compiler). The engine's own chapter-plan step used to
  // run here as an extra host round trip, but its answer never reached the
  // prompt, so it is not requested.
  const previousArtifact = chapter > 1 ? await draftStore.loadArtifact(workId, chapter - 1) : null;
  const previousSceneTail = previousArtifact?.prose
    ? previousArtifact.prose.slice(-2400).trim()
    : '';
  const episodePacketResult = compileWriterEpisodePacket({
    episodePlan: detailedPlan,
    arcEpisode,
    prevState,
    readabilityContract: storyProfile?.readabilityContract,
    characterNames: Object.fromEntries(foundation.characters.map((character) => [character.id, character.canonicalName])),
    budget: { maxTokens: WRITER_PACKET_MAX_TOKENS },
    kit,
  });
  if (!episodePacketResult.ok) {
    const details = episodePacketResult.error.missing ? `: ${episodePacketResult.error.missing.join(', ')}` : '';
    throw new Error(`${episodePacketResult.error.code}${details}`);
  }
  const episodePacket = episodePacketResult.value;
  const authorCraftPacket = compileAuthorCraftPacket({ skill: writerSkill, episodePlan: detailedPlan, chapter, recentPatterns: patternLedger.slice(-3), kit });
  const draftContract = compileDraftContract({ profile: storyProfile, identity: storyIdentity, writerSkill, episodePlan: detailedPlan, chapter, kit });
  const writerPacket = [draftContract.writerText, authorCraftPacket, renderStyleAnchor(styleAnchor, kit)].filter(Boolean).join('\n\n');
  const compilerInputs = {
    identity: {
      workId, chapter, workflowId, invocation: workflowId ? 'workflow' : 'direct',
      storyProfileRevision: storyProfile?.revision ?? null,
      arcRevision: arcPlan.revision ?? null,
      episodePlanRevision: detailedPlan.revision ?? null,
      canonicalStateRevision: prevState.chapterNumber ?? chapter - 1,
      canonHead: pinnedCanonHead,
      planSourceHash: pinnedPlanSourceHash,
    },
    episode: episodePacket,
    authorCraft: { writerText: writerPacket },
    kit,
    continuity: {
      genreLine: kit.phrases.draftInput.genreLine(foundation.genre, foundation.povMode || kit.phrases.draftInput.defaultPov),
      recentSummaries: chapter > 1 && contextMeta.recentSummaries?.length
        ? contextMeta.recentSummaries.slice(0, 2).map((summary) => summary.summary || summary)
        : [],
      castIds: detailedPlan.cast,
      locations: detailedPlan.locations,
      previousSceneTail,
    },
    supplementalDirection: plan ? { source: workflowId ? 'workflow-user' : 'direct-user', text: plan } : undefined,
    budget: { maxPlanTokens: 4000, maxContextTokens: 2000, maxMemoryTokens: 300 },
  };
  const planSourceBeforeDraft = sourceDigest({
    arcPlan: await store.loadArcPlan(workId), detailedPlan: await store.loadEpisodePlan(workId, chapter),
    storyProfile: await store.loadStoryProfile(workId), storyIdentity: await store.loadStoryIdentity(workId),
    pilotContract: chapter === 1 ? await store.loadPilotContract(workId) : null,
    patternLedger: (await loadCurrentExperienceLedger({ store, workId })).entries,
    writerSkill: await store.loadWriterSkill(workId), styleAnchor: await store.loadStyleAnchor?.(workId),
    narrativeContract, arcIntent, episodeIntent,
  });
  if (planSourceBeforeDraft !== pinnedPlanSourceHash) throw new Error(`STALE_DRAFT_IDENTITY: planSource ${pinnedPlanSourceHash} -> ${planSourceBeforeDraft}`);
  const currentPublication = await publicationUnit.readPublished();
  if (!currentPublication.ok) throw new Error(`CORRUPT_PUBLICATION: ${currentPublication.error.code}`);
  const observedCanonHead = currentPublication.value?.head ?? 'legacy-working-tree';
  if (observedCanonHead !== pinnedCanonHead) throw new Error(`STALE_DRAFT_IDENTITY: canonHead ${pinnedCanonHead} -> ${observedCanonHead}`);
  const writerArc = { ...planningArc, summary: `${arcEpisode.beat || arcEpisode.goal} → 비용: ${arcEpisode.costCreatedByResolution || arcEpisode.cost || ''}` };
  const execution = await executePinnedDraft({
    resolvedInputs: {
      compiler: compilerInputs,
      engine: {
        foundation: executionSnapshot, prevState, chapterNumber: chapter,
        activeCastIds: detailedPlan.cast,
        tension: tension ?? detailedPlan.tension, arc: writerArc,
        ...engineLanguageArgs(workLanguage, { legacyTarget: true }),
        model: MODEL,
      },
    },
    memoryClaims: [],
  }, { provider: providers });
  if (!execution.ok) throw new Error(`${execution.error.code}: ${execution.error.reason ?? 'draft-execution'}`);
  const result = execution.value;
  const publicationAfterDraft = await publicationUnit.readPublished();
  if (!publicationAfterDraft.ok) throw new Error(`CORRUPT_PUBLICATION: ${publicationAfterDraft.error.code}`);
  const canonHeadAfterDraft = publicationAfterDraft.value?.head ?? 'legacy-working-tree';
  if (canonHeadAfterDraft !== pinnedCanonHead) throw new Error(`STALE_DRAFT_IDENTITY: canonHead ${pinnedCanonHead} -> ${canonHeadAfterDraft}`);
  const planSourceAfterDraft = sourceDigest({
    arcPlan: await store.loadArcPlan(workId), detailedPlan: await store.loadEpisodePlan(workId, chapter),
    storyProfile: await store.loadStoryProfile(workId), storyIdentity: await store.loadStoryIdentity(workId),
    pilotContract: chapter === 1 ? await store.loadPilotContract(workId) : null,
    patternLedger: (await loadCurrentExperienceLedger({ store, workId })).entries,
    writerSkill: await store.loadWriterSkill(workId), styleAnchor: await store.loadStyleAnchor?.(workId),
    narrativeContract, arcIntent, episodeIntent,
  });
  if (planSourceAfterDraft !== pinnedPlanSourceHash) throw new Error(`STALE_DRAFT_IDENTITY: planSource ${pinnedPlanSourceHash} -> ${planSourceAfterDraft}`);
  const exchangeId = await store.saveModelExchange(workId, {
    request: result.providerRequest, response: result.raw,
    binding: { chapter, planSourceHash: pinnedPlanSourceHash, contractDigest: draftContract.trace.digest },
  });
  return {
    chapter, prose: result.raw, next: 'lore_check로 검사한 뒤 lore_commit 하세요.',
    contextAudit: {
      recentSummaries: contextMeta.recentSummaries,
      previousSceneChars: previousSceneTail.length,
      arcEpisodes: arcPlan.episodes.length,
      characterArcBeats: detailedPlan.characterArcBeats?.length ?? 0,
      episodePacketChars: episodePacket.writerText.length,
      episodePacketTokens: episodePacket.usage.usedTokens,
      episodeObligationHash: episodePacket.trace.obligationHash,
      episodePacketTrace: episodePacket.trace,
      writerPacketChars: writerPacket.length,
      draftContract: draftContract.trace,
      styleAnchorRevision: styleAnchor?.revision ?? null,
      styleAnchorSourceChapters: styleAnchor?.sourceChapters ?? [],
      narrativeContractDigest: narrativeContract.digest,
      arcIntentDigest: arcIntent?.digest ?? null,
      episodeIntentDigest: episodeIntent?.digest ?? null,
      draftInputTrace: result.compiled.trace,
      draftInputUsage: result.compiled.usage,
      providerRequestHash: result.providerRequestHash,
      exchangeId,
      language: workLanguage.language,
      lengthUnit: workLanguage.length.unit,
      lengthTarget: workLanguage.length.target,
      languageContractHash: workLanguage.contractHash,
      mcpContractVersion: MCP_CONTRACT_VERSION,
    },
  };
}

export async function runReviseTool({ store, workId, chapter, prose, castManifestRaw, violations, language = null, providers }) {
  const foundation = await store.loadFoundation(workId);
  if (!foundation) throw new Error('작품이 없습니다.');
  const workLanguage = await resolveWorkLanguage({ store, workId, requested: language, foundation });
  const sanitizer = new DefaultOutputSanitizer();
  const embeddedManifest = sanitizer.extractBlock(prose, 'cast-manifest');
  const sourceProse = sanitizer.sanitize(prose).clean.trim();
  const sourceCastManifest = castManifestRaw ?? embeddedManifest?.body ?? '{"cast":[]}';
  const reviseKit = promptKit({ contract: workLanguage.contract });
  const [profile, writerSkill, styleAnchor, previousArtifact] = await Promise.all([
    store.loadStoryProfile?.(workId),
    store.loadWriterSkill?.(workId),
    store.loadStyleAnchor?.(workId),
    chapter > 1 ? store.loadArtifact(workId, chapter - 1) : null,
  ]);
  const result = await runRevise({
    foundation: executionFoundation(foundation, workLanguage), chapterNumber: chapter, prose: sourceProse,
    castManifestRaw: sourceCastManifest,
    violations: Array.isArray(violations) ? violations : [],
    patchMode: true,
    styleContext: {
      approvedAnchor: renderStyleAnchor(styleAnchor, reviseKit),
      voiceContract: profile?.voiceContract ?? null,
      writerSkill: writerSkill ? renderNarrativeContract(compileNarrativeContract({ profile, writerSkill, kit: reviseKit }), reviseKit) : '',
      previousSceneTail: previousArtifact?.prose?.slice(-1200).trim() ?? '',
    },
    ...engineLanguageArgs(workLanguage), model: MODEL, providers,
  });
  return { chapter, prose: result.revisedProse, next: '수정본을 lore_check로 다시 검사하세요.' };
}

export async function runRewriteTool({ store, workId, chapter, intent, language = null, providers }) {
  const foundation = await store.loadFoundation(workId);
  const artifact = await store.loadArtifact(workId, chapter);
  if (!foundation || !artifact) throw new Error(`${chapter}화 원본 또는 작품 설정을 찾을 수 없습니다.`);
  const workLanguage = await resolveWorkLanguage({ store, workId, requested: language, foundation });
  const prevState = (await store.loadStoryState(workId, chapter - 1)) ?? emptyStoryState(workId);
  const result = await runRewrite({
    foundation: executionFoundation(foundation, workLanguage), prevState, chapterNumber: chapter,
    previousProse: artifact.prose, intentSummary: intent,
    ...engineLanguageArgs(workLanguage), model: MODEL, providers,
  });
  return { chapter, prose: result.prose, next: '다시 쓴 본문을 lore_check → lore_commit → lore_refold 순서로 반영하세요.' };
}

export async function runNextArc({ store, workId, currentArc, providers }) {
  const foundation = await store.loadFoundation(workId);
  if (!foundation) throw new Error('작품이 없습니다.');
  const chapters = await store.listChapters();
  const last = chapters.at(-1) ?? 0;
  const state = last ? await store.loadStoryState(workId, last) : null;
  const summaries = await store.loadRecentChapterSummaries(workId, last + 1, 10);
  const storedArc = await store.loadArcPlan(workId);
  const arc = currentArc ?? {
    arcNumber: Number(state?.arcCursor?.arcNumber ?? 1), title: '현재 아크', promise: '',
    type: 'standard', currentChapterInArc: last || 1, estimatedEpisodes: 12,
  };
  let characterDynamics = typeof store.loadCharacterDynamics === 'function'
    ? await store.loadCharacterDynamics(workId)
    : null;
  if (!characterDynamics && store.rootDir) {
    const canonical = await openCanonRepository({
      store, publicationUnit: createPublicationUnit({ rootDir: store.rootDir }),
    });
    characterDynamics = typeof canonical.loadCharacterDynamics === 'function'
      ? await canonical.loadCharacterDynamics(workId)
      : null;
  }
  const finalChapter = storedArc?.episodes?.at(-1)?.chapter;
  const previousArcReview = storedArc?.status === 'completed' && finalChapter
    ? await store.loadArcReview(workId, storedArc.arcNumber, finalChapter)
    : null;
  const characterArcSeeds = compileCharacterArcSeeds({
    foundation, projection: characterDynamics, previousArcPlan: storedArc, previousArcReview,
  });
  // 엔진 프롬프트는 2A 의 다른 소유자가 소비한다. 여기서는 해결된 언어와 계약을
  // 넘기고 플러그인이 만드는 문구만 계열에 맞춘다.
  const workLanguage = await resolveWorkLanguage({ store, workId, foundation });
  const kit = promptKit({ contract: workLanguage.contract });
  const proposal = await runNextArcProposal({
    currentArc: arc,
    workMeta: { genre: foundation.genre, targetChapters: foundation.targetChapters, totalChaptersSoFar: last },
    characters: foundation.characters.map((c) => ({ id: c.id, canonicalName: c.canonicalName, role: c.intrinsic?.role })),
    entities: await store.loadEntitySnapshots(workId),
    workSummary: summaries.reverse().map((s) => s.summary).join('\n'),
    characterArcSeeds: renderCharacterArcSeeds(characterArcSeeds, kit),
    ...engineLanguageArgs(workLanguage),
    writerModel: MODEL, proposalModel: MODEL, providers,
  });
  return { proposal };
}

export async function runRefold({ store, workId, fromChapter = 1 }) {
  const publicationUnit = createPublicationUnit({ rootDir: store.rootDir });
  const canonicalStore = await openCanonRepository({ store, publicationUnit });
  const chapters = await canonicalStore.listChapters();
  const foundation = await canonicalStore.loadFoundation(workId);
  const arcPlan = await store.loadArcPlan(workId);
  let state = emptyStoryState(workId);
  let entities = [];
  let dynamics = null;
  let rebuilt = 0;
  for (const chapter of chapters) {
    const artifact = await canonicalStore.loadArtifact(workId, chapter);
    if (!artifact?.delta) throw new Error(`${chapter}화 델타가 없어 재접기할 수 없습니다.`);
    state = reduceStoryState(state, artifact.delta);
    if (artifact.delta.entityOps?.length) {
      entities = applyEntityOps(entities, artifact.delta.entityOps, chapter).snapshots;
    }
    const observation = canonicalStore.publishedRevision?.tree?.observations?.[chapter];
    if (observation) {
      const folded = foldLegacyChapterCharacterDynamics({
        snapshotId: canonicalStore.publishedRevision.head, expectedHead: canonicalStore.publishedRevision.head,
        storyTimeScope: { worldline: 'main', through: chapter }, publicationOrder: chapter,
        transactionTime: observation.acceptedAt, policyRevision: observation.policyRevision,
        semanticGeneration: 'vibelore-1', fencingToken: canonicalStore.publishedRevision.manifest.fencingToken,
      }, { foundation, delta: { ...artifact.delta, chapterNumber: chapter }, episodePlan: await canonicalStore.loadEpisodePlan(workId, chapter), acceptedObservation: observation, previous: dynamics });
      if (!folded.ok) throw new Error(`CharacterDynamics refold 실패: ${folded.error.code}`);
      dynamics = folded.value;
    }
    if (chapter >= fromChapter) rebuilt += 1;
  }
  const published = canonicalStore.publishedRevision;
  if (published) {
    const token = await publicationUnit.issueFencingToken();
    const result = await publicationUnit.publish({
      context: {
        snapshotId: published.head, expectedHead: published.head, storyTimeScope: { worldline: 'main', through: chapters.at(-1) ?? 0 },
        publicationOrder: chapters.at(-1) ?? 1, transactionTime: new Date().toISOString(), policyRevision: 'vibelore-1',
        semanticGeneration: 'vibelore-1', fencingToken: token.value.fencingToken,
      },
      candidate: {
        tree: arcPlan ? { plans: { arcPlan } } : {},
        projections: { storyState: state, entities, ...(dynamics ? { characterDynamics: dynamics } : {}) },
        impactClosure: [],
      },
    });
    if (!result.ok) throw new Error(`refold publication 실패: ${result.error.code}`);
    await advanceWorkingTreeFingerprint({ store, previousHead: published.head, sourceHead: result.value.head });
  }
  await store.saveStoryState(state);
  await store.saveEntitySnapshots(workId, entities);
  return { fromChapter, throughChapter: chapters.at(-1) ?? 0, rebuilt };
}
