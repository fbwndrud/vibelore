import { creativeDecision } from './creative-decision.js';

/**
 * Read-only views of decisions that their owners already store. Nothing here
 * writes, migrates or upgrades a record. When an owner cannot show the evidence
 * a stronger authority needs, the weaker authority is reported.
 */
const answered = value => typeof value === 'string' && value.trim().length > 0;
// A status read must not fail on an old or damaged timestamp; it is shown as unknown.
const timestamp = value => answered(value) && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : null;
const shortText = (value, max) => answered(value) && value.length <= max;
const list = value => Array.isArray(value) ? value : [];
const DELEGATING_STYLE_SCOPES = ['style', 'production'];
const workScope = workId => ({ level: 'work', ref: { kind: 'work', id: workId } });

function ownerAuthority(record) {
  if (record.authority === 'user') return answered(record.userAnswer) ? 'user' : 'legacy';
  return ['delegated', 'approval', 'unconfirmed'].includes(record.authority) ? record.authority : 'legacy';
}

function ownerEvidence(record, authority) {
  if (authority === 'user') return { userAnswer: record.userAnswer };
  // StoryProfile owners delegate only through mode="auto" today.
  if (authority === 'delegated') return { delegationScope: 'auto-mode' };
  return {};
}

export function profileDecisions(profile, workId) {
  if (!profile || typeof profile !== 'object' || !shortText(workId, 200)) return [];
  const revision = Number.isInteger(profile.revision) && profile.revision >= 0 ? profile.revision : null;
  const common = { lane: 'novel', workId, scope: workScope(workId),
    target: { kind: 'story-profile', id: workId, revision } };
  const owned = (topic, record, value) => {
    const authority = ownerAuthority(record);
    return creativeDecision({ ...common, topic, kind: 'policy', authority, evidence: ownerEvidence(record, authority), value });
  };
  const decisions = [];
  if (profile.discovery && typeof profile.discovery === 'object') {
    decisions.push(owned('preparation-depth', profile.discovery,
      { depth: profile.discovery.depth ?? null, focus: list(profile.discovery.focus) }));
  }
  if (profile.worldbuilding && typeof profile.worldbuilding === 'object') {
    decisions.push(owned('worldbuilding-scope', profile.worldbuilding,
      { scope: profile.worldbuilding.scope ?? null, focus: list(profile.worldbuilding.focus) }));
  }
  // The stored profile does not say whether review or auto mode approved it.
  if (profile.status === 'active') {
    // A later preference edit bumps the revision but keeps the old approval, so
    // the approval names the revision only when it is not older than the last edit.
    const approvedAt = timestamp(profile.approvedAt);
    const edited = profile.updatedAt !== undefined && !(Date.parse(profile.updatedAt) <= Date.parse(approvedAt));
    const approved = { ...common.target, revision: approvedAt !== null && !edited ? revision : null };
    decisions.push(creativeDecision({ ...common, target: approved, topic: 'story-profile', kind: 'goal', authority: 'approval', evidence: {},
      value: { status: 'active' }, decidedAt: approvedAt }));
  }
  return decisions;
}

function styleEvidence(adoption, authority) {
  if (authority === 'user') return { userAnswer: adoption.feedback };
  if (authority !== 'delegated') return {};
  const userAnswer = [adoption.delegation.userAnswer, adoption.feedback].find(answered);
  return {
    delegationScope: adoption.delegation.scope,
    ...(userAnswer !== undefined ? { userAnswer } : {}),
    ...(adoption.choice && typeof adoption.choice === 'object'
      ? { choiceRationale: adoption.choice.rationale ?? null, inspectedImageHash: adoption.choice.imageHash ?? null } : {}),
  };
}

export function webtoonStyleDecision(style) {
  if (!style || typeof style !== 'object' || !shortText(style.workId, 200)) return null;
  const adoption = style.adoption && typeof style.adoption === 'object' ? style.adoption : {};
  const user = adoption.authority === 'user' && answered(adoption.feedback);
  const delegated = adoption.authority === 'delegated' && DELEGATING_STYLE_SCOPES.includes(adoption.delegation?.scope);
  const authority = user ? 'user' : delegated ? 'delegated' : 'legacy';
  const explicitTargets = [...new Set(list(adoption.applyToWorkflows).filter(id => shortText(id, 200)))].slice(0, 100);
  return creativeDecision({ topic: 'webtoon-style', kind: 'preference', lane: 'webtoon', workId: style.workId,
    scope: { ...workScope(style.workId), appliesTo: shortText(adoption.applyTo, 80) ? adoption.applyTo : 'future-scenes', explicitTargets },
    target: { kind: 'webtoon-style', id: style.workId, revision: shortText(style.revisionId, 200) ? style.revisionId : null },
    authority, evidence: styleEvidence(adoption, authority), value: { proposalId: style.proposalId ?? null },
    decidedAt: timestamp(adoption.adoptedAt) });
}
