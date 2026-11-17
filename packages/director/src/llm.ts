import Anthropic from "@anthropic-ai/sdk";
import type { ZodType, ZodTypeDef } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { realCalls } from "./call-guard.js";
import { describePrompt, fixtureDir, fixtureMode, noteFixture, promptHash, readFixture, writeFixture } from "./llm-fixtures.js";

/**
 * Extracts loggable diagnostic fields from an Anthropic SDK error object.
 * Returns only metadata (status, error type, sanitised message, request-id).
 * Never touches request headers, the API key, prompts, or user content.
 * Returns null when the value is not a recognisable API error.
 */
export function extractApiDiagnostics(err: unknown): {
  status: number;
  errorType: string | null;
  errorMessage: string | null;
  requestId: string | null;
} | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    status?: unknown;
    // SDK sets this to error.error.type (the inner Anthropic error type, e.g. "invalid_request_error")
    type?: unknown;
    // SDK sets this to the full response body: { type: "error", error: { type: "...", message: "..." } }
    error?: { type?: unknown; error?: { type?: unknown; message?: unknown } };
    requestID?: unknown;
    message?: unknown;
  };
  const status = typeof e.status === "number" ? e.status : null;
  if (status === null) return null;
  // e.type is the SDK-extracted inner type (error.error.type), e.g. "invalid_request_error".
  // Prefer it; fall back to the inner body field for any other error shape.
  const errorType = typeof e.type === "string" ? e.type
    : typeof e.error?.error?.type === "string" ? e.error.error.type
    : null;
  // The actual error description lives at error.error.message, not error.message.
  const errorMessage = typeof e.error?.error?.message === "string" ? e.error.error.message : null;
  // requestID helps Anthropic support trace the exact call
  const requestId = typeof e.requestID === "string" ? e.requestID : null;
  return { status, errorType, errorMessage, requestId };
}

export interface GenerateRequest<T> {
  /** Used as the tool name that forces structured output, e.g. "treatment". */
  name: string;
  system: string;
  user: string;
  schema: ZodType<T, ZodTypeDef, unknown>;
  maxTokens?: number;
}

/** The only model interface the Director uses, so tests and later providers can swap in. */
export interface LlmClient {
  /** True for a scripted or canned client whose answers predate art direction. The Director then treats art direction as optional. A real model never sets it. */
  readonly predatesArtDirection?: boolean;
  generate<T>(req: GenerateRequest<T>): Promise<T>;
}

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export type LlmErrorCode = "llm_budget" | "llm_billing" | "llm_auth" | "llm_rate_limit" | "llm_overloaded" | "llm_network" | "llm_model" | "llm_error";

/** A model failure with a message a person can act on. The raw provider text never reaches the UI, so keys cannot leak through it. */
export class LlmError extends Error {
  constructor(readonly code: LlmErrorCode, message: string) {
    super(message);
    this.name = "LlmError";
  }
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

/** Turns whatever the SDK threw into an LlmError, or null if it is not a provider failure. Works on plain objects so it is easy to test. */
export function classifyLlmError(err: unknown, model = DEFAULT_MODEL): LlmError | null {
  if (err instanceof LlmError) return err;
  if (!err || typeof err !== "object") return null;
  const e = err as { status?: number; name?: string; message?: string; code?: string; cause?: { code?: string } };
  const text = String(e.message ?? "").toLowerCase();
  const status = typeof e.status === "number" ? e.status : undefined;

  if (status === 402 || (status === 400 && text.includes("credit balance"))) {
    return new LlmError("llm_billing", "Your Anthropic account has no credit left. Add credit under Plans & Billing in the Anthropic Console, then try again.");
  }
  if (status === 401 || status === 403) return new LlmError("llm_auth", "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env and restart the console.");
  if (status === 404 && text.includes("model")) return new LlmError("llm_model", `The model "${model}" was not found for this key. Set ANTHROPIC_MODEL in .env to a model your account can use.`);
  if (status === 429) return new LlmError("llm_rate_limit", "Anthropic is rate limiting this key. Wait a minute and try again.");
  if (status === 529 || (status !== undefined && status >= 500)) return new LlmError("llm_overloaded", "Anthropic is overloaded or having problems right now. Try again in a moment.");
  if (e.name === "APIConnectionError" || e.name === "APIConnectionTimeoutError" || NETWORK_CODES.has(String(e.code ?? e.cause?.code ?? ""))) {
    return new LlmError("llm_network", "Could not reach Anthropic. Check your internet connection and try again.");
  }
  if (status !== undefined) return new LlmError("llm_error", `Anthropic rejected the request (error ${status}). Check the server log for details.`);
  return null;
}

export class AnthropicClient implements LlmClient {
  private readonly client: Anthropic;
  /** The SDK client this class built. A test that swaps `client` for a fake is not talking to the API, so its requests are not metered. */
  private readonly sdk: Anthropic;
  readonly model: string;
  private readonly onUsage: ((u: { input_tokens: number; output_tokens: number }) => void) | undefined;

  constructor(opts: { apiKey?: string; model?: string; onUsage?: (u: { input_tokens: number; output_tokens: number }) => void } = {}) {
    this.onUsage = opts.onUsage;
    // Replay never reaches the API, so it needs no key; the placeholder is never sent anywhere.
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? (fixtureMode() === "replay" ? "replay-mode-no-key" : undefined);
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example).");
    this.client = new Anthropic({ apiKey });
    this.sdk = this.client;
    this.model = opts.model ?? (process.env.ANTHROPIC_MODEL || DEFAULT_MODEL);
  }

