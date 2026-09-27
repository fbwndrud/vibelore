/**
 * The plugin renders characters, world facts and the carried state as text.
 * When those renders are supplied, the draft prompt uses them instead of the
 * JSON dumps; without them the legacy JSON sections stay.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { runDraft } from '../../src/generators/text/steps/draft.js';
const registry = createGenreProfileRegistry();
const foundation = {
    workId: 'w', genre: 'action', worldFacts: [{ id: 'f1', statement: 'JSON_WORLD_FACT' }], intrinsicChanges: [],
    genreProfile: registry.get('action'),
    characters: [{ id: 'c1', canonicalName: '리아', aliases: [], registeredAtChapter: 1,
        intrinsic: { gender: 'female', ageBand: '20대', role: '주인공', coreAppearance: [] },
        mutable: { status: 'alive', knownFacts: [], location: 'DESIGN_TIME_LOCATION' }, relationships: [] }],
};
function capture() {
    const requests = [];
    return { requests, provider: { async complete(req) { requests.push(req); return { text: '본문.\n\n⟦vle:cast-manifest {"cast":[]}⟧', usage: {}, model: req.model }; } } };
}
describe('runDraft — text sections', () => {
    it('uses the supplied text renders instead of Foundation and state JSON', async () => {
        const { provider, requests } = capture();
        await runDraft({ foundation, prevState: emptyStoryState('w'), chapterNumber: 2, plan: '기획', providers: provider,
            model: { provider: 'openai', modelId: 'm' },
            foundationRender: '## 세계 사실\n- TEXT_WORLD_FACT', stateRender: '## 현재 상태\n- TEXT_STATE' });
        const user = requests[0].messages.find((m) => m.role === 'user').content;
        expect(user).toContain('TEXT_WORLD_FACT');
        expect(user).toContain('TEXT_STATE');
        expect(user).not.toContain('JSON_WORLD_FACT');
        expect(user).not.toContain('DESIGN_TIME_LOCATION');
        expect(user).not.toContain('"addressMap"');
    });
    it('keeps the JSON sections when no render is supplied', async () => {
        const { provider, requests } = capture();
        await runDraft({ foundation, prevState: emptyStoryState('w'), chapterNumber: 2, plan: '기획', providers: provider,
            model: { provider: 'openai', modelId: 'm' } });
        const user = requests[0].messages.find((m) => m.role === 'user').content;
        expect(user).toContain('JSON_WORLD_FACT');
    });
    it('the JSON state shows the latest ledger records and only open hooks', async () => {
        const { provider, requests } = capture();
        const records = Array.from({ length: 14 }, (_, i) => ({ id: `o${i + 1}`, feature: 'objects', label: '물건', name: `RECORD_${i + 1}_`, aliases: [], status: 'active', fields: {}, registeredAt: 1, lastEventAt: i + 1, recent: [] }));
        const prevState = { ...emptyStoryState('w'), chapterNumber: 14, ledger: { records },
            hooks: [{ id: 'h1', text: 'OPEN_HOOK', status: 'open' }, { id: 'h2', text: 'PAID_HOOK', phase: 'paid' }] };
        await runDraft({ foundation, prevState, chapterNumber: 15, plan: '기획', providers: provider, model: { provider: 'openai', modelId: 'm' } });
        const user = requests[0].messages.find((m) => m.role === 'user').content;
        expect(user).toContain('RECORD_14_');
        expect(user).toContain('RECORD_3_');
        expect(user).not.toContain('RECORD_2_');
        expect(user).toContain('OPEN_HOOK');
        expect(user).not.toContain('PAID_HOOK');
        expect(user).not.toContain('"trackedEntities"');
    });
});
