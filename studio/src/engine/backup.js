import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, lstat, readdir, rm } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { retainedTables } from "./recovery.js";
import { blobReferences } from "../render/closure.js";
import {
  assertId,
  assertInteger,
  BLOB_ID,
  canonicalDigest,
  canonicalJSON,
  fail,
  publicError,
} from "./contracts.js";
import { saveAttempt, saveJob, getJob } from "./jobs.js";
import { holdUnknown } from "./budget.js";

const columns = {
  projects: "id title language budget_micros",
  productions: "project_id id title source_package_id",
  aggregates: "project_id kind id revision data_json",
  commands: "project_id id digest result_json",
  events:
    "cursor project_id command_id aggregate_kind aggregate_id aggregate_revision type value_json",
  blobs: "project_id id byte_length status",
  source_changes: "project_id id production_id data_json",
  generation_jobs: "project_id id intent_key data_json",
  generation_attempts: "project_id id job_id status fence data_json",
  generation_outbox: "project_id attempt_id status",
  budget_reservations:
    "project_id attempt_id status estimate_micros settled_micros amount_kind evidence_json",
  generation_candidates: "project_id id attempt_id data_json",
  asset_quarantines: "project_id id data_json",
  asset_adoptions: "project_id id data_json",
};
const hash = (b) => createHash("sha256").update(b).digest("hex");
const numeric = new Set([
  "budget_micros",
  "revision",
  "cursor",
  "aggregate_revision",
  "byte_length",
  "fence",
  "estimate_micros",
  "settled_micros",
]);
const nullable = new Set([
  "source_package_id",
  "attempt_id",
  "settled_micros",
  "amount_kind",
  "evidence_json",
]);
function exactKeys(value, keys) {
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    fail("BACKUP_INVALID", "Backup structure is invalid.");
}
async function noSymlinkPath(path) {
  if ((await lstat(path)).isSymbolicLink())
    fail("BACKUP_INVALID", "Symbolic links are not portable backup entries.");
}
async function safeRead(path) {
  await noSymlinkPath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile())
      fail("BACKUP_INVALID", "Expected a regular backup file.");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