  /**
   * The one place a request leaves for the API (every constructor of this class, in the console, the CLI, the scripts and the live evals, ends here). Each request is counted and
   * logged by the meter (call-guard.ts), with its structured-output name as the node.
   */
  private async send(node: string, params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    const metered = this.client === this.sdk;
    // Record and replay (llm-fixtures.ts) apply to the real client only, like metering.
    const mode = metered ? fixtureMode() : "off";
    const hash = mode === "off" ? "" : promptHash({ model: params.model, max_tokens: params.max_tokens, system: params.system, messages: params.messages, tools: params.tools, tool_choice: params.tool_choice });
    if (mode === "replay") {
      // Never calls the API, never counts as a real call. A prompt with no fixture is a loud failure, not a quiet request.
      const hit = readFixture(fixtureDir(), hash);
      if (!hit) throw new LlmError("llm_error", `Replay mode has no recorded response for this prompt (node ${node}, hash ${hash.slice(0, 12)}). Nothing was sent to Anthropic. Record it once with LLM_FIXTURE_MODE=record and REAL_CALL_CAP set, or change the prompt back.`);
      noteFixture("replayed");
      return hit.response as unknown as Anthropic.Message;
    }
    const turn = metered ? realCalls.begin(node) : null;
    // Over the cap, or the cap is off: nothing is sent. The message names the env var to set.
    if (turn && !turn.ok) throw new LlmError("llm_budget", turn.message);
    const n = turn && turn.ok ? turn.n : 0;
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create(params);
      if (metered) realCalls.end(n, { node, model: this.model, input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0, outcome: "ok" });
    } catch (e) {
      if (metered) realCalls.end(n, { node, model: this.model, input_tokens: 0, output_tokens: 0, outcome: "error" });
      // Log Anthropic's original error metadata so failures can be diagnosed from the server log.
      // Only status, error type, message, and request-id are logged — never headers or secrets.
      const diag = extractApiDiagnostics(e);
      if (diag) {
        const parts = [`[llm] HTTP ${diag.status}`];
        if (diag.errorType) parts.push(`type=${diag.errorType}`);
        if (diag.errorMessage) parts.push(`message="${diag.errorMessage}"`);
        if (diag.requestId) parts.push(`request-id=${diag.requestId}`);
        console.error(parts.join(" "));
      }
      throw classifyLlmError(e, this.model) ?? e;
    }
    // After the call has been counted and has succeeded: a problem saving the fixture is reported as itself, never as an API failure.
    if (mode === "record") {
      writeFixture(fixtureDir(), { format: "digikon.llm-fixture", hash, node, model: this.model, recorded_at: new Date().toISOString(), prompt: describePrompt(params.system, params.messages), response: { content: res.content as unknown[], ...(res.usage ? { usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } } : {}) } });
      noteFixture("recorded");
    }
    return res;
  }

  /** Forces a tool call so the reply is JSON, validates it with zod, and gives the model one chance to correct itself. */
  async generate<T>(req: GenerateRequest<T>): Promise<T> {
    const { $schema: _omit, ...inputSchema } = zodToJsonSchema(req.schema, { $refStrategy: "none", target: "jsonSchema7" }) as Record<string, unknown>;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.user }];
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.send(req.name, {
        model: this.model,
        max_tokens: req.maxTokens ?? 8000,
        system: req.system,
        messages,
        tools: [{ name: req.name, description: `Return the ${req.name} as structured data.`, input_schema: inputSchema as Anthropic.Tool.InputSchema }],
        tool_choice: { type: "auto" },
      });
      if (this.onUsage && res.usage) this.onUsage({ input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens });
      const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!block) { lastError = "no structured output returned"; continue; }
      const parsed = req.schema.safeParse(block.input);
      if (parsed.success) return parsed.data;
      lastError = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      messages.push({ role: "assistant", content: res.content });
      messages.push({
        role: "user",
        // Every tool_use block in the reply needs its own tool_result, or the API refuses the next request (HTTP 400). The model may return more than one.
        content: res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use").map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, is_error: true, content: b.id === block.id ? `Schema errors: ${lastError}. Return a corrected ${req.name}.` : `Not used: return exactly one ${req.name} call.` })),
      });
    }
    throw new Error(`Model output failed schema validation for ${req.name}: ${lastError}`);
  }
}

/** Test double: returns queued answers in order and records every call. Each answer is checked against the real schema. */
export class ScriptedClient implements LlmClient {
  readonly predatesArtDirection = true;
  readonly calls: { name: string; system: string; user: string }[] = [];
  constructor(private readonly answers: Array<unknown | ((req: GenerateRequest<unknown>) => unknown)>) {}

  async generate<T>(req: GenerateRequest<T>): Promise<T> {
    this.calls.push({ name: req.name, system: req.system, user: req.user });
    if (this.answers.length === 0) throw new Error(`ScriptedClient: no answer left for ${req.name}`);
    const next = this.answers.shift()!;
    const value = typeof next === "function" ? (next as (r: GenerateRequest<unknown>) => unknown)(req as GenerateRequest<unknown>) : next;
    return req.schema.parse(value);
  }
}
