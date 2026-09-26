/**
 * Extract and check requests take the plugin's text renders instead of JSON
 * dumps. The cast list is text with the work's influence dimension ids.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { DefaultHonorificLexicon } from '../../src/continuity/honorific-lexicon.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { continuityCheck, extractDelta } from '../../src/continuity/continuity-check.js';
import { createProviderRegistry } from '../../src/core/provider-registry.js';
const registry = createGenreProfileRegistry();
const foundation = {
    workId: 'w', genre: 'action', worldFacts: [{ id: 'f1', statement: 'JSON_WORLD_FACT' }], intrinsicChanges: [],
    genreProfile: registry.get('action'),
    characters: [{ id: 'c1', canonicalName: '리아', aliases: ['꼬마'], registeredAtChapter: 1,
        intrinsic: { gender: 'female', ageBand: '20대', role: '주인공' },
        mutable: { status: 'alive', knownFacts: [], location: 'DESIGN_TIME_LOCATION' },
        dramaticModel: { dimensionBaselines: { selfReliance: 2, trustInOthers: 0 } }, relationships: [] }],
};
function capture() {
    const calls = [];
    return { calls, providers: createProviderRegistry([{ provider: 'openai', async complete(req) { calls.push(req); return { text: '{}', usage: {} }; } }]) };
}
const MODEL = { provider: 'openai', modelId: 'm' };
const manifest = JSON.stringify({ cast: [{ characterId: 'c1', addressTermsUsed: ['도윤아'] }] });
describe('text sections in extract and check', () => {
    it('extract uses the state render and lists the cast as text with dimension ids', async () => {
        const { calls, providers } = capture();
        await extractDelta({ prose: '리아가 섰다.', castManifestRaw: manifest, chapterNumber: 2, foundation, prevState: emptyStoryState('w'),
            providers, model: MODEL, prevStateRender: '## 현재 상태\n- TEXT_STATE' });
        const user = calls[0].messages.find((m) => m.role === 'user').content;
        const input = user.slice(0, user.indexOf('## 본문'));
        expect(input).toContain('TEXT_STATE');
        expect(input).toContain('리아 (c1)');
        expect(input).toContain('꼬마');
        expect(input).toContain('도윤아');
        expect(input).toContain('selfReliance');
        expect(input).not.toMatch(/[{}\[\]]/);
    });
    it('check uses the supplied section renders instead of JSON', async () => {
        const { calls, providers } = capture();
        await continuityCheck({ prose: '리아가 섰다.', chapterNumber: 2,
            delta: { chapterNumber: 2, appearedCharacterIds: ['c1'], newAddressEntries: [], relationshipOps: [], hookChanges: [], mutableChanges: [], trackedEntityOps: [] },
            prevState: emptyStoryState('w'), foundation, lexicon: new DefaultHonorificLexicon([]), providers, model: MODEL,
            checkSections: { prev: 'TEXT_PREV', foundation: 'TEXT_FOUNDATION', delta: 'TEXT_DELTA', invariants: 'TEXT_INVARIANTS' } });
        const user = calls[0].messages.find((m) => m.role === 'user').content;
        for (const token of ['TEXT_PREV', 'TEXT_FOUNDATION', 'TEXT_DELTA', 'TEXT_INVARIANTS']) expect(user).toContain(token);
        expect(user).not.toContain('JSON_WORLD_FACT');
        expect(user).not.toContain('DESIGN_TIME_LOCATION');
    });
});
