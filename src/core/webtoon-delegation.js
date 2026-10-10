import { nonempty, safeId } from './webtoon-contract.js';

/** The host interprets the user's words; the server records and enforces their bounded delegation. */
export const WEBTOON_DELEGATION_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  scope: { type: 'string', enum: ['preview', 'style', 'production'], description: '이번 요청의 위임 범위. preview=예시만 만들고 사용자 선택 대기, style=화풍 선택까지, production=요청한 원작 범위 제작까지. 기존 장면 수정·발행 권한으로 확대하지 않는다.' },
  userAnswer: { type: 'string', minLength: 1, maxLength: 8000, description: '위임한 실제 사용자 원답. 언어 해석과 제약 추출은 호스트 LLM 책임이며 무응답은 위임이 아니다.' },
  apiPolicy: { type: 'string', enum: ['existing-only', 'allow', 'forbid'], description: '기본 existing-only=기존 승인 API만 재사용, allow=사용자가 새 API 비용도 허용, forbid=최신 무료/무과금 제한으로 기존 API도 사용 금지.' },
  maxAutoRevisions: { type: 'integer', minimum: 0, maximum: 3, description: '사용자가 허용한 자동 재설계 상한. 한 번만/다시 그리지 마는 0. scene autoRevisions가 더 크면 거절한다.' },
  reviseWorkflows: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string' }, description: '사용자가 명시적으로 수정까지 맡긴 기존 장면 ID만 기록한다. 미지정은 기존 장면 수정 권한이 없다.' },
}, required: ['scope', 'userAnswer'] };

export function webtoonDelegation(value) {
  if (value == null) return null;
  if (!['preview', 'style', 'production'].includes(value.scope) || !nonempty(value.userAnswer) || value.userAnswer.length > 8000
    || (value.apiPolicy !== undefined && !['existing-only', 'allow', 'forbid'].includes(value.apiPolicy))
    || (value.maxAutoRevisions !== undefined && (!Number.isInteger(value.maxAutoRevisions) || value.maxAutoRevisions < 0 || value.maxAutoRevisions > 3))
    || (value.reviseWorkflows !== undefined && (!Array.isArray(value.reviseWorkflows) || value.reviseWorkflows.length > 100
      || new Set(value.reviseWorkflows).size !== value.reviseWorkflows.length || !value.reviseWorkflows.every(safeId)))) {
    throw new Error('INVALID_WEBTOON_DELEGATION');
  }
  return { scope: value.scope, userAnswer: value.userAnswer, apiPolicy: value.apiPolicy ?? 'existing-only',
    ...(value.reviseWorkflows !== undefined ? { reviseWorkflows: value.reviseWorkflows } : {}),
    ...(value.maxAutoRevisions !== undefined ? { maxAutoRevisions: value.maxAutoRevisions } : {}) };
}

export const delegatesStyleChoice = delegation => ['style', 'production'].includes(delegation?.scope);
export const styleDecisionStage = delegation => delegatesStyleChoice(delegation) ? 'needs_style_decision' : 'awaiting_style_approval';
