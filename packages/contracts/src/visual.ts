import { z } from "zod";
import { VISUAL_SYSTEMS, VISUAL_SYSTEM_IDS } from "./visual-systems.js";

/**
 * Creative direction and the structured visual spec of a scene.
 *
 * The model proposes these; code validates them. Nothing here is executable: a scene's `visual` is data that the
 * `remotion/scene-composition` template draws (see packages/render/src/composition.ts), with every string bounded, free of control
 * characters, and never reaching a style sheet or a script except as text drawn by the renderer.
 */

const clean = (s: string) => !/[\u0000-\u001f\u007f<>]/.test(s);
/** Short display text. No control characters or angle brackets, so it can only ever be drawn as text. */
const Txt = (max: number) => z.string().trim().min(1).max(max).refine(clean, "contains control characters or angle brackets");

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour is written #rrggbb");

const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const relativeLuminance = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
/** WCAG contrast ratio of two #rrggbb colours, 1 to 21. */
export const contrastRatio = (a: string, b: string): number => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

export const Palette = z.object({
  background: HexColor,
  /** Cards, windows and panels that sit on the background. */
  surface: HexColor,
  text: HexColor,
  /** Secondary text. */
  muted: HexColor,
  accent: HexColor,
  accent_2: HexColor,
}).superRefine((p, ctx) => {
  const need = (a: keyof typeof p, b: keyof typeof p, min: number, what: string) => {
    const r = contrastRatio(p[a], p[b]);
    if (r < min) ctx.addIssue({ code: "custom", path: [a], message: `${what}: ${a} ${p[a]} on ${b} ${p[b]} has contrast ${r.toFixed(2)}, below ${min}` });
  };
  need("text", "background", 4.5, "text must be legible on the background");
  need("text", "surface", 4.5, "text must be legible on a panel");
  need("muted", "background", 3, "secondary text must stay readable");
  need("accent", "background", 3, "the accent must stand out from the background");
});
export type Palette = z.infer<typeof Palette>;

/** The film's art direction. It is part of the treatment, so the reviewer sees it before approving the storyboard. */
export const ArtDirection = z.object({
  /** What the viewer should think, feel or do by the end, in the audience's own terms. */
  audience_response: Txt(240),
  /** The one idea the film is built on. */
  concept: Txt(300),
  /** A visual metaphor that carries it, when one fits. Null is allowed: novelty for its own sake is not wanted. */
  visual_metaphor: Txt(300).nullable(),
  palette: Palette,
  typography: z.object({
    /** The renderer has one typeface file; weight, scale and case are what can vary. */
    weight: z.enum(["regular", "bold"]),
    scale: z.enum(["compact", "standard", "large"]),
    case: z.enum(["sentence", "upper"]),
    /** The typeface family. Absent: the visual system's own. */
    face: z.enum(["sans", "serif", "mono"]).optional(),
    rationale: Txt(200),
  }),
  /** The way of making this film (see visual-systems.ts). Absent on a treatment written before systems existed. */
  visual_system: z.enum(VISUAL_SYSTEM_IDS).optional(),
  /** Grid, spacing and where the eye goes first, described once so every scene follows it. */
  composition: Txt(300),
  motion_language: z.object({
    feel: z.enum(["calm", "precise", "snappy", "playful"]),
    easing: z.enum(["ease_out", "ease_in_out", "spring"]),
    description: Txt(240),
  }),
  /** The arc: what the opening, the development and the conclusion each do. */
  narrative: z.object({ opening: Txt(240), development: Txt(240), conclusion: Txt(240) }),
});
export type ArtDirection = z.infer<typeof ArtDirection>;

// ---------- scene visual spec ----------

