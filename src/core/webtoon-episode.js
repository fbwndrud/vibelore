import { parseDocument } from '../md/frontmatter.js';
import { digest, nonempty, safeId } from './webtoon-contract.js';
import { EDITORIAL_SCHEMA, validateEditorial } from './webtoon-editorial.js';
import { SCENE_TEXT_KINDS, isVerbatimText } from './webtoon-scene.js';

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
