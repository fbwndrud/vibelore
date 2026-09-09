# 다국어 지원 기획

작성일: 2026-09-09. 상태: **5차 검토 완료, 구현 착수 가능한 설계**. 구현·회귀 검증은 아직 수행하지 않았다.

사용자 요청에 따라 최대 5차의 검토·보완을 수행했다. 1~3차는 Claude/Grok, 4~5차는 Claude의 재검토와 Codex 대조로 진행했다. 5차의 최종 판정은 READY이며, 주요 설계 모순은 해소됐다. [차수별 채택·기각 기록](research/multilingual-2026-09-09/loops/REVIEW_LOG.md)과 [5차 최종 검토](research/multilingual-2026-09-09/loops/round-5-claude.md)에 근거를 남겼다.

## 작업 기준

- 브랜치: `codex/multilingual-prompts`
- 작업 폴더: `/Users/lyoojk/vibelore-plugin-multilingual`
- 기준 커밋: `11455398c53aaa3531afccad905798dbcc463c19`
- 기존 `webtoon` 작업 폴더의 미커밋 변경은 포함하지 않았다. 웹툰 기능 통합 시 별도 접점 검토가 필요하다.
- 이번 산출물은 설계와 업무 배분이다. 실제 구현·소설 생성·기존 작품 마이그레이션은 수행하지 않았다.

## 제안

프롬프트를 **한국어 특화 계열 + 영어 기반 다국어 계열** 두 벌로 관리한다. 영어도 다국어 계열을 사용한다. 언어마다 전체 프롬프트를 복제하지 않는다. 두 벌이라는 뜻은 단계별 템플릿을 갖는 두 계열이며, 전체 집필 과정을 거대한 프롬프트 두 개로 합친다는 뜻은 아니다.

공통 실행 흐름과 출력 스키마는 하나로 유지하고, 단계별 텍스트와 예시만 선택한다. 다국어 계열에는 목표 언어·지역/문자 체계·작품의 말투와 호칭·분량 단위를 주입한다. 해당 언어의 자연스러운 산문을 직접 생성하며 한국어 원고를 거쳐 번역하는 과정은 두지 않는다.

```text
사용자의 작품 언어 선택 → 작품에 저장 → 워크플로 시작 시 고정
                                  ↓
                   ko 계열             그 외
                한국어 특화          영어 기반 공통
                                  + 목표 언어 지시
                                  ↓
                  기획·본문·수정·요약·검토에 일관 적용
                                  ↓
                  공통 불변식 + 적용 가능한 언어 검사
```

## 현재 코드에서 확인한 문제

| 근거 | 확인 내용 | 설계 영향 |
|---|---|---|
| `src/tools/generate.js:47`, `:264`, `:277` | 생성·교정·재작성에 `language: 'ko'` 고정 | MCP 입력부터 실제 모델 호출까지 연결해야 한다. |
| `src/core/draft-execution.js:3`, `engine/src/generators/text/steps/draft.js:103`, `:321` | 실제 본문 생성은 `steps/draft.js`의 자체 system builder를 사용 | `prompts/draft.js`만 번역해서는 동작이 바뀌지 않는다. |
| `engine/src/generators/text/steps/chapter-plan.js`, `chapter-summary.js`, `coherence-judge.js` | 계획·요약·평가의 한국어 강제 | 본문 밖의 자연어 출력도 같은 언어 계약이 필요하다. |
| `src/tools/story-profile.js:192`, `:207` | 프로필에 `chapterChars`와 한국어 예시·기본값 | 프로필·작가 예시 생성도 언어 선택 이후에 실행해야 한다. |
| `src/tools/check.js:45`, `engine/src/continuity/pov-check.js:26` | 한국어 사전과 조사·내면 동사 검사 | 다른 언어에 한국어 판정을 그대로 적용하면 안 된다. |
| `src/tools/webnovel-format.js:35`, `src/core/quality-policy.js:1` | 대사 독립 문단 규칙이 수정 차단 조건에 포함 | 영어의 일반적인 대사+발화자 서술을 오탐한다. |
| `engine/src/core/mention-scan.js:50` | 이름을 대소문자 무시 부분 문자열로 탐색 | 영어 짧은 이름에서 잘못된 인물·설정 주입이 생긴다. |
| `engine/src/continuity/sentence-stats.js:11`, `engine/src/core/sliding-window.js:14` | 한국어 리듬 임계값과 `length / 2` 토큰 근사 | 언어별 산문 품질이나 실제 토큰 수로 간주할 수 없다. |
| `src/store/markdown-store.js:446`, `:482` | 한국어 섹션 제목 파싱과 정해진 frontmatter 소유 키 | 저장 파일을 단순 번역하면 재읽기에서 정보가 빠질 수 있다. |
| `src/provider/host-relay.js:61`, `engine/src/core/request-fingerprint.js` | 요청 메시지가 fingerprint에 포함 | 언어 주입은 요청 생성 전에 결정하고 재개 시 고정해야 한다. |
| `src/tools/story-profile.js:77`, `:134` | web serial이면 strict 포맷을 강제하고, 읽기 난도 답변 확인은 한국어 정규식에 의존 | 프롬프트 번역 외에 포맷 선택·인터뷰 확인 로직도 고쳐야 한다. |

Codex가 기준 커밋에서 직접 실행한 작은 재현 두 건:

1. `"I will go," she said.` → `WEBNOVEL_DIALOGUE_NOT_ISOLATED`가 blocking으로 분류된다.
2. 인물 `Ann`, 본문 `The banner fell.` → `Ann`이 등장한 것으로 탐지된다.

이는 현재 동작의 재현이며 다국어 구현의 통과 테스트가 아니다.

## 언어 계약

