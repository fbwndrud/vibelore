import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// A child deadline catches event-loop stalls; a test timeout cannot interrupt
// a synchronous regular expression. Linear scanning needs far less than 5 s.
const cases = [
    ['sanitize', 'core/output-sanitizer.js', "new m.DefaultOutputSanitizer().sanitize('⟦vle:a ' + ' '.repeat(200000))"],
    ['extractAllBlocks', 'core/output-sanitizer.js', "new m.DefaultOutputSanitizer().extractAllBlocks('⟦vle:a ' + ' '.repeat(200000))"],
    ['extractBlock', 'core/output-sanitizer.js', "new m.DefaultOutputSanitizer().extractBlock('⟦vle:a ' + ' '.repeat(200000), 'a')"],
    ['machine annotations', 'core/output-sanitizer.js', "new m.DefaultOutputSanitizer().sanitize('[' + 'field-'.repeat(100000) + 'value]')"],
    ['contradiction', 'continuity/character.js', "m.checkContradictionStrength('가'.repeat(200000))"],
    ['noun and verb scanning', 'continuity/prosody-scan.js', "m.runProsodyScan('힣'.repeat(200000)); m.runProsodyScan('가'.repeat(200000))"],
    ['sentence ending', 'continuity/prosody-scan.js', "m.runProsodyScan('첫' + '\\t'.repeat(200000) + '끝')"],
];
for (const [name, file, call] of cases) {
    test(`${name} completes on long adversarial input`, () => {
        const url = new URL(`../../src/${file}`, import.meta.url).href;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e',
            `import * as m from ${JSON.stringify(url)}; ${call};`], { timeout: 5000, encoding: 'utf8' });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
    });
}
