/**
 * performBookCreate (worldbuild + cast-design) — 다국어 Phase 2A 계열과 생성
 * 메타데이터 (최종 provider messages 기준).
 *
 * 확인하는 계약:
 *   1. 계약 없는 구형 호출은 기존 한국어 프롬프트 그대로다.
 *   2. 비ko 는 영어 설계 지시 계열이며 스키마 키·enum·id 는 동일하다.
 *   3. `chapterWordCount` 는 이름 그대로 legacyCodeUnits 목표이고, 계약과 어긋나면
 *      조용히 한쪽을 고르지 않고 거부한다.
 *   4. 명시된 `language`/`workContract` 는 Foundation 메타데이터로 보존되고,
 *      **아무것도 명시하지 않은 구형 입력은 새 키를 하나도 얻지 않는다**.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '../_support/vitest-shim.mjs';
import { FileStateStore } from '../../src/core/state-store.js';
import { DefaultOutputSanitizer } from '../../src/core/output-sanitizer.js';
import { buildLanguageContract, CANONICAL_FORMAT_VERSION_LEGACY_KO, CANONICAL_FORMAT_VERSION_MULTILINGUAL, LanguagePolicyError, } from '../../src/core/language-policy.js';
import { performChapterWriteBounded } from '../../src/generators/text/chapter-write-with-revise.js';
import { llmCastDesign } from '../../src/generators/text/steps/cast-design.js';
import { performBookCreate } from '../../src/generators/text/steps/worldbuild.js';

const HANGUL = /[가-힣]/;
const WORLD = JSON.stringify({
    premise: 'PREMISE_TOKEN 회귀한 헌터의 복수극.',
    worldFacts: [
        { id: 'wf1', statement: 'WORLDFACT_TOKEN 게이트는 10년 전 열렸다.' },
        { id: 'wf2', statement: '회귀는 단 1회만 가능하다.' },
    ],
});
const CAST = JSON.stringify({
    characters: [
        {
            id: 'c1',
            canonicalName: '서준',
            aliases: [],
            registeredAtChapter: 1,
            contradiction: '모순 한 줄.',
            intrinsic: { gender: 'male', ageBand: '20대초반', role: '주인공', coreAppearance: ['흑발'] },
            mutable: { status: 'alive', knownFacts: [] },
            relationships: [],
        },
    ],
});
function noopLogger() {
    return { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
}
function capturingCtx() {
    const requests = [];
    let call = 0;
    const responses = [WORLD, CAST];
    return {
        requests,
        ctx: {
            jobId: 'job-bc-lang',
            workId: 'work-bc-lang',
            kind: 'book-create',
            model: { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' },
            log: noopLogger(),
            providers: {
                register: () => undefined,
                has: () => true,
                async complete(req) {
                    requests.push(req);
                    const text = responses[Math.min(call, responses.length - 1)];
                    call += 1;
                    return { text, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
                },
            },
        },
    };
}
const BASE_INPUT = {
    title: 'TITLE_TOKEN',
    genre: 'regression-hunter',
    brief: 'BRIEF_TOKEN 회귀 복수극.',
    targetChapters: 50,
    chapterWordCount: 4000,
};
function partsOf(req) {
    return {
        system: req.messages.find((m) => m.role === 'system').content,
        user: req.messages.find((m) => m.role === 'user').content,
        step: req.step,
    };
}
async function capture(extra = {}) {
    const { ctx, requests } = capturingCtx();
    const { foundation } = await performBookCreate(ctx, { ...BASE_INPUT, ...extra });
    return {
        foundation,
        worldbuild: partsOf(requests[0]),
        cast: partsOf(requests[1]),
    };
}

describe('book-create — 계열', () => {
    it('구형 ko 호출은 기존 한국어 월드빌딩·캐스트 프롬프트 그대로다', async () => {
        const { worldbuild, cast } = await capture({ language: 'ko' });
        expect(worldbuild.step).toBe('worldbuild');
        expect(worldbuild.system).toContain('한국어 소설 월드빌더. JSON 만 출력. 세계 단위 사실 위주.');
        expect(worldbuild.user).toContain('너는 ko 소설의 월드빌더다.');
        // 구형 legacyCodeUnits 는 기존 '단어' 문구와 숫자를 그대로 유지한다.
        expect(worldbuild.user).toContain('- 화당 분량(어림): 4000 단어');
        expect(worldbuild.user).toContain('브리프: BRIEF_TOKEN 회귀 복수극.');
        expect(cast.step).toBe('cast-design');
        expect(cast.system).toContain('한국어 소설 초기 캐스트 디자이너. JSON 만 출력. intrinsic 핀고정 계약 준수.');
        expect(cast.user).toContain('너는 ko 소설의 초기 캐스트 디자이너다.');
        expect(cast.user).toContain('규칙 (핀고정 계약):');
        expect(cast.user).toContain('전제: PREMISE_TOKEN 회귀한 헌터의 복수극.');
    });
    it('언어도 계약도 없는 호출은 암묵적 ko 로 기존 프롬프트를 쓴다', async () => {
        const { worldbuild } = await capture();
        expect(worldbuild.user).toContain('너는 ko 소설의 월드빌더다.');
        // 지시문 줄이 붙지 않는다 — 구형 프롬프트가 그대로다.
        expect(worldbuild.system).toBe('한국어 소설 월드빌더. JSON 만 출력. 세계 단위 사실 위주.');
    });
    it('비ko 는 영어 설계 지시이며 스키마 키·enum 은 그대로다', async () => {
        const { worldbuild, cast } = await capture({ language: 'ja' });
        expect(HANGUL.test(worldbuild.system)).toBe(false);
        // 지시 라벨은 영어다. 작가 brief 같은 작품 데이터는 원문 그대로 남는다.
        expect(worldbuild.user).not.toContain('너는');
        expect(worldbuild.user).not.toContain('요구사항:');
        expect(worldbuild.user).toContain('BRIEF_TOKEN 회귀 복수극.');
        expect(worldbuild.system).toContain('Worldbuilder for a novel in the target work language.');
        expect(worldbuild.system).toContain('Target work language (BCP 47): ja.');
        expect(worldbuild.user).toContain('You are the worldbuilder for a novel written in the target work language.');
        // 계약 단위를 함께 적는다 — '단어' 라고 적고 코드 단위를 세는 상태를 막는다.
        expect(worldbuild.user).toContain('- Approximate length per chapter: 4000 legacyCodeUnits');
        expect(worldbuild.user).toContain('"worldFacts"');
        expect(worldbuild.user).toContain('{ "id": "wf1"');
        // cast 는 작품 데이터(전제·세계 사실)를 원문 그대로 싣는다.
        expect(cast.system).toContain('Initial cast designer for a novel in the target work language.');
        expect(cast.user).toContain('PREMISE_TOKEN 회귀한 헌터의 복수극.');
        expect(cast.user).toContain('WORLDFACT_TOKEN 게이트는 10년 전 열렸다.');
        expect(cast.user).toContain('"gender": "male|female|nonbinary|unknown|undisclosed|not_applicable|custom"');
        expect(cast.user).toContain('"mutable": { "status": "alive"');
        expect(cast.user).toContain('Rules (pin-on-register contract):');
    });
    it('두 LLM 단계가 같은 계약을 본다', async () => {
        const contract = buildLanguageContract({ language: 'fr', length: { unit: 'graphemes', target: 4000 } });
        const { worldbuild, cast } = await capture({ workContract: contract, chapterWordCount: null });
        for (const parts of [worldbuild, cast]) {
            expect(parts.system).toContain('Target work language (BCP 47): fr.');
            expect(parts.user).toContain('4000 graphemes');
        }
    });
    it('계약과 어긋난 언어·분량은 거부한다', async () => {
        const contract = buildLanguageContract({ language: 'fr', length: { unit: 'graphemes', target: 4000 } });
        // chapterWordCount 는 legacyCodeUnits 목표라 graphemes 계약과 충돌한다.
        await expect(capture({ workContract: contract })).rejects.toThrow(LanguagePolicyError);
        await expect(capture({ workContract: contract, chapterWordCount: null, language: 'ja' }))
            .rejects.toThrow(LanguagePolicyError);
    });
});

describe('book-create — 생성 언어 메타데이터', () => {
    it('명시 언어는 Foundation 메타데이터로 보존된다', async () => {
        const { foundation } = await capture({ language: 'ja' });
        expect(foundation.language).toBe('ja');
        expect(foundation.canonicalFormatVersion).toBe(CANONICAL_FORMAT_VERSION_MULTILINGUAL);
        expect(foundation.length).toEqual({ unit: 'legacyCodeUnits', target: 4000 });
        expect(foundation.workContract.language).toBe('ja');
        expect(foundation.workContract.length).toEqual({ unit: 'legacyCodeUnits', target: 4000 });
        // 기존 필드는 그대로 살아 있다.
        expect(foundation.workId).toBe('work-bc-lang');
        expect(foundation.characters).toHaveLength(1);
    });
    it('명시 ko 도 계약을 남기고 canonicalFormatVersion 은 구형 값이다', async () => {
        const { foundation } = await capture({ language: 'ko' });
        expect(foundation.language).toBe('ko');
        expect(foundation.canonicalFormatVersion).toBe(CANONICAL_FORMAT_VERSION_LEGACY_KO);
        expect(foundation.workContract.promptFamily).toBe('ko');
    });
    it('승인된 workContract 는 객체 그대로 보존된다', async () => {
        const contract = buildLanguageContract({ language: 'en', length: { unit: 'words', target: 900 } });
        const { foundation } = await capture({ workContract: contract, chapterWordCount: null });
        expect(foundation.workContract).toBe(contract);
        expect(foundation.language).toBe('en');
        expect(foundation.length).toEqual({ unit: 'words', target: 900 });
        expect(foundation.canonicalFormatVersion).toBe(contract.formatPolicy.canonicalFormatVersion);
    });
    it('언어도 계약도 없는 구형 입력은 새 키를 얻지 않는다', async () => {
        const { foundation } = await capture();
        expect(foundation.language).toBeUndefined();
        expect(foundation.canonicalFormatVersion).toBeUndefined();
        expect(foundation.length).toBeUndefined();
        expect(foundation.workContract).toBeUndefined();
        expect('language' in foundation).toBe(false);
        expect('workContract' in foundation).toBe(false);
    });
});

// ─── 공개 3-인자 castDesign ─────────────────────────────────────────────────
/**
 * `llmCastDesign(ctx, input, world)` 는 공개 3-인자 API 다(`engine/src/index.js` export).
 * 4번째 인자 없이도 `input.language`/`input.workContract` 로 계열이 정해져야 한다 —
 * 그러지 않으면 `language:'ja'` 공개 호출이 한국어 system 을 받는다.
 */
