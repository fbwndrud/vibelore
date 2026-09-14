import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withProjectLock } from '../src/core/project-lock.js';

test('two server operations cannot interleave their writes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vibelore-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release;
  let started;
  const inside = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const order = [];
  const first = withProjectLock(root, async () => { order.push('first start'); started(); await blocked; order.push('first end'); });
  await inside;
  await assert.rejects(withProjectLock(root, async () => { order.push('unexpected'); }, { waitMs: 0 }), /PROJECT_BUSY/);
  release(); await first;
  await withProjectLock(root, async () => order.push('second'));
  assert.deepEqual(order, ['first start', 'first end', 'second']);
});
