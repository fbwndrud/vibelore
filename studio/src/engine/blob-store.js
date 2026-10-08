import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BLOB_ID, assertId, fail, publicError } from './contracts.js';

const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');

export class BlobStore {
  constructor(directory, store) {
    this.storageDirectory = directory;
    this.directory = join(directory, 'blobs');
    this.store = store;
    this.closed = false;
    this.pending = new Set();
  }
  assertOpen() { if (this.closed) fail('STUDIO_CLOSED', 'Studio is closed.'); this.store.assertOpen(); }
  async operation(callback, failureCode) {
    this.assertOpen();
    const promise = callback();
    this.pending.add(promise);
    try { return await promise; } catch (error) { throw publicError(error, failureCode, true); } finally { this.pending.delete(promise); }
  }
  async syncDirectory(directory) {
    const handle = await open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  path(projectId, blobId) { return join(this.directory, projectId, blobId); }
  register(projectId, blobId, byteLength, status = 'available') {
    this.store.write(() => this.store.run(`INSERT INTO blobs(project_id,id,byte_length,status) VALUES(?,?,?,?)
      ON CONFLICT(project_id,id) DO UPDATE SET status=excluded.status`, projectId, blobId, byteLength, status));
  }
  async put(projectId, input) {
    return this.operation(async () => {
      assertId(projectId); this.store.requireProject(projectId);
      if (!(input instanceof Uint8Array)) fail('INVALID_INPUT', 'Blob writes require bytes.');
      const bytes = new Uint8Array(input);
      const blobId = hashBytes(bytes);
      const directory = join(this.directory, projectId);
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `${blobId}.${randomUUID()}.tmp`);
      let file;
      try {
        file = await open(temporary, 'wx', 0o600);
        await file.writeFile(bytes);
        await file.sync();
        await file.close(); file = null;
        // link publishes atomically without ever replacing an immutable destination.
        // rename() alone overwrites existing bytes on POSIX, including concurrent writers.
        try { await link(temporary, this.path(projectId, blobId)); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const existing = await readFile(this.path(projectId, blobId));
          if (hashBytes(existing) !== blobId) fail('BLOB_CORRUPT', 'Existing immutable blob failed integrity verification.', { blobId });
        }
        await unlink(temporary);
        // Persist the leaf entry and its complete configured directory chain.
        // Always sync parents: a previous failed first write may have created
        // them without making their directory entries durable.
        await this.syncDirectory(directory);
        await this.syncDirectory(this.directory);
        await this.syncDirectory(this.storageDirectory);
        this.register(projectId, blobId, bytes.byteLength);
        return { blobId, byteLength: bytes.byteLength };
      } finally {
        if (file) await file.close();
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }, 'BLOB_WRITE_FAILED');
  }
  async read(projectId, blobId) {
    return this.operation(async () => {
      assertId(projectId); this.store.requireProject(projectId);
      if (typeof blobId !== 'string' || !BLOB_ID.test(blobId)) fail('INVALID_INPUT', 'Expected a blob hash.');
      const blob = this.store.get('SELECT byte_length,status FROM blobs WHERE project_id = ? AND id = ?', projectId, blobId);
      if (!blob) fail('BLOB_NOT_FOUND', 'Blob is not registered for this project.', { blobId });
      let bytes;
      try { bytes = await readFile(this.path(projectId, blobId)); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.register(projectId, blobId, blob.byte_length, 'missing');
        fail('BLOB_MISSING', 'Registered blob bytes are missing.', { blobId });
      }
      if (bytes.byteLength !== blob.byte_length || hashBytes(bytes) !== blobId) {
        this.register(projectId, blobId, blob.byte_length, 'corrupt');
        fail('BLOB_CORRUPT', 'Blob failed integrity verification.', { blobId });
      }
      return new Uint8Array(bytes);
    }, 'BLOB_READ_FAILED');
  }
  async recover() {
    await mkdir(this.directory, { recursive: true });
    await this.syncDirectory(this.directory);
    await this.syncDirectory(this.storageDirectory);
    for (const { id: projectId } of this.store.all('SELECT id FROM projects')) {
      const registered = this.store.all('SELECT id,byte_length FROM blobs WHERE project_id = ?', projectId);
      for (const blob of registered) {
        let status;
        try {
          const bytes = await readFile(this.path(projectId, blob.id));
          status = bytes.byteLength === blob.byte_length && hashBytes(bytes) === blob.id ? 'available' : 'corrupt';
        } catch (error) { if (error.code !== 'ENOENT') throw error; status = 'missing'; }
        this.register(projectId, blob.id, blob.byte_length, status);
      }
      let entries;
      try { entries = await readdir(join(this.directory, projectId), { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const entry of entries) {
        if (!entry.isFile() || !BLOB_ID.test(entry.name) || registered.some(blob => blob.id === entry.name)) continue;
        const bytes = await readFile(this.path(projectId, entry.name));
        if (hashBytes(bytes) === entry.name) this.register(projectId, entry.name, bytes.byteLength);
      }
    }
  }
  async close() { this.closed = true; await Promise.allSettled([...this.pending]); }
}
