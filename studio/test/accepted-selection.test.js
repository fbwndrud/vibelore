import test from 'node:test';
import assert from 'node:assert/strict';
import { audioFixture, tone } from './helpers/render-fixture.js';
import { generationCommand, validImageRequest } from './helpers/project.js';
import { png, basePixels, environmentSlot } from './helpers/images.js';
import { runWorker } from '../src/engine/worker.js';

const create = (f, id = 'accepted', profile = 'audio') => f.command('edition.create', {
  id, productionId: 'main', profile
}, { aggregate: { kind: 'edition', id } });
const timeline = f => f.command('timeline.update', { productionId: 'main' }, {
  aggregate: { kind: 'timeline', id: 'main' }
});

async function sharedAudio(t) {
  const f = await audioFixture(t);
  f.service.providers.fake.generate = async () => ({ outputs: [{ bytes: tone(), mime: 'audio/wav' }] });
  const requests = ['u1', 'u2'].map(id => validImageRequest({
    kind: 'audio', target: { kind: 'utterance', id },
    input: { model: 'fake-v1', prompt: '같은 대사', config: {} }
  }));
  const jobs = await Promise.all(requests.map(r => generationCommand(f, r)));
  assert.equal(jobs[0].value.id, jobs[1].value.id);
  await runWorker({ service: f.service, drain: true });
  const candidate = (await f.service.snapshot('p1')).candidates.find(c => c.jobId);
  for (const r of requests) await f.command('candidate.adopt', {
    slotId: `take-${r.target.id}`, candidateId: candidate.id, subscriberId: r.subscriberId,
    actor: 'creator', reason: 'Explicitly accept this subscriber destination'
  }, { aggregate: { kind: 'assetSlot', id: `take-${r.target.id}` } });
  return { f, candidate, requests, job: jobs[0].value };
}

test('accepted subscriber audio reaches timeline, frozen Edition and actual WAV with original provenance', async t => {
  const { f, candidate, requests } = await sharedAudio(t);
  const result = await timeline(f);
  assert.deepEqual(result.value.resolved.takes.slice(0, 2).map(x => x.candidateId), [candidate.id, candidate.id]);
  const e = (await create(f)).value;
  assert.equal(e.closure.timeline.durationFrames, 150);
  const out = (await f.command('edition.render', { editionId: e.id, renderId: 'wav' }, {
    aggregate: { kind: 'editionOutput', id: 'wav' }
  })).value;
  assert.equal(out.status, 'completed');
  assert.equal(out.manifest.checks.decodedAudio, true);
  const s = await f.service.snapshot('p1');
  assert.deepEqual(s.candidates.find(c => c.id === candidate.id), candidate);
  assert.equal(candidate.target.id, 'u1');
  assert.equal(s.adoptions.find(a => a.subscriberId === requests[1].subscriberId).authorization.target.id, 'u2');
  // Retained selections permit timing edits without retroactively rerunning dispatch pins.
  await f.command('utterance.update', { id: 'u2', holdMs: 500 }, { aggregate: { kind: 'utterance', id: 'u2' } });
  assert.equal((await create(f, 'hold')).value.closure.timeline.durationFrames, 165);
});

