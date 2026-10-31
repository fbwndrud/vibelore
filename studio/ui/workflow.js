import { previewReadiness } from './player.js';
import { el, card, note, button } from './dom.js';

export function productionProgress(s, productionId, profile = 'landscape') {
  const readiness = previewReadiness(s, productionId, profile);
  const intent = s.timelines?.find(t => t.productionId === productionId)?.intent ?? {};
  const scenes = s.scenes.filter(sc => sc.productionId === productionId && (!intent.sceneIds || intent.sceneIds.includes(sc.id)));
  const occurrenceIds = new Set(scenes.flatMap(sc => sc.utterances.map(u => u.speakerOccurrenceId)));
  const missingVoices = [...occurrenceIds].filter(id => !s.resolvedBindings.some(b => b.occurrenceId === id && b.casting?.status === 'resolved'));
  const editions = (s.editions ?? []).filter(e => e.productionId === productionId && e.closure.profile.id === profile);
  const currentEditions = editions.filter(e => !(s.editionStates ?? []).find(state => state.id === e.id)?.workingChanged);
  const editionIds = new Set(editions.map(e => e.id));
  const currentIds = new Set(currentEditions.map(e => e.id));
  const outputs = (s.editionOutputs ?? []).filter(o => editionIds.has(o.editionId) && o.status === 'completed');
  const currentOutputs = outputs.filter(o => currentIds.has(o.editionId));
  const attempts = (s.attempts ?? []).filter(a => a.request?.productionId === productionId);
  const missingIds = new Set(readiness.audio.map(cue => cue.utteranceId));
  const latestAudio = new Map();
  for (const a of attempts) {
    if (a.request.kind !== 'audio' || a.request.provider !== 'google') continue;
    const target = a.request.target;
    const utteranceId = a.request.utteranceId ?? (target.kind === 'utterance' ? target.id : s.slots.find(slot => slot.id === target.id)?.utteranceId);
    if (missingIds.has(utteranceId)) latestAudio.set(utteranceId, a);
  }
  const rejection = [...latestAudio.values()].reverse().find(a => ['outcome_unknown','failed_definite'].includes(a.status) && a.providerFailure?.httpStatus);
  const totalShots = scenes.reduce((n, sc) => n + sc.shots.length, 0);
  const imageReadiness = profile === 'landscape' ? readiness : previewReadiness(s, productionId, 'landscape');
  const missingImages = imageReadiness.images.filter(image => image.shotId != null).length;
  const steps = [
    { label: '원작·각색', detail: `${scenes.length}개 장면 · ${readiness.utterances}개 발화`, done: scenes.length > 0 && readiness.utterances > 0, workspace: 'story' },
    { label: '목소리 배정', detail: `${occurrenceIds.size - missingVoices.length}/${occurrenceIds.size}명 배정`, done: occurrenceIds.size > 0 && !missingVoices.length, workspace: 'cast' },
    { label: '그림·음성 준비', detail: `그림 ${totalShots - missingImages}/${totalShots} · 음성 ${readiness.utterances - readiness.audio.length}/${readiness.utterances}`, done: readiness.ready, workspace: 'assets' },
    { label: '연출·미리보기', detail: currentEditions.length ? '현재 편집본의 고정판 있음' : editions.length ? '편집 변경 · 새 고정 필요' : '아직 고정하지 않음', done: currentEditions.length > 0, workspace: 'edit' },
    { label: '완성 파일', detail: currentOutputs.length ? `현재 편집본 ${currentOutputs.length}개 출력` : outputs.length ? `이전 편집본 ${outputs.length}개 · 새 출력 필요` : '완성 파일 없음', done: currentOutputs.length > 0, workspace: 'production' },
  ];
  return { readiness, scenes, steps, rejection, missingVoices, outputs, currentOutputs };
}

