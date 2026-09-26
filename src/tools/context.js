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
import { episodeForChapter, renderArcEpisode } from './arc.js';
import { renderStoryProfile } from './story-profile.js';
import { renderStorySpine } from './story-spine.js';
import { renderEpisodePlan } from './episode-plan.js';
import { hookDebt, retrieveMemory } from './memory-index.js';
import { compileMemory } from '../core/memory-compiler.js';
import { SEARCH_TERMS_REVISION } from '../core/search-terms.js';
import { createPublicationUnit } from '../core/publication-unit.js';
import { createHash } from 'node:crypto';
import { renderSceneCharacterPacket } from '../core/character-dynamics-adapter.js';
import { openCanonRepository } from '../core/canon-repository.js';
import { isHookActive } from '../../engine/src/continuity/story-state.js';
import { PROMPT_FAMILY_KO, promptKit } from '../prompts/index.js';
import { resolveWorkLanguage } from '../core/work-language.js';
import { tokenUnits } from '../core/token-units.js';
import { renderCharacter } from '../core/prompt-sections.js';

export const MAX_CONTEXT_TOKENS = 18000;

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

/**
 * `onOverflow: 'throw'` (lore_context) refuses an oversized context. Writer
 * and reviewer paths pass 'report': the draft does not send this string, so
 * an oversized one is recorded in `meta.overflow` and the trace instead of
 * stopping the chapter, and memory falls back to none when the mandatory set
 * alone is over its budget.
 */
export async function buildContext({ store, workId, chapter, scene, targetChapters, onOverflow = 'throw' }) {
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
  // The engine renders the entity and summary sections. They are prompt text,
  // not canonical files, so their labels follow the prompt family like every
  // other heading here: ko gets the legacy call with no language (bytes
  // unchanged), other families get the multilingual (English) labels.
  const sectionLanguage = kit.family === PROMPT_FAMILY_KO ? undefined : workLanguage.contract;

  const window = await buildSlidingWindow({ workId, currentChapter: chapter, state: store, promptFamily: kit.family });
  const lastState = window.lastStoryState;

  const snapshots = await store.loadEntitySnapshots(workId);
  const entity = resolveEntityContext({ snapshots, scene: scene ?? undefined, promptFamily: kit.family });

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
  const searchLanguage = workLanguage.contract?.language;
  const memory = await retrieveMemory({ store, workId, query: retrievalQuery, currentChapter: chapter, language: searchLanguage });
  // Candidates get the same `scope:ref` ids as the mandatory set so facts and
  // active hooks are not selected twice. The window already carries its
  // summaries verbatim, and a redraft must not see canon from the chapter it
  // replaces or later ones.
  const windowChapters = new Set(window.recentSummaries.map((summary) => summary.chapterNumber));
  const candidates = memory.candidates
    .filter((item) => Number(item.chapter) < chapter && !(item.scope === 'summary' && windowChapters.has(Number(item.chapter))))
    .map((item) => ({ ...item, id: `${item.scope}:${item.ref}` }));
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
    mandatory, candidates: candidates,
    query: retrievalQuery, promptFamily: kit.family, language: searchLanguage,
    indexGeneration: `memory:${memory.documents}`, tokenizerRevision: SEARCH_TERMS_REVISION, rankerRevision: memory.backend,
  });
  const t = kit.phrases.context;
  const overflow = { context: null, memory: null };
  if (!compiledMemory.ok) {
    if (onOverflow !== 'report') throw new Error(`${compiledMemory.error.code}: ${t.mandatoryOverflow}`);
    overflow.memory = compiledMemory.error.code;
  }
  const memoryItems = compiledMemory.ok ? compiledMemory.value.discretionary : [];

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
    episodePlan, kit,
  });
  if (characterPacket) sections.push('', characterPacket);

  const address = renderAddressMap(lastState, foundation, kit);
  if (address) sections.push('', t.addressHeading, address);

  // Only hooks still open; paid or parked ones are not promises to the reader.
  const openHooks = (lastState?.hooks ?? []).filter(isHookActive);
  if (openHooks.length) {
    sections.push('', t.hooksHeading,
      openHooks.map((h) => {
        const text = h.text || h.id;
        const started = h.plantedAtChapter;
        return t.hook(text, started);
      }).join('\n'));
  }

  if (entity.injected.length > 0) sections.push('', renderEntityContext(entity, sectionLanguage));

  if (memoryItems.length) {
    sections.push('', t.memoryHeading,
      ...memoryItems.map((item) => t.memoryItem(item.scope ?? item.kind, item.ref ?? item.id, item.chapter, item.text)));
  }
  const debts = hookDebt(lastState?.hooks, chapter);
  if (debts.length) sections.push('', t.hookDebtHeading, ...debts.map((debt) => t.hookDebt(debt.id, debt.staleFor, debt.action)));

  sections.push('', renderSlidingWindow(window, sectionLanguage));

  const context = sections.join('\n');
  // ko 계열은 0.3.10 그대로 flat chars/2 를 쓴다(entity-context/sliding-window/
  // memory-compiler 예산도 kit.family 로 같은 규칙을 따른다). 그 외 계열만 스크립트
  // 인지 tokenUnits() 로 추정한다.
  const actualTokens = kit.family === PROMPT_FAMILY_KO
    ? Math.max(1, Math.ceil([...context].length / 2))
    : tokenUnits(context);
  if (actualTokens > MAX_CONTEXT_TOKENS) {
    if (onOverflow !== 'report') throw new Error(`context_overflow: ${t.contextOverflow(actualTokens, MAX_CONTEXT_TOKENS)}`);
    overflow.context = { actualTokens, maxTokens: MAX_CONTEXT_TOKENS };
  }
  const contextHash = `sha256:${createHash('sha256').update(context).digest('hex')}`;
  const trace = {
    workId, chapter, compiledAt: new Date().toISOString(), query: retrievalQuery,
    protected: { worldFacts: foundation.worldFacts.map((f) => f.id), characters: visible.map((c) => c.id), arcEpisode: arcEpisode?.index ?? null, episodePlan: episodePlan?.revision ?? null },
    slidingWindow: { included: window.recentSummaries.map((summary) => summary.chapterNumber), trimmed: window.trimmedCount },
    retrieval: { documents: memory.documents, candidates: memory.candidates, selected: memory.selected, compiled: compiledMemory.ok ? compiledMemory.value : null }, hookDebt: debts,
    overflow,
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
      // Newest-first text of the same window, and the older memory the
      // compiler selected, so the draft sees what this context assembled.
      recentSummaryTexts: window.recentSummaries.map((summary) => ({ chapter: summary.chapterNumber, text: summary.summary })),
      overflow,
      olderMemory: memoryItems.map((item) => ({
        scope: item.scope ?? item.kind, ref: item.ref ?? item.id, chapter: item.chapter ?? null, text: item.text,
      })),
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