async function syncDirectory(path) {
  const f = await open(path, "r");
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
async function durableFile(path, bytes) {
  const f = await open(path, "wx", 0o600);
  try {
    await f.writeFile(bytes);
    await f.sync();
  } finally {
    await f.close();
  }
}
function validateManifest(m) {
  exactKeys(m, [
    "format",
    "formatVersion",
    "schemaVersion",
    "projectId",
    "tables",
    "inventory",
    "digest",
  ]);
  if (
    m.format !== "lore-studio-backup" ||
    m.formatVersion !== 1 ||
    m.schemaVersion !== 1
  )
    fail("SCHEMA_UNSUPPORTED", "Unsupported portable backup version.");
  assertId(m.projectId);
  const { digest, ...body } = m;
  if (!BLOB_ID.test(digest) || canonicalDigest(body) !== digest)
    fail("BACKUP_CHECKSUM", "Backup manifest checksum differs.");
  exactKeys(m.tables, retainedTables);
  const keys = new Map();
  for (const table of retainedTables) {
    const rows = m.tables[table];
    if (!Array.isArray(rows))
      fail("BACKUP_INVALID", "Invalid table inventory.");
    const seen = new Set();
    keys.set(table, seen);
    for (const row of rows) {
      exactKeys(row, columns[table].split(" "));
      for (const [k, v] of Object.entries(row)) {
        if (
          v === null &&
          nullable.has(k) &&
          (k !== "attempt_id" || table === "generation_candidates")
        )
          continue;
        if (numeric.has(k)) {
          assertInteger(v);
          if (["revision", "cursor"].includes(k) && v === 0)
            fail("BACKUP_INVALID", "Invalid revision or cursor.");
        } else if (typeof v !== "string")
          fail("BACKUP_INVALID", "Invalid table field.");
        if (k.endsWith("_json") && v !== null) canonicalJSON(JSON.parse(v));
      }
      if ((table === "projects" ? row.id : row.project_id) !== m.projectId)
        fail("BACKUP_INVALID", "Backup contains another project.");
      if (row.id && table !== "blobs") assertId(row.id);
      const key =
        table === "aggregates"
          ? `${row.kind}/${row.id}`
          : table === "events"
            ? row.cursor
            : (row.id ?? row.attempt_id);
      if (seen.has(key)) fail("BACKUP_INVALID", "Duplicate table row.");
      seen.add(key);
    }
  }
  for (const row of m.tables.generation_attempts) {
    const a = JSON.parse(row.data_json);
    if (
      !a ||
      a.id !== row.id ||
      a.jobId !== row.job_id ||
      a.status !== row.status ||
      a.fence !== row.fence ||
      !a.request ||
      typeof a.request !== "object" ||
      !BLOB_ID.test(a.requestDigest) ||
      ![
        "prepared",
        "dispatching",
        "outcome_unknown",
        "succeeded",
        "failed_definite",
        "cancelled_before_dispatch",
      ].includes(a.status)
    )
      fail("BACKUP_INVALID", "Attempt row and retained record disagree.");
    if (
      a.status === "succeeded" &&
      (!Array.isArray(a.outputs) || !a.outputs.length)
    )
      fail("BACKUP_INVALID", "Completed raw output inventory is missing.");
  }
  const attemptOwners = new Map(
    m.tables.generation_attempts.map((row) => [row.id, row.job_id]),
  );
  for (const row of m.tables.generation_attempts)
    if (!keys.get("budget_reservations").has(row.id))
      fail("BACKUP_INVALID", "Retained attempt has no budget reservation.");
  for (const row of m.tables.generation_jobs) {
    const job = JSON.parse(row.data_json);
    if (
      !job ||
      job.id !== row.id ||
      !Array.isArray(job.subscribers) ||
      !job.request ||
      typeof job.request !== "object" ||
      attemptOwners.get(job.currentAttemptId) !== row.id
    )
      fail("BACKUP_INVALID", "Invalid retained generation job.");
  }
  for (const row of m.tables.generation_outbox)
    if (!["queued", "dispatched", "done"].includes(row.status))
      fail("BACKUP_INVALID", "Invalid outbox state.");
  for (const row of m.tables.budget_reservations)
    if (
      !["reserved", "held_unknown", "released", "settled"].includes(row.status)
    )
      fail("BACKUP_INVALID", "Invalid reservation state.");
  for (const row of m.tables.aggregates) {
    const value = JSON.parse(row.data_json);
    if (
      row.kind === "edition" &&
      (!value?.closure ||
        canonicalDigest(value.closure) !== value.closureDigest)
    )
      fail("BACKUP_CLOSURE", "Edition closure digest differs.");
    if (
      row.kind === "editionOutput" &&
      value?.status === "completed" &&
      (!value.manifest ||
        canonicalDigest(value.manifest) !== value.manifestDigest)
    )
      fail("BACKUP_CLOSURE", "Edition output manifest differs.");
  }
  if (m.tables.projects.length !== 1)
    fail("BACKUP_INVALID", "Expected one project.");
  if (
    new Set(m.tables.generation_jobs.map((r) => r.intent_key)).size !==
    m.tables.generation_jobs.length
  )
    fail("BACKUP_INVALID", "Duplicate generation intent.");
  const has = (table, id) => id === null || keys.get(table).has(id);
  for (const row of m.tables.generation_attempts)
    if (!has("generation_jobs", row.job_id))
      fail("BACKUP_INVALID", "Missing job.");
  for (const table of [
    "generation_outbox",
    "budget_reservations",
    "generation_candidates",
  ])
    for (const row of m.tables[table])
      if (!has("generation_attempts", row.attempt_id))
        fail("BACKUP_INVALID", "Missing attempt.");
  if (
    !Array.isArray(m.inventory) ||
    m.inventory.length !== m.tables.blobs.length
  )
    fail("BACKUP_INVALID", "Incomplete blob inventory.");
  const inventory = new Map();
  for (const item of m.inventory) {
    exactKeys(item, ["blobId", "byteLength", "path"]);
    assertInteger(item.byteLength);
    if (
      !BLOB_ID.test(item.blobId) ||
      item.path !== `blobs/${item.blobId}` ||
      inventory.has(item.blobId)
    )
      fail("BACKUP_INVALID", "Unsafe or duplicate blob entry.");
    inventory.set(item.blobId, item);
  }
  for (const row of m.tables.blobs)
    if (
      row.status !== "available" ||
      inventory.get(row.id)?.byteLength !== row.byte_length
    )
      fail("BACKUP_INVALID", "Invalid blob registry.");
  for (const table of retainedTables)
    for (const row of m.tables[table])
      for (const [k, v] of Object.entries(row))
        if (k.endsWith("_json") && v)
          for (const id of blobReferences(JSON.parse(v)))
            if (!inventory.has(id))
              fail("BACKUP_CLOSURE", "Referenced blob is missing from backup.");
  return m;
}
export async function verifyInventory(archive) {
  try {
    await noSymlinkPath(archive);
    const entries = await readdir(archive, { withFileTypes: true });
    if (
      entries.some((e) => e.isSymbolicLink()) ||
      entries
        .map((e) => e.name)
        .sort()
        .join() !== "blobs,manifest.json"
    )
      fail("BACKUP_INVALID", "Unexpected backup entries.");
    const manifest = validateManifest(
      JSON.parse(
        (await safeRead(join(archive, "manifest.json"))).toString("utf8"),
      ),
    );
    await noSymlinkPath(join(archive, "blobs"));
    const listed = await readdir(join(archive, "blobs"), {
      withFileTypes: true,
    });
    if (
      listed.length !== manifest.inventory.length ||
      listed.some(
        (e) =>
          !e.isFile() || !manifest.inventory.some((i) => i.blobId === e.name),
      )
    )
      fail("BACKUP_INVALID", "Unexpected blob entries.");
    const bytes = new Map();
    for (const item of manifest.inventory) {
      const data = await safeRead(join(archive, item.path));
      if (data.length !== item.byteLength || hash(data) !== item.blobId)
        fail("BACKUP_CHECKSUM", "Backup blob checksum differs.");
      bytes.set(item.blobId, data);
    }
    return { manifest, bytes };
  } catch (e) {
    throw publicError(e, "BACKUP_INVALID");
  }
}
export async function createStudioBackup(
  service,
  projectId,
  backupId = randomUUID(),
) {
  assertId(backupId);
  const { store, blobs } = service;
  return blobs.leases.scope("backup", async () => {
    // Pins and logical table rows are captured under the same SQLite view.
    const tables = store.write(() => {
      store.requireProject(projectId);
      const tables = Object.fromEntries(
        retainedTables.map((table) => [
          table,
          store
            .all(
              `SELECT * FROM ${table} WHERE ${table === "projects" ? "id" : "project_id"}=?`,
              projectId,
            )
            .map((r) => ({ ...r })),
        ]),
      );
      const owner = blobs.leases.context.getStore();
      for (const b of tables.blobs) {
        if (
          b.status !== "available" ||
          store.get(
            "SELECT 1 FROM blob_tombstones WHERE project_id=? AND blob_id=?",
            projectId,
            b.id,
          )
        )
          fail("BACKUP_CLOSURE", "Project has unavailable bytes.");
        store.run(
          "INSERT OR IGNORE INTO blob_leases VALUES(?,?,?,?,?)",
          owner.id,
          owner.fence,
          projectId,
          b.id,
          "backup",
        );
      }
      return tables;
    });
    const inventory = tables.blobs.map((b) => ({
      blobId: b.id,
      byteLength: b.byte_length,
      path: `blobs/${b.id}`,
    }));
    const body = {
      format: "lore-studio-backup",
      formatVersion: 1,
      schemaVersion: 1,
      projectId,
      tables,
      inventory,
    };
    const manifest = { ...body, digest: canonicalDigest(body) };
    validateManifest(manifest);
    const parent = join(blobs.storageDirectory, "backups");
    await mkdir(parent, { recursive: true });
    const archive = join(parent, backupId);
    await mkdir(archive);
    await mkdir(join(archive, "blobs"));
    try {
      for (const item of inventory)
        await durableFile(
          join(archive, item.path),
          await blobs.read(projectId, item.blobId),
        );
      await syncDirectory(join(archive, "blobs"));
      await durableFile(
        join(archive, "manifest.json"),
        canonicalJSON(manifest),
      );
      await syncDirectory(archive);
      await syncDirectory(parent);
      await syncDirectory(blobs.storageDirectory);
      return {
        backupId,
        archive: `backups/${backupId}`,
        projectId,
        blobCount: inventory.length,
        digest: manifest.digest,
      };
    } catch (e) {
      await rm(archive, { recursive: true, force: true });
      throw e;
    }
  });
}
export async function restoreIntoNewDirectory(
  bundle,
  directory,
  { providers = {}, renderer = null } = {},
) {
  // The public entry point validates all bytes before creating the destination.
  const { manifest, bytes } = bundle;
  validateManifest(manifest);
  for (const i of manifest.inventory)
    if (
      !bytes.has(i.blobId) ||
      bytes.get(i.blobId).length !== i.byteLength ||
      hash(bytes.get(i.blobId)) !== i.blobId
    )
      fail("BACKUP_CHECKSUM", "Backup bytes differ.");
  await noSymlinkPath(dirname(resolve(directory)));
  try {
    await lstat(directory);
    fail("DESTINATION_EXISTS", "Restore requires a new directory.");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await mkdir(directory);
  let service;
  try {
    const { openStudio } = await import("./index.js");
    service = await openStudio({ directory, providers: {}, renderer });
    service.store.write(() => {
      for (const table of retainedTables) {
        const cols = columns[table].split(" ");
        for (const row of manifest.tables[table])
          service.store.run(
            `INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`,
            ...cols.map((k) => row[k]),
          );
      }
      for (const row of service.store.all(
        "SELECT data_json FROM generation_attempts WHERE status IN ('prepared','dispatching','outcome_unknown')",
      )) {
        const a = JSON.parse(row.data_json);
        a.restoreBoundary = {
          previousStatus: a.status,
          previousWorkerId: a.workerId ?? null,
        };
        a.status = "outcome_unknown";
        a.outcomeReason = "restore_boundary";
        a.workerId = null;
        a.fence++;
        saveAttempt(service.store, manifest.projectId, a);
        holdUnknown(service.store, manifest.projectId, a.id);
        service.store.run(
          "UPDATE generation_outbox SET status='done' WHERE project_id=? AND attempt_id=?",
          manifest.projectId,
          a.id,
        );
        const job = getJob(service.store, manifest.projectId, a.jobId);
        if (job.currentAttemptId === a.id) {
          job.status = "outcome_unknown";
          job.outcomeReason = "restore_boundary";
          saveJob(service.store, manifest.projectId, job);
        }
      }
    });
    for (const item of manifest.inventory)
      await service.blobs.put(manifest.projectId, bytes.get(item.blobId));
    await service.close();
    service = null;
    await syncDirectory(directory);
    await syncDirectory(dirname(resolve(directory)));
    return await openStudio({ directory, providers, renderer });
  } catch (e) {
    if (service) await service.close();
    await rm(directory, { recursive: true, force: true });
    throw publicError(e, "RESTORE_FAILED");
  }
}
export async function restoreStudioBackup({
  archive,
  directory,
  providers = {},
  renderer = null,
}) {
  return restoreIntoNewDirectory(await verifyInventory(archive), directory, {
    providers,
    renderer,
  });
}
export function registerBackupCommands(service) {
  service.registerCommand("project.backup", {
    target: ({ envelope }) => ({ kind: "project", id: envelope.projectId }),
    prepare: ({ envelope }) =>
      createStudioBackup(service, envelope.projectId, envelope.commandId),
    apply: ({ prepared }) => prepared,
  });
  service.registerCommand("project.restore", {
    target: ({ envelope }) => ({ kind: "project", id: envelope.projectId }),
    async prepare({ envelope }) {
      const { backupId, restoreId } = envelope.payload;
      assertId(backupId);
      assertId(restoreId);
      const parent = join(service.blobs.storageDirectory, "restores");
      const bundle = await verifyInventory(
        join(service.blobs.storageDirectory, "backups", backupId),
      );
      if (bundle.manifest.projectId !== envelope.projectId)
        fail("BACKUP_INVALID", "Backup belongs to another project.");
      await mkdir(parent, { recursive: true });
      const restored = await restoreIntoNewDirectory(
        bundle,
        join(parent, restoreId),
      );
      await restored.close();
      return {
        directory: `restores/${restoreId}`,
        projectId: envelope.projectId,
        execution: "held_at_restore_boundary",
      };
    },
    apply: ({ prepared }) => prepared,
  });
}

// Historical receipts remain immutable; a portable project does not copy nested archives.
export function localBackupReceipts(store, directory, projectId, type) {
  return store
    .all(
      "SELECT value_json FROM events WHERE project_id=? AND type=? ORDER BY cursor",
      projectId,
      type,
    )
    .map((row) => {
      const receipt = JSON.parse(row.value_json);
      const relative =
        type === "project.backup" ? receipt.archive : receipt.directory;
      const prefix = type === "project.backup" ? "backups" : "restores";
      const safe =
        typeof relative === "string" &&
        new RegExp(`^${prefix}/[A-Za-z0-9_-]{1,120}$`).test(relative);
      return {
        ...receipt,
        available:
          safe &&
          existsSync(
            join(
              directory,
              relative,
              type === "project.backup" ? "manifest.json" : "studio.sqlite",
            ),
          ),
      };
    });
}
