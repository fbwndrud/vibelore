import { mkdir, readFile, readdir, rename, writeFile, unlink, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, safeId } from '../core/webtoon-contract.js';
import { createPublicationUnit } from '../core/publication-unit.js';
import { detectWorkingTreeDrift, fingerprintWorkingTree } from '../core/working-tree-sync.js';
import { resolveWebtoonLanguage } from '../core/webtoon-language.js';

export const readJson = async (path) => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
export async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, path);
}

/** Separate webtoon state: never writes the prose current pointer or HEAD. */
export class WebtoonStore {
  constructor(store) { this.store = store; this.base = store.sidecar('webtoon'); }
  path(...parts) { return join(this.base, ...parts); }
  /** Persist a per-revision artifact and record its hash on the workflow. */
  async writeCandidate(workflow, name, bytes) {
    const path = this.path('candidates', workflow.workflowId, `r${workflow.revision}`, name);
    await atomicWrite(path, bytes); workflow.artifacts[name] = { path, hash: digest(bytes) }; return path;
  }
  async load(id) {
    if (id && !safeId(id)) throw new Error('INVALID_WEBTOON_WORKFLOW_ID');
    if (!id) id = (await readJson(this.path('current.json')))?.workflowId;
    return id ? readJson(this.path('workflows', `${id}.json`)) : null;
  }
  async save(workflow) {
    if (!safeId(workflow.workflowId)) throw new Error('INVALID_WEBTOON_WORKFLOW_ID');
    await atomicWrite(this.path('workflows', `${workflow.workflowId}.json`), JSON.stringify(workflow, null, 2));
    await atomicWrite(this.path('current.json'), JSON.stringify({ workflowId: workflow.workflowId }));
  }
  async locked(action) {
    await mkdir(this.base, { recursive: true });
    const path = this.path('operation.lock');
    let handle;
    try { handle = await import('node:fs/promises').then(({ open }) => open(path, 'wx')); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(path).catch(() => null);
      if (owner?.pid) {
        try { process.kill(owner.pid, 0); }
        catch (failure) {
          if (failure.code === 'ESRCH') { await unlink(path).catch(() => {}); return this.locked(action); }
        }
      }
      throw new Error('WEBTOON_BUSY: 다른 웹툰 작업이 저장 중입니다. 완료 후 재시도하세요.');
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await action(); }
    finally { await handle.close(); await unlink(path); }
  }
  async inventory() {
    const root = join(this.store.rootDir, 'webtoon'); const rows = [];
    async function walk(base, prefix = '') {
      let entries;
      try {
        if ((await lstat(base)).isSymbolicLink()) throw new Error(`WEBTOON_SYMLINK_UNSUPPORTED: ${prefix}`);
        entries = await readdir(base, { withFileTypes: true });
      }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(base, entry.name); const relative = `${prefix}${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error(`WEBTOON_SYMLINK_UNSUPPORTED: ${relative}`);
        if (entry.isDirectory()) await walk(path, `${relative}/`);
        else if (entry.isFile()) rows.push({ path: relative, hash: digest(await readFile(path)) });
      }
    }
    await walk(root); return rows;
  }
  async publish(workflow, artifactKind, artifact) {
    const base = this.store.sidecar('webtoon-publication');
    const parent = await readJson(join(base, 'HEAD.json'));
    if (parent) {
      const previous = await readJson(join(base, 'objects', `${parent.head.slice(7)}.json`));
      if (previous?.approvalId === workflow.approval?.id && previous?.artifactHash === digest(artifact)) return parent.head;
    }
    const manifest = { parent: parent?.head ?? null, workflowId: workflow.workflowId, workId: workflow.workId,
      approvalId: workflow.approval?.id,
      artifactKind, sourceCanonHead: workflow.source.sourceCanonHead, sourceScopeHash: workflow.source.hash,
      contractDigest: workflow.contract.digest, artifactHash: digest(artifact), receipt: workflow.receipt,
      runtimeIdentity: workflow.runtime, artifact };
    const head = digest(manifest);
    await atomicWrite(join(base, 'objects', `${head.slice(7)}.json`), JSON.stringify(manifest, null, 2));
    await atomicWrite(join(base, 'HEAD.json'), JSON.stringify({ head }));
    return head;
  }
}

export async function resolveWebtoonSource(store, workId, requested) {
  const foundation = await store.loadFoundation(workId);
  if (!foundation || foundation.workId !== workId) throw new Error('WEBTOON_SOURCE_NOT_INITIALIZED');
  const publication = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
  if (!publication.ok) throw new Error('CORRUPT_SOURCE_PUBLICATION');
  if (publication.value) {
    const drift = await detectWorkingTreeDrift({ store, sourceHead: publication.value.head });
    if (drift.status !== 'clean') throw new Error('SOURCE_NEEDS_SYNC: lore_sync로 원작 손수정을 먼저 반영하세요.');
  }
  const available = await store.listChapters();
  const storyProfile = await store.loadStoryProfile(workId);
  if (storyProfile && storyProfile.status !== 'active') throw new Error('STORY_PROFILE_NOT_ACTIVE: 원작의 pending 프로필을 먼저 결정하세요.');
  const selected = requested ?? available.slice(0, 1);
  if (!Array.isArray(selected) || !selected.length || selected.length > 20 || new Set(selected).size !== selected.length || !selected.every((n) => Number.isSafeInteger(n) && n > 0 && available.includes(n))) throw new Error('INVALID_WEBTOON_SOURCE_CHAPTERS');
  const chapters = []; const units = [];
  for (const chapter of [...selected].sort((a, b) => a - b)) {
    const artifact = await store.loadArtifact(workId, chapter);
    const raw = await readFile(store.chapterPath(chapter), 'utf8');
    if (!artifact?.prose?.trim()) throw new Error(`EMPTY_SOURCE_CHAPTER: ${chapter}`);
    chapters.push({ chapter, raw, prose: artifact.prose, hash: digest(raw),
      beforeState: await store.loadStoryState(workId, chapter - 1), afterState: await store.loadStoryState(workId, chapter),
      episodeIntent: await store.loadEpisodePlan(workId, chapter) });
    artifact.prose.split(/\n\s*\n/).filter((text) => text.trim()).forEach((text, i) => units.push({ id: `ch-${chapter}-p-${i + 1}`, chapter, text, hash: digest(text) }));
  }
  // Keep user-authored sections as well as the fields understood by MarkdownStateStore.
  const documents = [];
  for (const directory of ['world', 'characters']) {
    async function collect(base, prefix) {
      let entries;
      try {
        if ((await lstat(base)).isSymbolicLink()) throw new Error(`SOURCE_SYMLINK_UNSUPPORTED: ${prefix}`);
        entries = await readdir(base, { withFileTypes: true });
      }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(base, entry.name); const sourcePath = `${prefix}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error(`SOURCE_SYMLINK_UNSUPPORTED: ${sourcePath}`);
        if (entry.isDirectory()) await collect(path, sourcePath);
        else if (entry.isFile() && /\.(md|txt|json|ya?ml)$/i.test(entry.name)) {
          const raw = await readFile(path, 'utf8');
          documents.push({ id: sourcePath, path: sourcePath, raw, hash: digest(raw), temporalScope: 'current-document-not-as-of-scene' });
        }
      }
    }
    await collect(join(store.rootDir, directory), directory);
  }
  const snapshot = {
    languageContract: await resolveWebtoonLanguage({ store, workId, foundation, storyProfile }),
    sourceCanonHead: publication.value?.head ?? null,
    sourceStatus: publication.value ? 'published' : 'manuscript_snapshot',
    sourceFingerprint: await fingerprintWorkingTree(store.rootDir),
    foundation: { ...foundation, characters: foundation.characters.map(({ mutable, ...character }) => character) },
    documents,
    stateNote: '구조화 인물의 현재 mutable 상태는 제외했다. documents는 현재 파일 원문이며 미래 변화도 포함할 수 있다. 장면의 상태는 해당 화 원고와 beforeState/afterState로 판단한다. 과거 상태가 null이거나 설정과 충돌하면 관찰/추론/미해결을 구분한다.',
    storyProfile, identity: await store.loadStoryIdentity(workId),
    writerSkill: await store.loadWriterSkill(workId), chapters, units,
  };
  return { ...snapshot, hash: digest(snapshot) };
}
