const MODEL = { provider: 'host', modelId: 'host-agent' };
const parse = (raw) => { try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); } catch { return null; } };
const text = (v, max = 800) => String(v ?? '').trim().slice(0, max);
const list = (v, max = 8) => Array.isArray(v) ? v.map((x) => text(x, 500)).filter(Boolean).slice(0, max) : [];

function normalizeCandidate(raw, index) {
  return {
    id: text(raw?.id || `writer-${index + 1}`, 80), name: text(raw?.name || `작가 후보 ${index + 1}`, 120),
    aestheticThesis: text(raw?.aestheticThesis), coreAttention: list(raw?.coreAttention, 6),
    sceneTransformations: list(raw?.sceneTransformations, 8), withholdingInstinct: list(raw?.withholdingInstinct, 5),
    payoffInstinct: list(raw?.payoffInstinct, 5), antiFixation: list(raw?.antiFixation, 8),
    discoverySpaces: list(raw?.discoverySpaces, 5), audition: text(raw?.audition, 3000),
    authorCraft: {
      judgments: list(raw?.authorCraft?.judgments, 6), omissions: list(raw?.authorCraft?.omissions, 5),
      dialogueConduct: list(raw?.authorCraft?.dialogueConduct, 5), selfBetrayal: list(raw?.authorCraft?.selfBetrayal, 5),
    },
    storyDramaturgy: {
      conflictSources: list(raw?.storyDramaturgy?.conflictSources, 6), escalationLaws: list(raw?.storyDramaturgy?.escalationLaws, 5),
      protagonistError: text(raw?.storyDramaturgy?.protagonistError), oppositionAdaptation: list(raw?.storyDramaturgy?.oppositionAdaptation, 5),
    },
  };
}

export function writerSkillViolations(skill) {
  const violations = [];
  if (!skill?.aestheticThesis) violations.push({ code: 'WRITER_THESIS_MISSING', message: '작가의 미학적 판단축이 없다.' });
  if ((skill?.coreAttention?.length ?? 0) < 2) violations.push({ code: 'WRITER_ATTENTION_THIN', message: '핵심 관찰 습관이 최소 2개 필요하다.' });
  if ((skill?.sceneTransformations?.length ?? 0) < 3) violations.push({ code: 'WRITER_TRANSFORM_THIN', message: '재료를 장면으로 바꾸는 기술이 최소 3개 필요하다.' });
  if ((skill?.antiFixation?.length ?? 0) < 2) violations.push({ code: 'WRITER_FIXATION_GUARD_THIN', message: '개성이 틱으로 굳는 것을 막는 규칙이 최소 2개 필요하다.' });
  if ((skill?.discoverySpaces?.length ?? 0) < 1) violations.push({ code: 'WRITER_FREEDOM_MISSING', message: '작가가 장면에서 발견할 자유 영역이 없다.' });
  if ((skill?.authorCraft?.judgments?.length ?? 0) < 3) violations.push({ code: 'AUTHOR_JUDGMENT_THIN', message: '사건 레시피가 아닌 작가 판단 원칙이 최소 3개 필요하다.' });
  if ((skill?.authorCraft?.selfBetrayal?.length ?? 0) < 1) violations.push({ code: 'AUTHOR_SELF_BETRAYAL_MISSING', message: '작가 자신의 장기를 배반할 원칙이 필요하다.' });
  if ((skill?.storyDramaturgy?.conflictSources?.length ?? 0) < 2) violations.push({ code: 'DRAMATURGY_CONFLICT_THIN', message: '서로 다른 사건 발생 원천이 최소 2개 필요하다.' });
  if (!skill?.storyDramaturgy?.protagonistError) violations.push({ code: 'DRAMATURGY_ERROR_MISSING', message: '주인공의 반복 오류가 필요하다.' });
  return violations;
}

