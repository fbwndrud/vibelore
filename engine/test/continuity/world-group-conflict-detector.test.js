import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { scanWorldGroupConflict } from '../../src/continuity/world-group-conflict-detector.js';
import { createFoundation, } from '../../src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
const registry = createGenreProfileRegistry();
function makeFoundation(args) {
    return createFoundation({
        workId: 'work-wg-1',
        genre: 'comedy',
        genreProfile: registry.get('comedy'),
        ...(args.worldGroup ? { worldGroup: args.worldGroup } : {}),
    });
}
function makeWorldFact(id, statement, chapter) {
    return { id, statement, registeredAtChapter: chapter };
}
describe('scanWorldGroupConflict', () => {
    it('returns no violations when foundation.worldGroup is undefined', () => {
        const f = makeFoundation({});
        const r = scanWorldGroupConflict({
            prose: '용호왕국 왕자가 등장했다.',
            chapterNumber: 2,
            foundation: f,
        });
        expect(r.violations).toEqual([]);
    });
    it('returns no violations when sharedWorldFacts is empty', () => {
        const f = makeFoundation({
            worldGroup: {
                worldGroupId: 'wg-1',
                name: '용호 epic',
                sharedWorldFacts: [],
            },
        });
        const r = scanWorldGroupConflict({
            prose: '본문 본문 본문',
            chapterNumber: 2,
            foundation: f,
        });
        expect(r.violations).toEqual([]);
    });
    it('flags WORLD_GROUP_CONFLICT as SOFT when shared fact phrase appears with negation marker', () => {
        const f = makeFoundation({
            worldGroup: {
                worldGroupId: 'wg-1',
                name: '용호 epic',
                sharedWorldFacts: [
                    makeWorldFact('wg-fact-1', '용호왕국은 강대국이다.', 1),
                ],
            },
        });
        const prose = '사실 용호왕국 강대국은 존재하지 않는다고 그는 말했다.';
        const r = scanWorldGroupConflict({ prose, chapterNumber: 4, foundation: f });
        expect(r.violations.some((v) => v.code === 'WORLD_GROUP_CONFLICT')).toBe(true);
        expect(r.violations.every((v) => v.severity === 'soft')).toBe(true);
    });
    it('does not flag shared fact phrase appearing alone (no negation)', () => {
        const f = makeFoundation({
            worldGroup: {
                worldGroupId: 'wg-1',
                name: '용호 epic',
                sharedWorldFacts: [
                    makeWorldFact('wg-fact-1', '용호왕국은 강대국이다.', 1),
                ],
            },
        });
        const prose = '용호왕국 거리에 봄이 왔다. 강대국 답게 위엄이 흘렀다.';
        const r = scanWorldGroupConflict({ prose, chapterNumber: 4, foundation: f });
        expect(r.violations).toEqual([]);
    });
    it('emits only soft severity violations', () => {
        const f = makeFoundation({
            worldGroup: {
                worldGroupId: 'wg-2',
                name: '카르난 epic',
                sharedWorldFacts: [
                    makeWorldFact('wg-fact-a', '대마왕 카르난이 부활했다.', 1),
                    makeWorldFact('wg-fact-b', '흑야회 비밀결사가 활동한다.', 1),
                ],
            },
        });
        const prose = '카르난 대마왕 부활은 거짓이었다. 흑야회 비밀결사 활동은 존재하지 않는다.';
        const r = scanWorldGroupConflict({ prose, chapterNumber: 5, foundation: f });
        expect(r.violations.length).toBeGreaterThan(0);
        expect(r.violations.every((v) => v.severity === 'soft')).toBe(true);
        expect(r.violations.every((v) => v.code === 'WORLD_GROUP_CONFLICT')).toBe(true);
    });
    it('dedups phrase reports on repeated negated occurrences', () => {
        const f = makeFoundation({
            worldGroup: {
                worldGroupId: 'wg-3',
                name: '신령왕검 epic',
                sharedWorldFacts: [
                    makeWorldFact('wg-fact-1', '신령왕검 봉인이 유지된다.', 1),
                ],
            },
        });
        const prose = '신령왕검 봉인은 거짓이다. 신령왕검 봉인은 존재하지 않는다. 신령왕검 봉인은 없다.';
        const r = scanWorldGroupConflict({ prose, chapterNumber: 6, foundation: f });
        const messages = new Set(r.violations.map((v) => v.message));
        expect(messages.size).toBe(r.violations.length);
    });
});
