// Narrative lettering and physical writing have different production owners.
// Legacy plans without a policy version keep their saved rendering semantics.
export const TEXT_POLICY_VERSION = 1;
export const imageText = text => text?.kind === 'ui' && text.render === 'image';
export const physicalTexts = shot => shot.texts.filter(imageText).map(({ text, surface }) => ({ text, surface }));
export const visibleVoices = shot => (shot.voices ?? []).filter(v => shot.texts.some(t => t.speaker === v.id && t.kind === 'dialogue' && t.delivery !== 'offscreen'));
export function scriptText(text, shot, version) {
  if (!version) return `${text.speaker}: ${text.text}`;
  const label = { dialogue: '대사', thought: '속생각', caption: '설명', sfx: '효과음', ui: '사물 글자' }[text.kind];
  const speaker = shot.voices?.find(v => v.id === text.speaker)?.description ?? text.speaker;
  return imageText(text) ? `[${label} · 그림에 포함 · ${text.surface}] ${text.text}`
    : `[${label}${text.delivery === 'offscreen' ? ' · 화면 밖' : ''}] ${speaker}: ${text.text}`;
}
export const TEXT_DIRECTION = '문자 역할을 먼저 분류한다. dialogue는 실제 발화, thought는 특정 인물의 속생각, caption은 서술/시간 압축, sfx는 소리다. 간판·안내판·문서·모니터 문구는 ui + render="image" + surface(실제 사물과 표면 위치)로 지정한다. 정확한 원문은 texts에 보존하고 사물 글자는 이미지 생성에 포함하며 조판 상자로 중복 출력하지 않는다. 중요한 이름·연도는 생성 후 실제 읽힌 글자와 대조한다. 단역의 대화를 narrator 캡션으로 위장하지 않는다. 단역 화자는 shot.voices의 id/description/sourceIds로 원작 근거를 명시한다. 화면 밖 발화는 delivery="offscreen"으로 표시한다. 독백은 화자 ID를 보존한다. 기존 원작 인물을 단역 ID로 다시 만들지 않는다.';

export const TEXT_SCHEMA = {
  kind: 'dialogue|thought|caption|sfx|ui', speaker: '인물 ID / 선언된 단역 voice ID / narrator / system', text: '정확 문자열',
  render: 'ui는 image, 나머지는 overlay 또는 생략',
  surface: 'ui만: 실제 사물과 글자가 놓일 표면·위치',
  delivery: 'dialogue만: onscreen 또는 offscreen, 생략하면 onscreen',
};
