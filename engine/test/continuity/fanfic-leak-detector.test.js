import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { scanFanficLeak } from '../../src/continuity/fanfic-leak-detector.js';
import { createFoundation, } from '../../src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
const registry = createGenreProfileRegistry();
function makeFoundation(args) {
    return createFoundation({
        workId: 'work-fanfic-1',
        genre: 'comedy',
        genreProfile: registry.get('comedy'),
        ...(args.fanficSource ? { fanficSource: args.fanficSource } : {}),
    });
}
function makeWorldFact(id, statement, chapter) {
    return { id, statement, registeredAtChapter: chapter };
}
describe('scanFanficLeak', () => {
    it('returns no violations when fanficSource is undefined', () => {
        const f = makeFoundation({});
        const r = scanFanficLeak({
            prose: '용호왕국 왕자가 등장했다.',
            chapterNumber: 2,
            foundation: f,
        });
        expect(r.violations).toEqual([]);
    });
    it('returns no violations when canonicalWorldFacts is empty', () => {
        const f = makeFoundation({
            fanficSource: {
                canonicalWorkId: 'canonical-1',
                branchAtChapter: 3,
                canonicalWorldFacts: [],
            },
        });
        const r = scanFanficLeak({
            prose: '본문 본문 본문',
            chapterNumber: 2,
            foundation: f,
        });
        expect(r.violations).toEqual([]);
    });
    it('flags FANFIC_FUTURE_LEAK as SOFT when future-fact phrase appears in prose', () => {
        const f = makeFoundation({
            fanficSource: {
                canonicalWorkId: 'canonical-1',
                branchAtChapter: 3,
                canonicalWorldFacts: [
                    makeWorldFact('wf-future-1', '신령왕검이 봉인에서 풀려났다.', 7),
                ],
            },
        });
        const prose = '주인공은 우연히 신령왕검을 손에 넣었다.';
        const r = scanFanficLeak({ prose, chapterNumber: 2, foundation: f });
        expect(r.violations.some((v) => v.code === 'FANFIC_FUTURE_LEAK')).toBe(true);
        expect(r.violations.every((v) => v.severity === 'soft')).toBe(true);
    });
    it('does not flag canonical past facts (registeredAtChapter <= branchAtChapter)', () => {
        const f = makeFoundation({
            fanficSource: {
                canonicalWorkId: 'canonical-1',
                branchAtChapter: 5,
                canonicalWorldFacts: [
                    makeWorldFact('wf-past-1', '용호왕국은 강대국이다.', 1),
                    makeWorldFact('wf-past-2', '주인공은 천재 검사이다.', 5),
                ],
            },
        });
        const prose = '용호왕국 거리에 봄이 왔다. 주인공은 천재 검사답게 검을 휘둘렀다.';
        const r = scanFanficLeak({ prose, chapterNumber: 2, foundation: f });
        expect(r.violations).toEqual([]);
    });
    it('emits only soft severity violations', () => {
        const f = makeFoundation({
            fanficSource: {
                canonicalWorkId: 'canonical-1',
                branchAtChapter: 2,
                canonicalWorldFacts: [
                    makeWorldFact('wf-future-a', '비밀결사 흑야회가 등장했다.', 8),
                    makeWorldFact('wf-future-b', '대마왕 카르난이 부활했다.', 10),
                ],
            },
        });
        const prose = '흑야회 비밀결사가 도시에 잠입했다. 카르난 대마왕의 그림자가 드리웠다.';
        const r = scanFanficLeak({ prose, chapterNumber: 3, foundation: f });
        expect(r.violations.length).toBeGreaterThan(0);
        expect(r.violations.every((v) => v.severity === 'soft')).toBe(true);
        expect(r.violations.every((v) => v.code === 'FANFIC_FUTURE_LEAK')).toBe(true);
    });
    it('dedups phrase reports', () => {
        const f = makeFoundation({
            fanficSource: {
                canonicalWorkId: 'canonical-1',
                branchAtChapter: 2,
                canonicalWorldFacts: [
                    makeWorldFact('wf-future-1', '신령왕검 신령왕검 봉인 해제', 7),
                ],
            },
        });
        const prose = '신령왕검 신령왕검 신령왕검';
        const r = scanFanficLeak({ prose, chapterNumber: 3, foundation: f });
        const phrases = new Set(r.violations.map((v) => v.message));
        expect(phrases.size).toBe(r.violations.length);
    });
});
