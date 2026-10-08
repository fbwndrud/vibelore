import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStudio } from '../../src/engine/index.js';

export async function withStudio(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lore-studio-'));
  const service = await openStudio({ ...options, directory });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const projectId = 'p1';
  await service.command({ projectId, commandId: 'create-project', aggregate: { kind: 'project', id: projectId }, expectedRevision: 0,
    type: 'project.create', payload: { title: '작품', language: 'ko', budgetMicros: 1000000 } });
  return { directory, service, projectId, async command(type, payload, overrides = {}) {
    const aggregate = overrides.aggregate ?? (type === 'production.create' ? { kind: 'production', id: payload.id } : { kind: 'project', id: projectId });
    const snapshot = await service.snapshot(projectId);
    const expectedRevision = snapshot.aggregates.find(a => a.kind === aggregate.kind && a.id === aggregate.id)?.revision ?? 0;
    return service.command({ projectId, commandId: randomUUID(), aggregate, expectedRevision, type, payload, ...overrides });
  } };
}
