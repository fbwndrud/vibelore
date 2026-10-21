import { evaluatePerformance } from "../src/render/performance.js";
// Browser + export entry: pure timing/interpolation, no provider or mutable state.
export function frameAt({ edition, frame, fps = edition.closure.profile.fps }) {
  const c = edition.closure,
    time = frame / fps,
    shot =
      c.shots.find((s) => frame >= s.startFrame && frame < s.endFrame) ?? null;
  const tr = shot?.transform ?? {},
    localMs = shot ? ((frame - shot.startFrame) * 1000) / fps : 0;
  let camera = {
    x: tr.x ?? 0,
    y: tr.y ?? 0,
    scale: tr.scale ?? 1,
    anchor: tr.anchor ?? "center",
  };
  const keys = [...(tr.keyframes ?? [])];
  if (keys.length && keys[0].timeMs > 0) keys.unshift({ timeMs: 0, ...camera });
  if (keys.length) {
    let left = keys[0],
      right = keys[0];
    for (const key of keys) {
      if (key.timeMs <= localMs) left = key;
      if (key.timeMs >= localMs) {
        right = key;
        break;
      }
      right = key;
    }
    let a =
      right.timeMs === left.timeMs
        ? 0
        : Math.max(
            0,
            Math.min(1, (localMs - left.timeMs) / (right.timeMs - left.timeMs)),
          );
    if (tr.easing === "ease-in-out") a = a * a * (3 - 2 * a);
    for (const k of ["x", "y", "scale"])
      camera[k] = left[k] + (right[k] - left[k]) * a;
  }
  const active = c.timeline.takes.filter(
    (t) =>
      time * c.timeline.sampleRate >= t.startSample &&
      time * c.timeline.sampleRate < t.endSample,
  );
  return {
    frame,
    time,
    shotId: shot?.id ?? null,
    layers: shot
      ? evaluatePerformance({ shot, frame: frame - shot.startFrame })
      : [],
    camera,
    safeArea: tr.safeArea ?? {
      left: 0.06,
      top: 0.06,
      right: 0.06,
      bottom: 0.08,
    },
    caption: active.length
      ? {
          text: active.map((t) => t.text).join("\n"),
          speaker: active.map((t) => t.speaker).join(" · "),
          utteranceIds: active.map((t) => t.utteranceId),
        }
      : null,
    activeUtteranceIds: active.map((t) => t.utteranceId),
  };
}
function wrap(ctx, text, width) {
  const lines = [];
  for (const paragraph of text.normalize("NFC").split("\n")) {
    let line = "";
    for (const char of paragraph) {
      if (line && ctx.measureText(line + char).width > width) {
        lines.push(line);
        line = char;
      } else line += char;
    }
    lines.push(line);
  }
  return lines;
}
export function drawFrame(ctx, { edition, frame, assets }) {
  const c = edition.closure,
    { width: w, height: h } = c.profile,
    view = frameAt({ edition, frame });
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#15252c";
  ctx.fillRect(0, 0, w, h);
  const layered = view.layers.some((layer) => layer.transform);
  if (layered) {
    ctx.save();
    const pivotY =
      view.camera.anchor === "top"
        ? 0
        : view.camera.anchor === "bottom"
        ? h
        : h / 2;
    ctx.translate(w / 2 + view.camera.x * w, pivotY + view.camera.y * h);
    ctx.scale(view.camera.scale, view.camera.scale);
    ctx.translate(-w / 2, -pivotY);
  }
  for (const layer of view.layers) {
    const img = assets.get(layer.blobId);
    if (!img) throw Error("Missing closed image");
    if (layer.transform) {
      ctx.save();
      ctx.globalAlpha = layer.transform.opacity;
      ctx.translate(layer.transform.x * w, layer.transform.y * h);
      ctx.rotate(layer.transform.rotation);
      const iw = layer.size.width * w,
        ih = layer.size.height * h;
      ctx.drawImage(img, -layer.anchor.x * iw, -layer.anchor.y * ih, iw, ih);
      ctx.restore();
      continue;
    }
    const base = Math.max(w / img.width, h / img.height) * view.camera.scale,
      iw = img.width * base,
      ih = img.height * base;
    const y =
      view.camera.anchor === "top"
        ? 0
        : view.camera.anchor === "bottom"
        ? h - ih
        : (h - ih) / 2;
    ctx.drawImage(
      img,
      (w - iw) / 2 + view.camera.x * w,
      y + view.camera.y * h,
      iw,
      ih,
    );
  }
  if (layered) ctx.restore();
  const gradient = ctx.createLinearGradient(0, h * 0.42, 0, h);
  gradient.addColorStop(0, "rgba(8,17,22,0)");
  gradient.addColorStop(1, "rgba(8,17,22,0.90)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  if (view.caption) {
    const safe = view.safeArea,
      left = Math.max(safe.left, 0.06) * w,
      right = Math.max(safe.right, 0.06) * w,
      bottom = Math.max(safe.bottom, 0.08) * h;
    const size = Math.round(w < h ? w * 0.053 : h * 0.049),
      lineHeight = size * 1.5;
    ctx.font = `${size}px StudioCaption`;
    ctx.textBaseline = "top";
    const lines = wrap(ctx, view.caption.text, w - left - right - 32);
    const height = lines.length * lineHeight + size * 1.8;
    if (height > h * (1 - safe.top) - bottom) throw Error("CAPTION_OVERFLOW");
    const top = h - bottom - height;
    ctx.fillStyle = "rgba(9,19,24,.78)";
    ctx.fillRect(left - 16, top - 16, w - left - right + 32, height + 32);
    ctx.fillStyle = "#edbb75";
    ctx.font = `${Math.round(size * 0.7)}px StudioCaption`;
    ctx.fillText(view.caption.speaker, left, top);
    ctx.font = `${size}px StudioCaption`;
    ctx.fillStyle = "#fff8e8";
    lines.forEach((line, i) =>
      ctx.fillText(line, left, top + size * 1.4 + i * lineHeight),
    );
  }
  return view;
}
