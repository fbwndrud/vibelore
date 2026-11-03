import assert from 'node:assert/strict';
import test from 'node:test';
import { ADAPTATION_REVIEW_CHECKS, ADAPTATION_REVIEW_PROMPT, adaptationReviewPackets, adaptationReviewSchema, validateAdaptationReview } from '../src/core/webtoon-adaptation-review.js';
import { reviewWorkflow } from './fixtures/webtoon-episode.js';

const units = [{ id: 'u1', text: '"문 열어." 그녀가 말했다.' }, { id: 'u2', text: '대답은 없었다.' }, { id: 'u3', text: '손잡이가 차가웠다.' }];
const w = reviewWorkflow(units);
const reviewWith = (statuses = {}, extra = {}, world = w) => ({
  subjectHash: adaptationReviewSchema(world).subjectHash,
  checks: Object.fromEntries(ADAPTATION_REVIEW_CHECKS.map(key => [key, { status: statuses[key] ?? 'passed', panels: statuses[key] && statuses[key] !== 'passed' ? ['p1-1'] : [], evidence: `${key} 근거` }])),
  findings: [], ...extra,
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
  const finding = severity => ({ findings: [{ severity, panels: ['p1-2'], evidence: '근거' }] });
  assert.equal(validateAdaptationReview(reviewWith({}, finding('blocking')), w).passed, false);
  assert.equal(validateAdaptationReview(reviewWith({}, finding('advisory')), w).passed, true);
  assert.equal(validateAdaptationReview(reviewWith({}, { findings: [{ severity: 'blocking', panels: [], evidence: '전체 흐름' }] }), w).passed, false);
});
test('all passed with no blocking passes and is labelled same-host without a configured model', () =>
  assert.deepEqual(validateAdaptationReview(reviewWith({}), w), { passed: true, independence: 'same-host' }));
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
  bad({ severity: 'major', panels: [], evidence: '근거' });
  bad({ severity: 'blocking', panels: [], evidence: '' });
  bad({ severity: 'advisory', panels: ['p9-9'], evidence: '근거' });
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
