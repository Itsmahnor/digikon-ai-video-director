import type { Capability } from "./capability.js";
import type { DrawnBlock, VisualBlock } from "./visual.js";

/**
 * A visual system is a whole way of making a film: its story shape, its kinds of picture, its type, its pacing, its joins and its sound. Choosing one is the first creative decision,
 * because a palette alone cannot turn a SaaS explainer into a perfume film. Everything here is data the Director is shown and the renderer draws from; no system is a template:
 * each picture still comes from the brief, and a system is picked because it suits the brief, never at random.
 */

export const VISUAL_SYSTEM_IDS = ["atelier", "cinema", "saas_clarity", "launch_pulse", "runway", "voyage", "classroom", "manifesto", "product_bench"] as const;
export type VisualSystemId = (typeof VISUAL_SYSTEM_IDS)[number];
export type TypeFace = "sans" | "serif" | "mono";
export type Finish = "none" | "hairline" | "letterbox" | "grain" | "blueprint";

export interface VisualSystem {
  id: VisualSystemId;
  title: string;
  /** When it is the right choice, in plain words, for the Director. */
  suits: string;
  /** The film's shape: how scenes follow each other. */
  structure: string;
  /** Other shapes this way of making films can take. Two briefs of one kind choose between them by tone and subject, never to be different for its own sake. */
  alternates: readonly string[];
  /** The kinds of picture this way of making films uses. Anything else breaks the system. */
  blocks: readonly DrawnBlock[];
  face: TypeFace;
  /** What the picture carries on top of the scene (bars, a hairline frame, grain, a technical grid). */
  finish: Finish;
  headline: "rule" | "plain";
  motion: { feel: "calm" | "precise" | "snappy" | "playful"; easing: "ease_out" | "ease_in_out" | "spring" };
  /** The joins that suit it, most typical first. */
  transitions: readonly ("cut" | "match_cut" | "crossfade" | "dip_to_black" | "wipe")[];
  /** Scene length in seconds: this is the pacing, and pacing is half of how a film feels. */
  scene_seconds: readonly [number, number];
  sound: string;
  /** Words in a brief that point to this system, with how strongly. */
  signals: readonly (readonly [RegExp, number])[];
}

const CLOSE_LUXE: readonly DrawnBlock[] = ["closing_signature"];

