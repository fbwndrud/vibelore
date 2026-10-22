import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile, access, symlink, rm } from "node:fs/promises";
import {
  withStudio,
  withGeneration,
  generationCommand,
} from "./helpers/project.js";
import { openStudio } from "../src/engine/index.js";
import { runWorker } from "../src/engine/worker.js";

const waitPoint = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function backup(f) {
  const saved = await f.command("project.backup", {});
  return join(f.directory, saved.value.archive);
}

test("portable backup preserves bytes and restores queued execution inert while original worker lives", async (t) => {
  let sends = 0,
    block = false;
  const gate = waitPoint(),
    entered = waitPoint();
  const provider = {
    capabilities: async () => {
      if (block) {
        entered.resolve();
        await gate.promise;
      }
      return { kinds: ["image"], models: ["fake-v1"] };
    },
    generate: async () => {
      sends++;
      throw Error("fixture");
    },
  };
  const f = await withGeneration(t, { providers: { fake: provider } });
  await generationCommand(f);
  block = true;
  const originalWorker = runWorker({ service: f.service, drain: true });
  await entered.promise;
  let archive;
  try {
    archive = await backup(f);
  } catch (e) {
    gate.resolve();
    await originalWorker;
    throw e;
  }
  try {
    const { restoreStudioBackup } = await import("../src/engine/backup.js");
    const restored = await restoreStudioBackup({
      archive,
      directory: join(f.directory, "restored"),
      providers: { fake: provider },
    });
    t.after(() => restored.close());
    await runWorker({ service: restored, drain: true });
    assert.equal(sends, 0);
    const snapshot = await restored.snapshot("p1");
    assert.equal(snapshot.attempts[0].status, "outcome_unknown");
    assert.equal(snapshot.attempts[0].outcomeReason, "restore_boundary");
    assert.equal(snapshot.reservations[0].status, "held_unknown");
    gate.resolve();
    await originalWorker;
    assert.equal(sends, 1);
  } finally {
    gate.resolve();
    await originalWorker;
  }
});

test("backup rejects schema/checksum/path/symlink inventory before destination writes", async (t) => {
  const f = await withStudio(t);
  const raw = await f.service.blobs.put("p1", Buffer.from("private media"));
  const archive = await backup(f);
  const { restoreStudioBackup } = await import("../src/engine/backup.js");
  const manifestPath = join(archive, "manifest.json");
  const original = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const change of [
    (m) => (m.schemaVersion = 999),
    (m) => (m.inventory[0].path = "../escape"),
    (m) => (m.inventory[0].path = "/tmp/escape"),
    (m) => m.inventory.push({ ...m.inventory[0] }),
    (m) => (m.tables.projects[0].id = "other"),
  ]) {
    const m = structuredClone(original);
    change(m);
    const { canonicalDigest } = await import("../src/engine/contracts.js");
    const { digest, ...body } = m;
    m.digest = canonicalDigest(body);
    await writeFile(manifestPath, JSON.stringify(m));
    const target = join(f.directory, "invalid");
    await assert.rejects(restoreStudioBackup({ archive, directory: target }));
    await assert.rejects(access(target));
  }
  await writeFile(manifestPath, JSON.stringify(original));
  const media = join(archive, original.inventory[0].path);
  await writeFile(media, "bad");
  await assert.rejects(
    restoreStudioBackup({ archive, directory: join(f.directory, "bad") }),
  );
  await assert.rejects(access(join(f.directory, "bad")));
  await rm(media);
  await symlink(f.service.blobs.path("p1", raw.blobId), media);
  await assert.rejects(
    restoreStudioBackup({ archive, directory: join(f.directory, "link") }),
  );
  await assert.rejects(access(join(f.directory, "link")));
});

