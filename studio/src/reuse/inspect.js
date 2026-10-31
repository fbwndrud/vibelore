import {
  canonicalDigest,
  canonicalJSON,
  assertText,
  fail,
} from '../engine/contracts.js';
import { slotDeclaration, slotPins, sameSlot } from '../engine/asset-slots.js';
import { readValues, requireValue } from '../engine/story.js';
import { hashBytes } from '../source/source-package.js';
import { decodeMedia } from '../assets/decode.js';
import { originKey, validateBundle, validateOriginRef } from './bundle.js';

export const NORMALIZER_VERSION = 'studio-media-v1';
// Portable record convention shared with owner exporters:
// metadata = {mediaKind, roles:string[], subjects:SubjectRef[], audioBinding?,
// speechPerformance?, speakerStateRefs?:OriginRef[], selectedContentSha256?}.
// Original sourcePins stay inert portable evidence. An explicit per-record hash
// selects one directly required `selected-content` file. Without that pin, legacy
// bundles must have exactly one such file; shared evidence is never auto-selected.
// Roles are explicit advertised capabilities: no implicit role-family conversion.
// Purpose is free text. An exact speech take additionally needs portable performance,
// native text/language/voice evidence, and explicit identity/state mapping.
// Native audioBinding.characterId matches the speaking SubjectRef.identityId;
// native castingStateRef matches a source state OriginRef.recordId. Characterless
// narration instead uses speakerStateRefs belonging to its explicit native
// audioBinding.roleBindingId; character speakers never consume that field.
export const CONSUMPTION_ROLES = Object.freeze({
  image: [
    'identity-reference',
    'pose',
    'environment-reference',
    'final-scene',
    'style-reference',
    'edit-target',
  ],
  audio: ['speech-take', 'audio-reference', 'music', 'sfx'],
});
export function portableSpeechPerformance(utterance) {
  const {
    id,
    sceneId,
    holdMs,
    speakerOccurrenceId,
    addresseeOccurrenceIds,
    responseTo,
    ...performance
  } = utterance;
  return JSON.parse(canonicalJSON(performance));
}
function exactFields(value, required, optional = []) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => ![...required, ...optional].includes(k))
  )
    fail('INVALID_INPUT', 'Expected an explicit reuse intent.');
}
export function reuseIntent(input) {
  const intent = JSON.parse(canonicalJSON(input));
  exactFields(
    intent,
    ['target', 'purpose', 'identityMap', 'stateMap', 'selections'],
    ['mode']
  );
  intent.mode ??= 'reuse-preserved';
  if (!['reuse-preserved', 'new-import'].includes(intent.mode))
    fail('INVALID_INPUT', 'Unknown import mode.');
  assertText(intent.purpose);
  for (const k of ['identityMap', 'stateMap', 'selections'])
    if (!Array.isArray(intent[k]))
      fail('INVALID_INPUT', 'Expected reuse mappings and selection.');
  if (intent.selections.length !== 1)
    fail('INVALID_INPUT', 'Select exactly one root and destination slot.');
  const selection = intent.selections[0];
  exactFields(selection, ['source', 'slot', 'role']);
  validateOriginRef(selection.source);
  assertText(selection.role);
  exactFields(intent.target, ['kind', 'id']);
  if (
    intent.target.kind !== 'assetSlot' ||
    intent.target.id !== selection.slot?.id
  )
    fail('INVALID_AGGREGATE', 'Reuse target must be the selected asset slot.');
  for (const map of intent.identityMap) {
    exactFields(map, ['source', 'destinationIdentityId']);
    assertText(map.destinationIdentityId);
    exactFields(
      map.source,
      ['ownerId', 'projectId', 'identityId', 'stateRefs'],
      ['continuityId']
    );
    for (const k of ['ownerId', 'projectId', 'identityId'])
      assertText(map.source[k]);
    if (!Array.isArray(map.source.stateRefs))
      fail('INVALID_INPUT', 'Expected exact source state references.');
    for (const state of map.source.stateRefs) validateOriginRef(state);
  }
  for (const map of intent.stateMap) {
    exactFields(map, ['source', 'destinationStateId']);
    validateOriginRef(map.source);
    assertText(map.destinationStateId);
  }
  if (
    new Set(intent.identityMap.map((m) => canonicalJSON(m.source))).size !==
      intent.identityMap.length ||
    new Set(intent.stateMap.map((m) => originKey(m.source))).size !==
      intent.stateMap.length
  )
    fail('INVALID_INPUT', 'Reuse mappings must be unambiguous.');
  return intent;
}
export function selectedClosure(bundle, source) {
  const selected = originKey(source);
  if (!bundle.roots.some((ref) => originKey(ref) === selected))
    fail('INVALID_REFERENCE', 'Select an exact bundle root.');
  const keys = new Set([selected]);
  let size;
  do {
    size = keys.size;
    for (const link of bundle.links)
      if (link.requirement === 'runtime' && keys.has(originKey(link.from)))
        keys.add(originKey(link.to));
  } while (keys.size !== size);
  const records = bundle.records.filter((r) => keys.has(originKey(r.ref))),
    root = records.find((r) => originKey(r.ref) === selected);
  const hashes = new Set(records.flatMap((r) => r.requiredFileSha256s));
  const files = bundle.files.filter((f) => hashes.has(f.sha256));
  const hasSelector = Object.hasOwn(root.metadata, 'selectedContentSha256');
  const selectedHash = root.metadata.selectedContentSha256;
  if (
    hasSelector &&
    (typeof selectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(selectedHash))
  )
    fail(
      'BUNDLE_INCOMPLETE',
      'Selected content requires an exact SHA-256 hash.'
    );
  const selectedFiles = files.filter(
    (f) =>
      root.requiredFileSha256s.includes(f.sha256) &&
      f.role === 'selected-content' &&
      (!hasSelector || f.sha256 === selectedHash)
  );
  if (selectedFiles.length !== 1)
    fail(
      'BUNDLE_INCOMPLETE',
      'Selected root requires exactly one selected-content file.'
    );
  return { root, records, files, selectedFile: selectedFiles[0] };
}
function subjectIdentity(store, projectId, slot) {
  if (slot.subject.kind === 'environment') return null;
  if (slot.subject.kind === 'identity') return slot.subject.id;
  return (
    requireValue(store, projectId, 'cast', slot.subject.id).characterId ?? null
  );
}
function mappings(store, projectId, slot, pinned, metadata, intent, findings) {
  const subjects = metadata.subjects;
  if (!Array.isArray(subjects))
    fail('INVALID_INPUT', 'Preserved record requires explicit subjects.');
  const targetIdentity = subjectIdentity(store, projectId, slot),
    role = intent.selections[0].role;
  const characterlessSpeech =
    role === 'speech-take' && metadata.audioBinding?.characterId === null;
  const speakerStateRefs = characterlessSpeech
    ? metadata.speakerStateRefs ?? []
    : [];
  if (!Array.isArray(speakerStateRefs))
    fail(
      'INVALID_INPUT',
      'Expected exact characterless speaker state references.'
    );
  for (const state of speakerStateRefs) validateOriginRef(state);
  const referenceOnly =
    slot.subject.kind === 'environment' &&
    slot.utteranceId == null &&
    ['style-reference', 'audio-reference', 'music', 'sfx'].includes(role);
  const scene = pinned.sceneId
    ? requireValue(store, projectId, 'scene', pinned.sceneId)
    : null;
  const shot =
    slot.scope.kind === 'shot'
      ? scene.shots.find((s) => s.id === slot.scope.id)
      : null;
  const allowed =
    shot?.occurrenceIds ??
    (shot?.targetOccurrenceId ? [shot.targetOccurrenceId] : null);
  const mappingRequired = (evidence) =>
    findings.push({
      kind: 'context',
      code: 'REUSE_MAPPING_REQUIRED',
      evidence,
    });
  const identities = new Set(
    readValues(store, projectId, 'cast').flatMap((c) =>
      c.identity ? [c.identity.id] : []
    )
  );
  for (const subject of subjects) {
    exactFields(
      subject,
      ['ownerId', 'projectId', 'identityId', 'stateRefs'],
      ['continuityId']
    );
    for (const k of ['ownerId', 'projectId', 'identityId'])
      assertText(subject[k]);
    if (!Array.isArray(subject.stateRefs))
      fail('INVALID_INPUT', 'Expected source subject states.');
    const map = intent.identityMap.find(
      (m) => canonicalDigest(m.source) === canonicalDigest(subject)
    );
    const occurrences =
      map && scene
        ? scene.occurrences.filter(
            (o) =>
              o.characterId === map.destinationIdentityId &&
              (!allowed || allowed.includes(o.id))
          )
        : [];
    if (
      !referenceOnly &&
      (!map ||
        !identities.has(map.destinationIdentityId) ||
        (scene && !occurrences.length))
    )
      mappingRequired(
        'Map each exact source subject to a real identity authorized in the selected destination scope.'
      );
    else if (map && !identities.has(map.destinationIdentityId))
      mappingRequired('The explicit destination identity is absent.');
    const presentationStates = new Set(
      occurrences
        .flatMap((o) => [
          o.temporalStateRef,
          o.knowledgeStateRef,
          ...scene.presentations
            .filter((p) => p.occurrenceId === o.id)
            .flatMap((p) => [
              p.appearanceStateRef,
              p.castingStateRef,
              p.knowledgeStateRef,
            ]),
        ])
        .filter(Boolean)
    );
    for (const state of subject.stateRefs) {
      validateOriginRef(state);
      const stateMap = intent.stateMap.find(
        (m) => originKey(m.source) === originKey(state)
      );
      if (referenceOnly && !stateMap) continue;
      if (!stateMap) {
        mappingRequired(
          'Map each source state explicitly to a destination state.'
        );
        continue;
      }
      let present = false;
      try {
        requireValue(store, projectId, 'state', stateMap.destinationStateId);
        present = true;
      } catch (error) {
        if (error.code !== 'INVALID_REFERENCE') throw error;
      }
      if (
        !present ||
        (scene && !presentationStates.has(stateMap.destinationStateId))
      )
        mappingRequired(
          'The mapped state must exist and belong to the actual scoped character presentation.'
        );
    }
  }
  if (
    targetIdentity &&
    !subjects.some((subject) =>
      intent.identityMap.some(
        (m) =>
          canonicalDigest(m.source) === canonicalDigest(subject) &&
          m.destinationIdentityId === targetIdentity
      )
    )
  )
    mappingRequired(
      'Map the selected subject explicitly to the destination slot identity.'
    );
  if (
    intent.identityMap.some(
      (m) =>
        !subjects.some((s) => canonicalDigest(s) === canonicalDigest(m.source))
    ) ||
    intent.stateMap.some(
      (m) =>
        ![
          ...subjects.flatMap((subject) => subject.stateRefs),
          ...speakerStateRefs,
        ].some((ref) => originKey(ref) === originKey(m.source))
    )
  )
    fail(
      'INVALID_INPUT',
      'Mappings must refer to subjects or actual speaker states of the selected record.'
    );
  for (const map of intent.stateMap) {
    if (
      !speakerStateRefs.some(
        (state) => originKey(state) === originKey(map.source)
      )
    )
      continue;
    if (map.destinationStateId !== slot.castingStateRef)
      mappingRequired(
        'Map characterless speaker state evidence to the actual destination casting state.'
      );
    else requireValue(store, projectId, 'state', map.destinationStateId);
  }
  if (!referenceOnly)
    for (const state of new Set(
      [slot.appearanceStateRef, slot.castingStateRef].filter(Boolean)
    ))
      if (!intent.stateMap.some((m) => m.destinationStateId === state))
        mappingRequired(
          'Explicitly map the source state to the destination slot state.'
        );
  if (role === 'speech-take' && metadata.audioBinding && pinned.audioBinding) {
    if (!Object.hasOwn(metadata.audioBinding, 'characterId'))
      mappingRequired(
        'The source speech binding must explicitly identify its speaker or characterless narration.'
      );
    if (
      characterlessSpeech &&
      (typeof metadata.audioBinding.roleBindingId !== 'string' ||
        !metadata.audioBinding.roleBindingId.trim())
    )
      mappingRequired(
        'Characterless narration requires an explicit native source role binding.'
      );
    const sourceSpeaker = metadata.audioBinding.characterId ?? null;
    const destinationSpeaker = pinned.audioBinding.characterId ?? null;
    if (
      sourceSpeaker === null
        ? destinationSpeaker !== null
        : !subjects.some(
            (subject) =>
              subject.identityId === sourceSpeaker &&
              intent.identityMap.some(
                (map) =>
                  canonicalDigest(map.source) === canonicalDigest(subject) &&
                  map.destinationIdentityId === destinationSpeaker
              )
          )
    )
      mappingRequired(
        'Map the source speech speaker to the actual destination speaker, independently of other depicted subjects.'
      );
  }
  if (
    role === 'speech-take' &&
    metadata.audioBinding?.castingStateRef != null
  ) {
    const original = metadata.audioBinding;
    const speakingSubjects = subjects.filter(
      (subject) =>
        subject.identityId === original.characterId &&
        intent.identityMap.some(
          (map) =>
            canonicalDigest(map.source) === canonicalDigest(subject) &&
            map.destinationIdentityId === pinned.audioBinding?.characterId
        )
    );
    // Native state evidence belongs to the actual mapped source speaker. Another
    // depicted subject cannot lend its state, even when both local voices agree.
    let sourceSpeakerStates = [];
    if (characterlessSpeech) {
      if (
        typeof original.roleBindingId === 'string' &&
        original.roleBindingId.trim()
      )
        sourceSpeakerStates = speakerStateRefs;
    } else if (speakingSubjects.length === 1) {
      sourceSpeakerStates = speakingSubjects[0].stateRefs;
    }
    const sourceState = sourceSpeakerStates.find(
      (state) => state.recordId === original.castingStateRef
    );
    if (
      !sourceState ||
      !intent.stateMap.some(
        (m) =>
          originKey(m.source) === originKey(sourceState) &&
          m.destinationStateId === slot.castingStateRef
      )
    )
      mappingRequired(
        'Map the source speaker casting state to the actual destination casting state.'
      );
  }
}

