// Complete invented planning data for workflow transport tests, not model output.
export function planningResponse(request) {
  if (request.step === 'story-identity') return { text: JSON.stringify({ readerPromise: '주인공이 규칙의 대가를 행동으로 확인한다.', protagonistAppeal: '규칙을 세밀하게 읽는 사람', emotionalDefect: '도움을 빚으로 오해한다.', competenceSignature: ['낡은 장부를 대조한다.'], comedyEngines: ['절박한 사람과 느린 절차'], solutionPatternsToRotate: ['협상', '협력'] }) };
  if (request.step === 'pilot-contract') return { text: JSON.stringify({ beforeState: '규칙만 알면 안전하다고 믿는다.', firstFailure: '숨은 수수료를 놓친다.', protagonistSpecificAction: '장부를 직접 대조한다.', irreversibleChoice: '자기 몫을 담보로 내놓는다.', competenceProof: '어긋난 기록을 찾는다.', humanHook: '혼자 해결할 수 있는가?', seriesPromise: '선택에 따른 대가를 확인한다.', closingQuestion: '다음 비용은 누가 치르는가?' }) };
  return null;
}
