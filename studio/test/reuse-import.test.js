import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import {
  withStudio,
  withAudioScene,
  audioTakeSlot,
} from './helpers/project.js';
import { environmentSlot, wav } from './helpers/images.js';
import { bundleFixture, ref, pngBytes, pngSha256 } from './helpers/bundles.js';
import { sealBundle } from '../src/reuse/bundle.js';
import { canonicalDigest } from '../src/engine/contracts.js';
import { slotPins, slotDeclaration } from '../src/engine/asset-slots.js';
const hash = (b) => createHash('sha256').update(b).digest('hex');
function fixture(
  metadata = {},
  buffer = Buffer.from(pngBytes),
  mime = 'image/png'
) {
  const sha256 = hash(buffer),
    source = ref();
  return {
    ...bundleFixture({
      records: [
        {
          ref: source,
          metadata: {
            mediaKind: 'image',
            roles: ['environment-reference'],
            subjects: [],
            ...metadata,
          },
          requiredFileSha256s: [sha256],
          sourcePins: {},
          evidenceRefs: [],
        },
      ],
      files: [
        { sha256, byteLength: buffer.length, mime, role: 'selected-content' },
      ],
    }),
    bytes: { [sha256]: [...buffer] },
  };
}
function intent(slot = environmentSlot(), overrides = {}) {
  return {
    target: { kind: 'assetSlot', id: slot.id },
    mode: 'reuse-preserved',
    purpose: 'environment-reference',
    identityMap: [],
    stateMap: [],
    selections: [{ source: ref(), slot, role: 'environment-reference' }],
    ...overrides,
  };
}
async function inspect(f, data, use = intent()) {
  return f.service.inspectReuse({
    projectId: f.projectId,
    ...data,
    intent: use,
  });
}
async function imported(f, data, use = intent(), overrides = {}) {
  const inspection = await inspect(f, data, use);
  return f.command(
    'asset.importBundle',
    {
      ...data,
      inspectionDigest: inspection.inspectionDigest,
      intent: use,
      actor: 'artist',
      reason: 'preserve exact reference',
    },
    { aggregate: use.target, ...overrides }
  );
}
test('image preservation predicts actual canonical bytes, keeps provenance, and creates no jobs or adoption', async (t) => {
  const f = await withStudio(t),
    data = fixture();
  const before = await f.service.snapshot(f.projectId),
    inspection = await inspect(f, data);
  assert.equal(inspection.disposition, 'compatible');
  assert.equal(
    (await f.service.snapshot(f.projectId)).eventCursor,
    before.eventCursor
  );
  const result = await imported(f, data),
    receipt = result.value.importReceipt,
    c = result.value.candidate;
  assert.equal(receipt.localCandidates[0].candidateId, c.id);
  assert.notEqual(c.id, ref().recordId);
  assert.deepEqual(c.lineage.parentCandidateIds, []);
  assert.equal(c.rawBlobId, pngSha256);
  assert.equal(
    c.canonicalBlobId,
    inspection.materializations[0].canonicalSha256
  );
  assert.deepEqual(
    [...(await f.service.readBlob(f.projectId, c.rawBlobId))],
    pngBytes
  );
  assert.deepEqual(
    JSON.parse(
      Buffer.from(
        await f.service.readBlob(f.projectId, receipt.localManifestBlobId)
      ).toString()
    ),
    data.bundle
  );
  const s = await f.service.snapshot(f.projectId);
  assert.equal(s.reuseImports.length, 1);
  assert.equal(s.jobs.length, 0);
  assert.equal(s.adoptions.length, 0);
  assert.equal(s.slots[0].candidateId, null);
});
test('command replay and semantic reuse have separate identities; explicit new-import creates another candidate', async (t) => {
  const f = await withStudio(t),
    data = fixture(),
    use = intent(),
    inspection = await inspect(f, data, use);
  const envelope = {
    projectId: f.projectId,
    commandId: 'preserve',
    aggregate: use.target,
    expectedRevision: 0,
    type: 'asset.importBundle',
    payload: {
      ...data,
      intent: use,
      inspectionDigest: inspection.inspectionDigest,
      actor: 'artist',
      reason: 'first',
    },
  };
  const first = await f.service.command(envelope),
    replay = await f.service.command(envelope);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value, first.value);
  await assert.rejects(
    f.service.command({
      ...envelope,
      payload: { ...envelope.payload, reason: 'changed' },
    }),
    { code: 'COMMAND_CONFLICT' }
  );
  const second = await imported(f, data, use);
  assert.equal(second.value.candidate.id, first.value.candidate.id);
  assert.notEqual(second.value.importReceipt.id, first.value.importReceipt.id);
  const third = await imported(
    f,
    data,
    intent(environmentSlot(), { mode: 'new-import' })
  );
  assert.notEqual(third.value.candidate.id, first.value.candidate.id);
  assert.equal((await f.service.snapshot(f.projectId)).candidates.length, 2);
});
test('reject and corrupt existing candidates are never silently reused', async (t) => {
  for (const condition of ['reject', 'corrupt']) {
    const f = await withStudio(t),
      data = fixture(),
      first = await imported(f, data),
      id = first.value.candidate.id;
    if (condition === 'reject')
      await f.command(
        'candidate.review',
        {
          candidateId: id,
          decision: 'reject',
          actor: 'artist',
          reason: 'unsuitable',
        },
        { aggregate: { kind: 'assetReview', id } }
      );
    else {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        f.service.blobs.path(
          f.projectId,
          first.value.candidate.canonicalBlobId
        ),
        'corrupt'
      );
    }
    await assert.rejects(imported(f, data));
    assert.equal(
      (await f.service.snapshot(f.projectId)).reuseImports.length,
      1
    );
  }
});
test('distinct owners with identical bytes retain separate provenance', async (t) => {
  const f = await withStudio(t),
    a = fixture(),
    b = fixture();
  const changed = ref({ ownerId: 'second-owner' });
  b.bundle = sealBundle({
    ...b.bundle,
    roots: [changed],
    records: b.bundle.records.map((r) => ({ ...r, ref: changed })),
  });
  const one = await imported(f, a),
    use = intent();
  use.selections[0].source = changed;
  const two = await imported(f, b, use);
  assert.notEqual(one.value.candidate.id, two.value.candidate.id);
  assert.notDeepEqual(
    one.value.importReceipt.originRefs,
    two.value.importReceipt.originRefs
  );
  assert.deepEqual(two.value.candidate.lineage.parentCandidateIds, []);
});
test('JPEG normalization records technical derivation and WAV keeps the pinned decoder exact bytes', async (t) => {
  const f = await withStudio(t),
    jpeg = await sharp(Buffer.from(pngBytes)).jpeg().toBuffer(),
    a = fixture({}, jpeg, 'image/jpeg');
  const c = (await imported(f, a)).value;
  assert.equal(c.importReceipt.fileMap[0].normalizationChanged, true);
  assert.equal(c.candidate.lineage.normalization.relation, 'normalized-from');
  const audio = fixture(
      { mediaKind: 'audio', roles: ['audio-reference'] },
      wav(),
      'audio/wav'
    ),
    use = intent(environmentSlot('audio'), { purpose: 'audio-reference' });
  use.selections[0].role = 'audio-reference';
  const audioResult = (await imported(f, audio, use)).value;
  assert.equal(
    audioResult.importReceipt.fileMap[0].normalizationChanged,
    false
  );
  assert.deepEqual(
    [
      ...(await f.service.readBlob(
        f.projectId,
        audioResult.candidate.rawBlobId
      )),
    ],
    [...wav()]
  );
});
test('mapping is explicit, rejects style-only identity evidence, and cannot manufacture destination subjects', async (t) => {
  const f = await withStudio(t),
    subject = {
      ownerId: ref().ownerId,
      projectId: ref().projectId,
      identityId: 'hero',
      stateRefs: [],
    },
    data = fixture({ subjects: [subject] });
  const missing = await inspect(f, data);
  assert.equal(missing.disposition, 'needs_decision');
  assert.ok(missing.findings.some((x) => x.code === 'REUSE_MAPPING_REQUIRED'));
  await assert.rejects(imported(f, data), { code: 'REUSE_MAPPING_REQUIRED' });
  const use = intent(
    { ...environmentSlot(), subject: { kind: 'identity', id: 'ghost' } },
    { identityMap: [{ source: subject, destinationIdentityId: 'ghost' }] }
  );
  assert.notEqual((await inspect(f, data, use)).disposition, 'compatible');
});
test('invalid target, roles, extra selections and unsupported video never import', async (t) => {
  const f = await withStudio(t),
    data = fixture();
  const bad = [
    intent(undefined, { target: { kind: 'project', id: 'p1' } }),
    intent(undefined, { purpose: '' }),
  ];
  const role = intent();
  role.selections[0].role = 'identity-reference';
  bad.push(role);
  const extra = intent();
  extra.selections.push(extra.selections[0]);
  bad.push(extra);
  for (const use of bad) {
    assert.notEqual((await inspect(f, data, use)).disposition, 'compatible');
    await assert.rejects(imported(f, data, use));
  }
  for (const mediaKind of ['video', 'structured']) {
    const d = fixture({ mediaKind });
    assert.equal((await inspect(f, d)).disposition, 'unsupported');
    await assert.rejects(imported(f, d), { code: 'REUSE_MEDIA_UNSUPPORTED' });
  }
  assert.equal((await f.service.snapshot(f.projectId)).candidates.length, 0);
});
test('speech-take requires exact text, language, voice and performance evidence', async (t) => {
  const f = await withAudioScene(t),
    slot = audioTakeSlot('take', 'u1'),
    pins = slotPins(
      f.service.store,
      f.projectId,
      slotDeclaration(slot, 'audio')
    );
  const state = ref({ recordKind: 'state', recordId: 'childvoice' }),
    subject = {
      ownerId: ref().ownerId,
      projectId: ref().projectId,
      identityId: 'hero',
      stateRefs: [state],
    };
  const use = intent(slot, {
    purpose: 'speech-take',
    identityMap: [{ source: subject, destinationIdentityId: 'char' }],
    stateMap: [{ source: state, destinationStateId: 'childvoice' }],
  });
  use.selections[0].role = 'speech-take';
  const data = fixture(
    {
      mediaKind: 'audio',
      roles: ['speech-take'],
      subjects: [subject],
      audioBinding: { ...pins.audioBinding, characterId: 'hero' },
      speechPerformance: { text: '같은 대사', acting: { tone: 'quiet' } },
    },
    wav(),
    'audio/wav'
  );
  assert.equal((await inspect(f, data, use)).disposition, 'compatible');
  await imported(f, data, use);
  for (const field of ['textDigest', 'language', 'casting']) {
    const b = fixture(
      {
        mediaKind: 'audio',
        roles: ['speech-take'],
        subjects: [subject],
        audioBinding: {
          ...pins.audioBinding,
          characterId: 'hero',
          [field]: 'different',
        },
        speechPerformance: { text: '같은 대사', acting: { tone: 'quiet' } },
      },
      wav(),
      'audio/wav'
    );
    assert.equal((await inspect(f, b, use)).disposition, 'needs_derivation');
    await assert.rejects(imported(f, b, use));
  }
});
test('tampered inspection, partial bytes and stale CAS accept no candidate or receipt', async (t) => {
  const f = await withStudio(t),
    data = fixture(),
    use = intent(),
    inspection = await inspect(f, data);
  await assert.rejects(
    f.command(
      'asset.importBundle',
      {
        ...data,
        intent: use,
        inspectionDigest: 'f'.repeat(64),
        actor: 'a',
        reason: 'r',
      },
      { aggregate: use.target }
    ),
    { code: 'INPUT_STALE' }
  );
  await assert.rejects(
    f.command(
      'asset.importBundle',
      {
        ...data,
        bytes: {},
        intent: use,
        inspectionDigest: inspection.inspectionDigest,
        actor: 'a',
        reason: 'r',
      },
      { aggregate: use.target }
    ),
    { code: 'BUNDLE_INCOMPLETE' }
  );
  await assert.rejects(imported(f, data, use, { expectedRevision: 9 }), {
    code: 'REVISION_CONFLICT',
  });
  assert.equal((await f.service.snapshot(f.projectId)).reuseImports.length, 0);
});
test('semantic pin changes during staged bytes fail atomically', async (t) => {
  const f = await withAudioScene(t),
    data = fixture(),
    use = intent(environmentSlot('scoped', { kind: 'scene', id: 'scene' }));
  const put = f.service.blobs.put.bind(f.service.blobs);
  let entered,
    release,
    first = true;
  const start = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  f.service.blobs.put = async (...args) => {
    const x = await put(...args);
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return x;
  };
  const work = imported(f, data, use);
  await start;
  await f.command(
    'utterance.update',
    { id: 'u1', text: 'concurrently changed meaning' },
    { aggregate: { kind: 'utterance', id: 'u1' } }
  );
  release();
  await assert.rejects(work, { code: 'INPUT_STALE' });
  assert.equal((await f.service.snapshot(f.projectId)).reuseImports.length, 0);
  assert.equal((await f.service.snapshot(f.projectId)).candidates.length, 0);
});
test('exact text source provenance survives independent image failure and source retry replays', async (t) => {
  const f = await withStudio(t),
    text = Buffer.from('원문 그대로\r\n'),
    data = fixture({ mediaKind: 'text' }, text, 'text/plain');
  const payload = {
    ...data,
    sourcePackageId: 'source',
    productionId: null,
    title: '원문',
    language: 'ko',
    actor: 'a',
    reason: 'retain',
  };
  const e = {
    projectId: f.projectId,
    commandId: 'source-once',
    aggregate: { kind: 'sourcePackage', id: 'source' },
    expectedRevision: 0,
    type: 'source.importBundle',
    payload,
  };
  const source = await f.service.command(e);
  assert.deepEqual(source.value.originRefs, [ref()]);
  assert.equal(source.value.textUnits[0].text, text.toString());
  assert.deepEqual(
    [
      ...(await f.service.readBlob(
        f.projectId,
        source.value.textUnits[0].blobId
      )),
    ],
    [...text]
  );
  await assert.rejects(imported(f, { ...fixture(), bytes: {} }));
  assert.equal((await f.service.command(e)).replayed, true);
  assert.equal(
    (await f.service.snapshot(f.projectId)).sourcePackages.length,
    1
  );
});

