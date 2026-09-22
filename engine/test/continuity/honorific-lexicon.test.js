import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { DefaultHonorificLexicon, KO_HONORIFIC_SEED, } from '../../src/continuity/honorific-lexicon.js';
describe('KO_HONORIFIC_SEED', () => {
    it('contains at least 20 lexicon-confidence entries', () => {
        expect(KO_HONORIFIC_SEED.length).toBeGreaterThanOrEqual(20);
        for (const entry of KO_HONORIFIC_SEED) {
            expect(entry.confidence).toBe('lexicon');
        }
    });
    it('uses only Korean term strings (no zh/en remnants)', () => {
        // Hangul + Hangul Jamo blocks only; reject any term containing
        // CJK Unified Ideographs (zh) or basic Latin letters (en).
        const nonKorean = /[A-Za-z一-鿿]/;
        for (const entry of KO_HONORIFIC_SEED) {
            expect(nonKorean.test(entry.term), entry.term).toBe(false);
        }
    });
});
describe('DefaultHonorificLexicon — seed loading', () => {
    it('default constructor loads KO_HONORIFIC_SEED with >= 20 entries', () => {
        const lex = new DefaultHonorificLexicon();
        expect(lex.all().length).toBeGreaterThanOrEqual(20);
    });
    it('honors a custom seed when provided', () => {
        const custom = [
            { term: '테스트호칭', genderImplication: 'male', confidence: 'lexicon' },
        ];
        const lex = new DefaultHonorificLexicon(custom);
        expect(lex.all()).toHaveLength(1);
        expect(lex.lookup('테스트호칭')?.genderImplication).toBe('male');
        // Default seed must NOT leak in when a custom seed is supplied.
        expect(lex.lookup('도련님')).toBeUndefined();
    });
});
describe('DefaultHonorificLexicon.lookup', () => {
    const lex = new DefaultHonorificLexicon();
    it('returns male for 도련님 (target gender)', () => {
        const e = lex.lookup('도련님');
        expect(e).toBeDefined();
        expect(e?.genderImplication).toBe('male');
    });
    it('returns female for 아가씨 (target gender)', () => {
        const e = lex.lookup('아가씨');
        expect(e).toBeDefined();
        expect(e?.genderImplication).toBe('female');
    });
    it('returns female-speaker / male-target for 오라버니', () => {
        const e = lex.lookup('오라버니');
        expect(e).toBeDefined();
        expect(e?.speakerGenderImplication).toBe('female');
        expect(e?.genderImplication).toBe('male');
    });
    it('returns undefined for an unknown term', () => {
        expect(lex.lookup('unknown')).toBeUndefined();
    });
});
describe('DefaultHonorificLexicon.append', () => {
    it('appends a new entry, then lookup retrieves it', () => {
        const lex = new DefaultHonorificLexicon();
        const before = lex.all().length;
        lex.append({
            term: '새호칭',
            genderImplication: 'female',
            confidence: 'llm-inferred',
        });
        expect(lex.all().length).toBe(before + 1);
        const got = lex.lookup('새호칭');
        expect(got).toBeDefined();
        expect(got?.genderImplication).toBe('female');
        expect(got?.confidence).toBe('llm-inferred');
    });
    it('overwrites an existing term (last-write-wins)', () => {
        const lex = new DefaultHonorificLexicon();
        // 도련님 seed = male/상류귀족; overwrite with a refined LLM-inferred entry.
        lex.append({
            term: '도련님',
            genderImplication: 'male',
            statusImplication: '상류귀족-수정',
            confidence: 'llm-inferred',
        });
        const got = lex.lookup('도련님');
        expect(got?.confidence).toBe('llm-inferred');
        expect(got?.statusImplication).toBe('상류귀족-수정');
        // Map size unchanged — upsert, not duplicate.
        const dupes = lex.all().filter((e) => e.term === '도련님');
        expect(dupes).toHaveLength(1);
    });
});
