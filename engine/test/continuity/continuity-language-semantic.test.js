/**
 * continuity-check — 다국어 계열(ko / multilingual) + 의미 검증(phase 3).
 *
 * 상수 비교가 아니라 `providers.complete` 로 **실제로 나간 요청**을 캡처해 본다.
 * 확인하는 계약:
 *   1. 언어 인자가 없는 구형 호출은 기존 한국어 프롬프트와 byte-identical 이고
 *      결과의 legacy 필드도 그대로다.
 *   2. 비ko 는 영어 정적 지시 + 검증된 목표 locale 지시문이며 system·user 에
 *      한글 집필 지시가 남지 않는다. 명시적 계약의 추출 재시도는 호출자가 맡는다.
 *   3. 언어 인자와 저장된 계약이 충돌하면 provider 호출 **전에** 실패한다.
 *   4. ko 전용 결정 검사(scanLexicon / Hangul 고유명사 heuristic)는 비ko 에서
 *      증거로 실행되지 않고, 건너뛴 사실이 결과에 남는다.
 *   5. semanticValidation 은 실제 응답만 신뢰한다 — hash echo 불일치, 모르는 ID,
 *      빠진 필수 ID, 근거 없는 fail, 형식 오류, provider 오류는 통과가 아니다.
 *      continuityCheck 는 의미 재요청 루프를 돌리지 않는다.
 *   6. extractDelta 의 extractionValidation 은 잘 형성된 실제 응답만 completed.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { DefaultHonorificLexicon } from '../../src/continuity/honorific-lexicon.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { buildLanguageContract, LanguagePolicyError } from '../../src/core/language-policy.js';
import {
    CONTINUITY_CHECK_SYSTEM,
    CONTINUITY_CHECK_SYSTEM_MULTILINGUAL,
    CONTINUITY_STATIC_PROMPT_CAPTURES,
    CONTINUITY_STATIC_PROMPT_STEPS,
    EXTRACT_DELTA_SYSTEM,
    EXTRACT_DELTA_SYSTEM_MULTILINGUAL,
    SEMANTIC_INVARIANT_IDS,
    SEPARATE_VALIDATOR_IDS,
    computeContinuityContextHash,
    computeExtractionContextHash,
    continuityCheck,
    continuityCheckSystemStatic,
    continuityExtractRepairStatic,
    continuityExtractSystemStatic,
    extractDelta,
    requiredSemanticInvariantIds,
    unsupportedRequiredSemanticInvariantIds,
} from '../../src/continuity/continuity-check.js';

const registry = createGenreProfileRegistry();
const HANGUL = /[가-힣]/;
const MODEL = { provider: 'openai', modelId: 'mock-2026-05-20' };
const JA_CONTRACT = buildLanguageContract({ language: 'ja' });
const EN_CONTRACT = buildLanguageContract({ language: 'en' });

function capturing(...texts) {
    const requests = [];
    let index = 0;
    return {
        requests,
        providers: {
            async complete(req) {
                requests.push(req);
                const text = texts[Math.min(index, texts.length - 1)] ?? '{}';
                index += 1;
                return { text, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
            },
        },
    };
}
function throwingProviders() {
    const requests = [];
    return {
        requests,
        providers: {
            async complete(req) {
                requests.push(req);
                throw new Error('upstream timeout');
            },
        },
    };
}
function partsOf(req) {
    return {
        system: req.messages.find((m) => m.role === 'system').content,
        user: req.messages.find((m) => m.role === 'user').content,
        step: req.step,
    };
}
function maleChar(id, name) {
    return {
        id,
        canonicalName: name,
        aliases: [],
        registeredAtChapter: 1,
        intrinsic: { gender: 'male', ageBand: '20대초반', role: '주인공', coreAppearance: ['흑발'] },
        mutable: { status: 'alive', knownFacts: [] },
        relationships: [],
    };
}
function femaleChar(id, name) {
    return {
        id,
        canonicalName: name,
        aliases: [],
        registeredAtChapter: 1,
        intrinsic: { gender: 'female', ageBand: '20대초반', role: '주인공', coreAppearance: ['흑발'] },
        mutable: { status: 'alive', knownFacts: [] },
        relationships: [],
    };
}
function makeFoundation(extra = {}) {
    const genre = 'noble-clan-regression';
    return {
        workId: 'work-lang',
        genre,
        worldFacts: [],
        characters: [maleChar('c1', '이세종')],
        intrinsicChanges: [],
        genreProfile: registry.get(genre),
        ...extra,
    };
}
function emptyDelta(chapterNumber, appearedCharacterIds = []) {
    return {
        chapterNumber,
        appearedCharacterIds,
        newAddressEntries: [],
        relationshipOps: [],
        hookOps: [],
        mutableChanges: [],
        trackedEntityOps: [],
    };
}
const PROSE = '이세종은 편지를 펼쳤다. He read the letter twice.';
/** 저장된 작품은 언어가 불변이다. 호출 계약만 바꾸고 foundation 을 구형 ko 로 두면 충돌한다. */
function languageMetaFrom(extra) {
    if (extra.workContract)
        return { workContract: extra.workContract, language: extra.workContract.language };
    if (extra.language)
        return { language: extra.language };
    return {};
}
function foundationFor(extra) {
    const meta = languageMetaFrom(extra);
    if (extra.foundation) {
        if ('workContract' in extra.foundation || 'language' in extra.foundation || Object.keys(meta).length === 0)
            return extra.foundation;
        return { ...extra.foundation, ...meta };
    }
    return makeFoundation(meta);
}
function checkInput(extra = {}) {
    const { foundation: _ignored, ...rest } = extra;
    return {
        prose: PROSE,
        chapterNumber: 2,
        delta: emptyDelta(2, ['c1']),
        prevState: emptyStoryState('work-lang'),
        lexicon: new DefaultHonorificLexicon([]),
        model: MODEL,
        ...rest,
        foundation: foundationFor(extra),
    };
}
function extractInput(extra = {}) {
    const { foundation: _ignored, ...rest } = extra;
    return {
        prose: PROSE,
        castManifestRaw: JSON.stringify({ cast: [{ characterId: 'c1', addressTermsUsed: ['도련님'] }] }),
        chapterNumber: 2,
        prevState: emptyStoryState('work-lang'),
        model: MODEL,
        ...rest,
        foundation: foundationFor(extra),
    };
}
/** requiresSemantic 행만 실제 필수 ID 가 된다(등록기 plan 과 같은 모양). */
function planFor(ids, extraRows = []) {
    return {
        checkerPolicyVersion: 1,
        promptFamily: 'multilingual',
        rows: [
            ...ids.map((id) => ({
                checkerId: null,
                invariantId: id,
                runDetector: false,
                applicability: 'run',
                invariant: 'required',
                ifSkipped: 'semantic_required',
                requiresSemantic: true,
            })),
            ...extraRows,
        ],
    };
}
function semanticReply(hash, verdicts, evidence = [], extra = {}) {
    return JSON.stringify({ ...extra, semanticValidation: { contextHash: hash, verdicts, evidence } });
}
function extractReply(hash, extra = {}) {
    return JSON.stringify({
        ...extra,
        extractionValidation: { contextHash: hash },
    });
}
function completeEmptyExtraction(hash, extra = {}) {
    return JSON.stringify({
        newAddressEntries: [],
        relationshipOps: [],
        hookOps: [],
        mutableChanges: [],
        influenceEvents: [],
        noInfluenceReason: '',
        trackedEntityOps: [],
        extractionValidation: { contextHash: hash },
        ...extra,
    });
}

