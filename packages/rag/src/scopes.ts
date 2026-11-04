import type { RetrievalRecord } from "@digikon/contracts";
import type { Collection, Doc, Hit, RetrieveFilter, RetrieveQuery, Retriever } from "./types.js";

export type Agent = "director" | "editor";

/** Collections whose documents are knowledge notes tagged with topics. Recipes, specs and facts are scoped by collection only. */
const NOTE_COLLECTIONS: readonly Collection[] = ["directing_principles", "ad_playbooks", "approved_examples"];

/**
 * What each agent may read. One retriever and one index serve both; the scope only narrows what comes back.
 * The Director covers strategy and shooting and, because it proposes the edit plan, the editing notes too. The Editor gets the
 * editing craft and recipes but no ad strategy and no brand facts: the claims it may use arrive already grounded in the handoff.
 */
export interface AgentScope {
  agent: Agent;
  collections: readonly Collection[];
  /** Topics a knowledge note must carry at least one of. */
  topics: readonly string[];
}

const DIRECTOR_TOPICS = [
  "strategy", "structure", "hook", "opening", "cta", "end card", "claims", "legal",
  "cinematography", "framing", "continuity", "reframing", "quality",
  "editing", "transitions", "motion", "text", "legibility", "sound", "loudness", "ducking",
] as const;
const EDITOR_TOPICS = [
  "editing", "cuts", "priority", "transitions", "continuity", "pacing", "rhythm",
  "audio", "sound", "loudness", "ducking", "captions",
  "motion", "animation", "easing", "text", "legibility",
] as const;

export const AGENT_SCOPES: Record<Agent, AgentScope> = {
  director: {
    agent: "director",
    collections: ["directing_principles", "ad_playbooks", "platform_specs", "shot_recipes", "brand_product_facts", "approved_examples", "skills"],
    topics: DIRECTOR_TOPICS,
  },
  editor: {
    agent: "editor",
    collections: ["directing_principles", "shot_recipes", "platform_specs", "approved_examples", "skills"],
    topics: EDITOR_TOPICS,
  },
};

/** Topics both agents can read. Everything else belongs to one agent only. */
export const sharedTopics = (): string[] => AGENT_SCOPES.director.topics.filter((t) => AGENT_SCOPES.editor.topics.includes(t));

/**
 * Wraps the shared retriever for one agent. It refuses collections outside the scope, narrows topics to the scope, keeps draft
 * recipes and draft notes out unless development mode allows them, and records every query and the ids it returned so a run
 * can be replayed. Retrieved text is reference data for the agent, never instructions.
 */
export class ScopedRetriever implements Retriever {
  readonly records: RetrievalRecord[] = [];
  readonly scope: AgentScope;

  constructor(private readonly inner: Retriever, agent: Agent, private readonly opts: { allowDraft?: boolean } = {}) {
    this.scope = AGENT_SCOPES[agent];
  }

  /** The filter actually applied, or null when the request falls outside the scope. */
  private narrow(collection: Collection, filter: RetrieveFilter = {}): RetrieveFilter | null {
    if (!this.scope.collections.includes(collection)) return null;
    const out: RetrieveFilter = { ...filter, include_draft: !!this.opts.allowDraft && !!filter.include_draft };
    if (NOTE_COLLECTIONS.includes(collection)) {
      const topics = filter.topics?.length ? filter.topics.filter((t) => this.scope.topics.includes(t)) : [...this.scope.topics];
      if (topics.length === 0) return null;
      out.topics = topics;
    }
    return out;
  }

  async retrieve(q: RetrieveQuery): Promise<Hit[]> {
    const filter = this.narrow(q.collection, q.filter);
    const hits = filter ? await this.inner.retrieve({ ...q, filter }) : [];
    this.records.push({ agent: this.scope.agent, collection: q.collection, query: q.text, filter: { ...(filter ?? { out_of_scope: true }) }, returned_ids: hits.map((h) => h.doc.id) });
    return hits;
  }

  async get(id: string, collection: Collection, filter?: RetrieveFilter): Promise<Doc | null> {
    const narrowed = this.narrow(collection, filter);
    return narrowed ? this.inner.get(id, collection, narrowed) : null;
  }

  /**
   * Retrieval that says plainly when nothing eligible exists, so the caller reports missing knowledge instead of inventing it.
   * `missing` is null when at least one document came back.
   */
  async retrieveOrReport(q: RetrieveQuery): Promise<{ hits: Hit[]; missing: string | null }> {
    const hits = await this.retrieve(q);
    if (hits.length) return { hits, missing: null };
    const why = this.scope.collections.includes(q.collection) ? "no eligible document matched" : `the ${this.scope.agent} may not read ${q.collection}`;
    return { hits, missing: `No knowledge for "${q.text}" in ${q.collection}: ${why}.` };
  }
}
