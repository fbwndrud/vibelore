/**
 * Tests for reviseFoundation (rewrite-revise-worklock.plan Item 2).
 *
 * Mocks the ProviderRegistry so we drive the revise LLM response
 * deterministically and assert the append-only fold:
 *   - worldFacts replaced
 *   - existing character role/description updated, identity anchors preserved
 *   - new characters added
 *   - character removal request IGNORED (existing cast never shrinks)
 *   - genre / genreProfile / intrinsicChanges carried forward
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createFoundation, registerCharacter, resolveCharacter, } from '../../src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { reviseFoundation } from '../../src/generators/foundation/revise-foundation.js';
const registry = createGenreProfileRegistry();
function scriptedRegistry(responses) {
    const requests = [];
    let i = 0;
    const reg = {
        register: () => undefined,
        has: () => true,
        async complete(req) {
            requests.push(req);
            if (i >= responses.length) {
                throw new Error(`scriptedRegistry: out of responses at call ${i}`);
            }
            const text = responses[i];
            i += 1;
            return { text, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } };
        },
    };
    return { reg, requests };
}
function recordingLogger() {
    const infos = [];
    const log = {
        info: (msg, meta) => {
            infos.push({ msg, meta });
        },
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
    };
    return { log, infos };
}
const makeChar = (overrides = {}) => ({
    id: 'c1',
    canonicalName: '서준',
    aliases: ['강철왕'],
    registeredAtChapter: 1,
    intrinsic: {
        gender: 'male',
        ageBand: '20대초반',
        role: '주인공',
        coreAppearance: ['검은 머리'],
    },
    mutable: { status: 'alive', knownFacts: [] },
    relationships: [],
    contradiction: '냉정하지만 속에 분노가 끓는다',
    ...overrides,
});
function makeCurrent(characters = [makeChar()]) {
    let f = createFoundation({
        workId: 'work-revise-1',
        genre: 'regression-hunter',
        genreProfile: registry.get('regression-hunter'),
        povMode: 'limited-third',
    });
    f = {
        ...f,
        worldFacts: [
            { id: 'wf1', statement: '게이트는 10년 전 처음 열렸다.', registeredAtChapter: 1 },
            { id: 'wf2', statement: '회귀는 단 1회만 가능하다.', registeredAtChapter: 1 },
        ],
    };
    for (const c of characters)
        f = registerCharacter(f, c);
    return f;
}
const baseModel = { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' };
describe('reviseFoundation', () => {
    it('replaces worldFacts + adds a new character + preserves the existing one', async () => {
        const current = makeCurrent();
        const patch = JSON.stringify({
            worldFacts: [
                { id: 'wf1', statement: '게이트는 20년 전 처음 열렸다.' },
                { id: 'wf2', statement: '회귀는 단 1회만 가능하다.' },
                { id: 'wf3', statement: '국가 헌터 길드가 게이트를 관리한다.' },
            ],
            updatedCharacters: [],
            newCharacters: [
                {
                    id: 'c2',
                    canonicalName: '강수아',
                    aliases: [],
                    intrinsic: {
                        gender: 'female',
                        ageBand: '20대초반',
                        role: '조연',
                        coreAppearance: ['붉은 머리'],
                    },
                    mutable: { status: 'alive', knownFacts: [] },
                    relationships: [],
                    contradiction: '냉소적이지만 동료를 위해 희생한다',
                },
            ],
        });
        const { reg } = scriptedRegistry([patch]);
        const { foundation } = await reviseFoundation({
            current,
            feedback: '주인공의 라이벌을 한 명 추가하고 게이트 역사를 20년으로 늘려줘',
            providers: reg,
            model: baseModel,
        });
        // worldFacts replaced
        expect(foundation.worldFacts).toHaveLength(3);
        expect(foundation.worldFacts[0]?.statement).toContain('20년 전');
        expect(foundation.worldFacts.map((w) => w.id)).toContain('wf3');
        // existing character preserved
        const c1 = foundation.characters.find((c) => c.id === 'c1');
        expect(c1).toBeDefined();
        expect(c1?.canonicalName).toBe('서준');
        // new character added
        const c2 = foundation.characters.find((c) => c.id === 'c2');
        expect(c2).toBeDefined();
        expect(c2?.canonicalName).toBe('강수아');
        expect(c2?.intrinsic.gender).toBe('female');
        expect(foundation.characters).toHaveLength(2);
        // genre + profile carried forward
        expect(foundation.genre).toBe('regression-hunter');
        expect(foundation.genreProfile.genre).toBe('regression-hunter');
        expect(foundation.povMode).toBe('limited-third');
        expect(foundation.workId).toBe('work-revise-1');
    });
    it('records role/coreAppearance edits as IntrinsicChangeEvents (NEVER overwrites pinned base) + edits non-intrinsic fields directly', async () => {
        const current = makeCurrent();
        const patch = JSON.stringify({
            worldFacts: [{ id: 'wf1', statement: '게이트는 10년 전 처음 열렸다.' }],
            updatedCharacters: [
                {
                    // attempt to change identity anchors — must be IGNORED
                    id: 'c1',
                    canonicalName: '다른이름',
                    intrinsic: { gender: 'female', ageBand: '50대' },
                    // intrinsic edits — must flow through the intrinsicChanges log, NOT base
                    role: '적대자',
                    coreAppearance: ['은발', '왼쪽 뺨 흉터'],
                    // non-intrinsic edits — applied directly
                    aliases: ['배신자'],
                    contradiction: '복수를 원하지만 옛 동료를 차마 죽이지 못한다',
                },
            ],
            newCharacters: [],
        });
        const { reg } = scriptedRegistry([patch]);
        const { foundation } = await reviseFoundation({
            current,
            feedback: '서준을 적대자로 바꿔줘',
            providers: reg,
            model: baseModel,
        });
        const c1 = foundation.characters.find((c) => c.id === 'c1');
        // identity anchors pinned
        expect(c1.canonicalName).toBe('서준');
        expect(c1.intrinsic.gender).toBe('male');
        expect(c1.intrinsic.ageBand).toBe('20대초반');
        expect(c1.registeredAtChapter).toBe(1);
        // DATA-INTEGRITY: base intrinsic is UNCHANGED — role/coreAppearance edits are
        // NOT written onto the pinned base (effectiveIntrinsic would throw otherwise).
        expect(c1.intrinsic.role).toBe('주인공');
        expect(c1.intrinsic.coreAppearance).toEqual(['검은 머리']);
        // the edits are recorded as legal IntrinsicChangeEvents (from=base → to=new).
        const roleEvent = foundation.intrinsicChanges.find((e) => e.characterId === 'c1' && e.field === 'role');
        expect(roleEvent).toBeDefined();
        expect(roleEvent?.from).toBe('주인공');
        expect(roleEvent?.to).toBe('적대자');
        expect((roleEvent?.narrativeCause ?? '').length).toBeGreaterThan(0);
        const appearanceEvent = foundation.intrinsicChanges.find((e) => e.characterId === 'c1' && e.field === 'coreAppearance');
        expect(appearanceEvent?.from).toEqual(['검은 머리']);
        expect(appearanceEvent?.to).toEqual(['은발', '왼쪽 뺨 흉터']);
        // the EFFECTIVE intrinsic (what chapter generation reads via resolveCharacter)
        // reflects the change AND does not throw the data-integrity guard.
        const resolved = resolveCharacter(foundation, 1, 'c1');
        expect(resolved.intrinsic.role).toBe('적대자');
        expect(resolved.intrinsic.coreAppearance).toEqual(['은발', '왼쪽 뺨 흉터']);
        // non-intrinsic fields applied directly
        expect(c1.aliases).toEqual(['배신자']);
        expect(c1.contradiction).toBe('복수를 원하지만 옛 동료를 차마 죽이지 못한다');
    });
    it('IGNORES a character removal request — existing cast never shrinks', async () => {
        const current = makeCurrent([
            makeChar(),
            makeChar({ id: 'c2', canonicalName: '강수아', aliases: [] }),
        ]);
        // LLM omits c2 entirely (a removal attempt) and adds nothing.
        const patch = JSON.stringify({
            worldFacts: [{ id: 'wf1', statement: '게이트는 10년 전 처음 열렸다.' }],
            updatedCharacters: [{ id: 'c1', role: '주인공' }],
            newCharacters: [],
        });
        const { reg } = scriptedRegistry([patch]);
        const { log, infos } = recordingLogger();
        const { foundation } = await reviseFoundation({
            current,
            feedback: '강수아를 빼줘',
            providers: reg,
            model: baseModel,
            log,
        });
        // both characters still present — removal ignored
        expect(foundation.characters.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
        // the unmentioned (would-be-removed) id is logged
        const kept = infos.find((i) => i.msg === 'revise-foundation:characters_kept_unmentioned');
        expect(kept).toBeDefined();
        expect(kept.meta.keptIds).toContain('c2');
    });
    it('carries intrinsicChanges history forward unchanged', async () => {
        let current = makeCurrent();
        current = {
            ...current,
            intrinsicChanges: [
                {
                    characterId: 'c1',
                    atChapter: 5,
                    field: 'role',
                    from: '주인공',
                    to: '각성자',
                    narrativeCause: '봉인 해제',
                },
            ],
        };
        const patch = JSON.stringify({
            worldFacts: [{ id: 'wf1', statement: '바뀐 사실.' }],
            updatedCharacters: [],
            newCharacters: [],
        });
        const { reg } = scriptedRegistry([patch]);
        const { foundation } = await reviseFoundation({
            current,
            feedback: '세계관 한 줄만 바꿔줘',
            providers: reg,
            model: baseModel,
        });
        expect(foundation.intrinsicChanges).toHaveLength(1);
        expect(foundation.intrinsicChanges[0]?.narrativeCause).toBe('봉인 해제');
    });
    it('EMPTY-ARRAY WIPE guard: [] coreAppearance/aliases never blanks existing values', async () => {
        const current = makeCurrent();
        const patch = JSON.stringify({
            worldFacts: [{ id: 'wf1', statement: '사실.' }],
            updatedCharacters: [
                // role given but coreAppearance + aliases sent as [] — must NOT wipe.
                { id: 'c1', role: '조연', coreAppearance: [], aliases: [] },
            ],
            newCharacters: [],
        });
        const { reg } = scriptedRegistry([patch]);
        const { foundation } = await reviseFoundation({
            current,
            feedback: '역할만 바꿔줘',
            providers: reg,
            model: baseModel,
        });
        const c1 = foundation.characters.find((c) => c.id === 'c1');
        // existing values retained — empty arrays are no-ops
        expect(c1.intrinsic.coreAppearance).toEqual(['검은 머리']);
        expect(c1.aliases).toEqual(['강철왕']);
        // no coreAppearance event was logged (empty patch ignored)
        expect(foundation.intrinsicChanges.some((e) => e.field === 'coreAppearance')).toBe(false);
        // role change WAS logged (effective value updated, base untouched)
        expect(c1.intrinsic.role).toBe('주인공');
        const resolved = resolveCharacter(foundation, 1, 'c1');
        expect(resolved.intrinsic.role).toBe('조연');
    });
    it("edits the 'mutable' layer (status/location/knownFacts) the prompt promises", async () => {
        const current = makeCurrent([
            makeChar({ mutable: { status: 'alive', knownFacts: ['초기사실'] } }),
        ]);
        const patch = JSON.stringify({
            worldFacts: [{ id: 'wf1', statement: '사실.' }],
            updatedCharacters: [
                {
                    id: 'c1',
                    mutable: { status: 'missing', location: '북부 성채', knownFacts: ['새 사실'] },
                },
            ],
            newCharacters: [],
        });
        const { reg } = scriptedRegistry([patch]);
        const { foundation } = await reviseFoundation({
            current,
            feedback: '서준을 실종 상태로',
            providers: reg,
            model: baseModel,
        });
        const c1 = foundation.characters.find((c) => c.id === 'c1');
        expect(c1.mutable.status).toBe('missing');
        expect(c1.mutable.location).toBe('북부 성채');
        expect(c1.mutable.knownFacts).toEqual(['새 사실']);
    });
    it('mutable knownFacts [] is a no-op (never blanks existing facts)', async () => {
        const current = makeCurrent([
            makeChar({ mutable: { status: 'alive', knownFacts: ['지켜야 할 사실'] } }),
        ]);
        const patch = JSON.stringify({
            worldFacts: [{ id: 'wf1', statement: '사실.' }],
            updatedCharacters: [{ id: 'c1', mutable: { status: 'dead', knownFacts: [] } }],
            newCharacters: [],
        });
        const { reg } = scriptedRegistry([patch]);
        const { foundation } = await reviseFoundation({
            current,
            feedback: '서준 사망',
            providers: reg,
            model: baseModel,
        });
        const c1 = foundation.characters.find((c) => c.id === 'c1');
        expect(c1.mutable.status).toBe('dead');
        // knownFacts [] did not blank the existing facts
        expect(c1.mutable.knownFacts).toEqual(['지켜야 할 사실']);
    });
    it('consolidates repeated role revises into a single event (re-revise keeps effectiveIntrinsic valid)', async () => {
        // first revise: 주인공 → 적대자
        const current = makeCurrent();
        const patch1 = JSON.stringify({
            worldFacts: [{ id: 'wf1', statement: '사실.' }],
            updatedCharacters: [{ id: 'c1', role: '적대자' }],
            newCharacters: [],
        });
        const { reg: reg1 } = scriptedRegistry([patch1]);
        const { foundation: f1 } = await reviseFoundation({
            current,
            feedback: '적대자로',
            providers: reg1,
            model: baseModel,
        });
        expect(f1.intrinsicChanges.filter((e) => e.field === 'role')).toHaveLength(1);
        // second revise on the ALREADY-revised foundation: 적대자 → 흑막
        const patch2 = JSON.stringify({
            worldFacts: [{ id: 'wf1', statement: '사실.' }],
            updatedCharacters: [{ id: 'c1', role: '흑막' }],
            newCharacters: [],
        });
        const { reg: reg2 } = scriptedRegistry([patch2]);
        const { foundation: f2 } = await reviseFoundation({
            current: f1,
            feedback: '흑막으로',
            providers: reg2,
            model: baseModel,
        });
        // still a SINGLE consolidated role event — from=base, to=latest (no stacking).
        const roleEvents = f2.intrinsicChanges.filter((e) => e.field === 'role');
        expect(roleEvents).toHaveLength(1);
        expect(roleEvents[0]?.from).toBe('주인공');
        expect(roleEvents[0]?.to).toBe('흑막');
        // effectiveIntrinsic resolves cleanly (would throw if base was mutated).
        const resolved = resolveCharacter(f2, 1, 'c1');
        expect(resolved.intrinsic.role).toBe('흑막');
    });
    it('FIELD CARRY-FORWARD: preserves Foundation fields not in the explicit override list', async () => {
        let current = makeCurrent();
        // seed fields the generator does not explicitly re-add (worldEra/tone/styleNotes
        // + a draft worldview field).
        current = {
            ...current,
            worldEra: '조선 후기',
            tone: '느와르',
            styleNotes: '간결한 단문',
            entities: [{ id: 'e1', kind: 'location', canonicalName: '한양' }],
        };
        const patch = JSON.stringify({
            worldFacts: [{ id: 'wf1', statement: '바뀐 사실.' }],
            updatedCharacters: [],
            newCharacters: [],
        });
        const { reg } = scriptedRegistry([patch]);
        const { foundation } = await reviseFoundation({
            current,
            feedback: '세계관만 한 줄',
            providers: reg,
            model: baseModel,
        });
        expect(foundation.worldEra).toBe('조선 후기');
        expect(foundation.tone).toBe('느와르');
        expect(foundation.styleNotes).toBe('간결한 단문');
        expect(foundation.entities).toEqual([{ id: 'e1', kind: 'location', canonicalName: '한양' }]);
    });
    it('keeps current worldFacts when the LLM returns an empty/unusable facts array', async () => {
        const current = makeCurrent();
        const patch = JSON.stringify({
            worldFacts: [],
            updatedCharacters: [],
            newCharacters: [],
        });
        const { reg } = scriptedRegistry([patch]);
        const { foundation } = await reviseFoundation({
            current,
            feedback: '캐릭터만 살짝 다듬어줘',
            providers: reg,
            model: baseModel,
        });
        // never blank the registry — current facts retained
        expect(foundation.worldFacts).toHaveLength(2);
        expect(foundation.worldFacts.map((w) => w.id)).toEqual(['wf1', 'wf2']);
    });
    it('throws on empty feedback (no LLM call)', async () => {
        const current = makeCurrent();
        const { reg, requests } = scriptedRegistry(['{}']);
        await expect(reviseFoundation({ current, feedback: '   ', providers: reg, model: baseModel })).rejects.toThrow(/feedback is empty/);
        expect(requests).toHaveLength(0);
    });
    it('throws on unparseable LLM output', async () => {
        const current = makeCurrent();
        const { reg } = scriptedRegistry(['not json at all {{{']);
        await expect(reviseFoundation({ current, feedback: '뭔가 바꿔줘', providers: reg, model: baseModel })).rejects.toThrow(/parse failed/);
    });
    it('skips a new character whose id collides with an existing one (mislabelled update)', async () => {
        const current = makeCurrent();
        const patch = JSON.stringify({
            worldFacts: [{ id: 'wf1', statement: '사실.' }],
            updatedCharacters: [],
            newCharacters: [
                {
                    id: 'c1', // collides with existing
                    canonicalName: '가짜 신규',
                    intrinsic: { gender: 'male', ageBand: '30대', role: '조연', coreAppearance: [] },
                    mutable: { status: 'alive', knownFacts: [] },
                },
            ],
        });
        const { reg } = scriptedRegistry([patch]);
        const { foundation } = await reviseFoundation({
            current,
            feedback: '인물 추가',
            providers: reg,
            model: baseModel,
        });
        // c1 still the original (collision skipped, not overwritten or duplicated)
        expect(foundation.characters).toHaveLength(1);
        expect(foundation.characters[0]?.canonicalName).toBe('서준');
    });
    it('uses the revise-foundation step label + jsonMode on the LLM request', async () => {
        const current = makeCurrent();
        const patch = JSON.stringify({ worldFacts: [{ id: 'wf1', statement: 'x.' }], updatedCharacters: [], newCharacters: [] });
        const { reg, requests } = scriptedRegistry([patch]);
        await reviseFoundation({ current, feedback: '바꿔', providers: reg, model: baseModel });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.step).toBe('revise-foundation');
        expect(requests[0]?.jsonMode).toBe(true);
    });
});
