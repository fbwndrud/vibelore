import { validateLoreRevision } from '../../engine/src/lore/changes.js';

// Dry-run report for moving an existing work onto a shared world. It only
// reads: no character is merged by name, no prose or note is rewritten, and
// work-owned roles, goals and plans stay with the work.
const read = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function workMigrationReport({ foundation, binding, publication, previews, inventory }) {
  const locals = new Map(foundation.characters.map(c => [c.id, c]));
  const ownership = binding.cast.flatMap(member => member.projections.map(p => ({ localCharacterId: member.localCharacterId, entityId: member.entityId, target: p.target, fieldId: p.fieldId,
    from: 'work', to: 'shared', localValue: read(locals.get(member.localCharacterId), p.target) ?? null })));
  const diff = previews.flatMap(preview => [
    ...preview.projections.map(p => {
      const local = read(locals.get(p.localCharacterId), p.target) ?? null;
      return { chapter: preview.chapter, localCharacterId: p.localCharacterId, target: p.target, local, shared: p.value, change: same(local, p.value) ? 'same' : 'differs' };
    }),
    ...(preview.sceneVarying ?? []).map(v => ({ chapter: preview.chapter, localCharacterId: v.localCharacterId, target: v.target, local: read(locals.get(v.localCharacterId), v.target) ?? null,
      shared: null, change: 'scene_specific' })),
  ]);
  // Same-name characters outside the cast are reported, never merged.
  const nameFields = [...new Set([...binding.cast.flatMap(m => m.projections.filter(p => p.target === 'canonicalName').map(p => p.fieldId)),
    ...publication.registry.definitions.filter(d => d.definition.kind === 'field' && /(^|\.)name$/.test(d.definition.key)).map(d => d.definition.id)])];
  const scope = previews[0]?.scenes[0]?.scope;
  const resolver = validateLoreRevision({ revision: publication.revision, registry: publication.registry }).resolver;
  const sharedNames = [];
  for (const entity of publication.revision.content.entities) for (const fieldId of nameFields) {
    const r = scope ? resolver.resolve({ subjectId: entity.id, fieldId, scope }) : null;
    if (r?.status === 'resolved') sharedNames.push({ entityId: entity.id, name: r.value });
  }
  const bound = new Set(binding.cast.map(m => m.localCharacterId));
  const sameNameCandidates = foundation.characters.filter(c => !bound.has(c.id)).flatMap(c => {
    const matches = sharedNames.filter(s => s.name === c.canonicalName || (c.aliases ?? []).includes(s.name));
    return matches.length ? [{ localCharacterId: c.id, name: c.canonicalName, entityIds: matches.map(m => m.entityId), action: 'not_merged', note: 'Same name is not identity. Add an explicit cast entry if this is the same character.' }] : [];
  });
  const workOwned = binding.cast.map(m => ({ localCharacterId: m.localCharacterId, keeps: Object.keys(locals.get(m.localCharacterId) ?? {}).filter(k => !['id', 'canonicalName', 'intrinsic'].includes(k)) }));
  return { dryRun: true, ownership, diff, differs: diff.filter(d => d.change !== 'same').length, sameNameCandidates, workOwned,
    preservedSources: inventory.map(r => r.path).filter(p => /^(characters|world|chapters)\//.test(p) || p === 'work.md'),
    note: 'Nothing changes until apply. Local sheets and notes are preserved as written; shared values take authority only for the listed targets. Roll back with lore_rollback.' };
}
