import { renderBackup } from './backup.js';
import { renderPreview } from './player.js';
import { command, revision } from "./api.js";
import { el, card, note, form, button, uid, details } from "./dom.js";
export function generationCommand(
  snapshot,
  {
    kind,
    target,
    input,
    estimateMicros,
    recipe = {},
    intent = "reuse_or_generate",
  },
) {
  const id = uid("request");
  return command(snapshot, "generation.request", "generation", id, {
    subscriberId: id,
    target,
    provider: "google",
    kind,
    input,
    estimateMicros,
    recipe,
    intent,
    context: {
      accountId: "configured-google",
      policyRevision: "studio-v1",
      authorizationRevision: "local-v1",
      sourceVisibility: "selected",
    },
  });
}
const statusName = {
  queued: "대기 중",
  prepared: "전송 준비",
  running: "실행 중",
  dispatching: "전송 중",
  outcome_unknown: "결과 불명",
  candidate_ready: "후보 도착",
  pending_validation: "자료 검사 중",
  succeeded: "자료 수신",
  failed_definite: "실행 불가",
  held_unknown: "청구 불명 보류",
  reserved: "추정액 예약",
  released: "예약 해제",
  settled: "정산 기록됨",
  blocked_source_review: "원천 검토 필요",
  quarantined: "자료 격리",
};
const targetName = (s, target) =>
  target.kind === "shot"
    ? (s.scenes.flatMap((sc) => sc.shots).find((sh) => sh.id === target.id)
        ?.title ?? "선택 샷")
    : target.kind === "scene"
      ? (s.scenes.find((sc) => sc.id === target.id)?.title ?? "선택 장면")
      : target.kind === "utterance"
        ? "선택 발화"
        : target.kind === "assetSlot"
          ? "선택 자료"
          : "선택 대상";
