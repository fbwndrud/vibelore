/**
 * Tests for layer-2 LLM extractDelta + continuityCheck.
 *
 * The provider registry is mocked with a deterministic adapter so tests are
 * hermetic. Address terms are judged by the model, not by a built-in
 * dictionary: a female character called "도련님" yields no deterministic
 * finding.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { computeExtractionContextHash, continuityCheck, EXTRACTION_CONTEXT_HASH_VERSION, extractDelta, } from '../../src/continuity/continuity-check.js';
import { createProviderRegistry, } from '../../src/core/provider-registry.js';
const registry = createGenreProfileRegistry();
function makeFoundation(args) {
    const genre = args.genre ?? 'noble-clan-regression';
    return {
        workId: 'work-test',
        genre,
        worldFacts: [],
        characters: args.characters ?? [],
        intrinsicChanges: [],
        genreProfile: registry.get(genre),
    };
}
function maleChar(id, name, registeredAtChapter = 1) {
    return {
        id,
        canonicalName: name,
        aliases: [],
        registeredAtChapter,
        intrinsic: {
            gender: 'male',
            ageBand: '20대초반',
            role: '주인공',
            coreAppearance: ['흑발'],
        },
        mutable: { status: 'alive', knownFacts: [] },
        relationships: [],
    };
}
function femaleChar(id, name, registeredAtChapter = 1) {
    return {
        id,
        canonicalName: name,
        aliases: [],
        registeredAtChapter,
        intrinsic: {
            gender: 'female',
            ageBand: '20대초반',
            role: '주인공',
            coreAppearance: ['흑발'],
        },
        mutable: { status: 'alive', knownFacts: [] },
        relationships: [],
    };
}
function makeMockAdapter(opts = {}) {
    return {
        provider: 'openai',
        async complete(req) {
            opts.recordCalls?.push(req);
            const reply = opts.replies?.find((r) => r.match(req));
            const text = reply?.text ?? opts.default ?? '{}';
            return {
                text,
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            };
        },
    };
}
const MODEL = { provider: 'openai', modelId: 'mock-2026-05-20' };
// ─── extractDelta ──────────────────────────────────────────────────────────
describe('extractDelta', () => {
    it('empty manifest + empty LLM delta → ChapterDelta with op arrays empty', async () => {
        const providers = createProviderRegistry([
            makeMockAdapter({ default: '{}' }),
        ]);
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종')] });
        const result = await extractDelta({
            prose: '평범한 회차였다.',
            castManifestRaw: '',
            chapterNumber: 1,
            foundation,
            prevState: emptyStoryState('work-test'),
            providers,
            model: MODEL,
        });
        expect(result.manifest).toEqual([]);
        expect(result.unregisteredNamed).toEqual([]);
        expect(result.delta.chapterNumber).toBe(1);
        expect(result.delta.appearedCharacterIds).toEqual([]);
        expect(result.delta.newAddressEntries).toEqual([]);
        expect(result.delta.relationshipOps).toEqual([]);
        expect(result.delta.hookChanges).toEqual([]);
        expect(result.delta.mutableChanges).toEqual([]);
        expect(result.delta.trackedEntityOps).toEqual([]);
    });
    it('valid manifest → appearedCharacterIds populated, manifest parsed', async () => {
        const providers = createProviderRegistry([
            makeMockAdapter({ default: '{}' }),
        ]);
        const foundation = makeFoundation({
            characters: [maleChar('c1', '이세종'), femaleChar('c2', '소영')],
        });
        const manifestRaw = JSON.stringify({
            cast: [
                { characterId: 'c1', addressTermsUsed: ['도련님'] },
                { characterId: 'c2', addressTermsUsed: ['아가씨'] },
            ],
        });
        const result = await extractDelta({
            prose: '이세종이 입을 열었다.',
            castManifestRaw: manifestRaw,
            chapterNumber: 2,
            foundation,
            prevState: emptyStoryState('work-test'),
            providers,
            model: MODEL,
        });
        expect(result.manifest).toEqual([
            { characterId: 'c1', addressTermsUsed: ['도련님'] },
            { characterId: 'c2', addressTermsUsed: ['아가씨'] },
        ]);
        expect(result.delta.appearedCharacterIds).toEqual(['c1', 'c2']);
    });
    it('malformed castManifestRaw → empty manifest, no throw', async () => {
        const providers = createProviderRegistry([
            makeMockAdapter({ default: '{}' }),
        ]);
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종')] });
        const result = await extractDelta({
            prose: 'noop',
            castManifestRaw: '{not valid json',
            chapterNumber: 1,
            foundation,
            prevState: emptyStoryState('work-test'),
            providers,
            model: MODEL,
        });
        expect(result.manifest).toEqual([]);
        expect(result.delta.appearedCharacterIds).toEqual([]);
    });
    it('LLM returns populated ChapterDelta payload → parsed into delta ops', async () => {
        const providers = createProviderRegistry([
            makeMockAdapter({
                default: JSON.stringify({
                    newAddressEntries: [
                        { speakerId: 'c2', targetId: 'c1', term: '도련님', register: 'formal' },
                    ],
                    relationshipOps: [{ to: 'c2', kind: '연인', state: '호감' }],
                    hookChanges: [
                        {
                            id: 'h1',
                            text: '의문의 봉투',
                            plantedAtChapter: 2,
                            phase: 'planted',
                            horizon: 'arc',
                            lastMovedChapter: 2,
                        },
                    ],
                    mutableChanges: [
                        { characterId: 'c1', location: '서재', knownFactsAdded: ['편지내용'] },
                    ],
                    trackedEntityOps: [{ kind: 'Timeline', data: { era: '현생' } }],
                }),
            }),
        ]);
        const foundation = makeFoundation({
            characters: [maleChar('c1', '이세종'), femaleChar('c2', '소영')],
        });
        const manifestRaw = JSON.stringify({
            cast: [{ characterId: 'c1', addressTermsUsed: ['도련님'] }],
        });
        const result = await extractDelta({
            prose: '"도련님, 편지입니다." 이세종이 편지를 펼쳤다.',
            castManifestRaw: manifestRaw,
            chapterNumber: 2,
            foundation,
            prevState: emptyStoryState('work-test'),
            providers,
            model: MODEL,
        });
        expect(result.delta.newAddressEntries).toHaveLength(1);
        expect(result.delta.relationshipOps).toEqual([
            { to: 'c2', kind: '연인', state: '호감' },
        ]);
        expect(result.delta.hookChanges[0]?.id).toBe('h1');
        expect(result.delta.mutableChanges[0]?.knownFactsAdded).toEqual(['편지내용']);
        expect(result.delta.trackedEntityOps).toEqual([
            { kind: 'Timeline', data: { era: '현생' } },
        ]);
    });
    it('LLM returns invalid JSON → degrades to empty delta (no throw)', async () => {
        const providers = createProviderRegistry([
            makeMockAdapter({ default: 'sorry, not JSON today' }),
        ]);
        const foundation = makeFoundation({});
        const result = await extractDelta({
            prose: 'prose',
            castManifestRaw: '',
            chapterNumber: 1,
            foundation,
            prevState: emptyStoryState('work-test'),
            providers,
            model: MODEL,
        });
        expect(result.delta.newAddressEntries).toEqual([]);
        expect(result.delta.relationshipOps).toEqual([]);
    });
    it('empty prevState (chapter 0) does not throw', async () => {
        const providers = createProviderRegistry([
            makeMockAdapter({ default: '{}' }),
        ]);
        const foundation = makeFoundation({});
        await expect(extractDelta({
            prose: '도입부.',
            castManifestRaw: '',
            chapterNumber: 1,
            foundation,
            prevState: emptyStoryState('work-test'),
            providers,
            model: MODEL,
        })).resolves.toBeDefined();
    });
});
// ─── continuityCheck ───────────────────────────────────────────────────────
function emptyDelta(chapterNumber, appearedCharacterIds = []) {
    return {
        chapterNumber,
        appearedCharacterIds,
        newAddressEntries: [],
        relationshipOps: [],
        hookChanges: [],
        mutableChanges: [],
        trackedEntityOps: [],
    };
}
describe('continuityCheck', () => {
    it('LLM emits one intrinsicViolation → passed=false, hard INTRINSIC_VIOLATION', async () => {
        const providers = createProviderRegistry([
            makeMockAdapter({
                default: JSON.stringify({
                    intrinsicViolations: [{ characterId: 'c1', message: '여성 묘사 충돌' }],
                }),
            }),
        ]);
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종')] });
        const result = await continuityCheck({
            prose: '평범한 본문',
            chapterNumber: 2,
            delta: emptyDelta(2, ['c1']),
            prevState: emptyStoryState('work-test'),
            foundation,
            providers,
            model: MODEL,
        });
        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.severity === 'hard' && v.code === 'INTRINSIC_VIOLATION')).toBe(true);
        // #255 — same code as the deterministic structural check above; only
        // `origin` tells a post-mortem which of the two actually fired.
        const hit = result.violations.find((v) => v.code === 'INTRINSIC_VIOLATION');
        expect(hit.origin).toBe('llm');
    });
    it('LLM emits only unjustifiedMutable → passed=true, soft MUTABLE_UNJUSTIFIED', async () => {
        const providers = createProviderRegistry([
            makeMockAdapter({
                default: JSON.stringify({
                    unjustifiedMutable: [{ characterId: 'c1', message: '위치 이동 근거 부족' }],
                }),
            }),
        ]);
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종')] });
        const result = await continuityCheck({
            prose: 'noop',
            chapterNumber: 2,
            delta: emptyDelta(2, ['c1']),
            prevState: emptyStoryState('work-test'),
            foundation,
            providers,
            model: MODEL,
        });
        expect(result.passed).toBe(true);
        const soft = result.violations.filter((v) => v.code === 'MUTABLE_UNJUSTIFIED');
        expect(soft).toHaveLength(1);
        expect(soft[0]?.severity).toBe('soft');
    });
    it('invariantViolations with hard severity from profile → passed=false', async () => {
        const providers = createProviderRegistry([
            makeMockAdapter({
                default: JSON.stringify({
                    invariantViolations: [
                        { invariantId: 'timeline-causality', message: '전생 사건이 현생 이후' },
                    ],
                }),
            }),
        ]);
        // noble-clan-regression has timeline-causality as hard
        const foundation = makeFoundation({
            genre: 'noble-clan-regression',
            characters: [maleChar('c1', '이세종')],
        });
        const result = await continuityCheck({
            prose: 'noop',
            chapterNumber: 2,
            delta: emptyDelta(2, ['c1']),
            prevState: emptyStoryState('work-test'),
            foundation,
            providers,
            model: MODEL,
        });
        expect(result.passed).toBe(false);
        const inv = result.violations.find((v) => v.code === 'INVARIANT_VIOLATION');
        expect(inv?.severity).toBe('hard');
    });
    it('does not judge address terms with a built-in dictionary — the model owns ADDRESSING', async () => {
        const calls = [];
        const providers = createProviderRegistry([
            makeMockAdapter({ default: '{}', recordCalls: calls }),
        ]);
        const character = femaleChar('c2', '소영');
        const foundation = makeFoundation({ characters: [character] });
        const result = await continuityCheck({
            prose: '소영을 향해 "도련님" 하고 누군가 불렀다.',
            chapterNumber: 2,
            delta: emptyDelta(2, ['c2']),
            prevState: emptyStoryState('work-test'),
            foundation,
            providers,
            model: MODEL,
        });
        expect(result.violations).toEqual([]);
        expect(Object.keys(result).sort()).toEqual(['passed', 'semanticValidation', 'violations']);
        const req = calls.find((r) => r.step === 'continuity-check');
        const text = req.messages.map((m) => m.content).join('\n');
        expect(text.includes('genderImplication')).toBe(false);
    });
    it('mutableChanges referencing unknown character with knownFactsAdded → hard INTRINSIC_VIOLATION', async () => {
        const providers = createProviderRegistry([
            makeMockAdapter({ default: '{}' }),
        ]);
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종')] });
        const delta = emptyDelta(2, ['c1']);
        delta.mutableChanges.push({
            characterId: 'ghost',
            knownFactsAdded: ['unknown info'],
        });
        const result = await continuityCheck({
            prose: 'noop',
            chapterNumber: 2,
            delta,
            prevState: emptyStoryState('work-test'),
            foundation,
            providers,
            model: MODEL,
        });
        expect(result.passed).toBe(false);
        const hit = result.violations.find((v) => v.code === 'INTRINSIC_VIOLATION' &&
            v.characterId === 'ghost' &&
            v.severity === 'hard');
        expect(hit).toBeDefined();
        // #255 — the two sites that emit INTRINSIC_VIOLATION are indistinguishable
        // by code alone, and the host cannot persist `message` (the Layer-2 one is
        // LLM-authored free text). `origin` is the only discriminator that travels.
        expect(hit.origin).toBe('structural');
    });
    it('chapter 0 (empty prevState) does not throw', async () => {
        const providers = createProviderRegistry([
            makeMockAdapter({ default: '{}' }),
        ]);
        const prevState = emptyStoryState('work-test');
        const foundation = makeFoundation({});
        await expect(continuityCheck({
            prose: 'intro',
            chapterNumber: 1,
            delta: emptyDelta(1),
            prevState,
            foundation,
            providers,
            model: MODEL,
        })).resolves.toBeDefined();
    });
    it('LLM provider failure does not throw — degrades to the structural-only result', async () => {
        const failing = {
            provider: 'openai',
            async complete() {
                throw new Error('upstream timeout');
            },
        };
        const providers = createProviderRegistry([failing]);
        const foundation = makeFoundation({});
        const result = await continuityCheck({
            prose: '',
            chapterNumber: 1,
            delta: emptyDelta(1),
            prevState: emptyStoryState('work-test'),
            foundation,
            providers,
            model: MODEL,
        });
        expect(result.passed).toBe(true);
        expect(result.violations).toEqual([]);
    });
});

describe('relay-aware continuity prompts', () => {
    function pendingProvider(calls) {
        let pending = [];
        return {
            get pending() { return pending; },
            async complete(req) {
                calls.push(req);
                pending = [...pending, req];
                throw new Error('pending');
            },
        };
    }
    it('does not request an influence repair while the first extraction is still pending', async () => {
        const calls = [];
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종'), femaleChar('c2', '소영')] });
        await extractDelta({
            prose: '이세종이 입을 열었다.', castManifestRaw: '', chapterNumber: 2, foundation,
            prevState: emptyStoryState('work-test'), providers: pendingProvider(calls), model: MODEL,
            requireInfluenceObservation: true,
        });
        expect(calls.map((req) => req.step)).toEqual(['continuity-extract']);
    });
    it('asks for compact JSON and embeds the delta without pretty-print indentation', async () => {
        const calls = [];
        const providers = createProviderRegistry([makeMockAdapter({ default: '{}', recordCalls: calls })]);
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종')] });
        const delta = {
            chapterNumber: 2, appearedCharacterIds: ['c1'], newAddressEntries: [], relationshipOps: [],
            hookChanges: [{ id: 'h1', text: '누가 문을 잠갔나', plantedAtChapter: 1, phase: 'planted', horizon: 'arc', lastMovedChapter: 2 }],
            mutableChanges: [], influenceEvents: [], noInfluenceReason: '', trackedEntityOps: [],
        };
        await continuityCheck({
            prose: '이세종이 문을 밀었다.', chapterNumber: 2, foundation, delta,
            prevState: emptyStoryState('work-test'), providers, model: MODEL,
        });
        const user = calls.find((req) => req.step === 'continuity-check').messages.find((m) => m.role === 'user').content;
        const deltaSection = user.split('## 이번 회차 Delta\n')[1].split('\n\n')[0];
        expect(deltaSection.includes('"hookChanges":[{"id":"h1"')).toBe(true);
        expect(deltaSection.includes('\n')).toBe(false);
        const extractCalls = [];
        await extractDelta({
            prose: '이세종이 문을 밀었다.', castManifestRaw: '', chapterNumber: 2, foundation,
            prevState: emptyStoryState('work-test'), providers: createProviderRegistry([makeMockAdapter({ default: '{}', recordCalls: extractCalls })]), model: MODEL,
        });
        const system = extractCalls[0].messages.find((m) => m.role === 'system').content;
        expect(/공백|들여쓰기/.test(system)).toBe(true);
    });
});
// ─── continuity state that survives chapters ───────────────────────────────
describe('extractDelta carries continuity state', () => {
    it('shows the extractor open hook text, character states and ledger records', async () => {
        const calls = [];
        const providers = createProviderRegistry([makeMockAdapter({ default: '{}', recordCalls: calls })]);
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종'), femaleChar('c2', '소영')] });
        const prevState = {
            ...emptyStoryState('work-test'), chapterNumber: 4,
            hooks: [{ id: 'h1', text: 'HOOK_TEXT_TOKEN', status: 'open', plantedAtChapter: 2 }, { id: 'h2', text: 'PAID_HOOK_TOKEN', status: 'paid', plantedAtChapter: 1 }],
            ledger: { records: [{ id: 'o1', feature: 'objects', label: '물건', name: 'RECORD_TOKEN', aliases: [], status: 'active', fields: { owner: 'c1' }, registeredAt: 2, recent: [] }] },
        };
        await extractDelta({ prose: '평범한 회차였다.', castManifestRaw: '', chapterNumber: 5, foundation, prevState, providers, model: MODEL });
        const prompt = calls[0].messages.map((m) => m.content).join('\n');
        for (const token of ['HOOK_TEXT_TOKEN', '"records":[{"id":"o1","feature":"objects","label":"물건","name":"RECORD_TOKEN","status":"active"}]'])
            expect(prompt.includes(token)).toBe(true);
        for (const token of ['PAID_HOOK_TOKEN', 'trackedEntities', 'knownEntities'])
            expect(prompt.includes(token)).toBe(false);
    });
    it('shows the extractor records converted from a state written before the ledger', async () => {
        const calls = [];
        const providers = createProviderRegistry([makeMockAdapter({ default: '{}', recordCalls: calls })]);
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종'), femaleChar('c2', '소영')] });
        const prevState = {
            ...emptyStoryState('work-test'), chapterNumber: 4,
            hooks: [{ id: 'h1', text: 'HOOK_TEXT_TOKEN', phase: 'planted', plantedAtChapter: 2 }],
            characterStates: { c2: { vitalStatus: 'dead', knownFacts: [], sinceChapter: 3 } },
            ledger: undefined,
            trackedEntities: [{ kind: 'Artifact', data: { name: 'TRACKED_TOKEN', owner: 'c1' } }],
        };
        await extractDelta({
            prose: '평범한 회차였다.', castManifestRaw: '', chapterNumber: 5, foundation, prevState, providers, model: MODEL,
            entities: [{ entityId: 'sword', kind: 'item', canonicalName: 'ENTITY_TOKEN', aliases: [], status: 'active' }],
        });
        const prompt = calls[0].messages.map((m) => m.content).join('\n');
        for (const token of ['HOOK_TEXT_TOKEN', 'TRACKED_TOKEN', 'ENTITY_TOKEN', '"vitalStatus":"dead"', '"from"', '"ledgerOps"'])
            expect(prompt.includes(token)).toBe(true);
    });
    it('parses relationship direction, vital status and entity lifecycle ops', async () => {
        const providers = createProviderRegistry([makeMockAdapter({ default: JSON.stringify({
                relationshipOps: [{ from: '이세종', to: 'c2', kind: '신뢰', state: '의심' }],
                mutableChanges: [{ characterId: 'c2', vitalStatus: 'dead' }, { characterId: 'c1', vitalStatus: 'asleep' }],
                entityOps: [
                    { op: 'retire', entityId: 'sword', cause: 'destroyed' },
                    { op: 'register', entityId: 'shard', kind: 'item', name: '검 조각' },
                    { op: 'update', entityId: 'shard', fields: { owner: 'c1' } },
                    { op: 'explode', entityId: 'x' },
                ],
            }) })]);
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종'), femaleChar('c2', '소영')] });
        const result = await extractDelta({ prose: '검이 부러졌다.', castManifestRaw: '', chapterNumber: 5, foundation, prevState: emptyStoryState('work-test'), providers, model: MODEL });
        expect(result.delta.relationshipOps).toEqual([{ from: 'c1', to: 'c2', kind: '신뢰', state: '의심' }]);
        expect(result.delta.mutableChanges).toEqual([{ characterId: 'c2', vitalStatus: 'dead' }, { characterId: 'c1' }]);
        expect(result.delta.entityOps).toEqual([
            { op: 'retire', entityId: 'sword', cause: 'destroyed' },
            { op: 'register', entityId: 'shard', kind: 'item', name: '검 조각' },
            { op: 'update', entityId: 'shard', fields: { owner: 'c1' } },
        ]);
    });
});
describe('continuityCheck character presence', () => {
    const foundation = makeFoundation({ characters: [maleChar('c1', '이세종'), femaleChar('c2', '소영')] });
    const deadState = { ...emptyStoryState('work-test'), chapterNumber: 4, characterStates: { c2: { vitalStatus: 'dead', knownFacts: [], sinceChapter: 3 } } };
    const check = (delta) => continuityCheck({
        prose: '소영이 문을 열었다.', chapterNumber: 5, delta, prevState: deadState, foundation,
        providers: createProviderRegistry([makeMockAdapter({ default: '{}' })]), model: MODEL,
    });
    it('blocks a character recorded dead from appearing on stage', async () => {
        const result = await check(emptyDelta(5, ['c1', 'c2']));
        const hit = result.violations.find((v) => v.code === 'DEAD_CHARACTER_ON_STAGE');
        expect(hit?.severity).toBe('hard');
        expect(hit?.characterId).toBe('c2');
        expect(hit?.origin).toBe('structural');
    });
    it('accepts a revival quoted from the chapter and flags it for the author', async () => {
        const delta = emptyDelta(5, ['c2']);
        delta.mutableChanges = [{ characterId: 'c2', vitalStatus: 'alive', evidence: '소영이 문을 열었다' }];
        const result = await check(delta);
        expect(result.violations.some((v) => v.code === 'DEAD_CHARACTER_ON_STAGE')).toBe(false);
        const revived = result.violations.find((v) => v.code === 'DEAD_CHARACTER_REVIVED');
        expect(revived?.severity).toBe('soft');
        expect(revived?.characterId).toBe('c2');
    });
    it('keeps the block when the revival has no quote from the chapter', async () => {
        for (const change of [
            { characterId: 'c2', vitalStatus: 'alive' },
            { characterId: 'c2', vitalStatus: 'alive', evidence: '소영은 사실 살아 있었다' },
        ]) {
            const delta = emptyDelta(5, ['c2']);
            delta.mutableChanges = [change];
            const result = await check(delta);
            expect(result.violations.find((v) => v.code === 'DEAD_CHARACTER_ON_STAGE')?.severity).toBe('hard');
        }
    });
    it('does not treat missing as a revival of a character on stage', async () => {
        const delta = emptyDelta(5, ['c2']);
        delta.mutableChanges = [{ characterId: 'c2', vitalStatus: 'missing', evidence: '소영이 문을 열었다' }];
        const result = await check(delta);
        expect(result.violations.find((v) => v.code === 'DEAD_CHARACTER_ON_STAGE')?.severity).toBe('hard');
    });
});
describe('extractDelta revivals', () => {
    it('keeps a quoted revival and drops the vital status of an unquoted one', async () => {
        const providers = createProviderRegistry([makeMockAdapter({ default: JSON.stringify({
                mutableChanges: [
                    { characterId: 'c2', vitalStatus: 'alive', evidence: '소영이 숨을 몰아쉬며 일어났다', location: '성당' },
                    { characterId: 'c3', vitalStatus: 'alive', location: '광장' },
                    { characterId: 'c1', vitalStatus: 'dead', evidence: '없는 문장' },
                ],
            }) })]);
        const foundation = makeFoundation({ characters: [maleChar('c1', '이세종'), femaleChar('c2', '소영'), maleChar('c3', '도윤')] });
        const prevState = { ...emptyStoryState('work-test'), chapterNumber: 4, characterStates: {
                c2: { vitalStatus: 'dead', knownFacts: [], sinceChapter: 3 },
                c3: { vitalStatus: 'dead', knownFacts: [], sinceChapter: 2 },
            } };
        const result = await extractDelta({ prose: '종이 울렸다. 소영이 숨을 몰아쉬며 일어났다.', castManifestRaw: '', chapterNumber: 5, foundation, prevState, providers, model: MODEL });
        expect(result.delta.mutableChanges).toEqual([
            { characterId: 'c2', vitalStatus: 'alive', evidence: '소영이 숨을 몰아쉬며 일어났다', location: '성당' },
            { characterId: 'c3', location: '광장' },
            { characterId: 'c1', vitalStatus: 'dead', evidence: '없는 문장' },
        ]);
        expect(result.rejectedRevivals).toEqual([{ characterId: 'c3', vitalStatus: 'alive', sinceChapter: 2 }]);
    });
});
describe('extractDelta address entries', () => {
    it('rejects an address term that is absent from the prose or names a different character', async () => {
        const providers = createProviderRegistry([makeMockAdapter({ default: JSON.stringify({
                newAddressEntries: [
                    { speakerId: 'c1', targetId: 'c2', term: '마렌 씨', register: 'formal' },
                    { speakerId: 'c4', targetId: 'c2', term: '리아', register: 'intimate' },
                    { speakerId: 'c1', targetId: 'c2', term: '대장님', register: 'formal' },
                    { speakerId: 'c1', targetId: 'c2', term: '도윤', register: 'intimate' },
                    { speakerId: 'c1', targetId: 'c4', term: '마렌 씨', register: 'formal' },
                ],
            }) })]);
        const foundation = makeFoundation({ characters: [femaleChar('c1', '리아'), maleChar('c2', '도윤'), femaleChar('c4', '마렌')] });
        const result = await extractDelta({
            prose: '"도윤, 근거는 여기 있어." 리아가 말했다. "마렌 씨도 봤잖아요."', castManifestRaw: '', chapterNumber: 3,
            foundation, prevState: emptyStoryState('work-test'), providers, model: MODEL,
        });
        expect(result.delta.newAddressEntries).toEqual([
            { speakerId: 'c1', targetId: 'c2', term: '도윤', register: 'intimate' },
            { speakerId: 'c1', targetId: 'c4', term: '마렌 씨', register: 'formal' },
        ]);
        expect(result.rejectedAddressEntries.map((entry) => entry.reason)).toEqual(['names-other-character', 'names-other-character', 'not-in-prose']);
    });
});
// ─── story ledger ops ──────────────────────────────────────────────────────
async function extractWithAnswer(answer, extra = {}) {
    const calls = [];
    const providers = createProviderRegistry([makeMockAdapter({ default: JSON.stringify(answer), recordCalls: calls })]);
    const foundation = makeFoundation({ characters: [maleChar('c1', '이세종')] });
    const result = await extractDelta({
        prose: '평범한 회차였다.', castManifestRaw: '', chapterNumber: 3, foundation,
        prevState: emptyStoryState('work-test'), providers, model: MODEL, ...extra,
    });
    const prompt = calls[0].messages.find((m) => m.role === 'user').content;
    return { ...result, prompt };
}
describe('extractDelta ledger ops', () => {
    it('asks for ledgerOps of enabled features only and parses them', async () => {
        const answer = { newAddressEntries: [], relationshipOps: [], mutableChanges: [], influenceEvents: [], noInfluenceReason: '변화 없음',
            ledgerOps: [{ op: 'register', feature: 'objects', label: '물건', name: '서명 쪽지' }, { op: 'hook', id: 'h1', event: 'paid', evidence: '…' }, { op: 'bogus' }] };
        const { delta, prompt } = await extractWithAnswer(answer, { tracking: { knowledge: false, scheduled: false } });
        expect(prompt).toContain('"ledgerOps"');
        expect(prompt).toContain('objects');
        expect(prompt).not.toContain('knowledge|');
        expect(prompt).not.toContain('trackedEntityOps');
        expect(delta.ledgerOps).toEqual([{ op: 'register', feature: 'objects', label: '물건', name: '서명 쪽지' }, { op: 'hook', id: 'h1', event: 'paid', evidence: '…' }]);
    });
    it('drops keys the extractor is not offered and leaves hooks out when hooks are off', async () => {
        const answer = { ledgerOps: [
            { op: 'register', feature: 'knowledge', label: '비밀', name: '출생', id: 'r9', extra: 1 },
            { op: 'plant', text: '누가 쪽지를 썼나', horizon: 'soon', id: 'h9', plantedAtChapter: 1 },
            { op: 'chapter-note', note: '…' },
        ] };
        const { delta, prompt } = await extractWithAnswer(answer, { tracking: { hooks: false } });
        expect(prompt).toContain('objects|knowledge|scheduled');
        expect(prompt).not.toContain('"plant"');
        expect(delta.ledgerOps).toEqual([
            { op: 'register', feature: 'knowledge', label: '비밀', name: '출생' },
            { op: 'plant', text: '누가 쪽지를 썼나', horizon: 'soon' },
        ]);
    });
    it('still reads legacy hookChanges and trackedEntityOps from recorded answers', async () => {
        const { delta } = await extractWithAnswer({ hookChanges: [{ id: 'h1', text: '약속', phase: 'planted' }], trackedEntityOps: [{ kind: 'Clue', data: { name: '쪽지' } }] });
        expect(delta.hookChanges.map((hook) => hook.id)).toEqual(['h1']);
        expect(delta.trackedEntityOps).toEqual([{ kind: 'Clue', data: { name: '쪽지' } }]);
        expect(delta.ledgerOps).toEqual([]);
    });
    it('binds the extraction hash to the tracking switches', async () => {
        const base = { prose: '본문', chapterNumber: 1, foundation: makeFoundation({ characters: [] }), prevState: emptyStoryState('w'), castManifestRaw: '' };
        expect(EXTRACTION_CONTEXT_HASH_VERSION).toBe(2);
        expect(computeExtractionContextHash(base)).not.toBe(computeExtractionContextHash({ ...base, tracking: { hooks: false } }));
    });
});
