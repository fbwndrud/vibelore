import { resolveCasting } from './casting.js';
import { assertId, canonicalDigest, canonicalJSON, fail } from './contracts.js';
import { readValues, requireValue } from './story.js';

export function assetSchema(store) {
  store.write(() => store.db.exec(`
    CREATE TABLE IF NOT EXISTS asset_quarantines(project_id TEXT NOT NULL REFERENCES projects(id),id TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(project_id,id));
    CREATE TABLE IF NOT EXISTS asset_adoptions(project_id TEXT NOT NULL REFERENCES projects(id),id TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(project_id,id));
  `));
}

export function candidateValue(store, projectId, id) {
  assertId(id);
  const row = store.get('SELECT data_json FROM generation_candidates WHERE project_id=? AND id=?', projectId, id);

  if (!row)
    fail('INVALID_REFERENCE', 'Candidate does not belong to this project.');

  return JSON.parse(row.data_json);
}

export function insertCandidate(store, projectId, candidate) {
  store.run(
    'INSERT INTO generation_candidates(project_id,id,attempt_id,data_json) VALUES(?,?,?,?)',
    projectId,
    candidate.id,
    candidate.attemptId ?? null,
    canonicalJSON(candidate)
  );
}

export function insertQuarantine(store, projectId, quarantine) {
  store.run(
    'INSERT INTO asset_quarantines(project_id,id,data_json) VALUES(?,?,?)',
    projectId,
    quarantine.id,
    canonicalJSON(quarantine)
  );
}

export function utteranceAudioBinding(store, projectId, scene, utteranceId, shotId = null, requireResolved = false) {
  const baseline = scene.utterances.find(u => u.id === utteranceId);

  if (!baseline)
    fail('INVALID_REFERENCE', 'Utterance does not belong to the scoped scene.');

  if (shotId && !scene.shots.some(shot => shot.id === shotId))
    fail('INVALID_REFERENCE', 'Audio shot does not belong to the utterance scene.');

  const utterance = {
    ...baseline,

    ...store.aggregate(projectId, { kind: 'utterance', id: utteranceId }).value
  };

  const speaker = scene.occurrences.find(o => o.id === utterance.speakerOccurrenceId);

  if (!speaker)
    fail('INVALID_REFERENCE', 'Audio speaker occurrence is absent.');

  const role = requireValue(store, projectId, 'cast', speaker.roleBindingId), presentation = scene.presentations.find(p => p.occurrenceId === speaker.id);

  const decisions = readValues(store, projectId, 'casting').map(d => ({
    ...d,

    revision: store.aggregate(projectId, { kind: 'casting', id: d.id }).revision
  }));

  const casting = resolveCasting({
    occurrence: { ...speaker, castingStateRef: presentation.castingStateRef ?? null },

    decisions,
    productionId: scene.productionId,
    sceneId: scene.id,
    shotId,
    language: role.language
  });

  if (requireResolved && casting.status !== 'resolved')
    fail('CASTING_UNRESOLVED', 'Audio take requires a resolved voice selection.');

  const { id, sceneId, holdMs, ...performance } = utterance;

  return {
    speakerOccurrenceId: speaker.id,
    roleBindingId: speaker.roleBindingId,
    characterId: speaker.characterId ?? null,
    appearanceStateRef: presentation.appearanceStateRef ?? null,
    castingStateRef: presentation.castingStateRef ?? null,
    language: role.language,
    textDigest: canonicalDigest(utterance.text),
    performanceDigest: canonicalDigest(performance),
    casting
  };
}

export function compatibleTimingPins(previous, current) {
  if (!previous.utterancePerformance || !current.utterancePerformance)
    return false;

  const shape = value => Object.fromEntries(
    Object.keys(current).filter(k => k !== 'target').map(k => [k, k === 'pins' ? value.pins.map(pin => pin.kind === 'utterance' ? { ...pin, revision: 0 } : pin) : value[k]])
  );

  return canonicalDigest(shape(previous)) === canonicalDigest(shape(current));
}

