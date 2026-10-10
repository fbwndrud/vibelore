import { requireLore } from '../../engine/src/lore/schemas.js';

export const DISCOVERY_DEPTHS = Object.freeze(['quick', 'standard', 'deep']);
export const DISCOVERY_QUESTION_ID = 'discovery-depth';
export const DISCOVERY_QUESTIONS = Object.freeze({
  ko: { id: DISCOVERY_QUESTION_ID, title: '시작 전 함께 정할 정도',
    question: '이야기를 쓰기 전에 얼마나 함께 묻고 정하면 좋을까요? 꼭 필요한 것만 정하고 시작해도 되고, 중요한 선택들을 함께 정해도 되고, 세계관·인물·이야기·문체까지 충분히 살펴봐도 돼요. 특히 깊게 다루고 싶은 부분이 있으면 알려 주세요.',
    recommendation: '원하는 만큼 준비하면 됩니다. 진행하다가 질문을 줄이거나 더 자세히 정하는 쪽으로 바꿀 수 있어요.' },
  multilingual: { id: DISCOVERY_QUESTION_ID, title: 'How much to decide together',
    question: 'Before we start writing, how much would you like us to ask and decide together: just the essentials, the important choices, or a thorough exploration of the world, characters, story and voice? Tell us if there are areas you want to explore more deeply.',
    recommendation: 'Choose the amount of preparation you want. You can ask for fewer questions or more detail as we go.' },
});

const normalized = value => String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const quoted = (source, answer) => typeof answer === 'string' && normalized(answer).length > 0 && normalized(source).includes(normalized(answer));
const validFocus = value => value === undefined || Array.isArray(value) && value.length <= 20
  && value.every(v => typeof v === 'string' && v.trim() && v.length <= 1000);

/** The model interprets free answers; the runtime checks actual provenance. */
export function resolveDiscoveryPreference({ requested, proposed, existing, source, changeSource = source, mode, legacy = false }) {
  const settled = existing && DISCOVERY_DEPTHS.includes(existing.depth) && existing.authority !== 'unconfirmed';
  const candidate = requested ?? proposed;
  if (requested !== undefined) requireLore(requested && Object.keys(requested).every(k => ['depth', 'focus', 'userAnswer'].includes(k))
    && DISCOVERY_DEPTHS.includes(requested.depth) && quoted(source, requested.userAnswer) && validFocus(requested.focus),
  'INVALID_DISCOVERY_PREFERENCE', 'a preparation preference needs the actual user answer from brief or feedback');
  if (settled && !quoted(changeSource, candidate?.userAnswer)) {
    requireLore(requested === undefined || requested.depth === existing.depth && JSON.stringify(requested.focus ?? []) === JSON.stringify(existing.focus ?? []),
      'INVALID_DISCOVERY_PREFERENCE', 'changing preparation preferences needs a new user answer');
    return structuredClone(existing);
  }
  if (DISCOVERY_DEPTHS.includes(candidate?.depth) && quoted(source, candidate.userAnswer)) {
    requireLore(validFocus(candidate.focus), 'INVALID_DISCOVERY_PREFERENCE', 'invalid focus areas');
    return { depth: candidate.depth, focus: (candidate.focus ?? []).map(v => v.trim()), authority: 'user', userAnswer: candidate.userAnswer };
  }
  if (settled) return structuredClone(existing);
  return { depth: mode === 'auto' ? 'quick' : 'standard', focus: [],
    authority: mode === 'auto' ? 'delegated' : legacy ? 'legacy' : 'unconfirmed', userAnswer: null };
}

export function applyDiscoveryQuestions(review, preference, mode, kit) {
  const questions = review.openQuestions.filter(q => q.id !== DISCOVERY_QUESTION_ID);
  if (mode === 'auto') return { ...review, openQuestions: [] };
  if (preference.authority === 'unconfirmed') {
    const generated = kit.family !== 'ko' ? review.openQuestions.find(q => q.id === DISCOVERY_QUESTION_ID
      && ['title', 'question', 'recommendation'].every(k => typeof q[k] === 'string' && q[k].trim())) : null;
    const question = generated ?? DISCOVERY_QUESTIONS[kit.family];
    // These are the questions actually exposed, not discarded provisional questions.
    return { ...review, openQuestions: [question],
      askedQuestionIds: [...new Set([...review.askedQuestionIds.filter(id => !review.openQuestions.some(q => q.id === id)), DISCOVERY_QUESTION_ID])].slice(-40) };
  }
  const max = preference.depth === 'quick' ? 3 : 5;
  const reading = questions.filter(q => q.id === 'reading-experience-contract');
  const selected = [...questions.filter(q => q.id !== 'reading-experience-contract').slice(0, max - reading.length), ...reading];
  return { ...review, openQuestions: selected };
}