1. **작품 언어는 생애 단계별로 한 곳에서만 결정한다.** foundation 이전 인터뷰는 현재 프로필 revision의 language를 사용한다. foundation 생성은 그 revision이 승인된 경우에만 가능하며 오래된 승인 revision으로 자동 후퇴하지 않는다. 프로필 없이 `init/create`를 사용하는 기존 저수준 경로는 명시 요청 또는 ko 기본을 사용한다. foundation 생성 시 language를 foundation과 `world/setting.md`에 동일하게 기록하고, 수락한 언어를 복구·검증용 생성 기록으로 남긴다. 생성 후 최초 발행 전에는 저장된 foundation이 원천이며 프로필은 사본이다. 최초 발행 뒤에는 `openCanonRepository`가 읽는 Published HEAD의 foundation이 실행 원천이다. 손수정은 저장된 생성/발행 계약과 대조하며, 언어 변경을 승인 없이 실행 원천으로 삼지 않는다. 프로필과 워크플로는 동일 계약의 revision/hash로 묶인다.
2. 입력은 BCP 47 형식으로 정규화한다. `ko-KR`은 한국어 계열, `en-US`·`ja`·`zh-Hant`·`es`·`ar`는 공통 계열이다. 지역과 문자 체계는 버리지 않는다. 태그 문법·언어 식별 가능 여부·해당 언어의 모델 품질 보장은 구분한다. 형식 파서가 수용한 문자열을 모두 알려진 언어라고 간주하지 않는다. `kr`는 Kanuri이며 한국어의 잘못된 코드로 일괄 거부하면 안 된다. `zh`도 유효한 일반 중국어 선택으로 받되 사용자가 지정한 Hant/Hans는 보존한다.
3. 신규 작품은 사용자가 지정한 목표 언어를 우선한다. 자연어로 지정한 “일본어로 써 줘”는 호스트가 언어 인자로 전달한다. `lore_init/create/profile/write`에 optional `language`를 노출하되 schema/dispatch에는 기본값을 넣지 않는다. 미지정이면 저장된 프로필/작품 언어를 쓰고, 아무 계약도 없는 신규 호출만 `ko`로 해석한다. 언어 키 없는 기존 foundation/프로필은 이미 선택된 암묵적 `ko`이며 “언어 미설정”이 아니다. 조회만으로 파일을 변경하지 않는다. 대화 언어 변경은 작품 언어 변경이 아니다.
4. v1은 foundation 생성 이후 목표 언어 변경과 기존 작품 번역을 지원하지 않는다. 기존 작품과 다른 명시 인자는 `WORK_LANGUAGE_IMMUTABLE`로 거부하고 새 작품을 만들도록 안내한다. foundation 이전 프로필 언어 변경은 명시된 사용자 요청으로 새 프로필 revision을 만들고 기존 언어의 예시·승인·대기 요청을 계승하지 않는다. `init/create` 인자와 기존 프로필 언어가 다르면 생성 전에 오류를 반환한다. `write`의 language는 저장 계약과 일치하는지 확인하는 인자이며 일회성 출력 언어 override가 아니다.
5. 잘못된 태그·빈 명시값·둘 이상의 상충 언어는 조용히 한국어나 영어로 바꾸지 않고 입력 오류/선택 필요로 돌려준다. 여러 언어를 함께 쓰는 작품은 주 언어와 승인된 대사 예외를 구분한다.
6. 본문, 제목, 요약, 설정 설명, 인물 설명, 계획과 critic의 설명 값은 작품 언어로 생성한다. JSON 키, 기존 enum 값, ID, 경로와 sentinel은 번역하지 않는다. 인물 이름과 원문 인용은 작품 설정에 따른다.
7. 호스트의 사용자 설명은 사용자의 대화 언어를 따를 수 있지만, 이것이 작품 언어를 바꾸지는 않는다. 정적인 시스템 메시지는 한국어/영어 두 계열과 안정적인 오류 코드를 제공한다. 모든 언어의 UI 문자열 사전 구축은 포함하지 않는다.

완료 기준의 언어 목록은 allowlist가 아니라 회귀 표본이다. 식별 가능한 다른 목표 언어도 같은 multilingual 계열로 받는다. 이를 위해 새 프롬프트·렉시콘 팩을 필수로 만들지 않는다. 태그의 문법과 런타임 언어 식별을 분리하고, 식별이 불명확하면 언어명/태그를 명확히 하는 입력을 요청한다. 모델의 해당 언어 구사 능력은 실제 생성·검토 결과로 판단한다.

## 최소 구조

새 파일명은 제안이며 구현 시 기존 호출 구조에 맞춰 확정한다.

- `engine/src/core/language-policy.js`: 태그 정규화, 프롬프트 계열, 출력 언어 지시와 적용 가능한 검사 정책을 해결한다. 임의의 언어 문자열을 system에 붙이지 않고 검증된 값으로 지시문을 조립한다.
- `engine/src/generators/text/prompts/ko/`, `.../multilingual/`: 단계별 템플릿 두 계열. 기존 한국어의 품질 규칙과 예시는 유지한다. 공통 계열은 영어 지시와 짧은 예시를 가지며 목표 언어 출력 지시를 명시한다.
- 작은 selector/composer: `step + language policy + stage input → messages`. 각 단계의 JSON 계약과 기존 `needs_model → lore_resume` 실행 흐름은 유지한다. 플러그인 계층의 profile·arc·critic 등도 같은 선택 정책을 사용한다.
- 작품에서 승인된 `voiceContract`·`writerSkill`·style anchor의 예시는 목표 언어로 생성/보존한다. 언어별 정적 예시 모음을 끝없이 추가하지 않는다. 새 언어를 추가할 때 전체 템플릿 파일을 늘리지 않는 것이 완료 조건이다.
- 실제 요청의 언어·프롬프트 계열/버전·분량 계약·검사 정책을 워크플로 스냅샷에 묶는다. prompt fingerprint뿐 아니라 검사 영수증과 정본/계획 변경 감지도 같은 계약을 참조한다. 재개·수정·재검사에서 언어가 달라지면 기존 결과를 재사용하지 않는다.
- 프로필 발견 인터뷰의 고정 질문·fallback·사용자 답변 확인도 언어 계약을 따른다. 한국어 정규식에 안 맞았다는 이유로 다른 언어의 명시적 답변을 미응답으로 되돌리지 않는다. 사용자 확인 여부는 실제 답변 근거가 있는 구조화된 선택으로 연결하며 모델이 임의로 승인하지 않는다.
- 엔진의 공개 export는 MCP에서 직접 사용하지 않아도 호환 대상이다. 실제 호출 경로와 공개 API를 구분해 공통 selector로 연결하고, 이번 작업을 이유로 엔진 API를 삭제하지 않는다. 정적 prompt manifest는 실제 사용하는 두 계열의 정적 템플릿을 기록하고 동적인 작품별 입력은 요청 fingerprint에 남긴다. 엔진 변경 시 저장소의 버전 규칙을 따른다.

