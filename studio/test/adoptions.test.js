import test from 'node:test';
import assert from 'node:assert/strict';
import { withGeneration } from './helpers/project.js';
import { png, basePixels, driftPixels, maskPixels, assetImport, environmentSlot } from './helpers/images.js';

const adopt = (f, slotId, candidateId) => f.command('candidate.adopt', { slotId, candidateId, actor: 'artist', reason: 'accept' }, {
  aggregate: { kind: 'assetSlot', id: slotId }
});

test('project common undo appends audit while retaining an accepted explicit shot pin', async t => {
  const f = await withGeneration(t);
  await assetImport(f, 'common', await png(basePixels));
  const common = await adopt(f, 'background', 'common');

  await assetImport(f, 'shotimage', await png(driftPixels), environmentSlot('shotbg', { kind: 'shot', id: 'shot' }));

  const shot = await adopt(f, 'shotbg', 'shotimage');

  await f.command('adoption.undo', { slotId: 'background', adoptionId: common.value.adoptionId, actor: 'artist', reason: 'revert common' }, {
    aggregate: { kind: 'assetSlot', id: 'background' }
  });

  const s = await f.service.snapshot(f.projectId);
  assert.equal(s.slots.find(s => s.id === 'background').candidateId, null);
  assert.equal(s.slots.find(s => s.id === 'shotbg').candidateId, 'shotimage');
  assert.equal(s.adoptions.length, 3);
  assert.equal(s.audit.length, 3);
  assert.equal(s.adoptions[2].action, 'undo');
  assert.equal(s.adoptions[1].id, shot.value.adoptionId);
  assert.equal(s.candidates.length, 2);
});

test(
  'usage proposals match authorized identity and appearance state with no cast count limit',
  async t => {
    const f = await withGeneration(t);

    await f.command('story.save', {
      id: 'story',
      title: 'Story',
      text: 'body',

      states: [{ id: 'adult' }, { id: 'child' }],

      revealPolicy: {}
    }, {
      aggregate: { kind: 'story', id: 'story' }
    });

    for (let i = 0; i < 10; i++) await f.command('cast.put', {
      id: 'role' + i,
      name: 'Role',
      language: 'ko',
      characterId: 'char' + i,

      identity: {
        id: 'char' + i,

        origin: { kind: 'studioLocal' }
      }
    }, {
      aggregate: { kind: 'cast', id: 'role' + i }
    });

    const scene = (await f.service.snapshot(f.projectId)).scenes[0];

    scene.occurrences = [{ id: 'adultO', roleBindingId: 'role0', characterId: 'char0', presence: 'onscreen' }, { id: 'childO', roleBindingId: 'role0', characterId: 'char0', presence: 'onscreen' }, { id: 'otherO', roleBindingId: 'role1', characterId: 'char1', presence: 'onscreen' }];

    scene.presentations = [{ occurrenceId: 'adultO', appearanceStateRef: 'adult', castingStateRef: null, knowledgeStateRef: null }, { occurrenceId: 'childO', appearanceStateRef: 'child', castingStateRef: null, knowledgeStateRef: null }, { occurrenceId: 'otherO', appearanceStateRef: 'adult', castingStateRef: null, knowledgeStateRef: null }];

    await f.command('scene.put', scene, {
      aggregate: { kind: 'scene', id: scene.id }
    });

    const slot = {
      id: 'adultasset',

      scope: { kind: 'project', id: 'p1' },

      subject: { kind: 'identity', id: 'char0' },

      appearanceStateRef: 'adult'
    };

    await assetImport(f, 'adultimage', await png(basePixels), slot);
    await adopt(f, slot.id, 'adultimage');
    const s = await f.service.snapshot(f.projectId);
    assert.deepEqual(s.usageProposals.map(p => p.occurrenceId), ['adultO']);

    await assert.rejects(async () => assetImport(f, 'forbidden', await png(basePixels), { ...slot, id: 'bad', appearanceStateRef: 'missing' }), { code: 'INVALID_REFERENCE' });
  }
);

test('protected derivative keeps raw candidate distinct and blocks stale base adoption', async t => {
  const f = await withGeneration(t);
  const slot = environmentSlot();
  await assetImport(f, 'base', await png(basePixels));
  await adopt(f, slot.id, 'base');
  await assetImport(f, 'rawedit', await png(driftPixels), environmentSlot('raw'));

  const result = await f.command('asset.derive', {
    id: 'composite',
    slotId: slot.id,
    baseCandidateId: 'base',
    candidateId: 'rawedit',
    operation: 'protected_edit',
    maskBytes: [...(await png(maskPixels))],

    geometry: { kind: 'identity' },

    actor: 'artist'
  }, {
    aggregate: { kind: 'assetSlot', id: slot.id }
  });

  assert.equal(result.value.candidate.lineage.rawCandidateId, 'rawedit');
  assert.equal(result.value.candidate.lineage.actor, 'artist');
  assert.notEqual(result.value.candidate.blobId, result.value.candidate.rawBlobId);
  await assetImport(f, 'replacement', await png(driftPixels));
  await adopt(f, slot.id, 'replacement');

  await assert.rejects(() => adopt(f, slot.id, 'composite'), { code: 'STALE_BASE' });
});

test('changed scene pins prevent adoption', async t => {
  const f = await withGeneration(t);

  const slot = environmentSlot('shotbg', { kind: 'shot', id: 'shot' });

  await assetImport(f, 'image', await png(basePixels), slot);
  const scene = (await f.service.snapshot(f.projectId)).scenes[0];

  await f.command('scene.put', { ...scene, title: 'new' }, {
    aggregate: { kind: 'scene', id: scene.id }
  });

  await assert.rejects(() => adopt(f, slot.id, 'image'), { code: 'INPUT_STALE' });
});

test('a stale review revision is rejected and a matching approved review permits adoption', async t => {
  const f = await withGeneration(t);
  await assetImport(f, 'image', await png(basePixels));

  await f.command('candidate.review', { candidateId: 'image', decision: 'approve', actor: 'reviewer', reason: 'looks right' }, {
    aggregate: { kind: 'assetReview', id: 'image' }
  });

  await assert.rejects(() => adopt(f, 'background', 'image'), { code: 'STALE_REVIEW' });

  await f.command('candidate.adopt', { slotId: 'background', candidateId: 'image', reviewRevision: 1, actor: 'artist', reason: 'accept' }, {
    aggregate: { kind: 'assetSlot', id: 'background' }
  });

  const s = await f.service.snapshot(f.projectId);
  assert.equal(s.slots[0].candidateId, 'image');
  assert.equal(s.candidates[0].validation.status, 'passed');
  assert.equal(s.adoptions[0].watched, undefined);
});

