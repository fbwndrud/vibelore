import { digest, planShots } from './webtoon-contract.js';
import { composeWebtoonBoard, boardHtml } from './webtoon-board.js';
import { continuityInput } from './webtoon-continuity.js';
import { physicalTexts, imageText, visibleVoices } from './webtoon-text.js';

export const LEGACY_CODEX_IMAGE_POLICY = Object.freeze({
  version: 1, execution: 'codex-built-in', targetModel: 'gpt-image-2', observedModel: null,
  fallback: 'ask-user', billing: 'codex-usage', lettering: 'editable-overlay',
});
export const IMAGE_MODELS = Object.freeze(['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']);
export const CODEX_IMAGE_POLICY = Object.freeze({ ...LEGACY_CODEX_IMAGE_POLICY, version: 2, targetModel: 'gpt-image-2.5-sunburst' });

export function imagePolicyFor(model = CODEX_IMAGE_POLICY.targetModel, execution = 'codex-built-in') {
  if (!IMAGE_MODELS.includes(model)) throw new Error('UNSUPPORTED_WEBTOON_IMAGE_MODEL');
  if (!['codex-built-in', 'openai-api'].includes(execution)) throw new Error('UNSUPPORTED_WEBTOON_IMAGE_EXECUTION');
  if (execution === 'openai-api') return { ...CODEX_IMAGE_POLICY, version: 3, execution, targetModel: model, billing: 'openai-api' };
  return model === 'gpt-image-2' ? { ...LEGACY_CODEX_IMAGE_POLICY } : { ...CODEX_IMAGE_POLICY, targetModel: model };
}

export const imageSelectionConfirmed = (workflow) => workflow.imageSelection?.policyHash === digest(effectiveImagePolicy(workflow)) && workflow.imageSelection?.workId === workflow.workId;

// Persisted policy is part of approved input hashes. Never relabel older workflows.
export const effectiveImagePolicy = (workflow) => workflow.imagePolicy ?? LEGACY_CODEX_IMAGE_POLICY;
export function imageRuntime(workflow) {
  const policy = effectiveImagePolicy(workflow);
  if (policy.execution === 'openai-api') {
    const confirmed = imageSelectionConfirmed(workflow);
    return { available: confirmed, provider: 'openai-api', targetModel: policy.targetModel, observedModel: null,
      explicitModelSelection: true, executionOwner: 'host', credential: 'OPENAI_API_KEY',
      credentialStatus: 'check-on-host', accountAccess: 'unverified-until-request',
      ...(confirmed ? {} : { code: 'IMAGE_SELECTION_REQUIRED', reason: 'API 모델과 별도 과금을 먼저 사용자에게 확인하세요.' }) };
  }
  const available = policy.execution === 'codex-built-in' && policy.targetModel === 'gpt-image-2';
  return { available, provider: policy.execution, targetModel: policy.targetModel, observedModel: null,
    explicitModelSelection: false, documentedBuiltinModel: 'gpt-image-2', checkedAt: '2026-09-09',
    ...(available ? {} : { code: 'IMAGE_MODEL_NOT_SELECTABLE',
      reason: '현재 내장 이미지 도구에는 모델 선택 인자가 없습니다. 요청 모델을 프롬프트에 적는 것은 모델 선택이 아닙니다.',
      nextAction: '모델 선택 가능한 호스트 연결을 확인하거나 별도 API 과금 허용을 사용자에게 확인한 뒤 API 실행 경로를 연결하세요. 현재 서버는 API를 호출하지 않습니다.' }) };
}

export function validateImageProvenance(workflow, provenance) {
  const policy = effectiveImagePolicy(workflow);
  if (policy.execution !== 'openai-api') return;
  requireImageRuntime(workflow);
  if (provenance?.kind !== 'openai-api' || provenance.requestedModel !== policy.targetModel || provenance.selectionId !== workflow.imageSelection.id) throw new Error('IMAGE_EXECUTION_PROVENANCE_REQUIRED');
  // A submitted request is not evidence that the provider returned a model ID.
  if (provenance.observedModel != null && (typeof provenance.observedModel !== 'string' ||
    !(provenance.observedModel === policy.targetModel || provenance.observedModel.startsWith(`${policy.targetModel}-`)))) throw new Error('IMAGE_OBSERVED_MODEL_MISMATCH');
}

const apiRequest = (workflow, edit = false) => effectiveImagePolicy(workflow).execution === 'openai-api'
  ? { apiRequest: { model: workflow.imagePolicy.targetModel, endpoint: edit ? '/v1/images/edits' : '/v1/images/generations',
    selectionId: workflow.imageSelection.id, executionOwner: 'host', credential: 'OPENAI_API_KEY',
    note: '선택된 모델을 실제 API 인자로 지정한다. 편집 입력은 실제 파일로 첨부한다. 호스트의 임의 반복 호출·모델 대체 없음. SDK 자체 재시도 설정은 실행 시 확인한다.' } } : {};