for (const change of ['text', 'acting', 'voice', 'state', 'source']) test(`accepted subscriber audio rejects changed ${change} at consumption`, async t => {
  const { f } = await sharedAudio(t);
  // Establish a valid accepted closure before changing one semantic input.
  await create(f);
  if (change === 'text' || change === 'acting') await f.command('utterance.update', {
    id: 'u2', [change]: change === 'text' ? '바뀐 대사' : { tone: 'angry' }
  }, { aggregate: { kind: 'utterance', id: 'u2' } });
  if (change === 'voice') await f.command('casting.set', {
    id: 'narrow', scope: 'occurrence', productionId: 'main', sceneId: 'scene',
    occurrenceId: 'speaker', roleId: 'actor', state: 'childvoice', voice: 'new-voice'
  }, { aggregate: { kind: 'casting', id: 'narrow' } });
  if (change === 'state') {
    const scene = (await f.service.snapshot('p1')).scenes[0];
    scene.presentations[0].castingStateRef = 'adult';
    await f.command('scene.put', scene, { aggregate: { kind: 'scene', id: 'scene' } });
  }
  if (change === 'source') {
    const { makeSourcePackage } = await import('../src/source/source-package.js');
    const pkg = makeSourcePackage({ sourceKind: 'studio-script', sourceRevision: 'v2', textUnits: [], sceneScopes: [], sourceIdentityMap: [], revealPolicy: {}, blobManifest: [], preservationStatus: { actualSourceBytes: 'complete' } });
    await f.command('source.import', { package: pkg, blobs: [] }, { aggregate: { kind: 'sourcePackage', id: pkg.id } });
    const proposal = await f.command('source.rebase', { productionId: 'main', sourcePackageId: pkg.id, actor: 'creator', reason: 'New source' }, { aggregate: { kind: 'sourceBinding', id: 'main' } });
    await f.command('source.rebase', { productionId: 'main', decisionId: proposal.value.id, action: 'apply', actor: 'creator', reason: 'New source', choices: [{ sceneId: 'scene', action: 'replan' }] }, { aggregate: { kind: 'sourceBinding', id: 'main' } });
  }
  const code = change === 'source' ? 'SOURCE_BINDING_STALE' : change === 'state' ? 'CASTING_UNRESOLVED' : 'SLOT_CONFLICT';
  await assert.rejects(timeline(f), { code });
  await assert.rejects(create(f, 'changed'), { code });
});

async function sharedImages(t, subject = null) {
  const f = await audioFixture(t);
  f.service.providers.fake = {
    capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'] }),
    generate: async () => ({ outputs: [{ bytes: await png(basePixels), mime: 'image/png' }] })
  };
  const requests = ['shot', 'shot2'].map(id => validImageRequest({
    target: { kind: 'shot', id },
    ...(subject ? { recipe: { operation: 'generate', assetIntent: { subject: { kind: 'role', id: 'actor' }, appearanceStateRef: 'adult' } } } : {})
  }));
  const a = await generationCommand(f, requests[0]), b = await generationCommand(f, requests[1]);
  assert.equal(a.value.id, b.value.id);
  await runWorker({ service: f.service, drain: true });
  const candidate = (await f.service.snapshot('p1')).candidates.find(c => c.mediaKind === 'image');
  for (const r of requests) {
    const slot = environmentSlot(`picture-${r.target.id}`, r.target);
    if (subject) Object.assign(slot, { subject: { kind: 'role', id: 'actor' }, appearanceStateRef: 'adult' });
    await f.command('candidate.adopt', { slotId: slot.id, slot, candidateId: candidate.id, subscriberId: r.subscriberId, actor: 'creator', reason: 'Review each shot' }, { aggregate: { kind: 'assetSlot', id: slot.id } });
  }
  const scene = (await f.service.snapshot('p1')).scenes[0];
  scene.shots = scene.shots.map(sh => ({ ...sh, referenceSlotId: `picture-${sh.id}` }));
  await f.command('scene.put', scene, { aggregate: { kind: 'scene', id: 'scene' } });
  return { f, candidate };
}

test('accepted cross-shot image subscribers survive explicit shot assignment into Edition without rewriting origin', async t => {
  const { f, candidate } = await sharedImages(t);
  const e = (await create(f, 'film', 'landscape')).value;
  assert.deepEqual(e.closure.shots.map(s => s.candidateId), [candidate.id, candidate.id]);
  assert.deepEqual(e.closure.shots.map(s => s.slotId), ['picture-shot', 'picture-shot2']);
  assert.deepEqual((await f.service.snapshot('p1')).candidates.find(c => c.id === candidate.id), candidate);
});

test('accepted cross-shot image still rejects a changed appearance presentation', async t => {
  const { f } = await sharedImages(t, 'actor');
  await create(f, 'film', 'landscape');
  const scene = (await f.service.snapshot('p1')).scenes[0];
  scene.presentations[0].appearanceStateRef = 'childvoice';
  await f.command('scene.put', scene, { aggregate: { kind: 'scene', id: 'scene' } });
  await assert.rejects(create(f, 'changed', 'landscape'), { code: 'INVALID_REFERENCE' });
});

