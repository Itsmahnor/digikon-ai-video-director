import type { Energy, RecipeType } from "@digikon/contracts";

export const COLLECTIONS = [
  "directing_principles",
  "ad_playbooks",
  "platform_specs",
  "shot_recipes",
  "brand_product_facts",
  "approved_examples",
] as const;
export type Collection = (typeof COLLECTIONS)[number];

export interface Doc {
  id: string;
  collection: Collection;
  title: string;
  /** What is embedded or keyword-indexed and shown to the model. */
  text: string;
  /** Where the knowledge comes from, shown with every retrieved passage. */
  source: string;
  metadata: {
    /** Required for brand_product_facts so one project can never read another's facts. */
    project_id?: string;
    /** platform_specs are retrievable only when true. */
    verified?: boolean;
    /** shot_recipes only. */
    recipe_type?: RecipeType;
    recipe_status?: "draft" | "reviewed";
    recipe_aspect_ratios?: string[];
    recipe_media_types?: string[];
    recipe_min_duration_s?: number;
    recipe_max_duration_s?: number;
    recipe_energy?: Energy;
    /** shot_recipes only. True when the recipe has a working, validated template (built in, or learned and validated). Absent means unknown. */
    recipe_implemented?: boolean;
    /** Present only when the caller knew which recipes a real render has validated; when present it, not recipe_implemented, decides the ranking boost. */
    recipe_validated?: boolean;
    topics?: string[];
    grade?: "A" | "B" | "C";
    /** Knowledge notes only. A `draft` note is never retrieved unless `include_draft` is set. Notes without a status keep today's behaviour. */
    status?: "draft" | "reviewed";
  };
}

export interface RetrieveFilter {
  project_id?: string;
  recipe_type?: RecipeType;
  aspect_ratio?: string;
  duration_s?: number;
  energy?: Energy;
  /** Media types present in the target scene. Empty array means a graphics-only scene. */
  media?: string[];
  /** Hybrid retrieval only: the film being directed. What this film has already used is ranked lower. */
  film_id?: string;
  /** Include draft recipes. Development only. */
  include_draft?: boolean;
  /** Recipes only: keep only those with a working, validated template. Recipes whose state is unknown are dropped when this is set. */
  implemented_only?: boolean;
  /** Knowledge notes only: keep notes tagged with at least one of these topics. Notes with no topics are excluded when this is set. */
  topics?: string[];
  /** Knowledge notes only: drop notes graded below this (A is best). Notes with no grade are dropped when this is set. */
  min_grade?: "A" | "B" | "C";
}

export interface RetrieveQuery {
  text: string;
  collection: Collection;
  k: number;
  filter?: RetrieveFilter;
  /** Hard cap on the combined size of returned passages (about 4 characters per token). */
  max_tokens?: number;
}

export interface Hit {
  doc: Doc;
  score: number;
}

/** Keyword and Qdrant implementations both satisfy this, so the Director never depends on the engine. */
export interface Retriever {
  retrieve(q: RetrieveQuery): Promise<Hit[]>;
  /** Fetch one document by id, applying the same eligibility rules. Used to pin policy notes that must always be shown. */
  get(id: string, collection: Collection, filter?: RetrieveFilter): Promise<Doc | null>;
}

