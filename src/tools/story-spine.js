import { gateApprovalActivation } from '../core/approval-language-gate.js';
import { asKit, promptKit } from '../prompts/index.js';
import { resolveWorkLanguage } from '../core/work-language.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const DIMS = ['causalNecessity', 'protagonistError', 'expectationReframe', 'characterAgency', 'finalChoiceCost', 'endingTransformation'];

const parse = (raw) => { try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); } catch { return null; } };
const text = (value, max = 900) => String(value ?? '').trim().slice(0, max);
const list = (value, max = 12) => Array.isArray(value) ? value.map((v) => text(v)).filter(Boolean).slice(0, max) : [];

function normalize(obj, workId, mode) {
  return {
    workId, status: mode === 'auto' ? 'active' : 'pending',
    dramaticQuestion: text(obj.dramaticQuestion), protagonistWant: text(obj.protagonistWant), protagonistNeed: text(obj.protagonistNeed),
    falseBelief: text(obj.falseBelief), incitingDisruption: text(obj.incitingDisruption), initialStrategy: text(obj.initialStrategy),
    causalChain: list(obj.causalChain), midpointReframe: text(obj.midpointReframe), finalChoice: text(obj.finalChoice),
    endingChange: text(obj.endingChange), endingCost: text(obj.endingCost),
    characterForces: (Array.isArray(obj.characterForces) ? obj.characterForces : []).map((row) => ({ characterId: text(row?.characterId, 120), want: text(row?.want), actionThatChangesPlot: text(row?.actionThatChangesPlot) })).filter((r) => r.characterId && r.want && r.actionThatChangesPlot).slice(0, 8),
  };
}

export function deterministicStorySpineViolations(spine) {
  const required = ['dramaticQuestion','protagonistWant','protagonistNeed','falseBelief','incitingDisruption','initialStrategy','midpointReframe','finalChoice','endingChange','endingCost'];
  const violations = required.filter((key) => !spine?.[key]).map((key) => ({ code: 'SPINE_FIELD_MISSING', message: `${key}가 비어 있다.` }));
  if ((spine?.causalChain?.length ?? 0) < 5) violations.push({ code: 'SPINE_CAUSAL_CHAIN_THIN', message: '인과 사슬은 최소 5단계여야 한다.' });
  if ((spine?.characterForces?.length ?? 0) < 2) violations.push({ code: 'SPINE_CHARACTER_AGENCY_THIN', message: '플롯을 바꾸는 인물 힘이 최소 2개 필요하다.' });
  return violations;
}

async function judge({ foundation, spine, providers, kit }) {
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'story-spine-quality', messages: kit.messages('story-spine-quality', {
    foundationJson: JSON.stringify(foundation), spineJson: JSON.stringify(spine),
  }) });
  if ((providers.pending?.length ?? 0) > 0) return null;
  const obj = parse(response.text);
  const dimensions = obj?.dimensions ?? {};
  const scores = DIMS.map((key) => Number(dimensions[key]));
  if (scores.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) throw new Error('StorySpine 품질 심사의 6개 차원 점수가 유효하지 않습니다.');
  // 1~5점 척도 응답은 내용과 무관하게 전 차원이 65 미만으로 떨어지므로 척도 오류로 따로 거절한다.
  if (scores.every((n) => n <= 5)) throw new Error('StorySpine 품질 심사 점수가 0~100 척도가 아닙니다. 6개 차원을 0~100 정수로 다시 채점하세요.');
  const score = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const weakDimensions = DIMS.filter((key) => Number(dimensions[key]) < 65);
  return { score, dimensions, weakDimensions, findings: Array.isArray(obj.findings) ? obj.findings.slice(0, 12) : [], verdict: score >= 75 && weakDimensions.length === 0 ? 'passed' : 'failed' };
}

export async function runStorySpine({ store, workId, mode = 'review', direction = '', feedback = '', providers, retryValidation = false }) {
  const foundation = await store.loadFoundation(workId);
  const profile = await store.loadStoryProfile(workId);
  if (!foundation) throw new Error('세계와 인물을 먼저 생성하세요.');
  if (!profile || profile.status !== 'active') throw new Error('승인된 StoryProfile이 필요합니다.');
  const workLanguage = await resolveWorkLanguage({ store, workId, foundation });
  const kit = promptKit({ contract: workLanguage.contract });
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'story-spine', messages: kit.messages('story-spine', {
    workJson: JSON.stringify({ foundation, profile }),
    direction: direction || foundation.brief || kit.phrases.common.autonomousShort,
    feedback: feedback || kit.phrases.common.noneParen,
  }) });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true, operation: 'story-spine' };
  const obj = parse(response.text);
  if (!obj) throw new Error('StorySpine 응답을 해석할 수 없습니다.');
  const spine = normalize(obj, workId, mode);
  const structural = deterministicStorySpineViolations(spine);
  if (structural.length) throw new Error(`StorySpine 구조 검증 실패: ${structural.map((v) => v.message).join(' ')}`);
  const quality = await judge({ foundation, spine, providers, kit });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true, operation: 'story-spine-quality' };
  if (quality.verdict !== 'passed') throw new Error(`StorySpine 품질 검증 실패: ${quality.findings.map((f) => f.message).join(' ') || quality.weakDimensions.join(', ')}`);
  spine.quality = quality;
  spine.createdAt = new Date().toISOString();
  const approval = await gateApprovalActivation({ store, workId, kind: 'story', stateKey: 'spine', value: spine, providers, resolution: workLanguage, structuralErrors: deterministicStorySpineViolations(spine), retryValidation });
  if (!approval.ok) return { ...approval, candidate: spine };
  await store.saveStorySpine(workId, spine);
  return { spine, needsApproval: spine.status === 'pending' };
}

export async function runStorySpineDecide({ store, workId, action, providers, retryValidation = false }) {
  const spine = await store.loadStorySpine(workId);
  if (!spine) throw new Error('검토할 StorySpine이 없습니다.');
  const status = action === 'approve' ? 'active' : action === 'reject' ? 'rejected' : null;
  if (!status) throw new Error('action은 approve 또는 reject여야 합니다.');
  const next = { ...spine, status, [`${status === 'active' ? 'approved' : 'rejected'}At`]: new Date().toISOString() };
  if (status === 'active') {
    const approval = await gateApprovalActivation({ store, workId, kind: 'story', stateKey: 'spine', value: next, providers, consumeOnly: true, structuralErrors: deterministicStorySpineViolations(next), retryValidation });
    if (!approval.ok) return { ...approval, approved: false };
  }
  await store.saveStorySpine(workId, next);
  return { approved: status === 'active', spine: next };
}

export async function runStorySpineStatus({ store, workId }) {
  const spine = await store.loadStorySpine(workId);
  return spine ? { planned: true, spine } : { planned: false };
}

export function renderStorySpine(spine, kitSource) {
  if (!spine || spine.status !== 'active') return '';
  const t = asKit(kitSource).phrases.spine;
  return [t.heading, t.dramaticQuestion(spine.dramaticQuestion), t.wantNeed(spine.protagonistWant, spine.protagonistNeed), t.falseBelief(spine.falseBelief), t.initialStrategy(spine.initialStrategy), t.causalChain(spine.causalChain.join(' → ')), t.midpointReframe(spine.midpointReframe), t.finalChoice(spine.finalChoice, spine.endingCost), t.endingChange(spine.endingChange)].join('\n');
}
