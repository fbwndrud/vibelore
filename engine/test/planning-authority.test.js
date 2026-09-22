import { describe, expect, it } from './_support/vitest-shim.mjs';
import { prepareNarrativeCommit } from '../src/core/planning-authority.js';

const context = {
    snapshotId: 'head-3', expectedHead: 'head-3', storyTimeScope: { worldline: 'main', start: 5, end: 5 },
    publicationOrder: 5, transactionTime: '2026-08-26T00:00:00Z', policyRevision: 2,
    semanticGeneration: 4, fencingToken: 8,
};

function input() {
    return {
        storySpine: { status: 'active', causalChain: ['선택', '실패', '폭로'], characterForces: [] },
        arcPlan: { arcNumber: 1, startChapter: 1, readerContract: { promisedPayoffBy: 5, minimumPayoff: '배신의 이유' } },
        episodePlan: {
            chapter: 5, status: 'active',
            entryState: { protagonistImmediateWant: '기록 확보' },
            scenePressure: { withheldByOther: '동료가 금고를 옮긴다' },
            payoff: { promisePaid: '배신의 이유를 안다', proofOnPage: '영수증을 맞춰 본다' },
            turn: { causedByChoice: '원본 대신 동료를 구한다' },
            costCreatedByResolution: { immediate: '용의자가 된다' },
            exitValue: { nextQuestion: '재판에 설 것인가', specificFutureValue: '성문 봉쇄' },
            scenes: [{ order: 1, objective: '열쇠 탈취', characters: ['hero', 'ally'] }],
            characterAgendas: [
                { characterId: 'hero', goal: '공개', nextAction: '기록 탈취', deadline: 5, resources: ['열쇠'], knowledge: ['금고'], misbelief: ['배신'], redLine: '희생', fallback: '증언' },
                { characterId: 'ally', goal: '은폐', nextAction: '이전', deadline: 5, resources: ['차'], knowledge: ['추적'], misbelief: [], redLine: '체포', fallback: '소각' },
            ],
            characterCollisions: [{ agendaIds: ['hero', 'ally'], scarceConstraint: '같은 기록의 상반된 사용' }],
            revealContracts: [{ id: 'r1', inducedHypothesis: '배신', actualCause: '보호', dualUseClues: ['영수증'], concealment: '수취인 가림', triggeredByChoice: '사본 공개', recontextualizesSceneIds: ['s1'], changes: { actions: ['구출'], relationships: ['불신 해소'], costs: ['도주 포기'] } }],
        },
        storyState: { chapterNumber: 4, hooks: [{ hookId: 'h1', status: 'open' }] },
        audienceState: { known: [], suspected: [], misled: [], forbidden: [], promises: [] },
    };
}

describe('prepareNarrativeCommit', () => {
    it('normalizes legacy plans and returns publication-ready planning projections', () => {
        const result = prepareNarrativeCommit(context, input());
        expect(result.ok).toBe(true);
        expect(result.value.planImpact.status).toBe('valid');
        expect(result.value.impactClosure.every((item) => item.status === 'satisfied')).toBe(true);
        expect(result.value.audienceState.promises[0].status).toBe('settled');
        expect(result.value.revealContracts[0].id).toBe('r1');
        expect(result.value.foldReceipt.expectedHead).toBe('head-3');
        expect(result.value.normalizedPlan.storySpine.arcs).toHaveLength(3);
    });

    it('fails closed with typed replan when a core legacy field cannot be normalized', () => {
        const value = input();
        delete value.episodePlan.turn.causedByChoice;
        const result = prepareNarrativeCommit(context, value);
        expect(result).toMatchObject({ ok: false, error: { code: 'PLANNING_NORMALIZATION_INCOMPLETE', route: 'episode_replan' } });
        expect(result.error.details.missing).toContain('episode.choice');
    });

    it('uses the approved arc exit value when a sparse episode omits its hook fields', () => {
        const value = input();
        value.episodePlan.exitValue = {};
        value.episodePlan.closingState = '공식 지도 밖 우회로에 진입한다';
        value.episodePlan.arcBeat = { exitValue: '구조 신호와 맞지 않는 박자' };
        const result = prepareNarrativeCommit(context, value);
        expect(result.ok).toBe(true);
        expect(result.value.normalizedPlan.episode.hookConstraint).toBe('구조 신호와 맞지 않는 박자');
    });

    it('accepts a simple episode without optional character agendas or collisions', () => {
        const value = input();
        delete value.episodePlan.characterAgendas;
        delete value.episodePlan.characterCollisions;
        const result = prepareNarrativeCommit(context, value);
        expect(result.ok).toBe(true);
        expect(result.value.normalizedPlan.agendas).toHaveLength(0);
        expect(result.value.normalizedPlan.collisions).toHaveLength(0);
    });

    it('does not fabricate RevealContracts from a simple reveal note', () => {
        const value = input();
        value.episodePlan.reveals = ['배신의 이유'];
        value.episodePlan.revealContracts = [];
        const result = prepareNarrativeCommit(context, value);
        expect(result.ok).toBe(true);
        expect(result.value.revealContracts).toHaveLength(0);
    });

    it('routes observed plan deviation and leaves an unsatisfied impact closure', () => {
        const value = input();
        value.observedOutcome = { choice: '기록을 태운다', payoff: '아무것도 얻지 못한다', cost: '없음' };
        const result = prepareNarrativeCommit(context, value);
        expect(result).toMatchObject({ ok: false, error: { code: 'PLAN_IMPACT_REPLAN_REQUIRED', route: 'episode_replan' } });
        expect(result.error.details.impactClosure[0].status).toBe('needs_replan');
    });
});
