---
id: motion-vector-law
title: Exit and entry must share axis, direction and speed
category: all
topic: motion
scope: editor
funnel_stage: all
platform: all
grade: C
status: draft
---
**When to use:** whenever a multi-scene video is composed or a cut is planned.

**Rule:** how scene A exits decides how scene B enters. Same axis (x stays x, y stays y, depth stays depth), same direction, matched speed, and the cut lands mid-motion on both sides. On depth, direction is the sign of the scale change: a growing exit (push) needs a growing entry; a shrinking exit (pull) needs a shrinking entry. A receding exit answered by a grow-from-small entry is the most common violation, because grow-from-small is the default element entrance.

**Pacing:** mirror the eases (exit ease-in, entry ease-out, same distance and duration) so velocity matches at the cut. Settling to rest before a cut, or starting from rest after it, is a dead beat.

**Example:** scene A drifts left and off frame; scene B's content arrives already moving left, decelerating into place.

_Condensed and modified adaptation of hyperframes skills and motion doctrines (https://github.com/heygen-com/hyperframes), Apache-2.0, Copyright 2026 HeyGen, Inc.. Not a copy; changes were made (rewritten, shortened, re-scoped). See the source and its LICENSE for the full method._