export const VISUAL_BLOCKS = ["message_thread", "ui_demo", "process_flow", "data_chart", "kinetic_type", "layered_cards", "end_card", "title_plate", "quote_statement", "spec_callouts", "split_panels", "route_map", "timeline_path", "closing_signature", "asset_stage", "composition"] as const;
export type VisualBlock = (typeof VISUAL_BLOCKS)[number];
/** The blocks drawn entirely from data. asset_stage is not one: it needs uploaded pictures, so it is validated against real files, not example specs. */
export type DrawnBlock = Exclude<VisualBlock, "asset_stage">;
export const DRAWN_BLOCKS = VISUAL_BLOCKS.filter((b): b is DrawnBlock => b !== "asset_stage");
/** The fixed blocks the visual systems list. `composition` is not one of them: it is available in every system, because the Director composes it for the film. */
export type SystemBlock = Exclude<DrawnBlock, "composition">;

const Common = {
  /** A drawn camera over the whole composition. */
  camera: z.enum(["static", "push_in", "pull_out", "pan_left", "pan_right"]).default("static"),
  /** How the scene opens: a mask that uncovers it. */
  reveal: z.enum(["none", "wipe_right", "wipe_up", "iris"]).default("none"),
  backdrop: z.enum(["flat", "gradient", "grid", "dots", "spotlight", "vignette", "paper"]).default("flat"),
};

export const MessageThread = z.object({
  block: z.literal("message_thread"),
  messages: z.array(z.object({ from: z.enum(["them", "you"]), text: Txt(48) })).min(2).max(6),
  /** `pile_up` lets the messages crowd and overlap, to show a thread getting out of hand. */
  mode: z.enum(["stack", "pile_up"]).default("stack"),
  ...Common,
});
export const UiDemo = z.object({
  block: z.literal("ui_demo"),
  window_title: Txt(32),
  sidebar: z.array(Txt(18)).max(4).default([]),
  rows: z.array(z.object({ label: Txt(28), tag: Txt(14).nullable().default(null), state: z.enum(["open", "busy", "selected"]).default("open") })).min(2).max(6),
  /** The row a drawn cursor moves to and clicks. */
  cursor_target: z.number().int().min(0).max(5).nullable().default(null),
  /** What appears when the click lands (a confirmation). */
  confirm_text: Txt(28).nullable().default(null),
  ...Common,
});
export const ProcessFlow = z.object({
  block: z.literal("process_flow"),
  steps: z.array(z.object({ label: Txt(22), detail: Txt(36).nullable().default(null) })).min(2).max(5),
  ...Common,
});
export const DataChart = z.object({
  block: z.literal("data_chart"),
  chart: z.enum(["bars", "line"]),
  title: Txt(40),
  /** Relative heights, 0 to 100. They are never printed as numbers, and the chart is always labelled "Illustrative data". */
  points: z.array(z.object({ label: Txt(12), value: z.number().min(0).max(100) })).min(3).max(7),
  highlight_index: z.number().int().min(0).max(6).nullable().default(null),
  ...Common,
});
export const KineticType = z.object({
  block: z.literal("kinetic_type"),
  /** How the approved overlay text enters. */
  style: z.enum(["slide_stack", "word_pop", "mask_rise"]),
  /** The word (0-based) drawn in the accent colour. */
  emphasis_word: z.number().int().min(0).max(30).nullable().default(null),
  ...Common,
});
export const LayeredCards = z.object({
  block: z.literal("layered_cards"),
  cards: z.array(z.object({ title: Txt(24), detail: Txt(36).nullable().default(null) })).min(2).max(4),
  depth: z.enum(["subtle", "strong"]).default("subtle"),
  /**
   * A match cut into this scene: the scene opens with one word of the previous kinetic_type scene held exactly as that scene ends (same place, size,
   * colour, same background), then carries it into the title of one of its cards. Absent when the scene opens normally.
   */
  held: z.object({ card: z.number().int().min(0).max(3), from_scene: z.string().regex(/^S\d{2,3}$/), word_index: z.number().int().min(0).max(30) }).optional(),
  ...Common,
});
export const EndCard = z.object({
  block: z.literal("end_card"),
  /** A typeset name. This is text, never a logo. */
  wordmark: Txt(24).nullable().default(null),
  button: Txt(24),
  subline: Txt(40).nullable().default(null),
  ...Common,
});

