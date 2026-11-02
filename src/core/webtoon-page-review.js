import { digest, nonempty } from './webtoon-contract.js';
import { SCENE_IMAGE_REVIEW_PROMPT, validateSceneVisualChecks, sceneVisualCheckSchema } from './webtoon-scene-review.js';
import { sameLettering } from './webtoon-scene.js';
import { adaptationDigest, pageDigest, pageTexts, previousPageState, PAGE_FINDING_SHAPE } from './webtoon-episode.js';

const need = (ok, code) => { if (!ok) throw new Error(code); };

/** The host crops each page into a fixed grid of upscaled tiles so the reviewer can transcribe lettering up close. */
export const TILE_GRID = { cols: 2, rows: 4, overlap: 0.1, scale: 2, tolerance: 0.02 };
export const PAGE_DELIVERY_STATUSES = ['delivered', 'partial', 'missing'];
export const PAGE_CONTINUITY_CHECKS = ['identity', 'clothing', 'props', 'transition'];
export const FOREIGN_TEXT_PREFIX = 'Reviewer text observation moved here by the host because it is not a plan text id: ';

export const PAGE_REVIEW_PROMPT = `${SCENE_IMAGE_REVIEW_PROMPT}
Transcribe every text from the tiles, character by character, exactly as drawn; do not correct it toward the expected text.
Judge panelDelivery against each panel's approved shows.
Compare previousPage identity, clothing, props and transition.`;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from the IHDR chunk; nothing else in the file is trusted. */
export function pngSize(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('latin1', 12, 16) === 'IHDR', 'INVALID_PNG_CONTAINER');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Row-major crop rects (ids are one-based). Inner edges grow by overlap × cell size; integer pixels, clamped to the page. */
export function tileRects(width, height) {
  const { cols, rows, overlap } = TILE_GRID, cw = width / cols, ch = height / rows, rects = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const x0 = Math.max(0, Math.round(col * cw - (col > 0 ? overlap * cw : 0))), x1 = Math.min(width, Math.round((col + 1) * cw + (col < cols - 1 ? overlap * cw : 0)));
    const y0 = Math.max(0, Math.round(row * ch - (row > 0 ? overlap * ch : 0))), y1 = Math.min(height, Math.round((row + 1) * ch + (row < rows - 1 ? overlap * ch : 0)));
    rects.push({ id: `t-r${row + 1}c${col + 1}`, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return rects;
}

export function validateTiles(tiles, page) {
  const rects = tileRects(page.width, page.height);
  need(Array.isArray(tiles) && tiles.length === rects.length && rects.every(r => tiles.filter(t => t?.id === r.id).length === 1), 'PAGE_TILES_INCOMPLETE');
  for (const rect of rects) {
    const t = tiles.find(t => t.id === rect.id), { scale, tolerance } = TILE_GRID;
    need(Math.abs(t.width - rect.w * scale) <= rect.w * scale * tolerance && Math.abs(t.height - rect.h * scale) <= rect.h * scale * tolerance, 'PAGE_TILE_SIZE');
  }
  return tiles;
}

const pageState = (w, page) => (w.pages ?? []).find(p => p.id === page.id);

/** Binds a review to this adaptation, this page, the exact page image and its exact tiles. */
export function pageReviewSubject(w, page) {
  const state = pageState(w, page);
  need(state?.image?.hash && Array.isArray(state.tiles), 'PAGE_IMAGE_MISSING');
  return digest({ adaptation: adaptationDigest(w.adaptation), page: pageDigest(page), imageHash: state.image.hash, tiles: state.tiles.map(t => t.hash) });
}

/** The previous page is attached for comparison only once it passed its own review. */
export const previousPageAttached = (w, page) => previousPageState(w, page) !== null;

/** Skeleton the host fills. panelDelivery is an array with one entry per panel id, like textObservations. */
export function pageReviewSchema(w, page) {
  return { subjectHash: pageReviewSubject(w, page), inspectedImages: false, observedPanelCount: null,
    visualChecks: sceneVisualCheckSchema(),
    panelDelivery: page.panels.map(p => ({ id: p.id, status: 'delivered|partial|missing', evidence: '' })),
    textObservations: pageTexts(page).map(t => ({ id: t.id, observedText: '', readable: false, speakerCorrect: false, evidence: '' })),
    ...(previousPageAttached(w, page) ? { previousPage: Object.fromEntries(PAGE_CONTINUITY_CHECKS.map(k => [k, { passed: false, evidence: '' }])) } : {}),
    findings: [], findingItem: PAGE_FINDING_SHAPE };
}

/** Observations about ids the plan never had are advisory findings, not a reason to reject the whole review. Run before validation. */
export function moveForeignTextObservations(review, page) {
  if (!Array.isArray(review?.textObservations)) return review;
  const ids = new Set(pageTexts(page).map(t => t.id)), foreign = review.textObservations.filter(o => !ids.has(o?.id));
  if (!foreign.length) return review;
  const moved = foreign.map(o => ({ severity: 'advisory', evidence: `${FOREIGN_TEXT_PREFIX}${JSON.stringify(o)}` }));
  return { ...review, textObservations: review.textObservations.filter(o => ids.has(o?.id)), findings: [...(Array.isArray(review.findings) ? review.findings : []), ...moved] };
}

const sameIds = (items, ids) => Array.isArray(items) && items.length === ids.length && ids.every(id => items.filter(i => i?.id === id).length === 1);

export function validatePageReview(review, w, page) {
  need(review?.subjectHash === pageReviewSubject(w, page) && review.inspectedImages === true, 'PAGE_IMAGE_NOT_INSPECTED');
  const texts = pageTexts(page);
  need(sameIds(review.textObservations, texts.map(t => t.id)) && review.textObservations.every(o => typeof o.observedText === 'string'
    && typeof o.readable === 'boolean' && typeof o.speakerCorrect === 'boolean' && nonempty(o.evidence)), 'INCOMPLETE_PAGE_TEXT_REVIEW');
  need(sameIds(review.panelDelivery, page.panels.map(p => p.id)) && review.panelDelivery.every(d => PAGE_DELIVERY_STATUSES.includes(d.status) && nonempty(d.evidence)), 'INCOMPLETE_PAGE_DELIVERY');
  const attached = previousPageAttached(w, page);
  if (attached) need(PAGE_CONTINUITY_CHECKS.every(k => typeof review.previousPage?.[k]?.passed === 'boolean' && nonempty(review.previousPage[k].evidence)), 'INCOMPLETE_PAGE_CONTINUITY');
  need(Array.isArray(review.findings) && review.findings.every(f => ['blocking', 'advisory'].includes(f?.severity) && nonempty(f.evidence)), 'INVALID_PAGE_FINDING');
  need(Number.isInteger(review.observedPanelCount) && review.observedPanelCount > 0, 'PAGE_PANEL_COUNT_NOT_OBSERVED');
  const visualChecksPassed = validateSceneVisualChecks(review.visualChecks, page.panels.length);
  return visualChecksPassed && review.observedPanelCount === page.panels.length
    && review.panelDelivery.every(d => d.status === 'delivered')
    && review.textObservations.every(o => o.readable && o.speakerCorrect && sameLettering(o.observedText, texts.find(t => t.id === o.id).text))
    && (!attached || PAGE_CONTINUITY_CHECKS.every(k => review.previousPage[k].passed))
    && !review.findings.some(f => f.severity === 'blocking');
}
