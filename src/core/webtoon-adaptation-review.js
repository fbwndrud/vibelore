import { digest, nonempty } from './webtoon-contract.js';
import { adaptationDigest, episodeCast } from './webtoon-episode.js';

export const ADAPTATION_REVIEW_CHECKS = ['readThrough', 'coreKept', 'showNotTell', 'pageFlow', 'fidelity'];
const STATUSES = ['passed', 'failed', 'uncertain'], SEVERITIES = ['blocking', 'advisory'];
/** showNotTell severity follows its kind: a text doing the drawing's job or an undrawable panel blocks, a text that only repeats the drawing does not. */
export const SHOW_NOT_TELL_KINDS = { replacesDrawing: 'blocking', undrawable: 'blocking', redundant: 'advisory' };
const TEXT_VERDICTS = ['carries', 'replacesDrawing', 'redundant'];

export const ADAPTATION_REVIEW_PROMPT = `You review a webtoon episode adaptation as a reader who has not read the novel. Two packets are attached: scriptOnly (cast, extras, and pages of panels with shows, bridge and texts) and sourceComparison (the source units and the editorial map). Judge readThrough from scriptOnly alone, never from memory of the source or from sourceComparison; only coreKept and fidelity may use sourceComparison. Cite concrete panel ids and quote the script as evidence.
Audit the whole script in one pass. For every check, read every page, panel and text, and list every instance you find as its own finding, never only the first or the clearest one; the next revision fixes only what this review lists.
Give every check a status of passed, failed or uncertain, the panel ids involved, and evidence. Uncertain never passes. A failed or uncertain check lists every panel it concerns, and a failed check has one finding per instance tagged with that check.
readThrough: can a reader follow motive, action, result from the script-only packet? Fail on a character who acts before any introduction, an action with no visible cause, an answer whose question was cut, or a pointing word with no referent.
coreKept: focus.primary and the key turns survive, and nothing the next episode needs is dropped without a carryForward.
showNotTell: give every text in checks.showNotTell.textAudit a verdict. carries: the text adds what the drawing cannot show, such as a voice, a thought, a name, a number or a time. replacesDrawing: the text states a key action, motive or result that the drawing must carry and the panel's shows do not. redundant: the text only repeats what the shows already deliver. Each replacesDrawing or redundant text belongs to a showNotTell finding of that kind that lists it in textIds; a panel whose shows a single image cannot deliver is a finding of kind undrawable. replacesDrawing and undrawable are blocking; redundant is advisory polish and never fails the check.
pageFlow: each page has one purpose, and each pageTurn pulls the reader forward.
fidelity: fail when facts, speakers or disclosure timing contradict the source. An addition that changes no fact is advisory.
findings: each finding names its check, severity, panels and evidence; a showNotTell finding also names its kind and textIds. blocking means the adaptation must be revised; advisory is taste or minor polish and never forces a revision. Any failed check or any blocking finding fails the review. List the panel ids a finding concerns; leave panels empty only for an episode-wide finding.
Re-review: when previousReview and panelDiff are attached, first re-check the changed and added panels and every earlier finding, then audit the rest. An unchanged panel that was clean in previousReview keeps its verdict unless you can say why: a blocking finding whose panels are all such panels must explain in newOnUnchanged what the earlier review missed or what changed around them, or it is recorded as advisory.`;

const panelsOf = w => w.adaptation.pages.flatMap(p => p.panels);
const textsOf = w => panelsOf(w).flatMap(p => p.texts);

/** Panels of `current` compared with `previous` by id: a panel changes when its shows, bridge, texts or its page's purpose or pageTurn change. */
export function adaptationPanelDiff(previous, current) {
  const signatures = a => new Map(a.pages.flatMap(page => page.panels.map(({ id, shows, bridge, texts }) => [id,
    digest({ purpose: page.purpose, pageTurn: page.pageTurn, shows, bridge, texts: texts.map(({ kind, speaker, text }) => ({ kind, speaker, text })) })])));
  const before = signatures(previous), after = signatures(current), diff = { changed: [], added: [], unchanged: [], removed: [] };
  for (const [id, sig] of after) diff[!before.has(id) ? 'added' : before.get(id) === sig ? 'unchanged' : 'changed'].push(id);
  for (const id of before.keys()) if (!after.has(id)) diff.removed.push(id);
  return diff;
}

