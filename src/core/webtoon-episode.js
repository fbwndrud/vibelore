import { parseDocument } from '../md/frontmatter.js';
import { digest, nonempty, safeId } from './webtoon-contract.js';
import { styleReference } from '../store/webtoon-style-store.js';
import { EDITORIAL_SCHEMA, validateEditorial } from './webtoon-editorial.js';
import { SCENE_TEXT_KINDS, SCENE_LIMITS, isVerbatimText, validateSceneRenderBrief, imagePromptBody } from './webtoon-scene.js';

export const EPISODE_PRODUCTION_MODE = 'episode-pages-v1';
/** Reserved reference id for the previous page image. */
export const PREVIOUS_PAGE_ID = 'previous-page';
export const EPISODE_LIMITS = { panelsMin: 3, panelsMax: 6, textsPerPanel: 2, physicalPerPanel: 1, pageCapDefault: 6, pageCapMax: 20,
  adaptationRevisions: { default: 1, max: 2 }, pageRevisions: { default: 1, max: 2 } };

export const ADAPTATION_SCHEMA = {
  editorial: EDITORIAL_SCHEMA,
  extras: [{ id: 'extra-id', label: '이름 없는 등장인물 설명', sourceIds: ['source-id'] }],
  pageCountReason: '이 쪽수가 된 이유',
  pages: [{ id: 'page-1', purpose: '이 쪽이 전달하는 것', pageTurn: '마지막 칸이 다음 쪽에 넘기는 것',
    panels: [{ id: 'p1-1', beatIds: ['beat-id'], sourceIds: ['source-id'], shows: '말 대신 그림이 전하는 것',
      readerDelta: '독자가 여기서 새로 알게 되는 것', bridge: '앞 칸에서 이어지는 이유(동기 → 행동 → 결과). 쪽의 첫 칸만 "page opener"',
      texts: [{ id: 't1', sourceId: 'source-id', kind: 'dialogue|thought|caption|sfx|physical', speaker: 'cast id | extras id | narrator', text: '원문 그대로의 부분 문자열' }] }] }],
};

export const ADAPTATION_PROMPT = '웹툰 각색 작가다. 원작 한 화를 여러 쪽(쪽마다 3~6칸)의 각색 대본으로 만든다. 먼저 편집 지도(editorial)로 모든 원문 단락을 비트에 한 번씩 배정하고 expand/condense/omit/defer를 정한다. 문단마다가 아니라 사건·감정 비트마다 칸을 만든다. 그림이 정보를 실을 수 있으면 말로 하지 말고 그린다(shows). 압축해도 핵심 행동의 동기·위치·결과는 원문 없이 읽혀야 한다. 제외한 맥락이 이후 쪽에 필요하면 carryForward가 가리키는 곳에서 전한다. 쪽 수는 목표가 아니라 결과이며 pageCountReason에 이유를 적는다. 칸마다 shows, readerDelta, bridge(앞 칸에서 이어지는 이유)를 채우고 "page opener"는 쪽의 첫 칸에만 쓴다. 칸당 글자 요소는 최대 2개, physical은 최대 1개다. 글자는 원문 단락의 정확한 부분 문자열이며 발화자는 인물 id, extras id 또는 narrator(caption·sfx)다. 이름 없는 등장인물은 extras로 선언한다.';

const asText = v => Array.isArray(v) ? v.map(String).join('; ') : v === undefined || v === null ? '' : String(v);
/** Cast from `source.cast`, else from the id, name and appearance frontmatter of `characters/` documents. */
export function episodeCast(source) {
  if (Array.isArray(source?.cast)) return source.cast;
  return (source?.documents ?? []).filter(d => typeof d?.path === 'string' && d.path.startsWith('characters/'))
    .map(d => parseDocument(d.raw).data).filter(data => nonempty(data.id))
    .map(data => ({ id: String(data.id), name: asText(data.name), appearance: asText(data.appearance) }));
}

export const pageTexts = page => (page?.panels ?? []).flatMap(panel => panel?.texts ?? []);
export const adaptationDigest = a => digest({ editorial: a.editorial, extras: a.extras, pages: a.pages, pageCountReason: a.pageCountReason });
export const pageDigest = page => digest(page);

const need = (ok, code) => { if (!ok) throw new Error(code); };
const uniqueIds = rows => { const ids = rows.map(r => r?.id); return ids.every(safeId) && new Set(ids).size === ids.length; };
const retained = beat => ['expand', 'condense'].includes(beat?.decision);