test("durable command staging survives another connection GC across put-await-commit and releases aborted bytes", async (t) => {
  const f = await withStudio(t),
    other = await openStudio({ directory: f.directory });
  t.after(() => other.close());
  const entered = waitPoint(),
    resume = waitPoint();
  let id;
  f.service.registerCommand("fixture.stage", {
    target: () => ({ kind: "project", id: "p1" }),
    async prepare() {
      id = (await f.service.blobs.put("p1", Buffer.from("staged"))).blobId;
      entered.resolve();
      await resume.promise;
      return { blobId: id };
    },
    apply: ({ prepared }) => prepared,
  });
  const work = f.command("fixture.stage", {});
  await entered.promise;
  let first;
  try {
    first = await other.collectGarbage("p1", { graceMs: 0 });
  } catch (e) {
    resume.resolve();
    await work;
    throw e;
  }
  assert.equal(first.deleted.length, 0);
  assert.deepEqual(
    await other.readBlob("p1", id),
    new Uint8Array(Buffer.from("staged")),
  );
  resume.resolve();
  await work;
  assert.equal(
    (await other.collectGarbage("p1", { graceMs: 0 })).deleted.length,
    0,
  );
  const unused = await f.service.blobs.put("p1", Buffer.from("unused"));
  assert.ok(
    (await other.collectGarbage("p1", { graceMs: 0 })).deleted.includes(
      unused.blobId,
    ),
  );
  await assert.rejects(other.readBlob("p1", unused.blobId));
});

test("startup reports missing, corrupt and durably recovered orphan separately; support diagnostics exclude private data", async (t) => {
  const f = await withStudio(t);
  const a = await f.service.blobs.put("p1", Buffer.from("original")),
    b = await f.service.blobs.put("p1", Buffer.from("missing"));
  await writeFile(f.service.blobs.path("p1", a.blobId), "corruption");
  await rm(f.service.blobs.path("p1", b.blobId));
  const c = await f.service.blobs.put("p1", Buffer.from("orphan"));
  f.service.store.write(() =>
    f.service.store.run("DELETE FROM blobs WHERE id=?", c.blobId),
  );
  const other = await openStudio({ directory: f.directory });
  t.after(() => other.close());
  const report = await other.integrity("p1");
  assert.deepEqual(report.corrupt, [a.blobId]);
  assert.deepEqual(report.missing, [b.blobId]);
  assert.deepEqual(report.recovered, [c.blobId]);
  await assert.rejects(other.readBlob("p1", a.blobId), {
    code: "BLOB_CORRUPT",
  });
  const support = await other.supportBundle("p1");
  assert.equal(JSON.stringify(support).includes(f.directory), false);
  assert.equal(JSON.stringify(support).includes("작품"), false);
  assert.equal(JSON.stringify(support).includes("original"), false);
});

test("project backup is isolated, rejects recomputed dangling closure, and preserves archived state across later edits", async (t) => {
  const f = await withStudio(t);
  await f.service.command({
    projectId: "other",
    commandId: "create",
    aggregate: { kind: "project", id: "other" },
    expectedRevision: 0,
    type: "project.create",
    payload: { title: "SECRET_OTHER_TITLE", language: "ko", budgetMicros: 0 },
  });
  const secret = await f.service.blobs.put(
    "other",
    Buffer.from("SECRET_OTHER_MEDIA"),
  );
  const blob = await f.service.blobs.put("p1", Buffer.from("retained"));
  f.service.registerCommand("fixture.reference", {
    target: () => ({ kind: "project", id: "p1" }),
    apply: () => ({ blobId: blob.blobId }),
  });
  await f.command("fixture.reference", {});
  const archive = await backup(f),
    path = join(archive, "manifest.json");
  const m = JSON.parse(await readFile(path, "utf8"));
  assert.equal(JSON.stringify(m).includes("SECRET_OTHER"), false);
  assert.equal(
    m.inventory.some((i) => i.blobId === secret.blobId),
    false,
  );
  const { restoreStudioBackup } = await import("../src/engine/backup.js");
  const restored = await restoreStudioBackup({
    archive,
    directory: join(f.directory, "fresh"),
  });
  t.after(() => restored.close());
  assert.deepEqual(
    await restored.readBlob("p1", blob.blobId),
    new Uint8Array(Buffer.from("retained")),
  );
  await assert.rejects(restored.snapshot("other"), {
    code: "PROJECT_NOT_FOUND",
  });
  await assert.rejects(
    restoreStudioBackup({ archive, directory: join(f.directory, "fresh") }),
    { code: "DESTINATION_EXISTS" },
  );
  m.inventory = [];
  m.tables.blobs = [];
  const { canonicalDigest } = await import("../src/engine/contracts.js");
  const { digest, ...body } = m;
  m.digest = canonicalDigest(body);
  await writeFile(path, JSON.stringify(m));
  await assert.rejects(
    restoreStudioBackup({ archive, directory: join(f.directory, "dangling") }),
    { code: "BACKUP_CLOSURE" },
  );
  await assert.rejects(access(join(f.directory, "dangling")));
});

