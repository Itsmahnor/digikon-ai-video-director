import { Easing as RemotionEasing, interpolate, spring } from "remotion";
import type { SceneGraphV2 } from "@digikon/contracts";
import type { z } from "zod";
import type { SgEasing, SgElement, SgTrack } from "@digikon/contracts";

/**
 * The scene-graph compiler. A scene graph (contracts/scene-graph.ts) becomes a pure function of the frame: `sampleScene(compiled, frame)` gives the
 * state of every element and the camera, using remotion's spring() and interpolate() with the easing each segment names. Nothing here reads a file,
 * the network or the clock, so the same frame always gives the same state; the Remotion composition and the tests both draw from it.
 */

type Element = z.infer<typeof SgElement>;
type Track = z.infer<typeof SgTrack>;
type Easing = z.infer<typeof SgEasing>;

export interface Pose { x: number; y: number; scale: number; rotate: number; opacity: number; progress: number; w: number | null; h: number | null; tracking: number }
export interface UnitState extends Pose { text: string }
export interface ElementState extends Pose {
  id: string;
  kind: Element["kind"];
  parent: string | null;
  /** False before the element's start time: it is not drawn at all. */
  visible: boolean;
  /** The text as drawn at this frame: for a counter, the number so far. */
  text: string | null;
  /** A staggered text's lines, words or characters, each with its own pose. */
  units: UnitState[] | null;
}
export interface SceneState { frame: number; time_s: number; camera: { x: number; y: number; scale: number; rotate: number }; elements: ElementState[] }

export interface CompiledScene {
  fps: number;
  frames: number;
  width: number;
  height: number;
  graph: SceneGraphV2;
  /** When each element has finished moving, stagger included, in seconds. */
  end_s: Record<string, number>;
}

const DEFAULTS: Pose = { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1, progress: 1, w: null, h: null, tracking: 0 };

export function compileScene(graph: SceneGraphV2): CompiledScene {
  const end_s: Record<string, number> = {};
  for (const e of graph.elements) end_s[e.id] = e.timeline.start_s + e.timeline.duration_s + staggerSpan(e);
  return { fps: graph.canvas.fps, frames: Math.max(1, Math.round(graph.duration_s * graph.canvas.fps)), width: graph.canvas.width, height: graph.canvas.height, graph, end_s };
}

export const unitsOf = (e: Element): string[] => {
  const text = String((e.props as { text?: unknown }).text ?? "");
  const unit = e.stagger?.unit;
  if (!unit) return [text];
  if (unit === "line") return text.split("\n");
  if (unit === "word") return text.split(/(?<=\s)/); // each word keeps its trailing space so the line reads the same
  return Array.from(text);
};

function staggerSpan(e: Element): number {
  if (!e.stagger) return 0;
  return Math.max(0, unitsOf(e).length - 1) * e.stagger.each_s;
}

/** The place of unit i in the order units arrive, 0 being first. */
const arrival = (i: number, n: number, from: "start" | "end" | "center"): number => {
  if (from === "start") return i;
  if (from === "end") return n - 1 - i;
  const order = [...Array(n).keys()].sort((a, b) => Math.abs(a - (n - 1) / 2) - Math.abs(b - (n - 1) / 2) || a - b);
  return order.indexOf(i);
};

/** One easing curve applied to 0..1 progress through a segment. A spring is stretched to settle within the segment. */
export function ease(e: Easing, p: number, segFrames: number, fps: number): number {
  const t = Math.min(1, Math.max(0, p));
  if (e === "linear") return t;
  if (e === "ease_in") return RemotionEasing.in(RemotionEasing.cubic)(t);
  if (e === "ease_out") return RemotionEasing.out(RemotionEasing.cubic)(t);
  if (e === "ease_in_out") return RemotionEasing.inOut(RemotionEasing.cubic)(t);
  if ("bezier" in e) return RemotionEasing.bezier(...e.bezier)(t);
  const s = e.spring;
  if (t >= 1) return 1;
  return spring({ frame: t * segFrames, fps, durationInFrames: Math.max(2, segFrames), config: { damping: s.damping, stiffness: s.stiffness, mass: s.mass, overshootClamping: s.overshoot_clamp } });
}

/** A track's value at `t` (0..1 of the element's duration). Before the first keyframe and after the last it holds. */
export function sampleTrack(tr: Track, t: number, durationS: number, fps: number): number {
  const k = tr.keyframes;
  if (t <= k[0]!.at) return k[0]!.value;
  const last = k[k.length - 1]!;
  if (t >= last.at) return last.value;
  let i = 0;
  while (i < k.length - 2 && t >= k[i + 1]!.at) i++;
  const a = k[i]!, b = k[i + 1]!;
  const span = Math.max(1e-6, b.at - a.at);
  const p = (t - a.at) / span;
  const eased = ease(a.easing ?? tr.easing, p, span * durationS * fps, fps);
  return interpolate(eased, [0, 1], [a.value, b.value]);
}

function pose(e: Element, timeS: number, fps: number): Pose {
  const o = { ...DEFAULTS };
  const t = (timeS - e.timeline.start_s) / e.timeline.duration_s;
  for (const tr of e.timeline.tracks) (o as Record<string, number | null>)[tr.property] = sampleTrack(tr, Math.min(1, Math.max(0, t)), e.timeline.duration_s, fps);
  return o;
}

const counterText = (e: Element, progress: number): string | null => {
  const c = (e.props as { counter?: { from: number; to: number; decimals: number; prefix: string; suffix: string } }).counter;
  if (!c) return null;
  const p = Math.min(1, Math.max(0, progress));
  return `${c.prefix}${(c.from + (c.to - c.from) * p).toFixed(c.decimals)}${c.suffix}`;
};

/** The state of the whole scene at a frame. */
export function sampleScene(c: CompiledScene, frame: number): SceneState {
  const { fps } = c;
  const timeS = frame / fps;
  const elements: ElementState[] = c.graph.elements.map((e) => {
    const visible = timeS + 1e-9 >= e.timeline.start_s;
    let units: UnitState[] | null = null;
    if (e.stagger) {
      const parts = unitsOf(e), n = parts.length;
      units = parts.map((text, i) => ({ text, ...pose(e, timeS - arrival(i, n, e.stagger!.from) * e.stagger!.each_s, fps) }));
    }
    const p = pose(e, timeS, fps);
    return { id: e.id, kind: e.kind, parent: e.parent, visible, ...p, text: counterText(e, p.progress), units };
  });
  const cam = { x: 0, y: 0, scale: 1, rotate: 0 };
  const rig = c.graph.camera?.timeline;
  if (rig) {
    const t = Math.min(1, Math.max(0, (timeS - rig.start_s) / rig.duration_s));
    for (const tr of rig.tracks) cam[tr.property as keyof typeof cam] = sampleTrack(tr, t, rig.duration_s, fps);
  }
  return { frame, time_s: timeS, camera: cam, elements };
}


/** The CSS clip-path that shows `progress` of a masked region. */
export function maskClip(reveal: "left" | "right" | "up" | "down" | "circle", progress: number): string {
  const p = Math.min(1, Math.max(0, progress)), r = (1 - p) * 100;
  if (reveal === "left") return `inset(0 ${r}% 0 0)`;
  if (reveal === "right") return `inset(0 0 0 ${r}%)`;
  if (reveal === "up") return `inset(0 0 ${r}% 0)`;
  if (reveal === "down") return `inset(${r}% 0 0 0)`;
  return `circle(${(p * 75).toFixed(2)}% at 50% 50%)`;
}

