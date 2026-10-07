import { lstat, readFile, unlink } from 'node:fs/promises';
import { join, resolve, basename, isAbsolute } from 'node:path';
import { withProjectLock } from '../core/project-lock.js';
import { loreReadText, loreReadJson, loreWriteText, loreWriteJson, loreSyncDirectory, safeLorePath, loreWriteBytes } from '../core/lore-files.js';
import { hashLore, isLoreRevisionId } from '../../engine/src/lore/registry.js';
import { requireLore } from '../../engine/src/lore/schemas.js';
import { inspectLoreImage, loreBlobId, createLoreAssetRevision, createLoreExpressionProfile, createLoreAssetCatalog, verifyLoreAssetObject, validateLoreAssetLinks } from '../../engine/src/lore/assets.js';
import { UniverseStore } from './universe-store.js';

/**
 * World-level asset catalog with its own HEAD. Bytes are content-addressed and
 * never rewritten; replacing an image makes a child revision, so every older
 * catalog revision and production lock still reads its original file.
 */
export class AssetCatalogStore {
  constructor(rootDir, universeId) {
    this.rootDir = resolve(rootDir); this.universeId = universeId;
    this.base = join(this.rootDir, '.vibelore', 'shared-lore', 'assets');
  }
  path(area, id) { requireLore(isLoreRevisionId(id), 'INVALID_LORE_DATA', `invalid ${area} id`); return join(this.base, area, `${id.slice(7)}${area === 'blobs' ? '' : '.json'}`); }
  async head() {
    const text = await loreReadText(this.rootDir, join(this.base, 'HEAD'));
    requireLore(text === null || isLoreRevisionId(text.trim()), 'LORE_INTEGRITY', 'invalid asset catalog HEAD');
    return text?.trim() ?? null;
  }
  async object(id, kind) {
    const object = await loreReadJson(this.rootDir, this.path('objects', id));
    requireLore(object, 'LORE_REVISION_NOT_FOUND', `${kind} ${id}`);
    requireLore(object.revisionId === id, 'LORE_INTEGRITY', `${kind} object id mismatch`);
    return verifyLoreAssetObject(object, kind);
  }
  async read(revisionId) {
    const head = await this.head(), target = revisionId ?? head;
    if (!target) return { head, catalog: null };
    const catalog = await this.object(target, 'catalog');
    requireLore(catalog.universeId === this.universeId, 'LORE_UNIVERSE_MISMATCH', this.universeId);
    return { head, catalog };
  }
  async readBlob(blobId) {
    const path = this.path('blobs', blobId);
    await safeLorePath(this.rootDir, path);
    let bytes;
    try { bytes = await readFile(path); } catch (error) { if (error.code === 'ENOENT') requireLore(false, 'ASSET_BLOB_MISSING', blobId); throw error; }
    requireLore(loreBlobId(bytes) === blobId, 'LORE_INTEGRITY', `asset blob ${blobId} was modified`);
    return bytes;
  }
  async writeBlob(blobId, bytes) {
    requireLore(loreBlobId(bytes) === blobId, 'LORE_INTEGRITY', 'blob id does not match bytes');
    await loreWriteBytes(this.rootDir, this.path('blobs', blobId), bytes);
  }
  /** Exact closure for a production: catalog revision, chosen asset revisions, optional profile. */
  async closure({ catalogRevisionId, assetIds, expressionProfileId }) {
    const { catalog } = await this.read(catalogRevisionId);
    requireLore(catalog, 'LORE_REVISION_NOT_FOUND', 'asset catalog');
    const assetRevisions = [];
    for (const assetId of assetIds) {
      requireLore(catalog.assets[assetId], 'ASSET_NOT_APPROVED', assetId);
      const asset = await this.object(catalog.assets[assetId], 'asset');
      await this.readBlob(asset.blob.blobId);
      assetRevisions.push(asset);
    }
    const profileRevision = expressionProfileId ? await this.object(catalog.profiles[expressionProfileId] ?? requireLore(false, 'ASSET_NOT_APPROVED', expressionProfileId), 'expression-profile') : null;
    return { revision: catalog, assetRevisions, profileRevision };
  }
  async status() {
    const { head, catalog } = await this.read();
    const pending = await loreReadJson(this.rootDir, join(this.base, 'pending.json'));
    const assets = [];
    for (const [assetId, revisionId] of Object.entries(catalog?.assets ?? {})) {
      const a = await this.object(revisionId, 'asset');
      assets.push({ assetId, revisionId, entityId: a.entityId, stateIds: a.stateIds, label: a.label, blob: a.blob, parentRevisionId: a.parentRevisionId, derivedFrom: a.derivedFrom, expressionProfileId: a.expressionProfileId });
    }
    const profiles = [];
    for (const [profileId, revisionId] of Object.entries(catalog?.profiles ?? {})) { const p = await this.object(revisionId, 'expression-profile'); profiles.push({ profileId, revisionId, label: p.label, style: p.style, palette: p.palette }); }
    return { status: 'ok', head, catalogRevisionId: head, assets, profiles, recoveryPending: Boolean(pending) };
  }

