# Updated plan (after the 2026-11-03 discussion)

Supersedes the phase list in `TARGET_ARCHITECTURE_PROPOSAL.md`. It is wired from the existing codebase and from the earlier plans (`OVERALL_ENHANCEMENT_PLAN.md`, `PHASE_STATUS.md`, `TEMPLATE_LIBRARY_RAG_DESIGN.md`, `INFRASTRUCTURE_V2.md` in the project library). Proposal only: no code changed.

## Decisions made

- First three video categories: **SaaS, e-commerce, general promotional**.
- Skills: I search public repos, check licences, and load what passes **into the Postgres + pgvector database**. You will add some skills yourself.
- Website: **read automatically** (colours, fonts, copy, logo), with a manual fallback.
- Postgres: **local (Docker) for now**, hosted later. Files stay the source of truth for sealed approvals; the database holds the retrieval index.
- Scene previews: **high-resolution and moving**, and the user sees the outcome before approving.
- Template choice by the user is **temporary**: a bridge until Director + Editor choose well enough on their own.
- Roles: **Director = what the video says** (story, claims, scenes; changes reopen Gate 1). **Editor = how it looks and moves** (animation, templates, timing, sound; changes reopen Gate 2 only).

## What already exists and gets reused

| Piece | Where | Reuse |
|---|---|---|
| Two approval gates, hash-bound production plan, render gate | `packages/director`, `render/production-gate.ts` | Kept as is. All new features sit before Gate 1 or inside the Gate 2 loop. |
| Hybrid retriever (BM25 + vectors, RRF, MMR, no-repeat), bge-small embeddings | `packages/rag` | Wire into Director and Editor (Phase B). |
| pgvector migration (9 tables), data store, ingest and dedupe | `db/migrations`, `packages/rag/src/db`, `scripts/templates.mts` | Run for real on local Docker (never run on a live DB yet). |
| Retrieval benchmark and baselines | `evals/` | The gate for "is the new corpus better". |
| Capability registry and learning | `packages/render/src/capabilities*.ts` | Keep; extend later (see "Capability learning" below). |
| Scene-graph v2 engine behind `SCENE_GRAPH` | `render/src/scene-graph` | Template data format; port remaining 11 blocks later. |
| Model gateway (budget, retries, call log) | `director/src/gateway.ts` | Wire in for cheap-model routing (Phase F). |
| Audio stage | `render/src/audio.ts` | Kept; see "Audio". |
| Per-scene render | `render/src/scene-job.ts`, assembler | Basis for per-scene previews. |

Note from `PHASE_STATUS.md`: the main checkout is on the D: PC, with template Release 1 in progress on branch `feature/templates-r1` and nothing pushed there. This H: checkout is at the same tip `c49150b`. Work in this plan must start from the D: PC branches, or those get pushed first.

## Phases

**A. Database and skills foundation (first).** Run Postgres + pgvector in Docker, apply the migration, run the integration test that has never run. Define the skills schema (category, funnel stage, platform, grade, licence, source, status). Build the importer: repo -> licence check -> normalise -> dedupe -> embed -> store. Exit: integration tests pass on a real DB.

**B. Skills corpus for SaaS, e-commerce, general promo.** Search public repos, record licence per item, import only the permitted ones, and keep the licence and origin on every record. Add your own skills. Wire the hybrid retriever into Director and Editor with per-agent scopes. Exit: the retrieval benchmark shows the hybrid + new corpus beats the BM25 baseline on category queries.

**C. Guided intake and question module.** Project-kit wizard (goal, audience, platform, brand guide, website URL, logo, images, footage, audio, facts). Website reader (colours, fonts, copy, logo) with a fallback when blocked. Readiness checklist (required / recommended / optional). Question module asks only what is missing with typed answers: upload, choice, text, Skip. Edge cases: no logo, no site, unreadable PDF, blocked scraping, wrong or huge file, user changes mind, returning user with a saved brand kit.

**D. Director shows video type and story.** Classifier proposes 2-3 video types with a one-line description and an example; the user picks; the story is written from that category's skills. Needs-analysis step produces the Gate 1 requirements sheet.

**E. Editor with previews and changes.** Temporary template picker (pick or skip). Editor model + the Editor skills. High-resolution moving preview per scene, cached by scene hash so an edit re-renders only that scene. Scene-level change requests routed by the role rule above. Re-approval at Gate 2.

**F. After full video review and optimisation.** Route post-review changes to Director or Editor, re-render only what changed. Gateway: cheap model for classification and checks, strongest model for the story. Cache and outcome logging.

**G. Later.** Template library Releases 2 and 3, scene-graph blocks port, generative composition.

## Capability learning, in plain words

It is the system's way of proving a building block really works before it is used. For a block such as a transition or text animation, it renders a small test with the real renderer, runs automatic checks on the result, and only then saves a validated record in `capabilities/`. If a planned film needs a block that has no record yet, the render step tries to learn it first. It does not write new code, and it does not make the final video. Gaps today (from the earlier review): the catalogue is hard-coded, it checks one aspect ratio per block, and re-checking after a version change is manual.

