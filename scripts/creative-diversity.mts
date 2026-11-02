// The creative diversity evaluation: runs the real Director (treatment and storyboard, with the model) over evals/creative-diversity.json, renders each film with the real
// renderer, makes a contact sheet of real frames and compares the films. Plans are kept in storage/evals/diversity, so re-rendering costs no model calls.
//   npx tsx scripts/creative-diversity.mts                 plan what is missing, render, report
//   npx tsx scripts/creative-diversity.mts --fresh         plan every film again
//   npx tsx scripts/creative-diversity.mts --only id       one film
//   npx tsx scripts/creative-diversity.mts --no-render     plans and metrics only
//   npx tsx scripts/creative-diversity.mts --baseline      also score the films stored before visual systems existed
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Project, type EditorOperation, type ScenePlan, type Treatment } from "@digikon/contracts";
import { AnthropicClient, SkillLibrary, storyboardNode, treatmentNode } from "@digikon/director";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import { COMPOSITION_TEMPLATE, createRemotionAdapter, loadCapabilityRegistry } from "@digikon/render";
import { DIMENSIONS, diversityReport, type FilmPlan } from "../packages/evals/src/diversity.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
try { process.loadEnvFile(join(root, ".env")); } catch { /* optional */ }

const out = join(root, "storage", "evals", "diversity");
mkdirSync(out, { recursive: true });
const briefs = (JSON.parse(readFileSync(join(root, "evals", "creative-diversity.json"), "utf8")) as Record<string, string & number>[]).filter((b) => !arg("only") || b["id"] === arg("only"));

interface Planned { id: string; category: string; treatment: Treatment; plan: ScenePlan; issues: string[]; attempts: number }

async function planAll(): Promise<Planned[]> {
  const recipes = loadRecipes(join(root, "recipes"));
  const library = new RecipeLibrary(recipes, "draft");
  const deps = { llm: new AnthropicClient(), skills: new SkillLibrary(join(root, "skills")), retriever: new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(root, "knowledge"))]), recipes: library };
  const done: Planned[] = [];
  for (const b of briefs) {
    const file = join(out, `${b["id"]}.plan.json`);
    if (existsSync(file) && !flag("fresh")) { done.push(JSON.parse(readFileSync(file, "utf8"))); continue; }
    const project = Project.parse({ project_id: `eval-${b["id"]}`, owner_id: "eval", brief: b["brief"], objective: b["objective"], audience: b["audience"], platform: b["platform"], aspect_ratio: b["aspect_ratio"], target_duration: b["target_duration"] });
    console.log(`planning ${b["id"]} ...`);
    let t, s;
    try {
      t = await treatmentNode(deps, project, []);
      s = await storyboardNode(deps, project, [], [], t.treatment, []);
    } catch (e) { console.log(`  FAILED: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`); continue; }
    const p: Planned = { id: b["id"], category: b["category"], treatment: t.treatment, plan: s.value, issues: s.issues, attempts: s.attempts };
    writeFileSync(file, `${JSON.stringify(p, null, 2)}\n`);
    console.log(`  ${t.treatment.art_direction?.visual_system}: ${s.value.scenes.map((x) => x.visual?.block ?? "none").join(" > ")}${s.issues.length ? ` (${s.issues.length} open issues)` : ""}`);
    done.push(p);
  }
  return done;
}

