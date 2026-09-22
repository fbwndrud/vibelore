import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { dropRun, loadRun, saveRun } from '../src/runs.js';

async function tempRoot() {
  return await mkdtemp(join(tmpdir(), 'vibelore-runs-'));
}

describe('suspended run storage', () => {
  it('stores large strings as sidecar payloads and hydrates them transparently', async () => {
    const root = await tempRoot();
    const prose = '문장과 장면의 압력. '.repeat(1200);
    const run = {
      id: 'run-abc123',
      tool: 'lore_commit',
      args: { workId: 'book', prose, note: 'small stays inline' },
      answers: { draft: prose },
      createdAt: new Date().toISOString(),
    };

    await saveRun(root, run);

    const raw = await readFile(join(root, '.vibelore', 'runs', 'run-abc123.json'), 'utf8');
    assert.match(raw, /\$vibeloreRunPayload/);
    assert.doesNotMatch(raw, /문장과 장면의 압력\. 문장과 장면의 압력\./);
    assert.match(raw, /small stays inline/);

    const payloads = await readdir(join(root, '.vibelore', 'runs', 'payloads'));
    assert.equal(payloads.length, 1);

    const loaded = await loadRun(root, 'run-abc123');
    assert.deepEqual(loaded, run);
  });

  it('removes sidecar payloads when a run is dropped', async () => {
    const root = await tempRoot();
    const prose = '긴 원고 '.repeat(3000);
    await saveRun(root, {
      id: 'run-def456',
      tool: 'lore_rewrite',
      args: { prose },
      createdAt: new Date().toISOString(),
    });

    await dropRun(root, 'run-def456');

    await assert.rejects(
      () => readFile(join(root, '.vibelore', 'runs', 'run-def456.json'), 'utf8'),
      /ENOENT/,
    );
    assert.deepEqual(await readdir(join(root, '.vibelore', 'runs', 'payloads')), []);
  });

  it('refuses to hydrate a corrupted sidecar payload', async () => {
    const root = await tempRoot();
    const prose = '오염되면 안 되는 원고 '.repeat(1500);
    await saveRun(root, {
      id: 'run-ghi789',
      tool: 'lore_check',
      args: { prose },
      createdAt: new Date().toISOString(),
    });

    const [payload] = await readdir(join(root, '.vibelore', 'runs', 'payloads'));
    await writeFile(join(root, '.vibelore', 'runs', 'payloads', payload), 'corrupted', 'utf8');

    await assert.rejects(
      () => loadRun(root, 'run-ghi789'),
      /run payload checksum mismatch/,
    );
  });
});
