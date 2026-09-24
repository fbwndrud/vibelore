import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))];
const forbidden = /(^|\/)(?:\.env(?:\..*)?|manifest-private\.json)$|^(?:works|novels|art|webtoon|world|characters|chapters|summaries|experiments|\.vibelore|\.codex|\.claude|\.grok|_to_delete)\/|\.(?:pem|key|p12|pfx|bundle)$/;
for (const path of files) assert.ok(!forbidden.test(path) || path === '.env.example', `Private artifact tracked: ${path}`);
for (const path of ['LICENSE', 'NOTICE', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/release-review.json']) assert.ok(existsSync(path), `Missing ${path}`);
for (const path of ['package.json', 'engine/package.json']) {
  const pkg = JSON.parse(readFileSync(path));
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.engines.node, '^22.13.0 || ^24.0.0 || ^26.0.0');
  assert.equal(pkg.repository.url, 'https://github.com/fbwndrud/vibelore.git');
}
const manifest = JSON.parse(readFileSync('.codex-plugin/plugin.json'));
for (const url of [manifest.homepage, manifest.repository, manifest.interface.websiteURL]) assert.equal(url, 'https://github.com/fbwndrud/vibelore');
assert.match(readFileSync('README.md', 'utf8'), /git clone https:\/\/github.com\/fbwndrud\/vibelore\.git/);
console.log(`Source metadata and ${files.length} tracked/unignored paths checked. This is not license clearance.`);
