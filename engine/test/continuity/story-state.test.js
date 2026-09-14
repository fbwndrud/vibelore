import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { emptyStoryState, reduceStoryState, } from '../../src/continuity/story-state.js';
const emptyDelta = (chapterNumber) => ({
    chapterNumber,
    appearedCharacterIds: [],
    newAddressEntries: [],
    relationshipOps: [],
    hookChanges: [],
    mutableChanges: [],
    trackedEntityOps: [],
});
describe('emptyStoryState', () => {
    it('returns chapter 0 with empty containers', () => {
        const s = emptyStoryState('work-1');
        expect(s.workId).toBe('work-1');
        expect(s.chapterNumber).toBe(0);
        expect(s.addressMap.entries).toEqual({});
        expect(s.relationships).toEqual([]);
        expect(s.hooks).toEqual([]);
        expect(s.trackedEntities).toEqual([]);
    });
});
describe('reduceStoryState', () => {
    it('repairs legacy forward-skipping arc deltas while folding persisted plans', () => {
        const prev = { ...emptyStoryState('w'), chapterNumber: 3, arcCursor: { hero: { beat: 'attempt', enteredAtChapter: 2 } } };
        const delta = emptyDelta(4);
        delta.arcCursorOps = [{ characterId: 'hero', nextBeat: 'companion', note: '기존 sparse plan' }];
        const next = reduceStoryState(prev, delta);
        expect(next.arcCursor.hero.beat).toBe('companion');
        expect(next.arcCursor.hero.enteredAtChapter).toBe(4);
    });
    it('throws chapter-out-of-order when delta.chapterNumber <= prev.chapterNumber', () => {
        const prev = { ...emptyStoryState('w'), chapterNumber: 3 };
        expect(() => reduceStoryState(prev, emptyDelta(3))).toThrow(/chapter-out-of-order: prev=3 expected delta>3/);
        expect(() => reduceStoryState(prev, emptyDelta(2))).toThrow(/chapter-out-of-order: prev=3 expected delta>3/);
    });
    it('advances chapterNumber to delta.chapterNumber', () => {
        const prev = emptyStoryState('w');
        const next = reduceStoryState(prev, emptyDelta(1));
        expect(next.chapterNumber).toBe(1);
        const next2 = reduceStoryState(next, emptyDelta(2));
        expect(next2.chapterNumber).toBe(2);
    });
    it('adds an AddressMap entry keyed as `${speakerId}->${targetId}` with delta chapter as sinceChapter', () => {
        const prev = emptyStoryState('w');
        const delta = emptyDelta(2);
        delta.newAddressEntries = [
            { speakerId: 'maid-a', targetId: 'sample-character', term: '도련님', register: 'subordinate' },
        ];
        const next = reduceStoryState(prev, delta);
        expect(Object.keys(next.addressMap.entries)).toEqual(['maid-a->sample-character']);
        expect(next.addressMap.entries['maid-a->sample-character']).toEqual({
            term: '도련님',
            sinceChapter: 2,
            register: 'subordinate',
        });
    });
    it('AddressMap last-write-wins on the same key (both across deltas and within a single delta)', () => {
        const prev = emptyStoryState('w');
        const d1 = emptyDelta(1);
        d1.newAddressEntries = [
            { speakerId: 's', targetId: 't', term: '하린', register: 'formal' },
        ];
        const s1 = reduceStoryState(prev, d1);
        expect(s1.addressMap.entries['s->t']?.term).toBe('하린');
        const d2 = emptyDelta(2);
        d2.newAddressEntries = [
            { speakerId: 's', targetId: 't', term: '오라버니', register: 'intimate' },
            { speakerId: 's', targetId: 't', term: '주군', register: 'subordinate' },
        ];
        const s2 = reduceStoryState(s1, d2);
        expect(s2.addressMap.entries['s->t']).toEqual({
            term: '주군',
            sinceChapter: 2,
            register: 'subordinate',
        });
    });
    it('relationships: replaces existing (to,kind) pair in place', () => {
        const prev = {
            ...emptyStoryState('w'),
            relationships: [
                { to: 'a', kind: '아버지', state: '소원' },
                { to: 'b', kind: '연인', state: '연애' },
            ],
        };
        const delta = emptyDelta(1);
        delta.relationshipOps = [{ to: 'a', kind: '아버지', state: '화해' }];
        const next = reduceStoryState(prev, delta);
        expect(next.relationships).toEqual([
            { to: 'a', kind: '아버지', state: '화해' },
            { to: 'b', kind: '연인', state: '연애' },
        ]);
    });
    it('relationships: appends when (to,kind) is new', () => {
        const prev = {
            ...emptyStoryState('w'),
            relationships: [{ to: 'a', kind: '아버지', state: '소원' }],
        };
        const delta = emptyDelta(1);
        delta.relationshipOps = [
            { to: 'a', kind: '라이벌', state: '대립' },
            { to: 'c', kind: '주군', state: '충성' },
        ];
        const next = reduceStoryState(prev, delta);
        expect(next.relationships).toEqual([
            { to: 'a', kind: '아버지', state: '소원' },
            { to: 'a', kind: '라이벌', state: '대립' },
            { to: 'c', kind: '주군', state: '충성' },
        ]);
    });
    it('hooks: upserts on id — replace if present, append if new', () => {
        const prev = {
            ...emptyStoryState('w'),
            hooks: [
                {
                    id: 'h1',
                    text: '의문의 편지',
                    plantedAtChapter: 1,
                    phase: 'planted',
                    horizon: 'arc',
                    lastMovedChapter: 1,
                },
            ],
        };
        const delta = emptyDelta(3);
        delta.hookChanges = [
            {
                id: 'h1',
                text: '의문의 편지',
                plantedAtChapter: 1,
                phase: 'advancing',
                horizon: 'arc',
                lastMovedChapter: 3,
            },
            {
                id: 'h2',
                text: '숨겨진 검',
                plantedAtChapter: 3,
                phase: 'planted',
                lastMovedChapter: 3,
            },
        ];
        const next = reduceStoryState(prev, delta);
        expect(next.hooks).toHaveLength(2);
        expect(next.hooks[0]).toMatchObject({ id: 'h1', phase: 'advancing', lastMovedChapter: 3 });
        expect(next.hooks[1]).toMatchObject({ id: 'h2', phase: 'planted' });
    });
    it('trackedEntities: upserts on kind (one snapshot per kind)', () => {
        const prev = {
            ...emptyStoryState('w'),
            trackedEntities: [
                { kind: 'Timeline', data: { now: '회귀전' } },
                { kind: 'PowerSystem', data: { tier: 1 } },
            ],
        };
        const delta = emptyDelta(2);
        delta.trackedEntityOps = [
            { kind: 'Timeline', data: { now: '회귀후', loops: 2 } },
            { kind: 'Artifact', data: { owner: 'sample-character' } },
        ];
        const next = reduceStoryState(prev, delta);
        expect(next.trackedEntities).toHaveLength(3);
        expect(next.trackedEntities[0]).toEqual({ kind: 'Timeline', data: { now: '회귀후', loops: 2 } });
        expect(next.trackedEntities[1]).toEqual({ kind: 'PowerSystem', data: { tier: 1 } });
        expect(next.trackedEntities[2]).toEqual({ kind: 'Artifact', data: { owner: 'sample-character' } });
    });
    it('does not mutate prev (deep equality preserved after reduce)', () => {
        const prev = {
            workId: 'w',
            chapterNumber: 1,
            addressMap: {
                entries: {
                    's->t': { term: '하린', sinceChapter: 1, register: 'formal' },
                },
            },
            relationships: [{ to: 'a', kind: '아버지', state: '소원' }],
            hooks: [
                {
                    id: 'h1',
                    text: '의문의 편지',
                    plantedAtChapter: 1,
                    phase: 'planted',
                    lastMovedChapter: 1,
                },
            ],
            trackedEntities: [{ kind: 'Timeline', data: { now: '회귀전' } }],
        };
        const snapshot = JSON.parse(JSON.stringify(prev));
        const delta = emptyDelta(2);
        delta.newAddressEntries = [
            { speakerId: 's', targetId: 't', term: '주군', register: 'subordinate' },
            { speakerId: 'x', targetId: 'y', term: '아가씨', register: 'formal' },
        ];
        delta.relationshipOps = [
            { to: 'a', kind: '아버지', state: '화해' },
            { to: 'b', kind: '연인', state: '연애' },
        ];
        delta.hookChanges = [
            {
                id: 'h1',
                text: '의문의 편지',
                plantedAtChapter: 1,
                phase: 'paid',
                lastMovedChapter: 2,
            },
        ];
        delta.trackedEntityOps = [{ kind: 'Timeline', data: { now: '회귀후' } }];
        const next = reduceStoryState(prev, delta);
        // prev untouched
        expect(prev).toEqual(snapshot);
        // next is a different object graph
        expect(next).not.toBe(prev);
        expect(next.addressMap).not.toBe(prev.addressMap);
        expect(next.relationships).not.toBe(prev.relationships);
        expect(next.hooks).not.toBe(prev.hooks);
        expect(next.trackedEntities).not.toBe(prev.trackedEntities);
    });
    it('ignores mutableChanges and appearedCharacterIds (not part of StoryState carry-forward)', () => {
        const prev = emptyStoryState('w');
        const delta = emptyDelta(1);
        delta.appearedCharacterIds = ['c1', 'c2'];
        delta.mutableChanges = [
            { characterId: 'c1', location: '본가', status: 'alive', knownFactsAdded: ['아버지 사망'] },
        ];
        const next = reduceStoryState(prev, delta);
        expect(next.chapterNumber).toBe(1);
        expect(next.addressMap.entries).toEqual({});
        expect(next.relationships).toEqual([]);
        expect(next.hooks).toEqual([]);
        expect(next.trackedEntities).toEqual([]);
    });
});
