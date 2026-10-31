#!/usr/bin/env node
import { startupFailure } from '../src/transport/common.js';
import { parseOptions, configuredStudio } from '../src/transport/config.js';
import { serveStudioMcp } from '../src/transport/mcp.js';
let service, library;
let stopping = false;
try {
  const configured = await configuredStudio(
    parseOptions(process.argv.slice(2))
  );
  service = configured.service;
  library = configured.library;
  // Closing input stops intake; the transport finishes its current accepted command.
  const stop = () => {
    stopping = true;
    process.stdin.destroy();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const result = await serveStudioMcp(configured);
  process.exitCode = result.failed ? 1 : 0;
} catch (error) {
  if (!(stopping && error?.code === 'ERR_STREAM_PREMATURE_CLOSE'))
    process.stderr.write(`Studio MCP could not start (${startupFailure(error)}).\n`);
  process.exitCode =
    stopping && error?.code === 'ERR_STREAM_PREMATURE_CLOSE' ? 0 : 1;
} finally {
  try {
    try { await library?.close(); } finally { await service?.close(); }
  } catch {
    process.exitCode = 1;
  }
}
