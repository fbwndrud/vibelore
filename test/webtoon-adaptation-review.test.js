import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { ADAPTATION_REVIEW_CHECKS, ADAPTATION_REVIEW_PROMPT, adaptationPanelDiff, adaptationReviewPackets, adaptationReviewSchema, validateAdaptationReview } from '../src/core/webtoon-adaptation-review.js';
import { reviewWorkflow, withPages } from './fixtures/webtoon-episode.js';

const units = [{ id: 'u1', text: '"문 열어." 그녀가 말했다.' }, { id: 'u2', text: '대답은 없었다.' }, { id: 'u3', text: '손잡이가 차가웠다.' }];
const w = reviewWorkflow(units);
/** A failed check gets one blocking finding tagged with it unless `extra.findings` says otherwise; every text carries unless `verdicts` says otherwise. */
const reviewWith = (statuses = {}, extra = {}, world = w, verdicts = {}) => ({
  subjectHash: adaptationReviewSchema(world).subjectHash,
  checks: Object.fromEntries(ADAPTATION_REVIEW_CHECKS.map(key => [key, { status: statuses[key] ?? 'passed', panels: statuses[key] && statuses[key] !== 'passed' ? ['p1-1'] : [], evidence: `${key} 근거`,
    ...(key === 'showNotTell' ? { textAudit: adaptationReviewSchema(world).checks.showNotTell.textAudit.map(({ id }) => ({ id, verdict: verdicts[id] ?? 'carries' })) } : {}) }])),
  findings: Object.entries(statuses).filter(([key, status]) => status === 'failed' && key !== 'showNotTell').map(([check]) => ({ check, severity: 'blocking', panels: ['p1-1'], evidence: `${check} 결함` })),
  ...extra,
});
const withModel = { ...w, adaptationReviewModel: { provider: 'host', modelId: 'gpt-6.1-terra' } };

test('script-only packet carries no source prose', () => {
  const { scriptOnly, sourceComparison } = adaptationReviewPackets(w);
  assert.equal(JSON.stringify(scriptOnly).includes(w.units[1].text), false);
  assert.ok(scriptOnly.pages[0].panels[0].shows);
  assert.equal('units' in scriptOnly, false);
  assert.equal(JSON.stringify(scriptOnly).includes('readerDelta'), false);
  assert.deepEqual(scriptOnly.cast, [{ id: 'c1', name: '윤', appearance: '짧은 머리' }]);
  assert.deepEqual(Object.keys(scriptOnly.pages[0].panels[0]), ['id', 'shows', 'bridge', 'texts']);
  assert.deepEqual(sourceComparison, { units: w.units, editorial: w.adaptation.editorial });
});