2A의 이관 목록은 `prompts/`에 한정하지 않는다. `src/core/writer-episode-packet.js`, `narrative-contract.js`, `draft-input-compiler.js`의 작성 지시·파생 문구, engine의 `arc-context/entity-context/sliding-window/custom-prompt-override` 렌더러, 도구의 fallback·예시까지 **최종 provider messages** 기준으로 분류한다. 정적인 지시/라벨은 두 계열에서 관리하고, 작품 데이터·고유명·기계 enum은 번역 대상으로 오인하지 않는다. 조립 후 요청 캡처 테스트로 비ko 경로에 한국어 집필 지시가 남지 않는지 확인한다. 단순 소스 전체 한글 검색의 0건을 완료 기준으로 삼지 않는다.

## 프롬프트 외에 함께 처리할 범위

**검사:** 정본 사실·ID·구조·메타데이터 누출 등 언어 독립 검사는 모든 언어에 유지한다. 한국어 조사·존칭·리듬 검사는 한국어에서 유지하고, 다른 언어에는 검증된 검사만 적용한다. 결과에 `passed / failed / skipped / error`와 적용 범위를 기록하여 미지원 검사를 성공으로 표시하지 않는다. 필수 불변식을 확인할 수 없으면 검사 완료로 처리하지 않는다. soft/advisory는 자동 수정 사유로 승격하지 않으며 critic 실패 시 auto를 guided로 내리는 계약은 유지한다. 언어 오출력은 정본 사실 충돌과 구분된 출력 계약 오류로 다룬다.

검사기 하나의 미지원과 불변식 자체의 미검증은 구분한다. 한국어 POV 탐지기를 실행할 수 없다는 이유만으로 모든 외국어 집필을 영구 차단하지 않는다. 같은 불변식을 확인하는 목표 언어의 구조화된 의미 검토를 연결·검증한다. 필수 검토가 미완료면 `validation_incomplete` 결과와 원고를 표시하되 **승인 가능한 guided 상태로 전이하지 않는다**. 기존 critic 실패의 guided 강등은 필수 불변식·출력 계약 검사가 끝난 경우에만 적용한다.

| 필수 불변식·출력 계약 | critic | 영수증/다음 행동 |
|---|---|---|
| 위반 확인 | 무관 | 통과 영수증 없음, 같은 workflow의 제한된 수정·재검사 |
| 미완료·error·uncertain | 무관 | 미검증 항목 표시, 재개/재검사 필요, guided 승인으로도 커밋 불가 |
| 모두 통과 | 실패·미완료 | 핵심 검사 영수증 + critic 미완료 기록, 기존 guided 승인으로만 발행 |
| 모두 통과 | 정상 완료 | guided는 사용자 승인, auto는 기존 조건 충족 시 발행 |

soft 전용 검사 미지원은 사유와 범위를 표시하고 발행을 막지 않는다. 실행하지 않은 검사의 점수는 `null`이며 0점/100점으로 합성하지 않는다. 검사기별 상태와 불변식별 검증 상태를 별도로 집계하고 영수증에는 미검증 목록을 남긴다.

1단계에서 다음 구분을 고정한 검사 등록표를 2B에 전달한다. 전 언어 필수는 기계 schema/ID/sentinel 무결성, 확정 intrinsic·세계 사실·등록 상태와의 충돌, 승인된 시점/호칭 관계 계약, 명시된 분량·포맷·출력 언어 계약이다. 시점/호칭 조건이 없는 작품은 해당 항목을 `not_applicable`로 기록한다. ko의 기존 hard 탐지 결과는 유지하고, 비ko에서는 언어 전용 detector 대신 같은 근거를 읽는 semantic 판정을 연결한다. 한국어 감정/직유/의성어 빈도·리듬·클리프행어·문체 취향은 기존 severity를 유지하는 advisory이며 보편 필수 목록으로 승격하지 않는다. 기존에 hard로 분류되는 민감어 항목은 severity를 낮추거나 조용히 생략하지 않고 정책 등록표에 명시하여 적용 가능한 대체 검토를 정한다. 파서가 없다는 사실과 계약이 적용되지 않는다는 사실을 같은 상태로 쓰지 않는다.

**출력 언어 확인:** 문자 비율·문자 체계 탐지는 보조 정보일 뿐 pass/fail 기준이 아니다. 언어 독립 계약 검사에서 `languageCompliance: { verdict: pass|fail|uncertain, artifactHash, evidence: [{fieldPath, quote, reason}], allowedExceptions }`를 검증한다. 고유명·원문 인용·승인된 외국어 대사·기계 enum은 예외로 구분하고, 작품 언어와 다른 전체 본문이나 요약은 실패로 돌린다. 잘못된 JSON·다른 artifactHash·실패인데 근거 없음은 판정 성공이 아니다.

