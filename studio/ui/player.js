import { drawFrame } from "../render/frame.js";
import { command, revision } from "./api.js";
import { el, card, note, button, select, uid, details, form } from "./dom.js";
export const playbackFrame = (time, fps, durationFrames) =>
  Math.min(durationFrames - 1, Math.max(0, Math.round(time * fps)));
const clock = (t) =>
  `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60).toFixed(2).padStart(5, "0")}`;
export function renderPreview(c) {
  const s = c.snapshot,
    productionId =
      c.selection.production ??
      s.scenes.find((s) => s.id === c.selection.scene)?.productionId;
  const editions = (s.editions ?? []).filter(
    (e) => e.productionId === productionId,
  );
  const edition =
    editions.find((e) => e.id === c.selection.edition) ?? editions.at(-1);
  let profile =
    c.selection.previewProfile ?? edition?.closure.profile.id ?? "landscape";
  const profileSelect = el(
    "select",
    {
      name: "previewProfile",
      "aria-label": "출력 비율",
      onchange: (e) => {
        profile = e.target.value;
        c.selection.previewProfile = profile;
        c.persist();
      },
    },
    ...["landscape", "portrait", "audio"].map((id) =>
      el(
        "option",
        { value: id, selected: id === profile },
        {
          landscape: "16:9 · 가로 영상",
          portrait: "9:16 · 세로 영상",
          audio: "음성만 · WAV",
        }[id],
      ),
    ),
  );
  const toolbar = el(
    "div",
    { class: "preview-toolbar" },
    profileSelect,
    button("새 미리보기 고정", () =>
      c.run(async () => {
        c.status("선택한 실제 자료로 미리보기를 고정하고 있습니다.");
        const id = uid("edition");
        await c.send(
          command(s, "edition.create", "edition", id, {
            id,
            productionId,
            profile,
          }),
        );
        c.selection.edition = id;
        c.persist();
        await c.refresh(true);
      }),
    ),
  );
  const root = card("장면 미리보기");
  if (!edition) {
    root.append(toolbar);
    root.append(
      note(
        "샷의 참조 그림과 각 발화의 음원을 채택한 뒤 재생할 수 있습니다. 음성만 선택하면 그림 없이도 출력됩니다.",
      ),
    );
    return root;
  }
  if (
    edition.closure.assets.some(
      (a) => a.speechVerification === "unverified_import",
    )
  )
    root.children[0].append(
      el("small", { class: "audio-disclosure" }, "가져온 음원 · 연기 미검증"),
    );
  const imported = edition.closure.assets.filter(
    (asset) => asset.speechVerification === "unverified_import",
  );
  const origin =
    imported.length &&
    imported.every((asset) => asset.lineage?.actor === "macOS-local-TTS-import")
      ? "macOS 로컬 TTS 가져오기 데모 · 한국어 발음·연기 품질 미검증"
      : imported.length &&
          imported.every((asset) => asset.lineage?.actor === "local-fixture")
        ? "합성 진단음 데모 · 성우 음성이 아닙니다"
        : "가져온 음원 · 대사 일치·한국어 발음·연기 품질 미검증";
  const metadata = el("div", { class: "preview-metadata" });
  metadata.append(
    select(
      "고정한 미리보기",
      edition.id,
      editions.map((e, i) => ({
        value: e.id,
        label: `미리보기 ${i + 1} · ${{ landscape: "16:9", portrait: "9:16", audio: "음성" }[e.closure.profile.id]} · ${clock(e.closure.timeline.durationFrames / e.closure.profile.fps)}`,
      })),
      (id) => {
        c.selection.edition = id;
        c.persist();
        c.render();
      },
    ),
  );
  const changed = (s.editionStates ?? []).find(
    (x) => x.id === edition.id,
  )?.workingChanged;
  root.append(
    el(
      "p",
      { class: changed ? "edition-state changed" : "edition-state" },
      changed
        ? "고정 미리보기 · 현재 편집본에 새 변경이 있습니다"
        : "고정 미리보기 · 이 판의 자료와 타이밍을 재생합니다",
    ),
  );
  if (
    edition.closure.assets.some(
      (a) => a.speechVerification === "unverified_import",
    )
  )
    metadata.append(note(origin));
  const canvas = el("canvas", {
    width: edition.closure.profile.width,
    height: edition.closure.profile.height,
    "aria-label": "실제 장면 미리보기",
  });
  const stage = el(
    "div",
    { class: `preview-stage ${edition.closure.profile.id}` },
    canvas,
  );
  const audio = el("audio", { preload: "auto" });
  const time = el("output", {}, "00:00.00");
  const scrub = el("input", {
    type: "range",
    min: 0,
    max: edition.closure.timeline.durationFrames - 1,
    step: 1,
    value: 0,
    "aria-label": "재생 위치",
  });
  const playing = button(
    "재생",
    () =>
      c.run(async () => {
        if (audio.paused) {
          await audio.play();
          playing.textContent = "일시 정지";
        } else {
          audio.pause();
          playing.textContent = "재생";
        }
      }),
    { disabled: true },
  );
  root.append(
    stage,
    el("div", { class: "playback-controls" }, playing, scrub, time),
    audio,
    toolbar,
    metadata,
  );
  const tracks = el("div", { class: "timeline-tracks" });
  let filter = "all";
  function rows() {
    tracks.replaceChildren();
    for (const t of edition.closure.timeline.takes.filter(
      (t) => filter === "all" || t.presence === filter,
    )) {
      const row = button(
        [
          el("span", {}, t.speaker),
          el("span", {}, t.text),
          el("small", {}, clock(t.startSample / 48000)),
        ],
        () => {
          audio.currentTime = t.startSample / 48000;
          paint();
        },
        { class: "timeline-cue" },
      );
      tracks.append(row);
    }
  }
  root.append(
    select(
      "보이는 트랙",
      filter,
      [
        { value: "all", label: "모든 발화" },
        { value: "onscreen", label: "화면 속 인물" },
        { value: "offscreen", label: "화면 밖 인물" },
        { value: "narrator", label: "해설" },
      ],
      (value) => {
        filter = value;
        rows();
      },
    ),
    note(
      "트랙 필터는 목록만 바꿉니다. 화면 밖 인물과 해설도 음원에 그대로 포함됩니다.",
    ),
    tracks,
  );
  rows();
  let assets = new Map(),
    ready = false,
    raf,
    disposed = false;
  function paint() {
    if (!ready || disposed) return;
    const frame = playbackFrame(
      audio.currentTime,
      edition.closure.profile.fps,
      edition.closure.timeline.durationFrames,
    );
    const view = drawFrame(canvas.getContext("2d"), { edition, frame, assets });
    canvas.dataset.frame = String(frame);
    canvas.dataset.audioTime = String(audio.currentTime);
    canvas.dataset.activeUtterances = view.activeUtteranceIds.join(",");
    scrub.value = String(frame);
    time.textContent = `${clock(audio.currentTime)} / ${clock(edition.closure.timeline.durationFrames / edition.closure.profile.fps)}`;
  }
  function tick() {
    if (disposed) return;
    paint();
    raf = requestAnimationFrame(tick);
  }
  scrub.addEventListener("input", () => {
    audio.currentTime = Number(scrub.value) / edition.closure.profile.fps;
    paint();
  });
  audio.addEventListener("ended", () => {
    playing.textContent = "재생";
  });
  (c.cleanups ??= new Set()).add(() => {
    disposed = true;
    audio.pause();
    cancelAnimationFrame(raf);
  });
  (async () => {
    const fontBytes = await (
      await c.api.request(
        `/api/blobs/${edition.closure.font.blobId}?projectId=${encodeURIComponent(c.api.projectId)}`,
      )
    ).arrayBuffer();
    if (disposed) return;
    const font = new FontFace("StudioCaption", fontBytes);
    await font.load();
    document.fonts.add(font);
    for (const shot of edition.closure.shots) {
      if (assets.has(shot.blobId)) continue;
      const url = await c.api.blob({ blobId: shot.blobId, mime: "image/png" });
      c.urls.add(url);
      const image = new Image();
      image.src = url;
      await image.decode();
      assets.set(shot.blobId, image);
    }
    const url = await c.api.blob(edition.closure.mix);
    c.urls.add(url);
    if (disposed) return;
    audio.src = url;
    ready = true;
    playing.disabled = false;
    tick();
  })().catch((e) => {
    if (!disposed)
      c.status(`미리보기를 불러오지 못했습니다 · ${e.code ?? e.message}`);
  });
  const canRender =
    edition.closure.profile.kind === "audio" ||
    c.api.bootstrap.rendering?.video.available;
  root.append(
    button(
      "이 판 내보내기",
      () =>
        c.run(async () => {
          c.status(
            "고정된 판을 내보내고 있습니다. 창을 닫아도 서버의 작업은 계속됩니다.",
          );
          const id = uid("render");
          const result = await c.send(
            command(c.snapshot, "edition.render", "editionOutput", id, {
              editionId: edition.id,
              renderId: id,
            }),
          );
          await c.refresh(true);
          if (result.value.status === "failed")
            c.status(
              `내보내기 실패 · ${result.value.errorCode} · 고정 자료는 보존되어 있습니다.`,
            );
        }),
      { disabled: !canRender },
    ),
  );
  if (!canRender)
    root.append(
      note(
        "영상 내보내기에 필요한 로컬 브라우저 또는 FFmpeg를 찾지 못했습니다. 음성 출력은 사용할 수 있습니다.",
      ),
    );
  for (const output of (s.editionOutputs ?? []).filter(
    (x) => x.editionId === edition.id,
  )) {
    if (output.status !== "completed") {
      root.append(
        note(
          `출력 실패 · ${output.errorCode} · 다시 내보내기로 재시도할 수 있습니다.`,
        ),
      );
      continue;
    }
    const link = el(
      "a",
      {
        download: `${s.project.title}-${edition.closure.profile.id}.${output.manifest.output.extension}`,
        class: "download-link",
      },
      "완성 파일 내려받기",
    );
    c.api
      .blob(output.manifest.output)
      .then((url) => {
        c.urls.add(url);
        link.href = url;
      })
      .catch((e) => c.status(e.code ?? e.message));
    root.append(
      link,
      note(
        `실파일 검사 완료 · ${clock(output.manifest.durationSeconds)} · 감상 검토는 별도 기록`,
      ),
    );
    const review = (s.editionReviews ?? []).find(
      (r) => r.renderId === output.id,
    );
    const published = (s.editionPublications ?? []).find(
      (p) => p.editionId === edition.id,
    );
    if (published) root.append(note("이 고정판 발행 기록 완료"));
    else if (review)
      root.append(
        button("검토한 고정판 발행 기록", () =>
          c.run(async () => {
            await c.send(
              command(
                c.snapshot,
                "edition.publish",
                "editionPublication",
                edition.id,
                {
                  editionId: edition.id,
                  reviewId: review.id,
                  closureDigest: edition.closureDigest,
                  outputManifestDigest: output.manifestDigest,
                  policyBindingRevision: review.policyBindingRevision,
                },
              ),
            );
            await c.refresh(true);
          }),
        ),
      );
    else
      root.append(
        form(
          c,
          `review:${output.id}`,
          [
            {
              name: "listened",
              label: "실제 음원을 들었나요?",
              options: [
                { value: "no", label: "아직 듣지 않음" },
                { value: "yes", label: "실제로 듣고 확인함" },
              ],
            },
            {
              name: "watched",
              label: "실제 영상을 보았나요?",
              options: [
                { value: "no", label: "아직 보지 않음" },
                { value: "yes", label: "실제로 보고 확인함" },
              ],
            },
          ],
          async (p) => {
            const id = uid("review");
            await c.send(
              command(c.snapshot, "edition.review", "editionReview", id, {
                id,
                editionId: edition.id,
                renderId: output.id,
                actor: "creator",
                closureDigest: edition.closureDigest,
                outputManifestDigest: output.manifestDigest,
                policyBindingRevision: revision(
                  c.snapshot,
                  "editionPolicy",
                  edition.id,
                ),
                checks: {
                  watched: p.watched === "yes",
                  listened: p.listened === "yes",
                },
              }),
            );
          },
          { submit: "내 감상 검토 기록" },
        ),
      );
  }
  root.append(
    details("고정판과 출력 검사 정보", {
      editionId: edition.id,
      closureDigest: edition.closureDigest,
      profile: edition.closure.profile,
      mix: edition.closure.mix,
      policy: edition.policy,
    }),
  );
  return root;
}