// ─── extractDelta 계열 ─────────────────────────────────────────────────────
describe('extractDelta prompt families', () => {
    it('legacy call (no language) keeps the ko prompt byte-identical', async () => {
        const cap = capturing('{}');
        const input = extractInput({ providers: cap.providers });
        const result = await extractDelta(input);
        const { system, user, step } = partsOf(cap.requests[0]);
        expect(step).toBe('continuity-extract');
        expect(system).toBe(EXTRACT_DELTA_SYSTEM);
        const expectedUser = [
            `## 회차 번호`,
            '2',
            ``,
            `## 이전 상태 요약 (StoryState N-1)`,
            JSON.stringify({ chapterNumber: 0, addressMapKeys: [], openHookIds: [] }, null, 2),
            ``,
            `## 이번 회차 등장 캐스트 (writer manifest)`,
            JSON.stringify([{ characterId: 'c1', canonicalName: '이세종', aliases: [], addressTermsUsed: ['도련님'] }], null, 2),
            '- characterId 는 canonicalName/aliases 로 식별한다. addressTermsUsed 는 그 인물이 다른 인물을 부를 때 쓴 호칭이며, 그 인물이 불리는 호칭이 아니다.',
            ``,
            `## 본문`,
            PROSE,
            ``,
            `## 출력 스키마 (이 JSON 한 개만 출력)`,
            '{',
            '  "newAddressEntries": [{ "speakerId": "...", "targetId": "...", "term": "...", "register": "formal|intimate|subordinate|..." }],',
            '  "relationshipOps": [{ "to": "...", "kind": "...", "state": "..." }],',
            '  "hookOps": [{ "hookId": "...", "description": "...", "startChapter": 0, "status": "open|progressing|resolved|deferred", "payoffTiming": "immediate|near-term|mid-arc|slow-burn|endgame", "lastAdvancedChapter": 0 }],',
            '  "mutableChanges": [{ "characterId": "...", "location": "...", "status": "...", "knownFactsAdded": ["..."] }],',
            '  "influenceEvents": [{ "characterId": "...", "anchor": "본문에서 확인 가능한 짧은 근거", "interpretation": "이 사건을 인물이 어떻게 받아들였는가", "dimensionChanges": { "작품별_dimension_id": -1 }, "nextChoiceBias": "다음 선택에 생긴 편향", "behavioralProof": { "hypothesis": "성격 가설", "voluntary": true, "alternativesKnown": true, "alternativesAvailable": ["선택A", "선택B"], "chosen": "실제 선택", "costPaid": "지불한 비용", "competingHypotheses": [] }, "relationshipClaims": [{ "from": "...", "to": "...", "dimensions": { "trust": 1 }, "belief": "from이 to를 어떻게 보게 됐는가" }] }],',
            '  "noInfluenceReason": "인물의 선택·비용·인식·관계 변화가 정말 없을 때만 구체적으로 작성. influenceEvents 가 있으면 빈 문자열",',
            '  "trackedEntityOps": [{ "kind": "Timeline|RelationshipState|PowerSystem|Artifact|Clue|KnowledgeMatrix", "data": {} }]',
            '}',
        ].join('\n');
        expect(user).toBe(expectedUser);
        expect(user).not.toContain('extractionValidation');
        expect(result.extractionValidation.status).toBe('completed');
        expect(result.delta.newAddressEntries).toEqual([]);
    });
    it('explicit ja: multilingual static text + validated locale directive, no Korean instruction', async () => {
        const input = extractInput({ language: 'ja' });
        const cap = capturing(extractReply(computeExtractionContextHash(input)));
        await extractDelta({ ...input, providers: cap.providers });
        const { system, user } = partsOf(cap.requests[0]);
        expect(system.startsWith(EXTRACT_DELTA_SYSTEM_MULTILINGUAL)).toBe(true);
        expect(system).toContain('Target work language (BCP 47): ja.');
        expect(HANGUL.test(system)).toBe(false);
        expect(user).toContain('## Chapter number');
        expect(user).toContain('## Cast appearing in this chapter (writer manifest)');
        expect(user).toContain('- Identify each characterId by its canonicalName/aliases.');
        expect(user).toContain('"trackedEntityOps"');
        expect(user).toContain('## Extraction validation (extractionValidation)');
        expect(user).toContain(`contextHash: ${computeExtractionContextHash(input)}`);
        // 프롬프트에 실린 한글은 작품 데이터(캐스트 호칭·본문)뿐이고 지시문은 영어다.
        expect(user).not.toContain('## 본문');
        expect(user).not.toContain('출력 스키마');
    });
    it('stored foundation contract routes the family without a repeated language argument', async () => {
        const foundation = makeFoundation({ workContract: JA_CONTRACT, language: 'ja' });
        const input = extractInput({ foundation });
        const cap = capturing(extractReply(computeExtractionContextHash(input)));
        await extractDelta({ ...input, providers: cap.providers });
        expect(partsOf(cap.requests[0]).system).toContain('Target work language (BCP 47): ja.');
    });
    it('language that conflicts with the stored contract fails before the provider call', async () => {
        const cap = capturing('{}');
        const foundation = makeFoundation({ workContract: JA_CONTRACT });
        await expect(extractDelta(extractInput({ providers: cap.providers, foundation, language: 'en' })))
            .rejects.toBeInstanceOf(LanguagePolicyError);
        expect(cap.requests).toHaveLength(0);
    });
    it('influence repair request uses the same family (ko keeps the existing Korean instruction)', async () => {
        const cap = capturing('{}');
        await extractDelta(extractInput({ providers: cap.providers, requireInfluenceObservation: true }));
        expect(cap.requests).toHaveLength(2);
        const repair = partsOf(cap.requests[1]);
        expect(repair.step).toBe('continuity-extract-repair');
        expect(repair.system).toBe(EXTRACT_DELTA_SYSTEM);
        expect(repair.user).toContain('이전 응답에는 influenceEvents와 noInfluenceReason이 모두 비어 있어 커밋할 수 없다.');
        expect(repair.user).toContain('이전 응답:');
    });
    for (const language of ['ko', 'ja']) {
        for (const response of ['{}', 'not JSON', '']) {
            it(`explicit ${language} returns invalid ${JSON.stringify(response)} after one influence extraction request`, async () => {
                const input = extractInput({
                    workContract: buildLanguageContract({ language }), requireInfluenceObservation: true,
                });
                const cap = capturing(response, completeEmptyExtraction(computeExtractionContextHash(input)));
                const result = await extractDelta({ ...input, providers: cap.providers });
                expect(result.extractionValidation.status).toBe('invalid');
                expect(cap.requests).toHaveLength(1);
                expect(partsOf(cap.requests[0]).step).toBe('continuity-extract');
                if (language === 'ja') {
                    expect(partsOf(cap.requests[0]).system.startsWith(EXTRACT_DELTA_SYSTEM_MULTILINGUAL)).toBe(true);
                    expect(HANGUL.test(partsOf(cap.requests[0]).system)).toBe(false);
                }
            });
        }
    }
    it('explicit influence extraction provider failure returns after one request', async () => {
        const cap = throwingProviders();
        const result = await extractDelta(extractInput({
            providers: cap.providers, workContract: EN_CONTRACT, requireInfluenceObservation: true,
        }));
        expect(result.extractionValidation.status).toBe('error');
        expect(cap.requests).toHaveLength(1);
    });
    it('ko-only proper-noun heuristic does not run as proof on a non-ko work', async () => {
        const prose = '"라이덴" 하고 누군가 불렀다.';
        const ko = await extractDelta(extractInput({
            providers: capturing('{}').providers,
            prose,
        }));
        expect(ko.unregisteredNamed).toContain('라이덴');
        expect(ko.unregisteredNamed.length).toBeGreaterThan(0);
        expect(ko.unregisteredNamedScan).toEqual({ checkerId: 'findUnregisteredNamed', status: 'ran', skipReason: null });
        const jaInput = extractInput({
            prose: '"라이덴" 하고 누군가 불렀다.',
            workContract: JA_CONTRACT,
        });
        const ja = await extractDelta({
            ...jaInput,
            providers: capturing(extractReply(computeExtractionContextHash(jaInput))).providers,
        });
        expect(ja.unregisteredNamed).toEqual([]);
        expect(ja.unregisteredNamedScan).toEqual({
            checkerId: 'findUnregisteredNamed', status: 'skipped', skipReason: 'ko_lexical_unsupported',
        });
    });
});

