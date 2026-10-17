import { hashLore, isLoreRevisionId } from './registry.js';
import { LORE_ID_SCHEMA, requireLore, validateShape } from './schemas.js';

const id = value => validateShape(LORE_ID_SCHEMA, value, 'evidence ledger ID');
const fail = (condition, message) => requireLore(condition, 'INVALID_LORE_DATA', message);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 8000;
function closed(value, keys, name) {
  fail(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), `invalid ${name}`);
}
function refs(value) {
  fail(Array.isArray(value) && value.length <= 1000 && new Set(value).size === value.length, 'invalid evidence references');
  value.forEach(id);
}
function records(list, keys, name) {
  fail(Array.isArray(list) && list.length <= 10000, `invalid ${name} list`);
  const map = new Map();
  for (const record of list) {
    closed(record, keys, name); id(record.id);
    fail(!map.has(record.id), `duplicate ${name} ID`);
    map.set(record.id, record);
  }
  return map;
}
function checkRefs(ids, map) {
  refs(ids);
  for (const ref of ids) requireLore(map.has(ref), 'LORE_EVIDENCE_REFERENCE', ref);
}
/** Dependency-first order without recursive traversal or a hidden depth limit. */
function dependencyOrder(map) {
  const pending = new Map(), dependents = new Map(), queue = [];
  for (const record of map.values()) {
    checkRefs(record.dependsOn, map);
    pending.set(record.id, record.dependsOn.length);
    if (!record.dependsOn.length) queue.push(record.id);
    for (const dep of record.dependsOn) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(record.id);
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const dependent of dependents.get(queue[cursor]) ?? []) {
      pending.set(dependent, pending.get(dependent) - 1);
      if (pending.get(dependent) === 0) queue.push(dependent);
    }
  }
  requireLore(queue.length === map.size, 'LORE_EVIDENCE_CYCLE', 'cyclic evidence ledger dependencies');
  return queue;
}
const bases = new Set(['author-decision', 'text-explicit', 'rule-derived', 'model-inferred', 'character-report']);
const canonicalStatuses = new Set(['proposed', 'adopted', 'rejected', 'superseded']);
const questionStatuses = new Set(['open', 'investigating', 'blocked', 'resolved']);
const dispositions = new Set(['verified', 'withdrawn', 'out-of-scope']);
const splitSurrogate = (source, offset) => offset > 0 && offset < source.length
  && /[\uD800-\uDBFF]/u.test(source[offset - 1]) && /[\uDC00-\uDFFF]/u.test(source[offset]);

