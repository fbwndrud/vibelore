import { readFile, readdir } from 'node:fs/promises';
import { digest, safeId } from '../core/webtoon-contract.js';
import { PREVIOUS_SCENE_ID } from '../core/webtoon-scene.js';
import { COMPOSITION_VOCAB_VERSION, compositionFingerprint } from '../core/webtoon-composition.js';
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
    if (!text) return [];
    const parts = text.split('\n');
    if (parts.at(-1) === '') parts.pop();
    return parts.map(line => {
      try { const row = JSON.parse(line); if (row && typeof row === 'object' && !Array.isArray(row)) return row; }
      catch { /* reported below */ }
      throw new Error(`CORRUPT_COMPOSITION_SHARD: ${episodeKey}`);
    });
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
      openPanel: 1, closePanel: panelCount, references: (w.sceneReferences ?? []).map(r => ({ id: r.id, hash: r.hash, role: referenceRole(r.id) })) };
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
}
