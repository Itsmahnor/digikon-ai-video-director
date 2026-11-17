import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicClient, LlmError, fixtureMode, promptHash, realCalls } from "./index.js";

const schema = z.object({ n: z.number() });
const toolReply = (input: unknown, id = "toolu_1") => ({ content: [{ type: "tool_use", id, name: "thing", input }], usage: { input_tokens: 200, output_tokens: 40 } });
const ENV = ["LLM_FIXTURE_MODE", "LLM_FIXTURE_DIR", "REAL_CALL_CAP", "REAL_CALL_LOG", "ANTHROPIC_API_KEY"] as const;

/** A real AnthropicClient whose SDK instance answers from a script (record) or must never be asked (replay). */
function sdkClient(replies: unknown[]) {
  const client = new AnthropicClient({ apiKey: "test-key", model: "test-model" });
  let calls = 0;
  (client as unknown as { client: { messages: { create: unknown } } }).client.messages.create = async () => { calls++; if (!replies.length) throw new Error("the API was called"); return replies.shift(); };
  return { client, calls: () => calls };
}

describe("record and replay of model responses", () => {
  let dir: string, saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    dir = mkdtempSync(join(tmpdir(), "fixtures-"));
    process.env["LLM_FIXTURE_DIR"] = dir;
    process.env["REAL_CALL_LOG"] = join(dir, "call-log.jsonl");
    delete process.env["LLM_FIXTURE_MODE"];
    realCalls.reset();
  });
  afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } realCalls.reset(); });

  const record = async (replies: unknown[], req = { name: "thing", system: "sys", user: "the prompt" }) => {
    process.env["LLM_FIXTURE_MODE"] = "record"; process.env["REAL_CALL_CAP"] = "5";
    const { client, calls } = sdkClient(replies);
    const out = await client.generate({ ...req, schema });
    return { out, calls: calls() };
  };
  const replayClient = () => { process.env["LLM_FIXTURE_MODE"] = "replay"; delete process.env["REAL_CALL_CAP"]; return sdkClient([]); };

  it("record mode saves the response under the hash of the request, with the node, model and a hint of the prompt", async () => {
    const { out } = await record([toolReply({ n: 7 })]);
    expect(out).toEqual({ n: 7 });
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "call-log.jsonl");
    expect(files).toHaveLength(1);
    const f = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
    expect(files[0]).toBe(`${f.hash}.json`);
    expect(f).toMatchObject({ format: "digikon.llm-fixture", node: "thing", model: "test-model", prompt: { system_chars: 3, user_chars: 10, user_head: "the prompt" }, response: { usage: { input_tokens: 200, output_tokens: 40 } } });
    expect(f.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(realCalls.total).toBe(1); // recording is a real call: counted and capped
  });

  it("replay mode serves the saved response, calls no API and counts no real call", async () => {
    await record([toolReply({ n: 7 })]);
    realCalls.reset();
    const { client, calls } = replayClient();
    await expect(client.generate({ name: "thing", system: "sys", user: "the prompt", schema })).resolves.toEqual({ n: 7 });
    expect(calls()).toBe(0);
    expect(realCalls.total).toBe(0);
    expect(existsSync(join(dir, "call-log.jsonl"))).toBe(true); // only the line the recording wrote
    expect(readFileSync(join(dir, "call-log.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("replay mode needs no API key and no call cap", async () => {
    await record([toolReply({ n: 1 })]);
    delete process.env["ANTHROPIC_API_KEY"]; delete process.env["REAL_CALL_CAP"]; process.env["LLM_FIXTURE_MODE"] = "replay";
    const client = new AnthropicClient({ model: "test-model" });
    await expect(client.generate({ name: "thing", system: "sys", user: "the prompt", schema })).resolves.toEqual({ n: 1 });
  });

  it("a prompt with no fixture fails loudly and never reaches the API", async () => {
    await record([toolReply({ n: 7 })]);
    realCalls.reset();
    const { client, calls } = replayClient();
    const err = await client.generate({ name: "thing", system: "sys", user: "a DIFFERENT prompt", schema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).message).toContain("no recorded response");
    expect((err as LlmError).message).toContain("LLM_FIXTURE_MODE=record");
    expect(calls()).toBe(0);
    expect(realCalls.total).toBe(0);
  });

  it("an empty fixture folder fails loudly too, even with a real key and a cap set", async () => {
    process.env["LLM_FIXTURE_MODE"] = "replay"; process.env["REAL_CALL_CAP"] = "5"; process.env["ANTHROPIC_API_KEY"] = "sk-real-looking";
    const { client, calls } = sdkClient([toolReply({ n: 1 })]);
    await expect(client.generate({ name: "thing", system: "s", user: "u", schema })).rejects.toThrow(/no recorded response/i);
    expect(calls()).toBe(0);
  });

  it("replays a repair sequence: the bad answer and the corrected one are both served in order", async () => {
    const { out, calls } = await record([toolReply({ n: "bad" }, "toolu_a"), toolReply({ n: 9 }, "toolu_b")]);
    expect([out, calls]).toEqual([{ n: 9 }, 2]);
    expect(readdirSync(dir).filter((f) => f.length === 69 && f.endsWith(".json"))).toHaveLength(2);
    const { client, calls: used } = replayClient();
    await expect(client.generate({ name: "thing", system: "sys", user: "the prompt", schema })).resolves.toEqual({ n: 9 });
    expect(used()).toBe(0);
  });

  it("the hash covers model, system, prompt, tools and limits, and ignores key order", () => {
    const base = { model: "m", max_tokens: 100, system: "s", messages: [{ role: "user", content: "u" }], tools: [{ name: "t", input_schema: { type: "object", properties: { a: {}, b: {} } } }], tool_choice: { type: "auto" } };
    const h = promptHash(base);
    expect(promptHash({ ...base })).toBe(h);
    expect(promptHash({ tool_choice: base.tool_choice, tools: [{ input_schema: { properties: { b: {}, a: {} }, type: "object" }, name: "t" }], messages: base.messages, system: "s", max_tokens: 100, model: "m" })).toBe(h);
    for (const changed of [{ model: "m2" }, { system: "s2" }, { max_tokens: 101 }, { messages: [{ role: "user", content: "u2" }] }, { tool_choice: { type: "any" } }]) expect(promptHash({ ...base, ...changed })).not.toBe(h);
  });

  it("an unknown LLM_FIXTURE_MODE is an error, so a typo cannot fall back to the API", () => {
    expect(fixtureMode({})).toBe("off");
    expect(fixtureMode({ LLM_FIXTURE_MODE: "off" })).toBe("off");
    expect(fixtureMode({ LLM_FIXTURE_MODE: " Replay " })).toBe("replay");
    expect(() => fixtureMode({ LLM_FIXTURE_MODE: "repaly" })).toThrow(/Use "record", "replay"/);
  });
});
