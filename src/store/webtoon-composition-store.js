import { readFile, readdir, rename, access } from 'node:fs/promises';
import { digest, safeId } from '../core/webtoon-contract.js';
import { referenceRoleOf } from '../core/webtoon-scene.js';
import { COMPOSITION_VOCAB_VERSION, compositionFingerprint } from '../core/webtoon-composition.js';
import { applySceneToIndex, buildIndex, compactVector, expandVector, protagonistIdsFor, sceneSummary } from '../core/webtoon-composition-aggregate.js';
import { finalCompositionLabels } from '../core/webtoon-scene-review.js';
import { atomicWrite } from './webtoon-store.js';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const CORRUPT_SHARD = 'CORRUPT_COMPOSITION_SHARD';
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

const rowKey = r => `${r.workflowId}:${r.revision}`;
const INDEX_FILES = ['l1-scenes.json', 'l1-episodes.json', 'l2.json', 'l3.json'];
const mapValues = (object, fn) => Object.fromEntries(Object.entries(object).map(([k, v]) => [k, fn(v)]));
/** On disk a summary is sparse and its fingerprints map is stored once (it is `counts.fingerprints`). */
const packSummary = ({ counts, requiredCounts, closes, sceneType, adoptedAt }) => ({ counts: compactVector(counts), requiredCounts: compactVector(requiredCounts), closes, sceneType, adoptedAt });
const unpackSummary = ({ counts, requiredCounts, closes, sceneType, adoptedAt }) => {
  const full = expandVector(counts);
  return { counts: full, requiredCounts: expandVector(requiredCounts), closes, fingerprints: full.fingerprints, sceneType, adoptedAt: adoptedAt ?? null };
};
const exists = path => access(path).then(() => true, () => false);
/** Short reason that never carries a path: the error code or its first token. */
const shortReason = error => /^[A-Z][A-Z_]+(: [\w-]+)?/.exec(String(error?.message ?? error))?.[0] ?? error?.code ?? error?.name ?? 'ERROR';
const sameIds = (a, b) => a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);

