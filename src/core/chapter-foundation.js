import { gateFoundation } from './canon-gates.js';

/** 화 계획이 기반에 덧붙이는 것을 합치는 자리. 지금은 항등이며 계획 내용을 쓰지 않는다. */
export const overlay = (foundation, _plan) => foundation;

/** 한 화를 위한 기반: 정본 기반을 그 화 시점으로 자른 뒤 화 계획을 덧씌운다. 모든 소비자가 이 함수를 지난다. */
export function chapterFoundation({ raw, chapter, plan = null }) {
  return overlay(gateFoundation(raw, chapter), plan);
}
