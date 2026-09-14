/**
 * One place to build the Korean lexicon set the scans need.
 *
 * These seeds are the engine's hand-built work -- honorifics with context
 * guards, onomatopoeia, emotion verbs, simile markers, style and sensitivity.
 * They are the reason this plugin catches things a general-purpose model
 * reading its own draft does not, so they are wired once and shared rather
 * than reconstructed per call.
 */
import { DefaultHonorificLexicon } from '../../engine/src/continuity/honorific-lexicon.js';
import { DefaultEmotionVerbLexicon } from '../../engine/src/continuity/emotion-verb-lexicon.js';
import { DefaultSimileMarkerLexicon } from '../../engine/src/continuity/simile-marker-lexicon.js';
import { DefaultOnomatopoeiaLexicon } from '../../engine/src/continuity/onomatopoeia-lexicon.js';
import { DefaultSensitiveLexicon } from '../../engine/src/continuity/sensitive-lexicon.js';

let cached = null;

export function lexicons() {
  if (cached) return cached;
  cached = {
    honorific: new DefaultHonorificLexicon(),
    emotion: new DefaultEmotionVerbLexicon(),
    simile: new DefaultSimileMarkerLexicon(),
    onomatopoeia: new DefaultOnomatopoeiaLexicon(),
    sensitive: new DefaultSensitiveLexicon(),
  };
  return cached;
}
