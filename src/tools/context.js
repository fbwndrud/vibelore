/**
 * lore_context -- assemble everything the host model needs in order to write
 * the next chapter without drifting out of the writer's world.
 *
 * This is the tool that has to be excellent. Everything else in the plugin
 * catches mistakes after the fact; this one prevents them, and a model that
 * gets a good context block mostly does not make the mistakes in the first
 * place. So the block is written to be *read by a model*: canonical facts
 * first, then who is on stage and what is pinned about them, then what just
 * happened, then what this chapter owes the reader.
 */
import { buildSlidingWindow, renderSlidingWindow } from '../../engine/src/core/sliding-window.js';
import { resolveEntityContext, renderEntityContext } from '../../engine/src/core/entity-context.js';
import { arcPositionFromRatio, ARC_POSITION_LABEL_KO } from '../../engine/src/core/arc-context.js';
import { effectiveIntrinsic } from '../../engine/src/continuity/character.js';
import { episodeForChapter, renderArcEpisode } from './arc.js';
import { renderStoryProfile } from './story-profile.js';
import { renderStorySpine } from './story-spine.js';
import { renderEpisodePlan } from './episode-plan.js';
import { hookDebt, retrieveMemory } from './memory-index.js';
import { compileMemory } from '../core/memory-compiler.js';
import { createPublicationUnit } from '../core/publication-unit.js';
import { createHash } from 'node:crypto';
import { renderSceneCharacterPacket } from '../core/character-dynamics-adapter.js';
import { openCanonRepository } from '../core/canon-repository.js';
import { isHookActive } from '../../engine/src/continuity/story-state.js';
import { PROMPT_FAMILY_KO, promptKit } from '../prompts/index.js';
import { resolveWorkLanguage } from '../core/work-language.js';
import { tokenUnits } from '../core/token-units.js';

export const MAX_CONTEXT_TOKENS = 18000;

function renderCharacter(foundation, character, chapter, kit) {
  const t = kit.phrases.context;
  const labels = t.intrinsicLabels;
  const events = foundation.intrinsicChanges.filter((e) => e.characterId === character.id);
  const intrinsic = effectiveIntrinsic(character.intrinsic, events, chapter);
  const pinned = Object.entries(labels)
    .filter(([k]) => intrinsic[k] !== undefined && intrinsic[k] !== '')
    .map(([k, label]) => `${label}=${intrinsic[k]}`);
  if (intrinsic.coreAppearance?.length) pinned.push(t.appearance(intrinsic.coreAppearance.join('·')));
  const lines = [`- **${character.canonicalName}** (\`${character.id}\`) — ${pinned.join(', ')}`];
  if (character.contradiction) lines.push(t.characterContradiction(character.contradiction));
  const model = character.dramaticModel;
  if (model?.valueOrder?.length) lines.push(t.valueOrder(model.valueOrder.join(' > ')));
  for (const trait of (model?.behaviorTraits ?? []).slice(0, 3)) {
    lines.push(t.behaviorTrait(trait.trigger, trait.actionBias, trait.benefit, trait.cost));
  }
  if (model?.perception?.seesFirst?.length || model?.perception?.missesFirst?.length) {
    lines.push(t.perception(model.perception.seesFirst?.join('·') || '-', model.perception.missesFirst?.join('·') || '-'));
  }
  if (model?.defense?.underPressure) lines.push(t.defense(model.defense.underPressure));
  if (model?.repair?.firstMove) lines.push(t.repair(model.repair.firstMove));
  const speech = character.speechProfile;
  if (speech) {
    const samples = speech.samples ?? {};
    lines.push(t.speech([speech.defaultRegister, speech.sentenceShape, speech.logicHabit, speech.emotionalLeak].filter(Boolean).join(' / ') || t.speechProfilePresent));
    const sampleLines = [
      samples.everyday ? t.speechSampleEveryday(samples.everyday) : '',
      samples.underPressure ? t.speechSamplePressure(samples.underPressure) : '',
      samples.lying ? t.speechSampleLying(samples.lying) : '',
      samples.intimate ? t.speechSampleIntimate(samples.intimate) : '',
    ].filter(Boolean);
    if (sampleLines.length) lines.push(t.speechSamples(sampleLines.join(' / ')));
    if (speech.relationVariants?.length) {
      lines.push(t.relationVariants(speech.relationVariants.map((row) => `${row.targetId || '?'}=${row.adjustment || row.sample || ''}`).join('; ')));
    }
  }
  const changed = events.filter((e) => e.atChapter <= chapter);
  if (changed.length > 0) {
    lines.push(t.intrinsicChanges(changed.map((e) => t.intrinsicChange(e.atChapter, labels[e.field] ?? e.field, JSON.stringify(e.from), JSON.stringify(e.to))).join('; ')));
  }
  return lines.join('\n');
}