test("read leases and tombstone grace exclude new readers/writers/references until deletion", async (t) => {
  const f = await withStudio(t),
    other = await openStudio({ directory: f.directory });
  t.after(() => other.close());
  const b = await f.service.blobs.put("p1", Buffer.from("read pin"));
  await f.service.blobs.leases.scope("read", async () => {
    await f.service.readBlob("p1", b.blobId);
    assert.equal(
      (await other.collectGarbage("p1", { graceMs: 0 })).deleted.length,
      0,
    );
  });
  assert.deepEqual(
    (await other.collectGarbage("p1", { graceMs: 60000 })).pending,
    [b.blobId],
  );
  await assert.rejects(f.service.readBlob("p1", b.blobId), {
    code: "BLOB_GC_BUSY",
  });
  await assert.rejects(f.service.blobs.put("p1", Buffer.from("read pin")), {
    code: "BLOB_GC_BUSY",
  });
  f.service.registerCommand("fixture.late", {
    target: () => ({ kind: "project", id: "p1" }),
    apply: () => ({ blobId: b.blobId }),
  });
  await assert.rejects(f.command("fixture.late", {}), {
    code: "BLOB_UNAVAILABLE",
  });
  assert.deepEqual((await other.collectGarbage("p1", { graceMs: 0 })).deleted, [
    b.blobId,
  ]);
});

test("restore of dispatching and unknown attempts keeps inputs and held budget without sends or fake nonbilling evidence", async (t) => {
  const gate = waitPoint(),
    entered = waitPoint();
  let sends = 0;
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ["image"], models: ["fake-v1"] }),
        generate: async () => {
          sends++;
          entered.resolve();
          await gate.promise;
          throw Error("ambiguous");
        },
      },
    },
  });
  const input = await f.service.blobs.put("p1", Buffer.from("reference input"));
  const { validImageRequest } = await import("./helpers/project.js");
  await generationCommand(
    f,
    validImageRequest({
      input: {
        model: "fake-v1",
        prompt: "fixture",
        config: {},
        blobIds: [input.blobId],
      },
    }),
  );
  const running = runWorker({ service: f.service, drain: true });
  await entered.promise;
  try {
    const { restoreStudioBackup } = await import("../src/engine/backup.js");
    for (const state of ["dispatching", "outcome_unknown"]) {
      if (state === "outcome_unknown") {
        gate.resolve();
        await running;
      }
      const archive = await backup(f);
      const restored = await restoreStudioBackup({
        archive,
        directory: join(f.directory, state),
        providers: f.service.providers,
      });
      try {
        await runWorker({ service: restored, drain: true });
        assert.equal(sends, 1);
        const s = await restored.snapshot("p1");
        assert.equal(s.attempts[0].restoreBoundary.previousStatus, state);
        assert.equal(s.reservations[0].status, "held_unknown");
        assert.equal(s.reservations[0].evidence, null);
        await restored.collectGarbage("p1", { graceMs: 0 });
        assert.deepEqual(
          await restored.readBlob("p1", input.blobId),
          new Uint8Array(Buffer.from("reference input")),
        );
      } finally {
        await restored.close();
      }
    }
  } finally {
    gate.resolve();
    await running;
  }
});

