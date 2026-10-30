import { z } from "zod";

/**
 * The one delivery decision. Everything that shows a delivery (the report on disk, the API, the console) reads it from here, and nothing else
 * decides it. It is calculated from six independent criteria; each is true, false, or not yet known, and none implies another:
 *   1. scene render completion, 2. required operation completion, 3. content validation, 4. visual validation,
 *   5. approved-plan compliance, 6. recipe review and production eligibility.
 * A valid MP4 is not on this list: a technically valid file is the minimum for any result, not evidence that the video is complete or approved.
 */

export const DELIVERY_STATUSES = ["final_delivery_ready", "complete_preview", "incomplete_preview"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const CRITERIA = ["scene_render", "required_operations", "content_validation", "visual_validation", "plan_compliance", "recipe_review"] as const;
export type CriterionId = (typeof CRITERIA)[number];

export const Criterion = z.object({
  id: z.enum(CRITERIA),
  title: z.string(),
  /** true: met. false: not met. null: not established (for example visual QA was not run). */
  ok: z.boolean().nullable(),
  detail: z.string(),
  blockers: z.array(z.string()),
});
export type Criterion = z.infer<typeof Criterion>;

export const DeliveryDecision = z.object({
  status: z.enum(DELIVERY_STATUSES),
  /** One sentence for a person. The same text everywhere. */
  label: z.string(),
  /** True only for `final_delivery_ready`. */
  final: z.boolean(),
  /** True when every approved scene and operation is present (the film is the approved film, whatever else is open). */
  complete: z.boolean(),
  /** The MP4 itself passed technical validation. It is reported, and decides nothing on its own. */
  file_valid: z.boolean(),
  criteria: z.array(Criterion),
  /** Every open blocker, once each, in criterion order. */
  blockers: z.array(z.string()),
});
export type DeliveryDecision = z.infer<typeof DeliveryDecision>;

export interface DecisionInput {
  file_valid: boolean;
  scenes: readonly { scene_id: string; rendered: boolean; engine_content_checked: boolean; end_to_end_checked: boolean; unmet: readonly string[] }[];
  /** Approved operations (including transitions) that are not carried out, each with its reason. */
  omitted: readonly { operation_id: string; scene_id: string; recipe_id: string; reason: string }[];
  /** Transitions that were approved and not applied. */
  transitions_not_applied: readonly { after_scene: string; template: string; reason: string }[];
  audio_required: boolean;
  /** Measured problems in the finished film's frames. `null`: visual validation did not run. */
  visual: null | { critical_major: readonly string[]; not_checked: readonly string[] };
  /** Differences between the film and the approved plan (order, timing, templates, engines, silent replacements). */
  plan_problems: readonly string[];
  /** The recipes the film used and what production would need. */
  recipes: { draft: boolean; preview_only: boolean; blockers: readonly string[] };
}

const uniq = <T,>(xs: readonly T[]): T[] => [...new Set(xs)];

export function decideDelivery(i: DecisionInput): DeliveryDecision {
  const notRendered = i.scenes.filter((s) => !s.rendered);
  const sceneRender: Criterion = {
    id: "scene_render", title: "Scene render completion", ok: notRendered.length === 0 && i.scenes.length > 0,
    detail: `${i.scenes.length - notRendered.length} of ${i.scenes.length} scenes were rendered by an engine`,
    blockers: notRendered.map((s) => `${s.scene_id} was not rendered and is shown as a placeholder`),
  };
  const opBlockers = [
    ...i.omitted.map((o) => `${o.scene_id} ${o.recipe_id} (${o.operation_id}) is missing: ${o.reason}`),
    ...i.transitions_not_applied.map((t) => `the ${t.template} transition after ${t.after_scene} was not applied: ${t.reason}`),
    ...i.scenes.flatMap((s) => s.unmet.map((u) => `${s.scene_id}: ${u}`)),
    ...(i.audio_required ? ["the approved plan requires audio, which this phase cannot produce"] : []),
  ];
  const requiredOps: Criterion = { id: "required_operations", title: "Required operation completion", ok: opBlockers.length === 0, detail: opBlockers.length ? `${opBlockers.length} approved operation(s) or requirement(s) are not carried out` : "every approved operation and transition is carried out", blockers: uniq(opBlockers) };
  const unchecked = i.scenes.filter((s) => s.rendered && (!s.engine_content_checked || !s.end_to_end_checked));
  const content: Criterion = {
    id: "content_validation", title: "Content validation", ok: notRendered.length === 0 && unchecked.length === 0 && i.scenes.length > 0,
    detail: unchecked.length ? `${unchecked.length} rendered scene(s) were not content-checked by their engine` : notRendered.length ? "placeholders have no content to check" : "every scene's content was checked by its engine and against the final video",
    blockers: [...unchecked.map((s) => `${s.scene_id}'s content was not verified by its engine`), ...notRendered.map((s) => `${s.scene_id} has no rendered content to check`)],
  };
  const visual: Criterion = i.visual === null
    ? { id: "visual_validation", title: "Visual validation", ok: null, detail: "visual validation was not run on this film", blockers: ["visual validation has not been run on the finished film"] }
    : { id: "visual_validation", title: "Visual validation", ok: i.visual.critical_major.length === 0, detail: i.visual.critical_major.length ? `${i.visual.critical_major.length} critical or major visual problem(s)` : "no critical or major visual problem was measured", blockers: [...i.visual.critical_major] };
  const compliance: Criterion = { id: "plan_compliance", title: "Approved-plan compliance", ok: i.plan_problems.length === 0, detail: i.plan_problems.length ? `${i.plan_problems.length} difference(s) from the approved plan` : "the film matches the approved plan: scenes, order, timing, templates and engines", blockers: [...i.plan_problems] };
  const recipes: Criterion = { id: "recipe_review", title: "Recipe review and production eligibility", ok: !i.recipes.draft && !i.recipes.preview_only && i.recipes.blockers.length === 0, detail: i.recipes.draft ? "recipes used are drafts that no person has reviewed" : i.recipes.blockers.length ? "production readiness has open blockers" : "every recipe used is reviewed and eligible for production", blockers: [...(i.recipes.draft ? ["every recipe used is still a draft, so this is a preview and production rendering stays blocked"] : i.recipes.preview_only ? ["this is a preview render, not a production render"] : []), ...i.recipes.blockers] };

  const criteria = [sceneRender, requiredOps, content, visual, compliance, recipes];
  const complete = sceneRender.ok === true && requiredOps.ok === true && compliance.ok === true;
  const allOk = criteria.every((c) => c.ok === true) && i.file_valid;
  const blockers = uniq([...(i.file_valid ? [] : ["the rendered file did not pass technical validation"]), ...criteria.flatMap((c) => c.blockers)]);
  const status: DeliveryStatus = allOk ? "final_delivery_ready" : complete ? "complete_preview" : "incomplete_preview";
  const open = criteria.filter((c) => c.ok !== true).map((c) => c.title.toLowerCase());
  const label =
    status === "final_delivery_ready" ? "FINAL DELIVERY READY: every approved scene and operation is present and every check passed."
    : status === "complete_preview" ? `COMPLETE PREVIEW: every approved scene and operation is present, but it is not final delivery (open: ${open.join("; ")}).`
    : `INCOMPLETE PREVIEW: ${notRendered.length} scene(s) were not rendered and ${uniq(opBlockers).length} approved operation(s) or requirement(s) are missing or unmet. This is not the approved video.`;
  return { status, label, final: status === "final_delivery_ready", complete, file_valid: i.file_valid, criteria, blockers };
}
