import {
  assertId,
  assertText,
  canonicalJSON,
  fail,
} from '../engine/contracts.js';
import { requireValue } from '../engine/story.js';
import { validateBundle } from '../reuse/bundle.js';
import { selectedClosure } from '../reuse/inspect.js';
import { preserveBundleFiles } from '../reuse/import.js';
import {
  makeSourcePackage,
  hashBytes,
  prepareSourceImport,
  validateSourceImport,
  applySourceImport,
} from './source-package.js';
export function registerManuscriptCommand(service) {
  service.registerCommand('source.manuscript', {
    target: ({ envelope }) => ({
      kind: 'sourcePackage',
      id: envelope.payload.id,
    }),
    async prepare({ envelope }) {
      const p = envelope.payload;
      assertId(p.id);
      assertText(p.title);
      assertText(p.language);
      if (
        Object.keys(p).some(
          (k) => !['id', 'title', 'language', 'bytes'].includes(k)
        ) ||
        !Array.isArray(p.bytes) ||
        !p.bytes.length ||
        !p.bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
      )
        fail('INVALID_INPUT', 'Expected UTF-8 manuscript bytes.');
      const bytes = Uint8Array.from(p.bytes);
      const pkg = manuscriptPackage(p, bytes);
      return prepareSourceImport(service, envelope, {
        package: pkg,
        blobs: [{ blobId: hashBytes(bytes), bytes: p.bytes }],
      });
    },
    validate: validateSourceImport,
    apply: applySourceImport,
  });
  registerBundleSourceCommand(service);
}
export function manuscriptPackage(p, bytes, provenance = {}) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('INVALID_INPUT', 'Manuscript must be UTF-8.');
  }
  assertText(text);
  const blobId = hashBytes(bytes);
  return makeSourcePackage({
    id: p.id,
    sourceKind: 'studio-script',
    sourceRevision: blobId,
    title: p.title,
    language: p.language,
    textUnits: [{ id: 'manuscript', text, blobId }],
    selectedTextBlobId: blobId,
    sceneScopes: [],
    sourceIdentityMap: [],
    blobManifest: [
      {
        id: 'manuscript',
        blobId,
        byteLength: bytes.length,
        kind: 'original-manuscript',
      },
    ],
    revealPolicy: { kind: 'explicit-scene-selection' },
    ...provenance,
    preservationStatus: {
      status: 'exact-uploaded-bytes',
      historicalKnowledge: 'not-provided',
    },
  });
}

function registerBundleSourceCommand(service) {
  service.registerCommand('source.importBundle', {
    target: ({ envelope }) => ({
      kind: 'sourcePackage',
      id: envelope.payload.sourcePackageId,
    }),
    async prepare({ envelope }) {
      const p = envelope.payload;
      if (
        Object.keys(p).some(
          (k) =>
            ![
              'bundle',
              'bytes',
              'sourcePackageId',
              'productionId',
              'title',
              'language',
              'actor',
              'reason',
            ].includes(k)
        )
      )
        fail('INVALID_INPUT', 'Unsupported source preservation fields.');
      assertId(p.sourcePackageId);
      assertText(p.title);
      assertText(p.language);
      assertText(p.actor);
      assertText(p.reason);
      if (p.productionId != null)
        requireValue(
          service.store,
          envelope.projectId,
          'production',
          p.productionId
        );
      const bundle = validateBundle(p.bundle, p.bytes);
      const textRoots = bundle.roots.filter(
        (ref) =>
          bundle.records.find(
            (r) => canonicalJSON(r.ref) === canonicalJSON(ref)
          ).metadata.mediaKind === 'text'
      );
      if (textRoots.length !== 1)
        fail(
          'INVALID_INPUT',
          'Source import requires exactly one unambiguous text root.'
        );
      const closure = selectedClosure(bundle, textRoots[0]);
      if (
        !['text/plain', 'text/plain; charset=utf-8'].includes(
          closure.selectedFile.mime
        )
      )
        fail(
          'REUSE_MEDIA_UNSUPPORTED',
          'Source manuscript import requires UTF-8 plain text.'
        );
      const bytes = Uint8Array.from(p.bytes[closure.selectedFile.sha256]);
      const preserved = await preserveBundleFiles(
        service,
        envelope.projectId,
        bundle,
        closure.files,
        p.bytes
      );
      const pkg = manuscriptPackage(
        { id: p.sourcePackageId, title: p.title, language: p.language },
        bytes,
        {
          originRefs: closure.records.map((r) => r.ref),
          ...preserved,
          productionId: p.productionId ?? null,
          importProvenance: {
            commandId: envelope.commandId,
            bundleSha256: bundle.manifestSha256,
            actor: p.actor,
            reason: p.reason,
          },
          blobManifest: [
            ...closure.files.map((file, i) => ({
              id: `preserved-${i}`,
              blobId: file.sha256,
              byteLength: file.byteLength,
              kind: file.role,
            })),
            {
              id: 'bundle-manifest',
              blobId: preserved.localManifestBlobId,
              byteLength: Buffer.byteLength(canonicalJSON(bundle)),
              kind: 'preserved-bundle-manifest',
            },
          ],
        }
      );
      // Include manifest and all selected runtime/historical raw files in the same
      // existing source import closure; no image bytes are interpreted as text.
      return prepareSourceImport(service, envelope, { package: pkg });
    },
    validate: validateSourceImport,
    apply: applySourceImport,
  });
}
