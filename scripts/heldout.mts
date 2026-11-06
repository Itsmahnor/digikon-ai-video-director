import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CachedEmbedder, HybridRetriever, KeywordRetriever, MemoryVectorIndex, SKILLS_HYBRID_OPTIONS, SKILLS_KEYWORD_FLOOR, SKILLS_LOCAL_OPTIONS, chooseEmbedder, embeddingTextOf, loadSkillDocs, type Doc, type HybridOptions, type Retriever } from "@digikon/rag";

/**
 * The locked held-out retrieval set. Three steps:
 *   npm run heldout -- pool   pools the top candidates of several retrievers per query (order shuffled, ranks hidden) into evals/heldout/review.html for a person to grade
 *   npm run heldout -- lock   after labels.json is saved: records the hashes of queries.json and labels.json in LOCK.json (from then on a test fails if either changes)
 *   npm run heldout -- eval   scores the retrievers on the locked set with a bootstrap interval, appends the run to runs.log. Refuses if the lock is missing or broken,
 *                             or if HELDOUT_TUNING=1 is set. Look at it rarely: every run is logged, and tuning on it makes it a dev set.
 * No network and no API: the embedding model is local.
 */
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dir = join(root, "evals", "heldout");
type Q = [id: string, query: string, category: string, scope: string, kind: string];
const queries = (): Q[] => (JSON.parse(readFileSync(join(dir, "queries.json"), "utf8")) as { queries: Q[] }).queries;
const sha = (f: string) => createHash("sha256").update(readFileSync(join(dir, f))).digest("hex");
const filterOf = (q: Q) => ({ category: q[2], include_draft: true, skill_scope: q[3] });

async function build() {
  const docs: Doc[] = loadSkillDocs(join(root, "examples", "skills"));
  const chosen = chooseEmbedder(join(root, "storage", "models"));
  if (!chosen.real) throw new Error("No local sentence model under storage/models.");
  const emb = new CachedEmbedder(chosen.embedder, join(root, "storage", "index", "eval-skills.json"));
  const vs = await emb.embed(docs.map(embeddingTextOf));
  emb.save();
  const hybrid = (o: HybridOptions): Retriever => { const ix = new MemoryVectorIndex(), m = new Map<string, readonly number[]>(); docs.forEach((d, i) => { ix.set(`skills\u0000${d.id}`, vs[i]!); m.set(`skills\u0000${d.id}`, vs[i]!); }); return new HybridRetriever(docs, emb, ix, o, m); };
  return { docs, hybrid, model: `${chosen.embedder.model}@${chosen.embedder.version}` };
}

