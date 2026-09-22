import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { EMPTY_SCENE, renderEntityContext, resolveEntityContext, } from '../../src/core/entity-context.js';
function entity(overrides = {}) {
    return {
        entityId: 'e1',
        kind: 'location',
        canonicalName: '강남 게이트',
        aliases: [],
        status: 'active',
        attrs: { tier: 'S' },
        ...overrides,
    };
}
const noScene = { ...EMPTY_SCENE };
const someScene = {
    settings: ['e1'],
    characters: ['c1'],
    items: [],
    antagonists: ['e2'],
    additionalRefs: [],
};
describe('resolveEntityContext', () => {
    it('empty scene → empty injected', () => {
        const r = resolveEntityContext({ scene: noScene, snapshots: [entity()] });
        expect(r.injected).toEqual([]);
        expect(r.missingIds).toEqual([]);
    });
    it('match by entityId direct', () => {
        const r = resolveEntityContext({
            scene: someScene,
            snapshots: [entity(), entity({ entityId: 'e2', canonicalName: '모래뱀', kind: 'monster' })],
        });
        expect(r.injected.map((e) => e.entityId)).toEqual(['e1', 'e2']);
        expect(r.missingIds).toEqual(['c1']);
    });
    it('match by canonicalName fallback', () => {
        const r = resolveEntityContext({
            scene: { ...noScene, settings: ['강남 게이트'] },
            snapshots: [entity()],
        });
        expect(r.injected).toHaveLength(1);
        expect(r.injected[0].entityId).toBe('e1');
    });
    it('retired/destroyed entity excluded even if scene mentions it', () => {
        const r = resolveEntityContext({
            scene: { ...noScene, settings: ['e1'] },
            snapshots: [entity({ status: 'destroyed' })],
        });
        expect(r.injected).toEqual([]);
        expect(r.missingIds).toEqual([]); // entity exists, just filtered out
    });
    it('budget trims by stable order', () => {
        const big = { foo: 'x'.repeat(2000) }; // ~1000 tokens per entity
        const r = resolveEntityContext({
            scene: { ...noScene, settings: ['e1', 'e2', 'e3'] },
            snapshots: [
                entity({ entityId: 'e1', attrs: big }),
                entity({ entityId: 'e2', canonicalName: 'B', attrs: big }),
                entity({ entityId: 'e3', canonicalName: 'C', attrs: big }),
            ],
            tokenBudget: 1500,
        });
        expect(r.injected.length).toBeLessThan(3);
        expect(r.trimmedCount).toBeGreaterThan(0);
        // newest-first order preserved (first request first)
        expect(r.injected[0].entityId).toBe('e1');
    });
    it('deduplicates entity referenced in multiple scene buckets', () => {
        const r = resolveEntityContext({
            scene: {
                ...noScene,
                settings: ['e1'],
                characters: ['e1'],
                additionalRefs: ['강남 게이트'],
            },
            snapshots: [entity()],
        });
        expect(r.injected).toHaveLength(1);
    });
    it('unknown ref → missingIds', () => {
        const r = resolveEntityContext({
            scene: { ...noScene, characters: ['unknown-char'] },
            snapshots: [entity()],
        });
        expect(r.missingIds).toEqual(['unknown-char']);
        expect(r.injected).toEqual([]);
    });
});
describe('renderEntityContext', () => {
    it('empty → placeholder', () => {
        const r = resolveEntityContext({ scene: noScene, snapshots: [] });
        expect(renderEntityContext(r)).toMatch(/미지정/);
    });
    it('renders entities with kind / attrs / aliases', () => {
        const r = resolveEntityContext({
            scene: { ...noScene, settings: ['e1'] },
            snapshots: [entity({ aliases: ['G1'] })],
        });
        const text = renderEntityContext(r);
        expect(text).toMatch(/\[location\]/);
        expect(text).toMatch(/강남 게이트/);
        expect(text).toMatch(/aliases=\[G1\]/);
        expect(text).toMatch(/"tier":"S"/);
    });
    it('missingIds note appended', () => {
        const r = resolveEntityContext({
            scene: { ...noScene, characters: ['c-unknown'] },
            snapshots: [],
        });
        const text = renderEntityContext(r);
        expect(text).toMatch(/미등록.*c-unknown/);
    });
    it('trimmedCount note appended', () => {
        const r = {
            injected: [entity()],
            missingIds: [],
            trimmedCount: 3,
            estimatedTokens: 100,
            tokenBudget: 200,
        };
        expect(renderEntityContext(r)).toMatch(/3 개 생략/);
    });
});
