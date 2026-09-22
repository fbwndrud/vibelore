/**
 * TextGenerator — 1st-class generator, novel-chapter modality.
 *
 * Implements `Generator<TInput, TOutput>` where:
 *   - book-create input  → Foundation + initial Character[] + bound GenreProfile
 *   - chapter-write input → ChapterArtifact (prose + extracted ChapterDelta)
 *
 * Pipeline:
 *
 *   BookCreate:    worldbuild → castDesign → genreProfileBind → foundationInit
 *   ChapterWrite:  loadState(N-1) → chapterPlan → draft(+cast-manifest)
 *                  → registerCharacter* → layer1 lexicon scan → extractDelta
 *                  → layer2 continuityCheck → [HARD FAIL: bounded revise]
 *                  → sanitize → commit StoryState(N) + ChapterArtifact(N)
 *
 * T3.1 — shell wires plan/run/validate. Sub-step implementations (T3.2/T3.3/
 * T3.4) plug in via the `TextGeneratorSteps` constructor argument; defaults
 * are throwing stubs so the shell is testable now but cannot accidentally run
 * a half-implemented pipeline in prod.
 */
export function defaultTextGeneratorSteps() {
    return {
        worldbuild() {
            throw new Error('TextGenerator.worldbuild: TODO — T3.2');
        },
        writeChapter() {
            throw new Error('TextGenerator.writeChapter: TODO — T3.3 + T3.4');
        },
        rewriteFromChapter() {
            throw new Error('TextGenerator.rewriteFromChapter: TODO — T3.4');
        },
    };
}
const BOOK_CREATE_STEPS = [
    'worldbuild',
    'castDesign',
    'genreProfileBind',
    'foundationInit',
];
const CHAPTER_WRITE_STEPS = [
    'loadState',
    'chapterPlan',
    'draft',
    'registerCharacter',
    'lexiconScan',
    'extractDelta',
    'continuityCheck',
    'revise',
    'sanitize',
    'commitState',
];
const CHAPTER_REWRITE_STEPS = ['loadState', 'rewriteFromChapter'];
export class TextGenerator {
    steps;
    modality = 'text';
    kind = 'novel';
    constructor(steps = defaultTextGeneratorSteps()) {
        this.steps = steps;
    }
    async plan(_ctx, input) {
        switch (input.kind) {
            case 'book-create':
                return {
                    kind: 'book-create',
                    steps: [...BOOK_CREATE_STEPS],
                    meta: { input },
                };
            case 'chapter-write':
                return {
                    kind: 'chapter-write',
                    steps: [...CHAPTER_WRITE_STEPS],
                    meta: { input },
                };
            case 'chapter-rewrite':
                return {
                    kind: 'chapter-rewrite',
                    steps: [...CHAPTER_REWRITE_STEPS],
                    meta: { input },
                };
        }
    }
    async run(ctx, plan) {
        const input = plan.meta?.input;
        if (!input) {
            throw new Error('TextGenerator.run: plan.meta.input missing');
        }
        switch (plan.kind) {
            case 'book-create': {
                if (input.kind !== 'book-create') {
                    throw new Error(`TextGenerator.run: plan.kind=book-create but input.kind=${input.kind}`);
                }
                const { foundation } = await this.steps.worldbuild(ctx, {
                    title: input.title,
                    genre: input.genre,
                    brief: input.brief,
                    language: input.language,
                    targetChapters: input.targetChapters,
                    chapterWordCount: input.chapterWordCount,
                    ...(input.povMode ? { povMode: input.povMode } : {}),
                });
                return { kind: 'book-create', foundation };
            }
            case 'chapter-write': {
                if (input.kind !== 'chapter-write') {
                    throw new Error(`TextGenerator.run: plan.kind=chapter-write but input.kind=${input.kind}`);
                }
                const { artifact } = await this.steps.writeChapter(ctx, {
                    chapterNumber: input.chapterNumber,
                });
                return { kind: 'chapter-write', artifact };
            }
            case 'chapter-rewrite': {
                if (input.kind !== 'chapter-rewrite') {
                    throw new Error(`TextGenerator.run: plan.kind=chapter-rewrite but input.kind=${input.kind}`);
                }
                const { artifacts } = await this.steps.rewriteFromChapter(ctx, {
                    fromChapter: input.fromChapter,
                });
                return { kind: 'chapter-rewrite', artifacts };
            }
            default:
                throw new Error(`TextGenerator.run: unknown plan kind ${plan.kind}`);
        }
    }
    async validate(_ctx, output) {
        const violations = [];
        switch (output.kind) {
            case 'book-create': {
                const f = output.foundation;
                if (!f.workId || !f.genre || f.characters.length === 0) {
                    violations.push('foundation missing workId/genre/characters');
                }
                break;
            }
            case 'chapter-write': {
                if (output.artifact.prose.length === 0) {
                    violations.push('chapter prose empty');
                }
                break;
            }
            case 'chapter-rewrite': {
                if (output.artifacts.length === 0) {
                    violations.push('rewrite produced no artifacts');
                }
                break;
            }
        }
        return { passed: violations.length === 0, violations };
    }
}