// The slot scope may be project-wide and otherwise pin only the project itself.
// Explicitly mapped identity/state meanings must still participate in reuse/CAS
// validation and be retained on the candidate for later use decisions.
function mappedSemanticPins(store, projectId, intent, pinned) {
  const pins = [...pinned.pins];
  const add = (kind, id) =>
    pins.push({
      kind,
      id,
      revision: store.aggregate(projectId, { kind, id }).revision,
    });
  const identities = new Set(
    intent.identityMap.map((map) => map.destinationIdentityId)
  );
  for (const cast of readValues(store, projectId, 'cast'))
    if (identities.has(cast.characterId) || identities.has(cast.identity?.id)) {
      add('cast', cast.id);
      if (cast.identity?.origin?.kind === 'source')
        add('sourcePackage', cast.identity.origin.packageId);
    }
  const states = new Set(intent.stateMap.map((map) => map.destinationStateId));
  for (const story of readValues(store, projectId, 'story'))
    if (story.states.some((state) => states.has(state.id)))
      add('story', story.id);
  for (const pkg of readValues(store, projectId, 'sourcePackage'))
    if (
      pkg.sceneScopes.some((scope) =>
        Object.values(scope.stateIds ?? {})
          .flat()
          .some((id) => states.has(id))
      )
    )
      add('sourcePackage', pkg.id);
  return {
    ...pinned,
    pins: [
      ...new Map(pins.map((pin) => [`${pin.kind}:${pin.id}`, pin])).values(),
    ],
  };
}

