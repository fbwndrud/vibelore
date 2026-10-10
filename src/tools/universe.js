import { isAbsolute } from 'node:path';
import { UniverseStore } from '../store/universe-store.js';
import { validateLoreRevision } from '../../engine/src/lore/changes.js';
import { requireLore } from '../../engine/src/lore/schemas.js';
import { inspectWorkBinding, applyWorkBinding, workBindingStatus } from '../core/work-binding.js';

export async function runUniverse(args) {
  const allowed = { status: [], propose: ['expectedHead', 'registryRevisionId', 'content', 'reason'], decide: ['proposalId', 'expectedHead', 'decision'], resolve: ['loreRevisionId', 'query'], documents: ['loreRevisionId', 'documentIds'], recover: [] };
  requireLore(allowed[args.action] && Object.keys(args).every(k => ['action', 'worldRoot', 'universeId', ...allowed[args.action]].includes(k)) && isAbsolute(args.worldRoot ?? ''), 'INVALID_LORE_DATA', 'invalid universe action/input');
  const world = new UniverseStore(args.worldRoot, args.universeId);
  switch (args.action) {
    case 'status': {
      const current = await world.status();
      return { status: 'ok', head: current.head, loreRevisionId: current.head, contentRevisionId: current.revision?.revisionId ?? null,
        registryRevisionId: current.registry?.revisionId ?? null, drift: current.drift,
        counts: current.revision ? Object.fromEntries(['entities', 'states', 'documents', 'values'].map(k => [k, current.revision.content[k].length])) : null };
    }
    case 'propose': requireLore(Object.hasOwn(args, 'expectedHead'), 'INVALID_LORE_DATA', 'expectedHead required'); return world.propose(args);
    case 'decide': return world.decide({ proposalId: args.proposalId, expectedHead: args.expectedHead, action: args.decision });
    case 'recover': return world.recover();
    case 'documents': {
      requireLore(args.loreRevisionId, 'INVALID_LORE_DATA', 'pin loreRevisionId');
      const { revision, registry } = await world.read(args.loreRevisionId);
      requireLore(revision, 'LORE_REVISION_NOT_FOUND', args.loreRevisionId);
      requireLore(args.documentIds === undefined || Array.isArray(args.documentIds) && args.documentIds.length <= 100
        && new Set(args.documentIds).size === args.documentIds.length && args.documentIds.every(id => revision.content.documents.some(d => d.id === id)),
      'LORE_DOCUMENT_MISSING', 'select existing document IDs');
      const ownerOf = id => revision.content.worldDocumentIds.includes(id) ? { kind: 'world' }
        : revision.content.entities.find(e => e.documentIds.includes(id)) ? { kind: 'profile', entityId: revision.content.entities.find(e => e.documentIds.includes(id)).id }
        : revision.content.states.find(s => s.documentIds.includes(id)) ? { kind: 'state', ...revision.content.states.find(s => s.documentIds.includes(id)) } : { kind: 'unassigned' };
      return { loreRevisionId: args.loreRevisionId, registryRevisionId: registry.revisionId,
        documents: revision.content.documents.filter(d => args.documentIds === undefined || args.documentIds.includes(d.id))
          .map(d => ({ id: d.id, path: d.path, visibility: d.visibility, owner: ownerOf(d.id), bytes: Buffer.byteLength(d.text), ...(args.documentIds === undefined ? {} : { text: d.text }) })) };
    }
    case 'resolve': {
      requireLore(args.loreRevisionId && args.query, 'INVALID_LORE_DATA', 'pin loreRevisionId and query');
      const { revision, registry } = await world.read(args.loreRevisionId);
      return { loreRevisionId: args.loreRevisionId, ...validateLoreRevision({ revision, registry }).resolver.resolve(args.query) };
    }
  }
}
export async function runBinding({ store, args }) {
  const allowed = { status: [], inspect: ['worldRoot', 'binding'], apply: ['proposalId', 'expectedHead'] };
  requireLore(allowed[args.action] && Object.keys(args).every(k => ['action', 'project', 'workId', ...allowed[args.action]].includes(k)), 'INVALID_LORE_DATA', 'invalid binding action/input');
  switch (args.action) {
    case 'status': return workBindingStatus({ store, workId: args.workId });
    case 'inspect': return inspectWorkBinding({ store, workId: args.workId, worldRoot: args.worldRoot, binding: args.binding });
    case 'apply': return applyWorkBinding({ store, workId: args.workId, proposalId: args.proposalId, expectedHead: args.expectedHead });
  }
}
