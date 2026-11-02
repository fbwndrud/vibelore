import { gateFoundation } from './canon-gates.js';

/** Slot for what a chapter plan adds on top of the foundation. Identity for now; the plan is not read. */
export const overlay = (foundation, _plan) => foundation;

/** Foundation for one chapter: gate the canon foundation at that chapter, then overlay the chapter plan. Every consumer goes through this. */
export function chapterFoundation({ raw, chapter, plan = null }) {
  return overlay(gateFoundation(raw, chapter), plan);
}
