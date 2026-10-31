import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { webtoonStore, workId } from '../../test/fixtures/webtoon.js';
import { png, basePixels } from './helpers/images.js';
import { hashBytes } from '../src/source/source-package.js';
import { openStudio } from '../src/engine/index.js';
import { connectVibeloreSample, sampleVoiceIntents } from '../scripts/connect-vibelore-sample.js';

async function inventory(root, prefix = '') {
  const result = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await inventory(root, name));
    else result[name] = hashBytes(await readFile(join(root, name)));
  }
  return result;
}
async function fixture(t) {
  const store = await webtoonStore({ prose: '“너는 이따 먹어.”\n\n정희의 밥은 없었다.\n\n봉투에는 합의서라고 적혀 있었다.' });
  const foundation = await store.loadFoundation(workId);
  await rm(store.characterPath('hero'));
  await store.saveFoundation({ ...foundation, characters: ['c1', 'c2', 'c3', 'c4', 'c5'].map((id, i) => ({ id, canonicalName: ['윤정희', '강태섭', '오복자', '강만식', '서유라'][i], aliases: [], registeredAtChapter: 1 })) });
  const directory = await mkdtemp(join(tmpdir(), 'studio-connected-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputDir = join(store.rootDir, 'output', 'webtoon-ep01');
  const candidate = join(store.rootDir, '.vibelore', 'webtoon', 'candidates', 'wt-final', 'r2');
  await mkdir(outputDir, { recursive: true });
  await mkdir(candidate, { recursive: true });
  const bytes = await png(basePixels);
  await writeFile(join(candidate, 'scene.png'), bytes);
  const plan = { title: '지워진 자리', panelCount: 3, texts: [
    { id: 'text-1', sourceId: 'ch-1-p-1', kind: 'dialogue', speaker: 'c3', text: '너는 이따 먹어.' },
    { id: 'text-2', sourceId: 'ch-1-p-2', kind: 'caption', speaker: 'narrator', text: '정희의 밥은 없었다.' },
    { id: 'text-3', sourceId: 'ch-1-p-3', kind: 'physical', speaker: 'c1', text: '합의서' },
  ] };
  await writeFile(join(candidate, 'scene-plan.json'), JSON.stringify(plan));
  for (const name of ['cast-reference-v1.png', 'dining-room-reference-v1.png']) await writeFile(join(outputDir, name), bytes);
  const manifest = { title: '아까는 식구 아니라면서요', episode: 1, sourceChapter: 1, sourceParagraphs: 3, totalPanels: 3, scenes: [{ number: 1, title: plan.title, workflowId: 'wt-final', revision: 2, panelCount: 3, sourceUnitIds: ['ch-1-p-1', 'ch-1-p-2', 'ch-1-p-3'], image: { path: join(candidate, 'scene.png'), hash: `sha256:${hashBytes(bytes)}`, provenance: { kind: 'api', provider: 'openai', requestedModel: 'source-model' } } }] };
  const manifestPath = join(outputDir, 'episode-01-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { sourceRoot: store.rootDir, directory, output: join(directory, 'receipt'), projectId: 'sample', workId, voiceIntents: sampleVoiceIntents, manifest, manifestPath, plan, store };
}

test('connects original IDs, cited speech and verified final raster through public commands without source writes or generation', async t => {
  const f = await fixture(t), before = await inventory(f.sourceRoot);
  await connectVibeloreSample({ ...f, manifest: f.manifestPath });
  assert.deepEqual(await inventory(f.sourceRoot), before);
  const service = await openStudio({ directory: f.directory });
  t.after(() => service.close());
  const s = await service.snapshot(f.projectId);
  assert.equal(s.project.title, '아까는 식구 아니라면서요');
  assert.equal(s.sourcePackages[0].textUnits[0].id, 'ch-1-p-1');
  assert.deepEqual(s.cast.filter(r => r.characterId).map(r => r.characterId).sort(), ['c1', 'c2', 'c3', 'c4', 'c5']);
  const scene = s.scenes[0];
  assert.deepEqual(scene.sourceUnitIds, ['ch-1-p-1', 'ch-1-p-2', 'ch-1-p-3']);
  assert.deepEqual(scene.utterances.map(u => u.text), ['너는 이따 먹어.', '정희의 밥은 없었다.']);
  assert.equal(scene.occurrences.find(o => o.id === scene.utterances[0].speakerOccurrenceId).characterId, 'c3');
  assert.deepEqual(scene.utterances[0].sourceUnitIds, ['ch-1-p-1']);
  assert.equal(scene.utterances[1].sourceTextKind, 'caption');
  assert.equal(scene.shots.length, 1);
  assert.match(scene.shots[0].title, /전체.*3칸/);
  const image = s.candidates.find(c => c.slotId === scene.shots[0].referenceSlotId);
  assert.equal(image.rawBlobId, f.manifest.scenes[0].image.hash.slice(7));
  assert.equal(image.lineage.kind, 'import');
  assert.equal(image.attemptId, null);
  assert.equal(new Set(s.resolvedBindings.map(b => b.casting.voice)).size, 6);
  assert.equal(s.jobs.length, 0);
  assert.equal(s.attempts.length, 0);
  assert.equal(s.budget.budgetMicros, 0);
});

test('rerun preserves creator scene, speech and slot decisions without extra events or adoptions, and refuses changed source', async t => {
  const f = await fixture(t), options = { ...f, manifest: f.manifestPath };
  await connectVibeloreSample(options);
  const service = await openStudio({ directory: f.directory });
  t.after(() => service.close());
  let s = await service.snapshot(f.projectId);
  const scene = s.scenes[0], slot = s.slots.find(x => x.id === scene.shots[0].referenceSlotId);
  async function edit(type, kind, id, payload) {
    s = await service.snapshot(f.projectId);
    await service.command({ projectId: f.projectId, commandId: `user-${type.replaceAll('.', '-')}`, aggregate: { kind, id }, expectedRevision: s.aggregates.find(a => a.kind === kind && a.id === id)?.revision ?? 0, type, payload });
  }
  await edit('scene.put', 'scene', scene.id, { ...scene, title: '작가가 바꾼 장면' });
  await edit('utterance.update', 'utterance', scene.utterances[0].id, { id: scene.utterances[0].id, sceneId: scene.id, text: '작가가 고친 대사' });
  await edit('adoption.undo', 'assetSlot', slot.id, { slotId: slot.id, adoptionId: slot.adoptionId, actor: 'creator', reason: '직접 되돌린 이미지' });
  const before = await service.snapshot(f.projectId), events = await service.events(f.projectId);
  await connectVibeloreSample(options);
  const after = await service.snapshot(f.projectId);
  assert.equal(after.scenes[0].title, '작가가 바꾼 장면');
  assert.equal(after.scenes[0].utterances[0].text, '작가가 고친 대사');
  assert.deepEqual(after.slots, before.slots);
  assert.equal(after.adoptions.length, before.adoptions.length);
  assert.deepEqual(await service.events(f.projectId), events);
  await writeFile(f.store.chapterPath(1), (await readFile(f.store.chapterPath(1), 'utf8')).replace('너는 이따 먹어.', '너는 이따 먹어. 새로운 문장'));
  await assert.rejects(connectVibeloreSample(options), { code: 'SOURCE_CONNECTION_CHANGED' });
  assert.deepEqual(await service.events(f.projectId), events);
});

test('rejects final image hash, final version and source text mismatches before mutating Studio', async t => {
  for (const [kind, code] of [['hash', 'SOURCE_IMAGE_HASH_MISMATCH'], ['version', 'SOURCE_FINAL_VERSION_MISMATCH'], ['text', 'SOURCE_TEXT_MISMATCH']]) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'hash') f.manifest.scenes[0].image.hash = `sha256:${'0'.repeat(64)}`;
    if (kind === 'version') {
      await mkdir(join(dirname(f.manifest.scenes[0].image.path), '..', 'r3'));
      await writeFile(join(dirname(f.manifest.scenes[0].image.path), '..', 'r3', 'scene.png'), await readFile(f.manifest.scenes[0].image.path));
      f.manifest.scenes[0].revision = 3;
    }
    if (kind === 'text') {
      f.plan.texts[0].text = '근거에 없는 대사';
      await writeFile(join(dirname(f.manifest.scenes[0].image.path), 'scene-plan.json'), JSON.stringify(f.plan));
    }
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    const sourceBefore = await inventory(f.sourceRoot), storageBefore = await inventory(f.directory);
    await assert.rejects(connectVibeloreSample({ ...f, manifest: f.manifestPath }), { code });
    assert.deepEqual(await inventory(f.sourceRoot), sourceBefore);
    assert.deepEqual(await inventory(f.directory), storageBefore);
  });
});

