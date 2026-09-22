import { cp, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { createPublicationUnit } from '../core/publication-unit.js';
import { captureWorkingTreeFingerprint } from '../core/working-tree-sync.js';
import { saveExperienceLedgerForHead } from '../core/experience-ledger.js';

const canonicalDirs = ['world', 'characters', 'chapters', 'summaries'];
const machineEntries = ['foundation.json', 'story-profile.json', 'story-spine.json', 'writer-skill.json', 'story-identity.json', 'pilot-contract.json', 'arc-plan.json', 'arcs', 'arc-reviews', 'episode-plans', 'artifacts', 'story-state', 'summaries', 'entities.json', 'pattern-ledger.json', 'experience-ledger.json', 'style-anchor.json'];
const webtoonEntries = ['webtoon', 'webtoon-publication'];
const infrastructure = new Set(['publication', 'snapshots', 'rollback-archives', 'rollback-pending.json', 'project.lock', 'project.lock.cleanup', ...webtoonEntries]);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const invalid = (detail) => new Error(`INVALID_SNAPSHOT: ${detail}`);

function assertArguments(workId, chapter) {
  if (typeof workId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(workId)) throw new Error('INVALID_WORK_ID');
  if (!Number.isSafeInteger(chapter) || chapter < 1) throw new Error('INVALID_CHAPTER: 회차는 양의 정수여야 합니다.');
}
async function info(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function directory(path, optional = false) {
  const entry = await info(path);
  if (!entry && optional) return false;
  if (!entry?.isDirectory() || entry.isSymbolicLink()) throw invalid('directory missing or symbolic link');
  return true;
}
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function writeDurable(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  const file = await open(temporary, 'wx');
  try { await file.writeFile(json(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}

// Include empty directories and reject links/special files before copying or deleting.
async function inventory(path, prefix = '', items = []) {
  const entry = await info(path);
  if (!entry) return items;
  if (entry.isSymbolicLink()) throw invalid('symbolic links are not supported');
  if (entry.isDirectory()) {
    if (prefix) items.push([prefix, 'directory']);
    for (const name of (await readdir(path)).sort()) {
      if (!prefix && name === 'manifest.json') continue;
      await inventory(join(path, name), prefix ? `${prefix}/${name}` : name, items);
    }
  } else if (entry.isFile()) items.push([prefix, hash(await readFile(path))]);
  else throw invalid('special files are not supported');
  return items;
}
async function copyIfPresent(source, target) {
  if (!(await info(source))) return;
  await inventory(source);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}
async function boundedCopy(source, target, chapter) {
  if (!(await directory(source, true))) return;
  await mkdir(target, { recursive: true });
  for (const name of await readdir(source)) {
    const number = Number(name.replace(/\.(?:md|json)$/, ''));
    if (Number.isInteger(number) && number > chapter) continue;
    await copyIfPresent(join(source, name), join(target, name));
  }
}
async function safeMachineRoot(store) {
  await directory(store.rootDir);
  await directory(store.sidecar(), true);
}

export async function createChapterSnapshot({ store, workId, chapter }) {
  assertArguments(workId, chapter);
  await safeMachineRoot(store);
  const publication = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
  if (!publication.ok || publication.value?.tree?.workId !== workId || !publication.value.tree.chapters?.[chapter]) throw invalid('published chapter required');
  const base = store.sidecar('snapshots');
  if (!(await directory(base, true))) await mkdir(base);
  const staging = join(base, `.staging-${randomUUID()}`);
  await mkdir(staging);
  try {
    for (const dir of canonicalDirs) {
      if (['chapters', 'summaries'].includes(dir)) await boundedCopy(join(store.rootDir, dir), join(staging, 'canonical', dir), chapter);
      else await copyIfPresent(join(store.rootDir, dir), join(staging, 'canonical', dir));
    }
    for (const entry of machineEntries) {
      if (['episode-plans', 'artifacts', 'story-state', 'summaries'].includes(entry)) await boundedCopy(store.sidecar(entry), join(staging, 'machine', entry), chapter);
      else await copyIfPresent(store.sidecar(entry), join(staging, 'machine', entry));
    }
    await writeDurable(join(staging, 'published.json'), publication.value);
    const files = await inventory(staging);
    const manifest = { schemaVersion: 2, workId, chapter, createdAt: new Date().toISOString(), sourceHead: publication.value.head, files, digest: hash(json(files)) };
    await writeDurable(join(staging, 'manifest.json'), manifest);
    await validateSnapshot(staging, workId, chapter);
    const target = join(base, String(chapter));
    // Keep the previous valid snapshot until the new one is fully written.
    const previous = join(base, `.previous-${randomUUID()}`);
    const hadPrevious = await directory(target, true);
    if (hadPrevious) await rename(target, previous);
    try { await rename(staging, target); }
    catch (error) { if (hadPrevious) await rename(previous, target); throw error; }
    if (hadPrevious) await rm(previous, { recursive: true, force: true });
    return manifest;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function validateSnapshot(source, workId, chapter) {
  await directory(source);
  const manifestInfo = await info(join(source, 'manifest.json'));
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) throw invalid('manifest missing');
  let manifest;
  try { manifest = await readJson(join(source, 'manifest.json')); } catch { throw invalid('manifest is not JSON'); }
  if (manifest.schemaVersion !== 2) throw invalid('legacy snapshots must be migrated manually; no files were changed');
  if (manifest.workId !== workId || manifest.chapter !== chapter) throw invalid('work or chapter mismatch');
  const files = await inventory(source);
  if (json(files) !== json(manifest.files) || hash(json(files)) !== manifest.digest) throw invalid('file inventory or digest mismatch');
  const names = new Set(files.map(([name]) => name));
  for (const required of ['canonical/world/setting.md', `canonical/chapters/${String(chapter).padStart(3, '0')}.md`, 'machine/foundation.json', 'published.json']) {
    if (!names.has(required)) throw invalid(`required file missing: ${required}`);
  }
  const published = await readJson(join(source, 'published.json'));
  if (published.tree?.workId !== workId || published.head !== manifest.sourceHead || !published.projections || !published.manifest?.sealed) throw invalid('publication mismatch');
  const chapters = Object.keys(published.tree.chapters ?? {}).map(Number);
  if (Math.max(...chapters) !== chapter || chapters.some((n) => !Number.isSafeInteger(n) || n < 1)) throw invalid('publication chapter range mismatch');
  return { manifest, published };
}

export async function listSnapshots({ store }) {
  await safeMachineRoot(store);
  const base = store.sidecar('snapshots');
  if (!(await directory(base, true))) return [];
  return (await readdir(base, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name)).map((entry) => Number(entry.name)).sort((a, b) => a - b);
}

async function activeEntries(store) {
  return (await readdir(store.sidecar())).filter((name) => !infrastructure.has(name) && !name.startsWith('rollback-pending.json.tmp-'));
}
async function assertLiveSafe(store) {
  await safeMachineRoot(store);
  for (const dir of canonicalDirs) await inventory(join(store.rootDir, dir));
  for (const entry of await activeEntries(store)) await inventory(store.sidecar(entry));
  for (const entry of webtoonEntries) await inventory(store.sidecar(entry));
}

// The webtoon lane pins its own source. Preserve only its bound shared audit
// records and current run, never resurrect prose authorizations after rollback.
async function webtoonRecoveryEntries(store, archive) {
  const workflows = store.sidecar('webtoon', 'workflows');
  if (!(await directory(workflows, true))) return [];
  const backup = join(archive, 'before', 'machine');
  const entries = new Set();
  for (const name of await readdir(workflows)) {
    if (!/^wt-[A-Za-z0-9_-]+\.json$/.test(name)) continue;
    const workflow = await readJson(join(workflows, name));
    if (`${workflow.workflowId}.json` !== name) throw invalid('webtoon workflow identity');
    for (const { exchangeId } of workflow.events ?? []) {
      if (!/^[a-f0-9]{64}$/.test(exchangeId ?? '')) continue;
      const relative = join('model-exchanges', `${exchangeId}.json`);
      if (!(await info(join(backup, relative)))) continue;
      const exchange = await readJson(join(backup, relative));
      if (exchange.binding?.workflowId === workflow.workflowId) entries.add(relative);
    }
    const runId = workflow.pending?.runId;
    if (!/^run-[a-z0-9]+$/.test(runId ?? '')) continue;
    const relative = join('runs', `${runId}.json`);
    if (!(await info(join(backup, relative)))) continue;
    const run = await readJson(join(backup, relative));
    if (!['lore_webtoon_plan', 'lore_webtoon_render', 'lore_webtoon_scene'].includes(run.tool)
      || run.args?.workId !== workflow.workId || run.args?.workflowId !== workflow.workflowId || run.args?.revision !== workflow.revision) continue;
    entries.add(relative);
    const payloads = join(backup, 'runs', 'payloads');
    if (await directory(payloads, true)) for (const payload of await readdir(payloads)) {
      if (new RegExp(`^${runId}-[a-f0-9]{64}\\.txt$`).test(payload)) entries.add(join('runs', 'payloads', payload));
    }
  }
  return [...entries];
}

/** Called under the project lock before every MCP tool; replay is idempotent. */
export async function resumePendingRollback({ store, failAt = null }) {
  const journalPath = store.sidecar('rollback-pending.json');
  if (!(await info(journalPath))) return null;
  await safeMachineRoot(store);
  const journalInfo = await info(journalPath);
  if (!journalInfo.isFile() || journalInfo.isSymbolicLink()) throw invalid('recovery journal');
  const journal = await readJson(journalPath);
  assertArguments(journal.workId, journal.chapter);
  if (!/^rollback-[a-f0-9-]{36}$/.test(journal.archiveId)) throw invalid('recovery archive id');
  const archive = store.sidecar('rollback-archives', journal.archiveId);
  await directory(store.sidecar('rollback-archives')); await directory(archive);
  const source = join(archive, 'target');
  const { published } = await validateSnapshot(source, journal.workId, journal.chapter);
  await assertLiveSafe(store);
  await inventory(join(archive, 'before', 'machine'));
  const webtoonShared = await webtoonRecoveryEntries(store, archive);
  const unit = createPublicationUnit({ rootDir: store.rootDir });
  const current = await unit.readPublished();
  if (!current.ok) throw invalid('current publication is corrupt');
  const snapshotId = journal.archiveId;
  let head = current.value?.head ?? null;
  if (current.value?.manifest?.snapshotId !== snapshotId) {
    if (head !== journal.expectedHead) throw new Error('ROLLBACK_STALE_HEAD: recovery requires the original published head');
    const token = await unit.issueFencingToken();
    const result = await unit.publish({
      replace: true,
      context: { snapshotId, expectedHead: head, storyTimeScope: { worldline: 'main', through: journal.chapter }, publicationOrder: journal.chapter, transactionTime: journal.createdAt, policyRevision: 'vibelore-1', semanticGeneration: 'vibelore-1', fencingToken: token.value.fencingToken },
      candidate: { tree: published.tree, projections: published.projections, impactClosure: [] },
    });
    if (!result.ok) throw new Error(`ROLLBACK_PUBLICATION_FAILED: ${result.error.code}`);
    head = result.value.head;
  }
  if (failAt === 'afterPublication') throw new Error('injected rollback interruption');
  // The sealed target and original backup remain intact if materialization fails.
  for (const dir of canonicalDirs) {
    await rm(join(store.rootDir, dir), { recursive: true, force: true });
    await copyIfPresent(join(source, 'canonical', dir), join(store.rootDir, dir));
    if (failAt === `after:${dir}`) throw new Error('injected rollback interruption');
  }
  for (const entry of await activeEntries(store)) await rm(store.sidecar(entry), { recursive: true, force: true });
  if (failAt === 'after:machine') throw new Error('injected rollback interruption');
  for (const entry of machineEntries) await copyIfPresent(join(source, 'machine', entry), store.sidecar(entry));
  for (const entry of webtoonShared) await copyIfPresent(join(archive, 'before', 'machine', entry), store.sidecar(entry));
  const ledger = await store.loadExperienceLedger(journal.workId);
  await saveExperienceLedgerForHead({ store, workId: journal.workId, sourceHead: head, entries: (ledger.entries ?? []).filter((entry) => entry.chapter <= journal.chapter), criticVersion: ledger.criticVersion });
  // Old prose authorizations, runs, model exchanges and caches stay archived.
  await captureWorkingTreeFingerprint({ store, sourceHead: head });
  const result = { rolledBackTo: journal.chapter, archiveId: journal.archiveId, archive: `rollback-archives/${journal.archiveId}`, recoverable: true, publication: { head } };
  await writeDurable(join(archive, 'result.json'), result);
  await rm(journalPath);
  return result;
}

export async function rollbackToSnapshot({ store, workId, chapter, failAt = null }) {
  assertArguments(workId, chapter);
  const recovered = await resumePendingRollback({ store });
  if (recovered) return recovered;
  await safeMachineRoot(store);
  await directory(store.sidecar('snapshots'));
  const source = store.sidecar('snapshots', String(chapter));
  await validateSnapshot(source, workId, chapter);
  await assertLiveSafe(store);
  const current = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
  if (!current.ok || current.value?.tree?.workId !== workId) throw invalid('current work mismatch');
  const base = store.sidecar('rollback-archives');
  if (!(await directory(base, true))) await mkdir(base);
  const archiveId = `rollback-${randomUUID()}`;
  const archive = join(base, archiveId);
  await mkdir(archive);
  for (const dir of canonicalDirs) await copyIfPresent(join(store.rootDir, dir), join(archive, 'before', 'canonical', dir));
  for (const entry of await activeEntries(store)) await copyIfPresent(store.sidecar(entry), join(archive, 'before', 'machine', entry));
  await writeDurable(join(archive, 'before', 'published.json'), current.value);
  await copyIfPresent(source, join(archive, 'target'));
  await validateSnapshot(join(archive, 'target'), workId, chapter);
  await writeDurable(store.sidecar('rollback-pending.json'), { archiveId, workId, chapter, expectedHead: current.value.head, createdAt: new Date().toISOString() });
  return resumePendingRollback({ store, failAt });
}
