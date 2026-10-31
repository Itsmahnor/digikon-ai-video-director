# Digikon RAG & Creative System Audit

Date: 2026-10-31. Repo: `D:\digikon-ai-video-director`. Audit only: nothing in the repo was modified, installed, run or migrated. This file is the only artifact created.

## How this was done, and what it can and cannot support

- Method: static reading of source, recipes, skills, knowledge, contracts, docs and evidence files. The device shell was unavailable (the Linux VM would not start), so **no test, typecheck, eval or render was run by me.** Where the repo's own docs say "1078 tests pass / eval 16/16 / 7/7 capabilities", I report that as the repo's self-report: **Not verified**.
- Files read in full or in the relevant part: everything in `packages/rag/src`, `packages/director/src/{skills,llm,editor-agent,asset-match,store,graph}.ts` and the retrieval/gate parts of `nodes.ts`, `packages/recipes/src/library.ts`, `packages/media/src/{vision,ocr,understand,inspect,analysis,asset-registry}.ts`, `packages/contracts/src/{visual,recipe,schemas,assets}.ts`, parts of `packages/render/src/*`, `apps/console/src/{server,app}.ts` (grep plus the editor and render routes), `docker-compose.yml`, `.env.example` (the real `.env` was deliberately not opened), `package.json` files, `docs/{assets,quality}/PROGRESS.md`, `docs/assets/evidence/delivery.json`.
- Not read in depth: `Compositions.jsx`, most of `render/src`, `app.ts` bodies, and test files. Statements about them rely on names, grep results and docs, and are marked.
- Status legend: **Implemented** (code present and wired into the running path), **Partial**, **Not implemented**, **Not verified** (exists or is claimed, but I could not confirm it works).
- **Uncommitted-work warning:** the repo's own progress notes say "Nothing is committed" for the visual-quality and asset-understanding work. That is a backup/rollback risk before any upgrade starts.
- The context files named in the project (CLAUDE.md, DIGIKON_CONTEXT.md) are not in the repo; `docs/quality/PHASE1_AUDIT.md` says the same.

---

## 1. Existing architecture

Monorepo (npm workspaces): `apps/console` (Hono server plus browser UI), and packages `contracts`, `rag`, `recipes`, `director`, `router`, `speech`, `media`, `render`, `qa`, `evals`.

Flow: brief and uploads → `media` analysis (ffprobe, Whisper, image understanding) → LangGraph Director (`packages/director/src/graph.ts`): intake → treatment (with art direction) → storyboard → **human gate 1** → edit plan → **human gate 2** → handoff (hash-sealed) → `runEditor` (deterministic checks) → render plan → render (Remotion 4.0.539, HyperFrames 0.8.207, FFmpeg) → frame-level verification and visual QA → delivery status.

LLM: `AnthropicClient` (`claude-sonnet-5-5` default) in `packages/director/src/llm.ts`, one structured-output call per Director step.

### RAG, as it actually exists