기존 semantic continuity 요청에서 같은 근거를 확인할 수 있으면 그 요청에 묶는다. 프로필/토대/아크 등 별도 승인 산출물이나 최종 요약처럼 기존 요청 이후 생성되는 값은 **언어 공통 계약 검토 요청 하나**로 산출물 묶음을 확인한다. 언어별 검토 파이프라인은 만들지 않는다. 이 검토도 ko/multilingual 두 템플릿 계열과 기존 `needs_model → resume` 포트를 사용한다. 모든 필드에 별도 호출을 만들지 않고, 승인/발행 직전에 고정된 묶음으로 검증한다. 재사용은 아래의 동일 validation epoch·원천·계약·산출물에 한해서만 허용한다. 논리·문체 critic의 점수/성공 여부로 언어 준수를 대신하지 않는다. JSON 키뿐 아니라 소스 코드가 비교하는 한국어 enum/시점 값도 기계 계약으로 목록화해 보존한다.

오언어 실패는 `OUTPUT_LANGUAGE_MISMATCH`로 같은 workflow의 기존 수정 시도 상한 안에서 필요한 부분만 재생성한다. 보류 중 응답은 기존 `needs_model`로 기다린다. 실제 fail/uncertain/잘못된 판정 응답은 기존 `MAX_ATTEMPTS=3` 안에서 센다. 완료된 시도 수는 영속하며 resume가 카운터를 초기화하지 않는다. 상한 소진 시 기존 terminal `clean_fail`에 `VALIDATION_INCOMPLETE` 또는 `OUTPUT_LANGUAGE_MISMATCH` 원인을 남기고, 원고·근거·미검증 목록을 보존한다. 더 이상 자동 모델 요청이나 자동 재시작을 하지 않는다.

명시적 재검사는 `lore_write(retryValidation:true)`로만 허용한다. 실패 workflow의 원고를 재사용하되 새 validation epoch와 시도 묶음을 만들고 이전 판정·승인은 계승하지 않는다. **drift가 없고 계약이 동일하면 프로필 변경 없이도 재검사가 가능하다.** 일반 `write/resume`는 종료 상태를 보고한다. 프로필/토대 등 workflow 밖 계약 검토도 relay run의 동일한 유한 시도 기록을 사용하며, 소진 뒤에는 해당 생성 도구의 명시적인 새 요청으로만 재시도한다. 사용자 인용 예외는 프로필에 저장된 `allowedLanguageExceptions`의 새 승인 revision으로 반영한다. 각 예외는 고유명/원문 인용/특정 인물의 대사 중 종류·목표 언어·적용 범위와 사용자 근거를 갖고, 본문 전체·요약·설정 설명의 다른 언어 출력을 허용하는 wildcard는 받지 않는다. 예외 변경은 목표 언어 변경을 허용하는 통로가 아니다. 새 무한 재시도 루프나 soft 취향 수정 이유로 쓰지 않는다.

**대사·이름:** 모든 언어에 한국어식 대사 단독 문단을 강제하지 않는다. 승인된 작품 포맷을 따른다. 영문 apostrophe, 일본어 괄호 인용, 스페인어 대사 dash 등은 적용 가능한 파서만 사용한다. 이름 탐지는 Latin 단어 경계·CJK 짧은 이름을 구분해 기존 한국어 조사 결합 탐지를 보존한다. 무조건 `\\b`로 바꾸지 않는다.

**분량:** `length: { unit, target }`의 unit은 `legacyCodeUnits | graphemes | words`로 고정한다. `legacyCodeUnits`는 현재 JS `String.length`와 동일하다. 기존 `chapterWordCount/chapterChars/targetChars` 인자는 이름과 무관하게 그 단위로만 해석한다. 신규 length와 구형 인자를 함께 지정하면 단위와 목표가 모두 동일한 경우만 수용하고 나머지는 `LENGTH_CONTRACT_CONFLICT`다. 목표는 유한한 양의 정수다. 기존 프로필의 1000~10000자 clamp를 words에 재사용하지 않는다.

신규 프로필 schema version 3은 ko를 포함해 **`format.length`만 생성·저장**한다. 모델 schema/정규화/fallback에서 `chapterChars:3000`를 추가하지 않는다. 구형 프로필은 읽기 어댑터에서 기존 `chapterChars`를 length로 해석하되 원본을 자동 재작성하지 않는다. 충돌 검사는 호출자가 실제로 중복 지정한 필드나 이미 저장된 상충 값에만 적용하며 어댑터가 가짜 중복을 만들지 않는다. 신규 `profile/create` 및 고급 `draft`의 `length` 입력을 같은 resolver로 연결하고, 일반 write는 승인된 프로필의 목표를 따른다. 단계별 코드가 `chapterChars`를 직접 읽어 기본값을 다시 정하지 않는다.

기존 작품과 신규 ko의 기본은 `legacyCodeUnits:3000`이며 저장된 목표가 있으면 그것을 따른다. 신규 비ko의 기본은 `graphemes:3000`이다. 이는 기존 값을 변환한 것이 아니라 새 작품의 명시된 기본값이며 프로필 검토에서 표시한다. 사용자는 words 등을 선택할 수 있다. graphemes는 Unicode 문자군 계산으로 언어 사전을 요구하지 않으며 공통 Segmenter의 측정 locale을 명시적으로 기록한다. words는 목표 locale을 지원하는 `Intl.Segmenter`의 `isWordLike`만 센다. words 분할 지원이 없으면 `UNSUPPORTED_LENGTH_MEASUREMENT`를 반환하고 graphemes 선택을 안내하며, 작품 언어 자체를 미지원 처리하지 않는다. `resolvedOptions`/`supportedLocalesOf`를 확인하여 words가 호스트 기본 언어로 조용히 대체되지 않게 한다.

