import { describe, it, expect } from '../_support/vitest-shim.mjs';
import { DefaultStyleLexicon, STYLE_LEXICON_SEED } from '../../src/continuity/style-lexicon.js';
import { ENGINE_GENRES } from '../../src/continuity/genre-profile.js';
describe('StyleLexicon', () => {
    it('seed covers all 25 engine genres', () => {
        const genres = new Set(STYLE_LEXICON_SEED.map((e) => e.genreId));
        for (const g of ENGINE_GENRES) {
            expect(genres.has(g)).toBe(true);
        }
    });
    it('each genre carries at least 8 entries', () => {
        const lex = new DefaultStyleLexicon();
        for (const g of ENGINE_GENRES) {
            expect(lex.forGenre(g).length).toBeGreaterThanOrEqual(8);
        }
    });
    it('all() returns full seed', () => {
        const lex = new DefaultStyleLexicon();
        expect(lex.all().length).toBe(STYLE_LEXICON_SEED.length);
    });
    it('forGenre returns only that genre entries', () => {
        const lex = new DefaultStyleLexicon();
        const entries = lex.forGenre('regression-hunter');
        expect(entries.every((e) => e.genreId === 'regression-hunter')).toBe(true);
    });
    it('returns empty array for unknown genre (string cast)', () => {
        const lex = new DefaultStyleLexicon();
        expect(lex.forGenre('nope-not-real')).toEqual([]);
    });
});
