import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { emptyLedger, findRecord, hookStatusOf, ledgerFromLegacy, ledgerNameKey, nextLedgerId, similarRecord } from '../../src/continuity/ledger.js';
import { applyLedgerOps, applyMerges } from '../../src/continuity/ledger.js';
import { reviewLedgerOps } from '../../src/continuity/ledger.js';

const note = { id: 'o1', feature: 'objects', label: '물건', name: '서명 쪽지', aliases: [{ text: '그 쪽지' }], status: 'active', fields: {}, recent: [] };

describe('ledger lookup', () => {
    it('normalizes names: case, quotes and spaces, but keeps a trailing particle', () => {
        expect(ledgerNameKey('「서명 쪽지」를')).toBe('서명 쪽지를');
        expect(ledgerNameKey('  Silver  Key ')).toBe('silver key');
    });
    it('finds a record by id, merged id, name or alias', () => {
        const ledger = { records: [{ ...note, mergedIds: ['o9'] }] };
        expect(findRecord(ledger, 'o1')?.id).toBe('o1');
        expect(findRecord(ledger, 'o9')?.id).toBe('o1');
        expect(findRecord(ledger, '서명 쪽지')?.id).toBe('o1');
        expect(findRecord(ledger, '그 쪽지')?.id).toBe('o1');
        expect(findRecord(ledger, '그 쪽지', 'knowledge')).toBe(null);
    });
    it('never equates a name and its stem via an exact lookup', () => {
        const pairs = [['독사과', '독사'], ['공작가', '공작'], ['백작가', '백작'], ['고지도', '고지'], ['목걸이', '목걸']];
        for (const [full, stem] of pairs) {
            const ledger = { records: [{ id: 'o1', feature: 'objects', label: '', name: full, aliases: [], status: 'active', fields: {}, recent: [] }] };
            expect(findRecord(ledger, stem, 'objects')).toBe(null);
        }
    });
    it('reports a similar record without treating it as the same', () => {
        const ledger = { records: [note] };
        expect(similarRecord(ledger, 'objects', '재서명된 쪽지')?.id).toBe('o1');
        expect(similarRecord(ledger, 'objects', '은빛 열쇠')).toBe(null);
    });
    it('treats a name that only differs by a trailing particle as a similar candidate', () => {
        const ledger = { records: [note] };
        expect(similarRecord(ledger, 'objects', '서명 쪽지는')?.id).toBe('o1');
    });
    it('assigns the next id per feature prefix', () => {
        expect(nextLedgerId({ ledger: { records: [note, { ...note, id: 'o7' }] }, hooks: [] }, 'objects')).toBe('o8');
        expect(nextLedgerId({ ledger: emptyLedger(), hooks: [{ id: 'h2' }, { id: 'legacy-hook' }] }, 'hooks')).toBe('h3');
    });
});

describe('legacy conversion', () => {
    it('maps legacy hook phases and statuses to the four statuses', () => {
        expect(hookStatusOf({ phase: 'planted' })).toBe('open');
        expect(hookStatusOf({ phase: 'advancing' })).toBe('open');
        expect(hookStatusOf({ phase: 'parked' })).toBe('dormant');
        expect(hookStatusOf({ phase: 'paid' })).toBe('paid');
        expect(hookStatusOf({ status: 'resolved' })).toBe('paid');
        expect(hookStatusOf({ status: 'closed' })).toBe('closed');
    });
    it('lets a current status win over a stale legacy phase', () => {
        expect(hookStatusOf({ status: 'paid', phase: 'advancing' })).toBe('paid');
        expect(hookStatusOf({ status: 'open', phase: 'paid' })).toBe('open');
    });
    it('turns tracked entities and entity snapshots into records, dropping Timeline logs', () => {
        const ledger = ledgerFromLegacy({
            trackedEntities: [
                { kind: 'Artifact', data: { name: '서명 쪽지', holder: 'c2' }, updatedChapter: 5 },
                { kind: 'KnowledgeMatrix', data: { fact: '리아 손목 부상', knownBy: ['c1'] }, updatedChapter: 4 },
                { kind: 'Timeline', data: { chapter: 5, events: ['…'] }, updatedChapter: 5 },
            ],
            entities: [{ entityId: 'seed-1', kind: 'location', canonicalName: '계곡 다리', aliases: ['다리'], status: 'active', attrs: { tier: '길목' } },
                { entityId: 'seed-2', kind: 'item', canonicalName: '서명 쪽지', aliases: [], status: 'destroyed', attrs: {} }],
        });
        expect(ledger.records.map((r) => [r.id, r.feature, r.name, r.status])).toEqual([
            ['seed-1', 'objects', '계곡 다리', 'active'],
            ['seed-2', 'objects', '서명 쪽지', 'destroyed'],
            ['k1', 'knowledge', '리아 손목 부상', 'secret'],
        ]);
        expect(ledger.records[1].fields).toEqual({ holder: 'c2' });
        expect(ledger.records[0].aliases).toEqual([{ text: '다리' }]);
    });
});

