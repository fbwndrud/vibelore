import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { emptyStoryState, reduceStoryState, } from '../../src/continuity/story-state.js';
import { ledgerStep, legacyLedgerOps, normalizeStoryState, isHookActive, isLegacyLedger } from '../../src/continuity/story-state.js';
import { advanceCursor } from '../../src/continuity/character-arc.js';
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
    // 2026-09-28 ko sample: an approved second arc opened a personal arc for a third
    // character while two earlier arcs were still active. The arc cursor is an
    // advisory observation, so the over-quota start is left out instead of
    // failing the chapter commit; the other ops of the delta still apply.
    it('leaves out an arc start over the active quota and keeps the rest of the delta', () => {
        const prev = { ...emptyStoryState('w'), chapterNumber: 9, arcCursor: {
            hero: { beat: 'attempt', enteredAtChapter: 2 }, ally: { beat: 'attempt', enteredAtChapter: 3 } } };
        const delta = emptyDelta(10);
        delta.arcCursorOps = [
            { characterId: 'rival', nextBeat: 'wound', note: 'a third arc opens' },
            { characterId: 'hero', nextBeat: 'collapse', note: 'hero falls' },
        ];
        const next = reduceStoryState(prev, delta);
        expect(next.arcCursor.rival).toBe(undefined);
        expect(next.arcCursor.hero.beat).toBe('collapse');
        expect(next.chapterNumber).toBe(10);
    });
    // Chapter 11 of the same sample: the plan's next beat for the arc that never
    // started. With the quota still full it is left out the same way.
    it('leaves out later beats of an arc whose start was left out over the quota', () => {
        const prev = { ...emptyStoryState('w'), chapterNumber: 10, arcCursor: {
            hero: { beat: 'attempt', enteredAtChapter: 2 }, ally: { beat: 'attempt', enteredAtChapter: 3 } } };
        const delta = emptyDelta(11);
        delta.arcCursorOps = [{ characterId: 'rival', nextBeat: 'attempt' }];
        expect(reduceStoryState(prev, delta).arcCursor.rival).toBe(undefined);
        const open = { ...prev, arcCursor: { hero: prev.arcCursor.hero } };
        expect(() => reduceStoryState(open, delta)).toThrow(/first beat must be 'wound'/);
    });
    it('leaves out a beat the cursor has already passed but still rejects skipping ahead', () => {
        const prev = { ...emptyStoryState('w'), chapterNumber: 3, arcCursor: { hero: { beat: 'collapse', enteredAtChapter: 2 } } };
        const delta = emptyDelta(4);
        delta.arcCursorOps = [{ characterId: 'hero', nextBeat: 'wound' }];
        expect(reduceStoryState(prev, delta).arcCursor.hero).toEqual({ beat: 'collapse', enteredAtChapter: 2 });
        expect(() => advanceCursor(prev.arcCursor, { characterId: 'hero', nextBeat: 'wound', chapterNumber: 4 })).toThrow(/cannot regress/);
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
    it('hooks: a legacy change moves a known hook and plants a new one under its id', () => {
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
        expect(next.hooks[0]).toMatchObject({ id: 'h1', status: 'open', lastMovedChapter: 3 });
        expect(next.hooks[0].recent.map((e) => e.event)).toEqual(['advanced']);
        expect(next.hooks[0]).not.toHaveProperty('phase');
        expect(next.hooks[1]).toMatchObject({ id: 'h2', status: 'open', plantedAtChapter: 3 });
    });
    it('legacy tracked entities: named records become ledger records, unnamed snapshots are dropped', () => {
        const prev = {
            ...emptyStoryState('w'),
            ledger: undefined,
            trackedEntities: [
                { kind: 'Timeline', data: { now: '회귀전' } },
                { kind: 'Artifact', data: { name: '검', holder: 'c1' }, updatedChapter: 1 },
            ],
        };
        const delta = emptyDelta(2);
        delta.trackedEntityOps = [
            { kind: 'Timeline', data: { now: '회귀후', loops: 2 } },
            { kind: 'Artifact', data: { name: '검', holder: 'c2' } },
            { kind: 'PowerSystem', data: { ability: '불꽃', tier: 2 } },
        ];
        const next = reduceStoryState(prev, delta);
        expect(next.trackedEntities).toEqual([]);
        expect(next.ledger.records.map((r) => [r.id, r.label, r.name, r.fields, r.lastEventAt])).toEqual([
            ['o1', 'Artifact', '검', { holder: 'c2' }, 2],
        ]);
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
            trackedEntities: [],
            ledger: { records: [{ id: 'o1', feature: 'objects', label: '물건', name: '서명 쪽지', aliases: [], status: 'active', fields: { holder: 'c1' }, registeredAt: 1, recent: [] }] },
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
        delta.ledgerOps = [{ op: 'event', id: 'o1', event: 'changed', set: { holder: 'c2' } }];
        const next = reduceStoryState(prev, delta);
        // prev untouched
        expect(prev).toEqual(snapshot);
        // next is a different object graph
        expect(next).not.toBe(prev);
        expect(next.addressMap).not.toBe(prev.addressMap);
        expect(next.relationships).not.toBe(prev.relationships);
        expect(next.hooks).not.toBe(prev.hooks);
        expect(next.hooks[0].status).toBe('paid');
        expect(next.hooks[0]).not.toBe(prev.hooks[0]);
        expect(next.ledger).not.toBe(prev.ledger);
    });
    it('folds mutableChanges into characterStates and ignores appearedCharacterIds', () => {
        const prev = emptyStoryState('w');
        const delta = emptyDelta(1);
        delta.appearedCharacterIds = ['c1', 'c2'];
        delta.mutableChanges = [
            { characterId: 'c1', location: '본가', status: '아버지를 잃고 흔들림', vitalStatus: 'alive', knownFactsAdded: ['아버지 사망'] },
        ];
        const next = reduceStoryState(prev, delta);
        expect(next.chapterNumber).toBe(1);
        expect(next.addressMap.entries).toEqual({});
        expect(next.relationships).toEqual([]);
        expect(next.hooks).toEqual([]);
        expect(next.trackedEntities).toEqual([]);
        expect(next.characterStates).toEqual({
            c1: { vitalStatus: 'alive', location: '본가', status: '아버지를 잃고 흔들림', knownFacts: ['아버지 사망'], sinceChapter: 1 },
        });
    });
    it('characterStates: carries a death forward and accumulates known facts', () => {
        const first = emptyDelta(1);
        first.mutableChanges = [{ characterId: 'c1', knownFactsAdded: ['열쇠 위치'] }];
        const second = emptyDelta(2);
        second.mutableChanges = [{ characterId: 'c1', vitalStatus: 'dead', knownFactsAdded: ['배신자 이름', '열쇠 위치'] }];
        const next = reduceStoryState(reduceStoryState(emptyStoryState('w'), first), second);
        expect(next.characterStates.c1.vitalStatus).toBe('dead');
        expect(next.characterStates.c1.sinceChapter).toBe(2);
        expect(next.characterStates.c1.knownFacts).toEqual(['열쇠 위치', '배신자 이름']);
        const third = reduceStoryState(next, emptyDelta(3));
        expect(third.characterStates.c1.vitalStatus).toBe('dead');
    });
    it('omits characterStates while no character state has been recorded', () => {
        const next = reduceStoryState(emptyStoryState('w'), emptyDelta(1));
        expect('characterStates' in next).toBe(false);
    });
    it('relationships: keeps A->C and B->C apart by their from side', () => {
        const delta = emptyDelta(1);
        delta.relationshipOps = [
            { from: 'a', to: 'c', kind: '신뢰', state: '믿음' },
            { from: 'b', to: 'c', kind: '신뢰', state: '의심' },
        ];
        const once = reduceStoryState(emptyStoryState('w'), delta);
        const update = emptyDelta(2);
        update.relationshipOps = [{ from: 'b', to: 'c', kind: '신뢰', state: '화해' }];
        const next = reduceStoryState(once, update);
        expect(next.relationships).toEqual([
            { from: 'a', to: 'c', kind: '신뢰', state: '믿음' },
            { from: 'b', to: 'c', kind: '신뢰', state: '화해' },
        ]);
    });
    it('legacy tracked entities: one knowledge record per fact, timelines as chapter notes', () => {
        const first = emptyDelta(1);
        first.trackedEntityOps = [
            { kind: 'KnowledgeMatrix', data: { fact: '리아의 손목 부상', holders: ['c2'] } },
            { kind: 'Timeline', data: { chapter: 1, event: '다리가 무너졌다' } },
        ];
        const second = emptyDelta(2);
        second.trackedEntityOps = [
            { kind: 'KnowledgeMatrix', data: { fact: '표식의 주인', holders: ['c1'] } },
            { kind: 'KnowledgeMatrix', data: { fact: '리아의 손목 부상', holders: ['c2', 'c4'] } },
            { kind: 'Timeline', data: { chapter: 2, event: '막힌 통로를 찾았다' } },
        ];
        const once = reduceStoryState(emptyStoryState('w'), first);
        const next = reduceStoryState(once, second);
        expect(next.trackedEntities).toEqual([]);
        expect(next.ledger.records.map((r) => [r.id, r.feature, r.name, r.fields.holders])).toEqual([
            ['k1', 'knowledge', '리아의 손목 부상', ['c2', 'c4']],
            ['k2', 'knowledge', '표식의 주인', ['c1']],
        ]);
        const notes = ledgerStep(once, second).events.filter((e) => e.target === 'chapter');
        expect(notes).toEqual([{ chapter: 2, target: 'chapter', event: 'note', note: '막힌 통로를 찾았다' }]);
    });
});
describe('ledger in StoryState', () => {
    it('folds ledger ops and merges from the config', () => {
        const prev = { ...emptyStoryState('w'), chapterNumber: 1 };
        const delta = { ...emptyDelta(2), ledgerOps: [
            { op: 'register', feature: 'objects', label: '물건', name: '서명 쪽지' },
            { op: 'register', feature: 'objects', label: '물건', name: '재서명된 쪽지' },
            { op: 'plant', text: '누가 사슬을 박았나' },
        ] };
        const next = reduceStoryState(prev, delta, { config: { merges: [{ from: 'o2', into: 'o1' }] } });
        expect(next.ledger.records.map((r) => r.id)).toEqual(['o1']);
        expect(next.hooks.map((h) => [h.id, h.status])).toEqual([['h1', 'open']]);
        expect(next.trackedEntities).toEqual([]);
    });
    it('converts legacy hook changes and tracked entity ops into ledger ops', () => {
        const prev = { ...emptyStoryState('w'), chapterNumber: 4, hooks: [{ id: 'wrist', text: '손목', phase: 'planted', plantedAtChapter: 2 }] };
        const delta = { ...emptyDelta(5),
            hookChanges: [{ id: 'wrist', text: '손목', phase: 'advancing', plantedAtChapter: 2, lastMovedChapter: 5 }, { id: 'chain', text: '사슬', phase: 'planted' }],
            trackedEntityOps: [{ kind: 'Artifact', data: { name: '서명 쪽지', holder: 'c2' } }, { kind: 'Timeline', data: { chapter: 5, events: ['수레가 멈춤'] } }] };
        expect(legacyLedgerOps(normalizeStoryState(prev), delta)).toEqual([
            { op: 'hook', id: 'wrist', event: 'advanced' },
            { op: 'plant', text: '사슬', id: 'chain' },
            { op: 'register', feature: 'objects', label: 'Artifact', name: '서명 쪽지', fields: { holder: 'c2' } },
            { op: 'chapter-note', note: '수레가 멈춤' },
        ]);
        const next = reduceStoryState(prev, delta);
        expect(next.hooks.map((h) => [h.id, h.status])).toEqual([['wrist', 'open'], ['chain', 'open']]);
        expect(next.ledger.records.map((r) => r.name)).toEqual(['서명 쪽지']);
    });
    it('reads a legacy state: hooks by status, tracked entities as records', () => {
        const state = normalizeStoryState({ ...emptyStoryState('w'), ledger: undefined, hooks: [{ id: 'a', text: 'x', phase: 'parked' }], trackedEntities: [{ kind: 'Clue', data: { name: '표식' } }] },
            { entities: [{ entityId: 'seed-1', kind: 'location', canonicalName: '다리', aliases: [], status: 'active', attrs: {} }] });
        expect(state.hooks[0].status).toBe('dormant');
        expect(isHookActive(state.hooks[0])).toBe(false);
        expect(state.ledger.records.map((r) => r.id)).toEqual(['seed-1', 'o1']);
    });
    it('skips legacy RelationshipState and PowerSystem entries: relationships and rules are tracked elsewhere', () => {
        const delta = { ...emptyDelta(3), trackedEntityOps: [
            { kind: 'RelationshipState', data: { from: 'c1', to: 'c2', stance: '경계' } },
            { kind: 'PowerSystem', data: { name: '청록빛 방패', cost: '체력' } },
            { kind: 'Clue', data: { name: '표식' } }] };
        expect(legacyLedgerOps(emptyStoryState('w'), delta)).toEqual([{ op: 'register', feature: 'objects', label: 'Clue', name: '표식' }]);
        const state = normalizeStoryState({ ...emptyStoryState('w'), ledger: undefined, trackedEntities: delta.trackedEntityOps });
        expect(state.ledger.records.map((r) => r.name)).toEqual(['표식']);
    });
    it('marks a ledger converted from a state written before the ledger, and only that one', () => {
        const legacy = normalizeStoryState({ ...emptyStoryState('w'), ledger: undefined, trackedEntities: [] });
        expect(isLegacyLedger(legacy.ledger)).toBe(true);
        expect(isLegacyLedger(normalizeStoryState(legacy).ledger)).toBe(true);
        expect(isLegacyLedger(normalizeStoryState(emptyStoryState('w')).ledger)).toBe(false);
        expect(isLegacyLedger(ledgerStep(legacy, emptyDelta(1)).ledger)).toBe(false);
        expect(JSON.stringify(legacy.ledger)).toBe('{"records":[]}');
    });
    it('exposes the ledger step with its history lines', () => {
        const prev = { ...emptyStoryState('w'), chapterNumber: 1 };
        const step = ledgerStep(prev, { ...emptyDelta(2), ledgerOps: [{ op: 'plant', text: '사슬' }] });
        expect(step.events.map((e) => [e.target, e.event])).toEqual([['hook', 'planted']]);
        expect(step.violations).toEqual([]);
    });
});
describe('replaying old deltas', () => {
    it('keeps a legacy entity id so later updates and retirements land on it', () => {
        const first = { ...emptyDelta(1), entityOps: [{ op: 'register', entityId: 'e7', kind: 'item', name: '청동 열쇠' }] };
        const second = { ...emptyDelta(2), entityOps: [{ op: 'update', entityId: 'e7', fields: { holder: 'c2' } }] };
        const third = { ...emptyDelta(3), entityOps: [{ op: 'retire', entityId: 'e7', cause: 'destroyed' }] };
        const once = reduceStoryState(emptyStoryState('w'), first);
        const twice = reduceStoryState(once, second);
        expect(ledgerStep(twice, third).violations).toEqual([]);
        const next = reduceStoryState(twice, third);
        expect(next.ledger.records.map((r) => [r.id, r.name, r.fields.holder, r.status])).toEqual([['e7', '청동 열쇠', 'c2', 'destroyed']]);
    });
    it('keeps the phase and planting chapter of a hook first seen as paid', () => {
        const delta = { ...emptyDelta(5), hookChanges: [{ id: 'oath', text: '맹세', phase: 'paid', plantedAtChapter: 2 }] };
        expect(legacyLedgerOps(emptyStoryState('w'), delta)).toEqual([
            { op: 'plant', text: '맹세', id: 'oath', plantedAtChapter: 2 },
            { op: 'hook', id: 'oath', event: 'paid' },
        ]);
        const next = reduceStoryState({ ...emptyStoryState('w'), chapterNumber: 4 }, delta);
        expect(next.hooks[0]).toMatchObject({ id: 'oath', status: 'paid', plantedAtChapter: 2 });
    });
    it('carries a rewording and a new horizon of a known hook', () => {
        const prev = { ...emptyStoryState('w'), chapterNumber: 4, hooks: [{ id: 'wrist', text: '손목', phase: 'planted', horizon: 'long', plantedAtChapter: 2 }] };
        const delta = { ...emptyDelta(5), hookChanges: [{ id: 'wrist', text: '손목의 흉터', phase: 'advancing', horizon: 'next' }] };
        expect(legacyLedgerOps(normalizeStoryState(prev), delta)).toEqual([{ op: 'hook', id: 'wrist', event: 'advanced', text: '손목의 흉터', horizon: 'next' }]);
        expect(reduceStoryState(prev, delta).hooks[0]).toMatchObject({ text: '손목의 흉터', horizon: 'next', status: 'open' });
    });
    it('does not repeat the name field in the fields', () => {
        const delta = { ...emptyDelta(1), trackedEntityOps: [{ kind: 'KnowledgeMatrix', data: { fact: '리아의 손목 부상', holders: ['c2'] } }] };
        expect(legacyLedgerOps(emptyStoryState('w'), delta)).toEqual([
            { op: 'register', feature: 'knowledge', label: 'KnowledgeMatrix', name: '리아의 손목 부상', fields: { holders: ['c2'] } },
        ]);
    });
});
describe('config in effect per chapter', () => {
    it('applies a merge at the chapter it was approved for, so a later change of the merged record wins by recency', () => {
        const config = { merges: [{ from: 'o2', into: 'o1', atChapter: 3 }] };
        let state = { ...emptyStoryState('w') };
        state = reduceStoryState(state, { ...emptyDelta(1), ledgerOps: [{ op: 'register', feature: 'objects', label: '물건', name: '낡은 검', fields: { holder: 'c1' } }] }, { config });
        state = reduceStoryState(state, { ...emptyDelta(2), ledgerOps: [{ op: 'register', feature: 'objects', label: '물건', name: '녹슨 검', fields: { holder: 'c1' } }] }, { config });
        expect(state.ledger.records.map((r) => r.id)).toEqual(['o1', 'o2']);
        const step = ledgerStep(state, { ...emptyDelta(3), ledgerOps: [{ op: 'event', id: 'o2', event: 'changed', set: { holder: 'c3' } }] }, { config });
        expect(step.ledger.records.map((r) => [r.id, r.fields.holder])).toEqual([['o1', 'c3']]);
        expect(step.events.map((e) => [e.id, e.event])).toEqual([['o2', 'merged'], ['o1', 'changed']]);
    });
    it('keeps the ops of a feature turned off later, and drops them from the chapter it was turned off', () => {
        const config = { tracking: { hooks: false }, history: [{ atChapter: 1, tracking: {}, customTracking: [] }, { atChapter: 3, tracking: { hooks: false }, customTracking: [] }] };
        const early = ledgerStep(emptyStoryState('w'), { ...emptyDelta(1), ledgerOps: [{ op: 'plant', text: '손목' }] }, { config });
        expect(early.hooks.map((h) => h.id)).toEqual(['h1']);
        const late = ledgerStep({ ...emptyStoryState('w'), chapterNumber: 2, hooks: early.hooks }, { ...emptyDelta(3), ledgerOps: [{ op: 'hook', id: 'h1', event: 'advanced' }] }, { config });
        expect(late.events).toEqual([]);
        expect(late.hooks.map((h) => [h.id, h.status])).toEqual([['h1', 'open']]);
    });
    it('reads a legacy hook change by its current status, not a stale phase', () => {
        const prev = normalizeStoryState({ ...emptyStoryState('w'), chapterNumber: 4, hooks: [{ id: 'oath', text: '맹세', status: 'open', plantedAtChapter: 2 }] });
        const delta = { ...emptyDelta(5), hookChanges: [{ id: 'oath', text: '맹세', status: 'paid', phase: 'advancing' }] };
        expect(legacyLedgerOps(prev, delta)).toEqual([{ op: 'hook', id: 'oath', event: 'paid' }]);
        expect(reduceStoryState(prev, delta).hooks[0].status).toBe('paid');
    });
});