test('multi-character final-scene maps each actual character and presentation in the selected shot', async (t) => {
  const f = await withAudioScene(t);
  await f.command(
    'cast.put',
    {
      id: 'actor2',
      name: 'Second',
      language: 'ko',
      characterId: 'char2',
      identity: { id: 'char2', origin: { kind: 'studioLocal' } },
    },
    { aggregate: { kind: 'cast', id: 'actor2' } }
  );
  const scene = (await f.service.snapshot(f.projectId)).scenes[0];
  scene.occurrences.push({
    id: 'second',
    roleBindingId: 'actor2',
    characterId: 'char2',
    presence: 'onscreen',
  });
  scene.presentations.push({
    occurrenceId: 'second',
    appearanceStateRef: null,
    castingStateRef: null,
    knowledgeStateRef: null,
  });
  scene.shots[0].occurrenceIds = ['speaker', 'second'];
  await f.command('scene.put', scene, {
    aggregate: { kind: 'scene', id: scene.id },
  });
  const subject = (identityId) => ({
    ownerId: ref().ownerId,
    projectId: ref().projectId,
    identityId,
    stateRefs: [],
  });
  const subjects = [subject('external-one'), subject('external-two')],
    slot = environmentSlot('scene-picture', { kind: 'shot', id: 'shot' }),
    use = intent(slot, {
      purpose: 'complete scene illustration',
      identityMap: subjects.map((source, i) => ({
        source,
        destinationIdentityId: i ? 'char2' : 'char',
      })),
    });
  use.selections[0].role = 'final-scene';
  const data = fixture({ roles: ['final-scene'], subjects });
  assert.equal((await inspect(f, data, use)).disposition, 'compatible');
  await imported(f, data, use);
  const wrong = structuredClone(use);
  wrong.identityMap[1].destinationIdentityId = 'not-present';
  assert.equal((await inspect(f, data, wrong)).disposition, 'needs_decision');
  const excluded = structuredClone(scene);
  excluded.shots[0].occurrenceIds = ['speaker'];
  await f.command('scene.put', excluded, {
    aggregate: { kind: 'scene', id: scene.id },
  });
  assert.equal((await inspect(f, data, use)).disposition, 'needs_decision');
});
test('style and unbound audio reference preserve foreign subject history without asserting identity or speech approval', async (t) => {
  const f = await withStudio(t),
    subject = {
      ownerId: ref().ownerId,
      projectId: ref().projectId,
      identityId: 'foreign',
      stateRefs: [ref({ recordKind: 'state', recordId: 'old-look' })],
    };
  for (const [role, mediaKind, bytes, mime] of [
    ['style-reference', 'image', Buffer.from(pngBytes), 'image/png'],
    ['audio-reference', 'audio', wav(), 'audio/wav'],
  ]) {
    const data = fixture(
        { roles: [role], mediaKind, subjects: [subject] },
        bytes,
        mime
      ),
      use = intent(environmentSlot(role), { purpose: 'study expression' });
    use.selections[0].role = role;
    assert.equal((await inspect(f, data, use)).disposition, 'compatible');
    const r = await imported(f, data, use);
    assert.equal(r.value.candidate.lineage.kind, 'import');
    assert.equal(r.value.candidate.reuseRole, role);
    assert.equal(r.value.candidate.audioBinding, undefined);
    const bad = structuredClone(use);
    bad.selections[0].role =
      mediaKind === 'image' ? 'final-scene' : 'speech-take';
    assert.notEqual((await inspect(f, data, bad)).disposition, 'compatible');
  }
  assert.equal((await f.service.snapshot(f.projectId)).adoptions.length, 0);
});
test('cross-project speech uses portable performance and voice meaning, keeping foreign linkage IDs as evidence', async (t) => {
  const f = await withAudioScene(t),
    slot = audioTakeSlot('foreign-take', 'u1'),
    pins = slotPins(
      f.service.store,
      f.projectId,
      slotDeclaration(slot, 'audio')
    );
  const state = ref({ recordKind: 'state', recordId: 'foreign-voice' }),
    subject = {
      ownerId: ref().ownerId,
      projectId: ref().projectId,
      identityId: 'foreign-identity',
      stateRefs: [state],
    },
    use = intent(slot, {
      identityMap: [{ source: subject, destinationIdentityId: 'char' }],
      stateMap: [{ source: state, destinationStateId: 'childvoice' }],
    });
  use.selections[0].role = 'speech-take';
  const binding = {
    ...pins.audioBinding,
    characterId: 'foreign-identity',
    roleBindingId: 'foreign-role',
    speakerOccurrenceId: 'foreign-speaker',
    castingStateRef: 'foreign-voice',
    performanceDigest: 'foreign-local-id-sensitive-digest',
    casting: {
      ...pins.audioBinding.casting,
      decisionId: 'foreign-decision',
      revision: 87,
    },
  };
  const data = fixture(
    {
      mediaKind: 'audio',
      roles: ['speech-take'],
      subjects: [subject],
      audioBinding: binding,
      speechPerformance: { text: '같은 대사', acting: { tone: 'quiet' } },
    },
    wav(),
    'audio/wav'
  );
  assert.equal((await inspect(f, data, use)).disposition, 'compatible');
  const c = (await imported(f, data, use)).value.candidate;
  assert.deepEqual(c.audioBinding, pins.audioBinding);
  const bad = structuredClone(data);
  bad.bundle.records[0].metadata.speechPerformance.acting.tone = 'loud';
  bad.bundle = sealBundle(bad.bundle);
  assert.equal((await inspect(f, bad, use)).disposition, 'needs_derivation');
});
test('source intended production is rechecked at final transaction without binding or rebasing', async (t) => {
  const f = await withStudio(t);
  await f.command('production.create', {
    id: 'prod',
    title: 'Production',
    sourcePackageId: null,
  });
  const text = Buffer.from('manuscript'),
    data = fixture({ mediaKind: 'text' }, text, 'text/plain'),
    payload = {
      ...data,
      sourcePackageId: 'source',
      productionId: 'prod',
      title: 'Script',
      language: 'ko',
      actor: 'a',
      reason: 'retain',
    };
  const put = f.service.blobs.put.bind(f.service.blobs);
  let entered,
    release,
    first = true;
  const start = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  f.service.blobs.put = async (...args) => {
    const x = await put(...args);
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return x;
  };
  const work = f.command('source.importBundle', payload, {
    aggregate: { kind: 'sourcePackage', id: 'source' },
  });
  await start;
  f.service.store.write(() => {
    f.service.store.run(
      "DELETE FROM productions WHERE project_id=? AND id='prod'",
      f.projectId
    );
    f.service.store.run(
      "DELETE FROM aggregates WHERE project_id=? AND kind='production' AND id='prod'",
      f.projectId
    );
  });
  release();
  await assert.rejects(work, { code: 'INVALID_REFERENCE' });
  assert.equal(
    (await f.service.snapshot(f.projectId)).sourcePackages.length,
    0
  );
  await f.command('production.create', {
    id: 'prod',
    title: 'Production',
    sourcePackageId: null,
  });
  await f.command('source.importBundle', payload, {
    aggregate: { kind: 'sourcePackage', id: 'source' },
  });
  assert.equal(
    (await f.service.snapshot(f.projectId)).productions[0].sourcePackageId,
    null
  );
});
test('required historical raw and runtime dependencies survive GC and schema2 backup/restore with Edition provenance', async (t) => {
  const { audioFixture } = await import('./helpers/render-fixture.js');
  const { join } = await import('node:path');
  const { rm, readFile, writeFile } = await import('node:fs/promises');
  const { restoreStudioBackup } = await import('../src/engine/backup.js');
  const f = await audioFixture(t),
    original = await withStudio(t),
    raw = Buffer.from('historical raw source'),
    rawHash = hash(raw),
    data = fixture();
  await original.service.blobs.put(original.projectId, raw);
  data.bundle.records[0].requiredFileSha256s.push(rawHash);
  data.bundle.files.push({
    sha256: rawHash,
    byteLength: raw.length,
    mime: 'application/octet-stream',
    role: 'source-raw',
  });
  data.bytes[rawHash] = [...raw];
  data.bundle = sealBundle(data.bundle);
  const use = intent(environmentSlot('picture', { kind: 'shot', id: 'shot' }));
  const result = await imported(f, data, use);
  const c = result.value.candidate;
  await f.command(
    'candidate.adopt',
    {
      slotId: 'picture',
      candidateId: c.id,
      actor: 'a',
      reason: 'fixture image',
    },
    { aggregate: use.target }
  );
  const scene = (await f.service.snapshot(f.projectId)).scenes[0];
  for (const shot of scene.shots) shot.referenceSlotId = 'picture';
  // The second shot needs a scope-compatible slot; use a scene scope for this closure.
  const sceneUse = intent(
    environmentSlot('scene-picture', { kind: 'scene', id: 'scene' })
  );
  const sceneResult = await imported(f, data, sceneUse);
  await f.command(
    'candidate.adopt',
    {
      slotId: 'scene-picture',
      candidateId: sceneResult.value.candidate.id,
      actor: 'a',
      reason: 'fixture image',
    },
    { aggregate: sceneUse.target }
  );
  for (const shot of scene.shots) shot.referenceSlotId = 'scene-picture';
  await f.command('scene.put', scene, {
    aggregate: { kind: 'scene', id: 'scene' },
  });
  const edition = (
    await f.command(
      'edition.create',
      { id: 'preserved-edition', productionId: 'main', profile: 'landscape' },
      { aggregate: { kind: 'edition', id: 'preserved-edition' } }
    )
  ).value;
  assert.ok(edition.closure.blobIds.includes(rawHash));
  assert.ok(
    edition.closure.blobIds.includes(
      sceneResult.value.importReceipt.localManifestBlobId
    )
  );
  await original.service.close();
  await rm(original.directory, { recursive: true, force: true });
  data.bytes = {}; // Original storage is deleted; destination bytes remain.
  await f.service.collectGarbage(f.projectId, { graceMs: 0 });
  assert.deepEqual(
    Buffer.from(await f.service.readBlob(f.projectId, rawHash)),
    raw
  );
  const backup = (await f.command('project.backup', {})).value,
    archive = join(f.directory, backup.archive);
  const manifest = JSON.parse(
    await readFile(join(archive, 'manifest.json'), 'utf8')
  );
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.tables.reuse_imports.length, 2);
  const restored = await restoreStudioBackup({
    archive,
    directory: join(f.directory, 'restored-reuse'),
  });
  t.after(() => restored.close());
  const after = await restored.snapshot(f.projectId);
  assert.deepEqual(
    after.reuseImports,
    (await f.service.snapshot(f.projectId)).reuseImports
  );
  assert.deepEqual(after.editions[0], edition);
  assert.deepEqual(
    Buffer.from(await restored.readBlob(f.projectId, rawHash)),
    raw
  );
  const bad = structuredClone(manifest);
  bad.tables.reuse_imports[0].data_json = JSON.stringify({
    ...JSON.parse(bad.tables.reuse_imports[0].data_json),
    localCandidates: [
      { candidateId: 'absent', slotId: 'picture', source: ref() },
    ],
  });
  const { digest, ...body } = bad;
  bad.digest = canonicalDigest(body);
  await writeFile(join(archive, 'manifest.json'), JSON.stringify(bad));
  await assert.rejects(
    restoreStudioBackup({
      archive,
      directory: join(f.directory, 'invalid-receipt'),
    }),
    { code: 'BACKUP_INVALID' }
  );
});
test('actual image/audio candidates from another project preserve exact consumed bytes after original storage deletion', async (t) => {
  const { assetImport } = await import('./helpers/images.js'),
    { rm } = await import('node:fs/promises');
  const source = await withStudio(t),
    destination = await withStudio(t);
  for (const [mediaKind, buffer, mime, role] of [
    ['image', Buffer.from(pngBytes), 'image/png', 'environment-reference'],
    ['audio', wav(), 'audio/wav', 'audio-reference'],
  ]) {
    const original = (
      await assetImport(
        source,
        `original-${mediaKind}`,
        buffer,
        environmentSlot(`original-${mediaKind}`),
        mediaKind
      )
    ).value.candidate;
    const selected = Buffer.from(
        await source.service.readBlob(
          source.projectId,
          original.canonicalBlobId
        )
      ),
      origin = ref({
        projectId: source.projectId,
        recordId: original.id,
        revision: canonicalDigest(original),
      }),
      sha256 = hash(selected);
    const data = {
        bundle: sealBundle({
          schemaVersion: 1,
          roots: [origin],
          records: [
            {
              ref: origin,
              metadata: { mediaKind, roles: [role], subjects: [] },
              requiredFileSha256s: [sha256],
              sourcePins: original,
              evidenceRefs: [],
            },
          ],
          files: [
            {
              sha256,
              byteLength: selected.length,
              mime,
              role: 'selected-content',
            },
          ],
          links: [],
          disclosure: { includedScope: 'exact candidate', omittedEvidence: [] },
          capturedAt: '2026-10-21T00:00:00Z',
        }),
        bytes: { [sha256]: [...selected] },
      },
      use = intent(environmentSlot(`destination-${mediaKind}`));
    use.selections[0].role = role;
    use.selections[0].source = origin;
    const importedResult = await imported(destination, data, use);
    assert.equal(
      importedResult.value.candidate.rawBlobId,
      original.canonicalBlobId
    );
    assert.deepEqual(
      Buffer.from(
        await destination.service.readBlob(
          destination.projectId,
          importedResult.value.candidate.rawBlobId
        )
      ),
      selected
    );
  }
  await source.service.close();
  await rm(source.directory, { recursive: true, force: true });
  await destination.service.collectGarbage(destination.projectId, {
    graceMs: 0,
  });
  for (const receipt of (
    await destination.service.snapshot(destination.projectId)
  ).reuseImports)
    for (const file of receipt.fileMap)
      assert.ok(
        (
          await destination.service.readBlob(
            destination.projectId,
            file.rawBlobId
          )
        ).length
      );
});
test('only selected-root runtime closure is materialized, with supplied historical raw preserved and external IDs inert', async (t) => {
  const f = await withStudio(t),
    data = fixture(),
    dependency = ref({ recordId: 'runtime' }),
    unselected = ref({ recordId: 'unused' }),
    required = Buffer.from('required data'),
    unused = Buffer.from('unselected root data'),
    neededHash = hash(required),
    unusedHash = hash(unused);
  data.bundle.records.push(
    {
      ref: dependency,
      metadata: { blobId: 'f'.repeat(64) },
      requiredFileSha256s: [neededHash],
      sourcePins: { blobId: 'e'.repeat(64) },
      evidenceRefs: [],
    },
    {
      ref: unselected,
      metadata: { mediaKind: 'image' },
      requiredFileSha256s: [unusedHash],
      sourcePins: {},
      evidenceRefs: [],
    }
  );
  data.bundle.roots.push(unselected);
  data.bundle.links.push({
    from: ref(),
    relation: 'derived-from',
    to: dependency,
    requirement: 'runtime',
  });
  data.bundle.files.push(
    {
      sha256: neededHash,
      byteLength: required.length,
      mime: 'application/octet-stream',
      role: 'runtime-data',
    },
    {
      sha256: unusedHash,
      byteLength: unused.length,
      mime: 'application/octet-stream',
      role: 'selected-content',
    }
  );
  data.bytes[neededHash] = [...required];
  data.bytes[unusedHash] = [...unused];
  data.bundle = sealBundle(data.bundle);
  const receipt = (await imported(f, data)).value.importReceipt;
  assert.equal(receipt.fileMap.length, 2);
  assert.ok(receipt.originRefs.some((r) => r.recordId === 'runtime'));
  assert.equal(
    f.service.store.get(
      'SELECT id FROM blobs WHERE project_id=? AND id=?',
      f.projectId,
      unusedHash
    ),
    undefined
  );
  await f.service.collectGarbage(f.projectId, { graceMs: 0 });
  assert.deepEqual(
    Buffer.from(await f.service.readBlob(f.projectId, neededHash)),
    required
  );
});
test('slot CAS and latest review remain authoritative after asynchronous preservation', async (t) => {
  for (const action of ['adopt', 'reject']) {
    const f = await withStudio(t),
      data = fixture(),
      first = await imported(f, data),
      use = intent(),
      c = first.value.candidate;
    const put = f.service.blobs.put.bind(f.service.blobs);
    let entered,
      release,
      block = true;
    const start = new Promise((r) => (entered = r)),
      gate = new Promise((r) => (release = r));
    f.service.blobs.put = async (...args) => {
      const x = await put(...args);
      if (block) {
        block = false;
        entered();
        await gate;
      }
      return x;
    };
    const work = imported(f, data, use);
    await start;
    if (action === 'adopt')
      await f.command(
        'candidate.adopt',
        {
          slotId: 'background',
          candidateId: c.id,
          actor: 'a',
          reason: 'concurrent choice',
        },
        { aggregate: use.target }
      );
    else
      await f.command(
        'candidate.review',
        {
          candidateId: c.id,
          decision: 'reject',
          actor: 'a',
          reason: 'concurrent review',
        },
        { aggregate: { kind: 'assetReview', id: c.id } }
      );
    release();
    await assert.rejects(work, {
      code:
        action === 'adopt' ? 'REVISION_CONFLICT' : 'REUSE_CANDIDATE_REJECTED',
    });
    const after = await f.service.snapshot(f.projectId);
    assert.equal(after.reuseImports.length, 1);
    assert.equal(after.candidates.length, 1);
  }
});
test('source bundle rejects ambiguous text roots, image-as-text, and client candidate IDs are forbidden', async (t) => {
  const f = await withStudio(t),
    text = Buffer.from('text'),
    data = fixture({ mediaKind: 'text' }, text, 'text/plain'),
    another = ref({ recordId: 'second-text' });
  data.bundle.roots.push(another);
  data.bundle.records.push({ ...data.bundle.records[0], ref: another });
  data.bundle = sealBundle(data.bundle);
  const source = (data) =>
    f.command(
      'source.importBundle',
      {
        ...data,
        sourcePackageId: 'source',
        productionId: null,
        title: 'T',
        language: 'ko',
        actor: 'a',
        reason: 'r',
      },
      { aggregate: { kind: 'sourcePackage', id: 'source' } }
    );
  await assert.rejects(source(data), { code: 'INVALID_INPUT' });
  await assert.rejects(source(fixture({ mediaKind: 'text' })), {
    code: 'REUSE_MEDIA_UNSUPPORTED',
  });
  const image = fixture(),
    use = intent(),
    inspection = await inspect(f, image);
  await assert.rejects(
    f.command(
      'asset.importBundle',
      {
        ...image,
        intent: use,
        inspectionDigest: inspection.inspectionDigest,
        candidateId: 'forged',
        actor: 'a',
        reason: 'r',
      },
      { aggregate: use.target }
    ),
    { code: 'INVALID_INPUT' }
  );
  assert.equal(
    (await f.service.snapshot(f.projectId)).sourcePackages.length,
    0
  );
});

