import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DemoClient, SkillLibrary } from "@digikon/director";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import { createApp, type AppContext } from "./app.js";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const recipes = loadRecipes(join(repo, "recipes"));
const PAGE = `<!doctype html><html><head><title>Acme Roasters</title><meta name="description" content="Small-batch coffee roasted weekly in Leeds. Orders ship within two days of roasting.">
<style>a{color:#c8501e} .b{background:#0a7a5a;font-family:"Fraunces",serif}</style></head><body><img src="/logo.svg" alt="Acme logo"><h1>Coffee that tastes like this week</h1>
<p>We roast every Monday in small batches, so what reaches you is never more than a few days old.</p><p>Orders ship within two days of roasting, and every bag shows its roast date on the label.</p>
<p>${"More about our roastery and the people who run it. ".repeat(8)}</p></body></html>`;
const JS_ONLY = `<html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>`;

let dir: string, server: http.Server, host: string, base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kit-test-"));
  server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(req.url === "/js" ? JS_ONLY : PAGE); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`; base = `http://${host}`;
});
afterAll(async () => { rmSync(dir, { recursive: true, force: true }); await new Promise<void>((r) => server.close(() => r())); });

const build = (over: Partial<AppContext> = {}) => createApp({
  llm: new DemoClient(), demo: true, speech: { model: "stub", transcribe: async () => { throw new Error("unused"); } } as never, whisper: () => ({ state: "ready" }), skills: new SkillLibrary(join(repo, "skills")),
  retriever: new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge"))]), recipes: new RecipeLibrary(recipes, "draft"), ffmpegOk: true, storageDir: dir, publicDir: join(repo, "apps/console/public"), ...over,
});
const withFixture = () => build({ websiteOptions: { allowHosts: [host] } });
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const newSession = async (app: ReturnType<typeof build>) => ((await (await app.request("/api/sessions", { method: "POST" })).json()) as { id: string }).id;
const j = async (res: Response) => (await res.json()) as any;
const field = (app: ReturnType<typeof build>, id: string, f: string, action: string, value?: unknown) => app.request(`/api/sessions/${id}/kit/field`, post({ field: f, action, value }));

describe("website step: extracted values are candidates until the user confirms them", () => {
  it("reads a page, keeps the typed address as the user's answer, and applies nothing it found", async () => {
    const app = withFixture(), id = await newSession(app);
    const res = await app.request(`/api/sessions/${id}/website`, post({ url: base + "/" }));
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.status).toBe("ok");
    expect(body.extraction.colours.map((c: any) => c.hex)).toContain("#c8501e");
    expect(body.extraction.fonts).toContain("Fraunces");
    expect(body.extraction.facts.length).toBeGreaterThan(0);
    const kit = await j(await app.request(`/api/sessions/${id}/kit`));
    expect(kit.kit.website).toMatchObject({ state: "provided", source: "user" });
    for (const f of ["colours", "fonts"]) expect(kit.kit.brand[f].state, f).toBe("missing"); // not applied
    expect(kit.kit.facts.state).toBe("missing");
    expect(kit.approved_fact_count).toBe(0);
    expect(kit.pending_extractions[0].source).toBe("website");
  });
  it("only what the user confirms reaches the kit; confirmed facts become approved, unconfirmed ones never do", async () => {
    const app = withFixture(), id = await newSession(app);
    const ex = (await j(await app.request(`/api/sessions/${id}/website`, post({ url: base + "/" })))).extraction;
    const res = await app.request(`/api/sessions/${id}/kit/confirm`, post({ source: "website", colours: ["#c8501e"], fonts: ["Fraunces"], fact_ids: [ex.facts[0].id] }));
    const k = await j(res);
    expect(k.kit.brand.colours).toMatchObject({ state: "provided", value: ["#c8501e"], source: "website", confirmed: true });
    expect(k.kit.brand.fonts.value).toEqual(["Fraunces"]);
    expect(k.kit.facts.value).toHaveLength(1);
    expect(k.kit.facts.value[0]).toMatchObject({ origin: "website", confirmed: true, text: ex.facts[0].text });
    expect(k.approved_fact_count).toBe(1);
    expect(k.kit.brand.colours.value).not.toContain("#0a7a5a"); // found but not chosen
  });
  it("the Director run uses confirmed website facts and never the unconfirmed ones", async () => {
    const app = withFixture(), id = await newSession(app);
    await app.request(`/api/sessions/${id}/route`, post({ text: "A 12 second Instagram ad for my coffee roaster." }));
    const ex = (await j(await app.request(`/api/sessions/${id}/website`, post({ url: base + "/" })))).extraction;
    await app.request(`/api/sessions/${id}/kit/confirm`, post({ source: "website", fact_ids: [ex.facts[0].id] }));
    const sse = await (await app.request(`/api/sessions/${id}/direct`, post({ facts: [] }))).text();
    const state = JSON.parse(/event: state\ndata: (.*)/.exec(sse)![1]!);
    const prompt = JSON.stringify(state);
    expect(state.citations).toContain("F01"); // the confirmed fact was shown to the Director
    expect(state.citations).not.toContain("F02"); // the other candidates were not
    expect(prompt).not.toContain(ex.facts[1].text);
  });
  it("refuses to confirm something that was never extracted, or when nothing was extracted", async () => {
    const app = withFixture(), id = await newSession(app);
    expect((await app.request(`/api/sessions/${id}/kit/confirm`, post({ source: "website", colours: ["#112233"] }))).status).toBe(409);
    await app.request(`/api/sessions/${id}/website`, post({ url: base + "/" }));
    for (const body of [{ colours: ["#112233"] }, { fonts: ["Comic Sans"] }, { fact_ids: ["w99"] }]) expect((await app.request(`/api/sessions/${id}/kit/confirm`, post({ source: "website", ...body }))).status).toBe(422);
    const kit = await j(await app.request(`/api/sessions/${id}/kit`));
    expect(kit.kit.brand.colours.state).toBe("missing");
  });
  it("a page that cannot be read leaves the kit alone and asks the user instead", async () => {
    const app = withFixture(), id = await newSession(app);
    const res = await app.request(`/api/sessions/${id}/website`, post({ url: base + "/js" }));
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body).toMatchObject({ status: "could_not_read", reason: "no_content" });
    expect(body.ask).toContain("Type the colours, fonts and facts in yourself, or skip this step");
    expect((await j(await app.request(`/api/sessions/${id}/kit`))).kit.website.state).toBe("missing");
  });
  it("a private or local address is refused at the route (no fixture exemption in the real console)", async () => {
    const app = build(), id = await newSession(app); // no websiteOptions: this is how the console runs
    for (const url of [base + "/", "http://localhost/", "http://169.254.169.254/", "http://[::1]/", "file:///etc/passwd"]) {
      const body = await j(await app.request(`/api/sessions/${id}/website`, post({ url })));
      expect(body.status, url).toBe("could_not_read");
      expect(["blocked", "invalid_url"], url).toContain(body.reason);
    }
    expect((await j(await app.request(`/api/sessions/${id}/kit`))).kit.website.state).toBe("missing");
    expect((await app.request(`/api/sessions/${id}/website`, post({}))).status).toBe(400);
  });
});

