import assert from 'node:assert/strict';
import { it } from 'node:test';
import http from 'node:http';
import { withStudio } from './helpers/project.js';
import { makeSourcePackage, hashBytes } from '../src/source/source-package.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function start(t) {
  const f = await withStudio(t);
  const transport = await import('../src/transport/http.js').catch(() => ({}));
  assert.equal(
    typeof transport.startStudioHttp,
    'function',
    'HTTP daemon must exist'
  );
  const app = await transport.startStudioHttp({ service: f.service, port: 0 });
  t.after(() => app.close());
  const bootstrap = await fetch(`${app.url}/api/bootstrap`, {
    headers: { origin: app.url },
  });
  const config = await bootstrap.json();
  const headers = {
    origin: app.url,
    authorization: `Bearer ${config.token}`,
    'content-type': 'application/json',
  };
  return {
    ...f,
    ...app,
    headers,
    config,
    send: (envelope, route = '/api/commands') =>
      fetch(`${app.url}${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(envelope),
      }),
  };
}

it('serves every module reachable from the browser entry point', async t => {
  const app = await start(t);
  const pending = ['/app.js'], visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const url = new URL(path, app.url);
    const response = await fetch(url, { headers: { origin: app.url } });
    assert.equal(response.status, 200, `Browser dependency ${path} must be served`);
    assert.match(response.headers.get('content-type'), /javascript/);
    const source = await response.text();
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      pending.push(new URL(match[1], url).pathname);
    }
  }
  assert.ok(visited.has('/dom.js'));
  assert.ok(visited.has('/render/frame.js'));
});
const production = (id = 'prod', commandId = 'prod-create') => ({
  projectId: 'p1',
  commandId,
  aggregate: { kind: 'production', id },
  expectedRevision: 0,
  type: 'production.create',
  payload: { id, title: 'Production', sourcePackageId: null },
});
it('bootstraps a same-origin token and creates with durable replay and independent-client CAS', async (t) => {
  const f = await start(t);
  assert.equal(f.config.sourceCapture.available, false);
  assert.equal(f.config.projectId, 'p1');
  assert.ok(f.config.token.length >= 32);
  const a = await f.send(production());
  const result = await a.json();
  assert.equal(a.status, 200);
  assert.equal(result.replayed, false);
  const second = await fetch(`${f.url}/api/commands`, {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify(production()),
  });
  assert.equal((await second.json()).replayed, true);
  const stale = await f.send(production('prod', 'other-command'));
  assert.equal(stale.status, 409);
  const snapshot = await fetch(`${f.url}/api/snapshot?projectId=p1`, {
    headers: f.headers,
  });
  assert.equal(snapshot.headers.get('cache-control'), 'no-store');
  assert.ok(
    snapshot.headers
      .get('content-security-policy')
      .includes("default-src 'self'")
  );
  assert.equal((await snapshot.json()).productions.length, 1);
});
it('rejects hostile origin, Host, missing token and cross-origin bootstrap before mutation', async (t) => {
  const f = await start(t);
  const initial = (await f.service.snapshot('p1')).eventCursor;
  for (const headers of [
    { ...f.headers, origin: 'https://foreign.example' },
    { origin: f.url, 'content-type': 'application/json' },
  ]) {
    assert.equal(
      (
        await fetch(`${f.url}/api/commands`, {
          method: 'POST',
          headers,
          body: JSON.stringify(production()),
        })
      ).status,
      403
    );
  }
  const hostileHost = await new Promise((resolve, reject) => {
    const request = http.request(
      `${f.url}/api/commands`,
      { method: 'POST', headers: { ...f.headers, host: 'evil.example' } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      }
    );
    request.on('error', reject);
    request.end(JSON.stringify(production()));
  });
  assert.equal(hostileHost, 403);
  for (const origin of ['https://foreign.example', 'null'])
    assert.equal(
      (await fetch(`${f.url}/api/bootstrap`, { headers: { origin } })).status,
      403
    );
  assert.equal((await fetch(`${f.url}/api/bootstrap`)).status, 403);
  assert.equal((await f.service.snapshot('p1')).eventCursor, initial);
});
it('rejects streamed UTF-8 JSON exceeding 1 MiB and declared import over 128 MiB', async (t) => {
  const f = await start(t);
  const response = await fetch(`${f.url}/api/commands`, {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({
      ...production(),
      payload: { ...production().payload, title: '한'.repeat(360000) },
    }),
  });
  assert.equal(response.status, 413);
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(
      `${f.url}/api/commands`,
      { method: 'POST', headers: f.headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.write('{"a":"');
    for (let i = 0; i < 17; i++) req.write('x'.repeat(65536));
    req.end('"}');
  });
  assert.equal(chunked, 413);
  const declared = await new Promise((resolve, reject) => {
    const req = http.request(
      `${f.url}/api/import`,
      {
        method: 'POST',
        headers: { ...f.headers, 'content-length': 134217729 },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(declared, 413);
  assert.equal((await f.send(production(), '/api/import')).status, 400);
  assert.equal(
    (
      await fetch(`${f.url}/api/commands`, {
        method: 'POST',
        headers: { ...f.headers, 'content-type': 'text/plain' },
        body: '{}',
      })
    ).status,
    415
  );
});
it('imports real manuscript bytes, authorizes blobs by project and rejects traversal/static source paths', async (t) => {
  const f = await start(t);
  const bytes = Buffer.from('실제 원고');
  const blobId = hashBytes(bytes);
  const pkg = makeSourcePackage({
    id: 'source',
    sourceKind: 'studio-script',
    sourceRevision: 'v1',
    textUnits: [{ id: 'text', text: bytes.toString(), blobId }],
    sceneScopes: [],
    sourceIdentityMap: [],
    blobManifest: [
      { id: 'text', kind: 'text', blobId, byteLength: bytes.length },
    ],
    revealPolicy: {},
    preservationStatus: { actualSourceBytes: 'complete' },
  });
  const envelope = {
    projectId: 'p1',
    commandId: 'import',
    aggregate: { kind: 'sourcePackage', id: 'source' },
    expectedRevision: 0,
    type: 'source.import',
    payload: { package: pkg, blobs: [{ blobId, bytes: [...bytes] }] },
  };
  assert.equal((await f.send(envelope, '/api/import')).status, 200);
  const blob = await fetch(`${f.url}/api/blobs/${blobId}?projectId=p1`, {
    headers: f.headers,
  });
  assert.equal(blob.status, 200);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  assert.equal(
    (
      await fetch(`${f.url}/api/blobs/${blobId}?projectId=other`, {
        headers: f.headers,
      })
    ).status,
    404
  );
  assert.equal((await fetch(`${f.url}/api/blobs/${blobId}`)).status, 403);
  for (const path of [
    '/api/blobs/nope?projectId=p1',
    '/api/blobs/%2e%2e%2fsecret?projectId=p1',
    '/%2e%2e%2fpackage.json',
    '/chapters/001.md',
    '/src/server.js',
    '/app.js/extra',
  ])
    assert.ok(
      (await fetch(`${f.url}${path}`, { headers: f.headers })).status >= 400,
      path
    );
});
it('streams authenticated SSE and reconnects strictly after the recorded cursor', async (t) => {
  const f = await start(t);
  await f.send(production());
  const controller = new AbortController();
  const response = await fetch(`${f.url}/api/events?projectId=p1&after=1`, {
    headers: f.headers,
    signal: controller.signal,
  });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  assert.ok(text.includes('id: 2'));
  assert.ok(!text.includes('id: 1\n'));
  controller.abort();
  const c2 = new AbortController();
  const next = await fetch(`${f.url}/api/events?projectId=p1&after=2`, {
    headers: f.headers,
    signal: c2.signal,
  });
  const r2 = next.body.getReader();
  const read = r2.read();
  await f.send(production('second', 'second-create'));
  const out = new TextDecoder().decode((await read).value);
  assert.ok(out.includes('id: 3'));
  assert.ok(!out.includes('id: 2\n'));
  c2.abort();
});
it('redacts arbitrary backend error messages and details', async (t) => {
  const transport = await import('../src/transport/http.js').catch(() => ({}));
  assert.equal(typeof transport.startStudioHttp, 'function');
  const app = await transport.startStudioHttp({
    service: {
      snapshot: async () => {
        throw new Error('/private/provider-key secret');
      },
    },
    port: 0,
  });
  t.after(() => app.close());
  const { token } = await (
    await fetch(`${app.url}/api/bootstrap`, { headers: { origin: app.url } })
  ).json();
  const response = await fetch(`${app.url}/api/snapshot?projectId=p1`, {
    headers: { origin: app.url, authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 500);
  assert.ok(!JSON.stringify(await response.json()).includes('secret'));
});
it('runs real CLI from an empty directory and shuts down cleanly', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../bin/studio.js', import.meta.url)),
      '--project',
      directory,
      '--port',
      '0',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GEMINI_API_KEY: '' } }
  );
  t.after(() => child.kill());
  let error = '';
  child.stderr.on('data', (d) => (error += d));
  const url = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (d) => {
      text += d;
      const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
    child.on('exit', (code) =>
      reject(new Error(`CLI exited ${code}: ${error}`))
    );
  });
  const { token } = await (
    await fetch(`${url}/api/bootstrap`, { headers: { origin: url } })
  ).json();
  assert.ok(!error.includes(token));
  const response = await fetch(`${url}/api/commands`, {
    method: 'POST',
    headers: {
      origin: url,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      projectId: 'fresh',
      commandId: 'fresh',
      aggregate: { kind: 'project', id: 'fresh' },
      expectedRevision: 0,
      type: 'project.create',
      payload: { title: 'Fresh', language: 'ko', budgetMicros: 0 },
    }),
  });
  assert.equal(response.status, 200);
  child.kill('SIGTERM');
  assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 0);
});
it('configures real optional read-only capture, preserves original command replay and survives source removal', async (t) => {
  const { webtoonStore, workId } = await import(
    '../../test/fixtures/webtoon.js'
  );
  const { configuredStudio } = await import('../src/transport/config.js');
  const source = await import('../src/source/source-package.js');
  assert.equal(
    typeof source.registerSourceCaptureCommands,
    'function',
    'Configured capture must share source import authority'
  );
  const { readdir } = await import('node:fs/promises');
  const store = await webtoonStore();
  async function inventory(root, prefix = '') {
    const result = {};
    for (const entry of await readdir(join(root, prefix), {
      withFileTypes: true,
    })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        Object.assign(result, await inventory(root, path));
      else result[path] = hashBytes(await readFile(join(root, path)));
    }
    return result;
  }
  const original = await inventory(store.rootDir);
  const raw = await readFile(store.chapterPath(1));
  const directory = await mkdtemp(join(tmpdir(), 'studio-connected-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configured = await configuredStudio({
    project: directory,
    vibelore_root: store.rootDir,
  });
  t.after(() => configured.service.close());
  const { startStudioHttp } = await import('../src/transport/http.js');
  const app = await startStudioHttp({ ...configured, port: 0 });
  t.after(() => app.close());
  const config = await (
    await fetch(`${app.url}/api/bootstrap`, { headers: { origin: app.url } })
  ).json();
  assert.equal(config.sourceCapture.available, true);
  assert.ok(!JSON.stringify(config).includes(store.rootDir));
  const headers = {
    origin: app.url,
    authorization: `Bearer ${config.token}`,
    'content-type': 'application/json',
  };
  const send = (envelope) =>
    fetch(`${app.url}/api/commands`, {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope),
    });
  assert.equal(
    (
      await send({
        projectId: 'p1',
        commandId: 'create',
        aggregate: { kind: 'project', id: 'p1' },
        expectedRevision: 0,
        type: 'project.create',
        payload: { title: 'Connected', language: 'ko', budgetMicros: 0 },
      })
    ).status,
    200
  );
  const command = {
    projectId: 'p1',
    commandId: 'capture',
    aggregate: { kind: 'sourcePackage', id: 'selected' },
    expectedRevision: 0,
    type: 'source.capture',
    payload: {
      id: 'selected',
      workId,
      request: { kind: 'novel-chapters', chapters: [1] },
    },
  };
  const result = await send(command);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).value.id, 'selected');
  assert.deepEqual(await inventory(store.rootDir), original);
  const mcp = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../bin/studio-mcp.js', import.meta.url)),
      '--project',
      directory,
      '--vibelore-root',
      store.rootDir,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GEMINI_API_KEY: '' } }
  );
  t.after(() => mcp.kill());
  let text = '';
  let stderr = '';
  mcp.stderr.on('data', (d) => (stderr += d));
  mcp.stdout.on('data', (d) => (text += d));
  mcp.stdin.end(
    [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'studio_command', arguments: { envelope: command } },
      }),
    ].join('\n') + '\n'
  );
  assert.equal(await new Promise((resolve) => mcp.on('exit', resolve)), 0);
  assert.equal(stderr, '');
  const messages = text.trim().split('\n').map(JSON.parse);
  assert.equal(JSON.parse(messages[1].result.content[0].text).replayed, true);
  await rm(store.rootDir, { recursive: true, force: true });
  assert.equal((await (await send(command)).json()).replayed, true);
  const snapshot = await configured.service.snapshot('p1');
  assert.equal(snapshot.sourcePackages[0].id, 'selected');
  assert.ok(!JSON.stringify(snapshot).includes(store.rootDir));
  const chapter = snapshot.sourcePackages[0].blobManifest.find(
    (b) => b.kind === 'chapter'
  );
  assert.deepEqual(
    Buffer.from(await configured.service.readBlob('p1', chapter.blobId)),
    raw
  );
  const changed = await send({
    ...command,
    payload: {
      ...command.payload,
      request: { kind: 'novel-chapters', chapters: [2] },
    },
  });
  assert.equal(changed.status, 409);
});
it('enforces actual chunked import cap and rejects malformed UTF-8 without mutation', async (t) => {
  const f = await start(t);
  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      `${f.url}/api/import`,
      { method: 'POST', headers: f.headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    request.on('error', reject);
    let sent = 0;
    const chunk = Buffer.alloc(1024 * 1024, 32);
    function pump() {
      while (sent < 129) {
        sent++;
        if (!request.write(chunk)) {
          request.once('drain', pump);
          return;
        }
      }
      request.end();
    }
    pump();
  });
  assert.equal(response, 413);
  const invalid = await fetch(`${f.url}/api/commands`, {
    method: 'POST',
    headers: f.headers,
    body: Buffer.from([123, 34, 97, 34, 58, 34, 255, 34, 125]),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_JSON');
  assert.equal((await f.service.snapshot('p1')).productions.length, 0);
});

it('exposes explicit project selection and empty snapshot without automatically creating canon', async (t) => {
  const { parseOptions } = await import('../src/transport/config.js');
  const options = parseOptions([
    '--project',
    '/tmp/unused-project',
    '--project-id',
    'chosen',
    '--port',
    '0',
  ]);
  assert.equal(options.projectId, 'chosen');
  const f = await withStudio(t);
  const { startStudioHttp } = await import('../src/transport/http.js');
  const app = await startStudioHttp({
    service: f.service,
    port: 0,
    projectId: options.projectId,
  });
  t.after(() => app.close());
  const config = await (
    await fetch(`${app.url}/api/bootstrap`, { headers: { origin: app.url } })
  ).json();
  assert.equal(config.projectId, 'chosen');
  const missing = await fetch(`${app.url}/api/snapshot?projectId=chosen`, {
    headers: { authorization: `Bearer ${config.token}`, origin: app.url },
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'PROJECT_NOT_FOUND');
  assert.throws(
    () => parseOptions(['--project', '/tmp/project', '--project-id', '../bad']),
    { code: 'INVALID_INPUT' }
  );
  assert.throws(
    () =>
      parseOptions(['--project', '/tmp/project', '--port', '0', '--port', '1']),
    { code: 'INVALID_CONFIGURATION' }
  );
});
it('drains an accepted command and closes live SSE before stopping the transport', async (t) => {
  const f = await start(t);
  let release;
  let started;
  const ready = new Promise((resolve) => (started = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  f.service.registerCommand('test.delayed', {
    target: () => ({ kind: 'project', id: 'p1' }),
    prepare: async () => {
      started();
      await gate;
    },
    apply: () => ({ drained: true }),
  });
  const stream = await fetch(`${f.url}/api/events?projectId=p1&after=1`, {
    headers: f.headers,
  });
  const reading = stream.body.getReader().read();
  const command = f.send({
    projectId: 'p1',
    commandId: 'delayed',
    aggregate: { kind: 'project', id: 'p1' },
    expectedRevision: 1,
    type: 'test.delayed',
    payload: {},
  });
  await ready;
  const closing = f.close();
  release();
  const response = await command;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).value.drained, true);
  await closing;
  assert.equal((await reading).done, true);
  assert.equal((await f.service.snapshot('p1')).eventCursor, 2);
});
it('closes background work by aborting and awaiting the shared engine after transport drain', async (t) => {
  const f = await start(t);
  let drained = false;
  let stopped = false;
  const work = f.service.runBackground(
    (signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            stopped = true;
            setTimeout(() => {
              drained = true;
              resolve();
            }, 20);
          },
          { once: true }
        );
      })
  );
  await f.close();
  assert.equal(stopped, false);
  await f.service.close();
  await work;
  assert.equal(stopped, true);
  assert.equal(drained, true);
});
it('imports actual encoded assets through the generic bounded import adapter', async (t) => {
  const f = await start(t);
  const { png } = await import('./helpers/images.js');
  const bytes = await png([12, 34, 56, 255], 1, 1);
  const envelope = {
    projectId: 'p1',
    commandId: 'asset-import',
    aggregate: { kind: 'assetSlot', id: 'reference' },
    expectedRevision: 0,
    type: 'asset.import',
    payload: {
      id: 'image',
      bytes: [...bytes],
      mediaKind: 'image',
      actor: 'human',
      slot: {
        id: 'reference',
        scope: { kind: 'project', id: 'p1' },
        subject: { kind: 'environment', id: 'room' },
        appearanceStateRef: null,
      },
    },
  };
  const response = await f.send(envelope, '/api/import');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.value.candidate.mediaKind, 'image');
  assert.equal((await f.service.snapshot('p1')).candidates.length, 1);
});

it('returns bounded authenticated human history pages with saved scene changes and no raw manuscript payload', async t => {
  const f = await start(t);
  await f.send(production());
  const scene = { id:'sc', productionId:'prod', title:'실제 장면', occurrences:[], presentations:[], utterances:[], shots:[{id:'sh',title:'첫 구도'}] };
  const save = {projectId:'p1', commandId:'history-first', aggregate:{kind:'scene',id:'sc'}, expectedRevision:0, type:'scene.put',payload:scene};
  assert.equal((await f.send(save)).status,200);
  assert.equal((await f.send({...save,commandId:'history-second',expectedRevision:1,payload:{...scene,shots:[{id:'sh',title:'새 구도'}]}})).status,200);
  const response = await fetch(`${f.url}/api/history?projectId=p1&limit=2`,{headers:f.headers});
  assert.equal(response.status,200);
  const page = await response.json();
  assert.equal(page.entries.length,2);
  assert.ok(page.nextBefore > 0);
  assert.match(page.entries[0].label,/장면/);
  assert.match(page.entries[0].summary,/샷|구도/);
  assert.equal(page.entries[0].value,undefined,'History does not ship full source payloads');
  const older = await (await fetch(`${f.url}/api/history?projectId=p1&limit=2&before=${page.nextBefore}`,{headers:f.headers})).json();
  assert.ok(older.entries.every(e=>e.cursor < page.nextBefore));
  assert.equal(new Set([...page.entries,...older.entries].map(e=>e.cursor)).size,page.entries.length+older.entries.length);
  assert.equal((await fetch(`${f.url}/api/history?projectId=p1`)).status,403);
  assert.equal((await fetch(`${f.url}/api/history?projectId=p1&limit=101`,{headers:f.headers})).status,400);
});
