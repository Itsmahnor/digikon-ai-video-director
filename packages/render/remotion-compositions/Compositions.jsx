import React, { useEffect, useState } from "react";
import { AbsoluteFill, Img, Sequence, cancelRender, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

// The scene-composition template. Every number here was planned and checked beforehand (packages/render/src/composition.ts); this only
// draws them. A scene is a pure function of the frame: nothing reads a file, the network or the clock.

const FAMILY = "DigikonFont";
const CHAR = 0.56;

const useFont = (file) => {
  const [handle] = useState(() => delayRender("font"));
  useEffect(() => {
    const face = new FontFace(FAMILY, `url(${staticFile(file)})`);
    face.load().then(() => { document.fonts.add(face); continueRender(handle); }).catch((e) => cancelRender(e));
  }, [file, handle]);
};

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const outCubic = (t) => 1 - Math.pow(1 - t, 3);
const inOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const back = (t) => { const c1 = 1.25, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const EASE = { ease_out: outCubic, ease_in_out: inOutCubic, spring: back };

const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgba = (h, a) => { const [r, g, b] = hexToRgb(h); return `rgba(${r},${g},${b},${a})`; };
const chan = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (h) => { const [r, g, b] = hexToRgb(h); return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b); };
const onColor = (bg) => (lum(bg) > 0.4 ? "#0b0f19" : "#ffffff");

// progress of one element: starts at `start` and takes `dur`, both as shares of the active window (the first 70% of the scene, so the end is held)
const makeP = (scene, frame, fps) => {
  const T = scene.frames / fps;
  const active = Math.max(0.5, Math.min(T * 0.7, T - 1));
  const a = frame / fps / active;
  const ease = EASE[scene.motion.easing] ?? outCubic;
  return (start, dur) => ease(clamp((a - start) / Math.max(0.01, Math.min(dur * scene.motion.speed, 1 - start))));
};
const makeLinear = (scene, frame, fps) => {
  const T = scene.frames / fps;
  const active = Math.max(0.5, Math.min(T * 0.7, T - 1));
  const a = frame / fps / active;
  return (start, dur) => clamp((a - start) / Math.max(0.01, Math.min(dur * scene.motion.speed, 1 - start)));
};

const Backdrop = ({ scene }) => {
  const { palette: p, width, height } = scene;
  const short = Math.min(width, height);
  const b = scene.visual.backdrop;
  const base = { position: "absolute", inset: 0, background: p.background };
  if (b === "gradient") return <div style={{ ...base, background: `radial-gradient(circle at 82% 18%, ${rgba(p.accent, 0.22)} 0%, ${rgba(p.accent_2, 0.1)} 38%, ${p.background} 72%)` }} />;
  if (b === "grid") { const g = Math.round(short / 10); return <div style={{ ...base, backgroundImage: `linear-gradient(${rgba(p.text, 0.06)} 1px, transparent 1px), linear-gradient(90deg, ${rgba(p.text, 0.06)} 1px, transparent 1px)`, backgroundSize: `${g}px ${g}px` }} />; }
  if (b === "dots") { const g = Math.round(short / 16); return <div style={{ ...base, backgroundImage: `radial-gradient(${rgba(p.text, 0.1)} 2px, transparent 2.5px)`, backgroundSize: `${g}px ${g}px` }} />; }
  return <div style={base} />;
};

const typeStyle = (scene) => ({ fontFamily: `${FAMILY}, sans-serif`, fontWeight: scene.type.bold ? 700 : 400, textTransform: scene.type.upper ? "uppercase" : "none", color: scene.palette.text });

// ---------- headline column ----------
const Headline = ({ scene, p }) => {
  const h = scene.headline;
  if (!h) return null;
  const { box } = h;
  const wide = scene.width / scene.height >= 1.5;
  const bar = p(0, 0.15);
  return (
    <div style={{ position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, display: "flex", flexDirection: "column", justifyContent: wide ? "center" : "flex-start", alignItems: "flex-start", ...typeStyle(scene) }}>
      <div style={{ width: Math.round(h.font_px * 1.6 * bar), height: Math.max(4, Math.round(h.font_px * 0.12)), background: scene.palette.accent, borderRadius: 4, marginBottom: Math.round(h.font_px * 0.45) }} />
      {h.lines.map((l, i) => {
        const q = p(0.04 + i * 0.07, 0.18);
        return (
          <div key={i} style={{ overflow: "hidden", lineHeight: 1.15, fontSize: h.font_px, whiteSpace: "pre" }}>
            <div style={{ transform: `translateY(${(1 - q) * 105}%)`, opacity: clamp(q * 2) }}>{l}</div>
          </div>
        );
      })}
    </div>
  );
};

// ---------- blocks ----------
const MessageThread = ({ scene, p }) => {
  const v = scene.visual, box = scene.content, pal = scene.palette;
  const pile = v.mode === "pile_up";
  // every height and gap is proportional to the type size, so a long thread is shrunk as a whole to fit the frame (a pile also tilts, so keep some air)
  const tight = scene.lines["tight"] && scene.lines["tight"][0] === "1";
  const LH = tight ? 1.15 : 1.25, PADV = tight ? 0.4 : 0.55;
  const layout = (f) => {
    const items = v.messages.map((m, i) => { const ls = scene.lines[`m${i}`]; const h = ls.length * f * LH + f * PADV * 2; const mw = scene.lines[`w${i}`] ? parseFloat(scene.lines[`w${i}`][0]) * (f / scene.sizes.body) : Math.max(...ls.map((l) => l.length)) * f * CHAR; const w = Math.min(box.w * 0.78, mw + f * 1.8); return { m, ls, h, w }; });
    const gap = pile ? -f * 0.3 : f * 0.5;
    return { items, gap, total: items.reduce((a, it) => a + it.h, 0) + gap * (items.length - 1) };
  };
  const f = scene.sizes.body * Math.min(1, (box.h * 0.9) / layout(scene.sizes.body).total);
  const { items, gap, total } = layout(f);
  let y = box.y + (box.h - total) / 2;
  return (
    <>
      {items.map((it, i) => {
        const q = p(i * 0.14, 0.22);
        const yy = y; y += it.h + gap;
        const me = it.m.from === "you";
        const x = me ? box.x + box.w - it.w : box.x;
        const bg = me ? pal.accent : pal.surface, fg = me ? onColor(pal.accent) : pal.text;
        const rot = pile ? ((i % 2 ? 1 : -1) * 2.8 * (0.4 + i / items.length)) : 0;
        const jitter = pile ? (i % 2 ? 1 : -1) * f * 0.35 : 0;
        return (
          <div key={i} style={{ position: "absolute", left: x + jitter, top: yy, width: it.w, height: it.h, boxSizing: "border-box", padding: `${f * PADV}px ${f * 0.9}px`, borderRadius: f * 0.9, background: bg, color: fg, fontSize: f, lineHeight: LH, fontFamily: `${FAMILY}, sans-serif`, fontWeight: scene.type.bold ? 700 : 400, textTransform: scene.type.upper ? "uppercase" : "none", whiteSpace: "pre", opacity: clamp(q * 2), transform: `translateY(${(1 - q) * f * 1.3}px) scale(${0.88 + 0.12 * q}) rotate(${rot * q}deg)`, boxShadow: `0 ${f * 0.3}px ${f * 0.8}px ${rgba("#000000", 0.25)}`, zIndex: i }}>
            {it.ls.join("\n")}
          </div>
        );
      })}
    </>
  );
};

const Cursor = ({ x, y, size, scale, color }) => (
  <svg width={size} height={size * 1.4} viewBox="0 0 20 28" style={{ position: "absolute", left: x, top: y, transform: `scale(${scale})`, transformOrigin: "2px 2px", filter: "drop-shadow(0 3px 4px rgba(0,0,0,.45))" }}>
    <path d="M2 2 L2 22 L7.5 17.2 L11 25.5 L14.2 24.2 L10.8 16 L18 16 Z" fill={color} stroke="#0b0f19" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);

const UiDemo = ({ scene, p, lin }) => {
  const v = scene.visual, pal = scene.palette;
  const L = scene.layout.window, f = L.font_px;
  const { win, title_h: titleH } = L;
  const winP = p(0, 0.2);
  const tgt = v.cursor_target;
  const tgtRect = tgt === null ? null : L.row_rects[tgt];
  const tgtX = tgtRect ? tgtRect.x + tgtRect.w * 0.45 : 0, tgtY = tgtRect ? tgtRect.y + tgtRect.h / 2 : 0;
  const cur = lin(0.3, 0.3), click = p(0.62, 0.08);
  const e = (t) => t * t * (3 - 2 * t);
  const cx = lerp(win.x + win.w * 0.95, tgtX, e(cur)), cy = lerp(win.y + win.h + f * 1.2, tgtY, e(cur));
  const confirm = p(0.7, 0.18);
  const cf = L.confirm_px;
  return (
    <>
      <div style={{ position: "absolute", left: win.x, top: win.y + (1 - winP) * f * 1.5, width: win.w, height: win.h, borderRadius: f * 0.9, background: pal.surface, opacity: clamp(winP * 2), overflow: "hidden", boxShadow: `0 ${f}px ${f * 2.4}px ${rgba("#000000", 0.35)}`, border: `1px solid ${rgba(pal.text, 0.1)}` }}>
        <div style={{ height: titleH, boxSizing: "border-box", display: "flex", alignItems: "center", padding: `0 ${f}px`, borderBottom: `1px solid ${rgba(pal.text, 0.08)}` }}>
          {[pal.accent, pal.accent_2, pal.muted].map((c, i) => <div key={i} style={{ flex: "none", width: f * 0.55, height: f * 0.55, borderRadius: "50%", background: c, marginRight: f * 0.45 }} />)}
          <div style={{ marginLeft: f * 0.6, fontSize: L.title_px, lineHeight: 1.2, color: pal.muted, fontFamily: `${FAMILY}, sans-serif`, textTransform: scene.type.upper ? "uppercase" : "none", whiteSpace: "pre" }}>{L.title_lines.join("\n")}</div>
        </div>
        {L.side_w ? <div style={{ position: "absolute", left: 0, top: titleH, width: L.side_w, bottom: 0, borderRight: `1px solid ${rgba(pal.text, 0.08)}` }} /> : null}
      </div>
      {L.side_rects.map((r, i) => {
        const q = p(0.05 + i * 0.05, 0.15);
        return <div key={`s${i}`} style={{ position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, boxSizing: "border-box", padding: `${f * 0.35}px ${f * 0.4}px`, fontSize: L.small_px, lineHeight: 1.2, color: i === 0 ? pal.text : pal.muted, fontFamily: `${FAMILY}, sans-serif`, fontWeight: i === 0 ? 700 : 400, borderRadius: f * 0.4, background: i === 0 ? rgba(pal.accent, 0.2) : "transparent", opacity: q * winP, whiteSpace: "pre", textTransform: scene.type.upper ? "uppercase" : "none" }}>{L.side_lines[i].join("\n")}</div>;
      })}
      {v.rows.map((r, i) => {
        const q = p(0.08 + i * 0.07, 0.16);
        const rect = L.row_rects[i];
        const selected = tgt === i;
        const lit = selected ? click : r.state === "selected" ? 1 : 0;
        const bg = lit > 0 ? `rgba(${hexToRgb(pal.accent).join(",")},${0.18 + 0.82 * lit * (selected ? 1 : 0.6)})` : rgba(pal.text, 0.06);
        const fg = lit > 0.55 && selected ? onColor(pal.accent) : r.state === "busy" ? pal.muted : pal.text;
        return (
          <div key={i} style={{ position: "absolute", left: rect.x, top: rect.y + (1 - q) * f, width: rect.w, height: rect.h, borderRadius: f * 0.5, background: bg, display: "flex", alignItems: "center", justifyContent: "space-between", padding: `0 ${f * 0.8}px`, opacity: clamp(q * 2) * winP, boxSizing: "border-box" }}>
            <div style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
              <div style={{ flex: "none", width: f * 0.6, height: f * 0.6, borderRadius: "50%", background: r.state === "busy" ? pal.muted : pal.accent_2, marginRight: f * 0.7 }} />
              <div style={{ fontSize: f, lineHeight: 1.2, color: fg, fontFamily: `${FAMILY}, sans-serif`, textDecoration: r.state === "busy" ? "line-through" : "none", whiteSpace: "pre", textTransform: scene.type.upper ? "uppercase" : "none" }}>{L.row_lines[i].join("\n")}</div>
            </div>
            {r.tag ? <div style={{ flex: "none", marginLeft: f * 0.5, fontSize: L.small_px, color: fg, opacity: 0.85, fontFamily: `${FAMILY}, sans-serif`, whiteSpace: "pre" }}>{r.tag}</div> : null}
          </div>
        );
      })}
      {tgt !== null ? <Cursor x={cx} y={cy} size={f * 1.5} scale={1 - 0.18 * (click > 0 && click < 1 ? Math.sin(click * Math.PI) : 0)} color="#ffffff" /> : null}
      {L.confirm ? (
        <div style={{ position: "absolute", left: L.confirm.rect.x, top: L.confirm.rect.y, width: L.confirm.rect.w, height: L.confirm.rect.h, boxSizing: "border-box", transform: `translateY(${(1 - confirm) * f * 1.5}px) scale(${0.85 + 0.15 * confirm})`, opacity: clamp(confirm * 2), display: "flex", alignItems: "center", justifyContent: "center", padding: `0 ${f * 1.1}px`, borderRadius: f * 2, background: pal.accent_2, color: onColor(pal.accent_2), fontSize: cf, lineHeight: 1.2, fontFamily: `${FAMILY}, sans-serif`, fontWeight: 700, boxShadow: `0 ${f * 0.4}px ${f}px ${rgba("#000000", 0.35)}`, whiteSpace: "pre" }}>
          <svg width={cf} height={cf} viewBox="0 0 20 20" style={{ flex: "none", marginRight: cf * 0.5 }}><path d="M4 10.5 L8.5 15 L16 5.5" fill="none" stroke={onColor(pal.accent_2)} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {L.confirm.lines.join("\n")}
        </div>
      ) : null}
    </>
  );
};

// Steps are laid out by the planner (column, row, grid, or pages of a grid within the approved duration). A page is shown for an equal share of the scene.
const ProcessFlow = ({ scene, p, frame, fps }) => {
  const v = scene.visual, pal = scene.palette, S = scene.layout.steps, f = S.font_px;
  const n = v.steps.length, P = S.pages.length;
  const seg = scene.frames / P;
  const k = Math.min(P - 1, Math.floor(frame / seg));
  const pl = P === 1 ? p : makeP({ ...scene, frames: Math.round(seg) }, frame - k * seg, fps);
  const fadeOut = P > 1 && k < P - 1 ? clamp((seg - (frame - k * seg)) / 8) : 1;
  const page = S.pages[k];
  const rectOf = (i) => { const j = page.indexOf(i); const r = Math.floor(j / S.cols), c = j % S.cols; return { x: S.origin.x + c * (S.cell.w + S.gap.x), y: S.origin.y + r * (S.node_h + S.gap.y), w: S.cell.w, h: S.node_h }; };
  return (
    <div style={{ opacity: fadeOut }}>
      <svg width={scene.width} height={scene.height} style={{ position: "absolute", left: 0, top: 0 }}>
        {page.slice(0, -1).map((si, j) => {
          const a = rectOf(si), b = rectOf(page[j + 1]);
          const sameRow = Math.abs(a.y - b.y) < 1, sameCol = Math.abs(a.x - b.x) < 1;
          const q = pl(j * 0.2 + 0.12, 0.14);
          const d = sameRow ? `M ${a.x + a.w} ${a.y + a.h / 2} L ${b.x} ${b.y + b.h / 2}` : sameCol ? `M ${a.x + a.w / 2} ${a.y + a.h} L ${b.x + b.w / 2} ${b.y}` : `M ${a.x + a.w / 2} ${a.y + a.h} V ${(a.y + a.h + b.y) / 2} H ${b.x + b.w / 2} V ${b.y}`;
          return <path key={si} d={d} fill="none" stroke={pal.accent} strokeWidth={Math.max(3, f * 0.18)} strokeLinecap="round" strokeLinejoin="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - q} />;
        })}
      </svg>
      {page.map((si, j) => {
        const st = v.steps[si];
        const q = pl(j * 0.2, 0.2), lit = pl(j * 0.2 + 0.1, 0.1);
        const { x, y, w, h } = rectOf(si);
        const last = si === n - 1;
        const filled = last && lit > 0.9;
        const fg = filled ? onColor(pal.accent) : pal.text;
        return (
          <div key={si} style={{ position: "absolute", left: x, top: y + (1 - q) * f, width: w, height: h, boxSizing: "border-box", borderRadius: f * 0.8, background: filled ? pal.accent : pal.surface, border: `${Math.max(2, f * 0.1)}px solid ${lit > 0.5 ? pal.accent : rgba(pal.text, 0.15)}`, opacity: clamp(q * 2), padding: S.pad, display: "flex", flexDirection: "row", alignItems: "center", color: fg, fontFamily: `${FAMILY}, sans-serif` }}>
            <div style={{ flex: "none", width: S.badge, height: S.badge, borderRadius: "50%", background: filled ? onColor(pal.accent) : pal.accent, color: filled ? pal.accent : onColor(pal.accent), display: "flex", alignItems: "center", justifyContent: "center", fontSize: Math.round(S.badge * 0.56), fontWeight: 700, marginRight: f * 0.6 }}>{si + 1}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: f, fontWeight: scene.type.bold ? 700 : 400, textTransform: scene.type.upper ? "uppercase" : "none", lineHeight: 1.15, whiteSpace: "pre" }}>{S.labels[si].join("\n")}</div>
              {st.detail ? <div style={{ fontSize: S.detail_px, color: filled ? onColor(pal.accent) : pal.muted, marginTop: S.detail_px * 0.3, lineHeight: 1.2, whiteSpace: "pre", textTransform: scene.type.upper ? "uppercase" : "none" }}>{S.details[si].join("\n")}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
};
const DataChart = ({ scene, p, lin }) => {
  const v = scene.visual, box = scene.content, f = scene.sizes.body, sm = scene.sizes.small, pal = scene.palette;
  const n = v.points.length;
  const titleH = (scene.lines.title?.length ?? 1) * f * 1.2 + f * 0.6;
  const labelH = sm * 1.8;
  const cx = box.x, cw = box.w, cy = box.y + titleH, ch = box.h - titleH - labelH - sm * 1.8;
  const slot = cw / n;
  const pts = v.points.map((pt, i) => ({ x: cx + slot * (i + 0.5), y: cy + ch * (1 - pt.value / 100), v: pt.value }));
  const path = pts.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ");
  const draw = lin(0.1, 0.5);
  const tagW = sm * 11;
  return (
    <>
      <div style={{ position: "absolute", left: box.x, top: box.y, width: box.w, fontSize: f, color: pal.text, fontFamily: `${FAMILY}, sans-serif`, fontWeight: scene.type.bold ? 700 : 400, textTransform: scene.type.upper ? "uppercase" : "none", lineHeight: 1.2, whiteSpace: "pre", opacity: p(0, 0.15) }}>{(scene.lines.title ?? [v.title]).join("\n")}</div>
      <svg width={scene.width} height={scene.height} style={{ position: "absolute", left: 0, top: 0 }}>
        <line x1={cx} x2={cx + cw} y1={cy + ch} y2={cy + ch} stroke={rgba(pal.text, 0.25)} strokeWidth={2} />
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1={cx} x2={cx + cw} y1={cy + ch * (1 - g)} y2={cy + ch * (1 - g)} stroke={rgba(pal.text, 0.07)} strokeWidth={1} />)}
        {v.chart === "line" ? (
          <>
            <path d={path} fill="none" stroke={pal.accent} strokeWidth={Math.max(4, f * 0.2)} strokeLinecap="round" strokeLinejoin="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - outCubic(draw)} />
            {pts.map((q, i) => { const s = p(0.55 + i * 0.03, 0.1); const hl = v.highlight_index === i; return <circle key={i} cx={q.x} cy={q.y} r={(hl ? f * 0.5 : f * 0.28) * s} fill={hl ? pal.accent : pal.surface} stroke={pal.accent} strokeWidth={3} />; })}
          </>
        ) : pts.map((q, i) => {
          const g = p(0.08 + i * 0.07, 0.3), hl = v.highlight_index === i, bw = slot * 0.58, hh = (cy + ch - q.y) * g;
          return <rect key={i} x={q.x - bw / 2} y={cy + ch - hh} width={bw} height={Math.max(0, hh)} rx={bw * 0.12} fill={hl || v.highlight_index === null ? (hl ? pal.accent : pal.accent_2) : pal.muted} opacity={v.highlight_index === null || hl ? 1 : 0.55} />;
        })}
      </svg>
      {v.points.map((pt, i) => <div key={i} style={{ position: "absolute", left: cx + slot * i, top: cy + ch + sm * 0.5, width: slot, textAlign: "center", fontSize: sm * 1, color: pal.muted, fontFamily: `${FAMILY}, sans-serif`, whiteSpace: "pre", textTransform: scene.type.upper ? "uppercase" : "none" }}>{pt.label}</div>)}
      <div style={{ position: "absolute", left: box.x + box.w - tagW, top: cy + ch + labelH + sm * 0.4, width: tagW, textAlign: "right", fontSize: sm * 0.9, color: pal.muted, fontFamily: `${FAMILY}, sans-serif`, letterSpacing: 0.5 }}>{scene.badge}</div>
    </>
  );
};

const KineticType = ({ scene, p }) => {
  const h = scene.headline, v = scene.visual, pal = scene.palette;
  const f = h.font_px;
  let wi = 0;
  const rows = h.lines.map((l) => l.split(" ").map((w) => ({ w, i: wi++ })));
  const total = wi;
  const blockH = rows.length * f * 1.12;
  const top = h.box.y + (h.box.h - blockH) / 2;
  const ruler = p(0, 0.2);
  return (
    <>
      <div style={{ position: "absolute", left: h.box.x, top, width: Math.max(4, f * 0.1), height: blockH * ruler, background: pal.accent, borderRadius: 4 }} />
      <div style={{ position: "absolute", left: h.box.x + f * 0.4, top, width: h.box.w - f * 0.4, ...typeStyle(scene), fontSize: f, lineHeight: 1.12 }}>
        {rows.map((ws, r) => (
          <div key={r} style={{ overflow: v.style === "word_pop" ? "visible" : "hidden", height: f * 1.12, whiteSpace: "pre", transform: v.style === "slide_stack" ? `translateX(${(1 - p(0.04 + r * 0.12, 0.25)) * -f * 1.6}px)` : "none", opacity: v.style === "slide_stack" ? clamp(p(0.04 + r * 0.12, 0.25) * 2) : 1 }}>
            <div style={{ transform: v.style === "mask_rise" ? `translateY(${(1 - p(0.04 + r * 0.12, 0.22)) * 110}%)` : "none", display: "inline-block" }}>
              {ws.map(({ w, i }, k) => {
                const q = v.style === "word_pop" ? p(0.04 + (i / Math.max(1, total)) * 0.5, 0.16) : 1;
                return <span key={k} style={{ display: "inline-block", marginRight: f * 0.28, color: v.emphasis_word === i ? pal.accent : pal.text, transform: `scale(${0.55 + 0.45 * q})`, transformOrigin: "50% 80%", opacity: v.style === "word_pop" ? clamp(q * 2) : 1 }}>{w}</span>;
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
};

// where card i sits once it has settled (q = 1), for the drawing and for the word a match cut carries into it
const cardsGeom = (scene, frame, fps) => {
  const v = scene.visual, box = scene.content, f = scene.sizes.body;
  const n = v.cards.length;
  const k = v.depth === "strong" ? 14 : 6;
  const cw = box.w * 0.64, ch = f * 4.6;
  const stepX = (box.w - cw) / Math.max(1, n - 1), stepY = Math.min(f * 3.2, (box.h - ch) / Math.max(1, n - 1));
  const drift = Math.sin((frame / fps) * 0.9);
  const rect = (i, q = 1) => { const depth = (i + 1) / n; return { left: box.x + i * stepX + drift * k * depth, top: box.y + (box.h - ch - stepY * (n - 1)) / 2 + i * stepY + (1 - q) * f * 3, sc: 0.94 + 0.06 * depth }; };
  return { n, k, cw, ch, rect };
};
// progress of the carried word: 0 while it is held, then 0 to 1 as it moves into its card
const heldProgress = (scene, frame) => (scene.held ? clamp((frame - scene.held.hold_frames) / scene.held.move_frames) : 1);

const LayeredCards = ({ scene, p, frame, fps }) => {
  const v = scene.visual, f = scene.sizes.body, pal = scene.palette;
  const { n, cw, ch, rect } = cardsGeom(scene, frame, fps);
  const arrived = heldProgress(scene, frame) >= 1;
  return (
    <>
      {v.cards.map((c, i) => {
        const front = i === n - 1;
        const q = p(i * 0.16, 0.22);
        const depth = (i + 1) / n;
        const r0 = rect(i, q);
        return (
          <div key={i} style={{ position: "absolute", left: r0.left, top: r0.top, width: cw, height: ch, boxSizing: "border-box", borderRadius: f * 0.9, background: front ? pal.surface : rgba(pal.surface, 0.9), border: `${Math.max(2, f * 0.08)}px solid ${front ? pal.accent : rgba(pal.text, 0.12)}`, padding: f * 0.9, color: pal.text, fontFamily: `${FAMILY}, sans-serif`, opacity: clamp(q * 2) * (0.7 + 0.3 * depth), transform: `scale(${0.94 + 0.06 * depth})`, boxShadow: `0 ${f * 0.6}px ${f * 1.6}px ${rgba("#000000", 0.3)}`, zIndex: i }}>
            <div style={{ fontSize: f, fontWeight: scene.type.bold ? 700 : 400, lineHeight: 1.15, textTransform: scene.type.upper ? "uppercase" : "none", whiteSpace: "pre-wrap", opacity: scene.held && scene.held.card === i && !arrived ? 0 : 1 }}>{c.title}</div>
            {c.detail ? <div style={{ fontSize: scene.sizes.small, color: pal.muted, marginTop: f * 0.4, lineHeight: 1.2, textTransform: scene.type.upper ? "uppercase" : "none" }}>{c.detail}</div> : null}
            {front ? <div style={{ position: "absolute", right: f * 0.9, top: f * 0.9, width: f * 0.8, height: f * 0.8, borderRadius: "50%", background: pal.accent }} /> : null}
          </div>
        );
      })}
    </>
  );
};

const EndCard = ({ scene, p }) => {
  const v = scene.visual, h = scene.headline, pal = scene.palette;
  const f = h ? h.font_px : scene.sizes.big, b = scene.sizes.body, s = scene.sizes.small;
  const btn = p(0.5, 0.2);
  return (
    <div style={{ position: "absolute", left: 0, top: scene.stack_top ?? 0, width: scene.width, height: scene.height - (scene.stack_top ?? 0), display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", ...typeStyle(scene) }}>
      {v.wordmark ? <div style={{ fontSize: s * 1.15, letterSpacing: s * 0.22, color: pal.muted, textTransform: "uppercase", marginBottom: f * 0.5, opacity: p(0, 0.15), whiteSpace: "pre" }}>{v.wordmark}</div> : null}
      {h ? h.lines.map((l, i) => { const q = p(0.08 + i * 0.07, 0.2); return <div key={i} style={{ overflow: "hidden", lineHeight: 1.12, fontSize: f, whiteSpace: "pre" }}><div style={{ transform: `translateY(${(1 - q) * 105}%)` }}>{l}</div></div>; }) : null}
      <div style={{ marginTop: f * 0.7, padding: `${b * 0.7}px ${b * 1.8}px`, borderRadius: b * 2, background: pal.accent, color: onColor(pal.accent), fontSize: b, fontWeight: 700, opacity: clamp(btn * 2), transform: `scale(${0.8 + 0.2 * btn})`, whiteSpace: "pre", boxShadow: `0 ${b * 0.5}px ${b * 1.4}px ${rgba(pal.accent, 0.35)}` }}>{v.button}</div>
      {v.subline ? <div style={{ marginTop: b * 0.9, fontSize: s * 1.1, color: pal.muted, opacity: p(0.65, 0.2), whiteSpace: "pre-wrap", maxWidth: scene.width * 0.84 }}>{v.subline}</div> : null}
    </div>
  );
};

// The match cut: the previous scene's emphasised word, held exactly where that scene left it, then carried into its card title. It is drawn outside the camera
// and the iris, so its first frame is the previous scene's last pose; the target is followed through the camera as it moves.
const HeldWord = ({ scene, frame, fps, cam }) => {
  const H = scene.held, pal = scene.palette, f = scene.sizes.body;
  const a = heldProgress(scene, frame), e = inOutCubic(a);
  const g = cardsGeom(scene, frame, fps), r = g.rect(H.card);
  const b = Math.max(2, f * 0.08), pad = f * 0.9;
  const cx = r.left + g.cw / 2, cy = r.top + g.ch / 2;
  const tx0 = cx + (r.left + b + pad - cx) * r.sc, ty0 = cy + (r.top + b + pad - cy) * r.sc;
  const W = scene.width, Hh = scene.height;
  const tx = W / 2 + (tx0 - W / 2) * cam.s + cam.tx, ty = Hh / 2 + (ty0 - Hh / 2) * cam.s;
  const endScale = (f * r.sc * cam.s) / H.font_px;
  const s = lerp(1, endScale, e);
  const mixc = (c1, c2, t) => { const A = hexToRgb(c1), B = hexToRgb(c2); return `rgb(${A.map((v, i) => Math.round(lerp(v, B[i], t))).join(",")})`; };
  return (
    <>
      <div style={{ position: "absolute", left: H.bar.x, top: H.bar.y, width: H.bar.w, height: H.bar.h, background: pal.accent, borderRadius: 4, opacity: 1 - e }} />
      {a < 1 ? <div style={{ position: "absolute", left: 0, top: 0, transform: `translate(${lerp(H.x, tx, e)}px, ${lerp(H.y, ty, e)}px) scale(${s})`, transformOrigin: "0 0", fontSize: H.font_px, lineHeight: 1.12, whiteSpace: "pre", color: mixc(pal.accent, pal.text, e), ...typeStyle(scene), ...{ color: mixc(pal.accent, pal.text, e) } }}>{H.text}</div> : null}
    </>
  );
};

// An uploaded picture, drawn exactly where packages/render/src/asset-layers.ts planned it. The file is shown as it is: never recoloured, stretched or redrawn.
const assetRect = (l, frame) => { const t = l.move_frames > 0 ? outCubic(clamp(frame / l.move_frames)) : 1; return { x: lerp(l.from.x, l.to.x, t), y: lerp(l.from.y, l.to.y, t), w: lerp(l.from.w, l.to.w, t), h: lerp(l.from.h, l.to.h, t) }; };

const AssetLayer = ({ layer: l, frame, scene }) => {
  const r = assetRect(l, frame), pal = scene.palette;
  const opacity = l.fade_frames > 0 ? clamp(frame / l.fade_frames) : 1;
  const edge = Math.max(2, Math.min(scene.width, scene.height) * 0.004);
  const dx = r.x - l.to.x, dy = r.y - l.to.y;
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: scene.width, height: scene.height, opacity, zIndex: 10 + l.z }}>
      {l.plate ? <div style={{ position: "absolute", left: l.plate.box.x + dx, top: l.plate.box.y + dy, width: l.plate.box.w, height: l.plate.box.h, borderRadius: l.plate.radius, background: l.plate.colour }} /> : null}
      {l.frame === "browser" ? (
        <div style={{ position: "absolute", left: l.clip.x - edge, top: l.clip.y - l.chrome_h - edge, width: l.clip.w + 2 * edge, height: l.clip.h + l.chrome_h + 2 * edge, boxSizing: "border-box", borderRadius: l.chrome_h * 0.35, background: pal.surface, border: `${edge}px solid ${rgba(pal.text, 0.2)}` }}>
          {[0, 1, 2].map((i) => <div key={i} style={{ position: "absolute", left: l.chrome_h * (0.4 + i * 0.5), top: l.chrome_h * 0.34, width: l.chrome_h * 0.3, height: l.chrome_h * 0.3, borderRadius: "50%", background: rgba(pal.text, 0.35) }} />)}
        </div>
      ) : null}
      {l.frame === "device" ? <div style={{ position: "absolute", left: l.clip.x - 3 * edge, top: l.clip.y - 3 * edge, width: l.clip.w + 6 * edge, height: l.clip.h + 6 * edge, borderRadius: 6 * edge, background: "#0b0f19" }} /> : null}
      <div style={{ position: "absolute", left: l.clip.x, top: l.clip.y, width: l.clip.w, height: l.clip.h, overflow: "hidden" }}>
        <Img src={staticFile(l.file)} style={{ position: "absolute", left: r.x - l.clip.x, top: r.y - l.clip.y, width: r.w, height: r.h, maxWidth: "none" }} />
      </div>
    </div>
  );
};

const AssetStage = () => null;

const BLOCKS = { message_thread: MessageThread, ui_demo: UiDemo, process_flow: ProcessFlow, data_chart: DataChart, kinetic_type: KineticType, layered_cards: LayeredCards, end_card: EndCard, asset_stage: AssetStage };

const Scene = ({ scene, fps }) => {
  const frame = useCurrentFrame();
  // a scene that opens on a carried word starts its own animation after the word has been held
  const hold = scene.held ? scene.held.hold_frames : 0;
  const pf = Math.max(0, frame - hold);
  const p = makeP(scene, pf, fps), lin = makeLinear(scene, pf, fps);
  const v = scene.visual, pal = scene.palette;
  const Block = BLOCKS[v.block];
  const T = Math.max(1, scene.frames - 1);
  const t = frame / T;
  const cam = v.camera;
  // the camera never enlarges the picture past the frame edge: the largest scale that keeps the content box inside the edge ring (and the pan's shift) is the limit
  const cb = v.block === "kinetic_type" || v.block === "end_card" ? (scene.headline ? scene.headline.box : scene.content) : scene.content;
  const keep = Math.min(scene.width, scene.height) * 0.015 + 3 + (cam === "pan_left" || cam === "pan_right" ? scene.width * 0.015 : 0);
  const room = (c, lo, size) => Math.max(c - lo, lo + size - c) > 0 ? (c - keep) / Math.max(c - lo, lo + size - c) : 9;
  const sMax = Math.max(1, Math.min(room(scene.width / 2, cb.x, cb.w), room(scene.height / 2, cb.y, cb.h)));
  const S = (z) => Math.min(z, sMax);
  const camera = cam === "push_in" ? `scale(${lerp(1, S(1.07), inOutCubic(t))})` : cam === "pull_out" ? `scale(${lerp(S(1.08), 1, inOutCubic(t))})` : cam === "pan_left" ? `translateX(${lerp(1.5, -1.5, t)}%) scale(${S(1.06)})` : cam === "pan_right" ? `translateX(${lerp(-1.5, 1.5, t)}%) scale(${S(1.06)})` : "none";
  // the camera moves the picture, not the headline: type stays on its margin, so a push or pan can never clip it
  const rv = clamp(pf / fps / (0.7 * scene.motion.speed));
  const r = outCubic(rv);
  const clip = v.reveal === "wipe_right" ? `inset(0 ${(1 - r) * 100}% 0 0)` : v.reveal === "wipe_up" ? `inset(${(1 - r) * 100}% 0 0 0)` : v.reveal === "iris" ? `circle(${r * 75}% at 50% 50%)` : "none";
  const camS = cam === "push_in" ? lerp(1, S(1.07), inOutCubic(t)) : cam === "pull_out" ? lerp(S(1.08), 1, inOutCubic(t)) : cam === "pan_left" || cam === "pan_right" ? S(1.06) : 1;
  const camTx = cam === "pan_left" ? (lerp(1.5, -1.5, t) / 100) * scene.width : cam === "pan_right" ? (lerp(-1.5, 1.5, t) / 100) * scene.width : 0;
  const showHeadline = scene.headline && v.block !== "kinetic_type" && v.block !== "end_card";
  return (
    <AbsoluteFill style={{ background: pal.background, overflow: "hidden" }}>
      <AbsoluteFill style={{ clipPath: clip }}>
        <Backdrop scene={scene} />
        <AbsoluteFill style={{ transform: camera, transformOrigin: "50% 50%" }}>
          <Block scene={scene} p={p} lin={lin} frame={frame} fps={fps} />
          {scene.badge && v.block === "ui_demo" ? <div style={{ position: "absolute", left: scene.content.x, top: scene.content.y + scene.content.h - scene.sizes.small * 1.6, fontSize: scene.sizes.small * 0.95, color: pal.muted, fontFamily: `${FAMILY}, sans-serif`, letterSpacing: 0.4, opacity: p(0.1, 0.2) }}>{scene.badge}</div> : null}
        </AbsoluteFill>
        {(scene.asset_layers ?? []).map((l, i) => <AssetLayer key={i} layer={l} frame={frame} scene={scene} />)}
        {showHeadline ? <div style={{ position: "absolute", left: 0, top: 0, width: scene.width, height: scene.height, zIndex: 40 }}>{scene.headline_scrim ? <div style={{ position: "absolute", left: scene.headline_scrim.x, top: scene.headline_scrim.y, width: scene.headline_scrim.w, height: scene.headline_scrim.h, background: rgba(pal.background, 0.84) }} /> : null}<Headline scene={scene} p={p} /></div> : null}
      </AbsoluteFill>
      {scene.held ? <HeldWord scene={scene} frame={frame} fps={fps} cam={{ s: camS, tx: camTx }} /> : null}
    </AbsoluteFill>
  );
};

export const CompositionScenes = ({ fps, scenes, font }) => {
  useFont(font);
  const cfg = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {scenes.map((scene) => (
        <Sequence key={scene.scene_id} from={scene.from_frame} durationInFrames={scene.frames}>
          <Scene scene={scene} fps={fps ?? cfg.fps} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};