export const VISUAL_SYSTEMS: Readonly<Record<VisualSystemId, VisualSystem>> = {
  atelier: {
    id: "atelier", title: "Atelier", suits: "Luxury and craft: fragrance, jewellery, watches, fine objects, premium hospitality. Restraint, negative space, one object at a time.",
    structure: "Tease, reveal, detail, detail, signature. No problem, no explanation: desire is built by withholding.",
    alternates: ["The maker: one sentence of belief, the object, the hand-finished detail on leader lines, the name. For precision and collectors."],
    blocks: ["title_plate", "spec_callouts", "quote_statement", "kinetic_type", ...CLOSE_LUXE], face: "serif", finish: "hairline", headline: "plain", motion: { feel: "calm", easing: "ease_in_out" },
    transitions: ["dip_to_black", "crossfade"], scene_seconds: [3.5, 7], sound: "Sparse, slow music; no effects unless one earns its place.",
    signals: [[/\b(luxur\w*|premium|haute|bespoke|couture|fragrance|perfume|parfum|jewel\w*|watch(?:es)?|timepiece|champagne|cognac|whisky|atelier|craftsmanship|handcrafted|exclusive|elegan\w*)\b/i, 3]],
  },
  cinema: {
    id: "cinema", title: "Cinema", suits: "Brand films and stories: a founder, a mission, a place, an emotional arc. Slow, wide, serious.",
    structure: "Establish a world, a turn, a reason to care, a quiet ending. Words are sparse; each title lands alone.",
    alternates: ["Chapters: three dated titles, each a moment in a story, then the name."],
    blocks: ["title_plate", "quote_statement", "timeline_path", "kinetic_type", ...CLOSE_LUXE], face: "serif", finish: "letterbox", headline: "plain", motion: { feel: "calm", easing: "ease_in_out" },
    transitions: ["dip_to_black", "crossfade", "cut"], scene_seconds: [4, 8], sound: "A slow score under the whole film, narration if the story needs a voice.",
    signals: [[/\b(cinematic|brand film|film-like|documentary|anthem|story of|our story|heritage|legacy|emotional|founder)\b/i, 3], [/\b(mission|journey|purpose)\b/i, 1]],
  },
  saas_clarity: {
    id: "saas_clarity", title: "Clarity", suits: "Software that solves a recognisable workday problem, shown in conversation and in interface.",
    structure: "Problem, agitation, the product doing one thing, how it works, one action.",
    alternates: ["The running joke: one small frustration told in big type, escalating scene by scene with a playful feel and spring easing, until the product ends it in a single gesture. No process diagram.", "Before and after: the same picture twice, messy then calm, then one action."],
    blocks: ["message_thread", "ui_demo", "process_flow", "layered_cards", "data_chart", "kinetic_type", "end_card"], face: "sans", finish: "none", headline: "rule", motion: { feel: "precise", easing: "ease_out" },
    transitions: ["cut", "wipe", "crossfade"], scene_seconds: [2.5, 5], sound: "A light rhythmic bed, a click or a chime on an interface moment.",
    signals: [[/\b(saas|software|crm|dashboard|automation|workflow|platform|b2b|productivity|subscription|tool for teams?|sign[- ]?ups?|trial)\b/i, 3], [/\b(app|startup|teams?)\b/i, 1]],
  },
  launch_pulse: {
    id: "launch_pulse", title: "Launch pulse", suits: "New hardware or a technology launch: momentum, anticipation, specifications as drama.",
    structure: "Tease in fragments, count up, reveal, three hard specifications, date and action.",
    alternates: ["Blueprint reveal: the form is drawn line by line, labelled, then named."],
    blocks: ["kinetic_type", "spec_callouts", "title_plate", "data_chart", "end_card"], face: "mono", finish: "blueprint", headline: "plain", motion: { feel: "snappy", easing: "ease_out" },
    transitions: ["cut", "wipe", "match_cut"], scene_seconds: [1.5, 3.5], sound: "A driving pulse, hits on the reveals.",
    signals: [[/\b(launch\w*|unveil\w*|introducing|next[- ]gen\w*|announc\w*|new (?:chip|device|phone|laptop|headset|robot|gadget)|hardware|chipset|processor|flagship)\b/i, 3], [/\b(tech|technology|innovation|keynote)\b/i, 1]],
  },
  runway: {
    id: "runway", title: "Runway", suits: "Fashion and beauty campaigns, streetwear, attitude: editorial layouts, oversized words, rhythm.",
    structure: "A rhythm, not an argument: look, look, statement, look, name. No explanation at all.",
    alternates: ["One word, many ways: a single word recurs across panels until it means something new."],
    blocks: ["split_panels", "kinetic_type", "title_plate", ...CLOSE_LUXE], face: "serif", finish: "grain", headline: "plain", motion: { feel: "snappy", easing: "ease_in_out" },
    transitions: ["cut", "wipe"], scene_seconds: [1.5, 3], sound: "A confident beat; cuts land on it.",
    signals: [[/\b(fashion|apparel|streetwear|sportswear|lookbook|collection|runway|couture|garment|sneakers?|footwear|editorial|beauty|cosmetic\w*|makeup|skincare)\b/i, 3], [/\b(style|outfit|wear)\b/i, 1]],
  },
  voyage: {
    id: "voyage", title: "Voyage", suits: "Travel, places, hospitality, tourism boards: a route, a sense of arriving somewhere.",
    structure: "Departure, the route, stops along the way, the arrival and the invitation to go.",
    alternates: ["A week in days: each scene one day, each day its own colour, ending on the place."],
    blocks: ["route_map", "title_plate", "split_panels", "timeline_path", ...CLOSE_LUXE], face: "serif", finish: "grain", headline: "plain", motion: { feel: "calm", easing: "ease_out" },
    transitions: ["crossfade", "wipe", "dip_to_black"], scene_seconds: [3, 6], sound: "Warm, open music that builds as the route unfolds.",
    signals: [[/\b(travel\w*|tourism|tourist|destination|holiday|vacation|resort|hotel|airline|flights?|cruise|itinerary|trip|island|escape|getaway|safari|hiking)\b/i, 3], [/\b(adventure|explore|journey)\b/i, 1]],
  },
  classroom: {
    id: "classroom", title: "Classroom", suits: "Teaching: a concept explained step by step, a question answered, a lesson remembered.",
    structure: "A question, a picture of the idea, its parts one at a time, an example, the one thing to remember.",
    alternates: ["A myth corrected: what people think, why it is wrong, what is true."],
    blocks: ["spec_callouts", "process_flow", "data_chart", "kinetic_type", "layered_cards", "end_card"], face: "sans", finish: "none", headline: "plain", motion: { feel: "precise", easing: "ease_out" },
    transitions: ["crossfade", "cut"], scene_seconds: [3, 7], sound: "Clear narration, quiet music, a soft chime on each new idea.",
    signals: [[/\b(educational|explainer|explain|teach\w*|lesson|learn\w*|students?|course|tutorial|how (?:it|does)|science|school|concept|classroom|university)\b/i, 3]],
  },
  manifesto: {
    id: "manifesto", title: "Manifesto", suits: "Corporate brand, values, recruitment, annual story: what a company believes and where it has been.",
    structure: "A belief, the history behind it, what it means now, the promise, the name.",
    alternates: ["Promises kept: three promises, each set alone, each with one line of proof from an approved fact."],
    blocks: ["quote_statement", "timeline_path", "title_plate", "kinetic_type", "layered_cards", ...CLOSE_LUXE], face: "serif", finish: "hairline", headline: "plain", motion: { feel: "calm", easing: "ease_out" },
    transitions: ["crossfade", "dip_to_black", "cut"], scene_seconds: [3, 6], sound: "A measured score, narration carrying the belief.",
    signals: [[/\b(corporate|company values?|enterprise|annual|stakeholders?|investors?|recruit\w*|culture|employer|sustainab\w*|manifesto|our values|brand film|institution\w*)\b/i, 3], [/\b(mission|vision|purpose)\b/i, 1]],
  },
  product_bench: {
    id: "product_bench", title: "Product bench", suits: "A real product shown working: the object or the interface is the star and words only label it.",
    structure: "The product at once, what it does, the detail that matters, it working, where to get it.",
    alternates: ["The object on the bench: for a physical product. The form lit with its details on leader lines, then the steps of using it, then one action. No interface and no windows."],
    blocks: ["ui_demo", "spec_callouts", "process_flow", "layered_cards", "end_card"], face: "mono", finish: "none", headline: "rule", motion: { feel: "precise", easing: "ease_in_out" },
    transitions: ["cut", "crossfade"], scene_seconds: [3, 6], sound: "Quiet, with clicks and small effects on what the product does.",
    signals: [[/\b(demo|demonstration|walkthrough|how to use|feature tour|product tour|hands[- ]on|in action|screen recording|step[- ]by[- ]step)\b/i, 3], [/\b(product|feature)\b/i, 1]],
  },
};

