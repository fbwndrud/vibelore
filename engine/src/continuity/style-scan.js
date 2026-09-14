/**
 * Style-scan — layer-1 fatigue/cliché count over genre-specific style
 * lexicon. SOFT FLAG only; no HARD severity (fatigue is taste, not truth).
 *
 * Two metrics:
 *   - per-term overuse: any single term appears ≥ TERM_REPEAT_THRESHOLD
 *     times → `LEXICAL_FATIGUE` per term.
 *   - density: total fatigue-term count / wordCount > DENSITY_THRESHOLD
 *     → `CLICHE_DENSITY` once per chapter.
 */
const TERM_REPEAT_THRESHOLD = 3;
const DENSITY_THRESHOLD = 0.01;
export function scanStyle(input) {
    const { prose, chapterNumber, genre, lexicon } = input;
    if (!prose || prose.length === 0)
        return { violations: [] };
    const entries = lexicon.forGenre(genre);
    if (entries.length === 0)
        return { violations: [] };
    const violations = [];
    let totalHits = 0;
    for (const entry of entries) {
        if (!entry.surface)
            continue;
        const count = countOccurrences(prose, entry.surface);
        if (count === 0)
            continue;
        totalHits += count;
        if (count >= TERM_REPEAT_THRESHOLD) {
            violations.push({
                severity: 'soft',
                code: 'LEXICAL_FATIGUE',
                chapterNumber,
                message: `style 사전 '${entry.surface}' 반복 ${count}회 (장르=${genre}, kind=${entry.kind})`,
            });
        }
    }
    const wordCount = countWords(prose);
    if (wordCount > 0 && totalHits / wordCount > DENSITY_THRESHOLD) {
        violations.push({
            severity: 'soft',
            code: 'CLICHE_DENSITY',
            chapterNumber,
            message: `클리셰 밀도 ${((totalHits / wordCount) * 100).toFixed(2)}% (장르=${genre}, hits=${totalHits}/words=${wordCount})`,
        });
    }
    return { violations };
}
function countOccurrences(prose, term) {
    if (!term)
        return 0;
    let count = 0;
    let idx = 0;
    while ((idx = prose.indexOf(term, idx)) !== -1) {
        count++;
        idx += term.length;
    }
    return count;
}
function countWords(prose) {
    return prose.split(/\s+/).filter((w) => w.length > 0).length;
}
