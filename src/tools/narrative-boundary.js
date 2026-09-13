import { renderArcMap } from './arc.js';
import { renderEpisodePlan } from './episode-plan.js';
import { asKit } from '../prompts/index.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const DECISIONS = new Set(['advance_episode', 'iterate_episode', 'extend_arc', 'complete_arc']);

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

/** Judge a narrative boundary after prose exists; episode count is not a completion oracle. */
/**
 * @param {{ kit?: object|null }} input 워크플로가 작품 계약을 넘기기 전까지는
 *   구작의 암묵적 ko 계열로 해석한다(기존 동작).
 */
export async function runNarrativeBoundary({ arcPlan, episodePlan, chapter, prose, providers, kit: kitSource }) {
  const kit = asKit(kitSource);
  const current = arcPlan.episodes.find((episode) => episode.chapter === chapter);
  const isLast = current === arcPlan.episodes.at(-1);
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'narrative-boundary',
    messages: kit.messages('narrative-boundary', {
      arcMap: renderArcMap(arcPlan, chapter, kit),
      episodePlanRender: renderEpisodePlan(episodePlan, kit),
      isLast, prose,
    }),
  });
  const obj = parse(response.text) ?? {};
  let decision = DECISIONS.has(obj.decision) ? obj.decision : (isLast ? 'complete_arc' : 'advance_episode');
  if (decision === 'complete_arc' && !isLast) decision = 'advance_episode';
  if (decision === 'extend_arc' && !isLast) decision = 'iterate_episode';
  return {
    decision, reason: String(obj.reason ?? '').slice(0, 500),
    continuation: {
      title: String(obj.continuation?.title ?? kit.phrases.arc.continuationTitle(current.title)).slice(0, 120),
      beat: String(obj.continuation?.beat ?? current.beat ?? current.goal ?? '').slice(0, 500),
      pressure: String(obj.continuation?.pressure ?? '').slice(0, 500),
      turn: String(obj.continuation?.turn ?? '').slice(0, 500),
      carry: String(obj.continuation?.carry ?? current.carry ?? '').slice(0, 500),
    },
  };
}

/** Apply only at commit time so a rejected guided draft never mutates the arc. */
export async function applyNarrativeBoundary({ store, workId, chapter, boundary }) {
  if (!boundary || !['iterate_episode', 'extend_arc'].includes(boundary.decision)) return null;
  const plan = await store.loadArcPlan(workId);
  if (!plan || plan.status !== 'active') return null;
  const at = plan.episodes.findIndex((episode) => episode.chapter === chapter);
  if (at < 0) return null;
  const current = plan.episodes[at];
  const insertAt = boundary.decision === 'iterate_episode' ? at + 1 : plan.episodes.length;
  const insertChapter = boundary.decision === 'iterate_episode' ? chapter + 1 : (plan.episodes.at(-1)?.chapter ?? chapter) + 1;
  const shifted = plan.episodes.map((episode, index) => {
    if (index < insertAt) return { ...episode };
    return { ...episode, index: episode.index + 1, chapter: episode.chapter + 1 };
  });
  const continuation = {
    index: insertAt + 1, chapter: insertChapter, title: boundary.continuation.title,
    beat: boundary.continuation.beat, pressure: boundary.continuation.pressure,
    turn: boundary.continuation.turn, carry: boundary.continuation.carry,
    goal: boundary.continuation.beat, conflict: boundary.continuation.pressure,
    growth: '', cost: '', hook: boundary.continuation.carry, status: 'pending',
    logicalEpisode: current.logicalEpisode ?? current.index,
    iteration: boundary.decision === 'iterate_episode' ? Number(current.iteration ?? 1) + 1 : 1,
  };
  shifted.splice(insertAt, 0, continuation);
  const characterArcs = (plan.characterArcs ?? []).map((arc) => ({
    ...arc,
    beats: arc.beats.map((beat) => beat.episodeIndex > insertAt ? { ...beat, episodeIndex: beat.episodeIndex + 1 } : beat),
  }));
  const next = { ...plan, episodes: shifted, characterArcs, estimatedEpisodes: shifted.length };
  await store.saveArcPlan(workId, next);
  return next;
}