export function slotPins(store, projectId, slot) {
  assertId(slot.id);
  assertId(slot.subject?.id);

  if (!['project', 'production', 'scene', 'shot'].includes(slot.scope?.kind) || !['identity', 'role', 'environment'].includes(slot.subject?.kind))
    fail('INVALID_INPUT', 'Expected asset scope and subject.');

  if (slot.appearanceStateRef !== null)
    requireValue(store, projectId, 'state', slot.appearanceStateRef);

  const scope = pinTarget(store, projectId, slot.scope);

  if (slot.mediaKind === 'audio' && slot.castingStateRef != null)
    requireValue(store, projectId, 'state', slot.castingStateRef);

  let subjectPins = [];
  let audioBinding = null;

  if (slot.utteranceId != null) {
    assertId(slot.utteranceId);

    if (slot.mediaKind !== 'audio' || !['scene', 'shot'].includes(slot.scope.kind))
      fail('INVALID_REFERENCE', 'Audio utterance slots require an owning scene or shot.');

    const scene = requireValue(store, projectId, 'scene', scope.sceneId);
    audioBinding = utteranceAudioBinding(store, projectId, scene, slot.utteranceId, slot.scope.kind === 'shot' ? slot.scope.id : null, true);

    if ((slot.subject.kind === 'role' ? audioBinding.roleBindingId : slot.subject.kind === 'identity' ? audioBinding.characterId : null) !== slot.subject.id || audioBinding.castingStateRef !== (slot.castingStateRef ?? null))
      fail('INVALID_REFERENCE', 'Audio slot must match the actual speaker and resolved casting state.');

    if (slot.appearanceStateRef !== null && audioBinding.appearanceStateRef !== slot.appearanceStateRef)
      fail('INVALID_REFERENCE', 'Declared visual state does not match the audio speaker presentation.');
  }

  if (slot.subject.kind !== 'environment') {
    const role = slot.subject.kind === 'role' ? requireValue(store, projectId, 'cast', slot.subject.id) : readValues(store, projectId, 'cast').find(r => r.identity?.id === slot.subject.id);

    if (!role)
      fail('INVALID_REFERENCE', 'Asset identity is absent.');

    subjectPins = pinTarget(store, projectId, {
      kind: 'cast',
      id: role.id,
      stateRef: slot.mediaKind === 'audio' ? slot.castingStateRef ?? null : slot.appearanceStateRef,

      ...(scope.sourcePackageId ? { sourcePackageId: scope.sourcePackageId } : {})
    }).pins;

    if (slot.mediaKind === 'audio' && slot.appearanceStateRef !== null && slot.appearanceStateRef !== slot.castingStateRef) subjectPins.push(...pinTarget(store, projectId, {
      kind: 'cast',
      id: role.id,
      stateRef: slot.appearanceStateRef,

      ...(scope.sourcePackageId ? { sourcePackageId: scope.sourcePackageId } : {})
    }).pins);

    if (scope.sceneId && !audioBinding) {
      const scene = requireValue(store, projectId, 'scene', scope.sceneId);

      const matches = scene.occurrences.filter(
        o => slot.subject.kind === 'role' ? o.roleBindingId === slot.subject.id : o.characterId === slot.subject.id
      );

      const shot = slot.scope.kind === 'shot' ? scene.shots.find(s => s.id === slot.scope.id) : null;
      const allowed = slot.mediaKind === 'audio' ? matches.map(o => o.id) : shot?.occurrenceIds ?? (shot?.targetOccurrenceId ? [shot.targetOccurrenceId] : matches.map(o => o.id));

      if (!matches.some(o => allowed.includes(o.id) && scene.presentations.some(
        p => p.occurrenceId === o.id && (slot.mediaKind === 'audio' ? p.castingStateRef ?? null : p.appearanceStateRef ?? null) === (slot.mediaKind === 'audio' ? slot.castingStateRef ?? null : slot.appearanceStateRef)
      )))
        fail('INVALID_REFERENCE', 'Subject and appearance state are not authorized in this scope.');
    }
  }

  if (slot.subject.kind === 'environment' && slot.appearanceStateRef !== null) {
    const local = readValues(store, projectId, 'story').find(story => story.states.some(state => state.id === slot.appearanceStateRef));

    if (local) subjectPins.push({
      kind: 'story',
      id: local.id,

      revision: store.aggregate(projectId, { kind: 'story', id: local.id }).revision
    });
    else {
      const selected = readValues(store, projectId, 'sourcePackage').filter(
        pkg => (!scope.sourcePackageId || pkg.id === scope.sourcePackageId) && pkg.sceneScopes.some(scene => Object.values(scene.stateIds ?? {}).flat().includes(slot.appearanceStateRef))
      );

      if (!selected.length)
        fail('INVALID_REFERENCE', 'Asset state is outside the selected source scope.');

      for (const pkg of selected) subjectPins.push({
        kind: 'sourcePackage',
        id: pkg.id,

        revision: store.aggregate(projectId, { kind: 'sourcePackage', id: pkg.id }).revision
      });
    }
  }

  return {
    ...scope,
    pins: [...scope.pins, ...subjectPins],

    ...(audioBinding ? { audioBinding } : {})
  };
}

