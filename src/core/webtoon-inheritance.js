// Evidence is inherited; a visual preference still requires a user decision.
export function webtoonInheritance(source) {
  return {
    sourceHash: source.hash,
    worldFacts: source.foundation.worldFacts,
    characters: source.foundation.characters,
    narrative: source.storyProfile,
    documents: source.documents ?? [],
    sourceChapters: source.chapters.map(({ chapter, beforeState, afterState }) => ({ chapter, beforeState, afterState })),
    temporalCaution: source.stateNote,
    policy: '원작에서 확인한 사실은 다시 묻지 않고 보존한다. 원문에 없는 시각 선택만 확인하며 상속 사실을 웹툰 취향의 승인으로 처리하지 않는다.',
  };
}

export function inheritanceQuestions(questions, source) {
  const characterAreas = new Set(['W02', 'W05', 'W09', 'W14', 'E01', 'E03', 'E04', 'E06']);
  const worldAreas = new Set(['W02', 'W06', 'W08', 'W14', 'E02', 'E05', 'E07']);
  return questions.map((question) => ({ ...question,
    inherited: {
      ...(characterAreas.has(question.id) ? { characters: source.foundation.characters } : {}),
      ...(worldAreas.has(question.id) ? { worldFacts: source.foundation.worldFacts } : {}),
      narrative: source.storyProfile,
      documentIds: (source.documents ?? []).filter(({ path }) =>
        (characterAreas.has(question.id) && path.startsWith('characters/')) || (worldAreas.has(question.id) && path.startsWith('world/'))).map(({ id }) => id),
    },
    decisionBoundary: '위 상속 사실 자체는 재설계하지 않는다. 이 질문은 웹툰 표현의 미정 부분과 변경 허용 범위에 대한 선택이다. 원문에서 이미 답을 찾을 수 있는 세부 사실은 먼저 읽는다.',
  }));
}
