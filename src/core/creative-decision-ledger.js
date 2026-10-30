import { requireLore } from '../../engine/src/lore/schemas.js';
import { creativeDecision } from './creative-decision.js';
import { MAX_DRAFT_PREFERENCES, MAX_PREFERENCE_STATEMENT_CHARS, unsafePromptTextReason } from './draft-input-compiler.js';

/**
 * The user's lasting creative preferences for one work. Each item is a
 * creativeDecision plus ledger fields. Only the host adopts one, after the user
 * states it, and only on the user's authority. A preference is never widened
 * to a larger scope without a new user answer. Retired items stay as history.
 * Active items reach the workflow's draft and revisions as soft guidance, and
 * the coherence review reports adherence as advisories; they are never canon.
 */
export const LEDGER_LEVELS = Object.freeze(['subject', 'work']);
export const LEDGER_KINDS = Object.freeze(['preference', 'goal']);
export const MAX_ACTIVE_DECISIONS = MAX_DRAFT_PREFERENCES;
export const MAX_STATEMENT_CHARS = MAX_PREFERENCE_STATEMENT_CHARS;
export const MAX_USER_ANSWER_CHARS = 4000;

const WIDTH = { subject: 1, work: 2 };
const check = (condition, message) => requireLore(condition, 'INVALID_CREATIVE_DECISION', message);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && [...value].length <= max;
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
// Accidental variants (composed form, zero-width/format characters, spacing) are still the same answer.
const answerKey = (value) => oneLine(String(value ?? '').normalize('NFC').replace(/\p{Cf}/gu, ''));
const sameAnswer = (a, b) => answerKey(a) === answerKey(b);
const validDate = (value) => typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nextId = (items) => `dec-${items.reduce((max, item) => Math.max(max, Number(/^dec-(\d+)$/.exec(item.id)?.[1] ?? 0)), 0) + 1}`;

export function emptyCreativeDecisions(workId) {
  return { schemaVersion: 1, workId, revision: 0, items: [] };
}

/** Fail closed: a damaged item refuses the whole ledger instead of silently dropping the user's preferences. */
function checkStoredItem(item, index, seen) {
  const where = `the stored creative decision ledger is damaged at item ${index}`;
  check(plain(item) && typeof item.id === 'string' && /^dec-\d+$/.test(item.id) && !seen.has(item.id), `${where}: id`);
  seen.add(item.id);
  check(item.status === 'active' || item.status === 'retired', `${where}: status`);
  check(plain(item.scope) && LEDGER_LEVELS.includes(item.scope.level) && plain(item.scope.ref) && text(item.scope.ref.id, Infinity), `${where}: scope`);
  check(item.authority === 'user', `${where}: authority`);
  check(plain(item.evidence) && text(item.evidence.userAnswer, Infinity), `${where}: evidence`);
  check(text(item.statement, Infinity), `${where}: statement`);
}

/** A copy of the stored ledger, or an empty one when the work has none yet. */
export function readCreativeDecisions(stored, workId) {
  if (stored === null || stored === undefined) return emptyCreativeDecisions(workId);
  check(!plain(stored) || stored.workId === workId || typeof stored.workId !== 'string',
    `the stored creative decision ledger belongs to work ${stored.workId}, not ${workId}; check the workId argument`);
  check(plain(stored) && stored.schemaVersion === 1 && stored.workId === workId
    && Number.isSafeInteger(stored.revision) && stored.revision >= 0 && Array.isArray(stored.items),
  'the stored creative decision ledger has an unknown shape');
  const seen = new Set();
  stored.items.forEach((item, index) => checkStoredItem(item, index, seen));
  return structuredClone(stored);
}

export const activeCreativeDecisions = (ledger) => ledger.items.filter((item) => item.status === 'active');

