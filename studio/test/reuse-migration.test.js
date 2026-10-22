import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { withStudio } from './helpers/project.js';
import { openStudio } from '../src/engine/index.js';
test('schema 1 upgrades to 2 without changing existing aggregates or replay receipts', async (t) => {
  const f = await withStudio(t);
  const before = await f.service.snapshot(f.projectId);
  await f.service.close();
  const db = new DatabaseSync(join(f.directory, 'studio.sqlite'));
  db.exec('DROP TABLE IF EXISTS reuse_imports; PRAGMA user_version=1');
  db.close();
  const s = await openStudio({ directory: f.directory });
  t.after(() => s.close());
  assert.equal(s.store.get('PRAGMA user_version').user_version, 2);
  assert.deepEqual(
    (await s.snapshot(f.projectId)).aggregates,
    before.aggregates
  );
  assert.deepEqual((await s.snapshot(f.projectId)).reuseImports, []);
  const replay = await s.command({
    projectId: f.projectId,
    commandId: 'create-project',
    aggregate: { kind: 'project', id: f.projectId },
    expectedRevision: 0,
    type: 'project.create',
    payload: { title: '작품', language: 'ko', budgetMicros: 1000000 },
  });
  assert.equal(replay.replayed, true);
});
test('migration failure rolls back schema version and DDL; future schemas are refused', async (t) => {
  const f = await withStudio(t);
  await f.service.close();
  const path = join(f.directory, 'studio.sqlite');
  const db = new DatabaseSync(path);
  db.exec(
    'DROP TABLE IF EXISTS reuse_imports; CREATE VIEW reuse_imports AS SELECT id FROM projects; PRAGMA user_version=1'
  );
  db.close();
  await assert.rejects(openStudio({ directory: f.directory }));
  const check = new DatabaseSync(path);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 1);
  check.exec('DROP VIEW reuse_imports; PRAGMA user_version=99');
  check.close();
  await assert.rejects(openStudio({ directory: f.directory }), {
    code: 'SCHEMA_UNSUPPORTED',
  });
});
test('schema1 backup restores through schema2 without losing Edition, rejected candidates or source bytes', async (t) => {
  const { audioFixture } = await import('./helpers/render-fixture.js'),
    { assetImport, environmentSlot } = await import('./helpers/images.js'),
    { pngBytes } = await import('./helpers/bundles.js'),
    { readFile, writeFile } = await import('node:fs/promises'),
    { canonicalDigest } = await import('../src/engine/contracts.js'),
    { restoreStudioBackup } = await import('../src/engine/backup.js');
  const f = await audioFixture(t);
  await f.command(
    'source.manuscript',
    {
      id: 'source',
      title: 'Source',
      language: 'ko',
      bytes: [...Buffer.from('old source')],
    },
    { aggregate: { kind: 'sourcePackage', id: 'source' } }
  );
  await assetImport(
    f,
    'rejected',
    Buffer.from(pngBytes),
    environmentSlot('old-picture')
  );
  await f.command(
    'candidate.review',
    {
      candidateId: 'rejected',
      decision: 'reject',
      actor: 'a',
      reason: 'old choice',
    },
    { aggregate: { kind: 'assetReview', id: 'rejected' } }
  );
  const oldEdition = (
    await f.command(
      'edition.create',
      { id: 'old-edition', productionId: 'main', profile: 'audio' },
      { aggregate: { kind: 'edition', id: 'old-edition' } }
    )
  ).value;
  const before = await f.service.snapshot(f.projectId),
    receipt = (await f.command('project.backup', {})).value,
    archive = join(f.directory, receipt.archive),
    path = join(archive, 'manifest.json'),
    m = JSON.parse(await readFile(path, 'utf8'));
  delete m.tables.reuse_imports;
  m.schemaVersion = 1;
  const { digest, ...body } = m;
  m.digest = canonicalDigest(body);
  await writeFile(path, JSON.stringify(m));
  const restored = await restoreStudioBackup({
    archive,
    directory: join(f.directory, 'schema1-restored'),
  });
  t.after(() => restored.close());
  assert.equal(restored.store.get('PRAGMA user_version').user_version, 2);
  const snapshot = await restored.snapshot(f.projectId);
  assert.deepEqual(snapshot.editions[0], oldEdition);
  assert.deepEqual(snapshot.candidates, before.candidates);
  assert.deepEqual(snapshot.sourcePackages, before.sourcePackages);
  assert.equal(
    snapshot.aggregates.find(
      (a) => a.kind === 'assetReview' && a.id === 'rejected'
    ).value.decision,
    'reject'
  );
  await f.service.close();
  const db = new DatabaseSync(join(f.directory, 'studio.sqlite'));
  db.exec('DROP TABLE reuse_imports; PRAGMA user_version=1');
  db.close();
  const reopened = await openStudio({ directory: f.directory });
  t.after(() => reopened.close());
  assert.deepEqual(
    (await reopened.snapshot(f.projectId)).editions[0],
    oldEdition
  );
  assert.deepEqual(
    (await reopened.snapshot(f.projectId)).candidates,
    before.candidates
  );
});
