/**
 * Sentence-stats — layer-1 prosodic rhythm scan.
 *
 * Splits prose into sentences (Korean punctuation aware), computes mean +
 * std-dev of character counts. Extremes flag SOFT:
 *   - low std-dev (monotone rhythm) → `SENTENCE_MONOTONY`
 *   - high std-dev (erratic rhythm) → `SENTENCE_CHAOS`
 *
 * Korean web-novel typical: mean 20-40 chars, std-dev 10-20. Thresholds
 * tuned for that range.
 */
import { promptFamilyFrom } from './checker-registry.js';
// Tuned for Korean web-novel typical distribution.
const MIN_SENTENCES_FOR_SCAN = 10;
const STDEV_MONOTONY_MAX = 6; // very tight distribution
const STDEV_CHAOS_MIN = 30; // very erratic distribution

function computeLengthStats(sentences) {
    if (sentences.length === 0)
        return { sentenceCount: 0, meanLength: 0, stdev: 0 };
    const lengths = sentences.map((s) => s.length);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((acc, l) => acc + (l - mean) ** 2, 0) / lengths.length;
    return { sentenceCount: sentences.length, meanLength: mean, stdev: Math.sqrt(variance) };
}

export function scanSentenceStats(input) {
    const { prose, chapterNumber } = input;
    const family = promptFamilyFrom(input);
    if (!prose || prose.trim().length === 0) {
        return {
            violations: [],
            stats: { sentenceCount: 0, meanLength: 0, stdev: 0 },
            ...(family ? { status: 'passed' } : {}),
        };
    }
    const sentences = splitSentences(prose, { allowNoSpaceTerminator: family === 'multilingual' });
    const stats = computeLengthStats(sentences);
    if (family === 'multilingual') {
        return {
            violations: [],
            stats,
            status: 'skipped',
            skipReason: 'ko_rhythm_threshold_not_applied',
            invariantCoverage: 'not_applicable',
            score: null,
        };
    }
    if (sentences.length < MIN_SENTENCES_FOR_SCAN) {
        return {
            violations: [],
            stats: { sentenceCount: sentences.length, meanLength: 0, stdev: 0 },
        };
    }
    const { meanLength: mean, stdev } = stats;
    const violations = [];
    if (stdev < STDEV_MONOTONY_MAX) {
        violations.push({
            severity: 'soft',
            code: 'SENTENCE_MONOTONY',
            chapterNumber,
            message: `문장 길이 std-dev=${stdev.toFixed(2)} < ${STDEV_MONOTONY_MAX} — 리듬 단조 (mean=${mean.toFixed(1)}, n=${sentences.length})`,
        });
    }
    else if (stdev > STDEV_CHAOS_MIN) {
        violations.push({
            severity: 'soft',
            code: 'SENTENCE_CHAOS',
            chapterNumber,
            message: `문장 길이 std-dev=${stdev.toFixed(2)} > ${STDEV_CHAOS_MIN} — 리듬 불안정 (mean=${mean.toFixed(1)}, n=${sentences.length})`,
        });
    }
    return {
        violations,
        stats: { sentenceCount: sentences.length, meanLength: mean, stdev },
    };
}
/**
 * Korean prose sentence split — punctuation `. ! ? 。 …` followed by
 * whitespace OR newline boundaries. Quoted dialogue lines counted as
 * sentences too (split on closing quote + whitespace).
 */
function splitSentences(prose, { allowNoSpaceTerminator = false } = {}) {
    const splitter = allowNoSpaceTerminator
        ? /(?<=[.!?。…！？])\s*|\n+/
        : /(?<=[.!?。…])\s+|\n+/;
    return prose
        .split(splitter)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