측정 버전·런타임/ICU 버전·측정 locale·단위·공백/문장부호/본문만 계산 여부를 핀에 넣고 generation·length gate·density·요약 분량 지시에 같은 측정 계약을 사용한다. 본문 길이는 sentinel 제거 후 trim한 발행 본문을 대상으로 하며 graphemes는 그 안의 공백·문장부호도 포함한다. tokenizer 없는 토큰 수는 별도의 근사이며 분량 단위와 혼용하지 않는다. 로컬 확인에서 `kr`를 요청한 Segmenter가 `en-US`로 대체되므로, 언어 식별과 단어 측정 지원을 하나로 취급하면 안 된다.

**저장:** 기존 한국어 정본 포맷은 그대로 읽는다. `canonicalFormatVersion` 미지정/1은 기존 한국어 구조, 신규 비ko 작품은 2와 고정 영문 구조를 사용한다. 소유 표제 대응은 `세계 사실/World facts`, `모순/Contradiction`, `설명/Description`, `극적 모델/Dramatic model`, `말투 프로필/Speech profile` 다섯 쌍으로 고정한다. 표시 언어마다 표제를 추가하지 않는다. 버전은 locale에서 매번 추론하지 않고 해당 Markdown 문서 frontmatter에 기록·보존한다. 1의 읽기/저장을 2로 자동 바꾸지 않는다. 같은 의미의 소유 표제가 두 언어로 중복되면 합치거나 덮어쓰지 않고 `CANONICAL_SECTION_CONFLICT`로 중단한다. 알 수 없는 사용자 섹션은 보존한다.

형식 버전도 workContract에 고정한다. 버전 2로 생성된 문서에서 버전 키 삭제/변경은 레거시 문서로 돌아가는 방법이 아니며 계약 불일치다. v1 파서는 한국어 소유 표제만, v2는 영문 소유 표제만 해석한다. v2의 소유 표제는 내용이 비어도 처음 저장할 때 생성한다. 예상 소유 표제가 사라지고 반대 언어 표제만 있으면 `CANONICAL_FORMAT_MISMATCH`로 보고하고 파일은 보존한다. 예상 표제가 없는데 반대 언어 표제를 대신 읽거나 빈 설정으로 자동 발행하지 않는다. 예상 표제가 정상 존재하는 경우 그 외 사용자 섹션은 그대로 보존하되 위의 양언어 소유 표제 중복 규칙을 적용한다.

실제 읽을 서술 값은 작품 언어다. 왕복 저장 시 사용자 섹션·인물 ID·고유명·알 수 없는 frontmatter를 보존한다. `language`와 형식 버전을 명시 소유 키로 추가한다. language 손수정은 drift로 감지하며 v1의 기존 작품 언어 불변 규칙에 따라 차단한다. `.vibelore/` 파일은 직접 수정하지 않는다. 정본 adapter·snapshot·publication projection도 같은 직렬화 정책을 사용한다.

소유 키로 등록한다는 뜻은 구작의 첫 쓰기에 키를 추가한다는 뜻이 아니다. 기존 문서에 language/형식 버전 키가 없었다면 save·sync·다음 화 발행에서도 그 부재를 보존한다. 암묵적 ko/format 1은 실행 해석에만 사용한다. 키가 원래 있던 문서 또는 이번 계약으로 새로 생성한 문서의 최초 저장에만 두 키를 기록한다. serializer는 기존 문서의 키 존재 여부를 확인하며, resolved 기본값을 그대로 frontmatter에 퍼뜨리지 않는다. 새 신작 ko는 language ko/format 1, 새 비ko는 지정 언어/format 2를 최초 생성 때 기록한다.

**웹툰:** 이번 브랜치는 소설 생성·관리 경로를 대상으로 한다. 이후 웹툰 작업을 합칠 때 작품 언어 상속, 번역 언어 분리, 글꼴과 RTL/shaping 지원을 별도로 검증한다. 다국어 텍스트 생성이 웹툰 이미지의 다국어 렌더링 지원을 의미하지 않는다.

## 재개·발행·이전 버전 호환 계약

