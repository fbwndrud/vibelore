/**
 * draft.ts — Arc Flow Stage A (EPIC #191 / Stage A #192).
 *
 * runDraft 가 input.arc 가 있을 때만 ## Arc Promise + ## 회차 위치 헤더를
 * prompt 에 주입하는지 검증. legacy 작품 (arc=undefined) 의 prompt 는 기존
 * 형식 유지 — fixture stability.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { runDraft, formatArcHeader } from '../../src/generators/text/steps/draft.js';
const registry = createGenreProfileRegistry();
function makeChar(id) {
    return {
        id,
        canonicalName: '주인공',
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
function makeFoundation() {
    return {
        workId: 'work-arc',
        genre: 'action',
        worldFacts: [],
        characters: [makeChar('c1')],
        intrinsicChanges: [],
        genreProfile: registry.get('action'),
    };
}
function makeArc(overrides = {}) {
    return {
        arcId: 'arc-1',
        arcNumber: 1,
        title: '도주',
        summary: '주인공이 본거지를 떠난다',
        promise: '평범한 일상이 무너지고 도주가 시작된다',
        type: 'standard',
        estimatedEpisodes: 20,
        currentPosition: 'opening',
        currentChapterInArc: 1,
        ...overrides,
    };
}
/**
 * Provider that captures every request — runDraft only makes one LLM call so
 * the first captured request is the draft prompt.
 */
function capturingProvider() {
    const requests = [];
    const provider = {
        async complete(req) {
            requests.push(req);
            return {
                text: '본문 prose...\n\n⟦vle:cast-manifest {"cast":[]}⟧',
                usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
                model: req.model,
            };
        },
    };
    return { provider, requests };
}
describe('runDraft — Arc Flow Stage A', () => {
    it('injects ## Arc Promise + ## 회차 위치 when arc is set', async () => {
        const { provider, requests } = capturingProvider();
        const arc = makeArc({ promise: 'TEST_PROMISE_TOKEN' });
        await runDraft({
            foundation: makeFoundation(),
            prevState: emptyStoryState('work-arc'),
            chapterNumber: 1,
            plan: '회차 기획 내용',
            providers: provider,
            model: { provider: 'openai', modelId: 'gpt-4o-mini' },
            arc,
        });
        expect(requests).toHaveLength(1);
        const userMsg = requests[0].messages.find((m) => m.role === 'user');
        expect(userMsg.content).toContain('## Arc Promise');
        expect(userMsg.content).toContain('## 회차 위치');
        expect(userMsg.content).toContain('TEST_PROMISE_TOKEN');
        expect(userMsg.content).toContain('Arc #1');
        expect(userMsg.content).toContain('도입 (Opening)');
        // 헤더가 Foundation 보다 먼저 등장해야 LLM 이 Arc 를 먼저 인식.
        const arcIdx = userMsg.content.indexOf('## Arc Promise');
        const foundationIdx = userMsg.content.indexOf('## Foundation 요약');
        expect(arcIdx).toBeGreaterThan(-1);
        expect(foundationIdx).toBeGreaterThan(arcIdx);
    });
    it('omits Arc header entirely when arc is undefined (legacy)', async () => {
        const { provider, requests } = capturingProvider();
        await runDraft({
            foundation: makeFoundation(),
            prevState: emptyStoryState('work-arc'),
            chapterNumber: 1,
            plan: 'plan',
            providers: provider,
            model: { provider: 'openai', modelId: 'gpt-4o-mini' },
        });
        const userMsg = requests[0].messages.find((m) => m.role === 'user');
        expect(userMsg.content).not.toContain('## Arc Promise');
        expect(userMsg.content).not.toContain('## 회차 위치');
    });
    it('limits the Foundation character projection to the EpisodePlan cast', async () => {
        const { provider, requests } = capturingProvider();
        const foundation = makeFoundation();
        foundation.characters.push({ ...makeChar('c2'), canonicalName: '이번 화에 없는 인물' });
        await runDraft({
            foundation,
            prevState: emptyStoryState('work-arc'),
            chapterNumber: 1,
            activeCastIds: ['c1'],
            plan: 'plan',
            providers: provider,
            model: { provider: 'openai', modelId: 'gpt-4o-mini' },
        });
        const userMsg = requests[0].messages.find((m) => m.role === 'user');
        expect(userMsg.content).toContain('주인공');
        expect(userMsg.content).not.toContain('이번 화에 없는 인물');
    });
    it('renders "약속 미설정" placeholder when promise is empty', async () => {
        const arc = makeArc({ promise: '' });
        const header = formatArcHeader(arc);
        expect(header).toContain('약속 미설정');
    });
    it('includes Arc 안 N/M progress in the position section', async () => {
        const arc = makeArc({ currentChapterInArc: 7, estimatedEpisodes: 20, currentPosition: 'rising' });
        const header = formatArcHeader(arc);
        expect(header).toContain('Arc 안 7/20');
        expect(header).toContain('상승 (Rising)');
    });
});