describe('extractDelta extractionValidation', () => {
    it('legacy well-formed empty object is completed (confirmed no-change from an actual response)', async () => {
        const cap = capturing('{}');
        const result = await extractDelta(extractInput({ providers: cap.providers }));
        expect(result.extractionValidation.status).toBe('completed');
        expect(result.extractionValidation.contextHash).toBe(computeExtractionContextHash(extractInput()));
        expect(result.extractionValidation.diagnostics).toBeUndefined();
    });
    it('explicit contract requires hash echo; empty object without it is not confirmed no-change', async () => {
        const cap = capturing('{}');
        const result = await extractDelta(extractInput({ providers: cap.providers, workContract: EN_CONTRACT }));
        expect(result.extractionValidation.status).toBe('invalid');
        expect(result.extractionValidation.diagnostics.code).toBe('missing_block');
        expect(result.delta.newAddressEntries).toEqual([]);
        expect(partsOf(cap.requests[0]).user).toContain('"extractionValidation"');
    });
    it('matching hash echo on a well-formed empty extraction is completed', async () => {
        const input = extractInput({ workContract: EN_CONTRACT });
        const hash = computeExtractionContextHash(input);
        const cap = capturing(completeEmptyExtraction(hash));
        const result = await extractDelta({ ...input, providers: cap.providers });
        expect(result.extractionValidation.status).toBe('completed');
        expect(result.extractionValidation.contextHash).toBe(hash);
        expect(result.delta.mutableChanges).toEqual([]);
    });
    it('hash-only JSON is not completed SCHEMA proof', async () => {
        const input = extractInput({ workContract: EN_CONTRACT });
        const hash = computeExtractionContextHash(input);
        const cap = capturing(extractReply(hash));
        const result = await extractDelta({ ...input, providers: cap.providers });
        expect(result.extractionValidation.status).toBe('invalid');
        expect(result.extractionValidation.diagnostics.code).toBe('malformed');
        expect(result.delta.mutableChanges).toEqual([]);
    });
    it('hash plus missing array keys is invalid', async () => {
        const input = extractInput({ workContract: EN_CONTRACT });
        const hash = computeExtractionContextHash(input);
        const cap = capturing(JSON.stringify({
            extractionValidation: { contextHash: hash },
            mutableChanges: [],
            noInfluenceReason: '',
        }));
        const result = await extractDelta({ ...input, providers: cap.providers });
        expect(result.extractionValidation.status).toBe('invalid');
        expect(result.extractionValidation.diagnostics.code).toBe('malformed');
    });
    it('hash plus mutableChanges[null] is invalid, not confirmed no-change', async () => {
        const input = extractInput({ workContract: EN_CONTRACT });
        const hash = computeExtractionContextHash(input);
        const cap = capturing(completeEmptyExtraction(hash, { mutableChanges: [null] }));
        const result = await extractDelta({ ...input, providers: cap.providers });
        expect(result.extractionValidation.status).toBe('invalid');
        expect(result.extractionValidation.diagnostics.code).toBe('malformed');
        expect(result.delta.mutableChanges).toEqual([]);
    });
    it('unknown characterId that the parser would drop is invalid, not a lost change', async () => {
        const input = extractInput({ workContract: EN_CONTRACT });
        const hash = computeExtractionContextHash(input);
        const cap = capturing(completeEmptyExtraction(hash, {
            mutableChanges: [{ characterId: 'ghost', knownFactsAdded: ['secret'] }],
        }));
        const result = await extractDelta({ ...input, providers: cap.providers });
        expect(result.extractionValidation.status).toBe('invalid');
        expect(result.delta.mutableChanges).toEqual([]);
    });
    it('canonical name that resolves to a registered id remains completed', async () => {
        const input = extractInput({ workContract: EN_CONTRACT });
        const hash = computeExtractionContextHash(input);
        const cap = capturing(completeEmptyExtraction(hash, {
            mutableChanges: [{ characterId: '이세종', status: 'wounded' }],
        }));
        const result = await extractDelta({ ...input, providers: cap.providers });
        expect(result.extractionValidation.status).toBe('completed');
        expect(result.delta.mutableChanges).toEqual([{ characterId: 'c1', status: 'wounded' }]);
    });
    it('valid nonempty records with every required key remain completed', async () => {
        const input = extractInput({ workContract: EN_CONTRACT });
        const hash = computeExtractionContextHash(input);
        const cap = capturing(completeEmptyExtraction(hash, {
            newAddressEntries: [{ speakerId: 'c1', targetId: 'c1', term: 'sir', register: 'formal' }],
            relationshipOps: [{ to: 'c1', kind: 'ally', state: 'warm' }],
            hookOps: [{ hookId: 'h1', description: 'the letter', startChapter: 2, status: 'open', lastAdvancedChapter: 2 }],
            mutableChanges: [{ characterId: 'c1', location: 'study', knownFactsAdded: ['the letter'] }],
            influenceEvents: [{
                characterId: 'c1',
                anchor: 'He read the letter twice.',
                interpretation: 'he accepted the cost',
                dimensionChanges: { resolve: 1 },
                nextChoiceBias: 'open the next envelope',
                relationshipClaims: [{ from: 'c1', to: 'c1', dimensions: { trust: 1 }, belief: 'still himself' }],
            }],
            noInfluenceReason: '',
            trackedEntityOps: [{ kind: 'Timeline', data: { era: 'present' } }],
        }));
        const result = await extractDelta({ ...input, providers: cap.providers });
        expect(result.extractionValidation.status).toBe('completed');
        expect(result.delta.newAddressEntries).toHaveLength(1);
        expect(result.delta.hookOps[0].hookId).toBe('h1');
        expect(result.delta.influenceEvents[0].characterId).toBe('c1');
        expect(result.delta.trackedEntityOps).toEqual([{ kind: 'Timeline', data: { era: 'present' } }]);
    });
    it('recorded influenceEvents make noInfluenceReason optional (ja sample, 43be593)', async () => {
        const input = extractInput({ workContract: EN_CONTRACT });
        const hash = computeExtractionContextHash(input);
        const event = { characterId: 'c1', anchor: 'He read the letter twice.', interpretation: 'he accepted the cost' };
        const omitted = JSON.stringify({
            newAddressEntries: [], relationshipOps: [], hookOps: [], mutableChanges: [], trackedEntityOps: [],
            influenceEvents: [event],
            extractionValidation: { contextHash: hash },
        });
        const omittedResult = await extractDelta({ ...input, providers: capturing(omitted).providers });
        expect(omittedResult.extractionValidation.status).toBe('completed');
        expect(omittedResult.delta.influenceEvents).toHaveLength(1);
        expect(omittedResult.delta.noInfluenceReason).toBe('');
        const nulled = await extractDelta({ ...input, providers: capturing(completeEmptyExtraction(hash, { influenceEvents: [event], noInfluenceReason: null })).providers });
        expect(nulled.extractionValidation.status).toBe('completed');
        // Without any event the reason is still the required substitute.
        const bare = JSON.stringify({
            newAddressEntries: [], relationshipOps: [], hookOps: [], mutableChanges: [], trackedEntityOps: [], influenceEvents: [],
            extractionValidation: { contextHash: hash },
        });
        const bareResult = await extractDelta({ ...input, providers: capturing(bare).providers });
        expect(bareResult.extractionValidation.status).toBe('invalid');
        expect(bareResult.extractionValidation.diagnostics.code).toBe('malformed');
        const numeric = await extractDelta({ ...input, providers: capturing(completeEmptyExtraction(hash, { influenceEvents: [event], noInfluenceReason: 3 })).providers });
        expect(numeric.extractionValidation.status).toBe('invalid');
    });
    it('incomplete nested records and nonfinite dimensions are invalid', async () => {
        const input = extractInput({ workContract: EN_CONTRACT });
        const hash = computeExtractionContextHash(input);
        const incompleteHook = capturing(completeEmptyExtraction(hash, {
            hookOps: [{ hookId: 'h1' }],
        }));
        const hookResult = await extractDelta({ ...input, providers: incompleteHook.providers });
        expect(hookResult.extractionValidation.status).toBe('invalid');
        const badDim = capturing(completeEmptyExtraction(hash, {
            influenceEvents: [{
                characterId: 'c1',
                anchor: 'He read the letter twice.',
                dimensionChanges: { resolve: Number.POSITIVE_INFINITY },
            }],
        }));
        const dimResult = await extractDelta({ ...input, providers: badDim.providers });
        expect(dimResult.extractionValidation.status).toBe('invalid');
        const badFacts = capturing(completeEmptyExtraction(hash, {
            mutableChanges: [{ characterId: 'c1', knownFactsAdded: [null] }],
        }));
        const factsResult = await extractDelta({ ...input, providers: badFacts.providers });
        expect(factsResult.extractionValidation.status).toBe('invalid');
    });
    it('legacy missing-array payloads keep prior completed empty-delta behaviour', async () => {
        const cap = capturing(JSON.stringify({ mutableChanges: [{ characterId: 'ghost' }] }));
        const result = await extractDelta(extractInput({ providers: cap.providers }));
        expect(result.extractionValidation.status).toBe('completed');
        expect(result.delta.mutableChanges).toEqual([]);
    });
    it('hash mismatch is invalid, not completed', async () => {
        const input = extractInput({ workContract: JA_CONTRACT });
        const cap = capturing(extractReply('0'.repeat(64)));
        const result = await extractDelta({ ...input, providers: cap.providers });
        expect(cap.requests).toHaveLength(1);
        expect(result.extractionValidation.status).toBe('invalid');
        expect(result.extractionValidation.diagnostics.code).toBe('hash_mismatch');
    });
    it('malformed JSON is invalid and does not count as confirmed empty delta', async () => {
        const cap = capturing('sorry, not JSON today');
        const result = await extractDelta(extractInput({ providers: cap.providers, workContract: EN_CONTRACT }));
        expect(result.extractionValidation.status).toBe('invalid');
        expect(result.delta.relationshipOps).toEqual([]);
    });
    it('schema-invalid payload (array field is not an array) is invalid', async () => {
        const input = extractInput({ workContract: EN_CONTRACT });
        const cap = capturing(JSON.stringify({
            extractionValidation: { contextHash: computeExtractionContextHash(input) },
            mutableChanges: 'wounded',
        }));
        const result = await extractDelta({ ...input, providers: cap.providers });
        expect(result.extractionValidation.status).toBe('invalid');
        expect(result.extractionValidation.diagnostics.code).toBe('malformed');
    });
    it('provider throw is error, not completed empty', async () => {
        const cap = throwingProviders();
        const result = await extractDelta(extractInput({ providers: cap.providers, workContract: EN_CONTRACT }));
        expect(cap.requests).toHaveLength(1);
        expect(result.extractionValidation.status).toBe('error');
        expect(result.delta.newAddressEntries).toEqual([]);
        expect(result.manifest).toHaveLength(1);
    });
    it('binds chapterNumber so empty structures do not collapse across chapters', () => {
        const ch2 = extractInput({ workContract: EN_CONTRACT, chapterNumber: 2 });
        const ch3 = extractInput({ workContract: EN_CONTRACT, chapterNumber: 3 });
        expect(computeExtractionContextHash(ch2)).not.toBe(computeExtractionContextHash(ch3));
    });
});

