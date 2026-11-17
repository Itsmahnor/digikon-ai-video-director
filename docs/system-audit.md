# System audit: why the output looks ordinary

Audited 2026-11-17 on branch `feature/m1-capability-registry-v2` (commit `5da1b72`). No code was changed in this pass.

**How this was checked.** Source reading with file:line citations; the repo's own test run; and 4 finished renders (`storage/sessions/7a5b0693f0fc`, `63a9ceeb0308`, `9e7cd1ec8433`, `40c2de4fc28b`), each inspected as an 8-frame contact sheet, not played in full and not listened to. The stored plan of one earlier session (`58037c158ca7`) was also read. Real Claude was not run (no API key present). Where I could not verify something it is under "Open questions".

## 1. Executive summary

1. The pipeline is safe and well gated, and the plans the Director writes are decent. The ordinary look comes from what the **renderer can express**, not from the planning.
2. The Director's free-form scene (`composition`) is text plus rect/ellipse/line shapes with 8 entrance types and 3 easings. No rotation, no pictures, no gradients, light, blur or masks (`packages/contracts/src/visual.ts:227,231,250-279`).
3. Everything else is a fixed block (15 of them) drawn from a library of 40 recipes, in 3 typefaces, with 4 synthesised sound effects and a machine voice.
4. The prompts and skills push toward the safe choice: "never add novelty for its own sake", "never ask for a block or motion the reference does not list".
5. A supplied logo is protected so strongly (never cropped, recoloured or redrawn) that logo choreography is forbidden by design (`packages/contracts/src/assets.ts:215`).
6. Nothing looks at the film and improves it. `DIRECTOR_VISUAL_CRITIQUE` does not exist in the code. Visual QA is explicitly "measured, not judged" (`packages/qa/src/visual.ts:8-12`).
7. In the 4 renders: large empty areas, duplicated copy on an end card, flat dark-grey fades, slide-show screenshots, and 3 of 4 films have no audio track.
8. The reproducible tests currently show 26 failures from stale HyperFrames validations; six recipes are hidden from the Director until re-validated.
9. A "bespoke scene" path (Director-authored, sandboxed, frame-checked, hash-approved) can raise the ceiling without weakening any gate (section 5).
10. There is no polish metric, so improvements cannot be measured. Section 6 proposes one.

## 2. Weaknesses