test('derived crop is saved only by explicit derive and keeps its original parent revision', async t => {
  const f = await withGeneration(t);
  await assetImport(f, 'image', await png(basePixels));
  await adopt(f, 'background', 'image');
  const before = (await f.service.snapshot(f.projectId)).candidates[0];
  const scene = (await f.service.snapshot(f.projectId)).scenes[0];

  await f.command('scene.put', {
    ...scene,

    shots: scene.shots.map(s => ({
      ...s,

      viewportShotTransform: { scale: 2, left: 1, top: 0 }
    }))
  }, {
    aggregate: { kind: 'scene', id: scene.id }
  });

  assert.equal((await f.service.snapshot(f.projectId)).candidates.length, 1);

  const result = await f.command('asset.derive', {
    id: 'crop',
    slotId: 'background',
    baseCandidateId: 'image',
    operation: 'crop',

    rect: { left: 1, top: 0, width: 1, height: 1 },

    actor: 'artist'
  }, {
    aggregate: { kind: 'assetSlot', id: 'background' }
  });

  assert.deepEqual(result.value.candidate.metadata, { width: 1, height: 1, channels: 4, colourspace: 'srgb', oriented: true });

  assert.deepEqual(result.value.candidate.lineage.parentCandidateIds, ['image']);
  assert.deepEqual((await f.service.snapshot(f.projectId)).candidates[0], before);
});

test('generated cast candidate can be adopted only by the matching identity and state', async t => {
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'] }),

        generate: async () => ({
          outputs: [{ bytes: await png(basePixels), mime: 'image/png' }]
        })
      }
    }
  });

  await f.command('story.save', {
    id: 'story',
    title: 'Story',
    text: 'body',

    states: [{ id: 'adult' }, { id: 'child' }],

    revealPolicy: {}
  }, {
    aggregate: { kind: 'story', id: 'story' }
  });

  await f.command('cast.put', {
    id: 'role',
    name: 'Role',
    language: 'ko',
    characterId: 'char',

    identity: {
      id: 'char',

      origin: { kind: 'studioLocal' }
    }
  }, {
    aggregate: { kind: 'cast', id: 'role' }
  });

  const { generationCommand, validImageRequest } = await import('./helpers/project.js');

  await generationCommand(f, validImageRequest({
    target: { kind: 'cast', id: 'role', stateRef: 'adult' }
  }));

  const { runWorker } = await import('../src/engine/worker.js');

  await runWorker({ service: f.service, drain: true });

  const generated = (await f.service.snapshot(f.projectId)).candidates[0];

  const adult = {
    id: 'adultslot',

    scope: { kind: 'project', id: 'p1' },

    subject: { kind: 'identity', id: 'char' },

    appearanceStateRef: 'adult'
  };

  const child = { ...adult, id: 'childslot', appearanceStateRef: 'child' };

  await assetImport(f, 'adultimport', await png(basePixels), adult);
  await assetImport(f, 'childimport', await png(basePixels), child);
  await adopt(f, adult.id, generated.id);

  await assert.rejects(() => adopt(f, child.id, generated.id), { code: 'SLOT_CONFLICT' });
});

test('generated asset slot candidate cannot replace a changed accepted base', async t => {
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'] }),

        generate: async () => ({
          outputs: [{ bytes: await png(driftPixels), mime: 'image/png' }]
        })
      }
    }
  });

  await assetImport(f, 'image', await png(basePixels));
  await adopt(f, 'background', 'image');

  const { generationCommand, validImageRequest } = await import('./helpers/project.js');

  await generationCommand(f, validImageRequest({
    target: { kind: 'assetSlot', id: 'background' }
  }));

  const { runWorker } = await import('../src/engine/worker.js');

  await runWorker({ service: f.service, drain: true });

  const generated = (await f.service.snapshot(f.projectId)).candidates.find(c => c.attemptId);
  await assetImport(f, 'replacement', await png(basePixels));
  await adopt(f, 'background', 'replacement');

  await assert.rejects(() => adopt(f, 'background', generated.id), { code: 'STALE_BASE' });
});

test('production common reference can be explicitly pinned in its descendant shot', async t => {
  const f = await withGeneration(t);

  await assetImport(f, 'common', await png(basePixels), environmentSlot('productionbg', { kind: 'production', id: 'main' }));

  await assetImport(f, 'local', await png(driftPixels), environmentSlot('shotbg', { kind: 'shot', id: 'shot' }));

  await adopt(f, 'shotbg', 'common');
  assert.equal((await f.service.snapshot(f.projectId)).slots.find(s => s.id === 'shotbg').candidateId, 'common');
});

test('environment appearance state is pinned and removal blocks candidate adoption', async t => {
  const f = await withGeneration(t);

  await f.command('story.save', {
    id: 'story',
    title: 'Story',
    text: 'body',

    states: [{ id: 'summer' }],

    revealPolicy: {}
  }, {
    aggregate: { kind: 'story', id: 'story' }
  });

  await assetImport(f, 'summerroom', await png(basePixels), {
    ...environmentSlot(),
    appearanceStateRef: 'summer'
  });

  await f.command('story.save', {
    id: 'story',
    title: 'Story',
    text: 'body',
    states: [],
    revealPolicy: {}
  }, {
    aggregate: { kind: 'story', id: 'story' }
  });

  await assert.rejects(
    () => adopt(f, 'background', 'summerroom'),
    e => ['INPUT_STALE', 'INVALID_REFERENCE'].includes(e.code)
  );
});

test(
  'changed environment state semantics reject old candidate and stop a queued slot request before dispatch',
  async t => {
    const f = await withGeneration(t);

    await f.command('story.save', {
      id: 'story',
      title: 'Story',
      text: 'body',

      states: [{ id: 'summer', description: 'bright' }],

      revealPolicy: {}
    }, {
      aggregate: { kind: 'story', id: 'story' }
    });

    await assetImport(f, 'summerroom', await png(basePixels), {
      ...environmentSlot(),
      appearanceStateRef: 'summer'
    });

    const { generationCommand, validImageRequest } = await import('./helpers/project.js');

    await generationCommand(f, validImageRequest({
      target: { kind: 'assetSlot', id: 'background' }
    }));

    await f.command('story.save', {
      id: 'story',
      title: 'Story',
      text: 'body',

      states: [{ id: 'summer', description: 'dark' }],

      revealPolicy: {}
    }, {
      aggregate: { kind: 'story', id: 'story' }
    });

    await assert.rejects(() => adopt(f, 'background', 'summerroom'), { code: 'INPUT_STALE' });

    let dispatches = 0;

    const { runWorker } = await import('../src/engine/worker.js');

    await runWorker({
      service: f.service,
      drain: true,

      providers: {
        fake: {
          capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'] }),

          generate: async () => {
            dispatches++;

            return {
              outputs: [{ bytes: await png(basePixels), mime: 'image/png' }]
            };
          }
        }
      }
    });

    assert.equal(dispatches, 0);
    assert.equal((await f.service.snapshot(f.projectId)).attempts[0].status, 'failed_definite');
  }
);

