# Phase 1 audit: why generated videos look generic

Date: 2026-10-29. Method: read the code, then ran one real brief through the real console (live Claude, `claude-sonnet-5-5`, both gates approved by `scripts/drive-brief.mjs`), rendered it, and extracted frames with ffmpeg.

Note on inputs: `CLAUDE.md` and `DIGIKON_CONTEXT.md` do not exist in this repo. The rules were taken from `docs/DIRECTOR_HANDOFF.md`, `docs/RENDERER_FOUNDATION.md` and the code. `git status` was clean at the start (the recent work is in commit `8b9ca89`), so nothing was uncommitted to protect.

## Baseline (before any change)

| Command | Result |
|---|---|
| `npm test` | 50 files, 904 tests passed |
| `npm run typecheck` | all workspaces compiled with no errors printed |
| `npm run eval` | 16/16 passed (DEMO mode: canned model, tests the pipeline, says nothing about Claude's quality) |

## The traced video

Brief: 20 s, 16:9 YouTube explainer for "Slotly", a scheduling app. Calm, clear, modern. Goal: free-trial sign-ups. No footage, logo, voiceover or music. Two approved facts.

- Session `35e1221287dc`, render `rn_d43dec8eac194967`, 1280x720, 30 fps, 20 s.
- Output copy: `docs/quality/before/before_slotly.mp4`; contact sheet `docs/quality/before/contact.png`; frames in `docs/quality/before/frames/`; full run log `docs/quality/before/run.json`.

What Claude **planned** (good intent):
- Hook: email bubbles ping-pong ("Does Tuesday work?" ...) and pile up; no logo opener.
- Problem: bubbles tangle, slow push-in, headline "Booking shouldn't take this many emails."
- Solution: calendar graphic, a cursor picks an open slot, it becomes a confirmed booking.
- Fit: "Google Calendar" / "Outlook" names slide in.
- CTA: typeset "Slotly" wordmark, a button graphic, "Start your free 14-day trial."

What was **rendered**: 2 of 5 scenes. S01, S03, S05 are red "INCOMPLETE PREVIEW / NOT RENDERED" slates. S02 and S04 are a flat navy background with centred white Arial text. No bubbles, no calendar, no cursor, no button, no push-in, no crossfades (the report says transitions fell back to hard cuts). The system labelled this honestly as incomplete, which is correct, but the result is not a usable video.

## Root causes, with evidence

1. **The renderers can only draw a text card or one image.** `packages/render/src/web-scenes.ts` defines `WebKind = "text" | "image"`. A web scene is: one of 3 background colours (`navy`, `charcoal`, `forest`), one of 3 accents (`amber`, `teal`, `coral`), one font file, centred text, a fade-in and a short accent bar. `packages/render/remotion-project/Scenes.jsx` implements exactly that plus a `Composed` scene (supplied picture + camera move, text entrance, lower third, logo image, accent bar). There is no component for shapes, UI mockups, cursors, bubbles, charts, diagrams, parallax, masks or kinetic type. HyperFrames (`hyperframes-composed.ts`) mirrors the same set.
2. **The Director plans things nothing can draw.** The storyboard prompt (`nodes.ts`) tells the model that "animated text, shapes, cursors and windows drawn as graphics, progress bars, end cards, UI-style graphics" are `generate_graphics`. No capability implements those. S01, S03, S05 therefore fail with "no operation produces this scene's picture", "needs a product screen ... this renderer cannot show" and "needs a logo ... this renderer cannot show".
3. **No creative direction exists anywhere in the Director.** The skills are 1.0-2.0 KB each (`skills/*/SKILL.md`). `Treatment` has only `logline, hook, tone, beats, cta, claims`. Nothing asks for audience response, a concept or visual metaphor, a palette, typography, a composition or motion language, an arc, or a per-scene visual purpose. `motion-graphics` says only "use one dominant motion per scene". `video-qa` says "Flag taste as a defect: never".
4. **Visual treatment is not carried into the render contract.** The treatment's "soft neutral palette, off-white canvas, one accent" never reaches the renderer: the template's palette is the 3 fixed dark backgrounds (the plan asked for off-white; the render is navy). The edit plan can only pick `background` from `navy/charcoal/forest` or a recipe's `light` option. Approved art direction is lost between storyboard and pixels.
5. **Recipes decide the look, and there are only a few.** 19 recipes (+ HyperFrames siblings), all `draft`: 3 text entrances, 1 end card, 1 logo reveal, 1 lower third, 4 camera moves that only work on supplied images, 3 shots, 5 transitions, 3 sound cues. Every non-photo scene collapses to "text-fade-up on a flat colour". With ordinary briefs every video becomes a deck of identical title cards.
6. **Camera motion is silently dropped for graphics scenes.** S02 asked for a slow push-in; the report states "no renderer here has a camera-move template, so the scene would be shown static". Push-in is validated only for supplied images. So motion the Director intended is absent.
7. **Transitions degrade to hard cuts** whenever a neighbouring scene is unrendered, and crossfade/dip-to-black are generic xfades.
8. **Scene mixing is unsupported**: one engine per scene, and no way to give one scene a drawn background plus text plus a UI element.
9. **Portrait risk confirmed in code**: `web-scenes.ts` sizes text by frame height with a conservative `CHAR_W = 0.55`, so 9:16 refuses text that would fit, per the known issue.
10. **The quality gate checks existence and fidelity to the approved text, not visual quality.** `packages/qa/technical.ts`: duration, size, fps, audio, black frames, frozen frames, loudness. `packages/render/verify.ts`: that each scene's background colour and rendered text ink match what was planned (`verifySceneContent`, `verifySceneFidelity`). Nothing measures hierarchy, composition, empty area, repetition across scenes, palette consistency, motion presence, or whether the scene shows what the storyboard described. `video-qa` has no visual rubric items beyond the technical ones and its skill forbids reporting taste. A video made of repeated identical cards passes every gate.
11. **Honest labelling works, but it blocks creative delivery.** The delivery report correctly says INCOMPLETE and `final_delivery_ready: false`. It is right to refuse to call this finished; the fix is capability, not weaker gates.

## Checklist from the request

| Question | Finding |
|---|---|
| Repeated title-card layouts | Yes: every drawable scene is centred text on a flat colour |
| Generic/repetitive concepts | Concepts are decent; they cannot be expressed. No art-direction fields force distinctiveness |
| Weak hook and ending | Hook (bubbles) and ending (button) were planned but not drawable; they became slates |
| Insufficient or wrongly mapped assets | No assets supplied; the graphics workflow has no graphics to generate |
| Static scenes where motion intended | Yes (push-in dropped) |
| Unnecessary fades/transitions | Only fade-in; crossfades fall to hard cuts |
| Typography, timing, spacing, hierarchy | One font, one size rule, no hierarchy (single text block) |
| Renderers ignoring visual treatment | Yes: off-white/accent palette became fixed navy |
| Gate only checks existence/non-blank | Largely yes: checks technical validity and text/colour fidelity only |

## What Phase 2-6 will do about it

- Phase 2: add art direction + concept + per-scene visual-purpose fields to the Director output, with schema validation and skill text.
- Phase 3: add real drawable compositions to Remotion (UI/product demo with cursor, message bubbles, process diagram, animated chart, kinetic type, masked reveals, end card, parallax) with a palette that follows the approved art direction, registered in the capability registry and rendered/validated for real.
- Phase 4: add plan-compliance and visual-QA checks (repetition, hierarchy, empty area, motion presence, palette adherence) and a scene-level repair loop.
- Phase 5: persist verified versions, parameters, evidence and QA failures; renewed approval for approval-bound changes.
- Phase 6: re-render the same brief and compare.