test('uncertain does not pass', () => assert.equal(validateAdaptationReview(reviewWith({ readThrough: 'uncertain' }), w).passed, false));
test('a failed check or a blocking finding fails; an advisory finding does not', () => {
  assert.equal(validateAdaptationReview(reviewWith({ fidelity: 'failed' }), w).passed, false);
  const finding = severity => ({ findings: [{ check: 'pageFlow', severity, panels: ['p1-2'], evidence: '근거' }] });
  assert.equal(validateAdaptationReview(reviewWith({}, finding('blocking')), w).passed, false);
  assert.equal(validateAdaptationReview(reviewWith({}, finding('advisory')), w).passed, true);
  assert.equal(validateAdaptationReview(reviewWith({}, { findings: [{ check: 'coreKept', severity: 'blocking', panels: [], evidence: '전체 흐름' }] }), w).passed, false);
});
test('all passed with no blocking passes and is labelled same-host without a configured model', () => {
  const { passed, independence, review } = validateAdaptationReview(reviewWith({}), w);
  assert.deepEqual({ passed, independence }, { passed: true, independence: 'same-host' }); assert.deepEqual(review, reviewWith({}));
});
test('configured reviewer requires matching evidence', () => {
  const wm = withModel;
  assert.throws(() => validateAdaptationReview(reviewWith({}), wm), /ADAPTATION_REVIEWER_EVIDENCE_REQUIRED/);
  assert.throws(() => validateAdaptationReview(reviewWith({}, { reviewerEvidence: { modelId: 'other', responseId: 'resp_1' } }), wm), /ADAPTATION_REVIEWER_EVIDENCE_REQUIRED/);
  assert.throws(() => validateAdaptationReview(reviewWith({}, { reviewerEvidence: { modelId: 'gpt-6.1-terra', responseId: ' ' } }), wm), /ADAPTATION_REVIEWER_EVIDENCE_REQUIRED/);
  assert.equal(validateAdaptationReview(reviewWith({}, { reviewerEvidence: { modelId: 'gpt-6.1-terra', responseId: 'resp_1' } }), wm).independence, 'configured-model');
});
test('stale subject and missing panels on a failed check throw', () => {
  assert.throws(() => validateAdaptationReview({ ...reviewWith({}), subjectHash: 'sha256:old' }, w), /STALE_ADAPTATION_REVIEW/);
  const changed = { ...w, source: { ...w.source, hash: 'sha256:other' } };
  assert.throws(() => validateAdaptationReview(reviewWith({}), changed), /STALE_ADAPTATION_REVIEW/);
  const review = reviewWith({ readThrough: 'failed' });
  review.checks.readThrough.panels = [];
  assert.throws(() => validateAdaptationReview(review, w), /INCOMPLETE_ADAPTATION_REVIEW: readThrough/);
  assert.throws(() => validateAdaptationReview(review, w), /INCOMPLETE_ADAPTATION_REVIEW: readThrough/);
});
test('missing check, bad status, empty evidence and unknown panel are incomplete', () => {
  const mutate = fn => { const r = reviewWith({}); fn(r); return r; };
  const incomplete = (r, key) => assert.throws(() => validateAdaptationReview(r, w), new RegExp(`INCOMPLETE_ADAPTATION_REVIEW: ${key}`));
  incomplete(mutate(r => delete r.checks.coreKept), 'coreKept');
  incomplete(mutate(r => { r.checks.showNotTell.status = 'ok'; }), 'showNotTell');
  incomplete(mutate(r => { r.checks.pageFlow.evidence = ' '; }), 'pageFlow');
  incomplete(mutate(r => { r.checks.fidelity.panels = ['p9-9']; }), 'fidelity');
});
test('findings need a known severity, evidence and known panels', () => {
  const bad = finding => assert.throws(() => validateAdaptationReview(reviewWith({}, { findings: [finding] }), w), /INVALID_ADAPTATION_FINDING/);
  bad({ check: 'pageFlow', severity: 'major', panels: [], evidence: '근거' });
  bad({ check: 'pageFlow', severity: 'blocking', panels: [], evidence: '' });
  bad({ check: 'pageFlow', severity: 'advisory', panels: ['p9-9'], evidence: '근거' });
  bad({ severity: 'advisory', panels: ['p1-1'], evidence: '어느 검사인지 없다' });
  bad({ check: 'style', severity: 'advisory', panels: ['p1-1'], evidence: '근거' });
  bad({ check: 'showNotTell', severity: 'advisory', panels: ['p1-1'], textIds: ['t1-1'], evidence: '종류가 없다' });
  bad({ check: 'showNotTell', kind: 'toString', severity: 'advisory', panels: ['p1-1'], textIds: ['t1-1'], evidence: '근거' });
  bad({ check: 'showNotTell', kind: 'redundant', severity: 'advisory', panels: ['p1-1'], evidence: '어느 글자인지 없다' });
  bad({ check: 'showNotTell', kind: 'redundant', severity: 'advisory', panels: ['p1-1'], textIds: ['t9'], evidence: '근거' });
});
test('schema skeleton covers every check, findings and reviewer evidence only for a configured model', () => {
  const schema = adaptationReviewSchema(w);
  assert.deepEqual(Object.keys(schema.checks), ADAPTATION_REVIEW_CHECKS);
  assert.deepEqual(schema.findings, []);
  assert.ok(schema.findingItem);
  assert.equal('reviewerEvidence' in schema, false);
  assert.deepEqual(adaptationReviewSchema(withModel).reviewerEvidence, { modelId: '', responseId: '' });
});
test('prompt names every check and demands a script-only read-through', () => {
  for (const key of ADAPTATION_REVIEW_CHECKS) assert.ok(ADAPTATION_REVIEW_PROMPT.includes(key));
  assert.match(ADAPTATION_REVIEW_PROMPT, /scriptOnly alone/);
});

