import { digest, nonempty, planShots, safeId } from './webtoon-contract.js';

// Source coverage is an audit of editorial decisions, not a quota of things to draw.
export const EDITORIAL_SCHEMA = {
  version: 1,
  focus: { primary: '이번 화에서 가장 강하게 남길 독자 경험', supporting: ['보조 경험'], tradeoff: '주된 경험을 위해 덜어낼 것과 보존할 경계' },
  beats: [{ id: 'beat-id', sourceIds: ['source-id'], decision: 'expand|condense|omit|defer',
    reason: '이 작품의 주된 경험과의 관계', readerChange: '독자 이해·감정의 변화 또는 의도적 머묾',
    visualProof: '남기는 장면에서 실제로 보여야 하는 증거. 제외 장면은 빈 문자열',
    carryForward: '생략해도 남겨야 할 맥락의 전달 위치 / 뒤로 미루면 회수 계획 / 불필요하면 그 이유' }],
};

export const EDITORIAL_PROMPT = '웹툰 편집 각색가다. 원작 전체 범위와 승인 계약, 사용자 피드백을 읽고 컷을 나누기 전에 이번 화의 주된 독자 경험 하나와 보조 경험, 무엇을 덜어낼지 정한다. 원작 문단은 감사용 식별자다. 문단마다 그림을 만들지 말고 의미 있는 사건·감정 비트로 묶어 expand/condense/omit/defer를 결정한다. 각 sourceId는 정확히 한 비트에 속한다. 모든 원문을 지도에 기록하는 것은 모두 화면에 그리라는 뜻이 아니다. 작은 행동이나 반복도 작품의 약속에 기여하면 머물 수 있고, 핵심 행동의 동기·위치·결과는 압축해도 읽혀야 한다. 제외한 정보가 이후 이해에 필요하면 어디서 어떻게 전달할지 명시한다. 컷 수를 정하거나 maxShots를 채우지 않는다. 취향 변경은 사용자 결정이며 이 결과는 계획 승인을 받을 후보이지 승인된 새 계약이 아니다.';

export function validateEditorial(selection, source) {
  const errors = [];
  const fail = (code) => errors.push({ code });
  if (selection?.version !== 1 || !nonempty(selection?.focus?.primary) || !nonempty(selection?.focus?.tradeoff)
    || !Array.isArray(selection?.focus?.supporting) || !selection.focus.supporting.every(nonempty)) fail('EDITORIAL_FOCUS_REQUIRED');
  if (!Array.isArray(selection?.beats) || !selection.beats.length) return [...errors, { code: 'EDITORIAL_BEATS_REQUIRED' }];
  const sources = new Set(source.units.map(u => u.id)); const covered = new Set(); const ids = new Set();
  for (const beat of selection.beats) {
    if (!beat || !safeId(beat.id) || ids.has(beat.id)) { fail('EDITORIAL_BEAT_ID'); continue; }
    ids.add(beat.id);
    if (!['expand', 'condense', 'omit', 'defer'].includes(beat.decision) || !nonempty(beat.reason)
      || !nonempty(beat.readerChange) || !nonempty(beat.carryForward)) fail('EDITORIAL_DECISION_REQUIRED');
    if (['expand', 'condense'].includes(beat.decision) && !nonempty(beat.visualProof)) fail('EDITORIAL_VISUAL_PROOF_REQUIRED');
    if (!Array.isArray(beat.sourceIds) || !beat.sourceIds.length) { fail('EDITORIAL_SOURCE_REQUIRED'); continue; }
    for (const id of beat.sourceIds) {
      if (!sources.has(id) || covered.has(id)) fail('EDITORIAL_SOURCE_INVALID_OR_DUPLICATE');
      covered.add(id);
    }
  }
  if ([...sources].some(id => !covered.has(id))) fail('EDITORIAL_SOURCE_UNCOVERED');
  if (!selection.beats.some(b => ['expand', 'condense'].includes(b?.decision))) fail('EDITORIAL_NO_RETAINED_BEAT');
  return errors;
}

export function validateEditorialPlan(plan, selection, source) {
  const errors = validateEditorial(selection, source);
  if (errors.length) return errors;
  if (!plan || !Array.isArray(plan.sequences) || plan.sequences.some(s => !Array.isArray(s?.shots) || s.shots.some(s => !s))) return [{ code: 'EDITORIAL_PLAN_SHAPE_REQUIRED' }];
  const fail = (code, shotId) => errors.push({ code, ...(shotId ? { shotId } : {}) });
  if (digest(plan.editorial ?? null) !== digest(selection)) fail('EDITORIAL_BINDING_CHANGED');
  if (!nonempty(plan.panelCountReason)) fail('EDITORIAL_PANEL_COUNT_REASON_REQUIRED');
  const beats = new Map(selection.beats.map(b => [b.id, b])); const used = new Set();
  for (const shot of planShots(plan)) {
    if (!nonempty(shot.purpose) || !nonempty(shot.readerDelta)) fail('EDITORIAL_SHOT_PURPOSE_REQUIRED', shot.id);
    if (!Array.isArray(shot.beatIds) || !shot.beatIds.length || new Set(shot.beatIds).size !== shot.beatIds.length) {
      fail('EDITORIAL_SHOT_BEATS_REQUIRED', shot.id); continue;
    }
    for (const id of shot.beatIds) {
      const beat = beats.get(id);
      if (!beat || !['expand', 'condense'].includes(beat.decision)) fail('EDITORIAL_EXCLUDED_BEAT_DRAWN', shot.id);
      else if (!shot.sourceIds?.some(id => beat.sourceIds.includes(id))) fail('EDITORIAL_BEAT_WITHOUT_SOURCE', shot.id);
      used.add(id);
    }
    for (const id of shot.sourceIds ?? []) {
      if (!shot.beatIds.some(b => beats.get(b)?.sourceIds.includes(id))) fail('EDITORIAL_SHOT_SOURCE_MISMATCH', shot.id);
    }
  }
  for (const beat of selection.beats) {
    if (['expand', 'condense'].includes(beat.decision) && !used.has(beat.id)) fail('EDITORIAL_RETAINED_BEAT_MISSING');
    if (['omit', 'defer'].includes(beat.decision) && plan.adaptation?.some(a => beat.sourceIds.includes(a.sourceId) && a.operation !== 'omit')) fail('EDITORIAL_OMISSION_MAP_CONFLICT');
  }
  return errors;
}

export function editorialMarkdown(selection, plan = null) {
  return `# 각색 편집안\n\n주된 경험: ${selection.focus.primary}\n\n보조 경험: ${selection.focus.supporting.join(' / ')}\n\n선택과 포기: ${selection.focus.tradeoff}\n\n${selection.beats.map(b => `## ${b.id} — ${b.decision}\n\n${b.reason}\n\n독자 변화: ${b.readerChange}\n\n화면 증거: ${b.visualProof || '화면에서 제외'}\n\n맥락 보존: ${b.carryForward}\n\n원작: ${b.sourceIds.join(', ')}`).join('\n\n')}\n${plan ? `\n## 컷 수는 결과\n\n${planShots(plan).length}컷 — ${plan.panelCountReason}\n` : ''}`;
}