function requireImageRuntime(workflow) {
  if (!imageRuntime(workflow).available) throw new Error('WEBTOON_IMAGE_RUNTIME_REQUIRED');
}
const styleOf = (workflow) => Object.fromEntries(['W04', 'W05', 'W06', 'W09'].map((id) => [id, workflow.decisions[id]?.value]));

export function referenceSpecs(workflow) {
  const specs = new Map();
  for (const shot of planShots(workflow.plan)) {
    const subjects = [...shot.characters.map((id) => ({ kind: 'character', subjectId: id,
      design: workflow.plan.visualBible.characters.find((item) => item.id === id),
      original: workflow.source.foundation.characters.find((item) => item.id === id),
      variant: shot.visualState })),
    { kind: 'environment', subjectId: shot.environmentId,
      design: workflow.plan.visualBible.environments.find((item) => item.id === shot.environmentId),
      original: workflow.source.foundation.worldFacts, variant: 'approved-environment-design' }];
    for (const subject of subjects) {
      // IDs describe a visual design, not a chapter number: unchanged designs can cross episodes.
      const inputHash = digest({ ...subject, style: styleOf(workflow), policy: effectiveImagePolicy(workflow) });
      const id = `ref-${subject.kind}-${inputHash.slice(7, 31)}`;
      const spec = specs.get(id) ?? { id, inputHash, ...subject, style: styleOf(workflow), usedBy: [], storyTimes: [] };
      spec.usedBy.push(shot.id);
      if (!spec.storyTimes.includes(shot.storyTime)) spec.storyTimes.push(shot.storyTime);
      specs.set(id, spec);
    }
  }
  return [...specs.values()];
}

export function referenceSummary(workflow) {
  return (workflow.referenceSpecs ?? []).map((spec) => {
    const entry = workflow.references?.[spec.id];
    return { ...spec, status: entry?.approval ? 'approved' : entry ? 'candidate' : 'missing',
      imageHash: entry?.image.hash, path: entry?.path, approval: entry?.approval,
      provenance: entry?.image.provenance, reuse: entry?.reuse };
  });
}

export function referencesReady(workflow) {
  return (workflow.referenceSpecs?.length ?? 0) > 0 && workflow.referenceSpecs.every((spec) =>
    workflow.references?.[spec.id]?.approval && workflow.references[spec.id].inputHash === spec.inputHash);
}

export function referenceJobs(workflow) {
  requireImageRuntime(workflow);
  return workflow.referenceSpecs.filter(({ id }) => !workflow.references[id]).map((spec) => ({
    kind: 'reference', referenceId: spec.id, inputHash: spec.inputHash,
    execution: effectiveImagePolicy(workflow), ...apiRequest(workflow), design: spec,
    prompt: `웹툰 제작용 ${spec.kind === 'character' ? '인물·의상' : '공간'} 기준 이미지를 만든다. 같은 원작 인물을 다시 창작하지 않고 아래 승인된 디자인과 화풍을 시각화한다. 인물은 식별 가능한 얼굴·체형·의상, 공간은 형태·재질·광원을 읽을 수 있게 표현한다. 대사·캡션·로고는 넣지 않는다.\n${JSON.stringify({ design: spec.design, original: spec.original, variant: spec.variant, style: spec.style })}`,
    sourceHash: workflow.source.hash,
    output: { field: 'references', referenceId: spec.id, inputHash: spec.inputHash, formats: ['png', 'jpeg'], location: 'project-relative versioned file' },
  }));
}