| ID | Area | Evidence | Impact on quality | Effort |
|---|---|---|---|---|
| W1 | Composition vocabulary: only text and rect/ellipse/line; no rotate, image, gradient, glow, blur, mask | `contracts/src/visual.ts:250-279` (CompText, CompShape, `CompElement` union at 279) | High | M |
| W2 | Entrance motion: 8 types, 3 easings, no per-property keyframes | `visual.ts:227` (enter), `:231` (easing) | High | M |
| W3 | The richer scene-graph v2 (rotate, bezier and spring easing, masks, camera, 24 keyframes) exists but is behind `SCENE_GRAPH=on` and only templates reference it | `contracts/src/scene-graph.ts:13-28,138-139`; `templates/src/kit.ts:337` | High | M |
| W4 | Pictures are not elements; they are layered over a composition | `director/src/nodes.ts:253` (COMPOSITION_GUIDE) | High | M |
| W5 | Logo may never be cropped, recoloured, redrawn | `contracts/src/assets.ts:215`; `nodes.ts:225` | High (logo reveals impossible) | M |
| W6 | Skills discourage originality | `skills/creative-direction/SKILL.md`: procedure step 2 ("never add novelty for its own sake"), "Never: ask for a block or motion that the reference does not list" | High | S |
| W7 | Brand kit fields (colours, fonts, logo, tone) exist in the contract, but I found no use in Director prompts; only picture `dominant_colours` and brand-fact text are sent | `contracts/src/kit.ts:67-70`; `nodes.ts:273` | Med | S to M |
| W8 | No look-and-fix loop; the named flag does not exist | grep of whole repo: `DIRECTOR_VISUAL_CRITIQUE` appears only in docs | High | M |
| W9 | QA cannot judge polish | `qa/src/visual.ts:8-12` ("It cannot tell whether a design is good") | High (no signal) | M |
| W10 | 3 typefaces (Inter, EB Garamond, JetBrains Mono) | `render/src/fonts.ts`, `render/fonts/` | Med | S |
| W11 | Sound: 4 synthesised effects, machine voice (SAPI/espeak), generated bed; cue matching by words, not by time | `render/src/audio.ts:15,35,37,74-75` | High (perceived quality) | M |
| W12 | 3 of 4 reviewed films have no audio stream | ffprobe on sessions `9e7cd1ec8433`, `40c2de4fc28b`, `63a9ceeb0308` | Med | S |
| W13 | 5 to 6 transitions only; transitions chosen per scene by code gap-fill | `recipes/transition/*.json` (hard-cut, crossfade, dip-to-black, directional-wipe, match-cut, j-cut) | Med | M |
| W14 | Grounding rule: every word drawn must come from approved text | `contracts/src/composition-grounding.ts:3-8` | Med (blocks decorative or brand-line text) | S |
| W15 | The 476-template library was never retrieved by the Director, and the table was empty in Postgres | found this session; wired in `director/src/nodes.ts` (commit `5da1b72`) | Med | done, unproven |
| W16 | 26 failing tests: stale HyperFrames capability evidence (scene implementation hash changed) | full test run (1929 tests): 26 failed in 3 files: `render/src/hyperframes-capabilities.test.ts` (20), `render/src/assemble.test.ts` (5), `scripts/tree.test.ts` (1). The first two are consistent with the stale evidence; the `assemble` and `tree` causes were not diagnosed | Med (6 recipes hidden) | S |
| W17 | `scripts/*.mts` ingest to a throwaway in-memory store when `.env` is not loaded, and print success | `scripts/templates.mts:125` | Low | S |
| W18 | Full test suite takes about 12 minutes; sessions kept in memory; console has no login | test timing; docs | Low | M |
| W19 | Docs disagree with code: the "scene-graph v2 engine not wired in" vs code comments saying compositions are "drawn by the scene-graph engine" | `visual.ts:215` vs overview doc | Low | S |

## 3. Root-cause analysis, ranked by impact

1. **Expressive ceiling (W1, W2, W3, W4, W5).** The Director can place text and boxes and fade, rise or slide them. It cannot rotate, mask, glow, trace or choreograph. Every film therefore reduces to text cards, chat bubbles, UI windows and end cards on a soft gradient. This is the single biggest cause.
2. **No feedback on looks (W8, W9).** The model never sees a frame, and QA only reports measurable defects. Nothing pushes quality upward, and nothing even detects "ordinary".
3. **Prompts that reward safety (W6, W14).** The skill and the grounding rule are written to prevent bad outcomes, and they succeed, at the price of any distinctive one.
4. **Sound and type (W10, W11, W12).** A robotic voice, generated bed and three fonts make even good motion feel cheap. Three of four reviewed films were silent.
5. **Brand fidelity (W5, W7).** Logo handled as an untouchable picture; brand colours and fonts not demonstrably reaching the model.
6. **Unmeasured (no polish eval).** Without a score, changes cannot be compared.

**Could the Director express "two halves of a logo swing open from the gap while a light beam passes through, synced to a sound hit"? No.** Exact blocks: (a) a logo is a picture, and pictures are not composition elements (W4); (b) the logo may not be cropped into halves (W5); (c) there is no rotation or pivot on any element (W1/W2); (d) there is no light, gradient, glow or blend field in the schema (W1); (e) effects are cued by words at scene level and not at a timestamp, and only whoosh, hit, chime and click exist (W11).

## 4. What the real renders show

