# Implementation steps (full, in order)

Replaces the phase summary in `UPDATED_PLAN.md` with concrete steps. Nothing here is started. Work begins only when you approve, and on the unpushed repo on the D: PC.

How to read each step: **Build** (what is made), **Files** (where, based on the current code), **Done when** (a check we can run). Each step is one reviewable change (one commit or pull request). A step starts only when the one it depends on is done. **Gate rule:** the two approval gates and the render gate are never loosened by any step; every step must keep the existing tests green (last known run: 1,598 passed, 6 skipped).

## Phase A: database and skills foundation

**A1. Run the database for real**
- Build: start Postgres + pgvector with `npm run db:up`, apply `npm run db:migrate`, run the Postgres integration test that has never run.
- Files: `docker-compose.yml`, `db/migrations/0001_pgvector_foundation.sql`, `packages/rag/src/db/pg.integration.test.ts`.
- Done when: `db:health` says OK and the integration test passes with `DATABASE_URL` set.

**A2. Skills tables with licences**
- Build: migration `0002_skills.sql`: `skill_sources` (repo, url, licence, checked_on), `skills` (id, category, funnel_stage, platform, grade, status, body, content_hash, source_id), `skill_embeddings`, `assets_library` (fonts, sounds, music: kind, file, licence, source). A row cannot be saved without a licence.
- Files: `db/migrations/0002_skills.sql`, `packages/rag/src/db/store.ts` (add skills methods), `packages/contracts/src` (new `SkillRecord`).
- Done when: a unit test proves a skill without a licence is rejected.

**A3. Skill importer**
- Build: `npm run skills -- import <folder|repo>`: reads files, checks licence against an allow-list (MIT, Apache-2.0, BSD, CC0, CC-BY with attribution stored), normalises to `SkillRecord`, removes near-duplicates, embeds, stores. Refuses anything else and prints why.
- Files: `scripts/skills.mts`, `packages/rag/src/skills.ts` (reuses `templates.ts` dedupe and `embeddings.ts`).
- Done when: importing a sample folder stores records and a repeat import changes nothing.

**A4. Retriever reads the database**
- Build: a `Retriever` that combines keyword and vector search over the `skills` table, with the same filters as today (status, grade, aspect, platform), plus a new category filter.
- Files: `packages/rag/src/hybrid.ts` (use `storeVectorIndex`), `packages/rag/src/scopes.ts` (add `skills` to the Director and Editor scopes).
- Done when: the existing retrieval tests still pass and a category query returns only that category.

## Phase B: skills for SaaS, e-commerce, general promo

**B1. Find sources.** Search public repos for each category, record licence and origin in `skill_sources`. Output: a reviewed list for you to approve before anything is imported.

**B2. Import approved skills.** Run A3 on the approved list, plus the skills you provide. Convert each into the format the Director uses: when to use, structure, scene beats, pacing, claims warnings, example.
- Done when: at least the agreed number per category is stored (we set the number with you), and each has a licence.

**B3. Wire into the Director and Editor.** Director `treatment` and `storyboard` retrieve category skills; Editor retrieves editing skills. Skills used are recorded in the run audit, as `citations` already are.
- Files: `packages/director/src/nodes.ts` (retrieval calls), `apps/console/src/server.ts` (build the DB-backed retriever, with the keyword retriever as a fallback when `DATABASE_URL` is not set).
- Done when: the retrieval benchmark (`npm run eval:retrieval`, `eval:hybrid`) shows the new corpus beats the BM25 baseline on category queries, and a demo run for each category cites those skills.

## Phase C: guided intake and question module

**C1. Project kit contract.** A versioned `ProjectKit`: goal, audience, platform, brand (colours, fonts, logo, tone), website, guideline file, assets, facts, and for each field `provided | skipped | missing`. Linked to `Project.brand_id`.
- Files: `packages/contracts/src/kit.ts`.
- Done when: schema tests cover every skip and missing case.

