const MODEL = { provider: 'host', modelId: 'host-agent' };
const INDEPENDENT_ADVISORY_CODES = new Set(['CLEAN_CONFLICT_RESET']);
const MIN_FINDING_CONFIDENCE = 0.8;

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

export async function runEditorialQuality({ prose, context, providers }) {
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'editorial-quality',
    messages: [
      { role: 'system', content: '당신은 한국어 상업 웹소설의 편집자다. 이 요청은 현재 계획을 제외하지만 평가 문맥의 독립성을 보장하지는 않는다. 집필 계획이나 의도된 결말을 보지 않고 실제 독자가 받은 소설 체험만 평가한다. 설정 정답이나 계획 준수가 아니라 장면 접속, 인물별 말투와 욕망, 복선, 장면 체류, 권력 관계의 이동, 말하지 않은 욕망이 만드는 서브텍스트, 충돌 뒤에 남는 대가, 복선으로 납득되지만 즉시 예측되지는 않는 전환을 각각 채점한다. 계획표를 산문으로 옮긴 요약문과 근거 없는 호평을 엄격히 감점한다. 순수 JSON만 출력한다.' },
      { role: 'user', content: [
        '직전까지의 연속성 참고(정답표가 아니며 본문의 재미를 대신하지 않음):', context, '', '평가할 본문:', prose, '',
        '분량이 길다는 이유만으로 감점하지 않는다. 같은 협상·설명·판단을 기능 변화 없이 되풀이하거나, 이미 끝난 장면 뒤에 사실상 두 번째 결말을 붙여 종료 초점이 흐려질 때만 density 또는 endingFocus를 낮춘다.',
        'findings에는 반드시 해당 판단을 독립적으로 확인할 수 있는 짧은 본문 근거와 confidence(0~1)를 붙인다. 장면 하나의 명확한 충돌 초기화는 평균 점수를 억지로 낮추지 말고 finding으로 분리한다.',
        'JSON: {"score":0,"dimensions":{"sceneContinuity":0,"characterVoice":0,"setupPayoff":0,"sceneDepth":0,"proseIdentity":0,"powerShift":0,"subtext":0,"consequenceResidue":0,"surpriseIntegrity":0,"density":0,"endingFocus":0},"findings":[{"dimension":"powerShift|subtext|consequenceResidue|surpriseIntegrity|sceneDepth|proseIdentity|density|endingFocus","code":"SCENE_DISCONNECT|VOICE_FLAT|PAYOFF_UNSEEDED|SCENE_THIN|PLAN_SHAPED_PROSE|STATIC_POWER|ON_THE_NOSE_DIALOGUE|CLEAN_CONFLICT_RESET|TELEGRAPHED_TURN|OVERLONG_DENSITY|REPEATED_NEGOTIATION|DOUBLE_ENDING","message":"고칠 장면 방향","evidence":"본문의 짧고 구체적인 근거","confidence":0.0}]}',
      ].join('\n') },
    ],
  });
  const obj = parse(response.text);
  const score = typeof obj?.score === 'number' && obj.score >= 0 && obj.score <= 100 ? Math.round(obj.score) : null;
  const findings = (Array.isArray(obj?.findings) ? obj.findings : [])
    .filter((finding) => typeof finding?.message === 'string')
    .slice(0, 10)
    .map((finding) => ({
      ...finding,
      message: finding.message.trim(),
      evidence: typeof finding.evidence === 'string' ? finding.evidence.trim() : '',
      confidence: Number.isFinite(Number(finding.confidence)) ? Math.max(0, Math.min(1, Number(finding.confidence))) : null,
    }));
  return {
    score,
    dimensions: obj?.dimensions && typeof obj.dimensions === 'object' ? obj.dimensions : {},
    findings,
  };
}

export function editorialQualityAdvisories(result, chapter) {
  return (result?.findings ?? []).filter((finding) =>
    INDEPENDENT_ADVISORY_CODES.has(finding.code)
      && finding.evidence
      && Number(finding.confidence) >= MIN_FINDING_CONFIDENCE)
    .map((finding) => ({
      severity: 'soft', advisoryOnly: true, code: finding.code, chapterNumber: chapter,
      confidence: finding.confidence,
      message: `${finding.message} (근거: ${finding.evidence})`,
    }));
}