export async function runWriterSkill({ store, workId, mode = 'review', feedback = '', providers }) {
  const foundation = await store.loadFoundation(workId); const spine = await store.loadStorySpine(workId); const profile = await store.loadStoryProfile(workId);
  if (!foundation || !spine || spine.status !== 'active') throw new Error('승인된 세계·인물·StorySpine이 필요합니다.');
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'writer-skill', messages: [
    { role: 'system', content: '당신은 실제 작가의 문체를 모사하지 않고 깊은 창작 판단 체계를 설계한다. 장면 레시피를 작가 개성으로 포장하지 않는다. AuthorCraft에는 여러 사건에서도 같은 결과를 강요하지 않는 판단·생략·대사·자기배반 원칙을 둔다. StoryDramaturgy에는 이 작품만의 서로 다른 갈등 원천, 확대 법칙, 주인공의 반복 오류, 적대자의 적응을 둔다. 해결 절차나 고정된 반전 순서는 금지한다. audition은 동일한 첫 위기를 500~800자 산문으로 시연한다. 순수 JSON만 출력한다.' },
    { role: 'user', content: `작품: ${JSON.stringify({ title: foundation.title, brief: foundation.brief, genre: profile?.genreLabel, worldFacts: foundation.worldFacts.map((f) => f.statement), characters: foundation.characters.map((c) => ({ id:c.id,name:c.canonicalName,contradiction:c.contradiction })), spine })}\n피드백: ${feedback || '(없음)'}\n서로 다른 후보 정확히 3개. JSON: {"candidates":[{"id":"","name":"","aestheticThesis":"","coreAttention":[""],"sceneTransformations":[""],"withholdingInstinct":[""],"payoffInstinct":[""],"antiFixation":[""],"discoverySpaces":["정답이 아니라 열린 질문"],"authorCraft":{"judgments":[""],"omissions":[""],"dialogueConduct":[""],"selfBetrayal":[""]},"storyDramaturgy":{"conflictSources":[""],"escalationLaws":[""],"protagonistError":"","oppositionAdaptation":[""]},"audition":"500~800자 산문"}]}` },
  ] });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true, operation: 'writer-skill' };
  const obj = parse(response.text); const candidates = (obj?.candidates ?? []).map(normalizeCandidate);
  if (candidates.length !== 3 || candidates.some((c) => writerSkillViolations(c).length)) throw new Error('WriterSkill은 유효한 후보 3개가 필요합니다.');
  const judged = await providers.complete({ model: MODEL, jsonMode: true, step: 'writer-skill-audition', messages: [
    { role: 'system', content: '한국 상업 웹소설의 블라인드 작가 오디션 심사자다. 설정 준수보다 첫 문단의 견인, 장면 속 정보, 대사 서브텍스트, 예측 불가능한 인물 선택, 여러 화로 변주 가능한 판단 습관을 평가한다. 한 가지 틱을 반복할 후보와 추상 조언뿐인 후보를 탈락시킨다. 순수 JSON만 출력한다.' },
    { role: 'user', content: `후보: ${JSON.stringify(candidates.map((c) => ({ id:c.id, audition:c.audition, skill:{ aestheticThesis:c.aestheticThesis, coreAttention:c.coreAttention, sceneTransformations:c.sceneTransformations, antiFixation:c.antiFixation } })))}\nJSON: {"winnerId":"","scores":[{"id":"","scenePower":0,"subtext":0,"characterAgency":0,"range":0,"antiFixation":0,"reason":""}]}` },
  ] });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true, operation: 'writer-skill-audition' };
  const verdict = parse(judged.text); const winner = candidates.find((c) => c.id === verdict?.winnerId);
  if (!winner) throw new Error('WriterSkill 오디션이 유효한 우승 후보를 선택하지 못했습니다.');
  const skill = { ...winner, workId, status: mode === 'auto' ? 'active' : 'pending', selectedCandidate: winner.id, auditionScores: verdict.scores ?? [], candidates, revision: 1, createdAt: new Date().toISOString() };
  await store.saveWriterSkill(workId, skill); return { skill, candidates, needsApproval: skill.status === 'pending' };
}

export async function runWriterSkillDecide({ store, workId, action }) {
  const skill = await store.loadWriterSkill(workId); if (!skill) throw new Error('검토할 WriterSkill이 없습니다.');
  const status = action === 'approve' ? 'active' : action === 'reject' ? 'rejected' : null; if (!status) throw new Error('action은 approve 또는 reject여야 합니다.');
  const next = { ...skill, status }; await store.saveWriterSkill(workId, next); return { approved: status === 'active', skill: next };
}
export async function runWriterSkillStatus({ store, workId }) { const skill = await store.loadWriterSkill(workId); return skill ? { planned:true, skill } : { planned:false }; }

export function createDifferenceContract({ skill, episodePlan, chapter, recentPatterns = [] }) {
  const recent = recentPatterns.slice(-3).filter(Boolean);
  const usedSolutions = recent.map((p) => typeof p === 'string' ? p : p.solutionPattern).filter(Boolean);
  const usedMethods = recent.map((p) => typeof p === 'object' ? p.protagonistMethod : '').filter(Boolean);
  const owners = recent.flatMap((p) => typeof p === 'object' ? Object.keys(p.supportingAgency ?? {}) : []);
  const sources = skill?.storyDramaturgy?.conflictSources ?? [];
  return {
    previousSolutionShapes: [...new Set(usedSolutions)].slice(-3),
    forbiddenRepeat: usedSolutions.slice(-2).join(' → ') || '직전 화와 같은 발견·해결 순서',
    episodeEngine: sources.length ? sources[(chapter - 1) % sources.length] : episodePlan.scenePressure?.incompatibleGoods?.join(' vs ') || episodePlan.premise,
    protagonistMustMisread: skill?.storyDramaturgy?.protagonistError || '주인공의 전문성이 적어도 한 가지를 놓친다',
    agencyOwnerConstraint: owners.length ? `${owners.at(-1)} 이외의 인물이 독립 선택으로 전환을 만든다` : '주인공 이외 인물의 독립 선택이 장면을 바꾼다',
    methodToAvoid: usedMethods.at(-1) || '',
    expectationBefore: episodePlan.readerExpectation?.likelyOutcome || episodePlan.entryState?.activeQuestion || '장면에서 형성',
    expectationAfter: episodePlan.turn?.brokenBelief || episodePlan.costCreatedByResolution?.immediate || '기존 해석이 불충분해진다',
  };
}

