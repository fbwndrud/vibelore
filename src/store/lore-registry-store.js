import { mkdir, lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withProjectLock } from '../core/project-lock.js';
import { createLoreRegistry, compileLoreRegistry, addLoreDefinitions, encodeLore, hashLore, isLoreRevisionId } from '../../engine/src/lore/registry.js';
import { requireLore } from '../../engine/src/lore/schemas.js';
import { planLoreDefinitionNeeds } from '../../engine/src/lore/extend.js';

async function noSymlink(path) {
  try { requireLore(!(await lstat(path)).isSymbolicLink(), 'UNSAFE_LORE_PATH', path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function readText(path) {
  await noSymlink(path);
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}

/** Independent world-root registry. Objects become visible only through a durable CAS HEAD. */
export class LoreRegistryStore {
  constructor(rootDir, universeId) {
    requireLore(typeof rootDir === 'string' && rootDir.length > 0, 'INVALID_LORE_DATA', 'registry root required');
    this.rootDir = resolve(rootDir); this.universeId = createLoreRegistry(universeId).universeId;
    this.base = join(this.rootDir, '.vibelore', 'shared-lore', 'registry');
    this.objects = join(this.base, 'objects'); this.headPath = join(this.base, 'HEAD');
  }
  async safePaths() {
    for (const path of [this.rootDir, join(this.rootDir, '.vibelore'), join(this.rootDir, '.vibelore', 'shared-lore'), this.base, this.objects]) await noSymlink(path);
  }
  async head() {
    await this.safePaths();
    const text = await readText(this.headPath);
    if (text === null) return null;
    const revisionId = text.trim();
    requireLore(isLoreRevisionId(revisionId), 'LORE_INTEGRITY', 'invalid registry HEAD');
    return revisionId;
  }
  objectPath(revisionId) {
    requireLore(isLoreRevisionId(revisionId), 'INVALID_LORE_DATA', 'invalid revision ID');
    return join(this.objects, `${revisionId.slice(7)}.json`);
  }
  async readObject(revisionId) {
    const text = await readText(this.objectPath(revisionId));
    requireLore(text !== null, 'LORE_REVISION_NOT_FOUND', revisionId);
    try { return JSON.parse(text); } catch { requireLore(false, 'LORE_INTEGRITY', `invalid object ${revisionId}`); }
  }
  async read(revisionId) {
    await this.safePaths();
    const head = await this.head();
    const target = revisionId ?? head;
    if (target === null) return { head, registry: createLoreRegistry(this.universeId) };
    const object = await this.readObject(target);
    requireLore(object.objectKind === 'registry' && Array.isArray(object.registry?.definitions), 'LORE_INTEGRITY', 'not a registry object');
    const definitions = [];
    for (const definitionRevisionId of object.registry.definitions) {
      const document = await this.readObject(definitionRevisionId);
      requireLore(document.objectKind === 'definition' && hashLore(document.definition) === definitionRevisionId, 'LORE_INTEGRITY', 'definition object mismatch');
      definitions.push({ revisionId: definitionRevisionId, definition: document.definition });
    }
    requireLore(!Object.hasOwn(object.registry, 'revisionId'), 'LORE_INTEGRITY', 'registry payload contains a revision ID');
    const registry = { ...object.registry, revisionId: target, definitions };
    requireLore(registry.universeId === this.universeId, 'LORE_UNIVERSE_MISMATCH', this.universeId);
    compileLoreRegistry(registry);
    return { head, registry };
  }
  async writeObject(revisionId, object) {
    const path = this.objectPath(revisionId), text = encodeLore(object);
    await noSymlink(path);
    const existing = await readText(path);
    if (existing !== null) { requireLore(existing === text, 'LORE_INTEGRITY', 'immutable object differs'); return; }
    // A crash leaves only an unreachable temporary file, never a partial immutable object.
    const temporary = `${path}.tmp-${randomUUID()}`, handle = await open(temporary, 'wx');
    try {
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async register({ expectedHead, definitions, reason }) {
    requireLore(expectedHead === null || isLoreRevisionId(expectedHead), 'INVALID_LORE_DATA', 'expectedHead must be null or a revision ID');
    await this.safePaths();
    return withProjectLock(this.rootDir, async () => {
      const { head, registry } = await this.read();
      requireLore(head === expectedHead, 'STALE_LORE_HEAD', 'registry changed; search and retry against current HEAD', { expectedHead, currentHead: head });
      return this.publishAdditions({ head, registry, definitions, reason });
    });
  }
  operationPath(operationId) {
    requireLore(typeof operationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(operationId), 'INVALID_LORE_DATA', 'operationId must be 8..120 safe characters');
    return join(this.base, 'operations', `${hashLore(operationId).slice(7)}.json`);
  }
  /**
   * AI extension: search, reuse, then add only non-destructive definitions.
   * The same operationId replays its first result, so a resumed or retried
   * host call cannot register twice or silently pin a different revision.
   */
  async ensure({ needs, reason, operationId, expectedHead }) {
    requireLore(expectedHead === undefined || expectedHead === null || isLoreRevisionId(expectedHead), 'INVALID_LORE_DATA', 'expectedHead must be null or a revision ID');
    await this.safePaths();
    return withProjectLock(this.rootDir, async () => {
      const requestDigest = hashLore({ needs, reason, expectedHead: expectedHead ?? null });
      const opPath = operationId ? this.operationPath(operationId) : null;
      const prior = opPath ? await readText(opPath) : null;
      if (prior !== null) {
        const record = JSON.parse(prior);
        requireLore(record.requestDigest === requestDigest, 'OPERATION_CONFLICT', 'operationId was already used for a different request');
        return { ...record.result, replayed: true };
      }
      const { head, registry } = await this.read();
      requireLore(expectedHead === undefined || head === expectedHead, 'STALE_LORE_HEAD', 'registry changed; search and retry against current HEAD', { expectedHead, currentHead: head });
      const plan = planLoreDefinitionNeeds(registry, needs);
      let published = { head, registry };
      if (plan.additions.length) published = await this.publishAdditions({ head, registry, definitions: plan.additions, reason });
      const migrationIds = [];
      for (const outcome of plan.outcomes.filter(o => o.outcome === 'migration_required')) {
        const candidate = { schemaVersion: 1, registryRevisionId: published.registry.revisionId, definitionId: outcome.definitionId, existingRevisionId: outcome.revisionId, proposed: outcome.proposed, changes: outcome.changes, reason, status: 'requires_migration_review' };
        const id = hashLore(candidate); outcome.migrationCandidateId = id; migrationIds.push(id);
        await mkdir(join(this.base, 'migrations'), { recursive: true });
        await this.writeAt(join(this.base, 'migrations', `${id.slice(7)}.json`), encodeLore(candidate));
      }
      const result = { status: 'ok', previousHead: head, head: published.head, registryRevisionId: published.registry.revisionId,
        outcomes: plan.outcomes.map(({ proposed, ...o }) => o), addedRevisionIds: published.addedRevisionIds ?? [], migrationCandidateIds: migrationIds,
        next: 'Pin registryRevisionId when proposing world values (lore_universe propose). Registering a definition does not adopt any world fact.' };
      if (opPath) {
        await mkdir(join(this.base, 'operations'), { recursive: true });
        await this.writeAt(opPath, encodeLore({ operationId, requestDigest, result }));
      }
      return result;
    });
  }
  async writeAt(path, text) {
    await noSymlink(path);
    const existing = await readText(path);
    if (existing !== null) { requireLore(existing === text, 'LORE_INTEGRITY', 'immutable record differs'); return; }
    const temporary = `${path}.tmp-${randomUUID()}`, handle = await open(temporary, 'wx');
    try {
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path); await syncDirectory(dirname(path));
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async publishAdditions({ head, registry, definitions, reason }) {
    const result = addLoreDefinitions(registry, { definitions, reason });
    if (!result.addedRevisionIds.length) return { ...result, head, previousHead: head };
    await mkdir(this.objects, { recursive: true }); await this.safePaths();
    // Persist initial checkpoint too, so the first child's parent is readable.
    for (const candidate of [registry, result.registry]) {
      for (const document of candidate.definitions) await this.writeObject(document.revisionId, { objectKind: 'definition', definition: document.definition });
      const { revisionId, ...payload } = candidate;
      await this.writeObject(revisionId, { objectKind: 'registry', registry: { ...payload, definitions: candidate.definitions.map(d => d.revisionId) } });
    }
    await syncDirectory(this.objects);
    await syncDirectory(dirname(this.objects));
    await syncDirectory(join(this.rootDir, '.vibelore', 'shared-lore'));
    await syncDirectory(join(this.rootDir, '.vibelore'));
    await syncDirectory(this.rootDir);
    await noSymlink(this.headPath);
    const temporary = `${this.headPath}.tmp-${randomUUID()}`;
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(`${result.registry.revisionId}\n`); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, this.headPath); await syncDirectory(this.base); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { ...result, previousHead: head, head: result.registry.revisionId };
  }
}
