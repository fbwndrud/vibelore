import { digest, nonempty, safeId, planShots, PLAN_SCHEMA, validateWebtoonPlan } from './webtoon-contract.js';
import { TEXT_DIRECTION } from './webtoon-text.js';
import { unavailableComposite, unavailableReview } from './webtoon-efficiency.js';

const REVIEW_SYSTEM = '이번 묶음만 자세히 검토한다. 공통 지침은 유지하며 전체 지도는 맥락용이다. 각 컷의 행동 이유·대사 지시 대상·시각 증거를 관찰하고 앞뒤 인접 컷 연결도 확인한다. 증거 없이 coveredIds만 나열하지 않는다. clear/unclear/contradiction과 실제 근거를 반환한다. 원작에서 자연스러운 응답도 각색으로 앞말을 생략하면 어색할 수 있다. 질문→응답, 지시어의 대상, 화자가 이미 알고 있다는 전제가 웹툰 안에 남아 있는지 확인하고 원작을 읽은 기억으로 빈 맥락을 보충하지 않는다. 시각 검토는 해당 원화와 합성본의 해당 구간을 실제 열었을 때만 inspectedImages=true다. 미확인을 명시하며 자기검토를 독립 평가로 보고하지 않는다. 합성본 전체에 적용되는 열람 제한이면 inspectionUnavailable={scope:"composite",reason:"실제 제한 사유"}를 반환하고 우회하지 않는다. 일부 컷의 불량/누락은 전역 열람 제한으로 표시하지 않는다.';

// One opt-in workflow policy; partitioning and receipts stay behind the existing tools.
export const SEGMENT_SIZE = 6;
export const segmentCommon = w => ({ contractDigest: w.contract.digest, sourceHash: w.source.hash,
  ...(w.source.languageContract ? { languageContract: w.source.languageContract } : {}),
  direction: Object.fromEntries(Object.entries(w.decisions).map(([id, d]) => [id, d.value])),
  ...(w.textPolicyVersion ? { textPolicyVersion: w.textPolicyVersion, textInstructions: TEXT_DIRECTION } : {}),
  focus: w.editorial?.focus, identity: w.source.identity,
  rules: '공통 방향·원작 사실은 지역 지시로 덮어쓰지 않는다. 행동의 이유, 대사의 지시 대상, 필요한 시각 증거, 앞뒤 상태를 확인한다. 화면 밖/미확인은 추측으로 통과시키지 않는다.' });

export function segmentBatches(plan, size = SEGMENT_SIZE) {
  const all = planShots(plan), batches = [];
  let offset = 0;
  for (const sequence of plan.sequences) {
    for (let i = 0; i < sequence.shots.length; i += size) {
      const start = offset + i, end = Math.min(start + size, offset + sequence.shots.length);
      const shots = all.slice(start, end);
      const context = all.slice(Math.max(0, start - 1), Math.min(all.length, end + 1));
      batches.push({ id: `${sequence.id}-${i}`, purpose: sequence.purpose, shots, context,
        transitions: context.slice(1).map((s, n) => ({ from: context[n].id, to: s.id })) });
    }
    offset += sequence.shots.length;
  }
  return batches;
}

export const segmentSource = (w, ids) => ({ hash: w.source.hash,
  units: w.source.units.filter(u => ids.includes(u.id)), foundation: w.source.foundation,
  chapters: w.source.chapters.map(({ chapter, beforeState, afterState }) => ({ chapter, beforeState, afterState })) });

const planScope = w => (w.textPolicyVersion ? { ...w.scope, textPolicyVersion: w.textPolicyVersion } : w.scope);