export function shotJobs(workflow, { all = false } = {}) {
  requireImageRuntime(workflow);
  return planShots(workflow.plan).filter(({ id }) => all || !workflow.images[id]).map((shot) => {
    const continuity = continuityInput(workflow, shot.id);
    const refs = workflow.referenceSpecs.filter(spec => spec.usedBy.includes(shot.id)
      && !(spec.kind === 'environment' && continuity?.entry.background === 'abstract')
      && !(spec.kind === 'character' && continuity?.entry.visibleCharacters && !continuity.entry.visibleCharacters.includes(spec.subjectId))).map((spec) => {
      const entry = workflow.references[spec.id];
      if (!entry?.approval) throw new Error('WEBTOON_REFERENCES_APPROVAL_REQUIRED');
      return { referenceId: spec.id, role: spec.kind, subjectId: spec.subjectId, variant: spec.variant,
        path: entry.path, hash: entry.image.hash, approval: entry.approval,
        provenance: entry.image.provenance, reuse: entry.reuse };
    });
    const art = { action: shot.action, characters: shot.characters, environmentId: shot.environmentId,
      storyTime: shot.storyTime, visualState: shot.visualState, sourceIds: shot.sourceIds, height: shot.height,
      hasLettering: shot.texts.some(text => !imageText(text)),
      ...(physicalTexts(shot).length ? { physicalTexts: physicalTexts(shot) } : {}),
      ...(visibleVoices(shot).length ? { visibleVoices: visibleVoices(shot) } : {}),
      ...(workflow.plan.editorial ? { editorial: { focus: workflow.plan.editorial.focus,
        beats: workflow.plan.editorial.beats.filter(b => shot.beatIds.includes(b.id)), purpose: shot.purpose, readerDelta: shot.readerDelta } } : {}) };
    if (continuity) refs.push(...continuity.referenceImages);
    const artInputHash = digest({ art, ...(continuity ? { continuity: continuity.binding } : {}), source: workflow.source.hash, style: styleOf(workflow),
      references: refs.map(({ referenceId, hash }) => ({ referenceId, hash })), execution: effectiveImagePolicy(workflow) });
    const edit = workflow.imageEdits?.[shot.id];
    const inputHash = edit ? digest({ artInputHash, target: edit.image.hash, feedback: edit.feedback }) : artInputHash;
    return { kind: edit ? 'edit' : 'shot', shotId: shot.id, inputHash, artInputHash, execution: effectiveImagePolicy(workflow), ...apiRequest(workflow, true),
      referenceImages: refs, ...(continuity ? { continuity, blockedBy: continuity.blocked } : {}), ...(edit ? { editTarget: { path: edit.path, hash: edit.image.hash }, feedback: edit.feedback } : {}),
      instruction: shot,
      source: { units: workflow.source.units.filter(({ id }) => shot.sourceIds.includes(id)),
        chapters: workflow.source.chapters.filter(({ chapter }) => workflow.source.units.some((unit) => unit.chapter === chapter && shot.sourceIds.includes(unit.id))).map(({ chapter, beforeState, afterState }) => ({ chapter, beforeState, afterState })) },
      prompt: `웹툰 한 컷을 ${edit ? '수정' : '생성'}한다. 승인 참조의 얼굴·체형·의상·공간 특징을 유지한다. ${continuity ? 'art.action의 사건 의미는 보존하되 과거 구도·화면 등장인물·배경 묘사가 충돌하면 현재 continuityPrompt의 camera/blocking/visibleCharacters/background를 우선한다. 화면 밖 인물은 그리지 않는다. ' : ''}여러 인물의 시선과 접촉은 같은 장면 안에서 그린다. 대사·독백·캡션·효과음·말풍선은 그리지 않는다. 편집 문자가 있는 컷만 문자 여백을 확보한다. art.physicalTexts가 있으면 지정된 정확 문자열만 해당 사물 표면에 원근·재질·조명에 맞춰 그린다. 이는 대사 금지의 예외인 실제 간판/문서/화면 글자다. 공중 자막·설명 상자·중복 글자는 만들지 않는다. action에 과거의 별도 문자 지시가 있더라도 physicalTexts의 표면 지시를 우선한다. 인물 ID의 화면 밖 처리와 별개로 visibleVoices에 명시된 단역은 해당 장면에 표현한다.\n${JSON.stringify({ art, style: styleOf(workflow), references: refs.map(({ path, role, subjectId }) => ({ path, role, subjectId })), ...(edit ? { changeOnly: edit.feedback, preserve: '변경 요청 외 구도·인물 식별·공간·화풍' } : {}) })}`,
      ...(continuity ? { continuityPrompt: `사건 상태의 연속성과 그림 참조를 구분한다. reset은 새 장면, continue는 직전 그림 연결, cut은 같은 사건의 새 구도로 직전 그림을 자동 첨부하지 않는다. previous-shot/scene-anchor는 연결 참조다. storyboard 첨부가 있으면 panelIndex와 shotId에 해당하는 단 하나의 컷을 완성한다. 러프의 인물·괴수 수, 위치, 이동 방향, 실루엣, 접점, 핵심 여백을 지키며 문자·번호·화살표·다른 패널은 완성 그림에 복사하지 않는다. 얼굴·의상·화풍은 character 참조에서 가져온다. rough와 현재 지시가 모순되면 임의로 바꾸지 말고 수정 요청한다. abstract 배경은 건물 배치를 복사하지 말고 속도선·명암·먼지로 핵심 동작을 강조한다. visibleCharacters에 없는 인물은 화면에 넣지 않는다. 컷별 camera가 구도를 결정하며 공간 좌표를 같은 카메라로 오해하지 않는다. 승인된 style의 수위·외형 제한을 유지하고 변경 대상과 보존 대상을 구분한다.\n${JSON.stringify({ scene: continuity.scene, shot: continuity.entry, style: styleOf(workflow), ...(continuity.causalPrevious ? { causalPrevious: continuity.causalPrevious } : {}), storyboard: refs.filter(r => r.role === 'storyboard') })}` } : {}),
      output: { field: 'assets', shotId: shot.id, inputHash, formats: ['png', 'jpeg'], location: 'project-relative versioned file' },
    };
  });
}

export function referenceBoard(workflow) {
  const shots = workflow.referenceSpecs.map((spec) => ({ id: spec.id, action: `${spec.kind}: ${spec.subjectId} — ${spec.variant}`, height: 720, gapAfter: 40,
    texts: [{ speaker: 'narrator', text: `${spec.subjectId} / ${spec.variant}`, kind: 'caption' }] }));
  const board = composeWebtoonBoard({ title: '웹툰 시각 기준 후보', sequences: [{ shots }] },
    Object.fromEntries(Object.entries(workflow.references).map(([id, entry]) => [id, entry.image])));
  return { ...board, html: boardHtml(board) };
}
