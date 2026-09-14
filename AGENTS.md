# 소설 집필 — vibelore

`world/`, `characters/`, `chapters/`는 사람이 읽고 고치는 정본이며 `.vibelore/`는 직접 수정하지 않는다.

소설을 이어 쓸 때는 기본적으로 `lore_write`만 호출한다. `guided`는 검사 완료 원고와 advisory를 사용자에게 보여준 뒤 `lore_decide`, `auto`는 불변식 검사를 통과하고 critic이 정상 완료된 경우에만 자동 커밋한다. `needs_model`이면 요청에 답해 `lore_resume`으로 이어간다. 화별 계획·초고·결정론 검사·critic 검토 묶음·필요한 최소 수정·검사 영수증·커밋의 순서를 임의로 해체하지 않는다.

검토 모델 요청을 받으면 [검토 응답과 감사](docs/OPERATIONS.md#검토-응답과-감사)를 따른다. 실제 요청의 원고와 근거를 읽고 request ID에 답하며, 같은 호스트의 자기검토를 독립 독자 평가로 보고하지 않는다.

`soft`와 critic advisory는 자동 수정 이유가 아니다. `guided`에서는 원고와 근거를 보여주고, `auto`에서는 기록하되 커밋을 막지 않는다. critic이 실패한 auto 원고는 guided 승인으로 강등한다. 사용자가 수정을 원하면 `lore_decide(action="request_revision", feedback="...")`로 같은 workflow를 이어간다.

`lore_status`가 working-tree drift를 보고하면 집필을 계속하지 말고 `lore_sync`를 먼저 호출한다. 마지막 화 손수정은 `inspect → validate → apply` 승인 흐름을 사용한다. 이전 화 손수정은 재검사·재커밋 후 `lore_refold`, 세계·인물 변경은 계획 영향 검토가 필요하다.

새 작품 자동 설계는 `lore_create`, 초고 생성과 필요한 최소 수정은 통합 `lore_write`를 쓴다. `lore_draft`, `lore_revise`, `lore_rewrite`, `lore_refold`는 고급 MCP 표면의 디버깅·수동 복구 도구이며 일반 집필에서 직접 조합하지 않는다.

새 작품 또는 장르·톤이 아직 확정되지 않은 작품은 `story-discovery-interview` 스킬로 작품 발견 인터뷰를 먼저 진행한다. `lore_profile_status`를 확인하고 프로필이 없으면 인터뷰에서 정리한 자연어 브리프 전체를 `lore_profile`에 넘긴다. 일반 요청은 `mode="review"`로 결과를 사용자에게 보여주고 `lore_profile_decide(action="approve")`하며, “알아서/자동으로/묻지 말고”가 명시된 경우만 인터뷰를 생략하고 `mode="auto"`를 쓴다. 승인된 StoryProfile은 임의로 매 화 재해석하지 않는다.

`lore_profile(mode="review")`가 `designReview.openQuestions`를 반환하면 한 라운드의 질문을 모두 사용자에게 보여준다. 답변을 `feedback`으로 다시 넘겨 다음 라운드를 만들고, 열린 질문이 없거나 사용자가 현재 결정을 명시적으로 승인했을 때만 `lore_profile_decide(action="approve")`한다. 이 인터뷰는 작품별 독서 계약을 확정하는 용도이며 화별 세부 규칙을 늘리는 용도로 쓰지 않는다.

집필 요청을 받으면 `lore_arc_status`를 먼저 확인한다. 활성 아크가 없으면 본문부터 쓰지 않는다. 일반 요청은 `lore_arc_plan(mode="review")`로 3~20화의 아크 약속과 얇은 사건·압력·전환·다음 상태를 만든 뒤 사용자에게 보여주고 승인받는다. 사용자가 “알아서”, “자동으로”, “묻지 말고”라고 명시한 경우에만 `mode="auto"`를 쓴다.

활성 아크가 있으면 화별 얇은 계획은 `lore_write`가 자동 생성한다. 저수준 도구는 디버깅·수동 집필에만 사용하며, 활성 워크플로가 발급한 검사 영수증 없이 커밋을 우회하지 않는다. 진행 확인은 `lore_workflow_status`, 감사 이력은 `lore_workflow_history`를 쓴다.

hard 위반은 확정 사실과의 충돌이므로 고친다. soft 위반은 작가의 의도일 수 있으므로 임의로 문체를 훼손하지 말고 사용자에게 판단을 구한다. PatternLedger, 캐릭터 유연성, 밀도, ArcReview는 검증 전까지 관찰·advisory이며 정본 불변식으로 승격하지 않는다.
