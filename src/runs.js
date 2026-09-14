/**
 * Suspended runs.
 *
 * A tool that needs model work returns to the host and waits. The MCP server
 * process usually survives that round trip -- but "usually" is not good enough
 * when the thing being held is a writer's chapter, so runs live on disk under
 * `.vibelore/runs/` and survive a restart.
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const TTL_MS = 24 * 60 * 60 * 1000;
const INLINE_STRING_BYTES = 8192;
const PAYLOAD_REF = '$vibeloreRunPayload';

const dirFor = (root) => join(root, '.vibelore', 'runs');
const pathFor = (root, id) => join(dirFor(root), `${id}.json`);
const payloadDirFor = (root) => join(dirFor(root), 'payloads');

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function assertRunId(id) {
  if (!/^run-[a-z0-9]+$/.test(id)) throw new Error(`invalid runId: ${id}`);
}

function payloadFilename(runId, hash) {
  return `${runId}-${hash}.txt`;
}

function isPayloadRef(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value[PAYLOAD_REF] === 1;
}

function externalizeLargeStrings(value, runId, writes) {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= INLINE_STRING_BYTES) return value;
    const hash = sha256(value);
    const name = payloadFilename(runId, hash);
    writes.push({ name, text: value });
    return {
      [PAYLOAD_REF]: 1,
      encoding: 'utf8',
      bytes,
      sha256: hash,
      path: `payloads/${name}`,
    };
  }
  if (Array.isArray(value)) return value.map((item) => externalizeLargeStrings(item, runId, writes));
  if (value && typeof value === 'object') {
    if (isPayloadRef(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, externalizeLargeStrings(item, runId, writes)]),
    );
  }
  return value;
}

function payloadPathFromRef(root, ref) {
  const name = basename(String(ref.path ?? ''));
  if (!/^run-[a-z0-9]+-[a-f0-9]{64}\.txt$/.test(name)) {
    throw new Error(`invalid run payload reference: ${ref.path}`);
  }
  return join(payloadDirFor(root), name);
}

async function hydratePayloadRefs(root, value) {
  if (isPayloadRef(value)) {
    const text = await readFile(payloadPathFromRef(root, value), 'utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    const hash = sha256(text);
    if (bytes !== value.bytes || hash !== value.sha256) {
      throw new Error(`run payload checksum mismatch: ${value.path}`);
    }
    return text;
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => hydratePayloadRefs(root, item)));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => [key, await hydratePayloadRefs(root, item)]),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

function collectPayloadRefs(value, refs = []) {
  if (isPayloadRef(value)) {
    refs.push(value);
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPayloadRefs(item, refs);
    return refs;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPayloadRefs(item, refs);
  }
  return refs;
}

async function readRawRun(root, id) {
  assertRunId(id);
  try { return JSON.parse(await readFile(pathFor(root, id), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

export function newRunId() {
  return `run-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export async function saveRun(root, run) {
  assertRunId(run.id);
  await mkdir(dirFor(root), { recursive: true });
  const writes = [];
  const storedRun = externalizeLargeStrings(run, run.id, writes);
  if (writes.length) await mkdir(payloadDirFor(root), { recursive: true });
  for (const write of writes) {
    const p = join(payloadDirFor(root), write.name);
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, write.text, 'utf8');
    await rename(tmp, p);
  }
  const p = pathFor(root, run.id);
  await writeFile(`${p}.tmp`, JSON.stringify(storedRun, null, 2), 'utf8');
  await rename(`${p}.tmp`, p);
  return run;
}

export async function loadRun(root, id) {
  const raw = await readRawRun(root, id);
  if (!raw) return null;
  return await hydratePayloadRefs(root, raw);
}

export async function findLatestRun(root, { tool, workId, createdAfter } = {}) {
  let entries = [];
  try { entries = await readdir(dirFor(root)); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  const runs = [];
  for (const name of entries.filter((entry) => /^run-[a-z0-9]+\.json$/.test(entry))) {
    const run = await readRawRun(root, name.replace(/\.json$/, '')).catch(() => null);
    if (!run) continue;
    if (tool && run.tool !== tool) continue;
    if (workId && run.args?.workId !== workId) continue;
    if (createdAfter && Date.parse(run.createdAt ?? 0) < Date.parse(createdAfter)) continue;
    runs.push(run);
  }
  runs.sort((left, right) => Date.parse(right.createdAt ?? 0) - Date.parse(left.createdAt ?? 0));
  return runs[0] ?? null;
}

export async function dropRun(root, id) {
  const raw = await readRawRun(root, id);
  for (const ref of collectPayloadRefs(raw)) {
    try { await unlink(payloadPathFromRef(root, ref)); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  try { await unlink(pathFor(root, id)); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
}

/** Called opportunistically; a stale run is dead weight, not a bug to report. */
export async function sweepRuns(root, now = Date.now()) {
  let entries = [];
  try { entries = await readdir(dirFor(root)); }
  catch (err) { if (err.code === 'ENOENT') return 0; throw err; }
  let dropped = 0;
  for (const name of entries.filter((n) => n.endsWith('.json'))) {
    const run = await readRawRun(root, name.replace(/\.json$/, '')).catch(() => null);
    if (run && now - Date.parse(run.createdAt ?? 0) > TTL_MS) {
      await dropRun(root, run.id);
      dropped += 1;
    }
  }
  return dropped;
}
