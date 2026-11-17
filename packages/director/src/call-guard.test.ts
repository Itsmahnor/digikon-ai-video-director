import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicClient, CallMeter, realCalls } from "./index.js";

const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
const toolReply = (input: unknown, usage = { input_tokens: 120, output_tokens: 30 }) => ({ content: [{ type: "tool_use", id: "toolu_1", name: "thing", input }], usage });

/** A real AnthropicClient whose SDK instance answers from a script instead of the network: the metered path with no API. */
function sdkClient(replies: unknown[]) {
  const client = new AnthropicClient({ apiKey: "test-key", model: "test-model" });
  let calls = 0;
  const sdk = (client as unknown as { client: { messages: { create: unknown } } }).client;
  sdk.messages.create = async () => { calls++; const r = replies.shift(); if (r instanceof Error) throw r; return r; };
  return { client, calls: () => calls };
}

describe("the call counter and log", () => {
  it("counts each request and appends one line per request with time, node, model and tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "calllog-"));
    const path = join(dir, "nested", "call-log.jsonl");
    const m = new CallMeter({ logPath: () => path, now: () => new Date("2026-11-18T10:00:00Z") });
    expect(m.total).toBe(0);
    const a = m.begin(), b = m.begin();
    expect([a, b, m.total]).toEqual([1, 2, 2]);
    m.end(a, { node: "treatment", model: "m1", input_tokens: 10, output_tokens: 5, outcome: "ok" });
    m.end(b, { node: "storyboard", model: "m1", input_tokens: 0, output_tokens: 0, outcome: "error" });
    expect(lines(path)).toEqual([
      { ts: "2026-11-18T10:00:00.000Z", n: 1, node: "treatment", model: "m1", input_tokens: 10, output_tokens: 5, outcome: "ok" },
      { ts: "2026-11-18T10:00:00.000Z", n: 2, node: "storyboard", model: "m1", input_tokens: 0, output_tokens: 0, outcome: "error" },
    ]);
    expect(m.summary()).toContain("Real model calls this run: 2");
  });

  it("never fails a call because the log cannot be written, and says so once", () => {
    const dir = mkdtempSync(join(tmpdir(), "calllog-"));
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    const said: string[] = [];
    const m = new CallMeter({ logPath: () => join(blocker, "sub", "log.jsonl"), print: (l) => said.push(l) });
    const n = m.begin();
    expect(() => m.end(n, { node: "a", model: "m", input_tokens: 1, output_tokens: 1, outcome: "ok" })).not.toThrow();
    m.end(m.begin(), { node: "b", model: "m", input_tokens: 1, output_tokens: 1, outcome: "ok" });
    expect(m.total).toBe(2);
    expect(said.filter((s) => s.includes("could not be written")).length).toBe(1);
  });
});

describe("every real request goes through the meter", () => {
  let dir: string, path: string, saved: string | undefined;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "calllog-")); path = join(dir, "call-log.jsonl"); saved = process.env["REAL_CALL_LOG"]; process.env["REAL_CALL_LOG"] = path; realCalls.reset(); });
  afterEach(() => { if (saved === undefined) delete process.env["REAL_CALL_LOG"]; else process.env["REAL_CALL_LOG"] = saved; realCalls.reset(); });

  it("counts a request and logs its node, model and the tokens the provider reported", async () => {
    const { client } = sdkClient([toolReply({ n: 1 })]);
    await client.generate({ name: "thing", system: "s", user: "u", schema: z.object({ n: z.number() }) });
    expect(realCalls.total).toBe(1);
    expect(lines(path)).toMatchObject([{ n: 1, node: "thing", model: "test-model", input_tokens: 120, output_tokens: 30, outcome: "ok" }]);
  });

  it("counts the repair request after a schema error as a second call, and a failed request as an error line", async () => {
    const { client, calls } = sdkClient([toolReply({ n: "bad" }), toolReply({ n: 2 })]);
    await client.generate({ name: "thing", system: "s", user: "u", schema: z.object({ n: z.number() }) });
    expect(calls()).toBe(2);
    expect(realCalls.total).toBe(2);
    const failing = sdkClient([Object.assign(new Error("boom"), { status: 500 })]);
    await expect(failing.client.generate({ name: "other", system: "s", user: "u", schema: z.object({ n: z.number() }) })).rejects.toThrow();
    expect(lines(path).map((l) => [l["node"], l["outcome"]])).toEqual([["thing", "ok"], ["thing", "ok"], ["other", "error"]]);
    expect(realCalls.total).toBe(3);
  });

  it("does not count a request made through a substituted client, as the existing tests do", async () => {
    const client = new AnthropicClient({ apiKey: "test-key" });
    (client as unknown as { client: unknown }).client = { messages: { create: async () => toolReply({ n: 1 }) } };
    await client.generate({ name: "thing", system: "s", user: "u", schema: z.object({ n: z.number() }) });
    expect(realCalls.total).toBe(0);
    expect(existsSync(path)).toBe(false);
  });
});