const base = () => ({ ledger: { records: [
    { id: 'o1', feature: 'objects', label: '물건', name: '서명 쪽지', aliases: [], status: 'active', fields: { holder: 'c1' }, registeredAt: 4, lastEventAt: 4, recent: [] },
    { id: 'o2', feature: 'objects', label: '물건', name: '낡은 검', aliases: [], status: 'destroyed', fields: {}, registeredAt: 2, lastEventAt: 6, recent: [] },
] }, hooks: [{ id: 'h1', text: '손목의 비밀', status: 'paid', plantedAtChapter: 2, lastMovedChapter: 5, recent: [] }] });

describe('applyLedgerOps', () => {
    it('adds a changed event and keeps the last three events', () => {
        let state = base();
        for (let chapter = 5; chapter <= 8; chapter += 1) {
            state = { ...state, ...applyLedgerOps(state, [{ op: 'event', id: 'o1', event: 'changed', set: { holder: `c${chapter}` }, note: `${chapter}화` }], { chapter }) };
        }
        const record = state.ledger.records[0];
        expect(record.fields.holder).toBe('c8');
        expect(record.recent.map((e) => e.chapter)).toEqual([6, 7, 8]);
        expect(record.lastEventAt).toBe(8);
    });
    it('turns a register with an existing exact name into an event on that record', () => {
        const out = applyLedgerOps(base(), [{ op: 'register', feature: 'objects', label: '물건', name: '서명 쪽지', fields: { state: '재서명' } }], { chapter: 7 });
        expect(out.ledger.records).toHaveLength(2);
        expect(out.events).toEqual([{ chapter: 7, target: 'record', id: 'o1', event: 'changed', set: { state: '재서명' } }]);
    });
    it('registers a name that only differs by a trailing particle as a new possible duplicate', () => {
        const out = applyLedgerOps(base(), [{ op: 'register', feature: 'objects', label: '물건', name: '서명 쪽지를', fields: { state: '재서명' } }], { chapter: 7 });
        expect(out.ledger.records).toHaveLength(3);
        const added = out.ledger.records.at(-1);
        expect(added.possibleDuplicateOf).toBe('o1');
        expect(out.violations.map((v) => v.code)).toEqual(['LEDGER_POSSIBLE_DUPLICATE']);
    });
    it('registers a similar name but marks it as a possible duplicate', () => {
        const out = applyLedgerOps(base(), [{ op: 'register', feature: 'objects', label: '물건', name: '재서명된 쪽지' }], { chapter: 7 });
        const added = out.ledger.records.at(-1);
        expect(added.id).toBe('o3');
        expect(added.possibleDuplicateOf).toBe('o1');
        expect(out.violations.map((v) => v.code)).toEqual(['LEDGER_POSSIBLE_DUPLICATE']);
    });
    it('rejects a change to a destroyed record but allows a mention', () => {
        const out = applyLedgerOps(base(), [
            { op: 'event', id: 'o2', event: 'changed', set: { state: '수리됨' } },
            { op: 'event', id: 'o2', event: 'mentioned', note: '회상' },
        ], { chapter: 7 });
        expect(out.violations.map((v) => [v.code, v.severity])).toEqual([['LEDGER_UPDATE_AFTER_DESTROY', 'hard']]);
        expect(out.ledger.records[1].fields).toEqual({});
        expect(out.ledger.records[1].recent.map((e) => e.event)).toEqual(['mentioned']);
    });
    it('restores a destroyed record only with a note', () => {
        const without = applyLedgerOps(base(), [{ op: 'event', id: 'o2', event: 'restored' }], { chapter: 7 });
        expect(without.violations[0].code).toBe('LEDGER_RESTORE_NOTE_REQUIRED');
        const withNote = applyLedgerOps(base(), [{ op: 'event', id: 'o2', event: 'restored', note: '대장장이가 다시 벼림' }], { chapter: 7 });
        expect(withNote.ledger.records[1].status).toBe('active');
    });
    it('reopens a paid hook and plants a new one with the next id', () => {
        const out = applyLedgerOps(base(), [
            { op: 'hook', id: 'h1', event: 'reopened', note: '다시 아픔' },
            { op: 'plant', text: '누가 사슬을 박았나', horizon: 'arc' },
        ], { chapter: 7 });
        expect(out.hooks.map((h) => [h.id, h.status])).toEqual([['h1', 'open'], ['h2', 'open']]);
        expect(out.hooks[1].plantedAtChapter).toBe(7);
    });
    it('keeps a legacy hook id on plant unless it is taken', () => {
        const out = applyLedgerOps(base(), [{ op: 'plant', text: '사슬', id: 'chain' }, { op: 'plant', text: '또 하나', id: 'h1' }], { chapter: 7 });
        expect(out.hooks.map((h) => h.id)).toEqual(['h1', 'chain', 'h2']);
    });
    it('emits a chapter note without changing records or hooks', () => {
        const out = applyLedgerOps(base(), [{ op: 'chapter-note', note: 'x' }], { chapter: 3 });
        expect(out.events).toEqual([{ chapter: 3, target: 'chapter', event: 'note', note: 'x' }]);
        expect(out.ledger).toEqual(base().ledger);
        expect(out.hooks).toEqual(base().hooks);
    });
    it('keeps a legacy record id on register unless a record or merged id uses it', () => {
        const state = { ...base(), ledger: { records: [...base().ledger.records.map((r) => (r.id === 'o1' ? { ...r, mergedIds: ['e9'] } : r))] } };
        const out = applyLedgerOps(state, [
            { op: 'register', feature: 'objects', label: 'item', name: '청동 열쇠', id: 'e7' },
            { op: 'register', feature: 'objects', label: 'item', name: '은 거울', id: 'e9' },
        ], { chapter: 7 });
        expect(out.ledger.records.slice(-2).map((r) => [r.id, r.name])).toEqual([['e7', '청동 열쇠'], ['o3', '은 거울']]);
    });
    it('plants a hook at the chapter it was first planted when given', () => {
        const out = applyLedgerOps(base(), [{ op: 'plant', text: '사슬', id: 'chain', plantedAtChapter: 2 }], { chapter: 7 });
        expect(out.hooks[1]).toMatchObject({ id: 'chain', plantedAtChapter: 2, lastMovedChapter: 7 });
    });
    it('rewords a hook and changes its horizon through a hook op', () => {
        const out = applyLedgerOps(base(), [{ op: 'hook', id: 'h1', event: 'reopened', text: '손목의 진짜 비밀', horizon: 'next' }], { chapter: 7 });
        expect(out.hooks[0]).toMatchObject({ text: '손목의 진짜 비밀', horizon: 'next', status: 'open' });
        const bad = applyLedgerOps(base(), [{ op: 'hook', id: 'h1', event: 'mentioned', text: '  ', horizon: 'someday' }], { chapter: 7 });
        expect(bad.hooks[0].text).toBe('손목의 비밀');
        expect(bad.hooks[0]).not.toHaveProperty('horizon');
    });
    it('does not apply ops of a feature the user turned off', () => {
        const out = applyLedgerOps(base(), [{ op: 'register', feature: 'knowledge', label: '비밀', name: '손목 부상' }], { chapter: 7, config: { tracking: { knowledge: false } } });
        expect(out.ledger.records).toHaveLength(2);
        expect(out.violations).toEqual([]);
    });
    it('drops an unknown id with a soft finding', () => {
        const out = applyLedgerOps(base(), [{ op: 'event', id: 'o99', event: 'mentioned' }], { chapter: 7 });
        expect(out.violations.map((v) => v.code)).toEqual(['LEDGER_UNKNOWN_ID']);
    });
    it('ignores an event on a custom item whose feature is turned off, without a finding', () => {
        const config = { customTracking: [{ id: 'u1', name: '금화', feature: 'knowledge' }], tracking: { knowledge: false } };
        const out = applyLedgerOps(base(), [{ op: 'event', id: 'u1', event: 'mentioned' }], { chapter: 7, config });
        expect(out.ledger.records).toHaveLength(2);
        expect(out.violations).toEqual([]);
    });
    it('gives a register the custom item id only when its feature matches the op', () => {
        const config = { customTracking: [{ id: 'u1', name: '금화', feature: 'objects' }] };
        const out = applyLedgerOps(base(), [{ op: 'register', feature: 'knowledge', label: '비밀', name: '금화' }], { chapter: 7, config });
        const added = out.ledger.records.find((r) => r.name === '금화');
        expect(added.id).not.toBe('u1');
        expect(added.id.startsWith('k')).toBe(true);
        const ids = out.ledger.records.map((r) => r.id);
        expect(ids).toEqual([...new Set(ids)]);
    });
    it('reports LEDGER_INVALID_EVENT for a known hook given an unsupported event, keeping LEDGER_UNKNOWN_ID for an unknown hook', () => {
        const out = applyLedgerOps(base(), [
            { op: 'hook', id: 'h1', event: 'bogus' },
            { op: 'hook', id: 'h1', event: 'planted' },
            { op: 'hook', id: 'hXX', event: 'paid' },
        ], { chapter: 7 });
        expect(out.violations.map((v) => v.code)).toEqual(['LEDGER_INVALID_EVENT', 'LEDGER_INVALID_EVENT', 'LEDGER_UNKNOWN_ID']);
    });
    it('checks author rules on the custom item', () => {
        const config = { customTracking: [{ id: 'u1', name: '금화', feature: 'objects', rules: [{ type: 'monotonic', field: 'amount', direction: 'down', unless: '벌었' }] }] };
        let state = { ...base(), ...applyLedgerOps(base(), [{ op: 'event', id: 'u1', event: 'changed', set: { amount: '금화 10닢' } }], { chapter: 5, config }) };
        const up = applyLedgerOps(state, [{ op: 'event', id: 'u1', event: 'changed', set: { amount: '금화 12닢' } }], { chapter: 6, config });
        expect(up.violations.map((v) => v.code)).toEqual(['CUSTOM_RULE_MONOTONIC']);
        const earned = applyLedgerOps(state, [{ op: 'event', id: 'u1', event: 'changed', set: { amount: '금화 12닢' }, note: '품삯을 벌었다' }], { chapter: 6, config });
        expect(earned.violations).toEqual([]);
    });
});

