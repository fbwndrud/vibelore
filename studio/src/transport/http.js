import { renderCapabilities } from '../render/probe.js';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BLOB_ID, assertId } from '../engine/contracts.js';
import {
  JSON_LIMIT,
  IMPORT_LIMIT,
  importTypes,
  TransportError,
  publicFailure,
  queryProject,
  queryCursor,
  readJSON,
  capabilities,
  requireLibrary,
} from './common.js';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ...[
    'app.js',
    'api.js',
    'story.js',
    'cast.js',
    'asset-lab.js',
    'edit.js',
    'production.js',
    'backup.js',
    'player.js',
    'dom.js',
    'camera.js',
    'workflow.js',
    'management.js',
    'library.js',
    'performance.js',
  ].map((file) => [`/${file}`, [file, 'text/javascript; charset=utf-8']]),
  [
    '/src/render/performance.js',
    ['../src/render/performance.js', 'text/javascript; charset=utf-8'],
  ],
  [
    '/render/frame.js',
    ['../render/frame.js', 'text/javascript; charset=utf-8'],
  ],
  ['/studio.css', ['studio.css', 'text/css; charset=utf-8']],
]);
const uiRoot = new URL('../../ui/', import.meta.url);
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
function secureHeaders(response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', csp);
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
}
function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}
export async function startStudioHttp({
  service,
  library,
  port = 0,
  sourceCapture = false,
  providerCapabilities = [],
  projectId = 'p1',
  destinationKey = randomBytes(32).toString('hex'),
} = {}) {
  if (!service || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new TransportError('INVALID_CONFIGURATION');
  assertId(projectId);
  const rendering = await renderCapabilities();
  const token = randomBytes(32).toString('hex');
  const pending = new Set(),
    streams = new Set(),
    requests = new Set();
  let url,
    closing = false,
    closePromise;
  // Host/Origin/Sec-Fetch-Site and the bootstrap token stop cross-site browser requests.
  // A local process can forge these headers and read the token; that is a documented limit.
  function authorize(request, bootstrap) {
    if (request.headers.host !== new URL(url).host)
      throw new TransportError('FORBIDDEN', 403);
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== url)
      throw new TransportError('FORBIDDEN', 403);
    const site = request.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none')
      throw new TransportError('FORBIDDEN', 403);
    if (bootstrap) {
      if (origin !== url && site !== 'same-origin')
        throw new TransportError('FORBIDDEN', 403);
      return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new TransportError('FORBIDDEN', 403);
  }
  async function streamEvents(request, response, projectId, after) {
    let cursor = after;
    // Validate project/cursor before switching to a successful streaming response.
    let events = await service.events(projectId, cursor, 200);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    const stop = new AbortController();
    streams.add(stop);
    const abort = () => stop.abort();
    response.once('close', abort);
    try {
      while (!stop.signal.aborted && !closing) {
        for (const event of events) {
          if (stop.signal.aborted) break;
          if (
            !response.write(
              `id: ${event.cursor}\nevent: studio\ndata: ${JSON.stringify(
                event,
              )}\n\n`,
            )
          ) {
            await new Promise((resolve) => {
              const done = () => {
                response.off('drain', done);
                stop.signal.removeEventListener('abort', done);
                resolve();
              };
              response.once('drain', done);
              stop.signal.addEventListener('abort', done, { once: true });
            });
          }
          cursor = event.cursor;
        }
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            stop.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, 50);
          stop.signal.addEventListener('abort', done, { once: true });
          if (stop.signal.aborted) done();
        });
        if (!stop.signal.aborted && !closing)
          events = await service.events(projectId, cursor, 200);
      }
    } finally {
      streams.delete(stop);
      response.off('close', abort);
      response.end();
    }
  }
  async function handle(request, response) {
    secureHeaders(response);
    try {
      if (closing) throw new TransportError('STUDIO_CLOSED', 503);
      // Reject encoding/traversal before WHATWG URL normalization can hide it.
      if (
        !request.url.startsWith('/') ||
        /%2f|%5c|\\|(?:^|\/)\.\.(?:\/|$)|%2e/i.test(request.url.split('?')[0])
      )
        throw new TransportError('INVALID_PATH');
      const target = new URL(request.url, url);
      if (target.pathname.startsWith('/api/')) {
        const bootstrap = target.pathname === '/api/bootstrap';
        authorize(request, bootstrap);
        if (bootstrap && request.method === 'GET')
          return json(response, 200, {
            token,
            projectId,
            destinationKey,
            ...capabilities(sourceCapture, library),
            providers: providerCapabilities,
            rendering,
          });
        if (
          request.method === 'POST' &&
          [
            '/api/library/commands',
            '/api/library/query',
            '/api/library/export',
            '/api/reuse/inspect',
          ].includes(target.pathname)
        ) {
          const body = await readJSON(
            request,
            target.pathname === '/api/reuse/inspect'
              ? IMPORT_LIMIT
              : JSON_LIMIT,
          );
          const value =
            target.pathname === '/api/reuse/inspect'
              ? await service.inspectReuse(body)
              : target.pathname === '/api/library/commands'
              ? await requireLibrary(library).command(body)
              : target.pathname === '/api/library/query'
              ? await requireLibrary(library).query(body)
              : await requireLibrary(library).exportExact(body);
          return json(response, 200, value);
        }
        if (request.method === 'GET' && target.pathname === '/api/snapshot')
          return json(
            response,
            200,
            await service.snapshot(queryProject(target)),
          );
        if (
          request.method === 'POST' &&
          ['/api/commands', '/api/import'].includes(target.pathname)
        ) {
          const upload = target.pathname === '/api/import';
          const envelope = await readJSON(
            request,
            upload ? IMPORT_LIMIT : JSON_LIMIT,
          );
          if (upload && !importTypes.has(envelope?.type))
            throw new TransportError('INVALID_IMPORT');
          return json(response, 200, await service.command(envelope));
        }
        if (request.method === 'GET' && target.pathname === '/api/history')
          return json(
            response,
            200,
            await service.history(queryProject(target), {
              limit: queryCursor(target.searchParams.get('limit') ?? '50'),
              ...(target.searchParams.has('before')
                ? { before: queryCursor(target.searchParams.get('before')) }
                : {}),
            }),
          );
        if (request.method === 'GET' && target.pathname === '/api/events')
          return await streamEvents(
            request,
            response,
            queryProject(target),
            queryCursor(target.searchParams.get('after') ?? '0'),
          );
        if (
          request.method === 'GET' &&
          target.pathname.startsWith('/api/blobs/')
        ) {
          const blobId = target.pathname.slice('/api/blobs/'.length);
          if (!BLOB_ID.test(blobId)) throw new TransportError('INVALID_BLOB');
          const bytes = await service.readBlob(queryProject(target), blobId);
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': bytes.length,
          });
          return response.end(bytes);
        }
        throw new TransportError('NOT_FOUND', 404);
      }
      if (
        request.headers.host !== new URL(url).host ||
        (request.headers.origin && request.headers.origin !== url)
      )
        throw new TransportError('FORBIDDEN', 403);
      const file = staticFiles.get(target.pathname);
      if (request.method !== 'GET' || !file)
        throw new TransportError('NOT_FOUND', 404);
      let bytes;
      try {
        bytes = await readFile(new URL(file[0], uiRoot));
      } catch {
        throw new TransportError('NOT_FOUND', 404);
      }
      response.writeHead(200, { 'content-type': file[1] });
      response.end(bytes);
    } catch (error) {
      if (!response.headersSent) {
        const failure = publicFailure(error);
        json(response, failure.status, { error: failure.error });
      } else response.end();
      request.resume();
    }
  }
  const server = createServer((request, response) => {
    requests.add(request);
    request.once('close', () => requests.delete(request));
    const work = handle(request, response);
    pending.add(work);
    work.finally(() => pending.delete(work));
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    async close() {
      if (!closePromise) {
        closing = true;
        for (const stop of streams) stop.abort();
        for (const request of requests)
          if (!request.complete) request.destroy();
        closePromise = (async () => {
          const stopped = new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          server.closeIdleConnections();
          await Promise.allSettled([...pending]);
          await stopped;
        })();
      }
      return closePromise;
    },
  };
}
