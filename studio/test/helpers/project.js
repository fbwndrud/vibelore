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
