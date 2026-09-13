import { asKit, promptKit } from '../prompts/index.js';
import { resolveWorkLanguage } from '../core/work-language.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const parse = (raw) => { try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); } catch { return null; } };
const text = (v, max = 800) => String(v ?? '').trim().slice(0, max);
const list = (v, max = 8) => Array.isArray(v) ? v.map((x) => text(x, 500)).filter(Boolean).slice(0, max) : [];

function normalizeCandidate(raw, index, kit) {
  return {
    id: text(raw?.id || `writer-${index + 1}`, 80), name: text(raw?.name || kit.phrases.writer.candidateName(index + 1), 120),
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
  const workLanguage = await resolveWorkLanguage({ store, workId, foundation });
  const kit = promptKit({ contract: workLanguage.contract });
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'writer-skill', messages: kit.messages('writer-skill', {
    workJson: JSON.stringify({ title: foundation.title, brief: foundation.brief, genre: profile?.genreLabel, worldFacts: foundation.worldFacts.map((f) => f.statement), characters: foundation.characters.map((c) => ({ id:c.id,name:c.canonicalName,contradiction:c.contradiction })), spine }),
    feedback: feedback || kit.phrases.common.noneParen,
  }) });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true, operation: 'writer-skill' };
  const obj = parse(response.text); const candidates = (obj?.candidates ?? []).map((raw, index) => normalizeCandidate(raw, index, kit));
  if (candidates.length !== 3) throw new Error(`WriterSkill은 유효한 후보 3개가 필요합니다. 받은 후보 ${candidates.length}개.`);
  const invalid = candidates.map((c) => ({ name: c.name, violations: writerSkillViolations(c) })).filter((c) => c.violations.length);
  if (invalid.length) throw new Error(`WriterSkill은 유효한 후보 3개가 필요합니다. ${invalid.map((c) => `${c.name}: ${c.violations.map((v) => v.message).join(' ')}`).join(' / ')}`);
  const judged = await providers.complete({ model: MODEL, jsonMode: true, step: 'writer-skill-audition', messages: kit.messages('writer-skill-audition', {
    candidatesJson: JSON.stringify(candidates.map((c) => ({ id:c.id, audition:c.audition, skill:{ aestheticThesis:c.aestheticThesis, coreAttention:c.coreAttention, sceneTransformations:c.sceneTransformations, antiFixation:c.antiFixation } }))),
  }) });
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

export function createDifferenceContract({ skill, episodePlan, chapter, recentPatterns = [], kit: kitSource }) {
  const t = asKit(kitSource).phrases.writer;
  const recent = recentPatterns.slice(-3).filter(Boolean);
  const usedSolutions = recent.map((p) => typeof p === 'string' ? p : p.solutionPattern).filter(Boolean);
  const usedMethods = recent.map((p) => typeof p === 'object' ? p.protagonistMethod : '').filter(Boolean);
  const owners = recent.flatMap((p) => typeof p === 'object' ? Object.keys(p.supportingAgency ?? {}) : []);
  const sources = skill?.storyDramaturgy?.conflictSources ?? [];
  return {
    previousSolutionShapes: [...new Set(usedSolutions)].slice(-3),
    forbiddenRepeat: usedSolutions.slice(-2).join(' → ') || t.differenceForbiddenFallback,
    episodeEngine: sources.length ? sources[(chapter - 1) % sources.length] : episodePlan.scenePressure?.incompatibleGoods?.join(' vs ') || episodePlan.premise,
    protagonistMustMisread: skill?.storyDramaturgy?.protagonistError || t.differenceMisreadFallback,
    agencyOwnerConstraint: owners.length ? t.differenceAgencyOwner(owners.at(-1)) : t.differenceAgencyFallback,
    methodToAvoid: usedMethods.at(-1) || '',
    expectationBefore: episodePlan.readerExpectation?.likelyOutcome || episodePlan.entryState?.activeQuestion || t.differenceExpectationBefore,
    expectationAfter: episodePlan.turn?.brokenBelief || episodePlan.costCreatedByResolution?.immediate || t.differenceExpectationAfter,
  };
}

export function compileWriterPacket({ skill, episodePlan, chapter, recentPatterns = [], kit: kitSource }) {
  if (!skill || skill.status !== 'active') return '';
  const kit = asKit(kitSource);
  const t = kit.phrases.writer;
  const rotate = (values, count, offset) => Array.from({ length: Math.min(count, values.length) }, (_, i) => values[(offset + i) % values.length]);
  const craft = skill.authorCraft ?? {};
  const attention = rotate(craft.judgments?.length ? craft.judgments : skill.coreAttention, 2, (chapter - 1) * 2);
  const transforms = rotate(craft.omissions?.length ? craft.omissions : skill.sceneTransformations, 1, chapter - 1);
  const anti = rotate(skill.antiFixation, 1, chapter - 1);
  const freedom = rotate(skill.discoverySpaces, 1, chapter - 1);
  const contract = createDifferenceContract({ skill, episodePlan, chapter, recentPatterns, kit });
  return [
    t.packetHeading,
    t.expectationBefore(contract.expectationBefore),
    t.expectationAfter(contract.expectationAfter),
    t.conflictingValues(episodePlan.scenePressure?.incompatibleGoods?.join(' vs ') || t.conflictingValuesFallback),
    t.incompleteAttempt(episodePlan.turn?.brokenBelief || episodePlan.premise),
    t.payoff(episodePlan.payoff?.promisePaid || t.payoffFallback),
    t.resolutionCost(episodePlan.costCreatedByResolution?.immediate || episodePlan.costCreatedByResolution?.deferred || t.resolutionCostFallback),
    episodePlan.characterArcBeats?.length ? t.characterChange(episodePlan.characterArcBeats.map((b) => `${b.characterId}=${b.beat}(${b.note})`).join('; ')) : '',
    t.craftHeading, ...attention.map((v) => `  - ${v}`), ...transforms.map((v) => `  - ${v}`),
    t.episodeEngine(contract.episodeEngine),
    t.mustMisread(contract.protagonistMustMisread),
    t.turnOwner(contract.agencyOwnerConstraint),
    t.forbiddenRepeat(contract.forbiddenRepeat),
    contract.methodToAvoid ? t.methodToAvoid(contract.methodToAvoid) : '',
    t.antiFixation(anti[0] || t.antiFixationFallback),
    t.selfBetrayal(rotate(craft.selfBetrayal ?? [], 1, chapter - 1)[0] || t.selfBetrayalFallback),
    t.freedom(freedom[0] || t.freedomFallback),
    t.packetFooter,
  ].filter(Boolean).join('\n');
}

/** WriterSkill-only projection. Episode obligations belong to WriterEpisodePacket. */
export function compileAuthorCraftPacket({ skill, episodePlan, chapter, recentPatterns = [], kit: kitSource }) {
  if (!skill || skill.status !== 'active') return '';
  const t = asKit(kitSource).phrases.writer;
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
    t.craftPacketHeading,
    t.craftHeading, ...attention.map((value) => `  - ${value}`), ...transforms.map((value) => `  - ${value}`),
    repeatedSolutions.length ? t.repeatedSolutions(repeatedSolutions.join(' → ')) : '',
    t.antiFixation(anti[0] || t.antiFixationFallback),
    t.freedom(freedom[0] || t.freedomFallback),
    t.craftPacketFooter,
  ].filter(Boolean).join('\n');
}
