import { el, button, note } from './dom.js';

export const cameraPresets = [
  { label: '고정 화면', end: { x: 0, y: 0, scale: 1 } },
  { label: '완만하게 줌인', end: { x: 0, y: 0, scale: 1.18 } },
  { label: '천천히 줌아웃', startScale: 1.18, end: { x: 0, y: 0, scale: 1 } },
  { label: '왼쪽으로 이동', end: { x: -0.12, y: 0, scale: 1.12 } },
  { label: '오른쪽으로 이동', end: { x: 0.12, y: 0, scale: 1.12 } },
];

// JSON stays at the persistence boundary; the creator edits time and framing.
export function keyframeEditor(value) {
  let frames = [], invalid;
  function read(v) {
    try {
      const parsed = JSON.parse(v || '[]');
      if (!Array.isArray(parsed) || parsed.some(k => !k || typeof k !== 'object' || !['timeMs','x','y','scale'].every(key => Number.isFinite(k[key])))) throw new Error('Invalid camera draft');
      frames = parsed; invalid = undefined;
    } catch { invalid = v; frames = []; }
  }
  read(value);
  const root = el('div', { class: 'keyframe-editor', role: 'group', 'aria-label': '시간별 카메라 위치' });
  const changed = () => root.dispatchEvent(new Event('input', { bubbles: true }));
  function render() {
    root.replaceChildren();
    if (invalid !== undefined) {
      root.append(note('이전 카메라 초안을 읽을 수 없습니다. 초안은 보존되어 있습니다. 저장 내용으로 되돌리거나 추천 움직임을 선택해 복구하세요.'));
      return;
    }
    root.append(note('각 시점의 구도를 정하면 그 사이가 부드럽게 이어집니다. 저장 전 미리보기로 확인하세요.'));
    if (!frames.length) root.append(note('움직임 없음 · 고정 구도. 추천을 선택하거나 시점을 추가하세요.'));
    for (const [index, frame] of frames.entries()) {
      const row = el('div', { class: 'keyframe-row' });
      for (const field of [
        { key: 'timeMs', title: '시간 (초)', divisor: 1000, step: 0.1, min: 0 },
        { key: 'scale', title: '확대 배율', divisor: 1, step: 0.01, min: 0 },
        { key: 'x', title: '좌우 위치 (%)', divisor: 0.01, step: 1, min: -100, max: 100 },
        { key: 'y', title: '상하 위치 (%)', divisor: 0.01, step: 1, min: -100, max: 100 },
      ]) {
        const input = el('input', { type: 'number', value: frame[field.key] / field.divisor, step: 'any', min: field.min, ...(field.max != null ? { max: field.max } : {}), 'aria-label': `${index + 1}번 시점 ${field.title}` });
        input.addEventListener('input', () => { frame[field.key] = field.key === 'timeMs' ? Math.round(Number(input.value) * field.divisor) : Number(input.value) * field.divisor; });
        row.append(el('label', { class: 'field' }, el('span', {}, field.title), input));
      }
      row.append(button('시점 삭제', () => { frames.splice(index, 1); render(); changed(); }, { 'aria-label': `${index + 1}번 시점 삭제`, class: 'quiet' }));
      root.append(row);
    }
    root.append(button('카메라 시점 추가', () => {
      const last = frames.at(-1) ?? { timeMs: -1000, x: 0, y: 0, scale: 1 };
      frames.push({ ...last, timeMs: last.timeMs + 1000 }); render(); changed();
    }));
  }
  Object.defineProperty(root, 'value', {
    get: () => invalid !== undefined ? invalid : JSON.stringify(frames),
    set: v => { read(v); render(); },
  });
  render();
  return root;
}

export function cameraSuggestions(form, transform) {
  return el('div', { class: 'suggestions' }, el('p', { class: 'eyebrow' }, '추천 움직임'),
    note('추천은 편집 초안에만 적용됩니다. 저장해야 제작판에 반영됩니다.'),
    el('div', { class: 'chips' }, cameraPresets.map(p => button(p.label, () => {
      const draft = form.getDraftValues();
      const x = Number(draft.x ?? transform.x ?? 0), y = Number(draft.y ?? transform.y ?? 0), scale = Number(draft.scale ?? transform.scale ?? 1);
      const clamp = n => Math.max(-1, Math.min(1, n));
      const duration = Math.max(1000, ...(transform.keyframes ?? []).map(k => k.timeMs), 3500);
      const frames = p.label === '고정 화면' ? [] : [
        { timeMs: 0, x, y, scale: scale * (p.startScale ?? 1) },
        { timeMs: duration, x: clamp(x + p.end.x), y: clamp(y + p.end.y), scale: scale * p.end.scale },
      ];
      form.setDraftPatch({ keyframes: JSON.stringify(frames), easing: 'ease-in-out' });
    }))));
}

export function actingText(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  const labels = { emotion: '감정', direction: '연기', delivery: '발성', intent: '목적', subtext: '속뜻', pace: '속도', tone: '말투' };
  return Object.entries(value).map(([k, v]) => `${labels[k] ?? k}: ${actingText(v)}`).join('\n');
}
export function actingSuggestions(form) {
  const presets = [
    ['담담하게', '감정을 억누르며 차분하게 말한다. 끝을 크게 강조하지 않는다.'],
    ['따뜻한 걱정', '상대를 걱정하며 따뜻하고 부드럽게 말한다. 과장된 울음은 넣지 않는다.'],
    ['조심스러운 놀람', '예상 밖의 말에 잠깐 멈춘 뒤 조심스럽게 되묻는다.'],
    ['단호하게', '확신을 담아 또렷하게 말한다. 고함을 치지 않는다.'],
  ];
  return el('div', { class: 'suggestions' }, el('p', { class: 'eyebrow' }, '연기 제안'),
    note('원문 대사는 유지하고 연기 지시만 제안합니다. 감정과 속뜻은 아래에서 직접 다듬으세요.'),
    el('div', { class: 'chips' }, presets.map(([label, acting]) => button(label, () => form.setDraftPatch({ acting })))));
}

export function legacyActing(value) {
  if (typeof value !== 'string') return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : value; } catch { return value; }
}