export async function generateSegmentedPlan(w, call) {
  w.segmentDraft ??= { parts: {} };
  const draft = w.segmentDraft;
  if (!draft.outline) {
    const response = await call('webtoon-plan-outline',
      '회차 전체의 얇은 설계만 작성한다. 원작·선별안·공통 방향을 읽고 title/promise/closingQuestion/adaptation/visualBible/panelCountReason과 sequences를 만든다. 아직 개별 컷은 쓰지 않는다. 한 sequence는 하나의 사건·감정 목적이며 1~6컷으로 표현 가능한 범위로 나눈다. 선별한 원문을 sourceIds로 배정하고 entryState/exitState를 적는다. 생략 원문은 adaptation에만 남긴다. 컷 상한을 채우지 않는다.',
      { common: segmentCommon(w), source: w.source, editorial: w.editorial, feedback: w.revisionFeedback,
        limits: w.scope, schema: { ...PLAN_SCHEMA, panelCountReason: '필요한 장면과 예상 분량의 이유',
          sequences: [{ id: 'seq-1', purpose: '장면 목적', sourceIds: ['source-id'], entryState: '입장 상태', exitState: '다음으로 넘길 상태' }] } });
    if (!response || response.pending) return response;
    const known = new Set(w.source.units.map(u => u.id)), seqIds = new Set(), assigned = new Set();
    if (!Array.isArray(response.sequences) || !response.sequences.length || response.sequences.length > w.scope.maxShots) throw new Error('SEGMENT_OUTLINE_INVALID');
    for (const seq of response.sequences) {
      if (!safeId(seq.id) || seqIds.has(seq.id) || ![seq.purpose, seq.entryState, seq.exitState].every(nonempty)
        || seq.shots !== undefined || !Array.isArray(seq.sourceIds) || !seq.sourceIds.length
        || seq.sourceIds.some(id => !known.has(id) || assigned.has(id)) || new Set(seq.sourceIds).size !== seq.sourceIds.length) throw new Error('SEGMENT_OUTLINE_INVALID');
      seqIds.add(seq.id); seq.sourceIds.forEach(id => assigned.add(id));
    }
    const retained = w.editorial.beats.filter(b => ['expand', 'condense'].includes(b.decision)).flatMap(b => b.sourceIds);
    if (assigned.size !== retained.length || retained.some(id => !assigned.has(id))) throw new Error('SEGMENT_OUTLINE_SOURCE_COVERAGE');
    // textPolicyVersion is workflow metadata, not model output; stamp it and validate with the final check's scope.
    if (w.textPolicyVersion) response.textPolicyVersion = w.textPolicyVersion;
    const probe = { ...response, sequences: [{ id: 'outline-probe', purpose: 'Header validation only', shots: [{
      id: 'outline-probe-shot', sourceIds: [retained[0]], characters: [], environmentId: response.visualBible?.environments?.[0]?.id,
      storyTime: 'validation', visualState: 'validation', action: 'validation', knowledgeBefore: [], knowledgeAfter: [], texts: [], height: 640, gapAfter: 0 }] }] };
    if (!nonempty(response.panelCountReason) || validateWebtoonPlan(probe, w.source, planScope(w)).length) throw new Error('SEGMENT_OUTLINE_INVALID');
    draft.outline = response;
  }
  const outline = draft.outline;
  for (let index = 0; index < outline.sequences.length; index++) {
    const seq = outline.sequences[index];
    if (draft.parts[seq.id]) continue;
    const remainingShots = w.scope.maxShots - Object.values(draft.parts).flatMap(p => p.shots).length;
    const previous = draft.parts[outline.sequences[index - 1]?.id]?.shots.slice(-2) ?? [];
    const response = await call('webtoon-plan-part',
      '이번 장면만 1~6컷으로 각색한다. 공통 방향과 전체 개요는 바꾸지 않는다. 원문을 그대로 모두 그리지 말고 동기→선택→결과가 읽히는 순간을 고른다. 소품을 남기면 왜 만지는지 드러내고, 지시 대사는 서로 다른 대상을 구별할 시각 증거를 넣는다. 앞 장면의 끝과 다음 장면의 입장 상태를 연결한다. 컷 ID는 sequenceId를 접두사로 사용한다. 실제 대사를 작성한다. 원작을 모르는 독자의 이해를 점검한다.',
      { common: segmentCommon(w), episodeMap: outline.sequences, title: outline.title, promise: outline.promise,
        closingQuestion: outline.closingQuestion, visualBible: outline.visualBible, sequence: seq, previous,
        source: segmentSource(w, seq.sourceIds), editorial: w.editorial.beats.filter(b => b.sourceIds.some(id => seq.sourceIds.includes(id))),
        sourceReferences: { note: '설계 때 읽은 전체 문서가 필요하면 sourceId/documentId로 원문을 다시 확인한다. 생략된 문서를 추측하지 않는다.',
          documents: w.source.documents?.map(({ id, path, hash }) => ({ id, path, hash })) },
        remainingShots, maxShotsThisPart: Math.min(SEGMENT_SIZE, remainingShots - (outline.sequences.length - index - 1)),
        layout: { height: '240~2400 정수', gapAfter: '0~1600 정수' },
        schema: { sequenceId: seq.id, shots: [{ ...PLAN_SCHEMA.sequences[0].shots[0], beatIds: ['beat-id'], purpose: '컷 목적', readerDelta: '독자 변화' }] } });
    if (!response || response.pending) return response;
    if (response.sequenceId !== seq.id || !Array.isArray(response.shots) || !response.shots.length || response.shots.length > SEGMENT_SIZE
      || response.shots.some(s => !s || !s.id?.startsWith(`${seq.id}-`) || !Array.isArray(s.sourceIds) || s.sourceIds.some(id => !seq.sourceIds.includes(id)))) throw new Error('SEGMENT_PART_INVALID');
    const candidate = { ...outline, sequences: [{ id: seq.id, purpose: seq.purpose, shots: response.shots }] };
    if (validateWebtoonPlan(candidate, w.source, planScope(w)).length) throw new Error('SEGMENT_PART_INVALID');
    const count = Object.values(draft.parts).flatMap(p => p.shots).length + response.shots.length;
    if (count + outline.sequences.length - index - 1 > w.scope.maxShots) throw new Error('SEGMENT_SCOPE_EXCEEDED');
    draft.parts[seq.id] = response;
  }
  return { ...outline, ...(w.textPolicyVersion ? { textPolicyVersion: w.textPolicyVersion } : {}), editorial: w.editorial,
    sequences: outline.sequences.map(s => ({ id: s.id, purpose: s.purpose, shots: draft.parts[s.id].shots })) };
}