test('a failed check must list its instances as findings tagged with it', () => {
  assert.throws(() => validateAdaptationReview(reviewWith({ pageFlow: 'failed' }, { findings: [] }), w), /INCOMPLETE_ADAPTATION_REVIEW: pageFlow/);
  const other = { findings: [{ check: 'fidelity', severity: 'blocking', panels: ['p1-1'], evidence: '다른 검사' }] };
  assert.throws(() => validateAdaptationReview(reviewWith({ pageFlow: 'failed' }, other), w), /INCOMPLETE_ADAPTATION_REVIEW: pageFlow/);
  // Every instance is its own finding, and the revision feedback carries each one.
  const two = { findings: ['p1-1', 'p1-3'].map(id => ({ check: 'pageFlow', severity: 'blocking', panels: [id], evidence: `${id} 턴이 약하다` })) };
  const r = validateAdaptationReview(reviewWith({ pageFlow: 'failed' }, two), w);
  assert.equal(r.passed, false); assert.deepEqual(r.review.findings.map(f => f.panels[0]), ['p1-1', 'p1-3']);
  // kind and textIds on a check other than showNotTell are template echoes and are dropped.
  const echo = validateAdaptationReview(reviewWith({}, { findings: [{ check: 'pageFlow', kind: '', textIds: [], severity: 'advisory', panels: ['p1-1'], evidence: '근거' }] }), w);
  assert.deepEqual(echo.review.findings, [{ check: 'pageFlow', severity: 'advisory', panels: ['p1-1'], evidence: '근거' }]);
});

test('showNotTell audits every text once and each judged text is listed by a finding of that kind', () => {
  const wide = reviewWorkflow(units, { adaptation: withPages(reviewWorkflow(units).adaptation, 3) });
  const ids = adaptationReviewSchema(wide).checks.showNotTell.textAudit.map(a => a.id);
  assert.deepEqual(ids, ['t1-1-1', 't2-1-1', 't3-1-1']);
  const incomplete = r => assert.throws(() => validateAdaptationReview(r, wide), /INCOMPLETE_ADAPTATION_REVIEW: showNotTell/);
  const dropped = reviewWith({}, {}, wide); dropped.checks.showNotTell.textAudit.pop(); incomplete(dropped);
  const twice = reviewWith({}, {}, wide); twice.checks.showNotTell.textAudit[2] = { id: 't1-1-1', verdict: 'carries' }; incomplete(twice);
  const unjudged = reviewWith({}, {}, wide); unjudged.checks.showNotTell.textAudit[0].verdict = 'carries|replacesDrawing|redundant'; incomplete(unjudged);
  // A text judged redundant without a finding, or a finding naming a text the audit says carries, is incomplete.
  incomplete(reviewWith({}, {}, wide, { 't2-1-1': 'redundant' }));
  const stray = { findings: [{ check: 'showNotTell', kind: 'redundant', severity: 'advisory', panels: ['p3-1'], textIds: ['t3-1-1'], evidence: '근거' }] };
  incomplete(reviewWith({}, stray, wide, { 't2-1-1': 'redundant' }));
  const listed = { findings: [{ check: 'showNotTell', kind: 'redundant', severity: 'advisory', panels: ['p2-1'], textIds: ['t2-1-1'], evidence: '그림을 되풀이한다' }] };
  assert.equal(validateAdaptationReview(reviewWith({}, listed, wide, { 't2-1-1': 'redundant' }), wide).passed, true);
});

test('redundant text is advisory: a showNotTell failure made only of redundancy passes and says it was demoted', () => {
  const redundant = { check: 'showNotTell', kind: 'redundant', severity: 'blocking', panels: ['p1-1'], textIds: ['t1-1'], evidence: '“문 열어.”는 그림이 이미 보여 준다' };
  const r = validateAdaptationReview(reviewWith({ showNotTell: 'failed' }, { findings: [redundant] }, w, { 't1-1': 'redundant' }), w);
  assert.equal(r.passed, true);
  assert.deepEqual(r.review.findings, [{ ...redundant, severity: 'advisory', demoted: 'redundant' }]);
  assert.equal(r.review.checks.showNotTell.status, 'passed'); assert.equal(r.review.checks.showNotTell.demotedFrom, 'failed');
  // Text that replaces a key action the drawing must carry, or an undrawable panel, blocks whatever severity the reviewer wrote.
  const replaces = { ...redundant, kind: 'replacesDrawing', severity: 'advisory', evidence: '문을 여는 행동이 글로만 있다' };
  const blocked = validateAdaptationReview(reviewWith({ showNotTell: 'failed' }, { findings: [replaces] }, w, { 't1-1': 'replacesDrawing' }), w);
  assert.equal(blocked.passed, false); assert.equal(blocked.review.findings[0].severity, 'blocking'); assert.equal(blocked.review.checks.showNotTell.status, 'failed');
  const undrawable = { check: 'showNotTell', kind: 'undrawable', severity: 'blocking', panels: ['p1-2'], evidence: '두 시선을 번갈아 보는 칸은 한 그림이 아니다' };
  const mixed = validateAdaptationReview(reviewWith({ showNotTell: 'failed' }, { findings: [redundant, undrawable] }, w, { 't1-1': 'redundant' }), w);
  assert.equal(mixed.passed, false); assert.equal(mixed.review.checks.showNotTell.status, 'failed'); assert.equal(mixed.review.checks.showNotTell.demotedFrom, undefined);
  // The other checks keep their verdict: a fidelity failure with only an advisory finding the reviewer chose still fails.
  const own = validateAdaptationReview(reviewWith({ fidelity: 'failed' }, { findings: [{ check: 'fidelity', severity: 'advisory', panels: ['p1-1'], evidence: '근거' }] }), w);
  assert.equal(own.passed, false); assert.equal(own.review.checks.fidelity.status, 'failed');
});

