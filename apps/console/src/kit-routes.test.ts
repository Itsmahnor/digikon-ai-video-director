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
    // the guided setup is in use, so the three required answers are needed before the Director plans
    await app.request(`/api/sessions/${id}/kit/answers`, post({ answers: [{ question_id: "q_goal", action: "answer", value: "Drive first orders" }, { question_id: "q_audience", action: "answer", value: "Home coffee drinkers" }, { question_id: "q_platform", action: "answer", value: "Instagram Reels" }] }));
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

/** A one-page PDF with text, an RGB colour and a brand font, for the guideline route. */
const guidePdf = (text = "Our brand voice is warm, direct and never loud. We write the way we talk to a neighbour, in plain words and short sentences.") => Buffer.from(`%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n10 0 obj\n<< /Type /Font /BaseFont /ABCDEF+Fraunces-Bold >>\nendobj\n4 0 obj\n<< /Length 200 >>\nstream\n0.784 0.314 0.118 rg 0 0 50 50 re f\nBT /F1 12 Tf 72 700 Td (${text}) Tj ET\nendstream\nendobj\n%%EOF\n`, "latin1");
const upload = (name: string, bytes: Buffer | Uint8Array, type = "application/pdf") => { const fd = new FormData(); fd.append("file", new File([bytes as BlobPart], name, { type })); return { method: "POST", body: fd }; };