export interface SystemRank { id: VisualSystemId; score: number; reasons: string[] }

/** Tone words change the reading of a brief: two SaaS briefs, one playful and one serious, should not get the same film. */
const TONE: readonly (readonly [RegExp, Partial<Record<VisualSystemId, number>>])[] = [
  [/\b(playful|fun|quirky|cheeky|bold|energetic|edgy|attitude|hype)\b/i, { launch_pulse: 2, runway: 2, saas_clarity: 1 }],
  [/\b(calm|serene|quiet|minimal\w*|understated|timeless|refined|poetic)\b/i, { atelier: 2, cinema: 2, manifesto: 1 }],
  [/\b(trust\w*|serious|credib\w*|professional|authority|reliable)\b/i, { manifesto: 2, classroom: 1, product_bench: 1 }],
  [/\b(story|emotion\w*|inspir\w*|human|heartfelt)\b/i, { cinema: 2, manifesto: 1 }],
  [/\b(technical|engineers?|developers?|specs?|specification\w*|precision)\b/i, { product_bench: 2, launch_pulse: 2 }],
];

/** Ranks every system against the brief. Deterministic: the same brief gives the same ranking, and the ranking is a shortlist for the Director, who decides. */
export function rankVisualSystems(text: string): SystemRank[] {
  const out = VISUAL_SYSTEM_IDS.map((id): SystemRank => {
    let score = 0;
    const reasons: string[] = [];
    for (const [re, w] of VISUAL_SYSTEMS[id].signals) { const m = text.match(re); if (m) { score += w; reasons.push(`the brief says "${m[0].toLowerCase()}"`); } }
    for (const [re, add] of TONE) { const w = add[id]; const m = w ? text.match(re) : null; if (w && m) { score += w; reasons.push(`its tone is "${m[0].toLowerCase()}"`); } }
    return { id, score, reasons };
  });
  return out.sort((a, b) => b.score - a.score || VISUAL_SYSTEM_IDS.indexOf(a.id) - VISUAL_SYSTEM_IDS.indexOf(b.id));
}

