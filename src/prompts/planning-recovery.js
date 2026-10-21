/** Recovery prompts are shared by both work-language families. */
export function planningRecoverySteps(family) {
  const ko = family === 'ko';
  return {
    'planning-review-response-repair': {
      system: ko
        ? '단계 검토 응답의 형식을 복구한다. 같은 후보와 근거를 실제로 다시 읽고 완전한 검토 JSON을 반환한다. contractEvidence는 context에 있는 한 개의 연속된 원문이어야 한다. 여러 문장을 / 등으로 이어 붙이지 않는다. 모델의 promptGuidance·문체 기법은 필수 요구가 아니므로 advisory로 다룬다. 통과 결론이나 없는 근거를 꾸미지 않는다. checks는 모든 focus를 포함하고 findings는 id,evidence,reason,action을 갖는다. repair는 실제 contractEvidence와 실행할 revision을 갖는다. 코드블록 없이 JSON만 출력한다.'
        : 'Repair the review response contract by rereading the same candidate and context. Return the complete review JSON. contractEvidence must be one contiguous verbatim passage in context; never stitch excerpts together. Model craft suggestions are advisory, not mandatory requirements. Do not invent evidence or a passing result. checks covers every focus; findings has id,evidence,reason,action; repair has actual contractEvidence and actionable revision. Output JSON only.',
      user: c => JSON.stringify(c),
    },
    'planning-escalation-review': {
      system: ko
        ? '상위 복귀·추가 조사 요청이 정말 필요한지 실제 후보와 상위 근거를 대조한다. 상위의 확정 사실을 보존하면서 하위 계획을 고칠 수 있으면 repair다. 확정 모순이 아니라 표현의 모호함·취향·더 풍부해질 기회라면 advisory다. 사건 A 뒤 B라는 순서만으로 같은 화·직후를 강제하지 않는다. 상위 사실 자체를 바꾸어야만 해결되는 실제 모순일 때만 upstream, 요청한 결과에 꼭 필요한 외부 근거가 없을 때만 research다. 모든 입력 finding id에 한 번씩 답한다. repair/upstream/research에는 context에 있는 연속된 contractEvidence와 candidate에 있는 연속된 candidateEvidence를 원문 그대로 인용한다. repair에는 revision을 넣는다. 원래 action을 자동으로 승인하지 않는다. JSON만: {"findings":[{"id":"입력 id","action":"repair|advisory|upstream|research","reason":"실제 비교 판단","contractEvidence":"상위 원문","candidateEvidence":"후보 원문","revision":"repair면 구체적 수정"}]}'
        : 'Audit whether escalation really requires upstream change or research. Compare the actual candidate and parent context. Use repair if lower-stage changes can preserve parent facts. Ambiguity, taste and enrichment are advisory. A then B does not imply the same episode or immediate succession. upstream requires a genuine conflict resolvable only by changing a parent fact; research requires external evidence necessary for the requested result. Answer each input finding id exactly once. repair/upstream/research requires contiguous verbatim contractEvidence from context and candidateEvidence from candidate. repair requires revision. Do not automatically endorse the original action. JSON only: {"findings":[{"id":"input id","action":"repair|advisory|upstream|research","reason":"grounded comparison","contractEvidence":"parent quote","candidateEvidence":"candidate quote","revision":"actionable repair"}]}',
      user: c => JSON.stringify(c),
    },
  };
}