test("integrity scan pins registered bytes against concurrent GC before registering status", async (t) => {
  const f = await withStudio(t),
    other = await openStudio({ directory: f.directory });
  t.after(() => other.close());
  const b = await f.service.blobs.put("p1", Buffer.from("scan race"));
  const register = f.service.blobs.register.bind(f.service.blobs);
  let gc;
  f.service.blobs.register = (...args) => {
    if (args[1] === b.blobId && !gc)
      gc = other.collectGarbage("p1", { graceMs: 0 });
    return register(...args);
  };
  await f.service.blobs.recover();
  assert.deepEqual((await gc).deleted, []);
  assert.deepEqual(
    await f.service.readBlob("p1", b.blobId),
    new Uint8Array(Buffer.from("scan race")),
  );
});

test("orphan recovery refuses registry publication if leaf fsync fails", async (t) => {
  const f = await withStudio(t);
  const b = await f.service.blobs.put("p1", Buffer.from("orphan durability"));
  f.service.store.write(() =>
    f.service.store.run("DELETE FROM blobs WHERE id=?", b.blobId),
  );
  const sync = f.service.blobs.syncDirectory.bind(f.service.blobs);
  f.service.blobs.syncDirectory = async (path) => {
    if (path === join(f.directory, "blobs", "p1"))
      throw Object.assign(Error("fixture disk failure"), { code: "EIO" });
    return sync(path);
  };
  await assert.rejects(f.service.blobs.recover());
  assert.equal(
    f.service.store.get("SELECT id FROM blobs WHERE id=?", b.blobId),
    undefined,
  );
  f.service.blobs.syncDirectory = sync;
  await f.service.blobs.recover();
  assert.deepEqual(
    await f.service.readBlob("p1", b.blobId),
    new Uint8Array(Buffer.from("orphan durability")),
  );
});

test("malformed rows with a valid manifest digest fail preflight without transient destination creation", async (t) => {
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ["image"], models: ["fake-v1"] }),
      },
    },
  });
  await generationCommand(f);
  const archive = await backup(f),
    path = join(archive, "manifest.json"),
    original = JSON.parse(await readFile(path, "utf8"));
  const { watch } = await import("node:fs"),
    { setTimeout: delay } = await import("node:timers/promises");
  const { canonicalDigest } = await import("../src/engine/contracts.js"),
    { restoreStudioBackup } = await import("../src/engine/backup.js");
  const seen = [];
  const watcher = watch(f.directory, (_, name) => seen.push(name));
  t.after(() => watcher.close());
  for (const mutate of [
    (m) =>
      m.tables.generation_jobs.push({
        ...m.tables.generation_jobs[0],
        id: "duplicateIntent",
      }),
    (m) => (m.tables.generation_outbox[0].attempt_id = null),
    (m) => (m.tables.aggregates[0].revision = 0),
    (m) => (m.tables.generation_attempts[0].data_json = "{}"),
    (m) => (m.tables.generation_attempts[0].status = "succeeded"),
    (m) => (m.tables.generation_outbox[0].status = "invalid"),
  ]) {
    const m = structuredClone(original);
    mutate(m);
    const { digest, ...body } = m;
    m.digest = canonicalDigest(body);
    await writeFile(path, JSON.stringify(m));
    await assert.rejects(
      restoreStudioBackup({
        archive,
        directory: join(f.directory, "never-created"),
      }),
    );
  }
  await delay(30);
  assert.equal(seen.includes("never-created"), false);
});

