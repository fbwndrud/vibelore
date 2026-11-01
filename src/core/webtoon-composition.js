import { digest, safeId } from './webtoon-contract.js';
import { RETRY_FRAMING, isEnglish } from './webtoon-scene.js';

/** Bump on any vocabulary change and add a VOCAB_MIGRATIONS entry mapping the old values to the new ones. */
export const COMPOSITION_VOCAB_VERSION = 1;
const frozen = (...values) => Object.freeze(values);
export const COMPOSITION_VOCAB = Object.freeze({
  shot: frozen('ECU', 'CU', 'MCU', 'MS', 'FS', 'WS', 'EST', 'INSERT'),
  angle: frozen('eye', 'high', 'low', 'top', 'worm', 'dutch', 'ots', 'pov'),
  visibility: frozen('face', 'partial', 'back', 'hand', 'silhouette'),
  side: frozen('L', 'C', 'R'),
  facing: frozen('L', 'R', 'front', 'back', 'down'),
  expression: frozen('neutral', 'scowl', 'smirk', 'shock', 'laugh', 'soft', 'tired', 'other'),
  focal: frozen('face', 'hands', 'prop', 'space', 'text', 'two-face'),
  background: frozen('detailed', 'bokeh', 'flat', 'white', 'fx', 'silhouette'),
  layout: frozen('strip-stack', 'split-row', 'tall-panel', 'bleed', 'grid', 'single-splash'),
});
export const REQUIRED_KINDS = Object.freeze(['character', 'prop', 'action', 'location', 'text', 'state']);
export const SCENE_TYPES = Object.freeze(['dialogue', 'action', 'reveal', 'quiet']);
export const COMPOSITION_LIMITS = Object.freeze({ directedPerPage: 2, noteWords: 12 });

/** Old-version value maps keyed by source version; empty while only version 1 exists. */
const VOCAB_MIGRATIONS = {};

const invalid = detail => { throw new Error(`INVALID_SCENE_COMPOSITION: ${detail}`); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const oneOf = (field, value) => { if (!COMPOSITION_VOCAB[field].includes(value)) invalid(`${field} is not in the vocabulary`); };

/** Throws on any off-vocabulary or malformed field; returns the label unchanged when it is valid. */
export function validateCompositionLabel(label, { castIds } = {}) {
  if (!plain(label)) invalid('label must be an object');
  if (label.vocabVersion !== undefined && !(Number.isInteger(label.vocabVersion) && label.vocabVersion >= 1)) invalid('vocabVersion must be a positive integer');
  if (label.vocabVersion > COMPOSITION_VOCAB_VERSION) throw new Error('UNMAPPED_COMPOSITION: label vocabulary is newer than this server');
  for (const field of ['shot', 'angle', 'focal', 'background']) oneOf(field, label[field]);
  if (!Array.isArray(label.subjects)) invalid('subjects must be an array');
  for (const s of label.subjects) {
    if (!plain(s) || !safeId(s.id)) invalid('subject id is invalid');
    if (castIds && !castIds.includes(s.id)) invalid('subject is not in the cast');
    for (const field of ['visibility', 'side', 'facing', 'expression']) if (s[field] !== undefined) oneOf(field, s[field]);
  }
  if (label.directed !== undefined && typeof label.directed !== 'boolean') invalid('directed must be a boolean');
  if (label.required !== undefined) {
    if (!Array.isArray(label.required)) invalid('required must be an array');
    for (const r of label.required) if (!plain(r) || !REQUIRED_KINDS.includes(r.kind)) invalid('required kind is not in the vocabulary');
  }
  if (label.note !== undefined && (typeof label.note !== 'string' || label.note.trim().split(/\s+/).length > COMPOSITION_LIMITS.noteWords)) invalid(`note exceeds ${COMPOSITION_LIMITS.noteWords} words`);
  return label;
}

/** Framing identity for aggregation: shot, angle and who is visible where; ignores order, notes and direction flags. */
export const compositionFingerprint = label => digest([label.shot, label.angle,
  [...label.subjects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(s => `${s.id}:${s.visibility}:${s.side}`)]);

/** Carry a stored label to the current vocabulary; 'unmapped' labels are excluded from aggregation. */
export function migrateCompositionLabel(label, fromVersion) {
  if (fromVersion === COMPOSITION_VOCAB_VERSION) return label;
  if (!Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion > COMPOSITION_VOCAB_VERSION) return 'unmapped';
  let current = label;
  for (let v = fromVersion; v < COMPOSITION_VOCAB_VERSION; v++) {
    const step = VOCAB_MIGRATIONS[v];
    if (typeof step !== 'function') return 'unmapped';
    current = step(current);
    if (current === 'unmapped' || current === undefined) return 'unmapped';
  }
  return current;
}

const SHOT_WORDS = { ECU: 'extreme close', CU: 'close', MCU: 'medium close', MS: 'medium', FS: 'full-body', WS: 'wide', EST: 'establishing', INSERT: 'insert detail' };
const ANGLE_WORDS = { eye: 'eye-level', high: 'high-angle', low: 'low-angle', top: 'overhead', worm: 'ground-level', dutch: 'tilted', ots: 'over-the-shoulder', pov: 'first-person' };
const NAMED_FOCI = ['face', 'hands', 'two-face'];
const wordCount = text => text.trim().split(/\s+/).length;
const safePhrase = text => isEnglish(text) && wordCount(text) <= COMPOSITION_LIMITS.noteWords && !RETRY_FRAMING.test(text);

/** Short positive framing line for the image prompt, e.g. "wide high-angle view". */
export function framingPhrase(label, nameOf) {
  const base = `${SHOT_WORDS[label.shot]} ${ANGLE_WORDS[label.angle]} view`;
  const first = NAMED_FOCI.includes(label.focal) ? label.subjects?.[0]?.id : undefined;
  if (first === undefined || typeof nameOf !== 'function') return base;
  const name = String(nameOf(first) ?? '').trim();
  const named = `${base} of ${name}`;
  return name && safePhrase(named) ? named : base;
}

const COMPOSITION_SENTENCE = /\b(framing|close-?ups?|wide shots?|camera|angles?|layout|panel sizes?|single-column|vertical scroll|shots?)\b/i;

/**
 * Separate series-level composition sentences from the style direction so the image prompt carries style only.
 * When every sentence is about composition, the direction is kept whole.
 */
export function splitCompositionDirection(direction) {
  const sentences = String(direction).trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const moved = sentences.filter(s => COMPOSITION_SENTENCE.test(s));
  const kept = sentences.filter(s => !COMPOSITION_SENTENCE.test(s));
  return kept.length && moved.length ? { direction: kept.join(' '), compositionDefaults: moved } : { direction, compositionDefaults: [] };
}