const SIZE = { "16:9": [960, 540], "9:16": [540, 960], "1:1": [720, 720] } as const;
const font = [process.env["RENDER_FONT_FILE"] ?? "", "C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find((f) => f && existsSync(f))!;

async function render(p: Planned): Promise<{ video: string | null; problems: string[] }> {
  const ratio = p.plan.scenes.length ? (briefs.find((b) => b["id"] === p.id)?.["aspect_ratio"] as keyof typeof SIZE) ?? "16:9" : "16:9";
  const [width, height] = SIZE[ratio];
  const dir = join(out, "films");
  mkdirSync(dir, { recursive: true });
  const id = `rn_${Buffer.from(p.id.padEnd(8, "x")).toString("hex").slice(0, 16)}`;
  const video = join(dir, `${id}.mp4`);
  rmSync(video, { force: true });
  const fps = 30;
  const scenes = p.plan.scenes.filter((s) => s.visual);
  const adapter = createRemotionAdapter({ fontFile: font, outputRoot: dir, workRoot: join(out, "work") });
  const ops = scenes.map((s, i): EditorOperation => ({ operation_id: `E${i + 1}`, target_scene_id: s.scene_id, operation_type: "render_graphics_scene", parameters: {}, timing: { start_s: 0, duration_s: s.duration_seconds }, asset_ids: [], audio_cues: [], caption: null } as unknown as EditorOperation));
  let t = 0;
  for (const o of ops) { o.timing.start_s = t; t += o.timing.duration_s; }
  const job = {
    render_id: id, settings: { aspect_ratio: ratio, width, height, fps, duration_s: t, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "creative diversity evaluation" } } as never,
    operations: ops, templates: Object.fromEntries(ops.map((o) => [o.operation_id, COMPOSITION_TEMPLATE])), assets: [], clips: [], asset_info: {}, concept_asset_ids: [],
    scene_visuals: Object.fromEntries(scenes.map((s) => [s.scene_id, { visual: s.visual, overlay_text: s.overlay?.text ?? null, visual_purpose: s.visual_purpose }])), art_direction: p.treatment.art_direction ?? null, output_path: video,
  };
  const problems = adapter.check?.(job as never) ?? [];
  if (problems.length) return { video: null, problems };
  mkdirSync(join(out, "work"), { recursive: true });
  try { await adapter.render({ ...job, signal: new AbortController().signal } as never); } catch (e) { return { video: null, problems: [(e instanceof Error ? e.message : String(e)).slice(0, 600)] }; }
  // a contact sheet of the moment each scene has settled
  let at = 0;
  const times = scenes.map((s) => { const x = at + s.duration_seconds * 0.72; at += s.duration_seconds; return x; });
  const cols = Math.min(times.length, height > width ? 6 : 4);
  const tw = height > width ? 180 : 320;
  const select = times.map((x) => `lt(prev_pts*TB\\,${x.toFixed(3)})*gte(pts*TB\\,${x.toFixed(3)})`).join("+");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", video, "-vf", `select='${select}',scale=${tw}:-2,tile=${cols}x${Math.ceil(times.length / cols)}:padding=6:color=0x444444`, "-frames:v", "1", "-fps_mode", "vfr", join(out, `${p.id}.sheet.png`)], { windowsHide: true });
  return { video, problems: [] };
}

function baseline(): FilmPlan[] {
  const films: FilmPlan[] = [];
  const dir = join(root, "storage", "sessions");
  const seen = new Set<string>();
  for (const id of readdirSync(dir)) {
    const runs = join(dir, id, "runs");
    if (!existsSync(runs)) continue;
    for (const r of readdirSync(runs)) {
      const f = join(runs, r, "checkpoint.json");
      if (!existsSync(f)) continue;
      try {
        const s = JSON.parse(readFileSync(f, "utf8")).state;
        const brief = String(s.project?.brief ?? "").slice(0, 40);
        if (!s.scenePlan?.scenes?.some((x: { visual: unknown }) => x.visual) || seen.has(brief)) continue;
        seen.add(brief);
        films.push({ id, category: id, art: s.treatmentDoc?.art_direction ?? null, scenes: s.scenePlan.scenes });
      } catch { /* an unreadable run is left out */ }
    }
  }
  return films;
}

const pct = (n: number) => n.toFixed(2);
const report = (title: string, films: FilmPlan[]) => {
  const r = diversityReport(films);
  console.log(`\n== ${title} (${r.films} films) ==`);
  console.log(`mean distance ${pct(r.mean_distance)}; across categories ${pct(r.across_categories.mean)} (${r.across_categories.different}/${r.across_categories.total} different); within a category ${pct(r.within_category.mean)} (${r.within_category.different}/${r.within_category.total} different)`);
  console.log(`by dimension: ${DIMENSIONS.map((d) => `${d} ${pct(r.by_dimension[d])}`).join(", ")}`);
  console.log(`systems: ${JSON.stringify(r.systems)}\nopens on: ${JSON.stringify(r.opening_blocks)}\ncloses on: ${JSON.stringify(r.closing_blocks)}`);
  return r;
};

const planned = await planAll();
const films: FilmPlan[] = planned.map((p) => ({ id: p.id, category: p.category, art: p.treatment.art_direction ?? null, scenes: p.plan.scenes }));
const after = report("With visual systems", films);
for (const p of [...after.pairs].sort((a, b) => a.distance - b.distance).slice(0, 5)) console.log(`  closest: ${p.a} / ${p.b}: ${pct(p.distance)} (${p.verdict})`);
const before = flag("baseline") ? report("Stored films from before", baseline()) : null;

const renders: Record<string, string[]> = {};
if (!flag("no-render")) for (const p of planned) {
  console.log(`rendering ${p.id} ...`);
  const r = await render(p);
  renders[p.id] = r.problems;
  console.log(r.video ? "  rendered and measured" : `  REFUSED: ${r.problems.join("; ")}`);
}
writeFileSync(join(out, "report.json"), `${JSON.stringify({ ran_at: new Date().toISOString(), after, before, renders, plans: planned.map((p) => ({ id: p.id, system: p.treatment.art_direction?.visual_system, blocks: p.plan.scenes.map((s) => s.visual?.block ?? "none"), transitions: p.plan.scenes.map((s) => s.transition_out), audio: p.plan.scenes.flatMap((s) => s.audio_cues), open_issues: p.issues, attempts: p.attempts })) }, null, 2)}\n`);
void loadCapabilityRegistry;
