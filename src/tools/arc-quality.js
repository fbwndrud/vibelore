import { asKit } from '../prompts/index.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const DIMENSIONS = ['premisePressure', 'causalEscalation', 'expectationRenewal', 'characterAgency', 'oppositionAdaptation', 'payoffSurprise', 'serialMomentum'];
const TARGETED_CODES = new Set(['CHARACTER_ARC_RUSH', 'UNSUPPORTED_RELATIONSHIP_SHIFT', 'SOCIAL_CONSEQUENCE_RESET']);
export const MIN_ARC_QUALITY = 72;
export const MIN_ARC_DIMENSION = 60;
export const MIN_TARGETED_CONFIDENCE = 0.8;

const normalized = (value) => String(value ?? '').toLowerCase().replace(/[\s·,.'"“”‘’!?]/g, '');
function repetition(values) {
  const usable = values.map(normalized).filter(Boolean);
  if (usable.length < 3) return false;
  return new Set(usable).size <= Math.ceil(usable.length / 2);
}

export function deterministicArcViolations(plan) {
  const episodes = plan?.episodes ?? [];
  const violations = [];
  const fields = [
    ['beat', 'ARC_EVENT_REPETITION', '핵심 사건'], ['payoff', 'ARC_PAYOFF_REPETITION', '회차 지급'],
    ['costCreatedByResolution', 'ARC_COST_REPETITION', '해결 비용'], ['exitValue', 'ARC_EXIT_REPETITION', '다음 화 가치'],
  ];
  for (const [field, code, label] of fields) {
    if (repetition(episodes.map((episode) => episode[field]))) violations.push({ code, message: `${label}가 화수만 바뀐 채 반복된다.` });
  }
  for (const arc of plan?.characterArcs ?? []) {
    const inheritedIndex = CHARACTER_ARC_ORDER.indexOf(arc.inheritedState?.previousBeat);
    let previous = inheritedIndex >= 0 && inheritedIndex < CHARACTER_ARC_ORDER.length - 1
      ? inheritedIndex
      : null;
    for (const item of arc.beats ?? []) {
      const currentIndex = CHARACTER_ARC_ORDER.indexOf(item.beat);
      if (previous === null && currentIndex !== 0) {
        violations.push({ code: 'CHARACTER_ARC_START_INVALID', message: `${arc.characterId}의 첫 감정 비트는 wound여야 한다.` });
      } else if (previous !== null && (currentIndex < previous || currentIndex > previous + 1)) {
        violations.push({ code: 'CHARACTER_ARC_SEQUENCE_INVALID', message: `${arc.characterId}의 감정 비트가 근거 단계 없이 ${CHARACTER_ARC_ORDER[previous]}에서 ${item.beat}(으)로 이동한다.` });
      }
      previous = currentIndex;
    }
  }
  return violations;
}

const CHARACTER_ARC_ORDER = ['wound', 'attempt', 'collapse', 'companion', 'self-choice', 'echo'];

/**
 * 같은 회차에 감정 비트를 둘 이상 둔 원시 응답. 정규화는 회차당 첫 비트만 남기므로
 * 모델이 wound(1)·attempt(2)·collapse(2)·companion(3) 처럼 쓰면 저장된 비트는
 * attempt→companion 으로 단계를 건너뛴 것처럼 보인다(2026-09-14 en 표본). 정규화 전에
 * 원인을 그대로 말해 호스트 feedback 이 실제 문제를 가리키게 한다.
 */
export function characterArcBeatCollisions(rawCharacterArcs, count) {
  const violations = [];
  for (const raw of Array.isArray(rawCharacterArcs) ? rawCharacterArcs.slice(0, 2) : []) {
    const seen = new Map();
    for (const item of Array.isArray(raw?.beats) ? raw.beats : []) {
      const episodeIndex = Number(item?.episodeIndex);
      if (!Number.isInteger(episodeIndex) || episodeIndex < 1 || episodeIndex > count) continue;
      seen.set(episodeIndex, (seen.get(episodeIndex) ?? 0) + 1);
    }
    for (const [episodeIndex, n] of seen) {
      if (n > 1) violations.push({ code: 'CHARACTER_ARC_MULTIPLE_BEATS_PER_EPISODE', message: `${raw?.characterId ?? '?'}의 ${episodeIndex}화에 감정 비트가 ${n}개다. 회차당 비트는 하나만 두고, 한 단계는 여러 회차에 걸쳐도 된다.` });
    }
  }
  return violations;
}

function targetedFinding(value) {
  const confidence = Number(value?.confidence);
  const code = String(value?.code ?? '');
  const message = String(value?.message ?? '').trim();
  const evidence = String(value?.evidence ?? '').trim();
  if (!TARGETED_CODES.has(code) || !message || !evidence || !Number.isFinite(confidence)) return null;
  return { code, message, evidence, confidence: Math.max(0, Math.min(1, confidence)) };
}

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

/**
 * @param {{ kit?: object|null }} input `kit` 이 없으면 foundation 의 저장된 언어로,
 *   그것도 없으면 구작의 암묵적 ko 계열로 해석한다.
 */
export async function runArcQuality({ foundation, plan, providers, kit: kitSource }) {
  const kit = asKit(kitSource ?? { foundation });
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'arc-quality', messages: kit.messages('arc-quality', {
    foundationJson: JSON.stringify({ title: foundation.title, genre: foundation.genre, worldFacts: foundation.worldFacts, characters: foundation.characters.map((c) => ({ id: c.id, name: c.canonicalName, contradiction: c.contradiction, description: c.description })) }),
    planJson: JSON.stringify(plan),
  }) });
  if ((providers.pending?.length ?? 0) > 0) return null;
  const obj = parse(response.text);
  if (!obj) throw new Error('아크 품질 심사 JSON을 해석할 수 없습니다.');
  const rawDimensions = obj.dimensions && typeof obj.dimensions === 'object' ? obj.dimensions : {};
  const dimensions = { ...rawDimensions, characterAgency: rawDimensions.characterAgency ?? rawDimensions.characterCollision };
  const scores = DIMENSIONS.map((key) => Number(dimensions[key]));
  if (scores.some((score) => !Number.isFinite(score) || score < 0 || score > 100)) throw new Error('아크 품질 심사에 유효한 7개 차원 점수가 필요합니다.');
  const score = Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);
  const weakDimensions = DIMENSIONS.filter((key) => Number(dimensions[key]) < MIN_ARC_DIMENSION);
  const findings = (Array.isArray(obj.findings) ? obj.findings : []).filter((item) => typeof item?.message === 'string').slice(0, 12);
  const targetedApplicable = obj.targetedReview?.applicable === true;
  const targetedFindings = targetedApplicable
    ? (Array.isArray(obj.targetedReview?.findings) ? obj.targetedReview.findings : []).map(targetedFinding).filter(Boolean).slice(0, 6)
    : [];
  return {
    score, reportedScore: Number(obj.score), dimensions, findings,
    targetedReview: { applicable: targetedApplicable, findings: targetedFindings },
    verdict: score >= MIN_ARC_QUALITY && weakDimensions.length === 0 ? 'passed' : 'failed', weakDimensions,
  };
}
