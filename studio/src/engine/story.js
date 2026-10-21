import { assertId, assertText, canonicalDigest, fail } from './contracts.js';
export const domainValues = (snapshot, kind) => snapshot.aggregates.filter((a) => a.kind === kind);
export function readValues(store, projectId, kind) {
  return store
    .all('SELECT data_json FROM aggregates WHERE project_id=? AND kind=? ORDER BY id', projectId, kind)
    .map((r) => JSON.parse(r.data_json));
}
export function requireValue(store, projectId, kind, id) {
  assertId(id);
  let value;
  if (kind === 'production')
    value = store.get(
      'SELECT id,source_package_id AS sourcePackageId FROM productions WHERE project_id=? AND id=?',
      projectId,
      id
    );
  else if (kind === 'state')
    value =
      readValues(store, projectId, 'story')
        .flatMap((s) => s.states)
        .find((s) => s.id === id) ??
      readValues(store, projectId, 'sourcePackage')
        .flatMap((p) =>
          p.sceneScopes.flatMap((s) => Object.values(s.stateIds ?? {}).flat()).map((id) => ({ id }))
        )
        .find((s) => s.id === id);
  else if (kind === 'identity')
    value = readValues(store, projectId, 'cast')
      .map((r) => r.identity)
      .find((identity) => identity?.id === id);
  else value = store.aggregate(projectId, { kind, id }).value;
  if (!value) fail('INVALID_REFERENCE', 'Referenced subject does not belong to this project.');
  return value;
}
export function effectiveScenes(snapshot) {
  const updates = domainValues(snapshot, 'utterance').map((a) => a.value);
  return domainValues(snapshot, 'scene').map((a) => ({
    ...a.value,
    utterances: a.value.utterances.map((u) => ({
      ...u,
      ...updates.find((v) => v.id === u.id && v.sceneId === a.id),
    })),
  }));
}
function unique(items) {
  if (!Array.isArray(items)) fail('INVALID_INPUT', 'Expected domain collection.');
  const ids = new Set();
  for (const item of items) {
    assertId(item.id);
    if (ids.has(item.id)) fail('INVALID_INPUT', 'Duplicate stable identifier.');
    ids.add(item.id);
  }
  return ids;
}
function validateUtterance(u, occurrences, utterances) {
  assertText(u.text);
  if (!occurrences.has(u.speakerOccurrenceId))
    fail('INVALID_REFERENCE', 'Speaker occurrence does not belong to scene.');
  if (!Array.isArray(u.addresseeOccurrenceIds)) fail('INVALID_INPUT', 'Expected addressee occurrences.');
  for (const id of u.addresseeOccurrenceIds)
    if (!occurrences.has(id)) fail('INVALID_REFERENCE', 'Addressee does not belong to scene.');
  if (u.responseTo && !utterances.has(u.responseTo))
    fail('INVALID_REFERENCE', 'Response utterance does not belong to scene.');
  if (u.holdMs !== undefined && (!Number.isSafeInteger(u.holdMs) || u.holdMs < 0))
    fail('INVALID_INPUT', 'Expected nonnegative hold milliseconds.');
}
export function registerStoryCommands(service) {
  service.registerCommand('story.save', {
    target: ({ envelope }) => ({ kind: 'story', id: envelope.payload.id }),
    validate({ store, envelope }) {
      const p = envelope.payload;
      assertId(p.id);
      assertText(p.title);
      assertText(p.text);
      unique(p.states);
      if (!p.revealPolicy) fail('INVALID_INPUT', 'Expected reveal policy.');
      const stories = readValues(store, envelope.projectId, 'story');
      if (stories.some((s) => s.id !== p.id)) fail('INVALID_INPUT', 'Project has one story.');
      const sourceStateIds = readValues(store, envelope.projectId, 'sourcePackage').flatMap((pkg) =>
        pkg.sceneScopes.flatMap((scope) => Object.values(scope.stateIds ?? {}).flat())
      );
      const stateIds = new Set([...p.states.map((s) => s.id), ...sourceStateIds]);
      for (const scene of readValues(store, envelope.projectId, 'scene'))
        for (const ref of [
          ...scene.occurrences.flatMap((o) => [o.temporalStateRef, o.knowledgeStateRef]),
          ...scene.presentations.flatMap((b) => [
            b.appearanceStateRef,
            b.castingStateRef,
            b.knowledgeStateRef,
          ]),
        ].filter(Boolean)) {
          if (!stateIds.has(ref)) {
            const sourceStates = readValues(store, envelope.projectId, 'sourcePackage').flatMap((pkg) =>
              pkg.sceneScopes.flatMap((s) => Object.values(s.stateIds ?? {}).flat())
            );
            if (!sourceStates.includes(ref))
              fail('INVALID_REFERENCE', 'Cannot remove a referenced story state.');
          }
        }
      for (const decision of readValues(store, envelope.projectId, 'casting'))
        if (decision.state && !stateIds.has(decision.state))
          fail('INVALID_REFERENCE', 'Cannot remove a casting state.');
      for (const link of p.identityLinks ?? []) {
        requireValue(store, envelope.projectId, 'identity', link.localIdentityId);
        const source = requireValue(store, envelope.projectId, 'sourcePackage', link.packageId);
        if (!source.sourceIdentityMap.some((i) => i.id === link.sourceIdentityId))
          fail('INVALID_REFERENCE', 'Identity link source is absent.');
        assertText(link.actor);
        assertText(link.reason);
      }
    },
    apply: ({ envelope }) => envelope.payload,
  });
  service.registerCommand('cast.put', {
    target: ({ envelope }) => ({ kind: 'cast', id: envelope.payload.id }),
    validate({ store, envelope, aggregate }) {
      const p = envelope.payload;
      assertId(p.id);
      assertText(p.name);
      assertText(p.language);
      if (p.characterId != null) {
        assertId(p.characterId);
        if (p.identity) {
          if (p.identity.id !== p.characterId)
            fail('INVALID_REFERENCE', 'Role identity does not match its character.');
          const origin = p.identity.origin;
          if (!origin || !['studioLocal', 'source'].includes(origin.kind))
            fail('INVALID_INPUT', 'Expected identity origin.');
          if (origin.kind === 'source') {
            const pkg = requireValue(store, envelope.projectId, 'sourcePackage', origin.packageId);
            if (!pkg.sourceIdentityMap.some((i) => i.id === origin.canonId || i.canonId === origin.canonId))
              fail('INVALID_REFERENCE', 'Source identity is absent.');
          }
          const existing = readValues(store, envelope.projectId, 'cast')
            .map((r) => r.identity)
            .find((i) => i?.id === p.characterId);
          if (existing && canonicalDigest(existing) !== canonicalDigest(p.identity))
            fail('IDENTITY_CONFLICT', 'Identity changes require an explicit identity link.');
        } else requireValue(store, envelope.projectId, 'identity', p.characterId);
      } else if (p.identity) fail('INVALID_REFERENCE', 'Characterless roles cannot carry an identity.');
      const previousIdentity = aggregate.value?.identity;
      if (previousIdentity && previousIdentity.id !== p.characterId) {
        const otherRoles = readValues(store, envelope.projectId, 'cast').filter((role) => role.id !== p.id);
        const survives = otherRoles.some((role) => role.identity?.id === previousIdentity.id);
        if (!survives) {
          const referenced =
            otherRoles.some((role) => role.characterId === previousIdentity.id) ||
            readValues(store, envelope.projectId, 'scene').some((scene) =>
              scene.occurrences.some((o) => o.characterId === previousIdentity.id)
            ) ||
            readValues(store, envelope.projectId, 'casting').some(
              (decision) => decision.characterId === previousIdentity.id
            ) ||
            readValues(store, envelope.projectId, 'story').some((story) =>
              (story.identityLinks ?? []).some((link) => link.localIdentityId === previousIdentity.id)
            );
          if (referenced)
            fail('INVALID_REFERENCE', 'Cannot remove the only definition of a referenced identity.');
        }
      }
      if (
        aggregate.value &&
        aggregate.value.characterId !== p.characterId &&
        readValues(store, envelope.projectId, 'scene').some((s) =>
          s.occurrences.some((o) => o.roleBindingId === p.id)
        )
      )
        fail('INVALID_REFERENCE', 'Cannot change identity of a referenced role.');
    },
    apply: ({ envelope, aggregate }) => ({
      ...envelope.payload,
      ...(!envelope.payload.identity &&
      aggregate.value?.identity &&
      aggregate.value.identity.id === envelope.payload.characterId
        ? { identity: aggregate.value.identity }
        : {}),
    }),
  });
  service.registerCommand('scene.put', {
    target: ({ envelope }) => ({ kind: 'scene', id: envelope.payload.id }),
    validate: validateSceneSave,
    apply: ({ envelope }) => envelope.payload,
  });
  service.registerCommand('utterance.update', {
    target: ({ envelope }) => ({ kind: 'utterance', id: envelope.payload.id }),
    validate({ store, envelope }) {
      const p = envelope.payload;
      assertId(p.id);
      const scene = readValues(store, envelope.projectId, 'scene').find((s) =>
        s.utterances.some((u) => u.id === p.id)
      );
      if (!scene || (p.sceneId && p.sceneId !== scene.id))
        fail('INVALID_REFERENCE', 'Utterance does not belong to the selected scene.');
      const old = {
        ...scene.utterances.find((u) => u.id === p.id),
        ...store.aggregate(envelope.projectId, { kind: 'utterance', id: p.id }).value,
      };
      validateUtterance(
        { ...old, ...p },
        new Set(scene.occurrences.map((o) => o.id)),
        new Set(scene.utterances.map((u) => u.id))
      );
    },
    apply({ store, envelope }) {
      const p = envelope.payload;
      const scene = readValues(store, envelope.projectId, 'scene').find((s) =>
        s.utterances.some((u) => u.id === p.id)
      );
      return {
        ...scene.utterances.find((u) => u.id === p.id),
        ...store.aggregate(envelope.projectId, { kind: 'utterance', id: p.id }).value,
        ...p,
        sceneId: scene.id,
      };
    },
  });
}

