#!/usr/bin/env node
import { parseOptions, configuredStudio } from '../src/transport/config.js';
import { serveStudioMcp } from '../src/transport/mcp.js';
let service;
let stopping = false;
try {
  const configured = await configuredStudio(
    parseOptions(process.argv.slice(2))
  );
  service = configured.service;
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
  process.exitCode =
    stopping && error?.code === 'ERR_STREAM_PREMATURE_CLOSE' ? 0 : 1;
} finally {
  try {
    await service?.close();
  } catch {
    process.exitCode = 1;
  }
}