/** Pictures that read alike at a glance. Two neighbours of one family look like the same scene even when the block differs. */
export const BLOCK_FAMILY: Readonly<Record<VisualBlock, string>> = {
  message_thread: "interface", ui_demo: "interface", process_flow: "diagram", data_chart: "diagram", spec_callouts: "diagram", route_map: "path", timeline_path: "path",
  kinetic_type: "type", title_plate: "type", quote_statement: "type", layered_cards: "panels", split_panels: "panels", end_card: "closing", closing_signature: "closing", asset_stage: "picture",
};

export interface BlockRank { block: VisualBlock; score: number; reasons: string[] }
export interface BlockContext {
  system: VisualSystemId | null;
  /** How far each block's capability has come. A block with no live implementation is not offered at all. */
  readiness: (block: VisualBlock) => Capability["status"] | null;
  has_pictures: boolean;
  /** Blocks already used in this film, in order. */
  used: readonly VisualBlock[];
}

/**
 * Ranks the blocks for the next scene: creative fit first, then proven readiness, then what the assets allow, and last how alike it would look next to what the film already has. The
 * similarity penalty is a cost, not a ban: a block may repeat when it is the right picture, and this never picks at random.
 */
export function rankVisualBlocks(c: BlockContext, candidates: readonly VisualBlock[]): BlockRank[] {
  const sys = c.system ? VISUAL_SYSTEMS[c.system] : null;
  const prev = c.used[c.used.length - 1];
  const ranks: BlockRank[] = [];
  for (const block of candidates) {
    const r = c.readiness(block);
    if (!r || r === "registered" || r === "deprecated") continue;
    const reasons: string[] = [];
    let score = 0;
    if (block === "asset_stage") { if (!c.has_pictures) continue; score += 4; reasons.push("a real picture was supplied"); }
    else if (!sys || sys.blocks.includes(block)) { score += 3; if (sys) reasons.push(`part of ${sys.title}`); }
    else { score -= 3; reasons.push(`not part of ${sys.title}`); }
    if (r === "validated" || r === "reviewed" || r === "production") { score += 2; reasons.push(`readiness ${r}`); } else reasons.push(`readiness ${r}: not validated`);
    if (prev && prev === block && block !== "asset_stage") { score -= 3; reasons.push("the scene before uses it"); }
    else if (prev && BLOCK_FAMILY[prev] === BLOCK_FAMILY[block] && block !== "asset_stage") { score -= 1; reasons.push(`looks like the scene before (${BLOCK_FAMILY[block]})`); }
    const n = c.used.filter((b) => b === block).length;
    if (n) { score -= n * 0.5; reasons.push(`used ${n} time${n === 1 ? "" : "s"} already`); }
    ranks.push({ block, score, reasons });
  }
  return ranks.sort((a, b) => b.score - a.score || candidates.indexOf(a.block) - candidates.indexOf(b.block));
}
