import {
  cycleNativeRecords,
  portableCycleRecord,
  cycleReferences,
} from "../engine/asset-cycles.js";
import {
  ownerLocation,
  physicalOwnerIdentity,
  readOwnerBytes,
  withOwnerDatabase,
} from "./owner-io.js";
import {
  canonicalDigest,
  canonicalJSON,
  fail,
  assertId,
} from "../engine/contracts.js";
import { blobReferences } from "../render/closure.js";
import { portableSpeechPerformance } from "../reuse/inspect.js";
import { sealBundle, originKey, validateBundle } from "../reuse/bundle.js";

const portable = (value) =>
  Array.isArray(value)
    ? value.map(portable)
    : value && typeof value === "object"
    ? Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key]) =>
              ![
                "path",
                "filePath",
                "rootDir",
                "sourcePath",
                "worldRoot",
                "directory",
                "absolutePath",
              ].includes(key)
          )
          .map(([key, item]) => [key, portable(item)])
      )
    : value;
const nativeRef = (ownerId, projectId, kind, id, revision) => ({
  ownerId,
  projectId,
  recordKind: kind,
  recordId: id,
  revision,
});
const supportedKinds = new Set([
  "sourcePackage",
  "edition",
  "editionOutput",
  "editionReview",
  "editionPublication",
  "assetReview",
  "reuseImport",
]);
/** Locator: {directory}, one existing Studio root. Public allowedProjects contains
 * exact native project IDs. No constructor opens, initializes or repairs it. */
