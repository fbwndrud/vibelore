import { command } from "./api.js";
import { card, note, button, uid } from "./dom.js";
export function renderBackup(c) {
  const s = c.snapshot,
    latest = s.backups?.filter((b) => b.available).at(-1),
    restored = s.restores?.filter((r) => r.available).at(-1);
  return card(
    "백업과 복구",
    note(
      "원고·그림·음성·고정판을 함께 보존합니다. 백업 폴더를 다른 저장 장치에 복사해 보관하세요.",
    ),
    button("프로젝트 백업 만들기", () =>
      c.run(async () => {
        await c.send(command(s, "project.backup", "project", s.project.id, {}));
        await c.refresh(true);
      }),
    ),
    ...(latest
      ? [
          note(
            `저장 위치 (작업실 폴더 기준): ${latest.archive} · ${latest.blobCount}개 자료`,
          ),
          button("새 폴더로 복원", () =>
            c.run(async () => {
              await c.send(
                command(s, "project.restore", "project", s.project.id, {
                  backupId: latest.backupId,
                  restoreId: uid("restored"),
                }),
              );
              await c.refresh(true);
            }),
          ),
        ]
      : []),
    ...(restored
      ? [
          note(`복원 위치 (작업실 폴더 기준): ${restored.directory}`),
          note(
            "복원본을 열려면 현재 서버를 종료하고 복원 위치를 --project로 지정해 Studio를 시작하세요. 원본 작업실은 그대로 유지됩니다.",
          ),
          note(
            "복원된 미완료 생성은 결과 불명으로 보류됩니다. 공급자 결과 조회 또는 중복 과금 위험을 승인한 새 실행이 필요합니다.",
          ),
        ]
      : []),
    note(
      `시작 검사: 정상 ${s.integrity?.available ?? 0} · 누락 ${s.integrity?.missing.length ?? 0} · 손상 ${s.integrity?.corrupt.length ?? 0}`,
    ),
  );
}
