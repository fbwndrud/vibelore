// Transport summaries never replace persisted evidence or approval subjects.
export function compactWebtoonState(state) {
  const { plan, inherited, references, decisions, editorial, continuity, artifacts, ...rest } = state;
  return { ...rest, detail: 'summary',
    counts: { shots: plan?.sequences?.flatMap(s => s.shots).length, references: references?.length, artifacts: Object.keys(artifacts ?? {}).length },
    ...(continuity ? { continuity: { version: continuity.version, planHash: continuity.planHash,
      shots: continuity.shots, roughs: continuity.roughs, reviewProvenance: continuity.reviewProvenance,
      ...(continuity.version === 2 ? { storyboardApproved: continuity.storyboardApproved, approval: continuity.approval, transitions: continuity.transitions } : {}) } } : {}),
    artifacts: Object.fromEntries(Object.entries(artifacts ?? {}).filter(([name]) => ['episode.html', 'episode.svg', 'board.html', 'references.html', 'storyboard.html', 'lettering.json'].includes(name))),
    detailRequest: { tool: 'lore_workflow_inspect', lane: 'webtoon', workId: state.workId, workflowId: state.workflowId, detail: 'full' } };
}

export const unavailableComposite = response => response?.inspectionUnavailable?.scope === 'composite'
  && typeof response.inspectionUnavailable.reason === 'string' && response.inspectionUnavailable.reason.trim()
  && response.inspectedImages !== true;

export function unavailableReview(subjectHash, records, reason) {
  return { subjectHash, inspectedImages: false, failed: true, coveredIds: [],
    findings: [...records.flatMap(r => [...(r.response?.findings ?? []),
      ...[...(r.response?.observations ?? []), ...(r.response?.transitions ?? [])].filter(e => e.verdict !== 'clear')
        .map(e => ({ code: 'SEGMENT_SEMANTIC_CONCERN', ...e, message: e.evidence }))]),
      { code: 'COMPOSITE_UNAVAILABLE', message: reason, evidence: 'Host-reported unavailability; no replacement renderer or fabricated inspection.', advisoryOnly: true }] };
}
