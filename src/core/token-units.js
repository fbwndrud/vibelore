/**
 * Prompt budget estimate in model tokens, by script.
 *
 * The original heuristic was code points / 2, which fits Korean (one Hangul
 * syllable is roughly half a token to one token). Latin, Cyrillic and Greek
 * text runs closer to four characters per token, so the same divisor read a
 * Spanish EpisodePlan as twice its real size and overflowed the writer packet
 * (2026-09-15 es sample). Dense scripts (CJK, Kana, Hangul, Arabic, Hebrew,
 * Thai, Indic) keep the / 2 estimate; everything else uses / 4. Pure Korean
 * input yields exactly the previous value.
 */
const DENSE_SCRIPT = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Sinhala}\p{Script=Tibetan}]/u;

export function tokenUnits(value) {
  const text = String(value ?? '');
  if (text.length === 0) return 1;
  let dense = 0;
  let sparse = 0;
  for (const char of text) {
    if (DENSE_SCRIPT.test(char)) dense += 1;
    else sparse += 1;
  }
  // A sparse run attached to dense text (punctuation, spaces, digits inside
  // Korean prose) is charged at the dense rate so Korean estimates stay put.
  if (dense > 0 && sparse <= dense) return Math.max(1, Math.ceil((dense + sparse) / 2));
  return Math.max(1, Math.ceil(dense / 2 + sparse / 4));
}
