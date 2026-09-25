---
name: story-discovery-interview
description: Interview the user when creating a new novel or web novel (새 소설·웹소설, 신작 구상, 작품 생성, 소재 후보 선택) about taste, reading contract, protagonist, core device, early rewards, relationships, point of view and style, and turn the answers into a vibelore StoryProfile brief. Use it when the direction of a new work is not settled yet. Don't use it to write the next chapter of an existing work, or when the user explicitly asks to proceed automatically without questions (“알아서”, “자동으로”, “묻지 말고”, "automatically", "don't ask").
---

# Story discovery interview

Before generating a new work, discover the work the user actually wants to read. The finish line is not a number of questions but the state in which every important choice whose answer would change the work's design has been settled.

## Conversation language

Hold the whole interview in the language the user writes in: a Korean-speaking user gets every question, recommendation, example and summary in natural Korean, an English-speaking user gets them in English, and so on. These instructions are in English only for maintainability; they never set the conversation language. The work language (below) is a separate setting.

For a Korean-speaking user or a `ko` work, use the exact Korean strings marked `ko:` in this skill instead of translating the English text yourself. The reading-difficulty question, title and recommendation match the wording the server shows (`src/prompts/ko.js`), so the user sees one phrasing for them; the other `ko:` strings, including the per-axis option labels, are this skill's fixed wording and are not in the server. Korean glossary for recurring terms:

- reading contract — ko: 독서 계약
- author's latitude — ko: 작가 재량
- promise of the work — ko: 작품 약속
- early frustration — ko: 고구마

## Start

1. Check the profile for the same `workId` with `lore_profile_status`.
2. If there is an active profile, don't restart the interview; confirm what the user wants to change.
3. If there is a pending profile, continue from its existing `settledDecisions`, `askedQuestionIds` and `openQuestions`.
4. If the user explicitly said “알아서”, “자동으로”, “묻지 말고” or the equivalent in their language ("decide for me", "automatically", "don't ask"), use the existing auto design path instead of the interview.

## How to converse

- Ask only 4-5 related questions per round. Attach to each question a recommendation and a short note on how that choice changes the reading experience.
- Offer 2-4 concrete examples so the choice is easy, but accept free answers too. You may tidy up the user's wording, but don't turn a preference into more complicated settings.
- When an answer reveals a new preference or a contradiction, dig into it in the next round. Don't ask about questions already answered, names or props the model will decide during design, or per-chapter micro-rules.
- Ask about scene outcomes rather than vague yes/no. For example, instead of "Is the mood dark?" ask "When chapter 1 ends, should the reader feel catharsis or unease more strongly?" (in Korean: “어두운 분위기인가?”보다 “1화가 끝났을 때 독자가 통쾌함과 불안 중 무엇을 더 크게 느껴야 하는가?”).
- A short initial idea can typically take 4-6 rounds and produce 20-30 decisions in total. With a sufficient brief, finish early; don't invent questions to reach a number.

## What to investigate

Look only for open decisions in these areas that would still change the result.

- The core pleasure the reader receives again and again, and the depth of the work
- Familiar genre grammar and one or two points of difference
- The protagonist's desire, competence, lack, moral line and agency
- The usefulness, limits and possible misjudgment of abilities, regression, possession and world rules
- Chapter 1's pressure, the first reward, the tolerance for early frustration (고구마) and the sense of rising through chapter 10
- The familiarity of the world and the budget for new concepts, how exposition is paid out in scenes, and the surface meaning a reader without prior knowledge can hold on to
- The point-of-view character, narrative distance, and the information gap between reader and protagonist
- The key supporting cast's independent desires, relationship changes, and the intensity of romance or harem
- The texture of dialogue, each character's way of speaking, sentence rhythm, chapter length and line breaks, and when to use figures, precise times and jargon versus everyday expressions
- Material, emotional lines and plot formulas to avoid, and the group of works to compare against

Don't ask about every area equally deeply. Focus questions on areas where the choice changes the first 10 chapters or the repeating engine.