/** Deterministic structure, source and lettering checks. Throws Error(code) on the first failure. */
export function validateAdaptation(adaptation, { units, cast = [], maxPages = EPISODE_LIMITS.pageCapDefault, exactPages } = {}) {
  const [first] = validateEditorial(adaptation?.editorial, { units });
  if (first) throw new Error(first.code);
  const { pages, pageCountReason } = adaptation, extras = adaptation.extras ?? [];
  need(Array.isArray(pages) && pages.length > 0 && pages.length <= maxPages && (exactPages === undefined || pages.length === exactPages), 'EPISODE_PAGE_COUNT');
  need(nonempty(pageCountReason), 'EPISODE_PAGE_COUNT_REASON_REQUIRED');
  need(pages.every(p => Array.isArray(p?.panels)
    && p.panels.length >= EPISODE_LIMITS.panelsMin && p.panels.length <= EPISODE_LIMITS.panelsMax), 'EPISODE_PANEL_COUNT');
  need(Array.isArray(extras) && extras.every(e => e && Array.isArray(e.sourceIds)), 'EPISODE_EXTRA_SOURCE');
  const panels = pages.flatMap(p => p.panels);
  for (const p of panels) need(Array.isArray(p?.texts), 'EPISODE_PANEL_FIELDS_REQUIRED');
  const texts = panels.flatMap(p => p.texts);
  const castIds = new Set(cast.map(c => c.id));
  need(uniqueIds(pages) && uniqueIds(panels) && uniqueIds(texts) && uniqueIds(extras)
    && !extras.some(e => castIds.has(e.id) || e.id === 'narrator'), 'EPISODE_ID_DUPLICATE');
  const text = new Map(units.map(u => [u.id, u.text]));
  need(extras.every(e => e.sourceIds.every(id => text.has(id))), 'EPISODE_EXTRA_SOURCE');
  const speakers = new Set([...castIds, ...extras.map(e => e.id), 'narrator']);
  const beats = new Map(adaptation.editorial.beats.map(b => [b.id, b])), used = new Set();
  for (const page of pages) page.panels.forEach((panel, i) => {
    need(nonempty(panel.shows) && nonempty(panel.readerDelta) && nonempty(panel.bridge)
      && (i === 0 || panel.bridge.trim().toLowerCase() !== 'page opener') && Array.isArray(panel.beatIds) && panel.beatIds.length > 0, 'EPISODE_PANEL_FIELDS_REQUIRED');
    for (const id of panel.beatIds) { need(retained(beats.get(id)), 'EPISODE_EXCLUDED_BEAT_DRAWN'); used.add(id); }
    const own = new Set(panel.beatIds.flatMap(id => beats.get(id).sourceIds));
    need(Array.isArray(panel.sourceIds) && panel.sourceIds.length > 0 && panel.sourceIds.every(id => own.has(id)), 'EPISODE_PANEL_SOURCE_MISMATCH');
    need(panel.texts.length <= EPISODE_LIMITS.textsPerPanel && panel.texts.filter(t => t?.kind === 'physical').length <= EPISODE_LIMITS.physicalPerPanel, 'EPISODE_TEXT_LIMIT');
    for (const t of panel.texts) {
      need(typeof t?.text === 'string' && isVerbatimText(t.text, text.get(t.sourceId) ?? ''), 'EPISODE_TEXT_NOT_VERBATIM');
      need(SCENE_TEXT_KINDS.includes(t.kind) && speakers.has(t.speaker) && (!['caption', 'sfx'].includes(t.kind) || t.speaker === 'narrator'), 'EPISODE_TEXT_SPEAKER');
    }
  });
  need([...beats.values()].every(b => !retained(b) || used.has(b.id)), 'EPISODE_RETAINED_BEAT_MISSING');
  return adaptation;
}

export const pageState = (w, page) => (w.pages ?? []).find(p => p.id === page.id);

/** Runtime state of the page before `page`, only once it passed its own review; otherwise null (never a failed page). */
export function previousPageState(w, page) {
  const pages = w.adaptation?.pages ?? [], i = pages.findIndex(p => p.id === page.id);
  const state = i > 0 ? pageState(w, pages[i - 1]) : undefined;
  return state?.review?.passed === true ? state : null;
}

/** The page in the shape the scene validators and prompt blocks read: its panels' units and texts stand in for a scene. */
export function pageView(w, page) {
  const cited = new Set(page.panels.flatMap(p => p.sourceIds));
  return { panelCount: page.panels.length, sceneUnits: w.units.filter(u => cited.has(u.id)), scenePlan: { texts: pageTexts(page) }, styleSnapshot: w.styleSnapshot };
}

export const PAGE_BRIEF_CHECKS = ['shows', 'bridge', 'visibleRelations'];
export const PAGE_BRIEF_PROMPT = `Check only whether this page can be drawn: shows must be visible, each panel must follow from the previous one (bridge), and the visible relations between people, objects and places must be possible. Do not change facts, order or texts. Return renderBrief with exactly one moment per panel, in panel order; each moment's textIds equal that panel's text ids, its sourceIds cite the source units, and its action is ONE visible instant of at most ${SCENE_LIMITS.momentWords} English words. The style line is at most ${SCENE_LIMITS.styleWords} words. drawability judges this final brief; if the page cannot be drawn, fail it instead of deferring to the image model.`;

