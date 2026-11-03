import assert from 'node:assert/strict';
import test from 'node:test';
import { TILE_GRID, PAGE_REVIEW_PROMPT, pngSize, tileRects, validateTiles, pageReviewSchema, pageReviewSubject, previousPageAttached,
  validatePageReview, moveForeignTextObservations, FOREIGN_TEXT_PREFIX } from '../src/core/webtoon-page-review.js';
import { SCENE_IMAGE_REVIEW_PROMPT, SCENE_VISUAL_CHECKS } from '../src/core/webtoon-scene-review.js';
import { pageTexts } from '../src/core/webtoon-episode.js';
import { pixel } from './fixtures/webtoon.js';
import { adaptationFor, withPages } from './fixtures/webtoon-episode.js';

const units = [{ id: 'u1', text: '"문 열어." 그녀가 말했다.' }, { id: 'u2', text: '대답은 없었다.' }, { id: 'u3', text: '손잡이가 차가웠다.' }];
const PAGE = { width: 1024, height: 1536 };
const pngHeader = (width, height) => { const b = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); return b; };
const goodTiles = () => tileRects(PAGE.width, PAGE.height).map(r => ({ id: r.id, path: `/t/${r.id}.png`, hash: `sha256:${r.id}`, width: r.w * TILE_GRID.scale, height: r.h * TILE_GRID.scale }));
const stateFor = (id, extra = {}) => ({ id, digest: 'sha256:d', stage: 'page_review', image: { hash: `sha256:img-${id}`, path: `/${id}.png`, ...PAGE }, tiles: goodTiles(), ...extra });
const workflow = (n = 1, firstReview) => {
  const adaptation = withPages(adaptationFor(units), n);
  return { adaptation, pages: adaptation.pages.map((p, i) => stateFor(p.id, i === 0 && firstReview ? { review: firstReview } : {})) };
};
const w = workflow(), page = w.adaptation.pages[0];
const expectedText = pageTexts(page)[0].text;
const check = { status: 'passed', panels: [1], evidence: '보이는 근거' };

/** A passing review built from the schema; `over` patches the pieces a test cares about. */
function fill(w, page, over = {}) {
  const s = pageReviewSchema(w, page), expected = Object.fromEntries(pageTexts(page).map(t => [t.id, t.text]));
  return { ...s, inspectedImages: true, observedPanelCount: page.panels.length,
    visualChecks: Object.fromEntries(SCENE_VISUAL_CHECKS.map(k => [k, { ...check }])),
    panelDelivery: s.panelDelivery.map(d => ({ ...d, status: 'delivered', evidence: '그려져 있다' })),
    textObservations: s.textObservations.map(o => ({ ...o, observedText: expected[o.id], readable: true, speakerCorrect: true, evidence: '타일에서 읽음' })),
    ...(s.previousPage ? { previousPage: Object.fromEntries(Object.keys(s.previousPage).map(k => [k, { passed: true, evidence: '같다' }])) } : {}),
    findingItem: undefined, ...over };
}
const pageReviewWith = (text, over = {}) => fill(w, page, { textObservations: fill(w, page).textObservations.map((o, i) => i ? o : { ...o, observedText: text }), ...over });
const code = re => err => re.test(err.message);

test('pngSize reads IHDR and rejects non-PNG', () => {
  assert.deepEqual(pngSize(pixel), { width: 1, height: 1 });
  assert.deepEqual(pngSize(pngHeader(1024, 1536)), { width: 1024, height: 1536 });
  assert.throws(() => pngSize(Buffer.from('nope')), /INVALID_PNG_CONTAINER/);
  const noIhdr = pngHeader(1, 1); noIhdr.write('IDAT', 12, 'latin1');
  assert.throws(() => pngSize(noIhdr), /INVALID_PNG_CONTAINER/);
  assert.throws(() => pngSize(pngHeader(0, 5)), /INVALID_PNG_CONTAINER/);
  assert.throws(() => pngSize(pngHeader(5, 0)), /INVALID_PNG_CONTAINER/);
  const shortIhdr = pngHeader(1, 1); shortIhdr.writeUInt32BE(12, 8);
  assert.throws(() => pngSize(shortIhdr), /INVALID_PNG_CONTAINER/);
});

