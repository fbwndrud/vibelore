import { registerCycleCommands } from './asset-cycles.js';
import { inspectReuse } from '../reuse/inspect.js';
import { registerReuseCommands } from '../reuse/import.js';
import { readHistory } from './history.js';
import { collectGarbage, integrityReport, supportBundle } from './recovery.js';
import { registerBudgetCommands } from './budget.js';
import { registerBackupCommands, localBackupReceipts } from './backup.js';
import { registerEditionCommands, decorateEditionSnapshot } from '../render/edition.js';
import { registerTimelineCommands } from './timeline.js';
import { registerManuscriptCommand } from '../source/manuscript.js';
import { registerProposalCommands } from './proposals.js';
import { registerAdoptionCommands, decorateAssetSnapshot } from './adoptions.js';
import { registerAssetCommands } from '../assets/commands.js';
import { recoverWorkers, registerRecoveryCommands, revalidatePendingOutputs } from './worker.js';
import { registerJobCommands, decorateExecutionSnapshot } from './jobs.js';
import { registerSourceCommands } from '../source/source-package.js';
import { registerStoryCommands, effectiveScenes, domainValues } from './story.js';
import { registerCastingCommands, resolvedBindings } from './casting.js';
import { registerRebaseCommands } from './rebase.js';
import { mkdir } from 'node:fs/promises';
import { ProjectStore } from './project-store.js';
import { BlobStore } from './blob-store.js';
import { assertId, assertInteger, assertText, assertSynchronous, canonicalDigest, fail, publicError, validateEnvelope } from './contracts.js';

// validateEnvelope has already rejected accessors/prototypes before this freeze.
function freezeJSON(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJSON(child);
    Object.freeze(value);
  }
  return value;
}