// 2026-09-15 ko·zh-Hant·es 표본: 명단이 ID 와 호칭만 실어 추출기가 c1/c2 를 뒤바꿨고,
// Foundation 요약에 선언 시점이 없어 검수기가 POV 를 uncertain 으로만 돌려줬다.
describe('extractDelta / continuityCheck identify cast and declared POV', () => {
    it('cast summary names each manifest id from Foundation and leaves unknown ids bare', async () => {
        const cap = capturing('{}');
        await extractDelta(extractInput({
            providers: cap.providers,
            castManifestRaw: JSON.stringify({ cast: [
                { characterId: 'c1', addressTermsUsed: ['도련님'] },
                { characterId: 'ghost', addressTermsUsed: [] },
            ] }),
        }));
        const { user } = partsOf(cap.requests[0]);
        const cast = JSON.parse(user.split('## 이번 회차 등장 캐스트 (writer manifest)\n')[1].split('\n- characterId')[0]);
        expect(cast).toEqual([
            { characterId: 'c1', canonicalName: '이세종', aliases: [], addressTermsUsed: ['도련님'] },
            { characterId: 'ghost', addressTermsUsed: [] },
        ]);
    });
    it('foundation summary carries povMode when the work declares one', async () => {
        const cap = capturing('{}');
        await continuityCheck(checkInput({
            providers: cap.providers,
            foundation: makeFoundation({ povMode: '3인칭제한' }),
        }));
        const { user } = partsOf(cap.requests[0]);
        const summary = JSON.parse(user.split('## Foundation 요약\n')[1].split('\n\n## 이번 회차 Delta')[0]);
        expect(summary.povMode).toBe('3인칭제한');
    });
    it('foundation summary carries the profile povDesign when the caller passes one', async () => {
        const cap = capturing('{}');
        await continuityCheck(checkInput({
            providers: cap.providers,
            povDesign: { mode: '3인칭제한', openingViewpoint: '이세종', narrativeDistance: '', switchPolicy: '장 사이에서만 바꾼다', extra: 3 },
        }));
        const { user } = partsOf(cap.requests[0]);
        const summary = JSON.parse(user.split('## Foundation 요약\n')[1].split('\n\n## 이번 회차 Delta')[0]);
        expect(summary.povDesign).toEqual({ mode: '3인칭제한', openingViewpoint: '이세종', switchPolicy: '장 사이에서만 바꾼다' });
    });
    it('foundation summary omits povMode when the work declares none', async () => {
        const cap = capturing('{}');
        await continuityCheck(checkInput({ providers: cap.providers }));
        const { user } = partsOf(cap.requests[0]);
        expect(user).not.toContain('"povMode"');
    });
});

