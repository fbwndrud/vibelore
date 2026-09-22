// Art direction, lettering design and reading format are independent choices.
export const PRESENTATION_REQUIRED = ['W04', 'W15', 'W16'];
export const ART_STYLE_OPTIONS = [
  { value: '선명한 컬러와 또렷한 선, 자연스러운 인체 비례', label: '선명한 컬러형' },
  { value: '강한 잉크선과 명암, 입체적인 인체 강조', label: '미국 코믹스풍 참고' },
  { value: '섬세한 선과 표정 강조, 흑백과 톤 중심', label: '일본 만화풍 참고' },
];
export const PRESENTATION_AREAS = [
  { id: 'W15', title: '문자 표현', dependsOn: [], question: '대사·속생각·설명·효과음을 어떻게 구분할까요? 표시안을 선택하거나 원하는 차이를 말씀해 주세요.', recommendation: 'standard',
    options: [{ value: 'standard', label: '기본 대비형', description: '둥근 대사 풍선, 짙은 독백 상자, 설명 상자, 장면별 효과음.' },
      { value: 'soft', label: '밝은 상자형', description: '둥근 대사 풍선, 밝은 독백 상자, 설명 상자, 장면별 효과음.' },
      { value: 'minimal', label: '상자 최소형', description: '대사는 풍선, 독백·설명은 상자 없이 외곽선 글자.' }],
    custom: '자유 요청은 지원 필드로 정리하고 사용자에게 확인한다. JSON 문자열로 dialogue=round|square, thought=dark|light|plain, caption=box|plain, sfx=contextual|plain|impact 모두 지정. 임의 폰트·곡선 꼬리는 아직 미지원.' },
  { id: 'W16', title: '판면·읽기 방향', dependsOn: [], question: '어떤 형식으로 읽는 만화를 만들까요? 작화 느낌과 별개로 선택해 주세요.', recommendation: 'scroll',
    options: [{ value: 'scroll', label: '세로 스크롤', supported: true }, { value: 'page-ltr', label: '페이지형 · 왼쪽→오른쪽', supported: false },
      { value: 'page-rtl', label: '페이지형 · 오른쪽→왼쪽', supported: false }],
    notice: '페이지형은 선택을 보존하지만 아직 제작 미지원입니다. 세로형으로 자동 변경하지 않고 지원 안내에서 대기합니다. 일본풍=우→좌, 미국풍=페이지형으로 단정하지 않습니다.' },
];

const presets = {
  standard: { dialogue: 'round', thought: 'dark', caption: 'box', sfx: 'contextual' },
  soft: { dialogue: 'round', thought: 'light', caption: 'box', sfx: 'contextual' },
  minimal: { dialogue: 'round', thought: 'plain', caption: 'plain', sfx: 'contextual' },
};
export function letteringStyle(value) {
  if (Object.hasOwn(presets, value)) return { ...presets[value] };
  let style;
  try { style = JSON.parse(value); } catch { throw new Error('LETTERING_CHOICE_REQUIRED: 표시안 또는 지원 필드의 JSON 문자열을 사용자 답변으로 제출하세요.'); }
  const allowed = { dialogue: ['round', 'square'], thought: ['dark', 'light', 'plain'], caption: ['box', 'plain'], sfx: ['contextual', 'plain', 'impact'] };
  if (!style || typeof style !== 'object' || Array.isArray(style) || Object.keys(style).length !== 4 || Object.entries(allowed).some(([k, values]) => !values.includes(style[k]))) throw new Error('UNSUPPORTED_LETTERING_CHOICE');
  return { ...style };
}
export function validatePresentationAnswer(id, value) {
  if (id === 'W15') letteringStyle(value);
  if (id === 'W16' && !['scroll', 'page-ltr', 'page-rtl'].includes(value)) throw new Error('FORMAT_CHOICE_REQUIRED');
}
export function presentationOf(w) {
  if (w.presentationVersion !== 1) return null;
  if (PRESENTATION_REQUIRED.some(id => w.decisions[id]?.status !== 'answered')) return null;
  const format = w.decisions.W16.value;
  validatePresentationAnswer('W16', format);
  return { version: 1, artStyle: w.decisions.W04.value, lettering: letteringStyle(w.decisions.W15.value),
    format, readingDirection: format === 'page-rtl' ? 'rtl' : format === 'page-ltr' ? 'ltr' : 'top-to-bottom', supported: format === 'scroll' };
}

export function letteringAppearance(kind, style) {
  if (kind === 'dialogue') return { box: style.dialogue === 'square' ? 'square' : 'round', fill: 'white', ink: '#202020' };
  if (kind === 'thought') return { box: style.thought === 'plain' ? 'none' : 'square', fill: style.thought === 'dark' ? '#26332e' : '#eef2ed', ink: style.thought === 'dark' ? '#fff' : '#202020' };
  return { box: style.caption === 'plain' ? 'none' : 'square', fill: 'white', ink: '#202020' };
}
