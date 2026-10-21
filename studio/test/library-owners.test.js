import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  rm,
  rename,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withStudio } from "./helpers/project.js";
import {
  assetImport,
  environmentSlot,
  png,
  basePixels,
} from "./helpers/images.js";
import { canonicalDigest } from "../src/engine/contracts.js";
import { hashBytes } from "../src/source/source-package.js";
import { validateBundle } from "../src/reuse/bundle.js";

const modules = await Promise.all([
  import("../src/source/export-studio-assets.js").catch((e) =>
    e.code === "ERR_MODULE_NOT_FOUND" ? {} : Promise.reject(e)
  ),
  import("../src/source/owner-io.js").catch((e) =>
    e.code === "ERR_MODULE_NOT_FOUND" ? {} : Promise.reject(e)
  ),
]);
const [studio, io] = modules;
const ownerId = "native-owner";
async function inventory(directory, prefix = "") {
  const files = {};
  for (const entry of await readdir(join(directory, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory())
      Object.assign(files, await inventory(directory, path));
    else files[path] = hashBytes(await readFile(join(directory, path)));
  }
  return files;
}
function adapter(directory, allowedProjects = ["p1"]) {
  assert.equal(
    typeof studio.createStudioOwnerAdapter,
    "function",
    "read-only Studio owner adapter must exist"
  );
  return studio.createStudioOwnerAdapter({
    locator: { directory },
    ownerId,
    allowedProjects,
  });
}
for (const schemaVersion of [1, 2])
  test(`Studio schema ${schemaVersion} capture/export retains exact candidates and never mutates source`, async (t) => {
    const f = await withStudio(t);
    const bytes = await png(basePixels);
    const first = (await assetImport(f, "old", bytes)).value.candidate;
    await assetImport(
      f,
      "new",
      await png(basePixels.map((n, i) => (i === 0 ? n + 1 : n)))
    );
    await f.command(
      "source.manuscript",
      {
        id: "manuscript",
        title: "Draft",
        language: "ko",
        bytes: [...Buffer.from("원문 그대로")],
      },
      { aggregate: { kind: "sourcePackage", id: "manuscript" } }
    );
    const source = (await f.service.snapshot("p1")).sourcePackages[0];
    await f.service.close();
    if (schemaVersion === 1) {
      const db = new DatabaseSync(join(f.directory, "studio.sqlite"));
      db.exec("DROP TABLE reuse_imports; PRAGMA user_version=1");
      db.close();
    }
    const before = await inventory(f.directory),
      a = adapter(f.directory);
    const snapshot = await a.capture({ ownerId, allowedProjects: ["p1"] });
    const old = snapshot.entries.find((e) => e.ref.recordId === "old");
    assert.deepEqual(old.ref, {
      ownerId,
      projectId: "p1",
      recordKind: "candidate",
      recordId: "old",
      revision: canonicalDigest(first),
    });
    assert.ok(old.capabilities.includes("preserve"));
    const pkg = snapshot.entries.find(
      (e) => e.ref.recordKind === "sourcePackage"
    );
    assert.equal(pkg.ref.recordId, source.id);
    assert.equal(pkg.ref.revision, source.sourceDigest);
    const exported = await a.exportExact({ roots: [old.ref] });
    validateBundle(exported.bundle, exported.bytes);
    assert.deepEqual(
      Buffer.from(exported.bytes[first.canonicalBlobId]),
      await png(basePixels)
    );
    assert.deepEqual(exported.bundle.roots, [old.ref]);
    assert.ok(!JSON.stringify(exported.bundle).includes(f.directory));
    await assert.rejects(
      a.exportExact({ roots: [{ ...old.ref, revision: "absent" }] }),
      { code: "SOURCE_MISSING" }
    );
    assert.deepEqual(await inventory(f.directory), before);
  });
test("missing, unsupported and unregistered stores fail without creating or upgrading files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owner-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(adapter(join(root, "absent")).identify(), {
    code: "OWNER_OFFLINE",
  });
  assert.deepEqual(await readdir(root), []);
  const f = await withStudio(t);
  await f.service.close();
  await assert.rejects(
    adapter(f.directory, ["other"]).capture({
      ownerId,
      allowedProjects: ["other"],
    }),
    { code: "PROJECT_NOT_ALLOWED" }
  );
  const db = new DatabaseSync(join(f.directory, "studio.sqlite"));
  db.exec("PRAGMA user_version=99");
  db.close();
  const before = await inventory(f.directory);
  await assert.rejects(
    adapter(f.directory).capture({ ownerId, allowedProjects: ["p1"] }),
    { code: "SOURCE_SCHEMA_UNSUPPORTED" }
  );
  assert.deepEqual(await inventory(f.directory), before);
});
test("physical fingerprint survives moves and changes on replacement", async (t) => {
  const f = await withStudio(t);
  await f.service.close();
  const original = await adapter(f.directory).identify(),
    moved = `${f.directory}-moved`;
  await rename(f.directory, moved);
  t.after(() => rm(moved, { recursive: true, force: true }));
  assert.equal(await adapter(moved).identify(), original);
  const replacement = await withStudio(t);
  await replacement.service.close();
  assert.notEqual(await adapter(replacement.directory).identify(), original);
});
test("owner byte reader rejects escaping paths, symlinks, oversize and mismatched bytes", async (t) => {
  assert.equal(
    typeof io.readOwnerBytes,
    "function",
    "bounded owner reader must exist"
  );
  const root = await mkdtemp(join(tmpdir(), "owner-bytes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "text"), "safe");
  await symlink(join(root, "text"), join(root, "link"));
  assert.equal(
    Buffer.from(
      await io.readOwnerBytes({
        directory: root,
        relativePath: "text",
        expectedSha256: hashBytes(Buffer.from("safe")),
      })
    ).toString(),
    "safe"
  );
  for (const relativePath of ["../outside", "link", root])
    await assert.rejects(io.readOwnerBytes({ directory: root, relativePath }));
  await assert.rejects(
    io.readOwnerBytes({ directory: root, relativePath: "text", maxBytes: 3 }),
    { code: "BUNDLE_LIMIT_EXCEEDED" }
  );
  await assert.rejects(
    io.readOwnerBytes({
      directory: root,
      relativePath: "text",
      expectedSha256: "0".repeat(64),
    }),
    { code: "BUNDLE_HASH_MISMATCH" }
  );
});

test("active WAL snapshot includes committed rows without touching source and rejects rollback journals", async (t) => {
  const f = await withStudio(t);
  await assetImport(f, "wal-candidate", await png(basePixels));
  const before = await inventory(f.directory);
  assert.ok(Object.keys(before).includes("studio.sqlite-wal"));
  const a = adapter(f.directory),
    result = await a.capture();
  assert.ok(result.entries.some((e) => e.ref.recordId === "wal-candidate"));
  assert.deepEqual(await inventory(f.directory), before);
  await writeFile(join(f.directory, "studio.sqlite-journal"), "active");
  await assert.rejects(a.capture(), { code: "SOURCE_BUSY" });
});
test("a source manuscript exposes one consumable exact selected-content file", async (t) => {
  const f = await withStudio(t);
  await f.command(
    "source.manuscript",
    {
      id: "source",
      title: "Draft",
      language: "ko",
      bytes: [...Buffer.from("exact text")],
    },
    { aggregate: { kind: "sourcePackage", id: "source" } }
  );
  const a = adapter(f.directory),
    snapshot = await a.capture(),
    ref = snapshot.entries.find(
      (e) => e.ref.recordKind === "sourcePackage"
    ).ref;
  const data = await a.exportExact({ roots: [ref] });
  assert.equal(
    data.bundle.files.filter((f) => f.role === "selected-content").length,
    1
  );
});

const vibelore = await import("../src/source/export-vibelore-assets.js").catch(
  (e) => (e.code === "ERR_MODULE_NOT_FOUND" ? {} : Promise.reject(e))
);
function loreAdapter(directory, allowedProjects) {
  assert.equal(
    typeof vibelore.createVibeloreOwnerAdapter,
    "function",
    "read-only vibelore owner adapter must exist"
  );
  return vibelore.createVibeloreOwnerAdapter({
    locator: { directory },
    ownerId,
    allowedProjects,
  });
}
async function canonicalFixture() {
  const { webtoonStore, workId } = await import(
    "../../test/fixtures/webtoon.js"
  );
  const { createPublicationUnit } = await import(
    "../../src/core/publication-unit.js"
  );
  const { captureWorkingTreeFingerprint } = await import(
    "../../src/core/working-tree-sync.js"
  );
  const store = await webtoonStore(),
    publication = createPublicationUnit({ rootDir: store.rootDir });
  const token = await publication.issueFencingToken(),
    old = await publication.readPublished();
  const artifact = await store.loadArtifact(workId, 1);
  const result = await publication.publish({
    context: {
      snapshotId: "owner-fixture",
      expectedHead: old.value?.head ?? null,
      storyTimeScope: { worldline: "main", through: 1 },
      publicationOrder: 1,
      transactionTime: new Date().toISOString(),
      policyRevision: "test",
      semanticGeneration: "test",
      fencingToken: token.value.fencingToken,
    },
    candidate: {
      tree: {
        workId,
        chapters: {
          1: { chapterNumber: 1, title: artifact.title, prose: artifact.prose },
        },
      },
      projections: {},
      impactClosure: [],
    },
  });
  assert.equal(result.ok, true);
  await captureWorkingTreeFingerprint({ store, sourceHead: result.value.head });
  return { store, workId, head: result.value.head };
}
test("vibelore committed chapter keeps native publication revision and exact bytes, omits unconstrained world context, rejects drift", async () => {
  const { store, workId, head } = await canonicalFixture(),
    before = await inventory(store.rootDir);
  const a = loreAdapter(store.rootDir, [workId]),
    snapshot = await a.capture();
  const chapter = snapshot.entries.find((e) => e.ref.recordKind === "chapter");
  assert.equal(chapter.ref.projectId, workId);
  assert.equal(chapter.ref.recordId, "1");
  assert.equal(chapter.ref.revision, head);
  const data = await a.exportExact({ roots: [chapter.ref] });
  validateBundle(data.bundle, data.bytes);
  const selected = data.bundle.files.find((f) => f.role === "selected-content");
  assert.deepEqual(
    Buffer.from(data.bytes[selected.sha256]),
    await readFile(store.chapterPath(1))
  );
  assert.match(
    data.bundle.disclosure.omittedEvidence.join(" "),
    /author|future/i
  );
  assert.deepEqual(await inventory(store.rootDir), before);
  await writeFile(store.chapterPath(1), "unsynced change");
  await assert.rejects(a.capture(), { code: "SOURCE_DRIFT" });
  await assert.rejects(a.exportExact({ roots: [chapter.ref] }), {
    code: "SOURCE_DRIFT",
  });
});
test("vibelore missing roots and mismatched native work IDs never initialize storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lore-owner-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    loreAdapter(join(root, "missing"), ["work"]).identify(),
    { code: "OWNER_OFFLINE" }
  );
  assert.deepEqual(await readdir(root), []);
  const { store } = await canonicalFixture();
  await assert.rejects(loreAdapter(store.rootDir, ["other"]).capture(), {
    code: "PROJECT_NOT_ALLOWED",
  });
});

