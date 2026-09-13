import { asKit } from '../prompts/index.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const INDEPENDENT_ADVISORY_CODES = new Set(['CLEAN_CONFLICT_RESET']);
const MIN_FINDING_CONFIDENCE = 0.8;

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

/**
 * @param {{ kit?: object|null }} input 워크플로가 작품 계약을 넘기기 전까지는
 *   구작의 암묵적 ko 계열로 해석한다(기존 동작).
 */
export async function runEditorialQuality({ prose, context, providers, kit: kitSource }) {
  const kit = asKit(kitSource);
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'editorial-quality',
    messages: kit.messages('editorial-quality', { context, prose }),
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
