/**
 * Dialogue-ratio scan — counts dialogue lines (lines that start with a
 * Korean opening quote / contain dialogue markers) and compares against
 * genre's dialogueRatioRange. Out-of-range → SOFT FLAG `DIALOGUE_RATIO_OFF`.
 *
 * Quote conventions covered: `"…"` (Korean preference), `'…'`, `「…」`,
 * `『…』`. A line is counted as dialogue when ≥ 50% of its content lies
 * within balanced quote pairs.
 */
const QUOTE_PAIRS = [
    ['"', '"'],
    ['“', '”'],
    ["'", "'"],
    ['「', '」'],
    ['『', '』'],
];
import { skipKoLexical } from './checker-registry.js';
const MIN_LINES_FOR_SCAN = 6;
export function scanDialogueRatio(input) {
    const skipped = skipKoLexical(input, 'scanDialogueRatio');
    if (skipped)
        return skipped;
    const { prose, chapterNumber, genreProfile } = input;
    if (!prose || prose.trim().length === 0) {
        return {
            violations: [],
            stats: { totalLines: 0, dialogueLines: 0, ratio: 0 },
        };
    }
    const range = genreProfile.dialogueRatioRange;
    if (!range) {
        return {
            violations: [],
            stats: { totalLines: 0, dialogueLines: 0, ratio: 0 },
        };
    }
    const lines = prose
        .split(/\n+/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (lines.length < MIN_LINES_FOR_SCAN) {
        return {
            violations: [],
            stats: { totalLines: lines.length, dialogueLines: 0, ratio: 0 },
        };
    }
    let dialogue = 0;
    for (const line of lines) {
        if (isDialogueLine(line))
            dialogue++;
    }
    const ratio = dialogue / lines.length;
    const [min, max] = range;
    const violations = [];
    if (ratio < min) {
        violations.push({
            severity: 'soft',
            code: 'DIALOGUE_RATIO_OFF',
            chapterNumber,
            message: `대사 비율 ${(ratio * 100).toFixed(0)}% < 장르 하한 ${(min * 100).toFixed(0)}% (lines=${lines.length}, dialogue=${dialogue})`,
        });
    }
    else if (ratio > max) {
        violations.push({
            severity: 'soft',
            code: 'DIALOGUE_RATIO_OFF',
            chapterNumber,
            message: `대사 비율 ${(ratio * 100).toFixed(0)}% > 장르 상한 ${(max * 100).toFixed(0)}% (lines=${lines.length}, dialogue=${dialogue})`,
        });
    }
    return {
        violations,
        stats: { totalLines: lines.length, dialogueLines: dialogue, ratio },
    };
}
function isDialogueLine(line) {
    let inQuoteChars = 0;
    for (const [open, close] of QUOTE_PAIRS) {
        if (open === close) {
            // count pair-wise: each pair contributes their span length
            let inside = false;
            let start = -1;
            for (let i = 0; i < line.length; i++) {
                if (line[i] === open) {
                    if (!inside) {
                        start = i;
                        inside = true;
                    }
                    else {
                        inQuoteChars += i - start + 1;
                        inside = false;
                    }
                }
            }
        }
        else {
            let depth = 0;
            let start = -1;
            for (let i = 0; i < line.length; i++) {
                if (line[i] === open) {
                    if (depth === 0)
                        start = i;
                    depth++;
                }
                else if (line[i] === close && depth > 0) {
                    depth--;
                    if (depth === 0)
                        inQuoteChars += i - start + 1;
                }
            }
        }
    }
    return inQuoteChars / line.length >= 0.5;
}
