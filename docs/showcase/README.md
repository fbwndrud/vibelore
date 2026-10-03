# Showcase

정적 공개 뷰어. 빌드 도구 없이 GitHub Pages(소스: `main` 브랜치 `/docs`)로 그대로 서빙합니다.

당분간 운영자가 만든 작품만 공개합니다. 사용자 계정·외부 등록 신청·업로드 서버는 두지 않습니다. 첫 화면은 작품 읽기 중심이며 **소설 / 웹툰**과 **작품 언어**로 고릅니다. UI의 한국어/영어 전환은 본문 언어와 별개입니다. 모델·버전은 펼쳐 보는 제작 정보에 남깁니다.

### 작품·회차 갱신

1. 기존 작품의 본문·이미지를 교체하기 **전에** 공개본을 보관합니다. 현재 이미지가 있는 이미지 저장소 체크아웃이 필요합니다.

   ```bash
   python3 scripts/prepare-showcase.py --archive vesper --media ../vibelore-showcase-media
   ```

   소설 본문·리더 데이터는 `history/<작품>/<내용 해시>/`, 이미지 원본은 이미지 저장소의 같은 `history/` 경로에 고정합니다. `history.json`에는 보관한 리더 링크가 남습니다. 같은 자료로 다시 실행하면 중복하지 않습니다. 보관 리더는 현재 공통 리더 코드를 사용하되 본문과 그림은 보관 경로에서 읽고, 현재 공개본으로 돌아갈 수 있습니다. 제작 노트·사전 이동은 현재 작품으로 연결하며 보관본에서는 사전 연결을 끕니다. 다국어 모음은 자체 뷰어와 데이터를 함께 보관합니다.

2. 작품별 제작 도구로 공개용 `data.json`·`novel/`·`img/`를 갱신합니다. 새 작품이면 `works.json`에 소개·기존 공통 리더에 맞춘 페이지·표지 경로와 `language`(BCP 47)를 등록합니다. 모델·비용 기록은 없는 값을 추측하지 않습니다. 다국어 모음의 언어와 제목은 `data.json.languages`에서 읽습니다.

3. 새 그림이 있으면 이미지 저장소로 옮깁니다. 같은 파일명에 다른 그림이 생기면 내용 해시를 붙인 **새 주소**를 만들고, 기존 이미지 주소의 바이트는 보존합니다. 새 주소는 데이터와 표지 경로에 반영됩니다.

   ```bash
   python3 scripts/split-showcase-media.py --media ../vibelore-showcase-media
   ```

4. 공통 도구로 회차·언어·읽기 위치와 제작 정보를 갱신합니다. 표지도 바꿨다면 `--thumbs`를 붙입니다(썸네일에는 Pillow 필요).

   ```bash
   python3 scripts/prepare-showcase.py --thumbs
   python3 scripts/prepare-showcase.py --check
   ```

   표지가 같으면 첫 명령의 `--thumbs`를 생략할 수 있습니다. 회차와 장면 수는 본문 데이터에서 자동 계산되므로 목록 분량을 다시 적을 필요가 없습니다. 제작 정보는 기존 작품의 상세 계산식을 유지하고, 새로운 작품은 공통 계산으로 시작해 미기록 비용·시간을 그대로 표시합니다.

5. 로컬 리더와 변경된 이미지·회차 링크를 확인한 뒤 두 저장소의 변경을 검토합니다. **이미지 저장소를 먼저 배포하고 새 이미지 주소가 열리는지 확인한 다음** 본 사이트를 배포합니다. 검증 도구가 자동으로 커밋하거나 푸시하지는 않습니다. 현재 작품 URL과 `#epN/sN` 링크는 유지합니다.

검증: `python3 -m unittest discover -s test -p showcase_pipeline_test.py`. 누락된 본문·중복 회차·작품 언어 누락, 이미지 변경 후 원래 URL 보존, 공개본 보관 뒤 원문·이미지 불변을 확인합니다.

