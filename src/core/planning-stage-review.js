import { createHash } from 'node:crypto';
import { requireLore } from '../../engine/src/lore/schemas.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = raw => { try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); } catch { return null; } };
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const SUGGESTIONS = new Set(['promptGuidance', 'voiceContract', 'authorCraft', 'storyDramaturgy', 'stageReview', 'quality', 'designReview']);
/** Craft suggestions remain visible, but cannot supply a blocking contract quote. */
export function planningAuthority(value) {
  if (Array.isArray(value)) return value.map(planningAuthority);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SUGGESTIONS.has(key)).map(([key, item]) => [key, planningAuthority(item)]));
}
// Transient timestamps must not create a different relay request on resume.
const reviewable = ({ createdAt, updatedAt, stageReview, ...value }) => value;
export const STAGE_REVIEW_FOCUS = Object.freeze({
  story: ['reader-promise', 'character-agency', 'causal-change', 'ending-and-cost', 'world-consequences'],
  arc: ['parent-promise', 'escalation-and-payoff', 'independent-agendas', 'state-and-knowledge', 'next-arc-cost'],
  episode: ['whole-story-promise', 'entry-to-exit-change', 'goal-obstacle-choice', 'scene-causality', 'viewpoint-and-exposition', 'payoff-and-next-question'],
});

