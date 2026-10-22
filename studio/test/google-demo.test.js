import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withGeneration } from './helpers/project.js';
import { png, basePixels, wav } from './helpers/images.js';
import { interaction } from './helpers/google-http.js';
import { convertGoogleDemo, voiceIntents } from '../scripts/google-demo.js';

test('opt-in first-cue runner persists Google provenance and safely resumes without another request', async t => {
  const f = await withGeneration(t);
  const roles = Object.keys(voiceIntents);
  for (const id of roles) await f.command('cast.put', { id, name: id, language: 'ko', characterId: null }, { aggregate: { kind: 'cast', id } });
  const origin = {
    id: 'source-scene', productionId: 'main', occurrences: roles.map(id => ({ id: `o-${id}`, roleBindingId: id, characterId: null, presence: id === 'narrator' ? 'narrator' : id === 'driver' ? 'offscreen' : 'onscreen' })),
    presentations: roles.map(id => ({ occurrenceId: `o-${id}`, appearanceStateRef: null, castingStateRef: null, knowledgeStateRef: null })),
    utterances: Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, speakerOccurrenceId: `o-${roles[i % 6]}`, addresseeOccurrenceIds: [], text: `한국어 대사 ${i}` })),
    shots: Array.from({ length: 6 }, (_, i) => ({ id: `shot${i}`, referenceSlotId: `image${i}` })),
  };
  const assets = join(f.directory, 'fixture'), output = join(f.directory, 'output');
  await mkdir(assets);
  await writeFile(join(assets, 'landscape-closure.json'), JSON.stringify({ closure: { sourcePackage: { id: null }, scenes: [origin] } }));
  for (let i = 0; i < 6; i++) await writeFile(join(assets, `art-${i}.png`), await png(basePixels));
  let calls = 0;
  const options = { directory: f.directory, projectId: 'p1', assets, output, key: 'test-key-only', phase: 'first', fetchImpl: async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gemini-3.8-flash-tts');
    assert.equal(body.input[0].content[0].text, '한국어 대사 0');
    assert.equal(body.input[0].content[0].annotations[0].type, 'speech_metadata');
    assert.equal(body.generation_config.speech_config[0].voice, 'Kore');
    return new Response(JSON.stringify(interaction([{ type: 'audio', mime_type: 'audio/wav', data: wav().toString('base64') }], { model: 'gemini-3.8-flash-tts' })));
  } };
  await convertGoogleDemo(options);
  await convertGoogleDemo(options);
  assert.equal(calls, 1);
  const s = await f.service.snapshot('p1');
  const scene = s.scenes.find(x => x.id === 'google-scene');
  assert.deepEqual(scene.utterances.map(u => u.text), origin.utterances.map(u => u.text));
  assert.equal(new Set(Object.values(voiceIntents).map(x => x.voice)).size, 6);
  assert.equal(scene.occurrences.filter(o => o.presence === 'onscreen').length, 4);
  const receipt = JSON.parse(await readFile(join(output, 'live-receipt.json')));
  assert.equal(receipt.candidates.length, 1);
  assert.equal(receipt.candidates[0].lineage.kind, 'provider');
  assert.ok(receipt.attempts[0].operationId);
  assert.equal(receipt.reservations[0].status, 'held_unknown');
  assert.equal(receipt.actualBillingVerified, false);
  assert.equal(JSON.stringify(receipt).includes('test-key-only'), false);
  const rejected = { ...options, cue: 1, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'private billing text' } }), { status: 402 });
  } };
  await assert.rejects(convertGoogleDemo(rejected), /Stopped without retry/);
  await assert.rejects(convertGoogleDemo(rejected), /Stopped without retry/);
  assert.equal(calls, 2, 'unknown cue is never dispatched again on rerun');
  const stopped = JSON.parse(await readFile(join(output, 'live-receipt.json')));
  assert.deepEqual(stopped.attempts[1].providerFailure, { code: 'PROVIDER_REJECTED', httpStatus: 402 });
  assert.equal(stopped.reservations[1].status, 'held_unknown');
  assert.equal(JSON.stringify(stopped).includes('private billing text'), false);
});

test('runner render recovery retains failed output and reuses a completed render of the same frozen edition', async t => {
  const { audioFixture } = await import('./helpers/render-fixture.js');
  const { renderGoogleEdition } = await import('../scripts/google-demo.js');
  const f = await audioFixture(t);
  const edition = (await f.command('edition.create', { id: 'fixed', productionId: 'main', profile: 'audio' }, { aggregate: { kind: 'edition', id: 'fixed' } })).value;
  let calls = 0;
  f.service.renderer = async () => { calls++; throw Error('temporary renderer failure'); };
  const command = async (type, kind, id, payload) => (await f.command(type, payload, { aggregate: { kind, id } })).value;
  const options = { service: f.service, projectId: f.projectId, edition, command };
  assert.equal(typeof renderGoogleEdition, 'function');
  const failed = await renderGoogleEdition(options);
  assert.equal(failed.status, 'failed');
  f.service.renderer = async ({ edition, readBlob }) => { calls++; return { bytes: await readBlob(edition.closure.mix.blobId), frames: [] }; };
  const recovered = await renderGoogleEdition(options);
  assert.equal(recovered.status, 'completed');
  assert.notEqual(recovered.id, failed.id);
  assert.equal(recovered.closureDigest, edition.closureDigest);
  assert.deepEqual(await renderGoogleEdition(options), recovered);
  assert.equal(calls, 2);
  const s = await f.service.snapshot(f.projectId);
  assert.equal(s.aggregates.find(a => a.kind === 'editionOutput' && a.id === failed.id).value.status, 'failed');
});
