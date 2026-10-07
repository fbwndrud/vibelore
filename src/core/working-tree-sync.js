import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { relative, join, sep } from 'node:path';

const USER_EDITABLE_DIRS = ['world', 'characters', 'chapters'];

async function markdownFiles(rootDir) {
  const files = [];
  const bindingPath = join(rootDir, 'work.md');
  try {
    const info = await lstat(bindingPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('UNSAFE_LORE_PATH: work.md must be a regular file');
    files.push(bindingPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
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

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
// Whitespace carries no canon: a hand edit that only moves spaces or line
// breaks must not stop writing or trigger a model re-check.
const contentDigestOf = (bytes) => sha256(bytes.toString('utf8').normalize('NFC').replace(/\s+/gu, ''));

export async function fingerprintWorkingTree(rootDir) {
  const files = await markdownFiles(rootDir);
  const inventory = [];
  for (const path of files) {
    const bytes = await readFile(path);
    const local = relative(rootDir, path).split(sep).join('/');
    inventory.push({ path: local, digest: sha256(bytes), contentDigest: local === 'work.md' ? sha256(bytes) : contentDigestOf(bytes) });
  }
  const digest = sha256(JSON.stringify(inventory.map(({ path, contentDigest }) => ({ path, contentDigest }))));
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
  const before = new Map((accepted.inventory ?? []).map((item) => [item.path.replaceAll('\\', '/'), item]));
  const after = new Map(current.inventory.map((item) => [item.path.replaceAll('\\', '/'), item]));
  // Records captured before content digests existed compare raw bytes.
  const differs = (path) => {
    const old = before.get(path);
    const now = after.get(path);
    if (!old || !now) return true;
    return old.contentDigest ? old.contentDigest !== now.contentDigest : old.digest !== now.digest;
  };
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(differs).sort();
  if (accepted.sourceHead !== sourceHead) return { status: 'stale_fingerprint', sourceHead, acceptedHead: accepted.sourceHead, changed };
  return changed.length
    ? { status: 'modified', sourceHead, acceptedHead: accepted.sourceHead, changed }
    : { status: 'clean', sourceHead, acceptedHead: accepted.sourceHead, changed: [] };
}
