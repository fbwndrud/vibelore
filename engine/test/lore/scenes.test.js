import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { createLoreRegistry, addLoreDefinitions, compileLoreRegistry, lorePresetDefinitions, createLoreRevision, createWorkBinding, prepareLoreProduction, verifyLoreProductionLock,
  validateLoreSceneMap, verifyLoreSceneMap, checkLoreScenes, loreSceneMapRequest, loreSceneParagraphs, createLoreScript, prepareLoreScriptProduction, verifyLoreScriptLock,
  createLoreAssetRevision, createLoreExpressionProfile, createLoreAssetCatalog, inspectLoreImage, LORE_RESOLVER_VERSION, LORE_RESOLVER_VERSION_V2 } from '../../src/index.js';
import { hashLore } from '../../src/lore/registry.js';

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const field = (id, key, valueType, owner, cardinality = 'one', requiredScopes = ['continuity', 'worldPoint']) => ({ schemaVersion: 1, kind: 'field', id, namespace: 'u1', key, label: key, aliases: [], definition: `${key} 값`, subjectTypeIds: ['type-character'], valueType, owner, requiredScopes: owner === 'profile' ? [] : requiredScopes, cardinality, constraints: [], missingPolicy: 'unknown', requiredCapabilities: [] });
export function tsWorld() {
  const registry = addLoreDefinitions(createLoreRegistry('u1'), { reason: 'TS 세계', definitions: [...lorePresetDefinitions('u1'),
    field('name', 'character.name', { kind: 'text' }, 'profile'),
    field('body-gender', 'body.gender', { kind: 'enum', values: ['male', 'female'] }, 'state'),
    field('forbidden', 'addressing.forbidden', { kind: 'text' }, 'state', 'many'),
    field('accepted', 'addressing.accepted', { kind: 'text' }, 'state', 'many'),
  ] }).registry;
  const c = compileLoreRegistry(registry), rev = k => c.definition(k).revisionId;
  const scope = (from, until) => ({ continuityId: 'main', timelineId: 't1', fromPointId: from, untilPointId: until });
  const stateValues = (state, from, until, gender, forbidden, accepted) => [
    { id: `${state}-gender`, fieldDefinitionRevisionId: rev('body-gender'), value: gender },
    ...forbidden.map((term, i) => ({ id: `${state}-forbidden-${i}`, fieldDefinitionRevisionId: rev('forbidden'), value: term })),
    ...accepted.map((term, i) => ({ id: `${state}-accepted-${i}`, fieldDefinitionRevisionId: rev('accepted'), value: term })),
  ].map(v => ({ ...v, subject: { kind: 'entity', entityId: 'a' }, owner: 'state', storyScope: scope(from, until), evidenceIds: [`${state}-doc`] }));
  const before = stateValues('before', 'p0', 'p1', 'male', ['아가씨'], ['도련님']), after = stateValues('after', 'p1', null, 'female', ['도련님'], ['아가씨']);
  const content = {
    entities: [{ id: 'a', typeDefinitionRevisionId: rev('type-character'), documentIds: ['profile-doc'], valueIds: ['name-a'] }],
    states: [{ id: 'state-before', entityId: 'a', documentIds: ['before-doc'], valueIds: before.map(v => v.id), storyScope: scope('p0', 'p1') },
      { id: 'state-after', entityId: 'a', documentIds: ['after-doc'], valueIds: after.map(v => v.id), storyScope: scope('p1', null) }],
    timelines: [{ id: 't1', continuityId: 'main', pointIds: ['p0', 'p1', 'p2'] }],
    values: [{ id: 'name-a', subject: { kind: 'entity', entityId: 'a' }, fieldDefinitionRevisionId: rev('name'), owner: 'profile', value: '윤재', storyScope: {}, evidenceIds: ['profile-doc'] }, ...before, ...after],
    documents: [{ id: 'profile-doc', path: 'characters/a.md', text: '# 윤재\n', visibility: 'context' }, { id: 'before-doc', path: 'characters/states/before.md', text: 'BEFORE_ONLY\n', visibility: 'context' },
      { id: 'after-doc', path: 'characters/states/after.md', text: 'AFTER_ONLY\n', visibility: 'context' }, { id: 'secret-doc', path: 'world/secret.md', text: 'AUTHOR_ONLY\n', visibility: 'author' }],
    worldDocumentIds: ['secret-doc'],
  };
  const revision = createLoreRevision({ universeId: 'u1', registry, content, reason: 'TS' });
  const manifest = { revision, sourceFingerprint: { digest: hash('[]'), inventory: [] }, materialization: { before: [] }, proposalId: hash('p') };
  const publication = { publicationId: hashLore(manifest), registry, revision, manifest };
  return { registry, revision, publication, rev };
}
const fix = async publication => publication;
const projections = [
  { target: 'intrinsic.gender', fieldId: 'body-gender' }, { target: 'intrinsic.addressing.forbiddenGenderedTerms', fieldId: 'forbidden' },
  { target: 'intrinsic.addressing.acceptedGenderedTerms', fieldId: 'accepted' }];
