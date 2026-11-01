import { readFile, readdir } from 'node:fs/promises';
import { digest, safeId } from '../core/webtoon-contract.js';
import { PREVIOUS_SCENE_ID } from '../core/webtoon-scene.js';
import { COMPOSITION_VOCAB_VERSION, compositionFingerprint } from '../core/webtoon-composition.js';
import { applySceneToIndex, buildIndex, protagonistIdsFor, sceneSummary } from '../core/webtoon-composition-aggregate.js';
import { finalCompositionLabels } from '../core/webtoon-scene-review.js';
import { STYLE_REFERENCE_ID } from './webtoon-style-store.js';
import { atomicWrite } from './webtoon-store.js';

const SCRIPT_PREFIX = 'script-';
const chapterOf = key => /^ep-(\d{4,})$/.exec(key)?.[1];

/** `ep-0001` from the lowest source chapter, or `script-<scriptId>` for a scene script. */
export function sceneEpisodeKey(w) {
  if (w.source?.kind === 'scene-script') return `${SCRIPT_PREFIX}${w.source.scriptId}`;
  const chapters = w.sceneUnits.map(u => u.chapter).filter(Number.isSafeInteger);
  return `ep-${String(Math.min(...chapters)).padStart(4, '0')}`;
}

/** Identity of the source span a scene covers; independent of unit order. */
export const sceneKey = w => digest([...w.sceneUnits.map(u => u.id)].sort());

const referenceRole = id => id === PREVIOUS_SCENE_ID ? 'previous-scene' : id === STYLE_REFERENCE_ID ? 'adopted-style' : 'user';
const rowKey = r => `${r.workflowId}:${r.revision}`;
const INDEX_FILES = ['l1-scenes.json', 'l1-episodes.json', 'l2.json', 'l3.json'];
const sameIds = (a, b) => a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);

function parseShard(text, episodeKey) {
  if (!text) return [];
  const parts = text.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts.map(line => {
    try { const row = JSON.parse(line); if (row && typeof row === 'object' && !Array.isArray(row)) return row; }
    catch { /* reported below */ }
    throw new Error(`CORRUPT_COMPOSITION_SHARD: ${episodeKey}`);
  });
}

