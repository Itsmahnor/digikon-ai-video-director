import { LlmError, type GenerateRequest, type LlmClient, type LlmErrorCode } from "./llm.js";

/**
 * A thin layer over any `LlmClient`: provider/model selection by configuration, retry of transient failures, a hard per-film token/cost budget and a call log.
 * Structured output is passed straight through to the inner client (the request and its zod schema are not touched). With no budget, no log and a single
 * provider the gateway behaves exactly like the client it wraps, so wiring it in changes nothing until it is configured.
 */

export interface TokenUsage { input_tokens: number; output_tokens: number }
/** Dollars per million tokens. No prices are assumed: without them only the token budget applies. */
export interface ModelPrice { input_per_mtok: number; output_per_mtok: number }
export interface FilmBudget { max_tokens?: number; max_cost_usd?: number }

export interface CallLogEntry {
  film_id: string | null; provider: string; model: string; name: string;
  input_tokens: number; output_tokens: number; cost_usd: number; attempts: number;
  outcome: "ok" | "error" | "budget_stop"; error_code: string | null; duration_ms: number;
}
export interface CallLog { record(entry: CallLogEntry): void | Promise<void> }

export class InMemoryCallLog implements CallLog {
  readonly entries: CallLogEntry[] = [];
  record(e: CallLogEntry) { this.entries.push({ ...e }); }
}

/** Writes to the model_calls table through anything with the shape of `DataStore.logModelCall` (see @digikon/rag). A log failure never fails the model call. */
export class DbCallLog implements CallLog {
  constructor(private readonly store: { logModelCall(row: CallLogEntry): Promise<void> }, private readonly onError: (e: unknown) => void = () => {}) {}
  async record(e: CallLogEntry) { try { await this.store.logModelCall(e); } catch (err) { this.onError(err); } }
}

/** One selectable backend. The client is made lazily, so an unused provider needs no key. */
export interface ProviderConfig {
  /** Builds the client for a model. `onUsage` must be called with the provider's reported token counts after each request, when the provider reports them. */
  create(model: string, onUsage: (u: TokenUsage) => void): LlmClient;
  prices?: Record<string, ModelPrice>;
}

export interface GatewayConfig {
  provider: string;
  model: string;
  providers: Record<string, ProviderConfig>;
  /** Extra tries after a transient failure (rate limit, overload, network). Default 2. */
  retries?: number;
  backoff_ms?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  budget?: FilmBudget;
  log?: CallLog;
}

const TRANSIENT = new Set<LlmErrorCode>(["llm_rate_limit", "llm_overloaded", "llm_network"]);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const roughTokens = (s: string) => Math.ceil(s.length / 4);

interface Spend { tokens: number; cost_usd: number }

export class ModelGateway {
  private readonly spend = new Map<string, Spend>();
  private readonly clients = new Map<string, LlmClient>();
  /** Reports of the call in flight; calls are sequential per client, and a parallel call would only misattribute usage inside one log line, never the budget. */
  private pending: TokenUsage[] = [];

  constructor(private readonly cfg: GatewayConfig) {
    if (!cfg.providers[cfg.provider]) throw new Error(`model gateway: no provider "${cfg.provider}" is configured (have: ${Object.keys(cfg.providers).join(", ") || "none"})`);
  }

  get provider() { return this.cfg.provider; }
  get model() { return this.cfg.model; }
  /** What a film has used so far. */
  spent(filmId: string): Spend { return { ...(this.spend.get(filmId) ?? { tokens: 0, cost_usd: 0 }) }; }

  /** An `LlmClient` for one film: its calls count against that film's budget and are logged with its id. */
  forFilm(filmId: string | null): LlmClient {
    const self = this;
    return {
      get predatesArtDirection() { return self.client().predatesArtDirection; },
      generate: <T>(req: GenerateRequest<T>) => self.generate(filmId, req),
    };
  }

  private client(): LlmClient {
    const key = `${this.cfg.provider}|${this.cfg.model}`;
    let c = this.clients.get(key);
    if (!c) { c = this.cfg.providers[this.cfg.provider]!.create(this.cfg.model, (u) => this.pending.push(u)); this.clients.set(key, c); }
    return c;
  }

