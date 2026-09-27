import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { ENGINE_GENRES, createGenreProfileRegistry, } from '../../src/continuity/genre-profile.js';
const registry = createGenreProfileRegistry();
const kinds = (genre) => registry.get(genre).trackedEntities.map((spec) => spec.kind);
const invariantIds = (genre) => registry.get(genre).invariants.map((inv) => inv.id);
describe('GenreProfileRegistry', () => {
    it('registers all 25 genres', () => {
        expect(registry.all()).toHaveLength(25);
        expect(ENGINE_GENRES).toHaveLength(25);
    });
    it('has() returns true for every ENGINE_GENRES id and get() returns matching profile', () => {
        for (const genre of ENGINE_GENRES) {
            expect(registry.has(genre)).toBe(true);
            const profile = registry.get(genre);
            expect(profile.genre).toBe(genre);
        }
    });
    it('has() narrows unknown strings to false', () => {
        expect(registry.has('not-a-real-genre')).toBe(false);
        expect(registry.has('')).toBe(false);
        expect(registry.has('REGRESSION-HUNTER')).toBe(false);
    });
    describe('regression family', () => {
        it('regression-hunter no longer tracks genre-specific entities, but keeps its invariants', () => {
            expect(kinds('regression-hunter')).toEqual([]);
            expect(invariantIds('regression-hunter')).toEqual([
                'timeline-causality',
                'regression-knowledge-bound',
            ]);
        });
        it('noble-clan-regression and isekai also have no tracked entities', () => {
            expect(kinds('noble-clan-regression')).toEqual([]);
            expect(kinds('isekai')).toEqual([]);
        });
        it('regression invariants are hard severity', () => {
            const profile = registry.get('regression-hunter');
            const timelineInv = profile.invariants.find((i) => i.id === 'timeline-causality');
            const knowledgeInv = profile.invariants.find((i) => i.id === 'regression-knowledge-bound');
            expect(timelineInv?.severity).toBe('hard');
            expect(knowledgeInv?.severity).toBe('hard');
        });
    });
    describe('romance family', () => {
        it('romantasy has no tracked entities but keeps its invariant', () => {
            expect(kinds('romantasy')).toEqual([]);
            expect(invariantIds('romantasy')).toEqual(['relationship-no-backwards']);
        });
        it('relationship invariant is soft severity', () => {
            const profile = registry.get('romantasy');
            expect(profile.invariants[0]?.severity).toBe('soft');
        });
    });
    describe('composite ids', () => {
        it('villainess-isekai has no tracked entities but unions regression + romance invariants with no duplicates', () => {
            expect(kinds('villainess-isekai')).toEqual([]);
            const ids = invariantIds('villainess-isekai');
            expect(ids).toContain('timeline-causality');
            expect(ids).toContain('regression-knowledge-bound');
            expect(ids).toContain('relationship-no-backwards');
            expect(new Set(ids).size).toBe(ids.length);
        });
    });
    describe('power family', () => {
        it('cultivation has no tracked entities but keeps its invariants', () => {
            expect(kinds('cultivation')).toEqual([]);
            expect(invariantIds('cultivation')).toEqual([
                'power-no-backwards',
                'artifact-owner-tracked',
            ]);
        });
        it('power invariants split hard vs soft', () => {
            const profile = registry.get('cultivation');
            const power = profile.invariants.find((i) => i.id === 'power-no-backwards');
            const artifact = profile.invariants.find((i) => i.id === 'artifact-owner-tracked');
            expect(power?.severity).toBe('hard');
            expect(artifact?.severity).toBe('soft');
        });
        it('all 10 power-family ids have no tracked entities', () => {
            for (const g of [
                'cultivation',
                'xianxia',
                'xuanhuan',
                'litrpg',
                'progression',
                'tower-climber',
                'system-apocalypse',
                'dungeon-core',
                'academy-fantasy',
                'streaming-litrpg',
            ]) {
                expect(kinds(g)).toEqual([]);
            }
        });
    });
    describe('mystery family', () => {
        it('mystery-thriller has no tracked entities but keeps its invariant', () => {
            expect(kinds('mystery-thriller')).toEqual([]);
            expect(invariantIds('mystery-thriller')).toEqual([
                'no-undisclosed-clue-leak',
            ]);
            const profile = registry.get('mystery-thriller');
            expect(profile.invariants[0]?.severity).toBe('hard');
        });
    });
    describe('base-only ids', () => {
        it('action has no tracked entities and no invariants', () => {
            expect(registry.get('action').trackedEntities).toEqual([]);
            expect(registry.get('action').invariants).toEqual([]);
        });
        it('other base ids are also empty', () => {
            for (const g of [
                'comedy',
                'historical',
                'sci-fi',
                'horror',
                'cozy',
                'urban',
                'other',
                'banishment-revenge',
            ]) {
                expect(registry.get(g).trackedEntities).toEqual([]);
                expect(registry.get(g).invariants).toEqual([]);
            }
        });
    });
});
