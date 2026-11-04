import { digest } from './webtoon-contract.js';
import { COMPOSITION_VOCAB, EXTRA_SUBJECT_ID } from './webtoon-composition.js';
import { RETRY_FRAMING, isEnglish } from './webtoon-scene.js';
import { emptyVector, subVector, addVector, windowCounts, orderedScenes } from './webtoon-composition-aggregate.js';

export const DEFAULT_COMPOSITION_CONFIG = Object.freeze({ shortWindowEpisodes: 2, shortWindowScenes: 6, overuseDelta: 0.20, overuseMinCount: 4,
  streakLength: 3, observedBasisRate: 0.40, protagonistIds: Object.freeze([]) });

/** Share of each value when the work has too little history of its own (fewer than 3 baseline episodes). */
export const DEFAULT_PRIOR = Object.freeze({
  shot: { ECU: 0.05, CU: 0.15, MCU: 0.20, MS: 0.25, FS: 0.12, WS: 0.10, EST: 0.05, INSERT: 0.08 },
  angle: { eye: 0.55, high: 0.10, low: 0.10, top: 0.04, worm: 0.03, dutch: 0.04, ots: 0.10, pov: 0.04 },
  focal: { face: 0.35, hands: 0.12, prop: 0.12, space: 0.21, text: 0.05, 'two-face': 0.15 },
  background: { detailed: 0.45, bokeh: 0.15, flat: 0.15, white: 0.08, fx: 0.07, silhouette: 0.10 },
  protagonistVisibility: { face: 0.50, partial: 0.15, back: 0.15, hand: 0.08, silhouette: 0.12 },
  twoShotSide: { L: 0.35, C: 0.30, R: 0.35 },
  layout: { 'strip-stack': 0.25, 'split-row': 0.20, 'tall-panel': 0.15, bleed: 0.10, grid: 0.20, 'single-splash': 0.10 },
});

const FIELD_VALUES = { shot: COMPOSITION_VOCAB.shot, angle: COMPOSITION_VOCAB.angle, focal: COMPOSITION_VOCAB.focal, background: COMPOSITION_VOCAB.background,
  protagonistVisibility: COMPOSITION_VOCAB.visibility, twoShotSide: COMPOSITION_VOCAB.side, layout: COMPOSITION_VOCAB.layout };
const MENU_FIELDS = ['shot', 'angle', 'focal', 'background'];
const MIN_BASELINE_EPISODES = 3, MAX_OVERUSED = 3, MAX_STREAKS = 2, MAX_LINES = 8, MAX_MENU = 3, PER_FIELD_CANDIDATES = 2;

/** Positive wording tables. Plural noun phrases for overuse lines, article phrases for streaks and menu options. */
const PLURAL = {
  shot: { ECU: 'extreme close-ups', CU: 'close-ups', MCU: 'medium close-ups', MS: 'medium shots', FS: 'full-body shots', WS: 'wide shots', EST: 'establishing shots', INSERT: 'insert details' },
  angle: { eye: 'eye-level views', high: 'high-angle views', low: 'low-angle views', top: 'overhead views', worm: 'ground-level views', dutch: 'tilted views', ots: 'over-the-shoulder views', pov: 'first-person views' },
  focal: { face: 'face-focused frames', hands: 'hand-focused frames', prop: 'prop-focused frames', space: 'space-focused frames', text: 'text-focused frames', 'two-face': 'two-face frames' },
  background: { detailed: 'detailed backgrounds', bokeh: 'blurred backgrounds', flat: 'flat backgrounds', white: 'white backgrounds', fx: 'effect backgrounds', silhouette: 'silhouette backgrounds' },
  layout: { 'strip-stack': 'strip-stack layouts', 'split-row': 'split-row layouts', 'tall-panel': 'tall-panel layouts', bleed: 'bleed layouts', grid: 'grid layouts', 'single-splash': 'single-splash layouts' },
};
const SINGULAR = {
  shot: { ECU: 'an extreme close-up', CU: 'a close-up', MCU: 'a medium close-up', MS: 'a medium shot', FS: 'a full-body shot', WS: 'a wide shot', EST: 'an establishing shot', INSERT: 'an insert detail' },
  angle: { eye: 'an eye-level view', high: 'a high-angle view', low: 'a low-angle view', top: 'an overhead view', worm: 'a ground-level view', dutch: 'a tilted view', ots: 'an over-the-shoulder view', pov: 'a first-person view' },
  focal: { face: 'a face-focused frame', hands: 'a hand-focused frame', prop: 'a prop-focused frame', space: 'a space-focused frame', text: 'a text-focused frame', 'two-face': 'a two-face frame' },
  background: { detailed: 'a detailed background', bokeh: 'a blurred background', flat: 'a flat background', white: 'a white background', fx: 'an effect background', silhouette: 'a silhouette background' },
};
const SIDE_WORDS = { L: 'on the left', C: 'at the center', R: 'on the right' };
const VISIBILITY_PHRASE = {
  face: who => `${who}'s face`, partial: who => `partial views of ${who}`, back: who => `${who} seen from behind`,
  hand: who => `${who}'s hands`, silhouette: who => `${who} in silhouette`,
};

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = text => isEnglish(text) && !RETRY_FRAMING.test(text);
const round2 = n => Math.round(n * 100) / 100;
const sum = table => Object.values(table ?? {}).reduce((a, b) => a + b, 0);
const who = id => clean(id) ? id : 'a character';