test('tileRects gives 8 overlapping rects inside the page', () => {
  const r = tileRects(1024, 1536);
  assert.equal(r.length, 8); assert.equal(r[0].id, 't-r1c1'); assert.equal(r[7].id, 't-r4c2');
  assert.ok(r.every(t => Number.isInteger(t.x + t.y + t.w + t.h) && t.x >= 0 && t.y >= 0 && t.x + t.w <= 1024 && t.y + t.h <= 1536));
  assert.ok(r[0].w > 512);
  // Inner edges overlap by 10% of a cell; outer edges stay on the page border.
  assert.deepEqual(r[0], { id: 't-r1c1', x: 0, y: 0, w: 563, h: 422 });
  assert.equal(r[1].x, 461); assert.equal(r[1].x + r[1].w, 1024);
  assert.equal(r[2].y, 346);
  assert.deepEqual(r.map(t => t.id), ['r1c1', 'r1c2', 'r2c1', 'r2c2', 'r3c1', 'r3c2', 'r4c1', 'r4c2'].map(s => `t-${s}`));
});

test('validateTiles rejects missing ids and wrong sizes', () => {
  assert.equal(validateTiles(goodTiles(), PAGE).length, 8);
  assert.throws(() => validateTiles(goodTiles().slice(1), PAGE), /PAGE_TILES_INCOMPLETE/);
  assert.throws(() => validateTiles([...goodTiles().slice(1), { ...goodTiles()[1] }], PAGE), /PAGE_TILES_INCOMPLETE/);
  assert.throws(() => validateTiles(goodTiles().map((t, i) => i ? t : { ...t, id: 't-r9c9' }), PAGE), /PAGE_TILES_INCOMPLETE/);
  const sized = (i, patch) => goodTiles().map((t, j) => j === i ? { ...t, ...patch(t) } : t);
  assert.throws(() => validateTiles(sized(0, t => ({ width: t.width * 1.05 })), PAGE), /PAGE_TILE_SIZE/);
  assert.throws(() => validateTiles(sized(3, t => ({ height: t.height - 40 })), PAGE), /PAGE_TILE_SIZE/);
  assert.equal(validateTiles(sized(0, t => ({ width: Math.round(t.width * 1.015) })), PAGE).length, 8);
});

test('the page prompt keeps the scene prompt and the three page lines verbatim', () => {
  assert.ok(PAGE_REVIEW_PROMPT.startsWith(SCENE_IMAGE_REVIEW_PROMPT));
  for (const line of ['Transcribe every text from the tiles, character by character, exactly as drawn; do not correct it toward the expected text.',
    "Judge panelDelivery against each panel's approved shows.", 'Compare previousPage identity, clothing, props and transition.']) assert.ok(PAGE_REVIEW_PROMPT.includes(line));
});

test('the schema has one entry per panel and text and previousPage only after a passed previous page', () => {
  const s = pageReviewSchema(w, page);
  assert.equal(s.subjectHash, pageReviewSubject(w, page));
  assert.deepEqual(s.panelDelivery.map(d => d.id), page.panels.map(p => p.id));
  assert.deepEqual(s.textObservations.map(o => o.id), pageTexts(page).map(t => t.id));
  assert.equal('previousPage' in s, false);
  assert.deepEqual(Object.keys(pageReviewSchema(workflow(2, { passed: true }), workflow(2).adaptation.pages[1]).previousPage), ['identity', 'clothing', 'props', 'transition']);
});

test('the review subject changes with the image, a tile, the page and the adaptation', () => {
  const base = pageReviewSubject(w, page), clone = () => structuredClone(w);
  const a = clone(); a.pages[0].image.hash = 'sha256:other'; assert.notEqual(pageReviewSubject(a, page), base);
  const b = clone(); b.pages[0].tiles[3].hash = 'sha256:other'; assert.notEqual(pageReviewSubject(b, page), base);
  const c = clone(), p2 = c.adaptation.pages[0]; p2.panels[0].shows = '다른 장면'; assert.notEqual(pageReviewSubject(c, p2), base);
  assert.throws(() => pageReviewSubject({ ...w, pages: [] }, page), /PAGE_IMAGE_MISSING/);
});