| Render | What looks generic | Cause |
|---|---|---|
| `7a5b0693f0fc` (coffee, 16:9, 12 s) | Large empty areas; the timeline scene is small in a corner; one frame is an empty gradient; "Order your first bag" appears twice on the end card; headline wraps with an orphan word mid-entrance | W1, W14 (copy reuse), no critique (W8) |
| `9e7cd1ec8433` (invoices, 16:9, 20 s, silent) | Screenshot shown small as a thumbnail; plain mock UI; logo appears static at the end | W4, W5, W12 |
| `40c2de4fc28b` (client ops, square, 35 s, silent) | Screenshot slideshow with plain white captions; fades go to flat dark grey | W2, W13, no critique |
| `63a9ceeb0308` (CRM, 9:16, 15 s, silent) | Half the portrait frame empty; same chat-bubble then window then text then button sequence as the others | W1, W6 |

These four films share structure: concrete opening, UI window, one-line statement, button. That repetition across unrelated briefs is the template look.

## 5. Improvement roadmap

### Phase 1: quick wins (days)
| Change | Where | How the guarantees stay intact | Success measure |
|---|---|---|---|
| Re-validate stale HyperFrames capabilities | `npm run capabilities`, `capabilities/registry/hyperframes` | Registry evidence stays hash-bound; nothing is promoted without a real render | 0 failing tests; 6 recipes offered again |
| Soften skills: allow bold, concept-led choices; remove "never add novelty" and the unlisted-motion ban where schema already validates | `skills/creative-direction/SKILL.md`, `knowledge/` | Validators and gates unchanged | Higher polish score (section 6) |
| Make sure brand colours, fonts and tone reach the treatment prompt | `director/src/nodes.ts` (treatment section) | Hints only | Prompt shows brand block; palette matches brand in renders |
| Fix duplicate end-card copy; reduce empty-frame ratio | `contracts/src/composition-blocks.ts`, `render/src/layout.ts` | Pure layout | Empty-area metric under threshold |
| Make scripts load `.env` or fail loudly | `scripts/*.mts` | none | ingest reports the real store |
| Always give films a sound track (neural voice or licensed bed) | `render/src/audio.ts` | Audio is already planned and measured | Every final film has audio |

### Phase 2: widen the vocabulary (weeks)
| Change | Where | Safety | Measure |
|---|---|---|---|
| Add to composition: `rotate`, `scale`, `opacity` tracks, pivot, gradient fill, glow, blend `screen`, bezier and spring easing, image elements, rect-mask reveal, camera | `contracts/src/visual.ts`, `scene-graph.ts` (reuse v2), `render/src/composition.ts`, `director/src/nodes.ts` guide | New fields are data, validated by Zod and the existing bounds, legibility and grounding checks; still hashed into the storyboard | New elements appear in renders; checks still pass |
| Brand-asset processing: palette and font extraction, background removal, optional layer separation offered as an approved **asset variant** (the original logo stays untouched and is the one claimed as the logo) | `packages/media`, `contracts/src/assets.ts` | A derived variant is a new asset id with its own hash and an explicit user approval at Gate 1 | Logo variants usable in compositions |
| Audio timeline: cues at timestamps tied to scene events; more sfx kinds; licensed music | `audio.ts`, `contracts` | Cues are plan data and measured after mixing | Sync error under 80 ms |
| More typefaces (Manrope, DM Serif Display) | `render/fonts/` with licence records | Existing font hash verification | Brand fonts render |

### Phase 3: feedback loop (weeks)
Build, not switch on: render one frame per scene (or 3 per scene) after the preview render, send to Claude vision with the art direction, allow one repair pass at Gate 1 time. The result is advice only; the revised storyboard goes through the same gate, and the critique record is stored with the run. Measure: polish score before and after.

### Phase 4: bespoke scene path (below).

### Bespoke scene proposal

**Idea.** A new visual block, `authored_scene`: the Director writes a Remotion scene (TSX plus a small JSON manifest of copy, assets, cues). It is a creative proposal that must pass checks and be approved by hash; it is never executed unreviewed.

