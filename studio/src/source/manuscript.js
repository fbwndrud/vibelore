import { assertId, assertText, fail } from "../engine/contracts.js";
import {
  makeSourcePackage,
  hashBytes,
  prepareSourceImport,
  validateSourceImport,
  applySourceImport,
} from "./source-package.js";
export function registerManuscriptCommand(service) {
  service.registerCommand("source.manuscript", {
    target: ({ envelope }) => ({
      kind: "sourcePackage",
      id: envelope.payload.id,
    }),
    async prepare({ envelope }) {
      const p = envelope.payload;
      assertId(p.id);
      assertText(p.title);
      assertText(p.language);
      if (
        Object.keys(p).some(
          (k) => !["id", "title", "language", "bytes"].includes(k),
        ) ||
        !Array.isArray(p.bytes) ||
        !p.bytes.length ||
        !p.bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
      )
        fail("INVALID_INPUT", "Expected UTF-8 manuscript bytes.");
      const bytes = Uint8Array.from(p.bytes);
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        fail("INVALID_INPUT", "Manuscript must be UTF-8.");
      }
      assertText(text);
      const blobId = hashBytes(bytes);
      const pkg = makeSourcePackage({
        id: p.id,
        sourceKind: "studio-script",
        sourceRevision: blobId,
        title: p.title,
        language: p.language,
        textUnits: [{ id: "manuscript", text, blobId }],
        sceneScopes: [],
        sourceIdentityMap: [],
        blobManifest: [
          {
            id: "manuscript",
            blobId,
            byteLength: bytes.length,
            kind: "original-manuscript",
          },
        ],
        revealPolicy: { kind: "explicit-scene-selection" },
        preservationStatus: {
          status: "exact-uploaded-bytes",
          historicalKnowledge: "not-provided",
        },
      });
      return prepareSourceImport(service, envelope, {
        package: pkg,
        blobs: [{ blobId, bytes: p.bytes }],
      });
    },
    validate: validateSourceImport,
    apply: applySourceImport,
  });
}
