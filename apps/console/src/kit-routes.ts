import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import { Answer, AnswerRefused, applyAnswer, questionsFor, KIT_FIELDS, KitFact, ProjectKit, VideoCategory, approvedFacts, completeness, confirmField, emptyKit, getField, provide, skip, unconfirmed, unset, type Asset, type KitField } from "@digikon/contracts";
import { MAX_GUIDELINE_BYTES, readGuideline, readWebsite, type ReadOptions, type WebsiteReading } from "@digikon/media";
import { createHash } from "node:crypto";

/**
 * The guided intake's server side: each session has a project kit (digikon.project-kit), saved to the session folder after every change so progress survives a reload,
 * and a store of saved brands a returning user can reuse. Anything extracted from a website or a file waits in `extractions` until the user confirms it item by item;
 * confirming is the only way it reaches the kit, and unconfirmed extractions never become approved brand facts.
 */
export interface Extraction {
  source: "website" | "guideline";
  /** The user-facing label of where it came from (the page address or the file name). */
  from: string;
  colours: { hex: string; count: number }[];
  fonts: string[];
  facts: { id: string; text: string }[];
  logo_candidates: string[];
  excerpt: string[];
}
export interface KitSession { id: string; dir: string; assets: Asset[]; kit?: ProjectKit; extractions?: Partial<Record<"website" | "guideline", Extraction>> }
export interface KitRouteDeps {
  session(id: string): KitSession;
  fail(status: 400 | 404 | 409 | 413 | 422, code: string, message: string): never;
  storageDir: string;
  /** Tests only (a local fixture server). The console never sets it. */
  websiteOptions?: ReadOptions;
}

const FieldBody = z.object({ field: z.enum(KIT_FIELDS), action: z.enum(["provide", "skip", "unset"]), value: z.unknown().optional() });
const CategoryBody = z.object({ video_category: VideoCategory.nullable() });
const AnswersBody = z.object({ answers: z.array(Answer).min(1).max(20) });
const WebsiteBody = z.object({ url: z.string().trim().min(1).max(2000) });
const ConfirmBody = z.object({ source: z.enum(["website", "guideline"]), colours: z.array(z.string()).max(12).default([]), fonts: z.array(z.string()).max(6).default([]), fact_ids: z.array(z.string()).max(40).default([]) });
const BrandBody = z.object({ name: z.string().trim().min(1).max(80) });
const LoadBody = z.object({ brand_id: z.string().regex(/^brand_[a-f0-9]{12}$/) });

const writeJson = (file: string, data: unknown) => { writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), "utf8"); renameSync(`${file}.tmp`, file); };