/** On a revision: the previous review (verdicts and findings, no bookkeeping) and how the panels changed since it. */
function reReviewBasis(w) {
  const previous = w.previousFindings;
  if (!previous?.checks || !w.previousAdaptation) return null;
  return {
    previousReview: { checks: Object.fromEntries(Object.entries(previous.checks).map(([key, { status, panels, evidence }]) => [key, { status, panels, evidence }])),
      findings: previous.findings ?? [] },
    panelDiff: adaptationPanelDiff(w.previousAdaptation, w.adaptation),
  };
}

export function adaptationReviewPackets(w) {
  return {
    scriptOnly: {
      cast: episodeCast(w.source).map(({ id, name, appearance }) => ({ id, name, appearance })),
      extras: w.adaptation.extras,
      pages: w.adaptation.pages.map(({ id, purpose, pageTurn, panels }) => ({ id, purpose, pageTurn,
        panels: panels.map(({ id, shows, bridge, texts }) => ({ id, shows, bridge, texts })) })),
    },
    sourceComparison: { units: w.units, editorial: w.adaptation.editorial },
    ...reReviewBasis(w),
  };
}

const subjectHash = w => digest({ adaptation: adaptationDigest(w.adaptation), sourceHash: w.source.hash });

export function adaptationReviewSchema(w) {
  return {
    subjectHash: subjectHash(w),
    checks: Object.fromEntries(ADAPTATION_REVIEW_CHECKS.map(key => [key, { status: 'passed|failed|uncertain', panels: [], evidence: '',
      ...(key === 'showNotTell' ? { textAudit: textsOf(w).map(t => ({ id: t.id, verdict: TEXT_VERDICTS.join('|') })) } : {}) }])),
    findings: [], findingItem: { check: ADAPTATION_REVIEW_CHECKS.join('|'), severity: 'blocking|advisory', panels: ['panel-id'], evidence: '',
      kind: `showNotTell only: ${Object.keys(SHOW_NOT_TELL_KINDS).join('|')}`, textIds: ['showNotTell only: text-id'],
      ...(reReviewBasis(w) ? { newOnUnchanged: 'only for a blocking finding on unchanged panels that previousReview found clean' } : {}) },
    ...(w.adaptationReviewModel ? { reviewerEvidence: { modelId: '', responseId: '' } } : {}),
  };
}

/**
 * The server's reading of a structurally valid review: a showNotTell finding takes the severity of its kind, and on a re-review a
 * blocking finding confined to unchanged panels the previous review found clean becomes advisory unless it says why in newOnUnchanged.
 * A failed check whose every finding the server made advisory this way counts as passed and keeps `demotedFrom: 'failed'`.
 */
function normalizeReview(review, w) {
  const basis = reReviewBasis(w), unchanged = new Set(basis?.panelDiff.unchanged);
  const flagged = new Set(basis ? [...Object.values(basis.previousReview.checks).filter(c => c.status !== 'passed').flatMap(c => c.panels ?? []),
    ...basis.previousReview.findings.filter(f => f.severity === 'blocking').flatMap(f => f.panels ?? [])] : []);
  const cleanBefore = panels => basis && panels.length > 0 && panels.every(id => unchanged.has(id) && !flagged.has(id));
  const findings = review.findings.map(f => {
    let next = f.check === 'showNotTell' ? { ...f, severity: SHOW_NOT_TELL_KINDS[f.kind] } : f;
    if (f.severity === 'blocking' && next.severity === 'advisory') next = { ...next, demoted: 'redundant' };
    if (next.severity === 'blocking' && cleanBefore(next.panels) && !nonempty(next.newOnUnchanged)) next = { ...next, severity: 'advisory', demoted: 'unexplainedOnUnchanged' };
    return next;
  });
  const checks = Object.fromEntries(ADAPTATION_REVIEW_CHECKS.map(key => {
    const c = review.checks[key], own = findings.filter(f => f.check === key);
    if (c.status === 'failed' && !own.length) throw new Error(`INCOMPLETE_ADAPTATION_REVIEW: ${key}`);
    const serverAdvisory = f => f.demoted || (key === 'showNotTell' && f.kind === 'redundant');
    return [key, c.status === 'failed' && own.every(serverAdvisory) ? { ...c, status: 'passed', demotedFrom: 'failed' } : c];
  }));
  return { ...review, checks, findings };
}

