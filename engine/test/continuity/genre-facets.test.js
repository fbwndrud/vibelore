import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { ENGINE_GENRES } from '../../src/continuity/genre-profile.js';
import { GENRE_FACETS, allGenresCovered, facetsForGenre, } from '../../src/continuity/genre-facets.js';
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
});
describe('facetsForGenre', () => {
    it('returns the registered preset for a known genre', () => {
        expect(facetsForGenre('cultivation')).toBe(GENRE_FACETS.cultivation);
    });
    it('falls back to a generic non-empty preset for an unknown genre', () => {
        const preset = facetsForGenre('not-a-real-genre');
        expect(preset.facets.length).toBeGreaterThan(0);
    });
});
