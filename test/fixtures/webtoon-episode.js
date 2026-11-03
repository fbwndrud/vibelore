import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imagePolicyFor } from '../../src/core/webtoon-images.js';
import { pageBriefSchema, pageTexts } from '../../src/core/webtoon-episode.js';
import { TILE_GRID } from '../../src/core/webtoon-page-review.js';
import { runWebtoonEpisodeTool } from '../../src/tools/webtoon-episode.js';
import { workId } from './webtoon.js';
import { ADAPTATION_REVIEW_CHECKS } from '../../src/core/webtoon-adaptation-review.js';
import { deriveRequestFingerprint } from '../../engine/src/core/request-fingerprint.js';
import { sceneSetup, sceneVisualChecks } from './webtoon-scene.js';

/** Plain adaptation fixtures for the episode path: one expand beat over all units, one page, three panels, one dialogue text. */
const clone = value => structuredClone(value);
const panelAt = (units, page, n, extra = {}) => ({ id: `p${page}-${n}`, beatIds: ['beat-1'], sourceIds: n === 3 ? units.slice(1).map(u => u.id) : [units[0].id],
  shows: '문 앞에 선 인물의 굳은 어깨', readerDelta: '망설임이 보인다', bridge: n === 1 ? 'page opener' : '앞 칸의 망설임이 손을 멈추게 한다',
  texts: n === 1 ? [{ id: `t${page}-1`, sourceId: units[0].id, kind: 'dialogue', speaker: 'c1', text: units[0].text }] : [], ...extra });

export const adaptationFor = (units, overrides = {}) => ({
  editorial: { version: 1, focus: { primary: '문 앞의 망설임', supporting: ['고요'], tradeoff: '설명을 덜고 표정을 남긴다' },
    beats: [{ id: 'beat-1', sourceIds: units.map(u => u.id), decision: 'expand', reason: '주된 경험', readerChange: '망설임을 느낀다',
      visualProof: '문 앞에서 멈춘 손', carryForward: '불필요: 이 쪽 안에서 전달' }] },
  extras: [], pageCountReason: '한 장면이라 한 쪽이면 충분하다',
  pages: [{ id: 'page-1', purpose: '망설임을 보여 준다', pageTurn: '문이 열린다', panels: [1, 2, 3].map(n => panelAt(units, 1, n)) }],
  ...overrides,
});

/** Last unit leaves the beat and the panels, so the editorial map no longer covers it. */
export function dropUnit(a) {
  const next = clone(a), last = next.editorial.beats[0].sourceIds.pop();
  for (const panel of next.pages.flatMap(p => p.panels)) panel.sourceIds = panel.sourceIds.filter(id => id !== last);
  return next;
}

/** Last unit becomes an omitted beat, and the third panel still draws it. */
export function omitDrawnBeat(a) {
  const next = clone(a), [beat] = next.editorial.beats, last = beat.sourceIds.pop();
  next.editorial.beats.push({ ...beat, id: 'beat-2', sourceIds: [last], decision: 'omit', visualProof: '' });
  Object.assign(next.pages[0].panels[2], { beatIds: ['beat-2'], sourceIds: [last] });
  return next;
}

/** Last unit becomes an omitted beat no panel draws, and the first panel's text is lettered from it. */
export function omittedUnitText(a) {
  const next = clone(a), [beat] = next.editorial.beats, last = beat.sourceIds.pop();
  next.editorial.beats.push({ ...beat, id: 'beat-2', sourceIds: [last], decision: 'omit', visualProof: '' });
  for (const panel of next.pages[0].panels) panel.sourceIds = panel.sourceIds.filter(id => id !== last);
  Object.assign(next.pages[0].panels[0].texts[0], { sourceId: last });
  return next;
}

export function withText(a, text) { const next = clone(a); next.pages[0].panels[0].texts[0].text = text; return next; }
export function withSpeaker(a, speaker) { const next = clone(a); next.pages[0].panels[0].texts[0].speaker = speaker; return next; }
export function withExtraSpeaker(a, id) {
  const next = withSpeaker(a, id); next.extras = [...(next.extras ?? []), { id, label: '이름 없는 기수', sourceIds: [next.pages[0].panels[0].sourceIds[0]] }];
  return next;
}

