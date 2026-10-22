import { unlinkSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";
import { blobReferences } from "../render/closure.js";
import { assertInteger } from "./contracts.js";

export const retainedTables = [
  "projects",
  "productions",
  "aggregates",
  "commands",
  "events",
  "blobs",
  "source_changes",
  "generation_jobs",
  "generation_attempts",
  "generation_outbox",
  "budget_reservations",
  "generation_candidates",
  "asset_quarantines",
  "asset_adoptions",
  "reuse_imports",
];
export function retainedReferences(store, projectId) {
  const ids = new Set();
  for (const table of retainedTables) {
    if (
      !store.get(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        table,
      )
    )
      continue;
    for (const row of store.all(
      `SELECT * FROM ${table} WHERE ${table === "projects" ? "id" : "project_id"}=?`,
      projectId,
    ))
      for (const [key, value] of Object.entries(row))
        if (key.endsWith("_json") && value)
          blobReferences(JSON.parse(value), ids);
  }
  return ids;
}
export function collectGarbage(
  blobs,
  projectId,
  { graceMs = 60000, recoverOnly = false } = {},
) {
  const { store, leases } = blobs;
  store.requireProject(projectId);
  assertInteger(graceMs);
  leases.recover();
  if (!recoverOnly)
    store.write(() => {
      const refs = retainedReferences(store, projectId);
      for (const row of store.all(
        "SELECT id FROM blobs WHERE project_id=?",
        projectId,
      ))
        if (
          !refs.has(row.id) &&
          !store.get(
            "SELECT 1 FROM blob_leases WHERE project_id=? AND blob_id=?",
            projectId,
            row.id,
          )
        )
          store.run(
            "INSERT OR IGNORE INTO blob_tombstones VALUES(?,?,?)",
            projectId,
            row.id,
            Date.now(),
          );
    });
  const deleted = [];
  // Unlink and leaf fsync are synchronous inside the final authority transaction.
  // Tombstones already committed survive a crash and exclude new pins until retry completes.
  store.write(() => {
    const refs = retainedReferences(store, projectId);
    for (const row of store.all(
      "SELECT * FROM blob_tombstones WHERE project_id=? AND marked_at<=?",
      projectId,
      Date.now() - graceMs,
    )) {
      if (
        refs.has(row.blob_id) ||
        store.get(
          "SELECT 1 FROM blob_leases WHERE project_id=? AND blob_id=?",
          projectId,
          row.blob_id,
        )
      ) {
        store.run(
          "DELETE FROM blob_tombstones WHERE project_id=? AND blob_id=?",
          projectId,
          row.blob_id,
        );
        continue;
      }
      try {
        unlinkSync(blobs.path(projectId, row.blob_id));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const fd = openSync(dirname(blobs.path(projectId, row.blob_id)), "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      store.run(
        "DELETE FROM blobs WHERE project_id=? AND id=?",
        projectId,
        row.blob_id,
      );
      store.run(
        "DELETE FROM blob_tombstones WHERE project_id=? AND blob_id=?",
        projectId,
        row.blob_id,
      );
      deleted.push(row.blob_id);
    }
  });
  return {
    deleted,
    pending: store
      .all(
        "SELECT blob_id AS blobId FROM blob_tombstones WHERE project_id=?",
        projectId,
      )
      .map((r) => r.blobId),
  };
}
export function integrityReport(blobs, projectId) {
  blobs.store.requireProject(projectId);
  const result = {
    available: 0,
    missing: [],
    corrupt: [],
    recovered: blobs.recovered?.get(projectId) ?? [],
  };
  for (const b of blobs.store.all(
    "SELECT id,status FROM blobs WHERE project_id=? ORDER BY id",
    projectId,
  )) {
    if (b.status === "available") result.available++;
    else result[b.status].push(b.id);
  }
  return result;
}
export function supportBundle(service, projectId) {
  const { store } = service;
  store.requireProject(projectId);
  // Deliberate allowlist: no row dumps, text, media, provider payloads, environment or file paths.
  return {
    format: "lore-studio-support",
    version: 1,
    schemaVersion: 2,
    integrity: integrityReport(service.blobs, projectId),
    attempts: store
      .all(
        "SELECT status,count(*) AS count FROM generation_attempts WHERE project_id=? GROUP BY status",
        projectId,
      )
      .map((r) => ({ ...r })),
    reservations: store
      .all(
        "SELECT status,count(*) AS count FROM budget_reservations WHERE project_id=? GROUP BY status",
        projectId,
      )
      .map((r) => ({ ...r })),
  };
}