export function createStudioOwnerAdapter({
  locator,
  ownerId,
  allowedProjects,
}) {
  const directory = ownerLocation(locator),
    projects = [...allowedProjects];
  for (const id of projects) assertId(id);
  function allowed(ref) {
    if (ref.ownerId !== ownerId || !projects.includes(ref.projectId))
      fail(
        "PROJECT_NOT_ALLOWED",
        "Reference is outside this owner registration."
      );
  }
  async function snapshot(operation) {
    return withOwnerDatabase(directory, async (db) => {
      const all = (sql, ...args) => db.prepare(sql).all(...args);
      const has = (table) =>
        !!db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table);
      const values = [];
      for (const projectId of projects) {
        if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId))
          fail("PROJECT_NOT_ALLOWED", "Native project is not present.");
        for (const row of has("generation_candidates")
          ? all(
              "SELECT id,data_json FROM generation_candidates WHERE project_id=?",
              projectId
            )
          : []) {
          const value = JSON.parse(row.data_json);
          values.push({
            ref: nativeRef(
              ownerId,
              projectId,
              "candidate",
              row.id,
              canonicalDigest(value)
            ),
            value,
          });
        }
        for (const row of all(
          "SELECT aggregate_kind AS kind,aggregate_id AS id,value_json FROM events WHERE project_id=? ORDER BY cursor",
          projectId
        )) {
          if (!supportedKinds.has(row.kind)) continue;
          const value = JSON.parse(row.value_json);
          const revision =
            row.kind === "sourcePackage"
              ? value.sourceDigest
              : row.kind === "edition"
              ? value.closureDigest
              : row.kind === "editionOutput" && value.manifestDigest
              ? value.manifestDigest
              : canonicalDigest(value);
          values.push({
            ref: nativeRef(ownerId, projectId, row.kind, row.id, revision),
            value,
          });
        }
        for (const row of has("reuse_imports")
          ? all(
              "SELECT id,data_json FROM reuse_imports WHERE project_id=?",
              projectId
            )
          : []) {
          const value = JSON.parse(row.data_json);
          values.push({
            ref: nativeRef(
              ownerId,
              projectId,
              "reuseImport",
              row.id,
              canonicalDigest(value)
            ),
            value,
          });
        }
      }
      for (const projectId of projects)
        for (const item of cycleNativeRecords(db, projectId)) {
          if (
            !["job", "attempt", "adoption", "cycle", "productionCase"].includes(
              item.ref.recordKind
            )
          )
            continue;
          values.push({ ...item, ref: { ownerId, ...item.ref } });
        }
      const records = [
        ...new Map(values.map((v) => [originKey(v.ref), v])).values(),
      ];
      return operation({ db, records });
    });
  }
  function candidateLinks(record, records) {
    const { ref, value } = record,
      links = [];
    for (const id of value.lineage?.parentCandidateIds ?? []) {
      const parent = records.find(
        (r) =>
          r.ref.projectId === ref.projectId &&
          r.ref.recordKind === "candidate" &&
          r.ref.recordId === id
      );
      if (parent)
        links.push({
          from: ref,
          relation: "derived-from",
          to: parent.ref,
          requirement: "historical-reference",
        });
    }
    for (const to of value.lineage?.originRefs ?? value.originRefs ?? [])
      links.push({
        from: ref,
        relation:
          value.lineage?.normalization?.relation === "normalized-from"
            ? "normalized-from"
            : "derived-from",
        to,
        requirement: "historical-reference",
      });
    return links;
  }
  const visible = (record) =>
    portableCycleRecord(record.value, ownerId, record.ref.recordKind);
  function recordLinks(record) {
    return cycleReferences(record.ref.recordKind, visible(record)).map(
      (item) => ({
        from: item.relation === "derived-from" ? record.ref : item.ref,
        relation: item.relation,
        to: item.relation === "derived-from" ? item.ref : record.ref,
        requirement: "historical-reference",
      })
    );
  }
  function description(record, db) {
    const { ref, value } = record;
    const mediaKind =
      value.mediaKind ??
      (ref.recordKind === "sourcePackage"
        ? "text"
        : value.manifest?.output?.mime?.startsWith("audio/")
        ? "audio"
        : ref.recordKind === "editionOutput"
        ? "video"
        : "structured");
    // Semantic roles require actual selected native track evidence. An arbitrary
    // WAV, slot label, title or audio-shaped blob is never music/SFX evidence.
    const nativeTrackRoles = new Set();
    if (
      ref.recordKind === "candidate" &&
      mediaKind === "audio" &&
      !value.reuseRole
    ) {
      for (const row of db
        .prepare(
          "SELECT aggregate_kind,value_json FROM events WHERE project_id=? AND aggregate_kind IN ('timeline','edition')"
        )
        .all(ref.projectId)) {
        const native = JSON.parse(row.value_json);
        const timeline =
          row.aggregate_kind === "timeline"
            ? native.resolved
            : native.closure?.timeline;
        for (const track of timeline?.tracks ?? [])
          if (
            ["music", "sfx"].includes(track.kind) &&
            track.candidateId === value.id &&
            track.blobId === (value.canonicalBlobId ?? value.blobId) &&
            track.adoptionId &&
            db
              .prepare(
                "SELECT 1 FROM asset_adoptions WHERE project_id=? AND id=? AND json_extract(data_json,'$.candidateId')=? AND json_extract(data_json,'$.slotId')=?"
              )
              .get(ref.projectId, track.adoptionId, value.id, track.slotId)
          )
            nativeTrackRoles.add(track.kind);
      }
    }
    const roles = value.reuseRole
      ? [value.reuseRole]
      : mediaKind === "image"
      ? [
          value.slotIntent?.subject?.kind === "identity"
            ? "identity-reference"
            : "environment-reference",
        ]
      : mediaKind === "audio"
      ? nativeTrackRoles.size
        ? [...nativeTrackRoles].sort()
        : [
            value.audioBinding || value.utteranceBinding
              ? "speech-take"
              : "audio-reference",
          ]
      : [];
    const metadata = {
      mediaKind,
      roles,
      subjects: [],
      title: value.title ?? value.id ?? ref.recordId,
    };
    if (ref.recordKind !== "candidate") return metadata;
    const pinned = (kind, id) => {
      const pin = value.pins?.find((p) => p.kind === kind && p.id === id);
      if (!pin || pin.revision === 0) return null;
      const row = db
        .prepare(
          "SELECT value_json FROM events WHERE project_id=? AND aggregate_kind=? AND aggregate_id=? AND aggregate_revision=?"
        )
        .get(ref.projectId, kind, id, pin.revision);
      if (!row)
        fail("SOURCE_MISSING", "Pinned native source event is unavailable.");
      return JSON.parse(row.value_json);
    };
    const stateRef = (id) => {
      for (const pin of value.pins ?? []) {
        if (!["story", "sourcePackage"].includes(pin.kind)) continue;
        const parent = pinned(pin.kind, pin.id);
        const ids =
          pin.kind === "story"
            ? parent?.states?.map((s) => s.id)
            : parent?.sceneScopes?.flatMap((scope) =>
                Object.values(scope.stateIds ?? {}).flat()
              );
        if (ids?.includes(id))
          return nativeRef(
            ownerId,
            ref.projectId,
            "state",
            id,
            canonicalJSON({
              kind: pin.kind,
              id: pin.id,
              revision: parent.sourceDigest ?? String(pin.revision),
            })
          );
      }
      fail(
        "SOURCE_MISSING",
        "Native state revision is not retained in candidate pins."
      );
    };
    const scene = value.sceneId ? pinned("scene", value.sceneId) : null;
    const slot = value.slotIntent ?? value.recipe?.assetIntent;
    const binding = value.audioBinding ?? value.utteranceBinding;
    const addSubject = (identityId, stateIds) => {
      if (
        identityId &&
        !metadata.subjects.some((s) => s.identityId === identityId)
      )
        metadata.subjects.push({
          ownerId,
          projectId: ref.projectId,
          identityId,
          stateRefs: [...new Set(stateIds.filter(Boolean))].map(stateRef),
        });
    };
    if (scene && mediaKind === "image") {
      const shot = scene.shots.find(
        (s) =>
          s.id ===
          (slot?.scope?.kind === "shot"
            ? slot.scope.id
            : value.target?.kind === "shot"
            ? value.target.id
            : null)
      );
      const selectedOccurrences =
        shot?.occurrenceIds ??
        (shot?.targetOccurrenceId ? [shot.targetOccurrenceId] : null);
      for (const occurrence of scene.occurrences.filter(
        (o) => !selectedOccurrences || selectedOccurrences.includes(o.id)
      )) {
        const presentation = scene.presentations.find(
          (p) => p.occurrenceId === occurrence.id
        );
        addSubject(occurrence.characterId, [presentation?.appearanceStateRef]);
      }
    } else if (!binding && slot?.subject?.kind !== "environment") {
      const cast =
        slot?.subject?.kind === "role" ? pinned("cast", slot.subject.id) : null;
      addSubject(
        cast?.characterId ??
          (slot?.subject?.kind === "identity" ? slot.subject.id : null),
        [slot?.appearanceStateRef]
      );
    }
    if (binding) {
      metadata.audioBinding = binding;
      const utteranceId = slot?.utteranceId ?? value.target?.id;
      const baseline = scene?.utterances.find((u) => u.id === utteranceId);
      if (!baseline)
        fail("SOURCE_MISSING", "Pinned native utterance is unavailable.");
      const effective = { ...baseline, ...pinned("utterance", utteranceId) };
      if (canonicalDigest(effective.text) !== binding.textDigest)
        fail(
          "SOURCE_CORRUPT",
          "Pinned utterance differs from native audio binding."
        );
      metadata.speechPerformance = portableSpeechPerformance(effective);
      if (binding.characterId !== null)
        addSubject(binding.characterId, [
          binding.appearanceStateRef,
          binding.castingStateRef,
        ]);
      else if (binding.castingStateRef !== null)
        metadata.speakerStateRefs = [stateRef(binding.castingStateRef)];
    }
    return metadata;
  }
  async function blob(db, projectId, hash) {
    const row = db
      .prepare(
        "SELECT byte_length,status FROM blobs WHERE project_id=? AND id=?"
      )
      .get(projectId, hash);
    if (!row || row.status !== "available")
      fail("BUNDLE_INCOMPLETE", "Exact source blob is unavailable.");
    const bytes = await readOwnerBytes({
      directory,
      relativePath: `blobs/${projectId}/${hash}`,
      expectedSha256: hash,
    }).catch((error) => {
      if (error.code === "ENOENT")
        fail("BUNDLE_INCOMPLETE", "Exact source blob is missing.");
      throw error;
    });
    if (bytes.length !== row.byte_length)
      fail("BUNDLE_INCOMPLETE", "Exact source blob length differs.");
    return bytes;
  }
  const adapter = {
    identify: () => physicalOwnerIdentity(directory, "studio.sqlite"),
    async capture() {
      return snapshot(async ({ db, records }) => {
        const entries = [];
        for (const record of records) {
          const { title, ...meta } = description(record, db);
          let availability = "observed-available",
            capabilities = ["discover", "preserve", "inspect"];
          try {
            for (const hash of blobReferences(visible(record)))
              await blob(db, record.ref.projectId, hash);
          } catch (error) {
            if (
              !["BUNDLE_INCOMPLETE", "BUNDLE_HASH_MISMATCH"].includes(
                error.code
              )
            )
              throw error;
            availability =
              error.code === "BUNDLE_HASH_MISMATCH" ? "corrupt" : "missing";
            capabilities = ["discover"];
          }
          if (
            availability === "observed-available" &&
            ["text", "image", "audio"].includes(meta.mediaKind)
          )
            capabilities.push("derive");
          entries.push({
            ref: record.ref,
            title,
            mediaKind: meta.mediaKind,
            roles: meta.roles,
            subjects: meta.subjects,
            expressionRefs: [],
            availability,
            capabilities,
          });
        }
        const links = records.flatMap((record) => [
          ...candidateLinks(record, records),
          ...recordLinks(record),
        ]);
        const uses = records
          .filter((r) => r.ref.recordKind === "reuseImport")
          .flatMap((r) =>
            (r.value.localCandidates ?? []).flatMap((local) => {
              const consumer = records.find(
                (c) =>
                  c.ref.projectId === r.ref.projectId &&
                  c.ref.recordKind === "candidate" &&
                  c.ref.recordId === local.candidateId
              );
              return consumer
                ? [
                    {
                      ref: local.source,
                      usedIn: consumer.ref,
                      receiptRef: r.ref,
                    },
                  ]
                : [];
            })
          );
        for (const record of records)
          for (const item of cycleReferences(
            record.ref.recordKind,
            visible(record)
          )) {
            if (item.relation === "used-in")
              uses.push({ ref: item.ref, usedIn: record.ref });
          }
        const cases = records
          .filter((r) => r.ref.recordKind === "productionCase")
          .map((record) => {
            const value = visible(record),
              keys = [
                "id",
                "question",
                "contextRefs",
                "literalInputRefs",
                "trials",
                "observations",
                "unknowns",
                "decision",
                "classification",
                "literalInputs",
                "omissions",
                "planning",
                "externalObservations",
              ];
            return {
              ...Object.fromEntries(
                keys
                  .filter((k) => value[k] !== undefined)
                  .map((k) => [k, value[k]])
              ),
              ownerId,
              projectId: record.ref.projectId,
              ref: record.ref,
            };
          });
        return {
          token: canonicalDigest(records.map((r) => r.ref)),
          entries,
          links,
          uses,
          cases,
        };
      });
    },
    async exportExact({ roots, disclosure }) {
      for (const ref of roots) allowed(ref);
      return snapshot(async ({ db, records }) => {
        const selected = roots.map(
          (ref) =>
            records.find((r) => originKey(r.ref) === originKey(ref)) ??
            fail("SOURCE_MISSING", "Exact native revision is unavailable.")
        );
        const files = new Map(),
          bytes = {},
          exported = [],
          links = [];
        const chosen = new Map(selected.map((r) => [originKey(r.ref), r]));
        for (const record of chosen.values())
          for (const parentId of record.value.lineage?.parentCandidateIds ??
            []) {
            const parent = records.find(
              (r) =>
                r.ref.projectId === record.ref.projectId &&
                r.ref.recordKind === "candidate" &&
                r.ref.recordId === parentId
            );
            if (parent) chosen.set(originKey(parent.ref), parent);
          }
        for (const record of chosen.values()) {
          const ref = record.ref,
            value = visible(record),
            meta = description(record, db);
          const selectedHash =
            ref.recordKind === "candidate"
              ? value.canonicalBlobId ?? value.blobId
              : ref.recordKind === "sourcePackage"
              ? value.blobManifest.find((b) => b.kind === "original-manuscript")
                  ?.blobId
              : value.manifest?.output?.blobId;
          const isRoot = roots.some(
            (root) => originKey(root) === originKey(ref)
          );
          const hashes = isRoot ? [...blobReferences(value)] : [];
          for (const hash of hashes) {
            const content = await blob(db, ref.projectId, hash);
            bytes[hash] = [...content];
            const role =
              hash === selectedHash ? "selected-content" : "preserved-evidence";
            if (!files.has(hash) || role === "selected-content")
              files.set(hash, {
                sha256: hash,
                byteLength: content.length,
                mime:
                  hash === selectedHash
                    ? value.mime ?? value.manifest?.output?.mime ?? "text/plain"
                    : "application/octet-stream",
                role,
              });
          }
          exported.push({
            ref,
            metadata: {
              ...meta,
              nativeRecord: portable(value),
              ...(isRoot && hashes.includes(selectedHash)
                ? { selectedContentSha256: selectedHash }
                : {}),
            },
            requiredFileSha256s: hashes,
            sourcePins: portable(value),
            evidenceRefs: [
              ...(value.lineage?.originRefs ?? value.originRefs ?? []),
              ...cycleReferences(ref.recordKind, value).map((item) => item.ref),
            ],
          });
          links.push(
            ...candidateLinks(record, records),
            ...recordLinks(record)
          );
          if (value.reuseProvenance?.localManifestBlobId) {
            const retained = validateBundle(
              JSON.parse(
                (
                  await blob(
                    db,
                    ref.projectId,
                    value.reuseProvenance.localManifestBlobId
                  )
                ).toString("utf8")
              )
            );
            for (const original of retained.records)
              if (
                !exported.some(
                  (r) => originKey(r.ref) === originKey(original.ref)
                )
              ) {
                const { selectedContentSha256, ...metadata } =
                  original.metadata;
                exported.push({
                  ...original,
                  metadata,
                  requiredFileSha256s: [],
                });
              }
            links.push(
              ...retained.links.map((link) => ({
                ...link,
                requirement: "historical-reference",
              }))
            );
          }
        }
        // Bundle links require a source record even for historical citations.
        // A citation is explicit reference metadata, never a fabricated native
        // execution or a request to fetch/access the external owner.
        for (const link of links)
          if (
            !exported.some(
              (record) => originKey(record.ref) === originKey(link.from)
            )
          ) {
            exported.push({
              ref: link.from,
              metadata: {
                mediaKind: "structured",
                roles: [],
                subjects: [],
                title: link.from.recordId,
                observationScope:
                  "Reference citation only; source bytes, native request and execution were not verified by this export",
              },
              requiredFileSha256s: [],
              sourcePins: { scope: "citation-only" },
              evidenceRefs: [],
            });
          }
        return {
          bundle: sealBundle({
            schemaVersion: 1,
            roots,
            records: exported,
            files: [...files.values()],
            links: [
              ...new Map(
                links.map((link) => [canonicalDigest(link), link])
              ).values(),
            ],
            disclosure: {
              includedScope:
                disclosure?.includedScope ??
                "Exact registered Studio records and available required bytes",
              omittedEvidence: [
                ...(disclosure?.omittedEvidence ?? []),
                "Job/attempt provider request bodies, prompts, connection details and unselected logs are omitted; snapshots record observed native status, not proof of payment or independent completion. Case/cycle references are historical evidence only. Foreign approval is historical evidence only; destination adoption is not inherited. Ancestor runtime bytes and source code path labels are omitted; ancestors are historical references.",
              ],
            },
            capturedAt: new Date().toISOString(),
          }),
          bytes,
        };
      });
    },
    async verifyRefs(refs) {
      await adapter.exportExact({ roots: refs });
      return true;
    },
  };
  return adapter;
}