test('project-level mapped character revisions are semantic pins independent of destination slot CAS', async (t) => {
  const f = await withAudioScene(t);
  const subject = {
    ownerId: ref().ownerId,
    projectId: ref().projectId,
    identityId: 'source-character',
    stateRefs: [],
  };
  const data = fixture({ roles: ['final-scene'], subjects: [subject] });
  const use = intent(environmentSlot('mapped-project'), {
    identityMap: [{ source: subject, destinationIdentityId: 'char' }],
  });
  use.selections[0].role = 'final-scene';
  const put = f.service.blobs.put.bind(f.service.blobs);
  let entered,
    release,
    first = true;
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  f.service.blobs.put = async (...args) => {
    const value = await put(...args);
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return value;
  };
  const work = imported(f, data, use);
  await started;
  const actor = (await f.service.snapshot(f.projectId)).cast.find(
    (c) => c.id === 'actor'
  );
  await f.command(
    'cast.put',
    { ...actor, name: 'Changed actual identity' },
    { aggregate: { kind: 'cast', id: 'actor' } }
  );
  release();
  await assert.rejects(work, { code: 'INPUT_STALE' });
  assert.equal((await f.service.snapshot(f.projectId)).reuseImports.length, 0);
});

test('unrecognized media labels remain unsupported, including inherited object property names', async (t) => {
  const f = await withStudio(t);
  for (const mediaKind of ['toString', 'constructor']) {
    const data = fixture({ mediaKind });
    assert.equal((await inspect(f, data)).disposition, 'unsupported');
    await assert.rejects(imported(f, data), {
      code: 'REUSE_MEDIA_UNSUPPORTED',
    });
  }
});

