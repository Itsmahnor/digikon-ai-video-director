---
id: cut-the-curve-parameters
title: Seam parameters: partial travel, mirrored eases, blur and timings
category: all
topic: motion
scope: editor
funnel_stage: all
platform: all
grade: C
status: approved
---
**When to use:** implementing a velocity-matched cut.

**Cut the curve (the default boundary):** about 0.6 s in total, travelling about 12% of the frame (roughly 230 px at 1920 wide) in the film's current direction. Exit with a strong ease-in and entry with the matching ease-out, same distance and duration, so velocity matches at the cut. Fade the outgoing element out within the first quarter to third of its travel and ignite the incoming one around a third opacity mid-path; time the last fading element to finish at the cut so there is no dead gap. Exit 0.2 to 0.4 s, entry at least as long.

**Zoom-through (forward):** about 0.4 s; exit scale 1 to 1.2 with blur rising, hard swap at peak blur, entry 0.75 to 1. **Inverse (backward):** about 0.7 s for arrivals; exit 1 to 0.8, entry 1.25 to 1.

**Blur:** about 10 px for text-scale subjects (more smears the letterforms), 18 to 20 px only for full-frame surfaces; same peak blur on both sides, applied to the wrapper.

**Stage:** paint an opaque stage behind the scenes.

**Rule:** use the default boundary unless the story earns a special seam, and use the same parameters across the film so the cuts feel related.

_Condensed and modified adaptation of hyperframes motion doctrines and skills (https://github.com/heygen-com/hyperframes), Apache-2.0, Copyright 2026 HeyGen, Inc.. Not a copy; changes were made (rewritten, shortened, re-scoped). See the source and its LICENSE for the full method._
