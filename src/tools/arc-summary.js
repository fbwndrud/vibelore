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

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

const clip = (value, max) => String(value ?? '').trim().slice(0, max);

function finishedArcNumbers(arcPlan) {
  const current = Number(arcPlan?.arcNumber ?? 0);
  const last = arcPlan?.status === 'completed' ? current : current - 1;
  return Array.from({ length: Math.max(0, last) }, (_, i) => i + 1);
}

/**
 * Summarizes the earliest finished arc that has no summary yet, one arc per
 * call because each summary continues the previous story so far. Returns
 * `{ pending: true }` while a host answer is outstanding.
 */
export async function ensureArcSummaries({ store, workId, arcPlan, providers, kit: kitSource }) {
  if (typeof store.loadArcSummary !== 'function') return { pending: false };
  const kit = asKit(kitSource);
  for (const arcNumber of finishedArcNumbers(arcPlan)) {
    if (await store.loadArcSummary(workId, arcNumber)) continue;
    const arc = arcNumber === Number(arcPlan?.arcNumber) ? arcPlan : await store.loadArcArchive(workId, arcNumber);
    if (!arc) continue;
    const previous = arcNumber > 1 ? await store.loadArcSummary(workId, arcNumber - 1) : null;
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
    if (!obj?.arcSummary || !obj?.storySoFar) return { pending: false, failed: arcNumber };
    await store.saveArcSummary(workId, {
      arcNumber, title: arc.title ?? '', chapters: (arc.episodes ?? []).map((e) => e.chapter),
      summary: clip(obj.arcSummary, ARC_SUMMARY_CHARS), storySoFar: clip(obj.storySoFar, STORY_SO_FAR_CHARS),
      createdAt: new Date().toISOString(),
    });
  }
  return { pending: false };
}

/**
 * The long-memory section: the latest story so far, the last two arc
 * summaries and the current arc's finished chapters (before `chapter`).
 */
export async function renderLongMemory({ store, workId, arcPlan, chapter, kit: kitSource }) {
  if (typeof store.loadArcSummary !== 'function') return '';
  const kit = asKit(kitSource);
  const t = kit.phrases.sections;
  const done = finishedArcNumbers(arcPlan);
  const recent = [];
  for (const arcNumber of done.slice(-RECENT_ARC_SUMMARIES)) {
    const record = await store.loadArcSummary(workId, arcNumber);
    if (record) recent.push(record);
  }
  const latest = recent.at(-1);
  const lines = [];
  if (latest?.storySoFar) lines.push(t.storySoFar(latest.storySoFar));
  lines.push(...recent.map((record) => t.arcSummaryLine(record.arcNumber, record.title ?? '', record.summary)));
  if (arcPlan?.status === 'active') {
    const past = (arcPlan.episodes ?? []).filter((e) => e.chapter < chapter && (e.beat || e.goal));
    if (past.length) lines.push(t.currentArcSoFar(arcPlan.title ?? '', past.map((e) => `${e.chapter}화 ${e.beat ?? e.goal}`).join(' / ')));
  }
  return lines.length ? [t.longMemoryHeading, ...lines].join('\n') : '';
}