/** Deterministic generator seeded from the digest of the seed text. */
function prng(seed) {
  let state = parseInt(digest(String(seed ?? '')).slice('sha256:'.length, 'sha256:'.length + 8), 16) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function settings(config) {
  const merged = { ...DEFAULT_COMPOSITION_CONFIG, ...(plain(config) ? config : {}) };
  return { ...merged, protagonistIds: [...(merged.protagonistIds ?? [])] };
}

/** Short window (recent episodes, or recent scenes of a one-episode work) against the long baseline before it. */
function windowsOf(index, episodeKey, cfg) {
  const at = index.order.indexOf(episodeKey);
  const last = at >= 0 ? at : index.order.length - 1, count = last + 1;
  if (count <= 0) return { short: emptyVector(), base: emptyVector(), baselineEpisodes: 0, last };
  if (count >= 2) {
    const from = Math.max(0, count - cfg.shortWindowEpisodes);
    return { short: windowCounts(index, from, last), base: from > 0 ? windowCounts(index, 0, from - 1) : emptyVector(), baselineEpisodes: from, last };
  }
  const episode = index.order[0];
  const scenes = orderedScenes(index).filter(scene => scene.episodeKey === episode);
  const short = scenes.slice(-cfg.shortWindowScenes).reduce((acc, scene) => addVector(acc, scene.summary.counts), emptyVector());
  return { short, base: subVector(index.episodes[episode] ?? emptyVector(), short), baselineEpisodes: 0, last };
}

/** Baseline share of one value, or the prior when the history is too short or the field has no confident panel. */
function baselineShare(win, field, value) {
  const total = sum(win.base[field]);
  if (win.baselineEpisodes < MIN_BASELINE_EPISODES || total <= 0) return { share: DEFAULT_PRIOR[field][value] ?? 0, basis: 'prior' };
  return { share: (win.base[field][value] ?? 0) / total, basis: 'baseline' };
}

function overusedOf(win, cfg) {
  const found = [];
  for (const [fieldIndex, field] of Object.keys(FIELD_VALUES).entries()) {
    const shortTotal = sum(win.short[field]);
    if (shortTotal <= 0) continue;
    for (const value of FIELD_VALUES[field]) {
      const shortCount = win.short[field][value] ?? 0;
      if (shortCount < cfg.overuseMinCount) continue;
      const shortShare = shortCount / shortTotal, { share, basis } = baselineShare(win, field, value);
      const delta = shortShare - share;
      if (delta + 1e-9 >= cfg.overuseDelta) found.push({ field, value, shortCount, shortShare: round2(shortShare), baselineShare: round2(share), basis, delta, fieldIndex });
    }
  }
  return found.sort((a, b) => b.delta - a.delta || a.fieldIndex - b.fieldIndex || (a.value < b.value ? -1 : 1)).slice(0, MAX_OVERUSED)
    .map(({ delta, fieldIndex, ...rest }) => rest);
}

function pagesUpTo(index, last) {
  return orderedScenes(index).filter(scene => scene.episodeIndex <= last).map(scene => scene.summary);
}

const runLength = (pages, valueOf) => {
  const target = valueOf(pages.at(-1));
  if (target === undefined) return 0;
  let n = 0;
  for (let i = pages.length - 1; i >= 0 && valueOf(pages[i]) === target; i--) n++;
  return n;
};

/** Repetition that runs up to the latest adopted page: same close, same two-shot side, or the same framing. */
function streaksOf(index, last, cfg) {
  const pages = pagesUpTo(index, last);
  if (!pages.length) return [];
  const found = [];
  const closeLength = runLength(pages, p => p.closes?.[0]);
  if (closeLength >= cfg.streakLength) found.push({ kind: 'pageClose', key: pages.at(-1).closes[0], length: closeLength });
  const sideOf = p => { const sides = Object.entries(p.counts?.twoShotSide ?? {}).filter(([, n]) => n > 0).map(([side]) => side); return sides.length === 1 ? sides[0] : undefined; };
  const sideLength = runLength(pages, sideOf);
  if (sideLength >= cfg.streakLength) found.push({ kind: 'twoShotSide', key: sideOf(pages.at(-1)), length: sideLength });
  let best = { key: undefined, length: 0 };
  for (const key of Object.keys(pages.at(-1).fingerprints ?? {}).sort()) {
    const length = runLength(pages, p => (p.fingerprints ?? {})[key] > 0 ? key : undefined);
    if (length > best.length) best = { key, length };
  }
  if (best.length >= cfg.streakLength) found.push({ kind: 'fingerprint', key: best.key, length: best.length });
  return found.slice(0, MAX_STREAKS);
}

function overusePhrase(item, lead) {
  const names = PLURAL[item.field];
  return item.field === 'protagonistVisibility' ? VISIBILITY_PHRASE[item.value](who(lead))
    : item.field === 'twoShotSide' ? `${who(lead)} ${SIDE_WORDS[item.value]} in two-shots` : names[item.value];
}

/** "A", "A and B", "A, B and C". */
const joinList = items => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** One line for every overused value, so the planner reads a single note about repetition. */
const overuseLine = (items, lead) => `Recent pages lean on ${joinList(items.map(item => overusePhrase(item, lead)))}; give the next page a fresh framing.`;

function streakLine(streak, lead) {
  if (streak.kind === 'pageClose') {
    const [shot, id] = streak.key.split('|');
    return `The last ${streak.length} pages each closed on ${SINGULAR.shot[shot] ?? 'one framing'}${id && id !== '-' ? ` of ${who(id)}` : ''}; let the next page close on a different beat.`;
  }
  if (streak.kind === 'twoShotSide') return `The last ${streak.length} two-shot pages kept ${who(lead)} ${SIDE_WORDS[streak.key]}; let the next page vary the arrangement.`;
  return `The last ${streak.length} pages repeated one framing and arrangement; open the next page with a fresh composition.`;
}

function analyze(index, { episodeKey, config }) {
  const cfg = settings(config);
  const win = windowsOf(index, episodeKey, cfg);
  const lead = (index.protagonistIds ?? [])[0];
  const overused = overusedOf(win, cfg), streaks = streaksOf(index, win.last, cfg);
  return { cfg, win, lead, overused, streaks,
    lines: [...(overused.length ? [overuseLine(overused, lead)] : []), ...streaks.map(s => streakLine(s, lead))] };
}

/** The least used values per menu field (and cast subjects) that no required element locks, drawn with the seeded generator. */
function menuOf(index, win, { castIds, requiredLocks, seed }) {
  const locked = new Set(requiredLocks ?? []);
  const candidates = [];
  for (const field of MENU_FIELDS) {
    if (locked.has(field)) continue;
    const ranked = FIELD_VALUES[field].map((value, i) => ({ field, value, share: baselineShare(win, field, value).share, order: i }))
      .sort((a, b) => a.share - b.share || a.order - b.order);
    for (const entry of ranked.slice(0, PER_FIELD_CANDIDATES)) candidates.push({ field, value: entry.value, text: SINGULAR[field][entry.value] });
  }
  if (!locked.has('subject')) {
    const characters = index.entities?.character ?? {};
    const total = Object.values(characters).reduce((n, v) => n + (v.panels ?? 0), 0);
    const pool = Array.isArray(castIds) && castIds.length ? [...new Set(castIds)] : Object.keys(characters);
    const ranked = pool.filter(id => typeof id === 'string' && id !== EXTRA_SUBJECT_ID && clean(`${id}'s reaction`))
      .map(id => ({ id, share: total > 0 ? (characters[id]?.panels ?? 0) / total : 0 }))
      .sort((a, b) => a.share - b.share || (a.id < b.id ? -1 : 1));
    for (const entry of ranked.slice(0, PER_FIELD_CANDIDATES)) candidates.push({ field: 'subject', value: entry.id, text: `${entry.id}'s reaction` });
  }
  const random = prng(seed);
  for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
  const picked = [];
  for (const candidate of candidates) if (picked.length < MAX_MENU && !picked.some(p => p.field === candidate.field)) picked.push(candidate);
  return picked.length >= 2 ? picked : [];
}

function basisOf(basisStats, cfg) {
  const total = Number(basisStats?.total), corrected = Number(basisStats?.corrected);
  const valid = Number.isFinite(total) && Number.isFinite(corrected) && total > 0 && corrected >= 0;
  const rate = valid ? corrected / total : 0;
  return { correctedRate: round2(rate), observationCorrected: valid && total >= cfg.overuseMinCount && rate > cfg.observedBasisRate };
}

/**
 * Planner-facing summary of the work's framing history, in priority order: overused labels, streaks, a menu of
 * fresh options, and whether the history is mostly review-corrected. Positive wording only.
 */
export function compositionDigest(index, { episodeKey, castIds, requiredLocks, seed, config, basisStats } = {}) {
  const analysis = analyze(index, { episodeKey, config });
  const menu = menuOf(index, analysis.win, { castIds, requiredLocks, seed });
  const basis = basisOf(basisStats, analysis.cfg);
  const lines = [...analysis.lines,
    ...(menu.length ? [`Fresh options for this page, if the source allows: ${menu.map(o => o.text).join('; ')}.`] : []),
    ...(basis.observationCorrected ? ['Much of the recorded history reflects review corrections, so these counts follow the drawn pages.'] : [])]
    .filter(clean).slice(0, MAX_LINES);
  return { lines, overused: analysis.overused, streaks: analysis.streaks, menu, basis };
}

/** A soft note for after adoption when a streak or overuse reaches the latest page; null when there is none. */
export function compositionAdvisory(index, { episodeKey, config } = {}) {
  const { overused, streaks, lines } = analyze(index, { episodeKey, config });
  if (!overused.length && !streaks.length) return null;
  return { severity: 'advisory', category: 'composition', code: 'COMPOSITION_REPETITION', evidence: lines.filter(clean).join(' ') };
}