/** Separate model review, bounded revision, then review the actual replacement. */
export async function reviewPlanningStage({ stage, profile, candidate, context, providers, kit, rebuild, selection }) {
  if (selection?.enabled === false) return { ok: true, candidate, stageReview: {
    schemaVersion: 1, stage, verdict: 'disabled_by_user', attempts: [], contextHash: hash(context),
    reviewPolicyRevision: selection.revision ?? 0,
    profileRevision: profile?.revision ?? null, independence: 'not-established',
  } };
  if (selection?.semantic !== true && (!profile?.discovery || profile.discovery.authority === 'legacy')) return { ok: true, candidate };
  requireLore(STAGE_REVIEW_FOCUS[stage], 'INVALID_PLANNING_STAGE', stage);
  const authority = planningAuthority(context);
  const sourceQuotes = strings(authority);
  const hasSourceQuote = quote => typeof quote === 'string' && quote.trim() && sourceQuotes.some(text => text.includes(quote));
  let current = candidate;
  const attempts = [];
  for (let attempt = 0; attempt <= 1; attempt++) {
    const response = await providers.complete({ model: MODEL, jsonMode: true, step: `${stage}-plan-review`,
      messages: kit.messages('planning-stage-review', { stage, focus: STAGE_REVIEW_FOCUS[stage],
        preference: profile?.discovery ?? null, context, authority, candidate: reviewable(current) }) });
    if ((providers.pending?.length ?? 0) > 0) return { preview: true };
    const validate = review => {
      requireLore(review && Array.isArray(review.checks) && Array.isArray(review.findings), 'INVALID_PLANNING_REVIEW', 'checks and findings are required');
      requireLore(review.checks.length === STAGE_REVIEW_FOCUS[stage].length && STAGE_REVIEW_FOCUS[stage].every(focus => review.checks.some(c => c?.focus === focus
        && ['met', 'gap', 'not_applicable'].includes(c.result) && typeof c.evidence === 'string' && c.evidence.trim())),
      'INVALID_PLANNING_REVIEW', 'every stage focus needs a grounded result');
      requireLore(review.findings.every(f => f && typeof f.id === 'string' && f.id.trim()
        && typeof f.evidence === 'string' && f.evidence.trim() && typeof f.reason === 'string' && f.reason.trim()
        && ['repair', 'advisory', 'upstream', 'research'].includes(f.action)
        && (f.action !== 'repair' || hasSourceQuote(f.contractEvidence) && typeof f.revision === 'string' && f.revision.trim()))
        && new Set(review.findings.map(f => f.id)).size === review.findings.length,
      'INVALID_PLANNING_REVIEW', 'repairs need the actual requirement and an actionable revision; taste remains advisory');
      requireLore(!review.checks.some(c => c.result === 'gap') || review.findings.length > 0, 'INVALID_PLANNING_REVIEW', 'gaps need findings');
      return review;
    };
    let review = parse(response.text);
    const responseRepairs = [];
    try { validate(review); } catch (error) {
      const corrected = await providers.complete({ model: MODEL, jsonMode: true, step: `${stage}-plan-review-response-repair`,
        messages: kit.messages('planning-review-response-repair', { stage, focus: STAGE_REVIEW_FOCUS[stage], context: authority,
          candidate: reviewable(current), invalidResponse: response.text, error: error.message }) });
      if ((providers.pending?.length ?? 0) > 0) return { preview: true };
      review = validate(parse(corrected.text));
      responseRepairs.push({ originalHash: hash(response.text), correctedHash: hash(corrected.text), error: error.code });
    }
    const escalations = review.findings.filter(f => ['upstream', 'research'].includes(f.action));
    let escalationAudit = null;
    if (escalations.length) {
      const verified = await providers.complete({ model: MODEL, jsonMode: true, step: `${stage}-plan-escalation-review`,
        messages: kit.messages('planning-escalation-review', { stage, context: authority, candidate: reviewable(current), findings: escalations }) });
      if ((providers.pending?.length ?? 0) > 0) return { preview: true };
      const audit = parse(verified.text);
      const candidateQuotes = strings(reviewable(current));
      requireLore(Array.isArray(audit?.findings) && audit.findings.length === escalations.length && audit.findings.every(f => f && typeof f.id === 'string') && new Set(audit.findings.map(f => f.id)).size === escalations.length
        && escalations.every(f => audit.findings.some(a => a.id === f.id)), 'INVALID_PLANNING_REVIEW', 'escalation audit must cover each finding exactly once');
      requireLore(audit.findings.every(f => ['repair', 'advisory', 'upstream', 'research'].includes(f.action) && typeof f.reason === 'string' && f.reason.trim()
        && (f.action === 'advisory' || hasSourceQuote(f.contractEvidence)
          && typeof f.candidateEvidence === 'string' && f.candidateEvidence.trim() && candidateQuotes.some(text => text.includes(f.candidateEvidence)))
        && (f.action !== 'repair' || typeof f.revision === 'string' && f.revision.trim())), 'INVALID_PLANNING_REVIEW', 'escalation needs actual parent and candidate evidence');
      escalationAudit = audit.findings;
      review = { ...review, findings: review.findings.map(f => {
        const decision = audit.findings.find(a => a.id === f.id);
        return decision ? { ...f, ...decision, originalAction: f.action } : f;
      }) };
    }
    const repairs = review.findings.filter(f => f.action === 'repair');
    const external = review.findings.filter(f => ['upstream', 'research'].includes(f.action));
    attempts.push({ attempt, candidateHash: hash(reviewable(current)), checks: review.checks, findings: review.findings,
      ...(responseRepairs.length ? { responseRepairs } : {}), ...(escalationAudit ? { escalationAudit } : {}) });
    const record = { schemaVersion: 1, stage, profileRevision: profile?.revision ?? null,
      reviewPolicyRevision: selection?.revision ?? 0,
      preference: profile?.discovery ? structuredClone(profile.discovery) : null, contextHash: hash(context), attempts,
      verdict: repairs.length || external.length ? 'revision_required' : 'reviewed', reviewer: 'host-model', independence: 'not-established' };
    if (external.length) return { ok: false, status: 'needs_revision', code: 'PLANNING_UPSTREAM_REQUIRED', needsRevision: true,
      candidate: { ...current, status: 'pending', stageReview: record }, details: { stage, findings: external },
      instruction: '하위 계획에서 상위 사실을 바꾸지 마세요. 근거를 보여 주고 필요한 조사 또는 상위 단계 수정·영향 검토를 먼저 진행한 뒤 같은 계획 단계를 재개하세요.' };
    if (!repairs.length) return { ok: true, candidate: current, stageReview: record };
    if (attempt === 1) return { ok: false, status: 'needs_revision', code: 'PLANNING_REVISION_REQUIRED', needsRevision: true,
      candidate: { ...current, status: 'pending', stageReview: record }, details: { stage, repairs },
      instruction: '검토 근거와 후보를 보여 주세요. 같은 계획 도구에 feedback으로 수정 방향을 전달해 재검토하며, 상위 설정 변경은 해당 단계부터 검토하세요.' };
    const revised = await providers.complete({ model: MODEL, jsonMode: true, step: `${stage}-plan-revision`,
      messages: kit.messages('planning-stage-revision', { stage, context, candidate: reviewable(current), repairs }) });
    if ((providers.pending?.length ?? 0) > 0) return { preview: true };
    const parsed = parse(revised.text);
    requireLore(parsed && !Array.isArray(parsed) && typeof parsed === 'object', 'INVALID_PLANNING_REVISION', 'return the complete revised plan');
    current = rebuild(parsed);
  }
}
