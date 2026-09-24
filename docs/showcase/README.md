# Showcase

정적 공개 뷰어. 빌드 도구 없이 GitHub Pages(소스: `main` 브랜치 `/docs`)로 그대로 서빙합니다.

| 경로 | 내용 |
|---|---|
| `index.html` | 작품 목록. |
| `verdict-live/` | 『판결 LIVE』(사이버렉카 스릴러) 1~3화. 허브(`index.html`), 리더(`read.html`, thundertrail 리더 복제), 제작 노트(`notes.html`: 기준 이미지·회차별 결과·결함 유형·연출 지시 변경·비용·한계), `data.json`, `img/`(장면 24장 + 기준 이미지 6장). 집필·각색 Claude Opus 5.5, 이미지 생성 Codex(gpt-image-2.5-sunburst). |
| `thundertrail/index.html` | 허브. 방문 목적별(읽기 / 제작 기록 / 워크플로 해설 / 비용·시간 / 모델 비교) 입구. 옛 `#epN/sN` 링크는 `read.html`로 넘김. |
| `thundertrail/read.html` | 『길 위의 번개』 리더. 웹툰·나란히·소설 보기. 기본은 읽기 전용이고 “제작 정보” 토글로 판정·근거·프롬프트를 켬. |
| `thundertrail/process.html` | 제작 기록. 회차별 소설·웹툰 단계의 중간 산출물과 AI 판단 근거, 떡밥·설정 추적 타임라인(심기 → 진전 → 회수), 설계 변경 기록. |
| `thundertrail/workflow.html` | 워크플로 해설. 소설 10단계·웹툰 6단계 각각의 역할, 입출력, 결정 주체, 존재 이유, 실측 평균, 예시 링크. |
| `thundertrail/cost.html` | 비용·시간. 예상 비용 계산기, 회차별 합계, 토큰 구성, 단계별 상세·평균, 이미지. 수치마다 실측/정가 환산/추정/기록 없음 표시. |
| `thundertrail/compare.html` | 호스트별 스코어카드(장면·칸·판정·차단 근거 귀속·각색 CLI 비용), 첫 장면 나란히, 장면별 히트맵, 결함 귀속, 직접 해보기. |
| `thundertrail/costs.json` | 비용·시간 페이지 데이터. 모델 호출별 토큰(새 입력·캐시 쓰기·캐시 읽기·출력·추론)·시간·금액과 회차×작업×단계 합계. |
| `thundertrail/process.json` | 제작 과정 페이지 데이터. 워크플로 이벤트, 화별 계획, 비평 기록, 수정 전후 원고, 검사 영수증, 장면 워크플로(사전 검증·재설계·소요 시간)와 영→한 번역(`ko`). |
| `thundertrail/data.json` | 리더·비교 페이지 데이터. 장면별 원문 단락, 계획(plan), 렌더 브리프, 시각 검토, 타이밍, 판정. |
| `thundertrail/img/` | 장면 이미지 55장(WebP, 1024×1536). 원본 PNG는 저장소 밖 제작 폴더에 보관. |

`verdict-live/data.json`은 `tmp/verdict-scene-opus/build-site.py`가 `tmp/verdict-scene-opus/`·`tmp/verdict-20260923-opus/`·`tmp/verdict-webtoon-opus/` 실행 기록에서 만듭니다. thundertrail의 `data.json`·`process.json`·`costs.json`은 저장소에 포함되지 않는 제작 실행 산출물(`tmp/scene-20260921/`·`tmp/scene-20260922/`·`tmp/scene-20260923-opus/`·`tmp/scene-20260923-gpt6/`·`tmp/novel-20260923-gpt6/`, `works/thundertrail/production-workspaces/`)에서 생성합니다. 수치는 모두 CLI·API 실행 기록에서 읽은 값이며, 검토 판정은 오케스트레이션 호스트의 자기검토입니다.

로컬 확인:

```bash
python3 -m http.server 8765 --directory docs/showcase/thundertrail
```
