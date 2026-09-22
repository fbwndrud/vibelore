import { describe, expect, it } from './_support/vitest-shim.mjs';
import { validateAndFoldNarrativePlan } from '../src/core/narrative-planning.js';

const context = {
    snapshotId: 'rev-7',
    expectedHead: 'rev-7',
    storyTimeScope: { worldline: 'main', start: 30, end: 31 },
    publicationOrder: 12,
    transactionTime: '2026-08-26T10:00:00.000Z',
    policyRevision: 3,
    semanticGeneration: 5,
    fencingToken: 9,
};

function validInput() {
    return {
        storySpine: {
            arcs: [
                { id: 'a1', causedBy: [], makesInevitable: ['a2'], closes: [], opens: ['debt'] },
                { id: 'a2', causedBy: ['a1'], makesInevitable: ['a3'], closes: ['debt'], opens: ['truth'] },
                { id: 'a3', causedBy: ['a2'], makesInevitable: [], closes: ['truth'], opens: [] },
            ],
        },
        agendas: [
            { characterId: 'hero', goal: '진실 공개', nextAction: '기록 탈취', deadline: 31, resources: ['열쇠'], knowledge: ['금고 위치'], misbelief: ['동료가 배신자'], redLine: '민간인 희생', fallback: '증언 확보' },
            { characterId: 'ally', goal: '기록 은폐', nextAction: '금고 이전', deadline: 30, resources: ['운반차'], knowledge: ['추적 사실'], misbelief: [], redLine: 'hero 체포', fallback: '일부 문서 소각' },
        ],
        collisions: [{ agendaIds: ['hero', 'ally'], scarceConstraint: '같은 금고를 자정 전에 상반된 목적으로 선점' }],
        episode: {
            desire: '기록을 손에 넣는다', tactic: '열쇠를 훔친다', resistance: 'ally가 금고를 옮긴다',
            choice: '동료를 살리려고 원본을 포기한다', payoff: '사본 한 장을 확보한다',
            unexpectedCost: '사본이 공개되며 hero가 용의자가 된다', nextOptionsChanged: '도망치거나 공개 재판에 서야 한다',
            settlesPromiseIds: ['p1'], hookConstraint: '도시 출입문이 봉쇄된다',
        },
        reveals: [{
            id: 'r1', inducedHypothesis: 'ally가 배신했다', actualCause: 'ally가 증거를 지키려 위장했다',
            dualUseClues: ['금고를 옮긴 영수증'], concealment: '영수증의 수취인을 가렸다',
            triggeredByChoice: 'hero가 사본을 공개한다', recontextualizesSceneIds: ['scene-9'],
            changes: { actions: ['ally를 구한다'], relationships: ['불신이 부채감으로 변한다'], costs: ['도주 기회를 잃는다'] },
        }],
        audienceState: {
            known: [], suspected: [], misled: [], forbidden: ['future-king'],
            promises: [{ id: 'p1', status: 'open', duePublicationOrder: 12, minimumPayoff: '배신의 원인 공개' }],
        },
        audienceEvents: [
            { type: 'mislead', claimId: 'ally-betrayal', publicationOrder: 10 },
            { type: 'disclose', claimId: 'ally-protected-proof', publicationOrder: 11 },
            { type: 'settle', promiseId: 'p1', evidence: 'scene-12', publicationOrder: 12 },
        ],
        scenes: [
            { id: 'scene-12a', storyTime: { worldline: 'main', start: 30, end: 30 }, publicationOrder: 12 },
            { id: 'scene-12b', storyTime: { worldline: 'main', start: 20, end: 20 }, publicationOrder: 13 },
        ],
    };
}

describe('validateAndFoldNarrativePlan', () => {
    it('validates the complete planning contract and folds audience state by publication order', () => {
        const result = validateAndFoldNarrativePlan(context, validInput());
        expect(result.ok).toBe(true);
        expect(result.value.audienceState.known).toContain('ally-protected-proof');
        expect(result.value.audienceState.misled).toContain('ally-betrayal');
        expect(result.value.audienceState.promises[0].status).toBe('settled');
        expect(result.value.scenes[1].storyTime.start).toBe(20);
        expect(result.value.scenes[1].publicationOrder).toBe(13);
    });

    it('routes a deletable or swappable causal spine to arc replan', () => {
        const input = validInput();
        input.storySpine.arcs[1].causedBy = [];
        input.storySpine.arcs[0].makesInevitable = [];
        const result = validateAndFoldNarrativePlan(context, input);
        expect(result).toMatchObject({ ok: false, error: { code: 'EPISODIC_LOOSENESS', route: 'arc_replan' } });
    });

    it('accepts independent agendas when the episode does not need a forced collision', () => {
        const input = validInput();
        input.collisions = [];
        const result = validateAndFoldNarrativePlan(context, input);
        expect(result.ok).toBe(true);
        expect(result.value.collisions).toHaveLength(0);
    });

    it('accepts a complete propulsion chain without forcing an unexpected cost', () => {
        const input = validInput();
        input.episode.unexpectedCost = '';
        const result = validateAndFoldNarrativePlan(context, input);
        expect(result.ok).toBe(true);
        expect(result.value.episode.unexpectedCost).toBe('');
    });

    it('still rejects an explicitly requested collision that references no agenda', () => {
        const input = validInput();
        input.collisions = [{ agendaIds: ['hero', 'missing'], scarceConstraint: '한 사람만 출입할 수 있다' }];
        const result = validateAndFoldNarrativePlan(context, input);
        expect(result).toMatchObject({ ok: false, error: { code: 'CHARACTER_AGENDA_INVALID', route: 'episode_replan' } });
    });

    it('rejects a reveal without fair clues, recontextualization, and behavioral consequence', () => {
        const input = validInput();
        input.reveals[0].dualUseClues = [];
        input.reveals[0].recontextualizesSceneIds = [];
        input.reveals[0].changes = { actions: [], relationships: [], costs: [] };
        const result = validateAndFoldNarrativePlan(context, input);
        expect(result).toMatchObject({ ok: false, error: { code: 'REVEAL_CONTRACT_INVALID', route: 'arc_replan' } });
    });

    it('blocks forbidden disclosure and overdue open promises', () => {
        const forbidden = validInput();
        forbidden.audienceEvents.unshift({ type: 'disclose', claimId: 'future-king', publicationOrder: 9 });
        expect(validateAndFoldNarrativePlan(context, forbidden)).toMatchObject({ ok: false, error: { code: 'SPOILER_BOUNDARY_VIOLATION' } });

        const overdue = validInput();
        overdue.audienceEvents = overdue.audienceEvents.filter((event) => event.type !== 'settle');
        expect(validateAndFoldNarrativePlan(context, overdue)).toMatchObject({ ok: false, error: { code: 'AUDIENCE_PROMISE_OVERDUE', route: 'arc_replan' } });
    });

    it('requires explicit and unique StoryTime and PublicationOrder independently', () => {
        const input = validInput();
        delete input.scenes[0].storyTime;
        const result = validateAndFoldNarrativePlan(context, input);
        expect(result).toMatchObject({ ok: false, error: { code: 'STORY_TIME_INVALID', route: 'episode_replan' } });
    });

    it('returns a typed stale-context failure before inspecting the plan', () => {
        const result = validateAndFoldNarrativePlan({ ...context, expectedHead: '' }, validInput());
        expect(result).toMatchObject({ ok: false, error: { code: 'EXECUTION_CONTEXT_INVALID', route: 'refresh_context' } });
    });
});