const slotName = (s, id) => {
  const slot = s.slots.find((x) => x.id === id);
  return slot
    ? `${{ project: "작품 공통", production: "제작판", scene: "장면", shot: "샷" }[slot.scope.kind]} · ${s.cast.find((r) => r.id === slot.subject.id || r.characterId === slot.subject.id)?.name ?? "배경 / 공간"} · ${slot.mediaKind === "audio" ? "음성" : "그림"}`
    : "자료 슬롯";
};
const money = (n) => `$${(n / 1e6).toFixed(4)}`;
export function renderProduction(c) {
  const s = c.snapshot;
  const root = el("div", { class: "production-view" });
  if (c.selection.production) root.append(renderPreview(c));
  root.append(
    card(
      "제작 예산",
      form(
        c,
        `budget:${s.project.id}`,
        [{ name: "budget", label: "프로젝트 예산 한도 (USD)", type: "number", min: 0, step: "0.01", required: true, value: s.budget.budgetMicros / 1e6 }],
        async (p, rev) => c.send(command(s, "project.budget.set", "project", s.project.id, { budgetMicros: Math.round(Number(p.budget) * 1e6) }, rev)),
        { submit: "예산 한도 저장", revision: revision(s, "project", s.project.id), description: "앱의 생성 요청 한도입니다. 예약·청구 보류·정산 금액보다 낮출 수 없습니다." },
      ),
      el(
        "div",
        { class: "metrics" },
        ...[
          ["발급 가능", s.budget.availableMicros],
          ["예약 추정", s.budget.reservedEstimateMicros],
          ["청구 불명 보류", s.budget.heldUnknownEstimateMicros],
          ["확인 입력된 실제 비용", s.budget.settledActualMicros],
        ].map(([label, value]) =>
          el(
            "div",
            { class: "metric" },
            note(label),
            el("strong", {}, money(value)),
          ),
        ),
      ),
    ),
    card(
      "새 제작판",
      form(
        c,
        "new-production",
        [
          { name: "title", label: "제작판 이름", required: true },
          {
            name: "source",
            label: "원천 자료",
            options: [
              { value: "", label: "빈 제작판" },
              ...s.sourcePackages.map((p) => ({
                value: p.id,
                label: p.title ?? p.id,
              })),
            ],
          },
        ],
        async (p) => {
          const id = uid("production");
          await c.send(
            command(s, "production.create", "production", id, {
              id,
              title: p.title,
              sourcePackageId: p.source || null,
            }),
          );
          c.selection.production = id;
        },
        { submit: "제작판 만들기", id: "production-editor" },
      ),
    ),
  );
  if (!s.jobs.length)
    root.append(
      card(
        "아직 실행한 작업이 없습니다",
        note(
          "Story와 Asset Lab에서 후보를 요청하면 고정 입력, 진행 상태와 예산 예약이 여기에 표시됩니다.",
        ),
      ),
    );
  for (const job of s.jobs) {
    const attempt = s.attempts.find((a) => a.id === job.currentAttemptId),
      reservation = s.reservations.find((r) => r.attemptId === attempt?.id);
    const row = card(
      `${{ image: "그림", audio: "음성", text: "각색" }[job.request.kind]} · ${statusName[job.status] ?? job.status}`,
      note(`요청 대상 · ${targetName(s, job.request.target)}`),
      note(
        `시도 ${statusName[attempt.status] ?? attempt.status} · 예산 ${statusName[reservation?.status] ?? "없음"}`,
      ),
      details("고정 요청과 반환 근거", {
        request: attempt.request,
        operationId: attempt.operationId,
        providerRequestId: attempt.providerRequestId,
        resolvedModel: attempt.resolvedModel ?? "unknown",
        returnedModel: attempt.returnedModel ?? "unknown",
        returnedVoice: attempt.returnedVoice ?? "unknown",
        usage: attempt.usage ?? "unknown",
        providerFailure: attempt.providerFailure ?? null,
        reservation,
      }),
    );
    if (attempt.status === "outcome_unknown") {
      row.append(
        note(
          attempt.operationId
            ? "결과가 불명확합니다. 저장된 Interaction ID로 명시적으로 조회할 수 있습니다."
            : "응답 ID가 없어 원격 결과 회수를 보장할 수 없습니다. 자동 재전송하지 않습니다.",
        ),
      );
      row.append(
        button(
          "저장된 결과 조회",
          () =>
            c.run(async () => {
              await c.send(
                command(s, "attempt.reconcile", "attempt", attempt.id, {
                  attemptId: attempt.id,
                  action: "inspect",
                }),
              );
              await c.refresh(true);
            }),
          { disabled: !attempt.operationId || !attempt.inspectSupported },
        ),
      );
    }
    if (["outcome_unknown", "failed_definite"].includes(attempt.status))
      row.append(
        form(
          c,
          `retry:${attempt.id}`,
          [
            {
              name: "risk",
              label: "중복 청구 가능성 수락",
              options: [
                { value: "no", label: "아직 수락하지 않음" },
                { value: "yes", label: "별도 요청의 중복 청구 가능성 수락" },
              ],
            },
            {
              name: "estimate",
              label: "새 시도 예약 추정액 (USD)",
              type: "number",
              min: 0,
              step: "0.01",
              required: true,
            },
          ],
          async (p, rev) => {
            if (attempt.status === "outcome_unknown" && p.risk !== "yes")
              throw new Error("중복 청구 가능성을 명시적으로 수락해야 합니다.");
            await c.send(
              command(
                s,
                "attempt.retry",
                "job",
                job.id,
                {
                  attemptId: attempt.id,
                  acceptDuplicateChargeRisk: p.risk === "yes",
                  estimateMicros: Math.round(Number(p.estimate) * 1e6),
                },
                rev,
              ),
            );
          },
          { submit: "새 시도 요청", revision: revision(s, "job", job.id) },
        ),
      );
    if (reservation?.status === "held_unknown") {
      row.append(
        note(
          attempt.status === "succeeded"
            ? "자료는 도착했습니다. 실제 청구 근거가 없어 예산 추정액을 보류 중입니다."
            : "전송 결과와 청구 여부를 확인할 때까지 예약을 보류합니다.",
        ),
        form(
          c,
          `billing:${attempt.id}`,
          [
            {
              name: "amount",
              label: "보수적으로 청구 처리할 금액 (USD)",
              type: "number",
              min: 0,
              step: "0.01",
              required: true,
            },
            { name: "reference", label: "판단 근거 / 메모", required: true },
          ],
          async (p, rev) =>
            c.send(
              command(
                s,
                "attempt.reconcile",
                "attempt",
                attempt.id,
                {
                  attemptId: attempt.id,
                  action: "billing",
                  evidence: {
                    kind: "conservative_charge",
                    amountMicros: Math.round(Number(p.amount) * 1e6),
                    actor: "creator",
                    reference: p.reference,
                  },
                },
                rev,
              ),
            ),
          {
            submit: "사용자 판단으로 보수적 정산",
            revision: revision(s, "attempt", attempt.id),
          },
        ),
      );
    }
    if (job.subscribers.some((sub) => sub.status === "attached"))
      row.append(
        note("전송한 요청은 취소 후에도 완료되거나 청구될 수 있습니다."),
        button(`${targetName(s, job.request.target)} 요청 취소`, () =>
          c.run(async () => {
            await c.send(
              command(s, "job.cancel", "job", job.id, { jobId: job.id }),
            );
            await c.refresh(true);
          }),
        ),
      );
    root.append(row);
  }
  root.append(
    card(
      "채택 이력",
      s.adoptions.length
        ? s.adoptions.map((a) =>
            note(
              `${a.action === "undo" ? "되돌림" : "채택"} · ${slotName(s, a.slotId)} · ${a.reason}`,
            ),
          )
        : note("채택한 자료가 없습니다."),
      details("결정 식별 정보", s.adoptions),
    ),
  );
  root.append(renderBackup(c));
  return root;
}
