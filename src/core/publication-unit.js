import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CONTEXT_FIELDS = ['snapshotId', 'expectedHead', 'storyTimeScope', 'publicationOrder', 'transactionTime', 'policyRevision', 'semanticGeneration', 'fencingToken'];
const failure = (code, details = {}) => ({ ok: false, error: { code, ...details } });
const success = (value) => ({ ok: true, value });
function invalidContextFields(context) {
  const invalid = [];
  if (typeof context.snapshotId !== 'string' || context.snapshotId.length === 0) invalid.push('snapshotId');
  if (context.expectedHead !== null && !/^sha256:[0-9a-f]{64}$/.test(context.expectedHead)) invalid.push('expectedHead');
  if (!context.storyTimeScope || typeof context.storyTimeScope.worldline !== 'string' || context.storyTimeScope.worldline.length === 0) invalid.push('storyTimeScope');
  if (!Number.isSafeInteger(context.publicationOrder) || context.publicationOrder < 1) invalid.push('publicationOrder');
  if (typeof context.transactionTime !== 'string' || !Number.isFinite(Date.parse(context.transactionTime))) invalid.push('transactionTime');
  if (typeof context.policyRevision !== 'string' || context.policyRevision.length === 0) invalid.push('policyRevision');
  if (typeof context.semanticGeneration !== 'string' || context.semanticGeneration.length === 0) invalid.push('semanticGeneration');
  if (!Number.isSafeInteger(context.fencingToken) || context.fencingToken < 1) invalid.push('fencingToken');
  return invalid;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const encode = (value) => `${JSON.stringify(stable(value), null, 2)}\n`;
const digest = (value) => `sha256:${createHash('sha256').update(encode(value)).digest('hex')}`;
async function readText(path) { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function readJson(path) { const text = await readText(path); return text === null ? null : JSON.parse(text); }
async function durableWrite(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'w');
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}
async function atomicWrite(path, text) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await durableWrite(temporary, text); await rename(temporary, path);
  // Windows does not support opening a directory for fsync through Node.
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function mergeTree(parent, patch) {
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return stable(patch);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return stable(patch);
  const merged = { ...parent };
  for (const [key, value] of Object.entries(patch)) merged[key] = key in parent ? mergeTree(parent[key], value) : stable(value);
  return merged;
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
async function withLock(path, operation, ttlMs) {
  await mkdir(dirname(path), { recursive: true });
  const ownerId = randomUUID();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(path);
      await durableWrite(join(path, 'owner.json'), encode({ ownerId, pid: process.pid, expiresAt: Date.now() + ttlMs }));
      break;
    }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt >= 1000) throw error;
      const owner = await readJson(join(path, 'owner.json')).catch(() => null);
      if (owner && (Number(owner.expiresAt) <= Date.now() || !processAlive(Number(owner.pid)))) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  try { return await operation(); }
  finally {
    const owner = await readJson(join(path, 'owner.json')).catch(() => null);
    if (owner?.ownerId === ownerId) await rm(path, { recursive: true, force: true });
  }
}

export class PublicationCrash extends Error {
  constructor(failpoint) { super(`publication crash at ${failpoint}`); this.name = 'PublicationCrash'; this.failpoint = failpoint; }
}

