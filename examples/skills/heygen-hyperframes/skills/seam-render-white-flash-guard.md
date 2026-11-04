---
id: seam-render-white-flash-guard
title: Paint the stage so transitions never flash white
category: all
topic: renderer
scope: editor
funnel_stage: all
platform: all
grade: C
status: draft
---
**When to use:** when assembling the master timeline or when a transition shows a bright flash, especially on dark films.

**Cause:** during crossfades and zoom-throughs the two scene wrappers' combined opacity dips below one, so whatever is behind them shows through. If the stage has no opaque background, the page default (white) shows.

**Rule:** the assembler paints the stage with the film's deepest canvas colour. Transitions are pure transform, opacity and filter on the two clip wrappers, with no injected overlay elements.

**Verify:** scrub the frames in the middle of each seam, not just the ends.

_Condensed and modified adaptation of hyperframes skills and motion doctrines (https://github.com/heygen-com/hyperframes), Apache-2.0, Copyright 2026 HeyGen, Inc.. Not a copy; changes were made (rewritten, shortened, re-scoped). See the source and its LICENSE for the full method._