| Question | Finding | Status |
|---|---|---|
| Retriever | `KeywordRetriever` in `packages/rag/src/keyword.ts`: BM25 (k1 1.5, b 0.75) over title (doubled) plus text, with a crude suffix stripper and stop list. Built once at start in `apps/console/src/server.ts:38` from `recipeDocs(...) + loadKnowledge(...)`. | Implemented |
| Interface | `Retriever { retrieve, get }` in `types.ts`. Comments mention a Qdrant retriever "that must beat BM25", but no such code exists. | Implemented (interface); Qdrant Not implemented |
| Collections | 6 declared: `directing_principles`, `ad_playbooks`, `platform_specs`, `shot_recipes`, `brand_product_facts`, `approved_examples`. | Implemented |
| Actual content | `knowledge/directing_principles` 9 notes, `ad_playbooks` 5 notes (each 400-640 bytes), `platform_specs` **only a README, so zero retrievable docs** (specs need `verified: true`), `approved_examples` **no folder, zero docs**, `shot_recipes` 40, `brand_product_facts` built per project at runtime (`nodes.ts:121`). | Partial: very thin corpus |
| Chunking | None. One markdown file is one doc; one recipe JSON is one doc (`docs.ts`: "one recipe is one chunk"). Notes are small enough that it does not matter today. | Not implemented (no real chunker) |
| Embeddings | None anywhere in `rag`. (CLIP and Florence-2 exist in `media` for images only.) | Not implemented |
| Vector search | None. | Not implemented |
| BM25/keyword | Yes, as above. | Implemented |
| Metadata filters | Real eligibility rules applied before ranking: draft/reviewed status, grade, topics, recipe type, aspect ratio, duration, energy, media, `implemented_only`, per-project facts. An "implemented" boost of 1.15 prefers recipes with a validated template. | Implemented |
| Agent scoping | `ScopedRetriever` (`scopes.ts`): Director and Editor see different collections and topics; every query and returned id is logged to `RetrievalRecord`. | Implemented |
| Skills | `skills/` has 8 top-level skills plus `skills/editor` (10 sub-skills, `MANIFEST.json`). `SkillLibrary` loads a **fixed** step→skills map (`STEP_SKILLS`, `STEP_REFERENCES` in `skills.ts`) and puts whole bodies in the system prompt. Skills are **not retrieved**; they are statically routed. | Implemented (static routing); skill retrieval Not implemented |
| Results to Director | Yes. `nodes.ts` runs `retrieve`/`retrieveWithPins` and formats hits into the user prompt for treatment, storyboard and edit plan (pinned policy notes are forced in). | Implemented |
| Scene-level retrieval | **Recipes only.** Per scene, `nodes.ts` (about lines 274-292) queries `shot_recipes` by scene purpose/transition, camera motion, overlay text, with filters for aspect, duration, energy and media. **Knowledge notes are retrieved once per film step, not per scene.** | Partial |
| Results to Editor | `planEditorWork` retrieves `directing_principles` using one fixed query per operation type (`KNOWLEDGE_QUERY`) and `platform_specs`. Results are recorded as provenance and fed only to the optional LLM review. They do not select or change anything. | Partial (see section 3) |
| Retrieval quality evidence | `evals/retrieval.json` has 21 hand-written queries with expected ids. The repo says the eval passes 16/16, but that eval ran in demo mode and measures the pipeline, not Claude. | Not verified |

Current RAG limitations, in short: lexical only (misses paraphrase), a 14-note knowledge base with no platform specs and no approved examples, no per-scene note retrieval, no skill retrieval, no retrieval of visual references, brand facts retrieved by a throwaway per-call index, and no retrieval-quality benchmark beyond 21 queries.

---

## 2. Fully implemented features (code present and in the running path)

- Two human approval gates with plan hashes and evidence hashes: `graph.ts` interrupts, `approvals.ts`, `contracts/approval.ts`; render is refused unless both approvals match current plans (`checkRenderable`, `verifyHandoffWithStore`). *Behaviour not run by me, but the structure is unambiguous.*
- Evidence-grounded claims discipline (`claims-register`, claim validation in contracts/validate).
- BM25 retrieval with eligibility filters and agent scoping (section 1).
- Recipe library loading and validation (`recipes/src/library.ts`, `validate.ts`), parameter resolution, readiness by review record.
- Structured art direction and scene visuals: `ArtDirection` with WCAG-checked palette (`contracts/visual.ts`), 8 visual blocks, validated bounded text.
- Rendering through Remotion (data-driven `scene-composition`, `render/remotion-compositions/Compositions.jsx`), HyperFrames (HTML/CSS keyframes) and FFmpeg (xfade transitions, image scenes, clip play).
- Real-render capability learning/registry (`render/src/capabilities.ts`, `capabilities/registry/*`, `capabilities/visual/*`) and frame-based verification (`composition-verify.ts`, `transition-checks.ts`, `qa/src/visual.ts`, `delivery-status.ts`).
- Image understanding (local): see section 12.
- Uploaded images appear in renders: `docs/assets/evidence/delivery.json` records 6 `asset_validation` checks with verdict `visible`, overall `complete_preview`. That is one project's evidence, produced by the repo owner's run.

## 3. Partially implemented features

- **Editor Agent.** `runEditor` (`director/src/editor-agent.ts`) is a deterministic converter and checker: one typed operation per approved recipe use, conflicts, revision requests, execution report. A model call exists only as an optional advisory `modelReview` (one structured `editor_review` generate call). The console route `POST /api/sessions/:id/editor` (`app.ts` ~line 828) calls `runEditor` **without `llm`**; its own comment says "no model is called". So a Sonnet Editor is **not wired** (confirmed).
  - Tools: none. `AnthropicClient.generate` registers a single structured-output tool and uses `tool_choice: auto`; there is no tool loop (no search_templates, no inspect_asset).
  - Retrieves skills/templates: skills are loaded by name and versioned into provenance; template/recipe selection is made earlier by the Director (and later by the render selector), not the Editor.
  - Analyses actual assets: no. `planEditorWork` says it does not look at any file; it checks declared rights and hashes.
  - Scene-specific creative decisions: not in the Editor. They happen in the **Director's** treatment/storyboard/edit-plan steps (Sonnet is wired there). The Editor cannot reconfigure templates; parameters come from the approved plan.
  - Approved plans and gates: respected strongly (refuses unverified handoffs, never changes the plan, `rendered` always false).
