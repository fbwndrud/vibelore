# 소설 집필 — vibelore

웹툰화 요청은 설치된 `webtoon-discovery-interview` 스킬을 읽고 `lore_webtoon_plan`으로 시작한다. 스킬이 자동 로드되지 않는 MCP 단독 연결이면 vibelore 설치 경로의 `skills/webtoon-discovery-interview/SKILL.md`를 읽는다. 작화·문자·판면 선택과 사용자 러프 승인, 모델·비용 확인을 거치며, 웹툰 조회에는 `lane="webtoon"`을 지정한다. 소설 정본과 웹툰 산출물을 분리한다.

이 저장소는 vibelore 소설 프로젝트입니다. `world/`, `characters/`, `chapters/` 는
사람이 읽고 고치는 마크다운이고, `.vibelore/` 는 건드리지 마세요.

소설을 이어 쓸 때는 `lore_write`를 사용합니다. `guided`는 검사 완료 원고를 사용자에게
보여준 뒤 `lore_decide`, `auto`는 필수 검토가 정상 완료되고 불변식 검사를 통과한 원고를 자동 커밋합니다. 검토 실패 시 같은 원고를 승인 대기로 보존합니다. `needs_model`이면
요청에 답해 `lore_resume`으로 이어갑니다. 화별 계획·초고·연속성·coherence·최대 3회
수정·검사 영수증·커밋의 순서를 저수준 도구로 우회하지 않습니다.

진행 상태는 `lore_workflow_status`, 감사 이력은 `lore_workflow_history`로 확인합니다.

hard 위반은 확정된 사실과의 충돌이므로 고친다. soft 위반은 문체 취향이 섞이므로
작가에게 물어본다. 검사기가 작가의 의도를 오해했다고 판단되면 그렇게 말하고
판단을 받는다 — 도구를 이기려고 본문을 망치지 않는다.

검토 요청의 `system`·`user`에 담긴 현재 원고를 읽고 근거를 확인한 뒤 요청 ID별로 답합니다. 단계 이름만으로 미리 만든 평가를 공급하지 않습니다. 같은 호스트의 검토는 자기검토로 보고하며, 전체 발견은 `lore_workflow_history`에 보존됩니다. 실제 요청·응답이 필요하면 `includeModelExchanges=true`로 조회합니다.
