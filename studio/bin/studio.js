#!/usr/bin/env node
import { parseOptions, configuredStudio } from '../src/transport/config.js';
import { startStudioHttp } from '../src/transport/http.js';
let service, app;
let shutdown;
async function close() {
  if (!shutdown)
    shutdown = (async () => {
      await app?.close();
      await service?.close();
    })();
  return shutdown;
}
try {
  const options = parseOptions(process.argv.slice(2));
  const configured = await configuredStudio(options);
  service = configured.service;
  app = await startStudioHttp({ ...configured, port: options.port });
  const stop = () => {
    close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      }
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write(`Studio listening at ${app.url}\n`);
} catch {
  process.stderr.write('Studio could not start. Check local configuration.\n');
  await close();
  process.exitCode = 1;
}
