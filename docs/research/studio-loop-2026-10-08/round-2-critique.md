# 2회차 비평: 다인물 장면을 import부터 rebase까지 추적

## 추적한 작업 흐름

1. vibelore 작품을 연결해 장면 S12를 import한다. 등장은 다음과 같다.
   - 현재의 서연: narrator·inner
   - 어린 서연: onscreen
   - 엄마, 동생
   - Studio에서 만든 단역 "경비"
   - 군중 ensemble
2. Asset Lab의 9:16 reframe 샷에서 어린 서연 얼굴을 mask로 수정한다.
3. 수정본을 "작품 공통 참조로 채택"한다.
4. 같은 프로젝트에서 예고편을 만든다.
5. 원작자가 vibelore에서 서연 초상과 경비 설정을 갱신한다.
6. Studio에서 rebase한다.

결과: Occurrence·Candidate/Adoption·drift 차단은 1~2단계를 잘 지탱한다. 3~6단계에서는 slot, 배역, 원천 소유 경계가 정의되지 않아 깨진다.

## 순위별 결함

### 1. asset slot의 주체 키가 없다 (최우선)

- **실패 시나리오:** 어린 서연 얼굴 수정본을 `projectAsset`으로 채택했다. 그 slot을 참조하는 성인 서연 샷에도 "새 버전 사용 제안"이 뜬다. 거부하지 않으면 과거와 현재의 외형이 섞인다.
- **누락된 계약:**
  - `EditRequest.targetSlot`과 `Adoption.slotId`만 있고 slot이 무엇을 대표하는지 정의가 없다.
  - `Occurrence.temporalStateRef`는 있지만 asset slot과 연결되지 않는다.
  - scope 열거값(shot/scene/project)은 적용 범위만 말하고 대상 주체는 말하지 않는다.
- **최소 수정:**
  - `AssetSlot{id, kind, subject: {characterId, appearanceStateRef} | locationId | propId}`를 정의한다.
  - 제안 전파는 subject가 일치하는 occurrence의 샷으로만 한정한다.
- **수용 검사:** 성인과 어린 서연이 함께 나오는 fixture에서 어린 쪽 채택 시 성인 샷 제안이 0건이고, 영향 목록에 subject가 표시된다.

### 2. 배역(RoleBinding) 결정의 해석 계층과 재배역 영향이 없다

- **실패 시나리오:** 40인 프로젝트에서 엄마 목소리를 바꾸려 한다.
  - RoleBinding이 occurrence마다 있으면 30개 장면을 일일이 고쳐야 한다.
  - 공유 binding이면 어린 서연만 다른 목소리를 쓰는 예외를 표현할 수 없다.
- **충돌하는 계약:** `Occurrence.roleBindingId`는 단일 값이다. "같은 occurrence는 고정한 배역"이라는 문장만 있고 작품 단위 캐스팅 결정이 없다.
- **최소 수정:**
  - `CastingDecision`을 character → appearanceState → occurrence 순서로 override하는 구조로 둔다.
  - 생성 digest에는 실제로 해석된 binding revision을 넣는다.
  - 재배역은 Adoption과 같은 영향 미리보기를 거친다.
- **수용 검사:**
  - 엄마 재배역 시 엄마의 발화만 `input-invalid`가 되고, 어린 서연 override는 그대로다.
  - commit 전에 영향받는 발화 수가 표시된다.

### 3. 원천 소유 asset 위에 만든 Studio 파생본이 rebase에서 누락된다

- **실패 시나리오:**
  - 2단계 편집의 `baseAssetRevision`은 SourcePackage의 원작 초상이다.
  - 5단계에서 원작 초상이 바뀐다.
  - RebaseDecision의 source diff에는 초상 변경이 나오지만, 옛 초상에서 파생된 Studio 채택본은 영향 목록에 없다. 그 결과 구 외형이 조용히 유지된다.
- **누락된 계약:**
  - Adoption의 `dependencyDigest`가 원천 asset hash를 포함하는지 명시되지 않았다.
  - 원작 reference와 Studio 채택본 중 무엇이 우선하는지 해석 순서가 없다.
- **최소 수정:**
  - 파생 revision에 `sourceAssetOrigin{packageId, assetId, hash}`를 기록한다.
  - rebase 영향 목록에 "base가 바뀐 파생 채택"을 포함한다.
  - 선택지는 keep-override / 새 base에서 재편집 / 원작 reference로 복귀, 세 가지다.
- **수용 검사:** 원작 초상 bytes만 바꾼 rebase fixture에서 파생 채택이 영향 목록에 나온다. 아무것도 선택하지 않으면 기존 bytes가 고정 유지된다.