// ─── continuityCheck 계열 ──────────────────────────────────────────────────
describe('continuityCheck prompt families', () => {
    it('legacy call keeps the ko prompt byte-identical and the legacy result shape', async () => {
        const cap = capturing('{}');
        const input = checkInput({ providers: cap.providers });
        const result = await continuityCheck(input);
        const { system, user, step } = partsOf(cap.requests[0]);
        expect(step).toBe('continuity-check');
        expect(system).toBe(CONTINUITY_CHECK_SYSTEM);
        const expectedUser = [
            `## 회차 번호`,
            '2',
            ``,
            `## 이전 상태 요약`,
            JSON.stringify({ chapterNumber: 0, addressMapKeys: [], openHookIds: [] }, null, 2),
            ``,
            `## Foundation 요약`,
            JSON.stringify({
                genre: 'noble-clan-regression',
                characters: [{
                    id: 'c1',
                    canonicalName: '이세종',
                    aliases: [],
                    intrinsic: { gender: 'male', ageBand: '20대초반', role: '주인공', coreAppearance: ['흑발'] },
                    mutable: { status: 'alive', knownFacts: [] },
                }],
                intrinsicChanges: [],
                worldFacts: [],
            }, null, 2),
            ``,
            `## 이번 회차 Delta`,
            JSON.stringify(emptyDelta(2, ['c1']), null, 2),
            ``,
            `## 장르 invariant 목록`,
            JSON.stringify(registry.get('noble-clan-regression').invariants, null, 2),
            ``,
            `## 본문`,
            PROSE,
            ``,
            `## 검수 작업`,
            '- intrinsic 위반: Foundation 의 캐릭터 intrinsic(성별/연령대/역할 등)과 본문 묘사가 충돌하는 사례',
            '- invariant 위반: 위 invariant 목록 중 본문/Delta 에서 깨진 항목 (invariantId 명시)',
            '- 정당화되지 않은 mutable 변경: location/status 변화가 본문에 명시되지 않는 경우',
            '- lexicon 추가: 본문에 등장한 호칭이 알려지지 않은 경우 함의 분류',
            ``,
            `## 출력 스키마 (이 JSON 한 개만 출력)`,
            '{',
            '  "intrinsicViolations": [{ "characterId": "...", "message": "..." }],',
            '  "invariantViolations": [{ "invariantId": "...", "message": "..." }],',
            '  "unjustifiedMutable": [{ "characterId": "...", "message": "..." }],',
            '  "lexiconAdditions": [{ "term": "...", "genderImplication": "male|female|null", "speakerGenderImplication": "male|female|null", "statusImplication": "..." }]',
            '}',
        ].join('\n');
        expect(user).toBe(expectedUser);
        expect(result.passed).toBe(true);
        expect(result.violations).toEqual([]);
        expect(result.lexiconAdditions).toEqual([]);
        // 계획이 없으면 아무것도 묻지 않았으므로 통과가 아니라 pending 이다.
        expect(result.semanticValidation.status).toBe('pending');
        expect(result.semanticValidation.verdicts).toEqual({});
        expect(result.deterministicScan).toEqual({ checkerId: 'scanLexicon', status: 'ran', skipReason: null });
    });
    it('ja check prompt is English-based and asks for target-language messages', async () => {
        const cap = capturing('{}');
        await continuityCheck(checkInput({ providers: cap.providers, workContract: JA_CONTRACT }));
        const { system, user } = partsOf(cap.requests[0]);
        expect(system.startsWith(CONTINUITY_CHECK_SYSTEM_MULTILINGUAL)).toBe(true);
        expect(system).toContain('Write every message and reason in the target work language');
        expect(system).toContain('Target work language (BCP 47): ja.');
        expect(HANGUL.test(system)).toBe(false);
        expect(user).toContain('## Review tasks');
        expect(user).toContain('## Genre invariant list');
        expect(user).not.toContain('## 검수 작업');
        // 분량 목표는 검수 프롬프트에 섞이지 않는다.
        expect(system).not.toContain('3000 graphemes');
    });
    it('ko-only lexicon scan is skipped (not silently passed) on a non-ko work', async () => {
        const prose = '소영을 향해 "도련님" 하고 누군가 불렀다.';
        const foundation = makeFoundation({ characters: [femaleChar('c2', '소영')] });
        const ko = await continuityCheck(checkInput({
            providers: capturing('{}').providers, prose, foundation,
            lexicon: new DefaultHonorificLexicon(),
        }));
        expect(ko.violations.some((v) => v.code === 'GENDER_HONORIFIC_MISMATCH')).toBe(true);
        expect(ko.deterministicScan.status).toBe('ran');
        const ja = await continuityCheck(checkInput({
            providers: capturing('{}').providers, prose, foundation,
            lexicon: new DefaultHonorificLexicon(), workContract: JA_CONTRACT,
        }));
        expect(ja.violations).toEqual([]);
        expect(ja.deterministicScan).toEqual({
            checkerId: 'scanLexicon', status: 'skipped', skipReason: 'ko_lexical_unsupported',
        });
    });
    it('structural and fallback messages follow the family language', async () => {
        const delta = emptyDelta(2, ['c1']);
        delta.mutableChanges.push({ characterId: 'ghost', knownFactsAdded: ['unknown info'] });
        const llm = JSON.stringify({ intrinsicViolations: [{ characterId: 'c1' }], unjustifiedMutable: [{ characterId: 'c1' }] });
        const ko = await continuityCheck(checkInput({ providers: capturing(llm).providers, delta }));
        expect(ko.violations.find((v) => v.origin === 'structural').message)
            .toBe('Foundation 에 미등록된 캐릭터 "ghost" 의 knownFacts 변경 시도');
        expect(ko.violations.find((v) => v.origin === 'llm').message).toBe('본문이 Foundation intrinsic 과 충돌');
        const en = await continuityCheck(checkInput({
            providers: capturing(llm).providers, delta, workContract: EN_CONTRACT,
        }));
        expect(en.violations.find((v) => v.origin === 'structural').message)
            .toBe('knownFacts change attempted for character "ghost" which is not registered in Foundation');
        expect(en.violations.find((v) => v.origin === 'llm').message)
            .toBe('the chapter text contradicts a Foundation intrinsic');
        expect(en.violations.find((v) => v.code === 'MUTABLE_UNJUSTIFIED').message)
            .toBe('the mutable change is not grounded in the chapter text');
    });
    it('language conflicting with the stored contract fails before the provider call', async () => {
        const cap = capturing('{}');
        const foundation = makeFoundation({ workContract: JA_CONTRACT });
        await expect(continuityCheck(checkInput({ providers: cap.providers, foundation, language: 'ko' })))
            .rejects.toBeInstanceOf(LanguagePolicyError);
        expect(cap.requests).toHaveLength(0);
    });
});

