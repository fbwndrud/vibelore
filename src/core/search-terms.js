/**
 * Search terms for the memory index and the MemoryCompiler ranker.
 *
 * Words come from Intl.Segmenter so scripts written without spaces (ja,
 * zh-Hant, th) produce words instead of one run per sentence. A Hangul word
 * that ends in a common particle also yields its stem, so "수아가" and "수아는"
 * meet at "수아" while the surface form stays searchable.
 */
const KO_PARTICLES = [
  '에서는', '에게서', '으로는', '이라는', '에서', '에게', '한테', '께서', '으로', '까지', '부터', '처럼',
  '보다', '마저', '조차', '이나', '이랑', '은', '는', '이', '가', '을', '를', '의', '에', '와', '과',
  '도', '로', '만', '랑', '나',
];
const HANGUL_WORD = /^[가-힣]+$/u;
const HAN_CHAR = /^\p{Script=Han}$/u;
const WORD = /[\p{L}\p{N}_]+/gu;
const segmenters = new Map();

function segmenter(language) {
  const key = language || 'und';
  if (!segmenters.has(key)) {
    let value = null;
    try { value = new Intl.Segmenter(key, { granularity: 'word' }); } catch { value = null; }
    segmenters.set(key, value);
  }
  return segmenters.get(key);
}

function words(text, language) {
  const seg = segmenter(language);
  if (!seg) return text.match(WORD) ?? [];
  return [...seg.segment(text)].filter((part) => part.isWordLike).map((part) => part.segment);
}

function koreanStem(word) {
  if (!HANGUL_WORD.test(word)) return null;
  const particle = KO_PARTICLES.find((item) => word.endsWith(item) && [...word].length - [...item].length >= 2);
  return particle ? word.slice(0, -particle.length) : null;
}

export function searchTerms(value, language) {
  const text = String(value ?? '').normalize('NFC');
  const found = new Set();
  for (const raw of words(text, language)) {
    const word = raw.toLocaleLowerCase(language || undefined);
    const keep = [...word].length >= 2 || HAN_CHAR.test(word);
    if (keep) found.add(word);
    const stem = koreanStem(word);
    if (stem) found.add(stem);
  }
  return [...found];
}

export const SEARCH_TERMS_REVISION = 'intl-segmenter-ko-stem-1';
