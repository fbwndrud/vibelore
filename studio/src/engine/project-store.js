import { blobReferences } from '../render/closure.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { assertId, assertInteger, assertSynchronous, canonicalJSON, fail } from './contracts.js';

export class ProjectStore {
  constructor(directory) {
    this.closed = false;
    this.db = new DatabaseSync(join(directory, 'studio.sqlite'));
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      const version = this.get('PRAGMA user_version').user_version;
      if (version > 2) fail('SCHEMA_UNSUPPORTED', 'Database schema is newer than this engine.');
      this.write(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, language TEXT NOT NULL, budget_micros INTEGER NOT NULL CHECK(budget_micros >= 0)
          );
          CREATE TABLE IF NOT EXISTS productions (
            project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, title TEXT NOT NULL, source_package_id TEXT,
            PRIMARY KEY(project_id, id)
          );
          CREATE TABLE IF NOT EXISTS aggregates (
            project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, id TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision > 0), data_json TEXT NOT NULL,
            PRIMARY KEY(project_id, kind, id)
          );
          CREATE TABLE IF NOT EXISTS commands (
            project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, digest TEXT NOT NULL, result_json TEXT NOT NULL,
            PRIMARY KEY(project_id, id)
          );
          CREATE TABLE IF NOT EXISTS events (
            cursor INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
            command_id TEXT NOT NULL, aggregate_kind TEXT NOT NULL, aggregate_id TEXT NOT NULL,
            aggregate_revision INTEGER NOT NULL, type TEXT NOT NULL, value_json TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS events_project_cursor ON events(project_id, cursor);
          CREATE TABLE IF NOT EXISTS blobs (
            project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, byte_length INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('available','missing','corrupt')), PRIMARY KEY(project_id, id)
          );
          CREATE TABLE IF NOT EXISTS reuse_imports (
            project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, reuse_key TEXT NOT NULL, data_json TEXT NOT NULL,
            PRIMARY KEY(project_id,id)
          );
          CREATE INDEX IF NOT EXISTS reuse_imports_key ON reuse_imports(project_id,reuse_key);
          PRAGMA user_version = 2;
        `);
      });
    } catch (error) { this.close(); throw error; }
  }
  assertOpen() { if (this.closed) fail('STUDIO_CLOSED', 'Studio is closed.'); }
  get(sql, ...parameters) { this.assertOpen(); return this.db.prepare(sql).get(...parameters); }
  all(sql, ...parameters) { this.assertOpen(); return this.db.prepare(sql).all(...parameters); }
  run(sql, ...parameters) { this.assertOpen(); return this.db.prepare(sql).run(...parameters); }
  write(callback) {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = assertSynchronous(callback());
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  requireProject(projectId) {
    assertId(projectId);
    const project = this.get('SELECT id, title, language, budget_micros AS budgetMicros FROM projects WHERE id = ?', projectId);
    if (!project) fail('PROJECT_NOT_FOUND', 'Project does not exist.', { projectId });
    return { ...project };
  }
  aggregate(projectId, { kind, id }) {
    const row = this.get('SELECT revision, data_json FROM aggregates WHERE project_id = ? AND kind = ? AND id = ?', projectId, kind, id);
    return row ? { kind, id, revision: row.revision, value: JSON.parse(row.data_json) } : { kind, id, revision: 0, value: null };
  }
  command(projectId, commandId) { return this.get('SELECT digest, result_json FROM commands WHERE project_id = ? AND id = ?', projectId, commandId); }
  recordCommandAndEvent(envelope, digest, value) {
    const aggregateRevision = envelope.expectedRevision + 1;
    assertInteger(aggregateRevision);
    const valueJSON = canonicalJSON(value);
    for(const id of blobReferences(value)) {
      const blob=this.get('SELECT status FROM blobs WHERE project_id=? AND id=?',envelope.projectId,id);
      if(blob?.status!=='available'||this.get('SELECT 1 FROM blob_tombstones WHERE project_id=? AND blob_id=?',envelope.projectId,id)) fail('BLOB_UNAVAILABLE','A referenced blob is unavailable.');
    }
    this.run(`INSERT INTO aggregates(project_id,kind,id,revision,data_json) VALUES(?,?,?,?,?)
      ON CONFLICT(project_id,kind,id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json`,
    envelope.projectId, envelope.aggregate.kind, envelope.aggregate.id, aggregateRevision, valueJSON);
    const event = this.run(`INSERT INTO events(project_id,command_id,aggregate_kind,aggregate_id,aggregate_revision,type,value_json)
      VALUES(?,?,?,?,?,?,?)`, envelope.projectId, envelope.commandId, envelope.aggregate.kind, envelope.aggregate.id, aggregateRevision, envelope.type, valueJSON);
    const result = { commandId: envelope.commandId, aggregateRevision, eventCursor: Number(event.lastInsertRowid), value: JSON.parse(valueJSON), replayed: false };
    this.run('INSERT INTO commands(project_id,id,digest,result_json) VALUES(?,?,?,?)', envelope.projectId, envelope.commandId, digest, canonicalJSON(result));
    return result;
  }
  snapshot(projectId, decorate = value => value) {
    return this.write(() => assertSynchronous(decorate({
      project: this.requireProject(projectId),
      productions: this.all('SELECT id, title, source_package_id AS sourcePackageId FROM productions WHERE project_id = ? ORDER BY id', projectId).map(row => ({ ...row })),
      aggregates: this.all('SELECT kind, id, revision, data_json FROM aggregates WHERE project_id = ? ORDER BY kind,id', projectId)
        .map(row => ({ kind: row.kind, id: row.id, revision: row.revision, value: JSON.parse(row.data_json) })),
      eventCursor: this.get('SELECT coalesce(max(cursor),0) AS cursor FROM events WHERE project_id = ?', projectId).cursor,
    })));
  }
  events(projectId, afterCursor, limit = null) {
    this.requireProject(projectId); assertInteger(afterCursor);
    if (limit !== null) { assertInteger(limit); if (limit < 1 || limit > 1000) fail("INVALID_INPUT", "Expected an event page of 1 to 1000 entries."); }
    return this.all(`SELECT cursor,command_id AS commandId,aggregate_kind AS kind,aggregate_id AS id,
      aggregate_revision AS aggregateRevision,type,value_json FROM events WHERE project_id = ? AND cursor > ? ORDER BY cursor LIMIT ?`, projectId, afterCursor, limit ?? -1)
      .map(row => ({ cursor: row.cursor, projectId, commandId: row.commandId, aggregate: { kind: row.kind, id: row.id },
        aggregateRevision: row.aggregateRevision, type: row.type, value: JSON.parse(row.value_json) }));
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