test("published world is a state archive: exact context and approved assets, no author text or current winner", async (t) => {
  const { sharedWorld } = await import("../../test/fixtures/shared-lore.js");
  const { AssetCatalogStore } = await import(
    "../../src/store/asset-catalog-store.js"
  );
  const w = await sharedWorld();
  t.after(() => rm(w.root, { recursive: true, force: true }));
  const image = await png(basePixels),
    imagePath = join(w.root, "portrait.png");
  await writeFile(imagePath, image);
  const catalog = new AssetCatalogStore(w.root, "u1");
  const proposal = await catalog.propose({
    expectedHead: null,
    loreRevisionId: w.head,
    reason: "native fixture",
    assets: [
      {
        assetId: "portrait",
        sourcePath: imagePath,
        label: "Before",
        entityId: "character-a",
        stateIds: ["state-before"],
      },
    ],
  });
  const adopted = await catalog.decide({
    expectedHead: null,
    proposalId: proposal.proposalId,
    decision: "approve",
  });
  const nativeAsset = await catalog.object(
    (
      await catalog.read()
    ).catalog.assets.portrait,
    "asset"
  );
  const before = await inventory(w.root),
    a = loreAdapter(w.root, ["u1"]),
    snapshot = await a.capture();
  assert.ok(snapshot.entries.some((e) => e.ref.recordId === "before"));
  assert.ok(snapshot.entries.some((e) => e.ref.recordId === "after"));
  assert.ok(!snapshot.entries.some((e) => e.ref.recordId === "secret"));
  const state = snapshot.entries.find(
    (e) => e.ref.recordKind === "document" && e.ref.recordId === "before"
  );
  const result = await a.exportExact({ roots: [state.ref] });
  const texts = Object.values(result.bytes)
    .map((b) => Buffer.from(b).toString())
    .join("");
  assert.match(texts, /BEFORE_BODY_ONLY/);
  assert.doesNotMatch(texts, /AFTER_BODY_ONLY|FUTURE_SECRET_TOKEN/);
  assert.equal(
    result.bundle.records[0].metadata.temporalScope,
    "published-world-archive"
  );
  const asset = snapshot.entries.find((e) => e.ref.recordId === "portrait");
  assert.equal(asset.ref.revision, nativeAsset.revisionId);
  const exported = await a.exportExact({ roots: [asset.ref] });
  assert.deepEqual(
    Buffer.from(exported.bytes[nativeAsset.blob.blobId.slice(7)]),
    image
  );
  assert.equal(
    exported.bundle.records[0].sourcePins.catalogRevisionId,
    adopted.head
  );
  assert.equal(
    exported.bundle.records[0].metadata.subjects[0].stateRefs[0].recordId,
    "state-before"
  );
  assert.deepEqual(await inventory(w.root), before);
  await writeFile(join(w.root, "characters/states/before.md"), "changed");
  await assert.rejects(a.capture(), { code: "SOURCE_DRIFT" });
});
test("sealed script owner exports only selected state context and copied native assets after world is offline", async (t) => {
  const { sharedWorld } = await import("../../test/fixtures/shared-lore.js");
  const { AssetCatalogStore } = await import(
    "../../src/store/asset-catalog-store.js"
  );
  const { MarkdownStateStore } = await import(
    "../../src/store/markdown-store.js"
  );
  const { inspectSceneScript, applySceneScript } = await import(
    "../../src/core/scene-script.js"
  );
  const w = await sharedWorld(),
    root = await mkdtemp(join(tmpdir(), "sealed-owner-"));
  t.after(() =>
    Promise.all([
      rm(w.root, { recursive: true, force: true }),
      rm(root, { recursive: true, force: true }),
    ])
  );
  const image = await png(basePixels);
  await writeFile(join(w.root, "asset.png"), image);
  const assets = new AssetCatalogStore(w.root, "u1"),
    p = await assets.propose({
      expectedHead: null,
      loreRevisionId: w.head,
      reason: "native fixture",
      assets: [
        {
          assetId: "before-portrait",
          sourcePath: join(w.root, "asset.png"),
          label: "Before",
          entityId: "character-a",
          stateIds: ["state-before"],
        },
      ],
    });
  const adopted = await assets.decide({
    expectedHead: null,
    proposalId: p.proposalId,
    decision: "approve",
  });
  const store = new MarkdownStateStore(root),
    script = {
      schemaVersion: 1,
      workId: "script-work",
      scriptId: "native.script:1",
      title: "Scene",
      language: "ko",
      universeId: "u1",
      loreRevisionId: w.head,
      registryRevisionId: w.registry.revisionId,
      continuityId: "main",
      assetCatalogRevisionId: adopted.head,
      expressionProfileId: null,
      cast: [
        {
          localCharacterId: "hero",
          entityId: "character-a",
          projections: [{ target: "canonicalName", fieldId: "name" }],
          assetIds: ["before-portrait"],
        },
      ],
      scenes: [
        {
          id: "one",
          frame: "present",
          scope: { continuityId: "main", timelineId: "t1", pointId: "p0" },
          entityIds: ["character-a"],
          requirements: [
            { entityId: "character-a", fieldId: "name", required: true },
          ],
          text: "문 앞에서 기다린다.",
        },
      ],
    };
  const preview = await inspectSceneScript({
    store,
    workId: script.workId,
    worldRoot: w.root,
    script,
  });
  await applySceneScript({
    store,
    workId: script.workId,
    proposalId: preview.proposalId,
    expectedHead: null,
  });
  const secondScript = {
    ...script,
    scriptId: "native.script:2",
    title: "Another scene",
  };
  const secondPreview = await inspectSceneScript({
    store,
    workId: script.workId,
    worldRoot: w.root,
    script: secondScript,
  });
  await applySceneScript({
    store,
    workId: script.workId,
    proposalId: secondPreview.proposalId,
    expectedHead: null,
  });
  await rm(w.root, { recursive: true, force: true });
  const before = await inventory(root),
    a = loreAdapter(root, [script.workId]),
    snapshot = await a.capture();
  const selected = snapshot.entries.find(
    (e) => e.ref.recordKind === "sceneScript"
  );
  assert.equal(selected.ref.recordId, script.scriptId);
  assert.equal(selected.ref.revision, preview.scriptRevisionId);
  assert.ok(snapshot.entries.some((e) => e.ref.recordId === "before"));
  assert.ok(
    !snapshot.entries.some((e) => ["after", "secret"].includes(e.ref.recordId))
  );
  const asset = snapshot.entries.find(
      (e) => e.ref.recordId === "before-portrait"
    ),
    result = await a.exportExact({ roots: [asset.ref] });
  assert.equal(
    snapshot.entries.filter((entry) => entry.ref.recordId === "before-portrait")
      .length,
    1
  );
  assert.equal(result.bundle.records[0].sourcePins.scopeObservations.length, 2);
  assert.deepEqual(
    snapshot.uses
      .filter((use) => use.ref.recordId === "before-portrait")
      .map((use) => use.usedIn.recordId)
      .sort(),
    [script.scriptId, secondScript.scriptId].sort()
  );
  assert.deepEqual(Buffer.from(Object.values(result.bytes)[0]), image);
  assert.equal(
    result.bundle.records[0].metadata.temporalScope,
    "sealed-scene-scope"
  );
  assert.doesNotMatch(
    JSON.stringify(result.bundle),
    /FUTURE_SECRET_TOKEN|AFTER_BODY_ONLY/
  );
  assert.deepEqual(await inventory(root), before);
});
test("completed native webtoon scene keeps production record hash and final image without importing author source snapshot", async () => {
  const { sceneSetup, scenePlan, scenePreflight } = await import(
    "../../test/fixtures/webtoon-scene.js"
  );
  const { runWebtoonSceneTool } = await import(
    "../../src/tools/webtoon-scene.js"
  );
  const { workId } = await import("../../test/fixtures/webtoon.js");
  const { store, repo, args } = await sceneSetup();
  const providers = {
    provenance: { kind: "fixture" },
    async complete(request) {
      const d = JSON.parse(request.messages.at(-1).content),
        value =
          request.step === "webtoon-scene-plan"
            ? scenePlan(d.source)
            : request.step === "webtoon-scene-preflight"
            ? scenePreflight(d)
            : {
                ...d.schema,
                observedPanelCount: 6,
                inspectedImages: true,
                spatialCoherence: true,
                readingOrder: true,
                evidence: "Fixture assertion only",
                textObservations: d.plan.texts.map((t) => ({
                  id: t.id,
                  observedText: t.text,
                  readable: true,
                  speakerCorrect: true,
                  evidence: "Fixture only",
                })),
              };
      return { text: JSON.stringify(value) };
    },
  };
  const started = await runWebtoonSceneTool({ store, args, providers });
  await runWebtoonSceneTool({
    store,
    args: {
      workId,
      asset: {
        path: args.references[0].path,
        inputHash: started.jobs[0].inputHash,
        provenance: {
          kind: "openai-api",
          requestedModel: "gpt-image-2.5-sunburst",
          selectionId: "selected-api",
        },
      },
    },
    providers,
  });
  const native = await repo.load(),
    before = await inventory(store.rootDir),
    a = loreAdapter(store.rootDir, [workId]),
    snapshot = await a.capture();
  const entry = snapshot.entries.find(
    (e) => e.ref.recordKind === "webtoon-scene"
  );
  assert.equal(entry.ref.recordId, native.workflowId);
  assert.equal(entry.ref.revision, native.productionRecordHash);
  const result = await a.exportExact({ roots: [entry.ref] });
  validateBundle(result.bundle, result.bytes);
  assert.deepEqual(
    Buffer.from(result.bytes[native.sceneImage.hash.slice(7)]),
    await readFile(native.sceneImage.path)
  );
  assert.deepEqual(await inventory(store.rootDir), before);
});