function binding(publication, registry, scenes) {
  return createWorkBinding({ schemaVersion: 2, workId: 'w', universeId: 'u1', loreRevisionId: publication.publicationId, registryRevisionId: registry.revisionId, continuityId: 'main',
    cast: [{ localCharacterId: 'hero', entityId: 'a', projections }], chapters: [{ chapter: 1, scenes }] });
}
const scene = (id, pointId, frame = 'present') => ({ id, frame, scope: { continuityId: 'main', timelineId: 't1', pointId }, entityIds: ['a'], requirements: [{ entityId: 'a', fieldId: 'name', required: true }] });
const PROSE = '윤재는 거울 앞에 섰다. 하인이 도련님이라 불렀다.\n\n빛이 지나간 뒤 윤재의 몸이 바뀌었다.\n\n하녀가 아가씨, 하고 불렀다.';

describe('SharedLore scene resolver v2', () => {
  it('resolves TS before/after scenes separately and never applies one scene state to the chapter', async () => {
    const w = tsWorld(), publication = await fix(w.publication);
    const prepared = prepareLoreProduction({ binding: binding(publication, w.registry, [scene('s-before', 'p0'), scene('s-after', 'p1')]), publication, chapter: 1 });
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.blockers));
    const lock = prepared.lock;
    assert.equal(lock.resolverVersion, LORE_RESOLVER_VERSION_V2);
    assert.deepEqual(lock.scenes.map(s => s.projections.find(p => p.target === 'intrinsic.gender').value), ['male', 'female']);
    assert.deepEqual(lock.scenes.map(s => s.stateIds.a), [['state-before'], ['state-after']]);
    assert.deepEqual(lock.projections, []);
    assert.deepEqual(lock.sceneVarying.map(v => v.target).sort(), projections.map(p => p.target).sort());
    assert.match(JSON.stringify(lock.scenes[0].documents), /BEFORE_ONLY/); assert.doesNotMatch(JSON.stringify(lock.scenes[0].documents), /AFTER_ONLY|AUTHOR_ONLY/);
    assert.equal(verifyLoreProductionLock(lock).revisionId, lock.revisionId);
  });
  it('keeps a flashback out of the present chapter state and rejects an unmarked jump backwards', async () => {
    const w = tsWorld(), publication = await fix(w.publication);
    const lock = prepareLoreProduction({ binding: binding(publication, w.registry, [scene('now', 'p1'), scene('memory', 'p0', 'flashback'), scene('after', 'p2')]), publication, chapter: 1 }).lock;
    assert.equal(lock.projections.find(p => p.target === 'intrinsic.gender').value, 'female');
    assert.deepEqual(lock.projections.find(p => p.target === 'intrinsic.gender').sceneIds, ['now', 'after']);
    assert.equal(lock.scenes[1].projections.find(p => p.target === 'intrinsic.gender').value, 'male');
    assert.deepEqual(lock.sceneVarying.map(v => [v.target, v.reason]), [['intrinsic.addressing.forbiddenGenderedTerms', 'scene_checked'], ['intrinsic.addressing.acceptedGenderedTerms', 'scene_checked']]);
    const wrong = prepareLoreProduction({ binding: binding(publication, w.registry, [scene('now', 'p1'), scene('memory', 'p0')]), publication, chapter: 1 });
    assert.equal(wrong.status, 'unresolved'); assert.equal(wrong.blockers[0].code, 'SCENE_ORDER_REQUIRES_FRAME');
  });
  it('reports unsupported capabilities and scene-varying names instead of approximating them', async () => {
    const w = tsWorld(), publication = await fix(w.publication);
    assert.throws(() => binding(publication, w.registry, [{ ...scene('x', 'p0'), experiencePathId: 'loop-1' }]), { code: 'REQUIRED_CAPABILITY' });
    assert.throws(() => binding(publication, w.registry, [{ ...scene('x', 'p0'), participants: [] }]), { code: 'REQUIRED_CAPABILITY' });
    const b = createWorkBinding({ schemaVersion: 2, workId: 'w', universeId: 'u1', loreRevisionId: publication.publicationId, registryRevisionId: w.registry.revisionId, continuityId: 'main',
      cast: [{ localCharacterId: 'hero', entityId: 'a', projections: [{ target: 'canonicalName', fieldId: 'name' }] }], chapters: [{ chapter: 1, scenes: [scene('s1', 'p0'), scene('s2', 'p1')] }] });
    assert.equal(prepareLoreProduction({ binding: b, publication, chapter: 1 }).status, 'ready');
  });
  it('keeps resolver v1 locks for schemaVersion 1 bindings, including the explicit scene-checker block', async () => {
    const w = tsWorld(), publication = await fix(w.publication);
    const v1 = createWorkBinding({ schemaVersion: 1, workId: 'w', universeId: 'u1', loreRevisionId: publication.publicationId, registryRevisionId: w.registry.revisionId, continuityId: 'main',
      cast: [{ localCharacterId: 'hero', entityId: 'a', projections: [{ target: 'intrinsic.gender', fieldId: 'body-gender' }] }],
      chapters: [{ chapter: 1, scenes: [{ id: 's', scope: { continuityId: 'main', timelineId: 't1', pointId: 'p0' }, entityIds: ['a'], requirements: [] }] },
        { chapter: 2, scenes: ['p0', 'p1'].map(p => ({ id: `s2-${p}`, scope: { continuityId: 'main', timelineId: 't1', pointId: p }, entityIds: ['a'], requirements: [] })) }] });
    const lock = prepareLoreProduction({ binding: v1, publication, chapter: 1 }).lock;
    assert.equal(lock.resolverVersion, LORE_RESOLVER_VERSION); assert.equal(verifyLoreProductionLock(lock).revisionId, lock.revisionId);
    assert.equal(prepareLoreProduction({ binding: v1, publication, chapter: 2 }).blockers[0].status, 'requires_scene_checker');
  });
});

