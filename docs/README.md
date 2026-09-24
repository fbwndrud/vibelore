# vibelore 사용 안내

vibelore는 연결한 AI와 함께 소설을 쓰고, 기존 소설을 세로형 웹툰으로 만드는 로컬 도구입니다.
이 문서는 사용자가 **시작하고, 결과를 확인하고, 수정해서 이어가는 방법**을 안내합니다.

처음이라면 [설치와 첫 작품](GETTING_STARTED.md)부터 읽으세요. 이미 작품이 있다면
[웹툰 만들기](WEBTOON.md) 또는 아래 필요한 항목으로 바로 이동해도 됩니다.

## 사용하기

| 하고 싶은 일 | 안내 |
|---|---|
| 설치하고 첫 소설 쓰기 | [시작 안내](GETTING_STARTED.md) |
| 소설을 웹툰으로 만들고 고치기 | [웹툰 만들기](WEBTOON.md) |
| AI와 vibelore가 각각 무엇을 하는지 이해하기 | [아키텍처 — 요청부터 저장까지](ARCHITECTURE.md) |
| 텍스트·이미지 모델과 비용 경로 확인하기 | [모델 설정](MODELS.md) |
| 멈춘 작업 이어가기, 손수정 반영, 백업하기 | [문제 해결과 백업](TROUBLESHOOTING.md) |
| 원고와 이미지가 어디로 전달되는지 확인하기 | [데이터와 보안](../SECURITY.md) |
| 한국어 외의 언어로 작품 쓰기 | [TOOLS.md — 작품 언어와 분량 단위](TOOLS.md#작품-언어와-분량-단위), [다국어 구현 기록](https://github.com/fbwndrud/vibelore/blob/main/docs/research/MULTILINGUAL_IMPLEMENTATION.md) |
| README 를 다른 언어로 읽기 | [English](../README.en.md) · [日本語](../README.ja.md) · [Español](../README.es.md) · [Français](../README.fr.md) · [繁體中文](../README.zh-Hant.md) · [ไทย](../README.th.md) · [العربية](../README.ar.md) |

소설은 설정·계획 → 초고·검토 → 승인·저장 순서로 진행합니다.
웹툰은 기존 소설 → 방향·참조·칸 수 확인 → 장면 각색·영어 연출 → 생성 전 검증 → 장면 이미지 → 시각 검토 순서입니다.
일반 사용에서는 도구 이름이나 내부 상태를 외우지 않고 채팅으로 요청하면 됩니다.

## 직접 연동하거나 문제를 조사할 때

아래 문서는 호스트 AI·연동 개발자·기여자를 위한 상세 참조입니다.
내부 상태 이름과 호출 예시는 실제 도구 연동이나 문제 조사 시 참고하는 자료입니다.

- [MCP 도구 레퍼런스](TOOLS.md): 인자와 응답, 기본·고급 도구 구분
- [MCP 연결과 응답 계약](MCP.md): 서버와 호스트 사이의 작업 전달
- [웹툰 호스트 실행 규약](reference/WEBTOON_WORKFLOW.md): 기본 장면 경로와 이미지 반입·검토·승인 계약
- [운영·복구 상세 절차](OPERATIONS.md): 실행 상태와 감사 기록, 수동 복구
- [호스트 검증 기록](../HOSTS.md), [설계 원칙](PHILOSOPHY.md)

## 프로젝트 정보

- [변경 사항](../CHANGELOG.md)
- [기여 안내](../CONTRIBUTING.md)
- [라이선스](../LICENSE) · [고지](../NOTICE)