test(
  'a protected-edit raw provider candidate requires a verified composite before adoption',
  async t => {
    const f = await withGeneration(t, {
      providers: {
        fake: {
          capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'] }),

          generate: async () => ({
            outputs: [{ bytes: await png(driftPixels), mime: 'image/png' }]
          })
        }
      }
    });

    await assetImport(f, 'image', await png(basePixels));
    await adopt(f, 'background', 'image');

    const { generationCommand, validImageRequest } = await import('./helpers/project.js');

    await generationCommand(f, validImageRequest({
      target: { kind: 'assetSlot', id: 'background' },

      recipe: { operation: 'protected_edit', nativeMask: false }
    }));

    const { runWorker } = await import('../src/engine/worker.js');

    await runWorker({ service: f.service, drain: true });

    const candidate = (await f.service.snapshot(f.projectId)).candidates.find(c => c.attemptId);

    await assert.rejects(() => adopt(f, 'background', candidate.id), { code: 'PROTECTED_COMPOSITE_REQUIRED' });
  }
);

test(
  'asynchronous adoption rechecks source inputs and review after actual decode preparation',
  async t => {
    for (const change of ['scene', 'review']) await t.test(change, async t => {
      const f = await withGeneration(t);

      const slot = environmentSlot('shotbg', { kind: 'shot', id: 'shot' });

      await assetImport(f, 'image', await png(basePixels), slot);
      const read = f.service.blobs.read.bind(f.service.blobs);
      let release, entered;
      const gate = new Promise(r => release = r), started = new Promise(r => entered = r);

      f.service.blobs.read = async (...args) => {
        const bytes = await read(...args);
        entered();
        await gate;
        return bytes;
      };

      const work = adopt(f, slot.id, 'image');
      await started;

      if (change === 'scene') {
        const scene = (await f.service.snapshot(f.projectId)).scenes[0];

        await f.command('scene.put', { ...scene, title: 'changed' }, {
          aggregate: { kind: 'scene', id: scene.id }
        });
      } else await f.command('candidate.review', { candidateId: 'image', decision: 'reject', actor: 'reviewer', reason: 'changed mind' }, {
        aggregate: { kind: 'assetReview', id: 'image' }
      });

      release();

      await assert.rejects(work, { code: change === 'scene' ? 'INPUT_STALE' : 'STALE_REVIEW' });

      assert.equal((await f.service.snapshot(f.projectId)).adoptions.length, 0);
    });
  }
);

test('reusing an asset revision id cannot replace accepted bytes or lineage', async t => {
  const f = await withGeneration(t);
  await assetImport(f, 'immutable', await png(basePixels));
  const before = (await f.service.snapshot(f.projectId)).candidates[0];

  await assert.rejects(async () => assetImport(f, 'immutable', await png(driftPixels)), { code: 'IMMUTABLE_CANDIDATE' });

  assert.deepEqual((await f.service.snapshot(f.projectId)).candidates[0], before);
});

test(
  'decoded generated asset can create its matching adoption slot without a placeholder import',
  async t => {
    const f = await withGeneration(t, {
      providers: {
        fake: {
          capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'] }),

          generate: async () => ({
            outputs: [{ bytes: await png(basePixels), mime: 'image/png' }]
          })
        }
      }
    });

    const { generationCommand } = await import('./helpers/project.js');

    await generationCommand(f);

    const { runWorker } = await import('../src/engine/worker.js');

    await runWorker({ service: f.service, drain: true });

    const c = (await f.service.snapshot(f.projectId)).candidates[0],
          slot = environmentSlot('shotbg', { kind: 'shot', id: 'shot' });

    await f.command('candidate.adopt', { slotId: slot.id, slot, candidateId: c.id, actor: 'artist', reason: 'accept decoded result' }, {
      aggregate: { kind: 'assetSlot', id: slot.id }
    });

    const s = await f.service.snapshot(f.projectId);
    assert.equal(s.slots[0].candidateId, c.id);
    assert.equal(s.candidates.length, 1);
  }
);

test('source rebase blocks adoption of a candidate pinned to the old production package', async t => {
  const f = await withGeneration(t);

  await assetImport(f, 'old', await png(basePixels), environmentSlot('prod', { kind: 'production', id: 'main' }));

  const { makeSourcePackage } = await import('../src/source/source-package.js');

  const pkg = makeSourcePackage({
    sourceKind: 'studio-script',
    sourceRevision: 'v2',
    textUnits: [],
    sceneScopes: [],
    sourceIdentityMap: [],
    revealPolicy: {},
    blobManifest: [],

    preservationStatus: { actualSourceBytes: 'complete' }
  });

  await f.command('source.import', { package: pkg, blobs: [] }, {
    aggregate: { kind: 'sourcePackage', id: pkg.id }
  });

  const proposal = await f.command('source.rebase', { productionId: 'main', sourcePackageId: pkg.id, actor: 'user', reason: 'new source' }, {
    aggregate: { kind: 'sourceBinding', id: 'main' }
  });

  await f.command('source.rebase', {
    productionId: 'main',
    decisionId: proposal.value.id,
    action: 'apply',
    actor: 'user',
    reason: 'accept',

    choices: [{ sceneId: 'scene', action: 'replan' }]
  }, {
    aggregate: { kind: 'sourceBinding', id: 'main' }
  });

  await assert.rejects(() => adopt(f, 'prod', 'old'), { code: 'SOURCE_BINDING_STALE' });

  assert.equal((await f.service.snapshot(f.projectId)).candidates[0].sourcePackageId, null);
});

