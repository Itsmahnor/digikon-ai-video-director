import { z } from "zod";
import { BrandFact } from "./director.js";

/**
 * The project kit (`digikon.project-kit` v1): everything the guided intake gathers before planning, with the state of every field recorded. A field is
 * `provided` (it has a value), `skipped` (the user chose not to give it) or `missing` (not asked yet, or asked and not answered). The three are never blurred:
 * a skipped field is a decision, a missing one is a question still open. Values that came from a website or a guideline file are not facts until the user confirms them.
 * The kit links to the project through `project_id`, to a saved brand through `brand_id` (Project.brand_id), and carries the video category that decides which skills are read.
 */
export const KIT_FORMAT = "digikon.project-kit" as const;
export const KIT_VERSION = 1 as const;

export const FieldState = z.enum(["provided", "skipped", "missing"]);
export type FieldState = z.infer<typeof FieldState>;
/** Where a value came from. Anything not typed by the user needs confirming before it counts. */
export const FieldSource = z.enum(["user", "website", "guideline", "upload"]);
export type FieldSource = z.infer<typeof FieldSource>;

const BLANK = { state: "missing", value: null, source: null, confirmed: false } as const;
const Hex = z.string().regex(/^#[0-9a-f]{6}$/, "colours are lower-case #rrggbb");

/** A field with its state. `provided` needs a non-empty value; `skipped` and `missing` carry none. */
function field<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    state: FieldState.default("missing"),
    value: value.nullable().default(null),
    source: FieldSource.nullable().default(null),
    /** For values that did not come from the user: has the user confirmed them? */
    confirmed: z.boolean().default(false),
  }).superRefine((f, ctx) => {
    const empty = f.value === null || (Array.isArray(f.value) && f.value.length === 0) || (typeof f.value === "string" && (f.value as string).trim() === "");
    if (f.state === "provided" && empty) ctx.addIssue({ code: "custom", message: "a provided field needs a value", path: ["value"] });
    if (f.state !== "provided" && !empty) ctx.addIssue({ code: "custom", message: `a ${f.state} field must not carry a value`, path: ["value"] });
    if (f.state !== "provided" && f.source !== null) ctx.addIssue({ code: "custom", message: `a ${f.state} field has no source`, path: ["source"] });
    if (f.state === "provided" && f.source === null) ctx.addIssue({ code: "custom", message: "a provided field names where it came from", path: ["source"] });
  }).default(BLANK as never);
}

/** A fact gathered for the kit. Only `confirmed` facts are approved brand facts. */
export const KitFact = z.object({
  fact_id: z.string().min(1),
  text: z.string().trim().min(1).max(300),
  origin: FieldSource,
  /** Where it was found (a URL or a file name), shown to the user while confirming. */
  source: z.string().max(500).default(""),
  confirmed: z.boolean().default(false),
});
export type KitFact = z.infer<typeof KitFact>;

export const VideoCategory = z.enum(["saas", "ecommerce", "general-promo"]);

export const ProjectKit = z.object({
  format: z.literal(KIT_FORMAT).default(KIT_FORMAT),
  version: z.literal(KIT_VERSION).default(KIT_VERSION),
  kit_id: z.string().min(1),
  project_id: z.string().nullable().default(null),
  /** The saved brand this kit was built from or saved to (Project.brand_id). */
  brand_id: z.string().nullable().default(null),
  video_category: VideoCategory.nullable().default(null),
  goal: field(z.string().max(500)),
  audience: field(z.string().max(500)),
  platform: field(z.string().max(100)),
  brand: z.object({
    colours: field(z.array(Hex).max(12)),
    fonts: field(z.array(z.string().trim().min(1).max(80)).max(6)),
    /** The asset id of the uploaded logo. */
    logo: field(z.string().min(1)),
    tone: field(z.string().max(300)),
  }).default(() => ({ colours: BLANK, fonts: BLANK, logo: BLANK, tone: BLANK }) as never),
  website: field(z.string().url().max(2000)),
  /** The asset id of the uploaded brand guideline file. */
  guideline: field(z.string().min(1)),
  assets: field(z.array(z.string().min(1)).max(40)),
  facts: field(z.array(KitFact).max(40)),
}).strict();
export type ProjectKit = z.infer<typeof ProjectKit>;

