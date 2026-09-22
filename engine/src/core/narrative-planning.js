/**
 * NarrativePlanning is the single validation/fold seam between authored plans
 * and the drafting pipeline.  It deliberately owns policy, not persistence:
 * callers may publish `value` only after the rest of the publication closure
 * has succeeded.
 */

const REQUIRED_CONTEXT = [
    'snapshotId', 'expectedHead', 'storyTimeScope', 'publicationOrder',
    'transactionTime', 'policyRevision', 'semanticGeneration', 'fencingToken',
];

function failure(code, route, message, details = {}) {
    return { ok: false, error: { code, route, message, details } };
}

function present(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function validateContext(context) {
    const missing = REQUIRED_CONTEXT.filter((key) => {
        const value = context?.[key];
        return value === undefined || value === null || value === '';
    });
    if (missing.length > 0) {
        return failure('EXECUTION_CONTEXT_INVALID', 'refresh_context', 'ExecutionContext is incomplete.', { missing });
    }
    return null;
}

function validateSpine(storySpine) {
    const arcs = storySpine?.arcs;
    if (!Array.isArray(arcs) || arcs.length === 0) {
        return failure('STORY_SPINE_INVALID', 'arc_replan', 'StorySpine requires at least one arc.');
    }
    const ids = new Set(arcs.map((arc) => arc?.id));
    if (ids.size !== arcs.length || ids.has(undefined) || ids.has('')) {
        return failure('STORY_SPINE_INVALID', 'arc_replan', 'Arc ids must be present and unique.');
    }
    for (const arc of arcs) {
        for (const key of ['causedBy', 'makesInevitable', 'closes', 'opens']) {
            if (!Array.isArray(arc[key])) {
                return failure('STORY_SPINE_INVALID', 'arc_replan', `Arc ${arc.id} is missing ${key}.`);
            }
        }
        const dangling = [...arc.causedBy, ...arc.makesInevitable].filter((id) => !ids.has(id));
        if (dangling.length > 0) {
            return failure('STORY_SPINE_INVALID', 'arc_replan', `Arc ${arc.id} has dangling causal links.`, { dangling });
        }
    }
    // An adjacent pair must be mutually declared as cause/consequence.  If it
    // is not, deleting the latter or swapping the pair preserves the spine.
    for (let index = 1; index < arcs.length; index += 1) {
        const prior = arcs[index - 1];
        const current = arcs[index];
        if (!current.causedBy.includes(prior.id) || !prior.makesInevitable.includes(current.id)) {
            return failure('EPISODIC_LOOSENESS', 'arc_replan', 'Adjacent arcs fail delete/swap causality.', {
                prior: prior.id, current: current.id,
            });
        }
    }
    return null;
}

function validateAgendaCollisions(agendas, collisions) {
    if ((!agendas || agendas.length === 0) && (!collisions || collisions.length === 0)) return null;
    if (!Array.isArray(agendas) || agendas.length === 0) {
        return failure('CHARACTER_AGENDA_INVALID', 'episode_replan', 'A collision requires at least one explicit agenda set.');
    }
    const required = ['characterId', 'goal', 'nextAction', 'deadline', 'resources', 'knowledge', 'misbelief', 'redLine', 'fallback'];
    const ids = new Set();
    for (const agenda of agendas) {
        const missing = required.filter((key) => agenda?.[key] === undefined || agenda?.[key] === null || agenda?.[key] === '');
        if (missing.length > 0 || ids.has(agenda.characterId)) {
            return failure('CHARACTER_AGENDA_INVALID', 'arc_replan', 'CharacterAgenda is incomplete or duplicated.', {
                characterId: agenda?.characterId, missing,
            });
        }
        ids.add(agenda.characterId);
    }
    for (const collision of collisions ?? []) {
        if (!Array.isArray(collision.agendaIds) || collision.agendaIds.length < 2 || !present(collision.scarceConstraint)) {
            return failure('CHARACTER_AGENDA_INVALID', 'episode_replan', 'A selected collision is incomplete.');
        }
        if (collision.agendaIds.some((id) => !ids.has(id))) {
            return failure('CHARACTER_AGENDA_INVALID', 'episode_replan', 'Collision references an unknown agenda.');
        }
    }
    return null;
}

function validateEpisode(episode) {
    const chain = ['desire', 'tactic', 'resistance', 'choice', 'payoff', 'nextOptionsChanged', 'hookConstraint'];
    const missing = chain.filter((key) => !present(episode?.[key]));
    if (!Array.isArray(episode?.settlesPromiseIds) || episode.settlesPromiseIds.length === 0) missing.push('settlesPromiseIds');
    if (missing.length > 0) {
        return failure('EPISODE_PROPULSION_INCOMPLETE', 'episode_replan', 'Episode propulsion chain is incomplete.', { missing });
    }
    return null;
}

function validateReveals(reveals) {
    for (const reveal of reveals ?? []) {
        const textFields = ['id', 'inducedHypothesis', 'actualCause', 'concealment', 'triggeredByChoice'];
        const missing = textFields.filter((key) => !present(reveal?.[key]));
        if (!Array.isArray(reveal?.dualUseClues) || reveal.dualUseClues.length === 0) missing.push('dualUseClues');
        if (!Array.isArray(reveal?.recontextualizesSceneIds) || reveal.recontextualizesSceneIds.length === 0) missing.push('recontextualizesSceneIds');
        if (!Array.isArray(reveal?.changes?.actions) || reveal.changes.actions.length === 0) missing.push('changes.actions');
        const consequence = (reveal?.changes?.relationships?.length ?? 0) + (reveal?.changes?.costs?.length ?? 0);
        if (consequence === 0) missing.push('changes.relationships|costs');
        if (missing.length > 0) {
            return failure('REVEAL_CONTRACT_INVALID', 'arc_replan', 'Reveal lacks fairness, recontextualization, or consequence.', {
                revealId: reveal?.id, missing,
            });
        }
    }
    return null;
}

function validateScenes(scenes) {
    const orders = new Set();
    for (const scene of scenes ?? []) {
        const time = scene?.storyTime;
        if (!present(scene?.id) || !time || !present(time.worldline) || !Number.isFinite(time.start) || !Number.isFinite(time.end) || time.start > time.end) {
            return failure('STORY_TIME_INVALID', 'episode_replan', 'Every scene needs an explicit valid StoryTime interval.');
        }
        if (!Number.isFinite(scene.publicationOrder) || orders.has(scene.publicationOrder)) {
            return failure('PUBLICATION_ORDER_INVALID', 'episode_replan', 'Scene PublicationOrder must be explicit and unique.');
        }
        orders.add(scene.publicationOrder);
    }
    return null;
}

function foldAudience(context, state, events, settlesPromiseIds) {
    const next = {
        known: [...new Set(state?.known ?? [])],
        suspected: [...new Set(state?.suspected ?? [])],
        misled: [...new Set(state?.misled ?? [])],
        forbidden: [...new Set(state?.forbidden ?? [])],
        promises: (state?.promises ?? []).map((promise) => ({ ...promise })),
    };
    const promiseById = new Map(next.promises.map((promise) => [promise.id, promise]));
    const ordered = [...(events ?? [])].sort((a, b) => a.publicationOrder - b.publicationOrder);
    for (const event of ordered) {
        if (!Number.isFinite(event.publicationOrder)) {
            return failure('PUBLICATION_ORDER_INVALID', 'episode_replan', 'Audience event lacks PublicationOrder.');
        }
        if (event.type === 'disclose') {
            if (next.forbidden.includes(event.claimId)) {
                return failure('SPOILER_BOUNDARY_VIOLATION', 'episode_replan', 'A forbidden claim would be disclosed.', { claimId: event.claimId });
            }
            if (!next.known.includes(event.claimId)) next.known.push(event.claimId);
        } else if (event.type === 'suspect') {
            if (!next.suspected.includes(event.claimId)) next.suspected.push(event.claimId);
        } else if (event.type === 'mislead') {
            if (!next.misled.includes(event.claimId)) next.misled.push(event.claimId);
        } else if (['settle', 'partial-settle', 'extend', 'breach', 'renegotiate'].includes(event.type)) {
            const promise = promiseById.get(event.promiseId);
            if (!promise || !['open', 'partial', 'extended'].includes(promise.status)) {
                return failure('AUDIENCE_PROMISE_TRANSITION_INVALID', 'arc_replan', 'Promise transition has no active source.', { promiseId: event.promiseId });
            }
            if (event.type === 'settle' && !present(event.evidence)) {
                return failure('AUDIENCE_PROMISE_TRANSITION_INVALID', 'arc_replan', 'Settling a promise requires evidence.', { promiseId: event.promiseId });
            }
            promise.status = { settle: 'settled', 'partial-settle': 'partial', extend: 'extended', breach: 'breached', renegotiate: 'renegotiated' }[event.type];
            promise.lastEvent = { ...event };
            if ((event.type === 'extend' || event.type === 'renegotiate') && Number.isFinite(event.duePublicationOrder)) {
                promise.duePublicationOrder = event.duePublicationOrder;
            }
        } else {
            return failure('AUDIENCE_EVENT_INVALID', 'arc_replan', 'Unknown audience event type.', { type: event.type });
        }
    }
    const horizon = Math.max(context.publicationOrder, ...ordered.map((event) => event.publicationOrder));
    const overdue = next.promises.filter((promise) => ['open', 'partial', 'extended'].includes(promise.status) && promise.duePublicationOrder <= horizon);
    if (overdue.length > 0) {
        return failure('AUDIENCE_PROMISE_OVERDUE', 'arc_replan', 'An audience promise reached its deadline without settlement.', {
            promiseIds: overdue.map((promise) => promise.id),
        });
    }
    const unsettledEpisodePromises = settlesPromiseIds.filter((id) => promiseById.get(id)?.status !== 'settled');
    if (unsettledEpisodePromises.length > 0) {
        return failure('EPISODE_PROMISE_UNPAID', 'episode_replan', 'Episode declares a payoff that was not folded as settled.', {
            promiseIds: unsettledEpisodePromises,
        });
    }
    return { ok: true, value: next };
}

/**
 * Validate sections 49–54 and fold reader-facing state.  All failures are
 * typed and carry the planning layer that must be regenerated.
 */
export function validateAndFoldNarrativePlan(context, input) {
    const checks = [
        validateContext(context),
        validateSpine(input?.storySpine),
        validateAgendaCollisions(input?.agendas, input?.collisions),
        validateEpisode(input?.episode),
        validateReveals(input?.reveals),
        validateScenes(input?.scenes),
    ];
    const failed = checks.find(Boolean);
    if (failed) return failed;

    const audience = foldAudience(context, input.audienceState, input.audienceEvents, input.episode.settlesPromiseIds);
    if (!audience.ok) return audience;
    return {
        ok: true,
        value: {
            storySpine: structuredClone(input.storySpine),
            agendas: structuredClone(input.agendas),
            collisions: structuredClone(input.collisions),
            episode: structuredClone(input.episode),
            reveals: structuredClone(input.reveals ?? []),
            audienceState: audience.value,
            scenes: structuredClone(input.scenes ?? []),
            foldReceipt: {
                snapshotId: context.snapshotId,
                expectedHead: context.expectedHead,
                semanticGeneration: context.semanticGeneration,
                policyRevision: context.policyRevision,
                publicationOrder: context.publicationOrder,
                fencingToken: context.fencingToken,
            },
        },
    };
}
