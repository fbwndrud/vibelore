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

const INTRINSIC_LABEL = {
  species: '종족', form: '형태', gender: '성별', genderLabel: '성별 설명', ageBand: '연령대', birthOrder: '출생순서', role: '역할',
};
const MAX_CONTEXT_TOKENS = 18000;

function renderCharacter(foundation, character, chapter) {
  const events = foundation.intrinsicChanges.filter((e) => e.characterId === character.id);
  const intrinsic = effectiveIntrinsic(character.intrinsic, events, chapter);
  const pinned = Object.entries(INTRINSIC_LABEL)
    .filter(([k]) => intrinsic[k] !== undefined && intrinsic[k] !== '')
    .map(([k, label]) => `${label}=${intrinsic[k]}`);
  if (intrinsic.coreAppearance?.length) pinned.push(`외형=${intrinsic.coreAppearance.join('·')}`);
  const lines = [`- **${character.canonicalName}** (\`${character.id}\`) — ${pinned.join(', ')}`];
  if (character.contradiction) lines.push(`  - 모순: ${character.contradiction}`);
  const model = character.dramaticModel;
  if (model?.valueOrder?.length) lines.push(`  - 가치 우선순위: ${model.valueOrder.join(' > ')}`);
  for (const trait of (model?.behaviorTraits ?? []).slice(0, 3)) {
    lines.push(`  - 행동 편향: ${trait.trigger} → ${trait.actionBias} (효용: ${trait.benefit}; 비용: ${trait.cost})`);
  }
  if (model?.perception?.seesFirst?.length || model?.perception?.missesFirst?.length) {
    lines.push(`  - 인식: 먼저 ${model.perception.seesFirst?.join('·') || '-'} / 늦게 ${model.perception.missesFirst?.join('·') || '-'}`);
  }
  if (model?.defense?.underPressure) lines.push(`  - 압박 시 방어: ${model.defense.underPressure}`);
  if (model?.repair?.firstMove) lines.push(`  - 회복 첫 행동: ${model.repair.firstMove}`);
  const speech = character.speechProfile;
  if (speech) {
    const samples = speech.samples ?? {};
    lines.push(`  - 말투: ${[speech.defaultRegister, speech.sentenceShape, speech.logicHabit, speech.emotionalLeak].filter(Boolean).join(' / ') || '프로필 있음'}`);
    const sampleLines = [
      samples.everyday ? `평상시="${samples.everyday}"` : '',
      samples.underPressure ? `압박="${samples.underPressure}"` : '',
      samples.lying ? `거짓말="${samples.lying}"` : '',
      samples.intimate ? `친밀="${samples.intimate}"` : '',
    ].filter(Boolean);
    if (sampleLines.length) lines.push(`  - 말투 예시: ${sampleLines.join(' / ')}`);
    if (speech.relationVariants?.length) {
      lines.push(`  - 관계별 말투: ${speech.relationVariants.map((row) => `${row.targetId || '?'}=${row.adjustment || row.sample || ''}`).join('; ')}`);
    }
  }
  const changed = events.filter((e) => e.atChapter <= chapter);
  if (changed.length > 0) {
    lines.push(`  - 변경 이력: ${changed.map((e) => `${e.atChapter}화 ${INTRINSIC_LABEL[e.field] ?? e.field} ${JSON.stringify(e.from)}→${JSON.stringify(e.to)}`).join('; ')}`);
  }
  return lines.join('\n');
}

