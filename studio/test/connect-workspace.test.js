import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { webtoonStore, workId } from '../../test/fixtures/webtoon.js';
import { png, basePixels } from './helpers/images.js';
import { hashBytes } from '../src/source/source-package.js';
import { openStudio } from '../src/engine/index.js';

async function fixture(t, sourceId = 'hero', prose = '“안에 있나요?”\n\n문 앞에 멈췄다.') {
  const store = await webtoonStore({ prose });
  if (sourceId !== 'hero') {
    const foundation = await store.loadFoundation(workId);
    await rm(store.characterPath('hero'));
    await store.saveFoundation({ ...foundation, characters: foundation.characters.map(c => ({ ...c, id: sourceId })) });
  }
  const directory = await mkdtemp(join(tmpdir(), 'studio-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(store.rootDir, 'production-workspaces', 'ep01');
  const files = join(workspace, '.vibelore/webtoon/candidates/wt-real/r1');
  await mkdir(files, { recursive: true });
  await mkdir(join(workspace, '.vibelore/webtoon/workflows'), { recursive: true });
  const image = await png(basePixels), reference = await sharp(image).jpeg().toBuffer();
  const referencePath = join(workspace, 'hero.jpg');
  await writeFile(referencePath, reference);
  await writeFile(join(files, 'scene.png'), image);
  const plan = { title: '문 앞', panelCount: 2, texts: [{ id: 'text-1', sourceId: 'ch-1-p-1', kind: 'dialogue', speaker: sourceId, text: '안에 있나요?' }, { id: 'text-2', sourceId: 'ch-1-p-1', kind: 'thought', speaker: sourceId, text: '안에 있나요?' }, { id: 'text-3', sourceId: 'ch-1-p-1', kind: 'sfx', speaker: 'narrator', text: '안에' }] };
  const planBytes = Buffer.from(JSON.stringify(plan));
  await writeFile(join(files, 'scene-plan.json'), planBytes);
  await writeFile(join(workspace, '.vibelore/webtoon/workflows/wt-real.json'), JSON.stringify({ workflowId: 'wt-real', stage: 'completed', revision: 1, panelCount: 2, sceneUnits: [{ id: 'ch-1-p-1', chapter: 1 }], artifacts: { 'scene.png': { path: join(files, 'scene.png'), hash: `sha256:${hashBytes(image)}` }, 'scene-plan.json': { path: join(files, 'scene-plan.json'), hash: `sha256:${hashBytes(planBytes)}` } }, sceneReferences: [{ id: 'ref-hero', path: referencePath, hash: `sha256:${hashBytes(reference)}` }] }));
  return { sourceRoot: store.rootDir, workspaceRoot: workspace, directory, output: join(directory, 'connection'), projectId: 'real', workId, title: 'Real work', voiceIntents: { [sourceId]: { voice: 'Orus', style: '차분하게' }, narrator: { voice: 'Sulafat', style: '담담하게' } }, referenceBindings: { 'ref-hero': { subject: { kind: 'identity', id: sourceId }, label: '주인공 개별 참조' } }, store, referencePath };
}

test('connects an existing workspace with distinct JPEG references, exact canon citations and no source writes; replay preserves edits', async t => {
  const { connectWebtoonWorkspace } = await import('../scripts/connect-workspace.js');
  const f = await fixture(t), chapterBefore = await readFile(f.store.chapterPath(1));
  await connectWebtoonWorkspace(f);
  const service = await openStudio({ directory: f.directory });
  let s = await service.snapshot('real');
  assert.equal(s.project.title, 'Real work');
  assert.equal(s.sourcePackages[0].sourceIdentityMap[0].id, 'hero');
  assert.equal(s.scenes[0].utterances[0].text, '안에 있나요?');
  assert.equal(s.scenes[0].utterances.length, 2, 'Internal speech is retained; sound effects are not spoken dialogue');
  assert.equal(s.scenes[0].utterances[1].sourceTextKind, 'thought');
  assert.equal(s.scenes[0].utterances[0].speakerOccurrenceId, 'ep01-scene-1-hero');
  const slot = s.slots.find(x => x.subject.kind === 'identity');
  assert.equal(slot.scope.kind, 'project');
  const candidate = s.candidates.find(x => x.id === slot.candidateId);
  assert.equal(candidate.mime, 'image/png');
  const asset = s.sourcePackages[0].assets.find(x => x.id === slot.id);
  assert.equal(asset.provenance.sourceDeclaration.originalHash, `sha256:${hashBytes(await readFile(f.referencePath))}`);
  assert.equal(s.jobs.length, 0);
  await service.command({ projectId: 'real', commandId: 'creator-edit', type: 'scene.put', aggregate: { kind: 'scene', id: s.scenes[0].id }, expectedRevision: 1, payload: { ...s.scenes[0], title: '직접 편집' } });
  const count = (await service.events('real')).length;
  await service.close();
  await connectWebtoonWorkspace(f);
  const reopened = await openStudio({ directory: f.directory });
  t.after(() => reopened.close());
  s = await reopened.snapshot('real');
  assert.equal(s.scenes[0].title, '직접 편집');
  assert.equal((await reopened.events('real')).length, count);
  assert.deepEqual(await readFile(f.store.chapterPath(1)), chapterBefore);
});

test('rejects changed reference bytes before creating a Studio project', async t => {
  const { connectWebtoonWorkspace } = await import('../scripts/connect-workspace.js');
  const f = await fixture(t);
  await writeFile(f.referencePath, 'changed');
  await assert.rejects(connectWebtoonWorkspace(f), { code: 'SOURCE_IMAGE_HASH_MISMATCH' });
  const service = await openStudio({ directory: f.directory });
  t.after(() => service.close());
  await assert.rejects(service.snapshot('real'), { code: 'PROJECT_NOT_FOUND' });
});

test('normalizes external Lore identity IDs consistently for reference images, cast and scene speakers', async t => {
  const { connectWebtoonWorkspace } = await import('../scripts/connect-workspace.js');
  const f = await fixture(t, 'h'.repeat(121));
  await connectWebtoonWorkspace(f);
  const service = await openStudio({ directory: f.directory });
  t.after(() => service.close());
  const s = await service.snapshot('real'), identity = s.sourcePackages[0].sourceIdentityMap[0];
  assert.equal(identity.sourceCharacterId, 'h'.repeat(121));
  assert.notEqual(identity.id, 'h'.repeat(121));
  assert.equal(s.scenes[0].occurrences.find(o => o.presence === 'onscreen').roleBindingId, identity.id);
  assert.equal(s.slots.find(x => x.subject.kind === 'identity').subject.id, identity.id);
  assert.equal(s.resolvedBindings[0].casting.voice, 'Orus');
});

 test('retains completed lettering across prose emphasis and Unicode composition', async t => {
  const { connectWebtoonWorkspace } = await import('../scripts/connect-workspace.js');
  const f = await fixture(t, 'hero', '“안에 **있나요**?”'.normalize('NFD'));
  await connectWebtoonWorkspace(f);
  const service = await openStudio({ directory: f.directory });
  t.after(() => service.close());
  const s = await service.snapshot('real');
  assert.equal(s.scenes[0].utterances[0].text, '안에 있나요?');
  assert.equal(s.scenes[0].utterances[0].citations[0].sourceUnitId, s.sourcePackages[0].textUnits[0].id);
});

for (const length of [100, 120]) test(`connects allowed ${length}-character Lore IDs without overflowing composed IDs`, async t => {
  const { connectWebtoonWorkspace } = await import('../scripts/connect-workspace.js');
  const f = await fixture(t, 'h'.repeat(length));
  await connectWebtoonWorkspace(f);
  const service = await openStudio({ directory: f.directory });
  t.after(() => service.close());
  const s = await service.snapshot('real');
  assert.equal(s.scenes[0].occurrences[0].roleBindingId, 'h'.repeat(length));
  assert.equal(s.resolvedBindings[0].casting.voice, 'Orus');
});