/** One title alone on the frame, as a film or a campaign would set it. The overlay text is the title. */
export const TitlePlate = z.object({
  block: z.literal("title_plate"),
  eyebrow: Txt(32).nullable().default(null),
  subline: Txt(60).nullable().default(null),
  /** bare: the words only; hairline: thin rules draw in around them; letterbox: cinema bars close in. */
  plate: z.enum(["bare", "hairline", "letterbox"]).default("bare"),
  ...Common,
});
/** A sentence set as something somebody means. The overlay text is the quote, and it is approved copy: a quote is never invented for a real person. */
export const QuoteStatement = z.object({
  block: z.literal("quote_statement"),
  attribution: Txt(36).nullable().default(null),
  ...Common,
});
/** One form with what matters about it drawn out on leader lines: an object in a spotlight, a blueprint, a blackboard diagram. */
export const SpecCallouts = z.object({
  block: z.literal("spec_callouts"),
  /** An abstract drawn form. It stands for the subject and is never a picture of a real product. */
  form: z.enum(["orb", "slab", "column", "ring"]),
  style: z.enum(["spotlight", "blueprint", "chalk"]).default("spotlight"),
  notes: z.array(z.object({ label: Txt(22), detail: Txt(32).nullable().default(null) })).min(2).max(5),
  ...Common,
});
/** The frame cut into colour panels that slide in, one big word on each: an editorial spread. */
export const SplitPanels = z.object({
  block: z.literal("split_panels"),
  panels: z.array(z.object({ word: Txt(14), note: Txt(24).nullable().default(null) })).min(2).max(4),
  /** Which way the panels divide the frame. A portrait frame always stacks them. */
  axis: z.enum(["columns", "rows"]).default("columns"),
  ...Common,
});
/** A route that draws itself across the frame, with its stops. A drawn impression, not a map of real geography. */
export const RouteMap = z.object({
  block: z.literal("route_map"),
  stops: z.array(z.object({ label: Txt(20), note: Txt(28).nullable().default(null) })).min(2).max(5),
  shape: z.enum(["coast", "zigzag", "arc"]).default("coast"),
  ...Common,
});
/** Moments along a line: a history, a roadmap, the chapters of a story. */
export const TimelinePath = z.object({
  block: z.literal("timeline_path"),
  marks: z.array(z.object({ when: Txt(12), label: Txt(24) })).min(2).max(5),
  ...Common,
});
/** A quiet close: the name, a thin rule, one line to follow. No button. */
export const ClosingSignature = z.object({
  block: z.literal("closing_signature"),
  /** A typeset name. This is text, never a logo. */
  wordmark: Txt(28).nullable().default(null),
  action: Txt(36),
  subline: Txt(48).nullable().default(null),
  ...Common,
});

// ---------- free composition (written per scene by the Director, drawn by the scene-graph engine) ----------

const Frac = (min: number, max: number) => z.number().min(min).max(max);
const Ident = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/, "an id is letters, digits and underscores, starting with a letter");
const Token = z.enum(["text", "muted", "accent", "accent_2", "surface", "background"]);
/**
 * Where an element sits, as shares of the frame (0 to 1), so one plan draws at every size and aspect. `size` on text is a share of the frame's shorter side.
 * A portrait frame may override any of it (`portrait`), because a layout for 16:9 is rarely the right one for 9:16.
 */
const Place = z.object({ x: Frac(-0.2, 1.2), y: Frac(-0.2, 1.2), w: Frac(0.01, 1.4), h: Frac(0, 1.4).optional() });
const MotionObject = z.object({
  /** How it arrives. `rise` and `drop` move a little; `wipe` uncovers it left to right. */
  enter: z.enum(["none", "fade", "rise", "drop", "slide_left", "slide_right", "scale_in", "wipe"]).default("fade"),
  /** When it starts and how long it takes, as shares of the scene. Everything must finish early enough to be read. */
  delay: Frac(0, 0.9).default(0),
  duration: Frac(0.03, 1).default(0.2),
  easing: z.enum(["ease_out", "ease_in_out", "spring"]).default("ease_out"),
  /** Text only: lines, words or characters arrive one after another, `each` of the scene apart. */
  stagger: z.object({ unit: z.enum(["line", "word", "char"]), each: Frac(0.002, 0.2) }).optional(),
});
const Motion = MotionObject.default({});
/**
 * What the Editor may change about a composed scene: how its elements arrive (kind, delay, duration, easing, stagger) and nothing else. It is strict on purpose: a patch cannot
 * carry text, position, size, colour, shape or a picture, so the copy, facts and layout the storyboard approved stay exactly as they were. Part of the edit plan, so Gate 2 approves it.
 */
