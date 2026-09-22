import { createHash } from 'node:crypto';

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const list = (value) => Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
const tokenUnits = (value) => Math.max(1, Math.ceil([...String(value ?? '')].length / 2));
const DEFAULT_MAX_TOKENS = 1400;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return typeof value === 'string' ? value.normalize('NFC') : value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

export function compileWriterEpisodePacket({ episodePlan, arcEpisode, characterNames = {}, prevState, readabilityContract, budget = {} } = {}) {
  if (!episodePlan || episodePlan.status !== 'active') {
    return { ok: false, error: { code: 'EPISODE_PLAN_INACTIVE', message: '승인된 EpisodePlan이 필요합니다.' } };
  }
  const maxTokens = Number.isFinite(budget.maxTokens) ? budget.maxTokens : DEFAULT_MAX_TOKENS;
  if (arcEpisode?.chapter !== undefined && Number(arcEpisode.chapter) !== Number(episodePlan.chapter)) {
    return { ok: false, error: { code: 'ARC_EPISODE_MISMATCH', message: 'EpisodePlan과 Arc episode의 회차가 다릅니다.' } };
  }
  const derivedFields = [];
  const derived = (field, direct, fallback, derivedFrom) => {
    const value = clean(direct) || clean(fallback);
    if (!clean(direct) && value) derivedFields.push({ field, derivedFrom });
    return value;
  };
  const scenes = (episodePlan.scenes ?? []).map((scene, index) => ({
    order: Number(scene.order ?? index + 1),
    situation: clean(scene.situation || scene.objective),
    choice: clean(scene.choice || scene.obstacle),
    change: clean(scene.change || scene.turn || scene.outcome),
  }));
  const firstScene = episodePlan.scenes?.[0] ?? {};
  const lastScene = episodePlan.scenes?.at(-1) ?? {};
  const ownerId = derived('scenePressure.choiceOwner', episodePlan.scenePressure?.choiceOwner, episodePlan.povCharacter || episodePlan.cast?.[0], episodePlan.povCharacter ? 'povCharacter' : 'cast.0');
  const owner = (characterNames[ownerId] ?? ownerId) || '선택 주체';
  let goods = list(episodePlan.scenePressure?.incompatibleGoods);
  if (goods.length < 2) {
    goods = [...new Set((episodePlan.scenes ?? []).map((scene) => clean(scene.obstacle || scene.choice)).filter(Boolean))].slice(0, 2);
    if (goods.length) derivedFields.push({ field: 'scenePressure.incompatibleGoods', derivedFrom: 'scenes[].obstacle' });
  }
  const activeQuestion = derived('entryState.activeQuestion', episodePlan.entryState?.activeQuestion, episodePlan.premise, 'premise');
  const immediateWant = derived('entryState.protagonistImmediateWant', episodePlan.entryState?.protagonistImmediateWant, firstScene.objective || firstScene.situation, 'scenes.0.objective');
  const tickingLoss = derived('entryState.tickingLoss', episodePlan.entryState?.tickingLoss, arcEpisode?.conflict || episodePlan.arcBeat?.conflict, arcEpisode?.conflict ? 'arcEpisode.conflict' : 'arcBeat.conflict');
  const payoffPromise = derived('payoff.promisePaid', episodePlan.payoff?.promisePaid, episodePlan.closingState || lastScene.outcome, episodePlan.closingState ? 'closingState' : 'scenes.last.outcome');
  const payoffProof = derived('payoff.proofOnPage', episodePlan.payoff?.proofOnPage, lastScene.outcome || lastScene.change || lastScene.turn, 'scenes.last.outcome');
  const immediateCost = derived('costCreatedByResolution.immediate', episodePlan.costCreatedByResolution?.immediate, episodePlan.arcBeat?.cost || arcEpisode?.cost, episodePlan.arcBeat?.cost ? 'arcBeat.cost' : 'arcEpisode.cost');
  const exitState = derived('exitValue.specificFutureValue', episodePlan.exitValue?.specificFutureValue, episodePlan.closingState || lastScene.outcome, episodePlan.closingState ? 'closingState' : 'scenes.last.outcome');
  const bridgeSituation = immediateWant || activeQuestion;
  const readerBridge = derived('readerBridge', episodePlan.readerBridge,
    [bridgeSituation, tickingLoss ? `실패 시 손실: ${tickingLoss}` : '', `결과 증거: ${payoffProof || payoffPromise}`].filter(Boolean).join(' / '),
    'entryState+payoff');
  const foreground = new Set(list(episodePlan.foregroundCharacters).length
    ? list(episodePlan.foregroundCharacters)
    : [ownerId].filter(Boolean));
  const relationshipResidue = (prevState?.relationships ?? []).filter((item) => foreground.has(clean(item.to)))
    .slice(-4).map((item) => ({ to: clean(item.to), kind: clean(item.kind), state: clean(item.state) }));
  const arcResidue = Object.entries(prevState?.arcCursor ?? {}).filter(([characterId]) => foreground.has(characterId))
    .slice(-2).map(([characterId, value]) => ({ characterId, beat: clean(value?.beat), note: clean(value?.note) }));
  const includedFields = [
    'premise', 'openingState', 'closingState', 'entryState.activeQuestion', 'entryState.protagonistImmediateWant', 'entryState.tickingLoss',
    'scenePressure.choiceOwner',
    ...scenes.flatMap((_, index) => [`scenes.${index}.situation`, `scenes.${index}.choice`, `scenes.${index}.change`]),
    'payoff.promisePaid', 'payoff.proofOnPage', 'costCreatedByResolution.immediate', 'costCreatedByResolution.deferred',
    'exitValue.closedQuestion', 'exitValue.nextQuestion', 'exitValue.specificFutureValue', 'readerBridge', 'reveals', 'withheld',
    ...(episodePlan.characterArcBeats?.length ? ['characterArcBeats'] : []),
    ...(episodePlan.episodeVoiceTargets?.length ? ['episodeVoiceTargets'] : []),
    ...(relationshipResidue.length || arcResidue.length ? ['prevState.characterResidue'] : []),
  ];
  const obligations = {
    arcCurrent: arcEpisode ? { goal: clean(arcEpisode.goal || arcEpisode.beat), pressure: clean(arcEpisode.conflict || arcEpisode.pressure), cost: clean(arcEpisode.cost), hook: clean(arcEpisode.hook || arcEpisode.carry) } : null,
    entry: { premise: clean(episodePlan.premise), openingState: clean(episodePlan.openingState), activeQuestion, want: immediateWant, tickingLoss },
    pressure: { choiceOwner: ownerId, incompatibleGoods: goods, deadline: clean(episodePlan.scenePressure?.decisionDeadline) },
    causalTurns: scenes,
    payoff: { promise: payoffPromise, proof: payoffProof },
    cost: { immediate: immediateCost, deferred: clean(episodePlan.costCreatedByResolution?.deferred), payer: clean(episodePlan.costCreatedByResolution?.payer) },
    exit: { closedQuestion: clean(episodePlan.exitValue?.closedQuestion), nextQuestion: clean(episodePlan.exitValue?.nextQuestion), state: exitState },
    readerBridge,
    readerLoad: {
      phase: clean(episodePlan.readerLoad?.phase || arcEpisode?.readerLoad?.phase || 'expansion'),
      newConcepts: list(episodePlan.readerLoad?.newConcepts),
      complexityReason: clean(episodePlan.readerLoad?.complexityReason || arcEpisode?.readerLoad?.complexityReason),
      surfaceEase: clean(readabilityContract?.surfaceEase || 'easy'),
      inferenceLoad: clean(readabilityContract?.inferenceLoad || 'explicit'),
    },
    foregroundCharacters: [...foreground],
    characterMemory: { relationships: relationshipResidue, arc: arcResidue },
    knowledgeGuards: { reveal: list(episodePlan.reveals), withhold: list(episodePlan.withheld) },
    characterChanges: (episodePlan.characterArcBeats ?? []).map((item) => ({ characterId: clean(item.characterId), beat: clean(item.beat), note: clean(item.note) })).filter((item) => item.characterId && item.beat),
    voiceTargets: (episodePlan.episodeVoiceTargets ?? []).map((item) => ({
      characterId: clean(item.characterId),
      sceneOrder: Number.isFinite(Number(item.sceneOrder)) ? Number(item.sceneOrder) : null,
      pressure: clean(item.speakingPressure),
      surfaceIntent: clean(item.surfaceIntent),
      hiddenIntent: clean(item.hiddenIntent),
      sampleLine: clean(item.sampleLine),
      narrationFilter: clean(item.narrationFilter),
    })).filter((item) => foreground.has(item.characterId) && (item.sampleLine || item.pressure)),
  };
  const missing = [];
  if (!obligations.entry.premise) missing.push('premise');
  if (scenes.length < 2) missing.push('scenes[2+]');
  scenes.forEach((scene, index) => {
    if (!scene.situation) missing.push(`scenes.${index}.situation`);
    if (!scene.choice) missing.push(`scenes.${index}.choice`);
    if (!scene.change) missing.push(`scenes.${index}.change`);
  });
  if (!obligations.payoff.promise || !obligations.payoff.proof) missing.push('payoff');
  if (!obligations.exit.state) missing.push('exit');
  if (missing.length) {
    return { ok: false, error: { code: 'MANDATORY_EPISODE_FIELD_MISSING', message: 'Writer Episode Packet으로 복원할 수 없는 필수 의무가 있습니다.', missing: [...new Set(missing)] } };
  }
  const mergedFields = [];
  let renderedExitState = obligations.exit.state;
  if (renderedExitState && renderedExitState === obligations.payoff.promise) {
    mergedFields.push({ field: 'exitValue.specificFutureValue', mergedInto: 'payoff.promisePaid' });
    renderedExitState = '위 지급 결과가 종료 상태로 확정됨';
  }
  // A plan that answers "what state do we exit in" with the next question
  // verbatim would print the same sentence twice and spend packet budget on it.
  const exitLine = renderedExitState && renderedExitState === obligations.exit.nextQuestion
    ? (mergedFields.push({ field: 'exitValue.specificFutureValue', mergedInto: 'exitValue.nextQuestion' }), renderedExitState)
    : `${renderedExitState} / ${obligations.exit.nextQuestion}`;
  // Residue from the previous chapter that names the same beat this episode
  // carries is already covered by the "이번 화 변화" line.
  const carriedResidue = arcResidue.filter((item) => !obligations.characterChanges.some((change) => change.characterId === item.characterId && change.beat === item.beat));
  const protectedTruths = [
    ...(obligations.knowledgeGuards.withhold.length
      ? obligations.knowledgeGuards.withhold.map((item) => `아직 숨김: ${item}`)
      : []),
    obligations.payoff.proof ? `결과는 설명이 아니라 화면 증거로 확인되어야 함: ${obligations.payoff.proof}` : '',
  ].filter(Boolean);
  const characterCarry = [
    ...obligations.characterChanges
      .filter((item) => foreground.has(item.characterId))
      .map((item) => `${characterNames[item.characterId] ?? item.characterId}: 이번 화 변화=${item.beat}${item.note ? ` — ${item.note}` : ''}`),
    ...relationshipResidue.map((item) => `${characterNames[item.to] ?? item.to}: ${item.kind} — ${item.state}`),
    ...carriedResidue.map((item) => `${characterNames[item.characterId] ?? item.characterId}: ${item.beat}${item.note ? ` — ${item.note}` : ''}`),
  ];
  const discoverySpace = [
    '장면 순서와 해결 장소',
    '정확한 대사와 미세 행동',
    '인물이 선택을 결심하는 순간의 감각과 오판',
    '마지막 이미지와 다음 질문의 표현 방식',
    '의무를 바꾸지 않는 현장 디테일',
  ];
  const hardBeatLines = [];
  if (scenes.length <= 2) {
    hardBeatLines.push(...scenes.map((scene) => `- ${scene.situation} → ${scene.choice} → ${scene.change}`));
  }
  else {
    hardBeatLines.push(`- 시작 압력: ${scenes[0].situation}`);
    hardBeatLines.push(`- 도착 전환: ${lastScene.change || obligations.payoff.promise}`);
  }
  const writerText = [
    '## Reader Contract',
    `- 전문 설정을 몰라도 붙잡을 즉시 상황과 결과: ${obligations.readerBridge}`,
    `- 읽기 난도: ${obligations.readerLoad.surfaceEase} / 추론 부담=${obligations.readerLoad.inferenceLoad} / 단계=${obligations.readerLoad.phase}`,
    obligations.readerLoad.newConcepts.length ? `- 이번 화의 새 핵심 개념: ${obligations.readerLoad.newConcepts.join(', ')}` : '- 이번 화는 새 핵심 개념을 의무적으로 추가하지 않는다.',
    '- 대사는 독자가 먼저 본 구체적 상황과 욕구 위에서 시작한다. 표면 뜻을 이해한 뒤에만 서브텍스트를 남긴다.',
    '', '## Episode Core',
    `- 즉시 목표: ${owner} — ${obligations.entry.want || obligations.entry.activeQuestion}`,
    `- 눈앞의 장애물: ${obligations.entry.tickingLoss || obligations.arcCurrent?.pressure || scenes[0]?.situation}`,
    goods.length >= 2 ? `- 실제 선택 압박: ${goods[0]} / ${goods[1]}` : '',
    `- 지급할 결과: ${obligations.payoff.promise}`,
    obligations.cost.immediate || obligations.cost.deferred ? `- 남는 비용: ${obligations.cost.immediate || obligations.cost.deferred}` : '',
    `- 마지막 상태와 다음 질문: ${exitLine}`,
    ...(characterCarry.length ? ['', '## Character Carry', ...characterCarry.map((item) => `- ${item}`), '- 이전 관계를 설명하지 말고 현재 말투·거리·망설임 중 필요한 한 곳에만 반영한다.'] : []),
    ...(protectedTruths.length ? ['', '## Protected Truths', ...protectedTruths.map((item) => `- ${item}`)] : []),
    ...(obligations.voiceTargets.length ? [
      '', '## Voice Targets',
      ...obligations.voiceTargets.map((item) => `- ${characterNames[item.characterId] ?? item.characterId}${item.sceneOrder ? `@${item.sceneOrder}` : ''}: 압력=${item.pressure || '없음'} / 겉목적=${item.surfaceIntent || '없음'} / 숨은목적=${item.hiddenIntent || '없음'} / 예시="${item.sampleLine || '없음'}" / 서술필터=${item.narrationFilter || '없음'}`),
      '- 예시는 복붙하거나 모두 소화할 체크리스트가 아니다. 해당 인물이 장면 압력을 실제로 받을 때만 말투와 목적을 새 대사로 재현한다.',
    ] : []),
    '', '## Minimal Beats',
    ...hardBeatLines,
    '', '## Writer Freedom',
    ...discoverySpace.map((item) => `- ${item}`),
    '- 전면 인물이 아닌 등장인물은 논점을 증명할 필요가 없고, 평범하게 반응하거나 침묵할 수 있다.',
    '- 위 목적지를 향해 가되 장면 순서·해결 방식·대사 결은 본문 안에서 발견한다.',
  ].filter((line) => line !== '').join('\n');
  const usedTokens = tokenUnits(writerText);
  if (usedTokens > maxTokens) {
    return { ok: false, error: { code: 'EPISODE_PACKET_OVERFLOW', message: '필수 EpisodePlan 의무가 Writer Packet 예산을 초과합니다.', requiredTokens: usedTokens, maxTokens, recovery: 'split_episode_or_reduce_plan' } };
  }
  return {
    ok: true,
    value: {
      writerText, obligations, freedoms: discoverySpace,
      trace: { sourcePlanRevision: episodePlan.revision ?? null, sourcePlanHash: digest(episodePlan), includedFields, derivedFields, mergedFields, omittedFields: ['workId', 'status', 'revision', 'createdAt'], obligationHash: digest(obligations) },
      usage: { usedTokens, maxTokens },
    },
  };
}
