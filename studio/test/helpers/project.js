import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStudio } from '../../src/engine/index.js';

export async function withStudio(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lore-studio-'));
  const service = await openStudio({ ...options, directory });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const projectId = 'p1';
  await service.command({
    projectId,
    commandId: 'create-project',
    aggregate: { kind: 'project', id: projectId },
    expectedRevision: 0,
    type: 'project.create',
    payload: { title: '작품', language: 'ko', budgetMicros: 1000000 }
  });
  return {
    directory,
    service,
    projectId,
    async command(type, payload, overrides = {}) {
      const aggregate =
        overrides.aggregate ??
        (type === 'production.create'
          ? { kind: 'production', id: payload.id }
          : { kind: 'project', id: projectId });
      const snapshot = await service.snapshot(projectId);
      const expectedRevision =
        snapshot.aggregates.find((a) => a.kind === aggregate.kind && a.id === aggregate.id)
          ?.revision ?? 0;
      return service.command({
        projectId,
        commandId: randomUUID(),
        aggregate,
        expectedRevision,
        type,
        payload,
        ...overrides
      });
    }
  };
}

export async function withGeneration(t, options = {}) {
  const f = await withStudio(t, options);
  await f.command('production.create', {
    id: 'main',
    title: 'Main',
    sourcePackageId: null
  });
  await f.command(
    'scene.put',
    {
      id: 'scene',
      productionId: 'main',
      occurrences: [],
      presentations: [],
      utterances: [],
      shots: [{ id: 'shot' }, { id: 'shot2' }]
    },
    { aggregate: { kind: 'scene', id: 'scene' } }
  );
  return f;
}
export function validImageRequest(overrides = {}) {
  return {
    subscriberId: randomUUID(),
    target: { kind: 'shot', id: 'shot' },
    provider: 'fake',
    kind: 'image',
    context: {
      accountId: 'local',
      policyRevision: 'policy1',
      authorizationRevision: 'auth1',
      sourceVisibility: 'selected'
    },
    input: { model: 'fake-v1', prompt: 'A quiet blue room', config: {} },
    recipe: { operation: 'generate' },
    estimateMicros: 100000,
    intent: 'reuse_or_generate',
    ...overrides
  };
}
export function generationCommand(f, payload = validImageRequest(), overrides = {}) {
  return f.command('generation.request', payload, {
    aggregate: { kind: 'generation', id: payload.subscriberId },
    ...overrides
  });
}

// A crash after raw persistence, before decoder completion. No provider is invoked.
export async function retainPendingOutput(f, bytes, mime = 'image/png', attemptIndex = 0) {
  const { getAttempt, getJob, saveAttempt, saveJob } = await import('../../src/engine/jobs.js');

  const { holdUnknown } = await import('../../src/engine/budget.js');

  const raw = await f.service.blobs.put(f.projectId, bytes);
  const id = (await f.service.snapshot(f.projectId)).attempts[attemptIndex].id;

  return f.service.store.write(() => {
    const a = getAttempt(f.service.store, f.projectId, id);

    Object.assign(a, {
      status: 'succeeded',

      outputs: [{ ...raw, mime }]
    });

    saveAttempt(f.service.store, f.projectId, a);
    const job = getJob(f.service.store, f.projectId, a.jobId);
    job.status = 'pending_validation';
    saveJob(f.service.store, f.projectId, job);
    f.service.store.run('UPDATE generation_outbox SET status=\'done\' WHERE project_id=? AND attempt_id=?', f.projectId, id);
    holdUnknown(f.service.store, f.projectId, id);
    return a;
  });
}

export async function withAudioScene(t) {
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ['audio'], models: ['fake-v1'] }),

        generate: async () => {
          const { wav } = await import('./images.js');

          return {
            outputs: [{ bytes: wav(), mime: 'audio/wav' }]
          };
        }
      }
    }
  });

  await f.command('story.save', {
    id: 'story',
    title: 'Story',
    text: 'body',

    states: [{ id: 'adult' }, { id: 'childvoice' }, { id: 'eventtime' }, { id: 'knowledge' }],

    revealPolicy: {}
  }, {
    aggregate: { kind: 'story', id: 'story' }
  });

  await f.command('cast.put', {
    id: 'actor',
    name: 'Actor',
    language: 'ko',
    characterId: 'char',

    identity: {
      id: 'char',

      origin: { kind: 'studioLocal' }
    }
  }, {
    aggregate: { kind: 'cast', id: 'actor' }
  });

  await f.command('cast.put', { id: 'narrator', name: 'Narrator', language: 'ko', characterId: null }, {
    aggregate: { kind: 'cast', id: 'narrator' }
  });

  const scene = (await f.service.snapshot(f.projectId)).scenes[0];

  scene.occurrences = [{
    id: 'speaker',
    roleBindingId: 'actor',
    characterId: 'char',
    presence: 'offscreen',
    temporalStateRef: 'eventtime',
    knowledgeStateRef: 'knowledge'
  }, { id: 'narration', roleBindingId: 'narrator', characterId: null, presence: 'narrator' }];

  scene.presentations = [{ occurrenceId: 'speaker', appearanceStateRef: 'adult', castingStateRef: 'childvoice', knowledgeStateRef: 'knowledge' }, { occurrenceId: 'narration', appearanceStateRef: null, castingStateRef: null, knowledgeStateRef: null }];

  scene.utterances = [{
    id: 'u1',
    speakerOccurrenceId: 'speaker',
    addresseeOccurrenceIds: [],
    text: '같은 대사',

    acting: { tone: 'quiet' }
  }, {
    id: 'u2',
    speakerOccurrenceId: 'speaker',
    addresseeOccurrenceIds: [],
    text: '같은 대사',

    acting: { tone: 'quiet' }
  }, { id: 'uN', speakerOccurrenceId: 'narration', addresseeOccurrenceIds: [], text: '해설' }];

  await f.command('scene.put', scene, {
    aggregate: { kind: 'scene', id: scene.id }
  });

  await f.command('casting.set', { id: 'childcast', scope: 'project', roleId: 'actor', state: 'childvoice', voice: 'shared-voice' }, {
    aggregate: { kind: 'casting', id: 'childcast' }
  });

  await f.command('casting.set', { id: 'narratorcast', scope: 'project', roleId: 'narrator', state: null, voice: 'shared-voice' }, {
    aggregate: { kind: 'casting', id: 'narratorcast' }
  });

  return f;
}
export function audioTakeSlot(id,utteranceId,role='actor',castingStateRef='childvoice',scope={kind:'scene',id:'scene'}) {
  return {id,scope,subject:{kind:'role',id:role},appearanceStateRef:null,castingStateRef,utteranceId};
}
