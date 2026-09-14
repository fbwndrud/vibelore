import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { DefaultHonorificLexicon } from '../../src/continuity/honorific-lexicon.js';
import { scanLexicon } from '../../src/continuity/lexicon-scan.js';
const registry = createGenreProfileRegistry();
function makeFoundation(args) {
    return {
        workId: 'w1',
        genre: 'noble-clan-regression',
        worldFacts: [],
        characters: args.characters ?? [],
        intrinsicChanges: args.intrinsicChanges ?? [],
        genreProfile: registry.get('noble-clan-regression'),
    };
}
function maleChar(id, name) {
    return {
        id,
        canonicalName: name,
        aliases: [],
        registeredAtChapter: 1,
        intrinsic: {
            gender: 'male',
            ageBand: '20대초반',
            role: '주인공',
            coreAppearance: ['흑발'],
        },
        mutable: { status: 'alive', knownFacts: [] },
        relationships: [],
    };
}
function femaleChar(id, name) {
    return {
        id,
        canonicalName: name,
        aliases: [],
        registeredAtChapter: 1,
        intrinsic: {
            gender: 'female',
            ageBand: '20대초반',
            role: '주인공',
            coreAppearance: ['흑발'],
        },
        mutable: { status: 'alive', knownFacts: [] },
        relationships: [],
    };
}
describe('scanLexicon — empty / degenerate inputs', () => {
    it('returns no violations on empty prose', () => {
        const lexicon = new DefaultHonorificLexicon();
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종')] });
        const result = scanLexicon({
            prose: '',
            chapterNumber: 1,
            foundation,
            lexicon,
        });
        expect(result.violations).toEqual([]);
    });
    it('returns no violations when foundation has no characters', () => {
        const lexicon = new DefaultHonorificLexicon();
        const foundation = makeFoundation({});
        const result = scanLexicon({
            prose: '도련님이 들어왔다.',
            chapterNumber: 1,
            foundation,
            lexicon,
        });
        expect(result.violations).toEqual([]);
    });
});
describe('scanLexicon — Mode A (hints)', () => {
    it('no violation when hint targets a character whose effective gender matches lookup', () => {
        const lexicon = new DefaultHonorificLexicon();
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종')] });
        const prose = '"도련님" 하고 그녀가 불렀다.';
        const start = prose.indexOf('도련님');
        const result = scanLexicon({
            prose,
            chapterNumber: 2,
            foundation,
            lexicon,
            hints: [{ term: '도련님', targetId: 'c1', span: { start, end: start + 3 } }],
        });
        expect(result.violations).toEqual([]);
    });
    it('hard GENDER_HONORIFIC_MISMATCH for "도련님" → female character', () => {
        const lexicon = new DefaultHonorificLexicon();
        const foundation = makeFoundation({ characters: [femaleChar('c1', '라이덴')] });
        const prose = '"도련님"';
        const start = prose.indexOf('도련님');
        const result = scanLexicon({
            prose,
            chapterNumber: 2,
            foundation,
            lexicon,
            hints: [{ term: '도련님', targetId: 'c1', span: { start, end: start + 3 } }],
        });
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]).toMatchObject({
            severity: 'hard',
            code: 'GENDER_HONORIFIC_MISMATCH',
            chapterNumber: 2,
            characterId: 'c1',
            span: { start, end: start + 3 },
        });
        expect(result.violations[0].message).toContain('도련님');
        expect(result.violations[0].message).toContain('female');
    });
    it('hard GENDER_HONORIFIC_MISMATCH for "아가씨" → male character', () => {
        const lexicon = new DefaultHonorificLexicon();
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종')] });
        const prose = '"아가씨"';
        const start = prose.indexOf('아가씨');
        const result = scanLexicon({
            prose,
            chapterNumber: 1,
            foundation,
            lexicon,
            hints: [{ term: '아가씨', targetId: 'c1', span: { start, end: start + 3 } }],
        });
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]).toMatchObject({
            severity: 'hard',
            code: 'GENDER_HONORIFIC_MISMATCH',
            characterId: 'c1',
        });
    });
    it('"오라버니" → male target → no violation (speaker check out of scope)', () => {
        const lexicon = new DefaultHonorificLexicon();
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종')] });
        const prose = '오라버니';
        const result = scanLexicon({
            prose,
            chapterNumber: 1,
            foundation,
            lexicon,
            hints: [{ term: '오라버니', targetId: 'c1', span: { start: 0, end: 4 } }],
        });
        expect(result.violations).toEqual([]);
    });
    it('silently skips hint with targetId not in foundation', () => {
        const lexicon = new DefaultHonorificLexicon();
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종')] });
        const result = scanLexicon({
            prose: '도련님',
            chapterNumber: 1,
            foundation,
            lexicon,
            hints: [{ term: '도련님', targetId: 'ghost', span: { start: 0, end: 3 } }],
        });
        expect(result.violations).toEqual([]);
    });
    it('silently skips hint whose term is not in lexicon', () => {
        const lexicon = new DefaultHonorificLexicon();
        const foundation = makeFoundation({ characters: [femaleChar('c1', '라이덴')] });
        const result = scanLexicon({
            prose: '존자',
            chapterNumber: 1,
            foundation,
            lexicon,
            hints: [{ term: '존자', targetId: 'c1', span: { start: 0, end: 2 } }],
        });
        expect(result.violations).toEqual([]);
    });
    it('honors IntrinsicChangeEvent: male@ch1 → female@ch3, "도련님"@ch5 → hard violation', () => {
        const lexicon = new DefaultHonorificLexicon();
        const c = maleChar('c1', '이세종');
        const foundation = makeFoundation({
            characters: [c],
            intrinsicChanges: [
                {
                    characterId: 'c1',
                    atChapter: 3,
                    field: 'gender',
                    from: 'male',
                    to: 'female',
                    narrativeCause: '마법 성전환',
                },
            ],
        });
        const prose = '"도련님"';
        const start = prose.indexOf('도련님');
        const result = scanLexicon({
            prose,
            chapterNumber: 5,
            foundation,
            lexicon,
            hints: [{ term: '도련님', targetId: 'c1', span: { start, end: start + 3 } }],
        });
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]).toMatchObject({
            severity: 'hard',
            code: 'GENDER_HONORIFIC_MISMATCH',
            characterId: 'c1',
        });
        expect(result.violations[0].message).toContain('female');
    });
});
describe('scanLexicon — Mode B (no hints, best-effort)', () => {
    it('soft GENDER_HONORIFIC_MISMATCH when prose has "도련님" + exactly one named female character', () => {
        const lexicon = new DefaultHonorificLexicon();
        const foundation = makeFoundation({ characters: [femaleChar('c1', '라이덴')] });
        const prose = '라이덴은 고개를 들었다. "도련님" 누군가가 그녀를 불렀다.';
        const result = scanLexicon({
            prose,
            chapterNumber: 2,
            foundation,
            lexicon,
        });
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]).toMatchObject({
            severity: 'soft',
            code: 'GENDER_HONORIFIC_MISMATCH',
            characterId: 'c1',
        });
        const span = result.violations[0].span;
        expect(prose.slice(span.start, span.end)).toBe('도련님');
    });
    it('never emits a hard violation in Mode B even with one obvious conflict', () => {
        const lexicon = new DefaultHonorificLexicon();
        const foundation = makeFoundation({ characters: [femaleChar('c1', '라이덴')] });
        const prose = '라이덴 "도련님"';
        const result = scanLexicon({
            prose,
            chapterNumber: 2,
            foundation,
            lexicon,
        });
        expect(result.violations.every((v) => v.severity === 'soft')).toBe(true);
    });
    it('emits soft CAST_MANIFEST_MISMATCH when two female characters both conflict with "도련님"', () => {
        const lexicon = new DefaultHonorificLexicon();
        const foundation = makeFoundation({
            characters: [femaleChar('c1', '라이덴'), femaleChar('c2', '진')],
        });
        const prose = '라이덴과 진이 같이 있었다. "도련님"';
        const result = scanLexicon({
            prose,
            chapterNumber: 2,
            foundation,
            lexicon,
        });
        const ambig = result.violations.filter((v) => v.code === 'CAST_MANIFEST_MISMATCH');
        expect(ambig).toHaveLength(1);
        expect(ambig[0].severity).toBe('soft');
        expect(ambig[0].message).toContain('도련님');
        expect(ambig[0].message).toContain('c1');
        expect(ambig[0].message).toContain('c2');
    });
    it('excludes characters not yet registered at chapterNumber', () => {
        const lexicon = new DefaultHonorificLexicon();
        const late = {
            ...femaleChar('c1', '라이덴'),
            registeredAtChapter: 10,
        };
        const foundation = makeFoundation({ characters: [late] });
        const result = scanLexicon({
            prose: '라이덴 "도련님"',
            chapterNumber: 2,
            foundation,
            lexicon,
        });
        expect(result.violations).toEqual([]);
    });
});
