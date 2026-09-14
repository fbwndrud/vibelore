import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = /(^|\/)(?:\.env(?:\..*)?|manifest-private\.json)$|^(?:works|world|characters|chapters|summaries|experiments|\.vibelore|\.codex|\.claude|\.grok|_to_delete)\/|\.(?:pem|key|p12|pfx|bundle)$/;
for (const path of files) assert.ok(!forbidden.test(path) || path === '.env.example', `Private artifact tracked: ${path}`);
const legacyReference = /inkos|polisher|settler|raiden|레이든|work-third-house|reader-api|vibelore-reader|clean.room/i;
for (const path of files.filter((path) => /^(?:src|engine|test)\//.test(path))) {
  assert.ok(!legacyReference.test(path), `Historical reference in product path: ${path}`);
  if (/\.(?:js|mjs|json)$/.test(path)) assert.ok(!legacyReference.test(readFileSync(path, 'utf8')), `Historical reference in product content: ${path}`);
}
for (const path of ['LICENSE', 'NOTICE', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/PROVENANCE.md', 'docs/release-review.json']) assert.ok(existsSync(path), `Missing ${path}`);
for (const path of ['package.json', 'engine/package.json']) {
  const pkg = JSON.parse(readFileSync(path));
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.engines.node, '^22.13.0 || ^24.0.0');
  assert.equal(pkg.repository.url, 'https://github.com/fbwndrud/vibelore.git');
}
const manifest = JSON.parse(readFileSync('.codex-plugin/plugin.json'));
for (const url of [manifest.homepage, manifest.repository, manifest.interface.websiteURL]) assert.equal(url, 'https://github.com/fbwndrud/vibelore');
assert.match(readFileSync('README.md', 'utf8'), /git clone https:\/\/github.com\/fbwndrud\/vibelore\.git/);
console.log(`Source metadata and ${files.length} tracked paths checked. This is not license clearance.`);
