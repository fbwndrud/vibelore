// Existing canon and completed webtoon workflows are read only. All destination
// changes use Studio commands; no writing or regeneration of Lore artifacts.
import { readFile, readdir, realpath, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, basename, sep } from 'node:path';
import sharp from 'sharp';
import { containsLettering } from '../../src/core/webtoon-scene.js';
import { MarkdownStateStore } from '../../src/store/markdown-store.js';
import { exportVibeloreSource } from '../src/source/vibelore-connector.js';
import { hashBytes, makeSourcePackage, registerSourceCaptureCommands } from '../src/source/source-package.js';
import { assertId, fail, STABLE_ID } from '../src/engine/contracts.js';
import { openStudio } from '../src/engine/index.js';
import { decodeMedia } from '../src/assets/decode.js';

const composedId = value => STABLE_ID.test(value) ? value : `joined_${hashBytes(Buffer.from(value))}`;
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`);
async function location(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await location(dirname(path)), basename(path));
  }
}

export async function connectWebtoonWorkspace({ sourceRoot, workspaceRoot, directory, output, projectId, workId, title, chapters = [1], voiceIntents, referenceBindings = {} }) {
  assertId(projectId); assertId(workId);
  const root = await realpath(sourceRoot), workspace = await realpath(workspaceRoot);
  if (!inside(root, workspace)) fail('SOURCE_PATH_OUTSIDE_ROOT', 'Workspace must belong to this work.');
  for (const path of [directory, output]) {
    const target = await location(resolve(path));
    if (inside(root, target) || inside(target, root)) fail('SOURCE_DESTINATION_OVERLAP', 'Studio output must be outside canon.');
  }
  const captureCanon = () => exportVibeloreSource({ store: new MarkdownStateStore(root), workId, request: { kind: 'novel-chapters', chapters } });
  const exported = await captureCanon(), identities = exported.package.sourceIdentityMap;
  if (!voiceIntents?.narrator || identities.some(i => !voiceIntents[i.sourceCharacterId])) fail('SAMPLE_VOICE_SCOPE_REQUIRED', 'Explicit voices for this work are required.');
  const identityIds = new Map(identities.map(i => [i.sourceCharacterId, i.id]));
  const roleId = sourceId => sourceId === 'narrator' ? sourceId : identityIds.get(sourceId);
  const pkgId = 'connected-source', productionId = 'ep01';
  const units = new Map(exported.package.textUnits.map(u => [u.sourceUnitId, u]));
  const captures = new Map(), assets = [], plans = [], excluded = [];
  async function capture(path, expectedHash) {
    const actual = await realpath(path);
    if (!inside(root, actual)) fail('SOURCE_PATH_OUTSIDE_ROOT', 'Selected artifact escaped canon.');
    const bytes = await readFile(actual), blobId = hashBytes(bytes);
    if (expectedHash !== `sha256:${blobId}`) fail('SOURCE_IMAGE_HASH_MISMATCH', 'Declared artifact bytes changed.');
    captures.set(actual, { bytes, blobId });
    return { bytes, blobId };
  }
  const workflows = join(workspace, '.vibelore/webtoon/workflows');
  for (const name of (await readdir(workflows)).filter(x => x.endsWith('.json')).sort()) {
    const workflowPath = await realpath(join(workflows, name));
    if (!inside(root, workflowPath)) fail('SOURCE_PATH_OUTSIDE_ROOT', 'Workflow escaped canon.');
    const workflowBytes = await readFile(workflowPath);
    captures.set(workflowPath, { bytes: workflowBytes, blobId: hashBytes(workflowBytes), verificationOnly: true });
    const workflow = JSON.parse(workflowBytes);
    assertId(workflow.workflowId);
    if (workflow.stage !== 'completed') { excluded.push({ workflowId: workflow.workflowId, stage: workflow.stage, revision: workflow.revision }); continue; }
    if (!Number.isInteger(workflow.revision) || workflow.revision < 1 || !workflow.sceneUnits?.length) fail('INVALID_SAMPLE', 'Missing final workflow revision or source units.');
    const candidateRoot = await realpath(join(workspace, '.vibelore/webtoon/candidates', workflow.workflowId, `r${workflow.revision}`));
    const selected = {};
    for (const name of ['scene.png', 'scene-plan.json']) {
      const artifact = workflow.artifacts[name];
      if (!artifact || await realpath(artifact.path) !== await realpath(join(candidateRoot, name))) fail('SOURCE_FINAL_VERSION_MISMATCH', 'Artifact differs from final workflow revision.');
      selected[name] = await capture(artifact.path, artifact.hash);
    }
    const plan = JSON.parse(selected['scene-plan.json'].bytes);
    if (!Array.isArray(plan.texts) || !Number.isInteger(plan.panelCount) || plan.panelCount < 1) fail('INVALID_SAMPLE', 'Invalid scene plan.');
    const sourceIds = workflow.sceneUnits.map(u => {
      const original = units.get(u.id);
      if (!original || original.text !== u.text && u.text !== undefined) fail('SOURCE_TEXT_MISMATCH', 'Workspace source differs from canon.');
      return original.id;
    });
    for (const t of plan.texts) {
      assertId(t.id);
      if (!sourceIds.includes(units.get(t.sourceId)?.id) || !containsLettering(units.get(t.sourceId)?.text ?? '', t.text)) fail('SOURCE_TEXT_MISMATCH', 'Lettering must quote its declared canon unit.');
      if (!['dialogue', 'thought', 'caption', 'narration', 'sfx', 'physical'].includes(t.kind)) fail('INVALID_SAMPLE', 'Unknown lettering kind.');
      if (!['physical', 'sfx'].includes(t.kind) && t.speaker !== 'narrator' && !identities.some(i => i.sourceCharacterId === t.speaker)) fail('UNKNOWN_SPEAKER', 'Unknown source speaker.');
    }
    plans.push({ workflow, plan, sourceIds, image: selected['scene.png'], planBlobId: selected['scene-plan.json'].blobId });
    for (const ref of workflow.sceneReferences ?? []) {
      const binding = referenceBindings[ref.id];
      if (!binding) continue;
      const id = composedId(`reference-${ref.id}`), prior = assets.find(x => x.id === id);
      if (prior) {
        if (`sha256:${prior.originalHash}` !== ref.hash) fail('SOURCE_IMAGE_HASH_MISMATCH', 'Reference ID resolves to different bytes.');
        continue;
      }
      assertId(id);
      const original = await capture(ref.path, ref.hash);
      // Container conversion only: preserve separate original bytes and their hash.
      const bytes = await sharp(original.bytes).rotate().png().toBuffer();
      assets.push({ id, bytes, blobId: hashBytes(bytes), originalHash: original.blobId, label: binding.label, subject: ['identity', 'role'].includes(binding.subject.kind) ? { ...binding.subject, id: roleId(binding.subject.id) ?? fail('UNKNOWN_SPEAKER', 'Unknown reference identity.') } : binding.subject, scope: { kind: 'project', id: projectId }, representation: 'individual-reference' });
    }
  }
  if (!plans.length) fail('INVALID_SAMPLE', 'No completed scenes available.');
  plans.sort((a, b) => Number(a.workflow.sceneUnits[0].id.split('-').at(-1)) - Number(b.workflow.sceneUnits[0].id.split('-').at(-1)));
  for (const [i, p] of plans.entries()) {
    p.id = `${productionId}-scene-${i + 1}`;
    assets.push({ id: `${p.id}-raster`, ...p.image, originalHash: p.image.blobId, label: `원본 전체 장면 · ${p.plan.panelCount}칸 · r${p.workflow.revision}`, subject: { kind: 'environment', id: p.id }, scope: { kind: 'production', id: productionId }, representation: 'multi-panel-raster', sceneIds: [p.id] });
  }
  for (const asset of assets) await decodeMedia(asset.bytes, 'image');
  const captured = [...captures.values()].filter(c => !c.verificationOnly);
  const pkg = makeSourcePackage({ ...exported.package, id: pkgId,
    blobManifest: [...exported.package.blobManifest, ...captured.map((c, i) => ({ id: `workspace-original-${i}`, kind: 'workspace-original', blobId: c.blobId, byteLength: c.bytes.length })), ...assets.map(a => ({ id: a.id, kind: 'workspace-image', blobId: a.blobId, byteLength: a.bytes.length }))],
    sceneScopes: [...exported.package.sceneScopes, ...plans.map(p => ({ id: p.id, chapter: p.workflow.sceneUnits[0].chapter, sourceUnitIds: p.sourceIds, assetIds: assets.filter(a => a.scope.kind === 'project' || a.sceneIds?.includes(p.id)).map(a => a.id), stateNote: '현재 세계 문서는 전권의 상태를 포함한다. 장면 지식은 선택 원문만으로 판단한다.' }))],
    assets: assets.map(a => ({ id: a.id, sourceAssetId: a.id, blobId: a.blobId, mime: 'image/png', sceneIds: a.sceneIds ?? plans.map(p => p.id), entityId: a.subject.id, stateIds: [], label: a.label, provenance: { kind: 'import', sourceDeclaration: { originalHash: `sha256:${a.originalHash}`, representation: a.representation, conversion: a.blobId === a.originalHash ? 'none' : 'decoded-png-container' } } })),
    states: { ...exported.package.states, workspaceConnection: { completed: plans.map(p => ({ workflowId: p.workflow.workflowId, revision: p.workflow.revision, planBlobId: p.planBlobId })), excluded } },
  });
  for (const [path, c] of captures) if (hashBytes(await readFile(path)) !== c.blobId) fail('SOURCE_CAPTURE_CHANGED', 'Source changed during capture.');
  if ((await captureCanon()).package.sourceDigest !== exported.package.sourceDigest) fail('SOURCE_CAPTURE_CHANGED', 'Canon changed during capture.');
  const service = await openStudio({ directory: resolve(directory) });
  registerSourceCaptureCommands(service, { capture: async () => ({ package: pkg, blobs: [...exported.blobs, ...captured, ...assets].map(b => ({ blobId: b.blobId, bytes: [...b.bytes] })) }) });
  try {
    let existing;
    try { existing = await service.snapshot(projectId); } catch (e) { if (e.code !== 'PROJECT_NOT_FOUND') throw e; }
    const prior = existing?.sourcePackages.find(p => p.id === pkgId);
    if (prior && prior.sourceDigest !== pkg.sourceDigest) fail('SOURCE_CONNECTION_CHANGED', 'Connect changed sources to a fresh project.');
    const projectCommandId = `connect-project-${pkg.sourceDigest}`;
    const events = existing ? await service.events(projectId) : [];
    if (existing && !prior && (events.length !== 1 || events[0].commandId !== projectCommandId)) fail('PROJECT_CONNECTION_CONFLICT', 'Project is not this source connection.');
    const completed = new Set(events.map(e => e.commandId));
    async function command(type, kind, id, payload, expectedRevision = 0) {
      const commandId = type === 'project.create' ? projectCommandId : composedId(`workspace-${type.replaceAll('.', '-')}-${id}`);
      if (completed.has(commandId)) return;
      return service.command({ projectId, commandId, aggregate: { kind, id }, expectedRevision, type, payload });
    }
    await command('project.create', 'project', projectId, { title, language: 'ko', budgetMicros: 0 });
    if (!prior) await command('source.capture', 'sourcePackage', pkgId, { id: pkgId, workId, request: { kind: 'novel-chapters', chapters } });
    await command('production.create', 'production', productionId, { id: productionId, title: `${title} · 1화 웹툰 참조`, sourcePackageId: pkgId });
    for (const i of identities) await command('cast.put', 'cast', i.id, { id: i.id, name: i.name, language: 'ko', characterId: i.id, identity: { id: i.id, origin: { kind: 'source', packageId: pkgId, canonId: i.canonId } } });
    await command('cast.put', 'cast', 'narrator', { id: 'narrator', name: '해설', language: 'ko', characterId: null });
    for (const i of [...identities, { id: 'narrator', sourceCharacterId: 'narrator' }]) await command('casting.set', 'casting', composedId(`${productionId}-${i.id}`), { id: composedId(`${productionId}-${i.id}`), scope: 'production', productionId, roleId: i.id, language: 'ko', state: null, voice: voiceIntents[i.sourceCharacterId].voice });
    await command('story.save', 'story', 'story', { id: 'story', title, text: pkg.textUnits.filter(u => u.chapter === 1).map(u => u.text).join('\n\n'), states: [], revealPolicy: pkg.revealPolicy });
    for (const a of assets) {
      const slot = { id: a.id, scope: a.scope, subject: a.subject, appearanceStateRef: null };
      await command('asset.import', 'assetSlot', a.id, { id: composedId(`${a.id}-original`), slot, mediaKind: 'image', bytes: [...a.bytes], actor: 'workspace-source-connection' });
      await command('candidate.adopt', 'assetSlot', a.id, { slotId: a.id, candidateId: composedId(`${a.id}-original`), actor: 'workspace-source-connection', reason: `${a.label} · 검증된 원본 가져오기. 음성/영상 생성 확인 아님.` }, 1);
    }
    for (const p of plans) {
      const texts = p.plan.texts.filter(t => !['physical', 'sfx'].includes(t.kind));
      const roles = [...new Set(texts.map(t => roleId(t.speaker)))];
      const occurrences = roles.map(roleId => ({ id: composedId(`${p.id}-${roleId}`), sceneId: p.id, roleBindingId: roleId, characterId: roleId === 'narrator' ? null : roleId, presence: roleId === 'narrator' ? 'narrator' : 'onscreen' }));
      await command('scene.put', 'scene', p.id, { id: p.id, productionId, title: `${p.plan.title} · 전체 ${p.plan.panelCount}칸`, sourcePackageId: pkgId, sourceUnitIds: p.sourceIds, occurrences, presentations: occurrences.map(o => ({ occurrenceId: o.id, appearanceStateRef: null, castingStateRef: null, knowledgeStateRef: null })), utterances: texts.map(t => ({ id: composedId(`${p.id}-${t.id}`), speakerOccurrenceId: composedId(`${p.id}-${roleId(t.speaker)}`), addresseeOccurrenceIds: [], text: t.text, sourceTextKind: t.kind, sourceUnitIds: [units.get(t.sourceId).id], citations: [{ packageId: pkgId, sourceUnitId: units.get(t.sourceId).id, planBlobId: p.planBlobId }], acting: `한국어 원문 대사만 정확하게 말한다. ${voiceIntents[t.speaker].style}` })), shots: [{ id: `${p.id}-whole`, title: `웹툰 전체 ${p.plan.panelCount}칸 · 영상 각색 전`, referenceSlotId: `${p.id}-raster` }], provenance: { kind: 'existing-webtoon-import', workflowId: p.workflow.workflowId, revision: p.workflow.revision, planBlobId: p.planBlobId, limitations: ['전체 래스터 참조. 영상용 샷 분해 전.', ...p.plan.uncertainties ?? []] } });
    }
    const s = await service.snapshot(projectId);
    const receipt = { projectId, productionId, chapters: chapters.length, sourceCharacters: identities.length, textUnits: pkg.textUnits.length, completedWebtoonScenes: plans.length, excludedWorkflows: excluded, references: assets.filter(a => a.scope.kind === 'project').map(a => ({ id: a.id, originalHash: a.originalHash, pngHash: a.blobId, subject: a.subject })), sourceDigest: pkg.sourceDigest, voices: voiceIntents, generationJobs: s.jobs.length, actualBillingVerified: false };
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'connection-receipt.json'), JSON.stringify(receipt, null, 2));
    return receipt;
  } finally { await service.close(); }
}
