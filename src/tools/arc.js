import { arcPositionFromRatio } from '../../engine/src/core/arc-context.js';
import { CHARACTER_ARC_BEATS } from '../../engine/src/continuity/character-arc.js';
import { compileBriefWithProfile } from './story-profile.js';
import { deterministicArcViolations, runArcQuality } from './arc-quality.js';
import { renderStorySpine } from './story-spine.js';
import { MCP_CONTRACT_VERSION, runtimeVersion } from '../core/runtime-version.js';
import { createPublicationUnit } from '../core/publication-unit.js';
import { openCanonRepository } from '../core/canon-repository.js';
import { compileCharacterArcSeeds, renderCharacterArcSeeds } from '../core/character-arc-seeds.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

function defaultReaderLoadPhase({ index, count, arcNumber, complexityRamp }) {
  if (complexityRamp === 'dense-start') return 'expansion';
  if (complexityRamp === 'steady' || arcNumber > 1) return 'expansion';
  return index < Math.max(2, Math.ceil(count / 3)) ? 'onboarding' : 'expansion';
}

function normalizeEpisode(item, index, startChapter, readerLoadDefaults) {
  const obj = item && typeof item === 'object' ? item : {};
  const beat = String(obj.beat ?? obj.goal ?? '').slice(0, 500);
  const pressure = String(obj.pressure ?? obj.conflict ?? '').slice(0, 500);
  const requestedPhase = String(obj.readerLoad?.phase ?? obj.readabilityPhase ?? '');
  const fallbackPhase = defaultReaderLoadPhase({ index, ...readerLoadDefaults });
  const phase = fallbackPhase === 'onboarding'
    ? 'onboarding'
    : ['onboarding', 'expansion', 'focus'].includes(requestedPhase)
    && (requestedPhase !== 'focus' || String(obj.readerLoad?.complexityReason ?? '').trim())
    ? requestedPhase
    : fallbackPhase;
  return {
    index: index + 1,
    chapter: startChapter + index,
    title: String(obj.title ?? `${index + 1}화 비트`).slice(0, 120),
    beat, pressure, turn: String(obj.turn ?? '').slice(0, 500), carry: String(obj.carry ?? '').slice(0, 500),
    readerExpectation: String(obj.readerExpectation ?? '').slice(0, 500),
    payoff: String(obj.payoff ?? '').slice(0, 500),
    costCreatedByResolution: String(obj.costCreatedByResolution ?? obj.cost ?? '').slice(0, 500),
    exitValue: String(obj.exitValue ?? obj.hook ?? obj.carry ?? '').slice(0, 500),
    // Legacy aliases remain readable while callers migrate to the thinner beat.
    goal: beat,
    conflict: pressure,
    growth: String(obj.growth ?? '').slice(0, 500),
    cost: String(obj.cost ?? '').slice(0, 500),
    hook: String(obj.hook ?? '').slice(0, 500),
    readerLoad: {
      phase,
      newConcept: String(obj.readerLoad?.newConcept ?? '').trim().slice(0, 200),
      complexityReason: String(obj.readerLoad?.complexityReason ?? '').trim().slice(0, 300),
    },
    status: 'pending',
  };
}

const short = (value, max = 800) => String(value ?? '').trim().slice(0, max);
const shortList = (value, max = 12) => Array.isArray(value)
  ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, 500)).slice(0, max)
  : [];