- `workContract`에는 `schemaVersion, language, promptFamily, templateVersion, length, measurementPolicy, formatPolicy, canonicalFormatVersion, checkerPolicyVersion, allowedLanguageExceptions`를 저장하고 정규화된 내용의 hash를 만든다. 사용자 자유 문체 지침은 작품 데이터로 별도 직렬화하며 language system 지시문에 무검증 삽입하지 않는다.
- relay run·workflow·검사 결과·sync candidate·영수증이 동일한 contract hash와 `workId, chapter, sourceHead, planSourceHash, artifactHash`를 참조한다. `artifactHash`는 본문뿐 아니라 발행할 제목·요약·기계 delta/manifest를 포함한다. 사용자 승인도 같은 hash에 귀속한다. 검사 뒤 바뀐 요약을 본문 해시만으로 발행하지 않는다.
- 매 resume/decide/commit 및 sync apply 직전에 핀과 현재 실행 계약·HEAD·계획·작업 폴더 drift를 비교한다. 불일치는 `STALE_WORK_CONTRACT`/기존 drift 오류로 차단하고 기록은 보존한다. 태그를 원래 값으로 되돌렸다는 이유만으로 이미 stale로 판정한 영수증·승인을 부활시키지 않는다. 재검사에서 새 영수증을 발급한다.
- 캐시/영수증의 재사용 키는 `(workId, workflowId 또는 runId, validationEpoch, sourceHead, planSourceHash, contractHash, artifactHash, validatorVersion)`다. epoch는 명시 재검사와 stale 판정 때 갱신하는 영속 식별자다. 이전 epoch의 응답·영수증·승인은 같은 해시로 돌아와도 재사용하지 않는다. 모델 요청 fingerprint에도 epoch/검사 시도를 결정적으로 포함해 잘못된 이전 답변이 반복 적중하지 않게 한다. 시간/난수로 매 resume마다 새 요청을 만들지는 않는다.
- 장 영수증 발급처는 `workflow.js`, 수동 `check.js`, `sync.js` 세 곳이다. 신규 언어 계약 경로의 `commit.js`는 **영수증 소비만** 하며 모델 호출·요약 생성·delta 보충을 하지 않는다. 영수증 부재는 `MISSING_VALIDATION_RECEIPT`로 즉시 거부하고 수동 사용자는 `lore_check` 경유를 안내한다. 수동 check는 제목/요약의 입력도 받아 검증하고, 누락 요약이나 의미 delta는 이 단계에서 생성·검증한 뒤 완전한 산출물 묶음을 영수증에 결합한다. commit 인자는 그 묶음과 일치해야 한다. workflow에서 influence observation 등을 보충할 경우에도 영수증 발급 이전에 끝내며 발급 뒤 변경은 재검사한다. 소비처인 commit/workflow 승인/sync apply가 동일한 공통 검증기를 사용한다. 공개 엔진의 신규 계약 경로도 유효한 영수증을 요구하고, 기존 언어 없는 수동 API의 호환 경로는 별도 테스트로 유지한다.
- `retryValidation:true`는 일반 stale bypass가 아니다. 계약/원천이 그대로인 경우의 정상 재검사와, **프로필이 바뀐 경우**의 재결합을 구분한다. 후자는 승인된 프로필 변경이 **allowedLanguageExceptions와 그 승인 메타데이터만** 바꿨고 locale/본문/기타 계약·계획/Published HEAD/작업 폴더가 일치할 때에 한해, 실패한 동일 원고를 새 예외 계약에 명시적으로 재결합한다. 새 epoch·planSourceHash·contractHash를 만들고 이전 판정/승인은 무효화한다. 그 외 drift는 기존대로 차단한다. 새 영수증과 다음 발행에는 이 승인 프로필 snapshot을 포함하며 Published HEAD의 오래된 프로필로 되돌려 저장하지 않는다. 이것이 인용 예외 추가 후 같은 원고를 재검사하는 유일한 자동 재결합 경로다.
- `profile/story/ writer/arc/episode`의 decide 승인과 `mode=auto` 활성화, foundation 최초 저장도 해당 산출물 묶음의 `languageCompliance=pass`와 유효한 revision/hash를 요구한다. 문체 선택의 사용자 승인은 이 검증을 대신하지 않는다. chapter의 guided/auto/manual 발행과 sync apply도 같은 공통 gate를 소비한다. 언어 검토는 한 번 판정한 **동일 묶음**에 재사용할 수 있지만 제목/요약/예시를 추가한 다른 묶음에 이전 본문 결과를 복사하지 않는다.
- 구형 발행 작품은 읽을 때 암묵적 ko를 적용하고 정본을 일괄 재작성하지 않는다. 언어 없는 구형 **진행 요청/영수증**은 동일 템플릿·원천을 증명할 수 있을 때만 호환시키며, 새 계약을 증명할 근거가 없으면 원고를 보존한 채 명시적으로 재검사한다. 이는 기존 발행 원고의 변경과 구별되는 업그레이드 동작이다.
- rollback/구형 snapshot 복원 뒤에도 Published HEAD와 편집 파일, 프로필, 핀의 정합성을 확인한다. 현재 snapshot 복원은 Published HEAD를 함께 복원하지 않으므로 자동으로 성공한 새 실행 원천이라고 간주하지 않는다. 불일치 시 재개를 막고 기존 복구 절차를 안내한다. 일반 rollback 재설계는 이번 범위 밖이다.

한국어 호환성은 작법 규칙·예시·분량 의미·기존 정본 형식과 hard/soft·guided/auto의 승인 원칙을 보존한다는 뜻이다. **새 계약으로 생성/변경하는 산출물의 언어 검증 추가까지 “동작 무변경”으로 약속하지 않는다.** 이 검증은 ko에도 적용하며 ko를 문자 비율/한국어 사전만으로 통과시키지 않는다. 이미 승인·발행된 구작 자료는 기존 근거로 존중하고 단지 업그레이드했다는 이유로 언어 검토를 소급 호출하지 않는다. 업그레이드 후 새 workflow/새 프로필 revision 등 새 계약으로 만드는 값에는 검증을 적용하므로 provider 호출과 오류 상태가 추가될 수 있다. 변경 안내와 요청 캡처 테스트에서 이 차이를 명시한다. 별도 언어 검토는 기존 semantic 요청에 합칠 수 없을 때만 승인 산출물 묶음별 최대 한 요청을 추가하며, 재시도는 공통 3회 상한 안이다.

## 구현 업무 배분과 순서

| 단계 | 담당 | 소유 범위와 산출물 | 진입/종료 조건 |
|---|---|---|---|
| 0. 계약 고정 | Codex | 이 설계 검토, 동작/호환성/파일 경계 확정 | 실제 모델 검토 결과를 코드와 대조해 채택/기각 |
| 1. 언어 연결 | Claude | MCP schema·dispatch, `init/generate/story-profile`, markdown store, language-policy | 구작 ko 해석/정본 형식 보존 + 요청→저장→draft→resume 언어 연결 |
| 2A. 프롬프트 분리 | Claude | engine prompts/steps와 plugin profile/arc/episode/summary/critic의 자연어 메시지 | live 경로 전체에 두 계열 적용, 목표 언어 값과 기계 스키마 분리 |
| 2B. 검사 대응 | Grok | continuity scans, lexicons, webnovel-format의 순수 판정, 분량 측정, coverage와 fixture | 1의 계약을 받은 뒤 2A와 병렬 수행. policy/receipt/프로필 파일은 수정하지 않음 |
| 3. 워크플로 통합 | Claude, Codex 검수 | `workflow/check/quality-policy/commit/sync/relay-runner`, 영수증·요약·교정 경로 | Grok 판정을 정책에 매핑. 공유 파일은 이 단계에서 Claude 한 명만 수정 |
| 4. 교차 검증 | Grok·Claude, Codex 최종 판정 | 회귀 결과, 실제 생성 표본, 재개/오출력/실패 검사 | Grok은 Claude의 prompt/통합을, Claude는 Grok의 검사기를 검토. 자기 코드 검토를 독립 검증으로 보고하지 않음 |

