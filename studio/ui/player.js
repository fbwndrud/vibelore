import { performanceImageIds } from "../src/render/performance.js";
import { drawFrame, frameAt } from "../render/frame.js";
import { command, revision } from "./api.js";
import { el, card, note, button, select, uid, details, form } from "./dom.js";
export const playbackFrame = (time, fps, durationFrames) =>
  Math.min(durationFrames - 1, Math.max(0, Math.round(time * fps)));
const clock = (t) =>
  `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60)
    .toFixed(2)
    .padStart(5, "0")}`;
// UI guidance only. edition.create still validates accepted media and revisions.
export function previewReadiness(snapshot, productionId, profile) {
  const timeline = snapshot.timelines?.find(
    (t) => t.productionId === productionId,
  );
  const intent = timeline?.intent ?? {};
  const allScenes = snapshot.scenes.filter(
    (s) => s.productionId === productionId,
  );
  const scenes = intent.sceneIds
    ? intent.sceneIds
        .map((id) => allScenes.find((s) => s.id === id))
        .filter(Boolean)
    : allScenes;
  const audio = scenes.flatMap((scene) =>
    scene.utterances.flatMap((u) => {
      const takes = snapshot.slots.filter(
        (slot) =>
          slot.mediaKind === "audio" &&
          slot.utteranceId === u.id &&
          slot.candidateId &&
          snapshot.candidates.some((c) => c.id === slot.candidateId),
      );
      const selectedId = intent.utterances?.find(
        (x) => x.utteranceId === u.id,
      )?.slotId;
      return (
        selectedId ? takes.some((x) => x.id === selectedId) : takes.length === 1
      )
        ? []
        : [{ sceneId: scene.id, utteranceId: u.id, text: u.text }];
    }),
  );
  const images =
    profile === "audio"
      ? []
      : scenes.flatMap((scene) => {
          if (!scene.shots.length) return [{ sceneId: scene.id, shotId: null }];
          return scene.shots.flatMap((shot) => {
            const selections =
              shot.layers === undefined
                ? [{ slotId: shot.referenceSlotId, use: "shot" }]
                : shot.layers.flatMap((layer) => [
                    { slotId: layer.slotId, use: "layer" },
                    ...(layer.poseCues ?? []).map((cue) => ({
                      slotId: cue.slotId,
                      use: "poseCue",
                    })),
                  ]);
            const complete =
              selections.length > 0 &&
              selections.every((selection) => {
                const slot = snapshot.slots.find(
                  (x) =>
                    x.id === selection.slotId &&
                    x.mediaKind === "image" &&
                    x.candidateId,
                );
                const candidate = snapshot.candidates.find(
                  (c) => c.id === slot?.candidateId,
                );
                const roles =
                  selection.use === "poseCue"
                    ? ["pose"]
                    : slot?.subject.kind === "environment"
                    ? ["environment-reference", "final-scene"]
                    : selection.use === "layer"
                    ? ["identity-reference", "pose"]
                    : ["identity-reference", "pose", "final-scene"];
                return (
                  candidate &&
                  (!candidate.reuseRole || roles.includes(candidate.reuseRole))
                );
              });
            return complete ? [] : [{ sceneId: scene.id, shotId: shot.id }];
          });
        });
  const utterances = scenes.reduce((n, s) => n + s.utterances.length, 0);
  const timed = utterances > 0 || timeline?.resolved?.durationFrames > 0;
  return {
    ready: scenes.length > 0 && timed && !audio.length && !images.length,
    audio,
    images,
    scenes: scenes.length,
    utterances,
    timed,
  };
}

