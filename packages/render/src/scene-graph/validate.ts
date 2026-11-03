import { SceneGraphV2, contrastRatio, type Palette } from "@digikon/contracts";
import { ESTIMATE_METER, type TextMeter } from "../font-metrics.js";
import { detectOverflow, typeScale, wrapMeasured, LINE_HEIGHT, type Placed, type Rect } from "../layout.js";
import { compileScene, sampleScene, unitsOf, type CompiledScene } from "./compile.js";

/**
 * Checks a scene graph before anything draws it: the contract, the timing, then what the viewer would see at the end of the scene (text that fits and
 * stays inside the frame, legible against what is behind it) and for long enough to read. It reuses the layout engine and the font meter that the
 * fixed blocks are planned with, so a graph is held to the same standard as a block.
 */

export interface SceneGraphContext {
  palette: Palette;
  /** Measures text with the real font. Without it widths are estimated, generously. */
  meter?: TextMeter;
  /** The picture and clip references that exist. When given, any other reference is an issue. */
  assets?: ReadonlySet<string>;
  /** How long every text must be fully shown before the scene ends. */
  min_hold_s?: number;
}
export type SceneGraphVerdict = { ok: true; compiled: CompiledScene; issues: [] } | { ok: false; compiled: null; issues: string[] };

type Props = Record<string, unknown>;
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function resolveColor(token: string, p: Palette): string {
  return token.startsWith("#") ? token : (p as unknown as Record<string, string>)[token] ?? p.text;
}

