/**
 * draft — scene form system prompt.
 *
 * `form: 'scene'` swaps the chapter header, arc/legacy rules and the arc-pressure
 * voice line for scene rules. Every chapter prompt must stay byte-identical, which
 * the pinned SHA-256 values below prove.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { promptFamilyCaptureContext } from '../../src/core/prompt-language.js';
import { runDraft, draftSystemStatic, __buildDraftSystemForTest as buildDraftSystem, } from '../../src/generators/text/steps/draft.js';

const registry = createGenreProfileRegistry();
const sha = (text) => createHash('sha256').update(text).digest('hex');
function arc(position) {
    return {
        arcId: 'a1',
        arcNumber: 1,
        title: 'Main',
        summary: '',
        promise: 'X',
        type: 'standard',
        estimatedEpisodes: 20,
        currentPosition: position,
        currentChapterInArc: 1,
    };
}
function makeFoundation(language) {
    return {
        workId: 'work-scene',
        genre: 'action',
        ...(language ? { language } : {}),
        worldFacts: [],
        characters: [],
        intrinsicChanges: [],
        genreProfile: registry.get('action'),
    };
}
async function capture(extra = {}) {
    const requests = [];
    const provider = {
        async complete(req) {
            requests.push(req);
            return { text: 'prose\n\n⟦vle:cast-manifest {"cast":[]}⟧', model: req.model };
        },
    };
    await runDraft({
        foundation: makeFoundation(extra.language),
        prevState: { ...emptyStoryState('work-scene'), chapterNumber: 1 },
        chapterNumber: 2,
        plan: 'PLAN_TOKEN',
        providers: provider,
        model: { provider: 'openai', modelId: 'gpt-4o-mini' },
        ...extra,
    });
    return requests[0].messages.find((m) => m.role === 'system').content;
}

describe('draft scene form — chapter prompt bytes are unchanged', () => {
    const BASELINES = {
        ko: 'c96015923bdefba39fa73ba2ad18da5691a07f0780c3c260c4318873ac0fddbe',
        multilingual: '5ef067dfeb34ca34dc99edd77408ea2c396fc293ad8c1050c5f0c7e860adbcc4',
        opening: '74aea8fa00fa17b1c15b018ebaf5359f98c1231c1973dee049071cd2705f5502',
        closing: '6bb6d066f0a8b1d59e4ed893c332642f96a59d423e7a17e361e21f158bc5fcee',
        relaxed: 'a715e71d461fbf809072993b47183a0ba50148fdf594c1eaded6387d9878c313',
    };
    it('buildDraftSystem() and draftSystemStatic(ko)', () => {
        expect(sha(buildDraftSystem())).toBe(BASELINES.ko);
        expect(sha(buildDraftSystem(undefined, undefined, undefined, { form: 'chapter' }))).toBe(BASELINES.ko);
        expect(sha(draftSystemStatic('ko'))).toBe(BASELINES.ko);
    });
    it('draftSystemStatic(multilingual)', () => {
        expect(sha(draftSystemStatic('multilingual'))).toBe(BASELINES.multilingual);
    });
    it('arc opening and closing', () => {
        expect(sha(buildDraftSystem(arc('opening')))).toBe(BASELINES.opening);
        expect(sha(buildDraftSystem(arc('opening'), undefined, undefined, { form: 'chapter' }))).toBe(BASELINES.opening);
        expect(sha(buildDraftSystem(arc('closing')))).toBe(BASELINES.closing);
        expect(sha(buildDraftSystem(arc('closing'), undefined, undefined, { form: 'chapter' }))).toBe(BASELINES.closing);
    });
    it('dialogueBreakMode relaxed', () => {
        expect(sha(buildDraftSystem(undefined, undefined, undefined, { dialogueBreakMode: 'relaxed' }))).toBe(BASELINES.relaxed);
        expect(sha(buildDraftSystem(undefined, undefined, undefined, { dialogueBreakMode: 'relaxed', form: 'chapter' }))).toBe(BASELINES.relaxed);
    });
});

describe('draft scene form — system prompt', () => {
    it('ko scene', () => {
        const sys = buildDraftSystem(undefined, undefined, undefined, { form: 'scene' });
        expect(sys).toContain('짧은 장면 하나');
        expect(sys).toContain('요청에 없는 사건·갈등·반전·대가·다음 화 훅을 덧붙이지 않는다');
        expect(sys).toContain('관계와 감정은 행동과 대사로 드러내고');
        expect(sys).not.toContain('한 회차에 갈등 1개');
        expect(sys).not.toContain('다음 회차를 작성한다');
        expect(sys).not.toContain('아크 압력');
        // the other voice lines and the manifest rules stay
        expect(sys).toContain('인물 음성 규칙:');
        expect(sys).toContain('분 단위 시각');
        expect(sys).toContain('cast-manifest');
    });
    it('multilingual scene', () => {
        const sys = buildDraftSystem(null, undefined, promptFamilyCaptureContext('multilingual'), { form: 'scene' });
        expect(sys).toContain('one short scene');
        expect(sys).toContain('Do not add events, conflict, reversals, costs or a next-chapter hook');
        expect(sys).not.toContain('One conflict, one step of progress');
        expect(sys).not.toContain('arc pressure');
        expect(sys).toContain('Character voice rules:');
        expect(sys).toContain('Minute-level times');
    });
    it('scene ignores an arc', () => {
        const closingLine = '이번 화는 Arc 의 종결 박자';
        expect(buildDraftSystem(arc('closing'))).toContain(closingLine);
        const sys = buildDraftSystem(arc('closing'), undefined, undefined, { form: 'scene' });
        expect(sys).not.toContain(closingLine);
        expect(sys).toBe(buildDraftSystem(undefined, undefined, undefined, { form: 'scene' }));
    });
});

describe('draft scene form — runDraft', () => {
    it('runDraft passes form', async () => {
        const system = await capture({ language: 'en', form: 'scene' });
        expect(system).toContain('one short scene');
        expect(system).not.toContain('One conflict, one step of progress');
        expect(system).not.toContain('arc pressure');
    });
    it('runDraft without form keeps the chapter system prompt', async () => {
        const system = await capture({ language: 'en' });
        expect(system).toContain('write the next chapter');
        expect(system).toContain('arc pressure');
        const sceneNull = await capture({ language: 'en', form: null });
        expect(sceneNull).toBe(system);
    });
});
