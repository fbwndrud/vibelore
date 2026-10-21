import { bulletSection, formatDocument, section } from '../md/frontmatter.js';

/** Shared by managed saves and read-only checks of legacy materialization. */
export function renderStorySpineDocument(workId, spine) {
  const body = [
    section('극적 질문', spine.dramaticQuestion ?? ''),
    section('주인공의 욕망과 필요', `욕망: ${spine.protagonistWant ?? ''}\n\n필요: ${spine.protagonistNeed ?? ''}`),
    section('잘못된 믿음과 최초 해법', `잘못된 믿음: ${spine.falseBelief ?? ''}\n\n최초 해법: ${spine.initialStrategy ?? ''}`),
    bulletSection('인과 사슬', spine.causalChain ?? []),
    section('중간 재해석', spine.midpointReframe ?? ''),
    section('최종 선택과 결말 비용', `선택: ${spine.finalChoice ?? ''}\n\n비용: ${spine.endingCost ?? ''}\n\n변화: ${spine.endingChange ?? ''}`),
    bulletSection('플롯을 바꾸는 인물 힘', (spine.characterForces ?? []).map(row => `${row.characterId}: ${row.want} — ${row.actionThatChangesPlot}`)),
  ].join('\n');
  return formatDocument({ workId, status: spine.status }, body);
}

export function renderWriterSkillDocument(workId, skill) {
  const body = [
    section('작가의 시선', skill.aestheticThesis ?? ''),
    bulletSection('작가 판단 원칙', skill.authorCraft?.judgments ?? []),
    bulletSection('생략과 여백', skill.authorCraft?.omissions ?? []),
    bulletSection('대사의 관계 행동', skill.authorCraft?.dialogueConduct ?? []),
    bulletSection('자기 장기 배반', skill.authorCraft?.selfBetrayal ?? []),
    bulletSection('사건 발생 원천', skill.storyDramaturgy?.conflictSources ?? []),
    bulletSection('압력 확대 법칙', skill.storyDramaturgy?.escalationLaws ?? []),
    section('주인공의 반복 오류', skill.storyDramaturgy?.protagonistError ?? ''),
    bulletSection('적대자의 적응', skill.storyDramaturgy?.oppositionAdaptation ?? []),
    bulletSection('핵심 판단 습관', skill.coreAttention ?? []),
    bulletSection('장면 변환 기술', skill.sceneTransformations ?? []),
    bulletSection('정보를 숨기는 감각', skill.withholdingInstinct ?? []),
    bulletSection('보상을 만드는 감각', skill.payoffInstinct ?? []),
    bulletSection('고착 방지', skill.antiFixation ?? []),
    bulletSection('작가에게 남기는 자유', skill.discoverySpaces ?? []),
  ].join('\n');
  return formatDocument({ workId, status: skill.status, selectedCandidate: skill.selectedCandidate }, body);
}
