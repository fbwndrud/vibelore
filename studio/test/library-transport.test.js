import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { withStudio } from './helpers/project.js';
import { environmentSlot } from './helpers/images.js';
import { openLibrary } from '../src/library/index.js';
import { createStudioOwnerAdapter } from '../src/source/export-studio-assets.js';
import { startStudioHttp } from '../src/transport/http.js';
import { serveStudioMcp } from '../src/transport/mcp.js';
import { parseOptions, configuredStudio } from '../src/transport/config.js';
import { pngBytes } from './helpers/bundles.js';

export async function libraryFixture(t) {
  const f = await withStudio(t);
  const directory = await mkdtemp(join(tmpdir(), 'studio-library-transport-'));
  const library = await openLibrary({
    directory,
    adapters: { studio: createStudioOwnerAdapter },
  });
  t.after(async () => {
    await library.close();
    await rm(directory, { recursive: true, force: true });
  });
  const app = await startStudioHttp({ service: f.service, library });
  t.after(app.close);
  const config = await (
    await fetch(`${app.url}/api/bootstrap`, { headers: { origin: app.url } })
  ).json();
  const headers = {
    origin: app.url,
    authorization: `Bearer ${config.token}`,
    'content-type': 'application/json',
  };
  const post = (path, body, extra = {}) =>
    fetch(`${app.url}${path}`, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  return { ...f, library, app, config, post };
}
async function mcp(service, library, name, args) {
  let text = '';
  await serveStudioMcp({
    service,
    library,
    input: Readable.from([
      Buffer.from(
        [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name, arguments: args },
          },
        ]
          .map((x) => JSON.stringify(x))
          .join('\n') + '\n',
      ),
    ]),
    output: new Writable({
      write(chunk, enc, cb) {
        text += chunk;
        cb();
      },
    }),
  });
  return JSON.parse(text.trim().split('\n').at(-1)).result;
}
test('explicit Library CLI enables built-in read-only owners without registering or scanning', async (t) => {
  const f = await withStudio(t);
  const directory = join(f.directory, 'explicit-library');
  const options = parseOptions([
    '--project',
    f.directory,
    '--library',
    directory,
  ]);
  assert.equal(options.library, directory);
  const configured = await configuredStudio(options);
  t.after(async () => {
    await configured.library?.close();
    await configured.service.close();
  });
  assert.deepEqual(
    (await configured.library.query({ type: 'find' })).owners,
    [],
  );
});
test('HTTP and MCP share Library registration, exact export, inspection and import receipts', async (t) => {
  const f = await libraryFixture(t);
  assert.equal(f.config.library.available, true);
  const slot = environmentSlot();
  const native = await f.command(
    'asset.import',
    {
      id: 'native-image',
      mediaKind: 'image',
      slot,
      bytes: pngBytes,
      mime: 'image/png',
      actor: 'creator',
      reason: 'actual fixture',
    },
    { aggregate: { kind: 'assetSlot', id: slot.id } },
  );
  const register = {
    commandId: 'register',
    expectedRegistryRevision: 0,
    type: 'owner.register',
    payload: {
      adapterKind: 'studio',
      locator: { directory: f.directory },
      allowedProjects: ['p1'],
    },
  };
  const registered = await (
    await f.post('/api/library/commands', register)
  ).json();
  assert.deepEqual(registered, await f.library.command(register));
  const refreshed = await (
    await f.post('/api/library/commands', {
      commandId: 'refresh',
      expectedRegistryRevision: registered.registryRevision,
      type: 'owner.refresh',
      payload: { ownerId: registered.ownerId },
    })
  ).json();
  assert.equal(refreshed.status, 'observed-available');
  const found = await (
    await f.post('/api/library/query', { type: 'find', mediaKind: 'image' })
  ).json();
  assert.ok(found.entries.length);
  assert.equal(JSON.stringify(found).includes(f.directory), false);
  const selected = found.entries.find(
    (x) => x.ref.recordId === native.value.candidate.id,
  );
  const args = {
    ownerId: registered.ownerId,
    roots: [selected.ref],
    disclosure: { includedScope: 'explicit fixture', omittedEvidence: [] },
  };
  const exported = await (await f.post('/api/library/export', args)).json();
  const direct = await f.library.exportExact(args);
  assert.deepEqual(exported.bytes, direct.bytes);
  assert.deepEqual(exported.bundle.records, direct.bundle.records);
  const target = { ...slot, id: 'preserved' };
  const intent = {
    target: { kind: 'assetSlot', id: target.id },
    purpose: 'new setting',
    identityMap: [],
    stateMap: [],
    selections: [
      { source: selected.ref, slot: target, role: 'environment-reference' },
    ],
  };
  const inspectArgs = { projectId: 'p1', ...exported, intent };
  const inspected = await (
    await f.post('/api/reuse/inspect', inspectArgs)
  ).json();
  assert.equal(inspected.disposition, 'compatible');
  assert.deepEqual(inspected, await f.service.inspectReuse(inspectArgs));
  const envelope = {
    projectId: 'p1',
    commandId: 'preserve',
    aggregate: intent.target,
    expectedRevision: 0,
    type: 'asset.importBundle',
    payload: {
      ...exported,
      intent,
      inspectionDigest: inspected.inspectionDigest,
      actor: 'creator',
      reason: 'preserve',
    },
  };
  const result = await (await f.post('/api/import', envelope)).json();
  assert.ok(result.value.importReceipt);
  const replay = await mcp(f.service, f.library, 'studio_command', {
    envelope,
  });
  assert.equal(replay.isError, false);
  assert.deepEqual(JSON.parse(replay.content[0].text).value, result.value);
  const query = await mcp(f.service, f.library, 'studio_library_query', {
    request: { type: 'find' },
  });
  assert.equal(query.isError, false);
  assert.deepEqual(
    JSON.parse(query.content[0].text),
    await f.library.query({ type: 'find' }),
  );
  assert.equal((await f.service.snapshot('p1')).adoptions.length, 0);
});
test('Library endpoints retain authorization, body limits and private error sanitization', async (t) => {
  const f = await libraryFixture(t);
  for (const headers of [
    { authorization: '' },
    { origin: 'https://evil.invalid' },
    { 'sec-fetch-site': 'cross-site' },
  ]) {
    assert.equal(
      (await f.post('/api/library/query', { type: 'find' }, headers)).status,
      403,
    );
  }
  const hostileHost = await new Promise((resolve, reject) => {
    const r = http.request(
      `${f.app.url}/api/library/query`,
      { method: 'POST', headers: { host: 'evil.invalid' } },
      (s) => {
        s.resume();
        s.on('end', () => resolve(s.statusCode));
      },
    );
    r.on('error', reject);
    r.end('{}');
  });
  assert.equal(hostileHost, 403);
  assert.equal(
    (
      await f.post('/api/library/query', {
        type: 'find',
        text: 'x'.repeat(1024 * 1024),
      })
    ).status,
    413,
  );
  // Inspection gets the import limit; schema failure rather than ordinary JSON size failure.
  const inspected = await f.post('/api/reuse/inspect', {
    projectId: 'p1',
    bundle: { padding: 'x'.repeat(1024 * 1024 + 10) },
    bytes: {},
    intent: {},
  });
  assert.equal(inspected.status, 200);
  assert.equal((await inspected.json()).disposition, 'blocked');
  const failed = await f.post('/api/library/commands', {
    commandId: 'bad',
    expectedRegistryRevision: 0,
    type: 'owner.register',
    payload: {
      adapterKind: 'studio',
      locator: { directory: '/private/secret/not-present' },
      allowedProjects: ['p1'],
    },
  });
  const error = await failed.text();
  assert.equal(error.includes('/private/secret'), false);
  assert.match(error, /OWNER_OFFLINE|SOURCE_MISSING/);
});

