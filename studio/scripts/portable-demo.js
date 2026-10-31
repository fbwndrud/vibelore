// Retained current-runtime local-TTS example and genuine offline restore/rerender.
// Requires the existing narrated-demo project; no provider or credential is loaded.
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { openStudio, restoreStudioBackup } from "../src/engine/index.js";
import { createStudioBackup } from "../src/engine/backup.js";
const directory = fileURLToPath(new URL("../local-demo/", import.meta.url)),
  projectId = "night-stop";
const service = await openStudio({
  directory: join(directory, "project"),
  providers: {},
});
const stamp = process.argv[2] ?? randomUUID();
let restored;
async function command(s, type, kind, id, payload) {
  return (
    await s.command({
      projectId,
      commandId: randomUUID(),
      aggregate: { kind, id },
      expectedRevision: s.store.aggregate(projectId, { kind, id }).revision,
      type,
      payload,
    })
  ).value;
}
async function output(s, edition, prefix) {
  const id = `${prefix}-${edition.id}`;
  const result = await command(s, "edition.render", "editionOutput", id, {
    editionId: edition.id,
    renderId: id,
  });
  if (result.status !== "completed") throw Error(JSON.stringify(result));
  await writeFile(
    join(
      directory,
      `${prefix}-${edition.id}.${result.manifest.output.extension}`,
    ),
    await s.readBlob(projectId, result.manifest.output.blobId),
  );
  await writeFile(
    join(directory, `${prefix}-${edition.id}-manifest.json`),
    JSON.stringify(result, null, 2),
  );
  return result;
}
try {
  const editions = [];
  for (const profile of ["landscape", "audio"]) {
    const id = `zz-current-spoken-${profile}-${stamp}`;
    const e = await command(service, "edition.create", "edition", id, {
      id,
      productionId: "spoken",
      profile,
    });
    editions.push(e);
    await writeFile(
      join(directory, `${id}-closure.json`),
      JSON.stringify(e, null, 2),
    );
    console.log("Rendering retained current Edition", profile);
    await output(service, e, "original");
  }
  const saved = await createStudioBackup(
    service,
    projectId,
    `portable-${stamp}`,
  );
  await service.close();
  const restoredDirectory = join(directory, `offline-restored-${stamp}`);
  restored = await restoreStudioBackup({
    archive: join(directory, "project", saved.archive),
    directory: restoredDirectory,
    providers: {},
  });
  const results = [];
  for (const e of editions) {
    console.log("Rendering restored closed Edition", e.closure.profile.id);
    const r = await output(restored, e, "restored");
    results.push({
      editionId: e.id,
      closureDigest: e.closureDigest,
      status: r.status,
      manifestDigest: r.manifestDigest,
      durationSeconds: r.manifest.durationSeconds,
    });
  }
  await writeFile(
    join(directory, `portable-${stamp}-receipt.json`),
    JSON.stringify(
      {
        projectId,
        backup: saved,
        restoredDirectory: `offline-restored-${stamp}`,
        providers: [],
        sourceFolderCopied: false,
        provenance:
          "macOS local TTS imported demo; no human quality or paid-provider verification",
        results,
      },
      null,
      2,
    ),
  );
  console.log("Portable demo complete", stamp);
} finally {
  await service.close();
  await restored?.close();
}
