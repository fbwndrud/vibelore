import { createHash } from 'node:crypto';

const clean = (value, limit = 600) => String(value ?? '').trim().slice(0, limit);
const strings = (value, limit = 6) => Array.isArray(value)
  ? value.map((item) => clean(item, 300)).filter(Boolean).slice(0, limit)
  : [];
const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

export function compileNarrativeContract({ profile, identity, writerSkill }) {
  const voiceRecipe = profile?.voiceContract?.genreVoiceRecipe ?? {};
  const contract = {
    schemaVersion: 2,
    readerPromise: clean(identity?.readerPromise || profile?.narrativeContract?.readerPromise || profile?.storyEngines?.[0]),
    recurringPleasures: strings(identity?.competenceSignature?.length ? identity.competenceSignature : profile?.storyEngines),
    protagonistAppeal: clean(identity?.protagonistAppeal),
    emotionalDefect: clean(identity?.emotionalDefect),
    narration: {
      pov: clean(profile?.format?.pov),
      depth: clean(profile?.povDesign?.narrativeDistance || profile?.depthMode),
      tones: strings(profile?.tones, 4),
    },
    characterExpression: {
      principles: strings(profile?.voiceDesign?.principles || profile?.voice?.principles
        || [voiceRecipe.dialogue, voiceRecipe.narration, profile?.voiceContract?.emotionalRendering].filter(Boolean)),
      variation: strings(profile?.voiceDesign?.variationRules || profile?.voice?.variationRules
        || [voiceRecipe.rhythm, voiceRecipe.exposition].filter(Boolean)),
    },
    readerLegibility: clean(profile?.narrativeContract?.readerLegibility
      || '전문 지식 없이도 장면의 즉시 목표, 대사의 표면 뜻, 선택의 결과를 붙잡을 수 있게 쓴다.'),
    registerPolicy: clean(profile?.narrativeContract?.registerPolicy
      || '정밀한 시각·수치·전문어는 문서와 작전 상황에 쓰고, 일상 대화와 서술에서는 인물이 실제로 쓸 자연스러운 표현을 우선한다.'),
    readability: {
      surfaceEase: clean(profile?.readabilityContract?.surfaceEase || 'easy'),
      conceptPacing: clean(profile?.readabilityContract?.conceptPacing || 'slow'),
      inferenceLoad: clean(profile?.readabilityContract?.inferenceLoad || 'explicit'),
      complexityRamp: clean(profile?.readabilityContract?.complexityRamp || 'onboarding-first'),
    },
    craft: {
      judgments: strings(writerSkill?.authorCraft?.judgments),
      omissions: strings(writerSkill?.authorCraft?.omissions, 4),
      dialogueConduct: strings(writerSkill?.authorCraft?.dialogueConduct, 4),
      antiFixation: strings(writerSkill?.antiFixation, 4),
    },
    sourceRevisions: {
      storyProfile: profile?.revision ?? null,
      storyIdentity: identity?.revision ?? null,
      writerSkill: writerSkill?.revision ?? null,
    },
  };
  return { ...contract, compilerVersion: 'narrative-contract-2', digest: digest(contract) };
}

export function compileArcIntent(arcPlan) {
  if (!arcPlan) return null;
  const intent = {
    schemaVersion: 2,
    arcNumber: Number(arcPlan.arcNumber),
    title: clean(arcPlan.title),
    promise: clean(arcPlan.promise),
    minimumPayoff: clean(arcPlan.readerContract?.minimumPayoff),
    finalState: clean(arcPlan.finalState || arcPlan.outcome),
    sourceRevision: arcPlan.revision ?? null,
  };
  return { ...intent, compilerVersion: 'arc-intent-2', digest: digest(intent) };
}

export function compileEpisodeIntent({ episodePlan, arcEpisode, chapter }) {
  if (!episodePlan && !arcEpisode) return null;
  const scenes = (episodePlan?.scenes ?? []).map((scene) => ({
    situation: clean(scene.situation), choice: clean(scene.choice), change: clean(scene.change),
  })).filter((scene) => scene.situation || scene.choice || scene.change).slice(0, 5);
  const intent = {
    schemaVersion: 2,
    chapter: Number(chapter ?? episodePlan?.chapter ?? arcEpisode?.chapter),
    premise: clean(episodePlan?.premise || arcEpisode?.beat || arcEpisode?.goal),
    pressure: clean(episodePlan?.scenePressure?.decisionDeadline || arcEpisode?.pressure),
    expectedChange: clean(episodePlan?.exitValue?.specificFutureValue || episodePlan?.closingState || arcEpisode?.nextState || arcEpisode?.carry),
    payoff: clean(episodePlan?.payoff?.promisePaid || episodePlan?.payoff?.promise || arcEpisode?.payoff),
    cost: clean(episodePlan?.costCreatedByResolution?.immediate || episodePlan?.costCreatedByResolution?.deferred
      || arcEpisode?.costCreatedByResolution || arcEpisode?.cost),
    readerBridge: clean(episodePlan?.readerBridge),
    cast: strings(episodePlan?.cast, 12),
    scenes,
    sourceRevisions: { episodePlan: episodePlan?.revision ?? null, arcEpisode: arcEpisode?.index ?? null },
  };
  return { ...intent, compilerVersion: 'episode-intent-2', digest: digest(intent) };
}