test(
  'invalid geometry creates no derivative and preserves immutable raw candidate for another attempt',
  async t => {
    const f = await withGeneration(t);
    await assetImport(f, 'base', await png(basePixels));
    await adopt(f, 'background', 'base');
    await assetImport(f, 'raw', await png(driftPixels), environmentSlot('rawslot'));

    await assert.rejects(async () => f.command('asset.derive', {
      id: 'bad',
      slotId: 'background',
      baseCandidateId: 'base',
      candidateId: 'raw',
      operation: 'protected_edit',
      maskBytes: [...(await png(maskPixels))],

      geometry: { kind: 'unknown' },

      actor: 'artist'
    }, {
      aggregate: { kind: 'assetSlot', id: 'background' }
    }), { code: 'INVALID_GEOMETRY' });

    const s = await f.service.snapshot(f.projectId);
    assert.equal(s.candidates.length, 2);
    assert.equal(s.slots.find(s => s.id === 'background').candidateId, 'base');

    assert.deepEqual(
      [...(await f.service.readBlob(f.projectId, s.candidates.find(c => c.id === 'raw').rawBlobId))],
      [...(await png(driftPixels))]
    );
  }
);

test('protected derivation cannot relabel a raw candidate from another appearance state', async t => {
  const f = await withGeneration(t);

  await f.command('story.save', {
    id: 'story',
    title: 'Story',
    text: 'body',

    states: [{ id: 'adult' }, { id: 'child' }],

    revealPolicy: {}
  }, {
    aggregate: { kind: 'story', id: 'story' }
  });

  await f.command('cast.put', {
    id: 'role',
    name: 'Role',
    language: 'ko',
    characterId: 'char',

    identity: {
      id: 'char',

      origin: { kind: 'studioLocal' }
    }
  }, {
    aggregate: { kind: 'cast', id: 'role' }
  });

  const adult = {
          id: 'adultslot',

          scope: { kind: 'project', id: 'p1' },

          subject: { kind: 'identity', id: 'char' },

          appearanceStateRef: 'adult'
        },
        child = { ...adult, id: 'childslot', appearanceStateRef: 'child' };

  await assetImport(f, 'adultbase', await png(basePixels), adult);
  await adopt(f, adult.id, 'adultbase');
  await assetImport(f, 'childraw', await png(driftPixels), child);

  await assert.rejects(async () => f.command('asset.derive', {
    id: 'wrong',
    slotId: adult.id,
    baseCandidateId: 'adultbase',
    candidateId: 'childraw',
    operation: 'protected_edit',
    maskBytes: [...(await png(maskPixels))],

    geometry: { kind: 'identity' },

    actor: 'artist'
  }, {
    aggregate: { kind: 'assetSlot', id: adult.id }
  }), { code: 'SLOT_CONFLICT' });

  assert.equal((await f.service.snapshot(f.projectId)).candidates.length, 2);
});

test(
  'stale accepted common assets stop producing new usage proposals while retaining their adopted pin',
  async t => {
    const f = await withGeneration(t);

    const story = {
      id: 'story',
      title: 'Story',
      text: 'body',

      states: [{ id: 'adult' }],

      revealPolicy: {}
    };

    await f.command('story.save', story, {
      aggregate: { kind: 'story', id: 'story' }
    });

    await f.command('cast.put', {
      id: 'role',
      name: 'Role',
      language: 'ko',
      characterId: 'char',

      identity: {
        id: 'char',

        origin: { kind: 'studioLocal' }
      }
    }, {
      aggregate: { kind: 'cast', id: 'role' }
    });

    const scene = (await f.service.snapshot(f.projectId)).scenes[0];

    scene.occurrences = [{ id: 'o', roleBindingId: 'role', characterId: 'char', presence: 'onscreen' }];

    scene.presentations = [{ occurrenceId: 'o', appearanceStateRef: 'adult', castingStateRef: null, knowledgeStateRef: null }];

    await f.command('scene.put', scene, {
      aggregate: { kind: 'scene', id: scene.id }
    });

    const slot = {
      id: 'adultslot',

      scope: { kind: 'project', id: 'p1' },

      subject: { kind: 'identity', id: 'char' },

      appearanceStateRef: 'adult'
    };

    await assetImport(f, 'image', await png(basePixels), slot);
    await adopt(f, slot.id, 'image');
    assert.equal((await f.service.snapshot(f.projectId)).usageProposals.length, 1);

    await f.command('story.save', {
      ...story,

      states: [{ id: 'adult', description: 'changed costume' }]
    }, {
      aggregate: { kind: 'story', id: 'story' }
    });

    const s = await f.service.snapshot(f.projectId);
    assert.equal(s.slots[0].candidateId, 'image');
    assert.equal(s.usageProposals.length, 0);
  }
);

test(
  'successive undo restores protected B then original A using retained proof rather than current creation-base',
  async t => {
    const f = await withGeneration(t);
    await assetImport(f, 'A', await png(basePixels));
    await adopt(f, 'background', 'A');
    let latest;

    for (const [id, raw, pixels] of [['B', 'rawB', driftPixels], ['C', 'rawC', [21, 30, 40, 255, 200, 210, 220, 255, 81, 90, 100, 255]]]) {
      await assetImport(f, raw, await png(pixels), environmentSlot('rawslot'));
      const base = (await f.service.snapshot(f.projectId)).slots.find(s => s.id === 'background').candidateId;

      await f.command('asset.derive', {
        id,
        slotId: 'background',
        baseCandidateId: base,
        candidateId: raw,
        operation: 'protected_edit',
        maskBytes: [...(await png(maskPixels))],

        geometry: { kind: 'identity' },

        actor: 'artist'
      }, {
        aggregate: { kind: 'assetSlot', id: 'background' }
      });

      latest = await adopt(f, 'background', id);
    }

    const undo = await f.command('adoption.undo', { slotId: 'background', adoptionId: latest.value.adoptionId, actor: 'artist', reason: 'undo C' }, {
      aggregate: { kind: 'assetSlot', id: 'background' }
    });

    assert.equal(undo.value.candidateId, 'B');

    const again = await f.command('adoption.undo', { slotId: 'background', adoptionId: undo.value.adoptionId, actor: 'artist', reason: 'undo B' }, {
      aggregate: { kind: 'assetSlot', id: 'background' }
    });

    assert.equal(again.value.candidateId, 'A');
    const s = await f.service.snapshot(f.projectId);
    assert.equal(s.adoptions.length, 5);
    assert.equal(s.candidates.length, 5);
  }
);

