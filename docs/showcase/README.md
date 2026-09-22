# Showcase

정적 공개 뷰어. 빌드 도구 없이 GitHub Pages(소스: `main` 브랜치 `/docs`)로 그대로 서빙합니다.

| 경로 | 내용 |
|---|---|
| `thundertrail/index.html` | 『길 위의 번개』 1~3화 리더. 회차 = 각색 호스트(Codex / Claude / Grok). 웹툰·나란히·소설 보기, 장면별 검토 판정과 근거, 실제 영어 프롬프트·각색 JSON·검토 결과 열람. |
| `thundertrail/compare.html` | 호스트별 스코어카드(장면·칸·판정·차단 근거 귀속·각색 CLI 비용), 첫 장면 나란히, 장면별 히트맵, 결함 귀속, 직접 해보기. |
| `thundertrail/data.json` | 두 페이지의 단일 데이터 소스. 장면별 원문 단락, 계획(plan), 렌더 브리프, 시각 검토, 타이밍, 판정. |
| `thundertrail/img/` | 장면 이미지 25장(WebP, 1024×1536). 원본 PNG는 저장소 밖 제작 폴더에 보관. |

`data.json`은 저장소에 포함되지 않는 제작 실행 산출물(`tmp/scene-20260921/`, `works/thundertrail/production-workspaces/scene-run-20260921/`)에서 생성합니다. 수치는 모두 CLI·API 실행 기록에서 읽은 값이며, 검토 판정은 오케스트레이션 호스트의 자기검토입니다.

로컬 확인:

```bash
python3 -m http.server 8765 --directory docs/showcase/thundertrail
```