export function compileWriterPacket({ skill, episodePlan, chapter, recentPatterns = [] }) {
  if (!skill || skill.status !== 'active') return '';
  const rotate = (values, count, offset) => Array.from({ length: Math.min(count, values.length) }, (_, i) => values[(offset + i) % values.length]);
  const craft = skill.authorCraft ?? {};
  const attention = rotate(craft.judgments?.length ? craft.judgments : skill.coreAttention, 2, (chapter - 1) * 2);
  const transforms = rotate(craft.omissions?.length ? craft.omissions : skill.sceneTransformations, 1, chapter - 1);
  const anti = rotate(skill.antiFixation, 1, chapter - 1);
  const freedom = rotate(skill.discoverySpaces, 1, chapter - 1);
  const contract = createDifferenceContract({ skill, episodePlan, chapter, recentPatterns });
  return [
    '## 이번 화 Writer Packet',
    `- 독자의 기존 예상: ${contract.expectationBefore}`,
    `- 이번 화 뒤 달라질 해석: ${contract.expectationAfter}`,
    `- 충돌하는 가치: ${episodePlan.scenePressure?.incompatibleGoods?.join(' vs ') || '인물 욕망 두 개'}`,
    `- 불완전한 시도: ${episodePlan.turn?.brokenBelief || episodePlan.premise}`,
    `- 지급할 결과: ${episodePlan.payoff?.promisePaid || '작은 결과 하나'}`,
    `- 해결이 만드는 비용: ${episodePlan.costCreatedByResolution?.immediate || episodePlan.costCreatedByResolution?.deferred || '새 비용 하나'}`,
    episodePlan.characterArcBeats?.length ? `- 이번 화 인물 변화: ${episodePlan.characterArcBeats.map((b) => `${b.characterId}=${b.beat}(${b.note})`).join('; ')}` : '',
    '- 이번 화에 활성화할 작가적 판단:', ...attention.map((v) => `  - ${v}`), ...transforms.map((v) => `  - ${v}`),
    `- 이번 화 사건 원천: ${contract.episodeEngine}`,
    `- 주인공이 놓쳐야 하는 것: ${contract.protagonistMustMisread}`,
    `- 전환의 소유자: ${contract.agencyOwnerConstraint}`,
    `- 금지된 해결 반복: ${contract.forbiddenRepeat}`,
    contract.methodToAvoid ? `- 직전 주인공 방식도 재사용 금지: ${contract.methodToAvoid}` : '',
    `- 이번 화의 고착 방지: ${anti[0] || '같은 해결 순서를 반복하지 않는다'}`,
    `- 자기 장기 배반: ${rotate(craft.selfBetrayal ?? [], 1, chapter - 1)[0] || '익숙한 장기가 예상되는 순간 그 장기의 부작용을 드러낸다'}`,
    `- 작가에게 남기는 자유: ${freedom[0] || '정확한 행동과 대사는 장면에서 발견한다'}`,
    '- 위 결과를 설명하지 말고 장면에서 발견하라. 전체 아크의 정답을 요약하지 마라.',
  ].filter(Boolean).join('\n');
}

/** WriterSkill-only projection. Episode obligations belong to WriterEpisodePacket. */
export function compileAuthorCraftPacket({ skill, episodePlan, chapter, recentPatterns = [] }) {
  if (!skill || skill.status !== 'active') return '';
  const rotate = (values, count, offset) => Array.from({ length: Math.min(count, values?.length ?? 0) }, (_, i) => values[(offset + i) % values.length]);
  const craft = skill.authorCraft ?? {};
  const attention = rotate(craft.judgments?.length ? craft.judgments : skill.coreAttention, 2, (chapter - 1) * 2);
  const transforms = rotate(craft.omissions?.length ? craft.omissions : skill.sceneTransformations, 1, chapter - 1);
  const anti = rotate(skill.antiFixation, 1, chapter - 1);
  const freedom = rotate(skill.discoverySpaces, 1, chapter - 1);
  const repeatedSolutions = recentPatterns.slice(-2)
    .map((pattern) => typeof pattern === 'string' ? pattern : pattern?.solutionPattern)
    .filter(Boolean);
  return [
    '## 이번 화 Author Craft Packet',
    '- 이번 화에 활성화할 작가적 판단:', ...attention.map((value) => `  - ${value}`), ...transforms.map((value) => `  - ${value}`),
    repeatedSolutions.length ? `- 직전 해결 형태를 그대로 반복하지 않는다: ${repeatedSolutions.join(' → ')}` : '',
    `- 이번 화의 고착 방지: ${anti[0] || '같은 해결 순서를 반복하지 않는다'}`,
    `- 작가에게 남기는 자유: ${freedom[0] || '정확한 행동과 대사는 장면에서 발견한다'}`,
    '- 이것은 모든 항목을 장면마다 증명할 체크리스트가 아니다. 회차의 즉시 목표와 결과를 해치지 않는 범위에서 필요한 판단만 사용한다.',
  ].filter(Boolean).join('\n');
}
