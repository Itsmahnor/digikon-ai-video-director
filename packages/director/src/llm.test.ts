import { describe, expect, it } from "vitest";
import { LlmError, classifyLlmError, extractApiDiagnostics } from "./index.js";

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

  it("extracts status, errorType and errorMessage from a full SDK-style error", () => {
    const err = {
      status: 400,
      error: { type: "invalid_request_error", message: "max_tokens: field required" },
      requestID: "req_01XYZ",
    };
    expect(extractApiDiagnostics(err)).toEqual({
      status: 400,
      errorType: "invalid_request_error",
      errorMessage: "max_tokens: field required",
      requestId: "req_01XYZ",
    });
  });

  it("falls back to top-level type when error.type is absent", () => {
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
      error: { type: "authentication_error", message: "invalid api key" },
      headers: new Map([["x-api-key", "sk-ant-SECRET"]]),
      requestID: "req_02ABC",
    };
    const d = extractApiDiagnostics(err)!;
    expect(JSON.stringify(d)).not.toContain("SECRET");
    expect(JSON.stringify(d)).not.toContain("sk-ant");
    expect(JSON.stringify(d)).not.toContain("x-api-key");
  });
});