test("killed staging owner releases only orphan pins on a fresh connection", async (t) => {
  const f = await withStudio(t);
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {openStudio} from ${JSON.stringify(new URL("../src/engine/index.js", import.meta.url).href)}; const s=await openStudio({directory:process.argv[1]});await s.blobs.leases.scope('staging',async()=>{const b=await s.blobs.put('p1',Buffer.from('crash staging'));console.log(b.blobId);await new Promise(()=>{setInterval(()=>{},1000);});});`,
      f.directory,
    ],
    { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  const blobId = await new Promise((resolve, reject) => {
    child.stdout.on("data", (b) => {
      output += b;
      if (output.includes("\n")) resolve(output.trim());
    });
    child.once("error", reject);
    child.once("exit", () => reject(Error("child exited before staged bytes")));
  });
  assert.deepEqual(
    (await f.service.collectGarbage("p1", { graceMs: 0 })).deleted,
    [],
  );
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const reopened = await openStudio({ directory: f.directory });
  try {
    assert.deepEqual(
      (await reopened.collectGarbage("p1", { graceMs: 0 })).deleted,
      [blobId],
    );
  } finally {
    await reopened.close();
  }
});

test("backup pins a consistent database view while another service edits and collects", async (t) => {
  const f = await withStudio(t),
    other = await openStudio({ directory: f.directory });
  t.after(() => other.close());
  const b = await f.service.blobs.put("p1", Buffer.from("backup race"));
  const read = f.service.blobs.read.bind(f.service.blobs);
  let checked = false;
  f.service.blobs.read = async (...args) => {
    if (!checked) {
      checked = true;
      assert.deepEqual(
        (await other.collectGarbage("p1", { graceMs: 0 })).deleted,
        [],
      );
      await other.command({
        projectId: "p1",
        commandId: "concurrent-production",
        aggregate: { kind: "production", id: "later" },
        expectedRevision: 0,
        type: "production.create",
        payload: {
          id: "later",
          title: "After snapshot",
          sourcePackageId: null,
        },
      });
    }
    return read(...args);
  };
  const archive = await backup(f);
  const { restoreStudioBackup } = await import("../src/engine/backup.js");
  const restored = await restoreStudioBackup({
    archive,
    directory: join(f.directory, "snapshot"),
  });
  try {
    assert.deepEqual((await restored.snapshot("p1")).productions, []);
    assert.deepEqual(
      await restored.readBlob("p1", b.blobId),
      new Uint8Array(Buffer.from("backup race")),
    );
  } finally {
    await restored.close();
  }
  assert.equal((await other.snapshot("p1")).productions.length, 1);
});

test("startup retains corrupt pending raw output for diagnosis without resending or losing integrity report", async (t) => {
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ["image"], models: ["fake-v1"] }),
      },
    },
  });
  await generationCommand(f);
  const { retainPendingOutput } = await import("./helpers/project.js");
  const { png, basePixels } = await import("./helpers/images.js");
  const a = await retainPendingOutput(f, await png(basePixels));
  await writeFile(f.service.blobs.path("p1", a.outputs[0].blobId), "bad raw");
  await f.service.close();
  const reopened = await openStudio({ directory: f.directory });
  try {
    assert.deepEqual((await reopened.integrity("p1")).corrupt, [
      a.outputs[0].blobId,
    ]);
    assert.equal(
      (await reopened.snapshot("p1")).attempts[0].status,
      "succeeded",
    );
    assert.equal((await reopened.snapshot("p1")).candidates.length, 0);
  } finally {
    await reopened.close();
  }
});

test("portable backup preserves definite cancelled history without converting it to unknown liability", async (t) => {
  const f = await withGeneration(t);
  await generationCommand(f);
  const job = (await f.service.snapshot("p1")).jobs[0];
  await f.command(
    "job.cancel",
    { jobId: job.id },
    { aggregate: { kind: "job", id: job.id } },
  );
  const archive = await backup(f);
  const { restoreStudioBackup } = await import("../src/engine/backup.js");
  const s = await restoreStudioBackup({
    archive,
    directory: join(f.directory, "cancelled"),
  });
  try {
    const snapshot = await s.snapshot("p1");
    assert.equal(snapshot.attempts[0].status, "cancelled_before_dispatch");
    assert.equal(snapshot.reservations[0].status, "released");
  } finally {
    await s.close();
  }
});

test("restored history does not advertise original-machine backup folders as available archives", async (t) => {
  const f = await withStudio(t);
  await backup(f);
  const archive = await backup(f);
  const { restoreStudioBackup } = await import("../src/engine/backup.js");
  const s = await restoreStudioBackup({
    archive,
    directory: join(f.directory, "receipt-history"),
  });
  try {
    const snapshot = await s.snapshot("p1");
    assert.equal(snapshot.backups.length, 1);
    assert.equal(snapshot.backups[0].available, false);
    assert.equal((await f.service.snapshot("p1")).backups[0].available, true);
  } finally {
    await s.close();
  }
});

test("command lease classification does not evaluate an unvalidated type getter", async (t) => {
  const f = await withStudio(t);
  let calls = 0;
  const envelope = {
    projectId: "p1",
    commandId: "unsafe-getter",
    aggregate: { kind: "project", id: "p1" },
    expectedRevision: 1,
    payload: {},
  };
  Object.defineProperty(envelope, "type", {
    enumerable: true,
    get() {
      calls++;
      return "edition.render";
    },
  });
  await assert.rejects(f.service.command(envelope), { code: "INVALID_INPUT" });
  assert.equal(calls, 0);
});

test("real worker decoder canonical staging survives GC on another service before candidate commit", async (t) => {
  const sharp = (await import("sharp")).default;
  const raw = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 2, g: 3, b: 4, alpha: 1 },
    },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ["image"], models: ["fake-v1"] }),
        generate: async () => ({
          outputs: [{ bytes: raw, mime: "image/png" }],
        }),
      },
    },
  });
  await generationCommand(f);
  const other = await openStudio({ directory: f.directory });
  t.after(() => other.close());
  const entered = waitPoint(),
    resume = waitPoint(),
    put = f.service.blobs.put.bind(f.service.blobs);
  let calls = 0,
    canonical;
  f.service.blobs.put = async (...args) => {
    const result = await put(...args);
    if (++calls === 2) {
      canonical = result.blobId;
      entered.resolve();
      await resume.promise;
    }
    return result;
  };
  const work = runWorker({ service: f.service, drain: true });
  await entered.promise;
  try {
    assert.deepEqual(
      (await other.collectGarbage("p1", { graceMs: 0 })).deleted,
      [],
    );
  } finally {
    resume.resolve();
    await work;
  }
  const snapshot = await other.snapshot("p1");
  assert.equal(snapshot.candidates[0].canonicalBlobId, canonical);
  assert.notEqual(snapshot.candidates[0].rawBlobId, canonical);
  await other.readBlob("p1", canonical);
});

async function rejectRechecksummedArchiveBeforeCreate(
  t,
  f,
  archive,
  mutate,
  name,
) {
  const { canonicalDigest } = await import("../src/engine/contracts.js");
  const { restoreStudioBackup } = await import("../src/engine/index.js");
  const { watch } = await import("node:fs");
  const { setTimeout: delay } = await import("node:timers/promises");
  const path = join(archive, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  mutate(manifest);
  const { digest, ...body } = manifest;
  manifest.digest = canonicalDigest(body);
  await writeFile(path, JSON.stringify(manifest));
  const seen = [];
  const watcher = watch(f.directory, (_, entry) => seen.push(entry));
  t.after(() => watcher.close());
  let restored, error;
  try {
    restored = await restoreStudioBackup({
      archive,
      directory: join(f.directory, name),
    });
  } catch (e) {
    error = e;
  } finally {
    await restored?.close();
  }
  await delay(30);
  assert.deepEqual(
    { code: error?.code, destinationObserved: seen.includes(name) },
    { code: "BACKUP_INVALID", destinationObserved: false },
  );
  await assert.rejects(access(join(f.directory, name)), { code: "ENOENT" });
}

test("portable execution graph rejects a current attempt owned by another job before destination creation", async (t) => {
  const { validImageRequest } = await import("./helpers/project.js");
  const { restoreStudioBackup } = await import("../src/engine/index.js");
  const f = await withGeneration(t);
  await generationCommand(f);
  await generationCommand(
    f,
    validImageRequest({
      input: { model: "fake-v1", prompt: "A different green room", config: {} },
    }),
  );
  const archive = await backup(f);
  const baseline = await restoreStudioBackup({
    archive,
    directory: join(f.directory, "valid-graph"),
  });
  assert.equal((await baseline.snapshot("p1")).attempts.length, 2);
  await baseline.close();
  await rejectRechecksummedArchiveBeforeCreate(
    t,
    f,
    archive,
    (m) => {
      const jobs = m.tables.generation_jobs;
      const first = JSON.parse(jobs[0].data_json),
        second = JSON.parse(jobs[1].data_json);
      first.currentAttemptId = second.currentAttemptId;
      jobs[0].data_json = JSON.stringify(first);
    },
    "cross-job-never-created",
  );
});

test("portable execution graph requires reservations while preserving legitimate execution and billing history", async (t) => {
  for (const history of [
    "prepared",
    "cancelled-released",
    "succeeded-settled",
    "unknown-settled",
    "unknown-held",
  ])
    await t.test(history, async (t) => {
      const { restoreStudioBackup } = await import("../src/engine/index.js");
      const { png, basePixels } = await import("./helpers/images.js");
      const f = await withGeneration(t);
      await generationCommand(f);
      if (history === "cancelled-released") {
        const job = (await f.service.snapshot("p1")).jobs[0];
        await f.command(
          "job.cancel",
          { jobId: job.id },
          { aggregate: { kind: "job", id: job.id } },
        );
      } else if (history !== "prepared") {
        const bytes = await png(basePixels);
        await runWorker({
          service: f.service,
          drain: true,
          providers: {
            fake: {
              capabilities: () => ({ kinds: ["image"], models: ["fake-v1"] }),
              generate: async () => {
                if (history.startsWith("unknown"))
                  throw Error("fixture ambiguous send");
                return { outputs: [{ bytes, mime: "image/png" }] };
              },
            },
          },
        });
        if (history.endsWith("settled")) {
          const a = (await f.service.snapshot("p1")).attempts[0];
          await f.command(
            "attempt.reconcile",
            {
              attemptId: a.id,
              action: "billing",
              evidence: {
                kind: "verified_actual",
                amountMicros: 80000,
                reference: "fixture-invoice",
                actor: "fixture-owner",
              },
            },
            { aggregate: { kind: "attempt", id: a.id } },
          );
        }
      }
      const before = await f.service.snapshot("p1");
      const expectedHistory = {
        prepared: ["prepared", "reserved"],
        "cancelled-released": ["cancelled_before_dispatch", "released"],
        "succeeded-settled": ["succeeded", "settled"],
        "unknown-settled": ["outcome_unknown", "settled"],
        "unknown-held": ["outcome_unknown", "held_unknown"],
      };
      assert.deepEqual(
        [before.attempts[0].status, before.reservations[0].status],
        expectedHistory[history],
      );
      const archive = await backup(f);
      const baseline = await restoreStudioBackup({
        archive,
        directory: join(f.directory, "valid-history"),
      });
      try {
        const after = await baseline.snapshot("p1");
        const expectedStatus =
          history === "prepared"
            ? "held_unknown"
            : before.reservations[0].status;
        assert.equal(after.reservations[0].status, expectedStatus);
        assert.equal(
          after.reservations[0].settledMicros,
          before.reservations[0].settledMicros,
        );
        assert.deepEqual(
          after.reservations[0].evidence,
          before.reservations[0].evidence,
        );
        assert.equal(
          after.attempts[0].status,
          history === "prepared"
            ? "outcome_unknown"
            : before.attempts[0].status,
        );
      } finally {
        await baseline.close();
      }
      await rejectRechecksummedArchiveBeforeCreate(
        t,
        f,
        archive,
        (m) => {
          m.tables.budget_reservations = [];
        },
        "missing-budget-never-created",
      );
    });
});
