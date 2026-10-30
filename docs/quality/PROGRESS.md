# Progress checkpoint (resume notes)

Nothing is committed. Rules: no commit/push/stash/checkout/reset; no new dependencies; free local tools only.

## Done
- Phase 1: `docs/quality/PHASE1_AUDIT.md`; "before" render in `docs/quality/before/` (session 35e1221287dc, Slotly brief, driver `scripts/drive-brief.mjs`).
- Baseline: npm test 50 files / 904 tests pass; typecheck clean; eval 16/16 (demo).
- Phase 2/3 (in progress), edits so far, typecheck clean:
  - `packages/contracts/src/visual.ts` (new): `ArtDirection`, `Palette` (contrast-checked), `SceneVisual` (7 blocks), `creativeIssues`.
  - `Scene.visual_purpose` / `Scene.visual`, `Treatment.art_direction` (optional, default null: old data still parses).
  - `packages/render/src/composition.ts` (planner), `composition-verify.ts` (frame measures), `remotion-project/Compositions.jsx` (drawing), `index.jsx` (second composition id), `remotion.ts` wiring, `adapter.ts` (`scene_visuals`, `art_direction` on the job), `assemble.ts`/`render.ts` (jobVisuals), `coverage.ts` (`drawn_templates` capability field, not yet used by the logic).

## To do, in order
1. coverage.ts: a scene drawn by `remotion/scene-composition` counts its text, generated graphics/UI/logo-wordmark placeholders and drawn camera as shown (labelled concept).
2. Recipe `recipes/animation/scene-composition.json`; register template with the Editor / selectors; Director `editIssues` requires it for scenes with a visual.
3. Director: skill `skills/creative-direction`, treatment + storyboard prompts, schemas for LLM output (art_direction required), demo-client canned data, tests.
4. Real test renders of every block in 16:9 and 9:16 (tests + evidence).
5. Phase 4: visual QA across the film (`packages/qa/src/visual.ts`), plan compliance, delivery report section.
6. Phase 5: `capabilities/visual/` evidence records + QA failure log.
7. Phase 6: rerun the Slotly brief, `docs/quality/BEFORE_AFTER.md`, final npm test / typecheck / eval.

## Checkpoint 2026-10-30 (resumed session)
- Found already written (uncommitted): qa/visual.ts + test, render/visual-report.ts (filmQuality, planCompliance, logVisualQa), render/visual-capabilities.ts + scripts/validate-visual-capabilities.mts, console wiring in app.ts. Fixed a TS cast error in visual-capabilities.ts. Next: typecheck, tests, validate capabilities (capabilities/visual/ is empty), Phase 6 before/after.
- Phase 4/5 verified; live Slotly rerun complete (after/ folder: after_slotly.mp4, contact.png, run.json, visual_qa.json). Fixed: edge-check false positive on backdrops, message_thread overflow, camera clipping headline/edge, coverage of white cards. Remaining: write BEFORE_AFTER.md, final npm test/typecheck/eval.

## Final (2026-10-30)
- Phases 4-6 done. docs/quality/BEFORE_AFTER.md written. Final tree: npm test 54 files / 946 tests pass; typecheck 0 errors; eval 16/16 (demo); capabilities:visual all 7 blocks validated against current code. Nothing committed.

## Checkpoint 2026-10-30 (adaptive layout / transitions / status task, session 2)
Task: adaptive layout engine (S04/S05), real boundary transitions (match cut, crossfade, wipe, dip), one authoritative delivery status, accurate readiness diagnostics, 12-scene regression render. No commit; no gate weakened.
Regression case: storage/sessions/9a44fee151f6 (12 scenes, 1280x720@30, S04 process_flow 5 steps, S05 ui_demo 6 rows; S02 match_cut has only a hard-cut op E04).
- DONE: packages/render/src/font-metrics.ts (real glyph widths from the TTF), layout.ts (wrap, fitText, areas, grid shapes, steps column/row/grid/pages, window layout, overflow detection, layoutConstraints); composition.ts uses them (ui_demo/process_flow adaptive, `layout` on CompositionScene); remotion.ts passes the font meter.
- TODO next: Compositions.jsx draw from scene.layout; tests; match-cut recipe + assembler; delivery status model; readiness diagnostics; Director constraints; regression render.
- DONE (cont.): Compositions.jsx draws ui_demo/process_flow from scene.layout; layout.test.ts (34 tests) + composition.test.ts pass (real Remotion renders). S04/S05 plan OK at 1280x720, 1920x1080, 854x480, 720x1280, 1080x1080, 1080x1350, 640x360.
- NEXT: transitions (match-cut recipe+assembler verify, type-specific frame checks), status model, readiness diagnostics, Director constraints, regression render.
- DONE: ffmpeg.ts registers ffmpeg/concat-cut + ffmpeg/match-cut (fixes 'concat-cut unavailable'); recipes/transition/match-cut.json; Director TRANSITION_RECIPE.match_cut; transition-checks.ts (dissolve/dip/wipe/match measured on real frames); delivery-status.ts (decideDelivery, 6 criteria) integrated into assemble.ts (report.decision, readiness per op, late match-cut failure -> omitted). typecheck OK for render+console.
- NEXT: console app.ts/app.js use report.decision + readiness view + visualCheck/isolation deps; update tests broken by changes; new tests (transition-checks, delivery-status, assembly); Director layout constraints; revalidate capabilities:visual (fingerprint changed); regression render.
- DONE: tests added (delivery-status, transition-checks, match-cut, assemble decision/readiness); existing tests updated for new semantics (content_validated counts engine-checked scenes only; concat-cut/match-cut registered). capabilities:visual revalidation started (fingerprint changed). NEXT: full npm test/typecheck/eval, then regression render of session 9a44fee151f6 via console demo server + frame inspection.

## Final (adaptive layout / transitions / status task)
- npm test 58 files / 1005 tests pass; typecheck clean; eval 16/16; capabilities:visual 7/7 revalidated. Regression render: docs/quality/regression (render.json, plan.json, frames, contact sheets), video storage/sessions/9a44fee151f6/.../out/rn_bdb5bf7a58714b81.mp4. 12/12 scenes by remotion, all blends applied and frame-verified; S02 match cut stays unmet (approved edit plan U04 = hard-cut). Status: incomplete_preview. Nothing committed.

## Final (adaptive layout / transitions / status task)
- npm test 58 files / 1005 tests pass; typecheck clean; eval 16/16; capabilities:visual 7/7 revalidated. Regression render: docs/quality/regression (render.json, plan.json, frames, contact sheets); video storage/sessions/9a44fee151f6/renders/9a44fee151f6-1793346641368/out/rn_bdb5bf7a58714b81.mp4. 12/12 scenes by remotion, blends applied and frame-verified; S02 match cut unmet (approved edit plan U04 = hard-cut). Status incomplete_preview. Nothing committed.

## Match cut revision (approved by user 2026-10-30)
- New session 9a44fee151f7 (storyboard v2 + edit plan v2, approvals recorded from the user's chat approval); original session 9a44fee151f6 untouched. Render: 12/12 remotion, 1280x720 30fps 60s; match cut measured: bg diff 0.0 (<=16 ok), correlation 0.45 (<0.50 FAIL), centre shift 3% (<=12 ok) -> not applied, incomplete_preview. Video: storage/sessions/9a44fee151f7/renders/*/out/rn_37ab1a5834de40f1.mp4. Evidence docs/quality/regression2.
