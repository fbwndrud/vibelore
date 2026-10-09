import { keyframeEditor, cameraSuggestions, actingText, actingSuggestions, legacyActing } from './camera.js';
import { renderPreview, renderWorkingShot } from "./player.js";
import { command, revision, utteranceCommand } from "./api.js";
import { assetSlotLabel, slotInContext } from "./dom.js";
import {
  el,
  card,
  suggestedCard,
  note,
  form,
  select,
  options,
  uid,
  chosenScene,
  details,
  media,
} from "./dom.js";
export function shotCommand(
  snapshot,
  sceneId,
  shotId,
  patch,
  expectedRevision = revision(snapshot, "scene", sceneId),
) {
  const scene = structuredClone(snapshot.scenes.find((s) => s.id === sceneId));
  const index = scene.shots.findIndex((sh) => sh.id === shotId);
  const shot = { ...(scene.shots[index] ?? { id: shotId }), ...patch };
  if (index < 0) scene.shots.push(shot);
  else scene.shots[index] = shot;
  return command(
    snapshot,
    "scene.put",
    "scene",
    sceneId,
    scene,
    expectedRevision,
  );
}
export function renderEdit(c) {
  const s = c.snapshot,
    scene = chosenScene(c);
  if (!scene)
    return card(
      "장면을 선택하세요",
      note("Story에서 장면을 만든 뒤 대사와 샷을 편집할 수 있습니다."),
    );
  const root = el("div", { class: "workspace-grid" });
  const left = el("div"),
    right = el("div");
  const u =
    scene.utterances.find((u) => u.id === c.selection.utterance) ??
    scene.utterances[0];
  const shot = scene.shots.find((sh) => sh.id === c.selection.shot);
  const workingShot = shot ? renderWorkingShot(c, scene, shot) : null;
  if (workingShot) left.append(workingShot.root);
  left.append(renderPreview(c));
  if (u) {
    const originalActingText = actingText(u.acting);
    const previousActing = legacyActing(c.drafts.get(`utterance:${u.id}`)?.value.acting);
    let actingForm;
    const occurrence = scene.occurrences.find(
      (o) => o.id === u.speakerOccurrenceId,
    );
    const role = s.cast.find((r) => r.id === occurrence.roleBindingId);
    right.append(
      card(
        "발화 연기",
        select(
          "발화 선택",
          u.id,
          scene.utterances.map((u) => ({
            value: u.id,
            label: u.text.slice(0, 45),
          })),
          (id) => {
            c.selection.utterance = id;
            c.selection.occurrence = scene.utterances.find(
              (u) => u.id === id,
            ).speakerOccurrenceId;
            c.persist();
            c.render();
          },
        ),
        note(`${role?.name} · ${{onscreen:'화면 속',narrator:'해설',offscreen:'화면 밖',voiceover:'보이스오버',internal:'속마음',crowd:'군중'}[occurrence.presence] ?? '출현'} · 이 발화만 저장`),
        actingForm = form(
          c,
          `utterance:${u.id}`,
          [
            {
              name: "text",
              label: "대사",
              type: "textarea",
              value: u.text,
              required: true,
            },
            {
              name: "acting",
              label: "연기 지시",
              normalize: v => actingText(legacyActing(v)),
              serializeDraft: v => previousActing && typeof previousActing === 'object' && v === actingText(previousActing) ? previousActing : v === originalActingText ? u.acting ?? '' : v,
              type: "textarea",
              value:
                originalActingText,
            },
            {
              name: "holdMs",
              label: "대답 전 기다림 (밀리초)",
              type: "number",
              value: u.holdMs ?? 0,
              min: 0,
            },
            { name: "intent", label: "말하는 목적", value: u.intent ?? "" },
            { name: "subtext", label: "속뜻", value: u.subtext ?? "" },
          ],
          async (p, rev) =>
            c.send(
              utteranceCommand(
                s,
                u.id,
                Object.fromEntries(
                  Object.entries({
                    ...p,
                    acting: previousActing && typeof previousActing === "object" && p.acting === actingText(previousActing) ? previousActing : p.acting === originalActingText ? u.acting ?? "" : p.acting,
                    holdMs: Number(p.holdMs),
                  }).filter(
                    ([key, value]) => !(value === "" && u[key] == null),
                  ),
                ),
                rev,
              ),
            ),
          { revision: revision(s, "utterance", u.id), submit: "이 발화 저장" },
        ),
        actingSuggestions(actingForm),
        note(`적용 목소리 · ${s.resolvedBindings.find(b => b.occurrenceId === occurrence.id)?.casting?.voice ?? '미배정'} · Cast에서 변경`),
        details(
          "출현과 목소리 해석",
          s.resolvedBindings.filter((b) => b.occurrenceId === occurrence.id),
        ),
      ),
    );
    const takes = s.candidates.filter(
      (x) =>
        x.mediaKind === "audio" &&
        (x.utteranceId === u.id ||
          x.target.id === u.id ||
          x.slotIntent?.utteranceId === u.id),
    );
    left.append(
      card(
        "실제 음성 테이크",
        note(
          "파일 재생으로 비교하세요. 가져온 음원의 대사와 목소리는 자동 검증되지 않습니다.",
        ),
        takes.length
          ? takes.map((t) => media(c, t, t.id.slice(0, 16)))
          : note("가져오거나 생성한 음원이 없습니다."),
      ),
    );
  }
  right.append(
    card(
      "발화 추가",
      form(
        c,
        `new-utterance:${scene.id}`,
        [
          {
            name: "speaker",
            label: "화자 출현",
            options: scene.occurrences.map((o) => ({
              value: o.id,
              label: `${s.cast.find((r) => r.id === o.roleBindingId)?.name} · ${o.presence}`,
            })),
          },
          { name: "text", label: "대사", type: "textarea", required: true },
        ],
        async (p, rev) => {
          const id = uid("utterance");
          await c.send(
            command(
              s,
              "scene.put",
              "scene",
              scene.id,
              {
                ...scene,
                utterances: [
                  ...scene.utterances,
                  {
                    id,
                    speakerOccurrenceId: p.speaker,
                    addresseeOccurrenceIds: [],
                    text: p.text,
                    holdMs: 0,
                  },
                ],
              },
              rev,
            ),
          );
          c.selection.utterance = id;
        },
        { revision: revision(s, "scene", scene.id), submit: "발화 추가" },
      ),
    ),
  );
  const sh = shot ?? { id: uid("shot") },
    tr = sh.transform ?? {};
  let cameraForm;
  right.append(
    suggestedCard(
      shot ? "샷 연출" : "새 샷",
      note("카메라 의도 저장은 이미지·음성 생성 비용이 없습니다."),
      cameraForm = form(
        c,
        `shot:${scene.id}:${shot?.id ?? "new"}`,
        [
          { name: "title", label: "샷 이름", value: sh.title ?? "" },
          {
            name: "intent",
            label: "의도",
            value: sh.intent ?? "wide",
            options: ["wide", "close", "reaction", "insert"].map((v) => ({
              value: v,
              label: { wide: '전체 공간', close: '인물 가까이', reaction: '반응', insert: '소품 / 디테일' }[v],
            })),
          },
          {
            name: "target",
            label: "화면 속 대상",
            value: sh.targetOccurrenceId ?? "",
            options: [
              { value: "", label: "특정 인물 없음" },
              ...scene.occurrences
                .filter((o) => o.presence === "onscreen")
                .map((o) => ({
                  value: o.id,
                  label:
                    s.cast.find((r) => r.id === o.roleBindingId)?.name ?? o.id,
                })),
            ],
          },
          {
            name: "prop",
            advanced: true,
            label: "소품 대상 (선택)",
            value: sh.propTarget ?? "",
          },
          {
            name: "referenceSlotId",
            label: "참조 이미지 슬롯",
            value: sh.referenceSlotId ?? "",
            options: [
              { value: "", label: "아직 없음" },
              ...s.slots.filter(x => x.mediaKind === "image" && slotInContext(x, s, scene, shot?.id))
                .map(x => ({ value: x.id, label: assetSlotLabel(s, x) })),
            ],
          },
          ...["x", "y", "scale"].map((name) => ({
            name,
            advanced: true,
            label: {
              x: "가로 이동",
              y: "세로 이동",
              scale: "확대 배율",
            }[name],
            type: "number",
            step: "0.01",
            value: tr[name] ?? (name === "scale" ? 1 : 0),
          })),
          ...["Left", "Top", "Right", "Bottom"].map((edge) => ({
            name: `safeArea${edge}`,
            advanced: true,
            label: `안전 영역 · ${{ Left: "왼쪽", Top: "위쪽", Right: "오른쪽", Bottom: "아래쪽" }[edge]}`,
            type: "number",
            min: 0,
            max: 0.5,
            step: "0.01",
            value: tr.safeArea?.[edge.toLowerCase()] ?? 0,
          })),
          {
            name: "anchor",
            advanced: true,
            label: "기준점",
            value: tr.anchor ?? "center",
            options: ["center", "top", "bottom"].map((v) => ({
              value: v,
              label: { center: '중앙', top: '위쪽', bottom: '아래쪽' }[v],
            })),
          },
          {
            name: "easing",
            advanced: true,
            label: "이동 곡선",
            value: tr.easing ?? "linear",
            options: ["linear", "ease-in-out"].map((v) => ({
              value: v,
              label: { linear: '일정한 속도', 'ease-in-out': '부드럽게 시작·끝' }[v],
            })),
          },
          {
            name: "keyframes",
            label: "시간별 카메라 위치",
            render: keyframeEditor,
            value: JSON.stringify(tr.keyframes ?? []),
            help: "시점 사이의 이동은 선택한 이동 곡선을 따릅니다.",
          },
        ],
        async (p, rev) => {
          await c.send(
            shotCommand(
              s,
              scene.id,
              sh.id,
              {
                title: p.title,
                intent: p.intent,
                targetOccurrenceId: p.target || null,
                propTarget: p.prop || null,
                referenceSlotId: p.referenceSlotId || null,
                transform: {
                  x: Number(p.x),
                  y: Number(p.y),
                  scale: Number(p.scale),
                  safeArea: {
                    left: Number(p.safeAreaLeft),
                    top: Number(p.safeAreaTop),
                    right: Number(p.safeAreaRight),
                    bottom: Number(p.safeAreaBottom),
                  },
                  anchor: p.anchor,
                  easing: p.easing,
                  keyframes: JSON.parse(p.keyframes),
                },
              },
              rev,
            ),
          );
          c.selection.shot = sh.id;
        },
        { revision: revision(s, "scene", scene.id), submit: "샷 연출 저장", onDraft: workingShot?.update },
      ),
      cameraSuggestions(cameraForm, tr),
    ),
  );
  root.append(left, right);
  return root;
}
