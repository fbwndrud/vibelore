# 웹툰 실행 규약 — 호스트·연동 개발자용

## 장면 통합 제작 — 명시적 선택 경로

사용자가 러프 없이 장면 전체와 문자를 함께 생성하기로 선택하면 `lore_webtoon_scene`을 사용한다.
기존 컷별 작업은 자동 변경하지 않는다. 승인된 API 모델 선택과 인물·배경 참조를 재사용한다.
새 경로는 원작 문단 범위를 고정하고 **장면 각색·영어 연출 → 생성 전 검증 → 문자 포함 장면 이미지 → 실제 시각 검토**로 진행한다.
칸 수는 사용자가 `panelCount`를 정수(1~12) 또는 `"auto"`로 선택한다. 미선택이면 `needs_interview`(선택지 `4, 6, 8, 9, auto`)이며 모델·이미지 호출을 발급하지 않는다. `auto`는 `webtoon-scene-plan` 응답의 `panelCount`(정수 3~12)로 각색마다 다시 결정하며, 누락·범위 밖이면 `SCENE_PANEL_COUNT_UNRESOLVED`로 실패한다. 결정된 수는 `scene_panel_count_resolved` 이벤트에 기록되고 이후 renderBrief 길이·이미지 요청·관측 칸 수 검증에 그대로 쓰인다. `revise`는 auto 값을 초기화해 새 각색이 다시 고르게 한다. 정수 3 미만은 허용하지만 응답 `warnings`에 연속성 저하 경고를 실으며 차단하지 않는다. 시작 후 `panelCount`를 바꾸면 `SCENE_PANEL_COUNT_PINNED`이다(auto 작업은 `"auto"`만 허용). 칸 크기·배치·카메라는 이미지 모델에 맡긴다. 사건 단위는 컷 단위가 아니다.
원작의 사실과 불확실성을 구분하고, 원문 대사의 화자와 글자는 보존한다. 구조 검사는 원문 포함 여부와 근거 연결만 확인하며 의미 검토를 대신하지 않는다.

1. `action="start"`, 사용자 선택 `panelCount`, `sourceChapters`, 선택적 `sourceUnitIds`, 영어 `direction`, 기존 `references:[{id,path,hash,description}]`을 전달한다. 참조는 프로젝트 안에 있는 PNG/JPEG이며 description도 영어로 쓴다. 새 API 과금 선택을 이 도구에서 추정하지 않는다. 기존 활성 작업이 있으면 다른 제작 프로젝트를 사용한다.
2. `webtoon-scene-plan` 요청에 하나의 장면 브리프를 답한다. 이어 `webtoon-scene-preflight`에서 실제 원문과 브리프의 원작 충실성·공간/물리·시간 인과·정보 부담을 검토한다. 네 검사 뒤에 전달용 `renderBrief`를 만든다. 화풍 한 줄과 사용자 칸 수만큼의 짧은 순간 설명으로 줄이고, 정확한 대사는 textIds로 연결한다. 한 순간에 여러 연속 동작을 요구하지 않으며 생략해도 이해되는 이동·준비 과정은 덜어낸다. `drawability`는 이 최종 요청의 원작 충실성·사용자 방향·연속성·분량을 다시 판단한다. 과부하는 advisory로 넘기지 않고 생성 전에 막는다. 화풍 30단어·순간당 35단어 제한은 장황함을 제한할 뿐 의미 검토를 대신하지 않는다. 네 검사와 drawability가 통과하고 blocking finding이 없어야 이미지 요청이 발급된다. 실패하면 자동 재설계 예산(`autoRevisions`, 기본 2) 안에서 실패 근거를 feedback으로 삼아 같은 작업에서 다시 설계한다. 예산을 다 쓰면 `scene_preflight_blocked`이며 `action="revise"`와 feedback으로 이어간다.
3. `needs_scene_image.jobs`의 정확한 prompt·참조·모델·inputHash를 사용해 호스트가 API를 호출한다. 이미지 스킬의 기존 API 실행 지침을 따른다. 하나의 장면 이미지는 완성 작화와 원문 문자를 포함한다. 이미지 모델에는 짧은 renderBrief·대사·참조 역할만 보내며 사실 목록·중복 공간 설명·불확실성 목록·이전 오류 보고서는 보내지 않는다. 검토 근거는 별도 보존한다. 전달용 요청이 바뀌면 이전 이미지 반입 해시는 무효다. 러프, 컷별 작화, 별도 벡터 조판은 이 경로에서 생성하지 않는다.
4. `asset:{path,inputHash,provenance}`로 반입한다. `webtoon-scene-image-review`는 실제 그림과 모든 문구·화자·읽기 순서를 확인한다. 관측한 글자를 기록하고 미열람 검토를 통과시키지 않는다. 불합격이면 관측 결함(칸 수 차이, 원문과 다른 글자·화자, 연속성, blocking finding)을 feedback으로 만들어 자동 재설계 예산 안에서 다시 계획·검증·이미지 요청을 발급한다. 실패한 시도의 이미지·검토·feedback은 `attempts`에 남는다. 예산을 다 쓰면 `scene_needs_revision`으로 결과와 근거를 보여준다. 이미지 모델은 인용 문구 외의 글자·화자 이름표를 그리지 말고 참조 이미지의 글자를 따라 그리지 말라는 지시를 받는다. 재설계 때 생성 전 검증은 긍정형 강조만 만든다. `renderBrief.focusTextIds`는 특히 정확히 써야 할 문구 ID이며 서버가 정확한 원문을 다시 인용한다. `renderBrief.corrections`(최대 3줄, 줄당 20단어)는 원하는 결과만 서술한다. 이전 시도·틀린 결과·금지 표현(not, no, never, instead, previous, fix 등)은 거절한다. 틀린 형태를 이미지 모델에 다시 보여 주면 그쪽으로 끌리기 때문이다.
5. 조회는 기존 `lane="webtoon"`과 workflow ID를 사용한다. `completed`는 장면 검토 완료이며 소설 정본이나 기존 회차를 교체·발행한 뜻이 아니다. 결과는 `scene.html`, 원본 이미지, 계획 및 검토 JSON으로 보존한다. 글자는 래스터에 포함되므로 별도 편집 가능한 조판이라고 설명하지 않는다. 사용자가 컷 분리·부분 편집을 원하면 별도 후속 작업으로 처리한다.

`previousWorkflowId`를 지정하면 직전 장면의 실제 이미지·설계·검토 결과를 상속한다. 원문은 직전 구간 바로 다음 문단부터 시작해야 한다. 앞 장면에 수정 필요 판정이 있어도 그 기록을 보존한 채 이어갈 수 있으며, 실패를 승인으로 바꾸지 않는다. 실제 두 이미지를 비교한 인물·배경·동작 전환 근거와 관측 칸 수를 기록하고, 칸 수 불일치나 연속성 실패는 완료 처리를 막는다. 기존 저장 작업에 칸 수 모드를 소급 적용하지 않는다. 짧은 `renderBrief` 도입 전에 저장된 장면 작업은 다음 `revise`부터 새 요청 형식을 쓰며, 그때까지의 이미지 반입 영수증은 재사용하지 않는다.

기존의 아래 컷별·러프 승인 경로는 `lore_webtoon_plan/render/decide`로 계속 지원한다.

사용자 제작 안내는 [웹툰 만들기](../WEBTOON.md)에 있습니다. 이 문서는 MCP 요청에
응답하는 호스트와 연동 개발자를 위한 현재 실행 계약입니다. 오류·호환성 설명은
사용 가능한 제작 옵션을 뜻하지 않습니다.

기존 Vibelore 소설·세계관·인물을 세로형 웹툰으로 각색한다. 원작 판본을 고정하고,
방향 인터뷰 → 장면 선별·시나리오 → 기준 이미지 → 구도 러프와 사용자 승인 → 작화 →
조판·시각 검토 → 최종 승인을 별도 workflow로 관리한다. 시작은
`webtoon-discovery-interview` 스킬 또는 `lore_webtoon_plan`이다.