test('undo cannot restore an earlier candidate after semantic source rebase', async t => {
  const f = await withGeneration(t),
        slot = environmentSlot('prod', { kind: 'production', id: 'main' });

  await assetImport(f, 'A', await png(basePixels), slot);
  await adopt(f, slot.id, 'A');
  await assetImport(f, 'B', await png(driftPixels), slot);
  const current = await adopt(f, slot.id, 'B');

  const { makeSourcePackage } = await import('../src/source/source-package.js');

  const pkg = makeSourcePackage({
    sourceKind: 'studio-script',
    sourceRevision: 'v2',
    textUnits: [],
    sceneScopes: [],
    sourceIdentityMap: [],
    revealPolicy: {},
    blobManifest: [],

    preservationStatus: { actualSourceBytes: 'complete' }
  });

  await f.command('source.import', { package: pkg, blobs: [] }, {
    aggregate: { kind: 'sourcePackage', id: pkg.id }
  });

  const proposal = await f.command('source.rebase', { productionId: 'main', sourcePackageId: pkg.id, actor: 'user', reason: 'new source' }, {
    aggregate: { kind: 'sourceBinding', id: 'main' }
  });

  await f.command('source.rebase', {
    productionId: 'main',
    decisionId: proposal.value.id,
    action: 'apply',
    actor: 'user',
    reason: 'accept',

    choices: [{ sceneId: 'scene', action: 'replan' }]
  }, {
    aggregate: { kind: 'sourceBinding', id: 'main' }
  });

  await assert.rejects(() => f.command('adoption.undo', { slotId: slot.id, adoptionId: current.value.adoptionId, actor: 'artist', reason: 'undo' }, {
    aggregate: { kind: 'assetSlot', id: slot.id }
  }), { code: 'SOURCE_BINDING_STALE' });

  assert.equal((await f.service.snapshot(f.projectId)).slots[0].candidateId, 'B');
});

test('attached compatible shot subscribers can independently adopt one decoded result', async t => {
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'] }),

        generate: async () => ({
          outputs: [{ bytes: await png(basePixels), mime: 'image/png' }]
        })
      }
    }
  });

  const { generationCommand, validImageRequest } = await import('./helpers/project.js');

  const first = validImageRequest(),
        second = validImageRequest({
          target: { kind: 'shot', id: 'shot2' }
        });

  const one = await generationCommand(f, first);
  const two = await generationCommand(f, second);
  assert.equal(one.value.id, two.value.id);

  const { runWorker } = await import('../src/engine/worker.js');

  await runWorker({ service: f.service, drain: true });

  const c = (await f.service.snapshot(f.projectId)).candidates[0];

  const shot1 = environmentSlot('slot1', { kind: 'shot', id: 'shot' }),
        shot2 = environmentSlot('slot2', { kind: 'shot', id: 'shot2' });

  await f.command('candidate.adopt', {
    slotId: shot1.id,
    slot: shot1,
    candidateId: c.id,
    subscriberId: first.subscriberId,
    actor: 'artist',
    reason: 'accept first'
  }, {
    aggregate: { kind: 'assetSlot', id: shot1.id }
  });

  const before = (await f.service.snapshot(f.projectId)).slots.find(s => s.id === shot1.id);

  await f.command('candidate.adopt', {
    slotId: shot2.id,
    slot: shot2,
    candidateId: c.id,
    subscriberId: second.subscriberId,
    actor: 'artist',
    reason: 'accept second'
  }, {
    aggregate: { kind: 'assetSlot', id: shot2.id }
  });

  const s = await f.service.snapshot(f.projectId);
  assert.deepEqual(s.slots.find(s => s.id === shot1.id), before);
  assert.equal(s.slots.find(s => s.id === shot2.id).candidateId, c.id);
  assert.equal(s.candidates[0].target.id, 'shot');
  assert.equal(s.adoptions[1].subscriberId, second.subscriberId);
  assert.equal(s.adoptions[1].authorization.target.id, 'shot2');
  assert.equal(s.attempts.length, 1);
});

test(
  'detached, stale and mismatched-state subscribers cannot authorize cross-shot adoption',
  async t => {
    for (const failure of ['detached', 'stale', 'state']) await t.test(failure, async t => {
      const f = await withGeneration(t, {
        providers: {
          fake: {
            capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'] }),

            generate: async () => ({
              outputs: [{ bytes: await png(basePixels), mime: 'image/png' }]
            })
          }
        }
      });

      if (failure === 'state') await f.command('story.save', {
        id: 'story',
        title: 'Story',
        text: 'body',

        states: [{ id: 'child' }],

        revealPolicy: {}
      }, {
        aggregate: { kind: 'story', id: 'story' }
      });

      const { generationCommand, validImageRequest } = await import('./helpers/project.js');

      const first = validImageRequest(),
            second = validImageRequest({
              target: { kind: 'shot', id: 'shot2' }
            });

      const job = (await generationCommand(f, first)).value;
      await generationCommand(f, second);

      const { runWorker } = await import('../src/engine/worker.js');

      await runWorker({ service: f.service, drain: true });

      const c = (await f.service.snapshot(f.projectId)).candidates[0];

      let slot = environmentSlot('slot2', { kind: 'shot', id: 'shot2' });

      if (failure === 'detached') await f.command('job.cancel', { jobId: job.id, subscriberId: second.subscriberId }, {
        aggregate: { kind: 'job', id: job.id }
      });

      if (failure === 'stale') {
        const scene = (await f.service.snapshot(f.projectId)).scenes[0];

        await f.command('scene.put', { ...scene, title: 'changed' }, {
          aggregate: { kind: 'scene', id: scene.id }
        });
      }

      if (failure === 'state') slot = { ...slot, appearanceStateRef: 'child' };

      await assert.rejects(() => f.command('candidate.adopt', { slotId: slot.id, slot, candidateId: c.id, subscriberId: second.subscriberId, actor: 'artist', reason: 'accept' }, {
        aggregate: { kind: 'assetSlot', id: slot.id }
      }), { code: failure === 'detached' ? 'SUBSCRIBER_UNAVAILABLE' : failure === 'stale' ? 'INPUT_STALE' : 'SLOT_CONFLICT' });

      assert.equal((await f.service.snapshot(f.projectId)).adoptions.length, 0);
    });
  }
);

test(
  'subscriber detachment during real decode preparation fences adoption in the final transaction',
  async t => {
    const f = await withGeneration(t, {
      providers: {
        fake: {
          capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'] }),

          generate: async () => ({
            outputs: [{ bytes: await png(basePixels), mime: 'image/png' }]
          })
        }
      }
    });

    const { generationCommand, validImageRequest } = await import('./helpers/project.js');

    const first = validImageRequest(),
          second = validImageRequest({
            target: { kind: 'shot', id: 'shot2' }
          });

    const job = (await generationCommand(f, first)).value;
    await generationCommand(f, second);

    const { runWorker } = await import('../src/engine/worker.js');

    await runWorker({ service: f.service, drain: true });

    const c = (await f.service.snapshot(f.projectId)).candidates[0],
          slot = environmentSlot('slot2', { kind: 'shot', id: 'shot2' });

    const read = f.service.blobs.read.bind(f.service.blobs);
    let release, entered;
    const gate = new Promise(r => release = r), started = new Promise(r => entered = r);

    f.service.blobs.read = async (...args) => {
      const bytes = await read(...args);
      entered();
      await gate;
      return bytes;
    };

    const work = f.command('candidate.adopt', { slotId: slot.id, slot, candidateId: c.id, subscriberId: second.subscriberId, actor: 'artist', reason: 'accept' }, {
      aggregate: { kind: 'assetSlot', id: slot.id }
    });

    await started;

    await f.command('job.cancel', { jobId: job.id, subscriberId: second.subscriberId }, {
      aggregate: { kind: 'job', id: job.id }
    });

    release();

    await assert.rejects(work, { code: 'SUBSCRIBER_UNAVAILABLE' });

    assert.equal((await f.service.snapshot(f.projectId)).adoptions.length, 0);
  }
);

