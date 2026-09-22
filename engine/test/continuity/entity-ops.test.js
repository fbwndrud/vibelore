import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { foldEntityOps, scanDestroyedEntityMentions, } from '../../src/continuity/entity-ops.js';
function snapshot(overrides = {}) {
    return {
        entityId: 'e1',
        kind: 'location',
        canonicalName: '강남 게이트',
        aliases: [],
        status: 'active',
        attrs: {},
        ...overrides,
    };
}
describe('foldEntityOps', () => {
    it('register new id → toRegister', () => {
        const r = foldEntityOps({
            ops: [{ op: 'register', entityId: 'e1', kind: 'location', name: '강남 게이트' }],
            byId: new Map(),
            chapterNumber: 1,
        });
        expect(r.toRegister).toHaveLength(1);
        expect(r.violations).toHaveLength(0);
    });
    it('register on existing id → HARD violation, no register', () => {
        const r = foldEntityOps({
            ops: [{ op: 'register', entityId: 'e1', kind: 'location', name: '서울' }],
            byId: new Map([['e1', snapshot()]]),
            chapterNumber: 5,
        });
        expect(r.toRegister).toHaveLength(0);
        expect(r.violations[0]).toMatchObject({ severity: 'hard', code: 'ENTITY_ID_CONFLICT' });
    });
    it('register name clash with active entity → SOFT warn, register still proceeds', () => {
        const r = foldEntityOps({
            ops: [{ op: 'register', entityId: 'e2', kind: 'location', name: '강남 게이트' }],
            byId: new Map([['e1', snapshot()]]),
            chapterNumber: 5,
        });
        expect(r.toRegister).toHaveLength(1);
        expect(r.violations[0]).toMatchObject({ severity: 'soft', code: 'ENTITY_NAME_DUPLICATE' });
    });
    it('update active → toUpdate', () => {
        const r = foldEntityOps({
            ops: [{ op: 'update', entityId: 'e1', fields: { climate: 'tropical' } }],
            byId: new Map([['e1', snapshot()]]),
            chapterNumber: 5,
        });
        expect(r.toUpdate).toHaveLength(1);
        expect(r.toUpdate[0].fields.climate).toBe('tropical');
        expect(r.violations).toHaveLength(0);
    });
    it('update destroyed → HARD violation', () => {
        const r = foldEntityOps({
            ops: [{ op: 'update', entityId: 'e1', fields: { ruin: true } }],
            byId: new Map([['e1', snapshot({ status: 'destroyed' })]]),
            chapterNumber: 50,
        });
        expect(r.toUpdate).toHaveLength(0);
        expect(r.violations[0]).toMatchObject({
            severity: 'hard',
            code: 'ENTITY_UPDATE_AFTER_DESTROY',
        });
    });
    it('update unknown id → SOFT warn skip', () => {
        const r = foldEntityOps({
            ops: [{ op: 'update', entityId: 'e9', fields: {} }],
            byId: new Map(),
            chapterNumber: 1,
        });
        expect(r.toUpdate).toHaveLength(0);
        expect(r.violations[0]).toMatchObject({ severity: 'soft', code: 'ENTITY_UPDATE_UNKNOWN' });
    });
    it('retire active → toRetire with cause', () => {
        const r = foldEntityOps({
            ops: [{ op: 'retire', entityId: 'e1', reason: 'killed by hero' }],
            byId: new Map([['e1', snapshot()]]),
            chapterNumber: 20,
        });
        expect(r.toRetire).toHaveLength(1);
        expect(r.toRetire[0].cause).toBe('killed by hero');
    });
    it('retire already destroyed → SOFT reentry, no toRetire', () => {
        const r = foldEntityOps({
            ops: [{ op: 'retire', entityId: 'e1' }],
            byId: new Map([['e1', snapshot({ status: 'destroyed' })]]),
            chapterNumber: 20,
        });
        expect(r.toRetire).toHaveLength(0);
        expect(r.violations[0]).toMatchObject({ severity: 'soft', code: 'ENTITY_RETIRE_REENTRY' });
    });
    it('mixed batch — register + update + retire + 1 violation isolated', () => {
        const r = foldEntityOps({
            ops: [
                { op: 'register', entityId: 'e3', kind: 'monster', name: '모래뱀' },
                { op: 'update', entityId: 'e1', fields: { climate: 'arid' } },
                { op: 'retire', entityId: 'e2', reason: 'killed' },
                { op: 'update', entityId: 'unknown-id', fields: {} },
            ],
            byId: new Map([
                ['e1', snapshot()],
                ['e2', snapshot({ entityId: 'e2', canonicalName: '바다용', status: 'active' })],
            ]),
            chapterNumber: 10,
        });
        expect(r.toRegister).toHaveLength(1);
        expect(r.toUpdate).toHaveLength(1);
        expect(r.toRetire).toHaveLength(1);
        expect(r.violations).toHaveLength(1);
        expect(r.violations[0].code).toBe('ENTITY_UPDATE_UNKNOWN');
    });
});
describe('scanDestroyedEntityMentions', () => {
    it('destroyed entity name appears in prose → SOFT violation', () => {
        const v = scanDestroyedEntityMentions({
            prose: '그는 부서진 강남 게이트 앞에 섰다.',
            snapshots: [snapshot({ status: 'destroyed' })],
            chapterNumber: 25,
        });
        expect(v).toHaveLength(1);
        expect(v[0]).toMatchObject({ severity: 'soft', code: 'DESTROYED_ENTITY_MENTION' });
    });
    it('active entity mention → no violation', () => {
        const v = scanDestroyedEntityMentions({
            prose: '강남 게이트 앞에 섰다.',
            snapshots: [snapshot({ status: 'active' })],
            chapterNumber: 25,
        });
        expect(v).toHaveLength(0);
    });
    it('alias match also triggers violation', () => {
        const v = scanDestroyedEntityMentions({
            prose: '서울 던전이 다시 보였다.',
            snapshots: [snapshot({ status: 'destroyed', aliases: ['서울 던전'] })],
            chapterNumber: 30,
        });
        expect(v).toHaveLength(1);
    });
    it('no mention → no violation', () => {
        const v = scanDestroyedEntityMentions({
            prose: '주인공은 산을 올랐다.',
            snapshots: [snapshot({ status: 'destroyed' })],
            chapterNumber: 30,
        });
        expect(v).toHaveLength(0);
    });
    it('one violation per entity (multiple matches dedupe)', () => {
        const v = scanDestroyedEntityMentions({
            prose: '강남 게이트. 강남 게이트. 강남 게이트.',
            snapshots: [snapshot({ status: 'destroyed' })],
            chapterNumber: 30,
        });
        expect(v).toHaveLength(1);
    });
});