function evidenceCoverage(rows, expected, key) {
  return Array.isArray(rows) && rows.length === expected.length && new Set(rows.map(key)).size === expected.length
    && rows.every(r => r && expected.includes(key(r)) && nonempty(r.evidence)
      && ['clear', 'unclear', 'contradiction'].includes(r.verdict));
}

export function validateSegmentReview(response, packet) {
  return response?.failed !== true && response?.subjectHash === packet.subjectHash && Array.isArray(response.findings)
    && evidenceCoverage(response.observations, packet.shots.map(s => s.id), r => r?.shotId)
    && evidenceCoverage(response.transitions, packet.transitions.map(t => `${t.from}>${t.to}`), r => `${r?.from}>${r?.to}`)
    && (!packet.visual || response.inspectedImages === true);
}

export async function reviewSegmented(w, kind, subjectHash, call) {
  const visual = kind === 'render', step = visual ? 'webtoon-render-review' : 'webtoon-plan-review';
  const reviewPlan = visual ? { ...w.plan, sequences: w.plan.sequences.map(s => ({ ...s,
    shots: s.shots.filter(p => w.render.shotIds.includes(p.id)) })).filter(s => s.shots.length) } : w.plan;
  const common = segmentCommon(w), all = planShots(reviewPlan);
  const episodeMap = w.plan.sequences.map(s => ({ id: s.id, purpose: s.purpose,
    beats: s.shots.map(p => ({ id: p.id, change: p.readerDelta, before: p.knowledgeBefore, after: p.knowledgeAfter })) }));
  w.segmentReviews ??= {};
  const records = [];
  if (visual && w.reviewAccess?.available === false) return unavailableReview(subjectHash, [], w.reviewAccess.reason);
  const work = [];
  for (const batch of segmentBatches(reviewPlan)) {
    const contextImages = visual ? batch.context.map(s => ({ shotId: s.id, path: w.images[s.id]?.reviewPath ?? w.images[s.id]?.continuityPath,
      hash: w.images[s.id]?.hash, lettering: w.lettering?.[s.id]?.candidates.find(c => c.id === w.lettering[s.id].selectedId) })) : undefined;
    const payload = { common, episodeMap, batchId: batch.id, visual, shots: batch.shots,
      context: batch.context, transitions: batch.transitions, source: segmentSource(w, batch.context.flatMap(s => s.sourceIds)),
      visualBible: w.plan.visualBible, ...(visual ? { artComplete: w.render.artComplete } : {}),
      ...(visual ? { images: contextImages, files: Object.fromEntries(Object.entries(w.render.files).filter(([name]) => ['episode.html', 'episode.svg'].includes(name))) } : {}) };
    const binding = digest({ ...payload, ...(visual ? { files: undefined } : {}) });
    const key = `${kind}:${batch.id}`;
    const packet = { ...payload, subjectHash: binding };
    work.push({ key, binding, packet, record: w.segmentReviews[key]?.binding === binding ? w.segmentReviews[key] : null,
      data: { ...packet, schema: { subjectHash: binding, inspectedImages: false,
        ...(visual ? { inspectionUnavailable: null } : {}),
        observations: batch.shots.map(s => ({ shotId: s.id, verdict: 'clear|unclear|contradiction', evidence: '' })),
        transitions: batch.transitions.map(t => ({ ...t, verdict: 'clear|unclear|contradiction', evidence: '' })), findings: [] } } });
  }
  for (let index = 0; index < work.length;) {
    const current = work[index];
    if (current.record) {
      records.push(current.record); index++;
      if (visual && unavailableComposite(current.record.response)) return unavailableReview(subjectHash, records, current.record.response.inspectionUnavailable.reason);
      continue;
    }
    // Probe unknown visual access once, then fan out independent, bounded packets.
    const parallel = w.efficiencyVersion === 1 && call.batch && (!visual || records.length > 0 || w.reviewAccess?.available === true);
    const group = [current];
    while (parallel && group.length < 3 && work[index + group.length] && !work[index + group.length].record) group.push(work[index + group.length]);
    const result = parallel ? await call.batch(group.map(t => ({ step, system: REVIEW_SYSTEM, data: t.data })))
      : await call(step, REVIEW_SYSTEM, current.data);
    if (!result || result.pending) return result;
    const responses = parallel ? result : [result];
    if (!Array.isArray(responses) || responses.length !== group.length) throw new Error('REVIEW_BATCH_COVERAGE');
    for (let i = 0; i < group.length; i++) {
      const task = group[i], response = responses[i];
      const record = { binding: task.binding, complete: validateSegmentReview(response, task.packet), response };
      w.segmentReviews[task.key] = record; records.push(record);
    }
    const unavailable = visual && responses.find(unavailableComposite);
    if (unavailable) return unavailableReview(subjectHash, records, unavailable.inspectionUnavailable.reason);
    index += group.length;
  }
  const aggregate = records.flatMap(r => [...(r.response?.findings ?? []),
    ...[...(r.response?.observations ?? []), ...(r.response?.transitions ?? [])].filter(e => e.verdict !== 'clear')
      .map(e => ({ code: 'SEGMENT_SEMANTIC_CONCERN', ...e, message: e.evidence }))]);
  const flowBinding = digest({ common, subjectHash, records });
  const key = `${kind}:whole-flow`;
  let flow = w.segmentReviews[key];
  if (flow?.binding !== flowBinding) {
    const response = await call(step,
      '부분 검토를 반복하지 말고 회차 전체의 반복·리듬·정보 공개·감정 회수만 검토한다. 부분 검토의 미확인/실패를 통과로 덮어쓰지 않는다. 원작 사실이나 승인 방향을 변경하지 않는다. 시각 전체 통독은 합성본을 직접 보지 못하면 inspectedImages=false다.',
      { common, episodeMap, subjectHash: flowBinding, findings: aggregate, incompleteBatches: records.filter(r => !r.complete).length,
        ...(visual ? { files: Object.fromEntries(Object.entries(w.render.files).filter(([n]) => ['episode.html', 'episode.svg'].includes(n))) } : {}),
        schema: { subjectHash: flowBinding, evidence: '', inspectedImages: false, findings: [] } });
    if (!response || response.pending) return response;
    flow = { binding: flowBinding, complete: response.failed !== true && response.subjectHash === flowBinding && nonempty(response.evidence)
      && Array.isArray(response.findings) && (!visual || response.inspectedImages === true), response };
    w.segmentReviews[key] = flow;
  }
  return { subjectHash, coveredIds: all.map(s => s.id), inspectedImages: visual && records.every(r => r.complete) && flow.complete,
    failed: !records.every(r => r.complete) || !flow.complete, findings: [...aggregate, ...(flow.response?.findings ?? [])] };
}
