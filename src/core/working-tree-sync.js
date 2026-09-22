import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { relative, join, sep } from 'node:path';

const USER_EDITABLE_DIRS = ['world', 'characters', 'chapters'];

async function markdownFiles(rootDir) {
  const files = [];
  for (const directory of USER_EDITABLE_DIRS) {
    const base = join(rootDir, directory);
    let entries = [];
    try { entries = await readdir(base, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(base, entry.name));
    }
  }
  return files.sort();
}

export async function fingerprintWorkingTree(rootDir) {
  const files = await markdownFiles(rootDir);
  const inventory = [];
  for (const path of files) {
    const bytes = await readFile(path);
    inventory.push({ path: relative(rootDir, path).split(sep).join('/'), digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
  }
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(inventory)).digest('hex')}`;
  return { digest, inventory };
}

export async function captureWorkingTreeFingerprint({ store, sourceHead }) {
  const fingerprint = await fingerprintWorkingTree(store.rootDir);
  const record = { schemaVersion: 1, sourceHead, ...fingerprint, capturedAt: new Date().toISOString() };
  await store.saveWorkingTreeFingerprint(record);
  return record;
}

export async function advanceWorkingTreeFingerprint({ store, previousHead, sourceHead }) {
  if (previousHead) {
    const drift = await detectWorkingTreeDrift({ store, sourceHead: previousHead });
    if (drift.status !== 'clean') return { advanced: false, drift };
  }
  const fingerprint = await captureWorkingTreeFingerprint({ store, sourceHead });
  return { advanced: true, fingerprint };
}

export async function detectWorkingTreeDrift({ store, sourceHead }) {
  const accepted = await store.loadWorkingTreeFingerprint();
  if (!accepted) return { status: 'untracked', sourceHead, changed: [] };
  const current = await fingerprintWorkingTree(store.rootDir);
  const before = new Map((accepted.inventory ?? []).map((item) => [item.path.replaceAll('\\', '/'), item.digest]));
  const after = new Map(current.inventory.map((item) => [item.path.replaceAll('\\', '/'), item.digest]));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
  if (accepted.sourceHead !== sourceHead) return { status: 'stale_fingerprint', sourceHead, acceptedHead: accepted.sourceHead, changed };
  return changed.length
    ? { status: 'modified', sourceHead, acceptedHead: accepted.sourceHead, changed }
    : { status: 'clean', sourceHead, acceptedHead: accepted.sourceHead, changed: [] };
}
