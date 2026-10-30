import { describe, expect, it, vi } from '../_support/vitest-shim.mjs';
import { runCoherenceJudge } from '../../src/generators/text/steps/coherence-judge.js';
const writerModel = { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' };
const SAMPLE = '주인공이 동굴 입구에서 멈췄다. 어둠 너머 빛이 보였다.';
describe('runCoherenceJudge', () => {
    it('valid response → score + reason', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: JSON.stringify({ score: 85, reason: '본문이 plan 의도 잘 따름.' }),
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        const r = await runCoherenceJudge({
            prose: SAMPLE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.score).toBe(85);
        expect(r.reason).toMatch(/plan/);
        const req = providers.complete.mock.calls[0][0];
        expect(req.step).toBe('coherence-judge');
        expect(req.jsonMode).toBe(true);
    });
    it('LLM throw → score null', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => {
                throw new Error('rate');
            }),
        };
        const r = await runCoherenceJudge({
            prose: SAMPLE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.score).toBeNull();
        expect(r.reason).toBeNull();
    });
    it('malformed JSON → score null', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({ text: '{bogus', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } })),
        };
        const r = await runCoherenceJudge({
            prose: SAMPLE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.score).toBeNull();
    });
    it('out-of-range score → null', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: JSON.stringify({ score: 150, reason: 'x' }),
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        const r = await runCoherenceJudge({
            prose: SAMPLE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.score).toBeNull();
    });
    it('judgeModel override is used when supplied', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: JSON.stringify({ score: 50, reason: null }),
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        await runCoherenceJudge({
            prose: SAMPLE,
            chapterNumber: 5,
            writerModel,
            judgeModel: { provider: 'anthropic', modelId: 'haiku-4-5' },
            providers,
        });
        const req = providers.complete.mock.calls[0][0];
        expect(req.model.modelId).toBe('haiku-4-5');
    });
    it('rounds float score to integer', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: JSON.stringify({ score: 72.7, reason: 'x' }),
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        const r = await runCoherenceJudge({
            prose: SAMPLE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.score).toBe(73);
    });
    it('asks about author rules and returns their verdicts', async () => {
        let seen = '';
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: async (req) => {
                seen = req.messages.at(-1).content;
                return { text: JSON.stringify({ score: 80, reason: 'ok', authorRules: [{ rule: '리아는 어머니 이야기를 먼저 꺼내지 않는다', verdict: 'fail', evidence: '"엄마가…"' }] }) };
            },
        };
        const out = await runCoherenceJudge({
            prose: '본문', chapterNumber: 3, plan: '', prevSummary: '', writerModel: {}, providers,
            authorRules: ['리아는 어머니 이야기를 먼저 꺼내지 않는다'],
        });
        expect(seen).toContain('리아는 어머니 이야기를 먼저 꺼내지 않는다');
        expect(out.authorRules[0].verdict).toBe('fail');
    });
    it('no author rules given → no authorRules key', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({ text: JSON.stringify({ score: 80, reason: 'ok' }) })),
        };
        const out = await runCoherenceJudge({ prose: SAMPLE, chapterNumber: 3, writerModel, providers });
        expect(out.authorRules).toBeUndefined();
    });
    it('malformed authorRules entry is dropped, not the whole review', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: JSON.stringify({ score: 80, reason: 'ok', authorRules: [
                    { rule: '유효', verdict: 'warn', evidence: 'x' },
                    { rule: '검증 불가', verdict: 'maybe' },
                    { verdict: 'pass' },
                ] }),
            })),
        };
        const out = await runCoherenceJudge({
            prose: SAMPLE, chapterNumber: 3, writerModel, providers, authorRules: ['유효'],
        });
        expect(out.score).toBe(80);
        expect(out.authorRules).toHaveLength(1);
        expect(out.authorRules[0]).toEqual({ id: 'r1', rule: '유효', verdict: 'warn', evidence: 'x' });
    });
    it('asks for the whole JSON with a verdict per rule id, and flags a response without authorRules', async () => {
        let seen = '';
        const reply = (body) => ({ register: vi.fn(), has: vi.fn(), complete: async (req) => { seen = req.messages.at(-1).content; return { text: JSON.stringify(body) }; } });
        const rules = [{ id: 'u1', text: '리아는 어머니 이야기를 먼저 꺼내지 않는다' }, { id: 'u3', text: '금화는 줄기만 한다' }];
        const answered = await runCoherenceJudge({ prose: SAMPLE, chapterNumber: 3, writerModel, authorRules: rules,
            providers: reply({ score: 80, reason: 'ok', authorRules: [{ id: 'u3', verdict: 'warn', evidence: '금화가 늘었다' }, { id: 'u9', verdict: 'fail', evidence: 'x' }] }) });
        expect(seen).toContain('- u1: 리아는 어머니 이야기를 먼저 꺼내지 않는다');
        expect(seen).toContain('"authorRules": [{ "id":');
        expect(seen).toContain('"score": <0-100>');
        expect(answered.authorRules).toEqual([{ id: 'u3', rule: '금화는 줄기만 한다', verdict: 'warn', evidence: '금화가 늘었다' }]);
        expect(answered.authorRulesMissing).toBeUndefined();
        const missing = await runCoherenceJudge({ prose: SAMPLE, chapterNumber: 3, writerModel, authorRules: rules, providers: reply({ score: 80, reason: 'ok' }) });
        expect(missing.authorRules).toEqual([]);
        expect(missing.authorRulesMissing).toBe(true);
    });
    const prefs = [{ id: 'dec-1', level: 'work', ref: 'w', statement: '서술은 건조하게 쓴다.' },
        { id: 'dec-2', level: 'subject', ref: 'hero', statement: '윤재는 반말을 쓴다.' }];
    // With the canonical name the judge can find the character in the prose.
    const named = [prefs[0], { ...prefs[1], name: '윤재' }];
    const capture = (body) => { const box = { seen: '' }; box.providers = { register: vi.fn(), has: vi.fn(),
        complete: async (req) => { box.seen = req.messages.at(-1).content; return { text: JSON.stringify(body) }; } }; return box; };
    it('asks about each adopted preference and returns its verdict', async () => {
        const box = capture({ score: 80, reason: 'ok', creativePreferences: [
            { id: 'dec-2', verdict: 'warn', evidence: '"그러십시오"' }, { id: 'dec-9', verdict: 'fail' }, { id: 'dec-1', verdict: 'maybe' }] });
        const out = await runCoherenceJudge({ prose: SAMPLE, chapterNumber: 3, writerModel, providers: box.providers, creativePreferences: prefs });
        expect(box.seen).toContain('## 사용자가 채택한 창작 선호');
        expect(box.seen).toContain('- dec-1 (작품 전체): 서술은 건조하게 쓴다.\n- dec-2 (인물 hero): 윤재는 반말을 쓴다.');
        expect(box.seen).toContain('"creativePreferences": [{ "id": "선호 id"');
        expect(box.seen).not.toContain('"authorRules"');
        expect(out.creativePreferences).toEqual([{ id: 'dec-2', statement: '윤재는 반말을 쓴다.', verdict: 'warn', evidence: '"그러십시오"' }]);
        expect(out.creativePreferencesMissing).toBeUndefined();
        expect(out.authorRules).toBeUndefined();
        expect(box.seen).toContain('점수는 논리 연결만 평가하며 선호 판정은 점수에 반영하지 않는다.');
    });
    it('names the character next to a subject id when the caller gives it', async () => {
        const box = capture({ score: 80, reason: 'ok', creativePreferences: [] });
        await runCoherenceJudge({ prose: SAMPLE, chapterNumber: 3, writerModel, providers: box.providers, creativePreferences: named });
        expect(box.seen).toContain('- dec-2 (인물 hero(윤재)): 윤재는 반말을 쓴다.');
    });
    it('asks for rules and preferences together, and flags an answer without preference verdicts', async () => {
        const box = capture({ score: 80, reason: 'ok', authorRules: [] });
        const out = await runCoherenceJudge({ prose: SAMPLE, chapterNumber: 3, writerModel, providers: box.providers,
            authorRules: [{ id: 'u1', text: '금화는 줄기만 한다' }], creativePreferences: prefs });
        expect(box.seen.indexOf('## 작가 점검 규칙')).toBeLessThan(box.seen.indexOf('## 사용자가 채택한 창작 선호'));
        expect(box.seen).toContain('"authorRules": [{ "id": "규칙 id"');
        expect(box.seen).toContain('"creativePreferences": [{ "id": "선호 id"');
        expect(out.creativePreferences).toEqual([]);
        expect(out.creativePreferencesMissing).toBe(true);
    });
    it('without preferences the prompt is the one used before them, with or without author rules', async () => {
        for (const authorRules of [undefined, [{ id: 'u1', text: '금화는 줄기만 한다' }]]) {
            const plain = capture({ score: 80, reason: 'ok' });
            const empty = capture({ score: 80, reason: 'ok' });
            await runCoherenceJudge({ prose: SAMPLE, chapterNumber: 3, writerModel, providers: plain.providers, authorRules });
            const out = await runCoherenceJudge({ prose: SAMPLE, chapterNumber: 3, writerModel, providers: empty.providers, authorRules, creativePreferences: [] });
            expect(empty.seen).toBe(plain.seen);
            expect(out.creativePreferences).toBeUndefined();
        }
    });
    it('uses the multilingual labels for a non-Korean work', async () => {
        const box = capture({ score: 80, reason: 'ok', creativePreferences: [] });
        await runCoherenceJudge({ prose: 'He stopped.', chapterNumber: 3, writerModel, providers: box.providers, language: 'en', creativePreferences: prefs });
        expect(box.seen).toContain('## Creative preferences the user adopted');
        expect(box.seen).toContain('- dec-2 (character hero): 윤재는 반말을 쓴다.');
        expect(box.seen).toContain('The score judges coherence only; preference verdicts do not change it.');
    });
});