describe('SharedLore manuscript scene map and checks', () => {
  async function lock() {
    const w = tsWorld(), publication = await fix(w.publication);
    return prepareLoreProduction({ binding: binding(publication, w.registry, [scene('s-before', 'p0'), scene('s-after', 'p1')]), publication, chapter: 1 }).lock;
  }
  const answer = (l, prose, segments) => ({ proseHash: loreSceneMapRequest({ lock: l, prose }).proseHash, productionLockId: l.revisionId, segments });
  it('maps paragraphs to scenes and finds a state-specific term violation in the right scene only', async () => {
    const l = await lock(), paragraphs = loreSceneParagraphs(PROSE);
    assert.equal(paragraphs.length, 3);
    const good = validateLoreSceneMap({ lock: l, prose: PROSE, answer: answer(l, PROSE, [{ sceneId: 's-before', fromParagraph: 0, toParagraph: 1 }, { sceneId: 's-after', fromParagraph: 2, toParagraph: 2 }]) });
    const result = checkLoreScenes({ lock: l, prose: PROSE, map: good.map, chapter: 1 });
    assert.equal(result.status, 'passed', JSON.stringify(result.violations));
    const swapped = PROSE.replace('하녀가 아가씨', '하녀가 도련님');
    const bad = validateLoreSceneMap({ lock: l, prose: swapped, answer: answer(l, swapped, [{ sceneId: 's-before', fromParagraph: 0, toParagraph: 1 }, { sceneId: 's-after', fromParagraph: 2, toParagraph: 2 }]) });
    const failed = checkLoreScenes({ lock: l, prose: swapped, map: bad.map, chapter: 1 });
    assert.equal(failed.status, 'failed');
    const [v] = failed.violations;
    assert.equal(v.code, 'SHARED_SCENE_FORBIDDEN_TERM'); assert.equal(v.sceneId, 's-after'); assert.deepEqual(v.stateIds, ['state-after']);
    assert.equal(swapped.slice(v.span.start, v.span.end), '도련님'); assert.ok(v.span.start > paragraphs[2].start);
    assert.match(v.fieldDefinitionRevisionId, /^sha256:/); assert.deepEqual(v.evidenceIds, ['after-doc']);
  });
  it('rejects missing, overlapping, reordered and stale maps and keeps unresolved boundaries structured', async () => {
    const l = await lock();
    const check = segments => assert.throws(() => validateLoreSceneMap({ lock: l, prose: PROSE, answer: answer(l, PROSE, segments) }), { code: 'SCENE_MAP_INVALID' });
    check([{ sceneId: 's-before', fromParagraph: 0, toParagraph: 2 }]);
    check([{ sceneId: 's-before', fromParagraph: 0, toParagraph: 1 }, { sceneId: 's-after', fromParagraph: 1, toParagraph: 2 }]);
    check([{ sceneId: 's-after', fromParagraph: 0, toParagraph: 0 }, { sceneId: 's-before', fromParagraph: 1, toParagraph: 2 }]);
    check([{ sceneId: 's-before', fromParagraph: 0, toParagraph: 0 }, { sceneId: 's-after', fromParagraph: 2, toParagraph: 2 }]);
    const map = validateLoreSceneMap({ lock: l, prose: PROSE, answer: answer(l, PROSE, [{ sceneId: 's-before', fromParagraph: 0, toParagraph: 0 }, { sceneId: 's-after', fromParagraph: 1, toParagraph: 2 }]) }).map;
    assert.throws(() => verifyLoreSceneMap({ lock: l, prose: `${PROSE}\n\n수정한 문단`, map }), { code: 'STALE_SCENE_MAP' });
    assert.throws(() => validateLoreSceneMap({ lock: l, prose: PROSE, answer: { ...answer(l, PROSE, []), proseHash: 'sha256:0' } }), { code: 'STALE_SCENE_MAP' });
    const unresolved = validateLoreSceneMap({ lock: l, prose: PROSE, answer: { ...answer(l, PROSE), unresolved: { reason: '변신 시점이 본문에 없다', sceneIds: ['s-after'] } } });
    assert.equal(unresolved.status, 'unresolved'); assert.deepEqual(unresolved.sceneIds, ['s-after']);
  });
  it('never infers an honorific from body gender when no addressing data is projected', async () => {
    const w = tsWorld(), publication = await fix(w.publication);
    const b = createWorkBinding({ schemaVersion: 2, workId: 'w', universeId: 'u1', loreRevisionId: publication.publicationId, registryRevisionId: w.registry.revisionId, continuityId: 'main',
      cast: [{ localCharacterId: 'hero', entityId: 'a', projections: [{ target: 'intrinsic.gender', fieldId: 'body-gender' }] }], chapters: [{ chapter: 1, scenes: [scene('s-before', 'p0'), scene('s-after', 'p1')] }] });
    const l = prepareLoreProduction({ binding: b, publication, chapter: 1 }).lock, prose = PROSE.replace('하녀가 아가씨', '하녀가 도련님');
    const map = validateLoreSceneMap({ lock: l, prose, answer: answer(l, prose, [{ sceneId: 's-before', fromParagraph: 0, toParagraph: 1 }, { sceneId: 's-after', fromParagraph: 2, toParagraph: 2 }]) }).map;
    assert.equal(checkLoreScenes({ lock: l, prose, map }).violations.length, 0);
  });
});

