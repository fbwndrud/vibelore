import { createHash } from 'node:crypto';

const splitSurrogate = (source, offset) => offset > 0 && offset < source.length
  && /[\uD800-\uDBFF]/u.test(source[offset - 1]) && /[\uDC00-\uDFFF]/u.test(source[offset]);

/** Editorial acceptance of an extraction is separate from the truth of its interpretations. */
export function buildChapterObservation({ chapter, prose, delta, checkReceipt = null, executionContext }) {
  const sourceHash = `sha256:${createHash('sha256').update(prose).digest('hex')}`;
  const influenceEvents = Array.isArray(delta.influenceEvents) ? delta.influenceEvents : [];
  const evidence = [], claims = [];
  for (const [index, event] of influenceEvents.entries()) {
    const anchor = typeof event.anchor === 'string' ? event.anchor : '';
    const from = anchor.trim() ? prose.indexOf(anchor) : -1, evidenceId = `influence-${index}-anchor`;
    const repeated = from >= 0 && prose.indexOf(anchor, from + 1) >= 0;
    const boundary = !splitSurrogate(prose, from) && !splitSurrogate(prose, from + anchor.length);
    const exact = from >= 0 && !repeated && boundary;
    evidence.push({ id: evidenceId, basis: exact ? 'text-explicit' : 'model-inferred', sourceKind: 'chapter', chapter, sourceHash,
      span: exact ? { from, to: from + anchor.length } : null, quote: exact ? anchor : null, anchor,
      limitations: [exact ? 'quote_presence_only' : repeated ? 'ambiguous_anchor' : from >= 0 && !boundary ? 'invalid_anchor_boundary' : 'anchor_not_found'], dependsOn: [],
      producer: { kind: 'model-extraction', checkId: checkReceipt?.checkId ?? null, workflowId: checkReceipt?.workflowId ?? null } });
    const common = { basis: 'model-inferred', canonStatus: 'proposed', evidenceIds: [evidenceId],
      storyScope: { worldline: executionContext.worldline ?? 'main', chapter } };
    const add = (kind, statement, subjectId, targetId = null) => {
      if (typeof statement !== 'string' || !statement.trim()) return;
      claims.push({ id: `influence-${index}-claim-${claims.length}`, kind, statement, subjectId, targetId,
        perspective: { kind: 'character', characterId: subjectId }, ...common });
    };
    add('interpretation', event.interpretation, event.characterId);
    add('behavioral-hypothesis', event.behavioralProof?.hypothesis, event.characterId);
    for (const relationship of event.relationshipClaims ?? []) add('relationship-belief', relationship.belief, relationship.from, relationship.to);
  }
  return {
    observationId: checkReceipt ? `check:${checkReceipt.checkId}` : `legacy-manual:${chapter}:${sourceHash}`,
    sourceHash, status: 'accepted', acceptedAt: executionContext.transactionTime,
    policyRevision: executionContext.policyRevision, worldline: executionContext.worldline ?? 'main', influenceEvents,
    noInfluenceReason: influenceEvents.length ? null : String(delta.noInfluenceReason ?? '').trim() || null,
    temporal: {
      storyTimeScope: { worldline: executionContext.worldline ?? 'main', startOrdinal: chapter, endOrdinalExclusive: null, precision: 'chapter', tieGroup: null },
      publicationFrom: chapter, publicationTo: null, transactionFrom: chapter, transactionTo: null,
    },
    // A published chapter does not prove every embedded statement, private belief or reader disclosure.
    epistemic: { truthAssertions: [], readerAssertions: [], knowers: [], believers: [], disbelievers: [] },
    evidenceLedger: { schemaVersion: 1, evidence, claims },
    acceptance: checkReceipt ? {
      kind: 'workflow_check_and_canon_acceptance', checkId: checkReceipt.checkId,
      workflowId: checkReceipt.workflowId, checkedAt: checkReceipt.checkedAt, proseHash: checkReceipt.proseHash,
    } : { kind: 'legacy_manual_commit', migrationRequired: true },
  };
}