- **Scene-level retrieval**: recipes yes, notes no.
- **Asset-to-scene matching**: `director/src/asset-match.ts` is suggest-only and conclusive only when a human has reviewed the picture; the Director LLM separately assigns pictures from the image manifest.
- **Video understanding**: ffmpeg measurements only (section 12).
- **Template validation and preview**: strong for what exists (above); previews are explicitly labelled "not production-ready" because recipes are `draft`/review evidence is missing (delivery status `complete_preview`).
- **Template ecosystem breadth**: see section 5.

## 4. Missing features (Not implemented)

- Embeddings, vector search, hybrid ranking, rerank.
- Real chunking and per-section retrieval.
- Skill/reference retrieval on demand; scene-level knowledge retrieval.
- Any `platform_specs` and `approved_examples` content.
- Editor model loop with tools; Sonnet in the console's Editor route.
- Visual understanding of video keyframes (they are extracted but never classified; `keyframe_refs` are stripped from the storyboard prompt at `nodes.ts:235`).
- Brand identification (which logo is it); product recognition beyond a generic label.
- Postgres usage of any kind (section 7).
- Particles, 3D, Lottie, shape morphing, motion blur, colour grading, stock/generated imagery, icon library, maps, more than 2 chart types, more than one typeface (renderer has one font file; weight regular/bold only).
- Transitions beyond 5 contract values; tilt camera recipes (contract allows `tilt_up/down`; I found no recipe for them, **Not verified** for the renderers).

---

## 5. Template ecosystem (audit task 2)

**Actual files:** `recipes/` contains **40 JSON recipes**: animation 20, camera_move 7, shot 4, transition 6, sound_cue 3. Plus 8 visual blocks inside one recipe and 18 registry capability records (ffmpeg 2, hyperframes 6, remotion 10) and 7 `capabilities/visual` records.

**Families vs variants.** Many files are the same behaviour for a different engine or a trivial rename (e.g. `text-fade-up`, `text-fade-up-hyperframes`, `text-fade-hyperframes`, `text-card-fade`; `slow-push-in` and `-hyperframes`; `image-caption-remotion/-hyperframes`; `asset-stage-ffmpeg/-hyperframes`). Grouping by behaviour, not engine, my estimate is **about 29 distinct families** (a judgment; the repo has no `family` field, which is itself a finding):

- Text/graphics (13): text fade-up, word stagger, text card, text slide, title-subtitle, bullet list, stat callout, lower third, logo reveal, end-card CTA, image scene/caption, asset stage, scene-composition.
- Camera (4): slow push-in, pull-out reveal, pan reframe, punch-in.
- Shot (3): clip play (with caption), crop-to-detail, static hold.
- Transition (6): hard cut, crossfade, dip-to-black, directional wipe, J-cut audio lead, match-cut.
- Sound (3): music duck, SFX on cut, loudness normalise.

Inside `scene-composition`, the real creative breadth lives as 8 data-driven blocks: message_thread, ui_demo, process_flow, data_chart, kinetic_type, layered_cards, end_card, asset_stage.

**Metadata:** recipe schema (`contracts/recipe.ts`) has type, operation_type, intents, parameters (number/enum/string/boolean with ranges), constraints (duration, energy, uses per film), compatibility (aspect ratios, media types), validation rules, source/licence, status draft/reviewed, review record. No family, tags, mood, or taxonomy field.

**Animation types available:** image animations 9 (none, fade_in, scale_in, slide_up, ken_burns_in/out, pan_left/right, zoom_to_region; **Remotion only for most**, FFmpeg supports none/fade_in/slide_up, HyperFrames adds scale_in); kinetic text 3 (slide_stack, word_pop, mask_rise); reveals 4 (none, wipe_right, wipe_up, iris); backdrops 4; ease 3 (ease_out, ease_in_out, spring); chart 2.
**Transitions:** cut, match_cut, crossfade, dip_to_black, wipe (plus xfade variants learned for ffmpeg).
**Camera:** contract 7 motions (static, slow_push_in, pull_out, pan_left/right, tilt_up/down); drawn camera in visual blocks 5 (static, push_in, pull_out, pan_left/right).
**Integrations:** Remotion 4.0.539 + React 19.3.1 (Implemented), HyperFrames 0.8.207 (Implemented, smaller template set), FFmpeg (Implemented; concat, xfade, image/clip scenes).
**Validation/preview:** recipe validator, render-plan checks, per-scene frame verification, transition checks, visual QA log, delivery decision. Implemented; effectiveness beyond the repo's own evidence **Not verified**.