/** Every text is audited once, and each text judged replacesDrawing or redundant is listed by a showNotTell finding of that kind, and only those. */
function auditComplete(review, w) {
  const audit = review.checks.showNotTell.textAudit, ids = textsOf(w).map(t => t.id);
  if (!Array.isArray(audit) || audit.length !== ids.length || audit.some(a => !TEXT_VERDICTS.includes(a?.verdict))
    || new Set(audit.map(a => a?.id)).size !== ids.length || ids.some(id => !audit.some(a => a.id === id))) return false;
  const listed = kind => review.findings.filter(f => f.check === 'showNotTell' && f.kind === kind).flatMap(f => f.textIds).sort().join('\n');
  return ['replacesDrawing', 'redundant'].every(kind => listed(kind) === audit.filter(a => a.verdict === kind).map(a => a.id).sort().join('\n'));
}

/**
 * Throws on a stale or malformed review. Returns the review as the server reads it, and passes only when every check passed and no
 * finding blocks after that reading.
 */
export function validateAdaptationReview(review, w) {
  if (review?.subjectHash !== subjectHash(w)) throw new Error('STALE_ADAPTATION_REVIEW');
  const known = new Set(panelsOf(w).map(p => p.id)), knownTexts = new Set(textsOf(w).map(t => t.id));
  const knownPanels = list => Array.isArray(list) && list.every(id => known.has(id));
  for (const key of ADAPTATION_REVIEW_CHECKS) {
    const c = review.checks?.[key];
    if (!STATUSES.includes(c?.status) || !nonempty(c.evidence) || !knownPanels(c.panels) || (c.status !== 'passed' && !c.panels.length)) {
      throw new Error(`INCOMPLETE_ADAPTATION_REVIEW: ${key}`);
    }
  }
  const findings = review.findings ?? [];
  const validFinding = f => SEVERITIES.includes(f?.severity) && ADAPTATION_REVIEW_CHECKS.includes(f.check) && nonempty(f.evidence) && knownPanels(f.panels ?? [])
    && (f.check !== 'showNotTell' || (Object.hasOwn(SHOW_NOT_TELL_KINDS, f.kind ?? '') && Array.isArray(f.textIds ?? [])
      && (f.textIds ?? []).every(id => knownTexts.has(id)) && (f.kind === 'undrawable' || f.textIds?.length > 0)));
  if (!Array.isArray(findings) || !findings.every(validFinding)) throw new Error('INVALID_ADAPTATION_FINDING');
  // kind and textIds belong to showNotTell; on other checks they are template echoes and are dropped.
  const shaped = { ...review, findings: findings.map(({ kind, textIds, ...f }) => ({ ...f, panels: f.panels ?? [], ...(f.check === 'showNotTell' ? { kind, textIds: textIds ?? [] } : {}) })) };
  if (!auditComplete(shaped, w)) throw new Error('INCOMPLETE_ADAPTATION_REVIEW: showNotTell');
  const model = w.adaptationReviewModel;
  if (model && (review.reviewerEvidence?.modelId !== model.modelId || !nonempty(review.reviewerEvidence?.responseId))) {
    throw new Error('ADAPTATION_REVIEWER_EVIDENCE_REQUIRED');
  }
  const normalized = normalizeReview(shaped, w);
  return {
    passed: ADAPTATION_REVIEW_CHECKS.every(key => normalized.checks[key].status === 'passed') && !normalized.findings.some(f => f.severity === 'blocking'),
    independence: model ? 'configured-model' : 'same-host',
    review: normalized,
  };
}
