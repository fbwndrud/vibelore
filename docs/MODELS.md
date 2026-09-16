# 모델과 프로바이더

vibelore가 어떤 모델을 쓰는지, 단계별로 모델을 나누는 방법, 로컬 모델 연결을 설명합니다.

## 지원 환경과 프로바이더

기본 경로에서는 vibelore가 모델 회사 API를 직접 호출하지 않습니다. MCP를 실행하는
호스트의 현재 모델이 초고, 계획, 비평 요청에 답합니다. 따라서 별도 API 키가 필요 없고,
모델과 생각 수준도 vibelore가 아니라 호스트 세션에서 선택합니다.

| 실행 경로 | 모델 응답 경로 | 상태 |
|---|---|---|
| Codex 앱·CLI | Codex 세션 모델 | 전체 집필 왕복 확인 |
| Claude Code | Claude Code 세션 모델 | 전체 집필 왕복 확인 |
| Grok CLI | Grok 세션 모델 | 전체 집필 왕복 확인 |
| Ollama·LM Studio·llama.cpp | OpenAI 호환 `/chat/completions` | 선택 기능, 호환성 경로 |

OpenAI, Anthropic, Google, xAI의 API 키를 vibelore에 넣어 직접 호출하는 방식은 현재
지원하지 않습니다. 로컬 모델은 `VIBELORE_LOCAL_BASE_URL`과 `VIBELORE_LOCAL_MODEL`을
모두 지정했을 때만 호스트 모델 대신 사용합니다. 이 어댑터는 인증과 생각 수준 전달을
지원하지 않으므로 신뢰할 수 있는 로컬 엔드포인트에서만 사용해야 합니다.

```bash
VIBELORE_LOCAL_BASE_URL=http://127.0.0.1:11434/v1 \
VIBELORE_LOCAL_MODEL=qwen3:14b \
node /absolute/path/to/vibelore/src/server.js
```

호스트별 등록 방법과 실제 확인 버전은 [HOSTS.md](../HOSTS.md)에 기록합니다.

## 권장 모델과 생각 수준

다음은 2026-09-05 기준의 vibelore 운영 권장값입니다. 문학적 품질을 보증하는 순위가
아니라, 긴 지시를 유지하면서 계획·초고·검사를 한 세션에서 수행하기 위한 출발점입니다.
계정과 호스트에 표시되는 모델만 사용할 수 있습니다.

| 호스트 | 품질 우선 | 균형형 | 기본 생각 수준 |
|---|---|---|---|
| Codex | `gpt-6-astra` | `gpt-5.6-sol` | `high` |
| Claude Code | `opus` (`Claude Opus 5`) | `sonnet` (`Claude Sonnet 5`) | `high` |
| Grok CLI | `grok-4.6` | `grok-4.6` | `high` |
| 로컬 OpenAI 호환 | 한국어 장문·JSON 응답을 검증한 모델 | 해당 없음 | 서버에서 조절 불가 |

- 작품 발견 인터뷰, 전체 스토리, 첫 아크 설계: `high`. 설정과 인과가 특히 복잡할 때만
  `xhigh`를 검토합니다.
- `lore_write`로 회차를 계획·집필·검사할 때: `high`를 기본값으로 권장합니다.
- 상태 조회, 승인, 단순 손질: `medium` 또는 `low`로도 충분합니다.
- `max`는 일반 집필 기본값으로 권장하지 않습니다. 비용과 대기 시간이 늘고 작품을
  불필요하게 복잡하게 만들 수 있으므로, 실패 원인이 사고량 부족으로 확인된 경우에만 씁니다.

기본값은 한 작업을 같은 강한 모델과 `high` 수준으로 끝내는 것입니다. 단계별로 나누고
싶을 때만 `lore_write`에 `modelProfile`을 넘깁니다. `default`는 기준 모델, `light`는
계획·초고·검사 단계에 쓸 가벼운 모델이고, `identity`·`planning`·`draft`·`quality`·`final`로
단계를 직접 지정할 수 있습니다. 각 값은 모델 ID 문자열이거나 `{ provider, modelId,
reasoningEffort }`입니다. vibelore는 이 값을 `needs_model` 요청마다 `stage`·`model`·
`reasoningEffort` 힌트로 돌려주고, 실제로 어느 모델을 쓸지는 호스트가 정합니다.
로컬 OpenAI 호환 모델은 `provider: "local"`일 때만 요청별로 모델을 바꿉니다.

```json
"modelProfile": {
  "default": { "modelId": "gpt-6-astra", "reasoningEffort": "high" },
  "light": "gpt-5.6-sol",
  "quality": { "reasoningEffort": "medium" }
}
```

정체성과 마무리 단계는 `default`를 그대로 쓰므로, 비용을 줄이더라도 작품 정합성의
기준점은 유지됩니다. 프로필은 workflow에 저장되어 `lore_resume`과 `lore_decide`에도
같은 라우팅이 적용됩니다.
모델 제공사의 현재 명칭과 지원 범위는 [OpenAI 모델 안내](https://developers.openai.com/api/docs/guides/latest-model),
[Claude 모델 상태](https://docs.anthropic.com/en/docs/about-claude/model-deprecations),
[Grok reasoning 안내](https://docs.x.ai/developers/model-capabilities/text/reasoning)에서 확인하세요.
