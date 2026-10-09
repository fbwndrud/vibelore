import { assertInteger, fail } from './contracts.js';
const labels = {
  'project.create': '작업실 생성', 'production.create': '제작판 생성', 'story.save': '각색 노트 저장',
  'source.capture': '원작 연결', 'source.manuscript': '원고 가져오기', 'cast.put': '배역 저장',
  'casting.set': '목소리 배정', 'scene.put': '장면 편집 저장', 'utterance.update': '발화 연기 저장',
  'asset.import': '자료 가져오기', 'asset.derive': '이미지 수정', 'candidate.adopt': '자료 채택', 'adoption.undo': '자료 채택 되돌림',
  'generation.request': 'Google 생성 요청', 'timeline.update': '영상 타이밍 저장', 'edition.create': '미리보기 고정',
  'edition.render': '파일 출력', 'edition.review': '감상 검토 기록', 'edition.publish': '발행 기록',
  'project.budget.set': '예산 한도 변경', 'project.backup': '프로젝트 백업', 'job.retry': '생성 재시도',
  'job.cancel': '생성 요청 취소', 'attempt.reconcile': '생성 결과 확인',
};
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function changes(current, previous, key, label) {
  const old = previous?.[key] ?? [], now = current?.[key] ?? [];
  const byId = new Map(old.map(x=>[x.id,x]));
  const modified = now.filter(x=>!same(x,byId.get(x.id))).length;
  const removed = old.filter(x=>!now.some(y=>y.id===x.id)).length;
  return modified || removed ? `${label} ${modified}개 변경${removed ? ` · ${removed}개 삭제` : ''}` : null;
}
function summary(type, v, previous) {
  if (type === 'scene.put') return [v.title ?? '장면', changes(v,previous,'shots','샷 구도'), changes(v,previous,'utterances','발화'), changes(v,previous,'occurrences','출현')].filter(Boolean).join(' · ');
  if (type === 'utterance.update') return [v.text?.slice(0,70), previous && !same(v.acting,previous.acting) ? '연기 지시 변경' : null, v.holdMs !== previous?.holdMs ? `대답 간격 ${v.holdMs ?? 0}ms` : null].filter(Boolean).join(' · ');
  if (type === 'casting.set') return `목소리 ${v.voice} · ${{project:'작품 공통',production:'제작판',occurrence:'장면 출현'}[v.scope] ?? '선택 범위'}`;
  if (type === 'source.capture' || type === 'source.manuscript') return `원문 ${v.textUnits?.length ?? 0}개 단위 보존 · 원작 수정 없음`;
  if (type === 'candidate.adopt' || type === 'adoption.undo') return v.reason ?? '자료 선택 변경';
  if (type === 'generation.request') return '선택 자료로 후보 생성 요청을 저장함 · 결과와 청구 상태는 작업 기록에서 확인';
  if (type === 'edition.render') return v.status === 'completed' ? `파일 생성 완료 · ${v.manifest?.durationSeconds ?? ''}초` : `출력 ${v.status === 'failed' ? '실패' : '요청 저장'}${v.errorCode ? ` · ${v.errorCode}` : ''}`;
  if (type === 'edition.create') return '그림·음성·타이밍을 고정함 · 파일 출력 전';
  if (type === 'project.budget.set') return `앱 요청 한도 $${((v.budgetMicros ?? 0)/1e6).toFixed(2)}`;
  return v.title ?? v.name ?? (type.startsWith('asset.') ? '파일을 가져와 검사함 · 채택은 별도 기록' : '작업 결과를 저장함');
}
export function readHistory(store, projectId, { before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
  store.requireProject(projectId); assertInteger(before); assertInteger(limit);
  if (limit < 1 || limit > 100 || before < 1) fail('INVALID_HISTORY_PAGE', 'Invalid history page.');
  const rows = store.all(`SELECT cursor,aggregate_kind AS kind,aggregate_id AS id,aggregate_revision AS revision,type,value_json,
    (SELECT p.value_json FROM events p WHERE p.project_id=e.project_id AND p.aggregate_kind=e.aggregate_kind AND p.aggregate_id=e.aggregate_id AND p.cursor<e.cursor ORDER BY p.cursor DESC LIMIT 1) AS previous_json
    FROM events e WHERE project_id=? AND cursor<? ORDER BY cursor DESC LIMIT ?`,projectId,before,limit+1);
  const entries = rows.slice(0,limit).map(row => {
    const value = JSON.parse(row.value_json), previous = row.previous_json ? JSON.parse(row.previous_json) : null;
    return { cursor:row.cursor, revision:row.revision, type:row.type, aggregate:{kind:row.kind,id:row.id}, label:labels[row.type] ?? '제작 기록', summary:summary(row.type,value,previous) };
  });
  return { entries, nextBefore:rows.length > limit ? entries.at(-1).cursor : null };
}