export function candidateMatchesSlot(store, projectId, candidate, slot, current, restore = false) {
  let intent = candidate.slotIntent ?? candidate.recipe?.assetIntent;

  // Inserted narrower casting decisions can change effective voice semantics without
  // changing any retained dependency revision. Every bound take must match its
  // retained engine binding, regardless of generation/import target kind.
  if (candidate.mediaKind === 'audio' && slot.utteranceId != null) {
    const binding = candidate.utteranceBinding ?? candidate.audioBinding;

    if (!binding || !current.audioBinding)
      fail('SLOT_CONFLICT', 'Audio candidate requires an explicit matching utterance binding.');

    const semantic = value => {
      const { appearanceStateRef, ...audio } = value;

      return audio;
    };

    if (canonicalDigest(semantic(binding)) !== canonicalDigest(semantic(current.audioBinding)))
      fail('SLOT_CONFLICT', 'Audio speaker, text, performance or voice selection differs.');

    // Imports carry a manual, unverified speech binding; generated takes retain
    // the digest of actual requested speech independently of their target label.
    if (candidate.lineage?.kind !== 'import' && candidate.speechTextDigest !== current.audioBinding.textDigest)
      fail('SLOT_CONFLICT', 'Actual requested speech text does not match this utterance.');
  }

  if (candidate.mediaKind === 'audio' && candidate.target.kind === 'utterance') {
    const binding = candidate.utteranceBinding;

    intent = {
      subject: slot.subject.kind === 'role' ? { kind: 'role', id: binding.roleBindingId } : { kind: 'identity', id: binding.characterId },

      appearanceStateRef: slot.appearanceStateRef === null ? null : binding.appearanceStateRef,
      castingStateRef: binding.castingStateRef,
      utteranceId: candidate.target.id
    };
  } else if (candidate.target.kind === 'cast') {
    const role = requireValue(store, projectId, 'cast', candidate.target.id);

    intent = {
      subject: slot.subject.kind === 'role' ? { kind: 'role', id: role.id } : { kind: 'identity', id: role.characterId ?? null },

      appearanceStateRef: candidate.mediaKind === 'audio' ? slot.appearanceStateRef : candidate.target.stateRef ?? null,

      ...(candidate.mediaKind === 'audio' ? { castingStateRef: candidate.target.stateRef ?? null, utteranceId: null } : {})
    };
  }

  if (intent) {
    if (canonicalDigest(intent.subject) !== canonicalDigest(slot.subject) || intent.appearanceStateRef !== slot.appearanceStateRef || (candidate.mediaKind === 'audio' && ((intent.castingStateRef ?? null) !== (slot.castingStateRef ?? null) || (intent.utteranceId ?? null) !== (slot.utteranceId ?? null))))
      fail('SLOT_CONFLICT', 'Candidate subject or appearance state does not match slot.');
  } else if (slot.subject.kind !== 'environment' || slot.appearanceStateRef !== null)
    fail('SLOT_CONFLICT', 'Generated subject and appearance state require explicit asset intent.');

  const target = candidate.target;

  if (target.kind === 'assetSlot') {
    if (target.id !== slot.id)
      fail('SLOT_CONFLICT', 'Candidate belongs to a different slot.');

    if (!restore && (slot.candidateId !== candidate.baseCandidateId || slot.adoptionId !== candidate.baseAdoptionId))
      fail('STALE_BASE', 'Accepted generation base changed.');
  } else if (target.kind === 'utterance') {
    if (candidate.mediaKind !== 'audio' || slot.utteranceId !== target.id || !current.audioBinding)
      fail('SLOT_CONFLICT', 'Candidate belongs to a different utterance.');
  } else if (target.kind === 'production') {
    if (current.productionId !== target.id)
      fail('SLOT_CONFLICT', 'Candidate production does not contain this slot.');
  } else if (target.kind === 'scene') {
    if (current.sceneId !== target.id)
      fail('SLOT_CONFLICT', 'Candidate scene does not contain this slot.');
  } else if (target.kind === 'shot') {
    if (slot.scope.kind !== 'shot' || slot.scope.id !== target.id)
      fail('SLOT_CONFLICT', 'Candidate belongs to another shot.');
  } else if (!['project', 'cast'].includes(target.kind))
    fail('SLOT_CONFLICT', 'Candidate target cannot be adopted in this asset slot.');

  if (candidate.sourcePackageId && current.sourcePackageId && candidate.sourcePackageId !== current.sourcePackageId)
    fail('SOURCE_BINDING_STALE', 'Candidate source package differs from this scope.');
}

