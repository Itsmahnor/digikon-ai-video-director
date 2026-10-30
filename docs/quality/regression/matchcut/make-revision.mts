// Builds edit-plan revision 2 as a NEW file from the approved plan. It reads the checkpoint and writes nothing else: no approval, checkpoint or render is touched.
import { readFileSync, writeFileSync } from "node:fs";
import { RecipeLibrary, loadRecipes, validateEditPlan } from "../../../../packages/recipes/src/index.js";
import { editIssues } from "../../../../packages/director/src/nodes.js";
import { checkMatchCut } from "../../../../packages/render/src/transition-checks.js";
import { rawFrame } from "../../../../packages/render/src/verify.js";

const cp = JSON.parse(readFileSync("storage/sessions/9a44fee151f6/runs/9a44fee151f6-1793346641368/checkpoint.json", "utf8"));
const before = cp.state.editPlan;
const after = structuredClone(before);
after.version = before.version + 1;
const u = after.uses.find((x: { use_id: string }) => x.use_id === "U04");
if (u.recipe_id !== "hard-cut" || u.scene_id !== "S02") throw new Error("U04 is not the S02 hard cut");
u.recipe_id = "match-cut";
u.params = {};
u.rationale = "The storyboard asks for a match cut from S02 to S03. The match-cut recipe replaces the hard-cut approximation. It is only a match cut if S02's last picture and S03's first picture match; the assembler measures that and reports it as not applied otherwise (see the matching specification).";
writeFileSync("docs/quality/regression/matchcut/edit-plan-v2.json", JSON.stringify(after, null, 2));

const changed = after.uses.filter((x: { use_id: string }, i: number) => JSON.stringify(x) !== JSON.stringify(before.uses[i]));
console.log("uses", before.uses.length, "->", after.uses.length, "changed:", changed.map((x: { use_id: string }) => x.use_id).join(","));

const lib = new RecipeLibrary(loadRecipes("recipes"));
const issues = editIssues(after, cp.state.scenePlan, { recipes: lib } as never, cp.state.project, cp.state.assets);
console.log("v1 issues", JSON.stringify(editIssues(before, cp.state.scenePlan, { recipes: lib } as never, cp.state.project, cp.state.assets)));
console.log("v2 issues", JSON.stringify(issues));
void validateEditPlan;

const v = "storage/sessions/9a44fee151f6/renders/9a44fee151f6-1793346641368/out/rn_bdb5bf7a58714b81.mp4";
const m = checkMatchCut(await rawFrame(v, 179, 1280, 720, "ffmpeg"), await rawFrame(v, 180, 1280, 720, "ffmpeg"), 1280, 720);
console.log("current S02 last vs S03 first:", JSON.stringify(m));
