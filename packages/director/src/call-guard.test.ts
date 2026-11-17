import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicClient, CallMeter, LlmError, realCalls } from "./index.js";

const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
const toolReply = (input: unknown, usage = { input_tokens: 120, output_tokens: 30 }) => ({ content: [{ type: "tool_use", id: "toolu_1", name: "thing", input }], usage });
const schema = z.object({ n: z.number() });
/** A meter that is allowed `cap` calls and writes to `path`. */
const meter = (cap: string | undefined, path: string, extra: ConstructorParameters<typeof CallMeter>[0] = {}) => new CallMeter({ env: () => (cap === undefined ? {} : { REAL_CALL_CAP: cap }), logPath: () => path, ...extra });
const begin = (m: CallMeter) => { const r = m.begin("x"); if (!r.ok) throw new Error(r.message); return r.n; };

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
    const m = meter("10", path, { now: () => new Date("2026-11-18T10:00:00Z") });
    expect(m.total).toBe(0);
    const a = begin(m), b = begin(m);
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
    const m = meter("10", join(blocker, "sub", "log.jsonl"), { print: (l) => said.push(l) });
    const n = begin(m);
    expect(() => m.end(n, { node: "a", model: "m", input_tokens: 1, output_tokens: 1, outcome: "ok" })).not.toThrow();
    m.end(begin(m), { node: "b", model: "m", input_tokens: 1, output_tokens: 1, outcome: "ok" });
    expect(m.total).toBe(2);
    expect(said.filter((s) => s.includes("could not be written")).length).toBe(1);
  });
});

describe("the hard cap", () => {
  const path = () => join(mkdtempSync(join(tmpdir(), "calllog-")), "log.jsonl");

  it("refuses every real call when REAL_CALL_CAP is unset, empty, 0, negative or not a number", () => {
    for (const cap of [undefined, "", "0", "-3", "abc"]) {
      const m = meter(cap, path());
      const r = m.begin("treatment");
      expect(r.ok, String(cap)).toBe(false);
      expect(r.ok === false && r.message).toContain("REAL_CALL_CAP");
      expect(r.ok === false && r.message).toContain("treatment");
      expect(m.total).toBe(0);
      expect(m.cap).toBe(0);
    }
  });

  it("allows exactly the cap and refuses the next call, without counting it", () => {
    const m = meter("2", path());
    expect(m.begin("a").ok).toBe(true);
    expect(m.begin("b").ok).toBe(true);
    const third = m.begin("c");
    expect(third.ok).toBe(false);
    expect(third.ok === false && third.message).toContain("REAL_CALL_CAP=2");
    expect(third.ok === false && third.message).toContain("2 used");
    expect(m.total).toBe(2);
    expect(m.summary()).toContain("cap 2, 1 refused");
  });

  describe("through the client", () => {
    let dir: string, logFile: string, savedLog: string | undefined, savedCap: string | undefined;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "calllog-")); logFile = join(dir, "call-log.jsonl"); savedLog = process.env["REAL_CALL_LOG"]; savedCap = process.env["REAL_CALL_CAP"]; process.env["REAL_CALL_LOG"] = logFile; realCalls.reset(); });
    afterEach(() => { for (const [k, v] of [["REAL_CALL_LOG", savedLog], ["REAL_CALL_CAP", savedCap]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } realCalls.reset(); });

    it("sends nothing when the cap is not set, and the error names the env var", async () => {
      delete process.env["REAL_CALL_CAP"];
      const { client, calls } = sdkClient([toolReply({ n: 1 })]);
      const err = await client.generate({ name: "thing", system: "s", user: "u", schema }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).code).toBe("llm_budget");
      expect((err as LlmError).message).toContain("REAL_CALL_CAP");
      expect(calls()).toBe(0);
      expect(existsSync(logFile)).toBe(false);
    });

    it("aborts the run at the cap: the call over the cap is never sent and never logged", async () => {
      process.env["REAL_CALL_CAP"] = "1";
      const { client, calls } = sdkClient([toolReply({ n: 1 }), toolReply({ n: 2 })]);
      await client.generate({ name: "thing", system: "s", user: "u", schema });
      const err = await client.generate({ name: "next", system: "s", user: "u", schema }).catch((e: unknown) => e);
      expect((err as LlmError).code).toBe("llm_budget");
      expect((err as LlmError).message).toContain("REAL_CALL_CAP=1");
      expect(calls()).toBe(1);
      expect(lines(logFile).map((l) => l["node"])).toEqual(["thing"]);
    });

    it("counts the repair request toward the cap, so a retry cannot slip past it", async () => {
      process.env["REAL_CALL_CAP"] = "1";
      const { client, calls } = sdkClient([toolReply({ n: "bad" }), toolReply({ n: 2 })]);
      const err = await client.generate({ name: "thing", system: "s", user: "u", schema }).catch((e: unknown) => e);
      expect((err as LlmError).code).toBe("llm_budget");
      expect(calls()).toBe(1);
    });

    it("does not touch a substituted client: tests with a fake SDK still run with the cap off", async () => {
      delete process.env["REAL_CALL_CAP"];
      const client = new AnthropicClient({ apiKey: "test-key" });
      (client as unknown as { client: unknown }).client = { messages: { create: async () => toolReply({ n: 1 }) } };
      await expect(client.generate({ name: "thing", system: "s", user: "u", schema })).resolves.toEqual({ n: 1 });
      expect(realCalls.total).toBe(0);
    });
  });
});

describe("every real request goes through the meter", () => {
  let dir: string, path: string, savedLog: string | undefined, savedCap: string | undefined;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "calllog-")); path = join(dir, "call-log.jsonl"); savedLog = process.env["REAL_CALL_LOG"]; savedCap = process.env["REAL_CALL_CAP"]; process.env["REAL_CALL_LOG"] = path; process.env["REAL_CALL_CAP"] = "10"; realCalls.reset(); });
  afterEach(() => { for (const [k, v] of [["REAL_CALL_LOG", savedLog], ["REAL_CALL_CAP", savedCap]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } realCalls.reset(); });

  it("counts a request and logs its node, model and the tokens the provider reported", async () => {
    const { client } = sdkClient([toolReply({ n: 1 })]);
    await client.generate({ name: "thing", system: "s", user: "u", schema });
    expect(realCalls.total).toBe(1);
    expect(lines(path)).toMatchObject([{ n: 1, node: "thing", model: "test-model", input_tokens: 120, output_tokens: 30, outcome: "ok" }]);
  });

  it("counts the repair request after a schema error as a second call, and a failed request as an error line", async () => {
    const { client, calls } = sdkClient([toolReply({ n: "bad" }), toolReply({ n: 2 })]);
    await client.generate({ name: "thing", system: "s", user: "u", schema });
    expect(calls()).toBe(2);
    expect(realCalls.total).toBe(2);
    const failing = sdkClient([Object.assign(new Error("boom"), { status: 500 })]);
    await expect(failing.client.generate({ name: "other", system: "s", user: "u", schema })).rejects.toThrow();
    expect(lines(path).map((l) => [l["node"], l["outcome"]])).toEqual([["thing", "ok"], ["thing", "ok"], ["other", "error"]]);
    expect(realCalls.total).toBe(3);
  });

  it("does not count a request made through a substituted client, as the existing tests do", async () => {
    const client = new AnthropicClient({ apiKey: "test-key" });
    (client as unknown as { client: unknown }).client = { messages: { create: async () => toolReply({ n: 1 }) } };
    await client.generate({ name: "thing", system: "s", user: "u", schema });
    expect(realCalls.total).toBe(0);
    expect(existsSync(path)).toBe(false);
  });
});
