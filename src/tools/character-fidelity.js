import { asKit } from '../prompts/index.js';
import { renderCharacters, renderCurrentState } from '../core/prompt-sections.js';
import { renderSceneCharacterPacket } from '../core/character-dynamics-adapter.js';
import { renderEpisodePlan } from './episode-plan.js';

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

/**
 * @param {{ kit?: object|null }} input `kit` 이 없으면 정본 foundation 에 기록된
 *   작품 언어를 쓴다. 언어 키가 없던 구작은 암묵적 ko 다.
 */
/**
 * The review sees each on-stage character once, as text, and the material the
 * writer drafted from: the chapter plan, the character packet (current goals
 * and relationship views), the current state and the previous chapter's
 * summary. Design-time relationships and appearance are left out; the current
 * relationships come from the state. A caller may still pass its own `context`.
 * A scene has no plan: its cast and its request (`focusText`, used as focus
 * and not rendered as a plan) replace the plan's.
 */
export function characterFidelityContext({ foundation, chapter, episodePlan, prevState, dynamics, previousSummary, kit, config = {}, history = [], cast: sceneCast, focusText }) {
  const cast = sceneCast ?? (episodePlan?.cast?.length ? episodePlan.cast : []);
  const plan = focusText == null ? renderEpisodePlan(episodePlan, kit) : '';
  return [
    plan,
    renderSceneCharacterPacket({ projection: dynamics, cast, pressure: episodePlan?.scenePressure?.decisionDeadline ?? '', episodePlan, kit }),
    // The same tracking switches, pinned items and record history the writer saw.
    renderCurrentState(prevState, foundation, { cast, kit, mode: 'writer', focusText: focusText ?? plan, hookIds: episodePlan?.hooksTouched ?? [], config, history }),
    previousSummary?.summary ? kit.phrases.sections.previousSummary(previousSummary.chapterNumber, previousSummary.summary) : '',
  ].filter(Boolean).join('\n\n');
}

export async function runCharacterFidelity({ prose, chapter, foundation, context, episodePlan = null, prevState = null, dynamics = null, previousSummary = null, config = {}, history = [], cast, focusText, providers, kit: kitSource }) {
  const kit = asKit(kitSource ?? { foundation });
  const castText = renderCharacters(foundation, cast ?? episodePlan?.cast ?? [], chapter, kit, { appearance: false, description: true });
  const contextText = context ?? characterFidelityContext({ foundation, chapter, episodePlan, prevState, dynamics, previousSummary, kit, config, history, cast, focusText });
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'character-fidelity',
    messages: kit.messages('character-fidelity', { chapter, castText, context: contextText, prose }),
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
