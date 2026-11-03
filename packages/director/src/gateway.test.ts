import { describe, expect, it } from "vitest";
import { z } from "zod";
import { gatewayClient, InMemoryCallLog, ModelGateway, scriptedProvider, DbCallLog, type CallLogEntry, type ProviderConfig } from "./gateway.js";
import { LlmError, ScriptedClient, type GenerateRequest, type LlmClient } from "./llm.js";

const schema = z.object({ ok: z.boolean() });
const req = (name = "treatment"): GenerateRequest<{ ok: boolean }> => ({ name, system: "sys", user: "hello", schema });
const noSleep = async () => {};

describe("ModelGateway", () => {
  it("passes the request and structured output straight through", async () => {
    const inner = new ScriptedClient([{ ok: true }]);
    const g = new ModelGateway({ provider: "demo", model: "m", providers: { demo: scriptedProvider(inner) } });
    expect(await gatewayClient(g).generate(req())).toEqual({ ok: true });
    expect(inner.calls[0]).toMatchObject({ name: "treatment", system: "sys", user: "hello" });
  });
  it("an invalid answer still fails the caller's schema, unchanged", async () => {
    const g = new ModelGateway({ provider: "demo", model: "m", providers: { demo: scriptedProvider(new ScriptedClient([{ nope: 1 }])) } });
    await expect(gatewayClient(g).generate(req())).rejects.toThrow();
  });
  it("selects the provider and model by configuration", async () => {
    const seen: string[] = [];
    const mk = (label: string): ProviderConfig => ({ create: (model) => { seen.push(`${label}:${model}`); return new ScriptedClient([{ ok: true }]); } });
    const g = new ModelGateway({ provider: "b", model: "m2", providers: { a: mk("a"), b: mk("b") } });
    await g.generate(null, req());
    expect(seen).toEqual(["b:m2"]);
    expect(() => new ModelGateway({ provider: "zzz", model: "m", providers: { a: mk("a") } })).toThrow(/no provider "zzz"/);
  });
  it("retries transient failures with backoff and gives up on permanent ones", async () => {
    let n = 0;
    const flaky: LlmClient = { generate: async <T,>(r: GenerateRequest<T>) => { n++; if (n < 3) throw new LlmError("llm_overloaded", "busy"); return r.schema.parse({ ok: true }); } };
    const waits: number[] = [];
    const log = new InMemoryCallLog();
    const g = new ModelGateway({ provider: "p", model: "m", providers: { p: { create: () => flaky } }, retries: 2, sleep: async (ms) => { waits.push(ms); }, backoff_ms: (i) => 10 * (i + 1), log });
    expect(await g.generate("f", req())).toEqual({ ok: true });
    expect(waits).toEqual([10, 20]);
    expect(log.entries[0]).toMatchObject({ attempts: 3, outcome: "ok" });

    let m = 0;
    const bad: LlmClient = { generate: async () => { m++; throw new LlmError("llm_auth", "no"); } };
    const g2 = new ModelGateway({ provider: "p", model: "m", providers: { p: { create: () => bad } }, sleep: noSleep, log });
    await expect(g2.generate("f", req())).rejects.toMatchObject({ code: "llm_auth" });
    expect(m).toBe(1);
    expect(log.entries.at(-1)).toMatchObject({ outcome: "error", error_code: "llm_auth", attempts: 1 });
  });
  it("hard-stops a film at its token budget, per film", async () => {
    const log = new InMemoryCallLog();
    const inner = new ScriptedClient([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    const g = new ModelGateway({ provider: "p", model: "m", providers: { p: scriptedProvider(inner, { input_tokens: 100, output_tokens: 50 }) }, budget: { max_tokens: 250 }, log });
    const a = g.forFilm("A"), b = g.forFilm("B");
    await a.generate(req()); await a.generate(req()); // 300 used, over 250
    await expect(a.generate(req())).rejects.toMatchObject({ code: "llm_budget" });
    await expect(b.generate(req())).resolves.toEqual({ ok: true }); // another film is unaffected
    expect(g.spent("A").tokens).toBe(300);
    expect(inner.calls.length).toBe(3); // the stopped call never reached the model
    expect(log.entries.find((e) => e.outcome === "budget_stop")).toMatchObject({ film_id: "A", attempts: 0 });
  });
  it("hard-stops at a cost budget when prices are configured", async () => {
    const prices = { m: { input_per_mtok: 1000, output_per_mtok: 2000 } }; // 100*1000/1e6 + 50*2000/1e6 = 0.2 per call
    const g = new ModelGateway({ provider: "p", model: "m", providers: { p: scriptedProvider(new ScriptedClient([{ ok: true }, { ok: true }, { ok: true }]), undefined, prices) }, budget: { max_cost_usd: 0.3 } });
    await g.generate("F", req()); await g.generate("F", req());
    expect(g.spent("F").cost_usd).toBeCloseTo(0.4);
    await expect(g.generate("F", req())).rejects.toMatchObject({ code: "llm_budget" });
  });
  it("without a budget, nothing is ever stopped; a call with no film id is never budgeted", async () => {
    const g = new ModelGateway({ provider: "p", model: "m", providers: { p: scriptedProvider(new ScriptedClient([{ ok: true }, { ok: true }])) }, budget: { max_tokens: 1 } });
    await g.generate(null, req()); await g.generate(null, req());
  });
  it("estimates tokens when the provider reports none, so the budget still bites", async () => {
    const quiet: LlmClient = { generate: async <T,>(r: GenerateRequest<T>) => r.schema.parse({ ok: true }) };
    const g = new ModelGateway({ provider: "p", model: "m", providers: { p: { create: () => quiet } }, budget: { max_tokens: 1 } });
    await g.generate("F", req());
    expect(g.spent("F").tokens).toBeGreaterThan(0);
    await expect(g.generate("F", req())).rejects.toMatchObject({ code: "llm_budget" });
  });
  it("DbCallLog writes through the store and survives a store failure", async () => {
    const rows: CallLogEntry[] = [];
    const errors: unknown[] = [];
    const ok = new DbCallLog({ logModelCall: async (r) => { rows.push(r); } });
    const bad = new DbCallLog({ logModelCall: async () => { throw new Error("db down"); } }, (e) => errors.push(e));
    const g = new ModelGateway({ provider: "p", model: "m", providers: { p: scriptedProvider(new ScriptedClient([{ ok: true }, { ok: true }])) }, log: { record: async (e) => { await ok.record(e); await bad.record(e); } } });
    await g.generate("F", req());
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});
