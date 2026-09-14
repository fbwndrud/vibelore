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

async function judge({ foundation, spine, providers }) {
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'story-spine-quality', messages: [
    { role: 'system', content: '당신은 한국 상업 장편소설의 스토리 스파인 심사자다. 설정의 매력이 아니라 사건의 인과적 필연성을 본다. 앞 사건을 삭제해도 뒤 사건이 그대로면 감점한다. 주인공의 최초 해법이 실패를 낳고, 그 실패가 더 큰 문제의 원인이 되며, 중간 재해석이 앞 단서의 의미를 바꾸고, 주변 인물의 독립 욕망이 플롯을 꺾고, 마지막 선택의 양쪽 모두 실제 손실이 있어야 한다. 순수 JSON만 출력한다.' },
    { role: 'user', content: `세계·인물:\n${JSON.stringify(foundation)}\n\nStorySpine:\n${JSON.stringify(spine)}\n\nJSON: {"dimensions":{"causalNecessity":0,"protagonistError":0,"expectationReframe":0,"characterAgency":0,"finalChoiceCost":0,"endingTransformation":0},"findings":[{"code":"REMOVABLE_LINK|CORRECT_FROM_START|INFO_ONLY_TWIST|PASSIVE_CAST|FALSE_CHOICE|UNCHANGED_ENDING","message":"근거와 수정 방향"}]}` },
  ] });
  if ((providers.pending?.length ?? 0) > 0) return null;
  const obj = parse(response.text);
  const dimensions = obj?.dimensions ?? {};
  const scores = DIMS.map((key) => Number(dimensions[key]));
  if (scores.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) throw new Error('StorySpine 품질 심사의 6개 차원 점수가 유효하지 않습니다.');
  const score = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const weakDimensions = DIMS.filter((key) => Number(dimensions[key]) < 65);
  return { score, dimensions, weakDimensions, findings: Array.isArray(obj.findings) ? obj.findings.slice(0, 12) : [], verdict: score >= 75 && weakDimensions.length === 0 ? 'passed' : 'failed' };
}

export async function runStorySpine({ store, workId, mode = 'review', direction = '', feedback = '', providers }) {
  const foundation = await store.loadFoundation(workId);
  const profile = await store.loadStoryProfile(workId);
  if (!foundation) throw new Error('세계와 인물을 먼저 생성하세요.');
  if (!profile || profile.status !== 'active') throw new Error('승인된 StoryProfile이 필요합니다.');
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'story-spine', messages: [
    { role: 'system', content: '세계관 설명이나 사건 목록이 아니라 작품 전체의 인과적 StorySpine을 설계한다. 주인공의 잘못된 믿음에서 나온 최초 해법이 실제 실패를 만들고, 그 해결이 다음 문제의 원인이 되게 하라. 주변 인물은 독립 욕망으로 플롯을 바꾸며, 중간 재해석은 앞 단서의 의미를 뒤집는다. 마지막 선택은 양쪽 모두 대가가 있고 결말 변화는 그 선택으로 증명한다. 순수 JSON만 출력한다.' },
    { role: 'user', content: `작품:\n${JSON.stringify({ foundation, profile })}\n방향: ${direction || foundation.brief || '(자율)'}\n피드백: ${feedback || '(없음)'}\nJSON: {"dramaticQuestion":"","protagonistWant":"","protagonistNeed":"","falseBelief":"","incitingDisruption":"","initialStrategy":"","causalChain":["최소 5단계"],"midpointReframe":"","finalChoice":"","endingChange":"","endingCost":"","characterForces":[{"characterId":"실제 id","want":"","actionThatChangesPlot":""}]}` },
  ] });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true, operation: 'story-spine' };
  const obj = parse(response.text);
  if (!obj) throw new Error('StorySpine 응답을 해석할 수 없습니다.');
  const spine = normalize(obj, workId, mode);
  const structural = deterministicStorySpineViolations(spine);
  if (structural.length) throw new Error(`StorySpine 구조 검증 실패: ${structural.map((v) => v.message).join(' ')}`);
  const quality = await judge({ foundation, spine, providers });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true, operation: 'story-spine-quality' };
  if (quality.verdict !== 'passed') throw new Error(`StorySpine 품질 검증 실패: ${quality.findings.map((f) => f.message).join(' ') || quality.weakDimensions.join(', ')}`);
  spine.quality = quality;
  spine.createdAt = new Date().toISOString();
  await store.saveStorySpine(workId, spine);
  return { spine, needsApproval: spine.status === 'pending' };
}

export async function runStorySpineDecide({ store, workId, action }) {
  const spine = await store.loadStorySpine(workId);
  if (!spine) throw new Error('검토할 StorySpine이 없습니다.');
  const status = action === 'approve' ? 'active' : action === 'reject' ? 'rejected' : null;
  if (!status) throw new Error('action은 approve 또는 reject여야 합니다.');
  const next = { ...spine, status, [`${status === 'active' ? 'approved' : 'rejected'}At`]: new Date().toISOString() };
  await store.saveStorySpine(workId, next);
  return { approved: status === 'active', spine: next };
}

export async function runStorySpineStatus({ store, workId }) {
  const spine = await store.loadStorySpine(workId);
  return spine ? { planned: true, spine } : { planned: false };
}

export function renderStorySpine(spine) {
  if (!spine || spine.status !== 'active') return '';
  return [`## 승인된 작품 StorySpine`, `- 극적 질문: ${spine.dramaticQuestion}`, `- 욕망/필요: ${spine.protagonistWant} / ${spine.protagonistNeed}`, `- 잘못된 믿음: ${spine.falseBelief}`, `- 최초 해법: ${spine.initialStrategy}`, `- 인과 사슬: ${spine.causalChain.join(' → ')}`, `- 중간 재해석: ${spine.midpointReframe}`, `- 최종 선택과 비용: ${spine.finalChoice} / ${spine.endingCost}`, `- 결말 변화: ${spine.endingChange}`].join('\n');
}
