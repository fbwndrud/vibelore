/**
 * P4b (#516, Epic #511) — Codex 편집/멘션 컨텍스트 주입 테스트.
 *
 * Covers:
 *   - draft prompt: disabled 캐릭터 제외 + contradiction(한 줄 소개) 포함.
 *   - rewrite prompt: entityContextRender 섹션 유/무 + disabled 캐릭터 제외.
 *   - draftPhase: 직전 화 prose 멘션 → entity activation (scene declaration
 *     미선언이어도 prompt 도달).
 *   - performChapterRewriteBounded: 원본 prose 멘션 → rewrite prompt 의
 *     entity 섹션 도달.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '../_support/vitest-shim.mjs';
import { FileStateStore, } from '../../src/core/state-store.js';
import { DefaultOutputSanitizer } from '../../src/core/output-sanitizer.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { __buildUserPromptForTest } from '../../src/generators/text/steps/draft.js';
import { buildRewriteUserPrompt } from '../../src/generators/text/prompts/rewrite.js';
import { draftPhase } from '../../src/generators/text/steps/chapter-write.js';
import { performChapterRewriteBounded } from '../../src/generators/text/chapter-rewrite-with-revise.js';
const registry = createGenreProfileRegistry();
function noopLogger() {
    return {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
    };
}
function char(id, name, overrides = {}) {
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
        ...overrides,
    };
}
function makeFoundation(workId, characters) {
    return {
        workId,
        genre: 'action',
        worldFacts: [],
        characters,
        intrinsicChanges: [],
        genreProfile: registry.get('action'),
    };
}
// ─── prompt-level units ─────────────────────────────────────────────────────
describe('draft prompt — Codex disabled/contradiction', () => {
    it('disabled 캐릭터는 Foundation 요약에서 제외', () => {
        const foundation = makeFoundation('w1', [
            char('c1', '서준'),
            char('c2', '하린', { disabled: true }),
        ]);
        const prompt = __buildUserPromptForTest({
            foundation,
            prevState: emptyStoryState('w1'),
            chapterNumber: 2,
            plan: '평범한 회차',
            providers: {},
            model: { provider: 'openai', modelId: 'mock' },
        });
        expect(prompt).toContain('서준');
        expect(prompt).not.toContain('하린');
    });
    it('contradiction 이 있으면 캐릭터 요약에 포함, 없으면 키 생략', () => {
        const foundation = makeFoundation('w1', [
            char('c1', '서준', { contradiction: '모범생이지만 비밀리에 빈집털이' }),
            char('c2', '하린'),
        ]);
        const prompt = __buildUserPromptForTest({
            foundation,
            prevState: emptyStoryState('w1'),
            chapterNumber: 2,
            plan: '평범한 회차',
            providers: {},
            model: { provider: 'openai', modelId: 'mock' },
        });
        expect(prompt).toContain('모범생이지만 비밀리에 빈집털이');
        // c2 (contradiction 없음) 쪽 직렬화에는 키 자체가 없어야 함 — 한 번만 등장.
        expect(prompt.match(/"contradiction"/g)).toHaveLength(1);
    });
});
describe('rewrite prompt — entity 섹션 + disabled', () => {
    const base = {
        chapterNumber: 3,
        language: 'ko',
        intentSummary: '갈등 강화',
        previousProse: '원본 본문이다.',
        foundationContext: {
            genre: 'action',
            worldFacts: [],
            characters: [],
            invariants: [],
        },
        prevStateSummary: {
            chapterNumber: 2,
            addressMap: {},
            openHooks: [],
            relationships: [],
        },
    };
    it('entityContextRender 가 있으면 섹션 포함', () => {
        const prompt = buildRewriteUserPrompt({
            ...base,
            entityContextRender: '## 이번 화 무대 entity (1개, budget 2000t, used ~10t)\n- [item] 잿불 단검',
        });
        expect(prompt).toContain('## 이번 화 무대 entity');
        expect(prompt).toContain('잿불 단검');
        // 섹션 순서: Foundation 뒤 / StoryState 앞.
        expect(prompt.indexOf('## 이번 화 무대 entity')).toBeGreaterThan(prompt.indexOf('## Foundation 컨텍스트'));
        expect(prompt.indexOf('## 이번 화 무대 entity')).toBeLessThan(prompt.indexOf('## 이전 상태 요약'));
    });
    it('entityContextRender 미전달 → legacy prompt byte-identical (섹션 없음)', () => {
        const prompt = buildRewriteUserPrompt(base);
        expect(prompt).not.toContain('무대 entity');
    });
});
// ─── integration: mention activation ────────────────────────────────────────
const DAGGER = {
    entityId: 'ent-dagger',
    kind: 'item',
    canonicalName: '잿불 단검',
    aliases: ['재의 송곳니'],
    status: 'active',
    attrs: { property: '불 마법 증폭' },
};
const UNRELATED = {
    entityId: 'ent-tower',
    kind: 'location',
    canonicalName: '북부 첨탑',
    aliases: [],
    status: 'active',
    attrs: {},
};
/** FileStateStore + 고정 entity snapshot fixture. */
class EntityFixtureStateStore extends FileStateStore {
    snapshots;
    constructor(rootDir, snapshots) {
        super(rootDir);
        this.snapshots = snapshots;
    }
    async loadEntitySnapshots(_workId) {
        return this.snapshots;
    }
}
function recordingRegistry(replies) {
    const calls = [];
    const reg = {
        register: () => undefined,
        has: () => true,
        async complete(req) {
            calls.push(req);
            const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
            let text = '{}';
            if (sys.includes('다시쓰기 지시'))
                text = replies.rewrite ?? '';
            else if (sys.includes('회차 기획자'))
                text = replies.plan ?? '{"plan":"전개."}';
            else if (sys.includes('한국어 웹소설 작가'))
                text = replies.draft ?? '';
            return { text, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
        },
    };
    return { registry: reg, calls };
}
describe('draftPhase — 직전 화 멘션 entity activation', () => {
    let rootDir;
    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'vle-codex-inject-'));
    });
    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true });
    });
    it('plan scene 이 비어도 N-1 prose 멘션 entity 가 draft prompt 에 도달', async () => {
        const DRAFT_RAW = '본문.\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧';
        const { registry: providers, calls } = recordingRegistry({
            plan: '{"plan":"전개.","scene":{"settings":[],"characters":[],"items":[],"antagonists":[],"additionalRefs":[]},"tension":{}}',
            draft: DRAFT_RAW,
        });
        const state = new EntityFixtureStateStore(rootDir, [DAGGER, UNRELATED]);
        const ctx = {
            jobId: 'job-mi',
            workId: 'work-mi',
            kind: 'chapter-write',
            model: { provider: 'openai', modelId: 'mock' },
            state,
            providers,
            sanitizer: new DefaultOutputSanitizer(),
            log: noopLogger(),
        };
        await state.saveFoundation(makeFoundation('work-mi', [char('c1', '서준')]));
        // N-1 artifact: 잿불 단검 멘션, 북부 첨탑 미멘션.
        await state.saveArtifact({
            workId: 'work-mi',
            chapterNumber: 1,
            prose: '서준은 잿불 단검을 품에 숨겼다.',
            delta: {
                chapterNumber: 1,
                appearedCharacterIds: ['c1'],
                newAddressEntries: [],
                relationshipOps: [],
                hookChanges: [],
                mutableChanges: [],
                trackedEntityOps: [],
            },
        });
        await draftPhase(ctx, { chapterNumber: 2 });
        const draftCall = calls.find((c) => (c.messages.find((m) => m.role === 'system')?.content ?? '').includes('한국어 웹소설 작가'));
        expect(draftCall).toBeDefined();
        const userPrompt = draftCall.messages.find((m) => m.role === 'user')?.content ?? '';
        expect(userPrompt).toContain('## 이번 화 무대 entity');
        expect(userPrompt).toContain('잿불 단검');
        expect(userPrompt).toContain('불 마법 증폭');
        expect(userPrompt).not.toContain('북부 첨탑');
    });
});
describe('performChapterRewriteBounded — 원본 prose 멘션 entity activation', () => {
    let rootDir;
    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'vle-codex-rewrite-'));
    });
    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true });
    });
    it('원본 본문에 멘션된 entity 가 rewrite prompt 에 도달', async () => {
        const REWRITE_RAW = '다시 쓴 본문.\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧';
        const { registry: providers, calls } = recordingRegistry({ rewrite: REWRITE_RAW });
        const state = new EntityFixtureStateStore(rootDir, [DAGGER, UNRELATED]);
        const ctx = {
            jobId: 'job-mr',
            workId: 'work-mr',
            kind: 'chapter-rewrite',
            model: { provider: 'openai', modelId: 'mock' },
            state,
            providers,
            sanitizer: new DefaultOutputSanitizer(),
            log: noopLogger(),
        };
        await state.saveFoundation(makeFoundation('work-mr', [char('c1', '서준')]));
        await performChapterRewriteBounded(ctx, {
            chapterNumber: 1,
            previousProse: '서준은 재의 송곳니를 갈았다.',
            intentSummary: '긴장 강화',
        });
        const rewriteCall = calls.find((c) => (c.messages.find((m) => m.role === 'system')?.content ?? '').includes('다시쓰기 지시'));
        expect(rewriteCall).toBeDefined();
        const userPrompt = rewriteCall.messages.find((m) => m.role === 'user')?.content ?? '';
        expect(userPrompt).toContain('## 이번 화 무대 entity');
        expect(userPrompt).toContain('잿불 단검');
        expect(userPrompt).not.toContain('북부 첨탑');
    });
    it('멘션이 없으면 entity 섹션 없는 legacy prompt', async () => {
        const REWRITE_RAW = '다시 쓴 본문.\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧';
        const { registry: providers, calls } = recordingRegistry({ rewrite: REWRITE_RAW });
        const state = new EntityFixtureStateStore(rootDir, [DAGGER]);
        const ctx = {
            jobId: 'job-mr2',
            workId: 'work-mr2',
            kind: 'chapter-rewrite',
            model: { provider: 'openai', modelId: 'mock' },
            state,
            providers,
            sanitizer: new DefaultOutputSanitizer(),
            log: noopLogger(),
        };
        await state.saveFoundation(makeFoundation('work-mr2', [char('c1', '서준')]));
        await performChapterRewriteBounded(ctx, {
            chapterNumber: 1,
            previousProse: '서준은 맨손으로 싸웠다.',
            intentSummary: '긴장 강화',
        });
        const rewriteCall = calls.find((c) => (c.messages.find((m) => m.role === 'system')?.content ?? '').includes('다시쓰기 지시'));
        const userPrompt = rewriteCall.messages.find((m) => m.role === 'user')?.content ?? '';
        expect(userPrompt).not.toContain('무대 entity');
    });
});
