import { join, resolve } from 'node:path';
import { withProjectLock } from '../core/project-lock.js';
import { LoreRegistryStore } from './lore-registry-store.js';
import { createLoreRevision, validateLoreRevision } from '../../engine/src/lore/changes.js';
import { hashLore, isLoreRevisionId } from '../../engine/src/lore/registry.js';
import { requireLore } from '../../engine/src/lore/schemas.js';
import { loreReadText, loreReadJson, loreWriteText, loreWriteJson, loreDocumentPath, loreSourceFingerprint, loreSyncDirectory } from '../core/lore-files.js';

export class UniverseStore {
  constructor(rootDir, universeId) {
    this.rootDir = resolve(rootDir); this.universeId = universeId;
    this.registryStore = new LoreRegistryStore(this.rootDir, universeId);
    this.base = join(this.rootDir, '.vibelore', 'shared-lore', 'lore');
  }
  path(area, revisionId) {
    requireLore(isLoreRevisionId(revisionId), 'INVALID_LORE_DATA', 'invalid lore/proposal revision');
    return join(this.base, area, `${revisionId.slice(7)}.json`);
  }
  async head() {
    const text = await loreReadText(this.rootDir, join(this.base, 'HEAD'));
    requireLore(text === null || isLoreRevisionId(text.trim()), 'LORE_INTEGRITY', 'invalid lore HEAD');
    return text?.trim() ?? null;
  }
  async read(revisionId) {
    const head = await this.head(), target = revisionId ?? head;
    if (target === null) return { head, revision: null, registry: null };
    const stored = await loreReadJson(this.rootDir, this.path('objects', target));
    requireLore(stored && hashLore(stored) === target, 'LORE_INTEGRITY', 'missing or corrupt sealed lore object');
    const revision = stored.revision;
    requireLore(revision.universeId === this.universeId, 'LORE_UNIVERSE_MISMATCH', this.universeId);
    const { registry } = await this.registryStore.read(revision.registryRevisionId);
    validateLoreRevision({ revision, registry });
    requireLore(stored.sourceFingerprint?.digest === hashLore(stored.sourceFingerprint.inventory), 'LORE_INTEGRITY', 'source fingerprint mismatch');
    return { head, publicationId: target, revision, registry, manifest: stored, sourceFingerprint: stored.sourceFingerprint, materialization: stored.materialization, proposalId: stored.proposalId };
  }
  async status() {
    const current = await this.read();
    const actual = await loreSourceFingerprint(this.rootDir);
    const expected = current.sourceFingerprint;
    return { ...current, drift: !expected || expected.digest === actual.digest ? { status: 'clean', changed: [] } : {
      status: 'modified', changed: [...new Set([...expected.inventory.map(d => d.path), ...actual.inventory.map(d => d.path)])].filter(path => expected.inventory.find(d => d.path === path)?.digest !== actual.inventory.find(d => d.path === path)?.digest),
    } };
  }
  async propose({ expectedHead, registryRevisionId, content, reason }) {
    return withProjectLock(this.rootDir, async () => {
      const current = await this.read();
      requireLore(expectedHead === current.head, 'STALE_LORE_HEAD', 'lore HEAD changed');
      const { registry } = await this.registryStore.read(registryRevisionId);
      requireLore(registryRevisionId === registry.revisionId, 'INVALID_DEFINITION_REFERENCE', 'pin registryRevisionId');
      for (const doc of content.documents ?? []) loreDocumentPath(doc.path);
      const revision = createLoreRevision({ universeId: this.universeId, parentRevisionId: current.head, registry, content, reason });
      // Source deletion is deliberately explicit; preserve previously adopted source paths.
      requireLore((current.revision?.content.documents ?? []).every(d => content.documents.some(next => next.path === d.path)), 'LORE_SOURCE_REMOVAL_REQUIRED', 'keep prior documents (author-only if retired)');
      const fingerprint = await loreSourceFingerprint(this.rootDir), before = [];
      for (const doc of content.documents) before.push({ path: doc.path, text: await loreReadText(this.rootDir, join(this.rootDir, doc.path)) });
      const proposal = { schemaVersion: 1, expectedHead, revision, sourceDigest: fingerprint.digest, before };
      const proposalId = hashLore(proposal);
      await loreWriteJson(this.rootDir, this.path('proposals', proposalId), proposal, { immutable: true });
      return { status: 'awaiting_approval', proposalId, expectedHead, contentRevisionId: revision.revisionId,
        registryRevisionId, reason, counts: { entities: content.entities.length, states: content.states.length, values: content.values.length },
        changedDocuments: content.documents.filter(d => before.find(p => p.path === d.path)?.text !== d.text).map(d => ({ id: d.id, path: d.path, before: before.find(p => p.path === d.path)?.text, after: d.text })),
        impact: current.head ? 'referencing works keep their pinned revision; adoption requires binding review' : 'initial lore publication', revision };
    });
  }
  async materialize(publication) {
    const { revision, materialization } = publication;
    // Check every destination before writing any file. Recovery accepts old or already applied bytes.
    for (const doc of revision.content.documents) {
      loreDocumentPath(doc.path);
      const current = await loreReadText(this.rootDir, join(this.rootDir, doc.path)), old = materialization.before.find(p => p.path === doc.path)?.text;
      requireLore(current === old || current === doc.text, 'SHARED_LORE_SOURCE_DRIFT', doc.path);
    }
    for (const doc of revision.content.documents) await loreWriteText(this.rootDir, join(this.rootDir, doc.path), doc.text);
  }
  async decide({ proposalId, action, expectedHead, failAfterHead = false }) {
    return withProjectLock(this.rootDir, async () => {
      const proposal = await loreReadJson(this.rootDir, this.path('proposals', proposalId));
      requireLore(proposal && hashLore(proposal) === proposalId, 'LORE_INTEGRITY', 'proposal mismatch');
      requireLore(['approve', 'reject'].includes(action), 'INVALID_LORE_DATA', 'invalid decision');
      const priorDecision = await loreReadJson(this.rootDir, this.path('decisions', proposalId));
      requireLore(!priorDecision || priorDecision.action === action && action === 'reject', 'LORE_PROPOSAL_DECIDED', proposalId);
      const existing = await this.read();
      requireLore(existing.proposalId !== proposalId || action === 'approve', 'LORE_PROPOSAL_DECIDED', 'published proposal cannot be rejected');
      if (action === 'reject') {
        await loreWriteJson(this.rootDir, this.path('decisions', proposalId), { proposalId, action }, { immutable: true });
        return { status: 'rejected', proposalId };
      }
      if (existing.proposalId === proposalId) {
        await this.materialize(existing);
        await loreWriteJson(this.rootDir, this.path('decisions', proposalId), { proposalId, action, publicationId: existing.head }, { immutable: true });
        return { status: 'adopted', head: existing.head, loreRevisionId: existing.head, contentRevisionId: existing.revision.revisionId, registryRevisionId: existing.registry.revisionId };
      }
      requireLore(expectedHead === proposal.expectedHead && await this.head() === expectedHead, 'STALE_LORE_HEAD', 'proposal is stale');
      requireLore((await loreSourceFingerprint(this.rootDir)).digest === proposal.sourceDigest, 'SHARED_LORE_SOURCE_DRIFT', 'source changed after proposal');
      const { registry } = await this.registryStore.read(proposal.revision.registryRevisionId);
      validateLoreRevision({ registry, revision: proposal.revision });
      const inventory = (await loreSourceFingerprint(this.rootDir)).inventory.filter(d => !proposal.revision.content.documents.some(doc => doc.path === d.path));
      inventory.push(...proposal.revision.content.documents.map(doc => ({ path: doc.path, digest: hashLore(doc.text) })));
      inventory.sort((a, b) => a.path.localeCompare(b.path));
      const publication = { revision: proposal.revision, sourceFingerprint: { digest: hashLore(inventory), inventory }, materialization: { before: proposal.before }, proposalId };
      const publicationId = hashLore(publication);
      await loreWriteJson(this.rootDir, this.path('objects', publicationId), publication, { immutable: true });
      await loreSyncDirectory(join(this.rootDir, '.vibelore', 'shared-lore'));
      await loreWriteText(this.rootDir, join(this.base, 'HEAD'), `${publicationId}\n`);
      if (failAfterHead) throw new Error('injected lore materialization interruption');
      await this.materialize(publication);
      await loreWriteJson(this.rootDir, this.path('decisions', proposalId), { proposalId, action, publicationId }, { immutable: true });
      return { status: 'adopted', head: publicationId, loreRevisionId: publicationId, contentRevisionId: proposal.revision.revisionId, registryRevisionId: registry.revisionId };
    });
  }
  async recover() {
    return withProjectLock(this.rootDir, async () => {
      const current = await this.read(); requireLore(current.revision, 'LORE_REVISION_NOT_FOUND', 'no published lore');
      await this.materialize(current);
      return { status: 'recovered', head: current.head, drift: (await this.status()).drift };
    });
  }
}
