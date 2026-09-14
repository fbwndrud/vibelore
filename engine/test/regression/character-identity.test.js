import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createFoundation, registerCharacter, scanLexicon, DefaultHonorificLexicon, createGenreProfileRegistry, } from '../../src/index.js';
const genres = createGenreProfileRegistry();
const noble_profile = genres.get('noble-clan-regression');
function makeSampleCharacter() {
    return {
        id: 'sample-character',
        canonicalName: '하린',
        aliases: [],
        registeredAtChapter: 1,
        intrinsic: {
            gender: 'female',
            ageBand: '20대초반',
            role: '주인공',
            coreAppearance: ['갈색 머리', '검은 눈'],
        },
        mutable: { status: 'alive', knownFacts: [] },
        relationships: [],
    };
}
describe('SampleCharacter regression — load-bearing engine survival gate', () => {
    // 1. Mode A — hint-based (writer cast-manifest attribution: "도련님" → targetId='sample-character')
    it('HARD FAIL: female SampleCharacter addressed as "도련님" via attributed hint (Mode A)', () => {
        let f = createFoundation({ workId: 'work-honorific-check', genre: 'noble-clan-regression', genreProfile: noble_profile });
        f = registerCharacter(f, makeSampleCharacter());
        const lexicon = new DefaultHonorificLexicon();
        const prose = '하인이 그를 향해 고개를 숙였다. "도련님" 그가 답했다.';
        const dorenymStart = prose.indexOf('도련님');
        const result = scanLexicon({
            prose,
            chapterNumber: 2,
            foundation: f,
            lexicon,
            hints: [{
                    term: '도련님',
                    targetId: 'sample-character',
                    span: { start: dorenymStart, end: dorenymStart + 3 },
                }],
        });
        // **load-bearing assertion**
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0].severity).toBe('hard');
        expect(result.violations[0].code).toBe('GENDER_HONORIFIC_MISMATCH');
        expect(result.violations[0].characterId).toBe('sample-character');
        expect(result.violations[0].message).toContain('도련님');
    });
    // 2. Mode B — prose-only fallback (no writer manifest, named-once female + "도련님" → soft conflict)
    it('SOFT FAIL: prose-only — single female SampleCharacter + "도련님" appears → soft GENDER_HONORIFIC_MISMATCH (Mode B)', () => {
        let f = createFoundation({ workId: 'work-honorific-check', genre: 'noble-clan-regression', genreProfile: noble_profile });
        f = registerCharacter(f, makeSampleCharacter());
        const lexicon = new DefaultHonorificLexicon();
        const prose = '하린은 천천히 일어섰다. "도련님" 부르는 소리가 들렸다.';
        const result = scanLexicon({
            prose,
            chapterNumber: 2,
            foundation: f,
            lexicon,
        });
        // Mode B never emits hard — but should emit at least 1 soft GENDER_HONORIFIC_MISMATCH on the heuristic match
        expect(result.violations.length).toBeGreaterThanOrEqual(1);
        expect(result.violations.some((v) => v.severity === 'soft' && v.code === 'GENDER_HONORIFIC_MISMATCH' && v.characterId === 'sample-character')).toBe(true);
    });
    // 3. Negative control — male SampleCharacter + "도련님" → NO violation (proves the test isn't a tautology)
    it('NEGATIVE CONTROL: male SampleCharacter addressed as "도련님" → no violation', () => {
        let f = createFoundation({ workId: 'work-honorific-check', genre: 'noble-clan-regression', genreProfile: noble_profile });
        const maleSampleCharacter = { ...makeSampleCharacter(), intrinsic: { ...makeSampleCharacter().intrinsic, gender: 'male' } };
        f = registerCharacter(f, maleSampleCharacter);
        const lexicon = new DefaultHonorificLexicon();
        const prose = '하인이 그를 향해 고개를 숙였다. "도련님" 그가 답했다.';
        const dorenymStart = prose.indexOf('도련님');
        const result = scanLexicon({
            prose,
            chapterNumber: 2,
            foundation: f,
            lexicon,
            hints: [{ term: '도련님', targetId: 'sample-character', span: { start: dorenymStart, end: dorenymStart + 3 } }],
        });
        expect(result.violations).toHaveLength(0);
    });
    // 4. "아가씨" → male character is the symmetric case (covers the reverse drift direction)
    it('HARD FAIL: male character addressed as "아가씨" via hint (symmetric SampleCharacter case)', () => {
        let f = createFoundation({ workId: 'work-honorific-check', genre: 'noble-clan-regression', genreProfile: noble_profile });
        const maleProtag = {
            id: 'jin',
            canonicalName: '진',
            aliases: [],
            registeredAtChapter: 1,
            intrinsic: { gender: 'male', ageBand: '20대초반', role: '주인공', coreAppearance: [] },
            mutable: { status: 'alive', knownFacts: [] },
            relationships: [],
        };
        f = registerCharacter(f, maleProtag);
        const lexicon = new DefaultHonorificLexicon();
        const prose = '"아가씨" 누군가가 그를 그렇게 불렀다.';
        const agassiStart = prose.indexOf('아가씨');
        const result = scanLexicon({
            prose,
            chapterNumber: 2,
            foundation: f,
            lexicon,
            hints: [{ term: '아가씨', targetId: 'jin', span: { start: agassiStart, end: agassiStart + 3 } }],
        });
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0].severity).toBe('hard');
        expect(result.violations[0].characterId).toBe('jin');
    });
});
