import assert from 'node:assert/strict';
import { it } from 'node:test';
import { makeSourcePackage } from '../src/source/source-package.js';
import { withStudio } from './helpers/project.js';
const make = (revision, revealPolicy) =>
  makeSourcePackage({
    sourceKind: 'studio-script',
    sourceRevision: revision,
    textUnits: [{ id: 'u1', text: 'Same model input' }],
    sceneScopes: [],
    sourceIdentityMap: [],
    revealPolicy,
    blobManifest: [],
    preservationStatus: { actualSourceBytes: 'complete' },
  });
it('holds rebase decisions when bytes match but source meaning changes and preserves old packages', async (t) => {
  const { command, service } = await withStudio(t);
  const old = make('v1', { unknown: ['letter'] }),
    next = make('v2', { unknown: ['letter', 'sender'] });
  for (const pkg of [old, next])
    await command(
      'source.import',
      { package: pkg, blobs: [] },
      { aggregate: { kind: 'sourcePackage', id: pkg.id } }
    );
  await command('production.create', { id: 'main', title: 'Main', sourcePackageId: old.id });
  await command(
    'scene.put',
    {
      id: 'scene',
      productionId: 'main',
      sourcePackageId: old.id,
      sourceUnitIds: ['u1'],
      occurrences: [],
      presentations: [],
      utterances: [],
      shots: [],
    },
    { aggregate: { kind: 'scene', id: 'scene' } }
  );
  const pending = await command(
    'source.rebase',
    { productionId: 'main', sourcePackageId: next.id, actor: 'user', reason: 'reveal change' },
    { aggregate: { kind: 'sourceBinding', id: 'main' } }
  );
  assert.equal(pending.value.status, 'pending');
  assert.equal(pending.value.diff.inputBytesEqual, true);
  assert.equal(pending.value.diff.semanticValidity, 'needs_review');
  assert.equal(pending.value.impacts[0].sceneId, 'scene');
  let snapshot = await service.snapshot('p1');
  assert.equal(snapshot.productions[0].sourcePackageId, old.id);
  assert.equal(snapshot.sourcePackages.length, 2);
  assert.equal(snapshot.sourceChanges.length, 1);
  await command(
    'source.rebase',
    {
      productionId: 'main',
      decisionId: pending.value.id,
      action: 'keep_existing',
      actor: 'user',
      reason: 'finish original edition',
    },
    { aggregate: { kind: 'sourceBinding', id: 'main' } }
  );
  snapshot = await service.snapshot('p1');
  assert.equal(snapshot.productions[0].sourcePackageId, old.id);
  assert.equal(snapshot.sourceChanges[0].status, 'kept_existing');
});
it('requires explicit per-scene choices before changing a source binding', async (t) => {
  const { command, service } = await withStudio(t);
  const old = make('v1', {}),
    next = make('v2', {});
  for (const pkg of [old, next])
    await command(
      'source.import',
      { package: pkg, blobs: [] },
      { aggregate: { kind: 'sourcePackage', id: pkg.id } }
    );
  await command('production.create', { id: 'main', title: 'Main', sourcePackageId: old.id });
  await command(
    'scene.put',
    {
      id: 'scene',
      productionId: 'main',
      sourcePackageId: old.id,
      sourceUnitIds: ['u1'],
      occurrences: [],
      presentations: [],
      utterances: [],
      shots: [],
    },
    { aggregate: { kind: 'scene', id: 'scene' } }
  );
  const pending = await command(
    'source.rebase',
    { productionId: 'main', sourcePackageId: next.id, actor: 'user', reason: 'revision' },
    { aggregate: { kind: 'sourceBinding', id: 'main' } }
  );
  await assert.rejects(
    command(
      'source.rebase',
      { productionId: 'main', decisionId: pending.value.id, action: 'apply', actor: 'user', reason: 'ok' },
      { aggregate: { kind: 'sourceBinding', id: 'main' } }
    ),
    { code: 'REBASE_UNRESOLVED' }
  );
  await command(
    'source.rebase',
    {
      productionId: 'main',
      decisionId: pending.value.id,
      action: 'apply',
      choices: [{ sceneId: 'scene', action: 'replan' }],
      actor: 'user',
      reason: 'ok',
    },
    { aggregate: { kind: 'sourceBinding', id: 'main' } }
  );
  const snapshot = await service.snapshot('p1');
  assert.equal(snapshot.productions[0].sourcePackageId, next.id);
  assert.equal(snapshot.scenes[0].sourcePackageId, old.id);
  assert.equal(snapshot.sourceChanges[0].status, 'applied');
});
it('rejects applying a rebase after an affected scene changes', async (t) => {
  const { command } = await withStudio(t);
  const old = make('v1', {}),
    next = make('v2', {});
  for (const pkg of [old, next])
    await command(
      'source.import',
      { package: pkg, blobs: [] },
      { aggregate: { kind: 'sourcePackage', id: pkg.id } }
    );
  await command('production.create', { id: 'main', title: 'Main', sourcePackageId: old.id });
  const scene = {
    id: 'scene',
    productionId: 'main',
    sourcePackageId: old.id,
    sourceUnitIds: ['u1'],
    occurrences: [],
    presentations: [],
    utterances: [],
    shots: [],
  };
  await command('scene.put', scene, { aggregate: { kind: 'scene', id: 'scene' } });
  const pending = await command(
    'source.rebase',
    { productionId: 'main', sourcePackageId: next.id, actor: 'user', reason: 'revision' },
    { aggregate: { kind: 'sourceBinding', id: 'main' } }
  );
  await command('scene.put', { ...scene, title: 'changed' }, { aggregate: { kind: 'scene', id: 'scene' } });
  await assert.rejects(
    command(
      'source.rebase',
      {
        productionId: 'main',
        decisionId: pending.value.id,
        action: 'apply',
        choices: [{ sceneId: 'scene', action: 'replan' }],
        actor: 'user',
        reason: 'ok',
      },
      { aggregate: { kind: 'sourceBinding', id: 'main' } }
    ),
    { code: 'REVISION_CONFLICT' }
  );
});
it('invalidates source review when an independently edited utterance changes', async (t) => {
  const { command } = await withStudio(t);
  const old = make('v1', {}),
    next = make('v2', {});
  for (const pkg of [old, next])
    await command(
      'source.import',
      { package: pkg, blobs: [] },
      { aggregate: { kind: 'sourcePackage', id: pkg.id } }
    );
  await command('production.create', { id: 'main', title: 'Main', sourcePackageId: old.id });
  await command(
    'cast.put',
    { id: 'narrator', name: 'Narrator', language: 'ko', characterId: null },
    { aggregate: { kind: 'cast', id: 'narrator' } }
  );
  await command(
    'scene.put',
    {
      id: 'scene',
      productionId: 'main',
      occurrences: [{ id: 'o', presence: 'narrator', roleBindingId: 'narrator' }],
      presentations: [
        { occurrenceId: 'o', appearanceStateRef: null, castingStateRef: null, knowledgeStateRef: null },
      ],
      utterances: [{ id: 'u', speakerOccurrenceId: 'o', addresseeOccurrenceIds: [], text: 'Original' }],
      shots: [],
    },
    { aggregate: { kind: 'scene', id: 'scene' } }
  );
  const pending = await command(
    'source.rebase',
    { productionId: 'main', sourcePackageId: next.id, actor: 'user', reason: 'change' },
    { aggregate: { kind: 'sourceBinding', id: 'main' } }
  );
  await command(
    'utterance.update',
    { id: 'u', text: 'Changed' },
    { aggregate: { kind: 'utterance', id: 'u' } }
  );
  await assert.rejects(
    command(
      'source.rebase',
      {
        productionId: 'main',
        decisionId: pending.value.id,
        action: 'apply',
        actor: 'user',
        reason: 'ok',
        choices: [{ sceneId: 'scene', action: 'replan' }],
      },
      { aggregate: { kind: 'sourceBinding', id: 'main' } }
    ),
    { code: 'REVISION_CONFLICT' }
  );
});
