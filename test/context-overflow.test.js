/**
 * src/tools/context.js:206 estimated the full writing context with the flat
 * pre-token-units `[...context].length / 2` heuristic, ignoring
 * `tokenUnits()` from src/core/token-units.js (already used by
 * writer-episode-packet.js and draft-input-compiler.js). That overcounts
 * sparse scripts like English by roughly 2x, so an English work could hit
 * `context_overflow` at content sizes a Korean work of equivalent semantic
 * weight would pass comfortably.
 *
 * These tests pin: (1) a large-but-legitimate English context no longer
 * false-positives, (2) Korean's estimate is unchanged (dense-script chars
 * still cost the original / 2 rate), and (3) the overflow message follows
 * the static ko/en rule instead of always being Korean.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runInit } from '../src/tools/init.js';
import { approvalFixtureProvider } from './fixtures/approval-response.js';
import { buildContext, MAX_CONTEXT_TOKENS } from '../src/tools/context.js';
import { tokenUnits } from '../src/core/token-units.js';

async function newStore(tag) {
  return new MarkdownStateStore(await mkdtemp(join(tmpdir(), `vibelore-context-overflow-${tag}-`)));
}

/** N statements of `len` Latin characters each, built from a repeating sentence. */
function latinFacts(count, len) {
  const sentence = 'The lighthouse keeper counts the planks before the repairman arrives and the tide keeps its own schedule regardless of the harbor council. ';
  const long = (sentence.repeat(Math.ceil(len / sentence.length))).slice(0, len);
  return Array.from({ length: count }, (_, i) => `${long} (${i})`);
}

/** N statements of `len` Hangul characters each. */
function hangulFacts(count, len) {
  const sentence = '등대지기는 수리공이 도착하기 전에 널빤지를 세었고 항구 위원회와 무관하게 밀물은 제 시간표를 지켰다. ';
  const long = (sentence.repeat(Math.ceil(len / sentence.length))).slice(0, len);
  return Array.from({ length: count }, (_, i) => `${long} (${i})`);
}

/**
 * A big cast of minimal characters, each carrying `len` characters of prose
 * in `contradiction` and in the speech `everyday` sample. Characters (unlike
 * world facts / hooks) are not part of the MemoryCompiler mandatory-recall
 * set, so this inflates `buildContext()`'s output size without tripping the
 * separate, smaller mandatory-recall budget in src/core/memory-compiler.js.
 */
function bigCast(count, len, longText) {
  return Array.from({ length: count }, (_, i) => ({
    id: `c${i}`, canonicalName: `Char${i}`, aliases: [], registeredAtChapter: 1,
    contradiction: longText(len, i),
    description: '',
    intrinsic: { role: 'supporting', coreAppearance: [] },
    dramaticModel: { valueOrder: [] },
    speechProfile: { defaultRegister: '', samples: { everyday: longText(len, i + 1000) } },
    mutable: { status: 'alive', knownFacts: [] }, relationships: [],
  }));
}

function latinText(len, seed = 0) {
  const sentence = 'The lighthouse keeper counts the planks before the repairman arrives and the tide keeps its own schedule regardless of the harbor council. ';
  return (sentence.repeat(Math.ceil(len / sentence.length))).slice(0, len) + ` (${seed})`;
}

function hangulText(len, seed = 0) {
  const sentence = '등대지기는 수리공이 도착하기 전에 널빤지를 세었고 항구 위원회와 무관하게 밀물은 제 시간표를 지켰다. ';
  return (sentence.repeat(Math.ceil(len / sentence.length))).slice(0, len) + ` (${seed})`;
}

describe('writing-context token budget is script-aware (src/tools/context.js)', () => {
  it('an English context of ~30k Latin characters (~7.5k units) does not overflow, though the old flat /2 estimate would have', async () => {
    const store = await newStore('en');
    await runInit({
      store, workId: 'w', genre: 'other', language: 'en', povMode: '3인칭제한',
      worldFacts: ['The tower taxes every reward.'],
      providers: approvalFixtureProvider(),
    });
    const foundation = await store.loadFoundation('w');
    await store.saveFoundation({ ...foundation, characters: bigCast(20, 1300, latinText) });

    const { context } = await buildContext({ store, workId: 'w', chapter: 1 });
    const totalChars = [...context].length;

    // Sanity: this content is large enough that the retired chars/2 estimate
    // would have exceeded the budget and thrown context_overflow.
    assert.ok(Math.ceil(totalChars / 2) > MAX_CONTEXT_TOKENS,
      `fixture too small to prove the regression: chars=${totalChars}`);

    const trace = await store.loadContextTrace('w', 1);
    assert.ok(trace, 'context trace should be saved once the budget check passes');
    assert.equal(trace.actualTokens, tokenUnits(context));
    assert.ok(trace.actualTokens <= MAX_CONTEXT_TOKENS,
      `expected the script-aware estimate (${trace.actualTokens}) to fit the ${MAX_CONTEXT_TOKENS} budget`);
    // Roughly the sparse-script rate (chars / 4), not the old chars / 2.
    assert.ok(trace.actualTokens < Math.ceil(totalChars / 2));
  });

  it('a Korean context near the budget keeps the same estimate as before (dense-script chars stay at / 2)', async () => {
    const store = await newStore('ko');
    await runInit({
      store, workId: 'w', genre: 'other', povMode: '3인칭제한',
      worldFacts: ['탑은 모든 보상에 세금을 매긴다.'],
      providers: approvalFixtureProvider(),
    });
    const foundation = await store.loadFoundation('w');
    await store.saveFoundation({ ...foundation, characters: bigCast(15, 900, hangulText) });

    const { context } = await buildContext({ store, workId: 'w', chapter: 1 });
    const trace = await store.loadContextTrace('w', 1);
    assert.ok(trace);
    assert.ok(trace.actualTokens <= MAX_CONTEXT_TOKENS, 'fixture should stay under budget');
    // Korean prose is dense-script, so tokenUnits() reproduces the legacy
    // chars/2 heuristic exactly (the fix must not shrink or inflate ko budgets).
    assert.equal(trace.actualTokens, Math.ceil([...context].length / 2));
    assert.equal(trace.actualTokens, tokenUnits(context));
  });

  it('the overflow message is English for an English work', async () => {
    const store = await newStore('en-overflow');
    await runInit({
      store, workId: 'w', genre: 'other', language: 'en', povMode: '3인칭제한',
      worldFacts: latinFacts(60, 1300), // ~78k chars =~ 19.5k units, over budget even with the fix
      providers: approvalFixtureProvider(),
    });

    await assert.rejects(
      buildContext({ store, workId: 'w', chapter: 1 }),
      (err) => {
        assert.match(err.message, /^context_overflow:/);
        assert.equal(/[가-힣]/.test(err.message), false, `expected no Hangul in an English error: ${err.message}`);
        assert.match(err.message, /[a-zA-Z]/);
        // Must not claim automation the product does not implement.
        assert.doesNotMatch(err.message, /automatically/i);
        return true;
      },
    );
  });

  it('the overflow message is Korean for a Korean work', async () => {
    const store = await newStore('ko-overflow');
    await runInit({
      store, workId: 'w', genre: 'other', povMode: '3인칭제한',
      worldFacts: hangulFacts(60, 1300), // ~78k Hangul chars =~ 39k units, over budget
      providers: approvalFixtureProvider(),
    });

    await assert.rejects(
      buildContext({ store, workId: 'w', chapter: 1 }),
      (err) => {
        assert.match(err.message, /^context_overflow:/);
        assert.match(err.message, /[가-힣]/);
        return true;
      },
    );
  });
});
