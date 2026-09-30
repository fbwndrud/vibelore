import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createLocalOpenAIProvider } from '../src/provider/local-openai.js';

test('a stalled local model cannot hold the MCP queue indefinitely', async (t) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const provider = createLocalOpenAIProvider({ baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'test', timeoutMs: 30 });
  await assert.rejects(provider.complete({ messages: [] }), (error) => ['TimeoutError', 'AbortError'].includes(error.name));
});

test('images named by a request are attached to the last user message so a vision model can open them', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'vibelore-local-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = Buffer.from('89504e470d0a1a0a', 'hex'), path = join(dir, 'scene.png');
  await writeFile(path, png);
  let sent;
  const fetchImpl = async (_url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }; };
  const provider = createLocalOpenAIProvider({ baseUrl: 'http://local', model: 'vision', fetchImpl });
  await provider.complete({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '{"review":true}' }], images: [{ path, mime: 'image/png' }] });
  assert.equal(sent.messages[0].content, 'sys');
  assert.deepEqual(sent.messages[1].content, [{ type: 'text', text: '{"review":true}' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }]);
  await provider.complete({ messages: [{ role: 'user', content: 'plain' }] });
  assert.equal(sent.messages[0].content, 'plain');
});
