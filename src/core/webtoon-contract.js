import { createHash } from 'node:crypto';
import { TEXT_SCHEMA, TEXT_POLICY_VERSION, imageText } from './webtoon-text.js';
import { PRESENTATION_AREAS, PRESENTATION_REQUIRED, ART_STYLE_OPTIONS, validatePresentationAnswer, presentationOf } from './webtoon-presentation.js';
import { localizeWebtoonArea } from './webtoon-language.js';

const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
export const digest = (value) => `sha256:${createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest('hex')}`;
export const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Questions are also the coverage schema. No second, truncated question ledger.
export const WEBTOON_AREAS = [
  ['W01', '목적·독자', '누구에게 보여줄 웹툰이며 맛보기·피칭·연재 중 이번 목표는 무엇인가요?', '원작을 처음 보는 독자도 이해하는 한 화의 콘티부터 검토합니다.', []],
  ['W02', '각색 범위', '반드시 보존할 사건·관계·대사와 압축·생략·순서 변경을 허용할 범위는 무엇인가요?', '원작 사실과 동기를 보존하고 표현 변경은 각색 지도에 표시합니다.', []],
  ['W04', '화풍', '원하는 선·색·비례·배경의 인상과 피하고 싶은 특징은 무엇인가요?', '기준안과 같은 장면의 시각 샘플을 비교한 뒤 확정합니다.', []],
  ['W12', '참여·승인', '직접 확인할 단계와 일상적인 선택을 맡길 범위는 어디까지인가요?', '방향·대본·구도 러프·시각 기준·최종본을 검토하고 일상적인 세부 선택을 맡깁니다.', []],
  ['W03', '첫 제작·회차', '첫 제작 범위와 이번 화에서 가장 강하게 남길 경험은 무엇인가요? 보조로 살릴 것과 이를 위해 덜어내도 되는 것은요?', '원작의 독자 약속을 바탕으로 주된 경험과 보조 경험·생략 경계를 먼저 제안하고 컷 수는 선별 뒤 결정합니다.', ['W01', 'W02']],
  ['W05', '캐릭터·연기', '원작의 확정 외형·성격은 유지합니다. 아직 묘사되지 않은 외형 세부와 의상 재해석·치비·과장 표정은 어느 범위까지 허용할까요?', '원작 외형을 유지하고 연기 변형은 시각 샘플에서 확인합니다.', ['W02', 'W04']],
  ['W06', '시각 세계관', '건축·복식·기술·공간의 비어 있는 디자인은 어떤 기준으로 채울까요?', '확정 세계 규칙을 유지하고 반복 공간부터 기준을 만듭니다.', ['W02', 'W04']],
  ['W07', '대사·내면', '남겨야 할 독백과 행동·표정으로 옮길 설명, UI의 비중은 무엇인가요?', '핵심 내면을 보존하고 실제 글자를 러프 콘티부터 배치합니다.', ['W01', 'W02']],
  ['W08', '스크롤·공개', '감정에 머무르는 호흡과 사건 속도, 독자에게 정보를 먼저 알릴 범위는요?', '장면 목적에 맞춰 호흡을 바꾸고 원작 정보 공개 의도를 추적합니다.', ['W01', 'W02']],
  ['W09', '표현 강도', '잔혹함·공포·친밀함·희화화 중 줄이거나 강조할 표현이 있나요?', '원작 톤을 출발점으로 화면에서의 강도는 별도로 확인합니다.', ['W01']],
  ['W10', '화면·언어', '휴대폰·인쇄·번역 중 필요한 출력과 글자 읽힘의 우선순위는 무엇인가요?', '원작의 승인된 언어를 유지하고 모바일 세로 읽기와 편집 가능한 문자를 먼저 검토합니다. 번역은 별도 범위입니다.', ['W01']],
  ['W11', '비용·시간', '첫 실험의 비용·시간 한도와 완성도·속도·수정 가능성의 우선순위는요?', '비용 없는 콘티부터 확인하고 유료 생성의 한도는 별도로 정합니다.', ['W01', 'W12']],
  ['W13', '수용 기준', '얼굴·감정·읽힘·액션 중 가장 피하고 싶은 실패는 무엇인가요?', '읽기 혼란과 인물 식별을 먼저 확인하되 우선순위는 작품에 맞춥니다.', ['W01', 'W04']],
  ['W14', '연속성·변경', '다음 화에서 고정할 기준과 원작 개정·취향 변경의 적용 범위는요?', '현재 원작 판본을 고정하고 변경한 결정의 영향 범위만 다시 검토합니다.', ['W02', 'W12']],
].map(([id, title, question, recommendation, dependsOn]) => ({ id, title, question, recommendation, dependsOn }));