function parseShard(text, episodeKey) {
  if (!text) return [];
  const parts = text.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts.map(line => {
    try { const row = JSON.parse(line); if (row && typeof row === 'object' && !Array.isArray(row)) return row; }
    catch { /* reported below */ }
    throw Object.assign(new Error(`${CORRUPT_SHARD}: ${episodeKey}`), { code: CORRUPT_SHARD });
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
      openPanel: 1, closePanel: panelCount, sceneType: w.scenePlan?.sceneType ?? null, references: (w.sceneReferences ?? []).map(r => ({ id: r.id, hash: r.hash, role: referenceRoleOf(r.id),
        ...(r.mergedIds?.length ? { mergedRoles: r.mergedIds.map(referenceRoleOf) } : {}) })) };
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
  /** Adopted, confident, non-directed panels across the work, and how many of them the review corrected. */
  async basisStats() {
    const { texts } = await this.readSources();
    let corrected = 0, total = 0;
    for (const [episodeKey, text] of texts) {
      for (const row of parseShard(text, episodeKey)) {
        if (row.type !== 'panel' || row.status !== 'adopted' || row.confidence !== 'clear' || !plain(row.label) || row.directed === true) continue;
        total++;
        if (row.source === 'review-corrected') corrected++;
      }
    }
    return { corrected, total };
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
        scenes: mapValues(scenes.scenes, unpackSummary), episodes: mapValues(episodes.episodes, expandVector), order: l2.order, prefix: l2.prefix.map(expandVector),
        entities: { character: mapValues(l3.entities.character, expandVector), sceneType: mapValues(l3.entities.sceneType, expandVector) } };
    } catch { return null; }
  }
  /** The index, rebuilt from L0 when it is missing, unreadable or stale (vocabulary, source head or protagonist setting). */
  async loadIndex(options = {}) { return await this.peekIndex(options) ?? await this.rebuildIndex(options); }
  async saveIndex(index) {
    const meta = { vocabVersion: index.vocabVersion, sourceHead: index.sourceHead };
    const files = {
      'l1-scenes.json': { ...meta, configured: index.configured, protagonistIds: index.protagonistIds, scenes: mapValues(index.scenes, packSummary) },
      'l1-episodes.json': { ...meta, episodes: mapValues(index.episodes, compactVector) },
      'l2.json': { ...meta, order: index.order, prefix: index.prefix.map(compactVector) },
      'l3.json': { ...meta, entities: { character: mapValues(index.entities.character, compactVector), sceneType: mapValues(index.entities.sceneType, compactVector) } },
    };
    for (const [name, body] of Object.entries(files)) await atomicWrite(this.repo.path('composition', name), JSON.stringify(body));
  }
  /** Deterministic L1-L3 from L0 without touching disk; costs no model calls. */
  async computeIndex({ protagonistIds = [] } = {}) {
    const { texts, sourceHead } = await this.readSources();
    const rowsByEpisode = (await this.listEpisodes()).map(({ episodeKey }) => ({ episodeKey, rows: parseShard(texts.get(episodeKey) ?? '', episodeKey) }));
    return buildIndex(rowsByEpisode, { protagonistIds, sourceHead });
  }
  /** The index for reading only: the stored one when current, otherwise computed in memory and not written. */
  async readIndex(options = {}) { return await this.peekIndex(options) ?? await this.computeIndex(options); }
  /** Deterministic rebuild of L1-L3 from L0, written to disk. */
  async rebuildIndex(options = {}) {
    const index = await this.computeIndex(options);
    await this.saveIndex(index);
    return index;
  }
  /**
   * Update a loaded index for one scene whose rows were just rewritten: subtract the summary of its previous rows
   * (`prevRows`, read before the rewrite), add the new one, recompute prefix sums from the affected episode.
   * Falls back to a full rebuild when the implied protagonist changes.
   */
  async applySceneToIndex(index, episodeKey, key, prevRows, { protagonistIds = [] } = {}) {
    const [rows, { sourceHead }, episodes] = await Promise.all([this.readShard(episodeKey), this.readSources(), this.listEpisodes()]);
    const summaryOf = list => list.some(r => r.status === 'adopted') ? sceneSummary(list, { protagonistIds: index.protagonistIds }) : null;
    const id = `${episodeKey}:${key}`;
    const updated = applySceneToIndex(index, id, summaryOf(prevRows), summaryOf(rows.filter(r => r.sceneKey === key)), { order: episodes.map(e => e.episodeKey), sourceHead });
    if (!sameIds(protagonistIdsFor(updated, protagonistIds), updated.protagonistIds)) return this.rebuildIndex({ protagonistIds });
    await this.saveIndex(updated);
    return updated;
  }
  /**
   * Record a scene's rows, then keep the derived index in step. The index is rebuildable, so a failure there
   * never blocks the caller: it comes back as `indexError` (a short reason) and the next loadIndex notices the stale source head.
   * A damaged shard makes the rows themselves unrecordable and surfaces as CORRUPT_COMPOSITION_SHARD.
   */
  async adoptScene(w, { adopted, protagonistIds = [] }) {
    const key = sceneKey(w);
    let indexError = null, before = null, prevRows = [];
    try {
      before = await this.peekIndex({ protagonistIds });
      // The scene's rows as they stand before the rewrite: the index subtracts their summary.
      if (before) prevRows = (await this.readShard(sceneEpisodeKey(w))).filter(r => r.sceneKey === key);
    } catch (error) { before = null; indexError = shortReason(error); }
    const recorded = await this.recordScene(w, { adopted });
    try {
      if (before) await this.applySceneToIndex(before, recorded.episodeKey, key, prevRows, { protagonistIds });
      else await this.rebuildIndex({ protagonistIds });
    } catch (error) { indexError = shortReason(error); }
    return { ...recorded, indexError };
  }
  /**
   * Rename every damaged episode shard to a sibling name the store no longer lists or reads (bytes kept), so the
   * rest of the history can be rebuilt. Returns the episode keys that were set aside.
   */
  async setAsideCorrupt() {
    let names;
    try { names = await readdir(this.repo.path('composition', 'l0')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const stamp = this.now().replace(/[^0-9A-Za-z]/g, '');
    const aside = [];
    for (const name of names.filter(n => n.endsWith('.jsonl')).sort()) {
      const key = name.slice(0, -'.jsonl'.length);
      if (!safeId(key)) continue;
      try { await this.readShard(key); continue; }
      catch (error) { if (error.code !== CORRUPT_SHARD) throw error; }
      const from = this.shardPath(key);
      let target = `${from}.corrupt-${stamp}`;
      for (let n = 2; await exists(target); n++) target = `${from}.corrupt-${stamp}-${n}`;
      await rename(from, target);
      aside.push(key);
    }
    return aside;
  }
}