/** Optional adjunct. It never adopts values or upgrades a legacy document citation. */
export function validateLoreEvidence(content) {
  if (!Object.hasOwn(content, 'evidenceLedger')) return null;
  const ledger = content.evidenceLedger;
  closed(ledger, ['schemaVersion', 'evidence', 'claims', 'questions'], 'evidence ledger');
  fail(ledger.schemaVersion === 1, 'unsupported evidence ledger version');
  const evidence = records(ledger.evidence, ['id', 'basis', 'documentId', 'sourceHash', 'span', 'quote', 'dependsOn'], 'evidence');
  const claims = records(ledger.claims, ['id', 'statement', 'subjectId', 'perspective', 'canonStatus', 'valueId', 'evidenceIds', 'contradictingEvidenceIds', 'dependsOn'], 'claim');
  const questions = records(ledger.questions, ['id', 'question', 'status', 'disposition', 'evidenceIds', 'contradictingEvidenceIds', 'resolutionEvidenceIds', 'dependsOn'], 'question');
  const documents = new Map(content.documents.map(doc => [doc.id, doc]));
  const entities = new Set(content.entities.map(entity => entity.id)), values = new Map(content.values.map(value => [value.id, value]));
  for (const entry of evidence.values()) {
    fail(bases.has(entry.basis), 'unsupported evidence basis'); id(entry.documentId);
    const document = documents.get(entry.documentId);
    requireLore(document, 'LORE_EVIDENCE_REFERENCE', entry.documentId);
    requireLore(isLoreRevisionId(entry.sourceHash) && entry.sourceHash === hashLore(document.text), 'LORE_EVIDENCE_SOURCE_MISMATCH', entry.id);
    if (entry.span === null) {
      fail(entry.quote === null && ['author-decision', 'rule-derived', 'model-inferred'].includes(entry.basis), 'this evidence basis needs an exact quote span');
    } else {
      closed(entry.span, ['from', 'to'], 'quote span');
      const { from, to } = entry.span;
      requireLore(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to > from && to <= document.text.length
        && !splitSurrogate(document.text, from) && !splitSurrogate(document.text, to)
        && text(entry.quote) && document.text.slice(from, to) === entry.quote, 'LORE_EVIDENCE_SPAN_MISMATCH', entry.id);
    }
    refs(entry.dependsOn);
    fail(entry.basis !== 'rule-derived' || entry.dependsOn.length > 0, 'derived evidence needs dependencies');
  }
  const qualifying = new Map();
  for (const evidenceId of dependencyOrder(evidence)) {
    const entry = evidence.get(evidenceId);
    qualifying.set(evidenceId, ['author-decision', 'text-explicit', 'rule-derived'].includes(entry.basis)
      && entry.dependsOn.every(dep => qualifying.get(dep) === true));
  }
  dependencyOrder(claims); dependencyOrder(questions);
  for (const claim of claims.values()) {
    fail(text(claim.statement) && canonicalStatuses.has(claim.canonStatus), 'invalid claim'); id(claim.subjectId);
    requireLore(entities.has(claim.subjectId), 'LORE_EVIDENCE_REFERENCE', claim.subjectId);
    const perspective = claim.perspective;
    fail(perspective && ['world', 'character'].includes(perspective.kind), 'invalid claim perspective');
    closed(perspective, perspective.kind === 'world' ? ['kind'] : ['kind', 'characterId'], 'claim perspective');
    if (perspective.kind === 'character') {
      id(perspective.characterId); requireLore(entities.has(perspective.characterId), 'LORE_EVIDENCE_REFERENCE', perspective.characterId);
    }
    checkRefs(claim.evidenceIds, evidence); checkRefs(claim.contradictingEvidenceIds, evidence);
    if (claim.canonStatus === 'adopted') {
      requireLore(claim.dependsOn.every(ref => claims.get(ref).canonStatus === 'adopted'
        && (perspective.kind === 'character' || claims.get(ref).perspective?.kind === 'world')), 'LORE_CLAIM_UNSUPPORTED', 'adopted claim depends on an unadopted or incompatible perspective');
      requireLore(claim.contradictingEvidenceIds.length === 0, 'LORE_CLAIM_CONTRADICTED', claim.id);
      requireLore(claim.evidenceIds.length > 0 && (perspective.kind === 'character' || claim.evidenceIds.some(ref => qualifying.get(ref))), 'LORE_CLAIM_UNSUPPORTED', claim.id);
    }
    if (claim.valueId !== null) {
      id(claim.valueId); const value = values.get(claim.valueId);
      requireLore(value && value.subject.entityId === claim.subjectId, 'LORE_EVIDENCE_REFERENCE', claim.valueId);
      requireLore(claim.canonStatus === 'adopted', 'LORE_CLAIM_UNSUPPORTED', 'only adopted claims can back adopted values');
      requireLore(perspective.kind === 'character'
        ? value.owner === 'observer' && value.storyScope.observerId === perspective.characterId
        : value.owner !== 'observer', 'LORE_CLAIM_PERSPECTIVE', claim.id);
      // Value citations remain document IDs; support IDs belong to the ledger.
      const pending = [...claim.evidenceIds], visited = new Set();
      for (let i = 0; i < pending.length; i++) {
        const ref = pending[i]; if (visited.has(ref)) continue; visited.add(ref);
        const entry = evidence.get(ref);
        requireLore(value.evidenceIds.includes(entry.documentId), 'LORE_CLAIM_SOURCE', claim.id);
        pending.push(...entry.dependsOn);
      }
    }
  }
  for (const question of questions.values()) {
    fail(text(question.question) && questionStatuses.has(question.status), 'invalid residual question');
    fail(question.status === 'resolved' ? dispositions.has(question.disposition) : question.disposition === null, 'invalid question disposition');
    checkRefs(question.evidenceIds, evidence); checkRefs(question.contradictingEvidenceIds, evidence); checkRefs(question.resolutionEvidenceIds, evidence);
    fail(question.status === 'resolved' || question.resolutionEvidenceIds.length === 0, 'unresolved question has resolution evidence');
    if (question.disposition === 'verified') requireLore(question.dependsOn.every(ref => questions.get(ref).status === 'resolved')
      && question.contradictingEvidenceIds.length === 0
      && question.resolutionEvidenceIds.length > 0 && question.resolutionEvidenceIds.every(ref => question.evidenceIds.includes(ref))
      && question.resolutionEvidenceIds.some(ref => qualifying.get(ref)), 'LORE_QUESTION_UNSUPPORTED', question.id);
  }
  return { evidence, claims, questions };
}