export const WEBTOON_BRANCHES = [
  ['E01', '몸·시간 전환', /회귀|환생|빙의|변신|regress|reincarn/i, '몸이 바뀌어도 유지할 식별 특징과 전환 사실을 공개할 시점은요?', ['W05', 'W08']],
  ['E02', '시스템·문서', /시스템|게임|litrpg|휴대폰|문서|system|game/i, 'UI의 정확 문자·수치 중 꼭 읽혀야 할 것과 공개 범위는요?', ['W07', 'W08']],
  ['E03', '액션·접촉', /액션|전투|추격|격투|action|combat/i, '동작 이해와 속도감 중 우선순위, 부상·파손의 표현 범위는요?', ['W05', 'W08']],
  ['E04', '관계 연출', /로맨스|연애|관계극|romance/i, '시선·거리·침묵과 내면 공개 중 관계를 전달할 방식은요?', ['W05', 'W07']],
  ['E05', '공포·미스터리', /공포|미스터리|추리|horror|mystery/i, '보이지 않게 남길 것과 독자가 먼저 알아도 되는 단서는요?', ['W08', 'W09']],
  ['E06', '코미디·변형', /코미디|개그|comedy/i, '개그와 진지한 장면에서 각각 허용할 얼굴·몸의 과장 범위는요?', ['W05', 'W09']],
  ['E07', '전문·시대 표현', /경영|역사|전문|historical/i, '정확성이 필요한 도구·공간과 설명 그래픽의 우선순위는요?', ['W06', 'W07']],
  ['E08', '번역·다중 판면', /번역|인쇄|다국어|translation|print/i, '번역문이나 인쇄용 판면에 맞춰 컷과 풍선 배치를 바꿔도 될까요?', ['W10']],
].map(([id, title, trigger, question, dependsOn]) => ({ id, title, trigger, question, dependsOn, recommendation: '해당 장면의 원작 의도와 제작 제약을 함께 확인하고 결정합니다.' }));

export const interviewAreas = workflow => [...WEBTOON_AREAS, ...(workflow.presentationVersion === 1 ? PRESENTATION_AREAS : [])]
  .map(area => localizeWebtoonArea(area.id === 'W04' && workflow.presentationVersion === 1
    ? { ...area, options: ART_STYLE_OPTIONS, custom: '혼합·직접 지정도 가능합니다. 선·채색·비례·배경 밀도를 설명하고 작화와 판면은 별개로 선택합니다.' } : area, workflow.source));

export function coverage(workflow) {
  const evidence = JSON.stringify({ genre: workflow.source.foundation.genre, profile: workflow.source.storyProfile, inputs: workflow.inputs });
  const enabled = WEBTOON_BRANCHES.filter((area) => area.trigger.test(evidence) || workflow.enabledBranches?.includes(area.id))
    .map(area => localizeWebtoonArea(area, workflow.source));
  const required = [...interviewAreas(workflow), ...enabled];
  const resolved = (id) => (workflow.presentationVersion === 1 && PRESENTATION_REQUIRED.includes(id) ? ['answered'] : ['answered', 'delegated']).includes(workflow.decisions[id]?.status);
  const unresolved = required.filter((area) => !resolved(area.id));
  const presentationMissing = workflow.presentationVersion === 1 && PRESENTATION_REQUIRED.some(id => !resolved(id));
  return {
    complete: unresolved.length === 0,
    required: required.map(({ id }) => id),
    missing: unresolved.map(({ id }) => id),
    questions: unresolved.filter((area) => area.dependsOn.every(resolved) && (!presentationMissing || PRESENTATION_REQUIRED.includes(area.id))).map(({ trigger, ...area }) => area),
    inactiveBranches: WEBTOON_BRANCHES.filter((area) => !enabled.includes(area)).map(({ id }) => ({ id, reason: '아직 근거나 사용자가 선택한 분기가 없음; 후속 답변에서 재평가' })),
  };
}

