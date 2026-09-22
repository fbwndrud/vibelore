const MODEL = { provider: 'host', modelId: 'host-agent' };
export const MIN_CHARACTER_FIDELITY = 70;
export const MIN_CHARACTER_DIMENSION = 60;
export const MIN_CHARACTER_VOICE_DIMENSION = 70;
const DIMENSIONS = ['voice', 'motivation', 'responseCausality', 'relationshipContinuity', 'dialogueIntent'];
const FLEXIBILITY_DIMENSIONS = ['voiceRange', 'offAxisHumanity', 'profileRestraint'];
const INDEPENDENT_ADVISORY_CODES = new Set(['VOICE_MISMATCH', 'RELATIONSHIP_DRIFT', 'UNCAUSED_RESPONSE']);
const MIN_FINDING_CONFIDENCE = 0.8;

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

export async function runCharacterFidelity({ prose, chapter, foundation, context, providers }) {
  const cast = foundation.characters.map((character) => ({
    id: character.id, name: character.canonicalName, aliases: character.aliases,
    role: character.intrinsic?.role, contradiction: character.contradiction,
    description: character.description, relationships: character.relationships,
    speechProfile: character.speechProfile,
  }));
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'character-fidelity',
    messages: [
      { role: 'system', content: '당신은 한국 상업 웹소설의 캐릭터 디렉터다. 실제 본문에서 인물별 행동과 대사를 화자에게 귀속하고, 설정된 말투·욕망·모순·관계·금기에 비추어 이 상황의 대응이 그 인물에게서 나올 법한지 평가한다. 단순 호감도나 현실의 도덕성을 평가하지 않는다. 예상 밖 행동도 본문에 압력과 선택 근거가 축적되면 통과시킨다. speechProfile과 EpisodePlan의 말투 목표는 복사할 문장이 아니라 기준 예시다. 샘플 대사를 그대로 붙였거나, 여러 인물이 같은 문장 리듬/존대/논리 습관으로 말하거나, 대사가 정보 전달만 하고 겉목적·숨은목적·관계 압력을 남기지 않으면 voice 또는 dialogueIntent를 낮게 준다. 반대로 모든 대사에서 프로필의 숫자·계약·농담·진단 같은 대표 특징을 과시하는 것도 캐릭터 충실도가 아니다. 침묵, 사소한 취향, 실패한 농담, 엇나간 친절, 평소와 다른 문장 길이처럼 압력에 따른 가동 범위가 있어야 사람으로 보인다. 순수 JSON만 출력한다.' },
      { role: 'user', content: [
        `회차: ${chapter}`, `캐릭터 정본: ${JSON.stringify(cast)}`,
        '직전 상태 참고:', context, '', '본문:', prose, '',
        '본문에 실제 등장하거나 이번 장면의 선택 압력으로 직접 작동한 인물만 평가한다. 등록됐지만 이번 화에 나오지 않은 인물은 감점하지 않는다. dimensions는 작품 전체가 아니라 이번 화에 실제 작동한 인물들의 충실도를 각 축별 0~100으로 평가한다. score는 기존 다섯 핵심 dimensions의 산술평균이어야 한다. flexibilityDimensions는 캐릭터가 프로필을 반복 낭독하지 않고 상황에 따라 변주되는지를 별도로 평가한다.',
        'voice는 이름을 가려도 화자를 구분할 수 있는지, speechProfile과 관계별 말투 변형이 살아 있는지, 이번 화 말투 목표의 압력과 숨은 목적이 대사에 반영됐는지를 본다.',
        'dialogueIntent는 대화 전체가 정보 설명만으로 끝나는지 본다. 개별 대사마다 회피·압박·시험·유혹·관계 재정의를 강제하지 않으며, 짧은 대답·일상 반응·말하지 않음이 장면의 사람다운 호흡을 만들면 긍정적으로 평가한다.',
        'findings에는 반드시 해당 판단을 독립적으로 확인할 수 있는 짧은 본문 근거와 confidence(0~1)를 붙인다. 장면 하나의 명확한 불일치는 평균 점수를 억지로 낮추지 말고 finding으로 분리한다.',
        'JSON: {"score":0,"dimensions":{"voice":0,"motivation":0,"responseCausality":0,"relationshipContinuity":0,"dialogueIntent":0},"flexibilityDimensions":{"voiceRange":0,"offAxisHumanity":0,"profileRestraint":0},"characters":[{"characterId":"id","verdict":"pass|warn|fail","evidence":"행동/대사 근거"}],"findings":[{"characterId":"id","dimension":"voice|motivation|responseCausality|relationshipContinuity|dialogueIntent|voiceRange|offAxisHumanity|profileRestraint","code":"VOICE_MISMATCH|VOICE_NOT_DISTINCT|VOICE_SAMPLE_COPIED|MOTIVATION_BREAK|UNCAUSED_RESPONSE|RELATIONSHIP_DRIFT|GENERIC_DIALOGUE|DIALOGUE_INFO_ONLY|VOICE_RANGE_NARROW|OFF_AXIS_HUMANITY_MISSING|PROFILE_OVERPERFORMANCE","message":"최소 수정 방향","evidence":"본문의 짧고 구체적인 근거","confidence":0.0}]}',
      ].join('\n') },
    ],
  });
  const obj = parse(response.text);
  const dimensions = obj?.dimensions && typeof obj.dimensions === 'object' ? obj.dimensions : {};
  const flexibilityDimensions = obj?.flexibilityDimensions && typeof obj.flexibilityDimensions === 'object' ? obj.flexibilityDimensions : {};
  const dimensionScores = DIMENSIONS.map((key) => Number(dimensions[key])).filter((score) => Number.isFinite(score) && score >= 0 && score <= 100);
  const derivedScore = dimensionScores.length === DIMENSIONS.length
    ? Math.round(dimensionScores.reduce((sum, score) => sum + score, 0) / dimensionScores.length)
    : null;
  const flexibilityScores = FLEXIBILITY_DIMENSIONS.map((key) => Number(flexibilityDimensions[key])).filter((score) => Number.isFinite(score) && score >= 0 && score <= 100);
  const flexibilityScore = flexibilityScores.length === FLEXIBILITY_DIMENSIONS.length
    ? Math.round(flexibilityScores.reduce((sum, score) => sum + score, 0) / flexibilityScores.length)
    : null;
  const findings = (Array.isArray(obj?.findings) ? obj.findings : [])
    .filter((item) => typeof item?.message === 'string')
    .slice(0, 12)
    .map((item) => ({
      ...item,
      message: item.message.trim(),
      evidence: typeof item.evidence === 'string' ? item.evidence.trim() : '',
      confidence: Number.isFinite(Number(item.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : null,
    }));
  return {
    score: derivedScore,
    reportedScore: typeof obj?.score === 'number' && obj.score >= 0 && obj.score <= 100 ? Math.round(obj.score) : null,
    dimensions, flexibilityDimensions, flexibilityScore,
    characters: Array.isArray(obj?.characters) ? obj.characters.slice(0, 12) : [], findings,
  };
}

export function characterFidelityAdvisories(result, chapter) {
  return (result?.findings ?? []).filter((finding) =>
    INDEPENDENT_ADVISORY_CODES.has(finding.code)
      && finding.evidence
      && Number(finding.confidence) >= MIN_FINDING_CONFIDENCE)
    .map((finding) => ({
      severity: 'soft', advisoryOnly: true, code: finding.code, chapterNumber: chapter,
      ...(finding.characterId ? { characterId: finding.characterId } : {}),
      confidence: finding.confidence,
      message: `${finding.message} (근거: ${finding.evidence})`,
    }));
}

export function characterFidelityViolations(result, chapter) {
  const findings = result?.findings ?? [];
  const violations = [];
  if (result?.score !== null && result?.score < MIN_CHARACTER_FIDELITY) {
    violations.push({ severity: 'soft', code: 'CHARACTER_FIDELITY_LOW', chapterNumber: chapter,
      message: `캐릭터 대응·대사 충실도 ${result.score}점으로 기준 ${MIN_CHARACTER_FIDELITY}점 미만이다.` });
  }
  for (const [dimension, score] of Object.entries(result?.dimensions ?? {})) {
    const threshold = dimension === 'voice' ? MIN_CHARACTER_VOICE_DIMENSION : MIN_CHARACTER_DIMENSION;
    if (!Number.isFinite(Number(score)) || Number(score) >= threshold) continue;
    const finding = findings.find((item) => item.dimension === dimension);
    violations.push({ severity: 'soft', code: finding?.code ?? `CHARACTER_${dimension.toUpperCase()}_LOW`, chapterNumber: chapter,
      ...(finding?.characterId ? { characterId: finding.characterId } : {}),
      message: finding?.message ?? `${dimension} 차원이 ${score}점으로 기준 ${threshold}점 미만이다.` });
  }
  for (const [dimension, score] of Object.entries(result?.flexibilityDimensions ?? {})) {
    if (!FLEXIBILITY_DIMENSIONS.includes(dimension) || !Number.isFinite(Number(score)) || Number(score) >= MIN_CHARACTER_DIMENSION) continue;
    const finding = findings.find((item) => item.dimension === dimension);
    violations.push({ severity: 'soft', code: finding?.code ?? `CHARACTER_${dimension.toUpperCase()}_LOW`, chapterNumber: chapter,
      ...(finding?.characterId ? { characterId: finding.characterId } : {}),
      message: finding?.message ?? `${dimension} 차원이 ${score}점으로 기준 ${MIN_CHARACTER_DIMENSION}점 미만이다.` });
  }
  return violations;
}
