import { digest, nonempty } from './webtoon-contract.js';
import { adaptationDigest, episodeCast } from './webtoon-episode.js';

export const ADAPTATION_REVIEW_CHECKS = ['readThrough', 'coreKept', 'showNotTell', 'pageFlow', 'fidelity'];
const STATUSES = ['passed', 'failed', 'uncertain'], SEVERITIES = ['blocking', 'advisory'];

export const ADAPTATION_REVIEW_PROMPT = `You review a webtoon episode adaptation as a reader who has not read the novel. Two packets are attached: scriptOnly (cast, extras, and pages of panels with shows, bridge and texts) and sourceComparison (the source units and the editorial map). Judge readThrough from scriptOnly alone, never from memory of the source or from sourceComparison; only coreKept and fidelity may use sourceComparison. Cite concrete panel ids and quote the script as evidence.
Give every check a status of passed, failed or uncertain, the panel ids involved, and evidence. Uncertain never passes. A failed or uncertain check must list at least one panel id.
readThrough: can a reader follow motive, action, result from the script-only packet? Fail on a character who acts before any introduction, an action with no visible cause, an answer whose question was cut, or a pointing word with no referent.
coreKept: focus.primary and the key turns survive, and nothing the next episode needs is dropped without a carryForward.
showNotTell: fail when text explains what the drawing could carry, or when a panel's shows cannot be delivered by a single image.
pageFlow: each page has one purpose, and each pageTurn pulls the reader forward.
fidelity: fail when facts, speakers or disclosure timing contradict the source. An addition that changes no fact is advisory.
findings: blocking means the adaptation must be revised; advisory is taste or minor polish and never forces a revision. Any failed check or any blocking finding fails the review. List the panel ids a finding concerns; leave panels empty only for an episode-wide finding.`;

const panelsOf = w => w.adaptation.pages.flatMap(p => p.panels);

export function adaptationReviewPackets(w) {
  return {
    scriptOnly: {
      cast: episodeCast(w.source).map(({ id, name, appearance }) => ({ id, name, appearance })),
      extras: w.adaptation.extras,
      pages: w.adaptation.pages.map(({ id, purpose, pageTurn, panels }) => ({ id, purpose, pageTurn,
        panels: panels.map(({ id, shows, bridge, texts }) => ({ id, shows, bridge, texts })) })),
    },
    sourceComparison: { units: w.units, editorial: w.adaptation.editorial },
  };
}

const subjectHash = w => digest({ adaptation: adaptationDigest(w.adaptation), sourceHash: w.source.hash });

export function adaptationReviewSchema(w) {
  return {
    subjectHash: subjectHash(w),
    checks: Object.fromEntries(ADAPTATION_REVIEW_CHECKS.map(key => [key, { status: 'passed|failed|uncertain', panels: [], evidence: '' }])),
    findings: [], findingItem: { severity: 'blocking|advisory', panels: ['panel-id'], evidence: '' },
    ...(w.adaptationReviewModel ? { reviewerEvidence: { modelId: '', responseId: '' } } : {}),
  };
}

/** Throws on a stale or malformed review; passes only when every check passed and no finding blocks. */
export function validateAdaptationReview(review, w) {
  if (review?.subjectHash !== subjectHash(w)) throw new Error('STALE_ADAPTATION_REVIEW');
  const known = new Set(panelsOf(w).map(p => p.id));
  const knownPanels = list => Array.isArray(list) && list.every(id => known.has(id));
  for (const key of ADAPTATION_REVIEW_CHECKS) {
    const c = review.checks?.[key];
    if (!STATUSES.includes(c?.status) || !nonempty(c.evidence) || !knownPanels(c.panels) || (c.status !== 'passed' && !c.panels.length)) {
      throw new Error(`INCOMPLETE_ADAPTATION_REVIEW: ${key}`);
    }
  }
  const findings = review.findings ?? [];
  if (!Array.isArray(findings) || findings.some(f => !SEVERITIES.includes(f?.severity) || !nonempty(f.evidence) || !knownPanels(f.panels ?? []))) {
    throw new Error('INVALID_ADAPTATION_FINDING');
  }
  const model = w.adaptationReviewModel;
  if (model && (review.reviewerEvidence?.modelId !== model.modelId || !nonempty(review.reviewerEvidence?.responseId))) {
    throw new Error('ADAPTATION_REVIEWER_EVIDENCE_REQUIRED');
  }
  return {
    passed: ADAPTATION_REVIEW_CHECKS.every(key => review.checks[key].status === 'passed') && !findings.some(f => f.severity === 'blocking'),
    independence: model ? 'configured-model' : 'same-host',
  };
}
