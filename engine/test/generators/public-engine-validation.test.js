/**
 * Public engine new-contract receipt gates.
 *
 * Dedicated to consume-only commit, preparation/check, missing trust, and
 * legacy compatibility. Does not substitute character-ratio language detection.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '../_support/vitest-shim.mjs';
import { FileStateStore } from '../../src/core/state-store.js';
import { DefaultOutputSanitizer } from '../../src/core/output-sanitizer.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { buildLanguageContract } from '../../src/core/language-policy.js';
import {
    VALIDATION_ERROR_CODES,
    ValidationContractError,
    canonicalArtifact,
    computeArtifactHash,
    markReceiptConsumed,
    markReceiptStale,
} from '../../src/core/validation-contract.js';
import {
    commitPhase,
    performChapterWrite,
} from '../../src/generators/text/steps/chapter-write.js';
import {
    CleanFailError,
    performChapterWriteBounded,
} from '../../src/generators/text/chapter-write-with-revise.js';
import { prepareChapterPublication } from '../../src/generators/text/chapter-validation.js';
import { performChapterRewriteBounded } from '../../src/generators/text/chapter-rewrite-with-revise.js';
import { performBookCreate, prepareBookFoundationCandidate } from '../../src/generators/text/steps/worldbuild.js';
import { reviseFoundation } from '../../src/generators/foundation/revise-foundation.js';

function noopLogger() {
    return {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
    };
}

const registry = createGenreProfileRegistry();

function maleChar(id, name) {
    return {
        id,
        canonicalName: name,
        aliases: [],
        registeredAtChapter: 1,
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

function workContractKo(target = 500) {
    return buildLanguageContract({
        language: 'ko',
        length: { unit: 'legacyCodeUnits', target },
    });
}

function makeFoundation(workId = 'work-gate') {
    const workContract = workContractKo(500);
    return {
        workId,
        genre: 'action',
        worldFacts: [{ id: 'wf1', statement: '게이트는 10년 전 열렸다.' }],
        characters: [maleChar('c1', '서준')],
        intrinsicChanges: [],
        genreProfile: registry.get('action'),
        language: 'ko',
        workContract,
        length: workContract.length,
    };
}

const ISOLATED_PROSE = '서준은 깊은 숨을 내쉬었다. 게이트 너머에서 익숙한 기운이 새어 나오고 있었다.\n\n"드디어 시작이군."';
const ISOLATED_RAW = `${ISOLATED_PROSE}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧`;
const LEGACY_PROSE = '서준은 깊은 숨을 내쉬었다. 게이트 너머에서 익숙한 기운이 새어 나오고 있었다.\n' +
    '"드디어 시작이군." 그가 중얼거렸다.';
const LEGACY_RAW = `${LEGACY_PROSE}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧`;

function hexFrom(content, label) {
    const text = String(content ?? '');
    const labeled = text.match(new RegExp(`${label}\\s*\\n([a-f0-9]{64})`));
    if (labeled)
        return labeled[1];
    const inline = text.match(/contextHash: ([a-f0-9]{64})/);
    return inline ? inline[1] : null;
}

function languageFrom(content) {
    const text = String(content ?? '');
    const tagged = text.match(/language: ([A-Za-z0-9-]+)/);
    if (tagged)
        return tagged[1];
    const ko = text.match(/## 목표 언어\n([A-Za-z0-9-]+)/);
    if (ko)
        return ko[1];
    const en = text.match(/## Target language\n([A-Za-z0-9-]+)/);
    return en ? en[1] : 'ko';
}

async function expectCode(promise, code) {
    try {
        await promise;
        throw new Error(`expected ${code}, but the promise resolved`);
    }
    catch (err) {
        if (err instanceof Error && err.message.startsWith('expected '))
            throw err;
        expect(err).toBeInstanceOf(ValidationContractError);
        expect(err.code).toBe(code);
        return err;
    }
}

function passingSemantic(contextHash) {
    return {
        intrinsicViolations: [],
        invariantViolations: [],
        unjustifiedMutable: [],
        lexiconAdditions: [],
        semanticValidation: {
            contextHash,
            verdicts: {
                INTRINSIC: 'pass',
                POV: 'pass',
                REGISTRATION: 'pass',
                WORLD: 'pass',
            },
            evidence: [],
        },
    };
}

function stubProviders(opts = {}) {
    const calls = [];
    const continuitySequence = opts.continuityCheckSequence;
    let continuityIdx = 0;
    const reg = {
        register: () => undefined,
        has: () => true,
        async complete(req) {
            calls.push(req);
            if (typeof opts.onComplete === 'function')
                opts.onComplete(req);
            const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
            const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
            const step = req.step;
            let text = '{}';
            if (step === 'worldbuild' || sys.includes('월드빌더') || sys.includes('Worldbuilder'))
                text = opts.worldbuild ?? JSON.stringify({
                    premise: '게이트가 열린 세계에서 헌터가 산다.',
                    worldFacts: [{ id: 'wf1', statement: '게이트는 10년 전 열렸다.' }],
                });
            else if (step === 'cast-design' || sys.includes('캐스트 디자이너') || sys.includes('cast designer'))
                text = opts.cast ?? JSON.stringify({
                    characters: [maleChar('c1', '서준')],
                });
            else if (step === 'chapter-plan' || sys.includes('회차 기획자') || sys.includes('chapter planner'))
                text = opts.plan ?? '{"plan":"이번 회차는 게이트 앞에서 숨을 고른다."}';
            else if (step === 'draft' || sys.includes('한국어 웹소설 작가') || sys.includes('serial-fiction novelist'))
                text = opts.draft ?? ISOLATED_RAW;
            else if (step === 'continuity-extract' || step === 'continuity-extract-repair'
                || sys.includes('연속성 분석기') || sys.includes('continuity analyser')) {
                const contextHash = hexFrom(user, 'contextHash');
                text = opts.extractDelta ?? JSON.stringify({
                    newAddressEntries: [],
                    relationshipOps: [],
                    hookOps: [],
                    mutableChanges: [],
                    influenceEvents: [],
                    trackedEntityOps: [],
                    noInfluenceReason: '이번 회차에는 인물의 선택·비용·인식·관계 변화가 본문에 없다.',
                    extractionValidation: { contextHash },
                });
            }
            else if (step === 'continuity-check' || step === 'continuity-check-semantic-repair'
                || sys.includes('연속성 검수기') || sys.includes('continuity reviewer')) {
                const contextHash = hexFrom(user, 'contextHash') ?? hexFrom(user, '## 의미 검증');
                let payload;
                if (continuitySequence) {
                    const i = Math.min(continuityIdx, continuitySequence.length - 1);
                    continuityIdx += 1;
                    payload = continuitySequence[i];
                    if (payload && payload.semanticValidation && contextHash)
                        payload = {
                            ...payload,
                            semanticValidation: { ...payload.semanticValidation, contextHash },
                        };
                }
                else {
                    payload = passingSemantic(contextHash);
                    const declared = user.match(/(?:판정한다|these invariants): ([A-Z, ]+)\./);
                    if (declared) payload.semanticValidation.verdicts = Object.fromEntries(
                        declared[1].split(', ').map((id) => [id, 'pass']));
                }
                text = JSON.stringify(payload);
            }
            else if (step === 'chapter-title-summary' || sys.includes('회차 제목과 요약') || sys.includes('chapter title and summary'))
                text = opts.titleSummary ?? JSON.stringify({
                    title: '문 너머',
                    summary: '서준이 게이트 앞에서 숨을 고른다.',
                });
            else if (step === 'output-language-compliance' || sys.includes('출력 언어를 판정') || sys.includes('judge the output language')) {
                const artifactHash = hexFrom(user, '## artifactHash');
                const language = languageFrom(user);
                if (opts.languageVerdict === 'uncertain') {
                    text = JSON.stringify({
                        verdict: 'uncertain',
                        artifactHash,
                        language,
                        evidence: [],
                        allowedExceptions: [],
                    });
                }
                else if (opts.languageVerdict === 'fail') {
                    text = JSON.stringify({
                        verdict: 'fail',
                        artifactHash,
                        language,
                        evidence: [{
                            fieldPath: 'prose',
                            quote: '서준은 깊은 숨을 내쉬었다',
                            reason: '목표 언어와 다른 표현이 본문에 있다',
                        }],
                        allowedExceptions: [],
                    });
                }
                else {
                    text = JSON.stringify({
                        verdict: 'pass',
                        artifactHash,
                        language,
                        evidence: [],
                        allowedExceptions: [],
                    });
                }
            }
            else if (step === 'rewrite')
                text = opts.rewrite ?? ISOLATED_RAW;
            else if (sys.includes('한국어 웹소설 교정자') || step === 'revise')
                text = opts.revise ?? ISOLATED_RAW;
            else if (step === 'revise-foundation' || sys.includes('토대'))
                text = opts.reviseFoundation ?? JSON.stringify({
                    worldFacts: [{ id: 'wf1', statement: '게이트는 10년 전 열렸다.' }],
                    updatedCharacters: [],
                    newCharacters: [],
                });
            return { text, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
        },
    };
    return { providers: reg, calls };
}

async function makeCtx(opts) {
    const workId = opts.workId ?? 'work-gate';
    const ctx = {
        jobId: 'job-gate',
        workId,
        kind: opts.kind ?? 'chapter-write',
        model: { provider: 'openai', modelId: 'mock-2026-05-20' },
        state: opts.state ?? new FileStateStore(opts.rootDir),
        providers: opts.providers,
        sanitizer: new DefaultOutputSanitizer(),
        log: opts.log ?? noopLogger(),
    };
    if (opts.validationEpoch != null)
        ctx.validationEpoch = opts.validationEpoch;
    if (opts.workflowId != null)
        ctx.workflowId = opts.workflowId;
    if (opts.runId != null)
        ctx.runId = opts.runId;
    if (opts.workContract != null)
        ctx.workContract = opts.workContract;
    return ctx;
}

describe('public engine new-contract gates', () => {
    let rootDir;
    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'vle-public-gate-'));
    });
    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true });
    });

    it('legacy metadata-less write still persists without a receipt', async () => {
        const { providers, calls } = stubProviders({ draft: LEGACY_RAW });
        const ctx = await makeCtx({ rootDir, providers, workId: 'work-legacy' });
        const foundation = {
            workId: 'work-legacy',
            genre: 'action',
            worldFacts: [],
            characters: [maleChar('c1', '서준')],
            intrinsicChanges: [],
            genreProfile: registry.get('action'),
        };
        await ctx.state.saveFoundation(foundation);
        const { artifact } = await performChapterWrite(ctx, { chapterNumber: 1 });
        expect(artifact.prose).toContain('서준은 깊은 숨을 내쉬었다.');
        expect(artifact.validationReceipt).toBeUndefined();
        expect(await ctx.state.loadArtifact('work-legacy', 1)).not.toBeNull();
        expect(calls.some((req) => req.step === 'output-language-compliance')).toBe(false);
    });

    it('new-contract commitPhase without receipt fails MISSING_VALIDATION_RECEIPT before provider or save', async () => {
        const { providers, calls } = stubProviders();
        const ctx = await makeCtx({
            rootDir, providers, validationEpoch: 1, workflowId: 'wf-1',
        });
        const foundation = makeFoundation();
        await ctx.state.saveFoundation(foundation);
        const saves = [];
        const origSave = ctx.state.saveArtifact.bind(ctx.state);
        ctx.state.saveArtifact = async (artifact) => {
            saves.push(artifact);
            return origSave(artifact);
        };
        const before = calls.length;
        await expectCode(commitPhase(ctx, {
            prose: ISOLATED_RAW,
            foundation,
            prevState: emptyStoryState(ctx.workId),
            chapterNumber: 1,
            plan: '게이트 앞',
        }), VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT);
        expect(calls.length).toBe(before);
        expect(saves).toHaveLength(0);
        expect(await ctx.state.loadArtifact(ctx.workId, 1)).toBeNull();
    });

    it('rejects absent trusted identity instead of copying it from a receipt', async () => {
        const { providers } = stubProviders();
        const ctx = await makeCtx({ rootDir, providers, validationEpoch: 1 });
        await ctx.state.saveFoundation(makeFoundation());
        await expectCode(performChapterWrite(ctx, { chapterNumber: 1 }), VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION);
        expect(await ctx.state.loadArtifact(ctx.workId, 1)).toBeNull();
    });

    it('integrated new-contract public write succeeds with structured mocks and publishes exact checked fields', async () => {
        const { providers, calls } = stubProviders();
        const foundation = makeFoundation();
        const ctx = await makeCtx({
            rootDir, providers, validationEpoch: 1, workflowId: 'wf-write', workContract: foundation.workContract,
        });
        await ctx.state.saveFoundation(foundation);
        const { artifact } = await performChapterWrite(ctx, { chapterNumber: 1 });
        expect(artifact.title).toBe('문 너머');
        expect(artifact.summary).toBe('서준이 게이트 앞에서 숨을 고른다.');
        expect(artifact.prose).toBe(ISOLATED_PROSE);
        expect(artifact.prose).not.toContain('⟦vle:');
        expect(artifact.validationReceipt.consumed).toBe(true);
        expect(artifact.validationReceipt.stale).toBe(false);
        expect(artifact.validationReceipt.sourceHead).toBeNull();
        expect(artifact.validationReceipt.chapter).toBe(1);
        expect(artifact.validationReceipt.workId).toBe('work-gate');
        const saved = await ctx.state.loadArtifact('work-gate', 1);
        expect(saved.prose).toBe(artifact.prose);
        expect(saved.title).toBe(artifact.title);
        expect(calls.some((req) => req.step === 'output-language-compliance')).toBe(true);
        expect(calls.some((req) => req.step === 'chapter-title-summary')).toBe(true);
        const languageSys = calls.find((req) => req.step === 'output-language-compliance').messages
            .find((m) => m.role === 'system').content;
        expect(languageSys).toContain('문자 비율이나 문자 체계를 세어 언어를 추측하지 않는다');
    });

    for (const manifest of ['not valid JSON', '{"cast":[{"characterId":"unknown"}]}']) {
        it(`does not issue a receipt for invalid publication manifest: ${manifest}`, async () => {
            const { providers } = stubProviders();
            const foundation = makeFoundation();
            const ctx = await makeCtx({ rootDir, providers, validationEpoch: 1, workflowId: 'wf-manifest' });
            await ctx.state.saveFoundation(foundation);
            const savedJobs = [];
            const saveJob = ctx.state.saveJob.bind(ctx.state);
            ctx.state.saveJob = async (job) => { savedJobs.push(job); return saveJob(job); };
            const error = await expectCode(prepareChapterPublication(ctx, {
                prose: `${ISOLATED_PROSE}\n\n⟦vle:cast-manifest ${manifest}⟧`,
                foundation, prevState: emptyStoryState(ctx.workId), chapterNumber: 1, plan: '게이트 앞',
            }), VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE);
            expect(JSON.stringify(error.details.blocked)).toContain('SCHEMA');
            expect(savedJobs.some(job => job.receipt != null || job.status === 'checked')).toBe(false);
            expect(await ctx.state.loadArtifact(ctx.workId, 1)).toBeNull();
        });
    }

    it('preserves explicit empty manifest and rechecks manifest schema at consume without models', async () => {
        const { providers, calls } = stubProviders();
        const foundation = makeFoundation();
        const ctx = await makeCtx({ rootDir, providers, validationEpoch: 1, workflowId: 'wf-empty-manifest' });
        await ctx.state.saveFoundation(foundation);
        const prepared = await prepareChapterPublication(ctx, {
            prose: ISOLATED_PROSE, foundation, prevState: emptyStoryState(ctx.workId),
            chapterNumber: 1, plan: '게이트 앞',
        });
        expect(prepared.canonical.castManifestRaw).toBe('');
        const before = calls.length;
        const invalid = await expectCode(commitPhase(ctx, {
            chapterNumber: 1, validationReceipt: prepared.receipt,
            canonical: { ...prepared.canonical, castManifestRaw: 'invalid JSON' },
        }), VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE);
        expect(invalid.details.invariantId).toBe('SCHEMA');
        expect(await ctx.state.loadArtifact(ctx.workId, 1)).toBeNull();
        const result = await commitPhase(ctx, {
            chapterNumber: 1, validationReceipt: prepared.receipt, canonical: prepared.canonical,
        });
        expect(result.artifact.castManifestRaw).toBe('');
        expect(calls.length).toBe(before);
    });

    it('valid checked bundle consumes with zero provider calls', async () => {
        const { providers } = stubProviders();
        const foundation = makeFoundation();
        const ctx = await makeCtx({
            rootDir, providers, validationEpoch: 2, workflowId: 'wf-consume', workContract: foundation.workContract,
        });
        await ctx.state.saveFoundation(foundation);
        const { artifact } = await performChapterWrite(ctx, { chapterNumber: 1 });
        const counted = [];
        ctx.providers = {
            register: () => undefined,
            has: () => true,
            async complete(req) {
                counted.push(req);
                throw new Error(`provider must not run on consume: ${req.step}`);
            },
        };
        ctx.validationEpoch = 2;
        await expectCode(commitPhase(ctx, {
            foundation,
            prevState: emptyStoryState(ctx.workId),
            chapterNumber: 1,
            plan: '이번 회차는 게이트 앞에서 숨을 고른다.',
            validationReceipt: artifact.validationReceipt,
            canonical: canonicalArtifact({
                prose: artifact.prose,
                title: artifact.title,
                summary: artifact.summary,
                semanticDelta: artifact.delta,
                castManifestRaw: artifact.castManifestRaw,
            }),
        }), VALIDATION_ERROR_CODES.RECEIPT_ALREADY_CONSUMED);
        expect(counted).toHaveLength(0);
    });

    it('consume of an unconsumed matching bundle makes no provider calls', async () => {
        const { providers } = stubProviders();
        const foundation = makeFoundation('work-reuse');
        const ctx = await makeCtx({
            rootDir, providers, workId: 'work-reuse', validationEpoch: 3, workflowId: 'wf-reuse',
            workContract: foundation.workContract,
        });
        await ctx.state.saveFoundation(foundation);
        const first = await performChapterWrite(ctx, { chapterNumber: 1 });
        const live = first.artifact.validationReceipt;
        // Rebuild a sibling work to obtain an unconsumed receipt then consume it
        // through commitPhase with a throwing provider.
        const root2 = await mkdtemp(join(tmpdir(), 'vle-public-gate-b-'));
        try {
            const { providers: p2 } = stubProviders();
            const ctx2 = await makeCtx({
                rootDir: root2, providers: p2, workId: 'work-reuse2', validationEpoch: 4, workflowId: 'wf-reuse2',
                workContract: foundation.workContract,
            });
            const foundation2 = { ...makeFoundation('work-reuse2') };
            await ctx2.state.saveFoundation(foundation2);
            const prepared = await performChapterWrite(ctx2, { chapterNumber: 1 });
            const unconsumed = { ...prepared.artifact.validationReceipt, consumed: false };
            unconsumed.checkId = prepared.artifact.validationReceipt.checkId;
            const counted = [];
            ctx2.providers = {
                register: () => undefined,
                has: () => true,
                async complete(req) {
                    counted.push(req.step);
                    throw new Error('consume-only');
                },
            };
            // The persisted artifact already exists from the first write; consuming
            // the same receipt again must fail as consumed without provider calls.
            await expectCode(commitPhase(ctx2, {
                foundation: foundation2,
                prevState: emptyStoryState('work-reuse2'),
                chapterNumber: 1,
                plan: '이번 회차는 게이트 앞에서 숨을 고른다.',
                validationReceipt: prepared.artifact.validationReceipt,
                canonical: canonicalArtifact({
                    prose: prepared.artifact.prose,
                    title: prepared.artifact.title,
                    summary: prepared.artifact.summary,
                    semanticDelta: prepared.artifact.delta,
                    castManifestRaw: prepared.artifact.castManifestRaw,
                }),
            }), VALIDATION_ERROR_CODES.RECEIPT_ALREADY_CONSUMED);
            expect(counted).toHaveLength(0);
            expect(live.consumed).toBe(true);
        }
        finally {
            await rm(root2, { recursive: true, force: true });
        }
    });

    it('modified title/summary/delta/body are rejected before save', async () => {
        const { providers } = stubProviders();
        const foundation = makeFoundation('work-mut');
        const ctx = await makeCtx({
            rootDir, providers, workId: 'work-mut', validationEpoch: 1, workflowId: 'wf-mut',
            workContract: foundation.workContract,
        });
        await ctx.state.saveFoundation(foundation);
        const { artifact } = await performChapterWrite(ctx, { chapterNumber: 1 });
        const receipt = { ...artifact.validationReceipt, consumed: false };
        receipt.checkId = artifact.validationReceipt.checkId;
        const counted = [];
        ctx.providers = {
            register: () => undefined,
            has: () => true,
            async complete(req) {
                counted.push(req.step);
                throw new Error('no provider');
            },
        };
        const base = {
            prose: artifact.prose,
            title: artifact.title,
            summary: artifact.summary,
            semanticDelta: artifact.delta,
            castManifestRaw: artifact.castManifestRaw,
        };
        const cases = [
            { title: '다른 제목' },
            { summary: '다른 요약이다.' },
            { prose: `${artifact.prose} 추가.` },
            { semanticDelta: { ...artifact.delta, noInfluenceReason: 'changed' } },
        ];
        for (const patch of cases) {
            await expect(commitPhase(ctx, {
                foundation,
                prevState: emptyStoryState('work-mut'),
                chapterNumber: 1,
                plan: '이번 회차는 게이트 앞에서 숨을 고른다.',
                validationReceipt: receipt,
                canonical: canonicalArtifact({ ...base, ...patch }),
            })).rejects.toBeInstanceOf(ValidationContractError);
        }
        expect(counted).toHaveLength(0);
    });

    it('stale receipt cannot be resurrected and is rejected before save', async () => {
        const { providers } = stubProviders();
        const foundation = makeFoundation('work-stale');
        const ctx = await makeCtx({
            rootDir, providers, workId: 'work-stale', validationEpoch: 1, workflowId: 'wf-stale',
            workContract: foundation.workContract,
        });
        await ctx.state.saveFoundation(foundation);
        const { artifact } = await performChapterWrite(ctx, { chapterNumber: 1 });
        const stale = markReceiptStale({ ...artifact.validationReceipt, consumed: false }, 'contract_drift');
        const counted = [];
        ctx.providers = {
            register: () => undefined,
            has: () => true,
            async complete(req) {
                counted.push(req.step);
                throw new Error('no provider');
            },
        };
        await expectCode(commitPhase(ctx, {
            foundation,
            prevState: emptyStoryState('work-stale'),
            chapterNumber: 1,
            plan: '이번 회차는 게이트 앞에서 숨을 고른다.',
            validationReceipt: stale,
            canonical: canonicalArtifact({
                prose: artifact.prose,
                title: artifact.title,
                summary: artifact.summary,
                semanticDelta: artifact.delta,
                castManifestRaw: artifact.castManifestRaw,
            }),
        }), VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT);
        expect(counted).toHaveLength(0);
    });

    it('uncertain language blocks every path before save', async () => {
        const { providers } = stubProviders({ languageVerdict: 'uncertain' });
        const foundation = makeFoundation('work-unc');
        const ctx = await makeCtx({
            rootDir, providers, workId: 'work-unc', validationEpoch: 1, workflowId: 'wf-unc',
            workContract: foundation.workContract,
        });
        await ctx.state.saveFoundation(foundation);
        await expectCode(performChapterWrite(ctx, { chapterNumber: 1 }), VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE);
        expect(await ctx.state.loadArtifact('work-unc', 1)).toBeNull();
    });

    it('mandatory semantic skip/uncertain is not a pass and is rejected before save', async () => {
        const { providers } = stubProviders({
            continuityCheckSequence: [{
                intrinsicViolations: [],
                semanticValidation: {
                    contextHash: 'will-be-replaced',
                    verdicts: {
                        INTRINSIC: 'uncertain',
                        POV: 'pass',
                        REGISTRATION: 'pass',
                        WORLD: 'pass',
                    },
                    evidence: [],
                },
            }],
        });
        const foundation = makeFoundation('work-skip');
        const ctx = await makeCtx({
            rootDir, providers, workId: 'work-skip', validationEpoch: 1, workflowId: 'wf-skip',
            workContract: foundation.workContract,
        });
        await ctx.state.saveFoundation(foundation);
        await expectCode(performChapterWrite(ctx, { chapterNumber: 1 }), VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE);
        expect(await ctx.state.loadArtifact('work-skip', 1)).toBeNull();
    });

    it('changed sourceHead or contract is rejected before save', async () => {
        const { providers } = stubProviders();
        const foundation = makeFoundation('work-src');
        const ctx = await makeCtx({
            rootDir, providers, workId: 'work-src', validationEpoch: 1, workflowId: 'wf-src',
            workContract: foundation.workContract,
        });
        await ctx.state.saveFoundation(foundation);
        const { artifact } = await performChapterWrite(ctx, { chapterNumber: 1 });
        const receipt = { ...artifact.validationReceipt, consumed: false };
        receipt.checkId = artifact.validationReceipt.checkId;
        const counted = [];
        ctx.providers = {
            register: () => undefined,
            has: () => true,
            async complete(req) {
                counted.push(req.step);
                throw new Error('no provider');
            },
        };
        ctx.workContract = buildLanguageContract({
            language: 'ko',
            length: { unit: 'legacyCodeUnits', target: 499 },
        });
        await expect(commitPhase(ctx, {
            foundation: { ...foundation, workContract: ctx.workContract, length: ctx.workContract.length },
            prevState: emptyStoryState('work-src'),
            chapterNumber: 1,
            plan: '이번 회차는 게이트 앞에서 숨을 고른다.',
            validationReceipt: receipt,
            canonical: canonicalArtifact({
                prose: artifact.prose,
                title: artifact.title,
                summary: artifact.summary,
                semanticDelta: artifact.delta,
                castManifestRaw: artifact.castManifestRaw,
            }),
        })).rejects.toBeInstanceOf(ValidationContractError);
        expect(counted).toHaveLength(0);
    });

    it('bounded loop still exhausts after 3 continuity errors on the new-contract path', async () => {
        const { providers, calls } = stubProviders({
            continuityCheckSequence: [
                { intrinsicViolations: [{ characterId: 'c1', message: '성별 충돌 1' }] },
                { intrinsicViolations: [{ characterId: 'c1', message: '성별 충돌 2' }] },
                { intrinsicViolations: [{ characterId: 'c1', message: '성별 충돌 3' }] },
            ],
        });
        const foundation = makeFoundation('work-bound');
        const ctx = await makeCtx({
            rootDir, providers, workId: 'work-bound', validationEpoch: 1, workflowId: 'wf-bound',
            workContract: foundation.workContract,
        });
        await ctx.state.saveFoundation(foundation);
        let caught;
        try {
            await performChapterWriteBounded(ctx, { chapterNumber: 1 });
        }
        catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(CleanFailError);
        expect(caught.attempts).toBe(3);
        expect(caught.violations[0].code).toBe('INTRINSIC_VIOLATION');
        expect(await ctx.state.loadArtifact('work-bound', 1)).toBeNull();
        expect(calls.filter((req) => req.step === 'continuity-check' || (req.messages?.[0]?.content ?? '').includes('연속성 검수기')).length)
            .toBeGreaterThanOrEqual(3);
    });

    it('stored contract cannot bypass the gate by omitting all validation arguments', async () => {
        const { providers, calls } = stubProviders();
        const ctx = await makeCtx({ rootDir, providers });
        const foundation = makeFoundation();
        await ctx.state.saveFoundation(foundation);
        await expectCode(commitPhase(ctx, {
            foundation: {}, prose: ISOLATED_RAW, chapterNumber: 1,
            prevState: emptyStoryState(ctx.workId),
        }), VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT);
        expect(calls).toHaveLength(0);
        expect(await ctx.state.loadArtifact(ctx.workId, 1)).toBeNull();
    });

    it('prepared receipt consumes once with persisted full proof and zero providers', async () => {
        const { providers, calls } = stubProviders();
        const foundation = makeFoundation();
        const ctx = await makeCtx({ rootDir, providers, validationEpoch: 1, workflowId: 'wf-proof' });
        await ctx.state.saveFoundation(foundation);
        const args = { foundation, prose: ISOLATED_RAW, chapterNumber: 1,
            prevState: emptyStoryState(ctx.workId), plan: 'A checked plan' };
        const prepared = await prepareChapterPublication(ctx, args);
        expect(prepared.ok).toBe(true);
        expect(await ctx.state.loadArtifact(ctx.workId, 1)).toBeNull();
        const count = calls.length;
        ctx.providers = { complete: () => { throw new Error('Provider called during consume'); } };
        const consumeArgs = { ...args, canonical: prepared.canonical, validationReceipt: prepared.receipt };
        const result = await commitPhase(ctx, consumeArgs);
        expect(result.artifact.prose).toBe(prepared.canonical.prose);
        expect(result.artifact.title).toBe(prepared.canonical.title);
        expect(result.artifact.summary).toBe(prepared.canonical.summary);
        expect(result.artifact.delta).toEqual(prepared.canonical.semanticDelta);
        expect(calls.length).toBe(count);
        // Caller resets the receipt flag; current persisted state still rejects replay.
        await expectCode(commitPhase(ctx, { ...consumeArgs,
            validationReceipt: { ...prepared.receipt, consumed: false } }),
            VALIDATION_ERROR_CODES.RECEIPT_ALREADY_CONSUMED);
    });

    it('modified candidate fields cannot use the original unconsumed receipt', async () => {
        const { providers } = stubProviders();
        const foundation = makeFoundation();
        const ctx = await makeCtx({ rootDir, providers, validationEpoch: 1, workflowId: 'wf-edit' });
        await ctx.state.saveFoundation(foundation);
        const args = { foundation, prose: ISOLATED_RAW, chapterNumber: 1,
            prevState: emptyStoryState(ctx.workId), plan: 'A checked plan' };
        const prepared = await prepareChapterPublication(ctx, args);
        ctx.providers = { complete: () => { throw new Error('Provider called during consume'); } };
        for (const field of ['prose', 'title', 'summary', 'castManifestRaw']) {
            await expectCode(commitPhase(ctx, { ...args, validationReceipt: prepared.receipt,
                canonical: { ...prepared.canonical, [field]: prepared.canonical[field] + (field === 'castManifestRaw' ? ' ' : ' changed') } }),
                VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH);
        }
        expect(await ctx.state.loadArtifact(ctx.workId, 1)).toBeNull();
    });

    it('edited world facts invalidate a prepared receipt even when language and prose are unchanged', async () => {
        const { providers } = stubProviders();
        const foundation = makeFoundation();
        const ctx = await makeCtx({ rootDir, providers, validationEpoch: 1, workflowId: 'wf-world' });
        await ctx.state.saveFoundation(foundation);
        const args = { foundation, prose: ISOLATED_RAW, chapterNumber: 1,
            prevState: emptyStoryState(ctx.workId), plan: 'A checked plan' };
        const prepared = await prepareChapterPublication(ctx, args);
        await ctx.state.saveFoundation({ ...foundation, worldFacts: [{ id: 'wf1', statement: 'The gate never opened.' }] });
        await expectCode(commitPhase(ctx, { ...args, identity: prepared.identity,
            canonical: prepared.canonical, validationReceipt: prepared.receipt }),
            VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT);
        expect(await ctx.state.loadArtifact(ctx.workId, 1)).toBeNull();
    });

    it('new-contract attempts cannot reset the three-attempt budget by resuming the same epoch', async () => {
        const { providers, calls } = stubProviders({ languageVerdict: 'uncertain' });
        const foundation = makeFoundation();
        const ctx = await makeCtx({ rootDir, providers, validationEpoch: 1, workflowId: 'wf-budget' });
        await ctx.state.saveFoundation(foundation);
        const args = { foundation, prose: ISOLATED_RAW, chapterNumber: 1,
            prevState: emptyStoryState(ctx.workId), plan: 'A checked plan' };
        for (let i = 0; i < 3; i++) await expectCode(prepareChapterPublication(ctx, args),
            VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE);
        const count = calls.length;
        const error = await expectCode(prepareChapterPublication(ctx, args), VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE);
        expect(error.details.reason).toBe('validation_budget_exhausted');
        expect(calls.length).toBe(count);
    });

    it('length overshoot alone does not force a revision or block the receipt', async () => {
        const { providers, calls } = stubProviders();
        const foundation = makeFoundation();
        foundation.workContract = workContractKo(10);
        foundation.length = foundation.workContract.length;
        const ctx = await makeCtx({ rootDir, providers, validationEpoch: 1, workflowId: 'wf-length' });
        await ctx.state.saveFoundation(foundation);
        const result = await performChapterWriteBounded(ctx, { chapterNumber: 1 });
        expect(result.artifact.prose.length).toBeGreaterThan(10);
        expect(calls.filter((call) => call.step === 'revise')).toHaveLength(0);
    });

    it('public rewrite prepares a fresh checked candidate before consume', async () => {
        const { providers, calls } = stubProviders();
        const foundation = makeFoundation();
        const ctx = await makeCtx({ rootDir, providers, validationEpoch: 1, workflowId: 'wf-rewrite' });
        await ctx.state.saveFoundation(foundation);
        await performChapterWrite(ctx, { chapterNumber: 1 });
        ctx.validationEpoch = 2;
        const result = await performChapterRewriteBounded(ctx, {
            chapterNumber: 1, previousProse: ISOLATED_PROSE, intentSummary: 'Make the scene vivid',
        });
        expect(result.artifact.validationReceipt.consumed).toBe(true);
        expect(result.artifact.validationReceipt.validationEpoch).toBe(2);
        expect(calls.some((call) => call.step === 'rewrite')).toBe(true);
    });

    for (const [language, prose, title, summary] of [
        ['en', 'Alex opened the gate. “Welcome,” he said.', 'The gate', 'Alex opens a gate.'],
        ['ja', 'アレックスは門を開いた。「ようこそ」と言った。', '門', 'アレックスは門を開く。'],
    ]) {
        it(`${language} public write and rewrite retain target language and natural dialogue`, async () => {
            const raw = prose + '\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧';
            const { providers, calls } = stubProviders({ draft: raw, rewrite: raw,
                titleSummary: JSON.stringify({ title, summary }) });
            const foundation = makeFoundation();
            foundation.workContract = buildLanguageContract({ language,
                length: { unit: language === 'en' ? 'words' : 'graphemes', target: 5 }, dialogueBreakMode: 'natural' });
            foundation.language = language;
            foundation.length = foundation.workContract.length;
            const ctx = await makeCtx({ rootDir, providers, validationEpoch: 1, workflowId: 'wf-locale' });
            ctx.qualityThreshold = { prosody: 100, coherence: null };
            await ctx.state.saveFoundation(foundation);
            const created = await performChapterWrite(ctx, { chapterNumber: 1 });
            expect(created.artifact.prose).toBe(prose);
            expect(created.artifact.title).toBe(title);
            ctx.validationEpoch = 2;
            const rewritten = await performChapterRewriteBounded(ctx, {
                chapterNumber: 1, previousProse: prose, intentSummary: 'Preserve the encounter',
            });
            expect(rewritten.artifact.prose).toBe(prose);
            expect(rewritten.artifact.validationReceipt.consumed).toBe(true);
            const semantic = calls.find((call) => call.step === 'continuity-check');
            expect(semantic.messages[1].content).toContain('FORMAT');
            expect(calls.filter((call) => call.step === 'revise')).toHaveLength(0);
        });
    }

    it('candidate builder generates without approving; public activation still requires trusted identity', async () => {
        const { providers, calls } = stubProviders();
        const ctx = await makeCtx({ rootDir, providers, kind: 'book-create' });
        const input = { title: 'A work', genre: 'regression-hunter', language: 'en', targetChapters: 20 };
        const candidate = await prepareBookFoundationCandidate(ctx, input);
        expect(candidate.foundation.workContract.language).toBe('en');
        expect(candidate.validationReceipt).toBeUndefined();
        expect(calls.some((req) => req.step === 'output-language-compliance')).toBe(false);
        await expectCode(performBookCreate(ctx, input), VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION);
    });

    it('foundation new-contract activation returns an approval receipt and does not invent chapter fields', async () => {
        const { providers } = stubProviders();
        const ctx = await makeCtx({
            rootDir, providers, workId: 'work-found', kind: 'book-create',
            validationEpoch: 1, workflowId: 'wf-found',
        });
        const created = await performBookCreate(ctx, {
            title: '강철의 회귀자',
            genre: 'regression-hunter',
            brief: '회귀한 헌터의 복수극.',
            targetChapters: 50,
            language: 'ko',
            chapterWordCount: 400,
            validationEpoch: 1,
            workflowId: 'wf-found',
        });
        expect(created.foundation.language).toBe('ko');
        expect(created.canonicalApprovalArtifact.artifactKind).toBe('approval');
        expect(created.canonicalApprovalArtifact.approvalKind).toBe('foundation');
        expect(created.canonicalApprovalArtifact.prose).toBeUndefined();
        expect(created.validationReceipt.chapter).toBeNull();
        expect(created.validationReceipt.sourceHead).toBeNull();
        expect(created.validationReceipt.consumed).toBe(false);
    });

    it('legacy book-create without a validation epoch keeps the old output shape', async () => {
        const { providers } = stubProviders();
        const ctx = await makeCtx({ rootDir, providers, workId: 'work-found-legacy', kind: 'book-create' });
        const created = await performBookCreate(ctx, {
            title: '강철의 회귀자',
            genre: 'regression-hunter',
            brief: '회귀한 헌터의 복수극.',
            targetChapters: 50,
            chapterWordCount: 4000,
        });
        expect(created.foundation.language).toBeUndefined();
        expect(created.validationReceipt).toBeUndefined();
        expect(created.canonicalApprovalArtifact).toBeUndefined();
    });

    it('revise-foundation new-contract returns a language-validated approval artifact', async () => {
        const { providers } = stubProviders();
        const current = makeFoundation('work-rev');
        const result = await reviseFoundation({
            current,
            feedback: '세계 사실을 유지하라.',
            providers,
            model: { provider: 'openai', modelId: 'mock' },
            validationEpoch: 1,
            workflowId: 'wf-rev',
            workContract: current.workContract,
        });
        expect(result.foundation.workId).toBe('work-rev');
        expect(result.canonicalApprovalArtifact.approvalKind).toBe('foundation');
        expect(result.validationReceipt.artifactKind).toBe('approval');
    });
});
