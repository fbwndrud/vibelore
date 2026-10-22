import test from 'node:test';
import assert from 'node:assert/strict';
import { withGeneration, withStudio, generationCommand, retainPendingOutput } from './helpers/project.js';
import { png, basePixels, wav, assetImport, environmentSlot } from './helpers/images.js';
import { runWorker } from '../src/engine/worker.js';
import { openStudio } from '../src/engine/index.js';

test('import decodes actual PNG and WAV bytes into immutable ready candidates', async t => {
  const f = await withStudio(t);
  const image = await assetImport(f, 'image1', await png(basePixels));
  const audio = await assetImport(f, 'voice1', wav(), environmentSlot('audio'), 'audio');
  assert.equal(image.value.candidate.validation.status, 'passed');
  assert.equal(image.value.candidate.lineage.actor, 'artist');

  assert.deepEqual(image.value.candidate.metadata, { width: 3, height: 1, channels: 4, colourspace: 'srgb', oriented: true });

  assert.deepEqual(audio.value.candidate.metadata, { sampleRate: 24000, channels: 2, frameCount: 3, bitsPerSample: 16, codec: 'pcm', durationSeconds: 3 / 24000 });

  const s = await f.service.snapshot(f.projectId);
  assert.equal(s.candidates.length, 2);
  assert.equal(s.slots.length, 2);

  assert.deepEqual(
    [...(await f.service.readBlob(f.projectId, image.value.candidate.rawBlobId))],
    [...(await png(basePixels))]
  );
});

test(
  'malformed PNG, truncated WAV, unsupported WAV codec are quarantined with retained raw bytes',
  async t => {
    const f = await withStudio(t);
    const unsupported = wav();
    unsupported.writeUInt16LE(6, 20);

    for (const [id, bytes, kind] of [
      ['badpng', Buffer.from('private decoder error path'), 'image'],
      ['badwav', wav().subarray(0, 45), 'audio'],
      ['codec', unsupported, 'audio']
    ]) {
      const result = await assetImport(f, id, bytes, environmentSlot(id), kind);
      assert.equal(result.value.candidate, null);
      assert.equal(result.value.quarantine.status, 'quarantined');
      assert.deepEqual([...(await f.service.readBlob(f.projectId, result.value.quarantine.rawBlobId))], [...bytes]);
    }

    const s = await f.service.snapshot(f.projectId);
    assert.equal(s.candidates.length, 0);
    assert.equal(s.quarantines.length, 3);
    assert.doesNotMatch(JSON.stringify(s), /private decoder error path/);
  }
);

test(
  'worker decodes generated PNG before candidate_ready and quarantines malformed outputs',
  async t => {
    const image = await png(basePixels);

    const f = await withGeneration(t, {
      providers: {
        fake: {
          capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'] }),

          generate: async input => ({
            outputs: [{ bytes: input.prompt === 'bad' ? Buffer.from('bad') : image, mime: 'image/png' }]
          })
        }
      }
    });

    await generationCommand(f);

    await runWorker({ service: f.service, drain: true });

    let s = await f.service.snapshot(f.projectId);
    assert.equal(s.jobs[0].status, 'candidate_ready');
    assert.equal(s.candidates[0].metadata.width, 3);

    await generationCommand(f, (await import('./helpers/project.js')).validImageRequest({
      input: {
        model: 'fake-v1',
        prompt: 'bad',
        config: {}
      }
    }));

    await runWorker({ service: f.service, drain: true });

    s = await f.service.snapshot(f.projectId);
    assert.equal(s.jobs[1].status, 'quarantined');
    assert.equal(s.candidates.length, 1);
    assert.equal(s.quarantines.length, 1);
  }
);

test('reopening validates retained pending raw output without dispatch', async t => {
  const f = await withGeneration(t);
  const job = (await generationCommand(f)).value;
  await retainPendingOutput(f, await png(basePixels));
  await f.service.close();

  const reopened = await openStudio({ directory: f.directory });

  t.after(() => reopened.close());
  const s = await reopened.snapshot(f.projectId);
  assert.equal(s.jobs.find(j => j.id === job.id).status, 'candidate_ready');
  assert.equal(s.candidates.length, 1);
});

test(
  'retrieved provider outputs are actually decoded during inspection with no second generate',
  async t => {
    let generates = 0;

    const f = await withGeneration(t, {
      providers: {
        fake: {
          capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'], inspect: true }),

          generate: async () => {
            generates++;

            return { status: 'pending', operationId: 'retained' };
          },

          inspect: async () => ({
            status: 'succeeded',

            result: {
              outputs: [{ bytes: await png(basePixels), mime: 'image/png' }]
            }
          })
        }
      }
    });

    await generationCommand(f);

    await runWorker({ service: f.service, drain: true });

    const a = (await f.service.snapshot(f.projectId)).attempts[0];

    await f.command('attempt.reconcile', { attemptId: a.id, action: 'inspect' }, {
      aggregate: { kind: 'attempt', id: a.id }
    });

    const s = await f.service.snapshot(f.projectId);
    assert.equal(s.jobs[0].status, 'candidate_ready');
    assert.equal(s.candidates[0].metadata.width, 3);
    assert.equal(generates, 1);
  }
);