test('the prompt asks for an exhaustive audit, redundancy as advisory and a diff-first re-review', () => {
  assert.match(ADAPTATION_REVIEW_PROMPT, /list every instance you find as its own finding/);
  assert.match(ADAPTATION_REVIEW_PROMPT, /redundant is advisory/);
  assert.match(ADAPTATION_REVIEW_PROMPT, /first re-check the changed and added panels and every earlier finding/);
  assert.match(ADAPTATION_REVIEW_PROMPT, /newOnUnchanged/);
});

test('incoming demotion cannot turn a first-review fidelity failure with an advisory finding into a pass', () => {
  const finding = { check: 'fidelity', severity: 'advisory', panels: ['p1-1'], evidence: '원문과 공개 시점이 다르다', demoted: 'unexplainedOnUnchanged' };
  const result = validateAdaptationReview(reviewWith({ fidelity: 'failed' }, { findings: [finding] }), w);
  assert.equal(result.passed, false);
  assert.equal(result.review.checks.fidelity.status, 'failed');
  assert.equal(Object.hasOwn(result.review.findings[0], 'demoted'), false);
});

test('echoed demotion cannot excuse a fidelity failure after its panel changes', () => {
  const clean = { ...w, previousAdaptation: w.adaptation, previousFindings: reviewWith({}) };
  const prior = validateAdaptationReview(reviewWith({ fidelity: 'failed' }, {}, clean), clean);
  assert.equal(prior.passed, true);
  assert.equal(prior.review.findings[0].demoted, 'unexplainedOnUnchanged');
  const adaptation = structuredClone(w.adaptation);
  adaptation.pages[0].panels[0].shows = '문이 열린 뒤의 빈 복도';
  const changed = { ...w, adaptation, previousAdaptation: w.adaptation, previousFindings: prior.review };
  const echoed = reviewWith({ fidelity: 'failed' }, { findings: prior.review.findings }, changed);
  echoed.checks.fidelity.demotedFrom = 'failed';
  const result = validateAdaptationReview(echoed, changed);
  assert.equal(result.passed, false);
  assert.equal(result.review.checks.fidelity.status, 'failed');
  assert.equal(Object.hasOwn(result.review.checks.fidelity, 'demotedFrom'), false);
  assert.equal(Object.hasOwn(result.review.findings[0], 'demoted'), false);
});

for (const kind of ['replacesDrawing', 'undrawable']) {
  test(`incoming demotion cannot clear the failed check for a blocking ${kind} finding`, () => {
    const finding = { check: 'showNotTell', kind, severity: 'advisory', panels: ['p1-1'],
      textIds: kind === 'replacesDrawing' ? ['t1-1'] : [], evidence: '그림으로 전달되지 않는 행동', demoted: 'redundant' };
    const verdicts = kind === 'replacesDrawing' ? { 't1-1': 'replacesDrawing' } : {};
    const result = validateAdaptationReview(reviewWith({ showNotTell: 'failed' }, { findings: [finding] }, w, verdicts), w);
    assert.equal(result.passed, false);
    assert.equal(result.review.findings[0].severity, 'blocking');
    assert.equal(result.review.checks.showNotTell.status, 'failed');
    assert.equal(Object.hasOwn(result.review.findings[0], 'demoted'), false);
    assert.equal(Object.hasOwn(result.review.checks.showNotTell, 'demotedFrom'), false);
  });
}

test('incoming check demotion is discarded while uncertainty and reviewer evidence survive', () => {
  const reviewerEvidence = { modelId: 'gpt-6.1-terra', responseId: 'resp_current' };
  const incoming = reviewWith({ readThrough: 'uncertain' }, { reviewerEvidence }, withModel);
  for (const check of Object.values(incoming.checks)) check.demotedFrom = 'failed';
  const result = validateAdaptationReview(incoming, withModel);
  assert.equal(result.passed, false);
  assert.equal(result.independence, 'configured-model');
  assert.deepEqual(result.review.reviewerEvidence, reviewerEvidence);
  assert.equal(result.review.checks.readThrough.status, 'uncertain');
  assert.equal(result.review.checks.readThrough.evidence, 'readThrough 근거');
  for (const check of Object.values(result.review.checks)) assert.equal(Object.hasOwn(check, 'demotedFrom'), false);
});