test('queue destination identity survives configured restarts and isolates another store at the same project ID', async (t) => {
  const a = await withStudio(t),
    b = await withStudio(t);
  const first = await configuredStudio({ project: a.directory }),
    second = await configuredStudio({ project: a.directory }),
    other = await configuredStudio({ project: b.directory });
  t.after(async () => {
    for (const c of [first, second, other]) await c.service.close();
  });
  assert.match(first.destinationKey, /^[a-f0-9]{64}$/);
  assert.equal(first.destinationKey, second.destinationKey);
  assert.notEqual(first.destinationKey, other.destinationKey);
  const configured = await startStudioHttp({ ...first });
  t.after(configured.close);
  const response = await (
    await fetch(`${configured.url}/api/bootstrap`, {
      headers: { origin: configured.url },
    })
  ).json();
  assert.equal(response.destinationKey, first.destinationKey);
  const one = await startStudioHttp({ service: a.service }),
    two = await startStudioHttp({ service: a.service });
  t.after(one.close);
  t.after(two.close);
  const boot = (app) =>
    fetch(`${app.url}/api/bootstrap`, { headers: { origin: app.url } }).then(
      (r) => r.json(),
    );
  assert.notEqual(
    (await boot(one)).destinationKey,
    (await boot(two)).destinationKey,
  );
  const { preservationKey } = await import('../ui/library.js');
  assert.notEqual(
    preservationKey(
      { bootstrap: { destinationKey: first.destinationKey } },
      'p1',
    ),
    preservationKey(
      { bootstrap: { destinationKey: other.destinationKey } },
      'p1',
    ),
  );
});