test(
  'adoption result reports only the accepted slot pointer without stale import staging descriptors',
  async t => {
    const f = await withGeneration(t);
    await assetImport(f, 'A', await png(basePixels));
    await assetImport(f, 'B', await png(driftPixels));
    const accepted = await adopt(f, 'background', 'A');
    assert.equal(accepted.value.candidateId, 'A');
    assert.equal(accepted.value.candidate, undefined);
    assert.equal(accepted.value.quarantine, undefined);
  }
);

test(
  'encoded WAV takes bind independently to compatible utterances and explicit voice state',
  async t => {
    const { withAudioScene, audioTakeSlot, generationCommand, validImageRequest } = await import('./helpers/project.js');

    const f = await withAudioScene(t);

    const first = validImageRequest({
            kind: 'audio',

            input: {
              model: 'fake-v1',
              prompt: '같은 대사',
              config: {}
            },

            target: { kind: 'utterance', id: 'u1' }
          }),
          second = validImageRequest({
            kind: 'audio',

            input: {
              model: 'fake-v1',
              prompt: '같은 대사',
              config: {}
            },

            target: { kind: 'utterance', id: 'u2' }
          });

    const job = (await generationCommand(f, first)).value;
    const same = (await generationCommand(f, second)).value;
    assert.equal(job.id, same.id);

    const { runWorker } = await import('../src/engine/worker.js');

    await runWorker({ service: f.service, drain: true });

    const c = (await f.service.snapshot(f.projectId)).candidates[0];
    const s1 = audioTakeSlot('take1', 'u1'), s2 = audioTakeSlot('take2', 'u2');

    await f.command('candidate.adopt', { slotId: s1.id, slot: s1, candidateId: c.id, subscriberId: first.subscriberId, actor: 'artist', reason: 'select take' }, {
      aggregate: { kind: 'assetSlot', id: s1.id }
    });

    const before = (await f.service.snapshot(f.projectId)).slots.find(s => s.id === s1.id);

    await f.command('candidate.adopt', {
      slotId: s2.id,
      slot: s2,
      candidateId: c.id,
      subscriberId: second.subscriberId,
      actor: 'artist',
      reason: 'select take'
    }, {
      aggregate: { kind: 'assetSlot', id: s2.id }
    });

    const s = await f.service.snapshot(f.projectId);
    assert.deepEqual(s.slots.find(s => s.id === s1.id), before);
    assert.equal(s.slots.find(s => s.id === s2.id).candidateId, c.id);
    assert.equal(s.adoptions[1].utteranceId, 'u2');
    assert.equal(s.adoptions[1].castingStateRef, 'childvoice');
    assert.equal(s.adoptions[1].desiredVoiceBinding.voice, 'shared-voice');
    assert.equal(s.adoptions[1].takeId, c.id);
    assert.equal(s.candidates[0].metadata.frameCount, 3);
    assert.equal(s.candidates[0].target.id, 'u1');
    assert.equal(s.adoptions[1].listened, undefined);
  }
);

test(
  'characterless narrator and nonvisual speaker presences support actual imported audio takes',
  async t => {
    const { withAudioScene, audioTakeSlot } = await import('./helpers/project.js');

    const { wav } = await import('./helpers/images.js');

    const f = await withAudioScene(t);

    for (const presence of ['narrator', 'inner', 'ensemble', 'voiceover', 'offscreen']) {
      const scene = (await f.service.snapshot(f.projectId)).scenes[0];

      scene.occurrences = scene.occurrences.map(o => o.id === 'narration' ? { ...o, presence } : o);

      await f.command('scene.put', scene, {
        aggregate: { kind: 'scene', id: scene.id }
      });

      const slot = audioTakeSlot('n' + presence, 'uN', 'narrator', null, { kind: 'shot', id: 'shot' });

      await assetImport(f, 'audio' + presence, wav(), slot, 'audio');
      await adopt(f, slot.id, 'audio' + presence);
      const s = await f.service.snapshot(f.projectId);
      assert.equal(s.slots.find(s => s.id === slot.id).candidateId, 'audio' + presence);
      assert.equal(s.adoptions.at(-1).roleBindingId, 'narrator');
      assert.equal(s.adoptions.at(-1).speakerOccurrenceId, 'narration');
    }
  }
);

test(
  'audio adoption rejects another utterance, speaker, voice state and stale text/casting',
  async t => {
    const { withAudioScene, audioTakeSlot, generationCommand, validImageRequest } = await import('./helpers/project.js');

    for (const failure of ['utterance', 'speaker', 'state', 'text', 'casting']) await t.test(failure, async t => {
      const f = await withAudioScene(t);

      await generationCommand(f, validImageRequest({
        kind: 'audio',

        input: {
          model: 'fake-v1',
          prompt: '같은 대사',
          config: {}
        },

        target: { kind: 'utterance', id: 'u1' }
      }));

      const { runWorker } = await import('../src/engine/worker.js');

      await runWorker({ service: f.service, drain: true });

      const c = (await f.service.snapshot(f.projectId)).candidates[0];
      let slot = audioTakeSlot('take1', 'u1');

      if (failure === 'utterance') slot = { ...slot, utteranceId: 'u2' };

      if (failure === 'speaker') slot = {
        ...slot,

        subject: { kind: 'role', id: 'narrator' }
      };

      if (failure === 'state') slot = { ...slot, castingStateRef: 'adult' };

      if (failure === 'text') await f.command('utterance.update', { id: 'u1', text: '다른 대사' }, {
        aggregate: { kind: 'utterance', id: 'u1' }
      });

      if (failure === 'casting') await f.command('casting.set', { id: 'childcast', scope: 'project', roleId: 'actor', state: 'childvoice', voice: 'new-voice' }, {
        aggregate: { kind: 'casting', id: 'childcast' }
      });

      await assert.rejects(() => f.command('candidate.adopt', { slotId: slot.id, slot, candidateId: c.id, actor: 'artist', reason: 'select' }, {
        aggregate: { kind: 'assetSlot', id: slot.id }
      }), e => ['SLOT_CONFLICT', 'INVALID_REFERENCE', 'INPUT_STALE'].includes(e.code));

      assert.equal((await f.service.snapshot(f.projectId)).adoptions.length, 0);
    });
  }
);

