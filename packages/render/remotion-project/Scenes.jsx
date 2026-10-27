import React, { useEffect, useState } from "react";
import { AbsoluteFill, Img, Sequence, cancelRender, continueRender, delayRender, interpolate, staticFile, useCurrentFrame } from "remotion";

const FAMILY = "DigikonFont";

const useFont = (file) => {
  const [handle] = useState(() => delayRender("font"));
  useEffect(() => {
    const face = new FontFace(FAMILY, `url(${staticFile(file)})`);
    face.load().then(() => { document.fonts.add(face); continueRender(handle); }).catch((e) => cancelRender(e));
  }, [file, handle]);
};

const Scene = ({ scene, width, height, fps, badge }) => {
  const frame = useCurrentFrame();
  const fadeFrames = Math.max(1, Math.round(scene.fade_in_s * fps));
  const p = interpolate(frame, [0, fadeFrames], [0, 1], { extrapolateRight: "clamp" });
  const text = {
    position: "absolute", left: `${((1 - scene.text_w) / 2) * 100}%`, width: `${scene.text_w * 100}%`, top: `${scene.text_y * 100}%`,
    fontSize: scene.font_px, fontFamily: `${FAMILY}, sans-serif`, lineHeight: 1.2, color: "#fff", textAlign: "center", overflowWrap: "anywhere",
  };
  if (scene.kind === "text") {
    // slides up a short way while it fades in
    const rise = (1 - p) * height * 0.05;
    return (
      <AbsoluteFill style={{ background: scene.background }}>
        <div style={{ ...text, opacity: p, transform: `translateY(calc(-50% + ${rise}px))` }}>{scene.text}</div>
        <div style={{ position: "absolute", left: "40%", width: "20%", top: "80%", height: 6, background: scene.accent, opacity: p }} />
      </AbsoluteFill>
    );
  }
  const im = scene.image;
  const zoom = im.motion === "slow_zoom" ? 1 + 0.12 * (frame / scene.frames) : 1;
  return (
    <AbsoluteFill style={{ background: scene.background }}>
      <div style={{ position: "absolute", left: im.box.x, top: im.box.y, width: im.box.w, height: im.box.h, overflow: "hidden", opacity: p }}>
        <Img src={staticFile(im.file)} style={{ width: "100%", height: "100%", objectFit: im.fit, transform: `scale(${zoom})` }} />
      </div>
      <div style={{ ...text, opacity: p, transform: "translateY(-50%)" }}>{scene.text}</div>
      {im.concept ? (
        <div style={{ position: "absolute", left: im.box.x + 12, top: im.box.y + 12, fontFamily: `${FAMILY}, sans-serif`, fontSize: Math.max(10, Math.round(Math.min(height, (width * 9) / 16) / 28)), color: "#fff", background: "rgba(0,0,0,.65)", padding: "6px 8px", lineHeight: 1.2 }}>{badge}</div>
      ) : null}
    </AbsoluteFill>
  );
};

export const Scenes = ({ width, height, fps, scenes, font, badge }) => {
  useFont(font);
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {scenes.map((scene) => (
        <Sequence key={scene.operation_id} from={scene.from_frame} durationInFrames={scene.frames}>
          <Scene scene={scene} width={width} height={height} fps={fps} badge={badge} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