/** Author-facing, pinned lookup; no latest HEAD, extraction or canon mutation. */
export function queryLoreEvidence(content, query = {}) {
  fail(query && Object.getPrototypeOf(query) === Object.prototype && Object.keys(query).every(key => ['valueId', 'claimId', 'questionId'].includes(key))
    && Object.keys(query).length <= 1, 'select one valueId, claimId or questionId');
  Object.values(query).forEach(id);
  const compiled = validateLoreEvidence(content), value = query.valueId ? content.values.find(value => value.id === query.valueId) : null;
  if (query.valueId) requireLore(value, 'LORE_EVIDENCE_NOT_FOUND', query.valueId);
  if (!compiled) {
    requireLore(!query.claimId && !query.questionId, 'LORE_EVIDENCE_NOT_FOUND', 'legacy world has no structured claims/questions');
    return { status: 'legacy_unclassified', sourceDocumentIds: value?.evidenceIds ?? [], evidence: [], claims: [], questions: [] };
  }
  const { evidence, claims, questions } = compiled;
  if (!Object.keys(query).length) return { status: 'ok', schemaVersion: 1, counts: { evidence: evidence.size, claims: claims.size, questions: questions.size } };
  if (query.claimId) requireLore(claims.has(query.claimId), 'LORE_EVIDENCE_NOT_FOUND', query.claimId);
  if (query.questionId) requireLore(questions.has(query.questionId), 'LORE_EVIDENCE_NOT_FOUND', query.questionId);
  const selectedClaims = query.valueId ? [...claims.values()].filter(claim => claim.valueId === query.valueId) : query.claimId ? [claims.get(query.claimId)] : [];
  const selectedQuestions = query.questionId ? [questions.get(query.questionId)] : [];
  function dependencies(selected, map) {
    const result = new Map(selected.map(item => [item.id, item])), pending = [...selected];
    for (let i = 0; i < pending.length; i++) for (const ref of pending[i].dependsOn) if (!result.has(ref)) { result.set(ref, map.get(ref)); pending.push(map.get(ref)); }
    return [...result.values()];
  }
  const claimRecords = dependencies(selectedClaims, claims), questionRecords = dependencies(selectedQuestions, questions);
  const selectedEvidence = new Set([...claimRecords, ...questionRecords].flatMap(record => [...record.evidenceIds, ...record.contradictingEvidenceIds, ...(record.resolutionEvidenceIds ?? [])]));
  return structuredClone({ status: query.valueId && !selectedClaims.length ? 'unclassified' : 'ok', schemaVersion: 1,
    sourceDocumentIds: value?.evidenceIds ?? [], claims: claimRecords, questions: questionRecords,
    evidence: dependencies([...selectedEvidence].map(ref => evidence.get(ref)), evidence) });
}