function speechMatches(store, projectId, slot, pinned, metadata) {
  if (
    !slot.utteranceId ||
    !pinned.audioBinding ||
    !metadata.audioBinding ||
    !metadata.speechPerformance ||
    typeof metadata.speechPerformance.text !== 'string'
  )
    return false;
  const original = metadata.audioBinding,
    local = pinned.audioBinding;
  const scene = requireValue(store, projectId, 'scene', pinned.sceneId);
  const effective = {
    ...scene.utterances.find((u) => u.id === slot.utteranceId),
    ...store.aggregate(projectId, { kind: 'utterance', id: slot.utteranceId })
      .value,
  };
  return (
    canonicalDigest(metadata.speechPerformance.text) === original.textDigest &&
    original.textDigest === local.textDigest &&
    original.language === local.language &&
    canonicalDigest(metadata.speechPerformance) ===
      canonicalDigest(portableSpeechPerformance(effective)) &&
    original.casting?.status === 'resolved' &&
    original.casting.voice === local.casting.voice &&
    original.casting.language === local.casting.language
  );
}
export function evaluateInspection({
  bundle,
  intent,
  closure,
  decoded,
  destination,
}) {
  const { service, projectId } = destination,
    { store } = service;
  store.requireProject(projectId);
  const selection = intent.selections[0],
    metadata = closure.root.metadata,
    mediaKind = metadata.mediaKind;
  const findings = [],
    materializations = [];
  let disposition = 'compatible',
    pinned = null,
    slot = null;
  if (
    !Object.hasOwn(CONSUMPTION_ROLES, mediaKind) ||
    !CONSUMPTION_ROLES[mediaKind].includes(selection.role)
  ) {
    disposition = 'unsupported';
    findings.push({
      kind: 'contract',
      code: 'REUSE_MEDIA_UNSUPPORTED',
      evidence:
        'This destination supports only the advertised image/audio consumption roles.',
    });
  } else {
    slot = slotDeclaration(selection.slot, mediaKind);
    pinned = slotPins(store, projectId, slot);
    const current = store.aggregate(projectId, intent.target);
    if (current.value && !sameSlot(current.value, slot))
      fail('SLOT_CONFLICT', 'Existing slot declaration differs.');
    if (
      !Array.isArray(metadata.roles) ||
      !metadata.roles.includes(selection.role)
    ) {
      disposition = 'needs_derivation';
      findings.push({
        kind: 'context',
        code: 'REUSE_ROLE_INCOMPATIBLE',
        evidence:
          'The source does not advertise this consumption role; select another role or derive suitable content.',
      });
    }
    if (
      (selection.role === 'environment-reference' &&
        slot.subject.kind !== 'environment') ||
      (['identity-reference', 'pose'].includes(selection.role) &&
        slot.subject.kind === 'environment') ||
      (selection.role === 'speech-take' && !slot.utteranceId) ||
      (slot.audioRole != null && selection.role !== slot.audioRole) ||
      (['audio-reference', 'music', 'sfx'].includes(selection.role) &&
        slot.utteranceId)
    )
      fail(
        'INVALID_REFERENCE',
        'The consumption role does not match the destination slot subject/binding.'
      );
    mappings(store, projectId, slot, pinned, metadata, intent, findings);
    pinned = mappedSemanticPins(store, projectId, intent, pinned);
    if (findings.some((f) => f.code === 'REUSE_MAPPING_REQUIRED'))
      disposition = 'needs_decision';
    if (
      selection.role === 'speech-take' &&
      !speechMatches(store, projectId, slot, pinned, metadata)
    ) {
      if (disposition !== 'needs_decision') disposition = 'needs_derivation';
      findings.push({
        kind: 'context',
        code: 'REUSE_SPEECH_INCOMPATIBLE',
        evidence:
          'Exact speech requires matching mapped speaker/states, text, language, portable performance and voice.',
      });
    }
    materializations.push({
      sourceSha256: closure.selectedFile.sha256,
      canonicalSha256: hashBytes(decoded.bytes),
      metadataDigest: canonicalDigest(decoded.metadata),
      normalizerVersion: NORMALIZER_VERSION,
    });
    if (
      materializations[0].sourceSha256 !== materializations[0].canonicalSha256
    )
      findings.push({
        kind: 'advisory',
        code: 'REUSE_NORMALIZATION_CHANGED',
        evidence:
          'Destination normalization changes consumed bytes; original selected bytes remain preserved.',
      });
    findings.push({
      kind: 'advisory',
      code: 'REUSE_TECHNICAL_FIT_ONLY',
      evidence:
        'Technical compatibility does not imply subjective review, adoption or verified speech performance.',
    });
  }
  const view = {
    bundleSha256: bundle.manifestSha256,
    destinationPinsDigest: canonicalDigest({ projectId, slot, pinned }),
    intentDigest: canonicalDigest(intent),
    disposition,
    materializations,
    findings,
  };
  return {
    inspection: { ...view, inspectionDigest: canonicalDigest(view) },
    slot,
    pinned,
  };
}
export async function prepareReuseInspection({
  bundle,
  bytes,
  destination,
  intent,
}) {
  bundle = validateBundle(bundle, bytes);
  intent = reuseIntent(intent);
  const closure = selectedClosure(bundle, intent.selections[0].source),
    mediaKind = closure.root.metadata.mediaKind;
  const decoded = Object.hasOwn(CONSUMPTION_ROLES, mediaKind)
    ? await decodeMedia(
        Uint8Array.from(bytes[closure.selectedFile.sha256]),
        mediaKind
      )
    : null;
  return {
    bundle,
    intent,
    closure,
    decoded,
    ...evaluateInspection({ bundle, intent, closure, decoded, destination }),
  };
}
export async function inspectReuse(input) {
  try {
    return (await prepareReuseInspection(input)).inspection;
  } catch (error) {
    if (!error.code) throw error;
    const view = {
      bundleSha256: input.bundle?.manifestSha256 ?? '',
      destinationPinsDigest: '',
      intentDigest: canonicalDigest(input.intent),
      disposition: 'blocked',
      materializations: [],
      findings: [
        { kind: 'contract', code: error.code, evidence: error.message },
      ],
    };
    return { ...view, inspectionDigest: canonicalDigest(view) };
  }
}
