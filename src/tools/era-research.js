import { runEraResearch } from '../../engine/src/core/era-research.js';
import { resolveWorkKit } from '../prompts/index.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };

function parseFinding(raw) {
  try {
    const value = JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim());
    if (!['supports', 'contradicts', 'uncertain'].includes(value?.verdict)) return null;
    return {
      verdict: value.verdict,
      explanation: typeof value.explanation === 'string' ? value.explanation : '',
      sources: Array.isArray(value.sources) ? value.sources.filter((item) => typeof item === 'string').slice(0, 5) : [],
    };
  } catch { return null; }
}

export async function runEraResearchTool({ store, workId, chapter, era, claims, maxCalls, providers }) {
  const foundation = await store.loadFoundation(workId);
  if (!foundation) throw new Error('작품이 없습니다.');
  const resolvedEra = era ?? foundation.worldEra;
  if (!resolvedEra) throw new Error('시대 정보가 없습니다. era를 넘기거나 world/setting.md의 worldEra를 설정하세요.');
  const cleanClaims = (claims ?? []).map(String).map((s) => s.trim()).filter(Boolean);
  if (cleanClaims.length === 0) throw new Error('검증할 시대 고증 주장(claims)이 필요합니다.');

  const kit = await resolveWorkKit({ store, workId, foundation });
  const provider = {
    provider: 'host-llm',
    async research({ era: targetEra, claim, chapterNumber }) {
      const response = await providers.complete({
        model: MODEL,
        jsonMode: true,
        step: 'era-research',
        messages: kit.messages('era-research', { era: targetEra, chapter: chapterNumber, claim }),
      });
      return parseFinding(response.text);
    },
  };
  const result = await runEraResearch({
    era: resolvedEra, chapterNumber: chapter, claims: cleanClaims, provider,
    budget: { maxCalls: Math.max(1, Math.min(Number(maxCalls ?? cleanClaims.length), 10)), used: 0 },
  });
  return { era: resolvedEra, checked: result.budgetAfter.used, ...result };
}