export function goToWork(c, workspace, target = {}) {
  Object.assign(c.selection, { workspace }, target);
  c.persist(); c.render();
}
export function renderWorkflow(c, { compact = false } = {}) {
  const productionId = c.selection.production;
  if (!productionId) return note('제작판을 선택하면 완성까지 필요한 작업이 표시됩니다.');
  const s = c.snapshot, p = productionProgress(s, productionId, c.selection.previewProfile ?? 'landscape');
  const root = card('완성까지 할 일', el('div', { class: 'workflow-steps', 'aria-label': '제작 단계' }, p.steps.map((step, i) => button([
    el('span', { class: 'workflow-number' }, step.done ? '✓' : String(i + 1)),
    el('strong', {}, step.label), el('small', {}, step.detail),
  ], () => goToWork(c, step.workspace), { class: step.done ? 'workflow-step done' : 'workflow-step' }))));
  root.className += ` workflow-card${compact ? ' compact' : ''}`;
  root.append(note(p.currentOutputs.length ? '파일 생성 완료 · 재생과 감상 검토는 출력 영역에서 확인하세요.' : '현재 제작판은 편집 중입니다. 화면의 구도 미리보기와 완성 파일은 별도입니다.'));
  if (p.rejection && p.readiness.audio.length) {
    const status = p.rejection.providerFailure.httpStatus;
    root.append(el('div', { class: 'workflow-blocker', role: 'status' },
      el('strong', {}, `Google 요청 실패 · HTTP ${status}`),
      note(status === 402 ? 'Google 음성 요청에서 결제 관련 응답을 받았습니다. 계정의 결제·API 사용 권한 확인이 필요합니다. 이 요청의 음원이 아직 준비되지 않아 완성 파일 출력이 막혀 있습니다.' : '음성 요청 결과를 Production에서 확인하세요. 현재 누락 음원으로는 완성 파일을 만들 수 없습니다.'),
      button('실패 기록 확인', () => goToWork(c, 'production'))));
  }
  const missing = p.readiness.audio[0];
  if (missing) root.append(button('첫 누락 음성 준비', () => goToWork(c, 'assets', { scene: missing.sceneId, utterance: missing.utteranceId, assetKind: 'audio', slot: '', candidate: '' }), { class: 'primary' }));
  else if (p.readiness.images[0]) {
    const image = p.readiness.images[0];
    root.append(button('첫 누락 그림 준비', () => goToWork(c, 'assets', { scene: image.sceneId, shot: image.shotId ?? '', assetKind: 'image', slot: '', candidate: '' }), { class: 'primary' }));
  } else if (!p.currentOutputs.length) root.append(button(p.readiness.ready ? '미리보기·출력으로 이동' : '장면과 발화 준비', () => goToWork(c, p.readiness.ready ? 'production' : 'story'), { class: 'primary' }));
  if (!compact && missing) {
    const list = el('div', { class: 'missing-list' });
    for (const cue of p.readiness.audio) {
      const sc = s.scenes.find(x => x.id === cue.sceneId), u = sc.utterances.find(x => x.id === cue.utteranceId);
      const occurrence = sc.occurrences.find(x => x.id === u.speakerOccurrenceId), role = s.cast.find(x => x.id === occurrence?.roleBindingId);
      const voice = s.resolvedBindings.find(x => x.occurrenceId === occurrence?.id)?.casting?.voice;
      list.append(button(`${role?.name ?? '화자'} · ${voice ?? '목소리 미배정'} · ${cue.text}`, () => goToWork(c, 'assets', { scene: sc.id, utterance: u.id, assetKind: 'audio', slot: '', candidate: '' }), { class: 'missing-cue' }));
    }
    root.append(el('h3', {}, '아직 준비되지 않은 음성'), note('대사를 선택하면 해당 화자의 목소리와 연기 지시로 음성을 준비할 수 있습니다. 이 버튼은 생성 요청을 보내지 않습니다.'), list);
  }
  return root;
}

export function renderHistory(c) {
  const root = card('제작 변경 이력', note('작품 전체의 저장·자료 채택·생성·출력 기록을 저장 순서로 확인합니다. 원작과 편집 자료는 별도로 보존됩니다.'));
  if (!c.api.history) return root;
  let before;
  const entries = el('ol', { class: 'history-list' }), state = note('저장 기록을 불러오고 있습니다.');
  const more = button('이전 기록 더 보기', () => c.run(load));
  root.append(state, entries, more);
  async function load() {
    more.disabled = true;
    try {
      const result = await c.api.history(before);
      for (const e of result.entries) entries.append(el('li', {}, el('strong', {}, e.label), note(e.summary), el('small', {}, `저장 순서 ${e.cursor} · 변경판 ${e.revision}`)));
      before = result.nextBefore;
      state.textContent = entries.children.length ? `${entries.children.length}개 저장 기록 · 최신순` : '아직 저장한 기록이 없습니다.';
      more.disabled = !before;
    } catch { state.textContent = '이력을 불러오지 못했습니다. 새로고침해 다시 확인하세요.'; more.disabled = false; }
  }
  void load();
  return root;
}