export function registerKitRoutes(app: Hono, deps: KitRouteDeps) {
  const kitOf = (s: KitSession): ProjectKit => {
    if (!s.kit) {
      const f = join(s.dir, "kit.json");
      let loaded: ProjectKit | null = null;
      if (existsSync(f)) { const p = ProjectKit.safeParse(JSON.parse(readFileSync(f, "utf8"))); if (p.success) loaded = p.data; }
      s.kit = loaded ?? emptyKit(`kit_${s.id}`, { project_id: `proj_${s.id}` });
    }
    return s.kit;
  };
  const setKit = (s: KitSession, k: ProjectKit) => { s.kit = k; mkdirSync(s.dir, { recursive: true }); writeJson(join(s.dir, "kit.json"), k); };
  const view = (s: KitSession) => {
    const kit = kitOf(s);
    const pending = Object.values(s.extractions ?? {}).filter(Boolean) as Extraction[];
    return { kit, completeness: completeness(kit), approved_fact_count: approvedFacts(kit).length, unconfirmed: unconfirmed(kit), pending_extractions: pending };
  };
  const guard = <T>(fn: () => T): T => { try { return fn(); } catch (e) { deps.fail(422, "kit_invalid", e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : e instanceof Error ? e.message : String(e)); } };
  const body = async <S extends z.ZodTypeAny>(c: { req: { json(): Promise<unknown> } }, schema: S): Promise<z.infer<S>> => { const p = schema.safeParse(await c.req.json().catch(() => ({}))); if (!p.success) deps.fail(400, "bad_request", p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")); return p.data; };

  app.get("/api/sessions/:id/kit", (c) => c.json(view(deps.session(c.req.param("id")))));

  /** Provide, skip or clear one field. A required field cannot be skipped. Facts typed here are the user's own and count as approved. */
  app.post("/api/sessions/:id/kit/field", async (c) => {
    const s = deps.session(c.req.param("id")), b = await body(c, FieldBody);
    let kit = kitOf(s);
    guard(() => {
      const name = b.field as KitField;
      if (b.action === "skip") { if (!completeness(kit).items.find((i) => i.field === name)!.can_skip) deps.fail(422, "cannot_skip", `${name} is required for this kind of video and cannot be skipped`); kit = skip(kit, name); }
      else if (b.action === "unset") kit = unset(kit, name);
      else if (name === "facts") {
        const typed = z.array(z.string().trim().min(1).max(300)).max(20).parse(b.value);
        const kept = (getField(kit, "facts").value as KitFact[] | null)?.filter((f) => f.origin !== "user") ?? [];
        const mine = typed.map((text, i) => KitFact.parse({ fact_id: `F${String(i + 1).padStart(2, "0")}`, text, origin: "user", source: "entered in the console", confirmed: true }));
        kit = [...kept, ...mine].length ? provide(kit, "facts", [...mine, ...kept.map((f, i) => ({ ...f, fact_id: `F${String(mine.length + i + 1).padStart(2, "0")}` }))], "user") : unset(kit, "facts");
      } else if (name === "assets" || name === "brand.logo" || name === "guideline") {
        const ids = z.union([z.string(), z.array(z.string())]).parse(b.value);
        const list = Array.isArray(ids) ? ids : [ids];
        for (const id of list) if (!s.assets.some((a) => a.asset_id === id)) deps.fail(422, "unknown_asset", `${id} is not one of this session's files`);
        kit = provide(kit, name, name === "assets" ? list : list[0], "upload");
      } else if (name === "brand.colours") kit = provide(kit, name, z.array(z.string()).parse(b.value).map((x) => x.trim().toLowerCase()), "user");
      else kit = provide(kit, name, typeof b.value === "string" ? b.value.trim() : b.value, "user");
    });
    setKit(s, kit);
    return c.json(view(s));
  });

  app.post("/api/sessions/:id/kit/category", async (c) => {
    const s = deps.session(c.req.param("id")), b = await body(c, CategoryBody);
    setKit(s, guard(() => ProjectKit.parse({ ...kitOf(s), video_category: b.video_category })));
    return c.json(view(s));
  });

  // ---------- typed questions ----------
  /** The questions still to ask, typed (upload, choice, text), from the kit and the completeness check. */
  app.get("/api/sessions/:id/kit/questions", (c) => {
    const s = deps.session(c.req.param("id")), v = view(s);
    return c.json({ questions: questionsFor(v.kit), ready: v.completeness.ready });
  });
  /** Answers one or more questions. All or none: if any answer is refused nothing changes. An upload answer names files this session already has. */
  app.post("/api/sessions/:id/kit/answers", async (c) => {
    const s = deps.session(c.req.param("id")), b = await body(c, AnswersBody);
    let kit = kitOf(s);
    b.answers.forEach((a, i) => {
      try {
        if (a.action === "answer" && /^q_(assets|brand_logo)$/.test(a.question_id)) {
          for (const id of Array.isArray(a.value) ? a.value : a.value ? [a.value] : []) if (!s.assets.some((x) => x.asset_id === id)) throw new AnswerRefused(`${id} is not one of this session's files`);
        }
        kit = applyAnswer(kit, a);
      } catch (e) { deps.fail(422, e instanceof AnswerRefused ? "answer_refused" : "kit_invalid", `answer ${i + 1} (${a.question_id}): ${e instanceof z.ZodError ? e.issues.map((x) => x.message).join("; ") : e instanceof Error ? e.message : String(e)}`); }
    });
    setKit(s, kit);
    return c.json({ ...view(s), questions: questionsFor(kit) });
  });

  // ---------- website ----------
  /**
   * Reads a public page. The address the user typed is kept as their own answer; what the page said (colours, fonts, copy, logos) is only offered back as candidates.
   * If the page cannot be read the kit is unchanged and the answer says to type the details in instead. Nothing here approves a fact.
   */
  app.post("/api/sessions/:id/website", async (c) => {
    const s = deps.session(c.req.param("id")), b = await body(c, WebsiteBody);
    const result = await readWebsite(b.url, deps.websiteOptions);
    if (result.status === "could_not_read") {
      return c.json({ status: "could_not_read", reason: result.reason, detail: result.detail, ask: `I could not read that page (${result.detail}). Type the colours, fonts and facts in yourself, or skip this step.` });
    }
    const r: WebsiteReading = result;
    setKit(s, guard(() => provide(kitOf(s), "website", r.final_url, "user")));
    s.extractions = { ...s.extractions, website: { source: "website", from: r.final_url, colours: r.colours, fonts: r.fonts, facts: r.candidate_facts.map((f, i) => ({ id: `w${i + 1}`, text: f.text })), logo_candidates: r.logo_candidates, excerpt: [r.title, r.description, ...r.headings].filter((x): x is string => !!x).slice(0, 6) } };
    return c.json({ status: "ok", extraction: s.extractions.website, note: "These were found on the page. Nothing is used until you confirm it." });
  });

  // ---------- brand guideline (PDF) ----------
  /**
   * Reads a brand guideline PDF. A file of the wrong type is refused (422) and a huge one too (413); a real PDF that cannot be read (scanned, encrypted, damaged) is kept as the
   * user's answer and the reply says to type the details in. What it reads is offered as candidates and goes through the same confirm step as a website.
   */
  app.post("/api/sessions/:id/guideline", async (c) => {
    const s = deps.session(c.req.param("id"));
    if (Number(c.req.header("content-length") ?? 0) > MAX_GUIDELINE_BYTES + 64 * 1024) deps.fail(413, "file_too_large", `a guideline file can be at most ${MAX_GUIDELINE_BYTES / 1048576} MB`);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) deps.fail(400, "bad_request", "send the PDF in a form field named file");
    if (file.size > MAX_GUIDELINE_BYTES) deps.fail(413, "file_too_large", `a guideline file can be at most ${MAX_GUIDELINE_BYTES / 1048576} MB`);
    if (!/\.pdf$/i.test(file.name)) deps.fail(422, "wrong_file_type", "a brand guideline must be a PDF file");
    const buf = Buffer.from(await file.arrayBuffer());
    const r = readGuideline(buf);
    if (r.status === "could_not_read" && r.reason === "not_pdf") deps.fail(422, "wrong_file_type", "that file is not a PDF, even though its name ends in .pdf");
    const stored = `guideline-${createHash("sha256").update(buf).digest("hex").slice(0, 8)}.pdf`;
    mkdirSync(join(s.dir, "uploads"), { recursive: true });
    writeFileSync(join(s.dir, "uploads", stored), buf);
    setKit(s, guard(() => provide(kitOf(s), "guideline", stored, "upload")));
    if (r.status === "could_not_read") return c.json({ status: "could_not_read", reason: r.reason, detail: r.detail, ask: `I could not read that guideline (${r.detail}). Type the colours, fonts and tone in yourself, or skip this step.`, file: stored });
    s.extractions = { ...s.extractions, guideline: { source: "guideline", from: file.name, colours: r.colours, fonts: r.fonts, facts: r.candidate_facts.map((text, i) => ({ id: `g${i + 1}`, text })), logo_candidates: [], excerpt: r.excerpt } };
    return c.json({ status: "ok", file: stored, extraction: s.extractions.guideline, note: "These were found in the file. Nothing is used until you confirm it." });
  });

  /** The confirm step: only items that were actually extracted can be confirmed, one by one. */
  app.post("/api/sessions/:id/kit/confirm", async (c) => {
    const s = deps.session(c.req.param("id")), b = await body(c, ConfirmBody);
    const ex = s.extractions?.[b.source];
    if (!ex) deps.fail(409, "nothing_to_confirm", `nothing was extracted from a ${b.source}`);
    let kit = kitOf(s);
    guard(() => {
      const colours = b.colours.map((x) => x.toLowerCase()); for (const h of colours) if (!ex.colours.some((x) => x.hex === h)) deps.fail(422, "not_extracted", `${h} was not found in the ${b.source}`);
      for (const f of b.fonts) if (!ex.fonts.includes(f)) deps.fail(422, "not_extracted", `${f} was not found in the ${b.source}`);
      for (const id of b.fact_ids) if (!ex.facts.some((x) => x.id === id)) deps.fail(422, "not_extracted", `${id} was not found in the ${b.source}`);
      if (colours.length) { const have = (getField(kit, "brand.colours").value as string[] | null) ?? []; kit = provide(kit, "brand.colours", [...new Set([...have, ...colours])].slice(0, 12), b.source); kit = confirmField(kit, "brand.colours"); }
      if (b.fonts.length) { const have = (getField(kit, "brand.fonts").value as string[] | null) ?? []; kit = provide(kit, "brand.fonts", [...new Set([...have, ...b.fonts])].slice(0, 6), b.source); kit = confirmField(kit, "brand.fonts"); }
      if (b.fact_ids.length) {
        const have = (getField(kit, "facts").value as KitFact[] | null) ?? [];
        const add = b.fact_ids.map((id) => ex.facts.find((x) => x.id === id)!).filter((f) => !have.some((h) => h.text === f.text));
        const merged = [...have, ...add.map((f, i) => KitFact.parse({ fact_id: `F${String(have.length + i + 1).padStart(2, "0")}`, text: f.text, origin: b.source, source: ex.from, confirmed: true }))];
        kit = provide(kit, "facts", merged, "user");
      }
    });
    setKit(s, kit);
    return c.json(view(s));
  });

  // ---------- saved brands ----------
  const brandsDir = join(deps.storageDir, "brand-kits");
  const brandFile = (id: string) => join(brandsDir, `${id}.json`);
  app.get("/api/brand-kits", (c) => {
    if (!existsSync(brandsDir)) return c.json({ brands: [] });
    const brands = readdirSync(brandsDir).filter((f) => f.endsWith(".json")).flatMap((f) => { try { const j = JSON.parse(readFileSync(join(brandsDir, f), "utf8")) as { brand_id: string; name: string; saved_at: string }; return [{ brand_id: j.brand_id, name: j.name, saved_at: j.saved_at }]; } catch { return []; } });
    return c.json({ brands: brands.sort((a, b) => b.saved_at.localeCompare(a.saved_at)) });
  });
  /** Saves the brand part of the kit (colours, fonts, tone, website, confirmed facts) so a later project can reuse it. The logo and other uploads stay with their project. */
  app.post("/api/sessions/:id/kit/save-brand", async (c) => {
    const s = deps.session(c.req.param("id")), b = await body(c, BrandBody), kit = kitOf(s);
    const brand_id = kit.brand_id ?? `brand_${[...Array(12)].map(() => Math.floor(Math.random() * 16).toString(16)).join("")}`;
    mkdirSync(brandsDir, { recursive: true });
    const keep = (name: KitField) => { const f = getField(kit, name); return f.state === "provided" && (f.source === "user" || f.confirmed) ? f.value : null; };
    writeJson(brandFile(brand_id), { brand_id, name: b.name, saved_at: new Date().toISOString(), colours: keep("brand.colours"), fonts: keep("brand.fonts"), tone: keep("brand.tone"), website: keep("website"), facts: approvedFacts(kit).map((f) => ({ text: f.text, source: f.source })) });
    setKit(s, guard(() => ProjectKit.parse({ ...kit, brand_id })));
    return c.json({ brand_id, ...view(s) });
  });
  /** Starts from a saved brand: its values are the user's own (they saved them), so they are provided and confirmed, and the kit links to the brand. */
  app.post("/api/sessions/:id/kit/load-brand", async (c) => {
    const s = deps.session(c.req.param("id")), b = await body(c, LoadBody);
    if (!existsSync(brandFile(b.brand_id))) deps.fail(404, "no_such_brand", "that saved brand does not exist");
    const saved = JSON.parse(readFileSync(brandFile(b.brand_id), "utf8")) as { colours: string[] | null; fonts: string[] | null; tone: string | null; website: string | null; facts: { text: string; source: string }[] };
    let kit = kitOf(s);
    guard(() => {
      if (saved.colours?.length) kit = provide(kit, "brand.colours", saved.colours, "user");
      if (saved.fonts?.length) kit = provide(kit, "brand.fonts", saved.fonts, "user");
      if (saved.tone) kit = provide(kit, "brand.tone", saved.tone, "user");
      if (saved.website) kit = provide(kit, "website", saved.website, "user");
      if (saved.facts?.length) kit = provide(kit, "facts", saved.facts.map((f, i) => KitFact.parse({ fact_id: `F${String(i + 1).padStart(2, "0")}`, text: f.text, origin: "user", source: "saved brand", confirmed: true })), "user");
      kit = ProjectKit.parse({ ...kit, brand_id: b.brand_id });
    });
    setKit(s, kit);
    return c.json(view(s));
  });

  return { kitOf, setKit, view };
}