// ─── semanticValidation ────────────────────────────────────────────────────
describe('continuityCheck semanticValidation', () => {
    it('derives required IDs from the actual plan and ignores separate validators', () => {
        const plan = planFor(['INTRINSIC', 'POV', 'FORMAT'], [
            { checkerId: null, invariantId: 'SCHEMA', invariant: 'required', requiresSemantic: true, applicability: 'run' },
            { checkerId: null, invariantId: 'LENGTH', invariant: 'required', requiresSemantic: true, applicability: 'run' },
            { checkerId: null, invariantId: 'OUTPUT_LANGUAGE', invariant: 'required', requiresSemantic: true, applicability: 'run' },
            { checkerId: 'scanLexicon', invariantId: 'ADDRESSING', invariant: 'advisory', requiresSemantic: true, applicability: 'run' },
            { checkerId: 'checkPov', invariantId: 'POV', invariant: 'required', requiresSemantic: true, applicability: 'not_applicable' },
        ]);
        expect(requiredSemanticInvariantIds(plan)).toEqual(['FORMAT', 'INTRINSIC', 'POV']);
        expect(unsupportedRequiredSemanticInvariantIds(plan)).toEqual([]);
        expect(requiredSemanticInvariantIds({ rows: [] })).toEqual([]);
        expect(SEMANTIC_INVARIANT_IDS).toContain('FORMAT');
        expect(SEMANTIC_INVARIANT_IDS).toContain('SENSITIVE');
        expect(SEPARATE_VALIDATOR_IDS).toEqual(['LENGTH', 'OUTPUT_LANGUAGE', 'SCHEMA']);
    });
    it('unknown required semantic IDs are invalid, not silently omitted', async () => {
        const plan = planFor(['INTRINSIC', 'MADE_UP']);
        expect(requiredSemanticInvariantIds(plan)).toEqual(['INTRINSIC']);
        expect(unsupportedRequiredSemanticInvariantIds(plan)).toEqual(['MADE_UP']);
        const cap = capturing('{}');
        const result = await continuityCheck(checkInput({
            providers: cap.providers, workContract: EN_CONTRACT, checkerPlan: plan,
        }));
        expect(cap.requests).toHaveLength(1);
        expect(partsOf(cap.requests[0]).user).not.toContain('semanticValidation');
        expect(result.semanticValidation.status).toBe('invalid');
        expect(result.semanticValidation.verdicts).toEqual({});
        expect(result.passed).toBe(true);
    });
    it('valid response → completed with verdicts and quoted evidence, one provider call', async () => {
        const input = checkInput({ workContract: JA_CONTRACT, checkerPlan: planFor(['INTRINSIC', 'POV', 'WORLD']) });
        const hash = computeContinuityContextHash(input);
        const cap = capturing(semanticReply(hash, { INTRINSIC: 'pass', POV: 'pass', WORLD: 'uncertain' }, [
            { invariantId: 'INTRINSIC', fieldPath: 'prose', quote: 'He read the letter twice.', reason: '男性として描かれている記述と矛盾しない。' },
        ]));
        const result = await continuityCheck({ ...input, providers: cap.providers });
        expect(cap.requests).toHaveLength(1);
        const { user } = partsOf(cap.requests[0]);
        expect(user).toContain(`contextHash: ${hash}`);
        expect(user).toContain('Give a verdict for every one of these invariants: INTRINSIC, POV, WORLD.');
        expect(user).toContain('"semanticValidation": {');
        expect(result.semanticValidation.status).toBe('completed');
        expect(result.semanticValidation.contextHash).toBe(hash);
        expect(result.semanticValidation.verdicts).toEqual({ INTRINSIC: 'pass', POV: 'pass', WORLD: 'uncertain' });
        expect(result.semanticValidation.evidence).toHaveLength(1);
        expect(result.semanticValidation.evidence[0].quote).toBe('He read the letter twice.');
    });
    it('FORMAT is asked when the plan requires a semantic format substitute', async () => {
        const input = checkInput({ workContract: EN_CONTRACT, checkerPlan: planFor(['FORMAT']) });
        const hash = computeContinuityContextHash(input);
        const cap = capturing(semanticReply(hash, { FORMAT: 'pass' }));
        const result = await continuityCheck({ ...input, providers: cap.providers });
        expect(cap.requests).toHaveLength(1);
        const { user } = partsOf(cap.requests[0]);
        expect(user).toContain('Give a verdict for every one of these invariants: FORMAT.');
        expect(user).toContain('dialogueBreakMode=natural');
        expect(result.semanticValidation.status).toBe('completed');
        expect(result.semanticValidation.verdicts.FORMAT).toBe('pass');
    });
    it('complete semantic fail is completed+fail and leaves the legacy result untouched', async () => {
        const input = checkInput({ workContract: EN_CONTRACT, checkerPlan: planFor(['POV']) });
        const hash = computeContinuityContextHash(input);
        const cap = capturing(semanticReply(hash, { POV: 'fail' }, [
            { invariantId: 'POV', fieldPath: 'prose', quote: 'He read the letter twice.', reason: 'The narration switches to a third person the declared narrator cannot see.' },
        ]));
        const result = await continuityCheck({ ...input, providers: cap.providers });
        expect(result.semanticValidation.status).toBe('completed');
        expect(result.semanticValidation.verdicts.POV).toBe('fail');
        // 차단은 coverage 소유자 몫이다 — legacy passed 를 여기서 뒤집지 않는다.
        expect(result.passed).toBe(true);
        expect(result.violations).toEqual([]);
    });
    // 2026-09-16 th 표본: 검수자가 Foundation 요약에 실린 povDesign.mode 를 인용했는데 엔진 Foundation 레코드에는
    // 그 필드가 없어 응답 전체가 폐기됐고, 2화의 시점 인물이 계획(povCharacter)에서 정해졌다는 사실도 검수자에게 없었다.
    it('the summary names the planned viewpoint character and evidence may cite the viewpoint fields it shows', async () => {
        const povDesign = { mode: 'limited third person, alternating by chapter', openingViewpoint: '이세종', switchPolicy: 'only at a chapter break' };
        const input = checkInput({ workContract: EN_CONTRACT, checkerPlan: planFor(['POV']), povDesign, povCharacterId: 'c1' });
        const hash = computeContinuityContextHash(input);
        const cap = capturing(semanticReply(hash, { POV: 'fail' }, [
            { invariantId: 'POV', fieldPath: 'foundation.povDesign.mode', quote: 'alternating by chapter', reason: 'The chapter keeps the previous viewpoint although the design alternates.' },
            { invariantId: 'POV', fieldPath: 'foundation.povCharacterId', quote: 'c1', reason: 'The plan holds the viewpoint on c1 for this chapter.' },
        ]));
        const result = await continuityCheck({ ...input, providers: cap.providers });
        const { user } = partsOf(cap.requests[0]);
        const summary = JSON.parse(user.split('## Foundation summary\n')[1].split('\n\n## Delta for this chapter')[0]);
        expect(summary.povCharacterId).toBe('c1');
        expect(summary.povCharacterName).toBe('이세종');
        expect(summary.povDesign.mode).toBe(povDesign.mode);
        expect(user).toContain('when povCharacterId is given, that character is this chapter\'s viewpoint');
        expect(result.semanticValidation.status).toBe('completed');
        expect(result.semanticValidation.evidence.map((item) => item.fieldPath)).toEqual(['foundation.povDesign.mode', 'foundation.povCharacterId']);
        expect(computeContinuityContextHash({ ...input, povCharacterId: 'c2' })).not.toBe(hash);
    });
    it('evidence must quote the named field, not a sibling serialization', async () => {
        const delta = emptyDelta(2, ['c1']);
        delta.mutableChanges.push({ characterId: 'c1', status: 'wounded' });
        const input = checkInput({ workContract: EN_CONTRACT, delta, checkerPlan: planFor(['WORLD']) });
        const hash = computeContinuityContextHash(input);
        const ok = capturing(semanticReply(hash, { WORLD: 'fail' }, [
            { invariantId: 'WORLD', fieldPath: 'delta.mutableChanges[0].status', quote: 'wounded', reason: 'No wound is shown anywhere in the chapter text.' },
        ]));
        const okResult = await continuityCheck({ ...input, providers: ok.providers });
        expect(okResult.semanticValidation.status).toBe('completed');
        expect(okResult.semanticValidation.evidence[0].fieldPath).toBe('delta.mutableChanges[0].status');
        const elsewhere = capturing(semanticReply(hash, { WORLD: 'fail' }, [
            { invariantId: 'WORLD', fieldPath: 'delta.mutableChanges[0].status', quote: '"status": "wounded"', reason: 'No wound is shown anywhere in the chapter text.' },
        ]));
        const elsewhereResult = await continuityCheck({ ...input, providers: elsewhere.providers });
        expect(elsewhere.requests).toHaveLength(1);
        expect(elsewhereResult.semanticValidation.status).toBe('invalid');
    });
    it('a quote that only exists in prose cannot bless a delta fieldPath', async () => {
        const input = checkInput({ workContract: EN_CONTRACT, checkerPlan: planFor(['WORLD']) });
        const hash = computeContinuityContextHash(input);
        const cap = capturing(semanticReply(hash, { WORLD: 'fail' }, [
            { invariantId: 'WORLD', fieldPath: 'delta.chapterNumber', quote: 'He read the letter twice.', reason: 'The delta claims a world event the chapter never shows.' },
        ]));
        const result = await continuityCheck({ ...input, providers: cap.providers });
        expect(cap.requests).toHaveLength(1);
        expect(result.semanticValidation.status).toBe('invalid');
    });
    it('hash mismatch stays invalid after the single continuity-check call (no nested repair)', async () => {
        const input = checkInput({ workContract: JA_CONTRACT, checkerPlan: planFor(['INTRINSIC']) });
        const stale = semanticReply('0'.repeat(64), { INTRINSIC: 'pass' });
        const cap = capturing(stale);
        const result = await continuityCheck({ ...input, providers: cap.providers });
        expect(cap.requests.map((r) => r.step)).toEqual(['continuity-check']);
        expect(result.semanticValidation.status).toBe('invalid');
        expect(result.semanticValidation.verdicts).toEqual({});
        expect(result.semanticValidation.evidence).toEqual([]);
    });
    it('fail without quoted evidence is invalid, never a verdict', async () => {
        const input = checkInput({ workContract: EN_CONTRACT, checkerPlan: planFor(['SENSITIVE']) });
        const hash = computeContinuityContextHash(input);
        const cap = capturing(semanticReply(hash, { SENSITIVE: 'fail' }));
        const result = await continuityCheck({ ...input, providers: cap.providers });
        expect(cap.requests).toHaveLength(1);
        expect(result.semanticValidation.status).toBe('invalid');
    });
    it('a quote that is not present verbatim in the named field is invalid', async () => {
        const input = checkInput({ workContract: EN_CONTRACT, checkerPlan: planFor(['REGISTRATION']) });
        const hash = computeContinuityContextHash(input);
        const cap = capturing(semanticReply(hash, { REGISTRATION: 'fail' }, [
            { invariantId: 'REGISTRATION', fieldPath: 'prose', quote: 'a sentence the chapter never contains', reason: 'An unregistered character speaks here.' },
        ]));
        const result = await continuityCheck({ ...input, providers: cap.providers });
        expect(cap.requests).toHaveLength(1);
        expect(result.semanticValidation.status).toBe('invalid');
    });
    it('a reason that only repeats machine tokens is not evidence', async () => {
        const input = checkInput({ workContract: EN_CONTRACT, checkerPlan: planFor(['ADDRESSING']) });
        const hash = computeContinuityContextHash(input);
        const cap = capturing(semanticReply(hash, { ADDRESSING: 'fail' }, [
            { invariantId: 'ADDRESSING', fieldPath: 'prose', quote: 'He read the letter twice.', reason: 'ADDRESSING fail' },
        ]));
        const result = await continuityCheck({ ...input, providers: cap.providers });
        expect(cap.requests).toHaveLength(1);
        expect(result.semanticValidation.status).toBe('invalid');
    });
    it('missing required ID and unknown ID are both invalid — no N/A waiver', async () => {
        const base = checkInput({ workContract: EN_CONTRACT, checkerPlan: planFor(['INTRINSIC', 'POV']) });
        const hash = computeContinuityContextHash(base);
        const missing = capturing(semanticReply(hash, { INTRINSIC: 'pass' }));
        const missingResult = await continuityCheck({ ...base, providers: missing.providers });
        expect(missing.requests).toHaveLength(1);
        expect(missingResult.semanticValidation.status).toBe('invalid');
        const unknown = capturing(semanticReply(hash, { INTRINSIC: 'pass', POV: 'pass', LENGTH: 'pass' }));
        const unknownResult = await continuityCheck({ ...base, providers: unknown.providers });
        expect(unknown.requests).toHaveLength(1);
        expect(unknownResult.semanticValidation.status).toBe('invalid');
        const waiver = capturing(semanticReply(hash, { INTRINSIC: 'pass', POV: 'N/A' }));
        const waiverResult = await continuityCheck({ ...base, providers: waiver.providers });
        expect(waiverResult.semanticValidation.status).toBe('invalid');
    });
    it('malformed response text stays invalid with no extra provider call', async () => {
        const input = checkInput({ workContract: EN_CONTRACT, checkerPlan: planFor(['INTRINSIC']) });
        const cap = capturing('sorry, not JSON today');
        const result = await continuityCheck({ ...input, providers: cap.providers });
        expect(cap.requests).toHaveLength(1);
        expect(result.semanticValidation.status).toBe('invalid');
        expect(result.passed).toBe(true);
    });
    it('provider failure → error (unvalidated) and the legacy result still degrades gracefully', async () => {
        const input = checkInput({ workContract: EN_CONTRACT, checkerPlan: planFor(['INTRINSIC']) });
        const cap = throwingProviders();
        const result = await continuityCheck({ ...input, providers: cap.providers });
        expect(cap.requests).toHaveLength(1);
        expect(result.semanticValidation.status).toBe('error');
        expect(result.semanticValidation.verdicts).toEqual({});
        expect(result.passed).toBe(true);
        expect(result.violations).toEqual([]);
        expect(result.lexiconAdditions).toEqual([]);
    });
    it('a plan requiring no ID this module judges asks nothing and stays pending', async () => {
        const plan = { rows: [{ checkerId: null, invariantId: 'OUTPUT_LANGUAGE', invariant: 'required', requiresSemantic: true, applicability: 'run' }] };
        const cap = capturing('{}');
        const result = await continuityCheck(checkInput({ providers: cap.providers, workContract: EN_CONTRACT, checkerPlan: plan }));
        expect(cap.requests).toHaveLength(1);
        expect(partsOf(cap.requests[0]).user).not.toContain('semanticValidation');
        expect(result.semanticValidation.status).toBe('pending');
    });
    it('legacy empty findings never create a semantic pass', async () => {
        const cap = capturing('{}');
        const result = await continuityCheck(checkInput({ providers: cap.providers, checkerPlan: planFor(['INTRINSIC']) }));
        expect(result.passed).toBe(true);
        expect(result.semanticValidation.status).toBe('invalid');
        expect(result.semanticValidation.verdicts).toEqual({});
    });
});

