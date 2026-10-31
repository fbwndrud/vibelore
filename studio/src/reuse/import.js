import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  assertText,
  canonicalDigest,
  canonicalJSON,
  fail,
} from '../engine/contracts.js';
import {
  candidateValue,
  candidateMatchesSlot,
  checkPins,
  insertCandidate,
  slotResult,
} from '../engine/asset-slots.js';
import { prepareAssetMaterialization } from '../assets/commands.js';
import { hashBytes } from '../source/source-package.js';
import {
  evaluateInspection,
  NORMALIZER_VERSION,
  prepareReuseInspection,
} from './inspect.js';

function assertCompatible(inspection) {
  if (inspection.disposition === 'compatible') return;
  const finding =
    inspection.findings.find((f) => f.code === 'REUSE_MAPPING_REQUIRED') ??
    inspection.findings.find((f) => f.kind !== 'advisory');
  fail(
    finding?.code ?? 'REUSE_INCOMPATIBLE',
    finding?.evidence ?? 'Inspect a compatible destination use first.'
  );
}
function reuseKey(projectId, prepared) {
  const { intent, inspection } = prepared;
  return canonicalDigest({
    projectId,
    bundleSha256: inspection.bundleSha256,
    root: intent.selections[0].source,
    slotId: intent.target.id,
    destinationPinsDigest: inspection.destinationPinsDigest,
    purpose: intent.purpose,
    identityMap: intent.identityMap,
    stateMap: intent.stateMap,
    role: intent.selections[0].role,
    normalizerVersion: NORMALIZER_VERSION,
  });
}
function previousCandidate(store, projectId, key) {
  const row = store.get(
    "SELECT r.data_json FROM reuse_imports r JOIN events e ON e.project_id=r.project_id AND e.command_id=json_extract(r.data_json,'$.commandId') WHERE r.project_id=? AND r.reuse_key=? ORDER BY e.cursor DESC LIMIT 1",
    projectId,
    key
  );
  if (!row) return null;
  return candidateValue(
    store,
    projectId,
    JSON.parse(row.data_json).localCandidates[0].candidateId
  );
}
function validateExisting(service, projectId, candidate, prepared) {
  const { store } = service;
  checkPins(store, projectId, candidate);
  candidateMatchesSlot(
    store,
    projectId,
    candidate,
    prepared.slot,
    prepared.pinned
  );
  if (
    store.aggregate(projectId, { kind: 'assetReview', id: candidate.id }).value
      ?.decision === 'reject'
  )
    fail(
      'REUSE_CANDIDATE_REJECTED',
      'The preserved candidate was rejected; choose explicit new-import for a separate candidate.'
    );
  const material = prepared.inspection.materializations[0];
  if (
    candidate.validation?.status !== 'passed' ||
    candidate.canonicalBlobId !== material.canonicalSha256 ||
    candidate.rawBlobId !== material.sourceSha256 ||
    canonicalDigest(candidate.metadata) !== material.metadataDigest
  )
    fail(
      'REUSE_CANDIDATE_INVALID',
      'The existing preserved candidate no longer matches validated materialization.'
    );
}
function verifyLocalBytes(service, projectId, ids) {
  for (const id of new Set(ids)) {
    const row = service.store.get(
      'SELECT byte_length,status FROM blobs WHERE project_id=? AND id=?',
      projectId,
      id
    );
    if (
      row?.status !== 'available' ||
      service.store.get(
        'SELECT 1 FROM blob_tombstones WHERE project_id=? AND blob_id=?',
        projectId,
        id
      )
    )
      fail('BLOB_UNAVAILABLE', 'Required preserved bytes are unavailable.');
    let bytes;
    try {
      bytes = readFileSync(service.blobs.path(projectId, id));
    } catch {
      fail('BLOB_MISSING', 'Required preserved bytes are missing.');
    }
    if (bytes.length !== row.byte_length || hashBytes(bytes) !== id)
      fail(
        'BLOB_CORRUPT',
        'Required preserved bytes failed final integrity verification.'
      );
  }
}
export async function preserveBundleFiles(
  service,
  projectId,
  bundle,
  files,
  bytes,
  materialization = null
) {
  const manifest = await service.blobs.put(
    projectId,
    Buffer.from(canonicalJSON(bundle))
  );
  const fileMap = [];
  for (const file of files) {
    const raw = await service.blobs.put(
      projectId,
      Uint8Array.from(bytes[file.sha256])
    );
    const selected = materialization?.sourceSha256 === file.sha256;
    const canonical = selected
      ? await service.blobs.put(projectId, materialization.decoded.bytes)
      : raw;
    fileMap.push({
      sourceSha256: file.sha256,
      rawBlobId: raw.blobId,
      canonicalBlobId: canonical.blobId,
      normalizerVersion: selected ? NORMALIZER_VERSION : 'preserved-bytes-v1',
      normalizationChanged: raw.blobId !== canonical.blobId,
    });
  }
  return { localManifestBlobId: manifest.blobId, fileMap };
}
export function registerReuseCommands(service) {
  const { store } = service;
  service.registerCommand('asset.importBundle', {
    target: ({ envelope }) => envelope.payload.intent?.target,
    async prepare(context) {
      const { envelope } = context,
        p = envelope.payload,
        projectId = envelope.projectId;
      if (
        Object.keys(p).some(
          (k) =>
            ![
              'bundle',
              'bytes',
              'inspectionDigest',
              'intent',
              'actor',
              'reason',
            ].includes(k)
        )
      )
        fail(
          'INVALID_INPUT',
          'Unsupported import fields; candidate IDs are issued by the server.'
        );
      assertText(p.actor);
      assertText(p.reason);
      const prepared = await prepareReuseInspection({
        ...p,
        destination: { service, projectId },
      });
      assertCompatible(prepared.inspection);
      if (prepared.inspection.inspectionDigest !== p.inspectionDigest)
        fail(
          'INPUT_STALE',
          'Reuse inspection changed; inspect current destination pins.'
        );
      prepared.reuseKey = reuseKey(projectId, prepared);
      const existing =
        prepared.intent.mode === 'reuse-preserved'
          ? previousCandidate(store, projectId, prepared.reuseKey)
          : null;
      if (existing) {
        validateExisting(service, projectId, existing, prepared);
        await service.blobs.read(projectId, existing.rawBlobId);
        await service.blobs.read(projectId, existing.canonicalBlobId);
      }
      const preserved = await preserveBundleFiles(
        service,
        projectId,
        prepared.bundle,
        prepared.closure.files,
        p.bytes,
        {
          sourceSha256: prepared.closure.selectedFile.sha256,
          decoded: prepared.decoded,
        }
      );
      const id = randomUUID(),
        selected = preserved.fileMap.find(
          (f) => f.sourceSha256 === prepared.closure.selectedFile.sha256
        ),
        candidate =
          existing ??
          (await prepareAssetMaterialization(service, {
            projectId,
            id,
            slot: prepared.slot,
            pinned: prepared.pinned,
            bytes: Uint8Array.from(
              p.bytes[prepared.closure.selectedFile.sha256]
            ),
            actor: p.actor,
            decoded: prepared.decoded,
            materialized: {
              raw: { blobId: selected.rawBlobId },
              canonical: {
                blobId: selected.canonicalBlobId,
                byteLength: prepared.decoded.bytes.length,
              },
            },
          }));
      const receipt = {
        id: randomUUID(),
        commandId: envelope.commandId,
        bundleSha256: prepared.bundle.manifestSha256,
        originRefs: prepared.closure.records.map((r) => r.ref),
        localCandidates: [
          {
            candidateId: candidate.id,
            slotId: prepared.slot.id,
            source: prepared.closure.root.ref,
          },
        ],
        ...preserved,
        intentDigest: prepared.inspection.intentDigest,
        actor: p.actor,
        reason: p.reason,
      };
      if (!existing) {
        candidate.reuseRole = prepared.intent.selections[0].role;
        candidate.reuseProvenance = {
          originRefs: receipt.originRefs,
          localManifestBlobId: receipt.localManifestBlobId,
          fileMap: receipt.fileMap,
        };
        candidate.lineage = {
          ...candidate.lineage,
          originRefs: receipt.originRefs,
          normalization: {
            relation: receipt.fileMap.find(
              (f) => f.sourceSha256 === candidate.rawBlobId
            ).normalizationChanged
              ? 'normalized-from'
              : 'preserved-from',
            normalizerVersion: NORMALIZER_VERSION,
          },
        };
      }
      return { ...prepared, candidate, existing: !!existing, receipt };
    },
    validate({ envelope, prepared }) {
      const current = evaluateInspection({
        ...prepared,
        destination: { service, projectId: envelope.projectId },
      });
      assertCompatible(current.inspection);
      if (
        current.inspection.inspectionDigest !==
          prepared.inspection.inspectionDigest ||
        current.inspection.inspectionDigest !==
          envelope.payload.inspectionDigest
      )
        fail('INPUT_STALE', 'Destination meaning changed during preservation.');
      if (prepared.existing)
        validateExisting(
          service,
          envelope.projectId,
          candidateValue(store, envelope.projectId, prepared.candidate.id),
          { ...prepared, ...current }
        );
      verifyLocalBytes(service, envelope.projectId, [
        prepared.receipt.localManifestBlobId,
        ...prepared.receipt.fileMap.flatMap((f) => [
          f.rawBlobId,
          f.canonicalBlobId,
        ]),
      ]);
    },
    apply({ envelope, aggregate, prepared }) {
      // A concurrently committed exact import can be reused after the final slot CAS.
      let candidate = prepared.candidate;
      if (!prepared.existing && prepared.intent.mode === 'reuse-preserved') {
        const previous = previousCandidate(
          store,
          envelope.projectId,
          prepared.reuseKey
        );
        if (previous) {
          validateExisting(service, envelope.projectId, previous, prepared);
          verifyLocalBytes(service, envelope.projectId, [
            previous.rawBlobId,
            previous.canonicalBlobId,
          ]);
          candidate = previous;
          prepared.existing = true;
          prepared.receipt.localCandidates[0].candidateId = previous.id;
        }
      }
      if (!prepared.existing)
        insertCandidate(store, envelope.projectId, candidate);
      store.run(
        'INSERT INTO reuse_imports(project_id,id,reuse_key,data_json) VALUES(?,?,?,?)',
        envelope.projectId,
        prepared.receipt.id,
        prepared.reuseKey,
        canonicalJSON(prepared.receipt)
      );
      return {
        ...slotResult(aggregate.value ?? prepared.slot),
        candidate,
        importReceipt: prepared.receipt,
      };
    },
  });
}