export function createPublicationUnit({ rootDir, failAt = null, lockTtlMs = 30_000 }) {
  if (!rootDir) throw new TypeError('PublicationUnit requires rootDir');
  const base = join(rootDir, '.vibelore', 'publication');
  const objects = join(base, 'objects');
  const headPath = join(base, 'HEAD');
  const epochPath = join(base, 'fencing-epoch');
  const crash = (name) => { if (failAt === name) throw new PublicationCrash(name); };
  return {
    async issueFencingToken() {
      return withLock(join(base, 'authority.lock'), async () => {
        const fencingToken = Number((await readText(epochPath)) ?? 0) + 1;
        await atomicWrite(epochPath, `${fencingToken}\n`);
        return success({ fencingToken });
      }, lockTtlMs);
    },
    async publish({ context, candidate, replace = false }) {
      return withLock(join(base, 'authority.lock'), async () => {
      const missing = CONTEXT_FIELDS.filter((field) => !Object.hasOwn(context ?? {}, field));
      if (missing.length > 0) return failure('INVALID_EXECUTION_CONTEXT', { missing });
      const invalid = invalidContextFields(context);
      if (invalid.length > 0) return failure('INVALID_EXECUTION_CONTEXT', { invalid });
      const currentToken = Number((await readText(epochPath)) ?? 0);
      if (!Number.isSafeInteger(context.fencingToken) || context.fencingToken !== currentToken) return failure('STALE_FENCING_TOKEN', { expected: currentToken, actual: context.fencingToken });
      const currentHead = (await readText(headPath))?.trim() || null;
      if (!candidate?.tree || !candidate?.projections || typeof candidate.projections !== 'object') return failure('INVALID_CANDIDATE');
      let parentTree = {};
      let parentProjections = {};
      if (context.expectedHead) {
        const parentDir = join(objects, context.expectedHead.slice(7));
        parentTree = (await readJson(join(parentDir, 'tree.json'))) ?? {};
        parentProjections = (await readJson(join(parentDir, 'projections.json'))) ?? {};
      }
      const completeCandidate = { ...candidate, tree: replace ? stable(candidate.tree) : mergeTree(parentTree, candidate.tree), projections: replace ? stable(candidate.projections) : mergeTree(parentProjections, candidate.projections) };
      const head = digest({ context, candidate: completeCandidate });
      const objectDir = join(objects, head.slice(7));
      if (currentHead === head && await exists(join(objectDir, 'manifest.json'))) return success({ head, previousHead: context.expectedHead, idempotent: true });
      if (context.expectedHead !== currentHead) return failure('STALE_HEAD', { expected: currentHead, actual: context.expectedHead });
      const allowedGrandfatherKinds = new Set(['expression', 'summary', 'nonsemantic_projection']);
      const invalidClosure = (candidate.impactClosure ?? []).filter((dependency) => {
        if (dependency.status === 'explicitly_grandfathered') return !allowedGrandfatherKinds.has(dependency.dependencyKind);
        return !['revalidated', 'superseded', 'satisfied'].includes(dependency.status);
      });
      if (invalidClosure.length > 0) return failure('UNSATISFIED_DEPENDENCY_CLOSURE', { dependencies: invalidClosure.map((item) => item.id) });
      const watermarks = Object.fromEntries(Object.keys(completeCandidate.projections).sort().map((name) => [name, head]));
      const manifest = { generation: head, parent: currentHead, snapshotId: context.snapshotId, fencingToken: context.fencingToken, projectionWatermarks: watermarks, sealed: true, treeDigest: digest(completeCandidate.tree), projectionsDigest: digest(completeCandidate.projections) };
      if (!(await exists(join(objectDir, 'manifest.json')))) {
        await mkdir(objectDir, { recursive: true });
        crash('afterBlob');
        await durableWrite(join(objectDir, 'tree.json'), encode(completeCandidate.tree)); crash('afterTree');
        await durableWrite(join(objectDir, 'projections.json'), encode(completeCandidate.projections)); crash('afterEachProjection'); crash('afterProjections');
        await durableWrite(join(objectDir, 'manifest.json'), encode(manifest)); crash('afterManifestFsync');
      }
      crash('beforeHeadCAS');
      const tokenBeforeSwap = Number((await readText(epochPath)) ?? 0);
      if (tokenBeforeSwap !== context.fencingToken) return failure('STALE_FENCING_TOKEN', { expected: tokenBeforeSwap, actual: context.fencingToken });
      const headBeforeSwap = (await readText(headPath))?.trim() || null;
      if (headBeforeSwap !== context.expectedHead) return failure('STALE_HEAD', { expected: headBeforeSwap, actual: context.expectedHead });
      await atomicWrite(headPath, `${head}\n`); crash('afterHeadCAS');
      return success({ head, previousHead: currentHead, idempotent: false });
      }, lockTtlMs);
    },
    async readPublished() {
      const head = (await readText(headPath))?.trim() || null;
      if (!head) return success(null);
      const objectDir = join(objects, head.slice(7));
      const [tree, projections, manifest] = await Promise.all([readJson(join(objectDir, 'tree.json')), readJson(join(objectDir, 'projections.json')), readJson(join(objectDir, 'manifest.json'))]);
      if (!manifest?.sealed || manifest.generation !== head || !tree || !projections || manifest.treeDigest !== digest(tree) || manifest.projectionsDigest !== digest(projections)) return failure('CORRUPT_PUBLICATION', { head });
      return success({ head, tree, projections, manifest, projectionWatermarks: manifest.projectionWatermarks });
    },
  };
}