test('previousPageAttached needs a previous page that passed its review', () => {
  assert.equal(previousPageAttached(workflow(2, { passed: true }), workflow(2).adaptation.pages[0]), false);
  const two = workflow(2, { passed: true }); assert.equal(previousPageAttached(two, two.adaptation.pages[1]), true);
  const failed = workflow(2, { passed: false }); assert.equal(previousPageAttached(failed, failed.adaptation.pages[1]), false);
  const none = workflow(2); assert.equal(previousPageAttached(none, none.adaptation.pages[1]), false);
});

test('a matching transcription passes', () => assert.equal(validatePageReview(fill(w, page), w, page), true));

test('a transcription mismatch fails even when marked readable', () => {
  const review = pageReviewWith('위협도: 높음.');
  assert.equal(review.textObservations[0].readable, true);
  assert.equal(validatePageReview(review, w, page), false);
  assert.equal(validatePageReview(pageReviewWith(expectedText), w, page), true);
});

test('unreadable text, a wrong speaker and a blocking finding fail; an advisory does not', () => {
  const patch = o => fill(w, page, { textObservations: fill(w, page).textObservations.map((t, i) => i ? t : { ...t, ...o }) });
  assert.equal(validatePageReview(patch({ readable: false }), w, page), false);
  assert.equal(validatePageReview(patch({ speakerCorrect: false }), w, page), false);
  assert.equal(validatePageReview(fill(w, page, { findings: [{ severity: 'blocking', evidence: '칸이 잘렸다' }] }), w, page), false);
  assert.equal(validatePageReview(fill(w, page, { findings: [{ severity: 'advisory', evidence: '톤이 다르다' }] }), w, page), true);
});

test('a wrong panel count and a failed visual check fail', () => {
  assert.equal(validatePageReview(fill(w, page, { observedPanelCount: page.panels.length + 1 }), w, page), false);
  const failed = Object.fromEntries(SCENE_VISUAL_CHECKS.map(k => [k, { ...check }])); failed.propStructure = { ...check, status: 'failed' };
  assert.equal(validatePageReview(fill(w, page, { visualChecks: failed }), w, page), false);
});

test('partial panel delivery and failed previous-page transition fail', () => {
  const partial = fill(w, page); partial.panelDelivery[1].status = 'partial';
  assert.equal(validatePageReview(partial, w, page), false);
  const missing = fill(w, page); missing.panelDelivery[2].status = 'missing';
  assert.equal(validatePageReview(missing, w, page), false);
  const two = workflow(2, { passed: true }), second = two.adaptation.pages[1];
  assert.equal(validatePageReview(fill(two, second), two, second), true);
  const bad = fill(two, second); bad.previousPage.transition.passed = false;
  assert.equal(validatePageReview(bad, two, second), false);
});

test('structural gaps throw the specific incomplete codes', () => {
  const thrown = (review, re, ww = w, pg = page) => assert.throws(() => validatePageReview(review, ww, pg), code(re));
  thrown(fill(w, page, { subjectHash: 'sha256:stale' }), /PAGE_IMAGE_NOT_INSPECTED/);
  thrown(fill(w, page, { inspectedImages: false }), /PAGE_IMAGE_NOT_INSPECTED/);
  thrown(fill(w, page, { textObservations: [] }), /INCOMPLETE_PAGE_TEXT_REVIEW/);
  thrown(fill(w, page, { textObservations: [...fill(w, page).textObservations, { id: 'extra', observedText: 'x', readable: true, speakerCorrect: true, evidence: 'e' }] }), /INCOMPLETE_PAGE_TEXT_REVIEW/);
  thrown(fill(w, page, { textObservations: fill(w, page).textObservations.map(o => ({ ...o, evidence: '' })) }), /INCOMPLETE_PAGE_TEXT_REVIEW/);
  thrown(fill(w, page, { panelDelivery: fill(w, page).panelDelivery.slice(1) }), /INCOMPLETE_PAGE_DELIVERY/);
  thrown(fill(w, page, { panelDelivery: fill(w, page).panelDelivery.map(d => ({ ...d, status: 'ok' })) }), /INCOMPLETE_PAGE_DELIVERY/);
  const two = workflow(2, { passed: true }), second = two.adaptation.pages[1];
  const noTransition = fill(two, second); delete noTransition.previousPage.transition;
  thrown(noTransition, /INCOMPLETE_PAGE_CONTINUITY/, two, second);
  const noPrevious = fill(two, second); delete noPrevious.previousPage;
  thrown(noPrevious, /INCOMPLETE_PAGE_CONTINUITY/, two, second);
  const noEvidence = fill(two, second); noEvidence.previousPage.props.evidence = '';
  thrown(noEvidence, /INCOMPLETE_PAGE_CONTINUITY/, two, second);
  thrown(fill(w, page, { findings: [{ severity: 'blocking', evidence: '' }] }), /INVALID_PAGE_FINDING/);
});