**Flow.**
1. *Author.* At the storyboard step the Director may choose `authored_scene` for a scene whose idea no block fits. It returns source plus a manifest: `{ texts[], asset_refs[], cues:[{t, sfx}], duration }`.
2. *Static check.* Allow-list imports (`remotion`, a small helper library, no network, no fs, no `eval`, no dynamic import, no timers outside Remotion), size cap, deterministic (no `Math.random` without seed).
3. *Sandboxed sample render.* Render 5 frames and a 2 s strip in the existing isolated Chrome, with a timeout and memory cap. Fail closed.
4. *Checks on the frames.* Existing visual QA (blank, crowded, static, palette), plus text capture from the DOM or OCR compared with the grounding rule: every word must come from approved copy, so a scene cannot invent a claim. Legibility and safe areas as today.
5. *Gate 1.* The reviewer sees the sample frames and strip, and approves the exact **source hash**. A change to the code changes the hash and invalidates approval.
6. *Edit plan and Editor.* The edit plan carries one recipe use: `authored-scene` with a single parameter, `source_hash`. It takes no other parameters, as with `scene-composition`. The Editor translates it into one operation; it cannot alter the source.
7. *Render gate.* Re-hashes the source file, confirms Gate 1 and Gate 2 approvals match, confirms the capability record for the sandbox renderer is validated. Any mismatch refuses.
8. *Promotion.* After an authored scene has rendered and been approved in N films with no QA finding, a maintainer may promote it: its source becomes a recipe with parameters, written to the capability registry with the validating render as evidence, as learned capabilities are today.

**Why safety is not weakened.** Code never runs without a hash the person approved; the sandbox has no network or filesystem; the copy is grounded as today; claim and brand-fact rules run on the captured text; the Editor still cannot change anything approved; and a draft is labelled a preview until reviewed.

**Open design choice.** Remotion TSX is the most expressive but needs the strongest sandbox. A lower-risk first step is Phase 2 (a richer declarative scene graph) which needs no code execution; many brand-reveal effects (rotation, masks, glow, beams) are expressible as data.

## 6. Polish eval (quality score, not plan validity)

Run on a fixed set of 10 to 20 briefs; score each finished film.

| Criterion | What is scored | How measured |
|---|---|---|
| Hierarchy and composition | One clear focal point per scene; use of space; empty-area ratio | Vision judge plus frame statistics |
| Motion craft | Easing variety, overshoot or settle, stagger and choreography across elements, no everything-fades-in | Plan inspection plus vision judge on a strip |
| Typography | Pairing, scale contrast, line breaks, no orphans | Vision judge |
| Cohesion | Palette and type consistent; scenes related yet different | Judge plus the existing diversity script |
| Distinctiveness | Distance from a corpus of earlier films (reuse `packages/evals/src/diversity.ts`) | Embedding distance |
| Brand fidelity | Logo, colours, fonts used correctly | Rule checks plus judge |
| Sound | Voice quality, music fit, effects land on picture events | Human rating; sync error measured |
| Pacing | Hold times, rhythm, no dead frames | Frame statistics |
| Human preference | Pairwise against a reference film or the previous build | 3 reviewers, blind |

Method: score 0 to 5 per criterion with written anchors; calibrate the vision judge against human scores until agreement is acceptable; publish the score per build; any change must not lower the mean. The existing visual QA remains a floor, never a target.

## 7. Risks and open questions

- Real Claude was not run: no key was present, so plan quality with the live model, sound defaults and the new template section are untested live.
- I viewed 8 frames per film, not full playback, and did not listen to audio.
- Three failing test files are identified (see W16), but only the HyperFrames capability failures have a diagnosed cause; whether `assemble.test.ts` and `scripts/tree.test.ts` share it is unverified.
- Whether brand colours, fonts and logo reach the model by another path than the ones I searched (W7): not found, not proven absent.
- Which renderer actually draws `composition` (W19): code comments and docs disagree.
- Frame-based text capture for bespoke scenes may miss text drawn as paths or in images; it needs a design decision.
- Neural voice and licensed music have licence and cost implications to decide.
