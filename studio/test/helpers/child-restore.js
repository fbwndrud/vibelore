import { BlobStore } from '../../src/engine/blob-store.js';
import { restoreStudioBackup } from '../../src/engine/backup.js';
const [archive, directory] = process.argv.slice(2);
// Simulate a kill after restored rows are written and before every blob is published.
BlobStore.prototype.put = function () {
  process.kill(process.pid, 'SIGKILL');
  return new Promise(() => {});
};
await restoreStudioBackup({ archive, directory });