export function sameSlot(a, b) {
  return canonicalDigest({
    scope: a.scope,
    subject: a.subject,
    appearanceStateRef: a.appearanceStateRef,
    castingStateRef: a.castingStateRef ?? null,
    utteranceId: a.utteranceId ?? null,
    mediaKind: a.mediaKind
  }) === canonicalDigest({
    scope: b.scope,
    subject: b.subject,
    appearanceStateRef: b.appearanceStateRef,
    castingStateRef: b.castingStateRef ?? null,
    utteranceId: b.utteranceId ?? null,
    mediaKind: b.mediaKind
  });
}

export function checkPins(store, projectId, candidate) {
  for (const pin of candidate.pins ?? []) if (store.aggregate(projectId, pin).revision !== pin.revision) fail(
    pin.kind === 'sourceBinding' ? 'SOURCE_BINDING_STALE' : 'INPUT_STALE',
    'Candidate dependency changed and requires a new explicit decision.'
  );

  if (candidate.productionId) {
    const production = requireValue(store, projectId, 'production', candidate.productionId);

    if (production.sourcePackageId !== candidate.sourcePackageId)
      fail('SOURCE_BINDING_STALE', 'Candidate belongs to an older source binding.');
  }
}

export function ensureCandidateNew(store, projectId, id) {
  assertId(id);

  if (store.get('SELECT id FROM generation_candidates WHERE project_id=? AND id=?', projectId, id) || store.get('SELECT id FROM asset_quarantines WHERE project_id=? AND id=?', projectId, id))
    fail('IMMUTABLE_CANDIDATE', 'Asset revision ID already exists.');
}

export function slotDeclaration(input, mediaKind) {
  if (!input || Object.keys(input).some(
    key => !['id', 'scope', 'subject', 'appearanceStateRef', 'castingStateRef', 'utteranceId'].includes(key)
  ))
    fail('INVALID_INPUT', 'Slot declaration contains unsupported fields.');

  if (mediaKind !== 'audio' && (input.castingStateRef != null || input.utteranceId != null))
    fail('INVALID_INPUT', 'Voice state and utterance bindings require audio media.');

  return {
    id: input.id,
    scope: input.scope,
    subject: input.subject,
    appearanceStateRef: input.appearanceStateRef,
    mediaKind,

    ...(mediaKind === 'audio' ? { castingStateRef: input.castingStateRef ?? null, utteranceId: input.utteranceId ?? null } : {}),

    candidateId: null,
    adoptionId: null
  };
}

