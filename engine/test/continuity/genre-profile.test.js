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
        it('regression-hunter tracks Timeline + RegressionKnowledge', () => {
            expect(kinds('regression-hunter')).toEqual([
                'Timeline',
                'RegressionKnowledge',
            ]);
            expect(invariantIds('regression-hunter')).toEqual([
                'timeline-causality',
                'regression-knowledge-bound',
            ]);
        });
        it('noble-clan-regression and isekai also receive regression entities', () => {
            expect(kinds('noble-clan-regression')).toContain('Timeline');
            expect(kinds('noble-clan-regression')).toContain('RegressionKnowledge');
            expect(kinds('isekai')).toContain('Timeline');
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
        it('romantasy tracks RelationshipState only', () => {
            expect(kinds('romantasy')).toEqual(['RelationshipState']);
            expect(invariantIds('romantasy')).toEqual(['relationship-no-backwards']);
        });
        it('relationship invariant is soft severity', () => {
            const profile = registry.get('romantasy');
            expect(profile.invariants[0]?.severity).toBe('soft');
        });
    });
    describe('composite ids', () => {
        it('villainess-isekai unions regression + romance with no duplicates', () => {
            const ks = kinds('villainess-isekai');
            expect(ks).toContain('Timeline');
            expect(ks).toContain('RegressionKnowledge');
            expect(ks).toContain('RelationshipState');
            expect(new Set(ks).size).toBe(ks.length);
            // regression first
            expect(ks.indexOf('Timeline')).toBeLessThan(ks.indexOf('RelationshipState'));
            const ids = invariantIds('villainess-isekai');
            expect(ids).toContain('timeline-causality');
            expect(ids).toContain('regression-knowledge-bound');
            expect(ids).toContain('relationship-no-backwards');
            expect(new Set(ids).size).toBe(ids.length);
        });
    });
    describe('power family', () => {
        it('cultivation tracks PowerSystem + Artifact', () => {
            expect(kinds('cultivation')).toEqual(['PowerSystem', 'Artifact']);
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
        it('all 10 power-family ids tracked PowerSystem', () => {
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
                expect(kinds(g)).toEqual(['PowerSystem', 'Artifact']);
            }
        });
    });
    describe('mystery family', () => {
        it('mystery-thriller tracks Clue + KnowledgeMatrix', () => {
            expect(kinds('mystery-thriller')).toEqual(['Clue', 'KnowledgeMatrix']);
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