/** L0 panel records: one JSONL shard per episode under the webtoon lane, always rewritten whole. */
export class CompositionStore {
  constructor(repo, { now = () => new Date().toISOString() } = {}) { this.repo = repo; this.now = now; }
  shardPath(episodeKey) {
    if (!safeId(episodeKey)) throw new Error(`INVALID_COMPOSITION_EPISODE: ${episodeKey}`);
    return this.repo.path('composition', 'l0', `${episodeKey}.jsonl`);
  }
  async readShard(episodeKey) {
    const path = this.shardPath(episodeKey);
    let text;
    try { text = await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return parseShard(text, episodeKey);
  }
  /** Replace this workflow revision's rows, supersede earlier adopted rows of the same scene, and rewrite the shard. */
  async recordScene(w, { adopted }) {
    const episodeKey = sceneEpisodeKey(w), key = sceneKey(w), status = adopted ? 'adopted' : 'rejected';
    const existing = await this.readShard(episodeKey);
    const mine = `${w.workflowId}:${w.revision}`;
    const adoptedAt = existing.find(r => r.type === 'page' && rowKey(r) === mine)?.adoptedAt ?? this.now();
    const labels = finalCompositionLabels(w);
    const panelCount = w.panelCount ?? labels.length;
    const base = { workflowId: w.workflowId, revision: w.revision, reviewVersion: w.imageReviewVersion ?? null, sceneKey: key, episodeKey, status };
    const page = { type: 'page', ...base, adoptedAt, layout: w.preflight?.renderBrief?.pageComposition?.layout ?? null,
      openPanel: 1, closePanel: panelCount, sceneType: w.scenePlan?.sceneType ?? null, references: (w.sceneReferences ?? []).map(r => ({ id: r.id, hash: r.hash, role: referenceRole(r.id) })) };
    const panels = labels.map(({ panel, label, source, confidence }) => {
      const planned = w.preflight?.renderBrief?.moments?.[panel - 1]?.composition;
      return { type: 'panel', ...base, panel, vocabVersion: w.compositionVersion ?? COMPOSITION_VOCAB_VERSION, source, confidence, label: label ?? null,
        required: planned?.required ?? [], directed: planned?.directed === true, fingerprint: label ? compositionFingerprint(label) : null };
    });
    const rows = [page, ...panels];
    const kept = existing.filter(r => rowKey(r) !== mine)
      .map(r => adopted && r.sceneKey === key && r.status === 'adopted' ? { ...r, status: 'superseded' } : r);
    await atomicWrite(this.shardPath(episodeKey), [...kept, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n');
    return { episodeKey, rows };
  }
  /** Chapter episodes in numeric order, then script episodes by their first adoption time. */
  async listEpisodes() {
    let names;
    try { names = await readdir(this.repo.path('composition', 'l0')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const keys = names.filter(n => n.endsWith('.jsonl')).map(n => n.slice(0, -'.jsonl'.length)).filter(safeId);
    const chapters = keys.filter(k => chapterOf(k)).sort((a, b) => Number(chapterOf(a)) - Number(chapterOf(b)));
    const scripts = await Promise.all(keys.filter(k => k.startsWith(SCRIPT_PREFIX)).map(async episodeKey => {
      const times = (await this.readShard(episodeKey)).filter(r => r.type === 'page' && r.adoptedAt).map(r => r.adoptedAt);
      return { episodeKey, first: times.sort()[0] ?? '' };
    }));
    scripts.sort((a, b) => a.first < b.first ? -1 : a.first > b.first ? 1 : a.episodeKey < b.episodeKey ? -1 : 1);
    return [...chapters, ...scripts.map(s => s.episodeKey)].map((episodeKey, i) => ({ episodeKey, order: i + 1 }));
  }

  /** Digest of every shard file's hash, in episode-key order; null-safe for a work with no composition yet. */
  async readSources() {
    let names;
    try { names = await readdir(this.repo.path('composition', 'l0')); }
    catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
    const keys = names.filter(n => n.endsWith('.jsonl')).map(n => n.slice(0, -'.jsonl'.length)).filter(safeId).sort();
    const texts = new Map(await Promise.all(keys.map(async key => [key, await readFile(this.shardPath(key), 'utf8')])));
    return { texts, sourceHead: digest(keys.map(key => [key, digest(texts.get(key))])) };
  }
  /** The stored index when all four files agree with the current shards and settings; otherwise null. Never writes. */
  async peekIndex({ protagonistIds = [] } = {}) {
    try {
      const [scenes, episodes, l2, l3] = await Promise.all(INDEX_FILES.map(async name => JSON.parse(await readFile(this.repo.path('composition', name), 'utf8'))));
      const parts = [scenes, episodes, l2, l3];
      const { sourceHead } = await this.readSources();
      if (!parts.every(p => p.vocabVersion === COMPOSITION_VOCAB_VERSION && p.sourceHead === sourceHead)) return null;
      if (!sameIds(scenes.configured ?? [], protagonistIds)) return null;
      return { vocabVersion: l2.vocabVersion, sourceHead, configured: scenes.configured, protagonistIds: scenes.protagonistIds,
        scenes: scenes.scenes, episodes: episodes.episodes, order: l2.order, prefix: l2.prefix, entities: l3.entities };
    } catch { return null; }
  }
  /** The index, rebuilt from L0 when it is missing, unreadable or stale (vocabulary, source head or protagonist setting). */
  async loadIndex(options = {}) { return await this.peekIndex(options) ?? await this.rebuildIndex(options); }
  async saveIndex(index) {
    const meta = { vocabVersion: index.vocabVersion, sourceHead: index.sourceHead };
    const files = {
      'l1-scenes.json': { ...meta, configured: index.configured, protagonistIds: index.protagonistIds, scenes: index.scenes },
      'l1-episodes.json': { ...meta, episodes: index.episodes },
      'l2.json': { ...meta, order: index.order, prefix: index.prefix },
      'l3.json': { ...meta, entities: index.entities },
    };
    for (const [name, body] of Object.entries(files)) await atomicWrite(this.repo.path('composition', name), JSON.stringify(body));
  }
  /** Deterministic rebuild of L1-L3 from L0; costs no model calls. */
  async rebuildIndex({ protagonistIds = [] } = {}) {
    const { texts, sourceHead } = await this.readSources();
    const rowsByEpisode = (await this.listEpisodes()).map(({ episodeKey }) => ({ episodeKey, rows: parseShard(texts.get(episodeKey) ?? '', episodeKey) }));
    const index = buildIndex(rowsByEpisode, { protagonistIds, sourceHead });
    await this.saveIndex(index);
    return index;
  }
  /**
   * Update a loaded index for one scene whose rows were just rewritten: subtract its stored summary, add the new one,
   * recompute prefix sums from the affected episode. Falls back to a full rebuild when the implied protagonist changes.
   */
  async applySceneToIndex(index, episodeKey, key, { protagonistIds = [] } = {}) {
    const [rows, { sourceHead }, episodes] = await Promise.all([this.readShard(episodeKey), this.readSources(), this.listEpisodes()]);
    const mine = rows.filter(r => r.sceneKey === key);
    const next = mine.some(r => r.status === 'adopted') ? sceneSummary(mine, { protagonistIds: index.protagonistIds }) : null;
    const id = `${episodeKey}:${key}`;
    const updated = applySceneToIndex(index, id, index.scenes[id] ?? null, next, { order: episodes.map(e => e.episodeKey), sourceHead });
    if (!sameIds(protagonistIdsFor(updated, protagonistIds), updated.protagonistIds)) return this.rebuildIndex({ protagonistIds });
    await this.saveIndex(updated);
    return updated;
  }
  /**
   * Record a scene's rows, then keep the derived index in step. The index is rebuildable, so a failure here is
   * swallowed: it can never block the review verdict, and the next loadIndex notices the stale source head.
   */
  async adoptScene(w, { adopted, protagonistIds = [] }) {
    const before = await this.peekIndex({ protagonistIds }).catch(() => null);
    const recorded = await this.recordScene(w, { adopted });
    try {
      if (before) await this.applySceneToIndex(before, recorded.episodeKey, sceneKey(w), { protagonistIds });
      else await this.rebuildIndex({ protagonistIds });
    } catch { /* derived data */ }
    return recorded;
  }
}
