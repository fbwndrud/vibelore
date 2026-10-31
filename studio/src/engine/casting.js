import { assertId, assertText, canonicalDigest, fail } from './contracts.js';
import { domainValues, readValues, requireValue } from './story.js';
const levels = { project: 0, production: 1, scene: 2, shot: 3, occurrence: 4 };
/** Two-axis partial order: a narrower generic decision cannot defeat a state-specific default. */
export function resolveCasting({
  occurrence,
  decisions,
  productionId = null,
  sceneId = null,
  shotId = null,
  language = null,
}) {
  const matches = decisions.filter(
    (d) =>
      (d.roleId
        ? d.roleId === occurrence.roleBindingId
        : d.characterId != null && d.characterId === occurrence.characterId) &&
      (!d.language || !language || d.language === language) &&
      (d.state == null || d.state === occurrence.castingStateRef) &&
      (d.scope === 'project' || d.productionId === productionId) &&
      (!['scene', 'shot', 'occurrence'].includes(d.scope) || d.sceneId === sceneId) &&
      (d.scope !== 'shot' || d.shotId === shotId) &&
      (d.scope !== 'occurrence' || d.occurrenceId === occurrence.id)
  );
  const rank = (d) => [levels[d.scope], d.state != null || d.allStates ? 1 : 0];
  const dominates = (a, b) => {
    const x = rank(a),
      y = rank(b);
    return (
      (a.scope === 'occurrence' && b.scope !== 'occurrence') ||
      (x[0] >= y[0] && x[1] >= y[1] && (x[0] > y[0] || x[1] > y[1]))
    );
  };
  const winners = matches.filter((d) => !matches.some((other) => other !== d && dominates(other, d)));
  if (winners.length !== 1)
    return {
      status: 'unresolved',
      reason: winners.length ? 'competing_decisions' : 'unassigned',
      decisionIds: winners.map((d) => d.id),
    };
  const chosen = winners[0];
  return {
    status: 'resolved',
    decisionId: chosen.id,
    revision: chosen.revision ?? null,
    voice: chosen.voice,
    language: chosen.language ?? language,
  };
}
export function resolvedBindings(snapshot) {
  const decisions = domainValues(snapshot, 'casting').map((d) => ({ ...d.value, revision: d.revision }));
  return snapshot.scenes.flatMap((scene) =>
    scene.occurrences.flatMap((occurrence) => {
      const presentation = scene.presentations.find((p) => p.occurrenceId === occurrence.id);
      const role = snapshot.cast.find((r) => r.id === occurrence.roleBindingId);
      const shots = scene.shots.filter(
        (s) => s.targetOccurrenceId === occurrence.id || s.occurrenceIds?.includes(occurrence.id)
      );
      return [null, ...shots.map((s) => s.id)].map((shotId) => ({
        sceneId: scene.id,
        productionId: scene.productionId,
        shotId,
        occurrenceId: occurrence.id,
        characterId: occurrence.characterId ?? null,
        roleBindingId: occurrence.roleBindingId,
        temporalStateRef: occurrence.temporalStateRef ?? null,
        ...presentation,
        casting: resolveCasting({
          occurrence: { ...occurrence, castingStateRef: presentation.castingStateRef },
          decisions,
          productionId: scene.productionId,
          sceneId: scene.id,
          shotId,
          language: role.language,
        }),
      }));
    })
  );
}
export function registerCastingCommands(service) {
  service.registerCommand('casting.set', {
    target: ({ envelope }) => ({ kind: 'casting', id: envelope.payload.id }),
    validate({ store, envelope }) {
      const d = envelope.payload;
      assertId(d.id);
      assertText(d.voice);
      if (!Object.hasOwn(levels, d.scope)) fail('INVALID_INPUT', 'Unknown casting scope.');
      if (d.state != null) {
        assertId(d.state);
        requireValue(store, envelope.projectId, 'state', d.state);
      }
      if (d.allStates !== undefined && typeof d.allStates !== 'boolean')
        fail('INVALID_INPUT', 'Expected all-states boolean.');
      if (d.roleId) requireValue(store, envelope.projectId, 'cast', d.roleId);
      else if (d.characterId) requireValue(store, envelope.projectId, 'identity', d.characterId);
      else fail('INVALID_REFERENCE', 'Casting requires a stable role or character.');
      if (d.scope !== 'project') requireValue(store, envelope.projectId, 'production', d.productionId);
      if (['scene', 'shot', 'occurrence'].includes(d.scope)) {
        const scene = requireValue(store, envelope.projectId, 'scene', d.sceneId);
        if (scene.productionId !== d.productionId)
          fail('INVALID_REFERENCE', 'Casting scene does not belong to production.');
        if (
          d.scope === 'occurrence' &&
          !scene.occurrences.some(
            (o) =>
              o.id === d.occurrenceId &&
              (d.roleId ? o.roleBindingId === d.roleId : o.characterId === d.characterId)
          )
        )
          fail('INVALID_REFERENCE', 'Casting occurrence does not match its subject.');
        if (d.scope === 'shot' && !scene.shots.some((s) => s.id === d.shotId))
          fail('INVALID_REFERENCE', 'Casting shot does not belong to scene.');
      }
    },
    apply({ store, envelope }) {
      const decision = envelope.payload;
      const before = store
        .all(
          'SELECT revision,data_json FROM aggregates WHERE project_id=? AND kind=?',
          envelope.projectId,
          'casting'
        )
        .map((r) => ({ ...JSON.parse(r.data_json), revision: r.revision }));
      const after = [
        ...before.filter((d) => d.id !== decision.id),
        { ...decision, revision: envelope.expectedRevision + 1 },
      ];
      const impacts = [];
      for (const scene of readValues(store, envelope.projectId, 'scene'))
        for (const occurrence of scene.occurrences) {
          const presentation = scene.presentations.find((p) => p.occurrenceId === occurrence.id),
            role = requireValue(store, envelope.projectId, 'cast', occurrence.roleBindingId);
          const input = {
            occurrence: { ...occurrence, castingStateRef: presentation.castingStateRef },
            productionId: scene.productionId,
            sceneId: scene.id,
            language: role.language,
          };
          if (
            canonicalDigest(resolveCasting({ ...input, decisions: before })) !==
            canonicalDigest(resolveCasting({ ...input, decisions: after }))
          ) {
            for (const utterance of scene.utterances.filter((u) => u.speakerOccurrenceId === occurrence.id))
              impacts.push({
                sceneId: scene.id,
                occurrenceId: occurrence.id,
                utteranceId: utterance.id,
                reason: 'casting-binding-changed',
              });
          }
        }
      return { ...decision, impacts };
    },
  });
}
