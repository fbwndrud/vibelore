import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, rm, readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { LoreRegistryStore } from '../src/store/lore-registry-store.js';
import { runLoreRegistry } from '../src/tools/lore-registry.js';
import { lorePresetDefinitions, compileLoreRegistry } from '../engine/src/index.js';

async function root(t) { const dir = await mkdtemp(join(tmpdir(), 'vibelore-registry-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const reason = '독립 세계의 시작 정의';
const field = { schemaVersion: 1, kind: 'field', id: 'field-body-form', namespace: 'u1', key: 'body.form', label: '신체 형태', aliases: ['몸 형태'], definition: '해당 시점에서 인물의 신체 형태. 정체성은 같은 인물 ID로 유지한다.', subjectTypeIds: ['type-character'], valueType: { kind: 'enum', values: ['original', 'transformed'] }, owner: 'state', requiredScopes: ['continuity', 'worldPoint'], cardinality: 'one', constraints: [], missingPolicy: 'unknown', requiredCapabilities: ['state-at-point-v1'] };
function rpc(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, VIBELORE_MCP_SURFACE: 'public' } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`MCP timeout: ${stderr}`)); }, 20000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`MCP failed: ${stderr}`));
      try { resolve(JSON.parse(stdout.trim().split('\n').at(-1)).result); } catch (error) { reject(error); }
    });
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lore_registry', arguments: args } })}\n`);
  });
}

describe('SharedLore registry storage and host workflow', () => {
  it('works with no novel, leaves read-only roots empty, and writes independent immutable checkpoints', async t => {
    const dir = await root(t), store = new LoreRegistryStore(dir, 'u1');
    const status = await runLoreRegistry({ action: 'status', registryRoot: dir, universeId: 'u1' });
    assert.equal(status.head, null); assert.equal(status.definitionCount, 0); assert.deepEqual(await readdir(dir), []);
    const first = await store.register({ expectedHead: null, definitions: lorePresetDefinitions('u1'), reason });
    assert.equal(first.registry.definitions.length, 6);
    assert.equal((await store.read(first.registry.parentRevisionId)).registry.definitions.length, 0);
    const second = await store.register({ expectedHead: first.head, definitions: [field], reason: 'TS 작품의 상태 속성' });
    assert.equal((await store.read(first.head)).registry.definitions.length, 6);
    assert.equal((await store.read(second.head)).registry.definitions.length, 7);
    const retry = await store.register({ expectedHead: second.head, definitions: [field], reason: '같은 요청 재시도' });
    assert.equal(retry.head, second.head); assert.equal(retry.addedRevisionIds.length, 0);
    assert.deepEqual(await readdir(dir), ['.vibelore']);
    assert.equal((await readFile(store.headPath, 'utf8')).trim(), second.head);
    await assert.rejects(new LoreRegistryStore(dir, 'different-universe').read(), { code: 'LORE_UNIVERSE_MISMATCH' });
  });

  it('serializes competing registrations and refuses lost updates with explicit HEAD comparison', async t => {
    const dir = await root(t), store = new LoreRegistryStore(dir, 'u1');
    const definitions = lorePresetDefinitions('u1');
    const requests = await Promise.allSettled([
      store.register({ expectedHead: null, definitions, reason }),
      new LoreRegistryStore(dir, 'u1').register({ expectedHead: null, definitions, reason: '경쟁 등록' }),
    ]);
    assert.equal(requests.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(requests.find(r => r.status === 'rejected').reason.code, 'STALE_LORE_HEAD');
    assert.equal((await store.read()).registry.definitions.length, 6);
  });

  it('rejects invalid additions atomically and detects definition or HEAD corruption', async t => {
    const dir = await root(t), store = new LoreRegistryStore(dir, 'u1');
    const first = await store.register({ expectedHead: null, definitions: lorePresetDefinitions('u1'), reason });
    await assert.rejects(store.register({ expectedHead: first.head, definitions: [field, { ...field, id: 'other', valueType: { kind: 'execute' } }], reason: '실패 묶음' }), { code: 'INVALID_LORE_DATA' });
    assert.equal(await store.head(), first.head); assert.equal((await store.read()).registry.definitions.length, 6);
    const definition = first.registry.definitions[0], path = store.objectPath(definition.revisionId);
    const original = await readFile(path, 'utf8'), mutated = JSON.parse(original); mutated.definition.label = '변조';
    await writeFile(path, JSON.stringify(mutated));
    await assert.rejects(store.read(), { code: 'LORE_INTEGRITY' });
    await writeFile(path, original); await writeFile(store.headPath, '../escape');
    await assert.rejects(store.read(), { code: 'LORE_INTEGRITY' });
  });

  it('refuses registry path symlinks before writes', async t => {
    const dir = await root(t), target = await root(t); await symlink(target, join(dir, '.vibelore'));
    await assert.rejects(new LoreRegistryStore(dir, 'u1').register({ expectedHead: null, definitions: lorePresetDefinitions('u1'), reason }), { code: 'UNSAFE_LORE_PATH' });
    assert.deepEqual(await readdir(target), []);
  });

  it('the real MCP host can search, auto-add and resolve a TS field against a pinned world registry', async t => {
    const dir = await root(t), args = { registryRoot: dir, universeId: 'u1' };
    const seed = await rpc({ ...args, action: 'register', expectedHead: null, preset: 'base', reason });
    assert.equal(seed.isError, undefined); const first = seed.structuredContent;
    const add = await rpc({ ...args, action: 'register', expectedHead: first.head, definitions: [field], reason: '변신 전후 외형을 분리' });
    assert.equal(add.isError, undefined); const revisionId = add.structuredContent.head;
    const search = await rpc({ ...args, action: 'search', revisionId, search: '몸 형태' });
    assert.equal(search.structuredContent.results[0].match, 'exact');
    const { registry } = await new LoreRegistryStore(dir, 'u1').read(revisionId), compiled = compileLoreRegistry(registry);
    const input = {
      entities: [{ id: 'character-a', typeDefinitionRevisionId: compiled.definition('type-character').revisionId }],
      timelines: [{ id: 't1', continuityId: 'main', pointIds: ['before', 'after'] }],
      values: [['original', 'before', 'after'], ['transformed', 'after', null]].map(([value, fromPointId, untilPointId], i) => ({ id: `value-${i}`, subject: { kind: 'entity', entityId: 'character-a' }, fieldDefinitionRevisionId: compiled.definition(field.id).revisionId, owner: 'state', value, storyScope: { continuityId: 'main', timelineId: 't1', fromPointId, untilPointId }, evidenceIds: ['world-note'] })),
    };
    const result = await rpc({ ...args, action: 'resolve', revisionId, input, query: { subjectId: 'character-a', fieldId: field.id, scope: { continuityId: 'main', timelineId: 't1', pointId: 'after' } } });
    assert.equal(result.structuredContent.status, 'resolved'); assert.equal(result.structuredContent.value, 'transformed');
    assert.equal(result.structuredContent.registryRevisionId, revisionId);
    const unpinned = await rpc({ ...args, action: 'resolve', input, query: {} }); assert.equal(unpinned.structuredContent.code, 'INVALID_LORE_DATA');
    const modify = await rpc({ ...args, action: 'register', expectedHead: revisionId, definitions: [{ ...field, definition: '새 뜻' }], reason: '의미 변경' });
    assert.equal(modify.structuredContent.code, 'DEFINITION_MIGRATION_REQUIRED');
    await assert.rejects(runLoreRegistry({ ...args, action: 'status', definitions: [field] }), { code: 'INVALID_LORE_DATA' });
  });
});