test(
  'hold-only changes retain selected audio and allow explicitly compatible reuse without another dispatch',
  async t => {
    const { withAudioScene, audioTakeSlot, generationCommand, validImageRequest } = await import('./helpers/project.js');

    const f = await withAudioScene(t);

    const request = validImageRequest({
            kind: 'audio',

            input: {
              model: 'fake-v1',
              prompt: '같은 대사',
              config: {}
            },

            target: { kind: 'utterance', id: 'u1' }
          }),
          job = (await generationCommand(f, request)).value;

    const { runWorker } = await import('../src/engine/worker.js');

    await runWorker({ service: f.service, drain: true });

    const c = (await f.service.snapshot(f.projectId)).candidates[0], slot = audioTakeSlot('take1', 'u1');

    await f.command('candidate.adopt', { slotId: slot.id, slot, candidateId: c.id, actor: 'artist', reason: 'select' }, {
      aggregate: { kind: 'assetSlot', id: slot.id }
    });

    const before = (await f.service.snapshot(f.projectId)).slots[0];

    await f.command('utterance.update', { id: 'u1', holdMs: 1000 }, {
      aggregate: { kind: 'utterance', id: 'u1' }
    });

    assert.deepEqual((await f.service.snapshot(f.projectId)).slots[0], before);

    const reuse = validImageRequest({
      kind: 'audio',

      input: {
        model: 'fake-v1',
        prompt: '같은 대사',
        config: {}
      },

      target: { kind: 'utterance', id: 'u1' }
    });

    await f.command('job.reuse', { ...reuse, jobId: job.id, allowTimingChanges: true }, {
      aggregate: { kind: 'generation', id: reuse.subscriberId }
    });

    await f.command('candidate.adopt', { slotId: slot.id, candidateId: c.id, subscriberId: reuse.subscriberId, actor: 'artist', reason: 'reuse after hold' }, {
      aggregate: { kind: 'assetSlot', id: slot.id }
    });

    await runWorker({ service: f.service, drain: true });

    assert.equal((await f.service.snapshot(f.projectId)).attempts.length, 1);

    await f.command('utterance.update', {
      id: 'u1',

      acting: { tone: 'angry' }
    }, {
      aggregate: { kind: 'utterance', id: 'u1' }
    });

    const invalid = validImageRequest({
      kind: 'audio',

      input: {
        model: 'fake-v1',
        prompt: '같은 대사',
        config: {}
      },

      target: { kind: 'utterance', id: 'u1' }
    });

    await assert.rejects(() => f.command('job.reuse', { ...invalid, jobId: job.id, allowTimingChanges: true }, {
      aggregate: { kind: 'generation', id: invalid.subscriberId }
    }), { code: 'INCOMPATIBLE_REUSE' });
  }
);

test(
  'generated utterance audio rejects actual speech text that differs from its labeled target',
  async t => {
    const { withAudioScene, generationCommand, validImageRequest } = await import('./helpers/project.js');

    const f = await withAudioScene(t);

    await assert.rejects(() => generationCommand(f, validImageRequest({
      kind: 'audio',

      target: { kind: 'utterance', id: 'uN' },

      input: {
        model: 'fake-v1',
        prompt: '같은 대사',
        config: {}
      }
    })), { code: 'SPEECH_TEXT_MISMATCH' });

    const s = await f.service.snapshot(f.projectId);
    assert.equal(s.jobs.length, 0);
    assert.equal(s.reservations.length, 0);
  }
);

test('timing reuse refuses missing engine proof and non-audio relaxation', async t => {
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'] }),

        generate: async () => ({
          outputs: [{ bytes: await png(basePixels), mime: 'image/png' }]
        })
      }
    }
  });

  const { generationCommand, validImageRequest } = await import('./helpers/project.js');

  const job = (await generationCommand(f)).value;

  const { runWorker } = await import('../src/engine/worker.js');

  await runWorker({ service: f.service, drain: true });

  const image = validImageRequest();

  await assert.rejects(() => f.command('job.reuse', { ...image, jobId: job.id, allowTimingChanges: true }, {
    aggregate: { kind: 'generation', id: image.subscriberId }
  }), { code: 'INVALID_INPUT' });
});

test(
  'imported WAV take selection survives hold changes with manual speech verification preserved',
  async t => {
    const { withAudioScene, audioTakeSlot } = await import('./helpers/project.js');

    const { wav } = await import('./helpers/images.js');

    const f = await withAudioScene(t), slot = audioTakeSlot('take1', 'u1');
    await assetImport(f, 'importedtake', wav(), slot, 'audio');
    await adopt(f, slot.id, 'importedtake');
    const before = (await f.service.snapshot(f.projectId)).slots[0];

    await f.command('utterance.update', { id: 'u1', holdMs: 2000 }, {
      aggregate: { kind: 'utterance', id: 'u1' }
    });

    const s = await f.service.snapshot(f.projectId);
    assert.deepEqual(s.slots[0], before);
    assert.equal(s.jobs.length, 0);
    assert.equal(s.candidates[0].speechVerification, 'unverified_import');
    assert.equal(s.candidates[0].transcriptionVerification, 'not_performed');
  }
);

