import { mkdir } from 'node:fs/promises';
import { ProjectStore } from './project-store.js';
import { BlobStore } from './blob-store.js';
import { assertId, assertInteger, assertText, assertSynchronous, canonicalDigest, fail, publicError, validateEnvelope } from './contracts.js';

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
  const assertOpen = () => { if (closed) fail('STUDIO_CLOSED', 'Studio is closed.'); };
  async function boundary(callback, code) {
    assertOpen();
    try { return await callback(); } catch (error) { throw publicError(error, code); }
  }
  const service = {
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
      handlers.set(type, { ...handler });
    },
    async command(input) {
      return boundary(() => {
        const envelope = validateEnvelope(input);
        const digest = canonicalDigest(envelope);
        return store.write(() => {
          const previous = store.command(envelope.projectId, envelope.commandId);
          if (previous) {
            if (previous.digest !== digest) fail('COMMAND_CONFLICT', 'Command ID was already used for a different command.', { commandId: envelope.commandId });
            return { ...JSON.parse(previous.result_json), replayed: true };
          }
          const handler = handlers.get(envelope.type);
          if (!handler) fail('UNKNOWN_COMMAND', 'Unknown command type.');
          const context = { store, envelope, aggregate: store.aggregate(envelope.projectId, envelope.aggregate) };
          const target = assertSynchronous(handler.target(context));
          if (!target || target.kind !== envelope.aggregate.kind || target.id !== envelope.aggregate.id) fail('INVALID_AGGREGATE', 'Command aggregate must match its subject.');
          if (envelope.type !== 'project.create') store.requireProject(envelope.projectId);
          if (context.aggregate.revision !== envelope.expectedRevision) fail('REVISION_CONFLICT', 'Aggregate revision is stale.', {
            aggregate: { kind: envelope.aggregate.kind, id: envelope.aggregate.id }, expectedRevision: envelope.expectedRevision, actualRevision: context.aggregate.revision,
          });
          if (handler.validate) assertSynchronous(handler.validate(context));
          const value = assertSynchronous(handler.apply(context));
          return store.recordCommandAndEvent(envelope, digest, value);
        });
      }, 'COMMAND_FAILED');
    },
    async snapshot(projectId) { return boundary(() => store.snapshot(projectId), 'STORAGE_FAILED'); },
    async events(projectId, afterCursor = 0) { return boundary(() => store.events(projectId, afterCursor), 'STORAGE_FAILED'); },
    async readBlob(projectId, blobId) { return boundary(() => blobs.read(projectId, blobId), 'BLOB_READ_FAILED'); },
    async close() {
      if (!closePromise) {
        closed = true;
        closePromise = (async () => {
          try { await blobs.close(); store.close(); } catch (error) { throw publicError(error, 'STORAGE_FAILED'); }
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
  return service;
}
