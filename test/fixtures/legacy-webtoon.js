import { runWebtoonTool } from '../../src/tools/webtoon.js';
import { WebtoonStore } from '../../src/store/webtoon-store.js';

// Existing image/lettering tests exercise saved workflows predating the mandatory
// storyboard policy. Only test fixtures are downgraded; production has no opt-out.
// New-policy creation and end-to-end approval are tested in webtoon-storyboard.
export async function runLegacyWebtoonTool(input) {
  const result = await runWebtoonTool(input);
  if (input.toolName === 'lore_webtoon_plan' && result.workflowId) {
    const repo = new WebtoonStore(input.store), w = await repo.load(result.workflowId);
    if (w.storyboardPolicyVersion === 2) {
      delete w.storyboardPolicyVersion;
      await repo.save(w);
      result.storyboardPolicyVersion = null;
    }
  }
  return result;
}