test('resumes after its own project creation, refuses unrelated projects and source storage overlap', async t => {
  const f = await fixture(t), options = { ...f, manifest: f.manifestPath };
  await connectVibeloreSample(options);
  const completed = await openStudio({ directory: f.directory });
  const firstEvent = (await completed.events(f.projectId))[0];
  await completed.close();
  const partial = join(f.directory, 'partial');
  const service = await openStudio({ directory: partial });
  await service.command({ projectId: f.projectId, commandId: firstEvent.commandId, aggregate: firstEvent.aggregate, expectedRevision: 0, type: firstEvent.type, payload: { title: firstEvent.value.title, language: firstEvent.value.language, budgetMicros: firstEvent.value.budgetMicros } });
  await service.close();
  await connectVibeloreSample({ ...options, directory: partial });
  const connected = await openStudio({ directory: partial });
  assert.equal((await connected.snapshot(f.projectId)).scenes.length, 1);
  await connected.close();
  const unrelated = join(f.directory, 'unrelated');
  const other = await openStudio({ directory: unrelated });
  await other.command({ projectId: f.projectId, commandId: 'creator-project', aggregate: firstEvent.aggregate, expectedRevision: 0, type: firstEvent.type, payload: { title: firstEvent.value.title, language: 'ko', budgetMicros: 0 } });
  await other.close();
  await assert.rejects(connectVibeloreSample({ ...options, directory: unrelated }), { code: 'PROJECT_CONNECTION_CONFLICT' });
  await assert.rejects(connectVibeloreSample({ ...options, directory: join(f.sourceRoot, 'studio-storage') }), { code: 'SOURCE_DESTINATION_OVERLAP' });
  await assert.rejects(connectVibeloreSample({ ...options, voiceIntents: null }), { code: 'SAMPLE_VOICE_SCOPE_REQUIRED' });
});
