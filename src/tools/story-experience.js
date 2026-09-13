import { episodePlanReviewView } from '../core/episode-plan-view.js';
import { gateApprovalActivation, requireApprovalResult } from '../core/approval-language-gate.js';
import { asKit, resolveWorkKit } from '../prompts/index.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const text = (v, n = 800) => String(v ?? '').trim().slice(0, n);
const list = (v, n = 10) => Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, n) : [];
const parse = (raw) => { try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); } catch { return null; } };

export function renderStoryIdentity(identity, kitSource) {
  if (!identity) return '';
  const t = asKit(kitSource).phrases.experience;
  return [t.identityHeading, t.identityReaderPromise(identity.readerPromise), t.identityProtagonistAppeal(identity.protagonistAppeal),
    t.identityCompetence(identity.competenceSignature.join('; ')), t.identityDefect(identity.emotionalDefect),
    t.identityComedy(identity.comedyEngines.join('; ')), t.identityRotation(identity.solutionPatternsToRotate.join('; '))].join('\n');
}

export function renderPilotContract(contract, kitSource) {
  if (!contract) return '';
  const t = asKit(kitSource).phrases.experience;
  return [t.pilotHeading, t.pilotBefore(contract.beforeState),
    t.pilotFailure(contract.firstFailure), t.pilotAction(contract.protagonistSpecificAction),
    t.pilotIrreversible(contract.irreversibleChoice), t.pilotCompetence(contract.competenceProof),
    t.pilotHuman(contract.humanHook), t.pilotSeries(contract.seriesPromise), t.pilotClosing(contract.closingQuestion),
    t.pilotRuleFirstInference,
    t.pilotRuleLoss].join('\n');
}

export function renderPatternLedger(entries, kitSource) {
  const t = asKit(kitSource).phrases.experience;
  if (!entries?.length) return t.ledgerEmpty;
  const none = asKit(kitSource).phrases.common.none;
  return [t.ledgerHeading, ...entries.slice(-5).map((e) =>
    t.ledgerEntry({
      ...e,
      supportingAgencyText: Object.entries(e.supportingAgency ?? {}).map(([k, v]) => `${k}:${v}`).join(', '),
    }, t.ledgerUnclassified, none))].join('\n');
}

export async function ensureStoryIdentity({ store, workId, profile, foundation, providers }) {
  const existing = await store.loadStoryIdentity(workId);
  if (existing) return existing;
  const kit = await resolveWorkKit({ store, workId, foundation, profile });
  const t = kit.phrases.experience;
  const hasContract = Object.hasOwn(foundation ?? {}, 'language') || Object.hasOwn(profile ?? {}, 'language');
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'story-identity', messages: kit.messages('story-identity', {
    brief: foundation?.brief ?? profile?.sourceBrief ?? '',
    genre: profile?.genreLabel ?? foundation?.genre,
  }) });
  if ((providers.pending?.length ?? 0) > 0) return null;
  const o = parse(response.text) ?? {};
  const identity = { workId, readerPromise: text(o.readerPromise || profile?.storyEngines?.join('·') || t.identityFallbackPromise),
    protagonistAppeal: text(o.protagonistAppeal || t.identityFallbackAppeal), competenceSignature: list(o.competenceSignature).length ? list(o.competenceSignature) : [...t.identityFallbackCompetence],
    emotionalDefect: text(o.emotionalDefect || t.identityFallbackDefect), comedyEngines: list(o.comedyEngines).length ? list(o.comedyEngines) : [...t.identityFallbackComedy],
    solutionPatternsToRotate: list(o.solutionPatternsToRotate).length ? list(o.solutionPatternsToRotate) : [...t.identityFallbackRotation], createdAt: new Date().toISOString() };
  if (hasContract) {
    for (const key of ['readerPromise', 'protagonistAppeal', 'emotionalDefect']) identity[key] = text(o[key]);
    for (const key of ['competenceSignature', 'comedyEngines', 'solutionPatternsToRotate']) identity[key] = list(o[key]);
  }
  const approval = await gateApprovalActivation({ store, workId, kind: 'story', stateKey: 'story-identity', value: identity, providers });
  if (!requireApprovalResult(approval)) return null;
  await store.saveStoryIdentity(workId, identity); return identity;
}

