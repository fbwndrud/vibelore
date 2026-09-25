// P4b (#516, Epic #511) — entity mention scan (NovelAI Lorebook activation-key).
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { scanEntityMentions } from '../../src/core/mention-scan.js';
function entity(overrides = {}) {
    return {
        entityId: 'e1',
        kind: 'item',
        canonicalName: '잿불 단검',
        aliases: [],
        status: 'active',
        attrs: {},
        ...overrides,
    };
}
describe('scanEntityMentions', () => {
    it('canonicalName 멘션 감지 (조사 붙은 한국어 substring)', () => {
        const r = scanEntityMentions({
            text: '카엘은 잿불 단검을 뽑아 들었다.',
            snapshots: [entity()],
        });
        expect(r.mentionedIds).toEqual(['e1']);
        expect(r.matchedTerms.e1).toBe('잿불 단검');
    });
    it('alias 멘션 감지', () => {
        const r = scanEntityMentions({
            text: '사람들은 그 칼을 재의 송곳니라 불렀다.',
            snapshots: [entity({ aliases: ['재의 송곳니'] })],
        });
        expect(r.mentionedIds).toEqual(['e1']);
        expect(r.matchedTerms.e1).toBe('재의 송곳니');
    });
    it('멘션 없는 entity 는 미활성', () => {
        const r = scanEntityMentions({
            text: '비가 내리는 골목이었다.',
            snapshots: [entity()],
        });
        expect(r.mentionedIds).toEqual([]);
    });
    it('retired/destroyed entity 는 멘션돼도 제외', () => {
        const r = scanEntityMentions({
            text: '잿불 단검은 이미 부러졌다.',
            snapshots: [entity({ status: 'destroyed' })],
        });
        expect(r.mentionedIds).toEqual([]);
    });
    it('1글자 term 은 과매치 방지로 skip (minTermLength 기본 2)', () => {
        const r = scanEntityMentions({
            text: '그는 강을 건넜다.',
            snapshots: [entity({ canonicalName: '강' })],
        });
        expect(r.mentionedIds).toEqual([]);
    });
    it('영문 이름은 대소문자 무시', () => {
        const r = scanEntityMentions({
            text: 'EXCALIBUR 가 빛났다.',
            snapshots: [entity({ canonicalName: 'Excalibur' })],
        });
        expect(r.mentionedIds).toEqual(['e1']);
    });
    it('does not match Ann inside Ann with combining mark', () => {
        const snapshots = [entity({ entityId: 'ann', canonicalName: 'Ann' })];
        expect(scanEntityMentions({ text: 'Ann\u0301a walked.', snapshots }).mentionedIds).toEqual([]);
        expect(scanEntityMentions({ text: 'Ann walked.', snapshots }).mentionedIds).toEqual(['ann']);
    });
    it('NFD Hangul jamo name still matches particle attachment', () => {
        const nfd = '카엘'.normalize('NFD');
        expect(scanEntityMentions({
            text: `${nfd}은 문을 열었다.`,
            snapshots: [entity({ entityId: 'kael', canonicalName: nfd })],
        }).mentionedIds).toEqual(['kael']);
        expect(scanEntityMentions({
            text: '카엘은 문을 열었다.',
            snapshots: [entity({ entityId: 'kael', canonicalName: '카엘' })],
        }).mentionedIds).toEqual(['kael']);
    });
    it('mixed Hangul/Latin aliases stay case-insensitive substring', () => {
        expect(scanEntityMentions({
            text: 'kael카엘은 달렸다.',
            snapshots: [entity({ entityId: 'kael', canonicalName: 'Kael카엘' })],
        }).mentionedIds).toEqual(['kael']);
    });
    it('Latin short name does not match banner/anniversary substrings', () => {
        const snapshots = [entity({ entityId: 'ann', canonicalName: 'Ann' })];
        expect(scanEntityMentions({ text: 'The banner fell.', snapshots }).mentionedIds).toEqual([]);
        expect(scanEntityMentions({ text: 'The anniversary banquet fell silent.', snapshots }).mentionedIds).toEqual([]);
        expect(scanEntityMentions({ text: 'Ann walked in.', snapshots }).mentionedIds).toEqual(['ann']);
        expect(scanEntityMentions({ text: 'Ann, hello.', snapshots }).mentionedIds).toEqual(['ann']);
    });
    it('CJK short names stay substring with 1-character skip (observed, not NER)', () => {
        expect(scanEntityMentions({
            text: '田は走った。',
            snapshots: [entity({ entityId: 'ta', canonicalName: '田' })],
        }).mentionedIds).toEqual([]);
        expect(scanEntityMentions({
            text: '太郎は走った。',
            snapshots: [entity({ entityId: 'taro', canonicalName: '太郎' })],
        }).mentionedIds).toEqual(['taro']);
        const overlap = scanEntityMentions({
            text: '山田太郎が来た。',
            snapshots: [
                entity({ entityId: 'yamada', canonicalName: '山田' }),
                entity({ entityId: 'taro', canonicalName: '太郎' }),
            ],
        });
        expect(overlap.mentionedIds).toEqual(['yamada', 'taro']);
    });
    it('여러 entity 가 멘션되면 snapshot 순서 유지', () => {
        const r = scanEntityMentions({
            text: '성소의 제단 위에 잿불 단검이 놓여 있었다.',
            snapshots: [
                entity({ entityId: 'e2', kind: 'location', canonicalName: '성소' }),
                entity(),
            ],
        });
        expect(r.mentionedIds).toEqual(['e2', 'e1']);
    });
    it('빈 텍스트/빈 snapshot → 빈 결과', () => {
        expect(scanEntityMentions({ text: '', snapshots: [entity()] }).mentionedIds).toEqual([]);
        expect(scanEntityMentions({ text: '본문', snapshots: [] }).mentionedIds).toEqual([]);
    });
});