### 4. Studio가 만든 인물과 원작 인물을 연결하는 계약이 없다

- **실패 시나리오:**
  - "경비"는 Studio에서 만들어져 `characterId?`가 비어 있고, 이미 목소리와 그림이 채택되었다.
  - 원작자가 정본에 "경비 민수"를 추가한다.
  - rebase하면 같은 인물이 둘이 되거나, 이름 일치로 자동 병합될 위험이 있다.
- **누락된 계약:** CharacterIdentity의 출처(origin)가 정의되지 않았다.
- **최소 수정:**
  - `CharacterIdentity.origin`을 `source(packageId, canonId)` 또는 `studioLocal`로 둔다.
  - 둘을 잇는 것은 명시적이고 되돌릴 수 있는 `IdentityLink` 결정으로만 한다.
  - 연결해도 occurrence·binding·adoption ID는 유지한다. 이름 일치로 자동 연결하지 않는다.
- **수용 검사:**
  - link 후 기존 발화가 `input-invalid`가 되지 않는다. 단, 지식이나 상태 참조가 바뀌면 `review-stale`로 표시한다.
  - unlink하면 원상태로 돌아간다.

### 5. import와 결정론 편집이 Candidate 생명주기 밖에 있다

- **실패 시나리오 (오디오):** 녹음 MP3를 import했는데 파일 끝이 잘려 있다. Job 상태기계는 생성 작업만 전제하므로, 이 파일이 byte 검증 없이 slot에 들어간다.
- **실패 시나리오 (crop):** crop의 성격이 정해지지 않았다. 새 asset revision인지 샷의 transform 파라미터인지에 따라 공통 참조가 바뀌는지 여부가 달라진다.
- **최소 수정:**
  - `AssetRevision{origin: import | generate | aiEdit | deterministicEdit, parents[], operation, bytesHash}`로 계보를 통일한다.
  - 모든 origin에 hard byte 검증(decode·길이·샘플레이트·checksum)을 의미 검토와 별개로 적용하고, 통과해야 candidate가 된다.
  - crop·위치·카메라는 샷 transform으로 두고 asset revision을 만들지 않는다. matte·upscale은 revision을 만든다.
- **수용 검사:**
  - 잘린 WAV가 byte-validation 사유로 거부된다. 의미 검토 결과로 표시되지 않는다.
  - 샷 crop이 공통 slot을 바꾸지 않는다.

### 6. 프로젝트와 결과물(Production)의 경계가 없다

- **실패 시나리오:** 4단계에서 예고편 전용으로 서연 의상을 바꾼다.
  - scope에는 shot/scene/project만 있다.
  - 그래서 본편 slot까지 바꾸거나, 예고편 샷마다 override를 반복해야 한다.
  - 예고편을 별도 프로젝트로 만들면 채택 결과를 공유하지 못한다.
- **최소 수정:**
  - Project 하나에 여러 Production(본편·예고·세로·오디오)을 둔다.
  - scope에 `productionOverride`를 추가한다.
  - export manifest는 production별로 해석된 revision을 고정한다.
- **수용 검사:** 예고편 override 후 본편 export manifest가 바뀌지 않는다.

## 개선된 점

- **다인물 구조:** 인물·출현·배역·발화 4층 분리 덕분에 성인/어린 동시 출현, 내레이터, inner 발화를 표현할 수 있다.
- **asset 편집:** Candidate는 불변이고 Adoption은 supersede 방식이며, 기존 샷을 자동 교체하지 않는다.
- **mask 처리:** 원본 좌표 기준이고, 보호 영역은 compositor가 유지하며, prompt 문구만으로 보호를 보증하지 않는다.
- **과금과 실패:** exactly-once 과금을 주장하지 않고, 결과 불명·늦은 응답은 stale candidate로 처리한다.
- **원천 소유:** Studio가 정본에 직접 쓰지 않고, 원작 쪽 승인 경로를 거친다.
- **무효화 범위:** `input-invalid`와 `review-stale`을 구분하고, 발화 단위로 무효화한다.
- **다인물 검증 시점:** 첫 vertical slice부터 4인 이상을 요구한다.

## 아직 시험되지 않은 것

- 모든 수용 검사는 설계상의 기준이다. 저는 브라우저·API·backend를 실행하지 않았다.
- 실제 mask 합성 경계, provider native mask 탐지, 한국어 TTS 동일성, 40인 UI 성능은 증거가 없다.
- rebase 영향 계산과 IdentityLink는 문서 수준에서도 아직 정의되지 않았다.
- 화면 예시가 1·3·5번 결함을 이미 드러내는지는 이 artifact만으로 판단할 수 없다.