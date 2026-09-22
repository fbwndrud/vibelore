/**
 * draft.ts — EPIC #364 S3 (#367) tension 슬롯 배선.
 *
 * chapter-plan 의 tension 슬롯이 실제 draft LLM prompt 까지 도달하는지 검증.
 * S3 가 ChapterPlanOutput.tension 을 만들었지만 draft step (steps/draft.ts) 이
 * plan(string)만 받으면 dead data — 이 PR (S4) 이 DraftInput.tension 배선을
 * 추가. 채워진 필드만 "## 이번 화 긴장 설계" 섹션으로 직렬화, 전부 비면 생략.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { runDraft } from '../../src/generators/text/steps/draft.js';
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
        speechProfile: {
            defaultRegister: '낮은 존댓말',
            sentenceShape: '짧게 끊고 비용을 먼저 말한다',
            logicHabit: '감정보다 손실 계산을 앞세운다',
            samples: { everyday: 'VOICE_SAMPLE_TOKEN 계산부터 하죠.' },
        },
    };
}
function makeFoundation() {
    return {
        workId: 'work-tension',
        genre: 'action',
        worldFacts: [],
        characters: [makeChar('c1')],
        intrinsicChanges: [],
        genreProfile: registry.get('action'),
    };
}
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
const baseInput = () => ({
    foundation: makeFoundation(),
    prevState: emptyStoryState('work-tension'),
    chapterNumber: 2,
    plan: '회차 기획 내용',
    providers: capturingProvider().provider,
    model: { provider: 'openai', modelId: 'gpt-4o-mini' },
});
describe('runDraft — tension 슬롯 배선 (S3 #367)', () => {
    it('injects 긴장 설계 섹션 with all three filled slots', async () => {
        const { provider, requests } = capturingProvider();
        await runDraft({
            ...baseInput(),
            providers: provider,
            tension: {
                ticking: 'TICK_TOKEN 자정까지 12시간',
                stake: 'STAKE_TOKEN 동생의 목숨',
                escalation: 'ESC_TOKEN 추격자가 두 배로 늘었다',
            },
        });
        const userMsg = requests[0].messages.find((m) => m.role === 'user');
        expect(userMsg.content).toContain('## 이번 화 긴장 설계');
        expect(userMsg.content).toContain('TICK_TOKEN');
        expect(userMsg.content).toContain('STAKE_TOKEN');
        expect(userMsg.content).toContain('ESC_TOKEN');
        // 설명 아닌 장면으로 구현하라는 지시 포함
        expect(userMsg.content).toContain('장면');
    });
    it('renders only filled slots, skips empty/undefined ones', async () => {
        const { provider, requests } = capturingProvider();
        await runDraft({
            ...baseInput(),
            providers: provider,
            tension: { stake: 'ONLY_STAKE', ticking: '', escalation: undefined },
        });
        const userMsg = requests[0].messages.find((m) => m.role === 'user');
        expect(userMsg.content).toContain('## 이번 화 긴장 설계');
        expect(userMsg.content).toContain('ONLY_STAKE');
        expect(userMsg.content).not.toContain('ticking)');
        expect(userMsg.content).not.toContain('escalation)');
    });
    it('omits 긴장 설계 섹션entirely when tension undefined (legacy 호환)', async () => {
        const { provider, requests } = capturingProvider();
        await runDraft({ ...baseInput(), providers: provider });
        const userMsg = requests[0].messages.find((m) => m.role === 'user');
        expect(userMsg.content).not.toContain('## 이번 화 긴장 설계');
    });
    it('omits 섹션 when tension object is empty (all slots blank)', async () => {
        const { provider, requests } = capturingProvider();
        await runDraft({
            ...baseInput(),
            providers: provider,
            tension: { ticking: '', stake: '', escalation: '' },
        });
        const userMsg = requests[0].messages.find((m) => m.role === 'user');
        expect(userMsg.content).not.toContain('## 이번 화 긴장 설계');
    });
});

describe('runDraft — openingContract 슬롯 배선', () => {
    it('injects 1화 오프닝 계약 section for chapter 1', async () => {
        const { provider, requests } = capturingProvider();
        await runDraft({
            ...baseInput(),
            providers: provider,
            chapterNumber: 1,
            openingContract: {
                surfaceEvent: 'SURFACE_TOKEN 배급 심사 탈락',
                worldPressure: 'WORLD_TOKEN 도시가 자원 배급으로 시민을 통제한다',
                characterWound: 'WOUND_TOKEN 구조하지 못한 동료',
                misbelief: 'MISBELIEF_TOKEN 규칙은 공정하다',
                firstIrreversibleChoice: 'CHOICE_TOKEN 기록 조작 공개',
                withheldContext: 'WITHHELD_TOKEN 미궁 핵 정체',
                viewpointReason: 'POV_TOKEN 제도 밖 감각',
            },
        });
        const userMsg = requests[0].messages.find((m) => m.role === 'user');
        expect(userMsg.content).toContain('## 1화 오프닝 계약');
        expect(userMsg.content).toContain('SURFACE_TOKEN');
        expect(userMsg.content).toContain('WORLD_TOKEN');
        expect(userMsg.content).toContain('POV_TOKEN');
        expect(userMsg.content).toContain('사건 해결보다');
    });
    it('omits openingContract section after chapter 1', async () => {
        const { provider, requests } = capturingProvider();
        await runDraft({
            ...baseInput(),
            providers: provider,
            chapterNumber: 2,
            openingContract: { worldPressure: 'WORLD_TOKEN' },
        });
        const userMsg = requests[0].messages.find((m) => m.role === 'user');
        expect(userMsg.content).not.toContain('## 1화 오프닝 계약');
        expect(userMsg.content).not.toContain('WORLD_TOKEN');
    });
});

describe('runDraft — character voice contract', () => {
    it('injects speechProfile and voice rules into the provider request', async () => {
        const { provider, requests } = capturingProvider();
        await runDraft({ ...baseInput(), providers: provider });
        const systemMsg = requests[0].messages.find((m) => m.role === 'system');
        const userMsg = requests[0].messages.find((m) => m.role === 'user');
        expect(systemMsg.content).toContain('인물 음성 규칙');
        expect(systemMsg.content).toContain('sampleLine 은 복사할 문장이 아니라');
        expect(userMsg.content).toContain('speechProfile');
        expect(userMsg.content).toContain('VOICE_SAMPLE_TOKEN');
    });
});
