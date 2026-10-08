import { once } from 'node:events';
import {
  JSON_LIMIT,
  IMPORT_LIMIT,
  importTypes,
  parseJSON,
  publicFailure,
  capabilities,
} from './common.js';
const tools = [
  {
    name: 'studio_status',
    description: 'Read a Studio project snapshot and local capabilities.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'studio_command',
    description:
      'Execute the shared Studio command envelope with CAS and idempotency.',
    inputSchema: {
      type: 'object',
      properties: { envelope: { type: 'object' } },
      required: ['envelope'],
      additionalProperties: false,
    },
  },
  {
    name: 'studio_events',
    description: 'Read durable events strictly after a cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        after: { type: 'integer', minimum: 0 },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
];
export async function serveStudioMcp({
  service,
  input = process.stdin,
  output = process.stdout,
  sourceCapture = false,
}) {
  let initialized = false;
  async function send(message) {
    if (!output.write(`${JSON.stringify(message)}\n`))
      await once(output, 'drain');
  }
  async function dispatch(message, size) {
    if (
      !message ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string' ||
      (message.id !== undefined &&
        typeof message.id !== 'string' &&
        typeof message.id !== 'number' &&
        message.id !== null)
    )
      return send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid request.' },
      });
    const notification = message.id === undefined;
    const answer = (result) =>
      notification
        ? undefined
        : send({ jsonrpc: '2.0', id: message.id, result });
    const error = (code, text) =>
      notification
        ? undefined
        : send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code, message: text },
          });
    const { method, params = {} } = message;
    if (!params || typeof params !== 'object' || Array.isArray(params))
      return error(-32600, 'Invalid request.');
    const upload =
      method === 'tools/call' &&
      params.name === 'studio_command' &&
      importTypes.has(params.arguments?.envelope?.type);
    if (size > (upload ? IMPORT_LIMIT : JSON_LIMIT))
      return error(-32600, 'Request too large.');
    if (method === 'initialize') {
      if (initialized) return error(-32600, 'Already initialized.');
      initialized = true;
      return answer({
        protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(
          params.protocolVersion
        )
          ? params.protocolVersion
          : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'lore-studio', version: '0.1.0' },
      });
    }
    if (method === 'notifications/initialized') return;
    if (!initialized) return error(-32002, 'Server is not initialized.');
    if (method === 'ping') return answer({});
    if (method === 'tools/list') return answer({ tools });
    if (method !== 'tools/call') return error(-32601, 'Method not found.');
    if (!tools.some((tool) => tool.name === params.name))
      return error(-32602, 'Unknown tool.');
    try {
      const args = params.arguments ?? {};
      let value;
      if (params.name === 'studio_status')
        value = {
          snapshot: await service.snapshot(args.projectId),
          ...capabilities(sourceCapture),
        };
      else if (params.name === 'studio_events')
        value = await service.events(args.projectId, args.after ?? 0);
      else value = await service.command(args.envelope);
      return answer({
        content: [{ type: 'text', text: JSON.stringify(value) }],
        isError: false,
      });
    } catch (cause) {
      return answer({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: publicFailure(cause).error }),
          },
        ],
        isError: true,
      });
    }
  }
  // MCP stdio uses newline-delimited UTF-8 JSON, not HTTP Content-Length framing.
  let frameParts = [];
  let frameSize = 0;
  for await (const chunk of input) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      frameSize += part.length;
      if (frameSize > IMPORT_LIMIT) {
        await send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Request too large.' },
        });
        return { failed: true };
      }
      if (part.length) frameParts.push(part);
      if (newline < 0) break;
      const size = frameSize;
      const frame = Buffer.concat(frameParts, size);
      frameParts = [];
      frameSize = 0;
      offset = newline + 1;
      if (!size) continue;
      let message;
      try {
        message = parseJSON(frame);
      } catch {
        await send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error.' },
        });
        continue;
      }
      await dispatch(message, size);
    }
  }
  if (frameSize) {
    await send({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Incomplete frame.' },
    });
    return { failed: true };
  }
  return { failed: false };
}
