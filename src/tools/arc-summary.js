import { asKit } from '../prompts/index.js';
import { renderSummaries } from '../core/prompt-sections.js';

/**
 * Long memory beyond the recent summary window. When an arc is finished, one
 * model request condenses its chapter summaries into an arc summary and
 * carries the story so far forward; later requests read the latest story so
 * far, the last two arc summaries and the current arc's chapters so far, so
 * what they carry does not grow with the number of arcs. Arcs finished before
 * this existed are summarized the first time lore_write runs after it.
 */
const MODEL = { provider: 'host', modelId: 'host-agent' };
const ARC_SUMMARY_CHARS = 800;
const STORY_SO_FAR_CHARS = 2000;
const RECENT_ARC_SUMMARIES = 2;
const CURRENT_ARC_CHAPTER_CHARS = 160;
// The draft and the chapter plan carry the last five chapter summaries themselves.
const RECENT_WINDOW_CHAPTERS = 5;

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

const clip = (value, max) => String(value ?? '').trim().slice(0, max);

/**
 * Completed arcs in order. A rejected or abandoned plan keeps its number in
 * the archive, so status decides, not the number. An archive that is gone
 * ends the list: every later summary would continue a story with a hole.
 */
async function completedArcs(store, workId, arcPlan) {
  const current = Number(arcPlan?.arcNumber ?? 0);
  const arcs = [];
  for (let arcNumber = 1; arcNumber <= current; arcNumber += 1) {
    const arc = arcNumber === current ? arcPlan : await store.loadArcArchive?.(workId, arcNumber);
    if (!arc) return { arcs, missing: arcNumber };
    if (arc.status === 'completed') arcs.push(arc);
  }
  return { arcs, missing: null };
}

/**
 * Summarizes completed arcs that have no summary yet, in order, because each
 * summary continues the previous story so far. Returns `{ pending: true }`
 * while a host answer is outstanding, `failed` when an answer was unusable
 * (asked again next time) and `missing` when an arc's archive is gone.
 */
export async function ensureArcSummaries({ store, workId, arcPlan, providers, kit: kitSource }) {
  if (typeof store.loadArcSummary !== 'function') return { pending: false };
  const kit = asKit(kitSource);
  const { arcs, missing } = await completedArcs(store, workId, arcPlan);
  let previous = null;
  for (const arc of arcs) {
    const existing = await store.loadArcSummary(workId, arc.arcNumber);
    if (existing) { previous = existing; continue; }
    const summaries = [];
    for (const episode of arc.episodes ?? []) {
      const item = await store.loadChapterSummary(workId, episode.chapter);
      if (item?.summary) summaries.push(item);
    }
    const response = await providers.complete({
      model: MODEL, jsonMode: true, step: 'arc-summary',
      messages: kit.messages('arc-summary', {
        storySoFar: previous?.storySoFar || kit.phrases.sections.noStoryYet,
        arcTitle: arc.title ?? '', arcPromise: arc.promise ?? '',
        summariesText: renderSummaries(summaries, kit) || kit.phrases.sections.noStoryYet,
      }),
    });
    if ((providers.pending?.length ?? 0) > 0) return { pending: true };
    const obj = parse(response?.text);
    const arcSummary = typeof obj?.arcSummary === 'string' ? obj.arcSummary.trim() : '';
    const storySoFar = typeof obj?.storySoFar === 'string' ? obj.storySoFar.trim() : '';
    if (!arcSummary || !storySoFar) return { pending: false, failed: arc.arcNumber, missing };
    previous = {
      arcNumber: arc.arcNumber, title: arc.title ?? '', chapters: (arc.episodes ?? []).map((e) => e.chapter),
      summary: clip(arcSummary, ARC_SUMMARY_CHARS), storySoFar: clip(storySoFar, STORY_SO_FAR_CHARS),
      createdAt: new Date().toISOString(),
    };
    await store.saveArcSummary(workId, previous);
  }
  return { pending: false, missing };
}

/**
 * The long-memory section: the latest story so far, the last two arc
 * summaries and the current arc's finished chapters (before `chapter`).
 */
export async function renderLongMemory({ store, workId, arcPlan, chapter, kit: kitSource }) {
  if (typeof store.loadArcSummary !== 'function') return '';
  const kit = asKit(kitSource);
  const t = kit.phrases.sections;
  const { arcs } = await completedArcs(store, workId, arcPlan);
  const recent = [];
  for (const arc of arcs.slice(-RECENT_ARC_SUMMARIES)) {
    const record = await store.loadArcSummary(workId, arc.arcNumber);
    if (record) recent.push(record);
  }
  const latest = recent.at(-1);
  const lines = [];
  if (latest?.storySoFar) lines.push(t.storySoFar(latest.storySoFar));
  lines.push(...recent.map((record) => t.arcSummaryLine(record.arcNumber, record.title ?? '', record.summary)));
  if (arcPlan?.status === 'active') {
    // What actually happened in this arc's finished chapters; the plan beat
    // stands in, labelled, only where no summary was stored.
    const past = [];
    // Chapters in the recent summary window are shown there already.
    for (const episode of (arcPlan.episodes ?? []).filter((e) => e.chapter < chapter - RECENT_WINDOW_CHAPTERS)) {
      const stored = await store.loadChapterSummary?.(workId, episode.chapter);
      if (stored?.summary) past.push(`${episode.chapter}화 ${clip(stored.summary, CURRENT_ARC_CHAPTER_CHARS)}`);
      else if (episode.beat || episode.goal) past.push(t.plannedBeat(episode.chapter, episode.beat ?? episode.goal));
    }
    if (past.length) lines.push(t.currentArcSoFar(arcPlan.title ?? '', past.join(' / ')));
  }
  return lines.length ? [t.longMemoryHeading, ...lines].join('\n') : '';
}
