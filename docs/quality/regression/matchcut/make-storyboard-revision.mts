// Builds storyboard revision 2 as a NEW file. Nothing approved, stored or rendered is touched.
import { readFileSync, writeFileSync } from "node:fs";
import { SceneVisual, creativeIssues } from "../../../../packages/contracts/src/index.js";

const cp = JSON.parse(readFileSync("storage/sessions/9a44fee151f6/runs/9a44fee151f6-1793346641368/checkpoint.json", "utf8"));
const before = cp.state.scenePlan;
const after = structuredClone(before);
after.version = before.version + 1;
const s03 = after.scenes.find((s: { scene_id: string }) => s.scene_id === "S03");
s03.visual.held = { card: 0, from_scene: "S02", word_index: 1 };
writeFileSync("docs/quality/regression/matchcut/storyboard-v2.json", JSON.stringify(after, null, 2));

const flat = (o: unknown, p = ""): Record<string, string> => (o && typeof o === "object" ? Object.entries(o as object).reduce((a, [k, v]) => ({ ...a, ...flat(v, `${p}${p ? "." : ""}${k}`) }), {}) : { [p]: JSON.stringify(o) });
const a = flat(before), b = flat(after);
const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k] ?? "(absent)"} -> ${b[k] ?? "(absent)"}`);
console.log("changed fields:\n" + diff.join("\n"));
const parsed = after.scenes.map((s: { visual: unknown }) => (s.visual ? SceneVisual.safeParse(s.visual).success : true));
console.log("every visual parses:", parsed.every(Boolean));
console.log("creative issues v1:", JSON.stringify(creativeIssues(before.scenes, cp.state.treatmentDoc?.art_direction ?? null).map((i) => i.code)));
console.log("creative issues v2:", JSON.stringify(creativeIssues(after.scenes.map((s: { visual: unknown }) => ({ ...s, visual: s.visual ? SceneVisual.parse(s.visual) : null })), cp.state.treatmentDoc?.art_direction ?? null).map((i) => i.code)));