test('explicit timing-only subscriber reuse continues through Edition with immutable original candidate', async t => {
  const { f, candidate, requests, job } = await sharedAudio(t);
  await f.command('utterance.update', { id: 'u2', holdMs: 250 }, { aggregate: { kind: 'utterance', id: 'u2' } });
  const reuse = { ...requests[1], subscriberId: 'timing-reuse', jobId: job.id, allowTimingChanges: true };
  await f.command('job.reuse', reuse, { aggregate: { kind: 'generation', id: reuse.subscriberId } });
  await f.command('candidate.adopt', { slotId: 'take-u2', candidateId: candidate.id, subscriberId: reuse.subscriberId, actor: 'creator', reason: 'Explicit timing reuse' }, { aggregate: { kind: 'assetSlot', id: 'take-u2' } });
  await timeline(f);
  assert.equal((await create(f)).value.closure.timeline.durationFrames, 158);
  assert.equal((await f.service.snapshot('p1')).attempts.length, 1);
});

test('undo restores the subscriber-authorized selection through Edition, and cancellation does not revoke accepted media', async t => {
  const { assetImport } = await import('./helpers/images.js');
  const { audioTakeSlot } = await import('./helpers/project.js');
  const { f, candidate, job, requests } = await sharedAudio(t);
  await assetImport(f, 'replacement', tone(), audioTakeSlot('take-u2', 'u2'), 'audio');
  const adopted = await f.command('candidate.adopt', { slotId: 'take-u2', candidateId: 'replacement', actor: 'creator', reason: 'Compare replacement' }, { aggregate: { kind: 'assetSlot', id: 'take-u2' } });
  await f.command('adoption.undo', { slotId: 'take-u2', adoptionId: adopted.value.adoptionId, actor: 'creator', reason: 'Restore accepted subscriber take' }, { aggregate: { kind: 'assetSlot', id: 'take-u2' } });
  await f.command('job.cancel', { jobId: job.id, subscriberId: requests[1].subscriberId }, { aggregate: { kind: 'job', id: job.id } });
  const e = (await create(f)).value;
  assert.equal(e.closure.timeline.takes[1].candidateId, candidate.id);
});

test('a selection changing during actual audio decode cannot freeze an obsolete acceptance receipt', async t => {
  const { f } = await sharedAudio(t);
  const original = f.service.blobs.read.bind(f.service.blobs);
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  let first = true;
  f.service.blobs.read = async (...args) => {
    const bytes = await original(...args);
    if (first) { first = false; began(); await barrier; }
    return bytes;
  };
  const pending = create(f);
  await started;
  await f.command('candidate.adopt', { slotId: 'take-u2', candidateId: 'audio-u2', actor: 'creator', reason: 'Choose another accepted take during preparation' }, { aggregate: { kind: 'assetSlot', id: 'take-u2' } });
  release();
  await assert.rejects(pending, { code: 'INPUT_STALE' });
  assert.equal((await f.service.snapshot('p1')).editions.length, 0);
});

test('accepted protected composite retains its exact-pixel proof through image Edition resolution', async t => {
  const { videoFixture } = await import('./helpers/render-fixture.js');
  const { assetImport, driftPixels, maskPixels, identityGeometry } = await import('./helpers/images.js');
  const f = await videoFixture(t);
  await assetImport(f, 'raw', await png(driftPixels), environmentSlot('picture'));
  await f.command('asset.derive', { id: 'composite', slotId: 'picture', baseCandidateId: 'picture1', candidateId: 'raw', actor: 'creator', operation: 'protected_edit', geometry: identityGeometry, maskBytes: [...await png(maskPixels)] }, { aggregate: { kind: 'assetSlot', id: 'picture' } });
  await f.command('candidate.adopt', { slotId: 'picture', candidateId: 'composite', actor: 'creator', reason: 'Accept verified composite' }, { aggregate: { kind: 'assetSlot', id: 'picture' } });
  const e = (await create(f, 'protected', 'landscape')).value;
  assert.ok(e.closure.shots.every(sh => sh.candidateId === 'composite'));
  assert.equal(e.closure.assets.find(a => a.id === 'composite').lineage.kind, 'protected_edit');
});
