import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { ENGINE_GENRES, createGenreProfileRegistry, } from '../../src/continuity/genre-profile.js';
import { GENRE_FACETS, allGenresCovered, facetsForGenre, } from '../../src/continuity/genre-facets.js';
const registry = createGenreProfileRegistry();
// trackedAxes 가 정합해야 하는 entity kind 전부 (genre-profile.ts family kinds).
const VALID_AXES = new Set([
    'Timeline',
    'RegressionKnowledge',
    'RelationshipState',
    'PowerSystem',
    'Artifact',
    'Clue',
    'KnowledgeMatrix',
]);
describe('GENRE_FACETS', () => {
    it('covers all 25 ENGINE_GENRES with non-empty facets', () => {
        expect(ENGINE_GENRES).toHaveLength(25);
        for (const genre of ENGINE_GENRES) {
            const preset = GENRE_FACETS[genre];
            expect(preset, `genre "${genre}" missing in GENRE_FACETS`).toBeDefined();
            expect(preset.facets.length).toBeGreaterThan(0);
        }
        expect(allGenresCovered()).toBe(true);
    });
    it('every facet has a slug-like key and a non-empty label', () => {
        for (const genre of ENGINE_GENRES) {
            for (const facet of GENRE_FACETS[genre].facets) {
                expect(facet.key).toMatch(/^[a-z0-9-]+$/);
                expect(facet.label.trim().length).toBeGreaterThan(0);
            }
        }
    });
    it('facet keys are unique within each genre', () => {
        for (const genre of ENGINE_GENRES) {
            const keys = GENRE_FACETS[genre].facets.map((f) => f.key);
            expect(new Set(keys).size).toBe(keys.length);
        }
    });
    it('trackedAxes only use valid GenreProfile entity kinds', () => {
        for (const genre of ENGINE_GENRES) {
            for (const axis of GENRE_FACETS[genre].trackedAxes) {
                expect(VALID_AXES.has(axis), `genre "${genre}" axis "${axis}" not a known kind`).toBe(true);
            }
        }
    });
    it('trackedAxes are a subset of the genre profile tracked entity kinds', () => {
        for (const genre of ENGINE_GENRES) {
            const profileKinds = new Set(registry.get(genre).trackedEntities.map((e) => e.kind));
            for (const axis of GENRE_FACETS[genre].trackedAxes) {
                expect(profileKinds.has(axis), `genre "${genre}" facet axis "${axis}" not tracked by GenreProfile`).toBe(true);
            }
        }
    });
    it('power family genres track PowerSystem axis', () => {
        expect(GENRE_FACETS.cultivation.trackedAxes).toContain('PowerSystem');
        expect(GENRE_FACETS.litrpg.trackedAxes).toContain('PowerSystem');
    });
    it('regression family genres track Timeline + RegressionKnowledge', () => {
        expect(GENRE_FACETS['regression-hunter'].trackedAxes).toEqual(expect.arrayContaining(['Timeline', 'RegressionKnowledge']));
    });
    it('villainess-isekai tracks both regression and romance axes', () => {
        expect(GENRE_FACETS['villainess-isekai'].trackedAxes).toEqual(expect.arrayContaining(['Timeline', 'RegressionKnowledge', 'RelationshipState']));
    });
});
describe('facetsForGenre', () => {
    it('returns the registered preset for a known genre', () => {
        expect(facetsForGenre('cultivation')).toBe(GENRE_FACETS.cultivation);
    });
    it('falls back to a generic non-empty preset for an unknown genre', () => {
        const preset = facetsForGenre('not-a-real-genre');
        expect(preset.facets.length).toBeGreaterThan(0);
        expect(preset.trackedAxes).toEqual([]);
    });
});