// ─── context hash ──────────────────────────────────────────────────────────
describe('computeContinuityContextHash', () => {
    it('is deterministic and binds prose, delta, foundation, prevState, chapterNumber and the contract', () => {
        const input = checkInput({ workContract: JA_CONTRACT });
        const hash = computeContinuityContextHash(input);
        expect(computeContinuityContextHash(checkInput({ workContract: JA_CONTRACT }))).toBe(hash);
        expect(computeContinuityContextHash({ ...input, prose: `${PROSE} ` })).not.toBe(hash);
        expect(computeContinuityContextHash({ ...input, delta: emptyDelta(2, ['c1', 'c2']) })).not.toBe(hash);
        expect(computeContinuityContextHash({ ...input, prevState: { ...emptyStoryState('work-lang'), chapterNumber: 3 } })).not.toBe(hash);
        expect(computeContinuityContextHash({
            ...input,
            foundation: makeFoundation({
                worldFacts: [{ id: 'w1', statement: 'x' }],
                workContract: JA_CONTRACT,
                language: 'ja',
            }),
        })).not.toBe(hash);
        expect(computeContinuityContextHash(checkInput({ workContract: EN_CONTRACT }))).not.toBe(hash);
        const shapeless = { appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], hookOps: [], mutableChanges: [], trackedEntityOps: [] };
        expect(computeContinuityContextHash({ ...input, chapterNumber: 2, delta: shapeless }))
            .not.toBe(computeContinuityContextHash({ ...input, chapterNumber: 3, delta: shapeless }));
    });
    it('does not Unicode-normalize the prose', () => {
        const composed = checkInput({ prose: '가' });          // U+AC00
        const decomposed = checkInput({ prose: '가' }); // ᄀ + ᅡ
        expect(computeContinuityContextHash(composed)).not.toBe(computeContinuityContextHash(decomposed));
    });
    it('matches the hash the check prompt asks the model to echo', async () => {
        const input = checkInput({ workContract: JA_CONTRACT, checkerPlan: planFor(['INTRINSIC']) });
        const cap = capturing('{}');
        await continuityCheck({ ...input, providers: cap.providers });
        expect(partsOf(cap.requests[0]).user).toContain(`contextHash: ${computeContinuityContextHash(input)}`);
    });
});