export const MotionPatch = MotionObject.partial().extend({ stagger: MotionObject.shape.stagger.nullable() }).strict();
export const CompositionMotionPlan = z.object({
  scene_id: z.string().regex(/^S\d{2,}$/),
  elements: z.array(z.object({ id: Ident, motion: MotionPatch })).min(1).max(40),
  /** Why the motion is changed, for the reviewer. */
  rationale: Txt(200),
}).strict();
export type CompositionMotionPlan = z.infer<typeof CompositionMotionPlan>;
const Override = z.object({ x: Frac(-0.2, 1.2).optional(), y: Frac(-0.2, 1.2).optional(), w: Frac(0, 1.4).optional(), h: Frac(0, 1.4).optional(), size: Frac(0.012, 0.35).optional() });

export const CompText = z.object({
  id: Ident, kind: z.literal("text"),
  text: Txt(160),
  at: Place.pick({ x: true, y: true, w: true }),
  size: Frac(0.012, 0.35),
  weight: z.enum(["regular", "bold"]).default("bold"),
  align: z.enum(["left", "center", "right"]).default("left"),
  upper: z.boolean().default(false),
  color: Token.default("text"),
  /** The film's font roles: display for headlines, body for running text, mono for labels and figures. Absent: the visual system's face. */
  font: z.enum(["display", "body", "mono"]).optional(),
  line_height: Frac(0.8, 1.8).default(1.15),
  motion: Motion,
  portrait: Override.optional(),
});
export const CompShape = z.object({
  id: Ident, kind: z.literal("shape"),
  shape: z.enum(["rect", "ellipse", "line"]),
  at: Place.required({ h: true }).extend({ w: Frac(0, 1.4), h: Frac(0, 1.4) }),
  fill: Token.optional(),
  stroke: Token.optional(),
  /** Stroke width as a share of the shorter side. */
  stroke_w: Frac(0, 0.03).default(0),
  /** Corner radius as a share of the shorter side. */
  radius: Frac(0, 0.5).default(0),
  opacity: Frac(0, 1).default(1),
  motion: Motion,
  portrait: Override.optional(),
});
export const CompElement = z.discriminatedUnion("kind", [CompText, CompShape]);
export type CompElement = z.infer<typeof CompElement>;

/**
 * A scene composed for this film: elements placed on the frame with their own type, colour, layout and motion, instead of one of the fixed blocks. The Director writes it
 * from the approved story; code checks it (bounds, legibility, timing, evidence: every word must come from the scene's approved text or facts) before it can reach Gate 1.
 * Nothing in it is executable: text is drawn as text and colours are the film's palette. Pictures are not elements: a scene's supplied pictures are placed with asset_refs and drawn over the composition.
 */
export const Composition = z.object({
  block: z.literal("composition"),
  /** What this layout does for the story, in one sentence. The reviewer reads it beside the picture. */
  intent: Txt(200),
  elements: z.array(CompElement).min(1).max(40),
  ...Common,
});

