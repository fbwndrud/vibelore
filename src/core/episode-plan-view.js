/**
 * Reviewer-facing view of an EpisodePlan.
 *
 * Reviews receive the plan as JSON. The stored plan also carries publication
 * bookkeeping and scene field aliases (`objective`/`situation` and friends hold
 * the same text). Dropping exact duplicates and bookkeeping keeps every
 * creative fact while shrinking each review prompt.
 */
const BOOKKEEPING_KEYS = new Set([
  'workId', 'episodePlanSchemaVersion', 'contractVersion', 'planningContractVersion',
  'migratedFromPlanningContractVersion', 'status', 'revision', 'createdAt', 'approvedAt', 'rejectedAt', 'completedAt',
]);
const SCENE_ALIASES = [['objective', 'situation'], ['obstacle', 'choice'], ['turn', 'change'], ['outcome', 'change']];

export function episodePlanReviewView(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return plan ?? {};
  const view = Object.fromEntries(Object.entries(plan).filter(([key]) => !BOOKKEEPING_KEYS.has(key)));
  if (Array.isArray(view.scenes)) {
    view.scenes = view.scenes.map((scene) => {
      if (!scene || typeof scene !== 'object') return scene;
      const out = { ...scene };
      for (const [alias, base] of SCENE_ALIASES) {
        if (out[alias] !== undefined && out[alias] === out[base]) delete out[alias];
      }
      return out;
    });
  }
  return view;
}
