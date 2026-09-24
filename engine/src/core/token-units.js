/**
 * Prompt budget units, by script — Korean-equivalent content units.
 *
 * This is a deliberate duplicate of `src/core/token-units.js` in the plugin
 * package. `engine` (`@vibelore/novel-engine`) is a standalone package that
 * the plugin depends on, never the other way around, so it cannot import the
 * plugin's copy. Keep the two in sync; see the plugin copy for the full
 * calibration note (2026-09-15 Sonnet 5 acceptance runs).
 *
 *   - Hangul, Han, Kana: / 2 (unchanged; pure Korean yields the old value)
 *   - Thai and the other abugidas (Lao, Khmer, Myanmar, Indic), Arabic and
 *     Hebrew: / 3
 *   - everything else (Latin, Cyrillic, Greek, …): / 4
 */
const MID_SCRIPT = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Sinhala}\p{Script=Tibetan}]/u;
const DENSE_SCRIPT = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u;

export function tokenUnits(value) {
  const text = String(value ?? '');
  if (text.length === 0) return 1;
  let dense = 0;
  let mid = 0;
  let sparse = 0;
  for (const char of text) {
    if (DENSE_SCRIPT.test(char)) dense += 1;
    else if (MID_SCRIPT.test(char)) mid += 1;
    else sparse += 1;
  }
  // A sparse run attached to dense text (punctuation, spaces, digits inside
  // Korean prose) is charged at the dense rate so Korean estimates stay put.
  if (dense > 0 && mid + sparse <= dense) return Math.max(1, Math.ceil((dense + mid + sparse) / 2));
  return Math.max(1, Math.ceil(dense / 2 + mid / 3 + sparse / 4));
}