test(
  'explicit audio timing reuse still rejects text, casting, source and actual model/config changes',
  async t => {
    const { withAudioScene, generationCommand, validImageRequest } = await import('./helpers/project.js');

    for (const change of ['text', 'casting', 'source', 'model', 'config']) await t.test(change, async t => {
      const f = await withAudioScene(t),
            request = validImageRequest({
              kind: 'audio',

              target: { kind: 'utterance', id: 'u1' },

              input: {
                model: 'fake-v1',
                prompt: '같은 대사',
                config: {}
              }
            }),
            job = (await generationCommand(f, request)).value;

      const { runWorker } = await import('../src/engine/worker.js');

      await runWorker({ service: f.service, drain: true });

      let input = request.input;

      if (change === 'text') await f.command('utterance.update', { id: 'u1', text: '바뀐 대사' }, {
        aggregate: { kind: 'utterance', id: 'u1' }
      });

      if (change === 'casting') await f.command('casting.set', { id: 'childcast', scope: 'project', roleId: 'actor', state: 'childvoice', voice: 'different-voice' }, {
        aggregate: { kind: 'casting', id: 'childcast' }
      });

      if (change === 'source') {
        const { makeSourcePackage } = await import('../src/source/source-package.js');

        const pkg = makeSourcePackage({
          sourceKind: 'studio-script',
          sourceRevision: 'v2',
          textUnits: [],
          sceneScopes: [],
          sourceIdentityMap: [],
          revealPolicy: {},
          blobManifest: [],

          preservationStatus: { actualSourceBytes: 'complete' }
        });

        await f.command('source.import', { package: pkg, blobs: [] }, {
          aggregate: { kind: 'sourcePackage', id: pkg.id }
        });

        const proposal = await f.command('source.rebase', { productionId: 'main', sourcePackageId: pkg.id, actor: 'user', reason: 'new source' }, {
          aggregate: { kind: 'sourceBinding', id: 'main' }
        });

        await f.command('source.rebase', {
          productionId: 'main',
          decisionId: proposal.value.id,
          action: 'apply',
          actor: 'user',
          reason: 'accept',

          choices: [{ sceneId: 'scene', action: 'replan' }]
        }, {
          aggregate: { kind: 'sourceBinding', id: 'main' }
        });
      }

      if (change === 'model') input = { ...input, model: 'fake-v2' };

      if (change === 'config') input = {
        ...input,

        config: { voice: 'different-voice' }
      };

      const reuse = validImageRequest({
        kind: 'audio',

        target: { kind: 'utterance', id: 'u1' },

        input
      });

      await assert.rejects(() => f.command('job.reuse', { ...reuse, jobId: job.id, allowTimingChanges: true }, {
        aggregate: { kind: 'generation', id: reuse.subscriberId }
      }), e => ['INCOMPATIBLE_REUSE', 'SPEECH_TEXT_MISMATCH', 'SOURCE_BINDING_STALE'].includes(e.code));

      assert.equal((await f.service.snapshot(f.projectId)).attempts.length, 1);
    });
  }
);

test('timing reuse refuses audio without engine utterance compatibility proof', async t => {
  const { withAudioScene, generationCommand, validImageRequest } = await import('./helpers/project.js');

  const f = await withAudioScene(t);

  const request = validImageRequest({
          kind: 'audio',

          target: { kind: 'cast', id: 'actor', stateRef: 'childvoice' }
        }),
        job = (await generationCommand(f, request)).value;

  const { runWorker } = await import('../src/engine/worker.js');

  await runWorker({ service: f.service, drain: true });

  const reuse = validImageRequest({ kind: 'audio', target: request.target });

  await assert.rejects(() => f.command('job.reuse', { ...reuse, jobId: job.id, allowTimingChanges: true }, {
    aggregate: { kind: 'generation', id: reuse.subscriberId }
  }), { code: 'INCOMPATIBLE_REUSE' });
});

test('undo restores a subscriber-authorized utterance take and its voice provenance', async t => {
  const { withAudioScene, audioTakeSlot, generationCommand, validImageRequest } = await import('./helpers/project.js');

  const { wav } = await import('./helpers/images.js');

  const f = await withAudioScene(t);

  const first = validImageRequest({
    kind: 'audio',

    target: { kind: 'utterance', id: 'u1' },

    input: {
      model: 'fake-v1',
      prompt: '같은 대사',
      config: {}
    }
  });

  const second = validImageRequest({
    ...first,
    subscriberId: 'second',

    target: { kind: 'utterance', id: 'u2' }
  });

  await generationCommand(f, first);
  await generationCommand(f, second);

  const { runWorker } = await import('../src/engine/worker.js');

  await runWorker({ service: f.service, drain: true });

  const c = (await f.service.snapshot(f.projectId)).candidates[0], slot = audioTakeSlot('take2', 'u2');

  await f.command('candidate.adopt', {
    slotId: slot.id,
    slot,
    candidateId: c.id,
    subscriberId: second.subscriberId,
    actor: 'artist',
    reason: 'select shared take'
  }, {
    aggregate: { kind: 'assetSlot', id: slot.id }
  });

  await assetImport(f, 'replacement', wav(), slot, 'audio');
  const latest = await adopt(f, slot.id, 'replacement');

  const undo = await f.command('adoption.undo', { slotId: slot.id, adoptionId: latest.value.adoptionId, actor: 'artist', reason: 'restore previous take' }, {
    aggregate: { kind: 'assetSlot', id: slot.id }
  });

  const s = await f.service.snapshot(f.projectId);
  assert.equal(undo.value.candidateId, c.id);
  assert.equal(s.adoptions.at(-1).subscriberId, second.subscriberId);
  assert.equal(s.adoptions.at(-1).desiredVoiceBinding.voice, 'shared-voice');
  assert.equal(s.adoptions.at(-1).utteranceId, 'u2');
  assert.equal(s.adoptions.at(-1).takeId, c.id);
});

test(
  'audio receipt separates actual provider config from desired voice and acting without claiming verification',
  async t => {
    const { withAudioScene, audioTakeSlot, generationCommand, validImageRequest } = await import('./helpers/project.js');

    const f = await withAudioScene(t),
          input = {
            model: 'fake-v1',
            prompt: '같은 대사',

            config: { voice: 'other-provider-voice', acting: 'shouting' }
          };

    await generationCommand(f, validImageRequest({
      kind: 'audio',

      target: { kind: 'utterance', id: 'u1' },

      input
    }));

    const { runWorker } = await import('../src/engine/worker.js');

    await runWorker({ service: f.service, drain: true });

    const c = (await f.service.snapshot(f.projectId)).candidates[0], slot = audioTakeSlot('take1', 'u1');

    await f.command('candidate.adopt', { slotId: slot.id, slot, candidateId: c.id, actor: 'artist', reason: 'select for manual review' }, {
      aggregate: { kind: 'assetSlot', id: slot.id }
    });

    const receipt = (await f.service.snapshot(f.projectId)).adoptions[0];
    assert.deepEqual(c.actualAudioInput, input);
    assert.deepEqual(receipt.actualAudioInput, input);
    assert.equal(receipt.desiredVoiceBinding.voice, 'shared-voice');
    assert.equal(receipt.voiceBinding, undefined);
    assert.equal(receipt.voiceVerification, 'not_performed');
    assert.equal(receipt.actingVerification, 'not_performed');
    assert.equal(receipt.speechVerification, 'request_matches_utterance');
    assert.equal(receipt.transcriptionVerification, 'not_performed');
  }
);
