# Lore Studio 로컬 작업실

Studio는 원고를 읽어 그림·음성·장면을 편집하는 별도 로컬 패키지입니다. 소설 정본과 `.vibelore/`를 수정하지 않습니다. 저장한 자료만으로 재생·출력할 수 있으며 생성 공급자가 없어도 PNG/WAV 반입과 편집을 사용할 수 있습니다.

## 실행과 저장

Studio는 **Git 저장소 체크아웃에서 실행**합니다. `vibelore` npm 패키지에는 Studio 실행 파일·의존성이 포함되지 않습니다. npm 설치 폴더에서 아래 명령을 실행하지 마세요. 저장소 루트에서 Node `^22.13.0 || ^24.0.0 || ^26.0.0`으로 의존성을 설치합니다. 저장 폴더는 소설 원작 폴더와 다른 새 위치로 지정합니다. `--vibelore-root`를 함께 지정하면 `--project`나 `--library`가 원작 폴더 안에 있거나 원작 폴더를 포함할 때 아무것도 만들지 않고 `SOURCE_DESTINATION_OVERLAP`으로 시작을 거부합니다.

```sh
git clone https://github.com/fbwndrud/vibelore.git
cd vibelore
npm ci --prefix studio
npm start --prefix studio -- --project /your/studio-project --project-id p1
```

`--google-key-env` 또는 `--google-keychain-service`를 직접 지정했을 때만 자격 증명을 읽습니다. 옵션이 없으면 `GEMINI_API_KEY`가 환경에 있어도 공급자와 생성 worker를 연결하지 않습니다. 키를 UI·원고·command payload에 붙여 넣지 않습니다. Google을 의도적으로 사용할 때만 전용 환경 변수 또는 `--google-keychain-service`로 기존 자격 증명을 선택합니다. 계정/모델의 실제 제공 여부와 가격은 별도 확인 대상입니다.

터미널의 loopback URL을 엽니다. 작업실 제목·언어·USD 발급 예산을 지정하고 만들기를 누르면 SQLite와 immutable blobs가 저장됩니다. 같은 폴더와 `--project-id`로 재실행하면 이어서 작업합니다. 서버 종료는 Ctrl-C입니다. 저장 버튼이 command를 확정하며, 새 변경 알림은 작성 중인 입력 초안을 덮어쓰지 않습니다.

HTTP 서버는 loopback 주소에만 열리고, 실행할 때마다 새 bootstrap 토큰을 만듭니다. Host·Origin·`Sec-Fetch-Site` 검사와 토큰은 다른 웹사이트의 브라우저 요청(CSRF·DNS rebinding)을 막기 위한 것입니다. 같은 컴퓨터의 다른 로컬 프로세스는 헤더를 직접 지정해 bootstrap에서 토큰을 받을 수 있으므로 막지 못합니다. 신뢰하지 않는 프로그램이나 다른 사용자가 같은 계정에서 실행되는 환경에서는 Studio를 켜 두지 마세요.

## 제작 흐름

1. **Story**에서 UTF-8 원고를 반입하거나 빈 제작판을 만듭니다. `--vibelore-root`를 명시한 경우 기존 vibelore를 읽기 전용으로 연결할 수 있습니다. 원작 개정은 영향 검토 후 새 자료를 채택하며, 기존 판본은 그대로 남습니다.
2. **Cast**에서 배역·캐릭터 정체성·외형 상태·목소리 바인딩을 나눠 편집합니다. 화자 수를 두 명으로 제한하지 않습니다. 화면 밖 화자와 해설도 발화와 믹스에 포함됩니다. 목소리를 저장하기 전에 편집할 상태를 선택하면 기본·아동·성인 바인딩이 각각 유지됩니다.
3. **Asset Lab**에서 PNG/WAV를 반입하고 후보를 비교해 명시적으로 채택합니다. 보호 이미지 편집은 mask+feather 바깥 RGBA를 검사합니다. 되돌리기는 해당 슬롯의 새 결정이며 다른 샷의 선택을 일괄 취소하지 않습니다. 첫 생성 이미지도 범위·대상·외형 상태를 검토해 채택한 뒤 **선택 샷에 사용**으로 연결할 수 있습니다. 공유 후보는 각 대상의 명시적 채택을 거쳐 타임라인과 고정판에서 사용됩니다.
4. **Edit**에서 대사·연기 지시·카메라·발화 전 hold·타이밍을 편집합니다. 대사나 음성 입력이 바뀌면 과거 take를 자동 재사용하지 않습니다. 호환되는 hold-only 편집은 선택 take를 유지합니다.
5. **Production**에서 고정 Edition을 만들고 실제 mixed WAV를 기준으로 미리 듣기/재생합니다. 가로·세로 MP4와 오디오 WAV 출력은 저장한 선택 자료를 사용합니다. 원고·선택을 바꿔도 고정판은 소급 변경되지 않습니다.

