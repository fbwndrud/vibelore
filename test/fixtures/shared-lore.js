import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoreRegistryStore } from '../../src/store/lore-registry-store.js';
import { UniverseStore } from '../../src/store/universe-store.js';
import { compileLoreRegistry, lorePresetDefinitions } from '../../engine/src/index.js';

export async function sharedWorld() {
  const root = await mkdtemp(join(tmpdir(), 'vibelore-world-'));
  const registryStore = new LoreRegistryStore(root, 'u1');
  const field = (id, key, valueType, owner, requiredScopes) => ({ schemaVersion: 1, kind: 'field', id, namespace: 'u1', key, label: key, aliases: [], definition: `${key}의 명시된 값`, subjectTypeIds: ['type-character'], valueType, owner, requiredScopes, cardinality: 'one', constraints: [], missingPolicy: 'unknown', requiredCapabilities: [] });
  const definitions = [...lorePresetDefinitions('u1'),
    field('gender', 'body.gender', { kind: 'enum', values: ['male', 'female'] }, 'state', ['continuity', 'worldPoint']),
    field('name', 'character.name', { kind: 'text' }, 'profile', []),
    field('unknown-power', 'power.unset', { kind: 'text' }, 'fact', ['continuity', 'worldPoint']),
  ];
  const registered = await registryStore.register({ expectedHead: null, definitions, reason: '공유 세계 추천 정의' });
  const registry = registered.registry, compiled = compileLoreRegistry(registry);
  const values = [
    { id: 'name-a', subject: { kind: 'entity', entityId: 'character-a' }, fieldDefinitionRevisionId: compiled.definition('name').revisionId, owner: 'profile', value: '윤재', storyScope: {}, evidenceIds: ['profile'] },
    ...[['before', 'male', 'p0', 'p1'], ['after', 'female', 'p1', null]].map(([id, value, fromPointId, untilPointId]) => ({
      id: `value-${id}`, subject: { kind: 'entity', entityId: 'character-a' }, fieldDefinitionRevisionId: compiled.definition('gender').revisionId, owner: 'state', value,
      storyScope: { continuityId: 'main', timelineId: 't1', fromPointId, untilPointId }, evidenceIds: [id],
    })),
  ];
  const content = {
    entities: [{ id: 'character-a', typeDefinitionRevisionId: compiled.definition('type-character').revisionId, documentIds: ['profile', 'secret'], valueIds: ['name-a'] }],
    states: ['before', 'after'].map(id => ({ id: `state-${id}`, entityId: 'character-a', documentIds: [id], valueIds: [`value-${id}`], storyScope: values.find(v => v.id === `value-${id}`).storyScope })),
    timelines: [{ id: 't1', continuityId: 'main', pointIds: ['p0', 'p1', 'p2'] }], values,
    documents: [
      { id: 'world', path: 'world/setting.md', text: '# 세계\n공유된 탑에는 두 개의 달이 뜬다.\n', visibility: 'context' },
      { id: 'profile', path: 'characters/character-a.md', text: '# 윤재\n문을 열고 새 길을 찾는 인물이다.\n', visibility: 'context' },
      { id: 'secret', path: 'characters/secret.md', text: '# 작가만 아는 결말\nFUTURE_SECRET_TOKEN\n', visibility: 'author' },
      { id: 'before', path: 'characters/states/before.md', text: '# 변신 전\nBEFORE_BODY_ONLY\n', visibility: 'context' },
      { id: 'after', path: 'characters/states/after.md', text: '# 변신 후\nAFTER_BODY_ONLY\n', visibility: 'context' },
    ], worldDocumentIds: ['world'],
  };
  const world = new UniverseStore(root, 'u1'), proposal = await world.propose({ expectedHead: null, registryRevisionId: registry.revisionId, content, reason: '첫 설정 채택' });
  const adopted = await world.decide({ expectedHead: null, proposalId: proposal.proposalId, action: 'approve' });
  return { root, world, registry, content, head: adopted.head, publication: await world.read() };
}
export function sharedBinding(world, workId, pointId = 'p1') {
  return { schemaVersion: 1, workId, universeId: 'u1', loreRevisionId: world.head, registryRevisionId: world.registry.revisionId, continuityId: 'main',
    cast: [{ localCharacterId: 'hero', entityId: 'character-a', projections: [{ target: 'intrinsic.gender', fieldId: 'gender' }] }],
    chapters: [1, 2, 3].map(chapter => ({ chapter, scenes: [{ id: `scene-${chapter}`, scope: { continuityId: 'main', timelineId: 't1', pointId }, entityIds: ['character-a'], requirements: [{ entityId: 'character-a', fieldId: 'name', required: true }] }] })),
  };
}

/**
 * One shared character with childhood, adult and post-TS states, registered
 * without any novel. Addressing terms are explicit state data; body gender is
 * a separate field and never implies them.
 */