export function updateDecisions(workflow, updates, input, delegated = false) {
  const known = new Set([...WEBTOON_AREAS, ...PRESENTATION_AREAS, ...WEBTOON_BRANCHES].map((area) => area.id));
  for (const [id, value] of Object.entries(updates)) {
    if (!known.has(id) || !nonempty(value)) throw new Error(`INVALID_INTERVIEW_ANSWER: ${id}`);
    if (workflow.presentationVersion === 1) validatePresentationAnswer(id, value);
  }
  for (const [id, value] of Object.entries(updates)) {
    const prior = workflow.decisions[id];
    if (prior?.value === value && !delegated && prior.status === 'answered') continue;
    if (prior) workflow.decisionHistory.push({ ...prior, status: 'superseded' });
    workflow.decisions[id] = { id, value, status: delegated ? 'delegated' : 'answered', revision: (prior?.revision ?? 0) + 1, inputId: input.id };
    // A changed premise reopens only settled downstream decisions, unless the
    // user answered both in this same round. History retains the old choice.
    const changed = new Set(prior && prior.value !== value ? [id] : []);
    for (let pass = 0; pass < known.size; pass++) {
      for (const area of [...WEBTOON_AREAS, ...WEBTOON_BRANCHES]) {
        if (area.dependsOn.some((dep) => changed.has(dep)) && !Object.hasOwn(updates, area.id) && workflow.decisions[area.id] && !changed.has(area.id)) {
          workflow.decisionHistory.push({ ...workflow.decisions[area.id], status: 'superseded', reason: `dependency:${id}` });
          workflow.decisions[area.id] = { ...workflow.decisions[area.id], status: 'unresolved', reason: `dependency:${id}` };
          changed.add(area.id);
        }
      }
    }
  }
}

export function compileWebtoonContract(workflow) {
  const content = {
    schemaVersion: 1, sourceHash: workflow.source.hash, sourceCanonHead: workflow.source.sourceCanonHead,
    ...(workflow.source.languageContract ? { languageContract: workflow.source.languageContract } : {}),
    // Preserve full approved source inputs; per-shot selection is recorded later.
    narrative: workflow.source.storyProfile, identity: workflow.source.identity,
    writerSkill: workflow.source.writerSkill, sourceIntent: workflow.source.chapters.map(({ chapter, episodeIntent }) => ({ chapter, episodeIntent })),
    decisions: workflow.decisions, inputs: workflow.inputs, scope: workflow.scope, imagePolicy: workflow.imagePolicy,
    ...(workflow.presentationVersion === 1 ? { presentation: presentationOf(workflow) } : {}),
    ...(workflow.imageSelection ? { imageSelection: workflow.imageSelection } : {}),
  };
  return { content, digest: digest(content) };
}

export const PLAN_SCHEMA = {
  textPolicyVersion: TEXT_POLICY_VERSION,
  title: '웹툰 화 제목', promise: '이번 회차의 약속', closingQuestion: '마지막 질문',
  adaptation: [{ sourceId: 'ch-1-p-1', operation: 'keep|compress|split|merge|reorder|omit|inventBridge', reason: '각색 근거', payoffAt: '회수 위치 또는 미회수 이유' }],
  visualBible: { characters: [{ id: '원작 인물 ID', anchors: ['고정 외형'], performance: '연기 범위' }], environments: [{ id: 'place-1', description: '동선·광원·공간 기준' }] },
  sequences: [{ id: 'seq-1', purpose: '선택과 변화', shots: [{ id: 'shot-1', sourceIds: ['ch-1-p-1'], storyTime: '원작 시점', action: '보이는 행동·접촉·구도', characters: ['인물 ID'], environmentId: 'place-1', visualState: '의상·상처·소품', knowledgeBefore: ['독자가 아는 것'], knowledgeAfter: ['새로 아는 것'], voices: [{ id: 'staff', description: '원작에 등장하는 상담 직원. 주요 인물 재정의 아님', sourceIds: ['ch-1-p-1'] }], texts: [TEXT_SCHEMA], height: 640, gapAfter: 120 }] }],
};

