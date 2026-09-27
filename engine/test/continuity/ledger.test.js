import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { emptyLedger, findRecord, hookStatusOf, ledgerFromLegacy, ledgerNameKey, nextLedgerId, similarRecord } from '../../src/continuity/ledger.js';

const note = { id: 'o1', feature: 'objects', label: '물건', name: '서명 쪽지', aliases: [{ text: '그 쪽지' }], status: 'active', fields: {}, recent: [] };

describe('ledger lookup', () => {
    it('normalizes names: case, quotes, spaces and a trailing particle', () => {
        expect(ledgerNameKey('「서명 쪽지」를')).toBe('서명 쪽지');
        expect(ledgerNameKey('  Silver  Key ')).toBe('silver key');
    });
    it('finds a record by id, merged id, name or alias', () => {
        const ledger = { records: [{ ...note, mergedIds: ['o9'] }] };
        expect(findRecord(ledger, 'o1')?.id).toBe('o1');
        expect(findRecord(ledger, 'o9')?.id).toBe('o1');
        expect(findRecord(ledger, '서명 쪽지는')?.id).toBe('o1');
        expect(findRecord(ledger, '그 쪽지')?.id).toBe('o1');
        expect(findRecord(ledger, '그 쪽지', 'knowledge')).toBe(null);
    });
    it('reports a similar record without treating it as the same', () => {
        const ledger = { records: [note] };
        expect(similarRecord(ledger, 'objects', '재서명된 쪽지')?.id).toBe('o1');
        expect(similarRecord(ledger, 'objects', '은빛 열쇠')).toBe(null);
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