/** Structure problems of a composition that the schema cannot express (the union needs a plain object): repeated ids, and no words at all. */
export function compositionStructureIssues(c: z.infer<typeof Composition>): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const e of c.elements) { if (seen.has(e.id)) out.push(`duplicate element id ${e.id}`); seen.add(e.id); }
  if (!c.elements.some((e) => e.kind === "text")) out.push("a composition needs at least one text element: a scene with no words says nothing the reviewer can approve");
  return out;
}
/** The composition with the Editor's motion patches applied. Only the motion of the named elements changes; every other field is returned untouched. Ids the composition does not have are ignored here and reported by compositionMotionIssues. */
export function applyCompositionMotion(c: z.infer<typeof Composition>, plan: readonly { elements: readonly { id: string; motion: z.infer<typeof MotionPatch> }[] }[]): z.infer<typeof Composition> {
  const patches = new Map<string, z.infer<typeof MotionPatch>>();
  for (const p of plan) for (const e of p.elements) patches.set(e.id, { ...(patches.get(e.id) ?? {}), ...e.motion });
  if (!patches.size) return c;
  return { ...c, elements: c.elements.map((e) => {
    const p = patches.get(e.id);
    if (!p) return e;
    const { stagger, ...rest } = p;
    const next = { ...e.motion, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) } as typeof e.motion;
    if (stagger !== undefined) { if (stagger === null || e.kind !== "text") delete (next as { stagger?: unknown }).stagger; else next.stagger = stagger; }
    return { ...e, motion: next } as typeof e;
  }) };
}

/** Problems with the Editor's motion plan that need only the storyboard: a scene that is not a composition, an element that is not in it, a stagger on a shape, a scene named twice. */
export function compositionMotionIssues(plan: readonly CompositionMotionPlan[] | undefined, scenes: readonly { scene_id: string; visual: { block: string; elements?: readonly { id: string; kind: string }[] } | null }[]): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const p of plan ?? []) {
    if (seen.has(p.scene_id)) out.push(`${p.scene_id}: composition_motion names this scene twice; give each scene one entry`);
    seen.add(p.scene_id);
    const s = scenes.find((x) => x.scene_id === p.scene_id);
    if (!s || s.visual?.block !== "composition") { out.push(`${p.scene_id}: composition_motion names a scene that is not a composition; only composed scenes have motion to adjust`); continue; }
    const els = new Map((s.visual.elements ?? []).map((e) => [e.id, e.kind]));
    const ids = new Set<string>();
    for (const e of p.elements) {
      if (!els.has(e.id)) out.push(`${p.scene_id}: composition_motion names element ${e.id}, which the composition does not have (it has: ${[...els.keys()].join(", ")})`);
      else if (e.motion.stagger && els.get(e.id) !== "text") out.push(`${p.scene_id}: ${e.id} is not text, so it cannot stagger`);
      if (ids.has(e.id)) out.push(`${p.scene_id}: composition_motion names element ${e.id} twice`);
      ids.add(e.id);
    }
  }
  return out;
}
/**
 * A scene built from uploaded pictures: the scene's asset_refs say what goes where, and the overlay text is its headline. The pictures carry their own motion
 * (each ref's animation), so there is no whole-frame camera or reveal: a moved or masked frame could not be checked against the uploaded file.
 */
export const AssetStage = z.object({
  block: z.literal("asset_stage"),
  camera: z.literal("static").default("static"),
  reveal: z.literal("none").default("none"),
  backdrop: Common.backdrop,
});

export const SceneVisual = z.discriminatedUnion("block", [MessageThread, UiDemo, ProcessFlow, DataChart, KineticType, LayeredCards, EndCard, TitlePlate, QuoteStatement, SpecCallouts, SplitPanels, RouteMap, TimelinePath, ClosingSignature, AssetStage, Composition]);
export type SceneVisual = z.infer<typeof SceneVisual>;

