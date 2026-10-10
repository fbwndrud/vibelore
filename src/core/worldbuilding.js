import { isAbsolute, resolve } from 'node:path';
import { UniverseStore } from '../store/universe-store.js';
import { hashLore } from '../../engine/src/lore/registry.js';
import { requireLore } from '../../engine/src/lore/schemas.js';
import { tokenUnits } from './token-units.js';

export const WORLDBUILDING_SCOPES = Object.freeze(['starter', 'story', 'universe']);
export const WORLDBUILDING_QUESTION_ID = 'worldbuilding-scope';
export const WORLDBUILDING_QUESTIONS = Object.freeze({
  ko: { id: WORLDBUILDING_QUESTION_ID, title: '세계관 준비 범위',
    question: '세계관을 어느 정도까지 정하고 시작할까요? 빨리 시작할 만큼만, 이 작품에 필요한 설정을 자세히, 또는 여러 작품에 쓸 큰 세계까지 준비할 수 있어요. 특히 먼저 정하고 싶은 부분도 편하게 알려 주세요.',
    recommendation: '빠르게 시작하려면 핵심 설정부터 준비하세요. 상세 설계를 원하면 이 작품에 필요한 부분부터 함께 정리할 수 있어요.' },
  multilingual: { id: WORLDBUILDING_QUESTION_ID, title: 'World preparation',
    question: 'How much of the world would you like to prepare before writing: enough to start quickly, detailed settings for this story, or a larger world for several stories? Tell us which parts you want to decide first.',
    recommendation: 'Start with the essentials for a quick beginning. For detailed preparation, build the parts this story needs first.' },
});

const normalized = value => String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const hasAnswer = (source, answer) => typeof answer === 'string' && normalized(answer).length > 0 && normalized(source).includes(normalized(answer));
function focus(value) {
  requireLore(value === undefined || Array.isArray(value) && value.length <= 20 && value.every(v => typeof v === 'string' && v.trim() && v.length <= 1000), 'INVALID_WORLDBUILDING_CHOICE', 'focus must contain at most 20 user-selected areas');
  return value?.map(v => v.trim()) ?? [];
}

/** The model interprets the answer; code verifies its source, never its literary meaning. */
export function resolveWorldbuildingChoice({ requested, proposed, existing, source, changeSource = source, mode }) {
  const settled = existing && WORLDBUILDING_SCOPES.includes(existing.scope) && existing.authority !== 'unconfirmed';
  if (requested !== undefined) {
    requireLore(requested && Object.keys(requested).every(k => ['scope', 'focus', 'userAnswer'].includes(k))
      && WORLDBUILDING_SCOPES.includes(requested.scope) && hasAnswer(source, requested.userAnswer),
    'INVALID_WORLDBUILDING_CHOICE', 'a scope choice needs the user answer from brief or feedback');
    requireLore(!settled || requested.scope === existing.scope || hasAnswer(changeSource, requested.userAnswer), 'INVALID_WORLDBUILDING_CHOICE', 'changing a settled scope needs a new user answer');
    return { scope: requested.scope, focus: focus(requested.focus), authority: 'user', userAnswer: requested.userAnswer };
  }
  if (settled && !hasAnswer(changeSource, proposed?.userAnswer)) return structuredClone(existing);
  if (WORLDBUILDING_SCOPES.includes(proposed?.scope) && hasAnswer(source, proposed.userAnswer)) {
    return { scope: proposed.scope, focus: focus(proposed.focus), authority: 'user', userAnswer: proposed.userAnswer };
  }
  if (settled) return structuredClone(existing);
  return { scope: 'starter', focus: [], authority: mode === 'auto' ? 'delegated' : 'unconfirmed', userAnswer: null };
}

export function ensureWorldbuildingQuestion(review, choice, mode, kit) {
  const others = review.openQuestions.filter(q => q.id !== WORLDBUILDING_QUESTION_ID);
  if (mode !== 'review' || choice.authority !== 'unconfirmed') return { ...review, openQuestions: others };
  // World extent is a later design choice, not the initial interview-depth question.
  if (!review.openQuestions.some(q => q.id === WORLDBUILDING_QUESTION_ID)) return { ...review, openQuestions: others };
  const generated = kit.family !== 'ko' ? review.openQuestions.find(q => q.id === WORLDBUILDING_QUESTION_ID) : null;
  const question = generated ?? WORLDBUILDING_QUESTIONS[kit.family];
  const reading = others.filter(q => q.id === 'reading-experience-contract');
  return { ...review, openQuestions: [...others.filter(q => q.id !== 'reading-experience-contract').slice(0, 4 - reading.length), ...reading, question],
    askedQuestionIds: [...new Set([...review.askedQuestionIds, WORLDBUILDING_QUESTION_ID])].slice(-40) };
}

/** Detailed creation uses a reviewed, pinned world, with an explicit opening selection. */
export async function prepareWorldbuildingSource({ choice, source }) {
  if (!source) {
    requireLore(!choice || choice.scope === 'starter', 'WORLD_BUILDING_PREPARATION_REQUIRED', 'prepare and adopt the requested detailed world with lore_universe, then pass worldbuildingSource');
    return null;
  }
  requireLore(Object.keys(source).every(k => ['worldRoot', 'universeId', 'loreRevisionId', 'documentIds'].includes(k)) && isAbsolute(source.worldRoot ?? '')
    && typeof source.loreRevisionId === 'string' && Array.isArray(source.documentIds) && source.documentIds.length > 0
    && source.documentIds.length <= 100 && new Set(source.documentIds).size === source.documentIds.length,
  'INVALID_WORLDBUILDING_SOURCE', 'pin an adopted world and select its opening documents');
  const world = new UniverseStore(source.worldRoot, source.universeId);
  const current = await world.status();
  requireLore(current.drift.status === 'clean', 'SHARED_LORE_SOURCE_DRIFT', 'adopt world edits before creation');
  const publication = await world.read(source.loreRevisionId);
  requireLore(publication.revision, 'LORE_REVISION_NOT_FOUND', source.loreRevisionId);
  const docs = source.documentIds.map(id => publication.revision.content.documents.find(d => d.id === id));
  requireLore(docs.every(d => d?.visibility === 'context'), 'INVALID_WORLDBUILDING_SOURCE', 'opening documents must exist and be context-visible');
  const contextText = docs.map(d => `Document ${d.id} (${d.path}):\n${d.text}`).join('\n\n');
  requireLore(tokenUnits(contextText) <= 6000, 'SHARED_LORE_CONTEXT_BUDGET', 'select narrower opening documents; the complete world remains preserved');
  return { ...source, registryRevisionId: publication.registry.revisionId,
    documents: docs.map(d => ({ id: d.id, path: d.path, hash: hashLore(d.text) })), contextText };
}

/** Recover only the pinned selection from a host-owned stored source record. */
export function storedWorldbuildingSelection(source) {
  return source ? Object.fromEntries(['worldRoot', 'universeId', 'loreRevisionId', 'documentIds'].map(key => [key, source[key]])) : null;
}

export function requireWorldbuildingBinding(foundation, sharedLore) {
  const source = foundation?.worldbuilding?.source;
  requireLore(!source || sharedLore?.binding?.universeId === source.universeId
    && (sharedLore.binding.loreRevisionId === source.loreRevisionId || resolve(sharedLore.worldRoot) === resolve(source.worldRoot)),
    'WORLD_BUILDING_BINDING_REQUIRED', 'connect the prepared world with lore_bind before story planning or writing');
}
