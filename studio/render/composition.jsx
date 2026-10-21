import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Composition,
  registerRoot,
  useCurrentFrame,
  delayRender,
  continueRender,
  cancelRender,
} from "remotion";
import { performanceImageIds } from "../src/render/performance.js";
import { drawFrame } from "./frame.js";
function Film({ edition, urls }) {
  const frame = useCurrentFrame(),
    canvas = useRef(null),
    [assets, setAssets] = useState(null),
    [handle] = useState(() => delayRender("Load frozen edition assets"));
  useEffect(() => {
    let active = true;
    (async () => {
      const font = new FontFace(
        "StudioCaption",
        `url(${urls[edition.closure.font.blobId]})`,
      );
      await font.load();
      document.fonts.add(font);
      const map = new Map();
      for (const blobId of performanceImageIds(edition.closure.shots)) {
        const image = new Image();
        image.src = urls[blobId];
        await image.decode();
        map.set(blobId, image);
      }
      if (active) {
        setAssets(map);
        continueRender(handle);
      }
    })().catch(cancelRender);
    return () => {
      active = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (assets)
      try {
        drawFrame(canvas.current.getContext("2d"), { edition, frame, assets });
      } catch (e) {
        cancelRender(e);
      }
  }, [assets, frame]);
  return (
    <canvas
      ref={canvas}
      width={edition.closure.profile.width}
      height={edition.closure.profile.height}
    />
  );
}
const Root = () => (
  <Composition
    id="StudioEdition"
    component={Film}
    width={1280}
    height={720}
    fps={30}
    durationInFrames={30}
    calculateMetadata={({ props }) => ({
      width: props.edition.closure.profile.width,
      height: props.edition.closure.profile.height,
      fps: props.edition.closure.profile.fps,
      durationInFrames: props.edition.closure.timeline.durationFrames,
    })}
  />
);
registerRoot(Root);
