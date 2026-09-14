import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { scanInfoRestate } from '../../src/continuity/info-restate-detector.js';
import { createFoundation, } from '../../src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
const registry = createGenreProfileRegistry();
function makeFoundation(statements) {
    const base = createFoundation({
        workId: 'work-1',
        genre: 'comedy',
        genreProfile: registry.get('comedy'),
    });
    const worldFacts = statements.map((statement, i) => ({
        id: `wf-${i}`,
        statement,
        registeredAtChapter: 1,
    }));
    return { ...base, worldFacts };
}
describe('scanInfoRestate', () => {
    it('returns no violations for empty prose', () => {
        const f = makeFoundation(['세계 배경 설명']);
        expect(scanInfoRestate({ prose: '', chapterNumber: 2, foundation: f }).violations).toEqual([]);
    });
    it('returns no violations when no worldFacts', () => {
        const f = makeFoundation([]);
        expect(scanInfoRestate({ prose: '본문 본문 본문', chapterNumber: 2, foundation: f })
            .violations).toEqual([]);
    });
    it('flags INFO_RESTATED when phrase repeated ≥ 3', () => {
        const f = makeFoundation(['용호왕국은 천년 역사를 가진 강대국이다.']);
        const prose = '용호왕국은 평화로웠다. 용호왕국 전역에 봄이 왔다. 그날도 용호왕국 거리에는 사람들이 가득했다.';
        const r = scanInfoRestate({ prose, chapterNumber: 2, foundation: f });
        expect(r.violations.some((v) => v.code === 'INFO_RESTATED')).toBe(true);
        expect(r.violations.every((v) => v.severity === 'soft')).toBe(true);
    });
    it('does not flag at 2 occurrences', () => {
        const f = makeFoundation(['용호왕국은 강대국이다.']);
        const prose = '용호왕국. 그리고 다시 용호왕국.';
        const r = scanInfoRestate({ prose, chapterNumber: 2, foundation: f });
        expect(r.violations.every((v) => v.code !== 'INFO_RESTATED')).toBe(true);
    });
    it('dedups phrase reports', () => {
        const f = makeFoundation(['용호왕국 용호왕국 용호왕국 강대국이다.']);
        const prose = '용호왕국 용호왕국 용호왕국 용호왕국 용호왕국';
        const r = scanInfoRestate({ prose, chapterNumber: 2, foundation: f });
        const phrases = new Set(r.violations.map((v) => v.message));
        expect(phrases.size).toBe(r.violations.length);
    });
});