describe('llmCastDesign — 공개 3-인자 호출', () => {
    const WORLD = { premise: 'PREMISE_TOKEN', worldFacts: [{ id: 'wf1', statement: 'FACT_TOKEN' }] };
    function capturingProviders() {
        const requests = [];
        return {
            requests,
            providers: {
                register: () => undefined,
                has: () => true,
                async complete(req) {
                    requests.push(req);
                    return { text: CAST, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
                },
            },
        };
    }
    async function capture3(input) {
        const { providers, requests } = capturingProviders();
        await llmCastDesign({ workId: 'w', model: { provider: 'openai', modelId: 'mock' }, providers, log: noopLogger() }, input, WORLD);
        return partsOf(requests[0]);
    }
    it('input.language 만으로도 다국어 계열을 쓴다', async () => {
        const { system, user } = await capture3({ ...BASE_INPUT, language: 'ja' });
        expect(HANGUL.test(system)).toBe(false);
        expect(system).toContain('Initial cast designer for a novel in the target work language.');
        expect(system).toContain('Target work language (BCP 47): ja.');
        expect(user).toContain('You are the initial cast designer');
        expect(user).toContain('Rules (pin-on-register contract):');
        expect(user).toContain('PREMISE_TOKEN');
    });
    it('input.workContract 도 3-인자 호출에서 계열을 정한다', async () => {
        const contract = buildLanguageContract({ language: 'fr', length: { unit: 'graphemes', target: 4000 } });
        const { system, user } = await capture3({ ...BASE_INPUT, chapterWordCount: null, workContract: contract });
        expect(system).toContain('Target work language (BCP 47): fr.');
        expect(user).toContain('- Approximate length per chapter: 4000 graphemes');
    });
    it('언어도 계약도 없으면 기존 한국어 프롬프트 그대로다', async () => {
        const { system, user } = await capture3(BASE_INPUT);
        expect(system).toBe('한국어 소설 초기 캐스트 디자이너. JSON 만 출력. intrinsic 핀고정 계약 준수.');
        expect(user).toContain('너는 ko 소설의 초기 캐스트 디자이너다.');
    });
    it('4번째 인자가 input 의 명시 언어와 어긋나면 거부한다', async () => {
        const { providers } = capturingProviders();
        const ctx = { workId: 'w', model: { provider: 'openai', modelId: 'mock' }, providers, log: noopLogger() };
        await expect(llmCastDesign(ctx, { ...BASE_INPUT, language: 'ja' }, WORLD, { language: 'es' }))
            .rejects.toThrow(LanguagePolicyError);
    });
});

// ─── 생성 → 집필 상속 ───────────────────────────────────────────────────────
/**
 * 공개 경로에서 생성 때 정한 언어가 **집필 호출이 언어를 다시 넘기지 않아도**
 * 유지되는지 확인한다. 저장된 Foundation 메타데이터가 원천이며, 없던 구형 작품은
 * 기존처럼 암묵적 ko 로 남는다.
 */
describe('book-create → chapter-write 언어 상속', () => {
    let rootDir;
    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'vle-create-inherit-'));
    });
    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true });
    });
    function writeStub() {
        const calls = [];
        const prose = 'Seojun let out a slow breath.\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧';
        return {
            calls,
            providers: {
                register: () => undefined,
                has: () => true,
                async complete(req) {
                    const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
                    let kind = 'unknown';
                    let text = '{}';
                    if (sys.includes('serial-fiction chapter planner') || sys.includes('회차 기획자')) {
                        kind = 'plan';
                        text = '{"plan":"An ordinary chapter."}';
                    }
                    else if (sys.includes('serial-fiction novelist') || sys.includes('한국어 웹소설 작가')) {
                        kind = 'draft';
                        text = prose;
                    }
                    else if (sys.includes('연속성 분석기')) {
                        kind = 'extractDelta';
                    }
                    else if (sys.includes('연속성 검수기')) {
                        kind = 'continuityCheck';
                    }
                    calls.push({ kind, request: req });
                    return { text, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
                },
            },
        };
    }
    async function writeChapterWith(foundation, providers) {
        const state = new FileStateStore(rootDir);
        await state.saveFoundation(foundation);
        const ctx = {
            jobId: 'job-inherit',
            workId: foundation.workId,
            kind: 'chapter-write',
            model: { provider: 'openai', modelId: 'mock' },
            state,
            providers,
            sanitizer: new DefaultOutputSanitizer(),
            log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
        };
        await performChapterWriteBounded(ctx, { chapterNumber: 1 });
    }
    it('저장된 ja 계약을 집필이 물려받는다 — ctx 인자 없이도 ko 로 떨어지지 않는다', async () => {
        const created = await capture({ language: 'ja', chapterWordCount: 2600 });
        const { providers, calls } = writeStub();
        await writeChapterWith({ ...created.foundation, workId: 'work-inherit' }, providers);
        const draft = calls.find((c) => c.kind === 'draft').request.messages.find((m) => m.role === 'system').content;
        expect(draft).toContain('Target work language (BCP 47): ja.');
        expect(draft).toContain('2600 legacyCodeUnits');
        const plan = calls.find((c) => c.kind === 'plan').request.messages.find((m) => m.role === 'system').content;
        expect(plan).toContain('Target work language (BCP 47): ja.');
    });
    it('언어 메타데이터가 없는 구형 작품은 암묵적 ko 그대로다', async () => {
        const created = await capture();
        const { providers, calls } = writeStub();
        await writeChapterWith({ ...created.foundation, workId: 'work-legacy' }, providers);
        const draft = calls.find((c) => c.kind === 'draft').request.messages.find((m) => m.role === 'system').content;
        expect(draft).toContain('당신은 한국어 웹소설 작가이다.');
        expect(draft).not.toContain('작품 언어(BCP 47)');
    });
});
