---
id: remotion-captions-and-text
title: Remotion captions and text animation
category: all
topic: text-captions
scope: editor
funnel_stage: all
platform: all
grade: C
status: draft
---
**When to use:** subtitles or animated text in a Remotion video.

**Method:** keep captions as data (words or phrases with start and end times, converted to frames) and render the phrase active at the current frame. Group words into short lines (two lines at most), highlight the active word if wanted, and keep text inside safe zones with enough contrast. For text animation (stagger by word or character), compute each unit's start frame from a fixed offset and keep line breaks intact.

**Fonts:** load fonts explicitly and wait for them before rendering, or the first frames may use a fallback.

**Check:** verify the caption timing against the audio at several points, and look at the longest line on the narrowest aspect ratio.

**Licence warning:** Remotion has its own licence; check remotion.dev/license before commercial use.

_Original Digikon skill (MIT, Copyright (c) 2026 Digikon). Working guidance, not a benchmarked rule: check platform figures against the verified platform_specs before relying on them._
