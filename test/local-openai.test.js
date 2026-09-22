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