export function validateSceneSave({ store, envelope, aggregate }) {
  const s = envelope.payload;
  assertId(s.id);
  requireValue(store, envelope.projectId, 'production', s.productionId);
  const occurrences = unique(s.occurrences),
    utterances = unique(s.utterances);
  unique(s.shots);
  const others = readValues(store, envelope.projectId, 'scene').filter(
    (other) => other.id !== s.id,
  );
  if (
    others.some(
      (other) =>
        other.occurrences.some((o) => occurrences.has(o.id)) ||
        other.utterances.some((u) => utterances.has(u.id)) ||
        other.shots.some((shot) => s.shots.some((sh) => sh.id === shot.id)),
    )
  )
    fail('INVALID_REFERENCE', 'Scene child identifiers must be project-global.');
  if (aggregate.value && aggregate.value.productionId !== s.productionId)
    fail('INVALID_REFERENCE', 'Scene cannot move to another production.');
  if (s.sourcePackageId) {
    const pkg = requireValue(store, envelope.projectId, 'sourcePackage', s.sourcePackageId);
    for (const id of s.sourceUnitIds ?? [])
      if (!pkg.textUnits.some((u) => u.id === id))
        fail('INVALID_REFERENCE', 'Source text unit is absent.');
  }
  const presentations = new Set();
  if (!Array.isArray(s.presentations)) fail('INVALID_INPUT', 'Expected presentations.');
  for (const b of s.presentations) {
    if (!occurrences.has(b.occurrenceId) || presentations.has(b.occurrenceId))
      fail('INVALID_REFERENCE', 'Presentation occurrence is absent or repeated.');
    presentations.add(b.occurrenceId);
    for (const field of ['appearanceStateRef', 'castingStateRef', 'knowledgeStateRef'])
      if (b[field] != null) requireValue(store, envelope.projectId, 'state', b[field]);
  }
  for (const o of s.occurrences) {
    if (o.sceneId != null && o.sceneId !== s.id)
      fail('INVALID_REFERENCE', 'Occurrence scene is inconsistent.');
    const role = requireValue(store, envelope.projectId, 'cast', o.roleBindingId);
    if ((role.characterId ?? null) !== (o.characterId ?? null))
      fail('INVALID_REFERENCE', 'Occurrence and role identity disagree.');
    if (
      !['onscreen', 'offscreen', 'voiceover', 'inner', 'narrator', 'ensemble'].includes(o.presence)
    )
      fail('INVALID_INPUT', 'Unknown occurrence presence.');
    if (!presentations.has(o.id))
      fail('INVALID_REFERENCE', 'Each occurrence requires an explicit presentation.');
    for (const field of ['temporalStateRef', 'knowledgeStateRef'])
      if (o[field] != null) requireValue(store, envelope.projectId, 'state', o[field]);
  }
  for (const u of s.utterances) validateUtterance(u, occurrences, utterances);
  for (const shot of s.shots) {
    validateShotLayers(store, envelope.projectId, s, shot);
    if (shot.referenceSlotId != null) {
      const slot = requireValue(store, envelope.projectId, 'assetSlot', shot.referenceSlotId);
      if (
        slot.mediaKind !== 'image' ||
        (slot.scope.kind === 'scene' && slot.scope.id !== s.id) ||
        (slot.scope.kind === 'production' && slot.scope.id !== s.productionId) ||
        (slot.scope.kind === 'shot' && slot.scope.id !== shot.id)
      )
        fail('INVALID_REFERENCE', 'Reference slot is outside this shot scope.');
    }
    if (shot.transform != null) validateShotTransform(shot.transform);

    for (const id of [shot.targetOccurrenceId, ...(shot.occurrenceIds ?? [])].filter(Boolean))
      if (!occurrences.has(id)) fail('INVALID_REFERENCE', 'Shot occurrence is absent.');
    const target = s.occurrences.find((o) => o.id === shot.targetOccurrenceId);
    if (target && target.presence !== 'onscreen')
      fail('INVALID_REFERENCE', 'Camera target requires an onscreen occurrence.');
  }
  for (const decision of readValues(store, envelope.projectId, 'casting').filter(
    (d) => d.sceneId === s.id,
  )) {
    if (
      decision.productionId !== s.productionId ||
      (decision.scope === 'shot' && !s.shots.some((shot) => shot.id === decision.shotId)) ||
      (decision.scope === 'occurrence' &&
        !s.occurrences.some(
          (o) =>
            o.id === decision.occurrenceId &&
            (decision.roleId
              ? o.roleBindingId === decision.roleId
              : o.characterId === decision.characterId),
        ))
    ) {
      fail('INVALID_REFERENCE', 'Cannot remove the subject of a casting decision.');
    }
  }
  // Utterances are independently edited. A stale scene save cannot overwrite their content.
  for (const old of aggregate.value?.utterances ?? []) {
    const current = {
      ...old,
      ...store.aggregate(envelope.projectId, { kind: 'utterance', id: old.id }).value,
    };
    const next = s.utterances.find((u) => u.id === old.id);
    const { sceneId: ignored, ...content } = current;
    const { sceneId: nextSceneId, ...nextContent } = next ?? {};
    if (
      !next ||
      (nextSceneId != null && nextSceneId !== s.id) ||
      canonicalDigest(content) !== canonicalDigest(nextContent)
    )
      fail('INVALID_REFERENCE', 'Existing utterances must be edited through utterance.update.');
  }
}

