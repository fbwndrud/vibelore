// Shared browser/export evaluator. Coordinates use canvas fractions; rotations
// are clockwise radians. Image anchors use fractions of the contained image.
export const PERFORMANCE_VERSION = "layers-v1";
const defaults = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
export function evaluatePerformance({ shot, frame }) {
  if (shot.layers === undefined) return [{ blobId: shot.blobId }];
  const evaluated = new Map();
  const visit = (layer) => {
    if (evaluated.has(layer.id)) return evaluated.get(layer.id);
    const transform = { ...defaults, ...layer.transform };
    for (const field of Object.keys(defaults)) {
      const keys = [
        { frame: 0, [field]: transform[field] },
        ...(layer.keyframes ?? []).filter((k) => k[field] !== undefined),
      ];
      let left = keys[0],
        right = keys.at(-1);
      for (const key of keys) {
        if (key.frame <= frame) left = key;
        if (key.frame > frame) {
          right = key;
          break;
        }
      }
      const a =
        right.frame <= left.frame
          ? 0
          : Math.max(
              0,
              Math.min(1, (frame - left.frame) / (right.frame - left.frame)),
            );
      transform[field] = left[field] + (right[field] - left[field]) * a;
    }
    let selected = layer.selection,
      cue;
    for (const c of layer.poseCues ?? [])
      if (c.frame <= frame) {
        selected = c.selection;
        cue = c;
      }
    const { width: w, height: h } = shot.layout;
    const metadata = selected.metadata;
    const fit =
      Math.min(w / metadata.width, h / metadata.height) * transform.scale;
    const size = {
      width: (metadata.width * fit) / w,
      height: (metadata.height * fit) / h,
    };
    const offset = { x: transform.x, y: transform.y };
    transform.x += layer.anchor.x;
    transform.y += layer.anchor.y;
    if (layer.contact) {
      const target = visit(
        shot.layers.find((l) => l.id === layer.contact.targetLayerId),
      );
      const dx =
        (layer.contact.anchor.x - target.anchor.x) * target.size.width * w;
      const dy =
        (layer.contact.anchor.y - target.anchor.y) * target.size.height * h;
      const r = target.transform.rotation;
      transform.x =
        offset.x +
        target.transform.x +
        (dx * Math.cos(r) - dy * Math.sin(r)) / w;
      transform.y =
        offset.y +
        target.transform.y +
        (dx * Math.sin(r) + dy * Math.cos(r)) / h;
    }
    // Check the composed rectangle as well as each finite input: an anchor,
    // translation and size can each be finite while their sum overflows.
    const pixelWidth = size.width * w,
      pixelHeight = size.height * h;
    const corners = [0, 1].flatMap((x) =>
      [0, 1].flatMap((y) => {
        const dx = (x - layer.anchor.x) * pixelWidth;
        const dy = (y - layer.anchor.y) * pixelHeight;
        const r = transform.rotation;
        return [
          dx,
          dy,
          transform.x * w + dx * Math.cos(r) - dy * Math.sin(r),
          transform.y * h + dx * Math.sin(r) + dy * Math.cos(r),
        ];
      }),
    );
    if (
      ![
        ...Object.values(transform),
        ...Object.values(size),
        ...corners,
        transform.x * w,
        transform.y * h,
        size.width * w,
        size.height * h,
        layer.anchor.x * size.width * w,
        layer.anchor.y * size.height * h,
      ].every(Number.isFinite)
    ) {
      const error = new Error("Computed performance geometry must be finite.");
      error.code = "INVALID_INPUT";
      throw error;
    }
    const result = {
      id: layer.id,
      slotId: cue?.slotId ?? layer.slotId,
      occurrenceId: layer.occurrenceId,
      z: layer.z,
      anchor: { ...layer.anchor },
      transform,
      size,
      blobId: selected.blobId,
      ...(cue ? { expression: cue.expression, gaze: cue.gaze } : {}),
    };
    evaluated.set(layer.id, result);
    return result;
  };
  return shot.layers.map(visit).sort((a, b) => a.z - b.z);
}
export function performanceImageIds(shots) {
  return [
    ...new Set(
      shots.flatMap((s) =>
        s.layers === undefined
          ? [s.blobId]
          : s.layers.flatMap((l) => [
              l.selection.blobId,
              ...(l.poseCues ?? []).map((c) => c.selection.blobId),
            ]),
      ),
    ),
  ];
}