test('speech source speaker must map to the actual destination speaker, not another subject with matching voice', async (t) => {
  const f = await withAudioScene(t);
  await f.command(
    'cast.put',
    {
      id: 'other-actor',
      name: 'Other',
      language: 'ko',
      characterId: 'other-char',
      identity: { id: 'other-char', origin: { kind: 'studioLocal' } },
    },
    { aggregate: { kind: 'cast', id: 'other-actor' } }
  );
  const scene = (await f.service.snapshot(f.projectId)).scenes[0];
  scene.occurrences.push({
    id: 'other-occurrence',
    roleBindingId: 'other-actor',
    characterId: 'other-char',
    presence: 'offscreen',
  });
  scene.presentations.push({
    occurrenceId: 'other-occurrence',
    appearanceStateRef: null,
    castingStateRef: 'childvoice',
    knowledgeStateRef: null,
  });
  await f.command('scene.put', scene, {
    aggregate: { kind: 'scene', id: 'scene' },
  });
  const slot = audioTakeSlot('wrong-speaker', 'u1'),
    pins = slotPins(
      f.service.store,
      f.projectId,
      slotDeclaration(slot, 'audio')
    );
  const state = ref({ recordKind: 'state', recordId: 'childvoice' }),
    speaker = {
      ownerId: ref().ownerId,
      projectId: ref().projectId,
      identityId: 'source-speaker',
      stateRefs: [state],
    },
    extra = { ...speaker, identityId: 'source-extra', stateRefs: [] };
  const data = fixture(
    {
      mediaKind: 'audio',
      roles: ['speech-take'],
      subjects: [speaker, extra],
      audioBinding: { ...pins.audioBinding, characterId: 'source-speaker' },
      speechPerformance: { text: '같은 대사', acting: { tone: 'quiet' } },
    },
    wav(),
    'audio/wav'
  );
  const use = intent(slot, {
    identityMap: [
      { source: speaker, destinationIdentityId: 'other-char' },
      { source: extra, destinationIdentityId: 'char' },
    ],
    stateMap: [{ source: state, destinationStateId: 'childvoice' }],
  });
  use.selections[0].role = 'speech-take';
  assert.equal((await inspect(f, data, use)).disposition, 'needs_decision');
  await assert.rejects(imported(f, data, use), {
    code: 'REUSE_MAPPING_REQUIRED',
  });
});