describe('applyMerges', () => {
    it('folds a record into another and keeps its id and name as aliases', () => {
        const ledger = { records: [...base().ledger.records, { id: 'o3', feature: 'objects', label: '물건', name: '재서명된 쪽지', aliases: [], status: 'active', fields: { state: '재서명' }, recent: [] }] };
        const out = applyMerges(ledger, [{ from: 'o3', into: 'o1' }], 8);
        expect(out.ledger.records.map((r) => r.id)).toEqual(['o1', 'o2']);
        expect(out.ledger.records[0].mergedIds).toEqual(['o3']);
        expect(out.ledger.records[0].aliases).toEqual([{ text: '재서명된 쪽지' }]);
        expect(out.ledger.records[0].fields).toEqual({ holder: 'c1', state: '재서명' });
        expect(out.events).toEqual([{ chapter: 8, target: 'record', id: 'o3', event: 'merged', into: 'o1' }]);
        expect(applyMerges(out.ledger, [{ from: 'o3', into: 'o1' }], 9).events).toEqual([]);
    });
    it('skips a merge whose two records have different features', () => {
        const ledger = { records: [
            ...base().ledger.records,
            { id: 'k1', feature: 'knowledge', label: '비밀', name: '손목 부상', aliases: [], status: 'secret', fields: {}, recent: [] },
        ] };
        const out = applyMerges(ledger, [{ from: 'k1', into: 'o1' }], 5);
        expect(out.ledger.records.map((r) => r.id).sort()).toEqual(['k1', 'o1', 'o2']);
        expect(out.events).toEqual([]);
    });
});

