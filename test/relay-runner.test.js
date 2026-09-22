import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runRelayedTool } from '../src/relay-runner.js';
import { runWorkflowStatus } from '../src/tools/workflow.js';

async function fakeStore() {
  const rootDir = await mkdtemp(join(tmpdir(), 'vibelore-relay-runner-'));
  let workflow = null;
  return {
    rootDir,
    async loadWorkflow() { return workflow; },
    async saveWorkflow(_workId, next) { workflow = structuredClone(next); },
    setWorkflow(next) { workflow = structuredClone(next); },
    getWorkflow() { return workflow; },
  };
}

function providerWithPending(requests) {
  return () => ({ pending: requests });
}

describe('relay runner', () => {
  it('parks pending model work on disk and resumes with the same run id', async () => {
    const store = await fakeStore();
    const requests = [{ id: 'abc', step: 'draft', jsonMode: false, system: 's', user: 'u' }];

    const parked = await runRelayedTool({
      store, toolName: 'lore_rewrite', args: { workId: 'book', chapter: 1 },
      executeTool: async () => ({ preview: true }),
      providerForTool: providerWithPending(requests),
    });

    assert.equal(parked.status, 'needs_model');
    assert.match(parked.runId, /^run-[a-z0-9]+$/);
    assert.deepEqual(parked.requests, requests);

    const saved = JSON.parse(await readFile(join(store.rootDir, '.vibelore', 'runs', `${parked.runId}.json`), 'utf8'));
    assert.equal(saved.id, parked.runId);
    assert.equal(saved.tool, 'lore_rewrite');

    const resumed = await runRelayedTool({
      store, toolName: 'lore_rewrite', args: saved.args, answers: { abc: 'answer' }, run: saved,
      executeTool: async () => ({ done: true }),
      providerForTool: providerWithPending([]),
    });

    assert.deepEqual(resumed, { status: 'ok', done: true });
    await assert.rejects(() => readFile(join(store.rootDir, '.vibelore', 'runs', `${parked.runId}.json`), 'utf8'), /ENOENT/);
  });

  it('persists accumulated lore_write answers on unfinished workflows and clears them at terminal stages', async () => {
    const store = await fakeStore();
    store.setWorkflow({ workflowId: 'wf-1', workId: 'book', chapter: 1, stage: 'awaiting_model', relayAnswers: { old: 'yes' } });

    await runRelayedTool({
      store, toolName: 'lore_write', args: { workId: 'book' }, answers: { next: 'yes' },
      executeTool: async () => ({ preview: true }),
      providerForTool: (_tool, answers) => {
        assert.deepEqual(answers, { old: 'yes', next: 'yes' });
        return { pending: [{ id: 'more', step: 'draft', jsonMode: false, system: 's', user: 'u' }] };
      },
    });

    assert.deepEqual(store.getWorkflow().relayAnswers, { old: 'yes', next: 'yes' });
    assert.match(store.getWorkflow().pendingRunId, /^run-[a-z0-9]+$/);
    const status = await runWorkflowStatus({ store, workId: 'book' });
    assert.equal(status.resume.runId, store.getWorkflow().pendingRunId);
    store.setWorkflow({ ...store.getWorkflow(), stage: 'completed' });

    await runRelayedTool({
      store, toolName: 'lore_write', args: { workId: 'book' },
      executeTool: async () => ({ committed: 1 }),
      providerForTool: providerWithPending([]),
    });

    assert.equal(store.getWorkflow().relayAnswers, undefined);
    assert.equal(store.getWorkflow().pendingRunId, undefined);
  });

  it('recovers a pending run id for workflows created before explicit binding', async () => {
    const store = await fakeStore();
    store.setWorkflow({
      workflowId: 'wf-old', workId: 'book', chapter: 1, stage: 'awaiting_model',
      createdAt: new Date(Date.now() - 1000).toISOString(),
    });
    const parked = await runRelayedTool({
      store, toolName: 'lore_write', args: { workId: 'book' },
      executeTool: async () => ({ preview: true }),
      providerForTool: providerWithPending([{ id: 'repair', step: 'revise', system: 's', user: 'u' }]),
    });
    const legacyWorkflow = { ...store.getWorkflow() };
    delete legacyWorkflow.pendingRunId;
    store.setWorkflow(legacyWorkflow);

    const status = await runWorkflowStatus({ store, workId: 'book' });
    assert.equal(status.resume.runId, parked.runId);
    assert.equal(status.workflow.pendingRunId, parked.runId);
  });
});

describe('relay runner instruction', () => {
  it('tells the host that requests in one round trip are independent and may run in parallel', async () => {
    const store = await fakeStore();
    const parked = await runRelayedTool({
      store, toolName: 'lore_rewrite', args: { workId: 'book', chapter: 1 },
      executeTool: async () => ({ preview: true }),
      providerForTool: providerWithPending([{ id: 'a', step: 'coherence-judge', jsonMode: true, system: 's', user: 'u' }, { id: 'b', step: 'reader-hook', jsonMode: true, system: 's', user: 'u' }]),
    });
    assert.match(parked.instruction, /독립/);
    assert.match(parked.instruction, /병렬/);
  });
});
