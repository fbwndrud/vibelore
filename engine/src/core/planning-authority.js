import { validateAndFoldNarrativePlan } from './narrative-planning.js';
import { isHookActive } from '../continuity/story-state.js';

function failure(code, route, message, details = {}) {
    return { ok: false, error: { code, route, message, details } };
}

const text = (...values) => values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ?? '';

function normalizeSpine(spine) {
    if (Array.isArray(spine?.arcs)) return structuredClone(spine);
    if (!Array.isArray(spine?.causalChain) || spine.causalChain.length === 0) return null;
    return {
        arcs: spine.causalChain.map((node, index, all) => ({
            id: `spine-${index + 1}`,
            label: String(node),
            causedBy: index === 0 ? [] : [`spine-${index}`],
            makesInevitable: index === all.length - 1 ? [] : [`spine-${index + 2}`],
            closes: index === 0 ? [] : [`spine-obligation-${index}`],
            opens: index === all.length - 1 ? [] : [`spine-obligation-${index + 1}`],
        })),
    };
}

function normalizeEpisode(plan, chapter, promiseId) {
    const firstScene = plan?.scenes?.[0] ?? {};
    return {
        desire: text(plan?.desire, plan?.entryState?.protagonistImmediateWant),
        tactic: text(plan?.tactic, firstScene.objective, firstScene.choice),
        resistance: text(plan?.resistance, plan?.scenePressure?.withheldByOther, firstScene.obstacle),
        choice: text(plan?.choice, plan?.turn?.causedByChoice),
        payoff: text(plan?.payoff?.promisePaid, plan?.payoff),
        unexpectedCost: text(plan?.costCreatedByResolution?.immediate, plan?.costCreatedByResolution?.deferred),
        nextOptionsChanged: text(plan?.exitValue?.nextQuestion, plan?.closingState),
        settlesPromiseIds: [promiseId],
        hookConstraint: text(
            plan?.exitValue?.specificFutureValue,
            plan?.exitValue?.nextQuestion,
            plan?.arcBeat?.hook,
            plan?.arcBeat?.exitValue,
            plan?.closingState,
        ),
        chapter,
    };
}

function missingCore(normalized, source) {
    const missing = [];
    if (!normalized.storySpine) missing.push('storySpine.causalChain|arcs');
    for (const key of ['desire', 'tactic', 'resistance', 'choice', 'payoff', 'nextOptionsChanged', 'hookConstraint']) {
        if (!normalized.episode[key]) missing.push(`episode.${key}`);
    }
    return missing;
}

function normalizeScenes(context, episodePlan, chapter) {
    return (episodePlan?.scenes ?? []).map((scene, index) => ({
        id: scene.id ?? `chapter-${chapter}-scene-${index + 1}`,
        storyTime: scene.storyTime ?? {
            worldline: context.storyTimeScope?.worldline ?? 'main',
            start: chapter + index / 100,
            end: chapter + index / 100,
        },
        publicationOrder: scene.publicationOrder ?? context.publicationOrder + index / 100,
    }));
}

function compareObserved(episode, observed) {
    if (!observed) return [];
    return [
        ['choice', episode.choice, observed.choice],
        ['payoff', episode.payoff, observed.payoff],
        ['cost', episode.unexpectedCost, observed.cost],
    ].filter(([, planned, actual]) => typeof actual === 'string' && actual.trim().length > 0 && planned !== actual.trim())
        .map(([field, planned, actual]) => ({ field, planned, actual }));
}

/**
 * Adapter for the root workflow. It converts existing Markdown-store plan
 * shapes into the strict NarrativePlanning contract, then returns every
 * planning projection needed by a publication candidate.
 */
export function prepareNarrativeCommit(context, source) {
    const chapter = Number(source?.episodePlan?.chapter ?? context?.publicationOrder);
    const promiseId = `episode:${chapter}:payoff`;
    const storySpine = normalizeSpine(source?.storySpine);
    const episode = normalizeEpisode(source?.episodePlan, chapter, promiseId);
    const normalized = { storySpine, episode };
    const missing = missingCore(normalized, source ?? {});
    if (missing.length > 0) {
        const route = missing.some((field) => field.includes('storySpine'))
            ? 'arc_replan' : 'episode_replan';
        return failure('PLANNING_NORMALIZATION_INCOMPLETE', route, 'Existing plans lack fields required by the narrative contract.', { missing });
    }

    const deviations = compareObserved(episode, source.observedOutcome);
    if (deviations.length > 0) {
        const impactClosure = [{ id: `episode-plan:${chapter}`, dependencyKind: 'plan', status: 'needs_replan' }];
        return failure('PLAN_IMPACT_REPLAN_REQUIRED', 'episode_replan', 'Observed chapter outcome invalidates the approved episode plan.', {
            deviations, planImpact: { status: 'needs_replan', invalidated: deviations.map((item) => item.field) }, impactClosure,
        });
    }

    const priorAudience = source.audienceState ?? { known: [], suspected: [], misled: [], forbidden: [], promises: [] };
    const promises = [...(priorAudience.promises ?? []).filter((item) => item.id !== promiseId), {
        id: promiseId,
        status: 'open',
        duePublicationOrder: context.publicationOrder,
        minimumPayoff: episode.payoff,
    }];
    const audienceEvents = [{ type: 'settle', promiseId, evidence: source.episodePlan.payoff?.proofOnPage ?? episode.payoff, publicationOrder: context.publicationOrder }];
    for (const reveal of source.episodePlan.revealContracts ?? []) {
        audienceEvents.unshift({ type: 'mislead', claimId: `hypothesis:${reveal.id}`, publicationOrder: context.publicationOrder - 0.02 });
        audienceEvents.push({ type: 'disclose', claimId: `cause:${reveal.id}`, publicationOrder: context.publicationOrder - 0.01 });
    }
    const strictInput = {
        storySpine,
        agendas: source.episodePlan.characterAgendas ?? [],
        collisions: source.episodePlan.characterCollisions ?? [],
        episode,
        reveals: source.episodePlan.revealContracts ?? [],
        audienceState: { ...priorAudience, promises },
        audienceEvents,
        scenes: normalizeScenes(context, source.episodePlan, chapter),
    };
    const folded = validateAndFoldNarrativePlan(context, strictInput);
    if (!folded.ok) return folded;

    const impactClosure = [
        { id: 'story-spine', dependencyKind: 'plan', status: 'satisfied' },
        { id: `arc-plan:${source.arcPlan?.arcNumber ?? 'unknown'}`, dependencyKind: 'plan', status: 'satisfied' },
        { id: `episode-plan:${chapter}`, dependencyKind: 'plan', status: 'satisfied' },
        ...(source.storyState?.hooks ?? []).filter(isHookActive).map((hook) => ({
            id: `hook:${hook.id ?? hook.hookId}`, dependencyKind: 'promise', status: 'satisfied',
        })),
    ];
    return {
        ok: true,
        value: {
            normalizedPlan: folded.value,
            audienceState: folded.value.audienceState,
            promises: folded.value.audienceState.promises,
            revealContracts: folded.value.reveals,
            planImpact: { status: 'valid', invalidated: [] },
            impactClosure,
            foldReceipt: folded.value.foldReceipt,
        },
    };
}