export function validateSceneGraph(input: unknown, ctx: SceneGraphContext): SceneGraphVerdict {
  const parsed = SceneGraphV2.safeParse(input);
  if (!parsed.success) return { ok: false, compiled: null, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "scene graph"}: ${i.message}`) };
  const g = parsed.data;
  const issues: string[] = [];
  const meter = ctx.meter ?? ESTIMATE_METER;
  const { width, height, fps } = g.canvas;
  const short = Math.min(width, height);
  const compiled = compileScene(g);
  const byId = new Map(g.elements.map((e) => [e.id, e]));
  const holdS = ctx.min_hold_s ?? 0.8;

  // ---- timing sanity
  for (const e of g.elements) {
    const end = compiled.end_s[e.id]!;
    if (end > g.duration_s + 1e-6) issues.push(`${e.id} finishes at ${end.toFixed(2)}s, after the ${g.duration_s}s scene`);
    if (e.timeline.start_s >= g.duration_s) issues.push(`${e.id} starts at ${e.timeline.start_s}s, when the scene is over`);
    for (const tr of e.timeline.tracks) {
      const vals = tr.keyframes.map((k) => k.value);
      if (tr.property === "opacity" && vals.some((v) => v < 0 || v > 1)) issues.push(`${e.id}.opacity must stay between 0 and 1`);
      if (tr.property === "progress" && vals.some((v) => v < 0 || v > 1)) issues.push(`${e.id}.progress must stay between 0 and 1`);
      if (tr.property === "scale" && vals.some((v) => v <= 0 || v > 8)) issues.push(`${e.id}.scale must be above 0 and at most 8`);
      if ((tr.property === "w" || tr.property === "h") && vals.some((v) => v < 0)) issues.push(`${e.id}.${tr.property} cannot be negative`);
      if (tr.keyframes[0]!.at !== 0 || tr.keyframes[tr.keyframes.length - 1]!.at !== 1) issues.push(`${e.id}.${tr.property}: keyframes must run from 0 to 1 of the element's time`);
      if (tr.property === "x" || tr.property === "y") {
        for (let i = 1; i < tr.keyframes.length; i++) {
          const a = tr.keyframes[i - 1]!, b = tr.keyframes[i]!, secs = (b.at - a.at) * e.timeline.duration_s;
          if (secs > 0 && Math.abs(b.value - a.value) / secs > short * 6) issues.push(`${e.id}.${tr.property} moves faster than a viewer can follow`);
        }
      }
    }
    if (e.props["counter"] && e.stagger) issues.push(`${e.id} cannot be both a counter and staggered`);
    if (e.props["counter"] && !e.timeline.tracks.some((t) => t.property === "progress")) issues.push(`${e.id} is a counter and has no progress track to count with`);
    if (e.kind === "mask" && !e.timeline.tracks.some((t) => t.property === "progress")) issues.push(`${e.id} is a mask and has no progress track to reveal with`);
    if ((e.kind === "image" || e.kind === "video") && ctx.assets && !ctx.assets.has(String(e.props["asset_ref"]))) issues.push(`${e.id} uses ${String(e.props["asset_ref"])}, which is not an available asset`);
  }
  if (g.camera) {
    const c = g.camera.timeline;
    if (c.start_s + c.duration_s > g.duration_s + 1e-6) issues.push(`the camera moves until ${(c.start_s + c.duration_s).toFixed(2)}s, after the scene`);
    for (const t of c.tracks) if (t.property === "scale" && t.keyframes.some((k) => k.value < 0.5 || k.value > 3)) issues.push("the camera zoom must stay between 0.5x and 3x");
  }
  if (issues.length) return { ok: false, compiled: null, issues };

  // ---- where everything is at the end of the scene
  const last = sampleScene(compiled, compiled.frames - 1);
  const stateOf = new Map(last.elements.map((s) => [s.id, s]));
  const origin = (id: string | null): { x: number; y: number } => {
    let x = 0, y = 0;
    for (let c = id ? byId.get(id) : undefined; c; c = c.parent ? byId.get(c.parent) : undefined) {
      const s = stateOf.get(c.id)!;
      x += num((c.props as Props)["x"]) + s.x; y += num((c.props as Props)["y"]) + s.y;
    }
    return { x, y };
  };
  const safe = Math.round(short * 0.04);
  const frame: Rect = { x: 0, y: 0, w: width, h: height };
  const safeFrame: Rect = { x: safe, y: safe, w: width - 2 * safe, h: height - 2 * safe };
  const texts: (Placed & { id: string; px: number; color: string })[] = [];
  const fills: { rect: Rect; color: string; order: number }[] = [];

  g.elements.forEach((e, order) => {
    const p = e.props as Props;
    const o = origin(e.parent), s = stateOf.get(e.id)!;
    const x = o.x + num(p["x"]) + s.x, y = o.y + num(p["y"]) + s.y;
    const w = (s.w ?? num(p["w"])) * 1, h = (s.h ?? num(p["h"]));
    if (e.kind === "text") {
      const px = num(p["font_px"]), boxW = num(p["w"]);
      const floor = typeScale(width, height).minSmall;
      if (px < floor) issues.push(`${e.id}: text at ${px}px is below the ${floor}px floor for this frame`);
      const style = { upper: p["upper"] === true, bold: p["weight"] !== "regular" };
      const full = (s.text ?? unitsOf(e).join("")).replace(/ +$/gm, "");
      const counter = p["counter"] as { from: number; to: number; decimals: number; prefix: string; suffix: string } | undefined;
      const sample = counter ? [counter.from, counter.to].map((v) => `${counter.prefix}${v.toFixed(counter.decimals)}${counter.suffix}`).sort((a, b) => b.length - a.length)[0]! : String(p["text"]);
      const wrap = wrapMeasured(counter ? sample : full === "" ? String(p["text"]) : String(p["text"]), meter, px, boxW, style, false);
      if (wrap.width > boxW + 0.75) issues.push(`${e.id}: a word is wider than the ${Math.round(boxW)}px box at ${px}px`);
      const lh = num(p["line_height"], LINE_HEIGHT);
      const rect = { x, y, w: Math.min(boxW, Math.max(wrap.width, 1)), h: wrap.lines.length * px * lh };
      const align = p["align"];
      if (align === "center") rect.x = x + (boxW - rect.w) / 2; else if (align === "right") rect.x = x + boxW - rect.w;
      texts.push({ name: e.id, id: e.id, rect, px, color: resolveColor(String(p["color"] ?? "text"), ctx.palette) });
    } else if (e.kind === "shape") {
      const r = { x, y, w, h: Math.max(h, 0) };
      if (p["fill"] && p["shape"] !== "line") fills.push({ rect: r, color: resolveColor(String(p["fill"]), ctx.palette), order });
      if (r.x < frame.x - 0.75 || r.y < frame.y - 0.75 || r.x + r.w > frame.w + 0.75 || r.y + r.h > frame.h + 0.75) { /* decoration may bleed past the frame */ }
    } else if (e.kind === "image" || e.kind === "video" || e.kind === "chart") {
      if (x < -0.75 || y < -0.75 || x + w > width + 0.75 || y + h > height + 0.75) issues.push(`${e.id} (${e.kind}) leaves the frame`);
    }
  });

  // legible, inside the safe area, not on top of each other
  for (const t of texts) {
    const behind = fills.filter((f) => f.order < g.elements.findIndex((e) => e.id === t.id) && f.rect.x <= t.rect.x + 0.75 && f.rect.y <= t.rect.y + 0.75 && f.rect.x + f.rect.w >= t.rect.x + t.rect.w - 0.75 && f.rect.y + f.rect.h >= t.rect.y + t.rect.h - 0.75).pop();
    const bg = behind?.color ?? ctx.palette.background;
    const need = t.px >= short * 0.07 ? 3 : 4.5; // large text may be 3:1
    if (contrastRatio(t.color, bg) < need) issues.push(`${t.id}: text colour ${t.color} on ${bg} has contrast ${contrastRatio(t.color, bg).toFixed(1)}:1, below ${need}:1`);
  }
  issues.push(...detectOverflow(texts.map(({ name, rect }) => ({ name, rect })), safeFrame));

  // each text fully shown for long enough to be read
  for (const t of texts) {
    const e = byId.get(t.id)!;
    let shownAt: number | null = null;
    for (let f = 0; f < compiled.frames && shownAt === null; f++) {
      const st = sampleScene(compiled, f).elements.find((s) => s.id === e.id)!;
      const done = e.stagger ? (st.units ?? []).every((u) => u.opacity >= 0.99) : st.opacity >= 0.99;
      if (st.visible && done) shownAt = f / fps;
    }
    if (shownAt === null) issues.push(`${t.id} is never fully shown`);
    else if (g.duration_s - shownAt < holdS - 1e-6) issues.push(`${t.id} is fully shown for only ${(g.duration_s - shownAt).toFixed(2)}s; it needs ${holdS}s to be read`);
  }

  return issues.length ? { ok: false, compiled: null, issues } : { ok: true, compiled, issues: [] };
}

