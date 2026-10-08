import assert from 'node:assert/strict';
import { it } from 'node:test';
import { resolveCasting } from '../src/engine/casting.js';
import { withStudio } from './helpers/project.js';
const occurrence = { id: 'past1', characterId: 'seoyun', roleBindingId: 'hero', castingStateRef: 'child' };
const project = { id: 'default', scope: 'project', characterId: 'seoyun', state: null, voice: 'adult-v1' };
it('requires an explicit choice for crossing casting scope and state', () => {
  const decisions = [
    { ...project, state: 'child', voice: 'child-v1' },
    {
      id: 'trailer-default',
      scope: 'production',
      productionId: 'trailer',
      characterId: 'seoyun',
      state: null,
      voice: 'adult-v2',
    },
  ];
  assert.equal(resolveCasting({ occurrence, decisions, productionId: 'trailer' }).status, 'unresolved');
  decisions.push({
    id: 'explicit',
    scope: 'production',
    productionId: 'trailer',
    characterId: 'seoyun',
    state: 'child',
    voice: 'chosen',
  });
  assert.equal(resolveCasting({ occurrence, decisions, productionId: 'trailer' }).voice, 'chosen');
});
it('inherits by scope and state, honors occurrence override, and reports equal competitors', () => {
  const child = { ...project, id: 'child', state: 'child', voice: 'child' };
  assert.equal(resolveCasting({ occurrence, decisions: [project, child] }).voice, 'child');
  const override = {
    ...project,
    id: 'override',
    scope: 'occurrence',
    occurrenceId: 'past1',
    sceneId: 'dream',
    productionId: 'trailer',
    voice: 'special',
  };
  assert.equal(
    resolveCasting({ occurrence, decisions: [child, override], sceneId: 'dream', productionId: 'trailer' })
      .voice,
    'special'
  );
  assert.equal(
    resolveCasting({ occurrence, decisions: [child, { ...child, id: 'rival', voice: 'rival' }] }).status,
    'unresolved'
  );
  assert.equal(
    resolveCasting({
      occurrence,
      decisions: [
        child,
        {
          ...project,
          id: 'replace',
          scope: 'production',
          productionId: 'trailer',
          allStates: true,
          voice: 'all',
        },
      ],
      productionId: 'trailer',
    }).voice,
    'all'
  );
});
it('stores 40 roles without name merging and preserves past/dream presentation independently', async (t) => {
  const { command, service } = await withStudio(t);
  await command(
    'story.save',
    {
      id: 'main',
      title: 'Dream',
      text: '원문',
      states: [
        { id: 'past' },
        { id: 'child' },
        { id: 'adult-dream' },
        { id: 'before-letter', knowledge: { unknown: ['letter'], revealScope: 'later' } },
      ],
      revealPolicy: { unknown: ['letter'] },
    },
    { aggregate: { kind: 'story', id: 'main' } }
  );
  await command('production.create', { id: 'trailer', title: 'Trailer', sourcePackageId: null });
  for (let i = 0; i < 40; i++)
    await command(
      'cast.put',
      {
        id: `role${i}`,
        name: '동명이인',
        characterId: `person${i}`,
        identity: { id: `person${i}`, origin: { kind: 'studioLocal' } },
        language: 'ko',
      },
      { aggregate: { kind: 'cast', id: `role${i}` } }
    );
  const scene = {
    id: 'dream',
    productionId: 'trailer',
    occurrences: [
      {
        ...occurrence,
        characterId: 'person0',
        roleBindingId: 'role0',
        temporalStateRef: 'past',
        knowledgeStateRef: 'before-letter',
        presence: 'onscreen',
      },
    ],
    presentations: [
      {
        occurrenceId: 'past1',
        appearanceStateRef: 'adult-dream',
        castingStateRef: 'child',
        knowledgeStateRef: 'before-letter',
      },
    ],
    utterances: [
      { id: 'u1', speakerOccurrenceId: 'past1', addresseeOccurrenceIds: [], text: '편지는 어디 있지?' },
    ],
    shots: [{ id: 's1', targetOccurrenceId: 'past1' }],
  };
  await command('scene.put', scene, { aggregate: { kind: 'scene', id: 'dream' } });
  await command(
    'casting.set',
    {
      id: 'child-voice',
      scope: 'project',
      characterId: 'person0',
      state: 'child',
      voice: 'child-v1',
      language: 'ko',
    },
    { aggregate: { kind: 'casting', id: 'child-voice' } }
  );
  let snapshot = await service.snapshot('p1');
  assert.equal(snapshot.cast.length, 40);
  assert.equal(snapshot.scenes[0].occurrences[0].temporalStateRef, 'past');
  assert.equal(snapshot.resolvedBindings[0].appearanceStateRef, 'adult-dream');
  assert.equal(snapshot.resolvedBindings[0].casting.voice, 'child-v1');
  assert.deepEqual(snapshot.story.revealPolicy, { unknown: ['letter'] });
  const sceneRevision = snapshot.aggregates.find((a) => a.kind === 'scene').revision;
  await command(
    'utterance.update',
    { sceneId: 'dream', id: 'u1', text: '아직 모르겠어.' },
    { aggregate: { kind: 'utterance', id: 'u1' } }
  );
  snapshot = await service.snapshot('p1');
  assert.equal(snapshot.scenes[0].utterances[0].text, '아직 모르겠어.');
  assert.equal(snapshot.aggregates.find((a) => a.kind === 'scene').revision, sceneRevision);
  await assert.rejects(
    command(
      'scene.put',
      { ...scene, shots: [{ id: 's1', targetOccurrenceId: 'missing' }] },
      { aggregate: { kind: 'scene', id: 'dream' } }
    ),
    { code: 'INVALID_REFERENCE' }
  );
  await assert.rejects(
    command(
      'casting.set',
      {
        id: 'bad',
        scope: 'production',
        productionId: 'missing',
        characterId: 'person0',
        state: null,
        voice: 'x',
      },
      { aggregate: { kind: 'casting', id: 'bad' } }
    ),
    { code: 'INVALID_REFERENCE' }
  );
});
it('rejects wrong editable target and broken identity origin', async (t) => {
  const { command } = await withStudio(t);
  await assert.rejects(
    command(
      'cast.put',
      {
        id: 'r',
        name: 'n',
        characterId: 'c',
        identity: { id: 'c', origin: { kind: 'source', packageId: 'missing', canonId: 'hero' } },
        language: 'ko',
      },
      { aggregate: { kind: 'cast', id: 'r' } }
    ),
    { code: 'INVALID_REFERENCE' }
  );
  await assert.rejects(
    command(
      'story.save',
      { id: 's', title: 't', text: 'x', states: [], revealPolicy: {} },
      { aggregate: { kind: 'scene', id: 's' } }
    ),
    { code: 'INVALID_AGGREGATE' }
  );
});
it('keeps one identity across child/adult roles and separate characterless narrator with shared voice', async (t) => {
  const { command, service } = await withStudio(t);
  await command('production.create', { id: 'main', title: 'Main', sourcePackageId: null });
  for (const [id, characterId, identity] of [
    ['child', 'same', { id: 'same', origin: { kind: 'studioLocal' } }],
    ['adult', 'same', null],
    ['narrator', null, null],
  ])
    await command(
      'cast.put',
      { id, name: '같은 이름', language: 'ko', characterId, ...(identity ? { identity } : {}) },
      { aggregate: { kind: 'cast', id } }
    );
  await command(
    'story.save',
    { id: 's', title: 's', text: 's', states: [], revealPolicy: {} },
    { aggregate: { kind: 'story', id: 's' } }
  );
  const occurrences = [
    { id: 'past', characterId: 'same', roleBindingId: 'child', presence: 'onscreen' },
    { id: 'present', characterId: 'same', roleBindingId: 'adult', presence: 'onscreen' },
    { id: 'n', characterId: null, roleBindingId: 'narrator', presence: 'narrator' },
  ];
  await command(
    'scene.put',
    {
      id: 'scene',
      productionId: 'main',
      occurrences,
      presentations: occurrences.map((o) => ({
        occurrenceId: o.id,
        appearanceStateRef: null,
        castingStateRef: null,
        knowledgeStateRef: null,
      })),
      utterances: [
        { id: 'u-child', speakerOccurrenceId: 'past', addresseeOccurrenceIds: ['present'], text: '어른?' },
        { id: 'u-adult', speakerOccurrenceId: 'present', addresseeOccurrenceIds: ['past'], text: '나야.' },
        { id: 'u-n', speakerOccurrenceId: 'n', addresseeOccurrenceIds: [], text: '둘은 같은 사람이다.' },
      ],
      shots: [],
    },
    { aggregate: { kind: 'scene', id: 'scene' } }
  );
  for (const roleId of ['child', 'adult', 'narrator'])
    await command(
      'casting.set',
      { id: `c-${roleId}`, roleId, scope: 'project', state: null, voice: 'shared' },
      { aggregate: { kind: 'casting', id: `c-${roleId}` } }
    );
  await command(
    'casting.set',
    {
      id: 'override',
      roleId: 'adult',
      scope: 'occurrence',
      productionId: 'main',
      sceneId: 'scene',
      occurrenceId: 'present',
      state: null,
      voice: 'fixed',
    },
    { aggregate: { kind: 'casting', id: 'override' } }
  );
  const change = await command(
    'casting.set',
    { id: 'c-adult', roleId: 'adult', scope: 'project', state: null, voice: 'replacement' },
    { aggregate: { kind: 'casting', id: 'c-adult' } }
  );
  assert.deepEqual(change.value.impacts, []);
  await command(
    'utterance.update',
    { id: 'u-child', acting: { delivery: 'hesitant' }, holdMs: 200 },
    { aggregate: { kind: 'utterance', id: 'u-child' } }
  );
  const snapshot = await service.snapshot('p1');
  assert.equal(snapshot.cast.length, 3);
  assert.equal(snapshot.scenes[0].occurrences.length, 3);
  assert.equal(snapshot.scenes[0].utterances[0].holdMs, 200);
  assert.deepEqual(
    snapshot.resolvedBindings.map((b) => b.casting.voice),
    ['shared', 'fixed', 'shared']
  );
  const inherited = await command(
    'casting.set',
    { id: 'c-child', roleId: 'child', scope: 'project', state: null, voice: 'new-child' },
    { aggregate: { kind: 'casting', id: 'c-child' } }
  );
  assert.deepEqual(
    inherited.value.impacts.map((i) => i.utteranceId),
    ['u-child']
  );
});
it('rejects removal of a casting state or occurrence and retains identity on role-only edits', async (t) => {
  const { command, service } = await withStudio(t);
  await command(
    'story.save',
    { id: 's', title: 's', text: 'x', states: [{ id: 'child' }], revealPolicy: {} },
    { aggregate: { kind: 'story', id: 's' } }
  );
  await command('production.create', { id: 'main', title: 'm', sourcePackageId: null });
  await command(
    'cast.put',
    {
      id: 'r',
      name: 'r',
      language: 'ko',
      characterId: 'c',
      identity: { id: 'c', origin: { kind: 'studioLocal' } },
    },
    { aggregate: { kind: 'cast', id: 'r' } }
  );
  await command(
    'cast.put',
    { id: 'r', name: 'new role label', language: 'ko', characterId: 'c' },
    { aggregate: { kind: 'cast', id: 'r' } }
  );
  assert.equal((await service.snapshot('p1')).cast[0].identity.id, 'c');
  const scene = {
    id: 'scene',
    productionId: 'main',
    occurrences: [{ id: 'o', characterId: 'c', roleBindingId: 'r', presence: 'onscreen' }],
    presentations: [
      { occurrenceId: 'o', appearanceStateRef: null, castingStateRef: null, knowledgeStateRef: null },
    ],
    utterances: [],
    shots: [],
  };
  await command('scene.put', scene, { aggregate: { kind: 'scene', id: 'scene' } });
  await command(
    'casting.set',
    {
      id: 'c1',
      scope: 'occurrence',
      productionId: 'main',
      sceneId: 'scene',
      occurrenceId: 'o',
      roleId: 'r',
      state: 'child',
      voice: 'v',
    },
    { aggregate: { kind: 'casting', id: 'c1' } }
  );
  await assert.rejects(
    command(
      'story.save',
      { id: 's', title: 's', text: 'x', states: [], revealPolicy: {} },
      { aggregate: { kind: 'story', id: 's' } }
    ),
    { code: 'INVALID_REFERENCE' }
  );
  await assert.rejects(
    command(
      'scene.put',
      { ...scene, occurrences: [], presentations: [] },
      { aggregate: { kind: 'scene', id: 'scene' } }
    ),
    { code: 'INVALID_REFERENCE' }
  );
});
it('rejects stale scene replacement after utterance edit and accepts refreshed scene content', async (t) => {
  const { command, service } = await withStudio(t);
  await command('production.create', { id: 'main', title: 'm', sourcePackageId: null });
  await command(
    'cast.put',
    { id: 'narrator', name: 'N', language: 'ko', characterId: null },
    { aggregate: { kind: 'cast', id: 'narrator' } }
  );
  const scene = {
    id: 'scene',
    productionId: 'main',
    occurrences: [{ id: 'n', presence: 'narrator', roleBindingId: 'narrator' }],
    presentations: [
      { occurrenceId: 'n', appearanceStateRef: null, castingStateRef: null, knowledgeStateRef: null },
    ],
    utterances: [{ id: 'u', speakerOccurrenceId: 'n', addresseeOccurrenceIds: [], text: 'Old' }],
    shots: [],
  };
  const initial = await command('scene.put', scene, { aggregate: { kind: 'scene', id: 'scene' } });
  await command(
    'utterance.update',
    { id: 'u', text: 'Accepted edit' },
    { aggregate: { kind: 'utterance', id: 'u' } }
  );
  await assert.rejects(
    command(
      'scene.put',
      { ...scene, title: 'stale scene edit' },
      { aggregate: { kind: 'scene', id: 'scene' }, expectedRevision: initial.aggregateRevision }
    ),
    { code: 'INVALID_REFERENCE' }
  );
  const refreshed = (await service.snapshot('p1')).scenes[0];
  assert.equal(refreshed.utterances[0].text, 'Accepted edit');
  await command(
    'scene.put',
    { ...refreshed, title: 'refreshed scene edit' },
    { aggregate: { kind: 'scene', id: 'scene' }, expectedRevision: initial.aggregateRevision }
  );
  assert.equal((await service.snapshot('p1')).scenes[0].utterances[0].text, 'Accepted edit');
});