export function renderNarrativeContract(contract) {
  if (!contract) return '';
  return [
    '## 작품 계약',
    `- 독자 약속: ${contract.readerPromise || '미정'}`,
    `- 반복 쾌감: ${contract.recurringPleasures.join('; ') || '미정'}`,
    `- 주인공 매력과 결핍: ${contract.protagonistAppeal || '미정'} / ${contract.emotionalDefect || '미정'}`,
    `- 시점과 거리: ${contract.narration.pov || '미정'} / ${contract.narration.depth || '미정'}`,
    `- 정서: ${contract.narration.tones.join('; ') || '장면에 따른다'}`,
    `- 인물 표현: ${contract.characterExpression.principles.join('; ')}`,
    `- 표현 변주: ${contract.characterExpression.variation.join('; ')}`,
    `- 독자 접근성: ${contract.readerLegibility}`,
    `- 표현 레지스터: ${contract.registerPolicy}`,
    `- 읽기 난도: 표면=${contract.readability.surfaceEase} / 개념=${contract.readability.conceptPacing} / 추론=${contract.readability.inferenceLoad} / 상승=${contract.readability.complexityRamp}`,
    `- 작가 판단: ${contract.craft.judgments.join('; ') || '장면의 선택과 결과를 우선한다'}`,
    `- 대사 운용: ${contract.craft.dialogueConduct.join('; ') || '대사는 관계를 움직인다'}`,
    `- 고착 방지: ${contract.craft.antiFixation.join('; ') || '같은 기능의 해결을 연속 반복하지 않는다'}`,
  ].join('\n');
}

// Keep the approved contract in the actual writer request, not only its digest.
// Examples are optional; their selection and omission are observable.
export function compileDraftContract({ profile, identity, writerSkill, episodePlan, chapter = 1 }) {
  const contract = compileNarrativeContract({ profile, identity, writerSkill });
  const guidance = (profile?.promptGuidance?.draft ?? []).filter((item) => typeof item === 'string' && item.trim());
  const query = JSON.stringify({ premise: episodePlan?.premise, scenes: episodePlan?.scenes });
  const candidates = ['narrationExamples', 'dialogueExamples'].flatMap((field) =>
    (profile?.voiceContract?.[field] ?? []).flatMap((item, index) => typeof item?.example === 'string' && item.example.trim()
      ? [{ source: `voiceContract.${field}.${index}`, ...item }] : []));
  const terms = (text) => [...new Set(String(text).match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
  const ranked = candidates.map((item, index) => ({ ...item, index,
    relevance: terms(`${item.situation ?? ''} ${item.example}`).filter((term) => query.includes(term)).length,
  })).sort((a, b) => b.relevance - a.relevance || ((a.index + chapter - 1) % Math.max(1, candidates.length)) - ((b.index + chapter - 1) % Math.max(1, candidates.length)));
  const selected = [];
  const excluded = [];
  let chars = 0;
  for (const item of ranked) {
    const text = `${item.situation ?? '문체 예시'}\n${item.example}\n${item.craftReason ?? ''}`;
    const reason = selected.length >= 2 ? 'example-count' : chars + text.length > 1600 ? 'example-budget' : null;
    if (reason) excluded.push({ source: item.source, reason });
    else { selected.push({ source: item.source, text }); chars += text.length; }
  }
  // Preserve full source text for core intent even when the legacy contract
  // compiler bounds fields for other planning callers.
  const core = {
    ...contract,
    readerPromise: String(profile?.narrativeContract?.readerPromise || identity?.readerPromise || profile?.storyEngines?.[0] || '').trim(),
    protagonistAppeal: String(identity?.protagonistAppeal ?? '').trim(),
    emotionalDefect: String(identity?.emotionalDefect ?? '').trim(),
    recurringPleasures: profile?.storyEngines ?? identity?.competenceSignature ?? [],
    readerLegibility: profile?.narrativeContract?.readerLegibility ?? contract.readerLegibility,
    registerPolicy: profile?.narrativeContract?.registerPolicy ?? contract.registerPolicy,
    narration: { ...contract.narration, depth: String(profile?.povDesign?.narrativeDistance ?? contract.narration.depth), tones: profile?.tones ?? [] },
    characterExpression: {
      principles: profile?.voiceDesign?.principles ?? profile?.voice?.principles ?? [profile?.voiceContract?.genreVoiceRecipe?.narration, profile?.voiceContract?.genreVoiceRecipe?.dialogue, profile?.voiceContract?.emotionalRendering].filter(Boolean),
      variation: profile?.voiceDesign?.variationRules ?? profile?.voice?.variationRules ?? [profile?.voiceContract?.genreVoiceRecipe?.rhythm, profile?.voiceContract?.genreVoiceRecipe?.exposition].filter(Boolean),
    },
  };
  const writerText = [renderNarrativeContract(core),
    ...(identity?.competenceSignature?.length ? [`- 능력을 보여주는 방식: ${identity.competenceSignature.join('; ')}`] : []),
    ...guidance.map((item) => `- 승인된 집필 방향: ${item}`),
    ...(selected.length ? ['## 작품의 문체 예시', '예시는 인물의 관찰과 반응 방식을 참고한다. 현재 장면의 정서에 맞게 변주하며 문장을 복사하지 않는다.', ...selected.map((item) => item.text)] : []),
  ].join('\n');
  return { writerText, trace: { digest: digest(writerText), sourceRevisions: contract.sourceRevisions,
    examplesIncluded: selected.map((item) => item.source), examplesExcluded: excluded, coreTruncated: false } };
}

export function renderEpisodeIntent(intent) {
  if (!intent) return '';
  return [
    `## ${intent.chapter}화 의도`,
    `- 상황: ${intent.premise}`,
    `- 압력: ${intent.pressure}`,
    `- 도착 변화: ${intent.expectedChange}`,
    `- 지급과 대가: ${intent.payoff || '없음'} / ${intent.cost || '없음'}`,
    `- 독자 연결점: ${intent.readerBridge || '이번 선택과 결과가 장면에서 자명해야 함'}`,
    ...intent.scenes.map((scene) => `- ${scene.situation} -> ${scene.choice} -> ${scene.change}`),
  ].join('\n');
}
