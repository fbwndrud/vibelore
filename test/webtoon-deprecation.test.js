import test from 'node:test';
import assert from 'node:assert/strict';
import { runWebtoonTool } from '../src/tools/webtoon.js';
import { webtoonStore, workId, provider } from './fixtures/webtoon.js';

test('new panel workflows are deprecated at the MCP entry; existing ones keep working', async () => {
  const store = await webtoonStore();
  await assert.rejects(runWebtoonTool({ store, toolName: 'lore_webtoon_plan', args: { workId, imageModel: 'gpt-image-2' }, providers: provider(), blockNewPanelWorkflows: true }),
    /WEBTOON_PANEL_PATH_DEPRECATED.*lore_webtoon_scene/);
  const started = await runWebtoonTool({ store, toolName: 'lore_webtoon_plan', args: { workId, imageModel: 'gpt-image-2' }, providers: provider() });
  assert.equal(started.status, 'needs_interview');
  const resumed = await runWebtoonTool({ store, toolName: 'lore_webtoon_plan', args: { workId, workflowId: started.workflowId }, providers: provider(), blockNewPanelWorkflows: true });
  assert.equal(resumed.workflowId, started.workflowId);
});

test('an unknown workflowId is not treated as a new start; not-found wins over the deprecation error', async () => {
  const store = await webtoonStore();
  await assert.rejects(runWebtoonTool({ store, toolName: 'lore_webtoon_plan', args: { workId, workflowId: 'wt-does-not-exist' }, providers: provider(), blockNewPanelWorkflows: true }),
    /WEBTOON_WORKFLOW_NOT_FOUND/);
});