**Missing visual capabilities:** see section 4. Also visual diversity risk: the "scene variety" is capped by 8 blocks, 3 kinetic styles and one font.

---

## 6. Asset intelligence (audit task 4), the numbers behind section 12

| Capability | Finding | Status |
|---|---|---|
| Image classification | Local CLIP (`Xenova/clip-vit-base-patch32`, q8, CPU) zero-shot against 11 prompt groups, then rule adjustments (`vision.ts` `decideCategories`); below 0.35 confidence it says unknown. Model weights present in `storage/models`. | Implemented |
| Logo recognition | Only "looks like a logo" (CLIP) plus "carries words" (OCR). No brand identity, no logo-vs-reference matching. | Partial |
| Product image recognition | Generic `product_photo` label only; no product identity. | Partial |
| OCR | Windows Media OCR via PowerShell script, or Tesseract if installed (`ocr.ts`). Machine-specific; if neither is present, status becomes `unavailable` and the analysis is `partial`. | Implemented (Windows); portability Not verified |
| Image descriptions | Local Florence-2-base-ft caption plus objects. | Implemented |
| Video analysis | ffmpeg: silence, black, freeze, scene cuts, loudness, keyframes (`analysis.ts`); Whisper transcription. | Implemented (measurement only) |
| Keyframe understanding | Keyframes extracted; not classified/described; not shown to the Director. | Not implemented |
| Asset-to-scene matching | Director LLM from manifest plus `asset-match.ts` suggestions; human review required for certainty. | Partial |
| Real images in renders | Yes (evidence above); mandatory-asset visibility checked per scene. FFmpeg/HyperFrames asset stages support fewer animations than Remotion. | Implemented |

Weak/untested: base-size zero-shot models are coarse; 11 categories; evidence is essentially one real run (`docs/assets/evidence`); a scene (S06) was once refused/placeholder in `capabilities/visual/qa-log.jsonl` (VQ01) and later fixed per the repo notes; no multilingual OCR evaluation; no dataset to measure classification accuracy.

---

## 7. Database readiness (audit task 5)

- `docker-compose.yml`: service `postgres` using `postgres:16` (plain, **no pgvector**), user/db `digikon`, bound to `127.0.0.1:5432`, volume `pgdata`. `npm run db:up/db:down` exist.
- `.env.example` has `DATABASE_URL`, `STORAGE_DRIVER=local`, `STORAGE_LOCAL_DIR`.
- **Nothing uses Postgres.** No `pg`/ORM dependency in any `package.json`, and no source file references `DATABASE_URL` or `postgres` (the only repo hit is the `db:up` script in the root `package.json`).
- Actual persistence: JSON files under `storage/` (`sessions`, `assets`, `reviews`, `models`, `test-renders`). `RunStore` (`director/src/store.ts`) writes atomically with fsync, versioned checkpoint/handoff envelopes, refuses malformed files. LangGraph uses `MemorySaver` (in-memory) plus the custom checkpoint file. `capabilities/registry` is hash-sealed JSON. The asset registry (`media/src/asset-registry.ts`) is a project-scoped registry; its on-disk format **Not verified**.
- pgvector: not installed, not configured. Nothing was installed.

**Feasibility of Postgres + pgvector: High technically, but low urgency.** Swapping the image to `pgvector/pgvector:pg16` is a drop-in for the existing volume, and `CREATE EXTENSION vector` works on the same major version. The current corpus is about 54 documents (+ per-project facts), so a flat in-memory cosine index would be as fast as pgvector. pgvector earns its place only with growth (many projects, approved examples, per-asset embeddings) and for hybrid SQL filtering. Recommendation: put embeddings behind the existing `Retriever` interface first (no DB), keep indexes as cache files, and adopt Postgres later for records that benefit from queries.