  private price(): ModelPrice | undefined { return this.cfg.providers[this.cfg.provider]!.prices?.[this.cfg.model]; }
  private costOf(u: TokenUsage): number { const p = this.price(); return p ? (u.input_tokens * p.input_per_mtok + u.output_tokens * p.output_per_mtok) / 1e6 : 0; }

  private overBudget(filmId: string | null): string | null {
    const b = this.cfg.budget;
    if (!b || filmId === null) return null;
    const s = this.spent(filmId);
    if (b.max_tokens !== undefined && s.tokens >= b.max_tokens) return `film ${filmId} used ${s.tokens} of its ${b.max_tokens} token budget`;
    if (b.max_cost_usd !== undefined && s.cost_usd >= b.max_cost_usd) return `film ${filmId} spent $${s.cost_usd.toFixed(4)} of its $${b.max_cost_usd} budget`;
    return null;
  }

  async generate<T>(filmId: string | null, req: GenerateRequest<T>): Promise<T> {
    const started = Date.now();
    const base = { film_id: filmId, provider: this.cfg.provider, model: this.cfg.model, name: req.name };
    const stop = this.overBudget(filmId);
    if (stop) {
      await this.cfg.log?.record({ ...base, input_tokens: 0, output_tokens: 0, cost_usd: 0, attempts: 0, outcome: "budget_stop", error_code: "llm_budget", duration_ms: 0 });
      throw new LlmError("llm_budget", `The model budget for this film is spent (${stop}). Raise the budget to continue.`);
    }
    const retries = this.cfg.retries ?? 2;
    const sleep = this.cfg.sleep ?? defaultSleep;
    const backoff = this.cfg.backoff_ms ?? ((n) => 500 * 2 ** n);
    let attempts = 0, lastErr: unknown;
    const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    const take = () => { for (const u of this.pending.splice(0)) { usage.input_tokens += u.input_tokens; usage.output_tokens += u.output_tokens; } };
    const finish = async (outcome: "ok" | "error", code: string | null) => {
      take();
      // A provider that reports no usage is counted by a rough estimate of the text sent, so the budget still bites.
      if (usage.input_tokens + usage.output_tokens === 0) usage.input_tokens = roughTokens(req.system + req.user);
      const cost = this.costOf(usage);
      if (filmId !== null) { const s = this.spend.get(filmId) ?? { tokens: 0, cost_usd: 0 }; s.tokens += usage.input_tokens + usage.output_tokens; s.cost_usd += cost; this.spend.set(filmId, s); }
      await this.cfg.log?.record({ ...base, ...usage, cost_usd: cost, attempts, outcome, error_code: code, duration_ms: Date.now() - started });
    };
    for (let i = 0; i <= retries; i++) {
      attempts++;
      try {
        const out = await this.client().generate(req);
        await finish("ok", null);
        return out;
      } catch (e) {
        lastErr = e;
        take();
        const code = e instanceof LlmError ? e.code : null;
        if (code && TRANSIENT.has(code) && i < retries) { await sleep(backoff(i)); continue; }
        await finish("error", code ?? (e instanceof Error ? e.name : "error"));
        throw e;
      }
    }
    throw lastErr;
  }
}

/** The gateway as a plain `LlmClient` that is not tied to a film (no budget applies). */
export const gatewayClient = (g: ModelGateway): LlmClient => g.forFilm(null);

/** A provider config for the existing Anthropic client. Needs ANTHROPIC_API_KEY at first use, never earlier. */
export function anthropicProvider(make: (model: string, onUsage: (u: TokenUsage) => void) => LlmClient, prices?: Record<string, ModelPrice>): ProviderConfig {
  return { create: make, ...(prices ? { prices } : {}) };
}

/** A scripted provider for tests and demos: answers come from the queue and token usage is reported as given (default 100 in, 50 out per call). */
export function scriptedProvider(client: LlmClient, usage: TokenUsage = { input_tokens: 100, output_tokens: 50 }, prices?: Record<string, ModelPrice>): ProviderConfig {
  return {
    create: (_model, onUsage) => ({
      ...(client.predatesArtDirection !== undefined ? { predatesArtDirection: client.predatesArtDirection } : {}),
      generate: async <T>(req: GenerateRequest<T>) => { const out = await client.generate(req); onUsage(usage); return out; },
    }),
    ...(prices ? { prices } : {}),
  };
}
