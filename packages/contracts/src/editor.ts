import { z } from "zod";
import { DirectorHandoff, HANDOFF_SCHEMA_VERSION } from "./handoff.js";
import { EditOperation } from "./schemas.js";

/**
 * The boundary of the Editor agent. The Editor receives a validated handoff and returns concrete editing decisions. It never
 * changes the approved creative direction: anything that would is returned as a revision request for the Director, which
 * goes back through the human gates. No renderer exists yet; these operations are data for a future, allowlisted renderer.
 */
export const EDITOR_SCHEMA_VERSION = "1.0.0" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const PlanRef = z.object({ version: z.number().int().positive(), hash: Sha256 });

/** One retrieval an agent made: what it asked, under which scope, and exactly which ids came back. Enough to replay it. */
export const RetrievalRecord = z.object({
  agent: z.enum(["director", "editor"]),
  collection: z.string().min(1),
  query: z.string(),
  filter: z.record(z.unknown()).default({}),
  returned_ids: z.array(z.string()),
});
export type RetrievalRecord = z.infer<typeof RetrievalRecord>;

export const EditorInput = z.object({
  schema_version: z.literal(EDITOR_SCHEMA_VERSION),
  handoff: DirectorHandoff,
  /** Skills the Editor loads for this job, as name@version. */
  skills: z.array(z.string().min(1)).min(1),
  /** The Editor only ever retrieves under its own scope. */
  retrieval_scope: z.literal("editor"),
});
export type EditorInput = z.infer<typeof EditorInput>;

/**
 * One concrete editing decision. It reuses the existing EditOperation shape and adds what ties it to the approved plan:
 * the recipe use it implements, the exact recipe version, the assets it touches and where it sits on the timeline.
 */
export const EditorOperation = EditOperation.extend({
  source_use_id: z.string().regex(/^U\d{2,}$/),
  recipe_id: z.string().min(1),
  recipe_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  asset_ids: z.array(z.string()).default([]),
  timing: z.object({ start_s: z.number().nonnegative(), duration_s: z.number().positive() }),
  /** Text the operation puts on screen and when, if any. Must be the scene's approved overlay text. */
  caption: z.object({ text: z.string().max(120), start_s: z.number().nonnegative(), end_s: z.number().positive() }).nullable().default(null),
  audio_cues: z.array(z.string()).default([]),
});
export type EditorOperation = z.infer<typeof EditorOperation>;

/** Something the Editor could not do as approved. Reported, never silently worked around. */
export const EditorConflict = z.object({
  conflict_id: z.string().min(1),
  kind: z.enum([
    "missing_information", "unsupported_operation", "infeasible", "conflicts_with_approved_plan",
    "knowledge_missing", "knowledge_conflict",
  ]),
  scene_id: z.string().nullable().default(null),
  use_id: z.string().nullable().default(null),
  description: z.string().min(1),
  evidence: z.array(z.string()).default([]),
});
export type EditorConflict = z.infer<typeof EditorConflict>;

/** A change the Editor believes is needed to an approved plan. It always needs the Director and a new human approval. */
export const RevisionRequest = z.object({
  target: z.enum(["storyboard", "edit_plan"]),
  scene_ids: z.array(z.string()).default([]),
  reason: z.string().min(1),
  requires_reapproval: z.literal(true),
});
export type RevisionRequest = z.infer<typeof RevisionRequest>;

export const EditorOutput = z
  .object({
    schema_version: z.literal(EDITOR_SCHEMA_VERSION),
    handoff_schema_version: z.literal(HANDOFF_SCHEMA_VERSION),
    /** Binds the result to the exact handoff and approved plan versions it was made from. */
    handoff_id: z.string().min(1),
    handoff_content_hash: Sha256,
    approved: z.object({ storyboard: PlanRef, edit_plan: PlanRef }),
    status: z.enum(["ready", "needs_director_revision", "blocked"]),
    operations: z.array(EditorOperation),
    validation: z.object({ ok: z.boolean(), issues: z.array(z.string()) }),
    conflicts: z.array(EditorConflict).default([]),
    revision_requests: z.array(RevisionRequest).default([]),
    provenance: z.object({
      skills: z.array(z.string()),
      recipes: z.array(z.string()),
      retrievals: z.array(RetrievalRecord),
    }),
  })
  .superRefine((o, ctx) => {
    const issue = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
    if (o.status === "ready") {
      if (o.conflicts.length) issue("a result with unresolved conflicts cannot be ready", "status");
      if (o.revision_requests.length) issue("a result that asks for a revision cannot be ready", "status");
      if (!o.validation.ok) issue("a result that failed validation cannot be ready", "status");
    }
    if (o.revision_requests.length && o.status !== "needs_director_revision") issue("a revision request must set status needs_director_revision", "status");
    if (o.status === "needs_director_revision" && !o.revision_requests.length) issue("needs_director_revision needs at least one revision request", "revision_requests");
    if (o.status === "blocked" && !o.conflicts.length && o.validation.ok) issue("a blocked result must say what blocks it", "conflicts");
  });
export type EditorOutput = z.infer<typeof EditorOutput>;
