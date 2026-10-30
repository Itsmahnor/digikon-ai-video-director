# Edit plan revision 2: S02 to S03 match cut (proposal, NOT approved)

Session 9a44fee151f6, run 9a44fee151f6-1793346641368. The approved edit plan (version 1), its approvals, the checkpoint and the existing preview are untouched. The proposal is `edit-plan-v2.json` (regenerate with `make-revision.mts`).

## Before / after (the only change: use U04)

| | version 1 (approved) | version 2 (proposed) |
|---|---|---|
| use_id / scene | U04 / S02 | U04 / S02 |
| recipe_id | `hard-cut` | `match-cut` |
| implementation_ref | `ffmpeg/concat-cut` | `ffmpeg/match-cut` |
| params | {} | {} |
| rationale | "...no match-cut recipe was retrieved. Hard-cut is the closest supported option... the transition is approximated." | "...match-cut recipe replaces the hard-cut approximation. It is only a match cut if S02's last picture and S03's first match; the assembler measures that." |

The other 22 uses (U01-U03, U05-U23), all 12 scenes, order, wording, timing, assets and the S03/S07/S09/S10/S11 transitions are identical (verified by comparing every use).

## What the frames show now (existing preview, read-only)
- S02 last frame (frame 179): flat dark teal; green bar at left, three-line headline "YOUR / TECHNOLOGY (green) / SHOULD TOO." at the left, about 25% of the frame wide.
- S03 first frame (frame 180): completely empty. S03's `iris` reveal starts from nothing, so there is no picture to match. Measured by the assembler's check: "the first picture of the next scene is empty, so there is no shape to match".
- S03 at 1.2 s: tagline column at left (small), two cards at right on a green radial gradient.

So changing U04 alone will NOT make the cut a match cut: the assembler would report it as not applied, and the preview stays incomplete.

## What must align (the specification)
The shared element is the word **TECHNOLOGY**: green emphasis in S02, and the first card title "TECHNOLOGY" in S03.
1. Background: S03's opening frame must be the same flat dark teal as S02's last frame (check: border colour within 16/255; today 0 difference, but S03 then has no content). The gradient may bloom in after the cut.
2. Composition and position: at S03 frame 0, a green "TECHNOLOGY" must sit where it sits at S02's end (left column, about y 24-28% from the top, x 2.5-25% of the width), with the same left green bar and white lines around it, at the same scale (cap height about 8% of the frame height).
3. Movement: from there S03 animates the word down in scale and across into the first card's title position (card at about x 82%, y 33%), while the other cards and tagline settle in. The pull-out camera starts after the cut.
4. Pass criterion: the assembler measures the drawn shapes at S02's last and S03's first frames: background difference at most 16/255, shape correlation at least 0.50, centres within 12% of the frame width.

## What this needs beyond the edit plan (needs your decision)
S03 is an approved storyboard scene (reveal `iris`, no opening picture). Making its first frame show TECHNOLOGY means changing S03's visual (reveal and opening composition) and the scene-composition drawing. That is a storyboard-level change, which needs the storyboard approval again, plus a renderer addition: an "opening held element" for the layered-cards block. I have not done either, and I have not claimed the match cut works.

## Status
Not rendered, not approved, nothing committed, existing preview untouched.