export function validateWebtoonPlan(plan, source, scope) {
  const errors = [];
  const fail = (code, at) => errors.push({ code, at, severity: 'hard' });
  if (!plan || typeof plan !== 'object' || !nonempty(plan.title) || !nonempty(plan.promise) || !nonempty(plan.closingQuestion)) return [{ code: 'PLAN_HEADER_REQUIRED', severity: 'hard' }];
  if ((plan.textPolicyVersion !== undefined && plan.textPolicyVersion !== TEXT_POLICY_VERSION)
    || (scope.textPolicyVersion === TEXT_POLICY_VERSION && plan.textPolicyVersion !== TEXT_POLICY_VERSION)) fail('TEXT_POLICY_VERSION_REQUIRED');
  const units = new Set(source.units.map(({ id }) => id));
  const characters = new Set(source.foundation.characters.map(({ id }) => id));
  const mapped = new Set();
  const operations = new Set(['keep', 'compress', 'split', 'merge', 'reorder', 'omit', 'inventBridge']);
  if (!Array.isArray(plan.adaptation)) fail('ADAPTATION_REQUIRED');
  for (const row of Array.isArray(plan.adaptation) ? plan.adaptation : []) {
    if (!units.has(row?.sourceId) || !operations.has(row?.operation) || !nonempty(row?.reason)) fail('INVALID_SOURCE_MAPPING', row?.sourceId);
    else mapped.add(row.sourceId);
    if (row?.operation === 'omit' && !nonempty(row?.payoffAt)) fail('OMISSION_DISPOSITION_REQUIRED', row?.sourceId);
  }
  for (const id of units) if (!mapped.has(id)) fail('UNMAPPED_SOURCE', id);
  const ids = new Set(); let count = 0; let height = 0;
  const environments = plan.visualBible?.environments;
  const cast = plan.visualBible?.characters;
  if (!Array.isArray(environments) || !Array.isArray(cast)) fail('VISUAL_BIBLE_REQUIRED');
  const placeIds = new Set((Array.isArray(environments) ? environments : []).map((place) => place?.id));
  const castIds = new Set((Array.isArray(cast) ? cast : []).map((person) => person?.id));
  for (const place of Array.isArray(environments) ? environments : []) if (!safeId(place?.id) || !nonempty(place?.description)) fail('INVALID_VISUAL_PLACE', place?.id);
  for (const person of Array.isArray(cast) ? cast : []) if (!characters.has(person?.id) || !Array.isArray(person?.anchors) || !person.anchors.length || !person.anchors.every(nonempty) || !nonempty(person.performance)) fail('INVALID_VISUAL_CHARACTER', person?.id);
  if (!Array.isArray(plan.sequences) || !plan.sequences.length) fail('SEQUENCES_REQUIRED');
  for (const seq of Array.isArray(plan.sequences) ? plan.sequences : []) {
    if (!safeId(seq?.id) || ids.has(seq.id) || !nonempty(seq.purpose) || !Array.isArray(seq.shots) || !seq.shots.length) { fail('INVALID_SEQUENCE', seq?.id); continue; }
    ids.add(seq.id);
    for (const shot of seq.shots) {
      count++;
      if (!safeId(shot?.id) || ids.has(shot.id)) { fail('INVALID_SHOT_ID', shot?.id); continue; }
      ids.add(shot.id);
      if (!nonempty(shot.action) || !nonempty(shot.storyTime) || !nonempty(shot.visualState)) fail('SHOT_CONTEXT_REQUIRED', shot.id);
      if (!Array.isArray(shot.sourceIds) || !shot.sourceIds.length || !shot.sourceIds.every((id) => units.has(id) && mapped.has(id))) fail('INVALID_SHOT_SOURCE', shot.id);
      if (!Array.isArray(shot.characters) || !shot.characters.every((id) => characters.has(id) && castIds.has(id))) fail('INVALID_SHOT_CAST', shot.id);
      if (!placeIds.has(shot.environmentId)) fail('INVALID_SHOT_PLACE', shot.id);
      if (!Array.isArray(shot.knowledgeBefore) || !Array.isArray(shot.knowledgeAfter)) fail('KNOWLEDGE_TRACK_REQUIRED', shot.id);
      if (!Number.isInteger(shot.height) || shot.height < 240 || shot.height > 2400 || !Number.isInteger(shot.gapAfter) || shot.gapAfter < 0 || shot.gapAfter > 1600) fail('INVALID_LAYOUT', shot.id);
      height += (shot.height || 0) + (shot.gapAfter || 0);
      if (!Array.isArray(shot.texts)) { fail('TEXT_TRACK_REQUIRED', shot.id); continue; }
      const voices = new Set();
      if (shot.voices !== undefined && !Array.isArray(shot.voices)) fail('INVALID_SHOT_VOICES', shot.id);
      for (const voice of Array.isArray(shot.voices) ? shot.voices : []) {
        if (!safeId(voice?.id) || voices.has(voice.id) || characters.has(voice.id) || ['narrator', 'system'].includes(voice.id)
          || !nonempty(voice.description) || !Array.isArray(voice.sourceIds) || !voice.sourceIds.length
          || !voice.sourceIds.every(id => shot.sourceIds?.includes(id))) fail('INVALID_SHOT_VOICE', shot.id);
        else voices.add(voice.id);
      }
      let rows = 0;
      for (const text of shot.texts) {
        const visibleCast = Array.isArray(shot.characters) ? shot.characters : [];
        const person = visibleCast.includes(text?.speaker) || voices.has(text?.speaker)
          || (text?.delivery === 'offscreen' && characters.has(text?.speaker) && castIds.has(text?.speaker));
        if (!['dialogue', 'thought', 'caption', 'sfx', 'ui'].includes(text?.kind) || !nonempty(text?.text)
          || !(person || ['narrator', 'system'].includes(text?.speaker))) fail('INVALID_TEXT_AUTHORITY', shot.id);
        if (['dialogue', 'thought'].includes(text?.kind) && !person) fail('DIALOGUE_SPEAKER_NOT_IN_SHOT', shot.id);
        if (text?.delivery !== undefined && (text.kind !== 'dialogue' || !['onscreen', 'offscreen'].includes(text.delivery))) fail('INVALID_TEXT_DELIVERY', shot.id);
        if (text?.render !== undefined && !['overlay', 'image'].includes(text.render)) fail('INVALID_TEXT_RENDER', shot.id);
        if (text?.render === 'image' && (!imageText(text) || !nonempty(text.surface))) fail('PHYSICAL_TEXT_SURFACE_REQUIRED', shot.id);
        if (text?.surface !== undefined && !imageText(text)) fail('INVALID_TEXT_SURFACE', shot.id);
        if (plan.textPolicyVersion === TEXT_POLICY_VERSION) {
          if (text?.kind === 'ui' && !imageText(text)) fail('PHYSICAL_TEXT_RENDER_REQUIRED', shot.id);
          if (text?.kind === 'caption' && text.speaker !== 'narrator') fail('CAPTION_AUTHORITY_REQUIRED', shot.id);
        }
        if (imageText(text)) continue;
        rows += String(text?.text ?? '').split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].length / 22)), 0) + 1;
      }
      if (rows * 30 > shot.height - 110) fail('TEXT_OVERFLOW', shot.id);
    }
  }
  if (count > scope.maxShots || !count || height > 120000) fail('PRODUCTION_SCOPE_EXCEEDED');
  return errors;
}

export const planShots = (plan) => plan.sequences.flatMap((sequence) => sequence.shots).map(shot => plan.presentation?.lettering ? { ...shot, letteringStyle: plan.presentation.lettering } : shot);
