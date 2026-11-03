import React, { useEffect, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender, staticFile, useCurrentFrame } from "remotion";
import { compileScene, maskClip, sampleScene } from "../src/scene-graph/compile.ts";

// Draws a compiled scene graph. Every number comes from sampleScene(frame); this file only turns element state into CSS.
const colour = (token, p) => (token && token.startsWith("#") ? token : p[token] ?? p.text);
const transform = (s, extra = "") => `translate(${s.x}px, ${s.y}px) scale(${s.scale}) rotate(${s.rotate}deg)${extra}`;

// A text may name a font role (display, body, mono); `fonts` maps the roles to CSS families. With no role, or no map, the film's single font is used as before.
const Text = ({ e, s, palette, family, fonts }) => {
  const p = e.props;
  const base = { position: "absolute", left: p.x, top: p.y, width: p.w, textAlign: p.align, fontFamily: (p.font && fonts && fonts[p.font]) || family, fontSize: p.font_px, lineHeight: p.line_height, fontWeight: p.weight === "regular" ? 400 : 700, textTransform: p.upper ? "uppercase" : "none", color: colour(p.color, palette), whiteSpace: "pre" };
  if (s.units) {
    // lines, words or characters, each with its own pose; a line is a block, a word or character flows inline
    const block = e.stagger.unit === "line";
    return <div style={base}>{s.units.map((u, i) => block
      ? <div key={i} style={{ opacity: u.opacity, transform: transform(u), letterSpacing: `${u.tracking}em` }}>{u.text}</div>
      : <React.Fragment key={i}>
        {/* a line break belongs between the units, not inside an inline-block, where it would be swallowed and run two lines together */}
        <span style={{ display: "inline-block", opacity: u.opacity, transform: transform(u), letterSpacing: `${u.tracking}em` }}>{(u.text.endsWith("\n") ? u.text.slice(0, -1) : u.text).replace(/ /g, "\u00a0")}</span>
        {u.text.endsWith("\n") ? <br /> : null}
      </React.Fragment>)}</div>;
  }
  return <div style={{ ...base, opacity: s.opacity, transform: transform(s), letterSpacing: `${s.tracking}em` }}>{s.text ?? p.text}</div>;
};

const Shape = ({ e, s, palette }) => {
  const p = e.props;
  const w = s.w ?? p.w, h = s.h ?? p.h;
  const style = { position: "absolute", left: p.x, top: p.y, width: w, height: p.shape === "line" ? 0 : h, opacity: s.opacity, transform: transform(s), boxSizing: "border-box", background: p.fill && p.shape !== "line" ? colour(p.fill, palette) : "transparent", borderRadius: p.shape === "ellipse" ? "50%" : p.radius, border: p.stroke && p.stroke_w ? `${p.stroke_w}px solid ${colour(p.stroke, palette)}` : "none" };
  return <div style={style} />;
};

const Chart = ({ e, s, palette }) => {
  const p = e.props, max = Math.max(...p.values, 1), n = p.values.length, bw = p.w / n;
  return (
    <div style={{ position: "absolute", left: p.x, top: p.y, width: p.w, height: p.h, opacity: s.opacity, transform: transform(s) }}>
      {p.values.map((v, i) => <div key={i} style={{ position: "absolute", left: i * bw + bw * 0.1, bottom: 0, width: bw * 0.8, height: (v / max) * p.h * s.progress, background: colour(p.color, palette) }} />)}
    </div>
  );
};

const Cursor = ({ e, s, palette }) => {
  const p = e.props;
  return <div style={{ position: "absolute", left: p.x, top: p.y, width: 0, height: 0, opacity: s.opacity, transform: transform(s), borderLeft: `${p.size * 0.6}px solid transparent`, borderRight: `${p.size * 0.6}px solid transparent`, borderBottom: `${p.size}px solid ${colour(p.color, palette)}` }} />;
};

const Node = ({ e, state, byParent, palette, family, fonts }) => {
  const s = state.get(e.id);
  if (!s.visible) return null;
  const kids = (byParent.get(e.id) ?? []).map((k) => <Node key={k.id} e={k} state={state} byParent={byParent} palette={palette} family={family} fonts={fonts} />);
  const p = e.props;
  switch (e.kind) {
    case "text": return <Text e={e} s={s} palette={palette} family={family} fonts={fonts} />;
    case "shape": return <Shape e={e} s={s} palette={palette} />;
    case "chart": return <Chart e={e} s={s} palette={palette} />;
    case "cursor": return <Cursor e={e} s={s} palette={palette} />;
    case "image": return <img src={p.asset_ref} style={{ position: "absolute", left: p.x, top: p.y, width: p.w, height: p.h, objectFit: p.fit, opacity: s.opacity, transform: transform(s) }} />;
    case "video": return null; // a clip needs the Remotion <Video> and its file served; not part of the first slice
    case "mask": return <div style={{ position: "absolute", left: p.x, top: p.y, width: p.w, height: p.h, overflow: "hidden", clipPath: maskClip(p.reveal, s.progress), opacity: s.opacity }}>{kids}</div>;
    case "group": return <div style={{ position: "absolute", left: p.x, top: p.y, width: 0, height: 0, opacity: s.opacity, transform: transform(s) }}>{kids}</div>;
    default: return null;
  }
};

// `font_faces` are files in the bundle's public folder to load before drawing: [{ name, file, weight }]. Absent means nothing to load.
const useFaces = (faces) => {
  const [handle] = useState(() => (faces && faces.length ? delayRender("fonts") : null));
  useEffect(() => {
    if (handle === null) return;
    Promise.all(faces.map((f) => new FontFace(f.name, `url(${staticFile(f.file)})`, { weight: String(f.weight ?? 400) }).load())).then((all) => { all.forEach((f) => document.fonts.add(f)); continueRender(handle); }).catch((err) => cancelRender(err));
  }, [handle]);
};

export const SceneGraphScene = ({ graph, palette, font_family, fonts, font_faces }) => {
  useFaces(font_faces);
  const frame = useCurrentFrame();
  const compiled = React.useMemo(() => compileScene(graph), [graph]);
  const sampled = sampleScene(compiled, frame);
  const state = new Map(sampled.elements.map((s) => [s.id, s]));
  const byParent = new Map();
  for (const e of graph.elements) { const k = e.parent; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(e); }
  const cam = sampled.camera;
  return (
    <AbsoluteFill style={{ background: palette.background, overflow: "hidden" }}>
      <AbsoluteFill style={{ transformOrigin: "50% 50%", transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale}) rotate(${cam.rotate}deg)` }}>
        {(byParent.get(null) ?? []).map((e) => <Node key={e.id} e={e} state={state} byParent={byParent} palette={palette} family={font_family} fonts={fonts} />)}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
