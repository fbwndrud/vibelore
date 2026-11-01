import { COMPOSITION_VOCAB, COMPOSITION_VOCAB_VERSION, migrateCompositionLabel } from './webtoon-composition.js';

/** Dynamic-key sections: zero entries are dropped so incremental updates equal a full rebuild. */
const SPARSE = new Set(['pageClose', 'fingerprints']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const zeros = values => Object.fromEntries(values.map(v => [v, 0]));
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Fixed-length count vector over the vocabulary, plus the sparse pageClose and fingerprints maps. */
export function emptyVector() {
  return {
    ...Object.fromEntries(Object.entries(COMPOSITION_VOCAB).map(([field, values]) => [field, zeros(values)])),
    protagonistVisibility: zeros(COMPOSITION_VOCAB.visibility),
    twoShotSide: zeros(COMPOSITION_VOCAB.side),
    pageClose: {},
    fingerprints: {},
    panels: 0,
  };
}

function combine(a, b, sign, sparse) {
  const out = {};
  for (const key of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const x = a?.[key], y = b?.[key];
    if (plain(x) || plain(y)) out[key] = combine(x, y, sign, sparse || SPARSE.has(key));
    else { const value = (x ?? 0) + sign * (y ?? 0); if (value !== 0 || !sparse) out[key] = value; }
  }
  return out;
}
export const addVector = (a, b) => combine(a, b, 1, false);
export const subVector = (a, b) => combine(a, b, -1, false);

/** The constant-size part of a vector: what prefix sums and entity vectors store. */
const fixedPart = vector => ({ ...vector, pageClose: {}, fingerprints: {} });

const bump = (map, key, by = 1) => { map[key] = (map[key] ?? 0) + by; };
const closeKey = label => `${label.shot}|${label.subjects[0]?.id ?? '-'}`;

/**
 * Counts for one scene's rows. Only adopted, confident, mapped panels with a label count;
 * panels with required elements go to requiredCounts instead.
 */
export function sceneSummary(rows, { protagonistIds = [] } = {}) {
  const counts = emptyVector(), requiredCounts = emptyVector(), characters = {}, closes = [];
  const page = rows.filter(r => r.type === 'page' && r.status === 'adopted').at(-1);
  let sceneType = null;
  if (page) {
    sceneType = page.sceneType ?? null;
    if (COMPOSITION_VOCAB.layout.includes(page.layout)) counts.layout[page.layout] += 1;
  }
  for (const row of rows) {
    if (row.type !== 'panel' || row.status !== 'adopted' || row.confidence !== 'clear' || !plain(row.label)) continue;
    const label = migrateCompositionLabel(row.label, row.vocabVersion);
    if (label === 'unmapped' || !plain(label) || !Array.isArray(label.subjects)) continue;
    const required = Array.isArray(row.required) && row.required.length > 0;
    const target = required ? requiredCounts : counts;
    target.panels += 1;
    for (const field of ['shot', 'angle', 'focal', 'background']) bump(target[field], label[field]);
    for (const s of label.subjects) for (const field of ['visibility', 'side', 'facing', 'expression']) if (s[field] !== undefined) bump(target[field], s[field]);
    if (required) continue;
    if (row.fingerprint) bump(counts.fingerprints, row.fingerprint);
    const protagonist = label.subjects.find(s => protagonistIds.includes(s.id));
    if (protagonist) {
      if (protagonist.visibility !== undefined) bump(counts.protagonistVisibility, protagonist.visibility);
      if (label.subjects.length >= 2 && protagonist.side !== undefined) bump(counts.twoShotSide, protagonist.side);
    }
    if (page && row.panel === page.closePanel) { const key = closeKey(label); closes.push(key); bump(counts.pageClose, key); }
    for (const s of label.subjects) {
      const v = characters[s.id] ??= emptyVector();
      v.panels += 1;
      for (const field of ['shot', 'angle', 'focal', 'background']) bump(v[field], label[field]);
      for (const field of ['visibility', 'side', 'facing', 'expression']) if (s[field] !== undefined) bump(v[field], s[field]);
    }
  }
  return { counts, requiredCounts, closes, fingerprints: counts.fingerprints, sceneType, characters };
}

const sceneId = (episodeKey, sceneKey) => `${episodeKey}:${sceneKey}`;

/** Group an episode's rows by scene; a scene exists only when some row of it is adopted. */
function adoptedScenes(rows) {
  const byScene = new Map();
  for (const row of rows) {
    if (!byScene.has(row.sceneKey)) byScene.set(row.sceneKey, []);
    byScene.get(row.sceneKey).push(row);
  }
  return [...byScene].filter(([, list]) => list.some(r => r.status === 'adopted'));
}

const isZero = value => plain(value) ? Object.values(value).every(isZero) : value === 0;

function entityDelta(entities, prev, next) {
  const out = { character: { ...entities.character }, sceneType: { ...entities.sceneType } };
  const apply = (summary, sign) => {
    if (!summary) return;
    for (const [id, vector] of Object.entries(summary.characters)) out.character[id] = combine(out.character[id], vector, sign, false);
    if (summary.sceneType) out.sceneType[summary.sceneType] = combine(out.sceneType[summary.sceneType], fixedPart(summary.counts), sign, false);
  };
  apply(prev, -1); apply(next, 1);
  for (const group of Object.values(out)) for (const [id, v] of Object.entries(group)) if (isZero(v)) delete group[id];
  return out;
}

const prefixFrom = (order, episodes, from, base) => {
  const prefix = base.slice(0, from + 1);
  for (let i = from; i < order.length; i++) prefix[i + 1] = fixedPart(addVector(prefix[i], episodes[order[i]] ?? emptyVector()));
  return prefix;
};

/** Index over every episode in `rowsByEpisode` (`[{ episodeKey, rows }]`, already in reading order). */
export function buildIndex(rowsByEpisode, { protagonistIds = [], sourceHead = null } = {}) {
  const configured = [...protagonistIds];
  const build = resolved => {
    const scenes = {}, episodes = {}, order = [];
    let entities = { character: {}, sceneType: {} };
    for (const { episodeKey, rows } of rowsByEpisode) {
      order.push(episodeKey);
      let episode = emptyVector();
      for (const [key, list] of adoptedScenes(rows)) {
        const summary = sceneSummary(list, { protagonistIds: resolved });
        scenes[sceneId(episodeKey, key)] = summary;
        episode = addVector(episode, summary.counts);
        entities = entityDelta(entities, null, summary);
      }
      episodes[episodeKey] = episode;
    }
    return { vocabVersion: COMPOSITION_VOCAB_VERSION, sourceHead, configured, protagonistIds: resolved, scenes, episodes, order,
      prefix: prefixFrom(order, episodes, 0, [emptyVector()]), entities };
  };
  const first = build(configured);
  if (configured.length) return first;
  const resolved = protagonistIdsFor(first, []);
  return resolved.length ? build(resolved) : first;
}

/**
 * Subtract the scene's previous summary and add the new one (either may be null), then recompute prefix sums
 * from the first affected episode. The result deep-equals a full buildIndex over the same rows.
 * `order` is the current episode order (a new episode may appear); `sourceHead` the new digest.
 */
export function applySceneToIndex(index, id, prevSummary, nextSummary, { order = index.order, sourceHead = index.sourceHead } = {}) {
  const episodeKey = id.slice(0, id.indexOf(':'));
  const scenes = { ...index.scenes };
  if (nextSummary) scenes[id] = nextSummary; else delete scenes[id];
  const episodes = { ...index.episodes };
  episodes[episodeKey] = addVector(subVector(episodes[episodeKey] ?? emptyVector(), prevSummary?.counts ?? emptyVector()), nextSummary?.counts ?? emptyVector());
  for (const key of Object.keys(episodes)) if (!order.includes(key)) delete episodes[key];
  let shared = 0;
  while (shared < order.length && shared < index.order.length && order[shared] === index.order[shared]) shared++;
  const from = Math.max(0, Math.min(shared, order.indexOf(episodeKey)));
  return { ...index, sourceHead, scenes, episodes, order: [...order], prefix: prefixFrom(order, episodes, from, index.prefix),
    entities: entityDelta(index.entities, prevSummary, nextSummary) };
}

/** Counts over episodes fromIdx..toIdx (inclusive): one subtraction of prefix sums, plus the sparse maps of those episodes. */
export function windowCounts(index, fromIdx, toIdx) {
  const from = Math.max(0, fromIdx), to = Math.min(index.order.length - 1, toIdx);
  if (!(from <= to)) return emptyVector();
  const fixed = subVector(index.prefix[to + 1], index.prefix[from]);
  const sparse = emptyVector();
  for (let i = from; i <= to; i++) {
    const episode = index.episodes[index.order[i]];
    for (const key of SPARSE) for (const [k, n] of Object.entries(episode?.[key] ?? {})) bump(sparse[key], k, n);
  }
  return { ...fixed, pageClose: sparse.pageClose, fingerprints: sparse.fingerprints };
}

/** `configured` when set; otherwise the subject with the most adopted appearances (ties by id). */
export function protagonistIdsFor(index, configured = []) {
  if (configured.length) return [...configured];
  const ranked = Object.entries(index.entities.character).map(([id, v]) => [id, v.panels]).filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  return ranked.length ? [ranked[0][0]] : [];
}