| 경로 | 내용 |
|---|---|
| `index.html`·`shared/catalog.js`·`shared/catalog.css` | 작품 서가. 기본은 소설이며 소설은 타이포그래피 책 표지, 웹툰은 공개 그림으로 표시한다. 제목 검색·작품 언어 필터, 추천·제작 버전·분량·제목 정렬과 첫 문장 미리 읽기를 제공한다. 모델 필터와 모델·버전 정보는 제작 정보에서 펼친다. `?format=novel|webtoon|all&workLanguage=ja&sort=&q=`로 공유하며 `lang`은 UI 언어다. 리더도 선택한 형식으로 열고, 다국어는 실제 작품 제목을 개별 카드로 표시하고 해당 언어만 읽는 뷰어(`multilingual/?read=1#n-ja` 또는 `#w-ja`)로 연결한다. |
| `browse.json` | `prepare-showcase.py`가 `works.json`과 공개 데이터에서 만드는 언어·형식별 회차 수·다국어 제목과 읽기 위치·보관본 링크. 첫 문장 발췌도 공개 본문에서 가져온다. 손으로 수정하지 않는다. |
| `history.json`·`history/` | 첫 보관 시 생성되는 공개본 목록과 고정된 데이터·본문. 이미지는 별도 이미지 저장소의 `history/`에서 읽는다. |
| `works.json` | 작품 목록·버전 연혁의 단일 원본. `versions`(버전·날짜·CHANGELOG 요약)와 `works`(제목·장르·분량·모델·`family`·`formats`·버전 범위 `from`/`to`와 실행 커밋 `detail`·연혁 막대 문구 `bar`·표지 `cover`와 썸네일 `thumb`·`thumbSq`). 새 작품은 여기에 항목 하나를 더하면 목록과 연혁에 함께 나온다. |
| `<작품>/thumb.webp`·`thumb-sq.webp` | 목록·버전 연혁·작품 띠·사전용 표지 썸네일(600px 폭 / 128px 정사각). `scripts/build-showcase-thumbs.py`가 `works.json`의 `cover` 원본에서 만든다. 표지를 바꾸면 다시 실행한다. |
| `versions.html` | 버전 연혁. `works.json`의 버전을 가로축으로, 작품을 만든 버전 범위만큼의 막대로 그린다. |
| `how/` | 만드는 방식. `index.html`(사용자·호스트·vibelore·작품 폴더와 한 번의 왕복), `novel.html`(소설 한 화의 일곱 단계), `webtoon.html`(웹툰 한 장면의 여섯 단계와 베스퍼 1화 장면 8의 시도 기록). 단계 설명은 현재 `src/tools/workflow.js`·`check-contract.js`·`webtoon-scene.js` 기준이고, 실측 칸은 `vesper/data.json`에서 읽는다. |
| `shared/` | 목록·연혁·만드는 방식 공통 `site.css`(색·머리글·바닥글), `how.css`(흐름도), `chrome.js`(머리글 메뉴와 `works.json` 읽기). |
| `shared/reader.js` | 작품 공통 리더. 각 작품 `read.html`이 `Reader.start({ work, store, imageHost, sceneCost })`로 연다. 소설 목록이 있는 작품(`chapters`)은 회차 선택과 `novel/NNN.txt` 본문을, 웹툰 회차만 있는 작품은 회차 탭과 장면 원문을 그린다. 웹툰·나란히·소설 보기, `#epN/sN` 딥링크, 제작 정보 토글, 모바일 원문 시트, 인물·설정 사전 연결을 한 코드로 처리한다. 읽기 스타일은 `shared/reading.css`로 분리하며 소설은 중앙 본문, 웹툰은 이어지는 그림을 표시하고 제작 정보 토글로 장면·검토 정보를 표시한다. 데이터 형식은 아래 “리더 데이터”. |
| `shared/work.css`·`notes.css`·`worknav.js` | 작품 폴더 공통 스타일(리더·제작 노트)과 리더 메뉴. 작품 폴더에는 팔레트(`vesper.css` 등), 리더 메뉴 설정(`site.js`: `WorkNav({ title, pages })`), 작품별 제작 노트 스크립트(`notes.js`)만 남는다. |
| `shared/workpage.js`·`workpage.css` | 작품 페이지 공통 틀. `<body data-work data-tab>`과 `#work-band`로 테마 띠(이동 경로·이전/다음 작품·표지·제목·“1화부터 읽기”/“이어 읽기”·탭)를 그린다. 탭은 모든 작품이 개요 · 읽기 · 제작 노트 · 비용·데이터로 같고, 인물·설정과 `works.json`의 `tabs`가 뒤에 붙는다(제작 노트 경로는 `pages.notes`로 바꿀 수 있다). 작품 색은 띠에만 쓴다. `WorkPage.overview()`는 개요의 회차·아크·연출 실험·제작 정보를, `WorkPage.data()`는 비용·데이터 페이지를 채운다. “이어 읽기”는 리더가 남긴 `localStorage` `reader.last.<id>`. |
| `facts.json` | 작품별 제작 정보 8칸(vibelore · 설계·집필 · 웹툰 각색 · 이미지 · 그림 검토 · 분량 · 비용 · 소요 시간). `scripts/build-showcase-facts.py`가 `works.json` 버전과 각 작품 `data.json`(thundertrail은 `costs.json`)에서 제작 노트·비용 페이지와 같은 식으로 계산한다. 기록이 없으면 ‘기록 없음’, 추정이 섞이면 그렇게 적는다. |
| `<작품>/index.html`·`notes.html`·`data.html` | 작품 개요(소개·회차·연출 실험·제작 정보), 제작 노트, 비용·데이터(제작 정보 전체·다른 작품과 나란히·자세한 비용 링크·데이터 파일). |
| `lore.html` | 인물·설정 사전. `?work=<id>&ch=<n>`으로 고른 작품의 인물·장소·물건·비밀·예정된 일·떡밥·호칭표를 **고른 화까지만** 보여준다. 항목은 눌러야 펼쳐진다. 작품 목록은 `works.json`의 `lore` 필드에서 읽는다. |
| `shared/lore.js`·`lore.css` | 사전 카드 렌더와 리더 연결. 작품 리더(`read.html`)의 본문 도구줄(모바일은 아래 시트)에 “인물·설정” 켜기 버튼을 두고, 켜면 `lore.json`을 받아 본문 속 인물·장소 이름(장면 묶음마다 첫 번째)을 누를 수 있게 한다. N화를 읽는 중이면 N−1화까지를 보여주고 N화 변화는 접어 둔다. 기본은 꺼짐(`localStorage` `lore.on`). |
| `<작품>/lore.json` | 사전 데이터. `scripts/build-showcase-lore.py <id>`가 `works/<id>/characters/*.md`(인물·극적 모델·말투), `.vibelore/ledger/{seed.json,events.jsonl}`(화별 설정 원장, 베스퍼만), `.vibelore/entities.json`(원장 이전 작품의 설계 시드), `.vibelore/story-state/<N>.json`(떡밥·관계·호칭·아크 위치·인물이 아는 것)에서 화별 이력째로 만든다. 쇼케이스에 공개된 화까지만 담는다. |
| `family-revenge/` | 『아까는 식구 아니라면서요』 현대 가족 복수극. 소설 10화 완결, 웹툰 1화 4장면·34칸. vibelore 0.4.8(7ed081d), Codex 세션 집필·각색·자기검토, OpenAI API 이미지. 성인 생활 풍자풍, 참조 이미지 2장, 재생성 3건의 전후 비교, 7시도의 실제 계획·프롬프트·검토 기록을 공개한다. 세부 집필 모델·과금·순수 추론 시간은 미기록. 팔레트 `family.css`. |
| `plant-runaway/` | 『우리 집 화분이 가출했습니다』 기존 공개본을 원격 최신 버전에서 보존. 소설·웹툰 1~3화, 10장면·80칸, Gemini 집필·Codex 각색·OpenAI 이미지 API. |
| `vesper/` | 『베스퍼』(롯데월드 야간 퍼레이드 캐릭터를 빌린 비공식 팬 창작, 인외 로맨틱 코미디) 소설 50화 완결 + 웹툰 1~3화 27장면. vibelore 0.4.2(소설은 0.4.1에서 시작해 PR #9 수정을 반영하며 집필), 설계·집필·각색 Claude Opus 5.5, 이미지 OpenAI 이미지 API(gpt-image-2.5-sunburst). 아크별 회차 선택 리더, 제작 노트, `data.json`, `novel/NNN.txt`(정본 본문), 별도 이미지 저장소를 사용한다. 팔레트 `vesper.css`. |
| `i18n.js` | 모든 페이지 공통 한국어/영어 UI 사전과 토글. 기본 언어는 `navigator.language`, 선택은 `localStorage`(`vibelore.lang`)에 저장하고 `?lang=ko|en`으로 공유. 작품 본문·대사는 번역하지 않음. 새 UI 문자열은 한국어 원문을 키로 이 파일에 추가. |
| `multilingual/` | 8개 언어(ko·en·ja·zh-Hant·es·fr·ar·th) 소설 1화 발췌·사실과 장면 웹툰 한 장·판정. `data.json`, 이미지(이미지 저장소 `multilingual/img/`, WebP), `ml.js`·`ml.css`·`sample.css`. `?read=1#n-<언어>`와 `#w-<언어>`는 단일 작품 읽기 화면이며, 쿼리가 없는 기존 페이지는 전체 제작 기록을 유지한다. 기본 웹툰 실행은 3207b83, 비교용 “프롬프트 수정 전” 52e5aee. |
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

장면 이미지(`<작품>/img/`, 198장·약 50MB)는 본 저장소가 작품마다 커지지 않도록 [fbwndrud/vibelore-showcase-media](https://github.com/fbwndrud/vibelore-showcase-media)에 두고, 그 저장소의 GitHub Pages(`https://fbwndrud.github.io/vibelore-showcase-media/<작품>/img/…`)로 서빙합니다. `data.json`의 `image` 값과 `how/webtoon.html`의 그림은 이 절대 주소를 가리키고, `works.json`의 `cover`는 이미지 저장소 기준 경로입니다. 본 저장소에는 목록용 썸네일(`thumb`·`thumbSq`)만 둡니다.

작품 build 스크립트가 `data.json`과 `img/`를 새로 만든 뒤에는 아래를 실행하고 이미지 저장소를 커밋·푸시합니다. 스크립트는 이미지를 복사하고, `data.json`·`how/*.html`의 경로를 바꾸고, 본 저장소의 `img/`를 지웁니다.

```bash
python3 scripts/split-showcase-media.py --media ../vibelore-showcase-media
```

로컬 확인(장면 이미지는 인터넷에서 받음):

```bash
python3 -m http.server 8765 --directory docs   # http://127.0.0.1:8765/showcase/
```

### 가족 복수극 내보내기

`python3 scripts/build-showcase-family-revenge.py`(Pillow 필요)는 정본 10화와 완료된 장면 워크플로·검토 아티팩트를 읽습니다. 원문 76단락의 빠짐없는 대응, 34칸·44문구, 최종 이미지 해시와 통과 판정을 검사하고 4장면·이전 시도 3장·참조 2장을 lossless WebP로 내보냅니다. `records/`와 `prompts/`에는 기기 경로를 제거한 실제 시도 자료를 남깁니다. 이후 썸네일 생성 → 이미지 분리 → `build-showcase-lore.py family-revenge` → `prepare-showcase.py` 순서로 등록합니다.

완결 표시는 `works.json`의 `completed: {"novel": true}`로 선언합니다. 소설 완결이 웹툰 완결로 번지지 않으며, 공개 화수는 실제 `data.json`에서 계산합니다.
