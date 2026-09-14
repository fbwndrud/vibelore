# Deterministic Replay Suite — ADR Plan Pillar 8.6 / issue #213

이 디렉터리는 `RecordingProvider` (test/recording-provider.ts) 의 replay 모드
실행을 위한 fixture + 테스트.

## 명령어

```bash
# 일반 unit 테스트 (replay 포함 X)
pnpm --filter @vibelore/engine test

# replay-only 실행 — cost=0 deterministic
pnpm --filter @vibelore/engine run test:e2e:replay
```

## Fixture 갱신

`sample.fixture.jsonl` 같은 fixture 는 처음 record mode 로 한 번 실 LLM 실행
후 commit. 갱신은 환경변수로:

```bash
ENGINE_REPLAY_MODE=record OPENAI_API_KEY=... pnpm --filter @vibelore/engine test test/replay/<file>.test.ts
```

record 모드는 fixture 파일을 truncate 후 새로 작성. PR diff 로 변화 검토.

## 후속 (별 PR)

- 30-chapter 작품 fixture (3-Arc, ~$0.5 record cost) — Phase 1 머지 후
- engineVersion (ADR-0006) 별 fixture 분리
- CI 의 regression suite job (현재는 일반 test job 안 포함)
