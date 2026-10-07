import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, rm, writeFile, readFile, readdir, access, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { sharedSaga, SAGA_PROJECTIONS } from './fixtures/shared-lore.js';
import { scenePlan, scenePreflight } from './fixtures/webtoon-scene.js';
import { AssetCatalogStore } from '../src/store/asset-catalog-store.js';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { WebtoonStore, atomicWrite } from '../src/store/webtoon-store.js';
import { imagePolicyFor } from '../src/core/webtoon-images.js';
import { digest } from '../src/core/webtoon-contract.js';
import { inspectSceneScript, applySceneScript, resumePendingSceneScript, sceneScriptFile } from '../src/core/scene-script.js';
import { resolveProductionSource } from '../src/core/production-source.js';

const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii'); return Buffer.concat([head, data, Buffer.alloc(4)]); };
const png = (tag, w = 4, h = 4) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([tag])), chunk('IEND', Buffer.alloc(0))]); };
const exists = path => access(path).then(() => true, () => false);

async function catalogWorld() {
  const w = await sharedSaga(), files = await mkdtemp(join(tmpdir(), 'vibelore-asset-src-'));
  const file = async (name, tag) => { const path = join(files, name); await writeFile(path, png(tag)); return path; };
  const catalog = new AssetCatalogStore(w.root, 'u1');
  const proposal = await catalog.propose({ expectedHead: null, loreRevisionId: w.head, reason: '공유 인물 참조 이미지',
    profiles: [{ profileId: 'ink', label: '먹선', style: 'Ink line art with flat color.' }],
    assets: [
      { assetId: 'child-portrait', sourcePath: await file('child.png', 1), label: '유년기', entityId: 'character-a', stateIds: ['state-child'], expressionProfileId: 'ink' },
      { assetId: 'adult-portrait', sourcePath: await file('adult.png', 2), label: '성인기', entityId: 'character-a', stateIds: ['state-adult'], expressionProfileId: 'ink' },
    ] });
  const adopted = await catalog.decide({ proposalId: proposal.proposalId, expectedHead: null, decision: 'approve' });
  return { ...w, files, file, catalog, catalogHead: adopted.head, cleanup: () => Promise.all([rm(w.root, { recursive: true, force: true }), rm(files, { recursive: true, force: true })]) };
}

