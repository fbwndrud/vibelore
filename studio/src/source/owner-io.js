import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  mkdtemp,
  writeFile,
  rm,
} from "node:fs/promises";
import { resolve, relative, isAbsolute, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { hashBytes } from "./source-package.js";
import { fail, canonicalDigest } from "../engine/contracts.js";

export function ownerLocation(locator) {
  if (
    !locator ||
    Object.keys(locator).length !== 1 ||
    typeof locator.directory !== "string" ||
    !isAbsolute(locator.directory)
  )
    fail("INVALID_INPUT", "Owner locator requires one absolute directory.");
  return resolve(locator.directory);
}
export async function safeOwnerPath(directory, relativePath) {
  if (
    typeof relativePath !== "string" ||
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((p) => p === "..")
  )
    fail("SOURCE_CORRUPT", "Source path is outside the registered owner.");
  const root = resolve(directory),
    path = resolve(root, relativePath),
    local = relative(root, path);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
    fail("SOURCE_CORRUPT", "Source path escaped its owner.");
  // The root may be reached through a platform alias such as /tmp -> /private/tmp.
  // No symlink inside the configured owner (including the owner itself) is allowed.
  let current = root;
  for (const part of ["", ...local.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      fail("SOURCE_CORRUPT", "Source symlinks are unsupported.");
  }
  const actualRoot = await realpath(root),
    actual = await realpath(path),
    actualLocal = relative(actualRoot, actual);
  if (
    actualLocal === ".." ||
    actualLocal.startsWith(`..${sep}`) ||
    isAbsolute(actualLocal)
  )
    fail("SOURCE_CORRUPT", "Source path escaped its owner.");
  return path;
}
export async function readOwnerBytes({
  directory,
  relativePath,
  expectedSha256,
  maxBytes = 20 * 1024 * 1024,
}) {
  const path = await safeOwnerPath(directory, relativePath);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await file.stat();
    if (!before.isFile())
      fail("SOURCE_CORRUPT", "Source must be a regular file.");
    if (before.size > maxBytes)
      fail(
        "BUNDLE_LIMIT_EXCEEDED",
        "Source file exceeds the bounded read limit."
      );
    const chunks = [];
    let length = 0;
    while (length <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - length));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    if (length > maxBytes)
      fail(
        "BUNDLE_LIMIT_EXCEEDED",
        "Source file exceeds the bounded read limit."
      );
    await safeOwnerPath(directory, relativePath);
    const after = await lstat(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      fail(
        "SOURCE_DRIFT",
        "Source changed during its read; synchronize and retry."
      );
    const bytes = Buffer.concat(chunks, length);
    if (
      expectedSha256 &&
      hashBytes(bytes) !== expectedSha256.replace(/^sha256:/, "")
    )
      fail("BUNDLE_HASH_MISMATCH", "Source bytes failed their recorded hash.");
    return bytes;
  } finally {
    await file.close();
  }
}
export async function physicalOwnerIdentity(directory, relativePath) {
  try {
    const path = await safeOwnerPath(directory, relativePath),
      stat = await lstat(path, { bigint: true });
    return canonicalDigest({
      device: String(stat.dev),
      inode: String(stat.ino),
      birth: String(stat.birthtimeNs),
    });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR")
      fail("OWNER_OFFLINE", "Registered owner is unavailable.");
    throw error;
  }
}
async function optionalBytes(directory, relativePath, maxBytes) {
  try {
    return await readOwnerBytes({ directory, relativePath, maxBytes });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
/** Copy only the existing DB and WAL. SQLite may write its private snapshot's shm,
 * never the owner's. Double reads reject a concurrent checkpoint/commit. */
export async function withOwnerDatabase(directory, operation) {
  const identity = await physicalOwnerIdentity(directory, "studio.sqlite");
  const maxBytes = 128 * 1024 * 1024;
  if (await optionalBytes(directory, "studio.sqlite-journal"))
    fail(
      "SOURCE_BUSY",
      "Rollback journal requires the source owner to settle it."
    );
  async function stamp(name) {
    try {
      const s = await lstat(await safeOwnerPath(directory, name), {
        bigint: true,
      });
      return [s.dev, s.ino, s.birthtimeNs, s.size, s.mtimeNs, s.ctimeNs]
        .map(String)
        .join(":");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  const before = await Promise.all(
    ["studio.sqlite", "studio.sqlite-wal"].map(stamp)
  );
  async function databaseBytes(relativePath, optional = false) {
    try {
      return optional
        ? await optionalBytes(directory, relativePath, maxBytes)
        : await readOwnerBytes({ directory, relativePath, maxBytes });
    } catch (error) {
      if (error.code === "BUNDLE_LIMIT_EXCEEDED")
        fail(
          "SOURCE_LIMIT_EXCEEDED",
          "Database snapshot exceeds 128 MiB per file."
        );
      throw error;
    }
  }
  const dbBytes = await databaseBytes("studio.sqlite");
  const wal = await databaseBytes("studio.sqlite-wal", true);
  const again = await databaseBytes("studio.sqlite");
  const walAgain = await databaseBytes("studio.sqlite-wal", true);
  const after = await Promise.all(
    ["studio.sqlite", "studio.sqlite-wal"].map(stamp)
  );
  if (
    before.some((v, i) => v !== after[i]) ||
    !dbBytes.equals(again) ||
    (wal === null) !== (walAgain === null) ||
    (wal && !wal.equals(walAgain))
  )
    fail("SOURCE_BUSY", "Source database changed during capture.");
  if (wal?.length) {
    const pageSize = wal.length >= 32 ? wal.readUInt32BE(8) : 0;
    if (
      wal.length < 32 ||
      ![0x377f0682, 0x377f0683].includes(wal.readUInt32BE(0)) ||
      pageSize < 512 ||
      pageSize > 65536 ||
      (pageSize & (pageSize - 1)) !== 0 ||
      (wal.length - 32) % (pageSize + 24) !== 0
    )
      fail(
        "SOURCE_BUSY",
        "WAL capture is partial or unsupported; retry after the source writer settles."
      );
  }
  const temporary = await mkdtemp(join(tmpdir(), "studio-owner-snapshot-"));
  let db;
  try {
    await writeFile(join(temporary, "studio.sqlite"), dbBytes);
    if (wal) await writeFile(join(temporary, "studio.sqlite-wal"), wal);
    db = new DatabaseSync(join(temporary, "studio.sqlite"), { readOnly: true });
    db.exec("PRAGMA query_only=ON; BEGIN");
    if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "wal")
      fail(
        "SOURCE_SCHEMA_UNSUPPORTED",
        "Only native WAL sources are supported."
      );
    if (await optionalBytes(directory, "studio.sqlite-journal"))
      fail("SOURCE_BUSY", "Source journal changed during capture.");
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (![1, 2].includes(version))
      fail("SOURCE_SCHEMA_UNSUPPORTED", "Unsupported source schema.");
    const result = await operation(db);
    if ((await physicalOwnerIdentity(directory, "studio.sqlite")) !== identity)
      fail("OWNER_REPLACED", "Source was replaced during capture.");
    return result;
  } finally {
    if (db) {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Native resolvers run against this bounded private mirror, never live source
 * paths. Only the adapter's declared closure is copied. Read-back and directory
 * membership checks reject a source edit before returning the observation. */
export async function withOwnerFiles(directory, prepare, operation) {
  const temporary = await mkdtemp(join(tmpdir(), "lore-owner-snapshot-"));
  const files = new Map(),
    directories = new Map();
  let total = 0;
  const { mkdir, readdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const copy = {
    async file(path, optional = false) {
      if (files.has(path)) return files.get(path)?.bytes ?? null;
      let bytes;
      try {
        bytes = await readOwnerBytes({ directory, relativePath: path });
      } catch (error) {
        if (optional && error.code === "ENOENT") {
          files.set(path, null);
          return null;
        }
        throw error;
      }
      total += bytes.length;
      if (files.size >= 4096 || total > 128 * 1024 * 1024)
        fail(
          "SOURCE_LIMIT_EXCEEDED",
          "Native source snapshot exceeds its bounded closure."
        );
      files.set(path, {
        bytes,
        hash: hashBytes(bytes),
        identity: await physicalOwnerIdentity(directory, path),
      });
      await mkdir(dirname(join(temporary, path)), { recursive: true });
      await writeFile(join(temporary, path), bytes);
      return bytes;
    },
    async json(path, optional = false) {
      const bytes = await copy.file(path, optional);
      return bytes === null ? null : JSON.parse(bytes.toString("utf8"));
    },
    async list(path) {
      if (directories.has(path)) return directories.get(path) ?? [];
      let names;
      try {
        await safeOwnerPath(directory, path);
        names = (await readdir(join(directory, path))).sort();
      } catch (error) {
        if (error.code === "ENOENT") {
          directories.set(path, null);
          return [];
        }
        throw error;
      }
      if (directories.size >= 512 || names.length > 4096)
        fail(
          "SOURCE_LIMIT_EXCEEDED",
          "Native source snapshot directory limit exceeded."
        );
      directories.set(path, names);
      await mkdir(join(temporary, path), { recursive: true });
      return names;
    },
    async tree(path, extensions) {
      for (const name of await copy.list(path)) {
        const child = `${path}/${name}`,
          info = await lstat(await safeOwnerPath(directory, child));
        if (info.isDirectory()) await copy.tree(child, extensions);
        else if (extensions.test(name)) await copy.file(child);
      }
    },
  };
  try {
    await prepare(copy);
    const result = await operation(temporary);
    for (const [path, expected] of files) {
      let actual;
      try {
        actual = await readOwnerBytes({ directory, relativePath: path });
      } catch (error) {
        if (error.code === "ENOENT" && expected === null) continue;
        throw error;
      }
      if (
        expected === null ||
        hashBytes(actual) !== expected.hash ||
        (await physicalOwnerIdentity(directory, path)) !== expected.identity
      )
        fail("SOURCE_DRIFT", "Source changed during bounded resolver capture.");
    }
    for (const [path, expected] of directories) {
      let actual;
      try {
        await safeOwnerPath(directory, path);
        actual = (await readdir(join(directory, path))).sort();
      } catch (error) {
        if (error.code === "ENOENT" && expected === null) continue;
        throw error;
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        fail("SOURCE_DRIFT", "Source membership changed during capture.");
    }
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
