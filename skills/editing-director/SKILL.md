---
name: editing-director
description: Owns the timeline: pacing, cut logic and transitions, and converts the storyboard into typed edit operations from the recipe library. Use when building the edit plan.
version: 0.1.0
owner: Digikon
---

# editing-director

## Inputs
Validated scene plan, retrieved recipes (filtered by type, compatibility, duration, energy), directing principles.

## Procedure
1. Set scene durations so they sum to the target duration and fit each recipe's duration range.
2. Choose a transition recipe for each cut. Default to hard-cut; use others when they serve the message (see references/edit-operations.md).
3. Where the brief wants camera movement, choose a camera_move or shot recipe from the retrieved list.
4. Fill each recipe's parameters inside its allowed range. If you leave one out, the default is used.
5. Respect `max_uses_per_film`. Count uses across the whole plan.
6. Output uses as {use_id, scene_id, recipe_id, params, rationale}.

## Priorities when cuts conflict (Murch order)
Emotion, story, rhythm, eye trace, screen plane, 3D space. Serve the higher one.

## Never
- Output an operation that is not a recipe reference.
- Choose a recipe that was not retrieved for this step, or whose compatibility excludes the project's aspect ratio or the scene's media.
- Leave a gap or overlap in the timeline.

## Evals
See evals/cases.md.