function rpc(project, name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, VIBELORE_MCP_SURFACE: 'public' } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`MCP timeout: ${stderr}`)); }, 20000);
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) return reject(new Error(stderr)); resolve(JSON.parse(stdout.trim().split('\n').at(-1)).result); });
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: project ? { project, ...args } : args } })}\n`);
  });
}
const ok = result => { assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent ?? result).slice(0, 1200)); return result.structuredContent; };

function sagaScript(w, workId, overrides = {}) {
  return { schemaVersion: 1, workId, scriptId: 'tower-night', title: '탑의 밤', language: 'ko', universeId: 'u1', loreRevisionId: w.head,
    registryRevisionId: w.registry.revisionId, continuityId: 'main', assetCatalogRevisionId: w.catalogHead, expressionProfileId: 'ink',
    cast: [{ localCharacterId: 'hero', entityId: 'character-a', projections: SAGA_PROJECTIONS, assetIds: ['adult-portrait', 'child-portrait'] }],
    scenes: [
      { id: 's1', frame: 'present', scope: { continuityId: 'main', timelineId: 't1', pointId: 'adulthood' }, entityIds: ['character-a'], requirements: [{ entityId: 'character-a', fieldId: 'name', required: true }],
        text: '윤재가 탑 꼭대기에서 두 개의 달을 올려다본다.\n\n"도련님, 내려오세요."' },
      { id: 's2', frame: 'flashback', scope: { continuityId: 'main', timelineId: 't1', pointId: 'childhood' }, entityIds: ['character-a'], requirements: [{ entityId: 'character-a', fieldId: 'name', required: true }],
        text: '어린 윤재가 같은 계단을 처음 올랐던 밤.' },
    ], ...overrides };
}

describe('asset catalog', () => {
  it('pins immutable bytes, keeps replaced revisions, refuses world values in profiles and recovers an interrupted approval', async t => {
    const w = await catalogWorld(); t.after(w.cleanup);
    const status = await w.catalog.status();
    assert.deepEqual(status.assets.map(a => [a.assetId, a.stateIds]).sort(), [['adult-portrait', ['state-adult']], ['child-portrait', ['state-child']]]);
    const oldAdult = status.assets.find(a => a.assetId === 'adult-portrait');
    await assert.rejects(w.catalog.propose({ expectedHead: null, loreRevisionId: w.head, reason: 'stale', assets: [{ assetId: 'x', sourcePath: await w.file('x.png', 3), label: 'x', entityId: 'character-a' }] }), { code: 'STALE_ASSET_CATALOG' });
    await assert.rejects(w.catalog.propose({ expectedHead: w.catalogHead, loreRevisionId: w.head, reason: 'leak', profiles: [{ profileId: 'leak', label: 'l', style: 's', intrinsic: { gender: 'female' } }] }), { code: 'EXPRESSION_PROFILE_OWNERSHIP' });
    const bad = join(w.files, 'fake.png'); await writeFile(bad, 'not an image at all, only text bytes');
    await assert.rejects(w.catalog.propose({ expectedHead: w.catalogHead, loreRevisionId: w.head, reason: 'bad', assets: [{ assetId: 'bad', sourcePath: bad, label: 'b', entityId: 'character-a' }] }));
    await assert.rejects(w.catalog.propose({ expectedHead: w.catalogHead, loreRevisionId: w.head, reason: 'unknown state', assets: [{ assetId: 'ghost', sourcePath: await w.file('g.png', 4), label: 'g', entityId: 'character-a', stateIds: ['state-missing'] }] }));
    // Replacement is a child revision; the old catalog revision still closes over the old bytes.
    const replace = await w.catalog.propose({ expectedHead: w.catalogHead, loreRevisionId: w.head, reason: '성인기 재작화', assets: [{ assetId: 'adult-portrait', sourcePath: await w.file('adult-v2.png', 9), label: '성인기 v2', entityId: 'character-a', stateIds: ['state-adult'], expressionProfileId: 'ink' }] });
    assert.equal(replace.assets[0].replaces, oldAdult.revisionId);
    const interrupted = w.catalog.decide({ proposalId: replace.proposalId, expectedHead: w.catalogHead, decision: 'approve', failAfterHead: true });
    await assert.rejects(interrupted, /injected asset catalog interruption/);
    assert.equal((await w.catalog.status()).recoveryPending, true);
    const recovered = await w.catalog.recover();
    assert.equal(recovered.status, 'recovered');
    const replay = await w.catalog.decide({ proposalId: replace.proposalId, expectedHead: w.catalogHead, decision: 'approve' });
    assert.equal(replay.replayed, true);
    const old = await w.catalog.closure({ catalogRevisionId: w.catalogHead, assetIds: ['adult-portrait'], expressionProfileId: 'ink' });
    assert.equal(old.assetRevisions[0].revisionId, oldAdult.revisionId);
    assert.deepEqual(await w.catalog.readBlob(oldAdult.blob.blobId), png(2));
    const current = (await w.catalog.status()).assets.find(a => a.assetId === 'adult-portrait');
    assert.notEqual(current.blob.blobId, oldAdult.blob.blobId);
  });
});

describe('standalone scene script', () => {
  it('resolves per-scene states without a novel, refuses unresolved inputs, blocks stale/drifted adoption and recovers', async t => {
    const w = await catalogWorld(), root = await mkdtemp(join(tmpdir(), 'vibelore-script-'));
    t.after(() => Promise.all([w.cleanup(), rm(root, { recursive: true, force: true })]));
    const store = new MarkdownStateStore(root), workId = 'tower-comic';
    const withRequirement = fieldId => sagaScript(w, workId, { scenes: [{ ...sagaScript(w, workId).scenes[0], requirements: [{ entityId: 'character-a', fieldId, required: true }] }] });
    await assert.rejects(inspectSceneScript({ store, workId, worldRoot: w.root, script: withRequirement('missing-field') }), { code: 'INVALID_DEFINITION_REFERENCE' });
    const unresolved = await inspectSceneScript({ store, workId, worldRoot: w.root, script: withRequirement('field-life-status') });
    assert.equal(unresolved.status, 'unresolved'); assert.ok(unresolved.blockers.length);
    const preview = await inspectSceneScript({ store, workId, worldRoot: w.root, script: sagaScript(w, workId) });
    assert.equal(preview.status, 'awaiting_approval');
    assert.deepEqual(preview.scenes.map(s => [s.id, s.frame, s.stateIds]), [['s1', 'present', { 'character-a': ['state-adult'] }], ['s2', 'flashback', { 'character-a': ['state-child'] }]]);
    assert.match(preview.contextText, /ADULT_ONLY/); assert.match(preview.contextText, /CHILD_ONLY/);
    assert.doesNotMatch(preview.contextText, /TS_ONLY|FUTURE_SECRET_TOKEN/);
    assert.deepEqual(preview.assets.map(a => [a.assetId, a.sceneIds]).sort(), [['adult-portrait', ['s1']], ['child-portrait', ['s2']]]);
    // An interruption after HEAD publication leaves the readable copy unwritten; recovery writes only the approved bytes.
    const adopted = await applySceneScript({ store, workId, proposalId: preview.proposalId, expectedHead: null });
    const file = join(root, sceneScriptFile('tower-night'));
    const approved = await readFile(file, 'utf8');
    await unlink(file);
    await writeFile(join(root, '.vibelore/scene-scripts/pending.json'), JSON.stringify({ proposalId: preview.proposalId }));
    assert.equal((await resumePendingSceneScript({ store })).status, 'recovered');
    assert.equal(await readFile(file, 'utf8'), approved);
    assert.equal(await exists(join(root, 'chapters')), false, 'no novel chapter is created');
    assert.equal(await store.loadFoundation(workId), null, 'no novel Foundation is created');
    // Stale CAS and drift.
    const next = await inspectSceneScript({ store, workId, worldRoot: w.root, script: sagaScript(w, workId, { title: '탑의 밤 (수정)' }) });
    await assert.rejects(applySceneScript({ store, workId, proposalId: next.proposalId, expectedHead: null }), { code: 'STALE_SCENE_SCRIPT' });
    await writeFile(file, `${approved}\n손수정\n`);
    await assert.rejects(applySceneScript({ store, workId, proposalId: next.proposalId, expectedHead: adopted.scriptRevisionId }), { code: 'SCENE_SCRIPT_DRIFT' });
    await assert.rejects(resolveProductionSource(store, workId, { kind: 'scene-script', scriptId: 'tower-night' }), { code: 'SCENE_SCRIPT_DRIFT' });
    await writeFile(file, approved);
    const source = await resolveProductionSource(store, workId, { kind: 'scene-script', scriptId: 'tower-night' });
    assert.equal(source.foundation, null); assert.deepEqual(source.chapters, []);
    assert.deepEqual(source.units.map(u => u.sceneId), ['s1', 's1', 's2']);
  });

  it('runs a script-based webtoon over public MCP, records sealed inputs and verifies them after the world changes and disappears', async t => {
    const w = await catalogWorld(), root = await mkdtemp(join(tmpdir(), 'vibelore-script-mcp-'));
    t.after(() => Promise.all([w.cleanup(), rm(root, { recursive: true, force: true })]));
    const workId = 'tower-comic';
    const catalogStatus = ok(await rpc(null, 'lore_assets', { action: 'status', worldRoot: w.root, universeId: 'u1' }));
    assert.equal(catalogStatus.head, w.catalogHead);
    const preview = ok(await rpc(root, 'lore_scene_script', { action: 'inspect', workId, worldRoot: w.root, script: sagaScript(w, workId) }));
    const adopted = ok(await rpc(root, 'lore_scene_script', { action: 'apply', workId, proposalId: preview.proposalId, expectedHead: preview.expectedHead }));
    assert.equal(adopted.status, 'adopted');
    const policy = imagePolicyFor('gpt-image-2.5-sunburst', 'openai-api'), repo = new WebtoonStore(new MarkdownStateStore(root));
    await atomicWrite(repo.path('image-selection.json'), JSON.stringify({ workId, policy, selection: { id: 'selected-api', workId, policyHash: digest(policy) } }));
    const start = { workId, action: 'start', scriptId: 'tower-night', panelCount: 4, direction: 'Full color comic. Original Korean lettering. AI chooses layout.',
      references: [{ id: 'adult', assetId: 'adult-portrait', description: 'Adult identity only.' }, { id: 'child', assetId: 'child-portrait', description: 'Childhood flashback identity only.' }] };
    const ambiguous = await rpc(root, 'lore_webtoon_scene', { ...start, sourceChapters: [1] });
    assert.equal(ambiguous.structuredContent.code, 'SCENE_SOURCE_AMBIGUOUS');
    const unpinned = await rpc(root, 'lore_webtoon_scene', { ...start, references: [{ id: 'ts', assetId: 'ts-portrait', description: 'Not pinned.' }] });
    assert.equal(unpinned.structuredContent.code, 'SCENE_ASSET_NOT_PINNED');
    const seen = [];
    const answer = request => { const d = JSON.parse(request.user); seen.push({ step: request.step, d });
      if (request.step === 'webtoon-scene-plan') return scenePlan(d.source);
      if (request.step === 'webtoon-scene-preflight') return scenePreflight(d);
      return { ...d.schema, observedPanelCount: 4, inspectedImages: true, spatialCoherence: true, readingOrder: true, evidence: 'Fixture inspected the imported image.',
        textObservations: d.plan.texts.map(x => ({ id: x.id, observedText: x.text, readable: true, speakerCorrect: true, evidence: 'Visible.' })) }; };
    const drive = async result => {
      for (let pass = 0; result.status === 'needs_model' && pass < 10; pass++)
        result = ok(await rpc(root, 'lore_resume', { runId: result.runId, answers: Object.fromEntries(result.requests.map(r => [r.id, JSON.stringify(answer(r))])) }));
      return result;
    };
    let result = await drive(ok(await rpc(root, 'lore_webtoon_scene', start)));
    assert.equal(result.status, 'needs_scene_image', JSON.stringify(result).slice(0, 800));
    const plan = seen.find(s => s.step === 'webtoon-scene-plan').d;
    assert.match(plan.sharedLore, /ADULT_ONLY/); assert.match(plan.sharedLore, /CHILD_ONLY/);
    assert.doesNotMatch(JSON.stringify(plan), /TS_ONLY|FUTURE_SECRET_TOKEN/);
    assert.equal(plan.foundation, null);
    assert.equal(result.references.find(r => r.id === 'adult').assetId, 'adult-portrait');
    const imagePath = join(root, 'generated.png'); await writeFile(imagePath, png(42, 8, 12));
    result = await drive(ok(await rpc(root, 'lore_webtoon_scene', { workId, asset: { path: 'generated.png', inputHash: result.jobs[0].inputHash, provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: 'selected-api' } } })));
    assert.equal(result.status, 'completed', JSON.stringify(result).slice(0, 800));
    assert.equal((await w.world.status()).head, w.head, 'webtoon completion never changes the shared world');
    assert.equal(await exists(join(root, 'chapters')), false);
    const verified = ok(await rpc(root, 'lore_webtoon_scene', { workId, action: 'verify' }));
    assert.equal(verified.status, 'verified');
    assert.equal(verified.record.source.scriptRevisionId, adopted.scriptRevisionId);
    assert.deepEqual(verified.checks.map(c => c.check), ['sealed-lock', 'reference-bytes', 'reference-bytes', 'image-bytes']);
    assert.deepEqual(verified.unpreserved, []);
    // Replace the world reference image, then delete the whole world directory: the preserved inputs still verify.
    const replace = await w.catalog.propose({ expectedHead: w.catalogHead, loreRevisionId: w.head, reason: '재작화', assets: [{ assetId: 'adult-portrait', sourcePath: await w.file('adult-v3.png', 77), label: 'v3', entityId: 'character-a', stateIds: ['state-adult'], expressionProfileId: 'ink' }] });
    await w.catalog.decide({ proposalId: replace.proposalId, expectedHead: w.catalogHead, decision: 'approve' });
    await rm(w.root, { recursive: true, force: true });
    const again = ok(await rpc(root, 'lore_webtoon_scene', { workId, action: 'verify' }));
    assert.equal(again.recordHash, verified.recordHash);
    const sealed = await readdir(join(root, '.vibelore/input-objects/blobs'));
    const bytes = await Promise.all(sealed.map(name => readFile(join(root, '.vibelore/input-objects/blobs', name))));
    assert.ok(bytes.some(b => b.equals(png(2))), 'the old adult bytes stay sealed in the work');
    // A tampered sealed blob is detected.
    await writeFile(join(root, '.vibelore/input-objects/blobs', sealed[0]), png(99));
    const tampered = await rpc(root, 'lore_webtoon_scene', { workId, action: 'verify' });
    assert.equal(tampered.isError, true);
  });
});