describe("brand guideline step", () => {
  it("reads a PDF, offers what it found, and applies nothing until the user confirms", async () => {
    const app = build(), id = await newSession(app);
    const res = await app.request(`/api/sessions/${id}/guideline`, upload("brand.pdf", guidePdf()));
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.status).toBe("ok");
    expect(body.extraction.colours.map((c: any) => c.hex)).toContain("#c8501e");
    expect(body.extraction.fonts).toContain("Fraunces");
    const kit = await j(await app.request(`/api/sessions/${id}/kit`));
    expect(kit.kit.guideline).toMatchObject({ state: "provided", source: "upload" });
    expect(kit.kit.brand.colours.state).toBe("missing");
    expect(kit.approved_fact_count).toBe(0);
    const k = await j(await app.request(`/api/sessions/${id}/kit/confirm`, post({ source: "guideline", colours: ["#c8501e"], fact_ids: [body.extraction.facts[0].id] })));
    expect(k.kit.brand.colours).toMatchObject({ value: ["#c8501e"], source: "guideline", confirmed: true });
    expect(k.kit.facts.value[0]).toMatchObject({ origin: "guideline", confirmed: true });
    expect(k.approved_fact_count).toBe(1);
  });
  it("a PDF that cannot be read is kept and the user is asked to type the details in", async () => {
    const app = build(), id = await newSession(app);
    const scanned = Buffer.from("%PDF-1.4\n3 0 obj\n<< /Type /Page >>\nendobj\n4 0 obj\n<< /Length 30 >>\nstream\nq 600 0 0 800 0 0 cm /Im1 Do Q\nendstream\nendobj\n%%EOF\n", "latin1");
    const res = await app.request(`/api/sessions/${id}/guideline`, upload("scan.pdf", scanned));
    expect(res.status).toBe(200);
    expect(await j(res)).toMatchObject({ status: "could_not_read", reason: "no_text" });
    const kit = await j(await app.request(`/api/sessions/${id}/kit`));
    expect(kit.kit.guideline.state).toBe("provided"); // the file itself was provided
    expect(kit.pending_extractions).toEqual([]);
    expect(kit.kit.brand.colours.state).toBe("missing");
    const enc = await j(await app.request(`/api/sessions/${id}/guideline`, upload("locked.pdf", Buffer.from("%PDF-1.5\n<< /Encrypt 9 0 R >>\n%%EOF\n", "latin1"))));
    expect(enc).toMatchObject({ status: "could_not_read", reason: "encrypted" });
    expect(enc.ask).toContain("Type the colours, fonts and tone in yourself, or skip this step");
  });
  it("the wrong type of file is refused: another extension, or a picture named .pdf", async () => {
    const app = build(), id = await newSession(app);
    const png = Buffer.from("\x89PNG\r\n\x1a\n" + "x".repeat(500), "latin1");
    for (const [name, bytes] of [["logo.png", png], ["brand.docx", Buffer.from("PK\x03\x04docx")], ["notes.txt", Buffer.from("just text")], ["fake.pdf", png]] as [string, Buffer][]) {
      const res = await app.request(`/api/sessions/${id}/guideline`, upload(name, bytes));
      expect(res.status, name).toBe(422);
      expect((await j(res)).error, name).toBe("wrong_file_type");
    }
    expect((await j(await app.request(`/api/sessions/${id}/kit`))).kit.guideline.state).toBe("missing"); // nothing was stored
  });
  it("an oversized file is refused with 413 and nothing is read", async () => {
    const app = build(), id = await newSession(app);
    const huge = Buffer.alloc(21 * 1024 * 1024, 0x20); huge.write("%PDF-1.4\n");
    const res = await app.request(`/api/sessions/${id}/guideline`, upload("huge.pdf", huge));
    expect(res.status).toBe(413);
    expect((await j(res)).error).toBe("file_too_large");
    expect((await app.request(`/api/sessions/${id}/guideline`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
  });
});

describe("typed questions (C6)", () => {
  const answers = (app: ReturnType<typeof build>, id: string, list: unknown[]) => app.request(`/api/sessions/${id}/kit/answers`, post({ answers: list }));
  const stateOf = async (res: Response) => JSON.parse(/event: state\ndata: (.*)/.exec(await res.text())![1]!);

  it("asks the required questions first, typed, and only what is missing", async () => {
    const app = build(), id = await newSession(app);
    let q = await j(await app.request(`/api/sessions/${id}/kit/questions`));
    expect(q.ready).toBe(false);
    expect(q.questions.slice(0, 3).map((x: any) => [x.id, x.kind, x.skippable])).toEqual([["q_goal", "text", false], ["q_audience", "text", false], ["q_platform", "choice", false]]);
    const r = await j(await answers(app, id, [{ question_id: "q_goal", action: "answer", value: "Get sign-ups" }, { question_id: "q_brand_logo", action: "skip" }]));
    expect(r.questions.map((x: any) => x.id)).not.toContain("q_goal");
    expect(r.questions.map((x: any) => x.id)).not.toContain("q_brand_logo");
    q = await j(await app.request(`/api/sessions/${id}/kit/questions`));
    expect(q.questions[0].id).toBe("q_audience");
  });
  it("answers are all-or-nothing, and a required question cannot be skipped", async () => {
    const app = build(), id = await newSession(app);
    const res = await answers(app, id, [{ question_id: "q_goal", action: "answer", value: "Fine" }, { question_id: "q_audience", action: "skip" }]);
    expect(res.status).toBe(422);
    expect((await j(res)).error).toBe("answer_refused");
    expect((await j(await app.request(`/api/sessions/${id}/kit`))).kit.goal.state).toBe("missing"); // the first answer was not kept
    for (const bad of [{ question_id: "q_nope", action: "answer", value: "x" }, { question_id: "q_goal", action: "answer", value: " " }, { question_id: "q_brand_colours", action: "answer", value: "red" }, { question_id: "q_brand_logo", action: "answer", value: ["asset_deadbeef"] }]) expect((await answers(app, id, [bad])).status, JSON.stringify(bad)).toBe(422);
    expect((await app.request(`/api/sessions/${id}/kit/answers`, post({ answers: [] }))).status).toBe(400);
  });
  it("the Director run asks the open required questions, typed, then goes on to Gate 1 once they are answered", async () => {
    const app = build(), id = await newSession(app);
    await app.request(`/api/sessions/${id}/route`, post({ text: "A 12 second Instagram ad for my coffee roaster." }));
    await answers(app, id, [{ question_id: "q_goal", action: "answer", value: "Drive first orders" }]);
    let state = await stateOf(await app.request(`/api/sessions/${id}/direct`, post({ facts: [] })));
    expect(state.status).toBe("needs_clarification");
    expect(state.intake.questions.map((x: any) => x.id)).toEqual(["q_audience", "q_platform"]);
    expect(state.intake.questions[1]).toMatchObject({ kind: "choice", skippable: false });
    expect(state.treatment).toBeNull();
    await answers(app, id, [{ question_id: "q_audience", action: "answer", value: "Home coffee drinkers" }, { question_id: "q_platform", action: "answer", value: "Instagram Reels" }]);
    state = await stateOf(await app.request(`/api/sessions/${id}/direct`, post({ facts: [] })));
    expect(state.status).toBe("awaiting_approval");
    expect(state.gate).toBe("storyboard"); // the approval gate is unchanged
    expect(state.editPlan).toBeNull();
  });
  it("without the guided setup the run behaves as before", async () => {
    const app = build(), id = await newSession(app);
    await app.request(`/api/sessions/${id}/route`, post({ text: "A 12 second Instagram ad for my coffee roaster." }));
    const state = await stateOf(await app.request(`/api/sessions/${id}/direct`, post({ facts: [] })));
    expect(state.status).toBe("awaiting_approval");
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
  it("proposes video types for category and records user choice", async () => {
    const app = build(), id = await newSession(app);
    await app.request(`/api/sessions/${id}/kit/category`, post({ video_category: "saas" }));
    const types = await j(await app.request(`/api/sessions/${id}/video-types`));
    expect(types.video_category).toBe("saas");
    expect(types.proposals).toHaveLength(3);
    expect(types.proposals[0].id).toBe("saas-product-demo");
    expect(types.chosen).toBeNull();

    // User chooses a type
    const picked = await j(await app.request(`/api/sessions/${id}/video-type`, post({ video_type: "saas-feature-launch" })));
    expect(picked.ok).toBe(true);
    expect(picked.chosen).toBe("saas-feature-launch");
    expect(picked.kit.video_type).toBe("saas-feature-launch");

    // Invalid type rejected
    const bad = await app.request(`/api/sessions/${id}/video-type`, post({ video_type: "invalid-type" }));
    expect(bad.status).toBe(422);
  });
});