test('panel diff compares panel content and page framing by panel id', () => {
  const before = withPages(w.adaptation, 2), after = structuredClone(before);
  after.pages[0].panels[0].texts[0].text = '"열어."';
  after.pages[1].pageTurn = '다른 턴';
  after.pages[0].panels[1].id = 'p1-9';
  assert.deepEqual(adaptationPanelDiff(before, after), { changed: ['p1-1', 'p2-1', 'p2-2', 'p2-3'], added: ['p1-9'], unchanged: ['p1-3'], removed: ['p1-2'] });
  const renumbered = structuredClone(before); renumbered.pages[0].panels[0].texts[0].id = 'other-id';
  assert.deepEqual(adaptationPanelDiff(before, renumbered).changed, []);
});

describe('re-review', () => {
  const previousAdaptation = w.adaptation, adaptation = structuredClone(w.adaptation);
  adaptation.pages[0].panels[0].shows = '문을 두드리는 손';
  const previousFindings = { ...reviewWith({ pageFlow: 'failed' }, { findings: [{ check: 'pageFlow', severity: 'blocking', panels: ['p1-2'], evidence: '턴이 약하다' }] }), passed: false };
  previousFindings.checks.pageFlow.panels = ['p1-2'];
  const rw = reviewWorkflow(units, { adaptation, previousAdaptation, previousFindings });
  const blocking = (panels, extra = {}) => ({ findings: [{ check: 'readThrough', severity: 'blocking', panels, evidence: '원인이 안 보인다', ...extra }] });

  test('the request carries the previous review and the panel diff, and the schema asks for newOnUnchanged', () => {
    const packets = adaptationReviewPackets(rw);
    assert.deepEqual(packets.panelDiff, { changed: ['p1-1'], added: [], unchanged: ['p1-2', 'p1-3'], removed: [] });
    assert.deepEqual(packets.previousReview.checks.pageFlow, { status: 'failed', panels: ['p1-2'], evidence: 'pageFlow 근거' });
    assert.equal('textAudit' in packets.previousReview.checks.showNotTell, false);
    assert.equal(packets.previousReview.findings[0].evidence, '턴이 약하다');
    assert.ok(adaptationReviewSchema(rw).findingItem.newOnUnchanged);
    assert.equal('previousReview' in adaptationReviewPackets(w), false); assert.equal('newOnUnchanged' in adaptationReviewSchema(w).findingItem, false);
  });

  test('a new blocking finding on unchanged panels the previous review found clean needs a reason, or it is advisory', () => {
    const r = validateAdaptationReview(reviewWith({ readThrough: 'failed' }, blocking(['p1-3']), rw), rw);
    assert.equal(r.passed, true); assert.equal(r.review.findings[0].severity, 'advisory'); assert.equal(r.review.findings[0].demoted, 'unexplainedOnUnchanged');
    assert.equal(r.review.checks.readThrough.status, 'passed'); assert.equal(r.review.checks.readThrough.demotedFrom, 'failed');
    const reasoned = validateAdaptationReview(reviewWith({ readThrough: 'failed' }, blocking(['p1-3'], { newOnUnchanged: 'p1-1의 새 그림이 p1-3의 원인을 지웠다' }), rw), rw);
    assert.equal(reasoned.passed, false); assert.equal(reasoned.review.findings[0].severity, 'blocking');
  });

  test('changed panels and panels the previous review flagged may block without a reason', () => {
    assert.equal(validateAdaptationReview(reviewWith({ readThrough: 'failed' }, blocking(['p1-1']), rw), rw).passed, false);
    assert.equal(validateAdaptationReview(reviewWith({ readThrough: 'failed' }, blocking(['p1-2']), rw), rw).passed, false);
    assert.equal(validateAdaptationReview(reviewWith({ readThrough: 'failed' }, blocking(['p1-1', 'p1-3']), rw), rw).passed, false);
    // An episode-wide finding names no panel and is left as written.
    assert.equal(validateAdaptationReview(reviewWith({ readThrough: 'failed' }, blocking([]), rw), rw).passed, false);
    // Without a previous review the rule does not apply.
    assert.equal(validateAdaptationReview(reviewWith({ readThrough: 'failed' }, blocking(['p1-3'])), w).passed, false);
  });
});