export function slotResult(slot, additions = {}) {
  const { candidate, quarantine, ...value } = slot;

  return { ...value, candidateId: slot.candidateId ?? null, adoptionId: slot.adoptionId ?? null, ...additions };
}

function pinCommonTarget(store, projectId, target) {
  const pins = [{ kind: target.kind, id: target.id }];

  let productionId = null, sourcePackageId = target.sourcePackageId ?? null;

  if (target.kind === 'project') {
    if (target.id !== projectId)
      fail('INVALID_REFERENCE', 'Project target must match command project.');

    store.requireProject(projectId);
  } else if (target.kind === 'production') {
    const production = requireValue(store, projectId, 'production', target.id);
    productionId = production.id;

    if (sourcePackageId && sourcePackageId !== production.sourcePackageId)
      fail('SOURCE_BINDING_STALE', 'Requested source does not match production.');

    sourcePackageId = production.sourcePackageId;

    pins.push({ kind: 'sourceBinding', id: productionId });
  } else {
    const role = requireValue(store, projectId, 'cast', target.id);
    const definitions = readValues(store, projectId, 'cast').filter(r => r.identity && r.identity.id === role.characterId);

    for (const definition of definitions) pins.push({ kind: 'cast', id: definition.id });

    const origin = definitions[0]?.identity.origin;

    if (origin?.kind === 'source') {
      pins.push({ kind: 'sourcePackage', id: origin.packageId });

      sourcePackageId ??= origin.packageId;
    }
  }

  if (target.stateRef != null) {
    if (target.kind !== 'cast')
      fail('INVALID_INPUT', 'State references require a cast target.');

    requireValue(store, projectId, 'state', target.stateRef);
    const local = readValues(store, projectId, 'story').find(story => story.states.some(state => state.id === target.stateRef));

    if (local) pins.push({ kind: 'story', id: local.id });
    else {
      const declarations = readValues(store, projectId, 'sourcePackage').filter(
        pkg => (!sourcePackageId || pkg.id === sourcePackageId) && pkg.sceneScopes.some(scope => Object.values(scope.stateIds ?? {}).flat().includes(target.stateRef))
      );

      if (!declarations.length)
        fail('INVALID_REFERENCE', 'State is outside the selected source scope.');

      for (const pkg of declarations) pins.push({ kind: 'sourcePackage', id: pkg.id });

      sourcePackageId ??= declarations[0].id;
    }
  }

  const source = sourcePackageId ? requireValue(store, projectId, 'sourcePackage', sourcePackageId) : null;

  if (source) pins.push({ kind: 'sourcePackage', id: source.id });

  const spans = target.sourceUnitIds ?? [];

  if (!Array.isArray(spans) || spans.some(id => !source?.textUnits.some(unit => unit.id === id)))
    fail('INVALID_REFERENCE', 'Source spans must belong to the pinned package.');

  const unique = Array.from(new Map(pins.map(p => [`${p.kind}:${p.id}`, p])).values()).map(p => ({ ...p, revision: store.aggregate(projectId, p).revision }));

  return {
    target,
    productionId,
    sceneId: null,
    sourcePackageId,
    sourcePackageRevision: source?.sourceRevision ?? null,
    sourceDependencySpans: spans,

    sourceBindingRevision: productionId ? store.aggregate(projectId, { kind: 'sourceBinding', id: productionId }).revision : null,

    pins: unique,
    castingInventory: null,
    targetStateRef: target.stateRef ?? null
  };
}

