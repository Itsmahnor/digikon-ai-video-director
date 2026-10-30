# Match cut S02 to S03: storyboard revision 2 and edit plan revision 2 (PROPOSED, not approved, not rendered)

Session 9a44fee151f6. Approved versions (storyboard v1, edit plan v1), approvals, checkpoint and the existing preview are untouched. Proposals: `storyboard-v2.json`, `edit-plan-v2.json` (regenerate with `make-storyboard-revision.mts`, `make-revision.mts`).

## Storyboard diff (v1 to v2): one scene, one field
```
version: 1 -> 2
S03 visual.held: (absent) -> { "card": 0, "from_scene": "S02", "word_index": 1 }
```
Everything else is identical: S03's message, overlay text, cards (TECHNOLOGY / DIGIKON SOLUTIONS), depth, pull-out camera, iris reveal, gradient backdrop, duration (5 s), all other 11 scenes, wording, timing, assets. No creative-check issues before or after.

## Edit plan diff (v1 to v2): one use
```
U04 (S02): recipe hard-cut (ffmpeg/concat-cut) -> match-cut (ffmpeg/match-cut), rationale rewritten
```
The other 22 uses are identical.

## What the renderer now does (code, not yet rendered)
- Contract: `layered_cards.held` is optional (absent in all existing plans). Checks: the source is the scene straight before and is kinetic_type with text; the held word is that scene's emphasised word (so the colour matches); it equals the title of the card it lands in.
- Planner: S03's job carries all scenes' visuals, so it lays S02's headline out with S02's own rules and takes the word's exact position (x, y), font size and the green bar's rectangle. Verified by tests at 1280x720, 1920x1080, 854x480 and 720x1280: the held font size, bar position and height equal S02's, and the word sits on the line S02 puts it on.
- Drawing: S03 opens with the word and bar at S02's final pose, on the flat background (outside the iris and the camera). After a 0.3 s hold it moves over 0.8 s into the TECHNOLOGY card's title (following the pull-out camera), changing from green to the card's white and shrinking to the card's size; the bar fades. The iris reveal, cards, tagline and pull-out then run as before, starting after the hold. S03 keeps its 5 s.

## Not yet established
No frame has been rendered. The assembler's match-cut check (background difference at most 16/255, shape correlation at least 0.50, centres within 12% of the frame width) is only decided on rendered frames of S02's last and S03's first frame, so the match cut is NOT claimed. If it fails, the report keeps it as missing; no hard cut is substituted.

## Costs of approving
- Re-render all of S03 and the assembly (about 6 minutes), and refresh the visual capability records (the drawing code changed).
- The handoff hash changes with the storyboard, so the Editor is re-run (no model).
