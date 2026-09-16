import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const documents = [
  'README.md', 'HOSTS.md', 'docs/README.md', 'docs/PHILOSOPHY.md', 'docs/GETTING_STARTED.md',
  'docs/MODELS.md', 'docs/MCP.md', 'docs/TOOLS.md', 'docs/ARCHITECTURE.md', 'docs/OPERATIONS.md',
];

test('documentation links and fenced blocks stay valid', async () => {
  for (const file of documents) {
    const source = await readFile(file, 'utf8');
    assert.equal([...source.matchAll(/^```/gm)].length % 2, 0, `${file} has an unclosed fenced block`);
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
      const target = match[1];
      if (/^[a-z]+:/i.test(target)) continue;
      await access(resolve(dirname(file), target));
    }
  }
});

test('tool reference names every public and advanced MCP tool', async () => {
  const server = await readFile('src/server.js', 'utf8');
  const reference = await readFile('docs/TOOLS.md', 'utf8');
  const names = [...server.matchAll(/name: '(lore_[a-z_]+)'/g)].map((match) => match[1]);
  assert.equal(names.length, 39);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(reference, new RegExp(`\\b${name}\\b`), `${name} is undocumented`);
});

test('Codex plugin manifest points to a portable local MCP entrypoint', async () => {
  const manifest = JSON.parse(await readFile('.codex-plugin/plugin.json', 'utf8'));
  const mcp = JSON.parse(await readFile(manifest.mcpServers, 'utf8'));
  const server = mcp.mcpServers.vibelore;
  assert.equal(manifest.name, 'vibelore-plugin');
  assert.equal(manifest.skills, './skills/');
  assert.equal(server.command, 'node');
  assert.equal(server.cwd, './');
  assert.equal(server.args.length, 1);
  assert.equal(server.args[0].startsWith('/'), false, 'plugin MCP entrypoint must not contain a local absolute path');
  await access(resolve(server.cwd, server.args[0]));
});
