# 소설 기반 멀티미디어 제작을 위한 Google API 재검토

확인일: **2026-10-08, Asia/Seoul**. 기존 10월 4~6일 조사 메모를 읽고 Google 공식 문서 본문을 다시 확인했다. 유료 호출·음성 청취·이미지 생성·계정 변경은 하지 않았다. 아래의 **확인 사실**은 공개 API 계약이며, **제안**은 vibelore에 적용할 설계 판단이다. 실제 한국어 연기·인물 일관성·서비스 가용성은 아직 시험하지 않았다.

## 1. 우선 선택할 모델과 역할

| 역할 | 후보·API 경로 | 확인 사실 | 제안 |
|---|---|---|---|
| 장면 분해·각색·샷 계획 | Developer `gemini-3.8-flash` | Stable, 텍스트·이미지·영상·오디오 입력, 텍스트 출력, structured outputs 지원. [모델 사양](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) | 원작 근거가 붙은 각색 대본과 작은 JSON 산출물 생성. 최종 렌더링 시간은 결정론 코드가 계산. |
| 어려운 각색·별도 평가 | Developer `gemini-3.1-pro-preview` | Preview, structured outputs 지원. [모델 사양](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview) | 선택적 품질 경로. Preview에 기본 운영을 묶지 않고 실제 비교 시험 후 활성화. |
| 참조 기반 이미지·표정 변형 | Developer `gemini-nano-banana-2.1` | 공식 모델 목록에서 Stable. [모델 목록](https://ai.google.dev/gemini-api/docs/models), [모델 사양](https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1) | 신규 코어 에셋과 정밀 수정 후보. 막 출시된 모델이므로 기존 `gemini-3.1-flash-image`와 비교 후 기본값 확정. |
| 복잡한 주요 장면·키 비주얼 | Developer `gemini-3-pro-image` | 공식 목록에서 Stable. [모델 목록](https://ai.google.dev/gemini-api/docs/models) | 모든 컷에 쓰지 않고 레퍼런스 제작과 핵심 컷에 집중. |
| 감정 대사·내레이션 | Developer `gemini-3.8-flash-tts` | 공식 목록에서 Stable. [모델 목록](https://ai.google.dev/gemini-api/docs/models) | 배역별 발화 단위 합성. |
| 저비용 음성 초벌 | Developer `gemini-3.8-flash-lite-tts` | 공식 목록에서 Stable. [모델 목록](https://ai.google.dev/gemini-api/docs/models) | 스크래치 음성, 대량 낭독 후보. 최종 연기는 같은 대사 A/B 청취로 선택. |
| 재전사·단어 시각 추정 | Developer `gemini-3.5-transcribe` | 한국어와 비실시간 word timestamps 지원. [사양·제한](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe) | 누락·추가 후보 검출, 선택적인 단어 자막. |
| 카메라·레이어 움직임·최종 인코딩 | 자체 렌더러 | 모델 API 역할이 아님. | 타임라인과 좌표·키프레임·오디오를 코드로 합성. 같은 결과물을 웹툰·오디오 드라마·모션코믹으로 출력. |

Structured output은 JSON Schema 일부를 지원하지만 내용의 의미까지 맞는다는 보장은 없다. 문서는 앱에서 값 검증과 의미 오류 처리를 요구하며 큰 중첩 스키마가 거부될 수 있다고 설명한다. **제안:** `AdaptationScript`, `ShotPlan`, `PerformancePlan`을 분리하고, 허용된 `characterId`, `sourceSpan`, 자산 ID, 샷 종류·시간 범위를 앱이 검증한다. [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)

## 2. TTS 대본·연기·배역의 실제 계약

**확인 사실:** Developer API의 현재 TTS 가이드는 3.8 모델을 `POST https://generativelanguage.googleapis.com/v1beta/interactions`로 호출한다. `text`는 원문 낭독 대상으로 취급하고, 감정·속도·음량 등 연기 지시는 `speech_metadata.style`에 넣는다. 순간적인 쉼·한숨 등은 inline vocal tags를 사용한다. 한국어는 Flash와 Flash-Lite 모두 지원한다. 단일 multi-speaker 요청은 **prebuilt voice 최대 2명**이며 custom voice 대화는 발화별로 합성한다. Unary 기본 출력은 WAV, 24 kHz mono 16-bit PCM이고 streaming은 headerless PCM이다. [TTS 가이드](https://ai.google.dev/gemini-api/docs/speech-generation)

**제안:** 4인 장면이라면 내레이터까지 포함해 하나의 긴 파일로 생성하지 않는다. `utteranceId`마다 합성·저장하고 반응 컷·끼어들기·쉼·겹침은 편집 타임라인에서 명시한다. 고정 VoiceProfile에는 음색과 캐스팅을, PerformancePlan에는 이번 발화의 감정을 둔다. 감정 지시가 음성 정체성을 바꾸거나 원문 밖 문장을 만들면 해당 발화만 다시 생성한다.

Voice design은 텍스트 설명으로 `voice_...`와 WAV audition 샘플을 반환하고 이후 합성에서 재사용한다. 저장된 prompted/replicated voice는 프로젝트당 200개, **1년 TTL**이다. 문서의 “persistent ID”를 영구 캐릭터 식별자로 해석하면 안 된다. **제안:** 자체 `voiceProfileId`에 provider voice ID·만료일·설계 프롬프트·승인 샘플을 연결하고 실제 음성 파일을 보존한다. [Voice design](https://ai.google.dev/gemini-api/docs/voice-design)

## 3. Developer TTS와 Cloud TTS를 섞지 않는다

**확인 사실:** Cloud Text-to-Speech `https://texttospeech.googleapis.com/v1/text:synthesize`는 별도 API다. 문서는 `gemini-2.5-flash-tts`, `gemini-2.5-pro-tts`, Preview `gemini-3.1-flash-tts-preview`, Preview `gemini-2.5-flash-lite-preview-tts`를 구별한다. Cloud 3.8 TTS는 Gemini Enterprise API Preview 경로에만 있으며 **Cloud Text-to-Speech API에는 없다**고 명시한다. 한국어 `ko-KR`는 GA 언어로 표기된다. Cloud 단일 합성은 `text`와 `prompt` 각각 4,000 bytes, 합계 8,000 bytes, 출력 약 655초 제한이 있고 초과 출력은 잘린다. `audioConfig`로 포맷을 선택하며 Cloud IAM 권한도 필요하다. [Cloud Gemini TTS](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts)

**제안:** `provider="google"`만 저장하지 말고 `apiSurface="gemini-developer" | "cloud-tts" | "gemini-enterprise"`까지 기록한다. 한국어 bytes 제한은 글자 수와 다르므로 UTF-8 길이를 검사한다. 처음은 Developer 3.8 경로로 평가하고 Cloud의 IAM·지역·운영 계약이 필요하면 별도 어댑터를 추가한다. 다중 화자 Cloud 문서에는 합계 제한 표현이 불일치하므로 작은 발화 요청으로 시작한다.

## 4. TTS style metadata는 타임코드가 아니다

**확인 사실:** Interactions의 `SpeechAnnotation.start_index/end_index`는 텍스트 위치이며 시간값이 아니다. `AudioContent`의 공개 필드는 오디오 data·MIME·sample rate·channels·URI다. 이 TTS 응답에 word alignment가 있다고 문서화돼 있지 않다. 반면 전사 `WordInfo`에는 `start_offset/end_offset`가 명시된다. [Interactions API](https://ai.google.dev/api/interactions-api)

Gemini 3.5 Transcribe의 word timestamps는 파일 처리에서 지원한다. 문서는 timestamps가 전사 정확도를 낮출 수 있고 custom vocabulary와 함께 사용할 수 없다고 적는다. 3명 이상 speaker diarization은 실험적이며 timestamps 사용 시 파일 길이 제한은 30분이다. [Transcribe 사양](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe)

Cloud 일반 SSML은 `<mark>`와 `SSML_MARK`로 특정 지점의 timepoints를 반환한다. 하지만 이 사실을 Gemini TTS에서도 지원한다고 확대 해석해서는 안 된다. [SSML timepoints](https://docs.cloud.google.com/text-to-speech/docs/ssml)

**제안:** 실제 WAV sample 수로 길이를 측정하고 발화·컷·자막 타이밍을 확정한다. MVP는 문장 단위 자막으로 시작한다. 단어 자막은 재전사 결과와 승인 대본을 대조해 붙이며 이는 ASR 시각 추정이다. forced alignment나 lip-sync의 보장으로 보고하지 않는다. 대본과 실제 길이가 안 맞으면 그 발화 또는 해당 샷만 수정한다.

## 5. 이미지 정체성과 레이어 분리는 별도 검증 대상

**확인 사실:** 이미지 문서는 참조 입력과 대화형 편집을 지원한다. Nano Banana 2.1/3.1 Flash Image는 최대 4 캐릭터의 resemblance와 10 objects의 fidelity를 설명하고, Pro Image는 5개 high-fidelity reference와 총 14개 입력을 설명한다. 정확한 이미지 출력 수를 따르지 않을 수 있으며 생성 이미지에는 SynthID가 포함된다. [이미지 가이드·제한](https://ai.google.dev/gemini-api/docs/image-generation)

**제안:** 웹툰 완성 이미지 하나를 모든 출력의 원재료로 만들기보다, 승인된 인물·배경·소품 디자인과 clean plate를 공통 자산으로 만든다. 모션코믹은 가능한 경우 배경/인물/전경을 따로 저장한다. 모델의 “일관성”은 평가 능력이지 완벽한 동일성 보장이 아니다. identity·복장·손·소품·알파·가장자리·카메라 crop을 실제 파일로 검사한다. 투명 PNG·정확한 분리 레이어를 모델이 항상 반환한다고 가정하지 않는다. 자막·화자 표시·화면 대사는 렌더러 텍스트로 그리면 원문 대조와 재편집이 쉽다. 기존 웹툰 경로의 원문 대사 삽입 계약은 별도로 유지한다.

## 6. 수명 변경과 공식 문서 불일치

**확인 사실:** deprecations는 Nano Banana 2.1 출시를 2026-10-06, 3.8 TTS 출시를 2026-09-22, 종료일을 미공지로 표기한다. Developer Veo 3.1 Preview 세 모델의 종료 예정은 2026-10-22이며 대체 모델은 `gemini-omni-1.1-flash`다. Preview 종료 일정은 Cloud Veo GA 모델에 자동 적용할 수 없다. [종료 일정](https://ai.google.dev/gemini-api/docs/deprecations)

**불일치:** 2.5 Flash Image 종료일은 pricing에 2026-10-02, deprecations에 2027-03-15로 다르게 적혀 있다. 기존 10월 5일 메모의 “이미 종료” 문장은 현재 확인 사실로 재사용하지 않는다. 새 설계는 새 이미지 계열을 선택하되 배포 전에 계정 Models API와 실제 호출로 가용성을 확인한다. [Pricing](https://ai.google.dev/gemini-api/docs/pricing), [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations)

**제안:** 모델 registry에 공급 경로·모델 ID·확인일·기능·fallback·pricing version을 두고 프로젝트는 승인된 registry revision을 참조한다. 모델 이름을 바꾸는 작업과 작품 디자인 변경을 구별한다. 생성 파일과 승인 증거는 공급자 모델이 사라져도 재생 가능한 상태로 보존한다.

## 7. 비용의 주된 단위는 출력 장수와 재시도

2026-10-08 Developer Standard paid USD 확인값. 세금·환율·입력·thinking·재시도·검수·저장·렌더링 제외. TTS 공시 단가는 2026-12-31까지이며 2027-01-01에 두 배로 변경 예정이다. [공식 pricing](https://ai.google.dev/gemini-api/docs/pricing)

| 항목 | 출력 단가 | 출력만의 계산 예 |
|---|---:|---:|
| Nano Banana 2.1 1K | $0.0336/장 | 12장 $0.4032 |
| Nano Banana 2.1 2K | $0.0504/장 | 12장 $0.6048 |
| Pro Image 1K/2K | $0.134/장 | 12장 $1.608 |
| 3.8 Flash TTS | $9/1M audio tokens, 25 tokens/s | 60초 $0.0135, 5분 $0.0675 |
| 3.8 Flash-Lite TTS | $6/1M audio tokens, 25 tokens/s | 60초 $0.009, 5분 $0.045 |

**제안:** 동일 파일의 팬·줌에는 새 이미지 API 호출이 필요 없다. 비용은 에셋 생성과 반복 수정에 붙는다. 제작별 soft budget·hard cap·retry cap을 두고, 화면·음성·대본 변경에 따른 필요한 노드만 다시 실행한다. 초벌·최종 모델을 구분하되 이미 승인된 파일은 재사용한다. 표를 완성 영상 납품 원가로 쓰지 않는다.

API 쿼터는 키가 아닌 프로젝트에 적용되며 preview/experimental은 더 제한적이다. 공식 문서는 RPM·TPM 외에 계정 조건별 10분 spend limit과 429를 설명하고 실제 capacity가 변할 수 있다고 적는다. [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) **제안:** 공급 경로·모델별 큐와 concurrency limit, jitter backoff, 재개 checkpoint를 둔다. 새 키를 만드는 것으로 quota를 우회하려 하지 않는다.

## 8. 좁게 검증할 생산 시험

아래는 아직 실행하지 않은 제안이다.

1. 한국어 원문 한 장면, 3인+내레이터, 60~90초 목표로 시험한다. 기존 이미지부터 재사용하고 타임라인만 움직인다.
2. 캐스팅 audition에서 동일 문장·감정 3종을 각 후보 모델로 듣는다. 숫자·고유명사·존댓말·반말·쉼·배역 구분을 확인한다.
3. 원작 근거→각색 발화→WAV→샷→자막까지 ID를 추적한다. 재전사로 누락 후보를 잡되 ASR만으로 원문 정확성을 최종 확정하지 않는다.
4. 실제 파일의 무음·clipping·길이, 실제 렌더의 자막 safe area·읽기 시간·crop·레이어 edge·음성/자막 동기를 검사한다. 모델 영상 평가와 사람 청취를 보완적으로 쓴다.
5. 한 발화를 수정할 때 관련 음성과 길이에 의존하는 뒤쪽 타이밍만 갱신되는지, 기존 승인 이미지와 다른 배역 음성이 유지되는지 확인한다.
6. 합격 후 필요할 때만 짧은 생성형 영상 샷을 추가한다. 기본 제작 흐름은 정지 자산과 편집 엔진이며 generative video provider는 선택형 플러그인으로 둔다.

가장 중요한 미검증은 한국어 감정 연기의 반복 재현성, 장기 음성 정체성, 레이어 자산 품질, 샷 변화 후 의미·화자·타이밍 보존이다. 이는 최신 모델명 선정만으로 해결되지 않는다.
