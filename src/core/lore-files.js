import { lstat, mkdir, open, readFile, rename, unlink, readdir } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeLore, hashLore } from '../../engine/src/lore/registry.js';
import { requireLore } from '../../engine/src/lore/schemas.js';

export async function safeLorePath(root, path) {
  const local = relative(root, path);
  requireLore(!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`), 'UNSAFE_LORE_PATH', path);
  let current = root;
  for (const name of ['', ...local.split(sep).filter(Boolean)]) {
    if (name) current = join(current, name);
    try { requireLore(!(await lstat(current)).isSymbolicLink(), 'UNSAFE_LORE_PATH', current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export async function loreReadText(root, path) {
  await safeLorePath(root, path);
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function loreReadJson(root, path) {
  const text = await loreReadText(root, path);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { requireLore(false, 'LORE_INTEGRITY', `invalid JSON: ${path}`); }
}
export async function loreSyncDirectory(path) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
export async function loreWriteText(root, path, text, { immutable = false } = {}) {
  await safeLorePath(root, path); await mkdir(dirname(path), { recursive: true }); await safeLorePath(root, path);
  if (immutable) {
    const old = await loreReadText(root, path);
    if (old !== null) { requireLore(old === text, 'LORE_INTEGRITY', `immutable object differs: ${path}`); return; }
  }
  const temporary = `${path}.tmp-${randomUUID()}`, handle = await open(temporary, 'wx');
  try {
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path); await loreSyncDirectory(dirname(path));
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export const loreWriteJson = (root, path, value, options) => loreWriteText(root, path, encodeLore(value), options);

export function loreDocumentPath(path) {
  requireLore(typeof path === 'string' && path.length <= 300 && !path.includes('\\') && !path.split('/').some(p => !p || p === '.' || p === '..')
    && (path === 'universe.md' || /^(world|characters)\/[A-Za-z0-9_./-]+\.(md|json)$/.test(path)), 'UNSAFE_LORE_PATH', String(path));
  return path;
}
/** Exact source inventory; JSON/string whitespace may carry meaning. */
export async function loreSourceFingerprint(root) {
  const inventory = [];
  async function visit(path, local) {
    await safeLorePath(root, path);
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${local}/${name}`);
    } else if (info.isFile() && /\.(md|json)$/.test(local)) inventory.push({ path: local, digest: hashLore(await readFile(path, 'utf8')) });
    else requireLore(info.isFile(), 'UNSAFE_LORE_PATH', path);
  }
  await visit(join(root, 'world'), 'world'); await visit(join(root, 'characters'), 'characters');
  const universe = await loreReadText(root, join(root, 'universe.md'));
  if (universe !== null) inventory.push({ path: 'universe.md', digest: hashLore(universe) });
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  return { digest: hashLore(inventory), inventory };
}
/** Content-addressed bytes: an existing file must already hold exactly these bytes. */
export async function loreWriteBytes(root, path, bytes) {
  await safeLorePath(root, path); await mkdir(dirname(path), { recursive: true }); await safeLorePath(root, path);
  try {
    const old = await readFile(path);
    requireLore(old.equals(bytes), 'LORE_INTEGRITY', `immutable file differs: ${path}`); return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.tmp-${randomUUID()}`, handle = await open(temporary, 'wx');
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path); await loreSyncDirectory(dirname(path));
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
