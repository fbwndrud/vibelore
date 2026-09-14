import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { DefaultOutputSanitizer } from '../../src/core/output-sanitizer.js';
describe('DefaultOutputSanitizer.extractAllBlocks', () => {
    const s = new DefaultOutputSanitizer();
    it('returns empty array when prose has no sentinel', () => {
        expect(s.extractAllBlocks('plain prose with no markers.')).toEqual([]);
    });
    it('extracts every block in document order', () => {
        const prose = `prose start.

⟦vle:cast-manifest {"schemaVersion":1,"cast":[]}⟧

middle prose.

⟦vle:entity-ops {"schemaVersion":1,"ops":[]}⟧

⟦vle:hook-ops {"schemaVersion":1,"ops":[]}⟧
end.`;
        const blocks = s.extractAllBlocks(prose);
        expect(blocks.map((b) => b.tag)).toEqual(['cast-manifest', 'entity-ops', 'hook-ops']);
        expect(blocks[0].body).toContain('"cast":[]');
    });
    it('reentrant — repeated calls produce same result (no shared lastIndex bug)', () => {
        const prose = '⟦vle:cast-manifest {"schemaVersion":1,"cast":[]}⟧';
        expect(s.extractAllBlocks(prose)).toHaveLength(1);
        expect(s.extractAllBlocks(prose)).toHaveLength(1);
        expect(s.extractAllBlocks(prose)).toHaveLength(1);
    });
    it('extracts duplicate tag occurrences (caller must dedupe)', () => {
        const prose = '⟦vle:cast-manifest {"schemaVersion":1,"cast":[]}⟧ then ⟦vle:cast-manifest {"schemaVersion":1,"cast":[]}⟧';
        const blocks = s.extractAllBlocks(prose);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].tag).toBe('cast-manifest');
        expect(blocks[1].tag).toBe('cast-manifest');
    });
});
