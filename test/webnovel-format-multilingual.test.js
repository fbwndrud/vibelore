import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DIALOGUE_BREAK_MODES, WebnovelFormatError, normalizeWebnovelLayout, resolveWebnovelFormatPolicy, scanWebnovelFormat, separateBuriedDialogue } from '../src/tools/webnovel-format.js';
import { lexiconsForLanguage } from '../src/tools/lexicons.js';

describe('webnovel format multilingual policy', () => {
  it('does not block or rewrite English attribution when language is en', () => {
    const prose = '"I will go," she said.';
    const scanned = scanWebnovelFormat({ prose, chapterNumber: 1, language: 'en' });
    assert.equal(scanned.violations.some((item) => item.code === 'WEBNOVEL_DIALOGUE_NOT_ISOLATED'), false);
    const normalized = normalizeWebnovelLayout(prose, { language: 'en' });
    assert.equal(normalized, prose);
    assert.equal(separateBuriedDialogue(prose, { language: 'en' }), prose);
    assert.equal(scanned.coverage.dialogueIsolation.status, 'skipped');
    assert.equal(scanned.coverage.dialogueIsolation.skipReason, 'natural_dialogue_mode');
    assert.equal(scanned.stats.dialogueBreakMode, 'natural');
    assert.ok(DIALOGUE_BREAK_MODES.includes('natural'));
    assert.equal(resolveWebnovelFormatPolicy({ language: 'en' }).dialogueBreakMode, 'natural');
  });

  it('keeps scan and normalize on the same strict policy for non-KO', () => {
    const prose = '"I will go," she said.';
    const scanned = scanWebnovelFormat({ prose, chapterNumber: 1, language: 'en', dialogueBreakMode: 'strict' });
    assert.ok(scanned.violations.some((item) => item.code === 'WEBNOVEL_DIALOGUE_NOT_ISOLATED'));
    const separated = separateBuriedDialogue(prose, { language: 'en', dialogueBreakMode: 'strict' });
    assert.match(separated, /^"I will go,"\n\nshe said\.$/);
    assert.equal(normalizeWebnovelLayout(prose, { language: 'en', dialogueBreakMode: 'strict' }), separated);
  });

  it('preserves KO default isolation without language', () => {
    const mixed = '“너, 받침 짐 이리 줘.” 그녀가 짐꾼 하나를 불렀다.';
    const strict = scanWebnovelFormat({ prose: mixed, chapterNumber: 1 });
    assert.ok(strict.violations.some((item) => item.code === 'WEBNOVEL_DIALOGUE_NOT_ISOLATED'));
  });

  it('skips unsupported ES/AR dialogue parsers instead of claiming isolation pass', () => {
    const es = scanWebnovelFormat({ prose: '—Buenos días —dijo ella.', chapterNumber: 1, language: 'es' });
    assert.equal(es.coverage.dialogueIsolation.status, 'skipped');
    assert.equal(es.coverage.dialogueIsolation.skipReason, 'unsupported_quote_convention');
    assert.equal(es.violations.some((item) => String(item.code).startsWith('WEBNOVEL_DIALOGUE')), false);
    const ar = scanWebnovelFormat({ prose: 'قال: «سأذهب».', chapterNumber: 1, language: 'ar' });
    assert.equal(ar.coverage.dialogueIsolation.status, 'skipped');
    assert.equal(separateBuriedDialogue('—Hola —dijo.', { language: 'es' }).includes('\n\n'), false);
  });

  it('does not treat apostrophes as quotes', () => {
    const prose = '"Don\'t go," she said.';
    const scanned = scanWebnovelFormat({ prose, chapterNumber: 1, language: 'en' });
    assert.equal(scanned.violations.some((item) => item.code === 'WEBNOVEL_DIALOGUE_NOT_ISOLATED'), false);
    assert.equal(separateBuriedDialogue(prose, { language: 'en' }), prose);
  });

  it('fails clearly on empty, unknown, or contradictory dialogue modes', () => {
    assert.throws(() => scanWebnovelFormat({ prose: 'Hi.', chapterNumber: 1, language: 'en', dialogueBreakMode: '' }), WebnovelFormatError);
    assert.throws(() => scanWebnovelFormat({ prose: 'Hi.', chapterNumber: 1, language: 'en', dialogueBreakMode: 'inline' }), WebnovelFormatError);
    assert.throws(() => scanWebnovelFormat({
      prose: 'Hi.', chapterNumber: 1, language: 'en', dialogueBreakMode: 'strict',
      formatPolicy: { dialogueBreakMode: 'natural' },
    }), (error) => error.code === 'DIALOGUE_BREAK_MODE_CONFLICT');
    assert.throws(() => separateBuriedDialogue('Hi.', { language: 'en', dialogueBreakMode: 'bogus' }), WebnovelFormatError);
  });

  it('loads no fabricated English lexicons', () => {
    const en = lexiconsForLanguage('en');
    assert.equal(en.applicable, false);
    assert.equal(en.emotion, null);
    const ko = lexiconsForLanguage('ko');
    assert.equal(ko.applicable, true);
    assert.ok(ko.emotion.all().length > 0);
    const omitted = lexiconsForLanguage();
    assert.equal(omitted.applicable, true);
    assert.throws(() => lexiconsForLanguage(''), (error) => error.code === 'INVALID_LANGUAGE_TAG');
  });
});
