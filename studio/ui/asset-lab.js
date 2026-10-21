import { command, revision } from "./api.js";
import { assetSlotLabel } from "./dom.js";
import {
  el,
  card,
  note,
  form,
  button,
  select,
  options,
  uid,
  chosenScene,
  stateOptions,
  media,
  details,
} from "./dom.js";
import { generationCommand } from "./production.js";
export function sourcePoint(rect, clientX, clientY, width, height) {
  return {
    x: Math.max(
      0,
      Math.min(
        width - 1,
        Math.floor(((clientX - rect.left) / rect.width) * width),
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        height - 1,
        Math.floor(((clientY - rect.top) / rect.height) * height),
      ),
    ),
  };
}
export function importCommand(
  snapshot,
  slot,
  mediaKind,
  bytes,
  rev = revision(snapshot, "assetSlot", slot.id),
) {
  return command(
    snapshot,
    "asset.import",
    "assetSlot",
    slot.id,
    {
      id: uid("candidate"),
      slot,
      mediaKind,
      bytes: Array.from(bytes),
      actor: "creator",
    },
    rev,
  );
}
export function adoptCommand(
  snapshot,
  slot,
  candidate,
  reason = "자료를 직접 검토하고 채택",
  rev = revision(snapshot, "assetSlot", slot.id),
) {
  return command(
    snapshot,
    "candidate.adopt",
    "assetSlot",
    slot.id,
    {
      slotId: slot.id,
      ...(!snapshot.slots.some((x) => x.id === slot.id)
        ? {
            slot: Object.fromEntries(
              [
                "id",
                "scope",
                "subject",
                "appearanceStateRef",
                "castingStateRef",
                "utteranceId",
                "audioRole",
              ]
                .filter((key) => slot[key] !== undefined)
                .map((key) => [key, slot[key]]),
            ),
          }
        : {}),
      candidateId: candidate.id,
      actor: "creator",
      reason,
      reviewRevision: revision(snapshot, "assetReview", candidate.id),
    },
    rev,
  );
}
export function undoCommand(snapshot, slot) {
  return command(snapshot, "adoption.undo", "assetSlot", slot.id, {
    slotId: slot.id,
    adoptionId: slot.adoptionId,
    actor: "creator",
    reason: "이 슬롯의 이전 채택으로 되돌림",
  });
}
export function slotCandidates(candidates, slot) {
  return candidates.filter(
    (x) =>
      x.mediaKind !== "text" &&
      (!slot ||
        (x.mediaKind === slot.mediaKind &&
          (x.slotId
            ? x.slotId === slot.id
            : x.target.kind === "utterance"
              ? x.target.id === slot.utteranceId
              : x.target.kind === slot.scope.kind &&
                x.target.id === slot.scope.id))),
  );
}
const scopeName = {
  project: "작품 공통",
  production: "제작판",
  scene: "장면",
  shot: "샷",
};
const subjectName = (s, slot) =>
  s.cast.find(
    (r) => r.id === slot.subject.id || r.characterId === slot.subject.id,
  )?.name ??
  (slot.subject.kind === "environment" ? "배경 / 공간" : slot.subject.id);