/** Every string a visual shows, for checks that read the text (claims, characters). */
export function visualTexts(v: SceneVisual): string[] {
  switch (v.block) {
    case "message_thread": return v.messages.map((m) => m.text);
    case "ui_demo": return [v.window_title, ...v.sidebar, ...v.rows.flatMap((r) => [r.label, ...(r.tag ? [r.tag] : [])]), ...(v.confirm_text ? [v.confirm_text] : [])];
    case "process_flow": return v.steps.flatMap((s) => [s.label, ...(s.detail ? [s.detail] : [])]);
    case "data_chart": return [v.title, ...v.points.map((p) => p.label)];
    case "kinetic_type": return [];
    case "layered_cards": return v.cards.flatMap((c) => [c.title, ...(c.detail ? [c.detail] : [])]);
    case "end_card": return [...(v.wordmark ? [v.wordmark] : []), v.button, ...(v.subline ? [v.subline] : [])];
    case "title_plate": return [...(v.eyebrow ? [v.eyebrow] : []), ...(v.subline ? [v.subline] : [])];
    case "quote_statement": return v.attribution ? [v.attribution] : [];
    case "spec_callouts": return v.notes.flatMap((n) => [n.label, ...(n.detail ? [n.detail] : [])]);
    case "split_panels": return v.panels.flatMap((p) => [p.word, ...(p.note ? [p.note] : [])]);
    case "route_map": return v.stops.flatMap((p) => [p.label, ...(p.note ? [p.note] : [])]);
    case "timeline_path": return v.marks.flatMap((m) => [m.when, m.label]);
    case "closing_signature": return [...(v.wordmark ? [v.wordmark] : []), v.action, ...(v.subline ? [v.subline] : [])];
    case "asset_stage": return [];
    case "composition": return v.elements.flatMap((e) => (e.kind === "text" ? [e.text] : []));
  }
}

/** The storyboard camera motion a visual's drawn camera stands for, or null for none. */
export const STORYBOARD_CAMERA: Record<SceneVisual["camera"], string> = { static: "static", push_in: "slow_push_in", pull_out: "pull_out", pan_left: "pan_left", pan_right: "pan_right" };

export interface VisualIssue { scene_id: string; code: string; message: string }

/**
 * Creative checks that need no model. They apply only to a plan whose treatment has art direction (a plan made before it existed is
 * not judged by rules it was never given). Adjacent scenes may not repeat a block, and a block may not carry more than a third of a film.
 */