test('WAV samples are decoded and container inconsistencies are rejected', async () => {
  const { decodeWav } = await import('../src/assets/audio-import.js');

  const decoded = decodeWav(wav());
  assert.deepEqual([...decoded.samples], [-200 / 32768, -100 / 32768, 0, 100 / 32768, 200 / 32768, 300 / 32768]);

  for (const field of [28, 32, 40]) {
    const malformed = wav();

    if (field === 32)
      malformed.writeUInt16LE(9, field);
    else
      malformed.writeUInt32LE(9, field);

    assert.throws(() => decodeWav(malformed), { code: 'INVALID_WAV' });
  }
});

test('retained text outputs stay pending for the separate proposal validator', async t => {
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ['text'], models: ['fake-v1'] }),

        generate: async () => ({
          outputs: [{
            bytes: Buffer.from('{"proposal":"scene"}'),
            mime: 'application/json'
          }]
        })
      }
    }
  });

  const { validImageRequest } = await import('./helpers/project.js');

  await generationCommand(f, validImageRequest({ kind: 'text' }));

  await runWorker({ service: f.service, drain: true });

  await f.service.close();

  const reopened = await openStudio({ directory: f.directory });

  t.after(() => reopened.close());
  const s = await reopened.snapshot(f.projectId);
  assert.equal(s.jobs[0].status, 'pending_validation');
  assert.equal(s.candidates.length, 0);
  assert.equal(s.quarantines.length, 0);
});

test(
  'reopening quarantines retained malformed bytes without generation and preserves a detached subscriber',
  async t => {
    const f = await withGeneration(t);
    const job = (await generationCommand(f)).value;
    await retainPendingOutput(f, Buffer.from('bad png'));

    await f.command('job.cancel', { jobId: job.id }, {
      aggregate: { kind: 'job', id: job.id }
    });

    await f.service.close();
    let dispatches = 0;

    const reopened = await openStudio({
      directory: f.directory,

      providers: {
        fake: {
          generate: async () => {
            dispatches++;
          }
        }
      }
    });

    t.after(() => reopened.close());
    const s = await reopened.snapshot(f.projectId);
    assert.equal(dispatches, 0);
    assert.equal(s.quarantines.length, 1);
    assert.equal(s.candidates.length, 0);
    assert.equal(s.jobs[0].status, 'detached_in_flight');
  }
);

test(
  'legacy candidate schema migrates without rewriting existing immutable provider descriptors',
  async t => {
    const f = await withGeneration(t, {
      providers: {
        fake: {
          capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'] }),

          generate: async () => ({
            outputs: [{ bytes: await png(basePixels), mime: 'image/png' }]
          })
        }
      }
    });

    await generationCommand(f);

    await runWorker({ service: f.service, drain: true });

    const before = (await f.service.snapshot(f.projectId)).candidates[0];

    f.service.store.write(() => f.service.store.db.exec(`
    ALTER TABLE generation_candidates RENAME TO candidates_current;
    CREATE TABLE generation_candidates(project_id TEXT NOT NULL,id TEXT NOT NULL,attempt_id TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(project_id,id),FOREIGN KEY(project_id,attempt_id) REFERENCES generation_attempts(project_id,id));
    INSERT INTO generation_candidates SELECT * FROM candidates_current;
    DROP TABLE candidates_current;
  `));

    await f.service.close();

    const reopened = await openStudio({ directory: f.directory });

    t.after(() => reopened.close());

    const fixture = {
      ...f,
      service: reopened,

      command: async (type, payload, overrides) => {
        const snapshot = await reopened.snapshot(f.projectId);
        const aggregate = overrides.aggregate;

        return reopened.command({
          projectId: f.projectId,
          commandId: 'legacy-import',
          aggregate,
          expectedRevision: snapshot.aggregates.find(a => a.kind === aggregate.kind && a.id === aggregate.id)?.revision ?? 0,
          type,
          payload
        });
      }
    };

    await assetImport(fixture, 'localimport', await png(basePixels));
    const s = await reopened.snapshot(f.projectId);
    assert.equal(s.candidates.length, 2);
    assert.deepEqual(s.candidates[0], before);
    assert.equal(s.candidates[1].attemptId, null);
  }
);

test('import decode preparation cannot overwrite a concurrently accepted slot revision', async t => {
  const f = await withStudio(t);
  await assetImport(f, 'base', await png(basePixels));
  const put = f.service.blobs.put.bind(f.service.blobs);
  let release, entered, first = true;
  const gate = new Promise(r => release = r), started = new Promise(r => entered = r);

  f.service.blobs.put = async (...args) => {
    const result = await put(...args);

    if (first) {
      first = false;
      entered();
      await gate;
    }

    return result;
  };

  const work = assetImport(f, 'late', await png(basePixels));
  await started;

  await f.command('candidate.adopt', { slotId: 'background', candidateId: 'base', actor: 'artist', reason: 'accept' }, {
    aggregate: { kind: 'assetSlot', id: 'background' }
  });

  release();

  await assert.rejects(work, { code: 'REVISION_CONFLICT' });

  const s = await f.service.snapshot(f.projectId);
  assert.equal(s.candidates.length, 1);
  assert.equal(s.slots[0].candidateId, 'base');
});

test('client slot declarations cannot manufacture accepted pointers or adoption history', async t => {
  const f = await withStudio(t);

  await assert.rejects(async () => assetImport(f, 'image', await png(basePixels), {
    ...environmentSlot(),
    candidateId: 'forged',
    adoptionId: 'forgeddecision'
  }), { code: 'INVALID_INPUT' });

  const s = await f.service.snapshot(f.projectId);
  assert.equal(s.slots.length, 0);
  assert.equal(s.candidates.length, 0);
});
