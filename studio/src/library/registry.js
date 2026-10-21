import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJSON, fail, StudioError } from '../engine/contracts.js';

export const clone = value => JSON.parse(canonicalJSON(value));
export function invalid() { fail('INVALID_INPUT', 'Expected a valid Library request.'); }
export function text(value) { if (typeof value !== 'string' || !value.trim()) invalid(); }
export function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
export function projects(value) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) invalid();
  value.forEach(text); return value;
}
export function safeError(code) { return new StudioError(code, 'The Library operation could not be completed.'); }
const ADAPTER_CODES = new Set(['OWNER_OFFLINE', 'OWNER_REPLACED', 'SOURCE_SCHEMA_UNSUPPORTED', 'SOURCE_DRIFT', 'SOURCE_CORRUPT', 'SOURCE_MISSING', 'PROJECT_NOT_ALLOWED', 'BUNDLE_INCOMPLETE', 'BUNDLE_HASH_MISMATCH', 'BUNDLE_SCHEMA_UNSUPPORTED', 'BUNDLE_LIMIT_EXCEEDED']);
export function adapterError(error) { return safeError(ADAPTER_CODES.has(error?.code) ? error.code : 'OWNER_OFFLINE'); }

// Both databases use rollback journals. Attached transactions make the registry
// guard, owner projection and replay receipt one atomic cross-handle operation.
export async function openRegistry(directory) {
  let db;
  try {
    text(directory); await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'library-registry.sqlite');
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=5000');
    db.prepare('ATTACH DATABASE ? AS projection').run(join(directory, 'library-projection.sqlite'));
    for (const schema of ['main', 'projection']) {
      const version = db.prepare(`PRAGMA ${schema}.user_version`).get().user_version;
      if (![0, 1].includes(version)) throw safeError('LIBRARY_SCHEMA_UNSUPPORTED');
      db.exec(`PRAGMA ${schema}.journal_mode=DELETE`);
    }
    transaction(db, () => db.exec(`
      CREATE TABLE IF NOT EXISTS registry_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO registry_meta VALUES (1,0);
      CREATE TABLE IF NOT EXISTS owners (
        owner_id TEXT PRIMARY KEY, adapter_kind TEXT NOT NULL, locator_json TEXT NOT NULL,
        allowed_json TEXT NOT NULL, generation INTEGER NOT NULL, source_fingerprint TEXT NOT NULL,
        request_sequence INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY, digest TEXT NOT NULL, context_json TEXT, receipt_json TEXT
      );
      CREATE TABLE IF NOT EXISTS projection.snapshots (owner_id TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      PRAGMA main.user_version=1;
      PRAGMA projection.user_version=1;
    `));
    await chmod(path, 0o600); await chmod(join(directory, 'library-projection.sqlite'), 0o600);
    return db;
  } catch (error) {
    try { db?.close(); } catch {}
    if (error?.code === 'LIBRARY_SCHEMA_UNSUPPORTED') throw error;
    throw safeError('LIBRARY_STORAGE_ERROR');
  }
}
export function transaction(db, callback, write = true) {
  db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try { const value = callback(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export const revision = db => db.prepare('SELECT revision FROM registry_meta WHERE id=1').get().revision;
export function checkRevision(db, expected) { if (revision(db) !== expected) throw safeError('REVISION_CONFLICT'); }
export function bump(db) { db.exec('UPDATE registry_meta SET revision=revision+1 WHERE id=1'); return revision(db); }
export function owner(db, ownerId) {
  const row = db.prepare('SELECT * FROM owners WHERE owner_id=?').get(ownerId);
  if (!row) return null;
  return { ownerId: row.owner_id, adapterKind: row.adapter_kind, locator: JSON.parse(row.locator_json), allowedProjects: JSON.parse(row.allowed_json), generation: row.generation, sourceFingerprint: row.source_fingerprint, sequence: row.request_sequence, status: row.status, errorCode: row.error_code };
}
export function requireOwner(db, ownerId) { const value = owner(db, ownerId); if (!value) throw safeError('OWNER_NOT_REGISTERED'); return value; }
export const allOwners = db => db.prepare('SELECT owner_id FROM owners ORDER BY owner_id').all().map(row => owner(db, row.owner_id));
export function replay(db, envelope, digest) {
  const row = db.prepare('SELECT * FROM commands WHERE command_id=?').get(envelope.commandId);
  if (!row) return null;
  if (row.digest !== digest) throw safeError('COMMAND_CONFLICT');
  return { context: row.context_json ? JSON.parse(row.context_json) : null, receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null };
}
export function saveReceipt(db, envelope, digest, receipt) {
  db.prepare('INSERT INTO commands(command_id,digest,receipt_json) VALUES (?,?,?) ON CONFLICT(command_id) DO UPDATE SET receipt_json=excluded.receipt_json').run(envelope.commandId, digest, canonicalJSON(receipt));
  return receipt;
}