test('characterless narration preserves exact foreign role evidence without manufacturing identity mappings', async (t) => {
  const f = await withAudioScene(t),
    slot = audioTakeSlot('narration-import', 'uN', 'narrator', null),
    pins = slotPins(
      f.service.store,
      f.projectId,
      slotDeclaration(slot, 'audio')
    );
  const binding = {
    ...pins.audioBinding,
    roleBindingId: 'foreign-narration-role',
    speakerOccurrenceId: 'foreign-narration',
    performanceDigest: 'foreign-native-performance',
    casting: {
      ...pins.audioBinding.casting,
      decisionId: 'foreign-narration-voice',
      revision: 123,
    },
  };
  const data = fixture(
      {
        mediaKind: 'audio',
        roles: ['speech-take'],
        subjects: [],
        audioBinding: binding,
        speechPerformance: { text: '해설' },
      },
      wav(),
      'audio/wav'
    ),
    use = intent(slot);
  use.selections[0].role = 'speech-take';
  assert.equal((await inspect(f, data, use)).disposition, 'compatible');
  const result = await imported(f, data, use);
  assert.equal(result.value.candidate.audioBinding.characterId, null);
  assert.equal(result.value.candidate.audioBinding.roleBindingId, 'narrator');
  const manifest = JSON.parse(
    Buffer.from(
      await f.service.readBlob(
        f.projectId,
        result.value.importReceipt.localManifestBlobId
      )
    ).toString()
  );
  assert.equal(
    manifest.records[0].metadata.audioBinding.roleBindingId,
    'foreign-narration-role'
  );
  const incomplete = structuredClone(data);
  delete incomplete.bundle.records[0].metadata.audioBinding.characterId;
  incomplete.bundle = sealBundle(incomplete.bundle);
  assert.equal(
    (await inspect(f, incomplete, use)).disposition,
    'needs_decision'
  );
});

