import { renderArcMap } from './arc.js';
import { renderEpisodePlan } from './episode-plan.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const DECISIONS = new Set(['advance_episode', 'iterate_episode', 'extend_arc', 'complete_arc']);

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

/** Judge a narrative boundary after prose exists; episode count is not a completion oracle. */
export async function runNarrativeBoundary({ arcPlan, episodePlan, chapter, prose, providers }) {
  const current = arcPlan.episodes.find((episode) => episode.chapter === chapter);
  const isLast = current === arcPlan.episodes.at(-1);
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'narrative-boundary',
    messages: [
      { role: 'system', content: '당신은 한국어 연재소설의 서사 경계 편집자다. 숫자로 정한 분량이 아니라 본문에서 현재 에피소드의 선택·결과와 아크 promise가 실제로 정산됐는지 판단한다. iterate_episode는 현재 에피소드가 덜 끝나 한 화 더 필요할 때, advance_episode는 현재 에피소드는 끝났고 다음 비트로 갈 때, extend_arc는 마지막 예정 비트 뒤에 추가 정산 화가 필요할 때, complete_arc는 마지막 비트와 아크 약속이 모두 끝났을 때만 쓴다. 순수 JSON만 출력한다.' },
      { role: 'user', content: [
        renderArcMap(arcPlan, chapter), '', renderEpisodePlan(episodePlan), '',
        `현재 예정상 마지막 화인가: ${isLast}`, '본문:', prose, '',
        'JSON: {"decision":"advance_episode|iterate_episode|extend_arc|complete_arc","reason":"본문 근거","continuation":{"title":"필요할 때","beat":"다음 반복/연장 핵심 사건","pressure":"","turn":"","carry":""}}',
      ].join('\n') },
    ],
  });
  const obj = parse(response.text) ?? {};
  let decision = DECISIONS.has(obj.decision) ? obj.decision : (isLast ? 'complete_arc' : 'advance_episode');
  if (decision === 'complete_arc' && !isLast) decision = 'advance_episode';
  if (decision === 'extend_arc' && !isLast) decision = 'iterate_episode';
  return {
    decision, reason: String(obj.reason ?? '').slice(0, 500),
    continuation: {
      title: String(obj.continuation?.title ?? `${current.title} (계속)`).slice(0, 120),
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