3단계에는 호스트별 사용 안내와 story-discovery 인터뷰 지침의 언어 전달 규칙, `lore_configure`의 언어 표시도 포함한다. 이를 작업 언어 입력의 공식 진입점으로 연결한다.

Claude와 Grok은 같은 기준 커밋에서 시작하는 별도 작업 폴더를 사용한다. 공통 인터페이스가 확정되기 전에 서로 다른 언어 정책을 구현하지 않는다. Grok은 공유 파일 변경이 필요하면 패치 제안과 재현 테스트를 전달하며 Claude가 통합한다. Codex는 통합 결과·실패 사례·요청/출력 원문을 확인하고 재작업 여부를 판단한다. 구현 세부를 전부 직접 작성하는 역할은 맡지 않는다.

일정은 코드/테스트 범위가 확인된 후 확정한다. 우선 1→2A/2B→3의 작은 변경 묶음으로 나누고, 실제 다국어 표본의 통과 전에는 지원 완료로 발표하지 않는다.

## 완료 기준

| 사례 | 확인할 결과 |
|---|---|
| 언어 없는 기존 작품, `ko`, `ko-KR` | 한국어 작법·핵심 불변식·정본 형식·승인 원칙 유지. 새 계약 산출물에는 언어 검증을 추가하되 기존 승인 자료는 소급 검토하지 않음 |
| `en`, `en-US` | 영어 공통 계열 선택, 일반적인 대사+발화자 서술 허용, `Ann` 부분 문자열 오탐 방지 |
| `ja` | 일본어 본문·요약·검토 값, 인용 부호와 공백 없는 문장 처리, CJK 이름 보존 |
| `zh-Hant` | 번체 지시 보존, 이름/문자 체계 일관성, 짧은 이름 누락 관찰 |
| `es` | 목표 언어 값과 부호·대사 형식, 한국어 문체 강제 없음 |
| `ar` | RTL 텍스트 왕복과 Unicode 보존, Latin 스키마 키/ID 유지. 조판 품질은 별도 |
| 명시 언어 오류·혼합 지시 | 조용한 fallback/기존 작품 언어 변경 없음 |
| `needs_model → resume`, revise/rewrite/summary/critic | 동일한 언어 계약 유지, 다른 언어의 이전 응답·영수증 재사용 거부 |
| 외국어 인용·고유명 포함 | 전체 출력 오언어와 정당한 코드 전환 구분, 무조건 문자 비율 hard fail 금지 |
| 미지원 검사·critic 실패·정본 충돌 | coverage 정직한 표시, 기존 hard 수정/critic 실패 guided 전환 계약 유지 |
| 정본 저장→다시 읽기·사용자 손수정 | 언어/ID/설정/사용자 섹션 유지, sync·drift 검사 연결 |
| 외국어로 인터뷰에 명시적으로 답변 | 읽기 난도 등의 같은 질문이 한국어 패턴 미일치 때문에 반복되지 않음 |
| 표본 목록 밖 `fr` 또는 `th` | 새 프롬프트 팩 없이 공통 계열 진입, 언어별 사전 부재만으로 거부/가짜 통과 없음 |
| 프로필 ja → create es / 레거시 ko → write ja | 생성/발행 전 충돌 거부, 기존 승인·원고 보존 |
| 검토 후 요약 변경 / stale 이후 태그 원복 | artifact/contract hash 불일치 탐지, 기존 영수증·승인 부활 금지 |
| 출력 언어 fail/uncertain 또는 필수 검사 error | 자동·수동·sync 발행 모두 차단, critic 미완료만의 guided 강등과 구분 |
| 형식 버전 1/2·양쪽 소유 표제 중복 | 기존 정본 무변경 왕복, 신규 영문 구조 왕복, 중복 표제 오류·사용자 섹션 보존 |
| 프로필 ko → ja 재승인 → foundation / 미발행 foundation 뒤 프로필 손수정 | 최신 승인 언어로 생성, 생성 뒤에는 프로필 수정으로 언어 불변 규칙을 우회하지 못함 |
| 잘못된 모델 검토 응답 3회 / 명시 재검사 | clean_fail과 원고 보존, 자동 재시작 없음, 새 epoch로만 재검사 |
| 알려진 언어이나 words 분할 미지원 | 기본 graphemes로 작품 생성 가능, 명시 words 요청은 측정 문제만 보고하며 언어를 바꾸지 않음 |
| 신규 비ko 프로필 → create/write | format.length만 저장, 구형 chapterChars 기본 주입으로 충돌하지 않음 |
| ja 프로필/아크에 영어 설명만 생성 | decide 승인과 mode=auto 활성화 모두 거부, 해당 산출물만 재검증 |
| 비ko에서 ko 전용 POV detector skipped + semantic POV pass | 해당 POV 불변식 검증 완료. 다른 필수 검사는 별도로 모두 통과해야 함 |
| 비ko에서 ko 전용 POV detector skipped + semantic POV uncertain/error/응답 없음 | POV는 미검증, 통과 영수증·guided 승인·auto/manual/sync 발행 불가. critic 점수나 languageCompliance로 대신하지 않음 |
| v2 문서의 버전 삭제·표제 언어 변경 | 레거시로 오인하지 않고 계약/형식 오류, 설정·원문 보존 |
| 신규 계약 작품의 manual commit에 영수증 없음 | 모델 호출/발행 없이 MISSING_VALIDATION_RECEIPT, check에서 완전한 묶음 생성·검증 |
| 인용 예외만 새 승인 → retryValidation | 같은 원고를 새 epoch로 검증, 이전 승인 무효, 최신 예외 프로필로 발행. 다른 drift 동반 시 거부 |
| 언어/형식 버전 키 없는 구작을 save/sync/다음 화 발행 | 없던 frontmatter 키는 계속 없음, 실행 의미만 ko+format 1. 새 문서는 최초 저장 때 명시 |
| 계약/프로필 무변경 clean_fail → retryValidation | 새 epoch로 정상 재검사, 예외 추가가 선행 조건이 아님 |
| 새 계약 ko 프로필/아크/장 생성 | 언어 검증이 적용됨. 추가 요청은 묶음별 최대 하나이며 기존 승인 구작 읽기에는 추가 요청 없음 |