## Audio

Yes, a film can have sound. The audio stage plans music, sound effects and narration from what the approved storyboard asks for, and FFmpeg mixes it under the finished picture. Music and effects are synthesised locally; narration comes from a recording you supply or the machine's own speech synthesiser. Anything it cannot make stops Gate 2 rather than being dropped, and generated sound is labelled as generated. Limits: it is basic (no licensed music library, no beat sync) and needs licence or provider decisions (open decision 3 in `PHASE_STATUS.md`).

## Open items

1. Which public repos to take skills from, and whether template repos count (see the chat reply for candidates and licences).
2. Anthropic credit or another provider is still a blocker for model-dependent steps (needs-analysis, Editor model).
3. Fonts and music licences.
4. Whether to push the D: PC branches so work can continue from one place.

## Audio and fonts: what I will use (researched 2026-11-03)

Licences below were checked against the GitHub / Hugging Face metadata of each project where marked "checked". Everything else comes from secondary articles and must be re-checked on the official page before shipping. This is not legal advice. Every imported file or model gets its licence, source and date stored in the database.

### Narration (voice)

| Choice | Licence | Decision |
|---|---|---|
| **Kokoro-82M** (`hexgrad/kokoro`) | Apache-2.0 (checked: GitHub and Hugging Face) | **Use as the main voice.** Small, runs on CPU, local, no cost per film. Can run through the `@huggingface/transformers` stack the repo already uses. About 54 voices, 8 languages. Fixed voices, no cloning. |
| Windows SAPI / espeak | OS | **Keep as fallback** (already in `audio.ts`). |
| **Chatterbox** (`resemble-ai/chatterbox`) | MIT (checked) | **Later, optional:** voice cloning for a brand voice, only with the user's recorded consent. |
| Piper | engine MIT (old repo) / GPL-3.0 (new repo) (checked); each voice has its own licence | **Do not use** unless one voice's licence is verified; the GPL engine is a risk. |
| XTTS-v2, F5-TTS, Voxtral | non-commercial (secondary sources) | **Do not use.** |
| Hosted voices (ElevenLabs, etc.) | paid terms | Later, as an optional provider through the model gateway. Needs your decision and a budget. |

### Music

| Choice | Licence | Decision |
|---|---|---|
| **ACE-Step** (`ace-step/ACE-Step`) | Apache-2.0 code and weights (checked) | **Use for generated music beds**, on a machine with a GPU. Generated music is labelled as generated. Without a GPU it falls back to the existing local synthesised bed. |
| User-supplied music | user's own licence | **Keep** (already supported). The user confirms they own the rights. |
| MusicGen weights | CC BY-NC 4.0 (secondary sources, matches the model card) | **Do not use** (non-commercial). |
| Stable Audio Open | Stability Community Licence (HF says "other"): free commercially only under US $1M annual revenue, registration needed | **Do not use for now.** Possible later if you accept the revenue cap. |
| Licensed stock libraries | paid | Later, your decision. |

Open question for you: **does the machine that renders have a GPU?** ACE-Step is slow on CPU only.

### Sound effects (whoosh, hit, chime, click)

- **Use:** CC0 packs (Kenney audio; Freesound filtered to **CC0 only**) and, if wanted, Pixabay content (Pixabay Content Licence allows commercial use with no credit but not resale of the files themselves).
- **Keep:** the local synthesised effects already in `audio.ts` as the fallback.
- **Do not use:** Freesound CC-BY-NC, BBC sound effects (non-commercial).
- Each effect is a database record with licence and source, so a film's report can list what it used.

### Fonts

- **Use (all OFL-1.1, checked on GitHub for Inter, Manrope, Space Grotesk, Playfair Display):**
  - sans: **Inter** and **Manrope** (SaaS, e-commerce, general)
  - sans display: **Space Grotesk** (tech / launch look)
  - serif: **Playfair Display** (luxury / editorial look)
  - mono: **JetBrains Mono** (product / developer look; licence to be checked before adding)
- **Rules:** keep each font's licence file next to it; never modify a font and keep its name (the OFL "reserved font name" rule); do not sell the font files.
- **Video note:** the OFL is written about software, web and print, and the research found nothing explicit about video. Text rendered into a video is the normal, expected use, so I treat it as low risk, and record this assumption in the plan.
- **Do not use:** commercial display fonts and "free for personal use" fonts (for example Clash Display, flagged earlier). Buy a licence first if you want them.
- **Code change this needs:** the renderers currently take **one font file** for the whole film (`RENDER_FONT_FILE`, falling back to Arial). Multiple typefaces means FFmpeg, Remotion and HyperFrames each load the font for the visual system's `face`, and `font-metrics.ts` measures with the matching font. This is part of phase E.

### Where this fits in the phases

- Phase A: licence fields in the database schema, and the importer refuses an item with no licence.
- Phase B: import the fonts, SFX packs and music beds with their licence records.
- Phase E: Kokoro narration, ACE-Step music, per-face font loading, and the audio preview in scene previews.
