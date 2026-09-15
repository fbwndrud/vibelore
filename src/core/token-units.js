/**
 * Prompt budget units, by script — Korean-equivalent content units.
 *
 * Every prompt budget in the plugin (writer packet 1400, draft plan 4000, …)
 * was calibrated on Korean text with the original code points / 2 heuristic.
 * The budgets are content-discipline knobs, so the same plan content in
 * another language must measure about the same number of units. Measured on
 * the 2026-09-15 Sonnet 5 acceptance runs, identical-schema responses
 * (profile, spine, writer skill, arc, episode plan) were this many characters
 * relative to Korean: ja 0.89, zh-Hant 0.86, th 1.64, ar 1.64, es 1.89,
 * fr 1.91, en 2.24. Characters per unit is therefore 2 × that factor:
 *   - Hangul, Han, Kana: / 2 (unchanged; pure Korean yields the old value)
 *   - Thai and the other abugidas (Lao, Khmer, Myanmar, Indic), Arabic and
 *     Hebrew: / 3 (measured 3.3; a Thai plan read at / 2 overflowed the writer
 *     packet as 1930 units — the same content in Korean was ~1200)
 *   - everything else (Latin, Cyrillic, Greek, …): / 4 (measured 3.8–4.5)
 * These are not model-token estimates: the same runs put Claude at roughly
 * 1.3 chars/token for ko/ja/zh/th, 1.6 for ar and 2.4–2.8 for es/fr/en, so the
 * budgets deliberately admit more real tokens for token-expensive scripts.
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
