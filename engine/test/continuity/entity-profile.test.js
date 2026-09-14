import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { ATTRS_SCHEMAS, DEFAULT_ENTITY_PROFILE, ENTITY_KINDS, STREAMING_LITRPG_PROFILE, entityProfileFor, } from '../../src/continuity/entity-profile.js';
describe('ENTITY_KINDS', () => {
    it('contains 9 distinct kinds', () => {
        expect(new Set(ENTITY_KINDS).size).toBe(9);
        expect(ENTITY_KINDS).toContain('location');
        expect(ENTITY_KINDS).toContain('monster');
    });
});
describe('ATTRS_SCHEMAS', () => {
    it('every kind has a schema', () => {
        for (const k of ENTITY_KINDS) {
            expect(ATTRS_SCHEMAS[k]).toBeDefined();
        }
    });
    it('location schema accepts known + extra fields (passthrough)', () => {
        const r = ATTRS_SCHEMAS.location.safeParse({ tier: 'S', custom: 'x' });
        expect(r.success).toBe(true);
    });
    it('monster schema validates level as number', () => {
        expect(ATTRS_SCHEMAS.monster.safeParse({ level: 7 }).success).toBe(true);
        expect(ATTRS_SCHEMAS.monster.safeParse({ level: 'seven' }).success).toBe(false);
    });
});
describe('entityProfileFor', () => {
    it('streaming-litrpg → 5 slots dense', () => {
        expect(entityProfileFor('streaming-litrpg')).toBe(STREAMING_LITRPG_PROFILE);
        expect(STREAMING_LITRPG_PROFILE.slots).toHaveLength(5);
    });
    it('unknown genre → DEFAULT profile', () => {
        expect(entityProfileFor('xianxia')).toBe(DEFAULT_ENTITY_PROFILE);
    });
    it('undefined → DEFAULT profile', () => {
        expect(entityProfileFor(undefined)).toBe(DEFAULT_ENTITY_PROFILE);
    });
});
