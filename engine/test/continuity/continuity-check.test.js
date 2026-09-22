/**
 * Tests for layer-2 LLM extractDelta + continuityCheck.
 *
 * The provider registry is mocked with a deterministic adapter so tests are
 * hermetic. Layer-1 integration is exercised by setting up a scanLexicon-hit
 * case (female character + "도련님" in prose) and asserting the violation
 * propagates to the aggregate result.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { DefaultHonorificLexicon } from '../../src/continuity/honorific-lexicon.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { continuityCheck, extractDelta, } from '../../src/continuity/continuity-check.js';
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
            prose: '이세종이 편지를 펼쳤다.',
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
            lexicon: new DefaultHonorificLexicon([]),
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
            lexicon: new DefaultHonorificLexicon([]),
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
            lexicon: new DefaultHonorificLexicon([]),
            providers,
            model: MODEL,
        });
        expect(result.passed).toBe(false);
        const inv = result.violations.find((v) => v.code === 'INVARIANT_VIOLATION');
        expect(inv?.severity).toBe('hard');
    });
    it('integrates layer-1 scanLexicon — hard violation from prose surfaces in result', async () => {
        // Mode B (no hints): single conflicting character whose name appears in prose
        // → layer-1 emits a soft violation. We assert presence (the integration
        // contract is "layer-1 violations propagate"); severity per scanLexicon is
        // soft in this mode.
        const providers = createProviderRegistry([
            makeMockAdapter({ default: '{}' }),
        ]);
        const character = femaleChar('c2', '소영');
        const foundation = makeFoundation({ characters: [character] });
        const result = await continuityCheck({
            prose: '소영을 향해 "도련님" 하고 누군가 불렀다.',
            chapterNumber: 2,
            delta: emptyDelta(2, ['c2']),
            prevState: emptyStoryState('work-test'),
            foundation,
            lexicon: new DefaultHonorificLexicon(),
            providers,
            model: MODEL,
        });
        const layer1Hit = result.violations.find((v) => v.code === 'GENDER_HONORIFIC_MISMATCH');
        expect(layer1Hit).toBeDefined();
        expect(layer1Hit?.characterId).toBe('c2');
    });
    it('returns lexiconAdditions when LLM emits them', async () => {
        const providers = createProviderRegistry([
            makeMockAdapter({
                default: JSON.stringify({
                    lexiconAdditions: [
                        {
                            term: '소공자',
                            genderImplication: 'male',
                            statusImplication: '귀족',
                        },
                        {
                            term: '낭자',
                            genderImplication: 'female',
                            speakerGenderImplication: 'male',
                        },
                    ],
                }),
            }),
        ]);
        const foundation = makeFoundation({});
        const result = await continuityCheck({
            prose: 'noop',
            chapterNumber: 2,
            delta: emptyDelta(2),
            prevState: emptyStoryState('work-test'),
            foundation,
            lexicon: new DefaultHonorificLexicon([]),
            providers,
            model: MODEL,
        });
        expect(result.lexiconAdditions).toEqual([
            { term: '소공자', genderImplication: 'male', statusImplication: '귀족' },
            {
                term: '낭자',
                genderImplication: 'female',
                speakerGenderImplication: 'male',
            },
        ]);
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
            lexicon: new DefaultHonorificLexicon([]),
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
            lexicon: new DefaultHonorificLexicon([]),
            providers,
            model: MODEL,
        })).resolves.toBeDefined();
    });
    it('LLM provider failure does not throw — degrades to layer-1-only result', async () => {
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
            lexicon: new DefaultHonorificLexicon([]),
            providers,
            model: MODEL,
        });
        expect(result.passed).toBe(true);
        expect(result.violations).toEqual([]);
        expect(result.lexiconAdditions).toEqual([]);
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
            prevState: emptyStoryState('work-test'), lexicon: new DefaultHonorificLexicon(), providers, model: MODEL,
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