describe("kit routes", () => {
  it("provide, skip and clear fields; a required field cannot be skipped; bad values are refused", async () => {
    const app = build(), id = await newSession(app);
    expect((await field(app, id, "goal", "skip")).status).toBe(422);
    let k = await j(await field(app, id, "goal", "provide", "Get trial sign-ups"));
    expect(k.kit.goal).toMatchObject({ state: "provided", value: "Get trial sign-ups", source: "user", confirmed: true });
    k = await j(await field(app, id, "website", "skip"));
    expect(k.kit.website.state).toBe("skipped");
    expect(k.completeness.items.find((i: any) => i.field === "website").satisfied).toBe(true);
    k = await j(await field(app, id, "website", "unset"));
    expect(k.kit.website.state).toBe("missing");
    expect((await field(app, id, "brand.colours", "provide", ["red"])).status).toBe(422);
    expect((await field(app, id, "goal", "provide", "   ")).status).toBe(422);
    expect((await field(app, id, "assets", "provide", ["asset_deadbeef"])).status).toBe(422);
    expect((await app.request(`/api/sessions/${id}/kit/field`, post({ field: "nope", action: "skip" }))).status).toBe(400);
    expect(k.completeness.ready).toBe(false);
  });
  it("facts typed by the user are approved; the kit is saved to the session folder after every change", async () => {
    const app = build(), id = await newSession(app);
    const k = await j(await field(app, id, "facts", "provide", ["Beans are roasted weekly.", "Ships within two days."]));
    expect(k.approved_fact_count).toBe(2);
    const saved = JSON.parse(readFileSync(join(dir, "sessions", id, "kit.json"), "utf8"));
    expect(saved.facts.value).toHaveLength(2);
    expect(saved.kit_id).toBe(`kit_${id}`);
  });
  it("the video category is set on the kit and validated", async () => {
    const app = build(), id = await newSession(app);
    expect((await j(await app.request(`/api/sessions/${id}/kit/category`, post({ video_category: "saas" })))).kit.video_category).toBe("saas");
    expect((await j(await app.request(`/api/sessions/${id}/kit/category`, post({ video_category: null })))).kit.video_category).toBeNull();
    expect((await app.request(`/api/sessions/${id}/kit/category`, post({ video_category: "gaming" }))).status).toBe(400);
  });
  it("a returning user can save a brand and start a new project from it", async () => {
    const app = build(), a = await newSession(app);
    await field(app, a, "brand.colours", "provide", ["#c8501e", "#0a7a5a"]);
    await field(app, a, "brand.tone", "provide", "warm and direct");
    await field(app, a, "facts", "provide", ["Beans are roasted weekly."]);
    const saved = await j(await app.request(`/api/sessions/${a}/kit/save-brand`, post({ name: "Acme Roasters" })));
    expect(saved.brand_id).toMatch(/^brand_[a-f0-9]{12}$/);
    expect(saved.kit.brand_id).toBe(saved.brand_id);
    expect((await j(await app.request("/api/brand-kits"))).brands.map((b: any) => b.name)).toContain("Acme Roasters");
    const b = await newSession(app);
    const loaded = await j(await app.request(`/api/sessions/${b}/kit/load-brand`, post({ brand_id: saved.brand_id })));
    expect(loaded.kit.brand.colours.value).toEqual(["#c8501e", "#0a7a5a"]);
    expect(loaded.kit.brand.tone.value).toBe("warm and direct");
    expect(loaded.kit.brand_id).toBe(saved.brand_id);
    expect(loaded.approved_fact_count).toBe(1);
    expect(loaded.kit.goal.state).toBe("missing"); // project-specific answers are not carried over
    expect((await app.request(`/api/sessions/${b}/kit/load-brand`, post({ brand_id: "brand_000000000000" }))).status).toBe(404);
    expect(existsSync(join(dir, "brand-kits", `${saved.brand_id}.json`))).toBe(true);
  });
});