export function renderWorkingShot(c, scene, shot) {
  const canvas = el("canvas", {
    width: 1280,
    height: 720,
    "aria-label": "선택 샷 구도",
  });
  const message = note("그림을 불러오고 있습니다.");
  const root = card(
    "선택 샷 구도",
    note(
      "음원 없이 구도부터 확인합니다. 입력 중인 카메라 값은 저장 전에도 화면에 반영됩니다.",
    ),
    el("div", { class: "preview-stage landscape" }, canvas),
    message,
  );
  let assets = new Map(),
    loadedKey,
    loadingKey,
    desiredKey,
    epoch = 0,
    disposed = false,
    timeMs = 0,
    latest;
  const scrub = el("input", {
    type: "range",
    min: 0,
    max: 5000,
    step: 10,
    value: 0,
    "aria-label": "샷 구도 시간",
    oninput: (e) => {
      timeMs = Number(e.target.value);
      update(latest);
    },
  });
  root.append(
    el(
      "label",
      { class: "field" },
      el("span", {}, "키프레임 구도 확인 (밀리초)"),
      scrub,
    ),
  );
  c.cleanups ??= new Set();
  c.cleanups.add(() => {
    disposed = true;
    epoch++;
  });
  function update(p = {}) {
    latest = p;
    let transform;
    try {
      const old = shot.transform ?? {};
      transform = {
        ...old,
        ...Object.fromEntries(
          ["x", "y", "scale"].map((k) => [
            k,
            p[k] == null ? old[k] ?? (k === "scale" ? 1 : 0) : Number(p[k]),
          ]),
        ),
        anchor: p.anchor ?? old.anchor ?? "center",
        easing: p.easing ?? old.easing ?? "linear",
        keyframes:
          p.keyframes == null ? old.keyframes ?? [] : JSON.parse(p.keyframes),
      };
      if (
        ![transform.x, transform.y, transform.scale].every(Number.isFinite) ||
        transform.scale <= 0 ||
        !Array.isArray(transform.keyframes) ||
        transform.keyframes.some(
          (k) =>
            ![k.timeMs, k.x, k.y, k.scale].every(Number.isFinite) ||
            k.timeMs < 0 ||
            k.scale <= 0,
        )
      )
        throw Error();
    } catch {
      message.textContent =
        "카메라 값 또는 키프레임 형식을 확인하세요. 마지막 정상 구도는 유지됩니다.";
      return;
    }
    const slotId = p.referenceSlotId ?? shot.referenceSlotId;
    const candidates = new Map();
    const selection = (id) => {
      const slot = c.snapshot.slots.find(
        (x) => x.id === id && x.mediaKind === "image",
      );
      const candidate = c.snapshot.candidates.find(
        (x) => x.id === slot?.candidateId,
      );
      if (!candidate) return null;
      const blobId = candidate.canonicalBlobId ?? candidate.blobId;
      candidates.set(blobId, candidate);
      return { blobId, metadata: candidate.metadata };
    };
    const layers = shot.layers?.map((layer) => ({
      ...layer,
      selection: selection(layer.slotId),
      poseCues: (layer.poseCues ?? []).map((cue) => ({
        ...cue,
        selection: selection(cue.slotId),
      })),
    }));
    const base = shot.layers === undefined ? selection(slotId) : null;
    const complete = layers
      ? layers.every(
          (layer) =>
            layer.selection && layer.poseCues.every((cue) => cue.selection),
        )
      : !!base;
    const key = complete ? [...candidates.keys()].join(":") : null;
    if (desiredKey !== key) {
      desiredKey = key;
      epoch++;
      loadingKey = null;
    }
    const duration = Math.max(
      5000,
      ...transform.keyframes.map((k) => k.timeMs),
      ...(layers ?? []).flatMap((layer) =>
        [...(layer.keyframes ?? []), ...layer.poseCues].map(
          (cue) => (cue.frame * 1000) / 30,
        ),
      ),
    );
    scrub.max = duration;
    timeMs = Math.min(timeMs, duration);
    canvas.dataset.referenceSlotId = slotId ?? "";
    if (!complete) {
      epoch++;
      loadingKey = null;
      assets = new Map();
      loadedKey = null;
      if (canvas.isConnected)
        canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
      message.textContent =
        "이 샷에 필요한 그림이 채택되지 않았습니다. Asset Lab에서 각 레이어와 포즈의 그림을 채택하세요.";
      return;
    }
    const edition = {
      closure: {
        profile: { fps: 30, width: 1280, height: 720 },
        shots: [
          {
            ...shot,
            transform,
            ...(layers
              ? { layers, layout: { width: 1280, height: 720 } }
              : { blobId: base.blobId }),
            startFrame: 0,
            endFrame: Math.ceil((duration * 30) / 1000) + 1,
          },
        ],
        timeline: { sampleRate: 48000, takes: [] },
      },
    };
    const frame = Math.round((timeMs * 30) / 1000);
    canvas.dataset.camera = JSON.stringify(frameAt({ edition, frame }).camera);
    const source = c.snapshot.sourcePackages
      ?.flatMap((x) => x.assets ?? [])
      .find((x) => x.id === slotId);
    const referenceOnly =
      source?.label?.includes("전체 장면") ||
      source?.provenance?.sourceDeclaration?.representation ===
        "combined-cast-sheet";
    message.textContent = referenceOnly
      ? "참조 원본입니다. 여러 웹툰 칸이나 인물 시트는 영상용 단일 구도로 정리해야 합니다."
      : "현재 입력 구도 · 완성 영상의 음성·타이밍은 제작판 미리보기에서 확인합니다.";
    if (loadedKey === key && canvas.isConnected) {
      drawFrame(canvas.getContext("2d"), { edition, frame, assets });
      return;
    }
    if (loadingKey === key || !canvas.isConnected) return;
    loadingKey = key;
    const requestEpoch = ++epoch;
    Promise.all(
      [...candidates].map(async ([blobId, candidate]) => {
        const url = await c.api.blob(candidate);
        if (disposed || requestEpoch !== epoch || !canvas.isConnected) {
          URL.revokeObjectURL(url);
          return null;
        }
        c.urls.add(url);
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
          image.src = url;
        });
        return [blobId, image];
      }),
    )
      .then((entries) => {
        if (disposed || requestEpoch !== epoch || !canvas.isConnected) return;
        assets = new Map(entries);
        loadedKey = key;
        loadingKey = null;
        update(latest);
      })
      .catch(() => {
        if (!disposed && requestEpoch === epoch) {
          loadingKey = null;
          message.textContent =
            "참조 그림을 불러오지 못했습니다. 자료 파일 상태를 확인하세요.";
        }
      });
  }
  const draft = c.drafts.get(`shot:${scene.id}:${shot.id}`)?.value ?? {};
  update(draft);
  // The host is attached after this component returns.
  queueMicrotask(() => {
    if (!disposed) update(latest);
  });
  return { root, update };
}
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
        updateReadiness();
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
  const readinessNote = note("");
  const create = button("새 미리보기 고정", () =>
      c.run(async () => {
        if (!previewReadiness(s, productionId, profile).ready) return;
        c.status("선택한 실제 자료로 미리보기를 고정하고 있습니다.");
        const id = uid("edition");
        await c.send(command(s, "edition.create", "edition", id, { id, productionId, profile }));
        c.selection.edition = id;
        c.persist();
        await c.refresh(true);
      }));
  function updateReadiness() {
    const r = previewReadiness(s, productionId, profile);
    create.disabled = !r.ready;
    readinessNote.textContent = !r.scenes ? "선택 제작판에 장면이 없습니다." : !r.timed ? "장면의 음원을 채택하거나 명시적인 재생 시간을 저장하세요." :
      [r.audio.length ? `음원이 필요한 발화 ${r.audio.length}개 · Asset Lab에서 생성하거나 가져온 뒤 채택하세요.` : "",
       r.images.length ? `참조 그림이 필요한 샷 ${r.images.length}개 · 그림을 채택하고 샷에 연결하세요.` : ""].filter(Boolean).join(" ") ||
       "선택 타임라인의 채택 자료로 고정합니다. 저장 시 자료의 유효성을 다시 검사합니다.";
  }
  updateReadiness();
  const toolbar = el(
    "div",
    { class: "preview-toolbar" },
    profileSelect,
    create,
  );
  const root = card("제작판 미리보기", readinessNote);
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
    for (const blobId of performanceImageIds(edition.closure.shots)) {
      const url = await c.api.blob({ blobId, mime: "image/png" });
      c.urls.add(url);
      const image = new Image();
      image.src = url;
      await image.decode();
      assets.set(blobId, image);
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
    const bindingRevision = revision(s, "editionPolicy", edition.id);
    const reviews = (s.editionReviews ?? []).filter(
      (r) => r.renderId === output.id,
    );
    const review = reviews.find(
      (r) =>
        r.editionId === edition.id &&
        r.closureDigest === edition.closureDigest &&
        r.outputManifestDigest === output.manifestDigest &&
        r.policyBindingRevision === bindingRevision,
    );
    if (!review && reviews.length)
      root.append(
        note(
          "검토 정책이 변경되었습니다. 이 출력의 감상 검토를 다시 기록해 주세요.",
        ),
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
          `review:${output.id}:${bindingRevision}`,
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