export function adoptCreativeDecision(stored, input, { workId, at, characterIds }) {
  const ledger = readCreativeDecisions(stored, workId);
  const { statement: rawStatement, userAnswer, level, subjectId = null, kind = 'preference', topic = kind, authority = 'user', supersedes = null } = input ?? {};
  check(authority === 'user', 'only the user can adopt a creative decision');
  check(validDate(at), 'at must be a date string');
  // One line before the length check and screening, so a stray newline cannot open a heading in the prompt.
  const statement = typeof rawStatement === 'string' ? oneLine(rawStatement) : rawStatement;
  check(LEDGER_LEVELS.includes(level), `level must be one of ${LEDGER_LEVELS.join(', ')}`);
  check(LEDGER_KINDS.includes(kind), `kind must be one of ${LEDGER_KINDS.join(', ')}; facts belong in canon and policy in lore_configure`);
  check(level === 'subject'
    ? text(subjectId, 120) && !/\s/u.test(subjectId) && unsafePromptTextReason(subjectId) === null
    : subjectId === null, 'a subject decision needs one character id and a work decision takes none');
  // A name or typo would be stored and then never reach any chapter; refuse it when the work's ids are known.
  if (level === 'subject' && Array.isArray(characterIds)) {
    const shown = characterIds.slice(0, 20).join(', ') + (characterIds.length > 20 ? ', …' : '');
    check(characterIds.includes(subjectId), `subjectId must be a character id of this work: ${shown || '(none)'}`);
  }
  check(text(statement, MAX_STATEMENT_CHARS), `statement must be non-empty and at most ${MAX_STATEMENT_CHARS} characters`);
  const unsafe = unsafePromptTextReason(statement);
  check(unsafe === null, `statement cannot enter the writer prompt (${unsafe})`);
  check(text(userAnswer, MAX_USER_ANSWER_CHARS), `userAnswer must hold the user's exact words, at most ${MAX_USER_ANSWER_CHARS} characters`);
  const active = activeCreativeDecisions(ledger);
  const replaced = supersedes === null ? null : active.find((item) => item.id === supersedes) ?? null;
  check(supersedes === null || replaced !== null, `supersedes must name an active decision: ${supersedes}`);
  // The same user words never justify a wider scope than any item, active or retired, was adopted at.
  const widened = ledger.items.some((item) => WIDTH[level] > WIDTH[item.scope.level] && sameAnswer(item.evidence.userAnswer, userAnswer));
  requireLore(!widened, 'CREATIVE_DECISION_SCOPE_WIDENED', 'a wider scope needs a new user answer; ask the user before widening this decision');
  check(active.length - (replaced ? 1 : 0) < MAX_ACTIVE_DECISIONS, `a work keeps at most ${MAX_ACTIVE_DECISIONS} active decisions; retire or supersede one first`);
  const revision = ledger.revision + 1;
  const record = creativeDecision({
    topic, kind, lane: 'novel', workId,
    scope: { level, ref: level === 'subject' ? { kind: 'character', id: subjectId } : { kind: 'work', id: workId } },
    target: { kind: 'creative-decisions', id: workId, revision },
    authority: 'user', evidence: { userAnswer }, value: null, decidedAt: at,
  });
  const adopted = { id: nextId(ledger.items), status: 'active', statement, supersedes, adoptedAt: at, retiredAt: null, ...record };
  if (replaced) Object.assign(replaced, { status: 'retired', retiredAt: at });
  ledger.items.push(adopted);
  ledger.revision = revision;
  return { ledger, adopted, retired: replaced };
}

export function retireCreativeDecision(stored, { id } = {}, { workId, at }) {
  const ledger = readCreativeDecisions(stored, workId);
  check(validDate(at), 'at must be a date string');
  const item = activeCreativeDecisions(ledger).find((entry) => entry.id === id);
  check(item !== undefined, `id must name an active decision: ${id}`);
  Object.assign(item, { status: 'retired', retiredAt: at });
  ledger.revision += 1;
  return { ledger, retired: item };
}

/** What the user sees: the statement, its scope, their own words and the dates. */
export function creativeDecisionView(item) {
  return { id: item.id, status: item.status, kind: item.kind, topic: item.topic, statement: item.statement,
    scope: item.scope, userAnswer: item.evidence.userAnswer, supersedes: item.supersedes,
    adoptedAt: item.adoptedAt, retiredAt: item.retiredAt };
}

export function creativeDecisionStatus(stored, workId) {
  const ledger = readCreativeDecisions(stored, workId);
  return { revision: ledger.revision, active: activeCreativeDecisions(ledger).map(creativeDecisionView),
    retired: ledger.items.filter((item) => item.status === 'retired').map(creativeDecisionView) };
}

/** Draft input: only the host-written statement, never the user's own words. */
export function creativePreferencesForDraft(stored, workId) {
  return activeCreativeDecisions(readCreativeDecisions(stored, workId))
    .map((item) => ({ id: item.id, level: item.scope.level, ref: item.scope.ref.id, statement: item.statement }));
}

/** The set one workflow works under: the ledger revision (null without a ledger file) and the active statements. */
export function creativePreferencePin(stored, workId) {
  return { revision: stored === null || stored === undefined ? null : readCreativeDecisions(stored, workId).revision,
    items: creativePreferencesForDraft(stored, workId) };
}

/** Item order comes from the ledger, so structural equality is stable. */
export function samePreferencePin(a, b) {
  return plain(a) && plain(b) && JSON.stringify(a) === JSON.stringify(b);
}
