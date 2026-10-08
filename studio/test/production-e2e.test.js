import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { videoFixture } from "./helpers/render-fixture.js";
import { restoreStudioBackup } from "../src/engine/backup.js";
import { decodeWav } from "../src/assets/audio-import.js";

test("portable production restores closed source and Editions, then actually renders video/audio without source folders or providers", async (t) => {
  const f = await videoFixture(t),
    source = join(f.directory, "source-original");
  await mkdir(source);
  await writeFile(
    join(source, "chapter.txt"),
    "원작은 지워져도 이 판본에 보존됩니다.",
  );
  await f.command(
    "source.manuscript",
    {
      id: "source1",
      title: "Retained original",
      language: "ko",
      bytes: [...(await readFile(join(source, "chapter.txt")))],
    },
    { aggregate: { kind: "sourcePackage", id: "source1" } },
  );
  const editions = [];
  for (const profile of ["landscape", "audio"])
    editions.push(
      (
        await f.command(
          "edition.create",
          { id: profile, productionId: "main", profile, fps: 30 },
          { aggregate: { kind: "edition", id: profile } },
        )
      ).value,
    );
  const archive = (await f.command("project.backup", {})).value.archive;
  await f.service.close();
  await rm(source, { recursive: true });
  const restored = await restoreStudioBackup({
    archive: join(f.directory, archive),
    directory: join(f.directory, "offline"),
    providers: {},
    renderer: async (args) => {
      const { renderEdition } = await import("../src/render/renderer.js");
      try {
        return await renderEdition(args);
      } catch (error) {
        t.diagnostic(
          `Local renderer failure: ${error.code ?? "unclassified"} ${error.message}`,
        );
        throw error;
      }
    },
  });
  t.after(() => restored.close());
  const s = await restored.snapshot("p1");
  assert.equal(
    s.sourcePackages[0].textUnits[0].text,
    "원작은 지워져도 이 판본에 보존됩니다.",
  );
  assert.deepEqual(
    s.editions.map((e) => e.closureDigest).sort(),
    editions.map((e) => e.closureDigest).sort(),
  );
  for (const edition of editions) {
    const result = await restored.command({
      projectId: "p1",
      commandId: randomUUID(),
      aggregate: { kind: "editionOutput", id: edition.id },
      expectedRevision: 0,
      type: "edition.render",
      payload: { editionId: edition.id, renderId: edition.id },
    });
    assert.equal(
      result.value.status,
      "completed",
      JSON.stringify(result.value),
    );
    const bytes = await restored.readBlob(
      "p1",
      result.value.manifest.output.blobId,
    );
    if (edition.id === "audio")
      assert.equal(decodeWav(bytes).metadata.frameCount, 240000);
    else {
      assert.equal(result.value.manifest.output.mime, "video/mp4");
      assert.ok(bytes.length > 1000);
      assert.ok(result.value.manifest.frames.length > 0);
    }
  }
});