function validateShotTransform(t) {
  const bad = () => fail('INVALID_SHOT_TRANSFORM', 'Invalid shot transform or units.');
  if (
    !t ||
    typeof t !== 'object' ||
    Object.keys(t).some(
      (k) => !['x', 'y', 'scale', 'safeArea', 'anchor', 'easing', 'keyframes'].includes(k),
    )
  )
    bad();
  if (
    !Number.isFinite(t.x) ||
    !Number.isFinite(t.y) ||
    Math.abs(t.x) > 1 ||
    Math.abs(t.y) > 1 ||
    !Number.isFinite(t.scale) ||
    t.scale <= 0 ||
    !['center', 'top', 'bottom'].includes(t.anchor) ||
    !['linear', 'ease-in-out'].includes(t.easing)
  )
    bad();
  if (
    !t.safeArea ||
    Object.keys(t.safeArea).length !== 4 ||
    ['left', 'top', 'right', 'bottom'].some(
      (k) => !Number.isFinite(t.safeArea[k]) || t.safeArea[k] < 0 || t.safeArea[k] > 0.5,
    )
  )
    bad();
  if (!Array.isArray(t.keyframes) || t.keyframes.length > 1000) bad();
  let previous = -1;
  for (const k of t.keyframes) {
    if (
      Object.keys(k).some((f) => !['timeMs', 'x', 'y', 'scale'].includes(f)) ||
      !Number.isSafeInteger(k.timeMs) ||
      k.timeMs < 0 ||
      k.timeMs <= previous ||
      !Number.isFinite(k.x) ||
      Math.abs(k.x) > 1 ||
      !Number.isFinite(k.y) ||
      Math.abs(k.y) > 1 ||
      !Number.isFinite(k.scale) ||
      k.scale <= 0
    )
      bad();
    previous = k.timeMs;
  }
}