/** First page gets `n` panels, copies of its last one without texts. */
export function withPanels(a, n) {
  const next = clone(a), { panels } = next.pages[0];
  while (panels.length < n) panels.push({ ...clone(panels.at(-1)), id: `p1-${panels.length + 1}`, texts: [] });
  panels.length = n;
  return next;
}

/** First panel gets `n` dialogue texts copied from its first one. */
export function withTexts(a, n) {
  const next = clone(a), [panel] = next.pages[0].panels, [text] = panel.texts;
  panel.texts = Array.from({ length: n }, (_, i) => ({ ...text, id: `t1-${i + 1}` }));
  return next;
}

/** `n` pages, each a copy of the first with its own page, panel and text ids. */
export function withPages(a, n) {
  const next = clone(a), [page] = next.pages;
  next.pages = Array.from({ length: n }, (_, k) => ({ ...clone(page), id: `page-${k + 1}`, panels: page.panels.map((panel, i) => ({ ...clone(panel), id: `p${k + 1}-${i + 1}`,
    texts: panel.texts.map((t, j) => ({ ...t, id: `t${k + 1}-${i + 1}-${j + 1}` })) })) }));
  return next;
}

/** Minimal workflow object for adaptation review: source, units and a valid adaptation. */
export function reviewWorkflow(units, overrides = {}) {
  return { source: { hash: 'sha256:source', cast: [{ id: 'c1', name: '윤', appearance: '짧은 머리' }] }, units, adaptation: adaptationFor(units), adaptationReviewModel: null, ...overrides };
}

/** Episode workflow for page briefs and prompts: `n` pages with runtime state, one reference, an image policy and an adopted style. */
export function pageWorkflow(units, { pages = 2, passedThrough = 0, ...overrides } = {}) {
  const adaptation = withPages(adaptationFor(units), pages), image = id => ({ hash: `sha256:img-${id}`, path: `/${id}.png`, width: 1024, height: 1536 });
  return { source: { hash: 'sha256:source' }, units, adaptation, imagePolicy: imagePolicyFor('gpt-image-2.5-sunburst', 'openai-api'),
    references: [{ id: 'ref', path: '/ref.png', hash: 'sha256:ref', description: 'Character identity only.' }],
    styleSnapshot: { revisionId: 'sha256:style-1', profile: { style: 'Colored ink.' }, image: { path: '/style.png', hash: 'sha256:style' } },
    pages: adaptation.pages.map((p, i) => ({ id: p.id, image: image(p.id), tiles: [], ...(i < passedThrough ? { review: { passed: true } } : {}) })), ...overrides };
}

/** A filled page brief: every check passes, one short moment per panel with that panel's text ids; `over` patches the pieces a test cares about. */
export function briefFor(w, page, over = {}) {
  const s = pageBriefSchema(w, page);
  return { ...s, checks: s.checks.map(c => ({ ...c, passed: true, evidence: 'Visible in the panel.' })), findingItem: undefined,
    drawability: { passed: true, evidence: 'Synthetic fixture moments; no real image quality claim.' },
    renderBrief: { ...s.renderBrief, moments: s.renderBrief.moments.map((m, i) => ({ ...m, sourceIds: page.panels[i].sourceIds, action: `Panel ${i + 1}: she waits at the door.` })) }, ...over };
}

/** The same brief with the first two moments' text ids swapped. */
export function briefWithSwappedTexts(w, page) {
  const brief = briefFor(w, page), [a, b, ...rest] = brief.renderBrief.moments;
  return { ...brief, renderBrief: { ...brief.renderBrief, moments: [{ ...a, textIds: b.textIds }, { ...b, textIds: a.textIds }, ...rest] } };
}

/** Webtoon store with a confirmed API selection and one reference image, plus valid episode start args (no page count: the work cap applies). */
export async function episodeSetup(options) {
  const { store, repo, args: { panelCount, ...args } } = await sceneSetup(options);
  return { store, repo, args };
}

/** Host answer for `webtoon-adaptation`: one page of three panels; the speaker is the first cast member of the request, and the page-count reason follows the feedback so a revision differs. */
export const adaptationAnswer = d => withSpeaker(adaptationFor(d.source,
  { pageCountReason: d.feedback ? `피드백 반영: ${d.feedback.slice(0, 40)}` : '한 장면이라 한 쪽이면 충분하다' }), d.cast?.[0]?.id ?? 'narrator');

