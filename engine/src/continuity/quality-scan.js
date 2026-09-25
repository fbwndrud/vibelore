/**
 * Quality-scan — layer-1 Korean web-novel quality detectors built on
 * emotion-verb / simile-marker / onomatopoeia lexicons.
 *
 * All SOFT FLAGs — taste-level signals, not truth violations.
 *
 * Detectors:
 *   - N1 show-not-tell: emotion-verb count vs simile count (low ratio →
 *     `SHOW_NOT_TELL_LOW`).
 *   - N6 emotion overtell: 1인칭(`나는`/`내가`) + emotion-verb co-occurrence
 *     density (high → `EMOTION_OVERTELL`).
 *   - N8 onomatopoeia overuse: onomatopoeia density (high → `ONOMATOPOEIA_OVERUSE`).
 *   - N10 simile sparsity / overuse: simile-marker density extremes
 *     (`SIMILE_TOO_SPARSE` / `SIMILE_OVERUSE`).
 */
import { skipKoLexical } from './checker-registry.js';
// thresholds tuned for Korean web-novel pacing
const SHOW_NOT_TELL_RATIO_MIN = 0.3; // simile / emotion-verb ratio
const EMOTION_OVERTELL_DENSITY_MAX = 0.02; // first-person+emotion co-occur / wordCount
const ONOMATOPOEIA_DENSITY_MAX = 0.03; // onomato / wordCount
const SIMILE_DENSITY_MIN = 0.002;
const SIMILE_DENSITY_MAX = 0.04;
const FIRST_PERSON_MARKERS = ['나는', '내가', '나의', '나를', '내'];
export function scanQuality(input) {
    const skipped = skipKoLexical(input, 'scanQuality');
    if (skipped)
        return skipped;
    const { prose, chapterNumber, emotionLexicon, simileLexicon, onomatopoeiaLexicon } = input;
    if (!prose || prose.length === 0)
        return { violations: [] };
    const wordCount = countWords(prose);
    if (wordCount === 0)
        return { violations: [] };
    const emotionCount = countTokenSet(prose, emotionLexicon.all().map((e) => e.verb));
    const onomatoCount = countTokenSet(prose, onomatopoeiaLexicon.all().map((e) => e.word));
    const simileCount = countRegexSet(prose, simileLexicon.all().map((e) => e.patternSource));
    const violations = [];
    // N1 show-not-tell
    if (emotionCount >= 3 && simileCount / emotionCount < SHOW_NOT_TELL_RATIO_MIN) {
        violations.push({
            severity: 'soft',
            code: 'SHOW_NOT_TELL_LOW',
            chapterNumber,
            message: `직유 대비 감정동사 비율 부족 (similes=${simileCount}, emotions=${emotionCount}, ratio=${(simileCount / emotionCount).toFixed(2)} < ${SHOW_NOT_TELL_RATIO_MIN})`,
        });
    }
    // N6 emotion overtell — first-person + emotion co-occurrence at sentence level
    const overtellHits = countFirstPersonEmotionCooccurrence(prose, emotionLexicon);
    const overtellDensity = overtellHits / wordCount;
    if (overtellDensity > EMOTION_OVERTELL_DENSITY_MAX) {
        violations.push({
            severity: 'soft',
            code: 'EMOTION_OVERTELL',
            chapterNumber,
            message: `1인칭 감정 직접 진술 과잉 (hits=${overtellHits}, density=${(overtellDensity * 100).toFixed(2)}%)`,
        });
    }
    // N8 onomatopoeia overuse
    if (onomatoCount / wordCount > ONOMATOPOEIA_DENSITY_MAX) {
        violations.push({
            severity: 'soft',
            code: 'ONOMATOPOEIA_OVERUSE',
            chapterNumber,
            message: `의성어/의태어 과사용 (count=${onomatoCount}, density=${(onomatoCount / wordCount * 100).toFixed(2)}%)`,
        });
    }
    // N10 simile sparsity / overuse
    const simileDensity = simileCount / wordCount;
    if (simileDensity < SIMILE_DENSITY_MIN) {
        violations.push({
            severity: 'soft',
            code: 'SIMILE_TOO_SPARSE',
            chapterNumber,
            message: `직유/은유 빈도 부족 (count=${simileCount}, density=${(simileDensity * 100).toFixed(3)}%)`,
        });
    }
    else if (simileDensity > SIMILE_DENSITY_MAX) {
        violations.push({
            severity: 'soft',
            code: 'SIMILE_OVERUSE',
            chapterNumber,
            message: `직유/은유 과사용 (count=${simileCount}, density=${(simileDensity * 100).toFixed(2)}%)`,
        });
    }
    return { violations };
}
function countWords(prose) {
    return prose.split(/\s+/).filter((w) => w.length > 0).length;
}
function countTokenSet(prose, tokens) {
    let total = 0;
    for (const token of tokens) {
        if (!token)
            continue;
        let idx = 0;
        while ((idx = prose.indexOf(token, idx)) !== -1) {
            total++;
            idx += token.length;
        }
    }
    return total;
}
function countRegexSet(prose, patternSources) {
    let total = 0;
    for (const src of patternSources) {
        if (!src)
            continue;
        try {
            const re = new RegExp(src, 'g');
            const matches = prose.match(re);
            if (matches)
                total += matches.length;
        }
        catch {
            // skip invalid regex
        }
    }
    return total;
}
function countFirstPersonEmotionCooccurrence(prose, emotionLexicon) {
    const sentences = prose.split(/(?<=[.!?。…])\s+|\n+/);
    const emotionVerbs = emotionLexicon.all().map((e) => e.verb);
    let hits = 0;
    for (const sentence of sentences) {
        const hasFirstPerson = FIRST_PERSON_MARKERS.some((m) => sentence.includes(m));
        if (!hasFirstPerson)
            continue;
        const hasEmotion = emotionVerbs.some((v) => sentence.includes(v));
        if (hasEmotion)
            hits++;
    }
    return hits;
}