test('another depicted subject cannot supply the actual speech speaker casting state evidence', async (t) => {
  const f = await withAudioScene(t);
  await f.command(
    'cast.put',
    {
      id: 'state-holder',
      name: 'State holder',
      language: 'ko',
      characterId: 'state-holder-character',
      identity: {
        id: 'state-holder-character',
        origin: { kind: 'studioLocal' },
      },
    },
    { aggregate: { kind: 'cast', id: 'state-holder' } }
  );
  const scene = (await f.service.snapshot(f.projectId)).scenes[0];
  scene.occurrences.push({
    id: 'state-holder-occurrence',
    roleBindingId: 'state-holder',
    characterId: 'state-holder-character',
    presence: 'offscreen',
  });
  scene.presentations.push({
    occurrenceId: 'state-holder-occurrence',
    appearanceStateRef: null,
    castingStateRef: 'childvoice',
    knowledgeStateRef: null,
  });
  await f.command('scene.put', scene, {
    aggregate: { kind: 'scene', id: 'scene' },
  });
  const slot = audioTakeSlot('state-evidence-take', 'u1');
  const pins = slotPins(
    f.service.store,
    f.projectId,
    slotDeclaration(slot, 'audio')
  );
  const state = ref({ recordKind: 'state', recordId: 'source-voice-state' });
  const speaker = {
    ownerId: ref().ownerId,
    projectId: ref().projectId,
    identityId: 'source-speaker',
    stateRefs: [state],
  };
  const other = {
    ...speaker,
    identityId: 'source-state-holder',
  };
  const data = fixture(
    {
      mediaKind: 'audio',
      roles: ['speech-take'],
      subjects: [speaker, other],
      audioBinding: {
        ...pins.audioBinding,
        characterId: 'source-speaker',
        castingStateRef: 'source-voice-state',
      },
      speechPerformance: { text: '같은 대사', acting: { tone: 'quiet' } },
    },
    wav(),
    'audio/wav'
  );
  const use = intent(slot, {
    identityMap: [
      { source: speaker, destinationIdentityId: 'char' },
      { source: other, destinationIdentityId: 'state-holder-character' },
    ],
    stateMap: [{ source: state, destinationStateId: 'childvoice' }],
  });
  use.selections[0].role = 'speech-take';
  assert.equal((await inspect(f, data, use)).disposition, 'compatible');

  // Both real presentations and mappings remain valid. Only the actual source
  // speaker's state evidence disappears; the other depicted subject keeps it.
  const missingSpeakerState = structuredClone(data);
  const missingSpeaker =
    missingSpeakerState.bundle.records[0].metadata.subjects[0];
  missingSpeaker.stateRefs = [];
  missingSpeakerState.bundle.records[0].metadata.speakerStateRefs = [state];
  missingSpeakerState.bundle = sealBundle(missingSpeakerState.bundle);
  const missingUse = structuredClone(use);
  missingUse.identityMap[0].source = missingSpeaker;
  const inspection = await inspect(f, missingSpeakerState, missingUse);
  assert.equal(inspection.disposition, 'needs_decision');
  assert.ok(
    inspection.findings.some(
      (finding) => finding.code === 'REUSE_MAPPING_REQUIRED'
    )
  );
  await assert.rejects(imported(f, missingSpeakerState, missingUse), {
    code: 'REUSE_MAPPING_REQUIRED',
  });
  const snapshot = await f.service.snapshot(f.projectId);
  assert.equal(snapshot.reuseImports.length, 0);
  assert.equal(snapshot.candidates.length, 0);
});