/** Host answer for `webtoon-adaptation-review` shaped from the request schema; `fail` fails readThrough and adds a blocking and an advisory finding. */
export function adaptationReviewAnswer(d, request, { fail = false } = {}) {
  const [panel] = d.scriptOnly.pages[0].panels;
  return { ...d.schema, findingItem: undefined, checks: Object.fromEntries(ADAPTATION_REVIEW_CHECKS.map(key => [key,
    key === 'readThrough' && fail ? { status: 'failed', panels: [panel.id], evidence: `Panel ${panel.id} has an action with no visible cause.` }
      : { status: 'passed', panels: [panel.id], evidence: `Panel ${panel.id} reads as intended.` }])),
    findings: [...(fail ? [{ severity: 'blocking', panels: [panel.id], evidence: `Panel ${panel.id}: show what makes her stop.` }] : []),
      { severity: 'advisory', panels: [panel.id], evidence: 'Minor polish: tighten the last bridge.' }],
    ...(d.schema.reviewerEvidence ? { reviewerEvidence: { modelId: request.model.modelId, responseId: 'fixture-response-1' } } : {}) };
}

/** Host answer for `webtoon-page-brief`, shaped from the request schema: one short moment per panel; `block` fails every check. A redraw gets one positive correction. */
export function pageBriefAnswer(d, { block = false } = {}) {
  const { schema } = d;
  return { ...schema, findingItem: undefined, checks: schema.checks.map(c => ({ ...c, passed: !block, evidence: 'Visible in the panel.' })),
    drawability: { passed: true, evidence: 'Synthetic fixture moments; no real image quality claim.' },
    renderBrief: { ...schema.renderBrief, style: schema.renderBrief.style || 'Colored ink.', ...(d.feedback ? { corrections: ['The lettering reads cleanly in every balloon.'] } : {}),
      moments: schema.renderBrief.moments.map((m, i) => ({ ...m, sourceIds: d.page.panels[i].sourceIds, action: `Panel ${i + 1}: she waits at the door.` })) } };
}

/** Host answer for `webtoon-page-review`: every check passes and the lettering is transcribed exactly; `wrongText` makes the first text read differently on the tiles. */
export function pageReviewAnswer(d, request, { wrongText } = {}) {
  const { schema } = d, expected = Object.fromEntries(pageTexts(d.page).map(t => [t.id, t.text]));
  return { ...schema, findingItem: undefined, inspectedImages: true, observedPanelCount: d.page.panels.length, visualChecks: sceneVisualChecks(),
    panelDelivery: schema.panelDelivery.map(x => ({ ...x, status: 'delivered', evidence: 'Drawn in the page.' })),
    textObservations: schema.textObservations.map((o, i) => ({ ...o, observedText: wrongText && i === 0 ? wrongText : expected[o.id], readable: true, speakerCorrect: true, evidence: 'Read on the tiles.' })),
    ...(schema.reviewerEvidence ? { reviewerEvidence: { modelId: request.model.modelId, responseId: 'fixture-page-response-1' } } : {}),
    ...(schema.previousPage ? { previousPage: Object.fromEntries(Object.keys(schema.previousPage).map(k => [k, { passed: true, evidence: 'Same person and clothes.' }])) } : {}) };
}

/**
 * Fixture host for the episode path. `adaptationReview: 'fail'` fails every adaptation review; `pages` makes the adaptation `n` pages and
 * `adaptation(d, base)` may reshape it. The page brief and the page review are left unanswered (reported through `pending`, as a relay
 * would) unless `answerPages` is set; then `pageBrief: 'block'` blocks every brief and `pageReview(d, calls)` may return answer options
 * for review number `calls` of that page, e.g. `{ wrongText }`.
 */
