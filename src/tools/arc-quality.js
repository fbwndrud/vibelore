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

export async function runArcQuality({ foundation, plan, providers }) {
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'arc-quality', messages: [
    { role: 'system', content: '당신은 한국 상업 웹소설의 블라인드 아크 심사자다. 필드가 채워졌는지가 아니라 독자가 매 화 세운 가설이 갱신되는지, 해결이 다음 갈등의 원인이 되는지, 중심 인물이 자기 욕구로 선택해 결과를 바꾸는지, 상대가 성공을 학습해 적응하는지, 심은 단서가 예상 밖이지만 납득 가능한 방식으로 회수되는지 평가한다. 모든 인물이 매 화 충돌하거나 자기 논점을 주장할 필요는 없다. 조용한 반응, 합의, 부재도 장면에 맞으면 정상이다. 사건명만 바꾼 동일 공식, 주인공의 연속 정답, 비용 없는 장기 보상, 마지막에 새 위험만 붙이는 훅을 엄격히 감점한다. 관계 점검은 별도 조건부 관찰이다. 계획에 명시적인 관계·말투 변화가 있거나, 한 인물이 다른 인물의 안전·지위·신뢰를 크게 훼손하는 사건이 있을 때만 applicable=true로 평가한다. 해당 사건이 없으면 관계 문제를 억지로 만들지 않는다. 조건부 관찰은 일곱 평균 점수와 verdict에 반영하지 않는다. 결과 사건을 대신 쓰지 말고 설계의 생성 가능성을 심사한다. 순수 JSON만 출력한다.' },
    { role: 'user', content: `작품 세계·인물:\n${JSON.stringify({ title: foundation.title, genre: foundation.genre, worldFacts: foundation.worldFacts, characters: foundation.characters.map((c) => ({ id: c.id, name: c.canonicalName, contradiction: c.contradiction, description: c.description })) })}\n\n검사할 아크:\n${JSON.stringify(plan)}\n\n각 dimensions는 0~100이며 score는 일곱 차원의 산술평균이다. targetedReview는 명시적 관계 변화나 중대한 관계 사건이 있을 때만 적용하고, 단계 진행의 행동 근거 또는 사건 뒤 태도·책임·거리 변화가 계획에 남는지 본다. JSON: {"score":0,"dimensions":{"premisePressure":0,"causalEscalation":0,"expectationRenewal":0,"characterAgency":0,"oppositionAdaptation":0,"payoffSurprise":0,"serialMomentum":0},"verdict":"pass|revise","findings":[{"dimension":"premisePressure|causalEscalation|expectationRenewal|characterAgency|oppositionAdaptation|payoffSurprise|serialMomentum","code":"GENERIC_PREMISE|EPISODE_RESET|STATIC_EXPECTATION|PASSIVE_CHARACTER|PASSIVE_OPPOSITION|TELEGRAPHED_PAYOFF|WEAK_SERIAL_PULL","message":"구체적 문제와 아크 수준 수정 방향"}],"targetedReview":{"applicable":false,"findings":[{"code":"CHARACTER_ARC_RUSH|UNSUPPORTED_RELATIONSHIP_SHIFT|SOCIAL_CONSEQUENCE_RESET","message":"구체적 문제와 최소 아크 수정 방향","evidence":"문제가 드러나는 화와 계획 문구","confidence":0.0}]}}` },
  ] });
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
