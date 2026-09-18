import { createHash } from 'node:crypto';

import { asKit } from '../prompts/index.js';

const clean = (value, limit = 600) => String(value ?? '').trim().slice(0, limit);
const strings = (value, limit = 6) => Array.isArray(value)
  ? value.map((item) => clean(item, 300)).filter(Boolean).slice(0, limit)
  : [];
const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

export function compileNarrativeContract({ profile, identity, writerSkill, kit: kitSource }) {
  const t = asKit(kitSource ?? { profile }).phrases.contract;
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
      || t.defaultReaderLegibility),
    registerPolicy: clean(profile?.narrativeContract?.registerPolicy
      || t.defaultRegisterPolicy),
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

export function renderNarrativeContract(contract, kitSource) {
  if (!contract) return '';
  const kit = asKit(kitSource);
  const t = kit.phrases.contract;
  const undecided = kit.phrases.common.undecided;
  return [
    t.heading,
    t.readerPromise(contract.readerPromise || undecided),
    t.recurringPleasures(contract.recurringPleasures.join('; ') || undecided),
    t.protagonist(contract.protagonistAppeal || undecided, contract.emotionalDefect || undecided),
    t.narration(contract.narration.pov || undecided, contract.narration.depth || undecided),
    t.tones(contract.narration.tones.join('; ') || t.tonesFallback),
    t.expressionPrinciples(contract.characterExpression.principles.join('; ')),
    t.expressionVariation(contract.characterExpression.variation.join('; ')),
    t.readerLegibility(contract.readerLegibility),
    t.registerPolicy(contract.registerPolicy),
    t.readability(contract.readability),
    t.judgments(contract.craft.judgments.join('; ') || t.judgmentsFallback),
    t.dialogueConduct(contract.craft.dialogueConduct.join('; ') || t.dialogueConductFallback),
    t.antiFixation(contract.craft.antiFixation.join('; ') || t.antiFixationFallback),
  ].join('\n');
}

// Keep the approved contract in the actual writer request, not only its digest.
// Examples are optional; their selection and omission are observable.
export function compileDraftContract({ profile, identity, writerSkill, episodePlan, chapter = 1, characterNames = {}, kit: kitSource }) {
  const kit = asKit(kitSource ?? { profile });
  const t = kit.phrases.contract;
  const contract = compileNarrativeContract({ profile, identity, writerSkill, kit });
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
    const text = `${item.situation ?? t.styleExampleFallbackSituation}\n${item.example}\n${item.craftReason ?? ''}`;
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
  // The chapter's viewpoint character comes from the approved plan; the draft
  // and the local revise both read this contract, so both hear it here
  // (2026-09-18 es sample: a chapter planned on Clara was revised three times
  // without leaving Inés's viewpoint).
  const viewpointId = typeof episodePlan?.povCharacter === 'string' ? episodePlan.povCharacter.trim() : '';
  const writerText = [renderNarrativeContract(core, kit),
    ...(viewpointId ? [t.chapterViewpoint(characterNames[viewpointId] ?? viewpointId)] : []),
    ...(identity?.competenceSignature?.length ? [t.competenceSignature(identity.competenceSignature.join('; '))] : []),
    ...guidance.map((item) => t.approvedDraftRule(item)),
    ...(selected.length ? [t.styleExamplesHeading, t.styleExamplesRule, ...selected.map((item) => item.text)] : []),
  ].join('\n');
  return { writerText, trace: { digest: digest(writerText), sourceRevisions: contract.sourceRevisions,
    examplesIncluded: selected.map((item) => item.source), examplesExcluded: excluded, coreTruncated: false } };
}

export function renderEpisodeIntent(intent, kitSource) {
  if (!intent) return '';
  const kit = asKit(kitSource);
  const t = kit.phrases.contract;
  const none = kit.phrases.common.none;
  return [
    t.intentHeading(intent.chapter),
    t.intentSituation(intent.premise),
    t.intentPressure(intent.pressure),
    t.intentChange(intent.expectedChange),
    t.intentPayoffCost(intent.payoff || none, intent.cost || none),
    t.intentReaderBridge(intent.readerBridge || t.intentReaderBridgeFallback),
    ...intent.scenes.map((scene) => t.intentScene(scene.situation, scene.choice, scene.change)),
  ].join('\n');
}
