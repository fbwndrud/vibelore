/**
 * Tests for the BookCreate composer (T3.2).
 *
 * Mocks the ProviderRegistry so we can drive worldbuild + castDesign LLM
 * responses deterministically and observe how the composed function wires
 * them into a Foundation.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { performBookCreate } from '../../src/generators/text/steps/worldbuild.js';
function noopLogger() {
    return {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
    };
}
/**
 * Build a ProviderRegistry that returns scripted responses in order. The first
 * call hits worldbuild; the second hits castDesign. The script is matched by
 * call index so we don't have to inspect the prompt text.
 */
function scriptedRegistry(responses) {
    let i = 0;
    const reg = {
        register: () => undefined,
        has: () => true,
        async complete(_req) {
            if (i >= responses.length) {
                throw new Error(`scriptedRegistry: out of responses at call ${i}`);
            }
            const text = responses[i];
            i += 1;
            return {
                text,
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            };
        },
    };
    return reg;
}
function makeCtx(providers, workId = 'work-bc-1') {
    return {
        jobId: 'job-bc-test',
        workId,
        kind: 'book-create',
        model: { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' },
        providers,
        log: noopLogger(),
    };
}
const BASE_INPUT = {
    title: '강철의 회귀자',
    genre: 'regression-hunter',
    brief: '20년 후 미래에서 회귀한 헌터의 복수극.',
    language: 'ko',
    targetChapters: 50,
    chapterWordCount: 4000,
};
const GOOD_WORLDBUILD = JSON.stringify({
    premise: '20년 뒤 인류 멸망 직전에서 회귀한 헌터가 복수와 구원을 동시에 노린다.',
    worldFacts: [
        { id: 'wf1', statement: '게이트가 처음 열린 시점은 작품 시작 10년 전이다.' },
        { id: 'wf2', statement: '헌터의 능력은 각성 시점에 결정되며 후천적 변경은 불가능하다.' },
        { id: 'wf3', statement: '한반도 게이트는 전 세계에서 가장 위험한 등급으로 분류된다.' },
        { id: 'wf4', statement: '회귀는 단 1회만 가능하다.' },
        { id: 'wf5', statement: '국가 헌터 길드는 정부 산하 조직이다.' },
    ],
});
const GOOD_CAST = JSON.stringify({
    characters: [
        {
            id: 'c1',
            canonicalName: '서준',
            aliases: ['옛 강철왕'],
            registeredAtChapter: 1,
            intrinsic: {
                gender: 'male',
                ageBand: '20대초반',
                birthOrder: '장남',
                role: '주인공',
                coreAppearance: ['검은 머리', '왼쪽 뺨 흉터'],
                visualHints: {
                    hair: '검은 단발, 옆머리 살짝 묶음',
                    eyes: '회색, 날카로운 눈매',
                    build: '180cm, 군살 없는 체형',
                    attire: '검은 가죽 코트, 회색 셔츠',
                    distinguishing: ['왼쪽 뺨 사선 흉터'],
                    vibe: '냉정한 회귀자',
                },
            },
            mutable: { status: 'alive', location: '서울', knownFacts: ['회귀 사실'] },
            relationships: [{ to: 'c2', kind: '라이벌', state: '미해결갈등' }],
        },
        {
            id: 'c2',
            canonicalName: '강수아',
            aliases: [],
            registeredAtChapter: 1,
            intrinsic: {
                gender: 'female',
                ageBand: '20대초반',
                role: '조연',
                coreAppearance: ['붉은 머리'],
            },
            mutable: { status: 'alive', knownFacts: [] },
            relationships: [],
        },
        {
            id: 'c3',
            canonicalName: '이태형',
            aliases: [],
            registeredAtChapter: 1,
            intrinsic: {
                gender: 'male',
                ageBand: '40대중반',
                role: '적대자',
                coreAppearance: ['금발'],
            },
            mutable: { status: 'alive', knownFacts: [] },
            relationships: [],
        },
    ],
});
describe('performBookCreate', () => {
    it('successful flow produces Foundation with genre bound + worldFacts + characters', async () => {
        const providers = scriptedRegistry([GOOD_WORLDBUILD, GOOD_CAST]);
        const ctx = makeCtx(providers);
        const { foundation } = await performBookCreate(ctx, BASE_INPUT);
        expect(foundation.workId).toBe('work-bc-1');
        expect(foundation.genre).toBe('regression-hunter');
        expect(foundation.worldFacts).toHaveLength(5);
        expect(foundation.worldFacts[0]?.id).toBe('wf1');
        expect(foundation.worldFacts[0]?.registeredAtChapter).toBe(1);
        expect(foundation.characters).toHaveLength(3);
        expect(foundation.characters[0]?.canonicalName).toBe('서준');
        expect(foundation.characters[0]?.intrinsic.gender).toBe('male');
        // #56 — visualHints emit. c1 (서준) has visualHints set.
        expect(foundation.characters[0]?.intrinsic.visualHints).toEqual({
            hair: '검은 단발, 옆머리 살짝 묶음',
            eyes: '회색, 날카로운 눈매',
            build: '180cm, 군살 없는 체형',
            attire: '검은 가죽 코트, 회색 셔츠',
            distinguishing: ['왼쪽 뺨 사선 흉터'],
            vibe: '냉정한 회귀자',
        });
        // c2/c3 don't have visualHints in the script → fallback path (undefined).
        expect(foundation.characters[1]?.intrinsic.visualHints).toBeUndefined();
        expect(foundation.characters[2]?.intrinsic.visualHints).toBeUndefined();
        // regression-hunter is in REGRESSION_FAMILY → Timeline + RegressionKnowledge entities
        const trackedKinds = foundation.genreProfile.trackedEntities.map((t) => t.kind);
        expect(trackedKinds).toContain('Timeline');
        expect(trackedKinds).toContain('RegressionKnowledge');
    });
    it('throws on unsupported genre — does NOT spend any LLM call', async () => {
        let calls = 0;
        const providers = {
            register: () => undefined,
            has: () => true,
            async complete() {
                calls += 1;
                return { text: '{}', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
            },
        };
        const ctx = makeCtx(providers);
        await expect(performBookCreate(ctx, { ...BASE_INPUT, genre: 'not-a-real-genre' })).rejects.toThrow(/unsupported genre: not-a-real-genre/);
        expect(calls).toBe(0);
    });
    it('LLM returns malformed JSON for worldbuild → throws "worldbuild parse failed"', async () => {
        const providers = scriptedRegistry(['this is not json {{{']);
        const ctx = makeCtx(providers);
        await expect(performBookCreate(ctx, BASE_INPUT)).rejects.toThrow(/worldbuild parse failed/);
    });
    it('LLM returns malformed JSON for castDesign → throws "castDesign parse failed"', async () => {
        const providers = scriptedRegistry([GOOD_WORLDBUILD, 'nope nope nope']);
        const ctx = makeCtx(providers);
        await expect(performBookCreate(ctx, BASE_INPUT)).rejects.toThrow(/castDesign parse failed/);
    });
    it('castDesign returns 0 characters → still produces Foundation (append-only allows later registration)', async () => {
        const providers = scriptedRegistry([
            GOOD_WORLDBUILD,
            JSON.stringify({ characters: [] }),
        ]);
        const ctx = makeCtx(providers);
        const { foundation } = await performBookCreate(ctx, BASE_INPUT);
        expect(foundation.characters).toHaveLength(0);
        expect(foundation.worldFacts).toHaveLength(5);
    });
    it('duplicate character id from LLM → second one renamed (no throw)', async () => {
        const dupCast = JSON.stringify({
            characters: [
                {
                    id: 'c1',
                    canonicalName: '서준',
                    aliases: [],
                    registeredAtChapter: 1,
                    intrinsic: { gender: 'male', ageBand: '20대초반', role: '주인공', coreAppearance: [] },
                    mutable: { status: 'alive', knownFacts: [] },
                    relationships: [],
                },
                {
                    id: 'c1',
                    canonicalName: '서준의 사촌',
                    aliases: [],
                    registeredAtChapter: 1,
                    intrinsic: { gender: 'male', ageBand: '20대중반', role: '조연', coreAppearance: [] },
                    mutable: { status: 'alive', knownFacts: [] },
                    relationships: [],
                },
            ],
        });
        const providers = scriptedRegistry([GOOD_WORLDBUILD, dupCast]);
        const ctx = makeCtx(providers);
        const { foundation } = await performBookCreate(ctx, BASE_INPUT);
        expect(foundation.characters).toHaveLength(2);
        const ids = foundation.characters.map((c) => c.id);
        expect(new Set(ids).size).toBe(2);
        expect(ids[0]).toBe('c1');
        expect(ids[1]).toMatch(/^c1-\d+$/);
    });
    it('worldFact id missing → auto-id (wf1, wf2, …)', async () => {
        const facts = JSON.stringify({
            premise: '전제 한 줄.',
            worldFacts: [
                { statement: '첫 번째 사실 — id 누락.' },
                { id: 'wf2', statement: '명시 id wf2.' },
                { statement: '세 번째 사실 — id 누락.' },
            ],
        });
        const providers = scriptedRegistry([
            facts,
            JSON.stringify({ characters: [] }),
        ]);
        const ctx = makeCtx(providers);
        const { foundation } = await performBookCreate(ctx, BASE_INPUT);
        const ids = foundation.worldFacts.map((wf) => wf.id);
        expect(ids).toHaveLength(3);
        expect(new Set(ids).size).toBe(3); // all unique
        expect(ids).toContain('wf2'); // explicit one preserved
        for (const id of ids)
            expect(id).toMatch(/^wf\d+$/);
    });
    it('character with missing intrinsic.gender → defaults to explicit "unknown"', async () => {
        const cast = JSON.stringify({
            characters: [
                {
                    id: 'c1',
                    canonicalName: '미정 인물',
                    aliases: [],
                    registeredAtChapter: 1,
                    intrinsic: { ageBand: '10대후반', role: '조연', coreAppearance: [] },
                    mutable: { status: 'alive', knownFacts: [] },
                    relationships: [],
                },
            ],
        });
        const providers = scriptedRegistry([GOOD_WORLDBUILD, cast]);
        const ctx = makeCtx(providers);
        const { foundation } = await performBookCreate(ctx, BASE_INPUT);
        expect(foundation.characters).toHaveLength(1);
        expect(foundation.characters[0]?.intrinsic.gender).toBe('unknown');
    });
    it('character with missing canonicalName is skipped (LLM provides 2, only 1 usable)', async () => {
        const cast = JSON.stringify({
            characters: [
                {
                    id: 'c1',
                    canonicalName: '쓸만한 인물',
                    aliases: [],
                    registeredAtChapter: 1,
                    intrinsic: { gender: 'male', ageBand: '20대초반', role: '주인공', coreAppearance: [] },
                    mutable: { status: 'alive', knownFacts: [] },
                    relationships: [],
                },
                {
                    id: 'c2',
                    canonicalName: '',
                    aliases: [],
                    registeredAtChapter: 1,
                    intrinsic: { gender: 'female', ageBand: '20대초반', role: '조연', coreAppearance: [] },
                    mutable: { status: 'alive', knownFacts: [] },
                    relationships: [],
                },
            ],
        });
        const providers = scriptedRegistry([GOOD_WORLDBUILD, cast]);
        const ctx = makeCtx(providers);
        const { foundation } = await performBookCreate(ctx, BASE_INPUT);
        expect(foundation.characters).toHaveLength(1);
        expect(foundation.characters[0]?.canonicalName).toBe('쓸만한 인물');
    });
});
