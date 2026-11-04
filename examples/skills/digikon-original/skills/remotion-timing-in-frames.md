---
id: remotion-timing-in-frames
title: Remotion timing: think in frames, convert from seconds
category: all
topic: renderer
scope: editor
funnel_stage: all
platform: all
grade: C
status: approved
---
**When to use:** setting durations, delays and animation timing.

**Rules:** all timing is in frames; convert with frames = seconds x frame rate (for example 2.5 s at 30 fps is 75 frames). Round durations to whole frames and keep the total of scene lengths equal to the composition duration. Drive animation from the current frame (interpolation with clamped input and output ranges, or springs), never from wall-clock time or timers.

**Common slips:** an off-by-one at scene boundaries (a scene ending one frame early shows a gap), using different fps for the composition and the maths, animating beyond the clamped range, and overlapping sequences unintentionally.

**Check:** render a still at the first, middle and last frame of each scene.

**Licence warning:** Remotion has its own licence; check remotion.dev/license before commercial use.

**Rule:** keep the frame rate in one place and derive every duration from it, so changing the rate changes nothing else.

**Check:** add up the frame counts of all scenes and compare with the composition duration before rendering.

_Original Digikon skill (MIT, Copyright (c) 2026 Digikon). Working guidance, not a benchmarked rule: check platform figures against the verified platform_specs before relying on them._