export function pinTarget(store, projectId, target) {
  if (!target || !['project', 'production', 'cast', 'shot', 'scene', 'utterance', 'assetSlot'].includes(target.kind))
    fail('INVALID_INPUT', 'Unknown generation target kind.');

  assertId(target.id);

  if (target.kind === 'assetSlot') {
    const slot = requireValue(store, projectId, 'assetSlot', target.id);
    const pinned = slotPins(store, projectId, slot);

    return {
      ...pinned,
      target,
      assetSlotId: slot.id,
      baseCandidateId: slot.candidateId,
      baseAdoptionId: slot.adoptionId,
      slotSubject: slot.subject,
      appearanceStateRef: slot.appearanceStateRef,

      ...(slot.mediaKind === 'audio' ? { castingStateRef: slot.castingStateRef ?? null, utteranceId: slot.utteranceId ?? null } : {})
    };
  }

  if (['project', 'production', 'cast'].includes(target.kind))
    return pinCommonTarget(store, projectId, target);

  const scenes = readValues(store, projectId, 'scene');

  const scene = scenes.find(
    s => target.kind === 'scene' ? s.id === target.id : (target.kind === 'shot' ? s.shots : s.utterances).some(x => x.id === target.id)
  );

  if (!scene)
    fail('INVALID_REFERENCE', 'Target does not belong to this project.');

  const production = requireValue(store, projectId, 'production', scene.productionId);
  const sourcePackageId = scene.sourcePackageId ?? production.sourcePackageId;

  if (sourcePackageId !== production.sourcePackageId)
    fail('SOURCE_BINDING_STALE', 'Scene must resolve its source binding before generation.');

  const source = sourcePackageId ? requireValue(store, projectId, 'sourcePackage', sourcePackageId) : null;

  const pins = [{ kind: 'scene', id: scene.id }, ...scene.utterances.map(u => ({ kind: 'utterance', id: u.id })), ...scene.occurrences.map(o => ({ kind: 'cast', id: o.roleBindingId })), ...readValues(store, projectId, 'cast').filter(role => role.identity && scene.occurrences.some(o => o.characterId === role.identity.id)).map(role => ({ kind: 'cast', id: role.id })), ...readValues(store, projectId, 'story').map(story => ({ kind: 'story', id: story.id })), ...readValues(store, projectId, 'casting').map(c => ({ kind: 'casting', id: c.id })), { kind: 'sourceBinding', id: scene.productionId }];

  const unique = Array.from(new Map(pins.map(p => [`${p.kind}:${p.id}`, p])).values()).map(p => ({ ...p, revision: store.aggregate(projectId, p).revision }));

  const utterancePerformance = scene.utterances.map(u => ({ id: u.id, performanceDigest: utteranceAudioBinding(store, projectId, scene, u.id).performanceDigest }));

  const utteranceBinding = target.kind === 'utterance' ? utteranceAudioBinding(store, projectId, scene, target.id, target.shotId ?? null) : null;

  // The casting inventory also detects a newly added, more-specific binding before send.
  return {
    target,
    productionId: scene.productionId,
    sceneId: scene.id,
    sourcePackageId,
    sourcePackageRevision: source?.sourceRevision ?? null,
    sourceDependencySpans: scene.sourceUnitIds ?? [],

    sourceBindingRevision: store.aggregate(projectId, { kind: 'sourceBinding', id: scene.productionId }).revision,

    pins: unique,
    castingInventory: canonicalDigest(readValues(store, projectId, 'casting').map(c => c.id).sort()),
    utterancePerformance,

    ...(utteranceBinding ? { utteranceBinding } : {})
  };
}

export function checkPinnedRequest(store, projectId, request) {
  const current = pinTarget(store, projectId, request.target);

  if (current.sourcePackageId !== request.sourcePackageId || current.sourceBindingRevision !== request.sourceBindingRevision)
    fail('SOURCE_BINDING_STALE', 'Source binding changed and requires explicit review.');

  if (canonicalDigest(current) !== canonicalDigest(Object.fromEntries(Object.keys(current).map(k => [k, request[k]]))))
    fail('INPUT_STALE', 'Generation target or source dependencies changed before dispatch.');
}
