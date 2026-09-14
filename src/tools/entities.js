import { foldEntityOps } from '../../engine/src/continuity/entity-ops.js';

/** Apply validated chapter entity ops to persisted snapshots. */
export function applyEntityOps(snapshots, ops, chapter) {
  const byId = new Map(snapshots.map((entity) => [entity.entityId, entity]));
  const folded = foldEntityOps({ snapshots, byId, ops });
  for (const item of folded.toRegister) {
    byId.set(item.entityId, {
      entityId: item.entityId, kind: item.kind, canonicalName: item.name,
      aliases: [], status: 'active', attrs: {}, registeredAtChapter: chapter,
    });
  }
  for (const item of folded.toUpdate) {
    const current = byId.get(item.entityId);
    byId.set(item.entityId, { ...current, attrs: { ...(current.attrs ?? {}), ...item.fields }, updatedAtChapter: chapter });
  }
  for (const item of folded.toRetire) {
    const current = byId.get(item.entityId);
    byId.set(item.entityId, { ...current, status: item.cause === 'destroyed' ? 'destroyed' : 'retired', retiredAtChapter: chapter });
  }
  return { snapshots: [...byId.values()], violations: folded.violations };
}
