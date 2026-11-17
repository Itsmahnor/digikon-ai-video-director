# Root-cause report: why the Director makes average videos

Evidence: code read in `packages/director`, `packages/rag`, `packages/templates`; a stored real session (`storage/sessions/58037c158ca7`, LinkedIn, 15 s, 4 scenes); `npm run doctor`, `eval:retrieval`, `eval:skills` run on this machine. No paid model call was made, and no new video was rendered or watched, so the picture-quality claims rest on the plan and the code, not on viewing frames.

## 1. Is RAG implemented properly?

**Yes for what it covers; it is not the cause.**
- BM25 baseline: P@1 0.81, Recall@3 0.90, MRR 0.85, 17/19 off-topic queries correctly empty.
- Skills hybrid retrieval: dev MRR ~0.70, 0 category/scope leaks, abstains on off-topic queries.
- The stored session shows playbooks, directing principles, platform specs, recipes and one skill (`promo-brand-story`) reaching the prompts.

**But RAG is not feeding the part that decides how the film looks:**

| Finding | Evidence |
|---|---|
| **476 templates are never retrieved.** "templates" is not in `COLLECTIONS` (`packages/rag/src/types.ts:3`). `@digikon/templates` is imported only by `scripts/*.mts`. Nothing in `packages/director`, `render` or `apps/console` calls `searchTemplates`. | grep: zero hits in director/render/console |
| **Skills reach the model as 3 snippets, 900 tokens.** `retrieveDirectorSkills(k=3, maxTokens=900)` (`nodes.ts:113`). 117 library skills compete for 3 slots; the 9 hand-written skill folders (40 md files) are injected whole, but they are text about *process*, not *look*. | `nodes.ts:113-115` |
| **Draft skills are hidden by default.** `SKILLS_INCLUDE_DRAFT` is unset; library skills are written as drafts and the filter drops them. Only reviewed ones show. | `.env`, `nodes.ts:29` |
| **No example-based retrieval.** `approved_examples` collection exists but nothing fills it from real good outputs. | `scopes.ts:7` |

## 2. Root causes, ranked

1. **The creative ceiling is the renderer vocabulary, not the plan.** The stored plan is good (clear hook, concept "clutter to order", palette, 4 beats). Yet it becomes: `message_thread`, `ui_demo`, `layered_cards`, `end_card`, drawn with 3 typefaces, crossfades and one wipe. The Director cannot ask for anything outside ~15 visual blocks + 40 recipes, so every film converges on text and cards on a gradient. Good planning cannot exceed what the engine can draw.
2. **Templates, the main source of visual richness, are disconnected** (finding above). 476 validated templates sit unused.
3. **No look-and-fix loop.** The overview mentions `DIRECTOR_VISUAL_CRITIQUE`, but that name appears nowhere in the code (corrected after a later grep): the feature does not exist and must be built, not switched on. The model never sees its own frames. Single-pass generation of visuals is the weakest possible agent design; quality comes from render -> critique -> revise.
4. **No real footage or imagery.** Without user assets the film is abstract card animation. There is no stock/b-roll/image-generation source, so "enquiries piling up" is a text-bubble mock-up.
5. **Audio is robotic.** SAPI/espeak voice plus a generated bed. Viewers judge "average" within seconds of hearing it. Verified only with the demo model, never with the real Claude model.
6. **Everything is `draft`, so output is `complete_preview` only**, and the real model path (sound, default voice-over, visual critique) is unverified end to end.
7. **Over-constrained pipeline.** About 15 s, 4 scenes, max 2 revision rounds, heavy validators that send the model back to repair. Safety is valuable, but repair loops push toward the safest, plainest option.

## 3. Current flow (as built)

```
Brief+files -> Intake (probe, Whisper) -> Treatment (+art direction) -> Storyboard (visual JSON per scene)
 -> Gate 1 -> Edit plan (recipes from live registry; code fills scene-composition) -> Gate 2
 -> Editor (deterministic ops) -> Render gate -> FFmpeg / Remotion / HyperFrames per scene -> assemble + audio mix
 -> QA (technical + visual + loudness) -> MP4 + JSON reports
```
Retrieval feeds Treatment (playbooks, 3 skills), Storyboard (principles, specs, 3 skills), Edit plan (recipes per scene, principles). Templates feed nothing.

## 4. Recommended fixes, in order of impact

1. **Wire templates into the Director.** Add a `templates` collection (ingest from `packages/templates`, with look vectors), retrieve 3 to 5 per scene by purpose, energy and category, show them in the storyboard prompt as "adapt one of these". Biggest quality gain for the least work.
2. **Build visual critique** (it does not exist yet) (render a frame per scene, give it to Claude vision, one repair pass). Cap at 1 to 2 iterations for cost.
3. **Raise skill budget to 6 to 8 snippets and review the draft skills** so they can be shown; set `SKILLS_INCLUDE_DRAFT=1` for evaluation, then promote the good ones.
4. **Grow the vocabulary where it limits the look:** more typefaces (Manrope, DM Serif Display etc.), more blocks (kinetic type, device mock-ups, data charts), image/video sources.
5. **Better voice:** swap SAPI/espeak for a neural TTS (ElevenLabs, OpenAI TTS or local Kokoro/Piper) and licensed music instead of a generated bed.
6. **Build an eval set of 10 briefs scored by humans** (and a vision-LLM judge) so each change is measured, not guessed. The repo already has the eval harness; add a "looks good" rubric.

## 5. Tech-stack suggestions, with reasons

| Change | Reason |
|---|---|
| Keep LangGraph, Zod, FFmpeg, Remotion | The gate and validation design is sound and is what makes output safe and reproducible. |
| Keep pgvector + bge-small, but add a reranker (e.g. bge-reranker or Cohere Rerank) | Retrieval is already decent; the gain is in picking the *best* of top 10 for look, cheaply. |
| Use a stronger model for storyboard/critique (Opus/Fable 5.2), Sonnet for the rest | Visual judgement is where model strength shows; cost is limited to two steps. |
| Add image generation or stock APIs (Flux/Imagen, Pexels) | Removes the "all text cards" look. |
| Neural TTS | Biggest perceived-quality jump per dollar. |
| Docker is not running a DB here; env points at native Postgres :5433 | Confirm the console's start-up log says `pgvector-hybrid`, otherwise it falls back to BM25. |

## 6. Not verified
- No new film was rendered or watched in this pass.
- The real-Claude run (needs `ANTHROPIC_API_KEY` and costs money) was not made.
- The claim that no code path outside scripts uses the template library is from grep; worth a double-check by a maintainer.