test("directory preservation, normalization, derive and reexport keep local refs and foreign ancestry while source goes offline", async (t) => {
  const sharp = (await import("sharp")).default;
  const { writeBundleDirectory, readBundleDirectory } = await import(
    "../src/reuse/bundle.js"
  );
  const source = await withStudio(t),
    destination = await withStudio(t);
  const jpeg = await sharp(await png(basePixels))
    .jpeg()
    .toBuffer();
  const { bundleFixture, ref: externalRef } = await import(
    "./helpers/bundles.js"
  );
  const foreign = externalRef({ recordId: "jpeg-source" }),
    sha256 = hashBytes(jpeg),
    sourceSlot = environmentSlot("source-slot");
  const initial = {
    ...bundleFixture({
      roots: [foreign],
      records: [
        {
          ref: foreign,
          metadata: {
            mediaKind: "image",
            roles: ["environment-reference"],
            subjects: [],
          },
          requiredFileSha256s: [sha256],
          sourcePins: {},
          evidenceRefs: [],
        },
      ],
      files: [
        {
          sha256,
          byteLength: jpeg.length,
          mime: "image/jpeg",
          role: "selected-content",
        },
      ],
    }),
    bytes: { [sha256]: [...jpeg] },
  };
  const firstIntent = {
    target: { kind: "assetSlot", id: sourceSlot.id },
    mode: "reuse-preserved",
    purpose: "normalize original JPEG",
    identityMap: [],
    stateMap: [],
    selections: [
      { source: foreign, slot: sourceSlot, role: "environment-reference" },
    ],
  };
  const firstInspection = await source.service.inspectReuse({
    projectId: "p1",
    ...initial,
    intent: firstIntent,
  });
  const candidate = (
    await source.command(
      "asset.importBundle",
      {
        ...initial,
        intent: firstIntent,
        inspectionDigest: firstInspection.inspectionDigest,
        actor: "artist",
        reason: "normalize",
      },
      { aggregate: firstIntent.target }
    )
  ).value.candidate;
  const a = adapter(source.directory),
    originalRef = (await a.capture()).entries.find(
      (e) => e.ref.recordId === candidate.id
    ).ref;
  const data = await a.exportExact({ roots: [originalRef] });
  const bundleDirectory = join(
    await realpath(destination.directory),
    "portable"
  );
  await writeBundleDirectory(bundleDirectory, data);
  const imported = await readBundleDirectory(bundleDirectory),
    slot = environmentSlot("local-slot");
  const intent = {
    target: { kind: "assetSlot", id: slot.id },
    mode: "reuse-preserved",
    purpose: "make a crop",
    identityMap: [],
    stateMap: [],
    selections: [{ source: originalRef, slot, role: "environment-reference" }],
  };
  const inspection = await destination.service.inspectReuse({
    projectId: "p1",
    ...imported,
    intent,
  });
  assert.equal(inspection.disposition, "compatible");
  const receipt = (
    await destination.command(
      "asset.importBundle",
      {
        ...imported,
        inspectionDigest: inspection.inspectionDigest,
        intent,
        actor: "local-artist",
        reason: "preserve",
      },
      { aggregate: intent.target }
    )
  ).value;
  const importedId = receipt.candidate.id;
  await destination.command(
    "candidate.adopt",
    {
      slotId: slot.id,
      candidateId: importedId,
      actor: "artist",
      reason: "explicit local adoption",
    },
    { aggregate: intent.target }
  );
  await destination.command(
    "asset.derive",
    {
      id: "crop",
      slotId: slot.id,
      baseCandidateId: importedId,
      operation: "crop",
      rect: { left: 0, top: 0, width: 2, height: 1 },
      actor: "artist",
    },
    { aggregate: intent.target }
  );
  await source.service.close();
  const offline = `${source.directory}-offline`;
  await rename(source.directory, offline);
  t.after(() => rm(offline, { recursive: true, force: true }));
  await assert.rejects(a.exportExact({ roots: [originalRef] }), {
    code: "OWNER_OFFLINE",
  });
  const b = studio.createStudioOwnerAdapter({
    locator: { directory: destination.directory },
    ownerId: "destination-owner",
    allowedProjects: ["p1"],
  });
  const snapshot = await b.capture(),
    derived = snapshot.entries.find((e) => e.ref.recordId === "crop");
  const result = await b.exportExact({ roots: [derived.ref] });
  validateBundle(result.bundle, result.bytes);
  assert.equal(result.bundle.roots[0].ownerId, "destination-owner");
  assert.ok(
    result.bundle.links.some(
      (l) => l.to.ownerId === ownerId && l.to.recordId === candidate.id
    ),
    "foreign ancestry survives local derivation"
  );
  assert.ok(
    result.bundle.links.some(
      (l) => l.relation === "normalized-from" && l.to.recordId === "jpeg-source"
    ),
    "source normalization remains explicit"
  );
  assert.ok(
    snapshot.uses.some(
      (u) => u.ref.recordId === candidate.id && u.usedIn.recordId === importedId
    )
  );
});
test("native audio export retains actual speaker/state pins and historical performance after scene changes", async (t) => {
  const { withAudioScene, audioTakeSlot } = await import(
    "./helpers/project.js"
  );
  const { wav } = await import("./helpers/images.js");
  const f = await withAudioScene(t),
    slot = audioTakeSlot("take", "u1");
  const candidate = (await assetImport(f, "old-take", wav(), slot, "audio"))
    .value.candidate;
  await f.command(
    "utterance.update",
    { id: "u1", sceneId: "scene", text: "새로운 대사" },
    { aggregate: { kind: "utterance", id: "u1" } }
  );
  const a = adapter(f.directory),
    entry = (await a.capture()).entries.find(
      (e) => e.ref.recordId === "old-take"
    );
  const result = await a.exportExact({ roots: [entry.ref] }),
    metadata = result.bundle.records[0].metadata;
  assert.deepEqual(metadata.audioBinding, candidate.audioBinding);
  assert.equal(metadata.speechPerformance.text, "같은 대사");
  assert.equal(metadata.subjects[0].identityId, "char");
  assert.ok(
    metadata.subjects[0].stateRefs.some((r) => r.recordId === "childvoice")
  );
  assert.deepEqual(result.bundle.records[0].sourcePins.pins, candidate.pins);
});
test("Edition discovery retains native closure ID/digest and exports actual required blobs without claiming video rendering", async (t) => {
  const { audioFixture } = await import("./helpers/render-fixture.js");
  const f = await audioFixture(t),
    edition = (
      await f.command(
        "edition.create",
        { id: "edition1", productionId: "main", profile: "audio" },
        { aggregate: { kind: "edition", id: "edition1" } }
      )
    ).value;
  const a = adapter(f.directory),
    entry = (await a.capture()).entries.find(
      (e) => e.ref.recordKind === "edition"
    );
  assert.equal(entry.ref.recordId, "edition1");
  assert.equal(entry.ref.revision, edition.closureDigest);
  assert.ok(!entry.capabilities.includes("render"));
  const result = await a.exportExact({ roots: [entry.ref] });
  validateBundle(result.bundle, result.bytes);
  for (const id of edition.closure.blobIds) assert.ok(result.bytes[id]);
});

