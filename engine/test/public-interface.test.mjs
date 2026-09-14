/**
 * Library interface checks.
 *
 * Every supported public symbol must be present with the expected runtime type.
 * The genre vocabulary and fallback profile must remain usable for saved works.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as engine from '../src/index.js';

// Symbol → expected `typeof engine[symbol]`. Every one of these must be a
// real, callable/usable export — not `undefined` — for the port to be
// considered wired end-to-end for T1.2's slice of the surface.
const EXPECTED_TYPES = {
    performChapterWriteBounded: 'function',
    performChapterRewriteBounded: 'function',
    performBookCreate: 'function',
    TextGenerator: 'function', // class
    createFoundation: 'function',
    registerCharacter: 'function',
    createGenreProfileRegistry: 'function',
    ENGINE_GENRES: 'object', // array
    reduceStoryState: 'function',
    emptyStoryState: 'function',
    DefaultOutputSanitizer: 'function', // class
    createProviderRegistry: 'function',
    FileStateStore: 'function', // class
    MemoryStateStore: 'function', // class
    normalizeCustomPromptOverride: 'function',
    renderCustomPromptOverride: 'function',
    evaluateChapterQuality: 'function',
    extractDelta: 'function',
    continuityCheck: 'function',
};

// Symbols deliberately excluded from the must-export contract above: the
// four LLM provider adapters (out of scope for this package — see
// provider selection contract) and the CLI entrypoint (not a library export
// at all in the source's index.ts).
const EXCLUDED = ['OpenAIAdapter', 'AnthropicAdapter', 'GoogleAdapter', 'XAIAdapter', 'CLI'];

describe('public-interface: src/index.js exports', () => {
    for (const [symbol, expectedType] of Object.entries(EXPECTED_TYPES)) {
        it(`exports \`${symbol}\` as a ${expectedType}`, () => {
            assert.ok(
                Object.prototype.hasOwnProperty.call(engine, symbol),
                `expected src/index.js to export \`${symbol}\``,
            );
            const value = engine[symbol];
            assert.notStrictEqual(value, undefined, `\`${symbol}\` is exported but undefined`);
            assert.strictEqual(
                typeof value,
                expectedType,
                `expected \`${symbol}\` to be typeof ${expectedType}, got ${typeof value}`,
            );
        });
    }

    it('does not rely on the excluded provider-adapter / CLI symbols to satisfy the contract', () => {
        // Sanity check that the exclude list and the must-export list are
        // disjoint — a future edit accidentally adding an adapter to
        // EXPECTED_TYPES above would defeat the point of excluding it.
        for (const symbol of EXCLUDED) {
            assert.ok(
                !Object.prototype.hasOwnProperty.call(EXPECTED_TYPES, symbol),
                `\`${symbol}\` is on the exclude list and must not also be in EXPECTED_TYPES`,
            );
        }
    });

    it('ENGINE_GENRES contains 25 unique supported genre identifiers', () => {
        assert.ok(Array.isArray(engine.ENGINE_GENRES));
        assert.strictEqual(engine.ENGINE_GENRES.length, 25);
        // No duplicates — each id registered exactly once.
        assert.strictEqual(new Set(engine.ENGINE_GENRES).size, 25);
    });

    it("createGenreProfileRegistry().get('other') resolves the fallback profile", () => {
        const registry = engine.createGenreProfileRegistry();
        const profile = registry.get('other');
        assert.strictEqual(profile.genre, 'other');
        assert.ok(Array.isArray(profile.trackedEntities));
        assert.ok(Array.isArray(profile.invariants));
    });

    it('registry resolves every ENGINE_GENRES id without throwing', () => {
        const registry = engine.createGenreProfileRegistry();
        for (const genre of engine.ENGINE_GENRES) {
            assert.doesNotThrow(() => registry.get(genre));
        }
    });
});