describe('SharedLore scene scripts and assets', () => {
  // Structurally valid PNG chunks (CRC values are not checked here).
  const chunk = (kind, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(kind, 4, 'latin1'); data.copy(b, 8); return b; };
  const png = (w = 2, h = 3, tag = 0) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([tag])), chunk('IEND', Buffer.alloc(0))]); };
  it('reads verified image metadata from bytes and rejects other containers', () => {
    const meta = inspectLoreImage(png(640, 480));
    assert.equal(meta.mime, 'image/png'); assert.equal(meta.width, 640); assert.equal(meta.height, 480); assert.match(meta.blobId, /^sha256:/);
    assert.throws(() => inspectLoreImage(Buffer.from('GIF89a'.padEnd(40, 'x'))), { code: 'INVALID_ASSET_FILE' });
  });
  it('pins approved state-specific assets and an expression profile that cannot own world values', async () => {
    const w = tsWorld(), publication = await fix(w.publication);
    assert.throws(() => createLoreExpressionProfile({ profileId: 'pastel', label: '파스텔', style: 'soft', values: [{ fieldId: 'eye' }] }), { code: 'EXPRESSION_PROFILE_OWNERSHIP' });
    const profile = createLoreExpressionProfile({ profileId: 'pastel', label: '파스텔', style: 'soft watercolor', palette: ['blue eyes'] });
    const asset = (assetId, stateIds, tag) => createLoreAssetRevision({ assetId, blob: { ...inspectLoreImage(png(2, 3, tag)) }, purpose: 'reference-image', label: assetId, entityId: 'a', stateIds, provenance: { kind: 'import', sourceName: `${assetId}.png`, note: null }, linkedLoreRevisionId: publication.publicationId });
    const child = asset('a-before', ['state-before'], 1), adult = asset('a-after', ['state-after'], 2);
    const catalog = createLoreAssetCatalog({ universeId: 'u1', parent: null, assets: [child, adult], profiles: [profile], proposalId: hash('c'), reason: '기준 이미지' });
    const script = createLoreScript({ schemaVersion: 1, workId: 'toon', scriptId: 'ep1', title: '거울', language: 'ko', universeId: 'u1', loreRevisionId: publication.publicationId, registryRevisionId: w.registry.revisionId,
      continuityId: 'main', assetCatalogRevisionId: catalog.revisionId, expressionProfileId: 'pastel',
      cast: [{ localCharacterId: 'hero', entityId: 'a', projections, assetIds: ['a-after'] }],
      scenes: [{ ...scene('s1', 'p2'), text: '윤재: "아가씨라고 불러."' }] });
    const ready = prepareLoreScriptProduction({ script, publication, catalog: { revision: catalog, assetRevisions: [adult], profileRevision: profile } });
    assert.equal(ready.status, 'ready', JSON.stringify(ready.blockers));
    assert.equal(ready.lock.assets[0].blob.blobId, adult.blob.blobId); assert.equal(ready.lock.expression.palette[0], 'blue eyes');
    assert.equal(ready.lock.scenes[0].projections.find(p => p.target === 'intrinsic.gender').value, 'female');
    assert.equal(verifyLoreScriptLock(ready.lock).revisionId, ready.lock.revisionId);
    const { revisionId, ...base } = script;
    const wrongState = createLoreScript({ ...base, cast: [{ ...script.cast[0], assetIds: ['a-before'] }] });
    const mismatch = prepareLoreScriptProduction({ script: wrongState, publication, catalog: { revision: catalog, assetRevisions: [child], profileRevision: profile } });
    assert.equal(mismatch.status, 'unresolved'); assert.equal(mismatch.blockers[0].code, 'ASSET_STATE_MISMATCH');
    const replaced = asset('a-after', ['state-after'], 9);
    assert.throws(() => createLoreAssetCatalog({ universeId: 'u1', parent: catalog, assets: [replaced], proposalId: hash('d'), reason: '교체' }), { code: 'STALE_ASSET_REVISION' });
  });
});