test("read-only native snapshots remain coherent across writer commits and reject store replacement mid-operation", async (t) => {
  const f = await withStudio(t);
  const before = f.service.store.get("SELECT count(*) AS n FROM events").n;
  await io.withOwnerDatabase(f.directory, async (db) => {
    await f.command(
      "story.save",
      {
        id: "story",
        title: "New",
        text: "later",
        states: [],
        revealPolicy: {},
      },
      { aggregate: { kind: "story", id: "story" } }
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM events").get().n,
      before
    );
  });
  await f.service.close();
  const moved = `${f.directory}-replaced`;
  t.after(() => rm(moved, { recursive: true, force: true }));
  const replacement = await withStudio(t);
  await replacement.service.close();
  await assert.rejects(
    io.withOwnerDatabase(f.directory, async () => {
      await rename(f.directory, moved);
      await rename(replacement.directory, f.directory);
    }),
    { code: "OWNER_REPLACED" }
  );
});
test("native adapters work through Library facade without leaking private locator fields", async (t) => {
  const { openLibrary } = await import("../src/library/index.js");
  const f = await withStudio(t);
  await assetImport(f, "visible", await png(basePixels));
  const directory = await mkdtemp(join(tmpdir(), "owner-library-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const library = await openLibrary({
    directory,
    adapters: { studio: studio.createStudioOwnerAdapter },
  });
  t.after(() => library.close());
  const registration = await library.command({
    commandId: "register",
    expectedRegistryRevision: 0,
    type: "owner.register",
    payload: {
      adapterKind: "studio",
      locator: { directory: f.directory },
      allowedProjects: ["p1"],
    },
  });
  await library.command({
    commandId: "refresh",
    expectedRegistryRevision: registration.registryRevision,
    type: "owner.refresh",
    payload: { ownerId: registration.ownerId },
  });
  const found = await library.query({ type: "find" });
  assert.equal(found.entries.length, 1);
  const exported = await library.exportExact({
    ownerId: registration.ownerId,
    roots: [found.entries[0].ref],
    disclosure: {},
  });
  assert.ok(!JSON.stringify([found, exported]).includes(f.directory));
});
test("native chapter symlinks are rejected", async (t) => {
  const { store, workId } = await canonicalFixture(),
    chapter = store.chapterPath(1),
    original = await readFile(chapter),
    outside = join(store.rootDir, "outside.md");
  await writeFile(outside, original);
  await rm(chapter);
  await symlink(outside, chapter);
  await assert.rejects(loreAdapter(store.rootDir, [workId]).capture());
});