const cmd = process.argv[2];
if (cmd === "pool") {
  const { docs, hybrid } = await build();
  const byId = new Map(docs.map((d) => [d.id, d]));
  const bm25 = new KeywordRetriever(docs), wide = hybrid({ min_similarity: 0.2, rrf_k: 60 });
  const rank = (s: string) => createHash("sha256").update(s).digest("hex");
  const items = [];
  for (const q of queries()) {
    const ids = new Set<string>();
    for (const r of [bm25, wide]) for (const h of await r.retrieve({ text: q[1], collection: "skills", k: 10, filter: filterOf(q) })) ids.add(h.doc.id);
    const cands = [...ids].sort((a, b) => rank(q[0] + a).localeCompare(rank(q[0] + b))).map((id) => ({ id, title: byId.get(id)!.title, excerpt: byId.get(id)!.text.slice(0, 260) }));
    items.push({ id: q[0], query: q[1], kind: q[4], category: q[2], scope: q[3], candidates: cands });
  }
  writeFileSync(join(dir, "review.json"), JSON.stringify(items, null, 1));
  const html = `<!doctype html><meta charset="utf-8"><title>Grade retrieval candidates</title><style>body{font:15px system-ui;max-width:900px;margin:24px auto;padding:0 16px}.q{border:1px solid #bbb;border-radius:8px;padding:12px;margin:14px 0}.c{display:flex;gap:10px;padding:6px 0;border-top:1px solid #eee}.c small{color:#555;display:block}select{height:28px}h3{margin:0 0 6px}.off{background:#fff7e6}</style>
<h1>Grade retrieval candidates</h1><p>For each query, grade every skill: <b>2</b> = a good director would want this in front of them for this brief or scene; <b>1</b> = useful but not essential; <b>0</b> = not relevant (leave as is). Off-topic queries should stay all 0. Candidates are shuffled and carry no rank. Click Save at the bottom; it downloads <code>labels.json</code>: put it in <code>evals/heldout/</code>.</p><div id=app></div><p><label>Your name: <input id=who></label> <button id=save>Save labels.json</button></p>
<script>const items=${JSON.stringify(items).replace(/</g, "\\u003c")};const app=document.getElementById("app");
items.forEach(q=>{const d=document.createElement("div");d.className="q"+(q.kind==="off_topic"?" off":"");d.innerHTML="<h3>"+q.id+" ["+q.kind+", "+q.category+", "+q.scope+"]</h3><p><b>"+q.query.replace(/</g,"&lt;")+"</b></p>"+q.candidates.map(c=>'<div class=c><select data-q="'+q.id+'" data-s="'+c.id+'"><option>0</option><option>1</option><option>2</option></select><div><b>'+c.title.replace(/</g,"&lt;")+'</b> <code>'+c.id+'</code><small>'+c.excerpt.replace(/</g,"&lt;")+'</small></div></div>').join("");app.appendChild(d)});
document.getElementById("save").onclick=()=>{const labels={};items.forEach(q=>labels[q.id]={});document.querySelectorAll("select").forEach(s=>{labels[s.dataset.q][s.dataset.s]=Number(s.value)});const blob=new Blob([JSON.stringify({labelled_by:document.getElementById("who").value,labelled_at:new Date().toISOString(),labels},null,1)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="labels.json";a.click()};</script>`;
  writeFileSync(join(dir, "review.html"), html);
  console.log(`pooled ${items.length} queries, ${items.reduce((n, i) => n + i.candidates.length, 0)} candidates. Open evals/heldout/review.html, grade, save labels.json into evals/heldout/, then run: npm run heldout -- lock`);
} else if (cmd === "lock") {
  if (!existsSync(join(dir, "labels.json"))) { console.error("evals/heldout/labels.json is missing: grade the candidates first."); process.exit(2); }
  const labels = (JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")) as { labels: Record<string, Record<string, number>> }).labels;
  const missing = queries().filter((q) => !labels[q[0]]).map((q) => q[0]);
  if (missing.length) { console.error(`labels.json has no entry for: ${missing.join(", ")}`); process.exit(2); }
  const unlabelled = queries().filter((q) => q[4] !== "off_topic" && !Object.values(labels[q[0]]!).some((g) => g > 0)).map((q) => q[0]);
  if (unlabelled.length) { console.error(`these on-topic queries have no relevant skill graded 1 or 2: ${unlabelled.join(", ")}. Grade them, or remove the query.`); process.exit(2); }
  writeFileSync(join(dir, "LOCK.json"), JSON.stringify({ queries_sha256: sha("queries.json"), labels_sha256: sha("labels.json"), locked_at: new Date().toISOString() }, null, 1));
  console.log("locked. queries.json and labels.json must not change now.");
} else if (cmd === "eval") {
  if (process.env["HELDOUT_TUNING"] === "1") { console.error("Refused: HELDOUT_TUNING=1. Tune on a dev set (evals/local-retrieval-benchmark.json, the independent set), never on the held-out set."); process.exit(2); }
  if (!existsSync(join(dir, "LOCK.json"))) { console.error("Not locked: run `npm run heldout -- pool`, grade, then `lock`."); process.exit(2); }
  const lock = JSON.parse(readFileSync(join(dir, "LOCK.json"), "utf8")) as { queries_sha256: string; labels_sha256: string };
  if (lock.queries_sha256 !== sha("queries.json") || lock.labels_sha256 !== sha("labels.json")) { console.error("Refused: queries.json or labels.json changed after the lock."); process.exit(2); }
  const labels = (JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")) as { labels: Record<string, Record<string, number>> }).labels;
  const { hybrid, docs, model } = await build();
  const retrievers: Record<string, Retriever> = {
    "BM25 + idf floor 0.2": new KeywordRetriever(docs, 1.5, 0.75, SKILLS_KEYWORD_FLOOR),
    "hybrid, keyword required (old default)": hybrid(SKILLS_HYBRID_OPTIONS),
    "hybrid, local default": hybrid(SKILLS_LOCAL_OPTIONS),
  };
  const gain = (g: number) => (g === 2 ? 3 : g === 1 ? 1 : 0);
  type M = { ndcg: number; recall: number; mrr: number; empty: number | null };
  const per: Record<string, M[]> = {};
  for (const [name, r] of Object.entries(retrievers)) {
    per[name] = [];
    for (const q of queries()) {
      const lab = labels[q[0]]!, hits = (await r.retrieve({ text: q[1], collection: "skills", k: 5, filter: filterOf(q) })).map((h) => h.doc.id);
      if (q[4] === "off_topic") { per[name]!.push({ ndcg: NaN, recall: NaN, mrr: NaN, empty: hits.length === 0 ? 1 : 0 }); continue; }
      const dcg = hits.reduce((s, id, i) => s + gain(lab[id] ?? 0) / Math.log2(i + 2), 0);
      const ideal = Object.values(lab).map(gain).sort((a, b) => b - a).slice(0, 5).reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
      const must = Object.entries(lab).filter(([, g]) => g === 2).map(([id]) => id);
      const first = hits.findIndex((id) => (lab[id] ?? 0) > 0);
      per[name]!.push({ ndcg: ideal ? dcg / ideal : 0, recall: must.length ? must.filter((id) => hits.includes(id)).length / must.length : 1, mrr: first >= 0 ? 1 / (first + 1) : 0, empty: null });
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const on = (name: string, k: keyof M) => per[name]!.map((m) => m[k] as number).filter((x) => !Number.isNaN(x));
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const ci = (a: number[], b: number[]) => { const d = a.map((x, i) => x - b[i]!); const bs: number[] = []; for (let n = 0; n < 2000; n++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[Math.floor(rnd() * d.length)]!; bs.push(s / d.length); } bs.sort((x, y) => x - y); return [mean(d), bs[50]!, bs[1949]!] as const; };
  const lines = [`Held-out set: ${queries().length} queries (${queries().filter((q) => q[4] === "off_topic").length} off-topic), model ${model}`, "| retriever | nDCG@5 | recall@5 (grade 2) | MRR | off-topic empty |", "|---|---|---|---|---|"];
  for (const name of Object.keys(per)) lines.push(`| ${name} | ${mean(on(name, "ndcg")).toFixed(3)} | ${mean(on(name, "recall")).toFixed(3)} | ${mean(on(name, "mrr")).toFixed(3)} | ${per[name]!.filter((m) => m.empty === 1).length}/${per[name]!.filter((m) => m.empty !== null).length} |`);
  const local = "hybrid, local default";
  for (const base of ["BM25 + idf floor 0.2", "hybrid, keyword required (old default)"]) {
    const [d, lo, hi] = ci(on(local, "ndcg"), on(base, "ndcg"));
    lines.push(`nDCG@5, local default minus ${base}: ${d >= 0 ? "+" : ""}${d.toFixed(3)} (95% bootstrap interval ${lo.toFixed(3)} to ${hi.toFixed(3)})${lo > 0 ? ": improvement is clear" : hi < 0 ? ": worse" : ": not distinguishable from zero"}`);
  }
  const prior = existsSync(join(dir, "runs.log")) ? readFileSync(join(dir, "runs.log"), "utf8").split("\n").filter((l) => l.startsWith("RUN ")).length : 0;
  lines.push(`This is held-out run number ${prior + 1}. Every run is logged in evals/heldout/runs.log.`);
  appendFileSync(join(dir, "runs.log"), `RUN ${new Date().toISOString()}\n${lines.join("\n")}\n\n`);
  console.log(lines.join("\n"));
} else { console.error("usage: npm run heldout -- pool | lock | eval"); process.exit(2); }
