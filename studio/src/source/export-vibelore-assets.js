import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  ownerLocation,
  physicalOwnerIdentity,
  readOwnerBytes,
  safeOwnerPath,
  withOwnerFiles,
} from "./owner-io.js";
import { hashBytes } from "./source-package.js";
import { canonicalDigest, fail } from "../engine/contracts.js";
import { sealBundle, originKey } from "../reuse/bundle.js";
import { MarkdownStateStore } from "../../../src/store/markdown-store.js";
import { UniverseStore } from "../../../src/store/universe-store.js";
import { AssetCatalogStore } from "../../../src/store/asset-catalog-store.js";
import { createPublicationUnit } from "../../../src/core/publication-unit.js";
import {
  resolveProductionSource,
  verifyProductionSource,
} from "../../../src/core/production-source.js";
import { readSealedProductionInput } from "../../../src/core/input-objects.js";
import { readAdoptedScript } from "../../../src/core/scene-script.js";
import { digest } from "../../../src/core/webtoon-contract.js";
import { isLoreRevisionId } from "../../../engine/src/lore/registry.js";

const omissions = [
  "Author-only and unpublished evidence are omitted.",
  "Work sources omit unselected future/state context; world archives have no selected current timeline point.",
  "Deprecated cut-based webtoonPlan/webtoonReferences/webtoonRender manifests are unsupported; scene exports require retained native approving workflow evidence.",
];
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
                "rootDir",
                "sourcePath",
                "worldRoot",
                "directory",
                "absolutePath",
                "sourceFingerprint",
              ].includes(key)
          )
          .map(([k, v]) => [k, portable(v)])
      )
    : value;
/** Exactly one existing work OR world root. allowedProjects contains native
 * workId/universeId. A world is a published context archive, NOT a current state.
 * Work context comes solely from adopted sealed scene scopes. */