test('previousPage is not required when the previous page did not pass', () => {
  const two = workflow(2, { passed: false }), second = two.adaptation.pages[1];
  assert.equal(validatePageReview(fill(two, second), two, second), true);
});

test('foreign text observations move to an advisory with the fixed prefix', () => {
  const review = fill(w, page), foreign = { id: 'ghost-text', observedText: '위협도: 높음.', readable: true, speakerCorrect: true, evidence: '화면 모서리' };
  const withForeign = { ...review, textObservations: [...review.textObservations, foreign] };
  assert.throws(() => validatePageReview(withForeign, w, page), /INCOMPLETE_PAGE_TEXT_REVIEW/);
  const moved = moveForeignTextObservations(withForeign, page);
  assert.equal(moved.textObservations.length, pageTexts(page).length);
  assert.equal(moved.findings.at(-1).severity, 'advisory');
  assert.ok(moved.findings.at(-1).evidence.startsWith(FOREIGN_TEXT_PREFIX));
  assert.match(moved.findings.at(-1).evidence, /^Reviewer text observation moved here by the host because it is not a plan text id: /);
  assert.ok(moved.findings.at(-1).evidence.includes('ghost-text'));
  assert.equal(validatePageReview(moved, w, page), true);
  assert.equal(moveForeignTextObservations(review, page), review);
  assert.equal(withForeign.textObservations.length, review.textObservations.length + 1);
});

test('a malformed findings field is not repaired when foreign observations are present', () => {
  const review = fill(w, page), foreign = { id: 'ghost-text', observedText: 'x', readable: true, speakerCorrect: true, evidence: '모서리' };
  for (const findings of ['nope', null, { severity: 'advisory' }]) {
    const broken = { ...review, textObservations: [...review.textObservations, foreign], findings };
    const out = moveForeignTextObservations(broken, page);
    assert.equal(out, broken); assert.equal(out.findings, findings);
    assert.throws(() => validatePageReview(out, w, page));
  }
  const onlyBadFindings = { ...review, findings: 'nope' };
  assert.equal(moveForeignTextObservations(onlyBadFindings, page), onlyBadFindings);
  assert.throws(() => validatePageReview(onlyBadFindings, w, page), /INVALID_PAGE_FINDING/);
});

test('a configured reviewer model asks for evidence and the review fails without it', () => {
  const model = { provider: 'host', modelId: 'page-reviewer' }, configured = { ...w, reviewModel: model };
  assert.deepEqual(pageReviewSchema(configured, page).reviewerEvidence, { modelId: '', responseId: '' });
  assert.equal('reviewerEvidence' in pageReviewSchema(w, page), false);
  const withEvidence = reviewerEvidence => fill(configured, page, { reviewerEvidence });
  assert.equal(validatePageReview(withEvidence({ modelId: 'page-reviewer', responseId: 'resp-1' }), configured, page), true);
  for (const bad of [undefined, { modelId: 'page-reviewer', responseId: '' }, { modelId: 'someone-else', responseId: 'resp-1' }, { responseId: 'resp-1' }]) {
    assert.throws(() => validatePageReview(withEvidence(bad), configured, page), code(/PAGE_REVIEWER_EVIDENCE_REQUIRED/));
  }
  // Without a configured model the host's own review needs no evidence.
  assert.equal(validatePageReview(fill(w, page), w, page), true);
});