export async function openStudio({ directory, providers = {}, renderer = null } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) fail('INVALID_INPUT', 'Expected a project storage directory.');
  let store;
  try { await mkdir(directory, { recursive: true }); store = new ProjectStore(directory); }
  catch (error) { throw publicError(error, 'STORAGE_FAILED'); }
  const blobs = new BlobStore(directory, store);
  try { await blobs.recover(); } catch (error) { store.close(); throw publicError(error, 'STORAGE_FAILED'); }
  const handlers = new Map();
  let closed = false;
  let closePromise;
  const pendingCommands = new Set();
  const pendingBackground = new Set();
  const backgroundStop = new AbortController();
  const assertOpen = () => { if (closed) fail('STUDIO_CLOSED', 'Studio is closed.'); };
  async function boundary(callback, code) {
    assertOpen();
    try { return await callback(); } catch (error) { throw publicError(error, code); }
  }
  const service = {
    runBackground(callback) {
      const work = boundary(() => blobs.leases.scope('worker', () => callback(backgroundStop.signal)), 'EXECUTION_FAILED');
      pendingBackground.add(work);
      work.then(() => pendingBackground.delete(work), () => pendingBackground.delete(work));
      return work;
    },
    // Internal collaborators, shared by subsequent command-registration modules.
    store, blobs, providers, renderer,
    registerCommand(type, handler) {
      assertOpen();
      if (handlers.has(type)) fail('COMMAND_REGISTERED', 'Command type is already registered.');
      if (!handler || typeof handler.target !== 'function' || typeof handler.apply !== 'function') fail('INVALID_INPUT', 'Expected target and apply callbacks.');
      for (const callback of [handler.target, handler.validate, handler.apply].filter(Boolean)) {
        if (typeof callback !== 'function') fail('INVALID_INPUT', 'Expected a callback.');
        if (['AsyncFunction', 'AsyncGeneratorFunction', 'GeneratorFunction'].includes(callback.constructor.name)) fail('ASYNC_HANDLER', 'Command callbacks must be synchronous.');
      }
      if (handler.prepare && typeof handler.prepare !== 'function') fail('INVALID_INPUT', 'Expected a preparation callback.');
      if (handler.discard && typeof handler.discard !== 'function') fail('INVALID_INPUT', 'Expected a discard callback.');
      handlers.set(type, { ...handler });
    },
    async command(input) {
      const accepted = boundary(() => blobs.leases.scope('staging', async () => {
        const envelope = freezeJSON(validateEnvelope(input));
        if (envelope.type === 'edition.render') blobs.leases.context.getStore().kind = 'render';
        const digest = canonicalDigest(envelope);
        function replay() {
          const previous = store.command(envelope.projectId, envelope.commandId);
          if (!previous) return null;
          if (previous.digest !== digest) fail('COMMAND_CONFLICT', 'Command ID was already used for a different command.', { commandId: envelope.commandId });
          return { ...JSON.parse(previous.result_json), replayed: true };
        }
        const previous = replay(); if (previous) return previous;
        const handler = handlers.get(envelope.type);
        if (!handler) fail('UNKNOWN_COMMAND', 'Unknown command type.');
        function validateContext() {
          const context = { store, envelope, aggregate: store.aggregate(envelope.projectId, envelope.aggregate) };
          const target = assertSynchronous(handler.target(context));
          if (!target || target.kind !== envelope.aggregate.kind || target.id !== envelope.aggregate.id) fail('INVALID_AGGREGATE', 'Command aggregate must match its subject.');
          if (envelope.type !== 'project.create') store.requireProject(envelope.projectId);
          if (context.aggregate.revision !== envelope.expectedRevision) fail('REVISION_CONFLICT', 'Aggregate revision is stale.', {
            aggregate: { kind: envelope.aggregate.kind, id: envelope.aggregate.id }, expectedRevision: envelope.expectedRevision, actualRevision: context.aggregate.revision,
          });
          return context;
        }
        // Preparation may publish immutable bytes but owns no aggregate/adoption authority.
        // The original JSON envelope and digest are unchanged; final replay/CAS is authoritative.
        const prepared = handler.prepare ? await handler.prepare(validateContext()) : undefined;
        let result;
        try {
          result = store.write(() => {
            blobs.leases.assertFence();
            const previous = replay(); if (previous) return previous;
            const context = { ...validateContext(), prepared };
            if (handler.validate) assertSynchronous(handler.validate(context));
            const value = assertSynchronous(handler.apply(context));
            // Administrative receipts are events; they do not replace the aggregate's own value.
            return store.recordCommandAndEvent(envelope, digest, value, handler.keepAggregateValue ? context.aggregate.value : value);
          });
        } catch (error) {
          if (handler.discard) await handler.discard({ envelope, prepared }).catch(() => {});
          throw error;
        }
        // Preparation outside the store (such as files) is released when it was not committed.
        if (result.replayed && handler.discard) await handler.discard({ envelope, prepared }).catch(() => {});
        return result;
      }), 'COMMAND_FAILED');
      pendingCommands.add(accepted);
      try { return await accepted; } finally { pendingCommands.delete(accepted); }
    },
    async inspectReuse({ projectId, bundle, bytes, intent }) {
      return boundary(() => inspectReuse({ bundle, bytes, intent, destination: { service, projectId } }), 'REUSE_INSPECTION_FAILED');
    },
    async snapshot(projectId) { return boundary(() => {
      return store.snapshot(projectId, snapshot => {
        snapshot.integrity = integrityReport(blobs,projectId);
        snapshot.backups = localBackupReceipts(store,directory,projectId,'project.backup');
        snapshot.restores = localBackupReceipts(store,directory,projectId,'project.restore');
        snapshot.reuseImports = store
          .all('SELECT data_json FROM reuse_imports WHERE project_id=? ORDER BY id', projectId)
          .map(row => JSON.parse(row.data_json));
        snapshot.cycles = domainValues(snapshot, 'cycle').map(a => a.value);
        snapshot.productionCases = domainValues(snapshot, 'productionCase').map(a => a.value);
        snapshot.sourcePackages = domainValues(snapshot, 'sourcePackage').map(a => a.value);
        snapshot.story = domainValues(snapshot, 'story')[0]?.value ?? null;
        snapshot.cast = domainValues(snapshot, 'cast').map(a => a.value);
        snapshot.scenes = effectiveScenes(snapshot);
        snapshot.resolvedBindings = resolvedBindings(snapshot);
        snapshot.sourceChanges = store.all('SELECT data_json FROM source_changes WHERE project_id=? ORDER BY id', projectId).map(r => JSON.parse(r.data_json));
        return decorateEditionSnapshot(store, decorateAssetSnapshot(store, decorateExecutionSnapshot(store, snapshot)));
      });
    }, 'STORAGE_FAILED'); },
    async history(projectId, options) { return boundary(() => readHistory(store, projectId, options), 'STORAGE_FAILED'); },
    async events(projectId, afterCursor = 0, limit = null) { return boundary(() => store.events(projectId, afterCursor, limit), 'STORAGE_FAILED'); },
    async readBlob(projectId, blobId) { return boundary(() => blobs.read(projectId, blobId), 'BLOB_READ_FAILED'); },
    async collectGarbage(projectId, options) {return boundary(()=>collectGarbage(blobs,projectId,options),'GC_FAILED');},
    async integrity(projectId) {return boundary(()=>integrityReport(blobs,projectId),'STORAGE_FAILED');},
    async supportBundle(projectId) {return boundary(()=>supportBundle(service,projectId),'STORAGE_FAILED');},
    async close() {
      if (!closePromise) {
        closed = true;
        backgroundStop.abort();
        closePromise = (async () => {
          try { await Promise.allSettled([...pendingCommands, ...pendingBackground]); await blobs.close(); store.close(); } catch (error) { throw publicError(error, 'STORAGE_FAILED'); }
        })();
      }
      return closePromise;
    },
  };
  service.registerCommand('project.create', {
    target: ({ envelope }) => ({ kind: 'project', id: envelope.projectId }),
    validate({ store, envelope }) {
      const { title, language, budgetMicros } = envelope.payload;
      assertText(title); assertText(language); assertInteger(budgetMicros);
      if (store.get('SELECT id FROM projects WHERE id = ?', envelope.projectId)) fail('PROJECT_EXISTS', 'Project already exists.', { projectId: envelope.projectId });
    },
    apply({ store, envelope }) {
      const { title, language, budgetMicros } = envelope.payload;
      store.run('INSERT INTO projects(id,title,language,budget_micros) VALUES(?,?,?,?)', envelope.projectId, title, language, budgetMicros);
      return { id: envelope.projectId, title, language, budgetMicros };
    },
  });
  service.registerCommand('production.create', {
    target: ({ envelope }) => ({ kind: 'production', id: envelope.payload.id }),
    validate({ store, envelope }) {
      const { id, title, sourcePackageId } = envelope.payload;
      assertId(id); assertText(title);
      if (sourcePackageId !== null) {
        assertId(sourcePackageId);
        if (!store.aggregate(envelope.projectId, { kind: 'sourcePackage', id: sourcePackageId }).revision) fail('INVALID_REFERENCE', 'Source package does not belong to this project.');
      }
      if (store.get('SELECT id FROM productions WHERE project_id = ? AND id = ?', envelope.projectId, id)) fail('PRODUCTION_EXISTS', 'Production already exists.', { productionId: id });
    },
    apply({ store, envelope }) {
      const { id, title, sourcePackageId } = envelope.payload;
      store.run('INSERT INTO productions(project_id,id,title,source_package_id) VALUES(?,?,?,?)', envelope.projectId, id, title, sourcePackageId);
      return { id, title, sourcePackageId };
    },
  });
  registerSourceCommands(service);
  registerManuscriptCommand(service);
  registerProposalCommands(service);
  registerStoryCommands(service);
  registerCastingCommands(service);
  registerRebaseCommands(service);
  registerJobCommands(service);
  registerBudgetCommands(service);
  registerAssetCommands(service);
  registerReuseCommands(service);
  registerCycleCommands(service);
  registerAdoptionCommands(service);
  registerRecoveryCommands(service);
  registerTimelineCommands(service);
  registerEditionCommands(service);
  registerBackupCommands(service);
  recoverWorkers(service);
  await revalidatePendingOutputs(service);
  return service;
}

export { restoreStudioBackup } from './backup.js';
