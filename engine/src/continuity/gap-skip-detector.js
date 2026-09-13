/**
 * Gap-skip detector — Korean time-skip markers. Zero markers across a
 * chapter → SOFT FLAG `NO_TIME_SKIP` (chapter likely drags in one breath).
 *
 * Pure lexical, deterministic. Match anywhere in prose, not just last
 * paragraph (differs from cliffhanger which checks last paragraph only).
 */
export const GAP_SKIP_MARKERS = [
    // === short-skip ===
    { patternSource: '몇\\s?시간\\s?(?:후|뒤)', kind: 'short-skip' },
    { patternSource: '몇\\s?시간이\\s?흘러', kind: 'short-skip' },
    { patternSource: '그날\\s?저녁', kind: 'short-skip' },
    { patternSource: '그날\\s?밤', kind: 'short-skip' },
    { patternSource: '잠시\\s?후', kind: 'short-skip' },
    { patternSource: '잠시\\s?뒤', kind: 'short-skip' },
    { patternSource: '한참\\s?후', kind: 'short-skip' },
    { patternSource: '한참\\s?뒤', kind: 'short-skip' },
    { patternSource: '얼마\\s?후', kind: 'short-skip' },
    { patternSource: '얼마\\s?지나지\\s?않아', kind: 'short-skip' },
    { patternSource: '곧이어', kind: 'short-skip' },
    { patternSource: '이윽고', kind: 'short-skip' },
    // === day-skip ===
    { patternSource: '다음\\s?날', kind: 'day-skip' },
    { patternSource: '이튿날', kind: 'day-skip' },
    { patternSource: '그\\s?다음\\s?날', kind: 'day-skip' },
    { patternSource: '며칠\\s?후', kind: 'day-skip' },
    { patternSource: '며칠\\s?뒤', kind: 'day-skip' },
    { patternSource: '몇\\s?날\\s?며칠', kind: 'day-skip' },
    { patternSource: '사흘\\s?뒤', kind: 'day-skip' },
    { patternSource: '일주일\\s?후', kind: 'day-skip' },
    { patternSource: '일주일\\s?뒤', kind: 'day-skip' },
    { patternSource: '보름\\s?후', kind: 'day-skip' },
    // === long-skip ===
    { patternSource: '몇\\s?주\\s?후', kind: 'long-skip' },
    { patternSource: '몇\\s?주\\s?뒤', kind: 'long-skip' },
    { patternSource: '한\\s?달\\s?후', kind: 'long-skip' },
    { patternSource: '한\\s?달\\s?뒤', kind: 'long-skip' },
    { patternSource: '몇\\s?달\\s?후', kind: 'long-skip' },
    { patternSource: '몇\\s?달\\s?뒤', kind: 'long-skip' },
    { patternSource: '일\\s?년\\s?후', kind: 'long-skip' },
    { patternSource: '일\\s?년\\s?뒤', kind: 'long-skip' },
    { patternSource: '몇\\s?년\\s?후', kind: 'long-skip' },
    { patternSource: '몇\\s?년\\s?뒤', kind: 'long-skip' },
    { patternSource: '십\\s?년\\s?후', kind: 'long-skip' },
    { patternSource: '십\\s?년\\s?뒤', kind: 'long-skip' },
    { patternSource: '수년\\s?후', kind: 'long-skip' },
    { patternSource: '수년\\s?뒤', kind: 'long-skip' },
    { patternSource: '수십\\s?년\\s?후', kind: 'long-skip' },
    // === scene-cut ===
    { patternSource: '시간이\\s?흘러', kind: 'scene-cut' },
    { patternSource: '시간이\\s?지나', kind: 'scene-cut' },
    { patternSource: '세월이\\s?흘러', kind: 'scene-cut' },
    { patternSource: '세월이\\s?지나', kind: 'scene-cut' },
    { patternSource: '어느\\s?새', kind: 'scene-cut' },
    { patternSource: '어느덧', kind: 'scene-cut' },
    { patternSource: '그렇게\\s?\\S+일이\\s?지났다', kind: 'scene-cut' },
    { patternSource: '그로부터', kind: 'scene-cut' },
    { patternSource: '그\\s?후', kind: 'scene-cut' },
    { patternSource: '훗날', kind: 'scene-cut' },
];
import { skipKoLexical } from './checker-registry.js';
export function detectGapSkip(input) {
    const skipped = skipKoLexical(input, 'detectGapSkip');
    if (skipped)
        return skipped;
    const { prose, chapterNumber } = input;
    if (!prose || prose.trim().length === 0)
        return { violations: [] };
    for (const marker of GAP_SKIP_MARKERS) {
        const re = new RegExp(marker.patternSource, 'g');
        if (re.test(prose))
            return { violations: [] };
    }
    return {
        violations: [
            {
                severity: 'soft',
                code: 'NO_TIME_SKIP',
                chapterNumber,
                message: '시간 도약 marker 0 — chapter 가 한 호흡으로 늘어졌을 가능성',
            },
        ],
    };
}
