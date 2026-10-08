// Read-only source capture plus public Studio commands. No credentials or worker.
import { readFile, readdir, realpath, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MarkdownStateStore } from '../../src/store/markdown-store.js';
import { exportVibeloreSource } from '../src/source/vibelore-connector.js';
import { hashBytes, makeSourcePackage, registerSourceCaptureCommands } from '../src/source/source-package.js';
import { assertId, canonicalDigest, fail } from '../src/engine/contracts.js';
import { openStudio } from '../src/engine/index.js';
import { decodeMedia } from '../src/assets/decode.js';

export const sampleVoiceIntents = {
  c1: { voice: 'Kore', style: '차분하고 단단한 마흔두 살 여성. 짧게 답하고 정확하게 묻는다.' },
  c2: { voice: 'Orus', style: '마흔다섯 살 남성. 확신에 찬 말투와 책임을 피하는 조급함.' },
  c3: { voice: 'Gacrux', style: '나이 든 여성. 집안의 권위를 내세우는 단호한 말투.' },
  c4: { voice: 'Charon', style: '나이 든 남성. 낮고 느린 목소리, 짧게 말을 건넨다.' },
  c5: { voice: 'Leda', style: '성인 여성. 정중하고 부드러우며 계산이 선명한 말투.' },
  narrator: { voice: 'Sulafat', style: '차분한 한국어 해설. 장면의 원문을 담담하게 읽는다.' },
};
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`);
async function canonicalLocation(path) {
  try { return await realpath(path); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return join(await canonicalLocation(dirname(path)), basename(path));
  }
}

/** Connect the selected episode manifest, all chapter canon and its two reference sheets. */
export async function connectVibeloreSample({ sourceRoot, directory, output, projectId, workId = projectId, manifest = 'output/webtoon-ep01/episode-01-manifest.json', voiceIntents = null }) {
  assertId(projectId); assertId(workId);
  if (!voiceIntents && workId !== 'family-revenge') fail('SAMPLE_VOICE_SCOPE_REQUIRED', 'Default voice direction is scoped to family-revenge. Other works require explicit voice intents.');
  const selectedVoices = voiceIntents ?? sampleVoiceIntents;
  const root = await realpath(resolve(sourceRoot));
  for (const destination of [directory, output]) {
    const actual = await canonicalLocation(resolve(destination));
    if (inside(root, actual) || inside(actual, root)) fail('SOURCE_DESTINATION_OVERLAP', 'Studio storage and receipts must be outside the source tree.');
  }
  const captured = [];
  async function capture(path) {
    const actual = await realpath(resolve(root, path));
    if (!inside(root, actual)) fail('SOURCE_PATH_OUTSIDE_ROOT', 'Source asset must stay inside the selected source root.');
    const bytes = await readFile(actual), blobId = hashBytes(bytes);
    captured.push({ actual, bytes, blobId });
    return { bytes, blobId };
  }
  const manifestData = await capture(manifest);
  const episode = JSON.parse(manifestData.bytes);
  if (!Array.isArray(episode.scenes) || !episode.scenes.length || !Number.isInteger(episode.episode)) fail('INVALID_SAMPLE', 'Expected an episode scene manifest.');
  const chapterNumbers = (await readdir(join(root, 'chapters'))).filter(n => /^\d+\.md$/.test(n)).map(n => Number(n.slice(0, -3))).sort((a, b) => a - b);
  const exported = await exportVibeloreSource({ store: new MarkdownStateStore(root), workId, request: { kind: 'novel-chapters', chapters: chapterNumbers } });
  const pkgId = 'connected-source', productionId = `ep${String(episode.episode).padStart(2, '0')}`;
  const identities = exported.package.sourceIdentityMap;
  if (identities.some(i => !selectedVoices[i.sourceCharacterId]) || !selectedVoices.narrator) fail('UNKNOWN_CAST', 'This sample runner requires explicit voice intents; it does not infer identity by name.');
  const sourceUnit = new Map(exported.package.textUnits.map(u => [u.sourceUnitId, u]));
  const media = [], plans = [];
  for (const scene of episode.scenes) {
    assertId(scene.workflowId);
    if (!Number.isInteger(scene.number) || !Number.isInteger(scene.revision) || !Number.isInteger(scene.panelCount)) fail('INVALID_SAMPLE', 'Expected explicit final scene revision and panel count.');
    const expectedFile = join('.vibelore', 'webtoon', 'candidates', scene.workflowId, `r${scene.revision}`, 'scene.png');
    const actualFile = await realpath(resolve(root, scene.image.path));
    if (actualFile !== await realpath(join(root, expectedFile))) fail('SOURCE_FINAL_VERSION_MISMATCH', 'Manifest image does not identify its declared final revision.');
    const image = await capture(expectedFile);
    if (`sha256:${image.blobId}` !== scene.image.hash) fail('SOURCE_IMAGE_HASH_MISMATCH', 'Final image bytes differ from the manifest.');
    const planData = await capture(join(dirname(expectedFile), 'scene-plan.json'));
    const plan = JSON.parse(planData.bytes);
    if (plan.panelCount !== scene.panelCount || !Array.isArray(plan.texts) || !Array.isArray(scene.sourceUnitIds)) fail('INVALID_SAMPLE', 'Scene plan and final manifest disagree.');
    for (const id of scene.sourceUnitIds) if (!sourceUnit.has(id)) fail('INVALID_SAMPLE', 'Scene source unit is absent.');
    for (const text of plan.texts) {
      assertId(text.id);
      if (!scene.sourceUnitIds.includes(text.sourceId) || !sourceUnit.get(text.sourceId)?.text.includes(text.text)) fail('SOURCE_TEXT_MISMATCH', 'Selected lettering must exactly cite its original source paragraph.');
      if (!['dialogue', 'caption', 'narration', 'physical'].includes(text.kind)) fail('INVALID_SAMPLE', 'Unknown lettering kind; speech requires an explicit declaration.');
      if (text.kind !== 'physical' && !(identities.some(i => i.sourceCharacterId === text.speaker) || (['caption', 'narration'].includes(text.kind) && text.speaker === 'narrator'))) fail('UNKNOWN_SPEAKER', 'Speech must use a declared source character or narrator.');
    }
    const id = `${productionId}-scene-${scene.number}`;
    plans.push({ id, scene, plan, planBlobId: planData.blobId });
    media.push({ id: `${id}-raster`, ...image, scope: { kind: 'production', id: productionId }, subject: { kind: 'environment', id }, sceneIds: [id], label: `원본 전체 장면 이미지 · ${scene.panelCount}칸 · r${scene.revision}`, source: { workflowId: scene.workflowId, revision: scene.revision, declaredProvenance: scene.image.provenance ?? null } });
  }
  const referenceDir = dirname(resolve(root, manifest));
  const castReference = await capture(join(referenceDir, 'cast-reference-v1.png'));
  for (const identity of identities) media.push({ id: `${productionId}-cast-${identity.id}`, ...castReference, scope: { kind: 'production', id: productionId }, subject: { kind: 'identity', id: identity.id }, sceneIds: plans.map(p => p.id), label: `${identities.length}인 통합 참조 시트 (개별 인물 크롭 아님)`, source: { kind: 'existing-reference-import', reference: 'cast-reference-v1.png', sourceCharacterId: identity.sourceCharacterId, representation: 'combined-cast-sheet' } });
  media.push({ id: `${productionId}-room`, ...await capture(join(referenceDir, 'dining-room-reference-v1.png')), scope: { kind: 'production', id: productionId }, subject: { kind: 'environment', id: 'dining-room' }, sceneIds: plans.map(p => p.id), label: '기존 식당 공간 참조', source: { kind: 'existing-reference-import', reference: 'dining-room-reference-v1.png' } });
  // Decode every image before any project mutation. Keep raw bytes separately from canonical PNGs.
  for (const asset of media) await decodeMedia(asset.bytes, 'image');
  const extraBlobs = captured.map((c, i) => ({ id: `episode-blob-${i + 1}`, kind: 'episode-original', blobId: c.blobId, byteLength: c.bytes.length }));
  const pkg = makeSourcePackage({ ...exported.package, id: pkgId,
    blobManifest: [...exported.package.blobManifest, ...extraBlobs],
    sceneScopes: [...exported.package.sceneScopes, ...plans.map(({ id, scene }) => ({ id, chapter: episode.sourceChapter, sourceUnitIds: scene.sourceUnitIds.map(id => sourceUnit.get(id).id), assetIds: media.filter(m => m.sceneIds.includes(id)).map(m => m.id), stateNote: '원문 문단 범위만 고정. 화의 beforeState/afterState와 현재 세계 문서는 별도 보존하며 장면 중간 지식으로 간주하지 않는다.' }))],
    assets: media.map(m => ({ id: m.id, sourceAssetId: m.id, mime: 'image/png', blobId: m.blobId, sceneIds: m.sceneIds, stateIds: [], entityId: m.subject.id, label: m.label, provenance: { kind: 'import', sourceDeclaration: m.source } })),
    states: { ...exported.package.states, connectedSample: { manifestBlobId: manifestData.blobId, episode: episode.episode, sourceChapter: episode.sourceChapter, sourceParagraphs: episode.sourceParagraphs, totalPanels: episode.totalPanels, finalScenes: plans.map(p => ({ sceneId: p.id, workflowId: p.scene.workflowId, revision: p.scene.revision, planBlobId: p.planBlobId })) } },
  });
  for (const c of captured) if (hashBytes(await readFile(c.actual)) !== c.blobId) fail('SOURCE_CAPTURE_CHANGED', 'Episode source changed during capture.');
  const verified = await exportVibeloreSource({ store: new MarkdownStateStore(root), workId, request: { kind: 'novel-chapters', chapters: chapterNumbers } });
  if (verified.package.sourceDigest !== exported.package.sourceDigest) fail('SOURCE_CAPTURE_CHANGED', 'Novel source changed during episode capture.');
  const projectCommandId = `connect-project-create-${pkg.sourceDigest}`;
  const service = await openStudio({ directory: resolve(directory) });
  // Common source.capture preparation stages verified original bytes without
  // expanding large image arrays into a command's canonical JSON envelope.
  registerSourceCaptureCommands(service, { capture: async () => ({ package: pkg, blobs: [...exported.blobs, ...captured.map(c => ({ blobId: c.blobId, bytes: [...c.bytes] }))] }) });
  try {
    let existing;
    try { existing = await service.snapshot(projectId); } catch (e) { if (e.code !== 'PROJECT_NOT_FOUND') throw e; }
    const prior = existing?.sourcePackages.find(p => p.id === pkgId);
    if (prior && prior.sourceDigest !== pkg.sourceDigest) fail('SOURCE_CONNECTION_CHANGED', 'Source changed. Connect to a new isolated project rather than replacing this immutable capture.');
    if (existing && !prior) {
      const events = await service.events(projectId);
      if (events.length !== 1 || events[0].commandId !== projectCommandId || events[0].type !== 'project.create') fail('PROJECT_CONNECTION_CONFLICT', 'Existing project is not this source connection.');
    }
    const completed = new Set(existing ? (await service.events(projectId)).map(e => e.commandId) : []);
    const commandId = (type, id) => type === 'project.create' ? projectCommandId : `connect-${type.replaceAll('.', '-')}-${id}`;
    async function command(type, kind, id, payload, expectedRevision = 0) {
      return service.command({ projectId, commandId: commandId(type, id), aggregate: { kind, id }, expectedRevision, type, payload });
    }
    await command('project.create', 'project', projectId, { title: episode.title, language: 'ko', budgetMicros: 0 });
    if (!prior) await command('source.capture', 'sourcePackage', pkgId, { id: pkgId, workId, request: { kind: 'novel-chapters', chapters: chapterNumbers, episodeSourceDigest: pkg.sourceDigest } });
    await command('production.create', 'production', productionId, { id: productionId, title: `${episode.title} · ${episode.episode}화`, sourcePackageId: pkgId });
    for (const identity of identities) await command('cast.put', 'cast', identity.id, { id: identity.id, name: identity.name, language: 'ko', characterId: identity.id, identity: { id: identity.id, origin: { kind: 'source', packageId: pkgId, canonId: identity.canonId } } });
    await command('cast.put', 'cast', 'narrator', { id: 'narrator', name: '해설', language: 'ko', characterId: null });
    for (const roleId of [...identities.map(i => i.id), 'narrator']) await command('casting.set', 'casting', `${productionId}-${roleId}`, { id: `${productionId}-${roleId}`, scope: 'production', productionId, roleId, state: null, language: 'ko', voice: selectedVoices[roleId].voice });
    await command('story.save', 'story', 'story', { id: 'story', title: episode.title, text: exported.package.textUnits.filter(u => u.chapter === episode.sourceChapter).map(u => u.text).join('\n\n'), states: [], revealPolicy: pkg.revealPolicy });
    for (const asset of media) {
      const slot = { id: asset.id, scope: asset.scope, subject: asset.subject, appearanceStateRef: null };
      // Package digest already verified the exact bytes/identity/scope association.
      // Completed decisions stay completed even when the creator changed the slot.
      if (!completed.has(commandId('asset.import', slot.id))) await command('asset.import', 'assetSlot', slot.id, { id: `${asset.id}-original`, slot, mediaKind: 'image', bytes: [...asset.bytes], actor: 'vibelore-source-connection' });
      if (!completed.has(commandId('candidate.adopt', slot.id))) await command('candidate.adopt', 'assetSlot', slot.id, { slotId: slot.id, candidateId: `${asset.id}-original`, actor: 'vibelore-source-connection', reason: `${asset.label}. 원본 SHA-256 ${asset.blobId} 확인. 기존 파일 가져오기; 새 생성·관측 모델·과금 검증 없음.` }, 1);
    }
    for (const { id, scene, plan, planBlobId } of plans) {
      const roleIds = [...identities.map(i => i.id), ...(plan.texts.some(t => t.kind !== 'physical' && t.speaker === 'narrator') ? ['narrator'] : [])];
      const occurrences = roleIds.map(roleId => ({ id: `${id}-${roleId}`, sceneId: id, roleBindingId: roleId, characterId: roleId === 'narrator' ? null : roleId, presence: roleId === 'narrator' ? 'narrator' : 'onscreen' }));
      const utterances = plan.texts.filter(t => t.kind !== 'physical').map(t => ({ id: `${id}-${t.id}`, speakerOccurrenceId: `${id}-${t.speaker}`, addresseeOccurrenceIds: [], text: t.text, sourceTextId: t.id, sourceTextKind: t.kind, sourceUnitIds: [sourceUnit.get(t.sourceId).id], citations: [{ packageId: pkgId, sourceUnitId: sourceUnit.get(t.sourceId).id, sourceTextId: t.id, planBlobId }], acting: `한국어 원문만 정확하게 말한다. ${selectedVoices[t.speaker].style}` }));
      await command('scene.put', 'scene', id, { id, productionId, title: `${scene.title} · 전체 래스터 ${scene.panelCount}칸`, sourcePackageId: pkgId, sourceUnitIds: scene.sourceUnitIds.map(i => sourceUnit.get(i).id), occurrences, presentations: occurrences.map(o => ({ occurrenceId: o.id, appearanceStateRef: null, castingStateRef: null, knowledgeStateRef: null })), utterances, shots: [{ id: `${id}-whole`, title: `전체 장면 이미지 · ${scene.panelCount}칸 (칸별 분리 없음)`, referenceSlotId: `${id}-raster`, occurrenceIds: occurrences.filter(o => o.presence === 'onscreen').map(o => o.id) }], provenance: { kind: 'existing-webtoon-import', workflowId: scene.workflowId, revision: scene.revision, planBlobId, staging: plan.staging ?? null, rawImageHash: scene.image.hash, originalPanelCount: scene.panelCount, physicalLettering: plan.texts.filter(t => t.kind === 'physical'), limitations: ['장면 전체 래스터; 칸별 크롭·레이어·글자는 분리하지 않음.', '현재 세계·인물 문서는 미래 상태를 포함할 수 있음. 장면 지식은 원문 범위로 판단.'] } });
    }
    const snapshot = await service.snapshot(projectId);
    const receipt = { schemaVersion: 1, projectId, productionId, sourceDigest: pkg.sourceDigest, sourceRevision: pkg.sourceRevision, chapters: chapterNumbers.length, textUnits: pkg.textUnits.length, sourceDocuments: exported.package.blobManifest.filter(b => b.kind === 'document').length, sourceCharacters: identities.length, scenes: plans.length, originalPanels: plans.reduce((n, p) => n + p.scene.panelCount, 0), spokenTexts: plans.reduce((n, p) => n + p.plan.texts.filter(t => t.kind !== 'physical').length, 0), excludedPhysicalTexts: plans.reduce((n, p) => n + p.plan.texts.filter(t => t.kind === 'physical').length, 0), images: snapshot.candidates.map(c => ({ id: c.id, rawBlobId: c.rawBlobId, canonicalBlobId: c.canonicalBlobId, metadata: c.metadata, lineage: c.lineage })), adoptions: snapshot.adoptions.length, generationJobs: snapshot.jobs.length, budgetMicros: snapshot.budget.budgetMicros, actualBillingVerified: false, sourceFiles: pkg.blobManifest.map(b => ({ id: b.id, kind: b.kind, blobId: b.blobId, byteLength: b.byteLength })), connectionDigest: canonicalDigest({ sourceDigest: pkg.sourceDigest, voiceIntents: selectedVoices }) };
    await mkdir(resolve(output), { recursive: true });
    await writeFile(join(resolve(output), 'connection-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally { await service.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['source-root', 'project', 'output', 'project-id', 'work-id', 'manifest'].map(k => [k, { type: 'string' }])) });
    if (!['source-root', 'project', 'output', 'project-id'].every(k => values[k])) fail('INVALID_CONFIGURATION', 'Explicit --source-root --project --output --project-id required.');
    const receipt = await connectVibeloreSample({ sourceRoot: values['source-root'], directory: values.project, output: values.output, projectId: values['project-id'], workId: values['work-id'] ?? values['project-id'], ...(values.manifest ? { manifest: values.manifest } : {}) });
    console.log(JSON.stringify({ projectId: receipt.projectId, sourceDigest: receipt.sourceDigest, chapters: receipt.chapters, scenes: receipt.scenes, spokenTexts: receipt.spokenTexts, generationJobs: receipt.generationJobs }));
  } catch (error) { console.error(error.code ?? 'SOURCE_CONNECTION_FAILED'); process.exitCode = 1; }
}
