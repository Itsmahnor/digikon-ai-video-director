import { z } from "zod";
import { completeness, type Level } from "./kit-completeness.js";
import { KIT_FIELDS, getField, provide, skip, type KitField, type ProjectKit } from "./kit.js";

/**
 * Typed intake questions (C6). Instead of a free-text list of questions, the intake step asks one typed question per missing field: an upload, a choice, or a short text,
 * each with a Skip where skipping is allowed. Which questions to ask comes from the kit and the completeness check (plain code, no model): only fields that are still missing,
 * required ones first. Answers are applied to the kit through the same validation as everything else, so a bad answer is refused with a reason, never stored.
 * Questions that older runs or a model produced as plain strings are read as text questions that belong to no field.
 */
export const QuestionKind = z.enum(["upload", "choice", "text"]);
export const UploadAccept = z.enum(["image", "pdf", "video", "audio", "any"]);
export const QuestionOption = z.object({ value: z.string().min(1), label: z.string().min(1) });

export const Question = z.object({
  id: z.string().min(1),
  /** The kit field the answer fills; null for a free-form question that is not tied to the kit. */
  field: z.enum(KIT_FIELDS).nullable().default(null),
  kind: QuestionKind,
  prompt: z.string().min(1).max(400),
  help: z.string().max(300).default(""),
  options: z.array(QuestionOption).max(20).default([]),
  accept: UploadAccept.nullable().default(null),
  placeholder: z.string().max(200).default(""),
  /** True when Skip is allowed. Required fields cannot be skipped. */
  skippable: z.boolean().default(false),
  level: z.enum(["required", "recommended", "optional"]).default("recommended"),
}).strict();
export type Question = z.infer<typeof Question>;

export const Answer = z.object({
  question_id: z.string().min(1),
  action: z.enum(["answer", "skip"]),
  /** Text, a chosen option value, or asset ids for an upload (a list for several files). */
  value: z.union([z.string(), z.array(z.string())]).optional(),
}).strict();
export type Answer = z.infer<typeof Answer>;

export const PLATFORM_OPTIONS = ["Instagram Reels", "TikTok", "YouTube Shorts", "YouTube", "LinkedIn", "Instagram or Facebook feed", "Website hero"] as const;

type Template = Omit<Question, "id" | "field" | "skippable" | "level">;
const TEMPLATES: Record<KitField, Template> = {
  goal: { kind: "text", prompt: "What is this video for?", help: "A sentence is enough, for example the action you want viewers to take.", options: [], accept: null, placeholder: "e.g. Get free-trial sign-ups for our invoicing app" },
  audience: { kind: "text", prompt: "Who should watch it?", help: "", options: [], accept: null, placeholder: "e.g. Freelancers and small agencies" },
  platform: { kind: "choice", prompt: "Where will it be shown?", help: "This decides the shape and length.", options: PLATFORM_OPTIONS.map((p) => ({ value: p, label: p })), accept: null, placeholder: "" },
  "brand.colours": { kind: "text", prompt: "Which brand colours should I use?", help: "Hex codes, separated by spaces, e.g. #c8501e #0a7a5a. Skip and I will use neutral colours.", options: [], accept: null, placeholder: "#c8501e #0a7a5a" },
  "brand.fonts": { kind: "text", prompt: "Which fonts does your brand use?", help: "Separate with commas.", options: [], accept: null, placeholder: "Inter, Fraunces" },
  "brand.logo": { kind: "upload", prompt: "Do you have a logo to upload?", help: "PNG, JPG, WebP or SVG. Skip and I will not draw one.", options: [], accept: "image", placeholder: "" },
  "brand.tone": { kind: "text", prompt: "How should it sound?", help: "A few words about the tone of voice.", options: [], accept: null, placeholder: "e.g. warm and direct" },
  website: { kind: "text", prompt: "What is your website address?", help: "I can read it for colours, fonts and facts, and you confirm what to use.", options: [], accept: null, placeholder: "https://example.com" },
  guideline: { kind: "upload", prompt: "Do you have a brand guideline PDF?", help: "Optional. Up to 20 MB.", options: [], accept: "pdf", placeholder: "" },
  assets: { kind: "upload", prompt: "Do you have videos, images or audio I should use?", help: "Skip and I will plan a graphics-led video.", options: [], accept: "any", placeholder: "" },
  facts: { kind: "text", prompt: "What can I truthfully say about the business?", help: "One fact per line. Only claims backed by a fact here can appear in the video.", options: [], accept: null, placeholder: "Beans are roasted weekly in small batches." },
};

