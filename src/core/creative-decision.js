import { requireLore } from '../../engine/src/lore/schemas.js';

/**
 * One vocabulary for creative decisions that each owner already stores in its
 * own shape: what was decided, about which exact revision, how far it reaches
 * and on whose authority. A record never claims more than its evidence shows.
 * An approval step is not a direct user answer, and an unconfirmed default is
 * reported as unconfirmed, never as a user decision.
 */
export const DECISION_LEVELS = Object.freeze(['selection', 'artifact', 'subject', 'work', 'personal']);
export const DECISION_AUTHORITIES = Object.freeze(['user', 'delegated', 'approval', 'legacy', 'unconfirmed']);
export const DECISION_KINDS = Object.freeze(['fact', 'preference', 'goal', 'policy']);
export const DECISION_LANES = Object.freeze(['novel', 'webtoon']);

const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const check = (condition, message) => requireLore(condition, 'INVALID_CREATIVE_DECISION', message);
const exactRevision = value => value === null || (Number.isInteger(value) && value >= 0) || text(value, 200);

export function creativeDecision(input) {
  const { topic, kind, lane, workId = null, scope, target, authority, evidence = {}, value = null, decidedAt = null } = input ?? {};
  check(text(topic, 200), 'topic must be a short non-empty string');
  check(DECISION_KINDS.includes(kind), `kind must be one of ${DECISION_KINDS.join(', ')}`);
  check(DECISION_LANES.includes(lane), `lane must be one of ${DECISION_LANES.join(', ')}`);
  check(Boolean(scope) && DECISION_LEVELS.includes(scope.level), `scope.level must be one of ${DECISION_LEVELS.join(', ')}`);
  check(text(scope.ref?.kind, 80) && text(scope.ref?.id, 200), 'scope.ref needs kind and id');
  check(scope.appliesTo === undefined || text(scope.appliesTo, 80), 'scope.appliesTo must be a short label');
  const { explicitTargets } = scope;
  check(explicitTargets === undefined || Array.isArray(explicitTargets) && explicitTargets.length <= 100
    && new Set(explicitTargets).size === explicitTargets.length && explicitTargets.every(id => text(id, 200)),
  'scope.explicitTargets must be unique ids the user named');
  check(workId === null || text(workId, 200), 'workId must be null or a short non-empty id');
  check(scope.level === 'personal' || workId !== null, 'a work-bound decision needs workId');
  check(Boolean(target) && text(target.kind, 80) && text(target.id, 200) && exactRevision(target.revision),
    'target needs kind, id and an exact revision or null');
  check(DECISION_AUTHORITIES.includes(authority), `authority must be one of ${DECISION_AUTHORITIES.join(', ')}`);
  check(Boolean(evidence) && typeof evidence === 'object' && !Array.isArray(evidence), 'evidence must be an object');
  check(authority !== 'user' || text(evidence.userAnswer, Infinity), 'a user decision needs the actual user answer');
  check(authority !== 'delegated' || text(evidence.delegationScope, 80), 'a delegated decision needs the delegation scope');
  check(scope.level !== 'personal' || authority === 'user', 'only the user can decide for all of their works');
  check(decidedAt === null || (text(decidedAt, 40) && !Number.isNaN(Date.parse(decidedAt))), 'decidedAt must be an ISO timestamp or null');
  return structuredClone({
    schemaVersion: 1, topic, kind, lane, workId,
    scope: { level: scope.level, ref: { kind: scope.ref.kind, id: scope.ref.id },
      ...(scope.appliesTo !== undefined ? { appliesTo: scope.appliesTo } : {}),
      ...(explicitTargets !== undefined ? { explicitTargets } : {}) },
    target: { kind: target.kind, id: target.id, revision: target.revision },
    authority, evidence, value, decidedAt,
  });
}
