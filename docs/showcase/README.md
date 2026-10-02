# Showcase

정적 공개 뷰어. 빌드 도구 없이 GitHub Pages(소스: `main` 브랜치 `/docs`)로 그대로 서빙합니다.

| 경로 | 내용 |
|---|---|
| `index.html` | 작품 목록. `works.json`을 읽어 최신작(가장 늦은 버전으로 끝난 작품)을 맨 위에 크게, 나머지를 세로 카드로 그린다. 형식·모델 필터, 정렬(버전·분량·제목), 카드/목록 전환. 필터 상태는 `?format=&model=&sort=&view=`로 주소에 남아 링크 하나로 같은 화면을 공유한다. 버전에 마우스를 올리면 실행 커밋. |
| `works.json` | 작품 목록·버전 연혁의 단일 원본. `versions`(버전·날짜·CHANGELOG 요약)와 `works`(제목·장르·분량·모델·`family`·`formats`·버전 범위 `from`/`to`와 실행 커밋 `detail`·연혁 막대 문구 `bar`·표지 `cover`와 썸네일 `thumb`·`thumbSq`). 새 작품은 여기에 항목 하나를 더하면 목록과 연혁에 함께 나온다. |
| `<작품>/thumb.webp`·`thumb-sq.webp` | 목록·버전 연혁·작품 띠·사전용 표지 썸네일(600px 폭 / 128px 정사각). `scripts/build-showcase-thumbs.py`가 `works.json`의 `cover` 원본에서 만든다. 표지를 바꾸면 다시 실행한다. |
| `versions.html` | 버전 연혁. `works.json`의 버전을 가로축으로, 작품을 만든 버전 범위만큼의 막대로 그린다. |
| `how/` | 만드는 방식. `index.html`(사용자·호스트·vibelore·작품 폴더와 한 번의 왕복), `novel.html`(소설 한 화의 일곱 단계), `webtoon.html`(웹툰 한 장면의 여섯 단계와 베스퍼 1화 장면 8의 시도 기록). 단계 설명은 현재 `src/tools/workflow.js`·`check-contract.js`·`webtoon-scene.js` 기준이고, 실측 칸은 `vesper/data.json`에서 읽는다. |
| `shared/` | 목록·연혁·만드는 방식 공통 `site.css`(색·머리글·바닥글), `how.css`(흐름도), `chrome.js`(머리글 메뉴와 `works.json` 읽기). |
| `shared/reader.js` | 작품 공통 리더. 각 작품 `read.html`이 `Reader.start({ work, store, imageHost, sceneCost })`로 연다. 소설 목록이 있는 작품(`chapters`)은 회차 선택과 `novel/NNN.txt` 본문을, 웹툰 회차만 있는 작품은 회차 탭과 장면 원문을 그린다. 웹툰·나란히·소설 보기, `#epN/sN` 딥링크, 제작 정보 토글, 모바일 원문 시트, 인물·설정 사전 연결을 한 코드로 처리한다. 데이터 형식은 아래 “리더 데이터”. |
| `shared/work.css`·`notes.css`·`worknav.js` | 작품 폴더 공통 스타일(리더·제작 노트)과 리더 메뉴. 작품 폴더에는 팔레트(`vesper.css` 등), 리더 메뉴 설정(`site.js`: `WorkNav({ title, pages })`), 작품별 제작 노트 스크립트(`notes.js`)만 남는다. |
| `shared/workpage.js`·`workpage.css` | 작품 페이지 공통 틀. `<body data-work data-tab>`과 `#work-band`로 테마 띠(이동 경로·이전/다음 작품·표지·제목·“1화부터 읽기”/“이어 읽기”·탭)를 그린다. 탭은 모든 작품이 개요 · 읽기 · 제작 노트 · 비용·데이터로 같고, 인물·설정과 `works.json`의 `tabs`가 뒤에 붙는다(제작 노트 경로는 `pages.notes`로 바꿀 수 있다). 작품 색은 띠에만 쓴다. `WorkPage.overview()`는 개요의 회차·아크·연출 실험·제작 정보를, `WorkPage.data()`는 비용·데이터 페이지를 채운다. “이어 읽기”는 리더가 남긴 `localStorage` `reader.last.<id>`. |
| `facts.json` | 작품별 제작 정보 8칸(vibelore · 설계·집필 · 웹툰 각색 · 이미지 · 그림 검토 · 분량 · 비용 · 소요 시간). `scripts/build-showcase-facts.py`가 `works.json` 버전과 각 작품 `data.json`(thundertrail은 `costs.json`)에서 제작 노트·비용 페이지와 같은 식으로 계산한다. 기록이 없으면 ‘기록 없음’, 추정이 섞이면 그렇게 적는다. |
| `<작품>/index.html`·`notes.html`·`data.html` | 작품 개요(소개·회차·연출 실험·제작 정보), 제작 노트, 비용·데이터(제작 정보 전체·다른 작품과 나란히·자세한 비용 링크·데이터 파일). |
| `lore.html` | 인물·설정 사전. `?work=<id>&ch=<n>`으로 고른 작품의 인물·장소·물건·비밀·예정된 일·떡밥·호칭표를 **고른 화까지만** 보여준다. 항목은 눌러야 펼쳐진다. 작품 목록은 `works.json`의 `lore` 필드에서 읽는다. |
| `shared/lore.js`·`lore.css` | 사전 카드 렌더와 리더 연결. 작품 리더(`read.html`)의 본문 도구줄(모바일은 아래 시트)에 “인물·설정” 켜기 버튼을 두고, 켜면 `lore.json`을 받아 본문 속 인물·장소 이름(장면 묶음마다 첫 번째)을 누를 수 있게 한다. N화를 읽는 중이면 N−1화까지를 보여주고 N화 변화는 접어 둔다. 기본은 꺼짐(`localStorage` `lore.on`). |
| `<작품>/lore.json` | 사전 데이터. `scripts/build-showcase-lore.py <id>`가 `works/<id>/characters/*.md`(인물·극적 모델·말투), `.vibelore/ledger/{seed.json,events.jsonl}`(화별 설정 원장, 베스퍼만), `.vibelore/entities.json`(원장 이전 작품의 설계 시드), `.vibelore/story-state/<N>.json`(떡밥·관계·호칭·아크 위치·인물이 아는 것)에서 화별 이력째로 만든다. 쇼케이스에 공개된 화까지만 담는다. |
| `plant-runaway/` | 『우리 집 화분이 가출했습니다』 소설 1~3화 + 웹툰 1~3화(10장면·80칸). 소설 Gemini 3.8 Flash(Antigravity CLI), 각색·검토 Codex, 장면 이미지 gpt-image-2.5-sunburst 요청. 수정 전 이미지·기준 이미지·검토 근거 공개. `scripts/export-plant-runaway-showcase.py --work <작품 폴더>`로 내보낸다. |
| `vesper/` | 『베스퍼』(롯데월드 야간 퍼레이드 캐릭터를 빌린 비공식 팬 창작, 인외 로맨틱 코미디) 소설 50화 완결 + 1화 장면 웹툰. vibelore 0.4.2(소설은 0.4.1에서 시작해 PR #9 수정을 반영하며 집필), 설계·집필·각색 Claude Opus 5.5, 이미지 OpenAI 이미지 API(gpt-image-2.5-sunburst). 개요·리더(아크별 회차 선택, 2화부터 소설 전용)·제작 노트(버전표·아크 심사·버그 수정·후반 식자·비용), `data.json`, `novel/NNN.txt`(정본 본문), 이미지(이미지 저장소 `vesper/img/`: 장면 9장 + 다른 시도·식자 전 원본 6장 + 기준 이미지 5장). 팔레트 `vesper.css`. |
| `i18n.js` | 모든 페이지 공통 한국어/영어 UI 사전과 토글. 기본 언어는 `navigator.language`, 선택은 `localStorage`(`vibelore.lang`)에 저장하고 `?lang=ko|en`으로 공유. 작품 본문·대사는 번역하지 않음. 새 UI 문자열은 한국어 원문을 키로 이 파일에 추가. |
| `multilingual/` | 8개 언어(ko·en·ja·zh-Hant·es·fr·ar·th) 소설 1화 발췌·사실과 장면 웹툰 한 장·판정. `data.json`, 이미지(이미지 저장소 `multilingual/img/`, WebP), `ml.js`·`ml.css`. 기본 웹툰 실행은 3207b83, 비교용 “프롬프트 수정 전” 52e5aee. |
| `verdict-live/` | 『판결 LIVE』(사이버렉카 스릴러) 1~3화. 개요(`index.html`), 리더(`read.html`, 공통 리더), 제작 노트(`notes.html`: 기준 이미지·회차별 결과·결함 유형·연출 지시 변경·비용·한계), `data.json`, 이미지(이미지 저장소 `verdict-live/img/`: 장면 24장 + 1화 재생성 이전 시도 4장 + 기준 이미지 6장). 1화는 자동 재설계 서버(vibelore PR #5)로 다시 만든 결과. 집필·각색 Claude Opus 5.5, 이미지 생성 Codex(gpt-image-2.5-sunburst). |
| `executionprincess/` | 『처형 1분 전의 황녀』(로판 회귀 복수극) 1~3화. 개요·리더·제작 노트는 verdict-live 구조를 따르고 팔레트만 `princess.css`. 이미지(이미지 저장소 `executionprincess/img/`: 장면 27장 + 기준 이미지 7장). 설계·집필·각색 GPT-6 Sol(OpenAI Responses API), 이미지 OpenAI 이미지 API(gpt-image-2.5-sunburst), 그림 검토 Claude Opus 5.5. |
| `thundertrail/index.html` | 개요. 제작 노트 탭은 `process.html`이고, 비용·시간 상세(`cost.html`)와 모델 비교(`compare.html`)가 추가 탭이다. 옛 `#epN/sN` 링크는 `read.html`로 넘김. |
| `thundertrail/read.html` | 『길 위의 번개』 리더. 웹툰·나란히·소설 보기. 기본은 읽기 전용이고 “제작 정보” 토글로 판정·근거·프롬프트를 켬. |
| `thundertrail/process.html` | 제작 기록. 회차별 소설·웹툰 단계의 중간 산출물과 AI 판단 근거, 떡밥·설정 추적 타임라인(심기 → 진전 → 회수), 설계 변경 기록. |
| `thundertrail/workflow.html` | 옛 링크용 안내. 워크플로 해설은 공통 `how/`(만드는 방식)로 옮겼다. |
| `thundertrail/cost.html` | 비용·시간. 예상 비용 계산기, 회차별 합계, 토큰 구성, 단계별 상세·평균, 이미지. 수치마다 실측/정가 환산/추정/기록 없음 표시. |
| `thundertrail/compare.html` | 호스트별 스코어카드(장면·칸·판정·차단 근거 귀속·각색 CLI 비용), 첫 장면 나란히, 장면별 히트맵, 결함 귀속, 직접 해보기. |
| `thundertrail/costs.json` | 비용·시간 페이지 데이터. 모델 호출별 토큰(새 입력·캐시 쓰기·캐시 읽기·출력·추론)·시간·금액과 회차×작업×단계 합계. |
| `thundertrail/process.json` | 제작 과정 페이지 데이터. 워크플로 이벤트, 화별 계획, 비평 기록, 수정 전후 원고, 검사 영수증, 장면 워크플로(사전 검증·재설계·소요 시간)와 영→한 번역(`ko`). |
| `thundertrail/data.json` | 리더·비교 페이지 데이터. 장면별 원문 단락, 계획(plan), 렌더 브리프, 시각 검토, 타이밍, 판정. |
| 이미지 저장소 `thundertrail/img/` | 장면 이미지 55장(WebP, 1024×1536). 원본 PNG는 저장소 밖 제작 폴더에 보관. |

`multilingual/data.json`·`img/`는 `tmp/showcase-multilingual/build-multilingual.py`가 다국어 수락 테스트 증거(`--webtoon-run`, `--before`로 실행 선택)에서 만듭니다. `vesper/data.json`·`novel/`·`img/`는 `tmp/vesper-scene-opus/build-site.py`가 `works/vesper/`·`tmp/vesper-20260928-opus/`·`tmp/vesper-scene-opus/` 실행 기록에서 만듭니다. `executionprincess/data.json`은 `tmp/scene-20260924-sol/build-site.py`가 `tmp/scene-20260924-sol/`·`tmp/novel-20260924-sol/` 실행 기록에서 만듭니다. `verdict-live/data.json`은 `tmp/verdict-scene-opus/build-site.py`가 `tmp/verdict-scene-opus/`·`tmp/verdict-scene-opus-v2/`(1화 재생성)·`tmp/verdict-20260923-opus/`·`tmp/verdict-webtoon-opus/` 실행 기록에서 만듭니다. thundertrail의 `data.json`·`process.json`·`costs.json`은 저장소에 포함되지 않는 제작 실행 산출물(`tmp/scene-20260921/`·`tmp/scene-20260922/`·`tmp/scene-20260923-opus/`·`tmp/scene-20260923-gpt6/`·`tmp/novel-20260923-gpt6/`, `works/thundertrail/production-workspaces/`)에서 생성합니다. 수치는 모두 CLI·API 실행 기록에서 읽은 값이며, 검토 판정은 오케스트레이션 호스트의 자기검토입니다.

### 리더 데이터(`<작품>/data.json`)

`shared/reader.js`가 읽는 필드입니다. 표시 안 된 필드는 없어도 됩니다(해당 표시만 빠짐). 새 작품의 build 스크립트는 이 형식으로 내보내면 리더를 따로 만들 필요가 없습니다.

- 최상위: `work`, `builtAt`, `imageModel`, `imageHost?`, `reviewer{host,model}`, `episodes[]`
  - 소설 목록이 있으면 `chapters[]{chapter,title,chars}`와 `novel/NNN.txt`(빈 줄로 단락 구분), 선택 `arcs[]{n,title,start,end}`, `vibelore?{label, novel[]{from,to,packageVersion,commit}, webtoon{packageVersion}}`
- 회차 `episodes[]`: `chapter`, `title`, `host`, `model`, `effort`, `novelHost`, `novelModel`, `sceneCount`, `panelTotal`, `passCount`, `reviewer?`, `regen?{autoRevisionLimit, before?{passCount,sceneCount}}`, `device?{title,summary,hint?,glow?{sceneId:[색]}}`, `scenes[]`
- 장면 `scenes[]`: `id`(`s1`…), `n`, `title`, `image`, `verdict`(`pass`|`revise`), `blocking`, `pFrom`, `pTo`, `panelCount`, `plannedPanels?`, `units[]{text}`, `timings{imageCalls,imageS,planS[],preflightS[]}`, `imageUsd?`, `textsOk`, `textsTotal`, `findings[]{severity,ko,en,layerLabel,correction?,derived?}`, `review{observedPanelCount,evidence,continuity?,textObservations[]}`, `brief{style,moments[]}`, `plan{texts[]}`
  - 재설계 이력: `attempts[]{n,image,findings,plannedPanels,observedPanels,textsOk,textsTotal,emphasis?,after?}`, `attemptTotal?`, `chosenAttempt?`
  - 후반 식자: `lettering?{font,raw,fixes[]{textId,observed,fixed}}`

### 이미지 저장소

장면 이미지(`<작품>/img/`, 214장·약 57MB)는 본 저장소가 작품마다 커지지 않도록 [fbwndrud/vibelore-showcase-media](https://github.com/fbwndrud/vibelore-showcase-media)에 두고, 그 저장소의 GitHub Pages(`https://fbwndrud.github.io/vibelore-showcase-media/<작품>/img/…`)로 서빙합니다. `data.json`의 `image` 값과 `how/webtoon.html`의 그림은 이 절대 주소를 가리키고, `works.json`의 `cover`는 이미지 저장소 기준 경로입니다. 본 저장소에는 목록용 썸네일(`thumb`·`thumbSq`)만 둡니다.

작품 build 스크립트가 `data.json`과 `img/`를 새로 만든 뒤에는 아래를 실행하고 이미지 저장소를 커밋·푸시합니다. 스크립트는 이미지를 복사하고, `data.json`·`how/*.html`의 경로를 바꾸고, 본 저장소의 `img/`를 지웁니다.

```bash
python3 scripts/split-showcase-media.py --media ../vibelore-showcase-media
```

로컬 확인(장면 이미지는 인터넷에서 받음):

```bash
python3 -m http.server 8765 --directory docs   # http://127.0.0.1:8765/showcase/
```