function normalizeCommercialArc(obj, foundation) {
  const known = new Set(foundation.characters.map((c) => c.id));
  return {
    commercialPromise: {
      fantasy: short(obj.commercialPromise?.fantasy || obj.promise),
      humanComplication: short(obj.commercialPromise?.humanComplication),
      repeatableProof: short(obj.commercialPromise?.repeatableProof),
    },
    readerContract: {
      openingQuestion: short(obj.readerContract?.openingQuestion),
      expectedPath: short(obj.readerContract?.expectedPath),
      promisedPayoffBy: Number(obj.readerContract?.promisedPayoffBy) || null,
      minimumPayoff: short(obj.readerContract?.minimumPayoff || obj.promise),
    },
    characterPressureMatrix: (Array.isArray(obj.characterPressureMatrix) ? obj.characterPressureMatrix : []).flatMap((row) => {
      const characterId = short(row?.characterId, 120);
      return known.has(characterId) ? [{ characterId, visibleWant: short(row.visibleWant), privateNeed: short(row.privateNeed), protectedSecret: short(row.protectedSecret), lineTheyWillNotCross: short(row.lineTheyWillNotCross), pressureThatMayBreakIt: short(row.pressureThatMayBreakIt) }] : [];
    }).slice(0, 8),
    misconceptionStack: (Array.isArray(obj.misconceptionStack) ? obj.misconceptionStack : []).map((item, index) => ({
      id: short(item?.id || `misconception_${index + 1}`, 120), readerBelief: short(item?.readerBelief), characterBelief: short(item?.characterBelief),
      hiddenCausality: short(item?.hiddenCausality), evidenceToPlant: shortList(item?.evidenceToPlant, 6), revealPolicy: short(item?.revealPolicy),
    })).slice(0, 6),
    escalatingCosts: shortList(obj.escalatingCosts),
    oppositionAgency: {
      actor: short(obj.oppositionAgency?.actor), independentGoal: short(obj.oppositionAgency?.independentGoal),
      knowledge: short(obj.oppositionAgency?.knowledge), adaptationTrigger: short(obj.oppositionAgency?.adaptationTrigger),
    },
    openOutcomeSpace: {
      mustResolve: shortList(obj.openOutcomeSpace?.mustResolve), mayResolve: shortList(obj.openOutcomeSpace?.mayResolve),
      mustRemainCostly: shortList(obj.openOutcomeSpace?.mustRemainCostly),
    },
  };
}

function normalizeArcVoiceShifts(value, foundation) {
  const known = new Set(foundation.characters.map((c) => c.id));
  return (Array.isArray(value) ? value : []).flatMap((raw) => {
    const characterId = short(raw?.characterId, 120);
    if (!known.has(characterId)) return [];
    return [{
      characterId,
      startingVoice: short(raw.startingVoice),
      pressureVoice: short(raw.pressureVoice),
      changedVoice: short(raw.changedVoice),
      sampleBefore: short(raw.sampleBefore, 500),
      sampleAfter: short(raw.sampleAfter, 500),
    }];
  }).slice(0, 8);
}

function normalizeCharacterArcs(value, foundation, count, seeds = []) {
  const known = new Set(foundation.characters.map((c) => c.id));
  const seedByCharacter = new Map(seeds.map((seed) => [seed.characterId, seed]));
  return (Array.isArray(value) ? value : []).slice(0, 2).flatMap((raw) => {
    const characterId = String(raw?.characterId ?? '');
    if (!known.has(characterId)) return [];
    const requested = (Array.isArray(raw?.beats) ? raw.beats : []).flatMap((item) => {
      const episodeIndex = Number(item?.episodeIndex);
      const beat = String(item?.beat ?? '');
      if (!Number.isInteger(episodeIndex) || episodeIndex < 1 || episodeIndex > count || !CHARACTER_ARC_BEATS.includes(beat)) return [];
      return [{ episodeIndex, beat, note: String(item?.note ?? '').slice(0, 500) }];
    }).sort((a, b) => a.episodeIndex - b.episodeIndex);
    const beats = requested.filter((item, index) => index === 0 || item.episodeIndex > requested[index - 1].episodeIndex);
    const seed = seedByCharacter.get(characterId);
    return [{
      characterId, promise: String(raw?.promise ?? '').slice(0, 600), beats,
      ...(seed ? {
        inheritedState: {
          status: seed.status,
          unresolvedPressure: seed.unresolvedPressure,
          previousPromise: seed.previousArc?.promise ?? '',
          previousBeat: seed.previousArc?.lastBeat ?? null,
        },
        sourceEvidence: seed.evidence,
      } : {}),
    }];
  });
}

async function loadCharacterDynamics(store, workId) {
  if (typeof store.loadCharacterDynamics === 'function') return store.loadCharacterDynamics(workId);
  if (!store.rootDir) return null;
  const canonical = await openCanonRepository({
    store, publicationUnit: createPublicationUnit({ rootDir: store.rootDir }),
  });
  return typeof canonical.loadCharacterDynamics === 'function'
    ? canonical.loadCharacterDynamics(workId)
    : null;
}

export function characterArcBeatsForEpisode(plan, episodeIndex) {
  return (plan?.characterArcs ?? []).flatMap((arc) => arc.beats
    .filter((beat) => beat.episodeIndex === episodeIndex)
    .map((beat) => ({ characterId: arc.characterId, promise: arc.promise, beat: beat.beat, note: beat.note })));
}

