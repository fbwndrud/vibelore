import { assertInteger, assertText, fail } from './contracts.js';

export function budgetSnapshot(store, projectId) {
  const budgetMicros = store.requireProject(projectId).budgetMicros;
  const rows = store.all('SELECT * FROM budget_reservations WHERE project_id=?', projectId);
  const sum = (status, field) =>
    rows.filter((r) => r.status === status).reduce((n, r) => n + r[field], 0);
  const reservedEstimateMicros = sum('reserved', 'estimate_micros');
  const heldUnknownEstimateMicros = sum('held_unknown', 'estimate_micros');
  const settledActualMicros = rows
    .filter((r) => r.status === 'settled' && r.amount_kind === 'actual')
    .reduce((n, r) => n + r.settled_micros, 0);
  const settledConservativeMicros = rows
    .filter((r) => r.status === 'settled' && r.amount_kind === 'conservative')
    .reduce((n, r) => n + r.settled_micros, 0);
  return {
    budgetMicros,
    reservedEstimateMicros,
    heldUnknownEstimateMicros,
    settledActualMicros,
    settledConservativeMicros,
    availableMicros:
      budgetMicros -
      reservedEstimateMicros -
      heldUnknownEstimateMicros -
      settledActualMicros -
      settledConservativeMicros
  };
}
export function reserve(store, projectId, attemptId, estimateMicros) {
  assertInteger(estimateMicros);
  if (budgetSnapshot(store, projectId).availableMicros < estimateMicros)
    fail('BUDGET_EXCEEDED', 'The request exceeds the remaining application budget.');
  store.run(
    'INSERT INTO budget_reservations(project_id,attempt_id,status,estimate_micros) VALUES(?,?,?,?)',
    projectId,
    attemptId,
    'reserved',
    estimateMicros
  );
}
export function release(store, projectId, attemptId, reason) {
  store.run(
    "UPDATE budget_reservations SET status='released',evidence_json=? WHERE project_id=? AND attempt_id=? AND status='reserved'",
    JSON.stringify({ kind: 'definite_non_dispatch', reason }),
    projectId,
    attemptId
  );
}
export function holdUnknown(store, projectId, attemptId) {
  store.run(
    "UPDATE budget_reservations SET status='held_unknown' WHERE project_id=? AND attempt_id=? AND status='reserved'",
    projectId,
    attemptId
  );
}
export function reconcileBudget(store, projectId, attemptId, evidence) {
  if (!['verified_actual', 'verified_non_billable', 'conservative_charge'].includes(evidence?.kind))
    fail('INVALID_INPUT', 'Expected an explicit billing decision.');
  assertText(evidence.reference);
  assertText(evidence.actor);
  assertInteger(evidence.amountMicros);
  if (evidence.kind === 'verified_non_billable' && evidence.amountMicros !== 0)
    fail('INVALID_INPUT', 'Non-billable evidence must have zero amount.');
  const current = store.get(
    'SELECT status FROM budget_reservations WHERE project_id=? AND attempt_id=?',
    projectId,
    attemptId
  );
  if (!current || current.status === 'released')
    fail('INVALID_STATE', 'Reservation cannot be reconciled.');
  store.run(
    'UPDATE budget_reservations SET status=?,settled_micros=?,amount_kind=?,evidence_json=? WHERE project_id=? AND attempt_id=?',
    evidence.kind === 'verified_non_billable' ? 'released' : 'settled',
    evidence.amountMicros,
    evidence.kind === 'conservative_charge' ? 'conservative' : 'actual',
    JSON.stringify(evidence),
    projectId,
    attemptId
  );
}
export function reservationSnapshot(store, projectId) {
  return store
    .all('SELECT * FROM budget_reservations WHERE project_id=? ORDER BY rowid', projectId)
    .map((r) => ({
      attemptId: r.attempt_id,
      status: r.status,
      estimateMicros: r.estimate_micros,
      estimateKind: 'estimate',
      settledMicros: r.settled_micros,
      amountKind: r.amount_kind,
      evidence: r.evidence_json ? JSON.parse(r.evidence_json) : null
    }));
}