function renderAddressMap(state, foundation, kit) {
  const entries = Object.entries(state?.addressMap?.entries ?? {});
  if (entries.length === 0) return null;
  const name = (id) => foundation.characters.find((c) => c.id === id)?.canonicalName ?? id;
  return entries
    .map(([pair, e]) => {
      const [speaker, target] = pair.split('->');
      return kit.phrases.context.address(name(speaker), name(target), e.term, e.register ?? '?', e.sinceChapter);
    })
    .join('\n');
}

export async function buildContext({ store, workId, chapter, scene, targetChapters }) {
  const publicationUnit = createPublicationUnit({ rootDir: store.rootDir });
  store = await openCanonRepository({ store, publicationUnit });
  const foundation = await store.loadFoundation(workId);
  if (!foundation) {
    throw new Error('이 디렉터리에 작품이 없습니다. 먼저 lore_init 을 실행하세요.');
  }

  // 집필 컨텍스트는 최종 provider 메시지로 들어간다. 라벨과 안내 문장은 작품 언어
  // 계열을 따르고, 작품 데이터·ID·고유명은 저장된 값 그대로 둔다.
  const workLanguage = await resolveWorkLanguage({ store, workId, foundation });
  const kit = promptKit({ contract: workLanguage.contract });

  const window = await buildSlidingWindow({ workId, currentChapter: chapter, state: store });
  const lastState = window.lastStoryState;

  const snapshots = await store.loadEntitySnapshots(workId);
  const entity = resolveEntityContext({ snapshots, scene: scene ?? undefined });

  const estimated = targetChapters ?? foundation.targetChapters ?? 0;
  const arcPlan = await store.loadArcPlan(workId);
  const storyProfile = await store.loadStoryProfile(workId);
  const storySpine = await store.loadStorySpine(workId);
  const episodePlan = await store.loadEpisodePlan(workId, chapter);
  const arcEpisode = episodeForChapter(arcPlan, chapter);
  const arcPosition = arcEpisode
    ? arcPositionFromRatio(arcEpisode.index, arcPlan.estimatedEpisodes)
    : (estimated > 0 ? arcPositionFromRatio(chapter, estimated) : null);

  const visible = foundation.characters.filter((c) => (c.registeredAtChapter ?? 1) <= chapter);
  const retrievalQuery = [arcEpisode?.beat, arcEpisode?.pressure, episodePlan?.premise, episodePlan?.entryState?.activeQuestion,
    episodePlan?.readerExpectation?.likelyOutcome, ...(episodePlan?.hooksTouched ?? []), ...(scene?.entityIds ?? [])].filter(Boolean).join(' ');
  const published = store.publishedRevision ? { ok: true, value: store.publishedRevision } : { ok: true, value: null };
  const snapshotId = published.value?.head ?? 'legacy-working-tree';
  const memory = await retrieveMemory({ store, workId, query: retrievalQuery, currentChapter: chapter });
  const mandatory = [
    ...foundation.worldFacts.map((fact) => ({ id: `fact:${fact.id}`, kind: 'world_fact', text: fact.statement, active: true })),
    ...(lastState?.hooks ?? []).filter(isHookActive).map((hook) => ({ id: `hook:${hook.id}`, kind: 'promise', text: hook.text ?? '', active: true })),
  ];
  const compiledMemory = compileMemory({
    snapshotId, expectedHead: snapshotId, storyTimeScope: { worldline: 'main', through: chapter - 1 },
    publicationOrder: chapter - 1, transactionTime: new Date().toISOString(), policyRevision: 1,
    semanticGeneration: 1, fencingToken: published.value?.manifest?.fencingToken ?? 1,
  }, {
    scope: { chapter, entityIds: scene?.entityIds ?? [] }, budget: { maxTokens: 12000, reservedTokens: 3000 },
    mandatory, candidates: memory.candidates, query: retrievalQuery,
    indexGeneration: `memory:${memory.documents}`, tokenizerRevision: 'unicode61-or-ko-basic-1', rankerRevision: memory.backend,
  });
  const t = kit.phrases.context;
  if (!compiledMemory.ok) throw new Error(`${compiledMemory.error.code}: ${t.mandatoryOverflow}`);

  const sections = [
    t.heading(chapter, workId),
    '',
    t.genreLine(foundation.genre, foundation.povMode, arcPosition
      ? (kit.family === PROMPT_FAMILY_KO ? ARC_POSITION_LABEL_KO?.[arcPosition] ?? arcPosition : arcPosition)
      : null),
    '',
    t.worldFactsHeading,
    foundation.worldFacts.length
      ? foundation.worldFacts.map((f) => `- (${f.id}) ${f.statement}`).join('\n')
      : t.worldFactsEmpty,
    '',
    t.charactersHeading,
    visible.length ? visible.map((c) => renderCharacter(foundation, c, chapter, kit)).join('\n') : t.charactersEmpty,
  ];

  if (arcEpisode) {
    sections.push('', renderArcEpisode(arcPlan, arcEpisode, kit));
  } else if (arcPlan?.status === 'pending') {
    sections.push('', t.arcPendingHeading, t.arcPendingRule);
  } else {
    sections.push('', t.arcMissingHeading, t.arcMissingRule);
  }

  const profileBlock = renderStoryProfile(storyProfile, kit);
  if (profileBlock) sections.push('', profileBlock);
  else if (storyProfile?.status === 'pending') sections.push('', t.profilePendingHeading, t.profilePendingRule);

  const spineBlock = renderStorySpine(storySpine, kit);
  if (spineBlock) sections.push('', spineBlock);
  else sections.push('', t.spineMissingHeading, t.spineMissingRule);

  const episodeBlock = renderEpisodePlan(episodePlan, kit);
  if (episodeBlock) sections.push('', episodeBlock);
  else if (arcEpisode && episodePlan?.status === 'pending') sections.push('', t.episodePendingHeading, t.episodePendingRule);
  else if (arcEpisode) sections.push('', t.episodeMissingHeading, t.episodeMissingRule);

  const characterPacket = renderSceneCharacterPacket({
    projection: published.value?.projections?.characterDynamics,
    cast: episodePlan?.cast ?? [], pressure: episodePlan?.scenePressure?.decisionDeadline ?? '',
    kit,
  });
  if (characterPacket) sections.push('', characterPacket);

  const address = renderAddressMap(lastState, foundation, kit);
  if (address) sections.push('', t.addressHeading, address);

  if (lastState?.hooks?.length) {
    sections.push('', t.hooksHeading,
      lastState.hooks.map((h) => {
        const text = h.text || h.id;
        const started = h.plantedAtChapter;
        return t.hook(text, started);
      }).join('\n'));
  }

  if (entity.injected.length > 0) sections.push('', renderEntityContext(entity));

  if (compiledMemory.value.discretionary.length) {
    sections.push('', t.memoryHeading,
      ...compiledMemory.value.discretionary.map((item) => t.memoryItem(item.scope ?? item.kind, item.ref ?? item.id, item.chapter, item.text)));
  }
  const debts = hookDebt(lastState?.hooks, chapter);
  if (debts.length) sections.push('', t.hookDebtHeading, ...debts.map((debt) => t.hookDebt(debt.id, debt.staleFor, debt.action)));

  sections.push('', renderSlidingWindow(window));

  const context = sections.join('\n');
  const actualTokens = tokenUnits(context);
  if (actualTokens > MAX_CONTEXT_TOKENS) {
    throw new Error(`context_overflow: ${t.contextOverflow(actualTokens, MAX_CONTEXT_TOKENS)}`);
  }
  const contextHash = `sha256:${createHash('sha256').update(context).digest('hex')}`;
  const trace = {
    workId, chapter, compiledAt: new Date().toISOString(), query: retrievalQuery,
    protected: { worldFacts: foundation.worldFacts.map((f) => f.id), characters: visible.map((c) => c.id), arcEpisode: arcEpisode?.index ?? null, episodePlan: episodePlan?.revision ?? null },
    slidingWindow: { included: window.recentSummaries.map((summary) => summary.chapterNumber), trimmed: window.trimmedCount },
    retrieval: { documents: memory.documents, candidates: memory.candidates, selected: memory.selected, compiled: compiledMemory.value }, hookDebt: debts,
    contextChars: context.length, actualTokens, contextHash,
  };
  await store.saveContextTrace(workId, trace);
  return {
    context,
    meta: {
      workId,
      chapter,
      genre: foundation.genre,
      characterCount: visible.length,
      worldFactCount: foundation.worldFacts.length,
      openHooks: lastState?.hooks?.length ?? 0,
      recentSummaries: window.recentSummaries.length,
      trimmedSummaries: window.trimmedCount,
      arcPosition,
      missingEntityIds: entity.missingIds,
      arcPlanStatus: arcPlan?.status ?? 'missing',
      arcNumber: arcPlan?.arcNumber ?? null,
      arcEpisode: arcEpisode?.index ?? null,
      storyProfileStatus: storyProfile?.status ?? 'missing',
      genreLabel: storyProfile?.genreLabel ?? foundation.genre,
      episodePlanStatus: episodePlan?.status ?? 'missing',
      retrievedMemory: memory.selected.length,
      contextTrace: `context-traces/${chapter}.json`,
    },
  };
}
