import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import test from 'node:test';

const documents = [
  'README.md', 'README.en.md', 'README.ja.md', 'README.es.md', 'README.fr.md', 'README.zh-Hant.md',
  'README.th.md', 'README.ar.md', 'HOSTS.md', 'HOSTS.en.md', 'docs/README.md', 'docs/PHILOSOPHY.md', 'docs/GETTING_STARTED.md',
  'docs/MODELS.md', 'docs/MCP.md', 'docs/TOOLS.md', 'docs/ARCHITECTURE.md', 'docs/OPERATIONS.md',
  'docs/WEBTOON.md', 'docs/TROUBLESHOOTING.md', 'docs/reference/WEBTOON_WORKFLOW.md',
  'AGENTS.md', 'hosts/codex/AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'skills/story-discovery-interview/SKILL.md', 'skills/webtoon-discovery-interview/SKILL.md',
  'skills/webtoon-discovery-interview/references/editorial-selection.md',
  'skills/webtoon-discovery-interview/references/codex-images.md', 'src/assets/fonts/README.md',
];

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => {
    const path = `${directory}/${entry.name}`;
    if (path === 'docs/showcase') return []; // GitHub Pages site, not part of the npm package
    if (path === 'docs/research' || path === 'docs/superpowers') return []; // internal records, not shipped
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
  }));
  return groups.flat();
}

function proseOnly(source) {
  return source.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, '');
}

function headingIds(source) {
  const ids = new Set();
  for (const match of proseOnly(source).matchAll(/^#{1,6} (.+)$/gm)) {
    const base = match[1].toLowerCase().replace(/[^\p{L}\p{M}\p{N}_ -]/gu, '').replace(/ /g, '-');
    let id = base;
    for (let suffix = 1; ids.has(id); suffix++) id = `${base}-${suffix}`;
    ids.add(id);
  }
  return ids;
}

test('documentation links, section anchors and fenced blocks stay valid', async () => {
  const files = new Set([...documents, ...await markdownFiles('docs')]);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.equal([...source.matchAll(/^```/gm)].length % 2, 0, `${file} has an unclosed fenced block`);
    for (const match of proseOnly(source).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^[a-z]+:/i.test(match[1])) continue;
      const [target, anchor] = match[1].split('#');
      const path = target ? resolve(dirname(file), target) : resolve(file);
      await access(path);
      if (anchor && path.endsWith('.md')) {
        const headings = headingIds(await readFile(path, 'utf8'));
        assert.ok(headings.has(decodeURIComponent(anchor)), `${file}: missing section ${match[1]}`);
      }
    }
  }
});

test('distributed Markdown links stay inside the packaged files', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const packed = path => pkg.files.some(entry => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
  for (const file of new Set([...documents, ...await markdownFiles('docs')])) {
    assert.ok(packed(file), `Document missing from package: ${file}`);
    for (const match of proseOnly(await readFile(file, 'utf8')).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^[a-z]+:/i.test(match[1])) continue;
      const target = match[1].split('#')[0];
      if (!target) continue;
      const path = relative(resolve('.'), resolve(dirname(file), target)).split(sep).join('/');
      assert.ok(packed(path), `${file}: linked file missing from package: ${path}`);
    }
  }
});

test('tool reference names every public and advanced MCP tool', async () => {
  const server = await readFile('src/server.js', 'utf8');
  const names = [...server.matchAll(/name: '(lore_[a-z_]+)'/g)].map((match) => match[1]);
  assert.equal(names.length, 43);
  assert.equal(new Set(names).size, names.length);
  for (const file of ['docs/TOOLS.md', 'docs/TOOLS.en.md']) {
    const reference = await readFile(file, 'utf8');
    for (const name of names) assert.match(reference, new RegExp(`\\b${name}\\b`), `${file}: ${name} is undocumented`);
  }
});

test('Codex plugin manifest points to a portable local MCP entrypoint', async () => {
  const manifest = JSON.parse(await readFile('.codex-plugin/plugin.json', 'utf8'));
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const engine = JSON.parse(await readFile('engine/package.json', 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(engine.version, pkg.version);
  assert.ok((await readFile('CHANGELOG.md', 'utf8')).includes(`## ${pkg.version} —`));
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

test('webtoon distribution includes linked skill docs and the unmodified licensed font', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  for (const entry of ['src/', 'skills/', 'AGENTS.md', 'docs/WEBTOON.md',
    'docs/TROUBLESHOOTING.md', 'docs/reference/WEBTOON_WORKFLOW.md', 'NOTICE',
    'CONTRIBUTING.md', 'CHANGELOG.md', 'docs/release-review.json', 'examples/work.gitignore']) {
    assert.ok(pkg.files.includes(entry), `Missing distribution entry: ${entry}`);
  }
  const font = await readFile('src/assets/fonts/GowunDodum-Regular.ttf');
  const hash = createHash('sha256').update(font).digest('hex');
  assert.equal(hash, 'a6e457933227483a11758fd0947bc74422a106d46f0bf057fdaa5af94a30067d');
  assert.ok((await readFile('src/assets/fonts/README.md', 'utf8')).includes(hash), 'stale font record');
  assert.match(await readFile('src/assets/fonts/OFL.txt', 'utf8'), /SIL OPEN FONT LICENSE Version 1.1/);
  assert.match(await readFile('NOTICE', 'utf8'), /SIL Open Font License/);
});
