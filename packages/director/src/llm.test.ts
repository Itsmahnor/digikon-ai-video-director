import { describe, expect, it } from "vitest";
import { AnthropicClient, LlmError, classifyLlmError, extractApiDiagnostics } from "./index.js";

const cases: [string, unknown, string | null][] = [
  ["billing (400 with credit text)", { status: 400, message: '400 {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}' }, "llm_billing"],
  ["billing (402)", { status: 402, message: "payment required" }, "llm_billing"],
  ["bad key", { status: 401, message: "invalid x-api-key" }, "llm_auth"],
  ["forbidden", { status: 403, message: "forbidden" }, "llm_auth"],
  ["unknown model", { status: 404, message: "model: claude-nope not found" }, "llm_model"],
  ["rate limit", { status: 429, message: "slow down" }, "llm_rate_limit"],
  ["overloaded", { status: 529, message: "overloaded" }, "llm_overloaded"],
  ["server error", { status: 503, message: "unavailable" }, "llm_overloaded"],
  ["connection error", { name: "APIConnectionError", message: "Connection error." }, "llm_network"],
  ["dns failure", { code: "ENOTFOUND", message: "getaddrinfo" }, "llm_network"],
  ["other 4xx", { status: 422, message: "bad schema" }, "llm_error"],
  ["a plain bug", new Error("x is undefined"), null],
  ["not an error", "oops", null],
];

describe("classifyLlmError", () => {
  it.each(cases)("%s", (_name, err, code) => {
    expect(classifyLlmError(err)?.code ?? null).toBe(code);
  });
  it("never repeats provider text, so a key in the message cannot leak", () => {
    const e = classifyLlmError({ status: 401, message: "bad key sk-ant-usr-SECRET123" })!;
    expect(e.message).not.toContain("SECRET123");
    expect(e.message).not.toContain("sk-ant");
  });
  it("keeps an existing LlmError as is", () => {
    const original = new LlmError("llm_billing", "m");
    expect(classifyLlmError(original)).toBe(original);
  });
  it("names the configured model when it is not found", () => {
    expect(classifyLlmError({ status: 404, message: "model not found" }, "claude-x")!.message).toContain("claude-x");
  });
});

describe("extractApiDiagnostics", () => {
  it("returns null for non-objects", () => {
    expect(extractApiDiagnostics(null)).toBeNull();
    expect(extractApiDiagnostics("oops")).toBeNull();
    expect(extractApiDiagnostics(42)).toBeNull();
  });

  it("returns null when status is missing", () => {
    expect(extractApiDiagnostics({ name: "APIConnectionError" })).toBeNull();
  });

  it("extracts errorType from e.type (SDK-extracted) and errorMessage from e.error.error.message", () => {
    // This mirrors the real Anthropic SDK shape:
    //   e.type  = error.error.type  (SDK extracts this for convenience)
    //   e.error = full response body: { type: "error", error: { type: "...", message: "..." } }
    const err = {
      status: 400,
      type: "invalid_request_error",           // SDK-extracted inner type
      error: {
        type: "error",                          // outer envelope — should NOT be used
        error: { type: "invalid_request_error", message: "max_tokens: field required" },
      },
      requestID: "req_01XYZ",
    };
    expect(extractApiDiagnostics(err)).toEqual({
      status: 400,
      errorType: "invalid_request_error",
      errorMessage: "max_tokens: field required",
      requestId: "req_01XYZ",
    });
  });

  it("does not use the outer envelope type (e.error.type === 'error')", () => {
    // Before the fix, e.error.type was checked first and produced type="error" in the log.
    const err = {
      status: 400,
      type: "invalid_request_error",
      error: { type: "error", error: { type: "invalid_request_error", message: "some detail" } },
    };
    const d = extractApiDiagnostics(err)!;
    expect(d.errorType).toBe("invalid_request_error");
    expect(d.errorType).not.toBe("error");
  });

  it("falls back to e.error.error.type when top-level type is absent", () => {
    const err = {
      status: 400,
      error: { type: "error", error: { type: "invalid_request_error", message: "bad param" } },
    };
    const d = extractApiDiagnostics(err)!;
    expect(d.errorType).toBe("invalid_request_error");
    expect(d.errorMessage).toBe("bad param");
  });

  it("uses e.type alone when error body is missing (non-400 errors)", () => {
    const err = { status: 429, type: "rate_limit_error" };
    const d = extractApiDiagnostics(err)!;
    expect(d.errorType).toBe("rate_limit_error");
    expect(d.errorMessage).toBeNull();
    expect(d.requestId).toBeNull();
  });

  it("returns nulls for optional fields when they are absent", () => {
    const d = extractApiDiagnostics({ status: 503 })!;
    expect(d.status).toBe(503);
    expect(d.errorType).toBeNull();
    expect(d.errorMessage).toBeNull();
    expect(d.requestId).toBeNull();
  });

  it("does not expose the API key or any header value", () => {
    // Simulate an error object that has headers attached (as the real SDK does).
    // extractApiDiagnostics must never read or return header content.
    const err = {
      status: 401,
      type: "authentication_error",
      error: { type: "error", error: { type: "authentication_error", message: "invalid api key" } },
      headers: new Map([["x-api-key", "sk-ant-SECRET"]]),
      requestID: "req_02ABC",
    };
    const d = extractApiDiagnostics(err)!;
    expect(JSON.stringify(d)).not.toContain("SECRET");
    expect(JSON.stringify(d)).not.toContain("sk-ant");
    expect(JSON.stringify(d)).not.toContain("x-api-key");
  });
});

describe("AnthropicClient retry after a schema error", () => {
  it("answers every tool_use block of the reply with a tool_result, so the API accepts the retry", async () => {
    const { z } = await import("zod");
    const client = new AnthropicClient({ apiKey: "test-key" });
    const seen: unknown[][] = [];
    const replies = [
      { content: [{ type: "tool_use", id: "toolu_a", name: "thing", input: { n: "bad" } }, { type: "tool_use", id: "toolu_b", name: "thing", input: { n: 2 } }] },
      { content: [{ type: "tool_use", id: "toolu_c", name: "thing", input: { n: 3 } }] },
    ];
    (client as unknown as { client: unknown }).client = { messages: { create: async (r: { messages: unknown[] }) => { seen.push(structuredClone(r.messages)); return replies.shift(); } } };
    const out = await client.generate({ name: "thing", system: "s", user: "u", schema: z.object({ n: z.number() }) });
    expect(out).toEqual({ n: 3 });
    const results = (seen[1]!.at(-1) as { content: { tool_use_id: string; type: string }[] }).content;
    expect(results.map((r) => [r.type, r.tool_use_id])).toEqual([["tool_result", "toolu_a"], ["tool_result", "toolu_b"]]);
  });
});