import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { fail } from "./contracts.js";

const localOwners = new Set(),
  host = hostname();
function incarnation(pid) {
  try {
    return (
      execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}
const start = incarnation(process.pid);
export class BlobLeases {
  constructor(store) {
    this.store = store;
    this.context = new AsyncLocalStorage();
    store.write(() =>
      store.db.exec(`
      CREATE TABLE IF NOT EXISTS blob_owners(id TEXT PRIMARY KEY,pid INTEGER NOT NULL,hostname TEXT NOT NULL,incarnation TEXT NOT NULL,fence INTEGER NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blob_leases(owner_id TEXT NOT NULL REFERENCES blob_owners(id),fence INTEGER NOT NULL,project_id TEXT NOT NULL,blob_id TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(owner_id,project_id,blob_id));
      CREATE TABLE IF NOT EXISTS blob_tombstones(project_id TEXT NOT NULL,blob_id TEXT NOT NULL,marked_at INTEGER NOT NULL,PRIMARY KEY(project_id,blob_id));
    `),
    );
  }
  async scope(kind, callback) {
    if (this.context.getStore()) return callback();
    if (!start)
      fail(
        "LEASE_IDENTITY_UNAVAILABLE",
        "Cannot establish local storage ownership.",
      );
    const owner = { id: randomUUID(), fence: 1, kind };
    localOwners.add(owner.id);
    this.store.write(() =>
      this.store.run(
        "INSERT INTO blob_owners VALUES(?,?,?,?,?,?)",
        owner.id,
        process.pid,
        host,
        start,
        owner.fence,
        "active",
      ),
    );
    try {
      return await this.context.run(owner, callback);
    } finally {
      localOwners.delete(owner.id);
      this.store.write(() => {
        this.store.run("DELETE FROM blob_leases WHERE owner_id=?", owner.id);
        this.store.run("DELETE FROM blob_owners WHERE id=?", owner.id);
      });
    }
  }
  pin(projectId, blobId) {
    const owner = this.context.getStore();
    if (!owner) fail("LEASE_REQUIRED", "Blob IO requires a scoped lease.");
    this.store.write(() => this.pinLocked(projectId, blobId));
  }
  pinLocked(projectId, blobId) {
    const owner = this.context.getStore();
    this.assertFence();
    if (
      this.store.get(
        "SELECT 1 FROM blob_tombstones WHERE project_id=? AND blob_id=?",
        projectId,
        blobId,
      )
    )
      fail(
        "BLOB_GC_BUSY",
        "Blob reclamation is in progress. Retry the operation.",
      );
    this.store.run(
      "INSERT OR IGNORE INTO blob_leases VALUES(?,?,?,?,?)",
      owner.id,
      owner.fence,
      projectId,
      blobId,
      owner.kind,
    );
  }
  assertFence() {
    const owner = this.context.getStore();
    if (!owner) return;
    const current = this.store.get(
      "SELECT fence,status FROM blob_owners WHERE id=?",
      owner.id,
    );
    if (current?.status !== "active" || current.fence !== owner.fence)
      fail("LEASE_FENCED", "Blob operation ownership changed.");
  }
  recover() {
    // No TTL can prove a live process stopped using bytes. Unknown remote/inspection state retains pins.
    const dead = this.store
      .all("SELECT * FROM blob_owners WHERE status='active'")
      .filter((o) => {
        if (o.hostname !== host) return false;
        if (o.pid === process.pid) return !localOwners.has(o.id);
        try {
          process.kill(o.pid, 0);
        } catch (e) {
          return e.code === "ESRCH";
        }
        const actual = incarnation(o.pid);
        return actual !== null && actual !== o.incarnation;
      });
    this.store.write(() => {
      for (const o of dead) {
        const current = this.store.get(
          "SELECT * FROM blob_owners WHERE id=?",
          o.id,
        );
        if (current?.incarnation !== o.incarnation || current.fence !== o.fence)
          continue;
        this.store.run("DELETE FROM blob_leases WHERE owner_id=?", o.id);
        this.store.run("DELETE FROM blob_owners WHERE id=?", o.id);
      }
    });
  }
}
