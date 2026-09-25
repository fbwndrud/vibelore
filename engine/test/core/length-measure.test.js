import { describe, expect, it } from '../_support/vitest-shim.mjs';
import {
    LanguagePolicyError,
    computeMeasurementPolicyHash,
    resolveMeasurementPolicy,
    validateLengthMeasurementResult,
} from '../../src/core/language-policy.js';
import { countLength, publishedProse, truncateLength } from '../../src/core/length-measure.js';

describe('countLength', () => {
    it('legacyCodeUnits equals JS String.length of published prose', () => {
        const policy = resolveMeasurementPolicy({ language: 'ko', unit: 'legacyCodeUnits' });
        const text = '카엘은 걸었다.';
        const result = countLength(text, policy);
        expect(result.unit).toBe('legacyCodeUnits');
        expect(result.count).toBe(publishedProse(text).length);
        expect(result.measurementPolicyHash).toBe(computeMeasurementPolicyHash(policy));
        expect(validateLengthMeasurementResult(result, policy).count).toBe(result.count);
    });

    it('strips sentinels then trims before counting', () => {
        const policy = resolveMeasurementPolicy({ language: 'en', unit: 'legacyCodeUnits' });
        const raw = '  Hello ⟦vle:cast-manifest {"schemaVersion":1}⟧ world.  ';
        const result = countLength(raw, policy);
        expect(result.count).toBe(publishedProse(raw).length);
        expect(publishedProse(raw)).toBe('Hello  world.');
    });

    it('graphemes count emoji clusters and NFD/NFC as one when they are one cluster', () => {
        const policy = resolveMeasurementPolicy({ language: 'en', unit: 'graphemes' });
        expect(countLength('👨‍👩‍👧‍👦', policy).count).toBe(1);
        expect(countLength('e\u0301', policy).count).toBe(1);
        expect(countLength('é', policy).count).toBe(1);
        expect(countLength('The banner fell.', policy).count).toBe(16);
    });

    it('graphemes include internal whitespace and punctuation after trim', () => {
        const policy = resolveMeasurementPolicy({ language: 'ja', unit: 'graphemes' });
        const text = '太郎は走った。';
        const result = countLength(text, policy);
        expect(result.unit).toBe('graphemes');
        expect(result.count).toBe([...new Intl.Segmenter(policy.resolvedLocale, { granularity: 'grapheme' }).segment(text)].length);
    });

    it('words count isWordLike only for Arabic and English', () => {
        const en = resolveMeasurementPolicy({ language: 'en', unit: 'words' });
        expect(countLength('The banner fell.', en).count).toBe(3);
        const ar = resolveMeasurementPolicy({ language: 'ar', unit: 'words' });
        expect(countLength('سقطت الراية.', ar).count).toBe(2);
    });

    it('kr words is unsupported at policy production, not a silent en-US count', () => {
        expect(() => resolveMeasurementPolicy({ language: 'kr', unit: 'words' })).toThrow(LanguagePolicyError);
        try {
            resolveMeasurementPolicy({ language: 'kr', unit: 'words' });
        }
        catch (err) {
            expect(err.code).toBe('UNSUPPORTED_LENGTH_MEASUREMENT');
        }
    });

    it('rejects a policy whose hash/runtime cannot be measured faithfully', () => {
        const policy = resolveMeasurementPolicy({ language: 'en', unit: 'legacyCodeUnits' });
        const result = countLength('hello', policy);
        const other = resolveMeasurementPolicy({ language: 'en', unit: 'graphemes' });
        expect(() => validateLengthMeasurementResult(result, other)).toThrow(LanguagePolicyError);
        const badRuntime = { ...policy, runtime: { ...policy.runtime, icu: '0' } };
        expect(() => countLength('hello', badRuntime)).toThrow(LanguagePolicyError);
    });

    it('refuses a forged grapheme pin that would drop whitespace while still counting spaces', () => {
        const policy = resolveMeasurementPolicy({ language: 'en', unit: 'graphemes' });
        const forged = { ...policy, countsWhitespace: false };
        expect(() => countLength('a b', forged)).toThrow(LanguagePolicyError);
        const produced = countLength('a b', policy);
        expect(produced.count).toBe(3);
        expect(produced.measurementPolicyHash).toBe(computeMeasurementPolicyHash(policy));
    });

    it('truncateLength keeps grapheme/word integrity and counts ellipsis', () => {
        const g = resolveMeasurementPolicy({ language: 'en', unit: 'graphemes' });
        const family = '👨‍👩‍👧‍👦';
        const emoji = truncateLength(`${family} and more`, g, 2);
        expect(countLength(emoji, g).count).toBeLessThanOrEqual(2);
        expect(emoji.startsWith(family) || emoji === '…').toBe(true);
        expect(emoji.includes('\uD83D\uDC69') && emoji.includes('\u200D') || emoji === '…').toBe(true);

        const w = resolveMeasurementPolicy({ language: 'en', unit: 'words' });
        const words = truncateLength('The banner fell silently tonight.', w, 3);
        expect(countLength(words, w).count).toBeLessThanOrEqual(3);
        expect(words.includes('…')).toBe(true);
        expect(words.includes('silently')).toBe(false);

        const legacy = resolveMeasurementPolicy({ language: 'ko', unit: 'legacyCodeUnits' });
        const cut = truncateLength('abcdef', legacy, 4);
        expect(countLength(cut, legacy).count).toBeLessThanOrEqual(4);
        expect(cut.endsWith('…')).toBe(true);
        expect(() => truncateLength('abcdef', legacy, 0)).toThrow(LanguagePolicyError);
    });
});