export async function ensurePilotContract({ store, workId, identity, foundation, arcPlan, providers }) {
  const existing = await store.loadPilotContract(workId); if (existing) return existing;
  const kit = await resolveWorkKit({ store, workId, foundation });
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'pilot-contract', messages: kit.messages('pilot-contract', {
    identityRender: renderStoryIdentity(identity, kit),
    premise: foundation?.premise ?? foundation?.brief ?? '',
    arcPromise: arcPlan?.promise ?? '',
  }) });
  if ((providers.pending?.length ?? 0) > 0) return null;
  const o = parse(response.text) ?? {}; const contract = { workId, beforeState:text(o.beforeState), firstFailure:text(o.firstFailure), protagonistSpecificAction:text(o.protagonistSpecificAction), irreversibleChoice:text(o.irreversibleChoice), competenceProof:text(o.competenceProof), humanHook:text(o.humanHook), seriesPromise:text(o.seriesPromise || identity?.readerPromise), closingQuestion:text(o.closingQuestion), createdAt:new Date().toISOString() };
  const approval = await gateApprovalActivation({ store, workId, kind: 'story', stateKey: 'pilot', value: contract, providers });
  if (!requireApprovalResult(approval)) return null;
  await store.savePilotContract(workId, contract); return contract;
}

/**
 * @param {{ kit?: object|null }} input 워크플로가 작품 계약을 넘기기 전까지는
 *   구작의 암묵적 ko 계열로 해석한다(기존 동작).
 */
export async function runReaderHook({ chapter, prose, identity, pilotContract, episodePlan, contract = '', recentHookTypes = [], providers, kit: kitSource }) {
  const kit = asKit(kitSource);
  const response = await providers.complete({ model:MODEL,jsonMode:true,step:'reader-hook',messages: kit.messages('reader-hook', {
    chapter, contract,
    identityRender: renderStoryIdentity(identity, kit),
    pilotRender: chapter === 1 ? renderPilotContract(pilotContract, kit) : '',
    episodePlanJson: JSON.stringify(episodePlanReviewView(episodePlan)),
    recentHookTypesJson: JSON.stringify(recentHookTypes),
    prose,
  })}); const o=parse(response.text); return {score:typeof o?.score==='number'?Math.round(o.score):null,dimensions:o?.dimensions??{},commercialSerialCheck:o?.commercialSerialCheck??{},findings:Array.isArray(o?.findings)?o.findings.slice(0,10):[]};
}

export async function runPatternAnalysis({ chapter, prose, providers, kit: kitSource }) {
  const kit = asKit(kitSource);
  const response = await providers.complete({ model:MODEL,jsonMode:true,step:'pattern-ledger',messages: kit.messages('pattern-ledger', { prose })});
  const o=parse(response.text)??{}; return {
    chapter,
    solutionPattern:text(o.solutionPattern,200), moralChoice:text(o.moralChoice,200), costShape:text(o.costShape,100),
    evidenceFamily:text(o.evidenceFamily,100), sceneMode:text(o.sceneMode,100), emotionalTemperature:text(o.emotionalTemperature,100),
    endingImage:text(o.endingImage,100), comedyMechanism:text(o.comedyMechanism,200), protagonistMethod:text(o.protagonistMethod,200),
    mistakeAndCorrection:text(o.mistakeAndCorrection,300), supportingAgency:o.supportingAgency&&typeof o.supportingAgency==='object'?o.supportingAgency:{}, hookType:text(o.hookType,40),
  };
}

export function patternViolations(entries, current, kitSource) {
  const t = asKit(kitSource).phrases.experience;
  const recent=entries.slice(-2); const out=[];
  for(const field of ['solutionPattern','comedyMechanism','protagonistMethod']) if(current[field]&&recent.length===2&&recent.every((e)=>e[field]===current[field])) out.push({severity:'soft',code:'PATTERN_REPETITION',message:t.patternRepetition(field, current[field])});
  const semanticFields = {
    moralChoice: 'MORAL_CHOICE_REPETITION', costShape: 'COST_SHAPE_REPETITION',
    evidenceFamily: 'EVIDENCE_FAMILY_REPETITION', sceneMode: 'SCENE_MODE_REPETITION',
    emotionalTemperature: 'EMOTIONAL_TEMPERATURE_REPETITION', endingImage: 'ENDING_IMAGE_REPETITION',
  };
  for (const [field, code] of Object.entries(semanticFields)) {
    if (current[field] && recent.length === 2 && recent.every((entry) => entry[field] === current[field])) {
      out.push({ severity: 'soft', code, message: t.semanticRepetition(t.semanticLabels[field], current[field]) });
    }
  }
  const analyzed = Boolean(current.solutionPattern || current.protagonistMethod)
    && recent.every((e) => e.solutionPattern || e.protagonistMethod);
  if (recent.length===2 && analyzed && !current.mistakeAndCorrection && recent.every((e)=>!e.mistakeAndCorrection)) out.push({severity:'soft',code:'PERFECT_JUDGMENT_STREAK',message:t.perfectJudgment});
  if (current.hookType && current.hookType !== 'none' && recent.length === 2 && recent.every((e) => e.hookType === current.hookType)) out.push({severity:'soft',code:'HOOK_TYPE_REPETITION',message:t.hookRepetition(current.hookType)});
  return out;
}
