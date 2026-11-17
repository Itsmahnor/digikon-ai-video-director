# RAG re-inspection report

Date: 2026-11-06. Repo: `D:\digikon-ai-video-director`. Read-only inspection: nothing in the repo was changed, and this file is the only thing written. I ran no tests, evals or migrations. Every number below is copied from committed baseline files or from the repo's own docs, so treat it as **the repo's self-report, not re-measured by me**.

**Note on the earlier report.** `RETRIEVAL_AND_DIRECTOR_INTERNALS.md` is not in the repo or on `D:\`. The 2026-10-31 findings I compared against are in `RAG_CREATIVE_SYSTEM_AUDIT.md` (same date, section 1 "RAG, as it actually exists"). If you meant a different file, tell me and I will redo the comparison.

`/mnt/project-files/` is not reachable from this machine, so the report is here.

---

## 1. Short answer

On 2026-10-31 retrieval was BM25 only. It is now **BM25 plus vector hybrid, but only when `DATABASE_URL` is set**. Without it the console falls back to BM25. Hybrid means local `bge-small-en-v1.5` embeddings fused with BM25 by reciprocal rank fusion. Skills are the one corpus that was added and is stored in Postgres + pgvector. The Director and Editor now retrieve skills as well as recipes and notes. No Qdrant code exists.

The 2026-10-31 audit said "no embeddings, no vector search, no skills retrieval, no Postgres". Those four are no longer true. Most of the other limitations still hold (section 5).

---

## 2. What changed since 2026-10-31

Commit dates are from `git log`.

| Area | 2026-10-31 | Now | Evidence |
|---|---|---|---|
| Embeddings | none | `Embedder` interface in `packages/rag/src/embeddings.ts`. `HashEmbedder` (wording only, for tests/fallback) and `TransformersEmbedder` (loads from `storage/models` only, never downloads). Default is `Xenova/bge-small-en-v1.5` (CLS pooling, bge query instruction, q8). `chooseEmbedder` falls back to the hash embedder if no model is on disk. | `00d5b72`, `9b833ce` (2026-11-03); the model folder is present under `storage/models/Xenova` |
| Hybrid ranker | none | `HybridRetriever` (`hybrid.ts`): BM25 list + vector list, eligibility filters applied to both, RRF k=60, `min_similarity`, optional MMR variety and a no-repeat penalty from usage history. | same commits |
| Vector store | none | pgvector. Migration `0001` creates `template_embeddings`, `0002` creates `skills` and `skill_embeddings`, `0003` adds topic/scope. Search is `1 - (vector <=> $q)` ordered by distance (`db/store.ts`). Real server: native PostgreSQL 16.15 + pgvector 0.8.7 on localhost:5433; the integration test passed 7/7 there and on PGlite, per `docs/HANDOFF.md`. | `361fe95` (2026-11-03), `333ece5` (2026-11-04) |
| Skills | files, loaded by a fixed step-to-skill map, not retrieved | 117 skills in `examples/skills/*` (digikon-original 48, heygen-hyperframes 24, creatify 8, shotcraft 12, etc.), imported through a licence gate into Postgres, with category / topic / scope / platform / status filters. `skills` is now a retrievable collection in both agents' scopes. The static `skills/` folder (41 files) is still loaded by `SkillLibrary` as before. | `04cf77b` to `78c6298` |
| Skill status | all draft | 111 `approved` (Digikon, 2026-11-04), 6 skimmed-source skills still `draft`. Approved/reviewed are retrieved by default, draft only with `SKILLS_INCLUDE_DRAFT=1`. The review checks were run by the agent that wrote the skills (HANDOFF says so). | `78c6298` |
| Off-topic floor | none | A query that matches no distinctive word returns nothing, for the `skills` collection only (`skills-defaults.ts`: BM25 idf-coverage floor 0.2, `min_similarity` 0.6, `require_keyword`). | `97b0c4c` |
| Console wiring | BM25 index built once at start | `server.ts` builds a DB-backed hybrid retriever when `DATABASE_URL` is set (`createDbBackedRetriever`), else BM25 with the same skills floor. The retriever is rebuilt per request so the capability registry's implemented/validated sets are never stale. If the database is unreachable it falls back to BM25 with skills from files. | `3dec06c`, `server.ts:38-68` |
| Template library search | n/a | `searchTemplates` (`packages/templates/src/search.ts`): hard filters, hybrid over the stored text embeddings, MMR, no-repeat from `template_usage`. The library has 479 files under `templates/`; the 476 look vectors are CLIP embeddings of rendered frames. | `docs/TEMPLATE_LIBRARY.md` |
| Template picker (E4) | n/a | `GET .../scenes/:sceneId/templates` returns 3 to 5 retrieved options per scene; a pick is stored as a hint to the edit plan only, while Gate 1 is waiting. It queries `shot_recipes` through the shared retriever, not the template library. | `8d812e6`, `template-picker.ts`, `app.ts:995` |

Unchanged: the 14-note knowledge base, 40 recipes, the `Retriever` interface, agent scoping, the Editor being deterministic with an optional advisory model review, and the gates.

---

## 3. Current retrieval architecture (verified in code)

**Retrievers**
- `KeywordRetriever` (`keyword.ts`): BM25 k1 1.5, b 0.75, title weighted double, simple suffix stripper and a 22-word stop list. Eligibility filters (status, grade, topics, recipe type, aspect, duration, energy, media, implemented, per-project facts, skill category/scope) run before ranking.
- `HybridRetriever` (`hybrid.ts`): wraps the above and adds vectors (details in section 2).
- `createDbBackedRetriever` (`db-retriever.ts`): non-skill documents (recipes, notes) are embedded once at start-up into an in-memory index. Skill vectors come from pgvector. A composite index merges both by score.
- No Qdrant, no Elasticsearch, no cross-encoder reranker. `types.ts:98` still has a stale comment about a "Qdrant implementation".

**What is indexed**

| Collection | Content | Vectors |
|---|---|---|
| `directing_principles` | 9 notes | in memory, at start |
| `ad_playbooks` | 5 notes | in memory |
| `platform_specs` | **0 docs** (README only; unverified specs are never retrievable) | none |
| `approved_examples` | **0 docs** (no folder) | none |
| `shot_recipes` | 40 recipes, one doc per recipe | in memory |
| `brand_product_facts` | built per project at runtime; BM25 only | none |
| `skills` | 117 (111 approved, 6 draft) | pgvector (`skill_embeddings`) |
| template library | ~476 templates (479 files) | pgvector text + look vectors, **not read by the Director or Editor** |

Each markdown file or recipe is one document. There is still no chunker. Skills average small enough that this is tolerable, but I did not measure the skill sizes (my size command failed), so treat that as unverified.

**Eligibility filters:** unchanged in kind, with additions for skills (`category` returns that category plus `all`, never another specific category; `skill_scope` director/editor/both).

**Agent scoping:** `ScopedRetriever` still enforces per-agent collections and topics, and logs every query and returned id. `skills` was added to both scopes.

---

## 4. How the Director and Editor use retrieval now

| Step | Retrieval | Source |
|---|---|---|
| Intake | brand facts, indexed per call (BM25) | `nodes.ts:149` |
| Treatment | `ad_playbooks` (k 4, with pinned policy notes) + **skills** for the project's `video_category` (k 3) | `nodes.ts:252-253` |
| Storyboard | `directing_principles` (k 4), `platform_specs`, skills (hook + beats + pacing query) | `nodes.ts:305-308` |
| Scene recipes | per scene, `shot_recipes` by type (transition, camera, animation) with aspect/duration/energy/media filters, plus sound cues | `nodes.ts:408-418` |
| Edit plan | `directing_principles` (k 4) | `nodes.ts:473` |
| Editor (`planEditorWork`) | `directing_principles` per operation type, `platform_specs`, **skills** (editor/both scope) | `editor-agent.ts:197-208` |
| Template picker (UI, Gate 1) | `shot_recipes` through the live retriever; result is a hint only | `template-picker.ts` |

Ids of everything retrieved are recorded as citations and appear in handoff provenance. Skills used are included.

Still true: retrieval is **once per film step, not per scene, for notes and skills**. Only recipes are queried per scene. The Editor's retrieved text only feeds the optional advisory model review. It does not change any operation. The console's Editor route still runs `runEditor` without a model unless the stub (demo) or `EDITOR_MODEL_REVIEW=1` is on.

Not wired: `searchTemplates` and the 476-template library. A grep finds callers only in `scripts/templates.mts` and tests. The commit history says the Director picks recipes, not library templates.

---

## 5. Evals and benchmark results

All figures are from committed baselines (written 2026-11-03 and 2026-11-04). Not re-run by me.

### Step 2B: BM25 vs hybrid on the knowledge and recipe corpus (`evals/baselines/hybrid-vs-bm25-Xenova-bge-small-en-v1-5.md`)

124 queries (98 retrieval, 19 negative, 7 missing-knowledge), `min_similarity` 0.65:

| | BM25 | hybrid |
|---|---|---|
| P@1 | 0.806 | 0.816 |
| R@3 | 0.898 | 0.898 |
| MRR | 0.853 | 0.859 |
| nDCG@3 | 0.859 | 0.863 |
| negatives answered empty | 17/19 | 17/19 |

On the paraphrase queries hybrid does better (P@1 0.643 to 0.750). On scene-level queries and `shot_recipes` it is a bit worse (P@1 0.839 to 0.806). So over the knowledge and recipe corpus **hybrid is only marginally better than BM25**, and `min_similarity` sets how well it rejects negatives (0.5 gave 10/19, 0.6 or higher gave 17/19). These queries were mostly written for a corpus of 54 docs, with no `platform_specs`, `approved_examples` or `brand_product_facts` queries (those groups have zero retrieval queries).

### Skills benchmark (`evals/baselines/skills-hybrid-vs-bm25-*.md`)

117 skills, all queries run with `include_draft` for benchmarking. Independent set of 85 queries (42 dev, 43 test), written from the taxonomy without reading skill text, plus the 51 older queries written alongside the skills. Independent TEST half (n=37 scored):

| retriever | P@1 | MRR | nDCG@3 | off-topic empty |
|---|---|---|---|---|
| BM25, no floor | 0.486 | 0.620 | 0.582 | 1/6 |
| BM25 + idf floor | 0.486 | 0.572 | 0.582 | 6/6 |
| hybrid, no floor | 0.622 | 0.735 | 0.740 | 1/6 |
| **hybrid + keyword floor (shipped default)** | 0.622 | 0.704 | 0.686 | 6/6 |

Hybrid beats BM25 clearly on the independent skills queries (P@1 0.62 vs 0.49). On the older 51-query set they are about equal (MRR 0.899 vs 0.895). Over all independent queries the shipped default answers 9/12 off-topic queries with nothing. The "category and scope leakage" check reports 0 leaks.

Caveats the repo states itself, and I agree with them:
- The shipped default was chosen after looking at test numbers, because the dev-selected configuration over-fitted. The figures are indicative.
- The queries and the skills were written by the same agent family.
- The floor is a keyword-coverage rule. A word that really occurs in a skill can let an off-topic query through.
- The database path gives identical numbers to the file path on `eval:skills:db` (HANDOFF A1), tested on one local server.
- The benchmark measures retrieval, **not whether the retrieved skills improve plans or films**. No such evaluation exists.

---

## 6. Which earlier limitations still hold

| 2026-10-31 limitation | Status now |
|---|---|
| Lexical only, misses paraphrase | **Fixed with `DATABASE_URL`**, still BM25-only without it (default dev run, all test suites, `director/cli.ts`, and `scripts/creative-diversity.mts` use `KeywordRetriever`). |
| 14-note knowledge base | **Holds.** 9 + 5 notes, unchanged. |
| No platform specs | **Holds.** README only. Director and Editor query `platform_specs` and always get nothing. |
| No approved examples | **Holds.** No folder. |
| No real chunking | **Holds.** |
| No per-scene note retrieval | **Holds.** Per-scene retrieval is recipes only. |
| No skill retrieval | **Fixed** (117 skills, scoped, filtered, cited). Static `skills/` map is still used alongside. |
| Brand facts via a throwaway per-call index | **Holds.** BM25 only, no vectors. |
| No retrieval benchmark beyond 21 queries | **Fixed**: 124 queries (knowledge/recipes) and 85 + 51 (skills). Several collections still have no queries. |
| Editor retrieval does not change anything | **Holds.** |
| No Postgres | **Fixed** (migrations 0001-0003, real server tested locally). |
| No visual-reference retrieval | **Partly fixed**: look vectors (CLIP) exist for ~476 templates but nothing in the Director/Editor path queries them. |
| Qdrant not implemented | **Holds**, and nothing needs it at this corpus size. |

---

## 7. Current limitations (verified or inferred; marked)

1. **Hybrid is opt-in.** Without `DATABASE_URL` everything runs BM25 (verified in `server.ts`). Every test, the CLI and the creative-diversity script construct `KeywordRetriever` directly, so the default developer path never exercises the vector code. HANDOFF says what remains unproven: a full Director run through the database-backed retriever with a real model.
2. **No ANN index.** `skill_embeddings.vector` is an untyped-dimension `vector` column with no HNSW or IVFFlat index (verified in migration 0002 and 0003), so every search is an exact scan. At 117 skills that is fine and not a bug. It will not scale to thousands without a fixed dimension and an index. Inferred.
3. **Vector search is post-filtered.** `nearestSkills` takes top-k by distance and eligibility is applied afterwards in `HybridRetriever`. With a strict filter, relevant docs below the k cut-off can be lost. Fine at this size. Inferred from the code path.
4. **The content gap matters more than the ranker.** `platform_specs` and `approved_examples` are empty, and the notes corpus is 14 documents. A better ranker cannot fix missing content.
5. **Recipes are all draft unless validated** (40 of 40 draft in the 2026-11-03 baseline), so production retrieval without `include_draft` returns none. The capability registry's implemented/validated sets change what is boosted. The retriever is rebuilt per request to follow them, which re-runs BM25 index construction each time (cost not measured).
6. **Recipe-in-memory vectors are computed at start-up** (local ONNX on CPU). Start-up time with the model loaded was not measured.
7. **Template library is not in the loop.** Roughly 476 templates and their search exist but the Director and Editor never call `searchTemplates` (verified by grep). The template picker uses recipes instead.
8. **Skills retrieved once per step, not per scene**, and all skill text goes into the prompt up to a token cap (700 to 900 tokens). Nothing evaluates whether skills change plan quality.
9. **Eval weaknesses.** Skills benchmark authored by the same agent family as the skills. Default chosen after seeing test numbers. Small test halves (37 and 43 queries), so differences of a few points are noise. Step 2B has no queries for three of six collections.
10. **Retrieved text is reference data, not instruction.** The code and docs enforce this and I saw no sign it is bypassed, but I did not test a prompt-injection attempt via a skill body. Skills from third-party repos (heygen, creatify, etc.) are condensed adaptations under their licences. Reviewed by the writing agent, then approved by Digikon.
11. **Stale comment** at `packages/rag/src/types.ts:98` mentions Qdrant. Harmless but misleading.
12. **Not verified by me:** that the tests pass, that hybrid retrieval works on the current working tree, and the exact skill file sizes. `git status` showed no uncommitted files when I finished, which differs from the snapshot at the start of this session, so the work has since been committed.

---

## 8. Recommended next steps (in priority order)

1. **Fill the content gap first.** Write verified `platform_specs` (the Director and Editor already query them and get nothing) and a handful of `approved_examples`. Per-collection retrieval queries for these should be added to the benchmark at the same time. This is likely the highest value-for-effort item.
2. **Make hybrid the tested default.** Run the existing test suites and one Director demo against PGlite (already used in tests) so the vector path is covered by default, not only when `DATABASE_URL` is set. Keep BM25 as the fallback.
3. **Measure the effect on output, not just ranking.** Run the same briefs with skills off vs on (stub or a funded real run, only if Digikon allows spend) and compare plans against an agreed checklist. The retrieval benchmark cannot show whether skills help.
4. **Write a held-out benchmark that the skills' author did not write** (a human, or a different process), including multi-collection and per-scene queries, and re-confirm the default `min_similarity` and floor. Report with larger test halves.
5. **Add per-scene skill and note retrieval**, if step 3 shows skills help. Only recipes are per scene today.
6. **Decide what the template library is for.** Either wire `searchTemplates` into the picker or the Director (hint-only, gates untouched), or record that it is deliberately separate.
7. **Before the corpus grows**, give the vector column a fixed dimension, add an HNSW index, and move eligibility filtering into SQL or over-fetch. Not needed at current size.
8. **Housekeeping:** remove the stale Qdrant comment; consider caching the per-request BM25 index build.

Nothing here needs Qdrant or a different vector database at the current corpus size.