function renderAddressMap(state, foundation) {
  const entries = Object.entries(state?.addressMap?.entries ?? {});
  if (entries.length === 0) return null;
  const name = (id) => foundation.characters.find((c) => c.id === id)?.canonicalName ?? id;
  return entries
    .map(([pair, e]) => {
      const [speaker, target] = pair.split('->');
      return `- ${name(speaker)} → ${name(target)}: "${e.term}" (${e.register ?? '?'}, ${e.sinceChapter}화부터)`;
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
  if (!compiledMemory.ok) throw new Error(`${compiledMemory.error.code}: 필수 정사를 컨텍스트에 넣을 수 없어 장면 분할 또는 재계획이 필요합니다.`);

  const sections = [
    `# ${chapter}화 집필 컨텍스트 — ${workId}`,
    '',
    `장르: ${foundation.genre}${foundation.povMode ? ` · 시점: ${foundation.povMode}` : ''}` +
      `${arcPosition ? ` · 아크 위치: ${ARC_POSITION_LABEL_KO?.[arcPosition] ?? arcPosition}` : ''}`,
    '',
    '## 세계 사실 (변경 불가 — 이 사실과 충돌하면 안 됩니다)',
    foundation.worldFacts.length
      ? foundation.worldFacts.map((f) => `- (${f.id}) ${f.statement}`).join('\n')
      : '- (아직 등록된 세계 사실 없음)',
    '',
    '## 등장인물 (intrinsic 은 고정 — 서사적 사건 없이 바꾸지 마세요)',
    visible.length ? visible.map((c) => renderCharacter(foundation, c, chapter)).join('\n') : '- (아직 등록된 인물 없음)',
  ];

  if (arcEpisode) {
    sections.push('', renderArcEpisode(arcPlan, arcEpisode));
  } else if (arcPlan?.status === 'pending') {
    sections.push('', '## 집필 중단 — 아크 승인 대기', '- lore_arc_decide로 승인하거나 거절한 뒤 집필하세요.');
  } else {
    sections.push('', '## 아크 계획 없음', '- 방향 없는 연속 집필을 막기 위해 lore_arc_plan으로 다음 아크를 먼저 계획하세요.');
  }

  const profileBlock = renderStoryProfile(storyProfile);
  if (profileBlock) sections.push('', profileBlock);
  else if (storyProfile?.status === 'pending') sections.push('', '## StoryProfile 승인 대기', '- 장르·톤·이야기 동력 확정 전에는 새 아크를 계획하지 마세요.');

  const spineBlock = renderStorySpine(storySpine);
  if (spineBlock) sections.push('', spineBlock);
  else sections.push('', '## StorySpine 없음', '- 작품 전체 인과 설계 없이 회차 사건을 만들지 마세요. lore_story_plan을 먼저 실행하세요.');

  const episodeBlock = renderEpisodePlan(episodePlan);
  if (episodeBlock) sections.push('', episodeBlock);
  else if (arcEpisode && episodePlan?.status === 'pending') sections.push('', '## EpisodePlan 승인 대기', '- lore_episode_decide로 승인하거나 거절한 뒤 집필하세요.');
  else if (arcEpisode) sections.push('', '## 상세 EpisodePlan 없음', '- lore_episode_plan으로 현재 아크 비트를 장면 계획으로 확장한 뒤 집필하세요.');

  const characterPacket = renderSceneCharacterPacket({
    projection: published.value?.projections?.characterDynamics,
    cast: episodePlan?.cast ?? [], pressure: episodePlan?.scenePressure?.decisionDeadline ?? '',
  });
  if (characterPacket) sections.push('', characterPacket);

  const address = renderAddressMap(lastState, foundation);
  if (address) sections.push('', '## 호칭 (누가 누구를 어떻게 부르는지 — 바뀌면 이유가 필요합니다)', address);

  if (lastState?.hooks?.length) {
    sections.push('', '## 미해결 떡밥 (독자가 기억하고 있습니다)',
      lastState.hooks.map((h) => {
        const text = h.text || h.id;
        const started = h.plantedAtChapter;
        return `- ${text}${started ? ` (${started}화)` : ''}`;
      }).join('\n'));
  }

  if (entity.injected.length > 0) sections.push('', renderEntityContext(entity));

  if (compiledMemory.value.discretionary.length) {
    sections.push('', '## 오래된 관련 기억 (MemoryCompiler 선택)',
      ...compiledMemory.value.discretionary.map((item) => `- [${item.scope ?? item.kind}:${item.ref ?? item.id}${item.chapter ? ` · ${item.chapter}화` : ''}] ${item.text}`));
  }
  const debts = hookDebt(lastState?.hooks, chapter);
  if (debts.length) sections.push('', '## 복선 부채 (오래 진전되지 않음)', ...debts.map((debt) => `- ${debt.id}: ${debt.staleFor}화 정체 · 이번 화에서 ${debt.action}`));

  sections.push('', renderSlidingWindow(window));

  const context = sections.join('\n');
  const actualTokens = Math.max(1, Math.ceil([...context].length / 2));
  if (actualTokens > MAX_CONTEXT_TOKENS) {
    throw new Error(`context_overflow: 전체 집필 컨텍스트 ${actualTokens} 토큰이 ${MAX_CONTEXT_TOKENS} 토큰 예산을 넘어 장면 분할 또는 재계획이 필요합니다.`);
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