export function renderAssetLab(c) {
  const google = c.api.bootstrap.providers?.find(p => p.provider === "google");
  const s = c.snapshot,
    scene = chosenScene(c),
    root = el("div", { class: "workspace-grid" }),
    left = el("div"),
    right = el("div");
  const slot = s.slots.find((x) => x.id === c.selection.slot);
  const audioScene = slot?.utteranceId
    ? s.scenes.find((s) => s.utterances.some((u) => u.id === slot.utteranceId))
    : scene;
  const u = audioScene?.utterances.find(
    (u) => u.id === (slot?.utteranceId ?? c.selection.utterance),
  );
  const occurrence = audioScene?.occurrences.find(
    (o) => o.id === u?.speakerOccurrenceId,
  );
  const presentation = audioScene?.presentations.find(
    (p) => p.occurrenceId === occurrence?.id,
  );
  const kind = slot?.mediaKind ?? c.selection.assetKind ?? "image";
  const binding = s.resolvedBindings.find(
    (b) => b.occurrenceId === u?.speakerOccurrenceId && !b.shotId,
  );
  left.append(
    card(
      "에셋 작업실",
      select(
        "작업할 자료",
        kind,
        [
          { value: "image", label: "그림 후보" },
          ...(u ? [{ value: "audio", label: "선택 발화의 음성 후보" }] : []),
        ],
        (value) => {
          c.selection.assetKind = value;
          c.selection.slot = "";
          c.selection.candidate = "";
          c.persist();
          c.render();
        },
      ),
      select(
        "자료 슬롯",
        slot?.id ?? "",
        [
          { value: "", label: "새 자료 슬롯" },
          ...s.slots.map((x) => ({
            value: x.id,
            label: assetSlotLabel(s, x),
          })),
        ],
        (id) => {
          c.selection.slot = id;
          c.selection.assetKind =
            s.slots.find((x) => x.id === id)?.mediaKind ?? kind;
          c.selection.candidate = "";
          c.persist();
          c.render();
        },
      ),
      note(
        slot
          ? `적용 범위 · ${scopeName[slot.scope.kind]} · 대상 ${subjectName(s, slot)} · 외형 ${slot.appearanceStateRef ?? "없음"} · 목소리 상태 ${slot.castingStateRef ?? "없음"}`
          : kind === "audio" && u
            ? `선택 발화 · ${u.text} · 음성 후보를 생성하거나 WAV를 가져올 수 있습니다.`
            : "그림 후보를 생성하거나 PNG를 가져올 수 있습니다.",
      ),
      google?.available && s.budget.availableMicros <= 0
        ? note("생성 가능한 예산이 없습니다. Production에서 프로젝트 예산 한도를 설정하세요. 그림·음원 가져오기와 편집은 계속 사용할 수 있습니다.")
        : null,
    ),
  );
  const candidates = slotCandidates(s.candidates, slot).filter(
    (x) =>
      slot ||
      (x.mediaKind === kind &&
        (kind !== "audio" ||
          (x.target.kind === "utterance" && x.target.id === u?.id))),
  );

  const candidate =
    candidates.find((x) => x.id === c.selection.candidate) ?? candidates.at(-1);
  const suggestedScope = scene ? "scene" : "project";
  const scopeOptions = [
    { value: "project", label: "작품 공통" },
    ...(c.selection.production
      ? [{ value: "production", label: "선택 제작판" }]
      : []),
    ...(scene ? [{ value: "scene", label: "선택 장면" }] : []),
    ...(c.selection.shot ? [{ value: "shot", label: "선택 샷" }] : []),
  ];
  const firstImage = !slot && kind === "image" && candidate &&
    ["project", "production", "scene", "shot"].includes(candidate.target.kind);
  const imageIntent = candidate?.slotIntent ?? candidate?.recipe?.assetIntent;
  // Declare the first bound audio slot only inside the real adoption command.
  // Generation itself targets the utterance and creates no empty aggregate.
  const adoptionSlot =
    slot ??
    (kind === "audio" && candidate && u
      ? (s.slots.find(
          (x) =>
            x.mediaKind === "audio" &&
            x.utteranceId === u.id &&
            x.scope.kind === "scene" &&
            x.scope.id === audioScene.id &&
            x.subject.kind === "role" &&
            x.subject.id === occurrence.roleBindingId &&
            (x.castingStateRef ?? null) ===
              (presentation.castingStateRef ?? null),
        ) ?? {
          id: uid("slot"),
          scope: { kind: "scene", id: audioScene.id },
          subject: { kind: "role", id: occurrence.roleBindingId },
          appearanceStateRef: null,
          castingStateRef: presentation.castingStateRef ?? null,
          utteranceId: u.id,
        })
      : firstImage ? {
          id: uid("slot"),
          scope: candidate.target,
          subject: imageIntent?.subject ?? { kind: "environment", id: "room" },
          appearanceStateRef: imageIntent?.appearanceStateRef ?? null,
        } : null);
  const accepted = s.candidates.find((x) => x.id === adoptionSlot?.candidateId);
  const candidateStale = candidate?.pins?.some(pin => revision(s, pin.kind, pin.id) !== pin.revision) ?? false;
  left.append(
    card(
      "후보 비교",
      select(
        "비교 후보",
        candidate?.id ?? "",
        candidates.map((x) => ({
          value: x.id,
          label: `${x.lineage.kind} · ${x.id.slice(0, 18)}`,
        })),
        (id) => {
          c.selection.candidate = id;
          c.persist();
          c.render();
        },
      ),
      el(
        "div",
        { class: "comparison" },
        media(c, accepted, "현재 채택"),
        media(c, candidate, "선택한 후보"),
      ),
      candidate
        ? details("검사와 실제 요청", candidate)
        : note("아직 후보가 없습니다."),
    ),
  );
  if (adoptionSlot && candidate) {
    right.append(
      card(
        "이 슬롯에 채택",
        note(
          `${scopeName[adoptionSlot.scope.kind]} · ${subjectName(s, adoptionSlot)} · ${adoptionSlot.appearanceStateRef ?? "외형 지정 없음"}`,
        ),
        form(
          c,
          `adopt:${s.slots.some((x) => x.id === adoptionSlot.id) ? adoptionSlot.id : firstImage ? "first-image" : `utterance-${u.id}`}:${candidate.id}`,
          [
            ...(firstImage ? [
              {
                name: "scope", label: "채택 적용 범위", value: adoptionSlot.scope.kind,
                options: scopeOptions,
              },
              {
                name: "subject", label: "채택 그림 대상",
                value: `${adoptionSlot.subject.kind}:${adoptionSlot.subject.id}`,
                options: [
                  { value: "environment:room", label: "배경 / 공간" },
                  ...s.cast.map(r => ({ value: `role:${r.id}`, label: r.name })),
                  ...s.cast.filter(r => r.identity).map(r => ({ value: `identity:${r.characterId}`, label: `인물 · ${r.name}` })),
                ],
              },
              { name: "state", label: "채택 외형 상태", value: adoptionSlot.appearanceStateRef ?? "", options: stateOptions(c) },
            ] : []),
            {
              name: "reason",
              label: "검토 메모",
              value: "자료를 직접 검토하고 채택",
              required: true,
            },
          ],
          async (p, rev) => {
            const [subjectKind, subjectId] = (p.subject ?? "").split(":");
            const destination = firstImage ? {
              ...adoptionSlot,
              scope: {
                kind: p.scope,
                id: p.scope === adoptionSlot.scope.kind ? adoptionSlot.scope.id :
                  p.scope === "project" ? s.project.id : p.scope === "production" ? c.selection.production : p.scope === "scene" ? scene?.id : c.selection.shot,
              },
              subject: { kind: subjectKind, id: subjectId },
              appearanceStateRef: p.state || null,
            } : adoptionSlot;
            await c.send(adoptCommand(s, destination, candidate, p.reason, rev));
            c.selection.slot = destination.id;
          },
          {
            submit: "후보 채택",
            revision: revision(s, "assetSlot", adoptionSlot.id),
            disabled: candidateStale,
            description: candidateStale ? "자료를 만든 뒤 장면·목소리·원작 기준이 바뀌었습니다. 그림·음원을 현재 기준으로 다시 가져오거나 생성한 후 채택하세요." : "",
          },
        ),
        adoptionSlot.candidateId && kind === "image" && scene?.shots.some(sh => sh.id === c.selection.shot) &&
          (adoptionSlot.scope.kind !== "shot" || adoptionSlot.scope.id === c.selection.shot) &&
          (adoptionSlot.scope.kind !== "scene" || adoptionSlot.scope.id === scene.id) &&
          (adoptionSlot.scope.kind !== "production" || adoptionSlot.scope.id === scene.productionId)
          ? button("선택 샷에 사용", () => c.run(async () => {
              await c.send(command(s, "scene.put", "scene", scene.id, {
                ...scene,
                shots: scene.shots.map(sh => sh.id === c.selection.shot ? { ...sh, referenceSlotId: adoptionSlot.id } : sh),
              }, revision(s, "scene", scene.id)));
              await c.refresh(true);
            }))
          : null,
        adoptionSlot.adoptionId
          ? button("이 슬롯 채택 되돌리기", () =>
              c.run(async () => {
                await c.send(undoCommand(s, adoptionSlot));
                await c.refresh(true);
              }),
            )
          : null,
        note("되돌림도 새 결정으로 기록됩니다. 후보 파일과 이력은 남습니다."),
      ),
    );
  }
  right.append(
    card(
      slot ? "이 슬롯에 자료 추가" : "새 자료 가져오기",
      form(
        c,
        `asset-import:${slot?.id ?? "new"}`,
        [
          {
            name: "file",
            label: "PNG 그림 / WAV 음원",
            type: "file",
            accept: ".png,.wav,image/png,audio/wav",
            required: true,
          },
          ...(!slot
            ? [
                {name:"audioRole",label:"WAV 음원 용도",value:"speech-take",options:[{value:"speech-take",label:"선택 발화의 음성"},{value:"music",label:"독립 음악"},{value:"sfx",label:"독립 효과음"}]},
                {
                  name: "scope",
                  label: "적용 범위",
                  value: suggestedScope,
                  options: scopeOptions,
                },
                {
                  name: "subject",
                  label: "그림 대상",
                  value: "environment:room",
                  options: [
                    { value: "environment:room", label: "배경 / 공간" },
                    ...s.cast.map((r) => ({
                      value: `role:${r.id}`,
                      label: r.name,
                    })),
                  ],
                },
                {
                  name: "state",
                  label: "그림의 외형 상태",
                  options: stateOptions(c),
                },
              ]
            : []),
        ],
        async (p, rev) => {
          if (!p.file) throw new Error("파일을 선택하세요.");
          const kind = /\.wav$/i.test(p.file.name) ? "audio" : "image";
          let declaration = slot
            ? Object.fromEntries(
                [
                  "id",
                  "scope",
                  "subject",
                  "appearanceStateRef",
                  "castingStateRef",
                  "utteranceId",
                  "audioRole",
                ]
                  .filter((k) => slot[k] !== undefined)
                  .map((k) => [k, slot[k]]),
              )
            : null;
          if (!declaration) {
            const id = uid("slot");
            if (kind === "audio" && ['music','sfx'].includes(p.audioRole)) {
              declaration={id,scope:{kind:p.scope,id:p.scope==='project'?s.project.id:p.scope==='production'?c.selection.production:p.scope==='scene'?scene?.id:c.selection.shot},subject:{kind:'environment',id:'sound'},appearanceStateRef:null,audioRole:p.audioRole};
            } else if (kind === "audio") {
              if (!u) throw new Error("Edit에서 발화를 먼저 선택하세요.");
              declaration = {
                id,
                scope: { kind: "scene", id: scene.id },
                subject: { kind: "role", id: occurrence.roleBindingId },
                appearanceStateRef: null,
                castingStateRef: presentation.castingStateRef ?? null,
                utteranceId: u.id,
              };
            } else {
              const [kind, idSubject] = p.subject.split(":");
              declaration = {
                id,
                scope: {
                  kind: p.scope,
                  id:
                    p.scope === "project"
                      ? s.project.id
                      : p.scope === "production"
                        ? c.selection.production
                        : p.scope === "scene"
                          ? scene.id
                          : c.selection.shot,
                },
                subject: { kind, id: idSubject },
                appearanceStateRef: p.state || null,
              };
            }
          }
          const result = await c.send(
            importCommand(
              s,
              declaration,
              kind,
              new Uint8Array(await p.file.arrayBuffer()),
              slot ? rev : 0,
            ),
          );
          c.selection.slot = declaration.id;
          c.selection.candidate = result.value.candidate?.id ?? "";
        },
        {
          submit: "파일 가져오기",
          revision: slot ? revision(s, "assetSlot", slot.id) : 0,
          description: "WAV 용도를 고르세요. 독립 음악·효과음에는 발화나 목소리 배정이 필요 없습니다. 가져온 후보는 별도로 채택합니다.",
        },
      ),
    ),
  );
  const models = google?.catalog?.[kind] ?? [];
  right.append(
    card(
      kind === "audio" ? "이 발화 음성 만들기" : "그림 후보 만들기",
      note(
        google?.available
          ? "Google 생성이 연결되어 있습니다. 계정 권한과 한도는 실제 요청 시 확인됩니다."
          : "Google 생성 키가 설정되지 않았습니다. 파일 가져오기는 사용할 수 있습니다.",
      ),
      details("생성 서비스 정보", {
        API: google?.surface ?? "미설정",
        models,
        안내: "모델 목록은 계정 사용 권한이나 품질 보증이 아닙니다.",
      }),
      google?.available &&
        (kind === "audio"
          ? u && binding?.casting.status === "resolved"
          : slot || c.selection.shot)
        ? form(
            c,
            `generation:${kind}:${slot?.id ?? (kind === "audio" ? u?.id : c.selection.shot)}`,
            [
              {
                name: "model",
                label: "모델",
                options: models.map((m) => ({ value: m, label: m })),
              },
              ...(kind === "image"
                ? [
                    {
                      name: "prompt",
                      label: "생성 / 수정 지시",
                      type: "textarea",
                      required: true,
                    },
                    {
                      name: "operation",
                      label: "편집 방식",
                      options: [
                        { value: "generate", label: "전체 이미지 후보" },
                        {
                          value: "protected_edit",
                          label: "보호 편집용 원출력",
                        },
                      ],
                    },
                  ]
                : []),
              {
                name: "estimate",
                label: "이번 요청 예약 추정액 (USD)",
                type: "number",
                min: 0,
                step: "0.01",
                required: true,
                help: "사용자가 정한 예약 추정치입니다. Google 실제 요금이 아닙니다.",
              },
            ],
            async (p) => {
              const target = slot
                ? { kind: "assetSlot", id: slot.id }
                : kind === "audio"
                  ? { kind: "utterance", id: u.id }
                  : { kind: "shot", id: c.selection.shot };
              const input = {
                model: p.model,
                prompt: kind === "audio" ? u.text : p.prompt,
                config:
                  kind === "audio"
                    ? { voice: binding?.casting.voice, acting: u.acting ?? "" }
                    : { aspectRatio: "16:9", imageSize: "1K" },
                ...(kind === "image" && accepted?.mediaKind === "image"
                  ? { blobIds: [accepted.blobId] }
                  : {}),
              };
              await c.send(
                generationCommand(s, {
                  kind,
                  target,
                  input,
                  estimateMicros: Math.round(Number(p.estimate) * 1e6),
                  recipe: { operation: p.operation ?? "speech" },
                }),
              );
            },
            { submit: "예약하고 후보 요청", disabled: s.budget.availableMicros <= 0 },
          )
        : note(
            kind === "audio"
              ? "Edit에서 발화를 선택하고 Cast에서 목소리를 배정하세요."
              : "그림 슬롯 또는 샷을 선택하세요.",
          ),
    ),
  );
  if (
    slot?.mediaKind === "image" &&
    accepted &&
    candidate &&
    accepted.id !== candidate.id
  )
    left.append(maskEditor(c, slot, accepted, candidate));
  left.append(
    card(
      "공통 참조 사용 제안",
      note("기존 샷 채택은 자동 교체되지 않습니다."),
      details(
        "사용처",
        s.usageProposals.filter((p) => p.slotId === slot?.id),
      ),
    ),
    card(
      "가져오기 검사",
      s.quarantines.length
        ? s.quarantines.map((q) => note(`사용 불가 · ${q.code} · 원본 보존`))
        : note("격리된 자료가 없습니다."),
    ),
  );
  root.append(left, right);
  return root;
}
function maskEditor(c, slot, base, candidate) {
  const width = base.metadata.width,
    height = base.metadata.height;
  const root = card(
    "영역 보호 합성",
    note(
      "원출력과 별개의 새 합성 후보를 만듭니다. 칠한 영역 밖의 픽셀이 원본과 같은지 검사합니다.",
    ),
  );
  if (
    width !== candidate.metadata.width ||
    height !== candidate.metadata.height
  ) {
    root.append(
      note(
        "크기가 달라 대응 좌표를 확인할 수 없습니다. 보호 합성은 사용할 수 없습니다.",
      ),
    );
    return root;
  }
  const key = `mask:${base.id}:${candidate.id}`,
    draft = c.drafts.get(key)?.value ?? {
      points: [],
      radius: Math.max(1, Math.round(width / 40)),
    };
  const canvas = el("canvas", {
      width,
      height,
      tabIndex: 0,
      "aria-label": "원본 좌표에서 수정 영역 칠하기",
    }),
    mask = document.createElement("canvas");
  mask.width = width;
  mask.height = height;
  const ctx = canvas.getContext("2d"),
    m = mask.getContext("2d");
  let image;
  const repaint = () => {
    ctx.clearRect(0, 0, width, height);
    if (image) ctx.drawImage(image, 0, 0);
    m.fillStyle = "black";
    m.fillRect(0, 0, width, height);
    for (const p of draft.points) {
      m.fillStyle = "white";
      m.beginPath();
      m.arc(p.x, p.y, draft.radius, 0, Math.PI * 2);
      m.fill();
      ctx.fillStyle = "rgba(33,143,111,.5)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, draft.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  c.api.blob(base).then((url) => {
    c.urls.add(url);
    image = new Image();
    image.onload = repaint;
    image.src = url;
  });
  const info = note(
    `원본 ${width} × ${height} · 칠한 점 ${draft.points.length}`,
  );
  const paint = (e) => {
    const p = sourcePoint(
      canvas.getBoundingClientRect(),
      e.clientX,
      e.clientY,
      width,
      height,
    );
    draft.points.push(p);
    c.drafts.set(key, draft, slot.revision);
    c.persist();
    info.textContent = `원본 ${width} × ${height} · x ${p.x}, y ${p.y} · 칠한 점 ${draft.points.length}`;
    repaint();
  };
  let drawing = false;
  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    paint(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drawing) paint(e);
  });
  canvas.addEventListener("pointerup", () => (drawing = false));
  root.append(
    canvas,
    info,
    button("마스크 지우기", () => {
      draft.points = [];
      c.drafts.set(key, draft, slot.revision);
      c.persist();
      repaint();
    }),
    form(
      c,
      `mask-rect:${base.id}`,
      [
        { name: "x", label: "영역 x", type: "number", value: 0, min: 0 },
        { name: "y", label: "영역 y", type: "number", value: 0, min: 0 },
        {
          name: "radius",
          label: "브러시 반지름 (원본 픽셀)",
          type: "number",
          value: draft.radius,
          min: 1,
        },
      ],
      async (p) => {
        draft.radius = Number(p.radius);
        draft.points.push({ x: Number(p.x), y: Number(p.y) });
        c.drafts.set(key, draft, slot.revision);
        c.persist();
        repaint();
      },
      { submit: "좌표로 영역 추가" },
    ),
    button(
      "보호 합성 후보 저장",
      () =>
        c.run(async () => {
          if (!draft.points.length) throw new Error("수정 영역을 칠하세요.");
          const blob = await new Promise((resolve) =>
            mask.toBlob(resolve, "image/png"),
          );
          const result = await c.send(
            command(
              c.snapshot,
              "asset.derive",
              "assetSlot",
              slot.id,
              {
                id: uid("composite"),
                slotId: slot.id,
                baseCandidateId: base.id,
                candidateId: candidate.id,
                actor: "creator",
                operation: "protected_edit",
                geometry: { kind: "identity" },
                maskBytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
              },
              slot.revision,
            ),
          );
          c.selection.candidate = result.value.candidate.id;
          await c.refresh(true);
        }),
      { class: "primary" },
    ),
  );
  return root;
}
