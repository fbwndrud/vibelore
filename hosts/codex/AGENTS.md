# 소설 집필 — vibelore

웹툰화 요청은 설치된 `webtoon-discovery-interview` 스킬을 읽고 `lore_webtoon_scene`으로 시작한다. 스킬이 자동 로드되지 않는 MCP 단독 연결이면 vibelore 설치 경로의 `skills/webtoon-discovery-interview/SKILL.md`를 읽는다. 원작 범위·화풍·참조·칸 수·이미지 모델 확인을 거치며, 웹툰 조회에는 `lane="webtoon"`을 지정한다. `lore_webtoon_plan`은 deprecated이며 이미 시작된 컷별 작업을 마무리할 때만 쓴다. 소설 정본과 웹툰 산출물을 분리한다.

이 저장소는 vibelore 소설 프로젝트입니다. `world/`, `characters/`, `chapters/` 는
사람이 읽고 고치는 마크다운이고, `.vibelore/` 는 건드리지 마세요.

소설을 이어 쓸 때는 `lore_write`를 사용합니다. `guided`는 검사 완료 원고를 사용자에게
보여준 뒤 `lore_decide`, `auto`는 필수 검토가 정상 완료되고 불변식 검사를 통과한 원고를 자동 커밋합니다. 언어와 연속성은 필수 gate이며, 통과하지 못한 원고는 `auto`든 명시 승인이든 승인·발행하지 않습니다. 필수 gate 통과 뒤 critic만 실패하거나 불완전하면 같은 원고를 승인 대기로 보존합니다. `needs_model`이면
요청에 답해 `lore_resume`으로 이어갑니다. 화별 계획·초고·연속성·coherence·최대 3회
수정·검사 영수증·커밋의 순서를 저수준 도구로 우회하지 않습니다. 수정 3회를 소진하면 자동으로
다시 시작하지 않고, 같은 원고로 검증을 다시 돌릴 때만 `retryValidation=true`를 명시합니다.

## 작품 언어

사용자가 집필 언어를 밝히면 BCP 47 태그로 정규화해 `lore_profile`·`lore_init`·`lore_create`·`lore_write`의
선택 인자 `language`로 넘깁니다 — 일본어 → `ja`, 브라질 포르투갈어 → `pt-BR`, 번체 중국어 →
`zh-Hant`. 문자·지역 하위 태그는 보존합니다. 언어를 고르지 않았으면 인자를 생략해 이미
정해진 언어를 그대로 씁니다. 기본값 `ko`를 임의로 채워 넣지 않습니다.

대화 언어와 작품 언어는 별개입니다. 한국어로 대화하면서 다른 언어의 작품을 쓸 수 있습니다.
본문·제목·요약·설정·인물 설명과 계획·검토의 설명 값은 작품 언어로 쓰고, JSON 키·enum 값·ID·
경로·sentinel 태그는 번역하지 않습니다.

생성 전 언어 변경은 새 프로필 revision을 만들어 다시 승인받는 경로뿐입니다
(`LANGUAGE_CONTRACT_CONFLICT`). 이미 만들어진 작품의 언어는 바꿀 수 없으므로
(`WORK_LANGUAGE_IMMUTABLE`) 본문 언어를 덮어쓰지 말고 새 작품을 안내합니다.

진행 상태는 `lore_workflow_status`, 감사 이력은 `lore_workflow_history`로 확인합니다.

hard 위반은 확정된 사실과의 충돌이므로 고친다. soft 위반은 문체 취향이 섞이므로
작가에게 물어본다. 검사기가 작가의 의도를 오해했다고 판단되면 그렇게 말하고
판단을 받는다 — 도구를 이기려고 본문을 망치지 않는다.

한 `needs_model` 응답의 `requests`는 서로 독립이므로 병렬로(동시 CLI 실행) 답해도 되며, 모든 답을 한 번의 `lore_resume`에 함께 넘깁니다. 검토 요청의 `system`·`user`에 담긴 현재 원고를 읽고 근거를 확인한 뒤 요청 ID별로 답합니다. 단계 이름만으로 미리 만든 평가를 공급하지 않습니다. 같은 호스트의 검토는 자기검토로 보고하며, 전체 발견은 `lore_workflow_history`에 보존됩니다. 실제 요청·응답이 필요하면 `includeModelExchanges=true`로 조회합니다.
