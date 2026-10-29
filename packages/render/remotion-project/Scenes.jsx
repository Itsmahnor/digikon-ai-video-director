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
    fontSize: scene.font_px, fontFamily: `${FAMILY}, sans-serif`, lineHeight: 1.2, color: "#fff", textAlign: "center", overflowWrap: "anywhere", whiteSpace: "pre-line",
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

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const ease = (t, kind) => (kind === "ease_in_out" ? (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2) : t);
const lerp = (a, b, t) => a + (b - a) * t;

// A scene made of several approved operations: a picture with a camera move, an animated text entrance, or an end card. All numbers are planned
// and checked beforehand; this only draws them. The last frame of the scene is the end state of every motion.
const Composed = ({ scene, width, height }) => {
  const frame = useCurrentFrame();
  const t = scene.frames > 1 ? frame / (scene.frames - 1) : 1;
  const im = scene.image;
  let imageStyle = null;
  if (im) {
    const m = im.move;
    if (m.kind === "zoom") imageStyle = { transform: `scale(${lerp(m.from, m.to, ease(t, m.easing))})` };
    else if (m.kind === "punch") imageStyle = { transform: `scale(${lerp(1, m.to, 1 - Math.pow(1 - clamp01(frame / m.zoom_frames), 3))})` };
    else if (m.kind === "crop") imageStyle = { transform: `translate(${-m.zoom * (m.cx - 0.5) * width}px, ${-m.zoom * (m.cy - 0.5) * height}px) scale(${m.zoom})` };
    else imageStyle = { transform: `translate(${lerp(m.dx0, m.dx1, t) * width}px, ${lerp(m.dy0, m.dy1, t) * height}px) scale(${m.scale})` };
  }
  const tx = scene.text;
  const base = tx && {
    position: "absolute", left: `${((1 - tx.w) / 2) * 100}%`, width: `${tx.w * 100}%`, top: `${tx.y * 100}%`, fontSize: tx.font_px, fontFamily: `${FAMILY}, sans-serif`, lineHeight: 1.2,
    color: tx.color, textAlign: "center", overflowWrap: "anywhere", whiteSpace: "pre-line", ...(tx.strip ? { background: "rgba(0,0,0,.55)", padding: "18px 0" } : {}),
  };
  let words = null;
  if (tx && tx.mode === "stagger") {
    words = tx.words.map((w, i) => {
      const p = clamp01((frame - tx.delay_frames - i * tx.stagger_frames) / tx.word_frames);
      return <span key={i} style={{ display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 12}px)`, marginRight: "0.3em" }}>{w}</span>;
    });
  }
  const p = tx ? clamp01((frame - tx.delay_frames) / tx.duration_frames) : 1;
  // a lower third: slides in from the left, holds, slides out again; the bar and the text move together
  let lower = null;
  if (tx && tx.mode === "lower_third") {
    const pin = 1 - Math.pow(1 - clamp01(frame / tx.slide_frames), 3);
    const pout = Math.pow(clamp01((frame - tx.slide_frames - tx.hold_frames) / tx.slide_frames), 3);
    const dx = -(1 - pin) * width - pout * width;
    lower = (
      <div style={{ ...base, textAlign: tx.align, background: "rgba(0,0,0,.75)", padding: "14px 20px", boxSizing: "border-box", transform: `translate(${dx}px, -50%)` }}>{tx.text}</div>
    );
  }
  const lg = scene.logo;
  const lp = lg ? 1 - Math.pow(1 - clamp01(frame / lg.reveal_frames), 3) : 1;
  return (
    <AbsoluteFill style={{ background: scene.background }}>
      {im ? (
        <AbsoluteFill style={{ overflow: "hidden" }}>
          <Img src={staticFile(im.file)} style={{ width: "100%", height: "100%", objectFit: "cover", ...imageStyle }} />
        </AbsoluteFill>
      ) : null}
      {tx && tx.strip ? <div style={{ position: "absolute", left: 0, width: "100%", top: `${tx.y * 100}%`, height: tx.lines.length * tx.font_px * 1.2 + 48, transform: "translateY(-50%)", background: "rgba(0,0,0,.8)" }} /> : null}
      {tx && tx.mode === "stagger" ? <div style={{ ...base, transform: "translateY(-50%)" }}>{words}</div> : null}
      {lower}
      {lg ? (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <Img src={staticFile(lg.file)} style={{ width: "50%", height: "50%", objectFit: "contain", opacity: lp, transform: `scale(${lerp(lg.scale_from, 1, lp)})` }} />
        </AbsoluteFill>
      ) : null}
      {tx && tx.mode === "fade_up" ? <div style={{ ...base, opacity: p, transform: `translateY(calc(-50% + ${(1 - p) * tx.distance_px}px))` }}>{tx.text}</div> : null}
      {scene.end_card ? <div style={{ position: "absolute", left: "40%", width: "20%", top: "72%", height: 6, background: scene.end_card.accent, opacity: p }} /> : null}
    </AbsoluteFill>
  );
};
export const Scenes = ({ width, height, fps, scenes, font, badge }) => {
  useFont(font);
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {scenes.map((scene) => (
        <Sequence key={scene.operation_id ?? scene.scene_id} from={scene.from_frame} durationInFrames={scene.frames}>
          {scene.kind === "composed" ? <Composed scene={scene} width={width} height={height} /> : <Scene scene={scene} width={width} height={height} fps={fps} badge={badge} />}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
