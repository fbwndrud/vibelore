import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  rm,
  rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { withStudio } from './helpers/project.js';
import { sharedWorld } from '../../test/fixtures/shared-lore.js';
import { AssetCatalogStore } from '../../src/store/asset-catalog-store.js';
import { openLibrary } from '../src/library/index.js';
import { createStudioOwnerAdapter } from '../src/source/export-studio-assets.js';
import { createVibeloreOwnerAdapter } from '../src/source/export-vibelore-assets.js';
import { startStudioHttp } from '../src/transport/http.js';
import { StudioAPI, command } from '../ui/api.js';
import { PreservationQueue } from '../ui/library.js';
import { hashBytes } from '../src/source/source-package.js';
import { canonicalDigest } from '../src/engine/contracts.js';
import { nativeRevision } from '../src/engine/asset-cycles.js';
import { restoreStudioBackup } from '../src/engine/backup.js';
import { tone } from './helpers/render-fixture.js';
import { run } from '../src/render/probe.js';
const local = (kind, value) => ({
  projectId: 'p1',
  recordKind: kind,
  recordId: value.id,
  revision: nativeRevision(kind, value),
});
async function inventory(directory, prefix = '') {
  const values = {};
  for (const item of await readdir(join(directory, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, item.name);
    if (item.isDirectory())
      Object.assign(values, await inventory(directory, path));
    else values[path] = hashBytes(await readFile(join(directory, path)));
  }
  return values;
}
async function client(t, service, library) {
  const server = await startStudioHttp({ service, library });
  t.after(server.close);
  const api = new StudioAPI({
    baseURL: server.url,
    fetchImpl: (url, init = {}) =>
      fetch(url, { ...init, headers: { ...init.headers, origin: server.url } }),
  });
  await api.connect();
  return { api, server };
}
async function send(api, type, kind, id, payload) {
  return api.command(command(await api.snapshot(), type, kind, id, payload));
}
async function register(api, directory, adapterKind, allowedProjects) {
  const current = await api.libraryQuery({ type: 'find' });
  const receipt = await api.libraryCommand({
    commandId: crypto.randomUUID(),
    expectedRegistryRevision: current.registryRevision,
    type: 'owner.register',
    payload: { adapterKind, locator: { directory }, allowedProjects },
  });
  await refresh(api, receipt.ownerId);
  return receipt.ownerId;
}
async function refresh(api, ownerId) {
  const current = await api.libraryQuery({ type: 'find' });
  return api.libraryCommand({
    commandId: crypto.randomUUID(),
    expectedRegistryRevision: current.registryRevision,
    type: 'owner.refresh',
    payload: { ownerId },
  });
}
const exportRef = (api, ref) =>
  api.libraryExport({
    ownerId: ref.ownerId,
    roots: [ref],
    disclosure: {
      includedScope:
        'Explicit selected fixture for local three-cycle acceptance',
      omittedEvidence: [],
    },
  });
async function initStory(api) {
  await send(api, 'story.save', 'story', 'story', {
    id: 'story',
    title: 'Unrestricted fixture',
    text: 'Local diagnostic only',
    states: [{ id: 'adult' }],
    revealPolicy: {},
  });
  await send(api, 'cast.put', 'cast', 'actor', {
    id: 'actor',
    name: 'Local interpretation',
    language: 'ko',
    characterId: 'char',
    identity: { id: 'char', origin: { kind: 'studioLocal' } },
  });
}
async function scene(api, id, productionId, slotId, motion = 0) {
  return send(api, 'scene.put', 'scene', id, {
    id,
    productionId,
    title: 'Diagnostic scene; no artistic claim',
    occurrences: [
      {
        id: `${id}-actor`,
        roleBindingId: 'actor',
        characterId: 'char',
        presence: 'onscreen',
      },
    ],
    presentations: [
      { occurrenceId: `${id}-actor`, appearanceStateRef: 'adult' },
    ],
    utterances: [],
    shots: [
      {
        id: `${id}-shot`,
        layers: [
          {
            id: 'actor',
            slotId,
            occurrenceId: `${id}-actor`,
            z: 0,
            anchor: { x: 0.5, y: 0.5 },
            transform: { x: motion, y: 0, scale: 0.8 },
            keyframes: [{ frame: 10, x: -motion }],
          },
        ],
      },
    ],
  });
}
async function importImage(api, entry, data, slotId, purpose, role) {
  const subject = data.bundle.records.find(
    (x) =>
      x.ref.recordId === entry.ref.recordId &&
      x.ref.recordKind === entry.ref.recordKind,
  ).metadata.subjects[0];
  const slot = {
    id: slotId,
    scope: { kind: 'project', id: 'p1' },
    subject: { kind: 'identity', id: 'char' },
    appearanceStateRef: 'adult',
  };
  const intent = {
    target: { kind: 'assetSlot', id: slotId },
    purpose,
    identityMap: [{ source: subject, destinationIdentityId: 'char' }],
    stateMap: subject.stateRefs.map((source) => ({
      source,
      destinationStateId: 'adult',
    })),
    selections: [{ source: entry.ref, slot, role }],
  };
  const inspected = await api.inspectReuse({ ...data, intent });
  assert.equal(inspected.disposition, 'compatible', JSON.stringify(inspected));
  const result = await send(api, 'asset.importBundle', 'assetSlot', slotId, {
    ...data,
    intent,
    inspectionDigest: inspected.inspectionDigest,
    actor: 'fixture-author',
    reason: purpose,
  });
  return { result: result.value, intent, inspected };
}
const adopt = (api, slotId, candidateId) =>
  send(api, 'candidate.adopt', 'assetSlot', slotId, {
    slotId,
    candidateId,
    actor: 'fixture-author',
    reason: 'Explicit diagnostic selection; artistic quality unobserved',
  });
async function freeze(api, id, productionId, sceneId, tracks = []) {
  await send(api, 'timeline.update', 'timeline', productionId, {
    productionId,
    sceneIds: [sceneId],
    sceneDurations: [{ sceneId, durationMs: 500 }],
    tracks,
  });
  return (
    await send(api, 'edition.create', 'edition', id, {
      id,
      productionId,
      profile: 'landscape',
    })
  ).value;
}
async function rendered(api, service, edition, id) {
  const started = performance.now();
  const output = (
    await send(api, 'edition.render', 'editionOutput', id, {
      editionId: edition.id,
      renderId: id,
    })
  ).value;
  assert.equal(output.status, 'completed', JSON.stringify(output));
  assert.equal(output.manifest.checks.decodedVideo, true);
  assert.equal(output.manifest.durationSeconds, 0.5);
  const path = `/tmp/task8-${id}.mp4`;
  await writeFile(
    path,
    await service.readBlob('p1', output.manifest.output.blobId),
  );
  const decoded = await run(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-f', 'null', '-'],
    { timeoutMs: 30000 },
  );
  assert.equal(decoded.stderr, '');
  return { output, localElapsedMs: performance.now() - started, path };
}
async function recordCycle(
  api,
  id,
  inputRefs,
  producedRefs,
  decisionRefs,
  outputRefs,
  previousCycleRefs = [],
) {
  return (
    await send(api, 'cycle.record', 'cycle', id, {
      record: {
        id,
        purpose: `Fixture cycle ${id}: exact bytes, explicit decisions`,
        previousCycleRefs,
        externalObservations: [...inputRefs, ...previousCycleRefs]
          .filter((ref) => ref.ownerId)
          .map((ref) => ({
            ref,
            scope:
              'Exact Library observation and selected preserved fixture bytes',
          })),
        inputUses: inputRefs.map((ref) => ({
          ref,
          purpose: 'explicit fixture input',
        })),
        producedRefs,
        decisionRefs,
        outputRefs,
        executionRefs: [],
      },
      actor: 'fixture-author',
      reason: 'Actual local workflow evidence',
    })
  ).value;
}

test(
  'three public cycles preserve exact source, mapped pose and local outputs offline through projection rebuild, GC and backup restore',
  { timeout: 180000 },
  async (t) => {
    const started = performance.now(),
      world = await sharedWorld();
    t.after(() => rm(world.root, { recursive: true, force: true }));
    const jpeg = await sharp({
      create: { width: 2, height: 1, channels: 3, background: 'red' },
    })
      .jpeg()
      .toBuffer();
    const portrait = join(world.root, 'portrait.jpg');
    await writeFile(portrait, jpeg);
    const catalog = new AssetCatalogStore(world.root, 'u1'),
      proposal = await catalog.propose({
        expectedHead: null,
        loreRevisionId: world.head,
        reason: 'Public diagnostic image fixture',
        assets: [
          {
            assetId: 'portrait',
            sourcePath: portrait,
            label: 'Fixture portrait',
            entityId: 'character-a',
            stateIds: ['state-before'],
          },
        ],
      });
    await catalog.decide({
      expectedHead: null,
      proposalId: proposal.proposalId,
      decision: 'approve',
    });
    const canonBefore = await inventory(world.root),
      libraryDirectory = await mkdtemp(join(tmpdir(), 'cycle-library-'));
    const adapters = {
      studio: createStudioOwnerAdapter,
      vibelore: createVibeloreOwnerAdapter,
    };
    let library = await openLibrary({ directory: libraryDirectory, adapters });
    t.after(async () => {
      await library.close();
      await rm(libraryDirectory, { recursive: true, force: true });
    });
    let calls = 0;
    const providers = {
      fake: {
        capabilities: async () => ({
          kinds: ['image', 'audio'],
          models: ['fixture'],
        }),
        generate: async () => {
          calls++;
          throw new Error('No provider allowed in import cycles');
        },
      },
    };
    const a = await withStudio(t, { providers }),
      b = await withStudio(t, { providers }),
      ca = await client(t, a.service, library),
      cb = await client(t, b.service, library);
    await initStory(ca.api);
    await initStory(cb.api);
    const loreOwner = await register(ca.api, world.root, 'vibelore', ['u1']);
    const lore = (
      await ca.api.libraryQuery({ type: 'find', ownerId: loreOwner })
    ).entries;
    const sourceEntry = lore.find(
        (x) => x.ref.recordKind === 'document' && x.ref.recordId === 'before',
      ),
      imageEntry = lore.find((x) => x.ref.recordId === 'portrait');
    assert.ok(sourceEntry && imageEntry);
    assert.equal(imageEntry.subjects[0].identityId, 'character-a');
    assert.equal(imageEntry.subjects[0].stateRefs[0].recordId, 'state-before');
    const sourceBundle = await exportRef(ca.api, sourceEntry.ref),
      imageBundle = await exportRef(ca.api, imageEntry.ref);
    assert.doesNotMatch(
      JSON.stringify(sourceBundle),
      /FUTURE_SECRET_TOKEN|AFTER_BODY_ONLY/,
    );
    const sourceEnvelope = command(
      await ca.api.snapshot(),
      'source.importBundle',
      'sourcePackage',
      'source-a',
      {
        ...sourceBundle,
        sourcePackageId: 'source-a',
        title: 'Selected published state text',
        language: 'ko',
        actor: 'fixture-author',
        reason: 'Exact public selected source',
      },
    );
    const badEnvelope = command(
      await ca.api.snapshot(),
      'asset.importBundle',
      'assetSlot',
      'bad',
      {
        ...imageBundle,
        bytes: {},
        intent: {},
        inspectionDigest: 'invalid',
        actor: 'fixture-author',
        reason: 'Deliberate incomplete image',
      },
    );
    let saved;
    const storage = {
      load: async () => saved,
      save: async (_key, v) => {
        saved = structuredClone(v);
      },
    };
    const queue = await new PreservationQueue('A:p1', storage).load();
    await queue.add(sourceEnvelope, 'text');
    await queue.add(badEnvelope, 'image');
    await queue.resume((e) => ca.api.command(e));
    assert.ok(queue.items[0].receipt);
    assert.equal(queue.items[1].status, 'unfinished');
    const recovered = await new PreservationQueue('A:p1', storage).load();
    let retries = 0;
    await recovered.resume((e) => {
      retries++;
      assert.equal(e.commandId, badEnvelope.commandId);
      return ca.api.command(e);
    });
    assert.equal(retries, 1);
    assert.equal((await ca.api.snapshot()).productions.length, 0);
    await send(ca.api, 'source.manuscript', 'sourcePackage', 'independent', {
      id: 'independent',
      title: 'Independent manuscript',
      language: 'ko',
      bytes: [...Buffer.from('\ufeff독립 원고\r\n')],
    });
    await send(ca.api, 'production.create', 'production', 'first', {
      id: 'first',
      title: 'Cycle A',
      sourcePackageId: 'source-a',
    });
    // Actual scoped character occurrence must exist before identity/state mapping.
    await send(ca.api, 'scene.put', 'scene', 'a-scene', {
      id: 'a-scene',
      productionId: 'first',
      occurrences: [
        {
          id: 'a-scene-actor',
          roleBindingId: 'actor',
          characterId: 'char',
          presence: 'onscreen',
        },
      ],
      presentations: [
        { occurrenceId: 'a-scene-actor', appearanceStateRef: 'adult' },
      ],
      utterances: [],
      shots: [],
    });
    const importedA = await importImage(
      ca.api,
      imageEntry,
      imageBundle,
      'a-image',
      'First interpretation',
      'identity-reference',
    );
    assert.ok(
      importedA.inspected.findings.some(
        (f) => f.code === 'REUSE_NORMALIZATION_CHANGED',
      ),
    );
    assert.equal(importedA.result.candidate.rawBlobId, hashBytes(jpeg));
    await adopt(ca.api, 'a-image', importedA.result.candidate.id);
    await scene(ca.api, 'a-scene', 'first', 'a-image', 0.1);
    const editionA = await freeze(ca.api, 'edition-a', 'first', 'a-scene'),
      outA = await rendered(ca.api, a.service, editionA, 'cycle1');
    const snapshotA = await ca.api.snapshot();
    const cycleA = await recordCycle(
      ca.api,
      'cycle-a',
      [sourceEntry.ref, imageEntry.ref],
      [
        local('candidate', importedA.result.candidate),
        local('edition', editionA),
      ],
      snapshotA.adoptions.map((x) => local('adoption', x)),
      [local('editionOutput', outA.output)],
    );
    const aOwner = await register(ca.api, a.directory, 'studio', ['p1']);
    let entries = (await ca.api.libraryQuery({ type: 'find', ownerId: aOwner }))
      .entries;
    const aPose = entries.find(
      (x) =>
        x.ref.recordKind === 'candidate' &&
        x.ref.recordId === importedA.result.candidate.id,
    );
    assert.deepEqual(aPose.roles, ['pose']);
    const aOldRef = structuredClone(aPose.ref),
      poseBundle = await exportRef(ca.api, aOldRef),
      cycleARef = entries.find(
        (x) => x.ref.recordKind === 'cycle' && x.ref.recordId === cycleA.id,
      ).ref;
    await send(cb.api, 'production.create', 'production', 'second', {
      id: 'second',
      title: 'Cycle B',
      sourcePackageId: null,
    });
    await send(cb.api, 'scene.put', 'scene', 'b-scene', {
      id: 'b-scene',
      productionId: 'second',
      occurrences: [
        {
          id: 'b-scene-actor',
          roleBindingId: 'actor',
          characterId: 'char',
          presence: 'onscreen',
        },
      ],
      presentations: [
        { occurrenceId: 'b-scene-actor', appearanceStateRef: 'adult' },
      ],
      utterances: [],
      shots: [],
    });
    const importedB = await importImage(
      cb.api,
      aPose,
      poseBundle,
      'b-pose',
      'Crop for a different pose composition',
      'pose',
    );
    await adopt(cb.api, 'b-pose', importedB.result.candidate.id);
    const derived = (
      await send(cb.api, 'asset.derive', 'assetSlot', 'b-pose', {
        id: 'derived-pose',
        slotId: 'b-pose',
        baseCandidateId: importedB.result.candidate.id,
        operation: 'crop',
        rect: { left: 0, top: 0, width: 1, height: 1 },
        actor: 'fixture-author',
      })
    ).value.candidate;
    assert.deepEqual(derived.lineage.parentCandidateIds, [
      importedB.result.candidate.id,
    ]);
    await adopt(cb.api, 'b-pose', derived.id);
    await scene(cb.api, 'b-scene', 'second', 'b-pose', -0.1);
    const editionB = await freeze(cb.api, 'edition-b', 'second', 'b-scene'),
      outB = await rendered(cb.api, b.service, editionB, 'cycle2'),
      snapshotB = await cb.api.snapshot();
    const cycleB = await recordCycle(
      cb.api,
      'cycle-b',
      [aOldRef],
      [local('candidate', derived), local('edition', editionB)],
      snapshotB.adoptions.map((x) => local('adoption', x)),
      [local('editionOutput', outB.output)],
      [cycleARef],
    );
    await send(cb.api, 'case.record', 'productionCase', 'fixture-case', {
      record: {
        id: 'fixture-case',
        question: 'Can the selected local pose be preserved and cropped?',
        contextRefs: [aOldRef],
        literalInputRefs: [aOldRef],
        externalObservations: [
          { ref: aOldRef, scope: 'Exact A pose bytes preserved into B' },
        ],
        trials: [
          {
            id: 'local-crop',
            kind: 'fixture',
            status: 'succeeded',
            inputRefs: [aOldRef],
            producedRefs: [local('candidate', derived)],
            decisionRefs: [local('adoption', snapshotB.adoptions.at(-1))],
            outputRefs: [local('editionOutput', outB.output)],
            executionRefs: [],
            conditions: {
              task: 'Diagnostic local crop and decode',
              budgetMicros: 0,
            },
            omissions: [
              'No actual model invocation',
              'No artistic evaluator',
              'Rights unknown',
            ],
          },
        ],
        observations: [
          {
            id: 'decode',
            targetRef: local('editionOutput', outB.output),
            scope: 'Local fixture MP4 decodes',
            perspective: 'self-review',
            evaluator: { id: 'fixture-author', relationship: 'self' },
            text: 'Technical decoder succeeded only',
            score: null,
            rights: 'unknown',
          },
        ],
        unknowns: [
          'quality',
          'audience perception',
          'rights',
          'paid provider costs',
        ],
        classification: 'unobserved',
      },
      actor: 'fixture-author',
      reason: 'Scoped diagnostic evidence',
    });
    const bOwner = await register(cb.api, b.directory, 'studio', ['p1']);
    entries = (await cb.api.libraryQuery({ type: 'find', ownerId: bOwner }))
      .entries;
    const bPose = entries.find(
        (x) =>
          x.ref.recordKind === 'candidate' && x.ref.recordId === derived.id,
      ),
      bOutput = entries.find(
        (x) =>
          x.ref.recordKind === 'editionOutput' && x.ref.recordId === 'cycle2',
      );
    assert.ok(bPose && bOutput);
    const bBundle = await exportRef(cb.api, bPose.ref),
      videoBundle = await exportRef(cb.api, bOutput.ref);
    assert.equal(
      videoBundle.bundle.records.find((x) => x.ref.recordId === 'cycle2')
        .metadata.mediaKind,
      'video',
    );
    const unsupported = await cb.api.inspectReuse({
      ...videoBundle,
      intent: {
        target: { kind: 'assetSlot', id: 'video' },
        purpose: 'Unsupported video clip use',
        identityMap: [],
        stateMap: [],
        selections: [
          {
            source: bOutput.ref,
            role: 'final-scene',
            slot: {
              id: 'video',
              scope: { kind: 'project', id: 'p1' },
              subject: { kind: 'environment', id: 'room' },
              appearanceStateRef: null,
            },
          },
        ],
      },
    });
    assert.equal(unsupported.disposition, 'unsupported');
    await send(cb.api, 'production.create', 'production', 'third', {
      id: 'third',
      title: 'Cycle C: changed motion and music',
      sourcePackageId: null,
    });
    await send(cb.api, 'scene.put', 'scene', 'c-scene', {
      id: 'c-scene',
      productionId: 'third',
      occurrences: [
        {
          id: 'c-scene-actor',
          roleBindingId: 'actor',
          characterId: 'char',
          presence: 'onscreen',
        },
      ],
      presentations: [
        { occurrenceId: 'c-scene-actor', appearanceStateRef: 'adult' },
      ],
      utterances: [],
      shots: [],
    });
    const importedC = await importImage(
      cb.api,
      bPose,
      bBundle,
      'c-pose',
      'New motion in a third production',
      'pose',
    );
    await adopt(cb.api, 'c-pose', importedC.result.candidate.id);
    await scene(cb.api, 'c-scene', 'third', 'c-pose', 0.25);
    const soundSlot = {
      id: 'music',
      scope: { kind: 'production', id: 'third' },
      subject: { kind: 'environment', id: 'sound' },
      appearanceStateRef: null,
      audioRole: 'music',
    };
    const music = (
      await send(cb.api, 'asset.import', 'assetSlot', 'music', {
        id: 'music',
        slot: soundSlot,
        mediaKind: 'audio',
        bytes: [...tone({ seconds: 0.5 })],
        actor: 'fixture-author',
      })
    ).value.candidate;
    await adopt(cb.api, 'music', music.id);
    const editionC = await freeze(cb.api, 'edition-c', 'third', 'c-scene', [
      {
        id: 'track',
        kind: 'music',
        slotId: 'music',
        startMs: 0,
        gainDb: -6,
        fadeInMs: 50,
        fadeOutMs: 50,
      },
    ]);
    const outC = await rendered(cb.api, b.service, editionC, 'cycle3');
    await recordCycle(
      cb.api,
      'cycle-c',
      [bPose.ref, bOutput.ref],
      [
        local('candidate', importedC.result.candidate),
        local('edition', editionC),
      ],
      (await cb.api.snapshot()).adoptions
        .filter((x) => x.slotId === 'c-pose' || x.slotId === 'music')
        .map((x) => local('adoption', x)),
      [local('editionOutput', outC.output)],
      [{ ownerId: bOwner, ...local('cycle', cycleB) }],
    );
    const audioEdition = (
      await send(cb.api, 'edition.create', 'edition', 'audio-c', {
        id: 'audio-c',
        productionId: 'third',
        profile: 'audio',
      })
    ).value;
    const wavOut = (
      await send(cb.api, 'edition.render', 'editionOutput', 'audio-c', {
        editionId: audioEdition.id,
        renderId: 'audio-c',
      })
    ).value;
    assert.equal(wavOut.status, 'completed');
    await writeFile(
      '/tmp/task8-cycle3.wav',
      await b.service.readBlob('p1', wavOut.manifest.output.blobId),
    );
    assert.equal(
      (
        await run(
          'ffmpeg',
          ['-v', 'error', '-i', '/tmp/task8-cycle3.wav', '-f', 'null', '-'],
          { timeoutMs: 30000 },
        )
      ).stderr,
      '',
    );
    assert.deepEqual(await inventory(world.root), canonBefore);
    assert.equal((await ca.api.snapshot()).jobs.length, 0);
    assert.equal((await cb.api.snapshot()).jobs.length, 0);
    assert.equal(calls, 0);
    assert.deepEqual(
      (await ca.api.snapshot()).editions.find((x) => x.id === editionA.id),
      editionA,
    );
    assert.deepEqual(
      (await cb.api.snapshot()).editions.find((x) => x.id === editionB.id),
      editionB,
    );
    const oldAgain = await exportRef(ca.api, aOldRef);
    assert.deepEqual(oldAgain.bundle.records, poseBundle.bundle.records);
    // Original sources disappear. Destination closure, not the Library projection, owns bytes.
    await ca.server.close();
    await a.service.close();
    const moved = `${a.directory}-offline`;
    await rename(a.directory, moved);
    t.after(() => rm(moved, { recursive: true, force: true }));
    await refresh(cb.api, aOwner);
    assert.equal(
      (await cb.api.libraryQuery({ type: 'inspect', ref: aOldRef })).status,
      'offline',
    );
    await cb.server.close();
    await library.close();
    await rm(join(libraryDirectory, 'library-projection.sqlite'));
    library = await openLibrary({ directory: libraryDirectory, adapters });
    assert.equal(
      (await library.query({ type: 'inspect', ref: bPose.ref })).status,
      'unverified',
    );
    const current = await library.query({ type: 'find' });
    await library.command({
      commandId: 'rebuild',
      expectedRegistryRevision: current.registryRevision,
      type: 'owner.refresh',
      payload: { ownerId: bOwner },
    });
    assert.ok((await library.query({ type: 'inspect', ref: bPose.ref })).entry);
    await b.service.collectGarbage('p1', { graceMs: 0 });
    const backup = (await b.command('project.backup', {})).value.archive;
    const restored = await restoreStudioBackup({
      archive: join(b.directory, backup),
      directory: join(b.directory, 'restore'),
    });
    t.after(() => restored.close());
    assert.deepEqual(
      (await restored.snapshot('p1')).editions.find(
        (x) => x.id === editionC.id,
      ),
      editionC,
    );
    for (const id of editionC.closure.blobIds)
      assert.ok((await restored.readBlob('p1', id)).length);
    const restoredClient = await client(t, restored, null),
      again = await rendered(
        restoredClient.api,
        restored,
        editionC,
        'restored',
      );
    assert.equal(again.output.manifest.durationSeconds, 0.5);
    const evidence = {
      fixture: true,
      projectStores: 2,
      cycles: 3,
      sourceCanonUnchanged: true,
      providerInvocations: calls,
      importJobs: 0,
      artisticQuality: 'unobserved',
      rights: 'unknown',
      providerCharges: 'not invoked',
      localElapsedMs: performance.now() - started,
      renders: [outA, outB, outC, again].map(
        ({ path, localElapsedMs, output }) => ({
          path,
          localElapsedMs,
          manifest: output.manifest,
        }),
      ),
      sourceCanonDigest: canonicalDigest(canonBefore),
    };
    await writeFile(
      '/tmp/task8-three-cycle-evidence.json',
      JSON.stringify(evidence, null, 2),
    );
  },
);