## Required reading-difficulty contract

Don't treat thematic depth and difficulty of reading as the same thing. In a normal interview, check that the user chose these four.

- Surface readability of sentences and scenes: easy, standard, dense (ko: 쉽게, 표준, 조밀하게)
- Pace of introducing new settings and system concepts: slow, standard, fast (ko: 느리게, 표준, 빠르게)
- Inference load of dialogue and causality: surface meaning explicit, balanced, subtext-driven (ko: 표면 뜻은 명확하게, 균형, 서브텍스트 중심)
- Complexity ramp: start easy early on, steady, dense from the start (ko: 초반은 쉽게 시작, 일정하게, 처음부터 조밀하게)

Ask it with the server's wording. ko question: “주제의 깊이와 별개로, 문장 난도·새 개념 투입 속도·독자가 추론할 양·초반 복잡성 상승 방식을 어떻게 할까요?” (title ko: 읽기 난도)

The recommended default is "easy to read + slow concept introduction + explicit surface meaning + complexity after the reader settles in". ko: “권장은 ‘쉽게 읽히는 문장 + 느린 개념 투입 + 표면 뜻은 명확하게 + 초반은 익숙해진 뒤 복잡해짐’입니다. 주제적 깊이는 이와 별개로 높일 수 있습니다.” When summarizing the settled values, use the ko form “읽기 난도: … / 개념 속도: … / 추론 부담: … / 복잡성: …” with the option labels above; the server's own settled summary prints the stored enum values (`easy|standard|dense` and so on) in that form. Apply these values without asking only when the user explicitly asked to proceed automatically without questions. Store reading difficulty as a lasting contract for the whole work; don't expand it into micro-rules such as per-chapter sentence length or proper noun counts.

## Work language

The conversation language and the language the work is written in are separate.

If the user states the writing language, normalize it into a BCP 47 tag and pass it as the optional `language` argument of `lore_profile` — Japanese → `ja`, Brazilian Portuguese → `pt-BR`, Traditional Chinese → `zh-Hant`. If they didn't state it, omit the argument so the language already set is used as is, and don't invent a new question to confirm the language. If there is a clear correction later, use that latest value. Ask only when different languages remain at the same time and it is unclear which one is meant.

The full rules of the language contract are in [Work language and length units](../../docs/TOOLS.md#작품-언어와-분량-단위) (English: [TOOLS.en.md](../../docs/TOOLS.en.md#work-language-and-length-units)).

## MCP connection

Organize each round's answers into one clear `feedback` and pass it to `lore_profile(mode="review")`.
Pass the user's brief and answers in full, in their original wording, whatever language they came in. Don't drop information by
summarizing, and don't rewrite them into Korean wording in a way that changes the actual choice. Don't ask a question again
just because an answer doesn't match a particular expression or sentence pattern. The only grounds for asking the same question again
are an answer that is actually empty or contradicts an earlier answer.

Blend the `designReview.openQuestions` returned by MCP naturally into the next round, and state that a corrected answer takes precedence as the latest intent.

When the important open decisions are gone, show the following at once.

- A one-sentence promise of the work (ko: 한 문장의 작품 약속)
- The settled key decisions (ko: 확정된 핵심 결정)
- The author's latitude deliberately left open (ko: 의도적으로 열어 둔 작가 재량)
- The quality criteria for the first 10 chapters (ko: 첫 10화 품질 평가 기준)
- A summary of the generated StoryProfile (ko: 생성된 StoryProfile의 요약)

For a Korean user, use the ko strings above as the section headings.

Only then ask for StoryProfile approval. Before approval, don't move on to `lore_create`, StorySpine, WriterSkill or ArcPlan.

## Boundaries

Interview answers are input for this work. Don't promote them into global banned words for every genre, a checklist to repeat every chapter, or a detailed state machine. Leave to the author's latitude the areas the genre and the model judge well, and store in MCP only the reading contract and design decisions that will be reused over the long term.