test('stateful characterless narration uses only its explicit native role state evidence', async (t) => {
  const f = await withAudioScene(t);
  const scene = (await f.service.snapshot(f.projectId)).scenes[0];
  scene.presentations.find(
    (p) => p.occurrenceId === 'narration'
  ).castingStateRef = 'childvoice';
  await f.command('scene.put', scene, {
    aggregate: { kind: 'scene', id: 'scene' },
  });
  await f.command(
    'casting.set',
    {
      id: 'narrator-childvoice',
      scope: 'project',
      roleId: 'narrator',
      state: 'childvoice',
      voice: 'shared-voice',
    },
    { aggregate: { kind: 'casting', id: 'narrator-childvoice' } }
  );
  const slot = audioTakeSlot(
    'stateful-narration',
    'uN',
    'narrator',
    'childvoice'
  );
  const pins = slotPins(
    f.service.store,
    f.projectId,
    slotDeclaration(slot, 'audio')
  );
  const state = ref({ recordKind: 'state', recordId: 'source-narrator-voice' });
  const data = fixture(
    {
      mediaKind: 'audio',
      roles: ['speech-take'],
      subjects: [],
      audioBinding: {
        ...pins.audioBinding,
        roleBindingId: 'source-narrator',
        speakerOccurrenceId: 'source-narration',
        castingStateRef: state.recordId,
      },
      speakerStateRefs: [state],
      speechPerformance: { text: '해설' },
    },
    wav(),
    'audio/wav'
  );
  const use = intent(slot, {
    stateMap: [{ source: state, destinationStateId: 'childvoice' }],
  });
  use.selections[0].role = 'speech-take';
  assert.equal((await inspect(f, data, use)).disposition, 'compatible');
  const result = await imported(f, data, use);
  assert.equal(result.value.candidate.audioBinding.characterId, null);
  assert.equal(
    result.value.candidate.audioBinding.castingStateRef,
    'childvoice'
  );
  assert.equal(result.value.candidate.audioBinding.roleBindingId, 'narrator');

  // A depicted character can have the same mapped voice state; it still cannot
  // provide the characterless narrator's missing role-specific state evidence.
  const depicted = {
    ownerId: ref().ownerId,
    projectId: ref().projectId,
    identityId: 'source-depicted',
    stateRefs: [state],
  };
  const missingRoleState = structuredClone(data);
  delete missingRoleState.bundle.records[0].metadata.speakerStateRefs;
  missingRoleState.bundle.records[0].metadata.subjects = [depicted];
  missingRoleState.bundle = sealBundle(missingRoleState.bundle);
  const depictedUse = structuredClone(use);
  depictedUse.identityMap = [
    { source: depicted, destinationIdentityId: 'char' },
  ];
  assert.equal(
    (await inspect(f, missingRoleState, depictedUse)).disposition,
    'needs_decision'
  );
  await assert.rejects(imported(f, missingRoleState, depictedUse), {
    code: 'REUSE_MAPPING_REQUIRED',
  });

  const missingRole = structuredClone(data);
  delete missingRole.bundle.records[0].metadata.audioBinding.roleBindingId;
  missingRole.bundle = sealBundle(missingRole.bundle);
  assert.equal(
    (await inspect(f, missingRole, use)).disposition,
    'needs_decision'
  );
  const unrelatedRoleState = structuredClone(data);
  unrelatedRoleState.bundle.records[0].metadata.speakerStateRefs = [
    ref({ recordKind: 'state', recordId: 'unrelated-role-state' }),
  ];
  unrelatedRoleState.bundle = sealBundle(unrelatedRoleState.bundle);
  const unrelatedUse = structuredClone(use);
  unrelatedUse.stateMap[0].source =
    unrelatedRoleState.bundle.records[0].metadata.speakerStateRefs[0];
  assert.equal(
    (await inspect(f, unrelatedRoleState, unrelatedUse)).disposition,
    'needs_decision'
  );
});