**C2. Website reader.** Fetch a page, extract colours, fonts, headings, copy and logo, with timeouts and a size limit. Failure (blocked, no JavaScript content, offline) returns "could not read" and the wizard asks the user instead. Extracted facts are shown to the user to confirm before they count as approved brand facts.
- Files: `packages/media/src/website.ts`, console route `POST /api/sessions/:id/website`.

**C3. Brand guideline reader.** PDF text and colour extraction, same confirm step.

**C4. Intake wizard (UI).** Steps: goal, audience, platform, brand, website, assets. Each optional step has Skip, progress is saved, and a returning user can reuse the saved brand kit.
- Files: `apps/console/public/app.js`, `index.html`, `styles.css`, new routes in `apps/console/src/app.ts`.
- Done when: every edge case works in a browser test: no logo, no website, unreadable PDF, wrong file type, huge file, user goes back and changes an answer.

**C5. Completeness check.** Deterministic code decides required / recommended / optional from the kit and the video category (no model needed).

**C6. Question module.** Asks only what is still missing, one typed question at a time (upload, choice, short text, Skip). Replaces the free-text questions list in `IntakeOut`.
- Files: `packages/director/src/nodes.ts` (`intakeNode`), `packages/contracts` (typed question), UI.
- Done when: a kit with a logo never asks for one, and a kit without one asks once and accepts Skip.

## Phase D: Director shows video type and story

**D1. Video-type step.** After intake the Director proposes 2-3 video types for the category, each with a one-line description and a reference example, using the skills. The user picks one. Stored in the run so it is part of the audit.
- Files: new Director node before `treatment` in `packages/director/src/graph.ts` (bump `DIRECTOR_GRAPH_VERSION`), UI card.

**D2. Needs analysis.** Produce the Gate 1 requirements sheet (what the story needs from assets, fonts, sound). Contract fields already exist.

**D3. Story from the chosen type.** `treatment` and `storyboard` follow that category's skills.
- Done when: golden briefs for the three categories (`evals/golden-briefs.json`) produce different, category-appropriate stories, and Gate 1 tests are unchanged.

## Phase E: Editor, previews, changes, audio and fonts

**E1. Fonts.** Import the OFL fonts with licence records. Replace the single `RENDER_FONT_FILE` with a font per typeface; FFmpeg, Remotion and HyperFrames load the font for the visual system's face, and `font-metrics.ts` measures with the right one.
- Files: `packages/render/src/{ffmpeg,remotion,hyperframes,font-metrics,layout}.ts`, `capabilities/` re-validation.
- Done when: the 14 visual capabilities re-validate with real renders (`npm run capabilities:visual`).

**E2. Per-scene preview.** Render one scene at final resolution and cache it by a hash of the scene, its operations, assets and fonts. Only a changed scene is re-rendered.
- Files: `packages/render/src/scene-job.ts`, `assemble.ts`, console route `POST /api/sessions/:id/scenes/:sceneId/preview`.

**E3. Preview in the UI.** Moving high-resolution preview per scene with its sound, shown before Gate 2, with the plain-language outcome beside it.

**E4. Temporary template picker.** Show 3-5 templates per scene (from retrieval); the user picks or skips. The pick is only a hint to the edit plan. It is removed when the Editor's own choices are good enough.

**E5. Editor model and skills.** Pass an `llm` to `runEditor` so the 10 Editor skills are used, advisory only.

**E6. Change requests at the Editor.** The user says "I don't like this animation" on a scene. A classifier (skills + a cheap model) decides: look change goes to the Editor and Gate 2; story change goes to the Director and Gate 1; unsure asks one question.
- Files: `packages/director/src/editor-agent.ts`, new `route-change.ts`, console route, UI.
- Done when: tests prove a look change never alters the approved storyboard hash.

**E7. Audio.** Kokoro narration, ACE-Step music (GPU), CC0 sound effects with licence records, labelled as generated, and audio included in the scene previews.
- Files: `packages/render/src/audio.ts`, `packages/speech`.
- Done when: a film with narration and music renders, the mix passes the existing audio checks, and a sound that cannot be made still stops Gate 2.

## Phase F: after the full video, and efficiency

**F1. Post-review changes.** After the full video the user asks for changes; the same classifier routes them, and only affected scenes re-render using the E2 cache.

