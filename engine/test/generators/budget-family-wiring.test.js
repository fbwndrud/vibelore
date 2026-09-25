/**
 * Wiring: chapter-write (draftPhase) and chapter-rewrite pass the work's
 * prompt family into resolveEntityContext / buildSlidingWindow. Dropping
 * `promptFamily` at those call sites would silently fall back to the legacy
 * flat / 2 estimate for an en work; these tests catch that through the
 * `used ~Nt` numbers in the prompt the provider actually receives.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '../_support/vitest-shim.mjs';
import { FileStateStore } from '../../src/core/state-store.js';
import { DefaultOutputSanitizer } from '../../src/core/output-sanitizer.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { draftPhase } from '../../src/generators/text/steps/chapter-write.js';
import { performChapterRewriteBounded } from '../../src/generators/text/chapter-rewrite-with-revise.js';
import { tokenUnits } from '../../src/core/token-units.js';

const registry = createGenreProfileRegistry();
const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const NOTE = 'The dagger amplifies fire magic and hums whenever the northern tower bell rings at dusk. '.repeat(6);
const DAGGER = { entityId: 'ent-dagger', kind: 'item', canonicalName: 'Ember Dagger', aliases: ['Ash Fang'], status: 'active', attrs: { property: NOTE } };
const SUMMARY = 'Seo-jun hid the Ember Dagger and followed the tide line to the old harbor gate before dawn. '.repeat(5);
const legacy = (text) => Math.ceil(text.length / 2);
const entityCost = (estimate) => estimate(DAGGER.canonicalName) + estimate(JSON.stringify(DAGGER.attrs)) + 8;

class EntityStore extends FileStateStore {
    async loadEntitySnapshots() { return [DAGGER]; }
}
function foundation(workId) {
    return {
        workId, genre: 'action', language: 'en', worldFacts: [], intrinsicChanges: [], genreProfile: registry.get('action'),
        characters: [{ id: 'c1', canonicalName: 'Seojun', aliases: [], registeredAtChapter: 1,
            intrinsic: { gender: 'male', ageBand: 'early twenties', role: 'lead', coreAppearance: [] },
            mutable: { status: 'alive', knownFacts: [] }, relationships: [] }],
    };
}
function recording(replies) {
    const calls = [];
    return { calls, providers: { register: () => undefined, has: () => true, async complete(req) {
        calls.push(req);
        return { text: replies[req.step] ?? '{}', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    } } };
}
const userOf = (call) => call?.messages.find((m) => m.role === 'user')?.content ?? '';

describe('engine call sites pass the prompt family to the context budgets', () => {
    let rootDir;
    beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'vle-budget-wiring-')); });
    afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

    it('draftPhase measures an en work with tokenUnits (entity and sliding window)', async () => {
        const { providers, calls } = recording({
            'chapter-plan': '{"plan":"Advance.","scene":{"settings":[],"characters":[],"items":["ent-dagger"],"antagonists":[],"additionalRefs":[]},"tension":{}}',
            draft: 'Body.\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧',
        });
        const state = new EntityStore(rootDir);
        await state.saveFoundation(foundation('w-draft'));
        await state.saveChapterSummary({ workId: 'w-draft', chapterNumber: 1, summary: SUMMARY, sceneTags: [], plotBeat: null });
        await draftPhase({ jobId: 'j', workId: 'w-draft', kind: 'chapter-write', model: { provider: 'openai', modelId: 'mock' },
            state, providers, sanitizer: new DefaultOutputSanitizer(), log }, { chapterNumber: 2 });
        const user = userOf(calls.find((c) => c.step === 'draft'));
        expect(tokenUnits(SUMMARY)).toBeLessThan(legacy(SUMMARY));
        expect(user).toContain(`## Entities on stage this chapter (1, budget 2000t, used ~${entityCost(tokenUnits)}t)`);
        expect(user).toContain(`used ~${tokenUnits(SUMMARY) + 8}t)`);
        expect(user).not.toContain(`used ~${entityCost(legacy)}t`);
    });

    it('chapter-rewrite measures an en work with tokenUnits', async () => {
        const { providers, calls } = recording({ rewrite: 'Rewritten.\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧' });
        const state = new EntityStore(rootDir);
        await state.saveFoundation(foundation('w-rewrite'));
        // Only the rewrite prompt matters here; publication afterwards needs a
        // trusted validation identity this unit fixture does not provide.
        await performChapterRewriteBounded({ jobId: 'j', workId: 'w-rewrite', kind: 'chapter-rewrite', model: { provider: 'openai', modelId: 'mock' },
            state, providers, sanitizer: new DefaultOutputSanitizer(), log }, { chapterNumber: 1, previousProse: 'Seojun sharpened the Ember Dagger.', intentSummary: 'Raise tension.' }).catch(() => undefined);
        const user = userOf(calls.find((c) => c.step === 'rewrite'));
        expect(user).toContain(`used ~${entityCost(tokenUnits)}t)`);
        expect(user).not.toContain(`used ~${entityCost(legacy)}t`);
    });
});