실제 video 렌더에는 설치된 Chrome과 FFmpeg/ffprobe, 잠금된 선택 Remotion/React 런타임이 필요합니다. 앱은 브라우저를 다운로드하지 않습니다. macOS의 기본 Chrome 경로 외의 실행 파일은 `STUDIO_CHROME_PATH=/absolute/path/to/chrome`으로 지정합니다. macOS 이외에서는 이 설정이 필수입니다. 오디오 전용 출력은 PNG·Chrome·video 런타임을 요구하지 않습니다. 고정판에 저장된 Node/platform/architecture·코드·잠금 파일과 관련 video 환경이 현재 환경과 다르면 재렌더를 명시적으로 거부합니다. 과거 출력 재생은 가능하며 새 환경에서는 새 Edition을 만듭니다. 서로 다른 시스템에서 bit-identical 파일을 보장하지 않습니다.

검토는 정확한 Edition·출력 manifest·현재 정책에 묶입니다. 실제 보거나 듣지 않았다면 human review를 체크하지 않습니다. 합성 진단음 fixture, macOS local TTS 반입 예시, 실제 Google 생성 품질은 서로 다른 증거입니다.

## 결과 불명과 예산

전송 여부가 모호한 attempt는 `outcome_unknown`, 예약은 `held_unknown`으로 남습니다. 재시작이나 시간이 지났다는 이유로 재전송·예약 해제를 하지 않습니다. 기록된 provider operation과 조회 capability가 있을 때만 명시적 조회를 제공합니다. 그렇지 않으면 청구 확인 또는 중복 실행/과금 위험을 승인한 새 실행을 사용합니다. 성공한 raw bytes가 남아 있으면 재전송 없이 로컬 decode를 이어갈 수 있습니다.

## 백업과 복원

Production의 **프로젝트 백업 만들기**는 현재 project의 한 SQLite view와 등록된 자료를 JSON manifest + `blobs/` 폴더에 저장합니다. 다른 project의 row나 media는 포함하지 않습니다. 화면에 나오는 위치는 작업실 저장 폴더 기준 상대 경로입니다. 완성된 백업 폴더 전체를 다른 저장 장치에 복사하세요. 작업실 안의 백업만으로는 디스크 고장에 대비할 수 없습니다.

백업에는 원고·반입 원본·attempt 입력/원출력·후보·채택/undo 이력·고정 Edition·font/license·mixed audio·renderer source/lock·실제 출력이 포함됩니다. 공급자 키, 원작의 절대 폴더 경로, 일시적인 worker/read 소유권은 포함하지 않습니다. **프로젝트 백업에는 사적인 제작 원문과 media가 포함되므로 지원 진단 파일과 구분하세요.**

**새 폴더로 복원**은 원본을 덮어쓰지 않습니다. 복원 위치를 `--project`로 지정해 새 서버를 시작합니다. 다른 장치에서 가져온 백업은 다음 로컬 utility를 사용합니다. 어느 명령도 생성 worker나 자격 증명을 로드하지 않습니다.

```sh
node studio/scripts/backup.js backup /your/studio-project p1
node studio/scripts/backup.js restore /your/portable-backup /your/new-restored-project
node studio/scripts/backup.js support /your/studio-project p1 > support.json
npm start --prefix studio -- --project /your/new-restored-project --project-id p1 --google-key-env STUDIO_NO_KEY
```

복원은 schema/format version, manifest digest, 정확한 inventory, 모든 blob의 SHA-256/길이, 참조 closure와 row 소유권을 먼저 검사합니다. `..`/절대 entry/중복/심볼릭 링크/불완전한 inventory는 거부하며 임의 archive를 shell로 풀지 않습니다. 대상은 **아직 존재하지 않는 폴더**여야 합니다. 백업 schema 1·2를 지원하며 알 수 없는 미래 버전을 자동 변환하거나 덮어쓰지 않습니다.