export function episodeForChapter(plan, chapter) {
  if (!plan || plan.status !== 'active') return null;
  return plan.episodes.find((episode) => episode.chapter === chapter) ?? null;
}

export async function runArcPlan({ store, workId, mode = 'review', episodes = 8, direction = '', feedback = '', providers }) {
  const foundation = await store.loadFoundation(workId);
  if (!foundation) throw new Error('작품이 없습니다.');
  const chapters = await store.listChapters();
  const startChapter = (chapters.at(-1) ?? 0) + 1;
  const previous = await store.loadArcPlan(workId);
  const arcNumber = Number(previous?.arcNumber ?? 0) + (previous?.status === 'pending' ? 0 : 1);
  const previousFinalChapter = previous?.episodes?.at(-1)?.chapter;
  const previousArcReview = previous?.status === 'completed' && previousFinalChapter
    ? await store.loadArcReview(workId, previous.arcNumber, previousFinalChapter)
    : null;
  const count = Math.max(3, Math.min(Number(episodes) || 8, 20));
  const summaries = await store.loadRecentChapterSummaries(workId, startChapter, 10);
  const storyProfile = await store.loadStoryProfile(workId);
  if (storyProfile && storyProfile.status !== 'active') throw new Error('StoryProfile 승인 후 아크를 계획하세요.');
  const storySpine = await store.loadStorySpine(workId);
  if (!storySpine || storySpine.status !== 'active') throw new Error('승인된 StorySpine을 먼저 만들고 승인하세요.');
  const writerSkill = await store.loadWriterSkill(workId);
  if (!writerSkill || writerSkill.status !== 'active') throw new Error('승인된 WriterSkill을 먼저 만들고 승인하세요.');
  const profileDirection = compileBriefWithProfile(direction || foundation.brief || '', storyProfile, 'arc');
  const characterArcSeeds = compileCharacterArcSeeds({
    foundation,
    projection: await loadCharacterDynamics(store, workId),
    previousArcPlan: previous,
    previousArcReview,
  });
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'arc-plan',
    messages: [
      { role: 'system', content: '당신은 한국 상업 웹소설의 아크 설계자다. 결말 사건과 교훈을 미리 봉인하지 말고, 독자가 세울 가설·인물의 사적 욕망·해결이 낳는 비용·상대의 독립적 적응을 설계한다. 모든 인물을 매 화 충돌시키지 말고 중심 인물만 전면에 둔다. 각 화는 이전 화의 결과에서 시작하고 작품이 약속한 경험의 준비와 실제 지급을 구분한다. 그 경험을 인물이 실제로 누릴 사건과 시점을 아크에 배치하며, 의도적인 지연이면 이유와 지급 시점을 남긴다. 모든 화에 같은 웃음·손실·보상을 강제하지 않는다. 같은 훅을 반복하지 않는다. 인물 감정 비트는 회차별 체크리스트가 아니다. 실제 압력·선택·상대 반응이 본문에 나타날 회차에만 기록하고, 변화 근거가 없는 회차는 생략하거나 같은 단계를 유지한다. 짧은 아크라는 이유로 wound → attempt → collapse → companion → self-choice → echo를 끝까지 소진하지 않는다. 다음 단계로 갈 때는 note에 독자가 보게 될 행동 근거를 적는다. 누적 인물 서사 후보는 의무 목록이 아니다. 현재 사건과 자연스럽게 충돌하는 인물만 최대 2명 활성화하고, 활성화할 때는 제시된 과거 근거에서 압력과 선택을 발전시킨다. 과거 아크가 resolved면 같은 질문을 되풀이하지 않고, complicated나 dormant면 남은 압력을 새 사건에서 변형한다. 근거가 없는 과거사나 상처를 새로 발명하지 않는다. 회차 비트는 사건·압력·전환·다음 상태만 얇게 고정하고 득점자·승패·정답 행동처럼 집필 중 선택해야 할 결과는 openOutcomeSpace에 남긴다. readerLoad.phase는 onboarding이면 즉시 목표와 낯선 핵심 개념 하나만, expansion이면 이미 체험한 개념의 조합, focus이면 이전에 소개된 특정 개념 하나를 집중해서 다룬다. focus는 복잡해야 할 장면상 이유가 있을 때만 쓴다. 첫 아크에서 complexityRamp가 onboarding-first면 초반을 쉽게 시작한다. 순수 JSON만 출력한다.' },
      { role: 'user', content: [
        `작품: ${foundation.title ?? workId}`, `장르: ${foundation.genre}`, `새 아크 번호: ${arcNumber}`,
        `시작 화: ${startChapter}`, `총 화수: ${count}`, `사용자 방향과 StoryProfile: ${profileDirection || '(자율 설계)'}`, '', renderStorySpine(storySpine),
        `수정 피드백: ${feedback || '(없음)'}`, '', '세계 사실:', ...foundation.worldFacts.map((f) => `- ${f.statement}`),
        '', '주요 인물:', ...foundation.characters.map((c) => `- ${c.id}/${c.canonicalName}: ${c.contradiction ?? ''}`),
        '', '누적 인물 서사 후보(정사 관찰에서 뽑은 선택적 기획 근거):', renderCharacterArcSeeds(characterArcSeeds),
        '', '최근 요약:', ...summaries.reverse().map((s) => `- ${s.summary}`), '',
        '이전 아크 편집 리뷰(관찰 근거이며 강제 규칙이 아님):',
        previousArcReview ? JSON.stringify({
          dimensions: previousArcReview.dimensions,
          findings: previousArcReview.findings?.map(({ dimension, code, message }) => ({ dimension, code, message })),
        }) : '(없음)',
        '리뷰의 낮은 축은 새 아크의 사건 기능·보상·감정 온도·증거·결말 이미지를 달리해 대응하되, 이전 장면의 표면 해법이나 특정 문구를 복제하지 않는다.', '',
        `정확히 ${count}개의 episodes를 만들 것. JSON 스키마:`,
        '{"title":"아크 제목","promise":"끝에서 갚을 변화","type":"small|standard|volume","commercialPromise":{"fantasy":"반복 장르 쾌감","humanComplication":"사람 때문에 해법이 어긋나는 방식","repeatableProof":"훈련/행동이 뒤에서 변주되어 증명되는 방식"},"readerContract":{"openingQuestion":"독자가 붙들 질문","expectedPath":"독자가 예상할 경로","promisedPayoffBy":5,"minimumPayoff":"반드시 지급할 보상"},"characterPressureMatrix":[{"characterId":"아크 전체에서 압력을 받는 핵심 인물만","visibleWant":"","privateNeed":"","protectedSecret":"","lineTheyWillNotCross":"","pressureThatMayBreakIt":""}],"misconceptionStack":[{"id":"실제 반전이 있는 경우만","readerBelief":"","characterBelief":"","hiddenCausality":"","evidenceToPlant":["본문 단서"],"revealPolicy":"단서 의미를 어떻게 바꿀지"}],"escalatingCosts":["해결이 낳는 다음 비용"],"oppositionAgency":{"actor":"","independentGoal":"","knowledge":"","adaptationTrigger":""},"openOutcomeSpace":{"mustResolve":[""],"mayResolve":["승패·득점자 등"],"mustRemainCostly":[""]},"arcVoiceShifts":[{"characterId":"아크에서 실제 말투 변화가 있는 인물만","startingVoice":"","pressureVoice":"","changedVoice":"","sampleBefore":"","sampleAfter":""}],"characterArcs":[{"characterId":"최대 2명, 실제 변화가 있는 경우만","promise":"내적 변화","beats":[{"episodeIndex":1,"beat":"wound|attempt|collapse|companion|self-choice|echo","note":"단계명이 아니라 독자가 보게 될 압력·선택·반응"}]}],"episodes":[{"title":"가제","beat":"핵심 사건","pressure":"선택 압력","readerExpectation":"이번 화 예상","payoff":"작은 지급","turn":"선택이 만든 전환","costCreatedByResolution":"해결 비용 또는 빈 문자열","carry":"다음 상태","exitValue":"다음 화의 구체적 가치","readerLoad":{"phase":"onboarding|expansion|focus","newConcept":"이번 화의 낯선 핵심 개념 하나 또는 빈 문자열","complexityReason":"focus일 때만 복잡해야 하는 이유"}}]}',
      ].join('\n') },
    ],
  });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true };
  const obj = parse(response.text);
  if (!obj || !Array.isArray(obj.episodes) || obj.episodes.length !== count) throw new Error(`arc-plan 응답은 정확히 ${count}개 episodes여야 합니다.`);
  const plan = {
    workId, arcPlanSchemaVersion: 2, characterArcSeedVersion: 1, contractVersion: MCP_CONTRACT_VERSION,
    arcNumber, title: String(obj.title ?? '').slice(0, 200), promise: String(obj.promise ?? '').slice(0, 600),
    type: ['small', 'standard', 'volume'].includes(obj.type) ? obj.type : 'standard',
    storySpineNodes: shortList(obj.storySpineNodes, 8).length
      ? shortList(obj.storySpineNodes, 8)
      : storySpine.causalChain.slice(Math.max(0, arcNumber - 1), Math.max(1, arcNumber)),
    startChapter, estimatedEpisodes: count, status: mode === 'auto' ? 'active' : 'pending',
    episodes: obj.episodes.map((item, index) => normalizeEpisode(item, index, startChapter, {
      count,
      arcNumber,
      complexityRamp: storyProfile?.readabilityContract?.complexityRamp ?? 'onboarding-first',
    })),
    characterArcs: normalizeCharacterArcs(obj.characterArcs, foundation, count, characterArcSeeds),
    arcVoiceShifts: normalizeArcVoiceShifts(obj.arcVoiceShifts, foundation),
    ...normalizeCommercialArc(obj, foundation),
  };
  if (!plan.title || !plan.promise) throw new Error('arc-plan에 title과 promise가 필요합니다.');
  if (!plan.storySpineNodes.length) throw new Error('아크는 전진시킬 StorySpine 노드를 최소 하나 참조해야 합니다.');
  const structuralViolations = deterministicArcViolations(plan);
  if (structuralViolations.length) throw new Error(`아크 품질 검증 실패: ${structuralViolations.map((item) => item.message).join(' ')}`);
  const quality = await runArcQuality({ foundation, plan, providers });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true, operation: 'arc-quality' };
  if (quality.verdict !== 'passed') throw new Error(`아크 품질 검증 실패: ${quality.findings.map((item) => item.message).join(' ') || `총점 ${quality.score}, 취약 차원 ${quality.weakDimensions.join(', ')}`}`);
  plan.quality = quality;
  plan.createdAt = new Date().toISOString();
  await store.saveArcPlan(workId, plan);
  return {
    plan,
    ...(plan.status === 'pending'
      ? { needsApproval: true, instruction: '이 계획을 사용자에게 보여주고 마음에 드는지 물으세요. 승인 전에는 집필하지 마세요.' }
      : { needsApproval: false, instruction: '자동 승인되었습니다. 첫 회차부터 집필할 수 있습니다.' }),
  };
}