test("published world history exports exact old document and asset revisions after newer publication", async (t) => {
  const { sharedWorld } = await import("../../test/fixtures/shared-lore.js");
  const { AssetCatalogStore } = await import(
    "../../src/store/asset-catalog-store.js"
  );
  const w = await sharedWorld();
  t.after(() => rm(w.root, { recursive: true, force: true }));
  const assets = new AssetCatalogStore(w.root, "u1"),
    oldImage = await png(basePixels);
  await writeFile(join(w.root, "portrait.png"), oldImage);
  const proposal = await assets.propose({
    expectedHead: null,
    loreRevisionId: w.head,
    reason: "first",
    assets: [
      {
        assetId: "portrait",
        sourcePath: join(w.root, "portrait.png"),
        label: "First",
        entityId: "character-a",
        stateIds: ["state-before"],
      },
    ],
  });
  await assets.decide({
    expectedHead: null,
    proposalId: proposal.proposalId,
    decision: "approve",
  });
  const a = loreAdapter(w.root, ["u1"]),
    initial = await a.capture(),
    oldDocument = initial.entries.find(
      (e) => e.ref.recordKind === "document" && e.ref.recordId === "before"
    ).ref,
    oldAsset = initial.entries.find((e) => e.ref.recordKind === "asset").ref;
  const change = await w.world.propose({
    expectedHead: w.head,
    registryRevisionId: w.registry.revisionId,
    content: {
      ...w.content,
      documents: w.content.documents.map((d) =>
        d.id === "before" ? { ...d, text: "NEW_BEFORE_DOCUMENT" } : d
      ),
    },
    reason: "new publication",
  });
  const updated = await w.world.decide({
    expectedHead: w.head,
    proposalId: change.proposalId,
    action: "approve",
  });
  await writeFile(
    join(w.root, "portrait.png"),
    await png(basePixels.map((x, i) => (i === 0 ? x + 1 : x)))
  );
  const catalogHead = await assets.head(),
    changedAsset = await assets.propose({
      expectedHead: catalogHead,
      loreRevisionId: updated.head,
      reason: "replace",
      assets: [
        {
          assetId: "portrait",
          sourcePath: join(w.root, "portrait.png"),
          label: "Second",
          entityId: "character-a",
          stateIds: ["state-before"],
        },
      ],
    });
  await assets.decide({
    expectedHead: catalogHead,
    proposalId: changedAsset.proposalId,
    decision: "approve",
  });
  const result = await a.exportExact({ roots: [oldDocument, oldAsset] });
  assert.deepEqual(result.bundle.roots, [oldDocument, oldAsset]);
  assert.ok(
    Object.values(result.bytes).some((b) =>
      Buffer.from(b).toString().includes("BEFORE_BODY_ONLY")
    )
  );
  assert.ok(
    Object.values(result.bytes).some((b) => Buffer.from(b).equals(oldImage))
  );
});

