const ACTIONS = [
  '입구의 표시를 확인했다',
  '남은 절차를 기록했다',
  '닫힌 통로를 다시 살폈다',
  '동료에게 다음 순서를 알렸다',
];

const CONSEQUENCES = [
  '확인하지 않은 조건 하나가 남았다',
  '선택할 수 있는 길이 하나 줄었다',
  '앞선 판단의 비용이 분명해졌다',
  '다음 행동에 필요한 근거가 생겼다',
];

/** Length-sensitive tests use synthetic prose instead of a saved test novel. */
export const SYNTHETIC_LONG_PROSE = Array.from({ length: 64 }, (_, index) => {
  const action = ACTIONS[index % ACTIONS.length];
  const consequence = CONSEQUENCES[(index + 1) % CONSEQUENCES.length];
  return `윤재는 ${action}. 같은 동작을 되풀이하지 않고 ${index + 1}번째 기록을 비교하자 ${consequence}.`;
}).join('\n\n');