  /** Import candidates. Files are read and verified now; nothing is adopted until decide(approve). */
  async propose({ expectedHead, loreRevisionId, assets = [], profiles = [], reason }) {
    requireLore(typeof reason === 'string' && reason.trim(), 'INVALID_LORE_DATA', 'reason required');
    requireLore(Array.isArray(assets) && Array.isArray(profiles) && assets.length + profiles.length > 0 && assets.length <= 100 && profiles.length <= 100, 'INVALID_LORE_DATA', 'propose 1..100 assets or profiles');
    return withProjectLock(this.rootDir, async () => {
      const { head, catalog } = await this.read();
      requireLore(expectedHead === head, 'STALE_ASSET_CATALOG', 'asset catalog HEAD changed', { expectedHead, currentHead: head });
      const lore = await new UniverseStore(this.rootDir, this.universeId).read(loreRevisionId);
      requireLore(lore.revision, 'LORE_REVISION_NOT_FOUND', 'link assets to an adopted lore revision');
      const profileRevisions = profiles.map(p => createLoreExpressionProfile({ ...p, parentRevisionId: catalog?.profiles[p.profileId] ?? null }));
      const knownProfiles = new Set([...Object.keys(catalog?.profiles ?? {}), ...profileRevisions.map(p => p.profileId)]);
      const assetRevisions = [], files = [];
      for (const input of assets) {
        requireLore(input && typeof input.sourcePath === 'string' && isAbsolute(input.sourcePath), 'INVALID_LORE_DATA', 'asset sourcePath must be an absolute file path');
        const info = await lstat(input.sourcePath).catch(error => { if (error.code === 'ENOENT') requireLore(false, 'ASSET_SOURCE_MISSING', input.sourcePath); throw error; });
        requireLore(info.isFile() && !info.isSymbolicLink(), 'INVALID_ASSET_FILE', 'asset source must be a regular file');
        const bytes = await readFile(input.sourcePath), meta = inspectLoreImage(bytes);
        const { sourcePath, provenanceNote = null, ...fields } = input;
        const revision = createLoreAssetRevision({ ...fields, purpose: fields.purpose ?? 'reference-image', parentRevisionId: catalog?.assets[input.assetId] ?? null, blob: meta,
          provenance: { kind: 'import', sourceName: basename(sourcePath), note: provenanceNote }, linkedLoreRevisionId: lore.publicationId });
        validateLoreAssetLinks({ asset: revision, revision: lore.revision });
        requireLore(!revision.expressionProfileId || knownProfiles.has(revision.expressionProfileId), 'ASSET_NOT_APPROVED', `expression profile ${revision.expressionProfileId}`);
        if (revision.derivedFrom) await this.object(revision.derivedFrom.assetRevisionId, 'asset');
        assetRevisions.push(revision); files.push({ meta, bytes });
      }
      requireLore(new Set(assetRevisions.map(a => a.assetId)).size === assetRevisions.length && new Set(profileRevisions.map(p => p.profileId)).size === profileRevisions.length, 'INVALID_LORE_DATA', 'duplicate asset or profile ID in one proposal');
      createLoreAssetCatalog({ universeId: this.universeId, parent: catalog, assets: assetRevisions, profiles: profileRevisions, proposalId: `sha256:${'0'.repeat(64)}`, reason });
      // Unreferenced candidate bytes are inert: only an approved catalog revision points at them.
      for (const { meta, bytes } of files) await this.writeBlob(meta.blobId, bytes);
      for (const object of [...assetRevisions, ...profileRevisions]) await loreWriteJson(this.rootDir, this.path('objects', object.revisionId), object, { immutable: true });
      const proposal = { schemaVersion: 1, universeId: this.universeId, expectedHead: head, loreRevisionId: lore.publicationId, assetRevisionIds: assetRevisions.map(a => a.revisionId), profileRevisionIds: profileRevisions.map(p => p.revisionId), reason };
      const proposalId = hashLore(proposal);
      await loreWriteJson(this.rootDir, this.path('proposals', proposalId), proposal, { immutable: true });
      return { status: 'awaiting_approval', proposalId, expectedHead: head,
        assets: assetRevisions.map(a => ({ assetId: a.assetId, revisionId: a.revisionId, replaces: a.parentRevisionId, entityId: a.entityId, stateIds: a.stateIds, blob: a.blob, derivedFrom: a.derivedFrom, expressionProfileId: a.expressionProfileId })),
        profiles: profileRevisions.map(p => ({ profileId: p.profileId, revisionId: p.revisionId, replaces: p.parentRevisionId, style: p.style, palette: p.palette })),
        note: 'Approval adopts these files for reference use only; it is not a quality guarantee and never changes world values or existing production locks.' };
    });
  }
  async decide({ proposalId, expectedHead, decision, failAfterHead = false }) {
    requireLore(['approve', 'reject'].includes(decision), 'INVALID_LORE_DATA', 'decision must be approve or reject');
    return withProjectLock(this.rootDir, async () => {
      const proposal = await loreReadJson(this.rootDir, this.path('proposals', proposalId));
      requireLore(proposal && hashLore(proposal) === proposalId, 'LORE_INTEGRITY', 'asset proposal mismatch');
      const prior = await loreReadJson(this.rootDir, this.path('decisions', proposalId));
      const { head, catalog } = await this.read();
      if (prior) {
        requireLore(prior.decision === decision, 'LORE_PROPOSAL_DECIDED', proposalId);
        return { status: decision === 'approve' ? 'adopted' : 'rejected', proposalId, head, catalogRevisionId: prior.catalogRevisionId ?? null, replayed: true };
      }
      // Interrupted after HEAD moved: the published catalog already names this proposal.
      if (catalog?.change.proposalId === proposalId) return this.finish({ proposalId, decision, catalogRevisionId: head });
      if (decision === 'reject') {
        await loreWriteJson(this.rootDir, this.path('decisions', proposalId), { proposalId, decision }, { immutable: true });
        return { status: 'rejected', proposalId, head };
      }
      requireLore(expectedHead === proposal.expectedHead && head === expectedHead, 'STALE_ASSET_CATALOG', 'asset catalog changed after review');
      const assets = [], profiles = [];
      for (const id of proposal.assetRevisionIds) { const a = await this.object(id, 'asset'); await this.readBlob(a.blob.blobId); assets.push(a); }
      for (const id of proposal.profileRevisionIds) profiles.push(await this.object(id, 'expression-profile'));
      const next = createLoreAssetCatalog({ universeId: this.universeId, parent: catalog, assets, profiles, proposalId, reason: proposal.reason });
      await loreWriteJson(this.rootDir, this.path('objects', next.revisionId), next, { immutable: true });
      await loreSyncDirectory(join(this.base, 'objects'));
      await loreWriteJson(this.rootDir, join(this.base, 'pending.json'), { proposalId, expectedHead: head, catalogRevisionId: next.revisionId });
      await loreWriteText(this.rootDir, join(this.base, 'HEAD'), `${next.revisionId}\n`);
      if (failAfterHead) throw new Error('injected asset catalog interruption');
      return this.finish({ proposalId, decision, catalogRevisionId: next.revisionId });
    });
  }
  async finish({ proposalId, decision, catalogRevisionId }) {
    await loreWriteJson(this.rootDir, this.path('decisions', proposalId), { proposalId, decision, catalogRevisionId }, { immutable: true });
    await unlink(join(this.base, 'pending.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return { status: 'adopted', proposalId, head: catalogRevisionId, catalogRevisionId };
  }
  /** Completes or discards an interrupted approval; never invents a decision. */
  async recover() {
    return withProjectLock(this.rootDir, async () => {
      const journal = await loreReadJson(this.rootDir, join(this.base, 'pending.json'));
      if (!journal) return { status: 'clean', head: await this.head() };
      const head = await this.head();
      if (head === journal.catalogRevisionId) return { ...(await this.finish({ proposalId: journal.proposalId, decision: 'approve', catalogRevisionId: head })), status: 'recovered' };
      requireLore(head === journal.expectedHead, 'LORE_INTEGRITY', 'asset catalog HEAD matches neither side of the interrupted approval');
      await unlink(join(this.base, 'pending.json'));
      return { status: 'not_published', head };
    });
  }
}