test("native resolver snapshots use stable bounded copies and reject changes without reading live source again", async (t) => {
  assert.equal(typeof io.withOwnerFiles, "function");
  const root = await mkdtemp(join(tmpdir(), "owner-mirror-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.txt"), "before");
  await assert.rejects(
    io.withOwnerFiles(
      root,
      async (copy) => {
        await copy.file("source.txt");
      },
      async (mirror) => {
        await writeFile(join(root, "source.txt"), "after");
        assert.equal(
          (await readFile(join(mirror, "source.txt"))).toString(),
          "before"
        );
      }
    ),
    { code: "SOURCE_DRIFT" }
  );
});
test("oversized native context fails before invoking unbounded legacy source resolvers", async () => {
  const { store, workId } = await canonicalFixture();
  const { open } = await import("node:fs/promises");
  const file = await open(join(store.rootDir, "world", "oversized.md"), "w");
  await file.truncate(20 * 1024 * 1024 + 1);
  await file.close();
  await assert.rejects(loreAdapter(store.rootDir, [workId]).capture(), {
    code: "BUNDLE_LIMIT_EXCEEDED",
  });
});

test("partial native WAL and oversized database snapshot fail explicitly without source repair", async (t) => {
  const f = await withStudio(t);
  await f.service.close();
  await writeFile(join(f.directory, "studio.sqlite-wal"), Buffer.alloc(33));
  const before = await inventory(f.directory);
  await assert.rejects(adapter(f.directory).capture(), { code: "SOURCE_BUSY" });
  assert.deepEqual(await inventory(f.directory), before);
  await rm(join(f.directory, "studio.sqlite-wal"));
  const { open } = await import("node:fs/promises"),
    file = await open(join(f.directory, "studio.sqlite"), "r+");
  await file.truncate(128 * 1024 * 1024 + 1);
  await file.close();
  await assert.rejects(adapter(f.directory).capture(), {
    code: "SOURCE_LIMIT_EXCEEDED",
  });
});
test("Edition output refs use the native output manifest digest, distinct from their containing closure", async (t) => {
  const { audioFixture } = await import("./helpers/render-fixture.js");
  const f = await audioFixture(t);
  await f.command(
    "edition.create",
    { id: "e", productionId: "main", profile: "audio" },
    { aggregate: { kind: "edition", id: "e" } }
  );
  const output = (
    await f.command(
      "edition.render",
      { editionId: "e", renderId: "render" },
      { aggregate: { kind: "editionOutput", id: "render" } }
    )
  ).value;
  assert.equal(output.status, "completed");
  const a = adapter(f.directory),
    entry = (await a.capture()).entries.find(
      (e) => e.ref.recordKind === "editionOutput"
    );
  assert.equal(entry.ref.revision, output.manifestDigest);
  const data = await a.exportExact({ roots: [entry.ref] });
  assert.deepEqual(
    Buffer.from(data.bytes[output.manifest.output.blobId]),
    Buffer.from(await f.service.readBlob("p1", output.manifest.output.blobId))
  );
});