복원본은 **새 실행 문맥**입니다. 백업 당시 prepared/queued/dispatching/unknown 요청은 원본에서 나중에 전송됐을 수도 있으므로 모두 `restore_boundary` 결과 불명으로 보류하고 예산을 유지합니다. 복사한 요청을 자동 전송하지 않으며, 미전송/무료라는 증거를 만들어내지 않습니다. 과거 provider operation ID는 명시적인 조회에만 사용합니다. 복원 당시 original PID가 살아 있어도 다른 DB의 worker를 복원본 소유자로 믿지 않습니다.

`support.json` 기본 내용은 allowlist로 제한된 version·무결성 수/해시·attempt/예약 상태별 개수입니다. 제목·원고·media·prompt·키·환경 변수·원작 절대 경로를 넣지 않습니다. 필요한 production 자료를 지원 파일에 자동 첨부하지 않습니다.

## 무결성과 자료 정리

시작 검사는 등록된 missing/corrupt bytes와 미등록 orphan을 구분합니다. 손상/누락 자료는 읽기와 출판 검증을 통과하지 않습니다. 유효한 orphan은 파일과 leaf/상위 directory를 fsync한 뒤 등록합니다. 검사를 통과해도 이미지/음성 decode나 인간의 품질 평가가 완료됐다는 뜻은 아닙니다.

engine의 `collectGarbage(projectId, {graceMs:60000})`는 보존 이력의 모든 blob reference와 활성 staging/read/render/backup pin을 보호합니다. 후보/undo/unknown attempt의 참조는 운영 lease 시간과 무관하게 남습니다. 참조 없는 bytes만 tombstone으로 표시한 뒤 유예하고, 최종 참조/pin 재검사·동기 unlink·leaf fsync를 같은 짧은 SQLite write transaction 안에서 수행합니다. 새 read/write/reference는 tombstone이 있으면 재시도 오류를 받습니다. 중단된 삭제는 시작 때 다시 검사합니다. 활성 process의 pin은 TTL로 만료되지 않으며 죽은 process/incarnation이 확인됐을 때만 회수됩니다. 긴 worker 수명 동안 pin을 보수적으로 유지하므로 미참조 준비 자료는 worker 종료 후 정리될 수 있습니다.

백업/복원/렌더는 command preparation에서 실제 IO를 수행합니다. 연결이 끊겨도 수락한 backend 작업은 계속될 수 있지만 서버 crash에 대한 resumable render queue를 제공하지 않습니다. CAS 충돌이나 crash로 command receipt가 남지 않은 준비 폴더/bytes는 완료로 표시하지 않습니다. 결과와 무결성을 확인한 후 새 command로 재시도합니다.

## 검증과 한계

저장소 루트의 `npm run test:all`은 engine·MCP·Studio를 함께 검사합니다. Studio만 검사하려면 `npm run test:studio`를 사용합니다. 테스트는 합성 원고·로컬 endpoint·실제 SQLite·파일·codec·짧은 렌더를 사용하며 유료 공급자를 호출하지 않습니다. 과거 검증 기록은 [구현 증거](https://github.com/fbwndrud/vibelore/blob/26b0bca3ad0e0658d7a97a64eeda0d9c90ebfc49/docs/research/studio-implementation-evidence-2026-10-09.json)에 별도로 보존합니다.

출력 실패에는 원문 예외·경로·키 대신 안전한 `failure.stage`와 `failure.reason` 분류를 남깁니다. 타임아웃 분류는 근본 원인을 확정한 진단이 아닙니다. **이 판 내보내기**를 다시 누르면 같은 고정판에 새 출력 ID로 재시도하며, 과거 실패 기록과 같은 command ID의 재생 결과는 유지합니다. 자동 재시도는 하지 않습니다.

합성 테스트는 한국어 음성 연기, 공급자의 실제 요금·quota, 인물 identity·mask의 지각 품질, screen reader 실사용, 인간의 청취·감상 승인이나 브라우저 다운로드 완료를 입증하지 않습니다. 사례의 평가자 관계는 작성자의 선언이며 독립 독자를 인증하지 않습니다.
