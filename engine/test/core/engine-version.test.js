import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { ENGINE_VERSION, collectPromptManifest, collectPromptManifestWithHash, computePromptManifestHash, } from '../../src/core/engine-version.js';
describe('ENGINE_VERSION', () => {
    it('is a non-empty kebab-case string', () => {
        expect(ENGINE_VERSION).toMatch(/^[a-z0-9][a-z0-9-]*$/);
        expect(ENGINE_VERSION.length).toBeGreaterThan(0);
    });
});
describe('collectPromptManifest', () => {
    it('returns version + all 7 prompts (worldbuild/castDesign/chapterPlan/draft/revise/continuityExtract/continuityCheck)', () => {
        const m = collectPromptManifest();
        expect(m.version).toBe(ENGINE_VERSION);
        expect(Object.keys(m.prompts).sort()).toEqual([
            'castDesign',
            'chapterPlan',
            'continuityCheck',
            'continuityExtract',
            'draft',
            'revise',
            'worldbuild',
        ]);
        for (const v of Object.values(m.prompts)) {
            expect(typeof v).toBe('string');
            expect(v.length).toBeGreaterThan(0);
        }
    });
    it('is deterministic across calls (no module-local state mutation)', () => {
        const a = collectPromptManifest();
        const b = collectPromptManifest();
        expect(a).toEqual(b);
    });
});
describe('computePromptManifestHash', () => {
    it('produces a 64-char hex sha256', () => {
        const h = computePromptManifestHash(collectPromptManifest());
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
    it('is stable for the same input', () => {
        const m = collectPromptManifest();
        expect(computePromptManifestHash(m)).toBe(computePromptManifestHash(m));
    });
    it('key ordering does not affect hash (canonical sort)', () => {
        const m1 = {
            version: 'x',
            prompts: { b: 'b-text', a: 'a-text' },
        };
        const m2 = {
            version: 'x',
            prompts: { a: 'a-text', b: 'b-text' },
        };
        expect(computePromptManifestHash(m1)).toBe(computePromptManifestHash(m2));
    });
    it('value change → hash change', () => {
        const m1 = collectPromptManifest();
        const m2 = { version: m1.version, prompts: { ...m1.prompts, draft: 'changed!' } };
        expect(computePromptManifestHash(m1)).not.toBe(computePromptManifestHash(m2));
    });
    it('version change → hash change', () => {
        const m = collectPromptManifest();
        const m2 = { ...m, version: m.version + '-x' };
        expect(computePromptManifestHash(m)).not.toBe(computePromptManifestHash(m2));
    });
});
describe('collectPromptManifestWithHash', () => {
    it('returns matching version, prompts, and hash', () => {
        const m = collectPromptManifestWithHash();
        expect(m.version).toBe(ENGINE_VERSION);
        expect(m.hash).toBe(computePromptManifestHash({ version: m.version, prompts: m.prompts }));
    });
});