test("nested state refs distinguish identical state IDs in separate native source containers", async (t) => {
  const { makeSourcePackage } = await import("../src/source/source-package.js");
  const f = await withStudio(t);
  for (const id of ["one", "two"]) {
    const pkg = makeSourcePackage({
      id,
      sourceKind: "studio-script",
      sourceRevision: "native-v1",
      textUnits: [],
      sceneScopes: [{ id: "scene", stateIds: { hero: ["same-state"] } }],
      sourceIdentityMap: [{ id: "hero", canonId: "hero" }],
      blobManifest: [],
      revealPolicy: {},
      preservationStatus: {},
    });
    await f.command(
      "source.import",
      { package: pkg, blobs: [] },
      { aggregate: { kind: "sourcePackage", id } }
    );
    await f.command(
      "cast.put",
      {
        id: `role-${id}`,
        name: id,
        language: "ko",
        characterId: `person-${id}`,
        identity: {
          id: `person-${id}`,
          origin: { kind: "source", packageId: id, canonId: "hero" },
        },
      },
      { aggregate: { kind: "cast", id: `role-${id}` } }
    );
    const slot = {
      id: `slot-${id}`,
      scope: { kind: "project", id: "p1" },
      subject: { kind: "identity", id: `person-${id}` },
      appearanceStateRef: "same-state",
    };
    await assetImport(f, `candidate-${id}`, await png(basePixels), slot);
  }
  const snapshot = await adapter(f.directory).capture(),
    one = snapshot.entries.find((e) => e.ref.recordId === "candidate-one")
      .subjects[0].stateRefs[0],
    two = snapshot.entries.find((e) => e.ref.recordId === "candidate-two")
      .subjects[0].stateRefs[0];
  assert.equal(one.recordId, "same-state");
  assert.equal(two.recordId, "same-state");
  assert.notEqual(one.revision, two.revision);
  assert.equal(JSON.parse(one.revision).id, "one");
  assert.equal(JSON.parse(two.revision).id, "two");
});