// Validate declared layer geometry and subjects at save; acceptance and shot
// duration are checked again against the frozen timeline at Edition creation.
export function validateShotLayers(store, projectId, scene, shot, duration) {
  if (shot.layers === undefined) return;
  if (!Array.isArray(shot.layers) || !shot.layers.length)
    fail('INVALID_INPUT', 'Expected a nonempty explicit layer stack.');
  if (
    shot.layers.some(
      (layer) => !layer || typeof layer !== 'object' || Array.isArray(layer),
    )
  )
    fail('INVALID_INPUT', 'Expected layer objects.');
  const ids = unique(shot.layers);
  const point = (p) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
      fail('INVALID_INPUT', 'Expected finite normalized coordinates.');
  };
  const fields = ['x', 'y', 'scale', 'rotation', 'opacity'];
  const transform = (t) => {
    if (!t || typeof t !== 'object' || Array.isArray(t))
      fail('INVALID_INPUT', 'Expected transform.');
    for (const key of fields)
      if (
        t[key] !== undefined &&
        (!Number.isFinite(t[key]) ||
          (key === 'scale' && t[key] <= 0) ||
          (key === 'opacity' && (t[key] < 0 || t[key] > 1)))
      )
        fail('INVALID_INPUT', 'Invalid layer transform.');
  };
  const times = (items) => {
    if (!Array.isArray(items))
      fail('INVALID_INPUT', 'Expected performance cue array.');
    let last = -1;
    for (const cue of items) {
      if (
        !cue ||
        typeof cue !== 'object' ||
        Array.isArray(cue) ||
        !Number.isSafeInteger(cue.frame) ||
        cue.frame < 0 ||
        cue.frame <= last
      )
        fail(
          'INVALID_INPUT',
          'Performance frames must increase from frame zero.',
        );
      if (duration !== undefined && cue.frame >= duration)
        fail('TIMING_CONFLICT', 'Performance cue lies outside shot.');
      last = cue.frame;
    }
  };
  for (const layer of shot.layers) {
    if (!Number.isFinite(layer.z))
      fail('INVALID_INPUT', 'Expected finite explicit layer order.');
    point(layer.anchor);
    transform(layer.transform ?? {});
    times(layer.keyframes ?? []);
    for (const key of layer.keyframes ?? []) transform(key);
    times(layer.poseCues ?? []);
    for (const cue of layer.poseCues ?? [])
      for (const field of ['expression', 'gaze'])
        if (cue[field] !== undefined && typeof cue[field] !== 'string')
          fail(
            'INVALID_INPUT',
            'Expression and gaze cues are descriptive text.',
          );
    const occurrence = scene.occurrences.find(
      (o) => o.id === layer.occurrenceId,
    );
    if (layer.occurrenceId !== undefined && !occurrence)
      fail('INVALID_REFERENCE', 'Layer occurrence does not belong to scene.');
    for (const id of [
      layer.slotId,
      ...(layer.poseCues ?? []).map((c) => c.slotId),
    ]) {
      const slot = requireValue(store, projectId, 'assetSlot', id);
      if (
        slot.mediaKind !== 'image' ||
        (slot.scope.kind === 'project' && slot.scope.id !== projectId) ||
        (slot.scope.kind === 'production' &&
          slot.scope.id !== scene.productionId) ||
        (slot.scope.kind === 'scene' && slot.scope.id !== scene.id) ||
        (slot.scope.kind === 'shot' && slot.scope.id !== shot.id)
      )
        fail('INVALID_REFERENCE', 'Layer image lies outside shot scope.');
      if (slot.subject.kind === 'environment') {
        if (occurrence)
          fail(
            'INVALID_REFERENCE',
            'An environment image cannot impersonate an occurrence.',
          );
      } else {
        const presentation = scene.presentations.find(
          (p) => p.occurrenceId === occurrence?.id,
        );
        if (
          !occurrence ||
          occurrence.presence !== 'onscreen' ||
          (slot.subject.kind === 'identity'
            ? occurrence.characterId
            : occurrence.roleBindingId) !== slot.subject.id ||
          (presentation?.appearanceStateRef ?? null) !== slot.appearanceStateRef
        )
          fail(
            'INVALID_REFERENCE',
            'Layer image must match its onscreen occurrence identity and appearance state.',
          );
      }
    }
    if (layer.contact !== undefined) {
      point(layer.contact?.anchor);
      if (!ids.has(layer.contact.targetLayerId))
        fail('INVALID_REFERENCE', 'Contact target is absent.');
    }
  }
  const visiting = new Set(),
    done = new Set();
  const visit = (l) => {
    if (visiting.has(l.id)) fail('INVALID_REFERENCE', 'Layer contact cycle.');
    if (done.has(l.id)) return;
    visiting.add(l.id);
    if (l.contact)
      visit(shot.layers.find((x) => x.id === l.contact.targetLayerId));
    visiting.delete(l.id);
    done.add(l.id);
  };
  for (const layer of shot.layers) visit(layer);
}