- 처음 제작: [필수 선택](#제작-전-필수-선택--작화문자판면), [시작과 인터뷰](#시작과-인터뷰), [제작 순서](#제작-순서).
- 실행·재개: [상태표](#상태에-따라-이어가기), [러프 승인과 병렬 작화](#구도-러프-승인과-병렬-작화), [수정과 재개](#수정과-재개).
- 출력: 세로형 SVG/HTML 마스터. 실제 이미지 생성은 호스트가 수행한다.

## 제작 전 필수 선택 — 작화·문자·판면

새 workflow는 `presentationVersion=1`을 저장한다. 첫 `needs_interview` 라운드는 **W04 작화, W15 문자 표현, W16 판면**의 미응답 항목이다. 세 가지가 모두 사용자의 `answered`로 확정되어야 나머지 인터뷰와 제작으로 진행한다. `mode="auto"`도 이 항목을 대신 선택하지 않는다. 이미 승인된 작품 프로필의 선택은 다음 회차에서 재사용한다. 기존 진행 중인 workflow에는 새 버전을 끼워 넣거나 다시 질문하지 않는다. 예전 프로필로 새 회차를 시작할 때는 아직 없는 W15/W16만 추가 확인한다.

- **W04 작화:** 선·명암·채색·비례·배경 밀도의 원하는 인상을 자유롭게 지정한다. 선택지의 미국 코믹스풍·일본 만화풍은 넓은 참고 이름이며 특정 품질이나 판면을 보장하지 않는다. 일본풍이라는 작화 이름을 페이지형 출력 선택으로 해석하지 않는다. 기존 기준 이미지와 컷 생성 요청에 이 방향을 전달한다.
- **W15 문자 표현:** `standard`(둥근 대사 풍선·짙은 독백 상자·설명 상자), `soft`(밝은 독백 상자), `minimal`(독백·설명 상자 없음, 가독성을 위한 흰 글자 외곽선) 중 선택한다. 모두 독백에는 꼬리를 붙이지 않는다. 직접 지정은 JSON 문자열 `{ "dialogue":"round|square", "thought":"dark|light|plain", "caption":"box|plain", "sfx":"contextual|plain|impact" }`의 네 필드로 받는다. contextual은 컷별 효과음 기본/강조 선택이며 나머지는 해당 표현을 고정한다. 임의 폰트·구름 풍선·곡선 꼬리는 아직 미지원이다. 지원하지 않는 요청을 기본안으로 조용히 바꾸지 않는다.
- **W16 판면:** `scroll`, `page-ltr`, `page-rtl`. 현재 생성·조판·출력까지 지원하는 것은 scroll이다. 페이지형은 선택과 읽기 방향을 보존하고 `needs_format_support`에서 제작을 보류한다. 사용자가 변경하기 전에는 세로형으로 진행하지 않는다.

반환된 `questions.options`를 사용자가 이해하는 이름으로 보여주고 답을 받아 `responses`에 선택값을 넣는다. 자유 서술은 `feedback`으로 전달해 원문 근거와 함께 지원 필드로 정리한다. 의미를 확정할 수 없거나 지원 범위를 벗어나면 사용자에게 확인한다. 선택은 계약과 `plan.presentation`에 고정하며 문자 디자인은 실제 조판에 적용한다. 디자인이 바뀌면 조판 검사 해시도 바뀌므로 이전 검토를 그대로 통과시키지 않는다. 그림 입력에는 문자 디자인을 넣지 않아 그 선택만으로 컷 이미지 입력 해시를 변경하지 않는다.

## 구도 러프 승인과 병렬 작화

새 회차는 `storyboardPolicyVersion=2`로 시작한다. 기준 이미지 승인 다음에 `lore_webtoon_render(continuityPlan={version:2,...}, feedback="구도 설계 방향")`을 설정한다. 설정이 없으면 `needs_continuity_plan`과 빈 jobs를 반환하며 본 작화 반입도 거절한다. v1로 내려 필수 승인을 우회할 수 없다. 이 정책 필드가 없는 기존 저장 작업은 종전 상태를 보존하며 자동 이관·재생성하지 않는다. 아래 ‘연속 장면 제작’의 v1 필드를 사용하되 모든 계획 컷을 읽기 순서대로 포함한다.

`각색·대본 승인 → 단순 구도 러프 → 컷별·연결 검토 → 사용자 러프 승인 → 의존성에 따른 작화 → 실제 그림 연결 검토 → 조판·look/final 승인`

1. **구도만 먼저 결정한다.** 장소 배치와 카메라를 구분하고 인물·괴수 수, 이동 방향, 접촉점, 전후 상태, 결정적 순간을 적는다. 한 러프 묶음은 연속된 최대 6컷이다. 긴 전투를 나눠도 바로 앞 `previousShotId`를 이어 경계를 검사한다. 첫 컷 이후 `reset`에는 실제 시간·장소 전환을 설명하는 `resetReason`이 필요하다. 단지 묶음이 바뀐 것을 새 장면으로 취급하지 않는다.
2. **러프는 완성 작화가 아니다.** `needs_continuity_roughs.jobs`로 번호·인물 식별용 실루엣·간단한 소품/바닥·이동 화살표·접점·대사 여백만 그린다. 세밀한 얼굴·의상·질감보다 동작과 읽기 순서가 목적이다. 반환된 실제 이미지를 `continuityRoughs`로 반입한다. 수정 job의 `feedback`도 전달한다. 독립된 러프 묶음은 최대 3개 동시 실행할 수 있다.
3. **읽힌 근거로 검토한다.** `roughReviewJobs`는 대상 묶음과 경계 이전 묶음의 실제 이미지 경로를 준다. 다른 러프가 생성 중이어도 필요한 그림이 준비된 묶음부터 검토한다. `continuityReviews(kind="rough")`의 기본 필드 외에 job의 `contextHash`, 모든 컷의 `observations:[{shotId,verdict,evidence}]`, 모든 이전 연결의 `transitions:[{from,to,verdict,evidence}]`가 필요하다. 이웃 러프가 바뀌면 해당 연결 검토도 갱신한다. `verdict`는 `clear|unclear|contradiction`; 모두 clear인 때만 passed=true다. 번호·실루엣·접점이 안 보이면 원작이나 지시문으로 상상해 통과시키지 않는다.
4. **사용자가 러프를 확인한다.** 모든 묶음의 검토가 통과하면 `storyboard.html`과 `approval.kind="storyboard"`를 반환한다. 회차 순서와 대사를 함께 보여주고 현재 approval ID로 승인받는다. 이 단계는 `mode="auto"`에서도 자동 승인하지 않는다. 수정은 `request_revision`, `revisionTarget:{kind:"storyboard",sceneIds:[...]}`, `feedback`으로 요청한다. sceneIds 생략 시 전체 러프를 다시 만든다. 선택하지 않은 유효한 묶음과 이전 파일은 보존한다. 대사·사건·컷 수 수정은 `kind="adaptation"`으로 돌아간다.
5. **승인 러프를 실제 작화 입력으로 사용한다.** `referenceImages`의 `role="storyboard"` 파일을 인물 기준과 함께 첨부하고 `continuityPrompt`를 함께 전달한다. `shotId`/`panelIndex`에 해당하는 한 컷만 완성하며 번호·화살표·다른 패널은 복사하지 않는다. 인물 외형은 캐릭터 참조, 구도·동선·접점은 러프가 기준이다. 완성 컷의 `kind="shot"` 검토에는 `composition:{verdict,evidence}`로 러프와의 일치 근거가 필요하다.

### 무엇을 병렬로 실행하는가

| 대상 | v2 실행 조건 | 보존하는 검토 |
| --- | --- | --- |
| 독립 러프 묶음 | 승인 대본·기준을 공유하고 최대 3개 동시 실행 | 묶음 내부와 경계, 전체 사용자 승인 |
| 액션의 새 구도 `cut` | 승인 러프 기준으로 실행. 앞 컷 완성 그림을 기다리거나 자동 첨부하지 않음 | 인과 상태는 전달하고 생성 후 실제 두 그림 비교 |
| 자세·소품이 이어지는 `continue` | 직전 완성 그림 검토 후 실행 | 앞 그림 실제 첨부와 러프 일치 |
| 명시적 `anchorShotId` | anchor 그림 검토 후 실행 | 지정 기준 이미지 첨부 |

`needs_images.jobs`의 준비된 작업만 호스트가 최대 3개 실행하고 완료 순서대로 반입한다. 서버는 준비 여부와 입력 해시를 관리하며 유료 API 작업자를 직접 실행하지 않는다. cut의 입력 해시는 첨부하지 않은 앞 컷의 완료 순서에 영향받지 않는다. continue/anchor는 여전히 순차 의존성이므로 선행 검토 전에 함께 생성하면 거절한다.

`continuity.transitions`는 인접한 **실제 완성 이미지 두 장**의 경로와 결합 해시를 준다. `continuityReviews:[{kind:"transition",id,hash,inspectedImages:true,passed,evidence}]`로 위치·시선·이동·접촉·결과의 연결을 검토한다. 준비되는 대로 확인할 수 있으며 미검토/실패 연결은 look/final로 넘어가지 못한다. 개별 컷 수정 시 실제 이미지 의존 컷만 다시 만들고, 양쪽 연결 검토는 새 이미지 해시에 맞춰 갱신한다. 무관한 cut 작화를 연쇄 재생성하지 않는다.

검토는 호스트의 실제 열람 보고이지 독립 평가나 미감 보증이 아니다. 기존 조판·합성본·최종 승인은 유지한다. 테스트는 승인 차단, 파일 변경 검출, 병렬 준비 작업, 순차 의존성, 국소 무효화와 연결 검토를 검증한다. 실측 API 시간·비용·최종 연출 품질은 별도 제작에서 측정한다. 러프와 사용자 확인이 추가되므로 첫 생성 시간이 항상 줄어든다고 보장하지 않는다. 줄이려는 비용은 불필요한 직렬 대기와 완성 작화 재작업이다.

## 작품 언어 계약과 통합 범위

다국어 작업본의 작품 언어와 호스트 대화 언어는 별개다. `src/core/webtoon-language.js`는 같은 설치본의 공유 `work-language.js`가 있으면 `resolveWorkLanguage`를 사용하고, 승인 언어·계약 해시·허용 인용 예외를 원작 스냅샷의 `languageContract`에 고정한다. 별도 저장소의 파일을 런타임에 찾아 쓰거나 웹툰 취향으로 작품 언어를 덮어쓰지 않는다. 공유 처리기가 없는 구버전에서는 언어 키 없는 기존 한국어 작품만 호환하며, 명시 언어가 있는 작품은 `WEBTOON_LANGUAGE_CONTRACT_UNAVAILABLE`로 막는다. 처리기의 충돌·손상 오류를 한국어 기본값으로 숨기지 않는다.

- 질문·선택지·권장안은 ko/영어 안내 두 계열이다. 호스트는 사용자의 대화 언어로 의미를 전달하되 W04/W15/W16 선택과 미지원 안내를 빠뜨리지 않는다. `standard`, `minimal`, `page-rtl` 같은 값은 번역하지 않는다. 작품 언어를 묻는 새 웹툰 기본값은 만들지 않는다.
- 생성과 단일/병렬 분할 검토 요청에 같은 언어 계약·목표 언어 지침을 전달한다. 영어 안내나 한국어 스키마 예시를 작품 대사로 복사하지 않는다. 회차 HTML은 계획의 작품 언어 태그를 보존하고 비한국어 독자 안내는 영어 계열을 사용한다.
- 계획 검증에서 실제 조판 대상 문자열의 glyph·shaping 지원을 확인한다. 실패하면 `plan_invalid`의 `WEBTOON_TEXT_RENDERING_UNSUPPORTED`에 컷/문자 인덱스와 원인을 남기고 기준 이미지 생성 전에 멈춘다. 간판·모니터의 `render="image"` 문자는 별도 이미지 검토 경로를 유지한다. 폰트 부족을 한국어 번역이나 이미지 속 대사로 우회하지 않는다.

이 배포본에는 공유 작품 언어 처리기가 없다. 현재 호환 경로는 언어 키 없는 기존 한국어 작품이며, 명시 언어를 가진 원작은 위 오류로 중단한다. 이것은 다국어 제작 기능의 제공을 뜻하지 않는다.

### 품질 회귀 방지

문자 스타일이 적용된 컷도 객체 동일성이 아닌 회차 순서로 분할한다. 구간의 대본·앞뒤 컷·이미지 경로·원문이 동일한 범위를 가리키는지 함께 검증한다. 기존 위임/미정 값과 동일한 명시 답변도 `answered`로 수락하며, 값이 바뀌지 않은 확인은 후속 선택을 불필요하게 다시 열지 않는다.

신규 정책은 실제 MCP stdio 경로에서 러프 설정→러프 검토→사용자 승인→작화→실제 이미지 연결 검토→최종 승인까지 검증한다. 구버전 회귀 테스트는 이름이 명시된 테스트 전용 legacy fixture로 저장 정책 필드가 없던 작업을 재현한다. 프로덕션에는 정책을 제거하는 옵션이 없다. 합성 fixture 검토는 시각 품질 평가로 보고하지 않는다.

## 대기·중복 처리 개선

새 워크플로의 `efficiencyVersion=1`은 품질 검사를 삭제하지 않고 실행·전달을 줄인다. 기존 회차의 저장 데이터와 승인 상태를 자동으로 변경하지 않는다.

- `lore_workflow_status(lane="webtoon")`는 기본 `detail="summary"`다. 반복되는 원작·전체 계획·참조 상세·전체 산출물 목록을 생략하며 현재 승인 ID, 실패/발견 사항, 진행 상태는 유지한다. 전체 자료는 `detail="full"` 또는 `lore_workflow_inspect`로 조회한다. 새 작업의 `needs_images`도 기본 요약이며 실행할 jobs의 실제 지시·참조·해시는 줄이지 않는다. `lore_webtoon_render(detail="full")`로 전체 응답을 요청할 수 있다.
- 독립 구간 검토는 최대 3개의 **서로 다른 request ID**를 같은 run에 발급한다. 각 요청은 기존 최대 6컷·앞뒤 문맥·공통 지침을 그대로 갖는다. 완료된 답부터 `lore_resume`에 제출할 수 있고, 일부 답만 받은 상태와 감사 이력은 저장된다. 재시작 후 완료 슬롯을 재호출하지 않는다. 초고는 직전 장면 의존성이 있어 순차 처리하며, 전체 흐름 검토도 구간 검토가 끝난 뒤 별도로 진행한다. 호스트가 실제 동시 실행하는지는 호스트의 실행 환경과 권한에 따른다.
- 합성본을 열 수 없다는 사실을 확인했다면 승인/모델 응답 대기가 없는 render 호출에 `reviewAccess={available:false,reason:"실제 제한 사유"}`를 전달한다. 기하·원화 검토를 통과로 꾸미지 않고 불가능한 합성본 검토 요청만 생략해 실패 영수증과 사용자 승인 대기로 내린다. 열람 여부가 미정이면 첫 구간을 먼저 검토한다. 그 응답이 전역 제한 `inspectionUnavailable={scope:"composite",reason:"..."}`를 보고하면 나머지 구간과 전체 통독 요청을 반복하지 않는다. 기존 발견은 보존한다. 일부 컷의 결함을 전역 열람 불가로 보고하면 안 된다.
- `reviewAccess.available=true`는 열람 가능성에 대한 호스트 보고일 뿐 실제 검토 완료나 보안 제한 우회 권한이 아니다. 실패 게이트의 수정 요청 뒤 열람 환경이 실제로 복구됐을 때 갱신하고 검토한다. 승인·미완료 상태는 자동으로 통과하지 않는다.
- 이미지 jobs는 `scheduling.strategy="ready-first"`와 최대 동시 실행 3을 안내한다. 독립 장면의 묶음 전체를 기다리지 말고 완료된 컷을 확인한 뒤 즉시 반입한다. `assets`와 동일 파일의 실제 검토인 `continuityReviews(kind="shot")`를 한 호출에 보낼 수 있다. 파일·입력 해시 확인 후 검토를 연결하므로 후속 컷이 즉시 열린다. 부모·자식 그림을 검토 전에 함께 생성하는 우회는 여전히 거절한다. 서버 자체가 유료 이미지 API를 호출하거나 작업자를 실행하지는 않는다.

각색 검토의 기존 질문에 **생략 뒤에도 질문→응답·지시 대상·화자의 사전 지식이 웹툰 자체로 읽히는지**를 추가했다. 새로운 검사 단계나 특정 표현 금지 규칙은 아니다. 의미 판단은 여전히 모델의 advisory이며 완전한 자동 검출을 보장하지 않는다.

## 문자 역할과 제작 경로

새 워크플로는 `textPolicyVersion=1`을 저장하고 같은 값의 계획을 요구한다. 기존 워크플로·승인판·원작 정본에는 자동 적용하지 않는다. 모델·실행 경로 선택과 profile/plan/references/look/final 승인 절차는 그대로다.

- `dialogue`: 실제 발화. 인물 ID를 보존하고 별도 말풍선으로 조판한다. 화면 밖 발화는 `delivery="offscreen"`으로 표시하며 꼬리 anchor는 소리가 오는 화면 가장자리다. 보이는 다른 인물의 입에 연결하지 않는다.
- `thought`: 특정 인물의 속생각. 화자 ID가 필요하다. 꼬리 없는 짙은 바탕·밝은 글자로 일반 설명과 구분한다.
- `caption`: 서술자 설명·시간 압축. `speaker="narrator"`. 단역의 직접 대사를 이름 붙인 캡션으로 대신하지 않는다.
- `sfx`: 소리의 발생점에 별도 조판한다. 기존 일반/강조 효과음과 충돌 검사를 유지한다.
- `ui`: 간판·안내판·모니터·문서 등 실제 사물의 글자. 새 정책에서는 `render="image"`, 정확한 `text`, 사물과 표면 위치를 설명하는 `surface`를 지정한다. 생성 요청·이미지 입력 해시에 포함하고 조판 상자는 만들지 않는다. 대사·독백·설명·효과음을 `render="image"`로 넘기면 거절한다.

주요 인물에 없는 단역은 해당 컷의 `voices: [{id, description, sourceIds}]`로 원작 근거를 연결한다. 주요 인물 ID나 narrator/system을 재정의할 수 없다. 대사는 이 voice ID를 화자로 참조하고, 화면 안 발화자만 생성 요청의 `visibleVoices`에 포함한다. 원작에서 해당 단역이 실제 등장하는지는 모델 검토 대상이며, source ID 검사만으로 의미를 보증하지 않는다.

조판 분석 시 사물 글자는 `textIndex, observedText, surfaceBounds:[x,y,w,h], confidence, reason`을 반환한다. 실제 이미지에서 읽힌 원문이 기대 문자열과 다르거나 확인할 수 없으면 `PHYSICAL_TEXT_MISMATCH` 등으로 차단한다. 이미지 해시와 바인딩된 검토이며, 이 entry에는 풍선 후보·꼬리를 받지 않는다. 해당 표면 영역은 다른 대사·효과음의 가림 검사에 자동 포함한다. 오류는 그림의 부분 편집/재생성으로 수정하고 재검토해야 한다. 설명 상자 추가로 덮어 통과시키지 않는다.

원문·역할·대상 사물은 계획 JSON과 승인 대본에 남으므로 그림에 포함해도 문구 관리가 사라지지 않는다. 이 검사는 호스트가 실제로 읽었다는 보고를 검증하는 구조이지 독립 OCR이나 이미지 모델의 정확도 보증이 아니다. 생성 요청은 단일·분할 각색, 부분·전체 검토에 같은 문자 지침을 전달한다. 기존 `ui`의 별도 상자 출력은 버전 없는 과거 계획에만 호환 유지한다.

새 문자 정책은 신규 제작에 적용한다. 기존 회차 후보·이미지·조판·승인 상태를 갱신하거나 새 회차를 자동으로 시작하지 않는다.

## 분할 제작

새 작업에 `lore_webtoon_plan(segmented=true)`를 지정하면 기존 도구와 승인 단계를 유지하면서 작업 크기를 제한한다. 기존 작업의 정책은 변경하지 않으며, `segmented`를 생략한 기존 호출은 종전 경로를 유지한다. 이 옵션은 모델 능력이나 품질을 보증하는 설정이 아니다.

- 전체 선별 후 `webtoon-plan-outline`에서 개별 컷 없는 회차 개요·장면별 목적·입장/퇴장 상태·원문 배정을 만든다.
- `webtoon-plan-part`가 장면별 1~6컷을 작성한다. 공통 지침·전체 지도·관련 원문·직전 장면 마지막 2컷을 받는다. 원문 배정, 컷 상한, 장면 ID, 대본 구조를 검사한 뒤 합친다. 전체 상한을 장면별 할당량으로 나누지 않는다.
- 대본/시각 검토는 시퀀스별 최대 6컷과 앞뒤 1컷을 함께 요청한다. 각 대상 컷의 `observations`와 인접 연결의 `transitions`에 `clear|unclear|contradiction` 및 실제 근거가 필요하다. ID 목록만 제출하면 완료되지 않는다.
- 마지막 전체 검토는 얇은 흐름 지도와 부분 finding을 받으며 반복·공개·감정 회수에 집중한다. 시각 검토에는 실제 원화 경로와 해당 조판, 합성본 경로가 제공된다. 실제로 못 본 것은 `inspectedImages=false`로 남긴다.
- 조판 분석도 같은 장면 묶음으로 나누며, 서버가 완성된 지도를 저장하고 다음 요청을 발급한다. 호스트가 여러 요청을 손으로 임의 조합할 필요가 없다.
- 공통 지침은 승인된 사용자 방향 전체 값과 계약/원작 해시를 유지한다. 전체 원작·누적 artifact 목록을 모든 검토 요청에 반복하지 않는다. 부분 작업은 관련 원문과 확정 설정을 받는다.
- 부분 검토 결과는 내용·인접 컷·그림/조판 바인딩에 묶인다. 그대로인 검토는 재사용하고 입력이 달라진 묶음 및 마지막 통독을 다시 요청한다. 명시적 수정 요청은 미완료 검토를 재시도할 수 있게 한다. 새 각색은 개요·부분 초고를 다시 만든다.

`segmented.reviews[].complete`는 증거 형식/범위와 보고된 열람 여부가 갖춰졌다는 뜻이며 미감이나 의미의 자동 합격 판정이 아니다. `unclear`와 `contradiction`은 advisory finding에 남기고, 부분 검토 미완료는 전체 완료로 덮어쓰지 못한다. 기존 사용자 승인과 소설 정본 보호 규칙을 유지한다. 검토는 호스트 자기보고이며 독립 독자 평가가 아니다.

현재 한 작품에 진행 중인 웹툰 작업 하나만 허용한다. 이전 회차가 미승인이라면 다음 회차 생성 요청으로 이를 자동 승인·종료하지 않는다. 기존 후보를 보존한 미채택 종료 또는 승인 진행은 사용자 결정이 필요하다.

## 연속 장면 제작 — v1 호환 동작

기존 승인 대본의 공간·촬영·동작 연결을 보완할 때 현재 look gate에 `request_revision`으로 답한 뒤 render의 `continuityPlan`을 설정한다. 소설·대사·사건 순서는 바꾸지 않는다. 설정은 해당 컷의 이전 작화를 보존하고 생성 연결을 해제한다. 시나리오나 컷 수 변경은 기존 adaptation 수정 경로다.

`continuityPlan={version:1,scenes:[{id,environmentId,layout,cameraAxis}],shots:[{shotId,sceneId,transition,previousShotId?,anchorShotId?,visibleCharacters?,background?,blocking,camera,before,after,change,decisiveMoment}]}`. `reset`은 새 장면, `continue`는 이전 그림까지 이어받는 연속 촬영, `cut`은 인과 상태만 이어받고 새 구도로 촬영하는 전환이다. `continue`와 `cut` 모두 앞쪽 같은 장소의 `previousShotId`와 실제 검토를 요구하지만, `cut`은 이전 이미지를 자동 첨부하지 않는다. 명시한 `anchorShotId`만 추가 시각 기준으로 붙는다. `visibleCharacters`는 승인된 등장인물 중 이번 화면에 필요한 인물만 선택한다(빈 배열은 인물 없는 삽입 컷). `background`는 `establish|partial|abstract`이며 abstract는 건축 배경 기준 이미지를 제외한다. `layout`은 실제 장소 배치, `cameraAxis`는 촬영 측면, `blocking`은 인물·괴수·소품 위치다. 화면 좌우와 세계 좌표를 혼동하지 않는다. 전투는 표정·접촉·회전·충격의 결정적 순간을 선택하고, 인물을 매 컷 배경처럼 세우지 않는다. 대화/식사는 좌석·시선·소품 연속성을 우선한다.

계획 재설정은 변경 장면과 그 종속 컷만 무효화한다. 장면 정의·컷 항목이 동일하고 현재 입력에 대한 러프 검토가 유효한 장면은 러프·작화·검토를 보존한다. 보존 러프의 입력 바인딩은 새 전체 계획으로 재결합한다. 이전 후보 파일은 지우지 않으며 변경 장면·피드백은 워크플로 이력에 남긴다. 같은 계획을 다시 보내는 것만으로 검토된 러프를 강제 교체하지 않는다.

`needs_continuity_roughs`의 jobs로 장면별 연속 러프를 만들고 `continuityRoughs:[{sceneId,inputHash,path,provenance}]`로 반입한다. 실제 원화를 읽은 뒤 `continuityReviews:[{kind:"rough",id:sceneId,hash,inspectedImages:true,passed,evidence}]`를 제출한다. 실패한 러프는 본 작화를 열지 않는다. 러프를 교체할 때는 계획을 다시 설정해 종속 작화까지 무효화한다.

러프 검토 뒤 `needs_images.jobs`에는 실행 가능한 컷만 나온다. `blockedJobs`는 미생성·미검토 앞 컷 의존성을 표시한다. 생성에는 기존 인물·공간 `referenceImages`와 추가 `previous-shot`·`scene-anchor` 파일을 실제 첨부한다. `continuityPrompt`도 기본 요청과 함께 전달한다. 경로를 프롬프트에 적는 것은 이미지 첨부가 아니다. continuity는 촬영/배치 보완이며 대본을 변경하지 않는다.

반입 후 `continuityReviews:[{kind:"shot",id:shotId,hash,inspectedImages:true,passed,evidence}]`로 실제 연속성을 검토해야 다음 컷이 열린다. 앞 컷을 수정하면 previous/anchor에 의존한 후속 컷도 해제하며, 파일·생성 입력 해시는 보존된 원본과 새 연결을 구분한다. 거절한 컷을 그대로 후속 참조로 사용하지 않는다. 장면별 생성은 병렬 가능하지만 같은 연결 안에서는 검토 후 순차 실행한다.

이 검토는 호스트 보고이지 독립 판정·사용자 승인·연출 품질 보증이 아니다. 기존 look/final gate와 조판 검토는 유지한다. 단계형 참조 연결은 현재 `continuityPlan`을 명시한 작업에 적용되며 구형 작업에 임의로 끼워 넣지 않는다.

모델만 변경하면서 승인된 인물·배경 기준을 유지하려면 `lore_webtoon_render(imageModel="gpt-image-2.5-flare", imageExecution="openai-api", preserveReferences=true)`로 제안하고 현재 `confirmImageChoice` ID에 사용자 답을 전달한다. 기존 기준의 디자인·실제 파일 해시·원 승인 이력·생성 모델은 보존한다. 새 컷 요청은 새 모델을 사용하며 참조마다 `provenance`와 `reuse` 감사 정보가 제공된다. 미승인 참조와 변경된 파일은 재사용할 수 없다. 기본값은 기존 동작처럼 모델별 참조 재구성이다. 모델 변경으로 갱신된 계획 승인은 여전히 필요하다.

이미지 모델·실행 경로는 사용자 확인 후 작품별로 기억한다. 서버의 기본 제안과 실제 계정 가용성은 별개이며, 실행 호스트가 선택 모델을 지원하는지 확인해야 한다.

## 원작 입력과 상속

기본 입력은 일반 텍스트 업로드가 아니라 **기존 Vibelore 작품 프로젝트**다. 새 세계관·캐릭터를 처음부터 만들거나 다른 이미지 공급자를 비교하는 단계는 기본 제작 흐름에 넣지 않는다. Vibelore는 원작·각색·연속성·승인을, 실행 호스트는 승인된 지시와 참조 이미지를 이용한 이미지 생성·수정을 맡는다. 실제 생성과 열람이 가능한 호스트에서만 이미지 제작을 진행한다.

| 기존 작품에서 상속할 것 | 웹툰용으로 추가할 것 | 처리 원칙 |
|---|---|---|
| `world/`의 세계 규칙·시대·기술·공간 설정 | 배경의 형태·색·재질·광원·공간 기준 이미지 | 확정 사실은 보존하고 묘사되지 않은 시각 요소만 보완 |
| `characters/`의 인물 ID·성격·관계·외형 | 얼굴·체형·의상·표정·포즈 기준 이미지 | 새 캐릭터가 아니라 같은 인물의 시각적 표현을 확정 |
| `chapters/`의 확정 원고 | 웹툰 회차 구성·시퀀스·컷·대사·스크롤 호흡 | 소설 화 수와 웹툰 화 수를 일대일로 고정하지 않음 |
| 승인 StoryProfile·작품 정체성·집필 의도 | 내면의 표정·행동·캡션 전환과 독자 경험 | 소설의 문장 규칙을 컷 수 규칙으로 기계적으로 옮기지 않음 |
| 해당 화 전후 StoryState·화별 계획 | 컷 시점의 의상·상처·소품·관계·독자 지식 | 미래 시점 상태를 과거 장면에 적용하지 않음 |

웹툰에서 추가한 디자인은 웹툰 설정으로 보관한다. 원작의 사실을 바꾸는 제안과 단순히 빈 시각 정보를 채우는 제안을 구분하고, 소설 정본에 자동으로 역반영하지 않는다. 원문·현재 구조화 데이터·시점별 상태가 충돌하면 임의로 하나를 선택하지 말고 동기화 또는 사용자 확인으로 해결한다.

### 인터뷰는 재창작이 아니라 시각화 방향 확인

먼저 ‘원작에서 이미 정해진 것 / 화면화를 위해 비어 있는 것 / 바꾸려면 승인이 필요한 것’을 정리해 보여준다. 인물의 이름·성격·관계와 세계 규칙을 다시 묻지 않는다. 원작에서 답을 찾을 수 없는 화풍, 외형의 세부, 표정 과장, 설명의 시각화, 각색 재량, 스크롤 속도, 수위, 승인 범위만 질문한다.

기존 14개 영역·8개 분기는 질문 누락을 막는 coverage다. 모든 항목을 매번 처음부터 물으라는 뜻이 아니다. 이미 답한 웹툰 선택은 재사용하고, 소설 설정으로 확정되는 사실은 상속 근거로 보여준다. 다만 ‘소설에서 확정된 사실’만으로 ‘웹툰 취향을 사용자가 승인했다’고 처리하지 않는다. 현재 응답의 `inherited`는 고정된 원작 설정과 사용자 추가 문서 원문을, 질문별 `inherited`는 관련 인물·세계 사실·문서 ID와 결정 경계를 제공한다. 호스트는 이를 읽어 실제 미정 시각 요소를 설명한다. 미정 여부를 의미적으로 판정하는 완전한 자동 검사기는 아니다.

### 제작 순서

1. 기존 작품과 원작 화 범위·판본을 고정하고 설정·원고·당시 상태를 읽는다.
2. 웹툰 차이점 인터뷰로 각색·시각화 방향을 승인한다.
3. 컷 계획 전에 주된 독자 경험과 장면의 강조·압축·생략·이월을 결정한다. 이 편집 후보를 바탕으로 별도 웹툰 시나리오와 글자가 있는 러프 콘티를 만든다. 컷 수와 필요한 인물·공간·소품은 그 결과로 산정한다.
4. 실행 가능한 승인 모델로 이번 회차의 주요 인물·반복 공간부터 기준 이미지 후보를 만들고 대표 장면에서 검토한다. 작품의 모든 캐릭터를 미리 전부 생성하지 않는다.
5. 전체 컷의 공간·카메라·전후 상태를 정하고 최대 6컷 단순 러프를 만든다. 실제 컷과 경계 연결을 검토한 뒤 사용자 storyboard 승인을 받는다.
6. 승인 러프·인물 기준·컷 상태를 실제 첨부해 준비된 jobs만 생성한다. cut은 새 구도로 병렬 생성하고 continue/anchor는 검토된 선행 그림을 기다린다. 상호작용은 같은 장면에 그리며 실제 인접 그림의 연결도 확인한다.
7. 컷 그림과 편집 가능한 대사·캡션을 조립하고 얼굴·연기·공간·문자·스크롤 흐름을 검토한다. 한 화 전체를 한 장으로 생성하는 방식은 기본으로 삼지 않는다.
8. 문제 있는 컷은 필요한 부분을 수정하고 최종본을 새로 승인한다. 다음 화는 승인된 기준 이미지를 재사용하고 시점 상태만 갱신한다.

기준 이미지에는 인물·장소 ID, 적용 시점·의상, 승인 판본과 이미지 해시를 연결한다. 컷 요청에는 원작 근거, 해당 인물·장소의 승인 참조, 구도·행동, 유지할 특징, 변경할 특징, 문자 여백을 담는다. 직전 생성물을 무조건 다음 컷의 정답으로 사용하지 않는다. 수정으로 달라진 얼굴이 연쇄적으로 기준이 되는 것을 막기 위해 승인된 참조로 돌아가 비교한다.

### Codex 이미지 생성과 플러그인의 연결

`실행 가능 여부 확인 → Vibelore의 needs_images → 호스트 이미지 생성·수정 → 실제 결과 확인 → 작품 폴더에 보존 → assets 반입 → 검토·승인`이 기본 경로다. 서버가 Codex 전용 도구를 직접 호출하는 것과 호스트 에이전트가 도구 사이를 연결하는 것은 다르다. 현재 서버는 요청서와 이미지 반입을 제공하며, 내장 도구 호출 자체는 Codex가 담당한다.

서버의 내장 경로는 `gpt-image-2` 정책에만 요청을 발급한다. 이는 서버의 지원 계약이며 현재 호스트가 실제로 어떤 모델을 실행하는지에 대한 관측 결과가 아니다. 호스트의 실제 기능과 반환 결과를 확인한다. 별도 과금 API나 다른 공급자로 조용히 바꾸지 않는다.


`lore_webtoon_plan.imageModel`은 새 작업의 요청 모델 후보를 지정한다. 저장된 선택이 없으면 기본 후보는 `gpt-image-2.5-sunburst`, 다른 명시 후보는 `gpt-image-2.5-flare` 또는 기존 `gpt-image-2`다. 같은 작품에 확인된 선택이 있으면 이를 재사용한다. 기존 저장 정책과 해시는 자동 변경하지 않는다.

컷 이미지가 없는 승인 계획에서 `lore_webtoon_render(imageModel, imageExecution)`로 모델·경로를 제안한다. `needs_image_choice`는 현재 choice ID와 비용·유지 범위를 반환하며 이미지를 생성하지 않는다. 사용자가 선택하면 `confirmImageChoice`와 원답 `feedback`으로 확정한다. 대본과 이전 참조 파일은 보존하고 계약·참조 연결·계획 검토와 승인 ID를 갱신한다. 선택은 같은 작품의 다음 컷·회차에도 유지하고 변경할 때만 다시 확인한다. 과거 W11의 과금 경로와 충돌하면 명시적 최신 선택을 적용하되 나머지 제작 제약을 지운 것은 아니다.

API 선택 시 생성 jobs의 `apiRequest.model`을 호스트가 실제 API에 지정한다. 기준 이미지는 generations, 참조가 있는 컷은 edits 경로다. 호스트는 이미지 생성 스킬의 번들 CLI로 실행한다. 현재 서버 자체는 API를 호출하지 않는다. `imageRuntime.available`은 요청 발급 가능 여부이며 키·계정 권한·결제 잔액을 검증한 결과가 아니다. 키는 호스트 실행 환경에서 확인하고 대화나 MCP 인자에 넣지 않는다. [API 이미지 생성 안내](https://developers.openai.com/api/docs/guides/image-generation)

2.5를 내장 경로로 확정하면 현재 도구에는 모델 ID 선택 인자가 없으므로 `needs_image_runtime`으로 대기한다. 실행 실패를 이유로 모델이나 유료 경로를 자동 대체하지 않는다. API 결과 반입에는 `provenance.kind=openai-api`, 선택한 `requestedModel`, 현재 `selectionId`가 필요하다. 이는 호스트 보고의 일관성 검사이지 실제 제공자에 대한 독립 증명이 아니다. `targetModel`과 관측 모델을 구분하고 반환되지 않은 snapshot·호출 ID를 만들지 않는다.

이미지는 실제 반환된 파일을 확인해 작품 폴더에 버전별로 보존하고 반입한다. 실패한 생성 요청을 완료 이미지로 기록하지 않는다. 대사·캡션은 기본적으로 그림과 분리해 편집하며 이미지에 구워 넣은 글자를 최종 문자 원본으로 삼지 않는다.

## 현재 제공 범위

- 16개 필수 영역과 답에 따라 열리는 8개 심층 분기. 부분 답변, 정정·의존 질문 재개, 전체 원답 보존.
- 기존 원작의 정확한 파일과 당시 StoryState를 고정. 최신 인물 mutable 상태는 과거 각색 입력에서 제외.
- 원작 대응표·시퀀스·정확한 대사·최소 visual bible을 모델에 요청하고 구조 검사 및 advisory 검토 후 승인.
- PNG/JPEG 반입, 편집 가능한 문자와 결합한 SVG 마스터·모바일 HTML 프리뷰, 시각 기준 및 최종 bytes 승인.
- 소설과 별도 workflow·publication. 정확한 run ID로 모델 작업을 재개하고 실패 기록을 보존.

### 장면 선별

새 작업은 방향 승인 후 `webtoon-editorial → webtoon-plan → webtoon-plan-review → plan 승인`으로 진행한다. 세 모델 단계는 모두 `needs_model`과 `lore_resume`을 사용한다. 별도의 사용자 승인 단계를 늘리지 않고 **선별안과 컷 계획을 같은 plan 승인에 묶는다.** W03은 주된 경험·보조 경험·덜어낼 경계를 질문한다. 저장된 기존 답을 임의로 새 취향으로 바꾸지 않는다.

`editorial.focus`는 주된 경험·보조 경험·포기할 것을, `beats`는 원작 단위를 묶은 비트의 expand/condense/omit/defer, 이유·독자 변화·시각 증거·맥락 보존을 담는다. 원작 전체를 이 지도에 대응시키되 생략 비트를 화면에 그릴 의무는 없다. 계획은 동일한 `editorial`과 `panelCountReason`, 컷별 `beatIds/purpose/readerDelta`를 포함한다. 기본 `maxShots=40`은 기존 제작 안전 상한이며 40컷을 채우라는 뜻이 아니다.

서버는 원작 단위 누락·중복, 제외 비트를 사용한 컷, 남기기로 한 비트의 컷 누락, 컷의 출처·비트 불일치, 선별안 바인딩 변경을 차단한다. 의미적으로 좋은 생략인지, 인과가 실제로 읽히는지, 정적에 감정이 있는지는 검토와 사용자 판단에 남는다. 컷 생성 요청에도 해당 비트·경험·컷 역할을 전달하고 이미지 입력 해시에 묶는다. 표현 목적이 바뀐 그림을 무조건 재사용하지 않는다.

`editorial.json/md` 후보는 버전별로 저장하고 승인 후 `webtoon/episodes/.../editorial.md`에 공개한다. `editorial_invalid`는 오류를 읽고 plan의 `retry=true`로 재시도한다. 기존 workflow에는 자동 마이그레이션을 강제하지 않는다. 현재 plan/look/final 승인 대기에서 각색을 다시 잡을 때만 아래 명시적 요청으로 새 선별 흐름을 활성화한다. source·계약·제작 상한은 고정되고, 이전 후보·승인 파일은 보존한다.

```js
lore_webtoon_decide({
  project: "/absolute/path/to/work", workId: "my-work", workflowId: "wt-...",
  approvalId: "현재 승인 ID", action: "request_revision",
  revisionTarget: { kind: "adaptation" },
  feedback: "이번 화의 핵심 경험과 덜어낼 장면, 반드시 남길 맥락"
})
```

이 요청은 조판만 수정하는 `lettering`과 다르다. 기존 시각 승인을 해제하고 새 계획 승인으로 돌아가며, 새 이미지를 자동 생성하지 않는다.

현재 서버는 이미지 모델·실행 경로의 사용자 확인과 작품별 유지, 요청·PNG/JPEG 반입·조판 계산과 검토·승인을 관리한다. 서버가 유료 이미지 API를 직접 호출하거나 비용을 차감하지 않는다. `needs_images`는 생성 요청서이며 생성 완료를 뜻하지 않는다. 제공 출력은 SVG/HTML이며 플랫폼용 PNG/JPEG 분할은 제공하지 않는다.

## 시작과 인터뷰

```js
lore_webtoon_plan({
  project: "/absolute/path/to/work", workId: "my-work",
  sourceChapters: [1, 2], episode: 1, maxShots: 40, mode: "review", segmented: true
})
```

`sourceChapters`는 기존 원작 화 번호다. `episode`는 만들 웹툰 화 번호이며 여러 원작 화를 하나로 합칠 수 있다. 한 workflow는 한 웹툰 회차를 다룬다. 론칭 여러 화의 일괄 실행은 아직 제공하지 않는다. 원작 publication이 있으면 먼저 동기화되어 있어야 하고, publication이 없는 원고는 `manuscript_snapshot`으로 표시된다.

`needs_interview`가 반환한 질문 라운드를 사용자에게 보여준다. 답변은 같은 workflow에 전달한다.

```js
lore_webtoon_plan({
  project: "/absolute/path/to/work", workId: "my-work", workflowId: "wt-...",
  responses: { W01: "처음 읽는 독자에게 보여줄 한 화의 맛보기", W02: "사건과 관계는 유지하고 설명은 압축" }
})
```

질문 ID별 `responses`는 원답을 그대로 저장한다. 자연어로 여러 결정을 답했다면 `feedback`으로 전달하면 모델이 원문 근거를 붙여 정리한다. 모델이 빈 질문 목록을 반환해도 결정 coverage가 비어 있으면 완료되지 않는다. `mode="auto"`는 웹툰 선택 위임에만 명시적으로 사용한다.

## 상태에 따라 이어가기

| 상태 | 다음 동작 |
|---|---|
| `needs_interview` | 사용자에게 현재 questions를 보여주고 responses/feedback으로 재개 |
| `needs_model` | 모델이 request를 읽고 `lore_resume`에 답함. 빈 답변은 대기를 유지 |
| `awaiting_approval` | profile/plan/references/storyboard/look/final 중 현재 `approval.kind`의 실제 산출물을 보여주고 decide |
| `needs_format_support` | 페이지형 선택을 보존하고 미지원 안내. 사용자가 W16을 변경하기 전 생성하지 않음 |
| `plan_invalid` | hard 오류와 원문을 확인하고 `retry=true`로 수정 생성. 최대 3회 재시도 |
| `model_failed` | failure를 확인하고 `retry=true`. 같은 사용자 원답과 source를 보존 |
| `layout_blocked` | lettering.issues와 nextAction을 읽고 render에 조판 대상 컷·feedback을 지정. 그림을 자동 재생성하지 않음 |
| `plan_accepted` | `lore_webtoon_render(quality="preview")`로 시작. 미승인 기준이 있으면 기준 요청부터 반환 |
| `needs_reference_images` | 기준 이미지를 생성·검토하고 references로 반입한 뒤 references 승인 |
| `needs_continuity_plan` | 전체 컷의 version=2 공간·구도·전후 상태를 continuityPlan과 feedback으로 제출 |
| `needs_continuity_roughs` | 현재 러프 jobs만 생성하고 continuityRoughs로 반입 |
| `needs_continuity_review` | roughReviewJobs 또는 continuity의 실제 이미지·인접 연결을 확인하고 현재 해시로 검토 제출 |
| `needs_image_choice` | 모델·내장/API·비용·작품 내 유지 범위를 보여주고 현재 confirmImageChoice ID와 사용자 원답 feedback으로 확정 |
| `needs_image_runtime` | 요청 모델을 선택할 수 있는 호스트 경로 확인. 별도 과금은 사용자 선택 후 연결하며 현재 jobs는 실행하지 않음 |
| `needs_images` | 실행 가능한 승인 모델로 그림을 생성·검토하고 프로젝트 내부 PNG/JPEG를 assets로 반입 |
| `look_accepted` | 모든 shot 그림을 반입한 뒤 `quality="final"`로 최종본 생성·검토 |
| `completed` | 로컬 승인판과 SVG/HTML 마스터 사용. 다음 회차는 `newWorkflow=true`로 시작 |

```js
lore_webtoon_decide({
  project: "/absolute/path/to/work", workId: "my-work", workflowId: "wt-...",
  approvalId: "wa-...", action: "approve"
})
```

승인은 현재의 한 gate에만 적용된다. `request_revision`은 feedback과 함께 해당 gate로 돌아간다. profile의 취향을 바꾸려면 `plan`에 해당 질문 ID의 새 답을 보낸다. `hold`는 승인 대기를 유지하고 `reject`는 작업을 종료한다.

## 이미지와 산출물

새 작업은 기준 이미지를 먼저 승인한다. 각 요청에서 받은 ID·`inputHash`를 그대로 돌려준다. 다음 예제의 해시는 자리표시자다.

```js
lore_webtoon_render({
  project: "/absolute/path/to/work", workId: "my-work", workflowId: "wt-...",
  quality: "references",
  references: [{ referenceId: "ref-character-...", inputHash: "요청의 실제 inputHash", path: "art/hero-v1.png", provenance: { kind: "codex-built-in" } }]
})
```

새 작업은 `references` 승인 후 구도 계획·러프 검토·사용자 storyboard 승인을 거친다. 이후 `needs_images.jobs`에 컷별 승인 러프·참조의 실제 경로·해시·역할과 생성 프롬프트가 포함된다. 기준과 컷을 한 번에 반입해 승인을 우회할 수 없다.

```js
lore_webtoon_render({
  project: "/absolute/path/to/work", workId: "my-work", workflowId: "wt-...",
  quality: "preview",
  assets: [{ shotId: "shot-1", inputHash: "요청의 실제 inputHash", path: "art/shot-1.png", provenance: { kind: "codex-built-in" } }]
})
```

새 러프 정책에서는 전체 컷 작화와 필요한 실제 연결 검토를 마친 뒤 look 단계로 간다. 구형 작업의 시각 샘플 최소치는 두 shot(한 컷 계획이면 한 shot)이며 최종본은 모든 shot이 필요하다. 반입 그림은 bytes와 해시를 저장하므로 원본 경로가 바뀌어도 승인 이미지를 보존한다. 파일당 20MiB, 기준 이미지와 회차 그림 합계 약 60MiB를 허용한다. 기준 이미지를 바꾸면 해당 참조를 쓰는 컷의 재사용을 해제하고 기준·러프·프리뷰의 현재 바인딩을 다시 검토한다. 시각 검토 실패는 기준 이미지 단계에서도 자동 승인하지 않는다.

선택 컷은 `quality="preview", regenerateShotIds=["shot-1"], feedback="시선을 문손잡이로 옮긴다"`로 수정 요청한다. 승인 대기 중이라면 먼저 현재 gate에 `request_revision`으로 답한다. 새 job의 `kind="edit"`, `editTarget`, `referenceImages`와 `inputHash`를 사용한다. 원본 그림은 편집 입력으로 보존하며 수정 전의 늦은 생성 응답은 반입하지 않는다. 완결 작업은 새 workflow에서 다시 계획한다.

이 연결 이전에 저장되어 `imagePolicy`가 없는 구형 workflow는 기존 반입 방식으로 재개한다. 새 연결의 기준 이미지 승인을 사용하려면 기존 작업을 끝내거나 거절하고 `newWorkflow=true`로 시작한다. 저장된 승인을 조용히 새로운 계약으로 바꾸지 않는다.

후보는 `.vibelore/webtoon/candidates/`에, 승인 profile과 시나리오·최종 마스터는 `webtoon/`에 저장한다. 모델 요청·응답은 기존 model-exchanges 감사 기록과 연결된다. 웹툰 publication은 `.vibelore/webtoon-publication/`에 있으며 소설 HEAD를 움직이지 않는다. 생성 시점의 hash와 실제 파일이 다르면 최종 승인하지 못한다.

## 수정과 재개

### 조판 v2 — 그림을 다시 그리지 않는 수정

새 workflow는 v2를 사용한다. 구형 workflow는 명시적인 조판 수정 요청 시 v2로 전환하고 기존 look 승인을 해제한다. 소설 정본, 승인 대사, 그림 bytes와 참조 바인딩은 유지한다.

`실제 컷 분석(needs_model) → 후보 배치 계산 → 기하 검사 → SVG/HTML 생성 → 실제 합성본 검토(needs_model) → look 승인`으로 진행한다. 지도는 원본 이미지 정규화 좌표, 화자 입/소리 원인 anchor, 보호 사각형, 후보 중심, 확신·근거를 담는다. 그림·텍스트·높이·폰트 해시가 달라지면 기존 지도를 재사용하지 않는다.

승인 대기 중에는 현재 gate에 요청한다.

```js
lore_webtoon_decide({
  project: "/absolute/path/to/work", workId: "my-work", workflowId: "wt-...",
  approvalId: "현재 look 또는 final 승인 ID", action: "request_revision",
  revisionTarget: { kind: "lettering", shotIds: ["shot-32"] },
  feedback: "오른쪽 인물의 첫 발화가 먼저 읽히도록 하고 얼굴을 가리지 않게"
})
```

이미 look 승인했거나 `layout_blocked`라면 `lore_webtoon_render`에 같은 `revisionTarget`·`feedback`과 `quality="preview"`를 보낸다. 이 경로에 assets·references·regenerateShotIds를 섞지 않는다. 대사 문구 변경은 계획 수정, 그림 변경은 regenerateShotIds 경로이며 조판 수정과 구분한다. 조판 모델 실행이 실패한 `model_failed`는 **render의 retry=true**로 재시도한다. plan의 retry로 각색을 다시 시작하지 않는다.

- `lettering.json`: 원문·폰트 해시·분석 지도·최대 3개 후보·선택 ID·검사 영수증. 글꼴은 번들 Gowun Dodum(SIL OFL 1.1), 실제 advance와 glyph bounds를 읽고 SVG 글자는 윤곽 경로로 출력해 대체 폰트 오차를 없앤다. 문자열은 JSON에 보존하며 SVG 텍스트 노드를 직접 고치는 방식은 아니다.
- `lettered-samples.html`: 실제 작화가 있는 컷만 모은 현재 선택 조판. `lettering-options.html`과 컷별 후보 SVG는 비교용이다. 후보 선택을 바꾸려면 컷·후보 번호를 feedback으로 지정하고 재검토한다. 이전 후보 데이터도 모델에 전달되며 후보 ID를 직접 승인하는 API는 아니다.
- `lettering.technicalStatus`, `reviewStatus`, `approvalStatus`: 기하 검사, 호스트 검토, 최종 사용자 승인을 구분한다. `planned/images/checked`로 부분 샘플과 전체 회차를 구분한다. 검토 completed는 독립성이나 미감 통과 보증이 아니다.
- 승인 시 조판/지도/폰트 바인딩과 실제 산출물 bytes를 다시 확인한다. 이전 승인 ID는 재사용하지 못한다. 최종 승인에는 모든 계획 컷의 실제 작화와 새 최종 검토가 필요하다.

효과음 지도 entry의 `sfxStyle`은 `plain`(기본 58px) 또는 `impact`(76px, 굵은 획·흰 외곽선)를 받는다. impact는 강한 타격음에 선택적으로 사용하며, 커진 글자와 외곽선도 회전·가림 검사를 거친다. 대사에는 이 옵션을 적용하지 않는다. 말풍선과 직선 꼬리의 접합부는 몸체 테두리에 마스크를 적용해 막힌 이음선을 제거한다. 이 개선은 대사 중심·크기·줄바꿈을 바꾸지 않으며 곡선 꼬리 생성 기능은 아니다.

현재 계산은 폰트 실측 줄바꿈, 대사 순서, 사각 보호 영역 회피, 풍선 간 겹침, 직선 꼬리의 충돌·최소 돌출, 효과음 회전 경계를 검사한다. 후보 탐색은 제한된 beam search이므로 최적해 증명이 아니다. 호스트가 잘못 지정한 얼굴·화자·효과음 원인을 기하 검사로 교정하지 못한다. 곡선 꼬리·임의 마스크·다중 폰트·복잡 문자 shaping·작화 전 문자 여백 예약의 구조화·장르별 효과음 스타일은 아직 미구현이다. 한국어 완성형과 지원 glyph만 처리하고 미지원 문자는 차단한다.

`lore_workflow_status`와 `lore_workflow_history`에 `lane="webtoon"`을 지정한다. `workflowId`를 주면 정확한 작업을 조회한다. 이 옵션을 생략하면 기존 소설 workflow를 조회한다. `includeModelExchanges=true`로 실제 입력과 응답도 확인할 수 있다.

`webtoon/` 손수정이 있으면 자동 덮어쓰기를 멈춘다. 수정 파일과 diff를 읽고 의도를 확인한 뒤 `lore_webtoon_plan(adoptEdits=true, feedback="수정 의도")`로 재검토한다. 새 계획이 승인될 때까지 이전 정본을 보존한다.

대사 수정 등으로 계획을 다시 만들 때도 그림 입력이 변하지 않은 shot은 재사용한다. source·행동·인물·의상·공간·시각 기준이 바뀐 shot은 다시 준비한다. 재사용해도 바뀐 최종 문자·조립 파일은 새로 검토·승인한다.

기존 계획의 원작 판본은 고정된다. 새 원작 HEAD는 upstream 변경으로 표시되지만 자동으로 새 판본에 갈아타지 않는다. 작업 중 scope를 조용히 바꾸는 요청은 거절한다. 서버는 작품당 활성 웹툰 작업 하나를 지원하며 동시 변경 요청은 `WEBTOON_BUSY`로 재시도를 안내한다.
