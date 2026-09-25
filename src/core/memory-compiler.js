import { createHash } from 'node:crypto';
import { budgetEstimator } from './token-units.js';

const fail = (code, message, details = {}) => ({ ok: false, error: { code, message, ...details } });
// ko(와 계열 미지정 구형 호출)는 기존 code point / 2 그대로, 다른 계열은 tokenUnits().
const legacyTokens = (value) => Math.max(1, Math.ceil([...String(value ?? '')].length / 2));
const terms = (value) => [...new Set(String(value ?? '').toLocaleLowerCase('ko').match(/[가-힣a-z0-9_]{2,}/g) ?? [])];
const hash = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

function validateContext(context) {
  const required = ['snapshotId', 'expectedHead', 'storyTimeScope', 'publicationOrder', 'transactionTime', 'policyRevision', 'semanticGeneration', 'fencingToken'];
  const missing = required.filter((key) => context?.[key] === undefined || context?.[key] === null);
  if (missing.length) return fail('invalid_execution_context', 'ExecutionContext가 불완전합니다.', { missing });
  if (context.snapshotId !== context.expectedHead) return fail('stale_snapshot', '기준 snapshot이 현재 예상 HEAD와 다릅니다.');
  return null;
}

function score(candidate, queryTerms) {
  const haystack = terms(candidate.text);
  const matches = queryTerms.filter((term) => haystack.some((word) => word === term || word.includes(term) || term.includes(word))).length;
  return matches * 1000 + Number(candidate.priority ?? 0) * 10 + Math.min(Number(candidate.chapter ?? 0), 999999) / 1000000;
}

/** Deep MemoryCompiler seam: mandatory canon, ranked memory, budget and audit lineage. */
export function compileMemory(context, input) {
  const invalid = validateContext(context);
  if (invalid) return invalid;
  const tokens = budgetEstimator(input?.promptFamily, legacyTokens);
  const budget = input?.budget ?? {};
  const maxTokens = Number(budget.maxTokens);
  const reservedTokens = Number(budget.reservedTokens ?? 0);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0 || reservedTokens < 0 || reservedTokens >= maxTokens) {
    return fail('invalid_context_budget', '유효한 전체 토큰 예산과 예약량이 필요합니다.');
  }

  const mandatory = (input.mandatory ?? []).filter((item) => item?.active !== false);
  const mandatoryTokens = mandatory.reduce((sum, item) => sum + tokens(item.text), 0);
  const available = maxTokens - reservedTokens;
  if (mandatoryTokens > available) {
    return fail('context_overflow', 'Mandatory Recall Set을 손실 없이 넣을 수 없습니다.', {
      mandatoryTokens, availableTokens: available, recovery: 'split_scene_or_replan', mandatoryIds: mandatory.map((item) => item.id),
    });
  }

  const queryTerms = terms(input.query);
  const ranked = (input.candidates ?? [])
    .filter((candidate) => candidate?.text && !mandatory.some((item) => item.id === candidate.id))
    .map((candidate) => ({ ...candidate, score: score(candidate, queryTerms), tokenCost: tokens(candidate.text) }))
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  let remaining = available - mandatoryTokens;
  const discretionary = [];
  let boundaryWitness = null;
  for (const candidate of ranked) {
    if (candidate.score <= 0 || candidate.tokenCost > remaining) {
      boundaryWitness ??= { id: candidate.id, score: candidate.score, reason: candidate.score <= 0 ? 'no_query_match' : 'budget_boundary' };
      continue;
    }
    discretionary.push(candidate);
    remaining -= candidate.tokenCost;
  }

  const lineage = {
    snapshotId: context.snapshotId, storyTimeScope: context.storyTimeScope, publicationOrder: context.publicationOrder,
    query: input.query ?? '', queryTerms, predicate: input.scope ?? {}, indexGeneration: input.indexGeneration ?? 'unversioned',
    tokenizerRevision: input.tokenizerRevision ?? 'unspecified', rankerRevision: input.rankerRevision ?? 'unspecified',
    candidateUniverseHash: hash((input.candidates ?? []).map(({ id, kind, scope, ref, chapter, textHash, sourceHashes, aggregateSourceDigest, evidenceAnchors, text }) => ({
      id, kind, scope, ref, chapter, textHash: textHash ?? hash(text), sourceHashes, aggregateSourceDigest, evidenceAnchors,
    }))),
    selected: discretionary.map(({ id, scope, ref, chapter, textHash, sourceHashes, aggregateSourceDigest, evidenceAnchors }) => ({
      id, scope, ref, chapter, textHash, sourceHashes, aggregateSourceDigest, evidenceAnchors,
    })),
    selectedIds: discretionary.map((item) => item.id), mandatoryIds: mandatory.map((item) => item.id),
    boundaryWitness: boundaryWitness ?? { id: null, reason: 'all_ranked_candidates_fit' },
  };
  return { ok: true, value: { mandatory, discretionary, lineage, usage: { maxTokens, reservedTokens, mandatoryTokens, discretionaryTokens: available - mandatoryTokens - remaining, remainingTokens: remaining } } };
}