function boundedVibeloreOwnerAdapter({ locator, ownerId, allowedProjects }) {
  const directory = ownerLocation(locator),
    projects = [...allowedProjects],
    store = new MarkdownStateStore(directory);
  const ref = (projectId, recordKind, recordId, revision) => ({
    ownerId,
    projectId,
    recordKind,
    recordId: String(recordId),
    revision,
  });
  function allowed(id) {
    if (!projects.includes(id))
      fail(
        "PROJECT_NOT_ALLOWED",
        "Native project is outside this registration."
      );
  }
  const read = (path, expectedSha256) =>
    readOwnerBytes({ directory, relativePath: path, expectedSha256 });
  async function json(path, optional = false) {
    try {
      return JSON.parse((await read(path)).toString("utf8"));
    } catch (error) {
      if (optional && error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function names(path) {
    try {
      await safeOwnerPath(directory, path);
      return (await readdir(join(directory, path))).sort();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  function revisionPath(base, revision) {
    if (!isLoreRevisionId(revision))
      fail("SOURCE_CORRUPT", "Malformed native revision.");
    return `${base}/${revision.slice(7)}.json`;
  }
  async function collect(requested = []) {
    const identity = await physicalOwnerIdentity(directory, ".vibelore"),
      records = [],
      recordsByRef = new Map(),
      tokens = [],
      checks = [];
    function add(
      nativeRef,
      title,
      mediaKind,
      content,
      metadata = {},
      sourcePins = {}
    ) {
      const key = originKey(nativeRef);
      const previous = recordsByRef.get(key);
      const observation = { metadata, sourcePins };
      if (previous) {
        const sameContent =
          (previous.content === null && content === null) ||
          (Buffer.isBuffer(previous.content) &&
            Buffer.isBuffer(content) &&
            previous.content.equals(content));
        if (previous.mediaKind !== mediaKind || !sameContent)
          fail(
            "SOURCE_CORRUPT",
            "One native reference has conflicting content."
          );
        // A native asset can be copied into several adopted scripts. These are
        // separate sealed observations of the same immutable asset, never a new
        // canonical state or a reason to concatenate their document payloads.
        const observations = previous.metadata.scopeObservations ?? [
          { metadata: previous.metadata, sourcePins: previous.sourcePins },
        ];
        observations.push(observation);
        const subjects = new Map();
        for (const item of observations)
          for (const subject of item.metadata.subjects ?? []) {
            const { stateRefs, ...identity } = subject;
            const subjectKey = canonicalDigest(identity);
            const existing = subjects.get(subjectKey);
            subjects.set(subjectKey, {
              ...identity,
              stateRefs: [
                ...new Map(
                  [...(existing?.stateRefs ?? []), ...stateRefs].map(
                    (state) => [originKey(state), state]
                  )
                ).values(),
              ],
            });
          }
        previous.metadata = {
          ...previous.metadata,
          subjects: [...subjects.values()],
          scopeObservations: observations,
          subjectScope: "observed-sealed-scopes",
        };
        previous.sourcePins = {
          scopeObservations: observations.map((item) => item.sourcePins),
        };
        return;
      }
      const record = {
        ref: nativeRef,
        title,
        mediaKind,
        content,
        metadata: { roles: [], subjects: [], ...metadata },
        sourcePins,
      };
      recordsByRef.set(key, record);
      records.push(record);
    }
    const worldHeadPath = ".vibelore/shared-lore/lore/HEAD";
    let worldHead;
    try {
      worldHead = (await read(worldHeadPath)).toString().trim();
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (worldHead) {
      const manifest = await json(
        revisionPath(".vibelore/shared-lore/lore/objects", worldHead)
      );
      const universeId = manifest.revision?.universeId;
      allowed(universeId);
      const world = new UniverseStore(directory, universeId),
        published = await world.status();
      if (published.head !== worldHead || published.drift.status !== "clean")
        fail("SOURCE_DRIFT", "World edits require synchronization.");
      const temporalScope = "published-world-archive";
      const publications = [published];
      const neededLore = new Set(
        requested
          .filter((r) => ["document", "state"].includes(r.recordKind))
          .map((r) => r.revision)
      );
      neededLore.delete(published.revision.revisionId);
      for (
        let parent = published.revision.parentRevisionId;
        parent && neededLore.size;

      ) {
        await json(revisionPath(".vibelore/shared-lore/lore/objects", parent));
        const old = await world.read(parent);
        if (neededLore.delete(old.revision.revisionId)) publications.push(old);
        parent = old.revision.parentRevisionId;
      }
      for (const publication of publications) {
        const content = publication.revision.content;
        const stateRef = (id) =>
          ref(universeId, "state", id, publication.revision.revisionId);
        for (const doc of content.documents.filter(
          (d) => d.visibility === "context"
        )) {
          // Historical exact bytes live in the published immutable document; current
          // readable paths belong only to the current publication and are drift-checked.
          const bytes = Buffer.from(doc.text, "utf8");
          if (
            publication.head === publication.publicationId &&
            !(await read(doc.path)).equals(bytes)
          )
            fail(
              "SOURCE_DRIFT",
              "Public context differs from its native publication."
            );
          const states = content.states.filter((state) =>
            state.documentIds.includes(doc.id)
          );
          const subjects = content.entities
            .filter(
              (e) =>
                e.documentIds.includes(doc.id) ||
                states.some((state) => state.entityId === e.id)
            )
            .map((e) => ({
              ownerId,
              projectId: universeId,
              identityId: e.id,
              stateRefs: states
                .filter((state) => state.entityId === e.id)
                .map((state) => stateRef(state.id)),
            }));
          add(
            ref(
              universeId,
              "document",
              doc.id,
              publication.revision.revisionId
            ),
            doc.id,
            "text",
            bytes,
            { temporalScope, subjects },
            { loreRevisionId: publication.publicationId }
          );
        }
        for (const state of content.states)
          add(
            stateRef(state.id),
            state.id,
            "structured",
            null,
            {
              temporalScope,
              nativeState: {
                id: state.id,
                entityId: state.entityId,
                storyScope: state.storyScope,
              },
              subjects: [
                {
                  ownerId,
                  projectId: universeId,
                  identityId: state.entityId,
                  stateRefs: [stateRef(state.id)],
                },
              ],
            },
            { loreRevisionId: publication.publicationId }
          );
      }
      const catalogStore = new AssetCatalogStore(directory, universeId),
        catalogHead = await catalogStore.head();
      if (catalogHead) {
        const neededAssets = new Set(
          requested
            .filter((r) => r.recordKind === "asset")
            .map((r) => r.revision)
        );
        const selectedAssets = new Map();
        for (let catalogRevision = catalogHead; catalogRevision; ) {
          await json(
            revisionPath(
              ".vibelore/shared-lore/assets/objects",
              catalogRevision
            )
          );
          const { catalog } = await catalogStore.read(catalogRevision);
          for (const [assetId, assetRevision] of Object.entries(
            catalog.assets
          )) {
            const requestedOld = neededAssets.delete(assetRevision);
            if (catalogRevision !== catalogHead && !requestedOld) continue;
            selectedAssets.set(assetRevision, {
              assetId,
              assetRevision,
              catalogRevision,
            });
          }
          if (!neededAssets.size) break;
          catalogRevision = catalog.parentRevisionId;
        }
        for (const {
          assetId,
          assetRevision,
          catalogRevision,
        } of selectedAssets.values()) {
          await json(
            revisionPath(".vibelore/shared-lore/assets/objects", assetRevision)
          );
          const asset = await catalogStore.object(assetRevision, "asset");
          await json(
            revisionPath(
              ".vibelore/shared-lore/lore/objects",
              asset.linkedLoreRevisionId
            )
          );
          const linked = await world.read(asset.linkedLoreRevisionId);
          const bytes = await read(
            `.vibelore/shared-lore/assets/blobs/${asset.blob.blobId.slice(7)}`,
            asset.blob.blobId
          );
          const subjects = [
            {
              ownerId,
              projectId: universeId,
              identityId: asset.entityId,
              stateRefs: asset.stateIds.map((id) =>
                ref(universeId, "state", id, linked.revision.revisionId)
              ),
            },
          ];
          add(
            ref(universeId, "asset", assetId, assetRevision),
            asset.label,
            "image",
            bytes,
            {
              temporalScope,
              subjects,
              roles: ["identity-reference", "style-reference"],
              mime: asset.blob.mime,
              nativeAsset: portable(asset),
            },
            {
              catalogRevisionId: catalogRevision,
              loreRevisionId: asset.linkedLoreRevisionId,
            }
          );
        }
        tokens.push(catalogHead);
        checks.push(async () => {
          if ((await catalogStore.head()) !== catalogHead)
            fail("SOURCE_DRIFT", "Asset catalog changed.");
        });
      }
      tokens.push(worldHead);
      checks.push(async () => {
        const final = await world.status();
        if (final.head !== worldHead || final.drift.status !== "clean")
          fail("SOURCE_DRIFT", "World changed during capture.");
      });
    } else {
      const publicationHeadPath = ".vibelore/publication/HEAD";
      let head;
      try {
        head = (await read(publicationHeadPath)).toString().trim();
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (head) {
        const base = `.vibelore/publication/objects/${head.slice(7)}`;
        for (const name of ["tree.json", "projections.json", "manifest.json"])
          await json(`${base}/${name}`);
        const publication = await createPublicationUnit({
          rootDir: directory,
        }).readPublished();
        if (!publication.ok || publication.value?.head !== head)
          fail("SOURCE_CORRUPT", "Native publication failed verification.");
        const workId = publication.value.tree.workId;
        allowed(workId);
        const chapters = Object.keys(publication.value.tree.chapters ?? {}).map(
          Number
        );
        for (const chapter of chapters) {
          const source = await resolveProductionSource(store, workId, {
            kind: "novel-chapters",
            chapters: [chapter],
          });
          const bytes = await read(
            relative(directory, store.chapterPath(chapter))
          );
          const fingerprint = await store.loadWorkingTreeFingerprint();
          if (
            fingerprint?.inventory.find(
              (f) => f.path === relative(directory, store.chapterPath(chapter))
            )?.digest !== digest(bytes)
          )
            fail("SOURCE_DRIFT", "Chapter bytes require synchronization.");
          add(
            ref(workId, "chapter", chapter, head),
            `Chapter ${chapter}`,
            "text",
            bytes,
            { temporalScope: "committed-chapter", roles: [], chapter },
            { sourceCanonHead: head, sourceScopeHash: source.hash }
          );
          checks.push(() => verifyProductionSource(store, source, workId));
        }
        tokens.push(head);
      }
      for (const name of await names(".vibelore/scene-scripts/heads")) {
        if (!name.endsWith(".json")) continue;
        const scriptId = name.slice(0, -5),
          scriptHead = await json(`.vibelore/scene-scripts/heads/${name}`);
        await json(
          revisionPath(".vibelore/scene-scripts/objects", scriptHead.revisionId)
        );
        await json(
          revisionPath(
            ".vibelore/input-objects/locks",
            scriptHead.productionLockId
          )
        );
        const { script } = await readAdoptedScript({
          rootDir: directory,
          scriptId,
        });
        allowed(script.workId);
        const source = await resolveProductionSource(store, script.workId, {
          kind: "scene-script",
          scriptId,
        });
        const { lock } = await readSealedProductionInput({
          rootDir: directory,
          productionLockId: source.productionLockId,
        });
        const temporalScope = "sealed-scene-scope",
          pins = {
            productionLockId: lock.revisionId,
            loreRevisionId: lock.loreRevisionId,
            scriptRef: ref(
              script.workId,
              "sceneScript",
              scriptId,
              script.revisionId
            ),
          };
        add(
          ref(script.workId, "sceneScript", scriptId, script.revisionId),
          script.title,
          "text",
          await read(`scenes/${scriptId}.md`),
          { temporalScope, language: script.language },
          pins
        );
        for (const doc of new Map(
          lock.scenes.flatMap((scene) =>
            scene.documents.map((doc) => [doc.id, doc])
          )
        ).values())
          add(
            ref(script.workId, "document", doc.id, lock.revisionId),
            doc.id,
            "text",
            Buffer.from(doc.text),
            { temporalScope },
            pins
          );
        for (const asset of source.assets) {
          const selectedStates = [
            ...new Set(
              lock.scenes
                .filter((s) => asset.sceneIds.includes(s.id))
                .flatMap((s) => s.stateIds?.[asset.entityId] ?? [])
            ),
          ];
          const subjects = [
            {
              ownerId,
              projectId: script.workId,
              identityId: asset.entityId,
              stateRefs: selectedStates.map((id) =>
                ref(script.workId, "state", id, lock.loreRevisionId)
              ),
            },
          ];
          add(
            ref(script.workId, "asset", asset.assetId, asset.assetRevisionId),
            asset.label,
            "image",
            await read(asset.path, asset.hash),
            {
              temporalScope,
              subjects,
              roles: ["identity-reference", "style-reference"],
              mime: asset.mime,
              nativeAsset: portable(asset),
            },
            {
              ...pins,
              universeId: script.universeId,
              assetCatalogRevisionId: source.assetCatalogRevisionId,
            }
          );
        }
        tokens.push(script.revisionId);
        checks.push(() => verifyProductionSource(store, source, script.workId));
      }
      for (const name of await names(".vibelore/productions")) {
        if (!name.endsWith(".json")) continue;
        const production = await json(`.vibelore/productions/${name}`);
        if (production.kind !== "webtoon-scene") continue;
        allowed(production.workId);
        const workflow = await json(
          `.vibelore/webtoon/workflows/${production.workflowId}.json`
        );
        // Only the completed, hash-bound native production is a published expression.
        // Older records without their retained approving workflow are unavailable.
        if (
          workflow.stage !== "completed" ||
          workflow.revision !== production.revision
        )
          continue;
        const revision = digest(production);
        if (
          workflow.productionRecordHash !== revision ||
          workflow.sceneImage?.hash !== production.image.hash ||
          workflow.source.hash !== production.source.hash ||
          digest(workflow.scenePlan) !== production.planHash ||
          digest(workflow.visualReview) !== production.reviewHash ||
          digest(workflow.preflight) !== production.preflightHash
        )
          fail("SOURCE_CORRUPT", "Native completed webtoon evidence differs.");
        const permitted = `.vibelore/webtoon/candidates/${production.workflowId}/r${production.revision}/`;
        if (!production.image.path.startsWith(permitted))
          fail(
            "SOURCE_CORRUPT",
            "Webtoon image is outside its native candidate scope."
          );
        const bytes = await read(production.image.path, production.image.hash);
        add(
          ref(
            production.workId,
            "webtoon-scene",
            production.workflowId,
            revision
          ),
          workflow.scenePlan.title,
          "image",
          bytes,
          {
            temporalScope: "completed-production",
            roles: ["final-scene", "style-reference"],
            mime: production.image.mime,
            nativeProduction: portable(production),
            sourceObservations: portable(workflow.visualReview),
          },
          portable(production.source)
        );
        const source = await resolveProductionSource(
          store,
          production.workId,
          production.source.kind === "scene-script"
            ? {
                kind: "scene-script",
                scriptId: production.source.scriptId,
                scriptRevisionId: production.source.scriptRevisionId,
                productionLockId: production.source.productionLockId,
              }
            : {
                kind: "novel-chapters",
                chapters: production.source.chapters.map((c) => c.chapter),
              }
        );
        if (source.hash !== production.source.hash)
          fail("SOURCE_DRIFT", "Webtoon source requires synchronization.");
        tokens.push(revision);
        checks.push(() =>
          verifyProductionSource(store, source, production.workId)
        );
      }
      if (!tokens.length)
        fail("SOURCE_MISSING", "No committed source is present.");
    }
    for (const check of checks) await check();
    if ((await physicalOwnerIdentity(directory, ".vibelore")) !== identity)
      fail("OWNER_REPLACED", "Source store was replaced.");
    return { records, token: canonicalDigest(tokens) };
  }
  async function guarded(operation) {
    try {
      return await operation();
    } catch (error) {
      if (
        /SYNC|DRIFT|SOURCE_CHANGED/.test(`${error.code ?? ""} ${error.message}`)
      )
        fail("SOURCE_DRIFT", "Source edits require synchronization.");
      if (error.code === "ENOENT")
        fail("SOURCE_MISSING", "Exact source evidence is missing.");
      throw error;
    }
  }
  const adapter = {
    identify: () => physicalOwnerIdentity(directory, ".vibelore"),
    capture: () =>
      guarded(async () => {
        const { records, token } = await collect();
        return {
          token,
          entries: records.map((r) => ({
            ref: r.ref,
            title: r.title,
            mediaKind: r.mediaKind,
            roles: r.metadata.roles,
            subjects: r.metadata.subjects,
            expressionRefs: [],
            availability: "observed-available",
            capabilities: r.content
              ? ["discover", "preserve", "inspect", "derive"]
              : ["discover", "inspect"],
          })),
          links: [],
          uses: records.flatMap((record) => {
            if (!["asset", "document"].includes(record.ref.recordKind))
              return [];
            const pins = record.sourcePins.scopeObservations ?? [
              record.sourcePins,
            ];
            return [
              ...new Map(
                pins
                  .filter((pin) => pin.scriptRef)
                  .map((pin) => [
                    originKey(pin.scriptRef),
                    { ref: record.ref, usedIn: pin.scriptRef },
                  ])
              ).values(),
            ];
          }),
          cases: [],
        };
      }),
    exportExact: ({ roots, disclosure }) =>
      guarded(async () => {
        for (const root of roots) {
          allowed(root.projectId);
          if (root.ownerId !== ownerId)
            fail("PROJECT_NOT_ALLOWED", "Reference is outside this owner.");
        }
        const { records } = await collect(roots),
          selected = roots.map(
            (root) =>
              records.find((r) => originKey(r.ref) === originKey(root)) ??
              fail("SOURCE_MISSING", "Exact native revision is unavailable.")
          );
        const files = new Map(),
          bytes = {};
        const preserved = selected.map((r) => {
          const hashes = [];
          if (r.content) {
            const sha256 = hashBytes(r.content);
            hashes.push(sha256);
            bytes[sha256] = [...r.content];
            files.set(sha256, {
              sha256,
              byteLength: r.content.length,
              mime: r.metadata.mime ?? "text/plain",
              role: "selected-content",
            });
          }
          return {
            ref: r.ref,
            metadata: {
              title: r.title,
              mediaKind: r.mediaKind,
              ...r.metadata,
              ...(hashes.length ? { selectedContentSha256: hashes[0] } : {}),
            },
            requiredFileSha256s: hashes,
            sourcePins: r.sourcePins,
            evidenceRefs: [],
          };
        });
        return {
          bundle: sealBundle({
            schemaVersion: 1,
            roots,
            records: preserved,
            files: [...files.values()],
            links: [],
            disclosure: {
              includedScope:
                disclosure?.includedScope ??
                "Exact committed chapters, sealed scene scopes, or individually selected published world archive records",
              omittedEvidence: [
                ...omissions,
                ...(disclosure?.omittedEvidence ?? []),
              ],
            },
            capturedAt: new Date().toISOString(),
          }),
          bytes,
        };
      }),
    async verifyRefs(refs) {
      await adapter.exportExact({ roots: refs });
      return true;
    },
  };
  return adapter;
}

/** Public boundary: native source routines only see a bounded operation-local
 * mirror. The locator remains private and neither source nor mirror is opened
 * through an initializer, migration, recovery or workflow command. */
export function createVibeloreOwnerAdapter(config) {
  const directory = ownerLocation(config.locator);
  const allowed = (id) => {
    if (!config.allowedProjects.includes(id))
      fail(
        "PROJECT_NOT_ALLOWED",
        "Native project is outside this registration."
      );
  };
  const objectPath = (area, revision) => {
    if (!isLoreRevisionId(revision))
      fail("SOURCE_CORRUPT", "Malformed native revision.");
    return `${area}/${revision.slice(7)}.json`;
  };
  async function prepare(copy, roots = []) {
    const loreArea = ".vibelore/shared-lore/lore",
      registryArea = ".vibelore/shared-lore/registry",
      assetArea = ".vibelore/shared-lore/assets";
    const worldHead = (await copy.file(`${loreArea}/HEAD`, true))
      ?.toString()
      .trim();
    async function registry(revision) {
      await copy.file(`${registryArea}/HEAD`, true);
      const object = await copy.json(
        objectPath(`${registryArea}/objects`, revision)
      );
      for (const definition of object.registry.definitions)
        await copy.file(objectPath(`${registryArea}/objects`, definition));
    }
    async function lore(revision) {
      const object = await copy.json(
        objectPath(`${loreArea}/objects`, revision)
      );
      allowed(object.revision.universeId);
      await registry(object.revision.registryRevisionId);
      return object;
    }
    if (worldHead) {
      const current = await lore(worldHead);
      // Native drift checks own these exact source surfaces, including author
      // documents. Their bytes remain private in the mirror and are never DTOs.
      await copy.tree("world", /\.(md|json)$/i);
      await copy.tree("characters", /\.(md|json)$/i);
      await copy.file("universe.md", true);
      const wantedLore = new Set(
        roots
          .filter((r) => ["document", "state"].includes(r.recordKind))
          .map((r) => r.revision)
      );
      wantedLore.delete(current.revision.revisionId);
      for (
        let parent = current.revision.parentRevisionId;
        parent && wantedLore.size;

      ) {
        const object = await lore(parent);
        wantedLore.delete(object.revision.revisionId);
        parent = object.revision.parentRevisionId;
      }
      const assetHead = (await copy.file(`${assetArea}/HEAD`, true))
        ?.toString()
        .trim();
      const wantedAssets = new Set(
        roots.filter((r) => r.recordKind === "asset").map((r) => r.revision)
      );
      for (let revision = assetHead; revision; ) {
        const catalog = await copy.json(
          objectPath(`${assetArea}/objects`, revision)
        );
        allowed(catalog.universeId);
        for (const assetRevision of Object.values(catalog.assets)) {
          const selected = wantedAssets.delete(assetRevision);
          if (revision !== assetHead && !selected) continue;
          const asset = await copy.json(
            objectPath(`${assetArea}/objects`, assetRevision)
          );
          await lore(asset.linkedLoreRevisionId);
          await copy.file(`${assetArea}/blobs/${asset.blob.blobId.slice(7)}`);
        }
        if (!wantedAssets.size) break;
        revision = catalog.parentRevisionId;
      }
      return;
    }
    for (const path of ["world", "characters"])
      await copy.tree(path, /\.(md|txt|json|ya?ml)$/i);
    await copy.tree("chapters", /\.md$/i);
    await copy.file("work.md", true);
    for (const name of [
      "foundation",
      "story-profile",
      "story-identity",
      "writer-skill",
      "accepted-creation",
      "working-tree-fingerprint",
    ])
      await copy.file(`.vibelore/${name}.json`, true);
    for (const path of ["story-state", "artifacts", "episode-plans"])
      await copy.tree(`.vibelore/${path}`, /\.json$/i);
    const publishedHead = (await copy.file(".vibelore/publication/HEAD", true))
      ?.toString()
      .trim();
    if (publishedHead) {
      if (!isLoreRevisionId(publishedHead))
        fail("SOURCE_CORRUPT", "Malformed native publication.");
      const base = `.vibelore/publication/objects/${publishedHead.slice(7)}`;
      const tree = await copy.json(`${base}/tree.json`);
      allowed(tree.workId);
      for (const name of ["projections.json", "manifest.json"])
        await copy.file(`${base}/${name}`);
    }
    for (const name of await copy.list(".vibelore/scene-scripts/heads")) {
      if (!name.endsWith(".json")) continue;
      const head = await copy.json(`.vibelore/scene-scripts/heads/${name}`);
      const script = await copy.json(
        objectPath(".vibelore/scene-scripts/objects", head.revisionId)
      );
      allowed(script.workId);
      await copy.file(`scenes/${script.scriptId}.md`);
      const lock = await copy.json(
        objectPath(".vibelore/input-objects/locks", head.productionLockId)
      );
      for (const asset of lock.assets)
        await copy.file(
          `.vibelore/input-objects/blobs/${asset.blob.blobId.slice(7)}.${
            asset.blob.mime === "image/png" ? "png" : "jpg"
          }`
        );
    }
    for (const name of await copy.list(".vibelore/productions")) {
      if (!name.endsWith(".json")) continue;
      const production = await copy.json(`.vibelore/productions/${name}`);
      if (production.kind !== "webtoon-scene") continue;
      allowed(production.workId);
      await copy.file(
        `.vibelore/webtoon/workflows/${production.workflowId}.json`
      );
      const permitted = `.vibelore/webtoon/candidates/${production.workflowId}/r${production.revision}/`;
      if (!production.image.path.startsWith(permitted))
        fail(
          "SOURCE_CORRUPT",
          "Image is outside its declared native candidate scope."
        );
      await copy.file(production.image.path);
    }
  }
  async function operation(method, request) {
    const identity = await physicalOwnerIdentity(directory, ".vibelore");
    const result = await withOwnerFiles(
      directory,
      (copy) => prepare(copy, request?.roots),
      (mirror) =>
        boundedVibeloreOwnerAdapter({
          ...config,
          locator: { directory: mirror },
        })[method](request)
    );
    if ((await physicalOwnerIdentity(directory, ".vibelore")) !== identity)
      fail("OWNER_REPLACED", "Source store was replaced during capture.");
    return result;
  }
  return {
    identify: () => physicalOwnerIdentity(directory, ".vibelore"),
    capture: (request) => operation("capture", request),
    exportExact: (request) => operation("exportExact", request),
    verifyRefs: async (refs) => {
      await operation("exportExact", { roots: refs });
      return true;
    },
  };
}