export async function runArcDecide({ store, workId, action }) {
  const plan = await store.loadArcPlan(workId);
  if (!plan) throw new Error('검토할 아크 계획이 없습니다.');
  if (action === 'approve') {
    const active = { ...plan, status: 'active', approvedAt: new Date().toISOString() };
    await store.saveArcPlan(workId, active);
    return { approved: true, plan: active };
  }
  if (action === 'reject') {
    const rejected = { ...plan, status: 'rejected', rejectedAt: new Date().toISOString() };
    await store.saveArcPlan(workId, rejected);
    return { approved: false, plan: rejected, instruction: '피드백과 함께 lore_arc_plan을 다시 호출하세요.' };
  }
  throw new Error('action은 approve 또는 reject여야 합니다.');
}

export async function runArcStatus({ store, workId }) {
  const plan = await store.loadArcPlan(workId);
  if (!plan) return { planned: false, runtime: runtimeVersion() };
  const chapters = await store.listChapters();
  const nextChapter = (chapters.at(-1) ?? 0) + 1;
  return { planned: true, plan, nextChapter, currentEpisode: episodeForChapter(plan, nextChapter), runtime: runtimeVersion() };
}

export async function advanceArcAfterCommit({ store, workId, chapter }) {
  const plan = await store.loadArcPlan(workId);
  if (!plan || plan.status !== 'active') return null;
  const episodes = plan.episodes.map((episode) => episode.chapter === chapter ? { ...episode, status: 'completed' } : episode);
  const completed = episodes.every((episode) => episode.status === 'completed');
  const next = { ...plan, episodes, status: completed ? 'completed' : 'active', ...(completed ? { completedAt: new Date().toISOString() } : {}) };
  await store.saveArcPlan(workId, next);
  return { arcNumber: next.arcNumber, status: next.status, completedEpisode: chapter, nextEpisode: episodeForChapter(next, chapter + 1) };
}

