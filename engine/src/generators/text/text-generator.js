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
 *
 * 다국어 Phase 2A — 이 어댑터는 언어 계약을 **정하지 않고** 잃지도 않는다.
 * 호출자가 적은 `language`/`workContract`/`length`(+구형 `chapterWordCount`)를
 * 그대로 단계에 전달하고, 서로 어긋나면 단계까지 내려가기 전에 여기서 거부한다.
 * 적지 않은 속성은 `undefined` 로 주입하지 않고 **아예 빼서** 내려보낸다 —
 * 하위 단계가 "명시 여부"로 구형/신규 동작을 가르기 때문이다.
 */
import { resolvePromptLanguageContext } from '../../core/prompt-language.js';
/** 실제로 적힌 속성만 골라 넘긴다(없는 키는 주입하지 않는다). */
function forwardPresent(input, keys) {
    const out = {};
    for (const key of keys) {
        if (input[key] !== undefined)
            out[key] = input[key];
    }
    return out;
}
/**
 * 어댑터 경계에서 언어·분량 인자의 정합성만 확인한다. 계약을 만들어 하위로
 * 내려보내지 않는다 — 단계가 자기 규칙(구형 기본값 등)으로 다시 해석해야 한다.
 */
function assertLanguageInput(input, { legacyLengthKey = null } = {}) {
    const hasLegacy = legacyLengthKey !== null && input[legacyLengthKey] !== undefined && input[legacyLengthKey] !== null;
    if (input.workContract === undefined && input.language === undefined && input.length === undefined && !hasLegacy)
        return;
    resolvePromptLanguageContext({
        workContract: input.workContract ?? null,
        language: input.language ?? null,
        length: input.length ?? null,
        legacyLength: hasLegacy ? { chapterWordCount: input[legacyLengthKey] } : null,
    });
}
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
                assertLanguageInput(input, { legacyLengthKey: 'chapterWordCount' });
                const created = await this.steps.worldbuild({
                    ...ctx,
                    ...forwardPresent(input, ['validationEpoch', 'validationReceipt', 'workflowId', 'runId', 'workContract', 'language', 'length']),
                }, {
                    title: input.title,
                    genre: input.genre,
                    brief: input.brief,
                    targetChapters: input.targetChapters,
                    // 명시된 것만 넘긴다 — 구형 입력이 새 키를 얻지 않는다.
                    ...forwardPresent(input, [
                        'language', 'chapterWordCount', 'workContract', 'length',
                        'validationEpoch', 'validationReceipt', 'workflowId', 'runId',
                        'canonicalApprovalArtifact', 'languageCompliance',
                    ]),
                    ...(input.povMode ? { povMode: input.povMode } : {}),
                });
                return { kind: 'book-create', ...created };
            }
            case 'chapter-write': {
                if (input.kind !== 'chapter-write') {
                    throw new Error(`TextGenerator.run: plan.kind=chapter-write but input.kind=${input.kind}`);
                }
                assertLanguageInput(input, { legacyLengthKey: 'targetWordCount' });
                const { artifact } = await this.steps.writeChapter({
                    ...ctx,
                    ...forwardPresent(input, ['validationEpoch', 'validationReceipt', 'workflowId', 'runId', 'workContract', 'language', 'length']),
                }, {
                    chapterNumber: input.chapterNumber,
                    ...forwardPresent(input, [
                        'language', 'targetWordCount', 'workContract', 'length',
                        'title', 'summary', 'canonicalArtifact', 'validationReceipt',
                        'validationEpoch', 'workflowId', 'runId',
                    ]),
                });
                return { kind: 'chapter-write', artifact };
            }
            case 'chapter-rewrite': {
                if (input.kind !== 'chapter-rewrite') {
                    throw new Error(`TextGenerator.run: plan.kind=chapter-rewrite but input.kind=${input.kind}`);
                }
                assertLanguageInput(input);
                const { artifacts } = await this.steps.rewriteFromChapter({
                    ...ctx,
                    ...forwardPresent(input, ['validationEpoch', 'validationReceipt', 'workflowId', 'runId', 'workContract', 'language', 'length']),
                }, {
                    fromChapter: input.fromChapter,
                    ...forwardPresent(input, [
                        'language', 'workContract', 'length',
                        'title', 'summary', 'canonicalArtifact', 'validationReceipt',
                        'validationEpoch', 'workflowId', 'runId',
                    ]),
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