export async function sharedSaga() {
  const root = await mkdtemp(join(tmpdir(), 'vibelore-saga-'));
  const registryStore = new LoreRegistryStore(root, 'u1');
  const field = (id, key, valueType, owner, cardinality = 'one') => ({ schemaVersion: 1, kind: 'field', id, namespace: 'u1', key, label: key, aliases: [], definition: `${key}의 명시된 값`, subjectTypeIds: ['type-character'], valueType, owner, requiredScopes: owner === 'profile' ? [] : ['continuity', 'worldPoint'], cardinality, constraints: [], missingPolicy: 'unknown', requiredCapabilities: [] });
  const registered = await registryStore.register({ expectedHead: null, reason: '공유 인물 상태 정의', definitions: [...lorePresetDefinitions('u1'),
    field('name', 'character.name', { kind: 'text' }, 'profile'),
    field('age-stage', 'age.stage', { kind: 'enum', values: ['child', 'adult'] }, 'state'),
    field('body-gender', 'body.gender', { kind: 'enum', values: ['male', 'female'] }, 'state'),
    field('forbidden-terms', 'addressing.forbidden', { kind: 'text' }, 'state', 'many'),
    field('accepted-terms', 'addressing.accepted', { kind: 'text' }, 'state', 'many'),
  ] });
  const registry = registered.registry, c = compileLoreRegistry(registry), rev = id => c.definition(id).revisionId;
  const scope = (fromPointId, untilPointId) => ({ continuityId: 'main', timelineId: 't1', fromPointId, untilPointId });
  const stateValues = (state, from, until, age, gender, forbidden, accepted) => [
    { id: `${state}-age`, fieldDefinitionRevisionId: rev('age-stage'), value: age },
    { id: `${state}-gender`, fieldDefinitionRevisionId: rev('body-gender'), value: gender },
    ...forbidden.map((term, i) => ({ id: `${state}-forbidden-${i}`, fieldDefinitionRevisionId: rev('forbidden-terms'), value: term })),
    ...accepted.map((term, i) => ({ id: `${state}-accepted-${i}`, fieldDefinitionRevisionId: rev('accepted-terms'), value: term })),
  ].map(v => ({ ...v, subject: { kind: 'entity', entityId: 'character-a' }, owner: 'state', storyScope: scope(from, until), evidenceIds: [`${state}-doc`] }));
  const states = [['child', 'childhood', 'adulthood', 'child', 'male', ['아가씨'], ['도련님']], ['adult', 'adulthood', 'ts', 'adult', 'male', ['아가씨'], ['도련님']], ['ts', 'ts', null, 'adult', 'female', ['도련님'], ['아가씨']]];
  const values = [{ id: 'name-a', subject: { kind: 'entity', entityId: 'character-a' }, fieldDefinitionRevisionId: rev('name'), owner: 'profile', value: '윤재', storyScope: {}, evidenceIds: ['profile-doc'] },
    ...states.flatMap(s => stateValues(...s))];
  const content = {
    entities: [{ id: 'character-a', typeDefinitionRevisionId: rev('type-character'), documentIds: ['profile-doc', 'secret-doc'], valueIds: ['name-a'] }],
    states: states.map(([state, from, until]) => ({ id: `state-${state}`, entityId: 'character-a', documentIds: [`${state}-doc`], valueIds: values.filter(v => v.id.startsWith(`${state}-`)).map(v => v.id), storyScope: scope(from, until) })),
    timelines: [{ id: 't1', continuityId: 'main', pointIds: ['childhood', 'adulthood', 'ts', 'later'] }], values,
    documents: [
      { id: 'world-doc', path: 'world/setting.md', text: '# 세계\n탑에는 두 개의 달이 뜬다.\n', visibility: 'context' },
      { id: 'profile-doc', path: 'characters/character-a.md', text: '# 윤재\n길을 찾는 인물.\n', visibility: 'context' },
      { id: 'secret-doc', path: 'characters/character-a-secret.md', text: '# 작가 메모\nFUTURE_SECRET_TOKEN\n', visibility: 'author' },
      { id: 'child-doc', path: 'characters/states/child.md', text: '# 유년기\nCHILD_ONLY\n', visibility: 'context' },
      { id: 'adult-doc', path: 'characters/states/adult.md', text: '# 성인기\nADULT_ONLY\n', visibility: 'context' },
      { id: 'ts-doc', path: 'characters/states/ts.md', text: '# 변화 후\nTS_ONLY\n', visibility: 'context' },
    ], worldDocumentIds: ['world-doc'],
  };
  const world = new UniverseStore(root, 'u1'), proposal = await world.propose({ expectedHead: null, registryRevisionId: registry.revisionId, content, reason: '소설 없는 공유 인물 채택' });
  const adopted = await world.decide({ expectedHead: null, proposalId: proposal.proposalId, action: 'approve' });
  return { root, world, registry, content, head: adopted.head, publication: await world.read() };
}
export const SAGA_PROJECTIONS = [{ target: 'intrinsic.gender', fieldId: 'body-gender' }, { target: 'intrinsic.ageBand', fieldId: 'age-stage' },
  { target: 'intrinsic.addressing.forbiddenGenderedTerms', fieldId: 'forbidden-terms' }, { target: 'intrinsic.addressing.acceptedGenderedTerms', fieldId: 'accepted-terms' }];
export const sagaScene = (id, pointId, frame = 'present') => ({ id, frame, scope: { continuityId: 'main', timelineId: 't1', pointId }, entityIds: ['character-a'], requirements: [{ entityId: 'character-a', fieldId: 'name', required: true }] });
export function sagaBinding(world, workId, chapters) {
  return { schemaVersion: 2, workId, universeId: 'u1', loreRevisionId: world.head, registryRevisionId: world.registry.revisionId, continuityId: 'main',
    cast: [{ localCharacterId: 'hero', entityId: 'character-a', projections: SAGA_PROJECTIONS }],
    chapters: Object.entries(chapters).map(([chapter, scenes]) => ({ chapter: Number(chapter), scenes })) };
}
/** Host answer for `shared-scene-map`: split paragraphs at the given boundaries (default: equal halves). */
export function sceneMapAnswer(userJson, cut) {
  const request = JSON.parse(userJson), n = request.paragraphs.length, k = request.scenes.length;
  const starts = cut ?? request.scenes.map((_, i) => Math.floor(i * n / k));
  return JSON.stringify({ proseHash: request.proseHash, productionLockId: request.productionLockId,
    segments: request.scenes.map((s, i) => ({ sceneId: s.sceneId, fromParagraph: starts[i], toParagraph: (starts[i + 1] ?? n) - 1 })) });
}