describe('reviewLedgerOps', () => {
    const state = () => ({ ...base(), ledger: { records: [
        ...base().ledger.records,
        { id: 'o3', feature: 'objects', label: '물건', name: '통행 장부', aliases: [{ text: '그 종이 쪼가리', by: 'c4', since: 5 }], status: 'active', fields: {}, recent: [] },
    ] }, hooks: [{ id: 'h2', text: '누가 사슬을 박았나', status: 'open', recent: [] }] });
    it('downgrades a paid hook whose evidence is not in the prose', () => {
        const out = reviewLedgerOps({ state: state(), prose: '도윤은 사슬을 풀었다.', ops: [{ op: 'hook', id: 'h2', event: 'paid', evidence: '마렌이 사슬을 박았다' }] });
        expect(out.ops).toEqual([{ op: 'hook', id: 'h2', event: 'advanced', evidence: '마렌이 사슬을 박았다' }]);
        expect(out.violations.map((v) => v.code)).toEqual(['HOOK_PAID_WITHOUT_EVIDENCE']);
    });
    it('keeps a paid hook whose evidence is quoted from the prose', () => {
        const out = reviewLedgerOps({ state: state(), prose: '그날 밤, 마렌이   사슬을 박았다고 털어놓았다.', ops: [{ op: 'hook', id: 'h2', event: 'paid', evidence: '마렌이 사슬을 박았다' }] });
        expect(out.ops[0].event).toBe('paid');
        expect(out.violations).toEqual([]);
    });
    it('flags a change to a record the prose never names', () => {
        const out = reviewLedgerOps({ state: state(), prose: '리아는 걸었다.', ops: [{ op: 'event', id: 'o1', event: 'changed', set: { holder: 'c3' } }] });
        expect(out.violations.map((v) => v.code)).toEqual(['LEDGER_NAME_NOT_IN_PROSE']);
    });
    it('flags a speaker-only alias when its owner is absent, and a destroyed record named again', () => {
        const out = reviewLedgerOps({ state: state(), prose: '"그 종이 쪼가리 어디 뒀어?" 낡은 검이 벽에 걸려 있었다.', cast: ['c1', 'c2'], ops: [] });
        expect(out.violations.map((v) => v.code).sort()).toEqual(['DESTROYED_ENTITY_MENTION', 'LEDGER_ALIAS_OWNER_ABSENT']);
    });
    it('downgrades a paid hook whose evidence is too short, even when it matches the prose', () => {
        const out = reviewLedgerOps({ state: state(), prose: '그는 문을 닫았다.', ops: [{ op: 'hook', id: 'h2', event: 'paid', evidence: '다' }] });
        expect(out.ops[0].event).toBe('advanced');
        expect(out.violations.map((v) => v.code)).toEqual(['HOOK_PAID_WITHOUT_EVIDENCE']);
    });
    it('does not check or alter a paid hook when hooks are turned off', () => {
        const config = { tracking: { hooks: false } };
        const out = reviewLedgerOps({ state: state(), prose: '도윤은 사슬을 풀었다.', config, ops: [{ op: 'hook', id: 'h2', event: 'paid', evidence: '아무개가 말했다' }] });
        expect(out.ops[0].event).toBe('paid');
        expect(out.violations).toEqual([]);
    });
    it('does not check destroyed mentions, name-in-prose or speaker aliases for a feature the user turned off', () => {
        const config = { tracking: { objects: false } };
        const out = reviewLedgerOps({
            state: state(),
            prose: '"그 종이 쪼가리 어디 뒀어?" 낡은 검이 벽에 걸려 있었다.',
            cast: ['c1', 'c2'],
            config,
            ops: [{ op: 'event', id: 'o1', event: 'changed', set: { holder: 'c3' } }],
        });
        expect(out.violations).toEqual([]);
    });
});
