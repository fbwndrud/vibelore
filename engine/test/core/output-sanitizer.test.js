import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { DefaultOutputSanitizer } from '../../src/core/output-sanitizer.js';
describe('DefaultOutputSanitizer.sanitize', () => {
    const sut = new DefaultOutputSanitizer();
    it('round-trips an empty string with leaked=false', () => {
        const out = sut.sanitize('');
        expect(out.clean).toBe('');
        expect(out.removed).toEqual([]);
        expect(out.leaked).toBe(false);
    });
    it('strips a single sentinel block cleanly', () => {
        // Choice: preserve surrounding whitespace literally (do NOT trim) so that
        // upstream paragraph structure / spacing remains the caller's responsibility.
        // The block at position 6..end-of-block is replaced with the empty string,
        // leaving the two spaces that bracketed the block ("hello " + "" + " world").
        const input = 'hello ⟦vle:cast-manifest ["a"]⟧ world';
        const out = sut.sanitize(input);
        expect(out.clean).toBe('hello  world');
        expect(out.removed).toEqual([{ tag: 'cast-manifest', body: '["a"]' }]);
        expect(out.leaked).toBe(false);
    });
    it('strips multiple blocks in source order', () => {
        const input = '⟦vle:cast-manifest ["a"]⟧mid⟦vle:delta-hint {"k":1}⟧tail';
        const out = sut.sanitize(input);
        expect(out.clean).toBe('midtail');
        expect(out.removed).toEqual([
            { tag: 'cast-manifest', body: '["a"]' },
            { tag: 'delta-hint', body: '{"k":1}' },
        ]);
        expect(out.leaked).toBe(false);
    });
    it('flags an orphan sentinel-open (mismatched, no close) and leaves prose unchanged', () => {
        const input = '⟦vle:foo no close';
        const out = sut.sanitize(input);
        expect(out.clean).toBe(input);
        expect(out.removed).toEqual([]);
        expect(out.leaked).toBe(true);
    });
    it('flags a stray sentinel-close left in prose', () => {
        const input = 'no open ⟧ here';
        const out = sut.sanitize(input);
        expect(out.clean).toBe(input);
        expect(out.removed).toEqual([]);
        expect(out.leaked).toBe(true);
    });
    it('rejects a review note left in manuscript prose', () => {
        const input = '본문\n[review-note] 내부메모';
        const out = sut.sanitize(input);
        expect(out.clean).toBe(input);
        expect(out.removed).toEqual([]);
        expect(out.leaked).toBe(true);
    });
    it('detects internal phase annotations case-insensitively', () => {
        for (const marker of ['[state-init]', '[DRAFT-v1]', '[reviser-final]']) {
            const out = sut.sanitize(`prose ${marker} more`);
            expect(out.leaked, marker).toBe(true);
        }
    });
    it('rejects machine annotations regardless of which component wrote them', () => {
        for (const marker of ['[editor-note]', '[memory-hint]', '[cast-manifest]', '[entity-ops]']) {
            expect(sut.sanitize(`본문 ${marker} 메타데이터`).leaked, marker).toBe(true);
        }
    });
    it('preserves ordinary bracketed prose and isolated phase words', () => {
        const prose = '책 [해와 달], 표지 [sun-rise], 초안 [draft], 배역 [cast].';
        expect(sut.sanitize(prose)).toEqual({ clean: prose, removed: [], leaked: false });
    });
    it('does not strip free-text [bracketed] noise but does not flag unknown markers', () => {
        // Sanitizer only strips sentinel blocks; arbitrary `[foo]` is not a leak
        // marker class — leaks list is the exhaustive known-internal set.
        const input = 'prose [unrelated] tail';
        const out = sut.sanitize(input);
        expect(out.clean).toBe(input);
        expect(out.removed).toEqual([]);
        expect(out.leaked).toBe(false);
    });
    it('keeps removed[] order stable across many blocks', () => {
        const input = [
            '⟦vle:a 1⟧',
            'x',
            '⟦vle:b 2⟧',
            'y',
            '⟦vle:c 3⟧',
        ].join('');
        const out = sut.sanitize(input);
        expect(out.clean).toBe('xy');
        expect(out.removed.map((b) => b.tag)).toEqual(['a', 'b', 'c']);
        expect(out.removed.map((b) => b.body)).toEqual(['1', '2', '3']);
        expect(out.leaked).toBe(false);
    });
});
describe('DefaultOutputSanitizer.extractBlock', () => {
    const sut = new DefaultOutputSanitizer();
    it('returns the first match for a given tag and ignores later blocks', () => {
        const input = 'p ⟦vle:cast-manifest ["a"]⟧ q ⟦vle:cast-manifest ["b"]⟧ r';
        const got = sut.extractBlock(input, 'cast-manifest');
        expect(got).toEqual({ tag: 'cast-manifest', body: '["a"]' });
    });
    it('returns null when the tag is absent', () => {
        const input = 'p ⟦vle:delta-hint {"k":1}⟧ q';
        expect(sut.extractBlock(input, 'cast-manifest')).toBeNull();
    });
    it('does not mutate raw', () => {
        const input = 'p ⟦vle:cast-manifest ["a"]⟧ q';
        const snapshot = input;
        sut.extractBlock(input, 'cast-manifest');
        expect(input).toBe(snapshot);
    });
    it('only matches the requested tag, not other tags', () => {
        const input = '⟦vle:delta-hint {"k":1}⟧⟦vle:cast-manifest ["a"]⟧';
        const got = sut.extractBlock(input, 'cast-manifest');
        expect(got).toEqual({ tag: 'cast-manifest', body: '["a"]' });
    });
});