export function creativeIssues(
  scenes: readonly { scene_id: string; visual_purpose: string | null; visual: SceneVisual | null; overlay: { text: string } | null; claim_ids: string[]; asset_ids: string[]; asset_refs?: readonly { asset_id: string }[] }[],
  art: ArtDirection | null,
): VisualIssue[] {
  if (!art) return [];
  const issues: VisualIssue[] = [];
  const system = art.visual_system ? VISUAL_SYSTEMS[art.visual_system] : null;
  const seenPurpose = new Map<string, string>();
  scenes.forEach((s, i) => {
    if (!s.visual_purpose) issues.push({ scene_id: s.scene_id, code: "no_visual_purpose", message: "state what this scene's picture does that no other scene's does (visual_purpose)" });
    else {
      const key = s.visual_purpose.toLowerCase().replace(/\W+/g, " ").trim();
      const prev = seenPurpose.get(key);
      if (prev) issues.push({ scene_id: s.scene_id, code: "duplicate_visual_purpose", message: `visual_purpose repeats ${prev}'s; every scene needs its own` });
      seenPurpose.set(key, s.scene_id);
    }
    // a scene built from supplied footage or pictures is shown by its media recipes; every other scene is drawn and needs a visual
    if (!s.visual) { if (s.asset_ids.length === 0) issues.push({ scene_id: s.scene_id, code: "no_visual", message: "give the scene a structured visual (one of: " + VISUAL_BLOCKS.join(", ") + ")" }); return; }
    const placed = new Set((s.asset_refs ?? []).map((r) => r.asset_id));
    if (s.asset_ids.some((id) => !placed.has(id))) issues.push({ scene_id: s.scene_id, code: "visual_with_assets", message: "a drawn scene can only carry pictures placed in asset_refs; add an asset_refs entry for each asset, or remove the visual or the asset" });
    if (s.visual.block === "asset_stage" && placed.size === 0) issues.push({ scene_id: s.scene_id, code: "asset_stage_empty", message: "asset_stage draws the scene's asset_refs, and there are none" });
    const prev = scenes[i - 1]?.visual;
    // a run of pictures is a sequence, not a repeated layout: each shows a different file, so the block itself does not make them alike
    if (prev && prev.block === s.visual.block && s.visual.block !== "asset_stage" && s.visual.block !== "composition") issues.push({ scene_id: s.scene_id, code: "repeated_block", message: `${s.visual.block} is used again straight after ${scenes[i - 1]!.scene_id}; a neighbouring scene needs a different kind of picture` });
    if (s.visual.block === "kinetic_type" && !s.overlay) issues.push({ scene_id: s.scene_id, code: "kinetic_without_text", message: "kinetic_type animates the scene's overlay text, so the scene needs overlay text" });
    if ((s.visual.block === "title_plate" || s.visual.block === "quote_statement") && !s.overlay) issues.push({ scene_id: s.scene_id, code: "type_without_text", message: `${s.visual.block} sets the scene's overlay text, so the scene needs overlay text` });
    if (system && s.visual.block !== "asset_stage" && s.visual.block !== "composition" && !system.blocks.includes(s.visual.block as DrawnBlock)) issues.push({ scene_id: s.scene_id, code: "off_system_block", message: `${s.visual.block} is not a picture the ${system.title} system uses (${system.blocks.join(", ")}); choose one of those, or change the visual system in the treatment` });
    if (s.visual.block === "ui_demo" && s.visual.cursor_target !== null && s.visual.cursor_target >= s.visual.rows.length) issues.push({ scene_id: s.scene_id, code: "cursor_out_of_range", message: `cursor_target ${s.visual.cursor_target} is not a row (there are ${s.visual.rows.length})` });
    if (s.visual.block === "layered_cards" && s.visual.held) {
      const h = s.visual.held, src = scenes[i - 1];
      if (h.card >= s.visual.cards.length) issues.push({ scene_id: s.scene_id, code: "held_card_out_of_range", message: `held.card ${h.card} is not a card (there are ${s.visual.cards.length})` });
      else if (!src || src.scene_id !== h.from_scene || src.visual?.block !== "kinetic_type" || !src.overlay) issues.push({ scene_id: s.scene_id, code: "held_source", message: `held.from_scene must be the scene straight before, and a kinetic_type scene with overlay text` });
      else {
        const word = src.overlay.text.split(/\s+/).filter(Boolean)[h.word_index]?.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase() ?? "";
        const title = s.visual.cards[h.card]!.title.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
        if (!word || word !== title) issues.push({ scene_id: s.scene_id, code: "held_word_mismatch", message: `word ${h.word_index} of ${h.from_scene}'s text is "${word}", but card ${h.card}'s title is "${title}"; a match cut carries the same word` });
        if (src.visual.emphasis_word !== h.word_index) issues.push({ scene_id: s.scene_id, code: "held_not_emphasised", message: `${h.from_scene} draws word ${h.word_index} in the normal colour; the held word must be the emphasised one so the colour matches` });
      }
    }
    if (s.visual.block === "data_chart" && s.visual.highlight_index !== null && s.visual.highlight_index >= s.visual.points.length) issues.push({ scene_id: s.scene_id, code: "highlight_out_of_range", message: `highlight_index ${s.visual.highlight_index} is not a point` });
    // figures, money and percentages in drawn text read as claims; they need a claim behind the scene
    const shown = visualTexts(s.visual);
    if (shown.some((t) => /[%$â‚¬Â£]/.test(t)) && s.claim_ids.length === 0) issues.push({ scene_id: s.scene_id, code: "figure_without_claim", message: "the drawn text contains a % or currency sign, which reads as a claim; tie the scene to an approved claim (claim_ids) or remove it" });
  });
  if (scenes.length >= 4) {
    const counts = new Map<string, number>();
    for (const s of scenes) if (s.visual) counts.set(s.visual.block, (counts.get(s.visual.block) ?? 0) + 1);
    // A system has a narrow vocabulary on purpose: a rhythm of one kind of picture is its language, so the rule is a half there, not the third that used to force every film through the same rotation.
    const limit = system ? Math.ceil(scenes.length / 2) : Math.ceil(scenes.length / 3);
    for (const [block, n] of counts) if (block !== "asset_stage" && block !== "composition" && n > limit) issues.push({ scene_id: scenes[0]!.scene_id, code: "block_overused", message: `${block} is used in ${n} of ${scenes.length} scenes; no kind of picture may carry more than ${system ? "half" : "a third"} of a film` });
  }
  return issues;
}