**Migration/compat risks:** approval and handoff integrity depends on content hashes of plans; moving sessions into rows must preserve byte-stable canonical JSON or old approvals become "stale". Checkpoint version mismatch is refused by design (`graph.ts`), so old runs will not auto-migrate. The Windows host path assumptions (`C:\Windows\Fonts`, PowerShell OCR) matter if the stack ever runs in Docker/Linux. `.env` holds secrets and must stay out of anything shared.

---

## 8. GitHub resource audit (audit task 6)

**Limitation, stated plainly:** GitHub API/MCP/tarball access to these five repos was denied in this session (they are not attached repos), and I did not add them without your approval. Only individual files reachable at guessed raw paths could be read. Directory trees, file counts, stars, open issues, last-commit dates and full-source security scans are therefore **Not verified for all five.** What follows is from files actually fetched.

| Repo | What was actually read | License | Dependencies | Fit |
|---|---|---|---|---|
| `degueba/onda` | README, package.json, LICENSE, `scripts/sync-registry.mjs`, `remotion.config.ts` | MIT (verified file). Clash Display / Space Grotesk fonts: Clash Display is Fontshare, not OSS, **check font terms**. | React ^19, remotion ^4.0.466 (authored below 4.0.539; needs a pin test), zod ^3.23, zod-to-json-schema | **Best fit.** README says each component ships a Zod schema and defaultProps (maps to your JSON-props contract). Claimed 70 components + 18 transitions: README only. Entrance components look like near-variants. Copy source by hand; do not run its `npx ondajs add` registry CLI (unreviewed remote download). |
| `remotion-dev/skills` | README, package.json, one SKILL.md router | **Not verified** (no LICENSE at root paths tried) | version 4.0.539, matches your baseline; no install scripts | Good as version-matched guidance. 8 skills, guidance docs, not templates. Check the license before copying text. |
| `Liamrjohnston/remotion-motion-graphics-skill` | README, LICENSE, one SKILL.md, `promptible-gate.mjs` | MIT, but bundled third-party brand logos are not covered by MIT | No root package.json | Policy ideas only (fail-closed gate, provenance). Advertises `curl \| bash install.sh`; **unread, treat as risky.** Interactive intake and fixed resolutions conflict with your contract. |
| `ssuuppeerrmmaann/remotion-graphic-templates` | README, package.json, LICENSE, imports of Root.tsx | MIT (mirror of `lifeprompt-team/remotion-scenes` per package.json) | React ^18, remotion ^4.0.0, three/R3F 8 (conflicts with React 19.3.1) | Low-medium. "201 scenes" in 16 categories; likely many variants; examples take no props. Visual reference only. |
| `reactvideoeditor/remotion-templates` | README, one template file | **No LICENSE file found** at tried paths; README says MIT with non-standard attribution wording | No package.json | Do not copy until the license is clarified. 81 claimed templates (README); real family count Not verified. |

Security review depth: none of the five had source scanned beyond the files above. Standing rule for any adoption: read source before copying, no install scripts, no remote registry CLIs, no render-time network assets.

---

## 9. Existing files and modules worth reusing

`packages/rag/src/{types,keyword,scopes,docs}.ts` (the interface, filters and scoping are good: build on them), `packages/director/src/{skills,store,graph,approvals,handoff}.ts`, `contracts/{visual,recipe,assets,approval}.ts`, `render/src/{composition,layout,font-metrics,asset-layers,asset-stage,capabilities,visual-capabilities,delivery-status,transition-checks}.ts`, `qa/src/visual.ts`, `media/src/{vision,ocr,understand,inspect,analysis}.ts`, `skills/editor/*` plus `MANIFEST.json`, `evals/retrieval.json` as the seed benchmark, `capabilities/visual/qa-log.jsonl` as a failure log.

---

## 10. RAG upgrade recommendations

1. First extend the benchmark: grow `evals/retrieval.json` from 21 to roughly 60 queries including paraphrases, scene-level intents and negative cases, so any change is measured against BM25.
2. Add a `HybridRetriever` behind the existing `Retriever` interface: BM25 plus local embeddings (the repo already runs `@huggingface/transformers` for CLIP/Whisper; a small sentence-embedding model fits the same cache), fused by reciprocal rank fusion. Keep eligibility filters outside the ranking as they are now.
3. Make it scene-level: retrieve notes per scene using a scene archetype (section 11), not once per film.
4. Fill the empty collections: `platform_specs` (needs `verified: true` evidence) and `approved_examples`.
5. Replace the fixed skill routing with route-plus-retrieve for skill references (keep pinned policy skills always on).
6. Add heading-level chunking only when notes grow past about a page.
7. Keep Retrieval records for replay; add a recall metric to CI.

