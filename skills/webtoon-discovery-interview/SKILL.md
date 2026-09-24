---
name: webtoon-discovery-interview
description: Vibelore 소설·세계관·캐릭터를 웹툰으로 각색할 때 기존 설정을 상속하고 웹툰 표현의 차이만 인터뷰한다. `lore_webtoon_scene` 장면 통합 경로로 방향·참조·칸 수·이미지 모델을 정하고 생성 전 검증·시각 검토를 진행한다. 컷별 `lore_webtoon_plan` 경로는 deprecated이며 기존 작업 이어가기에만 쓴다. 다음 장면은 `previousWorkflowId`로 이어간다.
---

# 웹툰 발견 인터뷰

## 목적과 경로

새 웹툰 작업은 `lore_webtoon_scene`을 쓴다. 러프·컷별 작화 없이 장면 전체를 대사까지 한 장으로
생성하는 경로이며, 사용자와 함께 이 도구의 입력을 정하는 것이 이 인터뷰의 목적이다.

컷별 `lore_webtoon_plan`/`lore_webtoon_render`/`lore_webtoon_decide` 경로는 deprecated다.
새 작업 시작은 `WEBTOON_PANEL_PATH_DEPRECATED`로 거절된다. 이미 시작된 컷별 작업을 이어갈
때만 [부록: 컷별 경로 (deprecated)](#부록-컷별-경로-deprecated)를 따른다.

기능 개발 요청에는 이 흐름을 구현·검증하되 실제 작품의 인터뷰나 이미지 제작을 임의로 시작하지 않는다.

## 대화 언어와 작품 언어는 별개다

사용자와는 사용자의 대화 언어로 말한다. 웹툰 대사는 항상 작품 언어 원문이며 번역하지 않는다.
작품 언어는 `lore_status` 또는 StoryProfile의 `language`로 확인하며, 키가 없으면 ko다. 이미지
프롬프트에는 언어·문자 체계(ISO 15924)·읽기 방향이 자동으로 명시되므로 인터뷰에서 별도로
번역 지침을 만들지 않는다.

## 모을 입력과 순서

1. **원작 범위.** `sourceChapters`, 필요하면 `sourceUnitIds`. 읽은 범위만 지정한다.
2. **화풍과 연출 방향.** 사용자의 원답을 받아 영어 `direction`으로 옮긴다. 옮긴 영어 문장을
   사용자에게 보여주고 의도와 맞는지 확인받은 뒤에만 전달한다.
3. **참조 이미지.** 인물·배경 기준 이미지의 파일 경로와 영어 `description`. 필드명은 `hash`다
   (`inputHash`는 생성된 장면 이미지를 반입하는 `asset` 전용 필드이며 서로 다른 계약이다).
4. **`panelCount`.** 정수 1~12 또는 `"auto"`. 사용자가 고른다. 미선택이면
   `needs_interview`(선택지 `4, 6, 8, 9, auto`)이며, `auto`는 각색마다 AI가 3~12칸 중 새로
   고르고 3칸 미만은 응답 `warnings`의 연속성 경고로 보여준다.
5. **이미지 모델·실행 경로·비용.** 이 작품에 확정된 API 선택이 없으면 `action="start"` 호출이
   `needs_image_choice`를 반환한다(`imageChoice.id`, 모델·실행 경로·과금이 담긴
   `imageChoice.policy`, 안내문 `imageChoice.notice`). 이를 그대로 보여주고 사용자 원답을 받은
   뒤, 같은 `start` 인자에 `confirmImageChoice=imageChoice.id`와 `feedback=사용자 원답`을 추가해
   다시 호출하면 이 작품의 선택으로 확정된다. 표시된 기본값이나 무응답은 승인으로 처리하지 않는다.

세부 계약은 [기본 경로](../../docs/reference/WEBTOON_WORKFLOW.md#기본-경로-장면-통합-제작)를
따른다. `needs_model`(`webtoon-scene-plan`, `webtoon-scene-preflight`,
`webtoon-scene-image-review`)은 request의 system/user와 실제 근거를 읽고 `lore_resume`에
정확한 `runId`와 request ID별 JSON으로 답한다. 이는 모델 작업이며 사용자에게 할 질문과
구분한다. 조회는 `lore_workflow_status`/`history(lane="webtoon")`를 쓴다.

## 서버에 넘기는 라틴 문자 영어

`direction`과 참조 `description`은 라틴 문자 영어만 쓴다. 인물 이름은 로마자 표기나 ID로
쓴다. 인용할 대사를 연출 문장 안에 넣지 않는다 — 대사는 원문 그대로 별도 필드에서 참조되며
번역·의역하지 않는다.

## 이어지는 장면과 재개

이어지는 장면은 `previousWorkflowId`로 연결해 직전 장면의 실제 이미지·설계·검토 결과를
상속한다. 원문은 직전 구간 바로 다음 문단부터 시작해야 한다.

생성 전 검증이나 이미지 검토가 불합격이면 자동 재설계 예산(`autoRevisions`, start 전용,
0~3, 기본 2) 안에서 관측 결함을 feedback으로 삼아 서버가 다시 설계·검증·생성한다. 예산을
다 쓰면 `scene_preflight_blocked` 또는 `scene_needs_revision`이며 `action="revise"`와 사용자
feedback으로 이어간다.

`lore_workflow_status` 또는 `history`를 `lane="webtoon"`과 정확한 `workflowId`로 조회한다.
원작 drift는 `lore_sync`로 먼저 해결한다.

실행의 완료와 작품 품질의 검증을 구분한다. 자동 검토 실패는 사용자 검토로 내려오며, source·해시·
범위 검사를 통과한 결과만 사용자가 승인할 수 있다. 생성 품질·독자 반응·실제 비용은 측정한 범위만
보고한다.

## 부록: 컷별 경로 (deprecated)

아래는 이미 시작된 컷별 작업을 이어갈 때만 적용한다. 새 작업은 위 장면 경로를 쓴다.

`lore_webtoon_plan`으로 시작한다. 원작 프로젝트의 `project`와 `workId`를 사용하고, 읽은 원작
범위만 `sourceChapters`로 지정한다. 이미 승인된 소설 의도는 읽어서 재사용하며 웹툰의 새
취향으로 재해석하지 않는다.

### 질문과 답변

- 다국어 작품은 [작품 언어 계약과 통합 범위](../../docs/reference/WEBTOON_WORKFLOW.md#작품-언어-계약과-통합-범위)를 읽는다. 사용자 설명은 대화 언어로 전달하고 제작 문자는 `languageContract`의 원작 언어를 유지한다. 선택 값과 ID는 그대로 제출한다. 언어 계약 또는 글자 출력 미지원 오류는 지원 범위를 설명하고 멈추며 임의 번역으로 우회하지 않는다.
- 새 작업은 [작화·문자·판면 필수 선택](../../docs/reference/WEBTOON_WORKFLOW.md#제작-전-필수-선택--작화문자판면)을 읽고 W04/W15/W16부터 묻는다. 제공된 Ask 도구가 있으면 사용자용 이름과 차이를 보여주고 선택을 받는다. 작화와 판면을 별개로 묻고, 직접 지정도 허용한다. 페이지형의 미지원 상태를 선택 전에 알린다. 지원되지 않는 문자 디자인도 구현된 것처럼 약속하지 않는다.
- `inherited`와 질문별 `inherited.documentIds`의 원작 자료를 읽어 '확정 사실 / 미정 시각 요소 / 변경 시 승인 필요'를 먼저 구분한다. 현재 문서에 있는 미래 상태는 해당 화 원고·당시 상태와 대조한다. 인물 이름·성격·관계·세계 규칙을 다시 창작하지 않는다.
- `needs_interview`의 `questions` 전체가 현재 라운드다. 상속 사실을 바탕으로 아직 정하지 않은 표현만 번호·질문·권장안과 선택의 차이로 보여주고 답을 기다린다. 원작 사실은 웹툰 취향에 대한 사용자 답변을 대신하지 않는다. 질문을 소설 창작 도구에 전달하지 않는다.
- 답변은 같은 `workflowId`의 `lore_webtoon_plan`에 `responses: { 질문ID: 사용자 원답 }`으로 넘긴다. 여러 질문에 걸친 자연어 답은 `feedback`으로 넘겨 모델 정리를 거친다. 모델은 사용자 대신 취향을 선택하지 않는다.
- 권장안 선택 표시나 무응답은 답변이 아니다. `coverage`의 미결정이 남으면 같은 인터뷰를 계속한다. 정정은 해당 질문 ID의 새 답으로 전달한다.
- 시스템이 확인할 판본·기존 설정·도구 지원은 자료를 읽어서 파악한다. 각색 재량·선호·제작 한도는 사용자의 결정이다.
- 현재 웹툰에 '알아서/자동으로/묻지 말고'가 명시되면 `mode="auto"`를 사용할 수 있다. 소설 작성 때의 auto 지시를 웹툰에 확대하지 않는다. 이 모드는 기본 선택을 delegated로 기록하지만 새 작업의 작화·문자·판면은 사용자가 선택해야 한다. 같은 작품에서 이미 확정한 선택은 재사용한다.

### 방향과 각색 승인

`awaiting_approval`이면 `approval.kind`를 확인한다.

- `profile`: 원작에서 가져온 의도, 각색 범위·화풍·연기·문자·스크롤·표현 강도·독자·제작 제약·변경 정책을 `decisions`에서 요약해 보여준다. 사용자가 방향을 확인한 뒤에만 `lore_webtoon_decide(action="approve")`를 호출한다.
- `plan`: [장면 선별과 각색 검토](references/editorial-selection.md)를 읽고 주된 경험·살림/압축/생략/이월·맥락 보존부터 보여준다. 이어 실제 `plan`의 시퀀스와 대사, 컷 수가 나온 이유를 보여주고 `artifacts`의 `board.html`을 모바일 폭에서 확인한다. 승인 또는 같은 gate의 `request_revision`으로 이어간다.
- `references`: `references.html`과 실제 인물·공간 기준 이미지를 원작·승인 방향에 대조해 보여준다. 적용 의상·시점·사용 컷을 확인하고 현재 approval ID를 승인한다. 기준 승인 후에도 장면 샘플과 최종본은 별도로 검토한다.
- `storyboard`: 실제 `storyboard.html`의 구도 러프를 회차 순서로 보여주고 동선·접점·컷 연결·대사 공간을 확인받는다. 자동 모드에서도 현재 사용자 승인을 받은 뒤 본 작화로 진행한다. 구도 수정은 같은 gate의 `revisionTarget.kind="storyboard"`로 요청한다.
- `look`: 실제 반입 이미지와 글자가 있는 샘플을 열어 보고 화풍·인물·공간·말풍선이 의도에 맞는지 사용자에게 확인한다.
- `final`: 실제 최종 SVG/HTML을 전체 스크롤로 확인하고 현재 approval ID를 승인한다. 프리뷰 승인은 최종 승인을 대신하지 않는다.

수정할 취향 자체가 바뀌면 `lore_webtoon_plan`의 해당 질문 답을 갱신한다. 기존 계약 안에서 대사·순서·구도를 고칠 때는 현재 승인 gate에 `request_revision`과 구체적 `feedback`을 전달한다. 답변과 인물 선호는 해당 작품의 결정이며 전역 문체 금지 규칙으로 만들지 않는다.

### 모델 작업과 이미지 반입

- 새 회차는 기준 승인 후 [구도 러프 승인과 병렬 작화](../../docs/reference/WEBTOON_WORKFLOW.md#구도-러프-승인과-병렬-작화)를 읽고 `continuityPlan.version=2`를 설정한다. `needs_continuity_plan`이면 설정이 먼저 필요하며 `needs_continuity_roughs`와 `needs_continuity_review`도 이 절차를 따른다. 기존 작업의 버전과 이미지를 자동으로 교체하지 않는다.
- `needs_model`: request의 system/user와 실제 근거를 읽고 `lore_resume`에 정확한 `runId`와 request ID별 JSON을 전달한다. 이는 모델 작업이며 사용자에게 할 질문과 구분한다. 응답하지 않으면 작업은 대기한다.
- `webtoon-editorial`: [장면 선별과 각색 검토](references/editorial-selection.md)를 먼저 읽는다. 컷 계획보다 앞선 편집 후보이며, 상속한 독자 약속과 사용자 답을 근거로 장면을 고른다. 원작 대응표를 전 장면 작화 의무로 해석하지 않는다.
- 시각 critic은 `artifacts`의 실제 이미지·HTML을 열어 본 경우만 `inspectedImages=true`로 응답한다. 읽은 shot ID를 `coveredIds`에 넣고 실패·finding을 숨기지 않는다. 같은 호스트 검토를 독립 독자 평가라 부르지 않는다.
- `needs_image_choice`, `needs_image_runtime`, `needs_reference_images` 또는 `needs_images`: [Codex 이미지 실행 연결](references/codex-images.md)을 읽는다. 모델·내장/API 경로·비용 선택을 확인하고 같은 작품에서 재사용한다. 현재 `jobs`만 생성·수정·보존·반입한다. 기준 이미지는 `references`, 컷은 `assets`에 정확한 `inputHash`와 함께 넘긴다.
- `webtoon-layout-analyze`: 실제 요청의 이미지를 보고 화자 입·효과음 발생점·얼굴과 핵심 동작 보호 영역·배치 후보를 반환한다. 같은 이미지 해시의 이미 확인한 근거는 재사용할 수 있다. 낮은 확신은 그대로 기록한다. 서버가 실제 폰트 치수·가림·읽기 순서·꼬리 가시성을 계산하고, 의미와 미감은 합성본을 따로 검토한다.
- 말풍선·효과음 위치만 바꾸려면 [조판 v2 수정 흐름](../../docs/reference/WEBTOON_WORKFLOW.md#조판-v2--그림을-다시-그리지-않는-수정)을 읽고 `revisionTarget.kind="lettering"`과 대상 컷·feedback을 지정한다. `layout_blocked`는 사유를 확인해 후보를 재검토하는 상태이며 이미지 재생성 승인이 아니다.
- exporter는 SVG 마스터·HTML 프리뷰와 조판 JSON을 제공한다. v2 글자는 고정 폰트의 윤곽 경로이며 문자열 수정은 원본 계획과 조판 재계산으로 한다. 플랫폼용 PNG/JPEG 분할, 임의 폰트·곡선 꼬리·독립 독자 검증은 후속 범위다.

### 재개와 한계

`needs_format_support`이면 페이지형 선택을 그대로 보존하고 미지원 이유를 보고한다. 세로형 대체는 사용자가 W16을 변경한 경우에만 진행한다. 페이지 칸 배치·읽기 순서·넘김 연출·출력은 단순 프롬프트 변경으로 완료되지 않는다.

`lore_workflow_status` 또는 `history`를 `lane="webtoon"`과 정확한 `workflowId`로 조회한다. 원작 drift는 `lore_sync`로 먼저 해결한다. 웹툰 손수정은 diff와 피드백을 읽고 `adoptEdits=true`로 재검토한다. `.vibelore/`를 직접 고쳐 승인을 우회하지 않는다.

실행의 완료와 작품 품질의 검증을 구분한다. 자동 critic 실패는 사용자 검토로 내려오며, source/hash/범위 검사를 통과한 결과만 사용자가 승인할 수 있다. 생성 품질·독자 반응·실제 비용은 측정한 범위만 보고한다.