export function provider({ adaptationReview, pages, adaptation, answerPages = false, pageBrief, pageReview } = {}) {
  const requests = [], pending = [], reviews = {};
  return { requests, pending, reviews, provenance: { kind: 'fixture', contextIsolation: 'unverified' }, async complete(request) {
    requests.push(request);
    const d = JSON.parse(request.messages.at(-1).content);
    if (request.step === 'webtoon-adaptation') { const base = adaptationAnswer(d); return { text: JSON.stringify(adaptation ? adaptation(d, pages ? withPages(base, pages) : base) : pages ? withPages(base, pages) : base) }; }
    if (request.step === 'webtoon-adaptation-review') return { text: JSON.stringify(adaptationReviewAnswer(d, request, { fail: adaptationReview === 'fail' })) };
    if (answerPages && request.step === 'webtoon-page-brief') return { text: JSON.stringify(pageBriefAnswer(d, { block: pageBrief === 'block' })) };
    if (answerPages && request.step === 'webtoon-page-review') {
      const calls = reviews[d.page.id] = (reviews[d.page.id] ?? 0) + 1;
      return { text: JSON.stringify(pageReviewAnswer(d, request, pageReview?.(d, calls))) };
    }
    pending.splice(0, pending.length, { id: deriveRequestFingerprint(request), step: request.step, jsonMode: true,
      system: request.messages[0].content, user: request.messages.at(-1).content });
    throw new Error(`PENDING_${request.step}`);
  } };
}

export const PAGE_SIZE = { width: 1024, height: 1536 };
let seeds = 0;
/** A PNG of the given size whose bytes are unique per call: signature, IHDR, one IDAT holding a counter, IEND. No image data and no dependencies. */
export function pngOf(width, height) {
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from(`seed-${seeds++}`)), chunk('IEND', Buffer.alloc(0))]);
}

const call = (store, args, providers) => runWebtoonEpisodeTool({ store, args: { workId, ...args }, providers });
export const episodeCall = call;

/** Start, approve as the user and return the call that issues the first page image job (the provider must have `answerPages`). */
export async function driveToImage(store, args, providers) {
  const gate = await call(store, args, providers);
  return call(store, { action: 'approve', approvalId: gate.approvalView.approvalId, feedback: '이대로 그려 주세요.' }, providers);
}

/** Provenance the host would report for this job, requested quality included when the job carries one. */
export const provenanceFor = job => ({ kind: 'openai-api', requestedModel: job.apiRequest.model, selectionId: job.apiRequest.selectionId, ...(job.quality ? { requestedQuality: job.quality } : {}) });

/** The host stores a drawn page under the project and reports it; returns the tool result (the page-tiles job). */
export async function importPage(store, job, providers, { size = PAGE_SIZE, bytes = pngOf(size.width, size.height), ...over } = {}) {
  const dir = join(store.rootDir, 'host'); await mkdir(dir, { recursive: true });
  const path = join(dir, `${job.pageId}-${seeds++}.png`); await writeFile(path, bytes);
  return call(store, { asset: { pageId: job.pageId, path, inputHash: job.inputHash, provenance: provenanceFor(job), ...over } }, providers);
}

/** The host crops the tiles of a page-tiles job at its scale (sizes exact to the rect, files carrying only a header) and reports them. */
export async function importTiles(store, job, providers, { over = {}, sizeOf = r => ({ width: r.w * TILE_GRID.scale, height: r.h * TILE_GRID.scale }) } = {}) {
  const dir = join(store.rootDir, 'host'); await mkdir(dir, { recursive: true });
  const items = [];
  for (const rect of job.rects) { const path = join(dir, `${job.pageId}-${rect.id}-${seeds++}.png`); await writeFile(path, pngOf(sizeOf(rect).width, sizeOf(rect).height)); items.push({ id: rect.id, path }); }
  return call(store, { tiles: { pageId: job.pageId, imageHash: job.imageHash, items, ...over } }, providers);
}

/** Draw, tile and review the page of an image job; resolves to the result after its review (the next page's image job, or the finished episode). */
export async function importPageAndPass(store, job, providers) {
  const drawn = await importPage(store, job, providers);
  return importTiles(store, drawn.jobs[0], providers);
}

/** Pass every page from the given image job on; resolves to the last result. */
export async function passAll(store, first, providers) {
  let r = first;
  while (r.jobs?.[0]?.kind === 'page') r = await importPageAndPass(store, r.jobs[0], providers);
  return r;
}
