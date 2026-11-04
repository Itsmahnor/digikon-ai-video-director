---
id: port-remotion-to-hyperframes
title: Port existing video code and verify it frame by frame
category: all
topic: renderer
scope: editor
funnel_stage: all
platform: all
grade: C
status: approved
---
**When to use:** moving a Remotion composition, or other canvas or HTML animation, into the HyperFrames renderer.

**Three levels:** native (translate code that can become HTML plus timeline tweens), hosted (keep a canvas, p5 or WebGL piece and drive it from timeline time), media (render anything else to a file and place it as a clip). Anything that reads the clock, runs a live physics simulation or calls the network cannot be translated; bring it in as rendered media.

**Steps:** lint the source for blockers (stateful hooks, async metadata), translate one sub-composition per scene with times in seconds, keep props as variables, compare against the original at sampled times on both sides of each cut, and record what did not translate cleanly in a notes file.

_Condensed and modified adaptation of hyperframes skills and motion doctrines (https://github.com/heygen-com/hyperframes), Apache-2.0, Copyright 2026 HeyGen, Inc.. Not a copy; changes were made (rewritten, shortened, re-scoped). See the source and its LICENSE for the full method._