export function renderArcEpisode(plan, episode) {
  const position = arcPositionFromRatio(episode.index, plan.estimatedEpisodes);
  return [
    `## 승인된 아크 계획 — Arc ${plan.arcNumber} 「${plan.title}」`,
    `- 아크 약속: ${plan.promise}`, `- 진행: ${episode.index}/${plan.estimatedEpisodes} · ${position}`,
    `- 이번 화 가제: ${episode.title}`, `- 핵심 사건: ${episode.beat ?? episode.goal}`,
    `- 독자 난도 단계: ${episode.readerLoad?.phase ?? 'expansion'}${episode.readerLoad?.newConcept ? ` / 새 핵심 개념=${episode.readerLoad.newConcept}` : ''}`,
    episode.pressure || episode.conflict ? `- 압력: ${episode.pressure ?? episode.conflict}` : '',
    episode.turn ? `- 전환: ${episode.turn}` : '', episode.carry ? `- 다음 상태: ${episode.carry}` : '',
    episode.growth ? `- 아크상 성장 단서: ${episode.growth}` : '', episode.cost ? `- 아크상 대가: ${episode.cost}` : '',
    episode.hook ? `- 끝 연결: ${episode.hook}` : '',
    '- 위 비트는 방향 제약이다. 장면 표현은 자유지만 다음 화의 비트를 미리 소모하지 않는다.',
  ].filter(Boolean).join('\n');
}

