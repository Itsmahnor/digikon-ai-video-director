# Plan text for Phases D to G (as received)

Given to the working session by the coordinator on 2026-11-04 (quoting the project plan). `architecture/UPDATED_PLAN.md` is still not in the repo. Status and hashes live in `docs/HANDOFF.md`. Phases A to C are in `docs/PLAN_PHASES_A-C.md`.

Roles: **Director** = what the video says (story, claims, scenes; changes reopen Gate 1). **Editor** = how it looks and moves (animation, templates, timing, sound; changes reopen Gate 2 only). **Gate rule: the two approval gates and the render gate are never loosened.**

## D. Director shows video type and story

- **D1 Video-type step:** after intake the Director proposes 2 to 3 video types for the category (one-line description + a reference example, using the skills); the user picks one; the choice is stored in the run for audit. New Director node before `treatment` in `packages/director/src/graph.ts` (bump `DIRECTOR_GRAPH_VERSION`), plus a UI card.
- **D2 Needs analysis:** produce the Gate 1 requirements sheet (what the story needs from assets, fonts, sound); the contract fields already exist.
- **D3 Story from the chosen type:** treatment and storyboard follow that category's skills. Done when golden briefs for three categories (`evals/golden-briefs.json`) produce different, category-appropriate stories and the Gate 1 tests are unchanged.

## E. Editor, previews, changes, audio, fonts

- **E1 Fonts:** import OFL fonts with licence records; replace the single `RENDER_FONT_FILE` with a font per typeface; FFmpeg, Remotion and HyperFrames load the font for the visual system's face; font-metrics measures with the right one. Done when the 14 visual capabilities re-validate (`npm run capabilities:visual`).
- **E2 Per-scene preview:** render one scene at final resolution, cached by a hash of scene, operations, assets and fonts; only a changed scene re-renders (`packages/render/src/scene-job.ts`, `assemble.ts`, route `POST /api/sessions/:id/scenes/:sceneId/preview`).
- **E3 Preview in the UI:** a moving high-resolution preview per scene with sound, shown before Gate 2, with a plain-language outcome.
- **E4 Temporary template picker:** 3 to 5 templates per scene from retrieval; the user picks or skips; only a hint to the edit plan; to be removed later.
- **E5 Editor model and skills:** pass an llm to `runEditor` so the 10 Editor skills are used, advisory only.
- **E6 Change requests:** a classifier decides: look change -> Editor and Gate 2; story change -> Director and Gate 1; unsure -> ask one question. Tests prove a look change never alters the approved storyboard hash.
- **E7 Audio:** Kokoro narration, ACE-Step music (GPU), CC0 sound effects with licence records, labelled generated, audio in previews; a sound that cannot be made still stops Gate 2.

## F

- **F1** Post-review changes route to the Director or the Editor; only affected scenes re-render, using the E2 cache.
- **F2 Model gateway wired in:** a cheap model for routing and completeness wording, the strongest for story; a per-film budget and call log in the database (`packages/director/src/gateway.ts`, `apps/console/src/server.ts`).
- **F3 Measure:** time per edit, cost per film, retrieval hit rate, repeat-template rate; report in `evals/`.

## G. Later

Templates Releases 2 and 3, remaining scene-graph block ports, generative composition, hosted database and multi-user.