**F2. Model gateway wired in.** Cheap model for routing and completeness wording, strongest for the story; per-film budget and call log in the database.
- Files: `packages/director/src/gateway.ts`, `apps/console/src/server.ts`.

**F3. Measure.** Time per edit, cost per film, retrieval hit rate, repeat-template rate. Report in `evals/`.

## Phase G: later

Templates Release 2 and 3, the remaining scene-graph block ports, generative composition, hosted database and multi-user.

## What I need from you before step A1 starts

1. The go-ahead on this list (or changes to it).
2. The D: PC repo state: which branch to build on, and `feature/templates-r1` pushed or not.
3. Whether Anthropic credit or another provider is available for the model-dependent steps (D2, E5, E6, F2). Steps A1 to C5 do not need one.
4. How many skills per category count as "enough" for B2 (I suggest starting with 15 per category and growing).

## Additions (2026-11-03, after review)

### Audio is included. Where it is, step by step

- **B2a. Audio skills.** Import and write skills for sound: voiceover pacing and script length (words per second), music mood by category, ducking and loudness (the platform loudness targets), sound-effect use, and silence. Stored in the same database, same licence rule. The Editor skill `audio-voiceover-mixing` and the Director skill `sound-design` stay and are tested against them.
- **C4a. Audio intake.** The wizard asks: narration, music, both, or silent; and whether the user has a voiceover or music (upload with a rights tick). See `UX_GUIDE.md` section 10.
- **D3a. Story includes sound.** Each scene carries audio cues (narration line, music mood, effects). The storyboard shown at Gate 1 lists them, so the user approves the sound too.
- **E7 (expanded).** Kokoro narration with a voice picker, ACE-Step music with a mood picker (GPU), CC0 effects, a mix with ducking, loudness check, audio in every scene preview, generated sound labelled. A sound that cannot be made still stops Gate 2.
- **E7a. Audio checks.** The final review reports voice clarity, loudness and clipping in plain words. Uses the existing audio and technical QA checks.

### UX step added to every UI phase

- **UX0 (before C4).** Turn `UX_GUIDE.md` into a clickable prototype of screens 1-10 and test it with 5 users before building. Fix the flow first, then code it.
- **UX acceptance (steps C4, C6, D1, E3, E4, E6, F1).** A UI step is done only when it passes the checks in `UX_GUIDE.md` section 9: edge-case click-throughs, WCAG 2.2 AA, plain-language audit and the 5-minute-to-story target.

### Production-ready skills standard (new step B0, before any import)

A skill can be used in a real film only if it is **production-ready**. B0 defines and enforces this:
1. **Licence and source recorded**, from the allow-list.
2. **Structured:** when to use, inputs it needs, steps, scene beats, pacing numbers, what to avoid, a worked example.
3. **Tested:** at least 3 evaluation cases per skill (a brief in, what a good result must contain). Skills already have `evals/` folders; the importer refuses a skill without them.
4. **Reviewed:** status moves draft, reviewed, approved. Only `approved` skills are retrieved outside development mode (the same rule recipes follow today).
5. **Category-tagged** (SaaS, e-commerce, general promo; audio; editing; UX copy) and platform-tagged.
6. **Claim-safe:** no skill may tell the Director to assert results, numbers or comparisons without a brand fact (matches the existing claims-discipline rules).
7. **Measured:** the retrieval benchmark must show it is found for its category queries.
The existing nine Director skills and ten Editor skills are run through the same standard first, and any that fail are fixed before new ones are added.

### Memory and skills update

Project memory now records the plan, the roles, the audio and font choices, the UX guide and this standard (`project-direction-2026-11`, `project-pc-state`, and a new `project-skills-standard`). The skills you uploaded earlier (the files in the project library: audits, plans, `CLAUDE.md`, `DIGIKON_CONTEXT.md`) are the source for the standard above, and I read the plan and status files from it. I have not yet read all of them (for example `CLAUDE.md`, `DIGIKON_CONTEXT.md`, the audit parts); that is the first task when work starts.
