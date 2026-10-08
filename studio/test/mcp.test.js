import assert from 'node:assert/strict';
import { it } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withStudio } from './helpers/project.js';

async function client(t, directory) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../bin/studio-mcp.js', import.meta.url)),
      '--project',
      directory,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  child.stdin.on('error', () => {});
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  let buffer = '';
  const pending = new Map();
  let id = 0;
  child.stdout.on('data', (d) => {
    buffer += d;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        pending.get(message.id)?.resolve(message);
        pending.delete(message.id);
      } catch (e) {
        for (const p of pending.values()) p.reject(e);
      }
    }
  });
  child.on('exit', (code) => {
    for (const p of pending.values())
      p.reject(new Error(`MCP exited ${code}: ${stderr}`));
  });
  t.after(() => child.kill());
  return {
    child,
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        const message = { jsonrpc: '2.0', id: ++id, method, params };
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify(message) + '\n');
      });
    },
    stderr: () => stderr,
  };
}
it('uses real child stdio initialize/list/call and shares replay, CAS and events with another process', async (t) => {
  const f = await withStudio(t);
  const c = await client(t, f.directory);
  const init = await c.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  const listed = await c.request('tools/list');
  assert.deepEqual(
    listed.result.tools.map((x) => x.name),
    ['studio_status', 'studio_command', 'studio_events']
  );
  const envelope = {
    projectId: 'p1',
    commandId: 'shared',
    aggregate: { kind: 'production', id: 'prod' },
    expectedRevision: 0,
    type: 'production.create',
    payload: { id: 'prod', title: 'Prod', sourcePackageId: null },
  };
  const result = await c.request('tools/call', {
    name: 'studio_command',
    arguments: { envelope },
  });
  assert.equal(result.result.isError, false);
  assert.equal(JSON.parse(result.result.content[0].text).replayed, false);
  assert.equal((await f.service.command(envelope)).replayed, true);
  const other = await client(t, f.directory);
  await other.request('initialize', { protocolVersion: '2024-11-05' });
  const replay = await other.request('tools/call', {
    name: 'studio_command',
    arguments: { envelope },
  });
  assert.equal(JSON.parse(replay.result.content[0].text).replayed, true);
  const stale = await other.request('tools/call', {
    name: 'studio_command',
    arguments: { envelope: { ...envelope, commandId: 'stale' } },
  });
  assert.equal(stale.result.isError, true);
  assert.equal(
    JSON.parse(stale.result.content[0].text).error.code,
    'REVISION_CONFLICT'
  );
  const events = await c.request('tools/call', {
    name: 'studio_events',
    arguments: { projectId: 'p1', after: 1 },
  });
  assert.equal(JSON.parse(events.result.content[0].text).length, 1);
  const status = await c.request('tools/call', {
    name: 'studio_status',
    arguments: { projectId: 'p1' },
  });
  assert.equal(
    JSON.parse(status.result.content[0].text).snapshot.productions.length,
    1
  );
  assert.equal(c.stderr(), '');
  c.child.stdin.end();
  assert.equal(await new Promise((resolve) => c.child.on('exit', resolve)), 0);
});
it('rejects malformed JSON-RPC and bounded oversized stdio frames without executing commands', async (t) => {
  const f = await withStudio(t);
  const c = await client(t, f.directory);
  const invalid = await c.request('no-such-method');
  assert.equal(invalid.error.code, -32002);
  await c.request('initialize', { protocolVersion: '2024-11-05' });
  assert.equal((await c.request('no-such-method')).error.code, -32601);
  const malformed = await c.request('tools/call', null);
  assert.equal(malformed.error.code, -32600);
  const unknown = await c.request('tools/call', {
    name: 'unknown',
    arguments: {},
  });
  assert.equal(unknown.error.code, -32602);
  const large = await c.request('tools/call', {
    name: 'studio_command',
    arguments: {
      envelope: {
        projectId: 'p1',
        commandId: 'oversized',
        aggregate: { kind: 'project', id: 'p1' },
        expectedRevision: 1,
        type: 'bad',
        payload: { body: '한'.repeat(360000) },
      },
    },
  });
  assert.equal(large.error.code, -32600);
  c.child.stdin.write('x'.repeat(32768));
  c.child.stdin.end();
  assert.equal(await new Promise((resolve) => c.child.on('exit', resolve)), 1);
  assert.equal((await f.service.snapshot('p1')).productions.length, 0);
  assert.equal(c.stderr(), '');
});
it('accepts bounded large import frames and leaves queued generation untouched without a configured worker', async (t) => {
  const { withGeneration, generationCommand } = await import(
    './helpers/project.js'
  );
  const { makeSourcePackage, hashBytes } = await import(
    '../src/source/source-package.js'
  );
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ['image'], models: ['fake-v1'] }),
      },
    },
  });
  await generationCommand(f);
  const before = await f.service.snapshot('p1');
  assert.equal(before.attempts[0].status, 'prepared');
  const c = await client(t, f.directory);
  await c.request('initialize', { protocolVersion: '2024-11-05' });
  const status = await c.request('tools/call', {
    name: 'studio_status',
    arguments: { projectId: 'p1' },
  });
  assert.equal(
    JSON.parse(status.result.content[0].text).snapshot.attempts[0].status,
    'prepared'
  );
  const bytes = Buffer.alloc(600000, 128);
  const blobId = hashBytes(bytes);
  const pkg = makeSourcePackage({
    id: 'large-source',
    sourceKind: 'studio-script',
    sourceRevision: 'v1',
    textUnits: [],
    sceneScopes: [],
    sourceIdentityMap: [],
    blobManifest: [
      { id: 'raw', kind: 'raw', blobId, byteLength: bytes.length },
    ],
    revealPolicy: {},
    preservationStatus: { actualSourceBytes: 'complete' },
  });
  const envelope = {
    projectId: 'p1',
    commandId: 'large-import',
    aggregate: { kind: 'sourcePackage', id: 'large-source' },
    expectedRevision: 0,
    type: 'source.import',
    payload: { package: pkg, blobs: [{ blobId, bytes: [...bytes] }] },
  };
  const imported = await c.request('tools/call', {
    name: 'studio_command',
    arguments: { envelope },
  });
  assert.equal(imported.result.isError, false);
  assert.equal(
    JSON.parse(imported.result.content[0].text).value.id,
    'large-source'
  );
  assert.deepEqual(Buffer.from(await f.service.readBlob('p1', blobId)), bytes);
  assert.equal((await f.service.snapshot('p1')).attempts[0].status, 'prepared');
});
it('shuts down the stdio CLI cleanly on SIGTERM with an idle initialized client', async (t) => {
  const f = await withStudio(t);
  const c = await client(t, f.directory);
  await c.request('initialize', { protocolVersion: '2024-11-05' });
  c.child.kill('SIGTERM');
  assert.equal(await new Promise((resolve) => c.child.on('exit', resolve)), 0);
  assert.equal(c.stderr(), '');
});