자동 검사는 현재 `npm run test:all` 회귀와 위 위험을 재현하는 의미 있는 테스트를 사용한다. 모델 표본은 같은 이야기 브리프를 언어별로 작성하여 **프로필→아크→초고→검사→교정→요약→다음 화**에서 언어가 유지되는지 확인한다. 기계 스키마는 자동 검증하고, 자연스러움과 장르 적합성은 요청·응답 원문을 읽어 판정한다. 단순히 프롬프트에 언어 코드가 포함됐다는 테스트만으로 완료하지 않는다.

## 실제 모델 검토와 Codex 판정

Claude CLI의 `claude-opus-5`가 기준 커밋의 파일을 직접 읽어 구조를 검토했다. Grok CLI의 `grok-4.6-build`는 별도로 선별한 코드 발췌를 받아 검사와 호환성을 검토했다. 모두 기획만 수행했다. Grok의 첫 호출은 긴 입력 처리 중 turn limit으로 종료되어, 근거를 줄여 다시 호출했고 두 번째 응답이 정상 완료됐다. 이 실패를 완료된 검토로 세지 않았다.

원본: [Claude 검토](research/multilingual-2026-09-09/claude-review.md), [Grok 검토](research/multilingual-2026-09-09/grok-review.md). 두 보고서는 모델 제안 원문이므로 아래 판정 및 본문 설계가 우선한다.

| 모델 제안/관찰 | Codex 판정 |
|---|---|
| Claude: 실제 draft builder와 부차적인 prompt 파일이 다르다 | 채택. import와 호출 경로를 직접 확인했다. 실제 요청 기준으로 작업한다. |
| 양쪽: 한국어 특화 검사·단위·저장 파서가 프롬프트 밖에도 있다 | 채택. 본문만 번역하는 범위로는 완료할 수 없다. |
| Grok: skipped를 clean/passed로 표시하면 안 된다 | 채택. 미지원 검사와 필수 불변식의 실제 검증 범위를 분리해 표시한다. |
| Claude: `ko-KR → ko`, `en-US → en`으로 저장 | 수정. 계열 선택에만 기본 언어를 쓰고 원래 정규화 태그는 보존한다. |
| Grok: `kr`를 무효 언어의 예로 사용 | 기각. 로컬 Intl에서 `kr`가 Kanuri로 식별되는 것을 확인했다. 문법·언어 식별·품질 범위를 구분한다. |
| Claude: profile 우선 + foundation fallback | 수정. 사람이 읽는 정본 language를 원천으로, 프로필 승인과 workflow pin은 버전이 연결된 계약으로 사용한다. 불일치 시 조용한 우선순위 대체는 하지 않는다. |
| Grok: `chapterChars` 필드로 글자와 단어를 다르게 해석 | 기각. 명시적인 분량 단위가 필요하다. |
| Grok: FORMAT_INVARIANTS 전체를 언어 독립으로 고정 | 기각. 영어 대사 오탐을 직접 재현했다. 한국어 계약은 유지하고 비한국어는 승인된 포맷에 해당하는 검사를 적용한다. |
| Claude: 한국어 시스템에 언어 directive를 붙이는 헬퍼 | 조건부. 라우터/조립기는 채택하지만, 다른 언어 경로는 실제 영어 기반 템플릿이어야 한다. 한국어 원문을 남기고 목표 언어 한 줄만 붙이는 구현은 반려한다. |
| Claude: MCP가 쓰지 않는 엔진 경로를 dead로 격리 | 기각. `engine/src/index.js`의 공개 export를 확인했다. API 삭제/폐기는 이번 다국어 범위를 벗어난다. |
| Claude: 정적 manifest와 live draft 범위 차이 | 채택하되 범위 한정. 정적 템플릿 버전과 동적 요청 fingerprint를 구분한다. 매 화 입력 전체를 정적 lock에 넣지 않는다. |
| Claude: ko/en만 검증 대상으로 삼기 | 수정. 핵심 회귀는 ko/en, 공통 계열 확인은 ja/zh-Hant/es/ar까지 실제 표본으로 수행한다. 임의 언어의 동일 품질을 보장하지 않는다. |
| Claude: 모든 언어 작업을 한 커밋에 묶고 진행 run 폐기 | 수정. 작은 변경 묶음으로 통합한다. 바뀐 요청/계약에 한해 재개 호환성을 검증하고 기존 기록을 직접 삭제하지 않는다. |

최종 판단: 두 프롬프트 계열이라는 방향을 채택한다. 구현 착수 순서는 **언어 계약 → 프롬프트/검사 병렬 작업 → 워크플로 통합 → 실제 언어 표본 검수**다. 현재는 기획서와 검토 원본만 추가했으며 구현 테스트는 아직 수행하지 않았다.
