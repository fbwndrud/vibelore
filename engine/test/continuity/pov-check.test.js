import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { checkPov } from '../../src/continuity/pov-check.js';
import { resolveNarrator } from '../../src/continuity/pov-narrator.js';
import { createFoundation, registerCharacter, } from '../../src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { DefaultEmotionVerbLexicon } from '../../src/continuity/emotion-verb-lexicon.js';
const registry = createGenreProfileRegistry();
const emotionLexicon = new DefaultEmotionVerbLexicon();
function makeChar(id, canonicalName, role = '주연') {
    return {
        id,
        canonicalName,
        aliases: [],
        registeredAtChapter: 1,
        intrinsic: {
            gender: 'male',
            ageBand: '20대초반',
            role,
            coreAppearance: [],
        },
        mutable: { status: 'alive', knownFacts: [] },
        relationships: [],
    };
}
function makeFoundation(povMode, chars) {
    let f = createFoundation({
        workId: 'work-1',
        genre: 'action',
        genreProfile: registry.get('action'),
        ...(povMode ? { povMode } : {}),
    });
    for (const c of chars)
        f = registerCharacter(f, c);
    return f;
}
describe('resolveNarrator', () => {
    it('returns null for omniscient', () => {
        const f = makeFoundation('omniscient', [makeChar('a', '주인공A', '주인공')]);
        expect(resolveNarrator({ prose: '본문', foundation: f, castManifest: [] }).narratorId).toBe(null);
    });
    it('returns null for multi-pov', () => {
        const f = makeFoundation('multi-pov', [makeChar('a', '주인공A', '주인공')]);
        expect(resolveNarrator({ prose: '본문', foundation: f, castManifest: [] }).narratorId).toBe(null);
    });
    it('prefers cast-manifest head when known', () => {
        const f = makeFoundation('limited-third', [
            makeChar('a', '주인공A', '주인공'),
            makeChar('b', '조연B'),
        ]);
        const r = resolveNarrator({
            prose: '본문',
            foundation: f,
            castManifest: [{ characterId: 'b', addressTermsUsed: [] }],
        });
        expect(r.narratorId).toBe('b');
    });
    it('falls back to protagonist by role', () => {
        const f = makeFoundation('limited-third', [
            makeChar('a', '조연A'),
            makeChar('b', '주인공B', '주인공'),
        ]);
        const r = resolveNarrator({ prose: '본문', foundation: f, castManifest: [] });
        expect(r.narratorId).toBe('b');
    });
    it('defaults to limited-third when povMode absent', () => {
        const f = makeFoundation(undefined, [makeChar('a', '주인공A', '주인공')]);
        const r = resolveNarrator({ prose: '본문', foundation: f, castManifest: [] });
        expect(r.povMode).toBe('limited-third');
        expect(r.narratorId).toBe('a');
    });
});
describe('checkPov', () => {
    it('skips when narratorId is null (omniscient)', () => {
        const f = makeFoundation('omniscient', [
            makeChar('a', '주인공A', '주인공'),
            makeChar('b', '라이덴'),
        ]);
        const prose = '라이덴은 슬펐다. 그는 울었다.';
        const r = checkPov({
            prose,
            chapterNumber: 1,
            foundation: f,
            narratorId: null,
            emotionLexicon,
        });
        expect(r.violations).toEqual([]);
    });
    it('passes when narrator alone has emotion in prose', () => {
        const f = makeFoundation('limited-third', [
            makeChar('a', '주인공A', '주인공'),
            makeChar('b', '라이덴'),
        ]);
        const prose = '주인공A는 슬펐다. 그는 창밖을 바라보았다.';
        const r = checkPov({
            prose,
            chapterNumber: 1,
            foundation: f,
            narratorId: 'a',
            emotionLexicon,
        });
        expect(r.violations).toEqual([]);
    });
    it('HARD FAILs when narrator A asserts B의 emotion in narrative voice', () => {
        const f = makeFoundation('limited-third', [
            makeChar('a', '주인공A', '주인공'),
            makeChar('b', '라이덴'),
        ]);
        const prose = '주인공A는 거리에서 걸었다. 라이덴은 슬펐다.';
        const r = checkPov({
            prose,
            chapterNumber: 1,
            foundation: f,
            narratorId: 'a',
            emotionLexicon,
        });
        expect(r.violations.length).toBeGreaterThan(0);
        expect(r.violations.every((v) => v.code === 'POV_VIOLATION')).toBe(true);
        expect(r.violations.every((v) => v.severity === 'hard')).toBe(true);
        expect(r.violations[0].characterId).toBe('b');
    });
    it('does NOT flag when other character emotion is inside dialogue quotes', () => {
        const f = makeFoundation('limited-third', [
            makeChar('a', '주인공A', '주인공'),
            makeChar('b', '라이덴'),
        ]);
        const prose = '주인공A는 중얼거렸다. "라이덴은 슬펐다, 라고 나는 추측했다."';
        const r = checkPov({
            prose,
            chapterNumber: 1,
            foundation: f,
            narratorId: 'a',
            emotionLexicon,
        });
        expect(r.violations).toEqual([]);
    });
    it('flags interior-tell `<other> 속으로 생각했다` pattern', () => {
        const f = makeFoundation('limited-third', [
            makeChar('a', '주인공A', '주인공'),
            makeChar('b', '라이덴'),
        ]);
        const prose = '주인공A는 침묵했다. 라이덴은 속으로 후회하고 있다고 생각했다.';
        const r = checkPov({
            prose,
            chapterNumber: 1,
            foundation: f,
            narratorId: 'a',
            emotionLexicon,
        });
        expect(r.violations.some((v) => v.code === 'POV_VIOLATION')).toBe(true);
    });
});