export const questionId = (field: KitField) => `q_${field.replace(".", "_")}`;
/** A question that is not tied to the kit, from a plain string (an older run, or a model that returned free text). */
export function textQuestion(prompt: string, index = 0): Question {
  return Question.parse({ id: `q_free_${index + 1}`, field: null, kind: "text", prompt: prompt.trim().slice(0, 400) || "Can you tell me more?", skippable: false, level: "required" });
}
/** Accepts what intake used to return (strings) or typed questions. */
export const QuestionList = z.preprocess((v) => (Array.isArray(v) ? v.map((x, i) => (typeof x === "string" ? textQuestion(x, i) : x)) : v), z.array(Question));

/**
 * The questions still to ask for this kit, from the completeness check: required fields not yet provided first, then recommended ones still missing.
 * Nothing that was provided or deliberately skipped is asked again. Optional fields are never asked.
 */
export function questionsFor(kit: ProjectKit, opts: { levels?: readonly Level[] } = {}): Question[] {
  const levels = new Set<Level>(opts.levels ?? ["required", "recommended"]);
  const c = completeness(kit);
  return c.next.flatMap((field) => {
    const item = c.items.find((i) => i.field === field)!;
    if (!levels.has(item.level)) return [];
    return [Question.parse({ ...TEMPLATES[field], id: questionId(field), field, skippable: item.can_skip, level: item.level })];
  });
}

export class AnswerRefused extends Error {}

/**
 * Applies one answer to the kit. The id must be one of the kit's question ids (a field's question, whether or not it was already answered, so an answer can be changed); an unknown id is refused.
 * Skip is refused for a required question. Typed values are validated by the kit itself.
 */
export function applyAnswer(kit: ProjectKit, answer: Answer): ProjectKit {
  const a = Answer.parse(answer);
  const q = questionsFor(kit, { levels: ["required", "recommended", "optional"] }).find((x) => x.id === a.question_id) ?? KIT_FIELDS.map((f) => ({ id: questionId(f), field: f })).find((x) => x.id === a.question_id) as Question | undefined;
  if (!q || !q.field) throw new AnswerRefused(`there is no open question ${a.question_id}`);
  const field = q.field as KitField;
  if (a.action === "skip") {
    if (!completeness(kit).items.find((i) => i.field === field)!.can_skip) throw new AnswerRefused(`${field} is required and cannot be skipped`);
    return skip(kit, field);
  }
  const raw = a.value;
  if (raw === undefined || (Array.isArray(raw) ? raw.length === 0 : raw.trim() === "")) throw new AnswerRefused("an answer needs a value, or choose Skip");
  const first = Array.isArray(raw) ? raw[0]! : raw;
  switch (field) {
    case "brand.colours": {
      const parts = (Array.isArray(raw) ? raw : raw.split(/[\s,;]+/)).filter(Boolean).map((c) => c.toLowerCase().replace(/^#?/, "#").replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, "#$1$1$2$2$3$3"));
      const bad = parts.filter((c) => !/^#[0-9a-f]{6}$/.test(c));
      if (bad.length) throw new AnswerRefused(`I could not read ${bad.join(", ")} as a colour; use hex codes like #c8501e`);
      return provide(kit, field, [...new Set(parts)], "user");
    }
    case "brand.fonts": return provide(kit, field, [...new Set((Array.isArray(raw) ? raw : raw.split(/[,;\n]+/)).map((s) => s.trim()).filter(Boolean))], "user");
    case "assets": return provide(kit, field, Array.isArray(raw) ? raw : [raw], "upload");
    case "brand.logo": case "guideline": return provide(kit, field, first, "upload");
    case "facts": {
      const lines = (Array.isArray(raw) ? raw : raw.split("\n")).map((s) => s.trim()).filter(Boolean);
      const kept = (getField(kit, "facts").value as { fact_id: string; origin: string }[] | null)?.filter((f) => f.origin !== "user") ?? [];
      const mine = lines.map((text, i) => ({ fact_id: `F${String(i + 1).padStart(2, "0")}`, text, origin: "user", source: "entered in the console", confirmed: true }));
      return provide(kit, field, [...mine, ...kept.map((f, i) => ({ ...f, fact_id: `F${String(mine.length + i + 1).padStart(2, "0")}` }))] as never, "user");
    }
    case "platform": {
      const ok = TEMPLATES.platform.options.some((o) => o.value === first) || first.trim().length > 0;
      if (!ok) throw new AnswerRefused("choose one of the platforms");
      return provide(kit, field, first.trim(), "user");
    }
    default: return provide(kit, field, first.trim(), "user");
  }
}
