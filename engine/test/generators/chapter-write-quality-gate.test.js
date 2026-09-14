/**
 * ChapterWrite quality-gate opt-in wiring (NEP-W3 / W-D5, codex #10).
 *
 * Drives `performChapterWrite` with `ctx.qualityThreshold` set and a spy
 * ProviderRegistry that records every request (including `req.step`), so the
 * assertion surface is "was the coherence-judge LLM step actually invoked".
 *
 *   - coherence = <number>  → judge step IS called (prosody + coherence axes).
 *   - coherence = null      → judge step is SKIPPED entirely; the gate evaluates
 *                             prosody only (no extra LLM call, no coherence axis).
 *
 * The existing quality-gate.test.js (pure evaluateChapterQuality) is untouched.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '../_support/vitest-shim.mjs';
import { FileStateStore } from '../../src/core/state-store.js';
import { DefaultOutputSanitizer } from '../../src/core/output-sanitizer.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { performChapterWrite } from '../../src/generators/text/steps/chapter-write.js';

function noopLogger() {
    return { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
}
const registry = createGenreProfileRegistry();
function femaleChar(id, name) {
    return {
        id,
        canonicalName: name,
        aliases: [],
        registeredAtChapter: 1,
        intrinsic: { gender: 'female', ageBand: '20대초반', role: '주인공', coreAppearance: ['은발'] },
        mutable: { status: 'alive', knownFacts: [] },
        relationships: [],
    };
}
function makeFoundation() {
    return {
        workId: 'work-qg',
        genre: 'action',
        worldFacts: [],
        characters: [femaleChar('c1', '라이덴')],
        intrinsicChanges: [],
        genreProfile: registry.get('action'),
    };
}
// Spy registry — records every LLMRequest (so `step` is observable) and routes a
// scripted reply by the system-prompt keyword each step file uses.
function spyRegistry(replies = {}) {
    const calls = [];
    const reg = {
        register: () => undefined,
        has: () => true,
        async complete(req) {
            calls.push(req);
            const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
            let text = '{}';
            if (sys.includes('logical-coherence 평가자'))
                text = replies.coherence ?? '{"score":90,"reason":"ok"}';
            else if (sys.includes('회차 기획자'))
                text = replies.plan ?? '{"plan":"이번 회차는 평범했다."}';
            else if (sys.includes('한국어 웹소설 작가'))
                text = replies.draft ?? '';
            else if (sys.includes('연속성 분석기'))
                text = replies.extractDelta ?? '{}';
            else if (sys.includes('연속성 검수기'))
                text = replies.continuityCheck ?? '{}';
            return { text, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
        },
    };
    return { reg, calls };
}
async function makeCtx(rootDir, providers, qualityThreshold) {
    return {
        jobId: 'job-qg',
        workId: 'work-qg',
        kind: 'chapter-write',
        model: { provider: 'openai', modelId: 'mock-2026-05-20' },
        state: new FileStateStore(rootDir),
        providers,
        sanitizer: new DefaultOutputSanitizer(),
        log: noopLogger(),
        qualityThreshold,
    };
}
const GOOD_PROSE = '라이덴은 깊은 숨을 내쉬었다. 게이트 너머에서 익숙한 기운이 새어 나오고 있었다.\n' +
    '"드디어 시작이군." 그녀가 중얼거렸다.';
const GOOD_RAW = `${GOOD_PROSE}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧`;
const isJudge = (req) => req.step === 'coherence-judge';

describe('performChapterWrite — qualityThreshold opt-in gate (W-D5)', () => {
    let rootDir;
    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'vle-qg-'));
    });
    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true });
    });

    it('coherence = number → coherence-judge LLM step IS invoked (gate passes)', async () => {
        const { reg, calls } = spyRegistry({ draft: GOOD_RAW });
        const ctx = await makeCtx(rootDir, reg, { prosody: 0, coherence: 60 });
        await ctx.state.saveFoundation(makeFoundation());
        const { artifact } = await performChapterWrite(ctx, { chapterNumber: 1 });
        expect(artifact.chapterNumber).toBe(1);
        expect(calls.some(isJudge)).toBe(true);
    });

    it('coherence = null → coherence-judge step SKIPPED, prosody-only evaluation (chapter persists)', async () => {
        const { reg, calls } = spyRegistry({ draft: GOOD_RAW });
        const ctx = await makeCtx(rootDir, reg, { prosody: 0, coherence: null });
        await ctx.state.saveFoundation(makeFoundation());
        const { artifact } = await performChapterWrite(ctx, { chapterNumber: 1 });
        // Chapter still persists (prosody 0 threshold always passes) …
        expect(artifact.chapterNumber).toBe(1);
        expect(await ctx.state.loadArtifact('work-qg', 1)).not.toBeNull();
        // … but the coherence judge LLM call was never made.
        expect(calls.some(isJudge)).toBe(false);
    });

    it('no qualityThreshold → gate skipped entirely, no coherence-judge call', async () => {
        const { reg, calls } = spyRegistry({ draft: GOOD_RAW });
        const ctx = await makeCtx(rootDir, reg, undefined);
        await ctx.state.saveFoundation(makeFoundation());
        await performChapterWrite(ctx, { chapterNumber: 1 });
        expect(calls.some(isJudge)).toBe(false);
    });
});
