/** lore_preferences: record, retire and list the user's scoped creative preferences. No model call. */
import {
  adoptCreativeDecision, creativeDecisionStatus, creativeDecisionView, retireCreativeDecision,
} from '../core/creative-decision-ledger.js';

const SOFT = '선호는 이번 화 workflow의 초고와 모든 수정에 부드러운 지침으로 들어가고, 논리 검토(coherence-judge)가 지켜졌는지 advisory로만 알립니다. 정본 사실과 이번 화 계획이 우선하며 선호만으로는 수정하지 않습니다.';
const CHANGED = `${SOFT} 진행 중인 원고가 있으면 다음 lore_write가 같은 원고를 바뀐 선호로 다시 검사합니다(다시 쓰지 않음).`;
const STATUS = `${SOFT} 범위를 넓히거나 바꾸려면 사용자에게 다시 확인한 뒤 adopt(supersedes)나 retire를 호출하세요.`;

// A typo in workId must not create a ledger for a work that is not here (same message as the neighbouring write tools).
async function requireWork(store, workId) {
  const foundation = await store.loadFoundation(workId);
  if (!foundation || foundation.workId !== workId) throw new Error('이 디렉터리에 작품이 없습니다. 먼저 lore_init 을 실행하세요.');
  return foundation;
}

export async function runCreativeDecisionTool({ store, workId, action, statement, userAnswer, level, subjectId, kind, topic, authority, supersedes, id,
  now = () => new Date().toISOString() }) {
  if (action === 'status') return { ...creativeDecisionStatus(await store.loadCreativeDecisions(workId), workId), nextAction: STATUS };
  if (action === 'adopt') {
    const foundation = await requireWork(store, workId);
    const { ledger, adopted, retired } = adoptCreativeDecision(await store.loadCreativeDecisions(workId),
      { statement, userAnswer, level, subjectId: subjectId === '' ? null : subjectId, kind, topic, authority, supersedes },
      { workId, at: now(), characterIds: (foundation.characters ?? []).map((character) => character.id) });
    await store.saveCreativeDecisions(workId, ledger);
    return { revision: ledger.revision, adopted: creativeDecisionView(adopted),
      ...(retired ? { retired: creativeDecisionView(retired) } : {}), nextAction: CHANGED };
  }
  if (action === 'retire') {
    await requireWork(store, workId);
    const { ledger, retired } = retireCreativeDecision(await store.loadCreativeDecisions(workId), { id }, { workId, at: now() });
    await store.saveCreativeDecisions(workId, ledger);
    return { revision: ledger.revision, retired: creativeDecisionView(retired), nextAction: CHANGED };
  }
  throw new Error('INVALID_ARGUMENT: action must be adopt, retire or status');
}