/** Complete causal map for the writer; current-beat-only context cannot seed later payoffs. */
export function renderArcMap(plan, currentChapter) {
  if (!plan || plan.status !== 'active') return '';
  return [
    `## 전체 활성 아크 지도 — Arc ${plan.arcNumber} 「${plan.title}」`,
    `- 아크 약속: ${plan.promise}`,
    plan.commercialPromise?.fantasy ? `- 반복 쾌감: ${plan.commercialPromise.fantasy} / 인간 변수: ${plan.commercialPromise.humanComplication}` : '',
    plan.readerContract?.openingQuestion ? `- 독자 계약: ${plan.readerContract.openingQuestion} → ${plan.readerContract.minimumPayoff}` : '',
    plan.oppositionAgency?.actor ? `- 상대의 독립 행동: ${plan.oppositionAgency.actor} / 목표=${plan.oppositionAgency.independentGoal} / 적응 조건=${plan.oppositionAgency.adaptationTrigger}` : '',
    plan.escalatingCosts?.length ? `- 누적 비용: ${plan.escalatingCosts.join(' → ')}` : '',
    ...plan.episodes.map((episode) => [
      `- ${episode.chapter === currentChapter ? '▶' : ' '} ${episode.index}/${plan.estimatedEpisodes}화 「${episode.title}」`,
      `사건=${episode.beat ?? episode.goal ?? ''}`,
      episode.pressure || episode.conflict ? `압력=${episode.pressure ?? episode.conflict}` : '',
      episode.turn ? `전환=${episode.turn}` : '',
      episode.readerExpectation ? `독자 예상=${episode.readerExpectation}` : '',
      episode.payoff ? `지급=${episode.payoff}` : '',
      episode.costCreatedByResolution ? `해결 비용=${episode.costCreatedByResolution}` : '',
      episode.carry || episode.hook ? `전달=${episode.carry ?? episode.hook}` : '',
      episode.exitValue ? `다음 가치=${episode.exitValue}` : '',
    ].filter(Boolean).join(' / ')),
    ...(plan.characterArcs?.length ? [
      '- 인물 감정 곡선:',
      ...plan.characterArcs.map((arc) => `  - ${arc.characterId}: ${arc.promise} / ${arc.beats.map((b) => `${b.episodeIndex}화=${b.beat}(${b.note})`).join(' → ')}`),
    ] : []),
    ...(plan.arcVoiceShifts?.length ? [
      '- 아크 말투 변화:',
      ...plan.arcVoiceShifts.map((row) => `  - ${row.characterId}: ${row.startingVoice} → ${row.pressureVoice} → ${row.changedVoice} / 예시=${[row.sampleBefore, row.sampleAfter].filter(Boolean).join(' / ')}`),
    ] : []),
    '- 현재 화 이후 비트는 복선과 축적에만 참고하고, 사건 자체를 미리 소모하지 않는다.',
  ].filter(Boolean).join('\n');
}