## 11. Scene taxonomy recommendations

Add a `scene_archetype` (and `energy`, `needs_media`) to storyboard scenes and to recipe/doc metadata. Suggested set: hook, problem, solution reveal, product demo (UI), feature highlight, process/how-it-works, data/proof, comparison, social proof/people, brand moment (logo), transition beat, CTA/end card. Map each to preferred visual blocks, transitions, camera, energy, asset roles and duration bands. This turns "diversity" into a checkable rule (no more than N consecutive scenes sharing an archetype or block) and gives retrieval a stable key.

## 12. Template ecosystem recommendations

- Add a `family` and `variant_of` field to the recipe contract so counts and diversity checks are honest.
- Grow breadth inside the data-driven `scene-composition` blocks (new block types validated by zod like the existing 8), not by adding per-engine recipe files.
- Close engine gaps deliberately: decide which animations FFmpeg/HyperFrames must support or mark them Remotion-only in recipe compatibility.
- Add transitions and text styles only with real-render capability evidence (the learner already supports this).
- Promote recipes from draft to reviewed with review records, so previews can become deliverable.

## 13. GitHub resources worth adopting

First choice `degueba/onda` as a source of component patterns and schemas, after verifying fonts and pinning remotion 4.0.539 in a throwaway copy. `remotion-dev/skills` as agent guidance once its license is confirmed. Use the others for ideas only. All conclusions about contents beyond the files listed in section 8 need a second pass once repo access is granted (`add_repo` needs your approval).

## 14. Editor Agent upgrade requirements

- Decide the Editor's role: today creative decisions sit with the Director; an "Editor with tools" must not be allowed to change approved plans.
- Add a bounded tool loop (read-only first): `search_recipes`, `get_recipe`, `get_asset_manifest`, `inspect_frame`, `check_params`, with every call logged to `RetrievalRecord`-style provenance.
- Let it propose **parameter configuration within recipe ranges** and scene-level alternatives as a revision request, which re-enters gate 2 (existing mechanism: `revision_requests`).
- Wire `llm` into the console Editor route behind a flag, keep deterministic checks as the gate, keep `rendered: false` semantics.
- Add evals: golden handoffs with expected conflicts; model output must still pass `editorOutputIssues`.

## 15. Asset intelligence gaps

Describe/classify video keyframes with the existing CLIP/Florence stack and give the Director a per-clip manifest; a brand-logo reference match (user-declared logo as the reference, not recognition from a web of brands); a labelled evaluation set to measure classification and OCR; portable OCR (Windows-only engine today); stronger asset-to-scene matching using descriptions and OCR text rather than only reviewed flags.

## 16. Risks and backward compatibility

1. Uncommitted work (back up or commit before changing anything).
2. Hash-sealed approvals and handoffs: any change to recipe ids/versions, schemas or canonicalisation invalidates stored sessions; use additive optional fields (the repo already does this: `Treatment.art_direction` is optional).
3. Checkpoint version mismatch is refused, so graph shape changes strand in-flight runs.
4. `RECIPES_MODE` defaults to draft in the console; "reviewed" will hide most recipes today.
5. Windows-specific OCR and font paths.
6. New dependencies (embeddings, GitHub code) are a supply-chain and license surface; the rules in `README`/progress notes forbid new deps without approval.
7. Self-reported test counts were not re-run here.

## 17. Recommended implementation sequence

1. Commit or snapshot the current tree (your call).
2. Expand the retrieval benchmark and record the BM25 baseline.
3. Add `family`/`scene_archetype` metadata (optional fields, backward compatible).
4. `HybridRetriever` behind the interface; no database.
5. Scene-level retrieval of notes plus fill `platform_specs` and `approved_examples`.
6. Editor tool loop and flagged Sonnet review (read-only, gate-respecting).
7. Video keyframe understanding.
8. New visual blocks and transitions with real-render evidence.
9. Review adoption of `onda` patterns after repo access and font/license check.
10. Postgres/pgvector only if the corpus or multi-user needs justify it.

## Exact next implementation step

**Step 2 above, as a first, small, safe change: extend `evals/retrieval.json` to about 60 queries (paraphrases, scene-level intents, and negatives) and add a script that records BM25's baseline precision@1/recall@3 per collection.** No dependencies, no schema or storage changes, and every later RAG decision (hybrid retrieval, pgvector) is then measured against it. Prerequisite: you decide whether to commit the current uncommitted work first.