// ─── static captures ───────────────────────────────────────────────────────
describe('continuity static prompt captures', () => {
    it('exposes both families per live step id', () => {
        expect(CONTINUITY_STATIC_PROMPT_STEPS).toEqual([
            'continuity-check', 'continuity-extract', 'continuity-extract-repair',
        ]);
        for (const id of CONTINUITY_STATIC_PROMPT_STEPS) {
            const capture = CONTINUITY_STATIC_PROMPT_CAPTURES[id];
            const ko = capture('ko');
            const multilingual = capture('multilingual');
            expect(typeof ko).toBe('string');
            expect(HANGUL.test(ko)).toBe(true);
            expect(HANGUL.test(multilingual)).toBe(false);
            expect(ko).not.toBe(multilingual);
            // 캡처는 계열 정적 문자열이다 — 작품 언어 태그나 분량 수치가 없다.
            expect(multilingual).not.toContain('BCP 47');
            expect(multilingual).not.toContain('3000');
        }
        expect(continuityExtractSystemStatic('ko')).toBe(EXTRACT_DELTA_SYSTEM);
        expect(continuityCheckSystemStatic('ko')).toBe(CONTINUITY_CHECK_SYSTEM);
        expect(continuityCheckSystemStatic('multilingual')).toBe(CONTINUITY_CHECK_SYSTEM_MULTILINGUAL);
        expect(continuityExtractRepairStatic('multilingual')).toContain('Output the whole ChapterDelta JSON again.');
        expect(() => continuityExtractSystemStatic('en')).toThrow();
        expect(CONTINUITY_STATIC_PROMPT_CAPTURES['continuity-check-semantic-repair']).toBeUndefined();
    });
});