/** Binds a page brief to this adaptation, this page, the previous page image it will be drawn beside, the references, policy and style. */
export const pageBriefBinding = (w, page) => digest({ adaptation: adaptationDigest(w.adaptation), page: pageDigest(page),
  previousPageImage: previousPageState(w, page)?.image?.hash ?? null, references: w.references, policy: w.imagePolicy, styleRevision: w.styleSnapshot?.revisionId ?? null });

export const PAGE_FINDING_SHAPE = { severity: 'blocking | advisory', evidence: 'concrete evidence (required)' };

/** Skeleton the host fills: one moment per panel, texts pre-assigned in panel order. */
export const pageBriefSchema = (w, page) => ({ subjectHash: pageBriefBinding(w, page),
  checks: PAGE_BRIEF_CHECKS.map(id => ({ id, passed: false, evidence: '' })), findings: [], findingItem: PAGE_FINDING_SHAPE,
  renderBrief: { style: w.styleSnapshot?.profile.style ?? '', moments: page.panels.map(p => ({ sourceIds: [], action: '', textIds: p.texts.map(t => t.id) })) },
  drawability: { passed: false, evidence: '' } });

/** Throws on a stale, incomplete or reordered brief; false when a check or finding blocks; otherwise the drawability verdict. */
export function validatePageBrief(review, w, page) {
  need(review?.subjectHash === pageBriefBinding(w, page), 'STALE_PAGE_BRIEF');
  need(Array.isArray(review.findings) && Array.isArray(review.checks) && review.checks.length === PAGE_BRIEF_CHECKS.length
    && PAGE_BRIEF_CHECKS.every(id => review.checks.filter(c => c?.id === id && typeof c.passed === 'boolean' && nonempty(c.evidence)).length === 1), 'INCOMPLETE_PAGE_BRIEF');
  need(review.findings.every(f => ['blocking', 'advisory'].includes(f?.severity) && nonempty(f.evidence)), 'INVALID_PAGE_BRIEF_FINDING');
  if (!review.checks.every(c => c.passed) || review.findings.some(f => f.severity === 'blocking')) return false;
  const moments = review.renderBrief?.moments;
  if (Array.isArray(moments) && moments.length === page.panels.length) page.panels.forEach((panel, i) =>
    need(Array.isArray(moments[i]?.textIds) && moments[i].textIds.join('\n') === panel.texts.map(t => t.id).join('\n'), 'PAGE_BRIEF_ORDER'));
  validateSceneRenderBrief(review.renderBrief, pageView(w, page));
  need(typeof review.drawability?.passed === 'boolean' && nonempty(review.drawability?.evidence), 'PAGE_DRAWABILITY_REQUIRED');
  return review.drawability.passed;
}

/**
 * Reference images in attach order: the user's references, the adopted style sample, then the previous page once it passed.
 * Episode units carry no scene ids, so the user references lose their scene binding and render as plain roles.
 */
export function pageReferences(w, page) {
  const previous = previousPageState(w, page);
  return [...w.references.map(({ sceneIds, ...reference }) => reference), ...(w.styleSnapshot ? [styleReference(w.styleSnapshot)] : []),
    ...(previous ? [{ id: PREVIOUS_PAGE_ID, path: previous.image.path, hash: previous.image.hash, description: w.styleSnapshot
      ? 'Previous page of this episode: identities, clothing, current setting and temporal continuity. Visual treatment comes from the adopted style sample. Continue after its ending; leave its layout and lettering behind.'
      : 'Previous finished page of this episode: identity, clothing, style and temporal continuity only. Continue after its ending; do not copy its layout, text or unclear geometry.' }] : [])];
}

/** The image model sees the approved page brief (`w.pages[i].brief.renderBrief`), the exact texts and the reference roles; page k of n. */
export function pageImagePrompt(w, page, k, n) {
  const view = pageView(w, page), brief = validateSceneRenderBrief(pageState(w, page)?.brief?.renderBrief, view);
  return imagePromptBody({ ...view, sceneReferences: pageReferences(w, page), source: w.source }, brief, {
    opening: `Page ${k} of ${n} of one webtoon episode. Draw EXACTLY ${page.panels.length} panels. Choose panel sizes, layout and camera angles. Each panel shows one clear moment.`,
    references: `Match the character reference identities. ${previousPageState(w, page)
      ? 'The last image is the previous page of this episode: continue its identities, clothing and setting, not its events or layout.' : 'Reference sheets are for their described roles, not page layout.'}` });
}
