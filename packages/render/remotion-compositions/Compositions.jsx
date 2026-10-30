import React, { useEffect, useState } from "react";
import { AbsoluteFill, Sequence, cancelRender, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

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
  const layout = (f) => {
    const items = v.messages.map((m, i) => { const ls = scene.lines[`m${i}`]; const h = ls.length * f * 1.25 + f * 1.1; const w = Math.min(box.w * 0.78, Math.max(...ls.map((l) => l.length)) * f * CHAR + f * 1.8); return { m, ls, h, w }; });
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
          <div key={i} style={{ position: "absolute", left: x + jitter, top: yy, width: it.w, height: it.h, boxSizing: "border-box", padding: `${f * 0.55}px ${f * 0.9}px`, borderRadius: f * 0.9, background: bg, color: fg, fontSize: f, lineHeight: 1.25, fontFamily: `${FAMILY}, sans-serif`, fontWeight: scene.type.bold ? 700 : 400, textTransform: scene.type.upper ? "uppercase" : "none", whiteSpace: "pre", opacity: clamp(q * 2), transform: `translateY(${(1 - q) * f * 1.3}px) scale(${0.88 + 0.12 * q}) rotate(${rot * q}deg)`, boxShadow: `0 ${f * 0.3}px ${f * 0.8}px ${rgba("#000000", 0.25)}`, zIndex: i }}>
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
  const v = scene.visual, box = scene.content, f = scene.sizes.body, pal = scene.palette;
  const rowH = f * 2.1;
  const titleH = f * 2;
  const need = titleH + v.rows.length * rowH + f * 1.2;
  const h = Math.min(box.h - f * 2, need), w = box.w;
  const x = box.x, y = box.y + (box.h - h - f * 1.6) / 2;
  const win = p(0, 0.2);
  const side = v.sidebar.length ? w * 0.24 : 0;
  const rowsTop = y + titleH + f * 0.3;
  const tgt = v.cursor_target;
  const tgtY = tgt === null ? 0 : rowsTop + tgt * rowH + rowH / 2;
  const tgtX = x + side + (w - side) * 0.45;
  const cur = lin(0.3, 0.3), click = p(0.62, 0.08);
  const e = (t) => t * t * (3 - 2 * t);
  const cx = lerp(x + w * 0.95, tgtX, e(cur)), cy = lerp(y + h + f * 1.2, tgtY, e(cur));
  const confirm = p(0.7, 0.18);
  return (
    <>
      <div style={{ position: "absolute", left: x, top: y + (1 - win) * f * 1.5, width: w, height: h, borderRadius: f * 0.9, background: pal.surface, opacity: clamp(win * 2), overflow: "hidden", boxShadow: `0 ${f}px ${f * 2.4}px ${rgba("#000000", 0.35)}`, border: `1px solid ${rgba(pal.text, 0.1)}` }}>
        <div style={{ height: titleH, display: "flex", alignItems: "center", padding: `0 ${f}px`, borderBottom: `1px solid ${rgba(pal.text, 0.08)}` }}>
          {[pal.accent, pal.accent_2, pal.muted].map((c, i) => <div key={i} style={{ width: f * 0.55, height: f * 0.55, borderRadius: "50%", background: c, marginRight: f * 0.45 }} />)}
          <div style={{ marginLeft: f * 0.6, fontSize: f * 0.92, color: pal.muted, fontFamily: `${FAMILY}, sans-serif`, textTransform: scene.type.upper ? "uppercase" : "none", whiteSpace: "pre" }}>{v.window_title}</div>
        </div>
        {side ? (
          <div style={{ position: "absolute", left: 0, top: titleH, width: side, bottom: 0, borderRight: `1px solid ${rgba(pal.text, 0.08)}`, padding: `${f * 0.7}px ${f * 0.6}px` }}>
            {v.sidebar.map((s, i) => { const q = p(0.05 + i * 0.05, 0.15); return <div key={i} style={{ fontSize: scene.sizes.small, color: i === 0 ? pal.text : pal.muted, fontFamily: `${FAMILY}, sans-serif`, fontWeight: i === 0 ? 700 : 400, padding: `${f * 0.35}px ${f * 0.4}px`, marginBottom: f * 0.25, borderRadius: f * 0.4, background: i === 0 ? rgba(pal.accent, 0.2) : "transparent", opacity: q, whiteSpace: "pre", textTransform: scene.type.upper ? "uppercase" : "none" }}>{s}</div>; })}
          </div>
        ) : null}
      </div>
      {v.rows.map((r, i) => {
        const q = p(0.08 + i * 0.07, 0.16);
        const selected = tgt === i;
        const lit = selected ? click : r.state === "selected" ? 1 : 0;
        const bg = lit > 0 ? `rgba(${hexToRgb(pal.accent).join(",")},${0.18 + 0.82 * lit * (selected ? 1 : 0.6)})` : rgba(pal.text, 0.06);
        const fg = lit > 0.55 && selected ? onColor(pal.accent) : r.state === "busy" ? pal.muted : pal.text;
        return (
          <div key={i} style={{ position: "absolute", left: x + side + f * 0.8, top: rowsTop + i * rowH + (1 - q) * f, width: w - side - f * 1.6, height: rowH - f * 0.4, borderRadius: f * 0.5, background: bg, display: "flex", alignItems: "center", justifyContent: "space-between", padding: `0 ${f * 0.8}px`, opacity: clamp(q * 2) * win, boxSizing: "border-box" }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <div style={{ width: f * 0.6, height: f * 0.6, borderRadius: "50%", background: r.state === "busy" ? pal.muted : pal.accent_2, marginRight: f * 0.7 }} />
              <div style={{ fontSize: f, color: fg, fontFamily: `${FAMILY}, sans-serif`, textDecoration: r.state === "busy" ? "line-through" : "none", whiteSpace: "pre", textTransform: scene.type.upper ? "uppercase" : "none" }}>{r.label}</div>
            </div>
            {r.tag ? <div style={{ fontSize: scene.sizes.small, color: fg, opacity: 0.85, fontFamily: `${FAMILY}, sans-serif`, whiteSpace: "pre" }}>{r.tag}</div> : null}
          </div>
        );
      })}
      {tgt !== null ? <Cursor x={cx} y={cy} size={f * 1.5} scale={1 - 0.18 * (click > 0 && click < 1 ? Math.sin(click * Math.PI) : 0)} color="#ffffff" /> : null}
      {v.confirm_text ? (
        <div style={{ position: "absolute", left: x + w / 2, top: y + h + f * 0.45, transform: `translate(-50%, ${(1 - confirm) * f * 1.5}px) scale(${0.85 + 0.15 * confirm})`, opacity: clamp(confirm * 2), display: "flex", alignItems: "center", padding: `${f * 0.5}px ${f * 1.1}px`, borderRadius: f * 2, background: pal.accent_2, color: onColor(pal.accent_2), fontSize: f * 0.95, fontFamily: `${FAMILY}, sans-serif`, fontWeight: 700, boxShadow: `0 ${f * 0.4}px ${f}px ${rgba("#000000", 0.35)}`, whiteSpace: "pre" }}>
          <svg width={f} height={f} viewBox="0 0 20 20" style={{ marginRight: f * 0.5 }}><path d="M4 10.5 L8.5 15 L16 5.5" fill="none" stroke={onColor(pal.accent_2)} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {v.confirm_text}
        </div>
      ) : null}
    </>
  );
};

const ProcessFlow = ({ scene, p }) => {
  const v = scene.visual, box = scene.content, f = scene.sizes.body, pal = scene.palette;
  const n = v.steps.length;
  const horizontal = box.w / box.h > 1.15;
  const gapX = box.w * 0.06, gapY = box.h * 0.07;
  const nodeW = horizontal ? (box.w - gapX * (n - 1)) / n : box.w * 0.84;
  const nodeH = horizontal ? Math.min(box.h * 0.8, f * 6.4) : Math.min(f * 5.2, (box.h - gapY * (n - 1)) / n);
  const startX = horizontal ? box.x : box.x + (box.w - nodeW) / 2;
  const startY = horizontal ? box.y + (box.h - nodeH) / 2 : box.y + (box.h - (nodeH * n + gapY * (n - 1))) / 2;
  const pos = (i) => ({ x: horizontal ? startX + i * (nodeW + gapX) : startX, y: horizontal ? startY : startY + i * (nodeH + gapY) });
  return (
    <>
      <svg width={scene.width} height={scene.height} style={{ position: "absolute", left: 0, top: 0 }}>
        {v.steps.slice(0, -1).map((_, i) => {
          const a = pos(i), b = pos(i + 1);
          const x1 = horizontal ? a.x + nodeW : a.x + nodeW / 2, y1 = horizontal ? a.y + nodeH / 2 : a.y + nodeH;
          const x2 = horizontal ? b.x : b.x + nodeW / 2, y2 = horizontal ? b.y + nodeH / 2 : b.y;
          const q = p(i * 0.2 + 0.12, 0.14);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={pal.accent} strokeWidth={Math.max(3, f * 0.18)} strokeLinecap="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - q} />;
        })}
      </svg>
      {v.steps.map((st, i) => {
        const q = p(i * 0.2, 0.2), lit = p(i * 0.2 + 0.1, 0.1);
        const { x, y } = pos(i);
        const last = i === n - 1;
        const filled = last && lit > 0.9;
        return (
          <div key={i} style={{ position: "absolute", left: x, top: y + (1 - q) * f, width: nodeW, height: nodeH, boxSizing: "border-box", borderRadius: f * 0.8, background: filled ? pal.accent : pal.surface, border: `${Math.max(2, f * 0.1)}px solid ${lit > 0.5 ? pal.accent : rgba(pal.text, 0.15)}`, opacity: clamp(q * 2), padding: f * 0.7, display: "flex", flexDirection: "column", justifyContent: "center", color: filled ? onColor(pal.accent) : pal.text, fontFamily: `${FAMILY}, sans-serif` }}>
            <div style={{ width: f * 1.5, height: f * 1.5, borderRadius: "50%", background: filled ? onColor(pal.accent) : pal.accent, color: filled ? pal.accent : onColor(pal.accent), display: "flex", alignItems: "center", justifyContent: "center", fontSize: f * 0.85, fontWeight: 700, marginBottom: f * 0.4 }}>{i + 1}</div>
            <div style={{ fontSize: f, fontWeight: scene.type.bold ? 700 : 400, textTransform: scene.type.upper ? "uppercase" : "none", lineHeight: 1.15, whiteSpace: "pre-wrap" }}>{st.label}</div>
            {st.detail ? <div style={{ fontSize: scene.sizes.small, color: filled ? onColor(pal.accent) : pal.muted, marginTop: f * 0.25, lineHeight: 1.2, textTransform: scene.type.upper ? "uppercase" : "none" }}>{st.detail}</div> : null}
          </div>
        );
      })}
    </>
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

const LayeredCards = ({ scene, p, frame, fps }) => {
  const v = scene.visual, box = scene.content, f = scene.sizes.body, pal = scene.palette;
  const n = v.cards.length;
  const k = v.depth === "strong" ? 14 : 6;
  const cw = box.w * 0.64, ch = f * 4.6;
  const stepX = (box.w - cw) / Math.max(1, n - 1), stepY = Math.min(f * 3.2, (box.h - ch) / Math.max(1, n - 1));
  const drift = Math.sin((frame / fps) * 0.9);
  return (
    <>
      {v.cards.map((c, i) => {
        const front = i === n - 1;
        const q = p(i * 0.16, 0.22);
        const depth = (i + 1) / n;
        return (
          <div key={i} style={{ position: "absolute", left: box.x + i * stepX + drift * k * depth, top: box.y + (box.h - ch - stepY * (n - 1)) / 2 + i * stepY + (1 - q) * f * 3, width: cw, height: ch, boxSizing: "border-box", borderRadius: f * 0.9, background: front ? pal.surface : rgba(pal.surface, 0.9), border: `${Math.max(2, f * 0.08)}px solid ${front ? pal.accent : rgba(pal.text, 0.12)}`, padding: f * 0.9, color: pal.text, fontFamily: `${FAMILY}, sans-serif`, opacity: clamp(q * 2) * (0.7 + 0.3 * depth), transform: `scale(${0.94 + 0.06 * depth})`, boxShadow: `0 ${f * 0.6}px ${f * 1.6}px ${rgba("#000000", 0.3)}`, zIndex: i }}>
            <div style={{ fontSize: f, fontWeight: scene.type.bold ? 700 : 400, lineHeight: 1.15, textTransform: scene.type.upper ? "uppercase" : "none", whiteSpace: "pre-wrap" }}>{c.title}</div>
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
    <div style={{ position: "absolute", left: 0, top: 0, width: scene.width, height: scene.height, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", ...typeStyle(scene) }}>
      {v.wordmark ? <div style={{ fontSize: s * 1.15, letterSpacing: s * 0.22, color: pal.muted, textTransform: "uppercase", marginBottom: f * 0.5, opacity: p(0, 0.15), whiteSpace: "pre" }}>{v.wordmark}</div> : null}
      {h ? h.lines.map((l, i) => { const q = p(0.08 + i * 0.07, 0.2); return <div key={i} style={{ overflow: "hidden", lineHeight: 1.12, fontSize: f, whiteSpace: "pre" }}><div style={{ transform: `translateY(${(1 - q) * 105}%)` }}>{l}</div></div>; }) : null}
      <div style={{ marginTop: f * 0.7, padding: `${b * 0.7}px ${b * 1.8}px`, borderRadius: b * 2, background: pal.accent, color: onColor(pal.accent), fontSize: b, fontWeight: 700, opacity: clamp(btn * 2), transform: `scale(${0.8 + 0.2 * btn})`, whiteSpace: "pre", boxShadow: `0 ${b * 0.5}px ${b * 1.4}px ${rgba(pal.accent, 0.35)}` }}>{v.button}</div>
      {v.subline ? <div style={{ marginTop: b * 0.9, fontSize: s * 1.1, color: pal.muted, opacity: p(0.65, 0.2), whiteSpace: "pre-wrap", maxWidth: scene.width * 0.84 }}>{v.subline}</div> : null}
    </div>
  );
};

const BLOCKS = { message_thread: MessageThread, ui_demo: UiDemo, process_flow: ProcessFlow, data_chart: DataChart, kinetic_type: KineticType, layered_cards: LayeredCards, end_card: EndCard };

const Scene = ({ scene, fps }) => {
  const frame = useCurrentFrame();
  const p = makeP(scene, frame, fps), lin = makeLinear(scene, frame, fps);
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
  const rv = clamp(frame / fps / (0.7 * scene.motion.speed));
  const r = outCubic(rv);
  const clip = v.reveal === "wipe_right" ? `inset(0 ${(1 - r) * 100}% 0 0)` : v.reveal === "wipe_up" ? `inset(${(1 - r) * 100}% 0 0 0)` : v.reveal === "iris" ? `circle(${r * 75}% at 50% 50%)` : "none";
  const showHeadline = scene.headline && v.block !== "kinetic_type" && v.block !== "end_card";
  return (
    <AbsoluteFill style={{ background: pal.background, overflow: "hidden" }}>
      <AbsoluteFill style={{ clipPath: clip }}>
        <Backdrop scene={scene} />
        <AbsoluteFill style={{ transform: camera, transformOrigin: "50% 50%" }}>
          <Block scene={scene} p={p} lin={lin} frame={frame} fps={fps} />
          {scene.badge && v.block === "ui_demo" ? <div style={{ position: "absolute", left: scene.content.x, top: scene.content.y + scene.content.h - scene.sizes.small * 1.6, fontSize: scene.sizes.small * 0.95, color: pal.muted, fontFamily: `${FAMILY}, sans-serif`, letterSpacing: 0.4, opacity: p(0.1, 0.2) }}>{scene.badge}</div> : null}
        </AbsoluteFill>
        {showHeadline ? <Headline scene={scene} p={p} /> : null}
      </AbsoluteFill>
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


