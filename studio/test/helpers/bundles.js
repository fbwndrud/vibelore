import { createHash } from 'node:crypto';
import { sealBundle } from '../../src/reuse/bundle.js';

export const ref = (overrides = {}) => ({
  ownerId: 'ea2dc037-a423-4ec7-ab48-7dc089ef11aa', projectId: 'source-project',
  recordKind: 'candidate', recordId: 'portrait', revision: 'sha256:original-revision', ...overrides
});

// A real, one-pixel PNG. Two semantic records may intentionally share these bytes.
export const pngBytes = [...Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPQsAn4DwAC+AG0SoDrgAAAAABJRU5ErkJggg==', 'base64')];
export const pngSha256 = createHash('sha256').update(Buffer.from(pngBytes)).digest('hex');
export function bundleFixture({ roots = [ref()], records, files, links = [] } = {}) {
  return {
    bundle: sealBundle({
      schemaVersion: 1, roots,
      records: records ?? [{ ref: ref(), metadata: { title: 'Portrait', mediaKind: 'image', subjects: [{ ownerId: ref().ownerId, projectId: 'source-project', identityId: 'hero', stateRefs: [] }] }, requiredFileSha256s: [pngSha256], sourcePins: {}, evidenceRefs: [] }],
      files: files ?? [{ sha256: pngSha256, byteLength: pngBytes.length, mime: 'image/png', role: 'selected-content' }],
      links, disclosure: { includedScope: 'Selected portrait', omittedEvidence: [] }, capturedAt: '2026-10-21T00:00:00.000Z'
    }),
    bytes: { [pngSha256]: [...pngBytes] }
  };
}