export const KIT_FIELDS = ["goal", "audience", "platform", "brand.colours", "brand.fonts", "brand.logo", "brand.tone", "website", "guideline", "assets", "facts"] as const;
export type KitField = (typeof KIT_FIELDS)[number];

export function emptyKit(kit_id: string, init: { project_id?: string | null; brand_id?: string | null; video_category?: z.infer<typeof VideoCategory> | null } = {}): ProjectKit {
  return ProjectKit.parse({ kit_id, project_id: init.project_id ?? null, brand_id: init.brand_id ?? null, video_category: init.video_category ?? null });
}

type Loose = { state: FieldState; value: unknown; source: FieldSource | null; confirmed: boolean };
const slot = (kit: ProjectKit, name: KitField): Loose => (name.startsWith("brand.") ? (kit.brand as Record<string, Loose>)[name.slice(6)]! : (kit as unknown as Record<string, Loose>)[name]!);

export const getField = (kit: ProjectKit, name: KitField): Loose => slot(kit, name);

function put(kit: ProjectKit, name: KitField, f: Loose): ProjectKit {
  const next = structuredClone(kit) as ProjectKit;
  if (name.startsWith("brand.")) (next.brand as Record<string, Loose>)[name.slice(6)] = f; else (next as unknown as Record<string, Loose>)[name] = f;
  return ProjectKit.parse(next); // every change is validated, so a kit can never hold a half-set field
}
/** The user (or an extractor) provides a value. Values not typed by the user start unconfirmed. */
export const provide = (kit: ProjectKit, name: KitField, value: unknown, source: FieldSource = "user"): ProjectKit => put(kit, name, { state: "provided", value, source, confirmed: source === "user" });
/** The user chooses not to give a field. */
export const skip = (kit: ProjectKit, name: KitField): ProjectKit => put(kit, name, { state: "skipped", value: null, source: null, confirmed: false });
/** Back to unanswered. */
export const unset = (kit: ProjectKit, name: KitField): ProjectKit => put(kit, name, { state: "missing", value: null, source: null, confirmed: false });
export const confirmField = (kit: ProjectKit, name: KitField): ProjectKit => { const f = slot(kit, name); if (f.state !== "provided") throw new Error(`${name} has no value to confirm`); return put(kit, name, { ...f, confirmed: true }); };

/** Facts that count as approved brand facts: typed by the user, or confirmed by them. Nothing extracted is ever approved on its own. */
export function approvedFacts(kit: ProjectKit): BrandFact[] {
  const f = kit.facts;
  if (f.state !== "provided" || !f.value) return [];
  return f.value.filter((x) => x.origin === "user" || x.confirmed).map((x) => BrandFact.parse({ fact_id: x.fact_id, text: x.text, source: x.origin === "user" ? "entered in the console" : `${x.origin}: ${x.source}`.slice(0, 300) }));
}
/** Values from a website or a file that the user has not yet confirmed, for the confirm step. */
export function unconfirmed(kit: ProjectKit): { field: KitField; origin: FieldSource }[] {
  const out: { field: KitField; origin: FieldSource }[] = [];
  for (const name of KIT_FIELDS) { const f = slot(kit, name); if (f.state === "provided" && f.source && f.source !== "user" && f.source !== "upload" && !f.confirmed) out.push({ field: name, origin: f.source }); }
  if (kit.facts.state === "provided" && kit.facts.value?.some((x) => x.origin !== "user" && !x.confirmed) && !out.some((o) => o.field === "facts")) out.push({ field: "facts", origin: kit.facts.value.find((x) => x.origin !== "user" && !x.confirmed)!.origin });
  return out;
}
